import { readFileSync, rmSync, watchFile, unwatchFile } from 'node:fs';
import { hostname } from 'node:os';
import { X509Certificate } from 'node:crypto';
import { hostAddress, hostFqdn, loadConfig, pushProviderOf, saveConfig, validateConfig, validatePushConfig } from './config.js';
import { ensureDir, paths, readJson, writeJson } from './paths.js';
import { loadOrCreateDeviceCa, loadOrCreateDevServerCert, loadOrCreateHostIdentity } from './identity.js';
import { DeviceStore } from './devices.js';
import { AuditLog } from './audit.js';
import { PairingManager } from './pairing.js';
import { DshProxy } from './proxy.js';
import { RelayConnector } from './connector.js';
import { createRemoteServer } from './server.js';
import { createPushNotifier } from './push.js';
import { createApnsClient } from './apns.js';
import { checkTlsKeyPair } from './tls-check.js';
import { createHostRestartScheduler, requestHostRestart } from './host-restart.js';
import { GroupHostRuntime } from './group.js';

const VERSION = '0.1.18';

/** 主机插件的运行时装配：配置 → 身份/CA/设备/配对 → TLS 监听 + relay 连接。 */
export class RemoteService {
  /**
   * @param {object} ctx DSH 插件上下文
   * @param {{
   *   createApnsClient?: typeof createApnsClient,
   *   spawnHostRestart?: typeof import('node:child_process').spawn,
   *   hostRestartDedupeMs?: number,
   *   hostRestartEnv?: NodeJS.ProcessEnv,
   * }} [options] 测试注入用
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.createApnsClient = typeof options.createApnsClient === 'function' ? options.createApnsClient : createApnsClient;
    this.lastError = null;
    this.log = (message) => {
      try { console.log(`[dsh-remote] ${message}`); } catch { /* ignore */ }
    };
    // 远程「重启主机 DSH」：短窗口去重 + 可注入 spawn（测试绝不真的杀进程）。
    this.hostRestartScheduler = createHostRestartScheduler({
      windowMs: options.hostRestartDedupeMs,
      log: this.log,
      request: () => requestHostRestart({
        log: this.log,
        spawnImpl: options.spawnHostRestart,
        env: options.hostRestartEnv,
      }),
    });
    this.pushTokens = new Map();
    this.pushNotifier = createPushNotifier({
      getConfig: () => this.config ?? {},
      getConnector: () => this.connector,
      getApnsClient: () => this.apnsClient,
      getPushTokens: () => [...this.pushTokens.values()],
      onPushTokensInvalid: (entries) => this.#prunePushTokens(entries),
      audit: { append: (entry) => this.audit?.append(entry) },
      log: this.log,
    });
    if (typeof ctx.effect === 'function' && typeof ctx.on === 'function') {
      ctx.effect(() => ctx.on('session/event', (session, event) => {
        Promise.resolve(this.pushNotifier.onSessionEvent(session, event))
          .catch((error) => this.log(`push trigger failed: ${error?.message ?? error}`));
      }), 'dsh-remote-service: push triggers');
      ctx.effect(() => ctx.on('session/disposed', (session) => this.pushNotifier.reset(session?.id)), 'dsh-remote-service: push reset');
    }
    this.ready = this.#init().catch((error) => {
      this.lastError = error.message;
      this.log(`init failed: ${error.stack ?? error.message}`);
    });
  }

  async #init() {
    ensureDir(paths.dir());
    this.config = loadConfig();
    this.identity = loadOrCreateHostIdentity();
    this.ca = loadOrCreateDeviceCa();
    this.devices = new DeviceStore();
    // 设备配对/撤销后：群体模式立即把设备公钥同步给 relay（classic 模式下无 groupRuntime，空转）。
    this.devices.onChange = () => {
      try { this.groupRuntime?.syncDevices(); } catch { /* ignore */ }
    };
    this.audit = new AuditLog();
    const storedPush = readJson(paths.pushTokens(), { version: 1, tokens: [] });
    for (const entry of Array.isArray(storedPush.tokens) ? storedPush.tokens : []) {
      if (entry?.deviceId && entry?.token) {
        const record = {
          deviceId: String(entry.deviceId),
          provider: String(entry.provider ?? 'expo'),
          token: String(entry.token),
        };
        if (entry.environment === 'development' || entry.environment === 'production') record.environment = entry.environment;
        this.pushTokens.set(record.deviceId, record);
      }
    }
    this.pairing = new PairingManager({
      identity: this.identity,
      ca: this.ca,
      devices: this.devices,
      audit: this.audit,
      getConfig: () => this.config,
      // 群体模式：二维码用 v2（服务端下发的 hostId/relayDomain/mobilePort + auth=token）
      getGroupInfo: () => (this.config?.groupEnabled ? this.groupRuntime?.registrationInfo() : undefined),
      log: this.log,
    });
    this.proxy = new DshProxy({
      getUpstream: () => this.#upstream(),
      authenticatedUrl: () => this.#authenticatedUrl(),
      denyPrefixes: this.config.denyPrefixes,
      getMaxRequestBytes: () => this.config.maxRequestBytes,
      audit: this.audit,
      log: this.log,
    });
    await this.#apply();
  }

  /**
   * 群体服务版（A 模式）：注册到部署方 relay + loopback 明文代理 + 隧道连接。
   * 不启动主机 TLS 监听（relay 边缘终止 TLS），也不要求本地证书/APNs 配置。
   * @param {Record<string, any>} config
   */
  async #applyGroupMode(config) {
    this.groupRuntime = new GroupHostRuntime({
      config,
      devices: this.devices,
      proxy: this.proxy,
      pairing: this.pairing,
      audit: this.audit,
      log: this.log,
    });
    try {
      await this.groupRuntime.start();
      const status = this.groupRuntime.status();
      this.lastError = status.lastError;
      this.log(
        `group mode: ${status.registered ? `registered as ${status.hostId}` : 'not registered'}`
        + ` service=${status.serviceUrl || '-'} plain=127.0.0.1:${status.plainPort || '-'}`,
      );
    } catch (error) {
      this.lastError = `群体服务启动失败: ${error.message}`;
      this.log(this.lastError);
    }
  }

  #upstream() {
    const server = this.ctx.webServer;
    return {
      protocol: server?.protocol ?? 'http:',
      host: '127.0.0.1',
      port: Number(server?.port),
    };
  }

  #authenticatedUrl() {
    const origin = this.ctx.webServer.getOrigin();
    return this.ctx.connection.authenticatedUrl(origin);
  }

  async #apply() {
    await this.#stopRuntime();
    const config = this.config;
    this.#applyPush(config);
    if (!config.enabled) return;
    const errors = validateConfig(config);
    if (errors.length > 0) {
      this.lastError = errors.join('; ');
      return;
    }
    if (config.groupEnabled) {
      await this.#applyGroupMode(config);
      return;
    }
    let certPem;
    let keyPem;
    let certFile = config.tlsCertFile;
    let dev = false;
    let tlsError = null;
    if (config.tlsCertFile && config.tlsKeyFile) {
      try {
        certPem = readFileSync(config.tlsCertFile, 'utf8');
        keyPem = readFileSync(config.tlsKeyFile, 'utf8');
      } catch (error) {
        this.lastError = `TLS 证书读取失败: ${error.message}`;
        return;
      }
    } else {
      try {
        const devCert = loadOrCreateDevServerCert(hostFqdn(config));
        certPem = devCert.certPem;
        keyPem = devCert.keyPem;
        certFile = paths.devTlsCert();
        dev = true;
      } catch (error) {
        tlsError = error.message;
        this.lastError = `开发证书生成失败: ${error.message}`;
        return;
      }
    }
    // 配置级自检：证书/私钥不是一对、证书 SAN 不覆盖主机域名 ——
    // 这两类错误在 Node 里只会表现为晦涩的 TLS 错误或手机端「无法连接」，提前给出可读原因。
    // 注意：自签的开发证书（无 tlsCertFile 时生成）同样走这里。
    const fqdn = hostFqdn(config);
    const tlsCheck = checkTlsKeyPair({ certPem, keyPem, fqdn });
    if (tlsCheck.error) {
      // 清掉上一次成功启动的 tlsInfo，避免热加载失败后状态页仍显示旧证书「有效」
      this.tlsInfo = undefined;
      this.lastError = tlsCheck.error;
      return;
    }
    const certInfo = inspectCert(certPem);
    this.tlsInfo = {
      certFile,
      dev,
      fqdn,
      keyMatch: true,
      hostnameOk: tlsCheck.warnings.length === 0,
      ...certInfo,
    };
    try {
      const runtime = createRemoteServer({
        certPem,
        keyPem,
        caCertPem: this.ca.certPem,
        devices: this.devices,
        pairing: this.pairing,
        proxy: this.proxy,
        audit: this.audit,
        getConfig: () => this.config,
        savePushToken: (entry) => this.#savePushToken(entry),
        restartHost: (request) => this.#restartHost(request),
        getStatus: () => ({
          tls: this.tlsInfo
            ? {
                subject: this.tlsInfo.subject,
                notAfter: this.tlsInfo.notAfter,
                dev: this.tlsInfo.dev,
                valid: this.tlsInfo.valid,
              }
            : null,
          relayConnected: Boolean(this.connector?.isConnected()),
          version: VERSION,
        }),
        log: this.log,
      });
      this.listener = runtime;
      const address = await runtime.listen(Number(config.listenPort) || 0, '127.0.0.1');
      this.listenPort = address.port;
    } catch (error) {
      this.lastError = `远程 TLS 监听启动失败: ${error.message}`;
      await this.#stopRuntime();
      return;
    }
    this.connector = new RelayConnector({
      relayUrl: config.relayUrl,
      hostId: config.hostId,
      hostToken: config.hostToken,
      hostName: config.hostName || hostname(),
      getLocalPort: () => this.listenPort,
      relayTlsInsecure: Boolean(config.relayTlsInsecure),
      audit: this.audit,
      log: this.log,
    });
    this.connector.start();
    for (const entry of this.pushTokens.values()) {
      if (entry.provider === 'expo') {
        this.connector.registerPushToken({ deviceId: entry.deviceId, provider: entry.provider, token: entry.token });
      }
    }
    this.lastError = [tlsError, ...tlsCheck.warnings].filter(Boolean).join('; ') || null;
    if (tlsCheck.warnings.length > 0) this.log(`TLS 证书告警: ${tlsCheck.warnings.join('; ')}`);
    this.log(`remote server on 127.0.0.1:${this.listenPort}${dev ? ' (dev self-signed TLS)' : ''}`);
    this.#watchCertFiles(config);
  }

  /**
   * 远程「重启主机 DSH」：去重后调度 detached helper 杀进程并重新拉起。
   *
   * 只做调度，不自己动手杀进程；实际重启由 lib/host-restart.js 的 helper 在 ~1s 后完成，
   * 这样 HTTP 202 能先发回手机。审计由 server.js 的 /__dsh_remote/restart 路由统一写
   * （每请求一条 accepted/failed，去重命中标 hash=deduped），这里只记日志，避免重复条目。
   *
   * @param {{device?: {id?: string}}} [request] server.js 传入的请求上下文
   * @returns {{mode: string, deduped: boolean}}
   */
  #restartHost(request = {}) {
    const deviceId = request?.device?.id ?? 'unknown';
    if (this.config?.restartHostEnabled !== true) {
      // 组件被用户关闭：即使绕过 UI 直接调用接口也必须拒绝（server.js 路由也会先拦一道）。
      throw Object.assign(new Error('远程重启已在「设置 → 远程访问 → 组件」中关闭'), {
        status: 501,
        code: 'host-restart-disabled',
      });
    }
    try {
      const result = this.hostRestartScheduler.request();
      if (result.deduped) {
        this.log(`host-restart: 忽略 ${this.hostRestartScheduler.windowMs}ms 内的重复请求（device=${deviceId}, mode=${result.mode}）`);
      } else {
        this.log(`host-restart: 已安排重启（device=${deviceId}, mode=${result.mode}），DSH 将在约 1s 后退出并重新拉起`);
      }
      return result;
    } catch (error) {
      this.log(`host-restart: 调度失败（device=${deviceId}）: ${error?.message ?? error}`);
      throw error;
    }
  }

  /**
   * 撤销设备后立即断开其活跃连接（远端 tunnel API 与本地管理 API 共用）。
   * @param {string} deviceId
   * @returns {number}
   */
  disconnectDevice(deviceId) {
    if (!this.listener || typeof this.listener.disconnectDevice !== 'function') return 0;
    const device = this.devices.get(deviceId);
    if (!device) return 0;
    return this.listener.disconnectDevice(device.serial);
  }

  /**
   * 删除一条**已撤销**设备记录（桌面设备列表清理）。
   * 仍有效的设备必须先撤销再删除，避免误删正在使用的设备。
   * @param {string} deviceId
   * @returns {{device: object}}
   */
  deleteDevice(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) {
      const error = new Error('设备不存在');
      error.status = 404;
      error.code = 'device-not-found';
      throw error;
    }
    if (!device.revokedAt) {
      const error = new Error('请先撤销设备，再删除记录');
      error.status = 409;
      error.code = 'device-active';
      throw error;
    }
    const removed = this.devices.remove(device.id);
    if (removed && this.pushTokens.has(removed.id)) {
      this.pushTokens.delete(removed.id);
      this.#persistPushTokens();
    }
    this.audit.append({ deviceId: removed?.id ?? device.id, action: 'device-delete', result: 'ok' });
    return { device: removed ?? device };
  }

  /**
   * 手动/监听触发的证书热加载：重新执行 listen 配置（含 TLS 证书、connector）。
   * 供 acme.sh/certbot 覆盖文件后的 watcher 与运维脚本调用。
   */
  async reloadTls() {
    await this.#apply();
    return this.status();
  }

  /** B2 生产证书续期：acme.sh/certbot 覆盖 cert/key 后自动重建 TLS 监听。 */
  #watchCertFiles(config) {
    this.#unwatchCertFiles();
    if (!config.tlsCertFile || !config.tlsKeyFile) return;
    const files = [config.tlsCertFile, config.tlsKeyFile];
    let timer;
    const handler = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        this.log('TLS 证书文件已更新，重新加载远程监听');
        this.reloadTls().catch((error) => this.log(`cert reload failed: ${error.message}`));
      }, 2000);
      timer.unref?.();
    };
    for (const file of files) watchFile(file, { interval: 60_000 }, handler);
    this.certWatchers = { files, handler, timer: () => timer };
  }

  #unwatchCertFiles() {
    if (!this.certWatchers) return;
    const { files, handler, timer } = this.certWatchers;
    clearTimeout(timer());
    for (const file of files) unwatchFile(file, handler);
    this.certWatchers = undefined;
  }

  async #stopRuntime() {
    this.#unwatchCertFiles();
    const groupRuntime = this.groupRuntime;
    this.groupRuntime = undefined;
    if (groupRuntime) {
      try { await groupRuntime.stop(); } catch { /* ignore */ }
    }
    this.connector?.stop();
    this.connector = undefined;
    const listener = this.listener;
    this.listener = undefined;
    this.listenPort = 0;
    if (listener) {
      try { await listener.close(); } catch { /* ignore */ }
    }
  }

  /** 推送配置变化后重建 APNs 发送器（私钥只在构造时读取一次）。 */
  #applyPush(config) {
    this.apnsClient = undefined;
    if (pushProviderOf(config) !== 'apns') return;
    try {
      this.apnsClient = this.createApnsClient({
        keyFile: config.apnsKeyFile,
        keyId: config.apnsKeyId,
        teamId: config.apnsTeamId,
        topic: config.apnsTopic,
        environment: config.apnsEnvironment,
      });
      if (this.apnsClient?.error) this.log(`APNs 推送未就绪：${this.apnsClient.error}`);
    } catch (error) {
      this.log(`APNs 推送初始化失败：${error?.message ?? error}`);
      this.apnsClient = undefined;
    }
  }

  /**
   * 保存设备推送 token。
   * 每个设备只保留最新一条（切换通道时不会残留旧 provider 的 token）；
   * APNs token 只留在本机；expo token 兼容旧版才转给 relay。
   * @param {{deviceId: string, provider?: string, token: string, environment?: string}} entry
   */
  #savePushToken(entry) {
    const deviceId = String(entry.deviceId);
    /** @type {{deviceId: string, provider: string, token: string, environment?: string, updatedAt: number}} */
    const record = {
      deviceId,
      provider: String(entry.provider ?? 'expo'),
      token: String(entry.token),
      updatedAt: Date.now(),
    };
    if (entry.environment === 'development' || entry.environment === 'production') record.environment = entry.environment;
    this.pushTokens.set(deviceId, record);
    if (record.provider === 'expo') {
      this.connector?.registerPushToken({ deviceId: record.deviceId, provider: record.provider, token: record.token });
    }
    this.#persistPushTokens();
  }

  /** 落盘 push-tokens.json（0600，最多保留 100 条）。 */
  #persistPushTokens() {
    writeJson(paths.pushTokens(), { version: 1, tokens: [...this.pushTokens.values()].slice(-100) });
  }

  /**
   * APNs 返回 410 / Unregistered 时清理失效 token，避免持续发送。
   *
   * 入参是**实际发送失败的那个 token**（`{deviceId, token}`）。只有当前存储的 token
   * 与失败 token 完全一致时才删除：发送在途期间设备可能已重新注册/轮换 token，
   * 此时删掉会把新 token 误清（旧 token 的 410 与新 token 无关）。
   *
   * @param {Array<{deviceId?: string, token?: string}>} entries
   * @returns {number} 清理条数
   */
  #prunePushTokens(entries) {
    let removed = 0;
    for (const entry of Array.isArray(entries) ? entries : []) {
      const deviceId = String(entry?.deviceId ?? '');
      const token = typeof entry?.token === 'string' ? entry.token : '';
      if (deviceId === '' || token === '') continue;
      const current = this.pushTokens.get(deviceId);
      if (!current || current.token !== token) continue;
      this.pushTokens.delete(deviceId);
      removed += 1;
      this.audit?.append({ deviceId, action: 'push-token-pruned', result: 'ok' });
    }
    if (removed > 0) {
      this.#persistPushTokens();
      this.log(`push: 已清理 ${removed} 个失效设备 token`);
    }
    return removed;
  }

  /**
   * 群体服务版：用「服务地址 + 邀请码」注册并连接（管理 API 调用）。
   * @param {{serviceUrl?: string, inviteCode?: string, hostName?: string}} input
   */
  async registerGroup(input = {}) {
    const serviceUrl = String(input.serviceUrl ?? this.config?.groupServiceUrl ?? '').trim();
    const inviteCode = String(input.inviteCode ?? '').trim();
    if (serviceUrl === '') throw Object.assign(new Error('服务地址不能为空'), { status: 400, code: 'invalid-service-url' });
    if (inviteCode === '') throw Object.assign(new Error('邀请码不能为空'), { status: 400, code: 'invalid-invite' });
    this.config = saveConfig({
      enabled: true,
      groupEnabled: true,
      groupServiceUrl: serviceUrl,
      groupInviteCode: inviteCode,
      ...(String(input.hostName ?? '').trim() !== '' ? { hostName: String(input.hostName).trim() } : {}),
    });
    await this.#apply();
    if (!this.groupRuntime?.status().registered) {
      throw Object.assign(new Error(this.lastError || '注册失败'), { status: 400, code: 'group-register-failed' });
    }
    // 邀请码一次性：注册成功后立即清空，避免留存在配置里。
    this.config = saveConfig({ groupInviteCode: '' });
    this.audit?.append({ action: 'group-register', result: 'ok', hostId: this.groupRuntime.status().hostId });
    return this.status();
  }

  /** 群体服务版：停止并清除本机注册（换服务/重置邀请码时用）。 */
  async resetGroup() {
    try { rmSync(paths.groupRegistration(), { force: true }); } catch { /* ignore */ }
    this.config = saveConfig({ groupEnabled: false, groupInviteCode: '' });
    await this.#apply();
    this.audit?.append({ action: 'group-reset', result: 'ok' });
    return this.status();
  }

  /** 群体服务版：重试控制面隧道（不重置注册、不消耗邀请码）。 */
  async retryGroup() {
    const info = this.groupRuntime?.status();
    if (!info?.registered) {
      throw Object.assign(new Error('尚未注册服务，无法重试连接'), { status: 409, code: 'group-not-registered' });
    }
    await this.groupRuntime.reconnect();
    this.audit?.append({ action: 'group-retry', result: 'ok' });
    return this.status();
  }

  /** 返回当前状态（管理 API）。 */
  status() {
    const config = this.config ?? loadConfig();
    const tls = this.tlsInfo ?? {};
    return {
      version: VERSION,
      enabled: Boolean(config.enabled),
      relay: {
        url: config.relayUrl,
        connected: Boolean(this.connector?.isConnected()),
        lastError: this.connector?.lastError ?? this.lastError,
      },
      host: {
        id: config.hostId,
        name: config.hostName || hostname(),
        fingerprint: this.identity?.fingerprint ?? '',
        publicKey: this.identity?.publicKeyDerB64 ?? '',
        domain: hostFqdn(config),
        address: hostAddress(config),
        tls: {
          certFile: tls.certFile ?? config.tlsCertFile ?? '',
          subject: tls.subject ?? '',
          notAfter: tls.notAfter ?? null,
          valid: Boolean(tls.valid),
          dev: Boolean(tls.dev),
        },
      },
      pairing: this.pairing?.publicSession() ?? { active: false },
      // 「重启主机」组件状态（App 据此决定是否显示顶栏 ⏻；默认关闭）
      restart: { enabled: Boolean(config.restartHostEnabled) },
      devices: this.devices?.list() ?? [],
      listenPort: this.listenPort || null,
      // 群体服务版（A 模式）状态；classic 模式下 registered=false
      group: this.groupRuntime?.status() ?? {
        registered: false,
        serviceUrl: config.groupServiceUrl ?? '',
        hostId: '',
        relayDomain: '',
        mobilePort: 0,
        connected: false,
        plainPort: 0,
      },
      push: {
        provider: pushProviderOf(config),
        enabled: config.pushEnabled !== false,
        configured: pushProviderOf(config) === 'apns'
          ? Boolean(this.apnsClient?.isConfigured?.())
          : Boolean(this.connector?.isConnected?.()),
        tokens: this.pushTokens.size,
        error: this.apnsClient?.error ?? null,
        warnings: validatePushConfig(config),
      },
      // 管理 UI 需要读取的配置子集（密钥类字段只回布尔，不回明文）
      config: {
        enabled: Boolean(config.enabled),
        relayUrl: config.relayUrl ?? '',
        relayDomain: config.relayDomain ?? '',
        hostId: config.hostId ?? '',
        publicPort: Number(config.publicPort ?? 0),
        hostName: config.hostName ?? '',
        requireApproval: Boolean(config.requireApproval),
        restartHostEnabled: Boolean(config.restartHostEnabled),
        pushEnabled: config.pushEnabled !== false,
        pushCooldownSeconds: Number(config.pushCooldownSeconds ?? 30),
        pushProvider: pushProviderOf(config),
        apnsKeyFile: config.apnsKeyFile ?? '',
        apnsKeyId: config.apnsKeyId ?? '',
        apnsTeamId: config.apnsTeamId ?? '',
        apnsTopic: config.apnsTopic ?? '',
        apnsEnvironment: config.apnsEnvironment ?? 'auto',
        maxRequestBytes: Number(config.maxRequestBytes ?? 0),
        relayTlsInsecure: Boolean(config.relayTlsInsecure),
        groupEnabled: Boolean(config.groupEnabled),
        groupServiceUrl: config.groupServiceUrl ?? '',
        groupPlainPort: Number(config.groupPlainPort ?? 0),
        groupInsecure: Boolean(config.groupInsecure),
        listenPort: config.listenPort ?? 0,
        tlsCertFile: config.tlsCertFile ? 'configured' : '',
        tlsKeyFileConfigured: Boolean(config.tlsKeyFile),
        hostTokenConfigured: Boolean(config.hostToken),
        denyPrefixes: Array.isArray(config.denyPrefixes) ? config.denyPrefixes : [],
      },
    };
  }

  async updateConfig(patch) {
    this.config = saveConfig(patch);
    await this.#apply();
    return { config: this.config, errors: validateConfig(this.config) };
  }

  async dispose() {
    await this.#stopRuntime();
  }
}

function inspectCert(pem) {
  try {
    const cert = new X509Certificate(pem);
    return {
      valid: Date.parse(cert.validTo) > Date.now(),
      subject: cert.subject,
      notAfter: new Date(cert.validTo).toISOString(),
    };
  } catch {
    return { valid: false, subject: '', notAfter: null };
  }
}
