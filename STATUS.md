# DSH Remote Access — 项目状态 / 验收清单

快照：2026-10-19（实施第 14 轮）· 方案：**B2（自托管盲中继 + 设备 mTLS + 自建域名）**

## 一句话

POC 与 MVP 的**代码、文档、测试、部署产物、本地端到端验收均已完成**；
剩余 3 项需要外部环境：**iOS 真机验收（需 Xcode/iPhone）、Android 编译（需 Android SDK）、生产 relay 上线（需 VPS+域名）**。

## 2026-10-27 修复：应用内通知卡片停留时间 5s → 20s

- **现象**：跨会话推送的应用内卡片只停留 5 秒，来不及点就自动消失。
- **修复**：`App.tsx` 的自动消失常量改为 `20_000ms`（锁屏时仍立即清除避免内容泄露）；
  系统通知不受影响。
- **验证**：`tsc --noEmit` / `check:native` / `check:shell`；iOS Release **0.1.13 (build 15)**
  构建并安装到真机；**待用户实测确认**后再提交。
- **生效**：App 0.1.13（本机已安装）；Host 无需改动/重启。

## 2026-10-26 新增：等待用户回答（ask_user_question）时推送

- **需求**：Agent 调用 `ask_user_question` 等待用户作答时，也发推送提醒；标题用会话名，
  正文固定为「正在等待你的回答」。
- **实现**（host-plugin `lib/push.js`，只改 Host 半）：
  - 在现有 `session/event` 监听里识别 `tool/call` 且 `data.name === 'ask_user_question'`；
  - 标题复用会话摘要 tracker（最新 `session/title`，无则首条用户消息），正文固定
    `正在等待你的回答`；payload 仍带 `sessionId`/`host`，点击通知可直接跳到对应会话；
  - 与 `turn/end` 的 30s 冷却**相互独立**（问答常常紧接上一轮结束后发生，不能被吞掉）；
  - 按 `callId` 去重：事件流重连/重放不会重复推送；子代理会话、关闭推送时跳过；
  - 旧 `pushProvider=expo` 通道仍只能发 relay 通用文案（relay 侧无会话内容）。
- **验证**：host `npm test` **159/159**（本机全量，含工作区其它未提交改动；本次新增
  `ask_user_question` 推送用例：标题/正文、同 callId 去重、新 callId 再推、turn/end 冷却期
  内仍推送、子代理/关闭推送跳过）；`validate:artifacts` 通过。**真机问答推送待验收**
  （需重启 DSH 加载 Host 半）。
- **生效**：host-plugin 重启 DSH 后生效；App 无需重新安装（通知跳转沿用现有 0.1.5+ 逻辑）。
- **版本**：工作区已有其它会话的 host-plugin `0.1.14` 未提交改动，本次未再 bump 版本号，
  合并时建议统一递增（如 0.1.15）。

## 2026-10-26 新增：App 隐藏「在主机本机打开」入口 + 远程「重启主机 DSH」（App 0.1.11 build 13 / host-plugin 0.1.10）

- **需求**：① 手机 App 上「打开工作区 / 在文件夹中显示」实际是在**主机**的 Finder/本地应用打开，
  对 App 无作用，隐藏；② App 加「重启主机客户端」，装插件/改完功能后不必回电脑手动重启 DSH。
- **需求 1 做法**：DSH 核心插件 `@deepseek-ai/dsh-client-ui-open-in-app` 在会话头/右栏用稳定
  `data-*` 属性渲染「打开 / 显示文件位置」控件；App 注入手机壳 CSS（`mobileWebShell.ts`，只注入
  App 的 WebView，桌面 DSH 不受影响）按这些属性 `display:none`。不整段隐藏 `[data-slot]`
  （同槽位还有定时任务/session 导出等按钮）；规则与宽度无关（iPad 也隐藏）。
- **需求 2 做法**：
  - host-plugin 新增 `POST /__dsh_remote/restart`（设备 mTLS，与 `/status` 同一监听）：先回 202，
    再由 detached helper 等 ~1s → `SIGTERM` 当前 DSH pid（~10s 未退则 `SIGKILL`）→ 重新拉起。
    按运行形态自适应：macOS Electron `open -n <...app>`、Windows Electron `start "" <exe>`
    （best-effort）、Node CLI `execPath + argv.slice(1)`；10s 内重复请求去重；每次请求写审计
    `host-restart`；`DSH_REMOTE_DISABLE_HOST_RESTART=1` 可禁用（501）。
  - App 顶栏新增 ⏻「重启主机」：二次确认 → mTLS POST → 202 后轮询 `/__dsh_remote/status`
    （1.5s × 最多 30s）→ 恢复后自动 reload；405/501/403/超时均有可读提示，等待期间可退出取消。
  - 详设与安全评审见 [`docs/diagnostics/10-mobile-host-actions.md`](docs/diagnostics/10-mobile-host-actions.md)、
    契约见 [`dsh-remoteService/docs/ADMIN-API.md`](dsh-remoteService/docs/ADMIN-API.md) §2。
- **安全**：身份仍只认设备 mTLS；配对设备本来就拥有完整 DSH 控制权（可让 Agent 执行命令），
  重启不是新提权面；只杀当前 DSH 进程、不碰 relay/系统服务/`~/.dsh` 数据、不做提权；有审计与禁用开关。
- **验证**：
  - Host：`npm test` **153/153**（新增 25 项：重启 plan/shell quoting/pending helper/禁用开关/去重/
    真实 mTLS 端点 202+405+403/审计）；`validate:artifacts` 通过。另用**自建 dummy 进程**实测了
    kill + relaunch 脚本与「父进程被 SIGTERM 后 detached helper 仍存活」——没有真的重启本机 DSH。
  - App：`tsc --noEmit` / `check:native` / `check:shell`（**57/57**，新增 5 项 open-in-app 隐藏断言，
    宽屏/iPad 也验证）全绿。
  - 真机：iOS Release **0.1.11 (build 13)** 已构建并使用设备描述文件安装到已配对
    **iPhone 17 Pro Max / iOS 27.0**，`devicectl` 启动成功、截图确认 App 正常；WebView 内的
    交互项（⏻ 按钮、隐藏效果）本环境无 UI 自动化，需人工确认（ACCEPTANCE #32/#33）。
- **生效**：App 需重新安装 0.1.11（本机已装）；**host-plugin 0.1.10 仍需重启一次 DSH 才加载**——
  因此 `⏻` 按钮在旧 Host 半上会返回 404/501（App 有可读提示）；首次升级在电脑上手动重启一次后，
  之后即可用按钮远程重启（功能自举问题，已在文档注明）。
- **限制**：Windows 重启路径 best-effort（无 Windows 本机验证）；Linux Electron 返回 501；
  supervisor 托管的 `dsh web` 建议在 supervisor 层重启（已写入文档）。

## 2026-10-26 补充：手机端历史分片支持右侧 turn rail 跳转（host-plugin 0.1.9）

- **问题**：分片后 `session/page` 一律 10 条/页，右侧 turn rail 点「未加载的中间 turn」时
  （DSH `Session.loadThrough` 会从当前窗口**连续回填**到目标）会拆成几十次串行请求；
  需要确认「点进度条跳中间」是否还能用、并削掉这部分轮次。
