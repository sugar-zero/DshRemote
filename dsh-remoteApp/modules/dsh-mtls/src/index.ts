/**
 * dsh-mtls — JS bridge for the DSH Remote native module（群体服务版 / A 模式）。
 *
 * 历史原因保留模块名 `DSHMTLS`（减少工程改动），但模块内部只保留群体版能力：
 *   - P-256 设备密钥的生成/复用（iOS Secure Enclave 优先，Android AndroidKeyStore）；
 *   - 对 relay challenge 原始字节做 ECDSA-SHA256 签名（私钥不出安全区）；
 *   - 把短时 token 注入 WebView 的 `__Host-dsh_session` cookie；
 *   - 带会话 cookie 的原生 HTTPS 请求（主机 status / restart 内部接口）；
 *   - 清理 WebView 缓存（设置页「清理缓存」）；
 *   - 底部边缘系统手势 defer（iOS：页面内悬浮挂件贴到屏幕最底边时仍可拖动）。
 *
 * classic/单体 mTLS 模式的原生能力（CSR / PKCS#12 导入 / 设备证书 / 原生 mTLS
 * WebView / URLSession 客户端证书请求）已从 App 中删除，不再出现在这个 bridge。
 *
 * 未链接原生模块时（Expo Go / web 预览）所有函数会抛 {@link DshMtlsUnavailableError}，
 * 由调用方给出可读提示，不会让 JS bundle 崩溃。
 */

import { requireOptionalNativeModule } from 'expo-modules-core';

/** Native module name; must match `Name("DSHMTLS")` in Swift/Kotlin. */
export const DSH_MTLS_MODULE_NAME = 'DSHMTLS';

/** 群体版设备密钥的默认 label（与原生侧 defaultLabel 保持一致）。 */
export const GROUP_DEVICE_KEY_LABEL = 'com.dsh.remote.group.device';

