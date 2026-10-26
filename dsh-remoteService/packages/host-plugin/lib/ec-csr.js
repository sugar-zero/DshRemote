/**
 * 非 RSA 设备 CSR（iOS Secure Enclave 的 EC P-256 为主）的纯 JS 解析/校验/签发。
 *
 * 背景：node-forge 的 PKCS#10 解析只认 RSA（`publicKeyFromAsn1` 仅注册了 RSA），
 * Secure Enclave / AndroidKeyStore 的设备密钥是 EC，forge 会报
 * `Cannot read public key. OID is not RSA.`。macOS/Linux 上原本用系统 `openssl`
 * 兜底，但 Windows 默认没有 openssl，配对会直接失败（spawnSync openssl ENOENT）。
 *
 * 这里用 `forge.asn1`（成熟的 DER 编解码）+ `node:crypto`（真正的签名校验与
 * RSA 私钥签名）实现同一能力，作为 openssl 缺失时的回退：
 *   - 校验：解析 PKCS#10，取 CertificationRequestInfo 原始 DER 与 SPKI，
 *     用 node:crypto 的 `verify()` 校验自签名（这是设备持有私钥的证明）；
 *   - 签发：构造 X.509 v3 TBSCertificate（issuer 从设备 CA 证书原样取），
 *     用设备 CA 的 RSA 私钥以 sha256WithRSAEncryption 签名，输出 PEM。
 *
 * 安全约束：
 *   - 不跳过 CSR 自签名校验；签发前后都会用 `X509Certificate` 再验一次链与公钥；
 *   - 只接受已知的签名算法 OID（ECDSA/RSA/SHA-2 系列 + Ed25519），不做「解析失败就放行」。
 */
