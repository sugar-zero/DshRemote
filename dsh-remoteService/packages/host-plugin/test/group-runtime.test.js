/**
 * 群体服务版（A 模式）主机侧运行时端到端：
 * 真实 relay（group + edge TLS + 会话鉴权）+ GroupHostRuntime（注册 / 配对 / 隧道 / loopback 明文代理）。
 *
 * 覆盖：邀请码注册落盘 0600、v2 配对二维码（端口 + auth=token）、通过 relay 边缘完成设备公钥配对、
 * 设备同步到 relay、challenge → token → 隧道 → 主机 loopback 代理、Host/SNI 不一致 421、
 * 无 cookie 边缘 401、设备撤销后 token 立即失效。
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import {
  GROUP_AUTH_CHALLENGE_PATH,
  GROUP_AUTH_TOKEN_PATH,
  GROUP_SESSION_COOKIE,
  PAIR_PATH,
  PAIR_AUTH_TOKEN,
  PUSH_TOKEN_PATH,
  STATUS_PATH,
  groupDeviceChallengeMessage,
  newGroupDeviceId,
  parseGroupPairingUri,
  signGroupSessionToken,
} from 'dsh-remote-protocol';
import { createInvite, createRelay } from '../../relay/index.js';
import { GroupHostRuntime, loadGroupRegistration, saveGroupRegistration } from '../lib/group.js';
import { DeviceStore } from '../lib/devices.js';
import { PairingManager } from '../lib/pairing.js';
import { loadOrCreateHostIdentity } from '../lib/identity.js';
import { paths } from '../lib/paths.js';
import { withTempHome } from './helpers.js';

const SILENT = { debug() {}, info() {}, warn() {}, error() {} };

/** 生成 `*.relay.test` 的自签证书（relay 边缘 TLS 用；客户端以它为信任锚）。 */
function makeWildcardCert() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-group-wildcard-'));
  const keyFile = join(dir, 'key.pem');
  const certFile = join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1',
    '-keyout', keyFile, '-out', certFile,
    '-subj', '/CN=*.relay.test',
    '-addext', 'subjectAltName=DNS:relay.test,DNS:*.relay.test',
  ], { stdio: 'pipe' });
  return {
    dir,
    key: readFileSync(keyFile),
    cert: readFileSync(certFile),
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 设备 P-256 密钥 + 未压缩点公钥（base64url）。 */
function makeDevice() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    label: newGroupDeviceId(),
    privateKey,
    publicKeyRaw: Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(jwk.x, 'base64url'),
      Buffer.from(jwk.y, 'base64url'),
    ]).toString('base64url'),
  };
}

