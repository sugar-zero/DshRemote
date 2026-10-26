# dsh-remote-service 接口契约（v0.1 / POC）

两类接口，**不要混用**：

1. **本机管理 API**：注册在 DSH 本机 webServer 上，前缀 `ADMIN_BASE = /api/remote-access`。只有本机已认证浏览器（DSH 浏览器 cookie）可访问；远程代理必须 deny。
2. **远程隧道 API**：只存在于主机插件的 TLS 监听（`ADMIN` 之外的独立端口，默认 `127.0.0.1:0`），经 relay 暴露为 `https://<hostId>.<relayDomain>/`。除配对路径外**全部要求设备客户端证书（mTLS）**。

响应统一信封：
```json
{ "ok": true, "data": { } }
{ "ok": false, "error": { "code": "string", "message": "string" } }
```

## 1. 本机管理 API（`/api/remote-access`）

鉴权：`ctx.connection.requestRejection(req)` 未通过时返回 401/403。

### GET `/status`
```json
{
  "ok": true,
  "data": {
    "version": "0.1.0",
    "enabled": true,
    "relay": { "url": "wss://relay.example.com:8443", "connected": true, "lastError": null },
    "host": {
      "id": "h_ab12cd34",
      "name": "Example Mac",
      "fingerprint": "<base64url sha256(hostPublicKey)>",
      "publicKey": "<base64url Ed25519 raw>",
      "domain": "h_ab12cd34.relay.example.com",
      "tls": { "certFile": "/path/fullchain.pem", "subject": "CN=...", "notAfter": "2026-12-01T...", "valid": true }
    },
    "pairing": {
      "active": true,
      "pairingId": "p_xxx",
      "expiresAt": 1799999999000,
      "requiresApproval": true,
      "uri": "dshremote://pair?v=1&host=...",
      "code": "K7QM3F9DT2XA",
      "sas": null
    },
    "devices": [ { "id": "d_xxx", "name": "iPhone 15 Pro", "platform": "ios", "createdAt": 0, "lastSeenAt": 0, "revokedAt": null } ],
    "listenPort": 51234,
    "push": {
      "provider": "apns",
      "enabled": true,
      "configured": false,
      "tokens": 0,
      "error": null,
      "warnings": ["APNs 私钥路径（apnsKeyFile）未配置"]
    },
    "config": {
      "enabled": true,
      "relayUrl": "wss://relay.example.com:8443",
      "relayDomain": "relay.example.com",
      "hostId": "h_ab12cd34",
      "publicPort": 0,
      "hostName": "Example Mac",
      "requireApproval": true,
      "pushEnabled": true,
      "pushCooldownSeconds": 30,
      "pushProvider": "apns",
      "apnsKeyFile": "/path/AuthKey_<KEY_ID>.p8",
      "apnsKeyId": "<KEY_ID>",
      "apnsTeamId": "<TEAM_ID>",
      "apnsTopic": "com.example.dshremote",
      "apnsEnvironment": "auto",
      "maxRequestBytes": 268435456,
      "relayTlsInsecure": false,
      "listenPort": 0,
      "tlsCertFile": "configured",
      "tlsKeyFileConfigured": true,
      "hostTokenConfigured": true,
      "denyPrefixes": ["/connect"]
    }
  }
}
```

### POST `/config`
Body（全部可选，只改传入字段）：
```json
{
  "enabled": true,
  "relayUrl": "wss://relay.example.com:8443",
  "hostId": "h_ab12cd34",
  "publicPort": 0,
  "hostToken": "<relay host token>",
  "relayTlsInsecure": false,
  "tlsCertFile": "/path/fullchain.pem",
  "tlsKeyFile": "/path/privkey.pem",
  "requireApproval": true,
  "hostName": "Example Mac",
  "pushEnabled": true,
  "pushCooldownSeconds": 30,
  "pushProvider": "apns",
  "apnsKeyFile": "/path/AuthKey_<KEY_ID>.p8",
  "apnsKeyId": "<KEY_ID>",
  "apnsTeamId": "<TEAM_ID>",
  "apnsTopic": "com.example.dshremote",
  "apnsEnvironment": "auto",
  "maxRequestBytes": 268435456
}
```
`pushProvider`：`apns`（默认，自托管直连 Apple）或 `expo`（旧版经 relay）。
自托管 APNs 的通知标题/正文取自实际会话（会话标题 + 本轮助手回复摘要，截断），不再支持
配置固定标题/正文。
`apnsEnvironment`：`auto`（默认，按设备注册时上报的 `aps-environment`）/ `development` / `production`。
`apnsKeyFile` 只接受本机路径，私钥内容永远不会通过 API 下发。
返回同 `/status`。

