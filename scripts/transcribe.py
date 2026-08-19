import os
import sys
import json
import time
import re
import feedparser
import requests

from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

from faster_whisper import WhisperModel
from pathlib import Path
from lxml import etree
from urllib.parse import urlsplit, unquote


# ============================================================
# 配置
# ============================================================

PODCAST_SLUG = os.environ.get(
    "PODCAST_SLUG",
    "default"
)

FEED_URL = os.environ.get(
    "FEED_URL"
)

MODEL_SIZE = os.environ.get(
    "WHISPER_MODEL",
    "base"
)

BASE_URL = os.environ.get(
    "BASE_URL",
    ""
).rstrip("/")


# ============================================================
# BASE_URL 兜底
# ============================================================

if not BASE_URL:
    gh_repo = os.environ.get(
        "GITHUB_REPOSITORY",
        ""
    )

    if gh_repo and "/" in gh_repo:
        owner, repo = gh_repo.split(
            "/",
            1
        )

        BASE_URL = (
            f"https://{owner}.github.io/{repo}"
        )

        print(
            f"⚠️ BASE_URL 未设置，"
            f"从 GITHUB_REPOSITORY 推断: {BASE_URL}"
        )


# ============================================================
# 路径
# ============================================================

STATE_FILE = Path(
    "state.json"
)

SITE_DIR = Path(
    "site"
)

PODCAST_DIR = (
    SITE_DIR / PODCAST_SLUG
)

TRANSCRIPTS_DIR = (
    PODCAST_DIR / "transcripts"
)

PODCAST_DIR.mkdir(
    parents=True,
    exist_ok=True
)

TRANSCRIPTS_DIR.mkdir(
    parents=True,
    exist_ok=True
)


# ============================================================
# XML Namespace
# ============================================================

PODCAST_NS = (
    "https://podcastindex.org/namespace/1.0"
)

ATOM_NS = (
    "http://www.w3.org/2005/Atom"
)

ITUNES_NS = (
    "http://www.itunes.com/dtds/"
    "podcast-1.0.dtd"
)


# ============================================================
# Whisper 句号处理
# ============================================================

ABBREVIATIONS = (
    r'\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|vol|vols|'
    r'inc|etc|eg|ie|et al|st|ave|blvd|rd|dept|'
    r'univ|No|pp|par|Ltd|Co|Corp|Plc|LLC|'
    r'U\.S|U\.K|e\.g|i\.e)\.'
)


# ============================================================
# State
# ============================================================

def load_state():
    if STATE_FILE.exists():

        with open(
            STATE_FILE,
            "r",
            encoding="utf-8"
        ) as f:

            return json.load(f)

    return {
        "podcasts": {}
    }


def save_state(state):

    with open(
        STATE_FILE,
        "w",
        encoding="utf-8"
    ) as f:

        json.dump(
            state,
            f,
            ensure_ascii=False,
            indent=2
        )


def get_podcast_state(state):

    podcasts = state.setdefault(
        "podcasts",
        {}
    )

    if PODCAST_SLUG not in podcasts:

        podcasts[PODCAST_SLUG] = {
            "feed_url": FEED_URL,
            "processed": {},
            "total_processed": 0,
            "updated_at": None
        }

    return podcasts[PODCAST_SLUG]


# ============================================================
# 文件名
# ============================================================

def safe_filename(title):

    keep = (
        "abcdefghijklmnopqrstuvwxyz"
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        "0123456789-_. "
    )

    result = "".join(
        c if c in keep else "_"
        for c in title
    )

    result = result.strip()

    result = result.replace(
        " ",
        "_"
    )

    return result[:80]


# ============================================================
# VTT 时间
# ============================================================

def format_vtt_time(seconds):

    hours = int(
        seconds // 3600
    )

    minutes = int(
        (seconds % 3600) // 60
    )

    secs = int(
        seconds % 60
    )

    millis = int(
        (seconds % 1) * 1000
    )

    return (
        f"{hours:02d}:"
        f"{minutes:02d}:"
        f"{secs:02d}."
        f"{millis:03d}"
    )


# ============================================================
# 句子切分
# ============================================================

def split_sentences(text):

    if not text:
        return []

    protected = re.sub(
        ABBREVIATIONS,
        lambda m: m.group(0).replace(
            ".",
            "##DOT##"
        ),
        text
    )

    parts = re.split(
        r'(?<=[.!?])\s+',
        protected
    )

    return [
        p.replace(
            "##DOT##",
            "."
        ).strip()

        for p in parts

        if p.strip()
    ]


