import test from 'node:test';
import assert from 'node:assert/strict';
import {
  base32Encode,
  buildPairingUri,
  decodeFrame,
  encodeFrame,
  FRAME_TYPE,
  pairingSas,
  parsePairingUri,
  safeEqualStrings,
  shortFingerprint,
} from '../index.js';

test('pairing URI roundtrip keeps full fingerprint and expiry', () => {
  const uri = buildPairingUri({
    host: 'h_abc.relay.example.com',
    secret: 'secret-value',
    hostFingerprint: 'Zm9vYmFy',
    expiresAt: 1_800_000_000_000,
    relayDomain: 'relay.example.com',
  });
  assert.ok(!uri.includes('\n'));
  const parsed = parsePairingUri(uri);
  assert.equal(parsed.host, 'h_abc.relay.example.com');
  assert.equal(parsed.secret, 'secret-value');
  assert.equal(parsed.hostFingerprint, 'Zm9vYmFy');
  assert.equal(parsed.expiresAt, 1_800_000_000_000);
  assert.equal(parsed.relayDomain, 'relay.example.com');
});

test('pairing URI rejects wrong scheme/version', () => {
  assert.throws(() => parsePairingUri('https://pair?v=1&host=x&secret=y&hostfp=z&exp=1'));
  assert.throws(() => parsePairingUri('dshremote://pair?v=2&host=x&secret=y&hostfp=z&exp=1'));
});

test('base32 code is 12 chars and unambiguous alphabet', () => {
  const code = base32Encode(Buffer.from('0123456789abcdef0123456789abcdef01234567', 'hex'), 12);
  assert.equal(code.length, 12);
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{12}$/);
});

test('SAS binds host and device keys', () => {
  const a = pairingSas('secret', 'hostA', 'deviceA');
  assert.match(a, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal(a, pairingSas('secret', 'hostA', 'deviceA'));
  assert.notEqual(a, pairingSas('secret', 'hostB', 'deviceA'));
  assert.notEqual(a, pairingSas('secret', 'hostA', 'deviceB'));
});

test('frame encode/decode', () => {
  const frame = encodeFrame(FRAME_TYPE.DATA, 42, Buffer.from('hello'));
  const decoded = decodeFrame(frame);
  assert.equal(decoded.type, FRAME_TYPE.DATA);
  assert.equal(decoded.streamId, 42);
  assert.equal(decoded.payload.toString(), 'hello');
  assert.equal(decodeFrame(Buffer.from([1, 2])), undefined);
});

test('safeEqualStrings handles unequal lengths without throwing', () => {
  assert.equal(safeEqualStrings('abc', 'abc'), true);
  assert.equal(safeEqualStrings('abc', 'abcd'), false);
  assert.equal(safeEqualStrings('', 'x'), false);
});

test('shortFingerprint groups', () => {
  assert.equal(shortFingerprint('ABCDEFGHIJKLMNOP', 2, 4), 'ABCD · EFGH');
});
