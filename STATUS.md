# DSH Remote Access — 项目状态 / 验收清单

快照：2026-10-19（实施第 14 轮）· 方案：**B2（自托管盲中继 + 设备 mTLS + 自建域名）**

## 一句话

POC 与 MVP 的**代码、文档、测试、部署产物、本地端到端验收均已完成**；
剩余 3 项需要外部环境：**iOS 真机验收（需 Xcode/iPhone）、Android 编译（需 Android SDK）、生产 relay 上线（需 VPS+域名）**。

## 可自验证据（当前机器即可跑）

```bash
cd dsh-remoteService
npm install
npm test                    # ✅ 58/58 pass
npm run validate:artifacts  # ✅ shell/compose/plist/JSON/Node 入口校验
npm run poc:deploy          # ✅ check-deploy.sh 成功路径（真 relay + 真 host + 证书检查）
node poc/run-poc.js         # ✅ 配对→设备 mTLS→relay→真实 dsh web 的 UI/WS
npm run poc:webview         # ✅ WKWebView + URLSession 客户端证书
npm run poc:csr             # ✅ Swift P-256 CSR → host CA 签发 → openssl 校验
npm run bench               # ✅ 数据面基线（本机 loopback）

# Docker relay（需 docker；macOS 可 colima start）
npm run poc:docker          # ✅ 真实镜像 + 容器 + host 插件 + mTLS 全链路
```

```bash
cd dsh-remoteApp
npx tsc --noEmit            # ✅ 0 error
npm run check:native        # ✅ JS bridge ↔ iOS/Android 接口一致
npm run check:ios-env       # ❌ 本机缺完整 Xcode（脚本给出修复步骤，属预期）
npm run check:android-env   # ❌ 本机缺 Android SDK（同上）
```

## 已完成能力

### dsh-remoteService（DSH host + client 插件 / relay / 协议 / 部署）

- Host 插件：Cordis 生命周期、`/api/remote-access` 本地管理 API、账号上方入口 + 配对弹窗、桌面确认、设备列表/撤销/审计
- 设备身份：host Ed25519 身份、设备 CA（RSA 设备证书 + **P-256 EC CSR openssl 签发**，适配 Secure Enclave）
- 远程 TLS 监听：仅 `127.0.0.1` 反代真实 DSH Web（UI/静态资源/API/WS 全功能），mTLS 校验、Cookie 注入、Host/Origin/Forwarded 等头清洗、安全响应头、请求体上限、路径 deny list
- 配对：一次性 256-bit secret / 12 位 Crockford code、120s TTL、限速、完整 SHA-256 指纹、SAS、桌面允许/拒绝
- relay：443 **TLS 透传（按 SNI 路由，不看明文）**、80 重定向/healthz、8443 WSS 控制面、host token、per-IP/全站连接上限、push token 内存存储
- 推送：host 只发内容无关通用提醒（turn/end 等），relay → Expo；token 注册/恢复、冷却、断线重连后重注册
- 运维：TLS 证书文件热加载 `reloadTls()`、撤销设备立即断链、audit、`check-deploy.sh`、`validate:artifacts`
- 部署：relay `Dockerfile` + `docker-compose.yml`（已验证构建/运行）、systemd/launchd 模板、DNS-01 证书脚本、DEPLOY 文档

### dsh-remoteApp（Expo / React Native）

- 扫码配对手动输入 fallback、主机指纹校验、SecureStore 存储（私钥永不进 JS）
- 自定义 WKWebView/WebView mTLS 客户端证书挑战
- 原生：iOS Secure Enclave 优先的 P-256 密钥 + PKCS#10 CSR + 证书安装 + URLSession mTLS；Android AndroidKeyStore + 手写 PKCS#10 + setKeyEntry + HttpsURLConnection mTLS（源码完成，未编译）
- 设备管理（列表/撤销）、主机状态、安全审计（均走 mTLS tunnel API）
- 推送注册、生物识别 App 锁、诊断页
- 环境检查、原生源码一致性检查、Expo prebuild（iOS/Android 生成成功、autolinking 识别 `dsh-mtls`）、真机验收手册

## 安全属性（已实现）

- relay **看不到**任何 HTTPS 明文/会话内容；只按 SNI 转发字节流
- 设备身份**只来自 mTLS 客户端证书**；Host/X-Forwarded-*/Origin/来源 IP 一律不作为身份
- DSH Web 始终只监听 `127.0.0.1`，无 `--trusted-host`、不暴露公网
- 远程响应统一安全头；HTML/API `no-store`；请求体 256 MiB 上限；危险本机路径 deny
- 配对一次性 secret + 限速 + 完整指纹 + 桌面确认；设备可即时撤销并断链
- 推送 payload 零业务内容（只有通用标题/正文 + `{kind}`）

## 仓库地图

