/**
 * 群体服务版（A 模式）relay 核心实现。
 *
 * 0.3.0 起 relay 只服务群体版产品线：classic 单机盲中继（443 TLS 透传、80 跳转、
 * tokens.json）已删除。剩余四个面：
 *
 *   :<edge.port>/tcp  边缘 TLS —— relay 用通配证书终止手机 TLS（SNI → <hostId>.<domain>），
 *                     设备会话（短时 token / __Host- cookie）鉴权后经控制面隧道转发到主机。
 *   :<controlPort>/tcp 控制面 WSS（host 插件专用）：host.hello 鉴权 → host.ready →
 *                     JSON 控制消息 + 二进制流帧（dsh-remote-protocol）+ 推送（push.register / push.send）。
 *   :<httpPort>/tcp   只保留 GET/HEAD /healthz（容器 HEALTHCHECK 用）；其它一律 404。
 *   api / admin 面     可各自独立监听：POST /__group/register、/__group/refresh；/__admin。
 *
 * 隧道多路复用（边缘连接 → 主机）：
 *   公网 TLS 连接 → u32 streamId → host.open(JSON) → host.opened(JSON) →
 *   [二进制 DATA 帧双向] → CLOSE 帧。
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { WebSocket, WebSocketServer } from 'ws';
import {
  CONTROL_PATH,
  FRAME_TYPE,
  GROUP_AUTH_CHALLENGE_PATH,
  GROUP_AUTH_TOKEN_PATH,
  GROUP_EDGE_STREAM_KIND,
  GROUP_REGISTER_PATH,
  GROUP_REFRESH_PATH,
  PAIR_PATH,
  PAIR_STATUS_PATH,
  PROTOCOL_VERSION,
  RELAY_MSG,
  decodeFrame,
  encodeFrame,
  hostFqdn,
} from 'dsh-remote-protocol';
import { isValidHostId, normalizeHostId } from './tokens.js';
import { normalizeConfig, readTlsMaterial } from './config.js';
import { GroupRegistrationService, verifyHostToken } from './group.js';
import { GROUP_ADMIN_BASE, createGroupAdminHandler, ensureAdminToken } from './group-admin.js';
import { createGroupPushService } from './push.js';
import { dirname, join } from 'node:path';
import { GroupAuthError, GroupAuthService } from './group-auth.js';
import { parseHttpHead, readHttpHead, readHttpJsonBody, writeHttpResponse } from './edge-http.js';

/** 控制面单帧上限（流帧由主机侧切成合理大小；给 32 MiB 余量）。 */
const MAX_CONTROL_PAYLOAD = 32 * 1024 * 1024;
/** app → host 方向的 ws 背压水位。 */
const SEND_HIGH_WATER_BYTES = 2 * 1024 * 1024;
const SEND_LOW_WATER_BYTES = 1024 * 1024;
/** 控制连接关闭码（应用层自定义段 4000-4999）。 */
const CLOSE_CODE_REPLACED = 4001;
const CLOSE_CODE_HEARTBEAT_TIMEOUT = 4002;
const CLOSE_CODE_RELAY_SHUTDOWN = 4003;

/** @param {import('ws').WebSocket | undefined | null} ws */
function isWsOpen(ws) {
  return Boolean(ws) && ws.readyState === WebSocket.OPEN;
}

/** @param {net.Server | http.Server | undefined | null} server */
function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

/** @param {net.Socket} socket */
function formatPeer(socket) {
  return `${socket.remoteAddress ?? '?'}:${socket.remotePort ?? '?'}`;
}

class Relay {
  /** @param {ReturnType<typeof normalizeConfig>} config */
  constructor(config) {
    this.config = config;
    this.logger = config.logger;
    /**
     * 群体版设备会话鉴权（仅 edge 启用时）：短时 token、challenge、设备注册表。
     * @type {GroupAuthService | null}
     */
    this.groupAuth = config.group.edge.enabled
      ? new GroupAuthService({
        groupFile: config.group.file,
        ...config.group.auth,
        logger: config.logger,
      })
      : null;
    /**
     * 群体版注册/开通服务（邀请码 → 主机自助注册；本产品线唯一入口，始终启用）。
     * @type {GroupRegistrationService}
     */
    this.groupService = new GroupRegistrationService({
      ...config.group,
      relayDomain: config.domain,
      logger: config.logger,
      tokenPublicKey: this.groupAuth?.publicKey,
      getControlPort: () => this.controlPort,
      publicControlPort: config.group.publicControlPort,
    });
    /**
     * 服务端集中推送（client token 表只在内存；R2 起只有 self = 部署方 APNs key 直连 Apple）。
     * APNs 私钥不在启动时读取（首次实际推送才读，失败给可操作错误）。
     * 测试可经 createRelay({ pushClients }) 注入 APNs 替身（JSON 配置无法表达函数）。
     * @type {ReturnType<typeof createGroupPushService>}
     */
    this.push = createGroupPushService({
      config: config.group.push,
      logger: config.logger,
      domain: config.domain,
      apnsClient: config.pushClients?.apnsClient,
      now: config.pushClients?.now,
      createApnsClient: config.pushClients?.createApnsClient,
    });

    /** 部署方后台（/__admin）：默认自动生成 admin-token 文件（0600）。 */
    const adminTokenFile = config.group.adminTokenFile ?? join(dirname(config.group.file), 'admin-token');
    const admin = ensureAdminToken({ token: config.group.adminToken, tokenFile: adminTokenFile });
    this.groupAdminTokenInfo = admin;
    this.groupAdmin = createGroupAdminHandler({
      groupFile: config.group.file,
      domain: config.domain,
      mobilePort: config.group.mobilePort,
      adminToken: admin.token,
      onlineHostIds: () => [...this.hosts.keys()],
      pushSummary: () => this.push.summary(),
      onHostRevoked: (hostId) => {
        // 撤销主机后其推送 token 立即失效（凭据已不可用，不再给该 host 发通知）。
        this.push.dropHost(hostId);
      },
      logger: config.logger,
    });

    /** @type {Map<string, any>} hostId → host */
    this.hosts = new Map();

    this.controlPort = config.controlPort;
    this.httpPort = config.httpPort;
    this.edgePort = 0;
    this.closed = false;

    /** @type {tls.Server | null} 边缘 TLS（A 模式，唯一数据面） */
    this.edgeServer = null;
    /** @type {Set<import('node:tls').TLSSocket>} 边缘连接（close() 时强制断） */
    this.edgeSockets = new Set();
    /** @type {Map<string, number>} IP → 边缘连接数（DoS 兜底） */
    this.edgeIpConnections = new Map();
    /** @type {http.Server | https.Server | null} */
    this.controlServer = null;
    /** @type {http.Server | https.Server | null} group 注册 API 独立监听（apiPort） */
    this.groupApiServer = null;
    /** @type {http.Server | https.Server | null} group 部署方后台独立监听（adminPort） */
    this.groupAdminServer = null;
    this.groupApiPort = 0;
    this.groupAdminPort = 0;
    /** @type {http.Server | null} */
    this.httpServer = null;
    /** @type {WebSocketServer | null} */
    this.wss = null;
    /** @type {NodeJS.Timeout | null} */
    this.heartbeatTimer = null;
  }

