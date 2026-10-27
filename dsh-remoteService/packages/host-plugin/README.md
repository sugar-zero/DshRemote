# dsh-remote-service（主机插件）


> 许可证：**AGPL-3.0-or-later**（完整文本见根目录 [`LICENSE`](../../../LICENSE)）。
运行在 **DSH 主机** 上的远程访问插件，提供：

- 远程访问开关 / 中继连接配置
- 设备配对（二维码 + 一次性密钥 + 桌面 SAS 确认）
- 设备 mTLS 证书签发、设备列表、撤销、已撤销设备记录删除、审计
- 对手机出示 `https://<hostId>.<relayDomain>/` 的 TLS 服务
- 通过 mTLS 反向代理到本机 DSH Web（`127.0.0.1:<port>`，不对外暴露）
- 连接自托管盲中继（relay）的控制面 `wss://relay:8443`
- 推送/审批/文件等宿主侧集成（见下）

服务端 relay 的部署见 [`../../../server/README.md`](../../../server/README.md)；
完整部署步骤见 [`../../docs/DEPLOY.md`](../../docs/DEPLOY.md)。

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

> 本插件已随 `dsh-remoteService` monorepo 开发；Host 半是 `index.js`，
> Client 半是 `client.js`（侧栏入口 + 设置页）。协议见 `packages/protocol`。

---

## 2. 配置

DSH 设置 → 远程访问：

| 字段 | 说明 |
|---|---|
| 启用远程访问 | 关闭后 relay 断开，手机不可访问 |
| 中继地址 | `wss://relay.example.com:8443`（自托管 relay 控制面） |
| 中继域名 | `relay.example.com`；主机域名是 `<hostId>.relay.example.com` |
| 主机 ID | `h_ab12cd34`，必须与 relay token 的 hostId 一致 |
| 手机访问端口 | `443`/留空 = 默认 443（nginx 模式）；直连 relay 数据面时填 `1443` |
| 中继主机令牌 | relay 端 `token create` 生成的一次性 token |
| 主机名称 | 手机/App 显示的主机名 |
| TLS 证书路径 | 主机子域证书 `fullchain.pem` 的本机绝对路径 |
| TLS 私钥路径 | 主机子域私钥 `privkey.pem` 的本机绝对路径 |
| 新设备配对需要本机确认 | 开启后，手机扫码后需在桌面点「允许」 |
| 推送提醒 | 一轮结束/出错时发提醒（标题/正文取会话摘要，默认开启） |
| 自托管直连 APNs | 开：主机用 APNs 私钥直发 Apple（默认）；关：旧版经 relay 的 Expo |
| APNs 私钥路径 | `AuthKey_<KEY_ID>.p8` 本机绝对路径（0600，仓库外） |
| APNs Key ID / Apple Team ID | Apple Developer → Keys / 会员信息 |
| APNs Topic | App bundle ID（例如 `com.example.dshremote`） |
| 同会话推送冷却 | 默认 30 秒 |

### 证书从哪来

主机插件需要的是 **`<hostId>.relay.example.com`** 的证书（不是 `relay.example.com`）：

```bash
CF_Token="<Cloudflare token>" \
  ./dsh-remoteService/scripts/issue-host-cert.sh \
  h_ab12cd34 relay.example.com dns_cf
```

默认安装到：

```text
~/.dsh/remote-access/certs/fullchain.pem
~/.dsh/remote-access/certs/privkey.pem
```

插件每小时检查文件变化并热重建 TLS 监听；证书续期后无需重启 DSH。

### 直连端口模式（App 使用 `host:port`）

如果服务器 443 已被现有 nginx/业务占用，不想改 nginx stream，可以让 App 直接访问
relay 的公网数据端口：

1. 主机插件「手机访问端口」填公网数据端口，例如 `11443`；
2. 重启 DSH（Host 半必须重新加载）；
3. 重新生成配对二维码，host 会带端口：
   ```text
   h_ab12cd34.relay.example.com:11443
   ```
4. App 会直接访问 `https://<host>:11443/`；
5. 服务器防火墙/安全组需要放通该数据端口。

注意：

