/**
 * 群体服务版主机推送触发器（lib/push.js）。
 *
 * R2 下 notifier 只负责「什么时候该提醒」；发送阶段由运行时按设备 channel 分流
 * （self → relay；official → 主机直连官方 hub）。这里用假 deliver 验证触发/冷却/去重/
 * 子代理跳过/开关/无设备跳过，不连真 relay、不发真推送。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PUSH_KINDS } from 'dsh-remote-protocol';
import { createGroupPushNotifier, pushKindOf, QUESTION_WAITING_BODY } from '../lib/push.js';

test('pushKindOf：completed/error/max-tokens/blocked 触发，aborted 跳过；无 reason 按 completed（main 语义）', () => {
  assert.equal(pushKindOf({ kind: 'completed' }), 'completed');
  assert.equal(pushKindOf({ kind: 'error' }), 'failure');
  assert.equal(pushKindOf({ kind: 'max-tokens' }), 'failure');
  assert.equal(pushKindOf({ kind: 'blocked' }), 'failure');
  assert.equal(pushKindOf(undefined), 'completed', 'turn/end 缺 reason 时与 main 一致按 completed 触发');
  assert.equal(pushKindOf({}), 'completed');
  assert.equal(pushKindOf({ kind: 'aborted' }), 'skip');
  assert.equal(pushKindOf({ kind: 'cancelled' }), 'skip');
  assert.equal(pushKindOf(null), 'completed');
});

const DEFAULT_SUMMARY = {
  self: { devices: 1, sent: 1 },
  official: { devices: 0, sent: 0, failed: 0, pruned: 0 },
};

function makeNotifier({ targets = { self: 1, official: 0 }, summary, config = {}, deliver } = {}) {
  const state = { targets };
  const calls = [];
  const audits = [];
  const logs = [];
  const deliverFn = deliver ?? (async (intent) => {
    calls.push(intent);
    return typeof summary === 'function' ? summary(intent) : (summary ?? DEFAULT_SUMMARY);
  });
  const notifier = createGroupPushNotifier({
    getConfig: () => config,
    getTargets: () => state.targets,
    deliver: deliverFn,
    audit: { append: (entry) => audits.push(entry) },
    log: (message) => logs.push(message),
  });
  return { notifier, state, calls, audits, logs };
}

const session = (id, header = { origin: 'chat' }) => ({ id, header });

test('turn/end：生成推送意图交给 deliver（kind=turn-end + 标题/摘要/sessionId + uuid），审计 sent', async () => {
  const env = makeNotifier({ config: { pushEnabled: true, pushCooldownSeconds: 60 } });
  const s = session('s_1');
  await env.notifier.onSessionEvent(s, { type: 'user/message', data: { content: [{ type: 'text', text: '帮我看看登录重定向' }] } });
  await env.notifier.onSessionEvent(s, { type: 'session/title', data: { title: '修复登录 bug' } });
  await env.notifier.onSessionEvent(s, { type: 'turn/start', data: { turn: 0 } });
  await env.notifier.onSessionEvent(s, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '已修好登录重定向，跑完测试' }] } },
  });
  await env.notifier.onSessionEvent(s, { type: 'turn/end', data: { reason: { kind: 'completed' } } });

  assert.equal(env.calls.length, 1);
  const intent = env.calls[0];
  assert.deepEqual(Object.keys(intent).sort(), ['body', 'content', 'id', 'kind', 'sessionId', 'title']);
  assert.equal(intent.kind, PUSH_KINDS.TURN_END, 'kind 只能是 turn-end');
  assert.equal(intent.content, 'generic', '默认不带详细内容');
  assert.equal(intent.title, '修复登录 bug');
  assert.equal(intent.body, '已修好登录重定向，跑完测试');
  assert.equal(intent.sessionId, 's_1');
  assert.match(intent.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'id 必须是 randomUUID');
  assert.ok(env.audits.some((entry) => entry.action === 'push-trigger' && entry.result === 'sent' && entry.hash === 'turn-end'));
  assert.ok(!JSON.stringify(env.audits).includes('已修好登录重定向'), '审计不记录会话内容');
});

test('无设备/运行时未就绪：静默跳过且不消耗冷却，设备登记后下一轮照常推送', async () => {
  const env = makeNotifier({ targets: { self: 0, official: 0 }, config: { pushEnabled: true } });
  const s = session('s_wait');
  await env.notifier.onSessionEvent(s, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(env.calls.length, 0, '没有已登记设备时不调 deliver');
  assert.ok(env.audits.some((entry) => entry.action === 'push-trigger' && entry.result === 'skipped'));
  assert.ok(env.logs.some((line) => line.includes('没有已登记的推送设备')));

  env.state.targets = { self: 1, official: 0 };
  await env.notifier.onSessionEvent(s, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(env.calls.length, 1, '跳过不应消耗冷却，设备就绪后立即能推');

  // deliver 缺失（运行时不可用）：同样跳过
  const noDeliver = createGroupPushNotifier({
    getConfig: () => ({ pushEnabled: true }),
    getTargets: () => ({ self: 1, official: 0 }),
    deliver: undefined,
    audit: { append() {} },
  });
  await noDeliver.onSessionEvent(session('s_none'), { type: 'turn/end', data: { reason: { kind: 'completed' } } });
});

test('turn/end：同 session 30s 冷却、不同 session 不受影响；reset 清冷却', async () => {
  const env = makeNotifier({ config: { pushEnabled: true } });
  const a = session('s_a');
  const b = session('s_b');
  await env.notifier.onSessionEvent(a, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  await env.notifier.onSessionEvent(a, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(env.calls.length, 1, '同 session 冷却期内不重复推送');

  await env.notifier.onSessionEvent(b, { type: 'turn/end', data: { reason: { kind: 'error' } } });
  assert.equal(env.calls.length, 2, '不同 session 各自冷却');

  env.notifier.reset('s_a');
  await env.notifier.onSessionEvent(a, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(env.calls.length, 3, 'reset 后同 session 可再次推送');
});

test('turn/end：aborted / 子代理 / pushEnabled=false 一律跳过（静默）', async () => {
  const env = makeNotifier({ config: { pushEnabled: true } });
  await env.notifier.onSessionEvent(session('s_abort'), { type: 'turn/end', data: { reason: { kind: 'aborted' } } });
  await env.notifier.onSessionEvent({ id: 's_sub', header: { origin: 'subagent' } }, { type: 'turn/end', data: { reason: { kind: 'error' } } });
  assert.equal(env.calls.length, 0);

  const off = makeNotifier({ config: { pushEnabled: false } });
  await off.notifier.onSessionEvent(session('s_off'), { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  await off.notifier.onSessionEvent(session('s_off'), {
    type: 'tool/call',
    data: { callId: 'call_off', name: 'ask_user_question' },
  });
  assert.equal(off.calls.length, 0, '主机开关关闭时 turn/end 与问答都不推送');
  assert.equal(off.logs.length, 0, '开关关闭属于「静默跳过」，不刷日志');
  assert.equal(off.audits.length, 0, '静默跳过也不写审计');
});

test('ask_user_question：固定正文 + 按 callId 去重 + 不受 turn/end 冷却影响', async () => {
  const env = makeNotifier({ config: { pushEnabled: true, pushCooldownSeconds: 60 } });
  const s = session('s_q');
  await env.notifier.onSessionEvent(s, { type: 'session/title', data: { title: '修复登录 bug' } });
  const question = { type: 'tool/call', data: { turn: 0, step: 0, callId: 'call_1', name: 'ask_user_question' } };
  await env.notifier.onSessionEvent(s, question);
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].kind, PUSH_KINDS.WAITING_ANSWER);
  assert.equal(env.calls[0].body, QUESTION_WAITING_BODY);
  assert.equal(env.calls[0].body, '正在等待你的回答');
  assert.equal(env.calls[0].title, '修复登录 bug');
  assert.equal(env.calls[0].sessionId, 's_q');

  // 同一 callId 重放（事件流重连）不重复推送
  await env.notifier.onSessionEvent(s, question);
  assert.equal(env.calls.length, 1);

  // 新的 callId（第二次提问）应再次推送
  await env.notifier.onSessionEvent(s, { ...question, data: { ...question.data, callId: 'call_2' } });
  assert.equal(env.calls.length, 2);

  // turn/end 的 60s 冷却不影响同一会话的问答推送
  await env.notifier.onSessionEvent(s, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(env.calls.length, 3, 'turn/end 推送一次');
  await env.notifier.onSessionEvent(s, { type: 'tool/call', data: { callId: 'call_3', name: 'ask_user_question' } });
  assert.equal(env.calls.length, 4, 'turn/end 冷却期内仍应推送问答等待');
  assert.equal(env.calls[3].body, QUESTION_WAITING_BODY);
});

test('摘要兜底：失败无助手文本用状态文案，标题退回首条用户消息', async () => {
  const env = makeNotifier({ config: { pushEnabled: true } });
  const s = session('s_fallback');
  await env.notifier.onSessionEvent(s, { type: 'user/message', data: { content: [{ type: 'text', text: '跑一下部署脚本' }] } });
  await env.notifier.onSessionEvent(s, { type: 'turn/start', data: { turn: 1 } });
  await env.notifier.onSessionEvent(s, { type: 'turn/end', data: { reason: { kind: 'error' } } });
  assert.equal(env.calls.length, 1);
  assert.deepEqual(env.calls[0], {
    id: env.calls[0].id,
    kind: PUSH_KINDS.ERROR,
    title: '跑一下部署脚本',
    body: '任务出错，打开查看详情',
    sessionId: 's_fallback',
    content: 'generic',
  });

  // 失败但有助手文本 → 摘要前加 ⚠️
  const s2 = session('s_failure');
  await env.notifier.onSessionEvent(s2, { type: 'session/title', data: { title: '清理缓存' } });
  await env.notifier.onSessionEvent(s2, { type: 'turn/start', data: { turn: 2 } });
  await env.notifier.onSessionEvent(s2, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '缓存已清空，但部署步骤超时' }] } },
  });
  await env.notifier.onSessionEvent(s2, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } });
  assert.equal(env.calls.length, 2);
  assert.equal(env.calls[1].kind, PUSH_KINDS.ERROR);
  assert.equal(env.calls[1].body, '⚠️ 缓存已清空，但部署步骤超时');
});

test('分流结果：official 送达也算 sent；全部失败记 skipped；deliver 抛错只记日志/审计', async () => {
  // 只有 official 设备、hub 送达
  const officialEnv = makeNotifier({
    targets: { self: 0, official: 1 },
    summary: { self: { devices: 0, sent: 0 }, official: { devices: 1, sent: 1, failed: 0, pruned: 0 } },
  });
  await officialEnv.notifier.onSessionEvent(session('s_off1'), { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(officialEnv.calls.length, 1);
  assert.ok(officialEnv.audits.some((entry) => entry.result === 'sent'));
  assert.ok(officialEnv.logs.some((line) => line.includes('official=true')));

  // 全部失败 → skipped（不重试由运行时负责）
  const failEnv = makeNotifier({
    targets: { self: 1, official: 1 },
    summary: { self: { devices: 1, sent: 0 }, official: { devices: 1, sent: 0, failed: 1, pruned: 0 } },
  });
  await failEnv.notifier.onSessionEvent(session('s_fail'), { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.ok(failEnv.audits.some((entry) => entry.result === 'skipped'));

  // deliver 抛错：不冒泡、审计 skipped
  const throwEnv = makeNotifier({
    deliver: async () => { throw new Error('boom'); },
  });
  await throwEnv.notifier.onSessionEvent(session('s_throw'), { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.ok(throwEnv.logs.some((line) => line.includes('push trigger failed')));
  assert.ok(throwEnv.audits.some((entry) => entry.result === 'skipped'));
});
