# dsh-remoteService（方案 B2 · 服务端 monorepo）


> 许可证：**AGPL-3.0-or-later**（完整文本见根目录 [`LICENSE`](../LICENSE)）。
DSH 远程访问的服务端实现：**自托管盲中继 + 主机插件（mTLS 反向代理）+ 共享协议**。
配套手机 App 在 [`../dsh-remoteApp`](../dsh-remoteApp)；公网服务器编排在 [`../server`](../server)；评估与设计见 [`../docs/remote-access-evaluation.zh.md`](../docs/remote-access-evaluation.zh.md)。

## 快速导航

| 内容 | 文档 |
|---|---|
| 公网 relay + nginx 部署 | [`../server/README.md`](../server/README.md) |
| 主机插件安装与配置 | [`packages/host-plugin/README.md`](packages/host-plugin/README.md) |
| 手机 App | [`../dsh-remoteApp/README.md`](../dsh-remoteApp/README.md) |
| 完整部署细节（DNS-01 / 证书 / 运维） | [`docs/DEPLOY.md`](docs/DEPLOY.md) |
| 管理 API 契约 | [`docs/ADMIN-API.md`](docs/ADMIN-API.md) |
| 根目录总览 | [`../README.md`](../README.md) |

```
packages/protocol/     # 配对 URI/SAS/12 位码、relay 控制消息、二进制流帧、管理 API 常量
packages/host-plugin/  # DSH 插件：Host 半（身份/设备 CA/配对/mTLS/反代/relay 连接器/审计/证书热加载）
                       #          Client 半（sidebar.footer.action 入口 / 配对弹窗 / 设置页）
packages/relay/        # 自托管盲中继：443 TLS 透传、80 跳转/healthz、8443 控制面、token CLI、Docker
poc/                   # 本地端到端 POC（真实 dsh web + relay + mTLS）
docs/                  # ADMIN-API.md / DEPLOY.md / POC-REPORT.md
```

## 状态（2026-10-19）

| 项 | 状态 |
|---|---|
| 协议 / host 插件 / relay / 客户端 UI / 管理 API | ✅ 已实现 |
| 单元+集成测试 `npm test` | ✅ 94 tests / 0 fail（含 APNs、会话摘要、后台恢复重连与通知跳转） |
| 端到端 POC `node poc/run-poc.js`（配对→mTLS→relay→DSH UI/WS） | ✅ PASS |
| 真实 DSH 内入口 & 配对弹窗（截图验证） | ✅ PASS（`../mockups/live-pairing.png`） |
| B2 生产部署文档（域名/DNS-01/acme.sh/运维/安全红线） | ✅ `docs/DEPLOY.md` |
| WebView mTLS | ✅ macOS WKWebView 已验证；⏳ iOS 真机需 Xcode |
| 推送（自托管 APNs，会话摘要） | ✅ 主机直连 Apple（.p8 + device token；标题/正文取会话摘要）；旧 relay→Expo 通道可选 |
| 原生 CSR / Android 编译 | ⏳ 下一里程碑 |

## 开发与验收

```bash
cd dsh-remoteService
npm install
npm test                 # 58 tests
node poc/run-poc.js      # 端到端 POC（需要 dsh CLI；使用独立临时 DSH_HOME，安全）
npm run poc:docker       # Docker relay 端到端（需 docker/colima；含真实 host 插件 + mTLS）
npm run validate:artifacts  # 部署产物静态校验（shell/compose/plist/JSON）
npm run poc:deploy          # 部署自检脚本本地成功路径演练
npm run bench            # relay 数据面吞吐/延迟基线
npm run poc:webview      # macOS WKWebView 客户端证书 POC（无需 Xcode）
npm run poc:csr          # Swift P-256 CSR → host 签发 → openssl 校验（无需 Xcode）
```

POC 细节与已知限制见 [`docs/POC-REPORT.md`](docs/POC-REPORT.md)；生产部署见 [`docs/DEPLOY.md`](docs/DEPLOY.md)。

## 安全边界（摘要）

- 设备身份 = **mTLS 客户端证书**（私钥在 Secure Enclave/Keystore），不来自任何请求头/来源 IP。
- relay 是盲管道：443 只转发 TLS 字节，不持有主机子域证书；B2 下连冒充服务器都做不到。
- DSH 本机 Web 服务保持 `127.0.0.1`，不加 `--trusted-host`；插件剥离客户端头并注入本机 session cookie。
- 配对一次性密钥 ≤120s + 桌面 SAS 确认；设备可撤销；配对/反代路径有限速与 deny list。
