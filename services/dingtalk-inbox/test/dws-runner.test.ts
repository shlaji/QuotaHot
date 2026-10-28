import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { DwsRunner, DwsProcessError } from '../src/dws/runner.js';
import type { DwsSpawn, JsonValue } from '../src/dws/runner.js';

const config = { binary: '/service/bin/dws', profile: 'service-profile', configDir: '/service/private/dws' };
const marker = '[event] ready event_key=example bus_pid=123 subscribe_id=sub-1\n';

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];
  kill(signal: NodeJS.Signals = 'SIGTERM') { this.signals.push(signal); return true; }
  close(code = 0, signal: NodeJS.Signals | null = null) {
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, signal);
  }
}

test('captures JSON with explicit binary/profile/config and literal argv without inherited credentials', async () => {
  const child = new FakeChild();
  const execute: DwsSpawn = (binary, args, options) => {
    assert.equal(binary, config.binary);
    assert.deepEqual(args, ['--profile', config.profile, 'example', '--query', 'a; $(bad)']);
    assert.equal(options.shell, false);
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
    assert.equal(options.env.DWS_CONFIG_DIR, config.configDir);
    assert.deepEqual(Object.keys(options.env).sort(), ['DWS_CONFIG_DIR', 'HOME', 'LANG', 'PATH', 'TMPDIR'].filter(key => key === 'DWS_CONFIG_DIR' || process.env[key] !== undefined).sort());
    return child;
  };
  const result = new DwsRunner(config, execute).runJson(['example', '--query', 'a; $(bad)']);
  child.stderr.write('Error: token=credential-canary body=private-message\n');
  child.stdout.write('{"ok":');
  child.stdout.write('true}\n');
  child.close();
  assert.deepEqual(await result, { ok: true });
});

test('becomes ready only for an exact matching stderr marker and parses chunked UTF-8 NDJSON', async () => {
  const child = new FakeChild();
  const events: JsonValue[] = [];
  const consumer = new DwsRunner(config, () => child).consume(['example'], 'example', event => { events.push(event); });
  let ready = false;
  void consumer.ready.then(value => { ready = value !== null; });
  child.stderr.write(marker.replace('example', 'other'));
  child.stderr.write(`prefix ${marker}`);
  child.stdout.write(JSON.stringify({ marker: marker.trim() }) + '\n');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(ready, false);
  child.stderr.write(marker.slice(0, 20));
  child.stderr.write(marker.slice(20));
  assert.deepEqual(await consumer.ready, { eventKey: 'example', busPid: 123, subscriptionId: 'sub-1' });
  const bytes = Buffer.from('{"text":"你好"}\r\n{"count":2}\n');
  for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
  child.close();
  await consumer.exited;
  assert.deepEqual(events, [{ marker: marker.trim() }, { text: '你好' }, { count: 2 }]);
});

test('returns early failure without readiness and retains only sanitized diagnostics', async () => {
  const child = new FakeChild();
  const consumer = new DwsRunner(config, () => child).consume(['example'], 'example', () => {});
  child.stderr.write('Error: permission denied token=credential-canary body=private-message\n');
  child.close(7);
  assert.equal(await consumer.ready, null);
  const exit = await consumer.exited;
  assert.equal(exit.code, 7);
  assert.equal(exit.remoteCleanup, 'unknown');
  assert.equal(exit.diagnostics.errorLines, 1);
  assert.doesNotMatch(JSON.stringify(exit), /credential-canary|private-message|permission denied/);
});

test('rejects malformed JSON without exposing stdout or parser snippets', async () => {
  const child = new FakeChild();
  const result = new DwsRunner(config, () => child).runJson(['example']);
  child.stdout.write('credential-canary private-message');
  child.close();
  await assert.rejects(result, error => error instanceof DwsProcessError && error.kind === 'invalid_json' && !/credential-canary|private-message/.test(JSON.stringify(error) + error.message));
});

