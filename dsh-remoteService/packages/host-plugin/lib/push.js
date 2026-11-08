/**
 * 群体服务版主机侧推送触发器：监听 DSH 会话事件，在「一轮结束/出错」或「等待用户回答」时
 * 生成一条**推送意图**，交给运行时按设备通道分流投递（R2，契约 §6.2）：
 *
 * - **self 设备**（部署方自签 App）：经已鉴权的 relay 控制连接发 `push.send`（relay 发送，行为与 R1 一致）；
 * - **official 设备**（官方 App）：主机拿 App 上报的 credential 直连官方 hub（`/v1/push`），不经过 relay；
 * - 两类设备可混用，主机自动分流；只有 self 设备时不向 relay 发空意图，只有 official 设备时也不碰 relay；
 * - 主机**零 Apple 凭据**、不持有 hub 签名密钥；对 official 请求不等待/不重试（10s 超时只记状态）。
 *
 * 触发（与 main 分支语义一致，代码自 main 的 push.js 移植）：
 * - `turn/end` 且 reason ∈ completed / error / max-tokens / blocked（reason 缺省按 completed），
 *   子代理会话跳过，同一 session 30s 冷却；
 * - `tool/call` 且 `name === 'ask_user_question'`：立即推送，正文固定「正在等待你的回答」，
 *   按 callId 去重、不受 30s 冷却影响；
 * - 主机开关 `pushEnabled === false`、没有任何已登记设备、运行时不可用时静默跳过
 *   （跳过不消耗冷却/去重状态，等设备登记/运行时恢复后下一轮仍可推送）。
 */

import { randomUUID } from 'node:crypto';
import { PUSH_KINDS } from 'dsh-remote-protocol';
import { createPushSummaryTracker } from './push-summary.js';

/**
 * 会触发 `turn-end` 意图的结束原因（缺省 reason 按 completed 处理，与 main 语义一致）。
 * `aborted` 等用户主动中断不推送。
 */
const NOTIFY_REASONS = new Set(['completed', 'error', 'max-tokens', 'blocked', undefined]);
/** 等待用户回答（ask_user_question）时的通知正文（标题仍用会话名）。 */
export const QUESTION_WAITING_BODY = '正在等待你的回答';
/** DSH 里需要用户作答的工具名。 */
const QUESTION_TOOL_NAME = 'ask_user_question';
/** host 侧会话级冷却（契约 §6.2：同一 session 30s）。 */
const DEFAULT_COOLDOWN_SECONDS = 30;

/**
 * turn/end 的 reason → 摘要语气（completed / failure）；不推送的原因返回 skip。
 * @param {unknown} reason
 * @returns {'completed'|'failure'|'skip'}
 */
export function pushKindOf(reason) {
  const kind = reason && typeof reason === 'object' ? reason.kind : undefined;
  if (!NOTIFY_REASONS.has(kind)) return 'skip';
  return kind === 'completed' || kind === undefined ? 'completed' : 'failure';
}

/** @param {string} sessionId */
function sessionSuffix(sessionId) {
  return sessionId ? ` session=${String(sessionId).slice(-8)}` : '';
}

/**
 * @param {object} options
 * @param {() => Record<string, any>} options.getConfig 当前主机配置（读取 pushEnabled / pushCooldownSeconds）
 * @param {() => {self?: number, official?: number}} [options.getTargets]
 *   当前已登记推送设备数（service 注入 groupRuntime.pushTargets）；两类都为 0 时不触发。
 * @param {(intent: object) => Promise<any>} [options.deliver]
 *   发送分流入口（service 注入 groupRuntime.deliverPush）；缺失 = 运行时不可用，静默跳过。
 * @param {{append: (entry: object) => any}} [options.audit]
 * @param {(message: string) => void} [options.log]
 * @param {ReturnType<typeof createPushSummaryTracker>} [options.summaryTracker] 测试可注入
 */
