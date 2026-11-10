"""AstrBot Star plugin: MAA Web Manager queries, daily report and confirmed controls."""

from __future__ import annotations

import re
from datetime import date as date_cls
from pathlib import Path
from typing import Any

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, StarTools, register
from astrbot.core.message.components import Plain
from astrbot.core.message.message_event_result import MessageChain

from .maa.client import MaaApiError, MaaDailyClient
from .maa.control import ControlError, ControlService, ManagerControlClient
from .maa.formatter import (
    format_day,
    format_failures,
    format_help,
    format_schedules,
    format_status,
)
from .maa.jst import fmt_iso, shift_key, today_key
from .maa.scheduler import DailyReportScheduler, ReportConfig
from .maa.security import AuditLog, ConfirmationStore, PermissionPolicy
from .maa.state import JsonStateStore

PLUGIN_NAME = "astrbot_plugin_maa_manager"
CRON_NAME_PREFIX = "maa_daily_report:"
READ_COMMANDS = {"状态", "今日", "昨日", "失败", "排程", "帮助"}
ADMIN_COMMANDS = {"会话", "报告状态", "测试汇报"}
CONTROL_COMMANDS = {"运行", "暂停", "恢复", "取消", "确认"}
CONTROL_ACTIONS = {"运行": "run", "暂停": "pause", "恢复": "resume", "取消": "cancel"}


class _UnavailableClient:
    """Client stand-in so report/query paths can still produce a clear configuration error."""

    async def health(self) -> dict[str, Any]:
        raise MaaApiError("config")

    async def daily_status(self, date_key: str | None = None) -> dict[str, Any]:
        raise MaaApiError("config")


