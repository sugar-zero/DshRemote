/**
 * 群组版部署体验：entrypoint 在 group 模式下按 .env 自动生成 relay.json。
 *
 * 覆盖：
 *   - 缺失配置文件 + .env 齐备 → 生成 0600 JSON（域名/端口/证书路径/后台/鉴权文件）；
 *   - 已存在配置文件 → 绝不覆盖；
 *   - 缺 RELAY_DOMAIN / 证书缺失 → 可操作报错（exit 1）；
 *   - 服务端集中推送（RELAY_GROUP_PUSH_*，R2 起只有 self）→ 生成 group.push 段，
 *     产物可被 normalizeConfig 接受；mode=official 在 entrypoint 直接报错（已删除）。
 *
 * 直接执行仓库里的 relay-entrypoint.sh（host 上 sh + node 即可；不需要 /app）。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { normalizeConfig } from '../index.js';
import { silentLogger } from './helpers/certs.js';

const ENTRYPOINT = fileURLToPath(new URL('../relay-entrypoint.sh', import.meta.url));

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-relay-envconfig-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** @param {Record<string,string>} overrides */
function runEntrypoint(dir, overrides, configPath = join(dir, 'config', 'relay.json')) {
  const env = {
    ...process.env,
    ...overrides,
  };
  // 参数：带 --config 让 entrypoint 走「配置缺失则自动生成」路径，再 exec 空命令避免真启动 relay。
  return spawnSync('sh', [ENTRYPOINT, 'sh', '-c', 'exit 0', 'sh', '--config', configPath], {
    cwd: dir,
    env,
    encoding: 'utf8',
    timeout: 15_000,
  });
}

function writeCerts(dir) {
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');
  writeFileSync(cert, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
  writeFileSync(key, '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n');
  return { cert, key };
}

test('group entrypoint：按 .env 自动生成 relay.json（0600），且不覆盖已有文件', () => {
  const temp = tempDir();
  try {
    const { cert, key } = writeCerts(temp.dir);
    const configPath = join(temp.dir, 'config', 'relay.json');
    const baseEnv = {
      RELAY_DOMAIN: 'relay.test',
      RELAY_TLS_CERT_FILE: cert,
      RELAY_TLS_KEY_FILE: key,
      RELAY_GROUP_EDGE_CERT_FILE: cert,
      RELAY_GROUP_EDGE_KEY_FILE: key,
      RELAY_GROUP_MOBILE_PORT: '1443',
      RELAY_GROUP_PUBLIC_CONTROL_PORT: '8443',
    };

    const first = runEntrypoint(temp.dir, baseEnv, configPath);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /已根据 \.env 生成/);
    if (process.platform !== 'win32') assert.equal(statSync(configPath).mode & 0o777, 0o600);

    const generated = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(generated.domain, 'relay.test');
    assert.equal(generated.controlPort, 8443);
    assert.equal(generated.httpPort, 80);
    assert.equal(generated.listenHost, '0.0.0.0');
    assert.equal(generated.mode, undefined, '0.3.0 起配置不再有 mode（只有群体版）');
    assert.equal(generated.dataPort, undefined, 'classic 数据面端口已删除');
    assert.equal(generated.tokensFile, undefined, 'classic tokens.json 已删除');
    assert.equal(generated.group.mobilePort, 1443);
    assert.equal(generated.group.apiPort, 9443);
    assert.equal(generated.group.adminPort, 9444);
    assert.equal(generated.group.publicControlPort, 8443);
    assert.equal(generated.group.edge.enabled, true);
    assert.equal(generated.group.edge.port, 443);
    assert.equal(generated.group.edge.tls.certFile, cert);
    assert.equal(generated.group.file, '/data/group.json');
    assert.equal(generated.group.adminTokenFile, '/data/admin-token');
    assert.equal(generated.group.auth.signingKeyFile, '/data/signing-key.pem');

    // 第二次运行（即使 .env 变了）不得覆盖已有配置
    const second = runEntrypoint(temp.dir, { ...baseEnv, RELAY_DOMAIN: 'changed.test', RELAY_GROUP_MOBILE_PORT: '2443' }, configPath);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /group 模式/);
    const unchanged = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(unchanged.domain, 'relay.test');
    assert.equal(unchanged.group.mobilePort, 1443);
  } finally {
    temp.cleanup();
  }
});

