# DSH Remote · 群体服务版（A 模式）

给 **DeepSeek Harness (DSH)** 增加「手机远程访问」能力的**群体服务版**：任何人可以自建一个
relay，邀约一小群朋友/同事把各自的 DSH 主机接入，用手机 App 扫码后远程访问自己的 DSH。

> **本分支（`feat/group-service`）是独立产品线，只包含群体服务功能**：
> relay 终止手机 TLS（A 模式）、设备密钥 + 短时 token 鉴权、邀请码自助注册、部署方后台、
> **推送**（官方 App：官方 hub 设备直连；自签 App：部署方 relay 用自己的 APNs key）。
> 分支上**不再包含** `main` 的 B2 盲中继 + 设备 mTLS（single-host/单体版）功能、主机本机 APNs
> 推送、mTLS 证书管理等经典能力；两套形态的协议/配置/App 均不互通。

## 组成

```
┌──────────────┐   https://<hostId>.<relayDomain>:<mobilePort>   ┌────────────────────────┐
│  手机 App     │ ──────────────────────────────────────────────► │  relay（部署方 VPS）     │
│  (token 鉴权) │   挑战 → 设备密钥签名 → 短时 token                │  边缘 TLS（通配证书）    │
└──────────────┘                                                 │  鉴权 + 反向隧道         │
        ▲                                                        └───────────┬────────────┘
        │ wss://<relayDomain>:<publicControlPort>（主机出站隧道）              │ 隧道
        └───────────────────────────────  主机插件（DSH 主机） ◄──────────────┘
                                           反代到 127.0.0.1 的 DSH Web
```

- **App**：扫码配对（QR v2，`auth=token`）→ 用 Secure Enclave / Android Keystore 里的 P-256
  设备密钥对 relay challenge 签名 → 换 15 分钟短时 token → `__Host-dsh_session` cookie 访问自己的主机。
- **主机插件**：跑在 DSH 主机上，负责群体版配对、注册/刷新、出站 WSS 隧道、loopback 明文代理
  （HTTP + WebSocket 升级）到本机 DSH；默认拒绝外网入站。可选「允许手机重启主机 DSH」组件
  （默认关闭，开启后 App 顶栏出现重启按钮）。
- **relay**：部署方自建，终止手机 TLS（需要 `*.relayDomain` 通配证书），负责设备会话鉴权、
  主机隧道、邀请码注册、部署方后台；**自签 App 的 self 推送**可在 relay 配部署方自己的
  APNs key（官方 App 的推送不经过 relay，见下）。
- **官方推送（R2）**：官方 App 打包内置官方 hub 地址，用设备密钥向官方 hub 登记换
  per-device credential，主机直连 hub 发送——**与部署方 relay 配置无关**；hub 由项目所有者
  运营（官方团队 APNs key、固定通用文案、配额限流）。

## 风险与边界（部署/使用前必读）

- **部署方可见明文**：A 模式下 relay 终止手机 TLS，部署方（自己部署的人或服务提供商）能看到
  会话内容与元数据；风险与责任由部署方承担。部署文档与 App 内均有明示。
- **设备身份**：配对注册的设备公钥 + 短时 token（15 分钟、native 续期）+ 主机设备表撤销；
  token 泄露 = 该设备在有效期内可访问，不等价于「私钥不可导出的 mTLS」。
- **relay 是信任方**：A 模式下 relay 是身份权威，必须把它当作可信方；不要部署在不信任的服务器上。
- **仅限小范围、邀请制、可信群体**；协议、配置与 API 仍会演进，不要用于公开服务。
- DSH Web 始终只监听 `127.0.0.1`；不 fork DSH、不用 `--trusted-host` 旁路。
- 本分支**不包含**主机本机 APNs 推送（主机零 Apple 凭据）：官方 App 走官方 hub 设备直连、
  自签 App 走部署方 relay 自己的 APNs key；见
  [`docs/group-push-r2-contract.zh.md`](docs/group-push-r2-contract.zh.md) 与部署手册
  [`server/README.md`](server/README.md) §6。

