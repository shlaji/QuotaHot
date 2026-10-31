// quotahot:start
// 由 `quotahot-hook install` 配置；重新安装会整份覆盖。
// 作用：明确触限时切换账户，额度恢复后续跑仍处于失败空闲状态的会话。
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const COMMAND = "__QUOTAHOT_COMMAND_ARGS__";
function classifyQuotaSignal(payload) {
  const root = payload !== null && typeof payload === 'object' ? payload : null;
  const nestedEvent = root === null ? undefined : Reflect.get(root, 'event');
  const event = nestedEvent ?? payload;
  const properties = event !== null && typeof event === 'object' ? Reflect.get(event, 'properties') : undefined;
  const retryStatus = properties !== null && typeof properties === 'object' ? Reflect.get(properties, 'status') : undefined;
  const propertyError = properties !== null && typeof properties === 'object' ? Reflect.get(properties, 'error') : undefined;
  const eventError = event !== null && typeof event === 'object' ? Reflect.get(event, 'error') : undefined;
  const rootError = root === null ? undefined : Reflect.get(root, 'error');
  const error = propertyError ?? eventError ?? rootError;
  const errorData = error !== null && typeof error === 'object' ? Reflect.get(error, 'data') : undefined;
  const retryError = retryStatus !== null && typeof retryStatus === 'object' ? Reflect.get(retryStatus, 'error') : undefined;

  for (const value of [event, error, errorData, retryError]) {
    if (value === null || typeof value !== 'object') continue;
    const status = Reflect.get(value, 'statusCode') ?? Reflect.get(value, 'status');
    if (status === 429 || status === '429') return 'status_429';
  }

  const phrase = /\brate[ _-]?limit(?:_exceeded| exceeded|ed)?\b|\busage[ _-]limit(?:[ _-]reached| has been reached)?\b|\bquota(?:[ _-](?:exhausted|exceeded)| has been exhausted)\b|\btoo many requests\b|you'?ve (?:hit|reached) your|\binsufficient_quota\b|\bresets? (?:at|in)\b/i;
  for (const value of [event, error, errorData, retryStatus, retryError]) {
    if (value === null || typeof value !== 'object') continue;
    for (const key of ['message', 'code']) {
      const text = Reflect.get(value, key);
      if (typeof text === 'string' && phrase.test(text)) return 'quota_phrase';
    }
  }
  return null;
}

const HOOK_STDERR_LIMIT = 8192;
const SESSION_CACHE_LIMIT = 128;
const TOMBSTONE_LIMIT = 1024;
const TOMBSTONE_TTL_MS = 600000;
const LOOKUP_TIMEOUT_MS = 2000;
const assistantMessages = new Map();
const lookupPromises = new Map();
const deletedSessions = new Map();

const RECOVERY_INTERVAL_MS = 600000;
const MAX_TIMER_DELAY_MS = 2147483647;
const NETWORK_RETRY_BASE_MS = 5000;
const NETWORK_RETRY_MAX_MS = 300000;
const MAX_RECOVERY_FAILURES = 5;
const LOCK_RETRY_MS = 1000;
const RESET_BUFFER_MS = 60000;
const STATE_WATCH_RETRY_MS = 1000;
const STATE_PATH = join(process.env.QUOTAHOT_DATA_DIR ?? join(homedir(), ".quotahot"), "switch-state.json");
const RECOVERY_STATUS_DIR = "recovery-status";
const recoveryStatusID = randomUUID();
const recoveryStatusPath = join(process.env.QUOTAHOT_DATA_DIR ?? join(homedir(), ".quotahot"), RECOVERY_STATUS_DIR, recoveryStatusID + ".json");
const waitingSessions = new Map();
const completedFailures = new Map();
let recoveryTimer;
let nextCheckAt = null;
let heartbeatTimer;
let stateWatchRetryTimer;
let statusWrites = Promise.resolve();
let lastCheckAt = null;
let lastCheckResult = null;
let recoveryRunning = false;
let recoveryDelay = RECOVERY_INTERVAL_MS;
let networkRetryDelay = NETWORK_RETRY_BASE_MS;
let recoveryWaitUntil = 0;
let recoveryRetryAt = 0;
let recoveryHasLatestData = false;
let recoveryFailures = 0;
let recoveryCheckAfter = null;
let stateWatcher;
let stateSignature = "";
let stateReceiptAt = 0;
let stateResetAt = 0;
let stateReading = false;
let stateReadAgain = false;
let pendingExternalRecovery = false;
let initialRecoveryWave;

