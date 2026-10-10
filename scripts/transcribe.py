#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""RSS -> 中国代理竞速下载 -> faster-whisper -> Gemini 双语 VTT -> RSS/网站。
兼容新版 state.json，并尽量识别旧版 processed[guid].vtt_filename 记录。
"""

from __future__ import annotations

import hashlib
import html
import json
import logging
import os
import random
import re
import shutil
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

import feedparser
import requests
from lxml import etree
from faster_whisper import WhisperModel
from google import genai
from google.genai import types

# -------------------- 配置 --------------------
PODCAST_SLUG = os.getenv("PODCAST_SLUG", "podcast").strip()
FEED_URL = os.getenv("FEED_URL", "").strip()
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base.en").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash").strip()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
BASE_URL = os.getenv("BASE_URL", "").rstrip("/")
MAX_EPISODES = max(0, int(os.getenv("MAX_EPISODES", "0")))
TRANSLATE_BATCH_SIZE = max(1, int(os.getenv("TRANSLATE_BATCH_SIZE", "20")))
TRANSLATE_BATCH_MAX_CHARS = max(
    500, int(os.getenv("TRANSLATE_BATCH_MAX_CHARS", "9000"))
)
TRANSLATE_MAX_RETRIES = max(0, int(os.getenv("TRANSLATE_MAX_RETRIES", "3")))
TRANSLATE_BASE_DELAY = max(0.1, float(os.getenv("TRANSLATE_BASE_DELAY", "2")))
TRANSLATE_BATCH_DELAY = max(0.0, float(os.getenv("TRANSLATE_BATCH_DELAY", "0.3")))
# Gemini RPM 限速：15 RPM = 每次请求至少间隔 4 秒；所有请求（含重试）共享此限速器。
GEMINI_RPM = max(1, int(os.getenv("GEMINI_RPM", "15")))
GEMINI_REQUEST_INTERVAL = 60.0 / GEMINI_RPM
GEMINI_RATE_LIMIT_LOCK = threading.Lock()
GEMINI_LAST_REQUEST_AT = 0.0
AUDIO_TIMEOUT = max(10, int(os.getenv("AUDIO_TIMEOUT", "60")))
AUDIO_MAX_MB = max(1, int(os.getenv("AUDIO_MAX_MB", "1500")))

USE_CHINA_PROXY = os.getenv("USE_CHINA_PROXY", "true").lower() == "true"
MAX_PROXY_ATTEMPTS = max(1, int(os.getenv("MAX_PROXY_ATTEMPTS", "200")))
PROXY_WORKERS = max(1, int(os.getenv("PROXY_WORKERS", "20")))
PROXY_TEST_TIMEOUT = max(1, int(os.getenv("PROXY_TEST_TIMEOUT", "8")))
AUDIO_CONNECT_TIMEOUT = max(1, int(os.getenv("AUDIO_CONNECT_TIMEOUT", "8")))
AUDIO_READ_TIMEOUT = max(1, int(os.getenv("AUDIO_READ_TIMEOUT", "15")))
DOWNLOAD_CHUNK_SIZE = max(1024, int(os.getenv("DOWNLOAD_CHUNK_SIZE", str(256 * 1024))))
PROXY_CACHE_TTL = max(60, int(os.getenv("PROXY_CACHE_TTL", "1800")))

ROOT_DIR = Path(__file__).resolve().parent.parent
SITE_DIR = ROOT_DIR / "site"
STATE_FILE = ROOT_DIR / "state.json"
PROXY_CACHE_FILE = ROOT_DIR / ".china_proxy_cache.json"
PODCAST_DIR = SITE_DIR / PODCAST_SLUG
TRANSCRIPT_DIR = PODCAST_DIR / "transcripts"
PODCAST_NS = "https://podcastindex.org/namespace/1.0"
USER_AGENT = "PodcastTranscriptBot/1.0 (+https://github.com/)"
PROXY_API_URLS = [
    (
        "ProxyScrape",
        "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text&country=cn",
    )
]
GEOIP_URL = "https://ipwho.is/"
PROXY_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36"
}
BAD_PROXIES: set[str] = set()
BAD_PROXIES_LOCK = threading.Lock()
PROXY_STOP_EVENT = threading.Event()
PROXY_WINNER_LOCK = threading.Lock()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("podcast-transcriber")


# -------------------- 通用工具 / state --------------------
def ensure_directories() -> None:
    TRANSCRIPT_DIR.mkdir(parents=True, exist_ok=True)
    SITE_DIR.mkdir(parents=True, exist_ok=True)


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(value or "").replace("\ufeff", "")).strip()


def safe_filename(value: str, max_length: int = 120) -> str:
    value = html.unescape(value or "").strip()
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value)
    value = re.sub(r"\s+", " ", value).strip(" .")
    return value[:max_length].rstrip(" .") or "untitled"


def stable_id(*parts: str) -> str:
    return hashlib.sha256(
        "\n".join(str(p or "") for p in parts).encode("utf-8")
    ).hexdigest()


def load_state() -> dict[str, Any]:
    if not STATE_FILE.exists():
        return {"version": 1, "podcasts": {}}
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("state.json 根节点不是对象")
        data.setdefault("version", 1)
        data.setdefault("podcasts", {})
        if not isinstance(data["podcasts"], dict):
            raise ValueError("state.json 的 podcasts 不是对象")
        return data
    except Exception as exc:
        raise RuntimeError(
            f"无法读取 {STATE_FILE}，为避免覆盖历史进度已停止：{exc}"
        ) from exc


def save_state(state: dict[str, Any]) -> None:
    tmp = STATE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(STATE_FILE)


def format_timestamp(seconds: float) -> str:
    ms = max(0, int(round(float(seconds) * 1000)))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, milli = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{milli:03d}"


def make_public_url(path: Path) -> str:
    rel = path.relative_to(SITE_DIR).as_posix()
    encoded = "/".join(quote(part) for part in rel.split("/"))
    return f"{BASE_URL}/{encoded}" if BASE_URL else encoded


# -------------------- RSS --------------------
def get_entry_audio_url(entry: Any) -> str:
    for enc in getattr(entry, "enclosures", []) or []:
        href = enc.get("href") or enc.get("url")
        mime = (enc.get("type") or "").lower()
        if href and (
            mime.startswith("audio/")
            or not mime
            or any(
                ext in href.lower().split("?")[0]
                for ext in (
                    ".mp3",
                    ".m4a",
                    ".aac",
                    ".ogg",
                    ".wav",
                    ".opus",
                    ".flac",
                    ".mp4",
                )
            )
        ):
            return href
    for link in getattr(entry, "links", []) or []:
        href, rel, mime = (
            link.get("href"),
            (link.get("rel") or "").lower(),
            (link.get("type") or "").lower(),
        )
        if href and (rel == "enclosure" or mime.startswith("audio/")):
            return href
    return ""


def entry_identity(entry: Any, audio_url: str) -> str:
    guid = clean_text(getattr(entry, "id", "") or getattr(entry, "guid", "") or "")
    if guid:
        return guid
    return stable_id(
        clean_text(getattr(entry, "title", "") or ""),
        audio_url,
        clean_text(getattr(entry, "published", "") or ""),
    )


def get_feed_entries(feed_url: str) -> tuple[Any, list[Any]]:
    log.info("读取 RSS：%s", feed_url)
    parsed = feedparser.parse(feed_url)
    if parsed.bozo and not parsed.entries:
        raise RuntimeError(
            f"RSS 解析失败：{getattr(parsed, 'bozo_exception', '未知错误')}"
        )
    if not parsed.entries:
        raise RuntimeError("RSS 中没有找到节目条目。")
    return parsed, list(parsed.entries)


# -------------------- 代理列表 / 缓存 / GeoIP --------------------
def check_socks_support() -> None:
    try:
        import socks  # noqa: F401

        log.info("PySocks 已安装，支持 SOCKS 代理")
    except ImportError:
        log.warning('未检测到 PySocks；SOCKS 代理需要 pip install "requests[socks]"')


def is_socks_proxy(proxy: str) -> bool:
    return proxy.lower().startswith(
        ("socks4://", "socks4a://", "socks5://", "socks5h://")
    )


def mark_bad_proxy(proxy: str) -> None:
    with BAD_PROXIES_LOCK:
        BAD_PROXIES.add(proxy)


def is_bad_proxy(proxy: str) -> bool:
    with BAD_PROXIES_LOCK:
        return proxy in BAD_PROXIES


def load_proxy_cache() -> list[str]:
    if not PROXY_CACHE_FILE.exists():
        return []
    try:
        data = json.loads(PROXY_CACHE_FILE.read_text(encoding="utf-8"))
        if time.time() - float(data.get("created_at", 0)) > PROXY_CACHE_TTL:
            log.info("中国代理缓存已过期")
            return []
        proxies = data.get("proxies", [])
        if not isinstance(proxies, list):
            return []
        log.info("使用代理缓存：%d 个", len(proxies))
        random.shuffle(proxies)
        return proxies
    except Exception as exc:
        log.warning("读取代理缓存失败：%s", exc)
        return []


def save_proxy_cache(proxies: list[str]) -> None:
    try:
        PROXY_CACHE_FILE.write_text(
            json.dumps(
                {"created_at": time.time(), "proxies": proxies},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
    except Exception as exc:
        log.warning("保存代理缓存失败：%s", exc)


def get_china_proxies() -> list[str]:
    cached = load_proxy_cache()
    if cached:
        return cached
    log.info("获取中国免费代理列表")
    all_proxies: list[str] = []
    for source_name, api_url in PROXY_API_URLS:
        try:
            response = requests.get(api_url, timeout=30, headers=PROXY_HEADERS)
            response.raise_for_status()
            count = 0
            for raw in response.text.splitlines():
                line = raw.strip().replace(" ", "")
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
            log.info("代理来源 %s：获取 %d 个", source_name, count)
        except Exception as exc:
            log.warning("代理来源 %s 获取失败：%s", source_name, exc)
    random.shuffle(all_proxies)
    log.info("代理列表合计：%d 个", len(all_proxies))
    if all_proxies:
        save_proxy_cache(all_proxies)
    return all_proxies


def get_proxy_geoip(proxy: str) -> dict[str, Any] | None:
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
        log.debug("代理 GeoIP 失败 %s：%s", proxy, exc)
        return None


# -------------------- 音频校验 / 代理竞速下载 --------------------
def validate_audio_file(path: Path) -> int:
    if not path.exists():
        raise RuntimeError("音频文件不存在")
    size = path.stat().st_size
    if size < 1024:
        raise RuntimeError(f"音频文件异常：{size} bytes")
    with path.open("rb") as f:
        header = f.read(32)
    valid = (
        header.startswith(b"ID3")
        or (len(header) >= 2 and header[0] == 0xFF and (header[1] & 0xE0) == 0xE0)
        or (len(header) >= 12 and header[4:8] == b"ftyp")
        or header.startswith(b"OggS")
        or header.startswith(b"RIFF")
        or header.startswith(b"fLaC")
        or header.startswith(b"FORM")
    )
    if not valid:
        raise RuntimeError("下载内容不是已识别的音频格式")
    if size > AUDIO_MAX_MB * 1024 * 1024:
        raise RuntimeError(f"音频超过 {AUDIO_MAX_MB} MB 限制")
    return size


def calculate_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def proxy_download_worker(
    index: int,
    total: int,
    proxy: str,
    audio_url: str,
    race_dir: Path,
    headers: dict[str, str],
) -> dict[str, Any]:
    if PROXY_STOP_EVENT.is_set() or is_bad_proxy(proxy):
        return {"ok": False, "proxy": proxy, "stopped": True}
    if is_socks_proxy(proxy):
        try:
            import socks  # noqa: F401
        except ImportError:
            mark_bad_proxy(proxy)
            return {"ok": False, "proxy": proxy, "reason": "未安装 PySocks"}
    temp_path = (
        race_dir / f"{index:04d}_{hashlib.md5(proxy.encode()).hexdigest()[:12]}.part"
    )
    try:
        log.info("[%d/%d] 代理竞速启动：%s", index, total, proxy)
        geo = get_proxy_geoip(proxy)
        if PROXY_STOP_EVENT.is_set():
            return {"ok": False, "proxy": proxy, "stopped": True}
        if not geo:
            mark_bad_proxy(proxy)
            return {"ok": False, "proxy": proxy, "reason": "GeoIP 请求失败"}
        country_code = (geo.get("country_code") or "").upper()
        if country_code != "CN":
            mark_bad_proxy(proxy)
            return {
                "ok": False,
                "proxy": proxy,
                "reason": f"不是中国大陆 IP：{country_code}",
            }
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
            content_type = (response.headers.get("Content-Type") or "").lower()
            if "text/html" in content_type:
                raise RuntimeError("服务器返回 HTML 而非音频")
            content_length = response.headers.get("Content-Length")
            if content_length and int(content_length) > AUDIO_MAX_MB * 1024 * 1024:
                raise RuntimeError(f"音频 Content-Length 超过 {AUDIO_MAX_MB} MB")
            with temp_path.open("wb") as out:
                for chunk in response.iter_content(chunk_size=DOWNLOAD_CHUNK_SIZE):
                    if PROXY_STOP_EVENT.is_set():
                        return {"ok": False, "proxy": proxy, "stopped": True}
                    if not chunk:
                        continue
                    total_bytes += len(chunk)
                    if total_bytes > AUDIO_MAX_MB * 1024 * 1024:
                        raise RuntimeError(f"下载超过 {AUDIO_MAX_MB} MB 限制")
                    out.write(chunk)
        if PROXY_STOP_EVENT.is_set():
            return {"ok": False, "proxy": proxy, "stopped": True}
        validate_audio_file(temp_path)
        digest = calculate_sha256(temp_path)
        result = {
            "ok": True,
            "proxy": proxy,
            "public_ip": geo.get("ip"),
            "country_code": country_code,
            "country": geo.get("country"),
            "temp_path": str(temp_path),
            "size": total_bytes,
            "sha256": digest,
        }
        with PROXY_WINNER_LOCK:
            if PROXY_STOP_EVENT.is_set():
                return {"ok": False, "proxy": proxy, "stopped": True}
            PROXY_STOP_EVENT.set()
            log.info("代理竞速胜出：%s（%.1f MB）", proxy, total_bytes / 1024 / 1024)
        return result
    except Exception as exc:
        mark_bad_proxy(proxy)
        log.warning("代理下载失败 %s：%s: %s", proxy, type(exc).__name__, exc)
        try:
            temp_path.unlink(missing_ok=True)
        except Exception:
            pass
        return {"ok": False, "proxy": proxy, "reason": f"{type(exc).__name__}: {exc}"}


def download_audio(url: str, output_path: Path) -> dict[str, Any]:
    """严格沿用旧逻辑：只用经 GeoIP 确认的中国代理竞速，不自动直连回退。"""
    if not url:
        raise ValueError("节目没有音频 enclosure URL")
    if not USE_CHINA_PROXY:
        raise RuntimeError(
            "USE_CHINA_PROXY=false：按旧版策略，不允许使用 Runner IP 直连下载"
        )
    check_socks_support()
    proxies = get_china_proxies()[:MAX_PROXY_ATTEMPTS]
    if not proxies:
        raise RuntimeError("无法获取中国代理，任务终止")
    PROXY_STOP_EVENT.clear()
    with BAD_PROXIES_LOCK:
        BAD_PROXIES.clear()
    race_dir = output_path.parent / ".proxy_race"
    race_dir.mkdir(parents=True, exist_ok=True)
    for part in race_dir.glob("*.part"):
        try:
            part.unlink()
        except OSError:
            pass
    headers = {
        "User-Agent": PROXY_HEADERS["User-Agent"],
        "Accept": "audio/mpeg,audio/*;q=0.9,*/*;q=0.8",
    }
    total = len(proxies)
    workers = max(1, min(PROXY_WORKERS, total))
    log.info(
        "代理竞速开始：代理数=%d，并发=%d，最大音频=%d MB", total, workers, AUDIO_MAX_MB
    )
    executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="proxy-race")
    pending = set()
    next_index = 0
    winner = None

    def submit_next():
        nonlocal next_index
        while next_index < total:
            proxy = proxies[next_index]
            idx = next_index + 1
            next_index += 1
            if is_bad_proxy(proxy):
                continue
            return executor.submit(
                proxy_download_worker, idx, total, proxy, url, race_dir, headers
            )
        return None

    try:
        while len(pending) < workers:
            future = submit_next()
            if future is None:
                break
            pending.add(future)
        while pending:
            done, pending = wait(pending, return_when=FIRST_COMPLETED)
            for future in done:
                try:
                    result = future.result()
                except Exception as exc:
                    log.warning("代理 worker 异常：%s", exc)
                    result = None
                if result and result.get("ok"):
                    winner = result
                    PROXY_STOP_EVENT.set()
                    break
            if winner:
                break
            while len(pending) < workers and not PROXY_STOP_EVENT.is_set():
                future = submit_next()
                if future is None:
                    break
                pending.add(future)
    finally:
        PROXY_STOP_EVENT.set()
        executor.shutdown(wait=True, cancel_futures=True)
    if not winner:
        shutil.rmtree(race_dir, ignore_errors=True)
        raise RuntimeError("所有中国代理均无法下载音频")
    winner_path = Path(winner["temp_path"])
    if not winner_path.exists():
        shutil.rmtree(race_dir, ignore_errors=True)
        raise RuntimeError("代理竞速已选出 Winner，但临时音频不存在")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(winner_path, output_path)
    final_size = validate_audio_file(output_path)
    final_hash = calculate_sha256(output_path)
    shutil.rmtree(race_dir, ignore_errors=True)
    log.info(
        "代理下载成功：proxy=%s, ip=%s, country=%s, size=%.1f MB, SHA256=%s",
        winner.get("proxy"),
        winner.get("public_ip"),
        winner.get("country_code"),
        final_size / 1024 / 1024,
        final_hash,
    )
    return {
        "proxy": winner.get("proxy"),
        "public_ip": winner.get("public_ip"),
        "country_code": winner.get("country_code"),
        "country": winner.get("country"),
        "sha256": final_hash,
        "size": final_size,
    }


# -------------------- Whisper / 切句 --------------------
def split_into_sentences(text: str) -> list[str]:
    text = clean_text(text)
    if not text:
        return []
    abbreviations = {
        "Mr.": "Mr<DOT>",
        "Mrs.": "Mrs<DOT>",
        "Ms.": "Ms<DOT>",
        "Dr.": "Dr<DOT>",
        "Prof.": "Prof<DOT>",
        "St.": "St<DOT>",
        "vs.": "vs<DOT>",
        "e.g.": "e<DOT>g<DOT>",
        "i.e.": "i<DOT>e<DOT>",
    }
    protected = text
    for old, new in abbreviations.items():
        protected = re.sub(re.escape(old), new, protected, flags=re.I)
    return [
        p.replace("<DOT>", ".").strip()
        for p in re.split(r"(?<=[.!?])\s+", protected)
        if p.strip()
    ]


def resegment_whisper_segments(
    segments: list[dict[str, Any]], max_chars: int = 180
) -> list[dict[str, Any]]:
    cues = []
    for segment in segments:
        sentences = split_into_sentences(segment["text"])
        expanded = []
        for sentence in sentences:
            if len(sentence) <= max_chars:
                expanded.append(sentence)
                continue
            current = ""
            for part in re.split(r"(?<=[,;:])\s+", sentence):
                if not current:
                    current = part
                elif len(current) + 1 + len(part) <= max_chars:
                    current += " " + part
                else:
                    expanded.append(current.strip())
                    current = part
            if current.strip():
                expanded.append(current.strip())
        if not expanded:
            continue
        start, end = float(segment["start"]), float(segment["end"])
        duration = max(0.05, end - start)
        weights = [max(1, len(s)) for s in expanded]
        total = sum(weights)
        cursor = start
        for i, sentence in enumerate(expanded):
            cue_end = (
                end
                if i == len(expanded) - 1
                else cursor + duration * weights[i] / total
            )
            cue_end = max(cursor + 0.05, min(cue_end, end))
            cues.append({"start": cursor, "end": cue_end, "en": sentence, "zh": ""})
            cursor = cue_end
    previous_end = 0.0
    for cue in cues:
        cue["start"] = max(previous_end, float(cue["start"]))
        cue["end"] = max(cue["start"] + 0.05, float(cue["end"]))
        previous_end = cue["end"]
    return cues


def whisper_transcribe(audio_path: Path) -> list[dict[str, Any]]:
    log.info("加载 Whisper 模型：%s", WHISPER_MODEL)
    model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        str(audio_path),
        language="en",
        task="transcribe",
        beam_size=5,
        vad_filter=True,
        condition_on_previous_text=True,
    )
    log.info(
        "开始转录：language=%s，预计时长=%.1f 秒",
        getattr(info, "language", "unknown"),
        getattr(info, "duration", 0.0) or 0.0,
    )
    raw = []
    for seg in segments:
        text = clean_text(seg.text)
        if text:
            raw.append(
                {
                    "start": max(0.0, float(seg.start)),
                    "end": max(float(seg.start) + 0.05, float(seg.end)),
                    "text": text,
                }
            )
    if not raw:
        raise RuntimeError("Whisper 没有识别到任何语音内容")
    cues = resegment_whisper_segments(raw)
    log.info("转录完成：%d 条英文字幕", len(cues))
    return cues


# -------------------- Gemini 翻译 --------------------
def create_gemini_client() -> genai.Client:
    if not GEMINI_API_KEY:
        raise RuntimeError("缺少 GEMINI_API_KEY")
    return genai.Client(api_key=GEMINI_API_KEY)


def build_translation_batches(cues: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    batches = []
    current = []
    chars = 0
    for cue in cues:
        n = len(cue["en"])
        if current and (
            len(current) >= TRANSLATE_BATCH_SIZE
            or chars + n > TRANSLATE_BATCH_MAX_CHARS
        ):
            batches.append(current)
            current = []
            chars = 0
        current.append(cue)
        chars += n
    if current:
        batches.append(current)
    return batches


def parse_json_array(text: str) -> list[Any]:
    text = (text or "").strip()
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.I)
    text = re.sub(r"\s*```$", "", text)
    try:
        value = json.loads(text)
        if isinstance(value, list):
            return value
    except json.JSONDecodeError:
        pass
    start, end = text.find("["), text.rfind("]")
    if start >= 0 and end > start:
        value = json.loads(text[start : end + 1])
        if isinstance(value, list):
            return value
    raise ValueError("Gemini 没有返回有效 JSON 数组")


def wait_for_gemini_rate_limit() -> None:
    """全局串行限速 Gemini 请求，确保请求启动间隔不小于 60/RPM 秒。"""
    global GEMINI_LAST_REQUEST_AT
    with GEMINI_RATE_LIMIT_LOCK:
        now = time.monotonic()
        wait_seconds = GEMINI_REQUEST_INTERVAL - (now - GEMINI_LAST_REQUEST_AT)
        if wait_seconds > 0:
            log.info(
                "Gemini RPM 限速：等待 %.2f 秒（目标 %d RPM）", wait_seconds, GEMINI_RPM
            )
            time.sleep(wait_seconds)
        GEMINI_LAST_REQUEST_AT = time.monotonic()


def translate_batch_once(client: genai.Client, cues: list[dict[str, Any]]) -> list[str]:
    source = [c["en"] for c in cues]
    prompt = (
        "你是一名专业的英译简体中文字幕译者。请将 JSON 数组里的英文字幕逐条翻译为自然、准确、易读的简体中文。\n"
        "要求：严格按原顺序逐条翻译，一条英文对应一条中文；返回数量必须相同；不可合并、拆分、漏译或额外增加条目；保留姓名、专有名词、数字、语气、幽默和上下文；不要解释或添加译者注；只返回 JSON 字符串数组。\n待翻译字幕：\n"
        + json.dumps(source, ensure_ascii=False)
    )
    wait_for_gemini_rate_limit()
    response = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            temperature=0.2, response_mime_type="application/json"
        ),
    )
    translated = parse_json_array(response.text or "")
    if len(translated) != len(source):
        raise ValueError(
            f"字幕数量不匹配：输入 {len(source)} 条，返回 {len(translated)} 条"
        )
    cleaned = []
    for i, item in enumerate(translated):
        if not isinstance(item, str):
            raise ValueError(f"第 {i+1} 条翻译不是字符串")
        item = clean_text(item)
        if not item:
            raise ValueError(f"第 {i+1} 条翻译为空")
        if len(source[i]) >= 18 and item == source[i]:
            raise ValueError(f"第 {i+1} 条疑似未翻译")
        cleaned.append(item)
    return cleaned


def translate_batch_recursive(client: genai.Client, cues: list[dict[str, Any]]) -> None:
    last_error = None
    for attempt in range(TRANSLATE_MAX_RETRIES + 1):
        try:
            translated = translate_batch_once(client, cues)
            for cue, zh in zip(cues, translated):
                cue["zh"] = zh
            return
        except Exception as exc:
            last_error = exc
            if attempt < TRANSLATE_MAX_RETRIES:
                delay = min(60.0, TRANSLATE_BASE_DELAY * (2**attempt))
                log.warning(
                    "Gemini 批次失败（%d/%d）：%s；%.1f 秒后重试",
                    attempt + 1,
                    TRANSLATE_MAX_RETRIES + 1,
                    exc,
                    delay,
                )
                time.sleep(delay)
    if len(cues) > 1:
        mid = len(cues) // 2
        log.warning("批次重试仍失败，拆分为 %d 与 %d 条", mid, len(cues) - mid)
        translate_batch_recursive(client, cues[:mid])
        if TRANSLATE_BATCH_DELAY:
            time.sleep(TRANSLATE_BATCH_DELAY)
        translate_batch_recursive(client, cues[mid:])
        return
    raise RuntimeError(
        f"单条字幕翻译最终失败：{cues[0].get('en', '')[:160]!r}；错误：{last_error}"
    ) from last_error


def translate_cues_with_gemini(cues: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not cues:
        raise ValueError("没有可翻译字幕")
    client = create_gemini_client()
    batches = build_translation_batches(cues)
    log.info(
        "Gemini 翻译开始：%d 条字幕，%d 个初始批次，模型=%s，限速=%d RPM（请求间隔至少 %.2f 秒）",
        len(cues),
        len(batches),
        GEMINI_MODEL,
        GEMINI_RPM,
        GEMINI_REQUEST_INTERVAL,
    )
    for i, batch in enumerate(batches, 1):
        log.info("翻译批次 %d/%d：%d 条", i, len(batches), len(batch))
        translate_batch_recursive(client, batch)
        if TRANSLATE_BATCH_DELAY and i < len(batches):
            time.sleep(TRANSLATE_BATCH_DELAY)
    if any(not c.get("zh") for c in cues):
        raise RuntimeError("翻译不完整，存在缺失中文的字幕")
    return cues


def write_bilingual_vtt(cues: list[dict[str, Any]], output_path: Path) -> None:
    if not cues:
        raise ValueError("没有字幕，拒绝写出空 VTT")
    blocks = ["WEBVTT", ""]
    for i, cue in enumerate(cues, 1):
        en, zh = clean_text(cue.get("en", "")), clean_text(cue.get("zh", ""))
        if not en or not zh:
            raise RuntimeError(f"第 {i} 条字幕缺少英文或中文")
        if float(cue["end"]) <= float(cue["start"]):
            raise RuntimeError(f"第 {i} 条字幕时间无效")
        blocks.extend(
            [
                str(i),
                f"{format_timestamp(cue['start'])} --> {format_timestamp(cue['end'])}",
                en,
                zh,
                "",
            ]
        )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = output_path.with_suffix(output_path.suffix + ".tmp")
    tmp.write_text("\n".join(blocks).rstrip() + "\n", encoding="utf-8")
    tmp.replace(output_path)
    log.info("已写出双语 VTT：%s", output_path)


def is_valid_bilingual_vtt(path: Path) -> bool:
    try:
        content = path.read_text(encoding="utf-8-sig").strip()
    except (OSError, UnicodeError):
        return False
    if not content.startswith("WEBVTT"):
        return False
    blocks = re.split(r"\n\s*\n", content)
    count = 0
    for block in blocks[1:]:
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        idx = next((i for i, line in enumerate(lines) if "-->" in line), None)
        if idx is None:
            continue
        if len(lines[idx + 1 :]) < 2 or not lines[idx + 1] or not lines[idx + 2]:
            return False
        count += 1
    return count > 0


# -------------------- 增强 RSS / HTML --------------------
def find_item_guid(item: etree._Element) -> str:
    guid = item.find("guid")
    if guid is not None and guid.text:
        return guid.text.strip()
    link = item.find("link")
    return link.text.strip() if link is not None and link.text else ""


def find_feed_item(
    root: etree._Element, identity: str, title: str
) -> etree._Element | None:
    for item in root.xpath("//*[local-name()='item']"):
        guid = find_item_guid(item)
        item_title = item.findtext("title") or ""
        if identity and guid == identity:
            return item
        if title and item_title.strip() == title.strip():
            return item
    return None


def add_transcript_tag(item: etree._Element, url: str) -> None:
    tag = f"{{{PODCAST_NS}}}transcript"
    for old in item.findall(tag):
        if old.get("url") == url:
            return
    node = etree.SubElement(item, tag)
    node.set("url", url)
    node.set("type", "text/vtt")
    node.set("language", "zh-CN")
    node.set("rel", "captions")


def make_enhanced_feed(feed_url: str, records: list[dict[str, str]]) -> Path:
    response = requests.get(
        feed_url, headers={"User-Agent": USER_AGENT}, timeout=(20, AUDIO_TIMEOUT)
    )
    response.raise_for_status()
    parser = etree.XMLParser(
        recover=True, remove_blank_text=False, resolve_entities=False, no_network=True
    )
    root = etree.fromstring(response.content, parser=parser)
    if root is None:
        raise RuntimeError("无法解析原始 RSS XML")
    for record in records:
        item = find_feed_item(root, record.get("identity", ""), record.get("title", ""))
        if item is None:
            log.warning("增强 RSS 时未匹配到条目：%s", record.get("title", ""))
            continue
        add_transcript_tag(item, record["url"])
    path = PODCAST_DIR / "feed.xml"
    path.parent.mkdir(parents=True, exist_ok=True)
    etree.ElementTree(root).write(
        str(path), encoding="utf-8", xml_declaration=True, pretty_print=True
    )
    log.info("增强 RSS 已生成：%s", path)
    return path


def escape_html(value: str) -> str:
    return html.escape(value or "", quote=True)


def build_podcast_index(
    title: str, feed_url: str, records: list[dict[str, str]]
) -> Path:
    rows = []
    for item in sorted(records, key=lambda x: x.get("published", ""), reverse=True):
        rows.append(
            f'<li><a href="{escape_html(item.get("url", ""))}">{escape_html(item.get("title", "Untitled"))}</a><small>{escape_html(item.get("published", ""))}</small></li>'
        )
    base = BASE_URL or ""
    enhanced = f"{base}/{PODCAST_SLUG}/feed.xml"
    page = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{escape_html(title)} · 双语字幕</title><style>:root{{color-scheme:light dark}}body{{max-width:900px;margin:2rem auto;padding:0 1rem;font:16px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif}}h1{{line-height:1.25}}a{{overflow-wrap:anywhere}}li{{margin:.9rem 0}}small{{display:block;opacity:.7}}</style></head><body><h1>{escape_html(title)}</h1><p>英文原文与简体中文译文合并显示的 WebVTT 字幕。</p><nav><a href="{escape_html(enhanced)}">增强版 RSS Feed</a> · <a href="{escape_html(feed_url)}">原始 RSS Feed</a></nav><h2>已生成字幕</h2><ul>{''.join(rows) if rows else '<li>暂无字幕。</li>'}</ul></body></html>"""
    path = PODCAST_DIR / "index.html"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(page, encoding="utf-8")
    return path


