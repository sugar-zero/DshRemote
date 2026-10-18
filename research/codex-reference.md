# Codex 式远程访问参考调研（DSH Remote Access 预研）

> 调研日期：2026-10-19。范围：OpenAI Codex 远程/手机访问的真实形态、同类可自托管产品、手机 App 与服务端选型。
> 标注约定：✅ = 官方/一手来源确认；⚠️ = 推断或第三方来源、未经一手确认；📅 = 来源时间（时效性提示）。
> 本文只做评估，不涉及实现，不写代码。

---

## 1. 结论摘要（≤10 行）

1. Codex 的手机访问是「ChatGPT 桌面端当主机 + OpenAI 云中继 + ChatGPT 手机 App 当客户端」：桌面端出二维码、手机扫、同一 ChatGPT 账号/工作区 + MFA/SSO 确认；手机可发起任务、看终端/截图/diff、批准命令、切主机。（✅ 官方文档）
2. Codex 明确有独立入口：桌面端侧边栏/设置里的「Set up Codex mobile / 设置 Codex 移动版」，手机端是 App 内「Codex（旧名 Remote）」一级入口；"入口在账号上方"属于合理布局推断，官方文档未给像素级位置。（✅ 入口存在；⚠️ 相对账号位置）
3. Codex 的 relay 官方只称 "secure relay layer"，**没有声明端到端加密**；第三方博客里的 E2E/mTLS/端口细节不可当事实。（✅ 官方措辞；⚠️ E2E）
4. Codex 不可自托管：relay、账号、策略均由 OpenAI 控制；只有 SSH 主机连接是用户自己的机器，但仍由 OpenAI 协调。（✅/⚠️ 见 §2.3）
5. 同类产品里，**Happy（slopus/happy）与我们的目标几乎同构**：本地 Agent → 自托管盲中继 → Expo 手机 App，扫码配对，NaCl/AES-256-GCM 端到端加密，MIT，单 Docker 容器可跑。（✅）
6. Omnara 是「可自托管的托管 Agent 平台」（Go + Docker Compose + 出站 daemon），当前形态偏 Web/CLI/API，不是手机遥控本地编码会话的产品。（✅ 文档）
7. VibeTunnel 是「浏览器终端 + Tailscale/ngrok 远程」，无原生手机 App、无应用层 E2E；它验证了"远程访问不一定要自己做 relay"。（✅）
8. 我们的推荐主线：**盲中继 + 自托管 + 原生（Expo/RN）手机 App + 二维码配对 + 设备级密钥**，与用户"强安全 + 自托管"要求一致；服务端优先 Node/TS，单容器起步。（⚠️ 建议）
9. 三个架构模式：A 直连/VPN、B 盲中继 E2E、C 账号+云中继；Codex 是 C，Happy 是 B，VibeTunnel 是 A。C 体验最好但不可自托管、无 E2E；我们应选 B。（⚠️ 结论）
10. 最大的未知/风险：中继端 E2E 的具体威胁模型、推送通知的元数据泄露、App Store 4.2/2.5.2 审核、以及"手机批准高危命令"的策略默认值。（⚠️ 见 §7）

---

## 2. Codex 远程访问事实清单

### 2.1 ✅ 已确认（一手来源）

**支持面（surfaces）**
- 主机：ChatGPT 桌面 App（macOS / Windows）。手机端：ChatGPT iOS / Android App 内的 **Codex** 入口（旧版本标签叫 **Remote**）。可从手机连到 Mac 或 Windows 主机；也可从另一台装桌面 App 的设备「Control other devices」接管。📅 官方文档（2026 年当前版）：<https://learn.chatgpt.com/docs/remote-connections>
- 支持的主机类型：① 日常笔记本/台式机；② 常开专用电脑（如 Mac mini）；③ SSH 主机 / 托管远程开发环境（桌面 App 通过 `~/.ssh/config` 发现主机，用 SSH 启动远端 Codex app-server）。<https://learn.chatgpt.com/docs/remote-connections>
- 手机端能干的事：发起新任务/继续已有会话、追加指令、**批准命令与操作**、查看输出/diff/测试结果/终端输出/截图、切换主机、任务完成或需关注时收到通知。<https://learn.chatgpt.com/docs/mobile>
- 云端与本地并存：Codex 可在 Cloud 或「连接的电脑」上跑；另有一个 "Local computer access with Work Cloud"（OpenAI 云协调、在线电脑执行）的变体，官方明确它不改变手机连主机的机制。<https://learn.chatgpt.com/docs/remote-connections>

