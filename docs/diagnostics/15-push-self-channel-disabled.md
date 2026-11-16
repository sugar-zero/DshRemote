# 群体推送「暂不可用」根因：self 通道的 relay 未开启推送（并附插件设置页三处 UI 缺陷）

> 结论先行：
> 1. **推送本身没坏在代码里**——手机上当前这个包是 **self 通道**（未注入 `EXPO_PUBLIC_PUSH_CHANNEL=official`），
>    登记要经「主机 → relay 自己的 APNs 通道」；而部署方 relay 的 `group.push.enabled=false`，
>    所以 `push.register` 一律回 `push_disabled`，App 只能显示「推送暂不可用」。
> 2. **插件设置页「推送通道 —」是上面失败的结果**：通道由已登记设备推导，一台都没登记上就是空；
>    本次把空值文案改成「—（暂无已登记设备）」，避免被读成“通道坏了”。
> 3. **「详细推送内容」开关确实有缺陷**：它跟着「推送提醒」一起被 disabled，而禁用态**没有视觉差异**；
>    另外行标题点了没反应（DSH 原生设置行点整行都能切换）。已在 host-plugin 0.2.9 修掉并补回归测试。

## 1. 用户症状

- 手机上「推送提醒」显示 **暂不可用**，手动重试提示「推送开启失败，请稍后重试。」
- 主机插件设置页「推送提醒」区：**推送通道** 显示 `—`
- 顺带发现：「详细推送内容」开关**关不掉**

## 2. 证据链

### 2.1 主机审计：`push-token` 全部 `push_disabled`

`<DSH_HOME>/remote-access/audit.jsonl` 里 `action=push-token` 的分布：

```text
result=ok      hash=official       134 条   （官方到官方 hub 的登记，历史正常）
result=failed  hash=push_disabled   64 条   （self 通道，relay 拒绝）
result=failed  hash=timeout         39 条   （更早期 relay 无推送代码时）
```

`push_disabled` 只可能来自 relay 的推送总开关（`relay/lib/push.js` 的 `register()`：

```js
if (!enabled) return { ok: false, code: 'push_disabled', message: 'relay 未开启推送（group.push.enabled=false）' };
```

）。主机侧据此把 `status.push.self.lastError` 置为「服务器未开启推送（relay 的 group.push.enabled=false）」，
并给 App 回 `503 push-disabled` → App 状态映射为 `unavailable` → 文案「暂不可用」。

### 2.2 两条通道的区分（为什么“另一个包能用”）

| App 构建 | 通道 | 登记链路 | 依赖 relay 推送配置？ |
|---|---|---|---|
| 未注入 `EXPO_PUBLIC_PUSH_CHANNEL`（本地 `expo run:ios` / 普通 archive） | `self` | App → 主机 `/__dsh_remote/push-token` → 主机 → relay `push.register` | **是**（`group.push.enabled` + 部署方自己的 APNs key） |
| 注入 `official` + `EXPO_PUBLIC_PUSH_HUB`（TestFlight 官方包） | `official` | App → 官方 hub 换 credential → 主机 → 官方 hub 直连 | 否 |

同一份审计里 `ok/official` 与 `failed/push_disabled` 交错出现，正好对应**两个不同构建**的包：
官方包登记成功，自签包（本次装机调试的那个）被 relay 拒绝。

### 2.3 部署侧配置核对（只读）

本仓库的部署副本 `server/.env` **没有任何 `RELAY_GROUP_PUSH_*`**；
`docker-compose.group.yml` 对这些变量是 `${RELAY_GROUP_PUSH_ENABLED:-false}`。
线上 env 文件名可能不同（compose 默认读 `.env`，README 示例用 `--env-file .env.group`），
可用下面命令核对容器里实际生效的值：

```bash
docker inspect dsh-relay-group --format '{{range .Config.Env}}{{println .}}{{end}}' | grep RELAY_GROUP_PUSH || echo "（一个都没配 = 推送关闭）"
```

从主机审计看，self 通道自 2026-11-09 起**每一次登记都是 `push_disabled`**，说明线上一直是关的。

> 注：官方的 `/healthz` 摘要（`push.enabled/mode/tokens`）只绑宿主回环（默认 `127.0.0.1:18080`），
> 不能从公网核对；本次结论完全来自主机审计 + 代码路径。

## 3. 根因

