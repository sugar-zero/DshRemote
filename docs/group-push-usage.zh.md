# 群体版推送：使用与边界手册（先看这里，避免误报 bug）

> 面向：普通使用者 / 部署方（自签 App 用户）/ 官方 App 用户
> 版本：relay **0.4.0** / push-hub **0.3.1** / host-plugin **0.2.6** / App **0.2.0 (build 18)**
> 关联：实现契约 [`group-push-r2-contract.zh.md`](group-push-r2-contract.zh.md)、
> 部署 [`../server/README.md`](../server/README.md) §6、主机插件
> [`../dsh-remoteService/packages/host-plugin/README.md`](../dsh-remoteService/packages/host-plugin/README.md)、
> App [`../dsh-remoteApp/README.md`](../dsh-remoteApp/README.md)。

## 0. 一分钟版

- 推送走哪条通道，**由手机 App 的构建/签名决定，不是主机设置里选**：
  - `self`（部署方自签 App）→ App 报 token 给主机 → **主机 → 部署方 relay**（部署方自己的 APNs key）→ Apple；
  - `official`（官方 App）→ App 用设备密钥向**官方 hub** 登记 → **主机凭 credential 直连 hub** → Apple。
- 主机设置页**只有一个推送开关**（「推送提醒」）；「推送通道 / 自部署设备 / 官方直连设备 / 最近错误」都是**运行状态**，不是配置项。
- **一台手机同一时间只能装一种构建**（self 或 official）；混用需要两台设备（或以后换包重装）。
- 官方 App 的推送**不需要任何 relay 推送配置**；自签 App 的推送**必须**由部署方 relay 配好 APNs key。

## 1. 主机设置页字段说明（DSH「设置 → 远程访问 → 推送」）

| 字段 | 含义 | 是配置吗 |
|---|---|---|
| 推送提醒（开关） | 主机是否**上报新的推送意图**；保存后立即生效、不重建隧道 | ✅ 唯一配置 |
| 推送通道 | 由当前已登记设备推导：`自部署（经 relay）` / `官方（设备直连 hub）` / `混合（自动分流）` / `—` | ❌ 状态 |
| 自部署设备 | 当前在册的 self 设备数（经 relay 发送） | ❌ 状态 |
| 官方直连设备 | 当前在册的 official 设备数（主机直连 hub 发送） | ❌ 状态 |
| 官方推送 hub | 官方 App 上报的 hub 公网地址（仅展示，self 不需要） | ❌ 状态 |
| 最近错误 | **按通道**最近一次失败原因（历史/瞬时；成功后会更新） | ❌ 状态 |
| 保存 | 只写「推送提醒」开关，不重启隧道/不重建运行时 | — |

> 主机**不持有任何 Apple 凭据**；token/credential 只存内存，重启即清（App 下次连上会补报）。

## 2. 三种使用组合

### A. 只用官方 App（最省事）
1. 官方 hub 已部署（公网 HTTPS，`HUB_PUBLIC_URL` 与 App 内置地址一致）；
2. 安装**官方构建** App（`EXPO_PUBLIC_PUSH_CHANNEL=official` + `EXPO_PUBLIC_PUSH_HUB=https://<hub>`）；
3. 主机「推送提醒」保持开启即可；relay **不需要**任何推送配置；
4. App 进入主机后自动向 hub 登记 → 设置页显示「官方（设备直连）」。

### B. 只用自签 App
1. App 用**默认构建**（不注入 `official`，即 self）；
2. 部署方 relay 配好 **self 推送**（`.env.group` 或 `relay.json`）：

   ```bash
   RELAY_GROUP_PUSH_ENABLED=true
   RELAY_GROUP_PUSH_MODE=self
   RELAY_GROUP_PUSH_CONTENT=generic          # 或 summary
   RELAY_GROUP_PUSH_APNS_KEY_FILE=/data/apns/AuthKey_<KEY_ID>.p8
   RELAY_GROUP_PUSH_APNS_KEY_ID=<KEY_ID>
   RELAY_GROUP_PUSH_APNS_TEAM_ID=<TEAM_ID>
   RELAY_GROUP_PUSH_APNS_TOPIC=<自签 App 的 bundle id>
   RELAY_GROUP_PUSH_APNS_ENVIRONMENT=auto
   ```

   `.p8` 放 relay 的 `data/apns/`（`chown 100:101`、`chmod 600`）→ **重建 relay 容器**；
   验证 relay `/healthz` 出现 `"push":{"enabled":true,"mode":"self","tokens":N}`。
