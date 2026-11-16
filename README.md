# DSH Remote

DSH Remote 是 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）的远程访问客户端组合：

- `dsh-remoteApp/`：iOS App（扫码配对、远程会话、审批、可选推送）
- `dsh-remoteService/packages/host-plugin/`：DSH 主机插件（出站隧道 + loopback 代理）
- `dsh-remoteService/packages/relay/`：服务端（TLS 终止、群体鉴权、可选 self 推送）
- `server/`：relay 部署示例（Docker Compose / nginx）

## 功能

- 扫码配对：在 DSH「设置 → 远程访问」生成二维码，App 扫码连接
- 远程会话：查看/继续会话、流式输出、审批
- 多主机管理与设备撤销
- 可选推送：部署方使用自己的 APNs Auth Key，经 relay 发送给自己的 App
- App 锁、缓存清理、外链内嵌浏览器

## 官方 TestFlight 版（测试中）

官方 TestFlight 版仍在测试中，可直接通过公开链接安装：

**https://testflight.apple.com/join/XRUhMjNM**

- 安装后 App 可独立使用（连接你自己的群体版 relay服务器。仅适用于群体版不适用于单机版）。
- 如何使用？：在主机设置里开启「推送提醒」即可
- App 会自动向官方推送服务器登记，不需要再自己配置APNs即可享受到推送服务。

> 公开链接可能随测试结束、build 过期或名额调整而关闭/更换；
> TestFlight build 有效期 90 天，过期后需要安装新 build。

## 快速开始

1. 部署 relay：见 [`server/README.md`](server/README.md)
2. 构建 self App：见 [`dsh-remoteApp/README.md`](dsh-remoteApp/README.md)
3. 开发/测试：见 [`dsh-remoteService/README.md`](dsh-remoteService/README.md)
4. 真机验收：[`dsh-remoteApp/docs/ACCEPTANCE.md`](dsh-remoteApp/docs/ACCEPTANCE.md)
5. 诊断/排障：[`docs/diagnostics/`](docs/diagnostics/)
6. 群体版设计：[`docs/group-service-design.zh.md`](docs/group-service-design.zh.md)

## 安全提示

群体服务版由 relay 终止手机 TLS，**部署方可见会话明文**；请只连接你信任的服务。
DSH Web 始终只监听 `127.0.0.1`，不直接暴露公网。

## License

AGPL-3.0-or-later
