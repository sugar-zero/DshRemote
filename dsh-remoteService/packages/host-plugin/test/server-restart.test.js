import test from 'node:test';
import assert from 'node:assert/strict';
import { RESTART_PATH, STATUS_PATH } from 'dsh-remote-protocol';
import { makeCsr, makeRogueClientCert, tlsRequest, tlsRequestNoClientCert, withTempHome } from './helpers.js';

const SERVER_NAME = 'h_test.relay.test';

/** 起一个带 mTLS 的远程监听 + 一台已配对设备；restartHost 由测试注入 stub。 */
async function startServer({ restartHost, restartHostEnabled = true } = {}) {
  const home = withTempHome();
  const { loadOrCreateDeviceCa, loadOrCreateDevServerCert, signDeviceCertificate } = await import('../lib/identity.js');
  const { DeviceStore } = await import('../lib/devices.js');
  const { createRemoteServer } = await import('../lib/server.js');

  const ca = loadOrCreateDeviceCa();
  const devices = new DeviceStore();
  const devCert = loadOrCreateDevServerCert(SERVER_NAME);
  const config = { hostId: 'h_test', relayDomain: 'relay.test', hostName: 'Test Host', restartHostEnabled };
  const auditEntries = [];
  const audit = {
    append: (entry) => { auditEntries.push(entry); return entry; },
    tail: (limit = 50) => auditEntries.slice(-limit).reverse(),
  };
  // 这些路径不应被本轮测试触发（若触发会显式失败，避免静默走错路由）。
  const pairing = {
    handlePairRequest: () => { throw new Error('unexpected pairing request'); },
    statusFor: () => { throw new Error('unexpected pairing status'); },
  };
  const proxy = {
    handle: async () => { throw new Error('unexpected proxy request'); },
    handleUpgrade: () => { throw new Error('unexpected ws upgrade'); },
  };
  const remote = createRemoteServer({
    certPem: devCert.certPem,
    keyPem: devCert.keyPem,
    caCertPem: ca.certPem,
    devices,
    pairing,
    proxy,
    audit,
    getConfig: () => config,
    savePushToken: () => {},
    getStatus: () => ({ tls: null, relayConnected: true, version: '0.1.10-test' }),
    restartHost,
    log: () => {},
  });
  const { port } = await remote.listen(0, '127.0.0.1');

  const deviceCsr = makeCsr('Test iPhone');
  const signed = signDeviceCertificate({ ca, csrPem: deviceCsr.csrPem, deviceId: 'd_test01', commonName: 'Test iPhone' });
  devices.add({ id: 'd_test01', name: 'Test iPhone', platform: 'ios', serial: signed.serial, notAfter: signed.notAfter });

  return {
    home,
    port,
    devCert,
    deviceCsr,
    signed,
    auditEntries,
    remote,
    /** 带合法设备证书的请求。 */
    request: (options) => tlsRequest({
      port,
      servername: SERVER_NAME,
      caPem: devCert.certPem,
      certPem: signed.certPem,
      keyPem: deviceCsr.privateKeyPem,
      ...options,
    }),
  };
}

function parseBody(response) {
  try { return JSON.parse(response.body); } catch { return undefined; }
}

test('RESTART_PATH 常量与协议约定一致', () => {
  assert.equal(RESTART_PATH, '/__dsh_remote/restart');
});

