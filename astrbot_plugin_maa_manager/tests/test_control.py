"""Control adapter tests against a fake Manager: permissions, confirmation, idempotency."""

from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from astrbot_plugin_maa_manager.maa.client import MaaApiError, UrllibTransport
from astrbot_plugin_maa_manager.maa.control import (
    ControlError,
    ControlService,
    ManagerControlClient,
)
from astrbot_plugin_maa_manager.maa.security import AuditLog, ConfirmationStore, PermissionPolicy
from astrbot_plugin_maa_manager.tests.fakes import FakeManager


def policy(**overrides):
    cfg = {
        "control_enabled": True,
        "control_admin_ids": ["42"],
        "control_allowed_sessions": ["session1"],
    }
    cfg.update(overrides)
    return PermissionPolicy(cfg)


class ServiceCase(unittest.TestCase):
    def setUp(self):
        self.manager = FakeManager().__enter__()
        self.addCleanup(self.manager.__exit__, None, None, None)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.audit_path = Path(self.tmp.name) / "audit.jsonl"
        self.client = ManagerControlClient(
            self.manager.base_url, "https://maa.test", timeout=5
        )
        self.service = ControlService(
            self.client,
            policy(),
            ConfirmationStore(90),
            AuditLog(self.audit_path),
        )

    def propose(self, action, target=None, actor="42", session="session1"):
        return asyncio.run(self.service.propose(actor, session, action, target))

    def confirm(self, token, actor="42", session="session1"):
        return asyncio.run(self.service.confirm(actor, session, token))


class ProposeTests(ServiceCase):
    def test_permission_denied(self):
        ok, message = self.propose("run", "preset-demo02", actor="99")
        self.assertFalse(ok)
        self.assertIn("权限", message)

    def test_session_scope_denied(self):
        ok, message = self.propose("run", "preset-demo02", session="other")
        self.assertFalse(ok)
        self.assertIn("权限", message)

    def test_control_disabled(self):
        self.service.policy = policy(control_enabled=False)
        ok, message = self.propose("run", "preset-demo02")
        self.assertFalse(ok)
        self.assertIn("未启用", message)

    def test_run_proposal_includes_one_time_code(self):
        ok, message = self.propose("run", "preset-demo02")
        self.assertTrue(ok)
        self.assertIn("/maa 确认", message)
        token = message.split("/maa 确认 ")[1].split()[0]
        ok2, message2 = self.confirm(token)
        self.assertTrue(ok2)
        self.assertIn("已加入执行队列", message2)
        self.assertEqual(self.manager.calls[-1]["method"], "POST")
        self.assertEqual(self.manager.calls[-1]["origin"], "https://maa.test")
        self.assertEqual(self.manager.calls[-1]["maa"], "1")
        self.assertTrue(any(item["task"] == "preset-demo02" for item in self.manager.queue_items))

    def test_unknown_preset_rejected(self):
        ok, message = self.propose("run", "missing")
        self.assertFalse(ok)
        self.assertIn("预设不存在", message)

    def test_paused_queue_rejects_run(self):
        self.manager.paused = True
        ok, message = self.propose("run", "preset-demo02")
        self.assertFalse(ok)
        self.assertIn("暂停", message)

    def test_blocked_queue_rejects(self):
        self.manager.blocked = True
        ok, message = self.propose("run", "preset-demo02")
        self.assertFalse(ok)
        self.assertIn("受阻", message)

    def test_unhealthy_rejects(self):
        self.manager.health["adb"] = False
        ok, message = self.propose("run", "preset-demo02")
        self.assertFalse(ok)
        self.assertIn("未就绪", message)

    def test_duplicate_task_rejected(self):
        self.manager.queue_items.append({"id": "r0", "task": "preset-demo02"})
        ok, message = self.propose("run", "preset-demo02")
        self.assertFalse(ok)
        self.assertIn("已在队列", message)

    def test_pause_when_already_paused_is_noop(self):
        self.manager.paused = True
        ok, message = self.propose("pause")
        self.assertFalse(ok)
        self.assertIn("已处于暂停", message)

    def test_resume_when_running_is_noop(self):
        ok, message = self.propose("resume")
        self.assertFalse(ok)
        self.assertIn("未暂停", message)