- 修改 `publicPort` 后**旧二维码不会更新**，必须重新生成；
- 数据面证书仍是主机插件自己的 `<hostId>.<relayDomain>` / `*.<relayDomain>` 证书；
- 不要把 relay 控制面证书当成主机数据面证书；
- 证书 SAN 必须覆盖主机子域：
  ```bash
  openssl x509 -in ~/.dsh/remote-access/certs/fullchain.pem \
    -noout -subject -ext subjectAltName
  ```

### 主机端依赖：openssl（可选，Windows 无需安装）

配对时主机要校验设备 CSR 并签发设备证书，具体走哪条路取决于设备密钥类型：

- **RSA 设备密钥**（Android Keystore / 软件密钥）：内置 node-forge 处理，**不需要** openssl；
- **EC P-256 设备密钥**（iOS Secure Enclave，`ecdsa-with-SHA256` CSR）：forge 不支持
  （`Cannot read public key. OID is not RSA.`），插件**优先调用系统 `openssl`** 校验/签发；
- 找不到 `openssl`（Windows 默认没有，典型报错 `spawnSync openssl ENOENT`）时，自动
  **回退到纯 JS** 实现（`node:crypto` + `forge.asn1`），配对/签发照常完成；
  插件日志会出现 `已回退纯 JS 校验/签发 EC 设备证书`。

因此 **Windows 主机不需要额外安装 openssl**。如果希望优先走 openssl（与 macOS/Linux
上的行为完全一致）：

1. 安装 OpenSSL 3.x，或直接使用 Git for Windows 自带的
   `C:\Program Files\Git\usr\bin\openssl.exe`，把该目录加入 **PATH**；
2. **重启 DSH**（已在运行的进程不会重新继承新的 PATH）；
3. 配对日志不再出现「回退纯 JS」即表示走的是 openssl。

> 如果配对返回 `invalid_request`，且消息里同时出现 `OID is not RSA` 与
> `spawnSync openssl ENOENT`，说明主机上还是**没有纯 JS 回退的旧版插件**；
> 升级到 host-plugin **0.1.7+** 并重启 DSH 即可。

### 证书与私钥不匹配 / 手机「无法连接」怎么查

主机插件启动远程 TLS 监听前会自检两项，并把原因写进 DSH 设置 → 远程访问 → **最近错误**：

- `TLS 证书与私钥不匹配：证书公钥 <hash>，私钥公钥 <hash>`：`fullchain.pem` 与
  `privkey.pem` 不是同一次签发的一对（常见于从 nginx 拷证书时跨目录拼了 cert/key）；
- `TLS 证书 SAN 未覆盖主机名 <hostId>.<relayDomain>`：拷成了别的域名或非通配证书。

手动核对时注意：**EC 证书不能用 RSA modulus 比对**。`openssl x509 -modulus` 在 EC 证书上
只会输出 `Modulus=No modulus for this public key type`，`openssl rsa -modulus` 会报
`Not an RSA key` —— 两条命令都失败 **不代表**证书与私钥不匹配。正确做法是比较公钥指纹：

```bash
# 两行应输出同一个 SHA-256
openssl x509 -in fullchain.pem -noout -pubkey | openssl pkey -pubin -outform der | openssl dgst -sha256
openssl pkey -in privkey.pem -pubout -outform der | openssl dgst -sha256

# 确认 SAN 覆盖主机子域
openssl x509 -in fullchain.pem -noout -checkhost <hostId>.<relayDomain>
openssl x509 -in fullchain.pem -noout -subject -dates -ext subjectAltName
```

Windows（PowerShell）命令相同，把 `openssl` 换成已安装的 `openssl.exe`（或 PATH 里的名字）。

> 若证书与私钥真的不匹配，插件**不会启动**远程 TLS 监听（管理页显示
> 「TLS 证书与私钥不匹配…」），手机侧表现为「无法连接」，而不是配对请求报错。
> 反过来说：手机能收到主机返回的 JSON 错误，说明 TLS 监听是起来的、证书与私钥是匹配的。

### 如果 DSH 主机运行在 Docker 中

把主机证书挂进 **DSH 容器**（不是 relay 容器）：

```yaml
volumes:
  - /srv/dsh/remote-access:/root/.dsh/remote-access:ro
```

插件里填容器内路径，例如 `/root/.dsh/remote-access/certs/fullchain.pem`。

