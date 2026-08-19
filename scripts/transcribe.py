import os
import sys
import json
import time
import re
import random
import hashlib
import threading

import feedparser
import requests

from concurrent.futures import (
    ThreadPoolExecutor,
    wait,
    FIRST_COMPLETED,
)

from datetime import datetime, timezone
from faster_whisper import WhisperModel
from pathlib import Path
from lxml import etree

import builtins
from datetime import datetime


_original_print = builtins.print


def print(*args, **kwargs):
    timestamp = datetime.now().strftime(
        "%Y-%m-%d %H:%M:%S.%f"
    )[:-3]

    _original_print(
        f"[{timestamp}]",
        *args,
        **kwargs,
        flush=True
    )
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


# 是否使用中国代理
#
# 如果设置为 false：
# 程序不会使用 Runner IP 下载，
# 而是直接终止。
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
        "200"
    )
)


# ============================================================
# 代理并发
# ============================================================

# 同时运行多少个代理任务
#
# 建议：
# 10 ~ 20
#
# 免费代理 + 大型 MP3 下载时，
# 不建议一开始就开到 50/100。
PROXY_WORKERS = int(
    os.environ.get(
        "PROXY_WORKERS",
        "20"
    )
)


# ============================================================
# 超时
# ============================================================

# GeoIP 连接/读取超时
PROXY_TEST_TIMEOUT = int(
    os.environ.get(
        "PROXY_TEST_TIMEOUT",
        "8"
    )
)


# 音频连接超时
AUDIO_CONNECT_TIMEOUT = int(
    os.environ.get(
        "AUDIO_CONNECT_TIMEOUT",
        "8"
    )
)


# 音频读取超时
#
# 这是“连续多久没有收到任何数据”。
#
# 不建议设置过小。
AUDIO_READ_TIMEOUT = int(
    os.environ.get(
        "AUDIO_READ_TIMEOUT",
        "15"
    )
)


# 下载 chunk
DOWNLOAD_CHUNK_SIZE = int(
    os.environ.get(
        "DOWNLOAD_CHUNK_SIZE",
        str(256 * 1024)
    )
)


# 代理缓存时间
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

        owner, repo = gh_repo.split(
            "/",
            1
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


# 当前运行中已经确认失败的代理
BAD_PROXIES = set()

BAD_PROXIES_LOCK = threading.Lock()


# ============================================================
# 竞速停止事件
# ============================================================

PROXY_STOP_EVENT = threading.Event()


# ============================================================
# Winner 锁
# ============================================================

PROXY_WINNER_LOCK = threading.Lock()


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
                f"{type(e).__name__}: {e}, "
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
    直接从 RSS 中取得原始 enclosure。

    不解析：
    - pdst.fm
    - Castfire
    - Megaphone
    - 其他真实音频地址
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
# SOCKS 支持
# ============================================================

def check_socks_support():

    try:

        import socks  # noqa

        print(
            "   ✅ PySocks 已安装，"
            "支持 SOCKS4/SOCKS5"
        )

        return True

    except ImportError:

        print(
            "   ⚠️ 未检测到 PySocks"
        )

        print(
            '   请安装: '
            'pip install "requests[socks]"'
        )

        return False


def is_socks_proxy(proxy):

    return proxy.lower().startswith(
        (
            "socks4://",
            "socks4a://",
            "socks5://",
            "socks5h://"
        )
    )


# ============================================================
# BAD PROXY
# ============================================================

def mark_bad_proxy(proxy):

    with BAD_PROXIES_LOCK:

        BAD_PROXIES.add(
            proxy
        )


def is_bad_proxy(proxy):

    with BAD_PROXIES_LOCK:

        return proxy in BAD_PROXIES


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

            data = json.load(f)

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
            f"{type(e).__name__}: {e}"
        )

        return []


def save_proxy_cache(proxies):

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
            f"{type(e).__name__}: {e}"
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
                f"获取失败: "
                f"{type(e).__name__}: {e}"
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
                r"^(http|https|socks4|socks4a|socks5|socks5h)://"
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

