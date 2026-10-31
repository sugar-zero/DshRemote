# 群体服务版（`feat/group-service`）设计决策记录

> 状态：**P0 决策稿**（2026-10-27）· 分支 `feat/group-service`（基于 `main` @ `56ba36f`）
> 决策人：项目所有者（2026-10-27 会话拍板）· 实施从 P1 POC 开始
> 关联：根 `README.md`「群体服务版」、分支版 `AGENTS.md`「分支说明」、本地 `todo/TODO.md` T2 / T2.1
> 脱敏约定：本文所有域名 / hostId / 序列号一律使用占位符（`relay.example.com`、
> `h_ab12cd34`、`<BUNDLE_ID>`、`<VPS_IP>`），与任何真实部署无关。

## 0. 一句话

给「**任何人可自行部署、邀约小范围群体使用**」的远程访问形态：**服务端终止 TLS（A 模式）**，
主机只做出站隧道；**设备身份 = 配对注册的设备密钥 + 短时 token**（取消客户端证书）；
主机 ID 由服务端分配管理；推送由服务端统一完成。`main` 的 B2 盲中继形态**保持不变**。

## 1. 目标与非目标

### 目标（v1）

- 任何人（有 VPS + 域名）可一键部署一套服务，用邀请码邀约 3–20 人的小群体。
- 主机侧**零证书、零 token 手填**：填「服务地址 + 邀请码」后自动注册、领端口、出配对码。
- App 支持两种来源：部署方**自建 App**（自己的 Apple 团队 + 自己的 APNs key），
  或使用**官方 TestFlight 版**（推送走官方 hub）。
- 保留现有能力：WebView 复用 DSH UI、会话/审批/终端、推送、设备管理、撤销、远程重启（可选组件）。

### 非目标（v1）

- 不做公开注册 / 公开 SaaS（**邀请制**，只服务小范围可信群体）。
- 不做账号体系 / 工作区 / 计费（**配对即注册**）。
- 不做服务端会话历史（T1.1 仍是后续独立选项）。
- 不做 Android 服务端推送集中化（FCM 随后）。

## 2. 关键决策（2026-10-27 拍板）

| # | 决策 | 说明 |
|---|---|---|
| 1 | **A 模式** | relay 终止 TLS（通配证书）；主机只做出站隧道；部署方可见明文，**风险与责任由部署方承担** |
| 2 | **取消客户端证书** | 设备密钥（Secure Enclave / Keystore，配对时注册公钥）+ **短时 token（15–30 分钟，native 续期）** |
| 3 | **主机 ID 服务端管理** | 注册时分配、唯一、不可改；友好名称本地填写并同步服务端管理台 |
| 4 | **推送服务端完成** | 自建 App → 部署方直连 APNs；官方 TestFlight 版 → 官方中央推送 hub（建议通用文案） |
| 5 | **邀请制注册** | 邀请码 + 限速 + 配额；不做公开注册 |
| 6 | **`main` 不合并** | 两套形态同仓库、代码开关隔离；本分支不回流 `main` 默认路径 |

## 3. 架构

```
手机 App（WebView + 原生壳）
  │  https://<hostId>.<relayDomain>:<port>     ← 通配证书 TLS + __Host- 会话 cookie
  ▼
relay / 服务端（公网，A 模式，部署方运营）
  ├─ 边缘 TLS 终止（通配证书 `*.<relayDomain>`）
  ├─ 设备鉴权：短时 token 校验（15–30min）
  ├─ 路由：SNI / Host → hostId（服务端校验，不信任客户端声明）
  ├─ 出站隧道：WSS 到主机插件（HTTP/WS 多路复用、背压、心跳独立）
  └─ 推送：APNs direct（部署方 key） / 官方 hub / webhook 兜底
  ▼
主机插件（DSH 主机，只出站）
  ├─ 隧道客户端：注册、心跳、多路复用、重连
  ├─ 逐请求鉴权：relay 签名断言（deviceId/hostId/时间戳）+ 本机设备表
  ├─ 反代到 127.0.0.1 的 DSH（注入本机 cookie；deny list 与 main 一致）
  └─ 推送意图 / 设备 token 上报（不持有任何 Apple 凭据）
```

