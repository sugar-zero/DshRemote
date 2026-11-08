/**
 * health 平面（httpPort）：0.3.0 起只保留 GET/HEAD /healthz，classic 的 301 跳转已删除。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createInvite, createRelay, registerHost } from '../index.js';
import { ControlClient } from './helpers/control-client.js';
import { silentLogger } from './helpers/certs.js';

/**
 * @param {number} port
 * @param {{method?: string, path?: string, hostHeader?: string}} [options]
 * @returns {Promise<{status: number, headers: http.IncomingHttpHeaders, body: string}>}
 */
function request(port, { method = 'GET', path = '/', hostHeader } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: hostHeader ? { host: hostHeader } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function tempGroup() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-relay-http-'));
  const file = join(dir, 'group.json');
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 起一个 group relay（dev/无 TLS，临时端口 + 临时 group.json）。 */
async function startHttpTestRelay(file) {
  return createRelay({
    domain: 'relay.test',
    controlPort: 0,
    httpPort: 0,
    listenHost: '127.0.0.1',
    dev: true,
    logger: silentLogger,
    group: { file, edge: { enabled: false } },
  });
}

test('GET /healthz returns 200 JSON with domain and online hosts', async () => {
  const temp = tempGroup();
  const relay = await startHttpTestRelay(temp.file);
  try {
    const response = await request(relay.httpPort, { path: '/healthz', hostHeader: 'relay.test' });
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], /application\/json/);
    assert.deepEqual(JSON.parse(response.body), {
      ok: true,
      domain: 'relay.test',
      hosts: [],
      // 0.3.1 起 /healthz 带服务端推送摘要（不含任何 token/密钥）。
      push: { enabled: false, mode: 'self', tokens: 0 },
    });
  } finally {
    await relay.close();
    temp.cleanup();
  }
});

test('HEAD /healthz returns 200 with empty body', async () => {
  const temp = tempGroup();
  const relay = await startHttpTestRelay(temp.file);
  try {
    const response = await request(relay.httpPort, { method: 'HEAD', path: '/healthz' });
    assert.equal(response.status, 200);
    assert.equal(response.body, '');
  } finally {
    await relay.close();
    temp.cleanup();
  }
});

test('/healthz lists online hosts and drops them after disconnect', async () => {
  const temp = tempGroup();
  const invite = createInvite(temp.file, {});
  const host = registerHost({ file: temp.file, inviteCode: invite.code, hostName: 'Health Host' });
  const relay = await startHttpTestRelay(temp.file);
  try {
    const client = await ControlClient.connect(`ws://127.0.0.1:${relay.controlPort}/control`);
    client.sendJson({ t: 'host.hello', protocolVersion: 1, hostId: host.hostId, token: host.hostToken });
    assert.equal((await client.nextJson()).t, 'host.ready');

    const online = await request(relay.httpPort, { path: '/healthz' });
    assert.deepEqual(JSON.parse(online.body).hosts, [host.hostId]);

    client.close();
    await client.waitClose();
    const deadline = Date.now() + 2000;
    let body = JSON.parse((await request(relay.httpPort, { path: '/healthz' })).body);
    while (body.hosts.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      body = JSON.parse((await request(relay.httpPort, { path: '/healthz' })).body);
    }
    assert.deepEqual(body.hosts, [], 'offline host must disappear from /healthz');
  } finally {
    await relay.close();
    temp.cleanup();
  }
});

test('non-health paths return 404 (classic 301 redirect removed)', async () => {
  const temp = tempGroup();
  const relay = await startHttpTestRelay(temp.file);
  try {
    for (const options of [
      { path: '/', hostHeader: 'relay.test' },
      { path: '/__admin/', hostHeader: 'relay.test' },
      { path: '/?foo=bar', hostHeader: 'relay.test' },
      { method: 'POST', path: '/healthz' },
    ]) {
      const response = await request(relay.httpPort, options);
      assert.equal(response.status, 404, `${options.method ?? 'GET'} ${options.path} must be 404`);
      assert.equal(response.headers.location, undefined, 'no classic 301 Location header');
      assert.equal(JSON.parse(response.body).error.code, 'not_found');
    }
  } finally {
    await relay.close();
    temp.cleanup();
  }
});
