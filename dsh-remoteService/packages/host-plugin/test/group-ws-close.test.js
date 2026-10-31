/**
 * 组件开关保存后的 WS 断开收窄（0.2.4）：只断 DSH 主实时通道 `/api/remote.mux`。
 *
 * 背景（用户实测 0.2.3）：保存「允许手机重启主机 DSH」时断开了**所有** Upgrade/WS 连接；
 * App 会为每个 WebSocket 上报 `dsh-ws-close`，同一瞬间多个 close 把它的自动恢复预算
 * （60s 内 2 次）一次耗尽 → 显示「自动重连未恢复，请点击刷新重试」。
 *
 * 本测试直接驱动 GroupHostRuntime 的 loopback 明文代理：
 *   - `plainServer.on('upgrade')` 记录 socket → pathname；
 *   - 默认 `closeUpgradedConnections()` 只销毁 `/api/remote.mux`（含 query 变体），其它保留；
 *   - `closeUpgradedConnections({ path })` 可定向；空 path 不做任何事；重复调用返回 0；
 *   - 客户端主动断开 / 未鉴权被拒的 Upgrade 不残留计数。
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import net from 'node:net';
import test from 'node:test';
import {
  GROUP_SESSION_COOKIE,
  signGroupSessionToken,
} from 'dsh-remote-protocol';
import { GroupHostRuntime, saveGroupRegistration } from '../lib/group.js';
import { REMOTE_STREAM_MUX_PATH } from '../lib/proxy.js';
import { waitFor, withTempHome } from './helpers.js';

const HOST_ID = 'h_testwsclose';
const RELAY_DOMAIN = 'relay.test';
const FQDN = `${HOST_ID}.${RELAY_DOMAIN}`;
const DEVICE_ID = 'd_testdevice01';
const OTHER_WS_PATH = '/plugins/demo.ws';

/** 起一个「已注册 + loopback 明文代理」的运行时；proxy.handleUpgrade 接受升级后保持连接。 */
async function setupRuntime() {
  const home = withTempHome();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  saveGroupRegistration({
    serviceUrl: 'http://127.0.0.1:1',
    hostId: HOST_ID,
    hostToken: 'test-host-token',
    relayDomain: RELAY_DOMAIN,
    mobilePort: 11443,
    tokenPublicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    hostName: 'WS Close Test Host',
  });
  const runtime = new GroupHostRuntime({
    config: { groupPlainPort: 0, restartHostEnabled: true },
    devices: {
      list: () => [{ id: DEVICE_ID, name: 'Test iPhone', platform: 'ios', groupPublicKey: 'pk-test', revokedAt: null }],
      touchById: () => {},
    },
    proxy: {
      handle: async (req, res) => { res.writeHead(200); res.end('ok'); },
      // 写回 101 后保持 socket 打开（模拟真实 DSH 实时通道/插件 WS）。
      // resume() 让 socket 进入 flowing 模式（真实 DshProxy 会 pipe 数据）；否则对端 FIN
      // 不会被读取，server 侧迟迟收不到 close，跟踪表不会清理。
      handleUpgrade(req, socket) {
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        socket.resume();
      },
    },
    audit: { append: () => {} },
    log: () => {},
    version: '0.2.4-test',
  });
  await runtime.startPlainProxy();
  const token = signGroupSessionToken({ privateKey, hostId: HOST_ID, deviceId: DEVICE_ID }).token;
  return { home, runtime, token, port: runtime.plainPort };
}

/** 打开一条 Upgrade（WebSocket 握手）连接；返回 socket 与 101 响应文本。 */
function openUpgrade({ port, path, token }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${FQDN}\r\nCookie: ${GROUP_SESSION_COOKIE}=${token}\r\n`
        + 'Connection: Upgrade\r\nUpgrade: websocket\r\n'
        + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
      );
    });
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      if (!buffer.includes('\r\n\r\n')) return;
      socket.off('data', onData);
      socket.off('error', reject);
      if (!buffer.startsWith('HTTP/1.1 101')) {
        reject(new Error(`unexpected upgrade response: ${buffer.slice(0, 160)}`));
        return;
      }
      resolve({ socket, response: buffer });
    };
    socket.on('data', onData);
    socket.on('error', reject);
    socket.setTimeout(5000, () => reject(new Error('upgrade timeout')));
  });
}

/** 发一条未鉴权/无效的 Upgrade，等连接结束；返回服务端响应文本。 */
function upgradeExpectClosed({ port, path, token }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      const cookie = token === undefined ? '' : `Cookie: ${GROUP_SESSION_COOKIE}=${token}\r\n`;
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${FQDN}\r\n${cookie}`
        + 'Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      );
    });
    let buffer = '';
    socket.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
    socket.on('error', reject);
    socket.on('close', () => resolve(buffer));
    socket.setTimeout(5000, () => reject(new Error('timeout waiting for upgrade rejection')));
  });
}