组件职责：

| 组件 | 职责 |
|---|---|
| relay（新增 `group` 模式） | 终止 TLS、会话鉴权、hostId 路由、隧道终结、推送、限速/配额、审计 |
| 证书管理 | 部署时 ACME 签 `*.<relayDomain>`；续期；relay 启动自检 |
| 注册 / 管理端 | 邀请码、hostId 分配、主机列表、撤销、配额、部署方推送配置 |
| host-plugin（`group` 模式） | 出站隧道、注册/领配置、逐请求鉴权、反代、设备表、推送意图 |
| App（最小改动） | QR v2 解析、token 认证流程、`__Host-` cookie、推送 token 上报（仍给主机） |

## 4. 信任模型与部署方责任

A 模式把「主机终止 TLS」换成「服务端终止 TLS」，**部署方（自行部署者 / 服务提供商）成为信任方**：

- 可见：会话明文、连接元数据、设备标识。
- 必须承担：内容保密、日志最小化、告知义务、当地法规责任。
- 文档 / App 内须明示：**「本服务由 X 部署，运营方可看到会话内容」**；建议在主机状态与配对页显示运营方名称。
- 日志默认只记录连接元数据（hostId、deviceId、时间、字节数、结果），**不落会话正文**。
- 与 `main` 的差异：`main` 的 relay 是字节管道（B2），本分支的 relay 是**可信服务端**。

残余风险（必须写进部署文档，验收时逐条确认）：

1. relay 被攻破 / 运营方作恶 → 可冒充设备、读内容（A 模式的固有代价）。
2. token 被窃 → 在有效期内等同访问权（短 TTL + 设备密钥续期 + 撤销缓解）。
3. 部署方配置错误（公开注册、弱邀请码、未开 HSTS）→ 滥用面。

## 5. 主机配置契约（群体模式设置页）

以现有「设置 → 远程访问」页为基准，群体模式按下表改造（`main` 模式保留原字段）：

| 字段 | 群体模式行为 |
|---|---|
| 启用远程访问 | 保留；附带注册状态（未注册 / 已注册 / 已撤销） |
| 中继地址 + 中继域名 | **合并为「服务地址」**（如 `https://relay.example.com`）；`wss://relay.example.com:18444` 兼容解析；端口在「高级」可覆盖 |
| 主机 ID | **只读**，注册时由服务端分配（唯一、不可改） |
| 主机名称 | 本地可编辑（好友可见），同步到服务端管理台 |
| 手机访问端口 | **只读**，随注册由服务端下发（写入配对二维码） |
| 中继主机令牌 | **不显示**；注册时自动签发/轮换，0600 落盘；只提供「重置注册」 |
| TLS 证书路径 / 私钥路径 | **删除**（A 模式主机没有证书） |
| 推送（自托管直连 APNs / 私钥 / Key ID） | **整组移除**；仅保留「允许推送」开关；提示「推送由服务提供」 |
| 新设备配对需要本机确认 | **保留**（配对安全核心） |
| 高级项 | 服务端地址覆盖、端口覆盖、`relayTlsInsecure`（仅 POC 显式开启并警告） |

切换规则：`main` 模式与群体模式**互斥**；切换需清空本地注册（hostId/token/设备表），
并重新配对设备（协议不同，`main` 用 v1 + mTLS，群体模式用 v2 + token）。

## 6. 注册与开通流程

1. **部署方**：域名 + 通配 DNS → 启动 relay → 签发 `*.<relayDomain>` 证书 → 管理端生成邀请码。
2. **主机**：DSH 装插件 → 填「服务地址 + 邀请码」→ `POST /register`（限速）→ 服务端分配
   `hostId`、签发 `hostToken`、下发手机访问端口与推送配置 → 本地 0600 落盘。
