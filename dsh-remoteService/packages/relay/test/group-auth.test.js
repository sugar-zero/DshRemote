/**
 * 群体服务版（A 模式）P1 切片 3：设备短时 token + 边缘会话鉴权。
 *
 * 覆盖：注册响应下发 relay token 公钥、device.sync/device.revoke、challenge → token 流程、
 * 边缘 cookie 校验（无/篡改/过期/跨主机/撤销设备全部 401）、challenge 重放/未知设备、
 * 每 IP 限速、以及 GroupAuthService 的时钟注入单元测试（challenge 过期 / token 过期 / 限速）。
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import {
  FRAME_TYPE,
  GROUP_AUTH_CHALLENGE_PATH,
  GROUP_AUTH_TOKEN_PATH,
  GROUP_SESSION_COOKIE,
  RELAY_MSG,
  decodeFrame,
  encodeFrame,
  groupDeviceChallengeMessage,
  newGroupDeviceId,
  signGroupSessionToken,
  verifyGroupSessionToken,
} from 'dsh-remote-protocol';
import {
  GroupAuthError,
  GroupAuthService,
  createInvite,
  createRelay,
} from '../index.js';
import { ControlClient } from './helpers/control-client.js';
import { generateSelfSignedCert, silentLogger } from './helpers/certs.js';

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-relay-auth-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 生成一台设备：P-256 私钥 + 未压缩点公钥（base64url）。 */
function makeDevice(deviceId = newGroupDeviceId()) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const publicKeyRaw = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]).toString('base64url');
  return { deviceId, privateKey, publicKeyRaw };
}

/**
 * 起一个带边缘 TLS + 会话鉴权的 group relay（dev 证书 + 临时 group.json）。
 * @param {{group?: Record<string, any>, relay?: Record<string, any>}} [overrides]
 */
async function startAuthRelay(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-relay-auth-'));
  const cert = generateSelfSignedCert({ commonName: '*.relay.test', sans: ['relay.test', '*.relay.test', 'other.test'] });
  const file = join(dir, 'group.json');
  const groupOverrides = { ...(overrides.group ?? {}) };
  const edgeOverrides = groupOverrides.edge ?? {};
  const authOverrides = groupOverrides.auth ?? {};
  delete groupOverrides.edge;
  delete groupOverrides.auth;
  const group = {
    file,
    mobilePort: 11443,
    maxHosts: 50,
    registration: {
      enabled: true,
      maxAttemptsPerMinutePerIp: 50,
      maxAttemptsPerMinute: 500,
      bodyLimitBytes: 8192,
    },
    edge: {
      enabled: true,
      port: 0,
      tls: { cert: cert.cert, key: cert.key },
      allowUnauthenticated: false,
      ...edgeOverrides,
    },
    auth: {
      tokenTtlMs: 15 * 60 * 1000,
      challengeTtlMs: 2 * 60 * 1000,
      maxAttemptsPerMinutePerIp: 50,
      ...authOverrides,
    },
    ...groupOverrides,
  };
  const relay = await createRelay({
    domain: 'relay.test',
    dataPort: 0,
    controlPort: 0,
    httpPort: 0,
    dataHost: '127.0.0.1',
    dev: true,
    logger: silentLogger,
    mode: 'group',
    group,
    handshakeTimeoutMs: 3000,
    heartbeatIntervalMs: 50,
    heartbeatTimeoutMs: 1000,
    openTimeoutMs: 3000,
    ...(overrides.relay ?? {}),
  });
  return {
    relay,
    file,
    cert,
    async cleanup() {
      await relay.close();
      cert.cleanup();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 通过控制面 HTTP 调注册接口（dev 模式控制面是 http）。 */
function postRegister(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/__group/register',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = JSON.parse(raw);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, json, raw });
        });
      },
    );
    req.setTimeout(3000, () => req.destroy(new Error('registration request timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

/** 边缘 TLS 上发一个完整 HTTP 请求，返回状态/响应头/文本。 */
function tlsHttpRequest({ port, servername, ca, method = 'GET', path = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, servername, ca, rejectUnauthorized: true }, () => {
      const bodyBuffer = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8');
      const lines = [`${method} ${path} HTTP/1.1`, `Host: ${servername}`];
      for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
      if (bodyBuffer.length > 0) lines.push(`content-length: ${bodyBuffer.length}`);
      lines.push('connection: close');
      socket.write(Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'utf8'), bodyBuffer]));
    });
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const split = raw.indexOf('\r\n\r\n');
      const headText = split >= 0 ? raw.slice(0, split) : raw;
      const bodyText = split >= 0 ? raw.slice(split + 4) : '';
      const status = Number((/^HTTP\/1\.1 (\d{3})/.exec(headText) ?? [])[1] ?? 0);
      /** @type {Record<string, string>} */
      const responseHeaders = {};
      for (const line of headText.split('\r\n').slice(1)) {
        const idx = line.indexOf(':');
        if (idx > 0) responseHeaders[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
      let json;
      try {
        json = JSON.parse(bodyText);
      } catch {
        json = undefined;
      }
      resolve({ status, headers: responseHeaders, text: bodyText, raw, json });
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out waiting for TLS HTTP response'));
    }, 5000);
    timer.unref?.();
    socket.once('close', () => clearTimeout(timer));
  });
}

