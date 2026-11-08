/**
 * 「组件」保存路径回归（0.2.2：修复「允许手机重启主机 DSH」保存失败）。
 *
 * 背景（实测复现）：主机 config.enabled=true 但 config.groupServiceUrl 为空（注册信息只在
 * group.json）时，`updateConfig()` 里 `validateConfig` 会报「groupServiceUrl（服务地址）未配置」，
 * admin 返回 400 invalid-config → 桌面端任何保存（包括只切「组件」开关）都显示「保存失败」；
 * 同时 `#apply()` 会因校验失败把运行时拦住/重建。
 *
 * 覆盖：
 *   a) 历史配置缺 groupServiceUrl 但有 group.json 注册 → 启动时回填；保存 restartHostEnabled 200；
 *   b) 仅改 restartHostEnabled → 只持久化，不 stop/重建 group 运行时（隧道不重连）；
 *   c) 没有注册信息的历史遗留非法配置 → 保存 restartHostEnabled 也不被 400 阻塞；
 *   d) 真正非法的运行时改动（enabled=true 下显式清空 serviceUrl）仍返回 400（错误未被吞掉）。
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import { withTempHome } from './helpers.js';

const SERVICE_URL = 'http://127.0.0.1:1'; // 快速失败（ECONNREFUSED），测试不依赖网络
const HOST_ID = 'h_ab12cd34';
const RELAY_DOMAIN = 'relay.test';

function fakeResponse() {
  let status = 0;
  let body = '';
  return {
    writeHead(nextStatus) { status = nextStatus; },
    end(chunk) { body = chunk === undefined ? '' : String(chunk); },
    get status() { return status; },
    get body() { return body; },
  };
}

/** adminHandler 用 `for await (const chunk of req)` 读 body。 */
function fakeRequest({ path, method = 'POST', body }) {
  const payload = Buffer.from(JSON.stringify(body ?? {}), 'utf8');
  return {
    url: path,
    method,
    headers: { 'content-type': 'application/json' },
    socket: {},
    async *[Symbol.asyncIterator]() { yield payload; },
  };
}

async function postConfig(handler, patch) {
  const res = fakeResponse();
  await handler(fakeRequest({ path: '/api/remote-access/config', body: patch }), res);
  let json;
  try { json = JSON.parse(res.body); } catch { json = undefined; }
  return { status: res.status, body: res.body, json };
}

function fakeCtx() {
  return {
    webServer: { protocol: 'http:', port: 1, getOrigin: () => 'http://127.0.0.1:1/' },
    connection: { authenticatedUrl: (origin) => `${origin}?token=test` },
  };
}

async function makeService(options = {}) {
  const { RemoteService } = await import('../lib/service.js');
  const service = new RemoteService(fakeCtx(), options);
  await service.ready;
  return service;
}

