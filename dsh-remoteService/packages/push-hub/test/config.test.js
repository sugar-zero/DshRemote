import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HUB_BODY_LIMIT_BYTES,
  HUB_DEFAULT_CREDENTIAL_TTL_DAYS,
  HUB_DEFAULT_ENROLL_CHALLENGE_TTL_SECONDS,
  HUB_DEFAULT_MAX_TOKENS_PER_REQUEST,
  HUB_DEFAULT_PORT,
  HUB_DEFAULT_SIGNING_KEY_FILE_NAME,
  HUB_LIMIT_DEFAULTS,
  applyHubEnv,
  createHubConfig,
  loadHubConfig,
  normalizeHubConfig,
  normalizePublicUrl,
  readHubTlsMaterial,
} from '../index.js';
import { TEST_APNS_CONFIG, cleanupDir, makeTempDir } from './helpers.js';

const KEY_ID = 'ABC123DEF4';
const TEAM_ID = 'TEAM123456';
const TOPIC = 'com.example.dshremote';

/** @returns {Record<string, any>} */
function apnsConfig(overrides = {}) {
  return { keyFile: '/data/apns/AuthKey_TESTTEST00.p8', keyId: KEY_ID, teamId: TEAM_ID, topic: TOPIC, ...overrides };
}

test('config: 默认值（回环监听 / 9445 / 每请求 token 上限 / R2 关闭 / 无 store 段）', () => {
  const dir = makeTempDir();
  try {
    const configPath = join(dir, 'hub.json');
    const config = createHubConfig({}, { env: {}, configPath });
    assert.equal(config.listenHost, '127.0.0.1');
    assert.equal(config.port, HUB_DEFAULT_PORT);
    assert.equal(config.limits.maxTokensPerRequest, HUB_DEFAULT_MAX_TOKENS_PER_REQUEST);
    assert.equal(config.tls, null);
    assert.equal(config.apns.configured, false);
    // 0.3.0 起 hub 没有可写 store：配置里不再有 store 字段；limits 只剩 R2 各层。
    assert.equal(Object.hasOwn(config, 'store'), false);
    assert.deepEqual(Object.keys(config.limits).sort(), [
      'challengePerHourPerIp',
      'enrollPerHourPerDevice',
      'enrollPerHourPerIp',
      'maxTokensPerRequest',
      'pushPerDayPerToken',
      'pushPerMinuteGlobal',
      'pushPerMinutePerCredential',
      'pushPerMinutePerHost',
      'pushPerMinutePerIp',
      'pushPerMinutePerToken',
    ]);
    // 签名 key 默认放在 baseDir（有配置文件时即配置文件目录）。
    assert.equal(config.signingKeyFile, join(dir, HUB_DEFAULT_SIGNING_KEY_FILE_NAME));
    assert.equal(config.logLevel, 'info');
    assert.equal(HUB_BODY_LIMIT_BYTES, 16 * 1024);
  } finally {
    cleanupDir(dir);
  }
});

test('config: HUB_* 环境变量覆盖（含数字/路径/APNs）', () => {
  const config = createHubConfig({ port: 1000, logLevel: 'warn' }, {
    env: {
      HUB_LISTEN_HOST: '0.0.0.0',
      HUB_PORT: '19445',
      HUB_LOG_LEVEL: 'debug',
      HUB_APNS_KEY_FILE: '/data/apns/AuthKey_ABC123DEF4.p8',
      HUB_APNS_KEY_ID: 'ABC123DEF4',
      HUB_APNS_TEAM_ID: 'TEAM123456',
      HUB_APNS_TOPIC: 'com.example.dshremote',
      HUB_MAX_TOKENS_PER_REQUEST: '10',
    },
    cwd: '/tmp',
  });
  assert.equal(config.listenHost, '0.0.0.0');
  assert.equal(config.port, 19445);
  assert.equal(config.logLevel, 'debug');
  assert.equal(config.limits.maxTokensPerRequest, 10);
  assert.equal(config.apns.configured, true);
  assert.equal(config.apns.keyId, 'ABC123DEF4');
  assert.equal(config.apns.topic, 'com.example.dshremote');
  assert.equal(config.apns.keyFile, '/data/apns/AuthKey_ABC123DEF4.p8');
});

