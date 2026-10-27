# DSH Remote · 服务器（relay + nginx 生产部署）

本目录负责 **公网服务器** 的编排与配置，是 DSH Remote 三段式架构中的「中继层」：

```
iPhone App ──mTLS──► <hostId>.relay.example.com:443 ──► nginx / relay ──透传──► 主机插件
主机插件   ──WSS───► relay.example.com:8443
```

- **relay 是盲中继**：443 只按 SNI 转发 TLS 字节，不持有主机子域私钥、看不到明文。
- **主机插件** 才终止 `<hostId>.relay.example.com` 的 TLS，并校验手机设备证书。
- **relay 控制面** 自己持有 `relay.example.com` 的证书，供主机插件连接 `wss://relay.example.com:8443`。

> 主机插件、App、协议细节见：
> - [主机插件 README](../dsh-remoteService/packages/host-plugin/README.md)
> - [App README](../dsh-remoteApp/README.md)
> - [服务端 monorepo README](../dsh-remoteService/README.md)
> - [完整部署指南（DNS/acme.sh/主机侧）](../dsh-remoteService/docs/DEPLOY.md)

---

## 1. 目录

```text
server/
├── docker-compose.yml            # 模板 A：使用已有 relay 镜像
├── docker-compose.build.yml      # 模板 B：从源码构建 relay 镜像
├── docker-compose.nginx.yml      # 模板 C：可选叠加 nginx 容器
├── docker-compose.direct.yml     # 模板 D：直连数据端口，不动 nginx 443
├── docker-compose.group.yml      # 模板 E：群体服务版（A 模式）
├── .env.example                  # classic：复制为 .env
├── .env.group.example            # group：复制为 .env.group（配合 --env-file）
├── group/relay.group.example.json # group：复制为 data/config/relay.json
├── nginx/
│   ├── host-nginx-stream.conf    # classic：已有宿主机 nginx 的 443/8443 L4 透传
│   ├── group-nginx-stream.conf   # group 独立服务器：443/8443 L4 转发（relay 自己终止 TLS）
│   ├── host-nginx-stream.combined.conf # classic + group 同机：合并版 stream（SNI 分流，只 listen 一次）
│   └── container-nginx.conf      # 专用服务器：compose 内 nginx
├── data/                         # git ignore：tokens、relay 配置、证书
└── certs/                        # git ignore：可选挂载证书
```

---

## 2. 前置条件

| 项 | 说明 |
|---|---|
| 域名 | `relay.example.com` + `*.relay.example.com` 都解析到 VPS |
| VPS | 公网 IPv4；放行 80/443/8443（按需） |
| Docker | Docker 24+ / Docker Compose v2 |
| nginx | 宿主机已有 nginx（推荐），或使用 compose 的 standalone nginx |
| 证书 | relay 控制面证书 `relay.example.com`；主机子域证书在主机侧签发 |
| DNS | 建议用 DNS-01（Cloudflare/阿里云等）；80 端口由 nginx 管理，不走 HTTP-01 |

DNS 记录：

```text
relay.example.com        A  <VPS IP>
*.relay.example.com      A  <VPS IP>
```

---

## 3. 准备 relay 控制面证书

在服务器（或能写 DNS API 的机器）上签发 `relay.example.com`：

```bash
export CF_Token="<cloudflare-token>"   # 只给 Zone.DNS Edit
acme.sh --issue --dns dns_cf -d relay.example.com --keylength ec-256

mkdir -p data/certs/relay.example.com
acme.sh --install-cert -d relay.example.com \
  --fullchain-file "$PWD/data/certs/relay.example.com/fullchain.pem" \
  --key-file       "$PWD/data/certs/relay.example.com/privkey.pem" \
  --reloadcmd      "docker restart dsh-relay"
```

> **不要**用这张证书给 `<hostId>.relay.example.com`。主机子域证书在 DSH 主机侧用
> `scripts/issue-host-cert.sh` 签发，私钥只留在主机。

---

## 4. 启动 relay（三份模板按需选择）

