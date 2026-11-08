# dsh-remote-service（主机插件 · 群体服务版）

> 许可证：**AGPL-3.0-or-later**（完整文本见根目录 [`LICENSE`](../../../LICENSE)）。
>
> 版本 **0.2.8**：本插件只保留群体服务版（A 模式）主机能力（classic/单体版的 mTLS、主机证书、
> 主机侧自托管 APNs 已剥离）；**「重启主机 DSH」作为可关闭的「组件」在群体版恢复**（默认关闭）。
> 0.2.7 增加「详细推送内容」开关（默认关闭；开启后通知带会话标题/摘要，official 直连 hub / self 经 relay）
> 与 `error` 推送类型；official 推送携带 `sessionId`（点通知直达会话）；侧栏入口可见时每 2s 轮询状态，取消配对/设备变化无需再点开弹窗。
> 0.2.6（R2）把**官方 App 推送与 relay 解耦**：官方 App 用设备密钥向官方 hub 换 per-device
> credential，主机凭 credential **直连官方 hub**；部署方自签 App（self）仍走 relay。两类设备可
> 同机混用、主机自动分流；**主机不持有任何 Apple 凭据，token/credential 只存内存**。
> 0.2.5 增加服务端集中推送（R1，legacy 兼容）；0.2.4 收窄组件保存后的连接断开范围
> （只断 `/api/remote.mux`）。旧版配置字段会被忽略，升级后需要重新注册一次。
> 推送契约：[`docs/group-push-r2-contract.zh.md`](../../../docs/group-push-r2-contract.zh.md)；
> 使用与边界（设置页字段/常见误报 bug）：[`docs/group-push-usage.zh.md`](../../../docs/group-push-usage.zh.md)。

运行在 **DSH 主机** 上的远程访问插件，提供：

- 向部署方 relay 的**自助注册**（邀请码）与注册信息刷新；
- 主动外连 relay 控制面的**出站隧道**（主机不开放任何入站端口、不持有 TLS 证书）；
- 本机 **loopback 明文 HTTP/WS 代理**：逐请求校验 relay 签名 token + 设备在册后反代到
  `127.0.0.1` 的 DSH Web；
- **群体版设备配对**（二维码 v2 + 一次性密钥 + 桌面确认 + P-256 设备公钥登记）；
- **推送意图与 device token 转发**（R2 分流）：监听会话事件生成推送意图；self 设备经 relay
  （`push.register` / `push.send`），official 设备由主机用 App 上报的 credential 直连官方 hub；
  主机零 Apple 凭据、token/credential 只存内存、不落盘；
- **「重启主机 DSH」组件**（可关闭，默认关闭）：手机经隧道 `POST /__dsh_remote/restart`
  让主机调度 detached helper 重启整个 DSH 客户端（桌面端整组重启 / Node CLI 原样拉起）；
- 桌面 DSH 设置页 / 侧栏入口（注册、状态、配对、设备撤销、审计、组件/推送开关）；
- 本机管理 API（仅本机已认证浏览器可访问）。

relay 的部署（含 TLS / 注册 API / 边缘配置）见 [`../../../server/README.md`](../../../server/README.md)。

---

## 1. 安装到 DSH

插件通过 DSH profile 的本地 link / 包安装：

```bash
# 方式 A：在 DSH 桌面端插件管理里添加本地目录
#   仓库路径：dsh-remoteService/packages/host-plugin

# 方式 B：命令行（路径按实际仓库位置）
dsh plugin --profile desktop add link:/path/to/dshRemote/dsh-remoteService/packages/host-plugin
```

安装后在 DSH 中启用插件，重启 DSH 桌面端/Web 实例使 Host 半与 Client 半加载。

> Host 半是 `index.js`，Client 半是 `client.js`（侧栏入口 + 设置页）。协议见 `packages/protocol`。

---

## 2. 群体服务版（A 模式）工作原理

```text
手机 ──TLS──> relay 边缘（终止手机 TLS、校验 __Host- 短时 token）
                        │
                        └─ 出站隧道（主机主动连 relay 控制面）
                                │
                        主机 loopback 明文代理 127.0.0.1:<groupPlainPort>
                                │  校验：Host == <hostId>.<relayDomain>
                                │        token 用 relay 公钥离线验签、未过期、hostId 匹配
                                │        token 里的 deviceId 仍是本机有效设备
                                ▼
                        DshProxy ──> 127.0.0.1:<DSH 端口>（注入本机 cookie / deny list / WS）
```

