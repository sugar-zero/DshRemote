# 01 — DSH mux 心跳 / 大会话快照分析：terminate 条件、重连节奏、UI 跳动与可选修复

> 分析对象：DeepSeek Harness Desktop `0.2.1-rc.3`（运行中实例 profile = `~/.dsh/profiles/desktop`，web 服务 `http://127.0.0.1:63134`，
> host 插件远程 TLS 监听 `127.0.0.1:63135`）。
> DSH 源码证据来自 `app.asar` 解包目录 `/tmp/dsh-asar/`（`dsh-api-gateway`、`dsh-client-connection`、`dsh-api-session-controller`、
> `dsh-client-ui-*` 等）；补充包（`dsh-base` 的 `cordis.patch.yml`、`dsh-app-boot`、`dsh-hmr`、`ws`、`dsh-timeout`）按
> `asar` 头部信息从 `app.asar` 直接解出（header 偏移 16、payload 基址 4748716）。
> 本文所有结论均给 `file:line` 或命令输出证据；不含任何产品代码改动。

## 0. 结论摘要（TL;DR）

1. **根因确认**：`/api/remote.mux` 的服务端心跳是「每 2s Ping，连续 2 个周期没有任何活动就 `terminate`」。
   `session/follow` 首帧是数 MB 的历史快照（本会话实测 ≈3.88MB），在 ~600KB/s 的 relay 链路上要 6s+；
   Ping/Pong 被排在该 payload 之后，DSH 在最后一次活动后的**第 3 个心跳 tick（4–6s）** 就杀掉 mux，客户端随即重连、
   重发 3.9MB、再被杀 —— 死循环。（详见 §1、§2）
2. **DSH 侧「buffered write completed 视为存活」的自救路径救不了这种慢下行**：它最多把死亡推迟一到两个心跳窗口，
   payload（6.4s+）仍长于存活的延长期；且当前代理对上游有背压，这个回调本身就被慢链路节奏拖到死亡边缘。（§1.3，含实验数据）
3. **`session/follow` 首帧大小无法在代理侧"安全地"缩小**：窗口参数由浏览器端 JS 决定（`HISTORY_PAGE_OPTIONS`），
   代理改写请求帧属于协议 MITM、且客户端强制「页面末尾必须等于 cursor」，只能截断更旧的消息、却改变 UI 分页语义；
   也覆盖不了其它大帧。**确认：NO safe proxy-side shrink。**（§3）
4. **配置 patch 可行**：TypertGatewayService 的 `websocketHeartbeatIntervalMs` 支持 profile patch 覆盖，
   行 id 为 `typert-gateway`（`@deepseek-ai/dsh-base/cordis.patch.yml:52-53`）。精确片段与风险见 §4；
   DSH 有 HMR 监听 `~/.dsh/profiles/desktop/cordis.patch.yml` 与 `~/.dsh/cordis.patch.yml`，改配置预计可热生效（未实测，见 §4.5）。
5. **代理侧假 Pong 修复在 DSH 侧是安全的**（unsolicited Pong 不会触发任何校验/关闭），但**「只在看到 Ping 时才回 Pong」来不及**
   （我们的独立实验：Ping 首次可读 6976ms，terminate 6006ms）；必须依赖**拥塞期间的定时主动 Pong**（或等价机制）。
   方向/掩码：代理在 DSH 眼里是 client，Pong 必须 masked、opcode `0xA`、FIN、payload ≤125B（可回显）。（§5）
6. **推荐排序**：(a) host-plugin 代理主动 Pong（已实现，主修复）＞ (b) DSH profile patch 心跳 30s（配置层兜底，可 HMR）
   ＞ (c) permessage-deflate 压缩（DSH 未启用、配置不可达，需改打包 JS，不推荐）＞ (d) app 侧注入心跳帧 / relay 扩容等（§6）

---

## 1. DSH mux 心跳与 terminate 的精确条件

### 1.1 代码事实（`/tmp/dsh-asar/dsh-api-gateway/lib/index.js`）

- `REMOTE_STREAM_MUX_PATH = "/api/remote.mux"` — `index.js:133`
- `MAX_MISSED_HEARTBEATS = 2` — `index.js:293`
- 默认心跳间隔 `DEFAULT_WEBSOCKET_HEARTBEAT_INTERVAL_MS = 2e3` — `index.js:701`
- 配置 schema：`websocketHeartbeatIntervalMs`（1..`MAX_TIMER_DELAY_MS`，默认 2000）、`streamInboxBytes`（默认 262144）— `index.js:746-749`
- mux 服务器构造：`new RemoteStreamMuxServer(..., resolved.websocketHeartbeatIntervalMs, resolved.streamInboxBytes)` — `index.js:777`；
  `new WebSocketServer({ noServer: true })` — `index.js:300`
- upgrade 路由注册 — `index.js:785`；心跳 timer 在**第一次 upgrade 时**创建、进程级共用一个 `setInterval`（`unref()`）— `index.js:333, 361-379`
- 每个新 socket：`alive()` 把 `missedHeartbeats` 归零 — `index.js:329-332`

心跳 tick（`startHeartbeat`，`index.js:362-379`）：

```js
this.heartbeatTimer = setInterval(() => {
  for (const socket of this.server.clients) {
    if (socket.readyState !== WebSocket.OPEN) continue;
    const missed = this.missedHeartbeats.get(socket);
    if (missed >= MAX_MISSED_HEARTBEATS) {
      setImmediate(() => {                       // 再确认一次（期间收到 pong 就放过）
        if (this.missedHeartbeats.get(socket) >= MAX_MISSED_HEARTBEATS) socket.terminate();
      });
      continue;
    }
    this.missedHeartbeats.set(socket, missed + 1);
    socket.ping();
  }
}, this.heartbeatIntervalMs);
```

