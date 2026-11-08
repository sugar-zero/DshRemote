# DSH Remote · 群体服务版（A 模式）状态

快照：2026-11-08 · 分支 **`feat/group-service`** · 本分支**只包含群体服务功能**，
不含 `main` 的 classic/单体版（mTLS 盲中继、主机证书、主机本机 APNs 推送、远程重启主机）。

## 当前版本

| 组件 | 版本 | 状态 |
|---|---|---|
| relay | **0.4.0**（镜像 `dsh-remote-relay:0.4.0-group`，已构建/导出） | 群体版全部能力 + **self 推送（部署方自签 App 用自己的 APNs key 直连 Apple）**；**official 转发官方 hub 的 legacy 已于 0.4.0 删除**（R2 官方 App 直连 hub，不经过 relay）；设备 token 只存内存 |
| host-plugin | **0.2.6** | 群体版 + **推送意图 / 按设备分流（`self`→relay，`official`→直连官方 hub）/ 「推送提醒」开关**；远程重启为可选组件（默认关闭） |
| protocol | **0.3.1** | 群体版协议常量/QR v2/帧/签名校验 + 推送枚举/控制消息 + **R2 通道/channel/bundleId/设备登记消息** |
| apns（新） | **0.1.0** | APNs HTTP/2 发送器（relay `self` 与官方 hub 共用，零第三方依赖） |
| push-hub（新） | **0.3.1** | 官方推送 hub（**R2-only**）：设备登记（P-256 PoP）/ EdDSA device credential / 按 device·host·IP·全局配额限流 / 主机直连；固定通用文案、无状态、不落 token；**不识别 relay**（legacy relay-token 已删除） |
| App | **0.2.0（iOS build 18 官方包 / Android versionCode 18）** | 群体 token 模式 + **R2 官方推送（App 向官方 hub 登记凭证、主机直连）+ 键盘避让修复（build 16 起）** + 通知点击跳转/推送设置卡；App 锁、远程重启 UI 保留；**0.2.0 build 18 = official 通道官方构建（2026-11-08 构建/装机）**；0.1.9 build 17 = self 包（代码相同）；⏳ 真机 R2 推送 + 键盘回归验收待用户确认 |

## 2026-11-02 决策补充：删除 legacy O1 official 转发（R2 彻底解耦）

- **背景**：R2 的目标是官方 App 推送与部署方 relay 彻底解耦。只要 relay 还能「转发 official 给 hub」，
  就存在"需要部署方配合才能用官方推送"的可能；而官方 App 从未发布过旧版本、自签 App 的 APNs token
  用官方 key/topic 也发不动 → 该兼容链路没有现实使用者。
- **结论（用户确认）**：relay 只保留 `self` 推送；hub 只识别 App 设备（device credential），
  不再识别 relay。相关代码/配置/CLI/文档一并删除：
  - relay：`group.push.mode=official`、`group.push.official.*`、`RELAY_GROUP_PUSH_HUB_*`、
    `lib/push-hub-client.js`、`data/hub-token`（relay **0.4.0**）；
  - hub：relay 凭据库 `hub-store.json`、`relay create/list/revoke` CLI、`/v1/push` 的 relayToken
    模式、per-relay 限流、`/healthz` legacy 字段（hub **0.3.0**）。
- **不受影响**：self 推送（部署方自己的 APNs key）、R2 主路径（App→hub 登记、主机直连 hub）、
  App/host-plugin 代码、R2 真机验收项。
- **镜像**：relay 0.4.0 / hub 0.3.0 已于 2026-11-02 构建/导出并做容器冒烟（见下方「镜像构建与冒烟」）；
  VPS 上的 relay 换镜像时清理旧的 official 配置（你本机 `server/.env` 未配过 push，安全）；hub 首次部署即可。

## 2026-11-02 镜像构建与冒烟（relay 0.4.0 / hub 0.3.0；hub 0.3.1 见 11-08 章节）