完整设计与安全决策：[docs/group-service-design.zh.md](docs/group-service-design.zh.md)；
推送实现契约（R2）：[docs/group-push-r2-contract.zh.md](docs/group-push-r2-contract.zh.md)
（O1 历史契约：[docs/group-push-design.zh.md](docs/group-push-design.zh.md)；self 推送仍有效，official 转发已删除）。
推送使用与边界（字段说明/常见误报 bug/排错）：[docs/group-push-usage.zh.md](docs/group-push-usage.zh.md)。

## 从这里开始

| 我想… | 去这里 |
|---|---|
| 部署 relay（证书、端口、nginx、后台、邀请码） | [server/README.md](server/README.md) |
| 配置自签 App 的 self 推送（部署方 APNs key） | [server/README.md §6](server/README.md#6-推送可选自部署--官方推送-hub) |
| 官方推送 hub（运营方部署/配额） | [dsh-remoteService/packages/push-hub/README.md](dsh-remoteService/packages/push-hub/README.md) |
| 推送怎么用、边界与常见误报 bug | [docs/group-push-usage.zh.md](docs/group-push-usage.zh.md) |
| 在 DSH 主机安装/配置群体服务插件 | [dsh-remoteService/packages/host-plugin/README.md](dsh-remoteService/packages/host-plugin/README.md) |
| 构建/运行手机 App | [dsh-remoteApp/README.md](dsh-remoteApp/README.md) |
| 看服务端 monorepo（protocol/apns/relay/host-plugin/push-hub） | [dsh-remoteService/README.md](dsh-remoteService/README.md) |
| 推送实现契约（R2 官方推送/接口/安全） | [docs/group-push-r2-contract.zh.md](docs/group-push-r2-contract.zh.md) |
| 推送方案取舍/负载限流评估 | [docs/group-push-routing-options.zh.md](docs/group-push-routing-options.zh.md) · [docs/group-push-load-evaluation.zh.md](docs/group-push-load-evaluation.zh.md) |
| 看落地踩坑与根因记录 | [docs/diagnostics/12-group-service-issues.md](docs/diagnostics/12-group-service-issues.md) |
| 看当前状态与验收记录 | [STATUS.md](STATUS.md) |

## 仓库结构

```
DshRemote/
├── server/                     # 部署方 VPS：群体版 relay compose + group nginx 配置
├── dsh-remoteService/          # 服务端 monorepo
│   ├── packages/protocol/      #   群体版协议常量 / QR v2 / 帧 / 签名校验 / R2 推送登记契约
│   ├── packages/host-plugin/   #   DSH 主机插件（群体版注册/隧道/明文代理/配对/推送分流）
│   ├── packages/relay/         #   群体版 relay（边缘 TLS + 注册 API + 后台 + 控制面 WSS）
│   ├── packages/push-hub/      #   官方推送 hub（owner 运营：设备登记/credential/配额/APNs）
│   └── packages/apns/          #   APNs HTTP/2 发送器（relay self 与 hub 共用）
├── dsh-remoteApp/              # Expo / React Native App（群体版 token 模式，iOS 优先）
├── docs/                       # 设计文档与排障记录
└── STATUS.md                   # 当前状态与验收记录
```

## 开发与测试

```bash
cd dsh-remoteService
npm install
npm test
npm run validate:artifacts

cd ../dsh-remoteApp
npx tsc --noEmit
npm run check:native
npm run check:shell
```

真机构建/验收步骤见 [dsh-remoteApp/README.md](dsh-remoteApp/README.md) 与
[dsh-remoteApp/docs/ACCEPTANCE.md](dsh-remoteApp/docs/ACCEPTANCE.md)。

## 许可

本项目采用 **GNU Affero General Public License v3.0 or later（AGPL-3.0-or-later）**。

- 完整协议文本：[LICENSE](LICENSE)
- 版权声明：[COPYRIGHT](COPYRIGHT)
- 你可以运行、修改、分发、商业使用本软件；若修改后通过网络向用户提供服务，须按 AGPL §13
  向这些用户提供修改版的完整 Corresponding Source。
- 分发衍生作品时，必须继续使用 AGPL-3.0-or-later。
- App Store 等平台分发可能和 AGPL 的再分发要求存在冲突；若要上架，请单独评估或采用商业双许可。

第三方依赖遵循各自许可证。