### POST `/pairing/start`
创建设备配对会话（120s、单次），返回 `{ pairingId, uri, code, expiresAt, requiresApproval }`。
### POST `/pairing/cancel`
取消活跃配对会话。
### POST `/pairing/approve`
```json
{ "pairingId": "p_xxx", "approve": true }
```
桌面确认配对（`requireApproval: true` 时必需）。
### GET `/pairing/qr.svg`
返回当前活跃配对 URI 的 SVG 二维码（`image/svg+xml`；无活跃会话 409）。
### GET `/devices`
### POST `/devices/:id/revoke`
撤销设备（立即断链 + 拒绝续期）。

### POST `/devices/:id/delete`
删除一条**已撤销**设备记录（桌面设备列表清理；同时清理该设备的推送 token）。
仍有效的设备必须先 `revoke` 再删除：对未撤销设备返回 409 `device-active`；未知设备 404
`device-not-found`。成功返回 `{ ok:true, data:{ device: <被删除记录> } }`（审计
`device-delete`）。
### GET `/audit?limit=100`
最近审计条目：`{ ts, deviceId, action, resource, result, hash }`（无正文）。

## 2. 远程隧道 API（主机插件 TLS 监听，经 relay 访问）

除 `/__dsh_remote/pair*` 外，所有请求都必须携带由主机设备 CA 签发的客户端证书；校验失败 403。

### POST `/__dsh_remote/pair`（允许无客户端证书）
Body：
```json
{ "secret": "<base64url 一次性密钥>", "csrPem": "-----BEGIN CERTIFICATE REQUEST-----...", "deviceName": "iPhone 15 Pro", "platform": "ios" }
```
成功且无需审批：
```json
{ "ok": true, "data": { "status": "paired", "deviceId": "d_xxx", "certPem": "...", "caPem": "...", "hostName": "Example Mac", "hostFingerprint": "..." } }
```
需要桌面确认时返回 `{ "status": "pending", "ticket": "..." }`，App 轮询：

### GET `/__dsh_remote/pair/status?ticket=...`
`{ "status": "pending" | "paired" | "denied" | "expired", ...同 paired 字段 }`

### POST `/__dsh_remote/push-token`（要求 mTLS）

自托管 APNs（默认）：

```json
{ "provider": "apns", "token": "<64 位十六进制 APNs device token>", "environment": "development" | "production" }
```

- `environment` 可省略（主机按 `production` 兜底）；开发签名包应为 `development`（sandbox），
  发布签名包为 `production`。主机据此选择 `api.sandbox.push.apple.com` / `api.push.apple.com`。
- 400 错误码：`invalid-token`（非 64 位 hex）、`invalid-environment`、`unsupported-provider`。
- 旧版 Expo 通道兼容：`{ "provider": "expo", "token": "ExponentPushToken[...]" }`。

### GET `/__dsh_remote/status`（要求 mTLS）
返回主机状态（App 诊断页用，不含敏感内容）：
```json
{ "ok": true, "data": {
  "hostId": "h_xxx", "hostName": "Example Mac", "domain": "h_xxx.relay.example.com",
  "tls": { "subject": "CN=h_xxx.relay.example.com", "notAfter": "2026-..." , "dev": false, "valid": true },
  "relayConnected": true, "version": "0.1.16",
  "restart": { "enabled": false },
  "devices": { "total": 2, "active": 1 }
} }
```