- 构建机：Apple Silicon，通过 colima `cch-amd64`（x86_64）原生 linux/amd64 构建（2026-11-02）。
- `dsh-remote-relay:0.4.0-group` → `server/dsh-relay-0.4.0-group-linux-amd64.tar`
  （62,759,936 bytes，sha256 `41218320…bbc2ea`）。
  - 容器冒烟（自签临时证书 + 临时 `/data`）：正常启动 group edge/control/api/admin，
    `GET /healthz` = `{"ok":true,…,"push":{"enabled":false,"mode":"self","tokens":0}}`；
  - `RELAY_GROUP_PUSH_MODE=official` → entrypoint exit 1，提示「已删除：R2 起官方 App 推送直连官方 hub」。
- `dsh-remote-push-hub:0.3.0` → `server/dsh-push-hub-0.3.0-linux-amd64.tar`
  （62,633,984 bytes，sha256 `ec63991e…b49e0`）；**2026-11-08 已升级为 0.3.1**（TTL 30 天），
  新 tar：`server/dsh-push-hub-0.3.1-linux-amd64.tar`（62,635,008 bytes，sha256 `97211f90…87804b`，
  容器 `/healthz` 冒烟 `credential.ttlDays=30` 通过）。
  - 容器冒烟：`/healthz` 只含 `apns/credential/enroll/limits`（**无 legacy/relays**）；
    旧式 relayToken `POST /v1/push` → 401 `invalid_credential`；签名 key 自动生成到
    `/data/push-hub-signing-key.pem`（0600）；`relay create/list/revoke` 子命令已不存在。
  - 顺手修：hub 镜像内补默认 `HUB_LISTEN_HOST=0.0.0.0` / `HUB_PORT=9445` /
    `HUB_SIGNING_KEY_FILE=/data/push-hub-signing-key.pem`（手动 `docker run` 也不会把 key 落到 `/app`）。
- 两个 tar 均已 `docker load` 回环验证通过；部署命令与校验方式已写入 `server/README.md` §3.2/§6.5、
  `packages/relay/README.md`、`packages/push-hub/README.md`。

## 2026-11-08 官方 hub 部署就绪 + 官方 App build 18（0.2.0）构建/装机

- **官方 hub（push-hub 0.3.0）已部署**：Docker 容器 + nginx/HTTPS 公网入口（`HUB_PUBLIC_URL` 为
  `https://<hub 公网基址>`，真实地址只在部署环境，不入库）；APNs Auth Key 使用 Sandbox & Production
  覆盖的 key；`/data` 卷持久化 Ed25519 签名 key；容器日志 `apns=ready credential=enabled enroll=enabled`。
  公网自检：`POST https://<hub>/v1/enroll/challenge` → **200**（challenge JSON），说明 DNS/TLS/反代/hub 全链路可用。
- **官方 App build 18（0.2.0 / official 通道）已构建并装机**（2026-11-08）：
  - 构建环境注入 `EXPO_PUBLIC_PUSH_CHANNEL=official` + `EXPO_PUBLIC_PUSH_HUB=https://<hub 公网基址>`
    （真实地址不入库；仓库默认仍 `self`/空）；
  - iOS Release 签名构建 `** BUILD SUCCEEDED **`，产物 `0.2.0 / 18`，entitlement `aps-environment=development`；
    `main.jsbundle` 内联 hub 地址与 `dshremote-push-enroll-v1`（无 `EXPO_PUBLIC_*` 运行时残留）；
  - `devicectl` 覆盖安装成功（设备端 `0.2.0 / 18`），启动成功；
  - App 静态检查：`tsc --noEmit`、`check:native`、`check:shell`（59/59）通过；
  - 版本号：工作区 `app.json`/`package.json`/模块三处已为 `0.2.0`，buildNumber/versionCode 18，
    `ios/Info.plist` 已同步（未重新 prebuild）；模块 podspec 同步 `0.2.0`。
- **说明**：0.2.0 build 18 与 0.1.9 build 17 **代码相同**，仅版本号 + 构建通道（self→official）不同；
  self 通道回归需另装 self 包，不能与官方包在同一台手机同时验证。
- **credential TTL 7 → 30 天（0.3.1）**：用户 2026-11-08 决策——先延长 TTL 作为过渡（只有 App 能 PoP 续期，
  主机侧续期改造记入 `todo/TODO.md`「P1 推送 credential 生命周期移交主机」）。hub 0.3.1 默认 30 天；
  部署时把 `HUB_CREDENTIAL_TTL_DAYS=30` 写进 `.env.push-hub` 并重启（已有 credential 按旧 exp 到期，App 下次续期换成 30 天）。
