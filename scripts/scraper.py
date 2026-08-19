#!/usr/bin/env python3
"""
多播客字幕爬取器 (RSS-first + 搜索 + 自动对齐)
"""

import os
import sys
import re
import json
import time
import urllib.parse
import requests
import html as html_module
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from lxml import etree

# 可选依赖：faster-whisper（用于广告对齐）
try:
    from faster_whisper import WhisperModel
    HAS_FASTER_WHISPER = True
except ImportError:
    HAS_FASTER_WHISPER = False

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
WHISPER_MODEL_SIZE = os.environ.get("WHISPER_MODEL", "base")
ALIGN_AUDIO_SECONDS = 90  # 只下载前 90 秒检测片头广告


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


def display_name(podcast):
    base = podcast.get("name", podcast["slug"])
    return f"{base} (Unofficial)"


# ============ 网络请求 ============
def fetch_html(url, retries=3):
    for attempt in range(retries):
        try:
            resp = requests.get(url, headers=HEADERS, timeout=30)
            resp.raise_for_status()
            return resp.text
        except requests.exceptions.HTTPError as e:
            status = e.response.status_code
            if status == 429:
                sleep_time = 10 + 5 * attempt
                print(f"      429 限流，等待 {sleep_time}s...")
                time.sleep(sleep_time)
            else:
                print(f"      HTTP {status} 错误 (重试 {attempt + 1}/{retries})")
                time.sleep(3 ** attempt)
        except Exception as e:
            print(f"      请求失败: {e} (重试 {attempt + 1}/{retries})")
            time.sleep(3 ** attempt)
    return None


# ============ RSS 解析 ============
def fetch_rss_entries(feed_url):
    try:
        resp = requests.get(feed_url, timeout=60)
        root = etree.fromstring(resp.content)
        entries = []
        for item in root.xpath("//item"):
            guid_elem = item.find("guid")
            title_elem = item.find("title")
            pub_elem = item.find("pubDate")
            enc_elem = item.find("enclosure")
            audio_url = ""
            if enc_elem is not None:
                audio_url = enc_elem.get("url", "")
            if guid_elem is not None and guid_elem.text:
                entries.append(
                    {
                        "guid": guid_elem.text.strip(),
                        "title": title_elem.text.strip() if title_elem is not None and title_elem.text else "",
                        "pub_date": pub_elem.text.strip() if pub_elem is not None and pub_elem.text else "",
                        "audio_url": audio_url,
                    }
                )
        return entries
    except Exception as e:
        print(f"   获取 RSS 失败: {e}")
        return []


# ============ podscripts.co 搜索 ============
def search_podscripts(title, podscripts_id):
    if not podscripts_id:
        return None

    encoded = urllib.parse.quote_plus(title)
    url = (
        f"https://podscripts.co/podkeywordsearch/"
        f"?search_type=episode&keywordsToSearch={encoded}"
        f"&exact_match=true&slv=single&podSelectedId={podscripts_id}"
    )
    print(f"      搜索: {title[:60]}...")
    html_text = fetch_html(url)
    if not html_text:
        return None

    pattern = re.compile(
        r'<h[23][^>]*>.*?<a[^>]*href="(/podcasts/[^/]+/[^"]+)"[^>]*>(.*?)</a>.*?</h[23]>',
        re.DOTALL | re.IGNORECASE,
    )
    matches = pattern.findall(html_text)
    for href, title_html in matches:
        result_title = re.sub(r"<[^>]+>", "", title_html).strip()
        if titles_match(title, result_title):
            return clean_podscripts_url(href)

    if matches:
        return clean_podscripts_url(matches[0][0])

    return None


def clean_podscripts_url(href):
    href = href.replace("&amp;", "&")
    parsed = urllib.parse.urlparse(f"https://podscripts.co{href}")
    return f"https://podscripts.co{parsed.path}"


def titles_match(rss_title, result_title):
    def norm(t):
        return re.sub(r"[^\w]", "", t.lower())
    n1, n2 = norm(rss_title), norm(result_title)
    return n1 == n2 or n1 in n2 or n2 in n1


