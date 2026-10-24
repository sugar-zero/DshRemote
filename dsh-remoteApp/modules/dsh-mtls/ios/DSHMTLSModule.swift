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
      Prop("jsCommand") { (view: DshMtlsWebView, command: String?) in
        view.applyJsCommand(command)
      }

      Events("onMessage", "onLoadingStart", "onLoadingFinish", "onLoadingError")
    }
  }
}
