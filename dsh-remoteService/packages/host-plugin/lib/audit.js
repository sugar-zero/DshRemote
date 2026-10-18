import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { paths, ensureParent } from './paths.js';

/** 最小审计：只记动作/资源/结果/内容哈希，不记正文。 */
export class AuditLog {
  constructor(file = paths.audit()) {
    this.file = file;
  }

  append(entry) {
    const record = {
      ts: Date.now(),
      deviceId: entry.deviceId ?? null,
      action: String(entry.action ?? 'unknown'),
      resource: entry.resource ?? null,
      result: entry.result ?? 'ok',
      hash: entry.hash ?? null,
    };
    try {
      ensureParent(this.file);
      appendFileSync(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch {
      /* 审计失败不影响主流程 */
    }
    return record;
  }

  tail(limit = 100) {
    if (!existsSync(this.file)) return [];
    try {
      const lines = readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean);
      return lines.slice(-Math.max(1, Math.min(1000, limit))).map((line) => {
        try { return JSON.parse(line); } catch { return { raw: line }; }
      }).reverse();
    } catch {
      return [];
    }
  }
}