```
docs/remote-access-evaluation.zh.md   # 已批准的方案评估（B2、安全、决策）
research/                             # 代码测绘/威胁模型/Codex 参考
mockups/                              # 架构图 / 入口 / 配对 / 审批截图
dsh-remoteService/                    # host 插件 + relay + protocol + POC + docs + deploy
  docs/{POC-REPORT,DEPLOY,ADMIN-API}.md
  poc/{run-poc.js,webview-mtls,native-csr,docker-e2e,bench-relay.js,check-deploy-local.js}
dsh-remoteApp/                        # Expo App + 原生模块 + docs/ACCEPTANCE.md
```

## 待人工执行（需要外部环境）

### A. iOS 真机验收（Xcode 环境已就绪，待解锁/连接 iPhone 安装）

当前状态：
- ✅ Xcode 27.1、license、xcode-select、iPhoneOS SDK 均就绪
- ✅ CocoaPods 1.17.0，`pod install` 成功
- ✅ iOS 原生工程（`dsh-remoteApp/ios/`）已生成，bundle ID = `com.amesucre.dshremote`
- ✅ **无签名 generic iOS 编译已通过**（`xcodebuild ... BUILD SUCCEEDED`，含本地 Swift mTLS 模块）
- ✅ 开发证书 + `DshRemote.mobileprovision`（含 `aps-environment=development`）已安装到本机
- ✅ 已手动签名构建并安装到 iPhone「iPhone」，App 启动、JS bundle 加载成功
- ✅ 真机 Secure Enclave 自检：原生模块生成 P-256 key（`SE=true`）→ CSR → host CA 签发 → openssl 证书链/公钥校验通过
- ⏳ 仍待完成：相机授权、扫码配对、真机 WebView mTLS、推送、App 锁（需 host/APNs 就绪）

剩余步骤：

已完成真机安装（手动签名）：

```bash
cd dsh-remoteApp/ios
xcodebuild -workspace DSHRemote.xcworkspace -scheme DSHRemote -configuration Debug \
  -destination 'id=<IPHONE_UDID>' -derivedDataPath /tmp/dsh-ios-device \
  CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=<TEAM_ID> \
  PROVISIONING_PROFILE_SPECIFIER=<PROFILE_UUID> \
  CODE_SIGN_IDENTITY="Apple Development: <YOUR_NAME> (<CERT_ID>)" build
xcrun devicectl device install app --device <UDID> /tmp/dsh-ios-device/Build/Products/Debug-iphoneos/DSHRemote.app
```

剩余验收需要 host 配对二维码（相机/手动粘贴）与推送凭据；见 `docs/ACCEPTANCE.md`。
按 [`dsh-remoteApp/docs/ACCEPTANCE.md`](dsh-remoteApp/docs/ACCEPTANCE.md) 执行并记录：
配对/桌面确认、WebView mTLS、Secure Enclave 身份、推送、App 锁、撤销断链、证书轮换。

### B. Android 编译/验收（需 Android SDK + JDK）

```bash
cd dsh-remoteApp
npm run check:android-env
npx expo prebuild --platform android
npx expo run:android --device
```
验收清单同 ACCEPTANCE.md（指纹锁、Keystore 身份、FCM 推送、撤销断链）。

### C. 生产 relay 上线（需 VPS + 域名）

```bash
# 1) VPS 安装 Docker；域名 DNS 指向 VPS
# 2) 按 dsh-remoteService/docs/DEPLOY.md 配 relay.json / certs / tokens
# 3) 主机侧：dsh web + 远程访问插件（证书文件用 scripts/issue-host-cert.sh 签发）
# 4) 部署自检
cd dsh-remoteService
./scripts/check-deploy.sh <relay-domain> <hostId>
# 5) 手机扫码配对 → 外网访问
```

## 已知限制 / 风险（MVP 待收尾）

- iOS/Android 原生**未编译**（本机无 Xcode/Android SDK）；已用独立 Swift POC 验证 WKWebView/URLSession 客户端证书、P-256 CSR 链路
- 推送需要 APNs/EAS/FCM 凭据（代码已就绪，未配置真实凭据）
- 生产证书需要你的域名 DNS-01 签发；`check-deploy.sh` 已在本地成功路径 + 失败路径演练
- 审计/设备管理暴露给所有已配对设备（owner-equivalent 设计；如需"仅桌面管理"需改为本地审批）
- iOS 真机 Secure Enclave 身份来源（Keychain/SE）仍需真机确认（代码路径已实现）

## 相关文档

- [方案评估](docs/remote-access-evaluation.zh.md)
- [POC 报告](dsh-remoteService/docs/POC-REPORT.md)
- [部署指南](dsh-remoteService/docs/DEPLOY.md)
- [管理 API](dsh-remoteService/docs/ADMIN-API.md)
- [App 真机验收手册](dsh-remoteApp/docs/ACCEPTANCE.md)
