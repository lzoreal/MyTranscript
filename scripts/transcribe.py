import os
import sys
import json
import time
import re
import feedparser
import requests
from datetime import datetime, timezone
from faster_whisper import WhisperModel
from pathlib import Path
from lxml import etree

PODCAST_SLUG = os.environ.get("PODCAST_SLUG", "default")
FEED_URL = os.environ.get("FEED_URL")
MODEL_SIZE = os.environ.get("WHISPER_MODEL", "base")
BASE_URL = os.environ.get("BASE_URL", "").rstrip("/")


# 兜底：如果 BASE_URL 为空，尝试从 GITHUB_REPOSITORY 构造
if not BASE_URL:
    gh_repo = os.environ.get("GITHUB_REPOSITORY", "")
    if gh_repo and "/" in gh_repo:
        owner, repo = gh_repo.split("/", 1)
        BASE_URL = f"https://{owner}.github.io/{repo}"
        print(f"⚠️ BASE_URL 未设置，从 GITHUB_REPOSITORY 推断: {BASE_URL}")


STATE_FILE = Path("state.json")
SITE_DIR = Path("site")
PODCAST_DIR = SITE_DIR / PODCAST_SLUG
TRANSCRIPTS_DIR = PODCAST_DIR / "transcripts"

PODCAST_DIR.mkdir(parents=True, exist_ok=True)
TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)


ABBREVIATIONS = (
    r"\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|vol|vols|inc|etc|eg|ie|et al|"
    r"st|ave|blvd|rd|dept|univ|No|pp|par|Ltd|Co|Corp|Plc|LLC|"
    r"U\.S|U\.K|e\.g|i\.e)\."
)


def load_state():
    if STATE_FILE.exists():
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)

    return {"podcasts": {}}


def save_state(state):
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def get_podcast_state(state):
    podcasts = state.setdefault("podcasts", {})

    if PODCAST_SLUG not in podcasts:
        podcasts[PODCAST_SLUG] = {
            "feed_url": FEED_URL,
            "processed": {},
            "total_processed": 0,
            "updated_at": None,
        }

    return podcasts[PODCAST_SLUG]


def safe_filename(title):
    keep = "abcdefghijklmnopqrstuvwxyz" "ABCDEFGHIJKLMNOPQRSTUVWXYZ" "0123456789-_. "

    return (
        "".join(c if c in keep else "_" for c in title).strip().replace(" ", "_")[:80]
    )


def format_vtt_time(seconds):
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int((seconds % 1) * 1000)

    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{millis:03d}"


def split_sentences(text):
    if not text:
        return []

    protected = re.sub(
        ABBREVIATIONS, lambda m: m.group(0).replace(".", "##DOT##"), text
    )

    parts = re.split(r"(?<=[.!?])\s+", protected)

    return [p.replace("##DOT##", ".").strip() for p in parts if p.strip()]


def resegment(raw_segments):
    entries = []

    for seg in raw_segments:
        text = seg.text.strip()

        if text:
            entries.append({"start": seg.start, "end": seg.end, "text": text})

    merged = []

    buf = {"text": "", "start": 0, "end": 0}

    for e in entries:
        if not buf["text"]:
            buf = dict(e)
        else:
            buf["text"] += " " + e["text"]
            buf["end"] = e["end"]

        if re.search(r'[.!?]["\']?$', buf["text"]):
            merged.append(dict(buf))

            buf = {"text": "", "start": 0, "end": 0}

    if buf["text"]:
        merged.append(buf)

    final = []

    for m in merged:
        sentences = split_sentences(m["text"])

        if len(sentences) <= 1:
            final.append(m)
            continue

        total_chars = sum(len(s) for s in sentences)

        t = m["start"]
        duration = m["end"] - m["start"]

        for sent in sentences:
            ratio = len(sent) / total_chars if total_chars > 0 else 1 / len(sentences)

            seg_dur = max(duration * ratio, 0.5)

            final.append({"start": t, "end": t + seg_dur, "text": sent})

            t += seg_dur

    return final


def write_bilingual_vtt(sentences, path):
    with open(path, "w", encoding="utf-8") as f:
        f.write("WEBVTT\n\n")

        for item in sentences:
            start = format_vtt_time(item["start"])
            end = format_vtt_time(item["end"])

            en = item["en"].strip().replace("\n", " ")
            zh = item["zh"].strip().replace("\n", " ")

            f.write(f"{start} --> {end}\n" f"{en}\n" f"{zh}\n\n")


def translate_with_retry(text, translator, base_delay=1.0):
    attempt = 0

    while True:
        try:
            return translator.translate(text)

        except Exception as e:
            attempt += 1

            sleep_time = base_delay * (1.5 ** min(attempt, 10))

            print(f"   ⚠️ 第 {attempt} 次失败: {e}, " f"sleep {sleep_time:.1f}s...")

            time.sleep(sleep_time)


