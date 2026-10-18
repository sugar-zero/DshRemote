# DSH 远程访问安全评估：现有信任模型、威胁模型与设计建议

> 性质：评估（不实现）。对象：DeepSeek Harness（DSH）新增“手机 App + 可自托管中继 + 强认证/加密”的远程访问能力。
> 证据：DSH 实现提取物 `/tmp/dsh-extract/src/dsh/node_modules/@deepseek-ai/`，行号以该提取物为准。缩写：
> `CC`=`dsh-client-connection/lib/index.js`，`CCB`=同行 `client.browser.js`，`WS`=`dsh-host-webserver/lib/index.js`，
> `WA`=`dsh-web-app/lib/index.js`，`FS`=`dsh-host-frontend-static/lib/index.js`，`GW`=`dsh-api-gateway/lib/index.js`，
> `RA`=`dsh-api-remote-access/lib/index.js`，`CRED`=`dsh-credentials-local/lib/index.js`，`ACC`=`dsh-deepseek-account-platform/lib/index.js`。
> 用户核心要求：不能被 Host / X-Forwarded-For / X-Real-IP / Forwarded / Origin 等“自称 localhost”的头信息骗过去；远程访问不得削弱本地信任模型。

## 0. 五条结论（先看这里）

1. **DSH 今天没有任何“Host=localhost 即受信”的授权捷径。** loopback/Host/Origin 判定只用于 CSRF 与 DNS-rebinding 防护（`CC:134-145,240-250`）；通过栅栏后仍必须出示浏览器签名 cookie 或 API cookie，否则 401（`CC:736-750`）。`Host: localhost` 只能把请求送到鉴权门口，不能越过鉴权。
2. **现有模型是“单进程单 owner、长寿命 bearer”。** launch token → 30 天签名 cookie（`CC:1017`；README `dsh-client-connection/README.md:44`），无登出、无按设备撤销、无限速；`/connect` 同样发布 `{kind:'owner'}` Peer（`CC:505-539,781-791`）。网络侧**不存在**非 owner 角色：`PrincipalMap` 只合并了 `owner`（`dsh-api-remote-access/lib/typert.host.js:146`），全仓无第二处 `registerPolicy` 调用。互联网暴露 = 把 owner 全权交给 cookie 持有者。
3. **转发头在 DSH 中完全不被读取**：`X-Forwarded-For/X-Real-IP/X-Forwarded-Host/X-Forwarded-Proto/Forwarded` 在 306 个包中零引用；cookie 的 `Secure` 与 scheme 只由本监听器 TLS 配置决定，明确“绝不看 publicUrl 或转发头”（`CC:452-455,347-350`；`WS:302-308`）。因此“伪造 XFF=127.0.0.1”在 DSH 内不成立。但 TLS 终止型反代/中继会看到 cookie 明文，`X-Forwarded-Proto` 又救不了它——中继必须 E2E，不能只是 HTTPS 反代。
4. **`publicUrl` 不授权，但它会把 launch token 拼进公告 URL。** `--public-url` 仅用于打印/打开/环境变量（`WA:141-147,157-171`；`dsh-web-app/lib/startup.js:26` “grants no trust”；`dsh-web-app/cordis.patch.yml:233-234`）。可是 `authenticatedUrl()` 会把 `?token=` 加到公告 URL（`CC:440-444`），`dsh web` 随后打印并在子进程 argv 中传递它（`WA:161-166,85-100`）。若公告 URL 指向公网中继，**owner 引导令牌就进了中继/代理的 URL 日志**——现有代码在远程场景的直接泄露点。
5. **推荐硬性架构**：每设备 Ed25519 签名 + X25519 ECDH（Secure Enclave / Android Keystore，不可导出）；桌面端 QR 一次性配对密钥（≤120s、单次、含主机身份指纹）+ SAS 双向确认；App↔主机 Noise XX（或 libsodium `crypto_kx`）+ ChaCha20-Poly1305/XChaCha20-Poly1305 E2E；中继只按不透明路由转发帧、不持主机密钥、不落内容；主机签发 ≤15 分钟设备令牌并按设备撤销；绝不复用浏览器 cookie/launch token。

## 1. 现有 DSH 安全模型（精确到行为）

### 1.1 启动令牌 → GET / 交换 → 签名 cookie

- **令牌来源**：每进程 `randomBytes(32)` → base64url（256-bit），挂在 process owner 的 WeakMap 上，Connection 重载不换（`CC:294-300,414-423`）。`dsh-web-app` 启动后把 `?token=<t>` 拼到广告 URL 并打印/打开（`CC:440-444`；`WA:157-171`）。
- **交换**：只有 `GET /` 且 token 恰好一个、与进程令牌定时安全比较（`CC:330-334,461-464`）；成功写 `303 Location: ./` + `Set-Cookie` + `Cache-Control: no-store` + `Referrer-Policy: no-referrer`（`CC:473-478`）→ 地址栏回到干净 `./`（是否完全不入历史取决于浏览器实现）。
- **Cookie**：名字是 `dsh-auth-`+`sha256(authority)`（`CC:335-337`）；属性固定 `Max-Age=…; Path=/; Expires=…; HttpOnly; SameSite=Strict`，仅当本监听器 TLS 时加 `Secure`（`CC:347-350`）；默认寿命 30 天、可用插件配置 `cookieMaxAgeDays` 调整（`CC:1017`）。host-only（无 Domain）。
- **绑定**：签名为 HMAC-SHA256，密钥是 `$DSH_HOME/.credentials.yaml` 中 owner 级 `client-connection/browser-session` grant 记录、32 字节（`CC:273,391-408`；文件 0600/目录 0700——`CRED:555,566` 的 `448=0o700,384=0o600`）。请求 audience 由 **Host 头** 算出 `host[:port]`，TLS 下含 `https:` scheme（`CC:306-316`）；cookie 名与 payload 的 `authority` 都要匹配（`CC:335-337,559-569`），HTTP cookie 不能用于 TLS 监听器同址（README:46）。载荷还含绝对 `issuedAt/expiresAt`，越界/超寿命即拒绝（`CC:567-569`）。
- **无登出**：清浏览器 cookie 只结束一个浏览器；真正撤销 = 删凭据记录并重启（README:84）。**无按设备、无按会话撤销；连接层未发现频率限制/失败锁定**。

