import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAUDE_OAUTH_BETA,
  CLAUDE_VERSION,
  CODEX_CLIENT_VERSION,
  claudeModelsHeaders,
  claudeOAuthHeaders,
  codexModelsHeaders,
  codexResponsesHeaders,
  codexSubscriptionHeaders,
  codexWebHeaders,
} from '../src/server/headers.js';

/**
 * 每个端点在官方客户端里由哪个 HTTP 栈发出，这里就该长成哪个样子。
 * 这些值一旦漂了，上游多半不会报错，只是悄悄换一种对待方式——所以要钉住。
 */

test('OAuth 控制面走 axios 形态，而不是 CLI 身份', () => {
  const h = claudeOAuthHeaders('tok-123');
  assert.equal(h['user-agent'], 'axios/1.15.2');
  assert.equal(h.accept, 'application/json, text/plain, */*');
  assert.equal(h.connection, 'close');
  // axios 的压缩协商里没有 zstd，SDK 那条路径才有
  assert.doesNotMatch(h['accept-encoding'], /zstd/);
  assert.equal(h.authorization, 'Bearer tok-123');
  assert.equal(h['cache-control'], 'no-cache');
  // 这条路径不该出现任何 claude-cli 痕迹
  assert.doesNotMatch(JSON.stringify(h), /claude-cli|stainless/);
});

test('令牌端点不带 Authorization，也不带 cache-control', () => {
  const h = claudeOAuthHeaders();
  assert.equal(h.authorization, undefined);
  assert.equal(h['cache-control'], undefined);
  assert.equal(h['user-agent'], 'axios/1.15.2');
});

test('只有 usage 那条路径额外声明 OAuth beta', () => {
  assert.equal(claudeOAuthHeaders('t', CLAUDE_OAUTH_BETA)['anthropic-beta'], CLAUDE_OAUTH_BETA);
  assert.equal(claudeOAuthHeaders('t')['anthropic-beta'], undefined);
});

test('/v1/models 用 SDK 形态，但只声明 OAuth beta', () => {
  const h = claudeModelsHeaders('tok');
  assert.equal(h['anthropic-beta'], CLAUDE_OAUTH_BETA);
  assert.equal(h['x-stainless-lang'], 'js');
  assert.equal(h['anthropic-version'], '2023-06-01');
});

test('/v1/models 请求头带齐 SDK 指纹与会话标识', () => {
  const h = claudeModelsHeaders('TOKEN');
  assert.equal(h['user-agent'], `claude-cli/${CLAUDE_VERSION} (external, cli)`);
  assert.equal(h['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(h['x-stainless-runtime'], 'node');
  assert.equal(h['x-stainless-retry-count'], '0');
  assert.equal(h['x-stainless-timeout'], '600');
  assert.equal(h['x-app'], 'cli');
  assert.match(h['x-claude-code-session-id'], /^[0-9a-f-]{36}$/);
  assert.match(h['x-client-request-id'], /^[0-9a-f-]{36}$/);
});

test('会话 ID 一次运行内不变，请求 ID 每条都换', () => {
  const a = claudeModelsHeaders('T');
  const b = claudeModelsHeaders('T');
  assert.equal(a['x-claude-code-session-id'], b['x-claude-code-session-id']);
  assert.notEqual(a['x-client-request-id'], b['x-client-request-id']);
});

test('Codex CLI 身份三处版本号一致：UA、version 头、目录查询串', () => {
  const h = codexResponsesHeaders('tok', 'acct-1');
  assert.equal(h.version, CODEX_CLIENT_VERSION);
  assert.ok(h['user-agent'].includes(CODEX_CLIENT_VERSION));
  assert.equal(h.originator, 'codex-tui');
  assert.ok(h['user-agent'].startsWith('codex-tui/'));
  // 早期的 codex_cli_rs 已经不是线上形态了
  assert.doesNotMatch(h['user-agent'], /codex_cli_rs/);
  assert.doesNotMatch(h['user-agent'], /0\.0\.0/);
});

test('Codex 两个 CLI 端点报的是同一台机器', () => {
  const responses = codexResponsesHeaders('tok', 'acct-1');
  const models = codexModelsHeaders('tok', 'acct-1');
  assert.equal(responses['user-agent'], models['user-agent']);
  assert.equal(responses.originator, models.originator);
  // 目录接口不是流式对话，不该带这两个
  assert.equal(models['openai-beta'], undefined);
  assert.equal(models.session_id, undefined);
  assert.equal(models.accept, 'application/json');
});

test('Codex CLI 与 Claude CLI 声称的架构一致', () => {
  const codexUa = codexResponsesHeaders('tok', 'a')['user-agent'];
  assert.ok(codexUa.includes('arm64'));
  assert.equal(claudeModelsHeaders('tok')['x-stainless-arch'], 'arm64');
  // 一台 arm64 Mac 不会同时是 Linux/x86_64
  assert.doesNotMatch(codexUa, /Linux|x86_64/);
});

test('每次对话换一个 session_id 和请求 ID', () => {
  const a = codexResponsesHeaders('tok', 'acct-1');
  const b = codexResponsesHeaders('tok', 'acct-1');
  assert.notEqual(a.session_id, b.session_id);
  assert.notEqual(a['x-client-request-id'], b['x-client-request-id']);
});

test('wham 一族仍走桌面端浏览器身份，没有被 CLI 身份污染', () => {
  const h = codexWebHeaders('tok', 'acct-1');
  assert.equal(h.originator, 'Codex Desktop');
  assert.ok(h['user-agent'].startsWith('Mozilla/5.0'));
  assert.equal(h.referer, 'https://chatgpt.com/');
  assert.equal(h['sec-fetch-mode'], 'no-cors');
  assert.equal(h['chatgpt-account-id'], 'acct-1');
});

test('订阅族接口在浏览器身份之上再加目标路径头', () => {
  const path = '/backend-api/subscriptions';
  const h = codexSubscriptionHeaders('tok', 'acct-1', path);
  assert.equal(h['x-openai-target-path'], path);
  assert.equal(h['x-openai-target-route'], path);
  assert.equal(h.originator, 'Codex Desktop');
});

test('账户 ID 为空时不发空的 chatgpt-account-id', () => {
  assert.equal(codexWebHeaders('tok', '')['chatgpt-account-id'], undefined);
  assert.equal(codexModelsHeaders('tok', '')['chatgpt-account-id'], undefined);
});
