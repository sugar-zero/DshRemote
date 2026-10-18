/**
 * DSH Remote — secure persistence for the paired host connection.
 *
 * Security boundary (evaluation §4.4 / §4.7):
 *  - The device PRIVATE KEY is generated and kept by the native module in the
 *    iOS Keychain / Android Keystore. It is never exported to JS and must never
 *    be written through this wrapper.
 *  - This wrapper only stores non-key credentials: host metadata, device id,
 *    host fingerprint, and (for the POC) the issued certificate PEM. The
 *    certificate is public information; it still lives in SecureStore/Keychain
 *    because it identifies this device to the host.
 *  - `certRef` is a Keychain/Keystore label the native mTLS module uses to look
 *    up the identity (see `modules/dsh-mtls`).
 *
 * Platform notes:
 *  - iOS: Keychain via expo-secure-store, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`
 *    (no iCloud sync, no backup restore to another device).
 *  - Android: EncryptedSharedPreferences via expo-secure-store. Android limits a
 *    single stored value (~2 KB), so PEM blobs are chunked below.
 *  - Web: expo-secure-store is unavailable; a memory-only fallback keeps the
 *    UI preview runnable (`npm run web`). It is never persistent and never used
 *    for real pairing.
 */

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

export const CONNECTION_STORAGE_KEY = 'dshremote.connection.v1';
export const CERTIFICATE_STORAGE_KEY = 'dshremote.cert.v1';
export const DEVICE_NAME_STORAGE_KEY = 'dshremote.deviceName.v1';

/** Max characters per SecureStore value. Android enforces ~2048 bytes; stay well below. */
const CHUNK_SIZE = 1400;

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

