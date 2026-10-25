/**
 * ws-keepalive — 反向代理隧道里的 WebSocket 心跳「中间盒」小工具。
 *
 * 背景（手机 App 真机问题根因）：
 *   DSH Web 的 `/api/remote.mux` 使用 WebSocket Ping 心跳（默认 2s 一次，
 *   连续 2 个周期没收到 Pong/任何帧就 terminate）。打开一个大会话时，
 *   `session/follow` 的首帧是一个数 MB 的历史快照（单个 WS text message）。
 *   经 relay（盲转发 + 约 5Mbps 上行）下载时，这帧要 6s+ 才能到达手机；
 *   DSH 发往手机的 Ping 被排在这帧后面，手机的 Pong 自然也就来迟了，
 *   于是 DSH 在 ~6s 时误判客户端失联并 terminate，客户端重连、重试，
 *   表现为「载入历史很久/失败 + 画面反复跳」。
 *
 * 本模块做两件事：
 *   1. `createWsFrameScanner`：对 DSH→客户端 方向的明文 WebSocket 字节流做
 *      增量扫描，只关心控制帧（Ping/Pong/Close），数据帧的 payload 直接跳过
 *      （不复制、不缓存，几十 MB 也没问题）。
 *   2. `buildMaskedPongFrame`：构造客户端→服务端方向的 Pong 帧（RFC 6455
 *      要求客户端帧必须 masked）。
 *
 * 代理观察到 Ping 时立刻替「隧道链路」回一个 Pong 给 DSH，把心跳与慢速
 * 下行解耦。真正的客户端失联仍由 TCP socket 关闭检测（代理会 destroy
 * upstream），心跳只负责半开连接，因此中间盒代答是可接受且必要的折衷。
 */

/** RFC 6455 控制帧 opcode。 */
export const WS_OPCODE_CLOSE = 0x8;
export const WS_OPCODE_PING = 0x9;
export const WS_OPCODE_PONG = 0xa;

/**
 * 增量 WebSocket 帧扫描器。
 *
 * 只解析帧头，数据帧 payload 用 `subarray` 直接跳过；控制帧（≤125B）才复制
 * payload 交给回调。可以处理任意 chunk 切分、分片消息（控制帧允许夹在分片
 * 之间）、64 位长度、以及理论上服务端很少见的 masked 帧。
 *
 * @param {(frame: { opcode: number, payload: Buffer }) => void} onControlFrame
 *        只在收到控制帧（opcode >= 0x8）时回调，payload 已解除 mask。
 * @returns {(chunk: Buffer) => void} 把收到的字节喂给它即可。
 */
export function createWsFrameScanner(onControlFrame) {
  if (typeof onControlFrame !== 'function') throw new TypeError('createWsFrameScanner 需要回调函数');

  /** @type {Buffer} 未消费的字节（最多只是一个帧头/控制帧 payload）。 */
  let buffer = Buffer.alloc(0);
  /** @type {number} 当前数据帧还要跳过的 payload 字节数。 */
  let skipRemaining = 0;
  /** @type {{opcode:number, masked:boolean, len:number, headerSize:number, maskKey:Buffer|null}|null} */
  let frame = null;

  function parseHeader() {
    if (frame !== null) return;
    if (buffer.length < 2) return;
    const fin = (buffer[0] & 0x80) !== 0;
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let len = buffer[1] & 0x7f;
    let headerSize = 2;
    if (len === 126) {
      if (buffer.length < 4) return;
      len = buffer.readUInt16BE(2);
      headerSize = 4;
    } else if (len === 127) {
      if (buffer.length < 10) return;
      const big = buffer.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('WebSocket 帧长度超过 JS 安全整数范围，停止心跳扫描');
      }
      len = Number(big);
      headerSize = 10;
    }
    const isControl = opcode >= 0x8;
    if (isControl && (!fin || len > 125)) {
      throw new Error('WebSocket 控制帧不合法（fin=false 或 payload>125B），停止心跳扫描');
    }
    if (masked) {
      if (buffer.length < headerSize + 4) return;
      headerSize += 4;
    }
    frame = {
      opcode,
      masked,
      len,
      headerSize,
      maskKey: masked ? Buffer.from(buffer.subarray(headerSize - 4, headerSize)) : null,
    };
  }

  /** @param {Buffer} payload @param {Buffer} maskKey */
  function unmask(payload, maskKey) {
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i & 3];
  }

  return function scan(chunk) {
    if (chunk === undefined || chunk === null) return;
    if (buffer.length === 0) {
      buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    } else {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    }

    for (;;) {
      if (skipRemaining > 0) {
        const consumed = Math.min(skipRemaining, buffer.length);
        buffer = buffer.subarray(consumed);
        skipRemaining -= consumed;
        if (skipRemaining > 0) return;
        continue;
      }

      parseHeader();
      if (frame === null) return; // 帧头还不完整，等下一个 chunk

      const isControl = frame.opcode >= 0x8;
      const total = frame.headerSize + frame.len;

      if (isControl) {
        if (buffer.length < total) return; // 控制帧很小，攒齐再处理
        const payload = Buffer.from(buffer.subarray(frame.headerSize, total));
        if (frame.masked) unmask(payload, frame.maskKey);
        const current = frame;
        frame = null;
        buffer = buffer.subarray(total);
        onControlFrame({ opcode: current.opcode, payload });
        continue;
      }

      // 数据帧：只处理帧头，payload 跳过（支持分片：每个分片各自有帧头）。
      buffer = buffer.subarray(frame.headerSize);
      skipRemaining = frame.len;
      frame = null;
      if (skipRemaining === 0) continue;
    }
  };
}

/**
 * 构造客户端→服务端方向的 Pong 帧（masked）。
 * @param {Buffer} [payload] 要回显的 Ping payload（RFC 6455：Pong 应回显）。
 * @returns {Buffer}
 */
export function buildMaskedPongFrame(payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length > 125) throw new RangeError('Pong payload 不能超过 125 字节');
  const mask = Buffer.from([
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
  ]);
  const header = Buffer.alloc(2 + 4);
  header[0] = 0x80 | WS_OPCODE_PONG;
  header[1] = 0x80 | body.length;
  mask.copy(header, 2);
  const masked = Buffer.alloc(body.length);
  for (let i = 0; i < body.length; i += 1) masked[i] = body[i] ^ mask[i & 3];
  return Buffer.concat([header, masked]);
}
