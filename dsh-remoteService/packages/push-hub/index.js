/**
 * dsh-remote-push-hub —— DSH 群体服务版「官方推送 hub」（选项 2：走项目所有者的服务）。
 *
 * 职责（0.3.0 起只有 R2：官方推送与部署方 relay 解耦）：
 *   - 官方 App 用 P-256 设备密钥向 hub 登记（/v1/enroll/challenge + /v1/enroll），
 *     换取 per-device credential（hub 的 Ed25519 key 签发）；
 *   - 主机拿 credential 直连 hub 的 /v1/push（Bearer JWT）推送固定通用文案；
 *   - hub **不识别 relay**：没有 relay 凭据、没有 relay 转发通道、没有 hub 侧 store。
 *
 * 对外工厂：
 *   - createHubConfig(raw?, options?) → 规范化配置（hub.json + HUB_* 环境变量）
 *   - loadHubConfig({configPath, env, cwd}) → 读配置文件 + 环境覆盖（CLI serve 用）
 *   - createHubServer({config, logger, apnsClient, now?}) → { listen(), close(), address(), health() }
 *   - ChallengeStore / loadOrCreateSigningKey / verifyCredential … → R2 底层件（测试/工具用）
 *
 * 契约：docs/group-push-r2-contract.zh.md §4/§4.5；部署模板：server/docker-compose.push-hub.yml。
 * 零第三方依赖（只依赖 workspace 包 dsh-remote-apns / dsh-remote-protocol）。
 */

export {
  HUB_BODY_LIMIT_BYTES,
  HUB_DEFAULT_CHALLENGE_PER_HOUR_PER_IP,
  HUB_DEFAULT_CONFIG_FILE,
  HUB_DEFAULT_CREDENTIAL_TTL_DAYS,
  HUB_DEFAULT_ENROLL_CHALLENGE_TTL_SECONDS,
  HUB_DEFAULT_ENROLL_ENABLED,
  HUB_DEFAULT_ENROLL_PER_HOUR_PER_DEVICE,
  HUB_DEFAULT_ENROLL_PER_HOUR_PER_IP,
  HUB_DEFAULT_LISTEN_HOST,
  HUB_DEFAULT_LOG_LEVEL,
  HUB_DEFAULT_MAX_TOKENS_PER_REQUEST,
  HUB_DEFAULT_PORT,
  HUB_DEFAULT_PUSH_PER_DAY_PER_TOKEN,
  HUB_DEFAULT_PUSH_PER_MINUTE_GLOBAL,
  HUB_DEFAULT_PUSH_PER_MINUTE_PER_CREDENTIAL,
  HUB_DEFAULT_PUSH_PER_MINUTE_PER_HOST,
  HUB_DEFAULT_PUSH_PER_MINUTE_PER_IP,
  HUB_DEFAULT_PUSH_PER_MINUTE_PER_TOKEN,
  HUB_DEFAULT_SIGNING_KEY_FILE_NAME,
  HUB_LIMIT_DEFAULTS,
  HUB_LOG_LEVELS,
  applyHubEnv,
  createConsoleLogger,
  createHubConfig,
  loadHubConfig,
  normalizeHubApns,
  normalizeHubConfig,
  normalizeHubTls,
  normalizePublicUrl,
  readHubConfigFile,
  readHubTlsMaterial,
  redactSecrets,
} from './lib/config.js';

export { HUB_ERROR, HUB_ERROR_STATUS, errorPayload, statusForError } from './lib/errors.js';

export {
  HUB_LIMIT_WINDOWS,
  RateLimitSet,
  SlidingWindowLimiter,
  retryAfterSeconds,
} from './lib/limits.js';

export {
  HUB_CREDENTIAL_ALG,
  HUB_SIGNING_KEY_DIR_MODE,
  HUB_SIGNING_KEY_FILE_MODE,
  decodeCredential,
  issueDeviceCredential,
  loadOrCreateSigningKey,
  signCredential,
  signingKeyId,
  verifyCredential,
} from './lib/credential.js';

export {
  ChallengeStore,
  HUB_CHALLENGE_ID_BYTES,
  HUB_CHALLENGE_NONCE_BYTES,
  HUB_DEFAULT_CHALLENGE_TTL_MS,
  HUB_DEFAULT_MAX_PENDING_CHALLENGES,
  constantTimeEquals,
  isValidChallengeId,
  isValidEnrollHostId,
  isValidEnrollNonce,
  validateChallengeRequest,
  validateEnrollRequest,
  verifyEnrollSignature,
} from './lib/enroll.js';

export {
  HUB_PUSH_KINDS,
  sendPushNotifications,
  validateDevicePushRequest,
} from './lib/push.js';

export {
  HUB_ENROLL_CHALLENGE_PATH,
  HUB_ENROLL_PATH,
  HUB_HEALTH_PATH,
  HUB_PUSH_PATH,
  createHubServer,
} from './lib/hub-server.js';
