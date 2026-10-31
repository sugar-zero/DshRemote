/**
 * 群体版边缘隧道请求头重写：强制 Connection: close，避免客户端 keep-alive 复用连接
 * 把后续请求（pairing → challenge）直接透传到主机明文代理（表现为「配对后立即 401」）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { forceEdgeTunnelHead } from '../lib/server.js';

test('edge tunnel head: keep-alive 被改写成 Connection: close', () => {
  const head = Buffer.from(
    [
      'POST /__group/auth/challenge HTTP/1.1',
      'Host: h_test.relay.test:1447',
      'Connection: keep-alive',
      'Proxy-Connection: keep-alive',
      'Content-Type: application/json',
      'Content-Length: 2',
      '',
      '',
    ].join('\r\n'),
    'latin1',
  );
  const rewritten = forceEdgeTunnelHead(head).toString('latin1');
  assert.match(rewritten, /\r\nConnection: close\r\n/);
  assert.equal((rewritten.match(/^connection:/gim) ?? []).length, 1);
  assert.doesNotMatch(rewritten.toLowerCase(), /proxy-connection|keep-alive/);
  assert.match(rewritten, /Content-Length: 2/);
});

test('edge tunnel head: Upgrade 请求保持原样（101 之后要双向透传）', () => {
  const head = Buffer.from(
    [
      'GET /api/remote.mux HTTP/1.1',
      'Host: h_test.relay.test:1447',
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      '',
      '',
    ].join('\r\n'),
    'latin1',
  );
  assert.deepEqual(forceEdgeTunnelHead(head), head);
});
