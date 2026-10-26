/**
 * 主机 DSH 客户端「远程重启」的调度实现（Host 半，零新依赖）。
 *
 * 只做两件事：
 * 1. `createHostRestartPlan()`：纯函数，按平台/可执行文件路径算出「怎么把当前 DSH 重新拉起来」；
 * 2. `scheduleHostRestart()`：起一个 **detached** 的 shell helper（stdio ignore + unref）——
 *    先等 ~1s 让 HTTP 202 响应发完 → 杀当前 pid（SIGTERM；超时 ~10s 后 SIGKILL）→ 再等一点 → 重新拉起。
 *
 * 边界：
 * - 只重启**当前 DSH 进程**（Electron 桌面端或 `dsh web` Node CLI），不碰 relay / 系统服务 / ~/.dsh 数据；
 * - 重新拉起的子进程继承当前工作目录与环境变量（与 DSH 启动时一致），不做任何提权；
 * - spawn 可注入（生产默认 `node:child_process.spawn`，测试注入 fake，**绝不真的杀进程**）；
 * - `DSH_REMOTE_DISABLE_HOST_RESTART=1` 时拒绝调度（测试/CI 防误重启本机）。
 */

import { spawn } from 'node:child_process';

/** 禁用远程重启的环境变量；为 '1' 时调度直接抛 501。 */
export const HOST_RESTART_DISABLE_ENV = 'DSH_REMOTE_DISABLE_HOST_RESTART';

/** 默认：先等 1s 让 202 响应发完再杀进程。 */
export const HOST_RESTART_DELAY_MS = 1000;
/** 默认：SIGTERM 后最多等 10s，仍存活则 SIGKILL。 */
export const HOST_RESTART_KILL_GRACE_MS = 10_000;
/** 默认：当前进程退出后再等 1s 才重新拉起（给端口/单实例锁留释放时间）。 */
export const HOST_RESTART_RELAUNCH_DELAY_MS = 1000;
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
 * 仅用于 `start "" "<exe>"`、taskkill 等固定形态的命令；路径里出现 `%` 的极端情况未做处理
 * （Windows 下 DSH 安装路径不会包含 `%`）。
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

/**
 * 生成「重新拉起当前 DSH」的计划（纯函数，不执行任何进程操作）。
 *
 * 返回值形状：
 * - `{ mode: 'mac-app', supported: true, platform, execPath, bundle, command }`
 * - `{ mode: 'win-app', supported: true, platform, execPath, command }`
 * - `{ mode: 'node', supported: true, platform, execPath, argv, command }`
 * - `{ mode: 'unsupported', supported: false, platform, reason }`（环境不支持，不算崩溃）
 *
 * `command` 是已带引号的「重新拉起命令」片段，由 shell helper 在最后一步执行。
 *
 * @param {{
 *   platform?: string,
 *   execPath?: string,
 *   argv?: string[],
 *   versions?: Record<string, string>,
 * }} [options]
 */
export function createHostRestartPlan({
  platform = process.platform,
  execPath = process.execPath,
  argv = process.argv,
  versions = process.versions,
} = {}) {
  const platformName = String(platform ?? '');
  const exec = String(execPath ?? '');
  const isElectron = Boolean(versions?.electron);

  if (exec === '') {
    return { mode: 'unsupported', supported: false, platform: platformName, reason: '无法确定当前可执行文件路径（execPath 为空）' };
  }

  if (isElectron) {
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
        mode: 'mac-app',
        supported: true,
        platform: platformName,
        execPath: exec,
        bundle,
        command: `open -n ${shellQuote(bundle)}`,
      };
    }
    if (platformName === 'win32') {
      return {
        mode: 'win-app',
        supported: true,
        platform: platformName,
        execPath: exec,
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

/**
 * 生成 shell helper 的脚本文本（POSIX `/bin/sh -c` 或 Windows `cmd.exe /c`）。
 * 脚本顺序：等待 → 杀当前 pid（SIGTERM，超时 SIGKILL）→ 等待 → 重新拉起。
 *
 * @param {ReturnType<typeof createHostRestartPlan>} plan
 * @param {{pid?: number, delayMs?: number, killGraceMs?: number, relaunchDelayMs?: number}} [options]
 * @returns {string}
 */
export function buildHostRestartScript(plan, {
  pid = process.pid,
  delayMs = HOST_RESTART_DELAY_MS,
  killGraceMs = HOST_RESTART_KILL_GRACE_MS,
  relaunchDelayMs = HOST_RESTART_RELAUNCH_DELAY_MS,
} = {}) {
  if (!plan?.supported) {
    throw hostRestartError(501, 'host-restart-unsupported', plan?.reason ?? '当前环境不支持自动重启');
  }
  const targetPid = Number(pid);
  if (!Number.isInteger(targetPid) || targetPid <= 0) {
    throw hostRestartError(500, 'host-restart-invalid-pid', '当前进程 pid 非法，无法安排重启');
  }
  const delay = secondsOf(delayMs);
  const grace = secondsOf(killGraceMs, 1);
  const relaunch = secondsOf(relaunchDelayMs);

  if (plan.platform === 'win32') {
    // Windows best-effort：
    // - 用 ping 延迟而不是 timeout：timeout 在 stdin 被重定向（stdio: 'ignore'）时会立即失败，
    //   导致 202 还没发完就 taskkill；ping -n <秒数+1> 是无需控制台的等秒惯用法；
    // - taskkill /F 立即结束目标进程（不加 /T，避免连带杀掉本 helper 自身——helper 是目标进程的子进程）；
    // - start "" 由 cmd 内再拉起（失败时用户仍需手动打开 DSH）；
    // - 用 `& ` 串成单行：cmd /c 里多行脚本文本不可靠。
    return [
      `ping -n ${Math.max(2, delay + 1)} 127.0.0.1 >nul 2>&1`,
      `taskkill /PID ${targetPid} /F >nul 2>&1`,
      `ping -n ${Math.max(2, relaunch + 1)} 127.0.0.1 >nul 2>&1`,
      plan.command,
    ].join(' & ');
  }

  return [
    `sleep ${delay}`,
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

/**
 * 起 detached shell helper 执行重启（**真会杀进程**；测试必须注入 fake spawnImpl）。
 *
 * helper 与当前进程的关系：它是当前进程的子进程，但 `detached: true` 后自成进程组，
 * 父进程被 SIGTERM/SIGKILL 后仍能继续执行「重新拉起」步骤。
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
  relaunchDelayMs = HOST_RESTART_RELAUNCH_DELAY_MS,
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
    // 配合 windowsVerbatimArguments 把「已带引号的整段命令」直接交给 cmd，
    // 避免 Node 的参数转义与 cmd /c 的引号启发式互相打架（脚本里还有 start "" "<exe>" 的双引号）。
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
  log(`已安排主机重启助手（mode=${plan.mode}, pid=${pid}）：约 ${secondsOf(delayMs)}s 后重启`);
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
    platform = process.platform,
    execPath = process.execPath,
    argv = process.argv,
    versions = process.versions,
    pid = process.pid,
    log = () => {},
    spawnImpl,
    env,
    delayMs,
    killGraceMs,
    relaunchDelayMs,
  } = options;

  const plan = createHostRestartPlan({ platform, execPath, argv, versions });
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
