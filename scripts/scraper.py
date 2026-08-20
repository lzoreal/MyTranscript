#!/usr/bin/env python3
"""
多播客字幕爬取器
RSS-first + PodScripts 搜索
+ 通用增强 RSS Feed 生成

主要功能：

1. 从原始 RSS 获取 episode
2. 从 PodScripts 搜索 transcript
3. 转换成 VTT
5. 构造新的 RSS Feed
6. 新 Feed 只保留已经成功生成字幕的 episode
7. 保留原始 enclosure / metadata
8. 自动加入 Podcasting 2.0 transcript 标签
9. 通用支持不同播客托管平台
"""

import os
import sys
import re
import json
import time
import urllib.parse
import requests
import html as html_module

from datetime import datetime, timezone
from pathlib import Path
from copy import deepcopy
from lxml import etree




# ============================================================
# 文件配置
# ============================================================

PROGRESS_FILE = Path("progress.json")
PODCASTS_FILE = Path("podcasts.json")
SITE_DIR = Path("site")


# ============================================================
# 网络配置
# ============================================================

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 "
        "(KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;"
        "q=0.9,*/*;q=0.8"
    ),
    "Accept-Language": "en-US,en;q=0.5",
}


RSS_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 "
        "(KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": (
        "application/rss+xml, application/xml, text/xml, */*;q=0.8"
    ),
}


# ============================================================
# 运行配置
# ============================================================

BATCH_SIZE = 10


# 是否解析真实音频地址
#
# True：
#   对 enclosure URL 发 HEAD/GET，跟随重定向，
#   把最终 URL 写入新 Feed。
#
# False：
#   直接使用原 RSS 的 enclosure URL。
#



# ============================================================
# Podcasting 2.0
# ============================================================

PODCAST_NS = "https://podcastindex.org/namespace/1.0"

ATOM_NS = "http://www.w3.org/2005/Atom"

ITUNES_NS = "http://www.itunes.com/dtds/podcast-1.0.dtd"


# ============================================================
# 基础工具
# ============================================================

def now_iso():
    return datetime.now(timezone.utc).isoformat()


def display_name(podcast):
    base = podcast.get(
        "name",
        podcast.get("slug", "Podcast"),
    )
    return f"{base} (Unofficial)"


def safe_filename(title):
    keep = (
        "abcdefghijklmnopqrstuvwxyz"
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        "0123456789"
        "-_."
    )

    filename = "".join(
        c if c in keep else "_"
        for c in title
    )

    filename = filename.strip("._")

    if not filename:
        filename = "episode"

    return filename[:80]


# ============================================================
# podcasts.json
# ============================================================

def load_podcasts():
    with open(
        PODCASTS_FILE,
        "r",
        encoding="utf-8",
    ) as f:
        return json.load(f)


# ============================================================
# progress.json
# ============================================================

def load_progress():
    if PROGRESS_FILE.exists():
        with open(
            PROGRESS_FILE,
            "r",
            encoding="utf-8",
        ) as f:
            return json.load(f)

    return {
        "podcasts": {}
    }


def save_progress(progress):
    with open(
        PROGRESS_FILE,
        "w",
        encoding="utf-8",
    ) as f:
        json.dump(
            progress,
            f,
            ensure_ascii=False,
            indent=2,
        )


def get_podcast_progress(progress, slug):
    podcasts = progress.setdefault(
        "podcasts",
        {},
    )

    if slug not in podcasts:
        podcasts[slug] = {
            "processed": {},
            "total_processed": 0,
            "updated_at": None,
        }

    return podcasts[slug]


# ============================================================
# HTTP
# ============================================================

def fetch_html(url, retries=3):
    for attempt in range(retries):
        try:
            response = requests.get(
                url,
                headers=HEADERS,
                timeout=30,
            )

            response.raise_for_status()

            return response.text

        except requests.exceptions.HTTPError as e:

            status = (
                e.response.status_code
                if e.response is not None
                else None
            )

            if status == 429:
                sleep_time = 10 + 5 * attempt

                print(
                    f"      429 限流，"
                    f"等待 {sleep_time}s..."
                )

                time.sleep(sleep_time)

            else:
                print(
                    f"      HTTP {status} 错误 "
                    f"(重试 {attempt + 1}/{retries})"
                )

                time.sleep(3 ** attempt)

        except Exception as e:

            print(
                f"      请求失败: {e} "
                f"(重试 {attempt + 1}/{retries})"
            )

            time.sleep(3 ** attempt)

    return None


