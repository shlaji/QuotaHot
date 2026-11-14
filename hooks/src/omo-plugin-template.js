// quotahot:omo-extension
// 只在 OmO 内建账户轮换和重试结束后，尝试一次 QuotaHot 账户切换与续跑。
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// __QUOTAHOT_OMO_RECOVERY__
// __QUOTAHOT_OMO_RECOVERY_STATUS__

const COMMAND = "__QUOTAHOT_OMO_COMMAND_ARGS__";
const QUOTA_ERROR = /\brate[ _-]?limit(?:_exceeded| exceeded|ed)?\b|\busage[ _-]?limit(?:[ _-]reached| has been reached)?\b|\bquota(?:[ _-](?:exhausted|exceeded)| has been exhausted)\b|\btoo many requests\b|you'?ve (?:hit|reached) your|\binsufficient_quota\b|\bresets? (?:at|in)\b/i;
const recovery = createOmoRecovery();

export default function (pi) {
  let lastError = '';
  let attempted = false;
  let quotaStatus = false;
  let revision = 0;
  let requestIdentity;
  let recoveryEntry;
  let stopSignal;

  function cancelRecovery() {
    if (recoveryEntry) recovery.cancel(recoveryEntry);
    recoveryEntry = undefined;
    stopSignal?.();
    stopSignal = undefined;
  }

  pi.on('input', (event) => {
    if (event.attribution !== 'user') return;
    attempted = false;
    lastError = '';
    quotaStatus = false;
    requestIdentity = undefined;
    revision += 1;
    cancelRecovery();
  });
  for (const name of ['session_shutdown', 'model_select']) {
    pi.on(name, () => {
      revision += 1;
      cancelRecovery();
      lastError = '';
      requestIdentity = undefined;
    });
  }

  pi.on('before_provider_request', (event, ctx) => {
    requestIdentity = undefined;
    if ((event.model ?? ctx.model)?.provider !== 'chatgpt-subscription') return;
    const credential = ctx.modelRegistry.authStorage.get('chatgpt-subscription');
    if (credential?.type !== 'oauth' || (credential.accounts && credential.accounts.length !== 1)) return;
    const selected = credential.accounts?.[0] ?? credential;
    if (typeof selected.accountId !== 'string' || !selected.accountId) return;
    requestIdentity = {
      accountId: selected.accountId,
      email: typeof selected.email === 'string' ? selected.email : typeof credential.email === 'string' ? credential.email : '',
      loginId: typeof credential.loginId === 'string' ? credential.loginId : '',
    };
  });

  pi.on('after_provider_response', (event, ctx) => {
    if (ctx.model?.provider === 'chatgpt-subscription' && event.status === 429) quotaStatus = true;
  });

  pi.on('turn_end', (event) => {
    const message = event.message;
    if (recoveryEntry && message?.role === 'assistant'
      && ['stop', 'length', 'aborted'].includes(message.stopReason)) {
      revision += 1;
      cancelRecovery();
    }
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

  function runCheck(ctx, identity, error, recover, signal, quotaCheckAfter) {
    return new Promise((resolve) => {
      const child = spawn(COMMAND[0], [...COMMAND.slice(1), 'run', 'omo'], {
        env: { ...process.env, OMO_CODING_AGENT_DIR: ctx.agentDir },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const cancel = () => child.kill('SIGTERM');
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      let output = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
      child.on('error', () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); resolve(null); });
      child.stdin.on('error', () => child.kill('SIGTERM'));
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        if (output.length > 65_536) child.kill('SIGTERM');
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (code !== 0 || output.length > 65_536 || signal?.aborted) return resolve(null);
        try { resolve(JSON.parse(output)); } catch { resolve(null); }
      });
      child.stdin.end(JSON.stringify({ source: 'omo', provider: 'chatgpt-subscription',
        error: { message: error, ...(error === '429' ? { statusCode: 429 } : {}) },
        omoRequest: identity, ...(recover ? { recover: true } : {}),
        ...(Number.isFinite(quotaCheckAfter) ? { quotaCheckAfter } : {}) }));
    });
  }

  pi.on('agent_before_settle', async (event, ctx) => {
    if (attempted || !lastError || event.outcome !== 'error'
      || ctx.model?.provider !== 'chatgpt-subscription' || !requestIdentity || ctx.signal?.aborted) return;
    attempted = true;
    const started = revision;
    const identity = requestIdentity;
    const error = lastError;
    lastError = '';
    const entry = {
      key: JSON.stringify([ctx.agentDir, identity]),
      identity,
      sessionID: ctx.sessionManager?.getSessionId?.() ?? randomUUID(),
      active: () => revision === started && !ctx.signal?.aborted && ctx.model?.provider === 'chatgpt-subscription',
      idle: () => ctx.isIdle(),
      run: (options, signal) => runCheck(ctx, identity, error, options.recover, signal, options.quotaCheckAfter),
      notify: (message, kind) => { if (ctx.hasUI) ctx.ui.notify(message, kind); },
      resume: async () => {
        if (!entry.active() || !ctx.isIdle()) return false;
        if (ctx.modelRegistry.authStorage.reload() !== 'loaded' || !await pi.setSessionModel(ctx.model)
          || !entry.active() || !ctx.isIdle()) return false;
        cancelRecovery();
        if (ctx.hasUI) ctx.ui.notify('继续当前任务', 'info');
        await pi.sendUserMessage('继续当前任务');
        return true;
      },
    };
    recoveryEntry = entry;
    const abort = () => recovery.cancel(entry);
    ctx.signal?.addEventListener('abort', abort, { once: true });
    stopSignal = () => ctx.signal?.removeEventListener('abort', abort);
    const result = await recovery.check(entry);
    if (revision !== started || ctx.signal?.aborted || ctx.model?.provider !== 'chatgpt-subscription') return;
    if (!result?.switched && !result?.resume) {
      if (ctx.hasUI) ctx.ui.notify('已启动后台额度恢复检查', 'info');
      return;
    }
    cancelRecovery();
    if ((!result?.switched && !result?.resume) || revision !== started || ctx.signal?.aborted
      || ctx.model?.provider !== 'chatgpt-subscription') return;
    if (ctx.modelRegistry.authStorage.reload() !== 'loaded') return;
    // 同一模型的会话级重设会清除 OmO 为旧账户保留的 provider 额度冷却。
    if (!await pi.setSessionModel(ctx.model) || revision !== started || ctx.signal?.aborted
      || ctx.model?.provider !== 'chatgpt-subscription') return;
    if (ctx.hasUI) ctx.ui.notify('继续当前任务', 'info');
    return {
      entries: [...event.entries, {
        type: 'custom_message', customType: 'quotahot-recovery', display: false,
        content: result.switched
          ? '继续当前任务'
          : '继续当前任务',
      }],
      continue: true,
    };
  });
}