**配对与认证**
- 流程：桌面 App → **Settings > Connections > Control this Mac or PC** → Set up/Add → 批准远程访问 → 显示二维码 → 手机扫码 → 确认同一 ChatGPT 账号与工作区 → 完成 MFA/SSO/passkey → 主机的项目、聊天、凭据、权限、插件、Computer Use、浏览器配置对手机可见。<https://learn.chatgpt.com/docs/remote-connections>
- **手机配对必须从桌面 App 发起，CLI 与 IDE 扩展不能发起手机配对**。原文："Mobile setup starts from the app; you can't set it up from the Codex CLI or IDE extension." <https://learn.chatgpt.com/docs/remote-connections>
- 每台手机 × 每台主机要分别配对；2026-06-08 之后未使用过的旧连接需要重新配对。手机端"看不到主机"的排障步骤包括：桌面 App 在运行、已打开 "Allow other devices to connect"、同账号/同工作区。<https://learn.chatgpt.com/docs/remote-connections>
- 登出 ChatGPT 会关闭 Remote Control（配对关系保留），重新登录后要重新打开。<https://learn.chatgpt.com/docs/remote-connections>
- 企业/工作区：管理员可以关闭 Remote Control 访问；工作区策略、审计等仍然生效。<https://learn.chatgpt.com/docs/remote-connections>

**中继与网络暴露**
- 官方措辞："A secure relay layer keeps trusted machines reachable across your authorized ChatGPT devices without exposing them directly to the public internet." 中继同时负责跨设备同步活跃会话状态与上下文。<https://learn.chatgpt.com/docs/remote-connections>；中文报道复述：<https://www.appinn.com/work-with-codex-from-anywhere/> 📅 2026-05
- 数据留在主机：手机只发 prompt/批准/追问；仓库文件、本地文档、shell、MCP、skills、浏览器、Computer Use 都来自主机；沙箱与审批策略继续生效。<https://learn.chatgpt.com/docs/remote-connections>
- 主机必须保持唤醒/在线/App 打开；Mac 合盖需外接显示器并接电源，睡眠即断；Windows 上 Computer Use 是前台接管，建议专用机。<https://learn.chatgpt.com/docs/remote-connections>
- 手机端「入口」存在：官方文档写 "In the ChatGPT mobile app for iOS, open **Codex** ... If your mobile app still shows **Remote**, open it instead." <https://learn.chatgpt.com/docs/mobile>
- 桌面端「入口」存在：第三方排障文写 "Select **Set up Codex mobile** in the sidebar"：<https://revdoku.com/blog/fix-codex-remote-control-not-working/>；中文社区复现："更新 Codex 本地客户端。左侧会出现『设置 Codex 移动版』的入口（必须官方订阅账号，API 模式看不到）"：<https://linux.do/t/topic/2179701> 📅 2026-05/07

**CLI / 开发者侧（与手机通道并列的另一条"远程控制"能力）**
- `codex remote-control`（experimental）：启动/管理本地 app-server 守护进程的远程控制；`codex remote-control pair` 打印**短期手动配对码**，JSON 含 `pairingCode`、`manualPairingCode`、`environmentId`、`expiresAt`；`start` / `stop` / `--no-daemon` 可选。<https://learn.chatgpt.com/docs/developer-commands?surface=cli>
- `codex app-server --listen ws://IP:PORT` 提供 WebSocket 传输；`--remote ws://host:port` / `--remote-auth-token-env` 用 bearer token 鉴权；官方提示：**不要把 app-server 直接暴露在共享/公网网络**，跨网络应走 TLS/VPN/mesh。同链接。
- 这解释了 Codex 的远程控制底座：主机侧一个受管理的 app-server（本地 WS/Unix socket，带 bearer token）+ 云中继把手机请求转进来；配对码/二维码只是建立信任的短凭据。（⚠️ 底层协议未公开，此为根据命令文档的合理推断）

