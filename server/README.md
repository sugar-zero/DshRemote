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
├── .env.group.example            # group：复制为 .env.group；同机 classic 时按顶部注释改端口
├── group/relay.group.example.json # group：复制为 data/config/relay.json
├── nginx/
│   ├── host-nginx-stream.conf    # classic：已有宿主机 nginx 的 443/8443 L4 透传
│   ├── group-nginx-stream.conf   # group 独立服务器：443/8443 L4 转发（relay 自己终止 TLS）
│   ├── host-nginx-stream.combined.conf # classic + group 同机：合并版 stream（SNI 分流，只 listen 一次）
│   ├── group-admin-http.conf     # group：后台 /__admin 的 nginx HTTP 反代（basic auth/IP 白名单）
│   ├── group-api-http.conf       # group：注册 API 的 nginx HTTP 反代（可选，注意 Host/限速）
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

镜像：`dsh-remote-relay:0.2.9-group`（构建产物；x86_64 离线包 `server/dsh-relay-0.2.9-group-linux-amd64.tar`）。

1. **准备环境变量模板**（不要复用 classic 的 `.env`）：

   ```bash
   cd server
   cp .env.group.example .env.group   # 改端口/镜像/日志；admin token 建议留空自动生成
   ```

2. **准备证书（配置由 .env 自动生成）**：

   ```bash
   cd server
   mkdir -p data/certs/relay.example.com data/certs/wildcard
   # 控制面证书（relay.example.com）→ data/certs/relay.example.com/{fullchain.pem,privkey.pem}
   # 边缘通配证书（*.relay.example.com）→ data/certs/wildcard/{fullchain.pem,privkey.pem}
   chown -R 100:101 data      # 镜像内 relay 用户 UID/GID
   ```

   在 `.env.group` 里设置 `RELAY_DOMAIN`（证书目录名跟它一致）；**首次启动会自动生成
   `data/config/relay.json`**（已存在则不会覆盖，可直接手改；模板见 `group/relay.group.example.json`）。
   证书路径不同时，用 `RELAY_TLS_CERT_FILE` / `RELAY_TLS_KEY_FILE` /
   `RELAY_GROUP_EDGE_CERT_FILE` / `RELAY_GROUP_EDGE_KEY_FILE` 指定（容器内路径）。

   **两张证书分别是什么**：

   | 目录 | 证书 | 覆盖域名 | 用途 |
   |---|---|---|---|
   | `data/certs/<RELAY_DOMAIN>/` | 控制面证书 | `<RELAY_DOMAIN>`（apex） | 主机 WSS 隧道、注册 API、部署方后台 |
   | `data/certs/wildcard/` | **边缘通配证书** | `*.<RELAY_DOMAIN>` | 手机访问 `<hostId>.<RELAY_DOMAIN>`；relay 用它终止手机 TLS |

   - `fullchain.pem` = 证书 + 中间链，`privkey.pem` = 对应私钥；生产必须用公网 CA（Let's Encrypt/ZeroSSL 等），
     手机才信任；自签只适合 POC。
   - 通配证书**只能 DNS-01 签发**（`*.domain` 无法用 HTTP-01）：
     `acme.sh --issue --dns dns_xxx -d '<RELAY_DOMAIN>' -d '*.<RELAY_DOMAIN>'`，再 install 到对应目录。
   - 也可以申请一张同时含 `<RELAY_DOMAIN>` 与 `*.<RELAY_DOMAIN>` 的 SAN 证书，
     把同一对文件复制到两个目录，省一张证书。
   - 私钥权限 `600`、目录 `700`，并确保容器用户（默认 uid 100）可读。

   **端口只分两类：★ 公网入口（要放行/转发） vs 内部端口（不要放行）**：

   | 变量 | 谁访问 | 直连（无 nginx） | nginx 前置（推荐） | ★ 要放行/转发？ |
   |---|---|---|---|---|
   | `RELAY_GROUP_MOBILE_PORT` | 手机 App | `1443` | `443`（= nginx listen） | ★ 是 |
   | `RELAY_GROUP_PUBLIC_CONTROL_PORT` | 主机 WSS 隧道 | `18443` | **nginx 实际 listen 端口**（示例 `8443`，可自定义如 `18446`） | ★ 是 |
   | `RELAY_GROUP_API_HOST_PORT` | 主机注册 API | `19443` | `19443` | ★ 是 |
   | `RELAY_GROUP_ADMIN_HOST_PORT` | 部署方浏览器 | `19444` | `19444` | ✗ 只绑回环，别放行 |
   | `RELAY_GROUP_EDGE_HOST_PORT` | 本机 nginx → relay | `1443` | `1443`（bind 127.0.0.1） | ✗ nginx 内部 |
   | `RELAY_GROUP_CONTROL_HOST_PORT` | 本机 nginx → relay | `18443` | `18443`（bind 127.0.0.1） | ✗ nginx 内部 |
   | `RELAY_GROUP_HEALTH_HOST_PORT` | 本机排障（/healthz） | `18080` | `18080`（同机 classic 改 18081） | ✗ 只回环 |

   容器内端口固定：edge=`443`、控制面 WSS=`8443`、注册 API=`9443`、后台=`9444`、healthz=`80`（不用改）。
   同机已有 classic 时：内部端口改 16443/18444/18081；**直连形态下 `RELAY_GROUP_MOBILE_PORT` /
   `RELAY_GROUP_PUBLIC_CONTROL_PORT` 也要同步改成 16443/18444**；nginx 前置形态保持 443/8443。

   规则：
   - **`RELAY_GROUP_MOBILE_PORT`（= `group.mobilePort`）必须等于手机实际访问的公网端口**，不是容器宿主映射端口
     （常见错误：nginx 监听 443 → 转发 127.0.0.1:1443，却把 mobilePort 留成 1443，手机会去连公网 1443）。
   - 注册 API 与控制面 WSS 必须分开：注册响应会下发 `controlUrl`，端口 = `RELAY_GROUP_PUBLIC_CONTROL_PORT`。
     **这个值必须等于主机实际连接的公网端口（nginx listen）**；relay 不会自动探测 nginx/端口映射
     （容器内 8443、宿主映射 18445 都不是公网端口）。改端口后主机要「重置注册」重新注册。
   - 后台只绑 `127.0.0.1:19444`；用 SSH 隧道或 [`nginx/group-admin-http.conf`](nginx/group-admin-http.conf) 反代到 admin 域名。
   - **nginx 前置时最简只转发两个端口**：公网 `443 → 127.0.0.1:1443`、`8443 → 127.0.0.1:18443`；
     API（19443）可以直接对公网，也可以用 nginx 反代（见下）；后台（19444）不要转发到公网。
   - **注册 API 也可以走 nginx**：它只有一个 `POST /__group/register`，不依赖 SNI/多域名路由，
     所以既可用 L4 转发，也可让 nginx 终止 TLS 后反代到 relay（nginx 作为客户端连
     `https://127.0.0.1:19443`）。用 HTTP 反代时：把 `RELAY_GROUP_API_HOST_BIND` 改为 `127.0.0.1`，
     nginx 上游证书校验可关闭（仅回环），并**必须**把 `Host` 设为 `<RELAY_DOMAIN>`——注册响应里的
     `controlUrl` 是用请求 Host 生成的，Host 错了主机回连隧道会失败。
     注意：relay 的注册限速按 TCP 来源 IP 统计，经反代后所有请求都来自 127.0.0.1，单 IP 限速会退化成共享桶，
     需要把 `registration.maxAttemptsPerMinute` 调大或接受这一点。示例见
     [`nginx/group-api-http.conf`](nginx/group-api-http.conf)。

   **常见问题：明明配了 `RELAY_DOMAIN`，容器仍报「缺少 RELAY_DOMAIN」**：
   `docker compose` 默认只读 `.env`，不读 `.env.group`。如果你把变量放在 `.env.group` 里，
   启动命令必须带 `--env-file .env.group`（或把文件改名为 `.env`）。自检：

   ```bash
   grep RELAY_DOMAIN .env .env.group 2>/dev/null
   docker compose --env-file .env.group -f docker-compose.group.yml config | grep RELAY_DOMAIN
   docker inspect dsh-relay-group --format '{{range .Config.Env}}{{println .}}{{end}}' | grep RELAY_DOMAIN
   ```

   第一/二步能看到值、第三步为空 → 说明启动容器时没带对 env 文件；`docker compose ... up -d --force-recreate` 重建。

   **常见问题：改了 `RELAY_GROUP_API_HOST_BIND=127.0.0.1`，`docker ps` 里还是 `0.0.0.0`**：

   ```bash
   grep -n 'RELAY_GROUP_API_HOST_BIND' docker-compose.group.yml
   docker compose --env-file .env -f docker-compose.group.yml config | grep -B4 'published: "19443"'
   docker compose --env-file .env -f docker-compose.group.yml up -d --force-recreate
   docker ps --filter name=dsh-relay-group --format '{{.Ports}}'
   ```

   - 第一步没有输出 → compose 文件是旧版（API 端口那行写死了 `0.0.0.0:`），
     改成 `"${RELAY_GROUP_API_HOST_BIND:-0.0.0.0}:${RELAY_GROUP_API_HOST_PORT:-19443}:9443"`；
   - 第二步 `host_ip` 是 `127.0.0.1`、但第四步仍是 `0.0.0.0` → 容器没重建（`restart` 不更新端口映射）；
   - 第二步也是 `0.0.0.0` → env 文件没被读取（工作目录 / `--env-file`）。
   - 容器**日志**里 relay 在 `0.0.0.0:9443` 监听是正常的（容器内必须这样，Docker 才能转发）；
     宿主机绑定地址只看 `docker ps` 的 `127.0.0.1:19443->9443/tcp`。

