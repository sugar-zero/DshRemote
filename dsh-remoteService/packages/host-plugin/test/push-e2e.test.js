import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { withTempHome } from './helpers.js';

/**
 * 端到端推送：RemoteService 监听 session/event → connector → 真 relay push 服务 → mock Expo endpoint。
 * 断言 payload 内容无关（只有通用标题/正文 + kind），不含会话/消息/路径。
 */
test('push end-to-end: session turn end -> connector -> relay -> Expo endpoint (content-free)', async () => {
  const home = withTempHome();
  const expoRequests = [];
  const expo = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      expoRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ status: 'ok' }] }));
    });
  });
  await new Promise((resolve) => expo.listen(0, '127.0.0.1', resolve));
  const expoPort = expo.address().port;

  const { createRelay } = await import('../../relay/index.js');
  const relay = await createRelay({
    domain: 'relay.test',
    dataPort: 0,
    controlPort: 0,
    httpPort: 0,
    dev: true,
    dataHost: '127.0.0.1',
    hostTokens: { h_e2e: 'tok-e2e' },
    logLevel: 'silent',
    push: {
      endpoint: `http://127.0.0.1:${expoPort}/push`,
      title: 'DSH',
      body: '有任务需要你',
    },
  });
  const { saveConfig } = await import('../lib/config.js');
  const { paths, writeJson } = await import('../lib/paths.js');
  const { RemoteService } = await import('../lib/service.js');

  saveConfig({
    enabled: true,
    relayUrl: `ws://127.0.0.1:${relay.controlPort}`,
    relayDomain: 'relay.test',
    hostId: 'h_e2e',
    hostToken: 'tok-e2e',
    hostName: 'E2E Host',
    relayTlsInsecure: true,
    requireApproval: true,
    pushEnabled: true,
    pushCooldownSeconds: 0,
    pushProvider: 'expo',
  });
  writeJson(paths.pushTokens(), {
    version: 1,
    tokens: [{ deviceId: 'd_e2e', provider: 'expo', token: 'ExponentPushToken[eeeeeeee]', ts: Date.now() }],
  });

  const handlers = new Map();
  const fakeCtx = {
    webServer: { protocol: 'http:', port: 1, getOrigin: () => 'http://127.0.0.1:1/' },
    connection: { authenticatedUrl: (origin) => `${origin}?token=test` },
    effect: (fn) => fn(),
    on: (event, handler) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  };

  const service = new RemoteService(fakeCtx);
  try {
    await service.ready;
    const deadline = Date.now() + 8000;
    while (!service.connector?.isConnected() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(service.connector?.isConnected(), true, 'RemoteService connector 应连上 relay');
    // 等 push token 从 host 注册到 relay
    const tokenDeadline = Date.now() + 5000;
    while (relay.health().pushTokens < 1 && Date.now() < tokenDeadline) {
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(relay.health().pushTokens, 1, 'push token 应注册到 relay');

    const onSessionEvent = handlers.get('session/event');
    assert.equal(typeof onSessionEvent, 'function');
    onSessionEvent(
      { id: 's_e2e', header: { origin: 'chat' } },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    );

    const pushDeadline = Date.now() + 5000;
    while (expoRequests.length === 0 && Date.now() < pushDeadline) {
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(expoRequests.length, 1, 'Expo endpoint 应收到一次推送');
    const messages = expoRequests[0];
    assert.equal(messages.length, 1);
    assert.equal(messages[0].title, 'DSH');
    assert.equal(messages[0].body, '有任务需要你');
    assert.deepEqual(messages[0].data, { kind: 'attention' });
    // 零内容断言：不能出现会话 id / 消息 / 路径
    const serialized = JSON.stringify(messages[0]);
    assert.ok(!serialized.includes('s_e2e'));
    assert.ok(!serialized.includes('session'));
    assert.ok(!serialized.includes('/Users/'));
  } finally {
    await service.dispose();
    await relay.close();
    await new Promise((resolve) => expo.close(resolve));
    home.cleanup();
  }
});
