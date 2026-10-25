/**
 * 主机侧设备管理（通过 mTLS 隧道 API）。
 *
 * 端点（docs/ADMIN-API.md §2）：
 *   GET  /__dsh_remote/status                   → 主机状态（证书到期/relay 连接/版本/设备数）
 *   GET  /__dsh_remote/audit?limit=N            → 最近安全审计（mTLS 设备可读）
 *   GET  /__dsh_remote/devices                  → 已配对设备列表（含 current）
 *   POST /__dsh_remote/devices/:id/revoke       → 撤销设备（立即断链 + 拒绝续期）
 *
 * 这些请求要求设备客户端证书，走原生 `requestWithClientCert`（原生模块未链接时抛错）。
 */
import { isDshMtlsAvailable, requestWithClientCert } from '../../modules/dsh-mtls/src';
import type { StoredConnection } from './store';

export interface AuditEntry {
  ts?: number;
  action: string;
  result?: string;
  deviceId?: string;
  hash?: string;
}

export interface HostStatus {
  hostId: string;
  hostName: string;
  domain: string;
  tls: { subject?: string; notAfter?: string; dev?: boolean; valid?: boolean } | null;
  relayConnected: boolean | null;
  version: string | null;
  devices: { total: number; active: number };
}

export interface RemoteDevice {
  id: string;
  name: string;
  platform: string;
  serial: string;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
  current?: boolean;
}

function hostBase(connection: StoredConnection): string {
  return `https://${connection.host}`;
}

/**
 * 主机 mTLS 管理 API 的失败。`status` 是 HTTP 状态码（0 = 请求没有拿到响应），
 * `code` 是主机返回的机器可读错误码（`{ok:false,error:{code,message}}`）。
 *
 * 401/403 表示设备证书被主机拒绝（已撤销或过期），调用方据此把本地配对记录
 * 标记为「主机侧已解除配对」。
 */
export class HostApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'HostApiError';
    this.status = status;
    this.code = code;
    Object.setPrototypeOf(this, HostApiError.prototype);
  }
}

function parseEnvelope<T>(body: string, status: number): T {
  let json: { ok?: boolean; data?: T; error?: { code?: string; message?: string } };
  try {
    json = JSON.parse(body) as typeof json;
  } catch {
    throw new HostApiError(status, '主机返回了无法解析的响应');
  }
  if (!json.ok || json.data === undefined) {
    throw new HostApiError(
      status,
      json.error?.message ?? `请求失败（HTTP ${status}）`,
      typeof json.error?.code === 'string' ? json.error.code : undefined,
    );
  }
  return json.data;
}

async function requestHost<T>(connection: StoredConnection, path: string, method = 'GET'): Promise<T> {
  const response = await requestWithClientCert({
    url: `${hostBase(connection)}${path}`,
    method,
  });
  return parseEnvelope<T>(response.body, response.status);
}

export function canManageRemoteDevices(): boolean {
  return isDshMtlsAvailable;
}

export async function fetchAudit(connection: StoredConnection, limit = 10): Promise<AuditEntry[]> {
  const data = await requestHost<{ entries: AuditEntry[] }>(
    connection,
    `/__dsh_remote/audit?limit=${encodeURIComponent(String(limit))}`,
  );
  return data.entries ?? [];
}

export async function fetchHostStatus(connection: StoredConnection): Promise<HostStatus> {
  return requestHost<HostStatus>(connection, '/__dsh_remote/status');
}

export async function fetchRemoteDevices(connection: StoredConnection): Promise<RemoteDevice[]> {
  const data = await requestHost<{ devices: RemoteDevice[] }>(connection, '/__dsh_remote/devices');
  return data.devices ?? [];
}

export async function revokeRemoteDevice(connection: StoredConnection, deviceId: string): Promise<void> {
  await requestHost<{ device: RemoteDevice }>(
    connection,
    `/__dsh_remote/devices/${encodeURIComponent(deviceId)}/revoke`,
    'POST',
  );
}
