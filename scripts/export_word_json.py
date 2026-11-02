"""把 data/<slug>/*.json 导出为站点词级 JSON（一次性迁移或手动补导出）。

用法：
  python scripts/export_word_json.py office-ladies --progress progress.json
  python scripts/export_word_json.py how-we-made-your-mother --state state.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import word_transcript  # noqa: E402


def _load(path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def stems_from_progress(path, slug: str) -> dict[str, str]:
    data = _load(path)
    processed = ((data.get("podcasts") or {}).get(slug) or {}).get("processed") or {}
    return {
        guid: Path(info["vtt_filename"]).stem
        for guid, info in processed.items()
        if info.get("vtt_filename")
    }


def stems_from_state(path, slug: str) -> dict[str, str]:
    data = _load(path)
    records = ((data.get("podcasts") or {}).get(slug) or {}).get("transcripts") or []
    return {
        record["identity"]: Path(record["path"]).stem
        for record in records
        if record.get("identity") and record.get("path")
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("slug")
    parser.add_argument("--data-dir", type=Path, default=Path("data"))
    parser.add_argument("--json-dir", type=Path, default=Path("json"))
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--progress", type=Path)
    group.add_argument("--state", type=Path)
    args = parser.parse_args(argv)

    if args.progress:
        stems = stems_from_progress(args.progress, args.slug)
    else:
        stems = stems_from_state(args.state, args.slug)
    written = word_transcript.export_show(
        args.data_dir, args.json_dir, args.slug, stems
    )
    total = sum(
        path.stat().st_size
        for path in (args.json_dir / args.slug).glob("*.json")
    )
    print(f"{args.slug}: 导出 {written} 集，JSON 共 {total / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
