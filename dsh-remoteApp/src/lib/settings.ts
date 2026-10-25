/**
 * App 本地设置（小体量、非敏感开关放在 SecureStore，沿用现有 keychain 存储）。
 *
 * 目前只有「应用内通知」：
 *  - 开启（默认）时，App 在前台收到推送 → 不显示系统横幅，改在 App 内显示通知卡片；
 *  - 关闭时，App 在前台也按 iOS 默认行为显示系统横幅（后台始终是系统通知）。
 */
import * as SecureStore from 'expo-secure-store';

const IN_APP_NOTIFICATIONS_KEY = 'dshremote.inAppNotifications.v1';

/** 默认开启：前台不再弹系统通知，改为应用内通知卡片。 */
export async function isInAppNotificationsEnabled(): Promise<boolean> {
  try {
    const value = await SecureStore.getItemAsync(IN_APP_NOTIFICATIONS_KEY);
    return value !== '0';
  } catch {
    return true;
  }
}

export async function setInAppNotificationsEnabled(enabled: boolean): Promise<void> {
  try {
    await SecureStore.setItemAsync(IN_APP_NOTIFICATIONS_KEY, enabled ? '1' : '0');
  } catch {
    // 存储不可用时保持默认值；调用方负责提示
  }
}
