// DshMtlsWebView.kt
// DSH Remote — POC: ExpoView wrapper around an Android WebView with an mTLS
// WebViewClient (client certificate from KeyChain/AndroidKeyStore), plus a
// small JS bridge and loading events.
//
// ⚠️ STATUS: POC / NOT COMPILED on this machine. Reviewed only.
//
// JS side (modules/dsh-mtls/src/index.ts):
//   <DshMtlsWebView url="https://<hostId>.<relayDomain>/"
//                   clientIdentityLabel={connection.certRef} />
//
// The bridge is exposed to the page as `window.dshMtlsBridge.postMessage(str)`
// (same name as the WKScriptMessageHandler on iOS).

package com.dsh.remote.mtls

import android.annotation.SuppressLint
import android.content.Context
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

class DshMtlsWebView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {

  // Event dispatchers — names must match `Events(...)` in DshMtlsModule.kt and
  // the TS props in modules/dsh-mtls/src/index.ts.
  val onMessage by EventDispatcher<Map<String, Any?>>()
  val onLoadingStart by EventDispatcher<Map<String, Any?>>()
  val onLoadingFinish by EventDispatcher<Map<String, Any?>>()
  val onLoadingError by EventDispatcher<Map<String, Any?>>()

  private var loadedUrl: String? = null
  private var injectedJavaScript: String? = null

  /** KeyChain/Keystore alias of the client identity (falls back to the module config). */
  var clientIdentityLabel: String? = null

  private val webViewClient = DshMtlsWebViewClient(
    identityLabelProvider = { clientIdentityLabel ?: DshMtlsIdentityStore.configuredLabel },
    onPageStarted = { url ->
      onLoadingStart(mapOf("url" to (url ?: loadedUrl)))
      injectedJavaScript?.let { script ->
        // POC: evaluated on every page start rather than at documentStart.
        // TODO: inject a <script> via shouldInterceptRequest or use
        // WebViewCompat.addDocumentStartJavaScript for proper ordering.
        webView.evaluateJavascript(script, null)
      }
    },
    onPageFinished = { url -> onLoadingFinish(mapOf("url" to (url ?: loadedUrl))) },
    onError = { code, description, url ->
      onLoadingError(mapOf("code" to code, "description" to description, "url" to (url ?: loadedUrl)))
    }
  )

  private val webView: WebView = WebView(context)

  init {
    webView.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
    addView(webView)

    with(webView.settings) {
      javaScriptEnabled = true
      domStorageEnabled = true
      // SDK 58 / RN 0.88: mixed content never allowed; the tunnel is HTTPS-only.
      mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
      allowFileAccess = false
      allowContentAccess = false
      setSupportMultipleWindows(false)
    }

    webView.webViewClient = webViewClient
    webView.addJavascriptInterface(Bridge { data ->
      onMessage(mapOf("data" to data, "url" to webView.url))
    }, BRIDGE_NAME)

    backgroundColor = 0x00000000
  }

  fun applyUrl(url: String?) {
    if (url.isNullOrEmpty() || url == loadedUrl) return
    loadedUrl = url
    webView.loadUrl(url)
  }

  fun applyInjectedJavaScript(script: String?) {
    injectedJavaScript = script
  }

  /** Bridge exposed to the page as `window.dshMtlsBridge`. */
  private class Bridge(private val onMessage: (String) -> Unit) {
    @JavascriptInterface
    fun postMessage(data: String) {
      onMessage(data)
    }
  }

  companion object {
    private const val BRIDGE_NAME = "dshMtlsBridge"
  }
}
