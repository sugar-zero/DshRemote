# dsh-remote-relay —— 群体服务版（A 模式）relay

DSH 远程访问的**群体服务版**服务端中继：服务提供方部署一个 relay 域名，受邀的群成员
各自的主机凭邀请码自助接入，手机 App 通过 relay 访问自己的主机。

> **0.3.0 起 relay 只服务群体版产品线**：classic 单机盲中继（443 TLS 透传 / 80 跳转 /
> `tokens.json` / Expo 推送）已全部删除。旧版本行为见 git 历史，本文不再描述。

relay 提供五个面（职责分离，可各自独立监听）：

| 面 | 配置 | 默认端口 | 作用 | 谁能连 |
|---|---|---|---|---|
| **边缘 TLS**（默认开启） | `group.edge.port` | 443 | relay 用通配证书终止手机 TLS，SNI → `<hostId>.<domain>`；设备会话鉴权后经隧道转发到主机 | 手机 App / WebView |
| **控制面 WSS** | `controlPort` | 8443 | 主机插件出站隧道：`host.hello` 鉴权、心跳、`host.open`、二进制 `DATA`/`CLOSE` 帧 | 只有 host 插件 |
| **注册 API** | `group.apiPort` | 9443 | `POST /__group/register`、`POST /__group/refresh`（邀请码 → 主机自助开通） | host 插件 |
| **部署方后台** | `group.adminPort` + `group.adminBind` | 9444（默认绑 127.0.0.1） | `/__admin` 页面 + JSON API：邀请码/主机管理 | 只有部署方 |
| **health** | `httpPort` | 80 | 只服务 `GET/HEAD /healthz`（容器 HEALTHCHECK / 同机探针） | 探针（建议只绑回环） |

```
App ──TLS(SNI=h_abc.relay.example.com)──▶ relay:443（relay 终止 TLS，_Host- cookie 鉴权）
                                            │
                                   控制面隧道：JSON 控制消息 + DATA/CLOSE 帧
                                            ▼
host 插件 ──WSS(wss://relay.example.com:8443/control)──▶ relay:8443
                                            │
                                       浏览器/App 明文字节
                                            ▼
host 插件 loopback 明文代理 ──逐请求鉴权/deny list──▶ DSH webServer(127.0.0.1)
```

**A 模式的安全边界**：relay **终止**手机 TLS（用部署方的通配证书），因此**部署方可见会话明文**——
这 是本产品线的明确取舍，风险与责任由部署方承担（部署文档与 App 内已明示）。主机侧仍保持
`127.0.0.1` 回环、deny list 与逐请求鉴权；relay 不信任来源 IP / `X-Forwarded-*` / 自定义头作为身份。

---

## 1. 快速开始

### 1.1 本地开发（ws:// 控制面，临时端口）

```bash
cd dsh-remoteService
npm install

# 起 relay：dev 模式允许无 TLS 的 ws:// 控制面（绝不能用于公网）。
# 群体版边缘 TLS 默认开启（手机数据面是核心功能），因此这里用 --no-group-edge 显式关闭，
# 只本地联调「注册 API / 部署方后台 / 控制面」。
node packages/relay/bin/relay.js --dev --domain relay.test \
  --control-port 0 --http-port 0 --group-file ./group.json --no-group-edge
# 日志会打印实际端口：control :xxxxx / http health :xxxxx
```

本地要联调「边缘 TLS + 隧道」时，在 config 里给 `group.edge` 配一张自签通配证书（`enabled`
默认开启，不写也行），并显式 `"allowUnauthenticated": true`（**仅 dev/test 可用**，非 dev
配置会直接报错）；完整例子见 `test/group-tunnel.test.js`。

### 1.2 生产

```bash
# 1) 配置 + 证书（见 §3）
sudo install -d -m 0750 /etc/dsh-relay/certs
sudo cp relay.example.json /etc/dsh-relay/relay.json   # 修改 domain 与证书路径
# 2) 起 relay（首次启动会在 group.json 同目录生成部署方 admin-token，0600）
sudo node packages/relay/bin/relay.js --config /etc/dsh-relay/relay.json
# 3) 健康检查
curl -s http://127.0.0.1/healthz
# {"ok":true,"domain":"relay.example.com","hosts":[]}
# 4) 发邀请码给群成员（明文只打印一次）
sudo node packages/relay/bin/relay.js invite create --note "friend A" --expires-in 7d --config /etc/dsh-relay/relay.json
```

