// DSHMTLSWebView.swift
// DSH Remote — POC: WKWebView subclass that answers mTLS client-certificate
// challenges with a Keychain `SecIdentity`, plus a small event bridge to JS.
//
// ⚠️ STATUS: POC / NOT COMPILED on this machine (no Xcode). Reviewed only.
//
// Why a custom WebView is required (evaluation §4.7 / ADMIN-API.md §2):
//   After pairing, the host's TLS listener requires a client certificate on
//   every path except /__dsh_remote/pair. `react-native-webview` cannot present
//   one on iOS, so the shell needs this subclass.
//
// Integration from JS (see `modules/dsh-mtls/src/index.ts`):
//   const NativeView = getDshMtlsWebView();
//   <NativeView
//      url="https://<hostId>.<relayDomain>/"
//      clientIdentityLabel={connection.certRef}
//      onLoadingFinish={...} />
//
// Known POC risks to verify on a real device:
//   1. WKWebView delivers `didReceive challenge` for client certificates only
//      when the server requests them during the TLS handshake; validate against
//      the real host plugin (some iOS versions have quirks for main resources).
//   2. WebSocket upgrades (/api/remote.mux) are handled by WebKit itself and
//      should use the same TLS session; verify that mux traffic works.
//   3. If (1) turns out to be unreliable, fallback: a WKURLSchemeHandler that
//      proxies through URLSession with the same identity (bigger change).

import ExpoModulesCore
import WebKit

public final class DshMtlsWebView: ExpoView, WKNavigationDelegate, WKScriptMessageHandler {
  // Event dispatchers — names must match `Events(...)` in DSHMTLSModule.swift
  // and the TS props in modules/dsh-mtls/src/index.ts.
  let onMessage = EventDispatcher()
  let onLoadingStart = EventDispatcher()
  let onLoadingFinish = EventDispatcher()
  let onLoadingError = EventDispatcher()

  private static let bridgeName = "dshMtlsBridge"

  private let webView: WKWebView
  private var loadedUrlString: String?
  private var userScript: WKUserScript?
  private var pendingCommand: String?
  private var pageReady = false

  /// Keychain label of the client identity to present. Falls back to the
  /// globally configured label when the prop is not set.
  var clientIdentityLabel: String?

  public required init(appContext: AppContext? = nil) {
    let configuration = WKWebViewConfiguration()
    // The host proxies with its own owner cookie; keep the shell's WebView clean.
    configuration.websiteDataStore = .nonPersistent()
    let contentController = WKUserContentController()
    configuration.userContentController = contentController
    self.webView = WKWebView(frame: .zero, configuration: configuration)

    super.init(appContext: appContext)

    contentController.add(self, name: Self.bridgeName)
    webView.navigationDelegate = self
    webView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(webView)
    NSLayoutConstraint.activate([
      webView.leadingAnchor.constraint(equalTo: leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: trailingAnchor),
      webView.topAnchor.constraint(equalTo: topAnchor),
      webView.bottomAnchor.constraint(equalTo: bottomAnchor)
    ])
    backgroundColor = .clear
  }

  deinit {
    webView.configuration.userContentController.removeScriptMessageHandler(forName: Self.bridgeName)
    webView.navigationDelegate = nil
  }

  // MARK: - Props

  func applyUrl(_ urlString: String?) {
    guard let urlString, let url = URL(string: urlString) else { return }
    guard loadedUrlString != urlString else { return }
    loadedUrlString = urlString
    webView.load(URLRequest(url: url))
  }

  func applyInjectedJavaScript(_ script: String?) {
    if userScript != nil {
      // iOS 的 WKUserContentController 没有 removeUserScript；这个 WebView 只注入
      // 我们自己的脚本，直接清空后重新添加。
      webView.configuration.userContentController.removeAllUserScripts()
      userScript = nil
    }
    guard let script, !script.isEmpty else { return }
    let newScript = WKUserScript(
      source: script,
      injectionTime: .atDocumentStart,
      forMainFrameOnly: true
    )
    webView.configuration.userContentController.addUserScript(newScript)
    userScript = newScript
  }

  // MARK: - WKNavigationDelegate: mTLS client certificate challenge

  public func webView(
    _ webView: WKWebView,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    switch challenge.protectionSpace.authenticationMethod {
    case NSURLAuthenticationMethodClientCertificate:
      let label = clientIdentityLabel ?? DSHMTLSIdentityStore.shared.configuredLabel
      guard
        let label,
        let identity = DSHMTLSIdentityStore.shared.identity(label: label)
      else {
        // Never continue without a client identity: the host would reject anyway,
        // and failing loudly makes the POC failure mode visible.
        onLoadingError([
          "description": "未找到设备客户端证书（Keychain label: \(label ?? "未配置")）",
          "url": challenge.protectionSpace.host
        ])
        completionHandler(.cancelAuthenticationChallenge, nil)
        return
      }
      let certificates = DSHMTLSIdentityStore.shared.certificates(label: label)
      let credential = URLCredential(
        identity: identity,
        certificates: certificates,
        persistence: .forSession
      )
      completionHandler(.useCredential, credential)

    case NSURLAuthenticationMethodServerTrust:
      // POC: use the system TLS trust store. The host's server certificate is a
      // publicly-trusted LE certificate for <hostId>.<relayDomain> (plan B2).
      // TODO(security): optionally pin the leaf SPKI. `hostfp` from the QR is the
      // HOST IDENTITY key fingerprint, not the TLS cert — do not confuse them.
      completionHandler(.performDefaultHandling, nil)

    default:
      completionHandler(.performDefaultHandling, nil)
    }
  }

  // MARK: - WKNavigationDelegate: loading lifecycle → JS events

  public func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    pageReady = false
    onLoadingStart(["url": webView.url?.absoluteString ?? loadedUrlString ?? ""])
  }

  public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    pageReady = true
    runPendingCommand()
    onLoadingFinish(["url": webView.url?.absoluteString ?? ""])
  }

  public func webView(
    _ webView: WKWebView,
    didFail navigation: WKNavigation!,
    withError error: Error
  ) {
    emitLoadingError(error, url: webView.url?.absoluteString)
  }

  public func webView(
    _ webView: WKWebView,
    didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    emitLoadingError(error, url: webView.url?.absoluteString)
  }

  private func emitLoadingError(_ error: Error, url: String?) {
    onLoadingError([
      "code": (error as NSError).code,
      "description": error.localizedDescription,
      "url": url ?? ""
    ])
  }

  // MARK: - Native → page commands (session list opens a session)

  func applyJsCommand(_ command: String?) {
    guard let command, !command.isEmpty else { return }
    pendingCommand = command
    if pageReady { runPendingCommand() }
  }

  private func runPendingCommand() {
    guard let command = pendingCommand else { return }
    pendingCommand = nil
    webView.evaluateJavaScript(command) { [weak self] _, error in
      guard let self, let error else { return }
      self.onLoadingError([
        "description": "页面命令执行失败：\(error.localizedDescription)",
        "url": self.webView.url?.absoluteString ?? ""
      ])
    }
  }

  // MARK: - WKScriptMessageHandler (page → JS bridge)

  public func userContentController(
    _ userContentController: WKUserContentController,
    didReceive message: WKScriptMessage
  ) {
    guard message.name == Self.bridgeName else { return }
    let data: String
    if let string = message.body as? String {
      data = string
    } else {
      data = String(describing: message.body)
    }
    onMessage(["data": data, "url": webView.url?.absoluteString ?? ""])
  }
}