- **结论**：能点、能跳，但**不是 QQ 式随机定位**——客户端窗口必须连续，所以「点中间」=
  把当前位置到目标之间的历史全部拉下来（总字节与手动上翻相同，远跳仍受带宽限制）。
- **改动**：0.1.9 给跳转单独窗口 `jump: 30 / 15 / 2`（按 `JUMP_PAGE_OPTIONS.minMessages=200`
  识别，普通翻页仍 `10 / 5 / 1`；可用 `__DSH_REMOTE_MOBILE_HISTORY__` 覆盖）。
  实测同一次跳转总字节不变、轮次约为原来的 1/3：99MB 会话跳 turn 60 → **63 轮 → 24 轮**
  （单帧 max 756KB → 2.2MB；原版 3 轮但单帧 14.4MB）；近距跳转仍 1–2 轮到达。
- **验证**：`npm test` **128/128**（client-smoke 更新：跳转窗口/识别阈值/统计 kind=jump）；
  `validate:artifacts` 通过；离线用真实会话日志按 Host `paginate` 规则复算轮次/字节（见 09 文档 §4.1）。
- **生效**：Host 插件 **0.1.9**，重启 DSH 后生效；App 无需重新构建。
- **限制**：远距离跳转的耗时以带宽为主（例：99MB 会话跳一半 ≈ 30MB 回填），要 QQ 式
  「只拉中间那段」需要 DSH/Host 的随机窗口支持（T1.1/上游范围，本次未做）。
- **相关**：[`docs/diagnostics/09-mobile-history-slicing.md`](docs/diagnostics/09-mobile-history-slicing.md) §4.1

## 2026-10-27 更新：远程重启主机真机可用（host-plugin 0.1.14）+ App 两处隐藏经用户确认

- **远程重启**：0.1.10 → 0.1.14 连续四轮真机问题全部修复——① 只杀 host 子进程触发崩溃弹窗 +
  双实例（0.1.11）；② 桌面端识别依赖了实际不存在的 `DSH_DESKTOP_NODE_EXECUTABLE`（0.1.12）；
  ③ 整组 `SIGTERM` 让 Electron 先杀 renderer、弹「应用无法启动或已意外停止」（0.1.13）；
  ④ 硬杀残留的 Electron 单实例锁让新实例 ~80ms 内自杀（0.1.14，现象「关掉但没拉起」）。
  0.1.14 在拉起前清理属主已死的 `SingletonLock/Cookie/Socket`，`open -n` 后用 `ps` 校验、
  失败则直接执行 `.app` 内可执行文件兜底，全程写 `~/.dsh/remote-access/host-restart.log`。
  用户 2026-10-27 实测确认：点 ⏻ 后 DSH 窗口关闭、无弹窗、自动拉起、App 自动恢复。
- **App 隐藏**：左侧抽屉「工作区」`＋` 添加工作区按钮隐藏已由用户确认（App 0.1.12 build 14 起，
  iPad 宽度同样隐藏）；open-in-app「打开 / 显示文件位置」控件用户反馈在 App 上不可见
  （原本也未注意该控件）。`check:shell` 59/59 覆盖窄屏/宽屏隐藏与同 slot 按钮保留。
- **验证**：host `npm test` **159/159**、`validate:artifacts` 通过（含并行会话已提交的推送改动）；
  本机用临时 HOME + 自建 dummy 进程组验证杀进程组 / 拉起校验 / 直接执行兜底 / 陈旧锁清理，
  全程不触碰真实 DSH；App `tsc --noEmit`、`check:native`、`check:shell` 均通过。
- **版本 / 生效**：host-plugin **0.1.14**（含 `ask_user_question` 推送）；App 工作区版本
  **0.1.13 build 15**（含本轮隐藏修复，由并行会话推进版本）。host 半需重启 DSH 后生效。
- 根因与逐轮排查记录见 [`docs/diagnostics/10-mobile-host-actions.md`](docs/diagnostics/10-mobile-host-actions.md)
  §2；逐轮细节整理见并行会话的 `docs/diagnostics/11-host-restart-relaunch.md`（尚未提交）。

## 2026-10-26 新增：手机端会话历史分片拉取（host-plugin 0.1.8，todo T1）

- **目标**：手机 App（远程 WebView，`?dsh_mobile=1`）打开会话时只拉最近一小段历史，
  往上翻再一页页补，不再「打开就整段拉」——大会话在弱网下首帧数 MB、打开要等数秒。
- **根因**：DSH 客户端打开会话时 `session/follow` 的历史窗口是硬编码的
  `{ maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }`；本机大会话实测单帧
  3.5–4.5MB，更极端的会话更大（本机 30 个大会话离线复算：首帧 p50 7.5MB / max 22.9MB）。
  手机弱网下这条大帧就是「载入历史很久」本身。
- **做法**（`dsh-remoteService/packages/host-plugin/client.js`，Client 半）：
  只在 `?dsh_mobile=1` 下包装 DSH Client `SessionEventStream` 的 `repairRequest`
  （`session/follow` 首屏 + 重连 tail）与 `readPage`（`session/page` 翻页/跳转），把**请求窗口**
  压到手机预算（默认首屏 `6 / 3 / 1`、翻页 `10 / 5 / 1`），其余字段与协议语义不变；
  历史靠 DSH 既有「加载更早」/ `loadThrough` 按需补齐。桌面本机完全不装。
  可用 `globalThis.__DSH_REMOTE_MOBILE_HISTORY__` 覆盖窗口 / `enabled:false` 关闭；
  生效窗口挂在 `__DSH_REMOTE_MOBILE_HISTORY_ACTIVE__`，置 `__DSH_REMOTE_MOBILE_HISTORY_STATS__ = true`
  可记录最近 100 次分页请求/响应规模（手机 Web Inspector 里可查）。
- **为什么不是代理改帧**：代理重写 `session/follow` 请求帧属于协议 MITM，且客户端
  `assertPageThrough` 要求快照末尾等于 cursor；本方案是**客户端自己发更小的请求**，
  请求与响应两侧语义一致，Host 的 `maxMessages`/`turnWindow` 校验与客户端断言都满足
  （见 [`docs/diagnostics/09-mobile-history-slicing.md`](docs/diagnostics/09-mobile-history-slicing.md)）。
- **验证**：`npm test` **128/128**（新增 client-smoke 4 项：窗口压缩/幂等与恢复/桌面不装与降级/配置兜底）；
  `validate:artifacts` 通过；离线把补丁打到**从已安装 DSH 解包出来的真实
  `dsh-api-session-controller` Client 模块**上，确认 `repairRequest`/`readPage` 几何形状、
  参数透传与卸载恢复都符合预期；用真实会话日志按 Host `paginate` 规则离线复算首帧/翻页字节：
  30 个大会话首屏 p50 **7.5MB → 362KB**、p90 436KB、max 559KB（`300KB/s` 下约 1.2s，
  原 p50 约 25s）；翻页单页 median 540KB（原 p50 max 7.1MB）。
