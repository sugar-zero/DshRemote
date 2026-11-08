import net from 'node:net';
import {
  CONTROL_PATH,
  FRAME_TYPE,
  PROTOCOL_VERSION,
  RELAY_MSG,
  decodeFrame,
  encodeFrame,
} from 'dsh-remote-protocol';

/** 主机→relay 方向 WS 发送队列水位：超过就暂停本地 socket 读取，防止无限堆积。 */
const SEND_HIGH_WATER_BYTES = 2 * 1024 * 1024;
const SEND_LOW_WATER_BYTES = 512 * 1024;

/**
 * 主机 → relay 主动外联连接器（无入站端口）。
 * - JSON text frame 走控制面（hello/heartbeat/host.open/host.opened/host.close）
 * - 二进制 frame 走数据面（encodeFrame/decodeFrame）
 * - 群体版推送控制消息（push.register / push.registered / push.send / push.result）：
 *   主机只上报 device token 与推送意图，不持有 Apple 凭据；token 只在内存中，重连后自动重登记。
 */
export class RelayConnector {
  constructor({
    relayUrl, hostId, hostToken, hostName, getLocalPort, relayTlsInsecure = false, audit, log = () => {}, onReady,
    onPushRegistered, onPushResult,
    /** `push.register` 等 `push.registered` 的超时（毫秒）；超时由上层回可重试错误。 */
    pushRegisterTimeoutMs = 5000,
    /** `push.send` 等 `push.result` 的超时（毫秒）；契约 §4.2：超时只记日志、不重发。 */
    pushIntentTimeoutMs = 15_000,
  }) {
    this.relayUrl = relayUrl;
    this.hostId = hostId;
    this.hostToken = hostToken;
    this.hostName = hostName;
    this.getLocalPort = getLocalPort;
    this.relayTlsInsecure = relayTlsInsecure;
    this.audit = audit;
    this.log = log;
    this.onReady = typeof onReady === 'function' ? onReady : undefined;
    this.onPushRegistered = typeof onPushRegistered === 'function' ? onPushRegistered : undefined;
    this.onPushResult = typeof onPushResult === 'function' ? onPushResult : undefined;
    this.pushRegisterTimeoutMs = Number(pushRegisterTimeoutMs) > 0 ? Number(pushRegisterTimeoutMs) : 5000;
    this.pushIntentTimeoutMs = Number(pushIntentTimeoutMs) > 0 ? Number(pushIntentTimeoutMs) : 15_000;
    /**
     * 已成功登记（或本连接周期内登记成功）的设备 token；重连 ready 后自动补发。
     * 只存内存、只用于控制消息，不落盘、不进日志/状态明文。
     * @type {Map<string, {deviceId: string, provider: string, token: string, environment: string}>}
     */
    this.pushTokens = new Map();
    /** @type {Map<string, {resolve: (result: any) => void, timer: any, record: any}>} 等待 push.registered 的请求 */
    this.pendingPushRegistrations = new Map();
    /** @type {Map<string, {timer: any, kind: string}>} 等待 push.result 的意图（超时只记日志） */
    this.pendingPushIntents = new Map();
    this.ws = undefined;
    this.connected = false;
    this.lastError = null;
    this.streams = new Map();
    this.closed = false;
    this.retryMs = 1000;
    this.heartbeatTimer = undefined;
    this.retryTimer = undefined;
    /** @type {Array<{ frame: Buffer, socket: import('node:net').Socket | undefined }>} 有序待发队列 */
    this.sendQueue = [];
    this.sendQueueBytes = 0;
    this.flushScheduled = false;
    this.flushTimer = undefined;
    /** @type {Set<import('node:net').Socket>} 因发送队列过高而被暂停的本地 socket */
    this.pausedSockets = new Set();
  }

  controlUrl() {
    const url = new URL(this.relayUrl);
    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (url.protocol === 'http:') url.protocol = 'ws:';
    url.pathname = CONTROL_PATH;
    url.search = '';
    return url.href;
  }