```bash
cd server
cp .env.example .env
# 编辑 .env：RELAY_DOMAIN / RELAY_HOST_ID / 端口 / DSH_RELAY_IMAGE
```

| 场景 | 使用文件 | 命令 |
|---|---|---|
| **已有镜像**（离线/生产推荐） | `docker-compose.yml` | `docker compose up -d relay` |
| **纯源码编译** | `docker-compose.build.yml` | `docker compose -f docker-compose.build.yml up -d --build` |
| **直连端口（不动 nginx 443）** | `docker-compose.direct.yml` | `docker compose -f docker-compose.direct.yml up -d` |
| 已有镜像 + 内置 nginx | `docker-compose.yml` + `docker-compose.nginx.yml` | `docker compose -f docker-compose.yml -f docker-compose.nginx.yml up -d` |
| 编译 + 内置 nginx | `docker-compose.build.yml` + `docker-compose.nginx.yml` | `docker compose -f docker-compose.build.yml -f docker-compose.nginx.yml up -d --build` |

已有镜像的先加载：

```bash
docker load -i dsh-relay-0.1.0-linux-amd64.tar
```

查看日志：

```bash
docker compose logs -f relay
```

> 镜像默认 CMD 带 `--config /data/config/relay.json`；本模板已用
> `command: ["node", "packages/relay/bin/relay.js"]` 覆盖为纯环境变量模式，
> 不需要准备 `data/config/relay.json`。

relay 只监听宿主机回环地址：

| 宿主机端口 | 容器端口 | 用途 |
|---|---|---|
| `127.0.0.1:1443` | 443 | 数据面 TLS 透传（给 nginx） |
| `127.0.0.1:18443` | 8443 | 控制面 WSS（给 nginx） |
| `127.0.0.1:18080` | 80 | `/healthz`、301（可选） |

公网 443/8443 由 nginx 接管，**不要**把 relay 端口直接暴露到公网。

### 4.0 需要映射哪些目录

relay 容器**只需要映射 `/data`**：

| 宿主机路径 | 容器路径 | 内容 |
|---|---|---|
| `./data` | `/data` | `certs/`、`tokens.json`（以及可选的 `config/`） |

不需要挂载源代码、`node_modules`、`.env` 或 nginx 配置：代码/依赖已打进镜像，
`.env` 由 Docker Compose 在宿主机读取并注入环境变量。

如果使用 `docker-compose.nginx.yml` 叠加 nginx 容器，额外挂载：

| 宿主机路径 | 容器路径 | 内容 |
|---|---|---|
| `./nginx/container-nginx.conf` | `/etc/nginx/nginx.conf` | nginx 配置（只读） |

### 4.0.1 运行时 UID/GID（可选）

Docker 里的 `100:101` 只是**数字 ID**，和宿主机上的用户名没有对应关系。
compose 支持覆盖容器运行用户：

```yaml
user: "${RELAY_UID:-100}:${RELAY_GID:-101}"
```

`.env`：

```dotenv
# 宿主机上负责写 data 的用户
RELAY_UID=1000
RELAY_GID=1000
```

然后：

```bash
sudo chown -R 1000:1000 data
docker compose up -d --force-recreate relay
```

这样 relay 就会以宿主机用户 `1000:1000` 运行，`data/` 的属主也一致。

- 默认值是镜像内的 `relay(100:101)`；
- 不要用 `user: "0:0"` 让 relay 以 root 运行；
- 证书文件和 `tokens.json` 都需要该 UID/GID 可读/可写。

### 4.1 已有宿主机 nginx（推荐）

把 [`nginx/host-nginx-stream.conf`](nginx/host-nginx-stream.conf) 复制/安装到 nginx：

```bash
sudo cp nginx/host-nginx-stream.conf /etc/nginx/dsh-relay-stream.conf
# 在 /etc/nginx/nginx.conf 的 main 上下文（http 外面）加：
# include /etc/nginx/dsh-relay-stream.conf;
```

**不要**为 `relay.example.com` 或 `*.relay.example.com` 创建 nginx 的
`http { server { ... } }` 网站，也不要在 nginx 上给这些域名配置证书或
`proxy_pass`：这些域名必须在 `stream` 层原样透传给 relay，由 relay/主机插件
终止 TLS。nginx 只需要负责 SNI 选路。

