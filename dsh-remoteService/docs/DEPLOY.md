# 方案 B2 自托管部署指南（relay + 主机插件 + 域名）

> 目标形态：自建 relay（VPS + 自有域名）+ 本机 DSH 插件 + 手机 App。
> relay **盲转发**：443 只做 TLS 透传，看不到明文、也不持有主机子域证书；主机 TLS 在插件内终止；设备用 mTLS 客户端证书认证。
> 本文所有 `relay.example.com` / `h_ab12cd34` 都是占位，替换成你自己的域名与 hostId。

---

## 0. 前置条件

| 项 | 要求 |
|---|---|
| 域名 | 一个可管理 DNS 的域名（推荐 `relay.example.com`） |
| VPS | 公网 IPv4，开放 **80/tcp、443/tcp、8443/tcp**；1 vCPU / 1 GB 足够（单用户） |
| 主机 | 跑 DSH 的 Mac；`dsh` CLI 可用；Node 24（DSH 自带运行时）；`openssl`（签发 P-256 设备证书用，macOS/Linux 默认有） |
| 证书 | 两个名字：`relay.example.com`（relay 控制面）与 `<hostId>.relay.example.com`（主机插件） |
| DNS API | 推荐 Cloudflare / 阿里云等，供 acme.sh 做 **DNS-01**（80 端口被 relay 的 301 占用，不能 HTTP-01） |

---

## 1. DNS 配置

| 记录 | 值 |
|---|---|
| `relay.example.com` | `A` → VPS 公网 IPv4 |
| `*.relay.example.com` | `A` → VPS 公网 IPv4（**必须**，主机子域靠泛解析） |

- 只有 IPv4 时不要加 AAAA（否则部分客户端可能走 IPv6 连不上）。
- `<hostId>` 是子域第一段（DNS label），例如 `h_ab12cd34.relay.example.com`。

---

## 2. 部署 relay（VPS）

### 2.1 控制面证书（relay 自己用）

```bash
# 示例：Cloudflare DNS API（token 只需 Zone.DNS Edit）
export CF_Token="<cloudflare-api-token>"
acme.sh --issue --dns dns_cf -d relay.example.com --keylength ec-256
acme.sh --install-cert -d relay.example.com \
  --fullchain-file /etc/dsh-relay/certs/fullchain.pem \
  --key-file       /etc/dsh-relay/certs/privkey.pem \
  --reloadcmd      "docker restart dsh-relay 2>/dev/null || systemctl reload-or-restart dsh-relay"
```
> 只需 `relay.example.com` 这一张证书；**不要**在 relay 上给主机子域申请证书（B2 由主机插件自己申请）。

### 2.2 Docker Compose（推荐）

```bash
# 把仓库放到 VPS（或只拷贝 dsh-remoteService/packages/relay + packages/protocol）
cd dsh-remoteService/packages/relay
mkdir -p data/config data/certs/relay.example.com
cp relay.example.json data/config/relay.json
# 编辑 data/config/relay.json：domain / tls.certFile / tls.keyFile 指向 /data/... 
cp /etc/dsh-relay/certs/fullchain.pem data/certs/relay.example.com/
cp /etc/dsh-relay/certs/privkey.pem   data/certs/relay.example.com/
chown -R 1000:1000 data

docker compose up -d --build
docker compose logs -f relay
```

### 2.3 创建主机 token（每台主机一个）

```bash
docker compose exec relay node packages/relay/bin/relay.js token create h_ab12cd34 \
  --config /data/config/relay.json
# 输出一次性明文 token；把它配到 DSH 插件设置里（hostToken 字段）
# token 落盘在 data/tokens.json（0600）；轮换：token revoke + token create
```

### 2.4 健康检查

```bash
curl -s http://127.0.0.1/healthz
# {"ok":true,"domain":"relay.example.com","hosts":["h_ab12cd34"]}
```

### 2.5 systemd（不用 Docker 时）

参考 `packages/relay/README.md` §5 的 unit 示例；要点：非 root + `CAP_NET_BIND_SERVICE` + `ProtectSystem=strict` + `Restart=on-failure`。

### 2.6 防火墙

只放行 80/443/8443（以及 SSH 管理端口）。**不要**把 8443 暴露给无关来源；relay 自身没有 web 管理后台。

---

## 3. 主机侧证书（B2：主机侧 DNS-01）

目标名字：`<hostId>.relay.example.com`。私钥只保存在主机（`~/.dsh/remote-access/certs/`），relay 永不接触。

```bash
mkdir -p ~/.dsh/remote-access/certs

# 示例：Cloudflare（token 只给 Zone.DNS Edit；也可用阿里云/Route53 等 acme.sh dnsapi）
export CF_Token="<cloudflare-api-token>"
acme.sh --issue --dns dns_cf -d h_ab12cd34.relay.example.com --keylength ec-256
acme.sh --install-cert -d h_ab12cd34.relay.example.com \
  --fullchain-file "$HOME/.dsh/remote-access/certs/fullchain.pem" \
  --key-file       "$HOME/.dsh/remote-access/certs/privkey.pem"
chmod 600 ~/.dsh/remote-access/certs/privkey.pem
```

