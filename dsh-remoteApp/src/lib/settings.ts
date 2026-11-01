/**
 * settings.ts — App 级偏好设置（非敏感、可随时改回）。
 *
 * 目前只有一项：`bottomEdgeGestureDeferral`（默认开启）。
 *
 * - 开启：进入主机页面时 defer iOS 底部（Home 指示条）的「上滑回主屏」系统手势。
 *   DSH 页面里的可拖动悬浮挂件贴到屏幕最底边后，仍能从底边起手拖动，不会被系统手势
 *   把 App 切到后台；代价是主机页面里从最底边上滑回主屏要连划两次（第一次只高亮
 *   Home 指示条）。
 * - 关闭：恢复系统默认（一次上滑即回主屏）；但挂件贴到屏幕最底边时，从底边起手拖动
 *   仍可能被系统手势抢走（这是 iOS 系统行为，App 无法只关闭一半）。
 *
 * 与 appLock.ts 一样用 SecureStore 持久化（不涉及账户/凭据；安全存储不可用时保持默认开）。
 */
import * as SecureStore from 'expo-secure-store';

const BOTTOM_EDGE_DEFERRAL_KEY = 'dshremote.bottomEdgeGestureDeferral.v1';

/** 默认开启：对应「挂件贴底可拖」的修复；用户可在 App 设置里关闭，换回一次上滑回主屏。 */
export async function isBottomEdgeGestureDeferralEnabled(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(BOTTOM_EDGE_DEFERRAL_KEY)) !== '0';
  } catch {
    return true;
  }
}

/** 持久化偏好；默认值（开启）不写 key，关闭时写 '0'。 */
export async function setBottomEdgeGestureDeferralEnabled(enabled: boolean): Promise<void> {
  try {
    if (enabled) await SecureStore.deleteItemAsync(BOTTOM_EDGE_DEFERRAL_KEY);
    else await SecureStore.setItemAsync(BOTTOM_EDGE_DEFERRAL_KEY, '0');
  } catch {
    // 安全存储不可用时保持默认（开启）；开关值只在本次运行内生效。
  }
}
