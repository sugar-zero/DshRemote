# 02 · 慢速链路下 DSH mux 心跳误杀：复现工具与修复验证

> 目标：用**独立、可复现**的工具证明手机端「打开大会话反复转圈/画面跳」的根因是
> DSH `/api/remote.mux` 的心跳误杀；并对主机插件修复（WS Ping→Pong 中间盒 +
> 拥塞期主动 Pong）做冻结代码后的最终验证。
>
> 本文所有数字均在本机（macOS，Node v24.16）实测。复现命令见 §9。
>
> 相关文件：
> - 工具：`dsh-remoteService/poc/heartbeat-verify.js`、`dsh-remoteService/poc/heartbeat-runner.js`
> - 修复：`dsh-remoteService/packages/host-plugin/lib/{proxy.js,ws-keepalive.js,connector.js}`

## TL;DR

1. **根因确认**：DSH api-gateway 对 `/api/remote.mux` 每 2s 发一次 WS Ping，连续
   `MAX_MISSED_HEARTBEATS = 2` 个周期（≈6s）收不到 Pong/任何帧就 `terminate()`。
   打开大会话时 `session/follow` 的首帧是 **3.5MB–4.5MB 的历史快照**（单条 WS text
   message）；慢速下行时 Ping/Pong 被排在这条大帧后面（TCP 队头阻塞），DSH 误判
   客户端失联 → 杀 mux → 客户端重连/重试。
2. **复现（运行中的旧代码主机插件，600 KB/s 限速）**：无 Pong 代发时 mux 在
   **+8.4~8.9s 被杀（close 1006），大帧未传完**；客户端每 500ms 主动发 Pong 时
   **存活 >25s 且大帧完整**。对照组（限速但只开 `$events`）正常存活。
3. **修复验证（冻结的 repo 代码，独立 runner）**：**600/400/300/150 KB/s 全部存活、
   大帧完整**；同一 runner 换回 pre-fix 的 `proxy.js`（git HEAD）在 600 KB/s 下
   **+6.4s 被杀**。
4. **关键陷阱**：只在「读到 Ping 才回 Pong」**不够**——Ping 本身排在数 MB 大帧后面，
   等代理读到它时 DSH 可能已触发心跳上限。必须在大帧下行**拥塞期间主动周期发
   Pong**。冻结代码已包含该逻辑（`KEEPALIVE_INTERVAL_MS=1000`、
   `KEEPALIVE_CONGESTION_BYTES=64KB`）；A/B 变体（关掉主动 Pong）在 150 KB/s 下
   2/2 被杀、300 KB/s 下 1/3 被杀，证明它是竞态而非可靠修复。

---

## 1. 机理（代码依据）

DSH 侧实现（从 app.asar 提取到 `/tmp/dsh-asar/dsh-api-gateway/lib/index.js`，行号为该提取文件）：

| 位置 | 行为 |
|---|---|
| `:293` | `const MAX_MISSED_HEARTBEATS = 2;` |
| `:329-333` | `alive()`：任何 Pong/任何收到的帧 → `missedHeartbeats=0` |
| `:362-379` | `startHeartbeat()`：每个心跳周期遍历 OPEN socket；`missed>=2` → `setImmediate(... terminate())`；否则 `missed++` 并 `socket.ping()` |
| `:397-401` | 注释明确：Pong、收到任何帧、以及**排过队的下行写完成**都算对端活跃 |
| `:409-411` | `socket.on("pong", alive)`、`message` → `alive()` |
| `:542-551` | `send()` 里 `queued = socket.bufferedAmount > 0`，完成回调且当时排过队才 `alive()`（证明「本地写完成」不算链路活跃，但**排过队的写完成**会把计时器往后推一个周期——这是杀 mux 时刻在 6~9s 间波动的原因） |

