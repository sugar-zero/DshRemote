// DSHMTLSModule.swift
// DSH Remote — POC Expo Module entry point: mTLS WebView + Keychain identity.
//
// ⚠️ STATUS: POC / NOT COMPILED on this machine (only Command Line Tools, no
// Xcode). Source is complete and reviewed, but must be built on the user's Mac
// (`npx expo prebuild && npx expo run:ios`) — see README.
//
// JS surface (modules/dsh-mtls/src/index.ts):
//   setClientIdentity(label)            — configure Keychain label for challenges
//   getClientIdentity()                 — current label
//   clearClientIdentity()               — forget label (identity stays in Keychain)
//   importP12(base64, password, label?) — POC dev helper (see DSHMTLSIdentityStore)
//   generateCsr(commonName)             — P-256 密钥（Secure Enclave 优先）+ PKCS#10 CSR
//   installCertificate(certPem,label)   — 安装主机签发的证书并关联设备私钥
//   requestWithClientCert(options)       — 用设备身份发 HTTPS 请求（push token / pair status）
//   getDiagnostics()                    — label / presence / subject / expiry
//
// 群体服务版（A 模式，token 鉴权；与 mTLS 并存）：
//   generateGroupDeviceKey(label?)       — P-256 设备密钥（Secure Enclave 优先，幂等）
//   getGroupDevicePublicKey(label?)      — 读取已存在的设备公钥（base64url 未压缩点）
//   signGroupChallenge(label, messageB64) — ECDSA-SHA256 签 relay challenge（DER→base64url）
//   clearGroupDeviceKey(label?)          — 删除设备密钥
//   setSessionCookie({url,name,value,...}) — 注入 `__Host-` 会话 cookie（Secure/SameSite=Strict/host-only）

import Dispatch
import ExpoModulesCore
import WebKit