> 生产必须提供控制面 TLS（`tls.certFile/tls.keyFile`）与边缘通配证书（`group.edge.tls`）；
> 否则 `createRelay()` 直接抛错拒绝启动。dev 模式（`--dev`）才允许 ws://。

### 1.3 测试

```bash
cd dsh-remoteService
node --test packages/relay/test          # 目录入口（test/index.js）
# 或按文件：node --test packages/relay/test/*.test.js
```

测试覆盖：控制面鉴权/心跳/替换/生产 wss、health 面（只放行 `/healthz`）、边缘 TLS 终止与
SNI 路由、`host.open`/`opened` + 二进制帧隧道、设备 challenge→token→cookie 鉴权（含篡改/过期/
跨主机/撤销设备拒绝）、注册/刷新/限流/配额/邀请码、部署方后台鉴权与接口分层、entrypoint
自动生成配置。classic 数据面/推送/token 文件的测试已随功能删除。

---

## 2. 配置与 CLI

### 2.1 配置文件

JSON（完整示例见 `relay.example.json`）：

```json
{
  "domain": "relay.example.com",
  "controlPort": 8443,
  "httpPort": 80,
  "listenHost": "0.0.0.0",
  "tls": { "certFile": "/data/certs/relay.example.com/fullchain.pem",
           "keyFile": "/data/certs/relay.example.com/privkey.pem" },
  "logLevel": "info",

  "group": {
    "file": "/data/group.json",
    "mobilePort": 443,
    "maxHosts": 200,
    "apiPort": 9443,
    "apiBind": "0.0.0.0",
    "adminPort": 9444,
    "adminBind": "127.0.0.1",
    "publicControlPort": 8443,
    "edge": {
      "enabled": true,
      "port": 443,
      "tls": { "certFile": "/data/certs/wildcard/fullchain.pem",
               "keyFile": "/data/certs/wildcard/privkey.pem" },
      "allowUnauthenticated": false
    },
    "auth": { "signingKeyFile": "/data/signing-key.pem" },
    "adminTokenFile": "/data/admin-token",
    "push": {
      "enabled": false,
      "mode": "self",
      "content": "generic",
      "cooldownSeconds": 30,
      "self": { "keyFile": "/data/apns/AuthKey_<KEY_ID>.p8", "keyId": "<KEY_ID>",
                "teamId": "<TEAM_ID>", "topic": "<BUNDLE_ID>", "environment": "auto" }
    }
  }
}
```

- 相对路径（`tls.*`、`group.file`、`group.edge.tls.*`、`group.auth.signingKeyFile`、
  `group.adminTokenFile`、`group.push.self.keyFile`）
  按 **config 文件所在目录**解析。
- `controlPort/httpPort/group.edge.port/... = 0` 表示临时端口（测试用；实际端口从返回值/日志读取）。
- **`group.edge` 默认开启**（群体版唯一数据面）：必须提供覆盖 `*.<domain>` 的通配证书
  （`group.edge.tls`），否则 relay 拒绝启动；只有显式 `"group": { "edge": { "enabled": false } }`
  才会关闭——关闭后只有控制面/注册 API/后台，会打 warn，仅用于特殊/测试场景。
- **classic 字段已删除**：配置里出现 `dataPort` / `tokensFile` / `hostTokens` / `push` 会被
  **忽略并打一条 warn 日志**；`mode` 只接受 `"group"`（写 `"classic"` 直接报错拒绝启动）。
- 也可直接在代码里用 `createRelay(options)` / `startRelay(config)`（见 `index.js` 注释）。

优先级：**内置默认值 < config 文件 < 环境变量 < 命令行参数**。

### 2.2 环境变量

