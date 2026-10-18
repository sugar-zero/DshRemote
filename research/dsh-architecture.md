# DSH 现状架构测绘：远程访问 / 移动端 / 账号行入口

> 目标：为「移动端 App + 自托管 relay + 强安全 + 侧栏账号行上方入口」的**决策评估**提供事实底座。
> 方法：只读已安装 DSH 的应用包（`/Applications/DeepSeek Harness.app` → 解包到 `/tmp/dsh-extract/src/dsh/node_modules/@deepseek-ai/`）与真实 profile（`~/.dsh/profiles/{desktop,headless}`）。版本 **0.2.1-rc.2**。
> 约定：`pkg` 均指 `/tmp/dsh-extract/src/dsh/node_modules/@deepseek-ai/<pkg>`；证据写作 `文件:行`。**本文件只评估，不含实现。**

---

## 0. 结论速览（给决策者）

| 决策问题 | 结论 | 关键证据 |
|---|---|---|
| 功能能否做成**外部插件**、不 fork DSH？ | **能**。一个 npm 包可同时贡献 Host 插件（服务/路由）与 Client UI 插件（浏览器 bundle/slot），通过 profile bundle 安装。 | `dsh-app-boot/lib/index.js:552-558`；`dsh-client-modules/README.md:33-39`；profile 实装 `~/.dsh/profiles/desktop/package.json` |
| 侧栏「账号上方」入口能否第三方实现？ | **部分能**：唯一合法第三方席位是 `sidebar.footer.action`（list，渲染在账号行之上），但它与 Cordis 按钮共用一条**横向** footer 条；要做到「独占一整行、紧贴账号行上方」，需要**很小的 DSH 核心改动**（新增/改造席位）。 | `dsh-client-ui-sidebar/lib/client.js:400-409,512-519`；`dsh-client-ui-cordis/lib/client.js:1412-1415` |
| 现有 Web 鉴权是否已是「设备级」？ | **不是**。身份 = 进程 launch token → 30 天签名 cookie / `/connect` API cookie；所有通过者都是 **owner principal**，无设备身份、无按设备吊销、无 logout、无 presence。 | `dsh-client-connection/lib/index.js:294-300,458-497,505-539,714,742-750` |
| 「另一台设备/浏览器」的隔离机制存在吗？ | **机制存在、策略为空**。`RemoteAccessService`（角色/资源/快照/`decide`）已就绪，但全仓**没有任何 `registerPolicy` 调用**，非 owner 一律被拒；`/connect` 只发 owner Peer。 | `dsh-api-remote-access/lib/index.js:9,175-189,265`；全仓 grep `registerPolicy(` 仅定义处 |
| 手机浏览器现在能用吗？ | **勉强能跑、不是移动端体验**。有 viewport/manifest（`display:fullscreen`），但无 Service Worker、无 apple-touch-icon/maskable、桌面三栏布局按 1024px 折叠；Web 账号登录**只接受 loopback 回调源**，远程域名下不可用。 | `dsh-web-frontend/dist/index.html:5-7`、`manifest.webmanifest:1-15`；`dsh-client-ui-layout/lib/client.js:14,398-435`；`dsh-client-ui-settings-account/README.md:107` |
| 移动端可复用的协议面？ | 浏览器 wire 是唯一**网络** API：`POST /api/<ns>/<method>` + WebSocket `/api/remote.mux`（流、uplink、`$events`、reconnect/heartbeat）。SDK/ACP 都是 stdio JSON-RPC，不适合直连。 | `dsh-api-gateway/README.md:28-50,59-67`；`dsh-api-remotes/lib/index.js:21-140`；`dsh-sdk-protocol/README.md:31-52` |
| 已有 liveshare/共享/配对脚手架？ | **没有**。无 liveshare/share/pairing/device 包；只有 remote-access README 里一句「未来 liveshare 读者页」设计暗示。 | `dsh-api-remote-access/README.md:47`；全仓路径 grep |
| 自托管服务端是否已有？ | **基本有**：`dsh --profile web --host <ip> --port … [--tls-cert/--tls-key] --trusted-host <域名> --public-url <url>` 已是完整链路；缺的是**配对/设备管理/手机 UI**，以及桌面 App 形态下 `127.0.0.1 --port 0` 的启动参数是硬编码。 | `dsh-web-app/lib/startup.js:25-36,62-69`；`dsh-desktop-host/lib/index.js:227-241` |

---

## 1. Web 启动与插件系统（决定「外部插件 vs fork」）

### 1.1 `dsh web` 的启动链路
- launcher 入口：`dsh/lib/bin.js:106-123`。`dsh <name>` 是 `dsh --profile <name>` 的缩写（`bin.js:23`）；`plugin` 子命令把剩余参数**原样转发 pnpm**（`bin.js:117-123`）。
- 内置 profile 模板（按名字首次使用时自动初始化）：
  `dsh-app-boot/lib/index.js:552-558`
  - `web: [@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app]`
  - `headless` / `acp` / `sdk` / `sdk-minimal` 同构。