> 插件会**每小时检查证书文件变化并在文件更新后自动重建 TLS 监听**（无需重启 DSH）；acme.sh 默认 cron 自动续期。
> **DNS API token 只放在主机**，不要放到 relay；这是 B2「relay 无法冒充主机」的关键。
>
> 也可以用仓库脚本一键完成（需先安装 acme.sh）：
> ```bash
> CF_Token="<cloudflare-api-token>" ./dsh-remoteService/scripts/issue-host-cert.sh \
>   h_ab12cd34 relay.example.com dns_cf
> ```

---

## 4. 安装并配置主机插件

### 4.1 安装

插件包：`dsh-remoteService/packages/host-plugin`（name: `dsh-remote-service`）。

```bash
# 方式 A：从本地目录安装（开发/内网分发）
dsh plugin --profile desktop add /path/to/dsh-remoteService/packages/host-plugin

# 方式 B：发布到 npm / GitHub 后
dsh plugin --profile desktop add github:<you>/dsh-remote#<commit>
```

> ⚠️ 安装前**完全退出 Desktop App**（或先停掉目标 profile 的 DSH 进程），安装后重启；不要在运行中安装。
> 选择你自己的主机形态（二选一，不要同时跑两个共享同一 `$DSH_HOME` 的 DSH 实例）：
> - **Desktop App 常开**：安装到 `--profile desktop`（最简单）。
> - **独立 `dsh web` + launchd 常驻（远程更稳）**：安装到 `--profile web`，桌面端只作为本机客户端。

### 4.2 通过 UI 配置

1. 打开 DSH → 侧栏底部「远程访问」（账号行上方）→ 设置页；
2. 填写：
   - relay URL：`wss://relay.example.com:8443`
   - 中继域名：`relay.example.com`
   - hostId：`h_ab12cd34`
   - host token：relay 生成的 token（保存后不再回显）
   - 主机名：如 `Jiayu 的 Mac`
   - TLS 证书 / 私钥：`~/.dsh/remote-access/certs/fullchain.pem` / `privkey.pem`
   - 打开「启用远程访问」；按需打开「配对需要桌面确认」
3. 保存后入口状态点应变绿（中继在线）；若红，检查 relay 8443 可达性与 token。

### 4.3 通过管理 API 配置（可选/自动化）

```bash
# 先从 dsh web 启动日志拿到 tokenized URL，换取浏览器 cookie
curl -c /tmp/dsh.cookies -o /dev/null "http://127.0.0.1:3080/?token=<TOKEN>"
curl -b /tmp/dsh.cookies -X POST http://127.0.0.1:3080/api/remote-access/config \
  -H 'content-type: application/json' \
  -d '{"enabled":true,"relayUrl":"wss://relay.example.com:8443","relayDomain":"relay.example.com","hostId":"h_ab12cd34","hostToken":"<TOKEN>","hostName":"Jiayu 的 Mac","tlsCertFile":"/Users/you/.dsh/remote-access/certs/fullchain.pem","tlsKeyFile":"/Users/you/.dsh/remote-access/certs/privkey.pem","requireApproval":true}'
```

### 4.4 macOS 常驻（launchd，推荐远程主机形态）

模板见 `../deploy/launchd/com.dsh.web.plist`：

```bash
# 1) 确认 dsh 的绝对路径
which dsh
# 2) 编辑模板里的 <YOU> / DSH_BIN / DSH_HOME 后安装
cp ../deploy/launchd/com.dsh.web.plist ~/Library/LaunchAgents/com.dsh.web.plist
launchctl load -w ~/Library/LaunchAgents/com.dsh.web.plist
# 3) 状态与日志
launchctl list | grep com.dsh.web
tail -f /tmp/dsh-web.err.log
```

> 该实例固定 `127.0.0.1:3080`，远程访问插件只 bind loopback，因此无需也不应把它改成公网监听。
> **不要**同时运行 Desktop App 与这个实例共享同一个 `$DSH_HOME`。

---

## 5. 手机 App 配对

1. 入口点「配对新设备」→ 弹出二维码 + 12 位备用码 + 主机指纹 + SAS；
2. 手机安装 `dsh-remoteApp`（构建见 `dsh-remoteApp/README.md`），扫码；
3. 若开启「配对需要桌面确认」：手机显示 pending，桌面弹窗显示同一 SAS，点「允许」（App 轮询后拿到设备证书）；
4. 配对成功：手机获得设备证书（私钥在 Secure Enclave/Keystore），WebView 打开 `https://<hostId>.relay.example.com/`。

> 远程 UI 上 **DeepSeek 账号登录不可用**（loopback-only 回调）；账号操作请在主机完成，手机端只消费已登录状态。

---

## 6. 运维

