#!/usr/bin/env python3
"""
多播客字幕爬取器

功能：
1. 从原始 RSS 获取 episode
2. 从 PodScripts 搜索对应 episode
3. 使用 DOM + 多级容错方式解析 PodScripts transcript
4. 转换为 VTT
5. 构造新的 RSS Feed
6. 新 Feed 只保留已经成功生成字幕的 episode
7. 保留原始 enclosure / metadata
8. 自动加入 Podcasting 2.0 transcript 标签
9. 通用支持不同播客
10. 使用 progress.json 避免重复处理
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

from lxml import etree
from copy import deepcopy

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
    "Accept": ("text/html,application/xhtml+xml,application/xml;" "q=0.9,*/*;q=0.8"),
    "Accept-Language": "en-US,en;q=0.5",
}


RSS_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 "
        "(KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": ("application/rss+xml, application/xml, text/xml, " "*/*;q=0.8"),
}


# ============================================================
# 运行配置
# ============================================================

BATCH_SIZE = 10

# PodScripts 请求之间的间隔
SEARCH_DELAY = 2

# Episode 之间的间隔
EPISODE_DELAY = 5

# HTTP 超时
HTTP_TIMEOUT = 60


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
    keep = "abcdefghijklmnopqrstuvwxyz" "ABCDEFGHIJKLMNOPQRSTUVWXYZ" "0123456789" "-_."

    filename = "".join(c if c in keep else "_" for c in title)

    filename = filename.strip("._")

    if not filename:
        filename = "episode"

    return filename[:80]


def normalize_whitespace(text):
    """
    统一网页文本中的各种空白。
    """

    if text is None:
        return ""

    text = text.replace("\xa0", " ").replace("\u200b", "").replace("\ufeff", "")

    text = re.sub(
        r"[ \t\r\f\v]+",
        " ",
        text,
    )

    text = re.sub(
        r"\n\s*\n+",
        "\n",
        text,
    )

    return text.strip()


# ============================================================
# podcasts.json
# ============================================================


def load_podcasts():

    if not PODCASTS_FILE.exists():

        print(f"错误：找不到 {PODCASTS_FILE}")

        sys.exit(1)

    with open(
        PODCASTS_FILE,
        "r",
        encoding="utf-8",
    ) as f:

        data = json.load(f)

    if not isinstance(data, list):

        print("错误：podcasts.json 必须是数组")

        sys.exit(1)

    return data


# ============================================================
# progress.json
# ============================================================


def load_progress():

    if PROGRESS_FILE.exists():

        try:

            with open(
                PROGRESS_FILE,
                "r",
                encoding="utf-8",
            ) as f:

                data = json.load(f)

            if isinstance(data, dict):

                data.setdefault(
                    "podcasts",
                    {},
                )

                return data

        except Exception as e:

            print(f"读取 progress.json 失败: {e}")

    return {"podcasts": {}}


def save_progress(progress):

    temp_file = Path(str(PROGRESS_FILE) + ".tmp")

    with open(
        temp_file,
        "w",
        encoding="utf-8",
    ) as f:

        json.dump(
            progress,
            f,
            ensure_ascii=False,
            indent=2,
        )

    temp_file.replace(PROGRESS_FILE)


def get_podcast_progress(
    progress,
    slug,
):

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

    podcasts[slug].setdefault(
        "processed",
        {},
    )

    return podcasts[slug]


def count_successful(processed):

    return sum(
        1
        for value in processed.values()
        if (
            not value.get(
                "skipped",
                False,
            )
            and value.get("vtt_filename")
        )
    )


# ============================================================
# HTTP
# ============================================================


def fetch_html(
    url,
    retries=3,
):

    for attempt in range(retries):

        try:

            response = requests.get(
                url,
                headers=HEADERS,
                timeout=HTTP_TIMEOUT,
            )

            response.raise_for_status()

            # requests 根据 header 推断编码，
            # 但网页偶尔会声明错误编码。
            if not response.encoding:

                response.encoding = response.apparent_encoding

            return response.text

        except requests.exceptions.HTTPError as e:

            status = e.response.status_code if e.response is not None else None

            if status == 429:

                sleep_time = 10 + 5 * attempt

                print(f"      HTTP 429，" f"等待 {sleep_time}s...")

                time.sleep(sleep_time)

            elif status in {
                403,
                404,
            }:

                print(f"      HTTP {status}，" f"停止重试")

                return None

            else:

                print(f"      HTTP {status} " f"(重试 " f"{attempt + 1}/{retries})")

                time.sleep(3**attempt)

        except Exception as e:

            print(f"      请求失败: {e} " f"(重试 " f"{attempt + 1}/{retries})")

            time.sleep(3**attempt)

    return None


def fetch_rss(feed_url):

    try:

        response = requests.get(
            feed_url,
            headers=RSS_HEADERS,
            timeout=HTTP_TIMEOUT,
        )

        response.raise_for_status()

        root = etree.fromstring(response.content)

        return root

    except Exception as e:

        print(f"   获取 RSS 失败: {e}")

        return None


# ============================================================
# RSS
# ============================================================


def get_enclosure(item):

    enclosure = item.find("enclosure")

    if enclosure is not None:

        return enclosure

    result = item.xpath("./*[local-name()='enclosure']")

    if result:

        return result[0]

    return None


def get_episode_audio_url_from_item(
    item,
):

    enclosure = get_enclosure(item)

    if enclosure is None:

        return None

    url = enclosure.get("url")

    if not url:

        return None

    return url.strip()


def get_episode_audio_url(item):

    return get_episode_audio_url_from_item(item)


# ============================================================
# RSS episode
# ============================================================


def extract_rss_items(
    rss_root,
):

    result = []

    items = rss_root.xpath("//*[local-name()='item']")

    for item in items:

        guid_elem = item.xpath("./*[local-name()='guid'][1]")

        title_elem = item.xpath("./*[local-name()='title'][1]")

        pub_elem = item.xpath("./*[local-name()='pubDate'][1]")

        if not guid_elem:

            continue

        guid_text = "".join(guid_elem[0].itertext()).strip()

        if not guid_text:

            continue

        title = ""

        if title_elem:

            title = normalize_whitespace("".join(title_elem[0].itertext()))

        pub_date = ""

        if pub_elem:

            pub_date = normalize_whitespace("".join(pub_elem[0].itertext()))

        audio_url = get_episode_audio_url_from_item(item)

        result.append(
            {
                "guid": guid_text,
                "title": title,
                "pub_date": pub_date,
                "audio_url": audio_url,
                "item": item,
            }
        )

    return result


# ============================================================
# PodScripts URL
# ============================================================


def clean_podscripts_url(
    href,
):

    if not href:

        return None

    href = href.replace(
        "&amp;",
        "&",
    )

    url = urllib.parse.urljoin(
        "https://podscripts.co",
        href,
    )

    parsed = urllib.parse.urlparse(url)

    if parsed.netloc.lower() != ("podscripts.co"):

        return None

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


# ============================================================
# 标题匹配
# ============================================================


def normalize_title(text):

    if not text:

        return ""

    text = html_module.unescape(text)

    text = text.lower()

    # 常见引号统一
    text = (
        text.replace("’", "'")
        .replace("‘", "'")
        .replace("“", '"')
        .replace("”", '"')
        .replace("–", "-")
        .replace("—", "-")
    )

    # 去掉括号中的一些纯 UI 信息
    text = re.sub(
        r"\s+",
        " ",
        text,
    )

    text = re.sub(
        r"[^\w\s]",
        " ",
        text,
    )

    text = re.sub(
        r"\s+",
        " ",
        text,
    )

    return text.strip()


def title_tokens(text):

    normalized = normalize_title(text)

    if not normalized:

        return set()

    return set(normalized.split())


def title_similarity(
    rss_title,
    result_title,
):

    a = normalize_title(rss_title)

    b = normalize_title(result_title)

    if not a or not b:

        return 0.0

    if a == b:

        return 1.0

    if a in b or b in a:

        return 0.95

    tokens_a = title_tokens(rss_title)

    tokens_b = title_tokens(result_title)

    if not tokens_a or not tokens_b:

        return 0.0

    intersection = tokens_a & tokens_b

    union = tokens_a | tokens_b

    jaccard = len(intersection) / len(union)

    containment = len(intersection) / min(
        len(tokens_a),
        len(tokens_b),
    )

    return max(
        jaccard,
        containment * 0.9,
    )


def titles_match(
    rss_title,
    result_title,
):

    score = title_similarity(
        rss_title,
        result_title,
    )

    return score >= 0.65


# ============================================================
# PodScripts 搜索
# ============================================================


def extract_podscripts_search_results(
    html_text,
):
    """
    使用 DOM 提取 PodScripts 搜索结果。

    不依赖 h2/h3 的固定结构。
    """

    try:

        document = etree.HTML(html_text)

    except Exception as e:

        print(f"      搜索页 HTML 解析失败: {e}")

        return []

    if document is None:

        return []

    results = []

    # 找所有 PodScripts episode URL
    links = document.xpath("//a[@href]")

    seen = set()

    for link in links:

        href = link.get(
            "href",
            "",
        )

        if not href:

            continue

        href = html_module.unescape(href)

        # 只接受 episode 页面
        if not re.match(
            r"^/podcasts/[^/]+/[^/?#]+/?$",
            urllib.parse.urlparse(href).path,
            re.IGNORECASE,
        ):

            continue

        url = clean_podscripts_url(href)

        if not url:

            continue

        if url in seen:

            continue

        seen.add(url)

        title = normalize_whitespace("".join(link.itertext()))

        # 如果 a 本身没有文字，
        # 尝试附近元素
        if not title:

            parent = link.getparent()

            if parent is not None:

                title = normalize_whitespace("".join(parent.itertext()))

        results.append(
            {
                "url": url,
                "title": title,
            }
        )

    return results


def search_podscripts(
    title,
    podscripts_id,
):

    if not podscripts_id:

        return None

    encoded = urllib.parse.quote_plus(title)

    url = (
        "https://podscripts.co/"
        "podkeywordsearch/"
        "?search_type=episode"
        f"&keywordsToSearch={encoded}"
        "&exact_match=true"
        "&slv=single"
        f"&podSelectedId={podscripts_id}"
    )

    print(f"      搜索: {title[:80]}...")

    html_text = fetch_html(url)

    if not html_text:

        return None

    results = extract_podscripts_search_results(html_text)

    print(f"      搜索结果: " f"{len(results)}")

    if not results:

        return None

    # --------------------------------------------------------
    # 按标题相似度排序
    # --------------------------------------------------------

    scored = []

    for result in results:

        score = title_similarity(
            title,
            result["title"],
        )

        scored.append(
            (
                score,
                result,
            )
        )

    scored.sort(
        key=lambda x: x[0],
        reverse=True,
    )

    # 调试
    for score, result in scored[:5]:

        print(f"         候选 " f"{score:.3f}: " f"{result['title'][:100]}")

    # --------------------------------------------------------
    # 取最佳匹配
    # --------------------------------------------------------

    best_score, best_result = scored[0]

    # 高度匹配
    if best_score >= 0.65:

        print(f"      匹配成功 " f"({best_score:.3f})")

        return best_result["url"]

    # PodScripts 搜索页有时标题可能被截断，
    # 仍然允许一个较合理的结果。
    if best_score >= 0.45:

        print(f"      使用较宽松匹配 " f"({best_score:.3f})")

        return best_result["url"]

    print(f"      没有可靠匹配 " f"(最高 {best_score:.3f})")

    return None


# ============================================================
# Transcript 时间戳
# ============================================================

TIMESTAMP_PATTERN = re.compile(
    r"""
    Starting
    \s*
    point
    \s*
    is
    \s*
    (
        (?:
            \d{1,3}:
        )?
        \d{1,2}:
        \d{2}
    )
    """,
    re.IGNORECASE | re.VERBOSE,
)


def normalize_timestamp(
    value,
):

    value = value.strip()

    parts = value.split(":")

    try:

        if len(parts) == 3:

            h = int(parts[0])
            m = int(parts[1])
            s = int(parts[2])

        elif len(parts) == 2:

            h = 0
            m = int(parts[0])
            s = int(parts[1])

        else:

            return None

        if m >= 60:

            return None

        if s >= 60:

            return None

        return f"{h:02d}:" f"{m:02d}:" f"{s:02d}"

    except Exception:

        return None


# ============================================================
# Transcript DOM 提取
# ============================================================


def extract_visible_text(
    element,
):

    parts = []

    for text in element.itertext():

        if text is None:

            continue

        text = text.replace("\xa0", " ").replace("\u200b", "").replace("\ufeff", "")

        text = text.strip()

        if text:

            parts.append(text)

    return "\n".join(parts)


def clean_transcript_text(
    text,
):

    text = html_module.unescape(text)

    text = text.replace("\xa0", " ").replace("\u200b", "").replace("\ufeff", "")

    # PodScripts 常见 UI 内容
    stop_patterns = [
        "Click on any sentence",
        "There aren't comments",
        "There are no comments",
        "Privacy Policy",
        "© PodScripts.co",
    ]

    for pattern in stop_patterns:

        pos = text.lower().find(pattern.lower())

        if pos >= 0:

            text = text[:pos]

    # HTML 元素之间产生的换行，
    # 对字幕而言全部变成普通空格。
    text = re.sub(
        r"\s+",
        " ",
        text,
    )

    return text.strip()


def find_transcript_text(
    document,
):
    """
    多策略寻找 transcript。

    第一层：
        直接找包含 Starting point is 的节点。

    第二层：
        找包含大量时间戳的祖先节点。

    第三层：
        整个 body。
    """

    # --------------------------------------------------------
    # 第一层：
    # 找包含 Starting point is 的元素
    # --------------------------------------------------------

    candidates = []

    elements = document.xpath(
        "//*[not(self::script)" " and not(self::style)" " and not(self::noscript)]"
    )

    for element in elements:

        text = extract_visible_text(element)

        if "Starting point is" not in text:

            continue

        count = len(TIMESTAMP_PATTERN.findall(text))

        if count:

            candidates.append(
                (
                    count,
                    len(text),
                    element,
                )
            )

    if candidates:

        # 优先选择：
        # 时间戳多，同时文本不要巨大
        candidates.sort(
            key=lambda x: (
                x[0],
                -x[1],
            ),
            reverse=True,
        )

        best = candidates[0]

        print(
            f"         [调试] "
            f"候选 transcript 节点："
            f"{best[0]} 个时间戳，"
            f"文本 {best[1]} 字符"
        )

        return extract_visible_text(best[2])

    # --------------------------------------------------------
    # 第二层：
    # body
    # --------------------------------------------------------

    bodies = document.xpath("//body")

    if bodies:

        body_text = extract_visible_text(bodies[0])

        count = len(TIMESTAMP_PATTERN.findall(body_text))

        if count:

            print(f"         [调试] " f"使用 body，" f"发现 {count} 个时间戳")

            return body_text

    return ""


# ============================================================
# Transcript 解析
# ============================================================


def parse_transcript(
    html_text,
):

    if not html_text:

        return []

    # --------------------------------------------------------
    # DOM
    # --------------------------------------------------------

    try:

        document = etree.HTML(html_text)

    except Exception as e:

        print(f"         [错误] " f"HTML 解析失败: {e}")

        return []

    if document is None:

        return []

    # --------------------------------------------------------
    # 删除不会产生 transcript 的节点
    # --------------------------------------------------------

    for node in document.xpath(
        "//script | //style | " "//noscript | //svg | //template"
    ):

        parent = node.getparent()

        if parent is not None:

            parent.remove(node)

    # --------------------------------------------------------
    # 获取 transcript 候选文本
    # --------------------------------------------------------

    text = find_transcript_text(document)

    if not text:

        print("         [调试] " "没有找到 transcript 文本")

        return []

    print(f"         [调试] " f"Transcript 文本长度: " f"{len(text)}")

    # --------------------------------------------------------
    # 统一文本
    #
    # 非常重要：
    # 不能只依赖换行。
    # --------------------------------------------------------

    text = html_module.unescape(text)

    text = text.replace("\xa0", " ").replace("\u200b", "").replace("\ufeff", "")

    # --------------------------------------------------------
    # 查找时间戳
    # --------------------------------------------------------

    matches = list(TIMESTAMP_PATTERN.finditer(text))

    print(f"         [调试] " f"发现时间戳: {len(matches)}")

    # --------------------------------------------------------
    # 如果没有找到，
    # 尝试更加宽松的模式
    # --------------------------------------------------------

    if not matches:

        loose_pattern = re.compile(
            r"Starting\s*point\s*is"
            r"[\s:：-]*"
            r"("
            r"(?:\d{1,3}:)?"
            r"\d{1,2}:"
            r"\d{2}"
            r")",
            re.IGNORECASE,
        )

        matches = list(loose_pattern.finditer(text))

        print(f"         [调试] " f"宽松模式时间戳: " f"{len(matches)}")

    # --------------------------------------------------------
    # 仍然没有：
    # 打印几个 Starting 附近片段
    # --------------------------------------------------------

    if not matches:

        starts = list(
            re.finditer(
                r"Starting",
                text,
                re.IGNORECASE,
            )
        )

        for m in starts[:5]:

            pos = m.start()

            preview = text[max(0, pos - 100) : pos + 300]

            print("         [调试] " f"Starting 附近: " f"{repr(preview)}")

        return []

    # --------------------------------------------------------
    # 构造 cues
    # --------------------------------------------------------

    cues = []

    for index, match in enumerate(matches):

        timestamp = normalize_timestamp(match.group(1))

        if timestamp is None:

            continue

        content_start = match.end()

        if index + 1 < len(matches):

            content_end = matches[index + 1].start()

        else:

            content_end = len(text)

        content = text[content_start:content_end]

        content = clean_transcript_text(content)

        if not content:

            continue

        # ----------------------------------------------------
        # 防止最后把网页 UI 当成字幕
        # ----------------------------------------------------

        if content.lower() in {
            "transcript",
            "comments",
            "discussion",
        }:

            continue

        cues.append(
            {
                "start": timestamp,
                "text": content,
            }
        )

    # --------------------------------------------------------
    # 去掉明显重复 / 时间倒退
    # --------------------------------------------------------

    cleaned = []

    last_seconds = -1

    for cue in cues:

        try:

            seconds = time_to_seconds(cue["start"])

        except Exception:

            continue

        if seconds < last_seconds:

            print(f"         [调试] " f"忽略时间倒退: " f"{cue['start']}")

            continue

        if cleaned and seconds == last_seconds:

            cleaned[-1]["text"] += " " + cue["text"]

        else:

            cleaned.append(cue)

        last_seconds = seconds

    cues = cleaned

    # --------------------------------------------------------
    # 调试
    # --------------------------------------------------------

    print(f"         [调试] " f"最终解析 cues: {len(cues)}")

    if cues:

        print(
            f"         [调试] "
            f"第一条: "
            f"{cues[0]['start']} "
            f"{cues[0]['text'][:200]}"
        )

        if len(cues) > 1:

            print(
                f"         [调试] "
                f"第二条: "
                f"{cues[1]['start']} "
                f"{cues[1]['text'][:200]}"
            )

    return cues


# ============================================================
# 时间
# ============================================================


def time_to_seconds(ts):

    parts = ts.strip().split(":")

    if len(parts) == 3:

        h, m, s = parts

        return int(h) * 3600 + int(m) * 60 + int(s)

    if len(parts) == 2:

        m, s = parts

        return int(m) * 60 + int(s)

    raise ValueError(f"无法解析时间: {ts}")


def seconds_to_vtt(sec):

    sec = max(
        0,
        float(sec),
    )

    h = int(sec // 3600)

    m = int((sec % 3600) // 60)

    s = int(sec % 60)

    ms = int(round((sec % 1) * 1000))

    if ms >= 1000:

        sec += 1
        ms = 0

        h = int(sec // 3600)

        m = int((sec % 3600) // 60)

        s = int(sec % 60)

    return f"{h:02d}:" f"{m:02d}:" f"{s:02d}." f"{ms:03d}"


# ============================================================
# VTT
# ============================================================


def cues_to_vtt(
    cues,
    offset_seconds=0,
):

    lines = [
        "WEBVTT",
        "",
    ]

    for i, cue in enumerate(cues):

        start_sec = time_to_seconds(cue["start"]) + offset_seconds

        if i + 1 < len(cues):

            end_sec = time_to_seconds(cues[i + 1]["start"]) + offset_seconds

        else:

            end_sec = start_sec + 5

        end_sec = max(
            end_sec,
            start_sec + 0.1,
        )

        lines.append(str(i + 1))

        lines.append(
            f"{seconds_to_vtt(start_sec)}" f" --> " f"{seconds_to_vtt(end_sec)}"
        )

        lines.append(cue["text"])

        lines.append("")

    return "\n".join(lines)


# ============================================================
# Episode 处理
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

    processed = pc_prog["processed"]

    name = display_name(podcast)

    print(f"\n{'=' * 60}")

    print(f"播客: {name} ({slug})")

    feed_url = podcast.get("feed_url")

    if not feed_url:

        print("   未配置 feed_url，跳过")

        return False

    podscripts_id = podcast.get("podscripts_id")

    if not podscripts_id:

        print("   未配置 podscripts_id，跳过")

        return False

    rss_root = fetch_rss(feed_url)

    if rss_root is None:

        return False

    rss_items = extract_rss_items(rss_root)

    if not rss_items:

        print("   RSS 无内容")

        return False

    print(f"   RSS 共 " f"{len(rss_items)} 集")

    # --------------------------------------------------------
    # 找待处理
    # --------------------------------------------------------

    pending = []

    for entry in rss_items:

        guid = entry["guid"]

        info = processed.get(guid)

        if (
            info
            and not info.get(
                "skipped",
                False,
            )
            and info.get("vtt_filename")
        ):

            vtt_path = SITE_DIR / slug / "transcripts" / info["vtt_filename"]

            if vtt_path.exists():

                continue

        pending.append(entry)

    if not pending:

        print("   全部剧集已处理")

        return False

    batch = pending[:BATCH_SIZE]

    print(f"   本次处理 " f"{len(batch)} 集" f"（待处理 {len(pending)} 集）")

    changed = False

    # --------------------------------------------------------
    # Episode
    # --------------------------------------------------------

    for idx, entry in enumerate(
        batch,
        1,
    ):

        guid = entry["guid"]

        title = entry["title"]

        print(f"\n   [{idx}/{len(batch)}] " f"{title[:100]}")

        # ----------------------------------------------------
        # 搜索
        # ----------------------------------------------------

        ep_url = search_podscripts(
            title,
            podscripts_id,
        )

        time.sleep(SEARCH_DELAY)

        if not ep_url:

            print("      搜索无结果")

            processed[guid] = {
                "title": title,
                "vtt_filename": None,
                "processed_at": now_iso(),
                "skipped": True,
                "reason": "search_no_result",
            }

            changed = True

            # 及时保存
            pc_prog["total_processed"] = count_successful(processed)

            save_progress(progress)

            continue

        print(f"      页面: {ep_url}")

        # ----------------------------------------------------
        # 获取页面
        # ----------------------------------------------------

        html_text = fetch_html(ep_url)

        if not html_text:

            print("      无法获取字幕页面")

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

            continue

        print(f"      HTML 长度: " f"{len(html_text)}")

        # ----------------------------------------------------
        # Transcript
        # ----------------------------------------------------

        cues = parse_transcript(html_text)

        if not cues:

            print("      页面无可解析字幕")

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

            continue

        # ----------------------------------------------------
        # VTT
        # ----------------------------------------------------

        vtt_filename = f"{safe_filename(title)}.vtt"

        vtt_path = SITE_DIR / slug / "transcripts" / vtt_filename

        vtt_path.parent.mkdir(
            parents=True,
            exist_ok=True,
        )

        vtt_content = cues_to_vtt(
            cues,
            offset_seconds=0,
        )

        vtt_path.write_text(
            vtt_content,
            encoding="utf-8",
        )

        # ----------------------------------------------------
        # progress
        # ----------------------------------------------------

        processed[guid] = {
            "title": title,
            "vtt_filename": vtt_filename,
            "processed_at": now_iso(),
            "guid": guid,
            "source_url": ep_url,
            "skipped": False,
        }

        pc_prog["total_processed"] = count_successful(processed)

        pc_prog["updated_at"] = now_iso()

        changed = True

        # 立即保存，防止 Actions 中途失败
        save_progress(progress)

        print(f"      VTT: " f"{vtt_filename} " f"({len(cues)} cues)")

        print(f"      已成功处理: " f"{pc_prog['total_processed']} 集")

        if idx < len(batch):

            time.sleep(EPISODE_DELAY)

    # --------------------------------------------------------
    # 最终统计
    # --------------------------------------------------------

    pc_prog["total_processed"] = count_successful(processed)

    pc_prog["updated_at"] = now_iso()

    return changed


# ============================================================
# XML Namespace
# ============================================================


def ensure_namespace(
    root,
    prefix,
    uri,
):

    nsmap = dict(root.nsmap)

    if nsmap.get(prefix) == uri:

        return root

    nsmap[prefix] = uri

    new_root = etree.Element(
        root.tag,
        attrib=dict(root.attrib),
        nsmap=nsmap,
    )

    new_root.text = root.text
    new_root.tail = root.tail

    for child in root:

        new_root.append(child)

    return new_root


# ============================================================
# 判断是否成功处理
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

    filename = info.get("vtt_filename")

    if not filename:

        return False

    vtt_path = SITE_DIR / slug / "transcripts" / filename

    return vtt_path.exists()


# ============================================================
# Feed
# ============================================================


def generate_podcast_feed(
    pc_prog,
    podcast,
    base_url,
):

    slug = podcast["slug"]

    source_feed_url = podcast["feed_url"]

    print(f"   生成 Feed: {slug}")

    root = fetch_rss(source_feed_url)

    if root is None:

        print("      下载 RSS 失败")

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

    channel_nodes = root.xpath("./*[local-name()='channel']")

    if not channel_nodes:

        print("      RSS 没有 channel")

        return

    channel = channel_nodes[0]

    # --------------------------------------------------------
    # Feed 标题
    # --------------------------------------------------------

    title_nodes = channel.xpath("./*[local-name()='title']")

    if title_nodes:

        title_elem = title_nodes[0]

        original_title = "".join(title_elem.itertext()).strip()

        title_elem.text = f"{display_name(podcast)} " "- Transcripts"

    # --------------------------------------------------------
    # Description
    # --------------------------------------------------------

    description_nodes = channel.xpath("./*[local-name()='description']")

    if description_nodes:

        description_elem = description_nodes[0]

        original = "".join(description_elem.itertext())

        extra = "\n\n" "This is an unofficial " "transcript-enhanced feed."

        if "unofficial transcript-enhanced" not in original.lower():

            description_elem.text = original + extra

    # --------------------------------------------------------
    # Atom self
    # --------------------------------------------------------

    new_feed_url = f"{base_url}/{slug}/feed.xml"

    atom_links = channel.xpath(f"./{{{ATOM_NS}}}link")

    atom_self = None

    for link in atom_links:

        if link.get("rel") == "self":

            atom_self = link
            break

    if atom_self is None:

        atom_self = etree.Element(f"{{{ATOM_NS}}}link")

        atom_self.set(
            "rel",
            "self",
        )

        # 插入 channel 前面
        channel.insert(
            0,
            atom_self,
        )

    atom_self.set(
        "href",
        new_feed_url,
    )

    # --------------------------------------------------------
    # Processed
    # --------------------------------------------------------

    processed = pc_prog.get(
        "processed",
        {},
    )

    # --------------------------------------------------------
    # Items
    # --------------------------------------------------------

    original_items = root.xpath("./*[local-name()='channel']" "/*[local-name()='item']")

    kept = 0
    removed = 0
    added = 0

    for item in original_items:

        guid_nodes = item.xpath("./*[local-name()='guid'][1]")

        if not guid_nodes:

            channel.remove(item)

            removed += 1

            continue

        guid = "".join(guid_nodes[0].itertext()).strip()

        info = processed.get(guid)

        if not is_episode_processed(
            info,
            slug,
        ):

            channel.remove(item)

            removed += 1

            continue

        # ----------------------------------------------------
        # transcript
        # ----------------------------------------------------

        vtt_url = (
            f"{base_url}/"
            f"{slug}/transcripts/"
            f"{urllib.parse.quote(info['vtt_filename'])}"
        )

        existing = item.xpath(
            f"./*[local-name()='transcript' " f"and namespace-uri()='{PODCAST_NS}']"
        )

        transcript_exists = False

        for transcript in existing:

            if transcript.get("url") == vtt_url:

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
                f"{{{PODCAST_NS}}}" "transcript",
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

            added += 1

        kept += 1

    # --------------------------------------------------------
    # 写入
    # --------------------------------------------------------

    feed_path = SITE_DIR / slug / "feed.xml"

    feed_path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    tree = etree.ElementTree(root)

    tree.write(
        feed_path,
        pretty_print=True,
        xml_declaration=True,
        encoding="utf-8",
    )

    print(f"      保留 {kept} 集")

    print(f"      删除 {removed} 集")

    print(f"      新增 " f"{added} 个 transcript")


# ============================================================
# Podcast Index
# ============================================================


def generate_podcast_index(
    pc_prog,
    podcast,
    base_url,
):

    slug = podcast["slug"]

    name = display_name(podcast)

    processed = pc_prog.get(
        "processed",
        {},
    )

    total = count_successful(processed)

    missing = sum(
        1
        for info in processed.values()
        if info.get(
            "skipped",
            False,
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

    (SITE_DIR / slug / "index.html").write_text(
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

        slug = podcast["slug"]

        name = display_name(podcast)

        pc_prog = progress.get("podcasts", {}).get(slug, {})

        processed = pc_prog.get(
            "processed",
            {},
        )

        total = count_successful(processed)

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

    (SITE_DIR / "podcasts.html").write_text(
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

        if gh_repo and "/" in gh_repo:

            owner, repo = gh_repo.split(
                "/",
                1,
            )

            base_url = f"https://{owner}.github.io/" f"{repo}"

    if not base_url:

        print("无法推导 BASE_URL，" "请设置环境变量")

        sys.exit(1)

    print(f"BASE_URL: {base_url}")

    podcasts = load_podcasts()

    progress = load_progress()

    changed = False

    # ========================================================
    # 第一阶段：处理字幕
    # ========================================================

    for podcast in podcasts:

        try:

            result = process_podcast(
                podcast,
                progress,
            )

            if result:

                changed = True

        except KeyboardInterrupt:

            print("\n用户中断")

            save_progress(progress)

            raise

        except Exception as e:

            print(f"\n处理播客 " f"{podcast.get('slug')} " f"时发生异常: {e}")

            import traceback

            traceback.print_exc()

            # 一个播客失败不能影响其他播客
            continue

    # ========================================================
    # 第二阶段：生成增强 RSS
    # ========================================================

    print(f"\n{'=' * 60}")

    print("开始生成增强 RSS")

    for podcast in podcasts:

        slug = podcast["slug"]

        pc_prog = get_podcast_progress(
            progress,
            slug,
        )

        try:

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

        except Exception as e:

            print(f"   生成 {slug} Feed " f"失败: {e}")

            import traceback

            traceback.print_exc()

    # ========================================================
    # 第三阶段：首页
    # ========================================================

    try:

        generate_master_index(
            progress,
            podcasts,
            base_url,
        )

    except Exception as e:

        print(f"生成首页失败: {e}")

    # ========================================================
    # 保存进度
    # ========================================================

    save_progress(progress)

    # ========================================================
    # 输出统计
    # ========================================================

    print(f"\n{'=' * 60}")

    print(f"站点: {base_url}")

    for podcast in podcasts:

        slug = podcast["slug"]

        pc_prog = progress.get("podcasts", {}).get(slug, {})

        processed = pc_prog.get(
            "processed",
            {},
        )

        total = count_successful(processed)

        skipped = sum(
            1
            for info in processed.values()
            if info.get(
                "skipped",
                False,
            )
        )

        print(
            f"   • "
            f"{display_name(podcast)}: "
            f"{total} 集成功，"
            f"{skipped} 集跳过"
        )

    print("\n完成。")


# ============================================================
# Entry
# ============================================================

if __name__ == "__main__":

    main()
