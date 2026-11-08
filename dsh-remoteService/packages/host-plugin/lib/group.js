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
  PUSH_CHANNELS,
  PUSH_PROVIDER,
  PUSH_SEND_PATH,
  PUSH_TOKEN_PATH,
  STATUS_PATH,
  TUNNEL_BASE,
  isGroupHostId,
  isPushEnvironment,
  isValidApnsDeviceToken,
  isValidBundleId,
  normalizePushChannel,
  parseCookieHeader,
  verifyGroupSessionToken,
} from 'dsh-remote-protocol';
import { RelayConnector } from './connector.js';
import { paths, readJson, writeJson } from './paths.js';
import { REMOTE_STREAM_MUX_PATH } from './proxy.js';
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
/** R2：hubEndpoint 上限（字符）与 credential 上限（字符），见契约 §6.1。 */
const PUSH_HUB_ENDPOINT_MAX_CHARS = 2048;
const PUSH_CREDENTIAL_MAX_CHARS = 4096;
/** R2：credential 只校验「三段式 JWT 形态」，签名/claims 由官方 hub 校验（主机没有 hub 公钥）。 */
const PUSH_CREDENTIAL_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * R2：规范化官方 hub 基址（契约 §6.1）。
 * 只接受 **https** URL，≤2048 字符，无 userinfo / query / hash；去掉末尾斜杠便于拼 `/v1/push`。
 * @param {unknown} raw
 * @returns {string} 规范化后的基址
 * @throws {Error & {code: string}} 非法时抛 `invalid-hub-endpoint`
 */
export function normalizePushHubEndpoint(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const invalid = (message) => Object.assign(new Error(message), { code: 'invalid-hub-endpoint' });
  if (text === '') throw invalid('官方推送需要 hubEndpoint（https 基址）');
  if (text.length > PUSH_HUB_ENDPOINT_MAX_CHARS) throw invalid(`hubEndpoint 过长（≤${PUSH_HUB_ENDPOINT_MAX_CHARS} 字符）`);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw invalid('hubEndpoint 不是合法 URL');
  }
  if (url.protocol !== 'https:') throw invalid('hubEndpoint 必须是 https://');
  if (!url.hostname) throw invalid('hubEndpoint 缺少主机名');
  if (url.username !== '' || url.password !== '') throw invalid('hubEndpoint 不能包含 userinfo');
  if (url.search !== '') throw invalid('hubEndpoint 不能包含查询参数');
  if (url.hash !== '') throw invalid('hubEndpoint 不能包含 hash');
  const normalized = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  if (normalized.length > PUSH_HUB_ENDPOINT_MAX_CHARS) throw invalid(`hubEndpoint 过长（≤${PUSH_HUB_ENDPOINT_MAX_CHARS} 字符）`);
  return normalized;
}