def resegment(raw_segments):

    entries = []

    for seg in raw_segments:

        text = seg.text.strip()

        if text:

            entries.append({
                "start": seg.start,
                "end": seg.end,
                "text": text
            })

    merged = []

    buf = {
        "text": "",
        "start": 0,
        "end": 0
    }

    for e in entries:

        if not buf["text"]:

            buf = dict(e)

        else:

            buf["text"] += (
                " " + e["text"]
            )

            buf["end"] = e["end"]

        if re.search(
            r'[.!?]["\']?$',
            buf["text"]
        ):

            merged.append(
                dict(buf)
            )

            buf = {
                "text": "",
                "start": 0,
                "end": 0
            }

    if buf["text"]:
        merged.append(buf)

    final = []

    for m in merged:

        sentences = split_sentences(
            m["text"]
        )

        if len(sentences) <= 1:

            final.append(m)

            continue

        total_chars = sum(
            len(s)
            for s in sentences
        )

        t = m["start"]

        duration = (
            m["end"] - m["start"]
        )

        for sent in sentences:

            ratio = (
                len(sent) / total_chars
                if total_chars > 0
                else 1 / len(sentences)
            )

            seg_dur = max(
                duration * ratio,
                0.5
            )

            final.append({
                "start": t,
                "end": t + seg_dur,
                "text": sent
            })

            t += seg_dur

    return final


# ============================================================
# VTT
# ============================================================

def write_bilingual_vtt(
    sentences,
    path
):

    with open(
        path,
        "w",
        encoding="utf-8"
    ) as f:

        f.write(
            "WEBVTT\n\n"
        )

        for item in sentences:

            start = format_vtt_time(
                item["start"]
            )

            end = format_vtt_time(
                item["end"]
            )

            en = (
                item["en"]
                .strip()
                .replace("\n", " ")
            )

            zh = (
                item["zh"]
                .strip()
                .replace("\n", " ")
            )

            f.write(
                f"{start} --> {end}\n"
                f"{en}\n"
                f"{zh}\n\n"
            )


# ============================================================
# 翻译
# ============================================================

def translate_with_retry(
    text,
    translator,
    base_delay=1.0
):

    attempt = 0

    while True:

        try:

            return translator.translate(
                text
            )

        except Exception as e:

            attempt += 1

            sleep_time = (
                base_delay
                * (
                    1.5
                    ** min(
                        attempt,
                        10
                    )
                )
            )

            print(
                f"   ⚠️ 第 {attempt} 次失败: "
                f"{e}, "
                f"sleep {sleep_time:.1f}s..."
            )

            time.sleep(
                sleep_time
            )


def translate_sentences(sentences):

    from deep_translator import (
        GoogleTranslator
    )

    translator = GoogleTranslator(
        source="en",
        target="zh-CN"
    )

    total = len(
        sentences
    )

    results = []

    for i, s in enumerate(
        sentences,
        1
    ):

        text = s["text"]

        if not text:

            results.append({
                **s,
                "en": "",
                "zh": ""
            })

            continue

        zh = translate_with_retry(
            text,
            translator
        )

        results.append({
            **s,
            "en": text,
            "zh": zh
        })

        if (
            i % 20 == 0
            or i == total
        ):

            print(
                f"   翻译进度: "
                f"{i}/{total}"
            )

    return results


# ============================================================
# Feedparser GUID
# ============================================================

def get_entry_guid(entry):

    value = (
        entry.get("guid")
        or entry.get("id")
        or entry.get("title")
        or ""
    )

    return str(
        value
    ).strip()


# ============================================================
# XML 子元素获取
#
# 不依赖 namespace。
# ============================================================

def get_child_text(
    element,
    local_names
):

    if isinstance(
        local_names,
        str
    ):

        local_names = [
            local_names
        ]

    for child in element:

        try:
            name = etree.QName(
                child
            ).localname

        except Exception:
            continue

        if name in local_names:

            if child.text:

                return child.text.strip()

    return None


def get_child_element(
    element,
    local_name
):

    for child in element:

        try:
            name = etree.QName(
                child
            ).localname

        except Exception:
            continue

        if name == local_name:
            return child

    return None


def get_item_guid(item):

    return get_child_text(
        item,
        [
            "guid",
            "id"
        ]
    )


def get_item_title(item):

    return (
        get_child_text(
            item,
            "title"
        )
        or "untitled"
    )


def get_item_enclosure_url(item):

    for child in item:

        try:
            name = etree.QName(
                child
            ).localname

        except Exception:
            continue

        if name == "enclosure":

            return (
                child.get(
                    "url",
                    ""
                )
                or ""
            ).strip()

    return ""


