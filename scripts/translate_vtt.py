#!/usr/bin/env python3

import os
import re
import json
import sys
import time
import hashlib
import traceback
import logging
import random

from pathlib import Path
from datetime import datetime, timezone

from google import genai

# ============================================================
# Config
# ============================================================

# 读取播客配置
PODCASTS_JSON = Path("podcasts.json")

# 站点根目录
SITE_DIR = Path("site")

# 翻译输出子目录名
ZH_SUBDIR = "zh"

# 缓存/状态文件
CACHE_FILE = Path("translations.json")

MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.1-flash-lite")
MAX_FILES = int(os.environ.get("MAX_FILES", "10"))

# 按字符数分批，替代固定 BATCH_SIZE
MAX_BATCH_CHARS = int(os.environ.get("MAX_BATCH_CHARS", "120000"))

RETRY_COUNT = 5
RETRY_BASE = 20

# RPM 限流：14 RPM（配额 15，留 1 个缓冲）
RPM_LIMIT = int(os.environ.get("RPM_LIMIT", "14"))
MIN_REQUEST_INTERVAL = 60.0 / RPM_LIMIT

# RPD 硬上限（免费层 1500）
DAILY_REQUEST_LIMIT = int(os.environ.get("DAILY_REQUEST_LIMIT", "1500"))

# GitHub Actions 检测
IN_ACTIONS = os.environ.get("GITHUB_ACTIONS") == "true"

# ============================================================
# Logging
# ============================================================

if IN_ACTIONS:
    # Actions 里不需要日期前缀，用 GitHub 自带时间戳即可
    fmt = "[%(levelname)s] %(message)s"
else:
    fmt = "%(asctime)s [%(levelname)s] %(message)s"

logging.basicConfig(level=logging.INFO, format=fmt, datefmt="%H:%M:%S")
logger = logging.getLogger("vtt_translator")


def log(msg=""):
    logger.info(msg)


def separator():
    log("=" * 70)


def group(title):
    """GitHub Actions 日志分组"""
    if IN_ACTIONS:
        print(f"::group::{title}", flush=True)
    else:
        log(f"\n>>> {title}")


def endgroup():
    if IN_ACTIONS:
        print("::endgroup::", flush=True)


# ============================================================
# Gemini
# ============================================================

group("Initializing Gemini")
try:
    # 添加 120 秒 HTTP 超时，防止服务端无响应时无限挂死
    client = genai.Client(
        api_key=os.environ["GEMINI_API_KEY"],
        http_options={"timeout": 120000}
    )
    log("✅ Gemini initialized")
except Exception as e:
    log("❌ Gemini initialization failed")
    endgroup()
    raise e
endgroup()

_last_request_time = 0.0


def _rate_limit_wait():
    """确保请求间隔满足 RPM 限制"""
    global _last_request_time
    now = time.time()
    elapsed = now - _last_request_time
    if elapsed < MIN_REQUEST_INTERVAL:
        sleep_time = MIN_REQUEST_INTERVAL - elapsed
        log(f"⏳ Rate limit: sleeping {sleep_time:.2f}s")
        time.sleep(sleep_time)
    _last_request_time = time.time()


# ============================================================
# Exceptions
# ============================================================


class DailyLimitReached(Exception):
    """日 API 限额达到，需要优雅停止，不是真正的错误"""
    pass


# ============================================================
# Podcasts config
# ============================================================


def load_podcasts():
    """读取 podcasts.json，返回播客列表"""
    if not PODCASTS_JSON.exists():
        log("⚠️ podcasts.json not found, using empty list")
        return []
    try:
        data = json.loads(PODCASTS_JSON.read_text(encoding="utf-8"))
        log(f"📻 Loaded {len(data)} podcast(s) from podcasts.json")
        return data
    except Exception as e:
        log(f"⚠️ Failed to load podcasts.json: {e}")
        return []


# ============================================================
# Cache
# ============================================================


