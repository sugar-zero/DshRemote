// DSHMTLSGroupKeys.swift
// DSH Remote — 群体服务版（A 模式）设备密钥：P-256 设备身份 + 挑战签名。
//
// 与现有 mTLS 身份（DSHMTLSCsr / DSHMTLSIdentityStore，用于主线的 B2 形态）**并存**：
//   - 群体版不再签设备证书，而是把 P-256 **公钥**（未压缩点 65B）登记到主机/relay；
//   - 之后用私钥签 relay challenge 换短时 token（见 docs/group-service-design.zh.md §7）。
//
// 安全约束：
//   - 私钥只进 Keychain / Secure Enclave，绝不返回 JS；
//   - 返回值只有公钥（base64url 未压缩点）与签名（base64url DER）。
//
// ⚠️ 本文件随 Expo 模块一起在用户 Mac 上由 Xcode 编译（本机仅 `swiftc -parse` 语法自检）。

import Foundation
import Security

/// 群体版设备密钥的生成/复用/签名结果。
struct DSHMTLSGroupKeyResult {
  /// base64url(X9.63 未压缩 P-256 点，65 字节 0x04||X||Y)
  let publicKey: String
  let label: String
  /// true = 私钥由 Secure Enclave 持有；false = 软件 Keychain 回退。
  let secureEnclave: Bool
  /// true = 复用了同 label 已存在的密钥（幂等）。
  let reused: Bool
}

enum DSHMTLSGroupKeyError: Error, LocalizedError {
  case keyGenerationFailed(String)
  case publicKeyExportFailed(String)
  case signingFailed(String)
  case missingPrivateKey(String)
  case invalidMessageBase64

  var errorDescription: String? {
    switch self {
    case .keyGenerationFailed(let detail):
      return "生成群体版 P-256 设备密钥失败：\(detail)"
    case .publicKeyExportFailed(let detail):
      return "导出群体版设备公钥失败：\(detail)"
    case .signingFailed(let detail):
      return "群体版设备签名失败：\(detail)"
    case .missingPrivateKey(let label):
      return "找不到群体版设备私钥（label=\(label)）。请重新配对或重新生成设备密钥。"
    case .invalidMessageBase64:
      return "challenge 不是合法的 base64/base64url。"
    }
  }
}

enum DSHMTLSGroupKeys {
  /// 默认 label（App 侧未显式指定时使用；幂等 key 的稳定标识）。
  static let defaultLabel = "com.dsh.remote.group.device"

  /// 规范化 label：空串用默认值。
  static func resolvedLabel(_ label: String?) -> String {
    guard let label, !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return defaultLabel
    }
    return label
  }

  // MARK: - base64 / base64url

  static func base64Url(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  /// 同时接受标准 base64 与 base64url（无填充）。
  static func decodeBase64Any(_ value: String) -> Data? {
    if let data = Data(base64Encoded: value) { return data }
    var normalized = value
      .replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    while normalized.count % 4 != 0 { normalized.append("=") }
    return Data(base64Encoded: normalized)
  }

  // MARK: - Key lookup

  private static func tagData(_ label: String) -> Data {
    Data(label.utf8)
  }

  /// 按 applicationTag 查私钥（Keychain / Secure Enclave 均适用）。
  static func privateKey(label: String) -> SecKey? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tagData(label),
      kSecReturnRef as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
          let result else { return nil }
    return (result as! SecKey)
  }

  /// 是否 Secure Enclave 持有的密钥（SE 密钥带 kSecAttrTokenID）。
  static func isSecureEnclave(label: String) -> Bool {
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tagData(label),
      kSecReturnAttributes as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
          let attributes = result as? [String: Any] else { return false }
    return attributes[kSecAttrTokenID as String] != nil
  }

  /// 公钥外部表示：EC P-256 公钥为 X9.63 未压缩点（65 字节 0x04||X||Y）。
  static func exportPublicKey(_ key: SecKey) throws -> String {
    var error: Unmanaged<CFError>?
    guard let publicKey = SecKeyCopyPublicKey(key),
          let data = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
      throw DSHMTLSGroupKeyError.publicKeyExportFailed(String(describing: error?.takeRetainedValue()))
    }
    guard data.count == 65, data.first == 0x04 else {
      throw DSHMTLSGroupKeyError.publicKeyExportFailed("意外的公钥编码（\(data.count) 字节；期望 65 字节未压缩 P-256 点）")
    }
    return base64Url(data)
  }

  // MARK: - Generate (idempotent)

  /// 生成（或复用）P-256 设备密钥。Secure Enclave 优先，失败回退软件 Keychain。
  static func generate(label rawLabel: String?) throws -> DSHMTLSGroupKeyResult {
    let label = resolvedLabel(rawLabel)
    if let existing = privateKey(label: label) {
      let publicKey = try exportPublicKey(existing)
      return DSHMTLSGroupKeyResult(
        publicKey: publicKey,
        label: label,
        secureEnclave: isSecureEnclave(label: label),
        reused: true
      )
    }

    let tag = tagData(label)
    let privateAttrs: [String: Any] = [
      kSecAttrIsPermanent as String: true,
      kSecAttrApplicationTag as String: tag,
      kSecAttrLabel as String: label,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let baseAttrs: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecPrivateKeyAttrs as String: privateAttrs,
    ]
    var error: Unmanaged<CFError>?
    var key = SecKeyCreateRandomKey(
      baseAttrs.merging([kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave]) { $1 } as CFDictionary,
      &error
    )
    let usedSecureEnclave = key != nil
    if key == nil {
      error = nil
      key = SecKeyCreateRandomKey(baseAttrs as CFDictionary, &error)
    }
    guard let privateKey = key else {
      throw DSHMTLSGroupKeyError.keyGenerationFailed(String(describing: error?.takeRetainedValue()))
    }
    let publicKey = try exportPublicKey(privateKey)
    return DSHMTLSGroupKeyResult(
      publicKey: publicKey,
      label: label,
      secureEnclave: usedSecureEnclave,
      reused: false
    )
  }

  // MARK: - Public key / sign / clear

  /// 读取已存在密钥的公钥；不存在返回 nil。
  static func publicKey(label rawLabel: String?) throws -> String? {
    let label = resolvedLabel(rawLabel)
    guard let key = privateKey(label: label) else { return nil }
    return try exportPublicKey(key)
  }

  /// 对原始 message 字节做 ECDSA-SHA256（X9.62 DER），返回 base64url(DER)。
  static func sign(label rawLabel: String?, messageBase64: String) throws -> String {
    let label = resolvedLabel(rawLabel)
    guard let key = privateKey(label: label) else {
      throw DSHMTLSGroupKeyError.missingPrivateKey(label)
    }
    guard let message = decodeBase64Any(messageBase64) else {
      throw DSHMTLSGroupKeyError.invalidMessageBase64
    }
    var error: Unmanaged<CFError>?
    guard let signature = SecKeyCreateSignature(
      key,
      .ecdsaSignatureMessageX962SHA256,
      message as CFData,
      &error
    ) as Data? else {
      throw DSHMTLSGroupKeyError.signingFailed(String(describing: error?.takeRetainedValue()))
    }
    return base64Url(signature)
  }

  /// 删除群体版设备密钥（换设备身份/重置时用）。
  static func clear(label rawLabel: String?) -> Bool {
    let label = resolvedLabel(rawLabel)
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tagData(label),
    ]
    let status = SecItemDelete(query as CFDictionary)
    return status == errSecSuccess || status == errSecItemNotFound
  }
}