3. **主机**：建立出站隧道 → 状态 = 已注册 / 在线。
4. **主机**：生成配对二维码（QR v2）→ 手机扫码 → 主机本机确认（SAS 对照）→ 设备公钥注册 →
   主机把设备记录同步给 relay（供边缘鉴权）。
5. **手机**：用设备密钥换短时 token → 访问 `https://<hostId>.<relayDomain>:<port>`。
6. **撤销**：主机设备表删除 → relay 会话失效 + 主机拒绝（双保险）；断链立即生效。

## 7. 认证链（设备密钥 + 短时 token）

- **设备密钥**：配对时在 Secure Enclave / AndroidKeyStore 生成 P-256；公钥注册给主机；
  私钥不可导出。**只有公钥，没有证书、没有 CA**。
- **换 token**：设备用私钥签 relay nonce → relay 签发 15–30 分钟 token（绑定 `hostId` + `deviceId`）。
- **承载**：`__Host-` 前缀、host-only、HttpOnly、Secure、SameSite=Strict 的 cookie；
  native 层负责续期（JS 不可见）。
- **边缘校验 + 签名断言**：relay 逐请求校验 token → 对主机下发**签名断言**
  （`hostId` / `deviceId` / 时间戳 / nonce）→ 主机验签后才允许反代到 loopback DSH。
- **撤销双保险**：主机设备表（权威）+ relay 会话表；任一侧撤销都立即生效。

**禁止作为身份的内容**（与 `main` 相同，写入测试用例）：来源 IP、`X-Forwarded-*`、
`Host`、`Origin`、`isLoopback`、自定义头、查询参数 token、cookie 之外的任何「来源可信」假设。

**租户隔离**：同一 `relayDomain` 下多主机时，cookie 必须 host-only（不得设父域 `Domain`），
relay 不得跨 `hostId` 路由或复写身份；子域之间不共享会话。

## 8. 配对协议 QR v2

```
dshremote://pair?v=2&host=<hostId>.<relayDomain>&port=<port>
            &secret=<一次性 secret>&hostfp=<SHA-256(主机身份公钥)>&exp=<unix ts>&auth=token
```

- v2 新增 `port`（服务端下发）与 `auth=token`（App 据此选择 token 流程；`main` 仍用 v1 + mTLS）。
- `secret` 一次性、120 秒有效；`hostfp` 为完整指纹；本机确认 + SAS 短码对照保留。
- 二维码本身不含长期凭据；不得入库/截图外传。

## 9. 推送（服务端）

- 主机只上报 **device token / 推送意图**；所有 Apple 凭据只在服务端，主机零配置。
- **自建 App 路线**：部署方在自己的服务端配置 APNs（`p8` / Key ID / Team ID / topic），
  relay 直连 APNs。
- **官方 TestFlight 路线**：自部署 relay 用部署凭据把 push intent 发给**官方中央推送 hub**，
  hub 用官方团队的 key 发；hub 只发**通用文案**（如「有任务需要你」+ 深链），
  **不接收会话内容**。
- 内容策略默认**通用文案**；会话标题 / 摘要需部署方与用户显式开启（hub 场景禁止）。
- Android FCM 随后接入（结构同上）。

## 10. 安全基线与攻击用例（P1 验收必须覆盖）

| # | 攻击用例 | 期望 |
|---|---|---|
| 1 | 伪造 `Host` / `X-Forwarded-For` / `Origin` / 自定义身份头 | 401 / 不构成身份 |
| 2 | 从 relay 内网 IP 直连主机插件端口 | 拒绝（无「内网/回环可信」假设） |
| 3 | 声称来自 `localhost` / 回环 | 不构成身份；不得触发任何 owner 语义 |
| 4 | 重放 / 过期 / 跨 hostId 的 token | 401 |
| 5 | 跨主机 cookie 注入 / 读取（父域 Domain） | 隔离；host-only 生效 |
| 6 | 错误 SNI / 错误 hostId 路由 | 拒绝；不得串路由 |
| 7 | 未配对设备 | 拒绝 |
| 8 | 设备撤销后旧 token / 已建立连接 | 立即失效 |
| 9 | 篡改 / 伪造 relay 签名断言 | 主机拒绝 |
| 10 | 大帧 / 慢速 / 洪泛 | 背压、超时、限速生效；心跳不被堵 |