**时间线（📅）**
- 2026-05-13/14：Codex 进入 ChatGPT 手机 App（preview，iOS/Android，所有计划含 Free/Go），扫码配对；Remote SSH 同期 GA。中文报道：<https://www.appinn.com/work-with-codex-from-anywhere/>、<https://www.c114.net.cn/industry/82006.html>、<https://ai.zhiding.cn/2026/0518/3187339.shtml>；英文第三方：<https://appwrite.io/blog/post/openai-just-shipped-codex-to-the-chatgpt-mobile-app>
- 2026-09-28 DevDay 2026 回顾：Codex "按需运行：在电脑上运行、通过手机远程操作，或从任意设备在云端运行"，并提到可复用开发环境。<https://openai.com/zh-Hans-CN/index/devday-2026-recap/>
- 官方宣传页（抓取被拦，仅可引用链接）：<https://openai.com/zh-Hans-CN/index/work-with-codex-from-anywhere/>

### 2.2 ⚠️ 推断 / 不可当事实

- **是否 E2E**：官方文档只写 "secure relay layer"，**从未出现 end-to-end encryption**；同一整套文档里 Enterprise 数据只承诺 "encrypted in transit and at rest"。因此：Codex 手机↔主机的 payload 大概率由 OpenAI 中继可见（至少可访问 TLS 明文），**不能宣传为 E2E**。⚠️ 推断（依据：文档措辞 + 企业文档加密口径 <https://learn.chatgpt.com/docs/llms-full.txt>）。
- **二维码内容/有效期**：第三方西语博客称 QR 含 device_id + ephemeral key + relay endpoint、本地端口 47821、mTLS、QR 60 秒、`~/.config/codex/mobile-policy.toml`、Preferences → Mobile → Connected Devices 撤销设备：<https://azirgo.com/blog/codex-mobile-iphone-android-openai> 📅 2026-05。**这些均未在 OpenAI 官方文档出现，按未证实处理，不能进 PRD 当需求依据**。
- **"入口在账号上方"**：可确认的是"桌面端侧边栏有 Set up Codex mobile 入口、手机端 App 内有 Codex 一级入口"；入口相对账号区的精确位置官方无截图说明。用户所述"账号上方"应理解为：**侧边栏底部账号/设置区之上放一行产品级入口**，这是 Codex 桌面 App 的布局风格（⚠️ 布局推断，依据第三方截图描述与社区复现，未见官方界面规范）。
- **CLI remote-control 与手机通道是否同一协议**：文档说 "Managed remote-control clients and SSH remote workflows use these commands"，暗示手机即 managed client 之一；协议细节未公开。⚠️
- **Windows 时间**：2026-05 报道说"即将支持 Windows"，当前官方文档已写 Windows 主机支持，说明已 rollout；具体版本号未确认。✅ 支持存在 / ⚠️ 时间。

### 2.3 是否可自托管

- **不能**。relay、账号体系、工作区策略、设备管理与推送均由 OpenAI 提供；官方没有 self-host 选项，只有 SSH 主机连接（主机是你自己的远程开发环境）与私有部署的 OpenAI 模型（Bedrock 等）两条边角。⚠️ 由文档范围推断（无任何 self-host 入口）：<https://learn.chatgpt.com/docs/remote-connections>
- 对我们的意义：Codex 只能抄**交互与配对 UX**，不能抄部署模型；要满足"self-hosted server"必须走 Happy 那条路。

---

## 3. 同类产品对比表