- profile 目录：`$DSH_HOME/profiles/<name>`（`resolveProfileDir`，`dsh-app-boot/lib/index.js:547-550`）；目录内容 = `package.json`（`dsh.profile.bundles` 有序列表 + 依赖）、`cordis.yml`（空入口列表）、`cordis.patch.yml`（用户补丁层）、`pnpm-workspace.yaml`。初始化模板见 `dsh-app-boot/lib/index.js:594-604`。
- 组合顺序：bundle 的 `dsh.bundle.patch`（一个文件或有序列表，`dsh-app-boot/lib/index.js:515-532`）依次叠加 → profile `cordis.patch.yml` → home 级 patch → `--patch` 覆盖（`dsh-app-boot/README.md` 的 Profiles 节）。补丁可 `insert` 新条目、按 `id` 覆盖/禁用。
- 必需插件审计：`webserver`、`web-runtime`、`modules`、`connection` 等失败会整体拒绝启动（`dsh-app-boot/README.md` Startup 表；`dsh-web-app/cordis.patch.yml:1-12` 注释）。
- HMR：shipped `web` 模板启用 live reload（`dsh-app-boot/README.md`），所以插件安装/启停可热生效；其他模板需重启。

### 1.2 真实 profile 验证（desktop = 桌面 App 的 Web 组合）
`~/.dsh/profiles/desktop/`：
- `cordis.yml` 只有 `[]`；配置全在 patch/bundle 层 —— 与上节一致。
- `package.json` 的 `dsh.profile.bundles` 除官方外已装 **5 个**第三方 bundle：`dsh-whale-widget`、`dsh-orb`、`dsh-bili-scroll`、`dsh-mc-mode`、`dsh-serverChan`（依赖来自 npm / github / `link:` / `file:*.tgz`）。
- `cordis.patch.yml` 演示了普通用户层能做的三件事：按 `id` 覆盖官方行 config（`agent-default-model`、`ui-settings-account`、`web` 等）、`!!js` 表达式、以及 `insert`（由 bundle patch 承担）。

### 1.3 Desktop（Electron）承载模型 —— 「App 内入口」的真实宿主
- 桌面 App 由一个私有 Node 进程 `@deepseek-ai/dsh-desktop-host` 启动：它 `runProfile({ profile: "desktop", args: ["--no-open","--host","127.0.0.1","--port","0"] })`（`dsh-desktop-host/lib/index.js:227-241`），即**同一个 web-app 组合**、**仅 loopback + 随机端口**；启动后把 `authenticatedUrl(127.0.0.1:<port>)` 和 `collectIndexInjections()` 通过 IPC 交给 Electron（同文件 `343-350`）。
- `dsh-host-webserver/README.md:13` 说明：该 HTTP 服务「只服务浏览器；Electron 通过 `file://` 加载 dist 并走 IPC bridge 承载 fetch」；但 loopback HTTP 端点仍然存在（本会话观测到的 `http://127.0.0.1:52424` 即是它），且是 Web 侧访问同一 Host 的入口。
- 对远程访问的影响：面向桌面 App 时，**绑定地址/端口由 Electron 壳硬编码**，插件无法改 `--host/--port`；可选路径只有（a）插件自建对外监听/TLS/配对，再把请求代理回 loopback（复用 `ctx.connection.authenticatedUrl()` 拿到的 tokenized URL，`dsh-client-connection/lib/index.js:811-814`），或（b）改 Electron/desktop-host 启动参数（核心改动），或（c）让用户另起 `dsh --profile web` 独立自托管实例。

### 1.4 第三方插件包 manifest 约定
- **Host 半**：包根 `main`（如 `lib/index.js`）导出 Cordis 插件（`name/inject/apply/Config`）；bundle 通过 `dsh.bundle.patch` 指向自己的 `cordis.patch.yml`，在 patch 里 `insert` 行 `name: '<pkg>'`（或子路径导出如 `'<pkg>/host'`）。实例：`dsh-orb` 的 `exports["./host"]`、`dsh-mc-mode` 的 `index.js` + `cordis.patch.yml`。
- **Client 半**：`package.json` 的 `dsh.client`：
  ```json
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" },
           "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-settings"], "immediately": true } }
  ```
  `exports["./client"] -> ./client.js`；构建产物 `lib/client.js` 由 Host 扫描并在 `/plugins/<pkg>/client.js` 提供（`dsh-client-modules/README.md:33-39,55`）。`dsh.client.external` 声明非基线模块（`client-modules/README.md:49-51`）。
- **一个包同时贡献 Host + Client：确认可行**。`dsh-mc-mode`、`dsh-serverChan`、`dsh-orb`、`dsh-bili-scroll` 都同时有：主机侧 `index.js`/`dist/host`、客户端 `client.js`、`cordis.patch.yml`（插入 Host 行）+ `dsh.client`（浏览器 roster）。这正是远程访问功能需要的形状。
- **安装方式**：`dsh plugin --profile web add <pkg>`（文档示例 `dsh/lib/bin.js:49`；实现 `dsh/lib/plugin-BiveYA7h.js:64-97` → `dsh-plugin-manager/operations`）。安装会**默认启用 bundle**；切换写 `dsh.profile.bundles` 顺序（`dsh-plugin-manager/README.md:41-43`）。打包/发布规范与官方一致（`engines.dsh` 或 `peerDependencies` 兼容门禁，见 `dsh-app-boot/README.md`；不兼容需 `dsh plugin … allow-version`）。
- **结论**：远程访问的 Host 服务、`/api` 路由、WebSocket、Client UI、设置页都可以放进**一个外部 bundle 包**；不需要 fork DSH。唯一可能触碰核心的是「账号行上方」的**席位形态**（见 §3.3）。

