# media

把设备画面以低延迟分发给浏览器的 Go 服务。设计说明见 [Android 低延迟画面](../../docs/android-streaming.md)。

- 通过 `device` 容器的 ADB 服务（`MEDIA_ADB`，默认 `device:5037`）直接使用 ADB 协议，不创建 `adb forward`；只使用 `DEVICE_CONFIG` 中配置的那一台设备，USB 与网络 ADB 都支持，自身从不打开设备连接。
- 每个画质档位一个 scrcpy-server 实例，按需启动、无人观看后停止；视频经 WebRTC 发送，失败时回退到经 portal 的 WebSocket（H.264 + WebCodecs）。
- 输入只在 Manager 确认当前浏览器持有控制租约时接受。

| 文件 | 内容 |
| --- | --- |
| `adb.go` | ADB 协议客户端、设备列表解析与绑定 |
| `scrcpy.go` | scrcpy-server 推送、启动与视频/控制流 |
| `hub.go` | 档位实例的生命周期与扇出（`Device` / `Capture` 接口，可用 Fake 测试） |
| `session.go` | 单个浏览器会话的信令、WebRTC 与 WebSocket 回退 |
| `control.go` | 控制权校验与输入注入 |
| `main.go` | 配置读取与 HTTP 入口 |
| `tools/fakeadb`、`tools/probe` | 测试用假 ADB 服务器、无界面测量客户端 |

```bash
go test ./...
```
