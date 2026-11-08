# 群体版推送通道架构：方案与取舍（决策稿）

> 状态：**已拍板**（2026-11-01 选 R2；2026-11-02 补充：删除 legacy O1 official 转发）· 分支 `feat/group-service`
> 关联：[`group-push-design.zh.md`](group-push-design.zh.md)（当前实现契约）、
> [`../STATUS.md`](../STATUS.md)、`todo/TODO.md` T2.1（main 分支）
> 脱敏：域名 / hostId / Bundle ID / Team ID 一律占位符。

## 0. 要解决的问题（用户提出）

当前实现（0.3.1/0.2.5/0.1.8）的语义是：

- `self`：主机只把「推送意图 + device token」经**已鉴权 WSS** 上报给自己的 relay；relay 用
  **部署方自己的 APNs key** 直接发 Apple；
- `official`：同一路径，relay 再用**部署方（relay）的官方凭据**把意图转发给**官方推送 hub**，
  hub 用官方团队 key 发。

所以**主机的意图始终上报给自己的 relay**，official 只是 relay 多转发一次。

用户期望的形态：

- 在**主机端设置**推送：自部署 → 上报到「自己的地址」（relay 下发接口地址，免填写）；
  官方推送 → 上报到**内置的官方推送接口地址**；
- 两种方案的差别只是：**主机的推送意图上报给用户自己，还是上报给官方（项目所有者）**。

另外已确认的两个约束：

1. **同一条 relay 下手机 App 的签名可能混用**（官方 App / 部署方自签 App）；
2. 自部署的地址**由 relay 下发即可**（主机零填写）；
3. 通道选择希望是**每主机可选**。

## 1. 先钉住三个概念（否则方案一定拧巴）

| 概念 | 是什么 | 谁决定 |
|---|---|---|
| **Provider**（谁发 APNs） | 官方团队 key（官方 hub）还是部署方 key（relay/自部署服务） | **由 device token 所属 App 的签名决定**：APNs topic 必须匹配签名团队/App |
| **Transport**（意图走哪条路） | 主机 → relay → provider；或主机 → provider 直连 | 部署/网络/信任决定 |
| **Device channel**（设备属于哪条推送通道） | 官方 App / 部署方自签 App | **设备属性**，不是主机属性 |

**关键结论：Provider 不能由「主机选择」决定，只能由「设备 token 的 App 签名」决定。**
官方 hub 用官方 key 发不动部署方自签 App 的 token（`DeviceTokenNotForTopic`），反之亦然。
因此：

- 主机级「通道选择」最多只能表达**偏好/白名单**（例如“允许官方推送、允许自部署推送”）；
  真正发的时候必须**按设备 token 的 channel 路由**；
- 如果同一主机/同一条 relay 下混用两种 App，**必须**让 App 在登记 token 时上报
  `channel`（official/self），relay 按设备分流；否则一半设备必然收不到推送。

## 2. 推荐的 v1 架构（改动最小、与现有实现兼容）

**Provider 按设备路由，relay 作为意图中枢（保留 official 的 relay→hub 转发）。**

```
App(官方/自签) --登记 token{channel}--> Host --push.register{deviceId,channel}--> relay
Host --push.send{kind,title,body}--> relay
relay 按设备 channel 分流：
  channel=self     -> relay 自己的 APNs key（dsh-remote-apns）直发
  channel=official -> 官方 hub（Bearer relay 凭据）发送
```

- relay 配置同时支持两套 provider（可只配一套；只配一套时该通道外设备不推送，状态里可见）。
- 主机设置页展示：`推送开关` + `可用通道`（来自 relay 注册/刷新响应下发）+ 每通道可用性；
  **地址全部由 relay 下发，主机不填**；可选的每主机「允许通道」偏好（默认全允许）。
- 现有「单一 mode」配置保留为兼容（只配一套 provider 时等价于旧行为；旧 host 不上报 channel
  时默认按 relay 配置的唯一 provider 处理）。

### 2.1 协议/配置草图

App → 主机登记（新增 channel）：

```json
{"provider":"apns","token":"<64 hex>","environment":"development",
 "channel":"official"|"self"}
```

relay 注册/刷新响应新增 push 摘要（只读展示，免填写）：

