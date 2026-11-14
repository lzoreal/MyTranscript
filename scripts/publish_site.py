"""发布一个已迁移节目：词级 JSON → feed.xml → index.html（单 feed）。

用法：python scripts/publish_site.py <slug> [--data-dir data] [--json-dir json] [--site-dir site]

feed 的条目集合 = progress.json 里旧的、已发布的集 ∪ 本管线产出的集；
文件名沿用旧的那一个（扩展名由 .vtt 变 .json），订阅端会重新取字幕。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pipeline_site  # noqa: E402
import word_transcript  # noqa: E402

BASE_URL = "https://lzoreal.github.io/MyTranscript"


def load_json(path: Path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return default


def podcast_config(show: dict, podcasts: list[dict]) -> dict:
    """feeds.json 是迁移后的事实来源；缺的展示字段从旧 podcasts.json 补。"""
    legacy = next((p for p in podcasts if p.get("slug") == show["slug"]), {})
    return {
        "slug": show["slug"],
        "name": show.get("name") or legacy.get("name") or show["slug"],
        "feed_url": show.get("feed_url") or legacy.get("feed_url"),
        "language": show.get("language") or legacy.get("language") or "en",
        "podscripts_id": show.get("podscripts_id") or legacy.get("podscripts_id"),
    }


def merge_state_records(progress: dict, state: dict, slug: str, json_dir) -> int:
    """把老 state.json 的剧集记录并入 progress（hwmym 迁移用）。

    progress 里没有 hwmym；不合并的话 publish 会把只存在于 state 的 VTT 集
    从 feed 里删掉。JSON 已导出的集切到 .json，其余保留 VTT。
    """
    records = ((state.get("podcasts") or {}).get(slug) or {}).get("transcripts") or []
    bucket = (
        progress.setdefault("podcasts", {}).setdefault(slug, {}).setdefault("processed", {})
    )
    exported = Path(json_dir) / slug
    changed = 0
    for record in records:
        guid = (record.get("identity") or "").strip()
        path = (record.get("path") or "").strip()
        if not guid or not path:
            continue
        vtt = Path(path).name
        stem = Path(vtt).stem
        entry = bucket.get(guid) or {}
        merged = dict(entry)
        merged.setdefault("vtt_filename", vtt)
        merged.setdefault("title", record.get("title") or "")
        if (exported / f"{stem}.json").exists():
            merged["transcript_filename"] = f"{stem}.json"
            merged["transcript_type"] = "application/json"
            merged["url"] = word_transcript.public_url(slug, f"{stem}.json")
            merged["path"] = f"json/{slug}/{stem}.json"
        else:
            merged.setdefault("transcript_filename", vtt)
            merged.setdefault("transcript_type", "text/vtt")
        if merged != entry:
            bucket[guid] = merged
            changed += 1
    return changed


def merge_progress(progress: dict, slug: str, documents, stems) -> int:
    """把新发布的集登记进 progress.json：总索引的集数、feed 合并都读它。"""
    bucket = (
        (progress.setdefault("podcasts", {})).setdefault(slug, {}).setdefault("processed", {})
    )
    changed = 0
    for document in documents:
        guid = document["guid"]
        stem = stems.get(guid)
        if not stem:
            continue
        entry = bucket.get(guid) or {}
        merged = {
            "title": document.get("title", ""),
            "url": word_transcript.public_url(slug, f"{stem}.json"),
            "path": f"json/{slug}/{stem}.json",
            "completed_at": document.get("generated_at", ""),
            "transcript_filename": f"{stem}.json",
            "transcript_type": "application/json",
        }
        if any(entry.get(key) != value for key, value in merged.items()):
            changed += 1
            entry.update(merged)
            bucket[guid] = entry
    return changed


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("slug")
    parser.add_argument("--data-dir", type=Path, default=Path("data"))
    parser.add_argument("--json-dir", type=Path, default=Path("json"))
    parser.add_argument("--site-dir", type=Path, default=Path("site"))
    parser.add_argument("--base-url", default=BASE_URL)
    args = parser.parse_args(argv)

    feeds = load_json(Path("feeds.json"), [])
    show = next((item for item in feeds if item.get("slug") == args.slug), None)
    if show is None:
        print(f"ERROR: feeds.json 里没有 {args.slug}", file=sys.stderr)
        return 2
    podcasts = load_json(Path("podcasts.json"), [])
    progress = load_json(Path("progress.json"), {"podcasts": {}})
    state_changed = merge_state_records(
        progress, load_json(Path("state.json"), {}), args.slug, args.json_dir
    )

    result = pipeline_site.publish_show(
        show,
        data_dir=args.data_dir,
        json_dir=args.json_dir,
        site_dir=args.site_dir,
        progress=progress,
        site_base_url=args.base_url,
        podcast=podcast_config(show, podcasts),
    )
    progress_changed = merge_progress(
        progress, args.slug, pipeline_site.load_documents(args.data_dir, args.slug),
        result["stems"],
    )
    if progress_changed or state_changed:
        Path("progress.json").write_text(
            json.dumps(progress, ensure_ascii=False, indent=2) + chr(10), encoding="utf-8"
        )
    state = "已重建 feed" if result["published"] else "无改动，未重建 feed"
    print(
        f"{args.slug}: 发布 {result['episodes']} 集（词级 JSON），"
        f"导出改动 {result['exported']} 集，progress 更新 {progress_changed} 条，{state}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