---

## 2. Web 服务器、认证与信任围栏（安全评估核心）

### 2.1 服务器与对外 URL
- `dsh-host-webserver`：`node:http`/`node:https` 路由注册器；`host` 只接受**一个具体本机 IP**，通配地址加载即拒绝；`port` 可 0；`tls.certFile/keyFile` 才是 TLS；`ctx.webServer.protocol` 是 Transport 派生值（`dsh-host-webserver/README.md:40-46,58`；拒绝通配也在 `dsh-web-app/lib/startup.js:49`）。
- `publicUrl` 只是**广告**（打印/打开 URL、`DSH_WEB_URL`、运行时上下文），**不授予任何信任**、不配 listener/路由/cookie 域（`dsh-web-app/README.md`「Listening, trust, and public deployments」；`dsh-web-app/lib/index.js:141-148`）。启动打印带 token 的 URL 在 `dsh-web-app/lib/index.js:157-171`。
- `/api` 的 Host/Origin 围栏是 `dsh-client-connection` 的职责；webserver 自身**没有**全局认证/源策略（`dsh-host-webserver/README.md:130-132`）。
- 非 loopback 绑定 + 明文 HTTP 会打警告（`dsh-web-app/lib/index.js:144`），文档要求把端口限制在可信代理/网络（`dsh-web-app/README.md`）。

### 2.2 令牌与 Cookie（浏览器）
- 每个进程生成一个随机 launch token（32B base64url，`WeakMap` 按 root 复用）：`dsh-client-connection/lib/index.js:294-300,414-444`。
- `GET /?token=…` 交换：仅接受 `GET /`、单 token、Host 可解析；成功 `303` 到 `./` 并种 cookie（`index.js:458-497`）；已认证再访问 `/?token` 则直接 303。失败统一 `401` + 文案（`index.js:571-577`）。
- Cookie 属性：`Max-Age`、`Path=/`、`Expires`、`HttpOnly`、`SameSite=Strict`，**`Secure` 仅当接收该请求的 listener 本身是 TLS**（不信任 `publicUrl`/转发头）：`index.js:347-350,452-455,808-810`。
- Cookie 名与签名 payload 都绑定**规范化 host:port（HTTPS 还含 scheme）**：`index.js:306-316,335-337,559-568`。→ 同一 Host 用不同 authority（localhost / 127.0.0.1 / LAN IP / relay 域名 / 不同端口）是**不同会话**，手机/relay 必须各自走一次 token 交换。
- 签名密钥 = `ctx.credentials` 的 `client-connection/browser-session` 授权记录，持久化在 `$DSH_HOME/.credentials.yaml`；删除该记录并重启 = 吊销所有会话；**没有 logout 操作**（`dsh-client-connection/README.md` Known Limitations；代码 `index.js:273,391-408`）。
- 有效期默认 **30 天**（`cookieMaxAgeDays`，`index.js:1017,1030`），Provider 在 Connection 激活时同步加载密钥（`1034`）。

### 2.3 `/connect`：给非浏览器「另一客户端」的唯一入口
- `GET /connect?token=…&interactions=answer|none` → 生成一个 **owner principal** 的 Peer，写 v2 API cookie，`302` 到 `./api/remote.mux`（`index.js:505-539`；路由注册 `1058-1065`）。
- 认证顺序：先过 Host/Origin 围栏，再校验 token；`interactions` 缺省 `none`，重复或非法值 400（`index.js:505-516,797-804`）。
- API cookie 与浏览器 cookie 同名但用途分离；**一个 API Peer 只允许一条 WebSocket**：重复 attach 返回 409，socket 关闭即销毁 Peer，之后用该 cookie 的 HTTP 请求被拒（`index.js:756-776`；`dsh-client-connection/README.md` 对应段落）。
- 含义：手机客户端完全可以沿用 `/connect` 拿到 cookie，再开 `/api/remote.mux`；但拿到的是**owner 全权**（见 §2.5、§5.3）。

### 2.4 Host/Origin/`sec-fetch-site` 信任围栏（含反代/relay 行为）
- 判定函数 `isTrustedApiRequest`：`dsh-client-connection/lib/index.js:240-250`
  1. `Host` 必须：loopback 主机名（`localhost`/`[::1]`/`127/8`，`127-131`）**或** listener 的 bind IP 字面量（任意端口，`225-231`）**或** `trustedHosts` 条目（带端口=精确 `host:port`，无端口=该 host 任意端口，`196-207`）；
  2. `sec-fetch-site: cross-site` → 拒绝（`246`）；
  3. 若带 `Origin`，必须与 Host 同 authority（用 Origin 的 scheme 归一化端口，支持「HTTPS 代理 + HTTP 上游」，`247-249,258-268`）。
