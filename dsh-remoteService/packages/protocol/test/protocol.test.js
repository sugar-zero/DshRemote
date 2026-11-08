/**
 * dsh-remote-protocol 测试（群体服务版，A 模式）。
 *
 * 0.2.0 起 protocol 只服务群体版：classic 配对 URI v1、隧道 HTTP classic 路径与 classic
 * 单机推送路由已删除；0.3.0 新增「服务端集中推送」常量（`PUSH_*` / `RELAY_MSG.PUSH_*`），
 * 本文件覆盖保留的群体版常量/辅助函数/推送枚举/设备会话鉴权/流帧。
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import test from 'node:test';
import * as protocol from '../index.js';
import {
  ADMIN_BASE,
  CONTROL_PATH,
  FRAME_TYPE,
  GROUP_AUTH_CHALLENGE_PATH,
  GROUP_AUTH_TOKEN_PATH,
  GROUP_DEFAULT_MOBILE_PORT,
  GROUP_EDGE_STREAM_KIND,
  GROUP_REGISTER_PATH,
  GROUP_REFRESH_PATH,
  GROUP_SESSION_COOKIE,
  GROUP_SESSION_DEFAULT_TTL_MS,
  PAIR_AUTH_TOKEN,
  PAIR_PATH,
  PAIR_STATUS_PATH,
  RELAY_MSG,
  STATUS_PATH,
  TUNNEL_BASE,
  base32Encode,
  buildGroupPairingUri,
  decodeFrame,
  encodeFrame,
  generateGroupHostId,
  groupDeviceChallengeMessage,
  groupDevicePublicKeyObject,
  hostFqdn,
  isGroupHostId,
  isValidGroupDeviceId,
  newGroupDeviceId,
  newPairingSecret,
  normalizeGroupHostName,
  pairingCode,
  pairingSas,
  parseCookieHeader,
  parseGroupPairingUri,
  safeEqualStrings,
  sha256Base64Url,
  shortFingerprint,
  signGroupSessionToken,
  verifyGroupDeviceSignature,
  verifyGroupSessionToken,
} from '../index.js';

test('group pairing URI v2 roundtrip keeps port/relay/hostId/fingerprint/expiry', () => {
  const uri = buildGroupPairingUri({
    host: 'h_ab12cd34.relay.example.com',
    port: 11443,
    secret: 'secret-value',
    hostFingerprint: 'Zm9vYmFy',
    expiresAt: 1_800_000_000_000,
    relayDomain: 'relay.example.com',
    hostId: 'h_ab12cd34',
  });
  assert.ok(!uri.includes('\n'));
  assert.match(uri, /^dshremote:\/\/pair\?/);
  const parsed = parseGroupPairingUri(uri);
  assert.equal(parsed.version, 2);
  assert.equal(parsed.host, 'h_ab12cd34.relay.example.com');
  assert.equal(parsed.port, 11443);
  assert.equal(parsed.secret, 'secret-value');
  assert.equal(parsed.hostFingerprint, 'Zm9vYmFy');
  assert.equal(parsed.expiresAt, 1_800_000_000_000);
  assert.equal(parsed.relayDomain, 'relay.example.com');
  assert.equal(parsed.hostId, 'h_ab12cd34');
  assert.equal(parsed.auth, PAIR_AUTH_TOKEN);
});

test('group pairing URI rejects classic v1 / missing auth / bad port', () => {
  assert.throws(() => parseGroupPairingUri('dshremote://pair?v=1&host=x&secret=y&hostfp=z&exp=1'), /不是群体版配对 URI/);
  assert.throws(() => parseGroupPairingUri('dshremote://pair?v=2&host=x&secret=y&hostfp=z&exp=1'), /缺少 auth=token/);
  assert.throws(
    () => parseGroupPairingUri('dshremote://pair?v=2&host=x&secret=y&hostfp=z&exp=1&auth=token&port=70000'),
    /port 非法/,
  );
  assert.throws(() => parseGroupPairingUri('https://pair?v=2&host=x&secret=y&hostfp=z&exp=1&auth=token'));
});

test('classic 符号已删除（回归守卫）', () => {
  for (const name of [
    'buildPairingUri',
    'parsePairingUri',
    'PAIR_URI_VERSION',
    'PAIR_APPROVE_PATH',
    'AUDIT_PATH',
    'DEVICES_PATH',
    'DEVICE_REVOKE_PATH_PREFIX',
    'RESTART_PATH',
    'normalizeRelayUrl',
    'ADMIN_ROUTES',
  ]) {
    assert.equal(Object.hasOwn(protocol, name), false, `${name} 应已从 protocol 删除`);
  }
  for (const message of ['HOST_STATUS']) {
    assert.equal(Object.hasOwn(RELAY_MSG, message), false, `RELAY_MSG.${message} 应已删除`);
  }
});

test('群体版推送常量（0.3.0）', () => {
  assert.equal(protocol.PUSH_TOKEN_PATH, '/__dsh_remote/push-token');
  assert.equal(RELAY_MSG.PUSH_REGISTER, 'push.register');
  assert.equal(RELAY_MSG.PUSH_REGISTERED, 'push.registered');
  assert.equal(RELAY_MSG.PUSH_SEND, 'push.send');
  assert.equal(RELAY_MSG.PUSH_RESULT, 'push.result');
  assert.deepEqual(protocol.PUSH_PROVIDER, { APNS: 'apns' });
  assert.deepEqual(protocol.PUSH_ENVIRONMENT, { DEVELOPMENT: 'development', PRODUCTION: 'production' });
  assert.deepEqual(protocol.PUSH_KINDS, { TURN_END: 'turn-end', WAITING_ANSWER: 'waiting-answer', ERROR: 'error' });
  assert.equal(protocol.isValidApnsDeviceToken('a'.repeat(64)), true);
  assert.equal(protocol.isValidApnsDeviceToken('A'.repeat(64)), false, 'APNs token 只接受小写 hex');
  assert.equal(protocol.isValidApnsDeviceToken('a'.repeat(63)), false);
  assert.equal(protocol.isValidApnsDeviceToken('g'.repeat(64)), false);
  assert.equal(protocol.isPushEnvironment('development'), true);
  assert.equal(protocol.isPushEnvironment('production'), true);
  assert.equal(protocol.isPushEnvironment('sandbox'), false);
  assert.equal(protocol.isPushKind('turn-end'), true);
  assert.equal(protocol.isPushKind('waiting-answer'), true);
  assert.equal(protocol.isPushKind('attention'), false);
  assert.ok(protocol.GROUP_PUSH_MAX_TOKENS_PER_HOST > 0);
  assert.ok(protocol.GROUP_PUSH_MAX_INTENTS_PER_MINUTE > 0);
  assert.ok(protocol.GROUP_PUSH_DEFAULT_COOLDOWN_SECONDS > 0);
});

test('R2 推送通道/登记契约（0.3.1）', () => {
  assert.deepEqual(protocol.PUSH_CHANNELS, { OFFICIAL: 'official', SELF: 'self' });
  assert.equal(protocol.PUSH_ENROLL_VERSION, 'dshremote-push-enroll-v1');
  assert.equal(protocol.PUSH_CREDENTIAL_TYP, 'dsh-push-device');
  assert.equal(protocol.PUSH_ENROLL_CHALLENGE_PATH, '/v1/enroll/challenge');
  assert.equal(protocol.PUSH_ENROLL_PATH, '/v1/enroll');
  assert.equal(protocol.PUSH_SEND_PATH, '/v1/push');

  assert.equal(protocol.isPushChannel('official'), true);
  assert.equal(protocol.isPushChannel('self'), true);
  assert.equal(protocol.isPushChannel('relay'), false);
  assert.equal(protocol.isPushChannel(undefined), false);
  assert.equal(protocol.normalizePushChannel(undefined), 'self', '旧客户端缺省 self');
  assert.equal(protocol.normalizePushChannel('official'), 'official');
  assert.equal(protocol.normalizePushChannel('bogus'), '');

  assert.equal(protocol.isValidBundleId('com.example.dshremote'), true);
  assert.equal(protocol.isValidBundleId('com.example.dsh-remote'), true);
  assert.equal(protocol.isValidBundleId('ab'), false);
  assert.equal(protocol.isValidBundleId('.com.example'), false);
  assert.equal(protocol.isValidBundleId('com.example.'), false);
  assert.equal(protocol.isValidBundleId('com..example'), true, '连续点不在协议层禁止（由 APNs 校验）');
  assert.equal(protocol.isValidBundleId('com example'), false);

  const message = protocol.pushEnrollMessage({
    challengeId: 'ch-1',
    nonce: 'nonce-1',
    devicePublicKey: 'pk-1',
    hostId: 'h_ab12cd34',
    token: 'a'.repeat(64),
    environment: 'development',
    bundleId: 'com.example.dshremote',
  });
  assert.equal(
    message.toString('utf8'),
    [
      'dshremote-push-enroll-v1',
      'ch-1',
      'nonce-1',
      'pk-1',
      'h_ab12cd34',
      'a'.repeat(64),
      'development',
      'com.example.dshremote',
    ].join('\n'),
  );
  assert.equal(message.at(-1), 0x65, '消息末尾不能有换行');
  // hostId 可缺省为空串，且 App 与 hub 的字节必须一致。
  const noHost = protocol.pushEnrollMessage({
    challengeId: 'ch-1', nonce: 'n', devicePublicKey: 'pk',
    token: 'b'.repeat(64), environment: 'production', bundleId: 'com.example.dshremote',
  });
  assert.ok(noHost.toString('utf8').split('\n')[4] === '');
});

test('群体版常量：控制面/隧道/注册/会话', () => {
  assert.equal(CONTROL_PATH, '/control');
  assert.equal(ADMIN_BASE, '/api/remote-access');
  assert.equal(TUNNEL_BASE, '/__dsh_remote');
  assert.equal(PAIR_PATH, '/__dsh_remote/pair');
  assert.equal(PAIR_STATUS_PATH, '/__dsh_remote/pair/status');
  assert.equal(STATUS_PATH, '/__dsh_remote/status');
  assert.equal(GROUP_REGISTER_PATH, '/__group/register');
  assert.equal(GROUP_REFRESH_PATH, '/__group/refresh');
  assert.equal(GROUP_AUTH_CHALLENGE_PATH, '/__group/auth/challenge');
  assert.equal(GROUP_AUTH_TOKEN_PATH, '/__group/auth/token');
  assert.equal(GROUP_EDGE_STREAM_KIND, 'group-edge');
  assert.equal(GROUP_DEFAULT_MOBILE_PORT, 11443);
  assert.match(GROUP_SESSION_COOKIE, /^__Host-/);
  assert.ok(GROUP_SESSION_DEFAULT_TTL_MS > 0);
});

test('base32 code is 12 chars and unambiguous alphabet', () => {
  const code = base32Encode(Buffer.from('0123456789abcdef0123456789abcdef01234567', 'hex'), 12);
  assert.equal(code.length, 12);
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{12}$/);
});

test('newPairingSecret / pairingCode / SAS 绑定主机与设备公钥', () => {
  const secret = newPairingSecret();
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  assert.match(pairingCode(Buffer.from(secret, 'base64url')), /^[0-9A-HJKMNP-TV-Z]{12}$/);

  const a = pairingSas('secret', 'hostA', 'deviceA');
  assert.match(a, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal(a, pairingSas('secret', 'hostA', 'deviceA'));
  assert.notEqual(a, pairingSas('secret', 'hostB', 'deviceA'));
  assert.notEqual(a, pairingSas('secret', 'hostA', 'deviceB'));
});

test('hostFqdn / sha256Base64Url / shortFingerprint', () => {
  assert.equal(hostFqdn('h_ab12cd34', 'relay.example.com'), 'h_ab12cd34.relay.example.com');
  const hash = sha256Base64Url('hello');
  assert.equal(hash, 'LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ');
  assert.equal(sha256Base64Url(Buffer.from('hello')), hash);
  assert.equal(shortFingerprint('ABCDEFGHIJKLMNOP', 2, 4), 'ABCD · EFGH');
});

test('group hostId / deviceId 生成与校验', () => {
  for (let i = 0; i < 5; i += 1) {
    const hostId = generateGroupHostId();
    assert.match(hostId, /^h_[a-z0-9]{6,30}$/);
    assert.equal(isGroupHostId(hostId), true);
  }
  assert.equal(isGroupHostId('H_AB12CD34'), false);
  assert.equal(isGroupHostId('h_ab'), false);
  assert.equal(isGroupHostId('nope'), false);

  const deviceId = newGroupDeviceId();
  assert.match(deviceId, /^d_[a-z0-9]{6,40}$/);
  assert.equal(isValidGroupDeviceId(deviceId), true);
  assert.equal(isValidGroupDeviceId('d_AB'), false);

  assert.equal(normalizeGroupHostName('  客厅 Mac\n'), '客厅 Mac');
  assert.equal(normalizeGroupHostName('x'.repeat(100)).length, 64);
});

test('device challenge 消息 + P-256 签名校验', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  const publicKeyB64Url = raw.toString('base64url');
  assert.equal(groupDevicePublicKeyObject(publicKeyB64Url).asymmetricKeyType, 'ec');

  const message = groupDeviceChallengeMessage('h_ab12cd34', 'd_abc123', 'nonce-1');
  const signature = nodeSign('sha256', message, privateKey).toString('base64url');
  assert.equal(verifyGroupDeviceSignature({ publicKey: publicKeyB64Url, message, signature }), true);
  assert.equal(verifyGroupDeviceSignature({ publicKey: publicKeyB64Url, message: Buffer.from('other'), signature }), false);
  assert.equal(verifyGroupDeviceSignature({ publicKey: 'not-a-key', message, signature }), false);
});

test('group session token：签发/校验/过期/hostId 绑定/防篡改', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const issued = signGroupSessionToken({ privateKey, hostId: 'h_ab12cd34', deviceId: 'd_abc123' });
  assert.match(issued.token, /^v1\./);
  assert.equal(issued.payload.hostId, 'h_ab12cd34');

  assert.equal(verifyGroupSessionToken({ token: issued.token, publicKey: publicKeyPem }).deviceId, 'd_abc123');
  assert.equal(verifyGroupSessionToken({ token: issued.token, publicKey: publicKeyPem, hostId: 'h_ab12cd34' }).hostId, 'h_ab12cd34');
  assert.equal(verifyGroupSessionToken({ token: issued.token, publicKey: publicKeyPem, hostId: 'h_other' }), undefined);

  // 过期（注入 now）
  const expiredAt = (issued.payload.exp + 1) * 1000;
  assert.equal(verifyGroupSessionToken({ token: issued.token, publicKey: publicKeyPem, now: expiredAt }), undefined);

  // 篡改 body
  const [version, , sig] = issued.token.split('.');
  const tampered = `${version}.${Buffer.from(JSON.stringify({ v: 1, hostId: 'h_evil', deviceId: 'd_evil', iat: 0, exp: 9_999_999_999 })).toString('base64url')}.${sig}`;
  assert.equal(verifyGroupSessionToken({ token: tampered, publicKey: publicKeyPem }), undefined);

  // 错误密钥
  const other = generateKeyPairSync('ed25519');
  assert.equal(
    verifyGroupSessionToken({ token: issued.token, publicKey: other.publicKey.export({ format: 'pem', type: 'spki' }).toString() }),
    undefined,
  );
});

test('parseCookieHeader', () => {
  assert.deepEqual(parseCookieHeader('a=1; b=2; a=3'), { a: '1', b: '2' });
  assert.deepEqual(parseCookieHeader(''), {});
  assert.deepEqual(parseCookieHeader('noseparator'), {});
});

test('frame encode/decode', () => {
  const frame = encodeFrame(FRAME_TYPE.DATA, 42, Buffer.from('hello'));
  const decoded = decodeFrame(frame);
  assert.equal(decoded.type, FRAME_TYPE.DATA);
  assert.equal(decoded.streamId, 42);
  assert.equal(decoded.payload.toString(), 'hello');
  assert.equal(decodeFrame(Buffer.from([1, 2])), undefined);
});

test('safeEqualStrings handles unequal lengths without throwing', () => {
  assert.equal(safeEqualStrings('abc', 'abc'), true);
  assert.equal(safeEqualStrings('abc', 'abcd'), false);
  assert.equal(safeEqualStrings('', 'x'), false);
});
