# 12 - Windows setup and Android real-device E2E smoke test

验收日期：2026-11-02（Asia/Shanghai）。实机验证所用源码基线：`ae60b31`，加本轮 Android Kotlin 编译修复。
完整 PR 相对上游 `main`（`56ba36f`）的差异还包含该基线中的 Windows 兼容改动，代码状态保留 `64c1736`。

## 1. 验收范围与结论

在 Windows 11 开发机上补齐 Android 工具链后，完成了调试 APK 构建、USB 安装、
小米真机扫码配对、原生 mTLS WebView、公网中继访问及聊天烟雾测试。

| 项目 | 实际环境 |
|---|---|
| Windows | Windows 11 x64，版本 10.0.26100 |
| DSH Desktop | 文件版本 0.2.1-rc.5 |
| Node / npm | v24.14.0 / 11.9.0 |
| JDK | Eclipse Temurin 17.0.20.1 |
| App / host-plugin | 0.1.14，versionCode 17 / 0.1.16 |
| Expo / React Native | 58.0.14 / 0.88.0 |
| Gradle | 9.4.1，使用生成工程自带 wrapper |
| Android SDK | Platform `platforms;android-37.0`，Build Tools 37.0.0 |
| NDK / CMake | 27.1.12297006 / 3.22.1 |
| 真机 | Xiaomi 17，型号 25113PN0EC，Android 16 |
| APK | `com.amesucre.dshremote`，minSdk 24，targetSdk 36 |
| 公网链路 | WSS 控制面 8443；手机 HTTPS/mTLS 数据面 1443；未改动已有 443 服务 |

## 2. Windows 主机与工具链准备

先按 [部署指南](../../dsh-remoteService/docs/DEPLOY.md) 配置 relay、DNS、主机 TLS 证书及 host token。
下文用 `relay.example.com` / `h_example` 代替实际域名和主机 ID。

### 2.1 先对齐版本：Expo SDK 不等于 Android SDK

仓库的 Expo / React Native 版本保持不变，电脑补装对应的 Android 构建组件。
本机最初只有 Android Platform 35 / Build Tools 35.0.0。

本次编译实际使用 **Android SDK Platform 37.0（API 37）和 Build Tools 37.0.0**。
`targetSdk` 和 `minSdk` 是运行配置，不要求额外安装 Platform 36 或 Platform 24。

| 层级 | 仓库或依赖实际要求 | 本机最初情况 / 最终处理 |
|---|---|---|
| Expo SDK | `package.json` 声明 `~58.0.14`，实际安装 58.0.14 | 保持仓库版本；58 不是 Android API 编号 |
| React Native | 声明及实际安装均为 0.88.0 | 保持仓库版本，不降级换工具链 |
| Android compileSdk | 37 | 编译使用的 SDK；本机从 Platform 35 补装 `platforms;android-37.0` |
| Android targetSdk | 36 | 运行行为目标 API，不是需要另装的 SDK 版本 |
| Android minSdk | 24 | 最低支持的运行 API，不是需要另装的 SDK 版本 |
| Build Tools | 37.0.0 | 最初只有 35.0.0；最终补装 37.0.0 |
| NDK / CMake / Gradle | 27.1.12297006 / 3.22.1 / wrapper 9.4.1 | 按生成工程补齐，不能用“已安装 Android SDK”代替逐项核对 |

Android 版本来源可在安装依赖后核对：
`node_modules/react-native/gradle/libs.versions.toml` 中本轮为 `compileSdk=37`、`targetSdk=36`、
`minSdk=24`、`buildTools=37.0.0`、`ndkVersion=27.1.12297006`；Expo autolinking 的 Gradle 插件
读取版本目录并设置根工程属性，生成的 `android/app/build.gradle` 再消费这些属性。
`app.json` 中的 `minSdkVersion=24` 是最低运行版本，构建时还要核对上述组件。

`npm run check:android-env` 是 Bash 脚本，只检查 JDK、SDK 目录和 adb 是否存在，
不校验 compileSdk、Build Tools、NDK、CMake 的版本，对 Windows 的工具路径检查也不完整。
安装前需按上表核对。

### 2.2 首次构建实际卡过的位置

