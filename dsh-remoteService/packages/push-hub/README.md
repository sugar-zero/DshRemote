# dsh-remote-push-hub —— 官方推送 hub（群体服务版 · 选项 2，0.3.3 = R2-only）

由项目所有者部署/运营的中央推送服务：用**官方 App 的 APNs Auth Key** 发送**固定通用文案**，
不接收会话内容。**官方推送与部署方 relay 彻底解耦**——hub 不识别 relay，也不接受任何 relay
凭据或 relay 转发：

```
官方 App ──HTTPS──► hub /v1/enroll/challenge + /v1/enroll（P-256 PoP 验签）──► 签发 device credential
主机插件 ──HTTPS──► hub /v1/push（Authorization: Bearer <deviceCredential>）──► APNs（通用/可选摘要）
```

- 契约：[`docs/group-push-r2-contract.zh.md`](../../../docs/group-push-r2-contract.zh.md) §4/§4.5
- 零第三方依赖（只依赖 workspace 包 `dsh-remote-apns` / `dsh-remote-protocol`），Node.js >= 22
- 部署模板：[`server/docker-compose.push-hub.yml`](../../../server/docker-compose.push-hub.yml)、
  [`server/.env.push-hub.example`](../../../server/.env.push-hub.example)、
  [`server/nginx/push-hub-http.conf`](../../../server/nginx/push-hub-http.conf)

## 1. 安全边界（硬约束）

1. **默认不接收会话内容**：推送 schema 只允许 `kind` / `host` / `token` / `environment`；
   用户开启主机侧「详细推送内容」后，可选 `title`/`body`（必须成对，≤60/160 字，禁止控制字符）；
   可选 `sessionId`（≤128 字，用于点通知直达会话，opaque、不写日志）；旧的 `tokens` 数组或
   任何其它未知字段仍直接 `400 invalid_request`。
   `title`/`body` 不写日志；关闭时只发通用文案。
   文案在 hub 侧固定（`turn-end` → DSH「任务已完成」；`waiting-answer` → DSH「正在等待你的回答」）。
2. **device credential 由 hub 的 Ed25519 key 签发**：claims 绑定 `tokenHash + hostId + env +
   bundleId + aud(HUB_PUBLIC_URL) + exp`；签名 key 只在部署方数据卷（默认 `/data`，0600），
   首次启动自动生成。
   过期/被换 key 后 credential 自然失效，App 重新登记即可。
3. **hub 不识别 relay**：没有 relay 凭据、没有 hub 侧凭据库（store）、没有 relay 转发通道；
   `POST /v1/push` 只接受 device credential，Bearer 不是合法 credential → `401 invalid_credential`。
4. **鉴权只认 `Authorization: Bearer <deviceCredential>`**：**不信任来源 IP / `X-Forwarded-*` /
   自定义头 / 查询参数**。credential 的 `aud` 与 `bundleId` 必须匹配本 hub（防拿别的 hub 的
   credential 来用）。
5. **设备 token / credential 不落盘、不写日志**：日志只有模式、条数、结果、耗时；
   `/healthz` 只有能力开关、`topic` 与配额默认值。
6. **APNs 私钥 / 签名私钥**只从只读挂载（或内联配置）读取一次，不打印、不进日志、
   不进 `/healthz`、不进推送 payload。
7. **限流（内存滑动窗口）**：每 token 6/分钟 + 120/天、每 credential 6/分钟、每 host 30/分钟、
   每 IP 60/分钟、全局 120/分钟；enroll 每 IP 20/小时、每设备 5/小时、challenge 每 IP 60/小时。
   超限 `429 + Retry-After`；请求体上限 16KB。

## 2. 配置

两种来源可混用（环境变量覆盖配置文件；命令行 `--port/--listen-host/--log-level` 覆盖二者）。
**相对路径**：配置文件内按配置文件目录解析；环境变量内按进程 cwd 解析。