def translate_sentences(sentences):
    from deep_translator import GoogleTranslator

    translator = GoogleTranslator(source="en", target="zh-CN")

    total = len(sentences)
    results = []

    for i, s in enumerate(sentences, 1):
        text = s["text"]

        if not text:
            results.append({**s, "en": "", "zh": ""})

            continue

        zh = translate_with_retry(text, translator)

        results.append({**s, "en": text, "zh": zh})

        if i % 20 == 0 or i == total:
            print(f"   翻译进度: {i}/{total}")

    return results


def get_audio_url(entry):
    """
    获取 RSS 中的原始 enclosure URL。
    """

    for enc in entry.get("enclosures", []):
        href = enc.get("href", "") or enc.get("url", "")
        type_ = enc.get("type", "")

        if "audio" in type_ or href.lower().split("?")[0].endswith(
            (".mp3", ".m4a", ".wav")
        ):
            return href

    return None


def resolve_enclosure_url(enclosure_url):
    """
    解析 RSS enclosure 中嵌套的真实音频地址。

    主要处理：

        https://pdst.fm/e/.../serve.castfire.com/audio/xxx.mp3

    解析为：

        https://serve.castfire.com/audio/xxx.mp3

    同样支持：

        https://pdst.fm/e/.../traffic.megaphone.fm/xxx.mp3

    以及其他被 pdst.fm 嵌套的音频 host。

    如果 enclosure 本身已经是直接音频 URL，则原样返回。
    """

    if not enclosure_url:
        return None, "unknown"

    original = enclosure_url.strip()

    if not original:
        return None, "unknown"

    lower = original.lower()

    # ---------------------------------------------------------
    # 1. 已经不是 pdst.fm
    # ---------------------------------------------------------

    if "pdst.fm/" not in lower:
        if "traffic.megaphone.fm" in lower:
            return original, "megaphone"

        if "serve.castfire.com" in lower:
            return original, "castfire"

        return original, "direct"

    # ---------------------------------------------------------
    # 2. pdst.fm 嵌套 URL
    #
    # pdst.fm 的路径中通常会包含真实音频服务器：
    #
    # /e/.../traffic.megaphone.fm/xxxx.mp3
    # /e/.../serve.castfire.com/audio/xxxx.mp3
    #
    # 我们不再把 host 写死，而是尝试从路径中寻找：
    #
    #     xxx.xxx.xxx/<audio path>
    #
    # ---------------------------------------------------------

    # 去掉协议部分，避免匹配到 pdst.fm 自己
    try:
        from urllib.parse import urlsplit, urlunsplit, unquote
    except ImportError:
        print("   ⚠️ 无法导入 urllib.parse")
        return original, "unknown"

    parsed = urlsplit(original)

    path = parsed.path

    # URL decode 一次。
    #
    # 某些 pdst.fm URL 中可能会出现：
    #
    # %2F
    # %3A
    #
    # 但是这里最多只 decode 一次，避免破坏真正的文件名。
    decoded_path = unquote(path)

    # ---------------------------------------------------------
    # 2.1 首选：寻找路径中的真实 hostname
    #
    # hostname 至少需要：
    #
    # xxx.example.com
    #
    # 也允许：
    #
    # cdn.example.co.uk
    #
    # 不匹配 IP，避免误识别数字 ID。
    # ---------------------------------------------------------

    host_pattern = re.compile(
        r"(?:(?<=/)|^)"
        r"([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?"
        r"(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+)"
        r"(?=/|$)"
    )

    matches = list(host_pattern.finditer(decoded_path))

    candidates = []

    for match in matches:
        host = match.group(1).lower()

        # pdst.fm 自己不能作为真实 host
        if host == "pdst.fm" or host.endswith(".pdst.fm"):
            continue

        # 常见的非目标域名 / tracking host 排除
        if host in {
            "www.google.com",
            "google.com",
            "www.apple.com",
            "apple.com",
        }:
            continue

        candidates.append((match, host))

    # ---------------------------------------------------------
    # 2.2 优先使用已知 Podcast 音频服务
    # ---------------------------------------------------------

    preferred_hosts = [
        ("traffic.megaphone.fm", "megaphone"),
        ("serve.castfire.com", "castfire"),
    ]

    for preferred_host, source in preferred_hosts:
        for match, host in candidates:
            if host == preferred_host:
                start = match.start(1)

                extracted_path = decoded_path[start:]

                extracted = "https://" + extracted_path

                print(f"   🔎 enclosure 解析: {preferred_host}")

                print(f"   🎧 实际音频: {extracted}")

                return extracted, source

    # ---------------------------------------------------------
    # 2.3 其他未知音频 host
    # ---------------------------------------------------------

    #
    # 如果有多个候选 host：
    #
    #     /foo.example.com/.../bar.example.com/audio.mp3
    #
    # 优先选择后面那个，因为它更可能是真实音频服务器。
    #
    if candidates:
        match, host = candidates[-1]

        start = match.start(1)
        extracted_path = decoded_path[start:]

        extracted = "https://" + extracted_path

        # 检查后面是否看起来真的像音频资源。
        audio_extensions = (
            ".mp3",
            ".m4a",
            ".aac",
            ".ogg",
            ".opus",
            ".wav",
            ".flac",
            ".m4b",
        )

        extracted_lower = extracted.lower()

        looks_like_audio = (
            any(ext in extracted_lower for ext in audio_extensions)
            or "/audio/" in extracted_lower
            or "/episodes/" in extracted_lower
            or "/episode/" in extracted_lower
        )

        if looks_like_audio:
            print(f"   🔎 enclosure 解析: {host}")

            print(f"   🎧 实际音频: {extracted}")

            return extracted, "generic"

        print(f"   ⚠️ 找到嵌套 host，但不像音频地址: {host}")

    # ---------------------------------------------------------
    # 3. 无法识别
    # ---------------------------------------------------------

    print("   ⚠️ 未识别的 pdst.fm 嵌套音频地址，" "保留原 enclosure")

    return original, "unknown"


