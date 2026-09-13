import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogFor, clearCatalogCache, parseClaudeModels, parseCodexModels } from '../src/server/catalog.js';
import { MODEL_OPTIONS } from '../src/shared/models.js';

test('Codex 目录：按 priority 排序，隐藏内部模型', () => {
  const options = parseCodexModels({
    models: [
      { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 12 },
      { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', priority: 1 },
      // 上游留给自己的模型，不该出现在下拉框里
      { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', priority: 43 },
      { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', visibility: 'list', priority: 8 },
    ],
  });
  assert.deepEqual(
    options.map((m) => m.id),
    ['gpt-6-astra', 'gpt-5.6-luna', 'gpt-5.5'],
  );
  assert.equal(options[0].label, 'GPT-6-Astra');
});

test('Codex 目录：没有 priority 的排到最后，没有 display_name 的用 slug', () => {
  const options = parseCodexModels({
    models: [
      { slug: 'no-priority' },
      { slug: 'first', display_name: 'First', priority: 2 },
      { slug: '', display_name: '空 slug 应被丢掉', priority: 1 },
      { slug: 'not-in-api', display_name: 'X', priority: 3, supported_in_api: false },
    ],
  });
  assert.deepEqual(
    options.map((m) => m.id),
    ['first', 'no-priority'],
  );
  assert.equal(options[1].label, 'no-priority');
});

test('Claude 目录：保留上游给的顺序', () => {
  const options = parseClaudeModels({
    data: [
      { id: 'claude-opus-5', display_name: 'Claude Opus 5', type: 'model' },
      { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', type: 'model' },
    ],
  });
  assert.deepEqual(
    options.map((m) => m.id),
    ['claude-opus-5', 'claude-sonnet-5'],
  );
});

test('返回体形状不对时给空列表，而不是抛错', () => {
  assert.deepEqual(parseCodexModels({}), []);
  assert.deepEqual(parseCodexModels(null), []);
  assert.deepEqual(parseClaudeModels({ data: 'nope' }), []);
});

test('没有对应账户时退回内置清单，且不算错误', async () => {
  clearCatalogCache();
  const r = await catalogFor('codex', null);
  assert.equal(r.fromUpstream, false);
  assert.equal(r.error, '');
  assert.deepEqual(r.options, MODEL_OPTIONS.codex);
});