### 1.2 `/connect`：非浏览器客户端令牌流

- `GET /connect?token=…&interactions=answer|none`（`CC:505-539`）。先过 Host/Origin 栅栏，失败 403（`CC:797-803`）；`interactions` 必须出现至多一次且为 `answer|none`，否则 400（`CC:507-515`）；默认 `none`。token 校验同上，成功 302 到 `./api/remote.mux` 并发 **v2 cookie**（载荷含 `id=publishPeer(interactions)`，`CC:525-537`）。
- `publishPeer` 创建 owner principal Peer 存入 `peers` 表（`CC:781-791`）；HTTP 可以早于 WebSocket，但 API 会话以**一个 socket 的所有权**为准：`admitConnection` 对已 `ownsSocket` 的记录返回 **409**，socket 关闭时 dispose 并从表里删除（`CC:742-750,756-776`）；此后用该 cookie 的 HTTP 请求因查不到 Peer 而 401。未建 socket 的 API Peer 不回收、留到进程关闭（README:83）。
- 只接受 query token，**不接受 `Authorization` 头**；token 只在 `/` 与 `/connect` 两处被接受（README:42）。

### 1.3 Peer / principal / interactions

- `Peer`：一个被主机接纳的参与方，构造时固定 `principal` 与 `interactions`（默认 `answer`），有独立 scope 与 abort signal（`CC:646-684`）。
- `ctx.connection.browserPeer` 是**所有**浏览器会话共享的 owner Peer，`interactions` 默认 `answer`（`CC:714`）；`createPeer({principal, interactions?})` 仅进程内插件可调（`CC:752-754`）；`fetch(request, peer)`/HTTP 桥显式携带 peer。
- `interactions` 决定是否参与转发事件：`$events` 与 `$events/result` 一律要求 `answer`，否则 `gateway/interactions-forbidden`（`GW:1453-1454`）；只有 **owner** Peer 能回答 waterfall、能发 `$events/result`（`GW:963-969,1010-1011`）。
- Gateway 每次调用都带 Peer，禁止默认 Peer；已 dispose 的 Peer 在 dispatch 前被拒（`GW` README；`assertPeerLive`）。

### 1.4 Host / Origin / sec-fetch-site 请求信任栅栏（接受条件原文）

`isTrustedApiRequest(request, trustedHosts, bindHost, protocol)`（`CC:240-250`）：
1. 必须有 `Host` 且能被 WHATWG URL 解析（`CC:241-244`）；
2. Host hostname 必须是下列之一（`CC:245`）：
   - loopback：`localhost`、`[::1]`、任意 `127/8`（`CC:127-131`）；
   - listener 的 **bind IP 字面量**（任意端口，IPv4-mapped/IPv6 规范化后比较，`CC:217-231`）；
   - 配置的 `trustedHosts`：带端口 = 精确 `host:port`；无端口 = **同 hostname 任意端口**（`CC:196-207`）；条目必须是裸 authority，`user@host`、路径、非规范写法等在**加载时**报错而不是静默放宽（`CC:165-183`）。
3. `Sec-Fetch-Site: cross-site` → 直接拒（`CC:246`）；
4. 有 `Origin` 时必须是同一 authority（把 Host 按 Origin 的 http/https scheme 解析，以支持 HTTPS 代理 + HTTP 上游；`CC:247-269`）；**没有 Origin 时放行**（非浏览器客户端与浏览器“无标记读请求”都靠这条走，所以 Host 栅栏覆盖每一个请求）。
- 顺序与语义：栅栏失败 **403**；栅栏通过但未认证 **401**（`CC:743-749,797-803`；README:48）。栅栏“永远不建立身份”（`CC:144-145` 注释原文；README:48）。
- 升级到 WebSocket：`/api/remote.mux` 的 upgrade handler 同样先 `admitConnection`（`GW:787-790`），即 Host+Origin+认证三者都过才升级；webserver 自身只做路径路由、不做安全判断（`WS:433-466`）。

### 1.5 `isLoopback` 分类：哪些是授权决定？

- 服务端判定只有一份：`isLoopbackHostname`（`CC:127-131`），以及 webserver 对 **bind IP** 的 `isLoopbackHost`（`WS:163-166`）。前者只服务 Host 栅栏与 cookie audience，**不参与身份**。
- 客户端 `connection.isLoopback` = `transport.ownsHost===true || 无页面位置 || pageLocation.hostname 是 loopback`（`CCB:1334-1338,1425`；node 版 `client.node.js:441,532`）。消费点：
  - `dsh-client-ui-settings-general/lib/client.js:1115`：只有 loopback 才创建 `SettingsDocumentStore`（本地配置文件编辑入口）——纯 UI 能力；
  - `GW` 的 `$host.isLoopback` 固定为页面生命周期事实，供 UI 展示（`dsh-api-gateway/lib/types/client/index.js:81-84`；`client.browser.js:1666`）。
- 结论：**没有任何网络授权决定依赖请求头里的 loopback 判定**；客户端 `isLoopback` 是 UX 事实，若被远程/恶意页面伪造，最多影响本地 UI 行为，Host 侧仍逐调用鉴权。
- 服务端“loopback 事实”消费点（都基于**启动配置/绑定**，不是请求头）：明文 HTTP 暴露警告（`WA:144`）；目录选择器 native 后端（`dsh-host-directory-picker-auto/lib/index.js:68,132`，`allowsRemoteAuthorities || !isLoopbackHost(bindHost)` 就退回 browse）；出站代理对 loopback URL 直连（`dsh-http-proxy/lib/index.js:201,279`）。
- 唯一的“loopback 校验”安全语义：账号登录的 OAuth 回调 origin 必须是 loopback HTTP + 显式端口（`ACC:308-329`，见 1.7）。