/** 假主机：连接控制面、同步设备列表、回显隧道 DATA。 */
async function startDeviceHost({ relay, hostId, token, devices }) {
  const client = await ControlClient.connect(`ws://127.0.0.1:${relay.controlPort}/control`);
  client.sendJson({ t: RELAY_MSG.HOST_HELLO, protocolVersion: 1, hostId, token, hostName: 'Auth Host' });
  const ready = await client.nextJson();
  assert.equal(ready.t, RELAY_MSG.HOST_READY);

  let stopped = false;
  /** @type {Map<string, any[]>} */
  const inbox = new Map();
  /** @type {Map<string, Array<{resolve: Function, timer: NodeJS.Timeout}>>} */
  const waiters = new Map();
  const deliver = (msg) => {
    const pendingWaiters = waiters.get(msg.t) ?? [];
    const waiter = pendingWaiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
      return;
    }
    const queue = inbox.get(msg.t) ?? [];
    queue.push(msg);
    inbox.set(msg.t, queue);
  };
  const waitJson = (type, timeoutMs = 3000) => {
    const queue = inbox.get(type) ?? [];
    const ready = queue.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          const list = waiters.get(type) ?? [];
          const index = list.indexOf(waiter);
          if (index >= 0) list.splice(index, 1);
          reject(new Error(`timed out waiting for ${type}`));
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      const list = waiters.get(type) ?? [];
      list.push(waiter);
      waiters.set(type, list);
    });
  };

  const loop = (async () => {
    while (!stopped) {
      const item = await client.nextRaw(2000);
      if (!item) break;
      if (item.isBinary) {
        const frame = decodeFrame(item.data);
        if (frame && frame.type === FRAME_TYPE.DATA) {
          client.ws.send(encodeFrame(FRAME_TYPE.DATA, frame.streamId, frame.payload), { binary: true });
        }
        continue;
      }
      const msg = JSON.parse(item.data.toString('utf8'));
      if (msg.t === RELAY_MSG.HOST_OPEN) client.sendJson({ t: RELAY_MSG.HOST_OPENED, streamId: msg.streamId });
      deliver(msg);
    }
  })();
  const heartbeat = setInterval(() => {
    if (!stopped) client.sendJson({ t: RELAY_MSG.HOST_HEARTBEAT, ts: Date.now() });
  }, 20);
  heartbeat.unref?.();

  if (devices && devices.length > 0) {
    client.sendJson({
      t: RELAY_MSG.DEVICE_SYNC,
      devices: devices.map((device) => ({ deviceId: device.deviceId, publicKey: device.publicKeyRaw })),
    });
    const synced = await waitJson(RELAY_MSG.DEVICE_SYNCED);
    assert.equal(synced.ok, true);
    assert.equal(synced.count, devices.length);
  }

  return {
    client,
    loop,
    /** 撤销设备并等待 relay 确认。 */
    async revoke(deviceId) {
      client.sendJson({ t: RELAY_MSG.DEVICE_REVOKE, deviceId });
      return waitJson(RELAY_MSG.DEVICE_REVOKED);
    },
    stop() {
      stopped = true;
      clearInterval(heartbeat);
      client.close();
    },
  };
}