`RELAY_DOMAIN`、`RELAY_DEV`、`RELAY_CONTROL_PORT`、`RELAY_HTTP_PORT`、`RELAY_LISTEN_HOST`、
`RELAY_GROUP_FILE`、`RELAY_GROUP_MOBILE_PORT`、`RELAY_GROUP_API_PORT/BIND`、
`RELAY_GROUP_ADMIN_PORT/BIND`、`RELAY_GROUP_PUBLIC_CONTROL_PORT`、
`RELAY_GROUP_EDGE_ENABLED/PORT/CERT_FILE/KEY_FILE`、`RELAY_GROUP_SIGNING_KEY_FILE`、
`RELAY_ADMIN_TOKEN`、`RELAY_ADMIN_TOKEN_FILE`、`RELAY_TLS_CERT_FILE`、`RELAY_TLS_KEY_FILE`、
`RELAY_LOG_LEVEL`；服务端集中推送（0.4.0，只有 self，见 §6.5）：
`RELAY_GROUP_PUSH_ENABLED/MODE/CONTENT/COOLDOWN_SECONDS`、
`RELAY_GROUP_PUSH_APNS_KEY_FILE/KEY_ID/TEAM_ID/TOPIC/ENVIRONMENT`
（`RELAY_GROUP_PUSH_MODE` 只接受 `self`）。

### 2.3 CLI

```text
node packages/relay/bin/relay.js [启动参数]
node packages/relay/bin/relay.js invite create --note <text> --max-uses <n> --expires-in <dur>
node packages/relay/bin/relay.js invite list
node packages/relay/bin/relay.js invite revoke <inviteId|code>
node packages/relay/bin/relay.js host list
node packages/relay/bin/relay.js host revoke <hostId>
node packages/relay/bin/relay.js admin-token [--json]
node packages/relay/bin/relay.js --help / --version
```

- `group.json` 默认是 **config 同目录的 `group.json`**（无 `--config` 时是当前目录）。
- relay 在**每次注册/每个 host 握手时重读** group.json，CLI 发放邀请/撤销主机**无需重启**。
- `--json` 可让 invite/host/admin-token 输出机器可读 JSON。
- classic 的 `token create/list/revoke` 已在 0.3.0 删除（会提示改用 invite/host 命令）。

---

## 3. DNS 与证书

### 3.1 DNS

在域名服务商处配置（`relay.example.com` 换成你的域名）：

| 记录 | 值 |
|---|---|
| `relay.example.com  A` | relay 公网 IP |
| `*.relay.example.com A` | relay 公网 IP（**泛解析，必须**——主机子域 `<hostId>.<domain>` 靠它） |

- `hostId` 由服务端分配、是子域名第一段（DNS label）：`h_ab12cd34.relay.example.com` → `hostId = h_ab12cd34`。
- 只有 A 记录、relay 不监听 IPv6 时，不要加 AAAA（否则部分客户端走 IPv6 连不上）。

### 3.2 控制面证书（`relay.example.com`）

控制面 WSS 需要一张受信任证书。**80 端口不再做 ACME HTTP-01 跳转（只留 /healthz）**，
请用 **DNS-01** 签发：

```bash
# acme.sh + Cloudflare DNS API 示例（cf token 只需 Zone.DNS Edit 权限）
export CF_Token="<cloudflare-api-token>"
acme.sh --issue --dns dns_cf -d relay.example.com --keylength ec-256
acme.sh --install-cert -d relay.example.com \
  --fullchain-file /etc/dsh-relay/certs/relay.example.com/fullchain.pem \
  --key-file       /etc/dsh-relay/certs/relay.example.com/privkey.pem \
  --reloadcmd      "systemctl reload-or-restart dsh-relay"
```

### 3.3 边缘通配证书（`*.relay.example.com`）

A 模式下 relay 要**终止所有主机子域的手机 TLS**，因此需要一张覆盖 `*.<domain>` 的通配证书
（同样用 DNS-01，放在 `group.edge.tls` 指向的路径）。私钥只在 relay 上。

---

## 4. Docker 部署

`packages/relay/Dockerfile` 是多阶段、`node:24-alpine`、非 root；构建上下文必须是
`dsh-remoteService` 根目录（relay 依赖 workspace 包 `dsh-remote-protocol` / `dsh-remote-apns`）。
单机示例见
`packages/relay/docker-compose.yml`；多面端口/nginx 前置的完整部署模板见
[`server/docker-compose.group.yml`](../../../server/docker-compose.group.yml)
与 [`server/README.md`](../../../server/README.md)。

宿主机目录（`./data` 挂到容器 `/data`）：

```
data/
├── config/relay.json                         # 首次启动按 .env 自动生成（0600，已存在不覆盖）
├── certs/relay.example.com/{fullchain.pem,privkey.pem}   # 控制面证书
├── certs/wildcard/{fullchain.pem,privkey.pem}            # 边缘通配证书
├── group.json                                # 邀请码/主机注册表（0600，首次注册自动创建）
├── signing-key.pem                           # 设备会话签名私钥（0600，首次启动自动生成）
├── admin-token                               # 部署方后台 token（0600，首次启动自动生成）
├── apns/AuthKey_<KEY_ID>.p8                  # 可选 self 推送：APNs Auth Key（0600，只读挂载）
```

