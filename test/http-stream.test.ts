import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { request, setAuditSink, setProxy, type FetchOptions } from '../src/server/http.js';

type MustReject<Value extends false> = Value;
export type StreamExclusions = [
  MustReject<{ bodyStream: Readable; followRedirects: false; body: string } extends FetchOptions ? true : false>,
  MustReject<{ bodyStream: Readable; followRedirects: false; bodyBytes: Uint8Array } extends FetchOptions ? true : false>,
  MustReject<{ bodyStream: Readable; followRedirects: false; audit: object } extends FetchOptions ? true : false>,
  MustReject<{ bodyStream: Readable; followRedirects: false; transport: 'fetch' } extends FetchOptions ? true : false>,
  MustReject<{ bodyStream: Readable } extends FetchOptions ? true : false>,
  MustReject<{ bodyStream: Readable; followRedirects: true } extends FetchOptions ? true : false>,
];

test('sends stream bytes without buffering through the HTTP facade', async (context) => {
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    outgoing.end(Buffer.concat(chunks));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const options = { method: 'POST', followRedirects: false as const,
    bodyStream: Readable.from([Buffer.from('streamed-body')]) };
  const response = await request(`http://127.0.0.1:${address.port}/`, options);
  assert.equal(await response.text(), 'streamed-body');
});

for (const invalid of [{}, { followRedirects: true }, { followRedirects: false, body: undefined },
  { followRedirects: false, bodyBytes: Buffer.alloc(0) }, { followRedirects: false, audit: undefined },
  { followRedirects: false, transport: 'fetch' }, { followRedirects: false, transport: 'other' }]) {
  test('rejects unsafe stream options from JS before dispatch or body consumption', async () => {
    let reads = 0;
    const bodyStream = new Readable({ read() { reads++; this.push(null); } });
    await assert.rejects(Reflect.apply(request, undefined, ['not-a-url', { bodyStream, ...invalid }]),
      { name: 'TypeError', message: 'Invalid streaming HTTP options' });
    assert.equal(reads, 0);
    bodyStream.destroy();
  });
}

for (const route of ['proxy', 'bypass'] as const) {
  test(`stream request preserves ${route} routing and never writes audit`, async (context) => {
    let proxyCalls = 0;
    let directCalls = 0;
    let auditCalls = 0;
    const target = createServer((incoming, outgoing) => {
      directCalls++;
      incoming.resume();
      incoming.on('end', () => outgoing.end('direct'));
    });
    const proxy = createServer((incoming, outgoing) => {
      proxyCalls++;
      incoming.resume();
      incoming.on('end', () => outgoing.end('proxy'));
    });
    target.listen(0, '127.0.0.1'); proxy.listen(0, '127.0.0.1');
    await Promise.all([once(target, 'listening'), once(proxy, 'listening')]);
    context.after(() => {
      setProxy(''); setAuditSink(null);
      for (const server of [target, proxy]) { server.closeAllConnections(); server.close(); }
    });
    const targetAddress = target.address(); const proxyAddress = proxy.address();
    assert.ok(targetAddress && typeof targetAddress !== 'string');
    assert.ok(proxyAddress && typeof proxyAddress !== 'string');
    setAuditSink({ record: () => ++auditCalls, update() {}, updateResponse() { auditCalls++; } });
    setProxy(`http://127.0.0.1:${proxyAddress.port}`, route === 'bypass' ? ['127.0.0.1'] : []);
    const response = await request(`http://127.0.0.1:${targetAddress.port}/`, {
      method: 'POST', bodyStream: Readable.from([Buffer.from('private')]), followRedirects: false,
    });
    assert.equal(await response.text(), route === 'proxy' ? 'proxy' : 'direct');
    assert.equal(proxyCalls, route === 'proxy' ? 1 : 0);
    assert.equal(directCalls, route === 'bypass' ? 1 : 0);
    assert.equal(auditCalls, 0);
  });
}
