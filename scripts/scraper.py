#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
多播客字幕爬取器

RSS-first + PodScripts 搜索
+ 通用增强 RSS Feed 生成

主要功能：

1. 从原始 RSS 获取 episode
2. 从 PodScripts 搜索 transcript
3. 自动解析 PodScripts transcript
4. 转换成 VTT
5. 构造新的 RSS Feed
6. 新 Feed 只保留已经成功生成字幕的 episode
7. 保留原始 enclosure / metadata
8. 自动加入 Podcasting 2.0 transcript 标签
9. 通用支持不同播客托管平台
10. progress.json 记录处理状态

标题匹配增强：

- exact_match=false
- RSS 搜索标题会先进行 episode 标题规范化
- 支持 Episode / Ep / Bonus 前缀
- 支持 episode number，例如：
    409. Title
    #409 Title
    Episode 409: Title
    Ep 409 - Title
- 支持 Part N，例如：
    Title (Part 6)
    Title [Part 6]
    Title - Part 6
    Title: Part 6
    Title Part 6
- 支持 curly apostrophe
- 支持 & / and
- 支持大小写差异
- 支持标点差异

本版本重点修复：

- PodScripts 搜索页面：
  不再使用正则解析 HTML
  避免把 "0 comments" 当成 episode 标题

- PodScripts transcript：
  使用 lxml DOM + 文本节点解析
  不依赖固定 HTML 标签结构

- 标题匹配：
  RSS 标题和 PodScripts 标题都会进行核心标题规范化

- VTT 文件名：
  使用 safe_filename()
  不需要 urllib.parse.quote()
