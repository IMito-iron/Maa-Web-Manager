# 设备连接

MAA Web Manager 一次只管理**一台**设备，由 `config/devices.json` 指定。设备可以通过两种方式接入：

| transport | 适用 | Compose 叠加 | 设备标识 |
| --- | --- | --- | --- |
| `usb` | 插在宿主机上的真机 | `compose.yaml:compose.usb.yaml` | `serial`（`adb devices` 第一列） |
| `tcp` | 模拟器、redroid、Android 无线调试 | `compose.yaml` | `address`（`host:port`） |

无论哪种方式，ADB 服务都只运行在 `device` 容器里：它是唯一会打开设备连接的地方（USB 时占用 USB 设备，`tcp` 时只对配置的那一个 `host:port` 执行 `adb connect`）。Manager 与 media 服务只通过内部网络向这个 ADB 服务查询，不会自行建立连接，也不会执行 `adb tcpip`。

完整字段见 [配置参考](configuration.md#configdevicesjson)。修改 `devices.json` 后执行 `docker compose restart device manager media`。

## USB 真机

1. 手机上开启“开发者选项 → USB 调试”，USB 用途选择“传输文件”，并保持屏幕解锁（不要设置锁屏密码，Manager 不会输入密码）。
2. 宿主机上**不要**运行 `adb` 服务：它会先占用手机。可以执行一次 `sudo scripts/install-adb-guard.sh`，安装一个开机清理 + 定时清理宿主机 adb 的守护（幂等，不会重启 Docker）。
3. 查到 serial：在任意装有 adb 的电脑上执行 `adb devices -l`，或启动服务后在网页“Android → ADB 设备列表”中查看。
4. 写入配置并部署：

   ```json
   {"version": 2, "transport": "usb", "serial": "<你的 serial>", "packageName": "com.hypergryph.arknights"}
   ```

   `.env` 中保留 `COMPOSE_FILE=compose.yaml:compose.usb.yaml`。
5. 首次连接时手机会弹出“允许 USB 调试”，请勾选“始终允许”。授权所用的密钥保存在 `ADB_KEY_DIR`（默认 `./data/adb-keys`），保持该目录不变即可避免重复授权。

`device` 容器内没有 udev，ADB 收不到热插拔事件；supervisor 会轮询 `/sys/bus/usb/devices`，发现拓扑变化或“手机已暴露 ADB 接口但 ADB 没看到它”时自动重启 ADB 服务，所以插拔数据线或手机重启后通常几秒内恢复，不需要重启容器。

非 Debian/Ubuntu 系统上，若容器无法打开 USB 设备，请把 `.env` 中的 `USB_GID` 改成宿主机上拥有 `/dev/bus/usb/*` 的组（`ls -ln /dev/bus/usb/001`）。

## 网络 ADB（模拟器 / 无线调试）

```json
{"version": 2, "transport": "tcp", "address": "host.docker.internal:5555",
 "packageName": "com.hypergryph.arknights",
 "display": {"width": 1280, "height": 720, "naturalOrientation": "landscape", "density": 240, "dark": false}}
```

- `address` 只接受主机名或 IPv4 加端口；ADB 用这个字符串本身标识设备，所以 Manager 只认这个精确地址。
- `host.docker.internal` 指向运行 Docker 的这台宿主机（Compose 已为 `device` 容器加上映射）。
- `device` 容器会自动 `adb connect`，失败时以 2 秒起、最长 30 秒的间隔重试；设备显示 `offline` 时会先断开再重连。
- 模拟器没有可以熄灭的屏幕，建议 `"dark": false`。`display` 中的分辨率会通过 `wm size` / `wm density` 写入设备，请设置成 16:9（推荐 1280×720）。

### 常见来源

| 来源 | 默认 ADB 端口 | 说明 |
| --- | --- | --- |
| redroid（本仓库 `redroid` profile） | `android:5555` | 同一 Compose 网络内直接可达，见下文 |
| Android Studio 模拟器（AVD） | 5555 起，奇数端口 | 只监听 127.0.0.1，容器访问不到；需在宿主机上做端口转发（如 `socat TCP-LISTEN:15555,fork TCP:127.0.0.1:5555`，再用 `host.docker.internal:15555`） |
| MuMu 模拟器 12 | 16384（多开 +32） | Windows 程序，见下方“跨机器” |
| 雷电模拟器 9 | 5555（多开 +2） | 同上 |
| 夜神模拟器 | 62001 | 同上 |
| Android 11+ 无线调试 | 每次开启都会变化 | 需要先配对，见下文 |

**跨机器（例如 Linux 服务器 + Windows 上的模拟器）**：很多 Windows 模拟器的 ADB 只监听 `127.0.0.1`。需要在 Windows 上把端口转发到局域网（例如 `netsh interface portproxy add v4tov4 listenport=16384 listenaddress=0.0.0.0 connectport=16384 connectaddress=127.0.0.1`），并只对服务器的 IP 放行防火墙。ADB 端口相当于设备的完全控制权，**不要暴露到公网**。

**Android 无线调试**：系统要求先配对一次，再用“无线调试”页面显示的连接端口：

```bash
docker compose exec device /opt/scrcpy/adb pair <手机IP>:<配对端口>   # 输入手机上显示的配对码
```

配对信息保存在 `ADB_KEY_DIR`。手机重启或重新打开无线调试后连接端口会变化，需要更新 `address`。

### redroid（实验性）

`compose.yaml` 带有一个 `redroid` profile，在宿主机内核支持 binder 时可以在容器里运行 Android：

```bash
sudo scripts/prepare-host.sh          # 加载 binder 模块并挂载 binderfs（一次）
docker compose --profile redroid up -d
```

`devices.json` 使用 `{"version": 2, "transport": "tcp", "address": "android:5555"}`。游戏需要自行安装并登录。redroid 的数据保存在 `DATA_ROOT/android`；同一个数据目录绝不能同时被两个 Android 实例挂载。

## 支持的客户端

`packageName` 可以是 MaaCore 支持的任一明日方舟客户端：

| 客户端 | packageName |
| --- | --- |
| 官服 | `com.hypergryph.arknights` |
| B 服 | `com.hypergryph.arknights.bilibili` |
| 国际服 EN | `com.YoStarEN.Arknights` |
| 日服 | `com.YoStarJP.Arknights` |
| 韩服 | `com.YoStarKR.Arknights` |
| 台服 | `tw.txwy.and.arknights` |

`packageName` 只描述设备上运行的是哪个 App；MAA 的客户端类型（`client_type`）在每个预设的“开始唤醒”任务里设置。
