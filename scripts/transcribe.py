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
import math
import os
import random
import re
import shutil
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from datetime import timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable
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
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite").strip()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_API_KEYS_RAW = os.getenv("GEMINI_API_KEYS", "").strip()


def parse_gemini_keys(raw: str) -> list[str]:
    keys: list[str] = []
    for part in re.split(r"[,\s]+", raw or ""):
        key = part.strip()
        if key and key not in keys:
            keys.append(key)
    return keys


GEMINI_KEYS = parse_gemini_keys(GEMINI_API_KEYS_RAW) or (
    [GEMINI_API_KEY] if GEMINI_API_KEY else []
)


class QuotaExhausted(RuntimeError):
    """所有 Gemini key 都用尽；调用方应停止本轮、下轮再续。"""


class GeminiKeyRing:
    """顺序轮换 key：同一时刻只用一把，耗尽就切下一把，全部耗尽即不可用。

    轮换状态只活在进程内——配额按天重置，跨轮沿用会把恢复的 key 永久排除。
    """

    def __init__(self, keys: list[str], factory=None):
        if not keys:
            raise QuotaExhausted("没有任何可用的 Gemini key")
        self._keys = list(keys)
        self._clients: dict[str, Any] = {}
        self._index = 0
        self._factory = factory or (lambda api_key: genai.Client(api_key=api_key))
        self.requests = 0

    @property
    def available(self) -> bool:
        return self._index < len(self._keys)

    def label(self) -> str:
        if not self.available:
            return "#-（…****）"
        key = self._keys[self._index]
        tail = key[-4:] if len(key) > 4 else "****"
        return f"#{self._index + 1}（…{tail}）"

    def current(self) -> str:
        if not self.available:
            raise QuotaExhausted("所有 Gemini key 都已耗尽")
        return self._keys[self._index]

    def client(self):
        if not self.available:
            raise QuotaExhausted("所有 Gemini key 都已耗尽")
        key = self._keys[self._index]
        if key not in self._clients:
            self._clients[key] = self._factory(api_key=key)
        return self._clients[key]

    def mark_exhausted(self) -> bool:
        self._index += 1
        return self.available


BASE_URL = os.getenv("BASE_URL", "").rstrip("/")
MAX_EPISODES = max(0, int(os.getenv("MAX_EPISODES", "0")))
TRANSLATE_BATCH_SIZE = max(1, int(os.getenv("TRANSLATE_BATCH_SIZE", "50")))
TRANSLATE_BATCH_MAX_CHARS = max(
    500, int(os.getenv("TRANSLATE_BATCH_MAX_CHARS", "16000"))
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
TIMING_DIR = PODCAST_DIR / "timings"
# 回填任务把 sidecar 当断点：同一集最多尝试这么多次就放弃
BACKFILL_MAX_ATTEMPTS = 2
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
    level=getattr(
        logging, os.environ.get("LOG_LEVEL", "INFO").strip().upper(), logging.INFO
    ),
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


def atomic_write_text(path: Path, content: str) -> None:
    """Write a text file atomically; used for generated HTML pages."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


def snapshot_file_bytes(path: Path) -> bytes | None:
    """失败回滚用的快照；文件不存在或不可读时返回 None，调用方跳过恢复。"""
    try:
        return path.read_bytes()
    except OSError:
        return None


def restore_file_bytes(path: Path, data: bytes) -> None:
    """把快照原子写回（.tmp + replace），与写出路径保持同一套原子语义。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)


CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")