| 项 | 做法 |
|---|---|
| 证书续期 | relay：acme.sh cron + reloadcmd；主机：acme.sh cron，插件自动热加载 |
| token 轮换 | relay `token revoke <hostId>` + `token create <hostId>`；插件设置填新 token 保存（会重连） |
| 设备撤销 | 入口/设置页「设备列表 → 撤销」，立即断链；丢手机第一时间撤销 |
| relay 升级 | `docker compose build && up -d`；证书/token 在 data 卷 |
| 备份 | 只备份 relay `data/{config,tokens.json,certs}` 与主机 `~/.dsh/remote-access/`（devices/审计/证书）；不要备份到公网 |
| 监控 | `GET /healthz`（80 端口）+ 主机入口状态点；建议外部 uptime 探针 |
| 主机休眠 | 远程不可用；桌面「防止睡眠」/常开设备（Codex 同样要求） |
| 日志 | relay 不记内容；主机 audit.jsonl 只记动作/资源/哈希，0600 |

## 6.1 推送提醒（可选，零正文）

本仓库实现了「host 插件触发 → relay → APNs/FCM/Expo」的**内容无关**推送链路（POC 先接 Expo Push）：

1. 在 Expo 项目里为 App 配置 EAS projectId（App 侧 `EXPO_PUBLIC_EAS_PROJECT_ID`），并上传 APNs/FCM 凭据到 Expo（Expo 文档步骤）。
2. relay 配置（`relay.json` 或环境变量）：
   ```json
   { "push": { "enabled": true, "endpoint": "https://exp.host/--/api/v2/push/send",
               "title": "DSH", "body": "有任务需要你" } }
   ```
   也可用 `RELAY_PUSH_ENDPOINT / RELAY_PUSH_ACCESS_TOKEN / RELAY_PUSH_TITLE / RELAY_PUSH_BODY`。
3. 主机插件设置（管理 API 或后续 UI）：`pushEnabled: true`（默认）、`pushCooldownSeconds: 30`。
   生效条件：手机在 App 内成功注册 push token（`POST /__dsh_remote/push-token`，mTLS）。
4. 触发：DSH 一轮结束/出错时，host 插件只发 `kind=attention`；relay 只发通用标题/正文，**不含会话名、消息、文件路径**。手机收到后自行连回来看详情。

> 安全边界：relay 只按 hostId 存不透明 token（内存，最多 20 台/主机），不存内容；推送 payload 不含任何业务信息；日志不含 token 明文。
> 当前状态：host/relay 链路与测试已完成；App 侧 JS 已接入 expo-notifications，但**原生 mTLS 请求（`requestWithClientCert`）与 EAS/APNs 凭据仍需在真机里程碑完成**。未完成前推送会返回 "native transport unavailable"，不打断主流程。

---

## 7. 安全红线（部署时逐条确认）

- [ ] 443 是 TLS 透传，relay 不终止内容 TLS；relay 不持有主机子域私钥
- [ ] 主机子域证书用 **B2 主机侧 DNS-01**，DNS API token 只在主机（review §4.8）
- [ ] 不要把 relay 域名/泛域名写进 `--trusted-host`/`trustedHosts`
- [ ] 不要 `dsh web --host 0.0.0.0`；DSH 仍只 bind loopback
- [ ] 手机/中继不持有 DSH launch token 或 30 天 cookie
- [ ] 配对一次一密（≤120s、单次）+ 桌面 SAS 确认；QR 里无长期 token
- [ ] 设备可撤销；丢手机走撤销流程
- [ ] 推送只用通用可见文案（不含内容）；relay token 仅内存、日志不含 token；日志/崩溃报告不含 token/正文
- [ ] relay 与主机不共享 `$DSH_HOME`；relay 容器非 root/最小权限
- [ ] 802/8443 防火墙最小放行；relay 控制面证书有效（不要 `--dev` 上公网）

---

## 7.1 部署自检

```bash
./scripts/check-deploy.sh relay.example.com h_ab12cd34
```
依次检查 DNS（含泛解析）、relay `/healthz` 里的 hostId、8443 可达性、relay 控制面证书、主机子域证书（经 relay 透传握手）。

---

## 8. 排障

| 现象 | 检查 |
|---|---|
| 入口红点「中继离线」 | relay 8443 可达？hostId/token 正确？relay `healthz` hosts 里有该 hostId？ |
| 手机扫码后连不上 | `<hostId>.relay.example.com` 解析到 relay？主机插件证书是否覆盖该名字？插件是否 enabled？ |
| 配对 pending 一直不通过 | 桌面入口是否弹出确认？`requireApproval` 设置？SAS 是否两边一致？ |
| 配对 409/410 | 二维码过期（120s），重新生成 |
| 手机打开 UI 401/403 | 设备证书是否已签发/未撤销？主机证书是否过期？ |
| WebSocket 不工作 | 反代/防火墙是否允许 443 长连接；查看主机 audit 里 ws-upgrade 结果 |
| 证书续期后不生效 | 插件每小时检查文件；或关闭再启用远程访问强制重载 |

---

## 9. 相关文档

- `packages/relay/README.md`：relay 的 CLI/DNS/证书/systemd/健康检查细节
- `docs/ADMIN-API.md`：本机管理 API 与隧道 API 契约
- `docs/POC-REPORT.md`：本地 POC 结果与未验证项
- `../../docs/remote-access-evaluation.zh.md`：方案评估与安全设计（B1/B2/B′ 的取舍）
