import Foundation
import Security

// MARK: - Minimal DER encoder (PKCS#10)

enum DER {
  static func length(_ n: Int) -> Data {
    if n < 0x80 { return Data([UInt8(n)]) }
    var bytes: [UInt8] = []
    var value = n
    while value > 0 { bytes.insert(UInt8(value & 0xff), at: 0); value >>= 8 }
    return Data([0x80 | UInt8(bytes.count)] + bytes)
  }
  static func tlv(_ tag: UInt8, _ content: Data) -> Data { Data([tag]) + length(content.count) + content }
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

let oidEcPublicKey: [UInt8] = [0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01]
let oidPrime256v1: [UInt8] = [0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07]
let oidEcdsaWithSha256: [UInt8] = [0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x04, 0x03, 0x02]
let oidCommonName: [UInt8] = [0x55, 0x04, 0x03]

struct GeneratedCsr { let csrPem: String; let keyLabel: String }

func generateCsr(commonName: String, keyLabel: String) throws -> GeneratedCsr {
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
  if privateKey == nil { // macOS CLI/模拟器无 Secure Enclave 时回退软件钥匙串
    error = nil
    privateKey = SecKeyCreateRandomKey(baseAttrs as CFDictionary, &error)
  }
  guard let key = privateKey, let publicKey = SecKeyCopyPublicKey(key) else {
    throw NSError(domain: "dsh.csr", code: 1, userInfo: [NSLocalizedDescriptionKey: "生成 P-256 密钥失败: \(String(describing: error?.takeRetainedValue()))"])
  }
  var exportError: Unmanaged<CFError>?
  guard let publicKeyData = SecKeyCopyExternalRepresentation(publicKey, &exportError) as Data? else {
    throw NSError(domain: "dsh.csr", code: 2, userInfo: [NSLocalizedDescriptionKey: "导出公钥失败: \(String(describing: exportError?.takeRetainedValue()))"])
  }
  let subject = DER.sequence([
    DER.set([DER.sequence([DER.oid(oidCommonName), DER.utf8(commonName)])]),
  ])
  let subjectPublicKeyInfo = DER.sequence([
    DER.sequence([DER.oid(oidEcPublicKey), DER.oid(oidPrime256v1)]),
    DER.bitString(publicKeyData),
  ])
  let certificationRequestInfo = DER.sequence([
    DER.integer(0),
    subject,
    subjectPublicKeyInfo,
    Data([0xA0, 0x00]), // [0] IMPLICIT SET OF Attribute — empty
  ])
  var signError: Unmanaged<CFError>?
  guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, certificationRequestInfo as CFData, &signError) as Data? else {
    throw NSError(domain: "dsh.csr", code: 3, userInfo: [NSLocalizedDescriptionKey: "CSR 签名失败: \(String(describing: signError?.takeRetainedValue()))"])
  }
  let csr = DER.sequence([
    certificationRequestInfo,
    DER.sequence([DER.oid(oidEcdsaWithSha256)]),
    DER.bitString(signature),
  ])
  return GeneratedCsr(csrPem: DER.pem(csr, label: "CERTIFICATE REQUEST"), keyLabel: keyLabel)
}

let args = CommandLine.arguments
let commonName = args.count > 1 ? args[1] : "dsh-device"
let label = args.count > 2 ? args[2] : "com.dsh.remote.device"
let result = try generateCsr(commonName: commonName, keyLabel: label)
try result.csrPem.write(toFile: "generated.csr", atomically: true, encoding: .utf8)
print("CSR_WRITTEN label=\(result.keyLabel)")
