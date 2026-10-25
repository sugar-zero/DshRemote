/**
 * 系统设备名 / 配对默认设备名。
 *
 * 配对时主机设备列表显示的名字默认取系统设备名，而不是写死的「我的 iPhone」：
 *  - Android：`Settings.Global.DEVICE_NAME`（老系统回退蓝牙名），即用户设置的设备名；
 *  - iOS：`UIDevice.current.name`。iOS 16 起未获得「User-Assigned Device Name」
 *    权限（Apple 需单独审批）的 App 只会拿到通用名（"iPhone"/"iPad"），这时退回
 *    机型名（如 "iPhone 17 Pro Max"），至少能区分机型；
 *  - Web 预览 / 原生模块缺失时退回旧文案，保证页面对 UI 预览仍可用。
 *
 * 该名字只用于 `/__dsh_remote/pair` 请求里的 `deviceName`（并作为 CSR 的 CN），
 * 不是身份凭据；设备身份始终只来自 mTLS 客户端证书。
 */

import { Platform } from 'react-native';
import * as Device from 'expo-device';

/** iOS 16+ 无权限时 `UIDevice.current.name` 返回的通用名。 */
const GENERIC_IOS_DEVICE_NAMES = new Set([
  'iPhone',
  'iPad',
  'iPod touch',
  'Apple Vision Pro',
  'Apple TV',
  'Apple Watch',
  'HomePod',
]);

/** 旧版本写死并可能已经存进 SecureStore 的默认名（升级后不再沿用）。 */
const LEGACY_DEFAULT_NAMES = new Set(['我的 iPhone', '我的 Android 设备']);

const FALLBACK_DEVICE_NAME = Platform.OS === 'android' ? '我的 Android 设备' : '我的 iPhone';
const MAX_DEVICE_NAME_LENGTH = 64;

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 读取系统设备名（取不到时返回空串）。 */
export function systemDeviceName(): string {
  let deviceName = '';
  let modelName = '';
  try {
    deviceName = clean(Device.deviceName);
    modelName = clean(Device.modelName);
  } catch {
    // 未链接原生模块（例如旧安装包 / 极少数预览环境）时不影响配对页渲染。
    return '';
  }
  if (Platform.OS !== 'ios') return deviceName || modelName;
  if (!deviceName) return modelName;
  // iOS 16+ 通用名不区分设备，用机型名代替；有真实设备名时带上机型方便主机识别。
  if (GENERIC_IOS_DEVICE_NAMES.has(deviceName) || deviceName === modelName) {
    return modelName || deviceName;
  }
  if (modelName && !deviceName.includes(modelName)) return `${deviceName} (${modelName})`;
  return deviceName;
}

/** 配对页输入框的默认值：系统设备名，取不到时退回旧文案。 */
export function defaultDeviceName(): string {
  const system = systemDeviceName();
  const name = system || FALLBACK_DEVICE_NAME;
  return name.length > MAX_DEVICE_NAME_LENGTH ? name.slice(0, MAX_DEVICE_NAME_LENGTH) : name;
}

/** 旧版本保存的写死默认名 —— 不应再作为「用户自定义名」恢复。 */
export function isLegacyDefaultDeviceName(name: string): boolean {
  return LEGACY_DEFAULT_NAMES.has(name.trim());
}
