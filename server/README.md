# DSH Remote · 群体服务版 relay 部署手册

本目录用于在公网 VPS 上部署**群体服务版（A 模式）** relay。
适用版本：relay **0.4.0-group**（本分支只提供群体版，不包含 classic 单机版；0.4.0 起只保留 self 推送，official 转发已删除，见 §6；0.4.0 镜像已构建/导出，见 §3.2）。

> **安全前提（务必先读）**：A 模式下 relay 在边缘**终止手机 TLS**，部署方可以看到会话明文
> 与元数据，风险与责任由部署方承担；relay 同时也是设备身份的信任方，请部署在自己信任的
> 服务器上。设计细节见 [`../docs/group-service-design.zh.md`](../docs/group-service-design.zh.md)。

## 1. 组成与端口

```
手机 App ──https──► relay 边缘 :443（*.<relayDomain> 通配证书，终止 TLS）
                     │  challenge/token 鉴权
                     ▼
主机插件 ──wss──► 控制面 :8443（主机出站隧道；主机插件主动连 relay）
                     │
部署方 ──https──► 注册 API :9443（主机自助注册/刷新）
                 ──https──► 后台 :9444（/__admin，只绑回环）
```

容器内固定端口：edge=`443`、控制面 WSS=`8443`、注册 API=`9443`、后台=`9444`、healthz=`80`。
宿主机映射与公网端口在 `.env.group.example` 中配置，原则只有两类：

- **★ 公网入口**（要放行/由 nginx 转发）：`RELAY_GROUP_MOBILE_PORT`（手机访问）、
  `RELAY_GROUP_PUBLIC_CONTROL_PORT`（主机 WSS）、`RELAY_GROUP_API_HOST_PORT`（注册 API）；
- **内部/回环**（不要对公网放行）：admin、healthz，以及 nginx 前置形态下的 edge/control 映射。

> `RELAY_GROUP_MOBILE_PORT` / `RELAY_GROUP_PUBLIC_CONTROL_PORT` 必须等于**手机/主机实际连接的
> 公网端口**（nginx listen 端口），不是容器端口、也不是宿主机映射端口。

## 2. 前置条件

- 一台 Linux VPS（x86_64），Docker + Compose v2；
- 域名：`relay.example.com` 与 `*.relay.example.com` 都解析到该 VPS；
- 两张证书（生产必须公网 CA，手机才信任；自签只适合 POC）：

  | 目录（`data/certs/` 下） | 证书 | 覆盖域名 | 用途 |
  |---|---|---|---|
  | `<RELAY_DOMAIN>/` | 控制面证书 | `<RELAY_DOMAIN>`（apex） | 主机 WSS、注册 API、后台 |
  | `wildcard/` | 边缘通配证书 | `*.<RELAY_DOMAIN>` | 手机访问 `<hostId>.<RELAY_DOMAIN>`，relay 终止 TLS |

  - `fullchain.pem`（证书+中间链）+ `privkey.pem`（私钥）；私钥 `600`、目录 `700`；
  - 通配证书只能 DNS-01 签发（`*.domain` 不能用 HTTP-01），例如
    `acme.sh --issue --dns dns_xxx -d '<RELAY_DOMAIN>' -d '*.<RELAY_DOMAIN>'`；
  - 也可以申请一张同时含 apex + `*.<domain>` 的 SAN 证书，复制到两个目录。

## 3. 部署（两种形态）

### 3.1 准备变量与证书

```bash
cd server
cp .env.group.example .env.group      # 至少改 RELAY_DOMAIN；端口/镜像/admin token 按需改
mkdir -p data/certs/<RELAY_DOMAIN> data/certs/wildcard
# 把两张证书的 fullchain.pem / privkey.pem 放进对应目录
chown -R 100:101 data                 # 容器内 relay 用户 UID/GID
```

