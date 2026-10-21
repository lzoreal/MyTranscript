#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate a Chinese/bilingual podcast RSS feed from site/<slug>/feed.xml.

The generated feed is written to site/<slug>/feed-zh.xml. Only episodes with
completed translations and a valid transcript URL are retained. The original
episode GUIDs, audio enclosures, and unrelated RSS metadata are preserved.
"""

import argparse
import json
import logging
import os
import tempfile
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit
import xml.etree.ElementTree as ET

PODCAST_NS = "https://podcastindex.org/namespace/1.0"
ATOM_NS = "http://www.w3.org/2005/Atom"
ITUNES_NS = "http://www.itunes.com/dtds/podcast-1.0.dtd"

ET.register_namespace("atom", ATOM_NS)
ET.register_namespace("itunes", ITUNES_NS)
ET.register_namespace("podcast", PODCAST_NS)
ET.register_namespace("content", "http://purl.org/rss/1.0/modules/content/")
ET.register_namespace("media", "http://search.yahoo.com/mrss/")
ET.register_namespace("castfire", "https://amperwave.com/mrss/")


def log(msg: str) -> None:
    print(f"[ZH-FEED] {msg}", flush=True)


def local_name(tag: str) -> str:
    """Return an XML element's local name, regardless of namespace."""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def find_child(parent: ET.Element, name: str):
    for child in list(parent):
        if local_name(child.tag) == name:
            return child
    return None


def find_children(parent: ET.Element, name: str):
    return [child for child in list(parent) if local_name(child.tag) == name]


# ============================================================
# Load translation status
# ============================================================


def load_status():
    path = Path("translations.json")
    if not path.exists():
        log("ERROR: translations.json missing; refusing to rewrite feeds")
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            log("ERROR: translations.json root is not an object; refusing to rewrite feeds")
            return None
        episodes = {k: v for k, v in data.items() if not str(k).startswith("__")}
        total = sum(len(v) for v in episodes.values() if isinstance(v, dict))
        log(f"Loaded translation status: {total} episodes")
        return data
    except Exception as exc:
        log(f"ERROR: failed loading translations.json: {exc}; refusing to rewrite feeds")
        return None


def load_podcasts():
    path = Path("podcasts_translate.json")
    if not path.exists():
        log("ERROR: podcasts_translate.json missing; refusing to rewrite feeds")
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, list):
            log("ERROR: podcasts_translate.json root is not a list; refusing to rewrite feeds")
            return None
        log(f"Loaded podcasts: {len(data)}")
        return data
    except Exception as exc:
        log(f"ERROR: failed loading podcasts_translate.json: {exc}; refusing to rewrite feeds")
        return None


def build_public_feed_url(base_url: str, slug: str) -> str:
    """Build the exact public URL of the generated Chinese RSS feed."""
    base = base_url.rstrip("/")
    clean_slug = slug.strip("/")
    if not base:
        raise ValueError("--base-url cannot be empty")
    if not clean_slug or ".." in Path(clean_slug).parts:
        raise ValueError(f"Invalid podcast slug: {slug!r}")
    # Encode the slug as a single URL path segment. In particular, a literal
    # percent sign must become %25 (e.g. 99%-invisible -> 99%25-invisible).
    encoded_slug = quote(clean_slug, safe="-._~")
    return f"{base}/{encoded_slug}/feed-zh.xml"


def episode_id_from_transcript_url(url: str) -> str:
    """Extract the transcript filename stem, supporting URL-encoded filenames.

    Accepts both the English layout ``/transcripts/<name>.vtt`` and the
    Chinese layout ``/transcripts/zh/<name>.vtt``.  Older releases rejected the
    latter, which made regenerating ``feed-zh.xml`` from an already-Chinese
    feed delete every episode.
    """
    path = urlsplit(url or "").path
    marker = "/transcripts/"
    if marker not in path:
        return ""
    parts = [part for part in path.split(marker, 1)[1].split("/") if part]
    if len(parts) == 2 and parts[0].lower() == "zh":
        parts = parts[1:]
    # Only accept a VTT directly under transcripts/ (or transcripts/zh/).
    if len(parts) != 1:
        return ""
    filename = unquote(parts[0])
    if not filename.lower().endswith(".vtt"):
        return ""
    return filename[:-4]


