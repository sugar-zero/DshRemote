# 11 — 远程重启主机：0.1.10 之后四轮真机修复（目标 → 识别 → 杀法 → 拉起）

> 承接 [`10-mobile-host-actions.md`](10-mobile-host-actions.md) §2。
> 背景：手机 App 顶栏 ⏻ 远程重启主机 DSH。0.1.10 上线后，连续四次真机重试依次暴露
> 「杀错目标 → 识别失败 → 杀法触发弹窗 → 关掉但没拉起」四个独立问题，分别对应
> host-plugin **0.1.11 / 0.1.12 / 0.1.13 / 0.1.14**。
>
> 状态：0.1.14 修复已由用户实测确认，并与「等待作答推送」合并发布为 **0.1.15**；
> **0.1.16** 起「重启主机」改为可关闭组件（默认关闭，开关见 ACCEPTANCE #36 / STATUS 2026-10-27）。
> 本文区分「已确认事实」与「推断」。

## 1. 四轮迭代与根因

### 1.1 0.1.10 → 0.1.11：只杀 host 子进程 → 崩溃弹窗 + 双实例（第一轮真机失败）

- 真机现象：点 ⏻ 出现「应用无法启动或已意外停止」对话框，随后又出现一个 DSH 实例、
  两个实例抢端口（日志里有 `host web port` 冲突）。
- 原因：插件跑在 DSH 桌面端 Electron shell 派生的 **host 子进程**里；0.1.10 只 `SIGTERM`
  了 host 子进程，shell 判定「dsh desktop host stopped」→ 弹恢复对话框；helper 又
  `open -n` 拉起第二个实例。
- 修复（0.1.11）：重启目标改为**整个 DSH 应用进程组**（shell 为组长），等旧实例退出、
  端口释放后再拉起一个实例；同时加了桌面端识别（`DSH_DESKTOP_NODE_EXECUTABLE` 环境变量
  + 父进程校验）——但这个环境变量实际不会被注入，是下一轮失败的伏笔。

### 1.2 0.1.11 → 0.1.12：识别依赖了实际不存在的环境变量（点 ⏻ 没有任何反应）

- 真机现象：点 ⏻ 无任何反应（App 可能弹过 501 提示）。
- 审计日志对得上：`host-restart failed / host-restart-unsupported`（端点回了 501）。
- 原因：查 DSH 桌面端源码（只读解包），`DSH_DESKTOP_NODE_EXECUTABLE` 只在拉起子进程
  **传 bin 参数**时才注入；拉起 dsh-desktop-host 时传的是 `void 0` —— 变量根本不存在，
  桌面端判定必然失败。
- 修复（0.1.12）：改用真实判据 —— Electron 运行时 + `process.argv` 含
  `@deepseek-ai/dsh-desktop-host/lib/index.js` 入口 + 父进程必须是同一个 Electron 可执行文件
  （双重校验，避免在 DSH 内开的终端里误杀 host）。

### 1.3 0.1.12 → 0.1.13：整组 SIGTERM 触发 Electron「崩溃恢复」弹窗

- 真机现象：点 ⏻ 后出现「应用无法启动或已意外停止」对话框，随后又重新拉起。
- 崩溃日志：`Desktop renderer exited: killed` —— 整组 `SIGTERM` 让 Electron 走优雅关闭、
  先杀 renderer，shell 的 renderer 崩溃处理随即弹恢复对话框。
- 修复（0.1.13）：先直接 `SIGKILL` 浏览器主进程（不经过优雅关闭、不先杀 renderer）→
  再整组 `SIGKILL` 清理 renderer/utility/host → 确认旧实例退出（僵尸视为已退出）→
  等 ~2.5s 端口释放 → `open -n` 只拉起一个实例。

### 1.4 0.1.13 → 0.1.14：新实例被拉起后 79ms 自杀（主机被关掉、但没被拉起来）

本机 unified log（2026-10-26，已脱敏）：

```text
23:32:39      audit: host-restart accepted / desktop-app
23:32:40.300  WindowServer: 旧 DSH 进程死亡（pid 64987）
23:32:43.380  launchd: Successfully spawned DeepSeek Harness[65483]
23:32:43.459  loginwindow: appDeath（距 spawn 79ms）
23:32:43.441  chromium: codesign_util.cc:79 task_name_for_pid: (os/kern) failure (5)
```

- DSH 桌面端源码（只读解包）里 `claimDesktopSingleInstance()`：
  `requestSingleInstanceLock()` 返回 false 就 `application.quit()`。
- **推断的根因**：`SIGKILL` 不会清理 Electron 单实例锁（`SingletonLock` / `SingletonCookie` /
  `SingletonSocket` 指向已死的 pid）。新实例启动时锁校验失败 → 直接 quit；失败实例退出时
  顺手清掉了陈旧锁，所以稍后手动重开正常。
- 证据强度：**「新实例被拉起、79ms 后自杀」有日志直接证据**；「陈旧单实例锁导致
  `requestSingleInstanceLock()` 失败」是结合源码退出路径 + codesign 报错 + 稍后手动重开成功
  推出的**推断**，没有直接观测到锁返回值。下一次失败时以 helper 日志为准。

## 2. 0.1.14 的修复

`lib/host-restart.js` 生成的 macOS helper 脚本新增：

1. 全程写日志到 `~/.dsh/remote-access/host-restart.log`（不含凭据）：启动 / 杀进程 /
   清锁 / `open` 返回码 / 校验结果 / 兜底；
