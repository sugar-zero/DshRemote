import forge from 'node-forge';
import { writeFileSync } from 'node:fs';

function serial() { return `01${forge.util.bytesToHex(forge.random.getBytesSync(15))}`; }
function caCert() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey; cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: 'DSH WKWebView POC CA' }];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { keys, cert };
}
function issue(ca, cn, eku, sans) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey; cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  cert.setSubject([{ name: 'commonName', value: cn }]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', [eku]: true },
    ...(sans ? [{ name: 'subjectAltName', altNames: sans }] : []),
  ]);
  cert.sign(ca.keys.privateKey, forge.md.sha256.create());
  return { keys, cert };
}
const ca = caCert();
const server = issue(ca, '127.0.0.1', 'serverAuth', [{ type: 7, ip: '127.0.0.1' }, { type: 2, value: 'localhost' }]);
const client = issue(ca, 'dsh-poc-device', 'clientAuth');
import { mkdirSync } from 'node:fs';
mkdirSync('.build', { recursive: true });
const OUT = (name) => `.build/${name}`;
writeFileSync(OUT('ca.pem'), forge.pki.certificateToPem(ca.cert));
writeFileSync(OUT('server-cert.pem'), forge.pki.certificateToPem(server.cert));
writeFileSync(OUT('server-key.pem'), forge.pki.privateKeyToPem(server.keys.privateKey));
writeFileSync(OUT('client-cert.pem'), forge.pki.certificateToPem(client.cert));
writeFileSync(OUT('client-key.pem'), forge.pki.privateKeyToPem(client.keys.privateKey));
const p12 = forge.pkcs12.toPkcs12Asn1(client.keys.privateKey, [client.cert], 'poc-pass', { algorithm: '3des' });
writeFileSync(OUT('client.p12'), Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'));
console.log('certs generated');
