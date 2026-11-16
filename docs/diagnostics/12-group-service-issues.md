# 12 — 群体服务版（A 模式）落地问题全记录

> 范围：`feat/group-service`（relay 终止 TLS、主机出站隧道、设备 P-256 密钥 + 短时 token、
> 无客户端证书；服务端自助注册 + 邀约 + 部署方后台）。
> 最终版本：App **0.1.0 (buildNumber 6)**、host-plugin **0.1.23**、relay **0.2.13**（验收镜像）、
> relay **0.2.14**（仅日志降噪，功能同 0.2.13）。用户 2026-11-01 真机验收通过。
> 本文所有域名/hostId/设备 ID/端口映射均已脱敏。
>
> **后续更新（2026-11-01）**：本分支已进一步剥离 classic/单体版，只保留群体服务：
> relay **0.3.0**、host-plugin **0.2.0**、protocol **0.2.0**、App **0.1.1**（构建号 7）。
> 本文中提到的 relay 0.2.x / host-plugin 0.1.x 为当时修复版本；这些修复都已包含在当前版本中。

## 0. 快速索引

| # | 现象 | 根因 | 修复 | 版本/提交 |
|---|---|---|---|---|
| 1 | relay 启动即退出：`cannot read config file ... ENOENT` | 容器内没有 `relay.json` | entrypoint 从 `.env` 自动生成（0600，不覆盖已有） | relay 0.2.2 |
| 2 | 配了 `.env` 但 `RELAY_DOMAIN` 不生效 | compose 默认只读 `.env`；`--env-file` 未带 | `${RELAY_DOMAIN:?}` 快速失败 + 文档说明 | compose/文档 |
| 3 | 宿主端口 bind 没生效（0.0.0.0） | 旧 compose 缺 `*_HOST_BIND` 行 | 补齐 compose 变量 + README 排障 | compose |
| 4 | 主机日志 `relay control socket error` | `PUBLIC_CONTROL_PORT` 与实际 nginx listen 不一致 | 填「nginx 实际 listen 端口」；新增 refresh 自动同步 | relay 0.2.6 |
| 5 | 后台只显示 `inv_…`，无法复制邀请码 | 邀请码只存哈希 | `group.json` 明文存码（0600）+ 后台用掩码/复制按钮 | relay 0.2.4/0.2.5 |
| 6 | 群体模式下 App 仍显示 classic 字段/证书诊断 | 旧 UI 未按 `groupEnabled` 分支 | 主机客户端与 App 设备页按 group 模式重排 | host 0.1.21 / App build 3 |
| 7 | 配对后立刻 401（challenge 阶段） | 同一设备多次 challenge，单 nonce 被覆盖 | 允许同一设备多个未消费 challenge | relay 0.2.8（`e43b7cc`） |
| 8 | 首次进入白屏 401、返回再进正常 | 主机控制连接被替换时清空 relay 设备表，`device.sync` 到达前请求全 401 | 重连/替换不再清空设备表 | relay 0.2.9（`70e2256`） |
| 9 | 页面能开但「暂无会话 / 一直重新连接中」 | 主机 loopback 明文代理不处理 `Upgrade: websocket` | 新增 upgrade 代理（鉴权后交 `DshProxy.handleUpgrade`） | host 0.1.22（`147f14a`） |
| 10 | 刷新/进入跳到带地址栏的内嵌浏览器、手机布局消失 | 隧道 URL 带显式端口，`isTunnelUrl` 前缀匹配失败 → 当外链 | 按 hostname（忽略端口）判断隧道内 | App build 4（`a028f25`） |
| 11 | 配对后「重试才能进」、重试偶尔拿不到 token | App 会话获取并发/重复 challenge/token | 会话单飞 + 401/404/429/5xx 退避重试 | App build 3/5 |
| 12 | 旧连接设备已被删：一直 401/重试无意义 | relay 返回 `unknown_device`，旧 App 只显示泛化拒绝 | 明确提示「设备已在主机侧失效，请删除连接重新配对」；404 只短暂重试 | App build 5 |
| 13 | **配对后立刻 401，点重试又能进**（核心） | relay 隧道只处理连接上第一个 HTTP 请求；iOS keep-alive 复用连接，pairing 之后的 challenge 被透传到主机明文代理（无会话 cookie）→ 主机 401，且 relay 无日志 | 隧道化请求强制 `Connection: close`（WebSocket Upgrade 除外） | relay 0.2.13（`1104ff7`） |
| 14 | 主机设备列表一直显示「从未连接」 | 群体版没有 mTLS 握手，从未更新 `lastSeen` | 鉴权成功按 deviceId 更新 lastSeen（30s 节流） | host 0.1.23（`5f76547`） |
| 15 | 401 排障难：看不到请求是否到 relay | 边缘只记失败 | 增加 `edge: request` / `auth-path` / `tunnel` / `tls` 日志，最后把逐请求日志降回 debug | relay 0.2.10–0.2.14（`4622e6e`/`732968e`） |

