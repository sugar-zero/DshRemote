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
    "config": {
      "enabled": true,
      "relayUrl": "wss://relay.example.com:8443",
      "relayDomain": "relay.example.com",
      "hostId": "h_ab12cd34",
      "hostName": "Example Mac",
      "requireApproval": true,
      "pushEnabled": true,
      "pushCooldownSeconds": 30,
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
  "hostToken": "<relay host token>",
  "relayTlsInsecure": false,
  "tlsCertFile": "/path/fullchain.pem",
  "tlsKeyFile": "/path/privkey.pem",
  "requireApproval": true,
  "hostName": "Example Mac",
  "pushEnabled": true,
  "pushCooldownSeconds": 30,
  "maxRequestBytes": 268435456
}
```
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
Body：`{ "provider": "expo" | "apns" | "fcm", "token": "..." }`

### GET `/__dsh_remote/status`（要求 mTLS）
返回主机状态（App 诊断页用，不含敏感内容）：
```json
{ "ok": true, "data": {
  "hostId": "h_xxx", "hostName": "Example Mac", "domain": "h_xxx.relay.example.com",
  "tls": { "subject": "CN=h_xxx.relay.example.com", "notAfter": "2026-..." , "dev": false, "valid": true },
  "relayConnected": true, "version": "0.1.0",
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
