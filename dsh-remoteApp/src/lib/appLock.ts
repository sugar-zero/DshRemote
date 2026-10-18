/**
 * App 锁（生物识别门禁）—— POC。
 *
 * 目标：手机解锁后打开 App / 从后台回来时，要求 Face ID / Touch ID / 指纹，
 * 阻止"拿到已解锁手机的人"直接操作远程 DSH。
 *
 * 说明：
 *  - 只保护 App 入口；逐条审批的二次生物识别在下一里程碑（原生审批页/JS bridge）补。
 *  - 生物识别不可用时，用户可关闭 App 锁（POC 不做设备密码 fallback 的强绑定）。
 */
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

const APP_LOCK_KEY = 'dshremote.appLock.v1';

export async function isAppLockEnabled(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(APP_LOCK_KEY)) === '1';
  } catch {
    return false;
  }
}

export async function setAppLockEnabled(enabled: boolean): Promise<void> {
  try {
    if (enabled) await SecureStore.setItemAsync(APP_LOCK_KEY, '1');
    else await SecureStore.deleteItemAsync(APP_LOCK_KEY);
  } catch {
    // POC：安全存储不可用时保持原状；调用方负责提示。
  }
}

export interface BiometricAvailability {
  available: boolean;
  enrolled: boolean;
  label: string;
}

/** 查询设备生物识别能力（Face ID / Touch ID / 指纹）。 */
export async function getBiometricAvailability(): Promise<BiometricAvailability> {
  try {
    const [available, enrolled, types] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
      LocalAuthentication.supportedAuthenticationTypesAsync(),
    ]);
    let label = '生物识别';
    if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) label = 'Face ID';
    else if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) label = '指纹 / Touch ID';
    return { available, enrolled, label };
  } catch {
    return { available: false, enrolled: false, label: '生物识别' };
  }
}

/** 触发一次生物识别；成功返回 true。 */
export async function authenticateBiometric(reason = '解锁 DSH Remote'): Promise<boolean> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      cancelLabel: '取消',
      disableDeviceFallback: false,
    });
    return result.success;
  } catch {
    return false;
  }
}
