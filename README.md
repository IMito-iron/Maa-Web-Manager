# MAA Web Manager

在浏览器里管理一台 Android 设备上的 [MAA（MaaAssistantArknights）](https://github.com/MaaAssistantArknights/MaaAssistantArknights)：可视化配置任务、串行执行队列、实时日志、历史记录、定时调度和远程查看/操作设备画面。全部运行在 Docker Compose 里，宿主机不需要安装 MAA、ADB 或 Node。

> A self-hosted web console for running MAA (MaaAssistantArknights) against one Android device — a USB phone or a network ADB device such as an emulator — with a task editor modelled on the MAA Windows GUI, a serial run queue, schedules, live logs and remote screen control.

**状态：v0.1.0（首个公开版本）。** 已在一台 USB 真机上长期运行；网络 ADB（模拟器 / 无线调试）为本版本新增，请先阅读 [设备连接](docs/devices.md)。

## 功能

- **任务配置**：参照 MAA Windows 版（v6.21.4）界面的表单（开始唤醒、公招、基建、作战、信用商店、领取奖励、肉鸽等），运行时按 Windows 版的逻辑生成 maa-cli 参数；同时保留原始 JSON 模式。多预设、可命名、可复制。
- **执行队列**：单设备、单任务串行；运行快照与配置哈希记录在案；可停止、可重排。
- **定时调度**：每日 / 每周 / 间隔 / cron，按可配置的时区执行。
- **实时日志与历史**：SSE 增量推送，断线可续传；历史与日志分别保留。
- **设备画面**：WebRTC 低延迟画面（H.264）与 noVNC 兼容模式；需要显式“开始控制”才能输入，控制期间自动任务暂停派发。
- **设备连接**：USB 真机，或通过 `host:port` 连接的网络 ADB 设备（模拟器、无线调试）。
- **只读 Bot API**：带令牌的每日状态接口，附 AstrBot 插件（`astrbot_plugin_maa_manager/`）。

## 快速开始

要求：Linux x86_64、Docker Engine + Compose v2.24+、8 GiB 以上可用磁盘，以及一台已安装明日方舟的 Android 设备（USB 调试已开启）或模拟器。

```bash
git clone https://github.com/IMito-iron/Maa-Web-Manager.git
cd Maa-Web-Manager
cp .env.example .env
```

然后二选一配置设备：

```bash
# A. USB 真机：在 .env 里保持 COMPOSE_FILE=compose.yaml:compose.usb.yaml
cp config/devices.example.json config/devices.json      # 填入 `adb devices` 显示的 serial
```

```bash
# B. 模拟器 / 网络 ADB：在 .env 里改为 COMPOSE_FILE=compose.yaml
cp config/devices.tcp.example.json config/devices.json  # 填入 host:port，例如 host.docker.internal:5555
```

部署并打开：

```bash
bash deploy.sh
```

默认在 `http://localhost:8080` 提供服务（只监听本机）。首次启动队列处于暂停状态，在页面点击“恢复派发”后调度才会生效。

`deploy.sh` 会下载 `runtime.lock.json` 固定版本的官方 maa-cli 与 MaaCore 并校验 SHA-256，然后构建镜像。详见 [部署](docs/deployment.md)。

> **安全提示**：控制台本身没有账号体系，任何能访问网页的人都能操作设备和任务。默认只绑定 127.0.0.1；需要远程访问时，请在前面放置带认证的反向代理（见 [部署 · 反向代理](docs/deployment.md#反向代理)）。

## 文档

| 文档 | 内容 |
| --- | --- |
| [设备连接](docs/devices.md) | USB 真机与网络 ADB 的配置、授权、常见模拟器端口 |
| [配置参考](docs/configuration.md) | `.env`、`config/devices.json`、Compose 叠加文件、时区 |
| [部署与运维](docs/deployment.md) | 安装、反向代理、更新、备份与恢复 |
| [架构](docs/architecture.md) | 容器拓扑、分层、关键契约与替换点 |
| [开发](docs/development.md) | 仓库结构、构建、测试 |
| [排障](docs/troubleshooting.md) | 常见问题 |
| [Android 低延迟画面](docs/android-streaming.md) | 画面链路与控制模型 |
| [Bot API 契约](contracts/bot-daily-api.openapi.json) | 只读每日状态接口（OpenAPI） |

各子项目说明：[`apps/server`](apps/server/README.md) · [`apps/web`](apps/web/README.md) · [`apps/media`](apps/media/README.md) · [`astrbot_plugin_maa_manager`](astrbot_plugin_maa_manager/README.md)

## 常用命令

```bash
docker compose ps
docker compose logs -f manager device
docker compose exec manager maa-managerctl status
docker compose exec manager maa-managerctl resume     # 恢复派发
docker compose exec manager maa-managerctl run <预设名>
docker compose exec manager maa-managerctl pause
docker compose stop                                  # 停止服务，数据保留在 DATA_ROOT
```

## 许可证与致谢

本项目以 [GNU AGPL-3.0](LICENSE) 发布。构建出的镜像包含 [MaaAssistantArknights](https://github.com/MaaAssistantArknights/MaaAssistantArknights) 与 [maa-cli](https://github.com/MaaAssistantArknights/maa-cli)（均为 AGPL-3.0）、[scrcpy](https://github.com/Genymobile/scrcpy)（Apache-2.0）和 noVNC（MPL-2.0）。

本项目与 MAA 团队、鹰角网络无关。请遵守游戏的用户协议，自行承担使用自动化工具的风险。