# ============================================================
# 从 RSS 获取音频
# ============================================================

def get_audio_url(entry):

    for enc in entry.get(
        "enclosures",
        []
    ):

        href = (
            enc.get("href", "")
            or enc.get("url", "")
        )

        type_ = enc.get(
            "type",
            ""
        )

        if (
            "audio" in type_
            or href.lower()
            .split("?")[0]
            .endswith(
                (
                    ".mp3",
                    ".m4a",
                    ".wav",
                    ".aac",
                    ".ogg",
                    ".opus",
                    ".flac",
                    ".m4b"
                )
            )
        ):

            return href

    return None


# ============================================================
# 解析 pdst.fm
# ============================================================

def resolve_enclosure_url(
    enclosure_url
):

    if not enclosure_url:
        return None, "unknown"

    original = (
        enclosure_url
        .strip()
    )

    if not original:
        return None, "unknown"

    lower = original.lower()

    # --------------------------------------------------------
    # 非 pdst.fm
    # --------------------------------------------------------

    if "pdst.fm/" not in lower:

        if (
            "traffic.megaphone.fm"
            in lower
        ):

            return (
                original,
                "megaphone"
            )

        if (
            "serve.castfire.com"
            in lower
        ):

            return (
                original,
                "castfire"
            )

        return (
            original,
            "direct"
        )

    # --------------------------------------------------------
    # pdst.fm
    # --------------------------------------------------------

    try:

        parsed = urlsplit(
            original
        )

    except Exception:

        print(
            "   ⚠️ 无法解析 enclosure URL"
        )

        return (
            original,
            "unknown"
        )

    path = parsed.path

    decoded_path = unquote(
        path
    )

    # --------------------------------------------------------
    # 找 hostname
    # --------------------------------------------------------

    host_pattern = re.compile(
        r'(?:(?<=/)|^)'
        r'([a-zA-Z0-9]'
        r'(?:[a-zA-Z0-9-]{0,61}'
        r'[a-zA-Z0-9])?'
        r'(?:\.'
        r'[a-zA-Z0-9]'
        r'(?:[a-zA-Z0-9-]{0,61}'
        r'[a-zA-Z0-9])?)+)'
        r'(?=/|$)'
    )

    matches = list(
        host_pattern.finditer(
            decoded_path
        )
    )

    candidates = []

    for match in matches:

        host = (
            match.group(1)
            .lower()
        )

        if (
            host == "pdst.fm"
            or host.endswith(
                ".pdst.fm"
            )
        ):
            continue

        candidates.append(
            (
                match,
                host
            )
        )

    # --------------------------------------------------------
    # 已知 host 优先
    # --------------------------------------------------------

    preferred_hosts = [
        (
            "traffic.megaphone.fm",
            "megaphone"
        ),
        (
            "serve.castfire.com",
            "castfire"
        )
    ]

    for preferred_host, source in (
        preferred_hosts
    ):

        for match, host in candidates:

            if host == preferred_host:

                start = match.start(1)

                extracted = (
                    "https://"
                    + decoded_path[start:]
                )

                print(
                    f"   🔎 enclosure 解析: "
                    f"{preferred_host}"
                )

                print(
                    f"   🎧 实际音频: "
                    f"{extracted}"
                )

                return (
                    extracted,
                    source
                )

    # --------------------------------------------------------
    # 通用 host
    # --------------------------------------------------------

    if candidates:

        match, host = candidates[-1]

        start = match.start(1)

        extracted = (
            "https://"
            + decoded_path[start:]
        )

        extracted_lower = (
            extracted.lower()
        )

        audio_extensions = (
            ".mp3",
            ".m4a",
            ".aac",
            ".ogg",
            ".opus",
            ".wav",
            ".flac",
            ".m4b"
        )

        looks_like_audio = (
            any(
                ext in extracted_lower
                for ext in audio_extensions
            )
            or "/audio/"
            in extracted_lower
            or "/episode/"
            in extracted_lower
            or "/episodes/"
            in extracted_lower
        )

        if looks_like_audio:

            print(
                f"   🔎 enclosure 解析: "
                f"{host}"
            )

            print(
                f"   🎧 实际音频: "
                f"{extracted}"
            )

            return (
                extracted,
                "generic"
            )

    print(
        "   ⚠️ 未识别的 pdst.fm "
        "嵌套音频地址，保留原 enclosure"
    )

    return (
        original,
        "unknown"
    )


# ============================================================
# 查找下一集
# ============================================================

