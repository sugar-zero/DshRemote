/**
 * push.ts — 群体版 iOS APNs 推送（v1；Android FCM 未接入）。
 *
 * 通道（R2，见根目录 `docs/group-push-r2-contract.zh.md` §5）：
 *   - `self`（部署方自签 App，默认）：登记到主机 → 主机走 relay 自己的 APNs 通道；
 *   - `official`（官方 App）：先用群体版设备密钥向官方 hub 换 per-device credential
 *     （`src/lib/pushHub.ts`），再把 credential 交给主机，由主机**直连官方 hub**推送
 *     ——不依赖部署方 relay 的推送配置；拿不到凭证时不登记、**不回退 relay**。
 *
 * 流程：
 *   1. 权限：查询/请求通知权限（被拒只提示，不打断主流程）；
 *   2. APNs device token：`expo-notifications.getDevicePushTokenAsync()`（真机 + 含
 *      `aps-environment` 的签名包才有；模拟器/Expo Go 不可用），必须是 64 位十六进制；
 *   3. environment：`expo-application.getIosPushNotificationServiceEnvironmentAsync()`
 *      （读不到按 production 兜底）；
 *   4. official：`getOfficialPushCredential()` 取/换官方设备凭证；
 *   5. 登记：经原生 `groupHttpFetch`（`groupAuthorizedFetch`，带 `__Host-dsh_session`
 *      cookie / Bearer）`POST https://<host>:<port>/__dsh_remote/push-token`：
 *        self     → `{provider:'apns', token, environment}`（旧 body，向后兼容）
 *        official → 追加 `{channel:'official', bundleId, hubEndpoint, credential}`
 *   6. 设置页开关：SecureStore 本地偏好 `pushEnabled`（默认开）。
 *
 * 安全约束（硬性）：
 *   - APNs device token / 官方 credential **不落盘（除 credential 的 SecureStore 缓存）、
 *     不打印**：token 只作为请求体交给原生请求层；
 *   - 会话 token 不经本模块暴露（由 `group.ts` 内存缓存 + 原生请求使用）；
 *   - 失败原因只包含可读文案，不含 token / credential / cookie / UDID。
 *
 * 状态映射：
 *   - `registered`  已登记（`mode`/`channel` 区分 self=自部署 / official=官方 hub）；
 *   - `denied`      通知权限被拒；
 *   - `unavailable` 本机/服务端暂时不具备推送条件（Android、无 APNs token、服务器未开启推送）；
 *   - `error`       网络/协议/会话/官方登记等失败（可重试）；
 *   - `off`         用户在设置页关闭了「推送提醒」（本地偏好）。
 */

import * as Application from 'expo-application';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import {
  GroupPairingError,
  groupAuthorizedFetch,
  type GroupAuthorizedResponse,
} from './group';
import { PUSH_CHANNEL, PUSH_HUB_ENDPOINT, isOfficialPushConfigured, type PushChannel } from './pushConfig';
import { getOfficialPushCredential } from './pushHub';
import {
  groupPushTokenUrl,
  groupStatusUrl,
  type GroupPushChannelStatusData,
  type GroupPushMode,
  type GroupPushServerMode,
  type GroupPushServerStatusData,
  type GroupPushTokenData,
} from './protocol';
import type { StoredConnection } from './store';

/** SecureStore key：推送开关（默认开；关闭时写 '0'，删除即恢复默认）。 */
const PUSH_ENABLED_STORAGE_KEY = 'dshremote.pushEnabled.v1';

/** 同一台主机自动重试登记的最小间隔（进入主机 / 回前台 / 定时续期都会触发）。 */
const AUTO_RETRY_INTERVAL_MS = 60_000;

/** APNs device token：64 位小写十六进制（服务端按此校验）。 */
const APNS_TOKEN_RE = /^[0-9a-f]{64}$/;

const STATUS_REQUEST_TIMEOUT_MS = 8_000;
const PUSH_TOKEN_REQUEST_TIMEOUT_MS = 15_000;

export type PushEnvironment = 'development' | 'production';

export type PushState = 'registered' | 'denied' | 'unavailable' | 'error' | 'off';

