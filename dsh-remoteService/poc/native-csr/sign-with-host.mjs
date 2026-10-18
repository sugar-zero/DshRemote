// 用 host 插件真实的设备 CA 签发 Swift 生成的 EC(P-256) CSR，并落盘验证材料。
import { readFileSync, writeFileSync } from 'node:fs';
import { loadOrCreateDeviceCa, parseDeviceCsr, signDeviceCertificate } from '../../packages/host-plugin/lib/identity.js';

const csrPem = readFileSync('generated.csr', 'utf8');
const ca = loadOrCreateDeviceCa();
const parsed = parseDeviceCsr(csrPem);
if (parsed.keyType !== 'ec') throw new Error(`期望 EC CSR，实际 ${parsed.keyType}`);
const signed = signDeviceCertificate({ ca, csrPem, deviceId: 'd_swift_poc', commonName: 'dsh-poc-device', days: 7 });
writeFileSync('ca.pem', ca.certPem);
writeFileSync('device.pem', signed.certPem);
console.log(`SIGNED serial=${signed.serial} keyType=${signed.keyType}`);