def find_next_entry(
    entries,
    processed
):

    def sort_key(e):

        t = (
            e.get(
                "published_parsed"
            )
            or e.get(
                "updated_parsed"
            )
            or time.gmtime(0)
        )

        return time.mktime(t)

    entries.sort(
        key=sort_key
    )

    for entry in entries:

        guid = get_entry_guid(
            entry
        )

        if guid not in processed:

            return entry

    return None


# ============================================================
# 判断 XML episode 是否已处理
#
# 这是这次最重要的函数。
#
# 不只比较 GUID。
#
# 顺序：
#
# 1. GUID
# 2. title
# 3. 原始 enclosure URL
#
# 因此可以兼容之前 state.json 已经产生的记录。
# ============================================================

def find_processed_episode(
    item,
    processed
):

    item_guid = get_item_guid(
        item
    )

    item_title = get_item_title(
        item
    )

    item_enclosure = (
        get_item_enclosure_url(
            item
        )
    )

    # --------------------------------------------------------
    # 1. GUID 精确匹配
    # --------------------------------------------------------

    if item_guid:

        if item_guid in processed:

            return (
                item_guid,
                processed[item_guid],
                "guid"
            )

    # --------------------------------------------------------
    # 2. title 兜底
    # --------------------------------------------------------

    if item_title:

        for state_guid, state_data in (
            processed.items()
        ):

            state_title = str(
                state_data.get(
                    "title",
                    ""
                )
            ).strip()

            if (
                state_title
                and state_title
                == item_title
            ):

                return (
                    state_guid,
                    state_data,
                    "title"
                )

    # --------------------------------------------------------
    # 3. enclosure 兜底
    # --------------------------------------------------------

    if item_enclosure:

        for state_guid, state_data in (
            processed.items()
        ):

            state_enclosure = str(
                state_data.get(
                    "enclosure_url",
                    ""
                )
            ).strip()

            if (
                state_enclosure
                and state_enclosure
                == item_enclosure
            ):

                return (
                    state_guid,
                    state_data,
                    "enclosure"
                )

    return (
        None,
        None,
        None
    )


# ============================================================
# 生成 Feed
# ============================================================

