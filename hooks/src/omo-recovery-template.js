import { watch as watchOmoState } from 'node:fs';
import { readFile as readOmoStateFile } from 'node:fs/promises';
import { homedir as omoHome } from 'node:os';
import { dirname as omoDirname, join as omoJoin } from 'node:path';

function createOmoRecovery() {
  const INTERVAL = 600_000;
  const BUFFER = 60_000;
  const MAX_FAILURES = 5;
  const statePath = omoJoin(process.env.QUOTAHOT_DATA_DIR ?? omoJoin(omoHome(), '.quotahot'), 'switch-state.json');
  const groups = new Map();
  let watcher, watchTimer, reading;
  let readAgain = false;
  let state = { signature: '', receiptAt: 0, receiptKey: '', resetAt: Infinity };

  function cancel(entry) {
    const group = groups.get(entry.key);
    if (!group) return;
    group.entries.delete(entry);
    if (group.entries.size) return;
    clearTimeout(group.timer);
    group.controller?.abort();
    groups.delete(entry.key);
    if (groups.size) return;
    watcher?.close();
    watcher = undefined;
    clearTimeout(watchTimer);
    watchTimer = undefined;
    state = { signature: '', receiptAt: 0, receiptKey: '', resetAt: Infinity };
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
        try {
          const data = JSON.parse(await readOmoStateFile(statePath, 'utf8'));
          const quotas = Object.entries(data.accounts ?? {}).map(([id, memo]) =>
            [id, memo?.usedPercent, memo?.resetAt, memo?.blockedUntil]).sort(([a], [b]) => a.localeCompare(b));
          const receipt = data.lastOmoQuotaCheck;
          const receiptAt = receipt?.provider === 'codex' && Number.isFinite(receipt.completedAt)
            && typeof receipt.switched === 'boolean' && typeof receipt.latestData === 'boolean'
            && Number.isFinite(receipt.waitUntil)
            && ['switched', 'available', 'no_candidate', 'network_error', 'check_failed'].includes(receipt.outcome)
            ? receipt.completedAt : 0;
          next = { signature: JSON.stringify(quotas), receiptAt,
            receiptKey: JSON.stringify([receipt?.omoRequest?.accountId, receipt?.omoRequest?.email, receipt?.omoRequest?.loginId]),
            resetAt: quotas.reduce((earliest, [, , reset, blocked]) => {
              const due = Number(blocked) + BUFFER > Date.now() ? Number(blocked) : Number(reset);
              return Number.isFinite(due) && due > 0 && due + BUFFER > Date.now() ? Math.min(earliest, due) : earliest;
            }, Infinity) };
        } catch {
          // 文件尚未生成或正在被替换时，保留本地等待。
        }
        const quotaChanged = next.signature !== state.signature;
        const receiptChanged = next.receiptAt !== state.receiptAt;
        state = next;
        if (external && (quotaChanged || receiptChanged)) for (const group of groups.values()) {
          if (!prune(group) || group.ready) continue;
          const matchingReceipt = receiptChanged && next.receiptAt > 0 && next.receiptKey === group.identityKey;
          if (!quotaChanged && !matchingReceipt) continue;
          if (matchingReceipt) group.checkAfter = next.receiptAt;
          else group.failures = 0;
          if (group.running) group.receiptPending ||= matchingReceipt;
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
      const current = watchOmoState(omoDirname(statePath), () => { void refresh(true); });
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

  function resetDeadline(group) {
    const future = [group.waitUntil, state.resetAt].filter((time) =>
      Number.isFinite(time) && time > 0 && time + BUFFER > Date.now());
    return future.length ? Math.min(...future) + BUFFER : Infinity;
  }

  function schedule(group, delay) {
    if (!prune(group) || group.running) return;
    clearTimeout(group.timer);
    const due = resetDeadline(group);
    if (!group.ready && delay === undefined && (group.hasData ? !Number.isFinite(due) : group.failures >= MAX_FAILURES)) {
      group.timer = undefined;
      return;
    }
    const deadline = group.ready ? Date.now() + 1_000 : group.retryAt > Date.now() ? group.retryAt
      : Date.now() + (delay ?? (Number.isFinite(due) ? due - Date.now() : group.delay));
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
      const available = outcome === 'available' || outcome === 'switched';
      contended = outcome === 'lock_contended';
      retryDelay = outcome === 'network_error' ? group.networkDelay : undefined;
      group.networkDelay = outcome === 'network_error' ? Math.min(group.networkDelay * 2, 300_000) : 5_000;
      if (recover && !contended && outcome !== 'network_error') {
        group.delay = available ? INTERVAL : Math.min(group.delay * 2, 8 * INTERVAL);
      }
      group.hasData = result?.latestData === true;
      group.failures = group.hasData || available ? 0 : group.failures + 1;
      group.waitUntil = Number.isFinite(result?.waitUntil) ? result.waitUntil : 0;
      await refresh(false);
      if (contended) {
        group.retryAt = Date.now() + 1_000;
        group.checkAfter ??= checkAfter;
      } else {
        group.retryAt = 0;
        if (!group.receiptPending) group.checkAfter = null;
      }
      if (available) {
        group.ready = result;
        await deliver(group);
      } else if (group.failures === MAX_FAILURES) {
        for (const entry of group.entries) entry.notify('已停止自动额度查询，等待账户状态变化', 'info');
      }
      return result;
    } catch (error) {
      console.error('QuotaHot: 额度检查失败', error);
      group.hasData = false;
      group.failures += 1;
      return null;
    } finally {
      group.running = false;
      group.inFlight = undefined;
      if (prune(group)) {
        if (group.ready) schedule(group);
        else if (group.receiptPending) schedule(group, contended ? 1_000 : 0);
        else if (group.hasData || group.failures < MAX_FAILURES) schedule(group, retryDelay);
      }
      group.receiptPending = false;
    }
  }

  return {
    check(entry) {
      if (!entry.active()) return Promise.resolve(null);
      let group = groups.get(entry.key);
      if (!group) {
        group = { key: entry.key, identityKey: JSON.stringify([entry.identity.accountId, entry.identity.email, entry.identity.loginId]),
          entries: new Set(), initials: new Set(), failures: 0, delay: INTERVAL,
          networkDelay: 5_000, retryAt: 0, waitUntil: 0, hasData: false, running: false,
          checkAfter: null, ready: null, receiptPending: false };
        groups.set(entry.key, group);
      }
      group.entries.add(entry);
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
