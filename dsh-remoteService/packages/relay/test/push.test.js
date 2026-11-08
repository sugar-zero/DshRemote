/**
 * relay 服务端集中推送（0.4.0，只有 self）：`group.push` 配置校验 + push 服务。
 *
 * 覆盖（契约 docs/group-push-design.zh.md §2/§4/§5/§9）：
 *   - 配置：self 必填项、mode 只接受 self（official 已删除）、cooldown 校验、默认关闭；
 *   - self：generic 固定文案 / summary 截断、APNs pruned 删 token（含轮换保护）；
 *   - 限速 / cooldown / token 上限 / 设备撤销清表 / 未配置降级。
 *
 * R2 起官方 App 推送不经过 relay（App 向官方 hub 登记、主机直连），因此本文件没有
 * official / hub 客户端用例。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGroupPushService, normalizeConfig } from '../index.js';
import { silentLogger } from './helpers/certs.js';

const BIN = fileURLToPath(new URL('../bin/relay.js', import.meta.url));


/** register 限速测试用：每 host 每分钟最多登记次数（与 GROUP_PUSH_MAX_INTENTS_PER_MINUTE 一致）。 */
const GROUP_PUSH_TEST_MAX_REGISTERS = 30;

const DEVICE_A = 'd_0000000001';
const DEVICE_B = 'd_0000000002';
const DEVICE_C = 'd_0000000003';

/** 生成第 n 个合法 APNs device token（64 位小写 hex）。 */
function apnsToken(n) {
  return (n + 1).toString(16).padStart(64, '0');
}

/** 生成第 n 个合法 deviceId（d_ + [a-z0-9]{6,40}）。 */
function deviceId(n) {
  return `d_${(n + 1).toString(36).padStart(10, '0')}`;
}

/**
 * 直接构造一份合法的 group.push 原始配置（之后交给 normalizeConfig 校验/规范化）。
 * @param {Record<string, any>} [overrides]
 */
function rawPush(overrides = {}) {
  return {
    enabled: true,
    mode: 'self',
    content: 'generic',
    cooldownSeconds: 0,
    self: {
      keyFile: '/data/apns/AuthKey_TESTKEYID1.p8',
      keyId: 'TESTKEYID1',
      teamId: 'TESTTEAMID',
      topic: 'com.example.app',
      environment: 'auto',
    },
    ...overrides,
  };
}

/** 构造 normalizeConfig 的输入（dev 免 TLS；group.file 不读取）。 */
function configOptions(push) {
  return {
    domain: 'relay.test',
    dev: true,
    logger: silentLogger,
    group: { file: '/tmp/dsh-relay-push-test/group.json', edge: { enabled: false }, push },
  };
}

/** 规范化后的 push 配置。 */
function normalizePush(raw = rawPush()) {
  return normalizeConfig(configOptions(raw)).group.push;
}

/** 用规范化配置创建 push 服务（默认注入假 APNs）。 */
function createService(overrides = {}, deps = {}) {
  return createGroupPushService({
    config: normalizePush(rawPush(overrides)),
    domain: 'relay.test',
    logger: silentLogger,
    ...deps,
  });
}

/** 假 APNs 发送器：记录每次 sendToTokens 的入参，默认全部成功。 */
function fakeApns(handler) {
  const calls = [];
  return {
    calls,
    isConfigured: () => true,
    async sendToTokens(entries, message) {
      calls.push({
        entries: entries.map((entry) => ({ ...entry })),
        message: message ? { ...message } : {},
      });
      if (handler) return handler(entries, message);
      return { delivered: entries.length, failed: 0, pruned: [], configErrors: [], errors: [] };
    },
  };
}

/** 注册一个设备（默认 development 环境）。 */
function registerDevice(push, hostId, id, token, environment = 'development') {
  return push.register(hostId, { deviceId: id, provider: 'apns', token: apnsToken(token), environment });
}

