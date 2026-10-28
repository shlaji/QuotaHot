import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { HttpResponse, request, type FetchOptions } from '../src/server/http.js';
import { IlinkBotClient } from '../src/server/wechat-inbox/client.js';
import { fingerprintJson, parseLosslessJson } from '../src/server/wechat-inbox/fingerprint.js';

const binding = { baseUrl: 'https://first.example.test/', botToken: 'bot-secret-sentinel' };
const empty = '{"ret":0,"msgs":[],"get_updates_buf":"next"}';

function fixture(body = empty, status = 200) {
  const calls: { url: string; options: FetchOptions }[] = [];
  const transport: typeof request = async (url, options = {}) => {
    calls.push({ url, options });
    return new HttpResponse(status, new Headers(), Readable.from([body]));
  };
  return { client: new IlinkBotClient(binding, transport), calls, transport };
}

for (const id of ['0', '9007199254740993', '18446744073709551615', '"18446744073709551615"']) {
  test(`preserves uint64 message ID token ${id}`, async () => {
    const expected = id.replaceAll('"', '');
    const { client } = fixture(`{"ret":0,"msgs":[{"message_id":${id},"from_user_id":"contact",` +
      '"to_user_id":"owner","message_type":1,"message_state":2,"context_token":"context-secret",' +
      '"item_list":[{"type":1,"text_item":{"text":"literal message_id: 123"}}]}],' +
      '"get_updates_buf":"opaque-next","longpolling_timeout_ms":47000}');
    const result = await client.getUpdates();
    assert.equal(result.kind, 'updates');
    const entry = result.msgs[0];
    assert.equal(entry?.kind, 'message');
    assert.ok(entry?.kind === 'message');
    assert.equal(entry.message.message_id, expected);
    assert.equal(entry.message.from_user_id, 'contact');
    assert.equal(entry.message.context_token, 'context-secret');
    assert.deepEqual(entry.message.item_list, [{ kind: 'item', item: { type: 1, text_item: { text: 'literal message_id: 123' } } }]);
    assert.equal(result.get_updates_buf, 'opaque-next');
    assert.equal(result.longpolling_timeout_ms, 47000);
  });
}

test('accepts optional empty response fields without inventing a new cursor', async () => {
  const { client } = fixture('{}');
  const result = await client.getUpdates('previous');
  assert.deepEqual(result, { kind: 'updates', msgs: [] });
});

for (const clientId of ['', '   ']) {
  test(`normalizes blank USER and BOT client IDs to undefined: ${JSON.stringify(clientId)}`, async () => {
    const { client } = fixture(JSON.stringify({ msgs: [
      { message_id: '1', message_type: 1, from_user_id: 'sender', client_id: clientId },
      { message_id: '2', message_type: 2, to_user_id: 'receiver', client_id: clientId },
    ] }));
    const entries = (await client.getUpdates()).msgs;
    assert.ok(entries[0]?.kind === 'message');
    assert.ok(entries[1]?.kind === 'message');
    assert.equal(entries[0].message.client_id, undefined);
    assert.equal(entries[1].message.client_id, undefined);
  });
}

test('preserves valid USER and BOT client IDs exactly and accepts an absent BOT client ID', async () => {
  const { client } = fixture('{"msgs":[{"message_id":"1","message_type":1,"from_user_id":"sender",' +
    '"client_id":"  valid-id  "},{"message_id":"2","message_type":2,"to_user_id":"receiver"}]}');
  const entries = (await client.getUpdates()).msgs;
  assert.ok(entries[0]?.kind === 'message');
  assert.ok(entries[1]?.kind === 'message');
  assert.equal(entries[0].message.client_id, '  valid-id  ');
  assert.equal(entries[1].message.client_id, undefined);
});

test('preserves opaque media and unknown item payloads for later server-only processing', async () => {
  const items = [{ type: 2, image_item: { media: { aes_key: 'cdn-secret' } } }, { type: 99, future: true }];
  const { client } = fixture(JSON.stringify({ msgs: [{ message_id: '7', message_type: 1, from_user_id: 'contact', item_list: items }] }));
  const result = await client.getUpdates();
  const entry = result.msgs[0];
  assert.ok(entry?.kind === 'message');
  assert.deepEqual(entry.message.item_list, items.map((item) => ({ kind: 'item', item })));
});