队头阻塞为什么发生：历史快照是**一条** WS text message；ws 发送器按序写 TCP 流，
心跳 Ping 帧由定时器产生但只能追加在排队中的大帧字节之后。慢链路下行时大帧要数秒
乃至数十秒才能写完 → Ping 落后 → Pong 落后 → 2 个心跳周期后 mux 被 terminate。
实测证据：修复前的客户端在 payload 传完的瞬间**一次性收到 4 个 Ping**（见 §3、§6）。

---

## 2. 工具说明

### 2.1 `poc/heartbeat-verify.js`

自包含 Node 脚本（只依赖 repo 已有的 `ws`）：

- **限速 TCP 转发器**：监听 127.0.0.1 临时端口，转发到目标 TLS 端口；下行按
  `--rate` 字节/秒匀速放行（默认 600000），用 pause/resume 把背压传回源 socket；
  上行默认不限速（只影响很小的控制帧）。
- **真实 mTLS WS 客户端**：用 debug 设备证书（本次诊断放在 `/tmp/probe/device.crt|key`，**已清理**；复跑需自备，见 §2.3），
  `servername=<hostId>.<relayDomain>`、`rejectUnauthorized:false`，
  连 `wss://127.0.0.1:<port>/api/remote.mux`，依次发 `$events` 与
  `session/follow` 的 open 帧（与 DSH Web 客户端一致）。
- **测量项**：WS open 时刻、Ping 到达时刻、每条 message 大小/时刻（>100KB 记为
  “大帧”并解析 JSON 校验完整性）、close 码/时刻、限速器转发字节数、吞吐采样。
- **判定**：`survived-big-payload-complete` / `mux-killed-with-big-payload-in-flight` /
  `mux-killed-after-big-payload` / `survived-without-big-payload`。
- `--pong-spoof`：每 `--spoof-ms`（默认 500）主动发 unsolicited Pong——等价于
  「代理替隧道回 Pong」的修复效果，用于因果对照。
- `--runner`：自动拉起 `poc/heartbeat-runner.js` 并把目标指向它（见 2.2）。
- `--no-follow`：只开 `$events`，不 follow 大会话（心跳基线对照）。
- 安全阀：watchdog 在 `--duration + 30s` 后强制退出，避免测试挂死。

常用参数（`node poc/heartbeat-verify.js --help` 有完整列表）：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--port <n>` | 63135 | 目标 TLS 端口（运行中的主机插件监听） |
| `--rate <B/s>` | 600000 | 下行限速；`0` = 不限速直连 |
| `--pong-spoof` | 关 | 每 `--spoof-ms` 主动发 Pong |
| `--duration <ms>` | 20000 | 最长观察时间 |
| `--session <id>` | 无（必填） | 要 follow 的会话 id；也可用环境变量 `DSH_PROBE_SESSION` |
| `--runner` | 关 | 用独立 runner 起 repo 当前代码作为目标 |
| `--proxy-module <path>` | repo 当前 `proxy.js` | 配合 `--runner` 指定 `DshProxy` 模块（A/B 用） |
| `--no-follow` | 关 | 只开 `$events` |
| `--json` | 关 | 末尾输出一行机器可读 JSON 摘要 |

### 2.2 `poc/heartbeat-runner.js`

用 **repo 当前 host-plugin 代码** 起一个独立 mTLS TLS 监听（不连 relay、不重启、
不改动正在运行的 DSH/插件），供 `--runner` 使用：

- TLS 证书/私钥：读 `~/.dsh/remote-access/certs/{fullchain.pem,privkey.pem}`
  （文件路径取自 `~/.dsh/remote-access/config.json`，只读）。
- 设备 CA：`~/.dsh/remote-access/device-ca/cert.pem`（只读）。
- `devices.json` **先复制到 `/tmp` 临时目录**再用 `DeviceStore` 加载——`touch()`
  只会写临时副本，**绝不修改正在运行的插件状态**。
- `DshProxy` 上游 = `127.0.0.1:63134`；`authenticatedUrl` 指向一个本地一次性 HTTP
  服务，返回 `Set-Cookie: <现场生成的 DSH 浏览器 cookie>`（cookie 由
  `~/.dsh/.credentials.yaml` 的 browser-session secret HMAC 生成，
  authority=`127.0.0.1:63134`，不落盘）。
- 监听 127.0.0.1 临时端口，stdout 打一行
  `{"event":"ready","port":...}`；SIGINT/SIGTERM 正常关闭。
- `--proxy-module <path>`：加载任意版本的 `DshProxy` 模块 → 可以做
  **pre-fix / post-fix / 变体** 的同环境 A/B。

### 2.3 前置条件

- 运行中的主机插件远程 TLS 监听端口（本文验证时为 **127.0.0.1:63135**，旧代码在内存里跑；
  §3 复现都针对它）。端口可从 `~/.dsh/remote-access/` 的运行状态或插件日志确认；
  重置/重启插件后端口会变，`heartbeat-verify.js --port` 可指定。
- DSH Web：`http://127.0.0.1:63134`（`heartbeat-runner.js` 会在内存里用
  `~/.dsh/.credentials.yaml` 的 browser-session secret 现签 DSH cookie，不需要单独
  导出 cookie 的工具）。