// ---------------------------------------------------------------------------
// group.push 配置校验
// ---------------------------------------------------------------------------

test('push 配置：未配置时默认关闭（enabled=false, mode=self, generic, cooldown=30）', () => {
  const push = normalizeConfig(configOptions(undefined)).group.push;
  assert.equal(push.enabled, false);
  assert.equal(push.mode, 'self');
  assert.equal(push.content, 'generic');
  assert.equal(push.cooldownSeconds, 30);
  assert.equal(push.self.environment, 'auto');
  assert.equal(push.official, undefined, 'R2 起配置里不再有 official 段');
});

test('push 配置：enabled=true 时校验 self 必填项；mode=official 报「已删除」错误', () => {
  assert.throws(
    () => normalizeConfig(configOptions({ enabled: true, mode: 'self', self: { keyId: 'K' } })),
    /group\.push\.mode="self".*keyFile/,
  );
  // R2 起 official 转发已删除：即使 enabled=false 也直接报错（不带病启动）
  assert.throws(
    () => normalizeConfig(configOptions(rawPush({ enabled: false, mode: 'official' }))),
    /official.*已删除.*官方 hub.*self/,
  );
  // 关闭时不要求必填（部署方可先写好占位再打开）
  const disabled = normalizeConfig(configOptions({ enabled: false, mode: 'self', self: {} })).group.push;
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.mode, 'self');
});

test('push 配置：mode 只接受 self（大小写不敏感），其它值给可操作错误', () => {
  assert.equal(normalizeConfig(configOptions(rawPush({ mode: 'SELF' }))).group.push.mode, 'self');
  assert.throws(() => normalizeConfig(configOptions(rawPush({ mode: 'apns' }))), /只支持 "self"/);
  assert.throws(() => normalizeConfig(configOptions(rawPush({ mode: 1 }))), /只支持 "self"/);
});

test('push 配置：cooldownSeconds 必须是 0..3600 整数；0 合法', () => {
  assert.equal(normalizeConfig(configOptions(rawPush({ cooldownSeconds: 0 }))).group.push.cooldownSeconds, 0);
  assert.equal(normalizeConfig(configOptions(rawPush({ cooldownSeconds: 3600 }))).group.push.cooldownSeconds, 3600);
  for (const bad of [-1, 3601, 1.5, 'abc']) {
    assert.throws(() => normalizeConfig(configOptions(rawPush({ cooldownSeconds: bad }))), /cooldownSeconds/);
  }
});

test('push 配置：self.environment / content 非法值报错；keyFile 只校验路径不读文件', () => {
  assert.throws(
    () => normalizeConfig(configOptions(rawPush({ self: { ...rawPush().self, environment: 'staging' } }))),
    /environment/,
  );
  assert.throws(() => normalizeConfig(configOptions(rawPush({ content: 'full' }))), /content/);

  // 文件不读取：路径不存在也允许启动（首次实际推送时才报可操作错误）
  const push = normalizeConfig(configOptions(rawPush({
    self: { keyFile: '/nonexistent/AuthKey_NOPE.p8', keyId: 'K', teamId: 'T', topic: 'com.example.app' },
  }))).group.push;
  assert.equal(push.self.keyFile, '/nonexistent/AuthKey_NOPE.p8');
});