function publishRecoveryStatus() {
  const sessions = [...waitingSessions.values()].map((entry) => ({
    sessionID: entry.sessionID.slice(0, 128),
    phase: entry.ready ? "ready" : entry.queued ? recoveryRunning ? "checking" : "waiting" : "checking",
  }));
  const snapshot = sessions.length ? JSON.stringify({
    version: 1, id: recoveryStatusID, pid: process.pid, updatedAt: Date.now(),
    phase: recoveryRunning ? "checking" : sessions.some((entry) => entry.phase === "waiting") ? "waiting" : "ready",
    waitingCount: sessions.length, sessions,
    queuedCount: [...waitingSessions.values()].filter((entry) => entry.queued).length,
    checking: recoveryRunning, nextCheckAt, lastCheckedAt: lastCheckAt, lastOutcome: lastCheckResult,
  }) : null;
  if (sessions.length && !heartbeatTimer) {
    const beat = () => {
      heartbeatTimer = undefined;
      if (waitingSessions.size) publishRecoveryStatus();
    };
    heartbeatTimer = setTimeout(beat, 60000);
    heartbeatTimer.unref?.();
  }
  if (!sessions.length) {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = undefined;
  }
  statusWrites = statusWrites.then(async () => {
    if (snapshot === null) {
      await unlink(recoveryStatusPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
      return;
    }
    await mkdir(dirname(recoveryStatusPath), { recursive: true, mode: 0o700 });
    const temporary = recoveryStatusPath + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, recoveryStatusPath);
    } finally {
      await unlink(temporary).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    }
  }).catch(() => {});
}

async function readRecoveryState() {
  try {
    const state = JSON.parse(await readFile(STATE_PATH, "utf8"));
    const accounts = state?.accounts && typeof state.accounts === "object" ? state.accounts : {};
    const quotas = Object.entries(accounts).map(([id, memo]) => [id, memo?.usedPercent, memo?.resetAt, memo?.blockedUntil]);
    quotas.sort(([left], [right]) => left.localeCompare(right));
    const receipt = state?.lastQuotaCheck;
    const receiptAt = receipt?.provider === "codex" && Number.isFinite(receipt.completedAt) &&
      typeof receipt.switched === "boolean" && typeof receipt.latestData === "boolean" &&
      Number.isFinite(receipt.waitUntil) && ["switched", "available", "no_candidate", "network_error", "check_failed"].includes(receipt.outcome)
      ? receipt.completedAt : 0;
    const now = Date.now();
    return {
      signature: JSON.stringify(quotas),
      receiptAt,
      resetAt: quotas.reduce((earliest, [, , resetAt, blockedUntil]) => {
        const next = Number(blockedUntil) + RESET_BUFFER_MS > now ? Number(blockedUntil) : Number(resetAt);
        return Number.isFinite(next) && next > 0 && next + RESET_BUFFER_MS > now ? Math.min(earliest, next) : earliest;
      }, Infinity),
    };
  } catch {
    return { signature: "", resetAt: Infinity };
  }
}

async function refreshRecoveryState(external) {
  if (stateReading) {
    stateReadAgain ||= external;
    return;
  }
  stateReading = true;
  try {
    do {
      stateReadAgain = false;
      const state = await readRecoveryState();
      const quotaChanged = state.signature !== stateSignature;
      const receiptChanged = state.receiptAt !== stateReceiptAt;
      stateSignature = state.signature;
      stateReceiptAt = state.receiptAt;
      stateResetAt = state.resetAt;
      if (external && (quotaChanged || receiptChanged) && [...waitingSessions.values()].some((entry) => entry.queued)) {
        if (receiptChanged) recoveryCheckAfter = state.receiptAt;
        else if (quotaChanged) recoveryFailures = 0;
        if (recoveryRunning) pendingExternalRecovery = true;
        else {
          clearTimeout(recoveryTimer);
          recoveryTimer = undefined;
          scheduleRecovery(0);
        }
      }
      external = stateReadAgain;
    } while (stateReadAgain);
  } finally {
    stateReading = false;
  }
}

function watchRecoveryState() {
  if (stateWatcher) return;
  try {
    const watcher = watch(dirname(STATE_PATH), () => {
      void refreshRecoveryState(true);
    });
    stateWatcher = watcher;
    clearTimeout(stateWatchRetryTimer);
    stateWatchRetryTimer = undefined;
    watcher.on("error", () => {
      if (stateWatcher === watcher) stateWatcher = undefined;
      watcher.close();
      scheduleStateWatchRetry();
    });
    watcher.unref?.();
  } catch {
    // The data directory may not exist yet; the timer remains the fallback.
    scheduleStateWatchRetry();
  }
}

