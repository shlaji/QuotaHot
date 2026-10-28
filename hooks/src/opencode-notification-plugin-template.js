// quotahot-session-notify:start
// QuotaHot OpenCode 会话通知插件，由 `quotahot-hook notify install` 生成。
import { spawn } from "node:child_process";

const COMMAND = "__QUOTAHOT_SESSION_NOTIFY_COMMAND_ARGS__";
const MAX_STDOUT_BYTES = 65536;
const CHILD_TIMEOUT_MS = 120000;

function sessionIDOf(event) {
  const properties = event?.properties;
  if (typeof properties?.sessionID === "string") return properties.sessionID;
  if (typeof properties?.info?.id === "string") return properties.info.id;
  return null;
}

function callHook(command, payload) {
  return new Promise((resolve) => {
    const [executable, ...prefixArgs] = command;
    const child = spawn(executable, [...prefixArgs, "notify", "send-session", "--json"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "";
    let settled = false;
    let killTimer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      finish({ state: "unknown", reason: "通知命令执行超时，投递状态未知" });
    }, CHILD_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on("data", (data) => {
      output += data.toString();
      if (Buffer.byteLength(output, "utf8") > MAX_STDOUT_BYTES) {
        child.kill("SIGTERM");
        finish({ state: "unknown", reason: "通知命令输出超出限制，投递状态未知" });
      }
    });
    child.on("error", () => finish({ state: "unknown", reason: "通知命令启动失败" }));
    child.stdin.on("error", () => child.kill("SIGTERM"));
    child.on("close", (code) => {
      if (code !== 0) {
        finish({ state: "unknown", reason: "通知命令未能确认投递结果" });
        return;
      }
      try {
        const result = JSON.parse(output);
        if (result !== null && typeof result === "object" && typeof result.state === "string") finish(result);
        else finish({ state: "unknown", reason: "通知命令返回结果无法解析" });
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        finish({ state: "unknown", reason: "通知命令返回结果无法解析" });
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function showResult(client, result) {
  const message = result.reason ? `会话通知：${result.state}；${result.reason}` : `会话通知：${result.state}`;
  const variant = result.state === "sent" ? "success" : "warning";
  await client?.tui?.showToast?.({ body: { message, variant } });
  await client?.app?.log?.({
    body: {
      service: "quotahot-session-notify",
      level: variant === "success" ? "info" : "warn",
      message: result.reason ? `${result.state}: ${result.reason}` : result.state,
    },
  });
}

export function createSessionNotificationPlugin({ client, send }) {
  const pending = new Map();
  const deleted = new Set();
  let disposed = false;
  const deliver = send ?? ((payload) => callHook(COMMAND, payload));

  return {
    async event({ event }) {
      if (disposed || typeof event?.type !== "string") return;
      const sessionID = sessionIDOf(event);
      if (!sessionID) return;
      if (event.type === "session.deleted") {
        deleted.add(sessionID);
        return;
      }
      if (event.type !== "session.idle" || deleted.has(sessionID)) return;

      const active = pending.get(sessionID);
      if (active) return active;
      const attempt = (async () => {
        const response = await client.session.messages({ path: { id: sessionID } });
        if (disposed || deleted.has(sessionID)) return;
        const result = await deliver({ sessionId: sessionID, messages: response });
        if (!disposed && !deleted.has(sessionID)) await showResult(client, result);
      })();
      pending.set(sessionID, attempt);
      try {
        await attempt;
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        if (!disposed && !deleted.has(sessionID)) {
          await showResult(client, { state: "unknown", reason: "无法读取会话或确认通知结果" });
        }
      } finally {
        if (pending.get(sessionID) === attempt) pending.delete(sessionID);
      }
    },
    dispose() {
      disposed = true;
      pending.clear();
      deleted.clear();
    },
  };
}

export const SessionNotification = async (context) => createSessionNotificationPlugin(context);
export default SessionNotification;
// quotahot-session-notify:end