test('隧道重启端点：mTLS 门禁 / 202 / 405 / 501 / 500 / 审计', async () => {
  const calls = [];
  let mode = 'mac-app';
  let deduped = false;
  let failure;
  const env = await startServer({
    restartHost: async (request) => {
      calls.push(request);
      if (failure) throw failure;
      return { mode, deduped };
    },
  });
  try {
    // 1) 无客户端证书 → 403（mTLS 门禁在路由之前，stub 不会被执行）
    const noCert = await tlsRequestNoClientCert({ port: env.port, servername: SERVER_NAME, caPem: env.devCert.certPem, method: 'POST', path: RESTART_PATH });
    assert.equal(noCert.status, 403);
    assert.equal(calls.length, 0);

    // 1b) 不受信任 CA 签发的客户端证书 → 403
    const rogue = makeRogueClientCert();
    const rogueRes = await tlsRequest({
      port: env.port,
      servername: SERVER_NAME,
      caPem: env.devCert.certPem,
      certPem: rogue.certPem,
      keyPem: rogue.privateKeyPem,
      method: 'POST',
      path: RESTART_PATH,
    });
    assert.equal(rogueRes.status, 403);
    assert.equal(calls.length, 0);

    // 2) 合法设备证书但非 POST → 405（不调度重启）
    const getRes = await env.request({ method: 'GET', path: RESTART_PATH });
    assert.equal(getRes.status, 405);
    assert.equal(parseBody(getRes)?.error?.code, 'method-not-allowed');
    assert.equal(calls.length, 0);

    // 3) POST（按 App 实际调用带 Content-Type: application/json + 空 body）→ 202，
    //    stub 收到发起请求的设备，审计 accepted
    const okRes = await env.request({
      method: 'POST',
      path: RESTART_PATH,
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(okRes.status, 202);
    const okBody = parseBody(okRes);
    assert.equal(okBody.ok, true);
    assert.equal(okBody.data.restarting, true);
    assert.equal(okBody.data.mode, 'mac-app');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].device.id, 'd_test01');
    assert.equal(calls[0].device.serial, env.signed.serial);
    const acceptedAudit = env.auditEntries.filter((entry) => entry.action === 'host-restart').at(-1);
    assert.equal(acceptedAudit.deviceId, 'd_test01');
    assert.equal(acceptedAudit.result, 'accepted');
    assert.equal(acceptedAudit.hash, 'mac-app');

    // 4) 去重命中（service 层 10s 内重复请求）仍回 202，审计标记 deduped
    mode = 'node';
    deduped = true;
    const dedupedRes = await env.request({ method: 'POST', path: RESTART_PATH });
    assert.equal(dedupedRes.status, 202);
    assert.equal(parseBody(dedupedRes).data.mode, 'node');
    const dedupedAudit = env.auditEntries.filter((entry) => entry.action === 'host-restart').at(-1);
    assert.equal(dedupedAudit.result, 'accepted');
    assert.equal(dedupedAudit.hash, 'deduped');

    // 5) 调度层拒绝（环境不支持/被禁用）→ 透传 501，审计 failed
    failure = Object.assign(new Error('当前主机环境不支持自动重启'), { status: 501, code: 'host-restart-unsupported' });
    const unsupportedRes = await env.request({ method: 'POST', path: RESTART_PATH });
    assert.equal(unsupportedRes.status, 501);
    assert.equal(parseBody(unsupportedRes).error.code, 'host-restart-unsupported');
    assert.match(parseBody(unsupportedRes).error.message, /不支持/);
    const failedAudit = env.auditEntries.filter((entry) => entry.action === 'host-restart').at(-1);
    assert.equal(failedAudit.deviceId, 'd_test01');
    assert.equal(failedAudit.result, 'failed');
    assert.equal(failedAudit.hash, 'host-restart-unsupported');

    // 6) 未分类调度异常 → 500
    failure = new Error('spawn failed unexpectedly');
    const errorRes = await env.request({ method: 'POST', path: RESTART_PATH });
    assert.equal(errorRes.status, 500);
    assert.equal(parseBody(errorRes).error.code, 'host-restart-failed');
    const genericAudit = env.auditEntries.filter((entry) => entry.action === 'host-restart').at(-1);
    assert.equal(genericAudit.result, 'failed');

    // 7) 未知的隧道子路径仍是 404，不会被当成重启入口
    const unknown = await env.request({ method: 'POST', path: '/__dsh_remote/restart/extra' });
    assert.equal(unknown.status, 404);
  } finally {
    await env.remote.close();
    env.home.cleanup();
  }
});

test('隧道重启端点：未注入 restartHost 时 501（不强行为旧监听启用）', async () => {
  const env = await startServer();
  try {
    const res = await env.request({ method: 'POST', path: RESTART_PATH });
    assert.equal(res.status, 501);
    assert.equal(parseBody(res).error.code, 'host-restart-unavailable');
    const audit = env.auditEntries.filter((entry) => entry.action === 'host-restart').at(-1);
    assert.equal(audit.deviceId, 'd_test01');
    assert.equal(audit.result, 'failed');
    assert.equal(audit.hash, 'not-enabled');
  } finally {
    await env.remote.close();
    env.home.cleanup();
  }
});


test('隧道重启端点：组件关闭（restartHostEnabled=false）时 501，不调度、审计 disabled', async () => {
  const calls = [];
  const env = await startServer({
    restartHostEnabled: false,
    restartHost: async (request) => { calls.push(request); return { mode: 'mac-app', deduped: false }; },
  });
  try {
    const res = await env.request({
      method: 'POST',
      path: RESTART_PATH,
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 501);
    assert.equal(parseBody(res)?.error?.code, 'host-restart-disabled');
    assert.match(parseBody(res)?.error?.message ?? '', /关闭/);
    assert.equal(calls.length, 0, '关闭后不得进入重启调度');
    const audit = env.auditEntries.filter((entry) => entry.action === 'host-restart').at(-1);
    assert.equal(audit.deviceId, 'd_test01');
    assert.equal(audit.result, 'failed');
    assert.equal(audit.hash, 'disabled');
  } finally {
    await env.remote.close();
    env.home.cleanup();
  }
});

test('设备 /status 暴露「重启主机」组件状态（默认关闭 / 开启两态）', async () => {
  for (const restartHostEnabled of [false, true]) {
    const env = await startServer({ restartHostEnabled, restartHost: async () => ({ mode: 'mac-app', deduped: false }) });
    try {
      const res = await env.request({ method: 'GET', path: STATUS_PATH });
      assert.equal(res.status, 200);
      assert.deepEqual(parseBody(res)?.data?.restart, { enabled: restartHostEnabled });
    } finally {
      await env.remote.close();
      env.home.cleanup();
    }
  }
});