- 语义：**防 DNS rebinding + 防跨站浏览器请求；从不建立身份**（注释 `133-146`；`dsh-client-connection/README.md`）。失败 `403`，围栏通过但未认证 `401`（`742-750,1048-1056`）。
- `trustedHosts` 条目加载时做严格 canonical 校验（拒绝路径/userinfo/空白/零填充端口/非规范写法，`179-183`），非法直接插件加载失败。
- **反向代理/relay 关键点**：`publicUrl` 不给信任 → 代理对外 authority 必须进 `--trusted-host`；**任何 forwarded header（`X-Forwarded-*`）都不参与判定**（围栏只看 Host/Origin/sec-fetch-site，`240-268`；cookie 也只看实际接收的 listener 协议）。所以：
  - relay 若以自己域名对外，必须把该域名加入 `trustedHosts`，且它到 DSH 的连接要能带合法 Host；
  - relay/反代终止 TLS、上游 HTTP 时，cookie 不带 `Secure`（`808-810` 只看 listener 协议）——移动端仅走 TLS 到 relay、relay→DSH 明文可以工作，但 DSH 侧 cookie 不 Secure；
  - DSH 不校验客户端 IP（无「仅本机」IP 检查，只有 Host 名判定），也**没有 CSRF token**，靠 SameSite=Strict + Origin 检查 + token/cookie。

### 2.5 loopback 分类与「伪造 localhost」的安全问题
- 服务端围栏的 loopback 判定：`Host` 头解析后的 hostname（`127-131`），**不是**客户端声称的 IP，也没有 IP 来源检查。一个非浏览器 HTTP 客户端可以伪造 `Host: 127.0.0.1` 过围栏 —— 但**过不了认证**：仍需进程 token / 签名 cookie。围栏防的是 rebinding/跨站，不是身份。结论：**伪造 localhost 头不会获得权限**，威胁模型上可接受，但意味着「按来源 IP 限制远程访问」的直觉在 DSH 里**不存在**；要限制只能靠 token/cookie 或前置代理。
- 浏览器侧另有 `isLoopback`：由**页面 `location.hostname`** 推导（`dsh-client-connection/lib/client.browser.js:1334-1338,1425`；node/desktop 由 `ownsHost` 决定，`client.node.js:532`），作为 **Host facts** 下发给 `ctx.remote.$host.isLoopback`（`dsh-api-gateway/lib/client.browser.js:1666`；`types/client/index.js:81-84`），**每页固定、不可订阅**（`api-gateway/README.md:63`）。
- 现有唯一消费点：
  - 浏览器 UI 的 Settings 文档存储：仅 loopback 时用本地 document store（`dsh-client-ui-settings-general/lib/client.js:1115`）；
  - Host 侧目录选择器 auto：`allowsRemoteAuthorities || !isLoopbackHost(bindHost)` → 远程时改用浏览器目录选择（`dsh-host-directory-picker-auto/lib/index.js:68,131-132`）。
  → **没有任何授权/安全策略依赖客户端 isLoopback**；都是 UX/能力适配。

---

## 3. 侧栏与「账号行上方」入口

### 3.1 底栏 DOM 与席位
- 侧栏底部：`footArea = [footerActions(renderSlot("sidebar.footer.action")), settingsArea(renderSlot("sidebar.settings"))]`，column 布局 → **footer action 条在账号行之上**：`dsh-client-ui-sidebar/lib/client.js:400-409`。
- 席位声明：`sidebar.settings` = **single**（`client.js:512-515`）；`sidebar.footer.action` = **list**（`client.js:516-519`）。上层还有 `sidebar.panellist`（list，全局面板，位于工作区列表上方，`504-507`）与 `shell.bottom`（整宽底栏，layout 所有）。
- `sidebar.settings` 的唯一占用者是 `ui-settings-general`（`dsh-client-ui-settings-general/lib/client.js:1181` 起）：它注册 `SettingsRoot`，并把 launcher/trigger/section 作为子 slot：
  - `settings.launcher` = **single**、`settings.trigger` = single、`settings.section` = list、`settings.action` = list（`settings-general/lib/client.js:1234-1269`）。
- 底栏行 DOM（`settings-general/lib/client.js:432-482`）：`div.triggerRow` 内依次渲染 `settings.launcher` → `ConnectionIndicator` → `DesktopUpdateIndicator`。launcher 未注册时 fallback 为「设置齿轮按钮」（`448-464`）。

### 3.2 账号行
- `ui-settings-account` 注册 `settings.launcher`，组件 `AccountMenu`：
  - 注册点 `dsh-client-ui-settings-account/lib/client.js:4769-4773`（`name:"settings.launcher"`）；
  - 组件 `client.js:1777` 起；渲染为头像/「更多」按钮（`1848-1871`），点击弹 Menu（`1841` 起），菜单项 = Settings / 联系我们 / 退出登录（`1872-1890`）；
  - 未登录显示 `More`（ellipsis，`1867`），并带额度/登录 toast 与 bonus notice（`1817-1840`）。
