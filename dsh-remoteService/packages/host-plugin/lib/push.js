/**
 * 主机侧推送触发器：监听 DSH 会话事件，在"一轮结束/出错"或"等待用户回答"时发提醒。
 *
 * 通知内容取自实际会话（见 push-summary.js）：标题 = 会话标题（无则首条用户消息），
 * 正文 = 本轮最后一条助手回复的截断摘要（无则状态兜底文案）/ 等待回答时固定为
 * 「正在等待你的回答」；不含路径/命令等额外字段。
 *
 * 两种通道（config.pushProvider）：
 * - 'apns'（默认，自托管）：主机直接用 APNs Auth Key 发到 Apple，不经过 relay，
 *   也不依赖 Expo 账号；token 存在本机 push-tokens.json。
 * - 'expo'（旧版）：把 token 注册到 relay，由 relay 调 Expo Push Service（relay 侧仍是
 *   通用文案，不含会话内容）。
 *
 * 节流：turn/end 按 session 冷却（默认 30s）；等待回答事件按 callId 去重、不受该冷却影响。
 * 子代理会话默认不推。
 */

import { hostAddress, pushProviderOf } from './config.js';
import { createPushSummaryTracker } from './push-summary.js';

const NOTIFY_REASONS = new Set(['completed', 'error', 'max-tokens', 'blocked', undefined]);
const PUSH_KIND = 'attention';
/** 等待用户回答（ask_user_question）时的通知正文（标题仍用会话名）。 */
const QUESTION_WAITING_BODY = '正在等待你的回答';
/** DSH 里需要用户作答的工具名。 */
const QUESTION_TOOL_NAME = 'ask_user_question';

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
  /**
   * 每个会话最近一次已通知的等待事件（callId）。
   * 事件流重连/重放时同一 id 会再次出现；只认新的等待事件，避免重复推送。
   * @type {Map<string, string>}
   */
  const lastWaitingKey = new Map();
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

  /**
   * 需要用户作答（ask_user_question）时推送：标题=会话名，正文固定「正在等待你的回答」。
   * 与 turn/end 的冷却相互独立（问答常常紧接在上一轮结束后发生，不能被 30s 冷却吞掉）。
   * @param {{id?: string, header?: {origin?: string}}} session
   * @param {{type?: string, data?: {callId?: unknown, name?: unknown}}} event
   */
  async function notifyWaitingForAnswer(session, event) {
    const config = getConfig() ?? {};
    if (config.pushEnabled === false) return;
    if (session?.header?.origin === 'subagent') return;
    const sessionId = String(session?.id ?? '');
    if (sessionId === '') return;
    const callId = event?.data?.callId;
    const waitingKey = `question:${String(callId ?? '')}`;
    if (lastWaitingKey.get(sessionId) === waitingKey) return;

    const provider = pushProviderOf(config);
    if (provider === 'apns') {
      const client = getApnsClient?.();
      const entries = getPushTokens?.() ?? [];
      if (!client?.isConfigured?.() || !entries.some((entry) => entry?.provider === 'apns')) return;
    } else {
      const connector = getConnector();
      if (!connector?.isConnected?.()) return;
    }

    lastWaitingKey.set(sessionId, waitingKey);
    if (provider === 'apns') {
      // 只取标题；正文固定为等待提示，不显示助手内容，避免与上一轮摘要混淆。
      const title = tracker.compose(session, { kind: 'completed' }).title;
      await sendViaApns('waiting', sessionId, { title, body: QUESTION_WAITING_BODY });
      return;
    }

    // 旧版 relay→Expo 通道只能发通用文案（relay 侧不持有会话内容）。
    const sent = getConnector()?.sendPush?.({ kind: PUSH_KIND }) ?? false;
    audit?.append({ action: 'push-trigger', result: sent ? 'sent' : 'skipped', hash: 'waiting' });
    log(`push trigger: waiting${sessionSuffix(sessionId)} channel=expo sent=${String(sent)}`);
  }

  return {
    /**
     * @param {{id?: string, header?: {origin?: string}}} session
     * @param {{type?: string, data?: {reason?: {kind?: string}, name?: unknown, callId?: unknown}}} event
     * @returns {Promise<void>}
     */
    async onSessionEvent(session, event) {
      // 先喂会话摘要状态（标题 / 用户消息 / 助手回复 / turn 重置），再判断是否触发推送。
      tracker.observe(session, event);
      // 模型调用 ask_user_question：用户需要作答，立即通知（与 turn/end 通知独立）。
      if (event?.type === 'tool/call' && event?.data?.name === QUESTION_TOOL_NAME) {
        await notifyWaitingForAnswer(session, event);
        return;
      }
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
      lastWaitingKey.delete(id);
      tracker.forget(id);
    },
  };
}
