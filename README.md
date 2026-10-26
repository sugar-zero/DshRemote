# DSH Remote

给 **DeepSeek Harness (DSH)** 增加手机远程访问能力的自托管方案：

- **iPhone/Android App**：扫码配对，用设备证书（Secure Enclave / AndroidKeyStore）通过 mTLS 访问主机。
- **主机插件**：跑在 DSH 主机上，负责配对、证书、设备管理和到本机 DSH 的反向代理。
- **自托管 relay**：跑在公网服务器上，只做 TLS 盲转发；看不到明文，也不持有主机私钥。

> 设计目标：**不 fork DSH**、不把 DSH Web 直接暴露公网、支持自建域名/自建服务端。

---

## 架构

```
┌──────────────┐        mTLS 客户端证书         ┌─────────────────────┐
│  手机 App     │ ─────────────────────────────► │  nginx / relay:443   │
│  WebView     │   https://<hostId>.<domain>    │  TLS 盲透传（SNI）    │
└──────────────┘                                 └──────────┬──────────┘
                                                            │ TLS 原样转发
                                                            ▼
                                                 ┌─────────────────────┐
                                                 │  主机插件（DSH 主机） │
                                                 │  终止 TLS + 校验设备  │
                                                 │  反代到 127.0.0.1 DSH │
                                                 └─────────────────────┘
        ▲
        │ wss://relay:8443（控制面）
        └──────────── 主机插件 ↔ relay
```

- 手机拿到 `dshremote://pair?...` 二维码后配对，获得设备证书。
- App 用证书访问 `<hostId>.<relayDomain>`，主机插件校验后反代到本机 DSH。
- relay 只按 SNI 转发 TLS 字节；主机子域证书和私钥只在主机。

---

## 从这里开始