- 主机**不终止 TLS**、不持有证书、没有入站端口；relay 只把明文流转发进隧道。
- 设备身份只来自「配对登记的设备公钥 + relay 签名的短时 token」；不信任来源 IP、
  `X-Forwarded-*`、`Host`、`Origin`、自定义头或查询参数。
- 主机每次重新拉起时会先调用 relay `POST /__group/refresh` 同步最新
  `mobilePort` / `controlUrl`（不消耗邀请码），再重建隧道。
- 设备配对/撤销后自动把设备表（deviceId + P-256 公钥）全量 `device.sync` 给 relay。
- **推送（R2 分流）**：主机监听会话事件生成推送意图；**self** 设备经同一控制连接
  `push.register` / `push.send` 交给 relay；**official** 设备由主机逐设备
  `POST {hubEndpoint}/v1/push`（Bearer credential，10s 超时、不重试、不依赖 relay）。
  hub 返回 `pruned` 时删除该设备记录；token/credential 不落盘、不进日志/status。

---

## 3. 配置

DSH 设置 → 远程访问。配置落盘在 `~/.dsh/remote-access/config.json`（0600）：

| 字段 | 说明 |
|---|---|
| `enabled` | 启用远程访问；关闭后隧道断开、loopback 代理停止 |
| `hostName` | 主机友好名称（手机上显示，注册时同步给服务端） |
| `requireApproval` | 新设备配对需要本机确认（默认开启） |
| `groupServiceUrl` | 部署方 relay 的**注册 API** 地址，例如 `https://relay.example.com:19443`（POC 允许 `http://`，需 `groupInsecure`）。隧道 WSS 地址由注册响应 `controlUrl` 下发 |
| `groupInviteCode` | 一次性邀请码；注册成功后自动清空 |
| `groupPlainPort` | loopback 明文代理端口（默认 `0` = 随机；只被本机隧道客户端连接） |
| `groupInsecure` | 仅 POC：允许 http/ws 与自签证书（生产必须 https/wss） |
| `restartHostEnabled` | 「组件」：允许手机重启主机 DSH（**默认关闭**；关闭时 App 隐藏 ⏻、重启接口 501） |
| `pushEnabled` | 「推送提醒」：允许把推送意图（`push.send`）发给 relay（**默认开启**；关闭后不再发提醒，保存不重建运行时） |
| `pushDetail` | 「详细推送内容」：通知标题/正文带会话标题与摘要（**默认关闭**；关闭时只发通用文案，区分 turn-end / waiting-answer / error） |
| `denyPrefixes` | 反代 deny list（`/connect`、`/oauth`、`/open-in-app`、`/api/remote-access`、`/__dsh_remote`） |
| `maxRequestBytes` | 远程代理请求体上限（默认 256 MiB） |

注册结果落盘在 `~/.dsh/remote-access/group.json`（0600）：`hostId` / `hostToken` /
`relayDomain` / `mobilePort` / relay token 公钥 / `serviceUrl` / `controlUrl` / `hostName`。
**不要**把 `group.json`、邀请码或配对二维码提交到仓库 / 截图 / 日志里。

### 设置页各项（详细说明）

设置页每项只保留一两句提示，完整说明如下。文案在 host 插件的 `client.js`（`zh` / `en`
两份），改完重启 DSH 生效；App 无需重新构建。

**连接状态（卡片）**
只显示服务地址、是否已注册、隧道连接状态、最近错误、主机名称与插件版本。`hostId`、手机访问
域名/端口、隧道控制面地址、本机明文代理端口属于实现细节，不在界面上展示；排障时从
`GET /api/remote-access/status` 的 `group` 字段读取（见 §5）。

**群体服务（A 模式）**
向部署方 relay 注册后，主机只做出站隧道；relay 边缘终止手机 TLS，明文请求经隧道进入本机
loopback 代理，逐请求验签后反代到 DSH。因此**部署方（服务提供方）可见会话明文**，请只注册
自己信任的服务。链路与验签细节见 §2。

**启用远程访问**
关闭后隧道断开、loopback 代理停止，手机无法访问这台电脑；已配对设备保留，重新开启即恢复。

**新设备配对需要本机确认**
开启后，手机扫码提交公钥后还需在本机核对 SAS 短码并点「允许配对」；关闭后扫码提交公钥即
完成配对。