### 1.6 转发头与 publicUrl

- **转发头**：`X-Forwarded-For / X-Real-IP / X-Forwarded-Host / X-Forwarded-Proto / Forwarded / CF-Connecting-IP` 在 DSH 全部包中没有任何读取（grep 零命中；仅 inspector 的 devtools 静态资源里出现字符串）。cookie 的 `Secure` 与 scheme 绑定明确“只由本监听器协议决定，绝不由 publicUrl 公告或转发头决定”（`CC:452-455`；README:44/48）。这是正确设计，必须保留。
- **`--trusted-host`**：只把 authority 加进 `trustedHosts`（`dsh-web-app/lib/startup.js:26,68`），让栅栏接受该 Host；`allowsRemoteAuthorities` 由此变为 true（`CC:721`），但不改变认证。
- **`publicUrl`**：规范化为 http(s) 根（`dsh-web-app/lib/public-url-D_dMK-yI.js:17-30`），只影响打印/打开/`DSH_WEB_URL` 与 `getAdvertisedUrl`（`WA:141-148`），**不**加入 trustedHosts、**不**改变 cookie scheme。官方注释：“advertised public URL contributes nothing to it”（`dsh-web-app/cordis.patch.yml:233-234`）。

### 1.7 明文 HTTP、账号登录、静态资源

- **明文暴露警告**：非 loopback bind + HTTP 只打一行 `console.warn`（`WA:144`）；README 自认“plain-HTTP listener exposes the bearer cookie in transit”（README:82）。**没有 HSTS/CSP/X-Frame-Options/X-Content-Type-Options**：主 UI 响应路径未设置（`FS:74` 只写 content-type），全仓 CSP 仅账号平台自有页面（`ACC:1137`）。没有 CORS 头（因此跨源读取被浏览器 SOP 拦下，属于隐性防线）。
- **绑定限制**：`--host 0.0.0.0` 与一切 wildcard 被拒（`WS:253-258`；启动参数同样报错），必须绑具体接口 IP；TLS 可用 `--tls-cert/--tls-key`（`WS:260-263,411-432`）。因此“公网直连”只能绑具体公网/LAN IP + TLS，或 loopback + 本机代理/隧道。
- **静态资源公开**：fallback 只为 root/index 调 `authorizeIndex`，其它 asset 直接读盘；`index.html` 本身要认证（`FS:50-77`，特别是 `61` 与 README 第 6-14 行“Non-index assets stay public”）。好处是无鉴权读不到页面与 RPC；风险是网络可达即可拿 JS/CSS/字体/manifest 做指纹（dist 中无 `.map`，已核实 0 个）。index 200 响应没有 `Cache-Control: no-store`（`FS:74`），共享缓存/中继可能缓存认证页面（引导数据含插件清单与 `__DSH_REMOTE_ACCESS__` owner 基线；Host 仍逐调用鉴权，故主要是信息泄露与 UI 误导）。
- **账号登录的 loopback 限制**：`startSignIn(client, callbackOrigin, …)` 把 `callbackOrigin` 限制为 `http://localhost|127.0.0.1|[::1]:<port>`，注释明说 “remote domains and path-based proxies are unsupported”（`ACC:308-329`）；浏览器端传 `window.location.origin`（`dsh-client-ui-settings-account/lib/client.js:4672`），OAuth 回调路由 `/oauth/callback` 注册在 DSH 自己的 webServer 上、只校验 32 字节随机 `state`（`ACC:992-1015,1016-1023`）。**结论：远程域名下无法完成 DeepSeek 账号登录**（会在 `loginOrigin` 抛 `protocol`）。这是现有功能的硬限制，不是安全漏洞；远程访问不能把 `/oauth/callback` 暴露到公网来“绕过”。
- 暴露面补充：默认请求体上限 **300 MiB**（`CC:30,1018,1031`），WS 每流上行缓冲 256 KiB（`GW:702`）；无速率限制；这些在公网/中继下都是 DoS 面。

### 1.8 dsh-api-remote-access：roles/resources/peers 与 owner-only

- 模型：`registerPolicy(kind, policy)` 为**非 owner** principal kind 注册 `bindings(principal)`（`{role, resource, condition?}`）与可选 `explain()`；role = `{name, resource, actions}`；resource kind 为 `global|session|workspace`（`RA:175-193`；`dsh-api-remote-access/lib/typert.host.js` 的 schema）。
- 判定：owner 与 `remoteAccess/follow` 永不检查；否则 **每一个**被解析出的资源上都要有 binding 命名该资源、role 列出该 action、condition 通过，才 allow（`RA:222-240`）；`bindings()` 每次决策重读、不缓存；list 方法用 `allows(resource)` 逐项过滤（`RA:252-261`）；快照只含无参可允许的 endpoint actions（`RA:383-405`），事件 action `event:<name>` 不进快照。
- 谁做判定：Gateway 在参数校验之后、lookup/Context 解析之前，对非 owner 调 `decide({principal,action,resources,args})`，拒绝抛 `remote-access/denied`（`GW:1171-1191`）；解析不出资源直接 `resource-invalid` 拒；事件按 `event:<name>` 对每帧资源判定，整帧投递或丢弃。
- **今天网络侧没有非 owner**：`PrincipalMap` 只有 `owner`（唯一合并点 `dsh-api-remote-access/lib/typert.host.js:146`），除 `RA` 自身外全仓无 `registerPolicy` 调用者；`/connect` 与 browser cookie 发布的都是 owner（`CC:714,781-791`）。远程能力必须新增 principal kind + policy，否则只能给 owner 全权。
- **仍硬编码 owner-only 的**：所有 exact Connection Fetch 路由对非 owner 一律 403（`CC:826-832`；README:84）；`$events` waterfall 回答/`$events/result` 仅 owner（`GW:963-969`）；收事件必须 `interactions=answer`（`GW:1453-1454`）；账号登录（`ACC:308-329`）。
- **实现风险**：直接注册在 webServer 上的路由只调 `connection.requestRejection(req)` 判断“已认证”，不区分 principal kind（例：`dsh-host-open-in-app/lib/index.js:1265-1272` 及其 1273-1340 的三个路由）。接入非 owner principal 时这些路由必须逐个补授权，否则远程只读设备可调用本机原生打开器。

