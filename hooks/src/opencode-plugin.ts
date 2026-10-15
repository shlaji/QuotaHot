import { classifyQuotaSignal } from './quota-signal.js';
import { opencodeRecoverySource } from './opencode-recovery.js';

export function opencodePlugin(command: string | readonly string[]): string {
  return `// quotahot:start
// 由 \`quotahot-hook install\` 生成；重新安装会整份覆盖。
// 作用：明确触限时切换账户，额度恢复后续跑仍处于失败空闲状态的会话。
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const COMMAND = ${JSON.stringify(typeof command === 'string' ? [command] : command)};
const classifyQuotaSignal = ${classifyQuotaSignal.toString()};
const HOOK_STDERR_LIMIT = 8192;
const SESSION_CACHE_LIMIT = 128;
const TOMBSTONE_LIMIT = 1024;
const TOMBSTONE_TTL_MS = 600000;
const LOOKUP_TIMEOUT_MS = 2000;
const assistantMessages = new Map();
const lookupPromises = new Map();
const deletedSessions = new Map();
${opencodeRecoverySource}

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
`;
}