def rebuild_root_index() -> None:
    links = []
    if SITE_DIR.exists():
        for index_file in sorted(SITE_DIR.glob("*/index.html")):
            slug = index_file.parent.name
            if slug != "assets":
                links.append(
                    f'<li><a href="{escape_html(slug)}/index.html">{escape_html(slug)}</a></li>'
                )
    page = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Podcast Transcript Library</title><style>body{{max-width:900px;margin:2rem auto;padding:0 1rem;font:16px/1.7 system-ui,sans-serif}}li{{margin:.7rem 0}}</style></head><body><h1>Podcast Transcript Library</h1><p>自动生成的播客字幕目录。</p><ul>{''.join(links)}</ul></body></html>"""
    (SITE_DIR / "index.html").write_text(page, encoding="utf-8")


# -------------------- 单集与旧 state 兼容 --------------------
def get_existing_path(
    identity: str, processed: dict[str, Any], records: dict[str, dict[str, str]]
) -> Path | None:
    rec = records.get(identity)
    if rec and rec.get("path"):
        return SITE_DIR / rec["path"]
    old = processed.get(identity, {})
    if isinstance(old, dict):
        if old.get("path"):
            return SITE_DIR / old["path"]
        if old.get("vtt_filename"):
            return TRANSCRIPT_DIR / old["vtt_filename"]
    return None


def process_episode(
    entry: Any, identity: str, audio_url: str
) -> tuple[dict[str, str], dict[str, Any]]:
    title = clean_text(getattr(entry, "title", "") or "Untitled episode")
    published = clean_text(
        getattr(entry, "published", "") or getattr(entry, "updated", "") or ""
    )
    filename = safe_filename(title)
    transcript_path = TRANSCRIPT_DIR / f"{filename}.vtt"
    if transcript_path.exists() and is_valid_bilingual_vtt(transcript_path):
        log.info("完整双语字幕已存在，复用：%s", transcript_path)
        record = {
            "identity": identity,
            "title": title,
            "published": published,
            "url": make_public_url(transcript_path),
            "path": transcript_path.relative_to(SITE_DIR).as_posix(),
        }
        return record, {
            "proxy": None,
            "public_ip": None,
            "country_code": None,
            "sha256": None,
            "size": transcript_path.stat().st_size,
        }
    suffix = Path(urlparse(audio_url).path).suffix.lower()
    if suffix not in {".mp3", ".m4a", ".aac", ".wav", ".ogg", ".opus", ".flac", ".mp4"}:
        suffix = ".audio"
    with tempfile.TemporaryDirectory(prefix="podcast-audio-") as temp_dir:
        audio_path = Path(temp_dir) / f"episode{suffix}"
        proxy_info = download_audio(audio_url, audio_path)
        cues = whisper_transcribe(audio_path)
    cues = translate_cues_with_gemini(cues)
    if any(not c.get("en") or not c.get("zh") for c in cues):
        raise RuntimeError("字幕校验失败：存在空的英文或中文条目")
    write_bilingual_vtt(cues, transcript_path)
    record = {
        "identity": identity,
        "title": title,
        "published": published,
        "url": make_public_url(transcript_path),
        "path": transcript_path.relative_to(SITE_DIR).as_posix(),
    }
    return record, proxy_info


def migrate_legacy_records(
    podcast_state: dict[str, Any], processed: dict[str, Any]
) -> dict[str, dict[str, str]]:
    records: dict[str, dict[str, str]] = {}
    for record in podcast_state.get("transcripts", []) or []:
        if isinstance(record, dict) and record.get("identity"):
            records[record["identity"]] = record
    # 旧版 state 只有 processed[guid].vtt_filename，没有 transcripts 数组。
    for identity, item in processed.items():
        if identity in records or not isinstance(item, dict):
            continue
        vtt_filename = item.get("vtt_filename")
        if vtt_filename:
            path = TRANSCRIPT_DIR / vtt_filename
            records[identity] = {
                "identity": identity,
                "title": item.get("title", path.stem),
                "published": item.get("published", ""),
                "url": make_public_url(path),
                "path": path.relative_to(SITE_DIR).as_posix(),
            }
        elif item.get("path"):
            path = SITE_DIR / item["path"]
            records[identity] = {
                "identity": identity,
                "title": item.get("title", path.stem),
                "published": item.get("published", ""),
                "url": item.get("url") or make_public_url(path),
                "path": item["path"],
            }
    return records


# -------------------- 主流程 --------------------
def main() -> int:
    if not FEED_URL:
        log.error("缺少 FEED_URL 环境变量")
        return 2
    if not GEMINI_API_KEY:
        log.error("缺少 GEMINI_API_KEY 环境变量")
        return 2
    if not PODCAST_SLUG:
        log.error("缺少 PODCAST_SLUG 环境变量")
        return 2
    ensure_directories()
    state = load_state()
    podcasts = state.setdefault("podcasts", {})
    ps = podcasts.setdefault(
        PODCAST_SLUG, {"feed_url": FEED_URL, "processed": {}, "transcripts": []}
    )
    ps["feed_url"] = FEED_URL
    processed = ps.setdefault("processed", {})
    if not isinstance(processed, dict):
        raise RuntimeError("state.json 中 processed 不是对象，停止以避免覆盖历史记录")
    parsed, entries = get_feed_entries(FEED_URL)
    feed_title = clean_text(getattr(parsed.feed, "title", "") or PODCAST_SLUG)
    candidates = []
    for entry in entries:
        audio_url = get_entry_audio_url(entry)
        if audio_url:
            candidates.append((entry, entry_identity(entry, audio_url), audio_url))
    if MAX_EPISODES:
        candidates = candidates[:MAX_EPISODES]
    log.info(
        "播客：%s；RSS 条目：%d；可处理音频条目：%d",
        feed_title,
        len(entries),
        len(candidates),
    )
    records = migrate_legacy_records(ps, processed)
    completed_this_run = 0
    failed_count = 0
    for number, (entry, identity, audio_url) in enumerate(candidates, 1):
        title = clean_text(getattr(entry, "title", "") or "Untitled episode")
        log.info("处理节目 %d/%d：%s", number, len(candidates), title)
        old_path = get_existing_path(identity, processed, records)
        old_record = records.get(identity)
        if (
            processed.get(identity)
            and old_path
            and old_path.exists()
            and is_valid_bilingual_vtt(old_path)
        ):
            log.info("已处理且双语字幕文件有效，跳过：%s", title)
            if old_record:
                records[identity] = old_record
            else:
                records[identity] = {
                    "identity": identity,
                    "title": title,
                    "published": clean_text(
                        getattr(entry, "published", "")
                        or getattr(entry, "updated", "")
                        or ""
                    ),
                    "url": make_public_url(old_path),
                    "path": old_path.relative_to(SITE_DIR).as_posix(),
                }
            completed_this_run += 1
            continue
        try:
            record, proxy_info = process_episode(entry, identity, audio_url)
            processed[identity] = {
                "title": record["title"],
                "url": record["url"],
                "path": record["path"],
                "completed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "audio_url": audio_url,
                "model": WHISPER_MODEL,
                "translation_model": GEMINI_MODEL,
                "proxy": proxy_info.get("proxy"),
                "public_ip": proxy_info.get("public_ip"),
                "country_code": proxy_info.get("country_code"),
                "sha256": proxy_info.get("sha256"),
            }
            records[identity] = record
            completed_this_run += 1
            ps["transcripts"] = list(records.values())
            podcasts[PODCAST_SLUG] = ps
            state["podcasts"] = podcasts
            save_state(state)
            log.info("节目处理成功：%s", title)
        except Exception:
            failed_count += 1
            log.exception("节目处理失败：%s；不会标记为已完成，下次运行可重试", title)
    ps["transcripts"] = list(records.values())
    ps["last_run"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    ps["feed_url"] = FEED_URL
    ps["feed_title"] = feed_title
    # 兼容旧字段，不把已有计数清零；total_processed 以 processed 的历史条目数为下限。
    ps["total_processed"] = max(int(ps.get("total_processed", 0) or 0), len(processed))
    ps["updated_at"] = ps["last_run"]
    podcasts[PODCAST_SLUG] = ps
    state["podcasts"] = podcasts
    save_state(state)
    try:
        make_enhanced_feed(FEED_URL, list(records.values()))
    except Exception:
        log.exception("增强 RSS 生成失败；字幕文件和 state.json 已保留")
    build_podcast_index(feed_title, FEED_URL, list(records.values()))
    rebuild_root_index()
    log.info(
        "运行结束：本次成功或跳过 %d 集；失败 %d 集", completed_this_run, failed_count
    )
    return 1 if failed_count else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log.error("收到中断信号")
        sys.exit(130)
    except Exception as exc:
        log.exception("脚本执行失败：%s", exc)
        sys.exit(1)