| 产品 | 架构 / 中继模型 | E2E？ | 配对 / 认证 | 可自托管 | 手机端 | License |
|---|---|---|---|---|---|---|
| **OpenAI Codex mobile** | 桌面 App（主机）→ OpenAI 云中继 → ChatGPT App；主机侧 managed app-server（WS + bearer） | ❌ 官方未声明（仅 "secure relay"） | 桌面端出 QR；手机扫；同 ChatGPT 账号/工作区 + MFA/SSO/passkey；可撤销设备/管理员禁用 | ❌ 否 | ✅ 原生 ChatGPT App（iOS/Android，Codex/Remote 入口） | 闭源 |
| **Happy**（slopus/happy + happy-desktop） | CLI/Desktop Agent → 自托管 relay（Node Fastify + Socket.IO）→ Expo App/Web | ✅ 是：QR 换一次性公钥，账号 content keypair 包装每会话 AES-256 DEK；legacy 用 tweetnacl secretbox（XSalsa20-Poly1305） | QR 扫码（一次性公钥 + 回传账号公钥）；零往返认证（设备用账号派生的 key 自签随机 challenge）；服务端只存加密 blob | ✅ Docker 单容器（PGlite，自带 Postgres 可换 + Redis/S3 可选）；relay 约 1.2 万行 TS | ✅ 原生 Expo（App Store / Google Play）+ Web | MIT |
| **Omnara** | 自托管 Agent 平台：REST API + workers + Postgres + Redis；主机装 `omnarad` daemon **出站**连接，无入站端口 | ❌ 未声明 E2E；平台保存完整事件流（可查询做 eval），有 org/project RBAC 与 secrets | CLI `omnara login` / API key / 浏览器登录；项目级权限 | ✅ Docker Compose（官方 compose profile app）；也可用 Omnara Cloud | ❌ 当前文档以 Web dashboard + CLI + Slack/Discord 为主，未见手机 App | Apache-2.0 |
| **VibeTunnel** | 本机 Node 服务 + 浏览器终端（Lit + ghostty-web）；远程靠 Tailscale（推荐）/ ngrok / Cloudflare Tunnel | ❌ 无应用层 E2E；传输加密靠 Tailscale WireGuard / HTTPS | 浏览器登录：系统账号（macOS/PAM）、环境变量账号、SSH Ed25519 key、JWT session | ✅ npm / Homebrew / Docker | ❌ 无原生 App，浏览器即客户端（PWA 风格） | MIT |
| **纯 SSH/tmux 方案**（基线对照） | 直连：手机 SSH 客户端 → 家用机/跳板机；无中继 | ✅ SSH 本身端到端 | SSH key / 证书；WireGuard/Tailscale 做网络层 | ✅ | 第三方 SSH 客户端（如 Termius） | 不适用 |

**表格来源**
- Codex：<https://learn.chatgpt.com/docs/remote-connections>、<https://learn.chatgpt.com/docs/developer-commands?surface=cli>
- Happy README（MIT、Expo、E2E、桌面 App）：<https://github.com/slopus/happy>；架构/加密：<https://happy.engineering/docs/how-it-works/>、<https://happy.engineering/docs/security/>、<https://github.com/slopus/happy/blob/main/docs/encryption.md>、<https://github.com/slopus/happy/blob/main/docs/deployment.md>；自托管：<https://happy.engineering/docs/guides/self-hosting/>、<https://github.com/slopus/happy/blob/main/packages/happy-server/README.md>；手机配对：<https://happy.engineering/desktop/docs/mobile/>；App Store：<https://apps.apple.com/us/app/happy-codex-claude-code-app/id6748571505>、Play：<https://play.google.com/store/apps/details?id=com.ex3ndr.happy>
- Omnara：<https://github.com/omnara-ai/omnara>（Apache-2.0、Docker self-host、omnarad 出站）、<https://docs.omnara.com/introduction>（Web/CLI/REST，无手机端）
- VibeTunnel：<https://github.com/amantus-ai/vibetunnel>（MIT、架构、Tailscale/ngrok、认证模式）
- Termius（远程终端可上架的证据）：<https://apps.apple.com/us/app/termius-ssh-client/id549039908>

**Happy 的安全细节（值得抄）**
- 密钥层级：手机端 32B master secret（永不出手机）→ HMAC-SHA512 派生 content keypair → 每 session/machine 随机 AES-256 DEK 用 content public key 包装后存服务端 → 内容用 DEK 加密；服务端只见 blob。<https://happy.engineering/docs/security/>
- 配对：电脑显示含一次性公钥的 QR；手机扫码后回传账号公钥（只有电脑能解开）；之后每会话随机密钥用账号公钥包装；设备用账号派生 key 自签随机 challenge 完成零往返认证。<https://happy.engineering/docs/how-it-works/>
- 中继自己承认的**元数据边界**：relay "sees that machines and sessions exist and when they were active, not what is in them"——即盲中继仍泄露设备/会话存在性与活跃时间。<https://happy.engineering/desktop/docs/mobile/>
- 推送：README 称推送通知端到端加密、"we can't see the content"（即 payload 不携带明文）。<https://github.com/slopus/happy/blob/main/packages/happy-server/README.md>
- 已知事故/设计争议：本次调研未检索到经一手确认的安全事件记录；上述"元数据可见"是设计文档自述的边界，不是事故。⚠️（未证实部分不写）

---

## 4. 架构模式总结（3 种）