3. **启动**（二选一）：

   ```bash
   # A. 本机构建并启动
   DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose --env-file .env.group -f docker-compose.group.yml up -d --build

   # B. 服务器离线镜像
   docker load -i dsh-relay-0.2.9-group-linux-amd64.tar
   docker compose --env-file .env.group -f docker-compose.group.yml up -d --no-build
   ```

   **端口速查（`.env.group` 顶部也有同样一张表）**：
   - ★ 公网入口：`RELAY_GROUP_MOBILE_PORT`、`RELAY_GROUP_PUBLIC_CONTROL_PORT`、`RELAY_GROUP_API_HOST_PORT`；
   - ✗ 仅本机：`RELAY_GROUP_ADMIN_HOST_PORT`（回环）、`RELAY_GROUP_EDGE_HOST_PORT` / `RELAY_GROUP_CONTROL_HOST_PORT`
     （直连时对公网，nginx 前置时只绑 127.0.0.1 供 nginx 转发）。
   **不要把后台端口暴露公网**；也不要用防火墙封掉 WSS/API 来源（会挡主机）。

   **与已有 nginx / classic relay 共存**：group 模式不需要 nginx 做 TLS 终止/证书（relay 自己终止手机 TLS）。
   nginx 只能有一份 `stream {}`，443/8443 每个端口只能 listen 一次，所以：

   - **只部署 group**（独立服务器）：用 [`nginx/group-nginx-stream.conf`](nginx/group-nginx-stream.conf)
     （listen 443/8443 → 容器映射端口，SNI 分流、不解密）；
   - **同机已有 classic**：用 [`nginx/host-nginx-stream.combined.conf`](nginx/host-nginx-stream.combined.conf)
     一份合并配置（classic/group/现有网站按 SNI 分流）；**不能**同时 include 两个单版本文件。
     **就在同一个 `.env.group` 里改这几行**（主模板顶部也有同款注释块，不用另建模板）：
     `RELAY_GROUP_EDGE_HOST_PORT=16443`（让开 classic 1443）、`RELAY_GROUP_CONTROL_HOST_PORT=18444`
     （让开 classic 18443）、`RELAY_GROUP_HEALTH_HOST_PORT=18081`（让开 classic 18080），
     并把 `RELAY_GROUP_EDGE_BIND` / `RELAY_GROUP_CONTROL_BIND` 设为 `127.0.0.1`；
     `MOBILE_PORT` / `PUBLIC_CONTROL_PORT` 仍是 nginx 的 `443/8443`，不用动。
     手动对应关系：group 的端口要避开 classic 已占用的 1443/18443/18080，例如
     `RELAY_GROUP_EDGE_HOST_PORT=16443`、`RELAY_GROUP_CONTROL_HOST_PORT=18444`、
     `RELAY_GROUP_HEALTH_HOST_PORT=18081`，并把
     `RELAY_GROUP_EDGE_BIND` / `RELAY_GROUP_CONTROL_BIND` 设为 `127.0.0.1`
     （注册 API/后台默认 19443/19444，不与 classic 冲突）。
     **直连形态**还要把 ★ 端口同步改掉：`RELAY_GROUP_MOBILE_PORT=16443`、
     `RELAY_GROUP_PUBLIC_CONTROL_PORT=18444`（否则手机/主机会去连 classic 的 1443/18443）；
     **nginx 前置形态** ★ 端口保持 443/8443 即可。`.env.group` 第 3.5 节有完整对照；
   - group 必须有**自己的 relay 域名**（不能用 classic 的域名，通配证书也不同）。

   合并模板里 8443 用 WSS 的 SNI 区分 classic/group 两个控制面；若两个 relay 域名相同则无法共用 8443，
   需要给 group 控制面换一个公网端口。

   **备份**：`data/` 里保存了 `group.json`（主机/邀请码）、`signing-key.pem`（设备会话 token 签名私钥）、
   `admin-token`（后台令牌）和证书；迁移/升级前备份整个 `data/`，其中 `signing-key.pem` 和 `admin-token` 不要泄露。