`docker compose` 默认只读 `.env`；文件叫 `.env.group` 时必须显式 `--env-file .env.group`
（或改名为 `.env`）。**首次启动会根据 `.env.group` 自动生成 `data/config/relay.json`**
（已存在不覆盖；高级项可手改，字段参考 `group/relay.group.example.json`）。

### 3.2 启动 relay

```bash
# A. 本机构建（开发机/Apple Silicon 记得指定 linux/amd64）
DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose --env-file .env.group -f docker-compose.group.yml up -d --build

# B. 服务器离线镜像（推荐生产）
#   0.4.0 镜像已在本机构建/导出（2026-11-02，linux/amd64；scp 到 VPS 后 load 即可）：
#     server/dsh-relay-0.4.0-group-linux-amd64.tar   （62,759,936 bytes）
#     sha256: 41218320c65e4ff04a417006afcafd29702b70d61dd2553d9f35f40915bbc2ea
#   校验：shasum -a 256 dsh-relay-0.4.0-group-linux-amd64.tar   # macOS
#         sha256sum dsh-relay-0.4.0-group-linux-amd64.tar       # Linux
#   （server/*.tar 被本仓库 .git/info/exclude 忽略，不会进 git）
#   上一版 0.3.1 离线包仍在 server/，仅作回滚/过渡（含已删除的 official 转发，不推荐新部署）：
#     dsh-relay-0.3.1-group-linux-amd64.tar（62,767,616 bytes，sha256 170ba4f9…78b1e6）
docker load -i dsh-relay-0.4.0-group-linux-amd64.tar
docker compose --env-file .env.group -f docker-compose.group.yml up -d --no-build
# ⚠️ 若服务器 .env 里显式写了 DSH_RELAY_IMAGE（旧值），先改成
#    DSH_RELAY_IMAGE=dsh-remote-relay:0.4.0-group，否则会继续跑旧镜像。
```

生产服务器建议整理成标准目录（Compose 不关心文件名，只关心 `-f` 与 env 文件）：

```text
/opt/dsh-group/
├── docker-compose.yml      # = 仓库 server/docker-compose.group.yml
├── .env                    # = 仓库 server/.env.group.example（改端口/镜像/域名）
└── data/                   # 挂载进容器：config/relay.json、certs/、group.json、admin-token…
```

```bash
cd /opt/dsh-group
chmod 600 .env
docker compose config          # 确认变量插值
docker compose up -d --no-build
docker compose ps && docker compose logs -f relay
```

### 3.3 nginx 前置（推荐）

relay 自己终止手机 TLS，nginx **只做 L4 SNI 透传**，不要做 HTTPS 终止/HTTP 反代
（否则边缘证书与设备 cookie 都会出问题）。示例见
[`nginx/group-nginx-stream.conf`](nginx/group-nginx-stream.conf)：把公网 `443 → 127.0.0.1:<edge映射>`、
公网 `8443 → 127.0.0.1:<control映射>`，按 SNI 分流；然后在 `.env.group` 里把
`RELAY_GROUP_EDGE_BIND` / `RELAY_GROUP_CONTROL_BIND` 改为 `127.0.0.1`。

只有一台 relay 时也可直连（不装 nginx）：把 edge/control 映射到公网端口，并让
`RELAY_GROUP_MOBILE_PORT` / `RELAY_GROUP_PUBLIC_CONTROL_PORT` 等于这两个公网端口。

**注册 API（19443）** 既可以直接对公网，也可以让 nginx 终止 TLS 后反代到
`https://127.0.0.1:19443`：此时把 `RELAY_GROUP_API_HOST_BIND=127.0.0.1`，并且**必须**把
`Host` 设为 `<RELAY_DOMAIN>`（注册响应里的 `controlUrl` 用请求 Host 生成，Host 错了主机回连
隧道会失败）；参考 [`nginx/group-api-http.conf`](nginx/group-api-http.conf)。注意反代后注册
限速按 127.0.0.1 共享桶，必要时调大 `registration.maxAttemptsPerMinute`。

