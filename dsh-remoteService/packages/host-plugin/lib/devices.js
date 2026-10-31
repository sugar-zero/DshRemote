import { paths, readJson, writeJson } from './paths.js';

/**
 * 群体版已配对设备注册表（devices.json，0600）。
 *
 * 设备身份 = 配对时登记的 P-256 未压缩点公钥（base64url）。没有 mTLS 证书，
 * 因此没有证书 serial / notAfter 等 classic 字段；访问鉴权用服务端签发的短时 token。
 */
export class DeviceStore {
  constructor(file = paths.devices()) {
    this.file = file;
    this.state = readJson(file, { version: 1, devices: [] });
    if (!Array.isArray(this.state.devices)) this.state.devices = [];
    /** 设备表变化回调（群体模式下用于把设备公钥同步给 relay）。 */
    this.onChange = undefined;
  }

  save() {
    writeJson(this.file, this.state);
    try {
      this.onChange?.();
    } catch {
      /* 同步失败不影响本机配对/撤销 */
    }
  }

  list() {
    return this.state.devices.map((d) => ({ ...d }));
  }

  get(id) {
    return this.state.devices.find((d) => d.id === id);
  }

  findByPublicKey(groupPublicKey) {
    const wanted = String(groupPublicKey ?? '');
    if (wanted === '') return undefined;
    return this.state.devices.find((d) => d.groupPublicKey === wanted);
  }

  /**
   * 登记一台已配对设备。
   *
   * 同一把 P-256 公钥重复配对（例如撤销后重新扫码，App 复用同一设备密钥）时，
   * 复用原记录并重新激活，避免出现两条指向同一密钥的设备记录。
   *
   * @param {{id: string, name?: string, platform?: string, groupPublicKey: string, publicKeyFingerprint?: string}} device
   * @returns {object} 设备记录
   */
  add(device) {
    const groupPublicKey = typeof device?.groupPublicKey === 'string' ? device.groupPublicKey : '';
    if (!device?.id || groupPublicKey === '') throw new Error('device 需要 id 与 groupPublicKey');
    const existing = this.findByPublicKey(groupPublicKey);
    if (existing) {
      existing.name = device.name || existing.name;
      existing.platform = device.platform || existing.platform;
      existing.revokedAt = null;
      existing.lastSeenAt = null;
      this.save();
      return { ...existing };
    }
    const record = {
      id: device.id,
      name: device.name || device.id,
      platform: device.platform || 'unknown',
      // 群体版设备：P-256 未压缩点公钥（base64url），用于同步给 relay / 本机逐请求鉴权
      groupPublicKey,
      publicKeyFingerprint: device.publicKeyFingerprint || '',
      createdAt: Date.now(),
      lastSeenAt: null,
      revokedAt: null,
    };
    this.state.devices.push(record);
    this.save();
    return record;
  }

  /** 群体版：按设备 ID 更新 lastSeenAt（没有 mTLS 证书可 touch）。 */
  touchById(id) {
    const device = this.get(id);
    if (!device) return undefined;
    device.lastSeenAt = Date.now();
    this.save();
    return device;
  }

  revoke(id) {
    const device = this.get(id);
    if (!device) return undefined;
    if (!device.revokedAt) {
      device.revokedAt = Date.now();
      this.save();
    }
    return { ...device };
  }

  /**
   * 删除一条设备记录（仅用于清理已撤销设备；调用方需先校验 revokedAt）。
   * @param {string} id
   * @returns {object | undefined} 被删除的记录
   */
  remove(id) {
    const index = this.state.devices.findIndex((d) => d.id === id);
    if (index < 0) return undefined;
    const [removed] = this.state.devices.splice(index, 1);
    this.save();
    return removed ? { ...removed } : undefined;
  }
}