def generate_podcast_feed(
    pc_state
):

    print(
        "🔄 生成播客 RSS feed..."
    )

    # ========================================================
    # 获取官方 RSS
    # ========================================================

    resp = requests.get(
        FEED_URL,
        timeout=60,
        headers={
            "User-Agent": "Mozilla/5.0"
        }
    )

    resp.raise_for_status()

    root = etree.fromstring(
        resp.content
    )

    # ========================================================
    # Namespace
    # ========================================================

    nsmap = dict(
        root.nsmap
    )

    if (
        nsmap.get("podcast")
        != PODCAST_NS
    ):

        nsmap["podcast"] = (
            PODCAST_NS
        )

        new_root = etree.Element(
            root.tag,
            attrib=root.attrib,
            nsmap=nsmap
        )

        new_root[:] = root[:]

        new_root.text = root.text
        new_root.tail = root.tail

        root = new_root

    # ========================================================
    # channel
    #
    # 不使用 namespace 查找
    # ========================================================

    channel = None

    for child in root:

        try:
            name = etree.QName(
                child
            ).localname

        except Exception:
            continue

        if name == "channel":

            channel = child

            break

    if channel is None:

        print(
            "❌ 未找到 channel"
        )

        return

    # ========================================================
    # Feed URL
    # ========================================================

    feed_url = (
        f"{BASE_URL}/"
        f"{PODCAST_SLUG}/feed.xml"
    )

    print(
        f"   📡 新 Feed: {feed_url}"
    )

    # ========================================================
    # title
    # ========================================================

    title_elem = get_child_element(
        channel,
        "title"
    )

    if (
        title_elem is not None
        and title_elem.text
    ):

        original_title = (
            title_elem.text.strip()
        )

        original_title = re.sub(
            r"\s*\[Unofficial Transcripts\]\s*$",
            "",
            original_title,
            flags=re.IGNORECASE
        )

        title_elem.text = (
            f"{original_title} "
            f"[Unofficial Transcripts]"
        )

    # ========================================================
    # channel link
    # ========================================================

    link_elem = get_child_element(
        channel,
        "link"
    )

    if link_elem is not None:

        link_elem.text = (
            BASE_URL
        )

    # ========================================================
    # image
    # ========================================================

    image = get_child_element(
        channel,
        "image"
    )

    if image is not None:

        image_link = (
            get_child_element(
                image,
                "link"
            )
        )

        if image_link is not None:

            image_link.text = (
                BASE_URL
            )

        image_title = (
            get_child_element(
                image,
                "title"
            )
        )

        if (
            image_title is not None
            and title_elem is not None
        ):

            image_title.text = (
                title_elem.text
            )

    # ========================================================
    # Atom links
    # ========================================================

    for elem in root.iter():

        try:

            qname = etree.QName(
                elem
            )

        except Exception:
            continue

        if (
            qname.namespace
            != ATOM_NS
        ):

            continue

        if (
            qname.localname
            != "link"
        ):

            continue

        rel = elem.get(
            "rel"
        )

        if rel == "self":

            elem.set(
                "href",
                feed_url
            )

        elif rel in (
            "next",
            "previous"
        ):

            parent = (
                elem.getparent()
            )

            if parent is not None:

                parent.remove(
                    elem
                )

        elif rel in (
            "first",
            "last"
        ):

            elem.set(
                "href",
                feed_url
            )

    # ========================================================
    # itunes:new-feed-url
    # ========================================================

    new_feed = None

    for child in channel:

        try:

            qname = etree.QName(
                child
            )

        except Exception:
            continue

        if (
            qname.namespace
            == ITUNES_NS
            and qname.localname
            == "new-feed-url"
        ):

            new_feed = child

            break

    if new_feed is not None:

        new_feed.text = (
            feed_url
        )

    # ========================================================
    # processed
    # ========================================================

    processed = pc_state.get(
        "processed",
        {}
    )

    print(
        f"   📂 state.json 已处理: "
        f"{len(processed)} 集"
    )

    # ========================================================
    # 找出所有 item
    #
    # 不使用 channel.findall("item")
    #
    # 直接判断 localname。
    # ========================================================

    items = []

    for child in list(channel):

        try:

            name = etree.QName(
                child
            ).localname

        except Exception:
            continue

        if name == "item":

            items.append(
                child
            )

    print(
        f"   📡 官方 RSS item: "
        f"{len(items)} 集"
    )

    # ========================================================
    # 过滤
    # ========================================================

    kept_items = 0
    removed_items = 0
    added_transcripts = 0
    replaced_audio = 0

    latest_pub_timestamp = None
    latest_pub_text = None

    for item in list(items):

        item_title = get_item_title(
            item
        )

        item_guid = get_item_guid(
            item
        )

        (
            matched_guid,
            episode_state,
            match_type
        ) = find_processed_episode(
            item,
            processed
        )

        # ====================================================
        # 未处理 → 真正删除
        # ====================================================

        if episode_state is None:

            print(
                f"   🗑️ 删除未处理: "
                f"{item_title}"
            )

            if item_guid:

                print(
                    f"      GUID: "
                    f"{item_guid}"
                )

            channel.remove(
                item
            )

            removed_items += 1

            continue

        # ====================================================
        # 已处理 → 保留
        # ====================================================

        kept_items += 1

        print(
            f"   ✅ 保留: "
            f"{item_title}"
        )

        print(
            f"      匹配方式: "
            f"{match_type}"
        )

        # ====================================================
        # enclosure
        # ====================================================

        actual_audio_url = (
            episode_state.get(
                "audio_url"
            )
        )

        if actual_audio_url:

            enclosure = (
                get_child_element(
                    item,
                    "enclosure"
                )
            )

            if enclosure is not None:

                old_url = (
                    enclosure.get(
                        "url",
                        ""
                    )
                )

                if (
                    old_url
                    != actual_audio_url
                ):

                    enclosure.set(
                        "url",
                        actual_audio_url
                    )

                    replaced_audio += 1

                    print(
                        "      🔗 enclosure:"
                    )

                    print(
                        f"         原: "
                        f"{old_url}"
                    )

                    print(
                        f"         新: "
                        f"{actual_audio_url}"
                    )

        # ====================================================
        # transcript
        # ====================================================

        vtt_filename = (
            episode_state.get(
                "vtt_filename"
            )
        )

        if vtt_filename:

            vtt_url = (
                f"{BASE_URL}/"
                f"{PODCAST_SLUG}/"
                f"transcripts/"
                f"{vtt_filename}"
            )

            transcript_exists = False

            for child in item:

                try:

                    qname = etree.QName(
                        child
                    )

                except Exception:
                    continue

                if (
                    qname.localname
                    != "transcript"
                ):

                    continue

                if (
                    child.get("url")
                    == vtt_url
                ):

                    transcript_exists = True

                    break

            if not transcript_exists:

                transcript = etree.SubElement(
                    item,
                    f"{{{PODCAST_NS}}}transcript"
                )

                transcript.set(
                    "url",
                    vtt_url
                )

                transcript.set(
                    "type",
                    "text/vtt"
                )

                transcript.set(
                    "rel",
                    "captions"
                )

                added_transcripts += 1

        # ====================================================
        # 读取 episode pubDate
        # ====================================================

        pub_date_elem = (
            get_child_element(
                item,
                "pubDate"
            )
        )

        if (
            pub_date_elem is not None
            and pub_date_elem.text
        ):

            pub_text = (
                pub_date_elem.text.strip()
            )

            try:

                dt = parsedate_to_datetime(
                    pub_text
                )

                if dt.tzinfo is None:

                    dt = dt.replace(
                        tzinfo=timezone.utc
                    )

                timestamp = (
                    dt.timestamp()
                )

                if (
                    latest_pub_timestamp
                    is None
                    or timestamp
                    > latest_pub_timestamp
                ):

                    latest_pub_timestamp = (
                        timestamp
                    )

                    latest_pub_text = (
                        pub_text
                    )

            except Exception:

                pass

    # ========================================================
    # 最终统计
    # ========================================================

    print()
    print(
        "========== Feed 过滤结果 =========="
    )

    print(
        f"官方 episode: "
        f"{len(items)}"
    )

    print(
        f"保留: "
        f"{kept_items}"
    )

    print(
        f"删除: "
        f"{removed_items}"
    )

    print(
        f"新增 transcript: "
        f"{added_transcripts}"
    )

    print(
        f"替换 enclosure: "
        f"{replaced_audio}"
    )

    print(
        "===================================="
    )

    # ========================================================
    # channel pubDate
    # ========================================================

    channel_pub_date = (
        get_child_element(
            channel,
            "pubDate"
        )
    )

    if channel_pub_date is not None:

        if latest_pub_text:

            channel_pub_date.text = (
                latest_pub_text
            )

        else:

            now = datetime.now(
                timezone.utc
            )

            channel_pub_date.text = (
                now.strftime(
                    "%a, %d %b %Y %H:%M:%S GMT"
                )
            )

    # ========================================================
    # lastBuildDate
    # ========================================================

    now = datetime.now(
        timezone.utc
    )

    now_rfc822 = now.strftime(
        "%a, %d %b %Y %H:%M:%S GMT"
    )

    last_build = (
        get_child_element(
            channel,
            "lastBuildDate"
        )
    )

    if last_build is not None:

        last_build.text = (
            now_rfc822
        )

    else:

        last_build = etree.Element(
            "lastBuildDate"
        )

        last_build.text = (
            now_rfc822
        )

        channel.insert(
            0,
            last_build
        )

    # ========================================================
    # Atom updated
    # ========================================================

    now_atom = (
        now.isoformat()
    )

    for elem in root.iter():

        try:

            qname = etree.QName(
                elem
            )

        except Exception:
            continue

        if (
            qname.namespace
            == ATOM_NS
            and qname.localname
            == "updated"
        ):

            elem.text = (
                now_atom
            )

    # ========================================================
    # 写 Feed
    # ========================================================

    tree = etree.ElementTree(
        root
    )

    feed_path = (
        PODCAST_DIR / "feed.xml"
    )

    tree.write(
        feed_path,
        pretty_print=True,
        xml_declaration=True,
        encoding="utf-8"
    )

    print(
        f"\n💾 Feed 已保存:"
        f" {feed_path}"
    )

    # ========================================================
    # 生成播客首页
    # ========================================================

    total = pc_state.get(
        "total_processed",
        0
    )

    display_name = (
        f"{PODCAST_SLUG} (Unofficial)"
    )

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>

