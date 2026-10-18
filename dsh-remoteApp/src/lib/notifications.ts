/**
 * Push notification setup (POC, code-only).
 *
 * 流程：
 *   1. 请求通知权限；
 *   2. 取 Expo Push Token（需要 EAS projectId：EXPO_PUBLIC_EAS_PROJECT_ID）；
 *   3. 通过原生 mTLS 客户端 `POST /__dsh_remote/push-token` 注册到主机插件；
 *      主机插件再转给 relay（relay 发内容无关提醒）。
 *
 * 未链接原生模块 / 未配置 projectId 时返回失败原因，不打断 App 主流程。
 */
import * as Notifications from 'expo-notifications';
import { registerPushToken } from './pairing';
import type { StoredConnection } from './store';

let handlerConfigured = false;

/** 前台收到通知时的展示策略（POC：显示通用提醒；不展示任何内容载荷）。 */
export function configureNotificationHandler(): void {
  if (handlerConfigured) return;
  handlerConfigured = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

export interface PushRegistrationResult {
  ok: boolean;
  token?: string;
  reason?: string;
}

/** 为已配对连接注册推送 token；失败只返回原因，不抛错。 */
export async function enablePushForConnection(connection: StoredConnection): Promise<PushRegistrationResult> {
  try {
    const existing = await Notifications.getPermissionsAsync();
    let granted = existing.granted;
    if (!granted) {
      const requested = await Notifications.requestPermissionsAsync();
      granted = requested.granted;
    }
    if (!granted) return { ok: false, reason: '通知权限未授予' };

    const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
    const tokenResult = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined).catch((error: unknown) => {
      throw new Error(`获取 Expo Push Token 失败：${error instanceof Error ? error.message : String(error)}`);
    });
    const token = tokenResult.data;
    await registerPushToken({ host: connection.host, token, provider: 'expo' });
    return { ok: true, token };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
