import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTempHome } from './helpers.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 自托管 APNs 端到端（不联网）：
 * session turn/end → RemoteService → 注入的 APNs 发送器 → 断言会话摘要 payload；
 * 再模拟 APNs 410 → 失效 token 从内存与 push-tokens.json 清理。
 */
test('self-hosted APNs end-to-end: turn end -> host APNs push -> invalid token pruned', async () => {
  const home = withTempHome();
  const keyDir = mkdtempSync(join(tmpdir(), 'dsh-apns-e2e-'));
  const keyPath = join(keyDir, 'AuthKey_TEST.p8');
  try {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });

    const pushes = [];
    let prunedEntries = [];
    const fakeClient = {
      isConfigured: () => true,
      error: null,
      sendToTokens: async (entries, message) => {
        pushes.push({ entries, message });
        const pruned = prunedEntries;
        return {
          delivered: Math.max(0, entries.length - pruned.length),
          failed: pruned.length,
          pruned,
          configErrors: [],
          errors: [],
        };
      },
    };

    const { saveConfig } = await import('../lib/config.js');
    const { paths, writeJson } = await import('../lib/paths.js');
    const { RemoteService } = await import('../lib/service.js');
    saveConfig({
      enabled: true,
      relayUrl: 'ws://127.0.0.1:1',
      relayDomain: 'relay.test',
      hostId: 'h_apns',
      hostToken: 'tok',
      hostName: 'APNs Host',
      relayTlsInsecure: true,
      pushEnabled: true,
      pushCooldownSeconds: 0,
      pushProvider: 'apns',
      apnsKeyFile: keyPath,
      apnsKeyId: 'ABC123DEF4',
      apnsTeamId: 'TEAM123456',
      apnsTopic: 'com.example.dshremote',
    });
    writeJson(paths.pushTokens(), {
      version: 1,
      tokens: [{ deviceId: 'd_apns', provider: 'apns', token: 'a'.repeat(64), environment: 'development' }],
    });

    const handlers = new Map();
    const fakeCtx = {
      webServer: { protocol: 'http:', port: 1, getOrigin: () => 'http://127.0.0.1:1/' },
      connection: { authenticatedUrl: (origin) => `${origin}?token=test` },
      effect: (fn) => fn(),
      on: (event, handler) => {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
    };
    const service = new RemoteService(fakeCtx, { createApnsClient: () => fakeClient });
    try {
      await service.ready;
      const status = service.status();
      assert.equal(status.push.provider, 'apns');
      assert.equal(status.push.configured, true);
      assert.deepEqual(status.push.warnings, []);

      const onSessionEvent = handlers.get('session/event');
      assert.equal(typeof onSessionEvent, 'function');
      const session = { id: 's_apns', header: { origin: 'chat' } };
      // 通知标题/正文应来自实际会话事件（标题 + 最后一条助手回复）
      await onSessionEvent(session, { type: 'session/title', data: { title: '修复登录 bug' } });
      await onSessionEvent(session, {
        type: 'assistant/message',
        data: { turn: 0, step: 0, stream: [], message: { role: 'assistant', content: [{ type: 'text', text: '已修好登录重定向，跑完测试' }] } },
      });
      await onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
      let deadline = Date.now() + 3000;
      while (pushes.length === 0 && Date.now() < deadline) await sleep(20);
      assert.equal(pushes.length, 1, 'turn/end 应触发一次 APNs 推送');
      assert.deepEqual(pushes[0].entries.map((entry) => ({
        deviceId: entry.deviceId,
        provider: entry.provider,
        token: entry.token,
        environment: entry.environment,
      })), [{ deviceId: 'd_apns', provider: 'apns', token: 'a'.repeat(64), environment: 'development' }]);
      assert.deepEqual(pushes[0].message, {
        kind: 'attention',
        title: '修复登录 bug',
        body: '已修好登录重定向，跑完测试',
        sessionId: 's_apns',
        host: 'h_apns.relay.test',
      });

      const auditFile = join(home.dir, 'remote-access', 'audit.jsonl');
      let auditText = '';
      deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        try { auditText = readFileSync(auditFile, 'utf8'); } catch { auditText = ''; }
        if (auditText.includes('push-trigger')) break;
        await sleep(20);
      }
      assert.match(auditText, /"action":"push-trigger"/);
      assert.match(auditText, /"result":"sent"/);

      // APNs 410：清理失效 token（内存 + 文件）；条目是实际失败的那个 token
      prunedEntries = [{ deviceId: 'd_apns', token: 'a'.repeat(64) }];
      await onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } });
      await onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'error' } } });
      deadline = Date.now() + 3000;
      while (service.pushTokens.size > 0 && Date.now() < deadline) await sleep(20);
      assert.equal(service.pushTokens.size, 0, '失效 token 应从内存移除');
      const stored = JSON.parse(readFileSync(paths.pushTokens(), 'utf8'));
      assert.equal(stored.tokens.length, 0, '失效 token 也应从 push-tokens.json 移除');
      assert.match(readFileSync(auditFile, 'utf8'), /"action":"push-token-pruned"/);
    } finally {
      await service.dispose();
    }
  } finally {
    home.cleanup();
    rmSync(keyDir, { recursive: true, force: true });
  }
});