**后台（9444）** 默认只绑 `127.0.0.1:19444`，不要暴露公网：用 SSH 隧道
（`ssh -L 19444:127.0.0.1:19444 <VPS>`）或按
[`nginx/group-admin-http.conf`](nginx/group-admin-http.conf) 反代到独立 admin 域名 + basic auth。

## 4. 部署方后台与邀请码

- 后台地址：`https://127.0.0.1:19444/__admin/`（经 SSH 隧道/nginx 反代访问）；
- admin token 首次启动自动生成到 `data/admin-token`（0600），也可显式设 `RELAY_ADMIN_TOKEN`：

  ```bash
  docker exec dsh-relay-group node packages/relay/bin/relay.js admin-token --config /data/config/relay.json
  ```

- 生成邀请码（后台「生成邀请码」或 CLI）：

  ```bash
  docker exec dsh-relay-group node packages/relay/bin/relay.js invite create --note "friend A" --config /data/config/relay.json
  ```

  复制给群成员的是**邀请码本身（43 字符）**，不是列表里的 `inv_xxx` ID；
  后台列表里可随时复制；旧版本（哈希存储）的邀请显示「旧邀请码（不可显示）」，需重新生成。

## 5. 主机与 App

1. DSH 主机安装本分支 host-plugin（**0.2.5**）；DSH「设置 → 远程访问 → 群体服务」填：
   - 服务地址：`https://<relayDomain>:19443`（注册 API，不是控制面端口）；
   - 邀请码：后台生成的邀请码；
   - 点击「注册并连接」；成功后显示 hostId、隧道地址、连接状态。
2. 手机 App（**0.1.8**，iOS build 15）扫码配对：DSH「生成配对二维码」→ App 扫码 →
   桌面确认 → 进入主机。
3. 主机侧设备列表可随时撤销设备（relay 会话即时失效）；设备 lastSeen 在群体版鉴权成功时更新。
4. 可选推送：见 §6（自部署 APNs / 官方推送 hub）；主机不需要任何 Apple 凭据。

> 从旧版本升级：服务地址以前可能填的是控制面端口，请改成注册 API 地址并重新注册一次；
> 改过 `RELAY_GROUP_MOBILE_PORT` / `RELAY_GROUP_PUBLIC_CONTROL_PORT` 后，主机插件「重试连接」
> 会自动刷新注册信息（`POST /__group/refresh`），必要时重置注册。

## 6. 推送（可选：自部署 / 官方推送 hub）

推送由**服务端统一发送**，主机（朋友的电脑）不需要 Apple 开发者账号、不需要 `.p8`/Team ID/Key ID。
不配置 = 不推送（App 设置页会显示「服务器未开启推送」），其它功能不受影响。
实现契约：R2（官方 App 设备直连官方 hub）见
[`../docs/group-push-r2-contract.zh.md`](../docs/group-push-r2-contract.zh.md)（hub 0.3.0 / relay 0.4.0）；
O1 自部署推送（self）历史契约见 [`../docs/group-push-design.zh.md`](../docs/group-push-design.zh.md)。

按 App 来源自动走两条链路之一：

| App / 场景 | 推送链路 | relay 配置 | 部署方需要做什么 |
|---|---|---|---|
| 部署方自签 App（`self`） | 主机 → relay → 部署方自己的 APNs key | `MODE=self` + `data/apns/*.p8` | 见 §6.1 |
| 官方 App（R2；host-plugin ≥0.2.6） | App 向官方 hub 登记换 credential → 主机直连官方 hub | **不需要**（R2 与 relay 解耦） | 无需配置（官方 App 内置 hub 地址） |

> relay 0.4.0 起**只支持 self 推送**：legacy O1 的「relay 转发官方 hub」（`mode=official`、
> `relayId`/`relayTokenFile`、`data/hub-token`）已删除。官方 App 推送不经过任何部署方 relay。

hub 部署与运维（R2 设备登记 / 签名 key / 配额）：见 §6.5。

