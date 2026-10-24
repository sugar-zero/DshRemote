// DshMtlsModule.kt
// DSH Remote — POC Expo Module entry point: mTLS WebView + Keystore identity.
//
// ⚠️ STATUS: POC / NOT COMPILED on this machine (no Android SDK/Xcode).
// Reviewed only; build on the user's Mac with `npx expo run:android`.
//
// JS surface (modules/dsh-mtls/src/index.ts) is identical to iOS:
//   setClientIdentity / getClientIdentity / clearClientIdentity
//   importP12 / generateCsr (AndroidKeyStore P-256 + PKCS#10) / installCertificate
//   requestWithClientCert (push token / device list) / getDiagnostics
//   <DshMtlsWebView url clientIdentityLabel ... />
//
// Android realities the next milestone must handle (documented, not hidden):
//   - AndroidKeyStore cannot import externally generated private keys. The final
//     design generates the key pair INSIDE AndroidKeyStore (KeyGenParameterSpec,
//     PURPOSE_SIGN, EC P-256) and installs the host-signed certificate through
//     the system KeyChain installer (user confirmation), then presents the
//     AndroidKeyStore key + certificate chain in onReceivedClientCertRequest.
//   - This POC supports KeyChain-imported identities (PKCS#12 via the system
//     installer) as a dev path; see DshMtlsIdentityStore.

package com.dsh.remote.mtls

import android.content.Intent
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Thrown when the POC cannot import/install a client identity. */
class DshMtlsIdentityException(message: String) : CodedException(message)

class DshMtlsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DSHMTLS")

    OnCreate {
      appContext.reactContext?.let { DshMtlsIdentityStore.initialize(it) }
    }

    // MARK: - Identity configuration

    Function("setClientIdentity") { label: String ->
      DshMtlsIdentityStore.configuredLabel = label
    }

    Function("clearClientIdentity") {
      DshMtlsIdentityStore.configuredLabel = null
    }

    AsyncFunction("getClientIdentity") {
      DshMtlsIdentityStore.configuredLabel
    }

    // MARK: - POC identity import (dev helper)

    AsyncFunction("importP12") { p12Base64: String, _password: String, label: String? ->
      val context = appContext.reactContext
        ?: throw DshMtlsIdentityException("POC: React context 不可用，无法导入设备身份。")
      val resolvedLabel = label ?: DshMtlsIdentityStore.configuredLabel
      // The system KeyChain installer prompts the user for the PKCS#12 password,
      // so `password` is currently only validated for presence.
      val intent: Intent = DshMtlsIdentityStore.createP12InstallIntent(context, p12Base64)
      val activity = appContext.currentActivity
        ?: throw DshMtlsIdentityException("POC: 当前没有 Activity，无法打开证书安装界面。")

      activity.runOnUiThread {
        activity.startActivity(intent)
      }
      if (resolvedLabel != null) {
        DshMtlsIdentityStore.configuredLabel = resolvedLabel
      }
      mapOf(
        "imported" to false,
        "pendingUserConfirmation" to true,
        "configuredIdentityLabel" to (resolvedLabel ?: DshMtlsIdentityStore.configuredLabel),
        "identityPresent" to false,
        "subject" to null,
        "notAfter" to null,
        "nativeBuild" to DshMtlsIdentityStore.nativeBuild
      )
    }

    // MARK: - Device identity: AndroidKeyStore key + CSR + certificate install

    AsyncFunction("generateCsr") { commonName: String ->
      val result = DshMtlsCsr.generate(commonName)
      mapOf("csrPem" to result.csrPem, "label" to result.alias)
    }

    AsyncFunction("installCertificate") { certPem: String, label: String? ->
      val context = appContext.reactContext
        ?: throw DshMtlsIdentityException("React context 不可用，无法安装设备证书。")
      val alias = label ?: DshMtlsIdentityStore.configuredLabel
        ?: throw DshMtlsIdentityException("没有可用的设备身份 alias。")
      DshMtlsIdentityStore.installCertificate(context, certPem, alias)
    }

    // MARK: - Authenticated HTTPS (client certificate)

    AsyncFunction("requestWithClientCert") { options: Map<String, Any?> ->
      val context = appContext.reactContext
        ?: throw DshMtlsIdentityException("React context 不可用，无法发起 mTLS 请求。")
      DshMtlsNetwork.request(context, options)
    }

    // MARK: - Diagnostics

    AsyncFunction("getDiagnostics") {
      DshMtlsIdentityStore.diagnostics(appContext.reactContext)
    }

    // MARK: - Custom mTLS-aware WebView

    View(DshMtlsWebView::class) {
      Prop("url") { view: DshMtlsWebView, url: String? ->
        view.applyUrl(url)
      }
      Prop("clientIdentityLabel") { view: DshMtlsWebView, label: String? ->
        view.clientIdentityLabel = label
      }
      Prop("injectedJavaScript") { view: DshMtlsWebView, script: String? ->
        view.applyInjectedJavaScript(script)
      }
      Prop("jsCommand") { view: DshMtlsWebView, command: String? ->
        view.applyJsCommand(command)
      }

      Events("onMessage", "onLoadingStart", "onLoadingFinish", "onLoadingError")
    }
  }
}