### 模式 A：直连 / VPN / SSH（VibeTunnel + Tailscale、SSH 主机）
- 形态：主机跑本地服务或 sshd，手机通过 Tailscale/WireGuard/SSH 隧道直连，无厂商中继。
- 优点：信任面最小（无第三方中继）；可自托管天然成立；成本低；crypto 用现成（WireGuard/SSH）。
- 缺点：用户要装 VPN/配 SSH；NAT/防火墙/唤醒是常见故障；**没有推送**（App 后台被挂起后收不到提醒）；手机端体验差（终端缩放、审批 UI）；多设备/团队共享难。
- 证据：VibeTunnel 把 Tailscale 列为推荐远程方案、ngrok/Cloudflare 为备选：<https://github.com/amantus-ai/vibetunnel>；Codex 对 SSH 主机也提示"用 VPN/mesh，不要暴露 app-server"：<https://learn.chatgpt.com/docs/remote-connections>

### 模式 B：盲中继 + 端到端加密（Happy）
- 形态：桌面 Agent 与手机都**出站**连 relay；配对时交换公钥；内容在两端加密，relay 只转发不透明 blob，并负责离线缓存与推送。
- 优点：跨 NAT/蜂窝网可用；relay 可自托管（单容器）；服务端被攻破/作恶也读不到内容；支持多设备、团队多人；有推送。
- 缺点：**端到端加密的工程复杂度最高**（密钥层级、密钥轮换、丢手机/多设备恢复、加密推送载荷）；relay 仍见元数据（设备/会话存在、活跃时间、流量大小，可被流量分析）；服务端推送仍需 APNs/FCM 凭据。
- 证据：<https://happy.engineering/docs/how-it-works/>、<https://happy.engineering/docs/security/>、<https://happy.engineering/docs/guides/self-hosting/>

### 模式 C：账号体系 + 云中继（Codex / ChatGPT）
- 形态：桌面 App + 手机 App 都登录同一账号；厂商云中继按账号路由；二维码把手机与某台主机绑定；MFA/SSO/工作区策略集中管控。
- 优点：UX 最顺（不用配网络、扫码即用）；SSO/MFA/passkey、设备管理、管理员策略、企业审计齐全；推送、跨设备会话同步天然成立。
- 缺点：**不可自托管**；中继可读内容（未声明 E2E）；受厂商可用性/地域/套餐约束；企业管理员可一票关闭。
- 证据：<https://learn.chatgpt.com/docs/remote-connections>、<https://learn.chatgpt.com/docs/mobile>

> 变体 D：全托管云 Agent（Codex Cloud / Omnara sandboxes）——任务跑在厂商/云沙箱而不是"你自己的电脑"，不满足用户"控制自己机器"的诉求，仅作对照，不推荐。
> **我们应选 B**：满足"自托管 + 强安全"，同时保留 A 作为可选"局域网/直连加速路径"。

---

## 5. 手机 App 技术选型对比

> 前提：本产品是"远程控制/审批/查看 diff"的客户端，手机端**不执行**被控机器上的代码。

| 维度 | React Native / Expo | Flutter | 原生 iOS + Android | WebView 包壳 / PWA |
|---|---|---|---|---|
| 开发速度 | ✅ 最快：一套 TS 代码 iOS/Android/Web；Happy 用 Expo 已验证此品类可行（<https://github.com/slopus/happy>） | 快，但 Dart 生态与 Web 复用弱 | 最慢，两套代码 | 最快出 demo，但后面全要补原生 |
| E2E 加密库 | ✅ 纯 JS `tweetnacl`（Happy 正是 NaCl secretbox / AES-GCM，<https://github.com/slopus/happy/blob/main/docs/encryption.md>）；需要原生性能时可接 libsodium（<https://doc.libsodium.org/bindings_for_other_languages>） | ✅ 有 sodium/libsodium 绑定，但 RN/Flutter 两边都要自己封 | ✅ 直接 CryptoKit / JCA，最可控 | ⚠️ 受 WebCrypto 能力限制（X25519/AES-GCM 可用，NaCl 需 wasm/JS 库） |
| 安全存储 | ✅ `expo-secure-store`（iOS Keychain / Android Keystore）（<https://docs.expo.dev/versions/latest/sdk/securestore/>） | ✅ flutter_secure_storage 等社区包 | ✅ Keychain Services（<https://developer.apple.com/documentation/security/keychain_services>）/ Android Keystore（<https://developer.android.com/privacy-and-security/keystore>） | ❌ 无硬件级安全存储，不适合长期私钥 |
| 推送 | ✅ `expo-notifications`，经 Expo Push Service 转 APNs/FCM（<https://docs.expo.dev/push-notifications/overview/>）；也可直连 APNs/FCM（<https://firebase.google.com/docs/cloud-messaging>） | ✅ FCM/APNs 插件成熟 | ✅ 最可控（可做 Notification Service Extension 解密推送） | ❌ 基本不可用（无 APNs/FCM 原生对接） |
| 后台重连 | ⚠️ 需自己处理前后台 WebSocket 生命周期；iOS 后台会挂起 socket，一般靠推送唤醒 + 重连（工程判断，需实测） | 同等复杂度 | 最可控（BackgroundTasks/VoIP push 等，但审核更严） | ⚠️ 浏览器标签页被回收后不可靠 |
| 需要原生代码的部分 | 二维码扫描（expo-camera）、推送（含加密通知扩展）、背景 WS keepalive（必要时自写 native module） | 二维码/推送/后台 service | 全部 | 无（但能力也最弱） |
| 商店审核风险 | 中：需有"app-like"功能（见下） | 中 | 中 | **高**：纯包壳触碰 4.2 Minimum Functionality |
| 上架/分发路径 | Expo EAS Build → TestFlight / Play internal testing；后续正式上架 | 同 | Xcode/AS 直发 | PWA 可免审核但无推送/无安全存储 |