/**
 * R2：credential 形态校验（三段式 JWT 字符串，≤4096 字符）。
 * 主机只透传给 hub，**不验签、不解析 claims**（hub 才持有签名公钥）。
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isPushCredentialLike(raw) {
  return typeof raw === 'string'
    && raw.length > 0
    && raw.length <= PUSH_CREDENTIAL_MAX_CHARS
    && PUSH_CREDENTIAL_RE.test(raw);
}

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
   * @param {typeof fetch} [options.fetchImpl] 官方 hub HTTP 客户端（R2；测试注入假 fetch，默认 globalThis.fetch）
   * @param {number} [options.hubTimeoutMs] 官方 hub 单设备推送超时（默认 10000ms；测试可调小）
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
    /** R2：官方 hub 直连（契约 §6.2；主机零 Apple 凭据，只透传 App 上报的 credential 与 token）。 */
    this.fetchImpl = typeof options.fetchImpl === 'function'
      ? options.fetchImpl
      : ((...args) => globalThis.fetch(...args));
    this.hubTimeoutMs = Number(options.hubTimeoutMs) > 0 ? Number(options.hubTimeoutMs) : 10_000;
    this.insecure = options.config?.groupInsecure === true;
    this.registration = loadGroupRegistration(this.registrationFile);
    /** @type {http.Server | undefined} */
    this.plainServer = undefined;
    this.plainPort = 0;
    /** 活跃的 loopback 代理连接（全部）。 */
    this.plainSockets = new Set();
    /**
     * 活跃的 Upgrade（WebSocket）连接：socket → 请求 pathname。
     *
     * 组件开关变化时只断开 DSH **主实时通道**（`/api/remote.mux`），其它插件/子页面 WS 保留。
     * 一次保存同时断多条 WS 会让 App 在同一瞬间收到多个 `dsh-ws-close`，把它的自动恢复
     * 预算（60s 内 2 次）一次耗尽，表现为「自动重连未恢复，请点击刷新重试」。
     * @type {Map<import('node:net').Socket, string>}
     */
    this.plainUpgradeConnections = new Map();
    /** @type {RelayConnector | undefined} */
    this.connector = undefined;
    this.lastError = null;
    this.closed = false;
    /** 群体版设备 lastSeen 节流（deviceId → 上次写盘时间）。 */
    this.deviceTouchAt = new Map();
    /**
     * R2 推送设备（deviceId → 记录）。**只存内存、不落盘**；status/日志/审计不暴露 token 与 credential。
     * - self（部署方自签 App）：token 经 connector 上报 relay，推送仍走 relay；
     * - official（官方 App）：token + credential 由 App 向官方 hub 换取后上报，推送由主机直连 hub。
     * @type {Map<string, {deviceId: string, token: string, environment: string, channel: string,
     *   bundleId?: string, hubEndpoint?: string, credential?: string, registeredAt: number}>}
     */
    this.pushDevices = new Map();
    /** 可读的推送错误（按通道；不含 token/credential）。 */
    this.pushSelfLastError = '';
    this.pushOfficialLastError = '';
    /** 最近登记的官方 hub 基址（status 展示；无 official 设备时为 null）。 */
    this.pushOfficialHub = '';
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
        // 推送：relay 的 push.registered / push.result 回执交给本运行时更新状态/记录。
        onPushRegistered: (msg) => this.#onPushRegistered(msg),
        onPushResult: (msg) => this.#onPushResult(msg),
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
      // 记录 Upgrade 的请求路径：保存「组件」开关时只断主实时通道（/api/remote.mux），
      // 其它 WebSocket（插件面板等）保持连接，避免 App 一次收到多条 ws-close。
      this.plainUpgradeConnections.set(socket, pathnameOf(req.url) ?? '');
      const forget = () => this.plainUpgradeConnections.delete(socket);
      socket.once('close', forget);
      // 已升级的 socket 是 half-open：对端 FIN 只触发 'end'，不会自动 close。
      // 主动 destroy，避免跟踪表残留“假活”连接（stop()/重建运行时还会多等一条）。
      socket.once('end', () => {
        try { socket.destroy(); } catch { /* ignore */ }
        forget();
      });
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
    // 设备被撤销/删除后，本机推送设备记录（含 official 的 token/credential）也一并清掉。
    const known = new Set(devices.map((entry) => entry.deviceId));
    for (const deviceId of [...this.pushDevices.keys()]) {
      if (!known.has(deviceId)) this.pushDevices.delete(deviceId);
    }
    const sent = this.connector?.syncGroupDevices(devices) ?? false;
    if (sent) this.audit?.append({ action: 'group-device-sync', result: 'ok', count: devices.length });
    return devices.length;
  }

  /** R2：当前已登记推送设备数（按通道；供 notifier 判断是否值得触发）。 */
  pushTargets() {
    let self = 0;
    let official = 0;
    for (const device of this.pushDevices.values()) {
      if (device.channel === PUSH_CHANNELS.OFFICIAL) official += 1;
      else self += 1;
    }
    return { self, official };
  }

  /**
   * R2 推送状态（契约 §6.3：本机 `/api/remote-access/status` 与远程 `/__dsh_remote/status` 共用）。
   * **不暴露 token/credential**，只给开关、两通道设备数/可读错误、官方 hub 基址与自动分流模式。
   */
  pushStatus() {
    const targets = this.pushTargets();
    const mode = targets.self > 0 && targets.official > 0
      ? 'mixed'
      : (targets.self > 0 ? PUSH_CHANNELS.SELF : (targets.official > 0 ? PUSH_CHANNELS.OFFICIAL : ''));
    return {
      enabled: this.config?.pushEnabled !== false,
      detail: this.config?.pushDetail === true,
      self: {
        devices: targets.self,
        lastError: this.pushSelfLastError || null,
      },
      official: {
        devices: targets.official,
        lastError: this.pushOfficialLastError || null,
        hub: this.pushOfficialHub || null,
      },
      mode,
    };
  }

  /**
   * R2 推送发送分流（契约 §6.2）：触发入口不变，发送阶段按设备 channel 分派。
   *
   * - **self 设备**：一条 `push.send` 意图交给 relay（relay 按已登记 token 发送），行为与 R1 一致；
   * - **official 设备**：主机逐设备 `POST {hubEndpoint}/v1/push`（Bearer credential，10s 超时、不重试）；
   * - 没有 self 设备时**不向 relay 发**（避免空转/额度）；两类并存时都发；
   * - hub 返回 `pruned:[token]` → 删除对应设备记录（App 下次进入主机会重新登记）。
   *
   * 不抛异常：失败写入对应通道的 `lastError`，返回投递摘要供 notifier 记日志/审计。
   * @param {{id: string, kind: string, title?: string, body?: string, sessionId?: string}} intent
   * @returns {Promise<{self: {devices: number, sent: number}, official: {devices: number, sent: number, failed: number, pruned: number}}>}
   */
  async deliverPush(intent) {
    /** @type {{self: {devices: number, sent: number}, official: {devices: number, sent: number, failed: number, pruned: number}}} */
    const summary = {
      self: { devices: 0, sent: 0 },
      official: { devices: 0, sent: 0, failed: 0, pruned: 0 },
    };
    const devices = [...this.pushDevices.entries()].map(([deviceId, record]) => ({ deviceId, ...record }));
    const selfDevices = devices.filter((device) => device.channel !== PUSH_CHANNELS.OFFICIAL);
    const officialDevices = devices.filter((device) => device.channel === PUSH_CHANNELS.OFFICIAL);
    summary.self.devices = selfDevices.length;
    summary.official.devices = officialDevices.length;

    // —— self：一条意图交给 relay（relay 侧按 hostId 给所有已登记 token 发）——
    if (selfDevices.length > 0) {
      const connector = this.connector;
      const connected = Boolean(connector && typeof connector.sendPushIntent === 'function' && connector.isConnected?.() === true);
      if (!connected) {
        this.pushSelfLastError = 'relay 控制连接暂不可用，self 设备本次未推送';
        this.log('group push: self skipped（relay 未连接）');
      } else {
        try {
          const sent = connector.sendPushIntent(intent) !== false;
          summary.self.sent = sent ? 1 : 0;
          this.pushSelfLastError = sent ? '' : 'relay 控制连接暂不可用，self 设备本次未推送';
          if (!sent) this.log('group push: self skipped（relay 发送失败）');
        } catch (error) {
          summary.self.sent = 0;
          this.pushSelfLastError = `relay 发送失败：${error?.message ?? error}`;
          this.log(`group push: self failed: ${error?.message ?? error}`);
        }
      }
    }

    // —— official：逐设备直连官方 hub（不依赖 relay；失败不回退 relay，不重试）——
    if (officialDevices.length > 0) {
      const results = await Promise.all(officialDevices.map((device) => this.#pushToHub(device, intent)));
      /** @type {Set<string>} */
      const prunedTokens = new Set();
      let failed = 0;
      let firstError = '';
      for (const result of results) {
        if (result.ok === true) {
          summary.official.sent += 1;
          for (const token of result.pruned ?? []) prunedTokens.add(token);
        } else {
          failed += 1;
          if (firstError === '' && result.code) firstError = String(result.code);
        }
      }
      summary.official.failed = failed;
      // hub 返回 pruned:[token] → 删除对应设备记录（按 token 匹配；同 token 只属于一台设备）。
      if (prunedTokens.size > 0) {
        for (const [deviceId, record] of [...this.pushDevices]) {
          if (record.channel === PUSH_CHANNELS.OFFICIAL && prunedTokens.has(record.token)) {
            this.pushDevices.delete(deviceId);
            summary.official.pruned += 1;
          }
        }
      }
      if (failed > 0) {
        this.pushOfficialLastError = `官方推送失败：${firstError || 'unknown'}（不重试）`;
      } else if (summary.official.pruned > 0) {
        this.pushOfficialLastError = `${summary.official.pruned} 台设备的官方推送 token 已失效，已移除（App 重新进入主机后会重新登记）`;
      } else {
        this.pushOfficialLastError = '';
      }
      this.log(
        `group push: official devices=${summary.official.devices} sent=${summary.official.sent}`
        + ` failed=${summary.official.failed} pruned=${summary.official.pruned}`,
      );
    }

    return summary;
  }

  /**
   * R2：单设备直连官方 hub（契约 §6.2/§4.3）。
   * `POST {hubEndpoint}/v1/push`，`Authorization: Bearer <credential>`，body 只 `{kind, host, token}`
   * （不含 title/body/sessionId，官方 hub 固定通用文案）；超时 10s、**不重试**。
   * 日志/状态/审计不出现 token/credential。
   * @param {{deviceId: string, token: string, hubEndpoint: string, credential: string}} device
   * @param {{kind?: string}} intent
   * @returns {Promise<{ok: true, pruned: string[]} | {ok: false, code: string}>}
   */
  async #pushToHub(device, intent) {
    const url = `${device.hubEndpoint}${PUSH_SEND_PATH}`;
    /** @type {Record<string, string>} */
    const body = { kind: String(intent?.kind ?? '') };
    const host = this.registration ? `${this.registration.hostId}.${this.registration.relayDomain}` : '';
    if (host !== '') body.host = host;
    body.token = device.token;
    // 用户开启「详细推送内容」才把会话标题/摘要发给 hub；默认只发通用文案。
    if (this.config?.pushDetail === true
      && typeof intent?.title === 'string' && intent.title !== ''
      && typeof intent?.body === 'string' && intent.body !== '') {
      body.title = intent.title;
      body.body = intent.body;
    }
    // sessionId 只用于点通知跳会话；与详细内容开关无关，官方通道也带（opaque，不写日志）。
    if (typeof intent?.sessionId === 'string' && intent.sessionId !== '') {
      body.sessionId = intent.sessionId.slice(0, 128);
    }
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timeout: true }), this.hubTimeoutMs);
      timer.unref?.();
    });
    try {
      const request = Promise.resolve()
        .then(() => this.fetchImpl(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${device.credential}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }))
        .then((response) => ({ response }))
        .catch((error) => ({ error }));
      // 显式 race：即使测试/运行环境的 fetch 不理会 AbortSignal，也不会超过 hubTimeoutMs。
      const outcome = await Promise.race([request, timeout]);
      if (outcome.timeout === true) {
        try { controller.abort(); } catch { /* ignore */ }
        this.log(`group push: official timeout（device=${device.deviceId} hub=${device.hubEndpoint}）`);
        return { ok: false, code: 'timeout' };
      }
      if (outcome.error) {
        this.log(`group push: official failed（device=${device.deviceId} hub=${device.hubEndpoint}）: ${outcome.error?.message ?? outcome.error}`);
        return { ok: false, code: 'network' };
      }
      const response = outcome.response;
      if (!response || typeof response !== 'object') {
        this.log(`group push: official failed（device=${device.deviceId}）: 响应非法`);
        return { ok: false, code: 'invalid-response' };
      }
      let json;
      try { json = await response.json(); } catch { json = undefined; }
      if (response.ok !== true || !json || json.ok !== true) {
        const code = String(json?.error?.code ?? json?.code ?? `http_${response.status ?? 'unknown'}`);
        this.log(`group push: official rejected（device=${device.deviceId} hub=${device.hubEndpoint} status=${response.status ?? '?'} code=${code}）`);
        return { ok: false, code };
      }
      const pruned = Array.isArray(json.pruned) ? json.pruned.map((entry) => String(entry)) : [];
      return { ok: true, pruned };
    } catch (error) {
      this.log(`group push: official failed（device=${device.deviceId}）: ${error?.message ?? error}`);
      return { ok: false, code: 'internal' };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * relay `push.registered` 回执（R2：只影响 self 通道状态；official 不经过 relay）。
   * @param {{ok?: boolean, deviceId?: string, mode?: string, enabled?: boolean, code?: string, message?: string}} msg
   */
  #onPushRegistered(msg) {
    const deviceId = String(msg?.deviceId ?? '');
    if (msg?.ok === true) {
      this.pushSelfLastError = '';
      this.log(`group push: relay registered device=${deviceId} mode=${String(msg.mode ?? '-')} enabled=${String(msg.enabled === true)}`);
      return;
    }
    const code = String(msg?.code ?? 'internal');
    this.pushSelfLastError = code === 'push_disabled'
      ? '服务器未开启推送（relay 的 group.push.enabled=false），self 设备本次未推送'
      : `推送登记被拒绝：${code}${msg?.message ? `（${msg.message}）` : ''}`;
    const record = this.pushDevices.get(deviceId);
    if (record && record.channel !== PUSH_CHANNELS.OFFICIAL) this.pushDevices.delete(deviceId);
    this.log(`group push: relay register failed device=${deviceId} code=${code}`);
  }

  /**
   * relay `push.result` 回执（R2：只影响 self 通道；host 不重试，只记日志/审计并更新可读错误）。
   * `pruned` 是 APNs 410/Unregistered 的 self deviceId（relay 已删 token，App 下次进入会重登记）。
   * @param {{id?: string, ok?: boolean, code?: string, delivered?: number, failed?: number, pruned?: unknown[], skipped?: string}} msg
   */
  #onPushResult(msg) {
    const pruned = Array.isArray(msg?.pruned) ? msg.pruned.map((entry) => String(entry)) : [];
    for (const deviceId of pruned) {
      const record = this.pushDevices.get(deviceId);
      if (record && record.channel !== PUSH_CHANNELS.OFFICIAL) this.pushDevices.delete(deviceId);
    }
    if (msg?.ok === true) {
      if (pruned.length > 0) this.pushSelfLastError = `${pruned.length} 台 self 设备的推送 token 已失效（App 下次进入主机时会重新登记）`;
      this.log(`group push: relay result id=${String(msg?.id ?? '')} delivered=${Number(msg?.delivered ?? 0)} failed=${Number(msg?.failed ?? 0)} skipped=${String(msg?.skipped ?? '')} pruned=${pruned.length}`);
      return;
    }
    const code = String(msg?.code ?? 'internal');
    this.pushSelfLastError = `推送发送失败：${code}`;
    this.log(`group push: relay result id=${String(msg?.id ?? '')} failed code=${code}（不重试）`);
  }

  /**
   * 主动断开 loopback 代理上的 Upgrade（WebSocket）连接；**默认只断 DSH 主实时通道**
   * （`/api/remote.mux`）。
   *
   * 用途：配置保存后（如切换「允许手机重启主机」组件）让 App 的 WebView 主 WS 断开，
   * App 的 ws-close 自动恢复会重载页面并重新拉 `/__dsh_remote/status`，从而像单机版一样
   * 「主机保存 → App 立刻刷新顶栏 ⏻」，又不需要重建隧道。
   *
   * 为什么只断一条：App 会为每个 WebSocket 上报 `dsh-ws-close`，一次保存同时断开多条
   * （DSH mux + 各插件面板 WS）会在同一瞬间耗尽它的自动恢复预算（60s 内 2 次），
   * 表现为「自动重连未恢复，请点击刷新重试」。普通 HTTP keep-alive 与 relay↔主机隧道
   * 始终不受影响。
   *
   * @param {{path?: string}} [options] `path` 默认 `/api/remote.mux`；传其它路径可定向断开
   * @returns {number} 实际断开的连接数
   */
  closeUpgradedConnections({ path = REMOTE_STREAM_MUX_PATH } = {}) {
    const wanted = String(path ?? '').trim();
    if (wanted === '') return 0;
    let count = 0;
    for (const [socket, pathname] of [...this.plainUpgradeConnections]) {
      if (pathname !== wanted) continue;
      this.plainUpgradeConnections.delete(socket);
      count += 1;
      try { socket.destroy(); } catch { /* ignore */ }
    }
    return count;
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
      // 主动销毁本代理上仍存活的连接（含已 Upgrade 的 WebSocket）：
      // Node 的 server.close() 不跟踪已升级的 socket，closeAllConnections() 也覆盖不到它们；
      // 不主动断会一直等连接自然结束（配置保存重建运行时 → 卡住/超时）。
      for (const socket of [...this.plainSockets]) {
        try { socket.destroy(); } catch { /* ignore */ }
      }
      for (const socket of [...this.plainUpgradeConnections.keys()]) {
        try { socket.destroy(); } catch { /* ignore */ }
      }
      await new Promise((resolve) => {
        server.close(() => resolve(undefined));
        // 普通 HTTP keep-alive 同样一并断开，避免 close() 等连接自然结束。
        try { server.closeAllConnections?.(); } catch { /* ignore */ }
      });
    }
    this.plainSockets.clear();
    this.plainUpgradeConnections.clear();
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
      // 推送状态（契约 §6：不暴露 token 明文）
      push: this.pushStatus(),
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
    // —— 已鉴权的内部远程接口（群体版提供 status + push-token + restart）——
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
          // 推送状态（契约 §6）：App 设置页展示；永不包含 token 明文
          push: this.pushStatus(),
          devices: { total: devices.length, active: devices.filter((device) => !device.revokedAt).length },
        },
      });
      return;
    }
    // —— App 登记 APNs device token（R2：self 经 relay / official 直连官方 hub）——
    if (pathname === PUSH_TOKEN_PATH) {
      if (req.method !== 'POST') {
        sendError(res, 405, 'method-not-allowed', '仅支持 POST');
        return;
      }
      const deviceId = payload.deviceId;
      let body;
      try {
        body = await readJsonBody(req, 32 * 1024);
      } catch (error) {
        this.audit?.append({ deviceId, action: 'push-token', result: 'failed', hash: 'invalid-body' });
        sendError(res, error.status ?? 400, error.code ?? 'invalid-json', error.message ?? '请求体不是合法 JSON');
        return;
      }
      const fail = (status, code, message, hash) => {
        this.audit?.append({ deviceId, action: 'push-token', result: 'failed', hash: hash ?? code });
        sendError(res, status, code, message);
      };

      // —— 原有字段（provider/token/environment，与 R1 一致）——
      const provider = body?.provider;
      const token = body?.token;
      const environment = body?.environment;
      if (provider !== PUSH_PROVIDER.APNS || !isValidApnsDeviceToken(token) || !isPushEnvironment(environment)) {
        fail(
          400,
          'invalid-push-token',
          '推送参数非法：token 必须是 64 位小写十六进制，provider 必须是 apns，environment 必须是 development/production',
        );
        return;
      }
      // —— R2：channel 缺省 self（旧 App 兼容）——
      const channel = normalizePushChannel(body?.channel);
      if (channel === '') {
        fail(400, 'invalid-channel', 'channel 必须是 self 或 official');
        return;
      }
      const hubBundleId = typeof body?.bundleId === 'string' ? body.bundleId : '';
      const hubEndpointRaw = typeof body?.hubEndpoint === 'string' ? body.hubEndpoint : '';
      const credential = typeof body?.credential === 'string' ? body.credential : '';
      const hasHubFields = hubBundleId !== '' || hubEndpointRaw !== '' || credential !== '';

      if (channel === PUSH_CHANNELS.SELF) {
        // 旧 App 只发 provider/token/environment；self 不允许夹带 hub 字段（防误配/防把 credential 留在主机）。
        if (hasHubFields) {
          fail(400, 'invalid-body', 'self 通道不接受 bundleId/hubEndpoint/credential');
          return;
        }
        const connector = this.connector;
        if (!connector || typeof connector.registerPushToken !== 'function' || !connector.isConnected()) {
          this.pushSelfLastError = '主机与 relay 的控制连接暂不可用，App 稍后可重试登记';
          fail(503, 'push-not-connected', '主机与 relay 的控制连接暂不可用，请稍后重试', 'push-not-connected');
          return;
        }
        let registered;
        try {
          registered = await connector.registerPushToken({ deviceId, provider, token, environment });
        } catch (error) {
          registered = { ok: false, code: 'internal', message: error?.message };
        }
        if (registered?.ok === true) {
          // self：token 由 connector 内存缓存（重连补报 relay）；本机只记录用于 status 计数。
          this.pushDevices.set(deviceId, {
            deviceId,
            token,
            environment,
            channel: PUSH_CHANNELS.SELF,
            registeredAt: this.now(),
          });
          this.pushSelfLastError = '';
          this.audit?.append({ deviceId, action: 'push-token', result: 'ok', hash: 'self' });
          // mode 与 channel 同时返回：R2 App 用 channel，旧 App（0.1.8）用 mode 展示。
          sendJson(res, 200, { ok: true, data: { registered: true, channel: PUSH_CHANNELS.SELF, mode: PUSH_CHANNELS.SELF } });
          return;
        }
        const code = String(registered?.code ?? 'internal');
        if (code === 'not_connected') {
          this.pushSelfLastError = '主机与 relay 的控制连接暂不可用';
          fail(503, 'push-not-connected', '主机与 relay 的控制连接暂不可用，请稍后重试', code);
          return;
        }
        if (code === 'timeout') {
          // 契约外但明确：5s 内没等到 push.registered；App 按可重试处理（Lead 约定）。
          this.pushSelfLastError = '登记推送 token 超时：relay 未在 5s 内回应，App 可稍后重试';
          fail(503, 'push-timeout', '登记推送 token 超时，请稍后重试', code);
          return;
        }
        if (code === 'push_disabled') {
          this.pushSelfLastError = '服务器未开启推送（relay 的 group.push.enabled=false）';
          fail(403, 'push-disabled', 'relay 未开启推送', code);
          return;
        }
        if (code === 'invalid_push_token' || code === 'invalid_provider' || code === 'invalid_environment') {
          fail(400, 'invalid-push-token', `relay 判定推送参数非法（${code}）`, code);
          return;
        }
        this.pushSelfLastError = `relay 拒绝登记推送 token：${code}`;
        fail(502, 'push-rejected', `relay 拒绝登记推送 token（${code}）`, code);
        return;
      }

      // —— official：App 已用设备私钥向官方 hub 换到 credential，主机只做格式校验后内存保存 ——
      if (!isValidBundleId(hubBundleId)) {
        fail(400, 'invalid-body', 'official 通道需要合法 bundleId（3-155 字符，字母数字/./-）');
        return;
      }
      let hubEndpoint;
      try {
        hubEndpoint = normalizePushHubEndpoint(hubEndpointRaw);
      } catch (error) {
        fail(400, 'invalid-body', error.message, 'invalid-hub-endpoint');
        return;
      }
      if (!isPushCredentialLike(credential)) {
        fail(400, 'invalid-body', 'official 通道需要 credential（三段式 JWT 字符串，≤4096 字符）');
        return;
      }
      // 通道切换（同一设备从 self 改 official）：不再把它的 token 补报 relay。
      if (typeof this.connector?.removePushToken === 'function') this.connector.removePushToken(deviceId);
      this.pushDevices.set(deviceId, {
        deviceId,
        token,
        environment,
        channel: PUSH_CHANNELS.OFFICIAL,
        bundleId: hubBundleId,
        hubEndpoint,
        credential,
        registeredAt: this.now(),
      });
      this.pushOfficialHub = hubEndpoint;
      this.pushOfficialLastError = '';
      this.audit?.append({ deviceId, action: 'push-token', result: 'ok', hash: 'official' });
      this.log(`group push: registered device=${deviceId} channel=official bundleId=${hubBundleId} hub=${hubEndpoint}`);
      sendJson(res, 200, { ok: true, data: { registered: true, channel: PUSH_CHANNELS.OFFICIAL, mode: PUSH_CHANNELS.OFFICIAL } });
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