@register(
    PLUGIN_NAME,
    "IMito",
    "查询 MAA Manager 每日状态、定时推送日报，并在受控确认后执行队列操作",
    "v1.0.0",
)
class MaaManagerPlugin(Star):
    def __init__(self, context: Context, config: Any = None):
        super().__init__(context)
        self.cfg = config if config is not None else {}
        self.client: MaaDailyClient | _UnavailableClient | None = None
        self.control: ControlService | None = None
        self.scheduler: DailyReportScheduler | None = None
        self.store: JsonStateStore | None = None
        self.audit: AuditLog | None = None
        self.confirmations: ConfirmationStore | None = None
        self.policy = PermissionPolicy({})
        self.data_dir: Path | None = None
        self._client_error = ""
        self._control_error = ""
        self._cron_job_id = ""

    # ------------------------------------------------------------------ config
    def _conf(self, key: str, default: Any = None) -> Any:
        try:
            value = self.cfg.get(key, default)
        except Exception:
            value = default
        return default if value is None else value

    def _as_dict(self) -> dict[str, Any]:
        try:
            return dict(self.cfg)
        except Exception:
            return {}

    def _plugin_data_dir(self) -> Path:
        if self.data_dir is not None:
            return self.data_dir
        try:
            self.data_dir = Path(StarTools.get_data_dir(PLUGIN_NAME))
        except Exception:
            self.data_dir = Path(__file__).resolve().parent / "plugin_data"
            self.data_dir.mkdir(parents=True, exist_ok=True)
        return self.data_dir

    def _configured_sessions(self) -> list[str]:
        value = self._conf("report_sessions", [])
        if isinstance(value, str):
            value = [item.strip() for item in value.splitlines() if item.strip()]
        if not isinstance(value, list):
            return []
        seen: list[str] = []
        for item in value:
            text = str(item).strip()
            if text and text not in seen:
                seen.append(text)
        return seen

    # ------------------------------------------------------------------ lifecycle
    async def initialize(self) -> None:
        self.policy = PermissionPolicy(self._as_dict())
        data_dir = self._plugin_data_dir()
        self.audit = AuditLog(data_dir / "audit.jsonl")
        self.store = JsonStateStore(data_dir / "report_state.json")
        self.confirmations = ConfirmationStore(
            int(self._conf("control_confirm_ttl_seconds", 90) or 90)
        )
        try:
            self.client = MaaDailyClient.from_config(self._as_dict())
            self._client_error = ""
        except MaaApiError as error:
            self._client_error = error.user_message()
            self.client = _UnavailableClient()
            logger.warning("MAA plugin has no usable Daily API token: %s", error.kind)
        self._build_control()
        self._build_scheduler()
        if self.scheduler is not None:
            await self._register_cron_job()
        if bool(self._conf("enable_llm_tools", True)):
            for tool_name in ("maa_daily_status", "maa_queue_status"):
                try:
                    await self.context.activate_llm_tool_async(tool_name)
                except Exception as error:  # pragma: no cover - depends on core state
                    logger.warning(
                        "MAA plugin could not activate LLM tool %s: %s",
                        tool_name,
                        type(error).__name__,
                    )
        logger.info(
            "MAA manager plugin initialized (control=%s, report=%s, targets=%d)",
            bool(self._conf("control_enabled", False)),
            bool(self._conf("report_enabled", True)),
            len(self._configured_sessions()),
        )

    async def terminate(self) -> None:
        await self._remove_cron_job()
        logger.info("MAA manager plugin terminated")

    def _build_control(self) -> None:
        if not bool(self._conf("control_enabled", False)):
            self.control = None
            self._control_error = ""
            return
        try:
            control_client = ManagerControlClient(
                str(self._conf("control_base_url", "http://maa-manager-gateway:8080")),
                str(self._conf("control_origin", "https://maa.example.com")),
                float(self._conf("request_timeout_seconds", 12) or 12),
            )
            self.control = ControlService(
                control_client,
                self.policy,
                self.confirmations or ConfirmationStore(),
                self.audit or AuditLog(self._plugin_data_dir() / "audit.jsonl"),
            )
            self._control_error = ""
        except ControlError as error:
            self.control = None
            self._control_error = error.user_message()
            logger.warning("MAA plugin control disabled: %s", error.kind)

    def _build_scheduler(self) -> None:
        report_cfg = ReportConfig.from_config(self._as_dict())
        client = self.client or _UnavailableClient()
        self.scheduler = DailyReportScheduler(
            report_cfg,
            client,
            self.store or JsonStateStore(self._plugin_data_dir() / "report_state.json"),
            self._send_message,
            self.audit or AuditLog(self._plugin_data_dir() / "audit.jsonl"),
        )

    # ------------------------------------------------------------------ cron
    async def _register_cron_job(self) -> None:
        cfg = self.scheduler.cfg if self.scheduler else None
        if cfg is None:
            return
        try:
            jobs = await self.context.cron_manager.list_jobs()
        except Exception as error:
            logger.warning("MAA plugin cannot list cron jobs: %s", type(error).__name__)
            return
        for job in jobs:
            if str(getattr(job, "name", "")).startswith(CRON_NAME_PREFIX):
                try:
                    await self.context.cron_manager.delete_job(job.job_id)
                except Exception:
                    logger.warning(
                        "MAA plugin could not remove stale cron job %s",
                        getattr(job, "job_id", "?"),
                    )
        if not cfg.enabled or not cfg.sessions:
            logger.info(
                "MAA daily report not scheduled (enabled=%s, targets=%d)",
                cfg.enabled,
                len(cfg.sessions),
            )
            return
        try:
            job = await self.context.cron_manager.add_basic_job(
                name=f"{CRON_NAME_PREFIX}{PLUGIN_NAME}",
                cron_expression=cfg.cron_expression(),
                handler=self._scheduled_report,
                description=f"MAA daily report at {cfg.time_text()} Asia/Tokyo",
                timezone="Asia/Tokyo",
                enabled=True,
                persistent=False,
            )
            self._cron_job_id = str(job.job_id)
            if self.store is not None:
                self.store.update(job_id=self._cron_job_id)
            logger.info(
                "MAA daily report scheduled at %s Asia/Tokyo (job=%s)",
                cfg.time_text(),
                self._cron_job_id,
            )
        except Exception as error:
            logger.error(
                "MAA plugin could not schedule daily report: %s", type(error).__name__
            )

    async def _remove_cron_job(self) -> None:
        job_id = self._cron_job_id
        if not job_id:
            return
        try:
            await self.context.cron_manager.delete_job(job_id)
        except Exception:
            logger.warning("MAA plugin could not remove cron job %s", job_id)
        self._cron_job_id = ""

    async def _scheduled_report(self) -> None:
        if self.scheduler is None:
            return
        try:
            result = await self.scheduler.run()
            logger.info("MAA daily report finished: %s", result.get("status"))
        except Exception as error:  # pragma: no cover - defensive
            logger.error("MAA daily report raised: %s", type(error).__name__)

    def _next_run_text(self) -> str:
        if not self._cron_job_id:
            return "未调度（未启用或未配置接收会话）"
        try:
            value = self.context.cron_manager.get_next_run_time(self._cron_job_id)
        except Exception:
            return "未知"
        return fmt_iso(value.isoformat(), "%Y-%m-%d %H:%M") if value else "未知"

    # ------------------------------------------------------------------ sending
    async def _send_message(self, session: str, text: str) -> bool:
        try:
            chain = MessageChain([Plain(text)])
            result = await self.context.send_message(session, chain)
            return bool(result)
        except Exception as error:
            logger.warning("MAA plugin proactive send failed: %s", type(error).__name__)
            return False

    # ------------------------------------------------------------------ commands
    def _session(self, event: AstrMessageEvent) -> str:
        return str(getattr(event, "unified_msg_origin", "") or event.get_session_id())

    def _sender(self, event: AstrMessageEvent) -> str:
        return str(event.get_sender_id() or "")

    def _is_global_admin(self, event: AstrMessageEvent) -> bool:
        try:
            return bool(event.is_admin())
        except Exception:
            return False

    def _admin_allowed(self, event: AstrMessageEvent) -> bool:
        sender = self._sender(event)
        if sender and sender in self.policy.control_admin_ids:
            return True
        return self._is_global_admin(event)

    def _parse(self, text: str) -> tuple[str, list[str]]:
        raw = (text or "").strip()
        raw = re.sub(r"^[/!！。]+\s*", "", raw)
        match = re.match(r"(?i)^maa(?:\s+(.*))?$", raw)
        if match:
            rest = (match.group(1) or "").strip()
        else:
            rest = raw
        parts = rest.split() if rest else []
        return (parts[0] if parts else "帮助"), parts[1:]

    @filter.command("maa")
    async def maa_command(self, event: AstrMessageEvent):
        try:
            reply = await self._dispatch(event)
        except Exception as error:  # pragma: no cover - defensive
            logger.error("MAA plugin command failed: %s", type(error).__name__)
            reply = "MAA 插件处理失败；未执行写操作。请稍后重试或查看 AstrBot 日志。"
        yield event.plain_result(reply)

    async def _dispatch(self, event: AstrMessageEvent) -> str:
        command, args = self._parse(event.get_message_str())
        if command in ("帮助", "help", "HELP"):
            return format_help()
        session = self._session(event)
        sender = self._sender(event)
        is_admin = self._is_global_admin(event)
        if command in READ_COMMANDS:
            if not self.policy.query_allowed(sender, session, is_admin):
                return "当前会话未获授权查询 MAA 状态。"
            return await self._handle_query(command)
        if command in ADMIN_COMMANDS:
            if not self._admin_allowed(event):
                return "该命令仅限管理员使用。"
            return await self._handle_admin(command, session, sender)
        if command in CONTROL_COMMANDS:
            return await self._handle_control(event, command, args)
        return format_help()

    async def _handle_query(self, command: str) -> str:
        client = self.client
        if client is None:
            return self._client_error or "MAA API 客户端未初始化。"
        if command == "状态":
            try:
                health = await client.health()
            except MaaApiError as error:
                return format_status(None, None, error=error.user_message())
            try:
                daily = await client.daily_status()
            except MaaApiError as error:
                return format_status(health, None, error="")
            return format_status(health, daily)
        try:
            if command == "今日":
                return format_day(await client.daily_status(today_key()), "今日")
            if command == "昨日":
                return format_day(await client.daily_status(shift_key(today_key(), -1)), "昨日")
            if command == "失败":
                return format_failures(await client.daily_status(today_key()), include_detail=True)
            if command == "排程":
                return format_schedules(await client.daily_status(today_key()))
        except MaaApiError as error:
            return error.user_message()
        return format_help()

    async def _handle_admin(self, command: str, session: str, sender: str) -> str:
        if command == "会话":
            return (
                f"当前会话 unified_msg_origin：\n{session}\n"
                f"发送者 ID：{sender}（仅管理员可见，请勿在群内公开）\n"
                "将该 UMO 填入插件配置的 report_sessions 即可作为日报目标。"
            )
        if command == "报告状态":
            if self.scheduler is None:
                return "日报调度未初始化。"
            return self.scheduler.status_text(self._next_run_text(), self._cron_job_id)
        if command == "测试汇报":
            if self.scheduler is None:
                return "日报调度未初始化。"
            result = await self.scheduler.run(manual=True, force=True)
            status = result.get("status")
            if status in ("success", "partial", "failed"):
                return (
                    f"受控测试汇报：{status}（送达 {result.get('sent')}/{result.get('total')} 个会话，日期 {result.get('date')}）。\n"
                    "测试汇报不会占用正式日报的“已发送”去重日期。"
                )
            reason = result.get("reason") or result.get("error") or "未知"
            return f"受控测试汇报未发送：{reason}"
        return "未知管理命令。"

    async def _handle_control(
        self, event: AstrMessageEvent, command: str, args: list[str]
    ) -> str:
        if self.control is None:
            return self._control_error or "控制功能未启用或控制接口未配置。"
        session = self._session(event)
        sender = self._sender(event)
        is_admin = self._is_global_admin(event)
        if command == "确认":
            token = args[0] if args else ""
            if not token:
                return "用法：/maa 确认 <令牌>"
            _ok, message = await self.control.confirm(sender, session, token, is_admin)
            return message
        action = CONTROL_ACTIONS.get(command)
        if action is None:
            return format_help()
        target = " ".join(args).strip() or None
        _ok, message = await self.control.propose(sender, session, action, target, is_admin)
        return message

    # --------------------------------------------------------------- LLM tools
    @filter.llm_tool(name="maa_daily_status")
    async def maa_daily_status(
        self, event: AstrMessageEvent, date: str = "today", preset: str = ""
    ) -> str:
        """查询 MAA 某天的执行情况（只读）。

        Args:
            date(string): today、yesterday 或 YYYY-MM-DD；默认 today。
            preset(string): 可选，按预设名/任务名过滤。
        """
        if not self._tool_query_allowed(event):
            return "当前会话未获授权查询 MAA 状态。"
        return await self._tool_daily(date, preset)

    @filter.llm_tool(name="maa_queue_status")
    async def maa_queue_status(self, event: AstrMessageEvent) -> str:
        """查询 MAA 队列、设备健康与下一次排程（只读）。"""
        if not self._tool_query_allowed(event):
            return "当前会话未获授权查询 MAA 状态。"
        client = self.client
        if client is None:
            return self._client_error or "MAA API 客户端未初始化。"
        try:
            health = await client.health()
            daily = await client.daily_status()
        except MaaApiError as error:
            return error.user_message()
        return format_status(health, daily)

    def _tool_query_allowed(self, event: AstrMessageEvent) -> bool:
        try:
            return self.policy.query_allowed(
                self._sender(event), self._session(event), self._is_global_admin(event)
            )
        except Exception:
            return False

    async def _tool_daily(self, date: str, preset: str = "") -> str:
        client = self.client
        if client is None:
            return self._client_error or "MAA API 客户端未初始化。"
        text_date = (date or "today").strip().lower()
        if text_date in ("today", "今天", ""):
            key = today_key()
        elif text_date in ("yesterday", "昨天"):
            key = shift_key(today_key(), -1)
        else:
            try:
                key = date_cls.fromisoformat(text_date).isoformat()
            except ValueError:
                return "日期格式无效：请使用 today、yesterday 或 YYYY-MM-DD。"
        try:
            data = await client.daily_status(key)
        except MaaApiError as error:
            return error.user_message()
        wanted = (preset or "").strip().lower()
        if wanted:
            presets = [item for item in (data.get("presets") or []) if isinstance(item, dict)]
            filtered = [
                item
                for item in presets
                if wanted in str(item.get("task") or "").lower()
                or wanted in str(item.get("displayName") or "").lower()
            ]
            data = dict(data)
            data["presets"] = filtered
            if not filtered:
                return f"没有找到匹配的预设：{preset}"
        return format_day(data, "今日" if key == today_key() else key)