# ============ 字幕解析 & VTT ============
def parse_transcript(html_text):
    body_match = re.search(r'<body[^>]*>(.*?)</body>', html_text, re.DOTALL | re.IGNORECASE)
    if body_match:
        body = body_match.group(1)
    else:
        body = html_text

    body = re.sub(r'<script[^>]*>.*?</script>', '', body, flags=re.DOTALL | re.IGNORECASE)
    body = re.sub(r'<style[^>]*>.*?</style>', '', body, flags=re.DOTALL | re.IGNORECASE)

    text = html_module.unescape(body)
    text = re.sub(r'<[^>]+>', '\n', text)
    lines = [line.strip() for line in text.split('\n') if line.strip()]

    cues = []
    current_time = None
    current_texts = []

    for line in lines:
        if "© PodScripts.co" in line or "Privacy Policy" in line:
            break

        m = re.match(r"Starting\s+point\s+is\s+(\d{1,2}):(\d{2}):(\d{2})", line, re.IGNORECASE)
        if m:
            if current_time is not None and current_texts:
                cues.append({"start": current_time, "text": "\n".join(current_texts)})
            h, mi, s = m.groups()
            current_time = f"{int(h):02d}:{mi}:{s}"
            current_texts = []
        elif current_time is not None:
            if line.startswith("Click on any sentence") or line.startswith("There aren't comments"):
                continue
            current_texts.append(line)

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


def cues_to_vtt(cues, offset_seconds=0):
    lines = ["WEBVTT", ""]
    for i, cue in enumerate(cues):
        start_sec = _time_to_seconds(cue["start"]) + offset_seconds
        end_sec = (
            _time_to_seconds(cues[i + 1]["start"]) + offset_seconds
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


# ============ 广告对齐 ============
def get_audio_url(rss_entries, guid):
    """从已获取的 RSS entries 中查找音频 URL"""
    for entry in rss_entries:
        if entry["guid"] == guid and entry["audio_url"]:
            return entry["audio_url"]
    return None


def download_audio_sample(audio_url, duration=ALIGN_AUDIO_SECONDS):
    """用 ffmpeg 下载前 N 秒音频"""
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    cmd = [
        "ffmpeg", "-y", "-i", audio_url,
        "-t", str(duration), "-ar", "16000", "-ac", "1",
        "-vn", tmp.name
    ]
    try:
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=60)
        return Path(tmp.name)
    except Exception as e:
        print(f"         ffmpeg 失败: {e}")
        return None


def detect_ad_offset(audio_path, podscripts_text):
    """用 faster-whisper 检测广告偏移"""
    model = WhisperModel(WHISPER_MODEL_SIZE, device="cpu", compute_type="int8")
    segments, _ = model.transcribe(
        str(audio_path),
        beam_size=1,
        language="en",
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500),
        condition_on_previous_text=False,
    )
    segments = list(segments)

    # 取 podscripts 前 60 个字符作为指纹
    fingerprint = re.sub(r"[^\w]", "", podscripts_text[:80].lower())
    if not fingerprint:
        return 0

    for seg in segments:
        seg_text = re.sub(r"[^\w]", "", seg.text.lower())
        if fingerprint in seg_text or seg_text in fingerprint:
            offset = max(0, round(seg.start) - 1)
            return offset

    # 未匹配到，假设无广告
    return 0


def align_batch(podcast, rss_entries, batch_guids, processed):
    """对刚爬取的 10 集进行广告对齐"""
    if not HAS_FASTER_WHISPER:
        print("   faster-whisper 未安装，跳过对齐")
        return

    print(f"\n   开始广告对齐 ({len(batch_guids)} 集, 模型: {WHISPER_MODEL_SIZE})...")
    aligned = 0

    for guid in batch_guids:
        info = processed.get(guid)
        if not info or info.get("skipped") or not info.get("vtt_filename"):
            continue

        title = info["title"]
        print(f"      [{aligned+1}] {title[:50]}")

        audio_url = get_audio_url(rss_entries, guid)
        if not audio_url:
            print("         无音频 URL")
            continue

        # 读取现有字幕文本
        vtt_path = SITE_DIR / podcast["slug"] / "transcripts" / info["vtt_filename"]
        with open(vtt_path, "r", encoding="utf-8") as f:
            vtt_text = f.read()
        pod_text = re.sub(r"WEBVTT|^\d+$|\d{2}:\d{2}:\d{2}\.\d{3} --> .*", "", vtt_text, flags=re.MULTILINE)

        # 下载音频样本
        sample_path = download_audio_sample(audio_url)
        if not sample_path:
            continue

        try:
            offset = detect_ad_offset(sample_path, pod_text)
            if offset > 0:
                # 重新生成 VTT
                cues = parse_transcript(fetch_html(info["source_url"]) or "")
                if cues:
                    with open(vtt_path, "w", encoding="utf-8") as f:
                        f.write(cues_to_vtt(cues, offset_seconds=offset))
                    info["ad_offset"] = offset
                    print(f"         偏移 +{offset}s")
                    aligned += 1
            else:
                info["ad_offset"] = 0
                print(f"         无偏移")
        except Exception as e:
            print(f"         对齐失败: {e}")
        finally:
            sample_path.unlink(missing_ok=True)
            time.sleep(1)

    print(f"   对齐完成: {aligned}/{len(batch_guids)} 集有偏移")