## 2. 用户关切：每个可能“被骗”的位置逐条核对

| # | “自称 localhost”的位置 | DSH 是否相信？ | 实际效果 | 结论 |
|---|---|---|---|---|
| 1 | `Host: localhost`（或 127/8/`[::1]`） | 栅栏接受 | 仅放行到认证；无 cookie/token → 401（`CC:245,742-750`） | 不能冒充身份 |
| 2 | `Host` 为 bind IP | 栅栏接受（任意端口） | 同上，且 bind IP 不是 rebinding 目标 | 不能冒充身份 |
| 3 | `Host` 为 `trustedHosts` 条目 | 栅栏接受 | 同上；无端口条目放宽到同 host 任意端口（`CC:201-207`） | 只是 CSRF 白名单 |
| 4 | `X-Forwarded-For: 127.0.0.1`、`X-Real-IP` | **完全忽略** | 无任何代码读取（grep 零命中） | 不可能生效 |
| 5 | `Forwarded`/`X-Forwarded-Host`/`X-Forwarded-Proto` | **完全忽略** | cookie 的 Secure/scheme 只看 `WS.protocol`（`CC:452-455,347-350`；`WS:302-308`） | 不可能生效；也意味着反向代理下 cookie 不会自动变 Secure |
| 6 | WebSocket `Origin` | 必须同 authority（`CC:247-269`）；`Sec-Fetch-Site: cross-site` 拒（`CC:246`） | 恶意页面开 WS → 403；且 SameSite=Strict 不带 cookie | CSRF/WS hijack 防线 |
| 7 | DNS rebinding 页面发 fetch | 看 `Host`：攻击者域名不在 trustedHosts → 403 | 若 DSH 自己的域名被写进 trustedHosts 且该域名可被他人劫持/隧道商共享，则 Host 会通过；此时 cookie host-only **会**被带上、SameSite=Strict **也**放行（页面同 host）→ 可读 API | 必须自有稳定域名，禁止共享/可被他人绑定的 host 进 trustedHosts |
| 8 | 中继/反代 prepend 或改写头 | 转发头无效；`Host` 是代理配置产物 | 若中继把客户端 Host 原样透传，攻击者可自选 Host 过栅栏，但仍需 bearer；若中继伪造“XFF=127.0.0.1”无影响 | 头可信问题是“栅栏非身份”；不要加基于头的授权 |
| 9 | 本机恶意/同 uid 进程 | 不需要冒充 localhost | 可读 `$DSH_HOME/.credentials.yaml`（0600 但同 uid）伪造 HMAC cookie；可看终端打印的 launch token / 子进程 argv | 本地信任边界 = OS 用户；远程功能不得新增本机旁路 |
| 10 | `--host` 绑定 IP vs 公告 URL | 栅栏用 Host（浏览器 URL），公告 URL 不参与 | `publicUrl` 不授权；错配只会 403 或过期 cookie 名不匹配 | 公告 URL 不是信任来源 |
| 11 | 401 vs 403 顺序 | 栅栏先 403，再 401 | 形成“该 Host 是否受信 / cookie 是否有效”的 oracle（信息量小、无速率限制） | 可接受；远程入口建议统一 404/403 并限速 |
| 12 | 静态资源 | 公开 | 可无鉴权拿 JS/指纹；index 仍需认证 | 低危；远程中继不应代理整个 web UI |
| 13 | TLS SNI/证书与 Host 不一致 | Node TLS 不校验 Host | 仍需 cookie；不构成身份绕过 | 不依赖 TLS 证书做客户端授权 |

**真正建立身份的只有四样东西**：
1. 进程级 launch token（256-bit 随机，仅 `GET /` 与 `/connect`，定时安全比较：`CC:294-300,330-334,461-464,517-521`）；
2. 服务端 HMAC-SHA256 签名 cookie（密钥在 `.credentials.yaml`，authority+scheme+绝对过期绑定：`CC:306-316,335-337,347-350,559-569`）；
3. `/connect` 签发的 v2 API cookie（含 peer id，一 socket 所有权：`CC:525-537,756-776`）；
4. 进程内 `createPeer`（网络不可达，仅可信插件代码：`CC:752-754`）。
源 IP、Host、Origin、loopback 判定、TLS 证书都**不是**身份。栅栏只回答“要不要继续处理这个请求”，不回答“你是谁”。

**互联网暴露的四个缺口**：
- **G1 单 owner**：网络侧只有 owner 身份，没有只读/受限角色；中继或手机拿到浏览器 cookie = 主机完全控制（含执行工具、终端、会话记录）。
- **G2 凭证生命周期**：30 天、无登出（README:84）、无按设备撤销、无轮换（删记录+重启）、无速率限制；launch token 走 URL/控制台/子进程 argv，且 `--public-url` 会把它带到公网 URL（`CC:440-444`；`WA:161-166`）。
- **G3 传输**：无 mTLS/客户端证书；`X-Forwarded-Proto` 不被信任（正确），所以 TLS 终止型反代后面 cookie 不 `Secure`，反代到 DSH 一跳明文；无 HSTS/CSP。
- **G4 默认资源上限**：300 MiB body、无连接/频率限制（`CC:30,1018`）。

