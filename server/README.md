# relay 部署（群体服务版）

> 本分支是群体服务版（A 模式）：relay 终止手机 TLS，主机只做出站隧道。
> 部署方可见会话明文，**请只邀请你信任的人使用**。

## 1. 准备

- 一台有公网 IP 的 Linux 服务器；
- 一个 relay 域名及其通配子域，例如 `relay.example.com` + `*.relay.example.com`；
- 指向服务器的 DNS；
- Docker / docker compose。

## 2. 配置

```bash
cd server
cp .env.group.example .env.group
```

按 `.env.group` 注释填写：relay 域名、证书路径、管理 token、邀请码策略、端口等。
不做 push 时不需要 Apple 相关配置。

## 3. 启动

```bash
docker compose --env-file .env.group -f docker-compose.group.yml up -d --build
```

nginx 需对 relay 域名做 **L4 (stream) 透传**，或按 `server/README` 的端口方案反代；
证书/私钥只挂载到容器，不要写进仓库。

## 4. 注册主机

在 DSH 主机插件里填写 relay 的注册 API 地址 + 一次性邀请码，完成注册后主机自动建立隧道。
之后在主机「远程访问」中生成配对二维码，App 扫码即可。

## 5. 可选：self 推送

如需要“任务完成/等待回答”提醒，在 relay 配置中填入部署方自己的 APNs Auth Key、
Key ID、Team ID 和 App bundle id；relay 只会向已经登记 token 的自签 App 推送。
没有配置推送不影响远程访问本身。

## 6. 安全

- DSH Web 始终只监听 `127.0.0.1`；
- relay 不得记录明文、不得把 token/凭据写入日志；
- 设备身份来自配对设备密钥 + relay 短时 token，不看来源 IP/Header；
- 邀请码、管理 token、APNs 私钥保持 0600，只留在服务器。
