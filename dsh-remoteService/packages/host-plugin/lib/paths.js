import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';

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
  /** 主机身份（Ed25519）：只用于稳定的主机指纹展示与配对 SAS。 */
  hostIdentity: () => join(remoteDir(), 'host-identity.json'),
  devices: () => join(remoteDir(), 'devices.json'),
  audit: () => join(remoteDir(), 'audit.jsonl'),
  /** 群体版注册结果（0600）：hostId / hostToken / relayDomain / mobilePort / token 公钥 / controlUrl。 */
  groupRegistration: () => join(remoteDir(), 'group.json'),
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
