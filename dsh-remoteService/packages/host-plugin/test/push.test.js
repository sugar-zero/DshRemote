import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { RELAY_MSG } from 'dsh-remote-protocol';
import { createPushNotifier, pushKindOf } from '../lib/push.js';
import { normalizePushTokenBody } from '../lib/server.js';

test('pushKindOf maps turn end reasons', () => {
  assert.equal(pushKindOf({ kind: 'completed' }), 'completed');
  assert.equal(pushKindOf({ kind: 'error' }), 'failure');
  assert.equal(pushKindOf({ kind: 'max-tokens' }), 'failure');
  assert.equal(pushKindOf({ kind: 'aborted' }), 'skip');
  assert.equal(pushKindOf(undefined), 'completed');
});

test('push token body: accepts APNs device tokens + environment, rejects bad input', () => {
  const apns = normalizePushTokenBody({ provider: 'apns', token: 'A'.repeat(64), environment: 'development' });
  assert.deepEqual(apns, { provider: 'apns', token: 'A'.repeat(64), environment: 'development' });
  assert.deepEqual(normalizePushTokenBody({ provider: 'apns', token: 'b'.repeat(64) }), { provider: 'apns', token: 'b'.repeat(64) });
  // 旧 Expo token 兼容
  assert.deepEqual(normalizePushTokenBody({ provider: 'expo', token: 'ExponentPushToken[xxxxxxxx]' }), { provider: 'expo', token: 'ExponentPushToken[xxxxxxxx]' });
  // 默认 provider 仍为 expo（旧客户端的兼容路径）
  assert.equal(normalizePushTokenBody({ token: 'ExponentPushToken[yyyyyyyy]' }).provider, 'expo');
  assert.throws(() => normalizePushTokenBody({ provider: 'apns', token: 'not-hex' }), /64 位十六进制/);
  assert.throws(() => normalizePushTokenBody({ provider: 'apns', token: 'a'.repeat(64), environment: 'sandbox' }), /environment/);
  assert.throws(() => normalizePushTokenBody({ provider: 'windows', token: 'x' }), /provider/);
  assert.throws(() => normalizePushTokenBody({ provider: 'apns', token: '' }), /token/);
});

test('push notifier (self-hosted APNs): session title + assistant summary, prunes invalid tokens, honors cooldown/subagent/disabled', async () => {
  const sends = [];
  const audits = [];
  const pruned = [];
  const goneToken = 'f'.repeat(64);
  let config = { pushEnabled: true, pushCooldownSeconds: 60, pushProvider: 'apns', relayDomain: 'relay.test', hostId: 'h_push' };
  let tokens = [
    { deviceId: 'd_apns', provider: 'apns', token: 'a'.repeat(64), environment: 'development' },
    { deviceId: 'd_legacy', provider: 'expo', token: 'ExponentPushToken[zzzzzzzz]' },
  ];
  const client = {
    isConfigured: () => true,
    sendToTokens: async (entries, message) => {
      sends.push({ entries, message });
      return { delivered: entries.length, failed: 1, pruned: [{ deviceId: 'd_gone', token: goneToken }], configErrors: [], errors: [] };
    },
  };
  const notifier = createPushNotifier({
    getConfig: () => config,
    // APNs 通道不应依赖 relay 连接
    getConnector: () => ({ isConnected: () => { throw new Error('should not touch relay'); }, sendPush: () => { throw new Error('should not touch relay'); } }),
    getApnsClient: () => client,
    getPushTokens: () => tokens,
    onPushTokensInvalid: (entries) => pruned.push(...entries),
    audit: { append: (entry) => audits.push(entry) },
  });
  const session = { id: 's_1', header: { origin: 'chat' } };
  // 会话事件流：标题 / 用户消息 / turn 开始 / 助手回复
  await notifier.onSessionEvent(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我看看登录重定向' }] } });
  await notifier.onSessionEvent(session, { type: 'session/title', data: { title: '修复登录 bug' } });
  await notifier.onSessionEvent(session, { type: 'turn/start', data: { turn: 0 } });
  await notifier.onSessionEvent(session, {
    type: 'assistant/message',
    data: { turn: 0, step: 0, stream: [], message: { role: 'assistant', content: [{ type: 'text', text: '已修好登录重定向，跑完测试' }] } },
  });
  await notifier.onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].entries.map((entry) => entry.deviceId), ['d_apns'], '只把 apns token 交给 APNs 发送器');
  assert.deepEqual(sends[0].message, {
    kind: 'attention',
    title: '修复登录 bug',
    body: '已修好登录重定向，跑完测试',
    sessionId: 's_1',
    host: 'h_push.relay.test',
  });
  // pruned 条目原样传给清理回调（{deviceId, token} 而不是纯 deviceId）
  assert.deepEqual(pruned, [{ deviceId: 'd_gone', token: goneToken }]);
  assert.ok(audits.some((entry) => entry.action === 'push-trigger' && entry.result === 'sent'));

  // 冷却期内不重复
  await notifier.onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(sends.length, 1);
  // 子代理会话不推
  await notifier.onSessionEvent({ id: 's_2', header: { origin: 'subagent' } }, { type: 'turn/end', data: { reason: { kind: 'error' } } });
  assert.equal(sends.length, 1);
  // aborted 不推
  await notifier.onSessionEvent({ id: 's_3', header: {} }, { type: 'turn/end', data: { reason: { kind: 'aborted' } } });
  assert.equal(sends.length, 1);
  // 关闭推送
  config = { pushEnabled: false, pushCooldownSeconds: 0, pushProvider: 'apns', relayDomain: 'relay.test', hostId: 'h_push' };
  await notifier.onSessionEvent({ id: 's_4', header: {} }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(sends.length, 1);

  // 失败且本轮无助手文本 → 状态兜底文案；标题退回首条用户消息
  config = { pushEnabled: true, pushCooldownSeconds: 0, pushProvider: 'apns', relayDomain: 'relay.test', hostId: 'h_push' };
  const fallbackSession = { id: 's_fallback', header: {} };
  await notifier.onSessionEvent(fallbackSession, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '跑一下部署脚本' }] } });
  await notifier.onSessionEvent(fallbackSession, { type: 'turn/start', data: { turn: 1 } });
  await notifier.onSessionEvent(fallbackSession, { type: 'turn/end', data: { reason: { kind: 'error' } } });
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[1].message, { kind: 'attention', title: '跑一下部署脚本', body: '任务出错，打开查看详情', sessionId: 's_fallback', host: 'h_push.relay.test' });

  // 失败但有助手文本 → 摘要前加失败标记
  const failureSession = { id: 's_failure', header: {} };
  await notifier.onSessionEvent(failureSession, { type: 'session/title', data: { title: '清理缓存' } });
  await notifier.onSessionEvent(failureSession, { type: 'turn/start', data: { turn: 2 } });
  await notifier.onSessionEvent(failureSession, {
    type: 'assistant/message',
    data: { turn: 2, step: 0, stream: [], message: { role: 'assistant', content: [{ type: 'text', text: '缓存已清空，但部署步骤超时' }] } },
  });
  await notifier.onSessionEvent(failureSession, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } });
  assert.equal(sends.length, 3);
  assert.deepEqual(sends[2].message, { kind: 'attention', title: '清理缓存', body: '⚠️ 缓存已清空，但部署步骤超时', sessionId: 's_failure', host: 'h_push.relay.test' });

  // 运行中 token 失效清空后不再发送，也不再消耗冷却状态
  tokens = [];
  await notifier.onSessionEvent({ id: 's_5', header: {} }, { type: 'turn/end', data: { reason: { kind: 'error' } } });
  assert.equal(sends.length, 3);
});