**允许手机重启主机 DSH**（默认关闭）
开启后 App 顶栏显示 ⏻，可在手机上重启主机（会短暂断开，随后自动恢复）；关闭后 App 不显示
该按钮，`POST /__dsh_remote/restart` 返回 501。平台限制：Linux Electron 不支持（501），
Windows 的 kill/拉起为 best-effort。若 DSH 由 launchd（`KeepAlive`）或 systemd（`Restart=`）
托管，杀进程后 supervisor 也会拉起，可能与 helper 的重新拉起短暂竞争（多起的实例会因端口
占用退出，不影响先起的实例）；这类部署建议在 supervisor 层重启。

**推送提醒 / 详细推送内容**
主机只上报「推送意图 + 设备 token」：自部署 App（self）经 relay 发送，官方 App（official）
由主机凭 credential 直连官方推送 hub；主机不持有 Apple 凭据。关闭「推送提醒」后，本轮结束 /
等待回答都不再提醒；保存不重建隧道、立即生效。
「详细推送内容」开启后，通知标题显示会话标题、正文显示本轮摘要（任务完成 / 正在等待回答 /
出错）；关闭时只发通用文案。详细内容会经过推送服务（官方 hub 或自部署 relay），请自行判断
是否包含敏感信息。

### 从单体版（≤0.1.x）升级

classic 配置字段（`relayUrl` / `relayDomain` / `hostId` / `hostToken` / `publicPort` /
`tlsCertFile` / `tlsKeyFile` / 主机侧自托管推送的 `pushProvider` / `apns*` / `groupEnabled` 等）
已从 schema 删除，读取时会被忽略、保存时不会写回。**唯一保留的推送配置是群体版 `pushEnabled`**
（默认开启，只控制主机是否上报推送意图）。升级后：

1. 在设置页填「服务地址（注册 API 端口）+ 邀请码」→ 点「注册并连接」；
2. 删除不再使用的旧 TLS 证书 / 设备 CA 目录（如 `~/.dsh/remote-access/certs`、
   `~/.dsh/remote-access/device-ca`）与 `push-tokens.json`（可选，插件不再读取）；
3. 旧手机 App 的 mTLS 连接不再可用，需用群体版 App 重新扫码配对。
4. 「允许手机重启主机 DSH」已迁移到「设置 → 远程访问 → 组件」；默认仍为关闭，需要时再打开。
5. 0.2.2 起，若配置里缺 `groupServiceUrl` 但 `group.json` 有注册信息，启动/保存时会自动回填
   （历史配置迁移；不需要重新填服务地址或重新注册）。

---

## 4. 群体版配对

1. 桌面 DSH → 设置 → 远程访问 → 「配对新设备」；
2. 生成 **QR v2**：`dshremote://pair?v=2&host=<hostId>.<relayDomain>&port=<mobilePort>&auth=token&...`
   （端口中 relay 下发；二维码 2 分钟有效，可重新生成）；
3. 手机 App 扫码 → 生成/读取本机 P-256 设备密钥 → 经 `https://<host>:<port>/__dsh_remote/pair`
   提交**公钥**（不再签 CSR / 证书）；
4. `requireApproval` 开启时，手机显示 SAS 短码，桌面端核对后点「允许配对」；
5. 主机把设备公钥写入本机设备表并 `device.sync` 给 relay；手机随后用
   challenge → 签名 → 短时 token 换 `__Host-dsh_session` cookie 访问。

设备可在设置页「已配对设备」中撤销；已撤销设备记录可删除。撤销会同步 relay，原 token 随即失效。

---

## 5. 本机接口

Host 半注册在 DSH 本机 webServer：

| 路径 | 说明 |
|---|---|
| `/api/remote-access/*` | 本机管理 API（仅本机已认证 DSH 浏览器；远程代理 deny 该前缀） |

管理 API：

