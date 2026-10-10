#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Podcast RSS -> faster-whisper -> Gemini 分段翻译 -> 双语 VTT -> 增强 RSS / 网站

必需环境变量：
    PODCAST_SLUG
    FEED_URL
    GEMINI_API_KEY

可选环境变量：
    WHISPER_MODEL=base.en
    GEMINI_MODEL=gemini-2.5-flash
    BASE_URL=https://owner.github.io/repository
    MAX_EPISODES=0                 # 0 = 不限制
    TRANSLATE_BATCH_SIZE=20        # 每批最多多少条字幕
    TRANSLATE_BATCH_MAX_CHARS=9000 # 每批英文总字符上限
    TRANSLATE_MAX_RETRIES=3
    TRANSLATE_BASE_DELAY=2
    TRANSLATE_BATCH_DELAY=0.3
    AUDIO_TIMEOUT=60
    AUDIO_MAX_MB=1500

依赖：
    pip install faster-whisper feedparser requests lxml google-genai
"""

from __future__ import annotations

import html
import json
import logging
import os
import re
import sys
import time
import hashlib
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, unquote

import feedparser
import requests
from lxml import etree
from faster_whisper import WhisperModel
from google import genai
from google.genai import types

# ============================================================
# 配置
# ============================================================

PODCAST_SLUG = os.getenv("PODCAST_SLUG", "podcast").strip()
FEED_URL = os.getenv("FEED_URL", "").strip()
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base.en").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash").strip()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
BASE_URL = os.getenv("BASE_URL", "").rstrip("/")

MAX_EPISODES = int(os.getenv("MAX_EPISODES", "0"))
TRANSLATE_BATCH_SIZE = max(1, int(os.getenv("TRANSLATE_BATCH_SIZE", "20")))
TRANSLATE_BATCH_MAX_CHARS = max(
    500, int(os.getenv("TRANSLATE_BATCH_MAX_CHARS", "9000"))
)
TRANSLATE_MAX_RETRIES = max(0, int(os.getenv("TRANSLATE_MAX_RETRIES", "3")))
TRANSLATE_BASE_DELAY = max(0.1, float(os.getenv("TRANSLATE_BASE_DELAY", "2")))
TRANSLATE_BATCH_DELAY = max(0.0, float(os.getenv("TRANSLATE_BATCH_DELAY", "0.3")))
AUDIO_TIMEOUT = max(10, int(os.getenv("AUDIO_TIMEOUT", "60")))
AUDIO_MAX_MB = max(1, int(os.getenv("AUDIO_MAX_MB", "1500")))

ROOT_DIR = Path(__file__).resolve().parent.parent
SITE_DIR = ROOT_DIR / "site"
STATE_FILE = ROOT_DIR / "state.json"
PODCAST_DIR = SITE_DIR / PODCAST_SLUG
TRANSCRIPT_DIR = PODCAST_DIR / "transcripts"
SITE_INDEX = SITE_DIR / "index.html"

PODCAST_NS = "https://podcastindex.org/namespace/1.0"
NSMAP = {"podcast": PODCAST_NS}

USER_AGENT = "PodcastTranscriptBot/1.0 (+https://github.com/)"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("podcast-transcriber")


# ============================================================
# 通用工具
# ============================================================


def ensure_directories() -> None:
    TRANSCRIPT_DIR.mkdir(parents=True, exist_ok=True)
    SITE_DIR.mkdir(parents=True, exist_ok=True)


def safe_filename(value: str, max_length: int = 120) -> str:
    """生成跨平台安全文件名。"""
    value = html.unescape(value or "").strip()
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value)
    value = re.sub(r"\s+", " ", value)
    value = value.strip(" .")
    if not value:
        value = "untitled"
    return value[:max_length].rstrip(" .") or "untitled"


def stable_id(*parts: str) -> str:
    raw = "\n".join(str(p or "") for p in parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def load_state() -> dict[str, Any]:
    if not STATE_FILE.exists():
        return {"version": 1, "podcasts": {}}

    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("state.json 根节点不是对象")
        data.setdefault("version", 1)
        data.setdefault("podcasts", {})
        return data
    except Exception as exc:
        # 不自动覆盖损坏的状态文件，避免丢失已有进度。
        raise RuntimeError(f"无法读取 {STATE_FILE}: {exc}") from exc


def save_state(state: dict[str, Any]) -> None:
    tmp = STATE_FILE.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(state, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    tmp.replace(STATE_FILE)


def format_timestamp(seconds: float) -> str:
    """秒数转换为 WebVTT 时间戳：HH:MM:SS.mmm。"""
    milliseconds = max(0, int(round(float(seconds) * 1000)))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{millis:03d}"


def clean_text(value: str) -> str:
    value = html.unescape(value or "")
    value = value.replace("\ufeff", "")
    return re.sub(r"\s+", " ", value).strip()


# ============================================================
# RSS 解析与节目识别
# ============================================================


def get_entry_audio_url(entry: Any) -> str:
    """从 feedparser entry 中获取音频地址。"""
    for enclosure in getattr(entry, "enclosures", []) or []:
        href = enclosure.get("href") or enclosure.get("url")
        mime = (enclosure.get("type") or "").lower()
        if href and (
            mime.startswith("audio/")
            or not mime
            or any(
                ext in href.lower()
                for ext in (".mp3", ".m4a", ".aac", ".ogg", ".wav", ".opus")
            )
        ):
            return href

    for link in getattr(entry, "links", []) or []:
        href = link.get("href")
        rel = (link.get("rel") or "").lower()
        mime = (link.get("type") or "").lower()
        if href and (rel == "enclosure" or mime.startswith("audio/")):
            return href

    return ""


def entry_identity(entry: Any, audio_url: str) -> str:
    guid = clean_text(getattr(entry, "id", "") or "")
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


# ============================================================
# 音频下载
# ============================================================


def download_audio(url: str, output_path: Path) -> Path:
    """流式下载音频，限制最大文件大小。"""
    if not url:
        raise ValueError("节目没有音频 enclosure URL。")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    max_bytes = AUDIO_MAX_MB * 1024 * 1024

    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "*/*",
    }

    log.info("下载音频：%s", url)

    with requests.get(
        url,
        headers=headers,
        stream=True,
        timeout=(20, AUDIO_TIMEOUT),
        allow_redirects=True,
    ) as response:
        response.raise_for_status()

        content_length = response.headers.get("Content-Length")
        if content_length:
            try:
                if int(content_length) > max_bytes:
                    raise RuntimeError(
                        f"音频大小超过限制：{int(content_length) / 1024 / 1024:.1f} MB"
                    )
            except ValueError:
                pass

        written = 0
        with output_path.open("wb") as out:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if not chunk:
                    continue
                written += len(chunk)
                if written > max_bytes:
                    raise RuntimeError(f"下载音频超过 {AUDIO_MAX_MB} MB 限制，已停止。")
                out.write(chunk)

    if not output_path.exists() or output_path.stat().st_size == 0:
        raise RuntimeError("音频下载后文件为空。")

    log.info("音频下载完成：%.1f MB", output_path.stat().st_size / 1024 / 1024)
    return output_path


# ============================================================
# Whisper 转录与字幕切分
# ============================================================


def split_into_sentences(text: str) -> list[str]:
    """
    尽量按句末标点切分。
    保留英文缩写的处理采用简单规则，不追求完美 NLP 分句。
    """
    text = clean_text(text)
    if not text:
        return []

    # 避免常见缩写中的句点被错误视为句末。
    protected = text
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
    for old, new in abbreviations.items():
        protected = re.sub(re.escape(old), new, protected, flags=re.IGNORECASE)

    pieces = re.split(r"(?<=[.!?])\s+", protected)
    results = []
    for piece in pieces:
        piece = piece.replace("<DOT>", ".").strip()
        if piece:
            results.append(piece)
    return results


def whisper_transcribe(audio_path: Path) -> list[dict[str, Any]]:
    log.info("加载 Whisper 模型：%s", WHISPER_MODEL)

    # GitHub-hosted Ubuntu runner 通常没有可用 NVIDIA GPU。
    model = WhisperModel(
        WHISPER_MODEL,
        device="cpu",
        compute_type="int8",
    )

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

    raw_segments: list[dict[str, Any]] = []
    for segment in segments:
        text = clean_text(segment.text)
        if not text:
            continue
        raw_segments.append(
            {
                "start": max(0.0, float(segment.start)),
                "end": max(float(segment.start) + 0.05, float(segment.end)),
                "text": text,
            }
        )

    if not raw_segments:
        raise RuntimeError("Whisper 没有识别到任何语音内容。")

    cues = resegment_whisper_segments(raw_segments)
    log.info("转录完成：生成 %d 条英文字幕。", len(cues))
    return cues


def resegment_whisper_segments(
    segments: list[dict[str, Any]],
    max_chars: int = 180,
) -> list[dict[str, Any]]:
    """
    将 Whisper 片段进一步拆成较适合阅读的句子。
    若一个原始片段拆成多句，按字符长度近似分配时间段。
    """
    cues: list[dict[str, Any]] = []

    for segment in segments:
        text = segment["text"]
        start = float(segment["start"])
        end = float(segment["end"])
        duration = max(0.05, end - start)

        sentences = split_into_sentences(text)
        if not sentences:
            continue

        # 长句再按逗号、分号等软切分，避免字幕过长。
        expanded: list[str] = []
        for sentence in sentences:
            if len(sentence) <= max_chars:
                expanded.append(sentence)
                continue

            parts = re.split(r"(?<=[,;:])\s+", sentence)
            current = ""
            for part in parts:
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

        weights = [max(1, len(s)) for s in expanded]
        total_weight = sum(weights)
        cursor = start

        for index, sentence in enumerate(expanded):
            if index == len(expanded) - 1:
                cue_end = end
            else:
                cue_end = cursor + duration * weights[index] / total_weight

            cue_end = max(cursor + 0.05, min(cue_end, end))
            cues.append(
                {
                    "start": cursor,
                    "end": cue_end,
                    "en": sentence,
                    "zh": "",
                }
            )
            cursor = cue_end

    # 修正浮点误差导致的时间倒退或重叠。
    previous_end = 0.0
    for cue in cues:
        cue["start"] = max(previous_end, float(cue["start"]))
        cue["end"] = max(cue["start"] + 0.05, float(cue["end"]))
        previous_end = cue["end"]

    return cues


# ============================================================
# Gemini 分段翻译
# ============================================================


def create_gemini_client() -> genai.Client:
    if not GEMINI_API_KEY:
        raise RuntimeError(
            "缺少 GEMINI_API_KEY。请在 GitHub 仓库 Settings -> Secrets and variables "
            "-> Actions 中添加 GEMINI_API_KEY。"
        )
    return genai.Client(api_key=GEMINI_API_KEY)


def build_translation_batches(
    cues: list[dict[str, Any]],
    batch_size: int,
    max_chars: int,
) -> list[list[dict[str, Any]]]:
    """按条数和字符数双重限制分批。"""
    batches: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    current_chars = 0

    for cue in cues:
        text = cue["en"]
        text_len = len(text)

        if current and (
            len(current) >= batch_size or current_chars + text_len > max_chars
        ):
            batches.append(current)
            current = []
            current_chars = 0

        current.append(cue)
        current_chars += text_len

    if current:
        batches.append(current)

    return batches


def parse_json_array(text: str) -> list[Any]:
    """容忍模型偶尔返回 Markdown 代码围栏。"""
    text = (text or "").strip()
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*```$", "", text)

    try:
        value = json.loads(text)
        if isinstance(value, list):
            return value
    except json.JSONDecodeError:
        pass

    # 尝试从回答中提取第一个 JSON 数组。
    start = text.find("[")
    end = text.rfind("]")
    if start >= 0 and end > start:
        value = json.loads(text[start : end + 1])
        if isinstance(value, list):
            return value

    raise ValueError("Gemini 没有返回有效的 JSON 数组。")


def translate_batch_once(
    client: genai.Client,
    cues: list[dict[str, Any]],
) -> list[str]:
    """
    每批发送一组英文字幕，要求模型按原顺序返回等长中文数组。
    不允许模型修改时间戳；时间戳由程序在最终输出时原样生成。
    """
    source_texts = [cue["en"] for cue in cues]

    prompt = (
        "你是一名专业的英译简体中文字幕译者。\n"
        "请把下方 JSON 数组中的英文字幕逐条翻译为自然、准确、易读的简体中文。\n"
        "要求：\n"
        "1. 严格按原顺序逐条翻译，一条英文对应一条中文。\n"
        "2. 必须返回与输入数量完全相同的数组，不能合并、拆分、漏译或额外增加条目。\n"
        "3. 保留人物姓名、专有名词、数字、语气、幽默和上下文含义。\n"
        "4. 不要解释，不要添加译者注，不要返回英文原文。\n"
        "5. 只返回合法 JSON 数组，数组每项为一个中文字符串；不要 Markdown 围栏。\n\n"
        "待翻译字幕 JSON：\n" + json.dumps(source_texts, ensure_ascii=False)
    )

    response = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            temperature=0.2,
            response_mime_type="application/json",
        ),
    )

    translated = parse_json_array(response.text or "")

    if len(translated) != len(source_texts):
        raise ValueError(
            f"字幕数量不匹配：输入 {len(source_texts)} 条，"
            f"Gemini 返回 {len(translated)} 条。"
        )

    cleaned: list[str] = []
    for index, item in enumerate(translated):
        if not isinstance(item, str):
            raise ValueError(f"第 {index + 1} 条翻译不是字符串。")

        item = clean_text(item)
        if not item:
            raise ValueError(f"第 {index + 1} 条翻译为空。")

        # 如果某项看起来明显未翻译，不接受整批结果。
        # 专有名词、缩写、单词字幕可能本来就是英文，因此只检查较长句子。
        source = source_texts[index]
        if len(source) >= 18 and item == source:
            raise ValueError(f"第 {index + 1} 条疑似未翻译。")

        cleaned.append(item)

    return cleaned


def translate_batch_recursive(
    client: genai.Client,
    cues: list[dict[str, Any]],
    depth: int = 0,
) -> None:
    """
    先重试当前批次；多次失败后将批次二分，继续处理。
    单条字幕仍失败时抛出异常，防止生成不完整译文。
    """
    last_error: Exception | None = None

    for attempt in range(TRANSLATE_MAX_RETRIES + 1):
        try:
            translations = translate_batch_once(client, cues)
            for cue, translation in zip(cues, translations):
                cue["zh"] = translation
            return
        except Exception as exc:
            last_error = exc
            if attempt < TRANSLATE_MAX_RETRIES:
                wait_seconds = min(
                    60.0,
                    TRANSLATE_BASE_DELAY * (2**attempt),
                )
                log.warning(
                    "Gemini 批次失败（第 %d/%d 次）：%s；%.1f 秒后重试。",
                    attempt + 1,
                    TRANSLATE_MAX_RETRIES + 1,
                    exc,
                    wait_seconds,
                )
                time.sleep(wait_seconds)

    if len(cues) > 1:
        midpoint = len(cues) // 2
        log.warning(
            "批次重试仍失败，拆成两段继续处理（每段 %d / %d 条）。",
            midpoint,
            len(cues) - midpoint,
        )
        translate_batch_recursive(client, cues[:midpoint], depth + 1)
        if TRANSLATE_BATCH_DELAY:
            time.sleep(TRANSLATE_BATCH_DELAY)
        translate_batch_recursive(client, cues[midpoint:], depth + 1)
        return

    source = cues[0].get("en", "") if cues else ""
    raise RuntimeError(
        f"单条字幕翻译最终失败，不能安全生成完整双语字幕。"
        f"原文：{source[:160]!r}；最后错误：{last_error}"
    ) from last_error


def translate_cues_with_gemini(
    cues: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """批量翻译所有字幕。任何条目未成功翻译都会让整集失败。"""
    if not cues:
        raise ValueError("没有可供翻译的字幕。")

    client = create_gemini_client()
    batches = build_translation_batches(
        cues,
        TRANSLATE_BATCH_SIZE,
        TRANSLATE_BATCH_MAX_CHARS,
    )

    log.info(
        "Gemini 翻译开始：%d 条字幕，%d 个初始批次，模型=%s。",
        len(cues),
        len(batches),
        GEMINI_MODEL,
    )

    for index, batch in enumerate(batches, start=1):
        log.info(
            "翻译批次 %d/%d：%d 条字幕。",
            index,
            len(batches),
            len(batch),
        )
        translate_batch_recursive(client, batch)

        if TRANSLATE_BATCH_DELAY and index < len(batches):
            time.sleep(TRANSLATE_BATCH_DELAY)

    missing = [i for i, cue in enumerate(cues, start=1) if not cue.get("zh")]
    if missing:
        raise RuntimeError(f"翻译不完整，缺少中文的字幕序号：{missing[:20]}")

    log.info("Gemini 翻译完成：%d 条字幕全部通过检查。", len(cues))
    return cues


# ============================================================
# 双语 VTT 输出
# ============================================================


def write_bilingual_vtt(cues: list[dict[str, Any]], output_path: Path) -> None:
    """
    每条字幕内先显示英文，再显示中文。
    时间戳始终使用 Whisper 原始切分得到的时间，不交由 Gemini 改写。
    """
    if not cues:
        raise ValueError("没有字幕，拒绝写出空 VTT。")

    blocks = ["WEBVTT", ""]

    for index, cue in enumerate(cues, start=1):
        en = clean_text(cue.get("en", ""))
        zh = clean_text(cue.get("zh", ""))

        if not en or not zh:
            raise RuntimeError(f"第 {index} 条字幕缺少英文或中文，拒绝写出 VTT。")

        start = format_timestamp(cue["start"])
        end = format_timestamp(cue["end"])

        if cue["end"] <= cue["start"]:
            raise RuntimeError(f"第 {index} 条字幕的结束时间不晚于开始时间。")

        blocks.extend(
            [
                str(index),
                f"{start} --> {end}",
                en,
                zh,
                "",
            ]
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = output_path.with_suffix(output_path.suffix + ".tmp")
    temp_path.write_text("\n".join(blocks).rstrip() + "\n", encoding="utf-8")
    temp_path.replace(output_path)

    log.info("已写出双语 VTT：%s", output_path)


# ============================================================
# 增强 RSS：添加 Podcasting 2.0 transcript 标签
# ============================================================


def find_item_guid(item: etree._Element) -> str:
    guid = item.find("guid")
    if guid is not None and guid.text:
        return guid.text.strip()

    link = item.find("link")
    if link is not None and link.text:
        return link.text.strip()

    return ""


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


def add_transcript_tag(
    item: etree._Element,
    transcript_url: str,
) -> None:
    """为指定 RSS item 添加 podcast:transcript 标签，并避免重复。"""
    tag_name = f"{{{PODCAST_NS}}}transcript"

    for existing in item.findall(tag_name):
        if existing.get("url") == transcript_url:
            return

    node = etree.SubElement(item, tag_name)
    node.set("url", transcript_url)
    node.set("type", "text/vtt")
    node.set("language", "zh-CN")
    node.set("rel", "captions")


def make_enhanced_feed(
    feed_url: str,
    completed_items: list[dict[str, str]],
) -> Path:
    """
    下载并复制原始 RSS XML，给已生成字幕的节目添加 transcript 标签。
    不修改原始音频 enclosure。
    """
    log.info("生成增强 RSS。")

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
        raise RuntimeError("无法解析原始 RSS XML。")

    # 若原始 XML 没有声明 podcast 命名空间，lxml 会在标签上声明；
    # 这仍是有效 XML。
    for completed in completed_items:
        item = find_feed_item(
            root,
            completed.get("identity", ""),
            completed.get("title", ""),
        )
        if item is None:
            log.warning(
                "增强 RSS 时未匹配到节目条目：%s",
                completed.get("title", ""),
            )
            continue

        add_transcript_tag(item, completed["url"])

    output_path = SITE_DIR / PODCAST_SLUG / "feed.xml"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    tree = etree.ElementTree(root)
    tree.write(
        str(output_path),
        encoding="utf-8",
        xml_declaration=True,
        pretty_print=True,
    )

    log.info("增强 RSS 已生成：%s", output_path)
    return output_path


# ============================================================
# HTML 索引生成
# ============================================================


def escape_html(value: str) -> str:
    return html.escape(value or "", quote=True)


def build_podcast_index(
    title: str,
    feed_url: str,
    transcripts: list[dict[str, str]],
) -> Path:
    rows = []

    for item in sorted(
        transcripts,
        key=lambda x: x.get("published", ""),
        reverse=True,
    ):
        transcript_url = item.get("url", "")
        rows.append(
            "<li>"
            f'<a href="{escape_html(transcript_url)}">'
            f"{escape_html(item.get('title', 'Untitled'))}"
            "</a>"
            f"<small>{escape_html(item.get('published', ''))}</small>"
            "</li>"
        )

    base = BASE_URL or ""
    enhanced_feed_url = f"{base}/{PODCAST_SLUG}/feed.xml"

    page = f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{escape_html(title)} · 双语字幕</title>
<style>
:root {{ color-scheme: light dark; }}
body {{
  max-width: 900px; margin: 2rem auto; padding: 0 1rem;
  font: 16px/1.7 system-ui, -apple-system, "Segoe UI", sans-serif;
}}
h1 {{ line-height: 1.25; }}
a {{ overflow-wrap: anywhere; }}
li {{ margin: 0.9rem 0; }}
small {{ display: block; opacity: .7; }}
nav {{ margin: 1.5rem 0; }}
</style>
</head>
<body>
<h1>{escape_html(title)}</h1>
<p>英文原文与简体中文译文合并显示的 WebVTT 字幕。</p>
<nav>
  <a href="{escape_html(enhanced_feed_url)}">增强版 RSS Feed</a>
  ·
  <a href="{escape_html(feed_url)}">原始 RSS Feed</a>
</nav>
<h2>已生成字幕</h2>
<ul>
{''.join(rows) if rows else '<li>暂无字幕。</li>'}
</ul>
</body>
</html>
"""

    output_path = PODCAST_DIR / "index.html"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(page, encoding="utf-8")
    return output_path


