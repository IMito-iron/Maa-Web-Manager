"""Internal-only Manager control adapter with mandatory two-step confirmation.

The adapter talks to the Manager through the internal gateway URL (default
``http://maa-manager-gateway:8080``) and never through the public HTTPS origin. Manager requires
same-origin JSON requests; the plugin sends the configured Origin, ``X-Maa-Request`` and JSON body.
Write operations are proposal -> explicit confirmation -> single execution; timeouts are resolved by
querying current state, never by blindly repeating the write.
"""

from __future__ import annotations

import asyncio
import json
import logging
import urllib.error
from typing import Any
from urllib.parse import quote, urlsplit

from .client import HttpResponse, UrllibTransport
from .security import AuditLog, ConfirmationStore, PermissionPolicy

logger = logging.getLogger(__name__)

CONTROL_ACTIONS = ("run", "pause", "resume", "cancel")
TERMINAL_RUN_STATUSES = {"success", "success_unconfirmed", "failed", "cancelled", "skipped", "interrupted", "unknown"}


class ControlError(Exception):
    def __init__(self, kind: str, message: str = ""):
        self.kind = kind
        self.message = message or self._default(kind)
        super().__init__(self.message)

    @staticmethod
    def _default(kind: str) -> str:
        return {
            "config": "控制接口未正确配置。",
            "auth": "控制接口认证失败。",
            "forbidden": "控制请求被 Manager 拒绝（403）。",
            "timeout": "控制请求超时；正在查询实际状态，不会自动重复提交。",
            "unavailable": "无法连接内部 Manager 控制接口。",
            "http": "控制接口返回异常状态。",
            "invalid": "控制接口返回了无法解析的数据。",
            "permission": "没有控制权限。",
            "disabled": "控制功能未启用。",
            "precheck": "当前状态不满足控制条件。",
            "confirm": "确认令牌无效、已使用或已过期。",
        }.get(kind, "控制请求失败。")

    def user_message(self) -> str:
        return self.message


class ManagerControlClient:
    def __init__(
        self,
        base_url: str,
        public_origin: str,
        timeout: float = 10.0,
        transport: UrllibTransport | None = None,
    ):
        parsed = urlsplit(base_url.rstrip("/"))
        origin = urlsplit(public_origin)
        if parsed.scheme != "http" or not parsed.hostname:
            raise ControlError("config", "控制地址必须是内网 http 地址（禁止使用公网 HTTPS）。")
        if origin.hostname and parsed.hostname == origin.hostname:
            raise ControlError("config", "控制地址不能是公网域名；请使用内部 gateway/portal 地址。")
        self.base_url = base_url.rstrip("/")
        self.public_origin = public_origin.rstrip("/")
        self.timeout = max(3.0, min(60.0, float(timeout)))
        self.transport = transport or UrllibTransport()

    def _headers(self) -> dict[str, str]:
        return {
            "Origin": self.public_origin,
            "X-Maa-Request": "1",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "astrbot-plugin-maa-manager/1.0",
        }

    async def _request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        url = self.base_url + path
        try:
            response: HttpResponse = await self.transport.request(
                method, url, self._headers(), body, self.timeout
            )
        except Exception as error:
            if isinstance(error, ControlError):
                raise
            raise ControlError("timeout" if "timed out" in str(error).lower() else "unavailable") from error
        if response.status in (401, 403):
            raise ControlError("auth" if response.status == 401 else "forbidden")
        if response.status == 405:
            raise ControlError("http", "控制接口方法不允许（405）。")
        if response.status >= 500:
            raise ControlError("unavailable", f"控制接口异常（{response.status}）。")
        if response.status >= 400:
            raise ControlError("http", f"控制接口拒绝请求（{response.status}）。")
        text = response.body.strip()
        if not text:
            return {}
        try:
            return json.loads(text)
        except json.JSONDecodeError as error:
            raise ControlError("invalid") from error

    async def status(self) -> dict[str, Any]:
        data = await self._request("GET", "/api/status")
        return data if isinstance(data, dict) else {}

    async def queue(self) -> dict[str, Any]:
        data = await self._request("GET", "/api/queue")
        return data if isinstance(data, dict) else {}

    async def tasks(self) -> list[dict[str, Any]]:
        data = await self._request("GET", "/api/tasks")
        if isinstance(data, list):
            return [item for item in data if isinstance(item, dict)]
        if isinstance(data, dict) and isinstance(data.get("items"), list):
            return [item for item in data["items"] if isinstance(item, dict)]
        return []

    async def run_task(self, task_name: str) -> Any:
        return await self._request("POST", f"/api/tasks/{quote(task_name, safe='')}/run", {})

    async def pause(self) -> Any:
        return await self._request("POST", "/api/queue", {"action": "pause"})

    async def resume(self) -> Any:
        return await self._request("POST", "/api/queue", {"action": "resume"})

    async def stop_run(self, run_id: str) -> Any:
        return await self._request("POST", f"/api/runs/{quote(run_id, safe='')}/stop", {})

    async def recent_runs(self, limit: int = 50) -> list[dict[str, Any]]:
        data = await self._request("GET", f"/api/runs?limit={int(limit)}")
        if isinstance(data, dict) and isinstance(data.get("items"), list):
            data = data["items"]
        return [item for item in data if isinstance(item, dict)] if isinstance(data, list) else []

    async def find_run(self, run_id: str) -> dict[str, Any] | None:
        for run in await self.recent_runs(80):
            if str(run.get("id") or run.get("runId")) == str(run_id):
                return run
        return None