### 6.1 模式 A：自部署推送（部署方自己的 APNs key）

1. Apple Developer（付费）→ Keys → 新建 **Apple Push Notifications service (APNs)** key：
   - **Environment** 选 **Sandbox & Production**（只选 Sandbox 的 key 只能发开发签名包）；
   - **Key Restriction** 选 **Team Scoped (All Topics)**（或 Topic Specific 选 App 的 bundle id）；
   - 下载 `AuthKey_<KEY_ID>.p8`（只能下载一次），记下 Key ID；Team ID 在会员信息里。
2. 把 `.p8` 放进 relay 的 `data/apns/`（**不要进仓库**），并确保容器非 root 用户可读：

   ```bash
   cd server
   mkdir -p data/apns
   cp /path/to/AuthKey_<KEY_ID>.p8 data/apns/
   chmod 700 data/apns && chmod 600 data/apns/AuthKey_<KEY_ID>.p8
   chown -R 100:101 data/apns
   ```

3. 在 `.env.group` 里开启（`data/` 已整体挂到容器 `/data`，compose 另把 `data/apns` 只读挂载到 `/data/apns`）：

   ```bash
   RELAY_GROUP_PUSH_ENABLED=true
   RELAY_GROUP_PUSH_MODE=self
   RELAY_GROUP_PUSH_CONTENT=generic            # 想带会话标题/摘要再改 summary（锁屏可见，自行评估隐私）
   RELAY_GROUP_PUSH_APNS_KEY_FILE=/data/apns/AuthKey_<KEY_ID>.p8
   RELAY_GROUP_PUSH_APNS_KEY_ID=<KEY_ID>
   RELAY_GROUP_PUSH_APNS_TEAM_ID=<TEAM_ID>
   RELAY_GROUP_PUSH_APNS_TOPIC=<BUNDLE_ID>     # = 部署方自己签名的 App 的 bundle id
   RELAY_GROUP_PUSH_APNS_ENVIRONMENT=auto      # auto = 按 App 上报的签名环境选 sandbox/production
   ```

4. `docker compose --env-file .env.group -f docker-compose.group.yml up -d --force-recreate`
5. 验证：`/healthz` 出现 `"push":{"enabled":true,"mode":"self","tokens":N}`；
   手机 App 进入主机后设置页显示「推送已注册（自部署）」；DSH 一轮结束 / Agent 等待作答时手机收到通知。

> 环境范围必须覆盖 App 实际包：开发签名包只能发 `api.sandbox.push.apple.com`，发布/TestFlight 包只能发
> `api.push.apple.com`；`environment=auto` 会按 App 上报值选择。改了 bundle id / Team 之后要重新登记。

### 6.3 推送排障

