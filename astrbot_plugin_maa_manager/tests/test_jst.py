"""Unit tests for Date/JST helpers."""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from astrbot_plugin_maa_manager.maa.jst import (
    JST,
    fmt_iso,
    parse_clock,
    parse_iso,
    scheduled_datetime,
    shift_key,
    today_key,
)


class JstTests(unittest.TestCase):
    def test_today_key_uses_tokyo_not_utc(self):
        # 2026-11-06T16:30Z is already 2026-11-07 01:30 in Tokyo.
        instant = datetime(2026, 11, 6, 16, 30, tzinfo=timezone.utc)
        self.assertEqual(today_key(instant), "2026-11-07")

    def test_shift_crosses_month(self):
        self.assertEqual(shift_key("2026-11-01", -1), "2026-10-31")
        self.assertEqual(shift_key("2026-12-31", 1), "2027-01-01")

    def test_parse_iso_converts_to_jst(self):
        parsed = parse_iso("2026-11-06T22:00:00Z")
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed.utcoffset(), timedelta(hours=9))
        self.assertEqual(parsed.date().isoformat(), "2026-11-07")

    def test_fmt_iso_unknown(self):
        self.assertEqual(fmt_iso(None), "未知")
        self.assertEqual(fmt_iso("not-a-date"), "未知")
        self.assertIn("JST", fmt_iso("2026-11-06T07:00:00+09:00", "%Y-%m-%d %H:%M"))

    def test_parse_clock(self):
        self.assertEqual(parse_clock("23:00"), (23, 0))
        self.assertEqual(parse_clock("7:05"), (7, 5))
        self.assertEqual(parse_clock("24:00"), (23, 0))
        self.assertEqual(parse_clock("", "08:30"), (8, 30))

    def test_scheduled_datetime_is_tokyo(self):
        now = datetime(2026, 11, 6, 12, 0, tzinfo=JST)
        scheduled = scheduled_datetime(now, 23, 0)
        self.assertEqual(scheduled.hour, 23)
        self.assertEqual(scheduled.tzinfo, JST)


if __name__ == "__main__":
    unittest.main()