function scheduleStateWatchRetry() {
  if (stateWatchRetryTimer || stateWatcher || !waitingSessions.size) return;
  stateWatchRetryTimer = setTimeout(async () => {
    stateWatchRetryTimer = undefined;
    watchRecoveryState();
    await refreshRecoveryState(true);
    if (!stateWatcher) scheduleStateWatchRetry();
  }, STATE_WATCH_RETRY_MS);
  stateWatchRetryTimer.unref?.();
}

function failureKey(entry) {
  return JSON.stringify([entry.sessionID, entry.failureID || null]);
}

function active(entry) {
  return !entry.owner.disposed && waitingSessions.get(entry.sessionID) === entry && !isDeleted(entry.sessionID);
}

function forget(entry, reason) {
  if (reason) entry.owner.logRecovery("cancel", { sessionID: entry.sessionID, failureID: entry.failureID, reason });
  completedFailures.set(failureKey(entry), true);
  while (completedFailures.size > TOMBSTONE_LIMIT) completedFailures.delete(completedFailures.keys().next().value);
  if (waitingSessions.get(entry.sessionID) === entry) waitingSessions.delete(entry.sessionID);
  if (!waitingSessions.size) {
    clearTimeout(recoveryTimer);
    recoveryTimer = undefined;
    clearTimeout(stateWatchRetryTimer);
    stateWatchRetryTimer = undefined;
    nextCheckAt = null;
    recoveryDelay = RECOVERY_INTERVAL_MS;
    networkRetryDelay = NETWORK_RETRY_BASE_MS;
    recoveryWaitUntil = 0;
    recoveryRetryAt = 0;
    recoveryHasLatestData = false;
    recoveryFailures = 0;
    recoveryCheckAfter = null;
    stateWatcher?.close();
    stateWatcher = undefined;
    stateSignature = "";
    stateReceiptAt = 0;
    stateResetAt = 0;
    pendingExternalRecovery = false;
  }
  publishRecoveryStatus();
}

async function sdkRequest(operation) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(operation()).then((result) => result?.error ? null : result),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS); }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function userInput(message) {
  if (!Array.isArray(message?.parts) || !message.parts.length) return "unknown";
  let incomplete = false;
  for (const part of message.parts) {
    if (part?.type === "file") return "genuine";
    if (part?.type !== "text" || typeof part.text !== "string" || !part.text.trim()) { incomplete = true; continue; }
    if (part.synthetic !== true && !/<!--\s*OMO_INTERNAL_INITIATOR\s*-->/.test(part.text)) return "genuine";
  }
  return incomplete ? "unknown" : "internal";
}

function recoveryHistory(entry, messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > SESSION_CACHE_LIMIT) return "defer";
  if (messages.some((message) => !message?.info?.id || !Number.isFinite(message.info.time?.created))) return "defer";
  const ordered = [...messages].sort((left, right) => left.info.time.created - right.info.time.created);
  if (ordered.some((message, index) => index && message.info.time.created === ordered[index - 1].info.time.created)) return "defer";
  const anchor = ordered.find((message) => message.info.id === entry.failureID);
  if (!anchor) return "defer";
  if (anchor.info.error?.name === "MessageAbortedError") return "aborted";
  if (anchor.info.time.completed && !anchor.info.error) return "original_success";
  if (anchor.info.providerID !== "openai" || classifyQuotaSignal(anchor.info) === null) return "defer";
  const newer = ordered.filter((message) => message.info.time.created > anchor.info.time.created);
  const users = new Map(newer.filter((message) => message.info.role === "user").map((message) => [message.info.id, userInput(message)]));
  if ([...users.values()].includes("genuine")) return "genuine_user";
  const assistants = newer.filter((message) => message.info.role === "assistant");
  if (assistants.some(({ info }) => info.time.completed && !info.error &&
      ["stop", "length", "content-filter", "content_filter"].includes(info.finish))) return "final_success";
  if (assistants.some(({ info }) => info.error?.name === "MessageAbortedError")) return "aborted";
  if (assistants.some(({ info }) => info.providerID && info.providerID !== "openai")) return "provider_changed";
  let uncertain = [...users.values()].includes("unknown") || [...entry.pendingUsers].some((id) => !users.has(id)) ||
    [...entry.observedAssistants].some((id) => !assistants.some((message) => message.info.id === id));
  for (const { info } of assistants) {
    if (!info.parentID || !info.providerID) { uncertain = true; continue; }
    const parent = ordered.find((message) => message.info.id === info.parentID);
    if (!parent) { uncertain = true; continue; }
    if (parent.info.time.created >= info.time.created) { uncertain = true; continue; }
    if (!users.has(info.parentID)) return "unrelated_assistant";
    if (users.get(info.parentID) !== "internal") { uncertain = true; continue; }
    if (!info.error) {
      if (!info.time.completed || info.finish !== "tool-calls" || info.id === assistants.at(-1)?.info.id) uncertain = true;
      continue;
    }
    const network = info.error.name === "APIConnectionError" || (info.error.name === "APIError" &&
      /\b(?:ECONNREFUSED|ECONNRESET)\b/.test(
        [info.error.message, info.error.data?.message].filter((value) => typeof value === "string").join(" ")));
    if (!network && classifyQuotaSignal(info) === null) return "unrelated_failure";
  }
  return uncertain ? "defer" : "eligible";
}