- 也就是说：**账号行就是底栏那一行**（launcher 取代了齿轮），Settings 入口被收进账号菜单；账号行右侧还有连接状态/桌面更新指示器。

### 3.3 第三方能否插到账号上方？
- **合法且有先例的席位**：`sidebar.footer.action`（list）。已有占用者 `dsh-client-ui-cordis` 注册 `cordis-panel`（`dsh-client-ui-cordis/lib/client.js:1412-1415`）；cordis 运行时插件文档也把它列为可注入 slot（`dsh-cordis-client-runner/lib/client.js:5653,5697`）。
  → 第三方 client 插件 `ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({name, id, order, …}, MyRow))` 即可出现在账号行**正上方**，**无需核心改动**。
- **限制**：该条是横向 `display:flex`（`sidebar/lib/client.js:92` css：`_footerActions{display:flex}`），与 Cordis 图标按钮**并排**；没有「整行、独占」语义，也没有为普通行设计的间距/排版契约。要做出与账号行同宽、同风格、紧贴其上的**独立一行**，需要 DSH 核心小改（例如把 footerActions 改成可换行/新增专用 list 席位，或给 `sidebar.settings` 增加 children 行）。
- 不能走的路：
  - 占用 `settings.launcher`（single）：会**顶掉账号菜单**，等于「替换」而非「并列」，且会与 `ui-settings-account` 抢同一 single 席位；
  - 占用/替换 `sidebar.settings`（single）：等于重写设置壳，风险大；
  - `settings.section` 只能在 Settings 面板里加页面，不是侧栏行。
- **结论**：推荐「先用 `sidebar.footer.action` 快速验证（0 核心改动），确认要长期原生产品化时再提一个 ~10-30 行 UI 核心 patch 增加专用席位」（与 §7.3 一致）。

### 3.4 移动端/PWA 现状
- `index.html`：`<meta name="viewport" content="width=device-width, initial-scale=1">`、manifest 链接、favicon（`dsh-web-frontend/dist/index.html:5-9`）。
- manifest：`display:"fullscreen"`、`start_url:"./"`、单一 SVG 图标（`dist/manifest.webmanifest:1-15`）；**无 Service Worker**（dist 打包 JS 中无 `serviceWorker`），无离线缓存、无 apple-touch-icon/maskable。
- 响应式：布局是**桌面三栏**（sidebar 264–420px/默认 280、右栏按 45% 视口、<1024px 自动折叠侧栏），由 JS 读 `window.innerWidth` 控制（`dsh-client-ui-layout/lib/client.js:14,398-435`；`dsh-client-ui-layout/README.md`）。各 UI 包内有一些 `@media`（聊天、附件、设置页等，合计数十处），但外壳没有移动断点/触控/安全区适配。
- Web 账号登录的硬限制：Host **只接受 loopback 回调源**（`localhost`/`127.0.0.1`/`[::1]`）；经 `--trusted-host`/HTTPS 反代打开的 Web UI 仍显示登录入口，但点登录会以通用失败态告终，只能用 API key（`dsh-client-ui-settings-account/README.md:107`）。→ 手机通过 relay/域名访问时，**DeepSeek 账号登录不可用**（除非走 loopback，如 `adb reverse`/本机端口转发）。
- 结论：**WebView 包壳 + 登录由宿主 native 负责/或用 API key** 是第一期最低成本路线；原生 UI 不是必须先做的。

---

## 4. 账号行相关的设置/launcher 契约（补充）
- `settings.launcher` 的注入 props：`wide、settingsOpen、openSettings、settingsShortcut、openOnboarding`（`settings-general/lib/client.js:436-447`）。第三方若想「在账号行上方再加一个像账号行的入口」，拿不到账号自己的状态，但可独立渲染。
- `ui-settings` 提供 `settings.section`（list，order 排序，`settings-general:1294-1304` 与 account:4774-4796 order -10 示例）；第三方远程访问设置页可注册为 `settings.section`（如 `dsh-mc-mode` 已这么做），无需核心改动。
- 账号 launcher 与 `settings.section` 共享 account 快照流（`dsh-client-ui-settings-account/README.md`「Understand the implementation」）。

---

## 5. 移动客户端可用的 API 面