test('config: 环境变量空字符串视为未设置（compose 里 `${VAR:-}` 的常见形态）', () => {
  const raw = { port: 2000, apns: apnsConfig() };
  const merged = applyHubEnv(raw, { HUB_PORT: '', HUB_TLS_CERT_FILE: '', HUB_APNS_KEY_ID: '' });
  assert.equal(merged.port, 2000);
  assert.equal(merged.tls, undefined);
  assert.equal(merged.apns.keyId, KEY_ID);
});

test('config: 环境变量里的相对路径按 cwd 解析；配置文件里的相对路径按 config 目录解析', () => {
  const dir = makeTempDir();
  try {
    const configDir = join(dir, 'config');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'hub.json');
    const config = createHubConfig({
      signingKeyFile: '../data/signing.pem',
      apns: apnsConfig({ keyFile: 'keys/AuthKey_TESTTEST00.p8' }),
      tls: { certFile: 'certs/fullchain.pem', keyFile: 'certs/privkey.pem' },
    }, { baseDir: configDir, configPath, env: {} });
    assert.equal(config.signingKeyFile, join(dir, 'data', 'signing.pem'));
    assert.equal(config.apns.keyFile, join(configDir, 'keys', 'AuthKey_TESTTEST00.p8'));
    assert.deepEqual(config.tls, {
      certFile: join(configDir, 'certs', 'fullchain.pem'),
      keyFile: join(configDir, 'certs', 'privkey.pem'),
    });

    const fromEnv = createHubConfig({}, {
      env: {
        HUB_SIGNING_KEY_FILE: 'data/signing.pem',
        HUB_APNS_KEY_FILE: 'apns/AuthKey_ABC123DEF4.p8',
        HUB_APNS_KEY_ID: KEY_ID,
        HUB_APNS_TEAM_ID: TEAM_ID,
        HUB_APNS_TOPIC: TOPIC,
      },
      cwd: '/tmp/hub-cwd',
    });
    assert.equal(fromEnv.signingKeyFile, '/tmp/hub-cwd/data/signing.pem');
    assert.equal(fromEnv.apns.keyFile, '/tmp/hub-cwd/apns/AuthKey_ABC123DEF4.p8');
  } finally {
    cleanupDir(dir);
  }
});