4. **后台**：默认只绑回环，二选一访问（后台「生成邀请码」后要复制的是**43 字符邀请码**，
   不是列表里的 `inv_xxx` ID；生成后可在列表里随时复制）：
   - SSH 隧道：`ssh -L 19444:127.0.0.1:19444 <VPS>`，然后浏览器打开 `https://127.0.0.1:19444/__admin/`
     （证书是 relay 域名，需在 `/etc/hosts` 映射或忽略证书告警；也可用 `--resolve` / 本地 SOCKS）；
   - nginx 反代：按 [`nginx/group-admin-http.conf`](nginx/group-admin-http.conf) 暴露成 `admin.<domain>` 并加 basic auth。

   admin token 首次启动自动生成在 `data/admin-token`（0600），也可显式设 `RELAY_ADMIN_TOKEN`：

   ```bash
   docker exec dsh-relay-group node packages/relay/bin/relay.js admin-token --config /data/config/relay.json
   ```

5. **邀请码**：后台「生成邀请码」，或 CLI：

   ```bash
   docker exec dsh-relay-group node packages/relay/bin/relay.js invite create --note "friend A" --config /data/config/relay.json
   ```

6. **主机**：装分支 host-plugin **0.1.17**，DSH「设置 → 远程访问 → 群体服务（实验）」填
   **注册 API 地址** `https://<relayDomain>:19443` + 邀请码 → 注册并连接 → 生成 v2 配对二维码；手机 App 0.1.0 扫码配对。
   注册响应会下发控制面 `controlUrl`（公网 WSS 端口），主机据此连接隧道，不再从服务地址推导端口。
   **从旧版升级**（服务地址原来填控制面端口）：把主机的「服务地址」改成注册 API 地址并重新注册一次
   （旧的 group registration 里没有 `controlUrl`，会退回旧推导且注册路径在控制面已 404）。

