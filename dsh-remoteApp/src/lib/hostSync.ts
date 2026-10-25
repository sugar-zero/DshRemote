/**
 * 主机 → App 的配对记录同步。
 *
 * 配对成功后，主机名称保存在本机 SecureStore 里，主机会在桌面「远程访问」里
 * 改名（`config.hostName`）。为了不再让手机显示旧名字，App 在回到主机列表 /
 * 回到前台时用 mTLS 请求 `/__dsh_remote/status`：
 *   - 主机名（`hostName`）有变化 → 写回本地记录；
 *   - 主机拒绝本机设备证书（HTTP 401/403，或 iOS 在 TLS 阶段报
 *     `requires a client certificate`）→ 说明设备已被撤销或证书失效，在本机记录上
 *     标记 `revokedAt`，UI 提示「主机侧已解除配对」并提供删除入口；
 *   - 网络/其它错误 → 只返回错误文案，不改变本地状态（避免离线时误判）。
 *
 * 注意：`requestWithClientCert` 使用原生模块里全局配置的身份 label，所以这里按
 * 记录逐台 `setClientIdentity()` 串行同步；结束后由调用方恢复当前打开主机的
 * 身份（`restoreIdentityLabel`），避免把 WebView 探活用的身份留在别的设备上。
 */

import { isDshMtlsAvailable, setClientIdentity } from '../../modules/dsh-mtls/src';
import { fetchHostStatus, HostApiError, type HostStatus } from './devices';
import { updateConnection, type StoredConnection } from './store';

/** 设备在主机的状态：有效 / 已被撤销（或证书失效）/ 暂不可知。 */
export type HostRevocationState = 'active' | 'revoked' | 'unknown';

export interface ConnectionSyncResult {
  /** 同步后的记录（`changed` 为 true 时已写回 SecureStore）。 */
  connection: StoredConnection;
  /** 主机名或撤销标记有变化。 */
  changed: boolean;
  revocation: HostRevocationState;
  /** 成功读取到的主机状态（设备与安全页直接复用，避免重复请求）。 */
  status: HostStatus | null;
  /** 网络/原生模块等非认证错误；null 表示请求成功。 */
  error: string | null;
}

/** 主机认为设备证书无效 / 已撤销时返回的状态码。 */
const AUTH_REJECTED_STATUSES = new Set([401, 403]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * iOS URLSession 在主机拒绝本机客户端证书时，偶尔不会把主机返回的
 * HTTP 401/403 交回 JS，而是在 TLS 阶段直接抛
 * `The server "..." requires a client certificate.`（本机身份仍在 Keychain 里，
 * 只是主机不再接受它）。真机实测：主机侧撤销设备后就是这条错误。
 */
const CLIENT_CERT_REJECTED_TEXT = /requires a client certificate|client certificate required/i;

function isCertificateRejected(error: unknown): boolean {
  if (error instanceof HostApiError) return AUTH_REJECTED_STATUSES.has(error.status);
  return CLIENT_CERT_REJECTED_TEXT.test(errorMessage(error));
}

/** 同步一台主机：更新主机名、检测主机侧撤销。不会抛错。 */
export async function syncConnectionWithHost(connection: StoredConnection): Promise<ConnectionSyncResult> {
  if (!isDshMtlsAvailable) {
    return {
      connection,
      changed: false,
      revocation: connection.revokedAt ? 'revoked' : 'unknown',
      status: null,
      error: '当前构建未链接原生 mTLS 模块，无法读取主机状态',
    };
  }
  if (!connection.certRef) {
    return {
      connection,
      changed: false,
      revocation: connection.revokedAt ? 'revoked' : 'unknown',
      status: null,
      error: '本机没有可用的设备证书引用，无法读取主机状态',
    };
  }
  let identityConfigured = false;
  try {
    await setClientIdentity(connection.certRef);
    identityConfigured = true;
  } catch {
    // 配置身份失败时下面的请求会给出具体错误；这里不提前返回，方便统一处理。
  }

  try {
    const status = await fetchHostStatus(connection);
    const hostName = typeof status.hostName === 'string' ? status.hostName.trim() : '';
    const next: StoredConnection = { ...connection };
    let changed = false;
    if (hostName && hostName !== connection.hostName) {
      next.hostName = hostName;
      changed = true;
    }
    if (next.revokedAt !== undefined) {
      delete next.revokedAt;
      changed = true;
    }
    // 只更新已存在的记录：用户刚好删除了这条记录时不要把它写回来。
    if (changed) await updateConnection(next).catch(() => false);
    return { connection: next, changed, revocation: 'active', status, error: null };
  } catch (error) {
    if (identityConfigured && isCertificateRejected(error)) {
      const changed = connection.revokedAt === undefined;
      const next: StoredConnection = changed
        ? { ...connection, revokedAt: Date.now() }
        : connection;
      if (changed) await updateConnection(next).catch(() => false);
      return { connection: next, changed, revocation: 'revoked', status: null, error: null };
    }
    return {
      connection,
      changed: false,
      revocation: connection.revokedAt ? 'revoked' : 'unknown',
      status: null,
      error: errorMessage(error),
    };
  }
}

export interface SyncConnectionsResult {
  results: ConnectionSyncResult[];
  /** 同步后的完整列表（顺序与入参一致）。 */
  connections: StoredConnection[];
  revokedCount: number;
}

export interface SyncConnectionsOptions {
  /** 同步结束后恢复的原生 identity label（通常是当前打开主机的 certRef）。 */
  restoreIdentityLabel?: string | null;
}

/** 串行同步全部配对主机（原生 mTLS 身份是全局的，不能并发）。 */
export async function syncConnectionsWithHost(
  connections: StoredConnection[],
  options: SyncConnectionsOptions = {},
): Promise<SyncConnectionsResult> {
  const results: ConnectionSyncResult[] = [];
  for (const connection of connections) {
    results.push(await syncConnectionWithHost(connection));
  }
  if (options.restoreIdentityLabel) {
    try {
      await setClientIdentity(options.restoreIdentityLabel);
    } catch {
      // 恢复失败不影响本机记录，下一次打开主机/探活会重新配置身份。
    }
  }
  return {
    results,
    connections: results.map((result) => result.connection),
    revokedCount: results.filter((result) => result.revocation === 'revoked').length,
  };
}

/** 主机名展示：优先主机名，其次隧道地址。 */
export function displayHostName(connection: StoredConnection): string {
  return connection.hostName || connection.host;
}
