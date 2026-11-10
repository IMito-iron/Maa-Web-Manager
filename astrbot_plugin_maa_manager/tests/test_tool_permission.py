"""Regression tests for LLM tool query permission."""

from __future__ import annotations

import asyncio
import unittest

from astrbot_plugin_maa_manager.tests.fakes import FakeMaaApi
from astrbot_plugin_maa_manager.tests.test_plugin_surface import FakeEvent, PluginSurfaceTests


class ToolPermissionTests(PluginSurfaceTests):
    def test_llm_tools_deny_when_query_permission_denied(self):
        with FakeMaaApi(token="token") as api:
            plugin, _ = self.make(maa_api_base=api.base_url, query_admin_only=True)
            event = FakeEvent("", admin=False)
            self.assertIn("未获授权", asyncio.run(plugin.maa_daily_status(event)))
            self.assertIn("未获授权", asyncio.run(plugin.maa_queue_status(event)))

    def test_llm_tools_allow_when_permitted(self):
        with FakeMaaApi(token="token") as api:
            plugin, _ = self.make(maa_api_base=api.base_url)
            event = FakeEvent("", admin=False)
            text = asyncio.run(plugin.maa_queue_status(event))
            self.assertIn("MAA 状态", text)


if __name__ == "__main__":
    unittest.main()
