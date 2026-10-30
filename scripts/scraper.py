#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MyTranscript 多播客字幕增强 RSS 生成器。

功能：RSS-first + PodScripts 搜索 + VTT 生成 + 增强 RSS。
修复重点：
- URL 路径逐段 quote，slug 中的百分号会变成 %25，且不会双重编码。
- Atom self、iTunes new-feed-url、页面链接和 transcript URL 均指向增强 Feed。
- 特别处理原始 Feed 中指向官方地址的 itunes:new-feed-url，防止客户端（如 AntennaPod）
  按该标签把订阅自动切回官方 Feed。
- 保留原始 enclosure、GUID 和其他 episode 元数据。
- 同名 VTT 文件不会覆盖其他剧集；进度原子保存；失败项可重试。
- VTT 解析使用 lxml DOM；生成时间戳并清理字幕文本。

依赖：pip install requests lxml
配置：podcasts.json，示例见代码末尾说明。
"""

import os
import sys
import re
import json
import time
import hashlib
import urllib.parse
import html as html_module
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

import requests
from lxml import etree
from lxml import html as lxml_html

# ============================================================
# 文件与运行配置
# ============================================================
PROGRESS_FILE = Path("progress.json")
PODCASTS_FILE = Path("podcasts.json")
SITE_DIR = Path("site")
BATCH_SIZE = 500
PODSEARCH_DELAY = 2
EPISODE_DELAY = 5
HTTP_TIMEOUT = 60
MAX_RETRIES = 3

PODCAST_NS = "https://podcastindex.org/namespace/1.0"
ATOM_NS = "http://www.w3.org/2005/Atom"
ITUNES_NS = "http://www.itunes.com/dtds/podcast-1.0.dtd"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
}
RSS_HEADERS = {
    "User-Agent": HEADERS["User-Agent"],
    "Accept": "application/rss+xml, application/xml, text/xml, */*;q=0.8",
}
SESSION = requests.Session()
SESSION.headers.update(HEADERS)

# CI 里每集一行足够定位问题；设 VERBOSE=true 可恢复搜索变体、候选打分等逐步日志。
VERBOSE = os.environ.get("VERBOSE", "").strip().lower() in ("1", "true", "yes")


def detail(msg):
    if VERBOSE:
        print(msg)


# ============================================================
# 通用工具
# ============================================================
def now_iso():
    return datetime.now(timezone.utc).isoformat()


def display_name(podcast):
    return f"{podcast.get('name', podcast.get('slug', 'Podcast'))} (Unofficial)"


def safe_filename(title, max_len=120):
    """生成跨平台安全文件名；百分号等字符只用于文件名本身，不做 URL 编码。"""
    title = html_module.unescape(title or "").strip()
    keep = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_."
    value = "".join(c if c in keep else "_" for c in title)
    value = re.sub(r"_+", "_", value).strip("._")
    return (value or "episode")[:max_len]


def url_path_segment(value):
    """对单个 URL 路径段编码。必须 quote 原始值，不能对已编码值再次 quote。"""
    return urllib.parse.quote(str(value), safe="-_.~")


def public_url(base_url, *path_parts):
    """拼接公开 URL；path_parts 是未编码的路径段。"""
    encoded = "/".join(url_path_segment(part) for part in path_parts)
    return f"{base_url.rstrip('/')}/{encoded}"


def load_json(path, default):
    if not path.exists():
        return default
    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:
        print(f"读取 {path} 失败：{exc}")
        return default


def atomic_write_text(path, content):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(content, encoding="utf-8", newline="\n")
    tmp.replace(path)


def save_progress(progress):
    atomic_write_text(PROGRESS_FILE, json.dumps(progress, ensure_ascii=False, indent=2))


def load_podcasts():
    if not PODCASTS_FILE.exists():
        print(f"找不到 {PODCASTS_FILE.resolve()}")
        sys.exit(1)
    data = load_json(PODCASTS_FILE, [])
    if not isinstance(data, list):
        raise ValueError("podcasts.json 顶层必须是数组")
    return data


def get_podcast_progress(progress, slug):
    podcasts = progress.setdefault("podcasts", {})
    entry = podcasts.setdefault(
        slug, {"processed": {}, "total_processed": 0, "updated_at": None}
    )
    entry.setdefault("processed", {})
    return entry


# ============================================================
# HTTP 与 RSS
# ============================================================
def request_text(url, headers=None, retries=MAX_RETRIES):
    headers = headers or HEADERS
    for attempt in range(retries):
        try:
            response = SESSION.get(url, headers=headers, timeout=HTTP_TIMEOUT)
            response.raise_for_status()
            # requests 会按 HTTP 声明解码；若服务端没有声明，优先用 UTF-8。
            if not response.encoding or response.encoding.lower() == "iso-8859-1":
                response.encoding = response.apparent_encoding or "utf-8"
            return response.text
        except requests.HTTPError as exc:
            status = exc.response.status_code if exc.response is not None else None
            wait = 10 + 5 * attempt if status == 429 else 3**attempt
            print(f"      HTTP 请求失败 ({status})，{wait}s 后重试：{url}")
            if attempt + 1 < retries:
                time.sleep(wait)
        except Exception as exc:
            wait = 3**attempt
            print(f"      请求失败：{exc}；{wait}s 后重试")
            if attempt + 1 < retries:
                time.sleep(wait)
    return None


def fetch_rss(feed_url):
    try:
        response = SESSION.get(feed_url, headers=RSS_HEADERS, timeout=HTTP_TIMEOUT)
        response.raise_for_status()
        return etree.fromstring(response.content)
    except Exception as exc:
        print(f"   获取 RSS 失败：{exc}")
        return None


def local_name_child(element, name):
    found = element.xpath(f"./*[local-name()='{name}']")
    return found[0] if found else None


def get_enclosure(item):
    result = item.xpath("./*[local-name()='enclosure']")
    return result[0] if result else None


def get_episode_audio_url(item):
    enclosure = get_enclosure(item)
    return enclosure.get("url", "").strip() if enclosure is not None else None


# ============================================================
# 标题规范化与搜索变体
# ============================================================
def normalize_episode_title(text):
    if not text:
        return ""
    text = html_module.unescape(text)
    text = text.translate(
        str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-"})
    )
    text = text.replace("&", " and ")
    text = re.sub(r"^\s*(?:bonus|episode|ep)\s*[:.#\-]?\s*", "", text, flags=re.I)
    text = re.sub(r"^\s*#?\s*\d{1,5}\s*[.\-:#]\s*", "", text)
    text = re.sub(r"^\s*#\s*\d{1,5}\s+", "", text)
    text = re.sub(r"^\s*(?:episode|ep)\s+\d+\s*[:.#\-]?\s*", "", text, flags=re.I)
    text = re.sub(
        r"\s*(?:[([{]\s*part\s+\d+\s*[)\]}]|[-:]\s*part\s+\d+|\bpart\s+\d+\b)\s*$",
        "",
        text,
        flags=re.I,
    )
    text = re.sub(r"[^\w\s]", " ", text, flags=re.UNICODE)
    return re.sub(r"\s+", " ", text).strip().lower()


def build_search_variants(title):
    if not title:
        return []
    original = html_module.unescape(title).strip()
    variants = []

    def add(value):
        value = html_module.unescape(value or "").strip()
        if value and value not in variants:
            variants.append(value)

    add(original)
    no_part = re.sub(
        r"\s*(?:[([{]\s*part\s+\d+\s*[)\]}]|[-:]\s*part\s+\d+|\bpart\s+\d+\b)\s*$",
        "",
        original,
        flags=re.I,
    ).strip()
    add(no_part)
    no_ep = re.sub(
        r"^\s*(?:episode|ep)\s+\d+\s*[:.#\-]?\s*", "", original, flags=re.I
    ).strip()
    add(no_ep)
    no_number = re.sub(r"^\s*#?\s*\d{1,5}\s*[.\-:#]\s*", "", original).strip()
    add(no_number)
    add(re.sub(r"^\s*#\s*\d{1,5}\s+", "", original).strip())
    add(
        re.sub(
            r"\s*(?:[([{]\s*part\s+\d+\s*[)\]}]|[-:]\s*part\s+\d+|\bpart\s+\d+\b)\s*$",
            "",
            no_number,
            flags=re.I,
        ).strip()
    )
    add(
        re.sub(
            r"\s*(?:[([{]\s*part\s+\d+\s*[)\]}]|[-:]\s*part\s+\d+|\bpart\s+\d+\b)\s*$",
            "",
            no_ep,
            flags=re.I,
        ).strip()
    )
    if ":" in original:
        before, after = original.split(":", 1)
        add(before)
        add(after)
    return variants


def title_similarity(title1, title2):
    a, b = normalize_episode_title(title1), normalize_episode_title(title2)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    if a in b or b in a:
        return 0.90 + 0.10 * min(len(a), len(b)) / max(len(a), len(b))
    ta, tb = set(a.split()), set(b.split())
    if not ta or not tb:
        return 0.0
    inter = ta & tb
    return (len(inter) / len(ta | tb)) * 0.4 + max(
        len(inter) / len(ta), len(inter) / len(tb)
    ) * 0.6


def looks_like_bad_link_title(title):
    normalized = normalize_episode_title(title)
    if normalized in {
        "",
        "comments",
        "comment",
        "comedy",
        "view full transcript",
        "transcript",
        "read more",
        "share",
        "home",
        "podcasts",
        "categories",
    }:
        return True
    return bool(re.fullmatch(r"\d+\s+comments?", normalized, re.I))


# ============================================================
# PodScripts 搜索与页面解析
# ============================================================
def clean_podscripts_url(href):
    if not href:
        return None
    absolute = urllib.parse.urljoin("https://podscripts.co", href.replace("&amp;", "&"))
    parsed = urllib.parse.urlparse(absolute)
    if parsed.netloc.lower() not in {"podscripts.co", "www.podscripts.co"}:
        return None
    return urllib.parse.urlunparse(
        ("https", "podscripts.co", parsed.path.rstrip("/"), "", "", "")
    )


def parse_podscripts_search_results(html_text):
    if not html_text:
        return []
    try:
        doc = lxml_html.fromstring(html_text)
    except Exception as exc:
        print(f"      搜索页面 HTML 解析失败：{exc}")
        return []
    candidates, seen = [], set()
    for link in doc.xpath("//a[@href]"):
        href = link.get("href", "")
        if not href.startswith("/podcasts/"):
            continue
        url = clean_podscripts_url(href)
        if not url or url in seen:
            continue
        parts = [p for p in urllib.parse.urlparse(url).path.split("/") if p]
        if len(parts) < 3:
            continue
        title = ""
        for node in link.xpath(".//h1|.//h2|.//h3|.//strong"):
            candidate = " ".join(" ".join(node.itertext()).split())
            if candidate and not looks_like_bad_link_title(candidate):
                title = candidate
                break
        if not title:
            parent = link.getparent()
            if parent is not None:
                options = []
                for node in parent.xpath(".//h1|.//h2|.//h3|.//a|.//div"):
                    candidate = html_module.unescape(
                        " ".join(" ".join(node.itertext()).split())
                    )
                    if candidate and not looks_like_bad_link_title(candidate):
                        options.append(candidate)
                if options:
                    title = max(options, key=len)
        if not title:
            title = " ".join(" ".join(link.itertext()).split())
        title = html_module.unescape(title).strip()
        if looks_like_bad_link_title(title):
            continue
        seen.add(url)
        candidates.append({"title": title, "url": url})
    return candidates


def search_podscripts_once(search_title, podscripts_id):
    if not search_title:
        return []
    params = {
        "search_type": "episode",
        "keywordsToSearch": search_title,
        "exact_match": "false",
        "slv": "single",
        "podSelectedId": str(podscripts_id),
    }
    url = "https://podscripts.co/podkeywordsearch/?" + urllib.parse.urlencode(params)
    detail(f"      搜索：{search_title[:100]}")
    html_text = request_text(url)
    if not html_text:
        return []
    detail(f"      搜索页面 HTML 长度：{len(html_text)}")
    return parse_podscripts_search_results(html_text)


def search_podscripts(title, podscripts_id):
    if not podscripts_id:
        return None
    variants = build_search_variants(title)
    detail(f"      搜索变体数量：{len(variants)}")
    for index, variant in enumerate(variants, 1):
        detail(f"      开始搜索变体 [{index}/{len(variants)}]")
        candidates = search_podscripts_once(variant, podscripts_id)
        detail(f"      本次搜索得到：{len(candidates)} 个候选")
        scored = sorted(
            ((title_similarity(title, c["title"]), c) for c in candidates),
            key=lambda x: x[0],
            reverse=True,
        )
        for score, candidate in scored[:5]:
            detail(f"         {score:.3f} | {candidate['title']}")
        if scored:
            score, candidate = scored[0]
            if score >= 0.55:
                detail(f"      匹配成功 ({score:.3f})：{candidate['title']}")
                return candidate["url"]
            detail(f"      最高匹配度 {score:.3f}，低于 0.55，继续尝试")
        if index < len(variants):
            time.sleep(PODSEARCH_DELAY)
    detail("      所有标题变体均未找到可靠匹配")
    return None


# ============================================================
# Transcript 解析与 VTT
# ============================================================
TIME_PATTERN = re.compile(
    r"Starting\s+point\s+is\s+(?P<h>\d{1,2}):(?P<m>\d{2}):(?P<s>\d{2})", re.I
)


def clean_transcript_text(text):
    text = html_module.unescape(text or "").replace("\xa0", " ")
    return re.sub(r"\s+", " ", text).strip()


def parse_timestamp(match):
    return (
        int(match.group("h")) * 3600
        + int(match.group("m")) * 60
        + int(match.group("s"))
    )


def parse_transcript(html_text):
    if not html_text:
        return []
    try:
        doc = lxml_html.fromstring(html_text)
    except Exception as exc:
        print(f"         HTML DOM 解析失败：{exc}")
        return []
    for bad in doc.xpath("//script|//style|//noscript|//svg"):
        parent = bad.getparent()
        if parent is not None:
            parent.remove(bad)
    visible_text = " ".join(doc.itertext())
    visible_text = clean_transcript_text(visible_text)
    matches = list(TIME_PATTERN.finditer(visible_text))
    cues = []
    for index, match in enumerate(matches):
        start = parse_timestamp(match)
        end_pos = (
            matches[index + 1].start()
            if index + 1 < len(matches)
            else len(visible_text)
        )
        text = clean_transcript_text(visible_text[match.end() : end_pos])
        text = re.split(
            r"(?:©\s*PodScripts|Privacy Policy|Terms of Service)",
            text,
            maxsplit=1,
            flags=re.I,
        )[0]
        text = clean_transcript_text(text)
        if text and not text.lower().startswith(
            ("click on any sentence", "there aren't comments")
        ):
            cues.append({"start_seconds": start, "text": text})
    # 同一秒同一文本去重；保留按时间顺序的字幕。
    result, seen = [], set()
    for cue in cues:
        key = (cue["start_seconds"], cue["text"])
        if key not in seen:
            seen.add(key)
            result.append(cue)
    result.sort(key=lambda x: x["start_seconds"])
    detail(f"         解析到 cues：{len(result)}")
    return result


def seconds_to_vtt(seconds):
    total_ms = max(0, int(round(float(seconds) * 1000)))
    hours, rem = divmod(total_ms, 3600000)
    minutes, rem = divmod(rem, 60000)
    secs, ms = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{ms:03d}"


def cues_to_vtt(cues, offset_seconds=0):
    lines = ["WEBVTT", ""]
    for i, cue in enumerate(cues):
        start = float(cue["start_seconds"]) + offset_seconds
        if i + 1 < len(cues):
            next_start = float(cues[i + 1]["start_seconds"]) + offset_seconds
            end = max(next_start, start + 0.1)
        else:
            end = start + 5.0
        # 防止时间倒退或 0 时长。
        end = max(end, start + 0.1)
        lines.extend(
            [
                str(i + 1),
                f"{seconds_to_vtt(start)} --> {seconds_to_vtt(end)}",
                cue["text"].strip(),
                "",
            ]
        )
    return "\n".join(lines)


# ============================================================
# 进度与单集处理
# ============================================================
def vtt_path_for(slug, filename):
    return SITE_DIR / slug / "transcripts" / filename


def is_episode_processed(info, slug):
    if not info or info.get("skipped") or not info.get("vtt_filename"):
        return False
    path = vtt_path_for(slug, info["vtt_filename"])
    if not path.exists() or path.stat().st_size < 10:
        return False
    try:
        return path.read_text(encoding="utf-8-sig").lstrip().startswith("WEBVTT")
    except Exception:
        return False


def unique_vtt_filename(title, guid, slug, processed=None):
    """Pick a VTT filename without re-reading progress.json for every episode."""
    base = safe_filename(title)
    path = vtt_path_for(slug, base + ".vtt")
    if processed is None:
        progress = load_json(PROGRESS_FILE, {"podcasts": {}})
        processed = progress.get("podcasts", {}).get(slug, {}).get("processed", {})
    # 同名标题若已被另一 GUID 占用，使用 GUID hash 生成稳定文件名。
    used_by_other = {
        info.get("vtt_filename")
        for old_guid, info in processed.items()
        if old_guid != guid
    }
    if path.name in used_by_other:
        suffix = hashlib.sha1(guid.encode("utf-8")).hexdigest()[:8]
        return f"{base[:100]}_{suffix}.vtt"
    if path.exists():
        # 若该路径已经是本 GUID 的记录，可覆盖修复；否则避免覆盖未知文件。
        old_info = processed.get(guid, {})
        if old_info.get("vtt_filename") != path.name:
            suffix = hashlib.sha1(guid.encode("utf-8")).hexdigest()[:8]
            return f"{base[:100]}_{suffix}.vtt"
    return path.name


def process_podcast(podcast, progress):
    slug = podcast["slug"]
    feed_url = podcast.get("feed_url")
    podscripts_id = podcast.get("podscripts_id")
    pc_prog = get_podcast_progress(progress, slug)
    processed = pc_prog["processed"]
    print(f"\n播客：{display_name(podcast)} ({slug})")
    if not feed_url:
        print("   未配置 feed_url，跳过")
        return False
    if not podscripts_id:
        print("   未配置 podscripts_id，跳过")
        return False
    root = fetch_rss(feed_url)
    if root is None:
        return False
    rss_items = []
    for item in root.xpath("//*[local-name()='item']"):
        guid_elem = local_name_child(item, "guid")
        title_elem = local_name_child(item, "title")
        if guid_elem is None or not (guid_elem.text or "").strip():
            continue
        rss_items.append(
            {
                "guid": guid_elem.text.strip(),
                "title": (
                    (title_elem.text or "").strip() if title_elem is not None else ""
                ),
                "item": item,
                "audio_url": get_episode_audio_url(item),
            }
        )
    if not rss_items:
        print("   RSS 无内容")
        return False
    pending = [
        entry
        for entry in rss_items
        if not is_episode_processed(processed.get(entry["guid"]), slug)
    ]
    print(f"   RSS 共 {len(rss_items)} 集；待处理 {len(pending)} 集")
    if not pending:
        return False
    batch = pending[:BATCH_SIZE]
    changed = False
    for idx, entry in enumerate(batch, 1):
        guid, title = entry["guid"], entry["title"]
        label = title[:70]
        position = f"[{idx}/{len(batch)}]"
        try:
            ep_url = search_podscripts(title, podscripts_id)
            if not ep_url:
                processed[guid] = {
                    "title": title,
                    "vtt_filename": None,
                    "processed_at": now_iso(),
                    "skipped": True,
                    "reason": "search_no_result",
                }
                changed = True
                save_progress(progress)
                print(f"   {position} 未匹配到字幕页：{label}")
                continue
            detail(f"      页面：{ep_url}")
            html_text = request_text(ep_url)
            if not html_text:
                processed[guid] = {
                    "title": title,
                    "vtt_filename": None,
                    "processed_at": now_iso(),
                    "skipped": True,
                    "reason": "page_fetch_failed",
                    "source_url": ep_url,
                }
                changed = True
                save_progress(progress)
                print(f"   {position} 字幕页抓取失败：{label}")
                continue
            cues = parse_transcript(html_text)
            if not cues:
                processed[guid] = {
                    "title": title,
                    "vtt_filename": None,
                    "processed_at": now_iso(),
                    "skipped": True,
                    "reason": "no_transcript",
                    "source_url": ep_url,
                }
                changed = True
                save_progress(progress)
                print(f"   {position} 页面无字幕内容：{label}")
                continue
            filename = unique_vtt_filename(title, guid, slug, processed)
            path = vtt_path_for(slug, filename)
            # 临时文件写完再原子替换，避免中断留下半个 VTT。
            atomic_write_text(path, cues_to_vtt(cues))
            processed[guid] = {
                "title": title,
                "vtt_filename": filename,
                "processed_at": now_iso(),
                "guid": guid,
                "source_url": ep_url,
                "skipped": False,
            }
            # total_processed is recomputed once after the batch below; doing
            # it for every episode made large backlogs O(n^2).
            pc_prog["updated_at"] = now_iso()
            changed = True
            save_progress(progress)
            print(f"   {position} {label} → {filename}（{len(cues)} cues）")
        except KeyboardInterrupt:
            save_progress(progress)
            raise
        except Exception as exc:
            print(f"   {position} 处理异常：{label} → {exc}")
            processed[guid] = {
                "title": title,
                "vtt_filename": None,
                "processed_at": now_iso(),
                "skipped": True,
                "reason": "exception",
                "error": str(exc),
            }
            changed = True
            save_progress(progress)
        if idx < len(batch):
            time.sleep(EPISODE_DELAY)
    pc_prog["total_processed"] = sum(
        1
        for value in processed.values()
        if not value.get("skipped") and value.get("vtt_filename")
    )
    pc_prog["updated_at"] = now_iso()
    return changed


# ============================================================
# RSS 命名空间与增强 Feed
# ============================================================
def ensure_namespace(root, prefix, uri):
    if root.nsmap.get(prefix) == uri:
        return root
    nsmap = dict(root.nsmap)
    # 若已有该 URI 的其他前缀，保留已有映射，避免不必要重建。
    if uri in nsmap.values():
        return root
    nsmap[prefix] = uri
    new_root = etree.Element(root.tag, attrib=dict(root.attrib), nsmap=nsmap)
    new_root.text, new_root.tail = root.text, root.tail
    for child in root:
        new_root.append(deepcopy(child))
    return new_root


def remove_or_rewrite_new_feed_url(channel, enhanced_feed_url):
    """关键修复：不让官方 itunes:new-feed-url 把播客客户端带回官方 Feed。"""
    for node in channel.xpath(
        "./*[local-name()='new-feed-url' and namespace-uri()=$ns]", ns=ITUNES_NS
    ):
        node.text = enhanced_feed_url
    # 有些 feed 的该元素可能未正确绑定 namespace；一并处理。
    for node in channel.xpath(
        "./*[local-name()='new-feed-url' and not(namespace-uri())]"
    ):
        node.text = enhanced_feed_url


def ensure_atom_self(channel, enhanced_feed_url):
    self_links = channel.xpath(
        "./*[local-name()='link' and namespace-uri()=$ns and @rel='self']", ns=ATOM_NS
    )
    if self_links:
        node = self_links[0]
        node.set("href", enhanced_feed_url)
        node.set("type", "application/rss+xml")
        for extra in self_links[1:]:
            channel.remove(extra)
    else:
        node = etree.Element(
            f"{{{ATOM_NS}}}link",
            href=enhanced_feed_url,
            rel="self",
            type="application/rss+xml",
        )
        channel.insert(0, node)


def generate_podcast_feed(pc_prog, podcast, base_url):
    slug = podcast["slug"]
    source_feed_url = podcast["feed_url"]
    root = fetch_rss(source_feed_url)
    if root is None:
        print("      下载原始 RSS 失败")
        return
    root = ensure_namespace(root, "podcast", PODCAST_NS)
    root = ensure_namespace(root, "atom", ATOM_NS)
    channel_nodes = root.xpath("./*[local-name()='channel']")
    if not channel_nodes:
        print("      RSS 没有 channel")
        return
    channel = channel_nodes[0]
    enhanced_feed_url = public_url(base_url, slug, "feed.xml")

    title_elem = local_name_child(channel, "title")
    if title_elem is not None:
        title_elem.text = f"{display_name(podcast)} - Transcripts"
    desc_elem = local_name_child(channel, "description")
    if desc_elem is not None:
        original = desc_elem.text or ""
        if "unofficial transcript-enhanced feed" not in original.lower():
            desc_elem.text = (
                original.rstrip()
                + "\n\nThis is an unofficial transcript-enhanced feed."
            )

    # Atom self 与 iTunes new-feed-url 都必须指向增强版，而不是官方 Feed。
    ensure_atom_self(channel, enhanced_feed_url)
    remove_or_rewrite_new_feed_url(channel, enhanced_feed_url)

    processed = pc_prog.get("processed", {})
    original_items = channel.xpath("./*[local-name()='item']")
    kept = removed = added = 0
    for item in original_items:
        guid_elem = local_name_child(item, "guid")
        guid = (guid_elem.text or "").strip() if guid_elem is not None else ""
        info = processed.get(guid)
        if not guid or not is_episode_processed(info, slug):
            channel.remove(item)
            removed += 1
            continue
        vtt_url = public_url(base_url, slug, "transcripts", info["vtt_filename"])
        transcript_nodes = item.xpath(
            "./*[local-name()='transcript' and namespace-uri()=$ns]", ns=PODCAST_NS
        )
        matching = None
        for node in transcript_nodes:
            if node.get("url") == vtt_url:
                matching = node
            else:
                # 删除指向旧地址的本项目 transcript，避免同一集出现错误重复字幕标签。
                if node.get("url", "").find("/transcripts/") >= 0:
                    item.remove(node)
        if matching is None:
            matching = etree.SubElement(item, f"{{{PODCAST_NS}}}transcript")
            added += 1
        matching.set("url", vtt_url)
        matching.set("type", "text/vtt")
        matching.set("rel", "captions")
        matching.set("language", podcast.get("language", "en"))
        kept += 1

    feed_path = SITE_DIR / slug / "feed.xml"
    feed_path.parent.mkdir(parents=True, exist_ok=True)
    tree = etree.ElementTree(root)
    tmp = feed_path.with_name(feed_path.name + ".tmp")
    # lxml 会把文件名当 URI 解析，含 % 的相对路径在 Windows 上直接失败，所以走句柄。
    with open(tmp, "wb") as handle:
        tree.write(handle, pretty_print=True, xml_declaration=True, encoding="utf-8")
    tmp.replace(feed_path)
    print(
        f"   Feed：{slug} → {enhanced_feed_url}"
        f"（保留 {kept} 集；删除 {removed} 集；transcript 标签 {added} 个）"
    )


# ============================================================
# HTML 索引
# ============================================================
def generate_podcast_index(pc_prog, podcast, base_url):
    slug = podcast["slug"]
    name = display_name(podcast)
    processed = pc_prog.get("processed", {})
    total = sum(
        1
        for info in processed.values()
        if not info.get("skipped") and info.get("vtt_filename")
    )
    missing = sum(1 for info in processed.values() if info.get("skipped"))
    feed_url = public_url(base_url, slug, "feed.xml")
    html = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html_module.escape(name)} - Transcripts</title><style>body{{font-family:system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.7;color:#333}}a{{color:#0366d6}}code{{background:#f4f4f4;padding:2px 6px;border-radius:4px;overflow-wrap:anywhere}}.stat{{color:#666;font-size:.9rem}}</style></head><body>
<h1>🎙️ {html_module.escape(name)}</h1>
<p><strong>官方 Feed：</strong><a href="{html_module.escape(podcast['feed_url'], quote=True)}">{html_module.escape(podcast['feed_url'])}</a></p>
<p><strong>增强 Feed（含字幕）：</strong><br><code><a href="{html_module.escape(feed_url, quote=True)}">{html_module.escape(feed_url)}</a></code></p>
<p>已处理 <strong>{total}</strong> 集字幕 <span class="stat">（{missing} 集未找到字幕或处理失败）</span></p>
<p><a href="{public_url(base_url, 'podcasts.html')}">← 返回播客列表</a></p></body></html>"""
    atomic_write_text(SITE_DIR / slug / "index.html", html)


