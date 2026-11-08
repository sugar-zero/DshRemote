import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { RELAY_MSG, FRAME_TYPE, decodeFrame, encodeFrame } from 'dsh-remote-protocol';

test('relay connector: hello -> ready -> host.open -> opened -> data frames', async () => {
  const echo = net.createServer((socket) => {
    socket.on('data', (chunk) => socket.write(chunk));
    socket.on('error', () => {});
  });
  await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve));
  const echoPort = echo.address().port;

  const events = [];
  let relaySocket;
  const httpServer = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ server: httpServer, path: '/control' });
  wss.on('connection', (ws) => {
    relaySocket = ws;
    ws.on('message', (data, isBinary) => {
      if (!isBinary) events.push(JSON.parse(data.toString()));
      else events.push({ type: 'binary', frame: decodeFrame(Buffer.from(data)) });
    });
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const relayPort = httpServer.address().port;

  const { RelayConnector } = await import('../lib/connector.js');
  const connector = new RelayConnector({
    relayUrl: `ws://127.0.0.1:${relayPort}`,
    hostId: 'h_test',
    hostToken: 'tok_test',
    hostName: 'Test Mac',
    getLocalPort: () => echoPort,
    audit: { append() {} },
  });
  assert.equal(typeof connector.registerPushToken, 'function', '群体版 connector 应提供 push.register 上报接口');
  assert.equal(typeof connector.sendPushIntent, 'function', '群体版 connector 应提供 push.send 意图接口');
  connector.start();

  // 等 hello
  const hello = await waitFor(() => events.find((e) => e.t === RELAY_MSG.HOST_HELLO));
  assert.equal(hello.hostId, 'h_test');
  assert.equal(hello.token, 'tok_test');
  assert.equal(hello.protocolVersion, 1);

  relaySocket.send(JSON.stringify({ t: RELAY_MSG.HOST_READY, protocolVersion: 1, hostId: 'h_test', hostname: 'h_test.relay.test', domain: 'relay.test' }));
  relaySocket.send(JSON.stringify({ t: RELAY_MSG.HOST_OPEN, streamId: 7, sni: 'h_test.relay.test' }));
  await waitFor(() => events.find((e) => e.t === RELAY_MSG.HOST_OPENED && e.streamId === 7));

  relaySocket.send(new Uint8Array(encodeFrame(FRAME_TYPE.DATA, 7, Buffer.from('ping'))));
  const dataEvent = await waitFor(() => events.find((e) => e.type === 'binary' && e.frame?.type === FRAME_TYPE.DATA));
  assert.equal(dataEvent.frame.streamId, 7);
  assert.equal(dataEvent.frame.payload.toString(), 'ping');

  relaySocket.send(new Uint8Array(encodeFrame(FRAME_TYPE.CLOSE, 7)));
  await new Promise((resolve) => setTimeout(resolve, 50));
  connector.stop();
  wss.close();
  await new Promise((resolve) => httpServer.close(resolve));
  await new Promise((resolve) => echo.close(resolve));
});

test('relay connector: reconnects after relay drops the socket and re-sends hello', async () => {
  const { WebSocketServer } = await import('ws');
  const { RELAY_MSG } = await import('dsh-remote-protocol');
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  const port = wss.address().port;
  const helloHosts = [];
  let connections = 0;
  wss.on('connection', (ws) => {
    connections += 1;
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(data.toString());
      if (message.t === RELAY_MSG.HOST_HELLO) {
        helloHosts.push(message.hostId);
        ws.send(JSON.stringify({
          t: RELAY_MSG.HOST_READY,
          protocolVersion: 1,
          hostId: message.hostId,
          hostname: `${message.hostId}.relay.test`,
          domain: 'relay.test',
        }));
        // 第一次连接后主动断开，验证客户端会自动重连并重新握手。
        if (connections === 1) setTimeout(() => ws.close(), 50);
      }
    });
  });

  const { RelayConnector } = await import('../lib/connector.js');
  const connector = new RelayConnector({
    relayUrl: `ws://127.0.0.1:${port}`,
    hostId: 'h_reconnect',
    hostToken: 'tok',
    hostName: 'Test',
    getLocalPort: () => 1,
    audit: { append() {} },
  });
  connector.start();
  try {
    const deadline = Date.now() + 8000;
    while (!(connections >= 2 && helloHosts.length >= 2) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(connections >= 2, `应至少重连一次（connections=${connections}）`);
    assert.ok(helloHosts.length >= 2, '重连后应再次发送 host.hello');
    assert.equal(helloHosts[0], 'h_reconnect');
  } finally {
    connector.stop();
    await new Promise((resolve) => wss.close(resolve));
  }
});