### 5.1 传输层
- HTTP unary：浏览器 `POST /api`，JSON 请求/响应；byte 附件用 multipart（`dsh-client-connection/README.md`；`lib/index.js:820-968`）。`/api` 是 prefix 路由，token/cookie + 围栏后进入共享 Fetch handler（`index.js:1044-1058`）。
- 流：WebSocket `/api/remote.mux`（Gateway 拥有），每条 logical stream 双向：downlink items + client→host uplink（`dsh-api-gateway/README.md:40,44`）。心跳 Ping 2s 默认，两个间隔无活动断开（`README.md:40`）。
- 断线重连：Connection 指数退避（500ms→10s 上限，50–100% jitter），由 `$events` 流作为 generation source（`dsh-client-connection/README.md`；`dsh-client-connection/lib/index.js:983-998` 配置）。
- `$events`：Host 唯一应用事件源，allowlist 由 `dsh-api-remotes` 固定（`lib/index.js:21-140`）：`api-session/added|removed|activity|status|error`、`settings/document-updated`、`plugin-manager/*`、`schedule/changed`、`approval/request`（waterfall）、`user-questions/request`（waterfall）等。
- 会话数据面由 `dsh-api-session-controller` 提供：`session/list|page|follow|projections|search|control|create|fork|prompt|cancel|rename|…`；`session/prompt` 写入持久 `user-rpc` 消息并记录非 owner 的 principal（`dsh-api-session-controller/README.md:28-45`）。
- 审批/提问：作为 **waterfall** 事件转发，只有 `interactions==='answer'` 的 **owner** Peer 能接收/作答（`dsh-api-gateway/README.md:48-50`；`dsh-client-connection/lib/index.js:509,671`）。`/connect?interactions=answer` 可让手机成为「可作答」客户端。
- 权限审批通道细节：`approval/request` 与 `user-questions/request` 都在 allowlist（`dsh-api-remotes/lib/index.js:28-31,137-140`）。

### 5.2 多客户端 / 同会话观察
- 浏览器：**所有已认证浏览器共享同一个 `browserPeer`**（owner、`interactions:'answer'`，`dsh-client-connection/lib/index.js:714,746`）——多标签/多设备浏览器没有独立身份。
- API：每个 `/connect` 产生独立 owner Peer，但**一条 WebSocket**（409，`756-776`）；cookie 过期/主机重启后需重连 `/connect`。
- 同一会话可被多个客户端同时观察：`$events` 广播 + 各客户端独立 `session/follow`、`session/projections`、`session/control` 流（`api-session-controller/README.md`）；prompt 通过会话 inbox 排队（`sdk-jsonrpc-server/README.md` 亦描述「独立请求可继续入队」）。
- **缺口**：没有 presence/谁在看的 API；`hasLiveClient()` 仅被 Cordis inspect 使用（`dsh-cordis-host-runner/lib/index.js:837`）；多 owner 客户端同时在线时审批 waterfall 的归属/去重/防抢答**未在文档中定义**（每 Peer 的 reply 必须属于自己收到的事件流，`api-gateway/README.md:50`）——移动端审批需要实测并很可能要补仲裁。
- 并发提示：`session/prompt` 对同一 Session 依次入队；同一身份被另一个 owner 持写锁时会被拒（`session.create` 的「written by another owner」语义，`api-session-controller/README.md`）。

### 5.3 Peer / Principal / RemoteAccess（「另一设备」机制）
- `Peer` 模型：`principal`（owner 或非 owner kind）+ `interactions` + `signal`；`ctx.connection.browserPeer` 共享给浏览器；`admit(request)` 返回 Peer 或拒绝（`dsh-client-connection/lib/index.js:646-720,742-750`；`README.md` 同名段）。
- `RemoteAccessService`（`ctx.remoteAccess`）：`registerPolicy(kind, policy)`、`invalidate`、`decide`、`allows`、`snapshotFor`、`follow`；角色=资源+动作集，binding 可带 condition；Gateway 在非 owner 调用前按端点/资源询问（`dsh-api-remote-access/README.md:28-56`；`lib/index.js:9,175-189,265`）。
- 资源种类：`global` / `session` / `workspace`（快照 schema `dsh-api-remote-access/lib/typert.host.js`；UI Hooks `useRemoteAccess/useSessionAccess/useWorkspaceAccess`，`client-ui-session/README.md:28`、`client-ui-workspace/README.md:85`）。
- **现状**：全仓只有 `registerPolicy` 的**定义**，没有业务包注册策略；`/connect` 的 Peer 硬编码 owner principal（`publishPeer`，`lib/index.js:781-791`）。→ 「非 owner 设备」只能靠未来插件自行注册 policy + 需要一个签发非 owner Peer 的新入口（当前没有）。若一期接受「手机 = owner」，则不需要这部分也**不需要核心改动**；若要「受限共享/只读观众」，这是**核心或半核心改动点**。
- 非 owner 页面快照注入机制已设计好但无实现：`__DSH_REMOTE_ACCESS__` global（`lib/index.js:9,161`；README:47 提到「owner Host 上渲染 liveshare 读者页」的用法）。

### 5.4 备选协议（薄客户端）
- `dsh-sdk-protocol`：**stdio** 逐行 JSON-RPC 2.0；7 个 C→S 方法（`initialize/session/prompt|resume|wait|working-directory get|set/shutdown`）+ 4 个 S→C 通知（`session.event|status`、`subagent.started|finished`）；**无 cancel/close、无认证、无网络传输**（`README.md:31-52,120-124`）。
- `dsh-sdk-jsonrpc-server`：把上面这套挂到 stdio 的插件（`README.md:13,29-33`）；`dsh-acp`：标准 ACP v1 stdio server（session new/list/resume/close、cancel、MCP、**authenticate 立即成功=无认证**，`dsh-acp/README.md:13-19,55-65`）。
- 结论：这些适合「本机子进程/编辑器集成」，**不适合**手机直连；最多可作 relay 进程内部驱动 Host 的备选（例如 relay 用 ACP 起一个 DSH 子进程），但会丢掉 Web UI/审批/会话投影等现成能力。**建议移动端直接用浏览器 wire（`/api` + `/api/remote.mux`）**，与 Web UI 同源能力最全。

