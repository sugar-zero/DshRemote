import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOST_RESTART_DEDUPE_WINDOW_MS,
  HOST_RESTART_DISABLE_ENV,
  buildHostRestartScript,
  createHostRestartPlan,
  createHostRestartScheduler,
  extractMacBundlePath,
  requestHostRestart,
  scheduleHostRestart,
  shellQuote,
  windowsQuote,
} from '../lib/host-restart.js';

const MAC_EXEC = '/Applications/DSH Test.app/Contents/MacOS/DSH Test';
const MAC_BUNDLE = '/Applications/DSH Test.app';
const WIN_EXEC = 'C:\\Program Files\\DSH\\DSH.exe';

/** 记录 spawn 调用与 unref 的 fake（**绝不真的执行命令**）。 */
function makeFakeSpawn() {
  const calls = [];
  const unrefs = [];
  const spawnImpl = (command, args, options) => {
    const child = { pid: 4321, unref: () => unrefs.push(true) };
    calls.push({ command, args, options, child });
    return child;
  };
  return { calls, unrefs, spawnImpl };
}

function macPlan() {
  return createHostRestartPlan({ platform: 'darwin', execPath: MAC_EXEC, argv: [], versions: { electron: '30.0.0' } });
}

test('plan: macOS Electron 从 .app 包内可执行文件截出 bundle 并用 open -n 重启', () => {
  const plan = createHostRestartPlan({ platform: 'darwin', execPath: MAC_EXEC, argv: [], versions: { electron: '30.0.0' } });
  assert.equal(plan.supported, true);
  assert.equal(plan.mode, 'mac-app');
  assert.equal(plan.bundle, MAC_BUNDLE);
  assert.equal(plan.command, `open -n ${shellQuote(MAC_BUNDLE)}`);
  assert.equal(extractMacBundlePath(MAC_EXEC), MAC_BUNDLE);
  assert.equal(extractMacBundlePath('/usr/local/bin/electron'), undefined);
});

test('plan: macOS Electron 不在 .app 内时返回 unsupported（不算崩溃）', () => {
  const plan = createHostRestartPlan({ platform: 'darwin', execPath: '/usr/local/bin/electron', versions: { electron: '30.0.0' } });
  assert.equal(plan.supported, false);
  assert.equal(plan.mode, 'unsupported');
  assert.match(plan.reason, /\.app/);
});

test('plan: Windows Electron 用 cmd start 重新拉起 exe', () => {
  const plan = createHostRestartPlan({ platform: 'win32', execPath: WIN_EXEC, versions: { electron: '30.0.0' } });
  assert.equal(plan.supported, true);
  assert.equal(plan.mode, 'win-app');
  assert.equal(plan.command, `start "" ${windowsQuote(WIN_EXEC)}`);
});

test('plan: 其它 Electron 平台（Linux）返回 unsupported', () => {
  const plan = createHostRestartPlan({ platform: 'linux', execPath: '/opt/dsh/dsh', versions: { electron: '30.0.0' } });
  assert.equal(plan.supported, false);
  assert.equal(plan.mode, 'unsupported');
  assert.match(plan.reason, /linux/);
});

test('plan: 非 Electron 的 Node CLI 用 execPath + argv.slice(1) 重新拉起', () => {
  const plan = createHostRestartPlan({
    platform: 'darwin',
    execPath: '/usr/local/bin/node',
    argv: ['/usr/local/bin/node', '/opt/dsh/cli.js', 'web', '--port', '8080'],
    versions: {},
  });
  assert.equal(plan.supported, true);
  assert.equal(plan.mode, 'node');
  assert.deepEqual(plan.argv, ['/opt/dsh/cli.js', 'web', '--port', '8080']);
  assert.equal(plan.command, `'/usr/local/bin/node' '/opt/dsh/cli.js' 'web' '--port' '8080'`);
});

