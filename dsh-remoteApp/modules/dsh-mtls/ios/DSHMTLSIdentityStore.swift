// DSHMTLSIdentityStore.swift
// DSH Remote — POC: Keychain storage for the device client identity used for mTLS.
//
// ⚠️ STATUS: POC / NOT COMPILED on this machine (no Xcode). Reviewed only.
//
// Final design (docs/remote-access-evaluation.zh.md §4.4):
//   - The device private key is generated on-device (P-256, Secure Enclave) and
//     never leaves the Keychain. The host's device CA signs the CSR and the app
//     installs the issued certificate next to the key.
//   - This POC additionally supports importing a PKCS#12 blob (dev helper) so
//     the mTLS WebView can be validated against a real host before the CSR
//     milestone lands.
//
// TODO(next milestone): replace `importP12` with:
//   SecKeyCreateRandomKey([kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
//                          kSecAttrKeySizeInBits: 256,
//                          kSecAttrTokenID: kSecAttrTokenIDSecureEnclave, ...])
//   + SecKeyCreateSignature to build/sign a PKCS#10 CSR.
//   The certificate returned by POST /__dsh_remote/pair is then installed with
//   SecItemAdd (cert) and associated with the existing key.

import Foundation
import Security

enum DSHMTLSIdentityError: Error, LocalizedError {
  case invalidBase64
  case importFailed(OSStatus)
  case missingIdentityInP12
  case keychainWriteFailed(OSStatus)
  case certificateParseFailed
  case missingPrivateKey(OSStatus)

  var errorDescription: String? {
    switch self {
    case .invalidBase64:
      return "POC: 设备身份导入失败 —— PKCS#12 不是合法的 base64。"
    case .importFailed(let status):
      return "POC: SecPKCS12Import 失败（status=\(status)）。请检查证书/私钥与密码。"
    case .missingIdentityInP12:
      return "POC: PKCS#12 中没有可用的 SecIdentity（需要同时包含证书与私钥）。"
    case .keychainWriteFailed(let status):
      return "POC: 写入 Keychain 失败（status=\(status)）。"
    case .certificateParseFailed:
      return "主机返回的设备证书不是合法 PEM/DER。"
    case .missingPrivateKey(let status):
      return "找不到与设备证书匹配的私钥（status=\(status)）。请重新配对或重新导入身份。"
    }
  }
}

final class DSHMTLSIdentityStore {
  static let shared = DSHMTLSIdentityStore()

  private let configuredLabelKey = "dsh.mtls.configuredIdentityLabel"
  private let certificateChainKeyPrefix = "dsh.mtls.certificateChain."

  private init() {}

  // MARK: - Configured identity label

  /// Keychain label the WebView uses for client certificate challenges.
  /// Persisted in UserDefaults (the label itself is not a secret).
  var configuredLabel: String? {
    get { UserDefaults.standard.string(forKey: configuredLabelKey) }
    set {
      if let newValue {
        UserDefaults.standard.set(newValue, forKey: configuredLabelKey)
      } else {
        UserDefaults.standard.removeObject(forKey: configuredLabelKey)
      }
    }
  }

  // MARK: - Import (POC dev helper)

  /// Import a PKCS#12 blob (device cert + private key) into the Keychain.
  ///
  /// NOTE: `SecPKCS12Import` may import into the temporary/keychain depending on
  /// the OS version; we therefore re-add the identity with an explicit label and
  /// cache the (public) certificate chain. Verify persistence on a real device —
  /// see README "已知差距".
  func importP12(base64: String, password: String, label: String) throws -> [String: Any?] {
    guard let data = Data(base64Encoded: base64) else {
      throw DSHMTLSIdentityError.invalidBase64
    }

    var importedItems: CFArray?
    let options: [String: Any] = [kSecImportExportPassphrase as String: password]
    let status = SecPKCS12Import(data as CFData, options as CFDictionary, &importedItems)
    guard status == errSecSuccess else {
      throw DSHMTLSIdentityError.importFailed(status)
    }
    guard
      let items = importedItems as? [[String: Any]],
      let first = items.first,
      let identity = first[kSecImportItemIdentity as String] as? SecIdentity
    else {
      throw DSHMTLSIdentityError.missingIdentityInP12
    }

    let chain = (first[kSecImportItemCertChain as String] as? [SecCertificate]) ?? []
    try persist(identity: identity, chain: chain, label: label)
    configuredLabel = label
    return diagnostics(label: label)
  }

