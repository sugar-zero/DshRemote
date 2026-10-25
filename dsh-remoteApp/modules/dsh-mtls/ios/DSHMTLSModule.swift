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
