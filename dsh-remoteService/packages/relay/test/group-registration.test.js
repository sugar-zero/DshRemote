/**
 * 群体服务版（A 模式）P1 切片：邀请码 → 主机自助注册。
 *
 * 覆盖：存储 hash/权限、邀请消费/过期/撤销、hostId 分配、host token 校验与撤销、
 * relay 注册 HTTP 端点（成功/错误码/限流/关闭注册/上限）、classic 模式不受影响、CLI。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  GROUP_REGISTER_ERROR,
  GROUP_REGISTER_PATH,
  isGroupHostId,
} from 'dsh-remote-protocol';
import {
  createInvite,
  createRelay,
  defaultGroupFile,
  listHosts,
  listInvites,
  refreshHost,
  registerHost,
  revokeHost,
  revokeInvite,
  verifyHostToken,
} from '../index.js';
import { silentLogger } from './helpers/certs.js';

const BIN = fileURLToPath(new URL('../bin/relay.js', import.meta.url));

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-relay-group-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** @param {string[]} args */
function runCli(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

/**
 * 起一个 group 模式 relay（dev/无 TLS，临时端口 + 临时 group.json）。
 * @param {{group?: Record<string, any>, relay?: Record<string, any>}} [overrides]
 */
async function startGroupRelay(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-relay-group-'));
  const file = join(dir, 'group.json');
  const group = {
    file,
    mobilePort: 11443,
    maxHosts: 50,
    registration: {
      enabled: true,
      maxAttemptsPerMinutePerIp: 20,
      maxAttemptsPerMinute: 200,
      bodyLimitBytes: 8192,
    },
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
    dir,
    async cleanup() {
      await relay.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * POST 注册请求。
 * @param {number} port
 * @param {any} body
 */
function postRegister(port, body) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: GROUP_REGISTER_PATH,
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
          resolve({ status: res.statusCode, headers: res.headers, json, raw });
        });
      },
    );
    req.setTimeout(3000, () => req.destroy(new Error('registration request timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

/** @param {number} port */
function getRegister(port) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: GROUP_REGISTER_PATH }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      })
      .on('error', reject);
  });
}

test('group store: invite/token stored hashed (0600), invite single-use, revoke works', () => {
  const temp = tempDir();
  try {
    const file = join(temp.dir, 'group.json');
    const invite = createInvite(file, { note: 'friend A', maxUses: 1 });
    assert.match(invite.code, /^[A-Za-z0-9_-]{40,}$/, 'invite code is 32 random bytes (base64url)');
    assert.equal(invite.maxUses, 1);
    assert.ok(invite.expiresAt > Date.now());

    const raw = readFileSync(file, 'utf8');
    assert.equal(raw.includes(invite.code), true, 'invite code is stored plaintext for admin/CLI display');
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600, 'group.json must be 0600');

    const invites = listInvites(file);
    assert.deepEqual(invites.map((entry) => entry.inviteId), [invite.inviteId]);
    assert.equal(invites[0].code, invite.code, 'listInvites returns plaintext code for admin display');
    assert.equal(invites[0].remaining, 1);

    const registration = registerHost({ file, inviteCode: invite.code, hostName: '  Friend Mac  ', mobilePort: 11443 });
    assert.ok(isGroupHostId(registration.hostId), `hostId must be server-assigned h_...: ${registration.hostId}`);
    assert.match(registration.hostToken, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(registration.hostName, 'Friend Mac');
    assert.equal(registration.mobilePort, 11443);

    const rawAfter = readFileSync(file, 'utf8');
    assert.equal(rawAfter.includes(registration.hostToken), false, 'host token must not be stored in plaintext');

    const hosts = listHosts(file);
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].hostId, registration.hostId);
    assert.equal(hosts[0].hostName, 'Friend Mac');
    assert.equal(hosts[0].revoked, false);

    // 刷新注册信息：hostToken 鉴权、不消耗邀请码、可同步新的 mobilePort
    assert.throws(
      () => refreshHost(file, { hostId: registration.hostId, hostToken: 'wrong-token' }),
      (error) => error.code === 'invalid_token',
    );
    const refreshed = refreshHost(file, { hostId: registration.hostId, hostToken: registration.hostToken, mobilePort: 15555 });
    assert.equal(refreshed.mobilePort, 15555);
    assert.equal(listHosts(file)[0].mobilePort, 15555);
    assert.equal(hosts[0].revoked, false);

    const used = listInvites(file)[0];
    assert.equal(used.used, 1);
    assert.equal(used.remaining, 0);

    // 邀请码单次用尽 → 拒绝
    assert.throws(
      () => registerHost({ file, inviteCode: invite.code, hostName: 'second' }),
      (err) => err.code === GROUP_REGISTER_ERROR.INVITE_EXHAUSTED,
    );
    // 无效邀请码
    assert.throws(
      () => registerHost({ file, inviteCode: 'not-a-real-code', hostName: 'x' }),
      (err) => err.code === GROUP_REGISTER_ERROR.INVALID_INVITE,
    );

    // host token 校验 + 撤销
    assert.equal(verifyHostToken(file, registration.hostId, registration.hostToken), true);
    assert.equal(verifyHostToken(file, registration.hostId, `${registration.hostToken}x`), false);
    assert.equal(revokeHost(file, registration.hostId), true);
    assert.equal(verifyHostToken(file, registration.hostId, registration.hostToken), false);
    assert.equal(listHosts(file)[0].revoked, true);

    // 撤销邀请后不能再注册
    const invite2 = createInvite(file, { maxUses: 5 });
    assert.equal(revokeInvite(file, invite2.code), true);
    assert.throws(
      () => registerHost({ file, inviteCode: invite2.code }),
      (err) => err.code === GROUP_REGISTER_ERROR.INVALID_INVITE,
    );

    // 过期邀请
    const expired = createInvite(file, { now: Date.now() - 10_000, expiresInMs: 1000 });
    assert.throws(
      () => registerHost({ file, inviteCode: expired.code }),
      (err) => err.code === GROUP_REGISTER_ERROR.INVITE_EXPIRED,
    );

    assert.equal(defaultGroupFile('/etc/dsh-relay/relay.json'), '/etc/dsh-relay/group.json');
  } finally {
    temp.cleanup();
  }
});