---

### 推送（自托管 APNs，会话摘要）

默认 `pushProvider=apns`：主机插件在 DSH 会话一轮结束/出错时，用本机 APNs Auth Key
**直接调用 Apple**，不经过 relay、不需要 Expo 账号。

1. Apple Developer（付费）→ Keys → 新建 **Apple Push Notifications service (APNs)** key：
   - **Environment** 选 **Sandbox & Production**（推荐；只选 Sandbox 的 key 只能发开发包，
     上架/Ad Hoc 前必须换成覆盖生产环境的 key 或新建一把）；
   - **Key Restriction** 选 **Team Scoped (All Topics)**（或 Topic Specific 选 App 的 bundle ID）；
   - 下载 `AuthKey_<KEY_ID>.p8`（只能下载一次），记下 Key ID；Team ID 在会员信息里。
2. 把 `.p8` 放到仓库外（例如 `~/.dsh/remote-access/apns/`），`chmod 600`。
3. 设置页「推送提醒」开启、「自托管直连 APNs」开启，填私钥路径 / Key ID / Team ID /
   Topic（App 的 bundle ID）。
4. App 进入主机后会通过 mTLS 注册 `POST /__dsh_remote/push-token`
   （provider=apns + APNs device token + aps-environment）。开发签名包自动走
   `api.sandbox.push.apple.com`，发布签名包走 `api.push.apple.com`（由主机按注册时上报的
   environment 选择）。
5. 触发条件：`turn/end` 且原因为 completed/error/max-tokens/blocked、非子代理会话、
   同会话 30s 冷却。
   通知内容取自实际会话：**标题 = 最新会话标题（无则首条用户消息）；正文 = 本轮最后一条
   助手回复的截断摘要**（失败时加 `⚠️`；没有文本时用状态兜底文案）。只截断文本，不额外
   附带路径/命令/工具输出等字段；payload 只含标题/正文 + `{kind, sessionId, host}`
   （`sessionId`/`host` 仅用于点击通知跳会话，见第 7 点）。
6. APNs 返回 **410 / Unregistered** 时自动清理失效 token（内存 + `push-tokens.json`）；
   `BadDeviceToken` / `DeviceTokenNotForTopic` 多为 **topic / 环境配置错误**，不删 token，
   只在日志/状态提示检查 `apnsTopic` / `apnsEnvironment`（避免一个 typo 清空所有 token）。
7. **点通知跳会话**（App 0.1.5+）：payload 顶层 `body` 字典带 `{kind, sessionId, host}`
   （expo-notifications iOS 只把 `userInfo["body"]` 映射成 `content.data`，不能放根字段）。
   App 点击后通过原生 `evaluateJavaScript` 调用 host Client 半注册的
   `window.__DSH_REMOTE_OPEN_SESSION__(sessionId)`（内部 `uiWorkspace.openSession`）；
   同一时刻 host Client 半还会通过 WebView 桥上报当前会话，App 用它判断「前台推送是否
   属于当前正在看的会话」——是则应用内卡片和系统横幅都不显示；其它会话仍提示。
   `uiWorkspace` 不可用时自动降级为只打开主机。
   如果日志出现 `403 InvalidProviderToken`，通常是 **key 的环境范围/权限与运行包不匹配**，
   或 Key ID/Team ID 填错。

> 隐私提示：通知标题/正文会进入 APNs payload，可能显示在锁屏/通知中心（并经过 Apple 的
> 推送网络）；payload 的 `body` 还会带 `host` 与 `sessionId`（仅用于点击跳转，不新增会话
> 内容）。若不想让会话摘要出现在锁屏，请关闭推送或隐藏锁屏通知预览。
> 旧版通道：`pushProvider=expo` 时沿用 relay → Expo Push（relay 侧仍是通用文案，不含会话
> 内容），配置见 [`../relay/README.md`](../relay/README.md) §6.1；默认不启用。
> 安全边界：`.p8` 与设备 token 都只在本机；relay 不参与自托管 APNs 通道，也看不到 token。

### 手机 App 重启主机 DSH（0.1.16+，组件开关，默认关闭）

