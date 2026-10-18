// DshMtlsIdentityStore.kt
// DSH Remote — POC: Android Keystore / system KeyChain helpers for the device
// client identity used for mTLS.
//
// ⚠️ STATUS: POC / NOT COMPILED on this machine. Reviewed only.
//
// Two identity sources are supported by this POC skeleton:
//   1. System KeyChain (user-installed PKCS#12 via `KeyChain.createInstallIntent`)
//      — the dev path used to validate the mTLS WebView before the CSR milestone.
//   2. AndroidKeyStore aliases — the FINAL path: the key pair is generated
//      on-device with KeyGenParameterSpec and cannot be exported; the host-signed
//      certificate is installed alongside it.
//
// TODO(next milestone): generate the P-256 key pair in AndroidKeyStore and
// install the certificate returned by /__dsh_remote/pair. AndroidKeyStore does
// not allow importing external private keys, so `importP12` is intentionally a
// system-installer (user confirmation) flow, not a silent import.

package com.dsh.remote.mtls

import android.content.Context
import android.content.Intent
import android.security.KeyChain
import android.util.Base64
import java.security.KeyStore
import java.security.PrivateKey
import java.security.cert.X509Certificate
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

object DshMtlsIdentityStore {
  private const val PREFS_NAME = "dsh_remote_mtls"
  private const val KEY_CONFIGURED_LABEL = "configuredIdentityLabel"
  private const val ANDROID_KEYSTORE = "AndroidKeyStore"

  const val nativeBuild: String = "DSHMTLS/0.1.0 POC (android)"

  @Volatile
  private var appContext: Context? = null

  fun initialize(context: Context) {
    appContext = context.applicationContext
  }

  /** KeyChain/Keystore alias the WebView presents for client certificate challenges. */
  var configuredLabel: String?
    get() {
      val context = appContext ?: return null
      return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        .getString(KEY_CONFIGURED_LABEL, null)
    }
    set(value) {
      val context = appContext ?: return
      context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        .edit()
        .apply {
          if (value == null) {
            remove(KEY_CONFIGURED_LABEL)
          } else {
            putString(KEY_CONFIGURED_LABEL, value)
          }
        }
        .apply()
    }

  // MARK: - System KeyChain (user-installed PKCS#12)

  /**
   * Build the system certificate-installer intent for a PKCS#12 blob.
   * The OS prompts the user for confirmation (and the PKCS#12 password).
   */
  fun createP12InstallIntent(context: Context, p12Base64: String): Intent {
    val bytes = Base64.decode(p12Base64, Base64.DEFAULT)
    return KeyChain.createInstallIntent().apply {
      putExtra(KeyChain.EXTRA_PKCS12, bytes)
      putExtra(KeyChain.EXTRA_NAME, "DSH Remote 设备证书")
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
  }

  /** Private key from the system KeyChain alias (may prompt/deny for locked keys). */
  fun getKeyChainPrivateKey(context: Context, alias: String): PrivateKey? = try {
    KeyChain.getPrivateKey(context, alias)
  } catch (_: Exception) {
    null
  }

  /** Certificate chain from the system KeyChain alias. */
  fun getKeyChainCertificateChain(context: Context, alias: String): Array<X509Certificate>? = try {
    KeyChain.getCertificateChain(context, alias)
  } catch (_: Exception) {
    null
  }

  // MARK: - AndroidKeyStore (final on-device identity path)

  fun getAndroidKeyStorePrivateKey(alias: String): PrivateKey? = try {
    loadAndroidKeyStore().getKey(alias, null) as? PrivateKey
  } catch (_: Exception) {
    null
  }

  fun getAndroidKeyStoreCertificate(alias: String): X509Certificate? = try {
    loadAndroidKeyStore().getCertificate(alias) as? X509Certificate
  } catch (_: Exception) {
    null
  }

  private fun loadAndroidKeyStore(): KeyStore {
    val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE)
    keyStore.load(null)
    return keyStore
  }