1. **主因（部署配置）**：relay 未启用推送 → self 通道登记被拒。
2. **放大器（构建选择）**：本次装机的是 self 构建，天然需要 relay 推送；官方 TestFlight 包不依赖它。
3. **UI 缺陷（本次一并修）**：
   - 「详细推送内容」`disabled: disabled || !draft.pushEnabled`：`推送提醒` 关掉时它也跟着禁用；
     而 `[data-ra-sw]:disabled` 没有任何样式 → 看着是“开着的开关”，点不动 = 「关不掉」。
   - `Row` 只有右侧开关可点，标题/说明点了没反应（DSH 原生设置页是整行可切）。
   - 通道空值只显示 `—`，没有“为什么是空的”。

## 4. 修复

### 4.1 部署侧（需要部署方在 VPS 上执行；本代理不碰线上）

self 通道需要部署方**自己的** APNs Auth Key（`.p8` 只放服务器，不进仓库）。步骤如下（占位符）：

```bash
# 1) 放 key（容器内路径 /data/apns/，与 compose 的 data 卷对应）
cp AuthKey_<KEY_ID>.p8 <relay>/data/apns/
chmod 700 <relay>/data/apns && chmod 600 <relay>/data/apns/AuthKey_<KEY_ID>.p8

# 2) <relay>/.env（= server/.env）追加/修改
RELAY_GROUP_PUSH_ENABLED=true
RELAY_GROUP_PUSH_MODE=self
RELAY_GROUP_PUSH_CONTENT=generic           # 想带会话标题/摘要再改 summary
RELAY_GROUP_PUSH_APNS_KEY_FILE=/data/apns/AuthKey_<KEY_ID>.p8
RELAY_GROUP_PUSH_APNS_KEY_ID=<KEY_ID>
RELAY_GROUP_PUSH_APNS_TEAM_ID=<TEAM_ID>
RELAY_GROUP_PUSH_APNS_TOPIC=com.example.dshremote   # = 自签 App 的 bundle id
RELAY_GROUP_PUSH_APNS_ENVIRONMENT=auto

# 3) 重建容器（改 env/端口必须 force-recreate，restart 不更新）
docker compose -f docker-compose.group.yml up -d --force-recreate

# 4) 验证（relay 本机；摘要只含 enabled/mode/tokens）
curl -s http://127.0.0.1:18080/healthz | grep -o '"push":{[^}]*}'
#   期望 "enabled":true,"mode":"self"
```

> 重建会短暂断开隧道（主机自动重连）。按仓库约定，**重启由用户执行**，代理不代为重启。

随后在 App「设置 → 推送」关一次再开（或重启 App 进入主机），让 App 重新登记；
主机设置页应变成「推送通道：私有」「私有推送 1 台」。

**替代方案**：不部署 APNs key 时，改用官方构建（注入 `EXPO_PUBLIC_PUSH_CHANNEL=official` +
`EXPO_PUBLIC_PUSH_HUB=https://<hub>`），走官方 hub，不依赖 relay 推送配置。

### 4.2 插件侧（本次提交，host-plugin 0.2.9）

- 「详细推送内容」不再跟随「推送提醒」禁用；两者独立持久化（`pushEnabled` / `pushDetail`）。
- 所有开关行的**标题/说明区可点击切换**（键盘 Enter/Space 同样可用）。
- `[data-ra-sw]:disabled` 增加 `opacity:.5; cursor:default`——禁用态一眼可辨。
- 空通道文案：`—` → `—（暂无已登记设备）`（en + zh）。
- 新增回归测试：
  - 「详细推送内容」可独立关闭并只提交 `{pushDetail:false}`，保存后保持关闭；
  - 「推送提醒」关闭时「详细推送内容」仍可切换；
  - 点标题等价于点开关。

## 5. 验证

- `cd dsh-remoteService && npm test` → **303/303 通过**
- `cd dsh-remoteService && npm run validate:artifacts` → **通过（warnings: 0）**
- `node --check packages/host-plugin/client.js` → 通过
- 待用户侧验证（本次改动需要**重启 DSH** 才会加载新的 host 半；client.js 刷新页面即可）：
  1. 设置页「详细推送内容」可点标题/开关切换，保存后不再回弹；
  2. 「推送提醒」关掉时该开关仍可操作；
  3. 部署侧开启 self 推送后，App 重新登记成功、通知可收到（此项依赖 VPS 步骤）。

## 6. 未做 / 待确认

- **App 侧错误文案**：release 包里 `pushStatus.error` 只在 `__DEV__` 显示，用户只看到「暂不可用」，
  看不到「服务器未开启推送」这条关键信息。改它属于 `dsh-remoteApp/` 源码改动，按仓库约定需要
  构建 + 真机实测后由用户确认，本次未动，列为后续项。
- 若用户重启 DSH 后「详细推送内容」**仍**关不掉，请回报当时「推送提醒」的开/关状态与是否有 toast
  （保存成功/失败），以便继续定位（本轮从代码路径复现不到第二种原因）。