export function createGroupPushNotifier({
  getConfig,
  getTargets,
  deliver,
  audit,
  log = () => {},
  summaryTracker,
} = {}) {
  /** @type {Map<string, number>} 每个 session 上次 turn-end 推送时间（冷却用）。 */
  const lastPushAt = new Map();
  /**
   * 每个会话最近一次已通知的等待事件（callId）。
   * 事件流重连/重放时同一 id 会再次出现；只认新的等待事件，避免重复推送。
   * @type {Map<string, string>}
   */
  const lastWaitingKey = new Map();
  const tracker = summaryTracker ?? createPushSummaryTracker();

  const config = () => getConfig?.() ?? {};

  /** 当前可投递设备数（self + official）；运行时/设备未就绪时为 0。 */
  function targetCounts() {
    if (typeof deliver !== 'function') return { self: 0, official: 0 };
    const raw = getTargets?.() ?? {};
    const self = Math.max(0, Number(raw?.self ?? 0) || 0);
    const official = Math.max(0, Number(raw?.official ?? 0) || 0);
    return { self, official };
  }

  function hasTargets() {
    const counts = targetCounts();
    return counts.self + counts.official > 0;
  }

  /**
   * 投递一条推送意图（运行时负责 self/official 分流）；不等待回执。
   * @param {{kind: string, title: string, body: string, sessionId: string}} intent
   * @returns {Promise<boolean>} 是否至少投递到一个通道
   */
  async function send(intent) {
    const message = { id: randomUUID(), ...intent };
    let summary;
    try {
      summary = await deliver(message);
    } catch (error) {
      log(`push trigger failed: ${intent.kind}${sessionSuffix(intent.sessionId)} error=${error?.message ?? error}`);
      summary = undefined;
    }
    const selfSent = summary?.self?.sent > 0;
    const officialSent = Number(summary?.official?.sent ?? 0) > 0;
    const officialFailed = Number(summary?.official?.failed ?? 0);
    const officialPruned = Number(summary?.official?.pruned ?? 0);
    const sent = selfSent || officialSent;
    audit?.append({ action: 'push-trigger', result: sent ? 'sent' : 'skipped', hash: intent.kind });
    log(
      `push trigger: ${intent.kind}${sessionSuffix(intent.sessionId)}`
      + ` self=${selfSent} official=${officialSent} failed=${officialFailed} pruned=${officialPruned}`,
    );
    return sent;
  }

  /**
   * 需要用户作答（ask_user_question）时推送：标题=会话名，正文固定「正在等待你的回答」。
   * 与 turn/end 的冷却相互独立（问答常常紧接在上一轮结束后发生，不能被 30s 冷却吞掉）。
   * @param {{id?: string, header?: {origin?: string}}} session
   * @param {{type?: string, data?: {callId?: unknown, name?: unknown}}} event
   */
  async function notifyWaitingForAnswer(session, event) {
    if (config().pushEnabled === false) return;
    if (session?.header?.origin === 'subagent') return;
    const sessionId = String(session?.id ?? '');
    if (sessionId === '') return;
    const callId = String(event?.data?.callId ?? '');
    const waitingKey = `question:${callId}`;
    if (lastWaitingKey.get(sessionId) === waitingKey) return;
    // 运行时/设备未就绪时不记去重键：恢复后同一提问重放仍能推送（callId 不变只推一次）。
    if (!hasTargets()) {
      audit?.append({ action: 'push-trigger', result: 'skipped', hash: PUSH_KINDS.WAITING_ANSWER });
      log(`push trigger: ${PUSH_KINDS.WAITING_ANSWER}${sessionSuffix(sessionId)} skipped（没有已登记的推送设备或运行时不可用）`);
      return;
    }
    lastWaitingKey.set(sessionId, waitingKey);
    // 只取标题；正文固定为等待提示，不显示助手内容，避免与上一轮摘要混淆。
    const title = tracker.compose(session, { kind: 'completed' }).title;
    await send({ kind: PUSH_KINDS.WAITING_ANSWER, title, body: QUESTION_WAITING_BODY, sessionId });
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
      const current = config();
      if (current.pushEnabled === false) return;
      if (session?.header?.origin === 'subagent') return;
      const kind = pushKindOf(event?.data?.reason);
      if (kind === 'skip') return;
      const sessionId = String(session?.id ?? '');
      // 没有可投递设备/运行时未就绪时静默跳过，且不消耗冷却状态——恢复后下一轮仍应推送。
      if (!hasTargets()) {
        audit?.append({ action: 'push-trigger', result: 'skipped', hash: PUSH_KINDS.TURN_END });
        log(`push trigger: ${PUSH_KINDS.TURN_END}${sessionSuffix(sessionId)} skipped（没有已登记的推送设备或运行时不可用）`);
        return;
      }

      const now = Date.now();
      const cooldownMs = Math.max(0, Number(current.pushCooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS)) * 1000;
      if (sessionId !== '' && now - (lastPushAt.get(sessionId) ?? 0) < cooldownMs) return;
      if (sessionId !== '') lastPushAt.set(sessionId, now);

      const content = tracker.compose(session, { kind });
      await send({ kind: PUSH_KINDS.TURN_END, title: content.title, body: content.body, sessionId });
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
