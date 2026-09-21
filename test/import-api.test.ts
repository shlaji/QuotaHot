import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const secret = 'upload-secret-never-in-response';
const token = (email: string, accessToken = secret) => JSON.stringify({ type: 'codex', email, access_token: accessToken });
const upload = (files: readonly File[]) => {
  const form = new FormData();
  for (const file of files) form.append('files', file);
  return form;
};

test('token-file API through the live server', { timeout: 30_000 }, async (context) => {
  const dir = await mkdtemp(join(tmpdir(), 'quotahot-import-api-'));
  await writeFile(join(dir, 'config.json'), JSON.stringify({ usageRefreshMinutes: 0, clientCheckMinutes: 0 }));
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { appendFile } from 'node:fs/promises';
    const original = File.prototype.text;
    File.prototype.text = async function () {
      await appendFile(process.env.QUOTAHOT_DATA_DIR + '/reads', this.name + '\\n');
      if (this.name === 'unreadable.json') throw new Error('${secret}');
      return original.call(this);
    };
    await import(${JSON.stringify(new URL('../src/main.ts', import.meta.url).href)});
  `], {
    env: { ...process.env, HOME: dir, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir, CODEX_HOME: join(dir, 'codex'),
      QUOTAHOT_DATA_DIR: dir, QUOTAHOT_HOST: '127.0.0.1', QUOTAHOT_AUTH_USERNAME: '', QUOTAHOT_AUTH_PASSWORD: '', PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  context.after(async () => {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
    await rm(dir, { recursive: true, force: true });
  });
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server startup timeout')), 10_000);
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      const address = /QuotaHot 已启动: (http:\/\/\S+)/.exec(output)?.[1];
      if (address) { clearTimeout(timer); resolve(address); }
    });
    child.once('error', reject);
  });
  const post = (body: BodyInit) => fetch(`${base}/api/accounts/import-files`, { method: 'POST', body });

  await context.test('imports repeated native files in order and publishes the account state', async () => {
    const controller = new AbortController();
    const stream = await fetch(`${base}/api/events`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
    assert.ok(stream.body);
    const reader = stream.body.getReader();
    try {
      const response = await post(upload([
        new File([token('first@example.com')], 'first.JSON'),
        new File([token('second@example.com')], 'second.json'),
      ]));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { imported: ['codex:first@example.com', 'codex:second@example.com'], skipped: [] });
      let events = '';
      while (!events.includes('second@example.com')) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        events += new TextDecoder().decode(chunk.value);
      }
      assert.match(events, /"type":"accounts"/);
      assert.equal(events.includes(secret), false);
    } finally { controller.abort(); reader.releaseLock(); }
  });

  await context.test('continues after invalid JSON and unreadable files without exposing secrets', async () => {
    const response = await post(upload([
      new File([secret], 'broken.json'), new File([secret], 'unreadable.json'),
      new File([token('mixed@example.com')], 'mixed.json'),
    ]));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      imported: ['codex:mixed@example.com'], skipped: [
        { id: 'unreadable.json', reason: '读取文件失败' }, { id: 'broken.json', reason: 'JSON 格式无效' },
      ],
    });
  });

  await context.test('skips invalid extensions, oversize files and files after the twentieth without reading them', async () => {
    const files = [new File([secret], 'invalid.txt'), new File(['x'.repeat(1048577)], 'large.json'),
      ...Array.from({ length: 19 }, (_, index) => new File([token(`limit${index}@example.com`)], `limit${index}.json`))];
    const response = await post(upload(files));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      imported: Array.from({ length: 18 }, (_, index) => `codex:limit${index}@example.com`),
      skipped: [{ id: 'invalid.txt', reason: '仅支持 JSON 文件' }, { id: 'large.json', reason: '文件超过 1 MiB' },
        { id: 'limit18.json', reason: '每次最多导入 20 个文件' }],
    });
    const reads = (await readFile(join(dir, 'reads'), 'utf8')).split('\n');
    for (const name of ['invalid.txt', 'large.json', 'limit18.json']) assert.equal(reads.includes(name), false);
  });

  await context.test('accepts exactly 1 MiB and returns 200 for an all-skipped upload', async () => {
    const json = token('boundary@example.com');
    const response = await post(upload([new File([json.padEnd(1048576)], 'boundary.json')]));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { imported: ['codex:boundary@example.com'], skipped: [] });
    const skipped = await post(upload([new File([secret], 'token.txt')]));
    assert.equal(skipped.status, 200);
    assert.deepEqual(await skipped.json(), { imported: [], skipped: [{ id: 'token.txt', reason: '仅支持 JSON 文件' }] });
  });

  await context.test('overwrites an existing account but keeps the first duplicate in a request', async () => {
    const response = await post(upload([
      new File([token('first@example.com', 'replacement-secret')], 'replace.json'),
      new File([token('first@example.com', 'ignored-secret')], 'duplicate.json'),
    ]));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { imported: ['codex:first@example.com'],
      skipped: [{ id: 'codex:first@example.com', reason: '本次请求已导入该账户' }] });
    const stored = JSON.parse(await readFile(join(dir, 'accounts', 'codex-first@example.com.json'), 'utf8'));
    assert.equal(stored.access_token, 'replacement-secret');
  });

  await context.test('rejects missing files and non-multipart bodies with fixed errors', async () => {
    const textField = new FormData();
    textField.append('files', secret);
    for (const body of [new FormData(), textField, secret]) {
      const response = await post(body);
      assert.equal(response.status, 400);
      assert.equal((await response.text()).includes(secret), false);
    }
  });

  await context.test('rejects malformed multipart without exposing parser errors', async () => {
    const request = new Request(`${base}/api/accounts/import-files`, { method: 'POST', body: upload([new File([secret], 'broken.json')]) });
    const response = await fetch(request.url, { method: 'POST', headers: request.headers, body: secret });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: '无法解析上传文件' });
  });

  await context.test('preserves local source import behavior', async () => {
    const response = await fetch(`${base}/api/accounts/import`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sources: [] }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { imported: [], skipped: [] });
  });
});
