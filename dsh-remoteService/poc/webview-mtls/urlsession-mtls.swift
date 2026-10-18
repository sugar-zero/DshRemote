import Foundation
import Security

func derFromPem(_ pem: Data) -> Data? {
  guard let text = String(data: pem, encoding: .utf8) else { return nil }
  let lines = text.components(separatedBy: .newlines).filter { !$0.hasPrefix("-----") && !$0.isEmpty }
  return Data(base64Encoded: lines.joined())
}
let args = CommandLine.arguments
guard args.count >= 5 else { exit(64) }
let target = URL(string: args[1])!
let p12Data = try Data(contentsOf: URL(fileURLWithPath: args[2]))
let password = args[3]
let caPem = try Data(contentsOf: URL(fileURLWithPath: args[4]))
guard let caDer = derFromPem(caPem), let caCert = SecCertificateCreateWithData(nil, caDer as CFData) else { exit(65) }

let keychainPath = "/tmp/urlsession-poc/test.keychain-db"
try? FileManager.default.removeItem(atPath: keychainPath)
var keychain: SecKeychain?
guard SecKeychainCreate(keychainPath, UInt32(password.utf8.count), password, false, nil, &keychain) == errSecSuccess, let kc = keychain else { exit(66) }
var opts: [String: Any] = [kSecImportExportPassphrase as String: password, kSecImportExportKeychain as String: kc]
var imported: CFArray?
guard SecPKCS12Import(p12Data as CFData, opts as CFDictionary, &imported) == errSecSuccess,
      let items = imported as? [[String: Any]], let first = items.first,
      let identityRef = first[kSecImportItemIdentity as String] else { exit(67) }
let identity = identityRef as! SecIdentity
let chain = (first[kSecImportItemCertChain as String] as? [SecCertificate]) ?? []

final class Delegate: NSObject, URLSessionDelegate {
  let caCert: SecCertificate; let identity: SecIdentity; let chain: [SecCertificate]
  init(caCert: SecCertificate, identity: SecIdentity, chain: [SecCertificate]) { self.caCert = caCert; self.identity = identity; self.chain = chain }
  func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    let method = challenge.protectionSpace.authenticationMethod
    if method == NSURLAuthenticationMethodServerTrust, let trust = challenge.protectionSpace.serverTrust {
      SecTrustSetAnchorCertificates(trust, [caCert] as CFArray)
      SecTrustSetAnchorCertificatesOnly(trust, true)
      var error: CFError?
      if SecTrustEvaluateWithError(trust, &error) { completionHandler(.useCredential, URLCredential(trust: trust)) }
      else { completionHandler(.cancelAuthenticationChallenge, nil) }
      return
    }
    if method == NSURLAuthenticationMethodClientCertificate {
      completionHandler(.useCredential, URLCredential(identity: identity, certificates: chain, persistence: .forSession))
      return
    }
    completionHandler(.performDefaultHandling, nil)
  }
}
let delegate = Delegate(caCert: caCert, identity: identity, chain: chain)
let config = URLSessionConfiguration.ephemeral
let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
var request = URLRequest(url: target)
request.httpMethod = "POST"
request.httpBody = Data(#"{"provider":"expo","token":"ExponentPushToken[test]"}"#.utf8)
request.setValue("application/json", forHTTPHeaderField: "Content-Type")
let semaphore = DispatchSemaphore(value: 0)
var exitCode: Int32 = 1
session.dataTask(with: request) { data, response, error in
  defer { semaphore.signal() }
  if let error { print("ERR:", error); return }
  let status = (response as? HTTPURLResponse)?.statusCode ?? -1
  let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
  print("STATUS:", status)
  print("BODY:", body.replacingOccurrences(of: "\n", with: " ").prefix(120))
  exitCode = status == 200 ? 0 : 2
}.resume()
_ = semaphore.wait(timeout: .now() + 15)
session.invalidateAndCancel()
exit(exitCode)
