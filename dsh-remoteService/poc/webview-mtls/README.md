# POC-1：WKWebView 客户端证书（mTLS）验证

本目录用 **macOS WKWebView + WKNavigationDelegate** 验证方案 B2 的最后一个高风险假设：

> 当 HTTPS 站点要求客户端证书时，`WKWebView` 会把 `NSURLAuthenticationMethodClientCertificate`
> 挑战交给 `WKNavigationDelegate.didReceive challenge`，App 能返回 `SecIdentity` 并完成 mTLS。

这与 iOS 上 DSH Remote App 使用的机制一致。iOS 真机还需要验证 Secure Enclave/Keychain 身份来源与
`npx expo run:ios` 构建，但 **"WKWebView 会走客户端证书挑战、且该 API 可被 App 接住"这一关键假设已在本机验证**。

## 运行

```bash
bash poc/webview-mtls/run.sh
```

前置：macOS + Command Line Tools（`swiftc`，无需完整 Xcode）。

流程：
1. `generate-certs.mjs` 用 node-forge 生成：CA、服务器证书（SAN 127.0.0.1）、客户端证书 + PKCS#12（密码 `poc-pass`）。
2. `server.mjs` 起 `https.createServer({requestCert:true, rejectUnauthorized:true})`，要求设备证书并回显 CN。
3. `wk-mtls.swift` 创建 WKWebView，导入 PKCS#12 到**临时 keychain**（不污染登录 keychain），
   在 delegate 里处理 server-trust（固定测试 CA）与 client-certificate 两类挑战，加载页面并断言返回
   `MTLS OK: dsh-poc-device`。

成功输出：

```
✅ WKWebView mTLS POC PASS：客户端证书挑战已由 WKNavigationDelegate 正确处理
```

## 与 iOS/App 的对应关系

| 本 POC（macOS） | iOS App（下一步） |
|---|---|
| `WKNavigationDelegate.didReceive challenge` | 同一方法（iOS 16.4+） |
| 临时 keychain 里的 `SecIdentity` | Keychain 里的设备证书 + Secure Enclave 私钥 |
| `URLCredential(identity:certificates:persistence:)` | 同样 API |
| 测试 CA 的 server trust | B2 公开 CA（relay 无法拿同名证书） |

## 产物

`.build/` 下的证书、编译产物与日志均为临时文件，已被 gitignore。