- **生效**：Host 插件 **0.1.8**，重启 DSH 后加载新 Client 半；App 无需重新构建，
  在 App 内刷新/重开 WebView 即可（若 DSH 缓存启动 bundle 则重启 DSH 一次）。
- **未做真机实测**：本环境没有手机 WebView/浏览器自动化，且未重启用户 DSH（不擅自打断
  用户会话）——真机验收步骤见 [`docs/diagnostics/09-mobile-history-slicing.md`](docs/diagnostics/09-mobile-history-slicing.md) §7；
  上线时按「重启 DSH → App 内刷新/重开 WebView → 打开大会话」确认。
- **已知限制**：单条消息/单个 turn 本身可能很大（工具结果、request header），分片只能缩小
  「一次拉多少条消息」，无法把一条消息拆开；极大会话仍可能遇到单帧 >1MB。首屏 6 条消息
  为手机一屏左右的量，小会话（历史不足 6 条）行为不变。
- **相关**：[`docs/diagnostics/09-mobile-history-slicing.md`](docs/diagnostics/09-mobile-history-slicing.md)、
  [`docs/diagnostics/01-dsh-heartbeat.md`](docs/diagnostics/01-dsh-heartbeat.md) §3.3

## 2026-10-26 修复：Windows 主机无 openssl 时 EC 设备 CSR 配对失败（host-plugin 0.1.7）

- **现象**：第二台主机（Windows）扫码配对返回 `invalid_request`：
  `CSR 解析失败（forge: Cannot read public key. OID is not RSA.; openssl: … spawnSync openssl ENOENT）`。
- **根因**：iOS Secure Enclave 设备密钥是 EC P-256（`ecdsa-with-SHA256` CSR），node-forge
  只支持 RSA；原实现用系统 `openssl` 兜底，而 Windows 默认没有 openssl → 两条路都失败。
  与 hostId/token/端口/证书无关（请求已到主机插件、TLS 正常）。
- **修复**：
  1. 新增 `lib/ec-csr.js`：纯 JS（`node:crypto` + `forge.asn1`）解析 PKCS#10、校验自签名、
     构造 X.509 v3 证书并用设备 CA（RSA）以 SHA-256 签名；签发后自检链/公钥/serial；
  2. `identity.js` 引擎选择：RSA → forge；非 RSA → **优先 openssl**（行为不变）；
     openssl 不可用（ENOENT/ENOTDIR/EACCES/EPERM）→ 回退纯 JS；openssl 明确拒绝时**不回退放行**；
     openssl 通过后只要 CSR 能被纯 JS 解析，还会用 node:crypto 再独立复核一次自签名；
     回退会在日志/审计标 `engine=js`；EC 设备公钥指纹改为 SPKI 的 SHA-256（与 RSA 语义一致）；
  3. 新增 `lib/tls-check.js`：启动监听前检查证书/私钥是否成对（`checkPrivateKey`，RSA/EC 都支持）
     与 SAN 是否覆盖 `<hostId>.<relayDomain>`，失败原因写进管理页「最近错误」——
     避免手机端只看到「无法连接」。
- **「证书与密钥不匹配」误报**：EC 证书用 `openssl x509/rsa -modulus` 比对必然失败
  （`No modulus for this public key type` / `Not an RSA key`），不等于不匹配；
  本机（macOS）实测证书与私钥公钥 SHA-256 相同、`checkPrivateKey()=true`、SAN 匹配、
  relay 连接 ESTABLISHED。正确比对方式与排查步骤见 host-plugin README。
- **验证**：`npm test` **124/124**（新增 EC CSR 纯 JS 回退 14 项、TLS 自检 7 项、
  EC 配对集成 1 项、service 级 2 项；含假 openssl 的 fail-closed 用例）；`validate:artifacts` 通过；纯 JS 签发证书经 `openssl verify`
  独立验链通过；`PATH=''` 模拟无 openssl 跑通校验+签发；篡改签名/SPKI 与签名密钥不匹配的
  CSR 均被拒绝；另用 `poc/native-csr/gen-csr.swift`（与 App 同一实现）生成的真实 Apple 路径
  CSR 在两种引擎下均通过、纯 JS 签发证书验链与公钥一致。详情：[`docs/diagnostics/08-host-ec-csr-windows.md`](docs/diagnostics/08-host-ec-csr-windows.md)。
- **生效**：更新 DSH 里的 remote-access 插件到 **0.1.7+** 并**重启 DSH**；Windows 无需安装
  openssl（装了则优先使用）；现有主机证书/私钥无需重签。

## 2026-10-26 修复：主机设备列表清理 + App 解除配对入口合并（App 0.1.9 / host-plugin 0.1.6）

1. **主机侧「已配对设备」列表无法删除已撤销设备** → host-plugin `DeviceStore.remove()` +
   本机管理 API `POST /api/remote-access/devices/:id/delete` + 桌面 DSH 设备卡片「删除」
   按钮（二次确认）；只允许删除**已撤销**设备（有效设备返回 409 `device-active`，需先撤销），
   同时清理该设备的推送 token 并写审计 `device-delete`。远程隧道 API 不开放删除。
2. **App「删除本机配对记录」与「清除本地凭据并重新配对」功能重复** → 「设备与安全」页只保留
   单一「解除本机配对 / 删除本机配对记录」入口（确认框 → 删除记录并返回主机列表；没有其它
   主机时进入扫码页）；想重新连接同一主机时从主页「＋ 配对新主机」重新扫码。移除重复的
   “重新配对”按钮与 App 侧 `onRepair` 分支。

**验证**：
- host-plugin：`npm test` **101/101** 通过（新增 admin 删除接口 3 项 + 设备列表删除按钮
  smoke 1 项）；`npm run validate:artifacts` 通过；
- App：`tsc --noEmit` / `check:native` / `check:shell`（49/49）通过；iOS Release **0.1.9 (build 11)**
  真机构建 + 安装，设备与安全页只剩单一解除入口（ACCEPTANCE #31）。
- 主机插件改动需**更新 DSH 里的 remote-access 插件并重启 DSH** 才会在桌面 UI 出现删除按钮。

## 2026-10-26 修复：主机记录管理 / 主机名同步 / 系统设备名（App 0.1.8 build 10）

用户反馈 4 个问题，全部已在真机（iPhone 17 Pro Max / iOS 27.0）修复并验证：

1. **删除配对记录只能走「重新配对」** → 主页每台主机新增独立「删除」入口（确认框；只清本机
   配对记录与设备证书，不进入扫码流程）；「设备与安全」页也新增「删除本机配对记录」。主机侧
   设备记录仍需在桌面端单独撤销。
2. **主机改名后手机不同步** → 回到主页 / 回前台时用 mTLS 请求 `/__dsh_remote/status` 同步
   `hostName`（串行切换原生 identity；不并发）。真机验证：桌面改名 → 重启 App → 标题更新。
3. **配对默认设备名不是系统设备名** → 新增 `expo-device`，配对页默认预填系统本机设备名
   （iOS 若只返回通用名则回退机型名；Android 用 `Settings.Global.DEVICE_NAME`）；用户仍可
   自定义，旧版本写死的「我的 iPhone」不再沿用。
