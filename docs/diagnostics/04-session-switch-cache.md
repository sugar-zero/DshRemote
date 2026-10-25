# 04 — 会话切换重同步 / 主机重连重载：客户端本地缓存与差异更新

> 症状：手机 App 里每次切换会话都要重新「同步会话」（大会话要等数秒，像重新加载）；
> 以及此前反馈过的主机重启后 App 需要重新加载（黑屏）的问题。

## 1. 根因（DSH Web Client 的 retention 模型）

DSH Web 用**引用计数式的客户端会话保留（retention）**管理 Session 实例：

- 主视图（`dsh-client-ui-workspace`）只对**当前会话**持有 `source="mainView"` 的 retain
  （`dsh-client-ui-workspace/lib/client.js:1654`），切换会话时立即 `release()` 旧会话；
- 该会话的 retain 计数归零 → `SessionManager.drop()` → 销毁 Session 实例，连同已加载的
  历史记录和 `session/follow` 事件流一起丢弃
  （`dsh-api-session-controller/lib/client.js`：`retireScope` → `manager.drop` → `Session.dispose`）；
- 再切回来时新建实例 → `Session.open()` → 重新下载 `session/follow` 的**opening 快照**
  （最近 ≥50 条消息 / 2 个 Turn，上限 500 条记录）。本机上这是毫秒级，用户无感；
  但经 relay 的远程/手机链路时，一个大会话快照实测 **3.5–4.5MB**，于是每次切换都
  “重新同步”。

连接层面：mux 断线重连后，仍然打开的 event stream 会按协议重发一次 tail 快照
（`dsh-api-gateway/client.browser.js` 的 `RemoteJournalStream`，`replaceGeneration(resumed)`）；
`session/follow` 协议本身**没有 cursor 续传参数**，因此重连至少要重拉当前会话的 tail
快照——这是 DSH 核心行为，不 fork DSH 无法改成纯增量。页面若被整页重载（WebContent
进程被系统回收等），JS 内存里的所有缓存都会丢失。

## 2. 修复（客户端半，随 `dsh-remote-service` 插件分发）

在 `dsh-remoteService/packages/host-plugin/client.js` 增加「会话热缓存」：

- 只在手机远程 WebView（URL 带 `?dsh_mobile=1`，由 host 反代注入）下启用，桌面本机不受影响；
- 以额外 retain（`source="dsh-remote-cache"`）钉住**最近用户打开过的 3 个会话**
  （可通过 `globalThis.__DSH_REMOTE_SESSION_CACHE__ = { max }` 临时调整）；
- 切走不销毁：历史与 event stream 留在内存，切回时 `Session.open()` 已是 open 状态，
  **0 网络请求、瞬间渲染**；event stream 继续收 live 事件，所以缓存内容是最新的；
- 超过 3 个按 LRU 释放我们这份 retain（只撤缓存，不误伤当前会话）；
- 连接状态非 `connected` 时主动释放**非当前查看**的缓存，避免弱网/主机重启重连时
  把 3 份 tail 快照一起放大；恢复后随用户切换重新填充；
- 会话从列表消失（删除/归档）时释放对应缓存；
- 任何服务缺失/异常都静默降级，不影响 DSH 主 UI。

## 3. 效果 / 边界

| 场景 | 修复前 | 修复后 |
|---|---|---|
| A→B→A 切换 | A 第二次再拉整段快照（大会话数秒） | A 从内存恢复（0 快照请求） |
| 连续开关 4+ 个会话 | 每次都重新同步 | 最近 3 个复用；最旧的重新同步（有上限，控制内存） |
| mux 短暂断线 | 当前会话重拉 tail 快照 | 当前会话重拉 tail 快照（协议决定），其余缓存不参与放大 |
| 主机重启 | 页面保持时：当前会话重拉 tail 快照；页面被回收时整页重载 | 同上；缓存让重启后切回旧会话仍能命中（若页面未重载） |
| App 切首页/设备页再回来 | WebView 常驻，不重载（前一轮修复） | 不变 |

仍存在的限制（非本仓库能改）：`session/follow` 协议无断点续传，主机重启/整页重载后
当前会话仍需重拉一次 tail 快照；单次「首次打开某个大会话」仍受 relay 带宽限制
（4MB / 5Mbps ≈ 7s）。

## 4. 实现与测试

- 实现：`packages/host-plugin/client.js`
  - `installSessionWarmCache(scope, options)`：retain/LRU/断线清理/列表清理；
  - `installRemoteSessionCache(ctx)`：`ctx.inject(['sessions', 'connection'])`，仅
    `?dsh_mobile=1` 时安装；
  - `__test.installSessionWarmCache` 暴露给 smoke 测试。
- 单元测试：`packages/host-plugin/test/client-smoke.test.js`
  - LRU 保留与淘汰、切回命中不重复 retain、断线时只保留当前会话、会话从列表消失时释放、
    插件卸载清理；以及「只在 `?dsh_mobile=1` 安装」。
- 全量：`cd dsh-remoteService && npm test` 通过（与并行 APNs 改动合并后的工作区为 86/86）。

## 5. 端到端验证（headless Chrome + 真实 DSH Web UI）

验证方式：headless Chrome 经 CDP 载入本机 DSH Web（同一份 SPA），注入浏览器 cookie，
点击真实侧栏会话行，统计 WebSocket `session/follow` 的 opening 快照帧（≥200KB 的
`Network.webSocketFrameReceived`）与 console 异常。对照 = **同一份构建不带
`?dsh_mobile=1`**（此时缓存按设计不启用）。

| 场景 | 大快照帧 | follow-open | 切回 A 渲染 | console 异常 |
|---|---|---|---|---|
| 对照（无 `?dsh_mobile=1`）A→B→A | **3**（A 5.49M / B 7.12M / A 5.49M） | 3 | 265 ms | 0 |
| 缓存（`?dsh_mobile=1`）A→B→A | **2**（A 5.49M / B 7.12M；A 第二次 0 帧） | 2 | **86 / 81 ms** | **0** |
| 缓存 LRU 对照 A→B→C→D→A | **5**（A 被淘汰后第 5 次访问重新拉 5.49M） | 5 | 276 ms | 0 |

- 缓存命中时没有新快照、没有重连、没有重新订阅；单次页面加载只有 1 条 mux socket、
  访问期间 0 次关闭。
- 顺手修掉了一个实现期 bug：`sessions.retain()` 会**同步**发布 retention 变化，
  最初的实现会在订阅回调里重入 `pin()` 造成 `RangeError: Maximum call stack size
  exceeded`（会话打不开、界面卡在「载入历史…」）。已改为「先占位再 retain」+ 重入
  守卫 + 只淘汰非当前会话，并加了回归测试。
- 验证工具在本次诊断的 `/tmp` 下（headless Chrome harness），未随仓库提交；
  如需固化为可复用脚本可后续放进 `poc/`。

## 6. 生效方式

- 这是 **Client 半**（浏览器 bundle），由 host 从插件包文件提供；**不需要重新构建 App**、
  不需要重新配对。
- 手机 App 里**重新打开页面**（杀掉 App 重开 / 顶部刷新）即可加载新 client.js；
  若 DSH 缓存了启动时的 bundle 图（`client-modules`），需要重启 DSH 桌面端一次。
- 主机侧代理逻辑无改动；版本号随工作区当前发布号（并行开发时以实际为准）。