### 2.1 `hub.json`（可选）

```json
{
  "listenHost": "0.0.0.0",
  "port": 9445,
  "tls": null,
  "apns": {
    "keyFile": "/data/apns/AuthKey_<KEY_ID>.p8",
    "keyId": "<KEY_ID>",
    "teamId": "<TEAM_ID>",
    "topic": "<OFFICIAL_BUNDLE_ID>"
  },
  "publicUrl": "https://push.example.com",
  "signingKeyFile": "/data/push-hub-signing-key.pem",
  "credential": { "ttlDays": 30 },
  "enroll": { "enabled": true, "challengeTtlSeconds": 120 },
  "limits": {
    "maxTokensPerRequest": 20,
    "enrollPerHourPerIp": 20,
    "enrollPerHourPerDevice": 5,
    "challengePerHourPerIp": 60,
    "pushPerMinutePerToken": 6,
    "pushPerDayPerToken": 120,
    "pushPerMinutePerCredential": 6,
    "pushPerMinutePerHost": 30,
    "pushPerMinutePerIp": 60,
    "pushPerMinuteGlobal": 120
  },
  "logLevel": "info"
}
```

- `tls` 可省略：生产由前置 nginx 终止 TLS，hub 只听容器内 `0.0.0.0:9445`（宿主发布到回环）。
  也可给 `tls = {certFile,keyFile}` 或内联 `{cert,key}`（PEM 文本）让 hub 自己跑 HTTPS。
- `apns` 可省略：未配置时推送返回 `503 push_unavailable`、`/healthz` 显示
  `apns.configured=false`；但「配一半」（有 key 无 keyId 等）会在启动前直接报错。
- **`publicUrl` 是 R2 的总开关**：必须是 https 绝对地址（默认空 = 不启用设备直连：
  `/v1/enroll*` 与 credential 推送一并返回 503）。它就是 credential 的 `aud`，应与 nginx
  域名/App 打包内置的 hub 地址一致。
- `signingKeyFile` 默认在 baseDir（有配置文件时即配置文件目录；纯环境变量模式为 cwd）下的
  `push-hub-signing-key.pem`（容器内 `/data/push-hub-signing-key.pem`），**不存在则首次启动
  自动生成**（0600）；不要删（删了已发 credential 全失效）。
- `credential.ttlDays` 默认 **30 天**（0.3.1 起；原 7 天）；`enroll.enabled` 默认 true（紧急止损可关）。
- 没有 `store` 段：hub 无可写状态库，device credential 是自包含 JWT。

### 2.2 `HUB_*` 环境变量（compose 用）

