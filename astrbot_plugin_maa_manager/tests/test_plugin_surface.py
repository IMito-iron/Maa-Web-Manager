"""Plugin surface tests with a minimal AstrBot API stub.

These verify command routing, permissions and the read-only LLM tool surface without needing a
running AstrBot instance. The same module is later loaded by the real AstrBot deployment.
"""

from __future__ import annotations

import asyncio
import importlib
import logging
import sys
import tempfile
import types
import unittest
from pathlib import Path

from astrbot_plugin_maa_manager.tests.fakes import FakeMaaApi


def _install_astrbot_stubs(data_dir: Path) -> None:
    if "astrbot" in sys.modules and getattr(sys.modules["astrbot"], "_maa_stub", False):
        return

    astrbot = types.ModuleType("astrbot")
    astrbot._maa_stub = True
    astrbot.__path__ = []
    api = types.ModuleType("astrbot.api")
    api.__path__ = []
    api.logger = logging.getLogger("astrbot")
    cmd_decorator = lambda name: (lambda func: func)  # noqa: E731
    tool_decorator = lambda name=None: (lambda func: setattr(func, "_tool_name", name) or func)  # noqa: E731
    event = types.ModuleType("astrbot.api.event")
    event.__path__ = []
    event.AstrMessageEvent = object
    event.filter = types.SimpleNamespace(command=cmd_decorator, llm_tool=tool_decorator)
    event.MessageChain = object
    star = types.ModuleType("astrbot.api.star")
    star.__path__ = []
    star.Context = object

    class Star:
        def __init__(self, context):
            self.context = context

    star.Star = Star
    star.register = lambda *args, **kwargs: (lambda cls: cls)
    star.StarTools = types.SimpleNamespace(get_data_dir=lambda name: str(data_dir))

    core = types.ModuleType("astrbot.core")
    core.__path__ = []
    message = types.ModuleType("astrbot.core.message")
    message.__path__ = []
    components = types.ModuleType("astrbot.core.message.components")
    components.Plain = lambda text: ("plain", text)
    result = types.ModuleType("astrbot.core.message.message_event_result")
    result.MessageChain = lambda parts: ("chain", parts)

    for name, module in {
        "astrbot": astrbot,
        "astrbot.api": api,
        "astrbot.api.event": event,
        "astrbot.api.star": star,
        "astrbot.core": core,
        "astrbot.core.message": message,
        "astrbot.core.message.components": components,
        "astrbot.core.message.message_event_result": result,
    }.items():
        sys.modules[name] = module
    astrbot.api = api
    api.event = event
    api.star = star


class FakeEvent:
    def __init__(self, text: str, session: str = "webchat:FriendMessage:test", sender: str = "42", admin: bool = True):
        self.unified_msg_origin = session
        self._text = text
        self._sender = sender
        self._admin = admin

    def get_message_str(self) -> str:
        return self._text

    def get_session_id(self) -> str:
        return self.unified_msg_origin

    def get_sender_id(self) -> str:
        return self._sender

    def is_admin(self) -> bool:
        return self._admin

    def plain_result(self, text: str) -> str:
        return text


class FakeCronManager:
    def __init__(self):
        self.jobs: list[types.SimpleNamespace] = []
        self.next_run = None

    async def list_jobs(self):
        return list(self.jobs)

    async def delete_job(self, job_id):
        self.jobs = [job for job in self.jobs if job.job_id != job_id]

    def get_next_run_time(self, job_id):
        return self.next_run

    async def add_basic_job(self, *, name, cron_expression, handler, timezone, **kwargs):
        job = types.SimpleNamespace(job_id=f"job-{len(self.jobs) + 1}", name=name, handler=handler)
        self.jobs.append(job)
        return job


class FakeContext:
    def __init__(self):
        self.cron_manager = FakeCronManager()
        self.sent: list[tuple[str, object]] = []
        self.activated: list[str] = []

    async def activate_llm_tool_async(self, name):
        self.activated.append(name)
        return True

    async def send_message(self, session, chain):
        self.sent.append((session, chain))
        return True


class PluginSurfaceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        _install_astrbot_stubs(Path(cls.tmp.name))
        cls.module = importlib.import_module("astrbot_plugin_maa_manager.main")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def make(self, **overrides):
        cfg = {
            "maa_api_base": "http://127.0.0.1:1/api/v1/public",
            "maa_api_token": "token",
            "request_timeout_seconds": 3,
            "query_admin_only": False,
            "report_enabled": False,
            "report_sessions": [],
            "control_enabled": False,
            "enable_llm_tools": False,
        }
        cfg.update(overrides)
        context = FakeContext()
        plugin = self.module.MaaManagerPlugin(context, cfg)
        asyncio.run(plugin.initialize())
        return plugin, context

    def test_parse(self):
        plugin, _ = self.make()
        self.assertEqual(plugin._parse("/maa 状态"), ("状态", []))
        self.assertEqual(plugin._parse("/maa 运行 preset-a"), ("运行", ["preset-a"]))
        self.assertEqual(plugin._parse("今天怎么样"), ("今天怎么样", []))
        self.assertEqual(plugin._parse("/maa"), ("帮助", []))

    def test_query_commands_against_fake_api(self):
        with FakeMaaApi(token="token") as api:
            plugin, _ = self.make(maa_api_base=api.base_url)
            self.assertIn("MAA 状态", asyncio.run(plugin._dispatch(FakeEvent("/maa 状态"))))
            self.assertIn("MAA 今日", asyncio.run(plugin._dispatch(FakeEvent("/maa 今日"))))
            self.assertIn("MAA 昨日", asyncio.run(plugin._dispatch(FakeEvent("/maa 昨日"))))
            self.assertIn("MAA 失败", asyncio.run(plugin._dispatch(FakeEvent("/maa 失败"))))
            self.assertIn("MAA 排程", asyncio.run(plugin._dispatch(FakeEvent("/maa 排程"))))

    def test_auth_error_is_clear(self):
        with FakeMaaApi(token="right") as api:
            plugin, _ = self.make(maa_api_base=api.base_url, maa_api_token="wrong")
            text = asyncio.run(plugin._dispatch(FakeEvent("/maa 今日")))
            self.assertIn("认证失败", text)

    def test_query_permission(self):
        with FakeMaaApi(token="token") as api:
            plugin, _ = self.make(maa_api_base=api.base_url, query_admin_only=True)
            text = asyncio.run(plugin._dispatch(FakeEvent("/maa 状态", admin=False)))
            self.assertIn("未获授权", text)

    def test_natural_language_is_not_a_control_command(self):
        with FakeMaaApi(token="token") as api:
            plugin, _ = self.make(maa_api_base=api.base_url, control_enabled=False)
            text = asyncio.run(plugin._dispatch(FakeEvent("请帮我运行账号A的预设")))
            self.assertIn("MAA 助手", text)
            self.assertNotIn("待确认操作", text)

    def test_control_disabled_message(self):
        with FakeMaaApi(token="token") as api:
            plugin, _ = self.make(maa_api_base=api.base_url)
            text = asyncio.run(plugin._dispatch(FakeEvent("/maa 运行 preset-a")))
            self.assertIn("控制功能未启用", text)

    def test_admin_session_command(self):
        with FakeMaaApi(token="token") as api:
            plugin, _ = self.make(maa_api_base=api.base_url)
            text = asyncio.run(plugin._dispatch(FakeEvent("/maa 会话", session="webchat:FriendMessage:abc")))
            self.assertIn("webchat:FriendMessage:abc", text)
            denied = asyncio.run(plugin._dispatch(FakeEvent("/maa 会话", admin=False)))
            self.assertIn("仅限管理员", denied)

    def test_only_readonly_llm_tools_are_registered(self):
        plugin, _ = self.make()
        tools = []
        for name in dir(plugin):
            attr = getattr(plugin, name)
            if callable(attr) and hasattr(attr, "_tool_name"):
                tools.append((name, attr._tool_name))
        names = {name for _, name in tools}
        self.assertEqual(names, {"maa_daily_status", "maa_queue_status"})
        for name in names:
            self.assertFalse(any(word in name for word in ("run", "pause", "resume", "cancel", "confirm")))

    def test_report_disabled_does_not_schedule(self):
        plugin, context = self.make(report_enabled=False)
        self.assertEqual(context.cron_manager.jobs, [])

    def test_report_enabled_schedules_with_tokyo_timezone(self):
        plugin, context = self.make(
            report_enabled=True,
            report_sessions=["webchat:FriendMessage:test"],
            report_time="23:00",
        )
        self.assertEqual(len(context.cron_manager.jobs), 1)
        self.assertIn("maa_daily_report", context.cron_manager.jobs[0].name)


if __name__ == "__main__":
    unittest.main()
