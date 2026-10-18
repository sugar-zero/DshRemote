# 部署模板

| 文件 | 用途 |
|---|---|
| `launchd/com.dsh.web.plist` | macOS 上常驻一个 `dsh --profile web` 实例（远程主机形态推荐） |
| `../packages/relay/Dockerfile` + `docker-compose.yml` | VPS 上的自托管盲中继 |
| `../scripts/issue-host-cert.sh` | 主机侧 DNS-01 证书签发（acme.sh） |

完整步骤见 [`../docs/DEPLOY.md`](../docs/DEPLOY.md)。

Docker 镜像已用真实容器验证：`npm run poc:docker`（构建镜像 → dev 容器 → 真实 host 插件连接 → mTLS 请求）。
本机 macOS 可用 `colima start` 提供 Docker daemon；生产 VPS 直接 `docker compose up -d --build`。

部署完成后运行自检：

```bash
./scripts/check-deploy.sh relay.example.com h_ab12cd34
# 检查 DNS（含泛解析）、relay /healthz 里的 hostId、8443 端口、relay 证书、主机子域证书
```

本地/staging 演练（不检查 DNS，覆盖端口）：

```bash
CHECK_DEPLOY_SKIP_DNS=1 RELAY_HTTP_PORT=18080 RELAY_DATA_PORT=18443 \
  ./scripts/check-deploy.sh 127.0.0.1 h_local 18444
```

部署前先跑产物静态校验：`npm run validate:artifacts`（shell/compose/plist/JSON/Node 入口）。

快速检查（部署后）：

```bash
# relay 是否在线、是否看到你的 hostId
curl -s http://<VPS_IP>/healthz

# 主机子域 DNS 是否指向 relay（泛解析）
dig +short h_ab12cd34.relay.example.com

# 主机插件状态（本机）
curl -s -b /tmp/dsh.cookies http://127.0.0.1:3080/api/remote-access/status | head -c 500
```