/** 走完 challenge → token：返回 token/expiresAt/set-cookie。 */
async function authenticate({ relay, cert, hostId, device }) {
  const challenge = await tlsHttpRequest({
    port: relay.edgePort,
    servername: `${hostId}.relay.test`,
    ca: cert.cert,
    method: 'POST',
    path: GROUP_AUTH_CHALLENGE_PATH,
    headers: { 'content-type': 'application/json' },
    body: { deviceId: device.deviceId },
  });
  assert.equal(challenge.status, 200, challenge.raw);
  assert.equal(challenge.json.ok, true);
  const { nonce, expiresAt } = challenge.json;
  const signature = nodeSign('sha256', groupDeviceChallengeMessage(hostId, device.deviceId, nonce), device.privateKey).toString('base64url');
  return tlsHttpRequest({
    port: relay.edgePort,
    servername: `${hostId}.relay.test`,
    ca: cert.cert,
    method: 'POST',
    path: GROUP_AUTH_TOKEN_PATH,
    headers: { 'content-type': 'application/json' },
    body: { deviceId: device.deviceId, nonce, signature },
  }).then((response) => ({ response, challengeExpiresAt: expiresAt }));
}

/** 带会话 cookie 访问业务路径，读回主机回显的字节。 */
function edgeSessionProbe({ relay, cert, hostId, token, extraHead = '' }) {
  const request = Buffer.from(
    `GET /probe HTTP/1.1\r\nHost: ${hostId}.relay.test\r\nCookie: ${GROUP_SESSION_COOKIE}=${token}\r\n${extraHead}Connection: close\r\n\r\n`,
    'utf8',
  );
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: '127.0.0.1', port: relay.edgePort, servername: `${hostId}.relay.test`, ca: cert.cert, rejectUnauthorized: true },
      () => socket.write(request),
    );
    const chunks = [];
    let received = 0;
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      received += chunk.length;
      if (received >= request.length) {
        socket.end();
        resolve({ request, echo: Buffer.concat(chunks).subarray(0, request.length) });
      }
    });
    socket.on('error', reject);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out waiting for session probe echo'));
    }, 5000);
    timer.unref?.();
    socket.once('close', () => clearTimeout(timer));
  });
}

