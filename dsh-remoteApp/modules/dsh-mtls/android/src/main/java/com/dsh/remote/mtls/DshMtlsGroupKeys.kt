// DshMtlsGroupKeys.kt
// DSH Remote — 群体服务版（A 模式）设备密钥：AndroidKeyStore P-256 + challenge 签名。
//
// 与主线 mTLS 身份（DshMtlsCsr，用于 B2 形态）**并存**：
//   - 群体版不签设备证书，只把 P-256 **公钥**（未压缩点 65B）登记到主机/relay；
//   - 之后用私钥签 relay challenge 换短时 token（docs/group-service-design.zh.md §7）。
//
// AndroidKeyStore 不能导出私钥；公钥不是秘密，因此以 base64url(65B) 缓存在本机
// SharedPreferences（按 alias），供 getGroupDevicePublicKey 读取。
//
// ⚠️ 本机无 Android SDK，未编译验证；需 `npx expo run:android` 在设备上验证。

package com.dsh.remote.mtls

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import java.math.BigInteger
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

object DshMtlsGroupKeys {
  private const val ANDROID_KEYSTORE = "AndroidKeyStore"
  private const val PREFS_NAME = "dsh_remote_group_keys"
  private const val DEFAULT_LABEL = "com.dsh.remote.group.device"
  private const val PREF_PUBLIC_PREFIX = "publicKey."

  @Volatile
  private var appContext: Context? = null

  fun initialize(context: Context) {
    appContext = context.applicationContext
  }

  data class Result(val publicKey: String, val label: String, val reused: Boolean)

  /** 空 label 用稳定默认值（幂等 key 的标识）。 */
  fun resolvedLabel(label: String?): String = if (label.isNullOrEmpty()) DEFAULT_LABEL else label

  /**
   * 生成或复用群体版 P-256 设备密钥；返回 base64url 未压缩点公钥（65B）。
   * 幂等：同 alias 已存在且公钥缓存可读时直接复用。
   */
  @Throws(Exception::class)
  fun generate(label: String?): Result {
    val alias = resolvedLabel(label)
    val keyStore = loadKeyStore()
    if (keyStore.containsAlias(alias)) {
      val stored = storedPublicKey(alias)
      if (stored != null) return Result(stored, alias, true)
      // 有私钥但公钥缓存缺失（异常状态）：删掉重建，避免返回错误公钥。
      keyStore.deleteEntry(alias)
    }
    val keyPair = generateKeyPair(alias)
    val publicKey = encodeUncompressedPoint(keyPair.public as ECPublicKey)
    storePublicKey(alias, publicKey)
    return Result(publicKey, alias, false)
  }

  /** 读取已存在设备公钥；不存在返回 null。 */
  fun getPublicKey(label: String?): String? = storedPublicKey(resolvedLabel(label))

  /** 对 message 原始字节做 ECDSA-SHA256（X9.62 DER），返回 base64url(DER)。 */
  @Throws(Exception::class)
  fun sign(label: String?, messageBase64: String): String {
    val alias = resolvedLabel(label)
    val privateKey = loadKeyStore().getKey(alias, null) as? PrivateKey
      ?: throw IllegalStateException("找不到群体版设备私钥（alias=$alias）")
    val signature = Signature.getInstance("SHA256withECDSA")
    signature.initSign(privateKey)
    signature.update(decodeBase64Any(messageBase64))
    return base64Url(signature.sign())
  }

  /** 删除群体版设备密钥（换设备身份/重置时用；幂等）。 */
  fun clear(label: String?): Boolean {
    val alias = resolvedLabel(label)
    try {
      val keyStore = loadKeyStore()
      if (keyStore.containsAlias(alias)) keyStore.deleteEntry(alias)
    } catch (_: Exception) {
      // 删除失败也不阻塞重置流程；下次 generate 会因 alias 存在但公钥缺失而重建。
    }
    prefs()?.edit()?.remove(PREF_PUBLIC_PREFIX + alias)?.apply()
    return true
  }

  // ---- key generation ----

  @Throws(Exception::class)
  private fun generateKeyPair(alias: String): KeyPair {
    fun makeKeyPair(strongBox: Boolean): KeyPair {
      val generator = KeyPairGenerator.getInstance(
        KeyProperties.KEY_ALGORITHM_EC,
        ANDROID_KEYSTORE
      )
      val builder = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
        .setDigests(KeyProperties.DIGEST_SHA256)
        .setUserAuthenticationRequired(false)
      if (strongBox) builder.setIsStrongBoxBacked(true)
      generator.initialize(builder.build())
      return generator.generateKeyPair()
    }
    return try {
      makeKeyPair(true)
    } catch (_: StrongBoxUnavailableException) {
      makeKeyPair(false)
    } catch (_: Exception) {
      makeKeyPair(false)
    }
  }

  private fun loadKeyStore(): KeyStore {
    val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE)
    keyStore.load(null)
    return keyStore
  }

  // ---- public key encoding ----

  private fun encodeUncompressedPoint(publicKey: ECPublicKey): String {
    val x = toFixed32(publicKey.w.affineX)
    val y = toFixed32(publicKey.w.affineY)
    val raw = ByteArray(65)
    raw[0] = 0x04
    x.copyInto(raw, 1, 0, 32)
    y.copyInto(raw, 33, 0, 32)
    return base64Url(raw)
  }

  /** BigInteger（可能带符号前导 0 / 少于 32 字节）→ 固定 32 字节大端。 */
  private fun toFixed32(value: BigInteger): ByteArray {
    val bytes = value.toByteArray()
    return when {
      bytes.size == 32 -> bytes
      bytes.size == 33 && bytes[0] == 0.toByte() -> bytes.copyOfRange(1, 33)
      bytes.size < 32 -> ByteArray(32 - bytes.size) + bytes
      else -> bytes.copyOfRange(bytes.size - 32, bytes.size)
    }
  }

  private fun base64Url(bytes: ByteArray): String =
    Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

  /** 同时接受标准 base64 与 base64url。 */
  private fun decodeBase64Any(value: String): ByteArray {
    val normalized = value.replace('-', '+').replace('_', '/')
    return Base64.decode(normalized, Base64.DEFAULT)
  }

  // ---- prefs (public keys only) ----

  private fun prefs() = appContext?.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  private fun storedPublicKey(alias: String): String? =
    prefs()?.getString(PREF_PUBLIC_PREFIX + alias, null)

  private fun storePublicKey(alias: String, publicKey: String) {
    prefs()?.edit()?.putString(PREF_PUBLIC_PREFIX + alias, publicKey)?.apply()
  }
}
