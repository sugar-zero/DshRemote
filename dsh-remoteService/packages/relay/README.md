# dsh-remote-relay —— 自托管**盲中继**（方案 B2）

DSH 远程访问的服务端中继。三个角色共用一个域名后缀：

| 端口 | 协议 | 作用 | 谁能连 |
|---|---|---|---|
| `443/tcp` | **TLS 透传（不终止）** | 读 ClientHello 的 SNI，把 `<hostId>.<domain>` 的 TCP 流转给对应主机的控制连接 | App / 手机 WebView |
| `80/tcp` | HTTP | 除 `GET /healthz` 外一律 `301` 到 `https://<host><path>` | 浏览器 / 探针 |
| `8443/tcp` | WSS（relay 自己终止 TLS） | 主机插件控制面：`host.hello` 鉴权、心跳、`host.open/opened/close`、二进制流帧 | 只有 host 插件 |

**盲中继**：443 上是原始 TCP 字节流，relay 不参与 TLS 握手、**看不到明文、也不持有任何主机子域证书私钥**。
主机子域 `<hostId>.<domain>` 的服务端证书由主机插件自己申请（B2：主机侧 DNS-01，见下），relay 只在
SNI 上做路由。relay 自己唯一的证书是控制面用的 `relay.example.com` 证书。

```
App ──TLS(SNI=h_abc.relay.example.com)──▶ relay:443 ──原始字节▲▼──▶ host 插件 TLS 监听 ──▶ DSH webServer
                                                     │
                                      多路复用二进制帧（DATA/CLOSE）
                                                     ▼
host 插件 ──WSS(relay.example.com:8443/control)──▶ relay:8443
```

---

## 1. 快速开始

### 1.1 本地开发（ws:// 控制面，临时端口）

```bash
cd dsh-remoteService
npm install

# 起 relay（dev 模式允许无 TLS 的 ws:// 控制面；绝不能用于公网）
node packages/relay/bin/relay.js --dev --domain relay.test \
  --data-port 0 --control-port 0 --http-port 0
# 日志会打印实际端口：data :xxxxx / control :xxxxx / http :xxxxx
```

### 1.2 生产

```bash
# 1) 配置 + 控制面证书（见 §3）
sudo install -d -m 0750 /etc/dsh-relay/certs
sudo cp relay.example.json /etc/dsh-relay/relay.json   # 修改 domain 与证书路径
# 2) 签发第一台主机的 token（明文只打印一次）
sudo node packages/relay/bin/relay.js token create h_ab12cd34 --config /etc/dsh-relay/relay.json
# 3) 启动
sudo node packages/relay/bin/relay.js --config /etc/dsh-relay/relay.json
# 4) 健康检查
curl -s http://127.0.0.1/healthz
# {"ok":true,"domain":"relay.example.com","hosts":["h_ab12cd34"]}
```

> 生产必须提供 `tls.certFile/tls.keyFile`（或 `--dev` 才允许 ws://）；否则 `createRelay()` 直接抛错拒绝启动。

### 1.3 测试

```bash
cd dsh-remoteService
node --test packages/relay/test          # 目录入口（test/index.js）
# 或按文件：node --test packages/relay/test/*.test.js
```

测试覆盖：真实 ClientHello 捕获与 SNI 解析（含 TCP 分片/多 record）、token 拒绝、未知/缺失 SNI 销毁、
完整端到端 TLS 透传（假 host + 本地自签 TLS 服务 + `tls.connect` 客户端）、二进制 CLOSE 帧、
多路并发流、host 掉线清理、80 跳转与 `/healthz`、token CLI/文件权限。

---

## 2. 配置与 CLI

### 2.1 配置文件

JSON（见 `relay.example.json`）：

```json
{
  "domain": "relay.example.com",
  "dataPort": 443,
  "controlPort": 8443,
  "httpPort": 80,
  "dataHost": "0.0.0.0",
  "tls": { "certFile": "/data/certs/relay.example.com/fullchain.pem",
           "keyFile": "/data/certs/relay.example.com/privkey.pem" },
  "tokensFile": "/data/tokens.json",
  "logLevel": "info"
}
```

