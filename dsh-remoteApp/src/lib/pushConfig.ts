/**
 * pushConfig.ts — 推送通道的**打包配置**（R2：官方推送与 relay 解耦）。
 *
 * 契约见根目录 `docs/group-push-r2-contract.zh.md` §5.1：
 *   - 官方 App（owner 团队签名 + 官方 bundle id）构建时注入
 *     `EXPO_PUBLIC_PUSH_CHANNEL=official` 和 `EXPO_PUBLIC_PUSH_HUB=https://<hub 公开基址>`；
 *   - 自部署（self）构建不注入 → 默认 `self` + 空 hub 地址，继续走 relay 推送。
 *
 * 仓库里**只保留默认值**（不写真实域名 / 密钥 / 凭据）；官方构建命令由 owner 注入。
 * 这里的值在打包时被 Metro/Babel 内联成常量，运行时不可改（防改包冒充官方通道）。
 */

/** 推送通道：official = 官方 App（设备直连官方 hub）；self = 部署方自签 App（经 relay）。 */
export type PushChannel = 'official' | 'self';

/**
 * 构建时标记的推送通道。
 * 只有明确注入 `official` 才是官方通道；其它值（含未注入）一律按 `self`（安全默认）。
 */
export const PUSH_CHANNEL: PushChannel =
  process.env.EXPO_PUBLIC_PUSH_CHANNEL === 'official' ? 'official' : 'self';

/**
 * 官方 hub 的公开 HTTPS 基址（如 `https://push.example.com`）。
 * 去掉尾部斜杠；官方构建未注入时为空串（此时官方通道不可用，不会尝试登记）。
 */
export const PUSH_HUB_ENDPOINT = (process.env.EXPO_PUBLIC_PUSH_HUB ?? '').trim().replace(/\/+$/, '');

/**
 * 官方通道是否具备可用打包配置（channel=official 且 endpoint 是 https 基址）。
 * 不满足时 `push.ts` 记录「官方推送通道未配置」，**不会回退 relay**。
 */
export function isOfficialPushConfigured(): boolean {
  return PUSH_CHANNEL === 'official' && /^https:\/\/[^\s/]+/i.test(PUSH_HUB_ENDPOINT);
}
