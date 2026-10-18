/**
 * 测试辅助：控制面 WebSocket 客户端（JSON 文本帧队列 + 二进制帧队列）。
 */

import { WebSocket } from 'ws';

export class ControlClient {
  /** @param {WebSocket} ws */
  constructor(ws) {
    this.ws = ws;
    /** @type {Array<{data: Buffer, isBinary: boolean}>} */
    this.queue = [];
    /** @type {Array<{resolve: Function, timer: NodeJS.Timeout}>} */
    this.waiters = [];
    /** @type {{code: number, reason: string} | null} */
    this.closed = null;

    ws.on('message', (data, isBinary) => {
      const item = { data: Buffer.from(data), isBinary };
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(item);
      } else {
        this.queue.push(item);
      }
    });
    ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason?.toString() ?? '' };
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
    });
  }

  /**
   * @param {string} url
   * @param {import('ws').ClientOptions} [options]
   * @returns {Promise<ControlClient>}
   */
  static connect(url, options = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, options);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`timed out connecting to ${url}`));
      }, 5000);
      timer.unref?.();
      ws.once('open', () => {
        clearTimeout(timer);
        resolve(new ControlClient(ws));
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.once('unexpected-response', (req, res) => {
        clearTimeout(timer);
        ws.terminate();
        reject(new Error(`unexpected HTTP response ${res.statusCode} for ${url}`));
      });
    });
  }

  /** @param {Record<string, unknown>} message */
  sendJson(message) {
    this.ws.send(JSON.stringify(message));
  }

  /**
   * @param {number} timeoutMs
   * @returns {Promise<{data: Buffer, isBinary: boolean} | null | undefined>}
   *   item = 消息；null = 连接已关闭；undefined = 超时
   */
  nextRaw(timeoutMs = 3000) {
    const existing = this.queue.shift();
    if (existing) return Promise.resolve(existing);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      /** @type {{resolve: Function, timer: NodeJS.Timeout}} */
      const waiter = { resolve, timer: /** @type {any} */ (null) };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(undefined);
      }, timeoutMs);
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  /**
   * 下一条 JSON 文本消息；连接关闭返回 null；超时抛错。
   * @param {number} [timeoutMs]
   * @returns {Promise<Record<string, any> | null>}
   */
  async nextJson(timeoutMs = 3000) {
    const item = await this.nextRaw(timeoutMs);
    if (item === undefined) throw new Error('timed out waiting for a control JSON message');
    if (item === null) return null;
    if (item.isBinary) throw new Error('expected a JSON text frame, got binary');
    return JSON.parse(item.data.toString('utf8'));
  }

  /** @returns {Promise<{code: number, reason: string}>} */
  waitClose(timeoutMs = 3000) {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for websocket close')), timeoutMs);
      timer.unref?.();
      this.ws.once('close', (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason?.toString() ?? '' });
      });
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
    try {
      this.ws.terminate();
    } catch {
      /* ignore */
    }
  }
}
