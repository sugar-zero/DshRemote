// DSHMTLSModule.swift
// DSH Remote — 原生模块入口（群体服务版 / A 模式，token 鉴权）。
//
// 历史原因保留模块名 `DSHMTLS`（减少工程改动），但模块内部只保留群体版能力。
//
// JS surface (modules/dsh-mtls/src/index.ts):
//   generateGroupDeviceKey(label?)        — P-256 设备密钥（Secure Enclave 优先，幂等）
//   getGroupDevicePublicKey(label?)       — 读取已存在的设备公钥（base64url 未压缩点）
//   signGroupChallenge(label, messageB64) — ECDSA-SHA256 签 relay challenge（DER→base64url）
//   clearGroupDeviceKey(label?)           — 删除设备密钥
//   setSessionCookie({url,name,value,...}) — 注入 `__Host-` 会话 cookie（Secure/SameSite=Strict/host-only）
//   groupHttpFetch({url,token,method,body?,timeoutMs}) — 带会话 cookie 的 HTTPS 请求
//                                          （relay 边缘只认 cookie，用于 status/restart）
//   clearWebCache()                       — 清理 WKWebView 缓存/Cookie/本地存储 + URLCache
//
// classic/单体 mTLS 原生能力（CSR / PKCS#12 导入 / 设备证书安装 / 原生 mTLS WebView /
// URLSession 客户端证书请求）已从 App 删除：群体版设备身份只来自 P-256 设备密钥 +
// relay 签发的短时 token。

import Dispatch
import ExpoModulesCore
import WebKit