主机插件更新（linked 包/新版本）后，需要重启一次 DSH 才会加载新的 Host/Client 半。以前
得回到电脑上手动退出再打开；**0.1.10 起**，手机 App 的「重启主机」按钮可以远程触发：

- 通道：App 经 mTLS 调 `POST /__dsh_remote/restart`（与 `/__dsh_remote/status` 同一个
  TLS 监听），主机先回 **202**，再在约 1s 后结束 DSH 并重新拉起；
- 怎么拉起：按运行形态自适应 —— **DSH 桌面端**（Electron shell + host 子进程）先直接
  `SIGKILL` 浏览器主进程、再整组清理（**不要先 SIGTERM**：Electron 优雅关闭会先杀 renderer，
  shell 的崩溃处理会弹「应用无法启动或已意外停止」对话框），macOS 用 `open -n <...app>`、
  Windows 用 `start "" "<exe>"`（best-effort）；**Node CLI**（`dsh web`）用当前 `execPath`
  + 原参数重新拉起；
- 桌面端判定：Electron + `@deepseek-ai/dsh-desktop-host/lib/index.js` 入口（或用
  `DSH_DESKTOP_NODE_EXECUTABLE` 标记的启动器）+ 父进程校验（父进程必须是同一个 Electron
  可执行文件）；判不出来返回 501，不会去杀无关进程；
- 只重启**当前 DSH 进程**：不碰 relay / 系统服务 / `~/.dsh` 数据；重新拉起的进程继承当前
  工作目录与环境变量，不做提权；
- 10s 内的重复点击只调度一次（第二次仍回 202，不会重复杀进程）；
- **开关**：`restartHostEnabled`（默认 `false`）；关闭时 App 不显示 ⏻、`POST /__dsh_remote/restart` 返回 501 `host-restart-disabled` 且不调度 helper（审计 `failed/disabled`）。
- 硬杀后 Electron 会留下指向死进程的单实例锁，helper 会先清理陈旧锁再拉起（否则新实例会秒退），
  并用 `ps` 校验应用真的在跑，失败则兜底直接执行 `.app` 内可执行文件；
  排查日志在 `~/.dsh/remote-access/host-restart.log`（不含凭据）；
- 审计：`~/.dsh/remote-access/audit.jsonl` 记 `action: host-restart`、`result: accepted|failed`；
- CI/测试可设 `DSH_REMOTE_DISABLE_HOST_RESTART=1`，端点会返回 501 拒绝执行。

> **组件默认关闭**：需在「设置 → 远程访问 → 组件」开启「允许手机重启主机 DSH」并保存，App 顶栏才会显示 ⏻（关闭状态下重启接口一律 501）。
> **要重启一次 DSH 加载本插件新版本（≥0.1.16）后，该组件才可用**（旧版 Host 半
> 没有该端点，App 会收到 404/501）。首次升级仍建议在电脑上手动重启一次；之后即可远程重启。
> 平台限制：Linux Electron 暂不支持（返回 501）；Windows 的 kill/拉起为 best-effort。
> supervisor 注意：若 `dsh web` 由 launchd（`KeepAlive`，见 `deploy/launchd/`）或 systemd
> （`Restart=`）托管，被杀后 supervisor 自己也会拉起一份，可能与 helper 的重新拉起短暂竞争
> （多起的实例会因端口占用退出，不影响先起的实例）；这类部署更稳妥的做法是在 supervisor 层
> 重启（`launchctl kickstart -k` / `systemctl restart`）。

---

## 2.5 群体服务版（`group` 模式，P1 实验）

> 仅 `feat/group-service` 分支；设计见 [docs/group-service-design.zh.md](../../../docs/group-service-design.zh.md)。

群体版（A 模式）下主机**不持有 TLS / APNs 配置**：relay 边缘终止手机 TLS，主机只做出站隧道；
主机侧在 **loopback 明文 HTTP 代理**上逐请求鉴权。启用方式：`enabled: true` + `groupEnabled: true`。

配置（`~/.dsh/remote-access/config.json`，管理 API 可改）：

