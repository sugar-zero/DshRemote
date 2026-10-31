/**
 * dsh-mtls — JS bridge for the DSH Remote native mTLS module (POC skeleton).
 *
 * ⚠️ STATUS: POC / not compiled yet. The Swift and Kotlin sources in this
 * package are written to be "compile-level complete" but have only been
 * reviewed, not built (this repository machine has no Xcode/Android SDK).
 * See `README.md` in the app root for build + acceptance steps.
 *
 * What the native side must provide (evaluation §4.7 native module list):
 *  - iOS: a WKWebView subclass whose WKNavigationDelegate answers
 *    `NSURLAuthenticationMethodClientCertificate` challenges with a
 *    `SecIdentity` looked up in the Keychain by label.
 *  - Android: a WebView subclass whose WebViewClient answers
 *    `WebViewClient.onReceivedClientCertRequest` with the Keystore alias.
 *  - Device private key generation + PKCS#10 CSR + Keychain/Keystore certificate
 *    install (iOS Secure Enclave 优先；Android AndroidKeyStore).
 *
 * This wrapper deliberately degrades gracefully when the native module is not
 * linked (Expo Go / web / a build without the module): everything returns
 * "unavailable" instead of crashing the JS bundle.
 */

import type React from 'react';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';

/** Native module name; must match `Name("DSHMTLS")` in Swift/Kotlin. */
export const DSH_MTLS_MODULE_NAME = 'DSHMTLS';

/** Native view name used by the custom WKWebView/WebView wrapper. */
export const DSH_MTLS_VIEW_NAME = 'DshMtlsWebView';

/** Error thrown when the JS code expects mTLS but the native module is absent. */
export class DshMtlsUnavailableError extends Error {
  constructor(detail?: string) {
    super(
      detail ??
        'DSH mTLS 原生模块不可用：当前构建没有链接 modules/dsh-mtls。' +
          '请用 `npx expo run:ios`/`run:android` 构建 dev client（Expo Go 不包含该模块）。',
    );
    this.name = 'DshMtlsUnavailableError';
    Object.setPrototypeOf(this, DshMtlsUnavailableError.prototype);
  }
}

export interface ClientIdentityInfo {
  /** Keychain/Keystore label the module is configured to use. */
  label: string | null;
  /** Certificate subject (CN=...), when available. */
  subject: string | null;
  /** Certificate expiry (ISO 8601), when available. */
  notAfter: string | null;
}

export interface CsrResult {
  /** PEM-encoded PKCS#10 CSR to submit to `/__dsh_remote/pair`. */
  csrPem: string;
  /** Keychain/Keystore label of the newly generated private key. */
  label: string;
  /** iOS: true = 私钥由 Secure Enclave 持有；false = 软件 Keychain 回退。 */
  secureEnclave?: boolean;
}

export interface P12ImportResult {
  imported: boolean;
  /** Android POC: the system certificate installer is shown; user must confirm. */
  pendingUserConfirmation?: boolean;
  /** Keychain/Keystore label now configured for mTLS (native field name). */
  configuredIdentityLabel?: string | null;
  identityPresent?: boolean;
  subject?: string | null;
  notAfter?: string | null;
  nativeBuild?: string;
}

/** 群体版（A 模式）设备密钥：公钥为 base64url(未压缩 P-256 点，65 字节 0x04||X||Y)。 */
export interface GroupDeviceKeyResult {
  /** base64url(未压缩 P-256 点，65 字节)。 */
  publicKey: string;
  /** Keychain/Keystore alias（幂等 key 的稳定标识）。 */
  label: string;
  /** iOS：true = 私钥由 Secure Enclave 持有；false = 软件 Keychain 回退。Android 恒为 AndroidKeyStore。 */
  secureEnclave?: boolean;
  /** true = 复用了同 label 已存在的密钥（幂等，不会重新生成）。 */
  reused: boolean;
}

/** 群体版 challenge 签名：base64url(X9.62 DER ECDSA-SHA256)。 */
export interface GroupChallengeSignature {
  signature: string;
}

