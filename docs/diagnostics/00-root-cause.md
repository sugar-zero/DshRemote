# 手机 App「载入历史很久/失败 + 画面反复跳」根因与修复

> 结论先行：这是**主机插件反向代理与 DSH WebSocket 心跳机制不兼容**导致的 bug，不是手机端 UI bug。
> 已在 `dsh-remoteService/packages/host-plugin` 修复；需要**重启 DSH** 让插件重新加载后生效。

## 1. 用户症状

- iPhone App 里点开某个会话时，「载入历史」转圈很久，大概率失败；
- 页面时不时整体“跳一下”——表现为模型选择、会话列表等 UI 状态突然刷新；
- 只要停在这个会话界面，就会持续周期性发生（主机审计日志里可以看到连续几分钟每 5–15s 一次重连）。

## 2. 证据链

### 2.1 主机审计日志：`/api/remote.mux` 在持续重连

`~/.dsh/remote-access/audit.jsonl` 里同一设备（手机）连续出现：

```
04:04:13 ws-upgrade /api/remote.mux ok
04:04:18 ws-upgrade /api/remote.mux ok
04:04:29 ws-upgrade /api/remote.mux ok
...（持续数分钟，间隔 5–15s）
```

`/api/remote.mux` 是 DSH Web 前端唯一的数据面 WebSocket，它断 → 前端 `connection/reset`
→ 会话流、模型/会话投影全部重取，这就是“画面跳一下”的来源。

### 2.2 DSH 的心跳规则（源码：`dsh-api-gateway`）

- `/api/remote.mux` 每 **2s** 发一次 WebSocket Ping；
- `MAX_MISSED_HEARTBEATS = 2`：连续 2 个周期没有 Pong/任何帧 → `socket.terminate()`
  （`dsh-api-gateway/lib/index.js` 的 `RemoteStreamMuxServer.startHeartbeat` /
  `RemoteStreamMuxConnection.run`）；
- 也就是说客户端必须在 ~6s 内让 Pong 回到 DSH，否则 mux 必死。

### 2.3 大会话的 history 快照是一个数 MB 的单帧

DSH 前端打开会话时先开 `session/follow` 流；该流的**首帧**是历史快照：

- 本会话实测：**单条 WS text message ≈ 3.9 MB**（打开 `session/follow` 后 31ms 内
  本地直连收到，`msg.size=3,882,729`）；
- 后续 `session/page` 每页也有 ~3.5 MB。

### 2.4 慢速 relay 上 4MB 需要 > 6s，正好撞上心跳窗口

把探针放到真实 relay 后面（VPS 上行约 5 Mbps ≈ 600 KB/s）：

```
mux open 309ms
$events ready 364ms
history 快照 3,900,396B 到达 6405ms
CLOSE 1006（异常断开）6424ms   ← 刚好在 DSH 心跳 terminate 的时刻
```

对照实验：客户端每 500ms **主动发一个 Pong**（模拟“链路替客户端保活”），
同样的 4MB 传输 6.6s 到达、连接存活 20s+。⇒ 根因确定是**心跳误杀**：
Ping/Pong 被排在 4MB 数据后面，客户端根本来不及在 6s 内 Pong。

### 2.5 只“看到 Ping 才回 Pong”不够（关键坑）

DSH 写 4MB 帧后，后续 2s Ping 帧是**排在同一个发送队列的字节流后面**的；当代理
因为下行拥塞而暂停读上游时，Ping 字节要等 payload 排空才会被代理读到——等
扫到 Ping 再回 Pong 已经晚了。独立仿真（600KB/s、3.88MB 单帧）：

| 策略 | 结果 |
|---|---|
| 不回 Pong | terminate @ 6007ms |
| 扫到 Ping 才回 Pong（reactive） | Ping 首次可读 @ 6976ms，terminate @ 6006ms，仍然失败 |
| 拥塞期间定时主动发 Pong | 存活 20s+ ✅ |

所以最终实现是 **reactive + congestion-driven proactive（拥塞时每秒主动 Pong）**。

### 2.6 附带发现的真实 bug：主机→relay 发送队列会乱序

`RelayConnector.#sendBinary` 旧实现：当 `ws.bufferedAmount > 2MB` 时把当前帧
`setTimeout` 延后重发，但更晚到达的帧可能先发出去 → 隧道里的 TLS 密文字节乱序
→ 大 payload 传输时整条连接坏掉。已改成严格 FIFO 有序队列 + 本地 socket 背压。

## 3. 修复内容

全部在 `dsh-remoteService/packages/host-plugin/`：

| 文件 | 改动 |
|---|---|
| `lib/ws-keepalive.js`（新增） | 增量 WebSocket 帧扫描器（只解析帧头、跳过数据 payload、支持分片/64 位长度/跨 chunk）；masked Pong 帧构造 |
| `lib/proxy.js` | ① 先切出上游 HTTP 101 响应头再启用帧扫描（否则扫描器会把 `HTTP/1.1` 当坏帧）；② 收到 DSH Ping 立即回 masked Pong；③ **拥塞检测**（代理暂停读上游 或 客户端 TLS 写缓冲 >64KB）期间每秒主动发 Pong → 心跳与慢速下行彻底解耦；④ 上游非 101 时记审计 `ws-upgrade-failed` 并退化为纯字节透传 |
| `lib/connector.js` | 二进制帧改为**严格有序队列**发送（修复乱序 bug）；队列积压时暂停本地 socket 读取（背压，防内存膨胀） |

