import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opencodePlugin, selfCommand } from '../src/install.js';

test('自命令将相对入口转成绝对路径', () => {
  const original = process.argv[1];
  process.argv[1] = './dist/quotahot-hook';
  try { assert.ok(selfCommand().includes(join(process.cwd(), 'dist/quotahot-hook'))); }
  finally { process.argv[1] = original; }
});

test('含空格的插件执行路径不会拆坏', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'quotahot path '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'fake hook');
  await writeFile(binary, '#!/bin/sh\ncat >/dev/null\nprintf \'{"switched":true,"message":"ok"}\'\n', { mode: 0o700 });
  const plugin = join(dir, 'plugin.mjs');
  await writeFile(plugin, opencodePlugin(binary));
  const driver = join(dir, 'driver.mjs');
  await writeFile(driver, `import {QuotaHot} from './plugin.mjs';
const plugin = await QuotaHot({client:{tui:{showToast:({body})=>console.log(body.message)}}});
await plugin.event({event:{type:'message.updated',properties:{info:{id:'m',sessionID:'s',role:'assistant',providerID:'openai',time:{created:1}}}}});
await plugin.event({event:{type:'session.error',properties:{sessionID:'s',error:{status:429}}}});`);
  const output = execFileSync(process.execPath, [driver], { cwd: tmpdir(), timeout: 10000, encoding: 'utf8' });
  assert.match(output, /QuotaHot: ok/);
});