**中继介导的五条新增缺口**：
- R1 中继若是普通 HTTPS 反向代理：TLS 在它那里终止 → 它看到 cookie 与全部会话内容，还能注入/改写 → 等同于 owner 被接管。
- R2 中继若持久化或重放流量：无 E2E 时无法检测。
- R3 中继 hostname 若共享/可被第三方绑定（免费隧道、通配子域）：DNS rebinding 可让页面与 DSH 同 host，cookie 与 SameSite 都拦不住；trustedHosts 正好把它放进来。
- R4 中继与 DSH 同机/同容器且可读 `$DSH_HOME`：可直接拿 HMAC 密钥伪造任意 authority 的 cookie。
- R5 中继没有“设备”概念：无法按设备撤销/限权/审计，只能整体断链。

**三条铁律**：
- **铁律 1**：身份只来自密码学凭证（设备私钥、主机签发的短令牌、E2E 会话），绝不来自 Host / XFF / 源 IP / loopback 判定。
- **铁律 2**：中继只按不透明路由 id 转发帧，不终止内容层加密、不读明文、不落内容；App↔主机内层 E2E 永远存在。
- **铁律 3**：远程路径不复用浏览器 launch token/30 天 cookie，必须新 principal + 最小权限 policy + 独立路由 + 独立鉴权。
- **对中继的直接要求**：中继只能以密码学方式认证设备（设备私钥挑战/响应 + 与主机 E2E 握手绑定），**绝不**用 Host 头、`X-Forwarded-*`、源 IP 或“来自 loopback”来认证/授权；自托管中继同样按“不可信内容通道”对待（E2E、零明文、零内容持久化），只有路由与字节配额对它是可见的。

## 3. 威胁模型与攻击表

角色：网络攻击者（MITM/重放）、恶意网站（CSRF/rebinding/WS hijack）、诚实但好奇的中继运营者、完全恶意中继、被入侵的中继托管、手机被偷/解锁、笔记本被偷、恶意已配对设备、暴力破解者、DoS、供应链（中继镜像/App/更新）、日志/备份/遥测的读取者、本地同 uid 恶意进程。

| # | 攻击 | 前提 | 影响 | 缓解 | 残余风险 |
|---|---|---|---|---|---|
| 1 | 网络 MITM | 能截获链路 | 窃取 token/cookie/会话内容 | E2E（Noise XX/AEAD）+ 主机公钥 pinning；中继外 TLS 仅护中继认证 | 流量分析（时间/大小） |
| 2 | 恶意网站 CSRF | 用户浏览器已登录 DSH | 以 owner 身份发写请求 | SameSite=Strict + Origin 同 authority + `Sec-Fetch-Site` + Host 栅栏（`CC:240-269`）+ 无 CORS | 无 Origin 的旧浏览器/插件；但无 cookie 仍 401 |
| 3 | DNS rebinding | 页面域被解析到 DSH，且该域在 trustedHosts | 读 API/偷数据 | Host 栅栏拒非授信域；cookie host-only；禁止共享/可被他人绑定域名进 trustedHosts | DSH 域名本身被劫持 |
| 4 | WebSocket hijacking | 恶意页面开 WS | 读实时流/发指令 | WS 升级同样过 `admitConnection`（`GW:787-790`）；Origin 必须同 authority；Strict cookie | 非浏览器客户端无 Origin，但仍需 cookie |
| 5 | 诚实好奇中继看流量 | 中继终止外层 TLS | 读全部内容 | 中继盲转发 + 内层 E2E；不存内容；最小元数据 | 元数据（连接时间、字节数） |
| 6 | 恶意中继改/注入/重放 | 控制中继 | 篡改指令、劫持设备 | AEAD 防篡改 + 单调 nonce/序号 + 设备签名 + 主机指纹校验；路由令牌无内容授权 | 拒绝服务、流量分析 |
| 7 | 中继被入侵 | 服务器失陷 | 同上 + 路由令牌 | E2E；令牌短命且绑定设备/主机；可整体撤销；中继不持 `.credentials.yaml` | 可用性 |
| 8 | 手机被偷/解锁 | 物理接触 | 以该设备身份操作 | 生物识别门禁敏感操作；Keystore/Secure Enclave 不可导出；短令牌；远程撤销/擦除 | 解锁后社工/胁迫 |
| 9 | 笔记本被偷 | 物理接触 | 本机 owner 全权 | 全盘加密；浏览器 cookie 不落远程可读位置；远程撤销 | 本机信任 = OS 账户 |
| 10 | 恶意已配对设备 | 合法配对后滥用 | 权限内数据泄露/越权 | 按设备最小 role（只读/指定 session）；`remote-access` policy 逐资源判定；二次确认；审计 | 授权范围内的数据 |
| 11 | 重放/重连竞态 | 抓包/断线重连 | 重放指令、抢 socket | nonce+时间窗；会话密钥每连接新派生；一 socket 所有权 409（`CC:756-776`）；Peer dispose 关闭流 | 时间窗内重放 |
| 12 | 降级到明文 HTTP | 配置错误或强制降级 | cookie/内容泄露 | App 拒绝非 TLS；证书 pinning；HSTS；内层 E2E 不依赖外层 | 用户忽略警告 |
| 13 | APNs/FCM 元数据 | 推送服务可见 | 泄露沟通模式/设备关系 | payload 仅唤醒提示 + 不透明路由 id；正文走 E2E 拉取 | 推送时间/设备标识 |
| 14 | 供应链（中继镜像/App/更新） | 分发链污染 | 完全控制 | 签名发布+公证、SBOM、可复现构建、依赖 pinning、自动更新签名校验 | 上游 0day |
| 15 | 暴力破解配对码/token | 能连中继 | 配对劫持/冒充 | 256-bit 一次性配对密钥 + ≤120s + 单次 + 限速/锁定 + SAS 双向确认 | 用户误确认 |
| 16 | 资源耗尽 | 公网可达 | DoS/成本 | 中继侧连接数/速率/字节配额；调低 300 MiB body（`CC:30`）；保留 256 KiB 上行窗（`GW:702`）；超时 | 分布式 DoS |
| 17 | 日志/备份/遥测泄露 | 读取服务器或中继日志 | 内容/令牌泄露 | 永不记录 token/正文/配对密钥；审计只存内容哈希；备份加密；Web 端分析排除（`dsh-api-remotes/README.md:11`） | 运维误操作 |
| 18 | 中继静态/内存数据 | 中继落盘/取证 | 会话内容 | 中继不落内容，仅内存队列 + 短 TTL；E2E 使排队帧不可读 | 内存取证 |
| 19 | 多设备撤销不彻底 | 撤销延迟 | 旧 token 仍可用 | ≤15 分钟短令牌 + 撤销列表 + 立即 dispose Peer/断链 + 中继删路由 | 最长 15 分钟窗口 |
| 20 | 本机同 uid 恶意进程 | 同用户 | 读凭据伪造 cookie、读 token | 操作系统账户隔离；不新增弱本机旁路；`$DSH_HOME` 0600 | 本机信任边界本身 |
| 21 | 静态资源/指纹 | 网络可达 | 版本/插件指纹 | 无需鉴权也不给数据；可加认证/限速 | 低危 |
| 22 | 缓存型中继缓存认证页 | 中继做共享缓存 | 信息泄露/owner 基线 UI 误导 | index 加 `Cache-Control: no-store`（`FS:74` 当前缺失）；中继只转发不缓存 | 依赖中继配置 |