```bash
cd dsh-remoteService/packages/relay
mkdir -p data/{config,certs/relay.example.com,certs/wildcard}
cp relay.example.json data/config/relay.json   # 或删掉让 entrypoint 按 .env 生成
cp /path/to/fullchain.pem data/certs/relay.example.com/
cp /path/to/privkey.pem   data/certs/relay.example.com/
cp /path/to/wildcard-fullchain.pem data/certs/wildcard/fullchain.pem
cp /path/to/wildcard-privkey.pem   data/certs/wildcard/privkey.pem
chown -R 1000:1000 data

RELAY_DOMAIN=relay.example.com docker compose up -d --build
docker compose logs -f relay
docker compose exec relay node packages/relay/bin/relay.js invite create --config /data/config/relay.json
```

- 镜像 tag：`dsh-remote-relay:0.4.0-group`（离线包 `server/dsh-relay-0.4.0-group-linux-amd64.tar`，
  62,759,936 bytes，sha256 `41218320c65e4ff04a417006afcafd29702b70d61dd2553d9f35f40915bbc2ea`，
  2026-11-02 构建 + 容器 `/healthz` 冒烟通过）。
- `restart: unless-stopped` + 内置 `HEALTHCHECK`（`GET /healthz`）+ 日志轮转（10m × 3）。
- 升级：`docker compose build && docker compose up -d`；证书与 group.json 在 `./data` 卷里，不受影响。

---

## 5. systemd 示例（非 Docker）

```ini
# /etc/systemd/system/dsh-relay.service
[Unit]
Description=DSH group-service relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=relay
Group=relay
WorkingDirectory=/opt/dsh-remote/dsh-remoteService
ExecStart=/usr/bin/node packages/relay/bin/relay.js --config /etc/dsh-relay/relay.json
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/dsh-relay
# 允许非 root 绑定 80/443
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
```

---

## 6. 群体版功能面

### 6.1 注册 API（邀请码 → 主机自助开通）

主机插件调用（`group.apiPort` 独立监听时走 HTTPS `POST /__group/register`；未配置 apiPort 时
退回控制面，兼容旧部署）：

```json
{ "inviteCode": "<one-time invite code>", "hostName": "Living Room Mac" }
→ 200 { "ok": true, "protocolVersion": 1, "hostId": "h_ab12cd34xy",
        "hostToken": "<shown once>", "hostName": "Living Room Mac",
        "relayDomain": "relay.example.com", "mobilePort": 443,
        "controlUrl": "wss://relay.example.com:8443/control",
        "tokenPublicKey": "-----BEGIN PUBLIC KEY-----..." }
```

`controlUrl` 是主机回连隧道的**控制面 WSS 地址**（host 取注册请求 Host，端口优先
`group.publicControlPort`）：职责分离后注册 API 端口 ≠ WSS 端口，主机插件必须用它。

**刷新注册**（`POST /__group/refresh`，同一注册 API 面）用于服务端改了 `mobilePort` /
`publicControlPort` 后让已注册主机同步，**不消耗邀请码**（`Authorization: Bearer <hostToken>`）。

错误码：`invalid_request`(400) / `invalid_invite|invite_expired|invite_exhausted|registration_disabled`(403)
/ `host_limit`(409) / `rate_limited`(429，带 `Retry-After`)。

安全约定：

- **邀请制**：没有有效邀请码一律拒绝；`registration.enabled=false` 可整体关闭。
- `group.json`（0600）里 invite code **明文保存**（后台/CLI 需随时查看复制）、host token 只存 **SHA-256**；
  该文件属于敏感文件，泄露后应撤销全部邀请并重建。
- hostId 由服务端分配（DNS label 安全、不可自定义）；友好名称仅展示用。
- `mobilePort` 随注册下发，主机写进配对二维码（QR v2）。

### 6.2 边缘 TLS + 出站隧道 + 设备会话

`group.edge` **默认开启**（显式 `"enabled": false` 才关闭并 warn），relay 在 `group.edge.port`
用**通配证书**终止手机 TLS，并把解密后的字节流
经控制面隧道转发给主机（`host.open {kind:"group-edge"}` + 二进制 DATA/CLOSE 帧）；流量控制与
心跳沿用控制面机制（分帧、背压水位、心跳走控制 JSON 通道，互不阻塞）。