- **真机验收（2026-11-08 用户确认通过）**：official 设备登记（`push-token ok`）、锁屏/后台收到
  turn-end 与 ask_user_question 通知、点通知打开对应主机、主机「推送提醒」关闭→收不到/打开→收到、
  键盘删字不再跳动、hub 公网 `/v1/enroll/challenge` 200 且 `/healthz` 显示 `ttlDays=30`。
  遗留观察项：credential 自然续期（30 天 TTL，未到期）、设备撤销清理、其余功能全量回归。
  详见 `dsh-remoteApp/docs/ACCEPTANCE.md` 0.2.0 build 18 章节。
- **待用户验收**（历史）：

  通知点击跳转、credential 续期、关闭推送开关、撤销清理、日志无 token/credential、键盘删字回归、
  其它功能回归 —— 详见 `dsh-remoteApp/docs/ACCEPTANCE.md` 0.2.0 build 18 章节。

## 验收状态

- 历史（2026-11-01）：群体服务版首轮验收通过：App **0.1.5 (build 11)** + host-plugin **0.2.4** +
  relay **0.3.0**（配对/进入/手机布局/会话与实时消息正常；App 锁=全局冷启动+单连接可选；
  「重启主机 DSH」组件与保存后 App 即时刷新正常；当时前后台无任何推送）。
- 历史（2026-11-01）：App **0.1.7 (build 14)** 真机验收通过：主机内设置入口调整 + iOS 底部边缘手势 defer（含设置开关）。
- **R2 官方推送（protocol 0.3.1 / relay 0.4.0 / hub 0.3.0 / host 0.2.6 / App 0.1.9，本次）**：代码、单测、
  产物静态校验、进程级 R2 冒烟（18/18）通过；App 0.1.9 签名构建待装机；
  **真机验收未完成、待用户实测确认** —— 需要：① 部署 push-hub 0.3.0 到公网 HTTPS
  （`HUB_PUBLIC_URL`）；② 用官方 App 构建（`EXPO_PUBLIC_PUSH_CHANNEL=official` +
  `EXPO_PUBLIC_PUSH_HUB=<hub 地址>`）安装并进主机登记；③ 官方 hub 的 APNs 使用**官方团队** key。
  用户确认前不勾选 ACCEPTANCE 推送项、不提交。
- **键盘避让修复（App build 16 起）**：已装机，待用户复测「键盘弹出后删字页面跳动」；
  0.1.9 build 17 重新包含该修复。
- 验收记录：[`dsh-remoteApp/docs/ACCEPTANCE.md`](dsh-remoteApp/docs/ACCEPTANCE.md)。

## 2026-11-01 新增：服务端集中推送（两种模式）

契约：[`docs/group-push-design.zh.md`](docs/group-push-design.zh.md)；部署：[`server/README.md`](server/README.md) §6。

### 两种模式（relay 配置 `group.push.mode`）

- **`self` 自部署推送**：部署方把自己的 APNs Auth Key（`.p8`/Key ID/Team ID/Topic）配在 relay 上，
  relay 直连 Apple；App 必须是部署方自己 Apple 团队签名的包（bundle id = `self.topic`）。
  默认通用文案；显式设 `content=summary` 才带会话标题/助手回复摘要。
- **`official` 官方推送**：relay 不持有 Apple 凭据，只把 `kind + host + 设备 token` 转给**官方推送
  hub**（项目所有者运营，官方团队 key 发送）；hub 固定通用文案、**不接收会话内容**，schema 直接拒绝
  `title/body/sessionId`；relay 配置 `content=summary` 会被校验拒绝。

### 实现

- **protocol 0.3.0**：新增 `PUSH_TOKEN_PATH`、`RELAY_MSG.PUSH_REGISTER/PUSH_REGISTERED/PUSH_SEND/PUSH_RESULT`、
  `PUSH_PROVIDER/PUSH_ENVIRONMENT/PUSH_KINDS`、`GROUP_PUSH_*` 限额、`isValidApnsDeviceToken/isPushEnvironment/isPushKind`。
