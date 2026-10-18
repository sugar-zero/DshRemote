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
  await waitFor(() => connector.requestCount === undefined ? true : true, 50); // 让 close 处理
  connector.stop();
  wss.close();
  await new Promise((resolve) => httpServer.close(resolve));
  await new Promise((resolve) => echo.close(resolve));
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

test('relay connector: reconnects after relay drops the socket and re-registers push tokens', async () => {
  const { WebSocketServer } = await import('ws');
  const { RELAY_MSG } = await import('dsh-remote-protocol');
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  const port = wss.address().port;
  const helloHosts = [];
  const registrations = [];
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
        // 第一次连接后主动断开，验证客户端会自动重连并重新注册 push token。
        if (connections === 1) setTimeout(() => ws.close(), 50);
      }
      if (message.t === RELAY_MSG.PUSH_REGISTER) registrations.push(message.deviceId);
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
  connector.registerPushToken({ deviceId: 'd_reconnect', provider: 'expo', token: 'ExponentPushToken[rrrrrrrr]' });
  connector.start();
  try {
    const deadline = Date.now() + 8000;
    while (!(connections >= 2 && registrations.length >= 2) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(connections >= 2, `应至少重连一次（connections=${connections}）`);
    assert.ok(helloHosts.length >= 2, '重连后应再次发送 host.hello');
    assert.ok(registrations.length >= 2, '重连后应重新发送 push.register');
    assert.equal(helloHosts[0], 'h_reconnect');
  } finally {
    connector.stop();
    await new Promise((resolve) => wss.close(resolve));
  }
});
