# 群体服务版推送（服务端集中）——实现契约 v1（O1，legacy）

> ⚠️ **2026-11-01 更新**：官方推送已改为 **R2 方案**（官方 App ↔ 官方 hub 设备登记，主机直连 hub，
> 不经过 relay）；**当前实现以 [`group-push-r2-contract.zh.md`](group-push-r2-contract.zh.md) 为准**。
>
> ⚠️ **2026-11-02 更新**：O1 的 `official` 模式（relay 转发官方 hub）**已整体删除**
> （relay 0.4.0 只支持 self；hub 0.3.0 不再识别 relay）。本文中所有 `official` 相关章节仅作
> 历史记录；**仍有效的部分只有 `self` 推送（部署方自己的 APNs key，host → relay → Apple）**。
> 方案取舍见 [`group-push-routing-options.zh.md`](group-push-routing-options.zh.md)。
>
> 状态：**历史契约**（2026-11-01）· 分支 `feat/group-service`
> 关联：[`group-service-design.zh.md`](group-service-design.zh.md) §9、`STATUS.md`、`todo/TODO.md` T2.1（main 分支）
> 脱敏：示例里的域名 / hostId / Bundle ID / Team ID / Key ID 一律用占位符。

## 0. 一句话

推送由**服务端（relay）统一发送**，主机不再持有任何 Apple 凭据、App 也不直接连 Apple：

- **模式 1 `self`（自部署推送）**：部署方在自己的 relay 上配置 APNs Auth Key（`.p8`/Key ID/Team ID/Topic），
  relay 直连 Apple；App 由部署方自己的 Apple 团队签名（bundle id = `self.topic`）。适合「朋友各自装我签的 App」。
- **模式 2 `official`（官方推送）**：relay 不持有 Apple 凭据，把推送请求转给**官方推送 hub**
  （由项目所有者运营，持有官方 App 的 Apple 团队 key）；hub 只发**通用文案**，不接收会话内容。
  App 用官方签名包（TestFlight/商店），朋友的主机不需要 Apple 开发者账号。

两条链路的 App / 主机代码完全相同，差异只在 relay 配置（`group.push.mode`）。

## 1. 数据流

```
主机插件（DSH 主机）                        relay（部署方）                     Apple
  session/event ──判定──► push.send ──WSS──►  push 服务
    (turn/end / ask_user_question)             │  self:  dsh-remote-apns ──HTTP/2──► api[.sandbox].push.apple.com
  App ──POST /__dsh_remote/push-token──► 主机     │  official: hub client ──HTTPS──► 官方推送 hub ──► APNs
    (会话 token 鉴权)  ──push.register──WSS──►  token 表（内存）
```

要点：

1. **主机零配置**：主机只上报「推送意图 + 设备 token」，不接触 Apple 凭据。
2. **设备 token 由主机转发**：App 用已有的群体版会话 token（cookie / Bearer）调主机内部接口，
   主机校验 deviceId 在册后经**已鉴权的控制连接**上报 relay；relay 只给该 hostId 的 token 发消息。
3. **官方 hub 无状态**：relay 每次推送把自己的 token 列表随请求发给 hub，hub 不落库、不持久化
   token；hub 只认 relay 凭据 + 通用内容。relay 重启丢 token 表，App 重新进入主机时重登记。
4. **内容策略**：默认**通用文案**；self 模式可由部署方显式开启 `summary`（会话标题 + 助手回复摘要）。
   official 模式**永远只发通用文案**，relay 在转发前丢弃 title/body，hub 侧 schema 也不接受这两个字段。

## 2. relay 配置契约（`group.push`）

`relay.json` 新增（不是顶层 `push`，顶层是已删除的 classic 字段）：

```json
{
  "group": {
    "push": {
      "enabled": true,
      "mode": "self",
      "content": "generic",
      "cooldownSeconds": 30,
      "self": {
        "keyFile": "/data/apns/AuthKey_<KEY_ID>.p8",
        "keyId": "<KEY_ID>",
        "teamId": "<TEAM_ID>",
        "topic": "<BUNDLE_ID>",
        "environment": "auto"
      },
      "official": {
        "endpoint": "https://push.example.com",
        "relayId": "r_abcd1234",
        "relayTokenFile": "/data/hub-token",
        "insecure": false
      }
    }
  }
}
```

字段语义：