- **apns（新包）**：ES256 provider token（缓存 50min）、HTTP/2、sandbox/production 路由、
  410/Unregistered 才清理 token（配置错误不删）、通用文案表 `genericPushContent(kind)`。
- **relay**：`group.push` 配置（self/official、content、cooldown、env 变量 + entrypoint 自动生成 + 校验）；
  push 服务（token 表内存、按 host 限速/cooldown、self 用 apns 包、official 用 hub 客户端 20s 超时、
  内容策略、device.sync/revoke 清理）；控制消息处理；`/healthz` 附带 `push:{enabled,mode,tokens}`。
- **host-plugin**：`session/event` 触发（turn/end completed/error/max-tokens/blocked、无 reason 按 main 语义；
  `ask_user_question` 等待作答；子代理跳过；30s 会话冷却；callId 去重），`push.send` 意图；
  `POST /__dsh_remote/push-token`（会话 token + 设备在册鉴权，转发 `push.register`，5s 超时→503 `push-timeout`）；
  `status.push`（enabled/mode/tokens/lastError，不含 token 明文）；设置页「推送提醒」开关（保存不重建运行时）；
  重连后自动补报 token。
- **App 0.1.8**：`expo-notifications` + config plugin（`aps-environment` entitlement）；
  APNs device token + environment 经原生 `groupHttpFetch` 登记到主机；前台也显示系统通知；
  点击通知/冷启动按 `body.host` 打开主机、`body.sessionId` 尝试跳会话；设置页「推送」卡
  （开关/状态/重新注册/服务器状态）。
- **push-hub（新包）**：`/v1/push` Bearer relay 凭据（store 只存 SHA-256、可撤销）、schema 只收
  `kind/host/tokens`、每 relay 限速、每请求 token 上限、APNs 发送（可注入 mock）、`pruned` 透传、
  `/healthz`；CLI `relay create|list|revoke` + `serve`；Docker/compose/nginx 部署模板。

### 安全与隐私

- 主机**零 Apple 凭据**：只上报推送意图与设备 token（经已鉴权控制连接），不接触私钥/token 文件。
- `official` 通道 relay 转发前剥离 `title/body/sessionId`；hub 只发固定通用文案。
- APNs 私钥 / hub relay token 只放部署方服务器 `data/`（0600，容器只读挂载），不入仓库、不打印、不进日志/`healthz`。
- relay/hub 都**不持久化设备 token**（内存），重启后 App 重新进入主机/回前台自动重登记。
- 设备撤销（`device.revoke`/`device.sync`）立即从 relay token 表删除；host 侧撤销后登记请求 401。

### 验证（本次）

- `dsh-remoteService`：**`npm test` 275/275**（protocol/apns/host-plugin/relay/push-hub）；
  **`npm run validate:artifacts` 通过**（含 relay / group / push-hub compose 渲染）。
