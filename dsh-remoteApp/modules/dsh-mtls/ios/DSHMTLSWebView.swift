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
import UIKit
import WebKit

public final class DshMtlsWebView: ExpoView, WKNavigationDelegate, WKScriptMessageHandler {
  // Event dispatchers — names must match `Events(...)` in DSHMTLSModule.swift
  // and the TS props in modules/dsh-mtls/src/index.ts.
  let onMessage = EventDispatcher()
  let onLoadingStart = EventDispatcher()
  let onLoadingFinish = EventDispatcher()
  let onLoadingError = EventDispatcher()

  private static let bridgeName = "dshMtlsBridge"

  /// 当前活跃的 WebView（同一时刻只应有一个）；供 JS 桥/推送跳转注入脚本使用。
  static weak var activeView: DshMtlsWebView?

  private let webView: WKWebView
  private var loadedUrlString: String?
  private var userScript: WKUserScript?
  private var injectedJavaScriptSource: String?

  /// WebContent 进程被系统回收后的自动恢复预算（防止 reload 循环）。
  private var contentProcessTerminationCount = 0
  private var lastContentProcessTerminationAt: Date?
  /// 后台被回收时延后到回前台再 reload。
  private var pendingForegroundReload = false
  /// 首次加载被推迟的 URL：等 injectedJavaScript 在同一个 props 批次里注册完再导航，
  /// 否则首个页面可能完全没有注入手机壳（WKUserScript 只对添加之后开始的导航生效）。
  private var pendingLoadUrlString: String?
  private var foregroundObserver: NSObjectProtocol?

  /// Keychain label of the client identity to present. Falls back to the
  /// globally configured label when the prop is not set.
  var clientIdentityLabel: String?

