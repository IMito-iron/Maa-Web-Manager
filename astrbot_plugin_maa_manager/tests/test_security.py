"""Permission, confirmation-token and audit tests."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from astrbot_plugin_maa_manager.maa.security import (
    AuditLog,
    ConfirmationStore,
    PermissionPolicy,
    mask_id,
)


class PermissionTests(unittest.TestCase):
    def test_query_defaults_allow_all_but_control_is_disabled(self):
        policy = PermissionPolicy({})
        self.assertTrue(policy.query_allowed("1", "s"))
        self.assertFalse(policy.control_allowed("1", "s"))

    def test_query_admin_only(self):
        policy = PermissionPolicy({"query_admin_only": True})
        self.assertFalse(policy.query_allowed("1", "s"))
        self.assertTrue(policy.query_allowed("1", "s", is_global_admin=True))

    def test_query_session_scope(self):
        policy = PermissionPolicy({"query_allowed_sessions": ["group:1"]})
        self.assertTrue(policy.query_allowed("1", "group:1"))
        self.assertFalse(policy.query_allowed("1", "group:2"))

    def test_control_requires_enable_and_whitelist_and_session(self):
        policy = PermissionPolicy(
            {
                "control_enabled": True,
                "control_admin_ids": ["42"],
                "control_allowed_sessions": ["private:1"],
            }
        )
        self.assertTrue(policy.control_allowed("42", "private:1"))
        self.assertFalse(policy.control_allowed("42", "private:2"))
        self.assertFalse(policy.control_allowed("99", "private:1"))

    def test_control_global_admin_opt_in(self):
        policy = PermissionPolicy({"control_enabled": True, "control_admin_ids": []})
        self.assertFalse(policy.control_allowed("42", "s", is_global_admin=True))
        policy = PermissionPolicy(
            {"control_enabled": True, "control_admin_ids": [], "control_allow_global_admins": True}
        )
        self.assertTrue(policy.control_allowed("42", "s", is_global_admin=True))


class ConfirmationTests(unittest.TestCase):
    def setUp(self):
        self.now = [1000.0]
        self.store = ConfirmationStore(ttl_seconds=60, clock=lambda: self.now[0])

    def test_bound_to_user_session_action_target(self):
        proposal = self.store.issue("user1", "session1", "run", "preset-a")
        self.assertIsNone(self.store.consume(proposal.token, "user2", "session1"))
        self.assertIsNone(self.store.consume(proposal.token, "user1", "session2"))
        consumed = self.store.consume(proposal.token, "user1", "session1")
        self.assertIsNotNone(consumed)
        self.assertEqual(consumed.action, "run")
        self.assertEqual(consumed.target, "preset-a")

    def test_one_time(self):
        proposal = self.store.issue("user1", "session1", "pause", None)
        self.assertIsNotNone(self.store.consume(proposal.token, "user1", "session1"))
        self.assertIsNone(self.store.consume(proposal.token, "user1", "session1"))

    def test_expiry(self):
        proposal = self.store.issue("user1", "session1", "pause", None)
        self.now[0] += 61
        self.assertIsNone(self.store.consume(proposal.token, "user1", "session1"))

    def test_wrong_token(self):
        self.assertIsNone(self.store.consume("WRONG", "user1", "session1"))


class AuditTests(unittest.TestCase):
    def test_audit_is_redacted_and_hashed(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "audit.jsonl"
            audit = AuditLog(path)
            audit.record("run", "1161139840", "group:123", "preset-a", "success", "req1", "detail")
            line = json.loads(path.read_text(encoding="utf-8").strip())
            self.assertNotIn("1161139840", path.read_text(encoding="utf-8"))
            self.assertNotIn("group:123", path.read_text(encoding="utf-8"))
            self.assertEqual(line["target"], "preset-a")
            self.assertTrue(line["actor"].startswith("id:"))
            self.assertTrue(line["session"].startswith("session:"))

    def test_mask_is_stable(self):
        self.assertEqual(mask_id("abc"), mask_id("abc"))
        self.assertNotEqual(mask_id("abc"), mask_id("abd"))


if __name__ == "__main__":
    unittest.main()
