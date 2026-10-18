#!/usr/bin/env bash
# Docker relay 端到端验收：
#   构建镜像 → 起容器（dev 控制面/高位端口）→ 真实 host 插件连接 → mTLS 请求经容器 relay 到 host。
#
# 需要 Docker daemon（Linux/macOS；macOS 可用 colima）。
# 若镜像不存在会先构建（上下文 = dsh-remoteService 根目录）。
set -euo pipefail
cd "$(dirname "$0")/../.."
command -v docker >/dev/null || { echo "需要 docker" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker daemon 未运行（macOS 可 colima start）" >&2; exit 1; }
if ! docker image inspect dsh-remote-relay:poc >/dev/null 2>&1; then
  echo "==> 构建 relay 镜像 dsh-remote-relay:poc"
  docker build -f packages/relay/Dockerfile -t dsh-remote-relay:poc .
fi
node poc/docker-e2e/run.mjs
