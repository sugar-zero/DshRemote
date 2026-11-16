# dsh-remoteService

群体服务版服务端与主机插件（Node.js，无第三方运行时依赖为主）。

## 包

| 包 | 作用 |
|---|---|
| `packages/protocol` | 协议常量、QR v2、帧、签名/凭证校验 |
| `packages/relay` | relay：TLS 终止、群体鉴权、隧道、可选 self 推送 |
| `packages/host-plugin` | DSH 主机插件：注册、隧道、loopback 代理、设备/审计 |
| `packages/apns` | APNs HTTP/2 发送器（relay self 推送使用） |

## 开发

```bash
cd dsh-remoteService
npm install
npm test
npm run validate:artifacts
```

测试使用 Node 内置 test runner；不需要真实 Apple 凭据。

## 主机插件

在 DSH 中启用后，于「设置 → 远程访问」完成注册/配对；主机配置与设备表保存在
`$DSH_HOME/remote-access/`，不要提交运行数据。

## 部署

relay 部署见 [`../server/README.md`](../server/README.md)；App 构建见
[`../dsh-remoteApp/README.md`](../dsh-remoteApp/README.md)。

## License

AGPL-3.0-or-later
