# 部署与运维

## 要求

- Linux x86_64（MaaCore 的 Linux 构建只提供 x86_64）
- Docker Engine 与 Docker Compose v2.24 或更高版本
- 至少 8 GiB 可用磁盘（镜像约 3 GiB，另有资源、日志与缓存）
- 一台设备：USB 真机或网络 ADB 设备，见 [设备连接](devices.md)
- 能访问 GitHub（首次下载 maa-cli / MaaCore）与 MAA API（资源热更新、活动关卡数据）

## 安装

```bash
git clone https://github.com/IMito-iron/Maa-Web-Manager.git
cd Maa-Web-Manager
cp .env.example .env                     # 至少确认 PUBLIC_ORIGIN、COMPOSE_FILE、MANAGER_TIME_ZONE
cp config/devices.example.json config/devices.json        # USB；网络 ADB 用 devices.tcp.example.json
bash deploy.sh
```

`deploy.sh` 依次完成：

1. 检查 `.env` 与 `config/devices.json`（用与 Manager 相同的规则校验），根据 `transport` 检查 USB 总线与 `compose.usb.yaml` 是否就绪。
2. `vendor/maa-runtime.tar.gz` 不存在时，按 `runtime.lock.json` 下载官方 maa-cli 与 MaaCore，校验 SHA-256 后打包（`scripts/fetch-runtime.py`）。
3. 检查磁盘空间，`docker compose config` 校验配置，`scripts/prepare-data.py` 创建数据目录并设置权限。
4. 构建镜像；USB 模式下释放宿主机 adb 对手机的占用。
5. `docker compose up -d`。

启动后打开 `PUBLIC_ORIGIN`。**首次启动与每次 Manager 重启后队列都处于暂停状态**，确认设备与 MAA 状态正常后点击“恢复派发”（或 `docker compose exec manager maa-managerctl resume`），调度才会开始触发。

全新的设备需要先自行安装并登录游戏。

## 服务一览

| 服务 | 作用 | 对外 |
| --- | --- | --- |
| `gateway` | nginx 入口 | `BIND_ADDRESS:HTTP_PORT`，或经 `compose.proxy.yaml` 加入代理网络 |
| `portal` | 同源校验、控制 cookie、转发 API / 画面 / 媒体 | 无 |
| `manager` | API、队列、调度、maa-cli/MaaCore 执行 | 无（只监听 UNIX socket） |
| `device` | ADB 服务、scrcpy 画面、noVNC、设备 supervisor | 无 |
| `display-proxy` | noVNC 的内部代理 | 无 |
| `media` | WebRTC / WebSocket 低延迟画面 | `MEDIA_ICE_PORT` UDP+TCP |
| `android` | redroid，仅 `redroid` profile | 无 |

除 `device`（ADB 需要以 root 运行，但已 `cap_drop: ALL`）外，所有服务都以 UID 1000 运行、移除全部 capabilities、启用 `no-new-privileges`，并且都不挂载 Docker socket。

## 反向代理

控制台**没有账号体系**：任何能访问网页的人都能编辑任务、操作设备。远程访问时必须在网关前放置带认证的反向代理（HTTP Basic、OAuth2 Proxy、Nginx Proxy Manager 的 Access List、Cloudflare Access 等）。

- 代理需要支持 WebSocket（日志 SSE、noVNC、媒体回退通道都会用到），并原样转发 `Host` 与 `Origin`。
- `PUBLIC_ORIGIN` 设为浏览器中看到的 `https://` 地址。
- 若代理本身也是 Compose 容器：在 `COMPOSE_FILE` 中加入 `compose.proxy.yaml`，把 `PROXY_NETWORK` 设为代理所在的网络，上游填 `http://maa-manager-gateway:8080`。网关此时不再发布宿主机端口。
- 若代理在宿主机上（如系统 nginx/Caddy）：保持默认的 `127.0.0.1:8080`，代理到该地址即可。
- WebRTC 画面使用 `MEDIA_ICE_PORT`，不经过反向代理；远程使用时需要在防火墙放行该 UDP/TCP 端口，否则页面会自动回退到经过代理的 WebSocket 通道。

## 更新

1. 页面上暂停队列，等待或停止正在运行的任务。
2. 备份（见下文）。
3. `git pull`，查看 [CHANGELOG](../CHANGELOG.md) 中的迁移说明。
4. `bash deploy.sh`。数据库迁移在 Manager 启动时自动执行。
5. 检查状态后恢复派发。

`runtime.lock.json` 变化时删除 `vendor/maa-runtime.tar.gz` 再部署，才会下载新版本的 MaaCore。不要自动更新 MaaCore：新版本的识别资源可能改变任务行为。

`docker compose down` 不会删除绑定挂载的数据；不要对整个 Docker 执行 `prune`。保留上一版镜像（`docker tag`）以便回滚。

## 备份与恢复

1. 暂停队列、停止运行中的任务，然后 `docker compose stop`。
2. 归档 `DATA_ROOT`、`.env`、`config/devices.json`、`vendor/` 与当前代码版本。保留 SQLite 的 `-wal`/`-shm` 文件；不要单独复制正在运行中的数据库。
3. 恢复时放到一个新的空目录，保持文件属主（manager/portal 为 UID 1000，`adb-keys` 为 root），使用相同版本的镜像启动，确认设备与 API 正常后再开放访问。

备份中包含游戏登录状态、ADB 密钥和 Bot API 令牌，请私密保存。redroid 的数据目录绝不能同时被两个 Android 实例挂载。

## 运维命令

```bash
docker compose ps
docker compose logs -f manager device portal media
docker compose exec manager maa-managerctl status          # 设备、MAA、画面健康状态（JSON）
docker compose exec manager maa-managerctl queue
docker compose exec manager maa-managerctl pause | resume
docker compose exec manager maa-managerctl run <预设名>
docker compose exec manager maa-managerctl stop <运行 ID>
```

所有自动化都应通过 Manager 的队列执行。直接在容器里运行 `maa` 只用于诊断，并且应先暂停队列，避免两个 MAA 进程同时操作设备。
