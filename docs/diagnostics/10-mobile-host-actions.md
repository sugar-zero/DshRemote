# 10 — 手机 App：隐藏「在主机本机打开」入口 + 远程「重启主机 DSH」

> 需求（2026-10-26，用户）：
> 1. 手机 App 上 DSH 会话头/右栏里的「打开工作区 / 在文件夹中显示」实际是在**主机**的
>    Finder/本地应用打开，对 App 没有作用——直接隐藏；
> 2. 给 App 加「重启主机客户端」：给主机装插件/改完功能后经常要重启 DSH 才生效，
>    不想每次都回电脑手动重启。
>
> 落地版本：App **0.1.11 (build 13)**、host-plugin **0.1.10**。

## 1. 隐藏「在主机本机打开」控件

### 1.1 它是什么

DSH 的核心插件 `@deepseek-ai/dsh-client-ui-open-in-app` 在多个 Slot 渲染「打开 / 显示文件位置」
split 控件（`OpenTargetButton`）：

| Slot | 用途 |
|---|---|
| `conversation.session.header.utilities` | 会话头右侧：打开当前工作区目录 |
| `sidebar.right.tab.files.actions` | 右栏文件 tab：打开目录 |
| `sidebar.right.tab.document.actions` / `.unpreviewable` | 文档预览：打开文件 / 显示位置 |
| `deliverables.file.actions` / `.review.file.actions` | 交付物文件：打开文件 |

点击后走 `session.openWorkspacePath(path, { action: 'open' | 'reveal' })`：在**主机桌面**上用
Finder / 默认应用打开该路径。对通过远程 WebView 用手机的用户，动作发生在电脑上、手机无反馈，
既无用又占位（会话头还容易误触）。

### 1.2 做法（App 注入壳 CSS）

这些控件 DOM 带稳定的 `data-*` 契约（从已安装 DSH 0.2.1-rc.3 的
`open-in-app/lib/client.js` 只读确认，全 asar 只有该插件使用这些属性）：

- split 控件根：`[data-open-target="directory"|"file"]`
- 内部：`[data-open-path-open]` / `[data-open-path-more]` / `[data-open-path-unpreviewable]`
- 加载骨架：`[data-open-target-skeleton]`

在 `dsh-remoteApp/src/lib/mobileWebShell.ts` 注入的全局 CSS（本壳只注入 App 的 WebView，
桌面 DSH 浏览器不受影响）里对上述属性 `display: none !important`。规则**不放进窄屏
`@media`**：iPad（App 开启 `supportsTablet`）上这个动作同样发生在主机本机，所以与宽度无关。

只隐藏控件本身、不隐藏整个 `[data-slot]`——同一槽位还有其它插件按钮（DSH 0.2.1-rc.3 里
`dsh-client-ui-schedule` / `dsh-session-log-export` 也注册在 `conversation.session.header.utilities`）。

### 1.3 验证

`dsh-remoteApp/scripts/check-injected-shell.mjs` 新增第四份 fixture（真实形态的 header
utilities 槽：1 个普通插件按钮 + 4 种 open-in-app 控件），断言：

- 窄屏/宽屏（1000×800，iPad 场景）split 控件根 `display: none`；
- 内部主按钮/下拉箭头/骨架 `clientRects=0`（确实不再渲染）；
- 同 slot 的普通插件按钮仍可见、可命中（没有整段隐藏 slot）；
- 无 JS 异常。

`npm run check:shell` → **57/57**（原 52 + 新增 5）；用 HEAD 旧版 `mobileWebShell.ts` 对照跑，
恰好新增断言失败（证明用例能抓回归）。

## 2. 远程「重启主机 DSH」

### 2.1 链路

```
App（设备 mTLS 证书）
  → POST https://<hostId>.relay.example.com/__dsh_remote/restart
  → relay（盲管道）→ 主机插件 mTLS 监听（127.0.0.1:<port>，经 relay TLS 透传）
  → 校验设备证书 → 同步回 202 → detached helper：等 ~1s → SIGTERM 当前 DSH pid
    （~10s 未退出则 SIGKILL）→ 等 ~1s → 按运行形态重新拉起
  → App 轮询 GET /__dsh_remote/status（1.5s × 最多 30s）→ 200 后 reload WebView
```

- **macOS Electron 桌面端**：从 `process.execPath`（`.../*.app/Contents/MacOS/<bin>`）截出
  `.app`，重启命令 `open -n <bundle>`；
- **Windows Electron**：`cmd.exe /c start "" "<exe>"` + `taskkill /F`（best-effort，无本机可验）；
- **Node CLI（`dsh web`）**：`process.execPath` + 原 `argv.slice(1)` 重新拉起；
- 其它（如 Linux Electron）：返回 **501**（`host-restart-unsupported`）。

helper 用 `spawn(..., { detached: true, stdio: 'ignore' }).unref()`：父进程被杀后仍能执行
「重新拉起」；命令行里只有路径与 pid（无凭据、无 token）。

### 2.2 端点契约（详见 `dsh-remoteService/docs/ADMIN-API.md` §2）

| 情况 | 响应 |
|---|---|
| POST，成功调度 | **202** `{ ok:true, data:{ restarting:true, mode:'mac-app'|'win-app'|'node' } }` |
| 非 POST | 405 |
| 未注入（旧监听）/环境不支持/`DSH_REMOTE_DISABLE_HOST_RESTART=1` | 501（可读 message） |
| 调度失败（spawn 起不来等） | 500 |

