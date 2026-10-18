// DSHMTLSNetwork.swift
// DSH Remote — 用 Keychain 里的设备身份发 HTTPS 请求（客户端证书 mTLS）。
//
// 用途（JS 侧 modules/dsh-mtls/src 的 requestWithClientCert）：
//   - 注册推送 token：POST /__dsh_remote/push-token（要求 mTLS）
//   - 轮询 /__dsh_remote/pair/status 等需要设备证书的调用
//
// 实现要点：URLSession + URLSessionDelegate 在
// NSURLAuthenticationMethodClientCertificate 挑战中返回 SecIdentity；
// 服务端 TLS 使用系统默认信任（B2 生产证书由公开 CA 签发）。
//
// ⚠️ 本文件随 Expo 模块在用户 Mac 上由 Xcode 编译（本机无 Xcode，未做 iOS 编译）；
//    对应的 URLSession 客户端证书机制已用独立 Swift POC 在 macOS 验证通过。

import Foundation
import Security

enum DSHMTLSNetworkError: Error, LocalizedError {
  case invalidURL
  case noConfiguredIdentity
  case noIdentity(label: String)
  case invalidResponse
  case timeout
  case transport(String)

  var errorDescription: String? {
    switch self {
    case .invalidURL: return "requestWithClientCert: URL 非法"
    case .noConfiguredIdentity: return "还没有配置设备身份（请先完成配对）"
    case .noIdentity(let label): return "找不到 Keychain 身份：\(label)"
    case .invalidResponse: return "服务器返回了无法识别的响应"
    case .timeout: return "请求超时"
    case .transport(let message): return "网络错误：\(message)"
    }
  }
}

final class DSHMTLSNetwork: NSObject {
  private let identity: SecIdentity
  private let chain: [SecCertificate]
  private let completion: (Result<[String: Any], Error>) -> Void
  private var finished = false

  private init(
    identity: SecIdentity,
    chain: [SecCertificate],
    completion: @escaping (Result<[String: Any], Error>) -> Void
  ) {
    self.identity = identity
    self.chain = chain
    self.completion = completion
  }

  /// 同步等待（由 Expo AsyncFunction 在后台线程调用），返回 { status, headers, body }。
  static func request(
    urlString: String,
    method: String,
    headers: [String: String],
    body: String?
  ) throws -> [String: Any] {
    guard let url = URL(string: urlString) else { throw DSHMTLSNetworkError.invalidURL }
    let store = DSHMTLSIdentityStore.shared
    guard let label = store.configuredLabel else { throw DSHMTLSNetworkError.noConfiguredIdentity }
    guard let identity = store.identity(label: label) else {
      throw DSHMTLSNetworkError.noIdentity(label: label)
    }

    let semaphore = DispatchSemaphore(value: 0)
    var result: Result<[String: Any], Error>?
    let client = DSHMTLSNetwork(
      identity: identity,
      chain: store.certificates(label: label)
    ) { value in
      result = value
      semaphore.signal()
    }

    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 20
    configuration.timeoutIntervalForResource = 30
    let session = URLSession(configuration: configuration, delegate: client, delegateQueue: nil)
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.httpBody = body.map { Data($0.utf8) }
    for (name, value) in headers {
      request.setValue(value, forHTTPHeaderField: name)
    }
    let task = session.dataTask(with: request) { data, response, error in
      client.finish(data: data, response: response, error: error)
    }
    task.resume()
    if semaphore.wait(timeout: .now() + 25) == .timedOut {
      session.invalidateAndCancel()
      throw DSHMTLSNetworkError.timeout
    }
    session.finishTasksAndInvalidate()
    switch result {
    case .success(let value): return value
    case .failure(let error): throw error
    case .none: throw DSHMTLSNetworkError.transport("没有响应")
    }
  }

  private func finish(data: Data?, response: URLResponse?, error: Error?) {
    if finished { return }
    finished = true
    if let error {
      completion(.failure(DSHMTLSNetworkError.transport(error.localizedDescription)))
      return
    }
    guard let http = response as? HTTPURLResponse else {
      completion(.failure(DSHMTLSNetworkError.invalidResponse))
      return
    }
    var responseHeaders: [String: String] = [:]
    for (key, value) in http.allHeaderFields {
      if let key = key as? String, let value = value as? String { responseHeaders[key] = value }
    }
    completion(.success([
      "status": http.statusCode,
      "headers": responseHeaders,
      "body": data.flatMap { String(data: $0, encoding: .utf8) } ?? "",
    ]))
  }
}

extension DSHMTLSNetwork: URLSessionDelegate {
  func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodClientCertificate {
      completionHandler(.useCredential, URLCredential(identity: identity, certificates: chain, persistence: .forSession))
      return
    }
    completionHandler(.performDefaultHandling, nil)
  }
}
