import { rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { loadConfig, saveConfig, validateConfig } from './config.js';
import { ensureDir, paths } from './paths.js';
import { loadOrCreateHostIdentity } from './identity.js';
import { DeviceStore } from './devices.js';
import { AuditLog } from './audit.js';
import { PairingManager } from './pairing.js';
import { DshProxy, REMOTE_STREAM_MUX_PATH } from './proxy.js';
import { GroupHostRuntime, loadGroupRegistration } from './group.js';
import { createHostRestartScheduler, requestHostRestart } from './host-restart.js';
import { createGroupPushNotifier } from './push.js';

const VERSION = '0.2.6';

/**
 * 未启动群体运行时的推送状态默认值（契约 §6.3 R2 形状；不含 token/credential）。
 * @param {boolean} enabled
 */
function defaultPushStatus(enabled) {
  return {
    enabled: enabled !== false,
    self: { devices: 0, lastError: null },
    official: { devices: 0, lastError: null, hub: null },
    mode: '',
  };
}

/**
 * 会影响「群体运行时（隧道 / loopback 代理 / 配对）」装配的配置字段。
 *
 * 只有这些字段变化才需要重建 `GroupHostRuntime`（会断开重连隧道、重新刷新注册信息）；
 * 其余字段（典型：`restartHostEnabled` 这类组件开关、`pushEnabled` 推送开关）**只持久化**，
 * 不重启运行时——否则只是切一下「允许手机重启主机 DSH」或「推送提醒」也会把隧道断开重连，
 * 保存慢且可能失败。
 */
export const RUNTIME_CONFIG_KEYS = Object.freeze([
  'enabled', 'groupServiceUrl', 'groupInviteCode', 'hostName', 'groupPlainPort', 'groupInsecure',
  'requireApproval', 'denyPrefixes', 'maxRequestBytes',
]);

/** 数组按元素、对象按 JSON 比较（配置值都是 JSON 可序列化的原始类型/数组）。 */
function configValuesEqual(left, right) {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => String(value) === String(right[index]));
  }
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
  }
  return left === right;
}