### GET `/__dsh_remote/audit?limit=N`（要求 mTLS）
返回最近安全审计（设备认证/配对/撤销等事件；`limit` 1–200，默认 50）：
```json
{ "ok": true, "data": { "entries": [
  { "ts": 0, "action": "device-auth", "result": "ok", "deviceId": "d_xxx" }
] } }
```

### GET `/__dsh_remote/devices`（要求 mTLS）
返回已配对设备列表（App 设备管理用）：
```json
{ "ok": true, "data": { "devices": [
  { "id": "d_xxx", "name": "iPhone 15 Pro", "platform": "ios", "serial": "01...",
    "createdAt": 0, "lastSeenAt": 0, "revokedAt": null, "current": true }
] } }
```
`current` 表示发起请求的这台设备（按客户端证书 serial 匹配）。

### POST `/__dsh_remote/devices/:id/revoke`（要求 mTLS）
撤销指定设备（立即断链、拒绝续期）。返回 `{ ok:true, data:{ device } }`；未知设备 404。
> 说明：被撤销的设备无法再通过 mTLS 校验；当前请求仍会完成。设备列表/撤销也可在桌面 DSH 管理 API 操作。
> 删除设备记录目前只在**本机管理 API**（`POST /api/remote-access/devices/:id/delete`）开放，远程隧道不提供。

### POST `/__dsh_remote/restart`（要求 mTLS，host-plugin 0.1.16+；受 `restartHostEnabled` 组件开关控制，默认关闭）
远程触发**主机 DSH 客户端**重启（App「重启主机」入口，用于更新 Host/Client 半后不必回电脑
手动重启）。请求无 body；主机先回 202，再在约 1s 后结束当前 DSH 进程并重新拉起：
```json
{ "ok": true, "data": { "restarting": true, "mode": "mac-app" } }
```
`mode` 表示当前 Host 的重启方式：

| mode | 场景 | 重启目标与重新拉起方式 |
|---|---|---|
| `desktop-app` | DSH 桌面端（Electron shell + host 子进程） | 结束**整个 DSH 应用进程组**（shell 为组长）→ macOS `open -n <...app>` / Windows `start "" "<exe>"`（best-effort） |
| `node` | Node CLI（例如 `dsh web`） | 结束当前进程 → `execPath` + 原 `argv.slice(1)` 原样重新拉起 |

错误：
- **405** `method-not-allowed`：非 POST；
- **501** `host-restart-unavailable`（旧监听/未注入）、`host-restart-unsupported`（环境不支持，
  如 Linux Electron、执行文件不在 `.app` 内；`message` 给可读原因）、`host-restart-disabled`
  （组件开关关闭，或 `DSH_REMOTE_DISABLE_HOST_RESTART=1`，供测试/CI 防误重启）；
- **500** `host-restart-spawn-failed`：无法启动重启 helper（调度失败）。

安全说明：
- 认证与其它 `/__dsh_remote/*` 完全一致：**只认设备 mTLS 客户端证书**，没有额外 token；
  配对设备本来就能经隧道完整操作主机 DSH（Web UI/WS），远程重启**不是新的提权面**；
- 只结束当前 DSH 进程：不碰 relay / 系统服务 / `~/.dsh` 数据；重新拉起的进程继承当前工作
  目录与环境变量，不做提权；
- 重启 helper 是 detached shell：先等 ~1s 让 202 响应发完 → 桌面端**直接 `SIGKILL` 浏览器主进程
  （shell）**，再整组 `SIGKILL` 清理 renderer/utility/host（**不能先 SIGTERM**：Electron 的优雅
  关闭会先杀 renderer，shell 的崩溃处理会弹「应用无法启动或已意外停止」对话框，0.1.10–0.1.12
  的失败就是这个），CLI 模式只结束当前进程 → 确认旧实例退出后等 ~2.5s（让端口释放）→ 重新拉起；
  helper 用 `stdio: ignore` + `unref`，自成进程组，不会被自己结束的 DSH 进程树带走；
