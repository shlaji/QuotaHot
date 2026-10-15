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

const RECOVERY_INTERVAL_MS = 1800000;
const RESET_BUFFER_MS = 60000;
const STATE_PATH = join(process.env.QUOTAHOT_DATA_DIR ?? join(homedir(), ".quotahot"), "switch-state.json");
const RECOVERY_STATUS_DIR = "recovery-status";
const recoveryStatusID = randomUUID();
const recoveryStatusPath = join(process.env.QUOTAHOT_DATA_DIR ?? join(homedir(), ".quotahot"), RECOVERY_STATUS_DIR, recoveryStatusID + ".json");
const waitingSessions = new Map();
const completedFailures = new Map();
let recoveryTimer;
let nextCheckAt = null;
let heartbeatTimer;
let statusWrites = Promise.resolve();
let lastCheckAt = null;
let lastCheckResult = null;
let recoveryRunning = false;
let recoveryDelay = RECOVERY_INTERVAL_MS;
let recoveryWaitUntil = 0;
let stateWatcher;
let stateSignature = "";
let stateResetAt = 0;
let stateReading = false;
let stateReadAgain = false;
let pendingExternalRecovery = false;

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
    const now = Date.now();
    return {
      signature: JSON.stringify(quotas),
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
      const changed = state.signature !== stateSignature;
      stateSignature = state.signature;
      stateResetAt = state.resetAt;
      if (external && changed && [...waitingSessions.values()].some((entry) => entry.queued)) {
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
    stateWatcher = watch(dirname(STATE_PATH), (_event, filename) => {
      if (filename === "switch-state.json") void refreshRecoveryState(true);
    });
    stateWatcher.unref?.();
  } catch {
    // The data directory may not exist yet; the timer remains the fallback.
  }
}

function failureKey(entry) {
  return JSON.stringify([entry.sessionID, entry.failureID || null]);
}

function active(entry) {
  return !entry.owner.disposed && waitingSessions.get(entry.sessionID) === entry && !isDeleted(entry.sessionID);
}

