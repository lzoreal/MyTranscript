"""生成站点轻量目录：节目封面、简介与最近单集，供应用外壳首屏使用。

完整 feed 每个数百 KB 到 20MB，首页不能逐个拉取；这里把首屏需要的字段抽成
一份几百 KB 的 catalog.json，publish job 发布后重建。
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import quote

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ITUNES = "{http://www.itunes.com/dtds/podcast-1.0.dtd}"
PODCAST = "{https://podcastindex.org/namespace/1.0}"
MEDIA = "{http://search.yahoo.com/mrss/}"
OWN_RAW = "https://raw.githubusercontent.com/lzoreal/MyTranscript/data/"
OWN_SITE = "https://lzoreal.github.io/MyTranscript/"


def _text(node, path: str, default: str = "") -> str:
    found = node.find(path) if node is not None else None
    return (found.text or "").strip() if found is not None and found.text else default


def channel_meta(channel) -> dict:
    image = channel.find(f"{ITUNES}image")
    artwork = image.get("href") if image is not None else ""
    if not artwork:
        artwork = _text(channel, "image/url")
    return {
        "name": _text(channel, "title"),
        "artwork": artwork or "",
        "description": _text(channel, "description"),
    }


def own_transcript(item):
    """只把本项目的字幕暴露给播放器；官方字幕格式播放器不解析。"""
    for node in item.findall(f"{PODCAST}transcript"):
        url = (node.get("url") or "").strip()
        if url.startswith(OWN_RAW) or (url.startswith(OWN_SITE) and "/transcripts/" in url):
            return {"type": node.get("type") or "", "url": url}
    return None


def plain_text(value: str, limit: int = 400) -> str:
    text = re.sub(r"<[^>]+>", " ", value or "")
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def episode_entry(item, artwork: str, index: int) -> dict:
    image = item.find(f"{ITUNES}image")
    img = image.get("href") if image is not None else ""
    enclosure = item.find("enclosure")
    media = item.find(f"{MEDIA}content")
    url = (enclosure.get("url") if enclosure is not None else "") or ""
    media_url = (media.get("url") if media is not None else "") or ""
    return {
        "id": _text(item, "guid") or f"ep-{index}",
        "title": _text(item, "title"),
        "date": _text(item, "pubDate"),
        "duration": _text(item, f"{ITUNES}duration"),
        "url": url,
        "directUrl": media_url if media_url and media_url != url else "",
        "img": img or artwork,
        "description": plain_text(_text(item, "description")),
        "transcript": own_transcript(item),
    }


def _timestamp(date: str) -> float:
    try:
        return parsedate_to_datetime(date).timestamp()
    except (TypeError, ValueError, OverflowError):
        return 0.0


def build_catalog(feeds, *, latest: int = 20) -> dict:
    shows = []
    for slug, path in feeds:
        root = ET.parse(path).getroot()
        channel = root.find("channel")
        if channel is None:
            continue
        meta = channel_meta(channel)
        items = channel.findall("item")
        episodes = [episode_entry(item, meta["artwork"], i) for i, item in enumerate(items)]
        episodes = [e for e in episodes if e["title"] or e["url"]]
        episodes.sort(key=lambda e: _timestamp(e["date"]), reverse=True)
        shows.append(
            {
                "slug": slug,
                "name": meta["name"] or slug,
                "feed": quote(slug, safe="") + "/feed.xml",
                "artwork": meta["artwork"],
                "description": meta["description"],
                "episode_count": len(items),
                "latest": episodes[:latest],
            }
        )
    shows.sort(key=lambda s: s["name"].lower())
    return {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "shows": shows,
    }


def discover_feeds(site_dir: Path):
    for path in sorted(site_dir.glob("*/feed.xml")):
        if path.parent.name == "assets":
            continue
        yield path.parent.name, path


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--site-dir", default="site")
    parser.add_argument("--output", default="site/catalog.json")
    parser.add_argument("--latest", type=int, default=20)
    args = parser.parse_args(argv)

    site_dir = Path(args.site_dir)
    feeds = list(discover_feeds(site_dir))
    if not feeds:
        print(f"ERROR: {site_dir} 下没有 feed.xml", file=sys.stderr)
        return 1
    document = build_catalog(feeds, latest=max(1, args.latest))
    output = Path(args.output)
    if output.exists():
        try:
            previous = json.loads(output.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            previous = None
        # 内容没变就不重写，避免每次 publish 都因为 generated_at 产生空提交。
        if isinstance(previous, dict) and previous.get("shows") == document["shows"]:
            print(f"目录未变化：{len(document['shows'])} 个节目")
            return 0
    output.parent.mkdir(parents=True, exist_ok=True)
    tmp = output.with_name(output.name + ".tmp")
    tmp.write_text(
        json.dumps(document, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    tmp.replace(output)
    size = output.stat().st_size
    print(f"目录：{len(document['shows'])} 个节目，{size / 1024:.0f} KB → {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