def _parent_map(root: ET.Element) -> dict:
    """Map every element to its parent without repeated O(n^2) scans."""
    return {child: parent for parent in root.iter() for child in list(parent)}


def set_single_atom_self_link(channel: ET.Element, feed_url: str) -> int:
    """Set exactly one Atom self link to the generated feed URL."""
    links = [
        node
        for node in channel.iter()
        if local_name(node.tag) == "link"
        and node.tag == f"{{{ATOM_NS}}}link"
        and node.get("rel", "") == "self"
    ]

    if links:
        self_link = links[0]
        self_link.set("href", feed_url)
        self_link.set("type", "application/rss+xml")
        parents = _parent_map(channel)
        for duplicate in links[1:]:
            parent = parents.get(duplicate)
            if parent is not None:
                parent.remove(duplicate)
    else:
        self_link = ET.Element(
            f"{{{ATOM_NS}}}link",
            {"rel": "self", "type": "application/rss+xml", "href": feed_url},
        )
        # Insert near the start of channel metadata, after title if possible.
        title = find_child(channel, "title")
        if title is not None:
            channel.insert(list(channel).index(title) + 1, self_link)
        else:
            channel.insert(0, self_link)
    return 1


def set_itunes_new_feed_url(channel: ET.Element, feed_url: str) -> int:
    """If an iTunes feed migration tag exists, point it at this feed."""
    count = 0
    for node in channel.iter():
        if (
            node.tag == f"{{{ITUNES_NS}}}new-feed-url"
            or local_name(node.tag) == "new-feed-url"
        ):
            node.text = feed_url
            count += 1
    return count


