/**
 * 群体服务版服务端集中推送（relay 侧，0.4.0，只有 self）。
 *
 * 数据流（契约 docs/group-push-design.zh.md §1）：
 *   主机插件（经已鉴权控制连接）→ push.register（App 的 APNs device token）
 *                              → push.send（推送意图：turn-end / waiting-answer）
 *   relay → 部署方自己的 APNs Auth Key（dsh-remote-apns 直连 Apple）
 *
 * R2 起官方 App 的推送不经过 relay：App 用设备密钥向官方 hub 登记换 credential，
 * 主机直连 hub 发送。relay 只保留 self 推送（部署方自签 App），本模块没有 official 分支。
 *
 * 内存 token 表：hostId → deviceId → {provider, token, environment, updatedAt}。
 *   - 同一 deviceId 只保留最新 token（App 重新注册会覆盖）；
 *   - 同一 host 最多 GROUP_PUSH_MAX_TOKENS_PER_HOST 个设备；
 *   - **不落盘**（relay 重启清空，App 重新进入主机时重登记）。
 *
 * 安全边界：
 *   - hostId 只来自已鉴权控制连接（由调用方传入；消息体里的 hostId 一律忽略）；
 *   - token 只在内存里，日志只记 deviceId / 计数 / 结果，不记完整 token/密钥；
 *   - 设备撤销（device.revoke / device.sync / admin revokeHost）由 server.js 调用
 *     dropDevice / pruneDevices / dropHost 立即清表。
 *
 * 本模块零第三方依赖（APNs 发送委托给 workspace 包 dsh-remote-apns）。
 */

import {
  GROUP_PUSH_DEFAULT_COOLDOWN_SECONDS,
  GROUP_PUSH_MAX_INTENTS_PER_MINUTE,
  GROUP_PUSH_MAX_TOKENS_PER_HOST,
  PUSH_ENVIRONMENT,
  PUSH_PROVIDER,
  hostFqdn,
  isPushEnvironment,
  isPushKind,
  isValidApnsDeviceToken,
  isValidGroupDeviceId,
} from 'dsh-remote-protocol';
import { createApnsClient, genericPushContent } from 'dsh-remote-apns';

/** 限速窗口（push.register / push.send 各自每 host 30 次/分钟）。 */
const RATE_WINDOW_MS = 60_000;
/** deviceId 上限（协议里 d_ + 6..40 位；这里只做兜底防御）。 */
const MAX_DEVICE_ID_LENGTH = 64;
/** push.send.id（host 生成的 uuid）上限。 */
const MAX_INTENT_ID_LENGTH = 128;
/** 会话摘要上限（契约 §4.2：title ≤ 60 字、body ≤ 160 字）。 */
const MAX_SUMMARY_TITLE_CHARS = 60;
const MAX_SUMMARY_BODY_CHARS = 160;
/** sessionId 只用于 App 点通知跳会话（APNs collapse-id 也有 64 字节限制，由 apns 包截断）。 */
const MAX_SESSION_ID_CHARS = 128;

const SILENT_LOGGER = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

/**
 * 滚动窗口限速（单进程内存；key = hostId）。
 * 与 group-auth 的 RateLimiter 同思路，但这里不抛异常，返回可读的受限结果。
 */
class SlidingWindowLimiter {
  /** @param {{maxPerWindow: number, windowMs?: number, now: () => number}} options */
  constructor({ maxPerWindow, windowMs = RATE_WINDOW_MS, now }) {
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
    this.now = now;
    /** @type {Map<string, number[]>} */
    this.hits = new Map();
  }

