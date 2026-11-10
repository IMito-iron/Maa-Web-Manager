"""Permissions, one-time confirmation tokens and redacted audit logging."""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable


def _as_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str) and value.strip():
        return [item.strip() for item in re.split(r"[,\n]", value) if item.strip()]
    return []


def mask_id(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return "anonymous"
    return "id:" + hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


def mask_session(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return "session:unknown"
    return "session:" + hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


class PermissionPolicy:
    """Query and control permissions are deliberately separate."""

    def __init__(self, config: dict[str, Any]):
        self.query_admin_only = bool(config.get("query_admin_only", False))
        self.query_sessions = _as_list(config.get("query_allowed_sessions"))
        self.control_enabled = bool(config.get("control_enabled", False))
        self.control_admin_ids = _as_list(config.get("control_admin_ids"))
        self.control_sessions = _as_list(config.get("control_allowed_sessions"))
        self.control_allow_global_admins = bool(config.get("control_allow_global_admins", False))

    def query_allowed(self, sender_id: str, session: str, is_global_admin: bool = False) -> bool:
        if self.query_admin_only and not is_global_admin:
            return False
        if self.query_sessions and session not in self.query_sessions:
            return False
        return True

    def control_allowed(self, sender_id: str, session: str, is_global_admin: bool = False) -> bool:
        if not self.control_enabled:
            return False
        sender = str(sender_id or "").strip()
        if not sender:
            return False
        allowed_user = sender in self.control_admin_ids or (
            self.control_allow_global_admins and is_global_admin
        )
        if not allowed_user:
            return False
        if self.control_sessions and session not in self.control_sessions:
            return False
        return True


@dataclass(slots=True)
class Proposal:
    token: str
    actor_id: str
    session: str
    action: str
    target: str | None
    request_id: str
    created_at: float
    expires_at: float
    used: bool = False


class ConfirmationStore:
    """In-memory, one-time, short-lived, bound to actor + session + action + target."""

    def __init__(
        self,
        ttl_seconds: int = 90,
        clock: Callable[[], float] = time.time,
    ):
        self.ttl = max(30, min(300, int(ttl_seconds or 90)))
        self.clock = clock
        self._items: dict[str, Proposal] = {}
        self._lock = threading.Lock()

    def issue(self, actor_id: str, session: str, action: str, target: str | None) -> Proposal:
        now = self.clock()
        token = uuid.uuid4().hex[:8].upper()
        proposal = Proposal(
            token=token,
            actor_id=str(actor_id),
            session=str(session),
            action=action,
            target=target,
            request_id=uuid.uuid4().hex,
            created_at=now,
            expires_at=now + self.ttl,
        )
        with self._lock:
            self._prune(now)
            self._items[token] = proposal
        return proposal

    def consume(self, token: str, actor_id: str, session: str) -> Proposal | None:
        now = self.clock()
        key = str(token or "").strip().upper()
        with self._lock:
            self._prune(now)
            proposal = self._items.get(key)
            if proposal is None or proposal.used:
                return None
            if proposal.expires_at < now:
                self._items.pop(key, None)
                return None
            if proposal.actor_id != str(actor_id) or proposal.session != str(session):
                return None
            proposal.used = True
            return proposal

    def _prune(self, now: float) -> None:
        for key, proposal in list(self._items.items()):
            if proposal.used or proposal.expires_at < now:
                self._items.pop(key, None)


class AuditLog:
    """Append-only redacted audit log; never stores tokens, account names or raw messages."""

    def __init__(self, path: str | Path, max_bytes: int = 1024 * 1024):
        self.path = Path(path)
        self.max_bytes = max_bytes
        self._lock = threading.Lock()

    def record(
        self,
        action: str,
        actor_id: str,
        session: str,
        target: str | None,
        outcome: str,
        request_id: str | None = None,
        detail: str = "",
    ) -> None:
        entry = {
            "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "action": action,
            "actor": mask_id(actor_id),
            "session": mask_session(session),
            "target": str(target or "")[:120],
            "outcome": outcome,
            "request_id": request_id or "",
            "detail": str(detail or "")[:200],
        }
        line = json.dumps(entry, ensure_ascii=False)
        with self._lock:
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                self._rotate()
                with open(self.path, "a", encoding="utf-8") as handle:
                    handle.write(line + "\n")
            except OSError:
                # Auditing must never break a user-facing operation; the failure is visible in the
                # plugin log via the caller if needed.
                pass

    def _rotate(self) -> None:
        try:
            if self.path.exists() and self.path.stat().st_size > self.max_bytes:
                os.replace(self.path, self.path.with_suffix(".1.jsonl"))
        except OSError:
            pass
