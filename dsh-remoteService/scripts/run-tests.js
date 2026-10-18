import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

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