- 大会话：`<SESSION_ID>`（测试期间正被使用，因此
  历史快照大小会在 3.5MB–4.5MB 之间变化；表格里为实测值）。
- 设备证书：本次诊断临时注册了 `<DEBUG_DEVICE_ID> (debug-probe)` 并把证书放在
  `/tmp/probe/{device.crt,device.key,ca.pem}`，**诊断结束后已撤销该设备并删除证书**。
  复跑时请用自己的调试设备：`--cert/--key/--ca/--servername`（`heartbeat-verify.js`）
  或直接用一台已配对设备；建议只在测试环境这么做。
- `heartbeat-verify.js` 的会话与 SNI 没有内置默认值，用参数或环境变量提供：

  ```bash
  export DSH_PROBE_SESSION=<SESSION_ID>                 # 要 follow 的会话 id
  export DSH_PROBE_SERVERNAME=<hostId>.<relayDomain>    # 主机子域（TLS SNI）
  # 可选：export DSH_PROBE_CERT=/path/to/device.crt DSH_PROBE_KEY=... DSH_PROBE_CA=...
  ```

  下文命令都假设已设置好上述环境变量。

---

## 3. 复现实验 A：运行中的主机插件（旧代码）@ 600 KB/s

```bash
cd <repo>/dsh-remoteService

# A1. 限速 + 不代发 Pong（应被杀）
node poc/heartbeat-verify.js --rate 600000 --duration 20000 --json

# A2. 限速 + 客户端每 500ms 主动 Pong（对照：应存活）
node poc/heartbeat-verify.js --rate 600000 --pong-spoof --duration 25000 --json

# A3. 对照：限速但只开 $events（不 follow 大会话）
node poc/heartbeat-verify.js --rate 600000 --no-follow --duration 8000 --json
```

实测（2026-10-25 早间，live 插件 63135）：

| 场景 | 大帧 | Ping 收到 | mux 关闭 | 转发器下行字节 | 结论 |
|---|---|---|---|---|---|
| A1-a 无 Pong | 未完成 | 0 | **1006 @ +8365ms** | 4,262,415 | 心跳误杀，payload 丢在半路 |
| A1-b 无 Pong | 未完成 | 0 | **1006 @ +8393ms** | 4,238,415 | 同上（复跑） |
| A1-c 无 Pong | 4,389,890B @ +8666ms | 0 | **1006 @ +8917ms** | 4,532,414 | 大帧刚好传完就被杀（竞态）|
| A2 Pong 代发 | **4,409,633B @ +8714ms（complete）** | 13 | 存活至 +25s | 4,424,447 | 存活且 payload 完整 |
| A3 只开 $events | — | 4（738/2734/4734/6735ms） | 无 | — | 限速本身不杀 mux |

