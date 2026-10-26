# 09 — 手机端会话历史分片拉取：首屏小窗口 + 按需翻页

> 对应 `todo/TODO.md` 的 **T1**（App 会话历史改为分片拉取）。实现于 host-plugin **0.1.8**。
>
> 症状：手机 App（远程 WebView，`?dsh_mobile=1`）打开一个大会话要等数秒才看到内容；
> 弱网下表现为「载入历史很久/失败」。根因是 `session/follow` 打开快照本身太大，
> 而不是连接不稳定（心跳误杀已由 00/01 的修复解决）。

## 1. 为什么首帧会数 MB

DSH Web 客户端打开会话时，历史窗口是**客户端模块里的硬编码常量**：

- `HISTORY_PAGE_OPTIONS = { maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }`
  （`@deepseek-ai/dsh-api-session-controller/lib/client.js`，`Session.doOpen()` → `events.open(HISTORY_PAGE_OPTIONS)`）；
- Host 的 `paginate()` 从日志尾部往前走，返回 `cut..cursor` 之间的**全部事件**
  （不止消息，含 `request/header`、tool call/result、step 事件），再包成一帧
  `{ type: 'snapshot', records, hasMore, projections, assistantStream }`；
- 本机大会话里每条消息平均伴随约 60KB 的 `request/header` 等事件，因此
  「最近 50 条消息 + 2 个 Turn」的窗口常常就是数 MB。

本机用真实会话日志（解包后的 `session.v4.jsonl`）按 Host `paginate()` 规则离线复算：
**最大的 30 个会话**（解压后 5.9–95MB）打开快照 p50 ≈ **7.5MB**、p90 ≈ 10.9MB、max ≈ 22.9MB。

## 2. 为什么不在代理侧改帧（回顾 01 §3.3）

- 代理重写 `session/follow` 的 `open` 帧 = 协议 MITM：要按 endpoint/JSON 结构解析并替换
  `payload.args.request`，DSH 内部协议一变就会破坏整条 mux；
- 客户端 `RemoteJournalStream.replaceFromOpening()` 强制 `assertPageThrough`：快照末尾必须
  等于该 generation 的 cursor，代理既不能删尾部事件，也不能只改一半；
- 结论不变：**不存在安全的代理侧缩小方案**。能安全改的只有「客户端自己发出去的请求参数」。

## 3. 切入点：客户端的对象级钩子

DSH 的 `SessionEventStream`（session 控制器 Client 半导出）把请求窗口直接放在 RPC 参数里：

- `follow(request)` → `remote.session.follow({ address, assistantStream: true, ...this.repairRequest(request) })`
  —— 首屏快照 + 重连 tail 都走这里；
- `readPage(request, throughSeq)` → `remote.session.page({ address, throughSeq, ...request })`
  —— `loadOlder()`（「加载更早」）与 `loadThrough()`（跳转）都走这里；
- `repairRequest()` 原样透传 `maxMessages` / `turnWindow`，Host 端对这两个字段有明确校验
  （`maxMessages` 正整数；`minMessages ≤ maxMessages`；`minTurns ≥ 1`），README 也写明
  「`turnWindow` 是 page/follow 请求上可选的最小值参数」——所以**客户端改自己是合法的**，
  不算协议 MITM，也不会触发 `assertPageThrough`（快照末尾仍等于 cursor，只是更早 cut）。

插件的 Client 半在手机 WebView 下从浏览器模块表 `require('@deepseek-ai/dsh-api-session-controller')`，
包装 `SessionEventStream.prototype.repairRequest` 与 `.readPage`：只替换窗口参数，
`address` / `beforeSeq` / `throughSeq` / `signal` / 返回值全部原样透传。

## 4. 实现（host-plugin 0.1.8）

- 仅 `?dsh_mobile=1`（手机 App 的 WebView URL）下安装；桌面本机完全不装。
- 默认窗口（`MOBILE_HISTORY_DEFAULTS`）：

  | 场景 | maxMessages | turnWindow.minMessages | turnWindow.minTurns |
  |---|---|---|---|
  | 首屏 / 重连 tail（`follow`） | **6** | 3 | 1 |
  | 向上翻页 / 跳转（`page`） | **10** | 5 | 1 |

  只收紧不放大：请求方本来更小就保留请求值；请求没有 `turnWindow`（Host 的
  message-aligned 模式）时不凭空添加。
- 覆盖 / 关闭（调试用，改完刷新页面）：

  ```js
  globalThis.__DSH_REMOTE_MOBILE_HISTORY__ = {
    open: { maxMessages: 6, minMessages: 3, minTurns: 1 },
    page: { maxMessages: 10, minMessages: 5, minTurns: 1 },
    enabled: false, // true/省略 = 启用；false = 恢复 DSH 默认窗口
  };
  ```

- 诊断：
  - `globalThis.__DSH_REMOTE_MOBILE_HISTORY_ACTIVE__` = 实际生效窗口；
  - `globalThis.__DSH_REMOTE_MOBILE_HISTORY_STATS__ = true` 后，
    `__DSH_REMOTE_MOBILE_HISTORY_LOG__` 记录最近 100 次分页请求（窗口/`beforeSeq`）与
    翻页响应（记录数 / `hasMore` / 耗时）。
- 降级：模块不在浏览器模块表、DSH 改了类/方法名、`enabled:false` 都只是**不安装**
  （`console.warn` 一条），DSH 主 UI 行为不变；重复 apply/HMR 复用同一份包装，卸载时恢复原方法。