# ============ 核心处理 ============
def process_podcast(podcast, progress):
    slug = podcast["slug"]
    pc_prog = get_podcast_progress(progress, slug)
    processed = pc_prog.get("processed", {})

    name = display_name(podcast)

    print(f"\n{'='*50}")
    print(f"播客: {name} ({slug})")

    if not podcast.get("feed_url"):
        print("   未配置 feed_url，跳过")
        return False

    podscripts_id = podcast.get("podscripts_id")
    if not podscripts_id:
        print("   未配置 podscripts_id，跳过")
        return False

    rss_entries = fetch_rss_entries(podcast["feed_url"])
    if not rss_entries:
        print("   RSS 无内容")
        return False
    print(f"   RSS 共 {len(rss_entries)} 集")

    pending = [e for e in rss_entries if e["guid"] not in processed]
    if not pending:
        print("   全部剧集已处理")
        return False

    batch = pending[:BATCH_SIZE]
    print(f"   本次处理 {len(batch)} 集（待处理 {len(pending)} 集）")

    changed = False
    batch_guids = []  # 记录刚处理的 guid，用于后续对齐

    for idx, entry in enumerate(batch, 1):
        guid = entry["guid"]
        title = entry["title"]

        print(f"\n   [{idx}/{len(batch)}] {title[:70]}")

        ep_url = search_podscripts(title, podscripts_id)
        time.sleep(2)

        if not ep_url:
            print("      搜索无结果，标记为缺失")
            processed[guid] = {
                "title": title,
                "vtt_filename": None,
                "processed_at": datetime.now(timezone.utc).isoformat(),
                "skipped": True,
                "reason": "search_no_result",
            }
            changed = True
            continue

        print(f"      页面: {ep_url}")

        html_text = fetch_html(ep_url)
        if not html_text:
            print("      无法获取字幕页面")
            continue

        cues = parse_transcript(html_text)
        if not cues:
            print("      页面无字幕，标记跳过")
            processed[guid] = {
                "title": title,
                "vtt_filename": None,
                "processed_at": datetime.now(timezone.utc).isoformat(),
                "skipped": True,
                "reason": "no_transcript",
            }
            changed = True
            continue

        vtt_filename = f"{safe_filename(title)}.vtt"
        vtt_path = SITE_DIR / slug / "transcripts" / vtt_filename
        vtt_path.parent.mkdir(parents=True, exist_ok=True)

        # 先保存无偏移版本
        with open(vtt_path, "w", encoding="utf-8") as f:
            f.write(cues_to_vtt(cues, offset_seconds=0))

        processed[guid] = {
            "title": title,
            "vtt_filename": vtt_filename,
            "processed_at": datetime.now(timezone.utc).isoformat(),
            "guid": guid,
            "source_url": ep_url,
            "ad_offset": 0,
        }
        pc_prog["total_processed"] = pc_prog.get("total_processed", 0) + 1
        batch_guids.append(guid)
        changed = True
        print(f"      VTT: {vtt_filename} ({len(cues)} cues)")

        if idx < len(batch):
            time.sleep(5)

    # ========== 自动对齐刚爬取的 10 集 ==========
    if batch_guids and changed:
        align_batch(podcast, rss_entries, batch_guids, processed)

    pc_prog["updated_at"] = datetime.now(timezone.utc).isoformat()
    return changed