test('relay group mode: POST /__group/register issues hostId/token/port and enforces invite uses', async () => {
  const context = await startGroupRelay();
  try {
    const invite = createInvite(context.file, { note: 'family', maxUses: 2 });

    const first = await postRegister(context.relay.controlPort, { inviteCode: invite.code, hostName: 'Living Room Mac' });
    assert.equal(first.status, 200, first.raw);
    assert.equal(first.headers['cache-control'], 'no-store');
    assert.equal(first.json.ok, true);
    assert.equal(first.json.protocolVersion, 1);
    assert.ok(isGroupHostId(first.json.hostId));
    assert.match(first.json.hostToken, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(first.json.hostName, 'Living Room Mac');
    assert.equal(first.json.mobilePort, 11443);

    const second = await postRegister(context.relay.controlPort, { inviteCode: invite.code });
    assert.equal(second.status, 200, 'maxUses=2 allows a second host');
    assert.notEqual(second.json.hostId, first.json.hostId);

    const exhausted = await postRegister(context.relay.controlPort, { inviteCode: invite.code });
    assert.equal(exhausted.status, 403);
    assert.equal(exhausted.json.error.code, GROUP_REGISTER_ERROR.INVITE_EXHAUSTED);

    const unknown = await postRegister(context.relay.controlPort, { inviteCode: 'nope' });
    assert.equal(unknown.status, 403);
    assert.equal(unknown.json.error.code, GROUP_REGISTER_ERROR.INVALID_INVITE);

    const malformed = await postRegister(context.relay.controlPort, 'this is not json');
    assert.equal(malformed.status, 400);
    assert.equal(malformed.json.error.code, GROUP_REGISTER_ERROR.INVALID_REQUEST);

    const tooLarge = await postRegister(context.relay.controlPort, { inviteCode: 'x'.repeat(9000) });
    assert.equal(tooLarge.status, 400);
    assert.equal(tooLarge.json.error.code, GROUP_REGISTER_ERROR.INVALID_REQUEST);

    const wrongMethod = await getRegister(context.relay.controlPort);
    assert.equal(wrongMethod.status, 405);

    // 注册后的主机出现在 store 里（relay 与 CLI 共享文件）
    assert.equal(listHosts(context.file).length, 2);
  } finally {
    await context.cleanup();
  }
});

test('classic mode: /__group/register stays 404 (main behaviour unchanged)', async () => {
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
    assert.equal(relay.mode, 'classic');
    const response = await postRegister(relay.controlPort, { inviteCode: 'x' });
    assert.equal(response.status, 404);
  } finally {
    await relay.close();
  }
});

