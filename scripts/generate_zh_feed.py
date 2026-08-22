#!/usr/bin/env python3

import argparse
from pathlib import Path
import xml.etree.ElementTree as ET
import json
import os
import sys

PODCAST_NS = "https://podcastindex.org/namespace/1.0"

ET.register_namespace("atom", "http://www.w3.org/2005/Atom")
ET.register_namespace("itunes", "http://www.itunes.com/dtds/podcast-1.0.dtd")
ET.register_namespace("podcast", PODCAST_NS)
ET.register_namespace("content", "http://purl.org/rss/1.0/modules/content/")
ET.register_namespace("media", "http://search.yahoo.com/mrss/")
ET.register_namespace("castfire", "https://amperwave.com/mrss/")


# ============================================================
# Log
# ============================================================

def log(msg):
    print(f"[ZH-FEED] {msg}", flush=True)


# ============================================================
# Load translation status
# ============================================================

def load_status():
    path = Path("translations.json")
    if not path.exists():
        log("WARNING: translations.json missing")
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        # 排除 __meta__
        episodes = {k: v for k, v in data.items() if not k.startswith("__")}
        total = sum(len(v) for v in episodes.values() if isinstance(v, dict))
        log(f"Loaded translation status: {total} episodes")
        return data
    except Exception as e:
        log(f"Failed loading status: {e}")
        return {}


def load_podcasts():
    path = Path("podcasts_translate.json")
    if not path.exists():
        log("WARNING: podcasts.json missing")
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        log(f"Loaded podcasts: {len(data)}")
        return data
    except Exception as e:
        log(f"Failed loading podcasts.json: {e}")
        return []


# ============================================================
# Main
# ============================================================

def process_podcast(slug, base_url, status):
    site_dir = Path("site")
    source = site_dir / slug / "feed.xml"
    output = site_dir / slug / "feed-zh.xml"

    if not source.exists():
        log(f"SKIP {slug}: feed.xml not found")
        return 0, 0

    log(f"====================================")
    log(f"Processing: {slug}")
    log(f"Input:  {source}")
    log(f"Output: {output}")

    tree = ET.parse(source)
    root = tree.getroot()

    channel = root.find("channel")
    if channel is None:
        log(f"ERROR: channel missing in {source}")
        return 0, 0

    # --------------------------------------------------------
    # Channel metadata
    # --------------------------------------------------------
    title = channel.find("title")
    if title is not None and title.text:
        title.text = title.text + " 中文双语 Transcript Feed"

    language = channel.find("language")
    if language is not None:
        language.text = "zh-CN"

    description = channel.find("description")
    if description is not None and description.text:
        description.text = "English Chinese bilingual transcript feed"

    # --------------------------------------------------------
    # Items
    # --------------------------------------------------------
    items = channel.findall("item")
    log(f"Original episodes: {len(items)}")

    podcast_status = status.get(slug, {})
    kept = 0
    removed = 0

    for item in list(items):
        title_node = item.find("title")
        title_text = title_node.text if title_node is not None else "UNKNOWN"

        # 查找 podcast:transcript
        transcript = item.find(f"{{{PODCAST_NS}}}transcript")
        if transcript is None:
            log(f"REMOVE {title_text}: no transcript")
            channel.remove(item)
            removed += 1
            continue

        old_url = transcript.get("url", "")
        if "/transcripts/" not in old_url:
            log(f"REMOVE {title_text}: bad transcript url")
            channel.remove(item)
            removed += 1
            continue

        # 提取 episode id（文件名，不含 .vtt）
        episode = old_url.split("/transcripts/")[-1].replace(".vtt", "")

        info = podcast_status.get(episode)
        if not info:
            log(f"REMOVE {episode}: not in translation status")
            channel.remove(item)
            removed += 1
            continue

        if not info.get("translated", False):
            log(f"REMOVE {episode}: translation incomplete")
            channel.remove(item)
            removed += 1
            continue

        # 构建新的中文 VTT URL
        # 原 URL: .../transcripts/Episode.vtt
        # 新 URL: .../transcripts/zh/Episode.vtt
        new_url = old_url.replace("/transcripts/", "/transcripts/zh/", 1)
        transcript.set("url", new_url)
        transcript.set("language", "zh-CN")

        log(f"KEEP {episode}: {new_url}")
        kept += 1

    # --------------------------------------------------------
    # Atom self link
    # --------------------------------------------------------
    atom_ns = "http://www.w3.org/2005/Atom"
    for atom_link in channel.findall(f"{{{atom_ns}}}link"):
        rel = atom_link.get("rel", "")
        if rel == "self":
            href = atom_link.get("href", "")
            if href and "/feed.xml" in href:
                atom_link.set("href", href.replace("/feed.xml", "/feed-zh.xml", 1))

    # --------------------------------------------------------
    # Write
    # --------------------------------------------------------
    tree.write(output, encoding="utf-8", xml_declaration=True)
    log(f"SUMMARY {slug}: kept={kept}, removed={removed}")
    return kept, removed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    args = parser.parse_args()

    log("====================================")
    log("Generate Chinese Podcast Feed")
    log("====================================")
    log(f"Base URL: {args.base_url}")

    status = load_status()
    podcasts = load_podcasts()

    total_kept = 0
    total_removed = 0

    for podcast in podcasts:
        slug = podcast.get("slug")
        if not slug:
            continue
        k, r = process_podcast(slug, args.base_url, status)
        total_kept += k
        total_removed += r

    log("====================================")
    log("FINAL SUMMARY")
    log(f"Total kept: {total_kept}")
    log(f"Total removed: {total_removed}")
    log("Done")


if __name__ == "__main__":
    main()
