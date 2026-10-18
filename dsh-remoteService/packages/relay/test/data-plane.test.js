import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import tls from 'node:tls';
import { WebSocket } from 'ws';
import { FRAME_TYPE, decodeFrame, encodeFrame } from 'dsh-remote-protocol';
import { createRelay } from '../index.js';
import { captureClientHello, generateSelfSignedCert, silentLogger } from './helpers/certs.js';

/** @param {import('node:net').Server} server */
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(/** @type {import('node:net').AddressInfo} */ (server.address()).port));
  });
}

/** @param {import('node:net').Server | import('node:tls').Server} server */
function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

/**
 * 本地 TLS 目标服务（模拟主机插件背后的 DSH webServer）。
 * 收到完整 HTTP 请求头后返回固定响应并关闭连接。
 * @param {{key: Buffer, cert: Buffer}} credentials
 */
async function startTlsTarget(credentials) {
  const seenServernames = [];
  const server = tls.createServer({ key: credentials.key, cert: credentials.cert }, (socket) => {
    seenServernames.push(socket.servername ?? null);
    let request = Buffer.alloc(0);
    const onData = (chunk) => {
      request = Buffer.concat([request, chunk]);
      if (request.includes('\r\n\r\n')) {
        socket.removeListener('data', onData);
        const body = 'relay-pong';
        socket.end(
          `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
        );
      }
    };
    socket.on('data', onData);
    socket.on('error', () => {});
  });
  const port = await listen(server);
  return { server, port, seenServernames, close: () => closeServer(server) };
}

/**
 * 假 host：连控制面 → host.hello；收到 host.open 后拨本地 TLS 目标并双向 pipe 二进制帧。
 * @param {{controlPort: number, targetPort: number, hostId?: string, token?: string, protocolVersion?: number}} options
 */
async function openFakeHost({ controlPort, targetPort, hostId = 'poc', token = 'test-token', protocolVersion = 1 }) {
  const ws = new WebSocket(`ws://127.0.0.1:${controlPort}/control`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const state = {
    ws,
    ready: null,
    hostOpens: [],
    openedCount: 0,
    closeFrames: 0,
    targetErrors: 0,
    targets: new Map(),
    /** @type {Array<(msg: any) => void>} */ waiters: [],
    sendJson(message) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    },
    close() {
      for (const target of state.targets.values()) {
        try {
          target.destroy();
        } catch {
          /* ignore */
        }
      }
      state.targets.clear();
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    },
  };

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const frame = decodeFrame(data);
      if (!frame) return;
      const target = state.targets.get(frame.streamId);
      if (!target) return;
      if (frame.type === FRAME_TYPE.DATA) target.write(frame.payload);
      else if (frame.type === FRAME_TYPE.CLOSE) {
        state.closeFrames += 1;
        target.end();
      }
      return;
    }

    let message;
    try {
      message = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (message.t === 'host.ready') {
      state.ready = message;
      for (const waiter of state.waiters.splice(0)) waiter(message);
      return;
    }
    if (message.t === 'host.open') {
      state.hostOpens.push(message);
      const target = net.connect({ host: '127.0.0.1', port: targetPort });
      state.targets.set(message.streamId, target);
      target.on('error', () => {
        state.targetErrors += 1;
      });
      target.on('connect', () => {
        state.openedCount += 1;
        state.sendJson({ t: 'host.opened', streamId: message.streamId });
      });
      target.on('data', (chunk) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(encodeFrame(FRAME_TYPE.DATA, message.streamId, chunk));
        } catch {
          /* ignore */
        }
      });
      target.on('close', () => {
        state.targets.delete(message.streamId);
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(encodeFrame(FRAME_TYPE.CLOSE, message.streamId));
        } catch {
          /* ignore */
        }
      });
      return;
    }
    if (message.t === 'host.heartbeat') {
      state.sendJson({ t: 'host.heartbeat' });
    }
  });

  const readyPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for host.ready')), 5000);
    state.waiters.push((message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });

  state.sendJson({ t: 'host.hello', protocolVersion, hostId, token, hostName: 'Fake Host' });
  await readyPromise;
  return state;
}

