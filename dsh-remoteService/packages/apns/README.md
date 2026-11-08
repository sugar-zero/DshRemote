# dsh-remote-apns

群体服务版推送共用的 **APNs HTTP/2 发送器**（零第三方依赖，只用 `node:http2` + `node:crypto`）。

使用方：

- `packages/relay` 的 **`self` 模式**：部署方把自己的 APNs Auth Key 配在 relay 上，直连 Apple；
- `packages/push-hub`（官方推送 hub）：官方团队 key 发送通用文案。

主机插件和 App 都不直接持有 Apple 凭据，也不直接连接 Apple。

## 导出

```js
import {
  APNS_HOSTS,                 // { development: 'https://api.sandbox.push.apple.com', production: '...' }
  GENERIC_PUSH_CONTENT,       // { 'turn-end': {title,body}, 'waiting-answer': {title,body} }
  genericPushContent,         // kind → 通用文案
  loadPrivateKeyFile,         // .p8 → KeyObject（校验 EC P-256）
  createProviderToken,        // ES256 JWT（raw r||s，缓存 50 分钟由 client 负责）
  buildPushMessage,           // aps.alert + 顶层 body:{kind, sessionId?, host?}
  createApnsClient,           // { isConfigured(), sendToTokens(entries, message), error, environment }
  http2Request,               // 单请求（测试可注入）
} from 'dsh-remote-apns';
```

`sendToTokens(entries, message)`：

- `entries`：`[{ deviceId?, token, environment?: 'development'|'production' }]`；
- `message`：`{ kind, title, body, sessionId?, host? }`（内容由调用方按模式决定）；
- 返回 `{ delivered, failed, pruned, configErrors, errors, skipped? }`：
  - `pruned` 只在 APNs 返回 **410 / `Unregistered`** 时出现（`{deviceId?, token}`），供上层删 token；
  - `configErrors`（`BadDeviceToken` / `DeviceTokenNotForTopic` / `InvalidProviderToken`）是配置问题，
    **不能**当失效 token 清理。

## 安全

- `.p8` 只从文件读取（部署方服务器本地，0600），JWT 只缓存在内存，不落盘、不写日志；
- 设备 token 不持久化、不打印；payload 只有标题/正文 + `{kind, sessionId?, host?}`；
- `sessionId` 只允许 self 模式使用；official 模式由调用方保证不传会话信息。

契约细节见 [`docs/group-push-design.zh.md`](../../../docs/group-push-design.zh.md)。