/** 推送当前状态（设置页展示用；不包含 APNs token / 官方 credential）。 */
export interface PushStatus {
  state: PushState;
  /** 登记成功时主机返回的通道模式：自部署 / 官方推送 hub。 */
  mode?: GroupPushMode;
  /** 本机构建标记的推送通道（official = 官方 App 设备直连 hub；self = 经 relay）。 */
  channel: PushChannel;
  /** 可读原因（失败/未开启/未注册时）。 */
  error?: string;
  /** 最近一次 APNs environment（仅诊断展示，不含 token）。 */
  environment?: PushEnvironment;
  /** 最近一次状态更新时间（epoch ms）。 */
  updatedAt?: number;
}

export interface PushRegisterResult extends PushStatus {
  ok: boolean;
}

export interface RegisterPushOptions {
  /** 忽略节流立即登记（进入主机 / 设置页「重新注册」）。 */
  force?: boolean;
  /** 未授权时弹出系统权限请求（进入主机 / 用户主动重新注册时）。 */
  requestPermission?: boolean;
}

interface PushErrorEnvelope {
  code?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// 前台通知展示
// ---------------------------------------------------------------------------

let notificationHandlerConfigured = false;

/**
 * 前台也显示系统通知（v1 不做应用内卡片，见设计文档 §7）。
 * 重复调用是幂等的；iOS 后台/锁屏的展示由系统负责，不经过这个 handler。
 */
export function configureNotificationHandler(): void {
  if (notificationHandlerConfigured) return;
  notificationHandlerConfigured = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

// ---------------------------------------------------------------------------
// 本地偏好（SecureStore）
// ---------------------------------------------------------------------------

/** 推送开关，默认**开启**；安全存储不可用时按默认值处理。 */
export async function isPushEnabled(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(PUSH_ENABLED_STORAGE_KEY)) !== '0';
  } catch {
    return true;
  }
}

