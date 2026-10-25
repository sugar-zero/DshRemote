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
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams
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
  /** 渲染进程被系统回收后，这个 WebView 实例不可再使用（等 JS 重建原生视图）。 */
  private var renderProcessGone = false

  /** KeyChain/Keystore alias of the client identity (falls back to the module config). */
  var clientIdentityLabel: String? = null

  private val webViewClient = DshMtlsWebViewClient(
    identityLabelProvider = { clientIdentityLabel ?: DshMtlsIdentityStore.configuredLabel },
    onPageStarted = { url ->
      onLoadingStart(mapOf("url" to (url ?: loadedUrl)))
      if (!renderProcessGone) {
        injectedJavaScript?.let { script ->
          // POC: evaluated on every page start rather than at documentStart.
          // TODO: inject a <script> via shouldInterceptRequest or use
          // WebViewCompat.addDocumentStartJavaScript for proper ordering.
          webView.evaluateJavascript(script, null)
        }
      }
    },
    onPageFinished = { url ->
      onLoadingFinish(mapOf("url" to (url ?: loadedUrl)))
    },
    onError = { code, description, url ->
      onLoadingError(mapOf("code" to code, "description" to description, "url" to (url ?: loadedUrl)))
    },
    onRenderProcessGone = { didCrash ->
      // 默认实现会让 App 直接崩溃；这里把事件交给 JS（显示错误条并重建原生视图）。
      renderProcessGone = true
      val reasonText = if (didCrash) {
        "网页渲染进程崩溃，已停止使用该 WebView；请点「重试」重新加载。"
      } else {
        "系统回收了网页渲染进程（内存压力）；请点「重试」重新加载。"
      }
      onLoadingError(
        mapOf(
          "code" to -1,
          "description" to reasonText,
          "url" to loadedUrl,
          "reason" to "render-process-gone",
          "recoverable" to true
        )
      )
      // 返回 true 之后该 WebView 不可再碰：先从视图树摘掉，等 detach 时 destroy。
      (webView.parent as? ViewGroup)?.removeView(webView)
    }
  )

  private val webView: WebView = WebView(context)

  init {
    webView.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
    addView(webView)

    with(webView.settings) {
      javaScriptEnabled = true
      domStorageEnabled = true
      // Keep Android's default persistent HTTP cache: returning to the host or
      // relaunching the app should not re-download the DSH bundle.
      cacheMode = WebSettings.LOAD_DEFAULT
      setSupportZoom(false)
      builtInZoomControls = false
      displayZoomControls = false
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
    // 渲染进程已回收的 WebView 不可再用（loadUrl 会抛 IllegalStateException）。
    if (url.isNullOrEmpty() || url == loadedUrl || renderProcessGone) return
    loadedUrl = url
    webView.loadUrl(url)
  }

  fun applyInjectedJavaScript(script: String?) {
    injectedJavaScript = script
  }

  override fun onDetachedFromWindow() {
    // 渲染进程已死亡的 WebView 必须显式 destroy，否则其渲染进程资源会长期泄漏。
    if (renderProcessGone) {
      try { webView.destroy() } catch (_: Exception) { /* 已销毁 */ }
    }
    super.onDetachedFromWindow()
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