async function resume(entry) {
  if (!active(entry)) return;
  if (entry.resuming) { entry.recheck = true; return; }
  entry.resuming = true;
  try {
    do {
      entry.recheck = false;
      const revision = entry.revision;
      const result = await sdkRequest(() => entry.owner.client.session.messages({ path: { id: entry.sessionID }, query: { limit: SESSION_CACHE_LIMIT } }));
      if (!active(entry)) return;
      if (entry.revision !== revision) { entry.recheck = true; continue; }
      const reason = recoveryHistory(entry, Array.isArray(result) ? result : result?.data);
      entry.blocked = reason === "defer";
      if (reason !== "eligible" && reason !== "defer") {
        forget(entry, reason); return;
      }
      if (entry.blocked) return;
      if (entry.queued && recoveryFailures < MAX_RECOVERY_FAILURES) scheduleRecovery();
      if (!entry.ready || !entry.terminal || entry.status !== "idle") return;
      if (completedFailures.has(failureKey(entry))) { forget(entry); return; }
      const status = await sdkRequest(() => entry.owner.client.session.status());
      if (!active(entry)) return;
      if (entry.revision !== revision) { entry.recheck = true; continue; }
      if (entry.status !== "idle" || !status?.data || typeof status.data !== "object" || Array.isArray(status.data)) return;
      const current = status.data[entry.sessionID];
      if (current && current.type !== "idle") return;
      if (typeof entry.owner.client.session.promptAsync !== "function") return;
      entry.owner.logRecovery("dispatch", { sessionID: entry.sessionID, failureID: entry.failureID, reason: "quota_recovered" });
      forget(entry);
      const response = await sdkRequest(() => entry.owner.client.session.promptAsync({
        path: { id: entry.sessionID },
        body: { parts: [{ type: "text", text: "从上次中断的位置继续执行任务" }] },
      }));
      if (!response) entry.owner.notify("QuotaHot: 自动续跑未确认成功，请手动检查会话", "warning");
    } while (active(entry) && entry.recheck);
  } finally {
    entry.resuming = false;
  }
}

