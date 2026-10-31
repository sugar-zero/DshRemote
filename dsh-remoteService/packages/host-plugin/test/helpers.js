import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 每个测试独立 $DSH_HOME。 */
export function withTempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-remote-test-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  return {
    dir,
    cleanup() {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * 群体版设备身份：P-256 密钥 + 未压缩点公钥（base64url，65 字节 0x04||X||Y）。
 * 配对请求只提交公钥；私钥留在设备侧（App Secure Enclave / KeyStore）。
 * @param {string} [deviceName]
 */
export function makeGroupDevice(deviceName = 'Test iPhone') {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const publicKeyRaw = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]).toString('base64url');
  return { deviceName, privateKey, publicKey, publicKeyRaw };
}

/** 等一个谓词成立；超时抛错。 */
export function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        const value = predicate();
        if (value) { resolve(value); return; }
      } catch (error) { reject(error); return; }
      if (Date.now() - start > timeoutMs) { reject(new Error('timeout')); return; }
      setTimeout(tick, 10);
    };
    tick();
  });
}