def rebuild_root_index() -> None:
    """生成简单的站点总目录，列出 site/ 下的播客。"""
    podcast_pages = []

    if SITE_DIR.exists():
        for index_file in sorted(SITE_DIR.glob("*/index.html")):
            slug = index_file.parent.name
            if slug == "assets":
                continue
            podcast_pages.append(
                f'<li><a href="{escape_html(slug)}/index.html">'
                f"{escape_html(slug)}</a></li>"
            )

    page = f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Podcast Transcript Library</title>
<style>
body {{ max-width: 900px; margin: 2rem auto; padding: 0 1rem;
font: 16px/1.7 system-ui, sans-serif; }}
li {{ margin: .7rem 0; }}
</style>
</head>
<body>
<h1>Podcast Transcript Library</h1>
<p>自动生成的播客字幕目录。</p>
<ul>{''.join(podcast_pages)}</ul>
</body>
</html>
"""
    SITE_INDEX.write_text(page, encoding="utf-8")


# ============================================================
# 单集处理
# ============================================================


def process_episode(
    entry: Any,
    identity: str,
    audio_url: str,
) -> dict[str, str]:
    title = clean_text(getattr(entry, "title", "") or "Untitled episode")
    published = clean_text(
        getattr(entry, "published", "") or getattr(entry, "updated", "") or ""
    )

    filename = safe_filename(title)
    transcript_path = TRANSCRIPT_DIR / f"{filename}.vtt"

    # 如果文件已存在但状态没写入，可避免重复消耗翻译额度；
    # 这里仅在文件确实存在且有完整 VTT 内容时复用。
    if transcript_path.exists():
        existing = transcript_path.read_text(encoding="utf-8", errors="replace")
        if existing.startswith("WEBVTT") and "-->" in existing:
            log.info("字幕文件已存在，复用：%s", transcript_path)
            return {
                "identity": identity,
                "title": title,
                "published": published,
                "url": make_public_url(transcript_path),
                "path": str(transcript_path.relative_to(SITE_DIR)),
            }

    suffix = Path(urlparse(audio_url).path).suffix.lower()
    if suffix not in {".mp3", ".m4a", ".aac", ".wav", ".ogg", ".opus", ".flac", ".mp4"}:
        suffix = ".audio"

    with tempfile.TemporaryDirectory(prefix="podcast-audio-") as temp_dir:
        audio_path = Path(temp_dir) / f"episode{suffix}"
        download_audio(audio_url, audio_path)
        cues = whisper_transcribe(audio_path)

    # 只有转录成功后才发起翻译。
    cues = translate_cues_with_gemini(cues)

    # 写入前确保每条字幕都有英中内容。
    if any(not cue.get("en") or not cue.get("zh") for cue in cues):
        raise RuntimeError("字幕校验失败：仍存在空的英文或中文条目。")

    write_bilingual_vtt(cues, transcript_path)

    return {
        "identity": identity,
        "title": title,
        "published": published,
        "url": make_public_url(transcript_path),
        "path": str(transcript_path.relative_to(SITE_DIR)),
    }


def make_public_url(path: Path) -> str:
    relative = path.relative_to(SITE_DIR).as_posix()
    # GitHub Pages 子路径 BASE_URL 已由 workflow 设置。
    if BASE_URL:
        from urllib.parse import quote

        encoded_path = "/".join(quote(part) for part in relative.split("/"))
        return f"{BASE_URL}/{encoded_path}"
    return relative


# ============================================================
# 主流程
# ============================================================


def main() -> int:
    if not FEED_URL:
        log.error("缺少 FEED_URL 环境变量。")
        return 2

    if not GEMINI_API_KEY:
        log.error("缺少 GEMINI_API_KEY 环境变量。")
        return 2

    ensure_directories()

    state = load_state()
    podcast_states = state.setdefault("podcasts", {})
    podcast_state = podcast_states.setdefault(
        PODCAST_SLUG,
        {
            "feed_url": FEED_URL,
            "processed": {},
            "transcripts": [],
        },
    )
    podcast_state["feed_url"] = FEED_URL
    processed = podcast_state.setdefault("processed", {})

    parsed_feed, entries = get_feed_entries(FEED_URL)
    feed_title = clean_text(getattr(parsed_feed.feed, "title", "") or PODCAST_SLUG)

    # 默认先处理最新节目；MAX_EPISODES=0 表示不限制。
    candidates = []
    for entry in entries:
        audio_url = get_entry_audio_url(entry)
        if not audio_url:
            continue

        identity = entry_identity(entry, audio_url)
        candidates.append((entry, identity, audio_url))

    if MAX_EPISODES > 0:
        candidates = candidates[:MAX_EPISODES]

    log.info(
        "播客：%s；RSS 条目：%d；可处理音频条目：%d",
        feed_title,
        len(entries),
        len(candidates),
    )

    completed_this_run: list[dict[str, str]] = []
    transcripts_by_identity: dict[str, dict[str, str]] = {}

    # 先恢复 state 中已有的字幕记录，便于每次运行重建站点索引。
    for record in podcast_state.get("transcripts", []):
        if isinstance(record, dict) and record.get("identity"):
            transcripts_by_identity[record["identity"]] = record

    for number, (entry, identity, audio_url) in enumerate(candidates, start=1):
        title = clean_text(getattr(entry, "title", "") or "Untitled episode")
        log.info("处理节目 %d/%d：%s", number, len(candidates), title)

        existing_record = transcripts_by_identity.get(identity)
        existing_path = (
            SITE_DIR / existing_record["path"]
            if existing_record and existing_record.get("path")
            else None
        )

        if processed.get(identity) and existing_path and existing_path.exists():
            log.info("已处理且字幕文件存在，跳过：%s", title)
            completed_this_run.append(existing_record)
            continue

        try:
            record = process_episode(entry, identity, audio_url)

            # 只有整个转录和翻译成功、VTT 已写入后，才标记为完成。
            processed[identity] = {
                "title": record["title"],
                "url": record["url"],
                "path": record["path"],
                "completed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "audio_url": audio_url,
                "model": WHISPER_MODEL,
                "translation_model": GEMINI_MODEL,
            }

            transcripts_by_identity[identity] = record
            completed_this_run.append(record)

            podcast_state["transcripts"] = list(transcripts_by_identity.values())
            podcast_states[PODCAST_SLUG] = podcast_state
            state["podcasts"] = podcast_states
            save_state(state)

            log.info("节目处理成功：%s", title)

        except Exception:
            # 失败不写入 processed；下次 Actions 运行可以重新尝试。
            log.exception("节目处理失败：%s。不会标记为已完成。", title)
            continue

    # 如果单集失败，仍可为成功生成的节目更新 RSS 和站点。
    all_transcripts = list(transcripts_by_identity.values())
    podcast_state["transcripts"] = all_transcripts
    podcast_state["last_run"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    podcast_state["feed_url"] = FEED_URL
    podcast_state["feed_title"] = feed_title
    podcast_states[PODCAST_SLUG] = podcast_state
    state["podcasts"] = podcast_states
    save_state(state)

    # 根据全部已知字幕记录重建增强 RSS。
    try:
        make_enhanced_feed(FEED_URL, all_transcripts)
    except Exception:
        log.exception("增强 RSS 生成失败。字幕文件和 state.json 已保留。")

    build_podcast_index(feed_title, FEED_URL, all_transcripts)
    rebuild_root_index()

    success_count = len(completed_this_run)
    failure_count = max(0, len(candidates) - success_count)
    log.info(
        "运行结束：本次成功或跳过 %d 集；其余未成功处理 %d 集。",
        success_count,
        failure_count,
    )

    # 有节目失败时返回非零，让 GitHub Actions 显示失败状态。
    if failure_count:
        return 1

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log.error("收到中断信号。")
        sys.exit(130)
    except Exception as exc:
        log.exception("脚本执行失败：%s", exc)
        sys.exit(1)