| 字段 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | bool | `false` | 总开关；关闭时 `push.*` 控制消息一律返回 `push_disabled` |
| `mode` | `self` / `official` | `self` | 发送通道 |
| `content` | `generic` / `summary` | `generic` | 仅 self 模式可用 `summary`；official + summary = 配置错误 |
| `cooldownSeconds` | 0..3600 | `30` | relay 对**同一 host** 的推送意图最小间隔（防滥用）；host 侧还有会话级 30s 冷却 |
| `self.keyFile` | 路径 | — | APNs Auth Key（PKCS#8 EC P-256），0600、只在宿主/容器 `/data` 内；不要提交仓库 |
| `self.keyId` / `self.teamId` / `self.topic` | 字符串 | — | APNs Key ID / Apple Team ID / App bundle id |
| `self.environment` | `auto` / `development` / `production` | `auto` | auto = 按 App 上报的 `environment` 选择 sandbox/production |
| `official.endpoint` | https URL | — | 官方 hub 基地址（不带尾斜杠） |
| `official.relayId` | `r_[a-z0-9]{6,30}` | — | 官方 hub 分配给该 relay 的 ID |
| `official.relayTokenFile` | 路径 | — | hub 分配的 relay token（0600 文件）；也可用 `official.relayToken` 直接写（不推荐） |
| `official.insecure` | bool | `false` | 仅 POC：允许 `http://` hub（生产必须 https，配置校验会拒绝） |

环境变量（entrypoint / compose 使用，和现有 `RELAY_GROUP_*` 同一套）：

```
RELAY_GROUP_PUSH_ENABLED=true|false
RELAY_GROUP_PUSH_MODE=self|official
RELAY_GROUP_PUSH_CONTENT=generic|summary
RELAY_GROUP_PUSH_COOLDOWN_SECONDS=30
RELAY_GROUP_PUSH_APNS_KEY_FILE=/data/apns/AuthKey_<KEY_ID>.p8
RELAY_GROUP_PUSH_APNS_KEY_ID=<KEY_ID>
RELAY_GROUP_PUSH_APNS_TEAM_ID=<TEAM_ID>
RELAY_GROUP_PUSH_APNS_TOPIC=<BUNDLE_ID>
RELAY_GROUP_PUSH_APNS_ENVIRONMENT=auto|development|production
RELAY_GROUP_PUSH_HUB_ENDPOINT=https://push.example.com
RELAY_GROUP_PUSH_HUB_RELAY_ID=r_abcd1234
RELAY_GROUP_PUSH_HUB_TOKEN_FILE=/data/hub-token
RELAY_GROUP_PUSH_HUB_INSECURE=false
```

配置校验（`normalizeConfig` 阶段就报错，避免带病启动）：

- `enabled=true` 时：`mode=self` 必须给 keyFile/keyId/teamId/topic；`mode=official` 必须给 endpoint/relayId/tokenFile 且 URL 是 https（除非 `insecure`）。
- `mode=official` 且 `content=summary` → 错误（官方通道禁内容）。
- `cooldownSeconds` 必须是 0..3600 整数。
- 私钥/relay token 只在**使用前读取一次**，读取失败给可操作错误（不打印内容）；不放日志、不入 `/healthz`。

## 3. App ↔ 主机：token 登记

relay 边缘照旧终止手机 TLS，主机 loopback 代理逐请求鉴权。新增内部路由（`TUNNEL_BASE` 下）：

```
POST /__dsh_remote/push-token
鉴权：__Host-dsh_session cookie 或 Authorization: Bearer <token>（等价，同现有内部接口）
Body: {"provider":"apns","token":"<64 位小写 hex>","environment":"development"|"production"}
```

成功：`200 {"ok":true,"data":{"registered":true,"mode":"self"|"official"}}`
失败（JSON `{ok:false,error:{code,message}}`）：

| code | HTTP | 场景 |
|---|---|---|
| `unauthorized` | 401 | 会话 token 缺失/过期/设备已撤销 |
| `invalid-push-token` | 400 | token 不是 64 位 hex / provider 不是 apns / environment 非法 |
| `push-disabled` | 403 | relay 未开启推送（`group.push.enabled=false`） |
| `push-not-connected` | 503 | 主机到 relay 的控制连接暂不可用（App 可稍后重试） |
| `push-timeout` | 503 | 已转发 `push.register` 但 5s 内未收到 relay 回执（App 可稍后重试） |
| `push-rejected` | 502 | relay 拒绝了登记（host 不在册/限流/内部错误） |

约束：同一 deviceId 只保留最新 token；同一 host 最多 `GROUP_PUSH_MAX_TOKENS_PER_HOST=16` 个设备 token。

## 4. 控制面消息（JSON text frame）

`RELAY_MSG` 新增 4 种（老 relay 会 `default` 忽略，老 host 不发；兼容）：

