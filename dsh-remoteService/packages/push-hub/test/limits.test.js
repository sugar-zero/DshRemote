import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HUB_LIMIT_WINDOWS,
  RateLimitSet,
  SlidingWindowLimiter,
  retryAfterSeconds,
} from '../index.js';

test('limiter: peek 不消耗、consume 消耗、take 是别名', () => {
  let now = 1_700_000_000_000;
  const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 60_000, now: () => now });
  // peek 连续调用不会消耗配额。
  assert.deepEqual(limiter.peek('k'), { allowed: true, retryAfterMs: 0 });
  assert.deepEqual(limiter.peek('k'), { allowed: true, retryAfterMs: 0 });
  assert.equal(limiter.size, 0);
  // consume 两次后第三次被拒。
  assert.equal(limiter.consume('k').allowed, true);
  assert.equal(limiter.take('k').allowed, true);
  const blocked = limiter.consume('k');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 60_000);
  // 不同 key 互不影响。
  assert.equal(limiter.peek('other').allowed, true);
  // 窗口滚动后恢复。
  now += 60_000;
  assert.equal(limiter.consume('k').allowed, true);
  limiter.reset('k');
  assert.equal(limiter.size, 0);
  assert.equal(limiter.consume('k').allowed, true);
});

test('limiter: 按分钟/小时/天窗口（R2 三层单位）', () => {
  let now = 1_700_000_000_000;
  for (const [windowMs, label] of [
    [HUB_LIMIT_WINDOWS.minute, 'minute'],
    [HUB_LIMIT_WINDOWS.hour, 'hour'],
    [HUB_LIMIT_WINDOWS.day, 'day'],
  ]) {
    const limiter = new SlidingWindowLimiter({ limit: 1, windowMs, now: () => now });
    assert.equal(limiter.consume('k').allowed, true, label);
    const blocked = limiter.consume('k');
    assert.equal(blocked.allowed, false, label);
    assert.equal(blocked.retryAfterMs, windowMs, label);
    now += windowMs;
    assert.equal(limiter.consume('k').allowed, true, label);
  }
});

test('limiter: sweep 清理过期桶，maxKeys 限制内存', () => {
  let now = 1_700_000_000_000;
  const limiter = new SlidingWindowLimiter({ limit: 5, windowMs: 60_000, now: () => now, maxKeys: 5 });
  for (let i = 0; i < 20; i += 1) limiter.consume(`k${i}`);
  assert.ok(limiter.size <= 5, `size=${limiter.size} 应该被 maxKeys 限制`);
  now += 60_000;
  limiter.sweep();
  assert.equal(limiter.size, 0);
});

test('limiter: RateLimitSet 全部通过才消耗，被拒时任何层都不记账', () => {
  let now = 1_700_000_000_000;
  const token = new SlidingWindowLimiter({ limit: 2, windowMs: 60_000, now: () => now });
  const host = new SlidingWindowLimiter({ limit: 1, windowMs: 60_000, now: () => now });
  const set = new RateLimitSet({ token, host });
  const entries = [['token', 't1'], ['host', 'h1']];
  assert.deepEqual(set.take(entries), { allowed: true, retryAfterMs: 0, blockedBy: '' });
  // host 只有 1 次配额：第二次被 host 拒绝；此时 token 不能被记一次。
  const blocked = set.take(entries);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.blockedBy, 'host');
  // token 还剩 1 次（第二次被拒没消耗）→ 换 host 后仍可成功，成功后才耗尽。
  assert.equal(set.take([['token', 't1'], ['host', 'h2']]).allowed, true);
  assert.equal(set.take([['token', 't1'], ['host', 'h3']]).allowed, false);
  // 窗口滚动后恢复。
  now += 60_000;
  assert.equal(set.take(entries).allowed, true);
});

test('limiter: 未注册的层被跳过（便于部分配置）', () => {
  const set = new RateLimitSet({ token: new SlidingWindowLimiter({ limit: 1 }) });
  assert.equal(set.take([['missing', 'x'], ['token', 't']]).allowed, true);
  assert.equal(set.take([['missing', 'x'], ['token', 't']]).allowed, false);
});

test('limiter: retryAfterSeconds 至少 1 秒且向上取整', () => {
  assert.equal(retryAfterSeconds(0), 1);
  assert.equal(retryAfterSeconds(1), 1);
  assert.equal(retryAfterSeconds(1_001), 2);
  assert.equal(retryAfterSeconds(60_000), 60);
  assert.equal(retryAfterSeconds(86_400_000), 86_400);
});
