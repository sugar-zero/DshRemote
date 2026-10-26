import { randomBytes, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  buildPairingUri,
  hostFqdn,
  newPairingSecret,
  pairingCode,
  pairingSas,
  safeEqualStrings,
} from 'dsh-remote-protocol';
import { parseDeviceCsr, signDeviceCertificate } from './identity.js';
import { hostAddress } from './config.js';

export const PAIRING_TTL_MS = 120_000;
export const PAIRING_MAX_ATTEMPTS_PER_IP = 10;
export const PAIRING_ATTEMPT_WINDOW_MS = 60_000;

export class PairingError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'PairingError';
    this.code = code;
    this.status = status;
  }
}

/** 配对会话状态机：创建 → 等待扫码 → pending（桌面确认）/ paired。 */
export class PairingManager {
  constructor({ identity, ca, devices, audit, getConfig, log = () => {} }) {
    this.identity = identity;
    this.ca = ca;
    this.devices = devices;
    this.audit = audit;
    this.getConfig = getConfig;
    this.log = log;
    this.session = undefined;
    this.attempts = new Map(); // ip -> { count, resetAt }
  }

  now() {
    return Date.now();
  }

  cleanup() {
    const s = this.session;
    if (!s) return;
    if (s.status === 'paired' || s.status === 'denied') {
      if (s.resultKeptUntil && s.resultKeptUntil < this.now()) this.session = undefined;
      return;
    }
    if (s.expiresAt < this.now()) {
      s.status = 'expired';
      this.session = undefined;
      this.audit.append({ action: 'pairing', result: 'expired' });
    }
  }

