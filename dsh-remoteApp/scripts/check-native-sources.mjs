#!/usr/bin/env node
/**
 * 原生模块源码一致性检查（无需 Xcode / Android SDK）。
 *
 * 用途：本仓库机器无法编译 iOS/Android 原生代码，但可以静态保证：
 *   1. JS bridge（src/index.ts）的方法与 iOS(Swift)/Android(Kotlin) 的导出方法一致；
 *   2. 两端原生模块名/视图名一致；
 *   3. 关键实现文件存在且包含关键 API（Secure Enclave / AndroidKeyStore / 客户端证书）；
 *   4. 原生文件括号大致平衡（捕获明显的复制/编辑错误）。
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

const ts = read('modules/dsh-mtls/src/index.ts');
const swift = read('modules/dsh-mtls/ios/DSHMTLSModule.swift');
const kotlin = read('modules/dsh-mtls/android/src/main/java/com/dsh/remote/mtls/DshMtlsModule.kt');

console.log('== JS bridge ↔ 原生导出方法 ==');
const interfaceStart = ts.indexOf('interface NativeDshMtlsModule');
const interfaceEnd = ts.indexOf('\n}', interfaceStart);
const interfaceText = ts.slice(interfaceStart, interfaceEnd);
const tsEntries = [...interfaceText.matchAll(/^ {2}(\w+)(\?)?\(/gm)].map((m) => ({ name: m[1], optional: Boolean(m[2]) }));
const nativeFunctionNames = (source) => new Set([...source.matchAll(/(?:Async)?Function\("([^"]+)"/g)].map((m) => m[1]));
const ios = nativeFunctionNames(swift);
const android = nativeFunctionNames(kotlin);

for (const entry of tsEntries) {
  const missing = [];
  if (!ios.has(entry.name)) missing.push('iOS');
  if (!android.has(entry.name)) missing.push('Android');
  if (missing.length === 0) { ok(`${entry.name} (${entry.optional ? 'optional' : 'required'})`); continue; }
  if (entry.optional) warn(`${entry.name} 在 ${missing.join('/')} 缺失（JS 侧 optional，可接受）`);
  else bad(`${entry.name} 在 ${missing.join('/')} 缺失`);
}
for (const name of [...ios, ...android]) {
  if (!tsEntries.some((entry) => entry.name === name)) bad(`原生导出 ${name} 未出现在 TS bridge 接口中`);
}

console.log('== 模块/视图名 ==');
const moduleNames = [
  ['TS', /DSH_MTLS_MODULE_NAME = '([^']+)'/.exec(ts)?.[1]],
  ['iOS', /Name\("([^"]+)"\)/.exec(swift)?.[1]],
  ['Android', /Name\("([^"]+)"\)/.exec(kotlin)?.[1]],
];
const resolvedModuleNames = new Set(moduleNames.map(([, value]) => value).filter(Boolean));
if (resolvedModuleNames.size === 1) ok(`模块名一致：${[...resolvedModuleNames][0]}`);
else bad(`模块名不一致：${moduleNames.map(([label, value]) => `${label}=${value}`).join(', ')}`);
const viewNames = new Set([
  /DSH_MTLS_VIEW_NAME = '([^']+)'/.exec(ts)?.[1],
  /View\((\w+)\.self\)/.exec(swift)?.[1],
  /View\((\w+)::class\.java\)/.exec(kotlin)?.[1],
].filter(Boolean));
if (viewNames.size === 1) ok(`视图名存在：${[...viewNames][0]}`);
else warn(`JS 视图名与原生 View 名称不同（JS=${[...viewNames].join(', ')}；原生类名可不同，需看 expo-module.config）`);

console.log('== 关键实现文件 / API ==');
const requiredFiles = [
  'modules/dsh-mtls/ios/DSHMTLSCsr.swift',
  'modules/dsh-mtls/ios/DSHMTLSNetwork.swift',
  'modules/dsh-mtls/ios/DSHMTLSIdentityStore.swift',
  'modules/dsh-mtls/android/src/main/java/com/dsh/remote/mtls/DshMtlsCsr.kt',
  'modules/dsh-mtls/android/src/main/java/com/dsh/remote/mtls/DshMtlsNetwork.kt',
  'modules/dsh-mtls/android/src/main/java/com/dsh/remote/mtls/DshMtlsIdentityStore.kt',
];
for (const file of requiredFiles) {
  if (existsSync(resolve(root, file))) ok(file);
  else bad(`缺少 ${file}`);
}
const apiChecks = [
  ['iOS Secure Enclave 密钥生成', 'modules/dsh-mtls/ios/DSHMTLSCsr.swift', 'kSecAttrTokenIDSecureEnclave'],
  ['iOS PKCS#10 编码', 'modules/dsh-mtls/ios/DSHMTLSCsr.swift', 'CERTIFICATE REQUEST'],
  ['iOS 客户端证书挑战', 'modules/dsh-mtls/ios/DSHMTLSWebView.swift', 'NSURLAuthenticationMethodClientCertificate'],
  ['iOS URLSession mTLS', 'modules/dsh-mtls/ios/DSHMTLSNetwork.swift', 'URLCredential(identity:'],
  ['Android KeyGenParameterSpec', 'modules/dsh-mtls/android/src/main/java/com/dsh/remote/mtls/DshMtlsCsr.kt', 'KeyGenParameterSpec'],
  ['Android PKCS#10 编码', 'modules/dsh-mtls/android/src/main/java/com/dsh/remote/mtls/DshMtlsCsr.kt', 'CERTIFICATE REQUEST'],
  ['Android 证书安装', 'modules/dsh-mtls/android/src/main/java/com/dsh/remote/mtls/DshMtlsIdentityStore.kt', 'setKeyEntry'],
  ['Android WebView 客户端证书', 'modules/dsh-mtls/android/src/main/java/com/dsh/remote/mtls/DshMtlsWebViewClient.kt', 'onReceivedClientCertRequest'],
  ['Android HttpsURLConnection mTLS', 'modules/dsh-mtls/android/src/main/java/com/dsh/remote/mtls/DshMtlsNetwork.kt', 'X509ExtendedKeyManager'],
];
for (const [label, file, needle] of apiChecks) {
  if (read(file).includes(needle)) ok(label);
  else bad(`${label}（${file} 缺少 ${needle}）`);
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
for (const file of [...requiredFiles, 'modules/dsh-mtls/ios/DSHMTLSModule.swift', 'modules/dsh-mtls/android/src/main/java/com/dsh/remote/mtls/DshMtlsModule.kt']) {
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
