# 群体版推送 R2 实现契约（官方推送与 relay 解耦）

> 2026-11-01 · 分支 `feat/group-service` · 状态：**已实现（代码+测试），待真机验收**
> 关联：[`group-push-routing-options.zh.md`](group-push-routing-options.zh.md)（方案/取舍）、
> [`group-push-load-evaluation.zh.md`](group-push-load-evaluation.zh.md)（负载/限流默认值）、
> [`group-push-design.zh.md`](group-push-design.zh.md)（旧 O1 契约：self 推送仍有效；official 转发已删除）、
> [`group-push-usage.zh.md`](group-push-usage.zh.md)（使用与边界：字段说明/常见误报 bug/排错）。
> 版本：**protocol 0.3.2 / push-hub 0.3.3 / host-plugin 0.2.8 / App 0.2.0 (build 20，官方构建；self 包为 0.1.9 build 17，代码相同)**；
> relay **0.4.1**：只保留 self 推送；R2 官方推送不经过 relay。
> **2026-11-08：credential 默认 TTL 由 7 天延长到 30 天**（只有 App 能 PoP 续期；主机侧续期改造记入 todo，详见 `todo/TODO.md`）。
> **2026-11-02 决策补充：legacy O1「relay 转发官方 hub」已整体删除**（relay 0.4.0 / hub 0.3.0）——
> hub 只识别 App 设备（device credential），不再识别 relay；兼容没有必要（官方 App 从未发布旧版本，
> 且自签 App 的 token 官方 key/topic 也发不动）。
> 验证记录：`npm test` **299/299**、`validate:artifacts` ✅、R2 进程级冒烟 18/18
> （challenge→enroll→credential→device push/限流）；App self 包 0.1.9/17 已装机，
> **官方包 0.2.0 build 20（official 通道）已上传 TestFlight**。
> **2026-11-09：official 通知携带 `sessionId`（hub 0.3.3 / host 0.2.8），点通知可直达会话**。
> **2026-11-08：推送详细内容与 error 类型**——主机侧「详细推送内容」开关默认关闭；
> 开启后 official hub 接受可选 `title/body`（≤60/160 字），关闭时只发通用文案；
> 通用文案区分 `turn-end` / `waiting-answer` / `error`。

## 1. 目标与非目标

**目标**：官方 App 的推送**完全不依赖部署方 relay**——官方 App 用设备密钥向官方 hub 换
per-device credential，主机拿 credential 直连 hub 上报；self（部署方自签 App）走 relay 自己的
APNs key（与 hub 无关）。

**已删除（2026-11-02）**：O1 legacy 的 official 转发链路（relay → 官方 hub）。hub 端同时删除
relay 识别（relay 凭据库 / `relay create` CLI / 每 relay 限流）。理由：这条路只有「旧官方 App」
才会用，而官方 App 从未发布过；且自签 App 的 device token 官方 key/topic 发不动，本来就不通。

**非目标（本期）**：自签名 App 的推送（由部署方未来按同一协议对接自己的 hub）；
App Attest/DeviceCheck（后续可选加固）；R2 之外的多端账号体系。

## 2. 概念

| 概念 | 定义 |
|---|---|
| channel | `official`（官方 App）/ `self`（部署方自签 App） |
| bundleId | App 的 `applicationId`（iOS bundle id / Android package） |
| hubEndpoint | 官方 hub 的 **公开 HTTPS 基址**（官方 App 打包时内置，`https://push.example.com` 形式） |
| credential | hub 签发的 JWT（EdDSA），绑定 **tokenHash + hostId + environment + bundleId + aud + exp** |
| 官方 App | owner 团队签名、官方 bundle id、官方分发；`EXPO_PUBLIC_PUSH_CHANNEL=official` |
| self App | 部署方自己签名/改包；`EXPO_PUBLIC_PUSH_CHANNEL` 非 official（默认 self） |

## 3. 协议常量（`dsh-remoteService/packages/protocol`，0.3.1）