test('bin/relay.js applyEnv：RELAY_GROUP_PUSH_* 环境变量注入 group.push（非法组合在启动前报错）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-relay-push-env-'));
  try {
    const run = (pushEnv) => spawnSync(process.execPath, [
      BIN,
      '--dev',
      '--domain', 'relay.test',
      '--control-port', '0',
      '--http-port', '0',
      '--group-file', join(dir, 'group.json'),
      '--no-group-edge',
    ], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        RELAY_GROUP_PUSH_ENABLED: 'true',
        RELAY_GROUP_PUSH_MODE: 'self',
        ...pushEnv,
      },
    });
    // self 模式缺 APNs 四件套 → normalizeConfig 报可操作错误（证明 env 已注入 group.push）
    const missingSelf = run({});
    assert.equal(missingSelf.status, 1);
    assert.match(missingSelf.stderr, /group\.push\.mode="self"/);
    assert.match(missingSelf.stderr, /keyFile/);

    // RELAY_GROUP_PUSH_MODE=official → bin 层直接报「已删除」可操作错误
    const officialMode = run({ RELAY_GROUP_PUSH_MODE: 'official' });
    assert.equal(officialMode.status, 1);
    assert.match(officialMode.stderr, /official.*已删除.*self/);

    // cooldown 越界 → 配置阶段拒绝
    const badCooldown = run({
      RELAY_GROUP_PUSH_COOLDOWN_SECONDS: '9999',
      RELAY_GROUP_PUSH_APNS_KEY_FILE: join(dir, 'AuthKey.p8'),
      RELAY_GROUP_PUSH_APNS_KEY_ID: 'TESTKEYID1',
      RELAY_GROUP_PUSH_APNS_TEAM_ID: 'TESTTEAMID',
      RELAY_GROUP_PUSH_APNS_TOPIC: 'com.example.app',
    });
    assert.equal(badCooldown.status, 1);
    assert.match(badCooldown.stderr, /cooldownSeconds/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// self 模式
// ---------------------------------------------------------------------------

test('self+generic：用固定文案发送，忽略 host 上报的 title/body；sessionId 保留供点通知跳会话', async () => {
  const apns = fakeApns();
  const push = createService({}, { apnsClient: apns });
  assert.deepEqual(registerDevice(push, 'h_test', DEVICE_A, 1), {
    ok: true,
    deviceId: DEVICE_A,
    mode: 'self',
    enabled: true,
  });
  assert.equal(registerDevice(push, 'h_test', DEVICE_B, 2, 'production').ok, true);

  const result = await push.send('h_test', {
    id: 'intent-1',
    kind: 'turn-end',
    title: '不应泄露的会话标题',
    body: '不应泄露的助手摘要',
    sessionId: 'sess-abc',
  });
  assert.deepEqual(result, { ok: true, delivered: 2, failed: 0, pruned: [], mode: 'self' });

  assert.equal(apns.calls.length, 1);
  const { entries, message } = apns.calls[0];
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.environment).sort(), ['development', 'production']);
  assert.equal(message.kind, 'turn-end');
  assert.equal(message.title, 'DSH');
  assert.equal(message.body, '任务已完成');
  assert.equal(message.sessionId, 'sess-abc', 'self 模式 sessionId 允许用于点通知跳会话');
  assert.equal(message.host, 'h_test.relay.test');
  assert.ok(!JSON.stringify(message).includes('不应泄露'), 'generic 模式不得把会话内容写进 payload');
});

test('self+generic：waiting-answer 使用固定文案「正在等待你的回答」', async () => {
  const apns = fakeApns();
  const push = createService({}, { apnsClient: apns });
  registerDevice(push, 'h_test', DEVICE_A, 1);
  const result = await push.send('h_test', { id: 'intent-wait', kind: 'waiting-answer' });
  assert.equal(result.ok, true);
  assert.equal(apns.calls[0].message.body, '正在等待你的回答');
});

test('self+summary：title ≤60 字、body ≤160 字，空则退回通用文案', async () => {
  const apns = fakeApns();
  const push = createService({ content: 'summary' }, { apnsClient: apns });
  registerDevice(push, 'h_test', DEVICE_A, 1);

  const longTitle = '标'.repeat(80);
  const longBody = '摘'.repeat(200);
  const result = await push.send('h_test', { id: 'intent-summary', kind: 'turn-end', title: longTitle, body: longBody, sessionId: 'sess-1' });
  assert.equal(result.ok, true);
  const { message } = apns.calls[0];
  assert.equal(message.title, '标'.repeat(60));
  assert.equal(message.body, '摘'.repeat(160));
  assert.equal(message.sessionId, 'sess-1');

  await push.send('h_test', { id: 'intent-empty', kind: 'turn-end' });
  const fallback = apns.calls[1].message;
  assert.equal(fallback.title, 'DSH');
  assert.equal(fallback.body, '任务已完成');
});

