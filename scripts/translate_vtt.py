#!/usr/bin/env python3
"""
Podcast VTT Translator
"""

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
from google.genai import types

PODCASTS_JSON = Path("podcasts_translate.json")
SITE_DIR = Path("site")
ZH_SUBDIR = "zh"
CACHE_FILE = Path("translations.json")


def _positive_int_env(name, default):
    """Read a positive integer setting and fail early with a useful message."""
    try:
        value = int(os.environ.get(name, default))
    except ValueError as error:
        raise ValueError(
            f"{name} must be an integer, got {os.environ[name]!r}"
        ) from error
    if value <= 0:
        raise ValueError(f"{name} must be greater than zero, got {value}")
    return value


MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")
MAX_FILES = _positive_int_env("MAX_FILES", "10")
MAX_BATCH_CHARS = _positive_int_env("MAX_BATCH_CHARS", "30000")
# Batches at or below 30 cues use Gemini's structured JSON response, which is
# substantially less prone to dropped or reordered lines than delimiter text.
MAX_BATCH_BLOCKS = _positive_int_env("MAX_BATCH_BLOCKS", "30")
RETRY_COUNT = 3
RETRY_BASE = 10
# A 504 generally reflects temporary service-side pressure. Pause requests
# before retrying instead of repeatedly splitting and resubmitting the content.
DEADLINE_COOLDOWN_SECONDS = _positive_int_env("DEADLINE_COOLDOWN_SECONDS", "2")
RPM_LIMIT = _positive_int_env("RPM_LIMIT", "14")
MIN_REQUEST_INTERVAL = 60.0 / RPM_LIMIT
DAILY_REQUEST_LIMIT = _positive_int_env("DAILY_REQUEST_LIMIT", "15000")
TEMPERATURE = float(os.environ.get("TEMPERATURE", "0.0"))
USE_JSON_SCHEMA = os.environ.get("USE_JSON_SCHEMA", "true").lower() == "true"
# When Gemini blocks a batch at prompt level, locate the smallest offending cue
# instead of repeatedly retrying the same large prompt.
SENSITIVE_FALLBACK = os.environ.get("SENSITIVE_FALLBACK", "true").lower() == "true"
SENSITIVE_MAX_DIAGNOSTIC_RETRIES = _positive_int_env(
    "SENSITIVE_MAX_DIAGNOSTIC_RETRIES", "1"
)
IN_ACTIONS = os.environ.get("GITHUB_ACTIONS") == "true"

if IN_ACTIONS:
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
    if IN_ACTIONS:
        print(f"::group::{title}", flush=True)
    else:
        log(f"\n>>> {title}")


def endgroup():
    if IN_ACTIONS:
        print("::endgroup::", flush=True)


client = None


def initialize_client():
    """Create the API client only when the command is actually run."""
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is required to translate subtitles")
    return genai.Client(api_key=api_key, http_options={"timeout": 120000})


_last_request_time = 0.0


def _rate_limit_wait():
    global _last_request_time
    now = time.time()
    elapsed = now - _last_request_time
    if elapsed < MIN_REQUEST_INTERVAL:
        sleep_time = MIN_REQUEST_INTERVAL - elapsed
        log(f"⏳ Rate limit: sleeping {sleep_time:.2f}s")
        time.sleep(sleep_time)
    _last_request_time = time.time()


class DailyLimitReached(Exception):
    pass


class IndexMismatchError(Exception):
    def __init__(self, message, partial_result=None):
        super().__init__(message)
        self.partial_result = partial_result or {}


class RepetitionError(Exception):
    pass


class ProhibitedContentError(Exception):
    def __init__(self, message, block_reason=None, block_reason_message=None):
        super().__init__(message)
        self.block_reason = block_reason
        self.block_reason_message = block_reason_message


QUOTA_ERROR_MARKERS = (
    "resource_exhausted",
    "quota exceeded",
    "exceeded your current quota",
    "billing",
    "insufficient quota",
    "quota limit",
)


def is_quota_error(error):
    return any(marker in str(error).lower() for marker in QUOTA_ERROR_MARKERS)


def is_deadline_exceeded(error):
    error_text = str(error).lower()
    return "deadline_exceeded" in error_text or (
        "504" in error_text and "deadline" in error_text
    )


