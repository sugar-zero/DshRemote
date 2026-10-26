import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DESKTOP_HOST_ENV,
  DESKTOP_RELAUNCH_DELAY_MS,
  HOST_RESTART_DEDUPE_WINDOW_MS,
  HOST_RESTART_DISABLE_ENV,
  buildHostRestartScript,
  createHostRestartPlan,
  createHostRestartScheduler,
  detectDesktopShell,
  extractMacBundlePath,
  isDesktopHostEntry,
  requestHostRestart,
  scheduleHostRestart,
  shellQuote,
  windowsQuote,
} from '../lib/host-restart.js';

const MAC_EXEC = '/Applications/DSH Test.app/Contents/MacOS/DSH Test';
const MAC_BUNDLE = '/Applications/DSH Test.app';
const WIN_EXEC = 'C:\\Program Files\\DSH\\DSH.exe';
const SHELL_PID = 4242;
const HOST_PID = 4243;

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

const DESKTOP_ENTRY = '/Applications/DSH Test.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js';

/**
 * DSH 桌面端 host 子进程的公共判定参数（真实形态：Electron + dsh-desktop-host 入口
 * argv，父进程 = 同一个 Electron 可执行文件）。
 */
function desktopContext(overrides = {}) {
  return {
    argv: ['--expose-internals', DESKTOP_ENTRY, '<runtimeDir>', '<projectDir>'],
    execPath: MAC_EXEC,
    env: {},
    ppid: SHELL_PID,
    selfPid: HOST_PID,
    readParentCommand: () => MAC_EXEC,
    ...overrides,
  };
}

function macPlan() {
  return createHostRestartPlan({
    platform: 'darwin',
    versions: { electron: '30.0.0' },
    ...desktopContext(),
  });
}

function winDesktopPlan() {
  return createHostRestartPlan({
    platform: 'win32',
    execPath: WIN_EXEC,
    versions: { electron: '30.0.0' },
    argv: ['--expose-internals', 'C:\\app\\runtime\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js'],
    env: {},
    ppid: SHELL_PID,
    selfPid: HOST_PID,
  });
}

test('isDesktopHostEntry: 识别桌面端 host 入口（Node CLI 不匹配）', () => {
  assert.equal(isDesktopHostEntry(['electron', DESKTOP_ENTRY, '<runtimeDir>']), true);
  assert.equal(isDesktopHostEntry(['electron', '--expose-internals', DESKTOP_ENTRY]), true);
  assert.equal(isDesktopHostEntry(['C:\\app\\runtime\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js']), true);
  assert.equal(isDesktopHostEntry(['node', '/opt/dsh/cli.js', 'web']), false);
  assert.equal(isDesktopHostEntry(undefined), false);
});

test('detectDesktopShell: 「Electron + dsh-desktop-host 入口 + 父进程是 shell」才认桌面端', () => {
  assert.deepEqual(detectDesktopShell(desktopContext()), { desktopHost: true, shellPid: SHELL_PID });
  // 旧版/特殊启动器注入的环境标记同样认
  assert.deepEqual(
    detectDesktopShell(desktopContext({ argv: [], env: { [DESKTOP_HOST_ENV]: MAC_EXEC } })),
    { desktopHost: true, shellPid: SHELL_PID },
  );
  // 既没有入口也没有标记（Node CLI / 普通环境）：不是桌面端
  const cli = detectDesktopShell(desktopContext({ argv: ['/usr/local/bin/node', '/opt/dsh/cli.js', 'web'] }));
  assert.equal(cli.desktopHost, false);
  assert.match(cli.reason, /dsh-desktop-host/);
  // 父进程命令行不是同一个 Electron 可执行文件（例如在 DSH 里开的终端继承了环境变量）：不能误杀
  const mismatch = detectDesktopShell(desktopContext({ readParentCommand: () => '/bin/zsh' }));
  assert.equal(mismatch.desktopHost, false);
  assert.match(mismatch.reason, /父进程不是 DSH 桌面端 shell/);
  // ppid 非法
  assert.equal(detectDesktopShell(desktopContext({ ppid: 1 })).desktopHost, false);
  assert.equal(detectDesktopShell(desktopContext({ ppid: HOST_PID })).desktopHost, false);
});