该文件做了两件事：

1. `443` 用 `ssl_preread` 读取 SNI：
   - `relay.example.com` / `*.relay.example.com` → `127.0.0.1:1443`（relay）
   - 其它域名 → `127.0.0.1:4433`（你现有 nginx HTTPS server）
2. `8443` 纯 TCP 转发到 `127.0.0.1:18443`（relay 控制面）。

因此需要把你现有 nginx 的 HTTPS server 从 `listen 443 ssl;` 改到内部端口：

```nginx
server {
    listen 127.0.0.1:4433 ssl;
    server_name example.com www.example.com;
    # 原有证书配置不变
}
```

检查并重载：

```bash
nginx -t
sudo nginx -s reload
curl -s http://127.0.0.1:18080/healthz
```

> nginx 必须带 `stream` 模块：`nginx -V 2>&1 | grep -- --with-stream`。
> 如果 nginx 不能加 stream，改用 HAProxy 或给 relay 单独一个公网 IP。

### 4.2 专用服务器：compose 内 nginx

```bash
# 先把 nginx/container-nginx.conf 里的 relay.example.com 改成你的域名
# 已有镜像：
docker compose -f docker-compose.yml -f docker-compose.nginx.yml up -d

# 或从源码构建：
docker compose -f docker-compose.build.yml -f docker-compose.nginx.yml up -d --build
```

此时 nginx 容器占用 80/443/8443，不再需要宿主机 nginx；配置同样只做 L4 透传，
TLS 证书仍由 relay / 主机插件各自持有。

> `container-nginx.conf` 里的 `http {}` 只负责 `/healthz` 和 80 跳转，**不是**
> relay 域名的网站；不需要再为 relay 域名增加 server block。

---

### 4.3 直连数据端口（不动现有 nginx 443）

如果服务器 443 已经被 nginx 业务占用，也不想改 nginx stream，可以让 App 直接访问
relay 的公网数据端口，由二维码告诉 App 端口号。

```bash
# 需要新镜像（ENTRYPOINT 自动 token）
docker load -i dsh-relay-0.1.0-linux-amd64.tar

cd server
cp .env.example .env
# 编辑：
#   RELAY_DOMAIN=relay.example.com
#   RELAY_HOST_ID=h_xxxx
#   RELAY_PUBLIC_DATA_PORT=1443
#   RELAY_PUBLIC_CONTROL_PORT=8443

docker compose -f docker-compose.direct.yml up -d
```

防火墙需要放通：

```text
1443/tcp  App → relay 数据面（TLS + mTLS）
8443/tcp  主机插件 → relay 控制面（WSS）
```

主机插件设置：

```text
中继地址      wss://relay.example.com:8443
手机访问端口  1443
```

生成配对二维码后，QR 里的 host 会是：

```text
h_xxxx.relay.example.com:1443
```

> 主机插件的 `publicPort` / pairing 逻辑更新后，需要重启一次 DSH 桌面端，
> 让 Host 半与 Client 半重新加载。

App 会直接访问 `https://h_xxxx.relay.example.com:1443/`，完全绕过 nginx 443。

- 现有 nginx 443 完全不动；
- 不需要 stream，也不需要 4433；
- 证书不变：仍覆盖 `<hostId>.<relayDomain>`；
- 非标准端口在少数网络可能被拦截，443 兼容性最好。

---

## 5. 主机 token（容器首次启动自动完成）

不需要再 `docker compose exec` 进容器执行 `token create`。镜像 ENTRYPOINT（源码 [packages/relay/relay-entrypoint.sh](../dsh-remoteService/packages/relay/relay-entrypoint.sh)）会在 relay 启动前
检查 `/data/tokens.json`，并按 `.env` 自动补齐 host token。

### 5.1 必填：RELAY_HOST_ID

```dotenv
RELAY_HOST_ID=h_ab12cd34
```

必须与主机插件里的「主机 ID」完全一致。

### 5.2 推荐：显式设置 RELAY_HOST_TOKEN

