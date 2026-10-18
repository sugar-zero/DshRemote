import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import forge from 'node-forge';
import { WebSocketServer } from 'ws';
import { withTempHome } from './helpers.js';

function serial() {
  return `01${forge.util.bytesToHex(forge.random.getBytesSync(15))}`;
}

function makeServerCert(fqdn, days) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + days * 86_400_000);
  cert.setSubject([{ name: 'commonName', value: fqdn }]);
  cert.setIssuer([{ name: 'commonName', value: fqdn }]);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: fqdn }] },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(keys.privateKey) };
}

test('RemoteService: TLS certificate rotation hot-reloads listener without restart', async () => {
  const home = withTempHome();
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.t === 'host.hello') {
          ws.send(JSON.stringify({ t: 'host.ready', protocolVersion: 1, hostId: msg.hostId, hostname: 'h_rotate.relay.test', domain: 'relay.test' }));
        }
      } catch { /* ignore */ }
    });
  });

  const cert1 = makeServerCert('h_rotate.relay.test', 30);
  const cert2 = makeServerCert('h_rotate.relay.test', 90);
  const certPath = `${home.dir}/rotation.crt.pem`;
  const keyPath = `${home.dir}/rotation.key.pem`;
  writeFileSync(certPath, cert1.certPem, { mode: 0o600 });
  writeFileSync(keyPath, cert1.keyPem, { mode: 0o600 });

  const { saveConfig } = await import('../lib/config.js');
  const { RemoteService } = await import('../lib/service.js');
  saveConfig({
    enabled: true,
    relayUrl: `ws://127.0.0.1:${wss.address().port}`,
    relayDomain: 'relay.test',
    hostId: 'h_rotate',
    hostToken: 'tok',
    hostName: 'Rotate Host',
    tlsCertFile: certPath,
    tlsKeyFile: keyPath,
    relayTlsInsecure: true,
  });
  const fakeCtx = {
    webServer: { protocol: 'http:', port: 1, getOrigin: () => 'http://127.0.0.1:1/' },
    connection: { authenticatedUrl: (origin) => `${origin}?token=test` },
    effect: (fn) => fn(),
    on: () => () => {},
  };
  const service = new RemoteService(fakeCtx);
  try {
    await service.ready;
    const first = service.status();
    assert.equal(first.host.tls.dev, false);
    assert.equal(first.host.tls.certFile, certPath);
    const firstNotAfter = first.host.tls.notAfter;
    const firstPort = service.listenPort;
    assert.ok(firstPort > 0);

    // 模拟 acme.sh 续期后覆盖证书文件，再调用热加载
    writeFileSync(certPath, cert2.certPem, { mode: 0o600 });
    writeFileSync(keyPath, cert2.keyPem, { mode: 0o600 });
    const rotated = await service.reloadTls();

    assert.equal(rotated.host.tls.valid, true);
    assert.notEqual(rotated.host.tls.notAfter, firstNotAfter, 'notAfter 应变为新证书');
    assert.notEqual(service.listenPort, firstPort, '监听应重建（新端口）');
    assert.equal(rotated.enabled, true);
  } finally {
    await service.dispose();
    await new Promise((resolve) => wss.close(resolve));
    home.cleanup();
  }
});