test('group entrypoint：按 RELAY_GROUP_PUSH_* 生成 self 模式 push 段，产物通过 relay 配置校验', () => {
  const temp = tempDir();
  try {
    const { cert, key } = writeCerts(temp.dir);
    const configPath = join(temp.dir, 'config', 'relay.json');
    const env = {
      RELAY_DOMAIN: 'relay.test',
      RELAY_TLS_CERT_FILE: cert,
      RELAY_TLS_KEY_FILE: key,
      RELAY_GROUP_EDGE_CERT_FILE: cert,
      RELAY_GROUP_EDGE_KEY_FILE: key,
      RELAY_GROUP_PUSH_ENABLED: 'true',
      RELAY_GROUP_PUSH_MODE: 'self',
      RELAY_GROUP_PUSH_CONTENT: 'generic',
      RELAY_GROUP_PUSH_COOLDOWN_SECONDS: '45',
      RELAY_GROUP_PUSH_APNS_KEY_FILE: '/data/apns/AuthKey_TESTKEYID1.p8',
      RELAY_GROUP_PUSH_APNS_KEY_ID: 'TESTKEYID1',
      RELAY_GROUP_PUSH_APNS_TEAM_ID: 'TESTTEAMID',
      RELAY_GROUP_PUSH_APNS_TOPIC: 'com.example.app',
      RELAY_GROUP_PUSH_APNS_ENVIRONMENT: 'development',
    };
    const result = runEntrypoint(temp.dir, env, configPath);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /服务端推送 enabled=true mode=self/);

    const generated = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(generated.group.push, {
      enabled: true,
      mode: 'self',
      content: 'generic',
      cooldownSeconds: 45,
      self: {
        keyFile: '/data/apns/AuthKey_TESTKEYID1.p8',
        keyId: 'TESTKEYID1',
        teamId: 'TESTTEAMID',
        topic: 'com.example.app',
        environment: 'development',
      },
    });
    assert.equal(generated.group.push.official, undefined, 'R2 起不再生成 official 段');

    // 生成的配置文件必须能直接通过 relay 的 normalizeConfig（证书/密钥文件不在配置阶段读取）。
    const normalized = normalizeConfig({ ...generated, logger: silentLogger });
    assert.equal(normalized.group.push.enabled, true);
    assert.equal(normalized.group.push.mode, 'self');
    assert.equal(normalized.group.push.self.keyId, 'TESTKEYID1');
  } finally {
    temp.cleanup();
  }
});

test('group entrypoint：RELAY_GROUP_PUSH_MODE=official 直接报可操作错误（R2 已删除，不生成配置）', () => {
  const temp = tempDir();
  try {
    const { cert, key } = writeCerts(temp.dir);
    const configPath = join(temp.dir, 'config', 'relay.json');
    const result = runEntrypoint(temp.dir, {
      RELAY_DOMAIN: 'relay.test',
      RELAY_TLS_CERT_FILE: cert,
      RELAY_TLS_KEY_FILE: key,
      RELAY_GROUP_EDGE_CERT_FILE: cert,
      RELAY_GROUP_EDGE_KEY_FILE: key,
      RELAY_GROUP_PUSH_ENABLED: 'true',
      RELAY_GROUP_PUSH_MODE: 'official',
    }, configPath);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /official.*已删除.*self/);
    let generated = false;
    try {
      readFileSync(configPath);
      generated = true;
    } catch {
      generated = false;
    }
    assert.equal(generated, false, '非法 mode 不得生成半成品配置');
  } finally {
    temp.cleanup();
  }
});

test('group entrypoint：缺 RELAY_DOMAIN / 证书缺失时可操作报错', () => {
  const temp = tempDir();
  try {
    const { cert, key } = writeCerts(temp.dir);
    const configPath = join(temp.dir, 'config', 'relay.json');

    const noDomain = runEntrypoint(temp.dir, {
      RELAY_TLS_CERT_FILE: cert,
      RELAY_TLS_KEY_FILE: key,
      RELAY_GROUP_EDGE_CERT_FILE: cert,
      RELAY_GROUP_EDGE_KEY_FILE: key,
      RELAY_DOMAIN: '',
    }, configPath);
    assert.equal(noDomain.status, 1);
    assert.match(noDomain.stderr, /RELAY_DOMAIN/);

    const noCert = runEntrypoint(temp.dir, {
      RELAY_DOMAIN: 'relay.test',
      RELAY_TLS_CERT_FILE: join(temp.dir, 'missing-cert.pem'),
      RELAY_TLS_KEY_FILE: key,
      RELAY_GROUP_EDGE_CERT_FILE: cert,
      RELAY_GROUP_EDGE_KEY_FILE: key,
    }, configPath);
    assert.equal(noCert.status, 1);
    assert.match(noCert.stderr, /证书缺失/);
    let generated = false;
    try {
      readFileSync(configPath);
      generated = true;
    } catch {
      generated = false;
    }
    assert.equal(generated, false);
  } finally {
    temp.cleanup();
  }
});
