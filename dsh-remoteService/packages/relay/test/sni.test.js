import assert from 'node:assert/strict';
import test from 'node:test';
import { parseClientHello, MAX_CLIENT_HELLO_BYTES, SNI_STATUS } from '../lib/sni.js';
import { captureClientHello } from './helpers/certs.js';

test('parses SNI from a real (captured) ClientHello', async () => {
  const hello = await captureClientHello({ servername: 'poc.relay.test' });
  assert.ok(Buffer.isBuffer(hello));
  assert.equal(hello[0], 0x16, 'starts with a TLS handshake record');
  assert.ok(hello.length > 40);

  const result = parseClientHello(hello);
  assert.equal(result.status, SNI_STATUS.OK);
  assert.equal(result.sni, 'poc.relay.test');
});

test('reports absent SNI as ok with sni=null (client connected by IP)', async () => {
  const hello = await captureClientHello({ servername: undefined });
  const result = parseClientHello(hello);
  assert.equal(result.status, SNI_STATUS.OK);
  assert.equal(result.sni, null);
});

test('waits for fragmented ClientHello bytes (never mis-parses a prefix)', async () => {
  const hello = await captureClientHello({ servername: 'fragmented.relay.test' });

  let accumulated = Buffer.alloc(0);
  let sawIncomplete = false;
  let finalResult;
  for (let offset = 0; offset < hello.length; offset += 7) {
    accumulated = Buffer.concat([accumulated, hello.subarray(offset, Math.min(offset + 7, hello.length))]);
    const result = parseClientHello(accumulated);
    if (accumulated.length < hello.length) {
      assert.equal(result.status, SNI_STATUS.INCOMPLETE, 'prefix must be reported as incomplete');
      sawIncomplete = true;
    } else {
      finalResult = result;
    }
  }
  assert.ok(sawIncomplete);
  assert.equal(finalResult.status, SNI_STATUS.OK);
  assert.equal(finalResult.sni, 'fragmented.relay.test');
});

test('parses SNI when old handshake records are concatenated before the actual record', () => {
  // 覆盖多 record 收集路径：在真实 ClientHello 前面插一条空的 TLS record 头会非法，
  // 因此改为把真实 ClientHello 拆成两条 handshake record 再喂给解析器。
  return captureClientHello({ servername: 'multi.relay.test' }).then((hello) => {
    // 找到第一条 handshake record 的 payload，拆成两条 record 重新封装。
    const payload = hello.subarray(5, 5 + hello.readUInt16BE(3));
    const splitAt = Math.floor(payload.length / 2);
    const record = (fragment) => {
      const header = Buffer.alloc(5);
      header.writeUInt8(0x16, 0);
      header.writeUInt16BE(0x0301, 1);
      header.writeUInt16BE(fragment.length, 3);
      return Buffer.concat([header, fragment]);
    };
    const reRecorded = Buffer.concat([record(payload.subarray(0, splitAt)), record(payload.subarray(splitAt))]);
    const result = parseClientHello(reRecorded);
    assert.equal(result.status, SNI_STATUS.OK);
    assert.equal(result.sni, 'multi.relay.test');
  });
});

test('rejects non-TLS bytes', () => {
  const result = parseClientHello(Buffer.from('GET / HTTP/1.1\r\nHost: relay.test\r\n\r\n'));
  assert.equal(result.status, SNI_STATUS.INVALID);
  assert.match(result.reason, /not a TLS handshake record/);
});

test('returns incomplete for a short TLS prefix', () => {
  assert.equal(parseClientHello(Buffer.alloc(0)).status, SNI_STATUS.INCOMPLETE);
  assert.equal(parseClientHello(Buffer.from([0x16])).status, SNI_STATUS.INCOMPLETE);
  assert.equal(parseClientHello(Buffer.from([0x16, 0x03, 0x01, 0x00])).status, SNI_STATUS.INCOMPLETE);
});

test('rejects a handshake record that is not ClientHello', () => {
  // ServerHello (type 0x02) 形状的 record
  const header = Buffer.from([0x16, 0x03, 0x03, 0x00, 0x04]);
  const body = Buffer.from([0x02, 0x00, 0x00, 0x00]);
  const result = parseClientHello(Buffer.concat([header, body]));
  assert.equal(result.status, SNI_STATUS.INVALID);
  assert.match(result.reason, /expected ClientHello/);
});

test('exports the 64 KiB ClientHello cap', () => {
  assert.equal(MAX_CLIENT_HELLO_BYTES, 64 * 1024);
});