import { X509Certificate, createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import forge from 'node-forge';

const { asn1, pki, util } = forge;

/** PKCS#10 / X.509 用到的 OID。 */
const OID = {
  sha256WithRsaEncryption: '1.2.840.113549.1.1.11',
  commonName: '2.5.4.3',
  organizationName: '2.5.4.10',
  organizationalUnitName: '2.5.4.11',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectKeyIdentifier: '2.5.29.14',
  clientAuth: '1.3.6.1.5.5.7.3.2',
};

/** CSR 自签名算法 OID → node:crypto 摘要（null = Ed25519 的纯签名算法；Ed448 暂不支持）。 */
const CSR_SIGNATURE_HASHES = {
  '1.2.840.10045.4.1': 'sha1', // ecdsa-with-SHA1（兼容老设备；证书本身仍用 SHA-256 签）
  '1.2.840.10045.4.3.2': 'sha256',
  '1.2.840.10045.4.3.3': 'sha384',
  '1.2.840.10045.4.3.4': 'sha512',
  '1.2.840.113549.1.1.5': 'sha1', // sha1WithRSAEncryption
  '1.2.840.113549.1.1.11': 'sha256',
  '1.2.840.113549.1.1.12': 'sha384',
  '1.2.840.113549.1.1.13': 'sha512',
  '1.3.101.112': null, // Ed25519（PKCS#10 自签名即 EdDSA）
};

function derPemLabels(pem, primary, alternative) {
  const labels = [primary, alternative].filter(Boolean);
  for (const label of labels) {
    const match = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`).exec(String(pem));
    if (match) return Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
  }
  throw new Error(`不是合法的 PEM（缺少 BEGIN ${primary}）`);
}

function pemEncode(der, label) {
  const b64 = der.toString('base64').match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

function toDer(node) {
  return Buffer.from(asn1.toDer(node).getBytes(), 'binary');
}

function parseDer(buf) {
  // decodeBitStrings:false —— forge 默认会把「内容恰好是合法 DER 的 BIT STRING」解成 composed 子节点，
  // 而 EC 的 ECDSA 签名（DER 序列）正好会被这样误解析，导致拿不到原始签名字节。
  return asn1.fromDer(util.createBuffer(buf.toString('binary')), {
    strict: true,
    parseAllBytes: true,
    decodeBitStrings: false,
  });
}

function oidNode(oid) {
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(oid).getBytes());
}

function universal(type, constructed, value) {
  return asn1.create(asn1.Class.UNIVERSAL, type, constructed, value);
}

/**
 * 解析 PKCS#10（不校验签名，只切出后续校验/签发需要的原始 DER）。
 * @returns {{ tbsDer: Buffer, signatureAlgorithmOid: string, signature: Buffer,
 *             spkiDer: Buffer, spkiPem: string, spkiNode: object, publicKey: import('node:crypto').KeyObject }}
 */
export function parseUnsupportedCsr(csrPem) {
  const der = derPemLabels(csrPem, 'CERTIFICATE REQUEST', 'NEW CERTIFICATE REQUEST');
  const root = parseDer(der);
  if (root.tagClass !== asn1.Class.UNIVERSAL || root.type !== asn1.Type.SEQUENCE || !root.constructed) {
    throw new Error('CSR 不是 DER 编码的 SEQUENCE');
  }
  const [cri, sigAlg, sigBits] = root.value ?? [];
  if (root.value?.length !== 3) throw new Error('CSR 结构不符合 PKCS#10（顶层元素数量异常）');
  if (cri?.type !== asn1.Type.SEQUENCE || sigAlg?.type !== asn1.Type.SEQUENCE || sigBits?.type !== asn1.Type.BITSTRING) {
    throw new Error('CSR 结构不符合 PKCS#10');
  }
  const algOid = asn1.derToOid(sigAlg.value?.[0]?.value);
  if (!algOid) throw new Error('CSR 缺少签名算法 OID');
  const sigBytes = Buffer.from(sigBits.value ?? '', 'binary');
  if (sigBytes.length < 2) throw new Error('CSR 签名为空');
  if (sigBytes[0] !== 0x00) throw new Error('CSR 签名字节未对齐（unused bits 非 0）');
  const signature = sigBytes.subarray(1);

  // CertificationRequestInfo ::= SEQUENCE { version, subject, subjectPKInfo, attributes }
  const criValues = cri.value ?? [];
  if (criValues.length !== 4) throw new Error('CSR 结构不符合 PKCS#10（CertificationRequestInfo 元素数量异常）');
  const version = criValues[0];
  const versionBytes = version?.type === asn1.Type.INTEGER ? Buffer.from(version.value ?? '', 'binary') : undefined;
  if (!versionBytes || versionBytes.length !== 1 || versionBytes[0] !== 0) {
    throw new Error('不支持的 CSR 版本（PKCS#10 只接受 v1/INTEGER 0）');
  }
  const spkiNode = criValues[2];
  if (spkiNode?.type !== asn1.Type.SEQUENCE) throw new Error('CSR 缺少 subjectPublicKeyInfo');
  const attributes = criValues[3];
  if (attributes?.tagClass !== asn1.Class.CONTEXT_SPECIFIC || attributes.type !== 0 || !attributes.constructed) {
    throw new Error('CSR attributes 字段格式异常');
  }
  const spkiDer = toDer(spkiNode);
  let publicKey;
  try {
    publicKey = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
  } catch (error) {
    throw new Error(`不支持的 CSR 公钥类型: ${error.message}`);
  }
  return {
    tbsDer: toDer(cri),
    signatureAlgorithmOid: algOid,
    signature,
    spkiDer,
    spkiPem: pemEncode(spkiDer, 'PUBLIC KEY'),
    spkiNode,
    publicKey,
  };
}

/** 用 node:crypto 校验 CSR 自签名（openssl 不可用时的回退）。 */
export function verifyCsrSignatureWithNode(parsed) {
  const hash = CSR_SIGNATURE_HASHES[parsed.signatureAlgorithmOid];
  if (hash === undefined) {
    const error = new Error(`不支持的 CSR 签名算法（OID ${parsed.signatureAlgorithmOid}）`);
    // 调用方据此区分「我们的能力不足」与「签名确实不对」：前者可保留 openssl 的结论
    error.code = 'UNSUPPORTED_CSR_ALGORITHM';
    throw error;
  }
  let ok = false;
  try {
    ok = cryptoVerify(hash, parsed.tbsDer, parsed.publicKey, parsed.signature);
  } catch (error) {
    throw new Error(`CSR 签名校验失败: ${error.message}`);
  }
  if (!ok) throw new Error('CSR 签名校验失败');
  return true;
}

/** 从设备 CA 证书里原样取出 issuer（DER 节点），保证 leaf 的 issuer 与 CA 的 subject 完全一致。 */
function caIssuerNode(caCertPem) {
  const root = parseDer(derPemLabels(caCertPem, 'CERTIFICATE'));
  const tbs = root.value?.[0];
  if (tbs?.type !== asn1.Type.SEQUENCE) throw new Error('设备 CA 证书结构异常');
  const hasVersion = tbs.value?.[0]?.tagClass === asn1.Class.CONTEXT_SPECIFIC && tbs.value?.[0]?.type === 0;
  const issuer = tbs.value?.[(hasVersion ? 1 : 0) + 2];
  if (issuer?.type !== asn1.Type.SEQUENCE) throw new Error('无法从设备 CA 证书解析 issuer');
  return issuer;
}

function validityNode(date) {
  const utc = date >= new Date(Date.UTC(1950, 0, 1)) && date < new Date(Date.UTC(2050, 0, 1));
  return utc
    ? universal(asn1.Type.UTCTIME, false, asn1.dateToUtcTime(date))
    : universal(asn1.Type.GENERALIZEDTIME, false, asn1.dateToGeneralizedTime(date));
}

function attributeNode(oid, value) {
  return universal(asn1.Type.SET, true, [
    universal(asn1.Type.SEQUENCE, true, [
      oidNode(oid),
      universal(asn1.Type.UTF8, false, util.encodeUtf8(String(value))),
    ]),
  ]);
}

function nameNode(attributes) {
  return universal(asn1.Type.SEQUENCE, true, attributes.map(([oid, value]) => attributeNode(oid, value)));
}

function subjectKeyIdentifier(parsed) {
  // RFC 5280 方法 (1)：SHA-1(subjectPublicKey BIT STRING 的值，去掉 unused-bits 字节)
  const bits = Buffer.from(parsed.spkiNode.value?.[1]?.value ?? '', 'binary');
  if (bits.length < 2 || bits[0] !== 0x00) throw new Error('CSR 公钥 BIT STRING 结构异常');
  return createHash('sha1').update(bits.subarray(1)).digest();
}

/**
 * 用设备 CA（RSA）以 sha256WithRSAEncryption 给 EC 设备签发 X.509 v3 客户端证书。
 * @param {{ caCertPem: string, caKeyPem: string, csrPem: string, serial: string,
 *           commonName?: string, deviceId: string, days?: number }} options
 * @returns {{ certPem: string, serial: string, notAfter: number, publicKeyPem: string }}
 */
export function buildUnsupportedDeviceCertificate({ caCertPem, caKeyPem, csrPem, serial, commonName, deviceId, days = 30 }) {
  const parsed = parseUnsupportedCsr(csrPem);
  verifyCsrSignatureWithNode(parsed);

  let caKey;
  try {
    caKey = createPrivateKey(caKeyPem);
  } catch (error) {
    throw new Error(`设备 CA 私钥解析失败: ${error.message}`);
  }
  const subject = nameNode([
    [OID.commonName, commonName || deviceId],
    [OID.organizationName, 'DSH Remote Device'],
    [OID.organizationalUnitName, deviceId],
  ]);
  const extensions = [
    // CA:FALSE（客户端证书，不签发下级证书）
    { id: OID.basicConstraints, value: universal(asn1.Type.SEQUENCE, true, []) },
    // digitalSignature, keyEncipherment（与 openssl/forge 签发路径保持一致）
    { id: OID.keyUsage, value: universal(asn1.Type.BITSTRING, false, '\x05\xa0') },
    { id: OID.extKeyUsage, value: universal(asn1.Type.SEQUENCE, true, [oidNode(OID.clientAuth)]) },
    { id: OID.subjectKeyIdentifier, value: universal(asn1.Type.OCTETSTRING, false, subjectKeyIdentifier(parsed).toString('binary')) },
  ];
  const signatureAlgorithm = universal(asn1.Type.SEQUENCE, true, [
    oidNode(OID.sha256WithRsaEncryption),
    universal(asn1.Type.NULL, false, ''),
  ]);
  const notBefore = new Date(Date.now() - 5 * 60 * 1000);
  const notAfter = new Date(Date.now() + Math.max(1, days) * 24 * 3600 * 1000);
  const tbs = universal(asn1.Type.SEQUENCE, true, [
    // version [0] EXPLICIT v3(2)
    asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
      universal(asn1.Type.INTEGER, false, asn1.integerToDer(2).getBytes()),
    ]),
    universal(asn1.Type.INTEGER, false, util.hexToBytes(serial)),
    signatureAlgorithm,
    caIssuerNode(caCertPem),
    universal(asn1.Type.SEQUENCE, true, [validityNode(notBefore), validityNode(notAfter)]),
    subject,
    parsed.spkiNode,
    pki.certificateExtensionsToAsn1(extensions),
  ]);
  const tbsDer = toDer(tbs);
  const signature = cryptoSign('sha256', tbsDer, caKey);
  const certDer = toDer(universal(asn1.Type.SEQUENCE, true, [
    tbs,
    signatureAlgorithm,
    universal(asn1.Type.BITSTRING, false, `\x00${signature.toString('binary')}`),
  ]));
  const certPem = pemEncode(certDer, 'CERTIFICATE');

  // 自检：链、公钥绑定、serial、有效期都必须对得上，否则不返回。
  let leaf;
  try {
    leaf = new X509Certificate(certPem);
    const ca = new X509Certificate(caCertPem);
    if (!leaf.checkIssued(ca) || !leaf.verify(ca.publicKey)) throw new Error('证书链校验失败');
    const leafSpki = Buffer.from(leaf.publicKey.export({ type: 'spki', format: 'der' }));
    if (!leafSpki.equals(parsed.spkiDer)) throw new Error('证书公钥与 CSR 公钥不一致');
    if (String(leaf.serialNumber).toUpperCase() !== String(serial).toUpperCase()) throw new Error('证书 serial 不一致');
    return {
      certPem,
      serial: leaf.serialNumber.toUpperCase(),
      notAfter: Date.parse(leaf.validTo),
      publicKeyPem: parsed.spkiPem,
    };
  } catch (error) {
    throw new Error(`纯 JS 签发的设备证书未通过自检: ${error.message}`);
  }
}