### 4.1 `push.register`（host → relay）

```json
{"t":"push.register","deviceId":"d_0123456789abcdef","provider":"apns",
 "token":"<64 hex>","environment":"development"}
```

relay 校验（hostId 来自已鉴权控制连接，**绝不信消息里的 hostId**）后写入内存表并回复：

```json
{"t":"push.registered","ok":true,"deviceId":"d_0123456789abcdef","mode":"self","enabled":true}
{"t":"push.registered","ok":false,"deviceId":"...","code":"push_disabled","message":"..."}
```

错误码：`push_disabled` / `invalid_push_token` / `invalid_provider` / `invalid_environment` / `too_many_tokens` / `rate_limited` / `internal`。

### 4.2 `push.send`（host → relay）

```json
{"t":"push.send","id":"<uuid>","kind":"turn-end","title":"会话标题（≤60 字）",
 "body":"摘要（≤160 字）","sessionId":"<session id>"}
```

`kind` 只有 `turn-end`（一轮结束/出错/被阻塞）与 `waiting-answer`（`ask_user_question` 等待作答）。
`title`/`body` 只在 self+summary 模式使用；relay 在 generic 模式忽略它们（用固定文案）。

relay 回复（同 id）：

```json
{"t":"push.result","id":"<uuid>","ok":true,"delivered":1,"failed":0,
 "pruned":["d_..."],"mode":"self","skipped":"no-tokens"}
{"t":"push.result","id":"<uuid>","ok":false,"code":"rate_limited","message":"..."}
```

- `pruned`：APNs 410/Unregistered 的设备（relay 已从 token 表删除；host 只需展示/记录）。
- `skipped`：`no-tokens`（没有设备登记）/ `push_disabled`（不推送，但 ok:true 便于 host 不反复重试）/
  `cooldown`（relay 侧 cooldownSeconds 窗口内的重复意图，同样 ok:true 不重试）。
- `code`（ok:false 时）：`rate_limited` / `invalid_request` / `push_unavailable`（APNs 未配置或私钥
  读取失败，含 self 模式配置错误）/ `hub_unavailable`（官方 hub 不可达）/ `hub_unauthorized`
  （relay 凭据被撤销或错误）/ `hub_rejected`（hub 4xx/5xx）/ `internal`。
- host 对 `push.send` 有 15s 超时；超时只记日志，不重发（避免重复通知）。
- relay `/healthz` 始终附带 `push:{enabled,mode,tokens}`（不含 token/密钥），便于部署方排障。

## 5. 官方推送 hub 契约（`official` 模式）

独立服务（`packages/push-hub`，Node 零第三方依赖）。部署方 relay 用**部署凭据**调用：

```
POST /v1/push
Authorization: Bearer <relayToken>
Content-Type: application/json
Body:
{
  "kind": "turn-end" | "waiting-answer",
  "host": "h_ab12cd34.relay.example.com",        // 可选；仅用于 App 点击跳转，不参与鉴权
  "tokens": [
    {"token":"<64 hex>","environment":"development"}
  ]
}
```

响应：

```json
{"ok":true,"accepted":1,"failed":0,"pruned":["<token>"]}
{"ok":false,"error":{"code":"unauthorized|invalid_request|rate_limited|too_many_tokens|internal","message":"..."}}
```

- `tokens` 最多 20 个/请求；`kind` 只接受两个枚举；**body 不接受 title/body/sessionId**（schema 直接拒绝）。
- 鉴权：relay token 只在 hub 存 SHA-256；hub 按 relayId 识别调用方并限速（默认 60 次/分钟/relay）。
- 通用文案由 hub 固定：`turn-end` → DSH「任务已完成」；`waiting-answer` → DSH「正在等待你的回答」。
- APNs payload（hub 与 self 模式一致）：
  ```json
  {"aps":{"alert":{"title":"DSH","body":"任务已完成"},"sound":"default"},
   "body":{"kind":"turn-end","host":"h_ab12cd34.relay.example.com"}}
  ```
  self 模式额外允许 `body.sessionId`（点通知直接跳到会话）；official 模式**不带 sessionId**。
- `pruned` 中的 token 是 APNs 410/Unregistered；relay 收到后删除本地 token（按 token 匹配）。
- `GET /healthz` → `{"ok":true,"apns":{"configured":true,"topic":"..."},"relays":<n>}`（不含 token/密钥）。

hub 配置（`hub.json`，0600；或用 env 覆盖）：