test('plan: macOS DSH 桌面端以 shell 进程组为目标并用 open -n 重启 app', () => {
  const plan = macPlan();
  assert.equal(plan.supported, true);
  assert.equal(plan.mode, 'desktop-app');
  assert.equal(plan.bundle, MAC_BUNDLE);
  assert.equal(plan.shellPid, SHELL_PID);
  assert.equal(plan.hostPid, HOST_PID);
  assert.equal(plan.groupKill, true);
  assert.equal(plan.command, `open -n ${shellQuote(MAC_BUNDLE)}`);
  assert.equal(plan.relaunchDelayMs, DESKTOP_RELAUNCH_DELAY_MS);
  assert.equal(extractMacBundlePath(MAC_EXEC), MAC_BUNDLE);
  assert.equal(extractMacBundlePath('/usr/local/bin/electron'), undefined);
});

test('plan: Electron 但没有 dsh-desktop-host 入口/桌面标记时返回 unsupported（不再误杀 host 子进程）', () => {
  const plan = createHostRestartPlan({
    platform: 'darwin',
    execPath: MAC_EXEC,
    argv: [MAC_EXEC],
    versions: { electron: '30.0.0' },
    env: {},
    ppid: SHELL_PID,
    selfPid: HOST_PID,
    readParentCommand: () => MAC_EXEC,
  });
  assert.equal(plan.supported, false);
  assert.equal(plan.mode, 'unsupported');
  assert.match(plan.reason, /dsh-desktop-host/);
});

test('plan: 桌面端可执行文件不在 .app 内时返回 unsupported', () => {
  const plan = createHostRestartPlan({
    platform: 'darwin',
    execPath: '/usr/local/bin/electron',
    versions: { electron: '30.0.0' },
    ...desktopContext({
      execPath: '/usr/local/bin/electron',
      env: { [DESKTOP_HOST_ENV]: '/usr/local/bin/electron' },
      readParentCommand: () => '/usr/local/bin/electron',
    }),
  });
  assert.equal(plan.supported, false);
  assert.equal(plan.mode, 'unsupported');
  assert.match(plan.reason, /\.app/);
});

test('plan: Windows DSH 桌面端以 shell pid 为目标并用 start 重新拉起 exe', () => {
  const plan = winDesktopPlan();
  assert.equal(plan.supported, true);
  assert.equal(plan.mode, 'desktop-app');
  assert.equal(plan.shellPid, SHELL_PID);
  assert.equal(plan.hostPid, HOST_PID);
  assert.equal(plan.command, `start "" ${windowsQuote(WIN_EXEC)}`);
});

test('plan: Linux Electron 返回 unsupported', () => {
  const plan = createHostRestartPlan({
    platform: 'linux',
    execPath: '/opt/dsh/dsh',
    versions: { electron: '30.0.0' },
    argv: ['--expose-internals', '/opt/dsh/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'],
    env: {},
    ppid: SHELL_PID,
    selfPid: HOST_PID,
  });
  assert.equal(plan.supported, false);
  assert.equal(plan.mode, 'unsupported');
  assert.match(plan.reason, /Electron 平台/);
});

test('plan: 非 Electron 的 Node CLI 用 execPath + argv.slice(1) 重新拉起', () => {
  const plan = createHostRestartPlan({
    platform: 'darwin',
    execPath: '/usr/local/bin/node',
    argv: ['/usr/local/bin/node', '/opt/dsh/cli.js', 'web', '--port', '8080'],
    versions: {},
    env: {},
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
    env: {},
  });
  assert.equal(plan.mode, 'node');
  assert.equal(plan.command, `start "" "C:\\Program Files\\nodejs\\node.exe" "C:\\dsh\\cli.js" "web"`);
});

