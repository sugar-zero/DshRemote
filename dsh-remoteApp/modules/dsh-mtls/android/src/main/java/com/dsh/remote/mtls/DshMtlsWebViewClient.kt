// DshMtlsWebViewClient.kt
// DSH Remote — POC: WebViewClient that answers TLS client-certificate requests
// with a KeyStore/KeyChain identity.
//
// ⚠️ STATUS: POC / NOT COMPILED on this machine. Reviewed only.
//
// This is the Android equivalent of iOS `WKNavigationDelegate.didReceive
// (NSURLAuthenticationMethodClientCertificate)`:
//   WebViewClient.onReceivedClientCertRequest(view, request) →
//   request.proceed(privateKey, certificateChain) or request.cancel().
//
// The host requires mTLS on every path except /__dsh_remote/pair after pairing.
// (The JS bridge lives in DshMtlsWebView.kt, not here.)

package com.dsh.remote.mtls

import android.graphics.Bitmap
import android.net.http.SslError
import android.webkit.ClientCertRequest
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient

class DshMtlsWebViewClient(
  private val identityLabelProvider: () -> String?,
  private val onPageStarted: (String?) -> Unit,
  private val onPageFinished: (String?) -> Unit,
  private val onError: (Int, String?, String?) -> Unit
) : WebViewClient() {

  override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
    super.onPageStarted(view, url, favicon)
    onPageStarted(url)
  }

  override fun onPageFinished(view: WebView?, url: String?) {
    super.onPageFinished(view, url)
    onPageFinished(url)
  }

  // API 23+ error callback.
  override fun onReceivedError(
    view: WebView?,
    request: WebResourceRequest?,
    error: WebResourceError?
  ) {
    super.onReceivedError(view, request, error)
    onError(error?.errorCode ?: -1, error?.description?.toString(), request?.url?.toString())
  }

  // Deprecated callback for older devices (kept for completeness).
  @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
  override fun onReceivedError(
    view: WebView?,
    errorCode: Int,
    description: String?,
    failingUrl: String?
  ) {
    super.onReceivedError(view, errorCode, description, failingUrl)
    onError(errorCode, description, failingUrl)
  }

  override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler?, error: SslError?) {
    // Never bypass TLS errors: if the handshake fails we surface it instead of
    // continuing, otherwise the mTLS security model would be silently weakened.
    onError(-1, "TLS 握手失败：${error?.primaryError ?: -1}（证书/客户端证书校验失败）", error?.url)
    handler?.cancel()
  }

  override fun onReceivedClientCertRequest(view: WebView?, request: ClientCertRequest?) {
    if (request == null) return
    val label = identityLabelProvider()
    if (label == null) {
      onError(-1, "未配置设备客户端证书（KeyChain/Keystore alias 为空）", request.host)
      request.cancel()
      return
    }
    val context = view?.context?.applicationContext
    if (context == null) {
      request.cancel()
      return
    }
    val identity = DshMtlsIdentityStore.resolveIdentity(context, label)
    if (identity == null) {
      onError(-1, "找不到设备客户端证书（alias: $label）", request.host)
      request.cancel()
      return
    }
    try {
      request.proceed(identity.privateKey, identity.certificateChain)
    } catch (error: Exception) {
      onError(-1, "出示客户端证书失败：${error.message}", request.host)
      request.cancel()
    }
  }
}
