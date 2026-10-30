"""把管线产物落成站点文件：双语 VTT、feed.xml、feed-zh.xml、index.html。

只接管 ``feeds.json`` 里显式配置的节目（``publish: true``）。文件名优先沿用
progress.json 里已有的那一个——feed 里的 URL 一旦变了，订阅端会当作新条目。
"""

from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scraper  # noqa: E402


def _timestamp(value: float) -> str:
    ms = int(round(float(value) * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d}.{ms % 1000:03d}"


def render_english(sentences) -> str:
    blocks = ["WEBVTT", ""]
    for index, sentence in enumerate(sentences, 1):
        en = (sentence.get("en") or "").strip()
        if not en:
            raise ValueError(f"第 {index} 句缺少英文")
        if float(sentence["end"]) <= float(sentence["start"]):
            raise ValueError(f"第 {index} 句时间无效")
        blocks.extend(
            [str(index), f"{_timestamp(sentence['start'])} --> {_timestamp(sentence['end'])}", en, ""]
        )
    return chr(10).join(blocks).rstrip() + chr(10)


def _bilingual(sentences) -> str:
    blocks = ["WEBVTT", ""]
    for index, sentence in enumerate(sentences, 1):
        en = (sentence.get("en") or "").strip()
        zh = (sentence.get("zh") or "").strip()
        if not en or not zh:
            raise ValueError(f"第 {index} 句缺少英文或中文")
        if float(sentence["end"]) <= float(sentence["start"]):
            raise ValueError(f"第 {index} 句时间无效")
        blocks.extend(
            [
                str(index),
                f"{_timestamp(sentence['start'])} --> {_timestamp(sentence['end'])}",
                en,
                zh,
                "",
            ]
        )
    return chr(10).join(blocks).rstrip() + chr(10)


def stem_for(doc, slug: str, processed: dict) -> str:
    """沿用已有文件名；新集才按标题生成，重名时加 guid 指纹。"""
    known = (processed.get(doc["guid"]) or {}).get("vtt_filename")
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


def write_episode(document, site_dir: Path, slug: str, stem: str) -> str:
    """写英文 VTT 与双语 zh VTT，返回英文 VTT 文本（供状态指纹用）。"""
    sentences = document["sentences"]
    english = render_english(sentences)
    transcript_dir = Path(site_dir) / slug / "transcripts"
    transcript_dir.mkdir(parents=True, exist_ok=True)
    (transcript_dir / f"{stem}.vtt").write_text(english, encoding="utf-8")
    zh_dir = transcript_dir / "zh"
    zh_dir.mkdir(parents=True, exist_ok=True)
    (zh_dir / f"{stem}.vtt").write_text(_bilingual(sentences), encoding="utf-8")
    return english


def status_entry(english_vtt: str, now: str | None = None) -> dict:
    """translations.json 里的条目：zh feed 用它判断哪些集有中文。"""
    stamp = now or datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    return {
        "hash": hashlib.sha256(english_vtt.encode("utf-8")).hexdigest(),
        "translated": True,
        "updated": stamp,
    }


def merged_processed(progress: dict, slug: str, stems: dict[str, str]) -> dict:
    """老 progress 的条目 + 本管线产出的集，合并成 feed 需要的 processed 表。"""
    old = dict(((progress.get("podcasts") or {}).get(slug) or {}).get("processed") or {})
    for guid, stem in stems.items():
        info = dict(old.get(guid) or {})
        info["vtt_filename"] = f"{stem}.vtt"
        info.pop("skipped", None)
        old[guid] = info
    return old


def publish_show(show, *, data_dir, site_dir, progress, site_base_url, podcast, status) -> dict:
    """发布一个节目：写 VTT → 建 feed → 建 zh feed → 建 index；返回状态增量。"""
    slug = show["slug"]
    processed = merged_processed(
        progress, slug, {}
    )
    documents = load_documents(data_dir, slug)
    stems, statuses = {}, {}
    for document in documents:
        stem = stem_for(document, slug, processed)
        english = write_episode(document, site_dir, slug, stem)
        stems[document["guid"]] = stem
        statuses[stem] = status_entry(english, document.get("generated_at"))

    merged = merged_processed(progress, slug, stems)
    scraper.SITE_DIR = Path(site_dir)
    scraper.generate_podcast_feed({"processed": merged}, podcast, site_base_url)
    scraper.generate_podcast_index({"processed": merged}, podcast, site_base_url)

    import generate_zh_feed

    merged_status = dict((status or {}).get(slug) or {})
    merged_status.update(statuses)
    generate_zh_feed.process_podcast(slug, site_base_url, {slug: merged_status}, site_dir)
    return {"episodes": len(documents), "stems": stems, "status": statuses}