test('设备 challenge → 短时 token → 边缘 cookie 会话通过（主机可离线复验 token）', async () => {
  const context = await startAuthRelay();
  let host;
  try {
    const invite = createInvite(context.file, {});
    const registration = await postRegister(context.relay.controlPort, { inviteCode: invite.code, hostName: 'Auth Host' });
    assert.equal(registration.status, 200, registration.raw);
    assert.equal(typeof registration.json.tokenPublicKey, 'string', 'registration must deliver the relay token public key');
    assert.match(registration.json.tokenPublicKey, /BEGIN PUBLIC KEY/);

    const device = makeDevice();
    host = await startDeviceHost({
      relay: context.relay,
      hostId: registration.json.hostId,
      token: registration.json.hostToken,
      devices: [device],
    });

    const { response: tokenResponse } = await authenticate({
      relay: context.relay,
      cert: context.cert,
      hostId: registration.json.hostId,
      device,
    });
    assert.equal(tokenResponse.status, 200, tokenResponse.raw);
    assert.equal(tokenResponse.json.ok, true);
    assert.equal(tokenResponse.json.deviceId, device.deviceId);
    const token = tokenResponse.json.token;
    assert.match(token, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const setCookie = tokenResponse.headers['set-cookie'] ?? '';
    assert.match(setCookie, new RegExp(`^${GROUP_SESSION_COOKIE}=`));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\//);

    // 主机侧逐请求复验：用注册下发的公钥离线校验（无需回连 relay）。
    const verified = verifyGroupSessionToken({
      token,
      publicKey: registration.json.tokenPublicKey,
      hostId: registration.json.hostId,
    });
    assert.equal(verified?.deviceId, device.deviceId);

    const probe = await edgeSessionProbe({
      relay: context.relay,
      cert: context.cert,
      hostId: registration.json.hostId,
      token,
    });
    assert.equal(Buffer.compare(probe.echo, probe.request), 0, 'authenticated request must be forwarded through the tunnel unchanged');
  } finally {
    host?.stop();
    await context.cleanup();
  }
});

test('边缘鉴权拒绝：无 cookie / 篡改 / 过期 / 跨主机 / 设备撤销', async () => {
  const context = await startAuthRelay();
  let host;
  try {
    const invite = createInvite(context.file, {});
    const registration = await postRegister(context.relay.controlPort, { inviteCode: invite.code, hostName: 'Auth Host' });
    const hostId = registration.json.hostId;
    const device = makeDevice();
    host = await startDeviceHost({ relay: context.relay, hostId, token: registration.json.hostToken, devices: [device] });

    // 无 cookie → 401
    const noCookie = await tlsHttpRequest({
      port: context.relay.edgePort,
      servername: `${hostId}.relay.test`,
      ca: context.cert.cert,
      method: 'GET',
      path: '/',
    });
    assert.equal(noCookie.status, 401);

    const { response: tokenResponse } = await authenticate({ relay: context.relay, cert: context.cert, hostId, device });
    assert.equal(tokenResponse.status, 200, tokenResponse.raw);
    const token = tokenResponse.json.token;

    // 篡改 token → 401
    const tampered = `${token.slice(0, -3)}abc`;
    const tamperedResponse = await tlsHttpRequest({
      port: context.relay.edgePort,
      servername: `${hostId}.relay.test`,
      ca: context.cert.cert,
      method: 'GET',
      path: '/',
      headers: { cookie: `${GROUP_SESSION_COOKIE}=${tampered}` },
    });
    assert.equal(tamperedResponse.status, 401);

    // 过期 token（用 relay 私钥签一个已过期的；签名有效但 exp 已过）→ 401
    const signingKeyPem = readFileSync(join(dirname(context.file), 'signing-key.pem'), 'utf8');
    const expired = signGroupSessionToken({
      privateKey: signingKeyPem,
      hostId,
      deviceId: device.deviceId,
      iat: Date.now() - 120_000,
      ttlMs: 30_000,
    });
    const expiredResponse = await tlsHttpRequest({
      port: context.relay.edgePort,
      servername: `${hostId}.relay.test`,
      ca: context.cert.cert,
      method: 'GET',
      path: '/',
      headers: { cookie: `${GROUP_SESSION_COOKIE}=${expired.token}` },
    });
    assert.equal(expiredResponse.status, 401);

    // 跨主机 token → 401
    const crossHost = signGroupSessionToken({
      privateKey: signingKeyPem,
      hostId: 'h_other1234',
      deviceId: device.deviceId,
      ttlMs: 60_000,
    });
    const crossResponse = await tlsHttpRequest({
      port: context.relay.edgePort,
      servername: `${hostId}.relay.test`,
      ca: context.cert.cert,
      method: 'GET',
      path: '/',
      headers: { cookie: `${GROUP_SESSION_COOKIE}=${crossHost.token}` },
    });
    assert.equal(crossResponse.status, 401);

    // 撤销设备后：原 token 立即 401，challenge 也拒绝（404）
    const revoked = await host.revoke(device.deviceId);
    assert.equal(revoked.ok, true);
    const afterRevoke = await tlsHttpRequest({
      port: context.relay.edgePort,
      servername: `${hostId}.relay.test`,
      ca: context.cert.cert,
      method: 'GET',
      path: '/',
      headers: { cookie: `${GROUP_SESSION_COOKIE}=${token}` },
    });
    assert.equal(afterRevoke.status, 401);

    const challengeAfterRevoke = await tlsHttpRequest({
      port: context.relay.edgePort,
      servername: `${hostId}.relay.test`,
      ca: context.cert.cert,
      method: 'POST',
      path: GROUP_AUTH_CHALLENGE_PATH,
      headers: { 'content-type': 'application/json' },
      body: { deviceId: device.deviceId },
    });
    assert.equal(challengeAfterRevoke.status, 404);
  } finally {
    host?.stop();
    await context.cleanup();
  }
});

test('challenge 一次性 + 未知设备 + 每 IP 限速', async () => {
  const context = await startAuthRelay({ group: { auth: { maxAttemptsPerMinutePerIp: 3 } } });
  let host;
  try {
    const invite = createInvite(context.file, {});
    const registration = await postRegister(context.relay.controlPort, { inviteCode: invite.code, hostName: 'Auth Host' });
    const hostId = registration.json.hostId;
    const device = makeDevice();
    host = await startDeviceHost({ relay: context.relay, hostId, token: registration.json.hostToken, devices: [device] });

    // 未知设备 → 404（同时消耗 1 次尝试）
    const unknown = await tlsHttpRequest({
      port: context.relay.edgePort,
      servername: `${hostId}.relay.test`,
      ca: context.cert.cert,
      method: 'POST',
      path: GROUP_AUTH_CHALLENGE_PATH,
      headers: { 'content-type': 'application/json' },
      body: { deviceId: 'd_unknown0001' },
    });
    assert.equal(unknown.status, 404);

    // 第 2 次：正常 challenge（成功）
    const { response: tokenResponse } = await authenticate({ relay: context.relay, cert: context.cert, hostId, device });
    assert.equal(tokenResponse.status, 200, tokenResponse.raw);

    // 第 3 次：超过每 IP 限速 → 429 + retry-after
    const limited = await tlsHttpRequest({
      port: context.relay.edgePort,
      servername: `${hostId}.relay.test`,
      ca: context.cert.cert,
      method: 'POST',
      path: GROUP_AUTH_CHALLENGE_PATH,
      headers: { 'content-type': 'application/json' },
      body: { deviceId: device.deviceId },
    });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers['retry-after']) >= 1);
  } finally {
    host?.stop();
    await context.cleanup();
  }
});