## 1. 部署与环境问题

### 1.1 relay 容器启动失败：`cannot read config file "/data/config/relay.json": ENOENT`

- 现象：容器反复重启，日志只有 ENOENT。
- 根因：镜像只带代码，容器 `/data` 是空卷；文档之前假设手工挂 `relay.json`。
- 修复：`relay-entrypoint.sh` 在 group 模式下由环境变量自动生成 `/data/config/relay.json`
  （`RELAY_DOMAIN`、`data/certs/<domain>/`、`data/certs/wildcard/` 默认路径，可被
  `RELAY_TLS_*` / `RELAY_GROUP_EDGE_*` 覆盖；0600；已存在不覆盖），缺配置时给可操作报错。

### 1.2 `.env` 里写了 `RELAY_DOMAIN` 但容器看不到

- 根因：`docker compose` 默认只读同目录 `.env`；用户文件叫 `.env.group` 且 `up` 时没带
  `--env-file`；或 compose 里 `RELAY_DOMAIN: ${RELAY_DOMAIN}` 直接展开成空串。
- 修复：compose 改 `${RELAY_DOMAIN:?...}` 快速失败；README 明确 `.env` vs `--env-file`。

### 1.3 镜像/端口改了但行为没变

- 典型：`docker load` 了新 tag，`.env` 里 `DSH_RELAY_IMAGE` 还是旧 tag → `up` 仍用旧镜像；
  或改了 `*_HOST_PORT` 但旧 compose 文件里没有对应变量行 → 映射不生效（仍 0.0.0.0）。
- 处置：升级后必须同时改 tag 并 `--force-recreate`；用
  `docker inspect <container> --format '{{.Config.Image}}'` 和 `ss -lntp | grep <port>` 复核。

### 1.4 `relay control socket error`（主机连不上控制面）

- 根因：注册响应下发的 `controlUrl` 端口来自 `PUBLIC_CONTROL_PORT`，必须等于 nginx 实际
  listen 的公网端口；填成容器内部端口/宿主映射端口都会失败。
- 修复：文档强调端口语义；relay 0.2.6 增加 `POST /__group/refresh`（hostToken 鉴权、不消耗
  邀请码），主机插件「重试连接」/重启会自动同步最新 `mobilePort`/`controlUrl`。

## 2. 群体模式功能问题

### 2.1 邀请码 UX：只有 `inv_…` 的 ID，没法复制

- 根因：邀请码只存 SHA-256，后台无法展示。
- 修复：`group.json`（0600）改为明文存码；后台 UI 显示 `••••••••` + 复制按钮，新邀请只给
  「复制邀请码」；旧哈希邀请显示「旧邀请码（不可显示）」。

### 2.2 群体模式仍出现 classic 字段

- 修复：host 插件客户端与 App 均按 `groupEnabled` / `auth=token` 分支渲染：
  隐藏 relay/主机 token/TLS/mTLS 证书/APNs 字段，状态展示 group serviceUrl、controlUrl、
  hostId、fqdn、mobilePort、plainPort；App 设备页隐藏 mTLS 证书诊断，隧道地址带端口。

## 3. 鉴权链路问题（按出现顺序）

### 3.1 并发 challenge 覆盖 → token 401

- 现象：`challenge is missing, expired or mismatched`（手动用假 nonce 可复现）。
- 根因：relay 每个 `(hostId, deviceId)` 只存一个未消费 nonce，并发/重复 challenge 会覆盖。
- 修复：改为 `(hostId, deviceId, nonce)` 多维存储，允许多个未消费 challenge（各自 TTL），
  过期清理；新增回归测试：连续两次 challenge，用第一个 nonce 换 token 必须成功。

### 3.2 主机重连清空设备表 → 瞬时 401