**A2 的关键细节**：大帧传完前 Ping 数为 0；传完瞬间 **4 个 Ping 一起到达**
（`+8734ms` ×4），之后恢复 2s 节奏（8849、10852、12856…）。这直接证明 Ping 帧
被队头阻塞在大帧之后——也是为什么修复必须做「拥塞期主动 Pong」而不能只等 Ping。

### 3.1 旧代码的速率敏感性（live 插件）

| 下行限速 | 结果 |
|---|---|
| 1,000,000 B/s | 存活；大帧 4,290,064B @ +5140ms（在心跳上限前传完，`queued-write` 活跃判定救了它） |
| 600,000 B/s | 被杀（见上表，+8.4~8.9s） |
| 300,000 B/s | 被杀 1006 @ +16771ms；大帧未完成；转发 4,238,414B |

即：旧代码在「大帧传输时间 > 心跳宽限」时必然被杀；600 KB/s ~ 1 MB/s 附近是临界带。

---

## 4. 独立 runner + pre-fix A/B（同一 harness/runner，公平对照）

```bash
# 从 git HEAD 导出旧版 proxy.js（不动工作区）
cd <repo>
git show HEAD:dsh-remoteService/packages/host-plugin/lib/proxy.js > /tmp/pre-fix-proxy.mjs

# pre-fix：600 KB/s、不代发 Pong
cd dsh-remoteService
node poc/heartbeat-verify.js --runner --proxy-module /tmp/pre-fix-proxy.mjs \
  --rate 600000 --duration 18000 --json
```

| 场景 | 大帧 | Ping | 关闭 | 结论 |
|---|---|---|---|---|
| pre-fix `proxy.js`（git HEAD）+ runner @600KB/s | 未完成 | 0 | **1006 @ +6396ms** | 复现成功（与 live 插件同现象） |
| 冻结工作区 `proxy.js` + runner @600KB/s | 3,622,967B @ +6752ms | 10 | 无 | 存活 |

> 说明：pre-fix 的 `DshProxy` 与运行中的旧插件是同一份代码，故 runner+pre-fix 与
> live 插件两侧现象一致，证明 runner 路径可信；随后对 runner 换代码即可做因果验证。

---

## 5. 修复代码与冻结哈希

验证前由 Lead 冻结（此后不应再改，若改需重跑本矩阵）：

| 文件 | sha256 |
|---|---|
| `packages/host-plugin/lib/proxy.js` | `c5aa703d8c3d0f267c163146770ce33215dce3404a4851e42a26bb7af5961f4c` |
| `packages/host-plugin/lib/connector.js` | `5b9a4fe99982515ecaabd25e5c48999c145b12a5e3fc9480713a2f20b3ecd894` |
| `packages/host-plugin/lib/ws-keepalive.js` | `04f02449d69722e09a02b5ed3573f7e3b32824d4777fce5392d40460f66d33f9` |

（矩阵运行前后复核哈希一致；本文件写好后再次复核仍一致。）

修复要点：

1. `ws-keepalive.js`：增量 WS 帧扫描器（只解析帧头，大 payload 用 subarray 跳过；
   支持跨 chunk/分片/64 位长度/掩码）+ `buildMaskedPongFrame()`（客户端方向必须
   masked）。
2. `proxy.js` `handleUpgrade()`：只对 `/api/remote.mux` 启用；先原样转发上游
   `HTTP 101` 响应头，再扫描 DSH→客户端明文字节流；**看到 Ping 立刻向上游 DSH
   写一个 masked Pong**；原始字节仍原样转发（扫描器出错只禁用扫描，退化为纯 TCP
   透传）。
3. `proxy.js` 追加**拥塞期主动 Pong**：`congested = upstream.isPaused() ||
   clientSocket.writableLength > KEEPALIVE_CONGESTION_BYTES(64KB)` 时，每
   `KEEPALIVE_INTERVAL_MS(1000)` 向上游主动写一个 masked Pong——这是慢链路下真正
   把心跳与下行进度解耦的部分（见 §6 的反例）。