**审核约束（必须提前设计）**
- **4.2 Minimum Functionality**："Your app should include features, content, and UI that elevate it beyond a repackaged website." 纯 WebView 包壳风险最高。<https://developer.apple.com/app-store/review/guidelines/>
- **2.5.2**：App 必须自包含，不得下载/安装/执行会改变 App 功能的代码。<https://developer.apple.com/app-store/review/guidelines/> 本产品在手机上只做"遥控 + 展示"，不执行被控端代码，**天然合规**；但注意别在 App 内做"下载脚本/插件"。
- 远程终端/控制类 App 在 App Store 长期存在（Termius 等），说明品类本身可过审，关键是原生价值与安全说明：<https://apps.apple.com/us/app/termius-ssh-client/id549039908> ⚠️ 经验推断，仍需真实提审验证。
- 若 App 内支持创建账号，需提供 App 内账号删除入口（Apple 5.1.1(v) 账号删除要求，见同一 guideline 页面）——自托管场景通常没有"注册"，但仍要确认。
- 加密出口合规（Export Compliance）：使用标准加密（TLS/NaCl）需在 App Store Connect 填 ITSAppUsesNonExemptEncryption 等；属合规事项，需法务/上架前确认。<https://developer.apple.com/help/app-store-connect/manage-app-information/manage-encryption-export-compliance/> ⚠️ 待确认
- TestFlight：<https://developer.apple.com/testflight/>；Android 可用 Play internal testing/内部渠道，自托管用户也可侧载 APK。

**结论**：MVP 选 **React Native + Expo**（与 Happy 同路线、TS 复用、E2E 用 tweetnacl、SecureStore + expo-notifications），把"原生模块"压到最少；PWA/WebView 仅作 demo，不做主客户端。

---

## 6. 服务端技术选型

| 维度 | Node/TypeScript | Go | Rust |
|---|---|---|---|
| 代表性实现 | Happy relay：Node + Fastify + Socket.IO（<https://github.com/slopus/happy/blob/main/docs/deployment.md>） | Omnara：Go 后端 + Postgres（<https://github.com/omnara-ai/omnara>） | ——（本类产品少见一手案例） |
| 开发速度 | ✅ 最快；若 DSH 主栈是 TS 可共享协议类型（⚠️ 推断，需看 DSH 代码） | 中；类型安全、并发模型简单 | 慢；borrow checker + 生态少 |
| 单二进制/部署 | 需 Node 运行时；Docker 镜像或 Bun 编译单文件 | ✅ 原生静态单二进制，最适合 systemd/家用 NAS | ✅ 单二进制，体积小 |
| WebSocket/流式 | ✅ `ws`/Socket.IO 成熟，重连/房间/离线消息现成 | ✅ gorilla/websocket 等成熟 | ✅ axum/tokio 成熟但样板多 |
| 运维负担（单用户/家庭） | 低：1 个 Docker 容器 + PGlite/SQLite 即可（Happy 模式：<https://happy.engineering/docs/guides/self-hosting/>） | 最低：单二进制 + 嵌入式 SQLite | 低（若团队会 Rust） |
| 扩展（SaaS/多租户） | 中：加 Redis/Postgres，Socket.IO adapter 横向扩展（Happy 多副本用 Redis Streams，<https://github.com/slopus/happy/blob/main/docs/multi-process.md>） | 好：Postgres + 无状态 worker（Omnara 架构，<https://docs.omnara.com/introduction>） | 好但人力成本高 |
| 安全要点 | 反代 TLS、短期配对 token、每设备密钥、限流；**不要**把内部 app-server 直接暴露公网（Codex 同款警告：<https://learn.chatgpt.com/docs/developer-commands?surface=cli>） | 同上；静态二进制便于最小化攻击面 | 同上 |
| 协议建议 | WebSocket 做双向实时（配对、审批、流式输出），HTTP 做登录/设备管理/文件；移动网络断线用可恢复会话（消息序号 + 重放补拉） | 同 | 同 |

