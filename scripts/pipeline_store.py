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
    return _read_state(path)


def _read_state(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"episodes": {}}
    data.setdefault("episodes", {})
    return data


def done_guids(data_dir: Path, slug: str) -> set[str]:
    """汇总该节目所有分片 state 里记为 done 的 guid。

    分片数变了（10 → 20）时，老分片的记录还在旧文件里；只查自己那片会把
    做过的集当成新集重跑，这里合并读取来判重。写入仍各片各写。
    """
    done: set[str] = set()
    for path in sorted(show_dir(data_dir, slug).glob("state*.json")):
        for guid, entry in _read_state(path).get("episodes", {}).items():
            if isinstance(entry, dict) and entry.get("status") == "done":
                done.add(guid)
    return done


def blocked_guids(data_dir: Path, slug: str) -> set[str]:
    """已完成 + 重试次数到上限的 guid，分片时直接排除。

    待办集是跨分片重新轮流分配的，某集在 A 片记满 3 次失败后，下一轮可能
    落到 B 片；只看 B 片自己的 state 会把它当新集再试一遍。
    """
    blocked: set[str] = set()
    for path in sorted(show_dir(data_dir, slug).glob("state*.json")):
        for guid, entry in _read_state(path).get("episodes", {}).items():
            if not isinstance(entry, dict):
                continue
            if entry.get("status") == "done" or (
                entry.get("status") == "failed"
                and int(entry.get("attempts") or 0) >= MAX_ATTEMPTS
            ):
                blocked.add(guid)
    return blocked


def save_state(data_dir: Path, slug: str, state: dict[str, Any], suffix: str = "") -> None:
    _atomic_write(
        state_path(data_dir, slug, suffix),
        json.dumps(state, ensure_ascii=False, separators=(",", ":")),
    )


def plan_path(data_dir: Path, slug: str, shard: int) -> Path:
    """每片一份分片计划，和 state 一样各写各的。"""
    return show_dir(data_dir, slug) / f"plan-{shard}.json"


def read_plan(path: Path, run_id: str) -> list[str] | None:
    """只有同一个 run 的计划才算数：换 run 后待办集变了，必须重切。"""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict) or data.get("run_id") != run_id:
        return None
    return list(data.get("guids") or [])


def save_plan(data_dir: Path, slug: str, shard: int, run_id: str,
              guids: list[str]) -> None:
    _atomic_write(
        plan_path(data_dir, slug, shard),
        json.dumps({"run_id": run_id, "guids": list(guids)},
                   ensure_ascii=False, separators=(",", ":")),
    )


def claimed_guids(data_dir: Path, slug: str, run_id: str, shard: int) -> set[str]:
    """其它分片本轮已认领的集——它们可能正在跑，state 里还看不见。"""
    own = plan_path(data_dir, slug, shard)
    claimed: set[str] = set()
    for path in sorted(show_dir(data_dir, slug).glob("plan-*.json")):
        if path == own:
            continue
        guids = read_plan(path, run_id)
        if guids:
            claimed.update(guids)
    return claimed


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