| 现象 | 排查 |
|---|---|
| `/healthz` 里 `push.tokens=0` | App 没进入过该主机 / 通知权限被拒 / token 登记失败；看 App 设置页推送状态与主机日志 `push register` |
| 收到推送但点不开对应主机 | 通知的 `host` 与本地已存连接不一致（App 重装/重新配对后旧通知）；重新进主机即可 |
| 日志 `BadDeviceToken` / `DeviceTokenNotForTopic` / `InvalidProviderToken` | 配置错：topic 不是 App bundle id、environment 与签名包不符、Key ID/Team ID 错；**不会**删设备 token |
| relay 日志 `push result ... pruned=1` | 设备 token 已失效（App 卸载/重装）；App 重新进入主机会自动重登记 |
| relay 日志 `push_unavailable` | self 模式 APNs 私钥不可读/字段缺失；检查 `data/apns` 路径、0600/属主、Key ID/Team ID/topic |
| 收不到但 `/healthz` 正常 | 检查主机侧「设置 → 远程访问 → 推送提醒」是否开启、App 通知权限；看 relay 日志 `push trigger`/`push result` |
| App 登记推送失败，主机审计出现 `proxy-deny`（`/__dsh_remote/push-token`） | DSH 还在跑旧 host-plugin（<0.2.5，插件 link 后不热更新）：**重启 DSH 桌面端**加载 0.2.5 后，在 App 设置页点「重新注册」 |
| App 升级后仍收不到，`/healthz` 无 `push` 字段 | relay 还是 0.3.0 旧镜像（无推送代码）：按 §6.4 重建/加载 `dsh-remote-relay:0.4.0-group` 并更新 compose |
| 官方 App 设置页显示「官方推送暂不可用」/ 主机 `push.official.lastError` 有值 | hub 侧 `/v1/enroll*` 失败：看 hub `/healthz` 的 `credential.enabled`/`enroll.enabled` 与 hub 日志；错误码含义见 §6.5 排障表 |
| 主机日志 `push result` 里 official 401 `credential_expired` | credential 过期（默认 30 天，0.3.1 起；原 7 天）或 hub 签名 key 被轮换：App 重新进主机/回前台自动重新登记 |
| 主机 `/healthz` 的 `push.official.devices=0` | App 没走官方通道（检查打包 `EXPO_PUBLIC_PUSH_CHANNEL=official` / `EXPO_PUBLIC_PUSH_HUB`）、hub 不可达、或 bundleId ≠ hub `HUB_APNS_TOPIC` |
| hub 返回 429 `rate_limited` | 命中 R2 配额（token/credential/host/IP/全局）：看 429 message 的层级，等 `Retry-After` 或按 §6.5 调大 env |

### 6.4 已有部署升级注意（0.3.1 → 0.4.0，推送能力收窄）

- **relay 0.4.0 删除 official 转发**：`.env.group` / `relay.json` 里如果配过
  `RELAY_GROUP_PUSH_MODE=official`、`RELAY_GROUP_PUSH_HUB_*`、`group.push.official`、
  `data/hub-token`，升级前**删掉**（否则启动时配置校验会报错并给出提示）。
- 官方 App 推送不需要 relay 做任何事：R2 下 App 向官方 hub 登记、主机直连 hub；
  部署方无需 Apple 凭据、无需 relay 凭据。
- self 推送（部署方自己的 APNs key）行为不变：仍用 `RELAY_GROUP_PUSH_*` 的 self 一组配置。
- **同步新版 `docker-compose.group.yml`**（0.4.0 已去掉 `RELAY_GROUP_PUSH_HUB_*` 透传）；
  镜像换成 `dsh-remote-relay:0.4.0-group`。已有 `data/config/relay.json` 不用删
  （entrypoint 不覆盖），但要把其中 `group.push.official` 段删掉。
- 重建后 `/healthz` 的 `push.mode` 恒为 `self`（未开启推送时 `enabled=false`）。

### 6.5 R2 官方 hub 部署与运维（设备直连）

> 只有官方 hub 运营方需要；部署方 relay 不需要任何改动（R2 把官方推送与 relay 解耦）。
> 代码 [`../dsh-remoteService/packages/push-hub/`](../dsh-remoteService/packages/push-hub/README.md)，
> 契约 [`../docs/group-push-r2-contract.zh.md`](../docs/group-push-r2-contract.zh.md) §4/§4.5。

**部署**（server/ 目录下）：

```bash
cp .env.push-hub.example .env.push-hub
# 必填：HUB_PUBLIC_URL / HUB_APNS_KEY_DIR / HUB_APNS_KEY_ID / HUB_APNS_TEAM_ID / HUB_APNS_TOPIC
mkdir -p data/push-hub && chown -R 100:101 data/push-hub
docker compose --env-file .env.push-hub -f docker-compose.push-hub.yml up -d --build
curl -fsS http://127.0.0.1:19445/healthz
```

- `HUB_PUBLIC_URL` **必填**：= 官方 App 打包内置的 hub 公网地址（nginx https 域名），
  同时也是 device credential 的 `aud`；不设置时 hub 能启动但设备直连/enroll 全部禁用
  （`/healthz` 显示 `credential.enabled=false`/`enroll.enabled=false`）。