```json
{"push":{"enabled":true,"content":"generic",
         "providers":{"self":{"enabled":true},"official":{"enabled":true}},
         "endpoint":"https://<relay>/__group/push",        // self 意图地址（仅展示/未来直连）
         "officialEndpoint":"https://push.<官方域名>"}}
```

relay 配置（可同时存在；`mode` 保留兼容）：

```json
"push": {
  "enabled": true,
  "content": "generic",
  "self":     { "keyFile": "...", "keyId": "...", "teamId": "...", "topic": "<deployer bundle>" },
  "official": { "endpoint": "https://push.<官方域名>", "relayId": "r_...", "relayTokenFile": "/data/hub-token" }
}
```

`push.register` 控制消息新增 `channel`；`push.send` 不变，relay 内部按设备 channel 拆分；
`push.result` 增加 `perChannel: {self:{delivered,failed}, official:{...}}`。

### 2.2 O1（relay 转发官方 hub）的“保证边界”（重要）

**O1 不能保证推送**，它只对「官方 App 的 device token」成立。一次成功需要同时满足：

1. 设备 token 来自**官方团队签名**、**bundle id = hub 的 APNs topic**（官方 App 原包名，未被改）；
2. App 的 `aps-environment` 与 token 上报的 environment 匹配，且 hub 的 key 覆盖该环境
   （开发签名 → sandbox；发布签名 → production）；
3. token 有效（App 未卸载/换机、设备未被撤销）、用户已允许通知；
4. hub 可达、relay 在 hub 的凭据有效、未超配额。

**反例（部署方自签 / 改包名）**：部署方用自己的 Apple 团队重新签名、改了 bundle id（甚至只是换团队）
→ device token 的 topic / 签名团队与 hub 不匹配 → APNs 返回 `DeviceTokenNotForTopic` /
`InvalidProviderToken` 一类配置错误；hub/relay 只会记录并归类为配置错误，**不会推送成功，
也不会删除 token**。这不是“概率失败”，是必然失败。

因此 O1 必须配合**设备级路由**（§2.3）：relay 只把「bundle id == 官方 hub topic」的 token
转发 hub；其余设备走 self（部署方自己的 APNs topic）或明确跳过，**绝不能盲目全量转发**。
当前实现（单一全局 mode）如果 official 模式遇到自签/改包 App，就是上面这个必然失败场景。

### 2.3 设备级路由规则（v1 必须）

- App 登记 token 时上报 **bundleId**（`Application.applicationId`）+ 构建渠道常量
  （`channel: official|self`）；**relay 以 bundleId 为准做校验**，不完全信任 channel 声明。
- relay 配置里需要知道两个 topic：
  - `official.topic`：官方 App 的 bundle id（hub 的 APNs topic；由官方运营方告知，或 relay 启动时
    从 hub `/healthz` 的 `apns.topic` 读取）；
  - `self.topic`：部署方自签 App 的 bundle id（部署方自己 App 的 App ID）。
- 路由规则：
  - `bundleId === official.topic` 且官方通道已配置 → 转发 hub；
  - `bundleId === self.topic` 且 self 通道已配置 → relay 用自己的 APNs key 直发；
  - 两者都不匹配 / 对应通道未配置 → **不推送**，在 host 状态与 relay 日志里给出明确原因
    （例如「该设备的 App bundle id 不属于官方或部署方已配置的推送主题」）。
- 只配置一个 provider 的 relay：匹配该 provider 的设备可推送，另一类设备明确“无可用通道”，
  不能静默失败。

## 3. Official 路径的三种放法（核心取舍）

