import test from 'node:test';
import assert from 'node:assert/strict';
import { createWsFrameScanner, buildMaskedPongFrame, WS_OPCODE_PING, WS_OPCODE_PONG } from '../lib/ws-keepalive.js';

/** 构造一个 RFC 6455 帧（用于喂扫描器）。 */
function wsFrame(opcode, payload, { fin = true, masked = false } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '');
  let lenCode;
  const ext = [];
  if (body.length < 126) lenCode = body.length;
  else if (body.length < 65536) {
    lenCode = 126;
    const b = Buffer.alloc(2);
    b.writeUInt16BE(body.length, 0);
    ext.push(b);
  } else {
    lenCode = 127;
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(body.length), 0);
    ext.push(b);
  }
  const parts = [Buffer.from([(fin ? 0x80 : 0) | opcode, (masked ? 0x80 : 0) | lenCode]), ...ext];
  if (masked) {
    const mask = Buffer.from([1, 2, 3, 4]);
    parts.push(mask);
    const maskedBody = Buffer.alloc(body.length);
    for (let i = 0; i < body.length; i += 1) maskedBody[i] = body[i] ^ mask[i & 3];
    parts.push(maskedBody);
  } else {
    parts.push(body);
  }
  return Buffer.concat(parts);
}

function collectScanner() {
  const frames = [];
  const scan = createWsFrameScanner((frame) => frames.push(frame));
  return { frames, scan };
}

/** 把 buffer 按给定切分喂进去。 */
function feedAll(scan, buffer, cuts) {
  let at = 0;
  for (const size of cuts) {
    if (at >= buffer.length) break;
    scan(buffer.subarray(at, Math.min(buffer.length, at + size)));
    at = Math.min(buffer.length, at + size);
  }
  if (at < buffer.length) scan(buffer.subarray(at));
}

test('ws 帧扫描器：ping 被字节级切分也能识别', () => {
  const { frames, scan } = collectScanner();
  const ping = wsFrame(WS_OPCODE_PING, 'hi');
  for (const byte of ping) scan(Buffer.from([byte]));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].opcode, WS_OPCODE_PING);
  assert.equal(frames[0].payload.toString(), 'hi');
});

test('ws 帧扫描器：跳过 200KB 数据帧后仍能识别 ping（不缓存大 payload）', () => {
  const { frames, scan } = collectScanner();
  const big = Buffer.alloc(200 * 1024, 0x41);
  const stream = Buffer.concat([wsFrame(0x1, big), wsFrame(WS_OPCODE_PING, Buffer.from('after'))]);
  // 以 7KB 不规则切分喂入
  feedAll(scan, stream, Array.from({ length: 40 }, (_, i) => 1000 + (i % 7) * 1000));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].opcode, WS_OPCODE_PING);
  assert.equal(frames[0].payload.toString(), 'after');
});

test('ws 帧扫描器：64 位长度的大数据帧（>65535B）', () => {
  const { frames, scan } = collectScanner();
  const big = Buffer.alloc(70000, 0x42);
  const stream = Buffer.concat([wsFrame(0x1, big), wsFrame(WS_OPCODE_PING, 'x')]);
  feedAll(scan, stream, [1, 2, 3, 100, 5000, 65535, 1234]);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.toString(), 'x');
});

test('ws 帧扫描器：分片消息中间夹 ping（控制帧允许分片间出现）', () => {
  const { frames, scan } = collectScanner();
  const stream = Buffer.concat([
    wsFrame(0x1, 'hello', { fin: false }),
    wsFrame(WS_OPCODE_PING, 'mid'),
    wsFrame(0x0, ' world', { fin: true }),
  ]);
  scan(stream);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].opcode, WS_OPCODE_PING);
  assert.equal(frames[0].payload.toString(), 'mid');
});

test('ws 帧扫描器：理论上被 mask 的控制帧会先解 mask 再回调', () => {
  const { frames, scan } = collectScanner();
  scan(wsFrame(WS_OPCODE_PING, 'm', { masked: true }));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.toString(), 'm');
});

test('ws 帧扫描器：零长度 ping', () => {
  const { frames, scan } = collectScanner();
  scan(wsFrame(WS_OPCODE_PING, ''));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].opcode, WS_OPCODE_PING);
  assert.equal(frames[0].payload.length, 0);
});

test('ws 帧扫描器：非法控制帧抛出异常（调用方可停用扫描回退为纯透传）', () => {
  const { scan } = collectScanner();
  // 控制帧 payload 超过 125 字节是协议错误
  assert.throws(() => scan(wsFrame(WS_OPCODE_PING, Buffer.alloc(200))), /控制帧不合法/);
});

test('buildMaskedPongFrame：masked、opcode=0xA、payload 回显正确', () => {
  const payload = Buffer.from('echo-me');
  const frame = buildMaskedPongFrame(payload);
  assert.equal(frame[0], 0x80 | WS_OPCODE_PONG);
  assert.ok((frame[1] & 0x80) !== 0, '客户端帧必须 masked');
  const len = frame[1] & 0x7f;
  assert.equal(len, payload.length);
  const mask = frame.subarray(2, 6);
  const body = frame.subarray(6, 6 + len);
  const unmasked = Buffer.alloc(len);
  for (let i = 0; i < len; i += 1) unmasked[i] = body[i] ^ mask[i & 3];
  assert.deepEqual(unmasked, payload);
});

test('buildMaskedPongFrame：空 payload 也合法', () => {
  const frame = buildMaskedPongFrame();
  assert.equal(frame.length, 6);
  assert.equal(frame[0], 0x8a);
  assert.equal(frame[1], 0x80);
});