function scheduleRecovery(delay) {
  if (recoveryTimer || recoveryRunning || ![...waitingSessions.values()].some((entry) => entry.queued && !entry.blocked)) return;
  const due = Math.min(recoveryWaitUntil > 0 && recoveryWaitUntil + RESET_BUFFER_MS > Date.now() ? recoveryWaitUntil + RESET_BUFFER_MS : Infinity,
    Number.isFinite(stateResetAt) && stateResetAt > 0 && stateResetAt + RESET_BUFFER_MS > Date.now()
      ? stateResetAt + RESET_BUFFER_MS : Infinity);
  const wait = recoveryRetryAt > Date.now() ? recoveryRetryAt - Date.now()
    : delay ?? (Number.isFinite(due) ? Math.max(0, due - Date.now()) : recoveryDelay);
  const deadline = Date.now() + wait;
  const check = async () => {
    recoveryTimer = undefined;
    nextCheckAt = null;
    recoveryRunning = true;
    publishRecoveryStatus();
    const entries = [...waitingSessions.values()].filter((entry) => entry.queued && !entry.blocked);
    let owner;
    let contended = false;
    let retryDelay;
    let checkAfter = recoveryCheckAfter ?? Date.now();
    try {
      owner = entries[0]?.owner;
      if (!owner) return;
      watchRecoveryState();
      const attempt = recoveryFailures + 1;
      const result = await owner.run({ source: "opencode", recover: true, provider: "openai", quotaCheckAfter: checkAfter });
      const outcome = result?.switched ? "switched" : result?.outcome;
      retryDelay = retryDelayFor(outcome);
      contended = outcome === "lock_contended";
      lastCheckAt = Date.now();
      lastCheckResult = ["switched", "available", "no_candidate", "network_error", "check_failed", "lock_contended"].includes(outcome) ? outcome : "unknown";
      if (!contended && outcome !== "network_error") recoveryDelay = outcome === "switched" || outcome === "available"
        ? RECOVERY_INTERVAL_MS : Math.min(recoveryDelay * 2, 8 * RECOVERY_INTERVAL_MS);
      recoveryWaitUntil = Number.isFinite(result?.waitUntil) && result.waitUntil > Date.now() ? result.waitUntil : 0;
      recoveryHasLatestData = result?.latestData === true;
      recoveryFailures = recoveryHasLatestData || outcome === "switched" || outcome === "available" ? 0 : recoveryFailures + 1;
      await refreshRecoveryState(false);
      for (const entry of entries) {
        if (!active(entry)) continue;
        entry.ready = outcome === "switched" || outcome === "available";
        entry.queued = !entry.ready;
      }
      publishRecoveryStatus();
      owner.logRecovery("check attempt=" + attempt + "/" + MAX_RECOVERY_FAILURES + " outcome=" + lastCheckResult +
        " latestData=" + recoveryHasLatestData + " waitUntil=" + (recoveryWaitUntil || "none"));
      await Promise.all(entries.map(resume));
    } finally {
      recoveryRunning = false;
      const followUp = pendingExternalRecovery;
      pendingExternalRecovery = false;
      if (contended) {
        recoveryRetryAt = Date.now() + LOCK_RETRY_MS;
        recoveryCheckAfter ??= checkAfter;
      } else if (!followUp) recoveryCheckAfter = null;
      if (followUp && recoveryCheckAfter !== null) {
        scheduleRecovery(contended ? LOCK_RETRY_MS : 0);
      } else if (recoveryHasLatestData) {
        if (recoveryWaitUntil > Date.now() || stateResetAt > Date.now()) scheduleRecovery();
      } else if (recoveryFailures < MAX_RECOVERY_FAILURES) {
        scheduleRecovery(followUp ? Math.max(retryDelay ?? recoveryDelay, contended ? LOCK_RETRY_MS : 0) : retryDelay);
      }
      owner?.logRecovery("nextCheckAt=" + (nextCheckAt === null ? "none" : nextCheckAt) +
        " failures=" + recoveryFailures);
      publishRecoveryStatus();
    }
  };
  const arm = () => {
    const timer = setTimeout(async () => {
      if (recoveryTimer !== timer) return;
      if (Date.now() < deadline) {
        arm();
        return;
      }
      await check();
    }, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, deadline - Date.now())));
    recoveryTimer = timer;
    timer.unref?.();
  };
  nextCheckAt = deadline;
  arm();
  publishRecoveryStatus();
}

function retryDelayFor(outcome) {
  if (outcome !== "network_error") {
    networkRetryDelay = NETWORK_RETRY_BASE_MS;
    return undefined;
  }
  const delay = networkRetryDelay;
  networkRetryDelay = Math.min(networkRetryDelay * 2, NETWORK_RETRY_MAX_MS);
  return delay;
}

async function runInitialRecovery(wave, owner, run, payload) {
  if (!wave.check) {
    wave.check = (async () => {
      const attempt = recoveryFailures + 1;
      const result = await run(payload);
      const outcome = result?.switched ? "switched" : result?.outcome;
      const retryDelay = retryDelayFor(outcome);
      recoveryHasLatestData = result?.latestData === true;
      recoveryFailures = recoveryHasLatestData || outcome === "switched" || outcome === "available" ? 0 : recoveryFailures + 1;
      recoveryWaitUntil = Number.isFinite(result?.waitUntil) && result.waitUntil > Date.now() ? result.waitUntil : 0;
      owner.logRecovery("check attempt=" + attempt + "/" + MAX_RECOVERY_FAILURES + " outcome=" + (outcome || "unknown") +
        " latestData=" + recoveryHasLatestData + " waitUntil=" + (recoveryWaitUntil || "none"));
      return { result, retryDelay };
    })();
  }
  return wave.check;
}

