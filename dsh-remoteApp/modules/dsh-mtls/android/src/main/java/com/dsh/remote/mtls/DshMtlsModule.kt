// DshMtlsModule.kt
// DSH Remote — 原生模块入口（群体服务版 / A 模式，token 鉴权）。
//
// 历史原因保留模块名 `DSHMTLS`（减少工程改动），但模块内部只保留群体版能力：
//   generateGroupDeviceKey / getGroupDevicePublicKey / signGroupChallenge /
//   clearGroupDeviceKey / setSessionCookie / groupHttpFetch / clearWebCache
//
// classic/单体 mTLS 原生能力（CSR / PKCS#12 / 设备证书安装 / 原生 mTLS WebView /
// HttpsURLConnection 客户端证书请求）已从 App 删除：群体版设备身份只来自
// AndroidKeyStore 里的 P-256 设备密钥 + relay 签发的短时 token。

package com.dsh.remote.mtls

import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebViewDatabase
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Thrown when the native group-key/cookie API gets invalid input or is unavailable. */
class DshMtlsGroupException(message: String) : CodedException(message)

class DshMtlsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DSHMTLS")

    OnCreate {
      appContext.reactContext?.let {
        DshMtlsGroupKeys.initialize(it)
      }
    }

    // MARK: - 群体服务版（A 模式）：P-256 设备密钥 / challenge 签名 / 会话 cookie
    //
    // 群体版不签设备证书，只登记 P-256 公钥，之后用私钥签 relay challenge 换短时
    // token（docs/group-service-design.zh.md §7）。

    /// 生成或复用群体版 P-256 设备密钥；返回 base64url 未压缩点公钥（65B）。
    AsyncFunction("generateGroupDeviceKey") { label: String? ->
      val result = DshMtlsGroupKeys.generate(label)
      mapOf(
        "publicKey" to result.publicKey,
        "label" to result.label,
        "secureEnclave" to false,
        "reused" to result.reused
      )
    }

    /// 读取已存在的群体版设备公钥；不存在返回 null。
    AsyncFunction("getGroupDevicePublicKey") { label: String? ->
      DshMtlsGroupKeys.getPublicKey(label)
    }

    /// 用群体版设备私钥对 message 原始字节做 ECDSA-SHA256（X9.62 DER），返回 base64url(DER)。
    AsyncFunction("signGroupChallenge") { label: String, messageBase64: String ->
      mapOf("signature" to DshMtlsGroupKeys.sign(label, messageBase64))
    }

    /// 删除群体版设备密钥（换身份/重置时用；幂等）。
    AsyncFunction("clearGroupDeviceKey") { label: String? ->
      DshMtlsGroupKeys.clear(label)
    }

    /// 把 relay 下发的短时会话 token 写成 `__Host-` host-only cookie（群体版鉴权）。
    /// 不设置 Domain 即 host-only；Secure / HttpOnly / SameSite=Strict 由 CookieManager 字符串写入。
    AsyncFunction("setSessionCookie") { options: Map<String, Any?> ->
      val url = options["url"] as? String
        ?: throw DshMtlsGroupException("setSessionCookie 需要 { url, name, value }")
      val name = options["name"] as? String
        ?: throw DshMtlsGroupException("setSessionCookie 需要 { url, name, value }")
      val value = options["value"] as? String
        ?: throw DshMtlsGroupException("setSessionCookie 需要 { url, name, value }")
      if (name.isEmpty()) throw DshMtlsGroupException("setSessionCookie 的 name 不能为空")
      val maxAgeSeconds = (options["maxAgeSeconds"] as? Number)?.toLong() ?: (15 * 60L)
      val cookie = buildString {
        append(name)
        append('=')
        append(value)
        append("; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=")
        append(maxAgeSeconds)
      }
      CookieManager.getInstance().setCookie(url, cookie)
      CookieManager.getInstance().flush()
      true
    }

    /// 带 `__Host-dsh_session` 会话 cookie 的 HTTPS 请求（群体版隧道内的已鉴权内部接口）。
    ///
    /// relay 边缘对普通隧道流量只校验 `__Host-dsh_session` cookie；JS `fetch` 不会带上
    /// WebView CookieManager 里的 cookie，所以由原生显式设置 Cookie 头发请求。
    /// 只允许 https；返回 `{ status, body }`（body 为原始文本，JSON 解析交给 JS）。
    AsyncFunction("groupHttpFetch") { options: Map<String, Any?> ->
      val urlString = options["url"] as? String
        ?: throw DshMtlsGroupException("groupHttpFetch 需要 { url, token, method? }")
      val parsed = java.net.URL(urlString)
      if (!parsed.protocol.equals("https", ignoreCase = true)) {
        throw DshMtlsGroupException("groupHttpFetch 只允许 https 地址")
      }
      if (parsed.host.isNullOrEmpty()) {
        throw DshMtlsGroupException("groupHttpFetch 的 url 缺少主机名")
      }
      val token = options["token"] as? String
      if (token.isNullOrEmpty()) {
        throw DshMtlsGroupException("groupHttpFetch 需要有效的会话 token")
      }
      // token 会进入 Cookie / Authorization 头：只允许 base64url 安全字符（防头注入）。
      if (!Regex("^[A-Za-z0-9._~+/=-]+$").matches(token)) {
        throw DshMtlsGroupException("groupHttpFetch 的 token 含非法字符")
      }
      val method = ((options["method"] as? String) ?: "GET").uppercase()
      if (method != "GET" && method != "POST") {
        throw DshMtlsGroupException("groupHttpFetch 只支持 GET / POST")
      }
      val timeoutMs = (options["timeoutMs"] as? Number)?.toInt() ?: 15_000
      val connection = parsed.openConnection() as javax.net.ssl.HttpsURLConnection
      try {
        connection.requestMethod = method
        connection.connectTimeout = timeoutMs
        connection.readTimeout = timeoutMs
        connection.instanceFollowRedirects = false
        connection.setRequestProperty("Accept", "application/json")
        connection.setRequestProperty("Accept-Encoding", "identity")
        connection.setRequestProperty("Authorization", "Bearer $token")
        // relay 边缘按 cookie 放行（HttpOnly 只对浏览器有意义；这里与 Bearer 同一 token）。
        connection.setRequestProperty("Cookie", "__Host-dsh_session=$token")
        val body = options["body"] as? String
        if (body != null && body.isNotEmpty()) {
          connection.doOutput = true
          connection.setRequestProperty("Content-Type", "application/json")
          connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        }
        val status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
        mapOf("status" to status, "body" to text)
      } finally {
        connection.disconnect()
      }
    }

    // MARK: - WebView cache

    /// 清理 WebView 的 Cookie / 本地存储 / 表单数据 / HTTP 认证缓存。
    /// HTTP 磁盘缓存与 Cookie 的清理由 CookieManager/WebStorage/WebViewDatabase 完成；
    /// 没有活跃 WebView 实例时无法调用 app 级 clearCache，下次页面重建即可生效。
    AsyncFunction("clearWebCache") {
      CookieManager.getInstance().removeAllCookies(null)
      CookieManager.getInstance().flush()
      WebStorage.getInstance().deleteAllData()
      appContext.reactContext?.let { context ->
        WebViewDatabase.getInstance(context).clearHttpAuthUsernamePassword()
      }
      true
    }
  }
}
