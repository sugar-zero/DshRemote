// DshMtlsCsr.kt
// DSH Remote — AndroidKeyStore P-256 密钥 + PKCS#10 CSR（手写 DER，无第三方依赖）。
//
// 与 iOS 的 DSHMTLSCsr.swift 等价：
//   - 私钥生成在 AndroidKeyStore（StrongBox 可用时优先），不可导出；
//   - 公钥编码为 X.509 SubjectPublicKeyInfo（publicKey.encoded 原样嵌入 CSR）；
//   - 用 SHA256withECDSA 对 CertificationRequestInfo 签名。
//
// ⚠️ 本机无 Android SDK，未编译验证；需 `npx expo run:android` 在设备上验证。
//    iOS 同算法实现已由 openssl/host CA 验证（dsh-remoteService/poc/native-csr）。

package com.dsh.remote.mtls

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.UUID

object DshMtlsCsr {
  private val OID_COMMON_NAME = byteArrayOf(0x55, 0x04, 0x03)
  private val OID_ECDSA_WITH_SHA256 = byteArrayOf(
    0x2A, 0x86.toByte(), 0x48, 0xCE.toByte(), 0x3D, 0x04, 0x03, 0x02
  )

  data class Result(val csrPem: String, val alias: String)

  /** 生成 P-256 设备密钥（AndroidKeyStore）并返回 PKCS#10 CSR。 */
  @Throws(Exception::class)
  fun generate(commonName: String): Result {
    val alias = "com.dsh.remote.device." + UUID.randomUUID().toString()
    val keyPair = generateKeyPair(alias)
    val subject = derSequence(
      derSet(
        derSequence(
          derOid(OID_COMMON_NAME),
          derUtf8(commonName)
        )
      )
    )
    // publicKey.encoded 已经是 SubjectPublicKeyInfo (DER SEQUENCE)，直接嵌入。
    val subjectPublicKeyInfo = keyPair.public.encoded
    val certificationRequestInfo = derSequence(
      derIntegerZero(),
      subject,
      subjectPublicKeyInfo,
      byteArrayOf(0xA0.toByte(), 0x00) // [0] IMPLICIT SET OF Attribute（空）
    )
    val signature = Signature.getInstance("SHA256withECDSA")
    signature.initSign(keyPair.private)
    signature.update(certificationRequestInfo)
    val signatureBytes = signature.sign()
    val csr = derSequence(
      certificationRequestInfo,
      derSequence(derOid(OID_ECDSA_WITH_SHA256)),
      derBitString(signatureBytes)
    )
    return Result(csrPem = pem(csr), alias = alias)
  }

  @Throws(Exception::class)
  private fun generateKeyPair(alias: String): KeyPair {
    fun makeKeyPair(strongBox: Boolean): KeyPair {
      val generator = KeyPairGenerator.getInstance(
        KeyProperties.KEY_ALGORITHM_EC,
        "AndroidKeyStore"
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
      // 部分设备/模拟器不接受 StrongBox，回退到 TEE/软件支持的 AndroidKeyStore。
      makeKeyPair(false)
    }
  }

  // ---- Minimal DER encoder ----

  private fun derLength(length: Int): ByteArray {
    if (length < 0x80) return byteArrayOf(length.toByte())
    var value = length
    val bytes = ArrayList<Byte>()
    while (value > 0) {
      bytes.add(0, (value and 0xff).toByte())
      value = value shr 8
    }
    return byteArrayOf((0x80 or bytes.size).toByte()) + bytes.toByteArray()
  }

  private fun derTlv(tag: Int, content: ByteArray): ByteArray =
    byteArrayOf(tag.toByte()) + derLength(content.size) + content

  private fun derSequence(vararg items: ByteArray): ByteArray =
    derTlv(0x30, items.reduce { acc, item -> acc + item })

  private fun derSet(vararg items: ByteArray): ByteArray =
    derTlv(0x31, items.reduce { acc, item -> acc + item })

  private fun derIntegerZero(): ByteArray = byteArrayOf(0x02, 0x01, 0x00)

  private fun derOid(bytes: ByteArray): ByteArray = derTlv(0x06, bytes)

  private fun derUtf8(value: String): ByteArray = derTlv(0x0C, value.toByteArray(Charsets.UTF_8))

  private fun derBitString(bytes: ByteArray): ByteArray = derTlv(0x03, byteArrayOf(0x00) + bytes)

  private fun pem(der: ByteArray): String {
    val base64 = Base64.encodeToString(der, Base64.NO_WRAP)
    val wrapped = base64.chunked(64).joinToString("\n")
    return "-----BEGIN CERTIFICATE REQUEST-----\n$wrapped\n-----END CERTIFICATE REQUEST-----\n"
  }
}