for (const invalid of ['null', '[]', '"raw-secret"',
  '{"message_id":18446744073709551615,"from_user_id":"contact","context_token":{},"raw":"raw-secret"}']) {
  test(`preserves valid/malformed/valid message order for ${invalid}`, async () => {
    const { client } = fixture(`{"msgs":[{"message_id":1,"message_type":1,"from_user_id":"first"},${invalid},` +
      '{"message_id":3,"message_type":1,"from_user_id":"last"}],"get_updates_buf":"next"}');
    const result = await client.getUpdates();
    assert.deepEqual(result.msgs.map((entry) => entry.kind), ['message', 'malformed_message', 'message']);
    const first = result.msgs[0];
    const broken = result.msgs[1];
    const last = result.msgs[2];
    assert.ok(first?.kind === 'message' && broken?.kind === 'malformed_message' && last?.kind === 'message');
    assert.equal(first.message.from_user_id, 'first');
    assert.equal(last.message.from_user_id, 'last');
    assert.equal(broken.reason, 'invalid_message');
    assert.match(broken.fingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(broken).sort(), invalid.startsWith('{')
      ? ['fingerprint', 'from_user_id', 'kind', 'message_id', 'reason'] : ['fingerprint', 'kind', 'reason']);
    assert.equal(inspect(broken).includes('raw-secret'), false);
    assert.equal(result.get_updates_buf, 'next');
  });
}

for (const id of ['-1', '18446744073709551616', '1.5', '1e3', '"01"', '"not-an-id"', 'null', 'true', '{}']) {
  test(`isolates invalid message ID ${id} without discarding a validated sender`, async () => {
    const { client } = fixture(`{"msgs":[{"message_id":${id},"message_type":1,"from_user_id":"contact","context_token":"context-secret"}]}`);
    const result = await client.getUpdates();
    const entry = result.msgs[0];
    assert.ok(entry?.kind === 'malformed_message');
    assert.deepEqual(entry, { kind: 'malformed_message', reason: 'invalid_message',
      fingerprint: entry.fingerprint, from_user_id: 'contact' });
  });
}

for (const sender of ['null', '123', '{}']) {
  test(`rejects malformed transport sender field ${sender} but preserves an independently valid uint64 ID`, async () => {
    const { client } = fixture(`{"msgs":[{"message_id":18446744073709551615,"message_type":1,"from_user_id":${sender}}]}`);
    const entry = (await client.getUpdates()).msgs[0];
    assert.ok(entry?.kind === 'malformed_message');
    assert.deepEqual(entry, { kind: 'malformed_message', reason: 'invalid_message',
      fingerprint: entry.fingerprint, message_id: '18446744073709551615' });
  });
}

