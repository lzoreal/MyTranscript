"""data/<slug>/ 下的 state 与单集产物读写，全部原子写。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

MAX_ATTEMPTS = 3


def show_dir(data_dir: Path, slug: str) -> Path:
    return Path(data_dir) / slug


def state_path(data_dir: Path, slug: str, suffix: str = "") -> Path:
    """每片一份 state：分片按 guid 切分，各片只写自己的文件，push 不会互撞。"""
    return show_dir(data_dir, slug) / f"state{suffix}.json"


def load_state(data_dir: Path, slug: str, suffix: str = "") -> dict[str, Any]:
    path = state_path(data_dir, slug, suffix)
    if not path.exists():
        return {"episodes": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"episodes": {}}
    data.setdefault("episodes", {})
    return data


def save_state(data_dir: Path, slug: str, state: dict[str, Any], suffix: str = "") -> None:
    _atomic_write(
        state_path(data_dir, slug, suffix),
        json.dumps(state, ensure_ascii=False, separators=(",", ":")),
    )


def needs_work(state: dict[str, Any], guid: str) -> bool:
    record = state.get("episodes", {}).get(guid) or {}
    if record.get("status") == "done":
        return False
    return int(record.get("attempts") or 0) < MAX_ATTEMPTS


def safe_name(guid: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in guid)[:120]


def episode_path(data_dir: Path, slug: str, guid: str) -> Path:
    return show_dir(data_dir, slug) / f"{safe_name(guid)}.json"


def write_episode(path: Path, doc: dict[str, Any]) -> None:
    _atomic_write(path, json.dumps(doc, ensure_ascii=False, separators=(",", ":")))


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)