/** 发原始请求字节，收集响应文本（直到连接关闭）。 */
function tlsRaw({ port, servername, ca, request, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, servername, ca, rejectUnauthorized: true }, () => socket.write(request));
    let text = '';
    socket.on('data', (chunk) => { text += chunk.toString('utf8'); });
    socket.on('error', reject);
    socket.on('close', () => resolve(text));
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out waiting for edge response; partial=${text.slice(0, 200)}`));
    }, timeoutMs);
    timer.unref?.();
    socket.once('close', () => clearTimeout(timer));
  });
}

/** 边缘 TLS 上的 JSON POST（pairing / challenge / token 用）。 */
function tlsJson({ port, servername, ca, path, body }) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const request = Buffer.concat([
    Buffer.from(
      `POST ${path} HTTP/1.1\r\nHost: ${servername}\r\ncontent-type: application/json\r\n`
      + `content-length: ${payload.length}\r\nconnection: close\r\n\r\n`,
      'utf8',
    ),
    payload,
  ]);
  return tlsRaw({ port, servername, ca, request }).then((text) => {
    const split = text.indexOf('\r\n\r\n');
    const head = split >= 0 ? text.slice(0, split) : text;
    const bodyText = split >= 0 ? text.slice(split + 4) : '';
    const status = Number((/^HTTP\/1\.1 (\d{3})/.exec(head) ?? [])[1] ?? 0);
    let json;
    try {
      json = JSON.parse(bodyText);
    } catch {
      json = undefined;
    }
    return { status, json, raw: text };
  });
}

async function waitFor(fn, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const end = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw lastError ?? new Error('waitFor timed out');
}

test('群体版主机：注册 → v2 配对 → 隧道 → loopback 代理鉴权 → 撤销', async () => {
  const home = withTempHome();
  const cert = makeWildcardCert();
  const relayDir = mkdtempSync(join(tmpdir(), 'dsh-group-relay-'));
  const groupFile = join(relayDir, 'group.json');
  let relay;
  let runtime;
  let groupInfo;
  const seen = [];
  const seenUpgrades = [];

  try {
    relay = await createRelay({
      domain: 'relay.test',
      controlPort: 0,
      httpPort: 0,
      listenHost: '127.0.0.1',
      dev: true,
      logger: SILENT,
      mode: 'group',
      group: {
        file: groupFile,
        mobilePort: 11443,
        // 注册 API / 后台独立监听，控制面只做 WSS
        apiPort: 0,
        adminPort: 0,
        edge: { enabled: true, port: 0, tls: { cert: cert.cert, key: cert.key }, allowUnauthenticated: false },
        auth: { tokenTtlMs: 15 * 60 * 1000, challengeTtlMs: 2 * 60 * 1000, maxAttemptsPerMinutePerIp: 100 },
        registration: { enabled: true, maxAttemptsPerMinutePerIp: 50, maxAttemptsPerMinute: 200, bodyLimitBytes: 8192 },
      },
      handshakeTimeoutMs: 3000,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 30_000,
      openTimeoutMs: 3000,
    });
    const invite = createInvite(groupFile, { maxUses: 1 });
    const device = makeDevice();
    const devices = new DeviceStore();
    const identity = loadOrCreateHostIdentity();
    const pairing = new PairingManager({
      identity,
      ca: undefined,
      devices,
      audit: { append() {} },
      getConfig: () => ({ hostName: 'Group Test Mac', requireApproval: false }),
      getGroupInfo: () => groupInfo,
      log: () => {},
    });

    runtime = new GroupHostRuntime({
      config: {
        // 注册走独立的注册 API 面；隧道地址由注册响应 controlUrl 下发
        groupServiceUrl: `http://127.0.0.1:${relay.groupApiPort}`,
        groupInviteCode: invite.code,
        groupInsecure: true,
        groupPlainPort: 0,
        hostName: 'Group Test Mac',
      },
      devices,
      proxy: {
        async handle(req, res, dev) {
          seen.push({ url: req.url, device: dev?.id, host: req.headers.host });
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(`ok:${dev?.id}:${req.url}`);
        },
        async handleUpgrade(req, socket, head, dev) {
          seenUpgrades.push({ url: req.url, device: dev?.id, host: req.headers.host });
          socket.write(
            'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
          );
          socket.write('ws-hello');
          socket.end();
        },
      },
      pairing,
      audit: { append() {} },
      log: () => {},
    });

    // 1) 注册并落盘 0600
    const registration = await runtime.register();
    assert.ok(registration.hostId.startsWith('h_'));
    assert.equal(registration.relayDomain, 'relay.test');
    assert.equal(registration.mobilePort, 11443);
    assert.match(registration.tokenPublicKey, /BEGIN PUBLIC KEY/);
    // 控制面地址来自服务端下发，且是 WSS 端口（≠ 注册 API 端口）
    assert.equal(registration.controlUrl, `ws://127.0.0.1:${relay.controlPort}`);
    assert.equal(runtime.status().controlUrl, registration.controlUrl);
    assert.notEqual(String(relay.controlPort), String(relay.groupApiPort));
    groupInfo = { hostId: registration.hostId, relayDomain: registration.relayDomain, mobilePort: registration.mobilePort };
    devices.onChange = () => runtime.syncDevices();
    const registrationFile = paths.groupRegistration();
    if (process.platform !== 'win32') assert.equal(statSync(registrationFile).mode & 0o777, 0o600);
    assert.equal(loadGroupRegistration(registrationFile)?.hostId, registration.hostId);

    // 2) v2 配对二维码：带服务端下发端口 + auth=token
    const pairSession = pairing.createSession();
    const pairUri = parseGroupPairingUri(pairSession.uri);
    const fqdn = `${registration.hostId}.relay.test`;
    assert.equal(pairUri.host, fqdn);
    assert.equal(pairUri.port, 11443);
    assert.equal(pairUri.auth, PAIR_AUTH_TOKEN);
    assert.equal(pairUri.relayDomain, 'relay.test');
    assert.equal(pairUri.hostId, registration.hostId);
    assert.match(pairSession.code, /^[A-Z0-9]{4}-?[A-Z0-9]{4}$|^[A-Z0-9]{12}$/);

    // 3) 启动隧道后，通过 relay 边缘完成设备公钥配对（无需 mTLS 证书）
    await runtime.start();
    await waitFor(() => relay.onlineHostIds().includes(registration.hostId));
    const pairResponse = await tlsJson({
      port: relay.edgePort,
      servername: fqdn,
      ca: cert.cert,
      path: PAIR_PATH,
      body: { secret: pairUri.secret, publicKey: device.publicKeyRaw, deviceName: 'Test iPhone', platform: 'ios' },
    });
    assert.equal(pairResponse.status, 200, pairResponse.raw);
    assert.equal(pairResponse.json.data.status, 'paired');
    assert.match(pairResponse.json.data.deviceId, /^d_[a-z0-9]{6,40}$/);
    const pairedDeviceId = pairResponse.json.data.deviceId;
    assert.equal(pairResponse.json.data.auth, 'token');
    const storedDevice = devices.get(pairedDeviceId);
    assert.equal(storedDevice.groupPublicKey, device.publicKeyRaw);

    // 4) 设备同步到 relay 后换 token，并穿过隧道访问 loopback 代理
    const token = await waitFor(async () => {
      const challenge = await tlsJson({
        port: relay.edgePort,
        servername: fqdn,
        ca: cert.cert,
        path: GROUP_AUTH_CHALLENGE_PATH,
        body: { deviceId: pairedDeviceId },
      });
      if (challenge.status !== 200) return undefined;
      const signature = nodeSign(
        'sha256',
        groupDeviceChallengeMessage(registration.hostId, pairedDeviceId, challenge.json.nonce),
        device.privateKey,
      ).toString('base64url');
      const tokenResponse = await tlsJson({
        port: relay.edgePort,
        servername: fqdn,
        ca: cert.cert,
        path: GROUP_AUTH_TOKEN_PATH,
        body: { deviceId: pairedDeviceId, nonce: challenge.json.nonce, signature },
      });
      return tokenResponse.status === 200 ? tokenResponse.json.token : undefined;
    });
    assert.ok(token.startsWith('v1.'));

    const okResponse = await tlsRaw({
      port: relay.edgePort,
      servername: fqdn,
      ca: cert.cert,
      request: `GET /hello HTTP/1.1\r\nHost: ${fqdn}\r\nCookie: ${GROUP_SESSION_COOKIE}=${token}\r\nConnection: close\r\n\r\n`,
    });
    assert.ok(okResponse.includes(`ok:${pairedDeviceId}:/hello`), okResponse.slice(0, 300));
    assert.equal(seen[0]?.device, pairedDeviceId);
    assert.equal(seen[0]?.host, fqdn);
    // 群体版鉴权成功后更新 lastSeen（管理台不再显示「从未连接」）
    assert.ok(devices.get(pairedDeviceId)?.lastSeenAt > 0);

    // 4b) WebSocket 升级（DSH UI 实时通道）：边缘隧道 → 主机 loopback 明文代理 → DshProxy.handleUpgrade
    const wsResponse = await tlsRaw({
      port: relay.edgePort,
      servername: fqdn,
      ca: cert.cert,
      request:
        `GET /ws HTTP/1.1\r\nHost: ${fqdn}\r\nCookie: ${GROUP_SESSION_COOKIE}=${token}\r\n`
        + 'Connection: Upgrade\r\nUpgrade: websocket\r\n'
        + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
    });
    assert.ok(wsResponse.startsWith('HTTP/1.1 101'), wsResponse.slice(0, 300));
    assert.ok(wsResponse.includes('ws-hello'), wsResponse.slice(0, 300));
    assert.equal(seenUpgrades[0]?.device, pairedDeviceId);
    assert.equal(seenUpgrades[0]?.url, '/ws');

    // 5) Host 与 SNI 不一致 → 主机 loopback 代理 421
    const misdirected = await tlsRaw({
      port: relay.edgePort,
      servername: fqdn,
      ca: cert.cert,
      request: `GET /hello HTTP/1.1\r\nHost: evil.test\r\nCookie: ${GROUP_SESSION_COOKIE}=${token}\r\nConnection: close\r\n\r\n`,
    });
    assert.ok(misdirected.startsWith('HTTP/1.1 421'), misdirected.slice(0, 200));

    // 6) 无 cookie → 边缘 401
    const noCookie = await tlsRaw({
      port: relay.edgePort,
      servername: fqdn,
      ca: cert.cert,
      request: `GET /hello HTTP/1.1\r\nHost: ${fqdn}\r\nConnection: close\r\n\r\n`,
    });
    assert.ok(noCookie.startsWith('HTTP/1.1 401'), noCookie.slice(0, 200));

    // 7) 设备撤销 → relay 同步后原 token 立即 401
    devices.revoke(pairedDeviceId);
    await waitFor(async () => {
      const probe = await tlsRaw({
        port: relay.edgePort,
        servername: fqdn,
        ca: cert.cert,
        request: `GET /hello HTTP/1.1\r\nHost: ${fqdn}\r\nCookie: ${GROUP_SESSION_COOKIE}=${token}\r\nConnection: close\r\n\r\n`,
      });
      return probe.startsWith('HTTP/1.1 401');
    });

    // 8) 刷新注册信息（hostToken 鉴权，不消耗邀请码）与「重试连接」自动同步
    const refreshed = await runtime.refreshRegistration();
    assert.equal(refreshed.mobilePort, 11443);
    assert.equal(refreshed.hostId, registration.hostId);
    // 9) 「重试连接」：不重置注册，重建隧道后应重新连上
    await runtime.reconnect();
    await waitFor(() => runtime.status().connected === true);
  } finally {
    try { await runtime?.stop(); } catch { /* ignore */ }
    try { await relay?.close(); } catch { /* ignore */ }
    cert.cleanup();
    rmSync(relayDir, { recursive: true, force: true });
    home.cleanup();
  }
});