重置 `missed` 的「活动」来源（`RemoteStreamMuxConnection.run()/send()`）：

| 事件 | 代码 | 说明 |
|---|---|---|
| 收到 Pong | `index.js:409` `this.socket.on("pong", this.alive)` | 浏览器 WS 会自动回 Pong（RFC 6455） |
| 收到任意 `message` | `index.js:410-411` | 先 `alive()` 再校验；非法帧随后 close(1008) |
| 「有排队」的 downlink 写完成 | `index.js:529-554`，关键 `541-550`：`socket.send(text, cb)` 后 `queued = socket.bufferedAmount > 0`；cb 里 `if (queued) this.alive()` | 注释（`index.js:396-402`）明确：*立即完成*的写不算存活，排过队的写完成才算 |

**精确的 terminate 时刻**：设最后一次活动事件在 `T`（upgrade 的 `alive()`、任何 message、任何 pong、任何「排过队的写」完成），
全局心跳 tick 每 2s 一次（相位由首条 mux 连接决定）。从 `T` 起算：
第 1 个 tick `missed=1` → 第 2 个 tick `missed=2` → 第 3 个 tick 命中 `missed>=2` 并 `terminate`。
所以 **terminate 发生在最后一次活动后的第 3 个 tick，即 T + (4s, 6s]（取决于相位）**。
本机手机设备的实测重连间隔与之一致（§2.2）。

### 1.2 为什么 Ping 会排在 4MB payload 之后

DSH 发出 4MB 帧时，`socket.send(text)` 依次经过：

1. `ws@8.22.0`（asar 内 `dsh/node_modules/ws/package.json` = 8.22.0）的 `Sender.send()` 把帧直接 `socket.write` 进 Node socket 流
   （`sender.js:351-...`，非压缩路径 `dispatch → sendFrame`，`sender.js:503-...`、`563-...`）；
2. 大帧把 Node 用户态/内核写缓冲塞满（`bufferedAmount` 持续为正，getter 见 `websocket.js:133-137`）；
3. 2s 后的 `socket.ping()` 走 `Sender.ping()`（`sender.js:239-280`）：`_state === DEFAULT` 时同样**直接 `sendFrame` → 同一个
   socket 字节流**（`sender.js:276-280`），于是 Ping 帧字节排在 4MB payload 之后；
4. 代理对上游有背压（`proxy.js:276-281`：`clientSocket.write()` 返回 false → `upstream.pause()`）时，payload 尚未排空，
   Ping 字节根本到不了代理/手机；即使代理不背压、把 4MB 全速读进内存，Ping 也排在 payload 字节之后。

⇒ **占大头的下行数据与心跳共享同一条有序字节流**，这是本 bug 的物理根因。手机侧的 Pong 又要等 Ping 到达后才能生成，
所以 Pong 还要再晚一个「payload 尾部 + RTT」。

### 1.3 「buffered write completed 视为存活」能不能救慢下行？—— 不能

任务假设里写的是「本地写立即完成，所以 alive-path 不生效」。实测更精确：

- **若代理有背压（当前实现）**：4MB 写进本地 socket 的完成时刻被隧道速率拖后，`cb` 往往在 2–6s 才触发；
  它只是把死亡窗口往后推一次，payload 的传输时间（600KB/s 下 6.4s）仍大于延长量。
- **若代理不背压/内存缓冲（旧 connector 行为）**：`cb` 较早触发、确实会清零 `missed`，但清零只把 terminate 从
  「第 3 个 tick」重新计时一个周期，**4MB 的排空仍需 ~6.4s**，且 Ping/Pong 依然排在 payload 后。
- **实验**：仿 DSH 心跳逻辑 + 600KB/s 限速 TCP 中继（脚本 `/tmp/ping-order-test.mjs`，日志 `/tmp/ping-alive.log`）：
  3.88MB 单帧，`send` 回调 3788ms 时命中 alive-path、`missed` 清零；terminate 从 6007ms 推迟到 **8009ms**；
  但 Ping 帧首次可读是 **8034ms** —— 仍在心跳窗口边缘被杀。⇒ 该路径**不能**可靠挽救慢下行；
  它的设计目标（注释 `index.js:396-402`）是「拥塞把 Pong 挡在数据后面」的场景，但只缓一个窗口。

> 这解释了真机现象：审计日志里 mux 断连间隔最小 4.4s（心跳相位最坏情形，没等到 alive-path 或 alive 太晚）、
> 中位 5.7s（≈ 2 个心跳周期 + 重连退避），而不是无限的 6.4s 传输时间。

---

## 2. 客户端重连节奏与 UI「跳一下」

### 2.1 客户端重连链路（源码）

1. `ClientRemoteService` 创建 `RemoteStreamMuxClient`：`new RemoteStreamMuxClient((path) => connection.openWebSocket(path),
   connection.interactions === "answer")` — `/tmp/dsh-asar/dsh-api-gateway/lib/client.browser.js:1630-1632`。
   这里的 `waitForReconnect=true` 表示 socket 丢失后逻辑流会等 Connection 发起重连，而不是立刻失败（`lost()`，`client.browser.js:623-629`）。
2. `connection.start({ onConnected: () => ownerCtx.emit("connection/reset"), onReconnectRequested: () => this.streams.reconnect() })`
   — `client.browser.js:1638-1645`；即：**连接代际变化 → 发 `connection/reset`；退避重连请求 → 关闭旧 mux socket 并重开**。
