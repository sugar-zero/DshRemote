import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { paths, ensureDir, readJson, writeJson } from './paths.js';
import { sha256Base64Url } from 'dsh-remote-protocol';

/**
 * ED25519 主机身份：只用于稳定的主机指纹（配对二维码 / SAS / 设置页展示）。
 * 群体版不需要主机证书或设备 CA —— 设备身份来自「配对登记的 P-256 公钥 + 服务端短时 token」。
 */
export function loadOrCreateHostIdentity() {
  const file = paths.hostIdentity();
  const stored = readJson(file, undefined);
  if (stored?.privateKeyJwk) {
    const privateKey = createPrivateKey({ key: stored.privateKeyJwk, format: 'jwk' });
    const publicKey = createPublicKey(privateKey);
    return {
      status: 'loaded',
      privateKey,
      publicKey,
      publicKeyDerB64: stored.publicKeyDerB64,
      fingerprint: sha256Base64Url(Buffer.from(stored.publicKeyDerB64, 'base64url')),
    };
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyDerB64 = Buffer.from(der).toString('base64url');
  const privateKeyJwk = privateKey.export({ format: 'jwk' });
  ensureDir(paths.dir());
  writeJson(file, { version: 1, publicKeyDerB64, privateKeyJwk });
  return {
    status: 'created',
    privateKey,
    publicKey,
    publicKeyDerB64,
    fingerprint: sha256Base64Url(Buffer.from(publicKeyDerB64, 'base64url')),
  };
}
