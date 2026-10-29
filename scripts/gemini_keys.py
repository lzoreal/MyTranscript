"""Gemini 多 key 的顺序轮换：配额/鉴权失败就切下一把，全部耗尽即停。

轮换状态只在进程内有效——配额按天重置，跨轮沿用会把恢复的 key 永久排除。
"""

from __future__ import annotations

import re
from typing import Any, Callable

QUOTA_MARKERS = (
    "resource_exhausted",
    "quota exceeded",
    "exceeded your current quota",
    "insufficient quota",
    "quota limit",
)

AUTH_MARKERS = ("api_key_invalid", "api key not valid")


class QuotaExhausted(RuntimeError):
    """所有 Gemini key 都用尽；调用方应停止本轮、下轮再续。"""


class GeminiAuthFailed(RuntimeError):
    """轮换过的 key 全因鉴权失败被换掉：配置无效，任务应失败而不是安静暂停。"""


def parse_gemini_keys(raw: str) -> list[str]:
    keys: list[str] = []
    for part in re.split(r"[,\s]+", raw or ""):
        key = part.strip()
        if key and key not in keys:
            keys.append(key)
    return keys


def _default_factory(api_key: str):
    from google import genai

    return genai.Client(api_key=api_key)


class GeminiKeyRing:
    """顺序轮换 key：同一时刻只用一把，耗尽就切下一把。"""

    def __init__(
        self,
        keys: list[str],
        factory: Callable[[str], Any] | None = None,
        start: int = 0,
    ):
        if not keys:
            raise QuotaExhausted("没有任何可用的 Gemini key")
        self._keys = list(keys)
        self._clients: dict[str, Any] = {}
        # 各分片从不同的 key 起跑，否则所有 job 同时压在同一把 key 上。
        self._index = int(start) % len(self._keys)
        self._factory = factory or _default_factory
        self.requests = 0
        # 已用掉的"全 key 429 冷却"次数（每进程上限，防止每日额度用完后一直等）
        self.cooldowns = 0
        # 每次切换的原因（"quota" / "auth"）：最后一次的原因决定是"配额用完"还是"key 全被拒"
        self.switch_kinds: list[str] = []

    def __len__(self) -> int:
        return len(self._keys)

    @property
    def available(self) -> bool:
        return self._index < len(self._keys)

    def label(self) -> str:
        if not self.available:
            return "#-（…****）"
        key = self._keys[self._index]
        tail = key[-4:] if len(key) > 4 else "****"
        return f"#{self._index + 1}（…{tail}）"

    def current(self) -> str:
        if not self.available:
            raise QuotaExhausted("所有 Gemini key 都已耗尽")
        return self._keys[self._index]

    def client(self):
        if not self.available:
            raise QuotaExhausted("所有 Gemini key 都已耗尽")
        key = self._keys[self._index]
        if key not in self._clients:
            self._clients[key] = self._factory(key)
        return self._clients[key]

    def mark_exhausted(self) -> bool:
        self._index += 1
        return self.available

    def rewind(self) -> None:
        """全部 429 之后隔一会儿重来：RPM 限流会自己恢复，换 key 换不掉它。"""
        self._index = 0


def is_quota_error(exc: Exception) -> bool:
    text = str(exc).lower()
    code = getattr(exc, "code", None) or getattr(exc, "status_code", None)
    if code in (429, "429", "RESOURCE_EXHAUSTED"):
        return True
    return any(marker in text for marker in QUOTA_MARKERS)


def is_auth_error(exc: Exception) -> bool:
    text = str(exc).lower()
    code = getattr(exc, "code", None) or getattr(exc, "status_code", None)
    if code in (401, 403, "401", "403", "PERMISSION_DENIED", "UNAUTHENTICATED"):
        return True
    if code in (400, "400") and "api key" in text:
        return True
    return any(marker in text for marker in AUTH_MARKERS)