## 4. 推荐安全架构

### 4.1 设备身份与配对
- 每设备生成 **Ed25519（签名）+ X25519（ECDH）** 密钥对，私钥存 Secure Enclave / Android Keystore（StrongBox 优先），不可导出、可用时要求生物识别解锁；公钥在配对时由主机记录并 pin。
- 主机身份：首次启用远程时生成 Ed25519 主机密钥（新 host plugin 存储，0600），指纹 = `SHA-256(pubkey)` 的短 SAS（如 6 词/数字分组），显示在桌面端设置页与 QR 中。
- **QR 配对（桌面端发起，out-of-band 认证信道）**：QR 只含 `{relay 路由地址, 配对 ID, 一次性 256-bit 密钥, 主机指纹, 过期时间≤120s}`；一次性、单次使用、配对完成即作废。**禁止**把长期 token/浏览器 cookie 放进 QR 或 URL。
- 流程：App 扫码 → 用一次性密钥走 Noise XX（或 `crypto_kx`）与主机建立**已认证**通道（双方都验证对端静态公钥/指纹）→ App 提交设备公钥与设备名 → 主机显示 SAS/指纹，用户在桌面确认（双向确认，防中继/旁观者）→ 主机制备该设备的 role 与短令牌。
- 主机侧持久化：`device_id, pubkey, name, role, created_at, last_seen, revoked_at, push_hint`；不存设备私钥；配对密钥只用一次且不落盘明文。

### 4.2 信道与中继
- App↔主机：**Noise XX**（互相认证 + 每会话前向保密）或 libsodium `crypto_kx` + XChaCha20-Poly1305；内层帧含 `设备ID/序号/时间戳/类型/密文`；序号单调、窗口外拒绝，重连换新临时 X25519。
- 中继：只做“路由 id → 已认证设备连接”的盲转发；**不终止内容层 TLS**（外层 TLS 只保护 App↔中继的中继认证，或中继用独立 TLS 仅做认证）；不解密、不修改、不缓存内容；队列只在内存、短 TTL、按字节限额。
- 备选（若必须用 TLS 承载 E2E）：主机自签证书在配对时 pin，App 校验主机证书指纹；中继只能看到 TLS 到自己的外层，内层仍 Noise/AEAD——双层独立，任一层被破不泄内容。
- 主机端入口：**新 host plugin 自己注册路由与 upgrade，自己鉴权**，不经过 `/api` 的浏览器 cookie 语义；建议主机只监听 loopback，由本机中继客户端（或同机隧道）转出，避免 `--trusted-host` 扩大 Host 栅栏。

### 4.3 令牌、撤销、轮换
- 主机签发**短寿命 access token（≤15 分钟）**，绑定 `device_id + 设备公钥 + relay 路由 + 用途/资源范围`，设备私钥签名请求或 token 本身用主机密钥签；refresh token 绑定设备公钥、存 Keystore，仅能换取新 access token。
- 中继只认**每配对独立的路由 token**（可轮换、可撤销），该 token 不授予内容访问；中继侧做 per-token 限速、失败锁定、重放 nonce 去重。
- 撤销：主机吊销设备 → 立即删除中继路由 + deny refresh + dispose 该设备所有 Peer（`Peer.dispose` 会 abort signal 并关闭绑定 socket，参照 `GW:660-664`）+ 通知 App 清理本地密钥（best effort 远程擦除）；提供“全部设备下线/重新配对”。
- 轮换：设备密钥支持重配（重新 QR/SAS）；主机密钥轮换需重新配对 + 重新 pin；会话密钥每次连接新派生（前向保密），不复用长期密钥加密内容。
- 多设备：每设备独立身份与 role，桌面端可见设备列表/最后活跃/撤销；不存在共享 token。