# ============================================================
# RSS
# ============================================================

def fetch_rss(feed_url):
    try:
        response = requests.get(
            feed_url,
            headers=RSS_HEADERS,
            timeout=60,
        )

        response.raise_for_status()

        root = etree.fromstring(
            response.content
        )

        return root

    except Exception as e:

        print(
            f"   获取 RSS 失败: {e}"
        )

        return None


def fetch_rss_entries(feed_url):
    root = fetch_rss(feed_url)

    if root is None:
        return []

    entries = []

    for item in root.xpath(
        "//*[local-name()='item']"
    ):

        guid_elem = item.find("guid")

        title_elem = item.find("title")

        pub_elem = item.find("pubDate")

        enclosure = item.find("enclosure")

        audio_url = ""

        if enclosure is not None:
            audio_url = (
                enclosure.get("url", "")
                or ""
            )

        if (
            guid_elem is not None
            and guid_elem.text
        ):

            entries.append(
                {
                    "guid": guid_elem.text.strip(),

                    "title": (
                        title_elem.text.strip()
                        if (
                            title_elem is not None
                            and title_elem.text
                        )
                        else ""
                    ),

                    "pub_date": (
                        pub_elem.text.strip()
                        if (
                            pub_elem is not None
                            and pub_elem.text
                        )
                        else ""
                    ),

                    "audio_url": audio_url,
                }
            )

    return entries


# ============================================================
# 通用音频地址
# ============================================================

def get_enclosure(item):
    """
    查找标准 RSS enclosure。

    不依赖具体平台。
    """

    enclosure = item.find("enclosure")

    if enclosure is not None:
        return enclosure

    # 某些 XML namespace 情况下再次兜底
    result = item.xpath(
        "./*[local-name()='enclosure']"
    )

    if result:
        return result[0]

    return None


def get_episode_audio_url_from_item(item):
    enclosure = get_enclosure(item)

    if enclosure is None:
        return None

    url = enclosure.get("url")

    if not url:
        return None

    return url.strip()



def get_episode_audio_url(item):
    """
    通用获取 episode 音频地址。

    当前只依赖标准 RSS enclosure。
    """
    return get_episode_audio_url_from_item(item)


# ============================================================
# PodScripts
# ============================================================

def search_podscripts(
    title,
    podscripts_id,
):

    if not podscripts_id:
        return None

    encoded = urllib.parse.quote_plus(
        title
    )

    url = (
        "https://podscripts.co/"
        "podkeywordsearch/"
        f"?search_type=episode"
        f"&keywordsToSearch={encoded}"
        f"&exact_match=true"
        f"&slv=single"
        f"&podSelectedId={podscripts_id}"
    )

    print(
        f"      搜索: {title[:60]}..."
    )

    html_text = fetch_html(url)

    if not html_text:
        return None

    pattern = re.compile(
        r'<h[23][^>]*>'
        r'.*?'
        r'<a[^>]*href="'
        r'(/podcasts/[^/]+/[^"]+)'
        r'"[^>]*>'
        r'(.*?)'
        r'</a>'
        r'.*?'
        r'</h[23]>',
        re.DOTALL | re.IGNORECASE,
    )

    matches = pattern.findall(
        html_text
    )

    for href, title_html in matches:

        result_title = re.sub(
            r"<[^>]+>",
            "",
            title_html,
        ).strip()

        result_title = (
            html_module.unescape(
                result_title
            )
        )

        if titles_match(
            title,
            result_title,
        ):
            return clean_podscripts_url(
                href
            )

    if matches:

        return clean_podscripts_url(
            matches[0][0]
        )

    return None


def clean_podscripts_url(href):

    href = href.replace(
        "&amp;",
        "&",
    )

    parsed = urllib.parse.urlparse(
        urllib.parse.urljoin(
            "https://podscripts.co",
            href,
        )
    )

    return urllib.parse.urlunparse(
        (
            "https",
            "podscripts.co",
            parsed.path,
            "",
            "",
            "",
        )
    )