def published_sort_key(value: str) -> float:
    """Sort RFC-822 dates correctly; fall back to 0 for legacy/odd values."""
    try:
        parsed = parsedate_to_datetime(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except Exception:
        return 0.0


def format_timestamp(seconds: float) -> str:
    ms = max(0, int(round(float(seconds) * 1000)))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, milli = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{milli:03d}"


def make_public_url(path: Path) -> str:
    rel = path.relative_to(SITE_DIR).as_posix()
    encoded = "/".join(quote(part, safe="-._~") for part in rel.split("/"))
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
        log.debug("[%d/%d] 代理竞速启动：%s", index, total, proxy)
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
            log.debug("代理竞速胜出：%s（%.1f MB）", proxy, total_bytes / 1024 / 1024)
        return result
    except Exception as exc:
        mark_bad_proxy(proxy)
        log.debug("代理下载失败 %s：%s: %s", proxy, type(exc).__name__, exc)
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
    with BAD_PROXIES_LOCK:
        bad_count = len(BAD_PROXIES)
    if not winner:
        shutil.rmtree(race_dir, ignore_errors=True)
        raise RuntimeError(
            f"所有中国代理均无法下载音频：已尝试 {next_index}/{total} 个，失败 {bad_count} 个"
        )
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
        "代理下载成功：尝试 %d/%d 个（失败 %d），proxy=%s, ip=%s, country=%s, size=%.1f MB, SHA256=%s",
        next_index,
        total,
        bad_count,
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
        measured = measured_cue_times(expanded, segment.get("words") or [])
        cursor = start
        for i, sentence in enumerate(expanded):
            if measured is not None:
                cue_start, cue_end, words = measured[i]
            else:
                cue_end = (
                    end
                    if i == len(expanded) - 1
                    else cursor + duration * weights[i] / total
                )
                cue_start, words = cursor, []
            cue_end = max(cue_start + 0.05, min(cue_end, end))
            cue = {"start": cue_start, "end": cue_end, "en": sentence, "zh": ""}
            if words:
                cue["words"] = words
            cues.append(cue)
            cursor = cue_end
    previous_end = 0.0
    for cue in cues:
        cue["start"] = max(previous_end, float(cue["start"]))
        cue["end"] = max(cue["start"] + 0.05, float(cue["end"]))
        previous_end = cue["end"]
    return cues


def merge_continuation_words(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Whisper 会把 Whim-Yim、example.com 切成两个 token；续接段并回前一个词。"""
    merged: list[dict[str, Any]] = []
    for word in words:
        text = str(word["w"])
        if merged and text[:1] in ("-", "."):
            previous = merged[-1]
            merged[-1] = {
                "w": previous["w"] + text,
                "s": previous["s"],
                "e": word["e"],
            }
            continue
        merged.append({"w": text, "s": word["s"], "e": word["e"]})
    return merged


def split_words_proportionally(
    cue_texts: list[str], words: list[dict[str, Any]]
) -> list[list[dict[str, Any]]] | None:
    """词数与文本 token 数对不上时，按各 cue 的字符占比分词，保证每个 cue 至少一个词。"""
    total_chars = sum(len(text) for text in cue_texts)
    if total_chars == 0 or len(words) < len(cue_texts):
        return None
    chunks: list[list[dict[str, Any]]] = []
    cursor = 0
    consumed = 0
    for index, text in enumerate(cue_texts):
        consumed += len(text)
        remaining_cues = len(cue_texts) - index - 1
        if remaining_cues == 0:
            end = len(words)
        else:
            end = round(len(words) * consumed / total_chars)
            end = min(max(end, cursor + 1), len(words) - remaining_cues)
        chunks.append(words[cursor:end])
        cursor = end
    if cursor != len(words):
        return None
    return chunks


def measured_cue_times(
    cue_texts: list[str], words: list[dict[str, Any]]
) -> list[tuple[float, float, list[dict[str, Any]]]] | None:
    """按词的顺序把 Whisper 词时间分配到切好的 cue 上；词时间不可信就返回 None 让调用方估算。

    Whisper 的词切分与文本 token 数并不总一致（连字符、域名后缀），先合并续接词；
    仍然对不齐时按字符比例分词，宁可差一个词的边界，也不让整条 cue 丢掉词级时间。
    """
    words = merge_continuation_words(words or [])
    if not words:
        return None
    counts = [len(text.split()) for text in cue_texts]
    if sum(counts) == len(words):
        chunks: list[list[dict[str, Any]]] = []
        cursor = 0
        for count in counts:
            chunks.append(words[cursor : cursor + count])
            cursor += count
    else:
        chunks = split_words_proportionally(cue_texts, words)
        if chunks is None:
            return None
    result = []
    for chunk in chunks:
        if not chunk:
            return None
        first, last = float(chunk[0]["s"]), float(chunk[-1]["e"])
        if last <= first:
            return None
        result.append((first, last, chunk))
    for earlier, later in zip(result, result[1:]):
        if later[0] < earlier[0]:
            return None
    return result



def whisper_transcribe(audio_path: Path) -> tuple[list[dict[str, Any]], float]:
    log.info("加载 Whisper 模型：%s", WHISPER_MODEL)
    threads = int(os.getenv("WHISPER_THREADS", "0")) or (os.cpu_count() or 1)
    model = WhisperModel(
        WHISPER_MODEL, device="cpu", compute_type="int8", cpu_threads=threads
    )
    segments, info = model.transcribe(
        str(audio_path),
        language="en",
        task="transcribe",
        beam_size=5,
        vad_filter=True,
        condition_on_previous_text=True,
        word_timestamps=True,
    )
    log.info(
        "开始转录：language=%s，预计时长=%.1f 秒，cpu_threads=%d",
        getattr(info, "language", "unknown"),
        getattr(info, "duration", 0.0) or 0.0,
        threads,
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
                    "words": [
                        {"w": word.word.strip(), "s": float(word.start), "e": float(word.end)}
                        for word in (seg.words or [])
                        if word.word.strip()
                    ],
                }
            )
    if not raw:
        raise RuntimeError("Whisper 没有识别到任何语音内容")
    cues = resegment_whisper_segments(raw)
    log.info("转录完成：%d 条英文字幕", len(cues))
    return cues, round(getattr(info, "duration", 0.0) or 0.0, 2)


# -------------------- Gemini 翻译 --------------------
def is_quota_error(exc: Exception) -> bool:
    text = f"{exc}".upper()
    code = getattr(exc, "code", None) or getattr(exc, "status_code", None)
    return (
        code in (429, "429", "RESOURCE_EXHAUSTED")
        or "RESOURCE_EXHAUSTED" in text
        or "QUOTA" in text
    )


def is_auth_error(exc: Exception) -> bool:
    text = f"{exc}".upper()
    code = getattr(exc, "code", None) or getattr(exc, "status_code", None)
    if "API_KEY_INVALID" in text or "API KEY NOT VALID" in text:
        return True
    # Google 对无效 key 返回 400 INVALID_ARGUMENT（而非 401/403），
    # 消息里带 "API key not valid"；只靠状态码会让坏 key 走完退避重试。
    if code in (400, "400") and ("API KEY" in text or "API_KEY" in text):
        return True
    return code in (401, 403, "401", "403", "PERMISSION_DENIED", "UNAUTHENTICATED")


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


TRANSLATE_SCHEMA_MAX_BLOCKS = 60


class IncompleteTranslation(Exception):
    """模型漏译或合并了条目：带着已经拿到的译文抛出，重试只补差的编号。"""

    def __init__(self, message: str, partial: dict[int, str]):
        super().__init__(message)
        self.partial = partial


def build_translation_prompt(blocks: list[tuple[int, dict[str, Any]]]) -> str:
    payload = {str(index): cue["en"] for index, cue in blocks}
    return (
        "你是一名专业的英译简体中文字幕译者。下面的 JSON 对象把每条英文字幕绑定到一个编号，"
        "请逐条翻译成自然、准确、易读的简体中文。\n"
        "要求：只返回一个 JSON 对象，键必须与输入的编号完全一致，一个不多一个不少；"
        "每个键的值只放对应那一条的中文译文；编号只是标识，不要写进译文；"
        "即使多条英文完全相同或极短（例如连续的 Yeah.、Right.），也必须逐条独立返回，"
        "不可合并、拆分、漏译或改变顺序；键的先后顺序随意，但不能漏键；"
        "保留姓名、专有名词、数字、语气、幽默和上下文；不要解释或添加译者注。\n"
        f"待翻译字幕：\n{json.dumps(payload, ensure_ascii=False)}"
    )


def build_translation_schema(keys: list[int]) -> dict[str, Any]:
    properties = {str(key): {"type": "string"} for key in keys}
    return {"type": "object", "properties": properties, "required": list(properties)}


def parse_translation_object(text: str, source: dict[int, str]) -> dict[int, str]:
    """按编号配对，绝不按返回顺序配对——顺序一乱，整批中英就全串位。"""
    raw = (text or "").strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.I)
    raw = re.sub(r"\s*```$", "", raw)
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end <= start:
        raise IncompleteTranslation("Gemini 没有返回 JSON 对象", {})

    class JSONObjectPairs(list):
        pass

    try:
        data = json.loads(raw[start : end + 1], object_pairs_hook=JSONObjectPairs)
    except json.JSONDecodeError as exc:
        raise IncompleteTranslation(f"Gemini 返回的 JSON 无法解析：{exc}", {}) from exc
    if not isinstance(data, JSONObjectPairs):
        raise IncompleteTranslation("Gemini 返回的根节点不是对象", {})

    result: dict[int, str] = {}
    problems: list[str] = []
    for key, item in data:
        try:
            index = int(key)
        except (TypeError, ValueError):
            problems.append(f"非法编号 {key!r}")
            continue
        if index not in source:
            problems.append(f"多出编号 {index}")
            continue
        if index in result:
            problems.append(f"编号 {index} 重复")
            continue
        if not isinstance(item, str):
            problems.append(f"编号 {index} 的译文不是字符串")
            continue
        zh = clean_text(item)
        if not zh:
            problems.append(f"编号 {index} 译文为空")
            continue
        if len(source[index]) >= 18 and zh == source[index]:
            problems.append(f"编号 {index} 疑似未翻译")
            continue
        result[index] = zh

    missing = [index for index in sorted(source) if index not in result]
    if missing or problems:
        detail = f"输入 {len(source)} 条，有效返回 {len(result)} 条"
        if missing:
            detail += f"；缺失编号 {missing[:8]}" + ("…" if len(missing) > 8 else "")
        if problems:
            detail += f"；异常 {'; '.join(problems[:5])}"
        raise IncompleteTranslation("字幕未对齐：" + detail, result)
    return result


def wait_for_gemini_rate_limit() -> None:
    """全局串行限速 Gemini 请求，确保请求启动间隔不小于 60/RPM 秒。"""
    global GEMINI_LAST_REQUEST_AT
    with GEMINI_RATE_LIMIT_LOCK:
        now = time.monotonic()
        wait_seconds = GEMINI_REQUEST_INTERVAL - (now - GEMINI_LAST_REQUEST_AT)
        if wait_seconds > 0:
            log.debug(
                "Gemini RPM 限速：等待 %.2f 秒（目标 %d RPM）", wait_seconds, GEMINI_RPM
            )
            time.sleep(wait_seconds)
        GEMINI_LAST_REQUEST_AT = time.monotonic()


def translate_batch_once(
    client: genai.Client, blocks: list[tuple[int, dict[str, Any]]]
) -> dict[int, str]:
    source = {index: cue["en"] for index, cue in blocks}
    keys = sorted(source)
    config_args: dict[str, Any] = {
        "temperature": 0.2,
        "response_mime_type": "application/json",
    }
    if len(keys) <= TRANSLATE_SCHEMA_MAX_BLOCKS:
        config_args["response_schema"] = build_translation_schema(keys)
    wait_for_gemini_rate_limit()
    response = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=build_translation_prompt(blocks),
        config=types.GenerateContentConfig(**config_args),
    )
    return parse_translation_object(response.text or "", source)


def translate_blocks(
    ring: GeminiKeyRing,
    blocks: list[tuple[int, dict[str, Any]]],
    translated: dict[int, str],
) -> None:
    pending = [pair for pair in blocks if pair[0] not in translated]
    if not pending:
        return
    attempt = 0
    last_error: Exception | None = None
    while pending:
        try:
            ring.requests += 1
            translated.update(translate_batch_once(ring.client(), pending))
            return
        except QuotaExhausted:
            raise
        except Exception as exc:
            last_error = exc
            if is_quota_error(exc) or is_auth_error(exc):
                # 配额/鉴权错误不消耗退避重试次数：换 key 后立刻重试同一批。
                kind = "配额耗尽" if is_quota_error(exc) else "key 无效"
                before = ring.label()
                if not ring.mark_exhausted():
                    raise QuotaExhausted(
                        f"{kind}，所有 key 已用尽（本进程已发 {ring.requests} 次请求）"
                    ) from exc
                log.warning("Gemini key %s %s，切到 %s", before, kind, ring.label())
                continue
            if isinstance(exc, IncompleteTranslation):
                translated.update(exc.partial)
                pending = [pair for pair in pending if pair[0] not in translated]
                if not pending:
                    return
            if attempt < TRANSLATE_MAX_RETRIES:
                delay = min(60.0, TRANSLATE_BASE_DELAY * (2**attempt))
                log.warning(
                    "Gemini 批次失败（%d/%d）：%s；%.1f 秒后只补 %d 条",
                    attempt + 1,
                    TRANSLATE_MAX_RETRIES + 1,
                    exc,
                    delay,
                    len(pending),
                )
                time.sleep(delay)
                attempt += 1
                continue
            if len(pending) > 1:
                half = len(pending) // 2
                log.warning("批次重试仍失败，拆分为 %d 与 %d 条", half, len(pending) - half)
                translate_blocks(ring, pending[:half], translated)
                if TRANSLATE_BATCH_DELAY:
                    time.sleep(TRANSLATE_BATCH_DELAY)
                translate_blocks(ring, pending[half:], translated)
                return
            raise RuntimeError(
                f"单条字幕翻译最终失败：{pending[0][1].get('en', '')[:160]!r}"
            ) from last_error


def translate_cues_with_gemini(cues: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not cues:
        raise ValueError("没有可翻译字幕")
    ring = GeminiKeyRing(GEMINI_KEYS)
    batches = build_translation_batches(cues)
    log.info(
        "Gemini 翻译开始：%d 条字幕，%d 个初始批次，模型=%s，key=%d 把，限速=%d RPM（请求间隔至少 %.2f 秒）",
        len(cues),
        len(batches),
        GEMINI_MODEL,
        len(GEMINI_KEYS),
        GEMINI_RPM,
        GEMINI_REQUEST_INTERVAL,
    )
    for i, batch in enumerate(batches, 1):
        log.info("翻译批次 %d/%d：%d 条", i, len(batches), len(batch))
        translated: dict[int, str] = {}
        translate_blocks(ring, list(enumerate(batch)), translated)
        for index, cue in enumerate(batch):
            cue["zh"] = translated[index]
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


def write_word_timings(
    cues: list[dict[str, Any]],
    output_path: Path,
    audio_seconds: float,
    complete: bool = True,
    attempts: int = 1,
) -> None:
    """按 TMLT 的 sidecar 结构写出逐词时间轴；没有词的 cue 把 end 置空，由消费方回退到 VTT。

    ``complete`` / ``attempts`` 让 sidecar 兼作回填断点：失败时用
    ``write_sidecar_failure`` 写下未完成记录，下次运行据此跳过或重试。
    """
    if not cues:
        raise ValueError("没有字幕，拒绝写出空的逐词时间轴")
    segments = []
    for cue in cues:
        start_ms = int(round(float(cue["start"]) * 1000))
        cue_end_ms = int(round(float(cue["end"]) * 1000))
        words = []
        for word in cue.get("words") or []:
            word_start = int(round(float(word["s"]) * 1000))
            word_end = int(round(float(word["e"]) * 1000))
            words.append(
                [clean_text(word["w"]), word_start, max(0, word_end - word_start)]
            )
        if not words:
            end_ms = None
        elif float(cue["words"][-1]["e"]) <= float(cue["words"][-1]["s"]):
            end_ms = cue_end_ms
        else:
            end_ms = int(round(float(cue["words"][-1]["e"]) * 1000))
        segments.append(
            {
                "start": start_ms,
                "end": end_ms,
                "speaker": None,
                "text": clean_text(cue.get("en", "")),
                "words": words,
            }
        )
    document = {
        "episode": output_path.stem,
        "audio_seconds": round(float(audio_seconds), 2),
        "complete": complete,
        "attempts": attempts,
        "segments": segments,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = output_path.with_suffix(output_path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(document, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    tmp.replace(output_path)
    log.info(
        "已写出逐词时间轴：%s（%d 段，%d 词）",
        output_path,
        len(segments),
        sum(len(segment["words"]) for segment in segments),
    )


def sidecar_path_for(vtt_path: Path) -> Path:
    """双语 VTT 对应的逐词时间轴 sidecar 路径。"""
    return TIMING_DIR / f"{vtt_path.stem}.json"


def sidecar_status(path: Path) -> tuple[bool, int]:
    """返回 (complete, attempts)；缺失或损坏一律按未完成、0 次处理。

    attempts 只接受 JSON 整数（缺失算 0）；字符串、数组、对象、布尔等
    不可表示的值一律按未开始处理，绝不让单个坏文件打断整批扫描。
    """
    if not path.exists():
        return False, 0
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return False, 0
    if not isinstance(document, dict):
        return False, 0
    attempts = document.get("attempts")
    if attempts is None:
        attempts = 0
    if isinstance(attempts, bool) or not isinstance(attempts, int):
        return False, 0
    return document.get("complete") is True, attempts


def write_sidecar_failure(path: Path, attempts: int) -> None:
    """写下未完成的 sidecar 作为回填断点，保留 segments 空表以免消费方误读。"""
    document = {
        "episode": path.stem,
        "audio_seconds": 0.0,
        "complete": False,
        "attempts": attempts,
        "segments": [],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(document, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    tmp.replace(path)
    log.warning("逐词时间轴未完成：%s（第 %d 次尝试）", path, attempts)


MIN_BILINGUAL_RATIO = 0.8


def is_valid_bilingual_vtt(path: Path) -> bool:
    """Accept an already-generated bilingual VTT without re-transcribing it.

    A few historical files contain one or two untranslated cues, so requiring
    every cue to be bilingual would trigger expensive re-downloads.  An
    English-only file still has a ratio of zero and is rejected.
    """
    try:
        content = path.read_text(encoding="utf-8-sig").strip()
    except (OSError, UnicodeError):
        return False
    if not content.startswith("WEBVTT"):
        return False
    total = bilingual = 0
    for block in re.split(r"\n\s*\n", content)[1:]:
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        idx = next((i for i, line in enumerate(lines) if "-->" in line), None)
        if idx is None:
            continue
        total += 1
        text_lines = lines[idx + 1 :]
        if len(text_lines) >= 2 and any(
            CJK_RE.search(line) for line in text_lines[1:]
        ):
            bilingual += 1
    return total > 0 and bilingual / total >= MIN_BILINGUAL_RATIO


# -------------------- 回填分片与候选筛选 --------------------
def shard_of(identity: str, shards: int) -> int:
    """把一集稳定地分到某个分片。

    用 sha1 而不是内置 hash()：后者每个进程加盐，跨进程会漂移导致同一集
    被两个分片重复处理或被漏掉。
    """
    digest = hashlib.sha1(identity.encode("utf-8")).hexdigest()
    return int(digest, 16) % max(1, shards)


def needs_backfill(vtt_path: Path, sidecar_path: Path) -> bool:
    """只有「有效双语 VTT 且 sidecar 未完成、且尝试次数未达上限」才要回填。"""
    if not vtt_path.exists() or not is_valid_bilingual_vtt(vtt_path):
        return False
    complete, attempts = sidecar_status(sidecar_path)
    return not complete and attempts < BACKFILL_MAX_ATTEMPTS


def backfill_env() -> dict[str, Any] | None:
    """回填模式由环境变量开启；三个变量都为空才是正常模式。

    分片数量和预算只在回填模式里解析：正常模式不该因为一个残留的
    BACKFILL_SHARDS 拼写错误而整轮启动失败。

    但「设了分片数/预算、却缺分片号」必须报错而不是退回正常模式：
    那种情况多半是 CI 矩阵漏传 BACKFILL_SHARD，悄悄跑正常路径会写
    state/feed/index，正好是回填要避免的共享状态互相覆盖。
    """
    raw_shard = os.getenv("BACKFILL_SHARD", "").strip()
    raw_shards = os.getenv("BACKFILL_SHARDS", "").strip()
    raw_minutes = os.getenv("BACKFILL_MAX_MINUTES", "").strip()
    if not raw_shard:
        if raw_shards or raw_minutes:
            raise ValueError(
                "缺少 BACKFILL_SHARD：已设置 BACKFILL_SHARDS/BACKFILL_MAX_MINUTES，"
                "但分片回填必须同时提供有效的 BACKFILL_SHARD"
            )
        return None
    shard = int(raw_shard)
    shards = int(raw_shards or 20)
    max_minutes = float(raw_minutes or 280)
    if shards < 1 or not 0 <= shard < shards:
        raise ValueError(f"分片配置非法：shard={shard} shards={shards}")
    if not math.isfinite(max_minutes) or max_minutes <= 0:
        raise ValueError(f"预算非法：{max_minutes} 分钟（必须是有限正数）")
    return {"shard": shard, "shards": shards, "max_minutes": max_minutes}


def build_backfill_candidates(entries, records) -> list[dict[str, Any]]:
    """把 feed 条目与现有记录 join 成待回填清单（identity/title/audio_url/vtt_path）。

    每条 vtt_path 只保留 feed 顺序里第一个候选：旧状态经 migrate_legacy_records
    后可能让两个 identity 共用一条 path，二者会落到不同分片却写同一份 sidecar。
    """
    candidates = []
    seen_paths: set[Path] = set()
    for entry in entries:
        audio_url = get_entry_audio_url(entry)
        if not audio_url:
            continue
        identity = entry_identity(entry, audio_url)
        record = records.get(identity)
        if not record or not record.get("path"):
            continue
        vtt_path = SITE_DIR / record["path"]
        if vtt_path in seen_paths:
            continue
        seen_paths.add(vtt_path)
        if not needs_backfill(vtt_path, sidecar_path_for(vtt_path)):
            continue
        candidates.append(
            {
                "identity": identity,
                "title": record.get("title") or "",
                "audio_url": audio_url,
                "vtt_path": vtt_path,
            }
        )
    return candidates


def process_backfill_item(item: dict[str, Any]) -> None:
    """按 state 里既有的 VTT 路径重转一集；失败记账由 run_backfill 统一处理。

    ``output_path`` 必须显式传给 process_episode：多数既有文件名与标题推导名
    不一致，按标题推导会另写一份新文件，旧文件永远拿不到 sidecar。
    ``process_episode`` 回报的路径一旦与候选不一致就抛错，不把「写到别处」
    当成成功。
    """
    entry = SimpleNamespace(
        title=item["title"], published="", id=item["identity"], guid=item["identity"]
    )
    record, _ = process_episode(
        entry,
        item["identity"],
        item["audio_url"],
        path_owner=None,
        force=True,
        output_path=item["vtt_path"],
    )
    if (SITE_DIR / record["path"]) != item["vtt_path"]:
        # 产出写到别处却报成功，比这一集失败更糟：抛错让 run_backfill 记 failed。
        raise RuntimeError(
            f"回填产出路径与预期不一致：{item['vtt_path']} → {record['path']}"
        )


def run_backfill(
    candidates: list[dict[str, Any]],
    shard: int,
    shards: int,
    max_minutes: float,
    process: Callable[[dict[str, Any]], None] | None = None,
    clock: Callable[[], float] | None = None,
) -> dict[str, Any]:
    """回填一个分片：预算用完即停；配额耗尽干净退出；单集失败不影响其它集。"""
    process = process or process_backfill_item
    clock = clock or time.monotonic
    deadline = clock() + max_minutes * 60
    stats = {"done": 0, "failed": 0, "skipped": 0, "quota": False}
    for item in candidates:
        if shard_of(item["identity"], shards) != shard:
            stats["skipped"] += 1
            continue
        if clock() >= deadline:
            log.info("分片 %d 预算用完，已完成 %d 集", shard, stats["done"])
            break
        try:
            process(item)
        except QuotaExhausted:
            log.info("Gemini 配额耗尽，分片 %d 停下：本轮完成 %d 集", shard, stats["done"])
            stats["quota"] = True
            break
        except Exception:
            stats["failed"] += 1
            log.exception("回填失败（下轮重试）：%s", item.get("title", ""))
            continue
        stats["done"] += 1
        log.info("回填完成 %d 集：%s", stats["done"], item.get("title", "")[:70])
    return stats


# -------------------- 增强 RSS / HTML --------------------
def find_item_guid(item: etree._Element) -> str:
    guid = item.xpath("./*[local-name()='guid']")
    if guid and guid[0].text:
        return guid[0].text.strip()
    link = item.xpath("./*[local-name()='link']")
    return link[0].text.strip() if link and link[0].text else ""


def find_feed_item(
    root: etree._Element, identity: str, title: str
) -> etree._Element | None:
    for item in root.xpath("//*[local-name()='item']"):
        guid = find_item_guid(item)
        titles = item.xpath("./*[local-name()='title']")
        item_title = titles[0].text if titles and titles[0].text else ""
        if identity and guid == identity:
            return item
        if title and item_title.strip() == title.strip():
            return item
    return None


def remove_project_transcript_tags(root: etree._Element) -> int:
    """Drop transcript links owned by this project before rebuilding the feed.

    Keeps external transcript tags untouched while making repeated runs
    idempotent when a transcript file or URL was renamed.
    """
    removed = 0
    nodes = root.xpath(
        "//*[local-name()='item']/*[local-name()='transcript' and namespace-uri()=$ns]",
        ns=PODCAST_NS,
    )
    for node in nodes:
        if "/transcripts/" in (node.get("url") or ""):
            parent = node.getparent()
            if parent is not None:
                parent.remove(node)
                removed += 1
    return removed


def add_transcript_tag(item: etree._Element, url: str) -> None:
    """添加 Podcasting 2.0 transcript 标签；重复运行不会重复添加相同 URL。"""
    tag = f"{{{PODCAST_NS}}}transcript"
    found = None
    for old in list(item.findall(tag)):
        old_url = old.get("url") or ""
        if old_url == url:
            if found is None:
                found = old
            else:
                item.remove(old)
            continue
        # Remove stale project links (e.g. an episode was renamed); keep
        # third-party transcript links untouched.
        if "/transcripts/" in old_url:
            item.remove(old)

    if found is not None:
        found.set("type", "text/vtt")
        found.set("language", "zh-CN")
        found.set("rel", "captions")
        return

    node = etree.SubElement(item, tag)
    node.set("url", url)
    node.set("type", "text/vtt")
    node.set("language", "zh-CN")
    node.set("rel", "captions")


def ensure_podcast_namespace_prefix(root: etree._Element) -> etree._Element:
    """确保 RSS 根节点声明 podcast 前缀，使新写入的标签序列化为 podcast:transcript。

    lxml 对已解析 XML 中的 namespace prefix 会保留原有声明；仅调用
    register_namespace() 不足以可靠地重命名已有节点。因此在修改条目前，
    用同一标签、属性和内容重建根节点，并将 podcast 命名空间放到根节点 nsmap。
    子节点会被原样移动，RSS 内容与元数据不变。
    """
    nsmap = dict(root.nsmap or {})
    if nsmap.get("podcast") == PODCAST_NS:
        return root

    nsmap["podcast"] = PODCAST_NS
    replacement = etree.Element(root.tag, nsmap=nsmap)
    for key, value in root.attrib.items():
        replacement.set(key, value)
    replacement.text = root.text
    replacement.tail = root.tail
    for child in list(root):
        replacement.append(child)
    return replacement


def make_enhanced_feed(feed_url: str, records: list[dict[str, str]]) -> Path:
    """复制原始 RSS、添加双语字幕链接，并修正增强版 Feed 的自我声明地址。

    保留原始单集 GUID、音频 enclosure 和其他节目元数据；不把增强版重定向回官方 Feed。
    """
    if not feed_url:
        raise ValueError("FEED_URL 未设置，无法生成增强版 RSS")

    response = requests.get(
        feed_url,
        headers={"User-Agent": USER_AGENT},
        timeout=(20, AUDIO_TIMEOUT),
    )
    response.raise_for_status()

    parser = etree.XMLParser(
        recover=True,
        remove_blank_text=False,
        resolve_entities=False,
        no_network=True,
    )
    root = etree.fromstring(response.content, parser=parser)
    if root is None:
        raise RuntimeError("无法解析原始 RSS XML")

    # 在添加 transcript 节点之前固定命名空间前缀，避免 lxml 自动生成 ns115 等前缀。
    root = ensure_podcast_namespace_prefix(root)

    # 确保这是 RSS 2.0 文档且包含 channel。
    channels = root.xpath("/*[local-name()='rss']/*[local-name()='channel']")
    if not channels:
        raise RuntimeError("原始 XML 中找不到 RSS 2.0 channel 节点")
    channel = channels[0]

    # 1. 为匹配到的每一集添加 Podcasting 2.0 双语字幕链接。先清掉本项目
    # 旧链接，避免改标题/改文件名后同一集残留多个 transcript 标签。
    stale_removed = remove_project_transcript_tags(channel)
    if stale_removed:
        log.info("已清理旧字幕链接：%d 个", stale_removed)

    matched = 0
    for record in records:
        item = find_feed_item(
            root,
            record.get("identity", ""),
            record.get("title", ""),
        )
        if item is None:
            log.warning("增强 RSS 时未匹配到条目：%s", record.get("title", ""))
            continue
        transcript_url = record.get("url", "").strip()
        if not transcript_url:
            log.warning("字幕 URL 为空，跳过：%s", record.get("title", ""))
            continue
        add_transcript_tag(item, transcript_url)
        matched += 1

    # 2. 计算公开地址。要求 BASE_URL 指向 GitHub Pages 项目根目录，
    # 例如 https://lzoreal.github.io/MyTranscript，而不是仓库主页之外的地址。
    path = PODCAST_DIR / "feed.xml"
    path.parent.mkdir(parents=True, exist_ok=True)
    enhanced_url = make_public_url(path)

    # 3. 将 Atom self 链接统一指向增强版 Feed。
    atom_ns = "http://www.w3.org/2005/Atom"
    self_links = root.xpath(
        "//*[local-name()='link' and namespace-uri()=$ns and @rel='self']",
        ns=atom_ns,
    )
    if self_links:
        self_link = self_links[0]
        self_link.set("href", enhanced_url)
        self_link.set("type", "application/rss+xml")
        for duplicate in self_links[1:]:
            parent = duplicate.getparent()
            if parent is not None:
                parent.remove(duplicate)
    else:
        etree.SubElement(
            channel,
            f"{{{atom_ns}}}link",
            {
                "type": "application/rss+xml",
                "rel": "self",
                "href": enhanced_url,
            },
        )

    # 4. 如果官方 Feed 带有 iTunes new-feed-url，避免它将客户端引导回官方地址。
    itunes_ns = "http://www.itunes.com/dtds/podcast-1.0.dtd"
    new_feed_nodes = root.xpath(
        "//*[local-name()='new-feed-url' and namespace-uri()=$ns]",
        ns=itunes_ns,
    )
    for node in new_feed_nodes:
        node.text = enhanced_url

    # 5. 原子写入，避免中断时留下不完整的 feed.xml。
    temp_path = path.with_name(path.name + ".tmp")
    try:
        etree.ElementTree(root).write(
            str(temp_path),
            encoding="utf-8",
            xml_declaration=True,
            pretty_print=True,
        )
        temp_path.replace(path)
    finally:
        temp_path.unlink(missing_ok=True)

    log.info("增强 RSS 已生成：%s → %s", path, enhanced_url)
    log.info(
        "字幕链接条目：%d/%d；Atom self 修正 %d 处；new-feed-url 修正 %d 处",
        matched,
        len(records),
        len(self_links) or 1,
        len(new_feed_nodes),
    )
    return path


def escape_html(value: str) -> str:
    return html.escape(value or "", quote=True)


def build_podcast_index(
    title: str, feed_url: str, records: list[dict[str, str]]
) -> Path:
    rows = []
    for item in sorted(
        records, key=lambda x: published_sort_key(x.get("published", "")), reverse=True
    ):
        rows.append(
            f'<li><a href="{escape_html(item.get("url", ""))}">{escape_html(item.get("title", "Untitled"))}</a><small>{escape_html(item.get("published", ""))}</small></li>'
        )
    base = BASE_URL or ""
    enhanced = f"{base}/{quote(PODCAST_SLUG, safe='-._~')}/feed.xml"
    page = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{escape_html(title)} · 双语字幕</title><style>:root{{color-scheme:light dark}}body{{max-width:900px;margin:2rem auto;padding:0 1rem;font:16px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif}}h1{{line-height:1.25}}a{{overflow-wrap:anywhere}}li{{margin:.9rem 0}}small{{display:block;opacity:.7}}</style></head><body><h1>{escape_html(title)}</h1><p>英文原文与简体中文译文合并显示的 WebVTT 字幕。</p><nav><a href="{escape_html(enhanced)}">增强版 RSS Feed</a> · <a href="{escape_html(feed_url)}">原始 RSS Feed</a></nav><h2>已生成字幕</h2><ul>{''.join(rows) if rows else '<li>暂无字幕。</li>'}</ul></body></html>"""
    path = PODCAST_DIR / "index.html"
    atomic_write_text(path, page)
    return path


def rebuild_root_index() -> None:
    links = []
    if SITE_DIR.exists():
        for index_file in sorted(SITE_DIR.glob("*/index.html")):
            slug = index_file.parent.name
            if slug != "assets":
                href = quote(slug, safe="-._~")
                links.append(
                    f'<li><a href="{escape_html(href)}/index.html">{escape_html(slug)}</a></li>'
                )
    page = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Podcast Transcript Library</title><style>body{{max-width:900px;margin:2rem auto;padding:0 1rem;font:16px/1.7 system-ui,sans-serif}}li{{margin:.7rem 0}}</style></head><body><h1>Podcast Transcript Library</h1><p>自动生成的播客字幕目录。</p><ul>{''.join(links)}</ul></body></html>"""
    atomic_write_text(SITE_DIR / "index.html", page)


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
    entry: Any,
    identity: str,
    audio_url: str,
    path_owner: dict[str, str] | None = None,
    force: bool = False,
    output_path: Path | None = None,
) -> tuple[dict[str, str], dict[str, Any]]:
    """转录音集并写出双语 VTT 与逐词时间轴。

    ``force=True`` 忽略已存在的字幕重新转录；失败的尝试会把旧 VTT 原样恢复
    （快照 + 原子替换），并且只在旧 sidecar 未完成时写下 ``complete:false``
    的记账（attempts 递增），已完成的 sidecar 保持不动；随后重新抛出异常。

    ``QuotaExhausted`` 是暂停而不是失败：直接向上抛出，不动 sidecar 记账，
    否则重试计数会把这一集永久挤出回填候选。

    ``output_path`` 由调用方拥有时（例如按 state 里既有文件名回填）直接使用，
    不再按标题推导文件名，也不加同标题后缀。
    """
    title = clean_text(getattr(entry, "title", "") or "Untitled episode")
    published = clean_text(
        getattr(entry, "published", "") or getattr(entry, "updated", "") or ""
    )
    if output_path is not None:
        transcript_path = output_path
    else:
        filename = safe_filename(title)
        transcript_path = TRANSCRIPT_DIR / f"{filename}.vtt"
        relative_path = transcript_path.relative_to(SITE_DIR).as_posix()
        owner = (path_owner or {}).get(relative_path)
        if owner and owner != identity:
            # Two episodes with the same title must not share one transcript.
            # Existing files/state records keep working; only the collision gets a
            # stable identity suffix.
            suffix = hashlib.sha1(identity.encode("utf-8")).hexdigest()[:8]
            filename = f"{safe_filename(title, 100)}_{suffix}"
            transcript_path = TRANSCRIPT_DIR / f"{filename}.vtt"
    if (
        not force
        and transcript_path.exists()
        and is_valid_bilingual_vtt(transcript_path)
    ):
        log.debug("完整双语字幕已存在，复用：%s", transcript_path)
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
    sidecar = sidecar_path_for(transcript_path)
    # force 失败必须让旧 VTT 原样留下：先拍字节快照，异常时按快照恢复。
    previous_vtt = snapshot_file_bytes(transcript_path)
    try:
        with tempfile.TemporaryDirectory(prefix="podcast-audio-") as temp_dir:
            audio_path = Path(temp_dir) / f"episode{suffix}"
            proxy_info = download_audio(audio_url, audio_path)
            cues, audio_seconds = whisper_transcribe(audio_path)
        cues = translate_cues_with_gemini(cues)
        if any(not c.get("en") or not c.get("zh") for c in cues):
            raise RuntimeError("字幕校验失败：存在空的英文或中文条目")
        write_bilingual_vtt(cues, transcript_path)
        # sidecar 现在是回填断点，写失败必须显式失败，不能吞掉。
        write_word_timings(cues, sidecar, audio_seconds)
    except Exception as exc:
        try:
            current_vtt = snapshot_file_bytes(transcript_path)
            if previous_vtt is not None and current_vtt != previous_vtt:
                restore_file_bytes(transcript_path, previous_vtt)
                log.warning("本次尝试失败，已恢复旧字幕：%s", transcript_path)
        except Exception:
            log.exception("恢复旧字幕失败：%s", transcript_path)
        if isinstance(exc, QuotaExhausted):
            # 配额暂停不是这一集的失败：一次都不许记 attempts，否则两轮之后
            # needs_backfill 就把这集永久踢出候选，暂停等于丢进度。
            log.warning("Gemini 配额耗尽，暂停转录且不计失败：%s", transcript_path)
            raise
        try:
            complete, previous_attempts = sidecar_status(sidecar)
            if complete:
                # 已完成的 sidecar 是既有成果，失败的 force 尝试不得把它降级。
                log.warning("逐词时间轴已完成，保留原记录：%s", sidecar)
            else:
                write_sidecar_failure(sidecar, attempts=previous_attempts + 1)
        except Exception:
            # 记账只是附带动作，出错也不能掩盖真正要抛出的异常。
            log.exception("记录失败尝试出错：%s", sidecar)
        raise
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
    if not GEMINI_KEYS:
        log.error("缺少 GEMINI_API_KEYS（或 GEMINI_API_KEY）环境变量")
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
    records = migrate_legacy_records(ps, processed)
    backfill = backfill_env()
    if backfill is not None:
        # 回填只补 sidecar：不写 state、不重建 feed/index，多个分片才能并行跑。
        backfill_candidates = build_backfill_candidates(entries, records)
        log.info(
            "回填模式：分片 %d/%d，预算 %.0f 分钟，候选 %d 集，模型 %s，key %d 把",
            backfill["shard"],
            backfill["shards"],
            backfill["max_minutes"],
            len(backfill_candidates),
            WHISPER_MODEL,
            len(GEMINI_KEYS),
        )
        stats = run_backfill(
            backfill_candidates,
            shard=backfill["shard"],
            shards=backfill["shards"],
            max_minutes=backfill["max_minutes"],
        )
        log.info(
            "回填结束：完成 %d，失败 %d，非本分片 %d，配额耗尽=%s",
            stats["done"],
            stats["failed"],
            stats["skipped"],
            stats["quota"],
        )
        return 0
    path_owner = {
        record["path"]: identity
        for identity, record in records.items()
        if record.get("path")
    }
    # 先筛一遍缓存命中，日志才能报出真实待转录数；记账仍留在主循环，保持 records 原有顺序。
    cached_paths: dict[str, Any] = {}
    to_transcribe = 0
    for entry, identity, _audio_url in candidates:
        path = get_existing_path(identity, processed, records)
        if (
            processed.get(identity)
            and path
            and path.exists()
            and is_valid_bilingual_vtt(path)
        ):
            cached_paths.setdefault(identity, path)
            log.debug(
                "已处理且双语字幕有效，跳过：%s",
                clean_text(getattr(entry, "title", "") or "Untitled episode"),
            )
        else:
            to_transcribe += 1
    log.info(
        "播客：%s；RSS 条目：%d；含音频候选：%d；待转录：%d；已处理跳过：%d",
        feed_title,
        len(entries),
        len(candidates),
        to_transcribe,
        len(candidates) - to_transcribe,
    )
    completed_this_run = 0
    skipped_this_run = 0
    failed_count = 0
    work_no = 0
    for entry, identity, audio_url in candidates:
        title = clean_text(getattr(entry, "title", "") or "Untitled episode")
        old_path = cached_paths.get(identity)
        old_record = records.get(identity)
        if old_path:
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
            skipped_this_run += 1
            continue
        work_no += 1
        log.info("转录 %d/%d：%s", work_no, to_transcribe, title)
        try:
            record, proxy_info = process_episode(
                entry, identity, audio_url, path_owner
            )
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
            path_owner[record["path"]] = identity
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
        "运行结束：转录 %d 集；跳过（双语字幕已存在）%d 集；失败 %d 集",
        completed_this_run,
        skipped_this_run,
        failed_count,
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
