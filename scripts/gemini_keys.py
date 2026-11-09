"""Gemini 配额桶（模型 × key）的顺序轮换：耗尽就切下一桶，全部用尽即停。

日额度按 (key, model) 分开计，轮换表上每个模型都是一份额度：一个模型的 key
全用完只是少了一份，要等所有模型都用完才算本轮真的没额度。
轮换状态只在进程内有效——配额按天重置，跨轮沿用会把恢复的 key 永久排除。
"""

from __future__ import annotations

import os
import re
from typing import Any, Callable

DEFAULT_MODEL = "gemini-3.1-flash-lite"

QUOTA_MARKERS = (
    "resource_exhausted",
    "quota exceeded",
    "exceeded your current quota",
    "insufficient quota",
    "quota limit",
)

AUTH_MARKERS = ("api_key_invalid", "api key not valid")


class QuotaExhausted(RuntimeError):
    """轮换表上所有模型的所有 key 都用尽；调用方应停止本轮、下轮再续。"""


class GeminiAuthFailed(RuntimeError):
    """轮换过的 key 全因鉴权失败被换掉：配置无效，任务应失败而不是安静暂停。"""


def parse_gemini_keys(raw: str) -> list[str]:
    keys: list[str] = []
    for part in re.split(r"[,\s]+", raw or ""):
        key = part.strip()
        if key and key not in keys:
            keys.append(key)
    return keys


def gemini_models() -> list[str]:
    """轮换的模型表：GEMINI_MODELS 优先，没配就退回单个 GEMINI_MODEL。"""
    models = parse_gemini_keys(os.getenv("GEMINI_MODELS", ""))
    if models:
        return models
    return [(os.getenv("GEMINI_MODEL", "") or "").strip() or DEFAULT_MODEL]


GEMINI_TIMEOUT_MS = max(1000, int(os.getenv("GEMINI_TIMEOUT_MS", "120000")))


def _default_factory(api_key: str):
    from google import genai
    from google.genai import types

    # SDK 默认不设请求超时：Gemini 卡住不回包时，一集能把整个 6 小时 job 耗光。
    return genai.Client(
        api_key=api_key,
        http_options=types.HttpOptions(timeout=GEMINI_TIMEOUT_MS),
    )


class GeminiKeyRing:
    """顺序轮换配额桶：同一时刻只用一个 (model, key)，耗尽就切下一个。"""

    def __init__(
        self,
        keys: list[str],
        factory: Callable[[str], Any] | None = None,
        start: int = 0,
        models: list[str] | None = None,
        dead: dict[str | None, set[str]] | None = None,
    ):
        if not keys:
            raise QuotaExhausted("没有任何可用的 Gemini key")
        self._keys = list(keys)
        # 先走完一个模型的所有 key 再换模型：日额度是整块没的，同模型内换 key 救不回来。
        # models=None 表示调用方自己带模型名（如 translate_vtt），桶只按 key 分。
        # dead 按模型给出"已判死"的 key：同一个 job 里反复新建环时直接跳过，
        # 否则每批都会从 #1 重新撞一遍 429。
        dead = dead or {}
        self._slots = [
            (model, key)
            for model in (models or [None])
            for key in self._keys
            if key not in dead.get(model, ())
        ]
        self._clients: dict[str, Any] = {}
        # 各分片从不同的桶起跑，否则所有 job 同时压在同一把 key 上。
        self._index = int(start) % len(self._slots) if self._slots else 0
        self._factory = factory or _default_factory
        self.requests = 0
        # 已用掉的"全 key 429 冷却"次数（每进程上限，防止每日额度用完后一直等）
        self.cooldowns = 0
        # 每次切换的原因（"quota" / "auth"）：最后一次的原因决定是"配额用完"还是"key 全被拒"
        self.switch_kinds: list[str] = []

    def __len__(self) -> int:
        return len(self._slots)

    @property
    def available(self) -> bool:
        return self._index < len(self._slots)

    def label(self) -> str:
        if not self.available:
            return "#-（…****）"
        model, key = self._slots[self._index]
        tail = key[-4:] if len(key) > 4 else "****"
        return f"#{self._index + 1}（{f'{model} ' if model else ''}…{tail}）"

    def _current(self) -> tuple[str | None, str]:
        if not self.available:
            raise QuotaExhausted("所有 Gemini 模型的所有 key 都已耗尽")
        return self._slots[self._index]

    def current(self) -> str:
        return self._current()[1]

    def current_model(self) -> str | None:
        return self._current()[0]

    def client(self):
        key = self.current()
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