4. **主机侧撤销后本机记录无法删除** → 同步检测到主机拒绝设备证书（HTTP 401/403，或 iOS
   在 TLS 阶段报 `requires a client certificate`）时给记录标 `revokedAt`，主页显示红色警示
   （含撤销时间）并可直接删除本机记录。

**顺带修复（真机验收发现）**：删除最后一条 v2 配对记录后，`loadConnections` 会回退读到旧版
v1 单连接记录，把早已删除的旧主机「复活」。现 v1 读取时一次性迁移到 v2 并删除 v1；所有 v2
写入也会清理 v1。真机验证：删除后进入配对页、旧记录不再出现。

**验证**：`tsc --noEmit`、`check:native`、`check:shell`（49/49）通过；iOS Release 0.1.8 (build 10)
真机构建 + 安装 + 逐步验收（改名同步 / 删除 / 撤销警示 / 重新配对，ACCEPTANCE #25–#30 ✅）。

**生效**：App 需重新构建原生包（新增 `expo-device`）；主机侧无需改动。

## 2026-10-26 修复：点「展开其余 N 个会话」会把左侧抽屉收起

- **现象**：手机 App 左侧抽屉里点「展开其余 N 个会话」（或「收起」）时，抽屉被一起收掉，
  看不到展开结果。
- **根因**：注入手机壳（`mobileWebShell.ts`）的侧栏点击处理只对工作区行
  （`data-row-key^="workspace:"`）保持抽屉打开，其它侧栏内点击一律 `closeDrawer()`；
  而这个控件是 DSH `dsh-client-ui-workspace` 的溢出按钮
  `<button data-row-key="overflow:<workspaceId>">`，只是展开/收起侧栏内容，不是导航。
- **修复**：保持打开的判定加上 `[data-row-key^="overflow:"]`；会话行仍点击即收起抽屉
  并进入会话。
- **验证**：`check:shell` fixture 增加工作区行/会话行/overflow 按钮三类真实行，新增
  3 项断言，**52/52** 通过；用修复前注入壳跑同一套 **1/52 失败**（正好命中该回归）；
  `tsc`、`check:native`、服务端 124 测试、`validate:artifacts` 通过。
- **生效/版本**：纯 JS 注入壳；App **0.1.10 (build 12)** 已构建安装真机验证
  （ACCEPTANCE 第 25 项 ✅）。

## 2026-10-25 调整：主界面顶栏只显示主机 ID；Release 去掉底部连接信息条

- **顶栏**：标题仍显示主机名；副标题由「已连接 · <hostId>.<relayDomain>[:port]」改为
  「已连接 · <hostId>」（只保留主机 ID，不再显示完整 relay 域名与端口；直连 IP 保留 IP）。
  完整地址仍在主页卡片 / 设备与安全页可查。
- **底部连接信息条**：只在 **Debug 构建**保留（页面标题 + 当前 URL，开发诊断用）；
  **Release 构建不渲染**，高度让给主界面 WebView，底部改由 `webviewWrap` 预留
  `safe-area-inset-bottom`，避免内容压到 home indicator。
- **验证**：`tsc` / `check:native` / `check:shell` 通过；Release **0.1.7 (build 9)** 已构建安装并真机目视：
  副标题只显示主机 ID、Release 无底部信息条/黑边、页面背景连续、输入框未被 home indicator 遮挡
  （ACCEPTANCE 第 23/24 项 ✅）。
- **版本**：本任务最终构建 **0.1.7 (build 9)**（`package.json` / `app.json` / Android
  `build.gradle` 同步，iOS Info.plist 已同步）；另一会话已推送的 0.1.6 (build 7) 保留不动。
  同一任务多次构建跳过版本号、只递增构建号（8 → 9）。

## 2026-10-25 修复：手机端账号页「查询用量 / 充值 / 意见反馈」点击无反应

- **现象**：设置 → 账号与余额里点「更多 → 查询用量 / 充值 / 更多账号信息」，以及账号菜单
  「意见反馈」，在 App 里完全没有反应。
- **根因**：这些入口依赖打开新页面 —— 桌面 DSH 由 Electron 的 `dshPlatform` 桥打开内嵌
  平台页，浏览器里是 `<a target="_blank">` 新标签页；而 App 的原生 mTLS WebView 没有
  新窗口能力（iOS 无 `WKUIDelegate`，Android `setSupportMultipleWindows(false)` 且未处理
  `onCreateWindow`），点击被 WebKit 直接丢弃。不是页面被隐藏，也与安全 deny list 无关。
- **修复**（`mobileWebShell.ts` + `WebViewScreen.tsx` + 新增 `ExternalPageScreen.tsx`）：
  - 注入壳拦截外链锚点与 `window.open` 的 http(s) 地址，通过现有桥上报
    `dsh-remote/open-external`；
  - App 校验只放行 http(s)、拒绝隧道主机（没设备证书），在 **App 内嵌浏览器**
    （react-native-webview 全屏覆盖层：返回/刷新/在浏览器打开、底部 URL）里打开，
    等价桌面 DSH 的内嵌平台页；同源/非 http(s) 链接保持原样；
  - 左上返回始终关闭内嵌页回 DSH（平台页 pushState 不会把按钮卡住），Android 返回键同样；App 锁屏时自动关闭内嵌页。
- **验证**：`check:shell` 新增 3 项断言（锚点拦截、同源不拦截、window.open 拦截），
  **49/49** 通过；删掉锚点拦截 / window.open 拦截的两个 mutant 各 **1/49** 失败；
  旧注入壳 19/49 失败。`tsc --noEmit`、`check:native`、服务端 97 测试通过。
- **生效**：纯 JS（react-native-webview 已在原生工程链接，无需重建原生）。
- **真机验证**：2026-10-25，iPhone 17 Pro Max / iOS 27.0 / 0.1.5 build 6（Release，
  `xcodebuild` + `devicectl`）：账号页外链在 App 内嵌浏览器打开、左上返回关闭回 DSH、
  `↗` 切系统浏览器、关闭 App 重开后登录态仍在（ACCEPTANCE 第 22 项 ✅）。详情：[`docs/diagnostics/07-mobile-external-links.md`](docs/diagnostics/07-mobile-external-links.md)。

## 2026-10-25 修复：手机端设置页太挤（全屏 + 分区菜单抽屉）

- **现象**：App 里从左侧栏进入「设置」后，设置保持桌面端左右布局（左菜单 188px +
  右内容），390px 宽手机上内容区只剩 **154px**，表单/说明挤成竖排。
- **根因**：DSH 的设置是 body portal 的居中 modal（panel 800 / `max-width:calc(100vw-48px)`，
  左 nav 固定 188px），手机宽度下内容列被压到 154×742。
- **修复**（`dsh-remoteApp/src/lib/mobileWebShell.ts`，纯注入壳，不改 DSH 源码）：
  - 窄屏（≤760px）设置 panel 固定铺满 WebView；
  - 左分区菜单变成左侧离屏抽屉（`min(86vw, 320px)`）：菜单按钮 / 左缘右滑打开，
    点分区项 / 点抽屉外 / 左滑收起，点抽屉外会吞掉点击避免误触设置控件；
  - 内容区顶部注入手机栏：**左上返回**（调 DSH 原生 close 退出设置）、标题（取
    DSH `settings.header` 文案）、右侧菜单按钮；原生 header 隐藏；
  - 状态类 `html.dsh-settings-mobile` 只在装上手机栏后才生效，识别失败时退化为
    DSH 原生居中 modal（不会白屏/锁死）；>760px 继续走 DSH 原生布局。
