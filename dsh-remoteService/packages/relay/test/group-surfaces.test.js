/**
 * P1 切片 9：职责分离——控制面只做 WSS 隧道，注册 API 与部署方后台各自独立监听。
 *
 * 断言：
 *   - 配置 apiPort/adminPort 后，控制面不再提供 /__group/register 与 /__admin（404）；
 *   - 注册 API 面只服务 POST /__group/register，其它 404；
 *   - 后台面服务 /__admin 页面/API（admin token），其它 404；
 *   - 未配置时保持旧行为（由 group-admin / group-runtime 测试覆盖）。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createInvite, createRelay } from '../index.js';
import { silentLogger } from './helpers/certs.js';

const ADMIN_TOKEN = 'surfaces-admin-token-1234567890';

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
    req.setTimeout(3000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function tempGroup() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-relay-surfaces-'));
  const file = join(dir, 'group.json');
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const AUTH = { authorization: `Bearer ${ADMIN_TOKEN}` };

test('职责分离：控制面 WSS-only；注册 API / 后台各自独立监听', async () => {
  const temp = tempGroup();
  const relay = await createRelay({
    domain: 'relay.test',
    dataPort: 0,
    controlPort: 0,
    httpPort: 0,
    dataHost: '127.0.0.1',
    dev: true,
    logger: silentLogger,
    mode: 'group',
    group: {
      file: temp.file,
      mobilePort: 1443,
      adminToken: ADMIN_TOKEN,
      apiPort: 0,
      adminPort: 0,
      adminBind: '127.0.0.1',
    },
  });
  try {
    assert.ok(relay.groupApiPort > 0, '注册 API 独立端口应已监听');
    assert.ok(relay.groupAdminPort > 0, '后台独立端口应已监听');
    assert.notEqual(relay.groupApiPort, relay.controlPort);
    assert.notEqual(relay.groupAdminPort, relay.controlPort);
    assert.notEqual(relay.groupApiPort, relay.groupAdminPort);

    // 邀请码
    const invite = createInvite(temp.file, { note: 'surface test', maxUses: 1 });

    // 控制面：只接受 WSS upgrade（普通 HTTP 全部 404）
    const controlRegister = await request(relay.controlPort, {
      method: 'POST',
      path: '/__group/register',
      body: { inviteCode: invite.code },
    });
    assert.equal(controlRegister.status, 404);
    assert.match(controlRegister.json.error.message, /WebSocket upgrades/);
    const controlAdmin = await request(relay.controlPort, { path: '/__admin/api/state', headers: AUTH });
    assert.equal(controlAdmin.status, 404);

    // 注册 API 面：只服务 /__group/register
    const apiAdmin = await request(relay.groupApiPort, { path: '/__admin/api/state', headers: AUTH });
    assert.equal(apiAdmin.status, 404);
    assert.match(apiAdmin.json.error.message, /register only/);
    const registered = await request(relay.groupApiPort, {
      method: 'POST',
      path: '/__group/register',
      body: { inviteCode: invite.code, hostName: 'Surface Host' },
    });
    assert.equal(registered.status, 200, registered.text);
    assert.equal(registered.json.hostName, 'Surface Host');
    assert.ok(registered.json.hostId.startsWith('h_'));
    // 注册响应必须下发「控制面 WSS」地址（与注册 API 端口不同）
    assert.match(registered.json.controlUrl, /^ws:\/\/127\.0\.0\.1:\d+\/control$/);
    assert.notEqual(new URL(registered.json.controlUrl).port, String(relay.groupApiPort));
    assert.equal(Number(new URL(registered.json.controlUrl).port), relay.controlPort);

    // 后台面：页面无需 token；API 需要 token；其它路径 404
    const page = await request(relay.groupAdminPort, { path: '/__admin' });
    assert.equal(page.status, 200);
    assert.match(page.text, /群体服务后台/);
    assert.equal((await request(relay.groupAdminPort, { path: '/__admin/api/state' })).status, 401);
    const state = await request(relay.groupAdminPort, { path: '/__admin/api/state', headers: AUTH });
    assert.equal(state.status, 200, state.text);
    assert.equal(state.json.data.hosts.length, 1);
    assert.equal(state.json.data.hosts[0].hostName, 'Surface Host');
    assert.equal(state.json.data.mobilePort, 1443);
    const adminRegister = await request(relay.groupAdminPort, {
      method: 'POST',
      path: '/__group/register',
      body: { inviteCode: invite.code },
    });
    assert.equal(adminRegister.status, 404);
    assert.equal((await request(relay.groupAdminPort, { path: '/nope' })).status, 404);
  } finally {
    await relay.close();
    temp.cleanup();
  }
});

test('职责分离：adminBind 默认回环（不配 apiPort/adminPort 时仍走控制面兜底）', async () => {
  const temp = tempGroup();
  const relay = await createRelay({
    domain: 'relay.test',
    dataPort: 0,
    controlPort: 0,
    httpPort: 0,
    dataHost: '127.0.0.1',
    dev: true,
    logger: silentLogger,
    mode: 'group',
    group: { file: temp.file, adminToken: ADMIN_TOKEN },
  });
  try {
    // 兼容旧行为：未配置独立监听 → 控制面继续提供注册/后台
    assert.equal(relay.groupApiPort, 0);
    assert.equal(relay.groupAdminPort, 0);
    const invite = createInvite(temp.file, { maxUses: 1 });
    const reg = await request(relay.controlPort, {
      method: 'POST',
      path: '/__group/register',
      body: { inviteCode: invite.code },
    });
    assert.equal(reg.status, 200, reg.text);
    const admin = await request(relay.controlPort, { path: '/__admin/api/state', headers: AUTH });
    assert.equal(admin.status, 200);
  } finally {
    await relay.close();
    temp.cleanup();
  }
});