### 5.5 账号/登录相关的 API 约束
- 账号登录的 Host 只接受 loopback 回调 origin（`dsh-client-ui-settings-account/README.md:107`）；`account` Remote 命名空间（`dsh-api-account-controller`）存在。
- 移动端如果要做「App 内登录 DeepSeek 账号」，不能复用 Web 登录流（除非把 relay 的 loopback 暴露给手机，如 SSH 端口转发/adb reverse），需自己实现或引导用户填 API key。

---

## 6. 已有 sharing / liveshare / remote 脚手架盘点
- **没有**任何 `liveshare`/`share`/`viewer`/`pairing`/`device` 命名的包或功能（对 306 个包 + 全部 README/JS 的检索）。「共享观看」的唯一痕迹是 remote-access README 举的例子（`dsh-api-remote-access/README.md:47`）与快照注入机制——属于**设计预留**而非实现。
- 已有的「远程/多客户端」真实资产：
  1. 网络传输与断线重连（Connection + Gateway mux + `$events`）；
  2. token / `/connect` cookie 认证链路；
  3. 完整会话 Remote API + 转发事件 + 审批/提问 waterfall；
  4. RemoteAccess 角色/资源/快照**引擎**（无策略、无发放入口）；
  5. Web 前端 + slot 插件体系 + profile bundle 安装（无需 fork）；
  6. PWA manifest（但无 SW/图标规范）。
- 明确缺失：配对/二维码/设备注册与吊销、relay/中转服务、按设备 principal 与策略注册、移动端 UI/触控布局、审批多端仲裁与通知（APNs/FCM）、证书自动化、共享会话的只读观众模式、单点登出。

---

## 7. 可复用能力 / 缺口 / 需要 DSH 核心改动的点 / 对工作量的影响

### 7.1 可复用（几乎零成本）
| 能力 | 复用方式 | 证据 |
|---|---|---|
| 插件化打包/安装 | 发布一个 bundle 包（host rows + `dsh.client`），`dsh plugin add` 安装 | §1.2/1.4 |
| 侧栏入口 | `sidebar.footer.action`（list）注册一行 | §3.3 |
| 设置页 | `settings.section`（list，order） | §4 |
| 移动端传输 | 复用 `/api` + `/api/remote.mux`，客户端可参照 `dsh-client-connection`/`dsh-api-gateway` 的 browser bundle 协议 | §2/§5.1 |
| 会话与审批 | 复用 session Remote + 转发事件/waterfall | §5.1/5.2 |
| 认证原料 | launch token、`/connect` cookie、`trustedHosts`、TLS listener | §2.2-2.4 |
| 权限引擎 | RemoteAccess 的 role/binding/snapshot/follow（需自行注册 policy + 发放入口） | §5.3 |

### 7.2 缺口（按紧急度）
1. **设备身份与配对**：没有 device credential、配对码/二维码、设备列表、按设备吊销、logout。现在只有「**进程级** launch token（每次重启都变）→ 30 天 owner cookie」；首次入网要么让用户读主机启动日志里的 tokenized URL，要么自己实现配对。
2. **relay/自托管中转**：DSH 只支持 listener 直连 + 反代（Host authority 需 `trustedHosts`），没有中继/穿透/多路复用服务。
3. **手机触控体验**：桌面外壳 + 无 SW/无安全区/无手势；Web 登录 loopback 限制。
4. **桌面 App 的网络可达性**：Electron 壳固定 `127.0.0.1 --port 0`（`dsh-desktop-host/lib/index.js:227-241`），没有设置项可改 bind/端口/TLS/trustedHosts；做「App 内远程访问」需要插件自建对外监听或改壳。
5. **多端审批仲裁/推送**：无 presence、无「哪台设备处理审批」语义、无 push。
6. **受限共享观众**：non-owner Peer 发放入口 + policy 注册均缺（引擎已有）。
7. **运维安全默认值**：远端明文 HTTP 警告但可运行、cookie 明文可被网络截获（文档已警告）、无 HSTS/ACME。

### 7.3 需要 DSH 核心改动的点（按必要性）
| 改动 | 是否必须 | 规模/理由 |
|---|---|---|
| 「账号行正上方独占一行」原生席位 | 仅当不接受横向 footer 条内并排 | 小（UI patch，sidebar/settings-general 的 slot 声明 + DOM/CSS，约几十行）；可用 `sidebar.footer.action` 先绕过 |
| 非 owner 设备 Peer 的**发放入口**（新鉴权路由或扩展 `/connect` 接受第三方 device token → `Peer(principal:{kind:'device',…})`） | 若要「受限/只读共享」才必须；若手机=owner 则不必须 | 中；`HostConnectionService.publishPeer` 硬编码 owner（`client-connection/lib/index.js:781-791`），BrowserAuth 是包内部件 |
| 每设备策略注册 | 可放**外部插件**（`ctx.remoteAccess.registerPolicy` 是公开服务），不必核心改 | 小-中 |
| 移动端布局断点/安全区/触控 | 建议核心补，也可由插件注入 CSS 局部实现 | 中；当前只有 JS 1024px 折叠（`ui-layout/lib/client.js:14,420-435`） |
| 桌面 App 的对外 bind/TLS/trustedHosts（改 Electron 壳启动参数或设置项） | 若产品形态是「桌面 App 直接对外」，必须；若是「自托管 dsh web 实例 + 桌面 App 仅作客户端」则不必须 | 小-中（`dsh-desktop-host/lib/index.js:227-241` 是硬编码 args，改动在 Electron 主进程/desktop-host，不在 profile 层） |
| relay 协议/云端 | 完全可在 DSH 之外实现（DSH 侧只需 `trustedHosts` + TLS + 稳定的 Host 语义） | 中-大，非核心 |