test('plan: Windows 上的 Node CLI 用 start "" 重新拉起', () => {
  const plan = createHostRestartPlan({
    platform: 'win32',
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    argv: ['node.exe', 'C:\\dsh\\cli.js', 'web'],
    versions: {},
  });
  assert.equal(plan.mode, 'node');
  assert.equal(plan.command, `start "" "C:\\Program Files\\nodejs\\node.exe" "C:\\dsh\\cli.js" "web"`);
});

test('plan: execPath 为空时返回 unsupported', () => {
  const plan = createHostRestartPlan({ platform: 'darwin', execPath: '', versions: {} });
  assert.equal(plan.supported, false);
  assert.equal(plan.mode, 'unsupported');
  assert.match(plan.reason, /execPath/);
});

test('shellQuote: 单引号包裹并正确转义内部单引号（防注入）', () => {
  assert.equal(shellQuote(''), "''");
  assert.equal(shellQuote('plain'), "'plain'");
  assert.equal(shellQuote('with space'), "'with space'");
  assert.equal(shellQuote("a'b"), `'a'\\''b'`);
  assert.equal(shellQuote('$(rm -rf /)'), "'$(rm -rf /)'");
  assert.equal(shellQuote('`id`; echo'), "'`id`; echo'");
  assert.equal(shellQuote('a\nb'), "'a\nb'");
});

test('windowsQuote: 双引号包裹并转义内部双引号', () => {
  assert.equal(windowsQuote('C:\\DSH\\DSH.exe'), '"C:\\DSH\\DSH.exe"');
  assert.equal(windowsQuote('C:\\a b\\DSH.exe'), '"C:\\a b\\DSH.exe"');
  assert.equal(windowsQuote('say "hi"'), '"say \\"hi\\""');
});

test('script: POSIX helper 先等待再 SIGTERM/SIGKILL 并 exec 重启命令', () => {
  const script = buildHostRestartScript(macPlan(), { pid: 4242, delayMs: 1000, killGraceMs: 10_000, relaunchDelayMs: 1000 });
  const lines = script.split('\n');
  assert.equal(lines[0], 'sleep 1');
  assert.equal(lines[1], 'kill -TERM 4242 2>/dev/null || true');
  assert.ok(lines.includes('while kill -0 4242 2>/dev/null; do'));
  assert.ok(script.includes('if [ "$n" -ge 10 ]'), '10s grace 应换算成 10 次轮询');
  assert.ok(script.includes('kill -KILL 4242 2>/dev/null || true'), '超时后 SIGKILL 兜底');
  assert.ok(script.endsWith(`exec open -n ${shellQuote(MAC_BUNDLE)}`));
  assert.ok(!script.includes('taskkill'));
});

test('script: Windows helper 用 ping 延迟 + taskkill + start（单行命令）', () => {
  const winPlan = createHostRestartPlan({ platform: 'win32', execPath: WIN_EXEC, versions: { electron: '30.0.0' } });
  const script = buildHostRestartScript(winPlan, { pid: 4242, delayMs: 1000, killGraceMs: 10_000, relaunchDelayMs: 1000 });
  // stdio: 'ignore' 下 timeout 会立即失败，改用 ping 等秒（无控制台也能工作）
  assert.ok(script.includes('ping -n 2 127.0.0.1 >nul 2>&1'));
  assert.ok(!script.includes('timeout /t'));
  assert.ok(script.includes('taskkill /PID 4242 /F >nul 2>&1'));
  // 不能 /T：helper 自己是目标进程的子进程，/T 会把 helper 也杀掉，导致无法重新拉起。
  assert.ok(!script.includes('/T'));
  assert.ok(!script.includes('\n'), 'cmd /c 里多行脚本文本不可靠，必须是单行');
  assert.ok(script.trimEnd().endsWith(`start "" ${windowsQuote(WIN_EXEC)}`));
});

