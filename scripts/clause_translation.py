"""小句级翻译契约：可机械校验的输出格式。"""

from __future__ import annotations

import json
import re
from typing import Any

LEADING_PUNCT = tuple("，。！？；：、…,.!?;:")


def normalize_tokens(text: str) -> list[str]:
    cleaned = (re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff']", "", token.lower())
               for token in (text or "").split())
    return [token for token in cleaned if token]


def validate_clauses(source: str, clauses: list[dict[str, Any]]) -> tuple[bool, str]:
    if not clauses:
        return False, "clauses 为空"
    joined: list[str] = []
    for clause in clauses:
        en = (clause.get("en") or "").strip()
        zh = (clause.get("zh") or "").strip()
        if not en or not zh:
            return False, "存在空的小句"
        if zh.startswith(LEADING_PUNCT):
            return False, "中文小句以标点开头"
        joined.extend(normalize_tokens(en))
    if joined != normalize_tokens(source):
        return False, "en 拼接与原句不逐词相等"
    return True, ""


def parse_clause_object(raw: str, sources: dict[int, str]) -> dict[int, dict[str, Any]]:
    try:
        data = json.loads(raw or "")
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    out: dict[int, dict[str, Any]] = {}
    for key, value in data.items():
        try:
            index = int(key)
        except (TypeError, ValueError):
            continue
        source = sources.get(index)
        if source is None or not isinstance(value, dict):
            continue
        clauses = value.get("clauses")
        if not isinstance(clauses, list) or not validate_clauses(source, clauses)[0]:
            continue
        out[index] = {
            "zh": "".join((c.get("zh") or "").strip() for c in clauses),
            "clauses": clauses,
            "coarse": False,
        }
    return out


def build_clause_prompt(blocks) -> str:
    lines = [
        "Translate each block into Simplified Chinese, clause by clause.",
        'Return JSON: {"<index>": {"clauses": [{"en": ..., "zh": ...}]}}.',
        "Rules: the concatenated en must equal the source word for word; do not merge,",
        "split or omit clauses; every clause needs en and zh; zh must not start with punctuation.",
    ]
    for index, cue in blocks:
        lines.append(f"[{index}] {cue['en']}")
    return chr(10).join(lines)


def build_clause_schema(indices: list[int]) -> dict[str, Any]:
    clause = {
        "type": "object",
        "properties": {"en": {"type": "string"}, "zh": {"type": "string"}},
        "required": ["en", "zh"],
    }
    return {
        "type": "object",
        "properties": {
            str(i): {
                "type": "object",
                "properties": {"clauses": {"type": "array", "items": clause}},
                "required": ["clauses"],
            }
            for i in indices
        },
        "required": [str(i) for i in indices],
    }