- 相对路径（`tls.*`、`tokensFile`）按 **config 文件所在目录**解析。
- `dataPort/controlPort/httpPort = 0` 表示临时端口（测试用；实际端口从返回值/日志读取）。
- 也可直接在代码里用 `createRelay(options)` / `startRelay(config)`（见 `index.js` 注释），
  返回 `{ dataPort, controlPort, httpPort, domain, dev, close(), health(), onlineHostIds() }`。

优先级：**内置默认值 < config 文件 < 环境变量 < 命令行参数**。

### 2.2 环境变量

`RELAY_DOMAIN`、`RELAY_DEV`、`RELAY_DATA_PORT`、`RELAY_CONTROL_PORT`、`RELAY_HTTP_PORT`、
`RELAY_DATA_HOST`、`RELAY_TOKENS_FILE`、`RELAY_TLS_CERT_FILE`、`RELAY_TLS_KEY_FILE`、`RELAY_LOG_LEVEL`。

### 2.3 CLI

```text
node packages/relay/bin/relay.js [启动参数]
node packages/relay/bin/relay.js token create <hostId>   # 签发/轮换，明文 token 只打印一次
node packages/relay/bin/relay.js token list              # hostId + token 掩码 + 时间
node packages/relay/bin/relay.js token revoke <hostId>   # 吊销（下次重连生效）
node packages/relay/bin/relay.js --help
```

token 文件默认是 **config 同目录的 `tokens.json`**（无 `--config` 时是当前目录），原子写入、权限 `0600`。
relay 在**每次 host 握手时重读** token 文件，因此 CLI 签发/吊销后**无需重启 relay**；已建立的控制连接不受影响。
`--json` 可让 `token create/list/revoke` 输出机器可读 JSON。

---

## 3. DNS 与证书

### 3.1 DNS

在域名服务商处配置（`relay.example.com` 换成你的域名）：

| 记录 | 值 |
|---|---|
| `relay.example.com  A` | relay 公网 IP |
| `*.relay.example.com A` | relay 公网 IP（**泛解析，必须**——主机子域 `<hostId>.<domain>` 靠它） |

- `hostId` 是子域名的**第一段**（DNS label）：`h_ab12cd34.relay.example.com` → `hostId = h_ab12cd34`。
- 只有 A 记录、relay 不监听 IPv6 时，不要加 AAAA（否则部分客户端走 IPv6 连不上）。

### 3.2 控制面证书（relay 自己用，`relay.example.com`）

控制面 WSS 需要一个受信任证书。**80 端口被 301 占用，不能走 HTTP-01**，用 **DNS-01**：

```bash
# acme.sh + Cloudflare DNS API 示例（cf token 只需 Zone.DNS Edit 权限）
export CF_Token="<cloudflare-api-token>"
acme.sh --issue --dns dns_cf -d relay.example.com --keylength ec-256
acme.sh --install-cert -d relay.example.com \
  --fullchain-file /etc/dsh-relay/certs/fullchain.pem \
  --key-file       /etc/dsh-relay/certs/privkey.pem \
  --reloadcmd      "systemctl reload-or-restart dsh-relay"

# 也可以不用 acme.sh：把已有证书链/私钥放到 tls.certFile / tls.keyFile 指定的位置即可
```

- 只需要 `relay.example.com` 这一张证书；**不需要**为主机子域在 relay 上申请证书。
- 续期由 acme.sh cron 自动完成（默认每天检查）；`--reloadcmd` 让 relay 重新加载（或直接让 relay 重启）。
- 证书/私钥权限建议 `0600`，不要放进镜像。

### 3.3 主机子域证书（`<hostId>.relay.example.com`）