def find_next_entry(entries, processed):
    def sort_key(e):
        t = e.get("published_parsed") or e.get("updated_parsed") or time.gmtime(0)

        return time.mktime(t)

    entries.sort(key=sort_key)

    for entry in entries:
        guid = entry.get("guid") or entry.get("id") or entry.get("title")

        if guid not in processed:
            return entry

    return None


def generate_podcast_feed(pc_state):
    """
    生成只包含“已经成功处理”的 episode 的 Podcast RSS。

    功能：
    1. 从官方 RSS 获取最新内容
    2. 删除所有尚未处理的 <item>
    3. 已处理 episode：
       - enclosure 替换为实际音频地址
       - 注入 podcast:transcript
    4. 更新 Feed 自身 URL
    5. 更新 lastBuildDate
    6. 更新 pubDate
    7. 删除/修正官方分页 atom:link
    """

    print("🔄 生成播客 RSS feed...")

    # =========================================================
    # 1. 获取官方 RSS
    # =========================================================

    resp = requests.get(FEED_URL, timeout=60, headers={"User-Agent": "Mozilla/5.0"})

    resp.raise_for_status()

    root = etree.fromstring(resp.content)

    ns_uri = "https://podcastindex.org/namespace/1.0"
    atom_uri = "http://www.w3.org/2005/Atom"
    itunes_uri = "http://www.itunes.com/dtds/podcast-1.0.dtd"

    # =========================================================
    # 2. 确保 podcast namespace 存在
    # =========================================================

    nsmap = dict(root.nsmap)

    if nsmap.get("podcast") != ns_uri:
        nsmap["podcast"] = ns_uri

        new_root = etree.Element(root.tag, attrib=root.attrib, nsmap=nsmap)

        new_root[:] = root[:]
        new_root.text = root.text
        new_root.tail = root.tail

        root = new_root

    # =========================================================
    # 3. 获取 channel
    # =========================================================

    channel = root.find("channel", namespaces=root.nsmap)

    if channel is None:
        print("⚠️ 未找到 channel")
        return

    # =========================================================
    # 4. 新 Feed URL
    # =========================================================

    feed_url = f"{BASE_URL}/{PODCAST_SLUG}/feed.xml"

    print(f"   📡 新 Feed URL: {feed_url}")

    # =========================================================
    # 5. 修改 channel title
    # =========================================================

    title_elem = channel.find("title", namespaces=root.nsmap)

    if title_elem is not None and title_elem.text:
        original_title = title_elem.text.strip()

        # 避免重复添加
        original_title = re.sub(
            r"\s*\[Unofficial Transcripts\]\s*$",
            "",
            original_title,
            flags=re.IGNORECASE,
        )

        title_elem.text = f"{original_title} " f"[Unofficial Transcripts]"

        print(f"   📝 RSS 标题: {title_elem.text}")

    # =========================================================
    # 6. 更新 channel/link
    # =========================================================

    link_elem = channel.find("link", namespaces=root.nsmap)

    if link_elem is not None:
        link_elem.text = BASE_URL

        print(f"   🔗 <channel><link>: {BASE_URL}")

    # =========================================================
    # 7. 更新 channel/image
    # =========================================================

    image = channel.find("image", namespaces=root.nsmap)

    if image is not None:

        img_link = image.find("link", namespaces=root.nsmap)

        if img_link is not None:
            img_link.text = BASE_URL

        img_title = image.find("title", namespaces=root.nsmap)

        if img_title is not None and title_elem is not None:
            img_title.text = title_elem.text

    # =========================================================
    # 8. 更新 Atom links
    #
    # 对 Podcast App 来说非常重要。
    #
    # self     → 我们自己的 Feed
    # next     → 不再指向官方 RSS
    # previous → 不再指向官方 RSS
    # first    → 我们自己的 Feed
    # last     → 我们自己的 Feed
    # =========================================================

    for atom_link in root.findall(f".//{{{atom_uri}}}link"):

        rel = atom_link.get("rel")

        if rel == "self":
            atom_link.set("href", feed_url)

            print(f"   🔗 atom:self → {feed_url}")

        elif rel in ("first", "last"):
            atom_link.set("href", feed_url)

        elif rel in ("next", "previous"):
            parent = atom_link.getparent()

            if parent is not None:
                parent.remove(atom_link)

                print(f"   🗑️ 删除 atom:{rel}")

    # =========================================================
    # 9. 更新 itunes:new-feed-url
    # =========================================================

    new_feed = channel.find(f"{{{itunes_uri}}}new-feed-url")

    if new_feed is not None:
        new_feed.text = feed_url

        print(f"   🔄 itunes:new-feed-url → {feed_url}")

    # =========================================================
    # 10. 获取 processed
    # =========================================================

    processed = pc_state.get("processed", {})

    print(f"   📂 state 中已处理: " f"{len(processed)} 集")

    # =========================================================
    # 11. 过滤 episode
    #
    # 这里是最重要的部分。
    #
    # 官方 RSS：
    #
    #   Episode 10
    #   Episode 9
    #   Episode 8
    #   Episode 7
    #   Episode 6
    #
    # state：
    #
    #   Episode 10
    #   Episode 9
    #   Episode 8
    #
    # 最终 Feed：
    #
    #   Episode 10
    #   Episode 9
    #   Episode 8
    #
    # =========================================================

    added = 0
    replaced_audio = 0
    removed_items = 0
    kept_items = 0

    items = channel.findall("item", namespaces=root.nsmap)

    for item in list(items):

        guid_elem = item.find("guid", namespaces=root.nsmap)

        # -----------------------------------------------------
        # 没有 GUID
        # -----------------------------------------------------

        if guid_elem is None or not guid_elem.text:
            channel.remove(item)

            removed_items += 1

            print("   🗑️ 删除没有 GUID 的 episode")

            continue

        guid = guid_elem.text.strip()

        # -----------------------------------------------------
        # 未处理
        # -----------------------------------------------------

        if guid not in processed:

            title = item.findtext("title", default="untitled", namespaces=root.nsmap)

            channel.remove(item)

            removed_items += 1

            print(f"   🗑️ 删除未处理 episode: {title}")

            continue

        # -----------------------------------------------------
        # 已处理
        # -----------------------------------------------------

        kept_items += 1

        episode_state = processed[guid]

        title = item.findtext("title", default="untitled", namespaces=root.nsmap)

        print(f"   ✅ 保留 episode: {title}")

        # =====================================================
        # 12. 替换 enclosure
        # =====================================================

        actual_audio_url = episode_state.get("audio_url")

        if actual_audio_url:

            enclosures = item.findall("enclosure")

            if enclosures:

                enclosure = enclosures[0]

                old_url = enclosure.get("url", "")

                if old_url and old_url != actual_audio_url:

                    enclosure.set("url", actual_audio_url)

                    replaced_audio += 1

                    print("      🔗 enclosure:")

                    print(f"         原: {old_url}")

                    print(f"         新: {actual_audio_url}")

        # =====================================================
        # 13. 注入 Podcasting 2.0 transcript
        # =====================================================

        vtt_filename = episode_state.get("vtt_filename")

        if not vtt_filename:
            print("      ⚠️ 没有 VTT 文件名")

            continue

        vtt_url = f"{BASE_URL}/" f"{PODCAST_SLUG}/transcripts/" f"{vtt_filename}"

        existing_transcripts = item.findall(f"{{{ns_uri}}}transcript")

        # -----------------------------------------------------
        # 如果已经存在相同 URL，就不重复添加
        # -----------------------------------------------------

        already_exists = any(e.get("url") == vtt_url for e in existing_transcripts)

        if not already_exists:

            t = etree.SubElement(item, f"{{{ns_uri}}}transcript")

            t.set("url", vtt_url)

            t.set("type", "text/vtt")

            t.set("rel", "captions")

            added += 1

            print(f"      📝 transcript: {vtt_url}")

    # =========================================================
    # 14. 获取最终剩余 episode
    # =========================================================

    final_items = channel.findall("item", namespaces=root.nsmap)

    print(f"\n   📊 Feed episode 统计:")

    print(f"      保留: {kept_items}")

    print(f"      删除: {removed_items}")

    print(f"      Transcript 新增: {added}")

    print(f"      enclosure 替换: {replaced_audio}")

    # =========================================================
    # 15. 找到 Feed 中最新 episode 的 pubDate
    # =========================================================

    latest_pub_date = None
    latest_timestamp = None

    for item in final_items:

        pub_date_elem = item.find("pubDate", namespaces=root.nsmap)

        if pub_date_elem is None or not pub_date_elem.text:
            continue

        pub_date_text = pub_date_elem.text.strip()

        try:
            from email.utils import parsedate_to_datetime

            dt = parsedate_to_datetime(pub_date_text)

            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)

            timestamp = dt.timestamp()

            if latest_timestamp is None or timestamp > latest_timestamp:
                latest_timestamp = timestamp
                latest_pub_date = pub_date_text

        except Exception:
            continue

    # =========================================================
    # 16. 更新 channel/pubDate
    #
    # 使用当前 Feed 中最新 episode 的发布时间。
    # =========================================================

    channel_pub_date = channel.find("pubDate", namespaces=root.nsmap)

    if channel_pub_date is not None:

        if latest_pub_date:

            channel_pub_date.text = latest_pub_date

            print(f"   📅 channel pubDate: " f"{latest_pub_date}")

        else:

            # 如果解析不到 episode 的 pubDate，
            # 就使用当前 UTC 时间。
            now = datetime.now(timezone.utc)

            channel_pub_date.text = now.strftime("%a, %d %b %Y %H:%M:%S GMT")

            print("   📅 channel pubDate " "使用当前时间")

    # =========================================================
    # 17. 更新 lastBuildDate
    #
    # 这是 Feed 内容发生变化的时间。
    # =========================================================

    last_build = channel.find("lastBuildDate", namespaces=root.nsmap)

    now = datetime.now(timezone.utc)

    now_rfc822 = now.strftime("%a, %d %b %Y %H:%M:%S GMT")

    if last_build is not None:

        last_build.text = now_rfc822

    else:

        last_build = etree.Element("lastBuildDate")

        last_build.text = now_rfc822

        # 放在 channel 最前面
        channel.insert(0, last_build)

    print(f"   🔄 lastBuildDate: " f"{now_rfc822}")

    # =========================================================
    # 18. 更新 Atom updated
    #
    # 如果原 RSS 使用 Atom <updated>，
    # 同步修改。
    # =========================================================

    updated_elems = root.findall(f".//{{{atom_uri}}}updated")

    now_atom = now.isoformat()

    for updated in updated_elems:
        updated.text = now_atom

    # =========================================================
    # 19. 如果 Feed 完全没有 episode
    # =========================================================

    if not final_items:

        print("   ⚠️ 当前没有任何已经处理的 episode")

    # =========================================================
    # 20. 写入 Feed
    # =========================================================

    tree = etree.ElementTree(root)

    feed_path = PODCAST_DIR / "feed.xml"

    tree.write(feed_path, pretty_print=True, xml_declaration=True, encoding="utf-8")

    print(f"\n💾 Feed 已保存:" f" {feed_path}")

    # =========================================================
    # 21. 生成播客首页
    # =========================================================

    total = pc_state.get("total_processed", 0)

    display_name = f"{PODCAST_SLUG} (Unofficial)"

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport"
      content="width=device-width, initial-scale=1">

