import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { RELAY_MSG, FRAME_TYPE, decodeFrame } from 'dsh-remote-protocol';

/**
 * 回归测试：主机→relay 方向的二进制帧必须**严格保序**。
 *
 * 旧实现在 ws.bufferedAmount > 2MiB 时把当前帧 setTimeout 延后重发，
 * 更晚的帧可能先出去 → 隧道里的 TLS 字节流乱序 → 大会话历史（数 MB）
 * 直接把连接搞坏。这里用一个模拟「慢速 WSS」的假 ws 强制触发背压，
 * 断言 DATA 帧拼接后的字节与源数据完全一致、CLOSE 帧在所有 DATA 之后。
 */

function waitFor(predicate, timeoutMs = 6000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        const result = predicate();
        if (result) { resolve(result); return; }
      } catch (error) { reject(error); return; }
      if (Date.now() - start > timeoutMs) { reject(new Error('timeout')); return; }
      setTimeout(tick, 5);
    };
    tick();
  });
}

test('relay connector: 慢速 WSS 背压下 DATA/CLOSE 帧严格保序', async () => {
  let sourceSocket;
  const source = net.createServer((socket) => {
    sourceSocket = socket;
    socket.on('error', () => {});
  });
  await new Promise((resolve) => source.listen(0, '127.0.0.1', resolve));
  const sourcePort = source.address().port;

  const relayMessages = [];
  let relaySocket;
  const httpServer = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ server: httpServer, path: '/control' });
  wss.on('connection', (ws) => {
    relaySocket = ws;
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString());
      relayMessages.push(msg);
      if (msg.t === RELAY_MSG.HOST_HELLO) {
        ws.send(JSON.stringify({ t: RELAY_MSG.HOST_READY, protocolVersion: 1, hostId: 'h_test', hostname: 'h_test.relay.test', domain: 'relay.test' }));
      }
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
    getLocalPort: () => sourcePort,
    audit: { append() {} },
  });
  connector.start();

  try {
    await waitFor(() => relayMessages.find((m) => m.t === RELAY_MSG.HOST_HELLO));
    relaySocket.send(JSON.stringify({ t: RELAY_MSG.HOST_OPEN, streamId: 7, sni: 'h_test.relay.test' }));
    await waitFor(() => relayMessages.find((m) => m.t === RELAY_MSG.HOST_OPENED && m.streamId === 7));
    assert.ok(sourceSocket, '本地 socket 应已连接');

    // —— 用一个「慢速 WSS」假 socket 替换真实 ws，强制对端读到 >2MiB 背压 ——
    /** @type {Buffer[]} 按发送顺序收集到的帧数据 */
    const sentFrames = [];
    let fakeBuffered = 0;
    const fakeWs = {
      readyState: 1,
      get bufferedAmount() { return fakeBuffered; },
      send(data, options, callback) {
        const cb = typeof options === 'function' ? options : callback;
        if (typeof data === 'string') { if (cb) setImmediate(cb); return; }
        const chunk = Buffer.from(data);
        sentFrames.push(chunk);
        fakeBuffered += chunk.length;
        if (cb) {
          // 模拟慢速链路：每个帧 2ms 后才真正「冲出去」
          setTimeout(() => {
            fakeBuffered = Math.max(0, fakeBuffered - chunk.length);
            cb(null);
          }, 2);
        }
      },
    };
    connector.ws = fakeWs;

    // 本地「plugin」一次写出 ~5MiB（分块，模拟大数据帧流）
    const chunkSize = 256 * 1024;
    const chunkCount = 20;
    const chunks = Array.from({ length: chunkCount }, (_, index) => {
      const buf = Buffer.alloc(chunkSize);
      buf.fill(index & 0xff);
      return buf;
    });
    const expected = Buffer.concat(chunks);
    for (const chunk of chunks) {
      sourceSocket.write(chunk);
      await new Promise((resolve) => setImmediate(resolve));
    }
    await waitFor(() => sentFrames.length >= 2, 6000);
    // 让发送队列排空
    await waitFor(() => connector.sendQueue.length === 0 && fakeBuffered === 0, 20000);

    const dataPayloads = [];
    const closers = [];
    for (const raw of sentFrames) {
      const frame = decodeFrame(raw);
      if (frame === null) continue;
      if (frame.type === FRAME_TYPE.DATA) dataPayloads.push(frame.payload);
      else if (frame.type === FRAME_TYPE.CLOSE) closers.push(frame);
    }
    const actual = Buffer.concat(dataPayloads);
    assert.equal(actual.length, expected.length, 'DATA 帧总字节数应与源一致（无丢帧）');
    assert.ok(actual.equals(expected), 'DATA 帧拼接字节应与源数据完全一致（无乱序/无污染）');
    assert.ok(sentFrames.length >= chunkCount / 4, '应确实经历多帧发送');

    // 断开源 socket（模拟对端关闭）→ 必须产生 CLOSE 帧，且在所有 DATA 之后
    sourceSocket.end();
    await waitFor(() => {
      for (const raw of sentFrames) {
        const frame = decodeFrame(raw);
        if (frame?.type === FRAME_TYPE.CLOSE) return true;
      }
      return false;
    }, 10000);
    const closeIndex = sentFrames.findIndex((raw) => decodeFrame(raw)?.type === FRAME_TYPE.CLOSE);
    assert.ok(closeIndex >= 0, '应发送 CLOSE 帧');
    const dataAfterClose = sentFrames.slice(closeIndex + 1).filter((raw) => decodeFrame(raw)?.type === FRAME_TYPE.DATA);
    assert.equal(dataAfterClose.length, 0, 'CLOSE 之后不应再有 DATA 帧');
  } finally {
    connector.stop();
    try { sourceSocket?.destroy(); } catch { /* ignore */ }
    try { relaySocket?.terminate(); } catch { /* ignore */ }
    for (const client of wss.clients) {
      try { client.terminate(); } catch { /* ignore */ }
    }
    await new Promise((resolve) => wss.close(() => resolve()));
    await new Promise((resolve) => httpServer.close(resolve));
    await new Promise((resolve) => source.close(resolve));
  }
});