4. `connector.js`：relay 发送侧的有序队列（防背压时重排/破坏 TLS 流）。本 harness
   不经过 relay，该改动由 `npm test`（`connector-queue.test.js` 等）覆盖。

---

## 6. 修复验证矩阵（冻结代码，无客户端 Pong 代发）

```bash
cd <repo>/dsh-remoteService
node poc/heartbeat-verify.js --runner --rate 600000 --duration 20000 --json
node poc/heartbeat-verify.js --runner --rate 400000 --duration 22000 --json
node poc/heartbeat-verify.js --runner --rate 300000 --duration 30000 --json
node poc/heartbeat-verify.js --runner --rate 150000 --duration 48000 --json
```

实测（冻结哈希，矩阵跑完后哈希复核未变）：

| 下行限速 | 大帧 | Ping 收到 | 关闭 | 转发下行字节 | 结论 |
|---|---|---|---|---|---|
| 600,000 B/s | 3,622,967B @ +6752ms | 10 | 无 | 4,409,102 | **存活，payload 完整** |
| 400,000 B/s | 3,501,457B @ +10342ms | 11 | 无 | 3,513,508 | **存活，payload 完整** |
| 300,000 B/s | 3,501,457B @ +13817ms | 15 | 无 | 3,513,626 | **存活，payload 完整** |
| 150,000 B/s | 3,501,457B @ +27587ms | 24 | 无 | 3,513,841 | **存活，payload 完整** |
| pre-fix A/B 600,000 B/s | 未完成 | 0 | **1006 @ +6396ms** | 3,223,155 | 复现旧 bug（对照） |

Ping 到达模式同样印证队头阻塞：payload 完成前 Ping 数为 0（150KB/s 时 14 个 Ping
在 `+27606ms` 一次性到达），之后恢复 2s 节奏；代理的主动 Pong 让 DSH 在此期间始终
认为链路活跃，**大帧完整到达且 mux 不掉**。

---

## 7. 反例：只做「看到 Ping 才回 Pong」为什么不够

构造 A/B 变体（只关掉冻结代码里的拥塞期主动 Pong，其余完全一致）：

```bash
mkdir -p /tmp/proxy-variants/reactive-only
cd <repo>/dsh-remoteService
cp packages/host-plugin/lib/proxy.js       /tmp/proxy-variants/reactive-only/proxy-reactive.mjs
cp packages/host-plugin/lib/ws-keepalive.js /tmp/proxy-variants/reactive-only/ws-keepalive.mjs
sed -i '' "s#from './ws-keepalive.js'#from './ws-keepalive.mjs'#" /tmp/proxy-variants/reactive-only/proxy-reactive.mjs
sed -i '' 's#if (parsed.status === 101 \&\& isMuxUpgrade) startKeepAlive();#if (parsed.status === 101 \&\& isMuxUpgrade \&\& false) startKeepAlive();#' \
  /tmp/proxy-variants/reactive-only/proxy-reactive.mjs

node poc/heartbeat-verify.js --runner \
  --proxy-module /tmp/proxy-variants/reactive-only/proxy-reactive.mjs \
  --rate 300000 --duration 30000 --json
```

实测（payload 均 3,501,457B）：

| 下行限速 | 结果 | 说明 |
|---|---|---|
| 300,000 B/s | 存活 @ +13811ms / 存活 @ +13882ms / **被杀 @ +11404ms** | 竞态：1/3 失败 |
| 150,000 B/s | **被杀 @ +25368ms / 被杀 @ +22697ms** | 2/2 失败 |

机理：Ping 帧本身排在大帧后面，代理**读到 Ping 时已经太晚**；能否赶上完全取决于
DSH 的 `queued-write` 活跃判定把截止时间推后多少 + 心跳相位。冻结代码的拥塞期主动
Pong 不依赖 Ping 到达，因此 150–600 KB/s 全过。**结论：主动 Pong 不是优化，是必需。**

> 备注：修复过程中曾观察到一个更早的中间版本（只有 reactive 逻辑）在 300KB/s
> （+13963ms）和 400KB/s（+12011ms，payload 4.34MB）被杀——与本变体结论一致。