def cooldown_after_deadline():
    log(
        f"⏸️ Deadline exceeded; cooling down for {DEADLINE_COOLDOWN_SECONDS}s "
        "before the next retry"
    )
    time.sleep(DEADLINE_COOLDOWN_SECONDS)


def load_podcasts():
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
    temp_file = CACHE_FILE.with_suffix(f"{CACHE_FILE.suffix}.tmp")
    temp_file.write_text(
        json.dumps(cache, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    temp_file.replace(CACHE_FILE)
    log("💾 Cache saved")


def file_hash(path):
    sha = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            chunk = f.read(8192)
            if not chunk:
                break
            sha.update(chunk)
    return sha.hexdigest()


def _translation_context():
    return (
        "You are translating an existing transcript from a documentary or true-crime podcast. "
        "This is a TRANSLATION task, not a request to create new content. "
        "The source may contain sensitive or disturbing material, including descriptions or quotations "
        "about crime, violence, injury, death, abuse, sexual assault, sexual content, minors, drugs, "
        "weapons, self-harm, suicide, murder, or other upsetting events. "
        "Translate only what is already present in the source. "
        "Do not add facts, instructions, advice, encouragement, graphic embellishment, or procedural detail. "
        "Do not turn the source into a how-to guide. Do not role-play. Do not endorse the events. "
        "Do not moralize, warn, censor, sanitize, summarize, merge, or omit content merely because it is sensitive. "
        "Preserve names, numbers, uncertainty, relationships, speaker meaning, and tone as faithfully as possible. "
        "If the source contains a quotation, translate the quotation as a quotation. "
        "Return only the requested translations."
    )


def build_prompt_text(blocks):
    content = []
    for idx, text in blocks:
        content.append(f"{idx}|||{text}")
    joined = "\n\n".join(content)
    return (
        _translation_context()
        + "\n\nFor each subtitle block, output exactly one line in the format "
        "index|||Simplified Chinese translation. "
        "Keep every input index exactly once, in the same order. "
        "Do not output English, commentary, markdown, headings, or code fences. "
        "Do not combine two blocks into one translation.\n\n" + joined
    )


def build_prompt_json(blocks):
    content = {str(idx): text for idx, text in blocks}
    return (
        _translation_context()
        + "\n\nTranslate every value in the following JSON object into Simplified Chinese. "
        "Return one JSON object with exactly the same keys. "
        "Each value must contain only the corresponding Chinese translation. "
        "Do not add or remove keys. Do not summarize, merge, or reorder the blocks.\n\n"
        f"Input JSON: {json.dumps(content, ensure_ascii=False)}"
    )


def build_single_block_prompt(block):
    idx, text = block
    return (
        _translation_context()
        + "\n\nTranslate this single existing subtitle block into Simplified Chinese. "
        "The number before the delimiter is an identifier, not part of the source text. "
        "Return exactly one line: index|||translation. "
        "Do not add any other text.\n\n"
        f"{idx}|||{text}"
    )


def parse_translation_response_text(text, expected_indices):
    result = {}
    if not text:
        return result, False, "Empty response"
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
                index = int(idx)
                if index in result:
                    return result, False, f"Duplicate translation for index {index}"
                result[index] = value
        except Exception:
            continue
    return _validate_indices(result, expected_indices)


def parse_translation_response_json(text, expected_indices):
    result = {}
    if not text:
        return result, False, "Empty response"

    class JSONObjectPairs(list):
        pass

    try:
        data = json.loads(text, object_pairs_hook=JSONObjectPairs)
        if not isinstance(data, JSONObjectPairs):
            return result, False, "JSON root is not an object"
        for k, v in data:
            try:
                idx = int(k)
                if isinstance(v, str) and v.strip():
                    if idx in result:
                        return result, False, f"Duplicate translation for index {idx}"
                    result[idx] = v.strip()
            except (ValueError, TypeError):
                continue
    except json.JSONDecodeError as e:
        return result, False, f"JSON parse error: {e}"
    return _validate_indices(result, expected_indices)


def _validate_indices(result, expected_indices):
    actual_indices = set(result.keys())
    if actual_indices != expected_indices:
        missing = expected_indices - actual_indices
        extra = actual_indices - expected_indices
        msg = f"Index mismatch: expected {len(expected_indices)}, got {len(actual_indices)}"
        if missing:
            msg += f"; missing {len(missing)}: {sorted(missing)[:10]}"
        if extra:
            msg += f"; extra {len(extra)}: {sorted(extra)[:10]}"
        return result, False, msg
    return result, True, ""


def detect_repetition(text, threshold=3):
    if not text:
        return False
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    if len(lines) < threshold * 2:
        return False
    last_n = lines[-threshold:]
    return len(set(last_n)) == 1


def is_retryable_error(error):
    """
    判断错误是否值得重试。
    关键区分：
      - RPM 超限 (Too Many Requests / rate limit) → 等一会儿重试
      - 配额耗尽 (RESOURCE_EXHAUSTED / quota exceeded / billing) → 立即停止
    """
    err_str = str(error).lower()
    # 配额耗尽 —— 立即停止，不重试
    if is_quota_error(error):
        return False
    # 可恢复的服务端/网络错误 —— 可以重试
    retryable = [
        "too many requests",
        "rate limit",
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


def _get_prompt_block_reason(response):
    feedback = getattr(response, "prompt_feedback", None)
    reason = getattr(feedback, "block_reason", None) if feedback else None
    message = getattr(feedback, "block_reason_message", None) if feedback else None
    return reason, message


def log_empty_response_details(response):
    reason, message = _get_prompt_block_reason(response)
    candidates = getattr(response, "candidates", None) or []
    if reason:
        log(
            f"   prompt_feedback: block_reason={reason!s} "
            f"block_reason_message={message!r} candidates={len(candidates)}"
        )
    else:
        log(f"   prompt_feedback: none; candidates={len(candidates)}")
    for i, candidate in enumerate(candidates[:3]):
        log(
            f"   candidate[{i}]: finish_reason={getattr(candidate, 'finish_reason', None)!s} "
            f"finish_message={getattr(candidate, 'finish_message', None)!r}"
        )


def _raise_if_prompt_blocked(response):
    reason, message = _get_prompt_block_reason(response)
    if reason is not None:
        reason_text = str(reason).upper()
        if any(x in reason_text for x in ("PROHIBITED_CONTENT", "SAFETY", "BLOCKLIST")):
            raise ProhibitedContentError(
                f"Gemini prompt blocked: {reason_text}", reason_text, message
            )


def gemini_batch_translate(blocks, cache_meta):
    global _last_request_time
    expected_indices = {idx for idx, _ in blocks}
    use_json = USE_JSON_SCHEMA and len(blocks) <= 60

    for attempt in range(1, RETRY_COUNT + 1):
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
            f"(attempt {attempt}/{RETRY_COUNT}), blocks: {len(blocks)}, "
            f"json={use_json}"
        )

        try:
            if use_json:
                prompt = build_prompt_json(blocks)
                schema = build_response_schema(blocks)
                response = client.models.generate_content(
                    model=MODEL,
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        temperature=TEMPERATURE,
                        response_mime_type="application/json",
                        response_schema=schema,
                    ),
                )
                raw = response.text or ""
                if not raw:
                    log(
                        "⚠️ Gemini returned an empty text response; inspecting response metadata..."
                    )
                    log_empty_response_details(response)
                _raise_if_prompt_blocked(response)
                parsed, is_valid, err_msg = parse_translation_response_json(
                    raw, expected_indices
                )
            else:
                prompt = build_prompt_text(blocks)
                response = client.models.generate_content(
                    model=MODEL,
                    contents=prompt,
                    config=types.GenerateContentConfig(temperature=TEMPERATURE),
                )
                raw = response.text or ""
                if not raw:
                    log(
                        "⚠️ Gemini returned an empty text response; inspecting response metadata..."
                    )
                    log_empty_response_details(response)
                _raise_if_prompt_blocked(response)
                if detect_repetition(raw):
                    log(f"⚠️ Repetition detected in response")
                    raise RepetitionError(
                        "Model output appears to be in a repetition loop"
                    )
                parsed, is_valid, err_msg = parse_translation_response_text(
                    raw, expected_indices
                )

            if not is_valid:
                log(f"⚠️ Parse/Index error: {err_msg}")
                raise IndexMismatchError(err_msg, parsed)

            log(f"✅ Success {time.time() - start:.2f}s, parsed: {len(parsed)}")
            return parsed

        except Exception as e:
            if isinstance(e, (DailyLimitReached, IndexMismatchError, RepetitionError)):
                raise
            log(f"❌ Error: {e}")
            # 配额耗尽 —— 直接停止整个程序，不再重试
            if is_quota_error(e):
                log("⛔ API quota exhausted. Stopping immediately.")
                raise DailyLimitReached(f"API quota exhausted: {e}")
            if not is_retryable_error(e) or attempt >= RETRY_COUNT:
                raise
            if is_deadline_exceeded(e):
                cooldown_after_deadline()
                continue
            wait = RETRY_BASE * (2 ** (attempt - 1)) + random.uniform(0, 5)
            log(f"⏳ Retryable, waiting {wait:.1f}s...")
            time.sleep(wait)

    return {}


def translate_single_sensitive_block(block, cache_meta):
    """Retry one blocked subtitle with the narrowest legitimate translation prompt."""
    idx, text = block
    expected = {idx}
    for attempt in range(1, SENSITIVE_MAX_DIAGNOSTIC_RETRIES + 1):
        daily_used = cache_meta.get("daily_requests", 0)
        if daily_used >= DAILY_REQUEST_LIMIT:
            raise DailyLimitReached(
                f"Daily request limit reached: {daily_used}/{DAILY_REQUEST_LIMIT}"
            )
        cache_meta["daily_requests"] = daily_used + 1
        _rate_limit_wait()
        log(f"   🔎 Sensitive single-cue retry #{idx} (attempt {attempt})")
        try:
            response = client.models.generate_content(
                model=MODEL,
                contents=build_single_block_prompt(block),
                config=types.GenerateContentConfig(temperature=TEMPERATURE),
            )
            raw = response.text or ""
            if not raw:
                log_empty_response_details(response)
            _raise_if_prompt_blocked(response)
            parsed, valid, err = parse_translation_response_text(raw, expected)
            if valid:
                return parsed
            raise IndexMismatchError(err, parsed)
        except ProhibitedContentError:
            raise
        except DailyLimitReached:
            raise
        except Exception as e:
            if not is_retryable_error(e) or attempt >= SENSITIVE_MAX_DIAGNOSTIC_RETRIES:
                raise
            wait = RETRY_BASE * attempt + random.uniform(0, 3)
            log(f"   ⏳ Single-cue retryable error, waiting {wait:.1f}s")
            time.sleep(wait)
    raise RuntimeError(f"Unable to translate single cue #{idx}")


def safe_translate_batch(blocks, cache_meta):
    if not blocks:
        return {}
    try:
        return gemini_batch_translate(blocks, cache_meta)
    except ProhibitedContentError as e:
        if not SENSITIVE_FALLBACK:
            raise
        if len(blocks) == 1:
            block = blocks[0]
            try:
                return translate_single_sensitive_block(block, cache_meta)
            except ProhibitedContentError as single_error:
                log(
                    f"   🚫 Single cue #{block[0]} remains blocked "
                    f"({single_error.block_reason}); preserving source text as fallback."
                )
                return {block[0]: block[1]}
        log(
            f"   🚫 Sensitive batch ({len(blocks)} cues) blocked by Gemini; "
            "splitting only to localize blocked cue(s)"
        )
        mid = len(blocks) // 2
        left = safe_translate_batch(blocks[:mid], cache_meta)
        right = safe_translate_batch(blocks[mid:], cache_meta)
        return {**left, **right}
    except IndexMismatchError as e:
        expected_indices = {idx for idx, _ in blocks}
        partial_result = {
            idx: value
            for idx, value in e.partial_result.items()
            if idx in expected_indices
        }
        missing_blocks = [block for block in blocks if block[0] not in partial_result]

        # A truncated response often contains a valid prefix. Preserve it and
        # defer missing-cue recovery until every initial batch in the episode
        # has finished, so the missing cues can be retried together.
        if (
            partial_result
            and missing_blocks
            and len(partial_result) == len(e.partial_result)
        ):
            log(
                f"   Incomplete batch: preserving {len(partial_result)} cues and "
                f"deferring {len(missing_blocks)} missing cues for episode recovery"
            )
            return partial_result

        if len(blocks) == 1:
            raise
        log(f"   Invalid batch ({len(blocks)} cues), splitting for recovery: {e}")
        mid = len(blocks) // 2
        left = safe_translate_batch(blocks[:mid], cache_meta)
        right = safe_translate_batch(blocks[mid:], cache_meta)
        return {**left, **right}
    except RepetitionError as e:
        if len(blocks) == 1:
            log(f"   ❌ Single block #{blocks[0][0]} failed: {e}")
            raise
        log(f"   ⚠️ Batch ({len(blocks)} blocks) failed: {e}")
        mid = len(blocks) // 2
        left = safe_translate_batch(blocks[:mid], cache_meta)
        right = safe_translate_batch(blocks[mid:], cache_meta)
        result = {**left, **right}
        log(f"   ✅ Fallback done: {len(result)}/{len(blocks)}")
        return result


def parse_vtt_cues(content):
    cues = []
    lines = content.splitlines()
    i = 0
    n = len(lines)

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


def is_bilingual_cue(text):
    lines = text.splitlines()
    if len(lines) >= 2:
        return bool(re.search(r"[\u4e00-\u9fff]", lines[1].strip()))
    return False


def extract_speaker(text):
    match = re.match(r"<v\s+([^>]+)>(.*)", text, re.DOTALL)
    if match:
        return (match.group(1).strip(), match.group(2).strip())
    return (None, text)


def prepare_gemini_text(text):
    lines = text.splitlines()
    if len(lines) >= 2:
        if is_bilingual_cue(text):
            text = lines[0].strip()
        else:
            text = " ".join(lines)
    else:
        text = lines[0].strip() if lines else text

    speaker, content = extract_speaker(text)
    if speaker:
        return content
    return text


def get_original_text(text):
    if is_bilingual_cue(text):
        return text.splitlines()[0].strip()
    return text.strip()


def restore_speaker_translation(original, translated):
    speaker, _ = extract_speaker(original)
    if speaker:
        return f"<v {speaker}>{translated}"
    return translated


def chunk_cues_by_chars(cues, max_chars=MAX_BATCH_CHARS, max_blocks=MAX_BATCH_BLOCKS):
    batches = []
    current = []
    current_len = 500

    for i, cue in enumerate(cues):
        text = prepare_gemini_text(cue["text"])
        item_len = len(text) + 15
        if current and (
            current_len + item_len > max_chars or len(current) >= max_blocks
        ):
            batches.append(current)
            current = [(i, text)]
            current_len = 500 + item_len
        else:
            current.append((i, text))
            current_len += item_len

    if current:
        batches.append(current)
    return batches


def chunk_blocks(blocks, max_blocks=MAX_BATCH_BLOCKS):
    """将扁平的 block 列表按 max_blocks 切分成多个 batch"""
    batches = []
    current = []
    for block in blocks:
        if current and len(current) >= max_blocks:
            batches.append(current)
            current = [block]
        else:
            current.append(block)
    if current:
        batches.append(current)
    return batches


def translate_episode(source, target, cache_meta, current=None, total=None):
    # 构建进度前缀
    progress_prefix = f"[{current}/{total}] " if current and total else ""

    separator()
    log(f"{progress_prefix}📄 Translating {source.name}")
    separator()

    content = source.read_text(encoding="utf-8")
    cues = parse_vtt_cues(content)

    log(f"{progress_prefix}Cue blocks: {len(cues)}")
    if not cues:
        log(f"{progress_prefix}⚠️ No cues found, skipping")
        return

    translated = {}

    batches = chunk_cues_by_chars(cues)
    log(
        f"{progress_prefix}Batches: {len(batches)} (max {MAX_BATCH_CHARS} chars, {MAX_BATCH_BLOCKS} blocks)"
    )

    for batch_idx, batch in enumerate(batches, 1):
        group(
            f"{progress_prefix}Batch {batch_idx}/{len(batches)} ({batch[0][0]}-{batch[-1][0]})"
        )
        try:
            result = safe_translate_batch(batch, cache_meta)
        except Exception as e:
            endgroup()
            log(f"{progress_prefix}❌ Batch {batch_idx} failed after all retries: {e}")
            raise
        endgroup()
        for idx, value in result.items():
            translated[idx] = value

    missing = [i for i in range(len(cues)) if i not in translated]
    if missing:
        # 聚合缺失 cues，按更小的 batch size 重试，避免逐个单发
        missing_blocks = [
            (idx, prepare_gemini_text(cues[idx]["text"])) for idx in missing
        ]
        retry_batches = chunk_blocks(
            missing_blocks, max_blocks=min(MAX_BATCH_BLOCKS, 30)
        )
        log(
            f"{progress_prefix}⚠️ Missing {len(missing)} blocks, retrying in {len(retry_batches)} batch(es)..."
        )

        for batch_idx, batch in enumerate(retry_batches, 1):
            log(
                f"{progress_prefix}   Retry batch {batch_idx}/{len(retry_batches)} ({len(batch)} blocks)"
            )
            try:
                result = safe_translate_batch(batch, cache_meta)
                for idx, value in result.items():
                    translated[idx] = value
            except Exception as e:
                log(f"{progress_prefix}   Retry batch {batch_idx} failed: {e}")

        still_missing = [i for i in range(len(cues)) if i not in translated]
        if still_missing:
            for i in still_missing[:10]:
                log(
                    f"{progress_prefix}Still missing block {i}: {cues[i]['text'][:60]}..."
                )
            raise RuntimeError(
                f"Translation incomplete: {len(still_missing)} blocks still missing"
            )

    output = ["WEBVTT", ""]

    for i, cue in enumerate(cues):
        if cue["identifier"]:
            output.append(cue["identifier"])
        output.append(cue["timestamp"])
        output.append(get_original_text(cue["text"]))
        output.append(restore_speaker_translation(cue["text"], translated[i]))
        output.append("")

    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_suffix(".tmp")
    temp.write_text("\n".join(output), encoding="utf-8")
    temp.replace(target)
    log(f"{progress_prefix}✅ Saved: {target}")


def main():
    global client
    group("Initializing Gemini")
    try:
        client = initialize_client()
        log("Gemini initialized")
    finally:
        endgroup()

    separator()
    log("🚀 Translate VTT started")
    separator()
    log(f"Model: {MODEL}")
    log(f"Temperature: {TEMPERATURE}")
    log(f"JSON schema: {USE_JSON_SCHEMA}")
    log(f"Sensitive-content fallback: {SENSITIVE_FALLBACK}")
    log(f"Site dir: {SITE_DIR}")
    log(f"Max files: {MAX_FILES}")
    log(f"Max batch chars: {MAX_BATCH_CHARS}")
    log(f"Max batch blocks: {MAX_BATCH_BLOCKS}")
    log(f"Deadline cooldown: {DEADLINE_COOLDOWN_SECONDS}s")
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

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if meta.get("date") != today:
        meta["date"] = today
        meta["daily_requests"] = 0
        log("🌅 New day, daily counter reset")

    episode_positions = {}
    for podcast in podcasts:
        slug = podcast.get("slug")
        input_dir = SITE_DIR / slug / "transcripts" if slug else None
        if input_dir and input_dir.exists():
            files = sorted(
                input_dir.glob("*.vtt"),
                key=lambda path: int(path.stem) if path.stem.isdigit() else path.stem,
            )
            for source in files:
                episode_positions[source] = len(episode_positions) + 1
    total_episodes = len(episode_positions)
    log(f"Total VTT episodes: {total_episodes}")

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

            for episode_position, source in enumerate(files, start=1):
                episode = source.stem

                separator()
                log(
                    f"Processing episode {episode} "
                    f"(podcast {episode_position}/{len(files)}, "
                    f"overall {episode_positions[source]}/{total_episodes})"
                )

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
                    # 传入当前集数和总集数
                    translate_episode(
                        source,
                        target,
                        meta,
                        current=processed_total + 1,  # 当前是本次任务第几集
                        total=MAX_FILES,  # 本次任务总共要处理几集
                    )
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
                    continue

            log(
                f"✅ Podcast {slug}: {processed_podcast} episode(s) translated this run"
            )

            if processed_total >= MAX_FILES or stopped_by_limit:
                break

    finally:
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
        return 0
    elif errors:
        log("⚠️ Completed with errors.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