| 路由 | 说明 |
|---|---|
| `GET /api/remote-access/status` | 群体服务 / 隧道 / 配对 / 设备 / 配置状态 |
| `POST /api/remote-access/config` | 更新群体版配置字段 |
| `POST /api/remote-access/group/register` | `{serviceUrl, inviteCode, hostName?}` 注册并连接（邀请码一次性） |
| `POST /api/remote-access/group/retry` | 重试隧道连接（先刷新注册信息，不消耗邀请码） |
| `POST /api/remote-access/group/reset` | 停止隧道、删除 `group.json`、关闭远程访问 |
| `POST /api/remote-access/pairing/start` | 创建一次性配对会话（QR v2） |
| `POST /api/remote-access/pairing/cancel` | 取消当前配对会话 |
| `POST /api/remote-access/pairing/approve` | `{pairingId, ticket?, approve}` 桌面确认/拒绝 |
| `GET /api/remote-access/pairing/qr.svg` | 当前配对二维码 SVG |
| `GET /api/remote-access/devices` | 设备列表 |
| `POST /api/remote-access/devices/:id/revoke` | 撤销设备 |
| `POST /api/remote-access/devices/:id/delete` | 删除已撤销设备记录 |
| `GET /api/remote-access/audit?limit=N` | 最近审计 |

经隧道（relay 边缘 → 主机 loopback 代理）提供：

| 路径 | 说明 |
|---|---|
| `POST /__dsh_remote/pair` | 手机提交配对公钥（一次性 secret + 主机确认保护） |
| `GET /__dsh_remote/pair/status?ticket=` | 配对确认轮询 |
| `GET /__dsh_remote/status` | 已鉴权设备可读的主机状态（见下） |
| `POST /__dsh_remote/push-token` | App 登记 APNs device token（self → relay；official → 官方 hub 直连；见下） |
| `POST /__dsh_remote/restart` | 远程重启主机 DSH（「组件」开启时；成功 202） |

会话凭证两种等价形式（同一份 relay 签名 token、同一套离线验签 + 设备在册校验）：

- `Cookie: __Host-dsh_session=<token>`（浏览器 WebView / relay 边缘默认）；
- `Authorization: Bearer <token>`（App 的 JS fetch；本轮 relay 边缘以 cookie 为主，
  该形式保留为等价兜底，便于本地调试与后续 relay 支持）。

`GET /__dsh_remote/status` 响应（`ok:true`）：

```json
{
  "ok": true,
  "data": {
    "hostId": "h_ab12cd34",
    "hostName": "<HOST_NAME>",
    "domain": "h_ab12cd34.relay.example.com",
    "auth": "token",
    "relayConnected": true,
    "version": "0.2.6",
    "restart": { "enabled": false },
    "push": {
      "enabled": true,
      "self": { "devices": 1, "lastError": null },
      "official": { "devices": 2, "lastError": null, "hub": "https://push.example.com" },
      "mode": "mixed"
    },
    "devices": { "total": 1, "active": 1 }
  }
}
```

`push` 对象（R2 契约 §6.3，**不包含 token/credential**）：`enabled` = 主机「推送提醒」开关；`detail` = 「详细推送内容」；
`self.devices` / `official.devices` = 两条通道各自已登记的设备数；`self.lastError` /
`official.lastError` = 可读错误（relay 登记/发送失败、官方 hub 请求失败等）；`official.hub` =
最近登记的官方 hub 基址（无 official 设备时为 `null`）；`mode` = `self` / `official` / `mixed`
（两类设备混用，主机自动分流；无设备时为 `""`）。

`POST /__dsh_remote/push-token`（仅 POST，等价 cookie / Bearer 鉴权 + 设备在册；R2 向后兼容）：

```json
// self（部署方自签 App；旧 App 可省略 channel/hub 字段，缺省 self）
{ "provider": "apns", "token": "<64 位小写 hex>", "environment": "development" | "production" }

// official（官方 App：hubEndpoint/credential 由 App 向官方 hub 换取后上报）
{
  "provider": "apns", "token": "<64 位小写 hex>", "environment": "development" | "production",
  "channel": "official",
  "bundleId": "com.example.dshremote",             // 3-155 字符，字母数字/./-
  "hubEndpoint": "https://push.example.com",       // https 基址，≤2048，无 userinfo/query/hash
  "credential": "<三段式 JWT，≤4096 字符>"          // 主机只透传，签名/claims 由官方 hub 校验
}
```

