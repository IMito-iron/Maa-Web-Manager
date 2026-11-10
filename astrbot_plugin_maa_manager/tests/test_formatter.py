"""Formatter tests: five presets, multiple runs, unconfirmed, unknown and sanitisation."""

from __future__ import annotations

import copy
import unittest

from astrbot_plugin_maa_manager.maa.formatter import (
    format_day,
    format_failures,
    format_help,
    format_report,
    format_schedules,
    format_status,
    sanitize_reason,
)
from astrbot_plugin_maa_manager.tests.fakes import load_fixture


class FormatterTests(unittest.TestCase):
    def setUp(self):
        self.daily = load_fixture()

    def test_status_shows_health_queue_and_all_presets(self):
        text = format_status({"ok": True}, self.daily)
        self.assertIn("MAA 状态", text)
        for name in ("日常 账号A", "日常 账号B", "日常 账号C", "日常 账号D", "日常 账号E"):
            self.assertIn(name, text)
        self.assertIn("下次排程", text)
        self.assertIn("兼容模式", text)
        self.assertIn("配置不可读", text)
        self.assertNotIn("unknown", text.lower())

    def test_today_lists_multiple_runs_and_unconfirmed(self):
        text = format_day(self.daily, "今日")
        self.assertIn("日常 账号A", text)
        self.assertIn("成功未确认", text)
        self.assertIn("失败", text)
        self.assertIn("07:00", text)
        self.assertIn("19:00", text)
        self.assertIn("不等同于全部子任务成功", text)

    def test_yesterday_uses_given_date(self):
        yesterday = copy.deepcopy(self.daily)
        yesterday["date"] = "2026-11-05"
        text = format_day(yesterday, "昨日")
        self.assertIn("2026-11-05", text)
        self.assertIn("昨日", text)

    def test_failures_only_failed_and_unconfirmed(self):
        text = format_failures(self.daily, include_detail=True)
        self.assertIn("失败", text)
        self.assertIn("成功未确认", text)
        self.assertIn("com.hypergryph.arknights", text)
        self.assertNotIn("run-ok-1", text)

    def test_schedules_show_enabled_and_disabled(self):
        text = format_schedules(self.daily)
        self.assertIn("0 7,19 * * *", text)
        self.assertIn("启用", text)
        self.assertIn("未启用", text)
        self.assertIn("下次", text)

    def test_report_only_when_activity(self):
        text = format_report(self.daily, include_failure_detail=True, only_when_activity=True)
        self.assertIsNotNone(text)
        self.assertIn("MAA 日报", text)
        self.assertIn("失败", text)

    def test_report_skips_empty_day(self):
        empty = {
            "date": "2026-11-06",
            "summary": {"presets": 5, "schedules": {"total": 5, "enabled": 0}, "runs": {"total": 0, "byOutcome": {}}},
            "presets": [],
            "dataQuality": {"empty": True},
        }
        self.assertIsNone(format_report(empty, only_when_activity=True))
        self.assertIsNotNone(format_report(empty, only_when_activity=False))

    def test_missing_data_is_unknown_not_guessed(self):
        text = format_status(None, None, error="MAA API 请求超时：服务暂时无响应")
        self.assertIn("不可用", text)
        text2 = format_day({}, "今日")
        self.assertIn("未知", text2)
        text3 = format_schedules({})
        self.assertIn("未知", text3)

    def test_no_secret_or_identity_leak(self):
        text = format_day(self.daily, "今日")
        self.assertNotIn("account_name", text)
        self.assertNotIn("FAKEUSB0001", text)
        self.assertNotIn("Bearer", text)
        self.assertNotIn("/data/manager", text)
        self.assertNotIn("token=abcdef", text)

    def test_sanitize_reason(self):
        reason = "失败 token=secret /data/config/foo.json 1234567890123456 account_name=foo"
        text = sanitize_reason(reason)
        self.assertNotIn("secret", text)
        self.assertNotIn("/data/config", text)
        self.assertNotIn("1234567890123456", text)
        self.assertNotIn("account_name=foo", text)
        self.assertIn("<已隐藏>", text)

    def test_help_lists_commands_without_secrets(self):
        text = format_help()
        self.assertIn("/maa 状态", text)
        self.assertIn("/maa 确认", text)
        self.assertNotIn("token", text.lower().replace("token 无效", ""))


if __name__ == "__main__":
    unittest.main()
