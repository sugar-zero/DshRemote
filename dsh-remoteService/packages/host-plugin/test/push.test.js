import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { RELAY_MSG } from 'dsh-remote-protocol';
import { createPushNotifier, pushKindOf } from '../lib/push.js';

test('pushKindOf maps turn end reasons', () => {
  assert.equal(pushKindOf({ kind: 'completed' }), 'completed');
  assert.equal(pushKindOf({ kind: 'error' }), 'failure');
  assert.equal(pushKindOf({ kind: 'max-tokens' }), 'failure');
  assert.equal(pushKindOf({ kind: 'aborted' }), 'skip');
  assert.equal(pushKindOf(undefined), 'completed');
});

test('push notifier: sends content-free push on turn end, honors cooldown/subagent/disabled', () => {
  const calls = [];
  const audits = [];
  let config = { pushEnabled: true, pushCooldownSeconds: 60 };
  const notifier = createPushNotifier({
    getConfig: () => config,
    getConnector: () => ({ isConnected: () => true, sendPush: (arg) => { calls.push(arg); return true; } }),
    audit: { append: (entry) => audits.push(entry) },
  });
  const session = { id: 's_1', header: { origin: 'chat' } };
  notifier.onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { kind: 'attention' }); // 只有 kind，没有会话/内容
  assert.equal(calls[0].sessionId, undefined);
  // 冷却期内不重复
  notifier.onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(calls.length, 1);
  // 子代理会话不推
  notifier.onSessionEvent({ id: 's_2', header: { origin: 'subagent' } }, { type: 'turn/end', data: { reason: { kind: 'error' } } });
  assert.equal(calls.length, 1);
  // aborted 不推
  notifier.onSessionEvent({ id: 's_3', header: {} }, { type: 'turn/end', data: { reason: { kind: 'aborted' } } });
  assert.equal(calls.length, 1);
  // 关闭推送
  config = { pushEnabled: false, pushCooldownSeconds: 0 };
  notifier.onSessionEvent({ id: 's_4', header: {} }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(calls.length, 1);
  assert.ok(audits.some((entry) => entry.action === 'push-trigger'));
});

test('relay connector: registers push token and forwards push.send', async () => {
  const events = [];
  let relaySocket;
  const httpServer = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ server: httpServer, path: '/control' });
  wss.on('connection', (ws) => {
    relaySocket = ws;
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString());
      events.push(msg);
      if (msg.t === RELAY_MSG.HOST_HELLO) {
        ws.send(JSON.stringify({ t: RELAY_MSG.HOST_READY, protocolVersion: 1, hostId: 'h_test', hostname: 'h_test.relay.test', domain: 'relay.test' }));
      }
    });
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const relayPort = httpServer.address().port;
  const { RelayConnector } = await import('../lib/connector.js');
  const results = [];
  let connector;
  try {
  connector = new RelayConnector({
    relayUrl: `ws://127.0.0.1:${relayPort}`,
    hostId: 'h_test', hostToken: 'tok', hostName: 'Test', getLocalPort: () => 1,
    audit: { append() {} }, onPushResult: (msg) => results.push(msg),
  });
  connector.onPushResult = (msg) => results.push(msg);
  connector.registerPushToken({ deviceId: 'd1', provider: 'expo', token: 'ExponentPushToken[zzzzzzzz]' });
  connector.start();
  const start = Date.now();
  while (!connector.isConnected()) {
    if (Date.now() - start > 4000) throw new Error('connector did not connect');
    await new Promise((r) => setTimeout(r, 20));
  }
  // ready 后应补发注册
  assert.ok(events.some((e) => e.t === RELAY_MSG.PUSH_REGISTER && e.deviceId === 'd1'));
  assert.equal(connector.sendPush({ kind: 'attention' }), true);
  const sendStart = Date.now();
  while (!events.some((e) => e.t === RELAY_MSG.PUSH_SEND && e.kind === 'attention')) {
    if (Date.now() - sendStart > 2000) throw new Error('PUSH_SEND was not received by mock relay');
    await new Promise((r) => setTimeout(r, 20));
  }
  relaySocket.send(JSON.stringify({ t: RELAY_MSG.PUSH_RESULT, action: 'send', ok: true, delivered: 1 }));
  const resultStart = Date.now();
  while (results.length === 0) {
    if (Date.now() - resultStart > 2000) throw new Error('no push result callback');
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(results[0].delivered, 1);
  } finally {
    connector?.stop();
    wss.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