| | O1 relay 转发（当前） | O2 relay 换 token + 主机直报（B-lite） | O3 官方直接给主机发凭据 |
|---|---|---|---|
| 意图路径 | host→relay→hub | host→relay（注册时换 token）→之后 host→hub | host→hub（官方预先发放主机 token/邀请） |
| 凭据 | hub 只认 relay 凭据 | relay 用官方凭据向 hub 换 **host 级 JWT**，随注册下发；hub 验 JWT | 官方运营方给每台主机发 token（管理后台/邀请） |
| 滥用/配额边界 | 按 relay（简单） | 按 relay + host JWT（hub 无状态验签，可限额） | 按主机（需官方主机注册/配额/撤销体系） |
| device token 处理 | relay 内存持有，每次随请求给 hub（hub 不存） | host 持有并每次随请求直发 hub（hub 不存） | 同 O2 |
| 隐私/信任 | relay 可见推送意图（A 模式下 relay 本就可见明文，增量有限） | relay 不参与推送 | 同 O2 |
| 可用性 | relay 挂 → 推送断（隧道也断） | relay 挂后 official 推送仍可能发出（但点开没页面，意义有限） | 同 O2 |
| 运维 | 主机零配置；relay 配官方凭据 | 主机保存 host JWT（0600，需轮换）；relay 需 hub 的 enroll API | 官方要新增主机账号/邀请/配额后台；主机要填/扫码领 token |
| 实现成本 | 已完成 | 中：hub 新增 enroll+JWT 校验、relay 注册时 enroll、host 存 token/切传输、App 上报 channel | 高：官方主机注册/邀请/配额/撤销 + 主机配置 |
| 主要风险 | 多一跳；official 依赖 relay 配置 | host JWT 泄露=可向官方刷通用推送（可 TTL/限额/撤销缓解）；两套传输路径的失败语义 | 官方运营成本；主机配置复杂；多一个账号体系 |

### 3.1 O2（B-lite）最小设计（若以后要“官方不经过 relay”）

1. hub 新增 `POST /v1/hosts/enroll`（Bearer **relay token**，body `{hostId}`）→ 返回
   `{hostToken:<JWT>, expiresAt, endpoint}`；JWT 由 hub 签名，claims 含 `relayId/hostId/iat/exp`，
   TTL 建议 7–30 天；hub 每次请求仍校验 relay 是否已撤销（读现有 store）。
2. relay 注册/刷新 host 时调用 enroll，把 `pushEndpoint` + `hostPushToken` 放进响应；
   host 落盘 `group.json`（0600），推送开关/通道状态里显示“官方直连”。
3. host 对 official channel 的设备 token **直接 POST** hub；self channel 仍走 relay。
   hub `/v1/push` 同时接受 `Bearer <relayToken>`（旧路径）与 `Bearer <hostJWT>`（新路径）。
4. 撤销：relay 被撤销 → hub 拒绝其 JWT；host 撤销 → 主机不再发（可选 hub 维护 host 黑名单）。
5. 失败语义：official 直连失败时**不要回退 relay 转发**（会重复推送）；只记状态/日志。

### 3.2 「任意 relay + 官方 App 都能走官方推送」的前提（准入模型）

- **O1（relay 转发）**：官方 hub 只认 **relay 凭据**。所以「谁的中转服务器都行」不自动成立 ——
  每个部署方 relay 都必须先由官方授权（发放 `relayId + relayToken`）并配置 official 通道，
  它才有资格把意图转发给 hub。优点：滥用面集中在 relay 级、容易限速/撤销。
- **O2（relay 换 token，主机直报）**：准入仍在 relay 级（relay 必须持官方凭据才能为本主机
  enroll host token），区别只是**每次推送不再经过 relay**。若 relay 是第三方且未获授权，
  主机仍拿不到官方 host token。
- **O3（官方给主机发凭据）**：主机凭据由官方发放/邀请，不依赖 relay 操作方 —— 这才真正
  做到「不管 relay 是谁，官方 App 都能走官方推送」；代价是官方要维护**主机级**凭据发放、
  配额、撤销。
- **无凭据、彻底放开**：官方 hub 对公网开放、不做 relay/host 鉴权 → 会被滥用（任意人拿
  device token 刷推送/探测），不建议。
- **自签 App**：与准入模型无关 —— 它天然只能走 self（部署方自己的 Apple 团队 key + 自己的
  bundle id/topic），官方 hub 用官方 key 发不动（`DeviceTokenNotForTopic` / `InvalidProviderToken`）。
  任何架构都绕不过这条 APNs 物理约束。

### 3.3 R2（新增候选）：官方推送与 relay 解耦 —— App ↔ 官方 hub 设备登记

针对「官方 App + 任意 relay + 官方推送」的多端搭配问题：把推送授权从 relay 移到
「官方 App ↔ 官方 hub」，主机只按 App 下发的凭证直连 hub。

流程：

