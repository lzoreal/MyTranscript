#!/usr/bin/env python3
"""
多播客字幕爬取器 (RSS-first + 搜索架构)
流程：
1. 读取 RSS 获取所有剧集 (guid, title, pubDate)
2. 读取 progress.json，找出未处理的 guid
3. 取前 10 个未处理剧集
4. 在 podscripts.co 用标题搜索，找到对应页面
5. 爬取字幕 → 生成 VTT
6. 注入 <podcast:transcript> 到 RSS，生成 Feed
"""

import os
import sys
import re
import json
import time
import urllib.parse
import requests
from datetime import datetime, timezone, timedelta
from pathlib import Path
from lxml import etree

PROGRESS_FILE = Path("progress.json")
PODCASTS_FILE = Path("podcasts.json")
SITE_DIR = Path("site")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
}

BATCH_SIZE = 10


# ============ 配置 & 进度 ============
def load_podcasts():
    with open(PODCASTS_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def load_progress():
    if PROGRESS_FILE.exists():
        with open(PROGRESS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"podcasts": {}}


def save_progress(progress):
    with open(PROGRESS_FILE, "w", encoding="utf-8") as f:
        json.dump(progress, f, ensure_ascii=False, indent=2)


def get_podcast_progress(progress, slug):
    pcs = progress.setdefault("podcasts", {})
    if slug not in pcs:
        pcs[slug] = {
            "processed": {},
            "total_processed": 0,
            "updated_at": None,
        }
    return pcs[slug]


# ============ 网络请求 ============
def fetch_html(url, retries=3):
    for attempt in range(retries):
        try:
            resp = requests.get(url, headers=HEADERS, timeout=30)
            resp.raise_for_status()
            return resp.text
        except Exception as e:
            print(f"      请求失败: {e} (重试 {attempt + 1}/{retries})")
            time.sleep(2 ** attempt)
    return None


# ============ RSS 解析 ============
def fetch_rss_entries(feed_url):
    """获取官方 RSS 的所有 entries，返回 [{guid, title, pub_date}, ...]"""
    try:
        resp = requests.get(feed_url, timeout=60)
        root = etree.fromstring(resp.content)
        entries = []
        for item in root.xpath("//item"):
            guid_elem = item.find("guid")
            title_elem = item.find("title")
            pub_elem = item.find("pubDate")
            if guid_elem is not None and guid_elem.text:
                entries.append(
                    {
                        "guid": guid_elem.text.strip(),
                        "title": title_elem.text.strip() if title_elem is not None and title_elem.text else "",
                        "pub_date": pub_elem.text.strip() if pub_elem is not None and pub_elem.text else "",
                    }
                )
        return entries
    except Exception as e:
        print(f"   ⚠️ 获取 RSS 失败: {e}")
        return []


# ============ podscripts.co 搜索 ============
def search_podscripts(title, podscripts_id):
    """
    在 podscripts.co 搜索指定播客的剧集标题
    返回搜索结果中的第一个剧集 URL，或 None
    """
    if not podscripts_id:
        return None

    encoded = urllib.parse.quote_plus(title)
    url = (
        f"https://podscripts.co/podkeywordsearch/"
        f"?search_type=episode&keywordsToSearch={encoded}"
        f"&exact_match=true&slv=single&podSelectedId={podscripts_id}"
    )
    print(f"      🔍 搜索: {title[:60]}...")
    html = fetch_html(url)
    if not html:
        return None

    # 解析搜索结果：找第一个指向该播客的剧集链接
    # 搜索结果格式假设与列表页类似，包含 <h2>/<h3> 中的链接
    pattern = re.compile(
        r'<h[23][^>]*>.*?<a[^>]*href="(/podcasts/[^/]+/[^"]+)"[^>]*>(.*?)</a>.*?</h[23]>',
        re.DOTALL | re.IGNORECASE,
    )
    matches = pattern.findall(html)
    for href, title_html in matches:
        result_title = re.sub(r"<[^>]+>", "", title_html).strip()
        # 简单验证：搜索结果标题与查询标题是否相关
        if titles_match(title, result_title):
            return f"https://podscripts.co{href}"

    # 如果没匹配到，返回第一个结果（兜底）
    if matches:
        href = matches[0][0]
        return f"https://podscripts.co{href}"

    return None


def titles_match(rss_title, result_title):
    """判断两个标题是否匹配（忽略大小写、标点、空格）"""
    def norm(t):
        return re.sub(r"[^\w]", "", t.lower())
    return norm(rss_title) == norm(result_title) or norm(rss_title) in norm(result_title) or norm(result_title) in norm(rss_title)


# ============ 字幕解析 & VTT ============
def parse_transcript(html):
    """解析 podscripts.co 单集字幕"""
    paragraphs = re.findall(r'<p[^>]*>(.*?)</p>', html, re.DOTALL)
    cues = []
    current_time = None
    current_texts = []

    for p in paragraphs:
        clean = re.sub(r"<[^>]+>", "", p).strip()
        if not clean:
            continue
        m = re.match(r"Starting point is\s+(\d{1,2}):(\d{2}):(\d{2})", clean)
        if m:
            if current_time is not None and current_texts:
                cues.append({"start": current_time, "text": "\n".join(current_texts)})
            h, mi, s = m.groups()
            current_time = f"{int(h):02d}:{mi}:{s}"
            current_texts = []
        elif current_time is not None:
            current_texts.append(clean)

    if current_time is not None and current_texts:
        cues.append({"start": current_time, "text": "\n".join(current_texts)})
    return cues


def _time_to_seconds(ts):
    h, m, s = ts.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def _seconds_to_vtt(sec):
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = int(sec % 60)
    ms = int((sec % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def cues_to_vtt(cues):
    lines = ["WEBVTT", ""]
    for i, cue in enumerate(cues):
        start_sec = _time_to_seconds(cue["start"])
        end_sec = (
            _time_to_seconds(cues[i + 1]["start"])
            if i + 1 < len(cues)
            else start_sec + 5
        )
        lines.append(str(i + 1))
        lines.append(f"{_seconds_to_vtt(start_sec)} --> {_seconds_to_vtt(end_sec)}")
        for line in cue["text"].split("\n"):
            lines.append(line)
        lines.append("")
    return "\n".join(lines)


def safe_filename(title):
    keep = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_."
    return "".join(c if c in keep else "_" for c in title).strip("_.")[:80]


# ============ 核心处理 ============
def process_podcast(podcast, progress):
    slug = podcast["slug"]
    pc_prog = get_podcast_progress(progress, slug)
    processed = pc_prog.get("processed", {})

    print(f"\n{'='*50}")
    print(f"🎙️ {podcast['name']} ({slug})")

    if not podcast.get("feed_url"):
        print("   ⚠️ 未配置 feed_url，跳过")
        return False

    podscripts_id = podcast.get("podscripts_id")
    if not podscripts_id:
        print("   ⚠️ 未配置 podscripts_id，跳过（请手动查找并填写）")
        return False

    # 1. 获取 RSS 所有 entries
    rss_entries = fetch_rss_entries(podcast["feed_url"])
    if not rss_entries:
        print("   ❌ RSS 无内容")
        return False
    print(f"   📻 RSS 共 {len(rss_entries)} 集")

    # 2. 找出未处理的 RSS entries（按发布日期从新到旧排序）
    pending = []
    for entry in rss_entries:
        guid = entry["guid"]
        if guid not in processed:
            pending.append(entry)

    if not pending:
        print("   ✅ 全部剧集已处理")
        return False

    # 3. 取前 BATCH_SIZE 个
    batch = pending[:BATCH_SIZE]
    print(f"   📦 本次处理 {len(batch)} 集（待处理 {len(pending)} 集）")

    # 4. 逐个搜索并爬取
    changed = False
    for idx, entry in enumerate(batch, 1):
        guid = entry["guid"]
        title = entry["title"]

        print(f"\n   [{idx}/{len(batch)}] {title[:70]}")

        # 搜索 podscripts
        ep_url = search_podscripts(title, podscripts_id)
        if not ep_url:
            print("      ⚠️ 搜索无结果，标记为缺失")
            processed[guid] = {
                "title": title,
                "vtt_filename": None,
                "processed_at": datetime.now(timezone.utc).isoformat(),
                "skipped": True,
                "reason": "search_no_result",
            }
            changed = True
            continue

        print(f"      📄 页面: {ep_url}")

        # 爬取字幕
        html = fetch_html(ep_url)
        if not html:
            print("      ❌ 无法获取字幕页面")
            continue

        cues = parse_transcript(html)
        if not cues:
            print("      ⚠️ 页面无字幕，标记跳过")
            processed[guid] = {
                "title": title,
                "vtt_filename": None,
                "processed_at": datetime.now(timezone.utc).isoformat(),
                "skipped": True,
                "reason": "no_transcript",
            }
            changed = True
            continue

        # 生成 VTT
        vtt_filename = f"{safe_filename(title)}.vtt"
        vtt_path = SITE_DIR / slug / "transcripts" / vtt_filename
        vtt_path.parent.mkdir(parents=True, exist_ok=True)
        with open(vtt_path, "w", encoding="utf-8") as f:
            f.write(cues_to_vtt(cues))
        print(f"      💾 VTT: {vtt_filename} ({len(cues)} cues)")

        # 记录进度
        processed[guid] = {
            "title": title,
            "vtt_filename": vtt_filename,
            "processed_at": datetime.now(timezone.utc).isoformat(),
            "guid": guid,
            "source_url": ep_url,
        }
        pc_prog["total_processed"] = pc_prog.get("total_processed", 0) + 1
        changed = True

        # 集间延迟
        if idx < len(batch):
            time.sleep(2)

    pc_prog["updated_at"] = datetime.now(timezone.utc).isoformat()
    return changed


# ============ Feed & 页面生成 ============
def generate_podcast_feed(pc_prog, podcast, base_url):
    feed_url = podcast["feed_url"]
    slug = podcast["slug"]
    if not feed_url:
        return

    print(f"   📝 生成 Feed")
    try:
        resp = requests.get(feed_url, timeout=60)
        root = etree.fromstring(resp.content)
    except Exception as e:
        print(f"      ⚠️ 下载 RSS 失败: {e}")
        return

    ns_uri = "https://podcastindex.org/namespace/1.0"
    nsmap = dict(root.nsmap)
    if nsmap.get("podcast") != ns_uri:
        nsmap["podcast"] = ns_uri
        nsmap.pop(None, None)
        new_root = etree.Element(root.tag, attrib=root.attrib, nsmap=nsmap)
        new_root[:] = root[:]
        new_root.text = root.text
        new_root.tail = root.tail
        root = new_root

    processed = pc_prog.get("processed", {})
    added = 0

    for item in root.xpath("//item"):
        guid_elem = item.find("guid")
        if guid_elem is None or not guid_elem.text:
            continue
        guid = guid_elem.text.strip()

        info = processed.get(guid)
        if not info or not info.get("vtt_filename"):
            continue

        vtt_url = f"{base_url}/{slug}/transcripts/{info['vtt_filename']}"
        existing = item.findall(f"{{{ns_uri}}}transcript", namespaces=root.nsmap)
        if any(e.get("url") == vtt_url for e in existing):
            continue

        t = etree.SubElement(item, f"{{{ns_uri}}}transcript")
        t.set("url", vtt_url)
        t.set("type", "text/vtt")
        t.set("rel", "captions")
        t.set("language", podcast.get("language", "en"))
        added += 1

    feed_path = SITE_DIR / slug / "feed.xml"
    feed_path.parent.mkdir(parents=True, exist_ok=True)
    tree = etree.ElementTree(root)
    tree.write(feed_path, pretty_print=True, xml_declaration=True, encoding="utf-8")
    print(f"      ✅ 已注入 {added} 个 transcript")


def generate_podcast_index(pc_prog, podcast, base_url):
    slug = podcast["slug"]
    total = pc_prog.get("total_processed", 0)
    missing = sum(
        1 for v in pc_prog.get("processed", {}).values()
        if v.get("skipped")
    )
    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{podcast['name']} - Transcripts</title>
<style>
body{{font-family:system-ui,-apple-system,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6;color:#333}}
a{{color:#0366d6}}
code{{background:#f4f4f4;padding:2px 6px;border-radius:4px;word-break:break-all}}
.stat{{color:#666;font-size:0.9rem}}
</style>
</head>
<body>
<h1>🎙️ {podcast['name']}</h1>
<p><strong>官方 Feed:</strong> <a href="{podcast['feed_url']}" target="_blank">{podcast['feed_url']}</a></p>
<p><strong>增强 Feed (含字幕):</strong><br><code><a href="{base_url}/{slug}/feed.xml">{base_url}/{slug}/feed.xml</a></code></p>
<p>已处理 <strong>{total}</strong> 集字幕
   <span class="stat">（{missing} 集未找到字幕）</span></p>
</body>
</html>"""
    (SITE_DIR / slug / "index.html").write_text(html, encoding="utf-8")


def generate_master_index(progress, podcasts, base_url):
    items = ""
    for pc in podcasts:
        slug = pc["slug"]
        pc_prog = progress.get("podcasts", {}).get(slug, {})
        total = pc_prog.get("total_processed", 0)
        items += (
            f'<li><a href="{base_url}/{slug}/">{pc["name"]}</a> — '
            f'已处理 {total} 集 '
            f'<small>(<a href="{base_url}/{slug}/feed.xml">Feed</a>)</small></li>\n'
        )

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Podcast Transcripts Hub</title>
<style>
body{{font-family:system-ui,-apple-system,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6;color:#333}}
a{{color:#0366d6}}
li{{margin:8px 0}}
</style>
</head>
<body>
<h1>🎙️ Podcast Transcripts Hub</h1>
<p>以下播客均已自动生成 VTT 字幕：</p>
<ul>
{items}</ul>
</body>
</html>"""
    (SITE_DIR / "index.html").write_text(html, encoding="utf-8")


# ============ 入口 ============
def main():
    base_url = os.environ.get("BASE_URL", "").rstrip("/")
    if not base_url:
        gh_repo = os.environ.get("GITHUB_REPOSITORY", "")
        if gh_repo and "/" in gh_repo:
            owner, repo = gh_repo.split("/", 1)
            base_url = f"https://{owner}.github.io/{repo}"

    if not base_url:
        print("❌ 无法推导 BASE_URL，请设置环境变量")
        sys.exit(1)

    print(f"🌐 BASE_URL: {base_url}")

    podcasts = load_podcasts()
    progress = load_progress()

    changed = False
    for podcast in podcasts:
        if process_podcast(podcast, progress):
            changed = True

    # 重新生成所有 Feed 和索引
    for podcast in podcasts:
        slug = podcast["slug"]
        pc_prog = get_podcast_progress(progress, slug)
        generate_podcast_feed(pc_prog, podcast, base_url)
        generate_podcast_index(pc_prog, podcast, base_url)

    generate_master_index(progress, podcasts, base_url)
    save_progress(progress)

    print(f"\n{'='*50}")
    print(f"🌐 站点: {base_url}")
    for pc in podcasts:
        slug = pc["slug"]
        total = progress.get("podcasts", {}).get(slug, {}).get("total_processed", 0)
        print(f"   • {pc['name']}: {total} 集")


if __name__ == "__main__":
    main()