for (const fields of [{}, { from_user_id: 'contact' }, { message_id: '1' },
  { message_id: '1', message_type: 1, from_user_id: 'contact', item_list: {} },
  { message_id: '1', message_type: 1, from_user_id: 'contact', message_state: 'raw-secret' }]) {
  test(`returns a safe malformed result for missing identities or invalid message fields ${JSON.stringify(fields)}`, async () => {
    const entry = (await fixture(JSON.stringify({ msgs: [fields] })).client.getUpdates()).msgs[0];
    assert.ok(entry?.kind === 'malformed_message');
    assert.equal(entry.reason, 'invalid_message');
    assert.match(entry.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(inspect(entry).includes('raw-secret'), false);
  });
}

test('recovers individual items without exposing their malformed payload or losing adjacent items', async () => {
  const items = [{ type: 1, text_item: { text: 'first' } }, null,
    { type: 'raw-secret', media: { aes_key: 'cdn-secret' } }, { type: 99, future: true }];
  const entry = (await fixture(JSON.stringify({ msgs: [{ message_id: '1', message_type: 1, from_user_id: 'contact', item_list: items }] }))
    .client.getUpdates()).msgs[0];
  assert.ok(entry?.kind === 'message');
  assert.deepEqual(entry.message.item_list?.map((item) => item.kind), ['item', 'malformed_item', 'malformed_item', 'item']);
  for (const item of entry.message.item_list ?? []) {
    if (item.kind === 'malformed_item') {
      assert.deepEqual(item, { kind: 'malformed_item', reason: 'invalid_item', fingerprint: item.fingerprint });
      assert.match(item.fingerprint, /^[a-f0-9]{64}$/);
    }
  }
  assert.equal(inspect(entry).includes('raw-secret'), false);
  assert.equal(inspect(entry).includes('cdn-secret'), false);
});

test('does not interpret unrelated nested message_id properties as message identities', async () => {
  const item = { type: 99, nested: { message_id: 'not-an-id' }, message_id: -1 };
  const entry = (await fixture(JSON.stringify({ message_id: null,
    msgs: [{ message_id: '1', message_type: 1, from_user_id: 'contact', item_list: [item] }] })).client.getUpdates()).msgs[0];
  assert.ok(entry?.kind === 'message');
  assert.deepEqual(entry.message.item_list, [{ kind: 'item', item }]);
});

test('fingerprints malformed records before numeric rounding or ID normalization', async () => {
  const entries = await Promise.all(['9007199254740992', '9007199254740993', '"9007199254740993"'].map(async (token) => {
    const result = await fixture(`{"msgs":[{"message_id":${token},"from_user_id":null}]}`).client.getUpdates();
    const entry = result.msgs[0];
    assert.ok(entry?.kind === 'malformed_message');
    return entry.fingerprint;
  }));
  assert.equal(new Set(entries).size, 3);
});

for (const fields of [
  { message_type: 1, from_user_id: ' sender ', to_user_id: 'owner' },
  { message_type: 1, from_user_id: ' sender ' },
  { message_type: 1, from_user_id: ' sender ', to_user_id: '' },
  { message_type: 2, to_user_id: ' receiver ' },
  { message_type: 2, from_user_id: '', to_user_id: ' receiver ' },
  { message_type: 2, from_user_id: 'owner', to_user_id: ' receiver ' },
]) {
  test(`preserves optional transport identities without turning them into local contacts: ${JSON.stringify(fields)}`, async () => {
    const entry = (await fixture(JSON.stringify({ msgs: [{ message_id: '18446744073709551615', ...fields }] }))
      .client.getUpdates()).msgs[0];
    assert.ok(entry?.kind === 'message');
    assert.equal(entry.message.message_id, '18446744073709551615');
    assert.equal(entry.message.message_type, fields.message_type);
    assert.equal(entry.message.direction, fields.message_type === 1 ? 'inbound' : 'outbound');
    assert.equal(entry.message.from_user_id, fields.from_user_id);
    assert.equal(entry.message.to_user_id, fields.to_user_id);
  });
}

for (const message_type of [undefined, null, 0, 3, -1, 1.5, '1', '2', true, {}]) {
  test(`isolates invalid direction ${JSON.stringify(message_type)} with independently validated IDs`, async () => {
    const original = { message_id: '9', message_type, from_user_id: 'sender', to_user_id: 'receiver', raw: 'raw-secret' };
    const entry = (await fixture(JSON.stringify({ msgs: [original] })).client.getUpdates()).msgs[0];
    assert.deepEqual(entry, { kind: 'malformed_message', reason: 'invalid_message',
      fingerprint: fingerprintJson(parseLosslessJson(JSON.stringify(original))),
      message_id: '9', from_user_id: 'sender', to_user_id: 'receiver' });
  });
}

for (const message_type of [1, 2]) {
  for (const identity of [undefined, '', '   ']) {
    test(`accepts direction ${message_type} when no selectable peer identity is present (${JSON.stringify(identity)})`, async () => {
      const original = { message_id: '9', message_type,
        from_user_id: message_type === 1 ? identity : 'owner',
        to_user_id: message_type === 2 ? identity : 'owner', context_token: 'context-secret' };
      const entry = (await fixture(JSON.stringify({ msgs: [original] })).client.getUpdates()).msgs[0];
      assert.ok(entry?.kind === 'message');
      assert.equal(entry.message.direction, message_type === 1 ? 'inbound' : 'outbound');
      assert.equal(entry.message.from_user_id, message_type === 1 ? identity : 'owner');
      assert.equal(entry.message.to_user_id, message_type === 2 ? identity : 'owner');
    });
  }
  for (const identity of [null, 123, {}]) {
    test(`rejects malformed optional direction ${message_type} transport identity ${JSON.stringify(identity)}`, async () => {
      const original = { message_id: '9', message_type,
        from_user_id: message_type === 1 ? identity : 'owner',
        to_user_id: message_type === 2 ? identity : 'owner' };
      const entry = (await fixture(JSON.stringify({ msgs: [original] })).client.getUpdates()).msgs[0];
      assert.ok(entry?.kind === 'malformed_message');
      assert.equal(entry.reason, 'invalid_message');
    });
  }
  for (const fields of [{ client_id: {} }, { context_token: null }, { message_state: 'raw-secret' },
    { create_time_ms: 1.5 }, { update_time_ms: 'raw-secret' }, { item_list: {} },
    ...(message_type === 1 ? [{ to_user_id: {} }] : [{ from_user_id: {} }])]) {
    test(`isolates malformed optional fields for direction ${message_type}: ${JSON.stringify(fields)}`, async () => {
      const original = { message_id: '9', message_type, from_user_id: 'sender', to_user_id: 'receiver',
        raw: 'raw-secret', ...fields };
      const entry = (await fixture(JSON.stringify({ msgs: [original] })).client.getUpdates()).msgs[0];
      assert.deepEqual(entry, { kind: 'malformed_message', reason: 'invalid_message',
        fingerprint: fingerprintJson(parseLosslessJson(JSON.stringify(original))), message_id: '9',
        ...(typeof original.from_user_id === 'string' ? { from_user_id: original.from_user_id } : {}),
        ...(typeof original.to_user_id === 'string' ? { to_user_id: original.to_user_id } : {}) });
    });
  }
}