test('GroupAuthService：challenge 过期/重放、token 过期、撤销与限速（注入时钟）', () => {
  const temp = tempDir();
  try {
    const file = join(temp.dir, 'group.json');
    let now = 1_700_000_000_000;
    const service = new GroupAuthService({
      groupFile: file,
      tokenTtlMs: 60_000,
      challengeTtlMs: 10_000,
      maxAttemptsPerMinutePerIp: 3,
      now: () => now,
      logger: silentLogger,
    });
    const hostId = 'h_unit1234';
    const device = makeDevice();
    assert.equal(service.syncDevices(hostId, [{ deviceId: device.deviceId, publicKey: device.publicKeyRaw }]), 1);
    assert.equal(service.hasDevice(hostId, device.deviceId), true);

    const challenge = service.challenge({ hostId, deviceId: device.deviceId, clientKey: '10.0.0.1' });
    const message = groupDeviceChallengeMessage(hostId, device.deviceId, challenge.nonce);
    const signature = nodeSign('sha256', message, device.privateKey).toString('base64url');
    const issued = service.issueToken({ hostId, deviceId: device.deviceId, nonce: challenge.nonce, signature, clientKey: '10.0.0.1' });
    assert.equal(service.verifySessionToken(issued.token, hostId)?.deviceId, device.deviceId);
    assert.equal(service.verifySessionToken(issued.token, 'h_other1234'), undefined, 'token must be host-bound');

    // challenge 重放 → auth_failed
    assert.throws(
      () => service.issueToken({ hostId, deviceId: device.deviceId, nonce: challenge.nonce, signature, clientKey: '10.0.0.1' }),
      (err) => err instanceof GroupAuthError && err.code === 'auth_failed',
    );

    // token 过期
    now += 61_000;
    assert.equal(service.verifySessionToken(issued.token, hostId), undefined);

    // challenge 过期
    const stale = service.challenge({ hostId, deviceId: device.deviceId, clientKey: '10.0.0.2' });
    const staleSig = nodeSign('sha256', groupDeviceChallengeMessage(hostId, device.deviceId, stale.nonce), device.privateKey).toString('base64url');
    now += 11_000;
    assert.throws(
      () => service.issueToken({ hostId, deviceId: device.deviceId, nonce: stale.nonce, signature: staleSig, clientKey: '10.0.0.2' }),
      (err) => err instanceof GroupAuthError && err.code === 'auth_failed',
    );

    // 限速：同一 IP 第 4 次 → rate_limited（前 3 次即使设备未知也在限速窗口内计数）
    now += 120_000;
    for (let i = 0; i < 3; i += 1) {
      try {
        service.challenge({ hostId, deviceId: 'd_unknown0001', clientKey: '10.0.0.3' });
      } catch (err) {
        assert.ok(err instanceof GroupAuthError && err.code === 'unknown_device');
      }
    }
    assert.throws(
      () => service.challenge({ hostId, deviceId: device.deviceId, clientKey: '10.0.0.3' }),
      (err) => err instanceof GroupAuthError && err.code === 'rate_limited',
    );

    // 撤销设备 + clearHost
    assert.equal(service.revokeDevice(hostId, device.deviceId), true);
    assert.equal(service.hasDevice(hostId, device.deviceId), false);
    service.clearHost(hostId);
    assert.equal(service.devices.has(hostId), false);
  } finally {
    temp.cleanup();
  }
});

