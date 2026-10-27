/**
 * 群体服务版（A 模式）主机侧运行时。
 *
 * 与 main 的 B2 模式并存：
 *   - 主机先向部署方的 relay 自助注册（邀请码）→ 落盘 hostId / hostToken / relayDomain /
 *     mobilePort / relay token 公钥（0600，`$DSH_HOME/remote-access/group.json`）；
 *   - 主机主动连 relay 控制面（隧道），relay 边缘终止手机 TLS 后把明文流经隧道交给主机；
 *   - 主机在本机 **loopback 明文 HTTP 代理**上逐请求鉴权：
 *       Host 必须等于 `<hostId>.<relayDomain>`；
 *       cookie `__Host-dsh_session` = relay 签名的短时 token（本地用 relay 公钥离线验签）；
 *       token 里的 deviceId 必须仍是本机有效设备；
 *     通过后才交给 DshProxy 反代到 127.0.0.1 的 DSH（cookie 注入/deny list/WS 全部复用）。
 *
 * 身份来源永远只是「relay 签名 token + 本机设备表」，不看来源 IP / X-Forwarded-* / 头。
 */

import http from 'node:http';
import https from 'node:https';
import {
  CONTROL_PATH,
  GROUP_REGISTER_PATH,
  GROUP_SESSION_COOKIE,
  PAIR_PATH,
  PAIR_STATUS_PATH,
  PUSH_TOKEN_PATH,
  RESTART_PATH,
  STATUS_PATH,
  TUNNEL_BASE,
  isGroupHostId,
  parseCookieHeader,
  verifyGroupSessionToken,
} from 'dsh-remote-protocol';
import { RelayConnector } from './connector.js';
import { paths, readJson, writeJson } from './paths.js';
import { pathnameOf, readJsonBody, sendError, sendJson } from './http-utils.js';

/** group.json 版本。 */
export const GROUP_REGISTRATION_VERSION = 1;

const FQDN_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

/**
 * 规范化「服务地址」：接受 https://host[:port] 或 wss://host[:port]（POC 允许 http/ws）。
 * @param {string} raw
 * @param {{allowInsecure?: boolean}} [options]
 * @returns {string} 规范化后的基准 URL（无路径、无尾斜杠）
 */
export function normalizeGroupServiceUrl(raw, options = {}) {
  const allowInsecure = options.allowInsecure === true;
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('服务地址不是合法 URL（示例：https://relay.example.com:8443）');
  }
  const protocol = url.protocol;
  const allowed = allowInsecure ? ['https:', 'wss:', 'http:', 'ws:'] : ['https:', 'wss:'];
  if (!allowed.includes(protocol)) {
    throw new Error(`服务地址协议必须是 https:// 或 wss://${allowInsecure ? '（POC 模式也允许 http/ws）' : ''}`);
  }
  if (!url.hostname) throw new Error('服务地址缺少主机名');
  return `${url.protocol}//${url.host}`;
}

/**
 * 基准服务地址 → relay 控制面 WebSocket URL。
 * @param {string} serviceUrl
 */
export function groupControlUrl(serviceUrl) {
  const url = new URL(String(serviceUrl));
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  url.pathname = CONTROL_PATH;
  url.search = '';
  return url.href;
}

/**
 * 读取本机注册结果；不存在/损坏返回 undefined。
 * @param {string} [file]
 */
export function loadGroupRegistration(file = paths.groupRegistration()) {
  const stored = readJson(file, undefined);
  if (!stored || typeof stored !== 'object') return undefined;
  if (stored.version !== GROUP_REGISTRATION_VERSION) return undefined;
  if (!isGroupHostId(stored.hostId)) return undefined;
  if (typeof stored.hostToken !== 'string' || stored.hostToken === '') return undefined;
  if (typeof stored.relayDomain !== 'string' || !FQDN_RE.test(stored.relayDomain)) return undefined;
  if (typeof stored.tokenPublicKey !== 'string' || !stored.tokenPublicKey.includes('BEGIN PUBLIC KEY')) return undefined;
  return stored;
}

/**
 * 落盘注册结果（0600）。
 * @param {Record<string, any>} registration
 * @param {string} [file]
 */
export function saveGroupRegistration(registration, file = paths.groupRegistration()) {
  writeJson(file, { ...registration, version: GROUP_REGISTRATION_VERSION }, 0o600);
  return file;
}

/**
 * 群体版主机运行时（注册 + 隧道 + loopback 明文代理）。
 */
