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
  groupDeviceChallengeMessage,
  newGroupDeviceId,
  parseGroupPairingUri,
} from 'dsh-remote-protocol';
import { createInvite, createRelay } from '../../relay/index.js';
import { GroupHostRuntime, loadGroupRegistration } from '../lib/group.js';
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

  try {
    relay = await createRelay({
      domain: 'relay.test',
      dataPort: 0,
      controlPort: 0,
      httpPort: 0,
      dataHost: '127.0.0.1',
      dev: true,
      logger: SILENT,
      mode: 'group',
      group: {
        file: groupFile,
        mobilePort: 11443,
        // P1 切片 9：注册 API / 后台独立监听，控制面只做 WSS
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
  } finally {
    try { await runtime?.stop(); } catch { /* ignore */ }
    try { await relay?.close(); } catch { /* ignore */ }
    cert.cleanup();
    rmSync(relayDir, { recursive: true, force: true });
    home.cleanup();
  }
});

test('群体版主机配置校验：group 模式只需要服务地址（classic 字段不再必填）', async () => {
  const { validateConfig } = await import('../lib/config.js');
  assert.deepEqual(validateConfig({ enabled: true, groupEnabled: true, groupServiceUrl: 'https://relay.example.com:8443' }), []);
  assert.match(validateConfig({ enabled: true, groupEnabled: true, groupServiceUrl: '' }).join(';'), /groupServiceUrl/);
  assert.match(validateConfig({ enabled: true, groupEnabled: true, groupServiceUrl: 'ftp://x' }).join(';'), /https/);
  assert.deepEqual(
    validateConfig({ enabled: true, groupEnabled: true, groupServiceUrl: 'http://127.0.0.1:1', groupInsecure: true }),
    [],
  );
  assert.match(validateConfig({ enabled: true, relayUrl: '' }).join(';'), /relayUrl/);
});
