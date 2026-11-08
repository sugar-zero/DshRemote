import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PUSH_CREDENTIAL_TYP, PUSH_CREDENTIAL_VERSION, sha256Base64Url } from 'dsh-remote-protocol';
import {
  HUB_SIGNING_KEY_FILE_MODE,
  decodeCredential,
  issueDeviceCredential,
  loadOrCreateSigningKey,
  signCredential,
  signingKeyId,
  verifyCredential,
} from '../index.js';
import { cleanupDir, makeTempDir, silentLogger } from './helpers.js';

const AUDIENCE = 'https://push.example.com';
const TOPIC = 'com.example.dshremote.test';

/** @param {string} file @returns {number} */
function permissions(file) {
  return statSync(file).mode & 0o777;
}

test('credential: 签名 key 不存在时自动生成（0600 / 目录 0700 / kid 稳定）', () => {
  const dir = makeTempDir();
  try {
    const keyFile = join(dir, 'keys', 'push-hub-signing-key.pem');
    const first = loadOrCreateSigningKey(keyFile, { logger: silentLogger() });
    assert.equal(first.generated, true);
    assert.equal(permissions(keyFile), HUB_SIGNING_KEY_FILE_MODE);
    assert.equal(permissions(join(dir, 'keys')), 0o700);
    assert.match(readFileSync(keyFile, 'utf8'), /BEGIN PRIVATE KEY/);
    assert.equal(first.privateKey.asymmetricKeyType, 'ed25519');
    assert.equal(first.publicKey.asymmetricKeyType, 'ed25519');
    assert.match(first.kid, /^[A-Za-z0-9_-]{16}$/);
    assert.equal(first.kid, signingKeyId(first.publicKey));

    // 重启再次加载：同一把 key、kid 不变、不再标记 generated。
    const second = loadOrCreateSigningKey(keyFile, { logger: silentLogger() });
    assert.equal(second.generated, false);
    assert.equal(second.kid, first.kid);
    assert.equal(
      first.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      second.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    );
  } finally {
    cleanupDir(dir);
  }
});

test('credential: 已存在但权限过宽的 key 会被收紧为 0600', () => {
  const dir = makeTempDir();
  try {
    const keyFile = join(dir, 'signing.pem');
    mkdirSync(dir, { recursive: true });
    // 先用正常流程生成，再把权限放开。
    loadOrCreateSigningKey(keyFile, { logger: silentLogger() });
    chmodSync(keyFile, 0o644);
    /** @type {string[]} */
    const warnings = [];
    const logger = { debug() {}, info() {}, error() {}, warn: (message) => warnings.push(message) };
    loadOrCreateSigningKey(keyFile, { logger });
    assert.equal(permissions(keyFile), 0o600);
    assert.ok(warnings.some((line) => line.includes('权限过宽')));
  } finally {
    cleanupDir(dir);
  }
});