3. 主机「推送提醒」保持开启；无需填地址；App 进入主机后自动登记。

### C. 混用（官方 + 自签）
- 同时完成 A + B；主机自动按设备 channel 分流，不需要选通道；
- 需要两台设备（或换包重装）分别装两种构建；
- 状态会显示「混合（自动分流）」，两行设备数分别计数。

## 3. 常见“看起来像 bug，其实是设计”的行为

| # | 现象 | 解释 / 结论 | 什么时候才是真 bug |
|---|---|---|---|
| 1 | 为什么这里显示“官方”，我没选过通道？ | 没有通道选择；状态由**已登记设备**推导（见 §1） | 有 self 设备登记成功但通道不显示混合 |
| 2 | 「自部署设备 0 台」+ 错误「登记推送 token 超时：relay 未在 5s 内回应」 | self 设备想经 relay 登记，但 relay 没开 self 推送 / relay 版本太旧 / 隧道异常 | 按 §2B 配好并重建后，重新注册仍报同一错误 |
| 3 | App 推送开关关了，还是收到通知 | App 开关**只停止新登记**，不注销已登记 token；总闸在**主机「推送提醒」** | 主机开关已关闭并保存后仍收到，才是 bug |
| 4 | 改了 relay/hub 配置，推送没变化 | relay/hub 配置需**重建容器**才生效；主机开关保存即时生效 | 重建后 `/healthz` 仍显示旧值 |
| 5 | 换装另一种 App 构建后收不到 / 表现不一致 | 一台手机只能装一种构建；同 bundle id 覆盖安装会保留配对数据，但通道随构建变化 | 同构建下、登记状态正常却收不到 |
| 6 | 主机/relay/hub 重启后一段时间收不到 | token/credential 只在内存；App 重新进入主机/回前台才会补报 | App 已重连且显示已注册，仍收不到 |
| 7 | official 通知没有会话名/摘要；点通知只到主机 | 需要用户在主机开启「详细推送内容」才会带 title/body；sessionId 已支持（0.3.3 起点通知直达会话） | 通知完全没有任何文案/点不开 App |
| 8 | 关闭开关后还收到一条 | 关闭只影响**之后**的推送意图；已发出的通知会正常送达 | 关闭保存后仍持续有新通知 |
| 9 | 同一会话很快连续触发，只收到一条 | 每会话 30s 冷却；`ask_user_question` 有独立触发；子代理会话不推送 | 正常间隔仍收不到 |
| 10 | App 在前台时没有系统通知 | iOS 前台可能显示应用内卡片/按通知设置处理；请锁屏或切后台验证 | 锁屏/后台也无通知 |
| 11 | self 显示已登记但收不到 | relay 的 APNs key / Team / topic / environment 不匹配（开发包= sandbox，发布包= production）；或 relay 出网失败 | relay 日志有 APNs 明确错误码（BadDeviceToken 等） |
| 12 | official 显示已登记但收不到 | hub 不可达 / credential 过期 / `apns.topic` 与 App 签名不一致；看 hub 日志 `push: mode=device delivered=...` | hub 日志出现 delivered 但手机无通知（系统通知权限） |
| 13 | hub 没有后台页面 / 限速修改很麻烦 | 设计如此：hub 只提供 API + `/healthz`；限速是 env/hub.json 配置，改完重建容器；无状态、无数据库 | 需要在线改限速/看实时指标 → 属于新功能需求 |
| 14 | hub 好像谁都能注册 | 设计如此：官方 App 面向所有用户，开放登记；有 PoP + 限速 + APNs topic 兜底；没有账号体系 | 怀疑有人刷接口/资源耗尽 → 加限速或 App Attest |
| 15 | credential 30 天后 official 推送停了 | 默认 TTL 30 天；只有 App 能 PoP 续期，App 需至少每 30 天打开一次（后续计划把 credential 生命周期移交主机，见 STATUS「已知限制/后续计划」） | 30 天内 App 有打开且剩余 <24h 仍未续期 |
| 16 | `/healthz` 公网能打开 | 只含能力/配额摘要，不含 token/密钥；可自行用 nginx 限制为本机/监控 | 发现泄露 token/credential/私钥 |
| 17 | 撤销设备/重新配对后 | 主机清理该设备 token；relay/hub 重启后 token 表清空；App 重新进入会重新登记 | 撤销后仍能推送 |
| 18 | App 设置页显示「通知权限被拒」 | 系统通知权限未授予；到 iOS「设置 → 通知 → DSH Remote」开启后重新注册 | 权限已开仍显示被拒 |