## 11. 与 `main` 的关系

- 同一仓库、两套形态：`main` = B2 个人自托管（盲 relay + mTLS）；本分支 = 群体服务（A + token）。
- 代码用**模式开关**隔离（`group` 模式），`main` 默认路径与协议不变。
- 配置与协议**不互通**：QR v1（mTLS）vs v2（token）；两套部署不要混用。
- 版本号 / 构建号沿用 `AGENTS.md` 7.1 / 7.4；App 改动仍需构建 + 真机 + 用户确认闸门。
- 本分支**不得**把 A 模式做成 `main` 默认；若未来合并，须另行安全评审与用户决策。

## 12. 分期、POC 验收与风险

**P1（先做，约 2 周）**

1. relay 边缘 TLS 终止（通配证书）+ hostId 路由；
2. 出站隧道（HTTP/WS 多路复用、大帧背压、心跳独立）；
3. 注册 / 邀请 API + 最小管理端（CLI 或页面）；
4. token 鉴权 + 签名断言 + 主机逐请求鉴权；
5. 主机设置页「群体模式」；
6. QR v2 + App 最小改动（token 流程）。

P1 验收：一台主机 + 一台手机 + 一个自部署 relay 跑通「打开会话 / 发消息 / 审批 / 远程重启」，
且 §10 攻击用例表全部通过。

**P2（约 1 周）**：服务端推送（直连 APNs + 官方 hub 最小版）。
**P3（约 1 周）**：分发（自建 App 构建脚本/文档 + TestFlight 运维流程）+ 部署一键化。
**P4（约 1 周）**：加固、审计、文档、真机验收。

**主要风险**

- 大帧堵塞心跳（T1 已有前车之鉴）→ 独立流 / 优先级 / 背压设计，先做压测。
- relay 单点与被攻破 → 文档声明 + 审计 + 最小化日志；运营方责任写入部署文档。
- 注册滥用 → 邀请制 + 限速 + 配额 + 可关闭注册。
- 跨租户 cookie / 路由串话 → §10 用例覆盖。
- 与 `main` 代码分叉成本 → 模式开关 + 定期 rebase/merge `main`。

## 13. 未决问题

1. 官方推送 hub 是否 v1 必做（TestFlight 路线需要），还是先只支持自建 App 的直连 APNs？
2. 邀请码管理形态：CLI / 最小网页 / 二维码邀请链接？
3. 手机访问端口分配策略：每主机一个端口，还是每部署一个端口（443/11443）？
4. 隧道上传 / 下载大小上限（附件、导出、日志）与 relay 超时策略。
5. 会话历史（T1.1）是否作为群体版 v2 选项（服务端存储会进一步加重部署方信任责任）。

## 14. 脱敏约定

本文与配套文档、截图、日志统一使用占位符：`relay.example.com`、`h_ab12cd34`、
`<BUNDLE_ID>`、`<VPS_IP>`、`<HOST_TOKEN>`、`<PAIRING_SECRET>`。真实域名 / IP / hostId /
UDID / 设备名一律不得出现在仓库、issue、PR 或截图中。

## 15. P1 进度

- **2026-10-27：切片 1 已落地**——relay `group` 模式 + 邀请码自助注册
  （`POST /__group/register`，服务端分配 hostId/hostToken/mobilePort，`mobilePort` 随注册下发）+
  CLI（`invite create|list|revoke`、`host list|revoke`）+ `group.json`（0600、邀请码明文便于后台查看、
  host token 只存 SHA-256、原子写）+
  每 IP/全局限速、邀请过期/次数/撤销、`maxHosts` 上限；`npm test` **170/170**、
  `validate:artifacts` 通过；文档见 `dsh-remoteService/packages/relay/README.md` §10。