  /** 创建一次性配对会话（会取消旧的）。 */
  createSession() {
    this.cleanup();
    const config = this.getConfig();
    if (!config.hostId || !config.relayDomain) {
      throw new PairingError('not-configured', '请先配置 hostId / relayDomain 并启用远程访问', 409);
    }
    const fqdn = hostAddress(config);
    const secret = newPairingSecret();
    const expiresAt = this.now() + PAIRING_TTL_MS;
    const uri = buildPairingUri({
      host: fqdn,
      secret,
      hostFingerprint: this.identity.fingerprint,
      expiresAt,
      relayDomain: config.relayDomain,
    });
    const session = {
      pairingId: `p_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      secret,
      code: pairingCode(Buffer.from(secret, 'base64url')),
      uri,
      createdAt: this.now(),
      expiresAt,
      status: 'waiting',
      requiresApproval: Boolean(config.requireApproval),
      sas: null,
      ticket: null,
      temp: null,
      result: null,
      attempts: 0,
    };
    this.session = session;
    this.audit.append({ action: 'pairing', resource: session.pairingId, result: 'created' });
    return this.publicSession();
  }

  publicSession() {
    this.cleanup();
    const s = this.session;
    if (!s) return { active: false };
    return {
      active: s.status === 'waiting' || s.status === 'pending',
      pairingId: s.pairingId,
      expiresAt: s.expiresAt,
      requiresApproval: s.requiresApproval,
      status: s.status,
      uri: s.uri,
      code: s.code,
      sas: s.sas,
      pendingDevice: s.status === 'pending' && s.temp
        ? { name: s.temp.name, platform: s.temp.platform }
        : null,
    };
  }

  cancel() {
    if (this.session) {
      this.audit.append({ action: 'pairing', resource: this.session.pairingId, result: 'cancelled' });
      this.session = undefined;
    }
    return { active: false };
  }

  rateLimit(ip) {
    const key = String(ip ?? 'unknown');
    const now = this.now();
    let entry = this.attempts.get(key);
    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + PAIRING_ATTEMPT_WINDOW_MS };
      this.attempts.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > PAIRING_MAX_ATTEMPTS_PER_IP) {
      throw new PairingError('rate-limited', '配对尝试过于频繁，请稍后再试', 429);
    }
  }

  /**
   * App 侧提交配对请求（带一次性密钥 + CSR）。
   * @returns {Promise<{status:'paired'|'pending', ...}>}
   */
  handlePairRequest({ secret, csrPem, deviceName, platform, remoteAddress }) {
    this.cleanup();
    this.rateLimit(remoteAddress);
    const s = this.session;
    if (!s || s.status === 'expired' || s.status === 'paired' || s.status === 'denied') {
      throw new PairingError('no-active-pairing', '没有有效的配对会话，请在桌面端重新生成二维码', 409);
    }
    if (s.expiresAt < this.now()) {
      throw new PairingError('pairing-expired', '配对码已过期，请重新生成', 410);
    }
    if (!safeEqualStrings(secret, s.secret)) {
      s.attempts += 1;
      this.audit.append({ action: 'pairing', resource: s.pairingId, result: 'bad-secret' });
      if (s.attempts >= PAIRING_MAX_ATTEMPTS_PER_IP) this.cancel();
      throw new PairingError('invalid-secret', '配对密钥不正确', 403);
    }
    const parsed = parseDeviceCsr(csrPem);
    if (parsed.engine === 'js') {
      this.log('openssl 不可用，已回退纯 JS 校验 EC 设备 CSR（Windows 无需安装 openssl）');
    }
    const sas = pairingSas(s.secret, this.identity.publicKeyDerB64, parsed.publicKeyFingerprint);
    const temp = {
      deviceId: `d_${randomBytes(6).toString('hex')}`,
      name: String(deviceName || '新设备').slice(0, 80),
      platform: String(platform || 'unknown').slice(0, 20),
      csrPem,
      publicKeyFingerprint: parsed.publicKeyFingerprint,
    };
    if (!s.requiresApproval) return this.issue(s, temp);

    s.status = 'pending';
    s.sas = sas;
    s.temp = temp;
    s.ticket = randomUUID();
    this.audit.append({ action: 'pairing', resource: s.pairingId, result: 'pending-approval' });
    return { status: 'pending', ticket: s.ticket, sas, expiresAt: s.expiresAt, hostName: this.hostName(), hostFingerprint: this.identity.fingerprint };
  }

  /** 桌面端确认/拒绝。 */
  approve({ pairingId, ticket, approve }) {
    this.cleanup();
    const s = this.session;
    if (!s || s.pairingId !== pairingId) throw new PairingError('no-such-pairing', '配对会话不存在或已过期', 404);
    if (s.status !== 'pending' || !s.temp) throw new PairingError('not-pending', '没有等待确认的配对请求', 409);
    if (ticket && s.ticket !== ticket) throw new PairingError('bad-ticket', '配对确认票据不正确', 403);
    if (approve === false) {
      s.status = 'denied';
      s.resultKeptUntil = this.now() + PAIRING_TTL_MS;
      this.audit.append({ action: 'pairing', resource: s.pairingId, result: 'denied' });
      return { status: 'denied' };
    }
    return this.issue(s, s.temp);
  }

  issue(session, temp) {
    const signed = signDeviceCertificate({
      ca: this.ca,
      csrPem: temp.csrPem,
      deviceId: temp.deviceId,
      commonName: temp.name,
      days: 30,
    });
    if (signed.engine === 'js') {
      this.log('openssl 不可用或签发失败，已回退纯 JS 签发 EC 设备证书');
    }
    const device = this.devices.add({
      id: temp.deviceId,
      name: temp.name,
      platform: temp.platform,
      serial: signed.serial,
      publicKeyFingerprint: signed.devicePublicKeyFingerprint,
      notAfter: signed.notAfter,
    });
    session.status = 'paired';
    session.result = {
      status: 'paired',
      deviceId: device.id,
      deviceName: device.name,
      serial: device.serial,
      certPem: signed.certPem,
      caPem: this.ca.certPem,
      notAfter: signed.notAfter,
      hostName: this.hostName(),
      hostFingerprint: this.identity.fingerprint,
    };
    session.resultKeptUntil = this.now() + 5 * 60 * 1000;
    this.audit.append({ deviceId: device.id, action: 'pairing', resource: session.pairingId, result: 'paired', hash: signed.devicePublicKeyFingerprint });
    return session.result;
  }

  /** App 轮询桌面确认结果。 */
  statusFor(ticket) {
    this.cleanup();
    const s = this.session;
    if (!s || !ticket || s.ticket !== ticket) throw new PairingError('no-such-pairing', '配对请求不存在或已过期', 404);
    if (s.status === 'pending') return { status: 'pending', sas: s.sas, expiresAt: s.expiresAt };
    if (s.status === 'denied') return { status: 'denied' };
    if (s.status === 'paired' && s.result) return { ...s.result, sas: s.sas };
    return { status: s.status };
  }

  hostName() {
    const config = this.getConfig();
    return config.hostName || hostname();
  }
}
