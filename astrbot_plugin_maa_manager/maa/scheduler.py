"""Daily report scheduler: dedupe, restart recovery, no stale backfill, bounded retries."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any, Awaitable, Callable

from .client import MaaApiError
from .formatter import format_report
from .jst import fmt_iso, now_jst, parse_clock, scheduled_datetime, today_key
from .security import AuditLog
from .state import JsonStateStore

SendFunc = Callable[[str, str], Awaitable[bool]]


@dataclass(slots=True)
class ReportConfig:
    enabled: bool = True
    hour: int = 23
    minute: int = 0
    sessions: list[str] = field(default_factory=list)
    include_failure_detail: bool = True
    only_when_activity: bool = True
    failure_alert: bool = True
    retries: int = 2
    retry_delay: float = 3.0

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> "ReportConfig":
        hour, minute = parse_clock(config.get("report_time"), "23:00")
        sessions = config.get("report_sessions") or []
        if isinstance(sessions, str):
            sessions = [item.strip() for item in sessions.splitlines() if item.strip()]
        retries = int(config.get("report_retry_times") or 0)
        return cls(
            enabled=bool(config.get("report_enabled", True)),
            hour=hour,
            minute=minute,
            sessions=[str(item).strip() for item in sessions if str(item).strip()],
            include_failure_detail=bool(config.get("report_include_failure_detail", True)),
            only_when_activity=bool(config.get("report_only_when_activity", True)),
            failure_alert=bool(config.get("report_failure_alert", True)),
            retries=max(0, min(3, retries)),
            retry_delay=3.0,
        )

    def cron_expression(self) -> str:
        return f"{self.minute} {self.hour} * * *"

    def time_text(self) -> str:
        return f"{self.hour:02d}:{self.minute:02d}"


class DailyReportScheduler:
    def __init__(
        self,
        config: ReportConfig,
        client: Any,
        store: JsonStateStore,
        send: SendFunc,
        audit: AuditLog,
        clock: Callable[[], Any] = now_jst,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        build_report: Callable[..., str | None] = format_report,
    ):
        self.cfg = config
        self.client = client
        self.store = store
        self.send = send
        self.audit = audit
        self.clock = clock
        self.sleep = sleep
        self.build_report = build_report
        self._lock = asyncio.Lock()

    # ---------------------------------------------------------------- state
    @property
    def state(self) -> dict[str, Any]:
        return self.store.data

    async def run(self, manual: bool = False, force: bool = False) -> dict[str, Any]:
        """Run once. ``manual`` is used by the admin test command (still deduped unless force)."""
        async with self._lock:
            now = self.clock()
            today = today_key(now)
            if not self.cfg.enabled and not manual and not force:
                return self._skip("disabled", today)
            if not force and self.state.get("last_sent_date") == today:
                return self._skip("duplicate", today)
            scheduled = scheduled_datetime(now, self.cfg.hour, self.cfg.minute)
            if not manual and not force:
                if now > scheduled + timedelta(hours=6):
                    return self._skip("stale", today)
            try:
                daily = await self.client.daily_status(today)
            except MaaApiError as error:
                message = error.user_message()
                self.store.update(
                    last_result="failed",
                    last_error=message,
                    last_run_at=fmt_iso(now.isoformat()),
                )
                self.audit.record("report", "system", "scheduled", today, "failed", detail=error.kind)
                return {"status": "failed", "date": today, "error": message, "sent": 0, "total": len(self.cfg.sessions)}
            try:
                text = self.build_report(
                    daily,
                    include_failure_detail=self.cfg.include_failure_detail,
                    only_when_activity=self.cfg.only_when_activity and not manual,
                )
            except Exception as error:  # pragma: no cover - defensive
                message = f"日报格式化失败：{type(error).__name__}"
                self.store.update(last_result="failed", last_error=message, last_run_at=fmt_iso(now.isoformat()))
                self.audit.record("report", "system", "scheduled", today, "failed", detail=type(error).__name__)
                return {"status": "failed", "date": today, "error": message, "sent": 0, "total": len(self.cfg.sessions)}
            if text is None:
                self.store.update(last_result="skipped", last_error="", last_run_at=fmt_iso(now.isoformat()))
                self.audit.record("report", "system", "scheduled", today, "skipped", detail="no_activity")
                return {"status": "skipped", "reason": "no_activity", "date": today, "sent": 0, "total": len(self.cfg.sessions)}

            sessions = self._dedupe_sessions(self.cfg.sessions)
            if not sessions:
                message = "未配置日报接收会话（report_sessions）"
                self.store.update(last_result="failed", last_error=message, last_run_at=fmt_iso(now.isoformat()))
                self.audit.record("report", "system", "scheduled", today, "failed", detail="no_sessions")
                return {"status": "failed", "date": today, "error": message, "sent": 0, "total": 0}

            results = await self._send_all(sessions, text)
            sent = sum(1 for ok in results.values() if ok)
            total = len(results)
            result = "success" if sent == total else ("partial" if sent else "failed")
            update: dict[str, Any] = {
                "last_result": ("manual_" if manual else "") + result,
                "last_run_at": fmt_iso(now.isoformat()),
                "last_error": "" if sent else "所有目标会话发送失败",
            }
            if sent and not manual:
                update["last_sent_date"] = today
            if manual:
                update["last_test_at"] = fmt_iso(now.isoformat())
                update["last_test_result"] = f"{sent}/{total}"
            self._remember(update, today, result, sent, total)
            self.audit.record(
                "report", "system", "scheduled", today, result,
                detail=f"{'manual ' if manual else ''}{sent}/{total}",
            )

            alert_sent = 0
            if (
                not manual
                and self.cfg.failure_alert
                and self._has_failures(daily)
                and self.state.get("last_alert_date") != today
            ):
                alert = self._failure_alert(daily, today)
                alert_results = await self._send_all(sessions, alert)
                alert_sent = sum(1 for ok in alert_results.values() if ok)
                if alert_sent:
                    self.store.data["last_alert_date"] = today
                    self.store.save()
                self.audit.record("report_alert", "system", "scheduled", today, "success" if alert_sent else "failed", detail=f"{alert_sent}/{total}")

            return {
                "status": result,
                "date": today,
                "sent": sent,
                "total": total,
                "alert_sent": alert_sent,
            }

    async def _send_all(self, sessions: list[str], text: str) -> dict[str, bool]:
        results: dict[str, bool] = {}
        for session in sessions:
            results[session] = await self._send_with_retry(session, text)
        return results

    async def _send_with_retry(self, session: str, text: str) -> bool:
        attempts = self.cfg.retries + 1
        for attempt in range(attempts):
            try:
                ok = await self.send(session, text)
            except Exception:
                ok = False
            if ok:
                return True
            if attempt + 1 < attempts:
                await self.sleep(self.cfg.retry_delay)
        return False

    @staticmethod
    def _dedupe_sessions(sessions: list[str]) -> list[str]:
        seen: list[str] = []
        for session in sessions:
            if session not in seen:
                seen.append(session)
        return seen

    @staticmethod
    def _has_failures(daily: dict[str, Any]) -> bool:
        summary = daily.get("summary") if isinstance(daily, dict) else {}
        runs = summary.get("runs") if isinstance(summary, dict) else {}
        by_outcome = runs.get("byOutcome") if isinstance(runs, dict) else {}
        if not isinstance(by_outcome, dict):
            return False
        return any(int(by_outcome.get(key) or 0) > 0 for key in ("failed", "success_unconfirmed", "interrupted"))

    @staticmethod
    def _failure_alert(daily: dict[str, Any], date: str) -> str:
        summary = daily.get("summary") if isinstance(daily, dict) else {}
        runs = summary.get("runs") if isinstance(summary, dict) else {}
        by_outcome = runs.get("byOutcome") if isinstance(runs, dict) else {}
        failed = int(by_outcome.get("failed") or 0) if isinstance(by_outcome, dict) else 0
        unconfirmed = int(by_outcome.get("success_unconfirmed") or 0) if isinstance(by_outcome, dict) else 0
        interrupted = int(by_outcome.get("interrupted") or 0) if isinstance(by_outcome, dict) else 0
        return (
            f"⚠️ MAA 失败告警 · {date}（Asia/Tokyo）\n"
            f"失败 {failed} / 成功未确认 {unconfirmed} / 中断 {interrupted}\n"
            "请查看 MAA 控制台或发送 /maa 失败 获取脱敏摘要。"
        )

    def _skip(self, reason: str, today: str) -> dict[str, Any]:
        self.audit.record("report", "system", "scheduled", today, "skipped", detail=reason)
        return {"status": "skipped", "reason": reason, "date": today, "sent": 0, "total": len(self.cfg.sessions)}

    def _remember(self, update: dict[str, Any], date: str, result: str, sent: int, total: int) -> None:
        history = self.state.get("history")
        if not isinstance(history, list):
            history = []
        history.append({"date": date, "result": result, "sent": sent, "total": total})
        self.state["history"] = history[-10:]
        self.state.update(update)
        self.store.save()

    # --------------------------------------------------------------- status
    def status_text(self, next_run: str = "未知", job_id: str = "") -> str:
        state = self.state
        lines = ["📬 MAA 日报状态"]
        lines.append(f"启用：{'是' if self.cfg.enabled else '否'}；时间：{self.cfg.time_text()} Asia/Tokyo")
        lines.append(f"目标会话：{len(self.cfg.sessions)} 个" + ("（未配置）" if not self.cfg.sessions else ""))
        if job_id:
            lines.append(f"调度任务：{job_id}")
        lines.append(f"下次触发：{next_run}")
        lines.append(f"上次成功日期：{state.get('last_sent_date') or '无'}")
        lines.append(f"上次结果：{state.get('last_result') or '无'}")
        if state.get("last_error"):
            lines.append(f"上次错误：{state['last_error']}")
        if state.get("last_run_at"):
            lines.append(f"上次运行：{state['last_run_at']}")
        lines.append(f"失败重试：{self.cfg.retries} 次；仅活动时汇报：{'是' if self.cfg.only_when_activity else '否'}")
        return "\n".join(lines)

    def next_run_hint(self) -> str:
        now = self.clock()
        scheduled = scheduled_datetime(now, self.cfg.hour, self.cfg.minute)
        if scheduled <= now:
            scheduled += timedelta(days=1)
        return fmt_iso(scheduled.isoformat(), "%Y-%m-%d %H:%M")