由**主机插件**（B2，主机侧 DNS-01）自行申请和续期，host 插件拿到 DNS API 凭据后：
1. 在控制面 `host.hello` 注册（relay 返回 `hostname`/`dataPort`）；
2. 用自己的 DNS-01 拿到 `<hostId>.<domain>` 证书；
3. 在 `127.0.0.1:<随机端口>` 起 TLS 监听（mTLS/反代在插件内部处理）。

relay 只做 SNI 透传，**从不接触这些证书或私钥**，因此即使 relay 被攻破也无法冒充主机服务器 / 解密流量。

---

## 4. Docker 部署

`packages/relay/Dockerfile` 是多阶段、`node:24-alpine`、非 root；构建上下文必须是 `dsh-remoteService` 根目录
（relay 依赖 workspace 包 `dsh-remote-protocol`）。`docker-compose.yml` 已按此设置（`context: ../..`）。

宿主机目录（`./data` 挂到容器 `/data`）：

```
data/
├── config/relay.json
├── certs/relay.example.com/{fullchain.pem,privkey.pem}
└── tokens.json            # 首次 token create 后出现（0600）
```

```bash
cd dsh-remoteService/packages/relay
mkdir -p data/config data/certs/relay.example.com
cp relay.example.json data/config/relay.json
cp /path/to/fullchain.pem data/certs/relay.example.com/
cp /path/to/privkey.pem   data/certs/relay.example.com/
# 容器内 relay 用户 uid/gid 通常是 1000；确保挂载目录可读
chown -R 1000:1000 data

docker compose up -d --build
docker compose logs -f relay
docker compose exec relay node packages/relay/bin/relay.js token create h_ab12cd34 --config /data/config/relay.json
```

- 端口 `80/443/8443` 映射到宿主机；容器内非 root 绑定低端口依赖 Docker 的
  `net.ipv4.ip_unprivileged_port_start=0`（Docker 默认即为 0，compose 里也显式声明）。
- `restart: unless-stopped` + 内置 `HEALTHCHECK`（`GET /healthz`）+ 日志轮转（10m × 3）。
- 升级：`docker compose build && docker compose up -d`；token 与证书在 `./data` 卷里，不受影响。

---

## 5. systemd 示例（非 Docker）

```ini
# /etc/systemd/system/dsh-relay.service
[Unit]
Description=DSH remote access blind relay
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

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now dsh-relay
sudo systemctl status dsh-relay
```

---

## 6. 健康检查

```bash
curl -s http://127.0.0.1/healthz    # 200
# {"ok":true,"domain":"relay.example.com","hosts":["h_ab12cd34"]}
curl -sI http://relay.example.com/  # 301 Location: https://relay.example.com/
```

- `hosts` 是当前在线（控制面已鉴权且心跳正常）的 hostId 列表；主机离线时为空数组。
- 仅 `GET/HEAD /healthz` 返回 200；其余路径/方法一律 301。
- 外部探针建议直接 `curl -fsS https://relay.example.com:8443/healthz` 会 404（控制面只收 WS），
  所以探针请打 **80 端口的 `/healthz`**（= curl `http://127.0.0.1/healthz`），或由容器 HEALTHCHECK 负责。

---

## 6.1 推送（可选，旧版通道）

> **默认不参与推送**：主机插件默认 `pushProvider=apns`，直接用自己的 APNs Auth Key 把
> 会话摘要发到 Apple，不把 token 注册到 relay（见 host-plugin README「推送」）。本节是旧版
> relay → Expo Push 通道，只有显式配置 `pushProvider: "expo"` 时才会用到。

relay 接收 host 控制面的两类 push 消息（均需已通过 host.hello 鉴权）：

```text
host → relay: {t:'push.register', deviceId, provider:'expo', token}
host → relay: {t:'push.send', kind:'attention'}
relay → host: {t:'push.result', action:'register'|'send', ok, delivered, failed}
```

