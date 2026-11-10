"""Local fakes used by the plugin tests; no production service is contacted."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

FIXTURES = Path(__file__).parent / "fixtures"


def load_fixture(name: str = "daily_2026-11-06.json") -> dict[str, Any]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


class FakeMaaApi:
    """Tiny HTTP server implementing /health and /daily-status."""

    def __init__(
        self,
        daily: dict[str, Any] | None = None,
        token: str = "test-token",
        status: int = 200,
        delay: float = 0.0,
    ):
        self.daily = daily if daily is not None else load_fixture()
        self.token = token
        self.status = status
        self.delay = delay
        self.requests: list[dict[str, Any]] = []
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def base_url(self) -> str:
        assert self._server is not None
        return f"http://127.0.0.1:{self._server.server_address[1]}/api/v1/public"

    def __enter__(self) -> "FakeMaaApi":
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:  # silence
                return

            def do_GET(self) -> None:  # noqa: N802
                path = self.path.split("?")[0]
                query = self.path.split("?")[1] if "?" in self.path else ""
                outer.requests.append(
                    {
                        "path": path,
                        "query": query,
                        "auth": self.headers.get("Authorization", ""),
                    }
                )
                if self.headers.get("Authorization") != f"Bearer {outer.token}":
                    self._send(401, {"error": {"code": "unauthorized"}})
                    return
                if outer.delay:
                    pass
                if outer.status != 200:
                    self._send(outer.status, {"error": {"code": "test"}})
                    return
                if path.endswith("/health"):
                    self._send(200, {"ok": True, "service": "maa-manager", "readOnly": True, "timeZone": "Asia/Tokyo"})
                elif path.endswith("/daily-status"):
                    self._send(200, outer.daily)
                else:
                    self._send(404, {"message": "not found"})

            def _send(self, code: int, payload: Any) -> None:
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *args: Any) -> None:
        if self._server:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread:
            self._thread.join(timeout=2)
            self._thread = None


class FakeManager:
    """Stateful fake of the Manager control API (internal HTTP)."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.paused = False
        self.blocked = False
        self.health = {"adb": True, "android": True, "maa": True, "deviceState": "CONNECTED"}
        self.tasks = [{"name": "preset-demo02"}, {"name": "preset-demo03"}]
        self.queue_items: list[dict[str, Any]] = []
        self.runs: list[dict[str, Any]] = []
        self.calls: list[dict[str, Any]] = []
        self.fail_next_write = False  # return 500 once
        self.hang_next_write = False  # simulate timeout after applying the write
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def base_url(self) -> str:
        assert self._server is not None
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    def _send(self, handler: BaseHTTPRequestHandler, code: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        handler.send_response(code)
        handler.send_header("Content-Type", "application/json; charset=utf-8")
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        try:
            handler.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def __enter__(self) -> "FakeManager":
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                return

            def _record(self, method: str, path: str, body: bytes) -> None:
                outer.calls.append(
                    {
                        "method": method,
                        "path": path,
                        "body": body.decode("utf-8", "replace"),
                        "origin": self.headers.get("Origin", ""),
                        "maa": self.headers.get("X-Maa-Request", ""),
                    }
                )

            def do_GET(self) -> None:  # noqa: N802
                self._record("GET", self.path, b"")
                path = self.path.split("?")[0]
                with outer.lock:
                    if path == "/api/status":
                        self_status = {
                            **outer.health,
                            "queue": {"paused": outer.paused, "blocked": outer.blocked, "items": list(outer.queue_items)},
                        }
                        outer._send(self, 200, self_status)
                    elif path == "/api/queue":
                        outer._send(self, 200, {"paused": outer.paused, "blocked": outer.blocked, "items": list(outer.queue_items)})
                    elif path == "/api/tasks":
                        outer._send(self, 200, outer.tasks)
                    elif path == "/api/runs":
                        outer._send(self, 200, outer.runs)
                    else:
                        outer._send(self, 404, {"message": "not found"})

            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length) if length else b""
                self._record("POST", self.path, body)
                if self.headers.get("Origin") != "https://maa.test" or self.headers.get("X-Maa-Request") != "1":
                    outer._send(self, 403, {"message": "bad origin"})
                    return
                path = self.path.split("?")[0]
                with outer.lock:
                    if outer.fail_next_write:
                        outer.fail_next_write = False
                        outer._send(self, 500, {"message": "boom"})
                        return
                    if path == "/api/queue":
                        try:
                            payload = json.loads(body or b"{}")
                        except json.JSONDecodeError:
                            outer._send(self, 400, {"message": "bad json"})
                            return
                        action = payload.get("action")
                        if action == "pause":
                            outer.paused = True
                        elif action == "resume":
                            outer.paused = False
                        else:
                            outer._send(self, 400, {"message": "bad action"})
                            return
                        outer._send(self, 200, {"paused": outer.paused})
                    elif path.startswith("/api/tasks/") and path.endswith("/run"):
                        name = path[len("/api/tasks/") : -len("/run")]
                        run = {"id": f"run-{len(outer.runs) + 1}", "task": name, "status": "queued", "outcome": "queued"}
                        outer.runs.insert(0, run)
                        outer.queue_items.append({"id": run["id"], "task": name})
                        outer._send(self, 200, {"runId": run["id"]})
                    elif path.startswith("/api/runs/") and path.endswith("/stop"):
                        run_id = path[len("/api/runs/") : -len("/stop")]
                        for run in outer.runs:
                            if run["id"] == run_id:
                                run["status"] = "cancelled"
                                run["outcome"] = "cancelled"
                        outer.queue_items = [item for item in outer.queue_items if item.get("id") != run_id]
                        outer._send(self, 200, {"ok": True})
                    else:
                        outer._send(self, 404, {"message": "not found"})

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *args: Any) -> None:
        if self._server:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread:
            self._thread.join(timeout=2)
            self._thread = None