test('群体版主机配置校验：只需要服务地址（classic 字段已删除）', async () => {
  const { validateConfig, DEFAULT_CONFIG } = await import('../lib/config.js');
  assert.deepEqual(validateConfig({ enabled: true, groupServiceUrl: 'https://relay.example.com:8443' }), []);
  assert.match(validateConfig({ enabled: true, groupServiceUrl: '' }).join(';'), /groupServiceUrl/);
  assert.match(validateConfig({ enabled: true, groupServiceUrl: 'ftp://x' }).join(';'), /https/);
  assert.deepEqual(
    validateConfig({ enabled: true, groupServiceUrl: 'http://127.0.0.1:1', groupInsecure: true }),
    [],
  );
  assert.deepEqual(validateConfig({ enabled: false }), [], '未启用时不做字段校验');
  // classic/单体配置字段不再存在（relayUrl/hostId/hostToken/证书/推送/groupEnabled...）；
  // 「重启主机」组件（restartHostEnabled）是群体版正式字段，单独在下面断言。
  for (const key of [
    'relayUrl', 'relayDomain', 'hostId', 'publicPort', 'hostToken', 'relayTlsInsecure',
    'tlsCertFile', 'tlsKeyFile', 'listenPort',
    'pushCooldownSeconds', 'pushProvider', 'apnsKeyFile', 'apnsKeyId',
    'apnsTeamId', 'apnsTopic', 'apnsEnvironment', 'groupEnabled',
  ]) {
    assert.equal(key in DEFAULT_CONFIG, false, `${key} 不应再是群体版配置字段`);
  }
  assert.equal(DEFAULT_CONFIG.restartHostEnabled, false, '「重启主机」组件默认关闭');
  assert.equal(DEFAULT_CONFIG.pushEnabled, true, '「推送提醒」开关默认开启（服务端集中推送）');
  assert.deepEqual(validateConfig({ enabled: true, groupServiceUrl: 'https://relay.example.com:8443', restartHostEnabled: true }), []);
  assert.deepEqual(validateConfig({ enabled: true, groupServiceUrl: 'https://relay.example.com:8443', pushEnabled: false }), []);
});