- **验证**：`check:shell` 设置 fixture 共 **26 项断言**（23 项设置手机壳 + 3 项外链），
  全套 **49/49** 通过；同一 fixture 用旧注入壳跑 **19 项失败**并复现 `panel 342×796 / 内容 154×742`；
  另用 2 个 mutant（删 nav / close 缓存重解析）确认新断言能抓住回归；
  `tsc --noEmit`、`check:native` 通过。
- **生效**：纯 JS（注入壳），**无需重建原生包**，App 版本不变（0.1.5 build 6）。
- **真机验证**：2026-10-25，iPhone 17 Pro Max / iOS 27.0 / 0.1.5 build 6（Release，
  `xcodebuild` + `devicectl`）：全屏、抽屉、分区切换、左上返回、横竖屏切换通过
  （ACCEPTANCE 第 21 项 ✅）。
- 详情与效果示意：[`docs/diagnostics/06-mobile-settings-drawer.md`](docs/diagnostics/06-mobile-settings-drawer.md)。

## 2026-10-25 修复：手机端「载入历史很久/失败 + 画面反复跳」

- **根因**：DSH `/api/remote.mux` 心跳（2s Ping、2 个周期无 Pong 即 terminate）与
  relay 慢速下行冲突——打开大会话时 `session/follow` 首帧是 ~4MB 历史快照，
  Ping/Pong 被排在其后，DSH 在 ~6s 误杀 mux，前端反复重连（画面跳）。
  另发现主机→relay 二进制帧在背压下会**乱序**（TLS 密文损坏）。
- **修复**（`dsh-remoteService/packages/host-plugin`）：
  - `lib/ws-keepalive.js`（新）：WS 帧增量扫描 + masked Pong 构造；
  - `lib/proxy.js`：101 响应头先切分再扫描；Ping→即时 Pong；拥塞时每秒主动
    Pong；非 101 记审计并退化透传；
  - `lib/connector.js`：发送队列严格 FIFO + 本地 socket 背压。
- **验证**：`npm test` 73/73；`poc/heartbeat-verify.js` + `poc/heartbeat-runner.js`
  在真实 DSH/真实设备证书/限速链路下端到端对照（旧代码 600KB/s 下 4.6s 被踢，
  新代码 300KB/s 下 13.7s 大帧仍完整、连接存活）。
- **生效**：Host 插件版本 **0.1.1**（重启 DSH 生效，手机无需重新配对）；App 版本 **0.1.2 (build 3)** 需重新构建原生包（含一个修复：`configuration.preferences.isInspectable` 的 pre-existing 编译错误，否则下次 iOS rebuild 会失败）。
- 详情：[`docs/diagnostics/00-root-cause.md`](docs/diagnostics/00-root-cause.md)。

## 2026-10-25 修复：会话切换重复同步（本地缓存 + 差异更新）

- **现象**：手机 App 里每次切换会话都要重新同步（大会话数秒，像重新加载）。
- **根因**：DSH Web 客户端的 retention 模型——切走会话即销毁 Session 实例（历史 +
  event stream），切回新建实例并重拉 `session/follow` 的整段快照；经 relay 时一个大会话
  快照 3.5–4.5MB（协议也没有 cursor 续传参数，重连至少重拉当前会话 tail 快照）。
- **修复**（`dsh-remoteService/packages/host-plugin/client.js`，Client 半）：
  - 仅在手机远程 WebView（`?dsh_mobile=1`）下为最近打开的 3 个会话保留额外 retain：
    切走不销毁、切回 0 请求瞬间恢复，event stream 继续做增量更新；
  - 超过 3 个 LRU 释放；连接断开时只保留当前会话，避免重连放大快照流量；
  - 会话删除/归档时释放缓存；服务缺失时静默降级。桌面本机不启用。
- **验证**：`npm test` 全量通过（新增 client-smoke 缓存测试）；另有 headless-Chrome
  端到端测量（见 `docs/diagnostics/04-session-switch-cache.md`）。
- **生效**：Client bundle 由 host 提供，**App 无需重新构建**；在 App 内刷新/重开页面即可，
  若 DSH 缓存启动 bundle 则重启 DSH 一次。
- 详情：[`docs/diagnostics/04-session-switch-cache.md`](docs/diagnostics/04-session-switch-cache.md)。

## 2026-10-25 新增：自托管 APNs 推送（方案 A）

- **目标**：iOS 推送不再依赖 Expo 云 / EAS projectId；主机插件用自己的 APNs Auth Key
  直接调 Apple，relay 完全不参与推送，也看不到推送 token。
- **链路**：DSH `turn/end` → host `lib/apns.js` → APNs → iPhone；主机会按 App 注册时上报的
  `aps-environment` 自动选择 `api.sandbox.push.apple.com`（开发签名包）或
  `api.push.apple.com`（发布签名包）。
- **实现**：
  - host-plugin 新增 `lib/apns.js`（`node:http2` + `node:crypto`，零新依赖）：ES256 provider
    JWT（raw r||s，缓存 50min）、`apns-topic/push-type/priority`、410/BadDeviceToken 自动
    清理、错误分类；`pushProvider: apns|expo` 分流，旧 relay→Expo 通道保留为可选。
  - 通知内容取自实际会话（`lib/push-summary.js`）：**标题 = 最新会话标题（无则首条用户消息）；
    正文 = 本轮最后一条助手回复的截断摘要**（失败加 `⚠️`，无文本时状态兜底）；不再使用固定
    「DSH/有任务需要你」文案。标题最多 60 字符、正文 160 字符。
  - App：`getDevicePushTokenAsync()` + `getIosPushNotificationServiceEnvironmentAsync()`，
    经原生 mTLS 注册 `{provider:"apns", token, environment}`；`expo-application` 提为直接依赖。
  - 设置页新增：自托管直连 APNs 开关、私钥路径 / Key ID / Team ID / Topic。
  - `POST /__dsh_remote/push-token` 校验 APNs token（64 位 hex）与环境；每设备只保留最新
    token；APNs 返回 **410 / Unregistered** 时清理失效 token（`BadDeviceToken` /
    `DeviceTokenNotForTopic` 视为 topic/环境配置错误，不删 token）。
- **验证**：`npm test` **97/97**；`npm run validate:artifacts`；`npx tsc --noEmit`；
  `npm run check:native`；`npm run check:shell`。
- **生效**：本批次统一为 Host 插件 **0.1.5**（重启 DSH 后生效）；App **0.1.5 (build 6)**
  需重新构建安装/重载（本批次含原生能力；最终说明见文末 0.1.5 条目）。
- **隐私**：通知标题/正文会进入 APNs payload、可能显示在锁屏（并经过 Apple 推送网络）；
  介意的话关闭推送或隐藏锁屏预览。