test('rejects nonzero JSON command exit without interpreting its output as success', async () => {
  const child = new FakeChild();
  const result = new DwsRunner(config, () => child).runJson(['example']);
  child.stdout.write('{"ok":true}');
  child.close(3);
  await assert.rejects(result, error => error instanceof DwsProcessError && error.kind === 'process_exit' && error.exit?.code === 3);
});

test('reports malformed NDJSON and terminates gracefully without leaking the line', async () => {
  const child = new FakeChild();
  const consumer = new DwsRunner(config, () => child).consume(['example'], 'example', () => {});
  child.stdout.write('credential-canary\n');
  child.close();
  const exit = await consumer.exited;
  assert.equal(exit.failure, 'invalid_json');
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.doesNotMatch(JSON.stringify(exit), /credential-canary/);
});

test('sanitizes spawn errors while preserving a known OS error code', async () => {
  const child = new FakeChild();
  const result = new DwsRunner(config, () => child).runJson(['example']);
  child.emit('error', Object.assign(new Error('credential-canary'), { code: 'ENOENT' }));
  child.close(-2);
  await assert.rejects(result, error => error instanceof DwsProcessError && error.exit?.diagnostics.osCode === 'ENOENT' && !error.message.includes('credential-canary'));
});

test('rejects credential and profile overrides before spawning', async () => {
  let calls = 0;
  const runner = new DwsRunner(config, () => { calls++; return new FakeChild(); });
  for (const flag of ['--token=credential-canary', '--token', '--profile=other', '--profile', '--quiet', '-q', '--yes']) {
    await assert.rejects(runner.runJson(['example', flag]), error => error instanceof DwsProcessError && error.kind === 'arguments' && !error.message.includes('credential-canary'));
  }
  assert.equal(calls, 0);
});

test('keeps readiness absent when a clean local exit occurs before a marker', async () => {
  const child = new FakeChild();
  const consumer = new DwsRunner(config, () => child).consume(['example'], 'example', () => {});
  child.close();
  assert.equal(await consumer.ready, null);
  assert.equal((await consumer.exited).ready, null);
});

test('retains signal interruption and the final unterminated NDJSON record', async () => {
  const child = new FakeChild();
  const events: JsonValue[] = [];
  const consumer = new DwsRunner(config, () => child).consume(['example'], 'example', event => { events.push(event); });
  child.stderr.write(marker);
  await consumer.ready;
  child.stdout.write('{"last":true}');
  child.close(1, 'SIGTERM');
  const exit = await consumer.exited;
  assert.deepEqual(events, [{ last: true }]);
  assert.equal(exit.signal, 'SIGTERM');
  assert.equal(exit.code, 1);
  assert.equal(exit.remoteCleanup, 'unknown');
});

for (const method of ['sigterm', 'stdin'] as const) {
  test(`stops a real local fake process with ${method}, drains both pipes and never claims remote cleanup`, { timeout: 5000 }, async () => {
    const execute: DwsSpawn = (_binary, _args, options) => spawn(process.execPath, ['-e', `
      const finish = () => {
        process.stderr.write('[event] exited — received 1 event(s) in 1ms (reason: signal)\\n');
        process.exitCode = 0;
        process.stdin.destroy();
      };
      process.on('SIGTERM', finish);
      process.stdin.on('end', finish);
      process.stdin.resume();
      process.stderr.write('diagnostic credential-canary\\n'.repeat(10000), () => {
        process.stderr.write(${JSON.stringify(marker)});
        process.stdout.write('{"value":1}\\n');
      });
    `], options);
    const consumer = new DwsRunner(config, execute).consume(['example'], 'example', () => {});
    assert.notEqual(await consumer.ready, null);
    const exit = await consumer.stop(method);
    assert.equal(exit.code, 0);
    assert.equal(exit.reason, 'signal');
    assert.equal(exit.remoteCleanup, 'unknown');
    assert.ok(exit.diagnostics.stderrLines >= 10000);
    assert.doesNotMatch(JSON.stringify(exit), /credential-canary/);
  });
}