1. **官方 App 构建时内置**官方 hub 地址 + `channel=official` + 官方 bundle id；
2. 配对完成后 App 已知 `hostId` / `deviceId`；
3. App 用群体版**设备密钥**（Secure Enclave/Keystore P-256）对 hub 的 nonce 签名 → hub 签发
   **per-device push credential**（JWT：APNs token hash + hostId + exp，7 天级）；
4. App 调主机 `POST /__dsh_remote/push-token`，body 增加
   `{channel:'official', bundleId, hubEndpoint, credential}`；
5. 主机校验会话 token + 设备在册（不变），并校验：
   - `hubEndpoint` 必须 https、且在允许列表内（官方域名常量或 relay 下发的官方地址），
     防止被 App 带去任意地址；
   - credential 的 claims 与 `hubEndpoint`（aud）、token hash、hostId 一致（JWT 验签）；
6. 主机推送时按设备 channel 分派：official → 直连 hub（带 credential + token）；
   self → 走自己的 relay/self provider；
7. App 在进入主机/回前台时续期 credential；解配/撤销后自然失效。

要点：

- **不是“扫码时主机就知道 App 是官方的”**：主机只能从 App 上报的 `channel`/`bundleId`
  得到路由提示，最终裁判是 APNs（topic/key）与 hub 的 credential 校验。
- 内置 hub 地址是打包时嵌进 App 的；主机“知道”它的时机推荐是 **push-token 登记时**
  （此时 hostId 与 APNs token 都已就绪），配对请求里也可以带 `pushChannel` 仅作提示，不必依赖。
- hubEndpoint 不能无条件信任 App：https + 允许列表 + credential audience 绑定，
  避免主机被重定向把 token/credential 发给第三方。
- 失败语义：hub 不可达/credential 过期 → 该设备官方推送暂不可用，主机 `status` 显示原因；
  默认**不静默回退** relay 转发（避免重复推送），回退仅作为显式配置选项。
- 自签名 App（本次排除）：同一协议对部署方自己的 hub 实现即可（各用各的 key/地址）。

### 3.4 如何判定「官方 App」还是「自签名 App」

App 运行时能**可靠**读到的只有：

- bundle id（`expo-application` 的 `applicationId`）；
- APNs environment（`getIosPushNotificationServiceEnvironmentAsync()`）；
- 自身 entitlements（可用 `SecTask` 读 `application-identifier` / `team-identifier`，但**重签包会改掉**，不能作为“官方”证明）；
- iOS **没有** Android 那种读签名证书 SHA-256 的接口（App Store 包中没有 `embedded.mobileprovision`）。

所以判定分三层：

| 层 | 做法 | 用途/强度 |
|---|---|---|
| 1. 构建时标记 | 官方构建注入 `channel='official'`，部署方自签构建注入 `channel='self'`；登记 token 时同时上报 `bundleId` | **仅路由提示**。可被改，但改了 channel 并不能让推送成功：APNs 按 token 的真实 topic/key 校验 |
| 2. bundle id 白名单 | relay/hub 配置 `official.topic`（官方 bundle id）与 `self.topic`（部署方 bundle id），用上报的 bundleId 比对；**APNs 是最终裁判**（topic/key 不匹配 → `DeviceTokenNotForTopic` / `InvalidProviderToken`） | 路由正确性，防误发；不是安全边界 |
| 3. 强证明（可选，后续） | iOS **App Attest / DeviceCheck**：官方 hub 在设备登记时向 Apple 验证“这是官方二进制”；Android 可读签名证书 SHA-256 与官方证书比对 | 若要求“官方 hub 只接受官方 App 的登记”，才需要；需要 Apple 侧配置 |

**安全结论（R2 场景）**：对“别人拿自己的 token 蹭官方推送/滥用官方 hub”这类威胁，
R2 的**设备密钥 PoP + credential 绑定 token hash/hostId** 已经足够：

- App 用 Secure Enclave/Keystore 里的群体版设备私钥签 hub 的 nonce，hub 才签发 credential；
- credential 只对该设备的 APNs token 有效，仅能推该设备；
- 改包/自签 App 即使自称 official，它的 token topic 与官方 key 不匹配 → 发不出去（只会产生
  配置错误日志，不会真的送达）；
- 若还要“官方 hub 拒绝非官方二进制登记”，再加第 3 层 App Attest 即可。