  async start() {
    const tlsMaterial = readTlsMaterial(this.config.tls);

    const controlRequestHandler = (req, res) => this.handleControlHttpRequest(req, res);
    this.controlServer = tlsMaterial
      ? https.createServer({ cert: tlsMaterial.cert, key: tlsMaterial.key }, controlRequestHandler)
      : http.createServer(controlRequestHandler);
    this.controlServer.on('error', (err) => this.logger.error(`control plane server error: ${err.code ?? ''} ${err.message}`));
    this.controlServer.on('upgrade', (req, socket, head) => this.handleControlUpgrade(req, socket, head));

    // 职责分离：控制面只做 WSS 隧道；注册 API / 部署方后台各自独立监听（apiPort / adminPort）。
    const makeHttpServer = (handler, name) => {
      const server = tlsMaterial
        ? https.createServer({ cert: tlsMaterial.cert, key: tlsMaterial.key }, handler)
        : http.createServer(handler);
      server.on('error', (err) => this.logger.error(`${name} server error: ${err.code ?? ''} ${err.message}`));
      return server;
    };
    if (this.config.group.apiPort !== undefined) {
      this.groupApiServer = makeHttpServer((req, res) => this.handleGroupApiHttpRequest(req, res), 'group api');
    }
    if (this.config.group.adminPort !== undefined) {
      this.groupAdminServer = makeHttpServer((req, res) => { void this.groupAdmin(req, res); }, 'group admin');
    }

    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_CONTROL_PAYLOAD,
      perMessageDeflate: false,
      clientTracking: true,
    });
    this.wss.on('connection', (ws, req) => this.handleControlConnection(ws, req));
    this.wss.on('error', (err) => this.logger.error(`control websocket server error: ${err.message}`));

    this.httpServer = http.createServer((req, res) => this.handleHttpRequest(req, res));
    this.httpServer.on('error', (err) => this.logger.error(`http health server error: ${err.code ?? ''} ${err.message}`));

    if (this.config.group.edge.enabled) {
      const edgeTls = readTlsMaterial(this.config.group.edge.tls);
      this.edgeServer = tls.createServer(
        { cert: edgeTls.cert, key: edgeTls.key, requestCert: false, rejectUnauthorized: false },
        (socket) => this.handleEdgeConnection(socket),
      );
      this.edgeServer.on('tlsClientError', (err, socket) => {
        this.logger.debug(`edge: TLS handshake failed from ${formatPeer(socket)}: ${err.code ?? err.message}`);
      });
      this.edgeServer.on('error', (err) => this.logger.error(`edge server error: ${err.code ?? ''} ${err.message}`));
    }

    try {
      await Promise.all([
        this.listen(this.controlServer, this.config.controlPort, 'control'),
        this.listen(this.httpServer, this.config.httpPort, 'http'),
        this.edgeServer ? this.listen(this.edgeServer, this.config.group.edge.port, 'edge') : Promise.resolve(),
        this.groupApiServer
          ? this.listen(
            this.groupApiServer,
            this.config.group.apiPort,
            'group api',
            this.config.group.apiBind ?? this.config.listenHost,
          )
          : Promise.resolve(),
        this.groupAdminServer
          ? this.listen(
            this.groupAdminServer,
            this.config.group.adminPort,
            'group admin',
            this.config.group.adminBind ?? '127.0.0.1',
          )
          : Promise.resolve(),
      ]);
    } catch (err) {
      this.closed = true;
      await this.closeTransport();
      throw err;
    }

    const controlAddr = /** @type {net.AddressInfo} */ (this.controlServer.address());
    const httpAddr = /** @type {net.AddressInfo} */ (this.httpServer.address());
    this.controlPort = controlAddr.port;
    this.httpPort = httpAddr.port;
    if (this.groupApiServer) this.groupApiPort = /** @type {net.AddressInfo} */ (this.groupApiServer.address()).port;
    if (this.groupAdminServer) this.groupAdminPort = /** @type {net.AddressInfo} */ (this.groupAdminServer.address()).port;
    if (this.edgeServer) {
      this.edgePort = /** @type {net.AddressInfo} */ (this.edgeServer.address()).port;
      if (this.config.group.edge.allowUnauthenticated) {
        this.logger.warn(
          `group edge listening on :${this.edgePort} WITHOUT device authentication (dev-only); `
          + 'do not expose this to the internet',
        );
      } else {
        this.logger.info(`group edge listening on :${this.edgePort} (device session token auth enabled)`);
      }
    }

    const tick = Math.max(10, Math.min(this.config.timings.heartbeatIntervalMs, 5000));
    this.heartbeatTimer = setInterval(() => this.sweepHosts(), tick);
    this.heartbeatTimer.unref?.();

    this.logger.info(
      `group relay listening on ${this.config.listenHost} — `
      + `control :${this.controlPort} (${tlsMaterial ? 'wss' : 'ws/dev'}), http health :${this.httpPort}; domain ${this.config.domain}`,
    );
    if (this.groupApiServer) {
      const scheme = tlsMaterial ? 'https' : 'http';
      this.logger.info(
        `group api: ${scheme}://${this.config.domain}:${this.groupApiPort}${GROUP_REGISTER_PATH} `
        + `(self-registration + ${GROUP_REFRESH_PATH}; control plane :${this.controlPort} now WSS-only)`,
      );
    }
    if (this.groupAdmin) {
      const scheme = tlsMaterial ? 'https' : 'http';
      const info = this.groupAdminTokenInfo;
      const tokenHint = info?.file ? `${info.file}${info.generated ? ' (generated)' : ''}` : 'configured via group.adminToken';
      if (this.groupAdminServer) {
        this.logger.info(
          `group admin: ${scheme}://${this.config.group.adminBind ?? '127.0.0.1'}:${this.groupAdminPort}${GROUP_ADMIN_BASE}/ `
          + `— token: ${tokenHint}`,
        );
      } else {
        this.logger.info(`admin UI: ${scheme}://${this.config.domain}:${this.controlPort}${GROUP_ADMIN_BASE}/ — token: ${tokenHint}`);
      }
    }
    const pushSummary = this.push.summary();
    if (pushSummary.enabled) {
      this.logger.info('group push: mode self（relay 用部署方自己的 APNs Auth Key 直连 Apple；官方 App 推送直连官方 hub，不经过 relay）');
    } else {
      this.logger.info('group push: disabled（group.push.enabled=false；push.* 控制消息返回 push_disabled）');
    }
    return this.api();
  }

  /**
   * @param {net.Server | http.Server} server
   * @param {number} port
   * @param {string} name
   */
  listen(server, port, name, host = this.config.listenHost) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        const code = err && err.code ? ` (${err.code})` : '';
        reject(new Error(`failed to bind ${name} plane on ${host}:${port}${code}: ${err && err.message ? err.message : String(err)}`));
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ port, host });
    });
  }

  /** 暴露给调用方的 API（createRelay/startRelay 返回值；群体版 relay）。 */
  api() {
    return {
      controlPort: this.controlPort,
      httpPort: this.httpPort,
      groupApiPort: this.groupApiPort,
      groupAdminPort: this.groupAdminPort,
      domain: this.config.domain,
      edgePort: this.edgePort,
      dev: this.config.dev,
      close: () => this.close(),
      health: () => this.health(),
      onlineHostIds: () => [...this.hosts.keys()].sort(),
    };
  }

  health() {
    return {
      ok: true,
      domain: this.config.domain,
      hosts: [...this.hosts.keys()].sort(),
      // 只暴露摘要（enabled/mode/token 数），不含任何 token / 密钥。
      push: this.push.summary(),
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const host of [...this.hosts.values()]) this.removeHost(host, 'relay_shutdown');
    this.hosts.clear();
    for (const ws of this.wss?.clients ?? []) {
      try {
        ws.close(CLOSE_CODE_RELAY_SHUTDOWN, 'relay shutdown');
      } catch {
        /* ignore */
      }
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    }
    for (const socket of this.edgeSockets) socket.destroy();
    this.edgeSockets.clear();
    this.controlServer?.closeAllConnections?.();
    this.httpServer?.closeAllConnections?.();
    this.groupApiServer?.closeAllConnections?.();
    this.groupAdminServer?.closeAllConnections?.();
    await this.closeTransport();
    this.logger.info('relay stopped');
  }

  async closeTransport() {
    const wss = this.wss;
    this.wss = null;
    try {
      wss?.close();
    } catch {
      /* ignore */
    }
    await Promise.all([
      closeServer(this.httpServer),
      closeServer(this.controlServer),
      closeServer(this.edgeServer),
      closeServer(this.groupApiServer),
      closeServer(this.groupAdminServer),
    ]);
  }

  // ---------------------------------------------------------------------------
  // 控制面（:8443 WSS，host 插件专用）
  // ---------------------------------------------------------------------------

  /** @param {http.IncomingMessage} req @param {net.Socket} socket @param {Buffer} head */
  handleControlUpgrade(req, socket, head) {
    if (this.closed) {
      socket.destroy();
      return;
    }
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://relay.invalid').pathname;
    } catch {
      pathname = req.url ?? '/';
    }
    if (pathname !== CONTROL_PATH) {
      this.logger.debug(`control: rejecting websocket upgrade for path ${JSON.stringify(pathname)}`);
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
  }

  /**
   * 控制端口上的普通 HTTP 请求：
   *   - POST /__group/register、POST /__group/refresh → 群体版注册 API（未独立监听时）；
   *   - /__admin* → 部署方后台（未独立监听时）；
   *   - 其它 → 404（控制面只接受 WS upgrade）。
   */
  handleControlHttpRequest(req, res) {
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://relay.invalid').pathname;
    } catch {
      pathname = req.url ?? '/';
    }
    const separatedAdmin = this.config.group.adminPort !== undefined;
    const separatedApi = this.config.group.apiPort !== undefined;
    if (!separatedAdmin && (pathname === GROUP_ADMIN_BASE || pathname.startsWith(`${GROUP_ADMIN_BASE}/`))) {
      void this.groupAdmin(req, res);
      return;
    }
    if (!separatedApi && pathname === GROUP_REGISTER_PATH) {
      void this.groupService.handleHttp(req, res);
      return;
    }
    if (!separatedApi && pathname === GROUP_REFRESH_PATH) {
      void this.groupService.handleRefreshHttp(req, res);
      return;
    }
    const body = JSON.stringify({ ok: false, error: { code: 'not_found', message: 'control plane only accepts WebSocket upgrades on /control' } });
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  /**
   * 独立注册 API 面（group.apiPort）：只服务 POST /__group/register；其它 404。
   * 控制面配置了 apiPort 后不再提供注册接口。
   * @param {http.IncomingMessage} req @param {http.ServerResponse} res
   */
  handleGroupApiHttpRequest(req, res) {
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://relay.invalid').pathname;
    } catch {
      pathname = req.url ?? '/';
    }
    if (this.groupService && pathname === GROUP_REGISTER_PATH) {
      void this.groupService.handleHttp(req, res);
      return;
    }
    if (this.groupService && pathname === GROUP_REFRESH_PATH) {
      void this.groupService.handleRefreshHttp(req, res);
      return;
    }
    const body = JSON.stringify({
      ok: false,
      error: { code: 'not_found', message: 'group api plane serves POST /__group/register only' },
    });
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  /**
   * @param {WebSocket} ws
   * @param {http.IncomingMessage} req
   */
  handleControlConnection(ws, req) {
    const conn = {
      ws,
      remote: formatPeer(req.socket),
      ready: false,
      /** @type {any} */
      host: null,
      lastSeenAt: Date.now(),
      /** @type {NodeJS.Timeout | null} */
      helloTimer: null,
    };
    conn.helloTimer = setTimeout(() => {
      if (!conn.ready) this.failConn(conn, 'handshake_timeout', 'host.hello was not received in time');
    }, this.config.timings.handshakeTimeoutMs);
    conn.helloTimer.unref?.();

    ws.on('message', (data, isBinary) => this.handleControlMessage(conn, data, isBinary));
    ws.on('close', () => this.handleControlClose(conn));
    ws.on('error', (err) => this.logger.debug(`control: socket error from ${conn.remote}: ${err.code ?? err.message}`));
    this.logger.debug(`control: connection from ${conn.remote}`);
  }

  /**
   * @param {any} conn
   * @param {Buffer} data
   * @param {boolean} isBinary
   */
  handleControlMessage(conn, data, isBinary) {
    conn.lastSeenAt = Date.now();
    if (conn.host) conn.host.lastSeenAt = conn.lastSeenAt;

    if (!conn.ready) {
      this.handlePreHelloMessage(conn, data, isBinary);
      return;
    }
    if (isBinary) {
      this.handleHostFrame(conn.host, data);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      this.logger.debug('control: ignoring malformed JSON text message');
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case RELAY_MSG.HOST_HEARTBEAT:
        return; // lastSeenAt 已刷新
      case RELAY_MSG.DEVICE_SYNC:
        this.handleDeviceSync(conn.host, msg);
        return;
      case RELAY_MSG.DEVICE_REVOKE:
        this.handleDeviceRevoke(conn.host, msg);
        return;
      case RELAY_MSG.HOST_OPENED:
        this.handleHostOpened(conn.host, msg);
        return;
      case RELAY_MSG.HOST_CLOSE:
        this.handleHostCloseMessage(conn.host, msg);
        return;
      case RELAY_MSG.PUSH_REGISTER:
        this.handlePushRegister(conn.host, msg);
        return;
      case RELAY_MSG.PUSH_SEND:
        void this.handlePushSend(conn.host, msg);
        return;
      default:
        // 未知消息忽略（老 host 不认识的类型也可能出现；老 relay 会忽略 push.* 实现兼容）。
        this.logger.debug(`control: ignoring unsupported message type ${JSON.stringify(String(msg.t))}`);
    }
  }

  /**
   * @param {any} conn
   * @param {Buffer} data
   * @param {boolean} isBinary
   */
  handlePreHelloMessage(conn, data, isBinary) {
    if (isBinary) {
      this.failConn(conn, 'expected_hello', 'first control message must be a host.hello text frame');
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      this.failConn(conn, 'invalid_json', 'first control message must be valid JSON');
      return;
    }
    if (!msg || typeof msg !== 'object' || msg.t !== RELAY_MSG.HOST_HELLO) {
      this.failConn(conn, 'expected_hello', 'first control message must be host.hello');
      return;
    }
    this.handleHello(conn, msg);
  }

  /**
   * @param {any} conn
   * @param {Record<string, any>} msg
   */
  handleHello(conn, msg) {
    const version = Number(msg.protocolVersion);
    if (version !== PROTOCOL_VERSION) {
      this.failConn(conn, 'unsupported_protocol_version', `relay speaks protocol version ${PROTOCOL_VERSION}`);
      return;
    }
    if (!isValidHostId(msg.hostId)) {
      this.failConn(conn, 'invalid_host_id', 'hostId must be a DNS label (1-63 chars, a-z0-9_-)');
      return;
    }
    const hostId = normalizeHostId(msg.hostId);
    if (typeof msg.token !== 'string' || msg.token.length === 0) {
      this.failConn(conn, 'unauthorized', 'invalid host credentials');
      return;
    }
    if (!this.verifyHostCredential(hostId, msg.token)) {
      this.logger.warn(`control: rejected host "${hostId}" from ${conn.remote}: invalid token`);
      this.failConn(conn, 'unauthorized', 'invalid host credentials');
      return;
    }

    if (conn.helloTimer) {
      clearTimeout(conn.helloTimer);
      conn.helloTimer = null;
    }

    const hostName = typeof msg.hostName === 'string' && msg.hostName.trim() !== ''
      ? msg.hostName.trim().slice(0, 120)
      : hostId;

    // 同一 hostId 只保留最新连接：旧连接直接替换（先回收其 streams）。
    const existing = this.hosts.get(hostId);
    if (existing) {
      this.logger.info(`control: replacing existing control connection for host "${hostId}"`);
      this.removeHost(existing, 'replaced');
      this.sendJson(existing.ws, { t: RELAY_MSG.ERROR, code: 'replaced', message: 'replaced by a new control connection' });
      try {
        existing.ws.close(CLOSE_CODE_REPLACED, 'replaced');
      } catch {
        try {
          existing.ws.terminate();
        } catch {
          /* ignore */
        }
      }
    }

    const now = Date.now();
    const host = {
      hostId,
      hostName,
      ws: conn.ws,
      conn,
      connectedAt: now,
      lastSeenAt: now,
      lastHeartbeatAt: now,
      streams: new Map(),
      streamSeq: 0,
    };
    conn.ready = true;
    conn.host = host;
    this.hosts.set(hostId, host);
    this.logger.info(`host online: "${hostId}" (${hostName}) from ${conn.remote}`);

    this.sendJson(conn.ws, {
      t: RELAY_MSG.HOST_READY,
      protocolVersion: PROTOCOL_VERSION,
      hostId,
      domain: this.config.domain,
      hostname: hostFqdn(hostId, this.config.domain),
    });
  }

  /** @param {any} conn */
  handleControlClose(conn) {
    if (conn.helloTimer) {
      clearTimeout(conn.helloTimer);
      conn.helloTimer = null;
    }
    const host = conn.host;
    conn.host = null;
    conn.ready = false;
    if (host && this.hosts.get(host.hostId) === host) {
      this.removeHost(host, 'control_connection_closed');
    }
  }

  /**
   * @param {any} conn
   * @param {string} code
   * @param {string} message
   */
  failConn(conn, code, message) {
    this.logger.debug(`control: closing connection (${code}): ${message}`);
    if (conn.helloTimer) {
      clearTimeout(conn.helloTimer);
      conn.helloTimer = null;
    }
    if (isWsOpen(conn.ws)) {
      this.sendJson(conn.ws, { t: RELAY_MSG.ERROR, code, message });
      try {
        conn.ws.close(1008, code.slice(0, 120));
      } catch {
        try {
          conn.ws.terminate();
        } catch {
          /* ignore */
        }
      }
    } else {
      try {
        conn.ws.terminate();
      } catch {
        /* ignore */
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 边缘隧道核心：SNI → hostId 路由 + stream 分配（边缘 TLS 在下方「边缘平面」）
  // ---------------------------------------------------------------------------

  /**
   * 从 SNI 解析 hostId：必须严格是 <hostId>.<domain>，hostId 为单个 DNS 首标签。
   * @param {string | null | undefined} sni
   * @returns {string | null}
   */
  resolveHostIdFromSni(sni) {
    if (typeof sni !== 'string' || sni.length === 0 || sni.length > 253) return null;
    const name = sni.toLowerCase();
    const suffix = `.${this.config.domain}`;
    if (!name.endsWith(suffix)) return null;
    const hostId = name.slice(0, name.length - suffix.length);
    if (hostId === '' || hostId.includes('.') || !isValidHostId(hostId)) return null;
    return hostId;
  }

  /**
   * @param {any} host
   * @returns {number | null}
   */
  allocateStreamId(host) {
    for (let attempt = 0; attempt < 1_000_000; attempt += 1) {
      host.streamSeq = host.streamSeq >= 0xffffffff ? 1 : host.streamSeq + 1;
      if (!host.streams.has(host.streamSeq)) return host.streamSeq;
    }
    return null;
  }

  /**
   * host 回了 host.opened：先把缓冲的首包（HTTP 请求头/剩余字节）**转发给 host**
   *（client→host 方向），然后恢复 app socket 读流；后续 app 数据走 forwardAppData。
   *
   * 注意方向：stream.pending 是客户端发来的首包（client→host），
   * 绝不能写回 app socket。
   *
   * @param {any} stream
   */
  openStream(stream) {
    if (stream.opened || stream.finished) return;
    stream.opened = true;
    if (stream.openTimer) {
      clearTimeout(stream.openTimer);
      stream.openTimer = null;
    }
    const host = stream.host;
    if (!isWsOpen(host.ws)) {
      this.finishStream(stream, 'host_disconnected');
      return;
    }
    const socket = stream.socket;
    if (socket.destroyed || !socket.writable) {
      this.finishStream(stream, 'app_closed_before_open');
      return;
    }

    const pending = stream.pending.length === 1 ? stream.pending[0] : Buffer.concat(stream.pending);
    stream.pending = [];
    if (pending.length === 0) {
      this.resumeAppStream(stream);
      return;
    }
    try {
      host.ws.send(encodeFrame(FRAME_TYPE.DATA, stream.id, pending), { binary: true }, (err) => {
        if (err) {
          this.finishStream(stream, 'send_error');
          return;
        }
        this.resumeAppStream(stream);
      });
    } catch {
      this.finishStream(stream, 'send_error');
    }
  }

  /** 开始把 app socket 的后续字节转成 DATA 帧（首包已发给 host 之后才调用）。 */
  resumeAppStream(stream) {
    if (stream.finished || stream.socket.destroyed) return;
    stream.socket.on('data', (chunk) => this.forwardAppData(stream, chunk));
    stream.socket.resume();
  }

  /**
   * app → host：DATA 帧；ws 缓冲过高时暂停 app socket，send 回调后恢复。
   * @param {any} stream
   * @param {Buffer} chunk
   */
  forwardAppData(stream, chunk) {
    if (stream.finished) return;
    const host = stream.host;
    if (!isWsOpen(host.ws)) {
      this.finishStream(stream, 'host_disconnected');
      return;
    }
    const frame = encodeFrame(FRAME_TYPE.DATA, stream.id, chunk);
    try {
      host.ws.send(frame, { binary: true }, (err) => {
        if (err) {
          this.finishStream(stream, 'send_error');
          return;
        }
        const socket = stream.socket;
        if (!socket.destroyed && socket.isPaused() && host.ws.bufferedAmount < SEND_LOW_WATER_BYTES) socket.resume();
      });
    } catch {
      this.finishStream(stream, 'send_error');
      return;
    }
    if (host.ws.bufferedAmount > SEND_HIGH_WATER_BYTES && !stream.socket.isPaused()) stream.socket.pause();
  }

  /**
   * host → relay 二进制帧：DATA → app socket.write；CLOSE → app socket.end()。
   * @param {any} host
   * @param {Buffer} data
   */
  handleHostFrame(host, data) {
    const frame = decodeFrame(data);
    if (!frame) {
      this.logger.debug(`control: host "${host.hostId}" sent a binary frame shorter than the ${5}-byte header`);
      return;
    }
    const stream = host.streams.get(frame.streamId);
    if (!stream || stream.finished) return;
    if (frame.type === FRAME_TYPE.DATA) {
      if (!stream.opened) {
        this.logger.debug(`control: host "${host.hostId}" sent DATA before host.opened for stream ${frame.streamId}; dropped`);
        return;
      }
      if (stream.socket.destroyed || !stream.socket.writable) {
        this.finishStream(stream, 'app_closed');
        return;
      }
      try {
        stream.socket.write(frame.payload);
      } catch {
        this.finishStream(stream, 'app_write_error');
      }
      return;
    }
    if (frame.type === FRAME_TYPE.CLOSE) {
      stream.hostClosed = true;
      if (!stream.socket.destroyed) stream.socket.end();
      return;
    }
    this.logger.debug(`control: ignoring unknown frame type ${frame.type} from host "${host.hostId}"`);
  }

  /** @param {any} host @param {Record<string, any>} msg */
  handleHostOpened(host, msg) {
    const streamId = Number(msg.streamId);
    if (!Number.isInteger(streamId) || streamId <= 0) return;
    const stream = host.streams.get(streamId);
    if (!stream) {
      this.logger.debug(`control: host "${host.hostId}" opened unknown/expired stream ${streamId}`);
      return;
    }
    this.openStream(stream);
  }

  /** 主机主动取消一个未就绪/进行中的 stream（JSON host.close）。 */
  handleHostCloseMessage(host, msg) {
    const streamId = Number(msg.streamId);
    if (!Number.isInteger(streamId) || streamId <= 0) return;
    const stream = host.streams.get(streamId);
    if (!stream || stream.finished) return;
    stream.hostClosed = true;
    this.finishStream(stream, typeof msg.reason === 'string' ? msg.reason : 'host_closed');
  }

  /**
   * 结束一条 stream：从 host 表移除、必要时通知 host、销毁 app socket。
   * @param {any} stream
   * @param {string} reason
   */
  finishStream(stream, reason) {
    if (stream.finished) return;
    stream.finished = true;
    if (stream.openTimer) {
      clearTimeout(stream.openTimer);
      stream.openTimer = null;
    }
    const host = stream.host;
    host.streams.delete(stream.id);
    if (!stream.hostClosed && stream.opened && isWsOpen(host.ws)) {
      try {
        host.ws.send(encodeFrame(FRAME_TYPE.CLOSE, stream.id), { binary: true });
      } catch {
        /* ignore */
      }
    }
    if (!stream.socket.destroyed) stream.socket.destroy();
    this.logger.debug(`data: stream ${stream.id} closed (${reason})`);
  }

  /** @param {any} host @param {string} reason */
  removeHost(host, reason) {
    if (this.hosts.get(host.hostId) === host) this.hosts.delete(host.hostId);
    // 注意：不要在这里清空 groupAuth 的设备注册表。
    // 控制连接会被「replace / 短暂断线重连」替换，清空会导致主机重连、device.sync 到达前的
    // 几百毫秒内所有边缘请求 401（表现为「首次进入白屏 401、返回再进就好」）。
    // 设备撤销以主机侧设备表为权威（主机代理逐请求检查 device 是否存在），relay 设备表只用于
    // 校验 token 里的 deviceId 是否仍在册；显式撤销走 device.revoke。
    for (const stream of [...host.streams.values()]) {
      stream.finished = true;
      if (stream.openTimer) clearTimeout(stream.openTimer);
      if (!stream.socket.destroyed) stream.socket.destroy();
    }
    host.streams.clear();
    if (host.conn) {
      host.conn.ready = false;
      host.conn.host = null;
    }
    this.logger.info(`host offline: "${host.hostId}" (${reason})`);
  }

  /** 心跳：每 tick 发 host.heartbeat；超过 heartbeatTimeoutMs 没有任何消息 → 断开。 */
  sweepHosts() {
    if (this.closed) return;
    const now = Date.now();
    for (const host of [...this.hosts.values()]) {
      const silence = now - host.lastSeenAt;
      if (silence > this.config.timings.heartbeatTimeoutMs) {
        this.logger.warn(`host "${host.hostId}": silent for ${Math.round(silence)}ms (limit ${this.config.timings.heartbeatTimeoutMs}ms), dropping`);
        this.removeHost(host, 'heartbeat_timeout');
        try {
          host.ws.close(CLOSE_CODE_HEARTBEAT_TIMEOUT, 'heartbeat timeout');
        } catch {
          /* ignore */
        }
        try {
          host.ws.terminate();
        } catch {
          /* ignore */
        }
        continue;
      }
      if (now - host.lastHeartbeatAt >= this.config.timings.heartbeatIntervalMs) {
        host.lastHeartbeatAt = now;
        this.sendJson(host.ws, { t: RELAY_MSG.HOST_HEARTBEAT, ts: now });
      }
    }
  }

  /**
   * 校验 host 控制面凭据：只认 group.json 里的注册 token hash（classic tokens.json 已删除）。
   * @param {string} hostId
   * @param {string} token
   */
  verifyHostCredential(hostId, token) {
    try {
      return verifyHostToken(this.config.group.file, hostId, token);
    } catch (err) {
      this.logger.warn(`control: cannot verify host "${hostId}": ${err && err.message ? err.message : String(err)}`);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // 群体版边缘平面（A 模式）：relay 终止手机 TLS，明文经控制面隧道转发到主机
  // ---------------------------------------------------------------------------

  /** @param {import('node:tls').TLSSocket} socket */
  handleEdgeConnection(socket) {
    if (this.closed) {
      socket.destroy();
      return;
    }
    const ip = socket.remoteAddress ?? 'unknown';
    const ipCount = this.edgeIpConnections.get(ip) ?? 0;
    if (ipCount >= this.config.limits.maxConnectionsPerIp
      || this.edgeSockets.size >= this.config.limits.maxEdgeConnections) {
      this.logger.warn(`edge: dropping ${formatPeer(socket)}: connection limit reached`);
      socket.destroy();
      return;
    }
    this.edgeIpConnections.set(ip, ipCount + 1);
    this.edgeSockets.add(socket);
    socket.on('close', () => {
      this.edgeSockets.delete(socket);
      const left = (this.edgeIpConnections.get(ip) ?? 1) - 1;
      if (left <= 0) this.edgeIpConnections.delete(ip);
      else this.edgeIpConnections.set(ip, left);
    });
    socket.on('error', (err) => this.logger.debug(`edge: socket error from ${formatPeer(socket)}: ${err.code ?? err.message}`));
    const sni = typeof socket.servername === 'string' && socket.servername !== '' ? socket.servername : null;
    this.logger.debug(`edge: tls ${formatPeer(socket)} sni=${JSON.stringify(sni)}`);
    void this.handleEdgeSession(socket, sni).catch((err) => {
      this.logger.debug(`edge: session error from ${formatPeer(socket)}: ${err && err.message ? err.message : String(err)}`);
      if (!socket.destroyed) socket.destroy();
    });
  }

  /**
   * 拒绝一条边缘连接（TLS 已建立，回最小 HTTP 响应后关闭）。
   * @param {import('node:tls').TLSSocket} socket
   * @param {number} status
   * @param {string} reason
   */
  rejectEdgeHttp(socket, status, reason) {
    if (socket.destroyed) return;
    const reasonText = status === 421 ? 'Misdirected Request' : status === 502 ? 'Bad Gateway' : 'Service Unavailable';
    const body = `${reason}\n`;
    const head = `HTTP/1.1 ${status} ${reasonText}\r\n`
      + 'content-type: text/plain; charset=utf-8\r\n'
      + `content-length: ${Buffer.byteLength(body)}\r\n`
      + 'connection: close\r\n\r\n';
    try {
      socket.end(head + body);
    } catch {
      socket.destroy();
    }
  }

  /**
   * 边缘会话：读 HTTP 头 → 鉴权接口 /（cookie 校验后）开隧道到主机。
   * @param {import('node:tls').TLSSocket} socket
   * @param {string | null} sni
   */
  async handleEdgeSession(socket, sni) {
    if (socket.destroyed) return;
    const remote = formatPeer(socket);
    const hostId = this.resolveHostIdFromSni(sni);
    if (!hostId) {
      this.logger.debug(`edge: dropping ${remote}: no route for SNI ${sni === null ? '(absent)' : JSON.stringify(sni)}`);
      this.rejectEdgeHttp(socket, 421, 'no_route');
      return;
    }
    const host = this.hosts.get(hostId);
    if (!host || !isWsOpen(host.ws)) {
      this.logger.debug(`edge: dropping ${remote}: host "${hostId}" is offline (SNI ${JSON.stringify(sni)})`);
      this.rejectEdgeHttp(socket, 502, 'host_offline');
      return;
    }

    let rawHead;
    let rest;
    let parsedHead;
    try {
      ({ head: rawHead, rest } = await readHttpHead(socket, { timeoutMs: this.config.timings.openTimeoutMs }));
      parsedHead = parseHttpHead(rawHead);
    } catch (err) {
      this.logger.debug(`edge: bad HTTP request from ${remote}: ${err && err.message ? err.message : String(err)}`);
      this.rejectEdgeHttp(socket, 400, 'bad_request');
      return;
    }
    if (this.closed || socket.destroyed) return;
    if (!this.hosts.has(hostId)) {
      this.rejectEdgeHttp(socket, 502, 'host_offline');
      return;
    }

    const pathname = parsedHead.path.split('?')[0];
    if (pathname.startsWith('/__group/')) {
      this.logger.info(`edge: request ${parsedHead.method} ${pathname} for host ${hostId} from ${remote}`);
    }
    if (pathname === GROUP_AUTH_CHALLENGE_PATH || pathname === GROUP_AUTH_TOKEN_PATH) {
      this.logger.info(`edge: auth-path ${pathname} for host ${hostId} from ${remote}`);
      let body;
      try {
        body = await readHttpJsonBody(socket, parsedHead.headers, rest);
      } catch (err) {
        writeHttpResponse(socket, {
          status: err && err.statusCode ? err.statusCode : 400,
          body: JSON.stringify({ ok: false, error: { code: 'invalid_request' } }),
        });
        return;
      }
      if (!this.groupAuth) {
        writeHttpResponse(socket, { status: 503, body: JSON.stringify({ ok: false, error: { code: 'group_auth_unavailable' } }) });
        return;
      }
      const result = this.groupAuth.handleAuthRequest({
        hostId,
        method: parsedHead.method,
        path: pathname,
        body,
        clientKey: socket.remoteAddress ?? 'unknown',
      });
      if (result.status >= 400) {
        const entry = result.body && result.body.error ? result.body.error : result.body;
        this.logger.warn(
          `edge: auth ${pathname} -> ${result.status} for host ${hostId} `
          + `device ${String(body && body.deviceId ? body.deviceId : '?')} from ${remote}: ${JSON.stringify(entry)}`,
        );
      }
      writeHttpResponse(socket, {
        status: result.status,
        headers: result.headers,
        body: JSON.stringify(result.body),
      });
      return;
    }

    // 配对路径：允许无会话（一次性 secret + 主机确认保护；主机侧还有限速）。
    const isPairPath = pathname === PAIR_PATH || pathname === `${PAIR_PATH}/` || pathname === PAIR_STATUS_PATH;

    // 普通业务流量：校验 __Host- 会话 cookie（dev 允许跳过；生产必须通过）。
    let session;
    if (!isPairPath && !this.config.group.edge.allowUnauthenticated) {
      session = this.groupAuth?.sessionFromHeaders(parsedHead.headers, hostId);
      if (!session) {
        this.logger.debug(`edge: rejecting unauthenticated ${parsedHead.method} ${pathname} from ${remote} for host "${hostId}"`);
        writeHttpResponse(socket, {
          status: 401,
          headers: { 'www-authenticate': 'Session' },
          body: JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'missing or invalid session' } }),
        });
        return;
      }
    }

    this.openEdgeTunnel({ socket, hostId, host, sni, rawHead, rest, deviceId: session?.deviceId, remote, pathname });
  }

  /**
   * 把（已鉴权的）边缘连接转成控制面隧道 stream；已读的 HTTP 头/剩余字节作为首包原样转发。
   * 主机侧仍是真正的 HTTP/WS 代理（逐请求鉴权也在主机侧用 relay 公钥复验 token）。
   * @param {{socket: import('node:tls').TLSSocket, hostId: string, host: any, sni: string | null,
   *          rawHead: Buffer, rest: Buffer, deviceId?: string, remote: string}} input
   */
  openEdgeTunnel({ socket, hostId, host, sni, rawHead, rest, deviceId, remote, pathname }) {
    if (socket.destroyed || !isWsOpen(host.ws)) {
      this.rejectEdgeHttp(socket, 502, 'host_offline');
      return;
    }
    const streamId = this.allocateStreamId(host);
    if (streamId === null) {
      this.logger.warn(`edge: dropping ${remote}: stream table for host "${hostId}" is full`);
      this.rejectEdgeHttp(socket, 503, 'stream_limit');
      return;
    }
    socket.pause();
    /** @type {Buffer[]} */
    const pending = [forceEdgeTunnelHead(rawHead)];
    if (rest && rest.length > 0) pending.push(rest);
    const stream = {
      id: streamId,
      host,
      socket,
      pending,
      opened: false,
      finished: false,
      hostClosed: false,
      /** @type {NodeJS.Timeout | null} */
      openTimer: null,
      kind: GROUP_EDGE_STREAM_KIND,
    };
    host.streams.set(streamId, stream);
    socket.on('close', () => this.finishStream(stream, 'app_closed'));
    stream.openTimer = setTimeout(() => {
      if (stream.opened || stream.finished) return;
      this.logger.warn(`edge: stream ${streamId} → host "${hostId}" open timeout`);
      this.sendJson(host.ws, { t: RELAY_MSG.HOST_CLOSE, streamId, reason: 'open_timeout' });
      this.finishStream(stream, 'open_timeout');
    }, this.config.timings.openTimeoutMs);
    stream.openTimer.unref?.();
    this.logger.debug(`edge: tunnel ${pathname ?? '-'} → host "${hostId}" (stream ${streamId}${deviceId ? `, device ${deviceId}` : ''}) from ${remote}`);
    this.sendJson(host.ws, {
      t: RELAY_MSG.HOST_OPEN,
      streamId,
      sni,
      kind: GROUP_EDGE_STREAM_KIND,
      ...(deviceId ? { deviceId } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // 群体版设备注册同步（host 控制面 → relay）
  // ---------------------------------------------------------------------------

  /**
   * 主机全量同步设备列表（设备 ID + P-256 公钥）；覆写该主机的设备注册表。
   * 同步后按最新设备列表清理推送 token（不在册设备立即失效）。
   * @param {any} host
   * @param {Record<string, any>} msg
   */
  handleDeviceSync(host, msg) {
    if (!this.groupAuth) {
      this.sendJson(host.ws, { t: RELAY_MSG.DEVICE_SYNCED, ok: false, code: 'group_auth_unavailable' });
      return;
    }
    try {
      const count = this.groupAuth.syncDevices(host.hostId, msg.devices);
      const deviceIds = (Array.isArray(msg.devices) ? msg.devices : [])
        .map((entry) => (entry && typeof entry === 'object' ? String(entry.deviceId ?? '') : ''))
        .filter((deviceId) => deviceId !== '');
      const droppedTokens = this.push.pruneDevices(host.hostId, deviceIds);
      if (droppedTokens > 0) {
        this.logger.info(`push: host "${host.hostId}" device.sync removed ${droppedTokens} stale push token(s)`);
      }
      this.logger.info(`group auth: host "${host.hostId}" synced ${count} device(s)`);
      this.sendJson(host.ws, { t: RELAY_MSG.DEVICE_SYNCED, ok: true, count });
    } catch (err) {
      const code = err instanceof GroupAuthError ? err.code : 'invalid_devices';
      this.logger.warn(`group auth: host "${host.hostId}" device.sync failed: ${err && err.message ? err.message : String(err)}`);
      this.sendJson(host.ws, { t: RELAY_MSG.DEVICE_SYNCED, ok: false, code, message: err && err.message ? err.message : String(err) });
    }
  }

  /**
   * 撤销单台设备（旧 token 立即失效：session 校验会再查注册表；推送 token 同时删除）。
   * @param {any} host
   * @param {Record<string, any>} msg
   */
  handleDeviceRevoke(host, msg) {
    const deviceId = String(msg.deviceId ?? '');
    const revoked = this.groupAuth ? this.groupAuth.revokeDevice(host.hostId, deviceId) : false;
    if (revoked) this.logger.info(`group auth: host "${host.hostId}" revoked device ${deviceId}`);
    // 即使 auth 注册表里没有（例如只登记过推送 token），也清掉该设备的推送 token。
    if (this.push.dropDevice(host.hostId, deviceId)) {
      this.logger.info(`push: host "${host.hostId}" removed push token for revoked device ${deviceId}`);
    }
    this.sendJson(host.ws, { t: RELAY_MSG.DEVICE_REVOKED, ok: revoked, deviceId });
  }

  // ---------------------------------------------------------------------------
  // 控制面推送消息（host → relay；hostId 只取自已鉴权连接 conn.host）
  // ---------------------------------------------------------------------------

  /**
   * `push.register`：App 的 APNs device token 登记（回复 push.registered）。
   * @param {any} host
   * @param {Record<string, any>} msg
   */
  handlePushRegister(host, msg) {
    const result = this.push.register(host.hostId, msg);
    /** @type {Record<string, any>} */
    const response = {
      t: RELAY_MSG.PUSH_REGISTERED,
      ok: result.ok,
      deviceId: result.deviceId,
    };
    if (result.ok) {
      response.mode = result.mode;
      response.enabled = result.enabled;
    } else {
      response.code = result.code;
      response.message = result.message;
      this.logger.debug(`push: host "${host.hostId}" register rejected (${result.code})`);
    }
    this.sendJson(host.ws, response);
  }

  /**
   * `push.send`：推送意图（回复 push.result；同 id）。
   * APNs 发送是异步的：期间控制连接可能已断开（sendJson 会忽略）。
   * @param {any} host
   * @param {Record<string, any>} msg
   */
  async handlePushSend(host, msg) {
    const id = typeof msg?.id === 'string' ? msg.id.slice(0, 128) : '';
    const result = await this.push.send(host.hostId, msg);
    /** @type {Record<string, any>} */
    const response = { t: RELAY_MSG.PUSH_RESULT, id };
    if (result.ok) {
      response.ok = true;
      response.delivered = result.delivered;
      response.failed = result.failed;
      response.pruned = result.pruned;
      response.mode = result.mode;
      if (result.skipped !== undefined) response.skipped = result.skipped;
    } else {
      response.ok = false;
      response.code = result.code;
      response.message = result.message;
      this.logger.debug(`push: host "${host.hostId}" send rejected (${result.code})`);
    }
    this.sendJson(host.ws, response);
  }

  // ---------------------------------------------------------------------------
  // health 平面（:80，仅 /healthz；容器 HEALTHCHECK / 同机探针用）
  // ---------------------------------------------------------------------------

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  handleHttpRequest(req, res) {
    const rawUrl = typeof req.url === 'string' && req.url.startsWith('/') ? req.url : '/';
    if (rawUrl.split('?')[0] === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      const body = JSON.stringify(this.health());
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    // 0.3.0 起 80 端口只保留 /healthz（classic 的 301 跳转已删除）。
    const body = JSON.stringify({
      ok: false,
      error: { code: 'not_found', message: 'HTTP plane serves GET/HEAD /healthz only; use the edge TLS port for phone traffic' },
    });
    res.writeHead(404, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
      connection: 'close',
    });
    res.end(body);
  }

  /**
   * 向 host 发 JSON 控制消息。
   * @param {WebSocket} ws
   * @param {Record<string, any>} message
   */
  sendJson(ws, message) {
    if (!isWsOpen(ws)) return;
    try {
      ws.send(JSON.stringify(message));
    } catch (err) {
      this.logger.debug(`control: send failed: ${err && err.message ? err.message : String(err)}`);
    }
  }
}

/**
 * 边缘隧道只承载「一条连接上的第一个 HTTP 请求」：之后 socket 原样交给主机。
 * 必须强制 Connection: close，否则客户端（iOS URLSession 默认 keep-alive）会把后续请求
 * （例如 pairing 之后的 challenge）复用同一 TLS 连接发出，第二请求会被直接透传到主机明文
 * 代理（没有会话 cookie → 主机 401，relay 日志也看不到），表现为「配对后立刻 401，重试又能进」。
 * WebSocket Upgrade 请求不能改写（101 之后连接本来就要原样双向透传）。
 * @param {Buffer} head
 * @returns {Buffer}
 */
export function forceEdgeTunnelHead(head) {
  let upgrade = false;
  try {
    const parsed = parseHttpHead(head);
    upgrade = typeof parsed.headers.upgrade === 'string' && parsed.headers.upgrade !== '';
  } catch {
    return head;
  }
  if (upgrade) return head;
  const text = head.toString('latin1');
  const end = text.indexOf('\r\n\r\n');
  if (end < 0) return head;
  const lines = text.slice(0, end).split('\r\n');
  const filtered = lines.filter((line) => {
    const idx = line.indexOf(':');
    if (idx <= 0) return true;
    const name = line.slice(0, idx).trim().toLowerCase();
    return name !== 'connection' && name !== 'proxy-connection' && name !== 'keep-alive';
  });
  filtered.push('Connection: close');
  return Buffer.from(`${filtered.join('\r\n')}\r\n\r\n`, 'latin1');
}

/**
 * 创建并启动群体服务版 relay（A 模式）。
 * @param {object} options
 * @param {string} options.domain 根域名，如 relay.example.com
 * @param {object} options.group 群体版配置（必填 group.file；见 lib/config.js）
 * @param {number} [options.controlPort=8443] 控制面 WSS 端口；0 = 临时端口
 * @param {number} [options.httpPort=80] health 端口（GET/HEAD /healthz）；0 = 临时端口
 * @param {{certFile?: string, keyFile?: string, cert?: Buffer|string, key?: Buffer|string}} [options.tls]
 * @param {boolean} [options.dev=false] 允许无 TLS 的 ws:// 控制面（仅测试/开发）
 * @param {string} [options.listenHost='0.0.0.0'] 监听地址（旧名 dataHost 仍接受）
 * @param {{apnsClient?: any, now?: () => number,
 *   createApnsClient?: (options: object) => any}} [options.pushClients]
 *   仅测试注入：APNs 发送器替身（JSON 配置无法表达函数；生产不要设置）
 * @returns {Promise<{controlPort:number, httpPort:number, groupApiPort:number, groupAdminPort:number,
 *   edgePort:number, domain:string, dev:boolean, close:Function, health:Function, onlineHostIds:Function}>}
 */
export async function createRelay(options = {}) {
  const config = normalizeConfig(options);
  const relay = new Relay(config);
  return relay.start();
}

/**
 * startRelay 与 createRelay 等价，语义更贴近 CLI/config 文件入口：
 * 先校验配置（生产必须 TLS），再绑定各端口并返回实际端口。
 * @param {object} config
 */
export async function startRelay(config = {}) {
  return createRelay(config);
}
