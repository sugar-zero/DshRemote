import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/** Windows 上的 openssl 经常能跑 `version`，但没有默认 openssl.cnf，`req`/`x509` 会直接失败。 */
function ensureWindowsOpensslConf() {
  if (process.platform !== 'win32') return;
  if (process.env.OPENSSL_CONF && existsSync(process.env.OPENSSL_CONF)) return;
  const dir = mkdtempSync(join(tmpdir(), 'dsh-remote-openssl-'));
  const file = join(dir, 'openssl.cnf');
  writeFileSync(file, [
    'openssl_conf = openssl_init',
    '[openssl_init]',
    '[req]',
    'distinguished_name = req_dn',
    'prompt = no',
    '[req_dn]',
    'CN = dsh-remote',
    '',
  ].join('\n'));
  process.env.OPENSSL_CONF = file;
}

ensureWindowsOpensslConf();

const files = [];
for (const pkg of ['protocol', 'host-plugin', 'relay']) {
  const dir = `packages/${pkg}/test`;
  try {
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.test.js')) files.push(`${dir}/${name}`);
    }
  } catch { /* package has no tests yet */ }
}
if (files.length === 0) {
  console.error('no test files found');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