test('credential: 非法 key 文件给可操作错误（不含密钥内容）', () => {
  const dir = makeTempDir();
  try {
    const ecFile = join(dir, 'ec.pem');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    writeFileSync(ecFile, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    assert.throws(
      () => loadOrCreateSigningKey(ecFile, { logger: silentLogger() }),
      /must be an Ed25519 PKCS#8 key/,
    );

    const brokenFile = join(dir, 'broken.pem');
    writeFileSync(brokenFile, 'not a pem');
    assert.throws(
      () => loadOrCreateSigningKey(brokenFile, { logger: silentLogger() }),
      /not a valid PEM private key/,
    );
    assert.throws(() => loadOrCreateSigningKey('', { logger: silentLogger() }), /signingKeyFile 未配置/);
  } finally {
    cleanupDir(dir);
  }
});

test('credential: 签发/校验往返（claims 绑定 tokenHash/hostId/env/bundleId/aud/jti/exp）', () => {
  const dir = makeTempDir();
  try {
    const signing = loadOrCreateSigningKey(join(dir, 'signing.pem'), { logger: silentLogger() });
    const token = 'a'.repeat(64);
    const tokenHash = sha256Base64Url(token);
    const nowMs = 1_700_000_000_000;
    const issued = issueDeviceCredential({
      privateKey: signing.privateKey,
      kid: signing.kid,
      audience: AUDIENCE,
      ttlDays: 7,
      tokenHash,
      environment: 'production',
      bundleId: TOPIC,
      hostId: 'h_ab12cd34',
      now: () => nowMs,
    });
    assert.equal(issued.expiresAt, Math.floor(nowMs / 1000 + 7 * 86_400) * 1000);
    const verified = verifyCredential({
      publicKey: signing.publicKey,
      credential: issued.credential,
      audience: AUDIENCE,
      bundleId: TOPIC,
      now: () => nowMs,
    });
    assert.equal(verified.ok, true);
    assert.equal(verified.claims.typ, PUSH_CREDENTIAL_TYP);
    assert.equal(verified.claims.v, PUSH_CREDENTIAL_VERSION);
    assert.equal(verified.claims.tokenHash, tokenHash);
    assert.equal(verified.claims.env, 'production');
    assert.equal(verified.claims.bundleId, TOPIC);
    assert.equal(verified.claims.hostId, 'h_ab12cd34');
    assert.equal(verified.claims.aud, AUDIENCE);
    assert.match(verified.claims.jti, /^[0-9a-f-]{36}$/);
    assert.equal(verified.claims.iat, Math.floor(nowMs / 1000));
    assert.equal(verified.claims.exp, Math.floor(nowMs / 1000) + 7 * 86_400);
    assert.equal(verified.header.alg, 'EdDSA');
    assert.equal(verified.header.typ, 'JWT');
    assert.equal(verified.header.kid, signing.kid);
    // JWT 三段式；header/claims 可独立解码。
    const decoded = decodeCredential(issued.credential);
    assert.equal(decoded.claims.jti, verified.claims.jti);

    // hostId 空字符串时 claims 不带该字段。
    const noHost = issueDeviceCredential({
      privateKey: signing.privateKey, kid: signing.kid, audience: AUDIENCE, ttlDays: 1,
      tokenHash, environment: 'development', bundleId: TOPIC, hostId: '', now: () => nowMs,
    });
    assert.equal(Object.hasOwn(decodeCredential(noHost.credential).claims, 'hostId'), false);
  } finally {
    cleanupDir(dir);
  }
});

test('credential: 过期 / audience 不匹配 / bundleId 不匹配 / 篡改', () => {
  const dir = makeTempDir();
  try {
    const signing = loadOrCreateSigningKey(join(dir, 'signing.pem'), { logger: silentLogger() });
    const nowMs = 1_700_000_000_000;
    const tokenHash = sha256Base64Url('b'.repeat(64));
    const issued = issueDeviceCredential({
      privateKey: signing.privateKey,
      kid: signing.kid,
      audience: AUDIENCE,
      ttlDays: 1,
      tokenHash,
      environment: 'production',
      bundleId: TOPIC,
      now: () => nowMs,
    });
    /** @param {object} [overrides] */
    const verify = (overrides = {}) => verifyCredential({
      publicKey: signing.publicKey,
      credential: issued.credential,
      audience: AUDIENCE,
      bundleId: TOPIC,
      now: () => nowMs,
      ...overrides,
    });
    assert.equal(verify().ok, true);
    // 过期（TTL 1 天，推进 2 天）。
    const expired = verify({ now: () => nowMs + 2 * 86_400_000 });
    assert.deepEqual([expired.ok, expired.code], [false, 'credential_expired']);
    // audience 不匹配（HUB_PUBLIC_URL 变了/别的 hub 的 credential）。
    const wrongAud = verify({ audience: 'https://other.example.com' });
    assert.deepEqual([wrongAud.ok, wrongAud.code], [false, 'invalid_credential']);
    // bundleId 不匹配（credential 不是给本 hub topic 的）。
    const wrongBundle = verify({ bundleId: 'com.example.other' });
    assert.deepEqual([wrongBundle.ok, wrongBundle.code], [false, 'unsupported_bundle_id']);
    // 篡改 claims（保持签名不变）。
    const [headerPart, claimsPart, signaturePart] = issued.credential.split('.');
    const claims = JSON.parse(Buffer.from(claimsPart, 'base64url').toString('utf8'));
    claims.tokenHash = sha256Base64Url('c'.repeat(64));
    const tampered = `${headerPart}.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.${signaturePart}`;
    const tamperedResult = verify({ credential: tampered });
    assert.deepEqual([tamperedResult.ok, tamperedResult.code], [false, 'invalid_credential']);
    // 篡改签名。
    const badSig = `${headerPart}.${claimsPart}.${randomBytes(64).toString('base64url')}`;
    assert.equal(verify({ credential: badSig }).code, 'invalid_credential');
    // 不是 JWT / alg 不对。
    assert.equal(verify({ credential: 'not-a-jwt' }).code, 'invalid_credential');
    assert.equal(verify({ credential: 'a.b.c' }).code, 'invalid_credential');
  } finally {
    cleanupDir(dir);
  }
});

test('credential: 用别的 key 签发的 credential 不能通过校验', () => {
  const dir = makeTempDir();
  try {
    const signing = loadOrCreateSigningKey(join(dir, 'signing.pem'), { logger: silentLogger() });
    const { privateKey: otherKey } = generateKeyPairSync('ed25519');
    const tokenHash = sha256Base64Url('d'.repeat(64));
    const nowMs = 1_700_000_000_000;
    const claims = {
      v: PUSH_CREDENTIAL_VERSION,
      typ: PUSH_CREDENTIAL_TYP,
      tokenHash,
      env: 'production',
      bundleId: TOPIC,
      aud: AUDIENCE,
      jti: 'jti-1',
      iat: Math.floor(nowMs / 1000),
      exp: Math.floor(nowMs / 1000) + 60,
    };
    const foreign = signCredential({ privateKey: otherKey, kid: signing.kid, claims });
    const result = verifyCredential({ publicKey: signing.publicKey, credential: foreign, audience: AUDIENCE, bundleId: TOPIC, now: () => nowMs });
    assert.deepEqual([result.ok, result.code], [false, 'invalid_credential']);
    // 同一份 claims 用正确 key 签就是合法的（证明失败原因是 key 而非字段）。
    const own = signCredential({ privateKey: signing.privateKey, kid: signing.kid, claims });
    assert.equal(verifyCredential({ publicKey: signing.publicKey, credential: own, audience: AUDIENCE, bundleId: TOPIC, now: () => nowMs }).ok, true);
    // 头/claims 是 base64url JSON（不依赖第三方库），sha256 校验辅助自检。
    assert.equal(
      createHash('sha256').update('x').digest('base64url'),
      sha256Base64Url('x'),
    );
  } finally {
    cleanupDir(dir);
  }
});