<title>
{display_name} - Transcripts
</title>

<style>
body {{
    font-family:
        system-ui,
        -apple-system,
        sans-serif;

    max-width: 720px;
    margin: 40px auto;
    padding: 0 20px;
    line-height: 1.6;
    color: #333;
}}

code {{
    background: #f4f4f4;
    padding: 2px 6px;
    border-radius: 4px;
    word-break: break-all;
}}

a {{
    color: #0366d6;
}}
</style>

</head>

<body>

<h1>
🎙️ {display_name}
</h1>

<p>
<strong>原 RSS：</strong>
<a
    href="{FEED_URL}"
    target="_blank"
>
{FEED_URL}
</a>
</p>

<p>
<strong>带字幕 Feed：</strong>
<br>

<code>
<a href="{feed_url}">
{feed_url}
</a>
</code>
</p>

<p>
已处理
<strong>{total}</strong>
集
（中英双语字幕）。
</p>

<p>
当前 Feed 仅包含已经完成转录的集数。
</p>

</body>
</html>"""

    (PODCAST_DIR / "index.html").write_text(html, encoding="utf-8")

    print(f"🌐 播客页面已生成: " f"{PODCAST_DIR / 'index.html'}")
    print("🔄 生成播客 RSS feed...")

    resp = requests.get(FEED_URL, timeout=60)

    resp.raise_for_status()

    root = etree.fromstring(resp.content)

    ns_uri = "https://podcastindex.org/namespace/1.0"
    atom_uri = "http://www.w3.org/2005/Atom"
    itunes_uri = "http://www.itunes.com/dtds/podcast-1.0.dtd"

    # ---------------------------------------------------------
    # 确保 podcast namespace 声明存在
    # ---------------------------------------------------------

    nsmap = dict(root.nsmap)

    if nsmap.get("podcast") != ns_uri:
        nsmap["podcast"] = ns_uri

        new_root = etree.Element(root.tag, attrib=root.attrib, nsmap=nsmap)

        new_root[:] = root[:]
        new_root.text = root.text
        new_root.tail = root.tail

        root = new_root

    channel = root.find("channel", namespaces=root.nsmap)

    if channel is None:
        print("⚠️ 未找到 channel")
        return

    feed_url = f"{BASE_URL}/{PODCAST_SLUG}/feed.xml"

    # ---------------------------------------------------------
    # 1. 修改 channel title
    # ---------------------------------------------------------

    title_elem = channel.find("title", namespaces=root.nsmap)

    if title_elem is not None and title_elem.text:
        original_title = title_elem.text.strip()

        if "[Unofficial" not in original_title:
            title_elem.text = f"{original_title} " f"[Unofficial Transcripts]"

            print(f"   RSS 标题改为: {title_elem.text}")

    # ---------------------------------------------------------
    # 2. 更新 channel link
    # ---------------------------------------------------------

    link_elem = channel.find("link", namespaces=root.nsmap)

    if link_elem is not None:
        link_elem.text = BASE_URL

        print(f"   <link> 更新为: {BASE_URL}")

    # ---------------------------------------------------------
    # 3. 更新 channel image
    # ---------------------------------------------------------

    image = channel.find("image", namespaces=root.nsmap)

    if image is not None:
        img_link = image.find("link", namespaces=root.nsmap)

        if img_link is not None:
            img_link.text = BASE_URL

            print(f"   <image><link> 更新为: {BASE_URL}")

        img_title = image.find("title", namespaces=root.nsmap)

        if img_title is not None and title_elem is not None:
            img_title.text = title_elem.text

    # ---------------------------------------------------------
    # 4. 更新所有 atom:link
    # ---------------------------------------------------------

    for parent in (channel, root):
        for atom_link in parent.findall(f"{{{atom_uri}}}link"):
            rel = atom_link.get("rel")

            if rel == "self":
                atom_link.set("href", feed_url)

                print("   <atom:link rel='self'> " f"更新为: {feed_url}")

            elif rel in ("first", "last", "previous", "next"):
                atom_link.set("href", feed_url)

    # ---------------------------------------------------------
    # 5. 更新 itunes:new-feed-url
    # ---------------------------------------------------------

    new_feed = channel.find(f"{{{itunes_uri}}}new-feed-url")

    if new_feed is not None:
        new_feed.text = feed_url

        print("   <itunes:new-feed-url> " f"更新为: {feed_url}")

    # ---------------------------------------------------------
    # 6. 已处理 episode
    #
    #    - enclosure 替换成实际音频地址
    #    - 注入 VTT transcript
    # ---------------------------------------------------------

    processed = pc_state.get("processed", {})

    added = 0
    replaced_audio = 0

    for item in channel.findall("item", namespaces=root.nsmap):
        guid_elem = item.find("guid", namespaces=root.nsmap)

        if guid_elem is None or not guid_elem.text:
            continue

        guid = guid_elem.text.strip()

        if guid not in processed:
            continue

        episode_state = processed[guid]

        # -----------------------------------------------------
        # 替换 enclosure URL
        # -----------------------------------------------------

        actual_audio_url = episode_state.get("audio_url")

        if actual_audio_url:
            for enclosure in item.findall("enclosure"):
                old_url = enclosure.get("url", "")

                if old_url and old_url != actual_audio_url:
                    enclosure.set("url", actual_audio_url)

                    replaced_audio += 1

                    print("   🔗 替换 enclosure:")

                    print(f"      原: {old_url}")

                    print(f"      新: {actual_audio_url}")

                break

        # -----------------------------------------------------
        # 注入 VTT
        # -----------------------------------------------------

        vtt_filename = episode_state.get("vtt_filename")

        if not vtt_filename:
            continue

        existing = item.findall(f"{{{ns_uri}}}transcript", namespaces=root.nsmap)

        vtt_url = f"{BASE_URL}/" f"{PODCAST_SLUG}/transcripts/" f"{vtt_filename}"

        if any(e.get("url") == vtt_url for e in existing):
            continue

        t = etree.SubElement(item, f"{{{ns_uri}}}transcript")

        t.set("url", vtt_url)

        t.set("type", "text/vtt")

        t.set("rel", "captions")

        added += 1

    # ---------------------------------------------------------
    # 保存 Feed
    # ---------------------------------------------------------

    tree = etree.ElementTree(root)

    feed_path = PODCAST_DIR / "feed.xml"

    tree.write(feed_path, pretty_print=True, xml_declaration=True, encoding="utf-8")

    print(
        f"💾 Feed 已保存 "
        f"({added} 个字幕标签，"
        f"{replaced_audio} 个 enclosure 已替换): "
        f"{feed_path}"
    )

    # ---------------------------------------------------------
    # 生成播客页面
    # ---------------------------------------------------------

    total = pc_state.get("total_processed", 0)

    display_name = f"{PODCAST_SLUG} (Unofficial)"

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport"
      content="width=device-width, initial-scale=1">
<title>{display_name} - Transcripts</title>
<style>
body {{
    font-family: system-ui, -apple-system, sans-serif;
    max-width: 720px;
    margin: 40px auto;
    padding: 0 20px;
    line-height: 1.6;
    color: #333;
}}

code {{
    background: #f4f4f4;
    padding: 2px 6px;
    border-radius: 4px;
    word-break: break-all;
}}

a {{
    color: #0366d6;
}}
</style>
</head>
<body>

<h1>🎙️ {display_name}</h1>

<p>
<strong>原 RSS：</strong>
<a href="{FEED_URL}" target="_blank">
{FEED_URL}
</a>
</p>

<p>
<strong>带字幕 Feed：</strong><br>
<code>
<a href="{BASE_URL}/{PODCAST_SLUG}/feed.xml">
{BASE_URL}/{PODCAST_SLUG}/feed.xml
</a>
</code>
</p>

<p>
已处理 <strong>{total}</strong> 集
（中英双语字幕）。
</p>

</body>
</html>"""

    (PODCAST_DIR / "index.html").write_text(html, encoding="utf-8")


