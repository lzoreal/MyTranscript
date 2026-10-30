"""把旧 progress.json 里已发布的集标成 done，迁移后的管线只处理新集。

用法：python scripts/seed_state.py <slug> --data-dir <word-transcripts worktree>/data
      [--shards 10]

只写本分片该写的那一份 state，不动别的文件；重复执行是空操作。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pipeline_store as store  # noqa: E402


def shard_of(guid: str, shards: int) -> int:
    return int(hashlib.sha1(guid.encode("utf-8")).hexdigest(), 16) % shards


def seed(progress_path: Path, slug: str, data_dir: Path, shards: int) -> dict:
    progress = json.loads(Path(progress_path).read_text(encoding="utf-8"))
    processed = (
        (progress.get("podcasts") or {}).get(slug) or {}
    ).get("processed") or {}
    counts = {}
    for guid, info in processed.items():
        if not (info or {}).get("vtt_filename"):
            continue
        shard = shard_of(guid, shards)
        suffix = "" if shards <= 1 else f"-{shard}"
        state = store.load_state(Path(data_dir), slug, suffix)
        entry = state["episodes"].get(guid) or {}
        if entry.get("status") == "done":
            continue
        entry.update({"status": "done", "attempts": 0, "seeded": True})
        state["episodes"][guid] = entry
        store.save_state(Path(data_dir), slug, state, suffix)
        counts[suffix or "state"] = counts.get(suffix or "state", 0) + 1
    return counts


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("slug")
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--progress", type=Path, default=Path("progress.json"))
    parser.add_argument("--shards", type=int, default=10)
    args = parser.parse_args(argv)

    counts = seed(args.progress, args.slug, args.data_dir, args.shards)
    total = sum(counts.values())
    print(f"{args.slug}: 种下 {total} 集（{len(counts)} 个分片文件）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