3. 重连由 `ConnectionController` 驱动（`/tmp/dsh-asar/dsh-client-connection/lib/client.browser.js`）：
   - 默认参数：`backoffBaseMs=500, backoffFactor=2, backoffMaxMs=10000, generationReadyWarnMs=3000,
     generationReadyTimeoutMs=15000` — `client.browser.js:898-903`；
   - 退避公式：`cap = min(10000, 500 * 2^(attempt-1))`，实际延迟 `cap/2 + rand*(cap/2)` — `:1000-1007`；
   - 循环：`attempt++ → emitState("connecting") → sleep(backoffDelay) → sinks.onReconnectRequested()`
     （`onReconnectRequested` 就是 `streams.reconnect()`）— `:1034-1054`；
   - 新 generation 就绪：`attempt = 0`，`onConnected` 回调 — `:1094-1100`；
   - 就绪超时：`generationReadyTimeoutMs`（15s）硬超时结束该 generation（`waitForReady`，`:1126-1156`）。
4. mux 客户端 `reconnect()`：`revision++ → failAll → socket.close(4000, "reconnect requested") → maintain() → connect()`
   — `/tmp/dsh-asar/dsh-api-gateway/lib/client.browser.js:357-375`；`maintain()`/`connect()` — `:630-645`、`:521-577`。
5. 逻辑流（`session/follow` 等）由 `RemoteStream` 跨 carrier 代际重开：遇到 `RemoteStreamCarrierError` 时
   `waitForRemoteStreamRetry()` → 若当前没有 connection generation 就等下一个代际，否则第 1 次立即重试、第 2 次起视为终态
   — `client.browser.js:1110-1138`、`:998-1108`。

**重连节奏推导**：mux 被 DSH 心跳杀掉（最后一次活动后 4–6s）→ `$events` 逻辑流 carrier 失败 →
ConnectionController 走 `retry` 分支，第 1 次退避 250–500ms → `onReconnectRequested` → 新 mux socket → 等 `$events` 首帧就绪 →
`connection/reset` → 逻辑流（含 `session/follow`）重开。于是审计日志里相邻两次 `ws-upgrade` 的间隔 ≈
**kill 窗口（4–6s）+ 退避（0.25–0.5s）+ TLS/relay 握手与就绪（~0.1–1s）≈ 4.4–6.5s**；attempt>1 时退避可到 1–10s，
加上 generationReady 相关等待，出现 8–14s 的长间隔。

### 2.2 实测重连节奏（本机 `~/.dsh/remote-access/audit.jsonl`）

命令与统计（同一台 iPhone 设备 `<IPHONE_DEVICE_ID>` 的 `/api/remote.mux` 成功 upgrade）：

```
iphone mux upgrades: 129（2026-10-24T18:19:51Z ~ 20:16:04Z）
最近 40 个间隔(s): 4.7,5.7,5.8,5.0,9.1,5.9,6.0,8.0,11.7,5.1,5.7,5.2,9.9,5.4,11.3,5.8,4.7,5.1,5.5,5.7,
                    8.8,4.9,5.7,5.3,5.7,5.6,4.4,5.8,6.0,5.1,9.5,5.0,13.7,5.1,8.9,4.7,6.3,4.4,4.8,5.4
min 4.399 / p50 5.688 / p90 9.926 / max 13.734 (s)
```

与 §1.1 的心跳模型完全吻合：主体 4.4–6.3s = 心跳 phase 4–6s + 退避 0.25–0.5s；8–14s 为多次退避/generation 等待。

### 2.3 UI「跳一下」的来源（什么在监听 `connection/reset`）

- 每次新 generation 就绪都会 `ownerCtx.emit("connection/reset")` — `dsh-api-gateway/lib/client.browser.js:1640`。
- 监听者（解包 UI bundle 内）：
  - `/tmp/dsh-asar/dsh-client-ui-model-selection/lib/client.js:1002-1005`：
    `ctx.on("connection/reset", () => { this.catalog.resetGeneration(); for (...) directory.resetConnected(); })`
    → 模型目录 `invalidate(true)`（清空 value、status=idle）并重新 `load()`（`client.js:794-799`），
    模型选择器会闪一下/重取。
  - `/tmp/dsh-asar/dsh-client-ui-settings-models/lib/client.js:4472-4482`：`refreshModels()` → `refreshIfLoaded(controller)`
    （若 Models 设置页已加载则重取）。
  - `dsh-api-gateway` 自身的 `$events` 代际（`ClientRemoteEvents.pumpEvents`，`client.browser.js:821-...`）也随 mux 重开。
- **会话历史窗口被整段替换**：`session/follow` 逻辑流随新 generation 重开（`RemoteJournalStream` 的
  `open: (signal) => this.follow(this.initialRequest, signal)` — `dsh-api-gateway/lib/client.browser.js:1195`），
  重开的首帧又是 3.9MB 全量快照；`RemoteJournalStream.replaceFromOpening()` 发布 `{type:"replace"}` — `:1312-1327`；
  Session 控制器 `acceptEventChange → installWindow()` 用新页**替换整个连续窗口**（baseSeq/hasMore/eventSource 全换、
  `notifier.markDirty()`）— `/tmp/dsh-asar/dsh-api-session-controller/lib/client.js:2692-2729`。
  Chat 列表是虚拟滚动（`dsh-client-ui-chat/lib/client.js` 的 scroll 写回/锚定逻辑，`:1930-2060`、`:2387` 附近），
  整窗替换会触发重新测量与滚动重锚 → 用户看到「整页跳一下」。
