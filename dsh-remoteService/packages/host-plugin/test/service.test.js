import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import forge from 'node-forge';
import { WebSocketServer } from 'ws';
import { RESTART_PATH } from 'dsh-remote-protocol';
import { makeCsr, tlsRequest, withTempHome } from './helpers.js';

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

    // 热加载到「证书与私钥不匹配」：停止监听，且不能继续显示旧证书「有效」
    writeFileSync(certPath, cert2.certPem, { mode: 0o600 });
    writeFileSync(keyPath, cert1.keyPem, { mode: 0o600 });
    const broken = await service.reloadTls();
    assert.match(broken.relay.lastError, /证书与私钥不匹配/);
    assert.equal(service.listenPort, 0);
    assert.equal(broken.host.tls.valid, false);
    assert.equal(broken.host.tls.certFile, certPath);
  } finally {
    await service.dispose();
    await new Promise((resolve) => wss.close(resolve));
    home.cleanup();
  }
});

test('RemoteService: TLS 证书与私钥不匹配时给出可读错误，且不启动监听/中继', async () => {
  const home = withTempHome();
  try {
    const leaf = makeServerCert('h_badkey.relay.test', 30);
    const other = makeServerCert('h_badkey.relay.test', 30);
    const certPath = `${home.dir}/bad-cert.pem`;
    const keyPath = `${home.dir}/bad-key.pem`;
    writeFileSync(certPath, leaf.certPem, { mode: 0o600 });
    writeFileSync(keyPath, other.keyPem, { mode: 0o600 });

    const { saveConfig } = await import('../lib/config.js');
    const { RemoteService } = await import('../lib/service.js');
    saveConfig({
      enabled: true,
      relayUrl: 'ws://127.0.0.1:1',
      relayDomain: 'relay.test',
      hostId: 'h_badkey',
      hostToken: 'tok',
      hostName: 'Bad Key Host',
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
      const status = service.status();
      assert.match(status.relay.lastError, /证书与私钥不匹配/);
      assert.match(status.relay.lastError, /fullchain\.pem/);
      assert.equal(status.relay.connected, false);
      assert.equal(service.listenPort, 0);
      assert.equal(status.host.tls.valid, false);
    } finally {
      await service.dispose();
    }
  } finally {
    home.cleanup();
  }
});

test('RemoteService: 装配远程重启端点（去重 + 审计 + 注入 spawn，绝不真的重启）', async () => {
  const home = withTempHome();
  const spawnCalls = [];
  const fakeSpawn = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    return { pid: 1, unref: () => {} };
  };
  const restartEnv = {};
  let service;
  try {
    const { saveConfig } = await import('../lib/config.js');
    const { RemoteService } = await import('../lib/service.js');
    const { paths } = await import('../lib/paths.js');
    saveConfig({
      enabled: true,
      relayUrl: 'ws://127.0.0.1:1',
      relayDomain: 'relay.test',
      hostId: 'h_restart',
      hostToken: 'tok',
      hostName: 'Restart Host',
      relayTlsInsecure: true,
    });
    const fakeCtx = {
      webServer: { protocol: 'http:', port: 1, getOrigin: () => 'http://127.0.0.1:1/' },
      connection: { authenticatedUrl: (origin) => `${origin}?token=test` },
      effect: (fn) => fn(),
      on: () => () => {},
    };
    // spawnHostRestart 注入 fake：若注入没生效，这里会真的去杀测试进程，测试直接炸掉暴露问题。
    service = new RemoteService(fakeCtx, { spawnHostRestart: fakeSpawn, hostRestartEnv: restartEnv });
    await service.ready;
    assert.ok(service.listenPort > 0);
    const { readFileSync: readPkg } = await import('node:fs');
    const pkgVersion = JSON.parse(readPkg(new URL('../package.json', import.meta.url), 'utf8')).version;
    assert.equal(service.status().version, pkgVersion, '管理 API 展示的版本应与 package.json 一致');

    // 签一台设备证书并加入注册表（相当于已完成配对）
    const { signDeviceCertificate } = await import('../lib/identity.js');
    const deviceCsr = makeCsr('Restart iPhone');
    const signed = signDeviceCertificate({ ca: service.ca, csrPem: deviceCsr.csrPem, deviceId: 'd_restart', commonName: 'Restart iPhone' });
    service.devices.add({ id: 'd_restart', name: 'Restart iPhone', platform: 'ios', serial: signed.serial, notAfter: signed.notAfter });

    const fqdn = 'h_restart.relay.test';
    const devCertPem = readFileSync(paths.devTlsCert(), 'utf8');
    const request = (options) => tlsRequest({
      port: service.listenPort,
      servername: fqdn,
      caPem: devCertPem,
      certPem: signed.certPem,
      keyPem: deviceCsr.privateKeyPem,
      ...options,
    });

    // 第一次：进入调度（spawn 为 fake，且断言 helper 脚本针对当前测试进程 pid）
    const first = await request({ method: 'POST', path: RESTART_PATH });
    assert.equal(first.status, 202);
    assert.equal(JSON.parse(first.body).data.mode, 'node', '测试进程是 Node CLI，应为 node 模式');
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].command, '/bin/sh');
    assert.equal(spawnCalls[0].args[0], '-c');
    assert.ok(spawnCalls[0].args[1].includes(`kill -TERM ${process.pid}`));
    assert.equal(spawnCalls[0].options.detached, true);

    // 第二次（10s 去重窗口内）：仍 202，但不得再调度一次
    const second = await request({ method: 'POST', path: RESTART_PATH });
    assert.equal(second.status, 202);
    assert.equal(JSON.parse(second.body).data.mode, 'node');
    assert.equal(spawnCalls.length, 1, '去重窗口内不得再次调度');

    // 审计：每次请求一条 host-restart（tail 是「最新在前」）
    const entries = service.audit.tail(20).filter((entry) => entry.action === 'host-restart');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].deviceId, 'd_restart');
    assert.equal(entries[0].result, 'accepted');
    assert.equal(entries[0].hash, 'deduped');
    assert.equal(entries[1].hash, 'node');
  } finally {
    await service?.dispose();
    home.cleanup();
  }
});