test('script: 非法 pid / unsupported plan 抛带 status 的错误', () => {
  assert.throws(
    () => buildHostRestartScript(macPlan(), { pid: 0 }),
    (error) => error.status === 500 && error.code === 'host-restart-invalid-pid',
  );
  assert.throws(
    () => buildHostRestartScript(createHostRestartPlan({ platform: 'linux', execPath: '/opt/dsh', versions: { electron: '30' } }), { pid: 1 }),
    (error) => error.status === 501 && error.code === 'host-restart-unsupported',
  );
});

test('schedule: POSIX 用 detached /bin/sh -c，stdio ignore + unref', () => {
  const fake = makeFakeSpawn();
  const plan = macPlan();
  const result = scheduleHostRestart(plan, { pid: 777, env: {}, spawnImpl: fake.spawnImpl, log: () => {} });
  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.equal(call.command, '/bin/sh');
  assert.equal(call.args[0], '-c');
  assert.ok(call.args[1].includes('kill -TERM 777'));
  assert.equal(call.options.detached, true);
  assert.equal(call.options.stdio, 'ignore');
  assert.equal(call.options.windowsHide, true);
  assert.equal(fake.unrefs.length, 1, 'detached helper 必须 unref，避免阻塞 DSH 退出');
  assert.equal(result.mode, 'mac-app');
  assert.equal(result.pid, 777);
  assert.equal(result.shell, '/bin/sh');
});