function createRecovery(client, run, notify) {
  const owner = {
    client, run, notify, disposed: false,
    logRecovery(message, extra) {
      try { client?.app?.log?.({ body: { service: "quotahot", level: "info", message: "recovery " + message, ...(extra ? { extra } : {}) } })?.catch?.(() => {}); }
      catch { /* Logging must not affect recovery. */ }
    },
  };
  const recovery = {
    dispose: async () => {
      owner.disposed = true;
      for (const entry of waitingSessions.values()) if (entry.owner === owner) forget(entry, "disposed");
      await statusWrites;
    },
    observe: async (event, sessionID) => {
      const entry = waitingSessions.get(sessionID);
      if (!entry || entry.owner !== owner) return;
      const info = event.properties?.info;
      if (event.type === "session.deleted" || event.properties?.error?.name === "MessageAbortedError" ||
           info?.error?.name === "MessageAbortedError") { forget(entry, event.type === "session.deleted" ? "deleted" : "aborted"); return; }
      if (event.type === "session.error" && classifyQuotaSignal(event) === null) {
        entry.terminal = true;
        entry.status = "idle";
        entry.revision += 1;
        publishRecoveryStatus();
        await resume(entry);
        return;
      }
      if (event.type === "message.updated") {
        entry.revision += 1;
        if (info?.role === "assistant" && info.id === entry.failureID && info.time?.completed && !info.error) {
          forget(entry, "original_success");
          return;
        }
        if (info?.role === "assistant" && info.id !== entry.failureID &&
            (!Number.isFinite(info.time?.created) || entry.failureCreated === undefined || info.time.created >= entry.failureCreated)) {
          entry.observedAssistants.add(info.id);
          entry.blocked = true;
        }
        if (info?.role === "user" && info.id !== entry.parentID &&
             (!Number.isFinite(info.time?.created) || info.time.created >= entry.started ||
              (entry.failureCreated !== undefined && info.time.created >= entry.failureCreated))) {
          entry.pendingUsers.add(info.id);
          entry.blocked = true;
        }
        await resume(entry);
        if (active(entry) && entry.initialPending && !entry.blocked) await recovery.quota(entry.initialEvent, sessionID);
        return;
      }
      if (event.type === "message.part.updated" || event.type === "message.part.removed") {
        entry.revision += 1;
        await resume(entry);
        if (active(entry) && entry.initialPending && !entry.blocked) await recovery.quota(entry.initialEvent, sessionID);
        return;
      }
      if (event.type === "session.status" || event.type === "session.idle") {
        entry.status = event.type === "session.idle" ? "idle" : event.properties?.status?.type;
        entry.revision += 1;
        await resume(entry);
      }
    },
    quota: async (event, sessionID) => {
      if (owner.disposed || isDeleted(sessionID)) return;
      let entry = waitingSessions.get(sessionID);
      if (!entry) {
        entry = { sessionID, owner, started: Date.now(), revision: 0, status: "unknown", terminal: false,
          failureID: event.properties?.messageID, failureCreated: undefined, parentID: undefined,
          ready: false, queued: false, resuming: false, attempt: null, pendingUsers: new Set(), observedAssistants: new Set(), blocked: false,
          initialPending: true, initialEvent: event };
        waitingSessions.set(sessionID, entry);
        while (waitingSessions.size > SESSION_CACHE_LIMIT) forget(waitingSessions.values().next().value);
        publishRecoveryStatus();
      }
      if (entry.owner !== owner) return;
      if (event.type === "session.error") {
        entry.terminal = true;
        entry.status = "unknown";
        entry.revision += 1;
      } else {
        entry.terminal = false;
        entry.status = "retry";
        entry.revision += 1;
      }
      publishRecoveryStatus();
      if (entry.attempt) return entry.attempt;
      if (entry.queued || (entry.ready && entry.terminal)) return;
      const wave = initialRecoveryWave ??= { participants: 0, check: null, checkAfter: Date.now() };
      wave.participants += 1;
      const attempt = (async () => {
        try {
          const provider = await retryProvider(client, sessionID);
          if (!active(entry)) return;
          if (provider !== "openai") { waitingSessions.delete(sessionID); publishRecoveryStatus(); return; }
          const latest = entry.failureID && assistantMessages.get(sessionID)?.has(entry.failureID)
            ? [entry.failureID, assistantMessages.get(sessionID).get(entry.failureID)]
            : [...(assistantMessages.get(sessionID)?.entries() || [])].sort((left, right) => right[1].created - left[1].created)[0];
          entry.failureID ||= latest?.[0];
          entry.failureCreated = latest?.[1].created;
          entry.parentID = latest?.[1].parentID;
          if (completedFailures.has(failureKey(entry)) || completedFailures.has(JSON.stringify([sessionID, null]))) { forget(entry); return; }
          if (entry.pendingUsers.size) {
            await resume(entry);
            if (!active(entry) || entry.blocked) return;
          }
          entry.initialPending = false;
          const { result, retryDelay } = await runInitialRecovery(wave, owner, run, {
            source: "opencode", event, quotaCheckAfter: wave.checkAfter,
          });
          if (!active(entry)) return;
          recoveryCheckAfter = result?.outcome === "lock_contended" ? wave.checkAfter : null;
          entry.ready = result?.switched || result?.outcome === "switched" || result?.outcome === "available";
          entry.queued = !entry.ready;
          if (entry.queued) {
            await refreshRecoveryState(false);
            watchRecoveryState();
          }
          if (result?.outcome === "lock_contended") {
            recoveryRetryAt = Date.now() + LOCK_RETRY_MS;
            clearTimeout(recoveryTimer);
            recoveryTimer = undefined;
          }
          if (recoveryHasLatestData) {
            if (recoveryWaitUntil > Date.now() || stateResetAt > Date.now()) scheduleRecovery();
          } else if (recoveryFailures < MAX_RECOVERY_FAILURES) scheduleRecovery(retryDelay);
          owner.logRecovery("nextCheckAt=" + (nextCheckAt === null ? "none" : nextCheckAt) +
            " failures=" + recoveryFailures);
          publishRecoveryStatus();
          await resume(entry);
        } finally {
          wave.participants -= 1;
          if (wave.participants === 0 && initialRecoveryWave === wave) initialRecoveryWave = undefined;
        }
      })();
      entry.attempt = attempt;
      try { await attempt; } finally { entry.attempt = null; }
    },
    get disposed() { return owner.disposed; },
  };
  return recovery;
}