class ConfirmTests(ServiceCase):
    def token_for(self, action, target=None):
        ok, message = self.propose(action, target)
        self.assertTrue(ok, message)
        return message.split("/maa 确认 ")[1].split()[0]

    def test_token_wrong_user_or_session(self):
        self.service.policy = PermissionPolicy(
            {
                "control_enabled": True,
                "control_admin_ids": ["42", "43"],
                "control_allowed_sessions": ["session1", "session2"],
            }
        )
        token = self.token_for("pause")
        ok, message = self.confirm(token, actor="43")
        self.assertFalse(ok)
        self.assertIn("无效", message)
        ok, message = self.confirm(token, session="session2")
        self.assertFalse(ok)
        self.assertIn("无效", message)

    def test_token_is_one_time(self):
        token = self.token_for("pause")
        ok, _ = self.confirm(token)
        self.assertTrue(ok)
        ok2, message2 = self.confirm(token)
        self.assertFalse(ok2)
        self.assertIn("无效", message2)

    def test_pause_and_resume_verified(self):
        token = self.token_for("pause")
        ok, message = self.confirm(token)
        self.assertTrue(ok)
        self.assertTrue(self.manager.paused)
        self.assertIn("暂停", message)
        token = self.token_for("resume")
        ok, message = self.confirm(token)
        self.assertTrue(ok)
        self.assertFalse(self.manager.paused)

    def test_cancel_run(self):
        self.manager.runs = [{"id": "run-x", "task": "preset-demo02", "status": "running", "outcome": "running"}]
        token = self.token_for("cancel", "run-x")
        ok, message = self.confirm(token)
        self.assertTrue(ok)
        self.assertEqual(self.manager.runs[0]["status"], "cancelled")
        self.assertIn("已取消", message)

    def test_cancel_finished_run_is_noop(self):
        self.manager.runs = [{"id": "run-x", "task": "preset-demo02", "status": "success", "outcome": "success"}]
        ok, message = self.propose("cancel", "run-x")
        self.assertFalse(ok)
        self.assertIn("已结束", message)

    def test_write_error_reported_without_retry(self):
        self.manager.fail_next_write = True
        token = self.token_for("pause")
        ok, message = self.confirm(token)
        self.assertFalse(ok)
        self.assertIn("未确认", message)
        posts = [call for call in self.manager.calls if call["method"] == "POST"]
        self.assertEqual(len(posts), 1)

    def test_timeout_after_write_is_resolved_by_query_without_duplicate(self):
        class DropPostResponse(UrllibTransport):
            def __init__(self):
                self.dropped = False

            async def request(self, method, url, headers, body, timeout):
                response = await super().request(method, url, headers, body, timeout)
                if method == "POST" and not self.dropped:
                    self.dropped = True
                    raise ControlError("timeout")
                return response

        transport = DropPostResponse()
        self.client.transport = transport
        token = self.token_for("run", "preset-demo02")
        ok, message = self.confirm(token)
        self.assertTrue(ok)
        self.assertIn("确认", message)
        posts = [call for call in self.manager.calls if call["method"] == "POST"]
        self.assertEqual(len(posts), 1)

    def test_audit_redacts_actor_and_session(self):
        token = self.token_for("pause")
        self.confirm(token)
        text = self.audit_path.read_text(encoding="utf-8")
        self.assertNotIn("1161139840", text)
        self.assertNotIn("session1", text)
        self.assertIn("pause", text)

    def test_control_url_must_be_internal_http(self):
        with self.assertRaises(ControlError):
            ManagerControlClient("https://maa.test", "https://maa.test")
        with self.assertRaises(ControlError):
            ManagerControlClient("http://maa.example.com:8080", "https://maa.example.com")


if __name__ == "__main__":
    unittest.main()
