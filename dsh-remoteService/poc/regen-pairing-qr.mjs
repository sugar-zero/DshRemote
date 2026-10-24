// 为本地 iPhone 联调重新生成配对二维码（ttl 120s）。
import http from 'node:http';
import zlib from 'node:zlib';
import { writeFileSync, readFileSync } from 'node:fs';
import qrcode from 'qrcode-generator';

const WEB_URL = process.argv[2]; // http://127.0.0.1:65487/?token=...
const OUT = process.argv[3] || './mockups/local-pairing-qr.png';
if (!WEB_URL) { console.error('usage: regen-pairing-qr.mjs <dsh-web-url-with-token> [out.png]'); process.exit(2); }

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end();
  });
}
function crc32(buf) {
  let c; const table = [];
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function writeQrPng(uri, path) {
  const qr = qrcode(0, 'M'); qr.addData(uri); qr.make();
  const count = qr.getModuleCount(); const scale = 10; const margin = 4;
  const size = (count + margin * 2) * scale;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / scale) - margin; const my = Math.floor(y / scale) - margin;
      const dark = mx >= 0 && my >= 0 && mx < count && my < count && qr.isDark(my, mx);
      const v = dark ? 0 : 255; const off = y * (size * 3 + 1) + 1 + x * 3;
      raw[off] = v; raw[off + 1] = v; raw[off + 2] = v;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
  writeFileSync(path, png);
}

const tokenRes = await request(WEB_URL);
const cookie = (tokenRes.headers['set-cookie'] ?? []).map((c) => String(c).split(';')[0]).join('; ');
if (!cookie) throw new Error('token exchange failed');
const base = new URL(WEB_URL).origin;
const headers = { cookie };
await request(`${base}/api/remote-access/pairing/cancel`, { method: 'POST', headers }).catch(() => {});
const start = await request(`${base}/api/remote-access/pairing/start`, { method: 'POST', headers });
if (start.status >= 400) throw new Error(`pairing/start -> ${start.status} ${start.body}`);
const data = JSON.parse(start.body).data;
writeQrPng(data.uri, OUT);
writeFileSync('/tmp/pairing-uri.txt', data.uri + '\n');
console.log('PAIRING_URI=' + data.uri);
console.log('CODE=' + (data.code ?? ''));
console.log('EXPIRES_AT=' + new Date(data.expiresAt).toISOString());
console.log('QR=' + OUT);