### 4.4 推送、审计、日志、备份、遥测
- 推送只发**唤醒提示 + 不透明 ID**，不放会话 ID、消息内容、联系人、文件路径；正文一律经 E2E 拉取。APNs/FCM 凭证只在中继/推送服务，不进主机日志。
- 审计（主机侧）：只记 `时间/设备ID/动作/资源ID/结果/内容哈希`，不记正文与密钥；日志文件 0600、可轮换。
- 中继日志：路由 id、字节数、时间、错误码；不记设备公钥以外的身份、不记内容；保留期最小化。
- 备份：主机侧会话/配置备份必须加密；中继不做内容备份；App 不把 token 写进普通文件/日志/Crash 报告。

### 4.5 端点与服务器加固
- App：生物识别门禁“批准/破坏性动作”；截图保护（Android FLAG_SECURE、iOS 捕获检测提示，尽力而为）；剪贴板敏感内容短驻留/提示；jailbreak/root 只作为风险信号（评分/提示），**不作为唯一门禁**（避免误伤且易绕过）；证书/主机公钥 pinning；崩溃日志脱敏。
- 中继：TLS 1.2+/1.3、HSTS、禁用弱套件；无明文持久化；容器化/seccomp/只读根文件系统/非 root；最小网络暴露；每设备/每 IP 速率、连接数与字节配额；依赖 pinning + SBOM（SPDX/CycloneDX）+ 签名发布（Sigstore/cosign、SLSA）；镜像摘要固定。
- 主机侧 WS：保留 Host/Origin 栅栏与 SameSite/HttpOnly/Secure 作为纵深防御，但**不再作为远程授权依据**；给 index 加 `Cache-Control: no-store`；为公网路径下调 body 上限并加限速。

### 4.6 与现有本地信任模型的边界（用户硬要求）
- 不改动 launch token / cookie 的语义；不为远程新增“loopback 免认证”“受信中继注入头即受信”“Host=localhost 即 owner”任何分支。
- 远程 principal 是**新增受控主体**：不是 owner、不能回答 waterfall（`interactions:'none'`）、不能访问 exact Fetch 路由、不能触发账号登录、默认拒绝。
- 本地信任模型不变：本机同 uid 仍是完全信任边界；远程能力不扩大本机可被远程触发的动作集合，除非 owner 显式授权。

## 5. 需求 → DSH 实现落点（只映射位置，不写代码）

| 需求 | DSH 落点 | 说明 |
|---|---|---|
| 设备配对/身份/撤销存储 | 新 host plugin（如 `dsh-host-remote-device`），自建存储于 `$DSH_HOME` | 不要在 `dsh-client-connection` 里加分支；新插件注入 `credentials`/`webServer`，独立 0600 存储 |
| 远程入口路由/升级 | 用 `ctx.webServer.register` / `registerUpgrade`（`WS:327-347,433-466`）；自己实现认证 | 不要复用 `/api` 共享 FetchHandler 与浏览器 cookie；参考 Gateway 自注册 upgrade 的模式（`GW:787-820`） |
| E2E 握手/帧 | 新 host plugin 内部（Noise/AEAD）；App 端原生实现 | 主机不把明文交给中继；中继不依赖 DSH 实现 |
| 非 owner principal 与最小权限 | 声明合并 `PrincipalMap`（生成入口 `dsh-api-remote-access/lib/typert.host.js`）+ `ctx.remoteAccess.registerPolicy('device', …)`（`RA:175-193`） | role/resource/actions 粒度：session/read、session/append 等；owner-only 保持 |
| 远程调用 Peer | `ctx.connection.createPeer({principal:{kind:'device',…}, interactions:'none'})`（`CC:752-754`） | 远程 socket 绑定该 Peer；dispose 即断链（参照 `GW:660-664`） |
| 逐调用鉴权 | 无需改 Gateway：非 owner 自动走 `decide`（`GW:1171-1191`） | 资源解析来自 `@Remote({resources})`/typert.resources；漏标资源=漏检，需要审计每个远程可达 endpoint |
| 事件/流 | `$events` 需 `interactions=answer`（`GW:1453-1454`）→ 设备保持 `none`，只给它自己的 `remoteAccess/follow` 与显式 follow 流 | 不能收广播 waterfall；列表项用 `allows()` 过滤 |
| Web UI 远程化（可选） | 新 client plugin + `installConnection` 的 `createWebSocket/streamBaseUrl/ownsHost` 载体钩子（`CCB:1383-1425`） | `ownsHost` 只用于真正的本机壳；不得在远程壳置 `isLoopback=true` 来骗 UI |
| 配对 UI | 新 client plugin 注册到 web-app 浏览器插件名册（`dsh-web-app/cordis.patch.yml` 的 `dsh.client` 行） | 只在 owner 已认证的页面显示 QR；二维码 120s 自动失效 |
| CLI/配置 | `dsh-web-app/lib/startup.js` 增 flag（参照 `--trusted-host/--public-url` 模式，`startup.js:26,68`）+ `cordis.patch.yml` connection 行（`patch.yml:226-242`） | `publicUrl` 保持“grants no trust”；不要把远程开关做成默认开 |
| TLS/HSTS/安全头 | `dsh-host-webserver`（`WS:260-263,411-432`）或中继边缘 | 不引入 `X-Forwarded-Proto` 信任；Secure 仍只由监听器 TLS 决定（`CC:452-455`） |
| 限速/DoS | 中继边缘（新服务）+ 主机侧下调 `maxRequestBodyBytes`（`CC:30,1018`）与连接数 | Gateway 已有 `streamInboxBytes=256 KiB`（`GW:702`）与心跳超时，可复用 |
| 审计/日志 | 新 host plugin JSONL（`$DSH_HOME`，0600） | 内容哈希而非内容；与 `dsh-session-*` 持久化分离，避免中继触达 |
| 账号登录 | 维持 loopback 限制（`ACC:308-329`）；远程禁用 `account/startSignIn`，非 owner policy 不授予 | 若必须远程登录，另立设备码/OAuth device flow，禁止把 `/oauth/callback` 暴露公网 |
| 路由鉴权审计 | 现有直接 webserver 路由（如 `dsh-host-open-in-app/lib/index.js:1261-1340`） | 它们只查“已认证”不查 principal kind，必须补 policy 或对非 owner 拒绝 |

