/**
 * 主机 DSH 客户端「远程重启」的调度实现（Host 半，零新依赖）。
 *
 * 三种运行形态（由 `createHostRestartPlan()` 纯函数判定）：
 * 1. **DSH 桌面端（Electron shell + host 子进程）**：本插件跑在 shell 派生的 host 子进程里，
 *    `process.pid` 只是 host 子进程；杀它只会让 Electron shell 弹出「应用无法启动或已意外停止」
 *    崩溃对话框，不能完成重启。正确目标是**整个 DSH 应用进程组**（shell 是组长，
 *    host/渲染/utility 都是同一 pgid）：`kill -TERM -- -<shellPid>` 整组退出 →
 *    等进程组清空 → `open -n <...app>` 重新拉起桌面端。
 * 2. **Windows 桌面端**：同样以 shell pid 为目标（`taskkill /PID <shell> /F`），再补杀 host
 *    子进程，最后 `start "" "<exe>"`（best-effort）。
 * 3. **Node CLI（`dsh web` 等）**：本进程就是主进程，SIGTERM 自己后按 `execPath + argv` 原样拉起。
 *
 * 公共约束：
 * - 先等 ~1s 让 HTTP 202 响应发完再动手；
 * - 重启 helper 用 `spawn(..., { detached: true, stdio: 'ignore' }).unref()`：自成进程组，
 *   被杀的 DSH 进程树不会连带杀掉它；它也不阻塞旧进程退出；
 * - 只在确认旧实例退出后才拉起新实例，避免「两个 DSH 同时跑」抢端口（DSH 桌面端会因此
 *   直接崩溃）；
 * - spawn 可注入（生产默认 `node:child_process.spawn`，测试注入 fake，**绝不真的杀进程**）；
 * - `DSH_REMOTE_DISABLE_HOST_RESTART=1` 时拒绝调度（测试/CI 防误重启本机）。
 */

import { execFileSync, spawn } from 'node:child_process';

/** 禁止远程重启的环境变量；为 '1' 时调度直接抛 501。 */
export const HOST_RESTART_DISABLE_ENV = 'DSH_REMOTE_DISABLE_HOST_RESTART';
/** DSH 桌面端给 host 子进程注入的标记：值是 Electron 可执行文件路径。 */
export const DESKTOP_HOST_ENV = 'DSH_DESKTOP_NODE_EXECUTABLE';

/** 默认：先等 1s 让 202 响应发完再杀进程。 */
export const HOST_RESTART_DELAY_MS = 1000;
/** 默认：SIGTERM 后最多等 10s，仍存活则 SIGKILL。 */
export const HOST_RESTART_KILL_GRACE_MS = 10_000;
/** 默认：当前进程退出后再等 1s 才重新拉起（给端口/单实例锁留释放时间）。 */
export const HOST_RESTART_RELAUNCH_DELAY_MS = 1000;
/** 桌面端整组退出后额外等待：端口（如插件占用的 host web port）要完全释放。 */
export const DESKTOP_RELAUNCH_DELAY_MS = 2500;
/** 默认：`createHostRestartScheduler` 的去重窗口 —— 10s 内的重复请求只调度一次。 */
export const HOST_RESTART_DEDUPE_WINDOW_MS = 10_000;

const MAC_EXEC_MARKER = '/Contents/MacOS/';

/**
 * 构造带 HTTP status 的错误，便于 server.js 直接映射 202/405/500/501。
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {object} [extra]
 * @returns {Error & {status: number, code: string}}
 */
function hostRestartError(status, code, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/**
 * POSIX shell 单引号转义：`shellQuote("a'b") === "'a'\\''b'"`。
 * 单引号内不允许任何展开（`$`/反引号/反斜杠都是字面量），最安全。
 * @param {unknown} value
 * @returns {string}
 */
export function shellQuote(value) {
  const text = String(value ?? '');
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * Windows `cmd.exe` 双引号转义：空格/元字符放进双引号里即按字面量处理，内部双引号转义。
 * 仅用于 `start "" "<exe>"`、taskkill 等固定形态的命令。
 * @param {unknown} value
 * @returns {string}
 */
export function windowsQuote(value) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '\\"')}"`;
}

/**
 * 从 macOS Electron 可执行路径截出 `.app` bundle。
 * 例：`/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness`
 *   → `/Applications/DeepSeek Harness.app`
 * @param {string} execPath
 * @returns {string|undefined}
 */