<meta charset="utf-8">

<meta
    name="viewport"
    content="width=device-width, initial-scale=1"
>

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

当前 Feed
<strong>仅包含已经完成转录的集数</strong>。

</p>

</body>
</html>
"""

    (
        PODCAST_DIR / "index.html"
    ).write_text(
        html,
        encoding="utf-8"
    )


# ============================================================
# Master Index
# ============================================================

def generate_master_index(
    state
):

    podcasts = state.get(
        "podcasts",
        {}
    )

    items = ""

    for slug, pc in podcasts.items():

        total = pc.get(
            "total_processed",
            0
        )

        display_name = (
            f"{slug} (Unofficial)"
        )

        items += (
            f'<li>'
            f'<a href="{BASE_URL}/{slug}/">'
            f'{display_name}'
            f'</a> — '
            f'已处理 {total} 集 '
            f'<small>('
            f'<a href="{BASE_URL}/{slug}/feed.xml">'
            f'Feed'
            f'</a>)'
            f'</small>'
            f'</li>\n'
        )

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">

<head>

<meta charset="utf-8">

<meta
    name="viewport"
    content="width=device-width, initial-scale=1"
>

<title>
Podcast Transcripts Hub (Unofficial)
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

a {{
    color: #0366d6;
}}

li {{
    margin: 8px 0;
}}

</style>

</head>

<body>

<h1>
🎙️ Podcast Transcripts Hub (Unofficial)
</h1>

<p>
以下播客均已自动生成中英双语 VTT 字幕（非官方）：
</p>

<ul>

{items}

</ul>

</body>

</html>
"""

    (
        SITE_DIR / "index.html"
    ).write_text(
        html,
        encoding="utf-8"
    )