```dotenv
RELAY_HOST_TOKEN=<随机字符串>
```

生成方式（宿主机执行，不需要容器）：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

这个值同时填到主机插件「中继主机令牌」，两边一致即可。

### 5.3 不设置 RELAY_HOST_TOKEN 时

容器首次启动会自动生成随机 token：

- 写入 `data/tokens.json`
- 写入 `data/host-token.txt`（0600）
- 打印到 relay 启动日志

获取：

```bash
cd server
cat data/host-token.txt
# 或
docker compose logs relay | grep RELAY_HOST_TOKEN
```

然后填到主机插件。

### 5.4 已有 token 不会自动轮换

`data/tokens.json` 中已存在该 hostId 时，入口脚本不会覆盖它，避免每次重启
把主机踢下线。如果 `RELAY_HOST_TOKEN` 与文件中的值不一致，日志会提示，
但不会自动改。

需要主动轮换时：

```bash
cd server
docker compose exec relay \
  node packages/relay/bin/relay.js token create h_ab12cd34
```

### 5.5 验证

```bash
docker compose logs relay | head -30
cat data/tokens.json
```

relay 的 `/healthz` 里 `hosts` 列表要等主机插件实际连接后才会出现：

```bash
curl -s http://127.0.0.1:18080/healthz
# {"ok":true,"domain":"relay.example.com","hosts":["h_ab12cd34"]}
```

---

## 6. 主机插件配置

在 DSH 主机侧（不是服务器）填写：

| 字段 | 示例 |
|---|---|
| 启用远程访问 | 开 |
| 中继地址 | `wss://relay.example.com:8443` |
| 中继域名 | `relay.example.com` |
| 主机 ID | `h_ab12cd34` |
| 手机访问端口 | 443/留空 = nginx 443 模式；直连模式填 `1443` |
| 中继主机令牌 | 第 5 步生成的一次性 token |
| TLS 证书路径 | `~/.dsh/remote-access/certs/fullchain.pem` |
| TLS 私钥路径 | `~/.dsh/remote-access/certs/privkey.pem` |

主机子域证书覆盖 `h_ab12cd34.relay.example.com`，由主机侧 DNS-01 签发：

```bash
CF_Token="<token>" ../dsh-remoteService/scripts/issue-host-cert.sh \
  h_ab12cd34 relay.example.com dns_cf
```

> 插件每小时检查证书文件变化，续期后自动重建 TLS 监听，不需要重启 DSH。

---

## 7. 健康检查与排障

```bash
# relay 自身
curl -s http://127.0.0.1:18080/healthz
# 期望：{"ok":true,"domain":"relay.example.com","hosts":["h_ab12cd34"]}

# 主机子域 TLS（应看到主机插件自己的证书）
openssl s_client -connect relay.example.com:443 \
  -servername h_ab12cd34.relay.example.com </dev/null 2>/dev/null | openssl x509 -noout -subject

# 控制面
openssl s_client -connect relay.example.com:8443 -servername relay.example.com </dev/null 2>/dev/null | head -5
```

| 现象 | 检查 |
|---|---|
| App 打不开 / 握手失败 | DNS 泛解析；nginx SNI 映射；relay 是否在线；主机子域证书 |
| 主机插件显示「中继离线」 | `wss://...:8443` 是否被 nginx TCP 透传；token 是否正确 |
| 8443 能连但证书错误 | relay 控制面证书路径 / `.env` 的 `RELAY_DOMAIN` |
| 配对后 401/403 | 设备证书是否签发/撤销；主机插件是否启用 |
| 证书续期不生效 | relay 重启容器；主机插件等一小时或关闭再启用 |
| nginx reload 后 443 回落到默认站点 | `stream` 未 include / map 顺序 / 现有 HTTPS server 没改到 4433 |

---

## 8. 升级、备份与安全

```bash
# 升级 relay（使用已有镜像）
cd server
docker load -i dsh-relay-新版本-linux-amd64.tar
docker compose up -d --force-recreate relay

# 或从源码重新构建
docker compose -f docker-compose.build.yml up -d --build relay

# 备份（不要提交）
tar czf dsh-relay-backup-$(date +%F).tgz data/tokens.json data/certs data/config 2>/dev/null || true
```