test('config: apns 可选，但「配了一半」必须报错（可操作、不泄漏密钥）', () => {
  assert.equal(createHubConfig({}, { env: {} }).apns.configured, false);
  assert.equal(createHubConfig({ apns: {} }, { env: {} }).apns.configured, false);

  assert.throws(
    () => createHubConfig({ apns: { keyId: KEY_ID, teamId: TEAM_ID, topic: TOPIC } }, { env: {} }),
    /apns 已配置但缺少私钥.*keyFile.*privateKey/s,
  );
  assert.throws(
    () => createHubConfig({ apns: { keyFile: '/k.p8', teamId: TEAM_ID, topic: TOPIC } }, { env: {} }),
    /apns\.keyId/,
  );
  assert.throws(
    () => createHubConfig({ apns: { keyFile: '/k.p8', keyId: 'SHORT', teamId: TEAM_ID, topic: TOPIC } }, { env: {} }),
    /apns\.keyId 必须是 10 位字母数字/,
  );
  assert.throws(
    () => createHubConfig({ apns: { keyFile: '/k.p8', keyId: KEY_ID, teamId: TEAM_ID, topic: 'nodot' } }, { env: {} }),
    /apns\.topic 必须是官方 App 的 bundle id/,
  );
  assert.throws(
    () => createHubConfig({ apns: apnsConfig({ keyFile: '/k.p8', privateKey: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----' }) }, { env: {} }),
    /只能二选一/,
  );
});

test('config: tls 两种形态（文件/内联 PEM），非法形态可操作报错', () => {
  const config = createHubConfig({ tls: { cert: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----', key: '-----BEGIN PRIVATE KEY-----\ny\n-----END PRIVATE KEY-----' } }, { env: {} });
  assert.match(config.tls.cert, /BEGIN CERTIFICATE/);
  assert.throws(() => createHubConfig({ tls: { certFile: '/c.pem' } }, { env: {} }), /tls\.keyFile/);
  assert.throws(() => createHubConfig({ tls: { certFile: '/c.pem', keyFile: '/k.pem', cert: 'x', key: 'y' } }, { env: {} }), /只能二选一/);
  assert.throws(() => createHubConfig({ tls: { cert: 'not-pem', key: 'not-pem' } }, { env: {} }), /tls\.cert 必须是 PEM 证书文本/);
  assert.throws(() => createHubConfig({ tls: { certFile: '/c.pem', keyFile: '/k.pem', extra: true } }, { env: {} }), /tls has unsupported field/);
});

test('config: 内联私钥内容不会出现在错误信息里', () => {
  const secretBody = 'TOP-SECRET-MATERIAL-DO-NOT-LEAK';
  assert.throws(
    () => createHubConfig({ apns: { privateKey: `-----BEGIN PRIVATE KEY-----\n${secretBody}\n-----END PRIVATE KEY-----`, keyId: 'SHORT', teamId: TEAM_ID, topic: TOPIC } }, { env: {} }),
    (error) => {
      assert.ok(!String(error.message).includes(secretBody));
      return /apns\.keyId/.test(error.message);
    },
  );
  assert.throws(
    () => createHubConfig({ tls: { cert: 'not-pem', key: `-----BEGIN PRIVATE KEY-----\n${secretBody}\n-----END PRIVATE KEY-----` } }, { env: {} }),
    (error) => {
      assert.ok(!String(error.message).includes(secretBody));
      return true;
    },
  );
});

test('config: 非法值逐项拒绝（端口/整数/监听/未知字段/logLevel）', () => {
  /** @type {Array<[Record<string, any>, RegExp]>} */
  const cases = [
    [{ port: 70000 }, /invalid port/],
    [{ port: -1 }, /invalid port/],
    [{ port: 1.5 }, /invalid port/],
    [{ listenHost: 'bad host' }, /invalid listenHost/],
    [{ limits: { maxTokensPerRequest: 0 } }, /limits\.maxTokensPerRequest/],
    [{ limits: { maxTokensPerRequest: 'x' } }, /limits\.maxTokensPerRequest/],
    [{ logLevel: 'loud' }, /invalid logLevel/],
    // 0.3.0：旧的 per-relay 配额与 store 段都已删除，配了就是未知字段。
    [{ limits: { unknownLimit: 60 } }, /limits has unsupported field/],
    [{ store: { file: 'hub-store.json' } }, /unsupported field\(s\): store/],
    [{ unknownField: 1 }, /unsupported field\(s\): unknownField/],
    [{ apns: { keyFile: '/k.p8', keyId: KEY_ID, teamId: TEAM_ID, topic: TOPIC, extraNoise: 1 } }, /apns has unsupported field/],
    [{ tls: 'string' }, /tls must be a JSON object/],
  ];
  for (const [raw, pattern] of cases) {
    assert.throws(() => createHubConfig(raw, { env: {} }), pattern, `expected throw for ${JSON.stringify(raw)}`);
  }
  // port 0 = 临时端口，测试可用，不能拒绝。
  assert.equal(createHubConfig({ port: 0 }, { env: {} }).port, 0);
});

test('config: loadHubConfig 读文件 + env 覆盖 + 缺失文件给可操作错误', () => {
  const dir = makeTempDir();
  try {
    const configPath = join(dir, 'hub.json');
    writeFileSync(configPath, JSON.stringify({ port: 9999, limits: { maxTokensPerRequest: 5 } }));
    const { config, configPath: loadedPath } = loadHubConfig({ configPath, env: {} });
    assert.equal(loadedPath, configPath);
    assert.equal(config.port, 9999);
    assert.equal(config.limits.maxTokensPerRequest, 5);
    assert.equal(config.signingKeyFile, join(dir, HUB_DEFAULT_SIGNING_KEY_FILE_NAME));

    // 环境变量覆盖文件值。
    const overridden = loadHubConfig({ configPath, env: { HUB_PORT: '9876' } });
    assert.equal(overridden.config.port, 9876);

    // HUB_CONFIG 环境变量指定路径（不传 configPath）。
    const viaEnv = loadHubConfig({ env: { HUB_CONFIG: configPath } });
    assert.equal(viaEnv.configPath, configPath);
    assert.equal(viaEnv.config.port, 9999);

    // 纯环境变量模式：没有配置文件也能加载。
    const envOnly = loadHubConfig({ env: { HUB_PORT: '9446' }, cwd: dir });
    assert.equal(envOnly.configPath, undefined);
    assert.equal(envOnly.config.port, 9446);
    // 纯环境变量模式：签名 key 默认落在 cwd。
    assert.equal(envOnly.config.signingKeyFile, join(dir, HUB_DEFAULT_SIGNING_KEY_FILE_NAME));

    assert.throws(() => loadHubConfig({ configPath: join(dir, 'missing.json'), env: {} }), /cannot read hub config file/);

    writeFileSync(join(dir, 'broken.json'), '{not json');
    assert.throws(() => loadHubConfig({ configPath: join(dir, 'broken.json'), env: {} }), /not valid JSON/);

    writeFileSync(join(dir, 'array.json'), '[]');
    assert.throws(() => loadHubConfig({ configPath: join(dir, 'array.json'), env: {} }), /must be a JSON object/);
  } finally {
    cleanupDir(dir);
  }
});

test('config: normalizeHubConfig 不读环境变量（createHubConfig 才合并 env）', () => {
  const env = { HUB_PORT: '1234' };
  const normalized = normalizeHubConfig({ port: 4321 }, { env });
  assert.equal(normalized.port, 4321);
  // createHubConfig 合并 env（显式 env 参数隔离宿主机变量）。
  assert.equal(createHubConfig({ port: 4321 }, { env }).port, 1234);
});

test('config: readHubTlsMaterial（内联直通 / 文件缺失可操作报错）', () => {
  const inline = readHubTlsMaterial({
    cert: '-----BEGIN CERTIFICATE-----\nc\n-----END CERTIFICATE-----',
    key: '-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----',
  });
  assert.match(inline.cert, /BEGIN CERTIFICATE/);
  assert.match(inline.key, /BEGIN PRIVATE KEY/);
  assert.equal(readHubTlsMaterial(null), null);

  const dir = makeTempDir();
  try {
    const missing = join(dir, 'fullchain.pem');
    assert.throws(
      () => readHubTlsMaterial({ certFile: missing, keyFile: join(dir, 'privkey.pem') }),
      /cannot read TLS certificate file .*ENOENT/,
    );
    writeFileSync(missing, 'not a pem');
    assert.throws(
      () => readHubTlsMaterial({ certFile: missing, keyFile: join(dir, 'privkey.pem') }),
      /does not look like a PEM file/,
    );
  } finally {
    cleanupDir(dir);
  }
});

test('config: 测试常量自检（keyId/teamId 10 位；topic 含点）', () => {
  assert.match(TEST_APNS_CONFIG.keyId, /^[A-Za-z0-9]{10}$/);
  assert.match(TEST_APNS_CONFIG.teamId, /^[A-Za-z0-9]{10}$/);
  assert.ok(TEST_APNS_CONFIG.topic.includes('.'));
});

// ── R2 配置（0.2.0）─────────────────────────────────────────────────────────

test('config: R2 默认值（publicUrl 空=未启用 / 签名 key 在 baseDir / 7 天 / 120s / 配额默认）', () => {
  const dir = makeTempDir();
  try {
    const configPath = join(dir, 'hub.json');
    const config = createHubConfig({}, { env: {}, configPath });
    assert.equal(config.publicUrl, '', '未配置 HUB_PUBLIC_URL 时 R2 不启用');
    assert.equal(config.signingKeyFile, join(dir, HUB_DEFAULT_SIGNING_KEY_FILE_NAME));
    assert.deepEqual(config.credential, { ttlDays: HUB_DEFAULT_CREDENTIAL_TTL_DAYS });
    assert.deepEqual(config.enroll, { enabled: true, challengeTtlSeconds: HUB_DEFAULT_ENROLL_CHALLENGE_TTL_SECONDS });
    assert.deepEqual(config.limits, HUB_LIMIT_DEFAULTS);
  } finally {
    cleanupDir(dir);
  }
});

test('config: 签名 key 默认落在 baseDir（容器内 /data/push-hub-signing-key.pem）', () => {
  const config = createHubConfig({}, { baseDir: '/data', env: {} });
  assert.equal(config.signingKeyFile, '/data/push-hub-signing-key.pem');
  // 显式配置优先（相对路径按 config 目录解析）。
  const dir = makeTempDir();
  try {
    const configDir = join(dir, 'config');
    mkdirSync(configDir, { recursive: true });
    const explicit = createHubConfig({ signingKeyFile: 'keys/signing.pem' }, { baseDir: configDir, env: {} });
    assert.equal(explicit.signingKeyFile, join(configDir, 'keys', 'signing.pem'));
  } finally {
    cleanupDir(dir);
  }
});

test('config: normalizePublicUrl（必须是 https 绝对地址、去尾斜杠、拒 userinfo/query/hash）', () => {
  assert.equal(normalizePublicUrl('https://push.example.com'), 'https://push.example.com');
  assert.equal(normalizePublicUrl('https://push.example.com/'), 'https://push.example.com');
  assert.equal(normalizePublicUrl('https://push.example.com///'), 'https://push.example.com');
  assert.equal(normalizePublicUrl('https://push.example.com/hub'), 'https://push.example.com/hub');
  assert.equal(normalizePublicUrl(undefined), '');
  assert.equal(normalizePublicUrl(''), '');
  for (const bad of [
    'http://push.example.com',
    'ftp://push.example.com',
    'https://user:pass@push.example.com',
    'https://push.example.com/?a=1',
    'https://push.example.com/#frag',
    'not a url',
    `https://push.example.com/${'a'.repeat(2100)}`,
  ]) {
    assert.throws(() => normalizePublicUrl(bad), /invalid publicUrl/, `should reject ${bad.slice(0, 40)}`);
  }
});

test('config: HUB_* R2 环境变量覆盖（publicUrl / signing key / credential / enroll / 配额）', () => {
  const config = createHubConfig({}, {
    env: {
      HUB_PUBLIC_URL: 'https://push.example.com/',
      HUB_SIGNING_KEY_FILE: 'data/signing.pem',
      HUB_CREDENTIAL_TTL_DAYS: '3',
      HUB_ENROLL_ENABLED: 'false',
      HUB_ENROLL_CHALLENGE_TTL_SECONDS: '60',
      HUB_ENROLL_PER_HOUR_PER_IP: '7',
      HUB_ENROLL_PER_HOUR_PER_DEVICE: '8',
      HUB_CHALLENGE_PER_HOUR_PER_IP: '9',
      HUB_PUSH_PER_MINUTE_PER_TOKEN: '10',
      HUB_PUSH_PER_DAY_PER_TOKEN: '11',
      HUB_PUSH_PER_MINUTE_PER_CREDENTIAL: '12',
      HUB_PUSH_PER_MINUTE_PER_HOST: '13',
      HUB_PUSH_PER_MINUTE_PER_IP: '14',
      HUB_PUSH_PER_MINUTE_GLOBAL: '15',
    },
    cwd: '/tmp/hub-cwd',
  });
  assert.equal(config.publicUrl, 'https://push.example.com');
  assert.equal(config.signingKeyFile, '/tmp/hub-cwd/data/signing.pem');
  assert.equal(config.credential.ttlDays, 3);
  assert.equal(config.enroll.enabled, false);
  assert.equal(config.enroll.challengeTtlSeconds, 60);
  assert.deepEqual(config.limits, {
    ...HUB_LIMIT_DEFAULTS,
    enrollPerHourPerIp: 7,
    enrollPerHourPerDevice: 8,
    challengePerHourPerIp: 9,
    pushPerMinutePerToken: 10,
    pushPerDayPerToken: 11,
    pushPerMinutePerCredential: 12,
    pushPerMinutePerHost: 13,
    pushPerMinutePerIp: 14,
    pushPerMinuteGlobal: 15,
  });
});

test('config: R2 非法值逐项拒绝（publicUrl / ttlDays / enroll / 配额 / 未知字段）', () => {
  /** @type {Array<[Record<string, any>, RegExp]>} */
  const cases = [
    [{ publicUrl: 'http://push.example.com' }, /invalid publicUrl.*https/],
    [{ credential: { ttlDays: 0 } }, /credential\.ttlDays/],
    [{ credential: { ttlDays: 91 } }, /credential\.ttlDays/],
    [{ credential: { ttlDays: 7, extra: 1 } }, /credential has unsupported field/],
    [{ enroll: { enabled: 'maybe' } }, /enroll\.enabled/],
    [{ enroll: { challengeTtlSeconds: 5 } }, /enroll\.challengeTtlSeconds/],
    [{ enroll: { unknown: 1 } }, /enroll has unsupported field/],
    [{ limits: { pushPerMinutePerToken: 0 } }, /limits\.pushPerMinutePerToken/],
    [{ limits: { enrollPerHourPerIp: -1 } }, /limits\.enrollPerHourPerIp/],
    [{ limits: { challengePerHourPerIp: 'x' } }, /limits\.challengePerHourPerIp/],
    [{ signingKeyFile: 123 }, /signingKeyFile/],
    [{ publicUrl: 'https://push.example.com', unknownR2: true }, /unsupported field\(s\): unknownR2/],
  ];
  for (const [raw, pattern] of cases) {
    assert.throws(() => createHubConfig(raw, { env: {} }), pattern, `expected throw for ${JSON.stringify(raw)}`);
  }
});

test('config: hub.json 读取 R2 字段（loadHubConfig）', () => {
  const dir = makeTempDir();
  try {
    const configPath = join(dir, 'hub.json');
    writeFileSync(configPath, JSON.stringify({
      publicUrl: 'https://push.example.com',
      signingKeyFile: 'push-hub-signing-key.pem',
      credential: { ttlDays: 2 },
      enroll: { enabled: true, challengeTtlSeconds: 30 },
      limits: { pushPerMinutePerToken: 4 },
    }));
    const { config } = loadHubConfig({ configPath, env: {} });
    assert.equal(config.publicUrl, 'https://push.example.com');
    assert.equal(config.signingKeyFile, join(dir, 'push-hub-signing-key.pem'));
    assert.equal(config.credential.ttlDays, 2);
    assert.equal(config.enroll.challengeTtlSeconds, 30);
    assert.equal(config.limits.pushPerMinutePerToken, 4);
    assert.equal(config.limits.pushPerMinutePerHost, HUB_LIMIT_DEFAULTS.pushPerMinutePerHost);
  } finally {
    cleanupDir(dir);
  }
});
