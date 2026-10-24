// DSHMTLSCsr.swift
// DSH Remote — 设备密钥（P-256 / Secure Enclave 优先）与 PKCS#10 CSR 生成。
//
// 与 `dsh-remoteService/poc/native-csr/gen-csr.swift` 同一实现（该 POC 已用
// openssl + host 插件真实 CA 验证：CSR 自签名、签发证书链、公钥一致性）。
//
// 安全约束：
//   - 私钥只进 Keychain/Secure Enclave，绝不返回 JS；
//   - CSR 里只含公钥与 CN；主机返回的证书由 DSHMTLSIdentityStore 安装。
//
// ⚠️ 本文件随 Expo 模块一起在用户 Mac 上由 Xcode 编译（本机未验证 iOS 编译）。

import Foundation
import Security

struct DSHMTLSCsrResult {
  let csrPem: String
  let keyLabel: String
  /// true = P-256 私钥由 Secure Enclave 持有（不可导出）；false = 软件 Keychain 回退。
  let secureEnclave: Bool
}

enum DSHMTLSCsrError: Error, LocalizedError {
  case keyGenerationFailed(String)
  case publicKeyExportFailed(String)
  case signingFailed(String)

  var errorDescription: String? {
    switch self {
    case .keyGenerationFailed(let detail):
      return "生成 P-256 设备密钥失败：\(detail)"
    case .publicKeyExportFailed(let detail):
      return "导出设备公钥失败：\(detail)"
    case .signingFailed(let detail):
      return "CSR 签名失败：\(detail)"
    }
  }
}

enum DSHMTLSDER {
  static func length(_ count: Int) -> Data {
    if count < 0x80 { return Data([UInt8(count)]) }
    var bytes: [UInt8] = []
    var value = count
    while value > 0 { bytes.insert(UInt8(value & 0xff), at: 0); value >>= 8 }
    return Data([0x80 | UInt8(bytes.count)] + bytes)
  }
  static func tlv(_ tag: UInt8, _ content: Data) -> Data {
    Data([tag]) + length(content.count) + content
  }
  static func sequence(_ items: [Data]) -> Data { tlv(0x30, items.reduce(Data(), +)) }
  static func set(_ items: [Data]) -> Data { tlv(0x31, items.reduce(Data(), +)) }
  static func integer(_ value: UInt8) -> Data { tlv(0x02, Data([value])) }
  static func oid(_ bytes: [UInt8]) -> Data { tlv(0x06, Data(bytes)) }
  static func utf8(_ text: String) -> Data { tlv(0x0c, Data(text.utf8)) }
  static func bitString(_ bytes: Data) -> Data { tlv(0x03, Data([0x00]) + bytes) }
  static func pem(_ der: Data, label: String) -> String {
    let body = der.base64EncodedString(options: [.lineLength64Characters, .endLineWithLineFeed])
    return "-----BEGIN \(label)-----\n\(body)\n-----END \(label)-----\n"
  }
}

enum DSHMTLSCsr {
  // OID: id-ecPublicKey / prime256v1 / ecdsa-with-SHA256 / commonName
  private static let oidEcPublicKey: [UInt8] = [0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01]
  private static let oidPrime256v1: [UInt8] = [0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07]
  private static let oidEcdsaWithSha256: [UInt8] = [0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x04, 0x03, 0x02]
  private static let oidCommonName: [UInt8] = [0x55, 0x04, 0x03]

  /// 生成 P-256 密钥（Secure Enclave 优先，失败回退软件 Keychain）并输出 PKCS#10 CSR。
  static func generate(commonName: String, keyLabel: String) throws -> DSHMTLSCsrResult {
    let tag = Data(keyLabel.utf8)
    let privateAttrs: [String: Any] = [
      kSecAttrIsPermanent as String: true,
      kSecAttrApplicationTag as String: tag,
      kSecAttrLabel as String: keyLabel,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let baseAttrs: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecPrivateKeyAttrs as String: privateAttrs,
    ]
    let secureEnclaveAttrs = baseAttrs.merging([kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave]) { $1 }
    var error: Unmanaged<CFError>?
    var privateKey = SecKeyCreateRandomKey(secureEnclaveAttrs as CFDictionary, &error)
    let usedSecureEnclave = privateKey != nil
    if privateKey == nil {
      error = nil
      privateKey = SecKeyCreateRandomKey(baseAttrs as CFDictionary, &error)
    }
    guard let key = privateKey, let publicKey = SecKeyCopyPublicKey(key) else {
      throw DSHMTLSCsrError.keyGenerationFailed(String(describing: error?.takeRetainedValue()))
    }
    var exportError: Unmanaged<CFError>?
    guard let publicKeyData = SecKeyCopyExternalRepresentation(publicKey, &exportError) as Data? else {
      throw DSHMTLSCsrError.publicKeyExportFailed(String(describing: exportError?.takeRetainedValue()))
    }
    let subject = DSHMTLSDER.sequence([
      DSHMTLSDER.set([DSHMTLSDER.sequence([DSHMTLSDER.oid(oidCommonName), DSHMTLSDER.utf8(commonName)])]),
    ])
    let subjectPublicKeyInfo = DSHMTLSDER.sequence([
      DSHMTLSDER.sequence([DSHMTLSDER.oid(oidEcPublicKey), DSHMTLSDER.oid(oidPrime256v1)]),
      DSHMTLSDER.bitString(publicKeyData),
    ])
    let certificationRequestInfo = DSHMTLSDER.sequence([
      DSHMTLSDER.integer(0),
      subject,
      subjectPublicKeyInfo,
      Data([0xA0, 0x00]), // [0] IMPLICIT SET OF Attribute — empty
    ])
    var signError: Unmanaged<CFError>?
    guard let signature = SecKeyCreateSignature(
      key,
      .ecdsaSignatureMessageX962SHA256,
      certificationRequestInfo as CFData,
      &signError
    ) as Data? else {
      throw DSHMTLSCsrError.signingFailed(String(describing: signError?.takeRetainedValue()))
    }
    let csr = DSHMTLSDER.sequence([
      certificationRequestInfo,
      DSHMTLSDER.sequence([DSHMTLSDER.oid(oidEcdsaWithSha256)]),
      DSHMTLSDER.bitString(signature),
    ])
    return DSHMTLSCsrResult(
      csrPem: DSHMTLSDER.pem(csr, label: "CERTIFICATE REQUEST"),
      keyLabel: keyLabel,
      secureEnclave: usedSecureEnclave
    )
  }
}