// ---------------------------------------------------------------------------
// 群体版推送：POST /__dsh_remote/push-token（契约 §3）
// ---------------------------------------------------------------------------
// 不依赖 relay：起 loopback 明文代理（startPlainProxy），注入假 connector 模拟控制连接；
// token 用 relay 侧 Ed25519 私钥现场签发，host 只用保存的公钥离线验签。

const PUSH_HOST_ID = 'h_pushtest01';
const PUSH_RELAY_DOMAIN = 'relay.test';
const PUSH_FQDN = `${PUSH_HOST_ID}.${PUSH_RELAY_DOMAIN}`;
const PUSH_DEVICE_ID = 'd_pushdevice01';
const APNS_TOKEN = 'a'.repeat(64);

/** relay 侧 Ed25519 签名密钥（host 只保存公钥做离线验签）。 */
function makeRelaySigningKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/** 发一条 HTTP 请求到 loopback 明文代理。 */
function plainJsonRequest({ port, path, method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path, method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: response.statusCode, json, text });
      });
    });
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

/** 假 connector：只实现 push-token 路由用到的最小面。 */
function fakePushConnector({ connected = true, registerResult = { ok: true, mode: 'self', enabled: true } } = {}) {
  const calls = [];
  return {
    connected,
    calls,
    stopped: false,
    isConnected() { return this.connected === true; },
    stop() { this.stopped = true; },
    syncGroupDevices() { return true; },
    async registerPushToken(entry) {
      calls.push(entry);
      return typeof registerResult === 'function' ? registerResult(entry) : registerResult;
    },
  };
}

