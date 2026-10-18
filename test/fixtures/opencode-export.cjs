#!/usr/bin/env node
const assert = require('node:assert/strict');
const { fstatSync, readdirSync, statSync, writeSync } = require('node:fs');
const { join } = require('node:path');
assert.deepEqual(process.argv.slice(2), ['export', 'ses_root']);
assert.equal(process.cwd(), process.env.PWD);
assert.equal(process.cwd(), process.env.EXPORT_DIRECTORY);
if (process.env.EXPORT_VERIFY_PRIVATE === '1' && fstatSync(1).isFile()) {
  /** @type {string[]} */
  const entries = readdirSync(process.cwd());
  let directory = '';
  for (const entry of entries) {
    if (entry.startsWith('quotahot-export-')) {
      directory = entry;
      break;
    }
  }
  assert.ok(directory);
  assert.equal(directory.includes('ses_root'), false);
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(process.cwd(), directory)).mode & 0o777, 0o700);
    assert.equal(fstatSync(1).mode & 0o777, 0o600);
  }
}

switch (process.env.EXPORT_MODE) {
  case 'pipe-truncation': {
    const messages = Array.from({ length: 48 }, (_, index) => ({
      info: { id: `msg_${index}`, sessionID: 'ses_root', role: 'user', time: { created: 2000 + index } },
      parts: [{ id: `prt_${index}`, sessionID: 'ses_root', messageID: `msg_${index}`, type: 'text',
        text: index === 47 ? 'FINAL_EXPORT_MESSAGE_48' : 'synthetic text '.repeat(1024) }],
    }));
    const payload = JSON.stringify({ info: { id: 'ses_root', title: 'Synthetic export', time: { created: 1000, updated: 4000 } }, messages });
    writeSync(1, fstatSync(1).isFile() ? payload : payload.slice(0, 1024));
    process.exit(0);
  }
  case 'timeout':
    process.on('SIGTERM', () => process.stderr.write('Still running\n'));
    setInterval(() => {}, 1000);
    break;
  case 'stdout-limit':
    process.stdout.write('x'.repeat(4096));
    break;
  case 'stdout-limit-running':
    writeSync(1, 'x'.repeat(4096));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    break;
  case 'stderr-limit':
    process.stderr.write('x'.repeat(4096));
    break;
  case 'missing':
    process.stderr.write('Session not found: ses_root\n');
    break;
  case 'failed':
    process.stderr.write('database unavailable\n');
    process.exitCode = 1;
    break;
  case 'invalid':
    process.stdout.write('not json');
    break;
  case 'utf8':
    process.stdout.write(Buffer.from([0xff]));
    break;
  default: {
    process.stderr.write('Exporting session: ses_root\n');
    const payload = process.env.EXPORT_PAYLOAD;
    if (typeof payload !== 'string') throw new Error('Missing fixture export payload');
    process.stdout.write(payload);
    break;
  }
}
