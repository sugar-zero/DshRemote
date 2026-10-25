import { paths, readJson, writeJson } from './paths.js';

/** 已配对设备注册表（devices.json，0600）。 */
export class DeviceStore {
  constructor(file = paths.devices()) {
    this.file = file;
    this.state = readJson(file, { version: 1, devices: [] });
    if (!Array.isArray(this.state.devices)) this.state.devices = [];
  }

  save() {
    writeJson(this.file, this.state);
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
