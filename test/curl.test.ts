import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCurl,
  buildShell,
  commandLine,
  fillSecrets,
  isCliRecord,
  maskSecrets,
  maskText,
  REFRESH_PLACEHOLDER,
  TOKEN_PLACEHOLDER,
} from '../src/shared/curl.js';

const ACCESS = 'sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAA';
const REFRESH = 'sk-ant-ort01-BBBBBBBBBBBBBBBBBBBBBBBB';

test('gateway masking uses its own placeholder in every request field and response text', () => {
  const secrets = { accessToken: ACCESS, accessTokenPlaceholder: '$QUOTAHOT_GATEWAY_TOKEN' as const };
  const request = { method: 'POST', url: `https://example.test/${ACCESS}`, headers: { authorization: ACCESS }, body: ACCESS };
  const masked = maskSecrets(request, secrets);
  assert.deepEqual(masked, {
    method: 'POST', url: 'https://example.test/$QUOTAHOT_GATEWAY_TOKEN',
    headers: { authorization: '$QUOTAHOT_GATEWAY_TOKEN' }, body: '$QUOTAHOT_GATEWAY_TOKEN',
  });
  assert.equal(maskText(ACCESS, secrets), '$QUOTAHOT_GATEWAY_TOKEN');
  assert.deepEqual(fillSecrets(masked, secrets), request);
});

test('missing gateway PAT leaves its placeholder untouched despite an available OAuth token', () => {
  const request = { method: 'GET', url: 'https://example.test', headers: { authorization: '$QUOTAHOT_GATEWAY_TOKEN' }, body: '' };
  const restored = fillSecrets(request, { accessToken: ACCESS });
  assert.deepEqual(restored, request);
});

test('落库前令牌换成占位符，其余头原样保留', () => {
  const masked = maskSecrets(
    {
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        authorization: `Bearer ${ACCESS}`,
        'content-type': 'application/json',
        'chatgpt-account-id': 'acct-123',
      },
      body: '{"model":"claude-sonnet-5"}',
    },
    { accessToken: ACCESS },
  );
  assert.equal(masked.headers.authorization, `Bearer ${TOKEN_PLACEHOLDER}`);
  assert.equal(masked.headers['content-type'], 'application/json');
  assert.equal(
    masked.headers['chatgpt-account-id'],
    'acct-123',
    '账户标识不是密钥，要留着才跑得通',
  );
});

test('令牌出现在请求体里也一样抹掉', () => {
  // 刷新请求把 refresh_token 放在正文，只盯 authorization 头会把它原样写进库
  const masked = maskSecrets(
    {
      method: 'POST',
      url: 'https://console.anthropic.com/v1/oauth/token',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: REFRESH }),
    },
    { accessToken: ACCESS, refreshToken: REFRESH },
  );
  assert.doesNotMatch(masked.body, /BBBB/);
  assert.match(masked.body, /\$QUOTAHOT_REFRESH_TOKEN/);
});

test('读取时填回当前令牌，curl 拿去就能跑', () => {
  const stored = maskSecrets(
    {
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages',
      headers: { authorization: `Bearer ${ACCESS}`, 'content-type': 'application/json' },
      body: '{"model":"claude-sonnet-5"}',
    },
    { accessToken: ACCESS },
  );
  const fresh = 'sk-ant-oat01-CCCCCCCCCCCCCCCCCCCCCCCC';
  const curl = buildCurl(fillSecrets(stored, { accessToken: fresh }));

  // 关键是“新”而不是“发送当时那个”：令牌每小时都会轮换
  assert.match(curl, new RegExp(`-H 'authorization: Bearer ${fresh}'`));
  assert.doesNotMatch(curl, /AAAA/);
  assert.doesNotMatch(curl, /QUOTAHOT_TOKEN/, '填过之后不该再留占位符');
  assert.match(curl, /-H 'content-type: application\/json'/);
});