| 状态 | 响应 | 含义 |
|---|---|---|
| 200 | `{"ok":true,"data":{"registered":true,"channel":"self\|official","mode":"..."}}` | 已登记（self 经 relay `push.registered` 确认；official 校验格式后仅存本机内存；`mode` 为旧 App 兼容字段） |
| 400 | `{"ok":false,"error":{"code":"invalid-push-token",...}}` | token 不是 64 位小写 hex / provider ≠ apns / environment 非法 |
| 400 | `{"ok":false,"error":{"code":"invalid-channel",...}}` | channel 不是 self / official |
| 400 | `{"ok":false,"error":{"code":"invalid-body",...}}` | official 缺/非法 bundleId/hubEndpoint/credential，或 self 夹带 hub 字段 |
| 401 | `{"ok":false,"error":{...}}` | 会话 token 缺失/过期/设备已撤销（与其它内部接口一致） |
| 403 | `{"ok":false,"error":{"code":"push-disabled",...}}` | relay 未开启推送（仅 self；`group.push.enabled=false`） |
| 502 | `{"ok":false,"error":{"code":"push-rejected",...}}` | relay 拒绝 self 登记（host 不在册/限流/内部错误） |
| 503 | `{"ok":false,"error":{"code":"push-not-connected",...}}` | self 登记时主机到 relay 的控制连接暂不可用，App 稍后重试（official 不需要 relay） |
| 503 | `{"ok":false,"error":{"code":"push-timeout",...}}` | self 登记 5s 内没等到 `push.registered`，App 可稍后重试 |

约束：主机**不落盘** token/credential（只在内存，status/日志/审计不出现明文；设备撤销后随
`device.sync` 清理），同一 deviceId 只保留最新记录；同一 session 的 `turn-end` 提醒有 30s 冷却，
`ask_user_question` 等待提醒按 callId 去重、不受冷却影响。发送分流见 §2：
- self：`push.send` 15s 未收到 `push.result` 只记日志、不重发；失败码（`rate_limited` /
  `hub_unavailable` …）只记日志/审计，主机不重试。
- official：逐设备直连 hub（10s 超时、不重试、失败**不回退 relay**）；`pruned` 的设备记录删除，
  App 下次进入主机/回前台时重新登记。

`POST /__dsh_remote/restart`（仅 POST，body 可为空）：

| 状态 | 响应 | 含义 |
|---|---|---|
| 202 | `{"ok":true,"data":{"restarting":true,"mode":"desktop-app\|node"}}` | 已安排重启；helper 约 1s 后动手，先让 202 返回 |
| 401 | `{"ok":false,"error":{...}}` | 未带有效 token（cookie/Bearer 都没有或验签失败/设备已撤销） |
| 405 | `{"ok":false,"error":{"code":"method-not-allowed",...}}` | 非 POST |
| 501 | `{"ok":false,"error":{"code":"host-restart-disabled",...}}` | 「组件」未开启（`restartHostEnabled !== true`） |
| 501 | `{"ok":false,"error":{"code":"host-restart-unavailable",...}}` | 当前运行环境/插件版本未接入重启调度 |
| 501/500 | `{"ok":false,"error":{"code":"host-restart-unsupported\|host-restart-failed",...}}` | 环境不支持 / 调度 helper 失败 |

审计：`host-restart` 动作，`result=accepted`（`hash` = 重启模式或 `deduped`）或
`result=failed`（`hash` = `disabled` / `not-enabled` / 失败码），`deviceId` 为发起设备。

重启范围（`lib/host-restart.js`）：

- **DSH 桌面端（Electron shell + host 子进程）**：目标是整个应用进程组（shell 为组长），
  helper 直接 SIGKILL shell → 清理残留与旧单实例锁 → `open -n <DSH.app>` 重新拉起（失败再
  兜底直接执行 `.app` 内可执行文件）；不会只杀 host 子进程（那只会弹出崩溃对话框）。
- **Node CLI（`dsh web` 等）**：SIGTERM 本进程后按 `execPath + argv` 原样拉起。
- **Windows**：Desktop 以 shell pid 为 `taskkill` 目标再 `start` 重新拉起（best-effort）。
- 10s 去重窗口（连点/App 重试只调度一次）；`DSH_REMOTE_DISABLE_HOST_RESTART=1` 时一律拒绝
  调度（测试/CI 防误重启）。重启期间连接会短暂断开，随后 App 自动重连。

其余已鉴权请求反代到本机 DSH Web。`/api/remote-access/*` 对远程设备一律拒绝；
`/connect`、`/oauth`、`/open-in-app*`、`/__dsh_remote/*` 等本机敏感路径同样在 deny list 内。

**群体版不提供**：主机 TLS 监听、设备证书/mTLS、主机侧 APNs/Expo 发送（主机零 Apple 凭据与
hub 签名密钥）。推送按 R2 分流：self 设备由 relay 发送（部署方自己的 APNs Key）；official 设备
由主机凭 App 上报的 credential 直连官方 hub（hub 用官方 key 发通用文案）。`push-token` 接口与
其它内部接口一样只认设备会话 token（cookie/Bearer 等价）。

