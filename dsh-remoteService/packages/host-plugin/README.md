# dsh-remote-service（主机插件）


> 许可证：**AGPL-3.0-or-later**（完整文本见根目录 [`LICENSE`](../../../LICENSE)）。
运行在 **DSH 主机** 上的远程访问插件，提供：

- 远程访问开关 / 中继连接配置
- 设备配对（二维码 + 一次性密钥 + 桌面 SAS 确认）
- 设备 mTLS 证书签发、设备列表、撤销、审计
- 对手机出示 `https://<hostId>.<relayDomain>/` 的 TLS 服务
- 通过 mTLS 反向代理到本机 DSH Web（`127.0.0.1:<port>`，不对外暴露）
- 连接自托管盲中继（relay）的控制面 `wss://relay:8443`
- 推送/审批/文件等宿主侧集成（见下）

服务端 relay 的部署见 [`../../../server/README.md`](../../../server/README.md)；
完整部署步骤见 [`../../docs/DEPLOY.md`](../../docs/DEPLOY.md)。

---

## 1. 安装到 DSH

插件通过 DSH profile 的本地 link / 包安装：

```bash
# 方式 A：在 DSH 桌面端插件管理里添加本地目录
#   仓库路径：dsh-remoteService/packages/host-plugin

# 方式 B：命令行（路径按实际仓库位置）
dsh plugin --profile desktop add link:/path/to/dshRemote/dsh-remoteService/packages/host-plugin
```

安装后在 DSH 中启用插件，重启 DSH 桌面端/Web 实例使 Host 半与 Client 半加载。

> 本插件已随 `dsh-remoteService` monorepo 开发；Host 半是 `index.js`，
> Client 半是 `client.js`（侧栏入口 + 设置页）。协议见 `packages/protocol`。

---

## 2. 配置

DSH 设置 → 远程访问：

| 字段 | 说明 |
|---|---|
| 启用远程访问 | 关闭后 relay 断开，手机不可访问 |
| 中继地址 | `wss://relay.example.com:8443`（自托管 relay 控制面） |
| 中继域名 | `relay.example.com`；主机域名是 `<hostId>.relay.example.com` |
| 主机 ID | `h_ab12cd34`，必须与 relay token 的 hostId 一致 |
| 手机访问端口 | `443`/留空 = 默认 443（nginx 模式）；直连 relay 数据面时填 `1443` |
| 中继主机令牌 | relay 端 `token create` 生成的一次性 token |
| 主机名称 | 手机/App 显示的主机名 |
| TLS 证书路径 | 主机子域证书 `fullchain.pem` 的本机绝对路径 |
| TLS 私钥路径 | 主机子域私钥 `privkey.pem` 的本机绝对路径 |
| 新设备配对需要本机确认 | 开启后，手机扫码后需在桌面点「允许」 |

### 证书从哪来

主机插件需要的是 **`<hostId>.relay.example.com`** 的证书（不是 `relay.example.com`）：

```bash
CF_Token="<Cloudflare token>" \
  ./dsh-remoteService/scripts/issue-host-cert.sh \
  h_ab12cd34 relay.example.com dns_cf
```

默认安装到：

```text
~/.dsh/remote-access/certs/fullchain.pem
~/.dsh/remote-access/certs/privkey.pem
```

插件每小时检查文件变化并热重建 TLS 监听；证书续期后无需重启 DSH。

### 直连端口模式（App 使用 `host:port`）

如果服务器 443 已被现有 nginx/业务占用，不想改 nginx stream，可以让 App 直接访问
relay 的公网数据端口：

1. 主机插件「手机访问端口」填公网数据端口，例如 `11443`；
2. 重启 DSH（Host 半必须重新加载）；
3. 重新生成配对二维码，host 会带端口：
   ```text
   h_ab12cd34.relay.example.com:11443
   ```
4. App 会直接访问 `https://<host>:11443/`；
5. 服务器防火墙/安全组需要放通该数据端口。

注意：

- 修改 `publicPort` 后**旧二维码不会更新**，必须重新生成；
- 数据面证书仍是主机插件自己的 `<hostId>.<relayDomain>` / `*.<relayDomain>` 证书；
- 不要把 relay 控制面证书当成主机数据面证书；
- 证书 SAN 必须覆盖主机子域：
  ```bash
  openssl x509 -in ~/.dsh/remote-access/certs/fullchain.pem \
    -noout -subject -ext subjectAltName
  ```

### 如果 DSH 主机运行在 Docker 中

把主机证书挂进 **DSH 容器**（不是 relay 容器）：

```yaml
volumes:
  - /srv/dsh/remote-access:/root/.dsh/remote-access:ro
```

插件里填容器内路径，例如 `/root/.dsh/remote-access/certs/fullchain.pem`。

---

## 3. 本机接口

Host 半注册在 DSH 本机 webServer：

| 路径 | 说明 |
|---|---|
| `/__dsh_remote/pair` | 手机配对（mTLS 前的有限例外） |
| `/__dsh_remote/pair/status` | 配对轮询 |
| `/__dsh_remote/status` | 主机状态（mTLS） |
| `/__dsh_remote/devices` | 设备列表/撤销（mTLS） |
| `/__dsh_remote/audit` | 审计（mTLS） |
| `/api/remote-access/*` | 本机管理 API（仅本机已认证 DSH 浏览器） |

管理 API 的完整契约见 [`../../docs/ADMIN-API.md`](../../docs/ADMIN-API.md)。
手机访问时会被反代到本机 DSH Web；`/api/remote-access/*` 对远程设备一律拒绝。