生产默认（`allowUnauthenticated:false`）下，边缘连接必须先拿到会话：

1. **主机同步设备**：主机配对设备后经控制面发 `device.sync {devices:[{deviceId, publicKey}]}`
   （P-256 未压缩点 base64url；主机重连后全量重同步），`device.revoke {deviceId}` 撤销单台。
2. **设备换 token**（都走 `<hostId>.<domain>` 边缘 HTTPS）：
   - `POST /__group/auth/challenge {deviceId}` → `{nonce, expiresAt}`（一次性、默认 2 分钟）；
   - 设备私钥对 `hostId\ndeviceId\nnonce` 做 ECDSA-SHA256 签名 →
     `POST /__group/auth/token {deviceId, nonce, signature}` → `{token, expiresAt}` +
     `Set-Cookie: __Host-dsh_session=…; Path=/; Secure; HttpOnly; SameSite=Strict`（默认 15 分钟）。
3. **边缘校验**：业务请求带 cookie；relay 校验 token（Ed25519 签名 / 过期 / hostId / 设备未撤销）后才开隧道，
   未通过直接 401。**例外**：`/__dsh_remote/pair` 与 `/__dsh_remote/pair/status` 放行（一次性配对 secret +
   主机确认保护；仍有主机侧限速与一次性过期）。
4. **主机逐请求复验**：注册响应里的 `tokenPublicKey`（PEM）可离线校验 token（协议库
   `verifyGroupSessionToken`），设备撤销以主机设备表为权威源。

`group.auth` 配置：`tokenTtlMs`（5s–2h，默认 15min）、`challengeTtlMs`（10s–10min，默认 2min）、
`maxAttemptsPerMinutePerIp`（默认 30）、`signingKeyFile`（默认 `<group.json 目录>/signing-key.pem`，
Ed25519、0600、首次启动自动生成；**私钥只在 relay，主机只拿公钥**）。

错误语义：非 `<hostId>.<domain>` 的 SNI → `421`；主机未注册/离线 → `502`；连接/流表超限 → `503`。

### 6.3 部署方后台（`/__admin`）

配置了 `adminPort` 时是独立后台面（默认只绑回环），否则退回控制面端口：

```
https://<relayDomain>:<adminPort>/__admin/
```

推荐经 nginx 反代到 `admin.<domain>` 并加 basic auth / IP 白名单，或用 SSH 隧道访问；
**不要**直接把这个端口暴露公网。页面可以：查看域名/手机端口/在线主机数；生成邀请码（备注、
可用次数、有效期）；列邀请码并撤销；列主机（在线/离线/已撤销）并撤销主机。数据全部来自
`group.json`，页面每 10 秒自动刷新。

**鉴权**：`Authorization: Bearer <admin token>` 请求头（**不使用查询参数 token / 来源 IP 作为身份**），
失败限速（同 IP 5 分钟 10 次后 429）。token 来源优先级：

1. `group.adminToken` 配置 / 环境变量 `RELAY_ADMIN_TOKEN`；
2. token 文件 `group.adminTokenFile`（默认 `<group.json 目录>/admin-token`，0600；**首次启动自动生成**）；
3. 本机查看：`node bin/relay.js admin-token --config /etc/dsh-relay/relay.json`（`--json` 可机器读）。

### 6.4 接口分层

配置 `apiPort` / `adminPort` 后，控制面**不再**提供注册/后台路由（普通 HTTP 一律 404）；
不配置时保持「都挂在控制面」的兼容行为。

```json
"group": {
  "apiPort": 9443,
  "apiBind": "0.0.0.0",
  "adminPort": 9444,
  "adminBind": "127.0.0.1",
  "publicControlPort": 8443
}
```

`publicControlPort` 是注册响应下发 `controlUrl` 用的**公网** WSS 端口：nginx 前置时 = nginx 实际
listen 的端口，直连时 = 宿主映射端口。relay 不会自动探测，填错会导致主机 control socket error。

### 6.5 服务端集中推送（self，0.4.0）

推送由 relay 统一发送，**主机不持有任何 Apple 凭据**；主机只经已鉴权控制连接上报
「推送意图 + 设备 token」，relay 用**部署方自己的 APNs Auth Key** 直连 Apple
（`dsh-remote-apns`）。当前只有一种通道：