- App：`npx tsc --noEmit`、`npm run check:native`、`npm run check:shell`（59 项）通过；
  iOS Release **签名构建 `BUILD SUCCEEDED`**（0.1.8/**build 16**，`aps-environment=development`），
  已 `devicectl` 覆盖安装并启动到 iPhone（设备端确认 `0.1.8 / 16`）；
  **安装成功 ≠ 测过，推送 + 键盘修复真机验收待用户实测**。
- **服务端本地运行态冒烟（Lead，非用户验收）**：
  1. relay `official` 模式 + stub hub（**historical：该能力已于 2026-11-02 删除**）：**12/12** —— register/send、hub 只收 `{kind,host,tokens}`
     （无 title/body/sessionId）、cooldown、非法 kind；
  2. relay `self` 模式 + 真实 APNs sandbox：**5/5** —— 随机 provider key 被 Apple 判
     `InvalidProviderToken`，relay 归类为配置错误且不清理 token（JWT/HTTP2/sandbox 链路真实可用）；
  3. 真实 host-plugin `RelayConnector` ↔ 真实 relay 跨实现联调：**10/10** —— 含 relay 重启后
     connector 自动重连并补报 token（`/healthz` push.tokens 恢复）；
  4. 真实 push-hub 进程 + CLI + 真实 APNs：**13/13** —— `relay create/list`（store 0600 只存
     sha256、list 不显示 token）、`/healthz`、`/v1/push` 鉴权（错误 token 401）与 schema
     （带 title/body → 400）、真实 APNs 配置错误归类（failed=1/pruned=[]）、日志不含 token；
  5. relay-entrypoint 配置自动生成（**historical：official 组已删除**）：**8/8** —— self/official 两组 env → `relay.json` 的
     `group.push`（0600）、已有配置不覆盖、缺 `RELAY_DOMAIN`/证书时的可操作报错；
  6. compose 渲染核对：relay 的 push env 与 `data/apns` 只读挂载、hub 的 `HUB_*` env 与只读根文件系统。
- 未验证项：真实 APNs 推送（需部署方 APNs key / 官方 hub 真实公网部署与 nginx）、
  Android FCM（无 SDK，未接入）。
- 部署产物（2026-11-02 更新：relay 0.4.0 + hub 0.3.0 均已构建/导出）：
  - `server/dsh-relay-0.4.0-group-linux-amd64.tar`（62,759,936 bytes，
    sha256 `41218320c65e4ff04a417006afcafd29702b70d61dd2553d9f35f40915bbc2ea`）；
  - `server/dsh-push-hub-0.3.1-linux-amd64.tar`（62,635,008 bytes，
    sha256 `97211f903903076dc796f274db299b94f34fb2efbc63ef842e93e4543f87804b`）；
  - 上一版 `dsh-relay-0.3.1-group-linux-amd64.tar` 仍在 `server/`，仅作回滚/过渡。

### 契约偏差（已记录）

- turn/end `reason===undefined` 按 `completed` 触发（与 main 一致；契约字面只列 4 种 reason）。
- `push.register` 5s 未回执 → 主机返回 `503 push-timeout`（可重试，App 侧按可重试处理）。
- `push.send` 的 `id` 用 `randomUUID()`；relay cooldown 命中回 `ok:true, skipped:"cooldown"`。
- push-hub 的 relay 凭据 store 默认文件名 `hub-store.json`（与配置文件 `hub.json` 分离，防覆盖）。
- relay → hub 的 HTTP 客户端超时 20s（hub 并行发 APNs 单请求 15s，留余量）。

## 2026-11-01 新增：R2 官方推送（与 relay 解耦，当前方案）

契约：[`docs/group-push-r2-contract.zh.md`](docs/group-push-r2-contract.zh.md)；方案取舍
[`docs/group-push-routing-options.zh.md`](docs/group-push-routing-options.zh.md) §3.3；限流
[`docs/group-push-load-evaluation.zh.md`](docs/group-push-load-evaluation.zh.md)；
O1 历史契约：[`docs/group-push-design.zh.md`](docs/group-push-design.zh.md)（self 推送仍有效；official 转发已删除）。

### 数据流

```
官方 App（官方团队签名，内置 hub 地址 + channel=official）
  │ 1) 用群体版 P-256 设备私钥向官方 hub 登记：POST /v1/enroll/challenge → /v1/enroll
  │    → 得 per-device credential（EdDSA JWT：tokenHash+hostId+env+bundleId+aud+exp，7 天）
  │ 2) POST /__dsh_remote/push-token {token,env,channel,bundleId,hubEndpoint,credential}
  ▼
主机（零 Apple 凭据、零推送配置）——按设备分流：
  ├─ official 设备 → 直连 hub：POST {hubEndpoint}/v1/push（Bearer credential）
  └─ self 设备     → 原有 relay push.register/push.send（self APNs）
```

- **官方推送不再依赖部署方 relay 配置**：relay 只是隧道，谁部署都不影响官方 App 推送；
- 官方 hub 只发**固定通用文案**，不接收会话内容；device token 不持久化（每次随请求带 token hash 校验）；
- 混合设备（官方 App + 自签 App）自动按 channel 分流；App/主机/relay 都不需要人工选通道。

### 组件改动（本次）

- **protocol 0.3.1**：`PUSH_CHANNELS` / `PUSH_ENROLL_VERSION` / `pushEnrollMessage` /
  `isPushChannel` / `normalizePushChannel` / `isValidBundleId` / `PUSH_CREDENTIAL_*` / hub 路径常量。
- **push-hub 0.3.0**：新增 `/v1/enroll/challenge`、`/v1/enroll`（P-256 PoP、nonce 一次性 120s、
  bundleId 必须等于配置 topic）、EdDSA device credential（Ed25519 key 0600 自动生成）、
  `/v1/push` 仅 device credential 模式；配额限流（device/host/IP/global + enroll）；
  `/healthz` 扩展；relay-token 转发/relay 凭据已删除（一律 401）。
- **host-plugin 0.2.6**：`push-token` 兼容扩展（channel/bundleId/hubEndpoint/credential，
  official 校验 https/格式/长度；仅内存存储）；推送发送按设备分流；`status.push` 新形状
  `{enabled,self:{devices,lastError},official:{devices,lastError,hub},mode}`；版本 0.2.6。
- **App 0.1.9（build 17）**：`pushConfig.ts`（构建注入 `EXPO_PUBLIC_PUSH_CHANNEL/HUB`，仓库默认
  self+空地址）、`pushHub.ts`（credential 登记/缓存/续期，失败不回退 relay）、`push.ts`
  扩展登记 body、设置页按通道展示状态；键盘避让修复（build 16 起）继续包含。
- **relay 0.4.0**：删除 official 转发（`mode` 只保留 `self`、删 `push-hub-client.js`/`data/hub-token`/`RELAY_GROUP_PUSH_HUB_*`）；self 推送行为不变。

### 验证（本次，Lead）

- `cd dsh-remoteService && npm test` → **296/296 通过**（删除 legacy official/relay-token 用例后：relay 70、push-hub 61；protocol/apns/host-plugin 用例不变；
  host-plugin 141 用例，self 推送无回归）。
- `npm run validate:artifacts` → ✅（含 server compose dummy-env 渲染；修正脚本 `${WARN}` 与
  push-hub `HUB_PUBLIC_URL` 必填后通过）。
- **R2 进程级冒烟（真实 hub 进程，18/18）**：healthz credential.enabled、challenge→enroll→
  credential 三段式 JWT、challenge 重放/错误签名被拒、device push 鉴权通过（随机 APNs key →
  Apple 配置错误、不 prune，符合预期）、token mismatch 401、device 限流 429+Retry-After、
  device credential 推送与限流回归、日志/healthz 无 token/密钥。
- App：`tsc`/`check:native`/`check:shell`（59 项）通过；iOS Release 签名构建（0.1.9/17，
  `aps-environment=development`）进行/待装机（见 ACCEPTANCE）。
- **未验证**：真机 R2 推送（需要官方 hub 公网 HTTPS 部署 + 官方 App 构建注入 hub 地址 +
  官方团队 APNs key）；官方 hub Docker 镜像未 build（本机 daemon 未运行）；nginx conf 未 `nginx -t`；
  Android FCM 未接入。

### 待用户动作（R2 真机验收）

1. 部署 **push-hub 0.3.0** 到公网 HTTPS（`HUB_PUBLIC_URL` = 该域名），配置官方团队 APNs key
   （`.p8`/Key ID/Team ID/Topic = 官方 App bundle id）；或让官方 hub 跑在现有 VPS 的 nginx 后面；
2. 用 **`EXPO_PUBLIC_PUSH_CHANNEL=official EXPO_PUBLIC_PUSH_HUB=https://<hub域名>`** 构建/安装
   官方 App（仓库默认 self，不会误用官方通道；真实域名不入库）；
3. 进主机 → App 自动登记 device credential → 主机 `status.push.official.devices >= 1`
   → 触发 turn/end 收到通知；同时回归键盘删字 + 原有 self/配对功能。

## 2026-11-01 修复：iOS 键盘弹出后删除文字页面上下跳（App 0.1.8 build 16）

- **现象（用户真机录屏）**：App 内点输入框弹键盘后连续删除文字，聊天区/输入框在两个位置
  上下**来回跳**（每次删字切一次）。
- **根因**：App 的 WebView 没做键盘避让，始终铺满全屏。iOS WKWebView 键盘弹出时给自己加
  `scrollView.contentInset` 并自动把页面滚到光标；DSH 页面按 100% 高度布局、composer 在
  页面底部被键盘盖住，于是每次输入/删除都要滚一次页面；同时 DSH 输入框是 CodeMirror
  （contenteditable），它也按 `visualViewport` 滚祖先容器 → 两套滚动意图交替，页面在两个
  offset 之间来回跳。逐帧分析：两次状态竖直位移约 **186 CSS px**，键盘本身不动。
- **修复**：`WebViewScreen` 的 WebView 容器换成 `KeyboardAvoidingView`（iOS `behavior="padding"`，
  Android 不启用避免与系统 `adjustResize` 叠加）：键盘出现时 WebView 缩到键盘上方，页面布局
  视口 = 可见区，不再需要滚页；附带 DSH 自己的会话 header 也不会被顶出屏幕。
- **版本**：App **0.1.8 build 16**（version 沿用未发布的 0.1.8，只递增 buildNumber/versionCode；
  build 15 的推送功能不变）。⏳ **待用户真机复测**（键盘/删字/收起后布局 + 推送回归）。
- **验证**：`npx tsc --noEmit`、`npm run check:native`、`npm run check:shell`（59 项）通过；
  iOS Release 签名构建 `BUILD SUCCEEDED`（0.1.8/16），已 `devicectl` 覆盖安装并启动到 iPhone；
  ⏳ **待用户真机复测**（详见 ACCEPTANCE 与诊断文档）。
- 根因/证据/备选方案：[`docs/diagnostics/13-app-keyboard-composer-bounce.md`](docs/diagnostics/13-app-keyboard-composer-bounce.md)。

## 2026-11-01 修复：主机内设置入口 + iOS 底部边缘手势（App 0.1.7）

- **主机内设置入口**：进入主机后顶栏 ⚙ 改为打开**这台主机**的「设备与安全」（连接设置），
  返回回到主机页面（WebView 常驻、不重载）；App「设置」只从主机列表（外面）右上角 ⚙ 进入，
  并删掉底部「设备与安全」卡片——连接设置只从每个主机进入。
- **iOS 底部边缘手势**：DSH 页面里可拖动的悬浮挂件贴到屏幕最底边后，从底边起手拖动会被
  iOS「上滑回主屏」系统手势抢走（App 直接进后台）。进入主机页面时 defer 底部系统手势
  （`preferredScreenEdgesDeferringSystemGestures`；公开 API + 运行时替换基类实现，进程内生效），
  离开主机页面恢复默认。代价是主机页内回主屏要连划两次；该行为做成 App 设置开关
  「主机页面手势 → 挂件贴底拖动」（默认开，关闭恢复一次上滑回主屏）。
- **版本**：App **0.1.7（iOS build 14 / Android versionCode 14）**；纯 App 改动，host-plugin /
  relay / protocol 不变。✅ **2026-11-01 用户真机验收通过**（主机内 ⚙、设置页入口、挂件贴底
  拖动、开关关闭后一次上滑均按预期）。
- **验证**：`npx tsc --noEmit`、`npm run check:native`、`npm run check:shell`（59 项）通过；
  iOS Release **BUILD SUCCEEDED**，`devicectl` 覆盖安装并启动。
- 验收记录：[`dsh-remoteApp/docs/ACCEPTANCE.md`](dsh-remoteApp/docs/ACCEPTANCE.md) 0.1.7 条目。

## 本轮（2026-11-01）剥离内容

- **host-plugin**：删除 classic TLS/mTLS/证书/CSR/CA、classic 配对、APNs/Expo 推送、
  `session/event` 推送监听与 `/__dsh_remote/{audit,devices,push-token}` 等 classic 接口；
  **远程重启主机保留为群体版可选组件**（0.2.1 恢复：`/__dsh_remote/status|restart` 走群体隧道，
  cookie/Bearer 鉴权，默认关闭，需在主机「设置 → 远程访问 → 组件」开启）；配置只剩群体字段。
  > 注：0.2.5 起以**服务端集中推送**的新形态重新提供推送（主机仍不持有 Apple 凭据），见上一节。
- **relay**：删除 classic 数据面 TLS 透传（443 盲转发）、classic HTTP 面（301/admin/push/devices）、
  relay push、tokens.json/主机 token CLI、classic 配置；`mode` 只接受 group，缺省即群体版；
  边缘默认开启（显式关闭才 warn）。0.3.1 起以新协议重新提供服务端集中推送。
- **App**：删除 iOS/Android 原生 mTLS（CSR/identity/network/mTLS WebView）、classic 配对与证书存储、
  原生 WebView 分支、APNs/通知/应用内通知卡片、通知设置与证书诊断；保留群体配对/token 会话/
  主机列表/设备与安全/RN WebView + 手机壳/内嵌浏览器；**远程重启 UI 恢复**（Bearer/cookie 原生请求），
  **App 锁只在冷启动/打开主机连接时触发并移到设置页**。0.1.8 起重新接入 iOS APNs 推送（服务端发送）。
- **server/**：删除 classic compose/env/nginx 模板与 host 证书脚本，只保留群体版
  `docker-compose.group.yml` + `.env.group.example` + group nginx 配置（0.3.1 另加可选官方 hub 部署模板）。
- **protocol / docs / scripts**：清理 classic 协议符号、classic POC/部署脚本与经典文档；
  根 README/STATUS/server README/包 README 全部改为群体版定位。

## 关键修复（本轮真机踩坑，详见 diagnostics）

- 配对后立刻 401、点重试又能进：relay 单请求隧道 + iOS keep-alive 复用连接，pairing 后的 challenge
  被透传到主机明文代理。修复：隧道化请求强制 `Connection: close`（Upgrade 除外）。
- 页面能开但「暂无会话/一直重连」：主机明文代理未代理 WebSocket Upgrade；已补 upgrade 代理。
- 跳内嵌浏览器/手机布局丢失：隧道 URL 带端口被误判外链；改为 hostname 匹配。
- 设备「从未连接」：群体版鉴权成功时更新 lastSeen。
- 其他：多 challenge 并存、重连不清设备表、旧设备失效提示、错误响应诊断。

完整记录：[`docs/diagnostics/12-group-service-issues.md`](docs/diagnostics/12-group-service-issues.md)。

## 部署入口

- relay 部署（证书/端口/nginx/后台/邀请码/**推送**/排障）：[`server/README.md`](server/README.md)
- 推送实现契约（两种模式/接口/安全）：[`docs/group-push-design.zh.md`](docs/group-push-design.zh.md)
- 官方推送 hub（运营方）：[`dsh-remoteService/packages/push-hub/README.md`](dsh-remoteService/packages/push-hub/README.md)
- 主机插件：[`dsh-remoteService/packages/host-plugin/README.md`](dsh-remoteService/packages/host-plugin/README.md)
- App：[`dsh-remoteApp/README.md`](dsh-remoteApp/README.md)
- 设计/安全决策：[`docs/group-service-design.zh.md`](docs/group-service-design.zh.md)