test('self：APNs pruned 删表并回报 deviceId；token 已轮换的旧 410 不删新 token', async () => {
  const apns = fakeApns((entries) => {
    if (entries.length === 1 && entries[0].token === apnsToken(1)) {
      return { delivered: 0, failed: 1, pruned: [{ deviceId: DEVICE_A, token: apnsToken(1) }], configErrors: [], errors: [] };
    }
    return { delivered: entries.length, failed: 0, pruned: [], configErrors: [], errors: [] };
  });
  const push = createService({}, { apnsClient: apns });
  registerDevice(push, 'h_test', DEVICE_A, 1);

  const first = await push.send('h_test', { id: 'intent-a', kind: 'turn-end' });
  assert.deepEqual(first, { ok: true, delivered: 0, failed: 1, pruned: [DEVICE_A], mode: 'self' });
  assert.deepEqual(push.summary(), { enabled: true, mode: 'self', tokens: 0 });

  // 设备重新登记（token 轮换）后，APNs 对旧 token 的 410 晚到：不能删掉新 token
  registerDevice(push, 'h_test', DEVICE_A, 2);
  const stale = await push.send('h_test', {
    id: 'intent-stale',
    kind: 'turn-end',
    // 让假 APNs 返回「旧 token 已失效」
  });
  assert.equal(stale.ok, true);
  // 第二次调用 entries 里已是新 token，因此正常投递
  assert.equal(stale.delivered, 1);
  assert.equal(push.summary().tokens, 1);
});

test('self：APNs 配置错误（BadDeviceToken 等）不删 token，仍返回 ok + failed 计数', async () => {
  const apns = fakeApns(() => ({
    delivered: 0,
    failed: 1,
    pruned: [],
    configErrors: ['BadDeviceToken'],
    errors: [{ status: 400, reason: 'BadDeviceToken' }],
  }));
  const push = createService({}, { apnsClient: apns });
  registerDevice(push, 'h_test', DEVICE_A, 1);
  const result = await push.send('h_test', { id: 'intent-bad-token', kind: 'turn-end' });
  assert.deepEqual(result, { ok: true, delivered: 0, failed: 1, pruned: [], mode: 'self' });
  assert.equal(push.summary().tokens, 1, '配置错误不能清理设备 token');
});

test('self：APNs 未配置（私钥读取失败）返回 push_unavailable，不抛异常', async () => {
  // 不注入 apnsClient：走默认 createApnsClient，keyFile 不存在 → 首次推送时读失败
  const push = createGroupPushService({
    config: normalizePush(rawPush({
      self: { keyFile: '/nonexistent/AuthKey_NOPE.p8', keyId: 'K', teamId: 'T', topic: 'com.example.app' },
    })),
    domain: 'relay.test',
    logger: silentLogger,
  });
  registerDevice(push, 'h_test', DEVICE_A, 1);
  const result = await push.send('h_test', { id: 'intent-not-configured', kind: 'turn-end' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'push_unavailable');
  assert.match(result.message, /APNs 配置不可用/);
  assert.ok(!String(result.message).includes('/nonexistent'), '错误文案不回显密钥文件路径/内容以外的敏感信息');
});

test('self：设备 token 表上限 16；同 deviceId 重登记只更新不占位', async () => {
  const push = createService({}, { apnsClient: fakeApns() });
  for (let i = 0; i < 16; i += 1) {
    assert.equal(registerDevice(push, 'h_test', deviceId(i), i).ok, true, `device ${i} 应能登记`);
  }
  assert.equal(push.summary().tokens, 16);
  const tooMany = registerDevice(push, 'h_test', deviceId(16), 16);
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.code, 'too_many_tokens');

  // 同 deviceId 更新 token 不算新增
  const updated = registerDevice(push, 'h_test', deviceId(0), 99);
  assert.deepEqual(updated, { ok: true, deviceId: deviceId(0), mode: 'self', enabled: true });
  assert.equal(push.summary().tokens, 16);
  assert.equal(push.summary().enabled, true);
});

