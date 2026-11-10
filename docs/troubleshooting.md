# 排障

先看两处：网页“总览 / Android”页的设备状态与原因，以及 `docker compose exec manager maa-managerctl status` 输出的 JSON（`deviceState`、`deviceReason`、`deviceTransport`、`adb`、`maa`、`display*`）。

## 访问

- **页面打不开**：默认只监听 `127.0.0.1:8080`，从其他机器访问需要反向代理（见 [部署 · 反向代理](deployment.md#反向代理)）。`docker compose ps` 确认 `gateway`、`portal`、`manager` 都在运行。
- **portal 启动即退出，日志提示 `PUBLIC_ORIGIN must be an https:// origin`**：`PUBLIC_ORIGIN` 只能是 `https://…`，或 `http://localhost:<端口>` / `http://127.0.0.1:<端口>`。
- **保存或运行时 403 “Same-origin JSON request required”**：`PUBLIC_ORIGIN` 必须与浏览器地址栏的协议、主机、端口完全一致；反向代理需要原样转发 `Origin`。
- **重启后队列不动**：这是设计行为。Manager 每次启动都以暂停状态开始，检查设备与 MAA 状态后点击“恢复派发”。

## 设备（USB）

在 `device` 容器里查看 ADB 的真实视角（不要在宿主机上直接运行 `adb`，它会抢占手机）：

```bash
docker compose exec device /opt/scrcpy/adb devices -l
```

页面上的原因会指出该处理哪一侧：

1. **USB 未枚举**：数据线、接口或供电问题。换一根数据线，直接插主板接口，不要用集线器。
2. **USB 已枚举但未提供 ADB 接口**：手机没有开启 ADB 功能。开启“USB 调试”，USB 用途选“传输文件”，解锁屏幕后重新插拔；没有授权弹窗时，关闭再打开 USB 调试。
3. **ADB 服务未识别到设备**：通常是宿主机上的 adb 服务占用了手机。执行一次 `sudo scripts/install-adb-guard.sh`，或立即 `adb kill-server`。
4. **ADB 未授权**：在手机上勾选“始终允许使用这台计算机”。

容器会轮询 `/sys/bus/usb/devices`，检测到重新插拔时自行重启 ADB 服务（页面显示“adb 服务已自动重启 N 次”），不需要重启容器。

## 设备（网络 ADB）

- **网络 ADB 未连接**：`device` 容器会持续重试 `adb connect`。用 `docker compose logs device | grep "adb connect"` 查看返回信息：
  - `Connection refused`：目标端口没有 ADB 服务，或只监听在 127.0.0.1（多数 Windows 模拟器、Android Studio 模拟器），需要端口转发，见 [设备连接](devices.md#常见来源)。
  - `No route to host` / 超时：地址或防火墙问题；`host.docker.internal` 只指向运行 Docker 的这台机器。
  - `failed to authenticate`：在设备或模拟器上允许调试授权；Android 无线调试需要先 `adb pair`。
- **地址变了**：Android 无线调试的端口每次开启都会变化，更新 `config/devices.json` 后执行 `docker compose restart device manager media`。
- **设备列表里出现了别的设备**：Manager 只绑定 `address` 精确匹配、且通过网络连接的那一台。

## 运行

- **任务失败，原因是“失败时前台应用：…”**：失败时屏幕上是哪个应用。如果是设置页或其他应用，关闭它回到游戏后重新运行；如果就是游戏本身，请查看运行日志中 `ERROR` 所在的任务。MAA 核心日志位于 manager 容器的 `/data/state/maa/debug/asst.log`，识别失败时的截图在同目录的 `interface/` 下。
- **游戏更新后某个导航步骤一直失败**：通常是游戏界面变化导致识别区域失效。MAA 上游修复后，更新 `runtime.lock.json` 中的 MaaCore 版本；等待期间可以在 `config/maa-resource/tasks/manager.json` 中只覆盖相关任务的字段（例如 `roi`），重建 manager 镜像生效。
- **“理智未耗尽”**：运行原因会说明，Manager 已自动排入一次 `sanity-retry` 重试。作战关卡留空时先跟随游戏的“前往上一次作战”；重试使用记住的关卡（页面“总览”与 `/api/status.sanity` 可见）。删除 `DATA_ROOT/manager/state/sanity-stage.json` 可回到 `SANITY_FALLBACK_STAGE`；在预设中写明关卡则不跟随也不重试。
- **“任务配置无法执行”**：预设在派发时编译失败（例如选择的关卡今天未开放且没有备选）。原因中列出了具体任务和字段。
- **入队后提示配置已变化**：有人在 Manager 之外修改了预设文件；检查内容后重新提交。
- **账号切换的预设被阻止**：`ACCOUNT_IDENTITY_POLICY=require-verified` 时，无法从 MAA 核心日志确认当前登录账号就会阻止后续任务。确认切换生效后重试，或在了解风险后改为 `warn-continue`。

## 画面

- **画面空白、过小或有黑边**：点击 Android 面板上的“重置画面大小”，它会重连查看器并让 supervisor 恢复画面编码。`device` 容器刚重启的头几分钟画面可能为空，自动任务不受影响。
- **点击位置不准**：不要用浏览器缩放；按“重置画面大小”重新取景。
- **低延迟模式连不上**：WebRTC 需要 `MEDIA_ICE_PORT` 的 UDP/TCP 端口可达；不可达时页面会回退到经过网关的 WebSocket 通道，延迟会稍高。
- **手机在运行中被点亮**：MAA 的点击会唤醒屏幕，supervisor 每 `display.reassertMs` 重新熄屏一次；也可以点击“熄屏”。模拟器请设置 `"dark": false`。

## 其他

- **镜像构建时报 MaaCore 缺少依赖库**：`vendor/maa-runtime.tar.gz` 不完整或架构不符。删除后重新运行 `deploy.sh` 下载。
- **网关 502**：后端容器重建期间的短暂现象；持续出现时检查 `docker compose ps` 中各服务的健康状态。
