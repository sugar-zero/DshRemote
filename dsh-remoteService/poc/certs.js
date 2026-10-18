import tls from 'node:tls';
import forge from 'node-forge';

/** 生成 POC 设备密钥 + CSR（模拟 App 端原生密钥/CSR）。 */
export function makeDeviceCsr(commonName = 'POC iPhone') {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: 'commonName', value: commonName }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  return {
    csrPem: forge.pki.certificationRequestToPem(csr),
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

/** 经 relay 发 HTTPS 请求（TLS 由主机插件终止；可带/不带客户端证书）。 */
export function httpsRequest({ port, servername, ca, cert, key, method = 'GET', path = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const socket = tls.connect({
      host: '127.0.0.1',
      port,
      servername,
      ca,
      cert,
      key,
      rejectUnauthorized: true,
      ALPNProtocols: ['http/1.1'],
    }, () => {
      const lines = [
        `${method} ${path} HTTP/1.1`,
        `Host: ${headers.Host ?? servername}`,
        'Connection: close',
      ];
      if (payload) lines.push(`Content-Length: ${payload.length}`);
      const merged = { ...headers };
      delete merged.Host;
      for (const [name, value] of Object.entries(merged)) lines.push(`${name}: ${value}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (payload) socket.write(payload);
    });
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const idx = raw.indexOf('\r\n\r\n');
      const head = idx >= 0 ? raw.slice(0, idx) : raw;
      const responseBody = idx >= 0 ? raw.slice(idx + 4) : '';
      const status = Number((head.split('\r\n')[0] ?? '').split(' ')[1] ?? 0);
      resolve({ status, head, body: responseBody });
    });
  });
}

export async function httpsJson(options) {
  const res = await httpsRequest({
    ...options,
    method: options.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let parsed;
  try { parsed = JSON.parse(res.body); } catch { parsed = undefined; }
  return { ...res, json: parsed, data: parsed?.data, error: parsed?.error };
}