export class GroupHostRuntime {
  /**
   * @param {object} options
   * @param {Record<string, any>} options.config 主机配置（groupServiceUrl / groupInviteCode / groupPlainPort / groupInsecure / hostName）
   * @param {{ list: () => any[] }} [options.devices] DeviceStore（群组模式下设备记录需带 groupPublicKey）
   * @param {(req: any, res: any, device: any) => Promise<any>} options.proxy DshProxy 实例
   * @param {any} [options.audit]
   * @param {(message: string) => void} [options.log]
   * @param {string} [options.registrationFile]
   * @param {() => Array<{deviceId: string, publicKey: string}>} [options.getGroupDevices] 测试/集成注入
   * @param {() => number} [options.now]
   */
  constructor(options) {
    this.config = options.config ?? {};
    this.devices = options.devices;
    this.proxy = options.proxy;
    this.audit = options.audit;
    this.log = options.log ?? (() => {});
    this.registrationFile = options.registrationFile ?? paths.groupRegistration();
    this.getGroupDevices = options.getGroupDevices;
    /** @type {import('./pairing.js').PairingManager | undefined} 群体版配对（把 P-256 公钥写成设备记录） */
    this.pairing = options.pairing;
    this.now = options.now ?? (() => Date.now());
    this.insecure = options.config?.groupInsecure === true;
    this.registration = loadGroupRegistration(this.registrationFile);
    /** @type {http.Server | undefined} */
    this.plainServer = undefined;
    this.plainPort = 0;
    /** @type {RelayConnector | undefined} */
    this.connector = undefined;
    this.lastError = null;
    this.closed = false;
  }

  /** 当前注册信息（只读副本）。 */
  registrationInfo() {
    return this.registration ? { ...this.registration } : undefined;
  }

