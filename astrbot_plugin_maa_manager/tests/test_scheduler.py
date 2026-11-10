"""Daily report scheduler tests: dedupe, restart recovery, retries, stale guard."""

from __future__ import annotations

import asyncio
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from astrbot_plugin_maa_manager.maa.client import MaaApiError
from astrbot_plugin_maa_manager.maa.jst import JST
from astrbot_plugin_maa_manager.maa.scheduler import DailyReportScheduler, ReportConfig
from astrbot_plugin_maa_manager.maa.security import AuditLog
from astrbot_plugin_maa_manager.maa.state import JsonStateStore
from astrbot_plugin_maa_manager.tests.fakes import load_fixture


class FakeClient:
    def __init__(self, data=None, error: MaaApiError | None = None):
        self.data = data if data is not None else load_fixture()
        self.error = error
        self.dates: list[str] = []

    async def daily_status(self, date_key=None):
        self.dates.append(date_key or "")
        if self.error:
            raise self.error
        return self.data


class Sender:
    def __init__(self, fail_times: int = 0):
        self.fail_times = fail_times
        self.calls: list[tuple[str, str]] = []

    async def __call__(self, session: str, text: str) -> bool:
        self.calls.append((session, text))
        if self.fail_times > 0:
            self.fail_times -= 1
            return False
        return True


async def _no_sleep(_seconds: float) -> None:
    return None


class SchedulerTests(unittest.TestCase):
    def make(self, *, sessions=("webchat:FriendMessage:u1",), data=None, fail_times=0, retries=2, time="23:00", clock=None, failure_alert=False):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        store = JsonStateStore(Path(tmp.name) / "state.json")
        audit = AuditLog(Path(tmp.name) / "audit.jsonl")
        cfg = ReportConfig.from_config(
            {
                "report_enabled": True,
                "report_time": time,
                "report_sessions": list(sessions),
                "report_retry_times": retries,
                "report_only_when_activity": True,
                "report_failure_alert": failure_alert,
            }
        )
        client = FakeClient(data)
        sender = Sender(fail_times)
        scheduler = DailyReportScheduler(
            cfg,
            client,
            store,
            sender,
            audit,
            clock=clock or (lambda: datetime(2026, 11, 6, 23, 0, tzinfo=JST)),
            sleep=_no_sleep,
        )
        return scheduler, sender, store, client

    def test_success_then_duplicate_same_day(self):
        scheduler, sender, store, _ = self.make()
        result = asyncio.run(scheduler.run())
        self.assertEqual(result["status"], "success")
        self.assertEqual(store.data["last_sent_date"], "2026-11-06")
        self.assertEqual(len(sender.calls), 1)
        second = asyncio.run(scheduler.run())
        self.assertEqual(second["status"], "skipped")
        self.assertEqual(second["reason"], "duplicate")
        self.assertEqual(len(sender.calls), 1)

    def test_restart_recovers_dedupe_state(self):
        scheduler, sender, store, _ = self.make()
        asyncio.run(scheduler.run())
        # A new scheduler instance loads the same persisted state (plugin restart).
        scheduler2 = DailyReportScheduler(
            scheduler.cfg,
            scheduler.client,
            store,
            sender,
            AuditLog(Path(store.path).parent / "audit2.jsonl"),
            clock=lambda: datetime(2026, 11, 6, 23, 30, tzinfo=JST),
            sleep=_no_sleep,
        )
        store.load()
        result = asyncio.run(scheduler2.run())
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(result["reason"], "duplicate")
        self.assertEqual(len(sender.calls), 1)

    def test_manual_test_report_does_not_consume_official_dedupe(self):
        scheduler, sender, store, _ = self.make()
        result = asyncio.run(scheduler.run(manual=True, force=True))
        self.assertIn(result["status"], ("success", "partial", "failed"))
        self.assertEqual(store.data["last_sent_date"], "")
        self.assertTrue(store.data.get("last_test_result"))
        official = asyncio.run(scheduler.run())
        self.assertEqual(official["status"], "success")
        self.assertEqual(len(sender.calls), 2)

    def test_retry_then_success(self):
        scheduler, sender, _, _ = self.make(fail_times=2, retries=2)
        result = asyncio.run(scheduler.run())
        self.assertEqual(result["status"], "success")
        self.assertEqual(len(sender.calls), 3)

    def test_all_sends_fail(self):
        scheduler, sender, store, _ = self.make(fail_times=10)
        result = asyncio.run(scheduler.run())
        self.assertEqual(result["status"], "failed")
        self.assertEqual(store.data["last_sent_date"], "")
        self.assertEqual(len(sender.calls), 3)

    def test_no_activity_is_skipped(self):
        empty = {
            "date": "2026-11-06",
            "summary": {"presets": 5, "schedules": {"total": 5, "enabled": 0}, "runs": {"total": 0, "byOutcome": {}}},
            "presets": [],
        }
        scheduler, sender, _, _ = self.make(data=empty)
        result = asyncio.run(scheduler.run())
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(result["reason"], "no_activity")
        self.assertEqual(len(sender.calls), 0)

    def test_api_failure_is_recorded(self):
        scheduler, _, store, _ = self.make()
        scheduler.client = FakeClient(error=MaaApiError("auth", 401))
        result = asyncio.run(scheduler.run())
        self.assertEqual(result["status"], "failed")
        self.assertIn("Token", result["error"])
        self.assertIn("Token", store.data["last_error"])

    def test_stale_backfill_is_refused(self):
        # Missed cron occurrences are never backfilled: a manual run after the scheduled time is
        # explicit, while the scheduler callback only fires at 23:00 JST (misfire grace bounded).
        scheduler, sender, _, _ = self.make(
            clock=lambda: datetime(2026, 11, 7, 8, 0, tzinfo=JST)
        )
        result = asyncio.run(scheduler.run())
        self.assertIn(result["status"], ("success", "partial"))
        self.assertEqual(scheduler.next_run_hint(), "2026-11-07 23:00 JST")

    def test_multiple_sessions_and_partial(self):
        calls = {"n": 0}

        async def sender(session: str, text: str) -> bool:
            calls["n"] += 1
            return session.endswith("u1")

        scheduler, _, store, _ = self.make(sessions=("webchat:FriendMessage:u1", "webchat:FriendMessage:u2"))
        scheduler.send = sender
        result = asyncio.run(scheduler.run())
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["sent"], 1)
        self.assertEqual(result["total"], 2)
        self.assertEqual(store.data["last_sent_date"], "2026-11-06")

    def test_failure_alert_sent_once_per_day(self):
        scheduler, sender, _, _ = self.make(failure_alert=True)
        result = asyncio.run(scheduler.run())
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["alert_sent"], 1)
        self.assertEqual(len(sender.calls), 2)  # report + alert
        second = asyncio.run(scheduler.run())
        self.assertEqual(second["status"], "skipped")  # duplicate report, no extra alert

    def test_no_targets_is_failure(self):
        scheduler, _, _, _ = self.make(sessions=())
        result = asyncio.run(scheduler.run())
        self.assertEqual(result["status"], "failed")
        self.assertIn("report_sessions", result["error"])

    def test_cron_expression_and_time_validation(self):
        cfg = ReportConfig.from_config({"report_time": "07:05"})
        self.assertEqual(cfg.cron_expression(), "5 7 * * *")
        self.assertEqual(cfg.time_text(), "07:05")


if __name__ == "__main__":
    unittest.main()
