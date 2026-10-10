import os
import sys
import json
import time
import re
import random
import hashlib
import threading
import builtins
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from pathlib import Path

import feedparser
import requests
from faster_whisper import WhisperModel
from lxml import etree

# ============================================================
# 日志
# ============================================================

_original_print = builtins.print


def print(*args, **kwargs):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    _original_print(f"[{timestamp}]", *args, **kwargs, flush=True)


# ============================================================
# 配置
# ============================================================

PODCAST_SLUG = os.environ.get("PODCAST_SLUG", "default")
FEED_URL = os.environ.get("FEED_URL")
MODEL_SIZE = os.environ.get("WHISPER_MODEL", "base.en")
BASE_URL = os.environ.get("BASE_URL", "").rstrip("/")

USE_CHINA_PROXY = os.environ.get("USE_CHINA_PROXY", "true").lower() == "true"
MAX_PROXY_ATTEMPTS = int(os.environ.get("MAX_PROXY_ATTEMPTS", "200"))
PROXY_WORKERS = int(os.environ.get("PROXY_WORKERS", "20"))

PROXY_TEST_TIMEOUT = int(os.environ.get("PROXY_TEST_TIMEOUT", "8"))
AUDIO_CONNECT_TIMEOUT = int(os.environ.get("AUDIO_CONNECT_TIMEOUT", "8"))
AUDIO_READ_TIMEOUT = int(os.environ.get("AUDIO_READ_TIMEOUT", "15"))
DOWNLOAD_CHUNK_SIZE = int(os.environ.get("DOWNLOAD_CHUNK_SIZE", str(256 * 1024)))
PROXY_CACHE_TTL = int(os.environ.get("PROXY_CACHE_TTL", "1800"))

# 翻译设置
TRANSLATE_BATCH_SIZE = max(1, int(os.environ.get("TRANSLATE_BATCH_SIZE", "5")))
TRANSLATE_BATCH_MAX_CHARS = max(
    200, int(os.environ.get("TRANSLATE_BATCH_MAX_CHARS", "1800"))
)
TRANSLATE_BATCH_DELAY = max(0.0, float(os.environ.get("TRANSLATE_BATCH_DELAY", "2.0")))
TRANSLATE_MAX_RETRIES = max(1, int(os.environ.get("TRANSLATE_MAX_RETRIES", "6")))
TRANSLATE_BASE_DELAY = max(1.0, float(os.environ.get("TRANSLATE_BASE_DELAY", "10")))
TRANSLATE_MAX_DELAY = max(10.0, float(os.environ.get("TRANSLATE_MAX_DELAY", "300")))

if not BASE_URL:
    gh_repo = os.environ.get("GITHUB_REPOSITORY", "")
    if gh_repo and "/" in gh_repo:
        owner, repo = gh_repo.split("/", 1)
        BASE_URL = f"https://{owner}.github.io/{repo}"
        print(f"⚠️ BASE_URL 未设置，从 GITHUB_REPOSITORY 推断: {BASE_URL}")

SITE_DIR = Path("site")
PODCAST_DIR = SITE_DIR / PODCAST_SLUG
TRANSCRIPTS_DIR = PODCAST_DIR / "transcripts"
STATE_FILE = Path("state.json")
PROXY_CACHE_FILE = Path(".china_proxy_cache.json")

PODCAST_DIR.mkdir(parents=True, exist_ok=True)
TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)

BAD_PROXIES = set()
BAD_PROXIES_LOCK = threading.Lock()
PROXY_STOP_EVENT = threading.Event()
PROXY_WINNER_LOCK = threading.Lock()

ABBREVIATIONS = (
    r"\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|vol|vols|inc|etc|eg|ie|et al|"
    r"st|ave|blvd|rd|dept|univ|No|pp|par|Ltd|Co|Corp|Plc|LLC|U\.S|"
    r"U\.K|e\.g|i\.e)\."
)

PROXY_API_URLS = [
    (
        "ProxyScrape",
        "https://api.proxyscrape.com/v4/free-proxy-list/get"
        "?request=display_proxies&proxy_format=protocolipport"
        "&format=text&country=cn",
    ),
]

GEOIP_URL = "https://ipwho.is/"

PROXY_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/138.0 Safari/537.36"
    )
}


# ============================================================
# State / 文件名 / 时间
# ============================================================


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
    keep = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_. "
    filename = "".join(c if c in keep else "_" for c in title)
    return filename.strip().replace(" ", "_")[:80] or "untitled"