```json
{
  "listenHost": "0.0.0.0",
  "port": 9445,
  "tls": { "certFile": "/data/certs/fullchain.pem", "keyFile": "/data/certs/privkey.pem" },
  "apns": { "keyFile": "/data/apns/AuthKey_<KEY_ID>.p8", "keyId": "<KEY_ID>",
            "teamId": "<TEAM_ID>", "topic": "<OFFICIAL_BUNDLE_ID>" },
  "store": { "file": "/data/hub.json" },
  "limits": { "maxTokensPerRequest": 20, "pushPerMinutePerRelay": 60 }
}
```

hub.json 结构：`{"version":1,"relays":{"r_xxx":{"name":"...","tokenHash":"<sha256 base64url>","createdAt":0,"revokedAt":0}}}`。
CLI：

```bash
node packages/push-hub/bin/push-hub.js relay create --name "relay.example.com"   # 输出一次 relayId + relayToken
node packages/push-hub/bin/push-hub.js relay list
node packages/push-hub/bin/push-hub.js relay revoke r_abcd1234
node packages/push-hub/bin/push-hub.js serve --config /data/config/hub.json
```

`tls` 可省略（由 nginx 终止 TLS，hub 只听 127.0.0.1）。

## 6. 主机插件契约

配置新增（`~/.dsh/remote-access/config.json`，DSH 设置页可改）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `pushEnabled` | `true` | 是否允许把推送意图发给 relay；关闭后不再发 `push.send` |

- 触发（与 main 分支语义一致，代码从 main 移植）：
  - `session/event` 的 `turn/end`：reason ∈ completed/error/max-tokens/blocked（**undefined 按 completed 处理**，与 main 语义一致；aborted 等其它 reason 跳过）；子代理会话跳过；
    同一 session 30s 冷却；
  - `tool/call` 且 `name=ask_user_question`：立即推送，正文固定「正在等待你的回答」，按 callId 去重，
    不受 30s 冷却影响；
  - 标题 = 会话标题（无则首条用户消息），正文 = 本轮最后一条助手回复截断（≤160 字）。
- 状态（本机 `/api/remote-access/status` 与远程 `/__dsh_remote/status`）新增：

```json
"push": {
  "enabled": true,                 // 主机侧开关
  "provider": "apns",
  "serverEnabled": true,           // relay 是否开启推送（来自 push.registered）
  "mode": "self" | "official",     // relay 通道（未连接时为 ""）
  "tokens": 1,                     // 本机已上报的设备 token 数
  "lastError": ""                  // 可读错误（不含 token）
}
```

- 设置页「推送提醒」开关写 `pushEnabled`（保存不重建运行时；与「组件」开关同一做法）。
- App 通过 `/__dsh_remote/status` 读取上述 `push` 对象展示状态。

## 7. App 契约（v1 = iOS APNs；Android FCM 后续）

- 依赖 `expo-notifications`（~58.1.5），`app.json` 加 config plugin；iOS entitlement
  `aps-environment` 由 plugin 生成（development；发布包由签名 profile 覆盖为 production）。
- 注册时机：进入某台主机并拿到会话 token 后；App 回到前台时对当前主机重试；
  设置页「重新注册」；权限被拒/未联网时只提示，不影响主流程。
- 请求体中的 `token` 是 **APNs device token**（64 hex），`environment` 从
  `Application.getIosPushNotificationServiceEnvironmentAsync()` 读取（读不到按 production）。
- 通知展示：系统通知（前台也显示；v1 不做应用内卡片）。点击：
  - `body.host` 匹配已存连接 → 打开该主机（不存在的连接忽略并提示）；
  - `body.sessionId` 存在（self 模式）→ 进入主机后调用
    `window.__DSH_REMOTE_OPEN_SESSION__(sessionId)`（host Client 半已提供该桥）。
- 设置页新增「推送」卡：开关（本地偏好，默认开）、状态（未注册/已注册/权限被拒/服务器未开启/
  `mode`=自部署或官方）、「重新注册」按钮、错误原因。
- App 版本 0.1.8（build 15 / versionCode 15）；Android 仅静态检查（本机无 SDK），FCM 留待后续切片。

## 8. 安全与隐私（硬约束）

1. **设备身份只来自**群体版会话 token（relay 签名）+ 主机设备表；token 登记接口同样如此，
   绝不看来源 IP / `X-Forwarded-*` / 自定义头。
2. **relay 只信已鉴权控制连接**的 hostId；`push.*` 消息体里不允许出现 hostId。
3. **官方 hub 不接收会话内容**：relay 转发前 strip `title/body/sessionId`；hub schema 拒绝这两个字段；
   通用文案在 hub 侧固定。