def generate_master_index(state):
    podcasts = state.get("podcasts", {})

    items = ""

    for slug, pc in podcasts.items():
        total = pc.get("total_processed", 0)

        display_name = f"{slug} (Unofficial)"

        items += (
            f"<li>"
            f'<a href="{BASE_URL}/{slug}/">'
            f"{display_name}"
            f"</a> — 已处理 {total} 集 "
            f"<small>("
            f'<a href="{BASE_URL}/{slug}/feed.xml">'
            f"Feed"
            f"</a>)</small>"
            f"</li>\n"
        )

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport"
      content="width=device-width, initial-scale=1">
<title>Podcast Transcripts Hub (Unofficial)</title>
<style>
body {{
    font-family: system-ui, -apple-system, sans-serif;
    max-width: 720px;
    margin: 40px auto;
    padding: 0 20px;
    line-height: 1.6;
    color: #333;
}}

a {{
    color: #0366d6;
}}

li {{
    margin: 8px 0;
}}
</style>
</head>
<body>

<h1>🎙️ Podcast Transcripts Hub (Unofficial)</h1>

<p>
以下播客均已自动生成中英双语 VTT 字幕（非官方）：
</p>

<ul>
{items}
</ul>

</body>
</html>"""

    (SITE_DIR / "index.html").write_text(html, encoding="utf-8")


def main():
    if not FEED_URL or not BASE_URL or not PODCAST_SLUG:
        print("❌ 错误：需要设置 " "PODCAST_SLUG, FEED_URL, BASE_URL")

        sys.exit(1)

    print(f"🎙️ 播客: {PODCAST_SLUG}")

    print(f"📡 RSS: {FEED_URL}")

    print(f"🌐 BASE_URL: {BASE_URL}")

    print(f"🧠 模型: {MODEL_SIZE}")

    # ---------------------------------------------------------
    # 加载状态
    # ---------------------------------------------------------

    state = load_state()

    pc_state = get_podcast_state(state)

    processed = pc_state.get("processed", {})

    print(f"📂 该播客已处理 " f"{pc_state.get('total_processed', 0)} 集")

    # ---------------------------------------------------------
    # 获取 RSS
    # ---------------------------------------------------------

    feed = feedparser.parse(FEED_URL)

    entries = list(feed.entries)

    if not entries:
        print("⚠️ RSS 无条目")
        sys.exit(0)

    # ---------------------------------------------------------
    # 查找下一集
    # ---------------------------------------------------------

    next_entry = find_next_entry(entries, processed)

    if not next_entry:
        print("✅ 该播客全部处理完毕，仅更新 Feed")

        generate_podcast_feed(pc_state)

        generate_master_index(state)

        save_state(state)

        sys.exit(0)

    title = next_entry.get("title", "untitled")

    guid = next_entry.get("guid") or next_entry.get("id") or title

    print(f"\n🎯 本次处理: {title}")

    # ---------------------------------------------------------
    # 获取原始 enclosure
    # ---------------------------------------------------------

    enclosure_url = get_audio_url(next_entry)

    if not enclosure_url:
        print("❌ RSS 中未找到音频 enclosure")

        sys.exit(1)

    print("📎 RSS enclosure:")

    print(f"   {enclosure_url}")

    # ---------------------------------------------------------
    # 解析实际音频 URL
    # ---------------------------------------------------------

    audio_url, audio_source = resolve_enclosure_url(enclosure_url)

    if audio_url != enclosure_url:
        print(f"🔄 使用解析后的实际音频地址 " f"({audio_source})")
    else:
        print(f"ℹ️ 使用 enclosure 原地址 " f"({audio_source})")

    # ---------------------------------------------------------
    # 下载音频
    # ---------------------------------------------------------

    safe_title = safe_filename(title)

    mp3_path = PODCAST_DIR / f"{safe_title}.mp3"

    print("⬇️ 下载用于 Whisper 的实际音频...")

    try:
        r = requests.get(
            audio_url,
            timeout=300,
            headers={
                "User-Agent": "Mozilla/5.0",
                "Accept": ("audio/mpeg," "audio/*;q=0.9," "*/*;q=0.8"),
            },
            allow_redirects=True,
        )

        r.raise_for_status()

        content_type = r.headers.get("Content-Type", "")

        print(f"   HTTP: {r.status_code}")

        print(f"   Content-Type: {content_type}")

        print(f"   最终 URL: {r.url}")

        mp3_path.write_bytes(r.content)

        print(f"   " f"{mp3_path.stat().st_size / 1024 / 1024:.1f}" f" MB")

    except Exception as e:
        print(f"❌ 下载失败: {e}")

        sys.exit(1)

    # ---------------------------------------------------------
    # Whisper 转录
    # ---------------------------------------------------------

    print(f"📝 使用实际音频进行转录 " f"({MODEL_SIZE}, CPU int8, VAD)...")

    try:
        model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")

        segments_iter, info = model.transcribe(
            str(mp3_path),
            beam_size=5,
            language="en",
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=300),
            condition_on_previous_text=False,
            initial_prompt=(
                "Please punctuate accurately " "and break sentences naturally."
            ),
            log_prob_threshold=-1.0,
            no_speech_threshold=0.6,
        )

        total_duration = getattr(info, "duration", None)

        segments = []

        for i, seg in enumerate(segments_iter, 1):
            segments.append(seg)

            if i % 10 == 0:
                if total_duration and total_duration > 0:
                    pct = seg.end / total_duration * 100

                    print(
                        f"   转录进度: {pct:.1f}% "
                        f"({seg.end:.1f}s / "
                        f"{total_duration:.1f}s) | "
                        f"第 {i} 段"
                    )

                else:
                    print(f"   转录进度: " f"{seg.end:.1f}s | " f"第 {i} 段")

        print(f"   语言: {info.language} " f"({info.language_probability:.2f})")

        print(f"   共 {len(segments)} 个片段")

    except Exception as e:
        print(f"❌ 转录失败: {e}")

        sys.exit(1)

    finally:
        if mp3_path.exists():
            mp3_path.unlink()

    # ---------------------------------------------------------
    # 重新切句
    # ---------------------------------------------------------

    print(f"✂️ 后处理：按句子重新切分 " f"{len(segments)} 个原始片段...")

    sentences = resegment(segments)

    print(f"   合并为 {len(sentences)} " f"个句子级片段")

    # ---------------------------------------------------------
    # 翻译
    # ---------------------------------------------------------

    print("🌐 开始翻译（英→中，失败无限重试）...")

    bilingual = translate_sentences(sentences)

    # ---------------------------------------------------------
    # 写 VTT
    # ---------------------------------------------------------

    vtt_filename = f"{safe_title}.vtt"

    vtt_path = TRANSCRIPTS_DIR / vtt_filename

    write_bilingual_vtt(bilingual, vtt_path)

    print(f"💾 双语 VTT: " f"{vtt_path.name}")

    # ---------------------------------------------------------
    # 保存处理状态
    #
    # enclosure_url = RSS 原始地址
    # audio_url     = 实际用于 Whisper 的地址
    # ---------------------------------------------------------

    processed[guid] = {
        "title": title,
        "vtt_filename": vtt_filename,
        "processed_at": (datetime.now(timezone.utc).isoformat()),
        "enclosure_url": enclosure_url,
        "audio_url": audio_url,
        "audio_source": audio_source,
    }

    pc_state["total_processed"] = pc_state.get("total_processed", 0) + 1

    pc_state["updated_at"] = datetime.now(timezone.utc).isoformat()

    save_state(state)

    # ---------------------------------------------------------
    # 生成 Feed
    # ---------------------------------------------------------

    generate_podcast_feed(pc_state)

    generate_master_index(state)

    # ---------------------------------------------------------
    # 完成
    # ---------------------------------------------------------

    print(f"\n✅ 完成！" f"该播客累计 " f"{pc_state['total_processed']} 集")

    print(f"🎧 Feed: " f"{BASE_URL}/{PODCAST_SLUG}/feed.xml")


if __name__ == "__main__":
    main()