| 卡点 / 表现 | 本轮确认的原因 | 处理方式 |
|---|---|---|
| 配好 `ANDROID_HOME` 后仍需安装 SDK | 本机 35 与生成工程所需 37 / Build Tools 37.0.0 不一致 | 按版本表补齐，不修改依赖版本来绕过 |
| 请求 `platforms;android-37` 找不到包 | 本轮 SDK Manager 的包名实际是 `platforms;android-37.0` | 使用下面列出的完整 package ID；API 数字和安装包名不要混写 |
| Gradle 很久没有任务进展、CPU 很低 | 继承了不可用代理；去掉代理后，直连 `plugins.gradle.org` 的依赖请求仍失败 | 先确认下载连通性，再显式配置 Gradle JVM HTTP/HTTPS 代理；不是 Kotlin / RN 版本不兼容 |
| Gradle wrapper 下载停在 0 字节 | `gradle-9.4.1-bin.zip` 的下载没有取得有效进展 | 使用可用网络/代理；手动下载时先校验完整性，再放到该 wrapper 的缓存目录，不换成其它 Gradle 版本 |
| 自动安装 NDK 看起来卡住 | NDK 下载体积大，受下载链路影响；不是已经开始编译 C++ | 预先安装并确认 27.1.12297006 完整；本轮用官方归档校验后解压补齐，不把 `.partial` 目录当作已安装 |
| 下载结束后仍被 Kotlin / Ninja 阻塞 | 透明背景属性赋值编译错误、Windows 对象文件路径过长 | 按第 3 节修复 setter，并在生成工程中设置 `CMAKE_OBJECT_PATH_MAX=240` |

SDK Manager 代理参数与 Gradle JVM 的代理参数不是同一套；仅设置 PowerShell 的代理环境变量
不代表两者都能下载。首次构建必须有依赖缓存或可用网络；第 3 节的 `--offline` 只适合依赖齐全后的复编。

### 2.3 安装与配置步骤

1. 安装 Windows 版 Node 24、JDK 17、Android SDK Command-line Tools / Platform Tools。
   本轮分别放在 `D:\dev\jdk-17` 和 `D:\Android\Sdk`，仓库使用短路径 `D:\dev\DshRemote`。
2. 安装、启动 DSH Windows Desktop。若使用本地插件，先完全退出 Desktop，在服务目录安装依赖，
   再执行下列命令。`dsh` CLI 必须先可用；安装来源及基础配置沿用部署指南。

```powershell
$Repo = 'D:\dev\DshRemote'
Set-Location "$Repo\dsh-remoteService"
npm ci
dsh plugin --profile desktop add "$Repo\dsh-remoteService\packages\host-plugin"
```

启动 Desktop 后，在远程访问设置中填写 relay URL、域名、hostId、host token、主机证书及私钥路径。
本轮直接使用 1443 数据端口时，还需要配置 `publicPort=1443`，并在云防火墙放行该端口。
主机证书必须覆盖 `<hostId>.<relayDomain>`；不能关闭 TLS 校验代替正确配置。

同一个 `DSH_HOME` / hostId 只运行一个主机实例。Desktop 与 `dsh web` 同时运行时，
两个实例会反复替换中继控制连接。本轮的配对网络失败在停止旧 CLI 后恢复。

```powershell
$env:JAVA_HOME = 'D:\dev\jdk-17'
$env:ANDROID_HOME = 'D:\Android\Sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;" + $env:Path
$SdkManager = "$env:ANDROID_HOME\cmdline-tools\latest\bin\sdkmanager.bat"

# 按交互提示阅读并接受 SDK license。
& $SdkManager --sdk_root=$env:ANDROID_HOME --licenses
& $SdkManager --sdk_root=$env:ANDROID_HOME 'platform-tools' 'platforms;android-37.0' 'build-tools;37.0.0' 'ndk;27.1.12297006' 'cmake;3.22.1'
```

注意该 SDK 的安装名是 `platforms;android-37.0`，不是 `platforms;android-37`。
下载受网络限制时，可为 SDK Manager 显式添加
`--proxy=http --proxy_host=127.0.0.1 --proxy_port=10808`；无代理环境不要照抄该参数。