/** 群体版会话 cookie 注入参数（`__Host-` host-only）。 */
export interface GroupSessionCookieOptions {
  /** 目标 origin，如 `https://<hostId>.<relayDomain>:<port>`。 */
  url: string;
  /** Cookie 名（群体版为 `__Host-dsh_session`）。 */
  name: string;
  /** 会话 token 值。 */
  value: string;
  /** 有效期（秒）。 */
  maxAgeSeconds: number;
  /** 必须 host-only（固定 true；不设 Domain）。 */
  hostOnly?: true;
}

export interface DshMtlsDiagnostics {
  platform: 'ios' | 'android' | 'web';
  moduleAvailable: boolean;
  configuredIdentityLabel: string | null;
  identityPresent: boolean;
  subject: string | null;
  notAfter: string | null;
  /** Free-form native build info for the diagnostics screen. */
  nativeBuild: string | null;
}

interface NativeDshMtlsModule {
  /** Configure which Keychain/Keystore label is used for client certificate challenges. */
  setClientIdentity(label: string): Promise<void>;
  clearClientIdentity(): Promise<void>;
  getClientIdentity(): Promise<string | null>;
  /**
   * POC helper: import a PKCS#12 (device cert + private key) into the
   * Keychain/Keystore. In the final design the private key is generated
   * on-device and the certificate is installed from the pairing response.
   */
  importP12(p12Base64: string, password: string, label?: string): Promise<P12ImportResult>;
  /** Generate a P-256 key pair + PKCS#10 CSR (Secure Enclave / AndroidKeyStore). */
  generateCsr(commonName: string): Promise<CsrResult>;
  getDiagnostics(): Promise<DshMtlsDiagnostics>;
  /** 安装主机签发的设备证书（与 generateCsr 产生的私钥 label 关联）。 */
  installCertificate?(certPem: string, label?: string): Promise<P12ImportResult>;
  /** 用配置好的设备证书发一条 HTTPS 请求（iOS URLSession / Android HttpsURLConnection）。 */
  requestWithClientCert?(options: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ status: number; headers?: Record<string, string>; body: string }>;
  /** 清理 WebView 持久化缓存 / Cookie / DOM 存储（设置页“清理缓存”）。 */
  clearWebCache(): Promise<boolean>;
  /** 在当前 mTLS WebView 里执行一段 JS（点推送后打开对应会话）。 */
  evaluateJavaScript(script: string): Promise<boolean>;
  // ---- 群体服务版（A 模式，token 鉴权）----
  /** 生成/复用 P-256 设备密钥（iOS Secure Enclave 优先，Android AndroidKeyStore）。 */
  generateGroupDeviceKey?(label?: string): Promise<GroupDeviceKeyResult>;
  /** 读取已存在的设备公钥；不存在返回 null。 */
  getGroupDevicePublicKey?(label?: string): Promise<string | null>;
  /** 用设备私钥对 challenge 原始字节做 ECDSA-SHA256 签名。 */
  signGroupChallenge?(label: string, messageBase64: string): Promise<GroupChallengeSignature>;
  /** 删除本机设备密钥（幂等）。 */
  clearGroupDeviceKey?(label?: string): Promise<boolean>;
  /** 把 relay 下发的短时 token 注入 WebView cookie（`__Host-` host-only）。 */
  setSessionCookie?(options: GroupSessionCookieOptions): Promise<boolean>;
}

const nativeModule = requireOptionalNativeModule<NativeDshMtlsModule>(DSH_MTLS_MODULE_NAME);

/** True when this build linked the native module. */
export const isDshMtlsAvailable = nativeModule !== null;

function requireModule(): NativeDshMtlsModule {
  if (!nativeModule) throw new DshMtlsUnavailableError();
  return nativeModule;
}

/** Configure the Keychain/Keystore identity used for mTLS client certificate challenges. */
export async function setClientIdentity(label: string): Promise<void> {
  return requireModule().setClientIdentity(label);
}

/** Forget the configured identity (does not delete it from the Keychain). */
export async function clearClientIdentity(): Promise<void> {
  return requireModule().clearClientIdentity();
}

/** The currently configured Keychain/Keystore label, if any. */
export async function getClientIdentityLabel(): Promise<string | null> {
  if (!nativeModule) return null;
  return nativeModule.getClientIdentity();
}

/** POC: import cert+key (PKCS#12) into Keychain/Keystore and configure it for mTLS. */
export async function importClientIdentityFromP12(
  p12Base64: string,
  password: string,
  label?: string,
): Promise<P12ImportResult> {
  return requireModule().importP12(p12Base64, password, label);
}