def generate_master_index(progress, podcasts, base_url):
    rows = []
    for podcast in podcasts:
        slug = podcast["slug"]
        pc_prog = progress.get("podcasts", {}).get(slug, {})
        processed = pc_prog.get("processed", {})
        total = sum(
            1
            for info in processed.values()
            if not info.get("skipped") and info.get("vtt_filename")
        )
        page_url = public_url(base_url, slug, "index.html")
        feed_url = public_url(base_url, slug, "feed.xml")
        rows.append(
            f'<li><a href="{html_module.escape(page_url, quote=True)}">{html_module.escape(display_name(podcast))}</a> — 已处理 {total} 集 · <a href="{html_module.escape(feed_url, quote=True)}">Feed</a></li>'
        )
    html = f"""<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Podcast Transcripts Hub</title><style>body{{font-family:system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.7;color:#333}}li{{margin:10px 0}}a{{color:#0366d6}}</style></head><body><h1>🎙️ Podcast Transcripts Hub</h1><p>以下播客提供非官方 transcript 增强 RSS：</p><ul>{''.join(rows)}</ul></body></html>"""
    atomic_write_text(SITE_DIR / "podcasts.html", html)


# ============================================================
# 主程序
# ============================================================
def determine_base_url():
    base_url = os.environ.get("BASE_URL", "").rstrip("/")
    if base_url:
        return base_url
    gh_repo = os.environ.get("GITHUB_REPOSITORY", "")
    if gh_repo and "/" in gh_repo:
        owner, repo = gh_repo.split("/", 1)
        return f"https://{owner}.github.io/{repo}"
    return ""


