# DSH Remote Access（远程访问）方案评估

> 目标：给 DeepSeek Harness 增加「手机 App 远程访问 + 可自托管服务端 + 强安全 + 账号上方入口」能力，模仿 Codex 那一类体验。
> 本仓库当前阶段：**方案已确认（B2 + 自托管 relay + 自有域名），POC 已通过，进入 MVP 实现**。

## 先读这一个文件

- **[docs/remote-access-evaluation.zh.md](docs/remote-access-evaluation.zh.md)** —— 完整方案评估（一页结论 / 现状盘点 / 6 个方案对比 / 推荐架构 B / 安全设计 / 入口 UI / 工作量 / 决策清单）

## 配套材料

| 文件 | 内容 |
|---|---|
| [research/codex-reference.md](research/codex-reference.md) | Codex 远程访问事实清单（确认/推断分离）、Happy/Omnara/VibeTunnel 对比、App 与服务端选型、12 个待确认问题 |
| [research/dsh-architecture.md](research/dsh-architecture.md) | DSH 0.2.1-rc.2 代码测绘：启动/插件/认证/侧栏/API 面，含 file:line 证据 |
| [research/security.md](research/security.md) | 现有信任模型、13 种「自称 localhost」核对表、22 行威胁表、MUST/SHOULD/NICE、反模式 |
| [mockups/architecture.png](mockups/architecture.png) | 推荐架构图（方案 B） |
| [mockups/sidebar-entry.png](mockups/sidebar-entry.png) | 账号行上方入口 + 配对弹窗 UI 稿 |

## 一句话结论

DSH 已有约六成底座（Web 传输/会话/审批/插件/入口/自托管链路），推荐用**外部插件 + 自托管盲中继 + 设备 mTLS 证书 + Expo/WebView App** 实现；不 fork DSH，不直接暴露现有 Web 服务，不建议用「公网反代 + 手机浏览器」的捷径。

## 实施状态（2026-10-19）

方案已确认 **B2 + 自托管 relay + 自有域名**，POC 阶段完成：

| 项 | 状态 |
|---|---|
| 服务端 monorepo（protocol / host 插件 / relay / 客户端 UI） | ✅ 实现在 [`dsh-remoteService/`](dsh-remoteService) |
| 测试 `npm test` | ✅ 45/45 |
| 本地端到端 POC（真实 `dsh web` + relay + 设备 mTLS + UI/WS） | ✅ PASS，见 [`docs/POC-REPORT.md`](dsh-remoteService/docs/POC-REPORT.md) |
| 真实 DSH 入口 & 配对弹窗截图 | ✅ [`mockups/live-pairing.png`](mockups/live-pairing.png) |
| 手机 App 源码（Expo/RN + mTLS 原生模块骨架） | ✅ [`dsh-remoteApp/`](dsh-remoteApp)（原生未编译，需 Xcode） |
| B2 生产部署文档（域名/DNS-01/证书/运维） | ✅ [`dsh-remoteService/docs/DEPLOY.md`](dsh-remoteService/docs/DEPLOY.md) |
| WebView mTLS | ✅ macOS WKWebView 已验证（同一 iOS API）；⏳ iOS 真机待 Xcode |
| 推送 host/relay 链路 / 安全加固 | ✅ 已实现 + 测试 |
| 原生 Secure Enclave CSR + mTLS HTTP（iOS 源码 + POC） | ✅ `npm run poc:csr` / `poc:webview`（含 URLSession）通过；⏳ Xcode 编译/真机 |
| Android CSR（源码） | ✅ Keystore P-256 + PKCS#10 源码；⏳ 无 SDK 未编译 |
| Android 原生 mTLS HTTP（源码） | ✅ HttpsURLConnection + KeyManager；⏳ 无 SDK 未编译 |

快速验收：`cd dsh-remoteService && npm install && npm test && node poc/run-poc.js`

## 目录约定（实施时）

```
dsh-remoteService/   # pnpm monorepo：DSH host 插件 + 自托管 relay + 共享协议 + docker 部署
dsh-remoteApp/       # Expo/React Native App（iOS 优先）
docs/                # 方案/设计/部署文档
mockups/             # UI 与架构稿
research/            # 预研材料（已完成）
```