public final class DSHMTLSModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DSHMTLS")

    // MARK: - 群体服务版（A 模式）：P-256 设备密钥 / challenge 签名 / 会话 cookie
    //
    // 群体版不签设备证书，而是把 P-256 公钥登记到主机/relay，之后用私钥签 relay
    // challenge 换短时 token（docs/group-service-design.zh.md §7）。

    /// 生成或复用群体版 P-256 设备密钥；返回 base64url 未压缩点公钥（65B）与是否 Secure Enclave。
    AsyncFunction("generateGroupDeviceKey") { (label: String?) -> [String: Any] in
      let result = try DSHMTLSGroupKeys.generate(label: label)
      return [
        "publicKey": result.publicKey,
        "label": result.label,
        "secureEnclave": result.secureEnclave,
        "reused": result.reused,
      ]
    }

    /// 读取已存在的群体版设备公钥；不存在返回 nil。
    AsyncFunction("getGroupDevicePublicKey") { (label: String?) -> String? in
      try DSHMTLSGroupKeys.publicKey(label: label)
    }

    /// 用群体版设备私钥对 message 的原始字节做 ECDSA-SHA256（X9.62 DER），返回 base64url(DER)。
    AsyncFunction("signGroupChallenge") { (label: String, messageBase64: String) -> [String: Any] in
      let signature = try DSHMTLSGroupKeys.sign(label: label, messageBase64: messageBase64)
      return ["signature": signature]
    }

    /// 删除群体版设备密钥（换身份/重置时用）。
    AsyncFunction("clearGroupDeviceKey") { (label: String?) -> Bool in
      DSHMTLSGroupKeys.clear(label: label)
    }

    /// 把 relay 下发的短时会话 token 写成 `__Host-` host-only cookie（群体版鉴权）。
    ///
    /// 说明：iOS 的 `HTTPCookie` 属性 API 无法表达 **HttpOnly**（WebKit 不允许程序化设置
    /// HttpOnly cookie）；HttpOnly 由 relay 的 `Set-Cookie` 在 WebView 内发请求时写入
    /// （见设计文档 §7），本方法用于 native 侧直接注入/续期。Secure / SameSite=Strict /
    /// Path=/ / host-only（不设 domain）均可表达。
    AsyncFunction("setSessionCookie") { (options: [String: Any], promise: Promise) in
      guard let urlString = options["url"] as? String,
            let url = URL(string: urlString),
            let name = options["name"] as? String, !name.isEmpty,
            let value = options["value"] as? String else {
        promise.reject("invalid-cookie-options", "setSessionCookie 需要 { url, name, value }")
        return
      }
      let maxAgeSeconds = (options["maxAgeSeconds"] as? NSNumber)?.doubleValue ?? 15 * 60
      DispatchQueue.main.async {
        var properties: [HTTPCookiePropertyKey: Any] = [
          .name: name,
          .value: value,
          .path: "/",
          .secure: "TRUE",
          .discard: "FALSE",
          .maximumAge: maxAgeSeconds,
          .originURL: url,
        ]
        if #available(iOS 13.0, *) {
          properties[.sameSitePolicy] = HTTPCookieStringPolicy.sameSiteStrict
        }
        guard let cookie = HTTPCookie(properties: properties) else {
          promise.reject("cookie-build-failed", "无法构造 HTTPCookie（url/name/value 是否合法？）")
          return
        }
        WKWebsiteDataStore.default().httpCookieStore.setCookie(cookie) {
          promise.resolve(true)
        }
      }
    }

    /// 带 `__Host-dsh_session` 会话 cookie 的 HTTPS 请求（群体版隧道内的已鉴权内部接口）。
    ///
    /// 为什么需要原生请求：relay 边缘对普通隧道流量只校验 `__Host-dsh_session` cookie，
    /// 而 App 的 JS `fetch`（NSURLSession 的 cookie 处理）与 WKWebView 的 cookie store
    /// 不共享；这里由原生显式构造 cookie（写入 `HTTPCookieStorage.shared` 并设置
    /// `Cookie` 请求头）后发请求，保证 relay 边缘按 cookie 放行。
    ///
    /// 只允许 https；返回 `{ status, body }`，JSON 解析交给 JS 侧。
    /// 不使用设备证书 / mTLS：鉴权仍是 relay 签发的短时 token。
    AsyncFunction("groupHttpFetch") { (options: [String: Any], promise: Promise) in
      guard let urlString = options["url"] as? String,
            let url = URL(string: urlString),
            url.scheme?.lowercased() == "https",
            let host = url.host, !host.isEmpty,
            let token = options["token"] as? String, !token.isEmpty else {
        promise.reject("invalid-http-options", "groupHttpFetch 需要 https url 与 token")
        return
      }
      // token 会进入 Cookie / Authorization 头：只允许 base64url 安全字符（防头注入）。
      guard token.range(of: "^[A-Za-z0-9._~+/=-]+$", options: .regularExpression) != nil else {
        promise.reject("invalid-http-options", "groupHttpFetch 的 token 含非法字符")
        return
      }
      let method = ((options["method"] as? String) ?? "GET").uppercased()
      guard method == "GET" || method == "POST" else {
        promise.reject("invalid-http-method", "groupHttpFetch 只支持 GET / POST")
        return
      }
      let timeoutMs = (options["timeoutMs"] as? NSNumber)?.doubleValue ?? 15_000
      let cookieName = "__Host-dsh_session"
      let cookieHeader = "\(cookieName)=\(token)"
      var properties: [HTTPCookiePropertyKey: Any] = [
        .name: cookieName,
        .value: token,
        .path: "/",
        .secure: "TRUE",
        .discard: "FALSE",
        .maximumAge: 30 * 60,
        .originURL: url,
      ]
      if #available(iOS 13.0, *) {
        properties[.sameSitePolicy] = HTTPCookieStringPolicy.sameSiteStrict
      }
      // 双写：URLSession 默认会把 HTTPCookieStorage 里的匹配 cookie 自动带进请求；
      // 同时显式设置 Cookie 头，避免依赖自动 cookie 处理的具体行为（两者值相同）。
      if let cookie = HTTPCookie(properties: properties) {
        HTTPCookieStorage.shared.setCookie(cookie)
      }
      var request = URLRequest(url: url, timeoutInterval: max(1, timeoutMs / 1000))
      request.httpMethod = method
      request.setValue("application/json", forHTTPHeaderField: "Accept")
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
      request.setValue(cookieHeader, forHTTPHeaderField: "Cookie")
      if let body = options["body"] as? String, !body.isEmpty {
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body.data(using: .utf8)
      }
      URLSession.shared.dataTask(with: request) { data, response, error in
        if let error = error {
          promise.reject("group-http-failed", "无法连接主机：\(error.localizedDescription)")
          return
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        promise.resolve(["status": status, "body": body])
      }.resume()
    }

    // MARK: - WebView cache

    /// 清理 WKWebView 的持久化缓存 / Cookie / DOM 存储，并清空 URLCache。
    /// 设置页“清理缓存”调用；完成后由 JS 侧重载 WebView。
    /// 用 Promise 在 removeData 完成回调后 resolve(true)，不再阻塞 expo-modules-core 的
    /// 全局 AsyncFunction 队列；10s 兜底 resolve(false)，避免设置页一直停在 busy 状态。
    AsyncFunction("clearWebCache") { (promise: Promise) in
      // removeData 的完成回调与超时兜底都回到 main queue；settled 只在 main queue 读写。
      DispatchQueue.main.async {
        var settled = false
        let finish: (Bool) -> Void = { result in
          guard !settled else { return }
          settled = true
          promise.resolve(result)
        }
        WKWebsiteDataStore.default().removeData(
          ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
          modifiedSince: .distantPast
        ) {
          DispatchQueue.main.async {
            URLCache.shared.removeAllCachedResponses()
            finish(true)
          }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
          finish(false)
        }
      }
    }
  }
}
