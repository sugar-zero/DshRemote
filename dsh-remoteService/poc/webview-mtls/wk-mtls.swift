import AppKit
import WebKit
import Security

func derFromPem(_ pem: Data) -> Data? {
  guard let text = String(data: pem, encoding: .utf8) else { return nil }
  let lines = text.components(separatedBy: .newlines).filter { !$0.hasPrefix("-----") && !$0.isEmpty }
  return Data(base64Encoded: lines.joined())
}

let args = CommandLine.arguments
guard args.count >= 5 else { fputs("usage: wk-mtls <url> <p12> <password> <ca-pem>\n", stderr); exit(64) }
let targetURL = URL(string: args[1])!
let p12Data = try Data(contentsOf: URL(fileURLWithPath: args[2]))
let password = args[3]
let caPem = try Data(contentsOf: URL(fileURLWithPath: args[4]))
guard let caDer = derFromPem(caPem), let caCert = SecCertificateCreateWithData(nil, caDer as CFData) else {
  fputs("bad ca pem\n", stderr); exit(65)
}

// 临时 keychain：验证导入/身份构建链路，不污染登录 keychain。
let keychainPath = "/tmp/wk-poc/test.keychain-db"
try? FileManager.default.removeItem(atPath: keychainPath)
var keychain: SecKeychain?
let createStatus = SecKeychainCreate(keychainPath, UInt32(password.utf8.count), password, false, nil, &keychain)
guard createStatus == errSecSuccess, let kc = keychain else {
  fputs("keychain create failed: \(createStatus)\n", stderr); exit(66)
}
var importOptions: [String: Any] = [
  kSecImportExportPassphrase as String: password,
  kSecImportExportKeychain as String: kc,
]
var imported: CFArray?
let importStatus = SecPKCS12Import(p12Data as CFData, importOptions as CFDictionary, &imported)
guard importStatus == errSecSuccess,
      let items = imported as? [[String: Any]], let first = items.first,
      let identityRef = first[kSecImportItemIdentity as String] else {
  fputs("p12 import failed: \(importStatus)\n", stderr); exit(67)
}
let identity = identityRef as! SecIdentity
let chain = (first[kSecImportItemCertChain as String] as? [SecCertificate]) ?? []

final class Delegate: NSObject, WKNavigationDelegate {
  let caCert: SecCertificate
  let identity: SecIdentity
  let chain: [SecCertificate]
  var finished = false
  init(caCert: SecCertificate, identity: SecIdentity, chain: [SecCertificate]) {
    self.caCert = caCert; self.identity = identity; self.chain = chain
  }
  func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
               completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    let method = challenge.protectionSpace.authenticationMethod
    if method == NSURLAuthenticationMethodServerTrust, let trust = challenge.protectionSpace.serverTrust {
      SecTrustSetAnchorCertificates(trust, [caCert] as CFArray)
      SecTrustSetAnchorCertificatesOnly(trust, true)
      var error: CFError?
      if SecTrustEvaluateWithError(trust, &error) {
        completionHandler(.useCredential, URLCredential(trust: trust))
      } else {
        fputs("server trust failed: \(String(describing: error))\n", stderr)
        completionHandler(.cancelAuthenticationChallenge, nil)
      }
      return
    }
    if method == NSURLAuthenticationMethodClientCertificate {
      completionHandler(.useCredential, URLCredential(identity: identity, certificates: chain, persistence: .forSession))
      return
    }
    completionHandler(.performDefaultHandling, nil)
  }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    webView.evaluateJavaScript("document.body.innerText") { value, error in
      if let error { print("JSERR:", error); exit(3) }
      print("RESULT:", value ?? "nil")
      exit(0)
    }
  }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    print("NAVFAIL:", error); exit(4)
  }
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    print("PROVFAIL:", error); exit(5)
  }
}

let delegate = Delegate(caCert: caCert, identity: identity, chain: chain)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
webView.navigationDelegate = delegate
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600), styleMask: [], backing: .buffered, defer: false)
window.contentView = webView
webView.load(URLRequest(url: targetURL))
DispatchQueue.main.asyncAfter(deadline: .now() + 15) { print("TIMEOUT"); exit(6) }
app.run()
