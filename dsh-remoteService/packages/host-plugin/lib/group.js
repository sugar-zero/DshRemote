/**
 * 群体服务版（A 模式）主机侧运行时（本分支唯一模式）。
 *
 *   - 主机先向部署方的 relay 自助注册（邀请码）→ 落盘 hostId / hostToken / relayDomain /
 *     mobilePort / relay token 公钥（0600，`$DSH_HOME/remote-access/group.json`）；
 *   - 主机主动连 relay 控制面（隧道），relay 边缘终止手机 TLS 后把明文流经隧道交给主机；
 *   - 主机在本机 **loopback 明文 HTTP 代理**上逐请求鉴权：
 *       Host 必须等于 `<hostId>.<relayDomain>`；
 *       会话凭证 = `__Host-dsh_session` cookie **或** `Authorization: Bearer <token>`（二者等价；
 *       relay 边缘目前只认 cookie，App 的原生请求显式带 cookie；Bearer 作为等价兜底，
 *       便于 App JS fetch / 本地调试与后续 relay 支持）；
 *       token 由 relay 签名（本地用 relay 公钥离线验签）；
 *       token 里的 deviceId 必须仍是本机有效设备；
 *     通过后才交给 DshProxy 反代到 127.0.0.1 的 DSH（cookie 注入/deny list/WS 全部复用）。
 *
 * 身份来源永远只是「relay 签名 token + 本机设备表」，不看来源 IP / X-Forwarded-* / 头。
 */