/** group.json 里登记的注册服务地址（迁移回填用；没有则空串）。 */
function registrationServiceUrl() {
  try {
    return String(loadGroupRegistration()?.serviceUrl ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * 群体服务版主机插件运行时装配：
 * 配置 / 主机身份 / 设备表 → loopback 明文代理 → 群体版注册与隧道（GroupHostRuntime）。
 *
 * 主机不监听任何公网/本机 TLS 端口，也不持有证书或推送配置：relay 边缘终止手机 TLS，
 * 明文流经出站隧道交给本机 loopback 代理，逐请求 token 验签 + 设备在册校验后反代 DSH。
 *
 * 「重启主机 DSH」是可关闭组件（`config.restartHostEnabled`，默认关闭）：开启后手机可经
 * `POST /__dsh_remote/restart` 让主机调度 detached helper 重启整个 DSH 客户端。
 */
export class RemoteService {
  /**
   * @param {object} ctx DSH 插件上下文
   * @param {{
   *   spawnHostRestart?: typeof import('node:child_process').spawn,
   *   hostRestartDedupeMs?: number,
   *   hostRestartEnv?: NodeJS.ProcessEnv,
   *   fetchImpl?: typeof fetch,
   *   hubTimeoutMs?: number,
   * }} [options] 测试注入（spawn 必须是假的，绝不真的杀进程；fetchImpl 用于 mock 官方 hub）
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.lastError = null;
    this.fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : undefined;
    this.hubTimeoutMs = options.hubTimeoutMs;
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
    // 群体服务版推送（R2）：notifier 只做「什么时候该提醒」；发送阶段由 groupRuntime 按设备
    // channel 分流（self → relay push.send；official → 主机直连官方 hub）。主机不持有 Apple 凭据。
    this.pushNotifier = createGroupPushNotifier({
      getConfig: () => this.config ?? {},
      getTargets: () => this.groupRuntime?.pushTargets?.() ?? { self: 0, official: 0 },
      deliver: (intent) => this.groupRuntime?.deliverPush(intent),
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

  /**
   * 历史配置迁移：早期/异常状态下注册信息只在 `group.json`，`config.groupServiceUrl` 为空。
   * 而 `validateConfig` 要求 enabled 时 serviceUrl 非空 → 不回填的话**任何保存**都会
   * 400 `invalid-config`（保存「组件」开关也会失败），隧道也起不来。
   *
   * 用 registration.serviceUrl 回填并落盘（幂等；config 已有值时不覆盖用户输入）。
   * @returns {boolean} 是否发生回填
   */
  #backfillGroupServiceUrl() {
    if (String(this.config?.groupServiceUrl ?? '').trim() !== '') return false;
    const fallback = registrationServiceUrl();
    if (fallback === '') return false;
    this.config = saveConfig({ groupServiceUrl: fallback });
    this.log('config: 已从 group.json 回填 groupServiceUrl（历史配置迁移）');
    return true;
  }

  /** 按当前配置启动/停止群体隧道与 loopback 明文代理。 */
  async #apply() {
    await this.#stopRuntime();
    this.lastError = null;
    // 历史配置迁移：先补 groupServiceUrl，避免「已注册但 config 缺服务地址」导致永远起不来。
    this.#backfillGroupServiceUrl();
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
      version: VERSION,
      // 手机经隧道 POST /__dsh_remote/restart 时由 GroupHostRuntime 调用（内部再校验组件开关）。
      restartHost: (request) => this.restartHost(request),
      // 官方 hub 直连（R2）：测试可注入假 fetch / 缩短超时。
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      ...(Number(this.hubTimeoutMs) > 0 ? { hubTimeoutMs: Number(this.hubTimeoutMs) } : {}),
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
   * 远程「重启主机 DSH」：去重后调度 detached helper 杀进程并重新拉起。
   *
   * 只做调度，不自己动手杀进程；实际重启由 lib/host-restart.js 的 helper 在 ~1s 后完成，
   * 这样 HTTP **202** 能先发回手机。审计由 GroupHostRuntime 的 `/__dsh_remote/restart`
   * 路由统一写（每请求一条 accepted/failed，去重命中标 hash=deduped），这里只记日志。
   *
   * 组件开关 `config.restartHostEnabled !== true` 时抛 501 `host-restart-disabled`
   * （路由层也会先拦一道，绕过 UI 直接调用接口同样拒绝）。
   *
   * @param {{device?: {id?: string, deviceId?: string}}} [request] 路由层传入的请求上下文
   * @returns {{mode: string, deduped: boolean}}
   */
  restartHost(request = {}) {
    const deviceId = request?.device?.id ?? request?.device?.deviceId ?? 'unknown';
    if (this.config?.restartHostEnabled !== true) {
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
      // 未启动运行时：推送默认「主机开关生效、两通道都没有已登记设备」。
      push: defaultPushStatus(config.pushEnabled !== false),
    };
  }

  /** 推送状态（运行中读 GroupHostRuntime；未运行时给默认值，契约 §6.3）。 */
  #pushStatus(group) {
    if (group?.push) return group.push;
    const config = this.config ?? loadConfig();
    return defaultPushStatus(config.pushEnabled !== false);
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
      // 「重启主机」组件状态（App 据此决定是否显示顶栏 ⏻；默认关闭）
      restart: { enabled: config.restartHostEnabled === true },
      // 群体服务版（A 模式）：注册/隧道状态（唯一模式）
      group,
      // 推送状态（契约 §6：「推送提醒」开关 / relay 通道 / 已登记设备数 / 错误；不含 token）
      push: this.#pushStatus(group),
      // 管理 UI 需要读取的配置子集（密钥类字段不落配置，也没有可回显的密钥）
      config: {
        enabled: Boolean(config.enabled),
        hostName: config.hostName ?? '',
        requireApproval: Boolean(config.requireApproval),
        restartHostEnabled: Boolean(config.restartHostEnabled),
        pushEnabled: config.pushEnabled !== false,
        maxRequestBytes: Number(config.maxRequestBytes ?? 0),
        denyPrefixes: Array.isArray(config.denyPrefixes) ? config.denyPrefixes : [],
        groupServiceUrl: config.groupServiceUrl ?? '',
        groupPlainPort: Number(config.groupPlainPort ?? 0),
        groupInsecure: Boolean(config.groupInsecure),
      },
    };
  }

  /**
   * 更新配置（管理 API `/config`）。
   *
   * 行为约定（0.2.2 修复「组件开关保存失败」）：
   * 1. **历史迁移**：config.groupServiceUrl 为空但 group.json 有注册时，保存前用
   *    registration.serviceUrl 回填，避免任何保存都被 `validateConfig` 判成非法配置；
   * 2. **按需重建**：只有 `RUNTIME_CONFIG_KEYS` 里的字段真的变化才 `#apply()`（重建运行时）；
   *    `restartHostEnabled` / `pushEnabled` 这类纯状态字段只持久化，保存立即返回，隧道不断；
   * 3. **只对重建返回校验错误**：没重建运行时的保存不再被历史遗留校验问题阻塞（否则
   *    只切一个组件开关也会 400 → 客户端「保存失败」）。
   *
   * @param {Record<string, any>} [patch]
   * @returns {{config: Record<string, any>, errors: string[], applied: boolean}}
   *   `applied=true` 表示本次保存重建了群体运行时（隧道会短暂重连）。
   */
  async updateConfig(patch = {}) {
    const previous = this.config ?? loadConfig();
    const requested = { ...(patch ?? {}) };

    // 迁移回填：只有调用方没显式改 groupServiceUrl 时才补（避免覆盖用户清空/换服务地址的意图）。
    const nextUrl = Object.hasOwn(requested, 'groupServiceUrl')
      ? String(requested.groupServiceUrl ?? '').trim()
      : String(previous.groupServiceUrl ?? '').trim();
    if (nextUrl === '' && !Object.hasOwn(requested, 'groupServiceUrl')) {
      const fallback = registrationServiceUrl();
      if (fallback !== '') requested.groupServiceUrl = fallback;
    }

    this.config = saveConfig(requested);
    // 运行时若在跑：把最新配置对象交给它。纯状态字段（如 restartHostEnabled）不重建运行时，
    // 但隧道内的 `/__dsh_remote/status` 与 `POST /__dsh_remote/restart` 必须立刻看到新值，
    // 否则要等下次重建运行时 / 重启 DSH 才生效（App 顶栏 ⏻ 与重启接口都会滞后）。
    if (this.groupRuntime) this.groupRuntime.config = this.config;
    const changedKeys = Object.keys(requested).filter((key) => !configValuesEqual(previous[key], this.config[key]));
    const applied = changedKeys.some((key) => RUNTIME_CONFIG_KEYS.includes(key));
    if (applied) await this.#apply();

    // 「组件」开关变化时，隧道本身不重建（避免保存慢/失败），但要让 App 立刻感知：
    // 只断开 DSH **主实时通道**（/api/remote.mux）→ App 的 ws-close 自动恢复重载 → 重新拉 status
    // → 顶栏 ⏻ 立即出现/消失。**不能断所有 WS**：App 会为每个 WS 上报 dsh-ws-close，多条同时
    // 断开会把它的自动恢复预算（60s 内 2 次）一次耗尽（用户实测 0.2.3「自动重连未恢复」）。
    if (!applied && changedKeys.includes('restartHostEnabled')) {
      const dropped = this.groupRuntime?.closeUpgradedConnections?.() ?? 0;
      this.log(
        `config: restartHostEnabled=${this.config.restartHostEnabled}；`
        + `已断开 ${dropped} 条主实时通道（${REMOTE_STREAM_MUX_PATH}）连接以触发 App 即时刷新`,
      );
    }

    const errors = applied ? validateConfig(this.config) : [];
    if (errors.length > 0) this.log(`config: 保存后校验未通过: ${errors.join('; ')}`);
    return { config: this.config, errors, applied };
  }

  async dispose() {
    await this.#stopRuntime();
  }
}