/**
 * 清理竞态防护：APNs 发送在途时设备可能已经重新注册/轮换 token（新 token 写入内存）。
 * 旧 token 的 410 不能把新 token 删掉；只有「存储的 token === 失败的那个 token」才清。
 * 走真实 RemoteService + pushNotifier 路径（APNs 发送器注入，不联网）。
 */
test('self-hosted APNs prune is rotation-safe: only the exact failed token is removed', async () => {
  const home = withTempHome();
  const keyDir = mkdtempSync(join(tmpdir(), 'dsh-apns-rotate-'));
  const keyPath = join(keyDir, 'AuthKey_TEST.p8');
  const tokenOld = 'a'.repeat(64);
  const tokenNew = 'b'.repeat(64);
  try {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });

    const { saveConfig } = await import('../lib/config.js');
    const { paths, writeJson } = await import('../lib/paths.js');
    const { RemoteService } = await import('../lib/service.js');
    saveConfig({
      enabled: true,
      relayUrl: 'ws://127.0.0.1:1',
      relayDomain: 'relay.test',
      hostId: 'h_rotate',
      hostToken: 'tok',
      hostName: 'Rotate Host',
      relayTlsInsecure: true,
      pushEnabled: true,
      pushCooldownSeconds: 0,
      pushProvider: 'apns',
      apnsKeyFile: keyPath,
      apnsKeyId: 'ABC123DEF4',
      apnsTeamId: 'TEAM123456',
      apnsTopic: 'com.example.dshremote',
    });
    writeJson(paths.pushTokens(), {
      version: 1,
      tokens: [{ deviceId: 'd_rot', provider: 'apns', token: tokenOld, environment: 'development' }],
    });

    const handlers = new Map();
    const fakeCtx = {
      webServer: { protocol: 'http:', port: 1, getOrigin: () => 'http://127.0.0.1:1/' },
      connection: { authenticatedUrl: (origin) => `${origin}?token=test` },
      effect: (fn) => fn(),
      on: (event, handler) => {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
    };

    const seenTokens = [];
    let phase = 0;
    let service;
    const fakeClient = {
      isConfigured: () => true,
      error: null,
      sendToTokens: async (entries) => {
        seenTokens.push(entries.map((entry) => entry.token));
        if (phase === 0) {
          // 发送在途：设备重新注册了一个新 token（模拟 token 轮换），随后旧 token 的 410 才回来。
          service.pushTokens.set('d_rot', { deviceId: 'd_rot', provider: 'apns', token: tokenNew, environment: 'development' });
          return { delivered: 0, failed: 1, pruned: [{ deviceId: 'd_rot', token: tokenOld }], configErrors: [], errors: [] };
        }
        return { delivered: 0, failed: 1, pruned: [{ deviceId: 'd_rot', token: tokenNew }], configErrors: [], errors: [] };
      },
    };

    service = new RemoteService(fakeCtx, { createApnsClient: () => fakeClient });
    try {
      await service.ready;
      const onSessionEvent = handlers.get('session/event');
      assert.equal(typeof onSessionEvent, 'function');
      const session = { id: 's_rot', header: { origin: 'chat' } };

      // 第一次推送：旧 token 的 410 回来时，存储的已经是新 token → 不能删。
      await onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
      let deadline = Date.now() + 3000;
      while (seenTokens.length === 0 && Date.now() < deadline) await sleep(20);
      assert.deepEqual(seenTokens[0], [tokenOld]);
      // 等推送流程走完（服务在清理尝试后才写 push-trigger 审计）再断言 token 仍在。
      const auditPath = join(home.dir, 'remote-access', 'audit.jsonl');
      deadline = Date.now() + 3000;
      let auditText = '';
      while (Date.now() < deadline) {
        try { auditText = readFileSync(auditPath, 'utf8'); } catch { auditText = ''; }
        if (auditText.includes('push-trigger')) break;
        await sleep(20);
      }
      assert.equal(service.pushTokens.get('d_rot')?.token, tokenNew, '旧 token 的 410 不能删掉发送在途期间轮换的新 token');

      // 第二次推送：失败 token 与存储一致 → 正常清理（内存 + 文件）。
      phase = 1;
      await onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'error' } } });
      deadline = Date.now() + 3000;
      while (service.pushTokens.size > 0 && Date.now() < deadline) await sleep(20);
      assert.deepEqual(seenTokens[1], [tokenNew]);
      assert.equal(service.pushTokens.size, 0, '匹配的失效 token 应被清理');
      const stored = JSON.parse(readFileSync(paths.pushTokens(), 'utf8'));
      assert.equal(stored.tokens.length, 0, 'push-tokens.json 也应同步清理');
      const finalAudit = readFileSync(auditPath, 'utf8');
      assert.equal((finalAudit.match(/"action":"push-token-pruned"/g) ?? []).length, 1, '只应记录一次真实清理，旧 token 的 410 不计入');
    } finally {
      await service.dispose();
    }
  } finally {
    home.cleanup();
    rmSync(keyDir, { recursive: true, force: true });
  }
});