def titles_match(
    rss_title,
    result_title,
):

    def norm(text):

        return re.sub(
            r"[^\w]",
            "",
            text.lower(),
        )

    n1 = norm(rss_title)
    n2 = norm(result_title)

    return (
        n1 == n2
        or n1 in n2
        or n2 in n1
    )


# ============================================================
# Transcript
# ============================================================

def parse_transcript(html_text):

    body_match = re.search(
        r"<body[^>]*>(.*?)</body>",
        html_text,
        re.DOTALL | re.IGNORECASE,
    )

    if body_match:
        body = body_match.group(1)
    else:
        body = html_text

    body = re.sub(
        r"<script[^>]*>.*?</script>",
        "",
        body,
        flags=re.DOTALL | re.IGNORECASE,
    )

    body = re.sub(
        r"<style[^>]*>.*?</style>",
        "",
        body,
        flags=re.DOTALL | re.IGNORECASE,
    )

    text = html_module.unescape(
        body
    )

    # 关键修复：标签替换为空格而非换行，
    # 避免 "Starting point is" 被拆分到不同行
    text = re.sub(
        r"<[^>]+>",
        " ",
        text,
    )

    # 合并多余空白
    text = re.sub(
        r"\s+",
        " ",
        text,
    )

    lines = [
        line.strip()
        for line in text.split("\n")
        if line.strip()
    ]

    cues = []

    current_time = None
    current_texts = []

    for line in lines:

        if (
            "© PodScripts.co" in line
            or "Privacy Policy" in line
        ):
            break

        match = re.match(
            r"Starting\s+point\s+is\s+"
            r"(\d{1,2}):(\d{2}):(\d{2})",
            line,
            re.IGNORECASE,
        )

        if match:

            if (
                current_time is not None
                and current_texts
            ):

                cues.append(
                    {
                        "start": current_time,
                        "text": "\n".join(
                            current_texts
                        ),
                    }
                )

            h, mi, s = match.groups()

            current_time = (
                f"{int(h):02d}:"
                f"{mi}:"
                f"{s}"
            )

            current_texts = []

        elif current_time is not None:

            if (
                line.startswith(
                    "Click on any sentence"
                )
                or line.startswith(
                    "There aren't comments"
                )
            ):
                continue

            current_texts.append(
                line
            )

    if (
        current_time is not None
        and current_texts
    ):

        cues.append(
            {
                "start": current_time,
                "text": "\n".join(
                    current_texts
                ),
            }
        )

    # 调试日志
    has_sp = "Starting point is" in html_text
    print(f"         [调试] HTML含'Starting point is': {has_sp}")
    print(f"         [调试] 解析到 cues: {len(cues)}")
    if not cues and has_sp:
        # 打印去标签后的前 800 字符，帮助定位问题
        debug_text = text[:800].replace("\n", " ")
        print(f"         [调试] 去标签后文本片段: {debug_text}...")

    return cues

# ============================================================
# 时间
# ============================================================

def time_to_seconds(ts):

    h, m, s = ts.split(":")

    return (
        int(h) * 3600
        + int(m) * 60
        + int(s)
    )