/** 已注册 + loopback 明文代理就绪的群体运行时（不连 relay）。 */
async function setupPushRuntime({ connector } = {}) {
  const home = withTempHome();
  const relayKey = makeRelaySigningKey();
  saveGroupRegistration({
    serviceUrl: 'https://relay.example.com:19443',
    hostId: PUSH_HOST_ID,
    hostToken: 'test-host-token',
    relayDomain: PUSH_RELAY_DOMAIN,
    mobilePort: 11443,
    tokenPublicKey: relayKey.publicKeyPem,
    hostName: 'Push Test Host',
  });
  const auditEntries = [];
  const logs = [];
  const devices = {
    list: () => [{ id: PUSH_DEVICE_ID, name: 'Test iPhone', platform: 'ios', groupPublicKey: 'pk-test', revokedAt: null }],
    touchById: () => {},
  };
  const proxy = {
    handle: async () => { throw new Error('unexpected proxy request'); },
    handleUpgrade: () => { throw new Error('unexpected ws upgrade'); },
  };
  const runtime = new GroupHostRuntime({
    config: { pushEnabled: true, groupPlainPort: 0 },
    devices,
    proxy,
    audit: { append: (entry) => auditEntries.push(entry) },
    log: (message) => logs.push(message),
  });
  await runtime.startPlainProxy();
  if (connector !== undefined) runtime.connector = connector;
  const token = signGroupSessionToken({
    privateKey: relayKey.privateKey,
    hostId: PUSH_HOST_ID,
    deviceId: PUSH_DEVICE_ID,
  }).token;
  return { home, runtime, token, auditEntries, logs };
}

async function teardownPushRuntime(env) {
  try { await env.runtime.stop(); } catch { /* ignore */ }
  env.home.cleanup();
}

