# 方案 B2 · 本地 POC 报告

> 日期：2026-10-19 ｜ 环境：macOS（仅 Command Line Tools，**无 Xcode/Android SDK**）｜ DSH `0.2.1-rc.2` ｜ Node 24
> 结论：**服务端链路（relay 透传 + 主机插件 mTLS 反代 + DSH Web UI/WS）端到端 POC 通过**；手机 WebView mTLS 需在有 Xcode + iPhone 的环境完成最后验证。

---

## 1. POC 清单与状态

| # | POC | 状态 | 证据 |
|---|---|---|---|
| 1 | WebView mTLS（iOS/Android 真机） | ⏳ **本机无法验证**（无 Xcode/设备） | App 源码 + `modules/dsh-mtls` 骨架 + 构建/验收步骤见 `dsh-remoteApp/README.md`；需在用户 Mac 上 `npx expo run:ios --device` 验证 |
| 2 | relay TLS 透传 + SNI 路由 | ✅ **通过** | `packages/relay` 27 项测试（真实 ClientHello 捕获/分片、端到端 `tls.connect` → relay → 自签 TLS server、token 拒绝、未知 SNI 销毁、并发流、CLOSE 帧、控制面 TLS） |
| 3 | 主机插件反代后 DSH UI 全功能 | ✅ **通过** | `poc/run-poc.js`：真实 `dsh web` 实例 + 插件 + relay，`GET /` 200（37,865 bytes DSH HTML），WebSocket `/api/remote.mux` 101 升级成功 |
| 4 | 配对 + 桌面确认 + 设备证书 | ✅ **通过** | POC：`/pairing/start` → App CSR → `/__dsh_remote/pair` pending（SAS）→ 桌面 `/pairing/approve` → 设备证书 → mTLS 访问 |
| 5 | 证书（B2 生产形态） | ✅ 开发自签通过；⏳ 生产 DNS-01 以文档 + acme.sh 为准（插件已实现**证书文件热加载**） | `docs/DEPLOY.md` §3；`lib/service.js` 的 `#watchCertFiles` |
| 6 | 安全断言 | ✅ **通过** | 无客户端证书/不受信 CA/已撤销设备 → 403；伪造 `Host`/`X-Forwarded-For`/`X-Real-IP`/`Origin` 不影响身份；`/connect` 被 deny；配对错误密钥限速（10 次后 429） |
| 7 | 客户端 UI：入口 / 配对弹窗 / 桌面确认 | ✅ **通过（真实 DSH 截图）** | 入口在账号行正上方；配对弹窗含真实二维码/备用码/指纹/SAS；`pending` 时显示「待确认的配对请求」+设备名/SAS+「拒绝/允许配对」，点击允许后设备写入并刷新（截图见下） |
| 8 | App 源码/TS 检查 | ✅ 通过（未编译原生） | `npx tsc --noEmit` exit 0；`expo config` 通过；autolinking 识别 `dsh-mtls`；协议自测 14/14 |

## 2. 端到端 POC 运行结果

```bash
cd dsh-remoteService
npm test              # 48 tests, 0 fail（protocol + host-plugin + relay + client UI smoke）
node poc/run-poc.js   # 需要 dsh CLI 在 PATH；约 15–25s
```

最近一次运行（节选）：
```
[1/8] 安装 host-plugin 到临时 web profile
[2/8] 启动盲中继（dev，临时端口）
[3/8] 启动 dsh web
[4/8] 配置并启用远程访问 → plugin enabled, relay connected
[5/8] 创建配对会话并模拟 App 扫码配对
      App 收到 pending（SAS=N71X-2ABY），模拟桌面确认 → 桌面确认通过
      配对成功 deviceId=d_02eed01be001
[6/8] 用设备证书经 relay 访问 DSH UI
      DSH UI 200，37865 bytes
[7/8] 安全断言：无证书 403 / 头伪造不生效 / deny list 403
[8/8] WebSocket /api/remote.mux 经 relay + mTLS 升级
POC PASS：配对 → 设备 mTLS → relay 透传 → DSH UI/WS 全部打通
```