export function extractMacBundlePath(execPath) {
  const raw = String(execPath ?? '');
  const markerIndex = raw.indexOf(MAC_EXEC_MARKER);
  if (markerIndex <= 0) return undefined;
  const appIndex = raw.lastIndexOf('.app', markerIndex);
  if (appIndex <= 0) return undefined;
  return raw.slice(0, appIndex + '.app'.length);
}

/** 去掉首尾空白与包裹引号，便于比较 ps 输出的命令。 */
function normalizeCommand(value) {
  let text = String(value ?? '').trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
  return text;
}

/**
 * 默认的父进程命令行读取（POSIX `ps -o comm=`；Windows 无对应命令，返回 undefined）。
 * @param {number} pid
 * @returns {string|undefined}
 */
export function readParentCommand(pid) {
  if (process.platform === 'win32') return undefined;
  try {
    const output = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
    const text = normalizeCommand(output);
    return text === '' ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * 本进程的 argv 是否像 DSH 桌面端的 host 子进程入口。
 *
 * DSH 桌面端 shell 用 `spawn(electron, ['--expose-internals', <runtimeDir>/node_modules/
 * @deepseek-ai/dsh-desktop-host/lib/index.js, ...])`（ELECTRON_RUN_AS_NODE=1）拉起 Host；
 * 该入口是桌面端特有的，`dsh web` 等 CLI 不会出现。
 *
 * @param {string[]} argv 进程参数（Node 语义：process.argv）。
 * @returns {boolean}
 */
export function isDesktopHostEntry(argv) {
  if (!Array.isArray(argv)) return false;
  return argv.some((value) => {
    const text = normalizeCommand(value).replace(/\\/g, '/');
    return text.includes('dsh-desktop-host/lib/index.js') || text.endsWith('@deepseek-ai/dsh-desktop-host');
  });
}

/**
 * 判断本进程是不是 DSH 桌面端派生出来的 host 子进程，以及 shell 的 pid。
 *
 * 判据（任一不满足都不算桌面端，避免误杀无关父进程）：
 * 1. 运行在 Electron 里，且 argv 里有 `dsh-desktop-host/lib/index.js` 入口
 *    （旧版/特殊启动器可能改为注入 `DSH_DESKTOP_NODE_EXECUTABLE` 环境标记，两种都认）；
 * 2. `process.ppid` 合法（>1 且不是自己）；
 * 3. POSIX 下父进程的可执行文件是同一个 Electron 可执行文件 / 标记值
 *    （防止在 DSH 内开的终端里再起 `dsh web` 时误把终端 shell 当 DSH shell）。
 *
 * @param {{
 *   platform?: string,
 *   env?: NodeJS.ProcessEnv,
 *   argv?: string[],
 *   execPath?: string,
 *   ppid?: number,
 *   selfPid?: number,
 *   readParentCommand?: (pid: number) => string|undefined,
 * }} [options]
 * @returns {{desktopHost: boolean, shellPid?: number, reason?: string}}
 */
export function detectDesktopShell({
  platform = process.platform,
  env = process.env,
  argv = process.argv,
  execPath = process.execPath,
  ppid = process.ppid,
  selfPid = process.pid,
  readParentCommand: readCommand = readParentCommand,
} = {}) {
  const marker = normalizeCommand(env?.[DESKTOP_HOST_ENV]);
  const entry = isDesktopHostEntry(argv);
  const parentPid = Number(ppid);
  if (marker === '' && !entry) {
    return { desktopHost: false, reason: '当前进程不是 DSH 桌面端 host 子进程（没有 dsh-desktop-host 入口，也没有桌面端环境标记）' };
  }
  if (!Number.isInteger(parentPid) || parentPid <= 1 || parentPid === selfPid) {
    return { desktopHost: false, reason: `父进程 pid 非法（ppid=${String(ppid)}）` };
  }
  // 桌面端 shell 就是启动本进程的 Electron 可执行文件（标记值或 execPath）。
  const expected = marker !== '' ? marker : normalizeCommand(execPath);
  if (platform !== 'win32') {
    const command = readCommand ? readCommand(parentPid) : undefined;
    if (command !== undefined) {
      const normalized = normalizeCommand(command);
      const expectedBase = expected === '' ? '' : expected.split(/[\\/]/).pop();
      const samePath = normalized !== ''
        && (normalized === expected || (expectedBase !== '' && normalized.split(/[\\/]/).pop() === expectedBase));
      if (!samePath) return { desktopHost: false, reason: `父进程不是 DSH 桌面端 shell：${normalized}` };
    }
  }
  return { desktopHost: true, shellPid: parentPid };
}

/**
 * 生成「重新拉起当前 DSH」的计划（纯函数，不执行任何进程操作）。
 *
 * 返回值形状：
 * - `{ mode: 'desktop-app', supported: true, platform, shellPid, hostPid, bundle?, command, ... }`
 *   —— DSH 桌面端：目标是整个应用进程组（shell 为组长），命令重新打开 `.app` / `.exe`；
 * - `{ mode: 'node', supported: true, platform, execPath, argv, command }`
 *   —— Node CLI：目标是当前进程自己；
 * - `{ mode: 'unsupported', supported: false, platform, reason }`（环境不支持，不算崩溃）。
 *
 * @param {{
 *   platform?: string,
 *   execPath?: string,
 *   argv?: string[],
 *   versions?: Record<string, string>,
 *   env?: NodeJS.ProcessEnv,
 *   ppid?: number,
 *   selfPid?: number,
 *   readParentCommand?: (pid: number) => string|undefined,
 * }} [options]
 */
export function createHostRestartPlan({
  platform = process.platform,
  execPath = process.execPath,
  argv = process.argv,
  versions = process.versions,
  env = process.env,
  ppid = process.ppid,
  selfPid = process.pid,
  readParentCommand: readCommand = readParentCommand,
} = {}) {
  const platformName = String(platform ?? '');
  const exec = String(execPath ?? '');
  const isElectron = Boolean(versions?.electron);

  if (exec === '') {
    return { mode: 'unsupported', supported: false, platform: platformName, reason: '无法确定当前可执行文件路径（execPath 为空）' };
  }

  if (isElectron) {
    const shell = detectDesktopShell({
      platform: platformName,
      env,
      argv,
      execPath: exec,
      ppid,
      selfPid,
      readParentCommand: readCommand,
    });
    if (!shell.desktopHost) {
      return {
        mode: 'unsupported',
        supported: false,
        platform: platformName,
        reason: shell.reason ?? '无法确认 DSH 桌面端 shell（不以某个子进程为目标，避免误杀）',
      };
    }
    if (platformName === 'darwin') {
      const bundle = extractMacBundlePath(exec);
      if (!bundle) {
        return {
          mode: 'unsupported',
          supported: false,
          platform: platformName,
          reason: `macOS Electron 的可执行文件不在 .app 包内，无法安全重启：${exec}`,
        };
      }
      return {
        mode: 'desktop-app',
        supported: true,
        platform: platformName,
        execPath: exec,
        bundle,
        shellPid: shell.shellPid,
        hostPid: selfPid,
        groupKill: true,
        relaunchDelayMs: DESKTOP_RELAUNCH_DELAY_MS,
        command: `open -n ${shellQuote(bundle)}`,
      };
    }
    if (platformName === 'win32') {
      return {
        mode: 'desktop-app',
        supported: true,
        platform: platformName,
        execPath: exec,
        shellPid: shell.shellPid,
        hostPid: selfPid,
        groupKill: false,
        relaunchDelayMs: DESKTOP_RELAUNCH_DELAY_MS,
        command: `start "" ${windowsQuote(exec)}`,
      };
    }
    return {
      mode: 'unsupported',
      supported: false,
      platform: platformName,
      reason: `Electron 平台 ${platformName || 'unknown'} 暂不支持自动重启`,
    };
  }

  // 非 Electron：按 Node CLI 处理（`node <script> <args...>`，例如 `dsh web`）。
  const nodeArgs = Array.isArray(argv) ? argv.slice(1).map((arg) => String(arg)) : [];
  if (platformName === 'win32') {
    return {
      mode: 'node',
      supported: true,
      platform: platformName,
      execPath: exec,
      argv: nodeArgs,
      command: ['start ""', windowsQuote(exec), ...nodeArgs.map(windowsQuote)].join(' '),
    };
  }
  return {
    mode: 'node',
    supported: true,
    platform: platformName,
    execPath: exec,
    argv: nodeArgs,
    command: [shellQuote(exec), ...nodeArgs.map(shellQuote)].join(' '),
  };
}

/** 把毫秒换算成 helper 能用的整秒数（POSIX `sleep` / Windows `ping -n`；至少 min 秒）。 */
function secondsOf(ms, min = 0) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return min;
  return Math.max(min, Math.ceil(value / 1000));
}

/** POSIX 桌面端脚本：整组 SIGTERM → 组内退出（超时整组 SIGKILL）→ 拉起新实例。 */
function buildDesktopPosixScript(plan, { delayMs, killGraceMs, relaunchDelayMs }) {
  const shellPid = Number(plan.shellPid);
  const hostPid = Number(plan.hostPid);
  if (!Number.isInteger(shellPid) || shellPid <= 1) {
    throw hostRestartError(500, 'host-restart-invalid-pid', 'DSH 桌面端 shell pid 非法，无法安排重启');
  }
  const delay = secondsOf(delayMs);
  const grace = secondsOf(killGraceMs, 1);
  const relaunch = secondsOf(relaunchDelayMs);
  const execPath = String(plan.execPath ?? '').replace(/'/g, `'\\''`);
  const bundle = String(plan.bundle ?? '').replace(/'/g, `'\\''`);
  return [
    '# 重启 helper 日志：排查「已关掉但没拉起来」时直接看这里（不含凭据）',
    'LOG="${HOME}/.dsh/remote-access/host-restart.log"',
    'log() { /bin/date "+%Y-%m-%d %H:%M:%S" >> "$LOG" 2>/dev/null; printf "[host-restart] %s\\n" "$1" >> "$LOG" 2>/dev/null; }',
    `log "helper start (shell pid ${shellPid}, host pid ${hostPid})"`,
    `/bin/sleep ${delay}`,
    'shell_alive() {',
    `  s=\$(/bin/ps -o stat= -p ${shellPid} 2>/dev/null | /usr/bin/tr -d ' ')`,
    '  case "\$s" in',
    '    ""|Z*|z*) return 1 ;;',
    '    *) return 0 ;;',
    '  esac',
    '}',
    '# .app 是否已经跑起来（execPath 是 Electron 可执行文件；helper 自己是 /bin/sh，不会误判）',
    'app_running() {',
    `  /bin/ps -axo comm= 2>/dev/null | /usr/bin/grep -F -x '${execPath}' >/dev/null 2>&1`,
    '}',
    '# 清理被 SIGKILL 的旧实例留下的单实例锁（SingletonLock/Cookie/Socket）：',
    '# 不清理的话新实例会把「锁的主进程已死」误判为已有实例，启动 100ms 内直接退出（表现为「没拉起来」）。',
    'cleanup_singleton_locks() {',
    '  cleaned=0',
    '  for dir in "$HOME/Library/Application Support/@deepseek-ai/dsh-desktop" "$HOME/Library/Application Support/DeepSeek Harness" "$HOME/Library/Application Support/dsh-desktop"; do',
    '    [ -d "$dir" ] || continue',
    '    lock="$dir/SingletonLock"',
    '    [ -L "$lock" ] || continue',
    '    owner=$(/usr/bin/readlink "$lock" 2>/dev/null)',
    '    owner_pid="${owner##*-}"',
    '    if [ -n "$owner_pid" ] && kill -0 "$owner_pid" 2>/dev/null; then continue; fi',
    '    /bin/rm -f "$lock" "$dir/SingletonCookie" "$dir/SingletonSocket" 2>/dev/null && cleaned=1',
    '  done',
    '  log "singleton cleanup: cleaned=$cleaned"',
    '}',
    '# 关键：先直接 SIGKILL 浏览器主进程（shell）。不能先 SIGTERM：Electron/Chromium 收到 TERM 会走',
    '# 优雅关闭、先杀 renderer，shell 的 renderer 崩溃处理会弹「应用无法启动或已意外停止」对话框。',
    `kill -KILL ${shellPid} 2>/dev/null || true`,
    'log "shell killed"',
    `kill -KILL -- -${shellPid} 2>/dev/null || true`,
    `if kill -0 ${hostPid} 2>/dev/null; then kill -KILL ${hostPid} 2>/dev/null || true; fi`,
    'log "process group killed"',
    `/bin/sleep ${relaunch}`,
    'if shell_alive; then log "abort: shell still alive"; exit 1; fi',
    'cleanup_singleton_locks',
    `sleep 1`,
    '# 1) 首选 LaunchServices 正常激活（窗口/Dock 行为与手动打开一致）',
    `/usr/bin/open -n '${bundle}' >/dev/null 2>&1`,
    `open_rc=$?`,
    'log "open -n rc=$open_rc; waiting for app"',
    'n=0',
    'while [ "$n" -lt 10 ]; do',
    '  app_running && break',
    '  n=$((n + 1))',
    '  /bin/sleep 1',
    'done',
    'if app_running; then log "relaunched via open"; exit 0; fi',
    'log "open did not start the app; fallback to direct exec"',
    '# 2) 兜底：直接执行 .app 内的可执行文件。必须清掉 ELECTRON_RUN_AS_NODE / IPC 环境变量，',
    '#    否则 Electron 会以 Node 模式运行、不会起 GUI。',
    `/usr/bin/env -u ELECTRON_RUN_AS_NODE -u NODE_CHANNEL_FD -u NODE_CHANNEL_SERIALIZATION_MODE '${execPath}' >/dev/null 2>&1 &`,
    'n=0',
    'while [ "$n" -lt 10 ]; do',
    '  app_running && break',
    '  n=$((n + 1))',
    '  /bin/sleep 1',
    'done',
    'if app_running; then log "relaunched via direct exec"; exit 0; fi',
    'log "FAILED: app still not running after open + direct exec"',
    'exit 1',
  ].join('\n');
}

/** Windows 桌面端脚本（best-effort）：先杀 shell、再补杀 host 子进程，最后 start 新实例。 */
function buildDesktopWindowsScript(plan, { delayMs, killGraceMs, relaunchDelayMs }) {
  const shellPid = Number(plan.shellPid);
  const hostPid = Number(plan.hostPid);
  if (!Number.isInteger(shellPid) || shellPid <= 1) {
    throw hostRestartError(500, 'host-restart-invalid-pid', 'DSH 桌面端 shell pid 非法，无法安排重启');
  }
  const delay = secondsOf(delayMs);
  const grace = secondsOf(killGraceMs, 1);
  const relaunch = secondsOf(relaunchDelayMs);
  return [
    `ping -n ${Math.max(2, delay + 1)} 127.0.0.1 >nul 2>&1`,
    `taskkill /PID ${shellPid} /F >nul 2>&1`,
    `ping -n ${Math.max(2, grace + 1)} 127.0.0.1 >nul 2>&1`,
    `taskkill /PID ${hostPid} /F >nul 2>&1`,
    `ping -n ${Math.max(2, relaunch + 1)} 127.0.0.1 >nul 2>&1`,
    plan.command,
  ].join(' & ');
}

/** POSIX CLI 模式脚本：延迟 → SIGTERM 自己（超时 SIGKILL）→ 延迟 → 原样重新拉起。 */
function buildNodeScript(plan, { pid, delayMs, killGraceMs, relaunchDelayMs }) {
  const targetPid = Number(pid);
  if (!Number.isInteger(targetPid) || targetPid <= 0) {
    throw hostRestartError(500, 'host-restart-invalid-pid', '当前进程 pid 非法，无法安排重启');
  }
  const delay = secondsOf(delayMs);
  const grace = secondsOf(killGraceMs, 1);
  const relaunch = secondsOf(relaunchDelayMs);
  return [
    `/bin/sleep ${delay}`,
    `kill -TERM ${targetPid} 2>/dev/null || true`,
    'n=0',
    `while kill -0 ${targetPid} 2>/dev/null; do`,
    '  n=$((n + 1))',
    `  if [ "$n" -ge ${grace} ]; then kill -KILL ${targetPid} 2>/dev/null || true; break; fi`,
    '  sleep 1',
    'done',
    `sleep ${relaunch}`,
    `exec ${plan.command}`,
  ].join('\n');
}

/** Windows CLI（非桌面端）：延迟 → taskkill 自己 → 再延迟 → start 重新拉起。 */
function buildNodeWindowsScript(plan, { pid, delayMs, killGraceMs, relaunchDelayMs }) {
  const targetPid = Number(pid);
  if (!Number.isInteger(targetPid) || targetPid <= 0) {
    throw hostRestartError(500, 'host-restart-invalid-pid', '当前进程 pid 非法，无法安排重启');
  }
  const delay = secondsOf(delayMs);
  const grace = secondsOf(killGraceMs, 1);
  const relaunch = secondsOf(relaunchDelayMs);
  return [
    `ping -n ${Math.max(2, delay + 1)} 127.0.0.1 >nul 2>&1`,
    `taskkill /PID ${targetPid} /F >nul 2>&1`,
    `ping -n ${Math.max(2, grace + 1)} 127.0.0.1 >nul 2>&1`,
    `ping -n ${Math.max(2, relaunch + 1)} 127.0.0.1 >nul 2>&1`,
    plan.command,
  ].join(' & ');
}

/**
 * 生成 shell helper 的脚本文本（POSIX `/bin/sh -c` 或 Windows `cmd.exe /c`）。
 * 脚本顺序：等待 → 杀目标（桌面端=整组 + 补杀 host；CLI=自己）→ 等待 → 重新拉起。
 *
 * @param {ReturnType<typeof createHostRestartPlan>} plan
 * @param {{
 *   pid?: number,
 *   delayMs?: number,
 *   killGraceMs?: number,
 *   relaunchDelayMs?: number,
 * }} [options]
 * @returns {string}
 */
export function buildHostRestartScript(plan, {
  pid = process.pid,
  delayMs = HOST_RESTART_DELAY_MS,
  killGraceMs = HOST_RESTART_KILL_GRACE_MS,
  relaunchDelayMs = plan?.relaunchDelayMs ?? HOST_RESTART_RELAUNCH_DELAY_MS,
} = {}) {
  if (!plan?.supported) {
    throw hostRestartError(501, 'host-restart-unsupported', plan?.reason ?? '当前环境不支持自动重启');
  }
  if (plan.platform === 'win32') {
    if (plan.mode === 'desktop-app') return buildDesktopWindowsScript(plan, { delayMs, killGraceMs, relaunchDelayMs });
    return buildNodeWindowsScript(plan, { pid, delayMs, killGraceMs, relaunchDelayMs });
  }
  if (plan.mode === 'desktop-app') return buildDesktopPosixScript(plan, { delayMs, killGraceMs, relaunchDelayMs });
  return buildNodeScript(plan, { pid, delayMs, killGraceMs, relaunchDelayMs });
}

/**
 * 起 detached shell helper 执行重启（**真会杀进程**；测试必须注入 fake spawnImpl）。
 *
 * helper 与当前进程的关系：它是当前进程的子进程，但 `detached: true` 后自成进程组，
 * 父进程（以及整个 DSH 桌面端进程组）被 SIGTERM/SIGKILL 后仍能继续执行「重新拉起」步骤。
 *
 * @param {ReturnType<typeof createHostRestartPlan>} plan
 * @param {{
 *   pid?: number,
 *   log?: (message: string) => void,
 *   spawnImpl?: typeof spawn,
 *   env?: NodeJS.ProcessEnv,
 *   delayMs?: number,
 *   killGraceMs?: number,
 *   relaunchDelayMs?: number,
 * }} [options]
 * @returns {{mode: string, pid: number, shell: string, args: string[], script: string, child: any}}
 */
export function scheduleHostRestart(plan, {
  pid = process.pid,
  log = () => {},
  spawnImpl = spawn,
  env = process.env,
  delayMs = HOST_RESTART_DELAY_MS,
  killGraceMs = HOST_RESTART_KILL_GRACE_MS,
  relaunchDelayMs = plan?.relaunchDelayMs ?? HOST_RESTART_RELAUNCH_DELAY_MS,
} = {}) {
  if (env?.[HOST_RESTART_DISABLE_ENV] === '1') {
    throw hostRestartError(501, 'host-restart-disabled', `主机重启已被环境变量 ${HOST_RESTART_DISABLE_ENV}=1 禁用`);
  }
  if (!plan?.supported) {
    throw hostRestartError(501, 'host-restart-unsupported', plan?.reason ?? '当前环境不支持自动重启');
  }
  if (typeof spawnImpl !== 'function') {
    throw hostRestartError(500, 'host-restart-no-spawn', '未提供可用的 spawn 实现，无法安排重启');
  }

  const script = buildHostRestartScript(plan, { pid, delayMs, killGraceMs, relaunchDelayMs });
  const isWindows = plan.platform === 'win32';
  /** @type {{detached: boolean, stdio: string, windowsHide: boolean, env: any, windowsVerbatimArguments?: boolean}} */
  const spawnOptions = { detached: true, stdio: 'ignore', windowsHide: true, env };
  let shell;
  let args;
  if (isWindows) {
    // cmd.exe 的引号规则很绕：用 `/d`（跳过 AutoRun）+ `/s`（去掉最外层引号后原样执行），
    // 配合 windowsVerbatimArguments 把「已带引号的整段命令」直接交给 cmd。
    shell = 'cmd.exe';
    args = ['/d', '/s', '/c', `"${script}"`];
    spawnOptions.windowsVerbatimArguments = true;
  } else {
    shell = '/bin/sh';
    args = ['-c', script];
  }

  let child;
  try {
    child = spawnImpl(shell, args, spawnOptions);
  } catch (error) {
    throw hostRestartError(500, 'host-restart-spawn-failed', `无法启动重启助手进程: ${error?.message ?? error}`, { cause: error });
  }
  if (!child || (typeof child !== 'object' && typeof child !== 'function')) {
    throw hostRestartError(500, 'host-restart-spawn-failed', 'spawn 未返回子进程，无法确认重启助手已启动');
  }
  try {
    child.unref?.();
  } catch {
    /* unref 失败不影响 helper 运行（helper 已 detached） */
  }
  const target = plan.mode === 'desktop-app' ? `shell pid ${String(plan.shellPid)}（整组）` : `pid ${pid}`;
  log(`已安排主机重启助手（mode=${plan.mode}, ${target}）：约 ${secondsOf(delayMs)}s 后重启`);
  return { mode: plan.mode, pid, shell, args, script, child };
}

/**
 * 组合「生成计划 + 起 helper」。返回 `{ mode }`（另含 plan/pid 等调试信息）。
 *
 * @param {Parameters<typeof createHostRestartPlan>[0] & {
 *   pid?: number,
 *   log?: (message: string) => void,
 *   spawnImpl?: typeof spawn,
 *   env?: NodeJS.ProcessEnv,
 *   delayMs?: number,
 *   killGraceMs?: number,
 *   relaunchDelayMs?: number,
 * }} [options]
 * @returns {{mode: string, pid: number, plan: object, script: string}}
 */
export function requestHostRestart(options = {}) {
  const {
    platform,
    execPath,
    argv,
    versions,
    env = process.env,
    ppid,
    selfPid,
    readParentCommand: readCommand,
    pid = process.pid,
    log = () => {},
    spawnImpl,
    delayMs,
    killGraceMs,
    relaunchDelayMs,
  } = options;

  const plan = createHostRestartPlan({ platform, execPath, argv, versions, env, ppid, selfPid, readParentCommand: readCommand });
  if (!plan.supported) {
    throw hostRestartError(501, 'host-restart-unsupported', plan.reason ?? '当前环境不支持自动重启');
  }
  const scheduled = scheduleHostRestart(plan, { pid, log, spawnImpl, env, delayMs, killGraceMs, relaunchDelayMs });
  return { mode: plan.mode, pid, plan, script: scheduled.script };
}

/**
 * 去重调度器：`windowMs` 内重复触发只真正调度一次（其余直接返回上一次的 mode + `deduped: true`）。
 *
 * - 进程被杀后内存状态本来就会消失，所以窗口只需覆盖「用户连点 / App 重试」的几秒；
 * - 只有**成功**调度才推进时间戳：调度抛错（禁用/不支持/起进程失败）后可立即重试。
 *
 * @param {{
 *   windowMs?: number,
 *   now?: () => number,
 *   request?: typeof requestHostRestart,
 *   log?: (message: string) => void,
 * }} [options]
 */
export function createHostRestartScheduler({
  windowMs = HOST_RESTART_DEDUPE_WINDOW_MS,
  now = () => Date.now(),
  request = requestHostRestart,
  log = () => {},
} = {}) {
  const window = Math.max(0, Number(windowMs) || 0);
  let lastRequestAt = 0;
  let lastMode = null;

  return {
    get windowMs() {
      return window;
    },
    get lastRequestAt() {
      return lastRequestAt > 0 ? lastRequestAt : null;
    },
    /**
     * @param {object} [options] 透传给 request（platform/execPath/... 便于测试注入）
     * @returns {{mode: string, deduped: boolean}}
     */
    request(options = {}) {
      const ts = Number(now());
      if (lastRequestAt > 0 && ts >= lastRequestAt && ts - lastRequestAt < window) {
        log(`主机重启在 ${window}ms 内已触发过，忽略本次重复请求（mode=${lastMode ?? 'unknown'}）`);
        return { mode: lastMode ?? 'unknown', deduped: true };
      }
      const result = request(options) ?? {};
      lastRequestAt = ts;
      lastMode = result.mode ?? null;
      return { ...result, deduped: false };
    },
  };
}
