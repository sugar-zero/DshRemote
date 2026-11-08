# dsh-remoteService（群体服务版 · 服务端 monorepo）

> 许可证：**AGPL-3.0-or-later**（完整文本见根目录 [`LICENSE`](../LICENSE)）。

群体服务版（A 模式）的服务端实现：**relay（终止手机 TLS + 边缘鉴权 + 主机隧道 + 服务端集中推送）+
主机插件（DSH 主机，出站隧道 + loopback 明文代理 + 推送意图/设备 token 上报）+ 共享协议 +
官方推送 hub（可选，运营方部署）**。本分支不包含 classic 单机版（mTLS 盲中继）功能。

配套手机 App：[`../dsh-remoteApp`](../dsh-remoteApp)；公网部署：[`../server`](../server)；
设计与决策：[`../docs/group-service-design.zh.md`](../docs/group-service-design.zh.md)；
推送契约（R2 当前）：[`../docs/group-push-r2-contract.zh.md`](../docs/group-push-r2-contract.zh.md)
（O1 历史契约（self 推送仍有效）：[`../docs/group-push-design.zh.md`](../docs/group-push-design.zh.md)）。

## 包结构

```
packages/protocol/     # 群体版协议：QR v2、边缘鉴权常量、服务端集中推送常量、控制消息、
                       # 二进制流帧、challenge/token 签名与校验、cookie 解析
packages/apns/         # APNs HTTP/2 发送器（relay self 模式与官方推送 hub 共用，零依赖）
packages/host-plugin/  # DSH 主机插件：群体注册/刷新、控制面 WSS、设备同步、推送意图与
                       # 按设备分流（self → relay；official → 直连官方 hub）、device token /
                       # credential 转发（仅内存）、loopback 明文代理（HTTP + WebSocket upgrade）、
                       # 群体配对、桌面设置 UI
packages/relay/        # 群体版 relay：控制面 WSS、注册 API、部署方后台 /__admin、
                       # 边缘 TLS（通配证书）、challenge→token 鉴权、主机隧道、
                       # 推送（仅 self：部署方 APNs key 直连 Apple）
packages/push-hub/     # 官方推送 hub（owner 唯一部署）：R2 设备登记（P-256 PoP）/ EdDSA
                       # device credential / 配额限流 + 固定通用文案 APNs（R2-only，不识别 relay）
```

## 快速导航

| 内容 | 文档 |
|---|---|
| 部署 relay（证书/端口/nginx/后台/邀请码/**推送**） | [`../server/README.md`](../server/README.md) |
| 主机插件安装/配置 | [`packages/host-plugin/README.md`](packages/host-plugin/README.md) |
| relay 配置与运维 | [`packages/relay/README.md`](packages/relay/README.md) |
| 官方推送 hub（部署/CLI/API） | [`packages/push-hub/README.md`](packages/push-hub/README.md) |
| 手机 App | [`../dsh-remoteApp/README.md`](../dsh-remoteApp/README.md) |
| 推送实现契约（R2 官方推送/接口/安全） | [`../docs/group-push-r2-contract.zh.md`](../docs/group-push-r2-contract.zh.md) |
| 落地问题与根因记录 | [`../docs/diagnostics/12-group-service-issues.md`](../docs/diagnostics/12-group-service-issues.md) |

## 开发与测试

```bash
cd dsh-remoteService
npm install
npm test                    # 全部单元/集成测试（protocol/apns/host-plugin/relay/push-hub）
npm run validate:artifacts  # 部署产物静态校验（shell/Node 语法、JSON、compose）
```

## 安全边界（摘要）

- 设备身份只来自「配对注册的 P-256 设备公钥 + relay 签发的短时 token（15 分钟，native 续期）」；
  主机逐请求复验 token 并检查设备在册。
- relay 在 A 模式下终止手机 TLS（部署方可见明文，责任由部署方承担），是身份信任方；
  请部署在自己信任的服务器上。
- DSH Web 始终保持 `127.0.0.1` 回环，不暴露公网、不用 `--trusted-host`。
- 主机明文代理保留与 classic 一致的 deny list（`/connect`、`/oauth`、`/open-in-app*`、
  `/api/remote-access`、`/__dsh_remote/*` 等）。
- 撤销双保险：主机设备表删除 + relay 会话失效；控制连接断链立即生效。
- 邀请制注册（邀请码 + 限速 + 配额），不开放公开注册。
- 推送（R2 分流）：主机不持有任何 Apple 凭据与 hub 签名密钥。`self`（部署方自签 App）由主机经
  已鉴权控制连接上报意图与 device token，relay 用部署方自己的 APNs key 发送；`official`（官方 App）
  由 App 用设备密钥向官方 hub 换取 per-device credential，主机凭 credential 直连 hub
  （`POST {hubEndpoint}/v1/push`，只发 `kind + host + token`），relay 不参与。
  官方 hub 固定通用文案、**不接收会话内容**；relay/hub 都不持久化设备 token，主机 token/credential
  只在内存（status/日志/审计不含明文）。