- 组合效果：**每次 mux 断连都会 ①重发 3.9MB 快照 ②整窗 replace ③模型目录刷新**，4–6s 一次，直到离开该会话。

---

## 3. `session/follow` 首帧快照的形状/大小，以及能否在代理侧缩小

### 3.1 请求参数由浏览器端决定

- 打开会话时：`events.open(HISTORY_PAGE_OPTIONS)` — `/tmp/dsh-asar/dsh-api-session-controller/lib/client.js:2679`；
  `HISTORY_PAGE_OPTIONS = { maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }` — 同文件 `:2177-2183`；
  `JUMP_PAGE_OPTIONS`（跳转用）minMessages 200 — `:2184-2190`。
- `SessionEventStream.follow()` 把请求原样发给 Host：
  `this.remote.session.follow({ address, assistantStream: true, ...this.repairRequest(request) })` — `:431-435`；
  `repairRequest()` 会透传 `maxMessages`/`turnWindow` — `:481-486`。
- 后续翻旧历史：`loadOlder()` → `events.prepend({ beforeSeq: baseSeq, ...HISTORY_PAGE_OPTIONS })` — `:2492-2502`；
  跳转 → `loadThrough()` 循环用 `JUMP_PAGE_OPTIONS`（`:2504-2560`）。即 UI 用 `session/page` 分页补旧历史。

### 3.2 Host 侧快照的取页规则

`/tmp/dsh-asar/dsh-api-session-controller/lib/index.js`：

- `DEFAULT_MAX_MESSAGES = 50` — `:1438`；
- `follow()`：取 `source.events` 当前游标 `cursor`，`paginate(events, void 0, request.maxMessages ?? 50, cursor, request.turnWindow)`，
  然后**一帧** yield 出 `{ type: "snapshot", header, cursor, records: pageRecords(page.events), hasMore, projections, assistantStream }`
  — `:1510-1585`（关键 `1571-1585`）；
- `paginate()`：从尾部往前走，只统计 `user/message`、`assistant/message` 等 append-surface 消息；
  命中 `turnWindow`（count≥minMessages 且 turns≥minTurns 时在 `turn/start` 处切）或 `count >= maxMessages` 即停，
  返回 `events.slice(cut, end)` —— **包含 cut..cursor 之间的所有事件**（不仅是消息，含工具/步骤事件）— `:1717-1747`；
- 参数校验：`maxMessages` 必须是正整数；`turnWindow.minMessages` 必须 ≤ maxMessages — `:1680-1687`。

所以首帧大小 ≈「最近 ≥50 条消息且 ≥2 个 turn（最多 500 条消息）所覆盖的所有事件」+ 全部 projection + assistant stream 基线；
本会话实测单帧 3,882,729B（见 `docs/diagnostics/00-root-cause.md` §2.3 与任务上下文）。

### 3.3 代理侧能缩吗？—— 确认 NO（没有安全的做法）

1. **协议约束**：客户端 `RemoteJournalStream.replaceFromOpening()` 要求快照页的**末尾 cursor == 该 generation 的 cursor**，
   否则抛 `protocolViolation`（`assertPageThrough`，`dsh-api-gateway/lib/client.browser.js:1526-1531`、调用点 `:1314, 1351, 1358`）。
   代理不能删尾部事件，只能通过 `maxMessages/turnWindow` 让 Host 从更旧的 cut 开始切 —— 而这两个参数是**客户端请求帧**里的内容。
2. **改请求帧 = 协议 MITM**：`session/follow` 的 `open` 帧是 client→server JSON，代理需要在两条方向、按 endpoint 解析并重写
   `payload.args.request`；DSH 的 endpoint/payload 形态是内部协议（随版本变化），代理一旦解析失败会破坏整条 mux
   （Gateway 对非法帧直接 `close(1008)`，`index.js:410-421`）。
3. **语义代价**：即便把 maxMessages 改小，客户端会得到 `hasMore=true` 的窗口，后续要靠用户滚动触发 `session/page` 才能补齐；
   打开会话的「立即看到最近几十条」体验尚可，但**并没有解决其它大帧**（`session/page` 单页可达 500 条/数 MB、
   单条 assistant 消息本身就可能数 MB、`$events` 控制基线等），同一个慢链路仍会在别的帧上触发 6s 心跳误杀。
4. **不能截断/丢弃**：mux 文本帧的 `item` 是 JSON 文本，截断即非法 JSON，客户端 direct `parseMessage` 抛错 →
   `lost()/close(4002)`（`client.browser.js:607-621`）。

⇒ **结论：不存在「安全且治本」的代理侧缩小首帧方案**；正确的切入点只有心跳/保活（§5）或 DSH 配置（§4）。

---

## 4. 用 DSH 配置 patch 覆盖 `websocketHeartbeatIntervalMs`（可行性、精确片段、风险）

### 4.1 配置项与边界

- 配置 schema（`z.object`）：`websocketHeartbeatIntervalMs`（step 1，min 1，max `MAX_TIMER_DELAY_MS`，默认 2000）、
  `streamInboxBytes`（min 1，默认 262144）— `/tmp/dsh-asar/dsh-api-gateway/lib/index.js:746-749`；
  `MAX_TIMER_DELAY_MS = 2147483647` — `/tmp/asar-out/timeout-index.js:27`（`@deepseek-ai/dsh-timeout`）。
- 配置在插件构造时读取并创建 mux 服务器（`index.js:777`）→ **改配置需要该行插件重启**（可通过 HMR 触发，见 §4.4）。

### 4.2 行 id 与 patch 语义（关键证据）

