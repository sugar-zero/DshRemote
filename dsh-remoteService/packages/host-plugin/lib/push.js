/**
 * 主机侧推送触发器：监听 DSH 会话事件，在"一轮结束/出错"时让 relay 发一条
 * **内容无关**的提醒（只含通用标题/正文 + kind），手机收到后自行连回来看状态。
 *
 * 不发：会话标题、消息正文、文件路径、命令、模型输出。
 * 节流：按 session 冷却（默认 30s），子代理会话默认不推。
 */

const NOTIFY_REASONS = new Set(['completed', 'error', 'max-tokens', 'blocked', undefined]);

/** @param {unknown} reason */
export function pushKindOf(reason) {
  const kind = reason && typeof reason === 'object' ? reason.kind : undefined;
  return NOTIFY_REASONS.has(kind) ? (kind === 'completed' || kind === undefined ? 'completed' : 'failure') : 'skip';
}

export function createPushNotifier({ getConfig, getConnector, audit, log = () => {} }) {
  /** @type {Map<string, number>} */
  const lastPushAt = new Map();

  return {
    /**
     * @param {{id?: string, header?: {origin?: string}}} session
     * @param {{type?: string, data?: {reason?: {kind?: string}}}} event
     */
    onSessionEvent(session, event) {
      if (event?.type !== 'turn/end') return;
      const config = getConfig() ?? {};
      if (config.pushEnabled === false) return;
      if (session?.header?.origin === 'subagent') return;
      const kind = pushKindOf(event?.data?.reason);
      if (kind === 'skip') return;
      const connector = getConnector();
      if (!connector?.isConnected?.()) return;
      const sessionId = String(session?.id ?? '');
      const now = Date.now();
      const cooldownMs = Math.max(0, Number(config.pushCooldownSeconds ?? 30)) * 1000;
      if (sessionId !== '' && now - (lastPushAt.get(sessionId) ?? 0) < cooldownMs) return;
      if (sessionId !== '') lastPushAt.set(sessionId, now);
      const sent = connector.sendPush({ kind: 'attention' });
      audit?.append({ action: 'push-trigger', result: sent ? 'sent' : 'skipped', hash: kind });
      log(`push trigger: ${kind}${sessionId ? ` session=${sessionId.slice(-8)}` : ''} sent=${String(sent)}`);
    },

    /** 会话结束/卸载时清掉节流状态。 */
    reset(sessionId) {
      lastPushAt.delete(String(sessionId ?? ''));
    },
  };
}
