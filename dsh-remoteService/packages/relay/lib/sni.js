/**
 * 最小 TLS ClientHello 解析：只取 SNI，不终止 TLS，不改动任何字节。
 *
 * 盲中继的数据面只做两件事：
 *   1. 从客户端最早的若干字节里读出 ClientHello 的 SNI（按 <hostId>.<relayDomain> 路由）；
 *   2. 把已缓存的字节原样转发给主机侧，然后双向 pipe。
 *
 * 因此这里只解析 record layer + handshake header + extensions，不接触密钥材料。
 * 输入可能因 TCP 分片而不完整，调用方应持续累积字节直到 status 变为 ok/invalid。
 */

/** TLS handshake record content type。 */
export const TLS_CONTENT_HANDSHAKE = 0x16;
/** handshake message type: ClientHello。 */
export const HANDSHAKE_CLIENT_HELLO = 0x01;
/** 为防内存滥用，单个 ClientHello 最多缓存 64 KiB。 */
export const MAX_CLIENT_HELLO_BYTES = 64 * 1024;

/** parseClientHello() 的三种结果。 */
export const SNI_STATUS = Object.freeze({
  /** 字节还不够，继续读。 */
  INCOMPLETE: 'incomplete',
  /** 成功解析出 ClientHello；sni 可能是 null（客户端未发送 SNI）。 */
  OK: 'ok',
  /** 确定不是 TLS ClientHello / 格式错误，调用方应断开。 */
  INVALID: 'invalid',
});

const SNI_EXTENSION = 0x0000;
const SNI_NAME_TYPE_HOST = 0x00;

function incomplete() {
  return { status: SNI_STATUS.INCOMPLETE };
}

function invalid(reason) {
  return { status: SNI_STATUS.INVALID, reason };
}

/**
 * 解析 ClientHello body，返回 SNI 字符串 / null（未发送 SNI）/ undefined（格式错误）。
 * @param {Buffer} body
 * @returns {string | null | undefined}
 */
function parseServerName(body) {
  let offset = 0;

  // legacy_version(2) + random(32)
  if (body.length < 2 + 32) return undefined;
  offset += 2 + 32;

  // legacy_session_id
  if (offset + 1 > body.length) return undefined;
  const sessionIdLen = body[offset];
  offset += 1;
  if (offset + sessionIdLen > body.length) return undefined;
  offset += sessionIdLen;

  // cipher_suites
  if (offset + 2 > body.length) return undefined;
  const cipherSuitesLen = body.readUInt16BE(offset);
  offset += 2;
  if (offset + cipherSuitesLen > body.length) return undefined;
  offset += cipherSuitesLen;

  // legacy_compression_methods
  if (offset + 1 > body.length) return undefined;
  const compressionLen = body[offset];
  offset += 1;
  if (offset + compressionLen > body.length) return undefined;
  offset += compressionLen;

  // 没有 extensions：合法但无 SNI（例如按 IP 连接）
  if (offset === body.length) return null;
  if (offset + 2 > body.length) return undefined;
  const extensionsLen = body.readUInt16BE(offset);
  offset += 2;
  const extensionsEnd = Math.min(offset + extensionsLen, body.length);

  while (offset + 4 <= extensionsEnd) {
    const type = body.readUInt16BE(offset);
    const len = body.readUInt16BE(offset + 2);
    offset += 4;
    if (offset + len > extensionsEnd) return undefined;

    if (type === SNI_EXTENSION) {
      const data = body.subarray(offset, offset + len);
      if (data.length < 2) return undefined;
      const listLen = data.readUInt16BE(0);
      const listEnd = Math.min(2 + listLen, data.length);
      let pos = 2;
      while (pos + 3 <= listEnd) {
        const nameType = data[pos];
        const nameLen = data.readUInt16BE(pos + 1);
        pos += 3;
        if (pos + nameLen > listEnd) return undefined;
        if (nameType === SNI_NAME_TYPE_HOST) {
          const name = data.subarray(pos, pos + nameLen).toString('ascii');
          return name.length > 0 ? name : null;
        }
        pos += nameLen;
      }
      // SNI extension 存在但没有 host_name 条目
      return null;
    }
    offset += len;
  }

  return null;
}

/**
 * 尝试从（可能不完整的）TCP 字节流中解析 ClientHello 的 SNI。
 *
 * @param {Buffer|string|Uint8Array} input 累积的字节
 * @returns {{status:'incomplete'}|{status:'ok', sni: string|null}|{status:'invalid', reason: string}}
 */
export function parseClientHello(input) {
  const buf = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input ?? []);

  if (buf.length === 0) return incomplete();
  if (buf[0] !== TLS_CONTENT_HANDSHAKE) {
    return invalid(`not a TLS handshake record (first byte 0x${buf[0].toString(16).padStart(2, '0')})`);
  }
  if (buf.length < 5) return incomplete();

  // 逐条 TLS record 收集 handshake 字节。ClientHello 通常落在单条 record 里，
  // 但大 ClientHello（如带 PQ key share）可能跨 record；TCP 分片则由调用方累积。
  const chunks = [];
  let handshakeBytes = 0;
  let offset = 0;

  while (true) {
    if (buf.length < offset + 5) return incomplete();
    if (buf[offset] !== TLS_CONTENT_HANDSHAKE) {
      return invalid('TLS record sequence does not start with a handshake record');
    }
    const recordLen = buf.readUInt16BE(offset + 3);
    if (recordLen === 0) return invalid('empty TLS handshake record');
    if (buf.length < offset + 5 + recordLen) return incomplete();

    chunks.push(buf.subarray(offset + 5, offset + 5 + recordLen));
    handshakeBytes += recordLen;
    offset += 5 + recordLen;

    if (handshakeBytes > MAX_CLIENT_HELLO_BYTES) return invalid('ClientHello too large');

    if (handshakeBytes >= 4) {
      const message = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
      const messageType = message[0];
      if (messageType !== HANDSHAKE_CLIENT_HELLO) {
        return invalid(`expected ClientHello, got handshake type ${messageType}`);
      }
      const bodyLen = message.readUIntBE(1, 3);
      if (message.length >= 4 + bodyLen) {
        const sni = parseServerName(message.subarray(4, 4 + bodyLen));
        if (sni === undefined) return invalid('malformed ClientHello');
        return { status: SNI_STATUS.OK, sni };
      }
    }
  }
}

/**
 * 便捷函数：解析成功时返回 SNI（可能为 null），其余情况返回 undefined。
 * @param {Buffer|string|Uint8Array} input
 * @returns {string | null | undefined}
 */
export function extractSni(input) {
  const result = parseClientHello(input);
  return result.status === SNI_STATUS.OK ? result.sni : undefined;
}