安全红线：

- [ ] relay 端口只绑定 `127.0.0.1`（由 nginx 对外）
- [ ] relay 域名 / 主机子域在 nginx 上 **只做 TCP 透传**，不做 HTTP 反代/HTTPS 终止
- [ ] 私钥只在对应机器：relay 控制面私钥在服务器；主机子域私钥只在主机
- [ ] `.env`、`data/`、`certs/`、`*.pem` 永远不进 git
- [ ] 只放行 80/443/8443（以及 SSH），不直接暴露 Docker 端口
- [ ] 证书续期：acme.sh cron + relay 重启；主机插件自动热加载

---

## 9. 常见坑与排错（实战）

这些是本项目真实部署中踩过的坑。

### 9.1 relay 容器一直重启

| 日志 | 原因 | 修复 |
|---|---|---|
| `cannot load control-plane TLS certificate: ENOENT` | relay 控制面证书没放到 `server/data/certs/<RELAY_DOMAIN>/` | 把 `fullchain.pem` / `privkey.pem` 放到 `data/certs/<RELAY_DOMAIN>/` |
| `EACCES ... /data/.tokens.json...tmp` | `data/` 属主和容器运行 UID 不一致 | `chown -R <RELAY_UID>:<RELAY_GID> data`，或设置 `.env` 的 `RELAY_UID/GID` |
| `EACCES ... /app/packages/...` | 自定义镜像里 `/app` 文件对运行 UID 不可读 | 镜像构建时加 `chmod -R a+rX /app`；本项目镜像已包含 |
| `--config /data/config/relay.json` | 还在跑旧镜像 | `docker load` 新镜像后 `docker compose up -d --force-recreate relay` |
| `RELAY_HOST_ID 未设置` | `.env` 没被 compose 读取 | 在 `server/` 目录执行，确认 `docker compose config | grep RELAY_HOST_ID` |

### 9.2 主机显示在线，但 App 配对“网络连接失败”

主机在线只代表 **8443 控制面**通；App 走的是 **数据面端口**。

按顺序检查：

```bash
# 1. 二维码 host 是否带端口
# 应类似：h_ab12cd34.relay.example.com:11443

# 2. 公网 TLS（服务器外部执行）
openssl s_client -connect h_ab12cd34.relay.example.com:11443 \
  -servername h_ab12cd34.relay.example.com \
  -verify_hostname h_ab12cd34.relay.example.com </dev/null

# 3. 配对接口（不需要设备证书）
curl -i https://h_ab12cd34.relay.example.com:11443/__dsh_remote/pair \
  -X POST -H 'content-type: application/json' --data '{}'
```

常见原因：

1. **DNS 泛解析没配**
   ```text
   *.relay.example.com  A  <VPS IP>
   ```
   手机 Safari 打开配对地址提示“找不到服务器”时，先查这条。
2. **主机插件证书不对**
   - 数据面证书必须是 `h_ab12cd34.relay.example.com` 或 `*.relay.example.com`；
   - 不能是 relay 控制面证书或 `CN=xxx.local` 的开发证书；
   - 用 `openssl s_client ... | openssl x509 -noout -ext subjectAltName` 确认 SAN。
3. **扫的是旧二维码**
   - 修改 `publicPort` 后旧 QR 不会更新；
   - 必须重新「配对新设备」生成二维码。
4. **手机代理 / VPN / Private Relay**
   - 换蜂窝网络测试；
   - 关闭代理后重试；
   - 注意 Mac 上 `dig` 可能返回 `198.18.x.x` Fake-IP，不能代表公网 DNS。
5. **安全组没放通**
   - 1Panel/系统防火墙放通不等于云厂商安全组放通；
   - 直连模式要放通数据面和控制面端口。

### 9.3 公网 DNS / Fake-IP

代理软件（Clash/Surge 等）的 `198.18.0.0/15` 是 Fake-IP，不是真实服务器：

```bash
dig +short 你的主机子域
# 198.18.x.x  → 本机 DNS 被代理接管
```