/** @param {() => boolean | Promise<boolean>} predicate */
async function waitFor(predicate, timeoutMs = 3000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/**
 * 用 Node 自带 TLS 客户端完成一次 HTTP/1.1 请求（校验透传与证书校验）。
 * @param {{port: number, servername: string, ca: Buffer | Buffer[], path?: string}} options
 * @returns {Promise<string>} 原始响应文本
 */
function httpsGet({ port, servername, ca, path = '/ping' }) {
  return new Promise((resolve, reject) => {
    const client = tls.connect({ host: '127.0.0.1', port, servername, ca });
    let response = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      client.destroy();
      finish(reject, new Error('timed out waiting for HTTPS response through relay'));
    }, 10_000);
    timer.unref?.();

    client.on('secureConnect', () => {
      client.write(`GET ${path} HTTP/1.1\r\nHost: ${servername}\r\nConnection: close\r\n\r\n`);
    });
    client.on('data', (chunk) => {
      response += chunk.toString('latin1');
    });
    client.on('end', () => finish(resolve, response));
    client.on('close', () => {
      if (response !== '') finish(resolve, response);
    });
    client.on('error', (err) => finish(reject, err));
  });
}

/**
 * 原始 TCP 写入一段字节，期望 relay 很快断开且不回任何数据。
 * @param {number} port
 * @param {Buffer} payload
 */
function expectConnectionDestroyed(port, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(true);
    };
    const timer = setTimeout(() => finish(new Error('relay did not destroy the connection in time')), 3000);
    timer.unref?.();
    socket.on('connect', () => socket.write(payload));
    socket.on('data', () => finish(new Error('unexpected bytes from relay for a rejected connection')));
    socket.on('close', () => finish());
    socket.on('error', () => finish());
  });
}

/** @param {Record<string, any>} [overrides] */
function relayOptions(overrides = {}) {
  return {
    domain: 'relay.test',
    dataPort: 0,
    controlPort: 0,
    httpPort: 0,
    dataHost: '127.0.0.1',
    dev: true,
    hostTokens: { poc: 'test-token' },
    logger: silentLogger,
    ...overrides,
  };
}

test('end-to-end: TLS passthrough with SNI routing, stream framing and response', async () => {
  const credentials = generateSelfSignedCert({ commonName: 'poc.relay.test', sans: ['poc.relay.test'] });
  const target = await startTlsTarget(credentials);
  const relay = await createRelay(relayOptions());
  let fakeHost;
  try {
    fakeHost = await openFakeHost({ controlPort: relay.controlPort, targetPort: target.port });
    assert.equal(fakeHost.ready.hostname, 'poc.relay.test');
    assert.equal(fakeHost.ready.domain, 'relay.test');
    assert.equal(fakeHost.ready.dataPort, relay.dataPort);
    assert.deepEqual(relay.onlineHostIds(), ['poc']);

    const response = await httpsGet({
      port: relay.dataPort,
      servername: 'poc.relay.test',
      ca: credentials.cert,
    });

    assert.match(response, /^HTTP\/1\.1 200 OK/);
    assert.match(response, /relay-pong/);
    assert.deepEqual(target.seenServernames, ['poc.relay.test'], 'target TLS server sees the original SNI');
    assert.ok(fakeHost.openedCount >= 1, 'host received host.open and replied host.opened');
    assert.ok(fakeHost.hostOpens.length >= 1);
  } finally {
    try {
      fakeHost?.close();
    } catch {
      /* ignore */
    }
    await relay.close();
    await target.close();
    credentials.cleanup();
  }
});