---

## 4. 安全边界

- 设备身份只来自 **mTLS 客户端证书**（Secure Enclave / AndroidKeyStore 私钥），
  不信任来源 IP、`X-Forwarded-For` 或自定义头。
- 主机 TLS 在插件内终止；relay 只透传 TLS 字节，不持有主机私钥。
- DSH Web 保持 `127.0.0.1`，插件剥离客户端头并注入本机 session cookie。
- 配对密钥一次性且短时有效；设备可撤销；管理 API 与配对路径有限速/deny list。
- 公网端口只应由 nginx/relay 暴露；不要直接暴露 DSH Web 或插件管理 API。

---

## 4.1 反向代理的 WebSocket 心跳桥（重要）

DSH Web 的 `/api/remote.mux` 每 **2s** 发 Ping，连续 2 个周期没有 Pong 就
`terminate()`。打开大会话时，`session/follow` 的首帧是**数 MB 的历史快照**
（单个 WS text message）；经 relay 慢速下行时 Ping/Pong 被排在这帧后面，
手机根本来不及在 ~6s 内 Pong → DSH 误判失联、踢掉 mux → 前端反复重连
（表现：载入历史很久/失败 + 画面反复跳）。

主机插件的反代因此内置了一个 **WS 心跳桥**（`lib/ws-keepalive.js` +
`lib/proxy.js`）：

1. 先按 `\r\n\r\n` 切出上游 101 响应头，之后才开始解析 WS 帧；
2. 收到 DSH 的 Ping 时立刻替隧道链路回一个 masked Pong（reactive）；
3. 检测到下行拥塞（代理暂停读上游 / 客户端 TLS 写缓冲 >64KB）时，**每秒主动**
   向 DSH 发一个 masked Pong（proactive）——因为拥塞时 Ping 本身被排在
   数 MB payload 后面，等看到 Ping 再回就已经超时；
4. 上游不是 101 时退化为纯字节透传，并记审计 `ws-upgrade-failed`。

安全语义：这只影响「半开 TCP 连接」的心跳清理；真正的客户端断开仍由 socket
close → `upstream.destroy()` 检测，mTLS/鉴权/deny list 全部不变。仅对
`/api/remote.mux` 生效。

> 该修复需要重启 DSH 才会加载新插件代码；手机无需重新配对。
> 相关根因与实验证据：[`docs/diagnostics/00-root-cause.md`](../../../docs/diagnostics/00-root-cause.md)。

---

## 4.2 会话切换的本地缓存（Client 半）

DSH Web 客户端采用引用计数式 retention：切换会话时旧会话实例（历史 + event stream）
会被销毁，切回时重新拉 `session/follow` 的整段快照。本机很快，但手机经 relay 访问时
一个大会话快照可达数 MB，表现为「每次切会话都重新同步」。

插件的 **Client 半**（`client.js`）在手机远程 WebView（`?dsh_mobile=1`）下为**最近
打开过的 3 个会话**额外保留一份客户端 retain：切走不销毁、切回直接复用（0 快照请求、
瞬间渲染），其 event stream 继续接收增量事件；超过 3 个按 LRU 释放；连接断开时只保留
当前会话（避免重连时放大快照流量）。可通过 `globalThis.__DSH_REMOTE_SESSION_CACHE__ = { max }`
调整数量（调试用）。

> 该改动是浏览器 bundle，随插件包由 host 提供：**不需要重新构建 App**；在 App 内刷新/
> 重开页面即可加载（若 DSH 缓存了启动 bundle，需重启 DSH 一次）。
> 细节与限制见 [`docs/diagnostics/04-session-switch-cache.md`](../../../docs/diagnostics/04-session-switch-cache.md)。

---

## 5. 排障

| 现象 | 检查 |
|---|---|
| 中继离线 | relay 8443 可达？token/hostId 正确？relay `/healthz` hosts 列表有该 hostId？ |
| 手机 401/403 | 设备证书是否签发/未撤销？主机证书是否过期？ |
| 配对二维码过期 | 重新生成；配对密钥 ≤120s |
| 证书续期不生效 | 插件每小时检查；关闭再启用强制重载 |
| 手机打开管理 API 403 | 这是安全边界；远程设备不允许管理 relay/配对 |
| App 扫描后“网络连接失败” | 先重新生成二维码；确认 host 带 `:端口`；再查 `*.relayDomain` 泛解析、手机代理/VPN、云安全组、主机数据面证书 SAN |
| 设置里 publicPort 又变回 0 | Host 半还是旧代码；重启 DSH；确认 `~/.dsh/remote-access/config.json` 有 `publicPort` |
| 主机在线但 App 连不上 | 控制面 8443 和数据面不是一条链路；看 [server/README.md §9.2](../../../server/README.md#92-主机显示在线但-app-配对网络连接失败) |
| 打开大会话「载入历史」很久/失败、画面反复跳 | ① 插件是否已重启加载新代码（旧代码没有 WS 心跳桥，慢链路上 mux 会被 DSH 心跳误杀）；② relay 带宽/线路是否过慢（4MB 历史快照 / 5Mbps ≈ 7s）；详见 [`docs/diagnostics/00-root-cause.md`](../../../docs/diagnostics/00-root-cause.md) |

---

## 6. 相关文档

- [relay / 服务器部署](../../../server/README.md)
- [完整部署指南（DNS-01/acme.sh/运维）](../../docs/DEPLOY.md)
- [管理 API](../../docs/ADMIN-API.md)
- [根目录 README](../../../README.md)
