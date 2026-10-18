import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createRelay } from '../index.js';
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

async function startHttpTestRelay() {
  return createRelay({
    domain: 'relay.test',
    dataPort: 0,
    controlPort: 0,
    httpPort: 0,
    dataHost: '127.0.0.1',
    dev: true,
    hostTokens: { poc: 'token' },
    logger: silentLogger,
  });
}

test('GET /healthz returns 200 JSON with domain and online hosts', async () => {
  const relay = await startHttpTestRelay();
  try {
    const response = await request(relay.httpPort, { path: '/healthz', hostHeader: 'relay.test' });
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], /application\/json/);
    assert.deepEqual(JSON.parse(response.body), { ok: true, domain: 'relay.test', hosts: [], pushTokens: 0 });
  } finally {
    await relay.close();
  }
});

test('HEAD /healthz returns 200 with empty body', async () => {
  const relay = await startHttpTestRelay();
  try {
    const response = await request(relay.httpPort, { method: 'HEAD', path: '/healthz', hostHeader: 'relay.test' });
    assert.equal(response.status, 200);
    assert.equal(response.body, '');
  } finally {
    await relay.close();
  }
});

test('all other requests are 301-redirected to https://<host><path>', async () => {
  const relay = await startHttpTestRelay();
  try {
    const hostUnique = await request(relay.httpPort, {
      path: '/some/path?x=1&y=2',
      hostHeader: 'poc.relay.test:80',
    });
    assert.equal(hostUnique.status, 301);
    assert.equal(hostUnique.headers.location, 'https://poc.relay.test/some/path?x=1&y=2');

    const bare = await request(relay.httpPort, { path: '/', hostHeader: 'relay.test' });
    assert.equal(bare.status, 301);
    assert.equal(bare.headers.location, 'https://relay.test/');

    // 非 GET 的 /healthz 也走 301（健康检查只认 GET/HEAD）
    const post = await request(relay.httpPort, { method: 'POST', path: '/healthz', hostHeader: 'relay.test' });
    assert.equal(post.status, 301);
    assert.equal(post.headers.location, 'https://relay.test/healthz');
  } finally {
    await relay.close();
  }
});