### 3.5 官方 hub（owner-only）相比开源自部署的额外能力

**开源/自部署侧**（任何人可跑）：relay（隧道/配对/设备表）+ host-plugin（意图/token 转发）+
App（官方或自签）。**不需要官方 hub**。

**官方 hub 是 owner 独有的组件**（唯一需要官方 APNs 私钥 + 集中配额的地方）。当前
`packages/push-hub` 0.1.0 已有：relay-token 鉴权、固定通用文案、按 relay 限速、`pruned` 透传、
CLI 管理 relay 凭据。R2 需要在此基础上**额外承担**：

1. **设备登记 `/v1/enroll`（R2 新增）**
   - challenge/nonce + 用**设备公钥**验签（群体版 P-256，Secure Enclave/Keystore）；
   - 绑定 `APNs token hash + hostId + environment + audience(hub endpoint)`；
   - 签发 credential（JWT，默认 30 天（0.3.1 起，原 7 天），可轮换）；
   - enroll 自身限速（按 device、按 IP）；可选 App Attest/DeviceCheck 只接受官方二进制。
2. **推送接口扩展 `/v1/push`**
   - 只接受 **device credential**（主机直连，R2 唯一路径）；
   - 内容仍只允许固定通用文案（schema 拒绝 title/body/sessionId）。
3. **凭证与密钥管理**
   - 签发 key（0600，只在 `/data`；轮换流程）；credential TTL/续期；
   - audience/endpoint 绑定（防止被带去其他地址）；撤销（短 TTL + 可选黑名单/CLI）。
4. **配额与限速（核心差异）**
   - 建议层级 + 全局：**device**（如 10 次/分钟、200/天）、**host**（如 30 次/分钟）；超限 `429 + Retry-After`；
   - enroll 限速（如 5 次/小时/device、20 次/小时/IP）；
   - 每请求 token 上限（20）、body 上限（16KB）沿用；
   - 计数器默认内存即可（重启清零可接受）；需要多实例时换 Redis。
5. **防滥用/安全**
   - 只暴露 HTTPS（nginx 终止或内置 TLS）；body/字段严格校验；
   - 日志不记 token/credential/私钥原文；失败分类（410/Unregistered 才 prune）；
   - 可选：App Attest（iOS）/签名证书指纹（Android）只放行官方二进制。
6. **可观测与运维**
   - `/healthz`（现有）+ 计数/失败率/配额命中指标（可加 `/metrics` 或日志汇总）；
   - key 轮换、数据备份（私钥/撤销列表/配额状态按需）、升级/回滚；
   - 与 relay 部署解耦：hub 可以独立容器/独立 VPS，只要求主机或 relay 能出网到它。

**职责划分**

| | 开源自部署（部署方/任何人） | 官方（owner） |
|---|---|---|
| relay / host-plugin / App | ✅ 自己部署/构建 | — |
| 官方 App 签名与分发（TestFlight/商店） | — | ✅ 只有 owner |
| APNs 官方 key（团队/Key ID/Topic） | — | ✅ 只在官方 hub |
| 推送凭证签发/设备登记（R2） | — | ✅ |
| 配额/限速/滥用控制 | 只能约束自己的 relay | ✅ 官方 hub 统一约束 |
| 可选自建 hub（self push 用自己 key） | 可以，等价于自己的私有 hub | 与官方 hub 无关 |

> 结论：官方 hub 的“额外部分” = **官方 Apple 凭据 + 设备登记/凭证 + 集中配额与滥用控制 +
> 官方 App 的分发资格**。开源自部署用户没有这些也不需要（他们用自己团队 key 走 self）。

## 4. 对「每主机可选」的落地解释（建议 UI 文案）

因为 provider 由设备签名决定，主机端设置建议做成：

- **推送提醒**（总开关，已有）；
- **推送通道**：
  - `按设备自动（推荐）`：官方 App 设备走官方证书，自签 App 设备走部署方证书；
  - `仅官方推送` / `仅自部署推送`：只对相应 channel 的设备发；另一种 App 的设备会显示
    “此设备不属于所选通道，不会收到推送”；
- 主机设置页展示 relay 下发的可用通道和每通道状态（无需填任何地址）。