  public required init(appContext: AppContext? = nil) {
    let configuration = WKWebViewConfiguration()
    // Persistent store = disk HTTP cache, so returning to the host / relaunching
    // the app does not re-download the DSH web bundle every time. The WebView is
    // still scoped to one paired host and the app has its own lock screen.
    configuration.websiteDataStore = .default()
    let contentController = WKUserContentController()
    configuration.userContentController = contentController
    self.webView = WKWebView(frame: .zero, configuration: configuration)

    super.init(appContext: appContext)
    Self.activeView = self

    contentController.add(self, name: Self.bridgeName)
    #if DEBUG
    // Allow Safari Web Inspector on a physical device while tuning load times.
    // 注意：isInspectable 是 WKWebView 的属性（iOS 16.4+），不是 WKPreferences 的；
    // 之前写成 configuration.preferences.isInspectable 会直接编译失败。
    webView.isInspectable = true
    #endif
    webView.navigationDelegate = self
    // Mobile shell: no pinch/double-tap zoom; iOS otherwise zooms the page when
    // a focused input's font is < 16px, which breaks the conversation layout.
    webView.scrollView.maximumZoomScale = 1
    webView.scrollView.minimumZoomScale = 1
    webView.scrollView.bouncesZoom = false
    webView.scrollView.pinchGestureRecognizer?.isEnabled = false
    webView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(webView)
    NSLayoutConstraint.activate([
      webView.leadingAnchor.constraint(equalTo: leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: trailingAnchor),
      webView.topAnchor.constraint(equalTo: topAnchor),
      webView.bottomAnchor.constraint(equalTo: bottomAnchor)
    ])
    backgroundColor = .clear

    // 若 WebContent 进程在后台被系统回收，回前台时补一次 reload。
    foregroundObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didBecomeActiveNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      guard let self, self.pendingForegroundReload else { return }
      self.pendingForegroundReload = false
      self.reloadLoadedPage()
    }
  }

  deinit {
    if Self.activeView === self {
      Self.activeView = nil
    }
    if let observer = foregroundObserver {
      NotificationCenter.default.removeObserver(observer)
    }
    webView.configuration.userContentController.removeScriptMessageHandler(forName: Self.bridgeName)
    webView.navigationDelegate = nil
  }

  // MARK: - JS injection / push navigation

  /// 在 main 队列执行一段 JS；调用方（App）不需要等待返回值。
  func evaluateJavaScript(_ script: String) {
    DispatchQueue.main.async { [weak self] in
      self?.webView.evaluateJavaScript(script, completionHandler: nil)
    }
  }

  // MARK: - Props

  func applyUrl(_ urlString: String?) {
    guard let urlString, let url = URL(string: urlString) else { return }
    guard loadedUrlString != urlString else { return }
    loadedUrlString = urlString
    // WKUserScript 只对“添加之后开始”的导航生效，而 Expo 的 props 应用顺序不保证
    // url 在 injectedJavaScript 之后。这里先让出一个 runloop：同一个 props 批次里的
    // 脚本注册会先完成，然后我们再开始加载（避免首个页面漏注入手机壳）。
    guard userScript != nil else {
      pendingLoadUrlString = urlString
      DispatchQueue.main.async { [weak self] in
        guard let self, let pending = self.pendingLoadUrlString else { return }
        self.pendingLoadUrlString = nil
        guard let pendingUrl = URL(string: pending) else { return }
        self.webView.load(URLRequest(url: pendingUrl))
      }
      return
    }
    pendingLoadUrlString = nil
    webView.load(URLRequest(url: url))
  }

  func applyInjectedJavaScript(_ script: String?) {
    guard let script, !script.isEmpty else {
      // 不要因为空脚本把已有的脚本清掉（props 更新时可能先传 nil）。
      return
    }
    if script == injectedJavaScriptSource, userScript != nil { return }
    if userScript != nil {
      // iOS 的 WKUserContentController 没有 removeUserScript；这个 WebView 只注入
      // 我们自己的脚本，直接清空后重新添加。
      webView.configuration.userContentController.removeAllUserScripts()
      userScript = nil
    }
    let newScript = WKUserScript(
      source: script,
      injectionTime: .atDocumentStart,
      forMainFrameOnly: true
    )
    webView.configuration.userContentController.addUserScript(newScript)
    userScript = newScript
    injectedJavaScriptSource = script
    // 脚本在首次加载被推迟后才到达：现在导航，保证首个页面也注入手机壳。
    if let pending = pendingLoadUrlString {
      pendingLoadUrlString = nil
      if let pendingUrl = URL(string: pending) {
        webView.load(URLRequest(url: pendingUrl))
      }
    }
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
    onLoadingStart(["url": webView.url?.absoluteString ?? loadedUrlString ?? ""])
  }

  public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    // 页面成功加载 = 上一次 WebContent 进程回收已经恢复，重置自动 reload 预算。
    contentProcessTerminationCount = 0
    lastContentProcessTerminationAt = nil
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

  // MARK: - WKNavigationDelegate: WebContent 进程回收恢复
  //
  // iOS 会在内存压力 / watchdog 时杀掉 WKWebView 的 WebContent 进程（会话历史很大、
  // 页面持有 4MB 级 WebSocket 快照时更容易发生）。此时页面会变成空白或停在最后一帧，
  // 但 *不会* 触发 didFail，JS 也收不到任何事件——用户看到的就是“页面卡住/一直加载”。
  // 这里自动 reload（60s 窗口内最多 2 次）避免恢复循环；超限则把错误交给 JS，
  // 由用户点「重试」（JS 重建原生视图，预算随之清零）。
  public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    let now = Date()
    if let last = lastContentProcessTerminationAt, now.timeIntervalSince(last) > 60 {
      contentProcessTerminationCount = 0
    }
    lastContentProcessTerminationAt = now
    contentProcessTerminationCount += 1
    let canAutoRecover = contentProcessTerminationCount <= 2
    onLoadingError([
      "code": -1,
      "description": canAutoRecover
        ? "系统回收了网页进程（内存压力），正在自动重新加载…"
        : "系统多次回收网页进程（内存压力），请点「重试」重新加载。",
      "url": webView.url?.absoluteString ?? loadedUrlString ?? "",
      "reason": "content-process-terminated",
      "recoverable": canAutoRecover
    ])
    guard canAutoRecover else { return }
    reloadLoadedPage()
  }

  /// Reload whatever URL this view last loaded (used by the termination recovery).
  private func reloadLoadedPage() {
    // 后台不能可靠地 reload（WebKit 可能忽略或失败）：记下来，回前台再执行。
    guard UIApplication.shared.applicationState == .active else {
      pendingForegroundReload = true
      return
    }
    if webView.url != nil {
      webView.reload()
      return
    }
    if let urlString = loadedUrlString, let url = URL(string: urlString) {
      webView.load(URLRequest(url: url))
    }
  }

  private func emitLoadingError(_ error: Error, url: String?) {
    let nsError = error as NSError
    // -999 NSURLErrorCancelled：导航被主动取消（重定向、页面自己跳转、外链改走系统
    // 浏览器、WebView 重建）。这不是连接故障，上报会在 JS 侧弹出错误条并挤压 WebView
    // 布局，表现为屏幕“跳一下”，所以直接忽略。
    if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled { return }
    onLoadingError([
      "code": nsError.code,
      "description": nsError.localizedDescription,
      "url": url ?? ""
    ])
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
