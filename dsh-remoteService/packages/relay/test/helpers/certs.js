/**
 * 测试辅助：自签证书 + 静默 logger。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 测试里不需要 relay 日志。 */
export const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * 用 openssl CLI 生成自签证书（SAN 供 tls.connect 校验；自签即信任锚）。
 * @param {{commonName?: string, sans?: string[], days?: number}} [options]
 * @returns {{dir: string, keyFile: string, certFile: string, key: Buffer, cert: Buffer, cleanup: () => void}}
 */
export function generateSelfSignedCert({ commonName = 'poc.relay.test', sans = [commonName], days = 1 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-relay-cert-'));
  const keyFile = join(dir, 'key.pem');
  const certFile = join(dir, 'cert.pem');
  const args = [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
    '-days', String(days),
    '-keyout', keyFile,
    '-out', certFile,
    '-subj', `/CN=${commonName}`,
    '-addext', 'basicConstraints=critical,CA:TRUE',
  ];
  if (sans.length > 0) args.push('-addext', `subjectAltName=${sans.map((name) => `DNS:${name}`).join(',')}`);
  try {
    execFileSync('openssl', args, { stdio: 'pipe' });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    const stderr = err && err.stderr ? err.stderr.toString() : '';
    throw new Error(`openssl failed to generate a test certificate: ${stderr || (err && err.message)}`);
  }
  return {
    dir,
    keyFile,
    certFile,
    key: readFileSync(keyFile),
    cert: readFileSync(certFile),
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
