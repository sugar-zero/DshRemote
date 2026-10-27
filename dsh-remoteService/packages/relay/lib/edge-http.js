/**
 * 群体版边缘的极简 HTTP/1.x 工具（仅 relay 使用）。
 *
 * 只做两件事：
 *   1. 从已解密的 TLS socket 上读出「请求头（到 \r\n\r\n）」与剩余的字节（原样转发给主机）；
 *   2. 给设备鉴权接口写最小 HTTP 响应。
 *
 * 不实现 chunked 请求体、HTTP/2、压缩、keep-alive 语义——普通业务流量在读完
 * 第一个请求头后由隧道原样透传给主机（host 侧才是真正的 HTTP 代理）。
 */

/** 请求头上限（普通业务请求的 header 远小于此值）。 */
export const EDGE_HTTP_HEAD_LIMIT_BYTES = 16 * 1024;
/** 鉴权接口请求体上限（JSON，很小）。 */
export const EDGE_HTTP_BODY_LIMIT_BYTES = 8 * 1024;

const HEAD_END = Buffer.from('\r\n\r\n');
const STATUS_TEXT = Object.freeze({
  200: 'OK',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  421: 'Misdirected Request',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
});

/**
 * 解析 HTTP/1.x 请求头。
 * @param {Buffer} headBuffer 必须包含结尾的 \r\n\r\n
 * @returns {{method: string, path: string, version: string, headers: Record<string, string>}}
 */
export function parseHttpHead(headBuffer) {
  const text = headBuffer.toString('latin1');
  const lines = text.split('\r\n');
  const match = /^([A-Z]+) (\S+) HTTP\/(1\.[01])$/.exec(lines[0] ?? '');
  if (!match) throw new Error('invalid HTTP request line');
  /** @type {Record<string, string>} */
  const headers = {};
  for (const line of lines.slice(1)) {
    if (line === '') continue;
    const idx = line.indexOf(':');
    if (idx <= 0) throw new Error('invalid HTTP header line');
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (name === '') continue;
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  return { method: match[1], path: match[2], version: match[3], headers };
}

/**
 * 从 socket 读一个 HTTP 请求头；返回头字节 + 已读到的剩余字节（可能是请求体或隧道业务数据）。
 * 成功返回前 socket 保持 paused，由调用方决定继续转发或回复后关闭。
 * @param {import('node:tls').TLSSocket} socket
 * @param {{maxBytes?: number, timeoutMs?: number}} [options]
 * @returns {Promise<{head: Buffer, rest: Buffer}>}
 */
export function readHttpHead(socket, options = {}) {
  const maxBytes = options.maxBytes ?? EDGE_HTTP_HEAD_LIMIT_BYTES;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return new Promise((resolve, reject) => {
    socket.pause();
    let buffer = Buffer.alloc(0);
    let settled = false;
    /** @type {NodeJS.Timeout} */
    let timer;
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      clearTimeout(timer);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(HEAD_END);
      if (end >= 0) {
        socket.pause();
        finish(resolve, { head: buffer.subarray(0, end + HEAD_END.length), rest: buffer.subarray(end + HEAD_END.length) });
        return;
      }
      if (buffer.length > maxBytes) {
        socket.pause();
        finish(reject, new Error('HTTP head too large'));
      }
    };
    const onError = (err) => finish(reject, err);
    const onClose = () => finish(reject, new Error('socket closed before HTTP head'));
    timer = setTimeout(() => finish(reject, new Error('timed out reading HTTP head')), timeoutMs);
    timer.unref?.();
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.resume();
  });
}

/**
 * 读鉴权接口的 JSON 请求体（content-length 必须存在且在限制内）。
 * @param {import('node:tls').TLSSocket} socket
 * @param {Record<string, string>} headers 已解析的请求头
 * @param {Buffer} [rest] readHttpHead 返回的剩余字节
 * @param {{maxBytes?: number, timeoutMs?: number}} [options]
 * @returns {Promise<any>}
 */
export function readHttpJsonBody(socket, headers, rest = Buffer.alloc(0), options = {}) {
  const maxBytes = options.maxBytes ?? EDGE_HTTP_BODY_LIMIT_BYTES;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const rawLength = headers['content-length'];
  const contentLength = rawLength === undefined ? 0 : Number(rawLength);
  if (!Number.isInteger(contentLength) || contentLength < 0) {
    return Promise.reject(Object.assign(new Error('invalid content-length'), { statusCode: 400 }));
  }
  if (contentLength > maxBytes) {
    return Promise.reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
  }

  const parse = (buffer) => {
    if (buffer.length === 0) return {};
    try {
      return JSON.parse(buffer.toString('utf8'));
    } catch {
      throw Object.assign(new Error('request body must be valid JSON'), { statusCode: 400 });
    }
  };

  if (rest.length >= contentLength) {
    socket.pause();
    try {
      return Promise.resolve(parse(rest.subarray(0, contentLength)));
    } catch (err) {
      return Promise.reject(err);
    }
  }
  return new Promise((resolve, reject) => {
    socket.pause();
    let buffer = rest;
    let settled = false;
    /** @type {NodeJS.Timeout} */
    let timer;
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      clearTimeout(timer);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onData = (chunk) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      if (buffer.length < contentLength) return;
      socket.pause();
      try {
        finish(resolve, parse(buffer.subarray(0, contentLength)));
      } catch (err) {
        finish(reject, err);
      }
    };
    const onError = (err) => finish(reject, err);
    const onClose = () => finish(reject, new Error('socket closed before request body'));
    timer = setTimeout(() => finish(reject, new Error('timed out reading request body')), timeoutMs);
    timer.unref?.();
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.resume();
  });
}

/**
 * 写一个最小 HTTP 响应并关闭连接（鉴权接口/错误路径用）。
 * @param {import('node:tls').TLSSocket} socket
 * @param {{status?: number, headers?: Record<string,string>, body?: string | Buffer}} response
 */
export function writeHttpResponse(socket, response = {}) {
  if (socket.destroyed) return;
  const status = response.status ?? 200;
  const body = Buffer.isBuffer(response.body) ? response.body : Buffer.from(String(response.body ?? ''), 'utf8');
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': String(body.length),
    connection: 'close',
    ...(response.headers ?? {}),
  };
  let head = `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Unknown'}\r\n`;
  for (const [name, value] of Object.entries(headers)) head += `${name}: ${value}\r\n`;
  head += '\r\n';
  try {
    socket.write(head);
    socket.end(body);
  } catch {
    socket.destroy();
  }
}