- **待完成（需外部环境）**：把 APNs `.p8` 放到主机并填好设置 → 真机推送验收
  （`dsh-remoteApp/docs/ACCEPTANCE.md` §5）。key 建议 Environment 选 **Sandbox & Production**：
  只选 Sandbox 的 key 只能发开发包，上架/Ad Hoc 前需要覆盖生产环境。

## 2026-10-25 新增：App 设置页 + 前台应用内通知 + 清理缓存

- **前台通知策略**：新增「应用内通知」开关（默认开）。App 在前台收到推送时不再弹系统
  横幅，改为顶部应用内卡片（5s 自动消失，点击可打开主机）；关闭开关则前台恢复系统横幅。
  后台/锁屏仍由 iOS 显示系统通知；App 锁（生物识别）状态不显示应用内卡片，此时推送按
  系统通知显示（与后台一致）。
- **设置页**（Home 右上角 ⚙︎ / 主机页顶栏 ⚙︎）：
  - 版本：App 版本/构建号、Bundle ID、iOS 版本；
  - 通知：应用内通知开关、系统通知权限状态、打开系统设置、发送测试通知；
  - 缓存：清理 WebView 缓存 / Cookie / 本地存储（新增原生 `clearWebCache`：iOS
    WKWebsiteDataStore 全类型 + URLCache；Android HTTP 磁盘缓存 + Cookie/WebStorage/认证缓存），完成后自动重载 WebView；
  - 设备与安全入口（复用现有 DevicesScreen：证书/诊断/App 锁/解除配对）。
- **实现**：`src/screens/SettingsScreen.tsx`、`src/components/InAppNotificationBanner.tsx`、
  `src/lib/settings.ts`（SecureStore 持久化）、`notifications.ts`（按 AppState/开关抑制系统 UI）、
  `modules/dsh-mtls` 新增 `clearWebCache`（JS bridge + iOS/Android，`check-native` 增加两端一致性检查）。
- **验证**：`npx tsc --noEmit`、`npm run check:native`、`npm run check:shell`、`npx expo config`
  通过；iOS Release 编译通过；真机前台/后台行为与清缓存待验收。
- **生效**：本批次统一为 App **0.1.5 (build 6)** 需重新构建安装（含原生 clearWebCache）。

## 2026-10-25 修复：手机 WebView 后台恢复后的计时 / 状态不一致

- **现象**：App 切后台较长时间再回来，运行中计时先停在后台前的旧值（例如 4 分钟），
  短暂闪一下真实值（20 分钟）又回到旧值；其他会话信息也可能出现短暂不对等。
- **初步原因**：iOS 会挂起 WKWebView 的 JS 与定时器，但原 WebSocket 可能仍被判定为
  “活着”，DSH 客户端因此不会主动重建连接；恢复后 UI 继续复用后台前的 Session / 内存
  状态（叠加会话热缓存），与主机最新状态短暂并存 → 旧值/新值闪动。
- **缓解**：host 插件 Client 半在手机远程 WebView 中监听 `visibilitychange`；页面隐藏
  ≥10s 后再次可见时调用 DSH Client 的 `connection.reconnect()`，强制重建 generation 并
  重新下发 tail 快照；现有热缓存逻辑会在断线时释放非当前会话，避免旧状态继续复用。
  阈值可用 `globalThis.__DSH_REMOTE_RESUME_RECONNECT_MS__` 覆盖（调试）。
- **验证**：`client-smoke` 新增“后台恢复触发重连”用例；`npm test` 全量通过。
  **真机上的 4→20→4 闪烁仍需复测**（等 iPhone 可用后安装 0.1.5 观察）。
- **生效**：Client bundle 由 host 提供，App 内刷新/重开页面即可；若 DSH 缓存启动 bundle
  则重启 DSH 一次。Host 插件版本 **0.1.5**（本批次统一版本）。

## 2026-10-25 新增：推送点击跳转会话 + 当前会话不弹应用内通知

- **能力**：
  - 点击系统通知（后台/锁屏）或应用内卡片 → 切到推送所属主机，并让 DSH 打开对应会话；
  - 前台收到的推送若属于**当前正在查看的会话**（host + sessionId 匹配），应用内
    卡片与系统横幅都不显示（DSH 页面本身已更新）；其它会话 / 其它页面仍提示。
- **实现**：
  - host：APNs payload 增加 `body` 字典 `{kind, sessionId, host}`。注意 expo-notifications
    的 iOS 实现只把 APNs `userInfo["body"]` 映射到 JS 的 `content.data`，根字段拿不到；
    `push.js` 传入会话 id 与 `hostAddress(config)`，`apns.js` 负责组装。
  - host Client 半（`client.js`，仅 `?dsh_mobile=1`）：注入 DSH `uiWorkspace` service，
    订阅 `uiWorkspace.selection` 通过原生 WebView 桥上报当前 `{host, sessionId}`；暴露
    `window.__DSH_REMOTE_OPEN_SESSION__(id)`（内部 `uiWorkspace.openSession(id)`）与
    `dsh-remote:open-session` 事件；插件加载前的请求暂存 pending，加载后消费。
    `uiWorkspace` 不存在时静默降级（仍打开主机，只是不自动跳会话）。
  - App：原生模块新增 `evaluateJavaScript`（iOS WKWebView / Android WebView，同一时刻跟踪
    活跃 WebView）；WebViewScreen 新增 `openSessionRequest`（页面加载完成后注入打开脚本）、
    `onMessage` 解析当前会话；App 处理 received + response + 冷启动
    （`getLastNotificationResponseAsync`），多主机按 payload 的 `host` 路由。
- **验证**：`npm test` **97/97**；`npm run validate:artifacts`；`npx tsc --noEmit`；
  `npm run check:native`；`npm run check:shell`；iOS Release 编译通过；
  **2026-10-25 真机验收成功**：非当前会话推送、系统横幅点击跳转、当前会话不提示均通过
  （App 0.1.5 build 6 / Host 0.1.5）。
- **生效**：Host 插件 **0.1.5**（重启 DSH 生效；Client bundle 也可刷新页面加载）；
  App **0.1.5 (build 6)** 需重新构建安装（含原生 `evaluateJavaScript`）。
- **限制**：旧版 `pushProvider=expo` 通道 payload 无 session/host，点击只打开主机；
  会话已删除/归档时打开失败会保持当前页面。

## 2026-10-25 修复：手机 App 右侧栏打不开（展开按钮消失 / 面板不可见）

- **现象**：远程 App 里，会话 header 右角的「展开右侧栏」按钮可见；点击后按钮消失，
  但看不到面板——像「打开到了屏幕右边、App 看不到」。
- **根因**（App 侧，注入手机壳）：注入 DSH Web UI 的窄屏 CSS 里有
  `[class*="_rightbarCol"] { display: none !important; }`，把右栏整列隐藏。DSH 在 frame
  宽度 <768px 时让右栏**自动全屏**（`@deepseek-ai/dsh-client-ui-sidebar-right` 的
  `autoFullscreen`，面板 `position:absolute; right:0; width:100vw`，挂在该列里）；
  点击展开后 DSH 会隐藏 header 角落的按钮（`ExpandButton` 在 expanded 时返回 null），
  于是「按钮消失是正常的、面板被 CSS 藏掉是 bug」叠加成“点了没反应”。