"""

import os
import sys
import re
import json
import time
import urllib.parse
import html as html_module
import requests

from datetime import datetime, timezone
from pathlib import Path

from lxml import etree
from lxml import html as lxml_html

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
    "Accept": ("application/rss+xml, application/xml, " "text/xml, */*;q=0.8"),
}


# ============================================================
# 运行配置
# ============================================================

BATCH_SIZE = 400

# PodScripts 请求间隔
PODSEARCH_DELAY = 2

# 每个 episode 之间的间隔
EPISODE_DELAY = 5


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
        podcast.get(
            "slug",
            "Podcast",
        ),
    )

    return f"{base} (Unofficial)"


def safe_filename(title):
    """
    将标题转换成安全文件名。

    不保留空格、冒号、括号、问号等特殊字符。

    因此生成 VTT URL 时不需要再次 quote。
    """

    keep = "abcdefghijklmnopqrstuvwxyz" "ABCDEFGHIJKLMNOPQRSTUVWXYZ" "0123456789" "-_."

    filename = "".join(c if c in keep else "_" for c in title)

    filename = re.sub(
        r"_+",
        "_",
        filename,
    )

    filename = filename.strip("._")

    if not filename:
        filename = "episode"

    return filename[:120]


# ============================================================
# podcasts.json
# ============================================================


def load_podcasts():

    if not PODCASTS_FILE.exists():
        print(f"找不到 {PODCASTS_FILE}")
        sys.exit(1)

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

        try:

            with open(
                PROGRESS_FILE,
                "r",
                encoding="utf-8",
            ) as f:
                data = json.load(f)

            if not isinstance(
                data,
                dict,
            ):
                raise ValueError("progress.json 不是对象")

            data.setdefault(
                "podcasts",
                {},
            )

            return data

        except Exception as e:

            print(f"   读取 progress.json 失败: {e}")

    return {"podcasts": {}}


def save_progress(progress):

    tmp_file = Path(str(PROGRESS_FILE) + ".tmp")

    with open(
        tmp_file,
        "w",
        encoding="utf-8",
    ) as f:

        json.dump(
            progress,
            f,
            ensure_ascii=False,
            indent=2,
        )

    tmp_file.replace(PROGRESS_FILE)


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
                timeout=60,
            )

            response.raise_for_status()

            return response.text

        except requests.exceptions.HTTPError as e:

            status = e.response.status_code if e.response is not None else None

            if status == 429:

                sleep_time = 10 + 5 * attempt

                print(f"      429 限流，" f"等待 {sleep_time}s...")

                time.sleep(sleep_time)

            else:

                print(f"      HTTP {status} 错误 " f"(重试 {attempt + 1}/{retries})")

                time.sleep(3**attempt)

        except Exception as e:

            print(f"      请求失败: {e} " f"(重试 {attempt + 1}/{retries})")

            time.sleep(3**attempt)

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

        root = etree.fromstring(response.content)

        return root

    except Exception as e:

        print(f"   获取 RSS 失败: {e}")

        return None


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


def get_episode_audio_url(
    item,
):

    return get_episode_audio_url_from_item(item)


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

    absolute = urllib.parse.urljoin(
        "https://podscripts.co",
        href,
    )

    parsed = urllib.parse.urlparse(absolute)

    if parsed.netloc.lower() not in (
        "podscripts.co",
        "www.podscripts.co",
    ):
        return None

    return urllib.parse.urlunparse(
        (
            "https",
            "podscripts.co",
            parsed.path.rstrip("/"),
            "",
            "",
            "",
        )
    )


# ============================================================
# 标题规范化
# ============================================================


def normalize_episode_title(text):
    """
    用于 episode 匹配的核心标题规范化。

    例如：

    RSS:
        The Nazis in Power: Hitler's War on the Jews (Part 6)

    PodScripts:
        409. The Nazis in Power: Hitler's War on the Jews

    最终都会变成：

        the nazis in power hitlers war on the jews
    """

    if not text:
        return ""

    # HTML entity
    text = html_module.unescape(text)

    # --------------------------------------------------------
    # Unicode apostrophe / quotation
    # --------------------------------------------------------

    text = text.replace(
        "\u2018",
        "'",
    )

    text = text.replace(
        "\u2019",
        "'",
    )

    text = text.replace(
        "\u201c",
        '"',
    )

    text = text.replace(
        "\u201d",
        '"',
    )

    # --------------------------------------------------------
    # Unicode dash
    # --------------------------------------------------------

    text = text.replace(
        "\u2013",
        "-",
    )

    text = text.replace(
        "\u2014",
        "-",
    )

    # --------------------------------------------------------
    # & -> and
    # --------------------------------------------------------

    text = text.replace(
        "&",
        " and ",
    )

    # --------------------------------------------------------
    # 去掉常见前缀
    #
    # Bonus:
    # Episode:
    # Ep:
    # --------------------------------------------------------

    text = re.sub(
        r"^\s*(?:bonus|episode|ep)\s*[:.#\-]?\s*",
        "",
        text,
        flags=re.IGNORECASE,
    )

    # --------------------------------------------------------
    # 去掉 episode number
    #
    # 409. Title
    # 409 - Title
    # 409: Title
    # #409 Title
    # --------------------------------------------------------

    text = re.sub(
        r"^\s*#?\s*\d{1,5}\s*[\.\-:#]\s*",
        "",
        text,
    )

    # 某些站点可能使用：
    #
    # #409 Title
    #
    # 上面的正则可以处理 #409 + 标点。
    #
    # 这里再处理：
    #
    # #409 Title
    #
    text = re.sub(
        r"^\s*#\s*\d{1,5}\s+",
        "",
        text,
    )

    # --------------------------------------------------------
    # 去掉 Part N
    #
    # Title (Part 6)
    # Title [Part 6]
    # Title {Part 6}
    # Title - Part 6
    # Title : Part 6
    # Title Part 6
    # --------------------------------------------------------

    text = re.sub(
        r"""
        \s*
        (?:
            [\(\[\{]\s*part\s+\d+\s*[\)\]\}]
            |
            [-:]\s*part\s+\d+
            |
            \bpart\s+\d+\b
        )
        \s*$
        """,
        "",
        text,
        flags=re.IGNORECASE | re.VERBOSE,
    )

    # --------------------------------------------------------
    # 去掉常见的 Episode / Ep 前缀残留
    # --------------------------------------------------------

    text = re.sub(
        r"^\s*(?:episode|ep)\s+\d+\s*[:.#\-]?\s*",
        "",
        text,
        flags=re.IGNORECASE,
    )

    # --------------------------------------------------------
    # 只保留文字和数字
    # --------------------------------------------------------

    text = re.sub(
        r"[^\w\s]",
        " ",
        text,
        flags=re.UNICODE,
    )

    # --------------------------------------------------------
    # 合并空白
    # --------------------------------------------------------

    text = re.sub(
        r"\s+",
        " ",
        text,
    )

    return text.strip().lower()


def normalize_title(
    text,
):
    """
    保留原来的 normalize_title API。

    实际 episode 匹配统一使用
    normalize_episode_title()。
    """

    return normalize_episode_title(text)


def title_similarity(
    title1,
    title2,
):

    a = normalize_episode_title(title1)

    b = normalize_episode_title(title2)

    if not a or not b:
        return 0.0

    # --------------------------------------------------------
    # 完全相同
    # --------------------------------------------------------

    if a == b:
        return 1.0

    # --------------------------------------------------------
    # 包含关系
    # --------------------------------------------------------

    if a in b or b in a:

        shorter = min(
            len(a),
            len(b),
        )

        longer = max(
            len(a),
            len(b),
        )

        if longer == 0:
            return 0.0

        return 0.90 + 0.10 * shorter / longer

    # --------------------------------------------------------
    # Token similarity
    # --------------------------------------------------------

    tokens_a = set(a.split())

    tokens_b = set(b.split())

    if not tokens_a or not tokens_b:
        return 0.0

    intersection = tokens_a & tokens_b

    union = tokens_a | tokens_b

    if not union:
        return 0.0

    jaccard = len(intersection) / len(union)

    coverage_a = len(intersection) / len(tokens_a)

    coverage_b = len(intersection) / len(tokens_b)

    coverage = max(
        coverage_a,
        coverage_b,
    )

    return jaccard * 0.4 + coverage * 0.6


# ============================================================
# PodScripts 搜索结果判断
# ============================================================


def looks_like_bad_link_title(
    title,
):

    if not title:
        return True

    normalized = normalize_episode_title(title)

    bad_titles = {
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
    }

    if normalized in bad_titles:
        return True

    # 例如：
    #
    # 0 comments
    # 1 comment
    # 25 comments
    #

    if re.fullmatch(
        r"\d+\s+comments?",
        normalized,
        re.IGNORECASE,
    ):
        return True

    return False


# ============================================================
# PodScripts 搜索
# ============================================================


def search_podscripts(
    title,
    podscripts_id,
):

    if not podscripts_id:
        return None

    # --------------------------------------------------------
    # 重要：
    #
    # 不直接使用 RSS 原始标题搜索。
    #
    # 例如：
    #
    # The Nazis in Power: Hitler's War on the Jews (Part 6)
    #
    # 会变成：
    #
    # the nazis in power hitlers war on the jews
    #
    # 这样可以匹配：
    #
    # 409. The Nazis in Power: Hitler's War on the Jews
    # --------------------------------------------------------

    search_title = normalize_episode_title(title)

    if not search_title:
        search_title = title

    encoded = urllib.parse.quote_plus(search_title)

    # --------------------------------------------------------
    # exact_match=false
    #
    # 这是本次修改的核心之一。
    # --------------------------------------------------------

    url = (
        "https://podscripts.co/"
        "podkeywordsearch/"
        "?search_type=episode"
        f"&keywordsToSearch={encoded}"
        "&exact_match=false"
        "&slv=single"
        f"&podSelectedId={podscripts_id}"
    )

    print(f"      搜索: {search_title[:70]}...")

    if search_title != title:
        print(f"      原标题: {title[:70]}...")

    html_text = fetch_html(url)

    if not html_text:
        return None

    try:

        doc = lxml_html.fromstring(html_text)

    except Exception as e:

        print(f"      搜索页面 HTML 解析失败: {e}")

        return None

    candidates = []
    seen_urls = set()

    # --------------------------------------------------------
    # PodScripts 搜索结果解析
    #
    # 搜索结果中的 episode link:
    #
    # <a href="/podcasts/...">
    #
    # 自身文本可能只有：
    #
    # Arts
    #
    # 真正标题可能在：
    #
    # h2 / h3 / sibling node
    #
    # 所以不能直接 link.itertext()
    # --------------------------------------------------------

    links = doc.xpath("//a[@href]")

    for link in links:

        href = link.get("href")

        if not href:
            continue

        if not href.startswith("/podcasts/"):
            continue

        clean_url = clean_podscripts_url(href)

        if not clean_url:
            continue

        if clean_url in seen_urls:
            continue

        parsed = urllib.parse.urlparse(clean_url)

        parts = [p for p in parsed.path.split("/") if p]

        # 必须是：
        #
        # /podcasts/{podcast}/{episode}
        #

        if len(parts) < 3:
            continue

        # ----------------------------------------------------
        # 提取标题
        # ----------------------------------------------------

        result_title = ""

        # ----------------------------------------------------
        # 方法1：
        #
        # 当前节点内部寻找标题标签
        # ----------------------------------------------------

        for node in link.xpath(".//h1|.//h2|.//h3|.//strong"):

            text = " ".join(node.itertext()).strip()

            if text and not looks_like_bad_link_title(text):

                result_title = text
                break

        # ----------------------------------------------------
        # 方法2：
        #
        # 查找父节点附近标题
        # ----------------------------------------------------

        if not result_title:

            parent = link.getparent()

            if parent is not None:

                possible = []

                for node in parent.xpath(".//h1|.//h2|.//h3|.//a|.//div"):

                    text = " ".join(node.itertext()).strip()

                    if not text:
                        continue

                    text = html_module.unescape(text)

                    if looks_like_bad_link_title(text):
                        continue

                    possible.append(text)

                if possible:

                    # 标题通常最长
                    result_title = max(
                        possible,
                        key=len,
                    )

        # ----------------------------------------------------
        # 方法3：
        #
        # fallback
        # ----------------------------------------------------

        if not result_title:

            result_title = " ".join("".join(link.itertext()).split())

        result_title = html_module.unescape(result_title).strip()

        if looks_like_bad_link_title(result_title):
            continue

        seen_urls.add(clean_url)

        print(f"         DEBUG标题: {result_title}")

        candidates.append(
            {
                "title": result_title,
                "url": clean_url,
            }
        )

    print(f"      搜索结果: {len(candidates)}")

    if not candidates:

        print("      没有找到 episode 候选")

        return None

    # --------------------------------------------------------
    # 标题匹配
    # --------------------------------------------------------

    scored = []

    for candidate in candidates:

        score = title_similarity(
            title,
            candidate["title"],
        )

        scored.append(
            (
                score,
                candidate,
            )
        )

    scored.sort(
        key=lambda x: x[0],
        reverse=True,
    )

    # --------------------------------------------------------
    # 显示前 10 个候选
    # --------------------------------------------------------

    for score, candidate in scored[:10]:

        print(f"         候选 {score:.3f}: " f"{candidate['title']}")

    best_score, best = scored[0]

    # --------------------------------------------------------
    # 保持原来的 0.55 阈值
    #
    # 不通过简单降低阈值来解决标题差异。
    # 标题规范化之后，真正匹配的标题通常会得到
    # 1.0 或非常高的分数。
    # --------------------------------------------------------

    if best_score < 0.55:

        print(f"      没有可靠匹配 " f"(最高 {best_score:.3f})")

        return None

    print(f"      匹配成功 " f"({best_score:.3f}): " f"{best['title']}")

    return best["url"]


# ============================================================
# Transcript 页面 DOM 工具
# ============================================================

TIME_PATTERN = re.compile(
    r"Starting\s+point\s+is\s+" r"(?P<h>\d{1,2}):" r"(?P<m>\d{2}):" r"(?P<s>\d{2})",
    re.IGNORECASE,
)


def clean_transcript_text(
    text,
):

    if not text:
        return ""

    text = html_module.unescape(text)

    text = text.replace(
        "\xa0",
        " ",
    )

    text = re.sub(
        r"\s+",
        " ",
        text,
    )

    return text.strip()


def parse_timestamp(
    match,
):

    h = int(match.group("h"))

    m = int(match.group("m"))

    s = int(match.group("s"))

    return h * 3600 + m * 60 + s


# ============================================================
# Transcript 解析
# ============================================================


def parse_transcript(
    html_text,
):

    if not html_text:
        return []

    print(f"         [调试] HTML长度: " f"{len(html_text)}")

    # --------------------------------------------------------
    # 方法 1：
    #
    # DOM 文本节点解析
    #
    # 实际页面类似：
    #
    # Transcript
    #
    # Starting point is 00:00:04
    # I'm Jenna Fisher...
    #
    # Starting point is 00:00:28
    # I'm so thrilled...
    # --------------------------------------------------------

    try:

        doc = lxml_html.fromstring(html_text)

    except Exception as e:

        print(f"         [调试] HTML DOM 解析失败: {e}")

        doc = None

    cues = []

    if doc is not None:

        # ----------------------------------------------------
        # 获取所有文本节点
        # ----------------------------------------------------

        text_nodes = doc.xpath("//text()")

        # ----------------------------------------------------
        # 把 DOM 文本节点拼接成连续文本
        #
        # 这里不能简单用 ''.join，
        # 否则不同节点之间的文字可能粘在一起。
        # ----------------------------------------------------

        chunks = []

        for node in text_nodes:

            parent = node.getparent()

            if parent is None:
                continue

            tag = (
                parent.tag
                if isinstance(
                    parent.tag,
                    str,
                )
                else ""
            )

            tag_lower = tag.lower()

            # 排除脚本和 CSS
            if tag_lower in (
                "script",
                "style",
                "noscript",
                "svg",
            ):
                continue

            value = clean_transcript_text(str(node))

            if value:
                chunks.append(value)

        # ----------------------------------------------------
        # 不直接全部拼成一个字符串。
        #
        # 每个 chunk 中可能有：
        #
        # Starting point is 00:00:04 ...
        #
        # 所以分别扫描。
        # ----------------------------------------------------

        for chunk in chunks:

            matches = list(TIME_PATTERN.finditer(chunk))

            if not matches:
                continue

            for i, match in enumerate(matches):

                start = parse_timestamp(match)

                if i + 1 < len(matches):

                    end_position = matches[i + 1].start()

                else:

                    end_position = len(chunk)

                text = chunk[match.end() : end_position]

                text = clean_transcript_text(text)

                if not text:
                    continue

                cues.append(
                    {
                        "start_seconds": start,
                        "text": text,
                    }
                )

    # --------------------------------------------------------
    # 如果 DOM 方法没找到：
    #
    # 使用完整可见文本作为 fallback。
    # --------------------------------------------------------

    if not cues:

        print("         [调试] DOM 文本节点未找到 cues，" "启动 fallback...")

        try:

            doc = lxml_html.fromstring(html_text)

            # 删除脚本 / CSS
            for bad in doc.xpath("//script|//style|//noscript"):

                parent = bad.getparent()

                if parent is not None:
                    parent.remove(bad)

            visible_text = " ".join(doc.itertext())

            visible_text = html_module.unescape(visible_text)

            visible_text = visible_text.replace(
                "\xa0",
                " ",
            )

            # ------------------------------------------------
            # Starting point is 前面可能没有换行，
            # 所以直接正则寻找。
            # ------------------------------------------------

            matches = list(TIME_PATTERN.finditer(visible_text))

            for i, match in enumerate(matches):

                start = parse_timestamp(match)

                if i + 1 < len(matches):

                    end_pos = matches[i + 1].start()

                else:

                    end_pos = len(visible_text)

                text = visible_text[match.end() : end_pos]

                text = clean_transcript_text(text)

                # 清理页面尾部
                text = re.split(
                    r"(?:©\s*PodScripts|" r"Privacy Policy|" r"Terms of Service)",
                    text,
                    maxsplit=1,
                    flags=re.IGNORECASE,
                )[0]

                text = clean_transcript_text(text)

                if text:

                    cues.append(
                        {
                            "start_seconds": start,
                            "text": text,
                        }
                    )

        except Exception as e:

            print(f"         [调试] fallback 失败: {e}")

    # --------------------------------------------------------
    # 去重
    # --------------------------------------------------------

    cleaned = []

    seen = set()

    for cue in cues:

        key = (
            cue["start_seconds"],
            cue["text"],
        )

        if key in seen:
            continue

        seen.add(key)

        cleaned.append(cue)

    # --------------------------------------------------------
    # 按时间排序
    # --------------------------------------------------------

    cleaned.sort(key=lambda x: x["start_seconds"])

    # --------------------------------------------------------
    # 删除明显错误文本
    # --------------------------------------------------------

    final_cues = []

    for cue in cleaned:

        text = cue["text"].strip()

        if not text:
            continue

        if text.lower().startswith("click on any sentence"):
            continue

        if text.lower().startswith("there aren't comments"):
            continue

        final_cues.append(cue)

    print(f"         [调试] " f"解析到 cues: " f"{len(final_cues)}")

    if not final_cues:

        if "Starting point is" in html_text:

            print(
                "         [调试] HTML中存在 "
                "'Starting point is'，"
                "但没有成功提取 transcript。"
            )

        else:

            print("         [调试] HTML中没有 " "'Starting point is'")

    return final_cues


# ============================================================
# 时间
# ============================================================


def time_to_seconds(ts):

    h, m, s = ts.split(":")

    return int(h) * 3600 + int(m) * 60 + int(s)


def seconds_to_vtt(
    sec,
):

    sec = max(
        0,
        float(sec),
    )

    total_ms = int(round(sec * 1000))

    h = total_ms // (3600 * 1000)

    remainder = total_ms % (3600 * 1000)

    m = remainder // (60 * 1000)

    remainder %= 60 * 1000

    s = remainder // 1000

    ms = remainder % 1000

    return f"{h:02d}:" f"{m:02d}:" f"{s:02d}." f"{ms:03d}"


# ============================================================
# Cues -> VTT
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

        # 新格式
        if "start_seconds" in cue:

            start_sec = cue["start_seconds"] + offset_seconds

        # 兼容旧格式
        else:

            start_sec = time_to_seconds(cue["start"]) + offset_seconds

        if i + 1 < len(cues):

            next_cue = cues[i + 1]

            if "start_seconds" in next_cue:

                end_sec = next_cue["start_seconds"] + offset_seconds

            else:

                end_sec = time_to_seconds(next_cue["start"]) + offset_seconds

        else:

            end_sec = start_sec + 5

        # 防止重叠 / 反向
        end_sec = max(
            end_sec,
            start_sec + 0.1,
        )

        lines.append(str(i + 1))

        lines.append(
            f"{seconds_to_vtt(start_sec)}" f" --> " f"{seconds_to_vtt(end_sec)}"
        )

        text = cue["text"].strip()

        lines.append(text)

        lines.append("")

    return "\n".join(lines)


# ============================================================
# 处理状态
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

    # --------------------------------------------------------
    # RSS
    # --------------------------------------------------------

    rss_root = fetch_rss(feed_url)

    if rss_root is None:
        return False

    rss_items = []

    for item in rss_root.xpath("//*[local-name()='item']"):

        guid_elem = item.find("guid")

        title_elem = item.find("title")

        if guid_elem is None or not guid_elem.text:
            continue

        guid = guid_elem.text.strip()

        title = (
            title_elem.text.strip()
            if (title_elem is not None and title_elem.text)
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

        print("   RSS 无内容")

        return False

    print(f"   RSS 共 " f"{len(rss_items)} 集")

    # --------------------------------------------------------
    # Pending
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

            # 如果 VTT 实际存在，
            # 才真正跳过。
            #
            # 防止 progress 有记录，
            # 但文件后来被删除。
            #

            if is_episode_processed(
                info,
                slug,
            ):

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

        print(f"\n   [{idx}/{len(batch)}] " f"{title[:70]}")

        # ----------------------------------------------------
        # PodScripts 搜索
        # ----------------------------------------------------

        ep_url = search_podscripts(
            title,
            podscripts_id,
        )

        time.sleep(PODSEARCH_DELAY)

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

            continue

        print(f"      页面: {ep_url}")

        # ----------------------------------------------------
        # 获取 transcript 页面
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
            }

            changed = True

            continue

        print(f"      HTML 长度: " f"{len(html_text)}")

        # ----------------------------------------------------
        # Transcript
        # ----------------------------------------------------

        cues = parse_transcript(html_text)

        if not cues:

            print("      页面无字幕")

            processed[guid] = {
                "title": title,
                "vtt_filename": None,
                "processed_at": now_iso(),
                "skipped": True,
                "reason": "no_transcript",
                "source_url": ep_url,
            }

            changed = True

            continue

        # ----------------------------------------------------
        # VTT 文件
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

        pc_prog["total_processed"] = sum(
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

        pc_prog["updated_at"] = now_iso()

        changed = True

        print(f"      VTT: " f"{vtt_filename} " f"({len(cues)} cues)")

        # ----------------------------------------------------
        # 每成功一个 episode 就保存一次 progress
        #
        # GitHub Actions 被中断时，
        # 不至于丢掉整个 batch。
        # ----------------------------------------------------

        save_progress(progress)

        if idx < len(batch):

            time.sleep(EPISODE_DELAY)

    # --------------------------------------------------------
    # 最终统计
    # --------------------------------------------------------

    pc_prog["total_processed"] = sum(
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

    pc_prog["updated_at"] = now_iso()

    return changed


# ============================================================
# Namespace
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
        attrib=root.attrib,
        nsmap=nsmap,
    )

    # --------------------------------------------------------
    # 复制 children
    # --------------------------------------------------------

    for child in root:

        new_root.append(deepcopy_element(child))

    new_root.text = root.text
    new_root.tail = root.tail

    return new_root


def deepcopy_element(
    element,
):

    return etree.fromstring(etree.tostring(element))


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

    # --------------------------------------------------------
    # channel
    # --------------------------------------------------------

    channel = root.find("channel")

    if channel is None:

        print("      RSS 没有 channel")

        return

    # --------------------------------------------------------
    # Feed 标题
    # --------------------------------------------------------

    title_elem = channel.find("title")

    if title_elem is not None and title_elem.text:

        title_elem.text = f"{display_name(podcast)} " f"- Transcripts"

    # --------------------------------------------------------
    # Description
    # --------------------------------------------------------

    description_elem = channel.find("description")

    if description_elem is not None:

        original = description_elem.text or ""

        extra = "\n\n" "This is an unofficial " "transcript-enhanced feed."

        if "unofficial " "transcript-enhanced" not in original.lower():

            description_elem.text = original + extra

    # --------------------------------------------------------
    # Feed self URL
    # --------------------------------------------------------

    new_feed_url = f"{base_url}/" f"{slug}/feed.xml"

    atom_self = channel.find(f"{{{ATOM_NS}}}link")

    if atom_self is not None:

        atom_self.set(
            "href",
            new_feed_url,
        )

        atom_self.set(
            "rel",
            "self",
        )

    else:

        atom_self = etree.SubElement(
            channel,
            f"{{{ATOM_NS}}}link",
        )

        atom_self.set(
            "href",
            new_feed_url,
        )

        atom_self.set(
            "rel",
            "self",
        )

    # --------------------------------------------------------
    # processed
    # --------------------------------------------------------

    processed = pc_prog.get(
        "processed",
        {},
    )

    original_items = root.xpath("./channel/item")

    kept_items = []

    removed = 0
    added_transcripts = 0

    # --------------------------------------------------------
    # Items
    # --------------------------------------------------------

    for item in original_items:

        guid_elem = item.find("guid")

        if guid_elem is None or not guid_elem.text:

            channel.remove(item)

            removed += 1

            continue

        guid = guid_elem.text.strip()

        info = processed.get(guid)

        # ----------------------------------------------------
        # 只保留已经有 VTT 的 episode
        # ----------------------------------------------------

        if not is_episode_processed(
            info,
            slug,
        ):

            channel.remove(item)

            removed += 1

            continue

        # ----------------------------------------------------
        # VTT URL
        #
        # safe_filename() 已经保证：
        #
        # 空格 -> _
        # : -> _
        # ? -> _
        #
        # 因此这里不要再 quote。
        # ----------------------------------------------------

        vtt_url = f"{base_url}/" f"{slug}/transcripts/" f"{info['vtt_filename']}"

        # ----------------------------------------------------
        # 查找已有 transcript
        # ----------------------------------------------------

        existing_transcripts = item.xpath(
            "./*[local-name()='transcript' " f"and namespace-uri()='{PODCAST_NS}']"
        )

        transcript_exists = False

        for transcript in existing_transcripts:

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

        # ----------------------------------------------------
        # 如果没有，则添加
        # ----------------------------------------------------

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

            added_transcripts += 1

        kept_items.append(item)

    # --------------------------------------------------------
    # Feed 文件
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

    print(f"      保留 " f"{len(kept_items)} 集")

    print(f"      删除 " f"{removed} 集")

    print(f"      新增 " f"{added_transcripts} 个 transcript")


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

    total = sum(
        1
        for info in processed.values()
        if (
            not info.get(
                "skipped",
                False,
            )
            and info.get("vtt_filename")
        )
    )

    missing = sum(1 for info in processed.values() if info.get("skipped"))

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport"
      content="width=device-width, initial-scale=1">
<title>{html_module.escape(name)} - Transcripts</title>
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

<h1>🎙️ {html_module.escape(name)}</h1>

<p>
<strong>官方 Feed:</strong>
<a href="{html_module.escape(podcast["feed_url"])}"
   target="_blank">
{html_module.escape(podcast["feed_url"])}
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

        pc_prog = progress.get(
            "podcasts",
            {},
        ).get(
            slug,
            {},
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
                and info.get("vtt_filename")
            )
        )

        items += (
            "<li>"
            f'<a href="{base_url}/{slug}/">'
            f"{html_module.escape(name)}"
            "</a> — "
            f"已处理 {total} 集 "
            f'<a href="{base_url}/{slug}/feed.xml">'
            "Feed"
            "</a>"
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

    # --------------------------------------------------------
    # BASE_URL
    # --------------------------------------------------------

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

    # --------------------------------------------------------
    # 加载
    # --------------------------------------------------------

    podcasts = load_podcasts()

    progress = load_progress()

    # 确保 site
    SITE_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    changed = False

    # ========================================================
    # 第一阶段
    # ========================================================

    for podcast in podcasts:

        try:

            if process_podcast(
                podcast,
                progress,
            ):

                changed = True

        except KeyboardInterrupt:

            print("\n用户中断，保存进度...")

            save_progress(progress)

            raise

        except Exception as e:

            print(f"\n处理播客 " f"{podcast.get('slug', '?')} " f"时发生异常: {e}")

            # 一个 podcast 出错，
            # 不影响后面的 podcast。
            continue

        # 每个 podcast 完成后保存
        save_progress(progress)

    # ========================================================
    # 第二阶段：增强 RSS
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

    save_progress(progress)

    # ========================================================
    # 输出统计
    # ========================================================

    print(f"\n{'=' * 60}")

    print(f"站点: {base_url}")

    for podcast in podcasts:

        slug = podcast["slug"]

        pc_prog = progress.get(
            "podcasts",
            {},
        ).get(
            slug,
            {},
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
                and info.get("vtt_filename")
            )
        )

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