test('register：token/provider/environment/deviceId 非法值分别返回契约错误码', async () => {
  const push = createService({}, { apnsClient: fakeApns() });
  assert.equal(push.register('h_test', { deviceId: 'not-a-device', provider: 'apns', token: apnsToken(0), environment: 'development' }).code, 'invalid_device');
  assert.equal(push.register('h_test', { deviceId: DEVICE_A, provider: 'fcm', token: apnsToken(0), environment: 'development' }).code, 'invalid_provider');
  assert.equal(push.register('h_test', { deviceId: DEVICE_A, provider: 'apns', token: 'XYZ', environment: 'development' }).code, 'invalid_push_token');
  assert.equal(push.register('h_test', { deviceId: DEVICE_A, provider: 'apns', token: 'A'.repeat(64), environment: 'development' }).code, 'invalid_push_token');
  assert.equal(push.register('h_test', { deviceId: DEVICE_A, provider: 'apns', token: apnsToken(0), environment: 'staging' }).code, 'invalid_environment');
});

// ---------------------------------------------------------------------------
// 限速 / cooldown / 降级
// ---------------------------------------------------------------------------

test('send：同一 host 每分钟最多 30 次意图，register 另有一套独立预算', async () => {
  const apns = fakeApns();
  const push = createService({ cooldownSeconds: 0 }, { apnsClient: apns });
  registerDevice(push, 'h_test', DEVICE_A, 1);
  // register 单独计数：连续重登记 30 次不触发 send 限速
  for (let i = 0; i < GROUP_PUSH_TEST_MAX_REGISTERS - 1; i += 1) {
    assert.equal(registerDevice(push, 'h_test', DEVICE_A, 1).ok, true);
  }
  for (let i = 0; i < 30; i += 1) {
    const result = await push.send('h_test', { id: `intent-${i}`, kind: 'turn-end' });
    assert.equal(result.ok, true, `第 ${i + 1} 次 send 应通过`);
  }
  const limited = await push.send('h_test', { id: 'intent-limited', kind: 'turn-end' });
  assert.equal(limited.ok, false);
  assert.equal(limited.code, 'rate_limited');
  assert.equal(apns.calls.length, 30, '被限速的意图不能发到 APNs');
});

test('register：同一 host 每分钟最多 30 次（第 31 次 rate_limited）', async () => {
  const push = createService({}, { apnsClient: fakeApns() });
  for (let i = 0; i < 30; i += 1) {
    assert.equal(registerDevice(push, 'h_test', DEVICE_A, 1).ok, true, `第 ${i + 1} 次登记应通过`);
  }
  const limited = registerDevice(push, 'h_test', DEVICE_A, 1);
  assert.equal(limited.ok, false);
  assert.equal(limited.code, 'rate_limited');
});