/** 持久化推送开关：默认值（开）删除 key，关闭写 '0'。 */
export async function setPushEnabled(enabled: boolean): Promise<void> {
  try {
    if (enabled) await SecureStore.deleteItemAsync(PUSH_ENABLED_STORAGE_KEY);
    else await SecureStore.setItemAsync(PUSH_ENABLED_STORAGE_KEY, '0');
  } catch {
    // 安全存储不可用时保持默认（开）；开关只在本次运行内影响登记行为。
  }
  cachedStatus = enabled
    ? { state: 'unavailable', channel: PUSH_CHANNEL, error: '已开启，进入主机后自动登记推送 token', updatedAt: Date.now() }
    : { state: 'off', channel: PUSH_CHANNEL, updatedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// 状态缓存（module-level；不落盘、不含 token）
// ---------------------------------------------------------------------------

let cachedStatus: PushStatus | null = null;
/** 每条连接最近一次登记尝试时间（自动触发时做 60s 节流；force 忽略）。 */
const lastAttemptAtByKey = new Map<string, number>();
let hasGrantedPermission = false;

const inflightByKey = new Map<string, Promise<PushRegisterResult>>();

function connectionKey(connection: StoredConnection): string {
  return `${connection.host}|${connection.port}|${connection.deviceId}`;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readPushErrorEnvelope(body: unknown): PushErrorEnvelope {
  if (!isRecord(body) || !isRecord(body.error)) return {};
  return {
    code: typeof body.error.code === 'string' ? body.error.code : undefined,
    message: typeof body.error.message === 'string' ? body.error.message : undefined,
  };
}

/** `{ok:true,data}` envelope → data（非 envelope 时返回原值）。 */
function unwrapPushData(body: unknown): unknown {
  if (isRecord(body) && body.ok === true && 'data' in body) return body.data;
  return body;
}

/**
 * 登记成功响应里的通道：host-plugin 0.2.6 返回 `channel`，旧版返回 `mode`；
 * 都没有（或旧 relay 只回 `registered:true`）时用构建标记兜底。
 */
function readRegisteredMode(data: GroupPushTokenData | null): GroupPushMode | undefined {
  if (data) {
    if (data.channel === 'self' || data.channel === 'official') return data.channel;
    if (data.mode === 'self' || data.mode === 'official') return data.mode;
  }
  return PUSH_CHANNEL;
}

function rememberStatus(status: Omit<PushStatus, 'channel'>): PushRegisterResult {
  cachedStatus = { ...status, channel: PUSH_CHANNEL, updatedAt: Date.now() };
  return { ok: status.state === 'registered', ...cachedStatus };
}

/**
 * 读取当前推送状态（不发起网络、不弹权限）：
 * 优先返回最近一次登记结果，没有时按「开关 / 平台 / 权限」给出可读状态。
 */
export async function getPushStatus(): Promise<PushStatus> {
  if (!(await isPushEnabled())) return { state: 'off', channel: PUSH_CHANNEL, updatedAt: Date.now() };
  if (Platform.OS !== 'ios') {
    return { state: 'unavailable', channel: PUSH_CHANNEL, error: 'Android FCM 未接入', updatedAt: Date.now() };
  }
  try {
    const permissions = await Notifications.getPermissionsAsync();
    hasGrantedPermission = permissions.granted;
    if (!permissions.granted) {
      return {
        state: 'denied',
        channel: PUSH_CHANNEL,
        error: '通知权限未授予：可在 iOS「设置 → 通知 → DSH Remote」中开启',
        updatedAt: Date.now(),
      };
    }
  } catch {
    // 权限查询失败不阻断展示缓存状态。
  }
  return cachedStatus ?? {
    state: 'unavailable',
    channel: PUSH_CHANNEL,
    error: '尚未登记：进入主机后会自动登记推送 token',
    updatedAt: Date.now(),
  };
}

/** APNs 环境：读不到（模拟器/未签名包）按 production 兜底。 */
async function readApnsEnvironment(): Promise<PushEnvironment> {
  if (Platform.OS !== 'ios') return 'production';
  try {
    const environment = await Application.getIosPushNotificationServiceEnvironmentAsync();
    return environment === 'development' ? 'development' : 'production';
  } catch {
    return 'production';
  }
}

async function readApnsDeviceToken(): Promise<string> {
  const deviceToken = await Notifications.getDevicePushTokenAsync();
  if (deviceToken.type !== 'ios' || typeof deviceToken.data !== 'string') {
    throw new Error('未取得 APNs device token（需真机 + 含 aps-environment 的签名包）');
  }
  const token = deviceToken.data.trim().toLowerCase();
  if (!APNS_TOKEN_RE.test(token)) {
    throw new Error('APNs device token 格式异常（应为 64 位十六进制），已忽略本次登记');
  }
  return token;
}

/**
 * 为一条已配对连接登记 APNs device token（失败只返回可读原因，**不抛错**）。
 *
 * 网络请求走 `groupAuthorizedFetch`：内部确保群体版会话 token 有效（缓存复用/必要时
 * 重新 challenge），并在 401/403 时强制续期重试一次；APNs token 只出现在请求体里，
 * 不落盘、不打印。
 */
export async function registerPushForConnection(
  connection: StoredConnection,
  options: RegisterPushOptions = {},
): Promise<PushRegisterResult> {
  const key = connectionKey(connection);
  const inflight = inflightByKey.get(key);
  if (inflight) return inflight;

  const force = options.force === true;
  if (!force && Date.now() - (lastAttemptAtByKey.get(key) ?? 0) < AUTO_RETRY_INTERVAL_MS) {
    const cached: PushStatus = cachedStatus ?? { state: 'unavailable', channel: PUSH_CHANNEL };
    return { ok: cached.state === 'registered', ...cached };
  }
  lastAttemptAtByKey.set(key, Date.now());

  const promise = doRegisterPush(connection, options).finally(() => {
    inflightByKey.delete(key);
  });
  inflightByKey.set(key, promise);
  return promise;
}

async function doRegisterPush(
  connection: StoredConnection,
  options: RegisterPushOptions,
): Promise<PushRegisterResult> {
  try {
    if (!(await isPushEnabled())) return rememberStatus({ state: 'off' });
    if (Platform.OS !== 'ios') {
      return rememberStatus({ state: 'unavailable', error: 'Android FCM 未接入' });
    }

    // 1) 通知权限（进入主机时请求一次；被拒只提示，不打断进入主机）。
    let permissions = await Notifications.getPermissionsAsync().catch(() => null);
    if (permissions?.granted) {
      hasGrantedPermission = true;
    } else if (options.requestPermission) {
      permissions = await Notifications.requestPermissionsAsync().catch(() => null);
      hasGrantedPermission = permissions?.granted === true;
    }
    if (!permissions?.granted) {
      return rememberStatus({
        state: 'denied',
        error: '通知权限未授予：可在 iOS「设置 → 通知 → DSH Remote」中开启后重新注册',
      });
    }

    // 2) APNs device token（64 hex；不落盘、不打印）。
    let token: string;
    try {
      token = await readApnsDeviceToken();
    } catch (error) {
      return rememberStatus({
        state: 'unavailable',
        error: `获取 APNs device token 失败：${errorText(error)}`,
      });
    }

    // 3) APNs environment（development / production；读不到按 production）。
    const environment = await readApnsEnvironment();

    // 4) R2 官方通道：先向官方 hub 换 per-device credential（拿不到就**不登记、不回退 relay**）。
    let officialTokenFields: {
      channel: 'official';
      bundleId: string;
      hubEndpoint: string;
      credential: string;
    } | null = null;
    if (PUSH_CHANNEL === 'official') {
      if (!isOfficialPushConfigured()) {
        return rememberStatus({
          state: 'unavailable',
          error: '官方推送通道未配置（构建未内置 hub 地址），不会回退 relay',
        });
      }
      const bundleId = Application.applicationId ?? '';
      const enrolled = await getOfficialPushCredential({
        endpoint: PUSH_HUB_ENDPOINT,
        connection,
        token,
        environment,
        bundleId,
      });
      if (!enrolled.ok || !enrolled.credentials) {
        return rememberStatus({
          state: 'error',
          error: `官方推送暂不可用：${enrolled.error ?? '设备登记失败'}`,
        });
      }
      officialTokenFields = {
        channel: 'official',
        bundleId,
        hubEndpoint: PUSH_HUB_ENDPOINT,
        credential: enrolled.credentials.credential,
      };
    }

    // 5) 登记到主机（原生请求带会话 cookie；token / credential 只在请求体里）。
    //    self 保持旧 body（向后兼容）；official 追加通道/凭证字段（主机直连 hub）。
    let response: GroupAuthorizedResponse;
    try {
      response = await groupAuthorizedFetch({
        host: connection.host,
        port: connection.port,
        hostId: connection.hostId,
        deviceId: connection.deviceId,
        label: connection.deviceKeyLabel,
        method: 'POST',
        url: groupPushTokenUrl(connection.host, connection.port),
        body: officialTokenFields
          ? {
              provider: 'apns',
              token,
              environment,
              ...officialTokenFields,
            }
          : { provider: 'apns', token, environment },
        timeoutMs: PUSH_TOKEN_REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      return rememberStatus({
        state: 'error',
        error: error instanceof GroupPairingError
          ? error.message
          : `登记推送 token 失败：${errorText(error)}`,
      });
    }

    if (response.status >= 200 && response.status < 300) {
      const data = unwrapPushData(response.body) as GroupPushTokenData | null;
      const mode = readRegisteredMode(data);
      return rememberStatus({
        state: 'registered',
        ...(mode ? { mode } : {}),
        environment,
      });
    }

    const envelope = readPushErrorEnvelope(response.body);
    const detail = envelope.message ? `：${envelope.message}` : '';
    switch (response.status) {
      case 400: {
        // host-plugin 0.2.6 新增 R2 字段校验错误（invalid-channel/invalid-body 等）；
        // 旧版则多为 provider/environment/token 格式不符。
        const reason = envelope.message
          ?? (envelope.code ? `主机校验失败（${envelope.code}）` : 'provider/environment/token 格式不匹配');
        return rememberStatus({
          state: 'error',
          error: `推送登记请求被主机拒绝：${reason}`,
        });
      }
      case 401:
        return rememberStatus({
          state: 'error',
          error: `会话已失效，无法登记推送${detail}。请重新进入主机后再试`,
        });
      case 403:
        if (envelope.code === 'push-disabled') {
          return rememberStatus({
            state: 'unavailable',
            error: '服务器未开启推送（relay group.push.enabled=false）',
          });
        }
        return rememberStatus({
          state: 'error',
          error: `服务器拒绝了本次推送登记${detail || '（HTTP 403）'}`,
        });
      case 502:
        return rememberStatus({
          state: 'error',
          error: `服务器拒绝了推送登记${detail || '（push-rejected）'}`,
        });
      case 503:
        return rememberStatus({
          state: 'error',
          error: `主机到服务器的推送通道暂不可用${detail || '（push-not-connected），稍后自动重试'}`,
        });
      default:
        return rememberStatus({
          state: 'error',
          error: `登记推送 token 失败（HTTP ${response.status}）${detail}`,
        });
    }
  } catch (error) {
    return rememberStatus({ state: 'error', error: errorText(error) });
  }
}

/**
 * 读取主机 `/__dsh_remote/status` 的 `push` 字段（服务端状态；旧版 Host 可能没有）。
 * 失败/旧版主机返回 null，由设置页显示「未知」，不影响本地开关与重新注册。
 */
export async function readServerPushStatus(
  connection: StoredConnection,
): Promise<GroupPushServerStatusData | null> {
  try {
    const response = await groupAuthorizedFetch({
      host: connection.host,
      port: connection.port,
      hostId: connection.hostId,
      deviceId: connection.deviceId,
      label: connection.deviceKeyLabel,
      method: 'GET',
      url: groupStatusUrl(connection.host, connection.port),
      timeoutMs: STATUS_REQUEST_TIMEOUT_MS,
    });
    if (response.status !== 200) return null;
    const data = unwrapPushData(response.body);
    if (!isRecord(data) || !isRecord(data.push)) return null;
    const push = data.push;
    const readMode = (raw: unknown): GroupPushServerMode | undefined =>
      raw === 'self' || raw === 'official' || raw === 'mixed' || raw === '' ? raw : undefined;
    const readChannel = (raw: unknown): GroupPushChannelStatusData | undefined => {
      if (!isRecord(raw)) return undefined;
      const devices = typeof raw.devices === 'number' ? raw.devices : undefined;
      const lastError = typeof raw.lastError === 'string'
        ? raw.lastError
        : raw.lastError === null
          ? null
          : undefined;
      const hub = typeof raw.hub === 'string' ? raw.hub : undefined;
      if (devices === undefined && lastError === undefined && hub === undefined) return undefined;
      return {
        ...(devices !== undefined ? { devices } : {}),
        ...(lastError !== undefined ? { lastError } : {}),
        ...(hub !== undefined ? { hub } : {}),
      };
    };
    const mode = readMode(push.mode);
    const selfStatus = readChannel(push.self);
    const officialStatus = readChannel(push.official);
    const lastError = typeof push.lastError === 'string' ? push.lastError : push.lastError === null ? null : undefined;
    return {
      ...(typeof push.enabled === 'boolean' ? { enabled: push.enabled } : {}),
      ...(typeof push.provider === 'string' ? { provider: push.provider } : {}),
      ...(typeof push.serverEnabled === 'boolean' ? { serverEnabled: push.serverEnabled } : {}),
      ...(mode !== undefined ? { mode } : {}),
      ...(typeof push.tokens === 'number' ? { tokens: push.tokens } : {}),
      ...(lastError !== undefined ? { lastError } : {}),
      ...(selfStatus !== undefined ? { self: selfStatus } : {}),
      ...(officialStatus !== undefined ? { official: officialStatus } : {}),
    };
  } catch {
    return null;
  }
}

/** 当前是否已确认拿到过通知权限（App 内部判断用，不影响登记流程）。 */
export function hasPushPermission(): boolean {
  return hasGrantedPermission;
}

/** APNs 环境读取（供诊断/状态展示；不含 token）。 */
export async function getPushEnvironment(): Promise<PushEnvironment> {
  return readApnsEnvironment();
}