  /**
   * 记录一次操作；超限时返回 false（不记录本次）。
   * @param {string} key
   * @returns {{limited: boolean, retryAfterSec?: number}}
   */
  hit(key) {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const entries = (this.hits.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    if (entries.length >= this.maxPerWindow) {
      this.hits.set(key, entries);
      const retryAfterSec = Math.max(1, Math.ceil((entries[0] + this.windowMs - now) / 1000));
      return { limited: true, retryAfterSec };
    }
    entries.push(now);
    this.hits.set(key, entries);
    return { limited: false };
  }

  /** @param {string} key */
  reset(key) {
    this.hits.delete(key);
  }
}

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function truncate(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * 创建 relay 的推送服务（token 表 + 内容策略 + 限速 + APNs 发送）。
 *
 * @param {object} options
 * @param {Record<string, any>} options.config 规范化后的 `group.push`（见 lib/config.js；mode 恒为 self）
 * @param {string} options.domain relay 域名（拼 `<hostId>.<domain>` 供 App 点通知跳转）
 * @param {any} [options.logger]
 * @param {() => number} [options.now] 测试注入
 * @param {any} [options.apnsClient] 测试注入：dsh-remote-apns 发送器替身
 * @param {(options: object) => any} [options.createApnsClient] 测试注入：APNs 客户端工厂
 * @returns {{
 *   register: (hostId: string, msg: Record<string, any>) => {ok: boolean, deviceId: string, mode?: string,
 *     enabled?: boolean, code?: string, message?: string},
 *   send: (hostId: string, msg: Record<string, any>) => Promise<{
 *     ok: boolean, delivered?: number, failed?: number, pruned?: string[], mode?: string, skipped?: string,
 *     code?: string, message?: string}>,
 *   dropDevice: (hostId: string, deviceId: string) => boolean,
 *   dropHost: (hostId: string) => boolean,
 *   pruneDevices: (hostId: string, deviceIds: Iterable<string>) => number,
 *   summary: () => {enabled: boolean, mode: 'self', tokens: number},
 * }}
 */
export function createGroupPushService(options = {}) {
  const config = options.config && typeof options.config === 'object' ? options.config : {};
  const logger = options.logger ?? SILENT_LOGGER;
  const domain = typeof options.domain === 'string' ? options.domain : '';
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  const enabled = config.enabled === true;
  // R2 起只有 self：官方 App 推送直连 hub，relay 不参与（配置层已拒绝其它 mode）。
  const mode = 'self';
  const content = config.content === 'summary' ? 'summary' : 'generic';
  const cooldownSeconds = Number.isInteger(config.cooldownSeconds) && config.cooldownSeconds >= 0
    ? config.cooldownSeconds
    : GROUP_PUSH_DEFAULT_COOLDOWN_SECONDS;
  const selfConfig = config.self && typeof config.self === 'object' ? config.self : {};

  /** @type {Map<string, Map<string, {provider: string, token: string, environment: string, updatedAt: number}>>} */
  const tokensByHost = new Map();
  /** @type {Map<string, number>} hostId → 上次实际发送时间（cooldown 用） */
  const lastSentAt = new Map();
  const intentLimiter = new SlidingWindowLimiter({ maxPerWindow: GROUP_PUSH_MAX_INTENTS_PER_MINUTE, now });
  const registerLimiter = new SlidingWindowLimiter({ maxPerWindow: GROUP_PUSH_MAX_INTENTS_PER_MINUTE, now });

  // APNs 客户端延迟构建：私钥只在首次实际推送时读取一次，
  // 读取失败只返回可操作错误，不打印内容、不影响 relay 启动。
  const apnsFactory = typeof options.createApnsClient === 'function' ? options.createApnsClient : createApnsClient;
  let apns = options.apnsClient ?? null;
  let apnsResolved = Boolean(options.apnsClient);

  /** @returns {any} */
  function apnsClient() {
    if (apnsResolved) return apns;
    apnsResolved = true;
    try {
      apns = apnsFactory({
        keyFile: selfConfig.keyFile,
        keyId: selfConfig.keyId,
        teamId: selfConfig.teamId,
        topic: selfConfig.topic,
        environment: selfConfig.environment,
      });
    } catch (error) {
      logger.error(`push: 无法初始化 APNs 客户端（检查 group.push.self）: ${error && error.message ? error.message : String(error)}`);
      apns = null;
    }
    return apns;
  }

  /** @param {string} hostId */
  function totalTokens() {
    let total = 0;
    for (const table of tokensByHost.values()) total += table.size;
    return total;
  }

  /** 主机 FQDN（App 点通知跳转用；domain 缺失时留空）。 */
  function hostAccessName(hostId) {
    return domain === '' ? '' : hostFqdn(hostId, domain);
  }

  /**
   * 删除一个 device 的 token（表空时清掉 host 项）。
   * @param {string} hostId
   * @param {string} deviceId
   * @returns {boolean}
   */
  function dropDevice(hostId, deviceId) {
    const table = tokensByHost.get(hostId);
    if (!table) return false;
    const removed = table.delete(String(deviceId));
    if (table.size === 0) tokensByHost.delete(hostId);
    return removed;
  }

  /**
   * 只删除「token 未轮换」的失效 token（避免 APNs 410 晚到把新 token 删掉）。
   * @param {string} hostId
   * @param {string} deviceId
   * @param {string} token
   * @returns {boolean}
   */
  function dropStaleToken(hostId, deviceId, token) {
    const table = tokensByHost.get(String(hostId));
    if (!table) return false;
    const entry = table.get(String(deviceId));
    if (!entry || entry.token !== token) return false;
    return dropDevice(hostId, deviceId);
  }

  /**
   * 主机上报一个设备 token（`push.register`）。
   *
   * @param {string} hostId 来自已鉴权控制连接，**绝不**取自消息体
   * @param {Record<string, any>} msg
   * @returns {{ok: boolean, deviceId: string, mode?: string, enabled?: boolean, code?: string, message?: string}}
   */
  function register(hostId, msg) {
    const input = msg && typeof msg === 'object' ? msg : {};
    const deviceId = typeof input.deviceId === 'string' ? input.deviceId : '';
    if (deviceId === '' || deviceId.length > MAX_DEVICE_ID_LENGTH || !isValidGroupDeviceId(deviceId)) {
      return { ok: false, deviceId: deviceId.slice(0, MAX_DEVICE_ID_LENGTH), code: 'invalid_device', message: 'deviceId 必须是 d_ 开头的设备 ID' };
    }
    if (!enabled) {
      return { ok: false, deviceId, code: 'push_disabled', message: 'relay 未开启推送（group.push.enabled=false）' };
    }
    const limiting = registerLimiter.hit(hostId);
    if (limiting.limited) {
      return { ok: false, deviceId, code: 'rate_limited', message: `登记过于频繁，请 ${limiting.retryAfterSec} 秒后重试` };
    }
    if (input.provider !== PUSH_PROVIDER.APNS) {
      return { ok: false, deviceId, code: 'invalid_provider', message: '仅支持 provider="apns"（Android FCM 后续接入）' };
    }
    if (!isValidApnsDeviceToken(input.token)) {
      return { ok: false, deviceId, code: 'invalid_push_token', message: 'APNs device token 必须是 64 位小写 hex' };
    }
    if (!isPushEnvironment(input.environment)) {
      return { ok: false, deviceId, code: 'invalid_environment', message: 'environment 必须是 development 或 production' };
    }
    const environment = input.environment === PUSH_ENVIRONMENT.DEVELOPMENT
      ? PUSH_ENVIRONMENT.DEVELOPMENT
      : PUSH_ENVIRONMENT.PRODUCTION;

    const table = tokensByHost.get(hostId) ?? new Map();
    if (!table.has(deviceId) && table.size >= GROUP_PUSH_MAX_TOKENS_PER_HOST) {
      return {
        ok: false,
        deviceId,
        code: 'too_many_tokens',
        message: `同一主机最多保留 ${GROUP_PUSH_MAX_TOKENS_PER_HOST} 个设备 token（先在 App 设置页重新登记/清理旧设备）`,
      };
    }
    const replaced = table.has(deviceId);
    table.set(deviceId, {
      provider: PUSH_PROVIDER.APNS,
      token: input.token,
      environment,
      updatedAt: now(),
    });
    tokensByHost.set(hostId, table);
    logger.info(`push: host "${hostId}" ${replaced ? 'updated' : 'registered'} device ${deviceId} (mode ${mode})`);
    return { ok: true, deviceId, mode, enabled: true };
  }

  /**
   * 生成一条推送的内容（标题/正文/sessionId）。
   * generic 用固定文案（忽略 host 上报的 title/body）；仅 self+summary 用摘要。
   *
   * @param {string} hostId
   * @param {string} kind
   * @param {Record<string, any>} msg
   * @returns {{kind: string, title: string, body: string, sessionId: string, host: string}}
   */
  function buildMessage(hostId, kind, msg) {
    const generic = genericPushContent(kind);
    const host = hostAccessName(hostId);
    if (content === 'summary') {
      const title = truncate(msg.title, MAX_SUMMARY_TITLE_CHARS);
      const body = truncate(msg.body, MAX_SUMMARY_BODY_CHARS);
      return {
        kind,
        title: title !== '' ? title : generic.title,
        body: body !== '' ? body : generic.body,
        // sessionId 仅用于 App 点通知跳会话（self 推送）。
        sessionId: truncate(msg.sessionId, MAX_SESSION_ID_CHARS),
        host,
      };
    }
    // generic：标题/正文固定；sessionId 仍可用于点通知跳会话（契约 §5）。
    return {
      kind,
      title: generic.title,
      body: generic.body,
      sessionId: truncate(msg.sessionId, MAX_SESSION_ID_CHARS),
      host,
    };
  }

  /**
   * 发一次推送意图（`push.send`）。
   *
   * 返回约定：
   *   - `{ok:true, delivered, failed, pruned, mode, skipped?}`：已处理（skipped = no-tokens / push_disabled / cooldown）；
   *   - `{ok:false, code, message}`：invalid_request / rate_limited / push_unavailable / internal。
   *
   * @param {string} hostId 来自已鉴权控制连接
   * @param {Record<string, any>} msg
   * @returns {Promise<{ok: boolean, delivered?: number, failed?: number, pruned?: string[], mode?: string,
   *   skipped?: string, code?: string, message?: string}>}
   */
  async function send(hostId, msg) {
    const input = msg && typeof msg === 'object' ? msg : {};
    const id = truncate(input.id, MAX_INTENT_ID_LENGTH);
    if (id === '') return { ok: false, code: 'invalid_request', message: 'push.send 缺少 id' };
    if (!isPushKind(input.kind)) {
      return { ok: false, code: 'invalid_request', message: 'kind 必须是 "turn-end" 或 "waiting-answer"' };
    }
    const limiting = intentLimiter.hit(hostId);
    if (limiting.limited) {
      return { ok: false, code: 'rate_limited', message: `推送过于频繁，请 ${limiting.retryAfterSec} 秒后重试` };
    }
    if (!enabled) {
      return { ok: true, delivered: 0, failed: 0, pruned: [], mode, skipped: 'push_disabled' };
    }

    const table = tokensByHost.get(hostId);
    /** @type {Array<{deviceId: string, token: string, environment: string}>} */
    const entries = table
      ? [...table.entries()].map(([deviceId, entry]) => ({ deviceId, token: entry.token, environment: entry.environment }))
      : [];
    if (entries.length === 0) {
      return { ok: true, delivered: 0, failed: 0, pruned: [], mode, skipped: 'no-tokens' };
    }

    const timestamp = now();
    const lastSent = lastSentAt.get(hostId);
    if (cooldownSeconds > 0 && lastSent !== undefined && timestamp - lastSent < cooldownSeconds * 1000) {
      return { ok: true, delivered: 0, failed: 0, pruned: [], mode, skipped: 'cooldown' };
    }
    lastSentAt.set(hostId, timestamp);
    const kind = input.kind;

    const client = apnsClient();
    if (!client) {
      return { ok: false, code: 'push_unavailable', message: 'APNs 配置不可用（检查 group.push.self.keyFile/keyId/teamId/topic）' };
    }
    let result;
    try {
      result = await client.sendToTokens(entries, buildMessage(hostId, kind, input));
    } catch (error) {
      logger.warn(`push: host "${hostId}" APNs 发送失败: ${error && error.message ? error.message : String(error)}`);
      return { ok: false, code: 'internal', message: 'APNs 发送过程异常' };
    }
    if (result && result.skipped === 'not-configured') {
      logger.warn('push: APNs 未配置（检查 group.push.self.keyFile/keyId/teamId/topic）');
      return { ok: false, code: 'push_unavailable', message: 'APNs 配置不可用（检查 group.push.self.keyFile/keyId/teamId/topic）' };
    }
    if (result && Array.isArray(result.configErrors) && result.configErrors.length > 0) {
      // 不删 token：BadDeviceToken / DeviceTokenNotForTopic / InvalidProviderToken 是配置问题。
      logger.warn(`push: host "${hostId}" APNs 配置错误 ${result.configErrors.join(', ')}（检查 topic/environment/Key ID/Team ID）`);
    }
    /** @type {string[]} */
    const pruned = [];
    for (const item of result && Array.isArray(result.pruned) ? result.pruned : []) {
      if (dropStaleToken(hostId, String(item.deviceId ?? ''), String(item.token ?? ''))) pruned.push(String(item.deviceId));
    }
    const delivered = Number.isInteger(result?.delivered) ? result.delivered : 0;
    const failed = Number.isInteger(result?.failed) ? result.failed : 0;
    if (delivered > 0 || pruned.length > 0) {
      logger.info(`push: host "${hostId}" delivered ${delivered}, failed ${failed}, pruned ${pruned.length} (self)`);
    }
    return { ok: true, delivered, failed, pruned, mode };
  }

  /**
   * 撤销一台主机（admin revokeHost 等）：清空该主机的 token 表与限速状态。
   * @param {string} hostId
   * @returns {boolean}
   */
  function dropHost(hostId) {
    const had = tokensByHost.delete(String(hostId));
    lastSentAt.delete(String(hostId));
    intentLimiter.reset(String(hostId));
    registerLimiter.reset(String(hostId));
    return had;
  }

  /**
   * 按主机最新设备列表清理 token（device.sync 全量覆盖后调用；不在册的设备立即失效）。
   * @param {string} hostId
   * @param {Iterable<string>} deviceIds 仍在册的 deviceId
   * @returns {number} 删除的 token 数
   */
  function pruneDevices(hostId, deviceIds) {
    const table = tokensByHost.get(String(hostId));
    if (!table || table.size === 0) return 0;
    const keep = new Set();
    for (const deviceId of deviceIds) keep.add(String(deviceId));
    let dropped = 0;
    for (const deviceId of [...table.keys()]) {
      if (!keep.has(deviceId)) {
        table.delete(deviceId);
        dropped += 1;
      }
    }
    if (table.size === 0) tokensByHost.delete(String(hostId));
    return dropped;
  }

  return {
    register,
    send,
    dropDevice,
    dropHost,
    pruneDevices,
    /** /healthz 用摘要：不含任何 token / 密钥。 */
    summary: () => ({ enabled, mode, tokens: totalTokens() }),
  };
}
