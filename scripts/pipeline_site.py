"""把管线产物落成站点文件：词级 JSON、feed.xml、index.html（单 feed）。

只接管 ``feeds.json`` 里显式配置的节目（``publish: true``）。文件名优先沿用
progress.json 里已有的那一个——feed 里的 URL 一旦变了，订阅端会当作新条目。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scraper  # noqa: E402
import word_transcript  # noqa: E402


def stem_for(doc, slug: str, processed: dict) -> str:
    """沿用已有文件名；新集才按标题生成，重名时加 guid 指纹。"""
    info = processed.get(doc["guid"]) or {}
    known = info.get("transcript_filename") or info.get("vtt_filename")
    if known:
        return Path(known).stem
    filename = scraper.unique_vtt_filename(
        doc.get("title", ""), doc["guid"], slug, processed
    )
    return Path(filename).stem


def load_documents(data_dir: Path, slug: str) -> list[dict]:
    documents = []
    for path in sorted((Path(data_dir) / slug).glob("*.json")):
        if path.name.startswith("state"):
            continue
        document = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(document.get("sentences"), list):
            documents.append(document)
    return documents


def merged_processed(progress: dict, slug: str, stems: dict[str, str], json_dir) -> dict:
    """老 progress 的条目 + 本管线产出的集；只有已导出的集才指向 JSON。

    分批迁移时还没产出 JSON 的集必须继续用 VTT，否则 feed 构建器找不到
    JSON 会把这些集整条删掉。
    """
    exported = Path(json_dir) / slug
    old = {}
    for guid, info in (
        ((progress.get("podcasts") or {}).get(slug) or {}).get("processed") or {}
    ).items():
        item = dict(info)
        vtt = item.get("vtt_filename")
        if vtt and (exported / f"{Path(vtt).stem}.json").exists():
            item["transcript_filename"] = f"{Path(vtt).stem}.json"
            item["transcript_type"] = "application/json"
        old[guid] = item
    for guid, stem in stems.items():
        item = dict(old.get(guid) or {})
        item["transcript_filename"] = f"{stem}.json"
        item["transcript_type"] = "application/json"
        item.pop("skipped", None)
        old[guid] = item
    return old


def publish_show(show, *, data_dir, json_dir, site_dir, progress, site_base_url, podcast) -> dict:
    """发布一个节目：导出词级 JSON → 建 feed → 建 index（单 feed）。"""
    slug = show["slug"]
    processed = ((progress.get("podcasts") or {}).get(slug) or {}).get("processed") or {}
    documents = load_documents(data_dir, slug)
    stems = {}
    for document in documents:
        stems[document["guid"]] = stem_for(document, slug, processed)
    word_transcript.export_show(data_dir, json_dir, slug, stems)

    merged = merged_processed(progress, slug, stems, json_dir)
    scraper.SITE_DIR = Path(site_dir)
    scraper.generate_podcast_feed({"processed": merged}, podcast, site_base_url)
    scraper.generate_podcast_index({"processed": merged}, podcast, site_base_url)
    return {"episodes": len(documents), "stems": stems}