/** True when the platform has a real secure store (false on web preview). */
export async function isSecureStoreAvailable(): Promise<boolean> {
  if (isWeb) return false;
  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Connection record
// ---------------------------------------------------------------------------

/**
 * Persisted host connection. Field names intentionally mirror the pairing
 * response + ADMIN-API host metadata so screens can use them directly.
 */
export interface StoredConnection {
  /** Tunnel host, e.g. `h_ab12cd34.relay.example.com` (`https://${host}`). */
  host: string;
  /** Relay base domain, e.g. `relay.example.com`. */
  relayDomain: string;
  /** Full SHA-256 host identity fingerprint (base64url). */
  hostFingerprint: string;
  /** Device id issued by the host (`d_...`). */
  deviceId: string;
  /** Human-readable device name shown on the desktop device list. */
  deviceName: string;
  /**
   * Keychain/Keystore label of the client identity used for mTLS
   * (`DSHMTLS.setClientIdentity(label)`). Absent until the native identity is
   * installed.
   */
  certRef?: string;
  /** Host display name returned by the pairing response, if any. */
  hostName?: string;
  /** Epoch ms when pairing completed. */
  pairedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStoredConnection(value: unknown): value is StoredConnection {
  if (!isRecord(value)) return false;
  return (
    typeof value.host === 'string' &&
    typeof value.relayDomain === 'string' &&
    typeof value.hostFingerprint === 'string' &&
    typeof value.deviceId === 'string' &&
    typeof value.deviceName === 'string' &&
    typeof value.pairedAt === 'number'
  );
}

export async function saveConnection(connection: StoredConnection): Promise<void> {
  await setItem(CONNECTION_STORAGE_KEY, JSON.stringify(connection));
}

export async function loadConnection(): Promise<StoredConnection | null> {
  const raw = await getItem(CONNECTION_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isStoredConnection(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function clearConnection(): Promise<void> {
  await deleteItem(CONNECTION_STORAGE_KEY);
}

// ---------------------------------------------------------------------------
// Certificate PEM (POC: may live in SecureStore until the native identity store
// owns it; the private key is already native-only)
// ---------------------------------------------------------------------------

export interface StoredCertificate {
  /** PEM for the device certificate issued by the host device CA. */
  certPem: string;
  /** PEM for the host device CA (needed if a native HTTP client verifies mTLS). */
  caPem: string;
  /** Epoch ms when stored. */
  storedAt: number;
}

interface CertificateChunkMeta {
  chunkCount: number;
  storedAt: number;
  sha256Hint?: string;
}

function chunkKey(index: number): string {
  return `${CERTIFICATE_STORAGE_KEY}.chunk.${index}`;
}

function metaKey(): string {
  return `${CERTIFICATE_STORAGE_KEY}.meta`;
}

/**
 * Store both PEMs as chunked values: `{certPem: string, caPem: string}` JSON is
 * split into <=1400-char pieces to stay inside Android's per-value limit.
 */
export async function saveCertificate(certificate: StoredCertificate): Promise<void> {
  const payload = JSON.stringify({
    certPem: certificate.certPem,
    caPem: certificate.caPem,
    storedAt: certificate.storedAt,
  });
  const previous = await loadCertificateMeta();
  const chunks: string[] = [];
  for (let offset = 0; offset < payload.length; offset += CHUNK_SIZE) {
    chunks.push(payload.slice(offset, offset + CHUNK_SIZE));
  }
  await Promise.all(chunks.map((chunk, index) => setItem(chunkKey(index), chunk)));

  const meta: CertificateChunkMeta = { chunkCount: chunks.length, storedAt: certificate.storedAt };
  await setItem(metaKey(), JSON.stringify(meta));

  // Remove stale trailing chunks from a previous, longer certificate.
  if (previous) {
    for (let index = chunks.length; index < previous.chunkCount; index += 1) {
      await deleteItem(chunkKey(index));
    }
  }
}

async function loadCertificateMeta(): Promise<CertificateChunkMeta | null> {
  const raw = await getItem(metaKey());
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (typeof parsed.chunkCount !== 'number' || typeof parsed.storedAt !== 'number') return null;
    return { chunkCount: parsed.chunkCount, storedAt: parsed.storedAt };
  } catch {
    return null;
  }
}

export async function loadCertificate(): Promise<StoredCertificate | null> {
  const meta = await loadCertificateMeta();
  if (!meta) return null;
  const parts: string[] = [];
  for (let index = 0; index < meta.chunkCount; index += 1) {
    const chunk = await getItem(chunkKey(index));
    if (chunk === null) return null; // Corrupted/partial record: treat as absent.
    parts.push(chunk);
  }
  try {
    const parsed: unknown = JSON.parse(parts.join(''));
    if (!isRecord(parsed)) return null;
    if (typeof parsed.certPem !== 'string' || typeof parsed.caPem !== 'string') return null;
    const storedAt = typeof parsed.storedAt === 'number' ? parsed.storedAt : meta.storedAt;
    return { certPem: parsed.certPem, caPem: parsed.caPem, storedAt };
  } catch {
    return null;
  }
}

export async function clearCertificate(): Promise<void> {
  const meta = await loadCertificateMeta();
  if (meta) {
    for (let index = 0; index < meta.chunkCount; index += 1) {
      await deleteItem(chunkKey(index));
    }
  }
  await deleteItem(metaKey());
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

// ---------------------------------------------------------------------------
// Aggregate operations
// ---------------------------------------------------------------------------

/** Remove every credential this app persists (used by "重新配对"). */
export async function clearAll(): Promise<void> {
  await Promise.all([clearConnection(), clearCertificate(), deleteItem(DEVICE_NAME_STORAGE_KEY)]);
}

/** Quick summary for the devices screen. */
export interface StoredCredentialSummary {
  connection: StoredConnection | null;
  hasCertificate: boolean;
  certificateStoredAt: number | null;
}

export async function loadCredentialSummary(): Promise<StoredCredentialSummary> {
  const [connection, certificate] = await Promise.all([loadConnection(), loadCertificate()]);
  return {
    connection,
    hasCertificate: certificate !== null,
    certificateStoredAt: certificate?.storedAt ?? null,
  };
}