/** 发一条请求到主机 loopback 明文代理（模拟通过隧道到达的 App 请求）。 */
function plainRequest(port, { path, method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path, method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, raw: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function makeAdmin(service) {
  const { createAdminHandler } = await import('../lib/admin.js');
  return createAdminHandler({ ctx: {}, service, authDisabled: true });
}

/**
 * 模拟「早前版本已注册」：注册信息只在 group.json。
 * @returns {Promise<{privateKey: import('node:crypto').KeyObject}>} relay 侧签名私钥（测试签 token 用）
 */
async function saveRegistration(serviceUrl = SERVICE_URL) {
  const { saveGroupRegistration } = await import('../lib/group.js');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  saveGroupRegistration({
    serviceUrl,
    hostId: HOST_ID,
    hostToken: 'test-host-token',
    relayDomain: RELAY_DOMAIN,
    mobilePort: 11443,
    tokenPublicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    hostName: 'Example Host',
  });
  return { privateKey };
}

test('历史配置缺 groupServiceUrl 但有注册：启动回填，保存 restartHostEnabled 返回 200 且状态同步', async () => {
  const home = withTempHome();
  const { saveConfig, loadConfig } = await import('../lib/config.js');
  try {
    await saveRegistration();
    // 模拟旧版落盘的配置：enabled=true，但没有 groupServiceUrl（注册信息只在 group.json）
    saveConfig({ enabled: true, groupServiceUrl: '', groupInsecure: true, restartHostEnabled: false });
    assert.equal(loadConfig().groupServiceUrl, '', '前置条件：配置里没有服务地址');

    const service = await makeService();
    try {
      // 启动迁移：用 group.json 的 serviceUrl 回填并落盘，运行时不再被校验拦住
      assert.equal(loadConfig().groupServiceUrl, SERVICE_URL, '启动时应从 group.json 回填 groupServiceUrl');
      assert.equal(service.status().config.groupServiceUrl, SERVICE_URL);
      assert.doesNotMatch(String(service.lastError ?? ''), /groupServiceUrl/, '回填后不应再报「服务地址未配置」');

      const handler = await makeAdmin(service);
      const result = await postConfig(handler, { restartHostEnabled: true });
      assert.equal(result.status, 200, `保存应成功，实际：${result.status} ${result.body}`);
      assert.equal(result.json.ok, true);
      assert.equal(result.json.data.config.restartHostEnabled, true);
      assert.equal(result.json.data.restart.enabled, true);

      // 落盘 + 管理状态一致
      assert.equal(loadConfig().restartHostEnabled, true);
      assert.equal(service.status().config.restartHostEnabled, true);
      assert.equal(service.status().restart.enabled, true);
    } finally {
      await service.dispose();
    }
  } finally {
    home.cleanup();
  }
});

test('仅改 restartHostEnabled：只持久化，不 stop/重建 group 运行时（隧道不重连）', async () => {
  const home = withTempHome();
  const { saveConfig, loadConfig } = await import('../lib/config.js');
  try {
    saveConfig({ enabled: false, groupServiceUrl: SERVICE_URL, groupInsecure: true, restartHostEnabled: false });
    const service = await makeService();
    try {
      // 模拟「正在运行的群体运行时」：只关心它是否被 #apply 停掉/替换
      const fakeRuntime = {
        stopped: 0,
        closedClients: 0,
        closeOptions: undefined,
        config: { restartHostEnabled: false },
        async stop() { this.stopped += 1; },
        closeUpgradedConnections(options) { this.closedClients += 1; this.closeOptions = options; return 1; },
        status() { return { registered: false, connected: false }; },
      };
      service.groupRuntime = fakeRuntime;
      const before = service.groupRuntime;

      const result = await service.updateConfig({ restartHostEnabled: true });
      assert.equal(result.applied, false, '纯状态字段保存不应重建运行时');
      assert.equal(result.errors.length, 0);
      assert.equal(service.groupRuntime, before, '运行时实例不应被替换');
      assert.equal(fakeRuntime.stopped, 0, '运行时不应被 stop（隧道不断开）');
      assert.equal(loadConfig().restartHostEnabled, true);
      assert.equal(service.status().config.restartHostEnabled, true);
      assert.equal(service.status().restart.enabled, true);
      assert.equal(
        fakeRuntime.config.restartHostEnabled,
        true,
        '运行中实例的 config 引用应同步（隧道内 status/restart 立即生效，不等下次重建）',
      );
      assert.equal(fakeRuntime.closedClients, 1, '组件开关变化应断开 WebSocket 连接以触发 App 即时刷新');
      assert.equal(
        fakeRuntime.closeOptions,
        undefined,
        '应按默认行为调用（只断 /api/remote.mux 主实时通道，不传 path 表示默认值）',
      );

      // 对照：运行时相关字段变化才 rebuild（此时 enabled=false→true，会先 stop 旧 fake runtime）
      const next = await service.updateConfig({ enabled: true });
      assert.equal(next.applied, true, '运行时字段变化必须重建');
      assert.equal(fakeRuntime.stopped, 1, '应 stop 旧运行时');
    } finally {
      await service.dispose();
    }
  } finally {
    home.cleanup();
  }
});

test('历史遗留非法配置（无注册、enabled=true、serviceUrl 空）：组件保存不被 400 阻塞', async () => {
  const home = withTempHome();
  const { saveConfig, loadConfig } = await import('../lib/config.js');
  try {
    saveConfig({ enabled: true, groupServiceUrl: '', groupInsecure: false, restartHostEnabled: false });
    const service = await makeService();
    try {
      // 启动时确实有历史错误（没有可回填的注册信息）
      assert.match(String(service.lastError ?? ''), /groupServiceUrl/);

      const handler = await makeAdmin(service);
      const result = await postConfig(handler, { restartHostEnabled: true });
      assert.equal(result.status, 200, `纯状态保存不应被历史校验阻塞，实际：${result.status} ${result.body}`);
      assert.equal(result.json.data.config.restartHostEnabled, true);
      assert.equal(result.json.data.restart.enabled, true);
      assert.equal(loadConfig().restartHostEnabled, true);
      // 历史错误仍保留在 group.lastError 里（用户仍能看到「服务地址未配置」提示）
      assert.match(String(service.status().group.lastError ?? ''), /groupServiceUrl/);
    } finally {
      await service.dispose();
    }
  } finally {
    home.cleanup();
  }
});

test('真正的非法运行时改动仍返回 400（错误没有被吞掉）', async () => {
  const home = withTempHome();
  const { saveConfig } = await import('../lib/config.js');
  try {
    saveConfig({ enabled: true, groupServiceUrl: SERVICE_URL, groupInsecure: true });
    const service = await makeService();
    try {
      const handler = await makeAdmin(service);
      // enabled=true 时显式清空服务地址：这是运行时字段且非法 → 仍应 400 invalid-config
      const result = await postConfig(handler, { groupServiceUrl: '' });
      assert.equal(result.status, 400, result.body);
      assert.equal(result.json.error.code, 'invalid-config');
      assert.match(result.json.error.message, /groupServiceUrl/);
    } finally {
      await service.dispose();
    }
  } finally {
    home.cleanup();
  }
});

test('端到端：组件开关保存后，隧道内 status/restart 立即生效（不重连隧道、无需重启 DSH）', async () => {
  const home = withTempHome();
  const { saveConfig, loadConfig } = await import('../lib/config.js');
  const { GROUP_SESSION_COOKIE, STATUS_PATH, signGroupSessionToken } = await import('dsh-remote-protocol');
  const { RESTART_PATH } = await import('../lib/group.js');
  try {
    const { privateKey } = await saveRegistration();
    // 历史配置：enabled=true 且没有 groupServiceUrl（启动时迁移回填）
    saveConfig({ enabled: true, groupServiceUrl: '', groupInsecure: true, restartHostEnabled: false });
    const spawnCalls = [];
    const service = await makeService({
      hostRestartDedupeMs: 10_000,
      hostRestartEnv: {},
      // 绝不真重启：记录调度参数即可
      spawnHostRestart: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { pid: 4242, unref: () => {} };
      },
    });
    try {
      const runtime = service.groupRuntime;
      assert.ok(runtime, '回填 serviceUrl 后 loopback 运行时应已启动');
      const port = runtime.plainPort;
      assert.ok(port > 0, 'loopback 明文代理应已监听');

      // 已配对设备 + relay 侧签发的短时 token（模拟 App 经隧道访问）
      const deviceId = 'd_ab12cd34ef567890';
      service.devices.add({ id: deviceId, name: 'Test iPhone', platform: 'ios', groupPublicKey: 'pk-test' });
      const token = signGroupSessionToken({ privateKey, hostId: HOST_ID, deviceId }).token;
      const cookie = `${GROUP_SESSION_COOKIE}=${token}`;
      const fqdn = `${HOST_ID}.${RELAY_DOMAIN}`;
      const call = (path, options = {}) => plainRequest(port, {
        ...options,
        path,
        headers: { host: fqdn, cookie, ...(options.headers ?? {}) },
      });

      // 保存前：隧道内 status.restart.enabled=false，重启接口 501
      const before = await call(STATUS_PATH);
      assert.equal(before.status, 200, before.raw);
      assert.equal(JSON.parse(before.raw).data.restart.enabled, false);
      assert.equal((await call(RESTART_PATH, { method: 'POST' })).status, 501);

      // 桌面端只切「组件」开关 → 只持久化，不重建运行时（同一实例/端口；隧道不重连）
      const result = await service.updateConfig({ restartHostEnabled: true });
      assert.equal(result.applied, false);
      assert.equal(service.groupRuntime, runtime, '运行时实例不应被替换');
      assert.equal(service.groupRuntime.plainPort, port, 'loopback 端口不变（隧道未重连）');

      // 保存后：隧道内 status 立即 true，POST restart 立即 202（无需重启 DSH）
      const after = await call(STATUS_PATH);
      assert.equal(JSON.parse(after.raw).data.restart.enabled, true);
      const restarted = await call(RESTART_PATH, { method: 'POST' });
      assert.equal(restarted.status, 202, restarted.raw);
      const body = JSON.parse(restarted.raw);
      assert.equal(body.data.restarting, true);
      assert.equal(body.data.mode, 'node');
      assert.equal(spawnCalls.length, 1, '应调度一次重启 helper（fake spawn，绝不真重启）');
      assert.equal(loadConfig().restartHostEnabled, true);
    } finally {
      await service.dispose();
    }
  } finally {
    home.cleanup();
  }
});

test('「推送提醒」：默认开启；保存 pushEnabled 只持久化、不重建运行时（隧道不重连）', async () => {
  const home = withTempHome();
  const { saveConfig, loadConfig } = await import('../lib/config.js');
  try {
    saveConfig({ enabled: false, groupServiceUrl: SERVICE_URL, groupInsecure: true });
    assert.equal(loadConfig().pushEnabled, true, 'pushEnabled 默认 true');
    const service = await makeService();
    try {
      assert.equal(service.status().config.pushEnabled, true);
      assert.equal(service.status().push.enabled, true);
      // 模拟「正在运行的群体运行时」：status.push.enabled 读自身 config（与真实运行时一致）
      const fakeRuntime = {
        stopped: 0,
        config: { pushEnabled: true },
        async stop() { this.stopped += 1; },
        closeUpgradedConnections() { return 0; },
        status() {
          return {
            registered: false,
            connected: false,
            push: {
              enabled: this.config.pushEnabled !== false,
              self: { devices: 0, lastError: null },
              official: { devices: 0, lastError: null, hub: null },
              mode: '',
            },
          };
        },
      };
      service.groupRuntime = fakeRuntime;

      const result = await service.updateConfig({ pushEnabled: false });
      assert.equal(result.applied, false, '推送开关保存不应重建运行时');
      assert.equal(result.errors.length, 0);
      assert.equal(service.groupRuntime, fakeRuntime, '运行时实例不应被替换');
      assert.equal(fakeRuntime.stopped, 0, '隧道不应断开');
      assert.equal(fakeRuntime.config.pushEnabled, false, '运行中实例 config 引用应同步');
      assert.equal(loadConfig().pushEnabled, false);
      assert.equal(service.status().config.pushEnabled, false);
      assert.equal(service.status().push.enabled, false);

      // 再打开回来：同样只持久化
      const back = await service.updateConfig({ pushEnabled: true });
      assert.equal(back.applied, false);
      assert.equal(fakeRuntime.stopped, 0);
      assert.equal(loadConfig().pushEnabled, true);
      assert.equal(service.status().push.enabled, true);

      // 对照：真正的运行时字段变化才 rebuild
      const next = await service.updateConfig({ enabled: true });
      assert.equal(next.applied, true, '运行时字段变化必须重建');
      assert.equal(fakeRuntime.stopped, 1, '应 stop 旧运行时');
    } finally {
      await service.dispose();
    }
  } finally {
    home.cleanup();
  }
});
