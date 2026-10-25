import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPushSummaryTracker,
  extractMessageText,
  messageTextOfEvent,
  normalizeText,
  truncateText,
} from '../lib/push-summary.js';

test('push summary: extractMessageText only joins text blocks', () => {
  const message = {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: '内部推理不应进通知' },
      { type: 'text', text: '第一段' },
      { type: 'tool-call', id: 'c1', name: 'bash' },
      { type: 'text', text: '第二段' },
    ],
  };
  assert.equal(extractMessageText(message), '第一段\n第二段');
  assert.equal(extractMessageText({ content: [{ type: 'image' }] }), '');
  assert.equal(extractMessageText(null), '');
});

test('push summary: messageTextOfEvent handles user/message and assistant/message shapes', () => {
  assert.equal(
    messageTextOfEvent({ type: 'user/message', data: { content: [{ type: 'text', text: '帮我修一下登录' }] } }),
    '帮我修一下登录',
  );
  assert.equal(
    messageTextOfEvent({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '已修复' }] } } }),
    '已修复',
  );
  assert.equal(messageTextOfEvent({ type: 'turn/end' }), '');
});

test('push summary: normalize/truncate collapse whitespace and stay code-point safe', () => {
  assert.equal(normalizeText('  a\n\tb   全角\u3000空格  '), 'a b 全角 空格');
  assert.equal(truncateText(''.padEnd(0), 10), '');
  assert.equal(truncateText('a'.repeat(200), 10), `${'a'.repeat(9)}…`);
  assert.equal(Array.from(truncateText('😀😀😀', 2)).length, 2, '不能把 surrogate pair 切开');
  assert.equal(truncateText('短文本', 60), '短文本');
});

test('push summary tracker: title + per-turn assistant summary, fallbacks, subagent ignored', () => {
  const tracker = createPushSummaryTracker({ maxSessions: 2 });
  const session = { id: 's_1', header: { origin: 'chat' } };

  // 无标题时标题退回首条用户消息；无助手文本时正文用状态兜底
  tracker.observe(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一问' }] } });
  assert.deepEqual(tracker.compose(session, { kind: 'completed' }), { title: '第一问', body: '本轮已完成，打开查看结果' });

  // 标题事件优先后续使用；assistant/message 作为正文
  tracker.observe(session, { type: 'session/title', data: { title: '修复登录 bug' } });
  tracker.observe(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '已经修好了' }] } } });
  assert.deepEqual(tracker.compose(session, { kind: 'completed' }), { title: '修复登录 bug', body: '已经修好了' });

  // turn/start 清空上一轮摘要（避免新轮次通知显示旧回复）
  tracker.observe(session, { type: 'turn/start', data: { turn: 1 } });
  assert.deepEqual(tracker.compose(session), { title: '修复登录 bug', body: '本轮已完成，打开查看结果' });

  // 失败时：有摘要加 ⚠️，无摘要用失败兜底
  tracker.observe(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '部署步骤超时了' }] } } });
  assert.deepEqual(tracker.compose(session, { kind: 'failure' }), { title: '修复登录 bug', body: '⚠️ 部署步骤超时了' });
  const empty = { id: 's_empty', header: {} };
  tracker.observe(empty, { type: 'turn/start', data: { turn: 0 } });
  assert.deepEqual(tracker.compose(empty, { kind: 'failure' }), { title: 'DSH', body: '任务出错，打开查看详情' });

  // 子代理会话不跟踪
  tracker.observe({ id: 's_sub', header: { origin: 'subagent' } }, { type: 'session/title', data: { title: '不应出现' } });
  assert.equal(tracker.size(), 2);

  // LRU 上限：新会话挤掉最旧的
  tracker.observe({ id: 's_2', header: {} }, { type: 'session/title', data: { title: '第二个' } });
  assert.equal(tracker.size(), 2);
  assert.equal(tracker.compose({ id: 's_1' }).title, 'DSH', '最旧会话应被淘汰');

  // forget 清理
  tracker.forget('s_2');
  assert.equal(tracker.size(), 1);
});

test('push summary tracker: hydrates resumed sessions from snapshotEvents', () => {
  const history = [
    { type: 'user/message', data: { content: [{ type: 'text', text: '旧问题' }] } },
    { type: 'session/title', data: { title: '旧标题' } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '旧回复' }] } } },
  ];
  const session = { id: 's_resumed', header: {}, snapshotEvents: () => history };
  const tracker = createPushSummaryTracker();

  // 模拟插件在会话中途加载：第一次见到的是 turn/end，没有历史事件流
  tracker.observe(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.deepEqual(tracker.compose(session), { title: '旧标题', body: '旧回复' });

  // 新 turn 开始后不再沿用上一轮摘要
  tracker.observe(session, { type: 'turn/start', data: { turn: 1 } });
  assert.deepEqual(tracker.compose(session), { title: '旧标题', body: '本轮已完成，打开查看结果' });
});

test('push summary tracker: honors configured truncation limits', () => {
  const tracker = createPushSummaryTracker({ maxTitleChars: 6, maxBodyChars: 8 });
  const session = { id: 's_trim', header: {} };
  tracker.observe(session, { type: 'session/title', data: { title: '这是一个很长的会话标题' } });
  tracker.observe(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '这是一个很长的助手回复摘要' }] } } });
  const content = tracker.compose(session);
  assert.equal(Array.from(content.title).length, 6);
  assert.ok(content.title.endsWith('…'));
  assert.equal(Array.from(content.body).length, 8);
  assert.ok(content.body.endsWith('…'));
});