- **组件开关**：管理配置 `restartHostEnabled`（默认 `false`）。关闭时**一律 501 `host-restart-disabled`**，
  不调度 helper、不杀进程（审计 `host-restart/failed/hash=disabled`）；App 通过设备
  `GET /__dsh_remote/status` 的 `data.restart.enabled` 决定是否显示顶栏 ⏻（旧版 Host 无该字段时按启用处理）；
- 只在确认旧实例退出后才拉起新实例：两个 DSH 同时启动会互相抢端口（桌面端会直接崩）；
- **硬杀会留下 Electron 单实例锁**（`SingletonLock/Cookie/Socket` 指向已死 pid）：不清理的话新实例
  会在启动 ~100ms 内误判「已有实例」直接退出（表现就是「主机被关掉、没被拉起来」）。helper 会在
  拉起前清理属主已死的陈旧锁（属主仍存活则不动），然后 `open -n` 拉起、并用 `ps` 校验应用真的在跑；
  校验失败则兜底直接执行 `.app` 内可执行文件（清掉 `ELECTRON_RUN_AS_NODE`/IPC 环境变量）；
- helper 日志（不含凭据）：`~/.dsh/remote-access/host-restart.log`，记录启动/杀进程/清理/拉起结果，
  排查「关掉但没拉起来」时直接看这里；
- 为什么桌面端不能只杀 host 子进程：插件运行在 Electron shell 派生的 host 子进程里，只杀它会
  触发 shell 的「应用无法启动或已意外停止」崩溃对话框，等同失败；
- 桌面端判定：Electron 运行时 + argv 里出现 `@deepseek-ai/dsh-desktop-host/lib/index.js` 入口
  （或用 `DSH_DESKTOP_NODE_EXECUTABLE` 标记的启动器）+ POSIX 下父进程就是同一个 Electron
  可执行文件；判不出来的环境返回 501（edition 0.1.10/0.1.11 的旧判定会一律 501，已修）；
- 10s 内的重复请求去重（第二次直接回 202 + 上次 `mode`，不再调度第二次）；
- 审计（`audit.jsonl`）：每次请求一条 `{ deviceId, action: "host-restart", result: "accepted" | "failed" }`，
  `hash` 标记实际 mode / `deduped` / 错误码，可在 `GET /__dsh_remote/audit` 查看；
- Windows 的 kill/拉起为 best-effort（`taskkill /F` + `start`），失败不保证自动恢复；
- supervisor 托管（launchd `KeepAlive` / systemd `Restart=`）的 `dsh web`：supervisor 也会自动
  拉起，可能与 helper 的重新拉起短暂竞争（多起的实例因端口占用退出）；这类部署建议在
  supervisor 层重启（`launchctl kickstart -k` / `systemctl restart`）。

### 其余路径
全部反代到本机 DSH Web 服务（`http://127.0.0.1:<webServer.port>`），并：
- 剥离 `Cookie / Authorization / Host / Origin / Forwarded / X-Forwarded-* / X-Real-IP / Sec-Fetch-*`；
- 固定 `Host: 127.0.0.1:<port>`；
- 注入主机插件在进程内换到的 DSH 浏览器 session cookie；
- **deny**：`/connect`、`/oauth/*`、`/__dsh_remote/*`（内部路径自身处理）、`/api/remote-access/*`、以及配置的额外 deny 前缀（open-in-app 等本机副作用路由）；
- WebSocket upgrade 同样校验 mTLS、重写 Host/Origin。

## 3. 配对二维码 URI

```
dshremote://pair?v=1&host=<hostId>.<relayDomain>&secret=<base64url 32B>&hostfp=<base64url sha256(hostPub)>&exp=<unix 秒>&relay=<relayDomain>
```
- `secret` 必须单次、≤120s；`hostfp` 是**完整**指纹（短指纹只做屏幕人工对照）。
- 桌面管理 UI 显示 12 位备用码（Crockford base32）与 SAS；App 扫码后做 HMAC 挑战并提交 CSR。
