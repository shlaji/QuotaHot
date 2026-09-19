import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAccountOrder, moveAccountId } from '../src/shared/account-order.js';
import { normalize } from '../src/server/config.js';

const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

test('places visible accounts in saved order and appends new accounts', () => {
  assert.deepEqual(mergeAccountOrder(items, ['c', 'a']), [items[2], items[0], items[1]]);
});

test('ignores deleted and duplicate saved ids', () => {
  assert.deepEqual(mergeAccountOrder(items, ['missing', 'b', 'b', 'a']), [items[1], items[0], items[2]]);
});

test('keeps server order when saved order is empty', () => {
  assert.deepEqual(mergeAccountOrder(items, []), items);
});

test('moves an item to a bounded target index', () => {
  assert.deepEqual(moveAccountId(['a', 'b', 'c'], 'a', 2), ['b', 'c', 'a']);
  assert.deepEqual(moveAccountId(['a', 'b', 'c'], 'c', -1), ['c', 'a', 'b']);
});

test('normalizes account order ids and defaults missing order to empty', () => {
  assert.deepEqual(normalize({ accountOrder: { codex: [' c ', '', 42], claude: 'bad' } }).accountOrder, {
    codex: ['c', '42'],
  });
  assert.deepEqual(normalize({}).accountOrder, {});
});