/**
 * Generate a device key pair + CSR. Device private keys never leave native
 * storage (Secure Enclave / Keystore); the CSR is the only thing returned to JS.
 */
export async function generateCsr(commonName: string): Promise<CsrResult> {
  return requireModule().generateCsr(commonName);
}

/** 安装主机签发的设备证书并关联设备私钥（label 来自 generateCsr 的返回值）。 */
export async function installCertificate(certPem: string, label?: string): Promise<P12ImportResult> {
  const module = requireModule();
  if (typeof module.installCertificate !== 'function') {
    throw new DshMtlsUnavailableError('原生模块未实现 installCertificate（需要重新构建 dev client）。');
  }
  return module.installCertificate(certPem, label);
}

/** Diagnostics for the Devices/debug screen. Never returns key material. */
export async function getDiagnostics(): Promise<DshMtlsDiagnostics> {
  if (!nativeModule) {
    return {
      platform: 'web',
      moduleAvailable: false,
      configuredIdentityLabel: null,
      identityPresent: false,
      subject: null,
      notAfter: null,
      nativeBuild: null,
    };
  }
  return nativeModule.getDiagnostics();
}

/** POC：用设备证书发一条 HTTPS 请求（原生实现缺失时抛 DshMtlsUnavailableError）。 */
export async function requestWithClientCert(options: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; headers?: Record<string, string>; body: string }> {
  const module = requireModule();
  if (typeof module.requestWithClientCert !== 'function') {
    throw new DshMtlsUnavailableError('原生 mTLS HTTP 客户端尚未实现（requestWithClientCert）；POC 阶段可用 PKCS#12 手动导入后由 WebView 验证 mTLS。');
  }
  return module.requestWithClientCert({
    url: options.url,
    method: options.method ?? 'GET',
    headers: options.headers,
    body: options.body,
  });
}

/** 清理 WebView 缓存/Cookie/本地存储；用于设置页“清理缓存”（清理后调用方应重载 WebView）。 */
export async function clearWebCache(): Promise<boolean> {
  const module = requireModule();
  if (typeof module.clearWebCache !== 'function') {
    throw new DshMtlsUnavailableError('当前构建不支持 clearWebCache（需要重新构建 App）。');
  }
  return module.clearWebCache();
}

/** 在当前 mTLS WebView 里执行一段 JS；原生视图不在时返回 false。 */
export async function evaluateJavaScript(script: string): Promise<boolean> {
  const module = requireModule();
  if (typeof module.evaluateJavaScript !== 'function') return false;
  return module.evaluateJavaScript(script);
}

export interface DshMtlsWebViewMessageEvent {
  nativeEvent: { data: string; url?: string };
}

export interface DshMtlsWebViewErrorEvent {
  nativeEvent: {
    code?: number;
    description?: string;
    url?: string;
    /**
     * 原生侧的机器可读原因（非所有错误都有）：
     *  - `content-process-terminated`：iOS WebContent 进程被系统回收（原生侧已尝试自动 reload）
     *  - `render-process-gone`：Android 渲染进程崩溃/被回收（当前 WebView 实例不可再用，
     *    需要 JS 侧重建原生视图）
     */
    reason?: string;
    /** 原生侧是否已经/能够自动恢复；false 表示需要用户手动重试。 */
    recoverable?: boolean;
  };
}

export interface DshMtlsWebViewLoadingEvent {
  nativeEvent: { url?: string };
}

/** Props of the native mTLS-aware web view (subset of react-native-webview's). */
export interface DshMtlsWebViewProps {
  /** Initial URL, always `https://<host>/`. */
  url: string;
  /** Keychain/Keystore label of the client identity to present. */
  clientIdentityLabel?: string;
  /** Injected JS; native side adds it as a WKUserScript / evaluateJavascript. */
  injectedJavaScript?: string;
  onMessage?: (event: DshMtlsWebViewMessageEvent) => void;
  onLoadingStart?: (event: DshMtlsWebViewLoadingEvent) => void;
  onLoadingFinish?: (event: DshMtlsWebViewLoadingEvent) => void;
  onLoadingError?: (event: DshMtlsWebViewErrorEvent) => void;
  style?: unknown;
}