| 我想… | 去这里 |
|---|---|
| 部署公网 relay + nginx + 证书 | **[server/README.md](server/README.md)** |
| 在 DSH 主机安装/配置远程访问插件 | **[dsh-remoteService/packages/host-plugin/README.md](dsh-remoteService/packages/host-plugin/README.md)** |
| 构建/运行手机 App | **[dsh-remoteApp/README.md](dsh-remoteApp/README.md)** |
| 了解服务端 monorepo / relay 协议 / 管理 API | **[dsh-remoteService/README.md](dsh-remoteService/README.md)** |
| 看完整部署细节（DNS-01、acme.sh、主机证书、运维） | **[dsh-remoteService/docs/DEPLOY.md](dsh-remoteService/docs/DEPLOY.md)** |
| 看方案评估、威胁模型、Codex/Happy 对比 | **[docs/remote-access-evaluation.zh.md](docs/remote-access-evaluation.zh.md)** |
| 看 POC 验收记录/截图 | **[dsh-remoteService/docs/POC-REPORT.md](dsh-remoteService/docs/POC-REPORT.md)**、[STATUS.md](STATUS.md) |
| 看当前真机/构建状态 | **[STATUS.md](STATUS.md)** |
| 看真实部署踩坑与排错 | **[server/README.md §9 常见坑](server/README.md#9-常见坑与排错实战)** |
| 看手机端「载入历史很久/失败 + 画面反复跳」的根因与修复 | **[docs/diagnostics/00-root-cause.md](docs/diagnostics/00-root-cause.md)** |
| 看手机端「右侧栏打不开 / 展开按钮消失」的根因与修复 | **[docs/diagnostics/05-mobile-right-panel.md](docs/diagnostics/05-mobile-right-panel.md)** |
| 看手机端「设置页太挤」的全屏化 + 分区抽屉修复 | **[docs/diagnostics/06-mobile-settings-drawer.md](docs/diagnostics/06-mobile-settings-drawer.md)** |
| 看手机端「查询用量/充值/意见反馈点击没反应」的外链修复 | **[docs/diagnostics/07-mobile-external-links.md](docs/diagnostics/07-mobile-external-links.md)** |
| 看 Windows 主机无 openssl 时 EC 设备配对失败的根因与修复 | **[docs/diagnostics/08-host-ec-csr-windows.md](docs/diagnostics/08-host-ec-csr-windows.md)** |
| 看手机端「打开大会话要等几秒」的历史分片拉取（首屏小窗口 + 按需翻页） | **[docs/diagnostics/09-mobile-history-slicing.md](docs/diagnostics/09-mobile-history-slicing.md)** |
| 看手机 App 隐藏「在主机本机打开」入口 + 远程「重启主机 DSH」的设计与安全说明 | **[docs/diagnostics/10-mobile-host-actions.md](docs/diagnostics/10-mobile-host-actions.md)** |

### 服务器如何配置（摘要）

1. 域名：`relay.example.com` 和 `*.relay.example.com` 都解析到 VPS。
2. 证书：
   - relay 控制面证书（`relay.example.com`）放在服务器 `server/data/certs/`；
   - 主机子域证书（`<hostId>.relay.example.com`）在 **DSH 主机** 上签发，填到插件设置里。
3. `server/docker-compose.yml` 启动 relay；已有宿主机 nginx 时用 `server/nginx/host-nginx-stream.conf` 做 443/8443 的 **L4 TCP 透传**（不要做 HTTPS 终止）。
4. relay 端 `token create` 生成主机 token，填到主机插件。
5. 手机 App 扫码配对，访问 `https://<hostId>.relay.example.com/`。

完整步骤、nginx 配置、Docker 端口、排障与安全清单：[**server/README.md**](server/README.md)。

---

## 仓库结构

```
DshRemote/
├── server/                     # 公网服务器：relay compose + nginx 透传配置
├── dsh-remoteService/          # 服务端 monorepo
│   ├── packages/protocol/      #   配对 URI/SAS、relay 控制协议、二进制帧、管理 API 常量
│   ├── packages/host-plugin/   #   DSH 主机插件（Host 半 + Client 半）
│   ├── packages/relay/         #   自托管盲中继（443 透传 / 8443 控制面 / token CLI）
│   ├── scripts/                #   DNS-01 主机证书、部署自检
│   └── docs/                   #   DEPLOY / ADMIN-API / POC-REPORT
├── dsh-remoteApp/              # Expo / React Native App（iOS 优先，含原生 mTLS 模块）
├── docs/                       # 方案评估与设计
├── mockups/                    # UI / 架构稿 / 真机截图
├── research/                   # Codex/DSH 预研材料
└── STATUS.md                   # 当前实施状态与剩余验收项
```

---

## 两分钟跑通（开发/POC）

```bash
# 1) 服务端依赖 + 单元/端到端 POC（需要 dsh CLI）
cd dsh-remoteService
npm install
npm test
node poc/run-poc.js

# 2) 服务器编排（VPS）
cd ../server
cp .env.example .env        # 改 RELAY_DOMAIN
docker compose up -d relay

# 3) App
cd ../dsh-remoteApp
npm install
npx expo prebuild --clean
npx expo run:ios --device   # 或 run:android
```

生产证书、nginx、DNS 和 main 机插件配置不要跳过：
先读 [server/README.md](server/README.md) 与 [host-plugin README](dsh-remoteService/packages/host-plugin/README.md)。

---

## 安全模型（摘要）

- **设备身份 = mTLS 客户端证书**，私钥只在 Secure Enclave / AndroidKeyStore。
- **relay 是盲管道**：只按 SNI 转发 TLS，不持有主机子域证书、看不到明文。
- **主机插件终止主机 TLS**，校验设备证书后反代到 `127.0.0.1` 的 DSH Web。
- DSH Web 不直接暴露公网，不关闭认证，不使用 `--trusted-host`。
- 配对密钥一次性、短时有效；设备可撤销；管理 API 只允许本机已认证浏览器。
- 不要用 nginx 对 relay 域名做 HTTPS 终止/HTTP 反代；必须 L4 透传（原因见 server/README）。

---

## 开发与测试

```bash
cd dsh-remoteService
npm test
npm run validate:artifacts
node poc/run-poc.js
npm run poc:docker

cd ../dsh-remoteApp
npx tsc --noEmit
npm run check:native
npm run check:ios-env
```

> 当前 App 已包含原生 mTLS WebView、配对、设备管理、推送注册、设置页（通知/缓存/版本）和手机侧栏/右栏/设置页适配；
> 真机签名/构建步骤见 [dsh-remoteApp/README.md](dsh-remoteApp/README.md)。

---

## 许可

本项目采用 **GNU Affero General Public License v3.0 or later（AGPL-3.0-or-later）**。

- 完整协议文本：[LICENSE](LICENSE)
- 版权声明：[COPYRIGHT](COPYRIGHT)
- 你可以运行、修改、分发、商业使用本软件。
- 如果你修改了本软件并通过网络向用户提供服务，必须按 AGPL §13 向这些用户提供修改版的完整 Corresponding Source。
- 分发衍生作品时，必须继续使用 AGPL-3.0-or-later。
- App Store 等平台分发可能和 AGPL 的再分发要求存在冲突；若要上架，请单独评估或采用商业双许可。

第三方依赖遵循各自许可证。