- 现象：配对后首次进入白屏 401，返回再进正常；relay 日志出现 `synced 1 → 0 → 1`。
- 根因：控制连接被替换/短暂重连时 `removeHost` 清空 `groupAuth` 设备表，新 `device.sync`
  到达前所有边缘请求 401/404。
- 修复：重连/替换不再清空设备表（撤销仍走 `device.revoke`；主机侧逐请求检查设备存在，
  安全不放松）。

### 3.3 主机明文代理不代理 WebSocket 升级 → 页面空/一直重连

- 现象：页面能打开（HTTP 正常），但 DSH UI 显示「暂无会话」、底部一直「重新连接中」，
  且会触发 App 自动重载。
- 根因：群体版 loopback 明文代理只处理 HTTP；Node `http.Server` 对没有 `upgrade` 监听器的
  Upgrade 请求直接销毁 socket，DSH 的 `/api/remote.mux` 等实时通道全断。
- 修复（host 0.1.22）：`plainServer.on('upgrade')` → 同一套 Host 校验 + token 验签 + 设备在册
  检查后交给 `DshProxy.handleUpgrade`（复用 deny list、DSH cookie 注入、心跳代答）；
  e2e 测试覆盖「relay 边缘隧道 → 明文代理 → 101」。

### 3.4 旧设备连接：401/404 且无限重试

- 现象：主机删过旧设备后，App 仍用旧连接 `deviceId` 请求，relay 返回
  `404 unknown_device`（旧版本 UI 表现为泛化的 401 拒绝），点重试也没用。
- 修复（App build 5）：识别 `unknown_device`/404 → 明确提示「这台设备已在主机侧失效
  （被删除或重置），请返回主机列表删除该主机，用新二维码重新配对」；刚配对时 `device.sync`
  还没到 relay 的 404 只做一次短暂重试。

### 3.5 核心：keep-alive 连接复用 + 单请求隧道 → 配对后立刻 401，重试又能进

- 现象：配对完成立刻进入必现 `401`；错误页 URL 是 `/__group/auth/challenge`，响应体是
  **主机格式** `{"ok":false,"error":"unauthorized"}`（若带旧 cookie 则是 `unknown_device`），
  而 relay 日志里**没有** challenge 的 `edge: request` 记录；点「重试」新建连接后即可进入。
- 定位过程：
  1. 先排除网络：手机 Safari 直开同一 relay/端口拿到 405 JSON；relay 日志里 Wi-Fi/蜂窝
     都出现过正常 pairing，说明手机可达 relay；
  2. 对照 App 错误页新增的「响应体 + 响应头」（App build 6）：字符串 `error` 形态只有
     host 明文代理会产生；relay/API 的错误都是对象 `{code,message}`；
  3. relay 0.2.12 增加 TLS 连接级日志后确认：失败请求没有新建 TLS 连接，也没有 `edge: request`；
  4. 结合 iOS URLSession 默认 keep-alive：pairing 轮询 `/__dsh_remote/pair/status` 走的是
     relay 隧道——relay 在该连接上只解析第一个请求，之后 socket 原样交给主机；
     客户端复用同一连接发出的 challenge 就被透传到主机明文代理（无会话 cookie → 401）。
- 根因：边缘隧道「一条 TLS 连接只承载第一个 HTTP 请求」的假设与客户端 keep-alive 复用冲突。
- 修复（relay 0.2.13）：进入隧道前把请求头改写为 `Connection: close`（去掉
  `proxy-connection`/`keep-alive`），WebSocket Upgrade 请求保持原样；单测覆盖头改写与
  Upgrade 不破坏。修复后 challenge/token 落在两条新 TLS 连接上，配对后一次进入即成功。
- 教训：**「日志里没有」≠「请求没发出去」**；要区分「relay 没收到」与「relay 收到后原样
  转发给了主机」。协议代理类 bug 优先检查连接复用/keep-alive 语义。

## 4. App 侧问题

### 4.1 跳内嵌浏览器、手机布局消失

- 现象：页面内导航/刷新会打开 App 的内嵌浏览器（顶部「DeepSeek Harness」+ 地址栏），
  返回回到上一页；DSH 手机端布局（左侧抽屉覆盖、不挤压正文、点会话放大）全部消失。
- 根因：`isTunnelUrl` 用 `https://<host>/` 前缀匹配，群体版 URL 带显式端口
  （`https://<host>:<port>/...`）永远匹配失败 → 所有导航被当外链，交给内嵌浏览器
  （那里没有注入 `MOBILE_WEB_SHELL_JS`）。