# ============ Feed & 页面生成 ============
def generate_podcast_feed(pc_prog, podcast, base_url):
    feed_url = podcast["feed_url"]
    slug = podcast["slug"]
    if not feed_url:
        return

    print(f"   生成 Feed")
    try:
        resp = requests.get(feed_url, timeout=60)
        root = etree.fromstring(resp.content)
    except Exception as e:
        print(f"      下载 RSS 失败: {e}")
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

    channel = root.find("channel")
    if channel is not None:
        title_elem = channel.find("title")
        if title_elem is not None and title_elem.text:
            title_elem.text = f"{display_name(podcast)} - Transcripts"

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
    print(f"      已注入 {added} 个 transcript")


def generate_podcast_index(pc_prog, podcast, base_url):
    slug = podcast["slug"]
    name = display_name(podcast)
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
<title>{name} - Transcripts</title>
<style>
body{{font-family:system-ui,-apple-system,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6;color:#333}}
a{{color:#0366d6}}
code{{background:#f4f4f4;padding:2px 6px;border-radius:4px;word-break:break-all}}
.stat{{color:#666;font-size:0.9rem}}
</style>
</head>
<body>
<h1>🎙️ {name}</h1>
<p><strong>官方 Feed:</strong> <a href="{podcast["feed_url"]}" target="_blank">{podcast["feed_url"]}</a></p>
<p><strong>增强 Feed (含字幕):</strong><br><code><a href="{base_url}/{slug}/feed.xml">{base_url}/{slug}/feed.xml</a></code></p>
<p>已处理 <strong>{total}</strong> 集字幕
   <span class="stat">（{missing} 集未找到字幕）</span></p>
<p><a href="{base_url}/podcasts.html">← 返回播客列表</a></p>
</body>
</html>"""
    (SITE_DIR / slug / "index.html").write_text(html, encoding="utf-8")


def generate_master_index(progress, podcasts, base_url):
    items = ""
    for pc in podcasts:
        slug = pc["slug"]
        name = display_name(pc)
        pc_prog = progress.get("podcasts", {}).get(slug, {})
        total = pc_prog.get("total_processed", 0)
        items += (
            f'<li><a href="{base_url}/{slug}/">{name}</a> — '
            f'已处理 {total} 集 '
            f'<small>(<a href="{base_url}/{slug}/feed.xml">Feed</a>)</small></li>\n'
        )

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Podcast Transcripts Hub (Unofficial)</title>
<style>
body{{font-family:system-ui,-apple-system,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6;color:#333}}
a{{color:#0366d6}}
li{{margin:8px 0}}
</style>
</head>
<body>
<h1>🎙️ Podcast Transcripts Hub</h1>
<p>以下播客均已自动生成 VTT 字幕（非官方）：</p>
<ul>
{items}</ul>
</body>
</html>"""
    (SITE_DIR / "podcasts.html").write_text(html, encoding="utf-8")


# ============ 入口 ============
def main():
    base_url = os.environ.get("BASE_URL", "").rstrip("/")
    if not base_url:
        gh_repo = os.environ.get("GITHUB_REPOSITORY", "")
        if gh_repo and "/" in gh_repo:
            owner, repo = gh_repo.split("/", 1)
            base_url = f"https://{owner}.github.io/{repo}"

    if not base_url:
        print("无法推导 BASE_URL，请设置环境变量")
        sys.exit(1)

    print(f"BASE_URL: {base_url}")

    podcasts = load_podcasts()
    progress = load_progress()

    changed = False
    for podcast in podcasts:
        if process_podcast(podcast, progress):
            changed = True

    for podcast in podcasts:
        slug = podcast["slug"]
        pc_prog = get_podcast_progress(progress, slug)
        generate_podcast_feed(pc_prog, podcast, base_url)
        generate_podcast_index(pc_prog, podcast, base_url)

    generate_master_index(progress, podcasts, base_url)
    save_progress(progress)

    print(f"\n{'='*50}")
    print(f"站点: {base_url}")
    for pc in podcasts:
        slug = pc["slug"]
        total = progress.get("podcasts", {}).get(slug, {}).get("total_processed", 0)
        print(f"   • {display_name(pc)}: {total} 集")


if __name__ == "__main__":
    main()