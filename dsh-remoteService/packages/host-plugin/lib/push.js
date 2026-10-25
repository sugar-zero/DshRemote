/**
 * 主机侧推送触发器：监听 DSH 会话事件，在"一轮结束/出错"时发一条提醒。
 *
 * 通知内容取自实际会话（见 push-summary.js）：标题 = 会话标题（无则首条用户消息），
 * 正文 = 本轮最后一条助手回复的截断摘要（无则状态兜底文案）；不含路径/命令等额外字段。
 *
 * 两种通道（config.pushProvider）：
 * - 'apns'（默认，自托管）：主机直接用 APNs Auth Key 发到 Apple，不经过 relay，
 *   也不依赖 Expo 账号；token 存在本机 push-tokens.json。
 * - 'expo'（旧版）：把 token 注册到 relay，由 relay 调 Expo Push Service（relay 侧仍是
 *   通用文案，不含会话内容）。
 *
 * 节流：按 session 冷却（默认 30s），子代理会话默认不推。
 */

import { hostAddress, pushProviderOf } from './config.js';
import { createPushSummaryTracker } from './push-summary.js';

const NOTIFY_REASONS = new Set(['completed', 'error', 'max-tokens', 'blocked', undefined]);
const PUSH_KIND = 'attention';

/** @param {unknown} reason */
export function pushKindOf(reason) {
  const kind = reason && typeof reason === 'object' ? reason.kind : undefined;
  return NOTIFY_REASONS.has(kind) ? (kind === 'completed' || kind === undefined ? 'completed' : 'failure') : 'skip';
}

/** @param {string} sessionId */
function sessionSuffix(sessionId) {
  return sessionId ? ` session=${sessionId.slice(-8)}` : '';
}

export function createPushNotifier({
  getConfig,
  getConnector,
  getApnsClient,
  getPushTokens,
  onPushTokensInvalid,
  audit,
  log = () => {},
  summaryTracker,
}) {
  /** @type {Map<string, number>} */
  const lastPushAt = new Map();
  const tracker = summaryTracker ?? createPushSummaryTracker();

  /** 自托管 APNs 通道；未配置/无 token 时静默跳过（设置页与 /status 有提示）。 */
  async function sendViaApns(kind, sessionId, content) {
    const client = getApnsClient?.();
    const entries = (getPushTokens?.() ?? []).filter((entry) => entry && entry.provider === 'apns');
    if (!client?.isConfigured?.() || entries.length === 0) return;
    try {
      const config = getConfig() ?? {};
      const result = await client.sendToTokens(entries, {
        kind: PUSH_KIND,
        title: content?.title,
        body: content?.body,
        sessionId,
        host: hostAddress(config),
      });
      // 只有 410 / Unregistered 会出现在 pruned（条目是 {deviceId, token}，token 已轮换时不删）。
      if (Array.isArray(result.pruned) && result.pruned.length > 0) {
        try { onPushTokensInvalid?.(result.pruned); } catch { /* 清理失败不影响推送主流程 */ }
      }
      const configErrors = Array.isArray(result.configErrors) ? result.configErrors : [];
      if (configErrors.length > 0) {
        log(`push trigger: ${kind}${sessionSuffix(sessionId)} channel=apns APNs 判为配置错误（${configErrors.join(', ')}）：请检查 apnsTopic（bundle ID）/ apnsEnvironment / Key ID / Team ID；不会清理设备 token`);
      }
      const resultLabel = result.delivered > 0 ? 'sent' : (result.failed > 0 ? 'failed' : 'skipped');
      audit?.append({ action: 'push-trigger', result: resultLabel, hash: kind });
      const firstError = Array.isArray(result.errors) && result.errors.length > 0 ? ` error=${result.errors[0].reason}` : '';
      log(`push trigger: ${kind}${sessionSuffix(sessionId)} channel=apns delivered=${result.delivered} failed=${result.failed} pruned=${result.pruned?.length ?? 0}${firstError}`);
    } catch (error) {
      audit?.append({ action: 'push-trigger', result: 'failed', hash: kind });
      log(`push trigger failed: ${kind}${sessionSuffix(sessionId)} channel=apns error=${error?.message ?? error}`);
    }
  }

  return {
    /**
     * @param {{id?: string, header?: {origin?: string}}} session
     * @param {{type?: string, data?: {reason?: {kind?: string}}}} event
     * @returns {Promise<void>}
     */
    async onSessionEvent(session, event) {
      // 先喂会话摘要状态（标题 / 用户消息 / 助手回复 / turn 重置），再判断是否触发推送。
      tracker.observe(session, event);
      if (event?.type !== 'turn/end') return;
      const config = getConfig() ?? {};
      if (config.pushEnabled === false) return;
      if (session?.header?.origin === 'subagent') return;
      const kind = pushKindOf(event?.data?.reason);
      if (kind === 'skip') return;
      const sessionId = String(session?.id ?? '');
      const provider = pushProviderOf(config);

      if (provider === 'apns') {
        const client = getApnsClient?.();
        const entries = getPushTokens?.() ?? [];
        if (!client?.isConfigured?.() || !entries.some((entry) => entry?.provider === 'apns')) return;
      } else {
        const connector = getConnector();
        if (!connector?.isConnected?.()) return;
      }

      const now = Date.now();
      const cooldownMs = Math.max(0, Number(config.pushCooldownSeconds ?? 30)) * 1000;
      if (sessionId !== '' && now - (lastPushAt.get(sessionId) ?? 0) < cooldownMs) return;
      if (sessionId !== '') lastPushAt.set(sessionId, now);

      if (provider === 'apns') {
        const content = tracker.compose(session, { kind });
        await sendViaApns(kind, sessionId, content);
        return;
      }

      // 旧版：token 已注册到 relay，由 relay → Expo 发送（relay 侧标题/正文）。
      const sent = getConnector()?.sendPush?.({ kind: PUSH_KIND }) ?? false;
      audit?.append({ action: 'push-trigger', result: sent ? 'sent' : 'skipped', hash: kind });
      log(`push trigger: ${kind}${sessionSuffix(sessionId)} channel=expo sent=${String(sent)}`);
    },

    /** 会话结束/卸载时清掉节流状态与摘要缓存。 */
    reset(sessionId) {
      const id = String(sessionId ?? '');
      lastPushAt.delete(id);
      tracker.forget(id);
    },
  };
}