**选型建议**：
1. **MVP：Node/TS 中继**（Fastify/ws 或 Socket.IO）+ 单容器 + SQLite/PGlite 起步；与 DSH 生态一致、和手机端共享 zod/protobuf 类型，迭代最快。（⚠️ 建议）
2. **若要"单二进制 + 家用 NAS 极简部署"**：Go 版中继作 V2；协议先定好，服务端可替换。
3. **Rust 不推荐**作为首版（人力/迭代速度），除非团队已有 Rust 能力且安全审计是硬指标。
4. 部署形态：单容器（`--restart unless-stopped`）+ 反代（Caddy/Nginx，自动 TLS）；家庭场景加 Tailscale 兜底；SaaS 场景再加 Postgres/Redis/对象存储与水平扩展。
5. 推送：自托管 relay 需持有 APNs key / FCM 项目；可选"中继内置推送"或"手机直连 Expo Push"。**推送载荷必须无敏感内容**（只发"需要审批/任务完成"，内容进 App 后走 E2E 通道拉取），避免通知栏泄露——Happy 声称推送加密（<https://github.com/slopus/happy/blob/main/packages/happy-server/README.md>），我们至少要做到 content-free。

---

## 7. 对我们方案的启示 + 待确认问题

### 7.1 启示（给 Lead 的决策建议）

1. **产品形态照抄 Codex，信任模型照抄 Happy**：入口/配对/审批/看 diff 的 UX 按 Codex；中继选择盲转发 + E2E，按 Happy 的密钥层级实现（master secret 仅手机、content keypair、每会话 AES-256-GCM DEK、QR 一次性公钥）。（✅ 依据 §2/§3）
2. **入口位置**：桌面/Web GUI 侧边栏底部、**账号/设置区上方**加一行"远程访问 / 手机连接"（用户诉求），点击弹出二维码与已连接设备列表；设置页保留 `Connections > Control this device` 的细粒度开关（Codex 同款双重入口：侧边栏快捷入口 + Settings 详细页）。（⚠️ 布局推断，建议出 UI 稿确认）
3. **配对流程**：桌面端生成"短期、一次性"二维码（含 relay URL + 本机公钥 + 一次性 token），手机扫码 → 用账号公钥回封 → 桌面确认（可要求本机二次确认）→ 建立设备信任；需支持**设备列表/撤销/丢手机恢复**（Codex 有 Connected Devices，Happy 有恢复会话）。（✅ 参考实现均具备）
4. **审批策略是安全核心**：手机可批准 = 把主机权限搬到手机上。默认值应保守：高危命令（rm -rf、git push --force、生产环境）强制回桌面批准或二次确认；审批记录可审计；手机 UI 必须展示完整命令与 diff 摘要，而不是截断文本。（⚠️ 建议；Codex 文档确认"沙箱与审批仍生效"，但手机审批的细粒度策略官方未公开）
5. **主机可用性是产品的一部分**：需处理"电脑睡眠/断网/App 关闭"（Codex 文档明确这是断连主因），提供常开设备引导、唤醒策略与状态提示。（✅ 依据 Codex 文档）
6. **不要重复造 SSH**：SSH 主机连接可作为高级能力（Codex 已证明 `~/.ssh/config` + 远端 app-server 模式可行），但首版聚焦"本机 + 中继"。（⚠️ 建议）
7. **合规先行**：App Store 4.2（要有原生价值，不做 WebView 壳）、2.5.2（不在 App 内执行下载代码）、推送内容脱敏、加密出口申报、账号删除（若有注册）。（✅ 见 §5 链接）
8. **自托管的"最后一公里"**：给用户 Docker Compose 一键部署 + 反代 TLS 模板 + 二维码里自动带 relay 地址；手机 App 登录界面允许填自建服务器地址（Happy 的自托管流程正是这样：在 App 首屏齿轮里填 Server URL）。（✅ <https://happy.engineering/docs/guides/self-hosting/>）