- token 只存内存、按 hostId 隔离（每主机最多 20 台）；relay 重启后由 App 下次打开重新注册。
- 发送内容**固定为通用标题/正文 + `{kind}`**，绝不含会话名/消息/文件路径。
- 配置：`relay.json` 的 `push: {enabled,endpoint,accessToken,title,body}` 或环境变量 `RELAY_PUSH_*`；默认 endpoint 为 Expo Push API。
- 此旧通道 provider 仅支持 `expo`；`/healthz` 的 `pushTokens` 字段为当前注册设备数（默认直连 APNs 模式下为 0）。

---

## 6.2 连接限制（DoS 兜底）

`relay.json` 可选：

```json
{ "limits": { "maxConnectionsPerIp": 64, "maxDataConnections": 1024 } }
```

- `maxConnectionsPerIp`：同一来源 IP 允许的并发 443 数据连接数（默认 64）；
- `maxDataConnections`：全站并发数据连接上限（默认 1024）。
- 超限连接会被立即销毁并记 warn 日志；这是 DoS 兜底，不替代 host 侧 mTLS/配对鉴权。
- `limits` 字段也接受 `RELAY_...` 之外的 JSON 配置（CLI 暂未映射环境变量）。

---

## 7. 日志与隐私

- 会记录：hostId、来源 IP:port、streamId、字节数（debug）、错误码、在线/离线、心跳超时、token 校验失败（不含 token 值）。
- **不会记录**：TLS 内容、HTTP 正文、token 明文、主机子域证书、会话/文件信息。443 是原始字节透传，relay 看不到明文。
- 默认 `logLevel: info`；排查时可用 `--log-level debug`（会打印每条 stream 的开闭，仍不含内容）。
- **dev 模式是明文控制面**（host token 在网络上裸奔），只能在本机/隔离测试网使用；公网必须 TLS。

## 8. token 生命周期 / 轮换

```bash
# 新主机
node bin/relay.js token create h_new --config /etc/dsh-relay/relay.json   # 输出一次明文 token
# 轮换某主机（旧 token 立即失效；已连接会话不受影响，下次重连用新 token）
node bin/relay.js token create h_old --config /etc/dsh-relay/relay.json
# 吊销
node bin/relay.js token revoke h_old --config /etc/dsh-relay/relay.json
# 查看（掩码）
node bin/relay.js token list --config /etc/dsh-relay/relay.json
```

- `tokens.json` 为纯 JSON、权限 `0600`、原子写入；备份它 = 备份所有 host 凭据，注意保管。
- relay 每次握手重读文件，所以签发/轮换/吊销**无需重启**；已在线连接在重连或心跳超时后才会被新凭据约束。
- 怀疑泄露时：`token create`（轮换）→ 主机插件更新 token → 重启/重连；彻底失陷则 `revoke` 并检查控制面日志。

---

## 9. 排障

| 现象 | 可能原因 |
|---|---|
| `refusing to start relay without TLS` | 没配 `tls` 且未加 `--dev`；生产必须给控制面证书 |
| `EADDRINUSE` | 80/443/8443 被占用（如已有 nginx/httpd/其他 relay） |
| App 连 `<hostId>.<domain>` 报 TLS/连接重置 | relay 找不到该 host（离线/SNI 非 `<hostId>.<domain>`/泛解析未生效）；看 `--log-level debug` 的 `no route for SNI` |
| TLS 握手卡住/`unexpected message` | 主机侧没有在 `host.opened` 后把 ClientHello 转给本机 TLS 监听，或 relay/主机帧方向错误 |
| 控制面 401/连接被 1008 关闭 | token 不对/被吊销/hostId 不匹配；看 `control: rejected host ... invalid token` |
| 主机频繁掉线 | 30s 内无任何控制消息 → 可能是主机网络不稳定或未响应 `host.heartbeat` |
| 80 端口 301 正常但 https 打不开 | 控制面证书/端口问题 ≠ 443 透传问题；443 依赖主机在线与子域证书 |

协议细节（控制消息、二进制帧格式）见 `packages/protocol/index.js`；管理 API 契约见 `docs/ADMIN-API.md`。
