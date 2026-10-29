"""data/<slug>/ 下的 state 与单集产物读写，全部原子写。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

MAX_ATTEMPTS = 2


def show_dir(data_dir: Path, slug: str) -> Path:
    return Path(data_dir) / slug


def load_state(data_dir: Path, slug: str) -> dict[str, Any]:
    path = show_dir(data_dir, slug) / "state.json"
    if not path.exists():
        return {"episodes": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"episodes": {}}
    data.setdefault("episodes", {})
    return data


def save_state(data_dir: Path, slug: str, state: dict[str, Any]) -> None:
    path = show_dir(data_dir, slug) / "state.json"
    _atomic_write(path, json.dumps(state, ensure_ascii=False, separators=(",", ":")))


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
