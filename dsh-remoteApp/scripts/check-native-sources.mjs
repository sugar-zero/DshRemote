#!/usr/bin/env node
/**
 * 原生模块源码一致性检查（无需 Xcode / Android SDK）。
 *
 * 群体服务版（A 模式）App 的原生模块只保留 group 能力；这个脚本静态保证：
 *   1. JS bridge（src/index.ts）的方法与 iOS(Swift)/Android(Kotlin) 的导出方法一致；
 *   2. 两端原生模块名一致（模块名沿用历史的 `DSHMTLS`，减少工程改动）；
 *   3. 群体版关键实现存在：Secure Enclave / AndroidKeyStore P-256、ECDSA-SHA256
 *      签名、`__Host-` 会话 cookie、WebView 缓存清理；
 *   4. classic/单体 mTLS 版的原生文件已删除（防止回潮）；
 *   5. 原生文件括号大致平衡（捕获明显的复制/编辑错误）。
 *
 * 这不能替代真机编译，但能防止两端接口/实现漂移。
 *
 *   node scripts/check-native-sources.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
let failures = 0;
let warnings = 0;
function ok(msg) { console.log(`  ✅ ${msg}`); }
function bad(msg) { console.log(`  ❌ ${msg}`); failures += 1; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings += 1; }

const SWIFT_MODULE = 'modules/dsh-mtls/ios/DSHMTLSModule.swift';
const SWIFT_GROUP_KEYS = 'modules/dsh-mtls/ios/DSHMTLSGroupKeys.swift';
const KOTLIN_MODULE = 'modules/dsh-mtls/android/src/main/java/com/dsh/remote/mtls/DshMtlsModule.kt';
const KOTLIN_GROUP_KEYS = 'modules/dsh-mtls/android/src/main/java/com/dsh/remote/mtls/DshMtlsGroupKeys.kt';

const ts = read('modules/dsh-mtls/src/index.ts');
const swift = read(SWIFT_MODULE);
const kotlin = read(KOTLIN_MODULE);

console.log('== JS bridge ↔ 原生导出方法（群体版：全部必需） ==');
const interfaceStart = ts.indexOf('interface NativeDshMtlsModule');
const interfaceEnd = ts.indexOf('\n}', interfaceStart);
if (interfaceStart < 0 || interfaceEnd < 0) {
  bad('找不到 TS bridge 的 NativeDshMtlsModule 接口');
}
const interfaceText = interfaceStart >= 0 && interfaceEnd > interfaceStart ? ts.slice(interfaceStart, interfaceEnd) : '';
const tsEntries = [...interfaceText.matchAll(/^ {2}(\w+)(\?)?\(/gm)].map((m) => ({ name: m[1], optional: Boolean(m[2]) }));
const nativeFunctionNames = (source) => new Set([...source.matchAll(/(?:Async)?Function\("([^"]+)"/g)].map((m) => m[1]));
const ios = nativeFunctionNames(swift);
const android = nativeFunctionNames(kotlin);

const expectedFunctions = [
  'generateGroupDeviceKey',
  'getGroupDevicePublicKey',
  'signGroupChallenge',
  'clearGroupDeviceKey',
  'setSessionCookie',
  'groupHttpFetch',
  'clearWebCache',
];
for (const name of expectedFunctions) {
  const missing = [];
  if (!tsEntries.some((entry) => entry.name === name)) missing.push('TS');
  if (!ios.has(name)) missing.push('iOS');
  if (!android.has(name)) missing.push('Android');
  if (missing.length === 0) ok(`${name}`);
  else bad(`${name} 在 ${missing.join('/')} 缺失`);
}
for (const entry of tsEntries) {
  if (!expectedFunctions.includes(entry.name)) bad(`TS bridge 出现未预期的 classic 方法：${entry.name}`);
}
for (const name of [...ios, ...android]) {
  if (!tsEntries.some((entry) => entry.name === name)) bad(`原生导出 ${name} 未出现在 TS bridge 接口中`);
}

console.log('== 模块名 ==');
const moduleNames = [
  ['TS', /DSH_MTLS_MODULE_NAME = '([^']+)'/.exec(ts)?.[1]],
  ['iOS', /Name\("([^"]+)"\)/.exec(swift)?.[1]],
  ['Android', /Name\("([^"]+)"\)/.exec(kotlin)?.[1]],
];
const resolvedModuleNames = new Set(moduleNames.map(([, value]) => value).filter(Boolean));
if (resolvedModuleNames.size === 1) ok(`模块名一致：${[...resolvedModuleNames][0]}`);
else bad(`模块名不一致：${moduleNames.map(([label, value]) => `${label}=${value}`).join(', ')}`);

console.log('== 群体版关键实现文件 / API ==');
const requiredFiles = [
  SWIFT_MODULE,
  SWIFT_GROUP_KEYS,
  KOTLIN_MODULE,
  KOTLIN_GROUP_KEYS,
];
for (const file of requiredFiles) {
  if (existsSync(resolve(root, file))) ok(file);
  else bad(`缺少 ${file}`);
}
const apiChecks = [
  ['iOS Secure Enclave 密钥生成', SWIFT_GROUP_KEYS, 'kSecAttrTokenIDSecureEnclave'],
  ['iOS ECDSA-SHA256 签名', SWIFT_GROUP_KEYS, 'ecdsaSignatureMessageX962SHA256'],
  ['iOS 未压缩 P-256 公钥导出', SWIFT_GROUP_KEYS, 'data.count == 65'],
  ['iOS `__Host-` 会话 cookie（SameSite=Strict）', SWIFT_MODULE, 'sameSiteStrict'],
  ['iOS WebView 缓存清理', SWIFT_MODULE, 'WKWebsiteDataStore.allWebsiteDataTypes()'],
  ['Android AndroidKeyStore P-256', KOTLIN_GROUP_KEYS, 'secp256r1'],
  ['Android ECDSA-SHA256 签名', KOTLIN_GROUP_KEYS, 'SHA256withECDSA'],
  ['Android 会话 Cookie（Secure/HttpOnly/SameSite=Strict）', KOTLIN_MODULE, 'HttpOnly; SameSite=Strict'],
  ['Android WebView Cookie/存储清理', KOTLIN_MODULE, 'WebStorage'],
];
for (const [label, file, needle] of apiChecks) {
  if (read(file).includes(needle)) ok(label);
  else bad(`${label}（${file} 缺少 ${needle}）`);
}

console.log('== classic/单体 mTLS 文件必须已删除 ==');
const removedFiles = [
  'modules/dsh-mtls/ios/DSHMTLSCsr.swift',
  'modules/dsh-mtls/ios/DSHMTLSIdentityStore.swift',
  'modules/dsh-mtls/ios/DSHMTLSNetwork.swift',
  'modules/dsh-mtls/ios/DSHMTLSWebView.swift',
  'modules/dsh-mtls/android/src/main/java/com/dsh/remote/mtls/DshMtlsCsr.kt',
  'modules/dsh-mtls/android/src/main/java/com/dsh/remote/mtls/DshMtlsIdentityStore.kt',
  'modules/dsh-mtls/android/src/main/java/com/dsh/remote/mtls/DshMtlsNetwork.kt',
  'modules/dsh-mtls/android/src/main/java/com/dsh/remote/mtls/DshMtlsWebView.kt',
  'modules/dsh-mtls/android/src/main/java/com/dsh/remote/mtls/DshMtlsWebViewClient.kt',
];
for (const file of removedFiles) {
  if (existsSync(resolve(root, file))) bad(`classic 文件仍存在：${file}`);
  else ok(`已删除 ${file}`);
}

console.log('== 括号平衡（粗检） ==');
function stripCode(source) {
  let out = '';
  let inLine = false;
  let inBlock = false;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (inLine) { if (ch === '\n') { inLine = false; out += ch; } continue; }
    if (inBlock) { if (ch === '*' && next === '/') { inBlock = false; i += 1; } continue; }
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '/' && next === '/') { inLine = true; i += 1; continue; }
    if (ch === '/' && next === '*') { inBlock = true; i += 1; continue; }
    if (ch === '"') { inString = true; continue; }
    out += ch;
  }
  return out;
}
function balance(source, open, close) {
  let depth = 0;
  for (const ch of stripCode(source)) {
    if (ch === open) depth += 1;
    if (ch === close) depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}
for (const file of requiredFiles) {
  const source = read(file);
  const balanced = [['{', '}'], ['(', ')'], ['[', ']']].every(([open, close]) => balance(source, open, close));
  if (balanced) ok(`${file} 括号平衡`);
  else bad(`${file} 括号不平衡`);
}

console.log('');
if (failures > 0) {
  console.log(`❌ 原生源码检查失败：${failures} 项（warnings: ${warnings}）`);
  process.exit(1);
}
console.log(`✅ 原生源码一致性检查通过（warnings: ${warnings}）—— 仍需真机编译验证`);