- **2026-10-27：切片 2 已落地**——边缘 TLS 终止（通配证书，`group.edge`）+ 出站隧道
  （复用控制面多路复用 stream：`host.open {kind:"group-edge"}` + DATA/CLOSE 帧；分帧/背压/心跳独立）；
  错误语义 421/502/503；未认证模式 dev-only（生产默认拒绝）。
  已验证：8MB 大帧回显逐字节一致、传输期间心跳不断（主机不被踢）、断线清理；`npm test` **174/174**。
- **2026-10-27：切片 3 已落地**——设备会话鉴权：`device.sync`/`device.revoke`（主机同步设备公钥）、
  challenge → token（P-256 设备签名换 Ed25519 短时 token，默认 15 分钟）、`__Host-dsh_session` cookie、
  边缘校验（签名/过期/hostId/设备撤销）；注册响应下发 `tokenPublicKey`，主机可离线逐请求复验；
  生产默认拒绝未认证连接（dev-only `allowUnauthenticated` 仅测试用）。`npm test` **179/179**。
- **2026-10-27：切片 4 已落地**——主机插件 group 接入：邀请码自助注册（`POST /__group/register`）→
  `group.json`（0600：hostId/hostToken/relayDomain/mobilePort/tokenPublicKey）；loopback 明文代理
  逐请求鉴权（Host==`<hostId>.<relayDomain>`、`__Host-dsh_session` token 用 relay 公钥离线验签、
  deviceId 仍为有效设备）后交给既有 `DshProxy`；隧道 `device.sync` 同步设备公钥；`status().group` 暴露状态。
  端到端测试（真实 relay + 真 TLS 边缘 + 主机运行时）：注册/隧道/正向请求/Host 不一致 421/无 cookie 401/撤销后 401；
  `npm test` **181/181**。
- **2026-10-27：切片 5 已落地**——Client 半「群体服务（实验）」设置卡片（启用开关 / 服务地址 + 邀请码 /
  注册·隧道状态 / 注册并连接 / 重置注册；group 模式下提示 TLS·APNs 不生效）；管理 API
  `POST /group/register` 与 `POST /group/reset`；设备配对/撤销自动 `device.sync`（DeviceStore.onChange）；
  邀请码一次性（注册成功后清空）。`npm test` **184/184**。
- **2026-10-27：切片 6 已落地（Host/协议侧）**——群体版配对：QR **v2**（`host` + 服务端下发 `port` +
  `auth=token` + relay/hostid）；手机经 relay 边缘 `POST /__dsh_remote/pair` 提交 **P-256 公钥**（不签证书）→
  主机确认后写入设备记录并自动 `device.sync`；relay 边缘对 pair 路径放行（一次性 secret + 主机确认 + 主机侧限速）。
  端到端测试覆盖：注册 → v2 QR 解析 → 边缘配对 → 设备同步 → challenge/token → 隧道访问 → Host 不一致 421 →
  无 cookie 401 → 撤销后 401；`npm test` **184/184**。
- **2026-10-27：切片 7 已落地（部署方后台）**——relay 控制面提供 `/__admin/` 单页后台 + JSON API
  （状态 / 邀请码创建·列出·撤销 / 主机列出·撤销 / 在线隧道数）；`Authorization: Bearer` admin token
  （显式配置或首次启动生成 `<group.json 目录>/admin-token` 0600，`relay.js admin-token` 可查看）；
  失败限速、页面无外部资源/无数据、CSP 收紧；`npm test` **188/188**。
