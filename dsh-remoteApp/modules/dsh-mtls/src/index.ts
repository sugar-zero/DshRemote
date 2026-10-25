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

/**
 * Standard Keychain/Keystore label for this app's device identity. Keeping it
 * deterministic makes re-pairing / Keychain cleanup straightforward.
 */
export function defaultClientIdentityLabel(deviceId: string): string {
  return `com.dsh.remote.device.${deviceId}`;
}