test('plan: execPath 为空时返回 unsupported', () => {
  const plan = createHostRestartPlan({ platform: 'darwin', execPath: '', versions: {}, env: {} });
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

test('script: 桌面端 POSIX helper 先 SIGKILL shell（无弹窗）→清理残留→清理旧单实例锁→拉起并校验+兜底', () => {
  const plan = macPlan();
  const script = buildHostRestartScript(plan, { delayMs: 1000, killGraceMs: 10_000 });

  // 1) 杀进程：shell 主进程优先 KILL（不能 TERM，否则 renderer 崩溃弹窗），再整组清理 + 补杀 host
  assert.ok(script.includes('# 重启 helper 日志'), 'helper 写日志便于排查');
  assert.ok(script.includes(`kill -KILL ${SHELL_PID} 2>/dev/null || true`), '先直接 SIGKILL 浏览器主进程（shell）');
  assert.ok(!script.includes(`kill -TERM -- -${SHELL_PID}`), '不能对整组 SIGTERM（会触发 renderer 崩溃弹窗）');
  assert.ok(script.includes(`kill -KILL -- -${SHELL_PID} 2>/dev/null || true`), 'shell 死后整组 SIGKILL 清理残留');
  assert.ok(script.includes(`if kill -0 ${HOST_PID} 2>/dev/null; then kill -KILL ${HOST_PID}`), '补杀 host 子进程（本进程）');
  assert.ok(script.includes('shell_alive() {'), '用 ps 状态判断 shell 是否仍在（僵尸视为已退出）');
  assert.ok(script.includes(`/bin/ps -o stat= -p ${SHELL_PID}`), '按 pid 查询进程状态（绝对路径，防 PATH 异常）');
  assert.ok(script.includes('if shell_alive; then log "abort: shell still alive"; exit 1; fi'), '旧实例未退出时不得拉起第二个实例');

  // 2) 单实例锁清理：SIGKILL 不会清理 SingletonLock/Cookie/Socket，不清理新实例会秒退
  assert.ok(script.includes('cleanup_singleton_locks() {'), '清理陈旧单实例锁');
  assert.ok(script.includes('SingletonLock'), '检查 SingletonLock');
  assert.ok(script.includes('SingletonCookie') && script.includes('SingletonSocket'), '一并清理 Cookie/Socket');
  assert.ok(script.includes('kill -0 "$owner_pid"'), '锁的属主仍存活时不动它');

  // 3) 拉起：open -n 后用 ps 校验，失败则直接执行 .app 内可执行文件兜底
  assert.ok(script.includes(`/usr/bin/open -n '${MAC_BUNDLE}'`), '首选 open -n（LaunchServices 正常激活）');
  assert.ok(script.includes('app_running() {'), '拉起后用 ps comm 校验应用是否真的在跑');
  assert.ok(script.includes(`/usr/bin/grep -F -x '${MAC_EXEC}'`), '按 execPath 精确匹配应用进程');
  assert.ok(script.includes('/usr/bin/env -u ELECTRON_RUN_AS_NODE -u NODE_CHANNEL_FD'), '兜底直接执行时清掉 Node 模式/IPC 环境变量');
  assert.ok(script.includes(`'${MAC_EXEC}' >/dev/null 2>&1 &`), '兜底后台直接执行 .app 内可执行文件');
  assert.ok(script.includes('log "relaunched via open"') && script.includes('log "relaunched via direct exec"'));
  assert.ok(script.includes('log "FAILED: app still not running after open + direct exec"'), '两条路都失败要留日志');
  assert.ok(!script.includes('taskkill'));
  assert.ok(script.includes('/bin/sleep 3'), '桌面端默认多等约 2.5s 让端口释放后再拉起（ceil → 3）');
});

test('script: 生成的桌面端 helper 脚本通过 sh -n 语法检查', async () => {
  const { spawnSync } = await import('node:child_process');
  const script = buildHostRestartScript(macPlan(), { delayMs: 1000, killGraceMs: 10_000 });
  const check = spawnSync('/bin/sh', ['-n'], { input: script, encoding: 'utf8' });
  assert.equal(check.status, 0, `helper 脚本语法应合法：${check.stderr}`);
});

test('script: Node CLI 模式只杀自己（不会碰父进程/进程组）', () => {
  const plan = createHostRestartPlan({
    platform: 'darwin',
    execPath: '/usr/local/bin/node',
    argv: ['/usr/local/bin/node', '/opt/dsh/cli.js', 'web'],
    versions: {},
    env: {},
  });
  const script = buildHostRestartScript(plan, { pid: 4242, delayMs: 1000, killGraceMs: 10_000, relaunchDelayMs: 1000 });
  assert.equal(script.split('\n')[1], 'kill -TERM 4242 2>/dev/null || true');
  assert.ok(!script.includes('kill -TERM -- -'), 'CLI 模式不得整组杀（父进程可能是终端/pm2）');
  assert.ok(script.endsWith(`exec '/usr/local/bin/node' '/opt/dsh/cli.js' 'web'`));
});

test('script: Windows 桌面端 helper 用 ping 延迟 + taskkill（单 PID，无 /T）+ start', () => {
  const script = buildHostRestartScript(winDesktopPlan(), { delayMs: 1000, killGraceMs: 10_000, relaunchDelayMs: 1000 });
  assert.ok(script.includes('ping -n 2 127.0.0.1 >nul 2>&1'));
  assert.ok(!script.includes('timeout /t'));
  assert.ok(script.includes(`taskkill /PID ${SHELL_PID} /F >nul 2>&1`));
  assert.ok(script.includes(`taskkill /PID ${HOST_PID} /F >nul 2>&1`));
  // 不能 /T：helper 自己是 host 子进程的子进程，/T 会把 helper 也杀掉，导致无法重新拉起。
  assert.ok(!script.includes('/T'));
  assert.ok(!script.includes('\n'), 'cmd /c 里多行脚本文本不可靠，必须是单行');
  assert.ok(script.trimEnd().endsWith(`start "" ${windowsQuote(WIN_EXEC)}`));
});

test('script: 非法 pid / unsupported plan 抛带 status 的错误', () => {
  const badShell = { ...macPlan(), shellPid: 0 };
  assert.throws(
    () => buildHostRestartScript(badShell),
    (error) => error.status === 500 && error.code === 'host-restart-invalid-pid',
  );
  const node = createHostRestartPlan({ platform: 'darwin', execPath: '/usr/local/bin/node', argv: ['node'], versions: {}, env: {} });
  assert.throws(
    () => buildHostRestartScript(node, { pid: 0 }),
    (error) => error.status === 500 && error.code === 'host-restart-invalid-pid',
  );
  assert.throws(
    () => buildHostRestartScript(createHostRestartPlan({ platform: 'linux', execPath: '/opt/dsh', versions: { electron: '30' }, env: {} })),
    (error) => error.status === 501 && error.code === 'host-restart-unsupported',
  );
});

test('schedule: POSIX 用 detached /bin/sh -c，stdio ignore + unref；脚本目标是 shell 整组', () => {
  const fake = makeFakeSpawn();
  const plan = macPlan();
  const result = scheduleHostRestart(plan, { pid: 777, env: {}, spawnImpl: fake.spawnImpl, log: () => {} });
  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.equal(call.command, '/bin/sh');
  assert.equal(call.args[0], '-c');
  assert.ok(call.args[1].includes(`kill -KILL ${SHELL_PID}`), '脚本先 SIGKILL shell');
  assert.ok(call.args[1].includes(`kill -KILL -- -${SHELL_PID}`), '再整组 SIGKILL 清理');
  assert.equal(call.options.detached, true);
  assert.equal(call.options.stdio, 'ignore');
  assert.equal(call.options.windowsHide, true);
  assert.equal(fake.unrefs.length, 1, 'detached helper 必须 unref，避免阻塞 DSH 退出');
  assert.equal(result.mode, 'desktop-app');
  assert.equal(result.pid, 777);
  assert.equal(result.shell, '/bin/sh');
});

test('schedule: Windows 用 cmd.exe /d /s /c + windowsVerbatimArguments（避免引号被二次转义）', () => {
  const fake = makeFakeSpawn();
  const result = scheduleHostRestart(winDesktopPlan(), { pid: 777, env: {}, spawnImpl: fake.spawnImpl });
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
  const unsupported = createHostRestartPlan({ platform: 'linux', execPath: '/opt/dsh', versions: { electron: '30' }, env: {} });
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

test('requestHostRestart: 桌面端组合 plan+schedule，返回 desktop-app 且脚本杀 shell 整组', () => {
  const fake = makeFakeSpawn();
  const result = requestHostRestart({
    platform: 'darwin',
    versions: { electron: '30.0.0' },
    pid: 909,
    spawnImpl: fake.spawnImpl,
    log: () => {},
    ...desktopContext(),
  });
  assert.equal(result.mode, 'desktop-app');
  assert.equal(result.pid, 909);
  assert.equal(fake.calls.length, 1);
  assert.ok(fake.calls[0].args[1].includes(`kill -KILL ${SHELL_PID}`), '脚本先 SIGKILL shell');
  assert.ok(fake.calls[0].args[1].includes(`kill -KILL -- -${SHELL_PID}`), '再整组 SIGKILL 清理');
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
      platform: 'darwin', execPath: '/usr/local/bin/node', argv: ['node', '/opt/dsh/cli.js', 'web'], versions: {}, pid: 909,
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
      return { mode: 'desktop-app' };
    },
    log: () => {},
  });
  assert.equal(scheduler.windowMs, 10_000);

  const first = scheduler.request({ marker: 1 });
  assert.equal(first.deduped, false);
  assert.equal(first.mode, 'desktop-app');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { marker: 1 });

  now += 9_999;
  const second = scheduler.request({ marker: 2 });
  assert.equal(second.deduped, true);
  assert.equal(second.mode, 'desktop-app', '去重命中时也要回上一次的 mode，便于 202 响应');
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
