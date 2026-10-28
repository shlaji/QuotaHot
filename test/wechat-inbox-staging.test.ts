import assert from 'node:assert/strict';
import { chmod, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { inspect } from 'node:util';
import { HttpResponse } from '../src/server/http.js';
import { downloadMedia, encryptMedia, IlinkMediaError } from '../src/server/wechat-inbox/media.js';
import { InboxMediaStaging, InboxStagingError } from '../src/server/wechat-inbox/media-staging.js';

async function setup(t: TestContext) {
  const parent = await mkdtemp(join(tmpdir(), 'inbox-staging-test-'));
  const staging = new InboxMediaStaging(parent);
  t.after(async () => { await staging.dispose(); await rm(parent, { recursive: true, force: true }); });
  return { parent, staging };
}
async function* chunks(...parts: readonly Uint8Array[]) { yield* parts; }
function safeError(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof InboxStagingError);
    assert.equal(error.code, code);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(`${inspect(error)} ${JSON.stringify(error)}`, /secret|https:\/\/|signature=/);
    return true;
  };
}

test('creates nothing when disposed without staging and rejects reuse', async (t) => {
  const { parent, staging } = await setup(t);
  await staging.dispose();
  await staging.dispose();
  assert.deepEqual(await readdir(parent), []);
  await assert.rejects(staging.stage(chunks()), safeError('disposed'));
});

test('stages an empty stream using the default OS temp parent', async (t) => {
  const staging = new InboxMediaStaging();
  t.after(() => staging.dispose());
  const path = await staging.stage(chunks());
  assert.equal(dirname(dirname(path)), tmpdir());
  assert.equal((await stat(path)).size, 0);
});

test('keeps exact chunky bytes and publishes only after source completion', async (t) => {
  const { staging } = await setup(t);
  const parts = [Buffer.from('prefix'), Buffer.alloc(200003, 37), Buffer.alloc(0), Buffer.from('suffix')];
  let completed = false;
  const source = (async function* () { yield* parts; completed = true; })();
  const path = await staging.stage(source);
  assert.equal(completed, true);
  assert.deepEqual(await readFile(path), Buffer.concat(parts));
});

test('enforces private Unix modes without chmodding the parent', { skip: process.platform === 'win32' }, async (t) => {
  const { parent, staging } = await setup(t);
  await chmod(parent, 0o755);
  const path = await staging.stage(chunks(Buffer.from('plaintext')));
  assert.equal((await stat(parent)).mode & 0o777, 0o755);
  assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('handles short writes with bounded requests and source backpressure', async (t) => {
  const { parent } = await setup(t);
  let written = 0;
  const staging = new InboxMediaStaging(parent, async (path, flag, mode) => {
    assert.equal(flag, 'wx');
    assert.equal(mode, 0o600);
    const file = await open(path, flag, mode);
    return {
      async write(bytes) {
        assert.ok(bytes.length <= 65536);
        const result = await file.write(bytes.subarray(0, 7001));
        written += result.bytesWritten;
        return result;
      },
      close: () => file.close(),
    };
  });
  t.after(() => staging.dispose());
  const source = (async function* () {
    yield Buffer.alloc(200003, 19);
    assert.equal(written, 200003);
    yield Buffer.from('tail');
  })();
  const path = await staging.stage(source);
  assert.deepEqual(await readFile(path), Buffer.concat([Buffer.alloc(200003, 19), Buffer.from('tail')]));
});

test('removes partial plaintext and preserves the exact source error', async (t) => {
  const { parent, staging } = await setup(t);
  const original = new IlinkMediaError('decrypt_failed');
  const source = (async function* () { yield Buffer.from('secret-plaintext'); throw original; })();
  await assert.rejects(staging.stage(source), (error: unknown) => error === original);
  const entries = await readdir(parent);
  assert.equal(entries.length, 1);
  for (const entry of entries) assert.deepEqual(await readdir(join(parent, entry)), []);
});

for (const failure of ['throw', 'zero'] as const) {
  test(`cleans partial files and sanitizes filesystem write failure: ${failure}`, async (t) => {
    const { parent } = await setup(t);
    const staging = new InboxMediaStaging(parent, async (path, flag, mode) => {
      const file = await open(path, flag, mode);
      return {
        async write(bytes) {
          await file.write(bytes.subarray(0, 1));
          if (failure === 'zero') return { bytesWritten: 0 };
          throw new Error(`${path} secret-plaintext https://cdn.test/?signature=secret-key`);
        },
        close: () => file.close(),
      };
    });
    t.after(() => staging.dispose());
    await assert.rejects(staging.stage(chunks(Buffer.alloc(50))), safeError('write_failed'));
    for (const entry of await readdir(parent)) assert.deepEqual(await readdir(join(parent, entry)), []);
  });
}

test('sanitizes directory creation failures', async (t) => {
  const { parent } = await setup(t);
  const staging = new InboxMediaStaging(join(parent, 'secret-missing'));
  t.after(() => staging.dispose());
  await assert.rejects(staging.stage(chunks()), safeError('write_failed'));
});

test('honors pre-aborted signals without consuming the source or creating files', async (t) => {
  const { parent, staging } = await setup(t);
  const source = (async function* () { assert.fail('source must not run'); })();
  await assert.rejects(staging.stage(source, AbortSignal.abort('secret-reason')), safeError('aborted'));
  assert.deepEqual(await readdir(parent), []);
});

test('cancels while awaiting source data and requests iterator cleanup', async (t) => {
  const { parent, staging } = await setup(t);
  const controller = new AbortController();
  const waiting = Promise.withResolvers<void>();
  let returned = false;
  let calls = 0;
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (calls++ === 0) return Promise.resolve({ done: false, value: Buffer.from('secret-partial') });
          waiting.resolve();
          return new Promise<IteratorResult<Uint8Array>>(() => {});
        },
        async return() { returned = true; return { done: true, value: undefined }; },
      };
    },
  };
  const pending = staging.stage(source, controller.signal);
  await waiting.promise;
  controller.abort(new Error('secret-reason'));
  await assert.rejects(pending, safeError('aborted'));
  assert.equal(returned, true);
  for (const entry of await readdir(parent)) assert.deepEqual(await readdir(join(parent, entry)), []);
});

