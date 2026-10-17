#!/usr/bin/env node
const assert = require('node:assert/strict');
assert.deepEqual(process.argv.slice(2), ['export', 'ses_root']);
assert.equal(process.cwd(), process.env.PWD);
assert.equal(process.cwd(), process.env.EXPORT_DIRECTORY);

switch (process.env.EXPORT_MODE) {
  case 'timeout':
    process.on('SIGTERM', () => process.stderr.write('Still running\n'));
    setInterval(() => {}, 1000);
    break;
  case 'stdout-limit':
    process.stdout.write('x'.repeat(4096));
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
  default:
    process.stderr.write('Exporting session: ses_root\n');
    process.stdout.write(process.env.EXPORT_PAYLOAD);
}
