/**
 * 通知内容摘要：把「实际会话」压缩成通知标题 + 正文，替代固定文案。
 *
 * 数据来源（只读 DSH `session/event` 事件，不额外落盘）：
 * - 标题：最新的 `session/title`（用户重命名 / 自动标题）；没有时退回**首条用户消息**的截断；
 * - 正文：本轮最后一条带文本的 `assistant/message` 的截断摘要；本轮没有任何文本时退回状态文案。
 *
 * 隐私提示：这些文字会进入 APNs payload，可能显示在锁屏/通知中心（并经过 Apple 的推送网络）；
 * 只截取通用会话内容，不额外附带路径、命令、工具输出等字段。relay 不参与自托管 APNs 通道。
 *
 * 纯函数 + 有界内存，方便单测；不依赖 DSH 内部对象，只认事件结构。
 */

export const DEFAULT_PUSH_SUMMARY_LIMITS = Object.freeze({
  /** 通知标题最多字符数（按 Unicode code point 计）。 */
  maxTitleChars: 60,
  /** 通知正文最多字符数（按 Unicode code point 计）。 */
  maxBodyChars: 160,
  /** 最多跟踪多少个活跃会话（LRU，避免内存无界增长）。 */
  maxSessions: 100,
  /** 单条消息最多保留的字符数（存进 Map 前先截断）。 */
  maxStoredChars: 4000,
});

const FAILURE_BODY = '任务出错，打开查看详情';
const COMPLETED_BODY = '本轮已完成，打开查看结果';

/** 合并空白（换行/制表符/全角空格等）为单个半角空格，并裁剪首尾。 */
export function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * 按 Unicode code point 截断（避免把 emoji / 代理对切坏），超长时补省略号。
 * @param {unknown} value
 * @param {number} maxChars
 * @returns {string}
 */
export function truncateText(value, maxChars) {
  const text = normalizeText(value);
  if (text === '') return '';
  const points = Array.from(text);
  if (points.length <= maxChars) return text;
  const budget = Math.max(1, maxChars - 1);
  return `${points.slice(0, budget).join('').trimEnd()}…`;
}

/**
 * 从 DSH message 对象（`{ content: [{type:'text', text}] }`）提取纯文本块。
 * 忽略 reasoning / tool-call / image 等其它块。
 * @param {unknown} message
 * @returns {string}
 */
export function extractMessageText(message) {
  const content = message && typeof message === 'object' && Array.isArray(message.content) ? message.content : [];
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    const text = block.text.trim();
    if (text !== '') parts.push(text);
  }
  return parts.join('\n').trim();
}

/**
 * 从 `session/event` 事件里取出「消息文本」。
 * user/message 的 data 本身是 message；assistant/message 的 data.message 是 message。
 * @param {{type?: string, data?: any}} event
 * @returns {string}
 */
export function messageTextOfEvent(event) {
  if (!event || typeof event !== 'object') return '';
  if (event.type === 'user/message') return extractMessageText(event.data);
  if (event.type === 'assistant/message') return extractMessageText(event.data?.message);
  return '';
}

/**
 * 创建有界的会话摘要跟踪器。只观察与通知内容相关的事件：
 * - `session/title`：更新标题；
 * - `user/message`：没有标题时作为标题候选（首条用户消息）；
 * - `turn/start`：清空本轮助手文本；
 * - `assistant/message`：记录本轮最后一条带文本的助手回复。
 *
 * @param {Partial<typeof DEFAULT_PUSH_SUMMARY_LIMITS>} [options]
 */
