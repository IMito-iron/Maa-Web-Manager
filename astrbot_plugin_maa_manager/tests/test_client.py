"""Client and error-mapping tests with a local fake HTTP server."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from astrbot_plugin_maa_manager.maa.client import (
    MaaApiError,
    MaaDailyClient,
    UrllibTransport,
    resolve_token,
)
from astrbot_plugin_maa_manager.tests.fakes import FakeMaaApi, load_fixture


class ClientTests(unittest.TestCase):
    def test_health_and_daily(self):
        with FakeMaaApi(token="secret") as api:
            client = MaaDailyClient(api.base_url, "secret", timeout=5)
            health = __import__("asyncio").run(client.health())
            self.assertTrue(health["ok"])
            daily = __import__("asyncio").run(client.daily_status("2026-11-06"))
            self.assertEqual(daily["date"], "2026-11-06")
            self.assertTrue(api.requests[0]["auth"].startswith("Bearer "))
            self.assertIn("date=2026-11-06", api.requests[-1]["query"])

    def test_wrong_token_maps_to_auth(self):
        with FakeMaaApi(token="right") as api:
            client = MaaDailyClient(api.base_url, "wrong", timeout=5)
            with self.assertRaises(MaaApiError) as ctx:
                __import__("asyncio").run(client.daily_status())
            self.assertEqual(ctx.exception.kind, "auth")
            self.assertIn("Token", ctx.exception.user_message())

    def test_server_error_maps_to_unavailable(self):
        with FakeMaaApi(status=503, token="token") as api:
            client = MaaDailyClient(api.base_url, "token", timeout=5)
            with self.assertRaises(MaaApiError) as ctx:
                __import__("asyncio").run(client.health())
            self.assertEqual(ctx.exception.kind, "unavailable")

    def test_unreachable_maps_to_unavailable(self):
        client = MaaDailyClient("http://127.0.0.1:1/api/v1/public", "token", timeout=1)
        with self.assertRaises(MaaApiError) as ctx:
            __import__("asyncio").run(client.health())
        self.assertIn(ctx.exception.kind, ("unavailable", "timeout"))

    def test_token_file_takes_precedence(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "token"
            path.write_text("from-file\n", encoding="utf-8")
            self.assertEqual(resolve_token({"maa_api_token_file": str(path), "maa_api_token": "cfg"}), "from-file")

    def test_missing_token_is_config_error(self):
        with self.assertRaises(MaaApiError) as ctx:
            MaaDailyClient.from_config({"maa_api_token": ""})
        self.assertEqual(ctx.exception.kind, "config")
        self.assertIn("Token", ctx.exception.user_message())

    def test_invalid_json(self):
        class InvalidTransport(UrllibTransport):
            async def get_json(self, url, headers, timeout):
                return 200, object()

        client = MaaDailyClient("http://127.0.0.1:1/api/v1/public", "token", transport=InvalidTransport())
        with self.assertRaises(MaaApiError) as ctx:
            __import__("asyncio").run(client.health())
        self.assertIn(ctx.exception.kind, ("invalid", "unavailable"))

    def test_timeout_transport(self):
        class TimeoutTransport:
            async def get_json(self, url, headers, timeout):
                raise MaaApiError("timeout")

        client = MaaDailyClient("http://127.0.0.1:1/api/v1/public", "token", transport=TimeoutTransport())
        with self.assertRaises(MaaApiError) as ctx:
            __import__("asyncio").run(client.daily_status())
        self.assertEqual(ctx.exception.kind, "timeout")
        self.assertIn("超时", ctx.exception.user_message())


if __name__ == "__main__":
    unittest.main()