test('拿不到令牌时保留占位符，不写出空的 Bearer', () => {
  const stored = maskSecrets(
    {
      method: 'GET',
      url: 'https://api.anthropic.com/api/oauth/usage',
      headers: { authorization: `Bearer ${ACCESS}` },
      body: '',
    },
    { accessToken: ACCESS },
  );
  assert.deepEqual(fillSecrets(stored, { accessToken: '' }), stored);
});

test('短字符串不参与替换，否则正文会被打得面目全非', () => {
  const req = {
    method: 'POST',
    url: 'https://example.com/x',
    headers: { 'x-app': 'cli' },
    body: '{"entrypoint":"cli"}',
  };
  // 'cli' 远短于门槛，不该被当成凭证到处替换
  assert.deepEqual(maskSecrets(req, { accessToken: 'cli' }), req);
});

test('查询串里的令牌同样会被抹掉', () => {
  const masked = maskSecrets(
    { method: 'GET', url: `https://example.com/x?token=${ACCESS}`, headers: {}, body: '' },
    { accessToken: ACCESS },
  );
  assert.equal(masked.url, `https://example.com/x?token=${TOKEN_PLACEHOLDER}`);
});

test('请求体里的单引号被正确转义，粘进 shell 不会断开', () => {
  const curl = buildCurl({
    method: 'POST',
    url: 'https://example.com/x',
    headers: {},
    body: `{"text":"it's fine"}`,
  });
  assert.match(curl, /--data-raw '\{"text":"it'\\''s fine"\}'/);
});

test('没有请求体时不写 --data-raw', () => {
  const curl = buildCurl({ method: 'GET', url: 'https://example.com/x', headers: {}, body: '' });
  assert.doesNotMatch(curl, /--data-raw/);
  assert.equal(curl, `curl -X GET 'https://example.com/x'`);
});

test('两个占位符互不干扰', () => {
  assert.notEqual(TOKEN_PLACEHOLDER, REFRESH_PLACEHOLDER);
});

/* ── 本机 CLI 那条路 ───────────────────────────────────────────────────── */

const CLI_RUN = {
  method: 'EXEC',
  url: 'cli://claude',
  headers: { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: ACCESS },
  body: `claude --print --output-format json -- 'ping'`,
};

test('地址前缀认出这是本机执行而不是一次请求', () => {
  assert.equal(isCliRecord(CLI_RUN), true);
  assert.equal(isCliRecord({ url: 'https://api.anthropic.com/v1/messages' }), false);
});

test('命令行只在必要处加引号', () => {
  assert.equal(
    commandLine('claude', ['--print', '--model', 'claude-sonnet-5', '--', "it's fine"]),
    `claude --print --model claude-sonnet-5 -- 'it'\\''s fine'`,
  );
  // 空参数不能被吞掉，否则复制出来的命令与实际跑的那条不是一回事
  assert.equal(commandLine('/opt/my cli/claude', ['']), `'/opt/my cli/claude' ''`);
});

test('复现出来的是 env -i 打头的命令，环境照发送时那份重建', () => {
  const shell = buildShell(CLI_RUN);
  assert.match(shell, /^env -i \\\n {2}PATH='\/usr\/bin'/);
  assert.ok(shell.includes(`CLAUDE_CODE_OAUTH_TOKEN='${ACCESS}'`));
  assert.ok(shell.trimEnd().endsWith(CLI_RUN.body));
});

test('CLI 日志同样按值抹令牌，复制时再换回当前那份', () => {
  const masked = maskSecrets(CLI_RUN, { accessToken: ACCESS });
  assert.equal(masked.headers.CLAUDE_CODE_OAUTH_TOKEN, TOKEN_PLACEHOLDER);
  assert.doesNotMatch(buildShell(masked), new RegExp(ACCESS));

  const filled = fillSecrets(masked, { accessToken: 'sk-ant-oat01-CCCCCCCCCCCCCCCCCCCC' });
  assert.ok(buildShell(filled).includes(`CLAUDE_CODE_OAUTH_TOKEN='sk-ant-oat01-CCCCCCCCCCCCCCCCCCCC'`));
});
