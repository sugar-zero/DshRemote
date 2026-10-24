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

## 5. 排障

| 现象 | 检查 |
|---|---|
| 中继离线 | relay 8443 可达？token/hostId 正确？relay `/healthz` hosts 列表有该 hostId？ |
| 手机 401/403 | 设备证书是否签发/未撤销？主机证书是否过期？ |
| 配对二维码过期 | 重新生成；配对密钥 ≤120s |
| 证书续期不生效 | 插件每小时检查；关闭再启用强制重载 |
| 手机打开管理 API 403 | 这是安全边界；远程设备不允许管理 relay/配对 |

---

## 6. 相关文档

- [relay / 服务器部署](../../../server/README.md)
- [完整部署指南（DNS-01/acme.sh/运维）](../../docs/DEPLOY.md)
- [管理 API](../../docs/ADMIN-API.md)
- [根目录 README](../../../README.md)
