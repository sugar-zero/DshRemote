import { paths, readJson, writeJson } from './paths.js';

/** 已配对设备注册表（devices.json，0600）。 */
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

  findBySerial(serial) {
    const wanted = String(serial ?? '').toUpperCase();
    return this.state.devices.find((d) => d.serial.toUpperCase() === wanted);
  }

  add(device) {
    if (!device?.id || !device?.serial) throw new Error('device 需要 id 与 serial');
    if (this.findBySerial(device.serial)) throw new Error('serial 已存在');
    const record = {
      id: device.id,
      name: device.name || device.id,
      platform: device.platform || 'unknown',
      serial: String(device.serial).toUpperCase(),
      publicKeyFingerprint: device.publicKeyFingerprint || '',
      // 群体版设备：P-256 未压缩点公钥（base64url），用于同步给 relay / 本机逐请求鉴权
      ...(typeof device.groupPublicKey === 'string' && device.groupPublicKey !== ''
        ? { groupPublicKey: device.groupPublicKey }
        : {}),
      createdAt: Date.now(),
      notAfter: device.notAfter ?? null,
      lastSeenAt: null,
      revokedAt: null,
    };
    this.state.devices.push(record);
    this.save();
    return record;
  }

  touch(serial) {
    const device = this.findBySerial(serial);
    if (!device) return undefined;
    device.lastSeenAt = Date.now();
    this.save(); // POC 简单直接写盘；MVP 可节流
    return device;
  }

  /** 群体版：按设备 ID 更新 lastSeenAt（无 mTLS 证书可 touch）。 */
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

  isActive(serial) {
    const device = this.findBySerial(serial);
    return Boolean(device) && !device.revokedAt && (device.notAfter === null || device.notAfter > Date.now());
  }
}