安全/语义说明：代理替隧道回 Pong 只影响“半开 TCP 连接”的清理；真正的客户端断开
仍由 `clientSocket` close → `upstream.destroy()` 检测。代理只对 `/api/remote.mux`
这么做，HTTP 请求路径完全不变。

## 4. 验证

### 4.1 单元/集成测试（`cd dsh-remoteService && npm test`）

- `test/ws-keepalive.test.js`：帧扫描器跨 chunk、分片、64 位长度、masked 控制帧、非法帧降级；
- `test/ws-keepalive-proxy.test.js`：101 头切分、客户端 `autoPong=false` 时代理回 Pong、
  下行拥塞时主动 Pong、上游非 101 原样透传 + 审计；
- `test/connector-queue.test.js`：模拟慢速 WSS 背压下 5MB 数据 + CLOSE 帧**严格保序**；
- 全量：**73/73 通过**（连续 3 次）。

### 4.2 端到端复现/验收（真实 DSH + 真实设备证书 + 限速链路）

独立 harness（`dsh-remoteService/poc/heartbeat-verify.js` + `heartbeat-runner.js`）
以真实 DSH Web 为上游、真实设备 mTLS 证书为客户端，在中间插入限速 TCP 转发器：

| 场景 | 旧代码 | 新代码 |
|---|---|---|
| 600 KB/s 下行，4.2MB 历史快照 | **CLOSE 1006 @ 4.6s，快照未收到** | 存活 20s+，快照 6.85s 完整到达 ✅ |
| 300 KB/s 下行，4.2MB 历史快照 | **CLOSE 1006 @ 4.6s** | 存活 26s+，快照 13.7s 完整到达 ✅ |

> 300KB/s 场景说明：13.7s 早远超 6s 心跳窗口，只有“主动 Pong”方案能活。

## 5. 生效方式与残余限制

- **必须重启 DSH 桌面端/Web 实例**：Host 半插件是启动时加载的（linked 包不会热更新）。
  重启后手机无需重新配对。
- 修复解决的是“失败 + 反复跳”；**打开超大会话仍然受带宽限制**：4MB / 5Mbps ≈ 7s。
  若想进一步加速：提高 relay VPS 带宽/线路质量，或后续在代理层做 WebSocket
  permessage-deflate 压缩（JSON 历史通常可压 4–8 倍，属独立优化项，未在本轮实现）。
- 若 DSH 后续调整心跳参数，本机制仍然安全（多回 Pong 不会报错），但可在证据确认后简化。
- 若希望多一道保险，可按 [`01-dsh-heartbeat.md` §4.4](01-dsh-heartbeat.md) 在 DSH profile patch 里把
  `typert-gateway.websocketHeartbeatIntervalMs` 调到 30s（可选；主修复不依赖它）。

## 6. 延伸材料

| 文档 | 内容 |
|---|---|
| [`01-dsh-heartbeat.md`](01-dsh-heartbeat.md) | DSH 心跳/重连/快照的源码级分析（file:line）、Ping 顺序实验、配置 patch 方案与风险 |
| [`02-heartbeat-harness.md`](02-heartbeat-harness.md) | 慢链路心跳复现/验收工具（`poc/heartbeat-verify.js` + `poc/heartbeat-runner.js`）的用法与实测数据 |
| [`03-app-webview.md`](03-app-webview.md) | App 侧跳动源/进程回收恢复/误报的排查与修复、真机验收清单 |
| [`04-session-switch-cache.md`](04-session-switch-cache.md) | 会话切换重复同步/重连重载的客户端本地缓存（warm cache）与差异更新 |
| [`05-mobile-right-panel.md`](05-mobile-right-panel.md) | 手机窄屏右侧栏被注入壳 CSS 隐藏的修复 |
| [`06-mobile-settings-drawer.md`](06-mobile-settings-drawer.md) | 手机设置弹窗改全屏 + 分区菜单抽屉 |
| [`07-mobile-external-links.md`](07-mobile-external-links.md) | 手机端外链交给系统浏览器打开 |
| [`08-host-ec-csr-windows.md`](08-host-ec-csr-windows.md) | Windows 主机 EC 设备 CSR 配对失败（无 openssl）的修复 |
| [`09-mobile-history-slicing.md`](09-mobile-history-slicing.md) | 手机端会话历史分片拉取（首屏小窗口 + 按需翻页），本文件「大快照」问题的客户端侧解法 |
| [`10-mobile-host-actions.md`](10-mobile-host-actions.md) | App 隐藏「在主机本机打开」入口 + 远程「重启主机 DSH」（host-plugin 0.1.10 / App 0.1.11） |