# ============================================================
# Main
# ============================================================

def main():

    # ========================================================
    # 检查配置
    # ========================================================

    if (
        not FEED_URL
        or not BASE_URL
        or not PODCAST_SLUG
    ):

        print(
            "❌ 错误：需要设置 "
            "PODCAST_SLUG, "
            "FEED_URL, "
            "BASE_URL"
        )

        sys.exit(1)

    print(
        f"🎙️ 播客: "
        f"{PODCAST_SLUG}"
    )

    print(
        f"📡 RSS: "
        f"{FEED_URL}"
    )

    print(
        f"🌐 BASE_URL: "
        f"{BASE_URL}"
    )

    print(
        f"🧠 模型: "
        f"{MODEL_SIZE}"
    )

    # ========================================================
    # State
    # ========================================================

    state = load_state()

    pc_state = get_podcast_state(
        state
    )

    processed = pc_state.get(
        "processed",
        {}
    )

    print(
        f"📂 该播客已处理 "
        f"{pc_state.get('total_processed', 0)} 集"
    )

    # ========================================================
    # RSS
    # ========================================================

    feed = feedparser.parse(
        FEED_URL
    )

    entries = list(
        feed.entries
    )

    if not entries:

        print(
            "⚠️ RSS 无条目"
        )

        sys.exit(0)

    # ========================================================
    # 查找下一集
    # ========================================================

    next_entry = find_next_entry(
        entries,
        processed
    )

    # ========================================================
    # 没有新集
    # ========================================================

    if not next_entry:

        print(
            "✅ 该播客全部处理完毕，"
            "仅更新 Feed"
        )

        generate_podcast_feed(
            pc_state
        )

        generate_master_index(
            state
        )

        save_state(
            state
        )

        sys.exit(0)

    # ========================================================
    # Episode 信息
    # ========================================================

    title = next_entry.get(
        "title",
        "untitled"
    )

    guid = get_entry_guid(
        next_entry
    )

    print(
        f"\n🎯 本次处理: "
        f"{title}"
    )

    print(
        f"🆔 GUID: "
        f"{guid}"
    )

    # ========================================================
    # 原始 enclosure
    # ========================================================

    enclosure_url = get_audio_url(
        next_entry
    )

    if not enclosure_url:

        print(
            "❌ RSS 中未找到 "
            "音频 enclosure"
        )

        sys.exit(1)

    print(
        "📎 RSS enclosure:"
    )

    print(
        f"   {enclosure_url}"
    )

    # ========================================================
    # 解析真实音频
    # ========================================================

    (
        audio_url,
        audio_source
    ) = resolve_enclosure_url(
        enclosure_url
    )

    if (
        audio_url
        != enclosure_url
    ):

        print(
            f"🔄 使用解析后的实际音频地址 "
            f"({audio_source})"
        )

    else:

        print(
            f"ℹ️ 使用 enclosure 原地址 "
            f"({audio_source})"
        )

    # ========================================================
    # 临时音频
    # ========================================================

    safe_title = safe_filename(
        title
    )

    mp3_path = (
        PODCAST_DIR
        / f"{safe_title}.mp3"
    )

    print(
        "⬇️ 下载用于 Whisper "
        "的实际音频..."
    )

    try:

        r = requests.get(
            audio_url,
            timeout=300,
            headers={
                "User-Agent":
                    "Mozilla/5.0",

                "Accept":
                    "audio/mpeg,"
                    "audio/*;q=0.9,"
                    "*/*;q=0.8",
            },
            allow_redirects=True,
        )

        r.raise_for_status()

        content_type = (
            r.headers.get(
                "Content-Type",
                ""
            )
        )

        print(
            f"   HTTP: "
            f"{r.status_code}"
        )

        print(
            f"   Content-Type: "
            f"{content_type}"
        )

        print(
            f"   最终 URL: "
            f"{r.url}"
        )

        mp3_path.write_bytes(
            r.content
        )

        print(
            f"   "
            f"{mp3_path.stat().st_size / 1024 / 1024:.1f}"
            f" MB"
        )

    except Exception as e:

        print(
            f"❌ 下载失败: "
            f"{e}"
        )

        sys.exit(1)

    # ========================================================
    # Whisper
    # ========================================================

    print(
        f"📝 使用实际音频进行转录 "
        f"({MODEL_SIZE}, CPU int8, VAD)..."
    )

    try:

        model = WhisperModel(
            MODEL_SIZE,
            device="cpu",
            compute_type="int8"
        )

        (
            segments_iter,
            info
        ) = model.transcribe(

            str(mp3_path),

            beam_size=5,

            language="en",

            vad_filter=True,

            vad_parameters=dict(
                min_silence_duration_ms=300
            ),

            condition_on_previous_text=False,

            initial_prompt=(
                "Please punctuate accurately "
                "and break sentences naturally."
            ),

            log_prob_threshold=-1.0,

            no_speech_threshold=0.6,
        )

        total_duration = getattr(
            info,
            "duration",
            None
        )

        segments = []

        for i, seg in enumerate(
            segments_iter,
            1
        ):

            segments.append(
                seg
            )

            if i % 10 == 0:

                if (
                    total_duration
                    and total_duration > 0
                ):

                    pct = (
                        seg.end
                        / total_duration
                        * 100
                    )

                    print(
                        f"   转录进度: "
                        f"{pct:.1f}% "
                        f"({seg.end:.1f}s / "
                        f"{total_duration:.1f}s) | "
                        f"第 {i} 段"
                    )

                else:

                    print(
                        f"   转录进度: "
                        f"{seg.end:.1f}s | "
                        f"第 {i} 段"
                    )

        print(
            f"   语言: "
            f"{info.language} "
            f"({info.language_probability:.2f})"
        )

        print(
            f"   共 "
            f"{len(segments)} "
            f"个片段"
        )

    except Exception as e:

        print(
            f"❌ 转录失败: "
            f"{e}"
        )

        sys.exit(1)

    finally:

        if mp3_path.exists():

            mp3_path.unlink()

    # ========================================================
    # 后处理
    # ========================================================

    print(
        f"✂️ 后处理："
        f"按句子重新切分 "
        f"{len(segments)} "
        f"个原始片段..."
    )

    sentences = resegment(
        segments
    )

    print(
        f"   合并为 "
        f"{len(sentences)} "
        f"个句子级片段"
    )

    # ========================================================
    # 翻译
    # ========================================================

    print(
        "🌐 开始翻译"
        "（英→中，失败无限重试）..."
    )

    bilingual = translate_sentences(
        sentences
    )

    # ========================================================
    # VTT
    # ========================================================

    vtt_filename = (
        f"{safe_title}.vtt"
    )

    vtt_path = (
        TRANSCRIPTS_DIR
        / vtt_filename
    )

    write_bilingual_vtt(
        bilingual,
        vtt_path
    )

    print(
        f"💾 双语 VTT: "
        f"{vtt_path.name}"
    )

    # ========================================================
    # 保存 State
    # ========================================================

    processed[guid] = {

        "title": title,

        "vtt_filename":
            vtt_filename,

        "processed_at":
            datetime.now(
                timezone.utc
            ).isoformat(),

        "enclosure_url":
            enclosure_url,

        "audio_url":
            audio_url,

        "audio_source":
            audio_source,
    }

    pc_state[
        "total_processed"
    ] = (
        pc_state.get(
            "total_processed",
            0
        ) + 1
    )

    pc_state[
        "updated_at"
    ] = (
        datetime.now(
            timezone.utc
        ).isoformat()
    )

    save_state(
        state
    )

    print(
        "💾 state.json 已更新"
    )

    # ========================================================
    # 重新生成 Feed
    # ========================================================

    generate_podcast_feed(
        pc_state
    )

    generate_master_index(
        state
    )

    # ========================================================
    # 完成
    # ========================================================

    print()

    print(
        f"✅ 完成！"
        f"该播客累计 "
        f"{pc_state['total_processed']} 集"
    )

    print(
        f"🎧 Feed: "
        f"{BASE_URL}/"
        f"{PODCAST_SLUG}/feed.xml"
    )


# ============================================================
# Entry
# ============================================================

if __name__ == "__main__":

    main()