test('schedule: Windows 用 cmd.exe /d /s /c + windowsVerbatimArguments（避免引号被二次转义）', () => {
  const fake = makeFakeSpawn();
  const plan = createHostRestartPlan({ platform: 'win32', execPath: WIN_EXEC, versions: { electron: '30.0.0' } });
  const result = scheduleHostRestart(plan, { pid: 777, env: {}, spawnImpl: fake.spawnImpl });
  const call = fake.calls[0];
  assert.equal(call.command, 'cmd.exe');
  assert.deepEqual(call.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(call.args[3], `"${result.script}"`, '整段命令应作为一条已带引号的命令交给 cmd');
  assert.equal(call.options.windowsVerbatimArguments, true);
  assert.equal(call.options.detached, true);
  assert.equal(call.options.stdio, 'ignore');
});

test(`schedule: ${HOST_RESTART_DISABLE_ENV}=1 时拒绝（501）且不起任何进程`, () => {
  const fake = makeFakeSpawn();
  assert.throws(
    () => scheduleHostRestart(macPlan(), { pid: 777, env: { [HOST_RESTART_DISABLE_ENV]: '1' }, spawnImpl: fake.spawnImpl }),
    (error) => error.status === 501 && error.code === 'host-restart-disabled',
  );
  assert.equal(fake.calls.length, 0);
});

test('schedule: unsupported plan 501，spawn 失败 500', () => {
  const fake = makeFakeSpawn();
  const unsupported = createHostRestartPlan({ platform: 'linux', execPath: '/opt/dsh', versions: { electron: '30' } });
  assert.throws(
    () => scheduleHostRestart(unsupported, { pid: 777, env: {}, spawnImpl: fake.spawnImpl }),
    (error) => error.status === 501 && error.code === 'host-restart-unsupported',
  );
  assert.equal(fake.calls.length, 0);
  assert.throws(
    () => scheduleHostRestart(macPlan(), { pid: 777, env: {}, spawnImpl: () => { throw new Error('spawn boom'); } }),
    (error) => error.status === 500 && error.code === 'host-restart-spawn-failed' && /spawn boom/.test(error.message),
  );
  assert.throws(
    () => scheduleHostRestart(macPlan(), { pid: 777, env: {}, spawnImpl: () => null }),
    (error) => error.status === 500 && error.code === 'host-restart-spawn-failed',
  );
});

test('requestHostRestart: 组合 plan+schedule，返回 mode 且 spawn 收到当前 pid', () => {
  const fake = makeFakeSpawn();
  const result = requestHostRestart({
    platform: 'darwin',
    execPath: MAC_EXEC,
    argv: [],
    versions: { electron: '30.0.0' },
    pid: 909,
    env: {},
    spawnImpl: fake.spawnImpl,
    log: () => {},
  });
  assert.equal(result.mode, 'mac-app');
  assert.equal(result.pid, 909);
  assert.equal(fake.calls.length, 1);
  assert.ok(fake.calls[0].args[1].includes('kill -TERM 909'));
  assert.ok(fake.calls[0].args[1].includes(`open -n ${shellQuote(MAC_BUNDLE)}`));
});

test('requestHostRestart: Node CLI 模式返回 mode=node', () => {
  const fake = makeFakeSpawn();
  const result = requestHostRestart({
    platform: 'darwin',
    execPath: '/usr/local/bin/node',
    argv: ['/usr/local/bin/node', '/opt/dsh/cli.js', 'web'],
    versions: {},
    pid: 909,
    env: {},
    spawnImpl: fake.spawnImpl,
  });
  assert.equal(result.mode, 'node');
  assert.ok(fake.calls[0].args[1].includes(`exec '/usr/local/bin/node' '/opt/dsh/cli.js' 'web'`));
});

test('requestHostRestart: 环境不支持 / 被禁用都不起进程', () => {
  const fake = makeFakeSpawn();
  assert.throws(
    () => requestHostRestart({
      platform: 'linux', execPath: '/opt/dsh', versions: { electron: '30' }, pid: 909, env: {}, spawnImpl: fake.spawnImpl,
    }),
    (error) => error.status === 501 && error.code === 'host-restart-unsupported',
  );
  assert.throws(
    () => requestHostRestart({
      platform: 'darwin', execPath: MAC_EXEC, argv: [], versions: { electron: '30' }, pid: 909,
      env: { [HOST_RESTART_DISABLE_ENV]: '1' }, spawnImpl: fake.spawnImpl,
    }),
    (error) => error.status === 501 && error.code === 'host-restart-disabled',
  );
  assert.equal(fake.calls.length, 0);
});

test('scheduler: 去重窗口内只真正调度一次，窗口过后允许再次调度', () => {
  let now = 1_000;
  const requests = [];
  const scheduler = createHostRestartScheduler({
    windowMs: HOST_RESTART_DEDUPE_WINDOW_MS,
    now: () => now,
    request: (options) => {
      requests.push(options);
      return { mode: 'mac-app' };
    },
    log: () => {},
  });
  assert.equal(scheduler.windowMs, 10_000);

  const first = scheduler.request({ marker: 1 });
  assert.equal(first.deduped, false);
  assert.equal(first.mode, 'mac-app');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { marker: 1 });

  now += 9_999;
  const second = scheduler.request({ marker: 2 });
  assert.equal(second.deduped, true);
  assert.equal(second.mode, 'mac-app', '去重命中时也要回上一次的 mode，便于 202 响应');
  assert.equal(requests.length, 1, '窗口内重复请求不得再调度');

  now += 1; // 恰好到窗口边界
  const third = scheduler.request({ marker: 3 });
  assert.equal(third.deduped, false);
  assert.equal(requests.length, 2);
  assert.equal(scheduler.lastRequestAt, now);
});

test('scheduler: 调度失败不消耗去重窗口（可立即重试）', () => {
  let now = 5_000;
  let attempts = 0;
  const scheduler = createHostRestartScheduler({
    now: () => now,
    request: () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('unsupported');
        error.status = 501;
        throw error;
      }
      return { mode: 'node' };
    },
    log: () => {},
  });
  assert.throws(() => scheduler.request(), (error) => error.status === 501);
  const retry = scheduler.request();
  assert.equal(retry.deduped, false);
  assert.equal(retry.mode, 'node');
  assert.equal(attempts, 2, '失败后同一时刻重试应再次调度，而不是被去重挡掉');

  const deduped = scheduler.request();
  assert.equal(deduped.deduped, true);
  assert.equal(attempts, 2);
});
