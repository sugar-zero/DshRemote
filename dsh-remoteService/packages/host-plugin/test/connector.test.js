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
