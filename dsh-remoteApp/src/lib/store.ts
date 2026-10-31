/**
 * DSH Remote — 群体服务版（A 模式）本地持久化。
 *
 * 安全边界：
 *  - 群体版设备私钥（P-256）只存在 iOS Secure Enclave / Keychain 或 AndroidKeyStore，
 *    由原生模块生成和持有，不经过 JS、也不写入这里；本文件只保存密钥的 **label**。
 *  - 会话 token 只存在内存 + WebView 的 `__Host-dsh_session` cookie 中，**不落盘**。
 *  - 本文件保存：主机元数据（host / hostId / port / relayDomain / 指纹）、设备 ID、
 *    设备名、设备密钥 label、配对时间。
 *  - classic/单体 mTLS 版遗留的连接记录（含设备证书 PEM）在加载时**直接丢弃**，
 *    不做迁移：群体版 App 不再支持 classic 模式。
 *
 * Platform notes:
 *  - iOS: Keychain via expo-secure-store, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`
 *    (no iCloud sync, no backup restore to another device).
 *  - Android: EncryptedSharedPreferences via expo-secure-store.
 *  - Web: expo-secure-store is unavailable; a memory-only fallback keeps the
 *    UI preview runnable (`npm run web`). It is never persistent and never used
 *    for real pairing.
 */

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/** v2 多主机列表（每台 host 一条；群体版记录）。 */
export const CONNECTIONS_STORAGE_KEY = 'dshremote.connections.v2';
/** classic/单体版的单条连接记录；加载时清理，不迁移。 */
export const LEGACY_CONNECTION_STORAGE_KEY = 'dshremote.connection.v1';
/** classic/单体版的设备证书 PEM 前缀；加载时清理，不迁移。 */
export const LEGACY_CERTIFICATE_STORAGE_KEY = 'dshremote.cert.v1';
export const DEVICE_NAME_STORAGE_KEY = 'dshremote.deviceName.v1';

const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

const isWeb = Platform.OS === 'web';
const memoryStore = new Map<string, string>();

async function getItem(key: string): Promise<string | null> {
  if (isWeb) return memoryStore.get(key) ?? null;
  return SecureStore.getItemAsync(key, SECURE_STORE_OPTIONS);
}

