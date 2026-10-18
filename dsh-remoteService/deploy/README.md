# 部署模板

| 文件 | 用途 |
|---|---|
| `launchd/com.dsh.web.plist` | macOS 上常驻一个 `dsh --profile web` 实例（远程主机形态推荐） |
| `../packages/relay/Dockerfile` + `docker-compose.yml` | VPS 上的自托管盲中继 |
| `../scripts/issue-host-cert.sh` | 主机侧 DNS-01 证书签发（acme.sh） |

完整步骤见 [`../docs/DEPLOY.md`](../docs/DEPLOY.md)。

快速检查（部署后）：

```bash
# relay 是否在线、是否看到你的 hostId
curl -s http://<VPS_IP>/healthz

# 主机子域 DNS 是否指向 relay（泛解析）
dig +short h_ab12cd34.relay.example.com

# 主机插件状态（本机）
curl -s -b /tmp/dsh.cookies http://127.0.0.1:3080/api/remote-access/status | head -c 500
```