- nginx 示例 `server/nginx/push-hub-http.conf` 已包含 `/v1/enroll/challenge`、`/v1/enroll`、
  `/v1/push` 三个入口（`/healthz` 只允许本机/监控）与 per-IP 粗限速。
- `/data` 卷（`data/push-hub/`）只持久化 `push-hub-signing-key.pem`（Ed25519 签名 key，0600，
  首次启动自动生成）。**不要删签名 key**：删了已签发的 credential 全部失效（设备会重新登记，但没必要）。
- hub 不需要任何 relay 凭据 / relay 管理命令：官方 App 直接向 `/v1/enroll*` 登记。
- **离线镜像**（已在本机构建/导出，2026-11-08，linux/amd64；scp 到 VPS 后 load）：
  ```bash
  docker load -i dsh-push-hub-0.3.1-linux-amd64.tar   # server/dsh-push-hub-0.3.1-linux-amd64.tar
  # 62,635,008 bytes；sha256 97211f903903076dc796f274db299b94f34fb2efbc63ef842e93e4543f87804b
  docker compose --env-file .env.push-hub -f docker-compose.push-hub.yml up -d --no-build
  ```
  0.3.1 = R2-only + **credential 默认 TTL 30 天**（原 7 天；2026-11-08）；
  镜像内默认 `HUB_LISTEN_HOST=0.0.0.0` / `HUB_PORT=9445` / `HUB_SIGNING_KEY_FILE=/data/push-hub-signing-key.pem`（compose 会显式传同样值）。
- App 侧只需要官方构建注入 `EXPO_PUBLIC_PUSH_CHANNEL=official` + `EXPO_PUBLIC_PUSH_HUB=https://push.example.com`
  （由官方 hub 运营方提供地址，仓库默认 `self`）。

**接口/能力**（hub 细节见 push-hub README §4）：

| 路径 | 用途 | 鉴权 |
|---|---|---|
| `GET /healthz` | 能力/配额摘要（`credential.enabled` / `enroll.enabled` / `limits`） | 无（nginx 限本机/监控） |
| `POST /v1/enroll/challenge` | 官方 App 申请一次性 challenge（120s） | 无（按 IP/enroll 限速） |
| `POST /v1/enroll` | 设备 P-256 PoP 验签 → 签发 device credential（默认 30 天，0.3.1 起） | 设备私钥签名 |
| `POST /v1/push` | 推送（仅 device credential） | Bearer device credential |

**配额 env**（默认值 = 契约 §4.5；可按用户规模调整，超限统一 `429 + Retry-After`）：

| env | 默认 | 层级 |
|---|---|---|
| `HUB_ENROLL_PER_HOUR_PER_IP` | 20 | enroll / IP / 小时 |
| `HUB_ENROLL_PER_HOUR_PER_DEVICE` | 5 | enroll / 设备 token / 小时 |
| `HUB_CHALLENGE_PER_HOUR_PER_IP` | 60 | challenge / IP / 小时 |
| `HUB_PUSH_PER_MINUTE_PER_TOKEN` | 6 | R2 push / token / 分钟 |
| `HUB_PUSH_PER_DAY_PER_TOKEN` | 120 | R2 push / token / 天 |
| `HUB_PUSH_PER_MINUTE_PER_CREDENTIAL` | 6 | R2 push / credential / 分钟 |
| `HUB_PUSH_PER_MINUTE_PER_HOST` | 30 | R2 push / host / 分钟 |
| `HUB_PUSH_PER_MINUTE_PER_IP` | 60 | R2 push / IP / 分钟（nginx 后是共享桶，IP 级主要靠 nginx） |
| `HUB_PUSH_PER_MINUTE_GLOBAL` | 120 | R2 push / 全局兜底 |

计数器在内存：重启清零可接受（契约允许）；多实例部署时才需要共享存储。

**排障（R2）**：

