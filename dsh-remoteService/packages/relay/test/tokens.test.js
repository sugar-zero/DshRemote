/**
 * hostId / host token 辅助（群体版）。
 *
 * 0.3.0 起 classic 的 tokens.json 存储/CLI 已删除，只保留群体版注册用到的
 * hostId 规范化/校验与 host token 随机生成。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { HOST_TOKEN_BYTES, generateHostToken, isValidHostId, normalizeHostId } from '../index.js';

test('normalizeHostId enforces DNS-label-safe ids', () => {
  assert.equal(normalizeHostId('  H_AB12cd34 '), 'h_ab12cd34');
  assert.equal(normalizeHostId('h_ab12cd34'), 'h_ab12cd34');
  for (const bad of ['', '-abc', 'abc-', 'a b', 'ab.cd', 'a'.repeat(64), 'h_中文']) {
    assert.throws(() => normalizeHostId(bad), /invalid hostId/);
    assert.equal(isValidHostId(bad), false);
  }
  assert.equal(isValidHostId('h_ab12cd34'), true);
  assert.equal(isValidHostId('abc'), true);
});

test('generateHostToken returns 32-byte base64url tokens (unique per call)', () => {
  const first = generateHostToken();
  const second = generateHostToken();
  assert.equal(Buffer.from(first, 'base64url').length, HOST_TOKEN_BYTES);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
});
