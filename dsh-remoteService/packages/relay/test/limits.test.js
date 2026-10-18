import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRelay } from '../index.js';

test('relay data plane: per-IP connection limit closes excess sockets', async () => {
  const relay = await createRelay({
    domain: 'relay.test',
    dataPort: 0,
    controlPort: 0,
    httpPort: 0,
    dev: true,
    dataHost: '127.0.0.1',
    hostTokens: {},
    logLevel: 'silent',
    limits: { maxConnectionsPerIp: 2, maxDataConnections: 10 },
  });
  const sockets = [];
  try {
    const connect = () => new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: relay.dataPort });
      const state = { socket, closed: false };
      socket.on('close', () => { state.closed = true; });
      socket.on('error', () => {});
      socket.on('connect', () => resolve(state));
    });
    sockets.push(await connect());
    sockets.push(await connect());
    // 前两条连接已占满配额；第三条应被立即关闭。
    const third = await connect();
    sockets.push(third);
    const deadline = Date.now() + 2000;
    while (!third.closed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(third.closed, true, '第三条连接应被 limit 关闭');
    assert.equal(sockets[0].closed, false);
    assert.equal(sockets[1].closed, false);
  } finally {
    for (const state of sockets) state.socket.destroy();
    await relay.close();
  }
});