- 基础 bundle patch 里的行声明：`- id: typert-gateway` / `name: '@deepseek-ai/dsh-api-gateway'`
  — `@deepseek-ai/dsh-base/cordis.patch.yml:52-53`（该 bundle 的版本 = `0.2.1-rc.3`；`dsh.bundle.patch = ./cordis.patch.yml`，
  见其 `package.json`）。**该行没有 config**，所以当前生效值就是 schema 默认：2000ms / 262144B。
  （已用 grep 确认：全部 21 个 bundle 的 `cordis.patch.yml` 中只有 dsh-base 提到 `typert-gateway`，无任何 config 覆盖。）
- patch 语义（`@deepseek-ai/dsh-app-boot`）：按 id 命中已有行；非 insert patch **整个替换 `config`，不做深合并**；
  `name` 只用于"断言现有行名"，不匹配则 warn+skip；未知 id → warn+skip。
  证据：`/tmp/asar-out/app-boot.js:61-110`（`applyEntryPatches`，`target[key] = value` 于 `:104-107`，
  name 断言 `:100-103`）；同一语义的 schema 文案在 `:3039-3046`：
  > "Other patches replace supplied fields; config is replaced wholesale, not deep-merged. A truthy name asserts the existing plugin name rather than renaming it. Unknown targets and non-insert patches without a nonempty id are warned and skipped."

### 4.3 patch 层序与生效路径（桌面端确实会读用户 patch 层）

- patch 应用顺序（`readProfilePatches`，`/tmp/asar-out/app-boot.js:1127-1137`）：
  **bundle patches（按 `dsh.profile.bundles` 顺序）→ profile 的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → CLI `--patch` overlays**；
  `profile-boot.js:224-229` 的注释同义（home 层"outranks the per-profile layer"）。
- 运行中的桌面实例：`ps` 显示主进程
  `/Applications/DeepSeek Harness.app/.../dsh-desktop-host/lib/index.js ... <app.asar>/dsh <DSH_HOME>/profiles/desktop ...`；
  `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 含 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`dsh-remote-service` 等；
  `dsh-desktop-host/lib/index.js:224-236` 用 `loadProfileDirectory("dsh", projectDir, installAnchor)`（默认 `userLayer=true`，读用户 patch）
  并把 `resolvedProfile` 交给 `runProfile` → `profile-boot.js:236-247, 272, 302` 组装 patch 栈。
- 因此改 `~/.dsh/profiles/desktop/cordis.patch.yml` 会被下一次启动读取；同时 **HMR 会监听并热重组**：
  `dsh-hmr` 在 profile 存在时监听 `profile.patchPath` 与 `$DSH_HOME/cordis.patch.yml`，变化后 `reconcileProfile()`
  重新 `readProfilePatches` 并 `recomposeProfile`（对 Loader 树做 diff，重启受影响的插件行）—
  `/tmp/asar-out/dsh-hmr.js:850-870`、`:1320-1368`；`recompose` 通过 `entry.update({config:{...,patches}})` 应用 —
  `/tmp/asar-out/app-boot.js:3838-3855`。基础 bundle 的 `hmr` 行在 desktop profile 是启用的
  （`disabled: !!js "!ctx.get('profileContext')"`，`dsh-base/cordis.patch.yml:28-32`），注释明说
  "Profile configuration reloads by default; module roots are opt-in"。
  → **预计改 patch 文件可热生效（会重启 `typert-gateway` 插件 → 现有 mux 连接断一次、Web UI 自动重连），无需重启整个 App；此点未实测**。

### 4.4 精确 patch 片段（推荐值：30000ms）

追加到 `~/.dsh/profiles/desktop/cordis.patch.yml`（保留原文件内容，这个文件是 YAML 顶层数组）：

```yaml
# 缓解慢链路大会话快照触发 mux 心跳误杀：2s/2missed → 30s/2missed
# 语义提醒：patch 会【整体替换】该行 config，所以要把该行原有的两个 key 都写全。
- id: typert-gateway
  name: '@deepseek-ai/dsh-api-gateway'   # 可选；仅断言行名，写错会 warn+skip
  config:
    websocketHeartbeatIntervalMs: 30000
    streamInboxBytes: 262144              # 与当前默认值一致，保持不回归
