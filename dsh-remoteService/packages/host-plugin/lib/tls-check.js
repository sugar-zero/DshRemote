/**
 * 主机 TLS 证书自检：证书与私钥是否成对、证书 SAN 是否覆盖手机访问的主机名。
 *
 * 这两类配置错误在 Node 里只表现为一句很晦涩的 TLS 错误（或者干脆握手失败），
 * 手机端只会看到「无法连接」。这里提前检查并把原因写进 `lastError`
 * （DSH 设置 → 远程访问 → 最近错误），方便定位。
 *
 * 注意：EC 证书不能再用 `openssl x509 -modulus` / `openssl rsa -modulus` 比对
 * （EC 没有 RSA modulus，两条命令都会失败，容易被误判成「证书与密钥不匹配」），
 * 这里统一比较 SubjectPublicKeyInfo 的 SHA-256。
 */
import { X509Certificate, createHash, createPrivateKey, createPublicKey } from 'node:crypto';

const CERT_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/;

/** 证书 SAN 里的 DNS 名称（`cert.subjectAltName` 形如 `DNS:a.com, DNS:*.b.com, IP Address:1.2.3.4`）。 */
function sanDnsNames(cert) {
  const raw = cert.subjectAltName;
  if (!raw) return [];
  return raw
    .split(/,\s*/)
    .map((entry) => entry.trim())
    .filter((entry) => /^DNS:/i.test(entry))
    .map((entry) => entry.slice(4));
}

/** 匹配单层通配符（`*.example.com` 匹配 `foo.example.com`，不匹配 `a.b.example.com`）。 */
function matchDnsNames(names, host) {
  const target = String(host).toLowerCase();
  for (const name of names) {
    const pattern = name.toLowerCase();
    if (pattern === target) return name;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1);
      if (target.endsWith(suffix)) {
        const label = target.slice(0, -suffix.length);
        if (label && !label.includes('.')) return name;
      }
    }
  }
  return null;
}

/**
 * 主机名是否被证书覆盖。
 *
 * 注意：不能只用 `X509Certificate.checkHost()` —— 它按 RFC 1123 校验域名，遇到
 * 项目允许的 `[a-z0-9_-]` hostId（例如 `h_ab12cd34`，含下划线）会直接返回 undefined，
 * 造成「证书 SAN 未覆盖」的误报。所以先走 checkHost，未命中再按 SAN/CN 自行匹配。
 */
function matchCertificateHostname(cert, fqdn) {
  try {
    const matched = cert.checkHost(fqdn);
    if (matched) return matched;
  } catch { /* 继续走自实现匹配 */ }
  const names = sanDnsNames(cert);
  const matched = matchDnsNames(names, fqdn);
  if (matched) return matched;
  if (names.length === 0) {
    // 无 SAN 时按 RFC 6125 旧行为退回 CN
    const commonName = /CN=([^,\n]+)/.exec(cert.subject ?? '')?.[1]?.trim();
    if (commonName && commonName.toLowerCase() === String(fqdn).toLowerCase()) return commonName;
  }
  return null;
}

/** fullchain.pem 里可能有多张证书；X509Certificate 只取第一张（叶子证书）。 */
export function firstCertificatePem(pem) {
  const match = CERT_BLOCK.exec(String(pem ?? ''));
  return match ? `${match[0]}\n` : String(pem ?? '');
}

function spkiSha256(publicKey) {
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
}

function shortHash(hex) {
  return hex ? `${hex.slice(0, 16)}…` : '未知';
}

/**
 * @param {{ certPem: string, keyPem: string, fqdn?: string }} options
 * @returns {{ error?: string, warnings: string[], cert?: X509Certificate,
 *             certFingerprint?: string, keyFingerprint?: string, hostname?: string | null }}
 */
export function checkTlsKeyPair({ certPem, keyPem, fqdn }) {
  const warnings = [];
  let cert;
  try {
    cert = new X509Certificate(firstCertificatePem(certPem));
  } catch (error) {
    return { error: `TLS 证书解析失败：${error.message}`, warnings };
  }
  let key;
  try {
    key = createPrivateKey(keyPem);
  } catch (error) {
    return { error: `TLS 私钥解析失败：${error.message}`, warnings };
  }

  let certFingerprint;
  let keyFingerprint;
  try {
    certFingerprint = spkiSha256(cert.publicKey);
  } catch { /* 部分算法无法导出时退回 checkPrivateKey 的结果 */ }
  try {
    keyFingerprint = spkiSha256(createPublicKey(key));
  } catch { /* 同上 */ }

  let matched;
  try {
    matched = cert.checkPrivateKey(key);
  } catch {
    matched = certFingerprint && keyFingerprint ? certFingerprint === keyFingerprint : undefined;
  }
  if (matched === undefined && certFingerprint && keyFingerprint) matched = certFingerprint === keyFingerprint;
  if (matched === undefined) {
    // 双失败（无法导公钥且 checkPrivateKey 不可用）时不能断言匹配，至少给出告警
    warnings.push('无法确认 TLS 证书与私钥是否成对（当前 Node 无法导出/比对这两把密钥），请手动核对公钥指纹');
  }

  if (matched === false) {
    return {
      error: [
        'TLS 证书与私钥不匹配：',
        `证书公钥 ${shortHash(certFingerprint)}，私钥公钥 ${shortHash(keyFingerprint)}。`,
        '请确认 fullchain.pem 与 privkey.pem 是同一次签发、同一来源的一对；',
        'EC 证书不能用 `openssl rsa -modulus` 比对（那不是不匹配，是命令本身不适用）。',
      ].join(''),
      warnings,
      cert,
      certFingerprint,
      keyFingerprint,
    };
  }

  let hostname = null;
  if (fqdn) {
    // 说明：hostFqdn 来自 hostId.relayDomain，正常是域名；若未来支持 IP 直连需另加 IP SAN 匹配
    hostname = matchCertificateHostname(cert, fqdn);
    if (!hostname) {
      warnings.push(`TLS 证书 SAN 未覆盖主机名 ${fqdn}（当前证书 subject: ${cert.subject}），手机访问该域名会握手失败`);
    }
  }

  return { warnings, cert, certFingerprint, keyFingerprint, hostname };
}