| 变量 | 默认 | 说明 |
|---|---|---|
| `HUB_LISTEN_HOST` | `127.0.0.1` | 监听地址；容器内用 `0.0.0.0`（端口发布到宿主回环） |
| `HUB_PORT` | `9445` | 端口；`0` = 临时端口（测试） |
| `HUB_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` |
| `HUB_TLS_CERT_FILE` / `HUB_TLS_KEY_FILE` | — | 可选：hub 自己跑 HTTPS（否则由 nginx 终止） |
| `HUB_APNS_KEY_FILE` | — | 官方 APNs `.p8` 路径（与内联 `apns.privateKey` 二选一） |
| `HUB_APNS_KEY_ID` | — | Apple Key ID（10 位字母数字） |
| `HUB_APNS_TEAM_ID` | — | Apple Team ID（10 位字母数字） |
| `HUB_APNS_TOPIC` | — | 官方 App bundle id（推送 topic，也是允许登记的 bundleId） |
| `HUB_PUBLIC_URL` | `''` | **R2 必填**：credential 的 aud；空 = 不启用设备直连 |
| `HUB_SIGNING_KEY_FILE` | `<baseDir>/push-hub-signing-key.pem` | Ed25519 签名 key（0600，自动生成） |
| `HUB_CREDENTIAL_TTL_DAYS` | `30` | device credential 有效期（1..90 天；0.3.1 起默认 30） |
| `HUB_ENROLL_ENABLED` | `true` | 是否启用 `/v1/enroll*` |
| `HUB_ENROLL_CHALLENGE_TTL_SECONDS` | `120` | challenge/nonce TTL（10..900 秒） |
| `HUB_MAX_TOKENS_PER_REQUEST` | `20` | 预留：每请求 token 上限（R2 每次只推 1 个 token） |
| `HUB_ENROLL_PER_HOUR_PER_IP` | `20` | enroll：每 IP 每小时 |
| `HUB_ENROLL_PER_HOUR_PER_DEVICE` | `5` | enroll：每设备（tokenHash）每小时 |
| `HUB_CHALLENGE_PER_HOUR_PER_IP` | `60` | challenge：每 IP 每小时 |
| `HUB_PUSH_PER_MINUTE_PER_TOKEN` | `6` | push：每 token 每分钟 |
| `HUB_PUSH_PER_DAY_PER_TOKEN` | `120` | push：每 token 每天 |
| `HUB_PUSH_PER_MINUTE_PER_CREDENTIAL` | `6` | push：每 credential 每分钟 |
| `HUB_PUSH_PER_MINUTE_PER_HOST` | `30` | push：每 host 每分钟 |
| `HUB_PUSH_PER_MINUTE_PER_IP` | `60` | push：每来源 IP 每分钟（nginx 后是共享桶） |
| `HUB_PUSH_PER_MINUTE_GLOBAL` | `120` | push：全局兜底 |
| `HUB_CONFIG` | — | 可选：`hub.json` 路径（不设 = 纯环境变量模式） |

## 3. CLI

只有一个 `serve`（不需要任何 relay 凭据管理命令）：

```bash
# 启动（默认命令；配置来自 --config 或 HUB_* 环境变量）
node packages/push-hub/bin/push-hub.js serve --config /data/config/hub.json

# 帮助 / 版本
node packages/push-hub/bin/push-hub.js --help
node packages/push-hub/bin/push-hub.js --version
```

退出码：成功 0；参数/配置错误 1。设备凭据由设备自己向 `/v1/enroll*` 登记获取，
运维侧没有「发 token」这一步。

## 4. HTTP API

### `GET /healthz`

```json
{
  "ok": true,
  "apns": { "configured": true, "topic": "<OFFICIAL_BUNDLE_ID>" },
  "credential": { "enabled": true, "ttlDays": 30 },
  "enroll": { "enabled": true },
  "limits": { "maxTokensPerRequest": 20, "pushPerMinutePerToken": 6, "...": "..." }
}
```

不含 token、密钥、credential、任何标识或文件路径。`credential.enabled=false` 表示设备直连
未启用（`HUB_PUBLIC_URL`/APNs/签名 key 之一缺失）；`enroll.enabled=false` 另可能是
`HUB_ENROLL_ENABLED=false`。

### 4.1 `POST /v1/enroll/challenge`

```http
POST /v1/enroll/challenge
Content-Type: application/json

{ "devicePublicKey": "<base64url 65B P-256 未压缩点>" }   // 可选
```

成功：`{ ok:true, challengeId, nonce, expiresAt }`（challengeId 22 字符、nonce 43 字符、
TTL 默认 120s、一次性、只在内存）。

### 4.2 `POST /v1/enroll`

```http
POST /v1/enroll
Content-Type: application/json

{
  "challengeId": "<challengeId>",
  "nonce": "<nonce>",
  "devicePublicKey": "<base64url 65B P-256 未压缩点>",
  "hostId": "h_ab12cd34",              // 可选
  "token": "<64 位小写 hex APNs token>",
  "environment": "production",          // development | production
  "bundleId": "<OFFICIAL_BUNDLE_ID>",   // 必须 = hub 的 apns.topic
  "signature": "<base64url ECDSA-SHA256 DER>"
}
```