def main():
    base_url = determine_base_url()
    if not base_url:
        print(
            "无法推导 BASE_URL，请设置环境变量 BASE_URL，例如 https://用户名.github.io/MyTranscript"
        )
        sys.exit(1)
    print(f"BASE_URL：{base_url}")
    podcasts = load_podcasts()
    progress = load_json(PROGRESS_FILE, {"podcasts": {}})
    if not isinstance(progress, dict):
        progress = {"podcasts": {}}
    progress.setdefault("podcasts", {})
    SITE_DIR.mkdir(parents=True, exist_ok=True)

    for podcast in podcasts:
        if podcast.get("migrated"):
            print(f"播客：{display_name(podcast)} ({podcast['slug']}) 已迁移到新管线，跳过抓取")
            continue
        try:
            process_podcast(podcast, progress)
        except KeyboardInterrupt:
            print("\n用户中断，保存进度……")
            save_progress(progress)
            raise
        except Exception as exc:
            print(f"处理播客 {podcast.get('slug', '?')} 时发生异常：{exc}")
        save_progress(progress)

    print("\n开始生成增强 RSS")
    for podcast in podcasts:
        if podcast.get("migrated"):
            continue
        slug = podcast["slug"]
        pc_prog = get_podcast_progress(progress, slug)
        try:
            generate_podcast_feed(pc_prog, podcast, base_url)
            generate_podcast_index(pc_prog, podcast, base_url)
        except Exception as exc:
            print(f"   生成 {slug} Feed 失败：{exc}")
    generate_master_index(progress, podcasts, base_url)
    save_progress(progress)

    print(f"\n站点：{base_url}")
    for podcast in podcasts:
        slug = podcast["slug"]
        processed = progress.get("podcasts", {}).get(slug, {}).get("processed", {})
        total = sum(
            1
            for info in processed.values()
            if not info.get("skipped") and info.get("vtt_filename")
        )
        skipped = sum(1 for info in processed.values() if info.get("skipped"))
        print(f"   • {display_name(podcast)}：{total} 集成功，{skipped} 集失败/未找到")
    print("\n完成。")


if __name__ == "__main__":
    main()
