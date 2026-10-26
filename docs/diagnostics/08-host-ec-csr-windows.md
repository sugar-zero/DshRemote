# 08 — Windows 主机配对失败：`OID is not RSA` + `spawnSync openssl ENOENT`

快照：2026-10-26 · 涉及：host-plugin（`lib/identity.js`、新增 `lib/ec-csr.js`、`lib/tls-check.js`）

## 1. 现象

第二台主机（Windows）装好 host-plugin、填好 relay 地址/端口、hostId + host token、
并从 nginx 拷了同一套 `fullchain.pem` / `privkey.pem` 后，手机扫码配对失败：

```text
配对未完成 · 配对请求无效

CSR 解析失败（forge: Cannot read public key. OID is not RSA.;
openssl: openssl 校验 CSR 失败: spawnSync openssl ENOENT）

code: invalid_request
```

同机排查时还出现「TLS 证书与密钥不匹配」的怀疑（见第 4 节，属误报）。

## 2. 根因

配对时 App 提交设备 CSR，主机校验自签名并签发设备证书。设备密钥类型决定走哪条路：

| 设备密钥 | CSR 签名算法 | host-plugin 原实现 |
|---|---|---|
| RSA（AndroidKeyStore / 软件密钥） | `sha256WithRSAEncryption` | node-forge，全平台可用 |
| **EC P-256（iOS Secure Enclave）** | `ecdsa-with-SHA256` | forge 不支持 → 调系统 `openssl` 兜底 |

- node-forge 的 PKCS#10 解析只注册了 RSA 公钥（`publicKeyFromAsn1`），遇到 EC 的
  `id-ecPublicKey` 直接报 `Cannot read public key. OID is not RSA.`。
- 兜底的 `openssl` 在 **Windows 默认不存在**，`execFileSync('openssl', …)` 抛
  `spawnSync openssl ENOENT`。
- 两条路都失败 → 配对接口返回 `400 invalid_request`，与截图完全一致。

第一台 Mac 正常，是因为 macOS 自带 `/usr/bin/openssl`（实测 PATH 上为 Homebrew
OpenSSL 4.0.3），EC 兜底可用。**不是** hostId/token/端口/证书的问题——请求已经到达
主机插件并拿到了结构化 JSON 错误，说明 relay 转发与主机 TLS 都正常。

## 3. 修复

### 3.1 纯 JS 回退（核心）

新增 `dsh-remoteService/packages/host-plugin/lib/ec-csr.js`：

- 用 `forge.asn1` 解析 PKCS#10（注意：必须 `decodeBitStrings:false`，否则 ECDSA 的 DER
  签名会被 forge 误判成「composed」子节点而拿不到原始签名字节）；
- 取 `CertificationRequestInfo` 原始 DER 与 SPKI，用 `node:crypto.verify()` 校验自签名；
  只接受已知算法 OID（ECDSA/RSA 的 SHA-1/256/384/512、Ed25519），不做「解析失败就放行」；
- 解析时强制 PKCS#10 结构（顶层 3 元素、版本 0、`attributes [0]` 存在），避免「JS 比 openssl 宽松」；
  注意这比 openssl **严格**：完全缺 `attributes [0]` 的非合规 CSR 在无 openssl 的主机上会被拒
  （Apple/openssl 生成的合规 CSR 不受影响；如有第三方客户端踩到可放宽为「存在则校验」）；
- 签发：用 `forge.asn1` 构造 X.509 v3 TBSCertificate（issuer 从设备 CA 证书原样切出），
  用设备 CA 的 RSA 私钥以 `sha256WithRSAEncryption` 签名；
- 签发后自检：`X509Certificate.checkIssued()` + `verify(ca.publicKey)`、
  证书公钥与 CSR 公钥逐字节一致、serial 一致，任一不符即抛错。

### 3.2 引擎选择（安全语义）

`identity.js` 的 `parseDeviceCsr()` / `signDeviceCertificate()`：

1. RSA → forge（行为不变，`engine=forge`）；
2. 非 RSA → **优先 openssl**（`engine=openssl`）；
3. openssl **不可用**（`ENOENT`/`ENOTDIR`/`EACCES`）→ 纯 JS（`engine=js`）；
4. openssl **存在但明确拒绝**（签名不对/CSR 非法）→ **直接报错，不回退**（防止「坏 CSR
   在没装 openssl 的机器上被放行」）。
5. **openssl 通过后仍会复核**：只要 CSR 能被纯 JS 解析，就再用 `node:crypto` 独立验一次
   自签名；「openssl 说通过但 JS 验签失败」→ 拒绝。只有纯 JS 解析不了（未知算法）时才
   保留 openssl 的结论。
6. 签发侧对 openssl 任意失败会回退纯 JS：纯 JS 路径在签发前会**重新解析并校验 CSR 自签名**，
   所以回退不会放过坏 CSR（fail-closed）。