- **2026-10-27：切片 8 已落地（部署镜像）**——relay **0.2.1** group 镜像（linux/amd64，
  `dsh-remote-relay:0.2.1-group`，离线 tar 60MB）；group 模式不再启动 classic 443 L4 透传，边缘 TLS 直接监听
  `group.edge.port`；容器 entrypoint 在 group 模式跳过 host token 预置；新增
  `server/docker-compose.group.yml` + `server/group/relay.group.example.json`；容器内实测：健康检查、
  `/__admin` 页面/API、邀请码创建、主机自助注册、边缘通配 TLS（502 离线主机）全部通过。
  新增 `server/.env.group.example`（group compose 的环境变量模板，与 classic `.env` 分离；`.env.group` 已忽略）。
- **2026-10-27：切片 9 已落地（接口职责分离）**——控制面 WSS 只做主机隧道；`group.apiPort`（注册 API）
  与 `group.adminPort`（部署方后台，默认 bind 127.0.0.1）各自独立监听；注册响应新增 `controlUrl`
  （公网 WSS 地址，来自 `group.publicControlPort`），主机插件据此回连隧道；未配置时保留旧的控制面兜底行为；
  新增 `test/group-surfaces.test.js`（控制面 HTTP 404 / API 面只收注册 / 后台面独立 token）；
  镜像 **0.2.2** 起 entrypoint 对缺失的 `--config` 文件给出可操作提示（不再裸 ENOENT）；
  镜像 **0.2.3** 起 group 模式可**只填 `.env`**（域名/证书路径/端口）：首次启动自动生成
  `data/config/relay.json`（0600，已存在不覆盖），缺域名/证书时给出可操作报错；
  镜像 **0.2.4** 起邀请码在 `group.json`（0600）中明文保存，后台/CLI 可随时查看复制（旧邀请码只有哈希，
  升级后显示"不可显示"，需重新生成）；host token 仍只存 SHA-256；
  镜像 **0.2.5** 起后台不再展示邀请码明文，只提供「复制」按钮（防肩窥），CLI `invite list` 仍可查看；
  镜像 **0.2.7** 起 relay 会记录边缘 auth 请求失败日志（`edge: auth <path> -> <status> ... host/device/原因`），
  便于定位 App challenge/token 401；镜像 **0.2.8** 起同一设备允许多个未消费 challenge（并发/重复请求不再
  互相覆盖），并打印 challenge issued / token issued 日志；镜像 **0.2.9** 起主机控制连接被
  「替换/短暂重连」时不再清空 relay 设备表（避免主机重连、device.sync 到达前的边缘请求瞬时 401，
  表现为首次进入白屏、返回重进才正常）；host-plugin **0.1.22** 起群体版 loopback 明文代理同时
  代理 WebSocket 升级（DSH UI 的实时通道，避免「页面能开但暂无会话/一直重新连接中」）；
  host-plugin **0.1.23** 起群体版鉴权成功时更新设备 lastSeen（管理台不再显示「从未连接」）；
  镜像 **0.2.10** 起记录所有到达边缘的 `/__group/` 请求（定位 App 请求是否到 relay）；镜像
  **0.2.11** 起额外记录 auth 分支命中与隧道放行路径（判断 challenge 是否被误当业务流量转到主机）；
  镜像 **0.2.13** 起对隧道化的首个请求强制 `Connection: close`（避免客户端 keep-alive 复用连接，
  把 pairing 之后的 challenge 直接透传到主机明文代理 → 「配对后立刻 401、点重试又能进」）；
  镜像 **0.2.6** 起新增 `POST /__group/refresh`（hostToken 鉴权、不消耗邀请码）：服务端改
  `mobilePort`/`publicControlPort` 后，主机插件「重试连接」/重启会自动同步最新 mobilePort/controlUrl，
  无需重置注册；
  compose 默认端口：edge 1443 / WSS 18443 / API 19443 / admin 127.0.0.1:19444；镜像重建为 `dsh-remote-relay:0.2.1-group`；`npm test` 190/190。
- **下一片（App，版本线从 0.1.0 起）**：原生 P-256 设备密钥 + challenge 签名换短时 token + `__Host-` cookie
  注入/续期（替代群体模式下的 mTLS）、配对页 v2 流程、WebView URL 带服务端下发端口；构建后交用户真机验证。