---

## 8. 局限与注意事项

- **live 插件仍是旧代码**（进程在修复前启动）。本文 §3 是「修复前」参照，§6 是
  「修复后」；要让手机真正受益，需用户更新/重启 DSH（本任务按要求**没有**动它）。
- 限速器在**TLS 密文层**限速（≈下行链路），因此报的字节数含 TLS 开销；实际
  `--rate` 与 payload 有效吞吐略有差异（约 85%）。
- 大会话历史快照大小随会话活跃度变化（实测 3.5MB–4.5MB）；关闭时刻受心跳相位 +
  `queued-write` 宽限影响，在 6–9s 间波动。**断言应看「大帧是否完整 + mux 是否存活」，
  不要依赖某个精确毫秒数**。
- `heartbeat-runner.js` 只读 `~/.dsh` 下的证书/CA/设备/配置，`devices.json` 用
  `/tmp` 副本（`touch()` 不会写活文件）；不连 relay、不改 live 插件、不写
  `audit.jsonl`。连接 live 插件时插件自身会更新设备的 `lastSeenAt`（正常行为）。
- 需要一台可用的调试设备证书（本次用的临时设备已撤销并删除，见 §2.3）；若证书/会话 id 变化，
  用 `--cert/--key/--ca/--servername/--session` 覆盖。
- `/tmp/pre-fix-proxy.mjs`、`/tmp/proxy-variants/**` 是临时 A/B 产物，可随时重建
  （命令见 §4、§7）。

---

## 9. 复现命令速查

```bash
cd <repo>/dsh-remoteService

# —— A. 复现旧 bug（运行中的插件，63135，read-only）——
node poc/heartbeat-verify.js --rate 600000 --duration 20000 --json          # 预期 1006 被杀、大帧不完整
node poc/heartbeat-verify.js --rate 600000 --pong-spoof --duration 25000    # 预期存活、大帧完整
node poc/heartbeat-verify.js --rate 600000 --no-follow --duration 8000      # 对照：只开 $events，存活

# —— B. 验证 repo 当前（冻结）代码 ——
node poc/heartbeat-verify.js --runner --rate 600000 --duration 20000        # 预期 survived-big-payload-complete
node poc/heartbeat-verify.js --runner --rate 300000 --duration 30000
node poc/heartbeat-verify.js --runner --rate 150000 --duration 48000

# —— C. pre-fix A/B ——
cd <repo> && \
  git show HEAD:dsh-remoteService/packages/host-plugin/lib/proxy.js > /tmp/pre-fix-proxy.mjs && \
  cd dsh-remoteService && \
  node poc/heartbeat-verify.js --runner --proxy-module /tmp/pre-fix-proxy.mjs \
    --rate 600000 --duration 18000          # 预期 mux-killed-with-big-payload-in-flight

# —— D. 独立测试套件（修复后）——
npm test        # 预期 73/73；push.test.js 有已知的并行负载偶发 flake，失败可重跑一次
```

独立测试套件结果（本机实测）：第一次 `npm test` **72/73**，唯一失败是
`host-plugin/test/push.test.js`（Lead 已说明的已知并行 flake）；**重跑一次 73/73 全过**。

---

## 附录：产物与证据文件

| 文件 | 说明 |
|---|---|
| `poc/heartbeat-verify.js` | 限速 + mTLS mux 客户端 + 测量/判定（本文主工具） |
| `poc/heartbeat-runner.js` | 用 repo 当前代码起独立 TLS 监听（`--runner` 用） |
| `/tmp/final-matrix.jsonl` | 冻结代码最终矩阵的原始 JSON 行（本机临时文件） |
| `/tmp/reactive-matrix.jsonl` | reactive-only 反例矩阵原始 JSON 行（本机临时文件） |
| `/tmp/pre-fix-proxy.mjs` | `git show HEAD:…/proxy.js` 导出的 pre-fix 版本（临时） |