4. **APNs 私钥 / hub relay token**：只放部署方服务器的 `data/`（0600 或容器只读挂载），
   不落仓库、不打印、不进日志、不进 `/healthz`、不进推送 payload。
5. **token 不落盘**（relay/hub 内存），日志只记 deviceId / 计数 / 结果，不记完整 token。
6. 撤销设备（`device.revoke`/`device.sync`）时 relay 立即删除该设备 token；主机侧撤销后后续请求 401。
7. 限速：relay 每 host 推送频率 + 每 host token 数上限；hub 每 relay 每分钟配额 + 每请求 token 上限。

## 9. 失败与降级

| 场景 | 行为 |
|---|---|
| relay 未配推送 / 关闭 | `push.registered` ok:false `push_disabled`；host 状态提示；App 设置显示「服务器未开启推送」 |
| 控制连接断开 | host 不发意图（日志）；App 登记 503，进入主机/回前台时重试 |
| APNs 410/Unregistered | relay 删除该 token，`push.result.pruned` 回报；App 下次进入重新登记 |
| APNs 配置错误（BadDeviceToken/DeviceTokenNotForTopic/InvalidProviderToken） | 不删 token，状态/日志提示检查 topic/key/team/environment |
| 官方 hub 不可达/5xx | relay 返回 `hub_unavailable`，不重试（避免重复通知）；host 记日志 |
| relay 重启 | token 表清空；App 重新进入主机时自动重登记（不做持久化） |

## 10. 验收（本切片）

- relay：`npm test` 覆盖配置校验、push 服务（self：APNs mock；official：hub mock）、控制消息
  `push.register/push.send`、token 撤销、限速、generic/summary 内容策略、`/healthz`。
- push-hub：鉴权（有效/撤销/错误 token）、schema 拒绝 title/body、限速、APNs 结果映射、
  `pruned` 透传、CLI 创建/列出/撤销。
- host-plugin：意图触发（turn/end、ask_user_question、冷却、去重、子代理跳过、开关）、
  `/__dsh_remote/push-token` 鉴权与参数校验、connector 消息、状态、设置页开关。
- App：`tsc`、`check:native`、`check:shell` 通过；iOS Release **签名构建并装机**（0.1.8/15，
  `aps-environment=development`）；真机验收（用户确认）：
  1. self 模式：App 在前台/后台/锁屏收到通知（通用文案 + 会话摘要各一次）、点击跳会话；
  2. official 模式：经官方 hub 收到通用文案通知、点击打开对应主机；
  3. 关闭「推送提醒」后不再收到；relay 未开推送时 App 设置显示明确状态。

### 已完成的本地运行态冒烟（Lead，2026-11-01；**非真机验收**）

- relay `official` + stub hub（真实进程）：12/12 —— register/send、hub 只收到
  `{kind,host,tokens}`（无 title/body/sessionId）、cooldown、非法 kind。
- relay `self` + 真实 APNs sandbox：5/5 —— 随机 provider key 被 Apple 判 `InvalidProviderToken`，
  relay 归类为配置错误且不清理设备 token（JWT/HTTP2/sandbox 路由与错误分类真实可用）。
- 真实 host-plugin `RelayConnector` ↔ 真实 relay：10/10 —— 含 relay 重启后 connector 自动重连并
  补报 token（`/healthz` 的 push.tokens 恢复）。
- 真实 push-hub 进程 + CLI + 真实 APNs：13/13 —— `relay create/list`（store 0600 只存 sha256、
  list 不显示 token）、`/healthz`、`/v1/push` 鉴权与 schema（带 title/body → 400）、
  真实 APNs 配置错误归类（failed=1/pruned=[]）、日志不含 token。
- relay-entrypoint 配置自动生成：8/8 —— self/official 两组 env → `relay.json` 的 `group.push`
  （0600）、已有配置不覆盖、缺域名/证书时的可操作报错；compose 渲染核对 push env 与挂载。
- 真机推送仍需：部署 relay 0.4.0（仅 self，部署方 APNs key）+ 自签/官方签名包 → 用户实测。
- 部署文档：`server/README.md` 增加 self/official 两种配置、hub 部署与 relay 凭据下发步骤。

## 11. 版本

| 包 | 旧 | 新 |
|---|---|---|
| protocol | 0.2.0 | 0.3.0（新增 push 常量/消息） |
| apns（新） | — | 0.1.0 |
| push-hub（新） | — | 0.1.0 |
| relay | 0.3.0 | 0.3.1 |
| host-plugin | 0.2.4 | 0.2.5 |
| App | 0.1.7 (14) | 0.1.8 (15) |
