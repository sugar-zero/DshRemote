/**
 * 推送注册（自托管 APNs，方案 A）。
 *
 * 流程：
 *   1. 请求通知权限；
 *   2. 取原生 APNs device token（`getDevicePushTokenAsync`；真机 + 带 aps-environment
 *      的签名包才有；Expo Go / 模拟器不可用）；
 *   3. 读取本 App 的 aps-environment（development / production）——Expo 读的是
 *      embedded.mobileprovision 里的 entitlement，所以开发签名包自动走 sandbox；
 *   4. 通过原生 mTLS 客户端 `POST /__dsh_remote/push-token` 注册到主机插件；
 *      主机用本机 APNs Auth Key 直接发到 Apple，**不经过 relay / Expo**。
 *
 * 通知权限被拒 / 未链接原生模块 / 非 iOS 时返回失败原因，不打断 App 主流程。
 */
import * as Notifications from 'expo-notifications';
import * as Application from 'expo-application';
import { AppState, Platform } from 'react-native';
import { setClientIdentity } from '../../modules/dsh-mtls/src';
import { registerPushToken } from './pairing';
import type { StoredConnection } from './store';

let handlerConfigured = false;

/**
 * App 在前台时是否使用「应用内通知」（默认 true，由设置页切换）。
 * 关掉后前台恢复 iOS 默认行为：直接显示系统横幅。
 */
let foregroundInAppEnabled = true;

/** 设置页切换时同步给通知 handler（handler 在通知到达时读取最新值）。 */
export function setForegroundInAppEnabled(enabled: boolean): void {
  foregroundInAppEnabled = enabled;
}

/**
 * App 锁（LockScreen 覆盖在 WebView 之上）是否正在前台展示。
 * 锁屏时代码把「前台」视为后台：不抑制系统通知（内容由 iOS 展示），
 * 应用内卡片仍由 App 侧在 locked 时不渲染（避免内容出现在锁屏之上）。
 */
let foregroundLocked = false;

/** App 锁状态变化时同步给通知 handler。 */
export function setForegroundLocked(locked: boolean): void {
  foregroundLocked = locked;
}

/**
 * WebView 当前正在查看的会话（由 host 插件通过桥上报）。
 * handler 用它判断「前台收到的推送是否属于当前会话」——是则连系统横幅也不显示。
 */
let foregroundCurrentSession: { host: string; sessionId: string } | null = null;

export function setForegroundCurrentSession(session: { host: string; sessionId: string } | null): void {
  foregroundCurrentSession = session;
}

function notificationMatchesCurrentSession(data: unknown): boolean {
  if (!foregroundCurrentSession || !data || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
  if (!sessionId || sessionId !== foregroundCurrentSession.sessionId) return false;
  const host = typeof record.host === 'string' ? record.host : '';
  return !host || !foregroundCurrentSession.host || host === foregroundCurrentSession.host;
}

export function isForegroundInAppEnabled(): boolean {
  return foregroundInAppEnabled;
}

/**
 * 前台收到通知时的展示策略：
 * - 前台 + 应用内通知开启 → 不显示系统横幅，由 App 的 InAppNotificationBanner 展示；
 * - 前台 + 应用内通知关闭 → 系统横幅（旧行为）；
 * - App 锁屏（LockScreen 在前台）→ 按后台处理：系统通知照常显示（应用内卡片不渲染）；
 * - 后台 → 系统通知（由 iOS 决定，handler 不参与）。
 */
export function configureNotificationHandler(): void {
  if (handlerConfigured) return;
  handlerConfigured = true;
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      // 锁屏时按“不在前台”处理，否则系统横幅会被抑制、而应用内卡片又因 locked 不渲染，
      // 通知会彻底丢失。锁屏内容泄露由系统通知的锁屏预览设置兜底。
      const inForeground = AppState.currentState === 'active' && !foregroundLocked;
      const data = notification?.request?.content?.data;
      const isCurrentSession = inForeground && notificationMatchesCurrentSession(data);
      const showSystemUI = !isCurrentSession && (!inForeground || !foregroundInAppEnabled);
      return {
        shouldShowAlert: showSystemUI,
        shouldPlaySound: showSystemUI,
        shouldSetBadge: false,
        shouldShowBanner: showSystemUI,
        shouldShowList: showSystemUI,
      };
    },
  });
}

export type PushEnvironment = 'development' | 'production';

export interface PushRegistrationResult {
  ok: boolean;
  token?: string;
  environment?: PushEnvironment;
  reason?: string;
}

/** 读取 App 的 APNs 环境；读不到时返回 undefined，由主机按 production 兜底。 */
async function readApnsEnvironment(): Promise<PushEnvironment | undefined> {
  try {
    const environment = await Application.getIosPushNotificationServiceEnvironmentAsync();
    if (environment === 'development' || environment === 'production') return environment;
  } catch {
    /* 模拟器/非 iOS 时读不到，交给主机兜底 */
  }
  return undefined;
}

/** 为已配对连接注册 APNs 推送 token；失败只返回原因，不抛错。 */
export async function enablePushForConnection(connection: StoredConnection): Promise<PushRegistrationResult> {
  try {
    if (Platform.OS !== 'ios') return { ok: false, reason: '本版本仅支持 iOS APNs 推送（Android FCM 尚未接入）' };

    const existing = await Notifications.getPermissionsAsync();
    let granted = existing.granted;
    if (!granted) {
      const requested = await Notifications.requestPermissionsAsync();
      granted = requested.granted;
    }
    if (!granted) return { ok: false, reason: '通知权限未授予' };

    let token: string;
    try {
      const deviceToken = await Notifications.getDevicePushTokenAsync();
      if (deviceToken.type !== 'ios' || typeof deviceToken.data !== 'string' || deviceToken.data === '') {
        throw new Error('未取得 APNs device token（需真机 + 含 aps-environment 的签名包）');
      }
      token = deviceToken.data;
    } catch (error) {
      throw new Error(`获取 APNs device token 失败：${error instanceof Error ? error.message : String(error)}`);
    }

    const environment = await readApnsEnvironment();
    // 多主机：native requestWithClientCert 用的是全局 configuredLabel，必须先把设备身份
    // 对齐到当前连接，否则可能拿另一台主机的证书注册这条 token（主机侧 403，且不会重试）。
    if (connection.certRef) {
      try {
        await setClientIdentity(connection.certRef);
      } catch (error) {
        return {
          ok: false,
          reason: `切换设备证书身份失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    await registerPushToken({ host: connection.host, token, provider: 'apns', environment });
    return { ok: true, token, environment };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
