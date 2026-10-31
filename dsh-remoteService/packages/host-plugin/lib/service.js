import { rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { loadConfig, saveConfig, validateConfig } from './config.js';
import { ensureDir, paths } from './paths.js';
import { loadOrCreateHostIdentity } from './identity.js';
import { DeviceStore } from './devices.js';
import { AuditLog } from './audit.js';
import { PairingManager } from './pairing.js';
import { DshProxy } from './proxy.js';
import { GroupHostRuntime, loadGroupRegistration } from './group.js';

const VERSION = '0.2.0';

/**
 * 群体服务版主机插件运行时装配：
 * 配置 / 主机身份 / 设备表 → loopback 明文代理 → 群体版注册与隧道（GroupHostRuntime）。
 *
 * 主机不监听任何公网/本机 TLS 端口，也不持有证书或推送配置：relay 边缘终止手机 TLS，
 * 明文流经出站隧道交给本机 loopback 代理，逐请求 token 验签 + 设备在册校验后反代 DSH。
 */
export class RemoteService {
  /** @param {object} ctx DSH 插件上下文 */
  constructor(ctx) {
    this.ctx = ctx;
    this.lastError = null;
    this.log = (message) => {
      try { console.log(`[dsh-remote] ${message}`); } catch { /* ignore */ }
    };
    this.ready = this.#init().catch((error) => {
      this.lastError = error.message;
      this.log(`init failed: ${error.stack ?? error.message}`);
    });
  }

  async #init() {
    ensureDir(paths.dir());
    this.config = loadConfig();
    this.identity = loadOrCreateHostIdentity();
    this.devices = new DeviceStore();
    // 设备配对/撤销后：把最新设备表（deviceId + P-256 公钥）同步给 relay。
    this.devices.onChange = () => {
      try { this.groupRuntime?.syncDevices(); } catch { /* ignore */ }
    };
    this.audit = new AuditLog();
    this.pairing = new PairingManager({
      identity: this.identity,
      devices: this.devices,
      audit: this.audit,
      getConfig: () => this.config,
      // 群体版二维码用 v2（服务端下发的 hostId/relayDomain/mobilePort + auth=token）
      // 已注册但隧道暂时断开时也允许生成二维码（group.json 即注册事实）；连不上服务的配对请求自然会失败。
      getGroupInfo: () => (this.config?.enabled
        ? (this.groupRuntime?.registrationInfo() ?? loadGroupRegistration())
        : undefined),
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

  /** 按当前配置启动/停止群体隧道与 loopback 明文代理。 */
  async #apply() {
    await this.#stopRuntime();
    this.lastError = null;
    const config = this.config;
    if (!config.enabled) return;
    const errors = validateConfig(config);
    if (errors.length > 0) {
      this.lastError = errors.join('; ');
      return;
    }
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
      // 启动失败不留半启动的隧道 / loopback 代理；注册信息仍在 group.json，可点「重试连接」。
      await this.#stopRuntime();
    }
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
    this.audit.append({ deviceId: removed?.id ?? device.id, action: 'device-delete', result: 'ok' });
    return { device: removed ?? device };
  }

  async #stopRuntime() {
    const groupRuntime = this.groupRuntime;
    this.groupRuntime = undefined;
    if (groupRuntime) {
      try { await groupRuntime.stop(); } catch { /* ignore */ }
    }
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
    this.config = saveConfig({ enabled: false, groupInviteCode: '' });
    await this.#apply();
    this.audit?.append({ action: 'group-reset', result: 'ok' });
    return this.status();
  }

  /** 群体服务版：重试控制面隧道（不重置注册、不消耗邀请码）。 */
  async retryGroup() {
    const registration = this.groupRuntime?.registrationInfo() ?? loadGroupRegistration();
    if (!registration) {
      throw Object.assign(new Error('尚未注册服务，无法重试连接'), { status: 409, code: 'group-not-registered' });
    }
    if (!this.groupRuntime) {
      // 之前被关闭/启动失败：按已有注册重新装配（不会重新消耗邀请码）。
      this.config = saveConfig({ enabled: true });
      await this.#apply();
      if (!this.groupRuntime) {
        throw Object.assign(new Error(this.lastError || '重试连接失败'), { status: 500, code: 'group-retry-failed' });
      }
      return this.status();
    }
    await this.groupRuntime.reconnect();
    this.audit?.append({ action: 'group-retry', result: 'ok' });
    return this.status();
  }

  /** 已注册的群体服务信息（未注册/未启用时从 group.json 读取）。 */
  #groupStatus() {
    if (this.groupRuntime) return this.groupRuntime.status();
    const registration = loadGroupRegistration();
    const config = this.config ?? {};
    return {
      registered: Boolean(registration),
      serviceUrl: registration?.serviceUrl ?? config.groupServiceUrl ?? '',
      controlUrl: registration?.controlUrl ?? '',
      hostId: registration?.hostId ?? '',
      hostName: registration?.hostName || config.hostName || '',
      relayDomain: registration?.relayDomain ?? '',
      mobilePort: registration?.mobilePort ?? 0,
      fqdn: registration ? `${registration.hostId}.${registration.relayDomain}` : '',
      connected: false,
      plainPort: 0,
      tokenPublicKeyConfigured: Boolean(registration?.tokenPublicKey),
      lastError: this.lastError ?? null,
    };
  }

  /** 返回当前状态（管理 API / 桌面 UI）。 */
  status() {
    const config = this.config ?? loadConfig();
    const group = this.#groupStatus();
    return {
      version: VERSION,
      enabled: Boolean(config.enabled),
      host: {
        id: group.hostId,
        name: group.hostName || config.hostName || hostname(),
        fingerprint: this.identity?.fingerprint ?? '',
        domain: group.fqdn,
      },
      pairing: this.pairing?.publicSession() ?? { active: false },
      devices: this.devices?.list() ?? [],
      // 群体服务版（A 模式）：注册/隧道状态（唯一模式）
      group,
      // 管理 UI 需要读取的配置子集（密钥类字段不落配置，也没有可回显的密钥）
      config: {
        enabled: Boolean(config.enabled),
        hostName: config.hostName ?? '',
        requireApproval: Boolean(config.requireApproval),
        maxRequestBytes: Number(config.maxRequestBytes ?? 0),
        denyPrefixes: Array.isArray(config.denyPrefixes) ? config.denyPrefixes : [],
        groupServiceUrl: config.groupServiceUrl ?? '',
        groupPlainPort: Number(config.groupPlainPort ?? 0),
        groupInsecure: Boolean(config.groupInsecure),
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
