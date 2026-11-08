# syntax=docker/dockerfile:1
#
# DSH 群体服务版「官方推送 hub」镜像（选项 2：走项目所有者的服务）。
#
# 职责（0.3.0 = R2-only：官方推送与部署方 relay 解耦）：
#   - 官方 App 用设备密钥登记（/v1/enroll*）换 per-device credential，主机拿 credential
#     直连 /v1/push；hub 用 Ed25519 签名 key 签发/校验 credential（key 自动生成在 /data，0600）；
#   - hub 不识别 relay（没有 relay 凭据/转发通道/hub 侧 store），只发固定通用文案，
#     不接收会话内容、不持久化设备 token。
#
# 构建上下文必须是 dsh-remoteService 根目录（依赖 workspace 包 dsh-remote-apns / dsh-remote-protocol）：
#   docker build -f packages/push-hub/Dockerfile -t dsh-remote-push-hub:0.3.1 ../..   # 在 packages/push-hub 下
#   docker compose -f server/docker-compose.push-hub.yml build                        # 在 server/ 下
#
# 运行（配置用 `HUB_*` 环境变量；签名 key 与日志卷都在 /data）：
#   docker run -d --name dsh-push-hub --restart unless-stopped \
#     -p 127.0.0.1:19445:9445 \
#     -e HUB_LISTEN_HOST=0.0.0.0 \
#     -e HUB_PUBLIC_URL=https://push.example.com \        # R2 的 aud（App 打包内置的 hub 地址）
#     -e HUB_APNS_KEY_FILE=/data/apns/AuthKey_<KEY_ID>.p8 \
#     -e HUB_APNS_KEY_ID=<KEY_ID> -e HUB_APNS_TEAM_ID=<TEAM_ID> \
#     -e HUB_APNS_TOPIC=<OFFICIAL_BUNDLE_ID> \
#     -v dsh-push-hub-data:/data \
#     -v /path/to/apns-keys:/data/apns:ro \
#     dsh-remote-push-hub:0.3.1
#   /data 卷需持久化：首次启动会自动生成 /data/push-hub-signing-key.pem（0600），
#   丢了会导致已签发的 credential 全部失效（客户端重新登记即可，但没必要丢）。
#
# 注意：hub 默认只跑 HTTP，TLS 由前置 nginx 终止（见 server/nginx/push-hub-http.conf）；
#       compose 只把端口发布到宿主 127.0.0.1，绝不能直接对公网暴露明文 HTTP。

# ---- deps: 只装运行依赖（push-hub 零第三方依赖 + workspace 包 dsh-remote-apns / dsh-remote-protocol）----
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json ./
COPY packages/apns/package.json ./packages/apns/package.json
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY packages/push-hub/package.json ./packages/push-hub/package.json
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- runtime: 只带运行所需文件，非 root ----
FROM node:24-alpine
WORKDIR /app
# 容器内默认值：监听 0.0.0.0（供 Docker 端口发布）、固定容器端口 9445、
# 签名 key 落 /data 卷（compose 会显式传同样的值；手动 docker run 也不会落到 /app 丢失）。
ENV NODE_ENV=production \
    HUB_LISTEN_HOST=0.0.0.0 \
    HUB_PORT=9445 \
    HUB_SIGNING_KEY_FILE=/data/push-hub-signing-key.pem

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages/apns/package.json ./packages/apns/package.json
COPY packages/apns/index.js ./packages/apns/index.js
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY packages/protocol/index.js ./packages/protocol/index.js
COPY packages/push-hub/package.json ./packages/push-hub/package.json
COPY packages/push-hub/index.js ./packages/push-hub/index.js
COPY packages/push-hub/lib ./packages/push-hub/lib
COPY packages/push-hub/bin ./packages/push-hub/bin

# /data 挂载 hub.json（可选）、push-hub-signing-key.pem（Ed25519 credential 签名 key，0600，
# 自动生成）与 APNs key（只读 /data/apns）。
RUN addgroup -S pushhub \
 && adduser -S -G pushhub -h /data pushhub \
 && mkdir -p /data \
 && chown -R pushhub:pushhub /app /data \
 && chmod -R a+rX /app
USER pushhub

EXPOSE 9445

# 健康检查：hub 只跑 HTTP，/healthz 不含 token/密钥；端口取 HUB_PORT（compose 里固定 9445）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.HUB_PORT || 9445) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# 默认命令：serve（配置来自 HUB_* 环境变量；也可在 compose 里加 --config /data/config/hub.json）。
CMD ["node", "packages/push-hub/bin/push-hub.js", "serve"]
