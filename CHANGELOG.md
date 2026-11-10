# Changelog

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-11-10

首个公开版本。

### 功能

- 浏览器控制台：总览、任务配置、调度、运行历史与实时日志、Android 设备画面；中文与日文界面。
- 任务配置对齐 MAA Windows 版 v6.21.4：开始唤醒、公开招募、基建换班、理智作战、信用商店、领取奖励、集成战略、自定义任务、切换主题等，派发时按 Windows 版的序列化规则生成 maa-cli 参数；“仅本次”选项、活动关卡开放判断、信用商店“每日一次”、干员名称别名。原始 JSON 模式保留。
- 单设备串行执行队列：运行快照与哈希、停止、重启后中断与暂停、剩余理智自动重试。
- 调度：每日、每周、间隔、cron，按 `MANAGER_TIME_ZONE` 计算。
- 设备连接：USB 真机，或网络 ADB（模拟器、Android 无线调试、redroid），由 `config/devices.json` v2 选择；支持官服、B 服、国际服、日服、韩服、台服客户端。
- 画面：WebRTC 低延迟（H.264）与 WebSocket 回退、noVNC 兼容模式；显式控制租约。
- 带账号切换的预设：通过 MaaCore 日志确认登录账号，策略可选阻止或继续并标注风险。
- 只读 Bot API（`/api/v1/public/*`，令牌鉴权、限流）与 AstrBot 插件。
- Docker Compose 部署：基础文件与宿主机无关；`compose.usb.yaml`、`compose.proxy.yaml`、`compose.dri.yaml` 按需叠加；`deploy.sh` 下载并校验固定版本的 maa-cli 0.7.8 / MaaCore 6.21.4。

### 已知限制

- Bot API v1 的日期固定按 Asia/Tokyo 计算。
- 一个部署只管理一台设备；仅支持 Linux x86_64 宿主机。
- MaaCore 6.21.4 的终端底栏识别区域已按上游修复（v6.22.0-beta.2，#19179）在本地覆盖，升级到 6.22.0 及以上后应删除该覆盖。

### 从未公开的早期部署升级

- `config/devices.json` 的 `version: 1` 继续有效，无需修改。
- `MANAGER_TIME_ZONE` 的默认值为 `Asia/Shanghai`；此前固定为 `Asia/Tokyo` 的部署请在 `.env` 中设置 `MANAGER_TIME_ZONE=Asia/Tokyo`。
- `compose.yaml` 不再默认挂载 USB、`/dev/dri`，也不再加入外部 `proxy` 网络：USB 真机加入 `compose.usb.yaml`，原先依赖 `/dev/dri` 的部署加入 `compose.dri.yaml`，通过 Nginx Proxy Manager 访问的部署加入 `compose.proxy.yaml`，例如 `COMPOSE_FILE=compose.yaml:compose.usb.yaml:compose.dri.yaml:compose.proxy.yaml`。
