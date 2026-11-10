"""Small JSON state store used for report dedupe and last-result persistence."""

from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any

DEFAULT_STATE: dict[str, Any] = {
    "last_sent_date": "",
    "last_alert_date": "",
    "last_result": "",
    "last_error": "",
    "last_run_at": "",
    "job_id": "",
    "history": [],
}


class JsonStateStore:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self._lock = threading.Lock()
        self.data: dict[str, Any] = dict(DEFAULT_STATE)
        self.load()

    def load(self) -> dict[str, Any]:
        try:
            with open(self.path, encoding="utf-8") as handle:
                loaded = json.load(handle)
            if isinstance(loaded, dict):
                merged = dict(DEFAULT_STATE)
                merged.update(loaded)
                self.data = merged
        except (OSError, json.JSONDecodeError):
            self.data = dict(DEFAULT_STATE)
        return self.data

    def save(self) -> None:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            handle = tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=str(self.path.parent),
                prefix=f".{self.path.name}.",
                delete=False,
            )
            temp_path = handle.name
            try:
                json.dump(self.data, handle, ensure_ascii=False, indent=1)
                handle.flush()
                os.fsync(handle.fileno())
            finally:
                handle.close()
            os.replace(temp_path, self.path)

    def update(self, **values: Any) -> None:
        self.data.update(values)
        self.save()