  /**
   * 用邀请码向服务端注册（成功后落盘 0600）。
   * @param {{serviceUrl?: string, inviteCode?: string, hostName?: string}} [input]
   */
  async register(input = {}) {
    const serviceUrl = normalizeGroupServiceUrl(input.serviceUrl ?? this.config.groupServiceUrl, { allowInsecure: this.insecure });
    const inviteCode = String(input.inviteCode ?? this.config.groupInviteCode ?? '').trim();
    if (inviteCode === '') throw new Error('邀请码未配置');
    const hostName = String(input.hostName ?? this.config.hostName ?? '').trim();
    const response = await this.#postJson(new URL(GROUP_REGISTER_PATH, serviceUrl), {
      inviteCode,
      ...(hostName ? { hostName } : {}),
    });
    if (!response || response.ok !== true) {
      const code = response?.error?.code ?? 'registration_failed';
      const message = response?.error?.message ?? '注册失败';
      throw Object.assign(new Error(`注册失败：${code}（${message}）`), { code });
    }
    const hostId = String(response.hostId ?? '');
    const hostToken = String(response.hostToken ?? '');
    const relayDomain = String(response.relayDomain ?? '');
    const mobilePort = Number(response.mobilePort);
    const tokenPublicKey = String(response.tokenPublicKey ?? '');
    if (!isGroupHostId(hostId)) throw new Error('注册响应 hostId 非法');
    if (hostToken === '') throw new Error('注册响应缺少 hostToken');
    if (!FQDN_RE.test(relayDomain)) throw new Error('注册响应 relayDomain 非法');
    if (!Number.isInteger(mobilePort) || mobilePort < 1 || mobilePort > 65535) throw new Error('注册响应 mobilePort 非法');
    if (!tokenPublicKey.includes('BEGIN PUBLIC KEY')) throw new Error('注册响应缺少 relay token 公钥（服务端版本过旧？）');

    this.registration = {
      serviceUrl,
      hostId,
      hostToken,
      relayDomain,
      mobilePort,
      tokenPublicKey,
      hostName,
      registeredAt: this.now(),
    };
    saveGroupRegistration(this.registration, this.registrationFile);
    this.audit?.append({ action: 'group-register', result: 'ok', hostId });
    this.log(`group: registered as ${hostId} on ${serviceUrl}`);
    return this.registrationInfo();
  }

  /**
   * 启动：确保已注册 → 起 loopback 明文代理 → 连 relay 隧道（连上后自动同步设备）。
   */
  async start() {
    this.closed = false;
    if (!this.registration) {
      if (String(this.config.groupInviteCode ?? '').trim() !== '') await this.register();
      else throw new Error('尚未注册服务：请填写「服务地址 + 邀请码」并完成注册');
    }
    if (!this.plainServer) {
      this.plainServer = http.createServer((req, res) => {
        this.#handlePlain(req, res).catch((error) => {
          this.log(`group: plain proxy error: ${error && error.message ? error.message : String(error)}`);
          if (!res.headersSent) this.#send(res, 500, { ok: false, error: 'internal' });
          else res.destroy();
        });
      });
      this.plainServer.on('error', (error) => this.log(`group: plain proxy server error: ${error.code ?? error.message}`));
      await new Promise((resolve, reject) => {
        this.plainServer.once('error', reject);
        this.plainServer.listen(Number(this.config.groupPlainPort) || 0, '127.0.0.1', () => {
          this.plainServer.off('error', reject);
          this.plainPort = /** @type {import('node:net').AddressInfo} */ (this.plainServer.address()).port;
          resolve(undefined);
        });
      });
      this.log(`group: plain loopback proxy on 127.0.0.1:${this.plainPort}`);
    }
    if (!this.connector) {
      this.connector = new RelayConnector({
        relayUrl: this.registration.serviceUrl,
        hostId: this.registration.hostId,
        hostToken: this.registration.hostToken,
        hostName: this.registration.hostName || this.config.hostName || this.registration.hostId,
        getLocalPort: () => this.plainPort,
        relayTlsInsecure: this.insecure,
        audit: this.audit,
        log: this.log,
        onReady: () => {
          // 隧道就绪后把本机设备表同步给 relay（token 只存 hash；这里给公钥）。
          this.syncDevices();
        },
      });
      this.connector.start();
    }
    return this.status();
  }

  /** 把本机设备列表同步给 relay（device.sync 全量覆盖）。 */
  syncDevices() {
    const devices = this.#deviceRecords();
    const sent = this.connector?.syncGroupDevices(devices) ?? false;
    if (sent) this.audit?.append({ action: 'group-device-sync', result: 'ok', count: devices.length });
    return devices.length;
  }

  /** 停止隧道与明文代理。 */
  async stop() {
    this.closed = true;
    this.connector?.stop();
    this.connector = undefined;
    const server = this.plainServer;
    this.plainServer = undefined;
    this.plainPort = 0;
    if (server) {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
  }

  status() {
    const registration = this.registration;
    return {
      registered: Boolean(registration),
      serviceUrl: registration?.serviceUrl ?? this.config.groupServiceUrl ?? '',
      hostId: registration?.hostId ?? '',
      hostName: registration?.hostName || this.config.hostName || '',
      relayDomain: registration?.relayDomain ?? '',
      mobilePort: registration?.mobilePort ?? 0,
      fqdn: registration ? `${registration.hostId}.${registration.relayDomain}` : '',
      connected: Boolean(this.connector?.isConnected()),
      plainPort: this.plainPort || 0,
      tokenPublicKeyConfigured: Boolean(registration?.tokenPublicKey),
      lastError: this.lastError ?? this.connector?.lastError ?? null,
    };
  }

  /**
   * loopback 明文代理入口：Host 校验 → token 验签 → 设备有效 → 交给 DshProxy。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async #handlePlain(req, res) {
    if (this.closed || !this.registration) {
      this.#send(res, 503, { ok: false, error: 'not_registered' });
      return;
    }
    const expectedHost = `${this.registration.hostId}.${this.registration.relayDomain}`.toLowerCase();
    const rawHost = String(req.headers.host ?? '').trim().toLowerCase();
    const hostOnly = rawHost.startsWith('[') ? rawHost : rawHost.split(':')[0];
    if (hostOnly !== expectedHost) {
      this.audit?.append({ action: 'group-proxy', result: 'misdirected-host' });
      this.#send(res, 421, { ok: false, error: 'misdirected_request' });
      return;
    }
    const pathname = pathnameOf(req.url) ?? '/';

    // —— 配对路径：无需会话 token（一次性 secret + 主机确认保护）——
    if (pathname === PAIR_PATH || pathname === `${PAIR_PATH}/`) {
      if (!this.pairing) {
        sendError(res, 503, 'pairing-unavailable', '群体版配对未就绪');
        return;
      }
      if (req.method !== 'POST') {
        sendError(res, 405, 'method-not-allowed', '仅支持 POST');
        return;
      }
      try {
        const body = await readJsonBody(req, 128 * 1024);
        const result = this.pairing.handlePairRequest({
          secret: body.secret,
          publicKey: body.publicKey,
          deviceName: body.deviceName,
          platform: body.platform,
          remoteAddress: req.socket.remoteAddress,
        });
        this.audit?.append({ action: 'pair-request', result: result.status });
        sendJson(res, 200, { ok: true, data: result });
      } catch (error) {
        if (!res.headersSent) sendError(res, error.status ?? 400, error.code ?? 'pairing-failed', error.message);
        else res.destroy();
      }
      return;
    }
    if (pathname === PAIR_STATUS_PATH) {
      if (!this.pairing) {
        sendError(res, 503, 'pairing-unavailable', '群体版配对未就绪');
        return;
      }
      if (req.method !== 'GET') {
        sendError(res, 405, 'method-not-allowed', '仅支持 GET');
        return;
      }
      const ticket = new URL(req.url, 'https://localhost').searchParams.get('ticket');
      try {
        sendJson(res, 200, { ok: true, data: this.pairing.statusFor(ticket) });
      } catch (error) {
        sendError(res, error.status ?? 404, error.code ?? 'no-such-pairing', error.message);
      }
      return;
    }

    const cookies = parseCookieHeader(req.headers.cookie);
    const token = cookies[GROUP_SESSION_COOKIE];
    const payload = token
      ? verifyGroupSessionToken({
        token,
        publicKey: this.registration.tokenPublicKey,
        hostId: this.registration.hostId,
        now: this.now(),
      })
      : undefined;
    if (!payload) {
      this.audit?.append({ action: 'group-proxy', result: 'unauthenticated' });
      this.#send(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const device = this.#deviceRecords().find((entry) => entry.deviceId === payload.deviceId);
    if (!device) {
      this.audit?.append({ action: 'group-proxy', result: 'unknown-device', deviceId: payload.deviceId });
      this.#send(res, 401, { ok: false, error: 'unknown_device' });
      return;
    }
    // —— 已鉴权的内部远程接口（群体版暂只支持 status；push/restart 后续接入）——
    if (pathname === STATUS_PATH) {
      if (req.method !== 'GET') {
        sendError(res, 405, 'method-not-allowed', '仅支持 GET');
        return;
      }
      const devices = (typeof this.devices?.list === 'function' ? this.devices.list() : []);
      sendJson(res, 200, {
        ok: true,
        data: {
          hostId: this.registration.hostId,
          hostName: this.registration.hostName || '',
          domain: `${this.registration.hostId}.${this.registration.relayDomain}`,
          auth: 'token',
          relayConnected: Boolean(this.connector?.isConnected()),
          restart: { enabled: false },
          devices: { total: devices.length, active: devices.filter((device) => !device.revokedAt).length },
        },
      });
      return;
    }
    if (pathname === PUSH_TOKEN_PATH || pathname === RESTART_PATH) {
      sendError(res, 501, 'group-feature-unavailable', '群体模式暂未接入该接口');
      return;
    }
    if (pathname.startsWith(`${TUNNEL_BASE}/`)) {
      sendError(res, 404, 'not-found', '未知远程路径');
      return;
    }

    await this.proxy.handle(req, res, { id: payload.deviceId, deviceId: payload.deviceId, name: payload.deviceId });
  }

  /** @returns {Array<{deviceId: string, publicKey: string}>} */
  #deviceRecords() {
    if (typeof this.getGroupDevices === 'function') {
      return this.getGroupDevices().map((entry) => ({ deviceId: String(entry.deviceId), publicKey: String(entry.publicKey) }));
    }
    const list = typeof this.devices?.list === 'function' ? this.devices.list() : [];
    return list
      .filter((device) => !device.revokedAt && typeof device.groupPublicKey === 'string' && device.groupPublicKey !== '')
      .map((device) => ({ deviceId: String(device.id), publicKey: String(device.groupPublicKey) }));
  }

  /** @param {import('node:http').ServerResponse} res */
  #send(res, status, body) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  /**
   * POST JSON（注册用）；POC 自签证书需显式 `groupInsecure:true`。
   * @param {URL} url
   * @param {any} body
   */
  #postJson(url, body) {
    return new Promise((resolve, reject) => {
      const client = url.protocol === 'https:' || url.protocol === 'wss:' ? https : http;
      const payload = Buffer.from(JSON.stringify(body), 'utf8');
      const request = client.request(
        {
          protocol: url.protocol === 'wss:' ? 'https:' : url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80),
          path: url.pathname,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': payload.length },
          rejectUnauthorized: !this.insecure,
        },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let json;
            try {
              json = JSON.parse(raw);
            } catch {
              json = undefined;
            }
            if (!json) {
              reject(new Error(`注册响应不是 JSON（HTTP ${response.statusCode}）`));
              return;
            }
            resolve(json);
          });
        },
      );
      request.setTimeout(15_000, () => request.destroy(new Error('注册请求超时')));
      request.on('error', reject);
      request.end(payload);
    });
  }
}