绕过 DNS 测真实 IP：

```bash
curl -vk --resolve \
  h_ab12cd34.relay.example.com:11443:<VPS_IP> \
  https://h_ab12cd34.relay.example.com:11443/
```

### 9.4 nginx / 443 配置

- **不要**为 `relay.example.com` 或 `*.relay.example.com` 创建 nginx 网站、证书或 HTTP 反代；
- nginx 只做 **TCP/SNI 透传**；
- 如果使用 `stream { listen 443; }`，必须让出原 nginx 的 `http` 443：
  ```nginx
  listen 127.0.0.1:4433 ssl;   # 原站点改内部端口
  ```
- nginx 容器是 `network_mode: host` 时，relay 的 `127.0.0.1:1443/18443` 可直接访问；
- bridge 网络时，`127.0.0.1` 指容器自己，需改 `relay:443` 或 `host.docker.internal`；
- 不想动 443 时使用 `docker-compose.direct.yml` + 主机插件 `publicPort`，配套 DNS 和防火墙。

### 9.5 UID/GID 与权限

Docker 只看数字 UID/GID：

```bash
ls -ldn data
id -u
id -g
```

`data/` 属主必须与 compose 的 `user:` 一致：

```dotenv
RELAY_UID=1000
RELAY_GID=1000
```

```bash
chown -R 1000:1000 data
```

不要用 `user: "0:0"` 长期运行 relay。

### 9.6 主机在线但二维码没有端口

- 主机插件 `publicPort` 是 Host 半配置；
- 修改后必须**重启 DSH**，只刷新设置页不够；
- 重启后：

```bash
cat ~/.dsh/remote-access/config.json | jq .publicPort
```
  应为 `11443`/`1443`，不是 `0`。

---

## 10. 群体服务版（group 模式）部署（分支 `feat/group-service`）

> 与 main 的 classic（B2 盲中继）不同：group 模式由 relay **终止手机 TLS**（边缘通配证书），主机只做出站隧道、
> 用邀请码自助注册；relay 侧提供邀请码/主机管理后台 `/__admin`。设计见
> [`docs/group-service-design.zh.md`](../docs/group-service-design.zh.md)。**部署方可见明文，责任由部署方承担。**

镜像：`dsh-remote-relay:0.2.0-group`（构建产物；x86_64 离线包 `server/dsh-relay-0.2.0-group-linux-amd64.tar`）。

1. **准备环境变量模板**（不要复用 classic 的 `.env`）：

   ```bash
   cd server
   cp .env.group.example .env.group   # 改端口/镜像/日志；admin token 建议留空自动生成
   ```

2. **准备数据目录与证书**：

   ```bash
   cd server
   mkdir -p data/config data/certs/relay.example.com data/certs/wildcard
   cp group/relay.group.example.json data/config/relay.json    # 改域名/端口
   # 控制面证书（relay.example.com）→ data/certs/relay.example.com/{fullchain.pem,privkey.pem}
   # 边缘通配证书（*.relay.example.com）→ data/certs/wildcard/{fullchain.pem,privkey.pem}
   chown -R 100:101 data      # 镜像内 relay 用户 UID/GID
   ```

   **端口关系（必须分清三个端口）**：

   | 端口 | 直连（无 nginx） | 有 nginx 前置（推荐生产） |
   |---|---|---|
   | 手机实际访问（QR/注册下发） | `1443` | **`443`**（nginx listen） |
   | nginx listen | — | `443`（公网） |
   | relay 容器宿主映射 | `1443`（0.0.0.0） | `127.0.0.1:1443`（仅本机 nginx） |
   | 容器内 relay edge | `443` | `443` |

   规则：**`RELAY_GROUP_MOBILE_PORT`（= `group.mobilePort`）必须等于手机实际访问的公网端口**，
   不是容器宿主映射端口。常见错误：nginx 监听 443 → 转发 127.0.0.1:1443，却把 mobilePort 留成 1443，
   手机就会去连公网 1443（不可达/冲突）。容器宿主映射端口不要与 nginx listen 端口相同。
   直连形态下两者可以都是 1443；nginx 前置时必须让 nginx 用 443（或其它新公网端口）并把 mobilePort 改成同一个值。