```js
export const PUSH_CHANNELS = Object.freeze({ OFFICIAL: 'official', SELF: 'self' });
export const PUSH_ENROLL_VERSION = 'dshremote-push-enroll-v1';
export const PUSH_CREDENTIAL_TYP = 'dsh-push-device';
export const PUSH_CREDENTIAL_VERSION = 1;
export const PUSH_ENROLL_CHALLENGE_PATH = '/v1/enroll/challenge';
export const PUSH_ENROLL_PATH = '/v1/enroll';
export const PUSH_SEND_PATH = '/v1/push';

isPushChannel(raw)              // 'official' | 'self'
normalizePushChannel(raw, fallback = 'self')  // 旧客户端缺省 self
isValidBundleId(raw)            // 3..155, 仅 [A-Za-z0-9.-]，首尾字母数字
pushEnrollMessage({ challengeId, nonce, devicePublicKey, hostId, token, environment, bundleId }) -> Buffer
```

`pushEnrollMessage` 的字节必须与 App 完全一致（UTF-8，`\n` 连接，**无末尾换行**）：

```
dshremote-push-enroll-v1
<challengeId>
<nonce>
<devicePublicKey>
<hostId>            // 可为空串
<token>
<environment>
<bundleId>
```

签名：设备 P-256 私钥 ECDSA-SHA256（DER → base64url），复用现有
`verifyGroupDeviceSignature({publicKey, message, signature})`。

## 4. 官方 hub（`packages/push-hub` 0.3.0）接口

### 4.1 `POST /v1/enroll/challenge`

- body：`{ "devicePublicKey": "<base64url 65B>" }`（可选，仅用于校验格式）
- 返回：`{ ok, challengeId, nonce, expiresAt }`
- challengeId：16B base64url；nonce：32B base64url；TTL 120s；**一次性**；内存 Map。
- 限速：IP 60 次/小时。错误：`rate_limited`(429)、`invalid_request`(400)。

### 4.2 `POST /v1/enroll`

- body：
  `{ challengeId, nonce, devicePublicKey, hostId?, token, environment, bundleId, signature }`
- 校验顺序：
  1. IP 限速 20 次/小时；tokenHash 限速 5 次/小时；
  2. 字段格式（token 64hex 小写、environment `development|production`、`isValidBundleId`、
     hostId 可选且 `[A-Za-z0-9_-]{1,64}`、devicePublicKey 为合法 P-256 点）；
  3. 挑战存在、未使用、未过期、nonce 常量时间比较一致；
  4. `pushEnrollMessage(...)` 验签（`verifyGroupDeviceSignature`）；
  5. **bundleId 必须等于 hub 配置的官方 topic**（`apns.topic`）→ 否则 400 `unsupported_bundle_id`。
- 成功后消费 challenge，签发 credential：
  - header：`{ alg:'EdDSA', typ:'JWT', kid:'<key id>' }`
  - claims：`{ v:1, typ:'dsh-push-device', tokenHash: sha256Base64Url(token), env, bundleId,
    hostId?, aud: HUB_PUBLIC_URL, jti: randomUUID(), iat, exp }`
  - `exp = now + HUB_CREDENTIAL_TTL_DAYS(默认 30，0.3.1 起；原 7) 天`
  - 返回：`{ ok, credential, expiresAt, hub:{ endpoint: HUB_PUBLIC_URL, topic } }`
- 错误：`invalid_request` / `challenge_expired` / `challenge_used` / `invalid_signature` /
  `unsupported_bundle_id` / `rate_limited` / `enroll_disabled`。

### 4.3 `POST /v1/push`（仅 device credential）