test('group registration enforces per-IP rate limit with Retry-After', async () => {
  const context = await startGroupRelay({
    group: { registration: { enabled: true, maxAttemptsPerMinutePerIp: 3, maxAttemptsPerMinute: 100, bodyLimitBytes: 8192 } },
  });
  try {
    for (let i = 0; i < 3; i += 1) {
      const response = await postRegister(context.relay.controlPort, { inviteCode: 'bad' });
      assert.equal(response.status, 403);
    }
    const limited = await postRegister(context.relay.controlPort, { inviteCode: 'bad' });
    assert.equal(limited.status, 429);
    assert.equal(limited.json.error.code, GROUP_REGISTER_ERROR.RATE_LIMITED);
    assert.ok(Number(limited.headers['retry-after']) >= 1, 'must send Retry-After');
  } finally {
    await context.cleanup();
  }
});

test('group registration can be disabled and enforces maxHosts', async () => {
  const disabled = await startGroupRelay({ group: { registration: { enabled: false } } });
  try {
    const response = await postRegister(disabled.relay.controlPort, { inviteCode: 'whatever' });
    assert.equal(response.status, 403);
    assert.equal(response.json.error.code, GROUP_REGISTER_ERROR.REGISTRATION_DISABLED);
  } finally {
    await disabled.cleanup();
  }

  const limited = await startGroupRelay({ group: { maxHosts: 1 } });
  try {
    const inviteA = createInvite(limited.file, {});
    const inviteB = createInvite(limited.file, {});
    assert.equal((await postRegister(limited.relay.controlPort, { inviteCode: inviteA.code })).status, 200);
    const second = await postRegister(limited.relay.controlPort, { inviteCode: inviteB.code });
    assert.equal(second.status, 409);
    assert.equal(second.json.error.code, GROUP_REGISTER_ERROR.HOST_LIMIT);
  } finally {
    await limited.cleanup();
  }
});

test('config: group mode requires group.file and rejects invalid mode', async () => {
  const base = { domain: 'relay.test', dataPort: 0, controlPort: 0, httpPort: 0, dataHost: '127.0.0.1', dev: true, logger: silentLogger };
  await assert.rejects(createRelay({ ...base, mode: 'group' }), /requires group\.file/);
  await assert.rejects(createRelay({ ...base, mode: 'weird' }), /invalid mode/);
});

test('CLI: invite create/list/revoke and host list/revoke', () => {
  const temp = tempDir();
  try {
    const file = join(temp.dir, 'group.json');
    const created = runCli(['invite', 'create', '--note', 'friend A', '--max-uses', '2', '--expires-in', '1d', '--group-file', file, '--json']);
    assert.equal(created.status, 0, created.stderr);
    const invite = JSON.parse(created.stdout.trim());
    assert.equal(invite.note, 'friend A');
    assert.equal(invite.maxUses, 2);
    assert.equal(invite.groupFile, file);
    assert.match(invite.code, /^[A-Za-z0-9_-]{40,}$/);

    const listed = runCli(['invite', 'list', '--group-file', file, '--json']);
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout).invites.length, 1);
    assert.equal(JSON.parse(listed.stdout).invites[0].remaining, 2);
    assert.equal(listed.stdout.includes(invite.code), true, 'invite list prints the code for copying');

    const registration = registerHost({ file, inviteCode: invite.code, hostName: 'Test Mac' });
    const hosts = runCli(['host', 'list', '--group-file', file, '--json']);
    assert.equal(hosts.status, 0, hosts.stderr);
    assert.deepEqual(JSON.parse(hosts.stdout).hosts.map((host) => host.hostId), [registration.hostId]);

    const revokedHost = runCli(['host', 'revoke', registration.hostId, '--group-file', file, '--json']);
    assert.equal(revokedHost.status, 0, revokedHost.stderr);
    assert.equal(JSON.parse(revokedHost.stdout.trim()).revoked, true);

    const revokedInvite = runCli(['invite', 'revoke', invite.inviteId, '--group-file', file, '--json']);
    assert.equal(revokedInvite.status, 0, revokedInvite.stderr);
    assert.equal(JSON.parse(revokedInvite.stdout.trim()).revoked, true);

    assert.equal(runCli(['invite', 'revoke', 'inv_nope', '--group-file', file, '--json']).status, 1);
    assert.equal(runCli(['host', 'revoke', 'h_nope', '--group-file', file, '--json']).status, 1);

    const help = runCli(['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /invite create/);
    assert.match(help.stdout, /--mode <mode>/);
    assert.match(help.stdout, /--group-file/);
  } finally {
    temp.cleanup();
  }
});