`signature` 是对协议包 `pushEnrollMessage(...)` 生成字节的签名（UTF-8、`\n` 连接、无末尾换行）：

```
dshremote-push-enroll-v1
<challengeId>
<nonce>
<devicePublicKey>
<hostId>
<token>
<environment>
<bundleId>
```

成功返回（credential 只在这里出现一次，App 存 SecureStore）：

```json
{
  "ok": true,
  "credential": "<EdDSA JWT>",
  "expiresAt": 1794000000000,
  "hub": { "endpoint": "https://push.example.com", "topic": "<OFFICIAL_BUNDLE_ID>" }
}
```

credential claims：`v=1, typ="dsh-push-device", tokenHash, env, bundleId, hostId?, aud,
jti, iat, exp`；header：`{alg:"EdDSA", typ:"JWT", kid:"<16 chars>"}`。

### 4.3 `POST /v1/push`

只接受 device credential（主机直连）：

```http
POST /v1/push
Authorization: Bearer <deviceCredential>
Content-Type: application/json

{ "kind": "waiting-answer", "host": "h_ab12cd34.relay.example.com", "token": "<64 hex>", "sessionId": "s_ab12cd34" }
# 可选（主机「详细推送内容」开启时）：
# { "kind": "error", "host": "...", "token": "<64 hex>", "title": "清理缓存", "body": "部署步骤超时", "sessionId": "s_ab12cd34" }
```

`environment` 可省略（以 credential 的 `claims.env` 为准）；提供时必须与之一致。
成功：`{"ok":true,"delivered":1,"failed":0,"pruned":["<token>"],"mode":"device"}`。
`pruned` 是 APNs 410/Unregistered 的 token（主机负责删除该设备 token）。

Bearer 缺失、不是三段式 JWT、签名/typ/aud/bundleId 不匹配、tokenHash 不一致……一律 401；
hub 不认识任何 relay 凭据（旧式 relay token 也按 `invalid_credential` 拒绝）。

### 4.4 错误码

| HTTP | code | 场景 |
|---|---|---|
| 401 | `invalid_credential` | 缺 Bearer / credential 签名/typ/aud/字段非法、alg 非 EdDSA、Bearer 不是 credential |
| 401 | `credential_expired` | credential 过期（App 重新登记） |
| 401 | `token_mismatch` | body.token 与 credential 的 tokenHash 不一致 |
| 400 | `invalid_request` | 非 JSON / 字段不合法 / title 与 body 未成对或超长 / sessionId 超长 / tokens 等多余字段 |
| 413 | `invalid_request` | 请求体超过 16KB |
| 400 | `unsupported_bundle_id` | bundleId 不是本 hub 的 `apns.topic` |
| 400 | `challenge_expired` / `challenge_used` | enroll：challenge 过期/未知/已用（重新申请） |
| 400 | `invalid_signature` | enroll：nonce 不一致或设备 PoP 签名失败 |
| 429 | `rate_limited` | 命中任一层限流（响应带 `Retry-After` 秒数） |
| 503 | `push_unavailable` | APNs 未配置 / 设备直连未启用 |
| 503 | `enroll_disabled` | `/v1/enroll*` 未启用（或缺 `HUB_PUBLIC_URL`/APNs/签名 key） |
| 500 | `internal` | 内部错误（响应不回显异常细节；详情只进脱敏日志） |

响应头：`content-type: application/json; charset=utf-8`、`cache-control: no-store`。

> 设计取舍：credential 是自包含 JWT（aud 绑定 `HUB_PUBLIC_URL`），hub 不需要任何服务端会话
> 状态或凭据库；撤销靠 TTL（默认 30 天）+ 轮换签名 key。

## 5. 部署（Docker + nginx）