async function destroyQuietly(socket) {
  try { socket.destroy(); } catch { /* ignore */ }
}

async function cleanup(env) {
  try { await env.runtime.stop(); } catch { /* ignore */ }
  env.home.cleanup();
}

test('REMOTE_STREAM_MUX_PATH 常量与 DSH 主实时通道一致', () => {
  assert.equal(REMOTE_STREAM_MUX_PATH, '/api/remote.mux');
});

test('Upgrade 跟踪路径：默认只断开 /api/remote.mux，其它 WS 保留', async () => {
  const env = await setupRuntime();
  try {
    const mux = await openUpgrade({ port: env.port, path: REMOTE_STREAM_MUX_PATH, token: env.token });
    const other = await openUpgrade({ port: env.port, path: OTHER_WS_PATH, token: env.token });
    try {
      assert.deepEqual(
        [...env.runtime.plainUpgradeConnections.values()].sort(),
        [REMOTE_STREAM_MUX_PATH, OTHER_WS_PATH].sort(),
        '应记录每条 Upgrade 的 pathname',
      );

      const muxClosed = once(mux.socket, 'close');
      assert.equal(env.runtime.closeUpgradedConnections(), 1, '默认只断主实时通道');
      await muxClosed;
      assert.equal(mux.socket.destroyed, true, 'mux 连接应被断开');
      assert.equal(other.socket.destroyed, false, '其它 WebSocket 不应被断开');
      assert.deepEqual(
        [...env.runtime.plainUpgradeConnections.values()],
        [OTHER_WS_PATH],
        '只移除已断开的 mux 连接',
      );

      // 重复调用不重复计数；仍保留的其它 WS 不受影响
      assert.equal(env.runtime.closeUpgradedConnections(), 0);
      assert.equal(other.socket.destroyed, false);

      // 需要时可定向断开指定路径
      const otherClosed = once(other.socket, 'close');
      assert.equal(env.runtime.closeUpgradedConnections({ path: OTHER_WS_PATH }), 1);
      await otherClosed;
      assert.equal(other.socket.destroyed, true);
      assert.equal(env.runtime.plainUpgradeConnections.size, 0);
    } finally {
      await destroyQuietly(mux.socket);
      await destroyQuietly(other.socket);
    }
  } finally {
    await cleanup(env);
  }
});

test('Upgrade 跟踪路径：mux 的 query 变体也按 pathname 命中；未知/空 path 不断开任何连接', async () => {
  const env = await setupRuntime();
  try {
    const muxWithQuery = await openUpgrade({ port: env.port, path: `${REMOTE_STREAM_MUX_PATH}?dsh_mobile=1`, token: env.token });
    const other = await openUpgrade({ port: env.port, path: OTHER_WS_PATH, token: env.token });
    try {
      // 未知路径 / 空白 path 不做任何事
      assert.equal(env.runtime.closeUpgradedConnections({ path: '/nope' }), 0);
      assert.equal(env.runtime.closeUpgradedConnections({ path: '   ' }), 0);
      assert.equal(muxWithQuery.socket.destroyed, false);
      assert.equal(other.socket.destroyed, false);

      // 默认 path 按 pathname 匹配（query 被忽略）
      const closed = once(muxWithQuery.socket, 'close');
      assert.equal(env.runtime.closeUpgradedConnections(), 1);
      await closed;
      assert.equal(muxWithQuery.socket.destroyed, true);
      assert.equal(other.socket.destroyed, false);

      // 显式传默认路径等价于默认行为
      assert.equal(env.runtime.closeUpgradedConnections({ path: REMOTE_STREAM_MUX_PATH }), 0);
      assert.equal(other.socket.destroyed, false);
    } finally {
      await destroyQuietly(muxWithQuery.socket);
      await destroyQuietly(other.socket);
    }
  } finally {
    await cleanup(env);
  }
});

test('客户端主动断开 / 未鉴权被拒的 Upgrade 不会残留跟踪（避免误计数）', async () => {
  const env = await setupRuntime();
  try {
    // 1) 客户端自己断开：close 事件后从跟踪表移除
    const clientClosed = await openUpgrade({ port: env.port, path: REMOTE_STREAM_MUX_PATH, token: env.token });
    const closed = once(clientClosed.socket, 'close');
    clientClosed.socket.destroy();
    await closed;
    await waitFor(() => env.runtime.plainUpgradeConnections.size === 0);
    assert.equal(env.runtime.closeUpgradedConnections(), 0, '已关闭的连接不应再被计数');

    // 2) 未鉴权 Upgrade 被 401 拒绝：结束后也不残留
    const rejected = await upgradeExpectClosed({ port: env.port, path: REMOTE_STREAM_MUX_PATH, token: undefined });
    assert.match(rejected, /^HTTP\/1\.1 401/);
    await waitFor(() => env.runtime.plainUpgradeConnections.size === 0);
    assert.equal(env.runtime.closeUpgradedConnections(), 0);
  } finally {
    await cleanup(env);
  }
});
