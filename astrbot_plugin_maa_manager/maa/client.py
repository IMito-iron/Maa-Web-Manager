"""Read-only MAA Daily API client and the shared HTTP transport.

The transport is injectable so unit tests never need the real network. Every error carries a
stable ``kind`` used by the formatter to produce a clear Chinese message; secrets and response
bodies are never included in exceptions.
"""

from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlencode, urlsplit


class MaaApiError(Exception):
    """A classified API failure. The message is safe to show to users."""

    KINDS = ("config", "auth", "timeout", "unavailable", "http", "invalid")

    def __init__(self, kind: str, status: int | None = None, detail: str = ""):
        self.kind = kind if kind in self.KINDS else "unavailable"
        self.status = status
        self.detail = detail
        super().__init__(f"{self.kind} status={status}")

    def user_message(self) -> str:
        if self.kind == "config":
            return "MAA API 未配置：请先在插件配置中设置 Token。"
        if self.kind == "auth":
            return "MAA API 认证失败（401/403）：Token 无效或已轮换，请更新插件配置。"
        if self.kind == "timeout":
            return "MAA API 请求超时：服务暂时无响应，请稍后重试。"
        if self.kind == "unavailable":
            return "MAA API 暂不可用：无法连接或服务异常，请稍后重试。"
        if self.kind == "invalid":
            return "MAA API 返回了无法解析的数据；状态未知，未编造结果。"
        if self.status is not None:
            return f"MAA API 返回异常状态 {self.status}；当前状态未知。"
        return "MAA API 请求失败；当前状态未知。"


@dataclass(slots=True)
class HttpResponse:
    status: int
    body: str
    headers: dict[str, str]


class UrllibTransport:
    """Blocking urllib wrapped in a worker thread; no extra dependencies."""

    async def request(
        self,
        method: str,
        url: str,
        headers: dict[str, str],
        body: bytes | None,
        timeout: float,
    ) -> HttpResponse:
        return await asyncio.to_thread(self._request_sync, method, url, headers, body, timeout)

    @staticmethod
    def _request_sync(
        method: str,
        url: str,
        headers: dict[str, str],
        body: bytes | None,
        timeout: float,
    ) -> HttpResponse:
        request = urllib.request.Request(url=url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = response.read(2 * 1024 * 1024).decode("utf-8", errors="replace")
                return HttpResponse(
                    status=int(response.status),
                    body=payload,
                    headers={key.lower(): value for key, value in response.headers.items()},
                )
        except urllib.error.HTTPError as error:
            try:
                raw = error.read(512 * 1024).decode("utf-8", errors="replace")
                headers = {key.lower(): value for key, value in (error.headers or {}).items()}
            finally:
                error.close()
            return HttpResponse(status=int(error.code), body=raw, headers=headers)
        except TimeoutError as error:  # pragma: no cover - platform dependent
            raise MaaApiError("timeout") from error
        except urllib.error.URLError as error:
            reason = error.reason
            if isinstance(reason, TimeoutError):  # pragma: no cover - platform dependent
                raise MaaApiError("timeout") from error
            raise MaaApiError("unavailable") from error

    async def get_json(self, url: str, headers: dict[str, str], timeout: float) -> tuple[int, Any]:
        response = await self.request("GET", url, headers, None, timeout)
        return response.status, _decode(response)


def _decode(response: HttpResponse) -> Any:
    try:
        return json.loads(response.body) if response.body else None
    except json.JSONDecodeError:
        return _UNPARSEABLE


_UNPARSEABLE = object()


def build_urls(base: str, path: str) -> str:
    return base.rstrip("/") + "/" + path.lstrip("/")


def resolve_token(config: dict[str, Any]) -> str:
    """Resolve the token from a controlled file first, then the plugin config."""
    token_file = str(config.get("maa_api_token_file") or "").strip()
    if token_file:
        try:
            with open(token_file, encoding="utf-8") as handle:
                value = handle.read().strip()
            if value:
                return value
        except OSError:
            pass
    return str(config.get("maa_api_token") or "").strip()


def _validate_base(base: str) -> str:
    parsed = urlsplit(base)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise MaaApiError("config")
    return base.rstrip("/")


class MaaDailyClient:
    """GET-only client for the two public Manager endpoints."""

    def __init__(
        self,
        base_url: str,
        token: str,
        timeout: float = 12.0,
        transport: UrllibTransport | None = None,
    ):
        self.base_url = _validate_base(base_url)
        self._token = token
        self.timeout = max(3.0, min(60.0, float(timeout)))
        self.transport = transport or UrllibTransport()

    @classmethod
    def from_config(cls, config: dict[str, Any], transport: UrllibTransport | None = None) -> "MaaDailyClient":
        token = resolve_token(config)
        if not token:
            raise MaaApiError("config")
        base = str(config.get("maa_api_base") or "https://maa.example.com/api/v1/public")
        timeout = float(config.get("request_timeout_seconds") or 12)
        return cls(base, token, timeout, transport)

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._token}",
            "Accept": "application/json",
            "User-Agent": "astrbot-plugin-maa-manager/1.0",
        }

    async def _get(self, path: str) -> Any:
        url = build_urls(self.base_url, path)
        try:
            status, payload = await self.transport.get_json(url, self._headers(), self.timeout)
        except MaaApiError:
            raise
        except Exception as error:  # pragma: no cover - defensive
            raise MaaApiError("unavailable") from error
        if status in (401, 403):
            raise MaaApiError("auth", status)
        if status == 429:
            raise MaaApiError("http", status)
        if status >= 500:
            raise MaaApiError("unavailable", status)
        if status != 200:
            raise MaaApiError("http", status)
        if payload is _UNPARSEABLE or not isinstance(payload, dict):
            raise MaaApiError("invalid", status)
        return payload

    async def health(self) -> dict[str, Any]:
        return await self._get("health")

    async def daily_status(self, date_key: str | None = None) -> dict[str, Any]:
        query = ""
        if date_key:
            query = "?" + urlencode({"date": date_key}, quote_via=quote)
        return await self._get("daily-status" + query)
