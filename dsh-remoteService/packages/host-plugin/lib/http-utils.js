export function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

export function sendError(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } });
}

export function sendOk(res, data = {}) {
  sendJson(res, 200, { ok: true, data });
}

/** 读取并解析 JSON body（默认上限 256 KiB；配对 CSR 很小）。 */
export async function readJsonBody(req, maxBytes = 256 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error('请求体过大');
      error.code = 'body-too-large';
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('请求体不是合法 JSON');
    error.code = 'invalid-json';
    error.status = 400;
    throw error;
  }
}

export function pathnameOf(rawUrl) {
  try {
    return new URL(rawUrl ?? '/', 'https://localhost').pathname;
  } catch {
    return null;
  }
}