`engine` 会写日志/审计：回退时打
`openssl 不可用，已回退纯 JS 校验/签发 EC 设备证书`，便于判断某台主机走了哪条路。

### 3.3 主机 TLS 配置自检

新增 `lib/tls-check.js`，在启动监听前检查：

- **证书与私钥是否成对**：`X509Certificate.checkPrivateKey()`（RSA/EC 都支持）；
  不匹配时 `lastError = TLS 证书与私钥不匹配：证书公钥 <hash>，私钥公钥 <hash>…`
  并**不启动**监听（DSH 管理页「最近错误」可见）；
- **SAN 是否覆盖 `<hostId>.<relayDomain>`**：不覆盖时给出告警（握手会失败，否则手机只表现为
  「无法连接」）；
- fullchain 多证书时只看第一张（叶子）。

### 3.4 兼容性

- 非 RSA 设备公钥指纹改为 **SPKI 公钥的 SHA-256**（与 RSA 路径语义一致：同一把钥匙恒定；
  旧版是 CSR 内容哈希，同一把钥匙换一次 CSR 就会变）。`devices.json` 里的旧指纹只用于展示，
  不参与任何校验；
- RSA 路径与证书格式不变；版本号 host-plugin `0.1.6 → 0.1.7`。

## 4. 「TLS 证书与密钥不匹配」是误报

排查脚本/agent 常用：

```bash
openssl x509 -noout -modulus -in fullchain.pem | md5
openssl rsa -noout -modulus -in privkey.pem | md5
```

这套只适用于 RSA。本次两台主机的主机证书都是 **EC P-256**（LE 通配证书，私钥 241 字节），
实测：

```text
$ openssl x509 -in fullchain.pem -noout -modulus
Modulus=No modulus for this public key type

$ openssl rsa -in privkey.pem -noout -modulus
Not an RSA key
```

两条都失败 ≠ 不匹配。正确比对（两行应相同）：

```bash
openssl x509 -in fullchain.pem -noout -pubkey | openssl pkey -pubin -outform der | openssl dgst -sha256
openssl pkey -in privkey.pem -pubout -outform der | openssl dgst -sha256
```

本机（macOS 主机）实测：两侧 SHA-256 相同、`X509Certificate.checkPrivateKey()` 为 `true`、
`-checkhost <hostId>.<relayDomain>` 匹配、relay 连接 ESTABLISHED —— **本机没有这个问题**。

另外从行为上也能反证：证书与私钥真不匹配时 Node 抛
`ERR_OSSL_X509_KEY_VALUES_MISMATCH`，插件根本不启动 TLS 监听、也不连 relay，手机连
TLS 都握不上，不可能收到主机的 JSON 配对错误。

## 5. 验证

- `cd dsh-remoteService && npm test`：**124/124** 通过（新增 EC CSR 纯 JS 回退 14 项、
  TLS 自检 7 项、EC 配对集成 1 项、service 级 2 项）；
- `npm run validate:artifacts`：通过；
- 纯 JS 签发的 EC 证书用 `openssl verify -CAfile` 验链通过，`openssl x509 -text` 显示
  `id-ecPublicKey`、`TLS Web Client Authentication`、`CA:FALSE`、正确 SKI；
- 模拟无 openssl（`PATH=''`）跑通「校验 + 签发」；openssl 可用时 `engine=openssl`，
  RSA CSR 仍 `engine=forge`；
- 篡改签名 / SPKI 与签名私钥不匹配的 CSR 在两条引擎下都被拒绝；openssl 明确拒绝的坏 CSR
  不会静默回退放行；
- 纯 JS 签发的 EC 证书在**真实 TLS 握手**里被主机 mTLS 校验通过（`createPeerVerifier`）；
- 用一个假的 `openssl` 脚本验证 fail-closed：退出码 1（明确拒绝）→ 配对拒绝；
  退出码 0 但不干活 + 篡改 CSR → 被「openssl 通过后的纯 JS 复核」拒绝；
- 用仓库自带 `poc/native-csr/gen-csr.swift`（与 App `modules/dsh-mtls` 同一实现）现场生成
  **真实 Apple 路径 CSR**：openssl 引擎与纯 JS 回退都接受，纯 JS 签发证书经 `openssl verify`
  验链通过、证书公钥与 CSR 公钥逐字节一致。

## 6. 落地

1. 更新 DSH 里的 remote-access 插件到 **0.1.7+**，**重启 DSH**；
2. Windows 主机不需要装 openssl（也可以装；装了会优先用）；
3. 主机证书/私钥无需重签：若「最近错误」提示不匹配，按第 4 节用公钥指纹重新核对，
   确认是同一目录、同一次签发的一对即可。
