// quotahot:omo-extension
// 只在 OmO 内建账户轮换和重试结束后，尝试一次 QuotaHot 账户切换与续跑。
import { spawn } from 'node:child_process';

const COMMAND = "__QUOTAHOT_OMO_COMMAND_ARGS__";
const QUOTA_ERROR = /\brate[ _-]?limit(?:_exceeded| exceeded|ed)?\b|\busage[ _-]?limit(?:[ _-]reached| has been reached)?\b|\bquota(?:[ _-](?:exhausted|exceeded)| has been exhausted)\b|\btoo many requests\b|you'?ve (?:hit|reached) your|\binsufficient_quota\b|\bresets? (?:at|in)\b/i;

export default function (pi) {
  let lastError = '';
  let attempted = false;
  let quotaStatus = false;
  let revision = 0;
  let pendingChild;

  pi.on('input', (event) => {
    if (event.attribution !== 'user') return;
    attempted = false;
    lastError = '';
    quotaStatus = false;
    revision += 1;
    pendingChild?.kill('SIGTERM');
  });
  for (const name of ['session_shutdown', 'model_select']) {
    pi.on(name, () => {
      revision += 1;
      lastError = '';
      pendingChild?.kill('SIGTERM');
    });
  }

  pi.on('after_provider_response', (event, ctx) => {
    if (ctx.model?.provider === 'chatgpt-subscription' && event.status === 429) quotaStatus = true;
  });

  pi.on('turn_end', (event) => {
    const message = event.message;
    lastError = message?.role === 'assistant' && message.stopReason === 'error'
      && message.provider === 'chatgpt-subscription' && message.failureSource !== 'local'
      && !message.content?.length
      && message.errorCause?.scope !== 'model'
      && (message.errorCause?.type === 'usage_limit'
        || message.providerDiagnostic?.category === 'quota'
        || message.providerDiagnostic?.category === 'rate_limit'
        || typeof message.errorMessage === 'string' && QUOTA_ERROR.test(message.errorMessage)
        || quotaStatus)
      ? quotaStatus ? '429' : 'quota exhausted' : '';
  });

  pi.on('agent_before_settle', async (event, ctx) => {
    if (attempted || !lastError || event.outcome !== 'error'
      || ctx.model?.provider !== 'chatgpt-subscription') return;
    attempted = true;
    const started = revision;
    const error = lastError;
    lastError = '';
    const result = await new Promise((resolve) => {
      const child = spawn(COMMAND[0], [...COMMAND.slice(1), 'run', 'omo'], {
        env: { ...process.env, OMO_CODING_AGENT_DIR: ctx.agentDir },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      pendingChild = child;
      let output = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
      child.on('error', () => { clearTimeout(timer); resolve(null); });
      child.stdin.on('error', () => child.kill('SIGTERM'));
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        if (output.length > 65_536) child.kill('SIGTERM');
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (pendingChild === child) pendingChild = undefined;
        if (code !== 0 || output.length > 65_536) return resolve(null);
        try { resolve(JSON.parse(output)); } catch { resolve(null); }
      });
      child.stdin.end(JSON.stringify({ source: 'omo', provider: 'chatgpt-subscription',
        error: { message: error, ...(error === '429' ? { statusCode: 429 } : {}) } }));
    });
    if (!result?.switched || revision !== started || ctx.model?.provider !== 'chatgpt-subscription') return;
    if (ctx.modelRegistry.authStorage.reload() !== 'loaded') return;
    if (ctx.hasUI) ctx.ui.notify('继续当前任务', 'info');
    return {
      entries: [...event.entries, {
        type: 'custom_message', customType: 'quotahot-recovery', display: false,
        content: '额度账户已切换。继续当前任务，先核对已经完成的工具操作，避免重复执行。',
      }],
      continue: true,
    };
  });
}