## 3. 构建 Android 调试 APK

```powershell
Set-Location "$Repo\dsh-remoteApp"
npm ci
# 第一次生成工程时执行；不要对已有本地设置的工程随意使用 --clean。
& .\node_modules\.bin\expo.cmd prebuild --platform android
```

### 本轮必需的编译修复

`modules/dsh-mtls/android/src/main/java/com/dsh/remote/mtls/DshMtlsWebView.kt` 将
`backgroundColor = 0x00000000` 改为 `setBackgroundColor(0x00000000)`，避免 Kotlin 对继承属性的赋值编译错误。
透明背景保持不变。

Windows 上 RN/CMake 生成的对象文件路径过长会使 Ninja 构建失败。本轮在**生成的、未跟踪的**
`android/app/build.gradle` 的现有 `defaultConfig` 内加入：

```groovy
externalNativeBuild {
    cmake {
        arguments "-DCMAKE_OBJECT_PATH_MAX=240"
    }
}
```

不要另建第二个 `defaultConfig`。`128` 在本机不足以容纳固定目录前缀，最终使用 `240` 构建通过。
`android/` 不提交；重新 prebuild 后检查该设置。仍需保持仓库和 SDK 路径尽可能短。

```powershell
Set-Location "$Repo\dsh-remoteApp\android"

# 先清理当前构建进程继承的代理变量，不修改系统代理设置。
Remove-Item Env:HTTP_PROXY,Env:HTTPS_PROXY,Env:ALL_PROXY,Env:http_proxy,Env:https_proxy,Env:all_proxy -ErrorAction SilentlyContinue

# 本机首次下载依赖时使用的可选代理；网络直连正常时改为 @()。
$ProxyArgs = @('-Dhttp.proxyHost=127.0.0.1', '-Dhttp.proxyPort=10808', '-Dhttps.proxyHost=127.0.0.1', '-Dhttps.proxyPort=10808')
& .\gradlew.bat assembleDebug --no-daemon --console=plain @ProxyArgs
if ($LASTEXITCODE -ne 0) { throw 'Android build failed' }
```

输出：`android/app/build/outputs/apk/debug/app-debug.apk`。本轮离线增量复编日志为：

```text
BUILD SUCCESSFUL in 54s
339 actionable tasks: 22 executed, 317 up-to-date
```

此次增量复编使用已有依赖缓存，退出码为 0。缓存齐全后，可用
`./gradlew.bat assembleDebug --offline --no-daemon --console=plain` 复编；缓存不全时需先联网下载依赖。

交付 APK 为 180142683 字节，SHA-256：

```text
BB1C5236CADA33860427987B456FC10C5F08AFE45C9905E679C16BD849B31AF8
```

本次复编产物与已安装验收的 APK 摘要一致。APK 使用 Android debug 签名，
已验证 v2 签名及 DEX 中的原生 mTLS 模块。

## 4. USB 安装、Metro 与真机验收

1. 手机开启开发者选项、USB 调试，手动允许本电脑的调试授权。
   小米还需开启“USB 安装”，并由用户完成手机安装确认；`INSTALL_FAILED_USER_RESTRICTED`
   表示手机拒绝安装，需在手机上允许。
2. 用 `adb devices -l` 确认目标处于 `device`，下列 `<SERIAL>` 必须替换为该手机序列号。

```powershell
$Adb = "$env:ANDROID_HOME\platform-tools\adb.exe"
$Serial = '<SERIAL>'
& $Adb devices -l
& $Adb -s $Serial install -r "$Repo\dsh-remoteApp\android\app\build\outputs\apk\debug\app-debug.apk"
& $Adb -s $Serial reverse tcp:8081 tcp:8081
& $Adb -s $Serial shell am start -n com.amesucre.dshremote/.MainActivity
```

另开一个终端启动 Metro，并在调试期间保持运行：

```powershell
Set-Location 'D:\dev\DshRemote\dsh-remoteApp'
& .\node_modules\.bin\expo.cmd start --port 8081 --offline
```

该调试 APK 未内嵌 JS，需要保持 Metro 运行，通过 USB reverse 加载。
Expo `--offline` 只限制开发服务器的外部请求，不会阻断 App 访问公网 relay。
当前 Expo CLI 不接受同时传入 `--offline` 和 `--localhost`。

