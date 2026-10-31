/**
 * 群组版部署体验：entrypoint 在 group 模式下按 .env 自动生成 relay.json。
 *
 * 覆盖：
 *   - 缺失配置文件 + .env 齐备 → 生成 0600 JSON（域名/端口/证书路径/后台/鉴权文件）；
 *   - 已存在配置文件 → 绝不覆盖；
 *   - 缺 RELAY_DOMAIN / 证书缺失 → 可操作报错（exit 1）。
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

const ENTRYPOINT = fileURLToPath(new URL('../relay-entrypoint.sh', import.meta.url));

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-relay-envconfig-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** @param {Record<string,string>} overrides */
function runEntrypoint(dir, overrides, configPath = join(dir, 'config', 'relay.json')) {
  const env = {
    ...process.env,
    RELAY_MODE: 'group',
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
    assert.equal(generated.mode, 'group');
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