| 模式 | relay 侧配置 | 说明 |
|---|---|---|
| `self`（唯一） | `group.push.self.{keyFile,keyId,teamId,topic,environment}` | relay 用部署方自己的 APNs Auth Key 直连 Apple；App 必须用同一 Apple 团队签名 |

> **R2 起官方 App 的推送不经过 relay**：官方 App 用设备密钥向「官方推送 hub」登记换
> credential，主机直连 hub 推送。relay 里的 `official` 转发通道已在 0.4.0 删除，
> `group.push.mode` 只接受 `"self"`，配成其它值会在启动时报可操作错误。
> 契约见 [`../../../docs/group-push-r2-contract.zh.md`](../../../docs/group-push-r2-contract.zh.md)。

```json
"push": {
  "enabled": true,
  "mode": "self",
  "content": "generic",
  "cooldownSeconds": 30,
  "self": {
    "keyFile": "/data/apns/AuthKey_<KEY_ID>.p8",
    "keyId": "<KEY_ID>",
    "teamId": "<TEAM_ID>",
    "topic": "<BUNDLE_ID>",
    "environment": "auto"
  }
}
```

- `content`：`generic` = 固定通用文案（默认）；`summary` = 会话标题 + 助手回复摘要。
- `cooldownSeconds`：同一 host 两次推送意图的最小间隔（0..3600 秒，默认 30）。
- `environment`：`auto`（默认）/ `development` / `production`；实际 APNs 环境由 App 构建决定。
- 控制消息（协议见 `packages/protocol/index.js`）：`push.register` → `push.registered`；
  `push.send` → `push.result`（`delivered/failed/pruned/mode/skipped`）。`pruned` 是 APNs
  410/Unregistered 后 relay 已删除的 deviceId。
- 安全：hostId 只取自已鉴权控制连接；APNs 私钥只放部署方 `/data`（0600），
  **不落日志/healthz/仓库**。
- token 表只在内存（relay 重启清空；App 重新进入主机时重登记），设备撤销（`device.revoke` /
  `device.sync` / 后台撤销主机）立即删除对应 token；每 host 最多 16 个设备 token、
  每分钟 30 次推送意图，避免滥用。
- `/healthz` 只带摘要：`"push":{"enabled":true,"mode":"self","tokens":1}`（不含 token/密钥）。
- 部署步骤（compose 环境变量、`.p8` 放置）见
  [`server/README.md`](../../../server/README.md)。

---

## 7. 健康检查

```bash
curl -s http://127.0.0.1/healthz    # 200
# {"ok":true,"domain":"relay.example.com","hosts":["h_ab12cd34"],
#  "push":{"enabled":true,"mode":"self","tokens":1}}
```

- `hosts` 是当前在线（控制面已鉴权且心跳正常）的 hostId 列表；主机离线时为空数组。
- `push` 是服务端推送摘要（`enabled` / `mode` / 已登记 token 数），**不含任何 token/密钥**。
- **仅** `GET/HEAD /healthz` 返回 200；其余路径/方法一律 404（classic 的 80→443 301 跳转已删除）。
- 控制面端口只接受 WebSocket upgrade，探针请打 **httpPort 的 `/healthz`**（容器 HEALTHCHECK 已内置）。

---

## 8. 连接限制（DoS 兜底）

```json
{ "limits": { "maxConnectionsPerIp": 64, "maxEdgeConnections": 1024 } }
```

- `maxConnectionsPerIp`：同一来源 IP 允许的并发边缘 TLS 连接数（默认 64）；
- `maxEdgeConnections`：全站并发边缘连接上限（默认 1024；旧名 `maxDataConnections` 仍接受）。
- 超限连接会被立即销毁并记 warn 日志；这是 DoS 兜底，不替代主机侧设备鉴权。

---

## 9. 日志与隐私

- 会记录：hostId、在线/离线、来源 IP:port、streamId、字节数（debug）、错误码、心跳超时、
  token 校验失败（不含 token 值）、注册/撤销动作。
- **不会记录**：手机/主机明文内容、HTTP 正文、host token / 设备 token 明文、私钥。
- 默认 `logLevel: info`；排查时可用 `--log-level debug`（会打印每条流/连接的开闭，仍不含内容）。
- **A 模式部署方可见明文**（relay 终止 TLS）：请在部署文档与告知中明示，日志与磁盘仍按上面的
  最小化原则处理；不要开启会记录请求体的反向代理配置。
