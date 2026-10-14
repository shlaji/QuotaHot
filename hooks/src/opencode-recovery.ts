export const opencodeRecoverySource = `
const RECOVERY_INTERVAL_MS = 1800000;
const waitingSessions = new Map();
const completedFailures = new Map();
let recoveryTimer;
let recoveryRunning = false;
let recoveryDelay = RECOVERY_INTERVAL_MS;

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
    recoveryDelay = RECOVERY_INTERVAL_MS;
  }
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

function scheduleRecovery() {
  if (recoveryTimer || recoveryRunning || ![...waitingSessions.values()].some((entry) => entry.queued)) return;
  recoveryTimer = setTimeout(async () => {
    recoveryTimer = undefined;
    recoveryRunning = true;
    const entries = [...waitingSessions.values()].filter((entry) => entry.queued);
    try {
      const owner = entries[0]?.owner;
      if (!owner) return;
      const result = await owner.run({ source: "opencode", recover: true, provider: "openai" });
      const outcome = result?.switched ? "switched" : result?.outcome;
      recoveryDelay = outcome === "check_failed" || !outcome
        ? Math.min(recoveryDelay * 2, 8 * RECOVERY_INTERVAL_MS) : RECOVERY_INTERVAL_MS;
      for (const entry of entries) {
        if (!active(entry)) continue;
        entry.ready = outcome === "switched" || outcome === "available";
        entry.queued = !entry.ready;
      }
      await Promise.all(entries.map(resume));
    } finally {
      recoveryRunning = false;
      scheduleRecovery();
    }
  }, recoveryDelay);
  recoveryTimer.unref?.();
}

function createRecovery(client, run, notify) {
  const owner = { client, run, notify, disposed: false };
  return {
    dispose: async () => {
      owner.disposed = true;
      for (const entry of waitingSessions.values()) if (entry.owner === owner) forget(entry);
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
      if (entry.attempt) return entry.attempt;
      if (entry.queued || (entry.ready && entry.terminal)) return;
      const attempt = (async () => {
        const provider = await retryProvider(client, sessionID);
        if (!active(entry)) return;
        if (provider !== "openai") { waitingSessions.delete(sessionID); return; }
        const latest = [...(assistantMessages.get(sessionID)?.entries() || [])].sort((left, right) => right[1].created - left[1].created)[0];
        entry.failureID ||= latest?.[0];
        entry.failureCreated = latest?.[1].created;
        entry.parentID = latest?.[1].parentID;
        if (completedFailures.has(failureKey(entry)) || completedFailures.has(JSON.stringify([sessionID, null]))) { forget(entry); return; }
        const result = await run({ source: "opencode", event });
        if (!active(entry)) return;
        entry.ready = result?.switched || result?.outcome === "switched" || result?.outcome === "available";
        entry.queued = !entry.ready;
        scheduleRecovery();
        await resume(entry);
      })();
      entry.attempt = attempt;
      try { await attempt; } finally { entry.attempt = null; }
    },
    get disposed() { return owner.disposed; },
  };
}
`;
