import { readFileSync, watchFile, unwatchFile } from 'node:fs';
import { hostname } from 'node:os';
import { X509Certificate } from 'node:crypto';
import { hostAddress, hostFqdn, loadConfig, saveConfig, validateConfig } from './config.js';
import { ensureDir, paths, readJson, writeJson } from './paths.js';
import { loadOrCreateDeviceCa, loadOrCreateDevServerCert, loadOrCreateHostIdentity } from './identity.js';
import { DeviceStore } from './devices.js';
import { AuditLog } from './audit.js';
import { PairingManager } from './pairing.js';
import { DshProxy } from './proxy.js';
import { RelayConnector } from './connector.js';
import { createRemoteServer } from './server.js';
import { createPushNotifier } from './push.js';

const VERSION = '0.1.0';

/** 主机插件的运行时装配：配置 → 身份/CA/设备/配对 → TLS 监听 + relay 连接。 */
export class RemoteService {
  constructor(ctx) {
    this.ctx = ctx;
    this.lastError = null;
    this.log = (message) => {
      try { console.log(`[dsh-remote] ${message}`); } catch { /* ignore */ }
    };
    this.pushTokens = new Map();
    this.pushNotifier = createPushNotifier({
      getConfig: () => this.config ?? {},
      getConnector: () => this.connector,
      audit: { append: (entry) => this.audit?.append(entry) },
      log: this.log,
    });
    if (typeof ctx.effect === 'function' && typeof ctx.on === 'function') {
      ctx.effect(() => ctx.on('session/event', (session, event) => this.pushNotifier.onSessionEvent(session, event)), 'dsh-remote-service: push triggers');
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
    this.audit = new AuditLog();
    const storedPush = readJson(paths.pushTokens(), { version: 1, tokens: [] });
    for (const entry of Array.isArray(storedPush.tokens) ? storedPush.tokens : []) {
      if (entry?.deviceId && entry?.token) {
        this.pushTokens.set(String(entry.deviceId), {
          deviceId: String(entry.deviceId),
          provider: String(entry.provider ?? 'expo'),
          token: String(entry.token),
        });
      }
    }
    this.pairing = new PairingManager({
      identity: this.identity,
      ca: this.ca,
      devices: this.devices,
      audit: this.audit,
      getConfig: () => this.config,
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
    if (!config.enabled) return;
    const errors = validateConfig(config);
    if (errors.length > 0) {
      this.lastError = errors.join('; ');
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
    const certInfo = inspectCert(certPem);
    this.tlsInfo = { certFile, dev, fqdn: hostFqdn(config), ...certInfo };
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
    for (const entry of this.pushTokens.values()) this.connector.registerPushToken(entry);
    this.lastError = tlsError;
    this.log(`remote server on 127.0.0.1:${this.listenPort}${dev ? ' (dev self-signed TLS)' : ''}`);
    this.#watchCertFiles(config);
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
    this.connector?.stop();
    this.connector = undefined;
    const listener = this.listener;
    this.listener = undefined;
    this.listenPort = 0;
    if (listener) {
      try { await listener.close(); } catch { /* ignore */ }
    }
  }

  #savePushToken(entry) {
    this.pushTokens.set(String(entry.deviceId), {
      deviceId: String(entry.deviceId),
      provider: String(entry.provider ?? 'expo'),
      token: String(entry.token),
    });
    this.connector?.registerPushToken(entry);
    const file = paths.pushTokens();
    const stored = readJson(file, { version: 1, tokens: [] });
    const tokens = Array.isArray(stored.tokens) ? stored.tokens : [];
    const next = tokens.filter((t) => !(t.deviceId === entry.deviceId && t.provider === entry.provider));
    next.push({ ...entry, updatedAt: Date.now() });
    writeJson(file, { version: 1, tokens: next.slice(-100) });
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
      devices: this.devices?.list() ?? [],
      listenPort: this.listenPort || null,
      // 管理 UI 需要读取的配置子集（密钥类字段只回布尔，不回明文）
      config: {
        enabled: Boolean(config.enabled),
        relayUrl: config.relayUrl ?? '',
        relayDomain: config.relayDomain ?? '',
        hostId: config.hostId ?? '',
        publicPort: Number(config.publicPort ?? 0),
        hostName: config.hostName ?? '',
        requireApproval: Boolean(config.requireApproval),
        pushEnabled: config.pushEnabled !== false,
        pushCooldownSeconds: Number(config.pushCooldownSeconds ?? 30),
        maxRequestBytes: Number(config.maxRequestBytes ?? 0),
        relayTlsInsecure: Boolean(config.relayTlsInsecure),
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
