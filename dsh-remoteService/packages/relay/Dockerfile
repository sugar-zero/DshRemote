# syntax=docker/dockerfile:1
#
# DSH 自托管盲中继镜像。
#
# 构建上下文必须是 dsh-remoteService 根目录（relay 依赖 workspace 包 dsh-remote-protocol）：
#   docker build -f packages/relay/Dockerfile -t dsh-remote-relay:0.2.11-group ../..   # 在 packages/relay 下
#   docker compose -f packages/relay/docker-compose.yml build
#
# 运行（配置/证书/tokens 都在 /data 卷里）：
#   docker run -d --name dsh-relay --restart unless-stopped \
#     -p 80:80 -p 443:443 -p 8443:8443 -v "$PWD/data:/data" dsh-remote-relay:0.2.11-group

# ---- deps: 安装 ws（只复制 workspace 依赖清单，避免把源码/测试带进依赖层） ----
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json ./
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY packages/relay/package.json ./packages/relay/package.json
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- runtime: 只带运行所需文件 ----
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV RELAY_CONFIG=/data/config/relay.json

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY packages/protocol/index.js ./packages/protocol/index.js
COPY packages/relay/package.json ./packages/relay/package.json
COPY packages/relay/index.js ./packages/relay/index.js
COPY packages/relay/lib ./packages/relay/lib
COPY packages/relay/bin ./packages/relay/bin
COPY packages/relay/relay-entrypoint.sh /usr/local/bin/relay-entrypoint.sh

# 非 root 运行；/data 挂载 config/、certs/、tokens.json
RUN addgroup -S relay \
 && adduser -S -G relay -h /data relay \
 && mkdir -p /data \
 && chmod 755 /usr/local/bin/relay-entrypoint.sh \
 && chown -R relay:relay /app /data \
 && chmod -R a+rX /app
USER relay

# 入口脚本根据 RELAY_HOST_ID / RELAY_HOST_TOKEN 自动补齐 /data/tokens.json，
# 然后执行 CMD（默认启动 relay）。
ENTRYPOINT ["/usr/local/bin/relay-entrypoint.sh"]

# 80/443/8443 由 compose/run 映射；容器内非 root 绑定低端口依赖 Docker 的
# net.ipv4.ip_unprivileged_port_start=0（Docker 默认即 0，compose 里也显式声明）。
EXPOSE 80 443 8443

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.RELAY_HTTP_PORT || 80) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "packages/relay/bin/relay.js"]
