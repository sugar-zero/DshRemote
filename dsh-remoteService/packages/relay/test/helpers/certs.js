/**
 * 测试辅助：自签证书 + 真实 ClientHello 捕获 + 静默 logger。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { parseClientHello } from '../../lib/sni.js';

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

/**
 * 真实捕获一段 ClientHello：起一个 raw net server，让真实 `tls.connect` 向它发起握手，
 * 只收集字节、不完成握手（我们只关心 SNI 解析）。
 *
 * 注意：显式传 `servername: undefined` 表示"不发送 SNI"（例如按 IP 连接）；
 * 不传该字段才默认使用 'poc.relay.test'。
 *
 * @param {{servername?: string, host?: string, timeoutMs?: number}} [options]
 * @returns {Promise<Buffer>} 捕获到的原始字节（至少包含完整 ClientHello）
 */
export function captureClientHello(options = {}) {
  const { host = '127.0.0.1', timeoutMs = 5000 } = options;
  const servername = Object.hasOwn(options, 'servername') ? options.servername : 'poc.relay.test';
  return new Promise((resolve, reject) => {
    let settled = false;
    /** @type {import('node:net').Server | null} */
    const server = net.createServer((socket) => {
      let buffered = Buffer.alloc(0);
      socket.on('error', () => {});
      socket.on('data', (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (parseClientHello(buffered).status !== 'incomplete' && !settled) {
          settled = true;
          socket.destroy();
          server.close();
          resolve(buffered);
        }
      });
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.close();
      reject(new Error('timed out capturing a ClientHello'));
    }, timeoutMs);
    timer.unref?.();
    server.on('close', () => clearTimeout(timer));
    server.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    server.listen(0, host, () => {
      const address = /** @type {import('node:net').AddressInfo} */ (server.address());
      const client = tls.connect({
        host,
        port: address.port,
        servername,
        rejectUnauthorized: false,
      });
      client.on('error', () => {});
    });
  });
}