import http from 'node:http';
import https from 'node:https';
import {
  GROUP_REFRESH_PATH,
  GROUP_REGISTER_PATH,
  GROUP_SESSION_COOKIE,
  PAIR_PATH,
  PAIR_STATUS_PATH,
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

/**
 * 远程重启主机 DSH 的内部路径（host-plugin 侧定义；protocol 0.2.0 已删除 classic 的
 * `RESTART_PATH` 常量。App 侧等价实现使用同一字面量）。
 */
export const RESTART_PATH = `${TUNNEL_BASE}/restart`;

const FQDN_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const BEARER_RE = /^Bearer\s+(\S+)$/i;

/**
 * 提取请求的群体版会话 token：`Authorization: Bearer <token>` 优先，否则 `__Host-dsh_session` cookie。
 *
 * 两者等价（同一份 relay 签名 token、同一套离线验签 + 设备在册校验）：relay 边缘与
 * 浏览器 WebView 走 cookie，App 的 JS fetch / 本地调试可用 Bearer。绝不把来源 IP /
 * 自定义头 / 查询参数当作身份。
 *
 * @param {{authorization?: string, cookie?: string}} [headers]
 * @returns {string|undefined}
 */
export function sessionTokenFromHeaders(headers = {}) {
  const match = BEARER_RE.exec(String(headers?.authorization ?? '').trim());
  if (match) return match[1];
  return parseCookieHeader(headers?.cookie)[GROUP_SESSION_COOKIE];
}

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
 * 规范化注册响应下发的控制面地址（WSS 隧道回连用）：
 * 职责分离后，注册 API 端口与 WSS 端口不同，必须用服务端下发的 controlUrl。
 * @param {string} raw
 * @param {{allowInsecure?: boolean}} [options]
 * @returns {string} 基准 URL（ws:// 或 wss:// + host:port，无路径）
 */
export function normalizeGroupControlUrl(raw, options = {}) {
  const allowInsecure = options.allowInsecure === true;
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('控制面地址不是合法 URL');
  }
  const allowed = allowInsecure ? ['wss:', 'ws:'] : ['wss:'];
  if (!allowed.includes(url.protocol)) {
    throw new Error(`控制面地址协议必须是 wss://${allowInsecure ? '（POC 模式也允许 ws://）' : ''}`);
  }
  if (!url.hostname) throw new Error('控制面地址缺少主机名');
  if (!url.port) throw new Error('控制面地址缺少端口');
  return `${url.protocol}//${url.host}`;
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
  if (stored.controlUrl !== undefined && typeof stored.controlUrl !== 'string') return undefined;
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
   * @param {string} [options.version] 插件版本（`GET /__dsh_remote/status` 展示）
   * @param {(request: {device?: object}) => Promise<{mode: string, deduped?: boolean}>|{mode: string, deduped?: boolean}} [options.restartHost]
   *   「重启主机 DSH」调度器（service.restartHost；测试注入假实现）。缺失 = 501 host-restart-unavailable。
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
    this.version = options.version ?? '';
    /** @type {((request: object) => any) | undefined} 远程重启调度（见 service.restartHost） */
    this.restartHost = typeof options.restartHost === 'function' ? options.restartHost : undefined;
    this.insecure = options.config?.groupInsecure === true;
    this.registration = loadGroupRegistration(this.registrationFile);
    /** @type {http.Server | undefined} */
    this.plainServer = undefined;
    this.plainPort = 0;
    /** 活跃的 loopback 代理连接（全部）。 */
    this.plainSockets = new Set();
    /** 活跃的 Upgrade（WebSocket）连接——组件开关变化时只断开这些，触发 App 即时刷新。 */
    this.plainUpgradeSockets = new Set();
    /** @type {RelayConnector | undefined} */
    this.connector = undefined;
    this.lastError = null;
    this.closed = false;
    /** 群体版设备 lastSeen 节流（deviceId → 上次写盘时间）。 */
    this.deviceTouchAt = new Map();
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
    const controlUrlRaw = typeof response.controlUrl === 'string' ? response.controlUrl : '';
    const controlUrl = controlUrlRaw === ''
      ? undefined
      : normalizeGroupControlUrl(controlUrlRaw, { allowInsecure: this.insecure });
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
      ...(controlUrl ? { controlUrl } : {}),
      hostName,
      registeredAt: this.now(),
    };
    saveGroupRegistration(this.registration, this.registrationFile);
    this.audit?.append({ action: 'group-register', result: 'ok', hostId });
    this.log(`group: registered as ${hostId} on ${serviceUrl}${controlUrl ? ` (control: ${controlUrl})` : ''}`);
    return this.registrationInfo();
  }

  /**
   * 刷新注册信息（hostToken 鉴权，不消耗邀请码）：
   * 服务端改了 mobilePort/controlUrl 后，主机重新拉起时自动同步。
   */
  async refreshRegistration() {
    if (!this.registration) throw new Error('尚未注册服务，无法刷新注册信息');
    const url = new URL(GROUP_REFRESH_PATH, this.registration.serviceUrl);
    const response = await this.#postJson(
      url,
      { hostId: this.registration.hostId },
      { authorization: `Bearer ${this.registration.hostToken}` },
    );
    if (!response || response.ok !== true) {
      const code = response?.error?.code ?? 'refresh_failed';
      const message = response?.error?.message ?? '刷新注册信息失败';
      throw Object.assign(new Error(`刷新注册信息失败：${code}（${message}）`), { code });
    }
    const hostId = String(response.hostId ?? '');
    const relayDomain = String(response.relayDomain ?? '');
    const mobilePort = Number(response.mobilePort);
    const tokenPublicKey = String(response.tokenPublicKey ?? '');
    const controlUrlRaw = typeof response.controlUrl === 'string' ? response.controlUrl : '';
    const controlUrl = controlUrlRaw === ''
      ? this.registration.controlUrl
      : normalizeGroupControlUrl(controlUrlRaw, { allowInsecure: this.insecure });
    if (hostId !== this.registration.hostId) throw new Error('刷新响应 hostId 与本地不一致');
    if (!FQDN_RE.test(relayDomain)) throw new Error('刷新响应 relayDomain 非法');
    if (!Number.isInteger(mobilePort) || mobilePort < 1 || mobilePort > 65535) throw new Error('刷新响应 mobilePort 非法');
    if (!tokenPublicKey.includes('BEGIN PUBLIC KEY')) throw new Error('刷新响应缺少 relay token 公钥');

    this.registration = {
      ...this.registration,
      relayDomain,
      mobilePort,
      tokenPublicKey,
      ...(controlUrl ? { controlUrl } : {}),
    };
    saveGroupRegistration(this.registration, this.registrationFile);
    this.audit?.append({ action: 'group-refresh', result: 'ok', hostId });
    this.log(`group: refreshed registration (mobilePort=${mobilePort}${controlUrl ? `, control=${controlUrl}` : ''})`);
    return this.registrationInfo();
  }

  /** 启动前尽力同步一次服务端信息（旧 relay 无 refresh 接口时忽略，继续用缓存）。 */
  async #tryRefreshRegistration() {
    try {
      await this.refreshRegistration();
    } catch (error) {
      this.log(`group: refresh registration skipped: ${error && error.message ? error.message : String(error)}`);
    }
  }

  /**
   * 启动：确保已注册 → 同步服务端下发信息 → 起 loopback 明文代理 → 连 relay 隧道。
   */
  async start() {
    this.closed = false;
    const hadRegistration = Boolean(this.registration);
    if (!this.registration) {
      if (String(this.config.groupInviteCode ?? '').trim() !== '') await this.register();
      else throw new Error('尚未注册服务：请填写「服务地址 + 邀请码」并完成注册');
    }
    // 重新拉起时同步服务端信息（mobilePort/controlUrl 等可能已变）
    if (hadRegistration) await this.#tryRefreshRegistration();
    await this.startPlainProxy();
    if (!this.connector) {
      this.connector = new RelayConnector({
        // 职责分离：注册 API 与 WSS 控制面不同端口；优先用注册响应下发的 controlUrl。
        relayUrl: this.registration.controlUrl ?? this.registration.serviceUrl,
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

  /**
   * 启动本机 loopback 明文代理（幂等；只 bind 127.0.0.1，不开放任何入站端口）。
   *
   * 单独拆出便于测试直接驱动 `/__dsh_remote/*` 路由（不需要注册/隧道）；
   * 生产路径一律由 `start()` 调用。
   * @returns {Promise<number>} 实际监听端口
   */
  async startPlainProxy() {
    if (this.plainServer) return this.plainPort;
    this.plainServer = http.createServer((req, res) => {
      this.#handlePlain(req, res).catch((error) => {
        this.log(`group: plain proxy error: ${error && error.message ? error.message : String(error)}`);
        if (!res.headersSent) this.#send(res, 500, { ok: false, error: 'internal' });
        else res.destroy();
      });
    });
    // DSH Web 的实时通道（/api/remote.mux 等）是 WebSocket 升级请求；http.Server 默认
    // 把 upgrade 交给 'upgrade' 事件，没有监听器会直接销毁 socket，页面表现为「暂无会话 /
    // 重新连接中」。这里与 #handlePlain 同一套鉴权后交给 DshProxy.handleUpgrade。
    this.plainServer.on('upgrade', (req, socket, head) => {
      this.plainUpgradeSockets.add(socket);
      socket.once('close', () => this.plainUpgradeSockets.delete(socket));
      this.#handlePlainUpgrade(req, socket, head).catch((error) => {
        this.log(`group: plain upgrade proxy error: ${error && error.message ? error.message : String(error)}`);
        if (!socket.destroyed) socket.destroy();
      });
    });
    this.plainServer.on('error', (error) => this.log(`group: plain proxy server error: ${error.code ?? error.message}`));
    this.plainServer.on('connection', (socket) => {
      this.plainSockets.add(socket);
      socket.once('close', () => this.plainSockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
      this.plainServer.once('error', reject);
      this.plainServer.listen(Number(this.config.groupPlainPort) || 0, '127.0.0.1', () => {
        this.plainServer.off('error', reject);
        this.plainPort = /** @type {import('node:net').AddressInfo} */ (this.plainServer.address()).port;
        resolve(undefined);
      });
    });
    this.log(`group: plain loopback proxy on 127.0.0.1:${this.plainPort}`);
    return this.plainPort;
  }

  /**
   * 重试隧道连接（不重新注册、不清本地注册信息）。
   * 用于修好 nginx/证书/网络后立即重连，不必「重置注册」重新消耗邀请码。
   */
  async reconnect() {
    if (!this.registration) throw new Error('尚未注册服务，无法重试连接');
    if (this.connector) {
      try { this.connector.stop(); } catch { /* ignore */ }
      this.connector = undefined;
    }
    this.audit?.append({ action: 'group-reconnect', result: 'ok' });
    return this.start();
  }

  /** 把本机设备列表同步给 relay（device.sync 全量覆盖）。 */
  syncDevices() {
    const devices = this.#deviceRecords();
    const sent = this.connector?.syncGroupDevices(devices) ?? false;
    if (sent) this.audit?.append({ action: 'group-device-sync', result: 'ok', count: devices.length });
    return devices.length;
  }

  /** 停止隧道与明文代理。 */
  /**
   * 主动断开当前 loopback 代理的 Upgrade（WebSocket）连接。
   *
   * 用途：配置保存后（如切换「允许手机重启主机」组件）让 App 的 WebView WS 立刻断开，
   * App 的 ws-close 自动恢复会重载页面并重新拉 `/__dsh_remote/status`，从而像单机版一样
   * 「主机保存 → App 立刻刷新顶栏 ⏻」，而不需要退出主机或等轮询。
   *
   * 只断 WS/Upgrade 连接：relay↔主机隧道与普通 HTTP keep-alive 不受影响，重连后继续用同一
   * plain 端口。
   * @returns {number} 断开的连接数
   */
  closeUpgradedConnections() {
    let count = 0;
    for (const socket of [...this.plainUpgradeSockets]) {
      count += 1;
      try { socket.destroy(); } catch { /* ignore */ }
    }
    this.plainUpgradeSockets.clear();
    return count;
  }

  async stop() {
    this.closed = true;
    this.connector?.stop();
    this.connector = undefined;
    const server = this.plainServer;
    this.plainServer = undefined;
    this.plainPort = 0;
    if (server) {
      await new Promise((resolve) => {
        server.close(() => resolve(undefined));
        // 配置保存会重建运行时（stop→start）：把残留的 keep-alive / 活跃连接一并断开，
        // 否则 close() 可能一直等到连接自然结束，表现为「保存很慢/超时失败」。
        try { server.closeAllConnections?.(); } catch { /* ignore */ }
      });
    }
    this.plainSockets.clear();
    this.plainUpgradeSockets.clear();
  }

  status() {
    const registration = this.registration;
    return {
      registered: Boolean(registration),
      serviceUrl: registration?.serviceUrl ?? this.config.groupServiceUrl ?? '',
      controlUrl: registration?.controlUrl ?? '',
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
   * loopback 明文代理的 WebSocket 升级入口（DSH UI 实时通道）。鉴权逻辑与 #handlePlain 一致，
   * 通过后交给 DshProxy.handleUpgrade（含 deny list / DSH cookie 注入 / 心跳代答）。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:net').Socket} socket
   * @param {Buffer} head
   */
  async #handlePlainUpgrade(req, socket, head) {
    if (this.closed || !this.registration) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      return;
    }
    const expectedHost = `${this.registration.hostId}.${this.registration.relayDomain}`.toLowerCase();
    const rawHost = String(req.headers.host ?? '').trim().toLowerCase();
    const hostOnly = rawHost.startsWith('[') ? rawHost : rawHost.split(':')[0];
    if (hostOnly !== expectedHost) {
      this.audit?.append({ action: 'group-ws-proxy', result: 'misdirected-host' });
      socket.end('HTTP/1.1 421 Misdirected Request\r\n\r\n');
      return;
    }
    // cookie（WebView）与 `Authorization: Bearer`（App native fetch）等价
    const token = sessionTokenFromHeaders(req.headers);
    const payload = token
      ? verifyGroupSessionToken({
        token,
        publicKey: this.registration.tokenPublicKey,
        hostId: this.registration.hostId,
        now: this.now(),
      })
      : undefined;
    if (!payload) {
      this.audit?.append({ action: 'group-ws-proxy', result: 'unauthenticated' });
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    const device = this.#deviceRecords().find((entry) => entry.deviceId === payload.deviceId);
    if (!device) {
      this.audit?.append({ action: 'group-ws-proxy', result: 'unknown-device', deviceId: payload.deviceId });
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    this.#touchDevice(payload.deviceId);
    await this.proxy.handleUpgrade(req, socket, head, {
      id: payload.deviceId,
      deviceId: payload.deviceId,
      name: payload.deviceId,
    });
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

    // cookie（WebView）与 `Authorization: Bearer`（App native fetch）等价
    const token = sessionTokenFromHeaders(req.headers);
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
    this.#touchDevice(payload.deviceId);
    // —— 已鉴权的内部远程接口（群体版提供 status + restart）——
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
          version: this.version || null,
          // 「重启主机」组件：关闭时 App 不显示顶栏 ⏻，重启接口也会拒绝（501）
          restart: { enabled: this.config?.restartHostEnabled === true },
          devices: { total: devices.length, active: devices.filter((device) => !device.revokedAt).length },
        },
      });
      return;
    }
    // —— 远程重启主机 DSH（App 顶栏 ⏻；成功返回 202，helper 约 1s 后重启）——
    if (pathname === RESTART_PATH) {
      if (req.method !== 'POST') {
        sendError(res, 405, 'method-not-allowed', '仅支持 POST');
        return;
      }
      const deviceId = payload.deviceId;
      if (this.config?.restartHostEnabled !== true) {
        this.audit?.append({ deviceId, action: 'host-restart', result: 'failed', hash: 'disabled' });
        sendError(res, 501, 'host-restart-disabled', '远程重启已在「设置 → 远程访问 → 组件」中关闭');
        return;
      }
      if (typeof this.restartHost !== 'function') {
        this.audit?.append({ deviceId, action: 'host-restart', result: 'failed', hash: 'not-enabled' });
        sendError(res, 501, 'host-restart-unavailable', '当前主机未启用远程重启（插件版本或运行环境不支持）');
        return;
      }
      try {
        // 只做调度（detached helper 延迟 ~1s 才动手），先让 202 返回手机。
        const result = await this.restartHost({ device: { id: deviceId, deviceId } });
        const mode = String(result?.mode ?? 'unknown');
        this.audit?.append({
          deviceId,
          action: 'host-restart',
          result: 'accepted',
          hash: result?.deduped ? 'deduped' : mode,
        });
        sendJson(res, 202, { ok: true, data: { restarting: true, mode } });
      } catch (error) {
        this.audit?.append({
          deviceId,
          action: 'host-restart',
          result: 'failed',
          hash: error?.code ?? 'restart-failed',
        });
        sendError(res, error.status ?? 500, error.code ?? 'host-restart-failed', error.message ?? '安排主机重启失败');
      }
      return;
    }
    if (pathname.startsWith(`${TUNNEL_BASE}/`)) {
      sendError(res, 404, 'not-found', '未知远程路径');
      return;
    }

    await this.proxy.handle(req, res, { id: payload.deviceId, deviceId: payload.deviceId, name: payload.deviceId });
  }

  /** @returns {Array<{deviceId: string, publicKey: string}>} */
  /** 群体版没有 mTLS 握手，鉴权成功时按设备 ID 更新 lastSeen（30s 节流）。 */
  #touchDevice(deviceId) {
    const now = this.now();
    const last = this.deviceTouchAt.get(deviceId) ?? 0;
    if (now - last < 30_000) return;
    this.deviceTouchAt.set(deviceId, now);
    try {
      if (typeof this.devices?.touchById === 'function') this.devices.touchById(deviceId);
    } catch {
      /* lastSeen 更新失败不影响代理 */
    }
  }

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
  #postJson(url, body, extraHeaders = {}) {
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
          headers: {
            'content-type': 'application/json',
            'content-length': payload.length,
            ...extraHeaders,
          },
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