  // MARK: - Lookup used by the WebView client

  data class ClientIdentity(
    val privateKey: PrivateKey,
    val certificateChain: Array<X509Certificate>
  )

  /** Resolve the identity for `onReceivedClientCertRequest` (KeyChain first, then AndroidKeyStore). */
  fun resolveIdentity(context: Context, alias: String): ClientIdentity? {
    val keyChainChain = getKeyChainCertificateChain(context, alias)
    val keyChainKey = getKeyChainPrivateKey(context, alias)
    if (keyChainKey != null && keyChainChain != null && keyChainChain.isNotEmpty()) {
      return ClientIdentity(keyChainKey, keyChainChain)
    }

    val keyStoreKey = getAndroidKeyStorePrivateKey(alias)
    val keyStoreCertificate = getAndroidKeyStoreCertificate(alias)
    if (keyStoreKey != null && keyStoreCertificate != null) {
      return ClientIdentity(keyStoreKey, arrayOf(keyStoreCertificate))
    }
    return null
  }

  /**
   * 安装主机签发的设备证书到 AndroidKeyStore（与 CSR 生成的私钥 alias 关联）。
   * 说明：AndroidKeyStore 不允许导入外部私钥，但允许把证书链 setKeyEntry 到已有私钥上。
   */
  @Throws(Exception::class)
  fun installCertificate(context: Context, certPem: String, alias: String): Map<String, Any?> {
    val certificate = parseCertificatePem(certPem)
      ?: throw IllegalStateException("主机返回的设备证书不是合法 PEM/DER")
    val keyStore = loadAndroidKeyStore()
    val privateKey = keyStore.getKey(alias, null) as? PrivateKey
      ?: throw IllegalStateException("找不到与设备证书匹配的私钥（alias=$alias）")
    keyStore.setKeyEntry(alias, privateKey, null, arrayOf(certificate))
    configuredLabel = alias
    return diagnostics(context)
  }

  /** PKCS#7/X.509 PEM 单证书解析（忽略头尾行）。 */
  fun parseCertificatePem(certPem: String): X509Certificate? = try {
    val base64 = certPem.lineSequence()
      .filter { !it.startsWith("-----") }
      .joinToString("")
    val der = Base64.decode(base64, Base64.DEFAULT)
    val factory = java.security.cert.CertificateFactory.getInstance("X.509")
    factory.generateCertificate(der.inputStream()) as X509Certificate
  } catch (_: Exception) {
    null
  }

  // MARK: - Diagnostics (never returns key material)

  fun diagnostics(context: Context?): Map<String, Any?> {
    val label = configuredLabel
    if (context == null || label == null) {
      return mapOf(
        "configuredIdentityLabel" to label,
        "identityPresent" to false,
        "subject" to null,
        "notAfter" to null,
        "nativeBuild" to nativeBuild
      )
    }
    val chain = getKeyChainCertificateChain(context, label)
    val leaf = chain?.firstOrNull() ?: getAndroidKeyStoreCertificate(label)
    val hasKey = getKeyChainPrivateKey(context, label) != null ||
      getAndroidKeyStorePrivateKey(label) != null
    return mapOf(
      "configuredIdentityLabel" to label,
      "identityPresent" to (hasKey && leaf != null),
      "subject" to leaf?.subjectDN?.name,
      "notAfter" to leaf?.notAfter?.let { formatDate(it) },
      "nativeBuild" to nativeBuild
    )
  }

  fun deleteIdentity(alias: String) {
    val context = appContext ?: return
    try {
      KeyChain.getPrivateKey(context, alias)?.let { /* KeyChain entries are removed by the OS */ }
    } catch (_: Exception) {
      // Ignore: deletion is a next-milestone concern.
    }
    // TODO(next milestone): AndroidKeyStore deleteEntry(alias) for on-device keys.
  }

  private fun formatDate(date: Date): String =
    SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
      .apply { timeZone = TimeZone.getTimeZone("UTC") }
      .format(date)
}