- **修复**（`dsh-remoteApp/src/lib/mobileWebShell.ts`，纯 JS）：窄屏下不再隐藏整列，改为
  `[class*="_rightbarCol"] { display: contents !important; }` —— 列不生成盒子后，DSH 原生
  全屏面板（`position:absolute` + inline `width:100vw`）的包含块上移到 `_frame`
  （`position:relative; height:100%`），正好铺满 WebView。不覆盖几何、不加 z-index；
  收起态由 DSH 自己 `translateX(100vw)+visibility:hidden` 且面板 `pointer-events:none`，
  不拦截聊天手势。
- **验证**：`npm run check:shell` **23/23**（新增 11 项右栏断言：390×844 无头 Chrome
  fixture，展开覆盖 rect 0,0,390,844、点击穿透、面板按钮可点、旧脚本对照失败）；
  `npx tsc --noEmit`、`npm run check:native` 通过。**真机行为待验收**（见 ACCEPTANCE §3 #18）。
- **生效**：纯 JS，无需重建原生；dev client Metro reload / 重开 App 即可，发布包需重打
  JS bundle。Host 插件 / relay / DSH 不需要任何改动或重启。
- 详情：[`docs/diagnostics/05-mobile-right-panel.md`](docs/diagnostics/05-mobile-right-panel.md)。

## 2026-10-25 修复：推送 token 误删 / 清缓存 / 锁屏通知 / 会话状态（提交前审查）

- **APNs token 清理口径**：只对 **410 / Unregistered** 删除失效 token；
  `BadDeviceToken` / `DeviceTokenNotForTopic` / `InvalidProviderToken` 视为 topic / 环境 /
  key 配置错误，**不再删 token**，只记日志提示检查 `apnsTopic` / `apnsEnvironment` /
  Key ID / Team ID（避免一个 typo 清空所有设备 token）。清理时同时校验 token 值，避免误删
  刚轮换的新 token。新增 `apns-collapse-id`（= sessionId）折叠同会话重复提醒。
- **清缓存**：Android 补上 `WebView.clearCache(true)` / `clearFormData()`（HTTP 磁盘缓存真正
  清理）；iOS 改为 Promise 回调（不再阻塞 expo 全局 async 队列），10s 超时返回 false 并在
  设置页提示；`npm run check:native` 增加 Android 三项断言。
- **前台通知**：App 锁（生物识别覆盖层）显示时按“后台”处理——系统通知正常显示，应用内
  卡片不显示（避免通知被两处同时吞掉）。
- **当前会话抑制**：离开 WebView 时清空“当前会话”；host 侧在 selection 被清空时上报
  `sessionId:''`，App 清除抑制状态；重新进入主机时恢复上报，避免误吞其它推送。
- **多主机**：注册推送 token 前先 `setClientIdentity(connection.certRef)`，避免用其它主机
  的设备身份注册（失败返回原因，不重试）。
- **通知跳会话**：native 页面重载/自动恢复期间重置 `loadedRef`，避免把“注入到将销毁文档”
  当作已处理导致跳转丢失；`flushOpenSession` 只在页面就绪时执行。
- **验证**：`npm test` **97/97**（+3 新测试：prune 分类、config-error 不删 token、轮换安全）；
  `npm run validate:artifacts`；`npx tsc --noEmit`；`npm run check:native`；
  `npm run check:shell` **23/23**。
- **生效**：Host **0.1.5** / App **0.1.5 (build 6)**（与本批次同一版本）。

## 可自验证据（当前机器即可跑）

```bash
cd dsh-remoteService
npm install
npm test                    # ✅ 97/97 pass（含 APNs、会话摘要、后台恢复重连与通知跳转）
npm run validate:artifacts  # ✅ shell/compose/plist/JSON/Node 入口校验
npm run poc:deploy          # ✅ check-deploy.sh 成功路径（真 relay + 真 host + 证书检查）
node poc/run-poc.js         # ✅ 配对→设备 mTLS→relay→真实 dsh web 的 UI/WS
npm run poc:webview         # ✅ WKWebView + URLSession 客户端证书
npm run poc:csr             # ✅ Swift P-256 CSR → host CA 签发 → openssl 校验
npm run bench               # ✅ 数据面基线（本机 loopback）

# Docker relay（需 docker；macOS 可 colima start）
npm run poc:docker          # ✅ 真实镜像 + 容器 + host 插件 + mTLS 全链路
```

```bash
cd dsh-remoteApp
npx tsc --noEmit            # ✅ 0 error
npm run check:native        # ✅ JS bridge ↔ iOS/Android 接口一致
npm run check:shell         # ✅ 49/49（含设置页全屏/抽屉/inert、外链、右栏全屏、流式零查询）
npm run check:ios-env       # ❌ 本机缺完整 Xcode（脚本给出修复步骤，属预期）
npm run check:android-env   # ❌ 本机缺 Android SDK（同上）
```

## 已完成能力

### dsh-remoteService（DSH host + client 插件 / relay / 协议 / 部署）

- Host 插件：Cordis 生命周期、`/api/remote-access` 本地管理 API、账号上方入口 + 配对弹窗、桌面确认、设备列表/撤销/审计
- 设备身份：host Ed25519 身份、设备 CA（RSA 设备证书 + **P-256 EC CSR openssl 签发**，适配 Secure Enclave）
- 远程 TLS 监听：仅 `127.0.0.1` 反代真实 DSH Web（UI/静态资源/API/WS 全功能），mTLS 校验、Cookie 注入、Host/Origin/Forwarded 等头清洗、安全响应头、请求体上限、路径 deny list
- 配对：一次性 256-bit secret / 12 位 Crockford code、120s TTL、限速、完整 SHA-256 指纹、SAS、桌面允许/拒绝
- relay：443 **TLS 透传（按 SNI 路由，不看明文）**、80 重定向/healthz、8443 WSS 控制面、host token、per-IP/全站连接上限、push token 内存存储
- 推送：自托管直连 APNs（默认；会话标题+助手回复摘要、私钥/设备 token 只在本机、失效 token 自动清理）；旧 relay→Expo 通道保留为可选
- 运维：TLS 证书文件热加载 `reloadTls()`、撤销设备立即断链、audit、`check-deploy.sh`、`validate:artifacts`
- 部署：relay `Dockerfile` + `docker-compose.yml`（已验证构建/运行）、systemd/launchd 模板、DNS-01 证书脚本、DEPLOY 文档

### dsh-remoteApp（Expo / React Native）

- 扫码配对手动输入 fallback、主机指纹校验、SecureStore 存储（私钥永不进 JS）
- 自定义 WKWebView/WebView mTLS 客户端证书挑战
- 原生：iOS Secure Enclave 优先的 P-256 密钥 + PKCS#10 CSR + 证书安装 + URLSession mTLS；Android AndroidKeyStore + 手写 PKCS#10 + setKeyEntry + HttpsURLConnection mTLS（源码完成，未编译）
- 设备管理（列表/撤销）、主机状态、安全审计（均走 mTLS tunnel API）
- 推送注册、生物识别 App 锁、诊断页；设置页（版本 / 应用内通知开关 / 通知权限 / 清理 WebView 缓存）；前台推送应用内卡片
- 注入式手机壳：会话侧栏 → 左侧抽屉、窄屏单列布局、右栏（sidebar-right）全屏覆盖层、
  设置弹窗全屏 + 分区菜单抽屉（`src/lib/mobileWebShell.ts`；`npm run check:shell` 无头 Chrome 回归）
