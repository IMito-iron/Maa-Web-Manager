# 开发

## 仓库结构

```
apps/
  server/      NestJS Manager（API、队列、调度、MAA 执行）与 portal；Prisma/SQLite
    src/maa-model/   与 MAA Windows GUI 对齐的任务模型（纯 TypeScript，前后端共用）
  web/         React + Vite 控制台
  media/       Go：scrcpy 画面经 WebRTC / WebSocket 分发
astrbot_plugin_maa_manager/   AstrBot 插件（Python），使用只读 Bot API 与控制 API
config/        设备配置示例、随镜像安装的 MaaCore 资源覆盖
contracts/     Bot API 的 OpenAPI 契约
docker/        各服务的 Dockerfile 与 nginx 配置
scripts/       部署、容器入口、设备 supervisor、测试用假 CLI
compose*.yaml  基础编排与叠加文件
```

## 环境

- Node.js 22、npm（workspaces）
- Go（版本见 `apps/media/go.mod`，`go` 会自动下载工具链）
- Python 3.11+（部署脚本、AstrBot 插件测试）
- Docker（只在构建镜像、运行 Linux 集成测试时需要）

## 构建与测试

```bash
npm ci
npm run generate            # Prisma client
npm run build               # web + server
npm test                    # server 与 web 单元测试
(cd apps/media && go test ./...)
python -m pytest astrbot_plugin_maa_manager/tests
```

单元测试不需要设备、ADB、MaaCore 或网络：设备通过 `DevicePort` 的 Fake 注入，maa-cli 用 Node 假进程代替，MAA API 用本地夹具。

Linux 上还有一个用假 maa-cli / 假 adb 跑真实 Manager 进程的集成测试（会启动服务、执行任务、重启后检查中断与暂停）：

```bash
npm run build && bash scripts/test-linux.sh
```

`apps/web/integration/classic-ui.mjs` 是可选的浏览器级测试，用 Fake 设备启动真实的 Manager 与 portal，说明见 `apps/web/integration/README.md`。

### 修改任务模型

`apps/server/src/maa-model/form-spec.generated.ts` 由 `scripts/build-form-spec.cjs` 根据 MAA Windows GUI 的界面结构生成，不要手动编辑。任务的编译规则在 `compile.ts`，每个任务一个函数，对应 MAA Windows 中同名任务的序列化逻辑；新增或修改时请在 `apps/server/test/maa-model.test.ts` 中补充与 Windows 生成结果对比的用例。

### 界面文本

控制台默认中文，另有日文。`apps/web/src/i18n.test.ts` 会检查源码中每一个中文字符串（包括引号内的注释）都有日文翻译；新增文本时请同时在 `apps/web/src/i18n.ts` 中添加。

## 约定

- 依赖方向指向核心：`maa-model/`、`domain.ts`、`device-policy.js` 等纯模块不做 I/O；外部依赖（ADB、文件、数据库、HTTP、子进程）经由接口或适配器注入，以便在测试中替换。详见 [架构](architecture.md#关键契约与替换点)。
- 不在业务代码中写入主机名、设备标识、路径或时区；新增配置项放在 `config.ts`（或专门的解析模块）并写入 `.env.example` 与 [配置参考](configuration.md)。
- 外部进程使用固定可执行文件与参数数组，不拼接 shell 命令；文件读取设大小上限，写入用临时文件 + 原子重命名。
- 修改公开接口（REST、Bot API、`devices.json`、预设格式）时保持向后兼容，或在 CHANGELOG 中写明迁移方式。
- 修复缺陷时补充回归测试。