def format_vtt_time(seconds):
    seconds = max(0.0, float(seconds))
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int((seconds - int(seconds)) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{millis:03d}"


# ============================================================
# 句子切分与字幕重分段
# ============================================================


def split_sentences(text):
    if not text:
        return []

    protected = re.sub(
        ABBREVIATIONS,
        lambda m: m.group(0).replace(".", "##DOT##"),
        text,
        flags=re.IGNORECASE,
    )

    parts = re.split(r"(?<=[.!?])\s+", protected)
    return [p.replace("##DOT##", ".").strip() for p in parts if p.strip()]


def resegment(raw_segments):
    entries = []

    for seg in raw_segments:
        text = seg.text.strip()
        if text:
            entries.append(
                {
                    "start": float(seg.start),
                    "end": float(seg.end),
                    "text": text,
                }
            )

    merged = []
    buf = {"text": "", "start": 0.0, "end": 0.0}

    for entry in entries:
        if not buf["text"]:
            buf = dict(entry)
        else:
            buf["text"] += " " + entry["text"]
            buf["end"] = entry["end"]

        if re.search(r'[.!?]["\']?$', buf["text"]):
            merged.append(dict(buf))
            buf = {"text": "", "start": 0.0, "end": 0.0}

    if buf["text"]:
        merged.append(buf)

    final = []

    for item in merged:
        sentences = split_sentences(item["text"])

        if len(sentences) <= 1:
            final.append(item)
            continue

        total_chars = sum(len(s) for s in sentences) or 1
        duration = max(0.0, item["end"] - item["start"])
        cursor = item["start"]

        for index, sentence in enumerate(sentences):
            if index == len(sentences) - 1:
                end = item["end"]
            else:
                end = cursor + duration * len(sentence) / total_chars

            final.append(
                {
                    "start": cursor,
                    "end": max(cursor, end),
                    "text": sentence,
                }
            )
            cursor = end

    return final


def write_bilingual_vtt(sentences, path):
    with open(path, "w", encoding="utf-8") as f:
        f.write("WEBVTT\n\n")

        for item in sentences:
            start = format_vtt_time(item["start"])
            end = format_vtt_time(item["end"])
            en = item.get("en", "").strip().replace("\n", " ")
            zh = item.get("zh", "").strip().replace("\n", " ")

            f.write(f"{start} --> {end}\n{en}\n{zh}\n\n")


# ============================================================
# 翻译模块：批量合并、限流退避、有限重试
# ============================================================


class TranslationError(RuntimeError):
    """翻译服务持续失败或返回无法可靠拆分的结果。"""


def is_retryable_translation_error(exc):
    message = f"{type(exc).__name__}: {exc}".lower()

    retry_markers = (
        "toomanyrequests",
        "too many requests",
        "429",
        "rate limit",
        "timed out",
        "timeout",
        "connection",
        "503",
        "502",
        "500",
        "server error",
        "temporarily unavailable",
        "remote end closed",
    )

    # GoogleTranslator 返回的常见网络/限流异常可重试。
    return any(marker in message for marker in retry_markers)


def translate_with_retry(text, translator):
    """
    对一次翻译请求进行有限重试。

    达到最大重试次数后直接报错，不无限等待，
    也不自动将失败批次拆成大量单句请求。
    """
    for attempt in range(1, TRANSLATE_MAX_RETRIES + 1):
        try:
            result = translator.translate(text)

            if result is None or not str(result).strip():
                raise TranslationError("翻译服务返回空结果")

            return str(result).strip()

        except Exception as exc:
            if attempt >= TRANSLATE_MAX_RETRIES:
                raise TranslationError(
                    f"翻译失败，已达到最大重试次数 "
                    f"{TRANSLATE_MAX_RETRIES}: {type(exc).__name__}: {exc}"
                ) from exc

            if not is_retryable_translation_error(exc):
                raise TranslationError(
                    f"不可重试的翻译错误: {type(exc).__name__}: {exc}"
                ) from exc

            delay = min(
                TRANSLATE_BASE_DELAY * (2 ** (attempt - 1)),
                TRANSLATE_MAX_DELAY,
            )
            delay += random.uniform(0.0, min(3.0, delay * 0.15))

            print(
                f"   ⚠️ 翻译请求失败 "
                f"({attempt}/{TRANSLATE_MAX_RETRIES}): "
                f"{type(exc).__name__}: {exc}"
            )
            print(f"   ⏳ {delay:.1f} 秒后重试...")
            time.sleep(delay)

    raise TranslationError("翻译流程意外结束")


def build_translation_batches(sentences):
    """按句数和字符数分批；单条超长句独立成批。"""
    batches = []
    current = []
    current_chars = 0

    for index, item in enumerate(sentences):
        text = item.get("text", "").strip()

        if not text:
            continue

        estimated = len(text)

        should_flush = current and (
            len(current) >= TRANSLATE_BATCH_SIZE
            or current_chars + estimated > TRANSLATE_BATCH_MAX_CHARS
        )

        if should_flush:
            batches.append(current)
            current = []
            current_chars = 0

        current.append((index, text))
        current_chars += estimated

    if current:
        batches.append(current)

    return batches


def translate_batch(translator, batch):
    """
    合并多句为一个请求，成功后按专用标记拆分。

    如果服务端改写了标记或返回的句数不一致，
    不猜测句子对应关系，直接报错，防止字幕错位。
    """
    separator = "\nZXQSEPZXQ\n"
    texts = [text for _, text in batch]
    combined = separator.join(texts)

    translated = translate_with_retry(combined, translator)
    pieces = [piece.strip() for piece in translated.split(separator)]

    if len(pieces) != len(texts) or any(not p for p in pieces):
        raise TranslationError(
            "批量翻译结果无法可靠拆分："
            f"预期 {len(texts)} 条，实际 {len(pieces)} 条。"
            "为避免字幕错位，已停止本次任务。"
        )

    return pieces


def translate_sentences(sentences):
    from deep_translator import GoogleTranslator

    translator = GoogleTranslator(source="en", target="zh-CN")
    results = [
        {
            **item,
            "en": item.get("text", "").strip(),
            "zh": "",
        }
        for item in sentences
    ]

    batches = build_translation_batches(sentences)
    total_batches = len(batches)

    if not batches:
        print("   ℹ️ 没有需要翻译的句子")
        return results

    print(
        f"   翻译设置：每批最多 {TRANSLATE_BATCH_SIZE} 句，"
        f"字符上限 {TRANSLATE_BATCH_MAX_CHARS}，"
        f"批次间隔 {TRANSLATE_BATCH_DELAY:.1f}s，"
        f"最大重试 {TRANSLATE_MAX_RETRIES} 次"
    )

    for batch_number, batch in enumerate(batches, 1):
        print(f"   🌐 翻译批次 {batch_number}/{total_batches}，" f"{len(batch)} 句")

        try:
            translated_pieces = translate_batch(translator, batch)

        except Exception as exc:
            # 不在此处逐句回退，避免批量请求失败后产生请求风暴。
            raise TranslationError(
                f"第 {batch_number}/{total_batches} 批翻译失败。"
                "请稍后重试，或减小 TRANSLATE_BATCH_SIZE。"
                f"原因：{exc}"
            ) from exc

        for (original_index, _), zh in zip(batch, translated_pieces):
            results[original_index]["zh"] = zh

        done_sentences = sum(len(b) for b in batches[:batch_number])
        total_sentences = sum(len(b) for b in batches)

        print(f"   ✅ 翻译进度：{done_sentences}/{total_sentences} 句")

        if batch_number < total_batches and TRANSLATE_BATCH_DELAY:
            time.sleep(TRANSLATE_BATCH_DELAY)

    return results


# ============================================================
# RSS enclosure
# ============================================================


def get_audio_url(entry):
    for enc in entry.get("enclosures", []):
        href = enc.get("href", "") or enc.get("url", "")
        type_ = enc.get("type", "")
        clean_url = href.lower().split("?")[0]

        if "audio" in type_ or clean_url.endswith(
            (".mp3", ".m4a", ".wav", ".aac", ".ogg", ".opus")
        ):
            return href

    return None


# ============================================================
# 中国免费代理与缓存
# ============================================================


def check_socks_support():
    try:
        import socks  # noqa

        print("   ✅ PySocks 已安装，支持 SOCKS4/SOCKS5")
        return True
    except ImportError:
        print('   ⚠️ 未检测到 PySocks；SOCKS 代理需要 pip install "requests[socks]"')
        return False


def is_socks_proxy(proxy):
    return proxy.lower().startswith(
        ("socks4://", "socks4a://", "socks5://", "socks5h://")
    )


def mark_bad_proxy(proxy):
    with BAD_PROXIES_LOCK:
        BAD_PROXIES.add(proxy)


def is_bad_proxy(proxy):
    with BAD_PROXIES_LOCK:
        return proxy in BAD_PROXIES


def load_proxy_cache():
    if not PROXY_CACHE_FILE.exists():
        return []

    try:
        with open(PROXY_CACHE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)

        if time.time() - data.get("created_at", 0) > PROXY_CACHE_TTL:
            print("   ℹ️ 中国代理缓存已过期")
            return []

        proxies = data.get("proxies", [])
        if not isinstance(proxies, list):
            return []

        print(f"   ♻️ 使用代理缓存：{len(proxies)} 个")
        return proxies

    except Exception as exc:
        print(f"   ⚠️ 读取代理缓存失败：{type(exc).__name__}: {exc}")
        return []


def save_proxy_cache(proxies):
    try:
        with open(PROXY_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(
                {"created_at": time.time(), "proxies": proxies},
                f,
                ensure_ascii=False,
                indent=2,
            )
    except Exception as exc:
        print(f"   ⚠️ 保存代理缓存失败：{type(exc).__name__}: {exc}")


def get_china_proxies():
    cached = load_proxy_cache()
    if cached:
        random.shuffle(cached)
        return cached

    print("🇨🇳 获取中国免费代理列表...")
    all_proxies = []

    for source_name, api_url in PROXY_API_URLS:
        print(f"   📡 来源：{source_name}")

        try:
            response = requests.get(api_url, timeout=30, headers=PROXY_HEADERS)
            response.raise_for_status()
            text = response.text
        except Exception as exc:
            print(f"   ⚠️ {source_name} 获取失败：{type(exc).__name__}: {exc}")
            continue

        count = 0
        for line in text.splitlines():
            line = line.strip().replace(" ", "")
            if not line:
                continue

            if "://" not in line:
                line = "http://" + line

            if not re.match(
                r"^(http|https|socks4|socks4a|socks5|socks5h)://[^:]+:\d+$",
                line,
                re.I,
            ):
                continue

            if line not in all_proxies:
                all_proxies.append(line)
                count += 1

        print(f"      获取 {count} 个")

    random.shuffle(all_proxies)
    print(f"   📦 合计代理：{len(all_proxies)}")

    if all_proxies:
        save_proxy_cache(all_proxies)

    return all_proxies


def get_proxy_geoip(proxy):
    if PROXY_STOP_EVENT.is_set():
        return None

    try:
        response = requests.get(
            GEOIP_URL,
            timeout=PROXY_TEST_TIMEOUT,
            proxies={"http": proxy, "https": proxy},
            headers=PROXY_HEADERS,
        )
        response.raise_for_status()
        data = response.json()

        if not data.get("success", False):
            return None

        return {
            "ip": data.get("ip"),
            "country_code": data.get("country_code"),
            "country": data.get("country"),
        }

    except Exception as exc:
        print(f"   ❌ [{proxy}] GeoIP 失败：{type(exc).__name__}: {exc}")
        return None


# ============================================================
# 音频验证与 SHA256
# ============================================================


def validate_audio_file(path):
    if not path.exists():
        raise RuntimeError("音频文件不存在")

    size = path.stat().st_size
    if size < 1024:
        raise RuntimeError(f"音频文件异常：{size} bytes")

    with open(path, "rb") as f:
        header = f.read(32)

    valid_audio = (
        header.startswith(b"ID3")
        or (len(header) >= 2 and header[0] == 0xFF and (header[1] & 0xE0) == 0xE0)
        or (len(header) >= 12 and header[4:8] == b"ftyp")
        or header.startswith(b"OggS")
    )

    if not valid_audio:
        raise RuntimeError("下载内容不是已识别的音频格式")

    return size


def calculate_sha256(path):
    sha256 = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            sha256.update(chunk)
    return sha256.hexdigest()


# ============================================================
# 单代理完整下载
# ============================================================


def proxy_download_worker(index, total, proxy, audio_url, race_dir, headers):
    if PROXY_STOP_EVENT.is_set() or is_bad_proxy(proxy):
        return {"ok": False, "proxy": proxy, "stopped": True}

    if is_socks_proxy(proxy):
        try:
            import socks  # noqa
        except ImportError:
            mark_bad_proxy(proxy)
            return {"ok": False, "proxy": proxy, "reason": "未安装 PySocks"}

    temp_path = race_dir / (
        f"{index:04d}_{hashlib.md5(proxy.encode()).hexdigest()[:12]}.part"
    )

    try:
        print(f"\n🚀 [{index}/{total}] 开始代理竞速：{proxy}")
        geo = get_proxy_geoip(proxy)

        if PROXY_STOP_EVENT.is_set():
            return {"ok": False, "proxy": proxy, "stopped": True}

        if not geo:
            mark_bad_proxy(proxy)
            return {"ok": False, "proxy": proxy, "reason": "GeoIP 请求失败"}

        public_ip = geo.get("ip")
        country_code = (geo.get("country_code") or "").upper()
        country = geo.get("country") or ""

        print(f"   🌍 [{proxy}] IP={public_ip} Country={country_code}")

        if country_code != "CN":
            mark_bad_proxy(proxy)
            return {
                "ok": False,
                "proxy": proxy,
                "reason": f"不是中国大陆 IP：{country_code}",
            }

        if PROXY_STOP_EVENT.is_set():
            return {"ok": False, "proxy": proxy, "stopped": True}

        total_bytes = 0
        with requests.get(
            audio_url,
            timeout=(AUDIO_CONNECT_TIMEOUT, AUDIO_READ_TIMEOUT),
            headers=headers,
            proxies={"http": proxy, "https": proxy},
            allow_redirects=True,
            stream=True,
        ) as response:
            response.raise_for_status()
            content_type = response.headers.get("Content-Type", "").lower()

            print(f"   📡 [{proxy}] HTTP {response.status_code}")
            print(f"   📦 [{proxy}] Content-Type：{content_type}")
            print(f"   🔗 [{proxy}] 最终 URL：{response.url}")

            if "text/html" in content_type:
                raise RuntimeError("服务器返回 HTML")

            with open(temp_path, "wb") as f:
                for chunk in response.iter_content(chunk_size=DOWNLOAD_CHUNK_SIZE):
                    if PROXY_STOP_EVENT.is_set():
                        return {"ok": False, "proxy": proxy, "stopped": True}
                    if chunk:
                        f.write(chunk)
                        total_bytes += len(chunk)

        if PROXY_STOP_EVENT.is_set():
            return {"ok": False, "proxy": proxy, "stopped": True}

        validate_audio_file(temp_path)
        digest = calculate_sha256(temp_path)

        print(f"   ✅ [{proxy}] 完整下载成功，大小 {total_bytes / 1024 / 1024:.1f} MB")
        print(f"   SHA256：{digest}")

        with PROXY_WINNER_LOCK:
            if PROXY_STOP_EVENT.is_set():
                return {"ok": False, "proxy": proxy, "stopped": True}
            PROXY_STOP_EVENT.set()
            print("\n🏆 找到第一个完整下载成功的中国代理！")

        return {
            "ok": True,
            "proxy": proxy,
            "public_ip": public_ip,
            "country_code": country_code,
            "country": country,
            "temp_path": str(temp_path),
            "size": total_bytes,
            "sha256": digest,
        }

    except Exception as exc:
        mark_bad_proxy(proxy)
        print(f"   ❌ [{proxy}] {type(exc).__name__}: {exc}")
        return {"ok": False, "proxy": proxy, "reason": f"{type(exc).__name__}: {exc}"}


# ============================================================
# 多线程代理竞速
# ============================================================


def download_audio(audio_url, output_path):
    headers = {
        "User-Agent": PROXY_HEADERS["User-Agent"],
        "Accept": "audio/mpeg,audio/*;q=0.9,*/*;q=0.8",
    }

    if not USE_CHINA_PROXY:
        raise RuntimeError("USE_CHINA_PROXY=false：不允许使用 Runner IP 下载")

    proxies = get_china_proxies()
    if not proxies:
        raise RuntimeError("无法获取中国代理，任务终止")

    proxies = proxies[:MAX_PROXY_ATTEMPTS]
    PROXY_STOP_EVENT.clear()

    with BAD_PROXIES_LOCK:
        BAD_PROXIES.clear()

    race_dir = output_path.parent / ".proxy_race"
    race_dir.mkdir(parents=True, exist_ok=True)

    for old_part in race_dir.glob("*.part"):
        try:
            old_part.unlink()
        except Exception:
            pass

    total = len(proxies)
    worker_count = max(1, min(PROXY_WORKERS, total))

    print("\n🏁 代理竞速开始")
    print(f"   RSS enclosure：{audio_url}")
    print(f"   代理总数：{total}")
    print(f"   并发线程：{worker_count}")

    executor = ThreadPoolExecutor(
        max_workers=worker_count, thread_name_prefix="proxy-race"
    )
    pending = set()
    next_index = 0
    winner_result = None
    completed_count = 0

    def submit_next():
        nonlocal next_index

        while next_index < total:
            proxy = proxies[next_index]
            index = next_index + 1
            next_index += 1

            if is_bad_proxy(proxy):
                continue

            return executor.submit(
                proxy_download_worker,
                index,
                total,
                proxy,
                audio_url,
                race_dir,
                headers,
            )

        return None

    try:
        while len(pending) < worker_count:
            future = submit_next()
            if future is None:
                break
            pending.add(future)

        while pending:
            done, pending = wait(pending, return_when=FIRST_COMPLETED)

            for future in done:
                completed_count += 1
                try:
                    result = future.result()
                except Exception as exc:
                    print(f"   ⚠️ Worker 异常：{type(exc).__name__}: {exc}")
                    result = None

                if result and result.get("ok"):
                    winner_result = result
                    PROXY_STOP_EVENT.set()
                    break

            if winner_result:
                print("🛑 Winner 已产生，等待其他代理退出...")
                break

            while len(pending) < worker_count and not PROXY_STOP_EVENT.is_set():
                future = submit_next()
                if future is None:
                    break
                pending.add(future)

            print(f"📊 进度：已完成 {completed_count}/{total}，运行中 {len(pending)}")

    finally:
        PROXY_STOP_EVENT.set()
        executor.shutdown(wait=True, cancel_futures=True)

    print("🧹 所有代理线程已退出")

    if not winner_result:
        for part_file in race_dir.glob("*.part"):
            try:
                part_file.unlink()
            except Exception:
                pass
        try:
            race_dir.rmdir()
        except Exception:
            pass
        raise RuntimeError("所有中国代理均无法下载音频")

    winner_proxy = winner_result["proxy"]
    winner_temp = Path(winner_result["temp_path"])

    if not winner_temp.exists():
        raise RuntimeError("Winner 已产生，但 winner 临时音频不存在")

    if output_path.exists():
        output_path.unlink()

    winner_temp.replace(output_path)

    for part_file in race_dir.glob("*.part"):
        try:
            part_file.unlink()
        except Exception as exc:
            print(f"   ⚠️ 清理临时文件失败：{part_file}: {exc}")

    try:
        race_dir.rmdir()
    except Exception:
        pass

    final_size = validate_audio_file(output_path)
    final_sha256 = calculate_sha256(output_path)

    print("\n✅ 代理竞速完成")
    print(f"   Proxy：{winner_proxy}")
    print(f"   Public IP：{winner_result.get('public_ip')}")
    print(f"   Country：{winner_result.get('country_code')}")
    print(f"   Audio：{output_path}")
    print(f"   Size：{final_size / 1024 / 1024:.1f} MB")
    print(f"   SHA256：{final_sha256}")

    return {
        "proxy": winner_proxy,
        "public_ip": winner_result.get("public_ip"),
        "country_code": winner_result.get("country_code"),
        "country": winner_result.get("country"),
        "sha256": final_sha256,
        "size": final_size,
    }


# ============================================================
# 查找下一集
# ============================================================


def find_next_entry(entries, processed):
    def sort_key(entry):
        published = entry.get("published_parsed") or entry.get("updated_parsed")
        return time.mktime(published) if published else 0

    entries.sort(key=sort_key)

    for entry in entries:
        guid = entry.get("guid") or entry.get("id") or entry.get("title")
        if guid not in processed:
            return entry

    return None


# ============================================================
# 生成播客 RSS 与页面
# ============================================================


def generate_podcast_feed(pc_state):
    print("🔄 生成播客 RSS feed...")

    response = requests.get(FEED_URL, timeout=60, headers={"User-Agent": "Mozilla/5.0"})
    response.raise_for_status()
    root = etree.fromstring(response.content)

    ns_uri = "https://podcastindex.org/namespace/1.0"
    atom_uri = "http://www.w3.org/2005/Atom"
    itunes_uri = "http://www.itunes.com/dtds/podcast-1.0.dtd"

    nsmap = dict(root.nsmap)
    if nsmap.get("podcast") != ns_uri:
        nsmap["podcast"] = ns_uri
        new_root = etree.Element(root.tag, attrib=root.attrib, nsmap=nsmap)
        new_root[:] = root[:]
        new_root.text = root.text
        new_root.tail = root.tail
        root = new_root

    channel = root.find("channel")
    if channel is None:
        print("⚠️ 未找到 channel")
        return

    feed_url = f"{BASE_URL}/{PODCAST_SLUG}/feed.xml"
    title_elem = channel.find("title")

    if title_elem is not None and title_elem.text:
        original_title = title_elem.text.strip()
        if "[Unofficial" not in original_title:
            title_elem.text = f"{original_title} [Unofficial Transcripts]"
            print(f"   RSS 标题：{title_elem.text}")

    link_elem = channel.find("link")
    if link_elem is not None:
        link_elem.text = BASE_URL

    image_elem = channel.find("image")
    if image_elem is not None:
        img_link = image_elem.find("link")
        if img_link is not None:
            img_link.text = BASE_URL
        img_title = image_elem.find("title")
        if img_title is not None and title_elem is not None:
            img_title.text = title_elem.text

    for atom_link in channel.findall(f"{{{atom_uri}}}link"):
        rel = atom_link.get("rel")
        if rel == "self" or rel in ("first", "last", "previous", "next"):
            atom_link.set("href", feed_url)

    new_feed = channel.find(f"{{{itunes_uri}}}new-feed-url")
    if new_feed is not None:
        new_feed.text = feed_url

    processed = pc_state.get("processed", {})
    removed = added = replaced_audio = 0

    for item in channel.findall("item"):
        guid_elem = item.find("guid")

        if guid_elem is None or not guid_elem.text:
            channel.remove(item)
            removed += 1
            continue

        guid = guid_elem.text.strip()
        if guid not in processed:
            channel.remove(item)
            removed += 1
            continue

        episode_state = processed[guid]
        original_url = episode_state.get("enclosure_url")

        if original_url:
            enclosures = item.findall("enclosure")
            if enclosures:
                enclosure = enclosures[0]
                old_url = enclosure.get("url", "")
                if old_url != original_url:
                    enclosure.set("url", original_url)
                    replaced_audio += 1
                    print(f"   🔗 恢复原始 enclosure：{original_url}")

        vtt_filename = episode_state.get("vtt_filename")
        if not vtt_filename:
            continue

        vtt_url = f"{BASE_URL}/{PODCAST_SLUG}/transcripts/{vtt_filename}"
        existing = item.findall(f"{{{ns_uri}}}transcript")

        if any(elem.get("url") == vtt_url for elem in existing):
            continue

        transcript = etree.SubElement(item, f"{{{ns_uri}}}transcript")
        transcript.set("url", vtt_url)
        transcript.set("type", "text/vtt")
        transcript.set("rel", "captions")
        added += 1

    feed_path = PODCAST_DIR / "feed.xml"
    etree.ElementTree(root).write(
        feed_path,
        pretty_print=True,
        xml_declaration=True,
        encoding="utf-8",
    )

    print("💾 Feed 已保存")
    print(f"   保留处理集数：{len(processed)}")
    print(f"   删除未处理集数：{removed}")
    print(f"   新增字幕标签：{added}")
    print(f"   恢复原始 enclosure：{replaced_audio}")
    print(f"   文件：{feed_path}")

    total = pc_state.get("total_processed", 0)
    display_name = f"{PODCAST_SLUG} (Unofficial)"

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{display_name} - Transcripts</title>
<style>
body {{ font-family:system-ui,-apple-system,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6;color:#333; }}
code {{ background:#f4f4f4;padding:2px 6px;border-radius:4px;word-break:break-all; }}
a {{ color:#0366d6; }}
</style>
</head>
<body>
<h1>🎙️ {display_name}</h1>
<p><strong>原 RSS：</strong><a href="{FEED_URL}" target="_blank">{FEED_URL}</a></p>
<p><strong>带字幕 Feed：</strong><br><code><a href="{feed_url}">{feed_url}</a></code></p>
<p>已处理 <strong>{total}</strong> 集（中英双语字幕）。</p>
<p>当前 Feed 只包含已经处理完成的集数。</p>
</body>
</html>
"""
    (PODCAST_DIR / "index.html").write_text(html, encoding="utf-8")


def generate_master_index(state):
    items = ""

    for slug, pc in state.get("podcasts", {}).items():
        total = pc.get("total_processed", 0)
        display_name = f"{slug} (Unofficial)"
        items += (
            f'<li><a href="{BASE_URL}/{slug}/">{display_name}</a> '
            f"— 已处理 {total} 集 "
            f'<small>(<a href="{BASE_URL}/{slug}/feed.xml">Feed</a>)</small></li>\n'
        )

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Podcast Transcripts Hub (Unofficial)</title>
<style>
body {{ font-family:system-ui,-apple-system,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6;color:#333; }}
a {{ color:#0366d6; }}
li {{ margin:8px 0; }}
</style>
</head>
<body>
<h1>🎙️ Podcast Transcripts Hub (Unofficial)</h1>
<p>以下播客均已自动生成中英双语 VTT 字幕。</p>
<ul>
{items}
</ul>
</body>
</html>
"""
    (SITE_DIR / "index.html").write_text(html, encoding="utf-8")


# ============================================================
# 主程序
# ============================================================


def main():
    if not FEED_URL or not BASE_URL or not PODCAST_SLUG:
        print("❌ 错误：需要设置 PODCAST_SLUG、FEED_URL、BASE_URL")
        sys.exit(1)

    print(f"🎙️ 播客：{PODCAST_SLUG}")
    print(f"📡 RSS：{FEED_URL}")
    print(f"🌐 BASE_URL：{BASE_URL}")
    print(f"🧠 模型：{MODEL_SIZE}")
    print(f"🇨🇳 中国代理：{USE_CHINA_PROXY}")
    print(f"🔀 最大代理尝试数：{MAX_PROXY_ATTEMPTS}")
    print(f"🧵 并发线程：{PROXY_WORKERS}")
    print(f"⏱️ GeoIP 超时：{PROXY_TEST_TIMEOUT}s")
    print(f"⏱️ 音频连接超时：{AUDIO_CONNECT_TIMEOUT}s")
    print(f"⏱️ 音频读取超时：{AUDIO_READ_TIMEOUT}s")
    print(f"💾 代理缓存 TTL：{PROXY_CACHE_TTL}s")
    print(f"🌐 翻译批量大小：{TRANSLATE_BATCH_SIZE}")
    print(f"⏱️ 翻译批次间隔：{TRANSLATE_BATCH_DELAY}s")
    print(f"🔁 翻译最大重试：{TRANSLATE_MAX_RETRIES}")

    check_socks_support()

    state = load_state()
    pc_state = get_podcast_state(state)
    processed = pc_state.get("processed", {})

    print(f"📂 该播客已处理 {pc_state.get('total_processed', 0)} 集")

    feed = feedparser.parse(FEED_URL)
    entries = list(feed.entries)

    if not entries:
        print("⚠️ RSS 无条目")
        sys.exit(0)

    next_entry = find_next_entry(entries, processed)

    if not next_entry:
        print("✅ 该播客全部处理完毕")
        print("🔄 仅更新 Feed")
        generate_podcast_feed(pc_state)
        generate_master_index(state)
        save_state(state)
        sys.exit(0)

    title = next_entry.get("title", "untitled")
    guid = next_entry.get("guid") or next_entry.get("id") or title

    print(f"\n🎯 本次处理：{title}")
    print(f"🔑 GUID：{guid}")

    enclosure_url = get_audio_url(next_entry)
    if not enclosure_url:
        print("❌ RSS 中未找到音频 enclosure")
        sys.exit(1)

    print(f"📎 RSS 原始 enclosure：{enclosure_url}")

    audio_url = enclosure_url
    audio_source = "rss_enclosure"
    safe_title = safe_filename(title)
    mp3_path = PODCAST_DIR / f"{safe_title}.mp3"

    try:
        proxy_info = download_audio(audio_url, mp3_path)
    except Exception as exc:
        print(f"\n❌ 音频下载失败：{type(exc).__name__}: {exc}")
        sys.exit(1)

    if not proxy_info:
        print("❌ 未获得有效中国代理信息")
        if mp3_path.exists():
            mp3_path.unlink()
        sys.exit(1)

    print("\n📡 本次下载出口：")
    print(f"   Proxy：{proxy_info.get('proxy')}")
    print(f"   Public IP：{proxy_info.get('public_ip')}")
    print(f"   Country：{proxy_info.get('country_code')}")

    print(f"\n📝 使用实际音频进行转录（{MODEL_SIZE}, CPU int8, VAD）...")

    try:
        model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")

        segments_iter, info = model.transcribe(
            str(mp3_path),
            beam_size=5,
            language="en",
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=300),
            condition_on_previous_text=False,
            initial_prompt="Please punctuate accurately and break sentences naturally.",
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
                        f"   转录进度：{pct:.1f}% "
                        f"({seg.end:.1f}s / {total_duration:.1f}s) | 第 {i} 段"
                    )
                else:
                    print(f"   转录进度：{seg.end:.1f}s | 第 {i} 段")

        print(f"   语言：{info.language} ({info.language_probability:.2f})")
        print(f"   共 {len(segments)} 个片段")

    except Exception as exc:
        print(f"❌ 转录失败：{type(exc).__name__}: {exc}")
        sys.exit(1)

    finally:
        if mp3_path.exists():
            try:
                mp3_path.unlink()
                print(f"🗑️ 已删除临时音频：{mp3_path.name}")
            except Exception as exc:
                print(f"⚠️ 删除临时 MP3 失败：{type(exc).__name__}: {exc}")

    print(f"✂️ 后处理：按句子重新切分 {len(segments)} 个原始片段...")
    sentences = resegment(segments)
    print(f"   合并为 {len(sentences)} 个句子级片段")

    print("🌐 开始翻译（英→中，批量请求、有限重试）...")

    try:
        bilingual = translate_sentences(sentences)
    except Exception as exc:
        print(f"\n❌ 翻译失败：{type(exc).__name__}: {exc}")
        print("   本次不会标记为已处理；稍后重新运行即可重试。")
        sys.exit(1)

    vtt_filename = f"{safe_title}.vtt"
    vtt_path = TRANSCRIPTS_DIR / vtt_filename
    write_bilingual_vtt(bilingual, vtt_path)

    print(f"💾 双语 VTT：{vtt_path.name}")

    # 只有 VTT 成功写出后才更新已处理状态
    processed[guid] = {
        "title": title,
        "vtt_filename": vtt_filename,
        "processed_at": datetime.now(timezone.utc).isoformat(),
        "enclosure_url": enclosure_url,
        "audio_url": audio_url,
        "audio_source": audio_source,
        "proxy": proxy_info.get("proxy"),
        "public_ip": proxy_info.get("public_ip"),
    }

    pc_state["total_processed"] = pc_state.get("total_processed", 0) + 1
    pc_state["updated_at"] = datetime.now(timezone.utc).isoformat()
    save_state(state)

    generate_podcast_feed(pc_state)
    generate_master_index(state)

    print("\n✅ 完成！")
    print(f"   播客：{PODCAST_SLUG}")
    print(f"   累计处理：{pc_state['total_processed']} 集")
    print(f"   Feed：{BASE_URL}/{PODCAST_SLUG}/feed.xml")
    print(f"   Transcript：{BASE_URL}/{PODCAST_SLUG}/transcripts/{vtt_filename}")


if __name__ == "__main__":
    main()