- 请求：`Authorization: Bearer <deviceCredential>`，body ≤16KB。
- **device credential 模式**（唯一模式；relay token 转发已在 0.3.0 删除，未知 Bearer → 401）：
  - body：`{ kind, host?, token, environment?, title?, body?, sessionId? }`
    - `kind`：`turn-end` / `waiting-answer` / `error`；
    - `title`/`body`：**可选且必须成对**；仅在主机用户开启「详细推送内容」时发送，
      上限 60/160 字（Unicode code point），禁止控制字符；hub 不写日志；
    - `sessionId`：可选（≤128 字符，opaque），用于点通知直达会话；官方通道也携带，
      与详细内容开关无关；不写日志；
    - 缺省时 hub 使用 `genericPushContent(kind)` 的通用文案。
  - 校验：JWT 签名（hub 公钥）/exp/typ；`aud === HUB_PUBLIC_URL`；`bundleId === apns.topic`；
    `sha256Base64Url(body.token) === claims.tokenHash`；environment 若提供必须与 claims.env 一致；
    `kind` 合法。
  - 限速（超限 429 + `Retry-After`）：
    - 每 tokenHash：6 次/分钟、120 次/天；
    - 每 credential jti：6 次/分钟；
    - 每 host（body.host 规范化，缺省 `unknown`）：30 次/分钟；
    - 每 IP：60 次/分钟；全局：120 次/分钟。
  - 发送：现有 APNs 发送器，`title/body` 存在时使用，否则用通用文案，environment 用
    claims.env；APNs `Unregistered`/410 → 返回 `pruned:[token]`（host 负责删除该设备 token）；
    配置错误不 prune。
  - 返回：`{ ok, delivered, failed, pruned, mode:'device' }`。
- 其他：请求 body/token/credential 不写日志；错误码 `invalid_credential`、
  `credential_expired`、`token_mismatch`、`unsupported_bundle_id`、`rate_limited`。

### 4.4 `/healthz` 扩展

`{ ok, apns:{configured,topic}, credential:{enabled, ttlDays}, enroll:{enabled},
  limits:{...关键默认值} }`（不含任何密钥/token；无 relay/legacy 字段）。

### 4.5 配置/密钥/限流

新增 env（都有默认值，README 写明）：

```
HUB_PUBLIC_URL=https://push.example.com        # R2 必填（aud）
HUB_SIGNING_KEY_FILE=/data/push-hub-signing-key.pem   # Ed25519 PKCS8 PEM；不存在则 0600 自动生成
HUB_CREDENTIAL_TTL_DAYS=30
HUB_ENROLL_ENABLED=true
HUB_ENROLL_CHALLENGE_TTL_SECONDS=120

HUB_ENROLL_PER_HOUR_PER_IP=20
HUB_ENROLL_PER_HOUR_PER_DEVICE=5
HUB_CHALLENGE_PER_HOUR_PER_IP=60
HUB_PUSH_PER_MINUTE_PER_TOKEN=6
HUB_PUSH_PER_DAY_PER_TOKEN=120
HUB_PUSH_PER_MINUTE_PER_CREDENTIAL=6
HUB_PUSH_PER_MINUTE_PER_HOST=30
HUB_PUSH_PER_MINUTE_PER_IP=60
HUB_PUSH_PER_MINUTE_GLOBAL=120
```

限流实现：内存滑动窗口（复用 relay 的 `createRateLimiter` 思路即可，**不引入第三方依赖**）；
重启清零可接受；`Retry-After` 秒。

## 5. App（0.1.9 build 17）改动

### 5.1 打包配置（不写真实值进仓库）

- `src/lib/pushConfig.ts`：
  ```ts
  export type PushChannel = 'official' | 'self';
  export const PUSH_CHANNEL: PushChannel =
    process.env.EXPO_PUBLIC_PUSH_CHANNEL === 'official' ? 'official' : 'self';
  export const PUSH_HUB_ENDPOINT = (process.env.EXPO_PUBLIC_PUSH_HUB ?? '').replace(/\/+$/, '');
  ```
- 官方构建命令由 owner 注入 `EXPO_PUBLIC_PUSH_CHANNEL=official EXPO_PUBLIC_PUSH_HUB=https://<真实hub>`；
  仓库默认 `self` + 空 endpoint（开源构建不会误用官方通道）。
- `bundleId` 读 `expo-application` 的 `applicationId`。

### 5.2 登记流程（`src/lib/pushHub.ts` 新增，`src/lib/push.ts` 接上）

前提：拿到连接（含 `hostId`、`deviceKeyLabel`）、APNs token、environment。

1. 若 `PUSH_CHANNEL !== 'official'` 或 endpoint 为空 → 返回 null（走旧 self 注册）。
2. 读缓存 credential（SecureStore，key 用 endpoint|token|hostId 的 hash；带 expiresAt）；
   剩余 >24h 直接复用。
