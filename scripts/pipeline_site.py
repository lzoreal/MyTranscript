"""把管线产物落成站点文件：词级 JSON、feed.xml、index.html（单 feed）。

只接管 ``feeds.json`` 里显式配置的节目（``publish: true``）。文件名优先沿用
progress.json 里已有的那一个——feed 里的 URL 一旦变了，订阅端会当作新条目。
"""

from __future__ import annotations

import hashlib
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


def _export_owner(path: Path) -> str | None:
    try:
        document = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return None
    return document.get("guid") if isinstance(document, dict) else None


def _export_belongs(path: Path, guid: str) -> bool:
    """老 progress 里没有 guid 的文件视为可沿用，防止误占别人的导出。"""
    if not Path(path).exists():
        return False
    owner = _export_owner(path)
    return owner is None or owner == guid


def assign_stems(documents, slug: str, processed: dict, exported_dir=None) -> dict[str, str]:
    """每集一个导出文件名；同名标题不能共用一个文件，否则后写的覆盖前写的。

    已有导出文件里记着 guid，由它继续占住原名；其余同名集加 guid 指纹。
    """
    ordered = sorted(documents, key=lambda item: item["guid"])
    stems = {doc["guid"]: stem_for(doc, slug, processed) for doc in ordered}
    groups: dict[str, list[str]] = {}
    for guid, stem in stems.items():
        groups.setdefault(stem, []).append(guid)
    taken = {stem for stem, guids in groups.items() if len(guids) == 1}
    for stem in sorted(groups):
        guids = groups[stem]
        if len(guids) == 1:
            continue
        owner = None
        if exported_dir is not None:
            owner = _export_owner(Path(exported_dir) / f"{stem}.json")
        keeper = owner if owner in guids else guids[0]
        taken.add(stem)
        for guid in guids:
            if guid == keeper:
                continue
            suffix = hashlib.sha1(guid.encode("utf-8")).hexdigest()[:8]
            candidate = f"{stem}_{suffix}"
            index = 2
            while candidate in taken:
                candidate = f"{stem}_{suffix}_{index}"
                index += 1
            stems[guid] = candidate
            taken.add(candidate)
    return stems


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
        stem = stems.get(guid)
        if stem is not None:
            if (exported / f"{stem}.json").exists():
                item["transcript_filename"] = f"{stem}.json"
                item["transcript_type"] = "application/json"
            old[guid] = item
            continue
        vtt = item.get("vtt_filename")
        if vtt and _export_belongs(exported / f"{Path(vtt).stem}.json", guid):
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


def feed_is_current(feed, slug: str, stems: dict[str, str]) -> bool:
    """feed 里已经引用了每一集的 JSON，才算是最新的（中断恢复时用）。"""
    try:
        text = Path(feed).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    return all(
        word_transcript.public_url(slug, f"{stem}.json") in text
        for stem in stems.values()
    )


def publish_show(show, *, data_dir, json_dir, site_dir, progress, site_base_url, podcast) -> dict:
    """发布一个节目：导出词级 JSON → 建 feed → 建 index（单 feed）。"""
    slug = show["slug"]
    processed = ((progress.get("podcasts") or {}).get(slug) or {}).get("processed") or {}
    documents = load_documents(data_dir, slug)
    stems = assign_stems(documents, slug, processed, Path(json_dir) / slug)
    exported = word_transcript.export_show(data_dir, json_dir, slug, stems)

    feed = Path(site_dir) / slug / "feed.xml"
    index = Path(site_dir) / slug / "index.html"
    if exported == 0 and index.is_file() and feed_is_current(feed, slug, stems):
        return {"episodes": len(documents), "stems": stems,
                "exported": 0, "published": False}

    merged = merged_processed(progress, slug, stems, json_dir)
    scraper.SITE_DIR = Path(site_dir)
    scraper.generate_podcast_feed({"processed": merged}, podcast, site_base_url)
    scraper.generate_podcast_index({"processed": merged}, podcast, site_base_url)
    return {"episodes": len(documents), "stems": stems,
            "exported": exported, "published": True}
