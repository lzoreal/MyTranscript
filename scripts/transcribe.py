import os
import sys
import json
import time
import re
import random
import hashlib
import feedparser
import requests

from datetime import datetime, timezone
from faster_whisper import WhisperModel
from pathlib import Path
from lxml import etree


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


# 中国免费代理
USE_CHINA_PROXY = (
    os.environ.get(
        "USE_CHINA_PROXY",
        "true"
    ).lower()
    == "true"
)


# 最多尝试多少个中国代理
MAX_PROXY_ATTEMPTS = int(
    os.environ.get(
        "MAX_PROXY_ATTEMPTS",
        "30"
    )
)


# 代理连接测试超时
PROXY_TEST_TIMEOUT = int(
    os.environ.get(
        "PROXY_TEST_TIMEOUT",
        "8"
    )
)


# 音频下载超时
AUDIO_TIMEOUT = int(
    os.environ.get(
        "AUDIO_TIMEOUT",
        "300"
    )
)


# 代理缓存时间，单位秒
PROXY_CACHE_TTL = int(
    os.environ.get(
        "PROXY_CACHE_TTL",
        "1800"
    )
)


# ============================================================
# BASE_URL 兜底
# ============================================================

if not BASE_URL:

    gh_repo = os.environ.get(
        "GITHUB_REPOSITORY",
        ""
    )

    if gh_repo and "/" in gh_repo:

        owner, repo = (
            gh_repo.split(
                "/",
                1
            )
        )

        BASE_URL = (
            f"https://{owner}.github.io/{repo}"
        )

        print(
            f"⚠️ BASE_URL 未设置，"
            f"从 GITHUB_REPOSITORY 推断: "
            f"{BASE_URL}"
        )


# ============================================================
# 目录
# ============================================================

STATE_FILE = Path(
    "state.json"
)

SITE_DIR = Path(
    "site"
)

PODCAST_DIR = (
    SITE_DIR /
    PODCAST_SLUG
)

