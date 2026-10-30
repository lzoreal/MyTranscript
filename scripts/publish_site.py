"""发布一个已迁移节目：双语 VTT → feed.xml → feed-zh.xml → index.html。

用法：python scripts/publish_site.py <slug> [--data-dir data] [--site-dir site]

feed 的条目集合 = progress.json 里旧的、已发布的集 ∪ 本管线产出的集；
文件名沿用旧的那一个，所以订阅端看到的 transcript URL 不会变。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pipeline_site  # noqa: E402

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


def merge_translations(data: dict, slug: str, entries: dict) -> int:
    bucket = data.get(slug)
    if not isinstance(bucket, dict):
        bucket = {}
    changed = 0
    for stem, entry in entries.items():
        if bucket.get(stem) != entry:
            bucket[stem] = entry
            changed += 1
    data[slug] = bucket
    return changed


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("slug")
    parser.add_argument("--data-dir", type=Path, default=Path("data"))
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
    status_path = Path("translations.json")
    translations = load_json(status_path, {})
    if not isinstance(translations, dict):
        translations = {}

    result = pipeline_site.publish_show(
        show,
        data_dir=args.data_dir,
        site_dir=args.site_dir,
        progress=progress,
        site_base_url=args.base_url,
        podcast=podcast_config(show, podcasts),
        # zh feed 只保留 status 里的集：必须带上已发布的老集，否则会被整批删掉。
        status={args.slug: translations.get(args.slug) or {}},
    )
    merged = dict(translations)
    changed = merge_translations(merged, args.slug, result["status"])
    if changed:
        status_path.write_text(
            json.dumps(merged, ensure_ascii=False, indent=2) + chr(10),
            encoding="utf-8",
        )
    print(
        f"{args.slug}: 发布 {result['episodes']} 集，"
        f"新增/更新翻译状态 {changed} 条"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
