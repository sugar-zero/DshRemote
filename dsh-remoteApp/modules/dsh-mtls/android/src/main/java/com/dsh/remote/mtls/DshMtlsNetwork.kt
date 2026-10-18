// DshMtlsNetwork.kt
// DSH Remote — 用 AndroidKeyStore / KeyChain 里的设备身份发 HTTPS 请求（客户端证书 mTLS）。
//
// 对应 iOS 的 DSHMTLSNetwork.swift：push token 注册、/pair/status、设备列表等
// 需要设备证书的调用。
//
// ⚠️ 本机无 Android SDK，未编译验证；需 `npx expo run:android` 在设备上验证。
//    URLSession 版本的同一机制已在 macOS 独立验证（dsh-remoteService/poc/webview-mtls）。

package com.dsh.remote.mtls

import android.content.Context
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.security.Principal
import java.security.PrivateKey
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509ExtendedKeyManager

object DshMtlsNetwork {
  @Throws(Exception::class)
  fun request(context: Context, options: Map<String, Any?>): Map<String, Any?> {
    val urlString = options["url"] as? String
      ?: throw IllegalArgumentException("requestWithClientCert: url 必填")
    val method = (options["method"] as? String) ?: "GET"
    val rawHeaders = options["headers"] as? Map<*, *> ?: emptyMap<Any?, Any?>()
    val headers = rawHeaders.entries.associate { it.key.toString() to it.value.toString() }
    val body = options["body"] as? String
    val alias = DshMtlsIdentityStore.configuredLabel
      ?: throw IllegalStateException("还没有配置设备身份（请先完成配对）")
    val identity = DshMtlsIdentityStore.resolveIdentity(context, alias)
      ?: throw IllegalStateException("找不到设备证书/私钥（alias=$alias）")

    val keyManager = DeviceIdentityKeyManager(alias, identity)
    val trustManagerFactory = TrustManagerFactory
      .getInstance(TrustManagerFactory.getDefaultAlgorithm())
      .apply { init(null as KeyStore?) }
    val sslContext = SSLContext.getInstance("TLS")
    sslContext.init(arrayOf(keyManager), trustManagerFactory.trustManagers, null)

    val connection = URL(urlString).openConnection() as HttpsURLConnection
    connection.sslSocketFactory = sslContext.socketFactory
    connection.requestMethod = method
    connection.connectTimeout = 20_000
    connection.readTimeout = 30_000
    for ((name, value) in headers) connection.setRequestProperty(name, value)
    if (body != null) {
      connection.doOutput = true
      connection.outputStream.use { stream -> stream.write(body.toByteArray(Charsets.UTF_8)) }
    }

    val status = connection.responseCode
    val stream = if (status in 200..299) connection.inputStream else connection.errorStream
    val responseBody = stream?.bufferedReader()?.use { it.readText() } ?: ""
    val responseHeaders = connection.headerFields
      .filterKeys { it != null }
      .mapValues { entry -> entry.value.joinToString(", ") }
    connection.disconnect()

    return mapOf(
      "status" to status,
      "headers" to responseHeaders,
      "body" to responseBody,
    )
  }

  /** 只提供一个客户端别名；证书链/私钥均来自 AndroidKeyStore 或系统 KeyChain。 */
  private class DeviceIdentityKeyManager(
    private val alias: String,
    private val identity: DshMtlsIdentityStore.ClientIdentity,
  ) : X509ExtendedKeyManager() {
    override fun getClientAliases(keyType: String?, issuers: Array<out Principal>?): Array<String> = arrayOf(alias)
    override fun chooseClientAlias(keyType: Array<out String>?, issuers: Array<out Principal>?, socket: java.net.Socket?): String = alias
    override fun getServerAliases(keyType: String?, issuers: Array<out Principal>?): Array<String>? = null
    override fun chooseServerAlias(keyType: String?, issuers: Array<out Principal>?, socket: java.net.Socket?): String? = null
    override fun getCertificateChain(alias: String?): Array<X509Certificate>? =
      if (alias == this.alias) identity.certificateChain else null
    override fun getPrivateKey(alias: String?): PrivateKey? =
      if (alias == this.alias) identity.privateKey else null
  }
}