```bash
# server/ 目录下
cp .env.push-hub.example .env.push-hub   # 填 HUB_PUBLIC_URL / HUB_APNS_KEY_DIR / KEY_ID / TEAM_ID / TOPIC
mkdir -p data/push-hub && chown -R 100:101 data/push-hub
docker compose --env-file .env.push-hub -f docker-compose.push-hub.yml up -d --build

# 自检
curl -fsS http://127.0.0.1:19445/healthz
```

- hub 只发布到宿主 `127.0.0.1:19445`；公网入口是 nginx `443`（示例：
  [`server/nginx/push-hub-http.conf`](../../../server/nginx/push-hub-http.conf)，域名示例
  `push.example.com`，反代 `/v1/push`、`/v1/enroll`、`/v1/enroll/challenge`）。
- APNs `.p8` 只读挂载到容器 `/data/apns`；`/data` 卷只需持久化
  `push-hub-signing-key.pem`（Ed25519 签名 key，0600，首次启动自动生成）。
- **不需要任何 relay 配置**：官方 App 内置 hub 地址后自己登记，主机拿到 credential 直连推送；
  部署方 relay 既不需要 token，也没有转发通道。
- **离线镜像**（已在本机构建/导出，2026-11-08，linux/amd64）：`server/dsh-push-hub-0.3.2-linux-amd64.tar`
  （62,636,032 bytes，sha256 `10bf282d651598b78b9552db9a83402e9325f828d4c4ea3f19906f3760f8422b`）。0.3.3 = R2-only + 可选 title/body 摘要 + error 通用文案 + TTL 30 天；服务器上
  `docker load -i dsh-push-hub-0.3.2-linux-amd64.tar` 后 `up -d --no-build` 即可；
  镜像内默认 `HUB_LISTEN_HOST=0.0.0.0` / `HUB_PORT=9445` / `HUB_SIGNING_KEY_FILE=/data/push-hub-signing-key.pem`。

## 6. 运维

- **健康**：`curl -fsS http://127.0.0.1:19445/healthz`；`apns.configured=false` 说明 `.p8`
  路径/权限/字段不对；`credential.enabled=false` 说明设备直连未启用（看日志里的原因）。
- **日志**：只记 `mode=device`、kind、条数、结果、耗时；不会出现设备 token / credential / 私钥。
- **签名 key 轮换**：停 hub → 备份旧 key → 删 `/data/push-hub-signing-key.pem` → 启动
  （新 key 生成；已签发的 credential 全部失效，App 会重新登记）。
- **关闭设备直连（紧急止损）**：`HUB_ENROLL_ENABLED=false`（停止新登记）或删 `HUB_PUBLIC_URL`
  （enroll 与 credential 推送一并停用）。
- **备份**：`/data` 卷里的签名 key（按敏感文件对待，0600/0700）。
- **升级**：重建镜像重启容器即可；credential claims `v: 1` 向后兼容。

## 7. 测试

```bash
cd dsh-remoteService
node --test packages/push-hub/test/*.test.js
```

全部使用**随机端口 + 临时目录 + 假 APNs client + 临时签名 key**，覆盖：
- 配置校验（R2 字段/publicUrl/配额/密钥不落错误信息；`store`、per-relay 配额等旧字段被拒）；
- 设备登记：challenge TTL/一次性/过期、P-256 PoP 验签、bundleId 校验、credential claims；
- 直连推送：credential 过期/aud/typ/bundleId/tokenHash 校验、各层限流 429、pruned 透传、
  body 16KB 上限、日志不落 token/credential；
- `/v1/push` 只认 device credential（缺 Bearer / 旧式 relay token / 伪 JWT 一律 401）；
- `/healthz` 能力/配额摘要不含敏感信息，也没有 relay 相关字段。

## 8. 版本

`0.3.0`（R2-only：官方 App 设备登记 + 主机直连推送；不再有 relay 凭据/store/relay CLI），
对应 `docs/group-push-r2-contract.zh.md` §4/§4.5 与 protocol 0.3.2。
许可证：AGPL-3.0-or-later（与仓库其它包一致）。
