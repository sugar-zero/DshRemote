import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createHostToken,
  defaultTokensFile,
  listHostTokens,
  loadHostTokens,
  normalizeHostId,
  readTokenStore,
  revokeHostToken,
} from '../index.js';

const BIN = fileURLToPath(new URL('../bin/relay.js', import.meta.url));

/** @param {string[]} args */
function runCli(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-relay-cli-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('createHostToken writes a 0600 tokens file and list/revoke work', () => {
  const temp = tempDir();
  try {
    const file = join(temp.dir, 'tokens.json');
    const created = createHostToken(file, 'h_ab12cd34');
    assert.equal(created.hostId, 'h_ab12cd34');
    assert.equal(created.rotated, false);
    assert.match(created.token, /^[A-Za-z0-9_-]{40,}$/, 'token is base64url of 32 random bytes');
    assert.equal(loadHostTokens(file).h_ab12cd34, created.token);

    if (process.platform !== 'win32') {
      assert.equal(statSync(file).mode & 0o777, 0o600, 'tokens file must be 0600');
    }
    const stored = readTokenStore(file);
    assert.equal(stored.tokens.h_ab12cd34.token, created.token);
    assert.ok(stored.tokens.h_ab12cd34.createdAt > 0);

    const listed = listHostTokens(file);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].hostId, 'h_ab12cd34');
    assert.notEqual(listed[0].maskedToken, created.token, 'list never prints the full token');
    assert.match(listed[0].maskedToken, /…/);

    // 轮换：同一 hostId 重新签发 → 旧 token 失效
    const rotated = createHostToken(file, 'h_ab12cd34');
    assert.equal(rotated.rotated, true);
    assert.notEqual(rotated.token, created.token);
    assert.equal(loadHostTokens(file).h_ab12cd34, rotated.token);

    assert.equal(revokeHostToken(file, 'h_ab12cd34'), true);
    assert.deepEqual(loadHostTokens(file), {});
    assert.equal(revokeHostToken(file, 'h_ab12cd34'), false);
    assert.equal(listHostTokens(file).length, 0);
  } finally {
    temp.cleanup();
  }
});

test('normalizeHostId enforces DNS-label-safe ids and defaultTokensFile follows config dir', () => {
  assert.equal(normalizeHostId('  H_AB12cd34 '), 'h_ab12cd34');
  for (const bad of ['', 'has space', 'dot.separated', 'x'.repeat(64), '-leading', 'trailing-']) {
    assert.throws(() => normalizeHostId(bad), /invalid hostId/);
  }
  assert.equal(defaultTokensFile('/etc/dsh-relay/relay.json'), '/etc/dsh-relay/tokens.json');
  assert.equal(defaultTokensFile(undefined), join(process.cwd(), 'tokens.json'));
});

test('CLI: token create/list/revoke (--json) and --help', () => {
  const temp = tempDir();
  try {
    const file = join(temp.dir, 'tokens.json');

    const created = runCli(['token', 'create', 'h_cli', '--tokens-file', file, '--json']);
    assert.equal(created.status, 0, created.stderr);
    const createdJson = JSON.parse(created.stdout.trim());
    assert.equal(createdJson.hostId, 'h_cli');
    assert.match(createdJson.token, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(createdJson.rotated, false);
    assert.equal(createdJson.tokensFile, file);

    const listed = runCli(['token', 'list', '--tokens-file', file, '--json']);
    assert.equal(listed.status, 0, listed.stderr);
    const listJson = JSON.parse(listed.stdout);
    assert.equal(listJson.tokensFile, file);
    assert.deepEqual(listJson.hosts.map((host) => host.hostId), ['h_cli']);
    assert.notEqual(listJson.hosts[0].maskedToken, createdJson.token);

    const revoked = runCli(['token', 'revoke', 'h_cli', '--tokens-file', file, '--json']);
    assert.equal(revoked.status, 0, revoked.stderr);
    assert.equal(JSON.parse(revoked.stdout.trim()).revoked, true);
    assert.deepEqual(runCli(['token', 'list', '--tokens-file', file, '--json']).status, 0);
    assert.deepEqual(JSON.parse(runCli(['token', 'list', '--tokens-file', file, '--json']).stdout).hosts, []);

    const revokeMissing = runCli(['token', 'revoke', 'h_nope', '--tokens-file', file, '--json']);
    assert.equal(revokeMissing.status, 1);

    const help = runCli(['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /token create <hostId>/);
    assert.match(help.stdout, /RELAY_DOMAIN/);
  } finally {
    temp.cleanup();
  }
});

test('CLI: token file defaults to the --config directory', () => {
  const temp = tempDir();
  try {
    const configPath = join(temp.dir, 'relay.json');
    writeFileSync(configPath, JSON.stringify({ domain: 'relay.test', dev: true }), 'utf8');
    const result = runCli(['token', 'create', 'h_cfg', '--config', configPath, '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout.trim()).tokensFile, join(temp.dir, 'tokens.json'));
    assert.equal(JSON.parse(readFileSync(join(temp.dir, 'tokens.json'), 'utf8')).tokens.h_cfg.token.length > 40, true);
  } finally {
    temp.cleanup();
  }
});
