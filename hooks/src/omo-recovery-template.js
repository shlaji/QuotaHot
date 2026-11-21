import { watch as watchOmoState } from 'node:fs';
import { appendFile as appendOmoLog, readFile as readOmoStateFile, stat as statOmoLog } from 'node:fs/promises';
import { homedir as omoHome } from 'node:os';
import { dirname as omoDirname, join as omoJoin } from 'node:path';

function createOmoRecovery() {
  const statePath = omoJoin(process.env.QUOTAHOT_DATA_DIR ?? omoJoin(omoHome(), '.quotahot'), 'switch-state.json');
  const logDirectory = omoJoin(omoDirname(statePath), 'logs');
  const logPath = omoJoin(logDirectory, 'omo-recovery.jsonl');
  let logWrites = Promise.resolve();
  function log(event, entries, details = {}) {
    const line = JSON.stringify({
      at: Date.now(), pid: process.pid, event,
      sessions: [...entries].map((entry) => entry.sessionID).filter((id) => /^[a-zA-Z0-9_-]{1,128}$/.test(id)).slice(0, 20),
      ...details,
    }) + '\n';
    logWrites = logWrites.then(async () => {
      await mkdirOmoStatus(logDirectory, { recursive: true, mode: 0o700 });
      const size = await statOmoLog(logPath).then((info) => info.size, (error) => {
        if (error?.code === 'ENOENT') return 0;
        throw error;
      });
      if (size < 2 * 1024 * 1024) await appendOmoLog(logPath, line, { mode: 0o600 });
    }).catch(() => { /* Diagnostics must not affect recovery. */ });
  }
  const groups = new Map();
  const publishStatus = createOmoRecoveryStatus(groups, omoDirname(statePath));
  let watcher, watchTimer, reading;
  let readAgain = false;
  let state = { signature: '', receiptAt: 0, receiptKey: '', resetAt: Infinity };
  let forcedSurveyAt = 0;

  function cancel(entry) {
    const group = groups.get(entry.key);
    if (!group) return;
    group.entries.delete(entry);
    publishStatus();
    if (group.entries.size) return;
    clearTimeout(group.timer);
    group.nextCheckAt = null;
    group.controller?.abort();
    groups.delete(entry.key);
    if (groups.size) return;
    watcher?.close();
    watcher = undefined;
    clearTimeout(watchTimer);
    watchTimer = undefined;
    state = { signature: '', receiptAt: 0, receiptKey: '', resetAt: Infinity };
    forcedSurveyAt = 0;
  }

  function prune(group) {
    for (const entry of group.entries) if (!entry.active()) cancel(entry);
    return groups.get(group.key) === group && group.entries.size > 0;
  }

  async function refresh(external) {
    if (reading) { readAgain ||= external; return reading; }
    reading = (async () => {
      do {
        readAgain = false;
        let next = { signature: '', receiptAt: 0, receiptKey: '', resetAt: Infinity };
        let manualSurveyAt = 0;
        try {
          const data = JSON.parse(await readOmoStateFile(statePath, 'utf8'));
          if (Number.isFinite(data.lastForcedCodexSurveyAt) && data.lastForcedCodexSurveyAt > forcedSurveyAt) {
            manualSurveyAt = forcedSurveyAt = data.lastForcedCodexSurveyAt;
          }
          const quotas = Object.entries(data.accounts ?? {}).map(([id, memo]) =>
            [id, memo?.usedPercent, memo?.resetAt, memo?.blockedUntil]).sort(([a], [b]) => a.localeCompare(b));
          const receipt = data.lastOmoQuotaCheck;
          const receiptAt = receipt?.provider === 'codex' && Number.isFinite(receipt.completedAt)
            && typeof receipt.switched === 'boolean' && typeof receipt.latestData === 'boolean'
            && Number.isFinite(receipt.waitUntil)
            && (['switched', 'available'].includes(receipt.outcome) || receipt.latestData && receipt.outcome === 'no_candidate')
            ? receipt.completedAt : 0;
          next = { signature: JSON.stringify(quotas), receiptAt,
            receiptKey: JSON.stringify([receipt?.omoRequest?.accountId, receipt?.omoRequest?.email, receipt?.omoRequest?.loginId]),
            resetAt: quotas.reduce((earliest, [, , reset, blocked]) => {
              const due = Number(blocked) + RESET_BUFFER_MS > Date.now() ? Number(blocked) : Number(reset);
              return Number.isFinite(due) && due > 0 && due + RESET_BUFFER_MS > Date.now() ? Math.min(earliest, due) : earliest;
            }, Infinity) };
        } catch {
          // 文件尚未生成或正在被替换时，保留本地等待。
        }
        const quotaChanged = next.signature !== state.signature;
        const receiptChanged = next.receiptAt !== state.receiptAt;
        state = next;
        if (manualSurveyAt || (external && (quotaChanged || receiptChanged))) for (const group of groups.values()) {
          if (!prune(group) || group.ready) continue;
          const manualWake = manualSurveyAt > 0 && manualSurveyAt >= group.started;
          const matchingReceipt = external && receiptChanged && next.receiptAt > 0 && next.receiptKey === group.identityKey;
          if (!manualWake && !(external && quotaChanged) && !matchingReceipt) continue;
          log('state_wakeup', group.entries, { quotaChanged, matchingReceipt, manualWake, checkInProgress: group.running });
          if (manualWake) group.checkAfter = null;
          else if (matchingReceipt) group.checkAfter = next.receiptAt;
          if (quotaChanged || manualWake) {
            group.failures = 0;
            if (!group.running) group.networkDelay = NETWORK_RETRY_BASE_MS;
          }
          if (group.running) group.wakeupPending ||= manualWake || matchingReceipt;
          else schedule(group, 0);
        }
        external = readAgain;
      } while (readAgain);
    })();
    try { await reading; } finally { reading = undefined; }
  }

  function watchState() {
    if (watcher || !groups.size) return;
    try {
      const current = watchOmoState(omoDirname(statePath), (_event, name) => {
        if (name != null && name.toString() !== 'switch-state.json') return;
        void refresh(true);
      });
      watcher = current;
      current.unref?.();
      current.on('error', () => {
        if (watcher === current) watcher = undefined;
        current.close();
        retryWatch();
      });
    } catch { retryWatch(); }
  }

  function retryWatch() {
    if (watchTimer || watcher || !groups.size) return;
    watchTimer = setTimeout(async () => {
      watchTimer = undefined;
      watchState();
      await refresh(true);
      if (!watcher) retryWatch();
    }, 1_000);
    watchTimer.unref?.();
  }

  function schedule(group, delay) {
    if (!prune(group) || group.running) return;
    clearTimeout(group.timer);
    const now = Date.now();
    const wait = group.ready ? 1_000 : quotaRecoveryDelay({
      now, waitUntil: group.waitUntil, stateResetAt: state.resetAt, retryAt: group.retryAt,
      delay, hasData: group.hasData, failures: group.failures, backoff: group.delay,
    });
    if (wait === undefined) {
      group.timer = undefined;
      group.nextCheckAt = null;
      log('check_paused', group.entries, { reason: 'no_future_reset', failures: group.failures });
      publishStatus();
      return;
    }
    const deadline = now + wait;
    group.nextCheckAt = deadline;
    publishStatus();
    const arm = () => {
      const timer = setTimeout(async () => {
        if (group.timer !== timer || !prune(group)) return;
        if (Date.now() < deadline) { arm(); return; }
        group.timer = undefined;
        if (![...group.entries].some((entry) => entry.idle())) { schedule(group, 1_000); return; }
        if (group.ready) {
          group.running = true;
          try { await deliver(group); } finally { group.running = false; schedule(group); }
        } else await (group.inFlight = perform(group, true));
      }, Math.min(60_000, Math.max(0, deadline - Date.now())));
      group.timer = timer;
      timer.unref?.();
    };
    arm();
  }

  async function deliver(group) {
    for (const entry of [...group.entries]) {
      if (!entry.active()) { cancel(entry); continue; }
      if (group.initials.has(entry) || !entry.idle()) continue;
      try { if (await entry.resume(group.ready)) cancel(entry); }
      catch (error) {
        console.error('QuotaHot: 额度恢复失败', error);
        entry.notify('额度恢复失败，请手动检查会话', 'warning');
        cancel(entry);
      }
    }
  }

  async function perform(group, recover) {
    group.running = true;
    clearTimeout(group.timer);
    group.timer = undefined;
    group.nextCheckAt = null;
    publishStatus();
    group.controller = new AbortController();
    const checkAfter = group.checkAfter ?? Date.now();
    let retryDelay;
    let contended = false;
    try {
      await refresh(false);
      if (!prune(group)) return null;
      const owner = [...group.entries].find((entry) => entry.active() && (!recover || entry.idle()));
      if (!owner) return null;
      watchState();
      const result = await owner.run({ recover, quotaCheckAfter: checkAfter }, group.controller.signal);
      if (!prune(group)) return result;
      const outcome = result?.switched ? 'switched' : result?.resume ? 'available' : result?.outcome;
      group.lastCheckedAt = Date.now();
      group.lastOutcome = outcome ?? 'check_failed';
      const available = outcome === 'available' || outcome === 'switched';
      contended = outcome === 'lock_contended';
      if (outcome === 'network_error') {
        retryDelay = group.networkDelay;
        group.networkDelay = Math.min(group.networkDelay * 2, NETWORK_RETRY_MAX_MS);
      } else if (!contended) group.networkDelay = NETWORK_RETRY_BASE_MS;
      if (recover && !contended && outcome !== 'network_error') {
        group.delay = available ? RECOVERY_INTERVAL_MS : Math.min(group.delay * 2, 8 * RECOVERY_INTERVAL_MS);
      }
      if (!contended) {
        group.hasData = result?.latestData === true && !result.writeBlocked;
        group.failures = group.hasData || available ? 0 : group.failures + 1;
      }
      log('check_result', group.entries, { recover, outcome: group.lastOutcome,
        latestData: result?.latestData === true, failures: group.failures, ...(retryDelay !== undefined ? { retryDelayMs: retryDelay } : {}),
        ...(result?.writeBlocked ? { writeBlocked: true } : {}),
        ...(result?.checks ? { checks: result.checks } : {}) });
      group.waitUntil = Number.isFinite(result?.waitUntil) ? result.waitUntil : 0;
      await refresh(false);
      if (contended) {
        group.retryAt = Date.now() + LOCK_RETRY_MS;
        group.checkAfter ??= checkAfter;
      } else {
        group.retryAt = 0;
        if (!group.wakeupPending) group.checkAfter = null;
      }
      if (available) {
        group.ready = result;
        await deliver(group);
      }
      return result;
    } catch (error) {
      console.error('QuotaHot: 额度检查失败', error);
      group.hasData = false;
      group.lastCheckedAt = Date.now();
      group.lastOutcome = 'check_failed';
      group.failures += 1;
      group.networkDelay = NETWORK_RETRY_BASE_MS;
      log('check_exception', group.entries, { recover, failures: group.failures });
      return null;
    } finally {
      group.running = false;
      group.inFlight = undefined;
      if (prune(group)) {
        if (group.ready) schedule(group);
        else if (group.wakeupPending) schedule(group, contended ? LOCK_RETRY_MS : 0);
        else if (contended) schedule(group, LOCK_RETRY_MS);
        else schedule(group, group.hasData || group.failures >= HOURLY_RECOVERY_FAILURE_THRESHOLD ? undefined : retryDelay);
      }
      group.wakeupPending = false;
      publishStatus();
    }
  }

  return {
    log,
    check(entry) {
      if (!entry.active()) return Promise.resolve(null);
      let group = groups.get(entry.key);
      if (!group) {
        group = { key: entry.key, identityKey: JSON.stringify([entry.identity.accountId, entry.identity.email, entry.identity.loginId]),
          entries: new Set(), initials: new Set(), failures: 0, delay: RECOVERY_INTERVAL_MS,
          networkDelay: NETWORK_RETRY_BASE_MS, retryAt: 0, waitUntil: 0, hasData: false, running: false,
          nextCheckAt: null, lastCheckedAt: null, lastOutcome: null,
          started: Date.now(), checkAfter: null, ready: null, wakeupPending: false };
        groups.set(entry.key, group);
      }
      group.entries.add(entry);
      publishStatus();
      group.initials.add(entry);
      if (!group.inFlight) group.inFlight = perform(group, false);
      return group.inFlight.then((result) => {
        group.initials.delete(entry);
        if (result?.switched || result?.resume || result?.outcome === 'available') cancel(entry);
        return result;
      });
    },
    cancel,
  };
}
