# @maa/server

Manager 与 portal 两个 Node 进程，共用一个包。

| 入口 | 进程 | 作用 |
| --- | --- | --- |
| `src/main.ts` | manager | NestJS API（`/api/*`）、SSE 日志、执行队列与调度、只读 Bot API（`/api/v1/public/*`）。监听 `RUNNER_SOCKET` 指定的 UNIX socket；`RUNNER_SOCKET_ONLY=1`（Compose 中的设置）时不再监听 TCP `PORT` |
| `src/portal.ts` | portal | 浏览器面对的后端：同源校验、控制 cookie、转发 API / noVNC / 媒体 WebSocket |
| `src/sequence-main.ts` | 子进程 | 按顺序执行一个运行中的多个 maa-cli 文档，并在需要时确认登录账号 |

## 目录

| 路径 | 层 | 内容 |
| --- | --- | --- |
| `src/maa-model/` | Domain | 与 MAA Windows GUI（v6.21.4）对齐的任务模型：默认值、表单规格、每个任务的参数编译、关卡开放、旧预设迁移。纯 TypeScript，`apps/web` 也直接引用 |
| `src/domain.ts`、`execution-plan.ts`、`account-safety.ts`、`device-policy.js`、`time-zone.ts` | Domain | 预设校验、调度时间、执行计划、账号确认策略、设备配置与绑定规则 |
| `src/engine.ts`、`sequence.ts` | Application | 队列、派发、运行生命周期、多文档执行 |
| `src/public-api/` | Application + Presentation | 只读 Bot API（契约：`contracts/bot-daily-api.openapi.json`） |
| `src/device.ts`、`store.ts`、`maa-runtime.ts`、`stage-activity.ts`、`mall-history.ts`、`core-log-identity-probe.ts`、`sanity.ts` | Infrastructure | ADB、预设文件与 SQLite、MaaCore 资源、MAA API、状态文件、Core 日志 |
| `prisma/` | Infrastructure | SQLite 结构与迁移（容器启动时自动 `migrate deploy`） |
| `src/auth/`、`workspace/`、`lease/`、`automation/` | — | 早期多用户方案的模块，当前未接入（`automation/recovery.ts` 除外） |

## 开发

```bash
npm run generate -w @maa/server
npm run build -w @maa/server
npm test -w @maa/server
```

在本机直接运行 Manager 需要 Linux 版的 maa-cli 与 MaaCore；没有设备时可以用 `scripts/fake-maa.sh` 与 `scripts/fake-adb.sh` 代替（`scripts/test-linux.sh` 演示了完整的环境变量）。主要环境变量见 `src/config.ts` 与 [配置参考](../../docs/configuration.md)。