test('push notifier (self-hosted APNs): config errors are logged as a config hint and never pruned', async () => {
  const logs = [];
  const pruned = [];
  const audits = [];
  const client = {
    isConfigured: () => true,
    sendToTokens: async () => ({
      delivered: 0,
      failed: 1,
      pruned: [],
      configErrors: ['BadDeviceToken', 'DeviceTokenNotForTopic'],
      errors: [{ status: 400, reason: '400 DeviceTokenNotForTopic' }],
    }),
  };
  const notifier = createPushNotifier({
    getConfig: () => ({ pushEnabled: true, pushCooldownSeconds: 0, pushProvider: 'apns', relayDomain: 'relay.test', hostId: 'h_push' }),
    getConnector: () => { throw new Error('APNs 通道不应依赖 relay'); },
    getApnsClient: () => client,
    getPushTokens: () => [{ deviceId: 'd_cfg', provider: 'apns', token: 'b'.repeat(64) }],
    onPushTokensInvalid: (entries) => pruned.push(...entries),
    audit: { append: (entry) => audits.push(entry) },
    log: (message) => logs.push(message),
  });
  await notifier.onSessionEvent({ id: 's_cfg', header: {} }, { type: 'turn/end', data: { reason: { kind: 'error' } } });
  assert.deepEqual(pruned, [], '配置错误不能当成死 token 清理');
  assert.ok(audits.some((entry) => entry.action === 'push-trigger' && entry.result === 'failed'));
  assert.ok(logs.some((line) => line.includes('配置错误') && line.includes('apnsTopic') && line.includes('BadDeviceToken')),
    '日志应提示检查 apnsTopic / apnsEnvironment，而不是清理 token');
});

test('push notifier (legacy Expo via relay): only uses relay connector and keeps working', async () => {
  const calls = [];
  const audits = [];
  let config = { pushEnabled: true, pushCooldownSeconds: 60, pushProvider: 'expo' };
  const notifier = createPushNotifier({
    getConfig: () => config,
    getConnector: () => ({ isConnected: () => true, sendPush: (arg) => { calls.push(arg); return true; } }),
    getApnsClient: () => { throw new Error('expo 通道不应初始化 APNs'); },
    getPushTokens: () => [],
    audit: { append: (entry) => audits.push(entry) },
  });
  const session = { id: 's_1', header: { origin: 'chat' } };
  await notifier.onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { kind: 'attention' });
  assert.equal(calls[0].sessionId, undefined);
  await notifier.onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(calls.length, 1, '冷却期内不重复');
  assert.ok(audits.some((entry) => entry.action === 'push-trigger' && entry.result === 'sent'));
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