- **dev 模式是明文控制面**（host token 在网络上裸奔），只能在本机/隔离测试网使用；公网必须 TLS。

---

## 10. 排障

| 现象 | 可能原因 |
|---|---|
| `refusing to start relay without TLS` | 没配 `tls` 且未加 `--dev`；生产必须给控制面证书 |
| `group relay requires group.file` | 没配 `group.file`（或旧 classic 配置被使用）；群体版必须有 group.json |
| `group edge requires TLS` | `group.edge` 默认开启但没配通配证书（`group.edge.tls`）；纯本地调试可显式 `"enabled": false` / CLI `--no-group-edge` |
| `EADDRINUSE` | 80/443/8443/9443/9444 被占用（nginx/其他进程） |
| 手机连 `<hostId>.<domain>` 失败 | 主机离线 / sni 非 `<hostId>.<domain>` / 泛解析未生效；看 `--log-level debug` 的 `edge: dropping ... no route for SNI` |
| 边缘 421 | SNI 不是 `<hostId>.<relayDomain>` |
| 边缘 502 | 主机未注册/离线（控制面未连接） |
| 边缘 401 | 没有/过期的 `__Host-dsh_session` cookie；设备需重新 challenge→token 或该设备已撤销 |
| 控制面 401/1008 | host token 不对/主机被撤销/hostId 不匹配；看 `control: rejected host ... invalid token` |
| 主机频繁掉线 | 30s 内无任何控制消息 → 主机网络不稳定或未响应 `host.heartbeat` |
| 后台 401 | admin token 不对/未带 `Authorization: Bearer`；token 在 `data/admin-token` |

协议细节（控制消息、二进制帧格式）见 `packages/protocol/index.js`；主机插件管理 API 契约见
群体版设计见 [docs/group-service-design.zh.md](../../../docs/group-service-design.zh.md)。

---

## 11. 版本记录

- **0.4.0**（`feat/group-service`，R2）：**relay 推送只保留 self**——删除 official 转发通道
  （`lib/push-hub-client.js`、`group.push.official`、`RELAY_GROUP_PUSH_HUB_*`、`data/hub-token`）；
  `group.push.mode` 只接受 `self`，其它值启动即报可操作错误。官方 App 推送改为「App 向官方
  hub 登记、主机直连 hub」，不再经过 relay。版本号升 0.4.0。
- **0.3.1**（`feat/group-service`）：**服务端集中推送**（`docs/group-push-design.zh.md`）——
  主机不再持有 Apple 凭据，relay 统一发送：`self` 模式用部署方 APNs Auth Key 直连 Apple
  （`dsh-remote-apns`），`official` 模式把「kind + 主机地址 + device token」转给官方推送 hub
  （只发通用文案，不上行会话内容；0.4.0 已删除 official）；新增 `group.push` 配置（`enabled/mode/content/
  cooldownSeconds/self/official` 及 `RELAY_GROUP_PUSH_*` 环境变量）、控制消息
  `push.register/push.registered/push.send/push.result`、内存 token 表（撤销/同步立即失效，
  不落盘）、每 host 限速与 token 上限、`/healthz` 推送摘要；Dockerfile 增加
  `packages/apns` 依赖；版本号升 0.3.1。
- **0.3.0**（`feat/group-service`）：relay 只保留群体服务版（A 模式）——删除 classic 数据面 TLS
  透传（`dataServer`/`dataPort`）、classic HTTP 跳转面（80 端口只留 `/healthz`）、relay 侧推送
  （`lib/push.js`、Expo/APNs 配置与测试）、classic token 存储/CLI（`tokens.json`、
  `token create/list/revoke`、`hostTokens` 配置）与 SNI 透传解析（`lib/sni.js`）、classic 测试；
  `tokens.js` 缩为 hostId 校验 + host token 生成辅助（群体版注册仍用）；配置去掉 `mode: classic`、
  `dataPort`、`tokensFile`、`push`（旧字段忽略并告警）；`group.edge.enabled` 默认改为 **true**
  （手机数据面是核心功能，显式 false 才关闭并 warn）；版本号升 0.3.0。
- 0.2.x：群体版 P1 切片（注册/边缘 TLS/隧道/设备会话/后台/接口分层）与 classic 并存。