3. `POST {endpoint}/v1/enroll/challenge` `{devicePublicKey}`（`getGroupDevicePublicKey(label)`）。
4. 构造 `pushEnrollMessage`（与 §3 完全一致，hostId 用连接 hostId）；
   `signGroupChallenge(label, base64(message))` 得签名。
5. `POST {endpoint}/v1/enroll` body 同 §4.2 → 保存 credential/expiresAt。
6. 调 `POST /__dsh_remote/push-token`（`groupHttpFetch`，现有路径）：
   `{provider:'apns', token, environment, channel:'official', bundleId,
     hubEndpoint: endpoint, credential}`
7. 失败（hub 不可达/凭证过期且换不到）：不阻塞主流程；在 `push.ts` 的 status 里记录
   `官方推送暂不可用：<原因>`，进入主机/回前台时重试；**不回退 relay 转发**。
8. token/credential 不打印、不写日志；SecureStore 只存 credential（可存 token 摘要，不存明文）。

### 5.3 状态显示

`/__dsh_remote/status` 的 `push` 扩展后（见 §6），设置页推送卡显示：
`推送通道：官方（设备直连）/ 自部署（经 relay）` + 已登记设备数；失败显示原因。

### 5.4 版本/检查

- `package.json`/`app.json` version `0.1.9`、buildNumber 17、versionCode 17、
  `modules/dsh-mtls/android/build.gradle` versionName/versionCode 同步；
- `tsc`、`check:native`、`check:shell` 通过（真机构建/装机由 Lead 统一做）。

## 6. host-plugin（0.2.6）改动

### 6.1 `/__dsh_remote/push-token` 扩展（向后兼容）

- body 新增可选字段：`channel`、`bundleId`、`hubEndpoint`、`credential`。
- 校验（原有 device session token + 设备在册不变）：
  - provider/token/environment 同现状；
  - `channel` 缺省 = `self`（旧 App 兼容）；
  - `channel === 'official'` 时必须同时有 `bundleId`（合法）、`hubEndpoint`（**https** URL，
    ≤2048 字符，无 userinfo/query/hash）、`credential`（三段式 JWT 字符串，≤4096 字符）；
  - `channel === 'self'` 时拒绝携带 hub 字段（或忽略并记录警告）。
- 存储（**仅内存**，不落盘）：`pushDevices: Map<deviceId, {token, environment, channel,
  bundleId?, hubEndpoint?, credential?, registeredAt}>`；device 撤销/`device.sync` 清理。
- 返回：`{ ok:true, data:{ registered:true, channel } }`；错误 `invalid-body`/`invalid-channel` 等。
- 审计：沿用现有 `push-token` 审计，不写 token/credential。

### 6.2 推送发送分流

- 现有 `push.send` 意图入口不变（turn/end、ask_user_question 等），在发送阶段分流：
  - **self 设备**：沿用现有 `connector.sendPushIntent`（push.register 过的设备）；
  - **official 设备**：主机逐设备 `POST {hubEndpoint}/v1/push`
    `Authorization: Bearer <credential>`，body `{kind, host, token, title?, body?, sessionId?}`；
    `title/body` 仅在主机配置 `pushDetail=true` 时发送（默认关闭）；`sessionId` 始终携带（点通知直达会话）；超时 10s；**不重试**；失败记入 status；
  - 两类并存时都要发；没有 self 设备时不要向 relay 发 push.send（避免空转/额度）。
- 限速/去重沿用现有（30s/session、ask_user_question 按 callId）。
- 收到 hub 返回 `pruned:[token]` → 删除对应设备记录。

### 6.3 status / 设置页

- 主机设置新增「详细推送内容」`pushDetail`（默认 `false`）：开启后 official 请求带 `title/body`，
  self 请求带 `content=summary`；关闭时两种通道都走通用文案。
- `status.push` 增加 `detail` 布尔字段（不含 token/credential）。
- `error` 类型由 `turn/end` 的失败原因（`error` / `max-tokens` / `blocked`）触发。