class ControlService:
    def __init__(
        self,
        client: ManagerControlClient,
        policy: PermissionPolicy,
        confirmations: ConfirmationStore,
        audit: AuditLog,
        clock: Any = None,
    ):
        self.client = client
        self.policy = policy
        self.confirmations = confirmations
        self.audit = audit

    # ------------------------------------------------------------- proposals
    async def propose(
        self,
        actor_id: str,
        session: str,
        action: str,
        target: str | None = None,
        is_global_admin: bool = False,
    ) -> tuple[bool, str]:
        action = str(action or "").strip().lower()
        if action not in CONTROL_ACTIONS:
            return False, "未知控制操作。"
        if not self.policy.control_enabled:
            return False, "控制功能未启用（control_enabled=false）。"
        if not self.policy.control_allowed(actor_id, session, is_global_admin):
            self.audit.record(action, actor_id, session, target, "denied")
            return False, "没有控制权限：需要管理员用户白名单，且当前会话在允许范围内。"
        target = str(target or "").strip() or None
        if action in ("run", "cancel") and not target:
            return False, "缺少目标：" + ("预设名" if action == "run" else "运行 ID")
        try:
            precheck = await self._precheck(action, target)
        except ControlError as error:
            self.audit.record(action, actor_id, session, target, "precheck_failed", detail=error.kind)
            return False, error.user_message()
        if precheck != "ok":
            return False, precheck
        proposal = self.confirmations.issue(actor_id, session, action, target)
        self.audit.record(action, actor_id, session, target, "proposed", request_id=proposal.request_id)
        description = self._describe(action, target)
        return True, (
            f"✅ 待确认操作：{description}\n"
            f"请在 {self.confirmations.ttl} 秒内由同一用户在同一会话回复：\n"
            f"/maa 确认 {proposal.token}\n"
            "该令牌一次性有效；过期或换人/换会话均不可用。"
        )

    async def confirm(
        self, actor_id: str, session: str, token: str, is_global_admin: bool = False
    ) -> tuple[bool, str]:
        if not self.policy.control_enabled:
            return False, "控制功能未启用。"
        if not self.policy.control_allowed(actor_id, session, is_global_admin):
            self.audit.record("confirm", actor_id, session, None, "denied")
            return False, "没有控制权限。"
        proposal = self.confirmations.consume(token, actor_id, session)
        if proposal is None:
            self.audit.record("confirm", actor_id, session, None, "invalid_token")
            return False, "确认令牌无效、已使用、已过期，或不属于当前用户/会话。"
        try:
            ok, message = await self._execute(proposal.action, proposal.target)
        except ControlError as error:
            self.audit.record(
                proposal.action, actor_id, session, proposal.target, "error",
                request_id=proposal.request_id, detail=error.kind,
            )
            return False, error.user_message()
        self.audit.record(
            proposal.action, actor_id, session, proposal.target,
            "success" if ok else "failed", request_id=proposal.request_id,
        )
        return ok, message

    # --------------------------------------------------------------- precheck
    async def _precheck(self, action: str, target: str | None) -> str:
        status = await self.client.status()
        queue = status.get("queue") if isinstance(status.get("queue"), dict) else await self.client.queue()
        paused = bool(queue.get("paused"))
        blocked = bool(queue.get("blocked"))
        current = status.get("deviceState") or status.get("device") or ""
        healthy = all(status.get(key) is True for key in ("adb", "android", "maa"))
        if action == "run":
            if paused:
                return "队列已暂停，请先 /maa 恢复。"
            if blocked:
                return "队列当前受阻，请先在 MAA 控制台处理告警。"
            if not healthy:
                return "设备或 MAA 服务未就绪（ADB/Android/MAA 检查失败）。"
            tasks = await self.client.tasks()
            names = {str(task.get("name")) for task in tasks}
            if target not in names:
                return f"预设不存在：{target}（共 {len(names)} 个可用预设）。"
            items = queue.get("items") if isinstance(queue.get("items"), list) else []
            if any(isinstance(item, dict) and str(item.get("task") or item.get("name")) == target for item in items):
                return "该预设已在队列中，无需重复提交。"
            return "ok"
        if action == "pause":
            if paused:
                return "队列已处于暂停状态，无需再次暂停。"
            return "ok"
        if action == "resume":
            if blocked:
                return "队列受阻，恢复前需要先处理告警。"
            if not paused:
                return "队列当前未暂停。"
            return "ok"
        if action == "cancel":
            run = await self.client.find_run(target or "")
            if run is None:
                return f"找不到运行记录：{target}"
            run_status = str(run.get("status") or run.get("outcome") or "")
            if run_status and run_status not in ("queued", "running"):
                return f"运行 {target} 已结束（{run_status}），无需取消。"
            return "ok"
        return "未知操作。"

    # -------------------------------------------------------------- execution
    async def _execute(self, action: str, target: str | None) -> tuple[bool, str]:
        if action == "run":
            return await self._execute_run(target or "")
        if action == "pause":
            return await self._execute_pause_resume(expect_paused=True)
        if action == "resume":
            return await self._execute_pause_resume(expect_paused=False)
        if action == "cancel":
            return await self._execute_cancel(target or "")
        return False, "未知操作。"

    async def _execute_run(self, task_name: str) -> tuple[bool, str]:
        # Re-check right before executing; the state may have changed since the proposal.
        precheck = await self._precheck("run", task_name)
        if precheck != "ok":
            return False, precheck
        queue_before = await self.client.queue()
        before_ids = self._queue_ids(queue_before)
        try:
            result = await self.client.run_task(task_name)
        except ControlError as error:
            if error.kind in ("timeout", "unavailable"):
                found = await self._poll_for_new_queue_item(task_name, before_ids, timeout=10.0)
                if found:
                    return True, f"已入队（服务响应超时，但已在队列中确认）：{task_name}"
                return False, "提交结果未确认：请求可能已到达 Manager，但未在队列中观察到；未重复提交，请用 /maa 状态 检查后再决定。"
            raise
        run_id = self._extract_run_id(result)
        if run_id:
            return True, f"已加入执行队列：{task_name}（运行 ID {run_id}）。"
        return True, f"已加入执行队列：{task_name}。当前状态请用 /maa 状态 查看。"

    async def _execute_pause_resume(self, expect_paused: bool) -> tuple[bool, str]:
        label = "暂停" if expect_paused else "恢复"
        queue = await self.client.queue()
        if bool(queue.get("paused")) == expect_paused:
            return True, f"队列已经是{'暂停' if expect_paused else '运行'}状态（无需操作）。"
        try:
            if expect_paused:
                await self.client.pause()
            else:
                await self.client.resume()
        except ControlError as error:
            if error.kind in ("timeout", "unavailable"):
                current = await self._poll_queue_paused(expect_paused, timeout=8.0)
                if current is True:
                    return True, f"已{label}（响应超时，但队列状态已确认）。"
                return False, f"{label}结果未确认：未观察到预期状态；未重复提交，请用 /maa 状态 检查。"
            raise
        verified = await self._poll_queue_paused(expect_paused, timeout=8.0)
        if verified is True:
            return True, f"已{label}，并已验证队列状态。"
        return False, f"{label}请求已发送，但状态验证未通过；请用 /maa 状态 检查。"

    async def _execute_cancel(self, run_id: str) -> tuple[bool, str]:
        run = await self.client.find_run(run_id)
        if run is None:
            return False, f"找不到运行记录：{run_id}"
        run_status = str(run.get("status") or run.get("outcome") or "")
        if run_status and run_status not in ("queued", "running"):
            return True, f"运行 {run_id} 已结束（{run_status}），无需取消。"
        try:
            await self.client.stop_run(run_id)
        except ControlError as error:
            if error.kind in ("timeout", "unavailable"):
                if await self._poll_run_terminal(run_id, timeout=8.0):
                    return True, f"已取消运行 {run_id}（响应超时，但状态已确认）。"
                return False, "取消结果未确认：未重复提交；请用 /maa 状态 检查后再决定。"
            raise
        if await self._poll_run_terminal(run_id, timeout=10.0):
            return True, f"已取消运行 {run_id}，并已验证进入结束状态。"
        return False, f"取消请求已发送，但未验证到结束状态；请用 /maa 状态 检查。"

    # ----------------------------------------------------------------- helpers
    @staticmethod
    def _queue_ids(queue: dict[str, Any]) -> set[str]:
        items = queue.get("items") if isinstance(queue.get("items"), list) else []
        ids: set[str] = set()
        for item in items:
            if isinstance(item, dict):
                value = item.get("id") or item.get("runId")
                if value:
                    ids.add(str(value))
        return ids

    @staticmethod
    def _extract_run_id(result: Any) -> str:
        if isinstance(result, dict):
            for key in ("runId", "id", "run_id"):
                if result.get(key):
                    return str(result[key])
            for value in result.values():
                if isinstance(value, dict):
                    found = ControlService._extract_run_id(value)
                    if found:
                        return found
        return ""

    async def _poll_for_new_queue_item(self, task_name: str, before_ids: set[str], timeout: float) -> bool:
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            try:
                queue = await self.client.queue()
            except ControlError:
                return False
            items = queue.get("items") if isinstance(queue.get("items"), list) else []
            for item in items:
                if not isinstance(item, dict):
                    continue
                item_id = str(item.get("id") or item.get("runId") or "")
                if item_id and item_id not in before_ids and str(item.get("task") or item.get("name")) == task_name:
                    return True
            await asyncio.sleep(0.8)
        return False

    async def _poll_queue_paused(self, expect_paused: bool, timeout: float) -> bool | None:
        deadline = asyncio.get_running_loop().time() + timeout
        last: bool | None = None
        while asyncio.get_running_loop().time() < deadline:
            try:
                queue = await self.client.queue()
                last = bool(queue.get("paused"))
                if last == expect_paused:
                    return True
            except ControlError:
                return None
            await asyncio.sleep(0.6)
        return False if last is not None else None

    async def _poll_run_terminal(self, run_id: str, timeout: float) -> bool:
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            try:
                run = await self.client.find_run(run_id)
            except ControlError:
                return False
            if run is None:
                await asyncio.sleep(0.8)
                continue
            status = str(run.get("status") or run.get("outcome") or "")
            if status in TERMINAL_RUN_STATUSES:
                return True
            await asyncio.sleep(0.8)
        return False

    @staticmethod
    def _describe(action: str, target: str | None) -> str:
        if action == "run":
            return f"运行预设 {target}"
        if action == "pause":
            return "暂停 Manager 派发队列"
        if action == "resume":
            return "恢复 Manager 派发队列"
        if action == "cancel":
            return f"取消运行 {target}"
        return action
