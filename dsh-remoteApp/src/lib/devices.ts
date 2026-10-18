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

function parseEnvelope<T>(body: string): T {
  let json: { ok?: boolean; data?: T; error?: { message?: string } };
  try {
    json = JSON.parse(body) as typeof json;
  } catch {
    throw new Error('主机返回了无法解析的响应');
  }
  if (!json.ok || json.data === undefined) {
    throw new Error(json.error?.message ?? '请求失败');
  }
  return json.data;
}

export function canManageRemoteDevices(): boolean {
  return isDshMtlsAvailable;
}

export async function fetchAudit(connection: StoredConnection, limit = 10): Promise<AuditEntry[]> {
  const response = await requestWithClientCert({
    url: `${hostBase(connection)}/__dsh_remote/audit?limit=${encodeURIComponent(String(limit))}`,
    method: 'GET',
  });
  if (response.status !== 200) throw new Error(`读取审计失败：HTTP ${response.status}`);
  return parseEnvelope<{ entries: AuditEntry[] }>(response.body).entries ?? [];
}

export async function fetchHostStatus(connection: StoredConnection): Promise<HostStatus> {
  const response = await requestWithClientCert({
    url: `${hostBase(connection)}/__dsh_remote/status`,
    method: 'GET',
  });
  if (response.status !== 200) throw new Error(`读取主机状态失败：HTTP ${response.status}`);
  return parseEnvelope<HostStatus>(response.body);
}

export async function fetchRemoteDevices(connection: StoredConnection): Promise<RemoteDevice[]> {
  const response = await requestWithClientCert({
    url: `${hostBase(connection)}/__dsh_remote/devices`,
    method: 'GET',
  });
  if (response.status !== 200) throw new Error(`读取设备列表失败：HTTP ${response.status}`);
  return parseEnvelope<{ devices: RemoteDevice[] }>(response.body).devices ?? [];
}

export async function revokeRemoteDevice(connection: StoredConnection, deviceId: string): Promise<void> {
  const response = await requestWithClientCert({
    url: `${hostBase(connection)}/__dsh_remote/devices/${encodeURIComponent(deviceId)}/revoke`,
    method: 'POST',
  });
  if (response.status !== 200) throw new Error(`撤销设备失败：HTTP ${response.status}`);
  parseEnvelope<{ device: RemoteDevice }>(response.body);
}