### 7.2 待确认问题（需 Lead / 用户拍板）

1. **目标平台**：首版只 iOS，还是 iOS+Android 同步？是否需要 Web 客户端？（影响 Expo 与原生模块工作量）
2. **relay 归属**：用户自己部署（家庭 NAS/Mac mini）还是 DSH 官方提供托管中继？还是两者都要（自托管优先、官方 relay 可选）？
3. **账号体系**：复用 DSH 现有账号，还是手机端只做"设备配对码"不设账号？决定权限模型与 App Store 账号删除合规。
4. **E2E 强度**：必须"中继零知识"（Happy 级）吗？若接受账号+云中继（Codex 级），可省大量密钥管理复杂度，但与"self-hosted + 强安全"诉求冲突。
5. **中继可见的元数据**：是否接受 relay 看到"设备/会话存在与活跃时间"（Happy 也承认这点）？是否需要 padding/流量混淆？
6. **推送基础设施**：接受 Expo Push（第三方，最省事）还是自建 APNs/FCM 对接（更私密、运维重）？通知内容如何脱敏？
7. **审批策略默认值**：手机能否批准所有命令？哪些命令必须回桌面？是否需要手机端二次生物识别（Face ID/Touch ID）？
8. **后台重连指标**：iOS 锁屏 5 分钟/30 分钟后仍要收到审批推送吗？这决定是否必须做 Notification Service Extension / 加密推送。
9. **DSH 服务端现状**：DSH Web GUI 是否已有可复用的 HTTP/WS 服务与账号体系？（决定是"加一个 relay 进程"还是"在现有服务上加模块"）
10. **入口范围**：用户说的"账号上方"具体是 DSH 桌面 App 侧边栏、Web GUI 侧边栏，还是未来手机 App 内的底部导航/抽屉？需要一张参照截图确认。
11. **自托管部署目标**：Docker Compose / 单二进制 / macOS 菜单栏 App（像 VibeTunnel）/ NAS 套件？影响服务端语言与打包方式。
12. **安全审计与事故响应**：是否需要外部审计、漏洞披露政策、日志与遥测开关（自托管用户通常要求零遥测）。

---

## 附：一手来源清单（按主题）

- Codex 手机访问（官方）：<https://learn.chatgpt.com/docs/mobile>、<https://learn.chatgpt.com/docs/remote-connections>
- Codex CLI/远程控制（官方）：<https://learn.chatgpt.com/docs/developer-commands?surface=cli>
- Codex 审批与安全（官方）：<https://learn.chatgpt.com/docs/agent-approvals-security>
- Codex DevDay 2026：<https://openai.com/zh-Hans-CN/index/devday-2026-recap/>
- Happy 主仓：<https://github.com/slopus/happy>；工作原理：<https://happy.engineering/docs/how-it-works/>；加密：<https://happy.engineering/docs/security/>；自托管：<https://happy.engineering/docs/guides/self-hosting/>；桌面端手机配对：<https://happy.engineering/desktop/docs/mobile/>
- Happy 协议/加密源码文档：<https://github.com/slopus/happy/blob/main/docs/encryption.md>、<https://github.com/slopus/happy/blob/main/docs/deployment.md>
- Omnara：<https://github.com/omnara-ai/omnara>、<https://docs.omnara.com/introduction>
- VibeTunnel：<https://github.com/amantus-ai/vibetunnel>
- Apple 审核：<https://developer.apple.com/app-store/review/guidelines/>；TestFlight：<https://developer.apple.com/testflight/>
- Expo 推送/安全存储：<https://docs.expo.dev/push-notifications/overview/>、<https://docs.expo.dev/versions/latest/sdk/securestore/>
- 平台密钥库：<https://developer.apple.com/documentation/security/keychain_services>、<https://developer.android.com/privacy-and-security/keystore>
- 直连/远程方案参照：<https://tailscale.com>（VibeTunnel 文档推荐）、<https://apps.apple.com/us/app/termius-ssh-client/id549039908>（远程终端上架先例）

> 时效性提醒：Codex 相关界面/命名仍在快速变化（Remote → Codex、Windows 支持、DevDay 新能力），所有"入口/文案"结论建议以 2026-10 之后的最新官方文档与真机截图二次确认。