---

## 6. 安全边界

- 设备身份只来自**配对登记的设备公钥 + relay 签名的短时 token**；主机逐请求验签
  并校验 token 里的 deviceId 仍在本机有效设备表。不信任来源 IP / `X-Forwarded-*` /
  `Host` / `Origin` / 自定义头 / 查询参数。
- relay 边缘终止手机 TLS、可见明文（A 模式取舍，风险与责任由部署方承担）；
  主机只做出站隧道，不持有 TLS 私钥。
- DSH Web 始终保持 `127.0.0.1`，插件剥离客户端头并注入本机 session cookie。
- 配对密钥一次性且短时有效；主机侧另有限速；设备可撤销（主机设备表 + relay 会话双保险）。
- 管理 API 只允许本机已认证 DSH 浏览器访问；远程设备一律 403。
- 「重启主机」组件默认关闭；开启后仍要求设备 token 鉴权（cookie/Bearer 等价）且设备未撤销，
  关闭时接口直接 501，不进入调度。
- 推送 token/credential 只存内存、不落盘、不进日志/status/审计明文（status 只给计数与可读错误）；
  设备撤销后随 `device.sync` 清理。主机不持有 APNs 私钥 / hub relay token / hub 签名密钥。
- official 登记只做格式校验（https hubEndpoint ≤2048 无 userinfo/query/hash、三段式 JWT
  credential ≤4096）；**签名与 claims 由官方 hub 校验**（主机没有 hub 公钥，不是信任边界）。
  official 直连失败不回退 relay（避免重复通知）。

---

## 7. 手机 WebView 的会话优化（Client 半）

只在手机远程 WebView（`?dsh_mobile=1`）下生效，桌面本机不安装：

- **会话热缓存**：最近打开过的 3 个会话额外 retain，切走不销毁、切回 0 快照；
  超过按 LRU 释放；连接断开时只保留当前会话。可用
  `globalThis.__DSH_REMOTE_SESSION_CACHE__ = { max }` 调整。
- **历史分片**：把 `session/follow` 首屏与 `session/page` 翻页请求窗口压小
  （`6/3/1`、`10/5/1`，turn rail 跳转 `30/15/2`），历史交给 DSH 既有「加载更早」按需补齐。
  调试覆盖：`globalThis.__DSH_REMOTE_MOBILE_HISTORY__`。
- **后台恢复重连**：页面隐藏 ≥10s 再恢复时主动重连，刷新会话状态。

细节见 [`docs/diagnostics/04-session-switch-cache.md`](../../../docs/diagnostics/04-session-switch-cache.md)
与 [`09-mobile-history-slicing.md`](../../../docs/diagnostics/09-mobile-history-slicing.md)。

> 新增/修改 WebSocket 反向代理时注意保留 `lib/ws-keepalive.js` 的心跳桥：DSH 的
> `/api/remote.mux` 每 2s Ping，慢速链路上大帧会挤占心跳，代理需要及时代答 Pong，
> 否则 DSH 会误判失联并踢掉 mux。

---

## 8. 排障