`/__dsh_remote/status` 的 `push` 扩展（字段不含 token/credential）：

```json
{"enabled":true,
 "self":{"devices":1,"lastError":null},
 "official":{"devices":2,"lastError":null,"hub":"https://push.example.com"},
 "mode":"mixed"}
```

- 主机设置「推送提醒」开关语义不变（关闭 = 不发任何推送）；
- README 说明 official/self 两种设备可能会混用，主机自动分流。

### 6.4 版本

host-plugin 0.2.6（`package.json` + `lib/service.js` VERSION）。

## 7. relay：0.4.0（只做 self 推送）

- **删除** official 转发：`group.push.mode` 只接受 `self`；`group.push.official.*`、
  `RELAY_GROUP_PUSH_HUB_*`、`data/hub-token`、`lib/push-hub-client.js` 全部移除。
- self 推送保留（部署方自签 App 用自己的 APNs key，host → relay → Apple），行为不变。
- R2 官方推送不经过 relay：App 向官方 hub 登记，主机直连 hub。
- 升级注意：配置里如有 official 字段，启动会报清晰错误，删掉即可。

## 8. 测试/验收

### 8.1 单测（`cd dsh-remoteService && npm test`）

- protocol：channel/bundleId/enroll message 字节。
- push-hub：challenge→enroll→credential 校验全链路（真实 P-256 密钥对 + HTTP），nonce 一次性/
  过期/bundleId 不匹配/tokenHash 不匹配/rate limit(429)、device push、/healthz；
  relayToken 方式一律 401（legacy 已删除的回归）。
- host-plugin：push-token 新字段校验（official 缺 credential/hubEndpoint 非 https → 400；
  self 兼容旧 body）；动态 injection/hub 直连分流（mock fetch）；status 不含 token；
  pruned 清理；旧 relay 路径回归。
- relay：self 推送测试保持通过；official 配置会被拒绝。

### 8.2 App 静态 + 构建

`tsc` / `check:native` / `check:shell`；Lead 做 iOS Release 签名构建 + 装机（build 17）。

### 8.3 真机验收（用户确认，ACCEPTANCE 0.1.9 章节）

- 官方 hub 部署（Lead 本地起 hub + nginx 或直接 http? 必须 https；本机可用自签/反代，
  文档写明生产 https）；
- 官方 App 在自部署 relay 下（relay 不配 any push）→ 进主机后 official 设备登记成功；
  主机端 `status.push.official.devices >= 1`；turn/end 触发推送 → 手机收到；
- 混用：同一主机再配一台 self App 设备 → 两种设备各自收到（或 App 只有一种时跳过）；
- 关闭「推送提醒」→ 都不发；设备撤销 → 主机清理；
- 限流：脚本连续打 hub `/v1/push` 超 token 限额 → 429，正常推送不受影响；
- 日志/status/healthz 无 token/credential/密钥。

## 9. 写作用域（并行开发，避免冲突）

| 任务 | 写作用域 |
|---|---|
| hub R2 | `dsh-remoteService/packages/push-hub/**`、`server/.env.push-hub.example`、`server/docker-compose.push-hub.yml`、`server/nginx/push-hub-http.conf`、`server/README.md` §6 |
| host R2 | `dsh-remoteService/packages/host-plugin/**`、`dsh-remoteService/README.md`（host 相关） |
| App R2 | `dsh-remoteApp/src/**`、`dsh-remoteApp/package.json`、`dsh-remoteApp/app.json`、`dsh-remoteApp/modules/dsh-mtls/android/build.gradle`、`dsh-remoteApp/README.md`、`dsh-remoteApp/docs/ACCEPTANCE.md` |
| protocol/集成/文档/构建 | Lead：`packages/protocol/index.js` + test、本文件/STATUS/根 README、最终构建装机 |

## 10. 安全红线

- 不把 token/credential/私钥写日志、写 status、写文档；不进 git。
- hubEndpoint 只接受 https；hub 不记录 body 原文。
- credential 只存内存（host）与 SecureStore（App）；hub 签发 key 0600。
- 不削弱现有设备身份（会话 token）与 relay 盲管道语义。