- 环境检查、原生源码一致性检查、Expo prebuild（iOS/Android 生成成功、autolinking 识别 `dsh-mtls`）、真机验收手册

## 安全属性（已实现）

- relay **看不到**任何 HTTPS 明文/会话内容；只按 SNI 转发字节流
- 设备身份**只来自 mTLS 客户端证书**；Host/X-Forwarded-*/Origin/来源 IP 一律不作为身份
- DSH Web 始终只监听 `127.0.0.1`，无 `--trusted-host`、不暴露公网
- 远程响应统一安全头；HTML/API `no-store`；请求体 256 MiB 上限；危险本机路径 deny
- 配对一次性 secret + 限速 + 完整指纹 + 桌面确认；设备可即时撤销并断链
- 推送内容 = 会话标题 + 本轮助手回复摘要（截断，锁屏可见；用户可关闭推送/锁屏预览）；APNs 私钥与设备 token 只留在主机，relay 不接触

## 仓库地图

```
docs/remote-access-evaluation.zh.md   # 已批准的方案评估（B2、安全、决策）
research/                             # 代码测绘/威胁模型/Codex 参考
mockups/                              # 架构图 / 入口 / 配对 / 审批截图
dsh-remoteService/                    # host 插件 + relay + protocol + POC + docs + deploy
  docs/{POC-REPORT,DEPLOY,ADMIN-API}.md
  poc/{run-poc.js,webview-mtls,native-csr,docker-e2e,bench-relay.js,check-deploy-local.js}
dsh-remoteApp/                        # Expo App + 原生模块 + docs/ACCEPTANCE.md
```

## 待人工执行（需要外部环境）

### A. iOS 真机验收（Xcode 环境已就绪，待解锁/连接 iPhone 安装）

当前状态：
- ✅ Xcode 27.1、license、xcode-select、iPhoneOS SDK 均就绪
- ✅ CocoaPods 1.17.0，`pod install` 成功
- ✅ iOS 原生工程（`dsh-remoteApp/ios/`）已生成，bundle ID = `com.amesucre.dshremote`
- ✅ **无签名 generic iOS 编译已通过**（`xcodebuild ... BUILD SUCCEEDED`，含本地 Swift mTLS 模块）
- ✅ 开发证书 + `DshRemote.mobileprovision`（含 `aps-environment=development`）已安装到本机
- ✅ 已手动签名构建并安装到 iPhone 真机，App 启动、JS bundle 加载成功
- ✅ 真机 Secure Enclave 自检：原生模块生成 P-256 key（`SE=true`）→ CSR → host CA 签发 → openssl 证书链/公钥校验通过
- ✅ 真机配对 + 原生 mTLS WebView 已通过本地 Docker relay 端到端验证（设备 `d_example123`「我的 iPhone」，截图 `mockups/ios-mtls-dsh-ui.png`）
- ⏳ 仍待完成：App 锁交互验证、**真机推送验收（APNs 前台应用内/后台系统通知）**、设置页清理缓存验证；生产 relay 由用户自行验证

剩余步骤：

已完成真机安装（手动签名）：

```bash
cd dsh-remoteApp/ios
xcodebuild -workspace DSHRemote.xcworkspace -scheme DSHRemote -configuration Debug \
  -destination 'id=<IPHONE_UDID>' -derivedDataPath /tmp/dsh-ios-device \
  CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=<TEAM_ID> \
  PROVISIONING_PROFILE_SPECIFIER=<PROFILE_UUID> \
  CODE_SIGN_IDENTITY="Apple Development: <YOUR_NAME>" build
xcrun devicectl device install app --device <UDID> /tmp/dsh-ios-device/Build/Products/Debug-iphoneos/DSHRemote.app
```

剩余验收需要 host 配对二维码（相机/手动粘贴）与 APNs 私钥（`.p8` + Key ID/Team ID）；见 `docs/ACCEPTANCE.md`。
按 [`dsh-remoteApp/docs/ACCEPTANCE.md`](dsh-remoteApp/docs/ACCEPTANCE.md) 执行并记录：
配对/桌面确认、WebView mTLS、Secure Enclave 身份、推送、App 锁、撤销断链、证书轮换。

### B. Android 编译/验收（需 Android SDK + JDK）

```bash
cd dsh-remoteApp
npm run check:android-env
npx expo prebuild --platform android
npx expo run:android --device
```
验收清单同 ACCEPTANCE.md（指纹锁、Keystore 身份、FCM 推送、撤销断链）。

### C. 生产 relay 上线（需 VPS + 域名）

```bash
# 1) VPS 安装 Docker；域名 DNS 指向 VPS
# 2) 按 dsh-remoteService/docs/DEPLOY.md 配 relay.json / certs / tokens
# 3) 主机侧：dsh web + 远程访问插件（证书文件用 scripts/issue-host-cert.sh 签发）
# 4) 部署自检
cd dsh-remoteService
./scripts/check-deploy.sh <relay-domain> <hostId>
# 5) 手机扫码配对 → 外网访问
```

## 已知限制 / 风险（MVP 待收尾）

- iOS/Android 原生**未编译**（本机无 Xcode/Android SDK）；已用独立 Swift POC 验证 WKWebView/URLSession 客户端证书、P-256 CSR 链路
- 推送：iOS 自托管 APNs 代码就绪，需配置 APNs Auth Key 并真机验收（key 环境范围需覆盖运行包）；Android FCM 未接入；旧 relay/Expo 通道保留但非默认
- 推送通道升级：自托管 APNs 是默认通道；旧配置（无 `pushProvider` 字段）升级后按 `apns` 处理，
  未配置 APNs 的机器不会推送，也**不会自动回退**旧 relay→Expo 通道（需要旧通道请在设置页显式
  关闭「自托管直连 APNs」）
- 生产证书需要你的域名 DNS-01 签发；`check-deploy.sh` 已在本地成功路径 + 失败路径演练
- 审计/设备管理暴露给所有已配对设备（owner-equivalent 设计；如需"仅桌面管理"需改为本地审批）
- iOS 真机 Secure Enclave 身份来源（Keychain/SE）仍需真机确认（代码路径已实现）

## 相关文档

- [方案评估](docs/remote-access-evaluation.zh.md)
- [POC 报告](dsh-remoteService/docs/POC-REPORT.md)
- [部署指南](dsh-remoteService/docs/DEPLOY.md)
- [管理 API](dsh-remoteService/docs/ADMIN-API.md)
- [App 真机验收手册](dsh-remoteApp/docs/ACCEPTANCE.md)
- [手机端设置页全屏 + 抽屉（诊断 06）](docs/diagnostics/06-mobile-settings-drawer.md)
