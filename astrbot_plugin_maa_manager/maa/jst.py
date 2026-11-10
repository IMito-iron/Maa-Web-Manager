"""Asia/Tokyo date helpers. Never rely on the container's local timezone."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

JST = ZoneInfo("Asia/Tokyo")


def now_jst() -> datetime:
    return datetime.now(timezone.utc).astimezone(JST)


def to_jst(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(JST)


def today_key(now: datetime | None = None) -> str:
    current = now_jst() if now is None else to_jst(now)
    assert current is not None
    return current.date().isoformat()


def shift_key(key: str, days: int) -> str:
    return (date.fromisoformat(key) + timedelta(days=days)).isoformat()


def parse_iso(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return to_jst(parsed)


def fmt_iso(value: object, pattern: str = "%m-%d %H:%M") -> str:
    parsed = parse_iso(value)
    if parsed is None:
        return "未知"
    return parsed.strftime(pattern) + " JST"


def fmt_date(key: str) -> str:
    try:
        return date.fromisoformat(key).strftime("%Y-%m-%d")
    except ValueError:
        return "未知"


def parse_clock(text: object, default: str = "23:00") -> tuple[int, int]:
    """Parse HH:MM (24h) into (hour, minute); invalid values fall back to the default."""
    candidate = text if isinstance(text, str) else ""
    for value in (candidate, default):
        parts = value.strip().split(":")
        if len(parts) != 2 or not all(part.isdigit() for part in parts):
            continue
        hour, minute = int(parts[0]), int(parts[1])
        if 0 <= hour <= 23 and 0 <= minute <= 59:
            return hour, minute
    return 23, 0


def scheduled_datetime(now: datetime | None, hour: int, minute: int) -> datetime:
    current = now_jst() if now is None else to_jst(now)
    assert current is not None
    return current.replace(hour=hour, minute=minute, second=0, microsecond=0)