/** Error thrown when the JS code expects the native module but it is absent. */
export class DshMtlsUnavailableError extends Error {
  constructor(detail?: string) {
    super(
      detail ??
        'DSH 原生模块不可用：当前构建没有链接 modules/dsh-mtls。' +
          '请用 `npx expo run:ios`/`run:android` 构建原生包（Expo Go 不包含该模块）。',
    );
    this.name = 'DshMtlsUnavailableError';
    Object.setPrototypeOf(this, DshMtlsUnavailableError.prototype);
  }
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

/** 带会话 cookie 的 HTTPS 请求参数（群体版隧道内已鉴权内部接口）。 */
export interface GroupHttpFetchOptions {
  /** 完整隧道 URL，必须 https（如 `https://<host>:<port>/__dsh_remote/status`）。 */
  url: string;
  /** 短时会话 token（由 relay challenge 换得，只在本进程内存中）。 */
  token: string;
  /** GET / POST。 */
  method: 'GET' | 'POST';
  /** JSON 请求体（已有字符串，原生侧原样发送）。 */
  body?: string;
  /** 超时毫秒（默认 15000；重启探活用 3000）。 */
  timeoutMs?: number;
}

/** 带会话 cookie 的 HTTPS 请求结果（body 为原始文本，JSON 解析交给 JS）。 */
export interface GroupHttpFetchResult {
  status: number;
  body: string;
}

interface NativeDshMtlsModule {
  /** 生成/复用 P-256 设备密钥（iOS Secure Enclave 优先，Android AndroidKeyStore）。 */
  generateGroupDeviceKey(label?: string): Promise<GroupDeviceKeyResult>;
  /** 读取已存在的设备公钥；不存在返回 null。 */
  getGroupDevicePublicKey(label?: string): Promise<string | null>;
  /** 用设备私钥对 challenge 原始字节做 ECDSA-SHA256 签名。 */
  signGroupChallenge(label: string, messageBase64: string): Promise<GroupChallengeSignature>;
  /** 删除本机设备密钥（幂等）。 */
  clearGroupDeviceKey(label?: string): Promise<boolean>;
  /** 把 relay 下发的短时 token 注入 WebView cookie（`__Host-` host-only）。 */
  setSessionCookie(options: GroupSessionCookieOptions): Promise<boolean>;
  /**
   * 带 `__Host-dsh_session` cookie 的 HTTPS 请求（relay 边缘只认 cookie，
   * 用于 `/__dsh_remote/status`、`/__dsh_remote/restart`）。
   */
  groupHttpFetch(options: GroupHttpFetchOptions): Promise<GroupHttpFetchResult>;
  /** 清理 WebView 持久化缓存 / Cookie / DOM 存储（设置页“清理缓存”）。 */
  clearWebCache(): Promise<boolean>;
  /**
   * 进入主机 WebView 可见时调用：defer iOS 底部边缘（Home 指示条）的
   * 「上滑回主屏」系统手势，让页面内的悬浮挂件可以从屏幕最底边起手拖动。
   * 离开主机页面时传 false 恢复系统默认。Android 为 no-op（返回 false）。
   */
  setBottomEdgeGestureDeferral(enabled: boolean): Promise<boolean>;
}

const nativeModule = requireOptionalNativeModule<NativeDshMtlsModule>(DSH_MTLS_MODULE_NAME);

/** True when this build linked the native module. */
export const isDshMtlsAvailable = nativeModule !== null;

function requireModule(): NativeDshMtlsModule {
  if (!nativeModule) throw new DshMtlsUnavailableError();
  return nativeModule;
}

/**
 * 生成或复用群体版 P-256 设备密钥（幂等：同 label 已存在则返回既有公钥）。
 * 返回的 publicKey 为 base64url(未压缩点，65 字节)，配对时提交给主机。
 */
export async function generateGroupDeviceKey(label?: string): Promise<GroupDeviceKeyResult> {
  return requireModule().generateGroupDeviceKey(label);
}

/** 读取已存在的群体版设备公钥；原生模块未链接时返回 null。 */
export async function getGroupDevicePublicKey(label?: string): Promise<string | null> {
  if (!nativeModule) return null;
  return nativeModule.getGroupDevicePublicKey(label);
}

/** 用群体版设备私钥对 challenge 原始字节签名（返回 base64url(DER ECDSA-SHA256)）。 */
export async function signGroupChallenge(label: string, messageBase64: string): Promise<GroupChallengeSignature> {
  return requireModule().signGroupChallenge(label, messageBase64);
}

/** 删除群体版设备密钥（解除配对/换身份时用；幂等）。 */
export async function clearGroupDeviceKey(label?: string): Promise<boolean> {
  if (!nativeModule) return false;
  return nativeModule.clearGroupDeviceKey(label);
}

/**
 * 把 relay 下发的短时会话 token 注入 WebView cookie（`__Host-`，host-only）。
 *
 * 注意：iOS 的 `HTTPCookie` 属性 API 无法表达 HttpOnly（WebKit 不允许程序化设置）；
 * HttpOnly 由 relay 的 `Set-Cookie` 在 WebView 内发请求时写入（见设计文档 §7），
 * 本函数用于 native 侧直接注入/续期（Secure / SameSite=Strict / host-only 仍生效）。
 */
export async function setGroupSessionCookie(options: GroupSessionCookieOptions): Promise<boolean> {
  return requireModule().setSessionCookie(options);
}

/** 与原生函数名保持一致的别名（group.ts 用 setSessionCookie）。 */
export const setSessionCookie = setGroupSessionCookie;

/**
 * 带 `__Host-dsh_session` 会话 cookie 的 HTTPS 请求（原生实现）。
 *
 * 用途：群体版隧道内的已鉴权内部接口（`GET /__dsh_remote/status`、
 * `POST /__dsh_remote/restart`）。relay 边缘对普通隧道流量只校验
 * `__Host-dsh_session` cookie，而 JS `fetch` 拿不到 WebView 的 cookie store，
 * 因此由原生显式带 cookie 发请求。只允许 https，不涉及任何设备证书 / mTLS。
 */
export async function groupHttpFetch(options: GroupHttpFetchOptions): Promise<GroupHttpFetchResult> {
  return requireModule().groupHttpFetch(options);
}

/** 清理 WebView 缓存/Cookie/本地存储；用于设置页“清理缓存”（清理后调用方应重载 WebView）。 */
export async function clearWebCache(): Promise<boolean> {
  return requireModule().clearWebCache();
}

/**
 * 底部边缘系统手势 defer（仅 iOS 生效）。
 *
 * 进入主机 WebView 可见时传 true：iOS 底部边缘（Home 指示条）的「上滑回主屏」手势被
 * defer 一次——页面里的可拖动悬浮挂件贴到屏幕最底边后，仍能从底边起手拖动，而不会被
 * 系统手势切到后台；再次上滑才回主屏。离开主机页面时传 false 恢复系统默认。
 *
 * Android 的手势导航没有等价接口（原生为 no-op，返回 false）；原生模块未链接时也返回 false。
 */
export async function setBottomEdgeGestureDeferral(enabled: boolean): Promise<boolean> {
  if (!nativeModule) return false;
  return nativeModule.setBottomEdgeGestureDeferral(enabled);
}