3. **启动**（二选一）：

   ```bash
   # A. 本机构建并启动
   DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose --env-file .env.group -f docker-compose.group.yml up -d --build

   # B. 服务器离线镜像
   docker load -i dsh-relay-0.2.0-group-linux-amd64.tar
   docker compose --env-file .env.group -f docker-compose.group.yml up -d --no-build
   ```

   默认端口：宿主 `1443`（edge，手机访问）、`18443`（控制面：主机隧道+注册+后台）、`18080`（/healthz，默认只绑回环）。
   edge 和控制面需要公网可达（手机/主机从外网连）；控制面同时承载 `/__admin`，靠 admin token + 限速保护，
   如条件允许可用防火墙/安全组限制来源，或按下一小节用 nginx 统一入口。

   **与已有 nginx / classic relay 共存**：group 模式不需要 nginx 做 TLS 终止/证书（relay 自己终止手机 TLS）。
   nginx 只能有一份 `stream {}`，443/8443 每个端口只能 listen 一次，所以：

   - **只部署 group**（独立服务器）：用 [`nginx/group-nginx-stream.conf`](nginx/group-nginx-stream.conf)
     （listen 443/8443 → 容器映射端口，SNI 分流、不解密）；
   - **同机已有 classic**：用 [`nginx/host-nginx-stream.combined.conf`](nginx/host-nginx-stream.combined.conf)
     一份合并配置（classic/group/现有网站按 SNI 分流）；**不能**同时 include 两个单版本文件。
     group compose 的宿主端口也要避开 classic 已占用的 1443/18443，例如
     `RELAY_GROUP_EDGE_PORT_HOST=16443`、`RELAY_GROUP_CONTROL_PORT_HOST=19443`，并把
     `RELAY_GROUP_EDGE_BIND` / `RELAY_GROUP_CONTROL_BIND` 设为 `127.0.0.1`；
   - group 必须有**自己的 relay 域名**（不能用 classic 的域名，通配证书也不同）。

   合并模板里 8443 用 WSS 的 SNI 区分 classic/group 两个控制面；若两个 relay 域名相同则无法共用 8443，
   需要给 group 控制面换一个公网端口。

   **备份**：`data/` 里保存了 `group.json`（主机/邀请码）、`signing-key.pem`（设备会话 token 签名私钥）、
   `admin-token`（后台令牌）和证书；迁移/升级前备份整个 `data/`，其中 `signing-key.pem` 和 `admin-token` 不要泄露。

4. **后台**：浏览器打开 `https://<relayDomain>:18443/__admin/`，粘贴 admin token。
   token 首次启动自动生成在 `data/admin-token`（0600），也可显式设 `RELAY_ADMIN_TOKEN`：

   ```bash
   docker exec dsh-relay-group node packages/relay/bin/relay.js admin-token --config /data/config/relay.json
   ```

5. **邀请码**：后台「生成邀请码」，或 CLI：

   ```bash
   docker exec dsh-relay-group node packages/relay/bin/relay.js invite create --note "friend A" --config /data/config/relay.json
   ```

6. **主机**：装分支 host-plugin **0.1.17**，DSH「设置 → 远程访问 → 群体服务（实验）」填
   `https://<relayDomain>:18443` + 邀请码 → 注册并连接 → 生成 v2 配对二维码；手机 App 0.1.0 扫码配对。

> 安全提醒：group 模式下 relay 可见会话明文；admin token / `group.json` / `signing-key.pem` / `admin-token`
> 都在 `data/`（勿入库）；控制面不要直接暴露给群成员，只暴露 edge 端口。

## 11. 相关文档

- [完整部署指南](../dsh-remoteService/docs/DEPLOY.md)
- [管理 API 契约](../dsh-remoteService/docs/ADMIN-API.md)
- [协议与 relay 细节](../dsh-remoteService/packages/relay/README.md)
- [主机插件 README](../dsh-remoteService/packages/host-plugin/README.md)
- [根目录 README](../README.md)
