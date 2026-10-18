import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRelay } from '../index.js';
import { createPushService } from '../lib/push.js';
import { ControlClient } from './helpers/control-client.js';
import { RELAY_MSG, PROTOCOL_VERSION } from 'dsh-remote-protocol';

test('push service: registers tokens, sends content-free generic payload', async () => {
  const calls = [];
  const service = createPushService({
    enabled: true,
    endpoint: 'https://push.example.test/send',
    accessToken: 'tok',
    title: 'DSH',
    body: '有任务需要你',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ data: [{ status: 'ok' }, { status: 'error' }] }) };
    },
  });
  assert.equal(service.register('h_a', { deviceId: 'd1', provider: 'expo', token: 'ExponentPushToken[aaaaaaaa]' }).registered, true);
  assert.equal(service.register('h_a', { deviceId: 'd2', provider: 'expo', token: 'ExponentPushToken[bbbbbbbb]' }).registered, true);
  assert.equal(service.register('h_b', { deviceId: 'd3', provider: 'expo', token: 'ExponentPushToken[cccccccc]' }).registered, true);
  assert.equal(service.countFor('h_a'), 2);
  const result = await service.send('h_a', { kind: 'attention' });
  assert.deepEqual(result, { delivered: 1, failed: 1 });
  assert.equal(calls.length, 1);
  const batch = calls[0].body;
  assert.equal(batch.length, 2);
  for (const message of batch) {
    assert.equal(message.title, 'DSH');
    assert.equal(message.body, '有任务需要你');
    assert.deepEqual(message.data, { kind: 'attention' });
    assert.equal(message.sessionId, undefined);
    assert.equal(message.sessionTitle, undefined);
    assert.equal(message.path, undefined);
  }
  assert.equal((await service.send('h_unknown')).delivered, 0);
});

test('push service: rejects bad tokens and isolates hosts', () => {
  const service = createPushService({ enabled: true, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  assert.throws(() => service.register('h', { deviceId: '', token: 'x'.repeat(20) }), /deviceId/);
  assert.throws(() => service.register('h', { deviceId: 'd', provider: 'apns', token: 'x'.repeat(20) }), /provider/);
  assert.throws(() => service.register('h', { deviceId: 'd', token: 'short' }), /长度/);
  service.register('h1', { deviceId: 'd1', token: 'x'.repeat(20) });
  assert.equal(service.countFor('h2'), 0);
});

test('relay control plane: push.register / push.send roundtrip with mock Expo endpoint', async () => {
  const pushes = [];
  const pushServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      pushes.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ status: 'ok' }] }));
    });
  });
  await new Promise((resolve) => pushServer.listen(0, '127.0.0.1', resolve));
  const pushPort = pushServer.address().port;
  let relay;
  let client;
  try {
    relay = await createRelay({
      domain: 'relay.test',
      dataPort: 0,
      controlPort: 0,
      httpPort: 0,
      dev: true,
      dataHost: '127.0.0.1',
      hostTokens: { h_test: 'token-abc' },
      logLevel: 'silent',
      push: { endpoint: `http://127.0.0.1:${pushPort}/push`, title: 'DSH', body: '有任务需要你' },
    });
    client = await ControlClient.connect(`ws://127.0.0.1:${relay.controlPort}/control`);
    client.sendJson({ t: RELAY_MSG.HOST_HELLO, protocolVersion: PROTOCOL_VERSION, hostId: 'h_test', token: 'token-abc', hostName: 'Test' });
    const ready = await client.nextJson(4000);
    assert.equal(ready.t, RELAY_MSG.HOST_READY);

    client.sendJson({ t: RELAY_MSG.PUSH_REGISTER, deviceId: 'd1', provider: 'expo', token: 'ExponentPushToken[dddddddd]' });
    const reg = await client.nextJson(4000);
    assert.equal(reg.t, RELAY_MSG.PUSH_RESULT);
    assert.equal(reg.action, 'register');
    assert.equal(reg.ok, true);

    client.sendJson({ t: RELAY_MSG.PUSH_SEND, kind: 'attention' });
    const sent = await client.nextJson(4000);
    assert.equal(sent.t, RELAY_MSG.PUSH_RESULT);
    assert.equal(sent.action, 'send');
    assert.equal(sent.delivered, 1);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0][0].title, 'DSH');
    assert.deepEqual(pushes[0][0].data, { kind: 'attention' });
    assert.equal(relay.health().pushTokens, 1);
  } finally {
    client?.close();
    await relay?.close();
    await new Promise((resolve) => pushServer.close(resolve));
  }
});