### 7.4 对工作量的影响（估算口径：人月，供 Lead 做方案对比）
- **A. 纯外部插件 + WebView**（手机=owner、relay 只做 TLS 反代/端口转发）：**最低**。插件包（host 行 + footer 入口 + 设置页）≈ S；WebView 壳 + token/cookie 注入 + 登录策略 ≈ M；relay（若只做反代/证书）≈ S-M。**不需要 DSH 核心改动**；桌面 App 场景需插件自建对外监听 + 代理回 loopback（≈ S-M，因为 `dsh-desktop-host` 的 bind/端口不可配）。
- **B. 原生移动 UI**：在 A 之上叠加原生客户端实现（会话流、审批卡片、附件上传、重连）≈ M-L；协议复用不浪费。
- **C. 受限共享/多用户/设备管理**：必须补「非 owner Peer 发放入口 + policy + 设备吊销/配对」≈ M，且大概率动 DSH 核心（`publishPeer`/BrowserAuth 或新路由），还要处理审批仲裁与 presence（未定义语义，需设计）。
- **D. 真 relay 服务（NAT 穿透、端到端加密、多租户）**：≈ L，且安全评审是主要成本（当前 DSH 的信任模型只有「进程 token → owner」，relay 一旦持有 token 即拥有 owner 全权；要「relay 不持有明文/不全权」需改认证模型，属核心级设计变更）。
- **E. 自托管「服务端」产品化**：若定位为「用户自己跑 `dsh web`，手机连它」，服务端侧 ≈ S（CLI 参数/TLS/文档已具备），主要成本在配对 UX、移动端 UI、证书引导与运维文档。

### 7.5 给评估的 5 条硬事实（可直接写进结论）
1. **不需要 fork 就能做出插件和侧栏入口**；唯一「形态」妥协是入口与 Cordis 按钮共用 footer 条。
2. **现有安全边界 = token/cookie**；`isLoopback`/Host 头**不构成授权**，所以「伪造 localhost」拿不到权限，但也不存在来源 IP 限制——relay/代理必须自己承担网络层安全。
3. **手机可复用 `/connect?interactions=answer` + `/api/remote.mux`**，拿到 owner 全权与会话/审批能力；代价是**没有设备级隔离**。
4. **非 owner（受限观众）机制是空引擎**：有 role/binding/snapshot API 与资源模型，但无策略、无设备 Peer 入口、无 presence/仲裁。
5. **移动端 Web 体验是「能用但不像 App」**：viewport/manifest 有、SW/触控/图标/安全区/loopback 登录限制是主要缺口；WebView 包壳是第一期性价比最高的路线。

---

## 附：本次检索的主要路径
- 启动/配置：`dsh-app-boot/lib/index.js:547-604`；`dsh/lib/bin.js:106-123`；`dsh/lib/plugin-BiveYA7h.js:64-97`；`~/.dsh/profiles/desktop/{package.json,cordis.patch.yml,cordis.yml}`。
- 桌面承载：`dsh-desktop-host/lib/index.js:219-350`（`runProfile` 硬编码 `--host 127.0.0.1 --port 0`、IPC 上报 tokenized URL 与 injections）。
- Web/传输：`dsh-web-app/{README.md,lib/index.js,lib/startup.js,cordis.patch.yml}`；`dsh-client-connection/lib/{index.js,client.browser.js,client.node.js}`；`dsh-host-webserver/lib/index.js`；`dsh-api-gateway/lib/*`；`dsh-client-modules/README.md`。
- UI/入口：`dsh-client-ui-sidebar/lib/client.js`；`dsh-client-ui-settings-general/lib/client.js`；`dsh-client-ui-settings-account/lib/client.js`；`dsh-client-ui-cordis/lib/client.js`；`dsh-client-ui-layout/lib/client.js`。
- 权限/远程：`dsh-api-remote-access/{README.md,lib/index.js,lib/typert.host.js}`；`dsh-api-remotes/lib/index.js`；`dsh-api-session-controller/README.md`。
- 备选协议：`dsh-sdk-protocol/README.md`；`dsh-sdk-jsonrpc-server/README.md`；`dsh-acp/README.md`；`dsh-headless/README.md`。
- PWA：`dsh-web-frontend/dist/{index.html,manifest.webmanifest,assets/*}`。
