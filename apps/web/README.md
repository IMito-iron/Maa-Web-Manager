# @maa/web

React + Vite 控制台。构建产物（`dist/`）打包进 portal 与 manager 两个镜像：浏览器经 gateway 访问的是 portal 提供的静态文件；manager 也能直接提供（开发与 `RUNNER_SOCKET_ONLY` 之外的场景）。

| 文件 | 内容 |
| --- | --- |
| `src/main.tsx` | 页面框架：总览、任务配置、调度、历史、Android |
| `src/TaskConfig.tsx`、`WindowsTaskForm.tsx`、`taskSchema.ts`、`taskEditor.ts` | 预设编辑：Windows 风格表单（由 `maaModel.ts` 引用服务端的 `maa-model`）与原始 JSON 模式 |
| `src/SchedulePanel.tsx`、`schedule.ts` | 调度编辑与预览 |
| `src/RunDrawer.tsx` | 运行详情与实时日志（SSE） |
| `src/DevicePanel.tsx`、`AndroidPanel.tsx`、`mediaClient.ts`、`streamInput.ts`、`vncFit.ts` | 设备画面：WebRTC / WebSocket 低延迟模式与 noVNC 兼容模式、控制租约 |
| `src/i18n.ts`、`i18n.tsx`、`I18nContext.tsx` | 中文（默认）与日文 |
| `src/timeZone.ts` | 使用服务器报告的调度时区显示所有时间 |

所有写请求都带 `X-Maa-Request: 1` 与 JSON 内容类型，由 portal 做同源校验（`src/api.ts`）。

```bash
npm run build -w @maa/web
npm test -w @maa/web           # 单元测试 + 界面文本日文覆盖检查
```

开发时可以 `npx vite` 启动开发服务器，并把 `/api` 代理到一个运行中的 portal。`integration/classic-ui.mjs` 是可选的浏览器级测试，见 `integration/README.md`。