TRANSCRIPTS_DIR = (
    PODCAST_DIR /
    "transcripts"
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
# 代理缓存
# ============================================================

PROXY_CACHE_FILE = Path(
    ".china_proxy_cache.json"
)


# 本次运行已经确认无效的代理
BAD_PROXIES = set()


# ============================================================
# 英文缩写
# ============================================================

ABBREVIATIONS = (
    r'\b(?:'
    r'Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|vol|vols|'
    r'inc|etc|eg|ie|et al|st|ave|blvd|rd|'
    r'dept|univ|No|pp|par|Ltd|Co|Corp|Plc|'
    r'LLC|U\.S|U\.K|e\.g|i\.e'
    r')\.'
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

    filename = "".join(
        c if c in keep else "_"
        for c in title
    )

    return (
        filename
        .strip()
        .replace(" ", "_")
        [:80]
    )


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

        merged.append(
            buf
        )

    final = []

    for m in merged:

        sentences = split_sentences(
            m["text"]
        )

        if len(sentences) <= 1:

            final.append(
                m
            )

            continue

        total_chars = sum(
            len(s)
            for s in sentences
        )

        t = m["start"]

        duration = (
            m["end"]
            - m["start"]
        )

        for sent in sentences:

            ratio = (
                len(sent)
                / total_chars
                if total_chars > 0
                else
                1 / len(sentences)
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
                    **
                    min(
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
# RSS enclosure
# ============================================================

def get_audio_url(entry):

    """
    从 RSS 中寻找原始 enclosure。

    优先使用 entry.enclosures。
    """

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

        clean_url = (
            href.lower()
            .split("?")[0]
        )

        if (
            "audio" in type_
            or clean_url.endswith(
                (
                    ".mp3",
                    ".m4a",
                    ".wav",
                    ".aac",
                    ".ogg",
                    ".opus"
                )
            )
        ):

            return href

    return None


# ============================================================
# enclosure URL 解析
# ============================================================

def resolve_enclosure_url(
    enclosure_url
):

    """
    把 pdst.fm 嵌套的真实音频 URL
    提取出来。

    支持：

        serve.castfire.com
        traffic.megaphone.fm
    """

    if not enclosure_url:

        return None, "unknown"

    lower = (
        enclosure_url.lower()
    )

    # --------------------------------------------------------
    # 已经是直接地址
    # --------------------------------------------------------

    if "pdst.fm/" not in lower:

        if (
            "traffic.megaphone.fm"
            in lower
        ):

            return (
                enclosure_url,
                "megaphone"
            )

        if (
            "serve.castfire.com"
            in lower
        ):

            return (
                enclosure_url,
                "castfire"
            )

        return (
            enclosure_url,
            "direct"
        )

    # --------------------------------------------------------
    # 支持的平台
    # --------------------------------------------------------

    patterns = [

        (
            "traffic.megaphone.fm",
            "megaphone"
        ),

        (
            "serve.castfire.com",
            "castfire"
        ),

    ]

    for host, source in patterns:

        marker = (
            f"/{host}/"
        )

        pos = lower.find(
            marker
        )

        if pos != -1:

            start = pos + 1

            extracted = (
                "https://"
                +
                enclosure_url[start:]
            )

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
                source
            )

    # --------------------------------------------------------
    # 未识别
    # --------------------------------------------------------

    print(
        "   ⚠️ 未识别的嵌套音频地址，"
        "保留原 enclosure"
    )

    return (
        enclosure_url,
        "unknown"
    )


# ============================================================
# 中国免费代理
# ============================================================

PROXY_API_URLS = [

    (
        "ProxyScrape",
        "https://api.proxyscrape.com/v4/"
        "free-proxy-list/get"
        "?request=display_proxies"
        "&proxy_format=protocolipport"
        "&format=text"
        "&country=cn"
    ),

]


GEOIP_URL = (
    "https://ipwho.is/"
)


PROXY_HEADERS = {

    "User-Agent":
        "Mozilla/5.0 "
        "(Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 "
        "(KHTML, like Gecko) "
        "Chrome/138.0 Safari/537.36"

}


# ============================================================
# 代理缓存
# ============================================================

def load_proxy_cache():

    if not PROXY_CACHE_FILE.exists():

        return []

    try:

        with open(
            PROXY_CACHE_FILE,
            "r",
            encoding="utf-8"
        ) as f:

            data = json.load(
                f
            )

        created_at = data.get(
            "created_at",
            0
        )

        if (
            time.time()
            - created_at
            > PROXY_CACHE_TTL
        ):

            print(
                "   ℹ️ 中国代理缓存已过期"
            )

            return []

        proxies = data.get(
            "proxies",
            []
        )

        if not isinstance(
            proxies,
            list
        ):

            return []

        print(
            f"   ♻️ 使用代理缓存: "
            f"{len(proxies)} 个"
        )

        return proxies

    except Exception as e:

        print(
            f"   ⚠️ 读取代理缓存失败: "
            f"{e}"
        )

        return []


def save_proxy_cache(
    proxies
):

    try:

        with open(
            PROXY_CACHE_FILE,
            "w",
            encoding="utf-8"
        ) as f:

            json.dump(
                {
                    "created_at":
                        time.time(),

                    "proxies":
                        proxies
                },
                f,
                ensure_ascii=False,
                indent=2
            )

    except Exception as e:

        print(
            f"   ⚠️ 保存代理缓存失败: "
            f"{e}"
        )


# ============================================================
# 获取中国代理
# ============================================================

def get_china_proxies():

    cached = load_proxy_cache()

    if cached:

        random.shuffle(
            cached
        )

        return cached

    print(
        "🇨🇳 获取中国免费代理列表..."
    )

    all_proxies = []

    for source_name, api_url in (
        PROXY_API_URLS
    ):

        print(
            f"   📡 来源: "
            f"{source_name}"
        )

        try:

            response = requests.get(
                api_url,
                timeout=30,
                headers=PROXY_HEADERS
            )

            response.raise_for_status()

            text = response.text

        except Exception as e:

            print(
                f"   ⚠️ {source_name} "
                f"获取失败: {e}"
            )

            continue

        count = 0

        for line in text.splitlines():

            line = line.strip()

            if not line:
                continue

            line = line.replace(
                " ",
                ""
            )

            if "://" not in line:

                line = (
                    "http://"
                    + line
                )

            if not re.match(
                r"^(http|https|socks4|socks5)://"
                r"[^:]+:\d+$",
                line,
                re.I
            ):

                continue

            if line not in all_proxies:

                all_proxies.append(
                    line
                )

                count += 1

        print(
            f"      获取 {count} 个"
        )

    random.shuffle(
        all_proxies
    )

    print(
        f"   📦 合计代理: "
        f"{len(all_proxies)}"
    )

    if all_proxies:

        save_proxy_cache(
            all_proxies
        )

    return all_proxies


# ============================================================
# GeoIP
# ============================================================

def get_proxy_geoip(
    proxy
):

    request_proxies = {
        "http": proxy,
        "https": proxy
    }

    try:

        response = requests.get(
            GEOIP_URL,
            timeout=PROXY_TEST_TIMEOUT,
            proxies=request_proxies,
            headers=PROXY_HEADERS
        )

        response.raise_for_status()

        data = response.json()

        if not data.get(
            "success",
            False
        ):

            return None

        ip = data.get(
            "ip"
        )

        country_code = data.get(
            "country_code"
        )

        country = data.get(
            "country"
        )

        return {
            "ip":
                ip,

            "country_code":
                country_code,

            "country":
                country
        }

    except Exception:

        return None


# ============================================================
# 测试代理
# ============================================================

def test_proxy(
    proxy,
    target_url=None
):

    """
    测试代理：

    1. HTTPS 是否可用
    2. 是否有公网出口
    3. GeoIP 是否为 CN
    4. 目标音频服务器是否可访问
    """

    request_proxies = {
        "http": proxy,
        "https": proxy
    }

    # --------------------------------------------------------
    # 第一阶段：GeoIP
    # --------------------------------------------------------

    geo = get_proxy_geoip(
        proxy
    )

    if not geo:

        return {
            "ok":
                False,

            "reason":
                "GeoIP 请求失败"
        }

    public_ip = geo.get(
        "ip"
    )

    country_code = (
        geo.get(
            "country_code"
        )
        or ""
    ).upper()

    country = (
        geo.get(
            "country"
        )
        or ""
    )

    print(
        f"   🌍 出口 IP: "
        f"{public_ip}"
    )

    print(
        f"   🌏 地区: "
        f"{country} "
        f"({country_code})"
    )

    # --------------------------------------------------------
    # 必须是中国大陆
    # --------------------------------------------------------

    if country_code != "CN":

        return {
            "ok":
                False,

            "reason":
                f"不是中国大陆 IP: "
                f"{country_code}"
        }

    # --------------------------------------------------------
    # 第二阶段：测试目标服务器
    # --------------------------------------------------------

    if target_url:

        try:

            response = requests.head(
                target_url,
                timeout=PROXY_TEST_TIMEOUT,
                proxies=request_proxies,
                headers=PROXY_HEADERS,
                allow_redirects=True
            )

            # 某些 CDN 不支持 HEAD
            if response.status_code in (
                403,
                405,
                501
            ):

                response = requests.get(
                    target_url,
                    timeout=PROXY_TEST_TIMEOUT,
                    proxies=request_proxies,
                    headers={
                        **PROXY_HEADERS,
                        "Range":
                            "bytes=0-1023"
                    },
                    allow_redirects=True,
                    stream=True
                )

            if response.status_code >= 400:

                return {
                    "ok":
                        False,

                    "reason":
                        f"目标服务器 HTTP "
                        f"{response.status_code}"
                }

            print(
                f"   🎯 目标服务器测试: "
                f"HTTP {response.status_code}"
            )

        except Exception as e:

            return {
                "ok":
                    False,

                "reason":
                    f"目标服务器不可访问: "
                    f"{e}"
            }

    return {
        "ok":
            True,

        "public_ip":
            public_ip,

        "country_code":
            country_code,

        "country":
            country
    }


# ============================================================
# 下载音频
# ============================================================

def download_audio(
    audio_url,
    output_path
):

    headers = {

        "User-Agent":
            "Mozilla/5.0 "
            "(Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 "
            "(KHTML, like Gecko) "
            "Chrome/138.0 Safari/537.36",

        "Accept":
            "audio/mpeg,"
            "audio/*;q=0.9,"
            "*/*;q=0.8"

    }

    # ========================================================
    # 不使用代理
    # ========================================================

    if not USE_CHINA_PROXY:

        print(
            "ℹ️ USE_CHINA_PROXY=false，"
            "直接下载"
        )

        download_with_proxy(
            audio_url,
            output_path,
            headers,
            None
        )

        return {
            "proxy":
                None,

            "public_ip":
                None
        }

    # ========================================================
    # 获取代理
    # ========================================================

    proxies = get_china_proxies()

    if not proxies:

        print(
            "⚠️ 没有获取到中国代理"
        )

        print(
            "➡️ 回退到直接下载"
        )

        download_with_proxy(
            audio_url,
            output_path,
            headers,
            None
        )

        return {
            "proxy":
                None,

            "public_ip":
                None
        }

    # ========================================================
    # 限制尝试数量
    # ========================================================

    proxies = proxies[
        :MAX_PROXY_ATTEMPTS
    ]

    print(
        f"🔀 准备测试 "
        f"{len(proxies)} 个中国代理..."
    )

    # ========================================================
    # 逐个测试
    # ========================================================

    for index, proxy in enumerate(
        proxies,
        1
    ):

        if proxy in BAD_PROXIES:

            continue

        print(
            f"\n🌐 代理 "
            f"{index}/{len(proxies)}:"
        )

        print(
            f"   {proxy}"
        )

        result = test_proxy(
            proxy,
            target_url=audio_url
        )

        if not result.get(
            "ok"
        ):

            print(
                "   ❌ 代理不可用: "
                f"{result.get('reason')}"
            )

            BAD_PROXIES.add(
                proxy
            )

            continue

        public_ip = result.get(
            "public_ip"
        )

        print(
            "   ✅ 中国大陆代理可用"
        )

        # ----------------------------------------------------
        # 下载
        # ----------------------------------------------------

        try:

            download_with_proxy(
                audio_url,
                output_path,
                headers,
                proxy
            )

            return {
                "proxy":
                    proxy,

                "public_ip":
                    public_ip
            }

        except Exception as e:

            print(
                f"   ❌ 下载失败: "
                f"{e}"
            )

            BAD_PROXIES.add(
                proxy
            )

            if output_path.exists():

                try:

                    output_path.unlink()

                except Exception:
                    pass

    # ========================================================
    # 所有代理失败
    # ========================================================

    print(
        "\n⚠️ 所有中国代理均失败"
    )

    print(
        "➡️ 最后尝试直接下载..."
    )

    try:

        download_with_proxy(
            audio_url,
            output_path,
            headers,
            None
        )

        return {
            "proxy":
                None,

            "public_ip":
                None
        }

    except Exception as e:

        print(
            f"❌ 直接下载也失败: "
            f"{e}"
        )

        raise


# ============================================================
# 实际下载
# ============================================================

def download_with_proxy(
    audio_url,
    output_path,
    headers,
    proxy
):

    request_proxies = None

    if proxy:

        request_proxies = {
            "http":
                proxy,

            "https":
                proxy
        }

    print(
        "⬇️ 下载音频..."
    )

    print(
        f"   URL: "
        f"{audio_url}"
    )

    with requests.get(
        audio_url,
        timeout=AUDIO_TIMEOUT,
        headers=headers,
        proxies=request_proxies,
        allow_redirects=True,
        stream=True
    ) as response:

        response.raise_for_status()

        content_type = (
            response.headers
            .get(
                "Content-Type",
                ""
            )
            .lower()
        )

        content_length = (
            response.headers
            .get(
                "Content-Length",
                ""
            )
        )

        print(
            f"   HTTP: "
            f"{response.status_code}"
        )

        print(
            f"   Content-Type: "
            f"{content_type}"
        )

        print(
            f"   Content-Length: "
            f"{content_length}"
        )

        print(
            f"   最终 URL: "
            f"{response.url}"
        )

        # ----------------------------------------------------
        # 防止下载到 HTML
        # ----------------------------------------------------

        if (
            "text/html"
            in content_type
        ):

            raise RuntimeError(
                "服务器返回 HTML，"
                "不是音频文件"
            )

        # ----------------------------------------------------
        # 流式写入
        # ----------------------------------------------------

        total_bytes = 0

        with open(
            output_path,
            "wb"
        ) as f:

            for chunk in response.iter_content(
                chunk_size=1024 * 1024
            ):

                if not chunk:
                    continue

                f.write(
                    chunk
                )

                total_bytes += len(
                    chunk
                )

        print(
            f"   下载完成: "
            f"{total_bytes / 1024 / 1024:.1f} MB"
        )

    # --------------------------------------------------------
    # 最小文件检查
    # --------------------------------------------------------

    if total_bytes < 1024:

        raise RuntimeError(
            "下载文件异常，"
            "文件小于 1 KB"
        )

    # --------------------------------------------------------
    # 文件头检查
    # --------------------------------------------------------

    with open(
        output_path,
        "rb"
    ) as f:

        header = f.read(
            32
        )

    valid_audio = (

        # ID3 / MP3
        header.startswith(
            b"ID3"
        )

        or

        # MPEG Audio Frame
        (
            len(header) >= 2
            and
            header[0] == 0xFF
            and
            (
                header[1] & 0xE0
            ) == 0xE0
        )

        or

        # MP4 / M4A
        (
            len(header) >= 12
            and
            header[4:8] == b"ftyp"
        )

        or

        # Ogg
        header.startswith(
            b"OggS"
        )

        or

        # ADTS AAC
        (
            len(header) >= 2
            and
            header[0] == 0xFF
            and
            (
                header[1] & 0xF6
            ) == 0xF0
        )
    )

    if not valid_audio:

        raise RuntimeError(
            "下载内容不是已识别的音频格式"
        )

    # --------------------------------------------------------
    # SHA256
    # --------------------------------------------------------

    sha256 = hashlib.sha256()

    with open(
        output_path,
        "rb"
    ) as f:

        for chunk in iter(
            lambda:
                f.read(
                    1024 * 1024
                ),
            b""
        ):

            sha256.update(
                chunk
            )

    digest = (
        sha256.hexdigest()
    )

    print(
        f"   SHA256: "
        f"{digest}"
    )


# ============================================================
# 找下一集
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
            or
            e.get(
                "updated_parsed"
            )
            or
            time.gmtime(0)
        )

        return time.mktime(
            t
        )

    entries.sort(
        key=sort_key
    )

    for entry in entries:

        guid = (
            entry.get("guid")
            or entry.get("id")
            or entry.get("title")
        )

        if guid not in processed:

            return entry

    return None


# ============================================================
# 生成 Podcast Feed
# ============================================================

def generate_podcast_feed(
    pc_state
):

    print(
        "🔄 生成播客 RSS feed..."
    )

    # --------------------------------------------------------
    # 获取原始 RSS
    # --------------------------------------------------------

    resp = requests.get(
        FEED_URL,
        timeout=60,
        headers={
            "User-Agent":
                "Mozilla/5.0"
        }
    )

    resp.raise_for_status()

    root = etree.fromstring(
        resp.content
    )

    # --------------------------------------------------------
    # Namespace
    # --------------------------------------------------------

    ns_uri = (
        "https://podcastindex.org/"
        "namespace/1.0"
    )

    atom_uri = (
        "http://www.w3.org/2005/Atom"
    )

    itunes_uri = (
        "http://www.itunes.com/"
        "dtds/podcast-1.0.dtd"
    )

    # --------------------------------------------------------
    # 确保 podcast namespace
    # --------------------------------------------------------

    nsmap = dict(
        root.nsmap
    )

    if nsmap.get(
        "podcast"
    ) != ns_uri:

        nsmap["podcast"] = ns_uri

        new_root = etree.Element(
            root.tag,
            attrib=root.attrib,
            nsmap=nsmap
        )

        new_root[:] = root[:]

        new_root.text = (
            root.text
        )

        new_root.tail = (
            root.tail
        )

        root = new_root

    # --------------------------------------------------------
    # channel
    # --------------------------------------------------------

    channel = root.find(
        "channel"
    )

    if channel is None:

        print(
            "⚠️ 未找到 channel"
        )

        return

    # --------------------------------------------------------
    # Feed URL
    # --------------------------------------------------------

    feed_url = (
        f"{BASE_URL}/"
        f"{PODCAST_SLUG}/"
        f"feed.xml"
    )

    # --------------------------------------------------------
    # title
    # --------------------------------------------------------

    title_elem = channel.find(
        "title"
    )

    if (
        title_elem is not None
        and title_elem.text
    ):

        original_title = (
            title_elem.text.strip()
        )

        if (
            "[Unofficial"
            not in original_title
        ):

            title_elem.text = (
                f"{original_title} "
                f"[Unofficial Transcripts]"
            )

            print(
                f"   RSS 标题: "
                f"{title_elem.text}"
            )

    # --------------------------------------------------------
    # channel link
    # --------------------------------------------------------

    link_elem = channel.find(
        "link"
    )

    if link_elem is not None:

        link_elem.text = (
            BASE_URL
        )

    # --------------------------------------------------------
    # image
    # --------------------------------------------------------

    image = channel.find(
        "image"
    )

    if image is not None:

        img_link = image.find(
            "link"
        )

        if img_link is not None:

            img_link.text = (
                BASE_URL
            )

        img_title = image.find(
            "title"
        )

        if (
            img_title is not None
            and title_elem is not None
        ):

            img_title.text = (
                title_elem.text
            )

    # --------------------------------------------------------
    # atom:self
    # --------------------------------------------------------

    for atom_link in channel.findall(
        f"{{{atom_uri}}}link"
    ):

        rel = atom_link.get(
            "rel"
        )

        if rel == "self":

            atom_link.set(
                "href",
                feed_url
            )

        elif rel in (
            "first",
            "last",
            "previous",
            "next"
        ):

            atom_link.set(
                "href",
                feed_url
            )

    # --------------------------------------------------------
    # itunes:new-feed-url
    # --------------------------------------------------------

    new_feed = channel.find(
        f"{{{itunes_uri}}}"
        f"new-feed-url"
    )

    if new_feed is not None:

        new_feed.text = (
            feed_url
        )

    # ========================================================
    # 核心：
    # 只保留已经处理的 episode
    # ========================================================

    processed = pc_state.get(
        "processed",
        {}
    )

    all_items = channel.findall(
        "item"
    )

    removed = 0
    added = 0
    replaced_audio = 0

    for item in all_items:

        guid_elem = item.find(
            "guid"
        )

        if (
            guid_elem is None
            or not guid_elem.text
        ):

            channel.remove(
                item
            )

            removed += 1

            continue

        guid = (
            guid_elem.text.strip()
        )

        # ----------------------------------------------------
        # 未处理
        # ----------------------------------------------------

        if guid not in processed:

            channel.remove(
                item
            )

            removed += 1

            continue

        # ----------------------------------------------------
        # 已处理
        # ----------------------------------------------------

        episode_state = (
            processed[guid]
        )

        # ----------------------------------------------------
        # 替换 enclosure
        # ----------------------------------------------------

        actual_audio_url = (
            episode_state.get(
                "audio_url"
            )
        )

        if actual_audio_url:

            enclosures = (
                item.findall(
                    "enclosure"
                )
            )

            if enclosures:

                enclosure = (
                    enclosures[0]
                )

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
                        "   🔗 enclosure:"
                    )

                    print(
                        f"      原: "
                        f"{old_url}"
                    )

                    print(
                        f"      新: "
                        f"{actual_audio_url}"
                    )

        # ----------------------------------------------------
        # 添加 transcript
        # ----------------------------------------------------

        vtt_filename = (
            episode_state.get(
                "vtt_filename"
            )
        )

        if not vtt_filename:

            continue

        vtt_url = (
            f"{BASE_URL}/"
            f"{PODCAST_SLUG}/"
            f"transcripts/"
            f"{vtt_filename}"
        )

        existing = item.findall(
            f"{{{ns_uri}}}"
            f"transcript"
        )

        if any(
            e.get("url") == vtt_url
            for e in existing
        ):

            continue

        transcript = (
            etree.SubElement(
                item,
                f"{{{ns_uri}}}"
                f"transcript"
            )
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

        added += 1

    # ========================================================
    # 写 Feed
    # ========================================================

    tree = etree.ElementTree(
        root
    )

    feed_path = (
        PODCAST_DIR
        / "feed.xml"
    )

    tree.write(
        feed_path,
        pretty_print=True,
        xml_declaration=True,
        encoding="utf-8"
    )

    print(
        "💾 Feed 已保存"
    )

    print(
        f"   保留处理集数: "
        f"{len(processed)}"
    )

    print(
        f"   删除未处理集数: "
        f"{removed}"
    )

    print(
        f"   新增字幕标签: "
        f"{added}"
    )

    print(
        f"   替换 enclosure: "
        f"{replaced_audio}"
    )

    print(
        f"   文件: {feed_path}"
    )

    # ========================================================
    # 生成 Podcast 首页
    # ========================================================

    total = pc_state.get(
        "total_processed",
        0
    )

    display_name = (
        f"{PODCAST_SLUG} "
        f"(Unofficial)"
    )

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport"
      content="width=device-width, initial-scale=1">
<title>{display_name} - Transcripts</title>
<style>
body {{
    font-family:
        system-ui,
        -apple-system,
        sans-serif;
    max-width:720px;
    margin:40px auto;
    padding:0 20px;
    line-height:1.6;
    color:#333;
}}
code {{
    background:#f4f4f4;
    padding:2px 6px;
    border-radius:4px;
    word-break:break-all;
}}
a {{
    color:#0366d6;
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
当前 Feed 只包含已经处理完成的集数。
</p>

</body>
</html>
"""

    (
        PODCAST_DIR
        / "index.html"
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
            f"{slug} "
            f"(Unofficial)"
        )

        items += (
            f'<li>'
            f'<a href="{BASE_URL}/{slug}/">'
            f'{display_name}'
            f'</a> '
            f'— 已处理 {total} 集 '
            f'<small>('
            f'<a href="{BASE_URL}/{slug}/feed.xml">'
            f'Feed'
            f'</a>)</small>'
            f'</li>\n'
        )

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">

<head>

<meta charset="utf-8">

<meta name="viewport"
      content="width=device-width, initial-scale=1">

<title>
Podcast Transcripts Hub
(Unofficial)
</title>

<style>

body {{
    font-family:
        system-ui,
        -apple-system,
        sans-serif;

    max-width:720px;

    margin:40px auto;

    padding:0 20px;

    line-height:1.6;

    color:#333;
}}

a {{
    color:#0366d6;
}}

li {{
    margin:8px 0;
}}

</style>

</head>

<body>

<h1>
🎙️ Podcast Transcripts Hub
(Unofficial)
</h1>

<p>
以下播客均已自动生成
中英双语 VTT 字幕。
</p>

<ul>
{items}
</ul>

</body>

</html>
"""

    (
        SITE_DIR
        / "index.html"
    ).write_text(
        html,
        encoding="utf-8"
    )


# ============================================================
# MAIN
# ============================================================

def main():

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

    print(
        f"🇨🇳 中国代理: "
        f"{USE_CHINA_PROXY}"
    )

    print(
        f"🔀 最大代理尝试数: "
        f"{MAX_PROXY_ATTEMPTS}"
    )

    print(
        f"⏱️ 代理测试超时: "
        f"{PROXY_TEST_TIMEOUT}s"
    )

    print(
        f"💾 代理缓存 TTL: "
        f"{PROXY_CACHE_TTL}s"
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
    # 下一集
    # ========================================================

    next_entry = find_next_entry(
        entries,
        processed
    )

    if not next_entry:

        print(
            "✅ 该播客全部处理完毕"
        )

        print(
            "🔄 仅更新 Feed"
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
    # Episode
    # ========================================================

    title = next_entry.get(
        "title",
        "untitled"
    )

    guid = (
        next_entry.get("guid")
        or next_entry.get("id")
        or title
    )

    print(
        f"\n🎯 本次处理: "
        f"{title}"
    )

    print(
        f"🔑 GUID: "
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
            "❌ RSS 中未找到音频 enclosure"
        )

        sys.exit(1)

    print(
        "📎 RSS 原始 enclosure:"
    )

    print(
        f"   {enclosure_url}"
    )

    # ========================================================
    # 解析 enclosure
    # ========================================================

    audio_url, audio_source = (
        resolve_enclosure_url(
            enclosure_url
        )
    )

    if audio_url != enclosure_url:

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

    # ========================================================
    # 下载
    # ========================================================

    try:

        proxy_info = download_audio(
            audio_url,
            mp3_path
        )

    except Exception as e:

        print(
            f"❌ 音频下载失败: "
            f"{e}"
        )

        sys.exit(1)

    if not proxy_info:

        proxy_info = {
            "proxy":
                None,

            "public_ip":
                None
        }

    print(
        "\n📡 本次下载出口:"
    )

    print(
        f"   Proxy: "
        f"{proxy_info.get('proxy')}"
    )

    print(
        f"   Public IP: "
        f"{proxy_info.get('public_ip')}"
    )

    # ========================================================
    # Whisper
    # ========================================================

    print(
        f"\n📝 使用实际音频进行转录 "
        f"({MODEL_SIZE}, CPU int8, VAD)..."
    )

    try:

        model = WhisperModel(
            MODEL_SIZE,
            device="cpu",
            compute_type="int8"
        )

        segments_iter, info = (
            model.transcribe(

                str(mp3_path),

                beam_size=5,

                language="en",

                vad_filter=True,

                vad_parameters=dict(
                    min_silence_duration_ms=300
                ),

                condition_on_previous_text=False,

                initial_prompt=(
                    "Please punctuate "
                    "accurately and break "
                    "sentences naturally."
                ),

                log_prob_threshold=-1.0,

                no_speech_threshold=0.6,
            )
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
                        f"{total_duration:.1f}s) "
                        f"| 第 {i} 段"
                    )

                else:

                    print(
                        f"   转录进度: "
                        f"{seg.end:.1f}s "
                        f"| 第 {i} 段"
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

        # 删除临时 MP3
        if mp3_path.exists():

            try:

                mp3_path.unlink()

            except Exception:

                pass

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
        "🌐 开始翻译 "
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

        "title":
            title,

        "vtt_filename":
            vtt_filename,

        "processed_at":
            datetime.now(
                timezone.utc
            ).isoformat(),

        # 原始 RSS enclosure
        "enclosure_url":
            enclosure_url,

        # 实际用于 Whisper
        # 同时写入新 Feed
        "audio_url":
            audio_url,

        "audio_source":
            audio_source,

        # 下载代理
        "proxy":
            proxy_info.get(
                "proxy"
            ),

        "public_ip":
            proxy_info.get(
                "public_ip"
            ),

    }

    pc_state[
        "total_processed"
    ] = (
        pc_state.get(
            "total_processed",
            0
        )
        + 1
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

    # ========================================================
    # 生成 Feed
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

    print(
        f"\n✅ 完成！"
    )

    print(
        f"   播客: "
        f"{PODCAST_SLUG}"
    )

    print(
        f"   累计处理: "
        f"{pc_state['total_processed']} 集"
    )

    print(
        f"   Feed: "
        f"{BASE_URL}/"
        f"{PODCAST_SLUG}/feed.xml"
    )

    print(
        f"   Transcript: "
        f"{BASE_URL}/"
        f"{PODCAST_SLUG}/"
        f"transcripts/"
        f"{vtt_filename}"
    )


# ============================================================
# Entry
# ============================================================

if __name__ == "__main__":

    main()