## 6. 安全基线：MUST / SHOULD / NICE 与明确拒绝的反模式

**MUST（不满足不得上线）**
1. App↔主机 E2E（Noise XX 或 `crypto_kx`+AEAD）；中继不可读改内容，主机公钥配对时 pin。
2. 设备私钥在 Secure Enclave/Keystore 生成且不可导出；每设备独立 Ed25519+X25519。
3. QR 配对：≤120s、单次、一次性 256-bit 密钥 + 主机指纹 + 桌面 SAS 双向确认；QR/URL 中无长期令牌。
4. 主机签发 ≤15 分钟设备令牌并绑定设备公钥/路由；远程不使用浏览器 launch token 或 30 天 cookie。
5. 新 non-owner principal + 逐资源 policy；默认拒绝；owner-only 能力（exact Fetch、waterfall 回答、账号登录）不向远程开放。
6. 每设备撤销 + 立即断链 + 中继删路由 + 短令牌；支持全部设备下线。
7. 中继只转发不透明帧、不落内容、不持主机密钥/凭据；中继与 DSH 不同机或至少不共享 `$DSH_HOME`。
8. 传输拒绝明文：中继边缘 TLS1.2+ 与 HSTS；App 拒绝非 TLS；不依赖 `X-Forwarded-Proto`。
9. 配对/中继认证限速、锁定、重放 nonce；连接数/字节配额；下调公网 body 上限。
10. 不记录 token/正文/配对密钥；审计仅内容哈希；备份加密；Web 端分析排除。
11. 远程可信域名必须是自有稳定域名；禁止通配/可被他人绑定域名进 `trustedHosts`。
12. 中继/App 签名发布 + SBOM + 依赖锁定 + 更新签名校验。

**SHOULD**
- 生物识别门禁敏感操作；截图保护/剪贴板卫生；jailbreak/root 作为风险信号。
- HSTS preload、证书/主机公钥 pinning；内层 E2E 之外再套 TLS（双保险）。
- 前向保密（每会话临时 X25519）；主机/设备密钥轮换流程；多设备管理 UI。
- 中继 seccomp/容器隔离/只读根；依赖漏洞扫描与周期渗透测试。
- 设备级配额与异常连接告警；审计可导出与保留策略。
- index/API `Cache-Control: no-store`；主 UI 加 CSP/frame-ancestors。

**NICE**
- 硬件证明（App Attest/Play Integrity）作为风险评分而非唯一门禁。
- E2E 文件传输、透明日志/可验证发布、panic-wipe、按动作二次确认。
- 后量子混合密钥交换（X25519+ML-KEM）路线图。

**明确拒绝的反模式**
- 信任 `X-Forwarded-For/X-Real-IP/Forwarded/X-Forwarded-Host` 或源 IP=127.0.0.1 做授权。
- `Host/X-Forwarded-Host == localhost ⇒ 受信/免认证`；任何“方法级 loopback 免认证层”。
- 给 `trustedHosts` 加通配、无端口条目泛滥、或把中继共享域名/用户可控域名写进去。
- 把 launch token 或长期 token 放进 QR/URL；把浏览器 cookie 直接给 App/中继用；30 天 owner cookie 放手机。
- 中继终止 TLS 却不做内层 E2E；中继侧明文存取会话；让中继能读 `.credentials.yaml`。
- 关闭 SameSite/HttpOnly/Secure；加 `Access-Control-Allow-Origin: *`；接受 `Authorization` 头 token（DSH 现在刻意不支持）。
- 绑 `0.0.0.0`/无 TLS 暴露；用 `X-Forwarded-Proto` 决定 Secure。
- 推送载荷带完整消息/会话标题；日志/分析/崩溃报告带 token 或内容。
- 把 `/oauth/callback` 暴露到公网以支持远程账号登录。
- 远程入口直接透传整个 `/api` 或整个 web UI；中继做成任意目标 DSH 的开放代理（confused deputy）。

## 7. 残余风险与未决问题

- 中继即使盲转发，仍可见连接元数据（时间、频率、字节量）；强匿名不是目标，需在隐私说明中声明。
- 手机解锁后的本地操作无法由密码学区分“本人 vs 拿到已解锁设备的人”，只能靠生物识别门控与撤销响应速度。
- 主机被物理控制/被 root 时远程能力无法提供保护；远程安全上限 = 主机 OS 安全。
- DSH 现有 300 MiB 默认 body、无速率限制、无 HSTS/CSP，需随远程功能一并整改（或由中继兜底）。
- 若产品要求“远程可看/可批”而非全 owner，需先定义 role/action 目录并逐 endpoint 审计资源声明（漏标资源即漏检，见 `GW` resources 机制）。
- 账号体系远程登录需要独立 device-code 流程，涉及平台 OAuth 变更，属产品级决策。
- 现有 loopback-origin 登录、native 目录选择、`SettingsDocumentStore` 等能力在远程页面会自动降级，需在 UI 明示“远程不可用”而不是静默失败。
- 中继自托管用户的运维质量（域名/TLS/更新）参差，建议默认模板 + 健康检查 + 安全默认值。

参考：OWASP ASVS 5.0（V6 认证、V9 通信、V11 密码学）、OWASP MASVS/MASTG（STORAGE/CRYPTO/AUTH/NETWORK/PLATFORM）、OWASP API Security Top 10（API1 BOLA、API2 Broken Auth、API8 Misconfig）、OWASP Top 10（A01/A02/A05/A07）、Noise Protocol Framework（XX 模式）、RFC 8446（TLS 1.3）、NIST SP 800-63B（认证器生命周期）、SLSA/Sigstore（发布完整性）、SPDX/CycloneDX（SBOM）。
