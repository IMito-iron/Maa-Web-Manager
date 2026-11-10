"""Deterministic message formatting for MAA Daily API responses.

No LLM is involved: every function renders plain text from the JSON contract. Missing values are
rendered as ``未知`` and never guessed. Reasons are sanitised (paths, ids, tokens, account names).
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from .jst import fmt_date, fmt_iso, now_jst, today_key

OUTCOME_LABELS = {
    "success": "成功",
    "success_unconfirmed": "成功未确认",
    "failed": "失败",
    "running": "运行中",
    "queued": "等待",
    "cancelled": "已取消",
    "skipped": "已跳过",
    "interrupted": "已中断",
    "unknown": "未知",
}
SOURCE_LABELS = {
    "manual": "手动",
    "schedule": "排程",
    "sanity-retry": "自动重试",
    "other": "其他",
}
PLAN_LABELS = {"executed": "已执行", "pending": "待执行", "missed": "已错过"}


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _int(value: Any, default: int = 0) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else default


def _text(value: Any, default: str = "未知") -> str:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return default


def sanitize_reason(reason: Any, limit: int = 150) -> str:
    if not isinstance(reason, str) or not reason.strip():
        return "未知"
    text = re.sub(r"\x1b\[[0-9;]*m", "", reason)
    text = text.replace("\r", " ").replace("\n", " ").strip()
    text = re.sub(r"\b(?:token|password|secret)\s*[=:]\s*\S+", "<已隐藏>", text, flags=re.I)
    text = re.sub(r"Bearer\s+\S+", "<已隐藏>", text, flags=re.I)
    text = re.sub(r"account_name\s*[=:]\s*[^\s,;]+", "account_name=<已隐藏>", text, flags=re.I)
    text = re.sub(r"(?:[A-Za-z]:\\\\|/(?:data|config|logs|app|opt)/)[^\s\"']+", "<路径>", text)
    text = re.sub(r"\b[0-9a-fA-F]{16,}\b", "<id>", text)
    text = re.sub(r"\b\d{8,}\b", "<id>", text)
    if len(text) > limit:
        text = text[: limit - 1] + "…"
    return text


def outcome_counts(preset: dict[str, Any]) -> dict[str, int]:
    runs = _dict(preset.get("runs"))
    by_outcome = _dict(runs.get("byOutcome"))
    return {key: _int(by_outcome.get(key)) for key in OUTCOME_LABELS}


def plan_counts(preset: dict[str, Any]) -> dict[str, int]:
    counts = {"executed": 0, "pending": 0, "missed": 0}
    for occurrence in _list(preset.get("plan")):
        state = _dict(occurrence).get("state")
        if state in counts:
            counts[state] += 1
    return counts


def runs_of(preset: dict[str, Any]) -> list[dict[str, Any]]:
    return [_dict(item) for item in _list(_dict(preset.get("runs")).get("items"))]


def status_counts(runs: list[dict[str, Any]]) -> dict[str, int]:
    counts = {key: 0 for key in OUTCOME_LABELS}
    for run in runs:
        outcome = run.get("outcome") if run.get("outcome") in OUTCOME_LABELS else "unknown"
        counts[outcome] += 1
    return counts


def _outcome_text(counts: dict[str, int], include_zero: bool = False) -> str:
    parts = []
    for key, label in OUTCOME_LABELS.items():
        value = counts.get(key, 0)
        if value or include_zero:
            parts.append(f"{label}{value}")
    return " ".join(parts) if parts else "无运行"


def _plan_text(counts: dict[str, int]) -> str:
    return "计划 " + "/".join(f"{PLAN_LABELS[key]}{counts[key]}" for key in ("executed", "pending", "missed"))


def _preset_name(preset: dict[str, Any]) -> str:
    return _text(preset.get("displayName") or preset.get("task"))


def _ensure_daily(daily: Any) -> dict[str, Any]:
    return _dict(daily)


def _data_notes(daily: dict[str, Any]) -> str:
    quality = _dict(daily.get("dataQuality"))
    notes: list[str] = []
    if quality.get("empty"):
        notes.append("数据库为空")
    if quality.get("truncated"):
        notes.append("数据被截断")
    unreadable = _list(quality.get("unreadablePresets"))
    if unreadable:
        notes.append("不可读预设 " + ", ".join(_text(item) for item in unreadable[:5]))
    warnings = _list(daily.get("warnings"))
    if warnings:
        codes = []
        for warning in warnings[:5]:
            code = _dict(warning).get("code")
            if isinstance(code, str) and code not in codes:
                codes.append(code)
        if codes:
            notes.append("提示 " + ", ".join(codes))
    if not notes:
        return "数据完整"
    return "；".join(notes)


def _freshness_text(daily: dict[str, Any]) -> str:
    freshness = _dict(daily.get("freshness"))
    data_at = freshness.get("dataUpdatedAt")
    stale = freshness.get("stale")
    if data_at:
        return f"最新运行数据 {fmt_iso(data_at)}" + ("（偏旧）" if stale is True else "")
    return "暂时没有运行数据"


def format_status(health: dict[str, Any] | None, daily: dict[str, Any] | None, error: str = "") -> str:
    """Overall health + queue + next schedule + per-preset daily summary."""
    date = _text(_dict(daily).get("date"), today_key())
    lines = [f"📊 MAA 状态 · {fmt_date(date)}（Asia/Tokyo）"]
    if error:
        lines.append(f"服务：不可用 — {error}")
    else:
        data = _dict(daily)
        summary = _dict(data.get("summary"))
        current = _dict(summary.get("current"))
        if current.get("running") is True:
            queue_state = f"执行中（{_text(current.get('task'))}）"
        elif current.get("queueBlocked") is True:
            queue_state = "受阻"
        elif current.get("queuePaused") is True:
            queue_state = "已暂停"
        else:
            queue_state = "空闲"
        lines.append(f"服务：正常；队列：{queue_state}")
        runs = _dict(summary.get("runs"))
        lines.append("今日运行：" + _outcome_text(status_counts(_items_from_totals(runs)), include_zero=False))
        schedules = _dict(summary.get("schedules"))
        lines.append(f"排程：{_int(schedules.get('enabled'))} 条启用 / 共 {_int(schedules.get('total'))} 条")
        next_at = None
        for preset in _list(data.get("presets")):
            for schedule in _list(_dict(preset).get("schedules")):
                candidate = _dict(schedule).get("nextScheduledAt")
                if isinstance(candidate, str) and (next_at is None or candidate < next_at):
                    next_at = candidate
        lines.append("下次排程：" + (fmt_iso(next_at) if next_at else "暂无启用排程"))
        lines.append("数据：" + _data_notes(data))
        lines.append("预设：")
        presets = [_dict(item) for item in _list(data.get("presets"))]
        if not presets:
            lines.append("· 未知（API 未返回预设）")
        for preset in presets[:10]:
            plans = plan_counts(preset)
            counts = outcome_counts(preset)
            flag = "（配置不可读）" if preset.get("unreadable") is True else ""
            lines.append(f"· {_preset_name(preset)}{flag}：{_plan_text(plans)}｜{_outcome_text(counts)}")
        if len(presets) > 10:
            lines.append(f"· 其余 {len(presets) - 10} 个预设省略")
        if data.get("accountPolicy") == "warn-continue":
            lines.append("账号策略：兼容模式（warn-continue）— 身份未经验证，存在旧账号执行风险。")
        lines.append(_freshness_text(data))
    lines.append("数据来源：只读 Daily API；未知值不会推测。")
    return "\n".join(lines)


def _items_from_totals(runs: dict[str, Any]) -> list[dict[str, Any]]:
    by_outcome = _dict(runs.get("byOutcome"))
    return [{"outcome": key} for key, value in by_outcome.items() for _ in range(_int(value))]


def _run_line(run: dict[str, Any], include_detail: bool) -> str:
    outcome = OUTCOME_LABELS.get(str(run.get("outcome")), "未知")
    started = run.get("startedAt") or run.get("createdAt")
    source = SOURCE_LABELS.get(str(run.get("source")), "其他")
    pieces = [fmt_iso(started, "%H:%M"), source, outcome]
    if run.get("crossMidnight") is True:
        pieces.append("跨午夜")
    confidence = run.get("completionConfidence")
    if outcome == "成功" and run.get("subtasksConfirmed") is False:
        pieces[-1] = "成功未确认"
    if include_detail:
        reason = sanitize_reason(run.get("reason"))
        if reason != "未知":
            pieces.append(f"原因：{reason}")
    return " ".join(pieces)


def format_day(daily: Any, label: str = "今日", include_detail: bool = True) -> str:
    data = _ensure_daily(daily)
    date = _text(data.get("date"), today_key())
    lines = [f"📅 MAA {label} · {fmt_date(date)}（Asia/Tokyo）"]
    summary = _dict(data.get("summary"))
    runs_total = _int(_dict(summary.get("runs")).get("total"))
    schedules = _dict(summary.get("schedules"))
    lines.append(
        f"总计：预设 {_int(summary.get('presets'))} 个；排程 {_int(schedules.get('total'))} 条"
        f"（启用 {_int(schedules.get('enabled'))}）；运行 {runs_total} 次"
    )
    presets = [_dict(item) for item in _list(data.get("presets"))]
    if not presets:
        lines.append("· 未知（API 未返回预设）")
    for preset in presets[:10]:
        plans = plan_counts(preset)
        counts = outcome_counts(preset)
        lines.append(f"\n▸ {_preset_name(preset)}" + ("（配置不可读）" if preset.get("unreadable") is True else ""))
        lines.append(f"  {_plan_text(plans)}｜{_outcome_text(counts)}")
        items = runs_of(preset)
        for run in items[:6]:
            lines.append("  · " + _run_line(run, include_detail=True))
        if len(items) > 6:
            lines.append(f"  · 其余 {len(items) - 6} 次运行省略")
        current = _dict(preset.get("current"))
        if current.get("running") is True:
            lines.append("  · 当前运行中")
    unconfirmed = _unconfirmed_count(data)
    if unconfirmed:
        lines.append(f"\n注意：{unconfirmed} 次运行结果为“成功未确认”，不等同于全部子任务成功。")
    if data.get("accountPolicy") == "warn-continue":
        lines.append("账号策略：兼容模式（warn-continue）— 身份未经验证，存在旧账号执行风险。")
    lines.append("数据：" + _data_notes(data))
    return "\n".join(lines)


def _unconfirmed_count(daily: dict[str, Any]) -> int:
    summary = _dict(daily.get("summary"))
    by_outcome = _dict(_dict(summary.get("runs")).get("byOutcome"))
    return _int(by_outcome.get("success_unconfirmed"))


def format_failures(daily: Any, include_detail: bool = True) -> str:
    data = _ensure_daily(daily)
    date = _text(data.get("date"), today_key())
    lines = [f"⚠️ MAA 失败 · {fmt_date(date)}（Asia/Tokyo）"]
    lines.append("失败 / 未确认 / 中断：")
    rows: list[str] = []
    for preset in [_dict(item) for item in _list(data.get("presets"))]:
        for run in runs_of(preset):
            outcome = str(run.get("outcome"))
            if outcome not in ("failed", "success_unconfirmed", "interrupted", "cancelled"):
                continue
            label = OUTCOME_LABELS.get(outcome, "未知")
            line = f"· {_preset_name(preset)} · {fmt_iso(run.get('startedAt') or run.get('createdAt'), '%H:%M')} [{label}]"
            if include_detail:
                reason = sanitize_reason(run.get("reason"))
                if reason != "未知":
                    line += f" 原因：{reason}"
            rows.append(line)
    if rows:
        lines.extend(rows[:12])
        if len(rows) > 12:
            lines.append(f"· 其余 {len(rows) - 12} 条省略")
    else:
        lines.append("· 今日没有失败或未确认的运行。")
    lines.append("数据：" + _data_notes(data))
    return "\n".join(lines)


def format_schedules(daily: Any) -> str:
    data = _ensure_daily(daily)
    date = _text(data.get("date"), today_key())
    lines = [f"🗓️ MAA 排程 · {fmt_date(date)}（Asia/Tokyo）"]
    count = 0
    for preset in [_dict(item) for item in _list(data.get("presets"))]:
        for schedule in _list(preset.get("schedules")):
            schedule = _dict(schedule)
            count += 1
            enabled = "启用" if schedule.get("enabled") is True else "未启用"
            next_at = schedule.get("nextScheduledAt") or schedule.get("nextAt")
            lines.append(
                f"· {_preset_name(preset)} / {_text(schedule.get('name'))}（{enabled}）："
                f"{_text(schedule.get('type'))} {_text(schedule.get('expression'))} → 下次 {fmt_iso(next_at)}"
            )
            plan = []
            for occurrence in _list(preset.get("plan")):
                occurrence = _dict(occurrence)
                if occurrence.get("scheduleId") == schedule.get("id"):
                    plan.append(PLAN_LABELS.get(str(occurrence.get("state")), "未知"))
            if plan:
                lines.append("  当日：" + " / ".join(plan))
    if count == 0:
        lines.append("· 未知（API 未返回排程）")
    lines.append("数据：" + _data_notes(data))
    return "\n".join(lines)


def _has_activity(daily: dict[str, Any]) -> bool:
    summary = _dict(daily.get("summary"))
    runs = _dict(summary.get("runs"))
    if _int(runs.get("total")) > 0:
        return True
    for preset in _list(daily.get("presets")):
        if _list(_dict(preset).get("runs")):
            return True
        if plan_counts(_dict(preset))["executed"] or plan_counts(_dict(preset))["pending"]:
            return True
    return False


def format_report(daily: Any, include_failure_detail: bool = True, only_when_activity: bool = True) -> str | None:
    """Daily report; returns None when ``only_when_activity`` is set and nothing happened."""
    data = _ensure_daily(daily)
    if only_when_activity and not _has_activity(data):
        return None
    date = _text(data.get("date"), today_key())
    head = [f"📬 MAA 日报 · {fmt_date(date)}（Asia/Tokyo）"]
    summary = _dict(data.get("summary"))
    runs = _dict(summary.get("runs"))
    schedules = _dict(summary.get("schedules"))
    head.append(
        f"运行 {_int(runs.get('total'))} 次｜排程 {_int(schedules.get('total'))} 条"
        f"（启用 {_int(schedules.get('enabled'))}）｜预设 {_int(summary.get('presets'))} 个"
    )
    head.append("结果：" + _outcome_text(_totals_from_summary(runs)))
    body_lines: list[str] = []
    for preset in [_dict(item) for item in _list(data.get("presets"))]:
        items = runs_of(preset)
        if not items:
            continue
        plans = plan_counts(preset)
        body_lines.append(f"▸ {_preset_name(preset)}")
        body_lines.append("  " + _outcome_text(outcome_counts(preset)) + f"｜{_plan_text(plans)}")
        for run in items[:4]:
            body_lines.append("  · " + _run_line(run, include_detail=False))
        if len(items) > 4:
            body_lines.append(f"  · 其余 {len(items) - 4} 次省略")
    if not body_lines:
        body_lines.append("今天没有已记录的运行。")
    failure_lines: list[str] = []
    if include_failure_detail:
        for preset in [_dict(item) for item in _list(data.get("presets"))]:
            for run in runs_of(preset):
                if str(run.get("outcome")) not in ("failed", "success_unconfirmed", "interrupted"):
                    continue
                failure_lines.append(
                    f"· {_preset_name(preset)} [{OUTCOME_LABELS.get(str(run.get('outcome')), '未知')}] "
                    f"{sanitize_reason(run.get('reason'), 100)}"
                )
        if failure_lines:
            failure_lines = ["失败/未确认："] + failure_lines[:6]
            if len(failure_lines) > 7:
                failure_lines.append("· 其余省略")
    tail = ["数据：" + _data_notes(data), _freshness_text(data)]
    text = "\n".join(head + [""] + body_lines + ([""] + failure_lines if failure_lines else []) + [""] + tail)
    if len(text) > 1800:
        text = text[:1790] + "…\n（内容较长已截断）"
    return text


def _totals_from_summary(runs: dict[str, Any]) -> dict[str, int]:
    return {key: _int(_dict(runs.get("byOutcome")).get(key)) for key in OUTCOME_LABELS}


def format_help() -> str:
    return (
        "🤖 MAA 助手\n"
        "查询：/maa 状态 | 今日 | 昨日 | 失败 | 排程\n"
        "控制：/maa 运行 <预设> | 暂停 | 恢复 | 取消 <运行ID>\n"
        "确认：/maa 确认 <令牌>（一次性，短期有效）\n"
        "管理：/maa 会话 | 报告状态 | 测试汇报\n"
        "所有查询按 Asia/Tokyo 日期；未获取的数据显示为未知。"
    )