  /// 安装主机签发的设备证书：证书入 Keychain → 用同 label 的私钥组成 SecIdentity。
  /// 设备私钥由 `DSHMTLSCsr.generate` 生成并以 label 存在 Keychain（Secure Enclave 优先）。
  func installCertificate(certPem: String, label: String) throws -> [String: Any?] {
    guard let der = Self.der(fromPem: certPem),
          let certificate = SecCertificateCreateWithData(nil, der as CFData) else {
      throw DSHMTLSIdentityError.certificateParseFailed
    }
    let certQuery: [String: Any] = [
      kSecClass as String: kSecClassCertificate,
      kSecValueRef as String: certificate,
      kSecAttrLabel as String: label,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    ]
    let certStatus = SecItemAdd(certQuery as CFDictionary, nil)
    if certStatus != errSecSuccess && certStatus != errSecDuplicateItem {
      throw DSHMTLSIdentityError.keychainWriteFailed(certStatus)
    }
    var identity: SecIdentity?
    let identityStatus = SecIdentityCreateWithCertificate(nil, certificate, &identity)
    guard identityStatus == errSecSuccess, let identity else {
      throw DSHMTLSIdentityError.missingPrivateKey(identityStatus)
    }
    if self.identity(label: label) == nil {
      let identityQuery: [String: Any] = [
        kSecValueRef as String: identity,
        kSecAttrLabel as String: label,
        kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      ]
      let identityAddStatus = SecItemAdd(identityQuery as CFDictionary, nil)
      if identityAddStatus != errSecSuccess && identityAddStatus != errSecDuplicateItem {
        throw DSHMTLSIdentityError.keychainWriteFailed(identityAddStatus)
      }
    }
    let encodedChain = [certificate].map { certificate -> String in
      (SecCertificateCopyData(certificate) as Data).base64EncodedString()
    }
    UserDefaults.standard.set(encodedChain, forKey: certificateChainKeyPrefix + label)
    configuredLabel = label
    return diagnostics(label: label)
  }

  /// PEM → DER（只接受单证书 PEM；忽略头尾行）。
  static func der(fromPem pem: String) -> Data? {
    let lines = pem.components(separatedBy: .newlines).filter { !$0.hasPrefix("-----") }
    return Data(base64Encoded: lines.joined())
  }

  private func persist(identity: SecIdentity, chain: [SecCertificate], label: String) throws {
    deleteIdentity(label: label)

    let addQuery: [String: Any] = [
      kSecValueRef as String: identity,
      kSecAttrLabel as String: label,
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    ]
    let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
    guard addStatus == errSecSuccess || addStatus == errSecDuplicateItem else {
      throw DSHMTLSIdentityError.keychainWriteFailed(addStatus)
    }

    // The certificate chain is public information; cache it so URLCredential can
    // be built without re-deriving the chain from the Keychain on every challenge.
    let encodedChain: [String] = chain.compactMap { certificate in
      let data = SecCertificateCopyData(certificate) as Data
      return data.base64EncodedString()
    }
    UserDefaults.standard.set(encodedChain, forKey: certificateChainKeyPrefix + label)
  }

  // MARK: - Lookup

  /// Find the client identity by Keychain label (used in the TLS challenge).
  func identity(label: String) -> SecIdentity? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassIdentity,
      kSecAttrLabel as String: label,
      kSecReturnRef as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess else { return nil }
    return result as? SecIdentity
  }

  /// Certificate chain for `URLCredential(identity:certificates:persistence:)`.
  func certificates(label: String) -> [SecCertificate] {
    if let encoded = UserDefaults.standard.stringArray(forKey: certificateChainKeyPrefix + label) {
      let chain: [SecCertificate] = encoded.compactMap { base64 in
        guard let data = Data(base64Encoded: base64) else { return nil }
        return SecCertificateCreateWithData(nil, data as CFData)
      }
      if !chain.isEmpty { return chain }
    }
    // Fallback: at least present the leaf certificate.
    guard let identity = identity(label: label) else { return [] }
    var certificate: SecCertificate?
    SecIdentityCopyCertificate(identity, &certificate)
    return certificate.map { [$0] } ?? []
  }

  func deleteIdentity(label: String) {
    let query: [String: Any] = [
      kSecClass as String: kSecClassIdentity,
      kSecAttrLabel as String: label
    ]
    SecItemDelete(query as CFDictionary)
    UserDefaults.standard.removeObject(forKey: certificateChainKeyPrefix + label)
  }

  // MARK: - Diagnostics (never returns key material)

  func diagnostics(label: String?) -> [String: Any?] {
    let resolvedLabel = label ?? configuredLabel
    guard let resolvedLabel else {
      return [
        "configuredIdentityLabel": nil,
        "identityPresent": false,
        "subject": nil,
        "notAfter": nil,
        "nativeBuild": Self.nativeBuild
      ]
    }
    guard let identity = identity(label: resolvedLabel) else {
      return [
        "configuredIdentityLabel": resolvedLabel,
        "identityPresent": false,
        "subject": nil,
        "notAfter": nil,
        "nativeBuild": Self.nativeBuild
      ]
    }

    var certificate: SecCertificate?
    SecIdentityCopyCertificate(identity, &certificate)
    let subject = certificate.flatMap { SecCertificateCopySubjectSummary($0) as String? }
    let notAfter = certificate.flatMap { expiryDateString(for: $0) }

    return [
      "configuredIdentityLabel": resolvedLabel,
      "identityPresent": true,
      "subject": subject,
      "notAfter": notAfter,
      "nativeBuild": Self.nativeBuild
    ]
  }

  /// POC: parse `notAfter` via SecCertificateCopyValues (best effort).
  private func expiryDateString(for certificate: SecCertificate) -> String? {
    guard
      let values = SecCertificateCopyValues(
        certificate,
        [kSecOIDX509V1ValidityNotAfter] as CFArray,
        nil
      ) as? [String: [String: Any]],
      let entry = values[kSecOIDX509V1ValidityNotAfter as String],
      let raw = entry[kSecPropertyKeyValue as String] as? Double
    else {
      return nil
    }
    // SecCertificateCopyValues returns seconds since 2001-01-01 (CFAbsoluteTime).
    let date = Date(timeIntervalSinceReferenceDate: raw)
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.string(from: date)
  }

  private static var nativeBuild: String {
    "DSHMTLS/0.1.0 POC (ios)"
  }
}