| 字段 | 说明 |
|---|---|
| `groupEnabled` | 开启群体版（与 classic 的 relayUrl/hostId/token/证书字段互斥） |
| `groupServiceUrl` | 部署方 relay 服务地址，如 `https://relay.example.com:8443`（POC 允许 `http://`，需 `groupInsecure`） |
| `groupInviteCode` | 一次性邀请码；注册成功后应清空（只用于首次开通） |
| `groupPlainPort` | loopback 明文代理端口（默认 0 = 随机；只被本机隧道客户端连接） |
| `groupInsecure` | 仅 POC：允许 http/ws 与自签证书（生产必须 https/wss） |

流程：

1. 填「服务地址 + 邀请码」→ 主机 `POST /__group/register` 自助注册 → 落盘
   `~/.dsh/remote-access/group.json`（0600）：hostId / hostToken / relayDomain / mobilePort /
   relay token 公钥 / serviceUrl / hostName；
2. 启动后：loopback 明文代理（`127.0.0.1:<groupPlainPort>`）+ 主动连 relay 控制面隧道；
   隧道就绪后自动把本机设备列表（deviceId + P-256 公钥）`device.sync` 给 relay；
3. relay 边缘终止 TLS 后把明文流经隧道交给主机，主机代理逐请求检查：
   - `Host` 必须等于 `<hostId>.<relayDomain>`（否则 421）；
   - cookie `__Host-dsh_session` 必须是通过 relay 公钥离线验签、未过期、hostId 匹配的 token；
   - token 里的 deviceId 必须仍是本机有效设备（撤销设备即失效）；
   通过后才交给 `DshProxy` 反代到 127.0.0.1 DSH（cookie 注入 / deny list / WS 全部复用）。
4. 设备增删/撤销后调用 `syncDevices()`（后续会接到配对/设备管理事件）→ `device.sync` 全量覆盖。

状态：`GET /api/remote-access/status` 的 `group` 段（registered/serviceUrl/hostId/fqdn/mobilePort/connected/plainPort）。

设置页（Client 半）：group 模式下新增「群体服务（实验）」卡片——启用开关、服务地址 + 邀请码、
注册/隧道状态、**注册并连接** / **重置注册** 按钮；classic 的 TLS/APNs 字段在该模式下不生效（有提示）。
管理 API（本机已认证浏览器）：

- `POST /api/remote-access/group/register`（body `{serviceUrl, inviteCode, hostName?}`）→ 注册并连接；
  邀请码一次性，注册成功后会从配置中清空；
- `POST /api/remote-access/group/reset` → 停隧道、删除 `group.json`、关闭群体模式。

设备配对/撤销会自动 `device.sync` 到 relay（`DeviceStore.onChange`）；主机重连时也会全量同步。
**P1 边界**：QR v2（端口/认证模式）与 App token 流程在后续切片接入。

---

## 3. 本机接口

Host 半注册在 DSH 本机 webServer：

| 路径 | 说明 |
|---|---|
| `/__dsh_remote/pair` | 手机配对（mTLS 前的有限例外） |
| `/__dsh_remote/pair/status` | 配对轮询 |
| `/__dsh_remote/status` | 主机状态（mTLS） |
| `/__dsh_remote/devices` | 设备列表/撤销（mTLS） |
| `/__dsh_remote/audit` | 审计（mTLS） |
| `/__dsh_remote/restart` | 远程重启主机 DSH（mTLS，POST，0.1.10+） |
| `/api/remote-access/*` | 本机管理 API（仅本机已认证 DSH 浏览器） |

管理 API 的完整契约见 [`../../docs/ADMIN-API.md`](../../docs/ADMIN-API.md)。
手机访问时会被反代到本机 DSH Web；`/api/remote-access/*` 对远程设备一律拒绝。

---

## 4. 安全边界

- 设备身份只来自 **mTLS 客户端证书**（Secure Enclave / AndroidKeyStore 私钥），
  不信任来源 IP、`X-Forwarded-For` 或自定义头。
- 主机 TLS 在插件内终止；relay 只透传 TLS 字节，不持有主机私钥。
- DSH Web 保持 `127.0.0.1`，插件剥离客户端头并注入本机 session cookie。
- 配对密钥一次性且短时有效；设备可撤销；管理 API 与配对路径有限速/deny list。
- 公网端口只应由 nginx/relay 暴露；不要直接暴露 DSH Web 或插件管理 API。

---