function pushRequest(env, { body, headers = {}, method = 'POST' } = {}) {
  return plainJsonRequest({
    port: env.runtime.plainPort,
    path: PUSH_TOKEN_PATH,
    method,
    headers: {
      host: PUSH_FQDN,
      cookie: `${GROUP_SESSION_COOKIE}=${env.token}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const VALID_PUSH_BODY = Object.freeze({ provider: 'apns', token: APNS_TOKEN, environment: 'development' });

test('push-token（self 旧 body 兼容）：成功登记返回 registered/channel，status.push 有分流状态且不含 token', async () => {
  const connector = fakePushConnector();
  const env = await setupPushRuntime({ connector });
  try {
    const response = await pushRequest(env, { body: VALID_PUSH_BODY });
    assert.equal(response.status, 200, response.text);
    // R2：channel 新字段；mode 同时返回（旧 App 0.1.8 用 mode 展示）
    assert.deepEqual(response.json, { ok: true, data: { registered: true, channel: 'self', mode: 'self' } });
    assert.deepEqual(connector.calls, [{
      deviceId: PUSH_DEVICE_ID,
      provider: 'apns',
      token: APNS_TOKEN,
      environment: 'development',
    }]);

    const push = env.runtime.status().push;
    assert.deepEqual(push, {
      enabled: true,
      detail: false,
      self: { devices: 1, lastError: null },
      official: { devices: 0, lastError: null, hub: null },
      mode: 'self',
    });
    assert.equal(JSON.stringify(env.runtime.status()).includes(APNS_TOKEN), false, 'status 不能暴露 token 明文');
    assert.equal(env.logs.some((line) => line.includes(APNS_TOKEN)), false, '日志不能出现 token 明文');
    assert.ok(env.auditEntries.some((entry) => entry.action === 'push-token' && entry.result === 'ok' && entry.deviceId === PUSH_DEVICE_ID));

    // 远程 /__dsh_remote/status 也带上 push 对象（App 设置页读它）
    const statusResponse = await plainJsonRequest({
      port: env.runtime.plainPort,
      path: STATUS_PATH,
      headers: { host: PUSH_FQDN, cookie: `${GROUP_SESSION_COOKIE}=${env.token}` },
    });
    assert.equal(statusResponse.status, 200, statusResponse.text);
    assert.deepEqual(statusResponse.json.data.push, push);
    assert.equal(JSON.stringify(statusResponse.json).includes(APNS_TOKEN), false);
  } finally {
    await teardownPushRuntime(env);
  }
});

test('push-token：Authorization: Bearer 与 cookie 等价，且未鉴权/设备撤销返回 401', async () => {
  const connector = fakePushConnector();
  const env = await setupPushRuntime({ connector });
  try {
    // Bearer 等价（App native fetch）
    const bearer = await pushRequest(env, { body: VALID_PUSH_BODY, headers: { authorization: `Bearer ${env.token}` } });
    assert.equal(bearer.status, 200, bearer.text);

    // 无凭证
    const anon = await plainJsonRequest({
      port: env.runtime.plainPort,
      path: PUSH_TOKEN_PATH,
      method: 'POST',
      headers: { host: PUSH_FQDN, 'content-type': 'application/json' },
      body: JSON.stringify(VALID_PUSH_BODY),
    });
    assert.equal(anon.status, 401, anon.text);
    assert.equal(anon.json.ok, false);

    // 设备已撤销（不在本机设备表）→ 401
    env.runtime.devices = { list: () => [] };
    const revoked = await pushRequest(env, { body: VALID_PUSH_BODY });
    assert.equal(revoked.status, 401, revoked.text);
    assert.equal(connector.calls.length, 1, '未鉴权/已撤销请求不转发 relay');
  } finally {
    await teardownPushRuntime(env);
  }
});

test('push-token：坏参数一律 4xx（invalid-push-token / invalid-channel / invalid-body，不转发 relay）', async () => {
  const connector = fakePushConnector();
  const env = await setupPushRuntime({ connector });
  try {
    const badTokenBodies = [
      { ...VALID_PUSH_BODY, token: 'A'.repeat(64) }, // 大写 hex
      { ...VALID_PUSH_BODY, token: 'a'.repeat(63) }, // 长度不对
      { ...VALID_PUSH_BODY, token: 'z'.repeat(64) }, // 非 hex
      { ...VALID_PUSH_BODY, provider: 'expo' },
      { ...VALID_PUSH_BODY, provider: 'fcm' },
      { ...VALID_PUSH_BODY, environment: 'sandbox' },
      { provider: 'apns', token: APNS_TOKEN }, // 缺 environment
      {},
    ];
    for (const body of badTokenBodies) {
      const response = await pushRequest(env, { body });
      assert.equal(response.status, 400, `${JSON.stringify(body)} → ${response.status} ${response.text}`);
      assert.equal(response.json.error.code, 'invalid-push-token');
    }

    // R2：非法 channel → 400 invalid-channel
    for (const channel of ['expo', 'fcm', 'OFFICIAL', 1, true]) {
      const response = await pushRequest(env, { body: { ...VALID_PUSH_BODY, channel } });
      assert.equal(response.status, 400, `${JSON.stringify(channel)} → ${response.status} ${response.text}`);
      assert.equal(response.json.error.code, 'invalid-channel');
    }

    // R2：self 不允许携带 hub 字段 → 400 invalid-body
    for (const extra of [
      { channel: 'self', bundleId: 'com.example.app' },
      { channel: 'self', hubEndpoint: 'https://push.example.com' },
      { channel: 'self', credential: 'a.b.c' },
    ]) {
      const response = await pushRequest(env, { body: { ...VALID_PUSH_BODY, ...extra } });
      assert.equal(response.status, 400, `${JSON.stringify(extra)} → ${response.status} ${response.text}`);
      assert.equal(response.json.error.code, 'invalid-body');
    }
    assert.equal(connector.calls.length, 0, '本地校验失败的请求不能到达 relay');

    // 方法不对 → 405
    const wrongMethod = await pushRequest(env, { method: 'GET' });
    assert.equal(wrongMethod.status, 405, wrongMethod.text);
    assert.equal(wrongMethod.json.error.code, 'method-not-allowed');

    // 非法 JSON → 400
    const badJson = await plainJsonRequest({
      port: env.runtime.plainPort,
      path: PUSH_TOKEN_PATH,
      method: 'POST',
      headers: { host: PUSH_FQDN, cookie: `${GROUP_SESSION_COOKIE}=${env.token}`, 'content-type': 'application/json' },
      body: '{"provider":',
    });
    assert.equal(badJson.status, 400, badJson.text);
  } finally {
    await teardownPushRuntime(env);
  }
});

test('push-token（self）：relay 未连接 → 503 push-not-connected；无 connector 同样 503', async () => {
  const connected = fakePushConnector({ connected: false });
  const env = await setupPushRuntime({ connector: connected });
  try {
    const response = await pushRequest(env, { body: VALID_PUSH_BODY });
    assert.equal(response.status, 503, response.text);
    assert.equal(response.json.error.code, 'push-not-connected');
    assert.equal(connected.calls.length, 0);
    assert.match(env.runtime.status().push.self.lastError, /控制连接/);

    env.runtime.connector = undefined;
    const withoutConnector = await pushRequest(env, { body: VALID_PUSH_BODY });
    assert.equal(withoutConnector.status, 503, withoutConnector.text);
    assert.equal(withoutConnector.json.error.code, 'push-not-connected');
  } finally {
    await teardownPushRuntime(env);
  }
});

test('push-token（self）：relay 未开启推送 → 403 push-disabled；其它拒绝码 → 502 push-rejected', async () => {
  const disabled = fakePushConnector({ registerResult: { ok: false, code: 'push_disabled' } });
  const env = await setupPushRuntime({ connector: disabled });
  try {
    const response = await pushRequest(env, { body: VALID_PUSH_BODY });
    assert.equal(response.status, 403, response.text);
    assert.equal(response.json.error.code, 'push-disabled');
    const push = env.runtime.status().push;
    assert.equal(push.self.devices, 0);
    assert.equal(push.mode, '');
    assert.match(push.self.lastError, /服务器未开启推送/);

    env.runtime.connector = fakePushConnector({ registerResult: { ok: false, code: 'rate_limited', message: 'slow down' } });
    const rejected = await pushRequest(env, { body: { ...VALID_PUSH_BODY, token: 'b'.repeat(64) } });
    assert.equal(rejected.status, 502, rejected.text);
    assert.equal(rejected.json.error.code, 'push-rejected');
    assert.match(env.runtime.status().push.self.lastError, /rate_limited/);

    // 登记超时（5s 没等到 push.registered）→ 503 push-timeout（Lead 约定的契约外可重试错误码）
    env.runtime.connector = fakePushConnector({ registerResult: { ok: false, code: 'timeout' } });
    const timeout = await pushRequest(env, { body: { ...VALID_PUSH_BODY, token: 'c'.repeat(64) } });
    assert.equal(timeout.status, 503, timeout.text);
    assert.equal(timeout.json.error.code, 'push-timeout');
    assert.match(env.runtime.status().push.self.lastError, /超时/);
  } finally {
    await teardownPushRuntime(env);
  }
});

test('push-token：设备撤销后同步设备表会清掉本机推送设备记录', async () => {
  const connector = fakePushConnector();
  const env = await setupPushRuntime({ connector });
  try {
    const response = await pushRequest(env, { body: VALID_PUSH_BODY });
    assert.equal(response.status, 200, response.text);
    assert.equal(env.runtime.status().push.self.devices, 1);

    // 撤销设备 → service.devices.onChange 会调 runtime.syncDevices()
    env.runtime.devices = { list: () => [], touchById: () => {} };
    env.runtime.syncDevices();
    assert.equal(env.runtime.status().push.self.devices, 0, '设备撤销后不应再统计其推送 token');
    assert.equal(env.runtime.status().push.mode, '');
  } finally {
    await teardownPushRuntime(env);
  }
});