test('classifies cancellation at EOF instead of returning a path', async (t) => {
  const { staging } = await setup(t);
  const controller = new AbortController();
  const source = (async function* () { yield Buffer.from('partial'); controller.abort('secret-reason'); })();
  await assert.rejects(staging.stage(source, controller.signal), safeError('aborted'));
});

test('isolates parallel instances and removes only its own batch directory', async (t) => {
  const { parent, staging } = await setup(t);
  const other = new InboxMediaStaging(parent);
  t.after(() => other.dispose());
  await writeFile(join(parent, 'unrelated'), 'keep');
  const [first, second, third] = await Promise.all([
    staging.stage(chunks(Buffer.from('one'))), other.stage(chunks(Buffer.from('two'))), staging.stage(chunks()),
  ]);
  assert.notEqual(dirname(first), dirname(second));
  assert.equal(dirname(first), dirname(third));
  assert.notEqual(first, third);
  await staging.dispose();
  await staging.dispose();
  assert.deepEqual((await readdir(parent)).sort(), [basename(dirname(second)), 'unrelated'].sort());
  assert.equal(await readFile(second, 'utf8'), 'two');
});

test('streams a large attachment without imposing a total size cap', async (t) => {
  const { staging } = await setup(t);
  const source = (async function* () { for (let index = 0; index < 1025; index++) yield Buffer.alloc(65536, index % 256); })();
  const path = await staging.stage(source);
  assert.equal((await stat(path)).size, 1025 * 65536);
});

test('disposes an in-flight batch and removes completed as well as partial files', async (t) => {
  const { parent, staging } = await setup(t);
  await staging.stage(chunks(Buffer.from('completed')));
  const waiting = Promise.withResolvers<void>();
  const source = (async function* () {
    yield Buffer.from('partial');
    waiting.resolve();
    await new Promise<void>(() => {});
  })();
  const pending = staging.stage(source);
  const rejected = assert.rejects(pending, safeError('aborted'));
  await waiting.promise;
  await staging.dispose();
  await rejected;
  assert.deepEqual(await readdir(parent), []);
});

test('stops between bounded writes when cancellation arrives during a large input chunk', async (t) => {
  const { parent } = await setup(t);
  const controller = new AbortController();
  let writes = 0;
  const staging = new InboxMediaStaging(parent, async (path, flag, mode) => {
    const file = await open(path, flag, mode);
    return {
      async write(bytes) {
        const result = await file.write(bytes);
        writes++;
        controller.abort('secret-reason');
        return result;
      },
      close: () => file.close(),
    };
  });
  t.after(() => staging.dispose());
  await assert.rejects(staging.stage(chunks(Buffer.alloc(200000)), controller.signal), safeError('aborted'));
  assert.equal(writes, 1);
  for (const entry of await readdir(parent)) assert.deepEqual(await readdir(join(parent, entry)), []);
});

test('rejects real decryption finalization failure without retaining plaintext', async (t) => {
  const { parent, staging } = await setup(t);
  const key = Buffer.alloc(16, 7);
  const encrypted = encryptMedia(Buffer.alloc(131075, 42), key).subarray(0, 131073);
  const body = Readable.from([encrypted]);
  const source = downloadMedia({ url: 'https://cdn.test/?signature=secret', key },
    async () => new HttpResponse(200, new Headers(), body));
  await assert.rejects(staging.stage(source), (error: unknown) => error instanceof IlinkMediaError && error.code === 'decrypt_failed');
  assert.equal(body.destroyed, true);
  await staging.dispose();
  assert.deepEqual(await readdir(parent), []);
});
