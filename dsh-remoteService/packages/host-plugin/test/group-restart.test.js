/**
 * 群体服务版「重启主机 DSH」端到端（loopback 明文代理层）：
 * GroupHostRuntime + 假 restartHost（**绝不真的杀进程**）。
 *
 * 覆盖 App / 验收要求的契约：
 *   - `GET  /__dsh_remote/status`：cookie 与 `Authorization: Bearer` 等价鉴权，
 *     返回 hostId/hostName/domain/auth/relayConnected/version/restart.enabled/devices；
 *   - `POST /__dsh_remote/restart`：202 `{ok:true,data:{restarting:true,mode}}`；
 *     未鉴权 401；组件关闭 501 host-restart-disabled；未接入 501 host-restart-unavailable；
 *     方法不对 405；调度失败透传 status/code；审计 accepted/failed（去重命中 hash=deduped）。
 *   - Host 头与注册域名不一致 → 421，且不会触发重启调度。
 *
 * 不依赖 relay / TLS：直接起 loopback 明文代理（`startPlainProxy()`），token 用 relay 侧
 * Ed25519 私钥现场签发，host 只用保存的公钥离线验签。
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import {
  GROUP_SESSION_COOKIE,
  STATUS_PATH,
  signGroupSessionToken,
} from 'dsh-remote-protocol';
import { GroupHostRuntime, RESTART_PATH, saveGroupRegistration } from '../lib/group.js';
import { withTempHome } from './helpers.js';

const HOST_ID = 'h_testrestart';
const RELAY_DOMAIN = 'relay.test';
const FQDN = `${HOST_ID}.${RELAY_DOMAIN}`;
const DEVICE_ID = 'd_testdevice01';

/** relay 侧的 Ed25519 签名密钥：host 只保存公钥做离线验签。 */
function makeRelayKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/** 发一条 HTTP 请求到 loopback 明文代理（可自定义 Host / Cookie / Authorization）。 */
function plainRequest({ port, path, method = 'GET', headers = {}, body }) {
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

/**
 * 起一个「已注册 + loopback 明文代理」的群体版运行时。
 * @param {{restartHostEnabled?: boolean, restartHost?: Function}} [options]
 */
async function setupRuntime({ restartHostEnabled = true, restartHost } = {}) {
  const home = withTempHome();
  const relayKey = makeRelayKey();
  saveGroupRegistration({
    serviceUrl: 'https://relay.example.com:19443',
    hostId: HOST_ID,
    hostToken: 'test-host-token',
    relayDomain: RELAY_DOMAIN,
    mobilePort: 11443,
    tokenPublicKey: relayKey.publicKeyPem,
    hostName: 'Restart Test Host',
  });
  const auditEntries = [];
  const audit = {
    append(entry) {
      auditEntries.push(entry);
      return entry;
    },
  };
  const devices = {
    list: () => [{ id: DEVICE_ID, name: 'Test iPhone', platform: 'ios', groupPublicKey: 'pk-test', revokedAt: null }],
    touchById: () => {},
  };
  const proxy = {
    handle: async () => { throw new Error('unexpected proxy request'); },
    handleUpgrade: () => { throw new Error('unexpected ws upgrade'); },
  };
  const runtime = new GroupHostRuntime({
    config: { restartHostEnabled, groupPlainPort: 0 },
    devices,
    proxy,
    audit,
    log: () => {},
    version: '0.2.1-test',
    restartHost,
  });
  await runtime.startPlainProxy();
  const token = signGroupSessionToken({
    privateKey: relayKey.privateKey,
    hostId: HOST_ID,
    deviceId: DEVICE_ID,
  }).token;
  return { home, runtime, token, auditEntries };
}

async function teardown(env) {
  try { await env.runtime.stop(); } catch { /* ignore */ }
  env.home.cleanup();
}

function cookieHeaders(token, extra = {}) {
  return { host: FQDN, cookie: `${GROUP_SESSION_COOKIE}=${token}`, ...extra };
}

test('群体版 status：cookie 与 Bearer 等价鉴权，返回 restart.enabled / version 等群体字段', async () => {
  for (const restartHostEnabled of [true, false]) {
    const env = await setupRuntime({ restartHostEnabled });
    try {
      const expected = {
        hostId: HOST_ID,
        hostName: 'Restart Test Host',
        domain: FQDN,
        auth: 'token',
        relayConnected: false,
        version: '0.2.1-test',
        restart: { enabled: restartHostEnabled },
        // 推送状态（R2 契约 §6.3）；无设备时两通道都为 0、mode 为空
        push: {
          enabled: true,
          detail: false,
          self: { devices: 0, lastError: null },
          official: { devices: 0, lastError: null, hub: null },
          mode: '',
        },
        devices: { total: 1, active: 1 },
      };
      const cookieRes = await plainRequest({ port: env.runtime.plainPort, path: STATUS_PATH, headers: cookieHeaders(env.token) });
      assert.equal(cookieRes.status, 200, cookieRes.text);
      assert.equal(cookieRes.json.ok, true);
      assert.deepEqual(cookieRes.json.data, expected);

      // App 的 JS fetch 走 Bearer（host 侧与 cookie 等价；本轮 relay 边缘以 cookie 为主）
      const bearerRes = await plainRequest({
        port: env.runtime.plainPort,
        path: STATUS_PATH,
        headers: { host: FQDN, authorization: `Bearer ${env.token}` },
      });
      assert.equal(bearerRes.status, 200, bearerRes.text);
      assert.deepEqual(bearerRes.json.data, expected);
    } finally {
      await teardown(env);
    }
  }
});

test('群体版 status/restart：无凭证、非法 token、非 Bearer 方案 → 401 且不调度', async () => {
  const calls = [];
  const env = await setupRuntime({ restartHost: async (request) => { calls.push(request); return { mode: 'node' }; } });
  try {
    const cases = [
      { host: FQDN }, // 无凭证
      { host: FQDN, cookie: `${GROUP_SESSION_COOKIE}=v1.invalid.signature` },
      { host: FQDN, authorization: 'Bearer v1.invalid.signature' },
      { host: FQDN, authorization: 'Basic dXNlcjpwYXNz' }, // 非 Bearer 方案不会退化成 cookie
    ];
    for (const headers of cases) {
      const statusRes = await plainRequest({ port: env.runtime.plainPort, path: STATUS_PATH, headers });
      assert.equal(statusRes.status, 401, JSON.stringify(headers));
      assert.equal(statusRes.json.ok, false);
      const restartRes = await plainRequest({
        port: env.runtime.plainPort,
        path: RESTART_PATH,
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(restartRes.status, 401, JSON.stringify(headers));
    }
    assert.equal(calls.length, 0, '未鉴权不得进入重启调度');
    const audit = env.auditEntries.filter((entry) => entry.action === 'host-restart');
    assert.equal(audit.length, 0, '未鉴权请求不应写 host-restart 审计');
  } finally {
    await teardown(env);
  }
});

test('POST restart：开启时 202 {restarting:true,mode}，调度拿到发起设备，审计 accepted', async () => {
  const calls = [];
  const env = await setupRuntime({
    restartHostEnabled: true,
    restartHost: async (request) => {
      calls.push(request);
      return { mode: 'desktop-app', deduped: false };
    },
  });
  try {
    const res = await plainRequest({
      port: env.runtime.plainPort,
      path: RESTART_PATH,
      method: 'POST',
      headers: cookieHeaders(env.token, { 'content-type': 'application/json' }),
      body: '{}',
    });
    assert.equal(res.status, 202, res.text);
    assert.deepEqual(res.json, { ok: true, data: { restarting: true, mode: 'desktop-app' } });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].device, { id: DEVICE_ID, deviceId: DEVICE_ID });

    const audit = env.auditEntries.filter((entry) => entry.action === 'host-restart').at(-1);
    assert.equal(audit.deviceId, DEVICE_ID);
    assert.equal(audit.result, 'accepted');
    assert.equal(audit.hash, 'desktop-app');

    // Bearer 同样可调用（App 侧本轮以 cookie 为主，Bearer 作为等价兜底）
    const bearerRes = await plainRequest({
      port: env.runtime.plainPort,
      path: RESTART_PATH,
      method: 'POST',
      headers: { host: FQDN, authorization: `Bearer ${env.token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(bearerRes.status, 202, bearerRes.text);
    assert.equal(calls.length, 2);
  } finally {
    await teardown(env);
  }
});

test('POST restart：去重命中仍回 202，审计标记 deduped', async () => {
  const env = await setupRuntime({
    restartHost: async () => ({ mode: 'node', deduped: true }),
  });
  try {
    const res = await plainRequest({
      port: env.runtime.plainPort,
      path: RESTART_PATH,
      method: 'POST',
      headers: cookieHeaders(env.token),
    });
    assert.equal(res.status, 202, res.text);
    assert.deepEqual(res.json.data, { restarting: true, mode: 'node' });
    const audit = env.auditEntries.filter((entry) => entry.action === 'host-restart').at(-1);
    assert.equal(audit.result, 'accepted');
    assert.equal(audit.hash, 'deduped');
  } finally {
    await teardown(env);
  }
});

test('POST restart：组件关闭（restartHostEnabled=false）→ 501 host-restart-disabled，不调度', async () => {
  const calls = [];
  const env = await setupRuntime({
    restartHostEnabled: false,
    restartHost: async (request) => { calls.push(request); return { mode: 'node' }; },
  });
  try {
    const res = await plainRequest({
      port: env.runtime.plainPort,
      path: RESTART_PATH,
      method: 'POST',
      headers: cookieHeaders(env.token, { 'content-type': 'application/json' }),
      body: '{}',
    });
    assert.equal(res.status, 501, res.text);
    assert.equal(res.json.error.code, 'host-restart-disabled');
    assert.match(res.json.error.message, /关闭/);
    assert.equal(calls.length, 0, '组件关闭后不得进入重启调度');
    const audit = env.auditEntries.filter((entry) => entry.action === 'host-restart').at(-1);
    assert.equal(audit.deviceId, DEVICE_ID);
    assert.equal(audit.result, 'failed');
    assert.equal(audit.hash, 'disabled');
  } finally {
    await teardown(env);
  }
});

test('POST restart：未注入 restartHost → 501 host-restart-unavailable（不强行启用）', async () => {
  const env = await setupRuntime({ restartHostEnabled: true });
  try {
    const res = await plainRequest({
      port: env.runtime.plainPort,
      path: RESTART_PATH,
      method: 'POST',
      headers: cookieHeaders(env.token),
    });
    assert.equal(res.status, 501, res.text);
    assert.equal(res.json.error.code, 'host-restart-unavailable');
    const audit = env.auditEntries.filter((entry) => entry.action === 'host-restart').at(-1);
    assert.equal(audit.result, 'failed');
    assert.equal(audit.hash, 'not-enabled');
  } finally {
    await teardown(env);
  }
});

test('POST restart：方法不对 → 405，不调度', async () => {
  const calls = [];
  const env = await setupRuntime({ restartHost: async (request) => { calls.push(request); return { mode: 'node' }; } });
  try {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = await plainRequest({ port: env.runtime.plainPort, path: RESTART_PATH, method, headers: cookieHeaders(env.token) });
      assert.equal(res.status, 405, method);
      assert.equal(res.json.error.code, 'method-not-allowed');
      assert.match(res.json.error.message, /POST/);
    }
    assert.equal(calls.length, 0);
  } finally {
    await teardown(env);
  }
});

test('POST restart：调度层失败透传 status/code（501/500），审计 failed 记录原因', async () => {
  let failure = Object.assign(new Error('当前主机环境不支持自动重启'), { status: 501, code: 'host-restart-unsupported' });
  const env = await setupRuntime({
    restartHost: async () => { throw failure; },
  });
  try {
    const unsupported = await plainRequest({
      port: env.runtime.plainPort,
      path: RESTART_PATH,
      method: 'POST',
      headers: cookieHeaders(env.token),
    });
    assert.equal(unsupported.status, 501, unsupported.text);
    assert.equal(unsupported.json.error.code, 'host-restart-unsupported');
    let audit = env.auditEntries.filter((entry) => entry.action === 'host-restart').at(-1);
    assert.equal(audit.result, 'failed');
    assert.equal(audit.hash, 'host-restart-unsupported');

    failure = new Error('spawn failed unexpectedly');
    const generic = await plainRequest({
      port: env.runtime.plainPort,
      path: RESTART_PATH,
      method: 'POST',
      headers: cookieHeaders(env.token),
    });
    assert.equal(generic.status, 500, generic.text);
    assert.equal(generic.json.error.code, 'host-restart-failed');
    audit = env.auditEntries.filter((entry) => entry.action === 'host-restart').at(-1);
    assert.equal(audit.result, 'failed');
    assert.equal(audit.hash, 'restart-failed');
  } finally {
    await teardown(env);
  }
});

test('POST restart：Host 与注册域名不一致 → 421，不调度', async () => {
  const calls = [];
  const env = await setupRuntime({ restartHost: async (request) => { calls.push(request); return { mode: 'node' }; } });
  try {
    const res = await plainRequest({
      port: env.runtime.plainPort,
      path: RESTART_PATH,
      method: 'POST',
      headers: { host: 'evil.test', cookie: `${GROUP_SESSION_COOKIE}=${env.token}` },
    });
    assert.equal(res.status, 421, res.text);
    assert.equal(calls.length, 0);
  } finally {
    await teardown(env);
  }
});

test('RemoteService.restartHost：组件关闭 501；开启后调度（注入 fake spawn）并去重', async () => {
  const home = withTempHome();
  const { saveConfig } = await import('../lib/config.js');
  const { RemoteService } = await import('../lib/service.js');
  saveConfig({ enabled: false, restartHostEnabled: false });
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return { pid: 4242, unref: () => {} };
  };
  const service = new RemoteService(
    { webServer: { protocol: 'http:', port: 1 } },
    // 测试注入：绝不真的起 helper/杀进程
    { spawnHostRestart: spawnImpl, hostRestartDedupeMs: 10_000, hostRestartEnv: {} },
  );
  await service.ready;
  try {
    assert.throws(
      () => service.restartHost({ device: { id: 'd_1' } }),
      (error) => error.status === 501 && error.code === 'host-restart-disabled',
    );
    assert.equal(calls.length, 0);

    await service.updateConfig({ restartHostEnabled: true });
    const status = service.status();
    assert.deepEqual(status.restart, { enabled: true });
    assert.equal(status.config.restartHostEnabled, true);

    const first = service.restartHost({ device: { id: 'd_1' } });
    assert.equal(first.deduped, false);
    assert.equal(first.mode, 'node');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
    assert.equal(calls[0].options.detached, true);
    assert.equal(calls[0].options.stdio, 'ignore');

    // 去重窗口内重复请求不再起 helper
    const second = service.restartHost({ device: { id: 'd_1' } });
    assert.equal(second.deduped, true);
    assert.equal(second.mode, 'node');
    assert.equal(calls.length, 1);
  } finally {
    await service.dispose();
    home.cleanup();
  }
});