- 10s 内重复请求去重（第二次仍回 202，不再调度第二次）；
- 每个请求一条审计：`{ deviceId, action:'host-restart', result:'accepted'|'failed', hash: mode|'deduped'|错误码 }`
  （`GET /__dsh_remote/audit` 可查）。

### 2.3 安全评审（为什么可以开这个口子）

1. **身份不变**：仍是 `requestCert` + 设备证书链自校验（AGENTS 五.1）；没有引入
   「来源 IP / 自定义头 / 查询参数 token」；
2. **不是新提权面**：配对的远程设备本来就能通过同一隧道完整操作主机 DSH（发对话、让 Agent
   执行命令/终端、改文件）。能远程重启 DSH 比「能执行任意命令」弱得多；
3. **爆炸半径受控**：只结束**当前 DSH 进程**，不碰 relay、系统服务、`~/.dsh` 数据/凭据；
   重新拉起的进程继承当前 cwd/env，不做提权；不写文件、不安装任何东西；
4. **可审计**：每次请求都落 `audit.jsonl`，可在 App 设备页/管理 API 查看；
5. **可关闭**：`DSH_REMOTE_DISABLE_HOST_RESTART=1` 让端点固定返回 501（CI/测试/不希望开的环境）；
6. **风险提示**：supervisor 托管（launchd `KeepAlive` / systemd `Restart=`）的 `dsh web`，supervisor
   也会拉起，可能与 helper 短暂竞争（多起实例因端口占用退出）；这类部署建议在 supervisor 层重启。

### 2.4 「第一次」需要手动重启一次

旧版 host-plugin（<0.1.10）没有该端点，所以**升级到 0.1.10 后仍需在电脑上手动重启一次 DSH**
来加载新 Host 半；之后 App 里这个按钮才可用（旧 Endpoint 会返回 404/501，App 会给出可读提示）。
这是功能本身的引导问题，无法从 App 侧绕过（除非另开本机管理通道）。

### 2.5 App 侧交互

- 顶栏（返回 / 标题 / 设置之间）新增 `⏻` 按钮（accessibilityLabel「重启主机」）；
- 点击 → 二次确认（说明会短暂断开、恢复后自动重载）→ `POST /__dsh_remote/restart`；
- 202 → 状态显示「重启中」（spinner + 按钮禁用）→ 轮询 `/__dsh_remote/status`（1.5s × 最多 30s）
  → 200 自动 `reload()`；超时提示「主机重启超时，请稍后点刷新」；
- 401/403（证书失效）、405（主机插件过旧）、501（不支持/被禁用）、网络/原生模块错误都有可读提示；
- 等待期间返回主页/切主机：轮询可取消，不会对已销毁的 WebView 调 reload。

### 2.6 验证

- Host：`npm test` **153/153**（新增 25 项：plan（mac/win/node/unsupported）、shell quoting、
  fake-spawn 调度、禁用开关、去重、真实 mTLS 端点 202/405/403）；`validate:artifacts` 通过；
  另做了两次**只针对自建 dummy 进程**的真实脚本实测（kill dummy + 重新拉起；父进程被 SIGTERM
  后 detached helper 仍存活并完成 relaunch）——**没有真的重启本机 DSH**。
- App：`tsc --noEmit` / `check:native` / `check:shell`（57/57）通过。
- 真机：App **0.1.11 (build 13)** iOS Release 构建成功，用设备描述文件经 `xcrun devicectl`
  安装并启动到已配对 **iPhone 17 Pro Max / iOS 27.0**（`devicectl device info apps` 核对
  版本 0.1.11 / bundle 13；`main.jsbundle` 内确认含新文案与 `__dsh_remote/restart`）。
  手动交互项（⏻ 按钮、隐藏效果）由用户在手机上验收——本环境无 UI 自动化能力。

## 3. 未覆盖 / 后续

- **真机交互验收**：本环境只能安装/启动/截图，无法自动点按；按钮行为与控件隐藏需在手机上
  人工确认（清单见 `dsh-remoteApp/docs/ACCEPTANCE.md` #32/#33）。
- **Windows 重启路径** best-effort，无 Windows 本机可验证；失败时用户仍需手动打开 DSH。
- **Linux Electron** 返回 501。
- 若未来 DSH 给 `open-in-app` 换 data-* 属性/类名，隐藏规则会失效（不会报错，只是控件重新出现）；
  `check:shell` fixture 是回归哨兵。
- 首次升级必须手动重启一次 DSH 加载 host-plugin ≥0.1.10。

## 4. 相关

- 实现：`dsh-remoteService/packages/host-plugin/lib/host-restart.js`、`lib/server.js`、
  `lib/service.js`、`packages/protocol/index.js`；`dsh-remoteApp/src/lib/mobileWebShell.ts`、
  `src/lib/protocol.ts`、`src/screens/WebViewScreen.tsx`
- 契约：[`dsh-remoteService/docs/ADMIN-API.md`](../../dsh-remoteService/docs/ADMIN-API.md) §2
- 安全姿态：根目录 `AGENTS.md` 五（设备身份/mTLS/盲中继不变）