## 4.1 反向代理的 WebSocket 心跳桥（重要）

DSH Web 的 `/api/remote.mux` 每 **2s** 发 Ping，连续 2 个周期没有 Pong 就
`terminate()`。打开大会话时，`session/follow` 的首帧是**数 MB 的历史快照**
（单个 WS text message）；经 relay 慢速下行时 Ping/Pong 被排在这帧后面，
手机根本来不及在 ~6s 内 Pong → DSH 误判失联、踢掉 mux → 前端反复重连
（表现：载入历史很久/失败 + 画面反复跳）。

主机插件的反代因此内置了一个 **WS 心跳桥**（`lib/ws-keepalive.js` +
`lib/proxy.js`）：

1. 先按 `\r\n\r\n` 切出上游 101 响应头，之后才开始解析 WS 帧；
2. 收到 DSH 的 Ping 时立刻替隧道链路回一个 masked Pong（reactive）；
3. 检测到下行拥塞（代理暂停读上游 / 客户端 TLS 写缓冲 >64KB）时，**每秒主动**
   向 DSH 发一个 masked Pong（proactive）——因为拥塞时 Ping 本身被排在
   数 MB payload 后面，等看到 Ping 再回就已经超时；
4. 上游不是 101 时退化为纯字节透传，并记审计 `ws-upgrade-failed`。

安全语义：这只影响「半开 TCP 连接」的心跳清理；真正的客户端断开仍由 socket
close → `upstream.destroy()` 检测，mTLS/鉴权/deny list 全部不变。仅对
`/api/remote.mux` 生效。

> 该修复需要重启 DSH 才会加载新插件代码；手机无需重新配对。
> 相关根因与实验证据：[`docs/diagnostics/00-root-cause.md`](../../../docs/diagnostics/00-root-cause.md)。

---

## 4.2 会话切换的本地缓存（Client 半）

DSH Web 客户端采用引用计数式 retention：切换会话时旧会话实例（历史 + event stream）
会被销毁，切回时重新拉 `session/follow` 的整段快照。本机很快，但手机经 relay 访问时
一个大会话快照可达数 MB，表现为「每次切会话都重新同步」。

插件的 **Client 半**（`client.js`）在手机远程 WebView（`?dsh_mobile=1`）下为**最近
打开过的 3 个会话**额外保留一份客户端 retain：切走不销毁、切回直接复用（0 快照请求、
瞬间渲染），其 event stream 继续接收增量事件；超过 3 个按 LRU 释放；连接断开时只保留
当前会话（避免重连时放大快照流量）。可通过 `globalThis.__DSH_REMOTE_SESSION_CACHE__ = { max }`
调整数量（调试用）。

> 该改动是浏览器 bundle，随插件包由 host 提供：**不需要重新构建 App**；在 App 内刷新/
> 重开页面即可加载（若 DSH 缓存了启动 bundle，需重启 DSH 一次）。
> 另外，手机 WebView 隐藏 ≥10s 再恢复时会主动调用 DSH `connection.reconnect()`，重建
> 连接并重新下发 tail 快照，避免后台挂起造成的旧计时/旧状态与主机不一致
> （阈值可用 `globalThis.__DSH_REMOTE_RESUME_RECONNECT_MS__` 覆盖）。
> 细节与限制见 [`docs/diagnostics/04-session-switch-cache.md`](../../../docs/diagnostics/04-session-switch-cache.md)。

---

## 4.3 手机端历史分片拉取（Client 半，0.1.8+）

DSH 客户端打开会话时 `session/follow` 的窗口是硬编码的
`{ maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }`，大会话一帧可达数 MB
（本机大会话实测 3.5–4.5MB，更极端的更大）。手机弱网下这一帧就是「打开会话要等几秒」。
Host 侧 `paginate()` 返回 `cut..cursor` 的**全部事件**，所以窗口越大帧越大。

手机远程 WebView（`?dsh_mobile=1`）下，插件的 Client 半包装 DSH Client
`SessionEventStream` 的 `repairRequest`（`session/follow` 首屏/重连 tail）与 `readPage`
（`session/page` 翻页/跳转），把**请求窗口**压小，历史交给 DSH 既有「加载更早」按需补齐：