def get_proxy_geoip(proxy):

    if PROXY_STOP_EVENT.is_set():

        return None

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

            print(
                f"   ⚠️ [{proxy}] "
                f"GeoIP 返回 success=false"
            )

            return None

        return {
            "ip":
                data.get("ip"),

            "country_code":
                data.get("country_code"),

            "country":
                data.get("country")
        }

    except Exception as e:

        print(
            f"   ❌ [{proxy}] "
            f"GeoIP 失败: "
            f"{type(e).__name__}: {e}"
        )

        return None


# ============================================================
# 音频格式验证
# ============================================================

def validate_audio_file(path):

    if not path.exists():

        raise RuntimeError(
            "音频文件不存在"
        )

    size = path.stat().st_size

    if size < 1024:

        raise RuntimeError(
            f"音频文件异常: "
            f"{size} bytes"
        )

    with open(
        path,
        "rb"
    ) as f:

        header = f.read(
            32
        )

    valid_audio = (

        # MP3 ID3
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

        # AAC ADTS
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

    return size


# ============================================================
# SHA256
# ============================================================

def calculate_sha256(path):

    sha256 = hashlib.sha256()

    with open(
        path,
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

    return sha256.hexdigest()


# ============================================================
# 单代理完整下载
# ============================================================

def proxy_download_worker(
    index,
    total,
    proxy,
    audio_url,
    race_dir,
    headers
):
    """
    一个代理从 GeoIP 到完整音频下载。

    注意：
    只有“完整下载 + 音频格式验证成功”
    才算真正成功。
    """

    if PROXY_STOP_EVENT.is_set():

        return {
            "ok": False,
            "proxy": proxy,
            "stopped": True
        }

    if is_bad_proxy(proxy):

        return {
            "ok": False,
            "proxy": proxy,
            "stopped": True
        }

    # --------------------------------------------------------
    # SOCKS
    # --------------------------------------------------------

    if is_socks_proxy(proxy):

        try:

            import socks  # noqa

        except ImportError:

            mark_bad_proxy(
                proxy
            )

            return {
                "ok": False,
                "proxy": proxy,
                "reason":
                    "未安装 PySocks"
            }

    temp_name = (
        f"{index:04d}_"
        f"{hashlib.md5(proxy.encode()).hexdigest()[:12]}"
        f".part"
    )

    temp_path = (
        race_dir
        / temp_name
    )

    try:

        print(
            f"\n🚀 [{index}/{total}] "
            f"开始代理竞速: {proxy}"
        )

        # ====================================================
        # GeoIP
        # ====================================================

        geo = get_proxy_geoip(
            proxy
        )

        if PROXY_STOP_EVENT.is_set():

            return {
                "ok": False,
                "proxy": proxy,
                "stopped": True
            }

        if not geo:

            mark_bad_proxy(
                proxy
            )

            return {
                "ok": False,
                "proxy": proxy,
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
            f"   🌍 [{proxy}] "
            f"IP={public_ip} "
            f"Country={country_code}"
        )

        # ====================================================
        # 必须 CN
        # ====================================================

        if country_code != "CN":

            mark_bad_proxy(
                proxy
            )

            return {
                "ok": False,
                "proxy": proxy,
                "reason":
                    f"不是中国大陆 IP: "
                    f"{country_code}"
            }

        # ====================================================
        # 再次检查停止事件
        # ====================================================

        if PROXY_STOP_EVENT.is_set():

            return {
                "ok": False,
                "proxy": proxy,
                "stopped": True
            }

        # ====================================================
        # 开始真正下载
        # ====================================================

        request_proxies = {
            "http": proxy,
            "https": proxy
        }

        print(
            f"   ⬇️ [{proxy}] "
            f"开始实际下载 RSS enclosure"
        )

        total_bytes = 0

        with requests.get(
            audio_url,
            timeout=(
                AUDIO_CONNECT_TIMEOUT,
                AUDIO_READ_TIMEOUT
            ),
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

            print(
                f"   📡 [{proxy}] "
                f"HTTP {response.status_code}"
            )

            print(
                f"   📦 [{proxy}] "
                f"Content-Type: "
                f"{content_type}"
            )

            print(
                f"   🔗 [{proxy}] "
                f"最终 URL: "
                f"{response.url}"
            )

            # ------------------------------------------------
            # 防止服务器返回网页
            # ------------------------------------------------

            if (
                "text/html"
                in content_type
            ):

                raise RuntimeError(
                    "服务器返回 HTML"
                )

            # ------------------------------------------------
            # 独立临时文件
            # ------------------------------------------------

            with open(
                temp_path,
                "wb"
            ) as f:

                for chunk in response.iter_content(
                    chunk_size=DOWNLOAD_CHUNK_SIZE
                ):

                    # ----------------------------------------
                    # winner 已出现
                    # ----------------------------------------

                    if PROXY_STOP_EVENT.is_set():

                        print(
                            f"   🛑 [{proxy}] "
                            f"发现其他代理已获胜，"
                            f"停止当前下载"
                        )

                        return {
                            "ok":
                                False,

                            "proxy":
                                proxy,

                            "stopped":
                                True
                        }

                    if not chunk:

                        continue

                    f.write(
                        chunk
                    )

                    total_bytes += len(
                        chunk
                    )

        # ====================================================
        # winner 出现后，再检查一次
        # ====================================================

        if PROXY_STOP_EVENT.is_set():

            return {
                "ok":
                    False,

                "proxy":
                    proxy,

                "stopped":
                    True
            }

        # ====================================================
        # 完整下载校验
        # ====================================================

        validate_audio_file(
            temp_path
        )

        digest = calculate_sha256(
            temp_path
        )

        print(
            f"   ✅ [{proxy}] "
            f"完整下载成功"
        )

        print(
            f"   📦 大小: "
            f"{total_bytes / 1024 / 1024:.1f} MB"
        )

        print(
            f"   SHA256: "
            f"{digest}"
        )

        # ====================================================
        # 抢夺 winner
        # ====================================================

        with PROXY_WINNER_LOCK:

            if PROXY_STOP_EVENT.is_set():

                return {
                    "ok":
                        False,

                    "proxy":
                        proxy,

                    "stopped":
                        True
                }

            # ----------------------------------------------
            # winner
            # ----------------------------------------------

            PROXY_STOP_EVENT.set()

            print(
                "\n🏆🏆🏆 "
                "找到第一个完整下载成功的中国代理!"
            )

            print(
                f"   Proxy: "
                f"{proxy}"
            )

            print(
                f"   Public IP: "
                f"{public_ip}"
            )

            print(
                f"   Country: "
                f"{country_code}"
            )

        return {
            "ok":
                True,

            "proxy":
                proxy,

            "public_ip":
                public_ip,

            "country_code":
                country_code,

            "country":
                country,

            "temp_path":
                str(temp_path),

            "size":
                total_bytes,

            "sha256":
                digest
        }

    except Exception as e:

        mark_bad_proxy(
            proxy
        )

        print(
            f"   ❌ [{proxy}] "
            f"{type(e).__name__}: {e}"
        )

        return {
            "ok":
                False,

            "proxy":
                proxy,

            "reason":
                f"{type(e).__name__}: {e}"
        }


# ============================================================
# 多线程竞速
# ============================================================

def download_audio(
    audio_url,
    output_path
):
    """
    核心代理竞速逻辑：

    1. 获取最多 MAX_PROXY_ATTEMPTS 个代理
    2. 同时保持 PROXY_WORKERS 个活跃任务
    3. 谁先完整下载成功谁获胜
    4. winner 出现后不再提交新任务
    5. 已运行任务通过 stop_event 停止
    6. 所有 worker 完全退出后才清理临时文件
    7. 最后把 winner 文件移动为最终 MP3

    绝不使用 Runner IP。
    """

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
    # 严格禁止无代理下载
    # ========================================================

    if not USE_CHINA_PROXY:

        print(
            "❌ USE_CHINA_PROXY=false"
        )

        print(
            "🚫 根据当前配置，"
            "不允许使用 GitHub Actions Runner IP 下载"
        )

        raise RuntimeError(
            "中国代理模式未启用，任务终止"
        )

    # ========================================================
    # 获取代理
    # ========================================================

    proxies = get_china_proxies()

    if not proxies:

        print(
            "\n❌ 没有获取到中国代理"
        )

        print(
            "🚫 不使用 GitHub Actions Runner IP"
        )

        raise RuntimeError(
            "无法获取中国代理，任务终止"
        )

    # ========================================================
    # 限制数量
    # ========================================================

    proxies = proxies[
        :MAX_PROXY_ATTEMPTS
    ]

    # ========================================================
    # 清理状态
    # ========================================================

    PROXY_STOP_EVENT.clear()

    with BAD_PROXIES_LOCK:

        BAD_PROXIES.clear()

    # ========================================================
    # 临时目录
    # ========================================================

    race_dir = (
        output_path.parent
        / ".proxy_race"
    )

    race_dir.mkdir(
        parents=True,
        exist_ok=True
    )

    # --------------------------------------------------------
    # 清理旧 .part
    # --------------------------------------------------------

    for old_part in race_dir.glob(
        "*.part"
    ):

        try:

            old_part.unlink()

        except Exception:
            pass

    # ========================================================
    # 并发参数
    # ========================================================

    total = len(
        proxies
    )

    worker_count = max(
        1,
        min(
            PROXY_WORKERS,
            total
        )
    )

    print(
        "\n🏁 代理竞速开始"
    )

    print(
        f"   RSS enclosure: "
        f"{audio_url}"
    )

    print(
        f"   代理总数: "
        f"{total}"
    )

    print(
        f"   并发线程: "
        f"{worker_count}"
    )

    print(
        f"   GeoIP 超时: "
        f"{PROXY_TEST_TIMEOUT}s"
    )

    print(
        f"   Audio connect timeout: "
        f"{AUDIO_CONNECT_TIMEOUT}s"
    )

    print(
        f"   Audio read timeout: "
        f"{AUDIO_READ_TIMEOUT}s"
    )

    # ========================================================
    # 动态提交任务
    #
    # 永远只保持 worker_count 个活跃/待完成任务。
    #
    # 这样 winner 出现以后，不会有一堆已经排队的
    # Future 又继续启动。
    # ========================================================

    executor = ThreadPoolExecutor(
        max_workers=worker_count,
        thread_name_prefix="proxy-race"
    )

    pending = set()

    next_index = 0

    winner_result = None

    completed_count = 0

    try:

        # ----------------------------------------------------
        # 初始填满 worker
        # ----------------------------------------------------

        while (
            len(pending) < worker_count
            and next_index < total
        ):

            proxy = proxies[
                next_index
            ]

            index = (
                next_index + 1
            )

            next_index += 1

            if is_bad_proxy(proxy):

                continue

            future = executor.submit(
                proxy_download_worker,
                index,
                total,
                proxy,
                audio_url,
                race_dir,
                headers
            )

            pending.add(
                future
            )

        # ----------------------------------------------------
        # 动态循环
        # ----------------------------------------------------

        while pending:

            done, pending = wait(
                pending,
                return_when=FIRST_COMPLETED
            )

            for future in done:

                completed_count += 1

                try:

                    result = (
                        future.result()
                    )

                except Exception as e:

                    print(
                        f"   ⚠️ Worker "
                        f"异常: "
                        f"{type(e).__name__}: "
                        f"{e}"
                    )

                    result = None

                # --------------------------------------------
                # 找到 winner
                # --------------------------------------------

                if (
                    result
                    and result.get("ok")
                ):

                    winner_result = (
                        result
                    )

                    # ----------------------------------------
                    # 不再提交任何新任务
                    # ----------------------------------------

                    PROXY_STOP_EVENT.set()

                    break

            # ------------------------------------------------
            # winner 已找到
            # ------------------------------------------------

            if winner_result:

                print(
                    "\n🛑 Winner 已产生"
                )

                print(
                    "   不再启动新的代理任务"
                )

                print(
                    "   等待正在执行的代理"
                    "安全退出..."
                )

                break

            # ------------------------------------------------
            # 没有 winner：
            # 补充新的代理
            # ------------------------------------------------

            while (
                len(pending) < worker_count
                and next_index < total
                and not PROXY_STOP_EVENT.is_set()
            ):

                proxy = proxies[
                    next_index
                ]

                index = (
                    next_index + 1
                )

                next_index += 1

                if is_bad_proxy(proxy):

                    continue

                future = executor.submit(
                    proxy_download_worker,
                    index,
                    total,
                    proxy,
                    audio_url,
                    race_dir,
                    headers
                )

                pending.add(
                    future
                )

            print(
                f"📊 代理检测/下载进度: "
                f"已完成 {completed_count}/{total}，"
                f"运行中 {len(pending)}"
            )

        # ====================================================
        # winner 出现：
        # 取消未来任务
        # ====================================================

        if winner_result:

            PROXY_STOP_EVENT.set()

            # ------------------------------------------------
            # executor 里还没有开始的任务
            # 直接取消
            # ------------------------------------------------

            executor.shutdown(
                wait=True,
                cancel_futures=True
            )

        else:

            # ------------------------------------------------
            # 全部失败
            # ------------------------------------------------

            executor.shutdown(
                wait=True,
                cancel_futures=True
            )

    finally:

        # ====================================================
        # 防止异常情况下线程池没有退出
        # ====================================================

        if not PROXY_STOP_EVENT.is_set():

            PROXY_STOP_EVENT.set()

            try:

                executor.shutdown(
                    wait=True,
                    cancel_futures=True
                )

            except Exception:
                pass

    # ========================================================
    # 注意：
    #
    # 到这里所有 worker 已经真正退出。
    #
    # 所以现在再清理 .part 才不会出现：
    #
    # FileNotFoundError
    #
    # 或后台线程继续写文件。
    # ========================================================

    print(
        "\n🧹 所有代理线程已退出"
    )

    # ========================================================
    # Winner 检查
    # ========================================================

    if not winner_result:

        print(
            "\n❌ 所有中国代理均失败"
        )

        print(
            f"   共尝试: "
            f"{total}"
        )

        print(
            "🚫 不使用 GitHub Actions Runner IP"
        )

        print(
            "🛑 本次任务直接退出"
        )

        # 清理所有临时文件

        for part_file in race_dir.glob(
            "*.part"
        ):

            try:

                part_file.unlink()

            except Exception:
                pass

        try:

            race_dir.rmdir()

        except Exception:
            pass

        raise RuntimeError(
            "所有中国代理均无法下载音频"
        )

    # ========================================================
    # Winner
    # ========================================================

    winner_proxy = (
        winner_result[
            "proxy"
        ]
    )

    winner_temp = Path(
        winner_result[
            "temp_path"
        ]
    )

    print(
        "\n🏆 最终 Winner"
    )

    print(
        f"   Proxy: "
        f"{winner_proxy}"
    )

    print(
        f"   Public IP: "
        f"{winner_result.get('public_ip')}"
    )

    print(
        f"   Country: "
        f"{winner_result.get('country_code')}"
    )

    print(
        f"   Size: "
        f"{winner_result.get('size', 0) / 1024 / 1024:.1f} MB"
    )

    print(
        f"   SHA256: "
        f"{winner_result.get('sha256')}"
    )

    # ========================================================
    # Winner 文件必须存在
    # ========================================================

    if not winner_temp.exists():

        # 最后保险：
        # 某种异常情况下 runner 文件不存在
        #
        # 不使用其他代理，也不使用 Runner IP。
        raise RuntimeError(
            "Winner 已产生，但 winner 临时音频不存在"
        )

    # ========================================================
    # 删除旧文件
    # ========================================================

    if output_path.exists():

        try:

            output_path.unlink()

        except Exception as e:

            raise RuntimeError(
                f"无法删除旧音频: {e}"
            ) from e

    # ========================================================
    # 移动 Winner
    # ========================================================

    winner_temp.replace(
        output_path
    )

    # ========================================================
    # 清理其他 .part
    #
    # 现在所有 worker 都已经退出，
    # 所以安全。
    # ========================================================

    for part_file in race_dir.glob(
        "*.part"
    ):

        try:

            part_file.unlink()

        except Exception as e:

            print(
                f"   ⚠️ 清理临时文件失败: "
                f"{part_file}: "
                f"{e}"
            )

    try:

        race_dir.rmdir()

    except Exception:
        pass

    # ========================================================
    # 最终验证
    # ========================================================

    final_size = validate_audio_file(
        output_path
    )

    final_sha256 = calculate_sha256(
        output_path
    )

    print(
        "\n✅ 代理竞速完成"
    )

    print(
        f"   Proxy: "
        f"{winner_proxy}"
    )

    print(
        f"   Public IP: "
        f"{winner_result.get('public_ip')}"
    )

    print(
        f"   Country: "
        f"{winner_result.get('country_code')}"
    )

    print(
        f"   Audio: "
        f"{output_path}"
    )

    print(
        f"   Size: "
        f"{final_size / 1024 / 1024:.1f} MB"
    )

    print(
        f"   SHA256: "
        f"{final_sha256}"
    )

    return {
        "proxy":
            winner_proxy,

        "public_ip":
            winner_result.get(
                "public_ip"
            ),

        "country_code":
            winner_result.get(
                "country_code"
            ),

        "country":
            winner_result.get(
                "country"
            ),

        "sha256":
            final_sha256,

        "size":
            final_size
    }


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
    # 原始 RSS
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
    # Podcast namespace
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
    # 只保留已处理 episode
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
        # 恢复原始 enclosure
        # ----------------------------------------------------

        original_enclosure_url = (
            episode_state.get(
                "enclosure_url"
            )
        )

        if original_enclosure_url:

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
                    != original_enclosure_url
                ):

                    enclosure.set(
                        "url",
                        original_enclosure_url
                    )

                    replaced_audio += 1

                    print(
                        "   🔗 恢复原始 enclosure:"
                    )

                    print(
                        f"      原: "
                        f"{old_url}"
                    )

                    print(
                        f"      新: "
                        f"{original_enclosure_url}"
                    )

        # ----------------------------------------------------
        # transcript
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
        f"   恢复原始 enclosure: "
        f"{replaced_audio}"
    )

    print(
        f"   文件: {feed_path}"
    )

    # ========================================================
    # Podcast 首页
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
        f"🧵 并发线程: "
        f"{PROXY_WORKERS}"
    )

    print(
        f"⏱️ GeoIP 超时: "
        f"{PROXY_TEST_TIMEOUT}s"
    )

    print(
        f"⏱️ Audio connect timeout: "
        f"{AUDIO_CONNECT_TIMEOUT}s"
    )

    print(
        f"⏱️ Audio read timeout: "
        f"{AUDIO_READ_TIMEOUT}s"
    )

    print(
        f"💾 代理缓存 TTL: "
        f"{PROXY_CACHE_TTL}s"
    )

    # ========================================================
    # SOCKS
    # ========================================================

    check_socks_support()

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
    # 直接使用原始 enclosure
    # ========================================================

    audio_url = (
        enclosure_url
    )

    audio_source = (
        "rss_enclosure"
    )

    print(
        "🎧 直接使用 RSS 原始 enclosure"
    )

    print(
        "   不解析 pdst.fm 中的真实地址"
    )

    # ========================================================
    # 最终音频
    # ========================================================

    safe_title = safe_filename(
        title
    )

    mp3_path = (
        PODCAST_DIR
        / f"{safe_title}.mp3"
    )

    # ========================================================
    # 代理竞速下载
    # ========================================================

    try:

        proxy_info = download_audio(
            audio_url,
            mp3_path
        )

    except Exception as e:

        print(
            f"\n❌ 音频下载失败: "
            f"{type(e).__name__}: {e}"
        )

        sys.exit(1)

    if not proxy_info:

        print(
            "❌ 未获得有效中国代理信息"
        )

        if mp3_path.exists():

            try:

                mp3_path.unlink()

            except Exception:
                pass

        sys.exit(1)

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

    print(
        f"   Country: "
        f"{proxy_info.get('country_code')}"
    )

    # ========================================================
    # Whisper
    #
    # 到这里代理竞速线程已经全部退出。
    # 不会再有后台线程写 .part。
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
            f"{type(e).__name__}: {e}"
        )

        sys.exit(1)

    finally:

        # ----------------------------------------------------
        # 删除最终临时 MP3
        # ----------------------------------------------------

        if mp3_path.exists():

            try:

                mp3_path.unlink()

                print(
                    f"🗑️ 已删除临时音频: "
                    f"{mp3_path.name}"
                )

            except Exception as e:

                print(
                    f"⚠️ 删除临时 MP3 失败: "
                    f"{type(e).__name__}: {e}"
                )

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

        # 与 enclosure_url 相同
        "audio_url":
            audio_url,

        "audio_source":
            audio_source,

        # 实际下载代理
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
    # Feed
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
        "\n✅ 完成！"
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