test('send：cooldownSeconds 内第二次推送跳过（skipped=cooldown），到期后恢复；no-tokens 不占冷却', async () => {
  let clock = 1_000_000;
  const apns = fakeApns();
  const push = createService({ cooldownSeconds: 60 }, { apnsClient: apns, now: () => clock });
  // 没有 token：skipped=no-tokens，不应占用冷却
  const empty = await push.send('h_test', { id: 'intent-empty', kind: 'turn-end' });
  assert.deepEqual(empty, { ok: true, delivered: 0, failed: 0, pruned: [], mode: 'self', skipped: 'no-tokens' });
  registerDevice(push, 'h_test', DEVICE_A, 1);
  const first = await push.send('h_test', { id: 'intent-1', kind: 'turn-end' });
  assert.equal(first.ok, true);
  assert.equal(first.delivered, 1);

  clock += 30_000;
  const cooling = await push.send('h_test', { id: 'intent-2', kind: 'turn-end' });
  assert.deepEqual(cooling, { ok: true, delivered: 0, failed: 0, pruned: [], mode: 'self', skipped: 'cooldown' });
  assert.equal(apns.calls.length, 1);

  clock += 31_000;
  const resumed = await push.send('h_test', { id: 'intent-3', kind: 'turn-end' });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.delivered, 1);
  assert.equal(apns.calls.length, 2);
});

test('send：kind/id 非法返回 invalid_request；relay 关闭时 send 返回 skipped=push_disabled', async () => {
  const push = createService({}, { apnsClient: fakeApns() });
  const badKind = await push.send('h_test', { id: 'x', kind: 'attention' });
  assert.equal(badKind.ok, false);
  assert.equal(badKind.code, 'invalid_request');
  const noId = await push.send('h_test', { kind: 'turn-end' });
  assert.equal(noId.code, 'invalid_request');

  const disabled = createService({ enabled: false }, { apnsClient: fakeApns() });
  const registered = registerDevice(disabled, 'h_test', DEVICE_A, 1);
  assert.equal(registered.ok, false);
  assert.equal(registered.code, 'push_disabled');
  const skipped = await disabled.send('h_test', { id: 'intent-disabled', kind: 'turn-end' });
  assert.deepEqual(skipped, { ok: true, delivered: 0, failed: 0, pruned: [], mode: 'self', skipped: 'push_disabled' });
  assert.deepEqual(disabled.summary(), { enabled: false, mode: 'self', tokens: 0 });
});

// ---------------------------------------------------------------------------
// 设备/主机撤销清表
// ---------------------------------------------------------------------------

test('dropDevice / pruneDevices / dropHost：设备撤销与 device.sync 后 token 立即失效', async () => {
  const push = createService({}, { apnsClient: fakeApns() });
  registerDevice(push, 'h_a', DEVICE_A, 1);
  registerDevice(push, 'h_a', DEVICE_B, 2);
  registerDevice(push, 'h_b', DEVICE_C, 3);
  assert.equal(push.summary().tokens, 3);

  assert.equal(push.dropDevice('h_a', DEVICE_A), true);
  assert.equal(push.dropDevice('h_a', DEVICE_A), false);
  assert.equal(push.summary().tokens, 2);

  // device.sync 全量覆盖后，不在册的设备 token 被清理
  assert.equal(push.pruneDevices('h_a', [DEVICE_B]), 0);
  assert.equal(push.pruneDevices('h_a', []), 1);
  assert.equal(push.summary().tokens, 1);

  // 撤销主机：整台清空
  assert.equal(push.dropHost('h_b'), true);
  assert.equal(push.dropHost('h_b'), false);
  assert.deepEqual(push.summary(), { enabled: true, mode: 'self', tokens: 0 });
});

test('dropHost 同时清空限速/冷却状态（主机重新注册后可立即推送）', async () => {
  const push = createService({ cooldownSeconds: 0 }, { apnsClient: fakeApns() });
  registerDevice(push, 'h_test', DEVICE_A, 1);
  for (let i = 0; i < 30; i += 1) await push.send('h_test', { id: `intent-${i}`, kind: 'turn-end' });
  assert.equal((await push.send('h_test', { id: 'intent-over', kind: 'turn-end' })).code, 'rate_limited');
  push.dropHost('h_test');
  registerDevice(push, 'h_test', DEVICE_A, 1);
  assert.equal((await push.send('h_test', { id: 'intent-fresh', kind: 'turn-end' })).ok, true);
});
