/**
 * 群体服务版部署方后台（/__admin）：token 鉴权、状态、邀请码、主机、静态页面。
 *
 * 用 group 模式 relay（dev / 控制面 http）+ 临时 group.json；不涉及边缘 TLS。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRelay, createInvite, ensureAdminToken } from '../index.js';
import { silentLogger } from './helpers/certs.js';

const BIN = fileURLToPath(new URL('../bin/relay.js', import.meta.url));
const ADMIN_TOKEN = 'test-admin-token-value-123456';

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-relay-admin-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** @param {number} port */
function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try { json = JSON.parse(text); } catch { json = undefined; }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.setTimeout(3000, () => req.destroy(new Error('admin request timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function startGroupRelay(overrides = {}) {
  const temp = tempDir();
  const file = join(temp.dir, 'group.json');
  const group = {
    file,
    mobilePort: 11443,
    registration: { enabled: true, maxAttemptsPerMinutePerIp: 50, maxAttemptsPerMinute: 500, bodyLimitBytes: 8192 },
    adminToken: ADMIN_TOKEN,
    ...(overrides.group ?? {}),
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
    ...(overrides.relay ?? {}),
  });
  return {
    relay,
    file,
    dir: temp.dir,
    async cleanup() {
      await relay.close();
      rmSync(temp.dir, { recursive: true, force: true });
    },
  };
}

const AUTH = { authorization: `Bearer ${ADMIN_TOKEN}` };

test('admin：静态页面 + token 鉴权 + 状态/邀请码/主机管理', async () => {
  const context = await startGroupRelay();
  const port = context.relay.controlPort;
  try {
    // 页面本身公开（不含数据）
    const page = await request(port, { path: '/__admin' });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'] ?? '', /text\/html/);
    assert.match(page.text, /群体服务后台/);
    assert.match(page.headers['content-security-policy'] ?? '', /default-src 'none'/);

    // token 鉴权
    assert.equal((await request(port, { path: '/__admin/api/state' })).status, 401);
    assert.equal((await request(port, { path: '/__admin/api/state', headers: { authorization: 'Bearer wrong' } })).status, 401);
    const state0 = await request(port, { path: '/__admin/api/state', headers: AUTH });
    assert.equal(state0.status, 200);
    assert.equal(state0.json.data.domain, 'relay.test');
    assert.equal(state0.json.data.mobilePort, 11443);
    assert.deepEqual(state0.json.data.hosts, []);
    assert.deepEqual(state0.json.data.invites, []);

    // 生成邀请码（明文 code 只返回一次）
    const created = await request(port, {
      method: 'POST',
      path: '/__admin/api/invites',
      headers: AUTH,
      body: { note: 'friend A', maxUses: 2, expiresInHours: 24 },
    });
    assert.equal(created.status, 200, created.text);
    assert.match(created.json.data.code, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(created.json.data.maxUses, 2);
    const inviteId = created.json.data.inviteId;

    const withInvite = await request(port, { path: '/__admin/api/state', headers: AUTH });
    assert.equal(withInvite.json.data.invites.length, 1);
    assert.equal(withInvite.json.data.invites[0].remaining, 2);

    // 用邀请码注册主机 → 后台可见（离线）
    const registration = await request(port, {
      method: 'POST',
      path: '/__group/register',
      body: { inviteCode: created.json.data.code, hostName: 'Friend Mac' },
    });
    assert.equal(registration.status, 200, registration.text);
    const hostId = registration.json.hostId;
    const withHost = await request(port, { path: '/__admin/api/state', headers: AUTH });
    assert.equal(withHost.json.data.hosts.length, 1);
    assert.equal(withHost.json.data.hosts[0].hostId, hostId);
    assert.equal(withHost.json.data.hosts[0].hostName, 'Friend Mac');
    assert.equal(withHost.json.data.hosts[0].online, false);

    // 撤销主机 / 撤销邀请码
    const revokedHost = await request(port, { method: 'POST', path: `/__admin/api/hosts/${hostId}/revoke`, headers: AUTH });
    assert.equal(revokedHost.status, 200);
    assert.equal(revokedHost.json.data.revoked, true);
    const afterHost = await request(port, { path: '/__admin/api/state', headers: AUTH });
    assert.equal(afterHost.json.data.hosts[0].revoked, true);

    const revokedInvite = await request(port, { method: 'POST', path: `/__admin/api/invites/${inviteId}/revoke`, headers: AUTH });
    assert.equal(revokedInvite.status, 200);
    const afterInvite = await request(port, { path: '/__admin/api/state', headers: AUTH });
    assert.equal(afterInvite.json.data.invites[0].revoked, true);

    // 参数/路径错误
    assert.equal((await request(port, { method: 'POST', path: '/__admin/api/invites', headers: AUTH, body: { maxUses: 0 } })).status, 400);
    assert.equal((await request(port, { method: 'POST', path: '/__admin/api/hosts/h_nope/revoke', headers: AUTH })).status, 404);
    assert.equal((await request(port, { path: '/__admin/api/nope', headers: AUTH })).status, 404);
  } finally {
    await context.cleanup();
  }
});

test('admin：未配置 token 时首次启动自动生成 0600 文件', async () => {
  const temp = tempDir();
  try {
    const file = join(temp.dir, 'group.json');
    const tokenFile = join(temp.dir, 'admin-token');
    const relay = await createRelay({
      domain: 'relay.test',
      dataPort: 0,
      controlPort: 0,
      httpPort: 0,
      dataHost: '127.0.0.1',
      dev: true,
      logger: silentLogger,
      mode: 'group',
      group: { file, adminTokenFile: tokenFile },
    });
    try {
      if (process.platform !== 'win32') assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
      const token = readFileSync(tokenFile, 'utf8').trim();
      assert.ok(token.length >= 40);
      const state = await request(relay.controlPort, { path: '/__admin/api/state', headers: { authorization: `Bearer ${token}` } });
      assert.equal(state.status, 200);
    } finally {
      await relay.close();
    }
  } finally {
    temp.cleanup();
  }
});

test('admin：classic 模式没有 /__admin（404）', async () => {
  const relay = await createRelay({
    domain: 'relay.test',
    dataPort: 0,
    controlPort: 0,
    httpPort: 0,
    dataHost: '127.0.0.1',
    dev: true,
    logger: silentLogger,
  });
  try {
    const res = await request(relay.controlPort, { path: '/__admin/api/state' });
    assert.equal(res.status, 404);
  } finally {
    await relay.close();
  }
});

test('CLI：admin-token 打印/生成 token，--json 可机器读', () => {
  const temp = tempDir();
  try {
    const groupFile = join(temp.dir, 'group.json');
    const result = spawnSync(process.execPath, [BIN, 'admin-token', '--group-file', groupFile, '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout.trim());
    assert.ok(parsed.token.length >= 40);
    assert.ok(parsed.tokenFile.endsWith('admin-token'));
    const again = spawnSync(process.execPath, [BIN, 'admin-token', '--group-file', groupFile, '--json'], { encoding: 'utf8' });
    assert.equal(JSON.parse(again.stdout.trim()).token, parsed.token, '第二次应读到同一 token');
    // 生成的 token 可直接用于 ensureAdminToken（同一文件）
    assert.equal(ensureAdminToken({ tokenFile: parsed.tokenFile }).token, parsed.token);
    // 邀请码函数与后台共用同一 store
    const invite = createInvite(groupFile, { maxUses: 1 });
    assert.ok(invite.code.length > 0);
  } finally {
    temp.cleanup();
  }
});