function forget(entry) {
  completedFailures.set(failureKey(entry), true);
  while (completedFailures.size > TOMBSTONE_LIMIT) completedFailures.delete(completedFailures.keys().next().value);
  if (waitingSessions.get(entry.sessionID) === entry) waitingSessions.delete(entry.sessionID);
  if (!waitingSessions.size) {
    clearTimeout(recoveryTimer);
    recoveryTimer = undefined;
    nextCheckAt = null;
    recoveryDelay = RECOVERY_INTERVAL_MS;
    recoveryWaitUntil = 0;
    stateWatcher?.close();
    stateWatcher = undefined;
    stateSignature = "";
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

async function resume(entry) {
  if (!active(entry) || !entry.ready || !entry.terminal || entry.status !== "idle" || entry.resuming) return;
  entry.resuming = true;
  const revision = entry.revision;
  try {
    const result = await sdkRequest(() => entry.owner.client.session.messages({ path: { id: entry.sessionID } }));
    if (!active(entry) || entry.revision !== revision || !result) return;
    const messages = Array.isArray(result) ? result : result.data;
    if (!Array.isArray(messages) || messages.length === 0) return;
    const infos = messages.map((message) => message?.info);
    if (infos.some((info) => !info?.id || !Number.isFinite(info.time?.created))) return;
    infos.sort((left, right) => right.time.created - left.time.created);
    const latest = infos[0];
    if (infos.some((info) => info.id !== latest.id && info.time.created === latest.time.created)) return;
    if (latest.role !== "assistant" || latest.providerID !== "openai" ||
        latest.error?.name === "MessageAbortedError" || classifyQuotaSignal(latest) === null ||
        (entry.failureID ? latest.id !== entry.failureID : latest.time.created > entry.started)) {
      forget(entry);
      return;
    }
    if (!entry.failureID) entry.failureID = latest.id;
    if (completedFailures.has(failureKey(entry))) { forget(entry); return; }
    const status = await sdkRequest(() => entry.owner.client.session.status());
    if (!active(entry) || entry.revision !== revision || entry.status !== "idle" || !status?.data ||
        typeof status.data !== "object" || Array.isArray(status.data)) return;
    const current = status.data[entry.sessionID];
    if (current && current.type !== "idle") return;
    if (typeof entry.owner.client.session.promptAsync !== "function") return;
    forget(entry);
    const response = await sdkRequest(() => entry.owner.client.session.promptAsync({
      path: { id: entry.sessionID },
      body: { parts: [{ type: "text", text: "Continue the interrupted task from the existing conversation. Check what is already done before repeating actions." }] },
    }));
    if (!response) entry.owner.notify("QuotaHot: 自动续跑未确认成功，请手动检查会话", "warning");
  } finally {
    entry.resuming = false;
  }
}

function scheduleRecovery(delay) {
  if (recoveryTimer || recoveryRunning || ![...waitingSessions.values()].some((entry) => entry.queued)) return;
  const due = Math.min(recoveryWaitUntil > 0 && recoveryWaitUntil + RESET_BUFFER_MS > Date.now() ? recoveryWaitUntil + RESET_BUFFER_MS : Infinity,
    Number.isFinite(stateResetAt) && stateResetAt > 0 && stateResetAt + RESET_BUFFER_MS > Date.now()
      ? stateResetAt + RESET_BUFFER_MS : Infinity);
  const wait = delay ?? (Number.isFinite(due) ? Math.max(0, due - Date.now()) : recoveryDelay);
  recoveryTimer = setTimeout(async () => {
    recoveryTimer = undefined;
    nextCheckAt = null;
    recoveryRunning = true;
    publishRecoveryStatus();
    const entries = [...waitingSessions.values()].filter((entry) => entry.queued);
    try {
      const owner = entries[0]?.owner;
      if (!owner) return;
      const result = await owner.run({ source: "opencode", recover: true, provider: "openai" });
      const outcome = result?.switched ? "switched" : result?.outcome;
      lastCheckAt = Date.now();
      lastCheckResult = ["switched", "available", "no_candidate", "check_failed"].includes(outcome) ? outcome : "unknown";
      recoveryDelay = outcome === "switched" || outcome === "available"
        ? RECOVERY_INTERVAL_MS : Math.min(recoveryDelay * 2, 8 * RECOVERY_INTERVAL_MS);
      recoveryWaitUntil = Number.isFinite(result?.waitUntil) && result.waitUntil > Date.now() ? result.waitUntil : 0;
      await refreshRecoveryState(false);
      for (const entry of entries) {
        if (!active(entry)) continue;
        entry.ready = outcome === "switched" || outcome === "available";
        entry.queued = !entry.ready;
      }
      publishRecoveryStatus();
      await Promise.all(entries.map(resume));
    } finally {
      recoveryRunning = false;
      const followUp = pendingExternalRecovery;
      pendingExternalRecovery = false;
      scheduleRecovery(followUp ? 0 : undefined);
      publishRecoveryStatus();
    }
  }, wait);
  nextCheckAt = Date.now() + wait;
  recoveryTimer.unref?.();
  publishRecoveryStatus();
}

function createRecovery(client, run, notify) {
  const owner = { client, run, notify, disposed: false };
  return {
    dispose: async () => {
      owner.disposed = true;
      for (const entry of waitingSessions.values()) if (entry.owner === owner) forget(entry);
      await statusWrites;
    },
    observe: async (event, sessionID) => {
      const entry = waitingSessions.get(sessionID);
      if (!entry || entry.owner !== owner) return;
      const info = event.properties?.info;
      if (event.type === "session.deleted" || event.properties?.error?.name === "MessageAbortedError" ||
           info?.error?.name === "MessageAbortedError") { forget(entry); return; }
      if (event.type === "session.error" && classifyQuotaSignal(event) === null) { forget(entry); return; }
      if (event.type === "message.updated") {
        entry.revision += 1;
        if (info?.role === "assistant" && info.id === entry.failureID && info.time?.completed && !info.error) {
          forget(entry);
          return;
        }
        if (info?.role === "assistant" && entry.failureID && info.id !== entry.failureID &&
            info.time?.created >= entry.failureCreated) { forget(entry); return; }
        if (info?.role === "user" && info.id !== entry.parentID &&
            (!Number.isFinite(info.time?.created) || info.time.created >= entry.started ||
             (entry.failureCreated !== undefined && info.time.created >= entry.failureCreated))) forget(entry);
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
          ready: false, queued: false, resuming: false, attempt: null };
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
      const attempt = (async () => {
        const provider = await retryProvider(client, sessionID);
        if (!active(entry)) return;
        if (provider !== "openai") { waitingSessions.delete(sessionID); publishRecoveryStatus(); return; }
        const latest = [...(assistantMessages.get(sessionID)?.entries() || [])].sort((left, right) => right[1].created - left[1].created)[0];
        entry.failureID ||= latest?.[0];
        entry.failureCreated = latest?.[1].created;
        entry.parentID = latest?.[1].parentID;
        if (completedFailures.has(failureKey(entry)) || completedFailures.has(JSON.stringify([sessionID, null]))) { forget(entry); return; }
        const result = await run({ source: "opencode", event });
        if (!active(entry)) return;
        entry.ready = result?.switched || result?.outcome === "switched" || result?.outcome === "available";
        entry.queued = !entry.ready;
        if (entry.queued) {
          recoveryWaitUntil = Number.isFinite(result?.waitUntil) && result.waitUntil > Date.now() ? result.waitUntil : 0;
          await refreshRecoveryState(false);
          watchRecoveryState();
        }
        scheduleRecovery();
        publishRecoveryStatus();
        await resume(entry);
      })();
      entry.attempt = attempt;
      try { await attempt; } finally { entry.attempt = null; }
    },
    get disposed() { return owner.disposed; },
  };
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
      const sessionID = event.properties?.sessionID || event.properties?.info?.sessionID || event.properties?.info?.id;
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