| 现象 | 检查 |
|---|---|
| 注册报 `not_found`（控制面只接受 WebSocket upgrade） | 「服务地址」填成了控制面 WSS 端口；要填**注册 API** 地址（如 `https://relay.example.com:19443`） |
| 注册报 `invalid_invite` / `invite_expired` / `host_limit` | 邀请码错误/过期/用尽，或该部署方主机配额已满；找部署方重新生成 |
| 隧道断开 | 服务地址可达？`group.json` 里 `controlUrl` 是否与当前服务端一致？点「重试连接」或重新注册 |
| 手机 401/403 | 设备是否已配对且未撤销？token 是否过期（App 自动续期）？Host 头是否等于 `<hostId>.<relayDomain>`？ |
| 配对二维码过期 | 重新生成；配对密钥 ≤120s |
| 手机打开管理 API 403 | 这是安全边界；远程设备不允许管理本地插件 |
| App 没有「重启主机 ⏻」按钮 / 重启报 `host-restart-disabled` | 「设置 → 远程访问 → 组件」里「允许手机重启主机 DSH」是否开启（默认关闭）；保存后 status 的 `restart.enabled` 应为 true |
| 保存组件开关后 App 提示「自动重连未恢复，请点击刷新重试」 | 插件是否 ≥0.2.4（0.2.3 会一次断开所有 WS，耗尽 App 自动恢复预算）；升级 0.2.4 后应只断 `/api/remote.mux` 一条主通道，App 自动 reload |
| 重启报 `host-restart-unavailable` / `host-restart-unsupported` | 插件版本过旧，或当前运行环境不支持自动重启（如 Linux Electron）；本机手动重启仍可用 |
| self App 收不到推送 / 登记报 `push-disabled` | relay 的 `group.push.enabled` 是否为 true；部署方检查 APNs key/topic/environment（relay 侧配置，主机无需配置） |
| official App 登记报 `invalid-body` | 检查 App 上报的 bundleId / hubEndpoint（必须 https 基址）/ credential（三段式 JWT）；`status.push.official.lastError` 与主机审计有原因 |
| 登记报 `push-not-connected` / `push-timeout`（仅 self） | 隧道是否在线（status 的 `relayConnected`）；稍后重试登记（App 回前台/重新进入主机会自动重试）；official 不走 relay，不受影响 |
| status 的 `push.mode` 为空 / `push.official.devices=0` | 还没有设备登记（App 进入主机后自动登记）；official 设备登记失败看 `official.lastError`（hub 不可达/credential 过期时会重新换发） |
| official 推送失败 `rate_limited` / `timeout` / `invalid_credential` | 官方 hub 的限流或 credential 过期；主机不重试、不回退 relay；App 重新进入主机/回前台会重新登记换 credential |
| 打开大会话「载入历史」很久/失败、画面反复跳 | 插件是否为 ≥0.2.0 且已重启 DSH；手机 WebView 是否加载了历史分片；relay 带宽/线路是否过慢；详见 [`docs/diagnostics/09-mobile-history-slicing.md`](../../../docs/diagnostics/09-mobile-history-slicing.md) |

---

## 9. 相关文档

- [relay / 服务器部署](../../../server/README.md)
- [群体服务设计（A 模式）](../../../docs/group-service-design.zh.md)
- [服务器 / relay 部署](../../../server/README.md)
- [根目录 README](../../../README.md)

---

## 10. 变更记录

- **0.2.6**（R2：官方推送与 relay 解耦，混合设备自动分流）
  - `POST /__dsh_remote/push-token` 向后兼容扩展：新增可选 `channel`（缺省 self）、`bundleId`、
    `hubEndpoint`、`credential`；official 必须合法 bundleId + https hubEndpoint（≤2048，无
    userinfo/query/hash）+ 三段式 JWT credential（≤4096）；self 拒绝夹带 hub 字段。原有设备会话
    token 鉴权与设备在册校验不变；记录仅存内存，撤销/`device.sync` 清理，审计不写 token/credential。
  - 发送分流：self 设备继续 `connector.sendPushIntent`（relay 路径不变）；official 设备逐设备
    `POST {hubEndpoint}/v1/push`（Bearer credential，body 只 `{kind,host,token}`，10s 超时、
    不重试、失败不回退 relay）；没有 self 设备时不向 relay 发；hub `pruned` 时删除对应设备记录。
  - `status.push` 扩展为 `{enabled, self:{devices,lastError}, official:{devices,lastError,hub}, mode}`
    （mode=self/official/mixed），不含 token/credential；主机「推送提醒」开关语义不变（关闭即不发）。
  - 桌面设置页推送区展示两通道设备数/官方 hub/错误；版本 0.2.6。
  - 测试：新增 `push-r2.test.js`（official 校验矩阵、分流、超时、pruned、混合/通道切换），
    更新 connector / group-runtime / group-admin 端到端 / admin / group-restart / service /
    client-smoke 覆盖，`npm test` 全绿。