/**
 * The native view component, or `null` when the module isn't linked.
 *
 * Screens should prefer react-native-webview in Expo Go (no mTLS) and switch to
 * this view only on native dev-client/release builds. See `WebViewScreen.tsx`
 * for the integration TODO.
 */
export function getDshMtlsWebView(): React.ComponentType<DshMtlsWebViewProps> | null {
  if (!nativeModule) return null;
  try {
    return requireNativeViewManager<DshMtlsWebViewProps>(DSH_MTLS_MODULE_NAME, DSH_MTLS_VIEW_NAME);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 群体服务版（A 模式，token 鉴权）
// ---------------------------------------------------------------------------
// 群体版不签设备证书：配对时提交 P-256 公钥，之后用私钥签 relay challenge 换短时
// token（15 分钟级），token 放进 `__Host-dsh_session` cookie（见 docs/group-service-design.zh.md §7）。
// 私钥永远留在 Secure Enclave / AndroidKeyStore，不返回 JS。

/** 群体版设备密钥的默认 label（与原生侧 `defaultLabel` 保持一致）。 */
export const GROUP_DEVICE_KEY_LABEL = 'com.dsh.remote.group.device';

/**
 * 生成或复用群体版 P-256 设备密钥（幂等：同 label 已存在则返回既有公钥）。
 * 返回的 publicKey 为 base64url(未压缩点，65 字节)，配对时提交给主机。
 */
export async function generateGroupDeviceKey(label?: string): Promise<GroupDeviceKeyResult> {
  const module = requireModule();
  if (typeof module.generateGroupDeviceKey !== 'function') {
    throw new DshMtlsUnavailableError('原生模块未实现 generateGroupDeviceKey（需要重新构建 App）。');
  }
  return module.generateGroupDeviceKey(label);
}

/** 读取已存在的群体版设备公钥；原生模块未链接或未生成时返回 null。 */
export async function getGroupDevicePublicKey(label?: string): Promise<string | null> {
  if (!nativeModule || typeof nativeModule.getGroupDevicePublicKey !== 'function') return null;
  return nativeModule.getGroupDevicePublicKey(label);
}

/** 用群体版设备私钥对 challenge 原始字节签名（返回 base64url(DER ECDSA-SHA256)）。 */
export async function signGroupChallenge(label: string, messageBase64: string): Promise<GroupChallengeSignature> {
  const module = requireModule();
  if (typeof module.signGroupChallenge !== 'function') {
    throw new DshMtlsUnavailableError('原生模块未实现 signGroupChallenge（需要重新构建 App）。');
  }
  return module.signGroupChallenge(label, messageBase64);
}

/** 删除群体版设备密钥（解除配对/换身份时用；幂等）。 */
export async function clearGroupDeviceKey(label?: string): Promise<boolean> {
  if (!nativeModule || typeof nativeModule.clearGroupDeviceKey !== 'function') return false;
  return nativeModule.clearGroupDeviceKey(label);
}

/**
 * 把 relay 下发的短时会话 token 注入 WebView cookie（`__Host-`，host-only）。
 *
 * 注意：iOS 的 `HTTPCookie` 属性 API 无法表达 HttpOnly（WebKit 不允许程序化设置）；
 * 生产流程应让 relay 的 `Set-Cookie` 在 WebView 内发请求时写入（带 HttpOnly），
 * 本函数用于 native 侧直接注入/续期（Secure / SameSite=Strict / host-only 仍生效）。
 */
export async function setGroupSessionCookie(options: GroupSessionCookieOptions): Promise<boolean> {
  const module = requireModule();
  if (typeof module.setSessionCookie !== 'function') {
    throw new DshMtlsUnavailableError('原生模块未实现 setSessionCookie（需要重新构建 App）。');
  }
  return module.setSessionCookie(options);
}

/** 与原生函数名保持一致的别名（App 侧可任选 setGroupSessionCookie / setSessionCookie）。 */
export const setSessionCookie = setGroupSessionCookie;

/**
 * Standard Keychain/Keystore label for this app's device identity. Keeping it
 * deterministic makes re-pairing / Keychain cleanup straightforward.
 */
export function defaultClientIdentityLabel(deviceId: string): string {
  return `com.dsh.remote.device.${deviceId}`;
}