| 现象 | 排查 |
|---|---|
| `/healthz` `credential.enabled=false` | `HUB_PUBLIC_URL` 未设置 / APNs 未配置（缺 topic）/ 签名 key 不可用；看 hub 启动日志（不含密钥） |
| `/healthz` `enroll.enabled=false` | 同上，或 `HUB_ENROLL_ENABLED=false` |
| App 登记报 `challenge_expired` / `challenge_used` | challenge 超过 120s / 已用过：App 重新申请（正常流程会自动重试一次） |
| App 登记报 `invalid_signature` | 设备 PoP 失败：检查 App 与协议 `pushEnrollMessage` 字节（UTF-8、`\n` 连接、无末尾换行）与设备密钥 |
| App 登记报 `unsupported_bundle_id` | App 的 bundleId ≠ hub `HUB_APNS_TOPIC`（官方签名包与 hub 配置不一致） |
| 主机推送 401 `invalid_credential` / `credential_expired` | credential 被改/过期/签名 key 换过：App 重新进主机/回前台自动重新登记 |
| 主机推送 401 `token_mismatch` | 主机上报的 APNs token 与 credential 绑定不一致：App 重新登记 |
| 主机推送 429 `rate_limited` | 命中配额：看 message 里的层级与 `Retry-After`，按需调大上表 env |
| App 收不到但主机 `status.push.official.devices ≥ 1` | 检查 hub 日志 `push: mode=device ... delivered=N`、APNs topic/key 与 App 签名环境（development/production） |

## 7. 验证与排障

### 7.1 基础验证

```bash
# relay 日志（正常应有 host online / device.sync / edge: request 等）
docker logs -f dsh-relay-group

# healthz（http 平面，默认宿主 127.0.0.1:18080；含 push 摘要）
curl -s http://127.0.0.1:18080/healthz

# 注册 API（无请求体应返回 400 JSON，而不是连接失败）
curl -sk -X POST https://<relayDomain>:19443/__group/register -H 'content-type: application/json' -d '{}'

# 边缘端口 TLS 证书（应返回通配证书）
openssl s_client -connect <relayDomain>:<mobilePort> -servername <hostId>.<relayDomain> </dev/null 2>/dev/null | openssl x509 -noout -subject
```

### 7.2 常见问题

| 现象 | 排查 |
|---|---|
| 容器反复重启、日志 `cannot read config file ... ENOENT` | 镜像启动会从 env 自动生成 `data/config/relay.json`；检查 `data/` 挂载与权限（`chown 100:101`） |
| 容器报「缺少 RELAY_DOMAIN」 | `docker compose` 没读到 env 文件：带 `--env-file .env.group`，或改名为 `.env`；`docker compose ... config | grep RELAY_DOMAIN` 自检 |
| 改了 env 但端口/镜像没变 | 需要 `up -d --force-recreate`（`restart` 不更新端口映射）；`docker inspect dsh-relay-group --format '{{.Config.Image}}'` 确认镜像 tag |
| 宿主端口仍是 0.0.0.0 | compose 文件缺少 `*_HOST_BIND` 变量行（用仓库最新 compose），或未重建容器 |
| 主机日志 `relay control socket error` | `RELAY_GROUP_PUBLIC_CONTROL_PORT` 必须等于主机实际连接的 nginx listen 端口；改后主机「重试连接」或重置注册 |
| 手机 App 配对后一直 401 | 先看 relay 日志是否有对应 `edge: request POST /__group/auth/...`；若 App 错误页响应体是 `{"ok":false,"error":"..."}`（字符串 error），说明请求被透传到主机，检查 relay 版本（≥0.3.0）与是否有多实例/代理复用连接 |
| App 能开页面但「暂无会话/一直重连」 | host-plugin 需 ≥0.2.0（loopback 明文代理已代理 WebSocket Upgrade）；确认 DSH 已重启加载新插件 |
| 设备列表「从未连接」 | host-plugin ≥0.2.0 在群体鉴权成功时更新 lastSeen；重启 DSH 后应正常 |
| 后台打不开 | 后台只绑回环：用 SSH 隧道或 nginx 反代；不要直接把 19444 暴露公网 |
| 手机/主机关联到旧端口 | `RELAY_GROUP_MOBILE_PORT`/`PUBLIC_CONTROL_PORT` 配错或未重建；主机「重置注册」重新拿二维码 |