def load_cache():
    if not CACHE_FILE.exists():
        log("ℹ️ Cache not found")
        return {}
    try:
        data = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
        meta = data.get("__meta__", {})
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if meta.get("date") != today:
            meta["date"] = today
            meta["daily_requests"] = 0
            data["__meta__"] = meta
            log("🌅 New day detected, resetting daily request counter")
        # 统计各播客的已翻译集数
        episode_count = 0
        for key, val in data.items():
            if key.startswith("__"):
                continue
            if isinstance(val, dict):
                episode_count += len(val)
        log(f"💾 Cache loaded: {episode_count} episodes across podcasts")
        return data
    except Exception as e:
        log(f"⚠️ Cache load failed: {e}")
        return {}


def save_cache(cache):
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    CACHE_FILE.write_text(
        json.dumps(cache, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    log("💾 Cache saved")


# ============================================================
# Hash
# ============================================================


def file_hash(path):
    sha = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            chunk = f.read(8192)
            if not chunk:
                break
            sha.update(chunk)
    return sha.hexdigest()


# ============================================================
# Gemini Translation
# ============================================================


def build_prompt(blocks):
    content = []
    for idx, text in blocks:
        content.append(f"{idx}|||{text}")
    joined = "\n\n".join(content)
    prompt = f"""You are translating podcast subtitles.

Translate English subtitles into Simplified Chinese.

Rules:
1. WebVTT speaker names are metadata, not subtitle text.
2. Never output speaker names.
3. Only translate subtitle content.
4. Preserve the original meaning.
5. Do NOT summarize.
6. Keep every subtitle block.
7. Translate only the subtitle content.

Output format:
0|||Chinese translation
1|||Chinese translation

Important:
- Output exactly one line per block.
- Do not add markdown.
- Do not add explanations.
- Do not add introductions.
- Do not use code blocks.

Subtitle blocks:
{joined}
"""
    return prompt


def parse_translation_response(text):
    result = {}
    if not text:
        return result
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        line = re.sub(r"^[\-\*\s]+", "", line)
        try:
            if "|||" in line:
                idx, value = line.split("|||", 1)
            elif "|" in line:
                idx, value = line.split("|", 1)
            else:
                continue
            idx = re.sub(r"[^0-9]", "", idx.strip())
            if not idx:
                continue
            value = value.strip()
            if value:
                result[int(idx)] = value
        except Exception:
            continue
    return result


def is_retryable_error(error) -> bool:
    """只重试可恢复的服务端/网络错误"""
    err_str = str(error).lower()
    retryable = [
        "429",
        "too many requests",
        "rate limit",
        "quota",
        "503",
        "service unavailable",
        "500",
        "internal server error",
        "502",
        "504",
        "gateway",
        "timeout",
        "timed out",
        "deadline",
        "connection",
        "network",
        "unreachable",
    ]
    return any(kw in err_str for kw in retryable)


def validate_translation(original: str, translated: str) -> bool:
    """简单验证翻译结果质量"""
    if not translated or len(translated) < 2:
        return False
    if translated.lower().strip(".,!?") == original.lower().strip(".,!?"):
        return False
    if not re.search(r"[\u4e00-\u9fff]", translated):
        return False
    return True


def gemini_batch_translate(blocks, cache_meta):
    """带限流、RPD 检查、错误分类的翻译"""
    global _last_request_time
    prompt = build_prompt(blocks)

    for attempt in range(1, RETRY_COUNT + 1):
        # RPD 硬上限检查
        daily_used = cache_meta.get("daily_requests", 0)
        if daily_used >= DAILY_REQUEST_LIMIT:
            raise DailyLimitReached(
                f"Daily request limit reached: {daily_used}/{DAILY_REQUEST_LIMIT}"
            )
        cache_meta["daily_requests"] = daily_used + 1

        _rate_limit_wait()
        start = time.time()

        log(
            f"🤖 Request #{cache_meta['daily_requests']}/{DAILY_REQUEST_LIMIT} "
            f"(attempt {attempt}/{RETRY_COUNT}), blocks: {len(blocks)}"
        )

        try:
            response = client.models.generate_content(
                model=MODEL,
                contents=prompt
            )
            elapsed = time.time() - start
            raw = response.text or ""
            parsed = parse_translation_response(raw)

            log(f"✅ Success {elapsed:.2f}s, parsed: {len(parsed)}")
            if not parsed:
                log("⚠️ Empty parse result")
                log(raw[:500])
                if attempt < RETRY_COUNT:
                    raise Exception("Empty parse result")
            return parsed

        except Exception as e:
            if isinstance(e, DailyLimitReached):
                raise
            log(f"❌ Error: {e}")
            if not is_retryable_error(e) or attempt >= RETRY_COUNT:
                raise
            # 指数退避 + 抖动，应对服务端高负载
            wait = RETRY_BASE * (2 ** (attempt - 1)) + random.uniform(0, 5)
            log(f"⏳ Retryable, waiting {wait:.1f}s...")
            time.sleep(wait)

    return {}


# ============================================================
# VTT Parser (支持单语 & 双语 VTT)
# ============================================================


def parse_vtt_cues(content: str) -> list[dict]:
    """
    健壮的 WebVTT 解析器。
    正确处理 cue 标识符、多行文本、内部空行、NOTE/STYLE/REGION 区域。
    同时支持：
      - 单语 VTT（scraper 爬取）：每 cue 1 行文本
      - 双语 VTT（transcribe 生成）：每 cue 2 行文本（英+中）
    """
    cues = []
    lines = content.splitlines()
    i = 0
    n = len(lines)

    # 跳过 WEBVTT 头和所有元数据区域
    while i < n:
        line_stripped = lines[i].strip()
        if line_stripped in ("WEBVTT", ""):
            i += 1
            continue
        if line_stripped.startswith(("NOTE", "STYLE", "REGION")):
            i += 1
            while i < n and lines[i].strip() != "":
                i += 1
            continue
        if "-->" in line_stripped:
            break
        if i + 1 < n and "-->" in lines[i + 1]:
            break
        i += 1

    while i < n:
        while i < n and lines[i].strip() == "":
            i += 1
        if i >= n:
            break

        identifier = None
        if i + 1 < n and "-->" in lines[i + 1]:
            identifier = lines[i].strip()
            i += 1

        if i >= n or "-->" not in lines[i]:
            i += 1
            continue

        timestamp = lines[i].strip()
        i += 1

        text_lines = []
        while i < n and lines[i].strip() != "":
            text_lines.append(lines[i])
            i += 1

        text = "\n".join(text_lines).strip()
        if text:
            cues.append(
                {"timestamp": timestamp, "text": text, "identifier": identifier}
            )

    return cues


# ============================================================
# WebVTT Speaker handling
# ============================================================


def extract_speaker(text):
    match = re.match(r"<v\s+([^>]+)>(.*)", text, re.DOTALL)
    if match:
        return (match.group(1).strip(), match.group(2).strip())
    return (None, text)


def prepare_gemini_text(text):
    """
    从 VTT cue 文本中提取需要翻译的英文原文。
    支持两种情况：
      1. 单语 VTT：直接返回文本（去除 speaker tag）
      2. 双语 VTT：只取第一行（英文），忽略第二行（已有中文）
    """
    lines = text.splitlines()
    # 如果是双语 VTT（2行），取第一行作为原文
    if len(lines) >= 2:
        # 检查第二行是否像中文（包含中文字符）
        second_line = lines[1].strip()
        if re.search(r"[\u4e00-\u9fff]", second_line):
            text = lines[0].strip()
        else:
            # 两行都是英文（可能是长句换行），合并
            text = " ".join(lines)
    else:
        text = lines[0].strip() if lines else text

    speaker, content = extract_speaker(text)
    if speaker:
        return content
    return text


def restore_speaker_translation(original, translated):
    speaker, _ = extract_speaker(original)
    if speaker:
        return f"<v {speaker}>{translated}"
    return translated


# ============================================================
# Batch chunking (按字符数动态分批)
# ============================================================


def chunk_cues_by_chars(cues, max_chars=MAX_BATCH_CHARS):
    """
    按字符数分批，替代固定 BATCH_SIZE。
    最大化利用 TPM，减少总请求数（对 RPD 免费层至关重要）。
    """
    batches = []
    current = []
    current_len = 500  # prompt 模板本身约 500 字符开销

    for i, cue in enumerate(cues):
        text = prepare_gemini_text(cue["text"])
        # 每个条目：序号 + "|||" + 文本 + 换行，估算 +15 字符开销
        item_len = len(text) + 15
        if current and (current_len + item_len > max_chars):
            batches.append(current)
            current = [(i, text)]
            current_len = 500 + item_len
        else:
            current.append((i, text))
            current_len += item_len

    if current:
        batches.append(current)
    return batches


# ============================================================
# Translate Episode (适配为多播客结构)
# ============================================================


def translate_episode(source, target, cache_meta):
    separator()
    log(f"📄 Translating {source.name}")
    separator()

    content = source.read_text(encoding="utf-8")
    cues = parse_vtt_cues(content)

    log(f"Cue blocks: {len(cues)}")
    if not cues:
        log("⚠️ No cues found, skipping")
        return

    translated = {}

    # 按字符数动态分批
    batches = chunk_cues_by_chars(cues)
    log(f"Batches: {len(batches)} (dynamic by ~{MAX_BATCH_CHARS} chars)")

    for batch_idx, batch in enumerate(batches, 1):
        group(f"Batch {batch_idx}/{len(batches)} ({batch[0][0]}-{batch[-1][0]})")
        result = gemini_batch_translate(batch, cache_meta)
        endgroup()
        for idx, value in result.items():
            translated[idx] = value

    # ------------------------------
    # 缺失块检测与单独重试
    # ------------------------------
    missing = [i for i in range(len(cues)) if i not in translated]
    if missing:
        log(f"⚠️ Missing {len(missing)} blocks, retrying individually...")
        for idx in missing:
            single = [(idx, prepare_gemini_text(cues[idx]["text"]))]
            result = gemini_batch_translate(single, cache_meta)
            if idx in result:
                translated[idx] = result[idx]

        still_missing = [i for i in range(len(cues)) if i not in translated]
        if still_missing:
            for i in still_missing[:10]:
                log(f"Still missing block {i}: {cues[i]['text'][:60]}...")
            raise RuntimeError(
                f"Translation incomplete: {len(still_missing)} blocks still missing"
            )

    # ------------------------------
    # 生成标准双语 VTT
    # 原文在上 (line:0%)，译文在下 (line:80%)
    # ------------------------------
    output = ["WEBVTT", ""]

    for i, cue in enumerate(cues):
        # 保留原始 cue 编号（如果有）
        if cue["identifier"]:
            output.append(cue["identifier"])
        output.append(cue["timestamp"])
        # 原文：如果是单语 VTT，输出原文；如果是双语 VTT，输出原文（第一行）
        original_text = cue["text"].splitlines()[0].strip() if cue["text"] else ""
        output.append(original_text)
        # 译文：恢复 speaker tag（如果有）
        output.append(restore_speaker_translation(cue["text"], translated[i]))
        output.append("")

    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_suffix(".tmp")
    temp.write_text("\n".join(output), encoding="utf-8")
    temp.replace(target)
    log(f"✅ Saved: {target}")


# ============================================================
# Main
# ============================================================


def main():
    separator()
    log("🚀 Translate VTT started")
    separator()
    log(f"Model: {MODEL}")
    log(f"Site dir: {SITE_DIR}")
    log(f"Max files: {MAX_FILES}")
    log(f"Max batch chars: {MAX_BATCH_CHARS}")
    log(f"RPM limit: {RPM_LIMIT} (interval: {MIN_REQUEST_INTERVAL:.2f}s)")
    log(f"Daily request limit: {DAILY_REQUEST_LIMIT}")

    podcasts = load_podcasts()
    if not podcasts:
        log("⚠️ No podcasts configured, exiting")
        return 0

    cache = load_cache()
    meta = cache.setdefault(
        "__meta__",
        {
            "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "daily_requests": 0,
        },
    )

    # 日期检查（跨天时重置计数器）
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if meta.get("date") != today:
        meta["date"] = today
        meta["daily_requests"] = 0
        log("🌅 New day, daily counter reset")

    processed_total = 0
    errors = []
    stopped_by_limit = False

    try:
        for podcast in podcasts:
            slug = podcast.get("slug")
            if not slug:
                log("⚠️ Podcast missing slug, skipping")
                continue

            input_dir = SITE_DIR / slug / "transcripts"
            output_dir = SITE_DIR / slug / "transcripts" / ZH_SUBDIR

            if not input_dir.exists():
                log(f"⚠️ Input dir not found: {input_dir}")
                continue

            files = sorted(
                input_dir.glob("*.vtt"),
                key=lambda x: int(x.stem) if x.stem.isdigit() else x.stem,
            )
            log(f"\n📻 Podcast: {slug} ({podcast.get('name', slug)})")
            log(f"Found VTT: {len(files)}")

            podcast_cache = cache.setdefault(slug, {})
            processed_podcast = 0

            for source in files:
                episode = source.stem

                separator()
                log(f"Processing episode {episode}")

                sha = file_hash(source)
                old = podcast_cache.get(episode)
                target = output_dir / source.name

                if (
                    old
                    and old.get("hash") == sha
                    and old.get("translated")
                    and target.exists()
                ):
                    log("⏭ Already translated")
                    continue

                if processed_total >= MAX_FILES:
                    log("MAX_FILES reached")
                    break

                if meta["daily_requests"] >= DAILY_REQUEST_LIMIT:
                    log("⚠️ Daily request limit reached, stopping gracefully")
                    stopped_by_limit = True
                    break

                try:
                    group(f"Episode {episode} ({slug})")
                    translate_episode(source, target, meta)
                    endgroup()

                    podcast_cache[episode] = {
                        "hash": sha,
                        "translated": True,
                        "updated": datetime.now(timezone.utc).isoformat(),
                    }
                    processed_total += 1
                    processed_podcast += 1

                except DailyLimitReached as e:
                    endgroup()
                    log(f"⚠️ {e}")
                    stopped_by_limit = True
                    break

                except Exception as e:
                    endgroup()
                    log(f"❌ Episode {episode} failed: {e}")
                    traceback.print_exc()
                    errors.append((slug, episode, str(e)))
                    continue  # 跳过失败的集数，继续下一集

            log(f"✅ Podcast {slug}: {processed_podcast} episode(s) translated this run")

            if processed_total >= MAX_FILES or stopped_by_limit:
                break

    finally:
        # 统一保存缓存，确保即使中断也能把 daily_requests 写回仓库
        save_cache(cache)

    separator()
    log("Finished")
    log(f"Total translated episodes: {processed_total}")
    if errors:
        log(f"Failed episodes: {len(errors)}")
        for slug, ep, err in errors:
            log(f"  - {slug}/{ep}: {err}")
    log(f"Daily requests used: {meta['daily_requests']}/{DAILY_REQUEST_LIMIT}")
    separator()

    if stopped_by_limit:
        log("⛔ Stopped due to daily API limit. Run again tomorrow to continue.")
        return 0  # Actions 里返回 0，workflow 继续提交进度
    elif errors:
        log("⚠️ Completed with errors.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
