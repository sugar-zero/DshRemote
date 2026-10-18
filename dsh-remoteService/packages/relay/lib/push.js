/**
 * relay 侧推送服务：只存不透明设备推送 token，转发"需要关注"提醒。
 *
 * 安全边界（B2）：
 * - 推送内容**零正文**：只有通用标题/正文 + `{kind}`，不含会话名/消息/文件路径。
 * - token 仅内存保存，按 hostId 隔离；host 重新注册时覆盖；relay 重启后由 App
 *   下次打开重新注册（POC 阶段不做持久化）。
 * - relay 只接受已通过 host.hello 鉴权的控制连接发来的 register/send。
 */

export const DEFAULT_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';
export const DEFAULT_PUSH_TITLE = 'DSH';
export const DEFAULT_PUSH_BODY = '有任务需要你';
const MAX_TOKENS_PER_HOST = 20;
const MAX_BATCH = 100;

/**
 * @param {object} options
 * @param {string} [options.endpoint]
 * @param {string} [options.accessToken]
 * @param {string} [options.title]
 * @param {string} [options.body]
 * @param {boolean} [options.enabled]
 * @param {object} [options.logger]
 * @param {typeof fetch} [options.fetchImpl]
 */
export function createPushService(options = {}) {
  const endpoint = options.endpoint || DEFAULT_PUSH_ENDPOINT;
  const accessToken = options.accessToken || '';
  const title = options.title || DEFAULT_PUSH_TITLE;
  const body = options.body || DEFAULT_PUSH_BODY;
  const enabled = options.enabled !== false;
  const logger = options.logger ?? { debug() {}, info() {}, warn() {}, error() {} };
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  /** @type {Map<string, Map<string, {deviceId: string, provider: string, token: string, updatedAt: number}>>} */
  const hosts = new Map();

  function hostTokens(hostId) {
    let entry = hosts.get(hostId);
    if (!entry) {
      entry = new Map();
      hosts.set(hostId, entry);
    }
    return entry;
  }

  return {
    enabled,

    /** 注册/更新一个设备的推送 token。 @returns {{registered:boolean, count:number}} */
    register(hostId, { deviceId, provider = 'expo', token } = {}) {
      if (!enabled) return { registered: false, count: 0, reason: 'push-disabled' };
      const id = String(deviceId ?? '').slice(0, 64);
      const p = String(provider ?? 'expo');
      const t = String(token ?? '');
      if (id.length === 0) throw Object.assign(new Error('deviceId 不能为空'), { code: 'invalid-device' });
      if (p !== 'expo') throw Object.assign(new Error(`不支持的推送 provider: ${p}`), { code: 'unsupported-provider' });
      if (t.length < 8 || t.length > 4096) throw Object.assign(new Error('推送 token 长度非法'), { code: 'invalid-token' });
      const tokens = hostTokens(hostId);
      if (!tokens.has(id) && tokens.size >= MAX_TOKENS_PER_HOST) {
        throw Object.assign(new Error('该主机的推送设备数已达上限'), { code: 'too-many-devices' });
      }
      tokens.set(id, { deviceId: id, provider: p, token: t, updatedAt: Date.now() });
      logger.info(`push: host "${hostId}" registered device ${id} (${tokens.size} total)`);
      return { registered: true, count: tokens.size };
    },

    /** 某主机的 token 数量（诊断用，不暴露 token）。 */
    countFor(hostId) {
      return hosts.get(hostId)?.size ?? 0;
    },

    /** 总注册设备数（health/诊断用）。 */
    totalCount() {
      let total = 0;
      for (const tokens of hosts.values()) total += tokens.size;
      return total;
    },

    /**
     * 给某主机的设备发"需要关注"提醒。无 token / 关闭时静默成功（delivered=0）。
     * @returns {Promise<{delivered:number, failed:number, skipped?:string}>}
     */
    async send(hostId, { kind = 'attention' } = {}) {
      if (!enabled) return { delivered: 0, failed: 0, skipped: 'push-disabled' };
      const tokens = [...(hosts.get(hostId)?.values() ?? [])];
      if (tokens.length === 0) return { delivered: 0, failed: 0, skipped: 'no-tokens' };
      const safeKind = String(kind ?? 'attention').slice(0, 32);
      const messages = tokens.map((entry) => ({
        to: entry.token,
        title,
        body,
        data: { kind: safeKind },
        sound: 'default',
        priority: 'default',
      }));
      let delivered = 0;
      let failed = 0;
      for (let start = 0; start < messages.length; start += MAX_BATCH) {
        const batch = messages.slice(start, start + MAX_BATCH);
        try {
          const response = await fetchImpl(endpoint, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
              ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
            },
            body: JSON.stringify(batch),
          });
          if (!response.ok) {
            failed += batch.length;
            logger.warn(`push: endpoint -> HTTP ${response.status}`);
            continue;
          }
          const result = await response.json().catch(() => undefined);
          const tickets = Array.isArray(result?.data) ? result.data : [];
          for (const ticket of tickets) {
            if (ticket?.status === 'ok') delivered += 1;
            else failed += 1;
          }
          if (tickets.length === 0) delivered += batch.length; // 非 Expo 的自定义 endpoint 可能不回 tickets
        } catch (error) {
          failed += batch.length;
          logger.warn(`push: send failed: ${error.message}`);
        }
      }
      logger.info(`push: host "${hostId}" kind=${safeKind} delivered=${delivered} failed=${failed}`);
      return { delivered, failed };
    },

    /** 主机撤销/停用时清理其 token（当前控制面尚未调用，预留给 device revoke 同步）。 */
    dropHost(hostId) {
      const removed = hosts.delete(hostId);
      return removed;
    },
  };
}
