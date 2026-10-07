import { classifyQuotaSignal } from './quota-signal.js';

export const PI_EXTENSION_MARKER = '// quotahot:pi-extension';

export function piExtensionSource(command: readonly string[]): string {
  return `${PI_EXTENSION_MARKER}
import { spawn } from 'node:child_process';

const COMMAND = ${JSON.stringify(command)};
const classifyQuotaSignal = ${classifyQuotaSignal.toString()};

function callHook(message) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(COMMAND[0], COMMAND.slice(1), { stdio: ['pipe', 'pipe', 'ignore'], shell: false });
    } catch {
      resolve(false);
      return;
    }
    let output = '';
    let settled = false;
    const finish = (switched) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(switched);
    };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(false); }, 20000);
    child.on('error', () => finish(false));
    child.stdin.on('error', () => { child.kill('SIGTERM'); finish(false); });
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (Buffer.byteLength(output, 'utf8') > 65536) { child.kill('SIGTERM'); finish(false); }
    });
    child.on('close', (code) => {
      if (code !== 0) return finish(false);
      try { finish(JSON.parse(output).switched === true); } catch { finish(false); }
    });
    child.stdin.end(JSON.stringify(message));
  });
}

export default function (pi) {
  pi.on('message_end', async (event, ctx) => {
    try {
      const message = event.message;
      if (message?.role !== 'assistant' || message.stopReason !== 'error') return;
      if (message.provider !== 'anthropic' && message.provider !== 'openai-codex') return;
      const text = message.errorMessage;
      if (typeof text !== 'string' || !/(?:quota|limit)(?:\\b|_)|\\btoo many requests\\b/i.test(text)) return;
      if (classifyQuotaSignal({ message: text }) !== 'quota_phrase') return;
      if (await callHook(message)) {
        try {
          ctx.ui?.notify?.('QuotaHot: Pi 账户已切换。本次失败请求不会自动重试；新凭证将在后续使用时生效。', 'info');
        } catch { /* UI is optional in non-interactive Pi modes. */ }
      }
    } catch { /* Never block Pi on an integration failure. */ }
  });
}
`;
}
