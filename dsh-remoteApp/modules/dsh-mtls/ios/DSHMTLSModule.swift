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
//   generateCsr(commonName)             — NEXT MILESTONE (throws for now)
//   getDiagnostics()                    — label / presence / subject / expiry

import ExpoModulesCore
import WebKit

/// Thrown by `generateCsr` until the Secure Enclave key + CSR milestone lands.
final class DSHMTLSCsrNotImplementedException: Exception {
  override public var reason: String {
    "POC: 原生 CSR 生成尚未实现。设备身份需要手动导入（importP12，见 README），" +
      "下一里程碑将使用 Secure Enclave 生成 P-256 密钥并输出 PKCS#10 CSR。"
  }
}

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

    // MARK: - Next milestone

    AsyncFunction("generateCsr") { (_ commonName: String) -> [String: Any] in
      // TODO(next milestone): SecKeyCreateRandomKey (P-256, Secure Enclave) +
      // DER-encode and sign a PKCS#10 CSR; return { csrPem, label }.
      throw DSHMTLSCsrNotImplementedException()
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

      Events("onMessage", "onLoadingStart", "onLoadingFinish", "onLoadingError")
    }
  }
}