def seconds_to_vtt(sec):

    sec = max(
        0,
        float(sec),
    )

    h = int(sec // 3600)

    m = int(
        (sec % 3600) // 60
    )

    s = int(
        sec % 60
    )

    ms = int(
        round((sec % 1) * 1000)
    )

    if ms >= 1000:

        sec += 1

        ms = 0

        h = int(sec // 3600)

        m = int(
            (sec % 3600) // 60
        )

        s = int(sec % 60)

    return (
        f"{h:02d}:"
        f"{m:02d}:"
        f"{s:02d}."
        f"{ms:03d}"
    )


def cues_to_vtt(
    cues,
    offset_seconds=0,
):

    lines = [
        "WEBVTT",
        "",
    ]

    for i, cue in enumerate(cues):

        start_sec = (
            time_to_seconds(
                cue["start"]
            )
            + offset_seconds
        )

        if i + 1 < len(cues):

            end_sec = (
                time_to_seconds(
                    cues[i + 1]["start"]
                )
                + offset_seconds
            )

        else:

            end_sec = (
                start_sec + 5
            )

        # 防止异常 offset 导致 end < start
        end_sec = max(
            end_sec,
            start_sec + 0.1,
        )

        lines.append(
            str(i + 1)
        )

        lines.append(
            f"{seconds_to_vtt(start_sec)}"
            f" --> "
            f"{seconds_to_vtt(end_sec)}"
        )

        for line in cue["text"].split(
            "\n"
        ):
            lines.append(line)

        lines.append("")

    return "\n".join(lines)


# ============================================================
# 音频采样
# ============================================================

# ============================================================
# Whisper 广告偏移
# ============================================================

# ============================================================
# Whisper 批量对齐
# ============================================================

# ============================================================
# 核心处理
# ============================================================

def process_podcast(
    podcast,
    progress,
):

    slug = podcast["slug"]

    pc_prog = get_podcast_progress(
        progress,
        slug,
    )

    processed = pc_prog.get(
        "processed",
        {},
    )

    name = display_name(
        podcast
    )

    print(
        f"\n{'=' * 60}"
    )

    print(
        f"播客: {name} ({slug})"
    )

    feed_url = podcast.get(
        "feed_url"
    )

    if not feed_url:

        print(
            "   未配置 feed_url，跳过"
        )

        return False

    podscripts_id = podcast.get(
        "podscripts_id"
    )

    if not podscripts_id:

        print(
            "   未配置 podscripts_id，跳过"
        )

        return False

    rss_root = fetch_rss(
        feed_url
    )

    if rss_root is None:

        return False

    rss_items = []

    for item in rss_root.xpath(
        "//*[local-name()='item']"
    ):

        guid_elem = item.find(
            "guid"
        )

        title_elem = item.find(
            "title"
        )

        if (
            guid_elem is None
            or not guid_elem.text
        ):
            continue

        guid = guid_elem.text.strip()

        title = (
            title_elem.text.strip()
            if (
                title_elem is not None
                and title_elem.text
            )
            else ""
        )

        audio_url = get_episode_audio_url_from_item(item)

        rss_items.append(
            {
                "guid": guid,
                "title": title,
                "item": item,
                "audio_url": audio_url,
            }
        )

    if not rss_items:

        print(
            "   RSS 无内容"
        )

        return False

    print(
        f"   RSS 共 "
        f"{len(rss_items)} 集"
    )

    # --------------------------------------------------------
    # 只有没有成功处理过的集才进入 pending
    #
    # skipped 不算成功，因此下一轮仍然可以重新尝试。
    # --------------------------------------------------------

    pending = []

    for entry in rss_items:

        guid = entry["guid"]

        info = processed.get(
            guid
        )

        if (
            info
            and not info.get(
                "skipped",
                False,
            )
            and info.get(
                "vtt_filename"
            )
        ):

            continue

        pending.append(
            entry
        )

    if not pending:

        print(
            "   全部剧集已处理"
        )

        return False

    batch = pending[
        :BATCH_SIZE
    ]

    print(
        f"   本次处理 "
        f"{len(batch)} 集"
        f"（待处理 {len(pending)} 集）"
    )

    changed = False


    for idx, entry in enumerate(
        batch,
        1,
    ):

        guid = entry["guid"]

        title = entry["title"]

        print(
            f"\n   [{idx}/{len(batch)}] "
            f"{title[:70]}"
        )

        ep_url = search_podscripts(
            title,
            podscripts_id,
        )

        time.sleep(2)

        if not ep_url:

            print(
                "      搜索无结果"
            )

            # 注意：
            #
            # 仍然记录 skipped，
            # 但下一次运行仍然会重试。
            #
            processed[guid] = {
                "title": title,
                "vtt_filename": None,
                "processed_at": now_iso(),
                "skipped": True,
                "reason": "search_no_result",
            }

            changed = True

            continue

        print(
            f"      页面: {ep_url}"
        )

        html_text = fetch_html(
            ep_url
        )

        if not html_text:

            print(
                "      无法获取字幕页面"
            )

            continue

        print(f"      HTML 长度: {len(html_text)}")

        cues = parse_transcript(
            html_text
        )

        print(f"      解析 cues: {len(cues)}")

        if not cues:

            print(
                "      页面无字幕"
            )

            processed[guid] = {
                "title": title,
                "vtt_filename": None,
                "processed_at": now_iso(),
                "skipped": True,
                "reason": "no_transcript",
            }

            changed = True

            continue

        vtt_filename = (
            f"{safe_filename(title)}.vtt"
        )

        vtt_path = (
            SITE_DIR
            / slug
            / "transcripts"
            / vtt_filename
        )

        vtt_path.parent.mkdir(
            parents=True,
            exist_ok=True,
        )

        vtt_path.write_text(
            cues_to_vtt(
                cues,
                offset_seconds=0,
            ),
            encoding="utf-8",
        )

        processed[guid] = {
            "title": title,
            "vtt_filename": vtt_filename,
            "processed_at": now_iso(),
            "guid": guid,
            "source_url": ep_url,
        }

        pc_prog[
            "total_processed"
        ] = sum(
            1
            for value in processed.values()
            if (
                not value.get(
                    "skipped",
                    False,
                )
                and value.get(
                    "vtt_filename"
                )
            )
        )


        changed = True

        print(
            f"      VTT: "
            f"{vtt_filename} "
            f"({len(cues)} cues)"
        )

        if idx < len(batch):

            time.sleep(5)

    pc_prog[
        "total_processed"
    ] = sum(
        1
        for value in processed.values()
        if (
            not value.get(
                "skipped",
                False,
            )
            and value.get(
                "vtt_filename"
            )
        )
    )

    pc_prog[
        "updated_at"
    ] = now_iso()

    return changed


# ============================================================
# XML Namespace
# ============================================================

def ensure_namespace(
    root,
    prefix,
    uri,
):
    """
    确保 root 上存在 namespace。

    如果已经存在，则直接使用。
    """

    nsmap = dict(
        root.nsmap
    )

    if nsmap.get(prefix) == uri:
        return root

    nsmap[prefix] = uri

    new_root = etree.Element(
        root.tag,
        attrib=root.attrib,
        nsmap=nsmap,
    )

    new_root[:] = root[:]

    new_root.text = root.text

    new_root.tail = root.tail

    return new_root


# ============================================================
# Feed item 判断
# ============================================================

def is_episode_processed(
    info,
    slug,
):

    if not info:
        return False

    if info.get(
        "skipped",
        False,
    ):
        return False

    filename = info.get(
        "vtt_filename"
    )

    if not filename:
        return False

    vtt_path = (
        SITE_DIR
        / slug
        / "transcripts"
        / filename
    )

    return vtt_path.exists()


# ============================================================
# 新 Feed
# ============================================================

def generate_podcast_feed(
    pc_prog,
    podcast,
    base_url,
):

    slug = podcast["slug"]

    source_feed_url = podcast[
        "feed_url"
    ]

    print(
        f"   生成 Feed: {slug}"
    )

    root = fetch_rss(
        source_feed_url
    )

    if root is None:

        print(
            "      下载 RSS 失败"
        )

        return

    # --------------------------------------------------------
    # Namespace
    # --------------------------------------------------------

    root = ensure_namespace(
        root,
        "podcast",
        PODCAST_NS,
    )

    root = ensure_namespace(
        root,
        "atom",
        ATOM_NS,
    )

    # --------------------------------------------------------
    # channel
    # --------------------------------------------------------

    channel = root.find(
        "channel"
    )

    if channel is None:

        print(
            "      RSS 没有 channel"
        )

        return

    # --------------------------------------------------------
    # Feed 标题
    # --------------------------------------------------------

    title_elem = channel.find(
        "title"
    )

    if (
        title_elem is not None
        and title_elem.text
    ):

        title_elem.text = (
            f"{display_name(podcast)} "
            f"- Transcripts"
        )

    # --------------------------------------------------------
    # description
    # --------------------------------------------------------

    description_elem = channel.find(
        "description"
    )

    if (
        description_elem is not None
    ):

        original = (
            description_elem.text
            or ""
        )

        extra = (
            "\n\n"
            "This is an unofficial "
            "transcript-enhanced feed."
        )

        if (
            "unofficial transcript-enhanced"
            not in original.lower()
        ):

            description_elem.text = (
                original + extra
            )

    # --------------------------------------------------------
    # Feed self URL
    # --------------------------------------------------------

    new_feed_url = (
        f"{base_url}/{slug}/feed.xml"
    )

    atom_self = channel.find(
        f"{{{ATOM_NS}}}link"
    )

    if atom_self is not None:

        atom_self.set(
            "href",
            new_feed_url,
        )

        atom_self.set(
            "rel",
            "self",
        )

    # --------------------------------------------------------
    # 获取 processed
    # --------------------------------------------------------

    processed = pc_prog.get(
        "processed",
        {},
    )

    # --------------------------------------------------------
    # 原始 item
    # --------------------------------------------------------

    original_items = root.xpath(
        "./channel/item"
    )

    kept_items = []

    removed = 0

    added_transcripts = 0


    for item in original_items:

        guid_elem = item.find(
            "guid"
        )

        if (
            guid_elem is None
            or not guid_elem.text
        ):

            # 没有 GUID 的 item 无法可靠
            # 与 progress 对应。
            #
            # 直接删除。
            channel.remove(
                item
            )

            removed += 1

            continue

        guid = guid_elem.text.strip()

        info = processed.get(
            guid
        )

        # ----------------------------------------------------
        # 只保留成功处理的 episode
        # ----------------------------------------------------

        if not is_episode_processed(
            info,
            slug,
        ):

            channel.remove(
                item
            )

            removed += 1

            continue

        # ----------------------------------------------------
        # transcript URL
        # ----------------------------------------------------

        vtt_url = (
            f"{base_url}/"
            f"{slug}/transcripts/"
            f"{info['vtt_filename']}"
        )

        # 删除旧的、指向同一个 VTT 的 transcript
        existing_transcripts = item.xpath(
            "./*[local-name()='transcript'"
            f" and namespace-uri()='{PODCAST_NS}']"
        )

        transcript_exists = False

        for transcript in existing_transcripts:

            if (
                transcript.get("url")
                == vtt_url
            ):

                transcript_exists = True

                transcript.set(
                    "type",
                    "text/vtt",
                )

                transcript.set(
                    "rel",
                    "captions",
                )

                transcript.set(
                    "language",
                    podcast.get(
                        "language",
                        "en",
                    ),
                )

        if not transcript_exists:

            transcript = etree.SubElement(
                item,
                f"{{{PODCAST_NS}}}"
                "transcript",
            )

            transcript.set(
                "url",
                vtt_url,
            )

            transcript.set(
                "type",
                "text/vtt",
            )

            transcript.set(
                "rel",
                "captions",
            )

            transcript.set(
                "language",
                podcast.get(
                    "language",
                    "en",
                ),
            )

            added_transcripts += 1

        kept_items.append(
            item
        )

    # --------------------------------------------------------
    # Feed 文件
    # --------------------------------------------------------

    feed_path = (
        SITE_DIR
        / slug
        / "feed.xml"
    )

    feed_path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    tree = etree.ElementTree(
        root
    )

    tree.write(
        feed_path,
        pretty_print=True,
        xml_declaration=True,
        encoding="utf-8",
    )

    print(
        f"      保留 {len(kept_items)} 集"
    )

    print(
        f"      删除 {removed} 集"
    )

    print(
        f"      新增 "
        f"{added_transcripts} 个 transcript"
    )



# ============================================================
# Podcast Index
# ============================================================

def generate_podcast_index(
    pc_prog,
    podcast,
    base_url,
):

    slug = podcast["slug"]

    name = display_name(
        podcast
    )

    processed = pc_prog.get(
        "processed",
        {},
    )

    total = sum(
        1
        for info in processed.values()
        if (
            not info.get(
                "skipped",
                False,
            )
            and info.get(
                "vtt_filename"
            )
        )
    )

    missing = sum(
        1
        for info in processed.values()
        if info.get(
            "skipped"
        )
    )

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport"
      content="width=device-width, initial-scale=1">
<title>{name} - Transcripts</title>
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
code {{
    background: #f4f4f4;
    padding: 2px 6px;
    border-radius: 4px;
    word-break: break-all;
}}
.stat {{
    color: #666;
    font-size: 0.9rem;
}}
</style>
</head>

<body>

<h1>🎙️ {name}</h1>

<p>
<strong>官方 Feed:</strong>
<a href="{podcast["feed_url"]}"
   target="_blank">
{podcast["feed_url"]}
</a>
</p>

<p>
<strong>增强 Feed (含字幕):</strong>
<br>
<code>
<a href="{base_url}/{slug}/feed.xml">
{base_url}/{slug}/feed.xml
</a>
</code>
</p>

<p>
已处理 <strong>{total}</strong> 集字幕
<span class="stat">
（{missing} 集本次未找到字幕）
</span>
</p>

<p>
<a href="{base_url}/podcasts.html">
← 返回播客列表
</a>
</p>

</body>
</html>
"""

    (
        SITE_DIR
        / slug
        / "index.html"
    ).write_text(
        html,
        encoding="utf-8",
    )


# ============================================================
# Master Index
# ============================================================

def generate_master_index(
    progress,
    podcasts,
    base_url,
):

    items = ""

    for podcast in podcasts:

        slug = podcast[
            "slug"
        ]

        name = display_name(
            podcast
        )

        pc_prog = (
            progress
            .get("podcasts", {})
            .get(slug, {})
        )

        processed = pc_prog.get(
            "processed",
            {},
        )

        total = sum(
            1
            for info in processed.values()
            if (
                not info.get(
                    "skipped",
                    False,
                )
                and info.get(
                    "vtt_filename"
                )
            )
        )

        items += (
            "<li>"
            f'<a href="{base_url}/{slug}/">'
            f"{name}"
            "</a> — "
            f"已处理 {total} 集 "
            f'(<a href="{base_url}/{slug}/feed.xml">'
            "Feed"
            "</a>)"
            "</li>\n"
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

<h1>🎙️ Podcast Transcripts Hub</h1>

<p>
以下播客均已自动生成 VTT 字幕（非官方）：
</p>

<ul>
{items}
</ul>

</body>
</html>
"""

    (
        SITE_DIR
        / "podcasts.html"
    ).write_text(
        html,
        encoding="utf-8",
    )


# ============================================================
# 主程序
# ============================================================

def main():

    base_url = os.environ.get(
        "BASE_URL",
        "",
    ).rstrip("/")

    if not base_url:

        gh_repo = os.environ.get(
            "GITHUB_REPOSITORY",
            "",
        )

        if (
            gh_repo
            and "/" in gh_repo
        ):

            owner, repo = (
                gh_repo.split(
                    "/",
                    1,
                )
            )

            base_url = (
                f"https://{owner}.github.io/"
                f"{repo}"
            )

    if not base_url:

        print(
            "无法推导 BASE_URL，"
            "请设置环境变量"
        )

        sys.exit(1)

    print(
        f"BASE_URL: {base_url}"
    )


    podcasts = load_podcasts()

    progress = load_progress()

    changed = False

    # ========================================================
    # 第一阶段：处理字幕
    # ========================================================

    for podcast in podcasts:

        if process_podcast(
            podcast,
            progress,
        ):

            changed = True

    # ========================================================
    # 第二阶段：生成增强 RSS
    # ========================================================

    print(
        f"\n{'=' * 60}"
    )

    print(
        "开始生成增强 RSS"
    )

    for podcast in podcasts:

        slug = podcast[
            "slug"
        ]

        pc_prog = (
            get_podcast_progress(
                progress,
                slug,
            )
        )

        generate_podcast_feed(
            pc_prog,
            podcast,
            base_url,
        )

        generate_podcast_index(
            pc_prog,
            podcast,
            base_url,
        )

    # ========================================================
    # 第三阶段：首页
    # ========================================================

    generate_master_index(
        progress,
        podcasts,
        base_url,
    )

    # ========================================================
    # 保存进度
    # ========================================================

    save_progress(
        progress
    )

    # ========================================================
    # 输出统计
    # ========================================================

    print(
        f"\n{'=' * 60}"
    )

    print(
        f"站点: {base_url}"
    )

    for podcast in podcasts:

        slug = podcast[
            "slug"
        ]

        pc_prog = (
            progress
            .get("podcasts", {})
            .get(slug, {})
        )

        processed = pc_prog.get(
            "processed",
            {},
        )

        total = sum(
            1
            for info in processed.values()
            if (
                not info.get(
                    "skipped",
                    False,
                )
                and info.get(
                    "vtt_filename"
                )
            )
        )

        print(
            f"   • "
            f"{display_name(podcast)}: "
            f"{total} 集"
        )


if __name__ == "__main__":
    main()