3. 只在 Desktop 生成新配对 QR，手机扫描、核对主机指纹/SAS，按配置完成桌面确认。
   设备 CSR 由手机的 AndroidKeyStore 生成。
4. 配对后检查 App 的原生 mTLS WebView 已加载真正的 DSH 页面，地址为
   `https://<hostId>.relay.example.com:1443/?dsh_mobile=1`，无证书错误。
5. 在手机发送“回复 ok 即可”，确认收到 `ok`，并在 Windows Desktop 看到同一会话。

### 已观测到的证据

| 验收项 | 证据与结论 |
|---|---|
| 编译 | `assembleDebug` 返回 `BUILD SUCCESSFUL`，APK 摘要见上 |
| 安装 | USB 安装返回 `Performing Streamed Install` / `Success`；只读包查询确认 0.1.14 / code 17 |
| 真机配对 | 17:15:17 主机审计 `pairing=paired`、`pair-request=paired`；用户确认“这次配对成功了” |
| mTLS / 公网页面 | 17:16:10 审计 `ws-upgrade=ok`；手机截图显示已连接、原生 mTLS 身份与完整 DSH 页面 |
| 聊天 | 用户确认手机烟雾测试通过；桌面实际截图显示同一“确认回复 ok”会话及 `ok` 回复 |
| 私钥边界 | APK 包含 AndroidKeyStore CSR/证书处理模块，使用原生身份；未导出设备私钥、未做硬件 TEE/StrongBox attestation |

脱敏审计摘录（UTC+08:00，不包含设备 ID、资源、密钥或哈希）：

```text
2026-11-02 17:15:17  pairing       paired
2026-11-02 17:15:17  pair-request  paired
2026-11-02 17:16:10  ws-upgrade    ok
```

原始构建日志、审计、手机截图及 APK 保存在本机。原生 mTLS 成功页截图的 SHA-256 为：

```text
239B0D3470D88E01B8277890401FC737FA8854B2C15F5D7AAFB6866578D9D3AD
```

## 5. 回归与未验收项

2026-11-02 回归结果：

| 命令 | 本轮结果 |
|---|---|
| `cd dsh-remoteService; npm test` | 163 项：161 passed、2 skipped、0 failed；两项跳过需 POSIX shell |
| `cd dsh-remoteApp; npm run typecheck` | 通过 |
| `npm run check:native` | 通过，0 warnings |
| `npm run check:shell` | 跳过：脚本未识别本机 Windows Chrome 路径 |
| Android `assembleDebug --offline --no-daemon --console=plain` | 通过：`BUILD SUCCESSFUL in 54s`，339 项任务中 22 项执行、317 项已是最新，退出码 0 |

完整 PR 保留以下改动：

| 部分 | 修改内容 |
|---|---|
| Android 原生模块 | 透明背景改用显式 setter，修复 Kotlin 编译错误 |
| Windows 主机 | 补充桌面父进程识别；处理 OpenSSL 缺少配置文件的情况，保留 CSR 校验与签发规则 |
| 回归测试 | 适配 Windows Shell、路径断言及 OpenSSL 配置 |
| 服务端依赖锁文件 | 同步已声明的 workspace 包版本与许可证元数据，第三方依赖版本不变 |
| 文档 | 记录安装、构建、真机验收及复现步骤，更新状态说明 |

此前的 EC CSR 排障背景见 [EC CSR / OpenSSL 排障](08-host-ec-csr-windows.md)。

### 已知问题，独立后续任务

- `FOLLOWUP-PAIRING-UI`：PC 弹窗忽略 `paired` 终态，自动生成下一张 QR，可能在手机已连接后仍显示“等待配对”。
  审计显示配对成功约 5 毫秒后便创建了新会话。修复与测试已保存为独立补丁。
- `FOLLOWUP-DEVICE-COUNT`：侧栏“中继在线 · 3 台设备”统计未撤销的配对记录，不是当前在线数量，
  也未排除过期记录。本轮三条记录分别来自两条电脑测试身份和一条真实 Android 身份。
