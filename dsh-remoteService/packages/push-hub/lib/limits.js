/**
 * 内存滑动窗口限速器（零第三方依赖）。
 *
 * 设计（docs/group-push-r2-contract.zh.md §4.5 / docs/group-push-load-evaluation.zh.md §4）：
 * - 每个桶保存窗口内的命中时间戳数组，过期条目惰性清理；
 * - `peek` 只判断不记账，`consume` 判断并把本次计入；`take` 是 consume 的别名（0.1.0 名称）；
 * - `RateLimitSet.take()` 用于多层级限流：先 **全部 peek**，都通过才统一 consume，
 *   被拒的请求不消耗任何一层配额（避免误伤）；
 * - 计数器只在内存：进程重启清零可接受（契约明确允许）；多实例部署需换共享存储。
 */

/** 常用窗口大小。 */
export const HUB_LIMIT_WINDOWS = Object.freeze({
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
});

/** 单层限流默认最多保留的桶数（防随机 key 撑爆内存；超了先清理过期/最早的桶）。 */
const DEFAULT_MAX_KEYS = 50_000;

/**
 * @typedef {{allowed: boolean, retryAfterMs: number}} LimiterResult
 */

/**
 * 单层滑动窗口限速器。
 */
export class SlidingWindowLimiter {
  /**
   * @param {object} options
   * @param {number} options.limit 窗口内允许次数
   * @param {number} [options.windowMs]
   * @param {() => number} [options.now] 测试注入
   * @param {number} [options.maxKeys]
   */
  constructor({ limit, windowMs = HUB_LIMIT_WINDOWS.minute, now = Date.now, maxKeys = DEFAULT_MAX_KEYS }) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limiter limit 必须是正整数');
    if (!Number.isInteger(windowMs) || windowMs < 1) throw new Error('limiter windowMs 必须是正整数');
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.maxKeys = maxKeys;
    /** @type {Map<string, number[]>} */
    this.entries = new Map();
  }

  /** 当前桶数量（含可能已过期但尚未清理的）。 */
  get size() {
    return this.entries.size;
  }

  /**
   * 取某 key 的窗口内命中（并顺手清理过期时间戳）。
   * @param {string} key
   * @param {number} now
   * @returns {number[]}
   */
  #hits(key, now) {
    const cutoff = now - this.windowMs;
    const raw = this.entries.get(key);
    if (!raw) return [];
    const hits = raw.filter((timestamp) => timestamp > cutoff);
    if (hits.length === 0) this.entries.delete(key);
    else this.entries.set(key, hits);
    return hits;
  }

  /**
   * 只判断是否允许（不消耗配额）。
   * @param {string} key
   * @returns {LimiterResult}
   */
  peek(key) {
    const now = this.now();
    const hits = this.#hits(String(key), now);
    if (hits.length >= this.limit) {
      return { allowed: false, retryAfterMs: Math.max(1, hits[0] + this.windowMs - now) };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  /**
   * 判断并消耗一次配额（被拒时不记账）。
   * @param {string} key
   * @returns {LimiterResult}
   */
  consume(key) {
    const normalized = String(key);
    const now = this.now();
    const hits = this.#hits(normalized, now);
    if (hits.length >= this.limit) {
      return { allowed: false, retryAfterMs: Math.max(1, hits[0] + this.windowMs - now) };
    }
    hits.push(now);
    this.entries.set(normalized, hits);
    this.#evictIfNeeded();
    return { allowed: true, retryAfterMs: 0 };
  }

  /**
   * 0.1.0 的旧名字，等价 consume（兼容旧测试/调用方）。
   * @param {string} key
   * @returns {LimiterResult}
   */
  take(key) {
    return this.consume(key);
  }

  /** @param {string} key */
  reset(key) {
    this.entries.delete(String(key));
  }

  resetAll() {
    this.entries.clear();
  }

  /** 清掉所有已过期的桶（运维/测试用）。 */
  sweep() {
    const now = this.now();
    for (const key of [...this.entries.keys()]) this.#hits(key, now);
  }

  /** 桶太多时按插入顺序淘汰，保持内存有界。 */
  #evictIfNeeded() {
    if (this.entries.size <= this.maxKeys) return;
    const target = Math.floor(this.maxKeys * 0.9);
    let toRemove = this.entries.size - target;
    for (const key of this.entries.keys()) {
      if (toRemove <= 0) break;
      this.entries.delete(key);
      toRemove -= 1;
    }
  }
}

/**
 * 多层级限流器：按给定顺序检查，全部通过才消费；被拒时返回阻塞的那一层。
 */
export class RateLimitSet {
  /**
   * @param {Record<string, SlidingWindowLimiter>} limiters
   */
  constructor(limiters = {}) {
    this.limiters = limiters;
  }

  /**
   * @param {Array<[name: string, key: string]>} entries 顺序即检查优先级
   * @returns {{allowed: boolean, retryAfterMs: number, blockedBy: string}}
   */
  take(entries) {
    // 先全部 peek：被拒的请求不消耗任何配额（避免一次失败连累其它层）。
    for (const [name, key] of entries) {
      const limiter = this.limiters[name];
      if (!limiter) continue;
      const result = limiter.peek(String(key));
      if (!result.allowed) return { allowed: false, retryAfterMs: result.retryAfterMs, blockedBy: name };
    }
    for (const [name, key] of entries) {
      const limiter = this.limiters[name];
      if (limiter) limiter.consume(String(key));
    }
    return { allowed: true, retryAfterMs: 0, blockedBy: '' };
  }
}

/**
 * 把毫秒级等待时间转成 `Retry-After` 的整数秒（至少 1）。
 * @param {number} retryAfterMs
 * @returns {number}
 */
export function retryAfterSeconds(retryAfterMs) {
  return Math.max(1, Math.ceil(Number(retryAfterMs) / 1000));
}