def write_xml_atomically(tree: ET.ElementTree, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(
        prefix=f".{output.name}.", suffix=".tmp", dir=str(output.parent)
    )
    os.close(fd)
    temp_path = Path(temp_name)
    try:
        tree.write(str(temp_path), encoding="utf-8", xml_declaration=True)
        # Validate that the completed temporary file is parseable before replacing.
        ET.parse(temp_path)
        os.replace(temp_path, output)
    finally:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass


# ============================================================
# Process one podcast
# ============================================================


def transcript_rank(node) -> int:
    """Prefer an already-Chinese transcript, then an English project one."""
    path = urlsplit(node.get("url", "")).path
    if "/transcripts/zh/" in path:
        return 2
    if "/transcripts/" in path:
        return 1
    return 0


def process_podcast(slug, base_url, status):
    site_dir = Path("site")
    source = site_dir / slug / "feed.xml"
    output = site_dir / slug / "feed-zh.xml"

    if not source.exists():
        log(f"SKIP {slug}: feed.xml not found")
        return 0, 0

    log("====================================")
    log(f"Processing: {slug}")
    log(f"Input:  {source}")
    log(f"Output: {output}")

    try:
        tree = ET.parse(source)
    except (ET.ParseError, OSError) as exc:
        log(f"ERROR: failed to parse {source}: {exc}")
        return 0, 0

    root = tree.getroot()
    channel = find_child(root, "channel")
    if channel is None:
        log(f"ERROR: channel missing in {source}")
        return 0, 0

    feed_url = build_public_feed_url(base_url, slug)

    # --------------------------------------------------------
    # Channel metadata
    # --------------------------------------------------------
    title = find_child(channel, "title")
    suffix = " 中文双语 Transcript Feed"
    if title is not None and title.text:
        if not title.text.endswith(suffix):
            title.text += suffix

    language = find_child(channel, "language")
    if language is not None:
        language.text = "zh-CN"
    else:
        language = ET.SubElement(channel, "language")
        language.text = "zh-CN"

    description = find_child(channel, "description")
    if description is not None:
        description.text = "English Chinese bilingual transcript feed"
    else:
        description = ET.SubElement(channel, "description")
        description.text = "English Chinese bilingual transcript feed"

    # --------------------------------------------------------
    # Filter episodes and update transcript URLs
    # --------------------------------------------------------
    items = find_children(channel, "item")
    log(f"Original episodes: {len(items)}")

    # A missing slug entry means translations.json is incomplete/stale.  Do not
    # treat that as "every episode is untranslated", which used to overwrite a
    # good feed-zh.xml with an empty feed.
    podcast_status = status.get(slug)
    if not isinstance(podcast_status, dict):
        log(f"SKIP {slug}: no translation status; preserving existing feed")
        return 0, 0

    kept = 0
    removed = 0

    for item in list(items):
        title_node = find_child(item, "title")
        title_text = (
            title_node.text if title_node is not None and title_node.text else "UNKNOWN"
        )

        transcripts = [
            node for node in list(item) if node.tag == f"{{{PODCAST_NS}}}transcript"
        ]
        if not transcripts:
            log(f"REMOVE {title_text}: no transcript")
            channel.remove(item)
            removed += 1
            continue

        # Prefer an already-Chinese transcript, then an English one.
        transcript = max(transcripts, key=transcript_rank)
        if transcript_rank(transcript) == 0:
            log(f"REMOVE {title_text}: bad transcript url")
            channel.remove(item)
            removed += 1
            continue

        old_url = transcript.get("url", "")
        episode = episode_id_from_transcript_url(old_url)
        if not episode:
            log(f"REMOVE {title_text}: cannot extract episode ID from transcript URL")
            channel.remove(item)
            removed += 1
            continue

        info = podcast_status.get(episode)
        if not isinstance(info, dict):
            log(f"REMOVE {episode}: not in translation status")
            channel.remove(item)
            removed += 1
            continue

        if not info.get("translated", False):
            log(f"REMOVE {episode}: translation incomplete")
            channel.remove(item)
            removed += 1
            continue

        # Keep only the selected project transcript; stale English tags would
        # otherwise remain alongside the Chinese one in the Chinese feed.
        for node in transcripts:
            if node is not transcript and "/transcripts/" in urlsplit(
                node.get("url", "")
            ).path:
                item.remove(node)

        # Keep URL unchanged if it already points to /transcripts/zh/.
        # Otherwise insert /zh/ exactly once.
        parsed = urlsplit(old_url)
        path = parsed.path
        if "/transcripts/zh/" not in path:
            path = path.replace("/transcripts/", "/transcripts/zh/", 1)
        new_url = parsed._replace(path=path).geturl()
        transcript.set("url", new_url)
        transcript.set("language", "zh-CN")
        transcript.set("type", "text/vtt")
        transcript.set("rel", "captions")

        log(f"KEEP {episode}: {new_url}")
        kept += 1

    # Never publish an empty Chinese feed.  Kept=0 almost always means a
    # naming/status mismatch (or a temporarily empty source feed), not that
    # every translation was intentionally removed.
    if kept == 0:
        log(
            f"WARNING {slug}: no translated episodes matched; "
            f"preserving existing {output.name}"
        )
        return 0, removed

    # --------------------------------------------------------
    # Correct feed identity metadata
    # --------------------------------------------------------
    self_count = set_single_atom_self_link(channel, feed_url)
    new_feed_count = set_itunes_new_feed_url(channel, feed_url)

    # --------------------------------------------------------
    # Write
    # --------------------------------------------------------
    try:
        write_xml_atomically(tree, output)
    except Exception as exc:
        log(f"ERROR: failed writing {output}: {exc}")
        return kept, removed

    log(f"Atom self URL: {feed_url} (links normalized: {self_count})")
    log(f"iTunes new-feed-url updated: {new_feed_count}")
    log(f"SUMMARY {slug}: kept={kept}, removed={removed}")
    return kept, removed


def main():
    parser = argparse.ArgumentParser(description="Generate Chinese podcast RSS feeds")
    parser.add_argument(
        "--base-url",
        required=True,
        help="Public site base URL, e.g. https://example.github.io/MyTranscript",
    )
    args = parser.parse_args()

    log("====================================")
    log("Generate Chinese Podcast Feed")
    log("====================================")
    log(f"Base URL: {args.base_url.rstrip('/')}")

    status = load_status()
    podcasts = load_podcasts()
    if status is None or podcasts is None:
        log("Aborted: refusing to rewrite feeds with incomplete inputs")
        return 1

    total_kept = 0
    total_removed = 0

    for podcast in podcasts:
        if not isinstance(podcast, dict):
            continue
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