POC 使用独立临时 `$DSH_HOME`（不会碰用户的真实 DSH 数据），结束后自动清理；`POC_KEEP_HOME=1` 可保留现场。
`POC_TRANSPORT=direct` 可绕过 relay 数据面直连主机插件 TLS 监听（用于定位 relay/插件两侧问题）。

## 3. 真实 DSH UI 截图（客户端插件）

![入口 + 配对弹窗](../../mockups/live-pairing.png)

![桌面确认（pending）](../../mockups/live-approval.png)

> 截图来自真实 `dsh web` 实例（临时 home）加载本插件：入口在账号行上方；配对弹窗展示了真实二维码、12 位备用码、主机指纹与「本次配对需要在这台电脑上确认」；待确认卡片展示设备名、SAS、拒绝/允许按钮。

## 4. 交付物

| 路径 | 内容 |
|---|---|
| `packages/protocol` | 配对 URI/SAS/12 位码、relay 控制消息、二进制流帧、管理 API 常量 |
| `packages/host-plugin` | DSH 插件：Host 半（身份/设备 CA/配对/mTLS/反代/relay 连接器/审计/证书热加载）+ Client 半（footer 入口/配对弹窗/设置页/设备撤销/审计） |
| `packages/relay` | 自托管盲中继：443 TLS 透传 + 80 跳转/healthz + 8443 WSS 控制面 + token CLI + Dockerfile/compose + 部署 README |
| `poc/` | `run-poc.js` 端到端验收脚本 + 设备 CSR/HTTPS 工具 |
| `docs/DEPLOY.md` | B2 生产部署（DNS/证书/relay/插件/App/运维/安全红线/排障） |
| `docs/ADMIN-API.md` | 本机管理 API + 远程隧道 API 契约 |
| `../dsh-remoteApp` | Expo App：配对/WebView/设备页 + `modules/dsh-mtls`（iOS/Android）骨架 |

## 5. 尚未完成 / 下一步

1. **POC-1 真机 WebView mTLS**（阻塞在环境）：需要用户 Mac 安装 Xcode + iPhone，按 `dsh-remoteApp/README.md` 构建；验证 `WKNavigationDelegate` 客户端证书挑战 + Android `onReceivedClientCertRequest`。
2. **App 原生密钥/CSR**：当前 POC 用 PKCS#12 手动导入验证链路；MVP 实现 Secure Enclave/Keystore 生成密钥 + CSR。
3. **生产证书自动化**：当前按 `DEPLOY.md` 用 acme.sh 手工/定时签发；可加 relay 侧 ACME DNS-01 helper（B2 仍要求 DNS 凭据只在主机）。
4. **推送**：host 插件已留 `/__dsh_remote/push-token` 与 relay push 控制消息；App 接入 expo-notifications + relay 零正文推送待做。
5. **client UI 桌面确认按钮**：✅ 已补齐（pending 卡片 + 允许/拒绝 + 刷新 + 测试）。
6. **生产部署**：需要用户提供 VPS + 域名（或按 `DEPLOY.md` 自行部署）；relay 控制面必须用真实证书（`--dev` 仅本机）。
7. **加固收尾**：HTTP 响应安全头、body/限流参数可配置、审计 UI、Android 编译、换机/撤销演练。

## 6. 已知限制（POC 级别）

- **dev 自签主机证书**仅用于本地 POC；生产必须配置 B2 的 DNS-01 证书（否则手机 WebView 不信任）。
- relay 控制面在 dev 模式是 `ws://`（明文 token）；公网必须 `wss://`。
- `relayTlsInsecure` 配置目前未用于 wss 自签（dev 用 ws）；生产用受信证书即可。
- 手机 WebView 内不做证书 pinning（依赖公共 CA；B2 下 relay 无法拿同名证书，残余风险见评估 §4.8）。
- 反代路径 allow/deny 目前是配置 + 默认清单；DSH 升级后需复核新增"本机副作用"路由。
