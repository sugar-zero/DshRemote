import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, chmodSync } from 'node:fs';

/** DSH home（$DSH_HOME 或 ~/.dsh）。每次调用时读取，便于测试注入。 */
export function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh');
}

export function remoteDir() {
  return join(dshHome(), 'remote-access');
}

export const paths = {
  dir: remoteDir,
  config: () => join(remoteDir(), 'config.json'),
  hostIdentity: () => join(remoteDir(), 'host-identity.json'),
  deviceCaKey: () => join(remoteDir(), 'device-ca', 'key.pem'),
  deviceCaCert: () => join(remoteDir(), 'device-ca', 'cert.pem'),
  devices: () => join(remoteDir(), 'devices.json'),
  audit: () => join(remoteDir(), 'audit.jsonl'),
  devTlsCert: () => join(remoteDir(), 'dev-tls', 'cert.pem'),
  devTlsKey: () => join(remoteDir(), 'dev-tls', 'key.pem'),
  pushTokens: () => join(remoteDir(), 'push-tokens.json'),
  groupRegistration: () => join(remoteDir(), 'group.json'),
  log: () => join(remoteDir(), 'plugin.log'),
};

export function ensureDir(dir, mode = 0o700) {
  mkdirSync(dir, { recursive: true, mode });
  try { chmodSync(dir, mode); } catch { /* 某些文件系统不支持 chmod */ }
}

export function ensureParent(file) {
  ensureDir(join(file, '..'));
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value, mode = 0o600) {
  ensureParent(file);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  try { chmodSync(tmp, mode); } catch { /* ignore */ }
  renameSync(tmp, file);
  try { chmodSync(file, mode); } catch { /* ignore */ }
}

export function writeText(file, text, mode = 0o600) {
  ensureParent(file);
  writeFileSync(file, text, { mode });
  try { chmodSync(file, mode); } catch { /* ignore */ }
}

export function fileExists(file) {
  try { return existsSync(file); } catch { return false; }
}