这样做到了“主机端可选、地址不用填”，又不会出现“选了官方却给自签 App 设备发”的必然失败。

## 5. 实现工作量估算（相对当前已实现部分）

**v1（O1 + 设备级 channel 路由 + 双 provider）**
- protocol：`push.register` 增 `channel`；注册响应 push 摘要；错误码补 `invalid_channel`。
- App：登记 token 时带 `channel`（构建配置常量，官方/自签两个构建分别注入）；仅此一处。
- host-plugin：转发 channel、`status.push` 增加 providers/channel 统计（不含 token）；设置页展示/
  偏好开关。
- relay：`group.push.self` / `group.push.official` 可并存；token 表加 channel；`push.send` 分流；
  `/healthz` 分通统计；旧 `mode` 兼容。
- 测试/文档/版本号：中等。
- 预计改动量：小而集中（无新凭据/新协议族）。

**O2（B-lite）追加**
- hub：enroll 接口 + host JWT 签发/校验 + host 级限额；测试。
- relay：注册时 enroll + 响应下发 + （可选）不再转发 official；公网端点/失败处理。
- host：保存 host JWT（0600）+ 官方直连传输 + 状态/失败语义；测试。
- 安全评审：host JWT 泄露/撤销/TTL、hub 不可达时的行为。
- 预计改动量：中等偏大，建议作为独立切片（v2）。

## 6. 当时的建议与待拍板（历史记录；最终决策见 §8）

> 以下为 2026-11-01 决策前的初稿，保留作过程记录；**最终方案已按 §8 定案**（R2 + 删除 O1 official 转发）。

**当时的建议：**
1. **v1 先做 §2（O1 + 设备级 channel 路由 + 双 provider）**：它同时满足“主机端可见/可设、
   地址 relay 下发零填写、混用 App 不失败”，而且没有新增凭据体系；official 仍是 relay 转发
   一次（多一跳的代价是当前架构里最小的）。
2. **O2 作为可选 v2**：只有当你确认“官方推送的意图必须由主机直接上报给官方、部署方 relay
   不应接触推送”是硬需求时再做；O3（官方给每台主机发凭据）不建议现在做，等于新建一套主机
   账号/配额后台。
3. 无论选哪个，**App 上报自己的 channel** 都是前置（混用场景的硬约束）。

**当时待拍板（已在 §8 定案）：**
- official 路径：先按 O1（relay 转发）还是直接做 O2（host 直报 + relay 换 token）？
- 「每主机可选」是否按 §4 的“偏好/白名单”语义实现（设备通道优先）？
- 自部署是否需要支持“非 relay 的第三方推送网关（webhook/Bark/Server酱）”？如果需要，
  这是独立功能，建议单独切片。

## 7. 验收要点（v1，历史；对应最终 R2 的验收见 `group-push-r2-contract.zh.md` §8.3）

- 官方 App 设备 + 自签 App 设备混用：两种 device token 分别收到通知（topic 不匹配错误不出现）；
- 主机设置页显示 relay 下发的可用通道，**无需填写地址**；
- ~~只配一个 provider 的 relay：另一通道设备不推送且有明确状态~~（R2 后官方通道由 hub 直连，与 relay provider 配置无关）；
- `push.result` 按通道给出 delivered/failed；token 依然不落盘、不进日志；
- 关闭「推送提醒」/撤销设备/relay 重启后行为与现有契约一致。


## 8. 最终决策（2026-11-02 补记）

1. **采用 R2**：官方 App ↔ 官方 hub 设备登记（P-256 PoP → device credential），主机直连 hub 推送；
   官方推送与部署方 relay 完全解耦，官方 App 保证可用官方 hub。
2. **删除 legacy O1 official 转发**：relay 不再具备「转发官方 hub」能力（`mode` 只保留 `self`），
   hub 不再识别 relay（无 relay 凭据库 / `relay create` CLI / 每 relay 限流）。
   理由：该链路只服务「旧官方 App」，而官方 App 从未发布过；自签 App 的 token 官方 key/topic
   也发不动（`DeviceTokenNotForTopic`），兼容没有意义。
3. **self 推送保留**：部署方自签 App 仍走 relay 自己的 APNs key（与 hub 无关）。
4. 版本：relay **0.4.0**（self-only）、push-hub **0.3.0**（R2-only）。