async function setItem(key: string, value: string): Promise<void> {
  if (isWeb) {
    memoryStore.set(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value, SECURE_STORE_OPTIONS);
}

async function deleteItem(key: string): Promise<void> {
  if (isWeb) {
    memoryStore.delete(key);
    return;
  }
  await SecureStore.deleteItemAsync(key, SECURE_STORE_OPTIONS).catch(() => {
    // Deleting a key that does not exist is not an error for callers.
  });
}

// ---------------------------------------------------------------------------
// Connection record (group service / token auth only)
// ---------------------------------------------------------------------------

/**
 * 已配对主机的一条群体版记录。
 *
 * 设备身份 = 服务端登记的设备公钥 + 本机 Keychain/Keystore 里的私钥；
 * `deviceKeyLabel` 用来让原生模块找到这把密钥，它不是秘密。
 */
export interface StoredConnection {
  /** Tunnel host, e.g. `h_ab12cd34.relay.example.com`（`https://${host}:${port}`）。 */
  host: string;
  /** Relay base domain, e.g. `relay.example.com`. */
  relayDomain: string;
  /** Full SHA-256 host identity fingerprint (base64url). */
  hostFingerprint: string;
  /** Device id issued by the host (`d_...`). */
  deviceId: string;
  /** Human-readable device name shown on the desktop device list. */
  deviceName: string;
  /** 服务端分配/管理的主机 ID（`h_...`）。 */
  hostId: string;
  /** 手机访问端口（服务端自签 TLS 终止在 relay 边缘）。 */
  port: number;
  /** Keychain/Keystore label of the P-256 group device key. */
  deviceKeyLabel: string;
  /** Host display name returned by the pairing response, if any. */
  hostName?: string;
  /**
   * 「打开此连接时要求面容」开关（0.1.3 起，每台主机独立）。
   *
   * 仅在全局 App 锁（设置页，负责冷启动解锁）开启时生效；
   * 旧记录 / 未设置时为 undefined（等价 false，不需要迁移）。
   */
  requireBiometricOnOpen?: boolean;
  /** Epoch ms when pairing completed. */
  pairedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 把持久化记录规范化为群体版连接；不兼容的记录返回 null（由调用方丢弃）。
 *
 * - 0.1.1 把 `certRef` 改名为 `deviceKeyLabel`：旧群体版记录（authMode='token'）里的
 *   certRef 就是 P-256 设备密钥 label，这里迁移过来，升级安装不需要重新配对；
 * - 0.1.3 新增可选的 `requireBiometricOnOpen`（每台主机「打开此连接时要求面容」）：
 *   旧记录没有该字段时保持 undefined（等价 false），不强制迁移；
 * - classic/单体版记录没有 hostId/port（也没有 group 设备密钥），一律丢弃、不迁移。
 */
function normalizeStoredConnection(value: unknown): StoredConnection | null {
  if (!isRecord(value)) return null;
  const hostId = typeof value.hostId === 'string' ? value.hostId : '';
  const port = Number(value.port);
  const deviceKeyLabel = typeof value.deviceKeyLabel === 'string'
    ? value.deviceKeyLabel
    : typeof value.certRef === 'string'
      ? value.certRef
      : '';
  if (
    typeof value.host !== 'string' ||
    value.host === '' ||
    typeof value.relayDomain !== 'string' ||
    typeof value.hostFingerprint !== 'string' ||
    typeof value.deviceId !== 'string' ||
    typeof value.deviceName !== 'string' ||
    hostId === '' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    deviceKeyLabel === '' ||
    typeof value.pairedAt !== 'number'
  ) {
    return null;
  }
  return {
    host: value.host,
    relayDomain: value.relayDomain,
    hostFingerprint: value.hostFingerprint,
    deviceId: value.deviceId,
    deviceName: value.deviceName,
    hostId,
    port,
    deviceKeyLabel,
    ...(typeof value.hostName === 'string' ? { hostName: value.hostName } : {}),
    // 只保留 true：旧记录没有该字段 = 关闭（默认行为不变）。
    ...(value.requireBiometricOnOpen === true ? { requireBiometricOnOpen: true } : {}),
    pairedAt: value.pairedAt,
  };
}

function connectionIdentity(connection: StoredConnection): string {
  return `${connection.host}|${connection.deviceId}`;
}

/** 两条配对记录是否指向同一台主机上的同一设备。 */
export function isSameConnection(a: StoredConnection, b: StoredConnection): boolean {
  return connectionIdentity(a) === connectionIdentity(b);
}

/**
 * 清除 classic/单体版遗留的凭据（连接记录 + 设备证书 PEM）。
 * 仅清理已知的 key：旧版本的证书按 hostFingerprint 分片存储，无法枚举，
 * 但其中只有公开证书 PEM（私钥从来只在 Keychain/Keystore），不再被任何代码读取。
 */
async function clearLegacyClassicCredentials(): Promise<void> {
  await Promise.all([
    deleteItem(LEGACY_CONNECTION_STORAGE_KEY),
    deleteItem(LEGACY_CERTIFICATE_STORAGE_KEY),
    deleteItem(`${LEGACY_CERTIFICATE_STORAGE_KEY}.meta`),
  ]);
}

/**
 * 读取所有已配对主机（只返回群体版记录）。
 *
 * 旧 classic/单体版数据（单条 v1 连接 + 设备证书）不再迁移：过滤后直接写回本机记录，
 * 让用户从主机列表/扫码页重新配对。
 */
export async function loadConnections(): Promise<StoredConnection[]> {
  await clearLegacyClassicCredentials();
  const raw = await getItem(CONNECTIONS_STORAGE_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const stored = parsed
    .map(normalizeStoredConnection)
    .filter((item): item is StoredConnection => item !== null);
  if (JSON.stringify(stored) !== JSON.stringify(parsed)) {
    // 过滤掉了 classic 记录，或迁移了旧的 certRef 字段：把规范化的列表写回。
    try {
      if (stored.length === 0) await deleteItem(CONNECTIONS_STORAGE_KEY);
      else await setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // 写回失败不影响本次返回，内存里的连接仍可用。
    }
  }
  return stored;
}

/**
 * 串行化「读-改-写」连接列表的操作，避免并发的保存/删除互相覆盖。
 */
let connectionWriteQueue: Promise<void> = Promise.resolve();

function withConnectionWriteLock<T>(task: () => Promise<T>): Promise<T> {
  const run = connectionWriteQueue.then(task, task);
  connectionWriteQueue = run.then(() => undefined, () => undefined);
  return run;
}

/** 新增/更新一台已配对主机（同一 host+deviceId 覆盖）。 */
export async function saveConnection(connection: StoredConnection): Promise<void> {
  await withConnectionWriteLock(async () => {
    const list = await loadConnections();
    const index = list.findIndex((item) => connectionIdentity(item) === connectionIdentity(connection));
    if (index >= 0) list[index] = connection;
    else list.push(connection);
    await setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(list));
  });
}

/** 仅移除一台主机（保留其它已配对主机）。 */
export async function removeConnection(connection: StoredConnection): Promise<void> {
  await withConnectionWriteLock(async () => {
    const list = await loadConnections();
    const next = list.filter((item) => connectionIdentity(item) !== connectionIdentity(connection));
    if (next.length === 0) await deleteItem(CONNECTIONS_STORAGE_KEY);
    else await setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(next));
  });
}

/**
 * 设置某台主机的「打开此连接时要求面容」开关（0.1.3 起，每台主机独立）。
 *
 * 只在全局 App 锁（设置页，冷启动解锁）开启时生效；关闭时删除字段，
 * 保持「旧记录默认 false」的语义。返回更新后的记录；连接已不存在时返回 null。
 */
export async function setConnectionRequireBiometricOnOpen(
  connection: StoredConnection,
  enabled: boolean,
): Promise<StoredConnection | null> {
  let updated: StoredConnection | null = null;
  await withConnectionWriteLock(async () => {
    const list = await loadConnections();
    const index = list.findIndex((item) => connectionIdentity(item) === connectionIdentity(connection));
    const current = index >= 0 ? list[index] : undefined;
    if (!current) return;
    const next: StoredConnection = { ...current };
    if (enabled) next.requireBiometricOnOpen = true;
    else delete next.requireBiometricOnOpen;
    list[index] = next;
    await setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(list));
    updated = next;
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Device name (editable before pairing, reused for re-pairing)
// ---------------------------------------------------------------------------

export async function saveDeviceName(name: string): Promise<void> {
  await setItem(DEVICE_NAME_STORAGE_KEY, name);
}

export async function loadDeviceName(): Promise<string | null> {
  return getItem(DEVICE_NAME_STORAGE_KEY);
}

/** 忘记用户自定义的设备名（下次配对重新使用系统设备名）。 */
export async function clearDeviceName(): Promise<void> {
  await deleteItem(DEVICE_NAME_STORAGE_KEY);
}