test('classic 模式：host 发 device.sync 得到 group_auth_unavailable', async () => {
  const relay = await createRelay({
    domain: 'relay.test',
    dataPort: 0,
    controlPort: 0,
    httpPort: 0,
    dataHost: '127.0.0.1',
    dev: true,
    logger: silentLogger,
    hostTokens: { h_classic01: 'classic-token' },
  });
  let client;
  try {
    client = await ControlClient.connect(`ws://127.0.0.1:${relay.controlPort}/control`);
    client.sendJson({ t: RELAY_MSG.HOST_HELLO, protocolVersion: 1, hostId: 'h_classic01', token: 'classic-token', hostName: 'Classic' });
    assert.equal((await client.nextJson()).t, RELAY_MSG.HOST_READY);
    client.sendJson({ t: RELAY_MSG.DEVICE_SYNC, devices: [] });
    const response = await client.nextJson();
    assert.equal(response.t, RELAY_MSG.DEVICE_SYNCED);
    assert.equal(response.ok, false);
    assert.equal(response.code, 'group_auth_unavailable');
  } finally {
    client?.close();
    await relay.close();
  }
});

test('group auth: 同一设备并发 challenge 不互相覆盖（先发的 nonce 仍可换 token）', () => {
  const temp = tempDir();
  try {
    const service = new GroupAuthService({
      groupFile: join(temp.dir, 'group.json'),
      signingKeyFile: join(temp.dir, 'signing-key.pem'),
    });
    const hostId = 'h_testdevice';
    const device = makeDevice();
    service.syncDevices(hostId, [{ deviceId: device.deviceId, publicKey: device.publicKeyRaw }]);

    const first = service.challenge({ hostId, deviceId: device.deviceId, clientKey: '127.0.0.1' });
    const second = service.challenge({ hostId, deviceId: device.deviceId, clientKey: '127.0.0.1' });
    assert.notEqual(first.nonce, second.nonce);

    const signature = nodeSign(
      'sha256',
      groupDeviceChallengeMessage(hostId, device.deviceId, first.nonce),
      device.privateKey,
    ).toString('base64url');
    const issued = service.issueToken({
      hostId,
      deviceId: device.deviceId,
      nonce: first.nonce,
      signature,
      clientKey: '127.0.0.1',
    });
    assert.match(issued.token, /^v1\./);
  } finally {
    temp.cleanup();
  }
});