## 4. 排错速查

1. **先看三处状态**：主机设置页（通道/设备数/最近错误）、App 设置页推送卡、relay 或 hub 的 `/healthz`。
2. self：relay `/healthz.push.enabled=true`、`mode=self`；relay 日志有 APNs 结果；部署方 APNs key 与 App 签名同一团队、topic 一致。
3. official：hub `/healthz` 的 `apns.configured=true`、`credential.enabled=true`、`enroll.enabled=true`；hub 日志 `delivered/failed/pruned`；App 设置页显示「官方（设备直连）」。
4. 通知权限与专注模式：iOS 系统设置、锁屏通知预览设置也会影响显示。
5. 仍无法定位时，提供（脱敏后）：主机状态截图、App 推送卡截图、relay/hub 最近日志（去掉 token/credential/域名/IP）。

## 5. 配置位置速查

| 要改什么 | 在哪里 | 生效方式 |
|---|---|---|
| 主机是否上报推送意图 | DSH 主机设置页「推送提醒」 | 保存即生效（不重建隧道） |
| relay 的 self 推送（APNs key/内容/冷却） | relay `.env.group` 或 `relay.json` 的 `group.push`；密钥放 `data/apns/` | 重建 relay 容器；`/healthz` 验证 |
| hub（官方推送）APNs/credential/限速/TTL | hub `.env.push-hub` 或 `hub.json` 的 `limits`/`apns`/`credential` | 重建 hub 容器；`/healthz` 验证 |
| 官方 App 的 hub 地址/通道 | **构建时**注入 `EXPO_PUBLIC_PUSH_CHANNEL=official` + `EXPO_PUBLIC_PUSH_HUB=https://<hub>` | 重新构建安装（运行时不可改） |
| App 本地推送开关 | App 设置页「推送」卡 | 立即生效（只影响新登记） |

## 6. 安全 / 隐私边界

- 主机**零 Apple 凭据**；不持有 hub 签名密钥；token/credential 只存内存、不落盘、不进日志/status 明文。
- official：默认发**通用文案**；主机开启「详细推送内容」后 hub 接受成对 title/body；0.3.3 起也接受 `sessionId`（点通知直达会话）。credential 绑定 tokenHash + hostId + env + bundleId + aud。
- self：relay 用部署方自己的 key 直连 Apple；relay 是部署方自建/自管（A 模式部署方可见明文，风险由部署方承担）。
- 撤销：主机删除设备记录后，对应 token 清理；relay/hub 重启后 token 表清空（设计取舍：不在服务端持久化设备 token）。
- 不要提交/外传：`.p8`、credential、设备 token、配对二维码、`server/.env*`、`hub.json`。

## 7. 版本与迁移

- **relay 0.4.0**：只保留 `self` 推送；legacy `mode=official`（relay 转发 hub）已删除（配置会报错）。
- **push-hub 0.3.1**：R2-only（不识别 relay）；credential 默认 TTL **30 天**（原 7 天）。
- **host-plugin 0.2.6**：按设备 channel 分流；设置页展示两通道状态。
- **App 0.2.0 (build 18)**：official 构建支持（`pushConfig`/`pushHub`）；self 包为 0.1.9 build 17（代码相同）。