function sessionCache(sessionID) {
  let messages = assistantMessages.get(sessionID);
  if (!messages) messages = new Map();
  assistantMessages.delete(sessionID);
  assistantMessages.set(sessionID, messages);
  while (assistantMessages.size > SESSION_CACHE_LIMIT) assistantMessages.delete(assistantMessages.keys().next().value);
  return messages;
}

function isDeleted(sessionID) {
  const deletedAt = deletedSessions.get(sessionID);
  if (!deletedAt) return false;
  if (Date.now() - deletedAt > TOMBSTONE_TTL_MS) {
    deletedSessions.delete(sessionID);
    return false;
  }
  deletedSessions.delete(sessionID);
  deletedSessions.set(sessionID, deletedAt);
  return true;
}

function remember(sessionID, info) {
  if (!sessionID || info?.role !== "assistant" || !info.id || isDeleted(sessionID)) return;
  const messages = sessionCache(sessionID);
  const created = Number(info.time?.created || 0);
  const previous = messages.get(info.id);
  if (!previous || created >= previous.created) messages.set(info.id, { created, parentID: info.parentID, providerID: typeof info.providerID === "string" ? info.providerID : "" });
  while (messages.size > SESSION_CACHE_LIMIT) messages.delete(messages.keys().next().value);
}

function cachedProvider(sessionID) {
  const messages = assistantMessages.get(sessionID);
  if (!messages) return null;
  assistantMessages.delete(sessionID);
  assistantMessages.set(sessionID, messages);
  const latest = [...messages.values()].sort((a, b) => b.created - a.created);
  const newest = latest[0];
  if (!newest || latest.some((message) => message.created === newest.created && message.providerID !== newest.providerID)) return null;
  return newest.providerID || null;
}

function rememberLookup(sessionID, result) {
  if (result?.error) return;
  const data = Array.isArray(result) ? result : result?.data;
  for (const item of Array.isArray(data) ? data : []) remember(sessionID, item?.info);
}

async function retryProvider(client, sessionID) {
  if (isDeleted(sessionID)) return null;
  const cached = cachedProvider(sessionID);
  if (cached !== null) return cached;
  const existing = lookupPromises.get(sessionID);
  if (existing) return existing;
  const lookup = (async () => {
    let settled = false;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => { settled = true; resolve(null); }, LOOKUP_TIMEOUT_MS);
    });
    let request;
    try {
      request = Promise.resolve(client?.session?.messages?.({ path: { id: sessionID } })).then((result) => {
        if (settled || isDeleted(sessionID)) return null;
        settled = true;
        rememberLookup(sessionID, result);
        return cachedProvider(sessionID);
      }).catch(() => null);
    } catch {
      settled = true;
      request = Promise.resolve(null);
    }
    return Promise.race([request, timeout]).finally(() => clearTimeout(timer));
  })();
  lookupPromises.set(sessionID, lookup);
  try {
    return await lookup;
  } finally {
    lookupPromises.delete(sessionID);
  }
}

