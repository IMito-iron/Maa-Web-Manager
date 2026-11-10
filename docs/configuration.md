# 配置参考

所有部署相关的配置都在三处，业务代码中不包含任何主机、设备或时区的硬编码值：

| 位置 | 作用 |
| --- | --- |
| `.env` | 部署参数（由 `.env.example` 复制），Compose 读取 |
| `config/devices.json` | 要管理的设备（由 `config/devices.example.json` 或 `config/devices.tcp.example.json` 复制） |
| `COMPOSE_FILE` 中的叠加文件 | 宿主机资源（USB、GPU）与网络接入方式 |

`.env` 和 `config/devices.json` 已在 `.gitignore` 中，不会被提交。

## Compose 叠加文件

`compose.yaml` 本身与宿主机无关：不挂载 USB、不需要特定的用户组、不依赖外部 Docker 网络，网关只发布在 `127.0.0.1:8080`。按需在 `.env` 的 `COMPOSE_FILE` 中追加（Linux 用 `:` 分隔）：

| 文件 | 何时使用 | 内容 |
| --- | --- | --- |
| `compose.usb.yaml` | `transport: "usb"` | `/dev/bus/usb`、USB 设备 cgroup 规则（`c 189:*`）、`USB_GID` 组 |
| `compose.proxy.yaml` | 已有 Nginx Proxy Manager 等反向代理容器 | 网关加入 `PROXY_NETWORK`，别名 `maa-manager-gateway`，不再发布端口 |
| `compose.dri.yaml` | 可选 | `/dev/dri` 与 `VIDEO_GID`/`RENDER_GID`；画面是软件解码，一般不需要 |

`compose.proxy.yaml` 使用了 `!reset`，需要 Docker Compose v2.24 或更高版本。

## `.env`

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `COMPOSE_FILE` | `compose.yaml:compose.usb.yaml` | 见上表 |
| `PUBLIC_ORIGIN` | —（必填） | 浏览器访问的精确 origin。一般必须是 `https://`；只有 `http://localhost:<端口>` 与 `http://127.0.0.1:<端口>` 允许使用 http。所有写请求都要求 `Origin` 与之完全一致 |
| `BIND_ADDRESS` / `HTTP_PORT` | `127.0.0.1` / `8080` | 网关发布地址（未使用 `compose.proxy.yaml` 时） |
| `PROXY_NETWORK` | `proxy` | `compose.proxy.yaml` 加入的外部网络 |
| `MANAGER_TIME_ZONE` | `Asia/Shanghai` | IANA 时区。决定调度触发时间、基建计划的“本地时间”和页面上显示的所有时间。非法值会让 Manager 启动失败 |
| `DATA_ROOT` | `./data` | 所有持久数据的根目录，见下文 |
| `ADB_KEY_DIR` | `./data/adb-keys` | `device` 容器出示给设备的 ADB 密钥；保持不变可避免重复授权 |
| `LOG_RETENTION_DAYS` / `LOG_LIMIT_BYTES` | `30` / `10485760` | 运行日志保留天数 / 单次运行日志上限 |
| `USB_GID` | `46` | `compose.usb.yaml`：可打开 USB 设备节点的宿主机组（Debian/Ubuntu 的 plugdev） |
| `VIDEO_GID` / `RENDER_GID` | `44` / `990` | `compose.dri.yaml` 使用 |
| `SANITY_FALLBACK_STAGE` | `LS-6` | 还没有从成功运行中学到“剩余理智”关卡时使用的关卡 |
| `ACCOUNT_IDENTITY_POLICY` | `require-verified` | 带账号切换的预设：无法确认当前登录账号时 `require-verified` 阻止运行；`warn-continue` 继续执行并在运行记录中标注风险 |
| `MEDIA_ICE_PORT` | `8189` | WebRTC 使用的 UDP+TCP 端口，会发布到宿主机 |
| `MEDIA_HOST_IPS` | 空（自动） | 作为 ICE 候选公布的本机地址，逗号分隔 |
| `MEDIA_PUBLIC_IPS` | `auto` | 公网地址；`auto` 通过 STUN 获取，留空表示不公布 |
| `MEDIA_IDLE_STOP_SEC` | `15` | 无人观看多少秒后停止画面编码 |
| `BOT_DAILY_API_TOKEN` / `BOT_DAILY_API_TOKEN_FILE` | 空 | 只读 Bot API 令牌；为空时接口返回 503。推荐使用挂载的文件 |
| `BOT_DAILY_*` 其余项 | 见 `.env.example` | 回溯天数、数据陈旧阈值、限流 |