## 已知限制

- **真机推送验收未完成**：需部署 relay 0.4.0（self 需 APNs key；official 由官方 hub 负责，不过 relay）+
  带 Push 能力签名的 App 安装后由用户实测；用户确认前不提交、不勾选验收。
- Android 未构建/未真机（本机无 Android SDK）；**FCM 未接入**（App 对 Android 返回明确原因）。
- relay/hub 的设备 token 只存内存：relay/hub 重启后 token 表清空，App 重新进入主机/回前台时
  自动重登记；重登记前不会送达推送（设计取舍：避免在服务端持久化设备 token）。
- `official` 模式只发固定通用文案（hub 不接收会话内容）；`self` + `summary` 可选，锁屏可见，自行评估隐私。
- 主机侧「推送提醒」关闭只停止新的推送意图；已登记 token 在设备撤销/relay 重启前仍在表里
  （当前没有 App 主动注销接口）。
- App 本地推送开关只停止新的登记；已登记 token 同理（可配合主机开关/设备撤销立即失效）。
- relay 0.3.1 镜像已于 2026-11-01 在本机构建/导出（`server/dsh-relay-0.3.1-group-linux-amd64.tar`，
  仅作回滚/历史；0.4.0 镜像待重建（构建命令见 `server/README.md` §3.2）
  sha256 见 `server/README.md` §3.2；`docker load` + 容器 `/healthz` 冒烟通过）；官方 hub 镜像尚未构建。
- iOS 原生无法把 App 注入的会话 cookie 设为 HttpOnly（依赖 relay `Set-Cookie`，见设计文档）。
- 协议/配置仍会演进，仅限小范围邀请制使用。