function quotaRetry(event) {
  const status = event?.properties?.status;
  if (event?.type !== "session.status" || status?.type !== "retry") return false;
  return classifyQuotaSignal(event) !== null;
}

function callHook(payload) {
  return new Promise((resolve) => {
    const parts = COMMAND;
    let child;
    try {
      child = spawn(parts[0], parts.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      resolve({ value: null, diagnostic: "" });
      return;
    }
    let out = "";
    let stderrBytes = 0;
    let stderrTruncated = false;
    let settled = false;
    let inputError = false;
    let killTimer;
    const stderrSummary = () => {
      if (stderrBytes === 0) return "";
      if (stderrTruncated) return "hook emitted at least " + HOOK_STDERR_LIMIT + " bytes on stderr";
      return "hook emitted " + stderrBytes + " bytes on stderr";
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ value, diagnostic: stderrSummary() });
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      settled = true;
      clearTimeout(timer);
      resolve({ value: null, diagnostic: stderrSummary() });
    }, 120000);
    child.stdout.on("data", (data) => {
      out += data.toString();
      if (Buffer.byteLength(out, "utf8") > 65536) {
        child.kill("SIGTERM");
        finish(null);
      }
    });
    child.stderr.on("data", (data) => {
      const total = stderrBytes + Buffer.byteLength(data);
      stderrTruncated ||= total > HOOK_STDERR_LIMIT;
      stderrBytes = Math.min(total, HOOK_STDERR_LIMIT);
    });
    child.on("error", () => finish(null));
    child.stdin.on("error", () => {
      inputError = true;
      child.kill("SIGTERM");
    });
    child.on("close", (code) => {
      if (code !== 0 || inputError) return finish(null);
      try { finish(JSON.parse(out || "{}")); } catch { finish(null); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export const QuotaHot = async ({ client }) => {
  const toast = (message, variant) => {
    try {
      client?.tui?.showToast?.({ body: { message, variant } })?.catch?.(() => {});
    } catch {
      console.log("[QuotaHot] " + message);
    }
  };

  let lastOutcome = "";
  const run = async (payload) => {
    const hook = await callHook(payload);
    const out = hook?.value;
    const diagnostic = hook?.diagnostic || "";
    const outcome = out?.switched ? "switched" : out?.outcome || "unknown";
    if (outcome !== lastOutcome) {
      lastOutcome = outcome;
      const messages = {
        switched: out?.message || "账户已切换",
        network_error: "额度查询网络失败，将快速重试",
        check_failed: "账户检查或写入失败，请检查额度查询网络、凭证及文件权限",
        no_candidate: "本次未切换：暂无可用候选，或仍在切换冷却期",
        unknown: "切换钩子执行失败，请检查安装和运行环境",
      };
      if (messages[outcome]) {
        toast("QuotaHot: " + messages[outcome], "warning");
        try {
          const message = diagnostic ? outcome + " (" + diagnostic + ")" : outcome;
          client?.app?.log?.({ body: { service: "quotahot", level: "info", message } })?.catch?.(() => {});
        } catch {
          console.warn("[QuotaHot] " + outcome);
        }
      }
    }
    return out;
  };

  const recovery = createRecovery(client, run, toast);
  return {
    dispose: recovery.dispose,
    event: async ({ event }) => {
      if (recovery.disposed || !event || typeof event.type !== "string") return;
      const sessionID = event.properties?.sessionID || event.properties?.info?.sessionID || event.properties?.part?.sessionID || event.properties?.info?.id;
      if (sessionID && deletedSessions.has(sessionID)) return;
      const quotaEvent = quotaRetry(event) ||
        (event.type === "session.error" && event.properties?.error?.name !== "MessageAbortedError" && classifyQuotaSignal(event) !== null);
      if (quotaEvent && sessionID) return recovery.quota(event, sessionID);
      await recovery.observe(event, sessionID);
      if (event.type === "session.deleted") {
        if (sessionID) {
          deletedSessions.set(sessionID, Date.now());
          while (deletedSessions.size > TOMBSTONE_LIMIT) deletedSessions.delete(deletedSessions.keys().next().value);
          assistantMessages.delete(sessionID);
          lookupPromises.delete(sessionID);
        }
        return;
      }
      if (event.type === "message.updated") {
        remember(event.properties?.info?.sessionID || event.properties?.sessionID, event.properties?.info);
        return;
      }
    },
  };
};
export default { id: "QuotaHot", server: QuotaHot };
// quotahot:end