| 场景 | 默认窗口（maxMessages / minMessages / minTurns） |
|---|---|
| 首屏 / 重连 tail | `6 / 3 / 1` |
| 向上翻页「加载更早」 | `10 / 5 / 1` |
| 右侧 turn rail 跳转回填（`loadThrough`，0.1.9+） | `30 / 15 / 2` |

这是**客户端自己发更小的请求**（不是代理改帧）：`address`/`beforeSeq`/`throughSeq`/返回值
全部原样透传，Host 的窗口校验与客户端 `assertPageThrough` 都满足。桌面本机完全不安装；
DSH 版本改了内部方法名时自动降级（只打一条 `console.warn`），不影响主 UI。

右侧 turn rail 点未加载的 turn 时，DSH 用 `Session.loadThrough()` **从当前窗口往回连续回填**
到目标 turn（不是随机定位）——总字节与手动上翻相同、受带宽限制；`jump` 窗口只是把这个
回填过程的串行轮次降下来（10 条/页 → 30 条/页，实测远跳 63 轮 → 24 轮）。

调试覆盖（刷新页面生效）：

```js
globalThis.__DSH_REMOTE_MOBILE_HISTORY__ = {
  open: { maxMessages: 6, minMessages: 3, minTurns: 1 },
  page: { maxMessages: 10, minMessages: 5, minTurns: 1 },
  jump: { maxMessages: 30, minMessages: 15, minTurns: 2 },
  enabled: false, // 关掉分片，恢复 DSH 默认窗口
};
```

诊断：`__DSH_REMOTE_MOBILE_HISTORY_ACTIVE__` 为生效窗口；置
`__DSH_REMOTE_MOBILE_HISTORY_STATS__ = true` 后 `__DSH_REMOTE_MOBILE_HISTORY_LOG__`
记录最近 100 次分页请求/响应（窗口、`beforeSeq`、记录数、耗时），可在手机 Web Inspector 查。

> 生效方式同 §4.2：Host 插件 ≥ 0.1.9 + 重启 DSH；App 无需重新构建。
> 实测量化与限制见 [`docs/diagnostics/09-mobile-history-slicing.md`](../../../docs/diagnostics/09-mobile-history-slicing.md)。

---

## 5. 排障

| 现象 | 检查 |
|---|---|
| 中继离线 | relay 8443 可达？token/hostId 正确？relay `/healthz` hosts 列表有该 hostId？ |
| 手机 401/403 | 设备证书是否签发/未撤销？主机证书是否过期？ |
| 配对二维码过期 | 重新生成；配对密钥 ≤120s |
| 证书续期不生效 | 插件每小时检查；关闭再启用强制重载 |
| 手机打开管理 API 403 | 这是安全边界；远程设备不允许管理 relay/配对 |
| App 扫描后“网络连接失败” | 先重新生成二维码；确认 host 带 `:端口`；再查 `*.relayDomain` 泛解析、手机代理/VPN、云安全组、主机数据面证书 SAN |
| 设置里 publicPort 又变回 0 | Host 半还是旧代码；重启 DSH；确认 `~/.dsh/remote-access/config.json` 有 `publicPort` |
| 主机在线但 App 连不上 | 控制面 8443 和数据面不是一条链路；看 [server/README.md §9.2](../../../server/README.md#92-主机显示在线但-app-配对网络连接失败) |
| 打开大会话「载入历史」很久/失败、画面反复跳 | ① 插件是否已重启加载新代码（旧代码没有 WS 心跳桥，慢链路上 mux 会被 DSH 心跳误杀）；② 手机 WebView 是否加载了历史分片（≥0.1.8，控制台应有 `[dsh-remote] mobile session history window:`）；③ relay 带宽/线路是否过慢；详见 [`docs/diagnostics/09-mobile-history-slicing.md`](../../../docs/diagnostics/09-mobile-history-slicing.md)、[`00-root-cause.md`](../../../docs/diagnostics/00-root-cause.md) |

---

## 6. 相关文档

- [relay / 服务器部署](../../../server/README.md)
- [完整部署指南（DNS-01/acme.sh/运维）](../../docs/DEPLOY.md)
- [管理 API](../../docs/ADMIN-API.md)
- [根目录 README](../../../README.md)
