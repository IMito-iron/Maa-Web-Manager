# astrbot_plugin_maa_manager

AstrBot 插件：通过聊天查询 MAA Web Manager 的每日执行情况、定时推送日报，并在**显式二次确认**后执行受控的队列操作。

## 功能

- `/maa 状态`：服务健康、队列、当前运行、下次排程、每个预设的当日汇总
- `/maa 今日`、`/maa 昨日`：按 Asia/Tokyo 自然日列出每个预设的计划与实际运行（支持一天多次运行、成功/失败/运行中/等待/取消/结果未确认）
- `/maa 失败`：当天失败与未确认运行的脱敏摘要
- `/maa 排程`：所有调度的启用状态、表达式、下次触发与当日 occurrence 状态
- 每日定时汇报（默认 23:00 Asia/Tokyo），直接格式化 Daily API，不经过大模型；失败重试、按日去重、重启恢复、不补发过期报告
- 可选控制：`/maa 运行 <预设>`、`/maa 暂停`、`/maa 恢复`、`/maa 取消 <运行ID>`
  - 默认**关闭**，且必须配置管理员用户 ID 白名单
  - 所有写操作都需要 `/maa 确认 <令牌>` 二次确认，令牌一次性、短期有效、绑定用户+会话+操作+目标
  - 控制流量只走内部网络地址（默认 `http://maa-manager-gateway:8080`），不会走公网
- 自然语言：仅注册**只读** LLM 工具 `maa_daily_status` / `maa_queue_status`；写操作不会暴露给模型

## 配置

在 AstrBot 插件配置页面填写，敏感项 `maa_api_token` 不会写入日志：

- `maa_api_base`、`maa_api_token`（或 `maa_api_token_file`）
- 查询：`query_admin_only`、`query_allowed_sessions`
- 汇报：`report_enabled`、`report_time`、`report_sessions`、失败详情/仅活动时/失败告警/重试
- 控制：`control_enabled`、`control_base_url`、`control_admin_ids`、`control_allowed_sessions`、确认有效期
- 获取会话 UMO：在与机器人聊天中执行 `/maa 会话`（仅管理员）

## 指令

```text
/maa 状态 | 今日 | 昨日 | 失败 | 排程 | 帮助
/maa 会话                      # 管理员：显示当前会话 unified_msg_origin
/maa 报告状态                  # 管理员：日报配置、上次结果、下次触发
/maa 测试汇报                  # 管理员：立即发送一次受控测试日报（不写入“已发送”去重日期）
/maa 运行 <预设文件id>          # 管理员：生成二次确认令牌
/maa 暂停 | 恢复 | 取消 <runId> # 管理员：生成二次确认令牌
/maa 确认 <令牌>                # 管理员：执行待确认操作（一次性）
```

## 数据与安全

- 只读数据来自 `GET /api/v1/public/health` 与 `/daily-status`（独立 Bearer Token）
- 不在群消息中输出账号登录名、Token、设备序列号、原始日志或完整配置
- 控制请求失败不盲目重试；超时先查询实际状态再决定
- 审计记录写入插件目录 `plugin_data/astrbot_plugin_maa_manager/audit.jsonl`，用户/会话已哈希脱敏

## 已知限制

- 控制依赖 Manager 的内部 HTTP 入口（gateway→portal）；Manager 本身无公网控制端口
- 账号身份由 Manager 侧策略决定；本插件把结果中的 `identityConfirmation` 如实显示为 `unavailable`，不视为已验证
- 如果 AstrBot 与 MAA Manager 不在同一可互通内网，控制功能应保持关闭