## 5. 验证

### 5.1 测试

- `dsh-remoteService`：`npm test` **128/128**（新增 `client-smoke` 4 项：窗口压缩与参数透传、
  重复安装幂等 + 卸载恢复、桌面不装 + 模块缺失/`enabled:false` 静默降级、配置解析兜底）。
- `npm run validate:artifacts` 通过。

### 5.2 打到真实 DSH 类上

把补丁安装到**从已安装 DSH 解包出来的真实 `dsh-api-session-controller` Client 模块**
（`SessionEventStream` 的真实实现）上做离线验证：

- `repairRequest({ maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } })`
  → `{ maxMessages: 6, turnWindow: { minMessages: 3, minTurns: 1 } }`；
- 真实 `readPage()` 实际发出的请求（含 `address`/`throughSeq`）
  → `{ address, throughSeq, beforeSeq, maxMessages: 10, turnWindow: { minMessages: 5, minTurns: 1 } }`，
  返回值原样透传；
- 卸载后 prototype 恢复为原函数。

### 5.3 真实会话日志的字节收益（离线复算）

方法：解压本机会话日志，按 Host `paginate()` 的同一规则计算首帧 / 翻页 `records` 的
JSON 字节数（与线上帧的 `records` 部分同口径，不含 projections）。

| 样本 | 原窗口首帧 | 新首屏（6/3/1） |
|---|---|---|
| 30 个大会话（5.9–95MB 日志） | p50 7.5MB / p90 10.9MB / max 22.9MB | **p50 362KB / p90 436KB / max 559KB** |
| 同上（若把首屏调到 5 条：`open.maxMessages=5`） | — | p50 301KB / p90 367KB / max 509KB |
| 20 个随机小会话 | p50 58KB / max 355KB | p50 49KB / max 201KB（历史不足 6 条时行为不变） |

翻页（`loadOlder` 一页）：

| 窗口 | 单页最大 p50 | 单页最大 p90 | 单页最大 max | 单页中位 p50 |
|---|---|---|---|---|
| 原 500/50/2 | 7.1MB | 11.5MB | 22.4MB | 3.7MB |
| 新 10/5/1 | **953KB** | 1.27MB | 1.72MB | **540KB** |

按 300KB/s 的弱网估算：首屏 p50 由 ≈25s 降到 ≈1.2s（600KB/s 下 ≈0.6s）；翻一页 ≈1.8s。

## 6. 风险 / 未覆盖

- **单条消息 / 单个 Turn 本身可能很大**（工具结果、request header）：分片只能减少「一次拉
  多少条消息」，不能把一条消息拆开；极大会话仍可能遇到单帧 >1MB（首屏 6 条时本机最大
  559KB，但极端工具输出比本机样本更大时会更慢）。
- 首屏 6 条消息 ≈ 手机一屏；历史更多的会话需要点「加载更早」（DSH 目前是按钮，不是滚动自动
  加载；UI 侧改造不在本次范围）。翻页 `10/5/1` 是「速度 vs 点击次数」的折中，可用
  `__DSH_REMOTE_MOBILE_HISTORY__` 按网络情况调：网更差时把 `open.maxMessages` 调到 5
  （本机大会话 p50 301KB）或 4，网好时调到 8–10 减少点击。
- 跳转（`loadThrough`）也会被压成小页：远端跳转要发更多轮请求，但单帧小、弱网更稳。
- 依赖 DSH `SessionEventStream.repairRequest/readPage` 的内部方法名（与 0.2.1-rc.3 对齐）；
  DSH 升级改名时本功能自动降级（不影响其它功能），需要按新结构更新。
- 大帧的心跳误杀已由 00/01 的 WS Pong 桥修复；本改动是「打开延迟」优化，不替代那层修复。

## 7. 手工验收步骤（手机）

1. 主机更新到 host-plugin ≥ 0.1.8 并重启 DSH；App 内刷新/重开 WebView（无需重装 App）。
2. 手机连 Safari Web Inspector（或 DSH 日志）确认 `[dsh-remote] mobile session history window:`
   一行出现，且 `__DSH_REMOTE_MOBILE_HISTORY_ACTIVE__` 为 `{open:{6,3,1},page:{10,5,1}}`。
3. 打开 3.9MB 级大会话：应「先快速看到最近几条」，顶部出现「加载更早」；点一次只补一页。
4. 向上翻多页：无跳屏/重复/顺序错乱；滚到顶不出现「加载失败」。
5. 切会话、整页重载、断线重连：流量不放大（与 04 的会话热缓存互补）。
6. 桌面本机（非 `?dsh_mobile=1`）行为与之前完全一致。
7. 可临时 `__DSH_REMOTE_MOBILE_HISTORY__ = { enabled: false }` 做 A/B 对照（刷新页面生效）。

## 8. 相关

- `dsh-remoteService/packages/host-plugin/client.js`（`installMobileHistory*`、`__test`）
- `dsh-remoteService/packages/host-plugin/test/client-smoke.test.js`（4 项新测试）
- `docs/diagnostics/00-root-cause.md`（3.9MB 单帧实测）、`01-dsh-heartbeat.md` §3（协议约束）、
  `04-session-switch-cache.md`（切会话热缓存）
- `todo/TODO.md` T1（本项）；T1.1「服务器会话存储」按用户指示**不在本次范围**。