public final class DSHMTLSModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DSHMTLS")

    // MARK: - Identity configuration

    Function("setClientIdentity") { (label: String) in
      DSHMTLSIdentityStore.shared.configuredLabel = label
    }

    Function("clearClientIdentity") {
      DSHMTLSIdentityStore.shared.configuredLabel = nil
    }

    AsyncFunction("getClientIdentity") { () -> String? in
      DSHMTLSIdentityStore.shared.configuredLabel
    }

    // MARK: - POC identity import (dev helper)

    AsyncFunction("importP12") { (p12Base64: String, password: String, label: String?) -> [String: Any?] in
      let resolvedLabel = label ?? DSHMTLSIdentityStore.shared.configuredLabel ?? "com.dsh.remote.device"
      return try DSHMTLSIdentityStore.shared.importP12(
        base64: p12Base64,
        password: password,
        label: resolvedLabel
      )
    }

    // MARK: - Device identity: Secure Enclave key + CSR + certificate install

    AsyncFunction("generateCsr") { (commonName: String) -> [String: Any] in
      let label = "com.dsh.remote.device.\(UUID().uuidString)"
      let result = try DSHMTLSCsr.generate(commonName: commonName, keyLabel: label)
      return ["csrPem": result.csrPem, "label": result.keyLabel, "secureEnclave": result.secureEnclave]
    }

    AsyncFunction("installCertificate") { (certPem: String, label: String?) -> [String: Any?] in
      let resolvedLabel = label ?? DSHMTLSIdentityStore.shared.configuredLabel ?? "com.dsh.remote.device"
      return try DSHMTLSIdentityStore.shared.installCertificate(certPem: certPem, label: resolvedLabel)
    }

    // MARK: - 群体服务版（A 模式）：P-256 设备密钥 / challenge 签名 / 会话 cookie
    //
    // 与主线 mTLS 身份并存：群体版不签设备证书，而是把 P-256 公钥登记到主机/relay，
    // 之后用私钥签 relay challenge 换短时 token（docs/group-service-design.zh.md §7）。

    /// 生成或复用群体版 P-256 设备密钥；返回 base64url 未压缩点公钥（65B）与是否 Secure Enclave。
    AsyncFunction("generateGroupDeviceKey") { (label: String?) -> [String: Any] in
      let result = try DSHMTLSGroupKeys.generate(label: label)
      return [
        "publicKey": result.publicKey,
        "label": result.label,
        "secureEnclave": result.secureEnclave,
        "reused": result.reused,
      ]
    }

    /// 读取已存在的群体版设备公钥；不存在返回 nil。
    AsyncFunction("getGroupDevicePublicKey") { (label: String?) -> String? in
      try DSHMTLSGroupKeys.publicKey(label: label)
    }

    /// 用群体版设备私钥对 message 的原始字节做 ECDSA-SHA256（X9.62 DER），返回 base64url(DER)。
    AsyncFunction("signGroupChallenge") { (label: String, messageBase64: String) -> [String: Any] in
      let signature = try DSHMTLSGroupKeys.sign(label: label, messageBase64: messageBase64)
      return ["signature": signature]
    }

    /// 删除群体版设备密钥（换身份/重置时用）。
    AsyncFunction("clearGroupDeviceKey") { (label: String?) -> Bool in
      DSHMTLSGroupKeys.clear(label: label)
    }

    /// 把 relay 下发的短时会话 token 写成 `__Host-` host-only cookie（群体版鉴权）。
    ///
    /// 说明：iOS 的 `HTTPCookie` 属性 API 无法表达 **HttpOnly**（WebKit 不允许程序化设置
    /// HttpOnly cookie）；HttpOnly 由 relay 的 `Set-Cookie` 在 WebView 内发请求时写入
    /// （见设计文档 §7），本方法用于 native 侧直接注入/续期。Secure / SameSite=Strict /
    /// Path=/ / host-only（不设 domain）均可表达。
    AsyncFunction("setSessionCookie") { (options: [String: Any], promise: Promise) in
      guard let urlString = options["url"] as? String,
            let url = URL(string: urlString),
            let name = options["name"] as? String, !name.isEmpty,
            let value = options["value"] as? String else {
        promise.reject("invalid-cookie-options", "setSessionCookie 需要 { url, name, value }")
        return
      }
      let maxAgeSeconds = (options["maxAgeSeconds"] as? NSNumber)?.doubleValue ?? 15 * 60
      DispatchQueue.main.async {
        var properties: [HTTPCookiePropertyKey: Any] = [
          .name: name,
          .value: value,
          .path: "/",
          .secure: "TRUE",
          .discard: "FALSE",
          .maximumAge: maxAgeSeconds,
          .originURL: url,
        ]
        if #available(iOS 13.0, *) {
          properties[.sameSitePolicy] = HTTPCookieStringPolicy.sameSiteStrict
        }
        guard let cookie = HTTPCookie(properties: properties) else {
          promise.reject("cookie-build-failed", "无法构造 HTTPCookie（url/name/value 是否合法？）")
          return
        }
        WKWebsiteDataStore.default().httpCookieStore.setCookie(cookie) {
          promise.resolve(true)
        }
      }
    }

    // MARK: - Authenticated HTTPS (client certificate)

    AsyncFunction("requestWithClientCert") { (options: [String: Any]) -> [String: Any] in
      guard let url = options["url"] as? String else { throw DSHMTLSNetworkError.invalidURL }
      let method = (options["method"] as? String) ?? "GET"
      let headers = (options["headers"] as? [String: String]) ?? [:]
      let body = options["body"] as? String
      return try DSHMTLSNetwork.request(urlString: url, method: method, headers: headers, body: body)
    }

    // MARK: - Diagnostics

    AsyncFunction("getDiagnostics") { () -> [String: Any?] in
      DSHMTLSIdentityStore.shared.diagnostics(label: nil)
    }

    // MARK: - WebView bridge / cache

    /// 把一段 JS 注入当前 mTLS WebView（App 点击推送后用它打开对应会话）。
    AsyncFunction("evaluateJavaScript") { (script: String) -> Bool in
      guard let view = DshMtlsWebView.activeView else { return false }
      view.evaluateJavaScript(script)
      return true
    }

    /// 清理 WKWebView 的持久化缓存 / Cookie / DOM 存储，并清空 URLCache。
    /// 设置页“清理缓存”调用；完成后由 JS 侧重载 WebView。
    /// 用 Promise 在 removeData 完成回调后 resolve(true)，不再阻塞 expo-modules-core 的
    /// 全局 AsyncFunction 队列；10s 兜底 resolve(false)，避免设置页一直停在 busy 状态。
    AsyncFunction("clearWebCache") { (promise: Promise) in
      // removeData 的完成回调与超时兜底都回到 main queue；settled 只在 main queue 读写。
      DispatchQueue.main.async {
        var settled = false
        let finish: (Bool) -> Void = { result in
          guard !settled else { return }
          settled = true
          promise.resolve(result)
        }
        WKWebsiteDataStore.default().removeData(
          ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
          modifiedSince: .distantPast
        ) {
          DispatchQueue.main.async {
            URLCache.shared.removeAllCachedResponses()
            finish(true)
          }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
          finish(false)
        }
      }
    }

    // MARK: - Custom mTLS-aware WebView

    View(DshMtlsWebView.self) {
      Prop("url") { (view: DshMtlsWebView, url: String?) in
        view.applyUrl(url)
      }
      Prop("clientIdentityLabel") { (view: DshMtlsWebView, label: String?) in
        view.clientIdentityLabel = label
      }
      Prop("injectedJavaScript") { (view: DshMtlsWebView, script: String?) in
        view.applyInjectedJavaScript(script)
      }

      Events("onMessage", "onLoadingStart", "onLoadingFinish", "onLoadingError")
    }
  }
}
