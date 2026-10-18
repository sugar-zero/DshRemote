import { X509Certificate } from 'node:crypto';
import { createServer as createHttpsServer } from 'node:https';

/**
 * 校验 TLS 客户端证书：必须由设备 CA 签发、证书有效、serial 在设备注册表中且未撤销。
 * 注意：这里不使用 Host/X-Forwarded-* 任何请求头做身份判断。
 */
export function createPeerVerifier({ devices, caCertPem }) {
  const ca = new X509Certificate(caCertPem);
  return function verifyPeer(socket) {
    let raw;
    try {
      raw = socket.getPeerCertificate?.(true);
    } catch {
      raw = undefined;
    }
    if (!raw || !raw.raw) return { ok: false, code: 'client-cert-missing' };
    let cert;
    try {
      cert = new X509Certificate(raw.raw);
    } catch {
      return { ok: false, code: 'client-cert-invalid' };
    }
    const now = Date.now();
    const from = Date.parse(cert.validFrom);
    const to = Date.parse(cert.validTo);
    if (Number.isFinite(from) && from > now) return { ok: false, code: 'client-cert-not-yet-valid' };
    if (Number.isFinite(to) && to < now) return { ok: false, code: 'client-cert-expired' };
    let trusted = false;
    try {
      trusted = cert.checkIssued(ca) && cert.verify(ca.publicKey);
    } catch {
      trusted = false;
    }
    if (!trusted) return { ok: false, code: 'client-cert-untrusted' };
    const serial = String(cert.serialNumber ?? '').toUpperCase();
    const device = devices.findBySerial(serial);
    if (!device) return { ok: false, code: 'device-unknown' };
    if (device.revokedAt) return { ok: false, code: 'device-revoked' };
    if (device.notAfter && device.notAfter < now) return { ok: false, code: 'device-cert-expired' };
    return { ok: true, device: { ...device }, cert, serial };
  };
}

/** 主机插件远程 TLS 监听（mTLS：requestCert 但自行校验，便于按设备注册表判定）。 */
export function createRemoteTlsServer({ certPem, keyPem }) {
  return createHttpsServer({
    key: keyPem,
    cert: certPem,
    requestCert: true,
    rejectUnauthorized: false,
    minVersion: 'TLSv1.2',
  });
}