test('app-initiated close sends a binary CLOSE frame to the host', async () => {
  const credentials = generateSelfSignedCert({ commonName: 'poc.relay.test', sans: ['poc.relay.test'] });
  const target = await startTlsTarget(credentials);
  const relay = await createRelay(relayOptions());
  let fakeHost;
  try {
    fakeHost = await openFakeHost({ controlPort: relay.controlPort, targetPort: target.port });

    const client = tls.connect({
      host: '127.0.0.1',
      port: relay.dataPort,
      servername: 'poc.relay.test',
      ca: credentials.cert,
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for TLS handshake through relay')), 10_000);
      timer.unref?.();
      client.once('secureConnect', () => {
        clearTimeout(timer);
        resolve(undefined);
      });
      client.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    assert.ok(fakeHost.hostOpens.length >= 1, 'host.open reached the fake host');
    client.destroy();
    assert.ok(await waitFor(() => fakeHost.closeFrames >= 1), 'relay sent a binary CLOSE frame to the host');
  } finally {
    try {
      fakeHost?.close();
    } catch {
      /* ignore */
    }
    await relay.close();
    await target.close();
    credentials.cleanup();
  }
});

test('relay destroys app connections whose SNI is unknown, absent, wrong-domain or not TLS', async () => {
  const relay = await createRelay(relayOptions());
  try {
    // SNI 合法但对应 host 未在线
    const onlineHostTlsFailure = await new Promise((resolve) => {
      const client = tls.connect({
        host: '127.0.0.1',
        port: relay.dataPort,
        servername: 'poc.relay.test',
        rejectUnauthorized: false,
      });
      client.on('error', (err) => resolve(err));
      client.on('secureConnect', () => resolve(new Error('unexpected TLS handshake success')));
      client.on('close', () => resolve(new Error('client closed')));
      setTimeout(() => resolve(new Error('timed out')), 3000).unref?.();
    });
    assert.ok(onlineHostTlsFailure instanceof Error);
    assert.notEqual(onlineHostTlsFailure.message, 'unexpected TLS handshake success');

    // 未知 hostId（DNS 泛解析会落到 relay，但没有对应 host）
    await expectConnectionDestroyed(relay.dataPort, await captureClientHello({ servername: 'unknown.relay.test' }));
    // 域名后缀不匹配
    await expectConnectionDestroyed(relay.dataPort, await captureClientHello({ servername: 'poc.example.com' }));
    // 完全没有 SNI
    await expectConnectionDestroyed(relay.dataPort, await captureClientHello({ servername: undefined }));
    // 非 TLS 字节
    await expectConnectionDestroyed(relay.dataPort, Buffer.from('GET / HTTP/1.1\r\nHost: relay.test\r\n\r\n'));
  } finally {
    await relay.close();
  }
});

test('host disconnect destroys in-flight app connections', async () => {
  const credentials = generateSelfSignedCert({ commonName: 'poc.relay.test', sans: ['poc.relay.test'] });
  const target = await startTlsTarget(credentials);
  const relay = await createRelay(relayOptions());
  let fakeHost;
  try {
    fakeHost = await openFakeHost({ controlPort: relay.controlPort, targetPort: target.port });

    const client = tls.connect({
      host: '127.0.0.1',
      port: relay.dataPort,
      servername: 'poc.relay.test',
      ca: credentials.cert,
    });
    /** @type {Promise<{kind: string, message?: string}>} */
    const clientFailure = new Promise((resolve) => {
      client.on('secureConnect', () => resolve({ kind: 'connected' }));
      client.on('error', (err) => resolve({ kind: 'error', message: err.message }));
      client.on('close', () => resolve({ kind: 'closed' }));
    });
    assert.equal((await clientFailure).kind, 'connected');
    assert.ok(fakeHost.hostOpens.length >= 1);

    const closed = new Promise((resolve) => {
      client.on('error', () => resolve(true));
      client.on('close', () => resolve(true));
    });
    fakeHost.ws.terminate();
    assert.equal(await closed, true, 'app socket is destroyed when its host disappears');
    assert.deepEqual(relay.onlineHostIds(), []);
  } finally {
    try {
      fakeHost?.close();
    } catch {
      /* ignore */
    }
    await relay.close();
    await target.close();
    credentials.cleanup();
  }
});

test('multiple concurrent streams are multiplexed with distinct streamIds', async () => {
  const credentials = generateSelfSignedCert({ commonName: 'poc.relay.test', sans: ['poc.relay.test'] });
  const target = await startTlsTarget(credentials);
  const relay = await createRelay(relayOptions());
  let fakeHost;
  try {
    fakeHost = await openFakeHost({ controlPort: relay.controlPort, targetPort: target.port });
    const responses = await Promise.all([
      httpsGet({ port: relay.dataPort, servername: 'poc.relay.test', ca: credentials.cert }),
      httpsGet({ port: relay.dataPort, servername: 'poc.relay.test', ca: credentials.cert }),
    ]);
    for (const response of responses) {
      assert.match(response, /^HTTP\/1\.1 200 OK/);
      assert.match(response, /relay-pong/);
    }
    const streamIds = fakeHost.hostOpens.map((msg) => msg.streamId);
    assert.equal(new Set(streamIds).size, streamIds.length, 'streamIds are unique');
    assert.equal(target.seenServernames.length, 2);
  } finally {
    try {
      fakeHost?.close();
    } catch {
      /* ignore */
    }
    await relay.close();
    await target.close();
    credentials.cleanup();
  }
});