- 修复（App build 4）：按 URL `hostname` 比较（忽略端口）；隧道内导航留在 DSH WebView，
  手机壳脚本恢复生效。

### 4.2 会话获取并发/重复

- 现象：进入主机时偶发 challenge/token 401，重进恢复。
- 修复（App build 3/5）：`ensureGroupSessionIfNeeded` 单飞（并发共享同一个 promise）；
  401/404/429/5xx/网络错误退避重试；404 只在刚配对窗口重试一次。

### 4.3 错误可观测性

- 修复（App build 6）：认证失败错误页附带原始响应体（≤512B）与关键响应头
  （server/via/www-authenticate/content-type），是本次定位「响应来自主机」的关键。

## 5. 观测性与日志

- relay 0.2.10：`/__group/*` 到达边缘即记 `edge: request`；
- 0.2.11：`edge: auth-path`（auth 分支命中）、`edge: tunnel`（业务流量放行路径）；
- 0.2.12：`edge: tls`（TLS 连接级，含 SNI）；此阶段用于定位，逐请求 info 很吵；
- 0.2.13：修复 keep-alive 后保留上述日志便于复测；
- 0.2.14：`edge: tls` / `edge: tunnel` 降回 debug，仅 `/__group/` 请求与失败保持
  info/warn，作为最终部署镜像。

## 6. 排查陷阱清单（本次踩过的坑）

1. `docker logs --since 2m` 窗口太短/容器刚重建会漏日志；先确认 `docker inspect` 的镜像 tag。
2. 改了 `DSH_RELAY_IMAGE` 不 `--force-recreate`，仍在跑旧容器。
3. relay 返回 404/401 的 JSON 形态与 host 明文代理不同：**relay 是对象**
   `{code,message}`，**host 是字符串** `{"ok":false,"error":"..."}`——可直接判断响应来源。
4. iOS `URLSession` 会复用 keep-alive 连接；「一条连接只处理一个请求」的隧道实现必须强制关闭。
5. iOS 卸载 App **不会清 Keychain/Secure Enclave 里的设备私钥**，重装后仍复用同一把 P-256 key
   （配对会重新上报公钥，不影响；需要彻底换 key 要走「重置设备密钥」）。
6. iOS 共享粘贴板里的录屏路径是临时目录，发送后很快被清理；且 `/Users/.../Library/Group
   Containers/...` 受 macOS 权限限制，代理可能读不到——需要先复制到 `~/Downloads` 等可读位置。
7. 手机 Wi-Fi 与蜂窝网络对照测试很有价值：本次 401 与网络无关，但「Wi-Fi 正常 / 蜂窝异常」
   这类对照能快速区分服务端与链路问题。
8. `docker compose` 默认只读 `.env`；文件名不同时必须 `--env-file`。
9. relay/主机同机部署时注意 classic 与 group 的端口让位（EDGE/CONTROL/HEALTH 改到 16xxx/18xxx，
   ★ 公网端口按 nginx 实际 listen 填）。
10. 调试日志分级：定位阶段逐请求 info 有助复现，正式部署前降回 debug（0.2.14）。

## 7. 最终验证与产物

- 真机验收：配对 → 立刻进入（无 401）→ 手机布局/会话放大/实时消息正常；切回 nginx 前置
  链路重新配对后正常进入（记录见 `dsh-remoteApp/docs/ACCEPTANCE.md`）。
- 测试：server `npm test` **195/195**；`npm run validate:artifacts` 通过；
  App `tsc --noEmit` / `check:native` / `check:shell` 通过；iOS Release 构建并真机安装。
- 最终镜像：`dsh-remote-relay:0.2.14-group`（tar 随 `server/` 发布，sha256 见交付说明）。
- 关键提交：relay 0.2.8/0.2.9/0.2.13/0.2.14、host-plugin 0.1.22/0.1.23、App 群体版（`a028f25`）。

## 8. 已知限制 / 后续

- Android 尚未编译验证（本次真机验收仅 iOS）；
- 服务端推送（APNs）按设计文档后续接入；
- iOS 原生无法把 App 注入的会话 cookie 设为 HttpOnly（依赖 relay `Set-Cookie`，已在设计文档标注）；
- relay 日志如需长期排查可临时把 `RELAY_LOG_LEVEL` 设为 debug（0.2.14 起逐请求日志在 debug）。