function waitFor(predicate, timeoutMs = 4000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        const result = predicate();
        if (result) { resolve(result); return; }
      } catch (error) { reject(error); return; }
      if (Date.now() - start > timeoutMs) { reject(new Error('timeout')); return; }
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** 假的 relay 控制面（只实现 hello/ready + 推送控制消息），用于 connector 推送单测。 */
async function startMockRelay({ replyRegistered = true, replyResult = false, ignoreRegisterDeviceIds = [] } = {}) {
  const state = {
    sockets: [],
    messages: [],
    pushRegisters: [],
    pushSends: [],
    pushResults: [],
    connections: 0,
  };
  const httpServer = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ server: httpServer, path: '/control' });
  wss.on('connection', (ws) => {
    state.connections += 1;
    state.sockets.push(ws);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString());
      state.messages.push(msg);
      if (msg.t === RELAY_MSG.HOST_HELLO) {
        ws.send(JSON.stringify({
          t: RELAY_MSG.HOST_READY,
          protocolVersion: 1,
          hostId: msg.hostId,
          hostname: `${msg.hostId}.relay.test`,
          domain: 'relay.test',
        }));
        return;
      }
      if (msg.t === RELAY_MSG.PUSH_REGISTER) {
        state.pushRegisters.push(msg);
        if (replyRegistered && !ignoreRegisterDeviceIds.includes(msg.deviceId)) {
          ws.send(JSON.stringify({
            t: RELAY_MSG.PUSH_REGISTERED,
            ok: true,
            deviceId: msg.deviceId,
            mode: 'self',
            enabled: true,
          }));
        }
        return;
      }
      if (msg.t === RELAY_MSG.PUSH_SEND) {
        state.pushSends.push(msg);
        if (replyResult) {
          ws.send(JSON.stringify({
            t: RELAY_MSG.PUSH_RESULT,
            id: msg.id,
            ok: true,
            delivered: 1,
            failed: 0,
            pruned: [],
            mode: 'self',
          }));
        }
      }
    });
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = httpServer.address().port;
  return {
    ...state,
    port,
    get connections() { return state.connections; },
    get socket() { return state.sockets.at(-1); },
    async close() {
      for (const ws of state.sockets) { try { ws.close(); } catch { /* ignore */ } }
      wss.close();
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

const APNS_TOKEN = 'a'.repeat(64);

test('relay connector: push.register → push.registered（回调 + 缓存），重连后自动补报', async () => {
  const relay = await startMockRelay();
  const registered = [];
  const logs = [];
  const { RelayConnector } = await import('../lib/connector.js');
  const connector = new RelayConnector({
    relayUrl: `ws://127.0.0.1:${relay.port}`,
    hostId: 'h_push',
    hostToken: 'tok',
    hostName: 'Push Test',
    getLocalPort: () => 1,
    audit: { append() {} },
    log: (message) => logs.push(message),
    onPushRegistered: (msg) => registered.push(msg),
    pushRegisterTimeoutMs: 1000,
  });
  connector.start();
  try {
    await waitFor(() => connector.isConnected());
    const result = await connector.registerPushToken({
      deviceId: 'd_apns', provider: 'apns', token: APNS_TOKEN, environment: 'development',
    });
    assert.deepEqual(result, { ok: true, mode: 'self', enabled: true });
    assert.equal(relay.pushRegisters.length, 1);
    assert.deepEqual(relay.pushRegisters[0], {
      t: RELAY_MSG.PUSH_REGISTER,
      deviceId: 'd_apns',
      provider: 'apns',
      token: APNS_TOKEN,
      environment: 'development',
    });
    assert.equal(registered.length, 1);
    assert.equal(registered[0].deviceId, 'd_apns');

    // 重连（relay 断开）后：ready 时自动补报缓存的 token（relay 重启会丢内存 token 表）
    relay.socket.close();
    await waitFor(() => relay.connections >= 2, 5000);
    await waitFor(() => connector.isConnected(), 5000);
    await waitFor(() => relay.pushRegisters.length >= 2, 5000);
    assert.equal(relay.pushRegisters.at(-1).deviceId, 'd_apns');
    // token 不落日志
    assert.equal(logs.some((line) => line.includes(APNS_TOKEN)), false, '日志不能出现 token 明文');
  } finally {
    connector.stop();
    await relay.close();
  }
});

test('relay connector: push.send → push.result 回调；15s 超时只记日志/不重发；登记超时返回可重试错误', async () => {
  const relay = await startMockRelay({ ignoreRegisterDeviceIds: ['d_timeout'] });
  const results = [];
  const logs = [];
  const audits = [];
  const { RelayConnector } = await import('../lib/connector.js');
  const connector = new RelayConnector({
    relayUrl: `ws://127.0.0.1:${relay.port}`,
    hostId: 'h_push',
    hostToken: 'tok',
    hostName: 'Push Test',
    getLocalPort: () => 1,
    audit: { append: (entry) => audits.push(entry) },
    log: (message) => logs.push(message),
    onPushResult: (msg) => results.push(msg),
    pushRegisterTimeoutMs: 80,
    pushIntentTimeoutMs: 80,
  });

  // 未连接：两个接口都安全返回可重试错误/ false
  assert.equal(connector.sendPushIntent({ id: 'before-start', kind: 'turn-end' }), false);
  assert.deepEqual(
    await connector.registerPushToken({ deviceId: 'd_x', provider: 'apns', token: APNS_TOKEN, environment: 'development' }),
    { ok: false, code: 'not_connected' },
  );

  connector.start();
  try {
    await waitFor(() => connector.isConnected());

    // push.result 回调 + 审计（host 不重试）
    assert.equal(connector.sendPushIntent({
      id: 'push-1', kind: 'turn-end', title: '标题', body: '摘要', sessionId: 's_1',
    }), true);
    await waitFor(() => relay.pushSends.length >= 1);
    assert.deepEqual(relay.pushSends[0], {
      t: RELAY_MSG.PUSH_SEND,
      id: 'push-1',
      kind: 'turn-end',
      title: '标题',
      body: '摘要',
      sessionId: 's_1',
    });
    relay.socket.send(JSON.stringify({
      t: RELAY_MSG.PUSH_RESULT, id: 'push-1', ok: true, delivered: 1, failed: 0, pruned: ['d_gone'], mode: 'self',
    }));
    await waitFor(() => results.length === 1);
    assert.equal(results[0].delivered, 1);
    assert.ok(audits.some((entry) => entry.action === 'push-result' && entry.result === 'ok'));

    // 失败回执只记日志/审计，不重试
    assert.equal(connector.sendPushIntent({ id: 'push-2', kind: 'waiting-answer' }), true);
    relay.socket.send(JSON.stringify({
      t: RELAY_MSG.PUSH_RESULT, id: 'push-2', ok: false, code: 'rate_limited', message: 'too many',
    }));
    await waitFor(() => results.length === 2);
    assert.equal(results[1].ok, false);
    assert.ok(audits.some((entry) => entry.action === 'push-result' && entry.result === 'failed'));

    // 15s 超时（这里注入 80ms）：只记日志，不重发
    assert.equal(connector.sendPushIntent({ id: 'push-timeout', kind: 'turn-end' }), true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(relay.pushSends.filter((msg) => msg.id === 'push-timeout').length, 1, '超时不能重发');
    assert.ok(logs.some((line) => line.includes('未收到 push.result')), '超时应记日志');
    assert.ok(connector.pendingPushIntents.size === 0, '超时后清理等待表');

    // 登记超时（relay 不回 push.registered）→ 可重试错误 code=timeout
    const timeoutResult = await connector.registerPushToken({
      deviceId: 'd_timeout', provider: 'apns', token: 'b'.repeat(64), environment: 'production',
    });
    assert.deepEqual(timeoutResult, { ok: false, code: 'timeout' });
    assert.ok(logs.some((line) => line.includes('push.register timeout')));
    assert.equal(connector.pushTokens.has('d_timeout'), false, '登记失败不能进重连补报表');
  } finally {
    connector.stop();
    await relay.close();
  }
});

test('relay connector: removePushToken 后重连不再补报该设备 token（R2 设备改走 official）', async () => {
  const relay = await startMockRelay();
  const { RelayConnector } = await import('../lib/connector.js');
  const connector = new RelayConnector({
    relayUrl: `ws://127.0.0.1:${relay.port}`,
    hostId: 'h_push',
    hostToken: 'tok',
    hostName: 'Push Test',
    getLocalPort: () => 1,
    audit: { append() {} },
    pushRegisterTimeoutMs: 1000,
  });
  connector.start();
  try {
    await waitFor(() => connector.isConnected());
    const result = await connector.registerPushToken({
      deviceId: 'd_switch', provider: 'apns', token: 'c'.repeat(64), environment: 'development',
    });
    assert.equal(result.ok, true);
    assert.equal(relay.pushRegisters.length, 1);

    // 设备改走 official：清掉 relay token 缓存，重连 ready 不应再补报
    connector.removePushToken('d_switch');
    assert.equal(connector.pushTokens.has('d_switch'), false);

    relay.socket.close();
    await waitFor(() => relay.connections >= 2, 5000);
    await waitFor(() => connector.isConnected(), 5000);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(relay.pushRegisters.length, 1, 'removePushToken 后不应再补报该设备');
  } finally {
    connector.stop();
    await relay.close();
  }
});

test('relay connector: handshake watchdog reconnects when host.ready never arrives', async () => {
  const { WebSocketServer } = await import('ws');
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  const port = wss.address().port;
  let connections = 0;
  wss.on('connection', (ws) => {
    connections += 1;
    // 故意不回 host.ready：模拟“TCP 连着但 relay 不回话”的半开/挂起。
    ws.on('message', () => {});
  });
  const { RelayConnector } = await import('../lib/connector.js');
  const connector = new RelayConnector({
    relayUrl: `ws://127.0.0.1:${port}`,
    hostId: 'h_hs',
    hostToken: 'tok',
    hostName: 'HS Test',
    getLocalPort: () => 1,
    audit: { append() {} },
    handshakeTimeoutMs: 120,
    livenessTimeoutMs: 30_000,
  });
  connector.start();
  try {
    await waitFor(() => connections >= 2, 3000);
    assert.ok(connections >= 2, '握手超时后应主动重连');
    assert.equal(connector.isConnected(), false);
  } finally {
    connector.stop();
    await new Promise((resolve) => wss.close(resolve));
  }
});

test('relay connector: liveness watchdog reconnects when relay goes silent after ready', async () => {
  const { WebSocketServer } = await import('ws');
  const { RELAY_MSG } = await import('dsh-remote-protocol');
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  const port = wss.address().port;
  let connections = 0;
  wss.on('connection', (ws) => {
    connections += 1;
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(data.toString());
      if (message.t !== RELAY_MSG.HOST_HELLO) return;
      ws.send(JSON.stringify({
        t: RELAY_MSG.HOST_READY, protocolVersion: 1, hostId: 'h_live', hostname: 'h_live.relay.test', domain: 'relay.test',
      }));
      // ready 之后不再发 host.heartbeat：模拟半开链路。
    });
  });
  const { RelayConnector } = await import('../lib/connector.js');
  const connector = new RelayConnector({
    relayUrl: `ws://127.0.0.1:${port}`,
    hostId: 'h_live',
    hostToken: 'tok',
    hostName: 'Live Test',
    getLocalPort: () => 1,
    audit: { append() {} },
    handshakeTimeoutMs: 5000,
    livenessTimeoutMs: 120,
  });
  connector.start();
  try {
    await waitFor(() => connections >= 2, 4000);
    assert.ok(connections >= 2, '静默超时后应主动重连（不等 TCP 超时）');
  } finally {
    connector.stop();
    await new Promise((resolve) => wss.close(resolve));
  }
});