### 7.3 与其它服务同机共存

如果这台机器已有别的网站/relay 占用 443/8443/1443/18443/18080，把 group 的内部端口
（`RELAY_GROUP_EDGE_HOST_PORT` / `RELAY_GROUP_CONTROL_HOST_PORT` / `RELAY_GROUP_HEALTH_HOST_PORT`）
改成 16xxx/18xxx 等空闲端口，公网端口仍按 nginx 实际 listen 填；nginx 的 `stream {}` 全局只有一份，
把 group 的 SNI 段合并进现有 stream 配置即可。group 必须有**自己的 relay 域名**与通配证书。

## 8. 升级、备份与安全

### 8.1 从旧版本升级（classic/单体版 → 群体版）

本分支已删除 classic 单机版；如果服务器上还跑着旧 relay（0.2.x / classic 镜像）：

1. `docker load` 新镜像 `dsh-remote-relay:0.4.0-group`（0.4.0：只保留 self 推送；official 转发已删除），改 `.env` 的 `DSH_RELAY_IMAGE`，`up -d --force-recreate`；
2. 旧 `data/config/relay.json` 会被保留（entrypoint 不覆盖）：里面的 classic 字段
   （`mode`/`dataPort`/`tokensFile`/`hostTokens`/`push`）在新版会被忽略并打 warn；建议对照
   `group/relay.group.example.json` 手动精简一次，或备份后删除让 entrypoint 重新生成；
3. `data/group.json`、`signing-key.pem`、`admin-token`、证书可沿用（主机注册/会话不丢）；
4. 主机插件升级到 **0.2.0** 后需重启 DSH；旧 classic 配置字段会被丢弃，群体服务地址/邀请码保留，
   必要时「重置注册」重新注册；App 升级到 **0.1.1** 后需重新扫码配对（旧 classic/单体连接会被丢弃）；
5. 升级后首次验证：relay `/healthz` 200、主机注册成功、App 配对→进入正常、前后台不再收到任何推送。

- **升级**：`docker load` 新镜像 → 改 `.env` 的 `DSH_RELAY_IMAGE` → `up -d --force-recreate`；
  改过镜像 tag/端口后必须重建容器。
- **备份**：整个 `data/`（`group.json` 主机/邀请码、`signing-key.pem` 会话 token 签名私钥、
  `admin-token`、证书）。`group.json` 含明文邀请码、`signing-key.pem`/`admin-token` 泄露等于
  身份泄露，**不要入库/上传/外发**。
- **安全**：边缘与注册 API 必须对群成员网络可达；后台只回环；admin token 只给部署方；
  不使用自签证书对外（手机会拒绝）；relay 机器被攻破等同于部署方被冒充，务必做好主机安全。

## 9. 相关文档

- 设计与安全决策：[`../docs/group-service-design.zh.md`](../docs/group-service-design.zh.md)
- 推送实现契约（两种模式/接口/安全）：[`../docs/group-push-design.zh.md`](../docs/group-push-design.zh.md)
- 官方推送 hub：[`../dsh-remoteService/packages/push-hub/README.md`](../dsh-remoteService/packages/push-hub/README.md)
- 落地问题与根因记录：[`../docs/diagnostics/12-group-service-issues.md`](../docs/diagnostics/12-group-service-issues.md)
- 主机插件：[`../dsh-remoteService/packages/host-plugin/README.md`](../dsh-remoteService/packages/host-plugin/README.md)
- 手机 App：[`../dsh-remoteApp/README.md`](../dsh-remoteApp/README.md)