Manager 进程还识别以下变量（一般不需要修改）：`MAA_API_URLS`（活动关卡数据源，`off` 关闭）、`MAA_STAGE_ACTIVITY_FILE`、`MAA_BATTLE_DATA_FILE`。

## `config/devices.json`

```json
{
  "version": 2,
  "transport": "usb",
  "serial": "ABC123",
  "packageName": "com.hypergryph.arknights",
  "display": {"width": 1280, "height": 720, "naturalOrientation": "auto", "density": 240,
              "dark": true, "darkMode": "turn-screen-off", "brightness": 0, "reassertMs": 30000}
}
```

| 字段 | 说明 |
| --- | --- |
| `version` | `2`。旧的 `1` 仍然有效，但只支持 `usb` 与官服包名 |
| `transport` | `usb` 或 `tcp` |
| `serial` | `usb` 必填：`adb devices` 中的 serial（字母、数字、`_`、`-`） |
| `address` | `tcp` 必填：`host:port`，主机名或 IPv4，端口 1–65535 |
| `packageName` | 可选，默认官服。可选值见 [设备连接 · 支持的客户端](devices.md#支持的客户端) |
| `display.width` / `height` | 游戏画面分辨率，必须是 16:9 横屏（720–3840 × 360–2160） |
| `display.naturalOrientation` | `auto`（根据 `wm size` 判断）、`portrait`、`landscape` |
| `display.density` | 120–640，通过 `wm density` 写入设备 |
| `display.dark` / `darkMode` | 是否在运行时熄屏；`turn-screen-off`（scrcpy 关闭显示，LCD 也能真正变黑）、`brightness-zero`、`none` |
| `display.brightness` / `reassertMs` | 熄屏亮度与重新确认间隔（5000–300000 ms） |

同一份校验逻辑（`apps/server/src/device-policy.js`）被 Manager、`device` 容器的 supervisor 和 `deploy.sh` 共用，media 服务（Go）中有对应实现，并由各自的测试保证一致。

## 数据目录

`DATA_ROOT` 下的目录由 `scripts/prepare-data.py` 创建并设置权限：

| 目录 | 容器内路径 | 内容 |
| --- | --- | --- |
| `manager/` | manager `/data` | SQLite（运行、调度）、运行日志、执行快照、缓存与状态（活动关卡、信用商店记录） |
| `config/` | manager `/config` | maa-cli 配置：`profiles/`、预设 `tasks/*.json`、资源覆盖 `resource/` |
| `hot-update/` | manager `/opt/maa/share/MaaResource` | MAA 资源热更新缓存 |
| `control/`、`control-state/` | 多个容器 | Manager 的控制 socket（权限 0600）与控制租约状态 |
| `display-stats/` | device `/stats` | 画面 supervisor 发布的状态 |
| `portal/` | portal `/data` | portal 自身的数据库 |
| `adb-keys/`（`ADB_KEY_DIR`） | device `/root/.android` | ADB 密钥（权限 0700） |
| `android/` | redroid `/data` | 仅 `redroid` profile 使用 |

备份包含游戏登录状态与 ADB 密钥，请存放在私有位置。

## 调度表达式

所有调度在 `MANAGER_TIME_ZONE` 时区下计算：

| 类型 | 示例 | 含义 |
| --- | --- | --- |
| daily | `05:10` | 每天 05:10 |
| weekly | `0,6 02:00` | 每周日、周六 02:00（0 = 周日） |
| interval | `360` | 从启用起每 360 分钟 |
| cron | `10 5 * * *` | 五段 cron |

修改调度会重置下一次触发时间。服务暂停或离线期间错过的触发不会补跑；设备不可用时已入队的运行保持排队。

## 已知限制

- **Bot API v1 固定使用 Asia/Tokyo。** `/api/v1/public/*` 的契约（`contracts/bot-daily-api.openapi.json`）以 `+09:00` 的自然日为单位。`MANAGER_TIME_ZONE` 设为其他时区时接口仍可用，但“当日计划”与实际调度的日期边界会错开，Manager 启动时会打印警告。
- 一个部署只管理一台设备。
- MaaCore 与资源版本由 `runtime.lock.json` 固定；`config/maa-resource/tasks/manager.json` 中有针对该版本的少量任务覆盖，来源与移除条件记录在 `apps/server/test/maa-resource.test.ts`。