```

也可写到机器级 `~/.dsh/cordis.patch.yml`（对**所有** profile 生效，优先级高于 per-profile 层；当前该文件不存在）。

应用/回滚：

```bash
cp ~/.dsh/profiles/desktop/cordis.patch.yml ~/.dsh/profiles/desktop/cordis.patch.yml.bak
# 追加上面 8 行；保存后等 1~2s，观察手机/浏览器 mux 是否掉线重连一次（HMR 重组的预期现象）
# 回滚：cp 回 .bak（同样会被 HMR 热重组）
```

### 4.5 生效模型与风险

- **效果**：心跳周期 30s、`MAX_MISSED_HEARTBEATS=2` → terminate 窗口变为「最后活动后第 3 个 tick」= **60–90s**；
  600KB/s 下 3.9MB 快照 6.4s、4.2MB 6.9s，均远小于 30s，因此不会再误杀；慢至 ~250KB/s（3.9MB ≈ 16s）也安全。
- **风险/代价**：
  1. 真正的死连接/半开连接回收变慢（最多 ~60–90s；但客户端侧浏览器有 `online/offline` 事件、
     TCP 层仍会在重传超时后报错，实际影响主要是"死连接占资源时间变长"）。
  2. **patch 是整体替换 config 语义**：必须同时重述 `streamInboxBytes`（否则回落到 schema 默认 262144 —— 与本例相同，
     但若以后 bundle 层改了该值会被覆盖）。若 DSH 升级把该行 config 增加新 key，本 patch 会把它们重置为默认。
  3. DSH 升级若改行 id/插件名：非 insert patch 对未知 id 只 **warn+skip**（`app-boot.js:95-103`），不会崩溃，但会静默失效；
     若 key 名被删/改，schema 校验可能在该插件启动时报错（影响 DSH 启动，需回滚 patch）。
  4. 只对 `desktop` profile 生效（本 bug 涉及的运行形态）；若以 `dsh web`/其它 profile 跑同一服务，需要写 home 级 patch 或对应 profile。
  5. 这是 DSH 内部的 loader 配置（非公开 API）；用官方支持的 profile patch 机制表达，但字段名属于内部实现。
- **客户端是否需要对称配置？不需要**：
  - 浏览器端 mux client 没有 ping/pong/heartbeat 逻辑（`dsh-api-gateway/lib/client.browser.js` 全文无 `.ping()`/`"pong"`；
    `dsh-client-connection/lib/client.browser.js` 亦无）；
  - WebSocket 由浏览器原生创建（`openConnectionWebSocket` → `new WebSocket(url)`，`dsh-client-connection/lib/client.browser.js:1348-1354`），
    浏览器按 RFC 6455 自动回 Pong；
  - 客户端侧唯一的超时是 ConnectionController 的 `generationReadyTimeoutMs=15s`（控制流就绪），与 mux 心跳无耦合。
  → 仅 server 侧参数即可，抬高间隔不会让客户端误判断线。

### 4.6 与代理修复的关系

配置 patch 与代理主动 Pong 是**独立的两种机制**：
- 代理 Pong 是「中间盒保活」，对所有慢链路/大帧通用，不改 DSH 配置、不需要重启 DSH 之外的组件（插件代码改动本身需重启 DSH 桌面端加载）；
- 配置 patch 是「放宽 DSH 误判阈值」，不依赖隧道实现，但只对这台 DSH 生效、要改用户 profile 文件、有升级漂移风险。
建议 **代理修复为主 + 配置 patch 作为可选的第二道防线**（在代理修复无法立即重启的窗口内，配置 patch 若 HMR 生效可立刻止疼）。

---

## 5. 代理侧 Ping→Pong 中间盒修复：DSH 侧安全性 + 我的独立实验

### 5.1 DSH 侧对「未经请求的 Pong」的语义（安全）

- `socket.on("pong", this.alive)`：任何 Pong 都只是清 `missedHeartbeats` — `/tmp/dsh-asar/dsh-api-gateway/lib/index.js:409`、`:329-331`；
- ws@8.22.0 的 receiver 对任何 Pong 控制帧都只 `emit('pong')`，**不校验是否有未响应的 ping、不校验 payload**
  — `/tmp/asar-out/receiver.js:703-713`；`websocket.js:1262-1277`；
- ws server 不会因 unsolicited Pong 报错/关闭；多回几次 Pong 只是多余的 6 字节控制帧；
- 反过来：ws server 自己的 `autoPong` 只影响它收到的 Ping（`websocket.js:1265`），与本机制无关。
  ⇒ **在 DSH 侧，「代理替链路回 Pong」没有协议风险**。

### 5.2 帧方向/掩码/格式要求（构造 Pong 时）

- 方向：DSH 是 WS server，代理在 DSH 眼里是 **client**，所以 Pong 必须是 **client→server 帧 = 必须 masked**（RFC 6455 §5.3）；
- opcode `0xA`（Pong），FIN=1；payload ≤125B，建议**回显对应 Ping 的 payload**（RFC 6455 §5.5.3；DSH 不校验，但回显最规范）；
- Pong 必须插在**完整帧边界**上（不能在别的帧的 payload 中间），且与其它 client→server 字节保持顺序；
- 若代理扫描 DSH→client 方向：服务端帧是 unmasked；扫描器要能跳过 HTTP 101 响应头（见 §5.3 第 1 点）。

### 5.3 现有 WIP 实现的两个问题（均已独立复现）

1. **HTTP 101 前导会"毒死"扫描器**：`proxy.js` 在向 DSH 写入 Upgrade 请求后立即 `upstream.on('data', ...)` 挂扫描器
   （`dsh-remoteService/packages/host-plugin/lib/proxy.js:248-282`），第一个上游数据 chunk 是
   `HTTP/1.1 101 Switching Protocols\r\n...`；首字节 `'H'=0x48` 被解析为 `fin=0 / opcode=0x8(Close)`，
   扫描器在 `ws-keepalive.js:73-75` 抛"非法控制帧"，`createSafeScanner` 永久停用（`proxy.js:302-319`）→ 静默失效。
   我在独立实验里把未切头的原始字节喂给 `createWsFrameScanner` 时复现了同一个异常。
   （Lead 已在 00-root-cause.md §3 说明改为"先切 101 头再启用扫描"，此条保留作为回归检查点。）
2. **只"看到 Ping 才回 Pong"来不及**：Ping 帧字节排在 4MB payload 之后（§1.2），只要代理对上行有背压，
   代理要等 payload 排空才能读到 Ping。实验（`/tmp/ping-order-test.mjs`，WS 服务端=DSH 心跳逻辑，中间 600KB/s 限速 TCP，
   中继内嵌 `ws-keepalive.js` 的 scanner + `buildMaskedPongFrame`，3.88MB 单帧）：

| 策略 | terminate | Ping 首次可读 | 客户端收到完整 payload | 结论 |
|---|---|---|---|---|
| 不回 Pong | **6007ms** | 6985ms | 未完成（被杀） | 必死 |
| 扫到 Ping 才回 Pong（reactive） | **6006ms** | 6976ms（reactive pong 发在 6976ms） | 未完成 | **慢约 1s，仍失败** |
| 拥塞期间定时主动 Pong（1s 间隔） | 无（存活 20s+，19 次 pong 均被 DSH 清零） | —（payload 期间 Ping 未到也不影响） | 持续传输 | ✅ |
| 复刻 DSH alive-path（排过队的 4MB 写完成 → alive） | 6007 → **8009ms** | 8034ms（比 terminate 晚 25ms） | 未完成 | 只延一个窗口，仍失败 |

日志：`/tmp/ping-none.log`、`/tmp/ping-reactive.log`、`/tmp/ping-proactive.log`、`/tmp/ping-alive.log`（脚本 `/tmp/ping-order-test.mjs`；
第一版日志里还能看到 101 前导异常）。

**与另一条独立验证互相印证**（harness-verify 的真实 DSH + 设备证书 + 限速链路 A/B）：
reactive-only 在 300KB/s / 400KB/s 下仍被杀；拥塞驱动的主动 Pong 一路存活到 **150KB/s、28.7s payload**。
（见 `dsh-remoteService/poc/` 的 harness 与 `docs/diagnostics/00-root-cause.md` §2.5/§4.2。）

> 结论：**reactive-only 不可靠**；需要「拥塞期间定时主动 Pong」（或更简单：mux socket 打开期间每 1s 主动一次），
> 或者让代理不背压、把大 payload 全速读进内存（内存风险，不推荐作为唯一手段）。
> 最终落地的实现是 **reactive + 拥塞驱动 proactive**（上游被暂停读 或 客户端 TLS 写缓冲超阈值期间，每秒主动发 masked Pong）；
> 代码状态已由 Lead 冻结：`proxy.js` sha256 `c5aa703d…`、`connector.js` `5b9a4fe9…`、`ws-keepalive.js` `04f02449…`。

### 5.4 死链/半开连接语义（假 Pong 的边界）

- 代理替链路回 Pong 后，DSH 心跳不再能区分「客户端慢」和「客户端死」。真正的断开仍由 socket 链检测：
  `clientSocket`/`upstream` 的 `close/error` 会互相 `destroy()`（`proxy.js:283-291` 一带），隧道断开即销毁上游连接。
- 残余风险：手机网络半开（无 FIN/RST）时，mux 可能被假 Pong 保活到 TCP 重传超时（分钟级），期间 DSH 侧该 mux 的
  `session/follow` 订阅仍占资源。缓解选项（按需）：
  - 只在「代理暂停读上游 / 客户端 TLS 写缓冲超阈值」等拥塞信号出现时定时发 Pong（更接近"链路替客户端保活"的本意）；
  - 记录 client→server 最近一次字节时间，超过 N 秒（如 60s）没有客户端任何字节就停止假 Pong（让 DSH 心跳回收），
    同时不影响正常会话（正常时浏览器的 Pong 会周期性上行）。
- 这些只是风险边界；对本 bug（慢但活的手机链路）假 Pong 是安全且必要的。

---

## 6. 推荐排序

| 排名 | 方案 | 有效性 | 成本/风险 | 是否需要重启 | 是否改 DSH |
|---|---|---|---|---|---|
| **1 (a)** | host-plugin 代理 mux 保活：**reactive + 拥塞期间定时主动 masked Pong**（上游暂停读 或 客户端 TLS 写缓冲 >64KB 时每 1s 一次；+ 101 头先切分；非 101 退化为纯透传）。配套 `connector.js` 严格 FIFO 发送队列（乱序/TLS 破坏 bug 的独立必需修复） | 直接消除心跳误杀；任何大帧/慢链路通用；真人 harness 已在 150KB/s / 28.7s payload 下存活，旧代码 300–400KB/s 即被杀 | 低：不改 DSH/配置；仅放宽半开连接回收（见 §5.4），用 socket close 链兜底 | 需重启 DSH 桌面端（插件是启动时加载的 linked 包） | 否（只改本仓库插件） |
| **2 (b)** | DSH profile patch：`typert-gateway.config.websocketHeartbeatIntervalMs: 30000` | 把误杀窗口从 4–6s 放宽到 60–90s；对 3.9MB/6.4s 有 5–10× 余量 | 中低：整体替换 config 需重述 key；升级可能静默失效/需回滚；半开回收变慢；只覆盖该 profile | 预计 HMR 热生效（未实测）；否则重启 App | 是（改用户 profile patch 文件，仍是官方 patch 机制） |
| **3 (c)** | 启用 WebSocket permessage-deflate 压缩 3.9MB JSON（预计 4–8×） | 能显著降低传输时间（<1s），但只是缓解而非心跳解耦 | 高：DSH 的 `new WebSocketServer({ noServer: true })`（`index.js:300`）未启用；ws server 默认 `perMessageDeflate: false`（`websocket-server.js:54,76`），**没有配置项可达**，需改 DSH 打包 JS（不支持/易碎）；代理目前是原样转发扩展头（`proxy.js:235`），但服务端不接受 | 是（改 DSH 包） | 是（改 DSH 内部代码） |
| 4 (d) | 其它：app 侧注入 JS 定时向 mux 发合法 `cancel` 帧（`streams.get(id)?.stop()` 对未知 id 是 no-op，但 `alive()` 先于解析执行，`index.js:410-411`）；app 侧 UI 稳定性/重连体验（task-3）；relay 扩容；降低 HISTORY_PAGE_OPTIONS（需改客户端 JS） | 可作零改 DSH 的应急手段（d1）；或降低症状感知（d2） | d1 依赖 DSH 内部帧格式（跨版本风险，非法帧会被 close(1008)）；d2 治标；relay 扩容不改代码但需花钱 | d1 改 app 注入脚本后需重装/重载 WebView | d1: 否（app 侧）；其它: 视方案 |

**一句话给 Lead**：主修复继续走 (a)（确保是"拥塞期间定时主动 Pong"，且已修 101 前导）；(b) 作为可选的第二道防线照抄 §4.4 的
8 行 patch 即可；(c) 不做；(d1) 可作为"来不及重启 DSH 时"的应急。

---

## 7. 附录：证据索引与复现命令

### 7.1 主要证据文件/行

| 事实 | 证据（`/tmp/dsh-asar/…` 或 `/tmp/asar-out/…`） |
|---|---|
| mux 路径、心跳常量/间隔/terminate、alive 来源、send queued-alive | `dsh-api-gateway/lib/index.js:133, 293, 300, 329-332, 362-379, 396-426, 409-411, 529-554, 701, 746-749, 777, 785` |
| mux client 重连/退避/代际、`connection/reset`、journal replace、`assertPageThrough` | `dsh-api-gateway/lib/client.browser.js:357-375, 521-577, 623-645, 998-1138, 1195, 1209-1224, 1297-1327, 1526-1531, 1630-1645` |
| ConnectionController 退避/就绪超时、浏览器 WS 创建 | `dsh-client-connection/lib/client.browser.js:898-903, 1000-1007, 1020-1056, 1126-1156, 1348-1354` |
| `connection/reset` 的 UI 监听者（模型闪烁） | `dsh-client-ui-model-selection/lib/client.js:1002-1005, 794-799`；`dsh-client-ui-settings-models/lib/client.js:4472-4482` |
| `session/follow` 快照形状与分页 | `dsh-api-session-controller/lib/index.js:1438, 1510-1585, 1680-1687, 1717-1747`；`lib/client.js:431-435, 481-486, 2177-2190, 2492-2502, 2679, 2692-2729` |
| patch 语义/层序/生效 | `app-boot.js:61-110, 1015-1053, 1127-1137, 3039-3046, 3838-3855`；`profile-boot.js:224-247, 272, 302`；`dsh-hmr.js:850-870, 1320-1368`；`dsh-desktop-host/lib/index.js:224-236` |
| 行 id/当前 config | `@deepseek-ai/dsh-base/cordis.patch.yml:52-53`（无 config）；`dsh-base/package.json`（`dsh.bundle.patch`） |
| ws 内部（ping 排入同一字节流、pong 语义、bufferedAmount、server deflate 默认） | `dsh/node_modules/ws/lib/sender.js:239-280, 503-..., 563-...`；`receiver.js:703-713`；`websocket.js:133-137, 1262-1277`；`websocket-server.js:54,76` |
| `MAX_TIMER_DELAY_MS` | `@deepseek-ai/dsh-timeout/lib/index.js:27` |

### 7.2 复现命令

```bash
# 1) 运行态与插件状态（不重启）
cd /tmp && COOKIE=$(node /tmp/mint-cookie.mjs) && \
  curl -s -H "Cookie: $COOKIE" http://127.0.0.1:63134/api/remote-access/status