- **0.2.5**（群体服务版推送 R1：服务端集中发送，主机零 Apple 凭据；R2 保留 self/relay legacy）
  - 新增 `lib/push.js` / `lib/push-summary.js`（自 main 移植并适配群体版）：监听
    `session/event`，`turn/end`（completed/error/max-tokens/blocked，子代理跳过，同 session 30s
    冷却）与 `ask_user_question`（正文固定「正在等待你的回答」，按 callId 去重、不占冷却）
    生成 `push.send` 意图（`randomUUID` id + 会话标题/助手摘要/`sessionId`）；主机开关关闭、
    relay 未连接时静默跳过；15s 无 `push.result` 只记日志、不重发。
  - connector 增加 `registerPushToken` / `sendPushIntent` 与 `push.registered` / `push.result`
    入站回调；成功登记的 token 只在内存缓存，重连 ready 后自动补报（relay 重启丢内存 token 表）。
  - 新增远程内部接口 `POST /__dsh_remote/push-token`：沿用会话 token 鉴权 + 设备在册校验，
    校验 64 位小写 hex / apns / environment 后转发 relay；返回 `registered/mode` 或
    400 `invalid-push-token` / 401 / 403 `push-disabled` / 502 `push-rejected` /
    503 `push-not-connected` / 503 `push-timeout`（5s 未等到 `push.registered`，可重试）。
  - `status`（本机管理 API 与 `GET /__dsh_remote/status`）新增 `push` 对象：`enabled` /
    `provider` / `serverEnabled` / `mode` / `tokens` / `lastError`（**不含 token 明文**）；
    token 不落盘，设备撤销后随 `device.sync` 清理。
  - 配置新增 `pushEnabled`（默认开启）：设置页「推送提醒」开关只持久化、不重建运行时；
    `push.result` 失败码只记日志/审计，不重试。
  - 测试：新增 `push.test.js` / `push-summary.test.js`，扩展 connector / group-runtime /
    admin / group-restart / config-save / service / client-smoke 覆盖（128 个测试全绿）。
- **0.2.4**（修复 App「自动重连未恢复，请点击刷新重试」）
  - 保存「组件 → 允许手机重启主机 DSH」后不再断开**所有** Upgrade/WS 连接：跟踪每条 Upgrade
    的请求 pathname，默认**只断开 DSH 主实时通道 `/api/remote.mux`**（其它插件/子页面 WS 保留）。
    0.2.3 一次断开多条会让 App 在同一瞬间收到多个 `dsh-ws-close`，把自动恢复预算
    （60s 内 2 次）一次耗尽、不再自动 reload。
  - `closeUpgradedConnections({ path })` 支持定向断开（默认值为 `REMOTE_STREAM_MUX_PATH`）；
    空 path 不做任何事，返回实际断开条数。
  - 已升级的 socket（half-open）在对端 FIN 时主动 `destroy`，避免跟踪表残留“假活”连接；
    `stop()` 主动断开本代理上的全部连接（含 Upgrade）后再 `close()`，避免重建运行时卡住。
- **0.2.3**：保存「组件 → 允许手机重启主机」后主动断开 App 的 Upgrade/WS 连接（隧道不重建），
  让 App 的 ws-close 自动恢复立即重载页面并重新拉 status，顶栏 ⏻ 无需退出重进即可出现/消失。
  （0.2.4 将其收窄为只断主实时通道。）
- **0.2.2**（修复「允许手机重启主机 DSH」保存失败）
  - 历史配置迁移：`config.groupServiceUrl` 为空但有 `group.json` 注册信息时，启动/保存时
    自动用 `registration.serviceUrl` 回填并落盘（此前会因 `validateConfig` 报
    「groupServiceUrl（服务地址）未配置」，导致任何保存都被 admin 拒绝为 400 invalid-config，
    隧道也无法重建）。
  - 配置保存按需重建运行时：只有 `enabled` / `groupServiceUrl` / `groupInviteCode` /
    `hostName` / `groupPlainPort` / `groupInsecure` / `requireApproval` / `denyPrefixes` /
    `maxRequestBytes` 变化才重建 `GroupHostRuntime`；`restartHostEnabled` 等纯状态字段
    只持久化，保存立即返回、隧道不重连。
  - 非运行时字段的保存不再返回历史遗留校验错误（`updateConfig` 返回 `applied` 标记，
    admin 只在真正重建运行时失败时返回 400）。
  - 停止 loopback 代理时主动断开残留 keep-alive/活跃连接，避免重建等待连接自然结束造成的
    「保存很慢/超时」。
  - 客户端保存失败 toast 带上服务端 `error.message` 与 `error.code`（如 `invalid-config`）。
- **0.2.1**：群体版恢复「重启主机 DSH」可关闭组件（`restartHostEnabled`，默认关闭）、
  cookie/Bearer 等价鉴权、`GET /__dsh_remote/status` 返回 `restart.enabled`、
  `POST /__dsh_remote/restart`（202/401/405/501 + 审计）。
- **0.2.0**：群体服务版（A 模式）主机能力（注册/隧道/loopback 明文代理/群体配对）。