2. 拉起前**清理陈旧单实例锁**：`SingletonLock` 是符号链接时解析属主 pid，
   **属主已死才删** `SingletonLock` / `SingletonCookie` / `SingletonSocket`（属主存活不动）；
3. `open -n <bundle>` 后轮询 `ps -axo comm=` **精确匹配应用 execPath**，确认应用真的在跑；
4. 校验失败时**兜底**：直接执行 `.app/Contents/MacOS/<bin>`，并清掉 `ELECTRON_RUN_AS_NODE`、
   `NODE_CHANNEL_FD`、`NODE_CHANNEL_SERIALIZATION_MODE`（否则 Electron 会以 Node 模式跑、不起 GUI）；
5. 系统命令统一用绝对路径（防 PATH 异常）；顺带修了两处脚本生成 bug：
   `printf` 格式串里的 `\n` 被 JS 模板提前转义、`log "helper start (shell pid …)"` 未在构建时插值。

## 3. 验证

- Host：`npm test` **158/158**、`validate:artifacts` 通过（2026-10-26 第 8 轮；2026-10-27
  复核会话复跑仍为 158/158）。新增「生成的 helper 脚本通过 `sh -n` 语法检查」用例。
- 本机端到端模拟（临时 `HOME` + 自建 dummy 进程组，**全程不触碰真实 DSH 进程**）：
  - 触发并验证：dummy 进程组（模拟 shell + host）被杀 → `open -n` 拉起 → `ps` 校验；
  - 兜底路径：bundle 指向不存在路径 → 直接执行可执行文件；
  - 锁清理：属主已死的锁被删除；属主存活的锁保持不动。
  - 场景 4 的断言一开始用 `existsSync` 判断符号链接（悬空链接会返回 false）导致误报，
    改用 `lstat` 后通过 —— 是测试脚本自身问题，不是产品代码问题。
- **测试对象说明（如实记录）**：e2e 需要一个真实 macOS GUI 应用作为「被拉起的应用」，
  选用了**系统 Calculator**（`/System/Applications/Calculator.app`，用 AppleScript 退出）；
  其中「直接执行兜底」改用自建常驻二进制验证——Calculator 是沙盒应用，不能直接 exec。
  由于 helper 脚本 / 测试断言在迭代中反复修正，该验证前后**拉起 Calculator 约 20+ 次**。
  该做法会弹出窗口、甚至先退出用户自己开着的 Calculator，属于侵入用户桌面；此后已在根
  `AGENTS.md` 六.9 明确禁止「擅自拉起其他应用」。后续替代方案：在系统临时目录自建最小
  `.app`（常驻二进制 + `Info.plist`）当测试对象，或每次操作前征得用户同意。
- **已复验（2026-10-27，用户确认）**：0.1.14 修复后点 ⏻ 可正常关闭并自动拉起；随后合并发布
  **0.1.15**（含等待作答推送）。再在 **0.1.16** 把该能力改为**可关闭组件**（默认关闭；
  开关在 DSH 本机「设置 → 远程访问 → 组件」；关闭时 App 不显示 ⏻、接口一律 501
  `host-restart-disabled` 且不调度 helper，见 ACCEPTANCE #36）。App 侧在进入主机 / 回前台 /
  点 ↻ 刷新 / 页面加载完成 / WS 重连时都会重新读取组件状态，按钮实时出现/消失。
  排查断点仍可看 `~/.dsh/remote-access/host-restart.log`（每一步都有记录）。

## 4. 未覆盖 / 风险

- **Windows 桌面端**仍是 best-effort（`taskkill /F` + `start`），没有同样的「清锁 / 校验 / 兜底」，
  且本环境无 Windows 可验证；
- **Linux Electron** 仍返回 501；
- 锁清理**硬编码 3 个候选 userData 目录**（`@deepseek-ai/dsh-desktop` 等）：DSH 若改产品名 /
  多频道，清理会静默失效，旧症状可能复发；
- 锁属主 pid 若被复用，可能误判「锁还活着」而不清理（概率低）；
- `app_running()` 依赖 `ps -axo comm=` 与 execPath 精确匹配：应用被 translocation / 路径变化时
  可能误判为未启动（会走兜底，最多多起一个会被单实例锁挡掉的进程）；
- helper 日志无轮转（每次重启约 10 行，可忽略）；
- 0.1.16 起组件**默认关闭**：升级后需在 DSH 本机「设置 → 远程访问 → 组件」主动开启才显示 ⏻；
  该设置页仅本机可见（远程 WebView 不注册，管理 API 的 deny 边界不变）。

## 5. 相关

- 实现：`dsh-remoteService/packages/host-plugin/lib/host-restart.js`、
  `test/host-restart.test.js`、`lib/server.js`、`lib/service.js`；
  组件开关：`lib/config.js`（`restartHostEnabled`，默认 false）、`lib/server.js`（501 门禁）、
  `client.js`（「设置 → 远程访问 → 组件」开关）、App `src/screens/WebViewScreen.tsx`；
  [`ADMIN-API.md`](../../dsh-remoteService/docs/ADMIN-API.md) §2、ACCEPTANCE #36
- 上文：[`10-mobile-host-actions.md`](10-mobile-host-actions.md)（功能链路与安全评审）
- 安全姿态：根 `AGENTS.md` 五；操作边界：根 `AGENTS.md` 六.9（不擅自拉起其他应用）