# 关键输出：version=0.1.0（插件）、relay.connected=true、host.address=<hostId>.<relayDomain>:<publicPort>、
# tls.certFile=<DSH_HOME>/remote-access/certs/fullchain.pem、listenPort=63135

# 2) 手机设备 mux 重连统计（只读审计日志）
node -e '
const fs=require("fs");
const lines=fs.readFileSync(process.env.HOME+"/.dsh/remote-access/audit.jsonl","utf8").trim().split("\n").map(JSON.parse);
const ip=lines.filter(l=>l.deviceId==="<IPHONE_DEVICE_ID>"&&l.action==="ws-upgrade");
const gaps=[];for(let i=1;i<ip.length;i++)gaps.push(ip[i].ts-ip[i-1].ts);
const r=gaps.slice(-40).map(g=>g/1000).sort((a,b)=>a-b);
console.log("upgrades",ip.length,"min/p50/p90/max",r[0],r[Math.floor(r.length/2)],r[Math.floor(r.length*0.9)],r.at(-1));
'

# 3) 独立心跳/慢链路对照实验（ws@8.22.0 + 600KB/s 限速中继 + ws-keepalive scanner）
#    生成 4 份日志：/tmp/ping-none.log /tmp/ping-reactive.log /tmp/ping-proactive.log /tmp/ping-alive.log
node /tmp/ping-order-test.mjs none; node /tmp/ping-order-test.mjs reactive
node /tmp/ping-order-test.mjs proactive; node /tmp/ping-order-test.mjs alive
```

### 7.3 边界说明

- 本文未实测「写 patch 文件 → HMR 热生效」链路（按要求不改用户配置），只给出代码路径证据（§4.3）；若需 100% 确认可重启桌面端。
- 本文未改动任何产品代码；`/tmp/ping-order-test.mjs`、`/tmp/mint-cookie.mjs`、`/tmp/ping-*.log`、
  `/tmp/probe/*` 都是诊断期的临时实验脚本/日志/调试证书，**不属于仓库交付物，已在收尾时清理**；
  持久、可复现的工具是仓库里的 `poc/heartbeat-verify.js` + `poc/heartbeat-runner.js`（见 02）。
  若要用同样的心跳实验复跑，可直接用这两个脚本 + 自己的调试设备证书。
- 文中 DSH 源码行号基于 `app.asar`（`0.2.1-rc.3`）解包结果，升级版本后行号/字段可能变化。