export function createPushSummaryTracker(options = {}) {
  const limits = { ...DEFAULT_PUSH_SUMMARY_LIMITS, ...options };
  /** @type {Map<string, {title: string, firstUserText: string, lastAssistantText: string, updatedAt: number}>} */
  const sessions = new Map();

  /**
   * 首次见到某个会话时，从已存在的会话事件补齐标题/首条用户消息/最后一条助手文本。
   * DSH 重启或插件后加载时，历史事件不会重新走 `session/event`；不补齐的话第一条推送
   * 会退回固定文案。`snapshotEvents()` 只是读取 Session 内存 log 的冻结视图，成本可接受。
   * @param {{title: string, firstUserText: string, lastAssistantText: string}} state
   * @param {any} session
   */
  function hydrateFromSession(state, session) {
    if (typeof session?.snapshotEvents !== 'function') return;
    let events;
    try {
      events = session.snapshotEvents();
    } catch {
      return;
    }
    if (!Array.isArray(events) || events.length === 0) return;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (state.title === '' && event?.type === 'session/title') {
        const title = normalizeText(event.data?.title);
        if (title !== '') state.title = truncateText(title, limits.maxStoredChars);
      }
      if (state.lastAssistantText === '' && event?.type === 'assistant/message') {
        const text = messageTextOfEvent(event);
        if (text !== '') state.lastAssistantText = truncateText(text, limits.maxStoredChars);
      }
      if (state.title !== '' && state.lastAssistantText !== '') break;
    }
    if (state.firstUserText === '') {
      for (const event of events) {
        if (event?.type !== 'user/message') continue;
        const text = messageTextOfEvent(event);
        if (text !== '') {
          state.firstUserText = truncateText(text, limits.maxStoredChars);
          break;
        }
      }
    }
  }

  function stateFor(sessionId, session) {
    let state = sessions.get(sessionId);
    if (!state) {
      state = { title: '', firstUserText: '', lastAssistantText: '', updatedAt: 0 };
      sessions.set(sessionId, state);
      hydrateFromSession(state, session);
    }
    return state;
  }

  function touch(sessionId, state) {
    state.updatedAt = Date.now();
    sessions.delete(sessionId);
    sessions.set(sessionId, state);
    while (sessions.size > limits.maxSessions) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
  }

  return {
    /**
     * 观察一条会话事件（对无关事件是无操作）。
     * @param {{id?: string, header?: {origin?: string}} | undefined} session
     * @param {{type?: string, data?: any} | undefined} event
     */
    observe(session, event) {
      if (!session || !event) return;
      if (session.header?.origin === 'subagent') return;
      const sessionId = String(session.id ?? '');
      if (sessionId === '') return;
      const type = event.type;
      // 首次见到该会话时用历史事件补齐（否则重启后第一条推送会退化成固定文案）。
      const state = stateFor(sessionId, session);
      if (type === 'session/title') {
        const title = normalizeText(event.data?.title);
        if (title === '') return;
        state.title = truncateText(title, limits.maxStoredChars);
        touch(sessionId, state);
        return;
      }
      if (type === 'user/message') {
        const text = messageTextOfEvent(event);
        if (text === '') return;
        if (state.firstUserText === '') state.firstUserText = truncateText(text, limits.maxStoredChars);
        touch(sessionId, state);
        return;
      }
      if (type === 'assistant/message') {
        const text = messageTextOfEvent(event);
        if (text === '') return;
        state.lastAssistantText = truncateText(text, limits.maxStoredChars);
        touch(sessionId, state);
        return;
      }
      if (type === 'turn/start') {
        state.lastAssistantText = '';
        touch(sessionId, state);
      }
    },

    /**
     * 生成通知标题/正文。
     * @param {{id?: string}} session
     * @param {{kind?: 'completed'|'failure'|string}} [options]
     * @returns {{title: string, body: string}}
     */
    compose(session, { kind = 'completed' } = {}) {
      const sessionId = String(session?.id ?? '');
      const state = sessionId !== '' ? sessions.get(sessionId) : undefined;
      const title = truncateText(state?.title || state?.firstUserText || '', limits.maxTitleChars) || 'DSH';
      const snippet = truncateText(state?.lastAssistantText ?? '', limits.maxBodyChars);
      let body;
      if (snippet !== '') body = kind === 'failure' ? `⚠️ ${snippet}` : snippet;
      else body = kind === 'failure' ? FAILURE_BODY : COMPLETED_BODY;
      return { title, body };
    },

    /** 会话销毁时清理状态。 */
    forget(sessionId) {
      sessions.delete(String(sessionId ?? ''));
    },

    /** 当前跟踪的会话数（测试/诊断用）。 */
    size() {
      return sessions.size;
    },
  };
}
