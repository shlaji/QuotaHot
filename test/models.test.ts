import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_OPTIONS, isKnownModel } from '../src/shared/models.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ACCOUNTS_DIR,
  CLI_PROXY_API_DIR,
  DATA_DIR,
  DEFAULT_CONFIG,
  normalize,
} from '../src/server/config.js';

test('默认模型必须在可选清单里，否则界面下拉会渲染成空白', () => {
  assert.equal(isKnownModel('claude', DEFAULT_CONFIG.models.claude), true);
  assert.equal(isKnownModel('codex', DEFAULT_CONFIG.models.codex), true);
});

test('固定路径：账户目录在主目录下，导入来源指向 cli-proxy-api', () => {
  // QUOTAHOT_DATA_DIR 优先级更高，设了它就没有“默认位置”可断言
  if (!process.env.QUOTAHOT_DATA_DIR) {
    // 数据目录不能跟着工作目录走，否则从不同路径启动会读到不同的账户
    assert.equal(DATA_DIR, join(homedir(), '.quotahot'));
  }
  assert.ok(ACCOUNTS_DIR.startsWith(DATA_DIR));
  assert.notEqual(
    CLI_PROXY_API_DIR,
    ACCOUNTS_DIR,
    '导入来源指向账户目录会把自己的凭证当成外部凭证再扫一遍',
  );
  assert.equal(DEFAULT_CONFIG.dailyEnd, '23:00');
  assert.equal(DEFAULT_CONFIG.models.codex, 'gpt-5.6-luna');
  assert.equal(DEFAULT_CONFIG.proxy, 'http://127.0.0.1:7897');
  assert.deepEqual(DEFAULT_CONFIG.noProxy, [
    'localhost',
    '127.0.0.1',
    '::1',
    '10.10.0.79',
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '169.254.0.0/16',
    '100.64.0.0/10',
  ]);
});

test('模型清单没有重复 ID，且不带日期后缀', () => {
  for (const provider of ['claude', 'codex'] as const) {
    const ids = MODEL_OPTIONS[provider].map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, `${provider} 存在重复 ID`);
    for (const id of ids) {
      assert.ok(id.trim() === id && id.length > 0, `${id} 不该有首尾空格`);
      assert.doesNotMatch(id, /-\d{8}$/, `${id} 不该带日期后缀`);
    }
  }
});

test('自定义模型 ID 能存下来，清单只是建议而非白名单', () => {
  const cfg = normalize({ models: { claude: 'claude-something-new', codex: 'gpt-9' } });
  assert.equal(cfg.models.claude, 'claude-something-new');
  assert.equal(cfg.models.codex, 'gpt-9');
  assert.equal(isKnownModel('claude', cfg.models.claude), false, '前提：它确实不在清单里');

  // 空值应回落到默认，不能把空字符串发给上游
  const blank = normalize({ models: { claude: '   ', codex: '' } });
  assert.equal(blank.models.claude, DEFAULT_CONFIG.models.claude);
  assert.equal(blank.models.codex, DEFAULT_CONFIG.models.codex);
});