  start() {
    this.closed = false;
    this.#connect();
  }

  stop() {
    this.closed = true;
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.retryTimer);
    this.#clearPushWaiters();
    this.#resetSendQueue();
    this.#closeAllStreams('connector-stopped');
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = undefined;
    this.connected = false;
  }

  isConnected() {
    return this.connected;
  }

  /**
   * 群体版：把设备 APNs token 上报 relay（`push.register`），等 `push.registered` 回执。
   *
   * - 只在已连接时发送；未连接/超时返回可读错误（上层转成 503，App 稍后重试）；
   * - 成功后才把 token 记入内存缓存（重连 ready 时自动补发），避免“未登记成功也被自动上报”；
   * - token 只走控制消息与内存 Map，不进日志/状态明文。
   *
   * @param {{deviceId: string, provider: string, token: string, environment: string}} entry
   * @param {{timeoutMs?: number}} [options]
   * @returns {Promise<{ok: true, mode: string, enabled: boolean} | {ok: false, code: string, message?: string}>}
   */
  registerPushToken(entry, options = {}) {
    const deviceId = String(entry?.deviceId ?? '');
    const provider = String(entry?.provider ?? '');
    const token = String(entry?.token ?? '');
    const environment = String(entry?.environment ?? '');
    if (deviceId === '' || provider === '' || token === '' || environment === '') {
      return Promise.resolve({ ok: false, code: 'invalid_push_token' });
    }
    if (!this.connected || this.ws?.readyState !== 1) {
      return Promise.resolve({ ok: false, code: 'not_connected' });
    }
    const record = { deviceId, provider, token, environment };
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : this.pushRegisterTimeoutMs;
    return new Promise((resolve) => {
      // 同一 deviceId 并发登记：旧请求直接失败，避免悬挂等待。
      const previous = this.pendingPushRegistrations.get(deviceId);
      if (previous) {
        clearTimeout(previous.timer);
        previous.resolve({ ok: false, code: 'superseded' });
      }
      const finish = (result) => resolve(result);
      const timer = setTimeout(() => {
        this.pendingPushRegistrations.delete(deviceId);
        this.log(`push.register timeout: device=${deviceId}（${timeoutMs}ms 内未收到 push.registered，App 可稍后重试）`);
        finish({ ok: false, code: 'timeout' });
      }, timeoutMs);
      timer.unref?.();
      this.pendingPushRegistrations.set(deviceId, { resolve: finish, timer, record });
      this.#send({ t: RELAY_MSG.PUSH_REGISTER, ...record });
    });
  }

  /**
   * R2：设备改走 official（官方 hub 直连）后，不再把它的 token 补报给 relay。
   * 只清本机缓存；relay 侧旧 token 由 relay 在设备撤销/host 撤销/重启时清理（relay 无单设备反注册消息）。
   * @param {string} deviceId
   */
  removePushToken(deviceId) {
    const id = String(deviceId ?? '');
    if (id !== '') this.pushTokens.delete(id);
  }

  /**
   * 群体版：发送一条推送意图（`push.send`）。不等待回执：
   * `push.result` 到达时交给 `onPushResult`（上层只记日志/审计）；超时只记日志、不重发。
   *
   * @param {{id: string, kind: string, title?: string, body?: string, sessionId?: string}} intent
   * @returns {boolean} 是否已写入控制连接
   */
  sendPushIntent(intent) {
    const id = String(intent?.id ?? '');
    const kind = String(intent?.kind ?? '');
    if (id === '' || kind === '' || !this.connected || this.ws?.readyState !== 1) return false;
    const message = { t: RELAY_MSG.PUSH_SEND, id, kind };
    if (typeof intent.title === 'string' && intent.title !== '') message.title = intent.title;
    if (typeof intent.body === 'string' && intent.body !== '') message.body = intent.body;
    if (typeof intent.sessionId === 'string' && intent.sessionId !== '') message.sessionId = intent.sessionId;
    const previous = this.pendingPushIntents.get(id);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => {
      this.pendingPushIntents.delete(id);
      this.log(`push.send ${kind} id=${id} ${this.pushIntentTimeoutMs}ms 未收到 push.result（只记日志，不重发以免重复通知）`);
    }, this.pushIntentTimeoutMs);
    timer.unref?.();
    this.pendingPushIntents.set(id, { timer, kind });
    this.#send(message);
    return true;
  }

  /** 清空等待中的推送请求（断开/停止时调用；登记等待者收到可重试错误，不悬挂）。 */
  #clearPushWaiters() {
    for (const [, pending] of this.pendingPushRegistrations) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, code: 'not_connected' });
    }
    this.pendingPushRegistrations.clear();
    for (const [, pending] of this.pendingPushIntents) clearTimeout(pending.timer);
    this.pendingPushIntents.clear();
  }

  /**
   * 群体版：把本机设备列表（deviceId + P-256 公钥）全量同步给 relay。
   * 仅在已连接时发送；连接建立时由 onReady 回调触发。
   * @param {Array<{deviceId: string, publicKey: string}>} devices
   */
  syncGroupDevices(devices) {
    if (!this.connected) return false;
    this.#send({ t: RELAY_MSG.DEVICE_SYNC, devices: Array.isArray(devices) ? devices : [] });
    return true;
  }

  #scheduleReconnect() {
    if (this.closed) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.#connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
  }

  #connect() {
    if (this.closed) return;
    const url = this.controlUrl();
    this.log(`connecting to relay ${url}`);
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      this.lastError = error.message;
      this.#scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => {
      this.log('relay control socket open');
      ws.send(JSON.stringify({
        t: RELAY_MSG.HOST_HELLO,
        protocolVersion: PROTOCOL_VERSION,
        hostId: this.hostId,
        token: this.hostToken,
        hostName: this.hostName,
      }));
    });
    ws.addEventListener('message', (event) => {
      const data = event.data;
      if (typeof data === 'string') {
        this.#onControlMessage(data);
      } else if (data instanceof ArrayBuffer) {
        this.#onBinary(Buffer.from(data));
      } else if (ArrayBuffer.isView(data)) {
        this.#onBinary(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      }
    });
    ws.addEventListener('error', () => {
      this.lastError = 'relay control socket error';
    });
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.connected = false;
      clearInterval(this.heartbeatTimer);
      this.#clearPushWaiters();
      this.#resetSendQueue();
      this.#closeAllStreams('relay-disconnected');
      if (!this.closed) this.#scheduleReconnect();
    });
  }

  #onControlMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.t === RELAY_MSG.HOST_READY) {
      this.connected = true;
      this.lastError = null;
      this.retryMs = 1000;
      this.log(`relay ready: ${msg.hostname ?? this.hostId}`);
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => this.#send({ t: RELAY_MSG.HOST_HEARTBEAT }), 10_000);
      // 重连后把已登记过的 device token 重新上报（relay 重启会丢内存 token 表）。
      for (const entry of this.pushTokens.values()) {
        this.#send({ t: RELAY_MSG.PUSH_REGISTER, ...entry });
      }
      try {
        this.onReady?.();
      } catch (error) {
        this.log(`onReady failed: ${error && error.message ? error.message : String(error)}`);
      }
      return;
    }
    if (msg.t === RELAY_MSG.ERROR) {
      this.lastError = `${msg.code}: ${msg.message}`;
      this.log(`relay error: ${this.lastError}`);
      return;
    }
    if (msg.t === RELAY_MSG.HOST_OPEN) {
      this.#openStream(msg.streamId, msg.sni);
      return;
    }
    if (msg.t === RELAY_MSG.PUSH_REGISTERED) {
      const deviceId = String(msg.deviceId ?? '');
      const pending = this.pendingPushRegistrations.get(deviceId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingPushRegistrations.delete(deviceId);
        if (msg.ok === true) {
          // 只有登记成功的 token 才进缓存（重连后自动补报）；失败/被拒的一律丢弃。
          this.pushTokens.set(deviceId, { ...pending.record });
          pending.resolve({
            ok: true,
            mode: String(msg.mode ?? ''),
            enabled: msg.enabled === true,
          });
        } else {
          this.pushTokens.delete(deviceId);
          pending.resolve({
            ok: false,
            code: String(msg.code ?? 'internal'),
            message: msg.message === undefined ? '' : String(msg.message),
          });
        }
      } else if (msg.ok !== true) {
        // 非本连接发起的登记失败（例如重连补报被拒）：只清本地缓存，不影响其它请求。
        this.pushTokens.delete(deviceId);
      }
      try {
        this.onPushRegistered?.(msg);
      } catch (error) {
        this.log(`onPushRegistered failed: ${error?.message ?? error}`);
      }
      return;
    }
    if (msg.t === RELAY_MSG.PUSH_RESULT) {
      const id = String(msg.id ?? '');
      const pending = this.pendingPushIntents.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingPushIntents.delete(id);
      }
      this.audit?.append({
        action: 'push-result',
        result: msg.ok === true ? 'ok' : 'failed',
        hash: msg.ok === true ? String(msg.skipped ?? 'delivered') : String(msg.code ?? 'internal'),
      });
      if (msg.ok === true) {
        this.log(`push.result id=${id} ok delivered=${Number(msg.delivered ?? 0)} failed=${Number(msg.failed ?? 0)} skipped=${String(msg.skipped ?? '')} pruned=${Array.isArray(msg.pruned) ? msg.pruned.length : 0}`);
      } else {
        this.log(`push.result id=${id} failed code=${String(msg.code ?? 'internal')} message=${String(msg.message ?? '')}（只记日志，不重发）`);
      }
      try {
        this.onPushResult?.(msg);
      } catch (error) {
        this.log(`onPushResult failed: ${error?.message ?? error}`);
      }
      return;
    }
    if (msg.t === RELAY_MSG.HOST_CLOSE) {
      const stream = this.streams.get(msg.streamId);
      if (stream) {
        stream.socket.destroy();
        this.streams.delete(msg.streamId);
      }
    }
  }

  #openStream(streamId, sni) {
    if (this.streams.has(streamId)) return;
    let socket;
    try {
      socket = net.connect({ host: '127.0.0.1', port: this.getLocalPort() });
    } catch (error) {
      this.#send({ t: RELAY_MSG.ERROR, code: 'local-connect', message: error.message, streamId });
      return;
    }
    const stream = { socket, sni };
    this.streams.set(streamId, stream);
    socket.setNoDelay(true);
    socket.once('connect', () => {
      this.#send({ t: RELAY_MSG.HOST_OPENED, streamId });
    });
    socket.on('data', (chunk) => {
      this.#sendBinary(encodeFrame(FRAME_TYPE.DATA, streamId, chunk), socket);
    });
    socket.on('error', () => {
      this.#sendBinary(encodeFrame(FRAME_TYPE.CLOSE, streamId));
      socket.destroy();
      this.streams.delete(streamId);
    });
    socket.on('close', () => {
      this.#sendBinary(encodeFrame(FRAME_TYPE.CLOSE, streamId));
      this.streams.delete(streamId);
    });
  }

  #onBinary(buffer) {
    const frame = decodeFrame(buffer);
    if (!frame) return;
    const stream = this.streams.get(frame.streamId);
    if (!stream) return;
    if (frame.type === FRAME_TYPE.DATA) {
      const ok = stream.socket.write(frame.payload);
      if (!ok) {
        stream.socket.pause();
        stream.socket.once('drain', () => stream.socket.resume());
      }
    } else if (frame.type === FRAME_TYPE.CLOSE) {
      stream.socket.end();
      this.streams.delete(frame.streamId);
    }
  }

  #closeAllStreams(reason) {
    for (const [, stream] of this.streams) {
      stream.socket.destroy();
    }
    this.streams.clear();
    if (reason === 'relay-disconnected') this.audit?.append({ action: 'relay-disconnect', result: reason });
  }

  #send(message) {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * 发送一条二进制帧（数据/CLOSE），**严格保序**。
   *
   * 旧实现遇到 `bufferedAmount > 2MiB` 时会把当前帧 setTimeout 延后重发，
   * 而更晚到达的帧可能先发出去 —— 帧顺序被打乱 = TLS 密文字节乱序，
   * 慢速链路上大 payload（会话历史快照）会因此把整条隧道搞坏。
   * 现在统一走有序队列：只按 FIFO 出队；队列积压时暂停对应本地 socket，
   * 水位回落后再恢复，既保序也不会无限占内存。
   *
   * @param {Buffer} buffer 已编码的流帧
   * @param {import('node:net').Socket} [sourceSocket] 该帧来源的本地 socket（可选，用于背压）
   */
  #sendBinary(buffer, sourceSocket) {
    if (this.ws?.readyState !== 1) return;
    this.sendQueue.push({ frame: buffer, socket: sourceSocket });
    this.sendQueueBytes += buffer.length;
    if (sourceSocket !== undefined && this.sendQueueBytes > SEND_HIGH_WATER_BYTES) {
      this.#pauseSource(sourceSocket);
    }
    this.#flushSendQueue();
  }

  /** 队列积压时暂停本地 socket 读取（避免内存无限增长）。 */
  #pauseSource(socket) {
    if (!socket || socket.destroyed || socket.isPaused()) return;
    try {
      socket.pause();
      this.pausedSockets.add(socket);
    } catch { /* ignore */ }
  }

  /** 水位回落后恢复被暂停的本地 socket。 */
  #resumePausedSockets() {
    if (this.pausedSockets.size === 0) return;
    for (const socket of this.pausedSockets) {
      if (!socket.destroyed) {
        try { socket.resume(); } catch { /* ignore */ }
      }
    }
    this.pausedSockets.clear();
  }

  /** 连接断开/停止时清空发送队列与定时器（本地 socket 由 #closeAllStreams 处理）。 */
  #resetSendQueue() {
    this.sendQueue = [];
    this.sendQueueBytes = 0;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.flushScheduled = false;
    this.#resumePausedSockets();
  }

  /** 按 FIFO 发送队列头部帧，受 WS 缓冲水位与回调驱动；绝不乱序、绝不丢帧。 */
  #flushSendQueue() {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      const ws = this.ws;
      if (!ws || ws.readyState !== 1) return;
      while (this.sendQueue.length > 0 && ws.bufferedAmount < SEND_HIGH_WATER_BYTES) {
        const entry = this.sendQueue.shift();
        if (entry === undefined) break;
        this.sendQueueBytes -= entry.frame.length;
        try {
          ws.send(new Uint8Array(entry.frame), { binary: true }, (error) => {
            if (error) this.log(`relay binary send failed: ${error.message}`);
            if (this.sendQueue.length > 0) this.#flushSendQueue();
          });
        } catch (error) {
          this.log(`relay binary send threw: ${error?.message ?? error}`);
          this.sendQueue.length = 0;
          this.sendQueueBytes = 0;
          break;
        }
        if (ws.bufferedAmount >= SEND_HIGH_WATER_BYTES) break;
      }
      if (this.sendQueue.length > 0) {
        if (this.flushTimer === undefined) {
          this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            this.#flushSendQueue();
          }, 10);
          this.flushTimer.unref?.();
        }
        return;
      }
      if (this.sendQueueBytes <= SEND_LOW_WATER_BYTES) this.#resumePausedSockets();
    });
  }
}