### 生产服务器上的目录与文件命名

仓库里的 `docker-compose.group.yml` / `.env.group.example` 是为了和 classic 模板区分；
**Docker Compose 不关心文件名**，只关心 `-f` 指定的编排文件和 `--env-file`（或同目录 `.env`）。
到生产服务器上**建议改名成标准名**，直接 `docker compose up -d`：

```text
/opt/dsh-group/
├── docker-compose.yml      # = 仓库 server/docker-compose.group.yml
├── .env                    # = 仓库 server/.env.group.example（改端口/镜像/域名相关变量）
└── data/                   # 挂载进容器：config/relay.json、certs/、group.json、admin-token…
```

```bash
cd /opt/dsh-group
chmod 600 .env
docker load -i /path/to/dsh-relay-0.2.9-group-linux-amd64.tar
docker compose config          # 先确认变量插值（镜像/端口/挂载）
docker compose up -d --no-build
docker compose ps && docker compose logs -f relay
```

> **如果 JSON 文件名/镜像文件名还没改**：目录里同时保留 `docker-compose.group.yml` 和 `.env` 时，
> `docker compose` 找不到默认的 `docker-compose.yml`，必须带 `-f`；而 `.env` 的读取还依赖
> 工作目录/项目目录，最稳的写法是显式指定：
>
> ```bash
> cd /opt/dsh-group
> docker compose --env-file .env -f docker-compose.group.yml up -d --force-recreate
> ```
>
> 否则容易出现「.env 里明明配了 RELAY_DOMAIN，容器里却是空」的假象。

要点：

- 改名后 `.env` 会被自动读取；不在同目录时用 `docker compose --env-file /opt/dsh-group/.env -f ...`；
- 服务器上没有源码树时**不要带 `--build`**（compose 文件里的 `build:` 段只在显式 `--build` 或镜像不存在时才会触发；
  镜像已 `docker load` 就只跑 `--no-build`）；想彻底避免误构建可把 `build:` 段删掉；
- 同机同时跑 classic 和 group：放**两个不同目录**，各自 `docker-compose.yml` + `.env` 即可
  （文件里 `name: dsh-remote-group` / `dsh-remote-server` 已区分 project，`docker compose ls` 可看）；
- 不要把 `.env`、`data/`（含 group.json / signing-key.pem / admin-token / 证书）提交或打包上传后留在仓库里；
  `.env` 权限 `600`，`data/` 归容器运行的 UID/GID（默认 100:101）。

> 安全提醒：group 模式下 relay 可见会话明文；admin token / `group.json` / `signing-key.pem` / `admin-token`
> 都在 `data/`（勿入库）。
>
> **控制面端口（18443/8443）必须对主机公网可达**——主机要从各自网络连 WSS 隧道、调用注册接口，
> 和单机版 8443 的定位完全一样。它同时承载 `/__admin` 后台，这是和单机版唯一的差别：
> 后台靠 admin token + 失败限速保护，**不要公开宣传后台地址**，条件允许时用 nginx 前置
> basic auth / IP 白名单，或按需给后台单独域名反代；**admin token 只给部署方，不要发给群成员**。

## 11. 相关文档

- [完整部署指南](../dsh-remoteService/docs/DEPLOY.md)
- [管理 API 契约](../dsh-remoteService/docs/ADMIN-API.md)
- [协议与 relay 细节](../dsh-remoteService/packages/relay/README.md)
- [主机插件 README](../dsh-remoteService/packages/host-plugin/README.md)
- [根目录 README](../README.md)
