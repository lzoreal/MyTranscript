"""把抓取来的 VTT 对齐到音频，产出逐词时间 sidecar（TMLT 机制的移植）。"""

from __future__ import annotations

import json
import os
import re
import statistics
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import transcribe  # noqa: E402  （复用下载、sidecar 结构、断点语义）

GROUP_MAX_CHARS = 900
GROUP_MAX_SPAN = 100.0

TIMESTAMP = re.compile(r"(\d+):(\d\d):([\d.]+)\s*-->\s*(\d+):(\d\d):([\d.]+)")




PAD = 3.0
TAIL_PAD = 8.0
NOMINAL_CPS = 15.0
SLOWEST_CPS = 4.0




EARLY_TOLERANCE = 8.0
LATE_TOLERANCE = 8.0
# 单条 cue 的锚点误差实测可达 ±25 秒，时间边界必须比它宽
CUE_TIME_TOLERANCE = 60.0


CONTINUATION_PREFIXES = ("-", ".", "'", "’")




SR = 16000
MISMATCH_MEDIAN = 3.0



def decode_audio(path: Path):
    """解成 16 kHz 单声道 float32。"""
    import av
    import numpy as np

    chunks = []
    with av.open(str(path)) as container:
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="flt", layout="mono", rate=SR)
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray().reshape(-1))
    return np.concatenate(chunks).astype("float32")



RECENT_DAYS = 30


def _published(entry: dict[str, Any]) -> datetime | None:
    raw = entry.get("published") or ""
    try:
        from email.utils import parsedate_to_datetime

        stamp = parsedate_to_datetime(raw)
        return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def build_candidates(
    shows: list[dict[str, Any]],
    mode: str,
    latest_per_show: int = 20,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    """按模式挑选需要对齐的集；sidecar 已完成或尝试超限的集跳过。"""
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=RECENT_DAYS)
    candidates: list[dict[str, Any]] = []
    seen_paths: set[Path] = set()
    for show in shows:
        slug = show["slug"]
        entries = show["entries"]
        processed = show["processed"]
        picked: list[tuple[dict[str, Any], Path]] = []
        for entry in entries:
            info = processed.get(entry["guid"])
            if not info or not info.get("vtt_filename"):
                continue
            vtt_path = transcribe.SITE_DIR / slug / "transcripts" / info["vtt_filename"]
            if not vtt_path.exists() or not transcribe.is_valid_bilingual_vtt(vtt_path):
                continue
            complete, attempts = transcribe.sidecar_status(
                transcribe.sidecar_path_for(vtt_path)
            )
            if complete or attempts >= transcribe.BACKFILL_MAX_ATTEMPTS:
                continue
            if mode == "recent":
                stamp = _published(entry)
                if stamp is None or stamp < cutoff:
                    continue
            picked.append((entry, vtt_path))
        if mode == "latest":
            picked = picked[:latest_per_show]
        for entry, vtt_path in picked:
            if vtt_path in seen_paths:
                continue
            seen_paths.add(vtt_path)
            candidates.append(
                {
                    "slug": slug,
                    "identity": entry["guid"],
                    "title": entry["title"],
                    "audio_url": entry["url"],
                    "vtt_path": vtt_path,
                }
            )
    return candidates


def run_align(
    candidates: list[dict[str, Any]],
    shard: int,
    shards: int,
    max_minutes: float,
    process=None,
    clock=None,
) -> dict[str, int]:
    """跑一个分片：预算到点即停；单集结果分别计数。"""
    if process is None:
        raise ValueError("run_align 需要注入 process")
    clock = clock or time.monotonic
    deadline = clock() + max_minutes * 60
    stats = {"done": 0, "rejected": 0, "failed": 0, "skipped": 0}
    for item in candidates:
        if transcribe.shard_of(item["identity"], shards) != shard:
            stats["skipped"] += 1
            continue
        if clock() >= deadline:
            print(f"分片 {shard} 预算用完，已完成 {stats['done']} 集")
            break
        outcome = process(item)
        stats[outcome] = stats.get(outcome, 0) + 1
    print(
        f"分片 {shard} 结束：done {stats['done']}，rejected {stats['rejected']}，"
        f"failed {stats['failed']}，skipped {stats['skipped']}"
    )
    return stats


ROOT = Path(__file__).resolve().parent.parent


def process_candidate(item: dict[str, Any], model=None) -> str:
    """重写一集：转写 → 映射 → 分流 → 重写 VTT 与 sidecar。"""
    model = model or load_model()
    with tempfile.TemporaryDirectory(prefix="align-audio-") as temp_dir:
        return rewrite_episode(
            item["vtt_path"], item["audio_url"], model, workdir=Path(temp_dir)
        )


def load_model():
    import stable_whisper as sw

    threads = int(os.getenv("ALIGN_THREADS", "0")) or (os.cpu_count() or 1)
    return sw.load_faster_whisper(
        transcribe.WHISPER_MODEL,
        device="cpu",
        compute_type="int8",
        cpu_threads=threads,
    )


def align_env() -> dict[str, Any]:
    mode = (os.getenv("ALIGN_MODE", "recent") or "recent").strip().lower()
    if mode not in ("recent", "latest"):
        raise ValueError(f"ALIGN_MODE 只能是 recent 或 latest：{mode}")
    shards = int(os.getenv("ALIGN_SHARDS", "20") or 20)
    shard = int(os.getenv("ALIGN_SHARD", "0") or 0)
    max_minutes = float(os.getenv("ALIGN_MAX_MINUTES", "150") or 150)
    latest = int(os.getenv("ALIGN_LATEST_PER_SHOW", "20") or 20)
    if shards < 1 or not 0 <= shard < shards:
        raise ValueError(f"分片配置非法：shard={shard} shards={shards}")
    if max_minutes <= 0:
        raise ValueError(f"预算非法：{max_minutes}")
    if latest < 1:
        raise ValueError(f"ALIGN_LATEST_PER_SHOW 非法：{latest}")
    return {
        "mode": mode,
        "shard": shard,
        "shards": shards,
        "max_minutes": max_minutes,
        "latest": latest,
    }


def collect_shows(podcasts: list[dict[str, Any]], progress: dict[str, Any]) -> list[dict[str, Any]]:
    shows = []
    for podcast in podcasts:
        slug = podcast["slug"]
        _, entries = transcribe.get_feed_entries(podcast["feed_url"])
        processed = progress.get("podcasts", {}).get(slug, {}).get("processed", {})
        shows.append(
            {
                "slug": slug,
                "entries": [
                    {
                        "guid": str(getattr(entry, "id", "") or ""),
                        "title": transcribe.clean_text(getattr(entry, "title", "") or ""),
                        "published": str(getattr(entry, "published", "") or ""),
                        "url": transcribe.get_entry_audio_url(entry),
                    }
                    for entry in entries
                ],
                "processed": processed,
            }
        )
    return shows


def main() -> int:
    env = align_env()
    podcasts = json.loads((ROOT / "podcasts.json").read_text(encoding="utf-8"))
    progress = json.loads((ROOT / "progress.json").read_text(encoding="utf-8"))
    shows = collect_shows(podcasts, progress)
    candidates = build_candidates(shows, mode=env["mode"], latest_per_show=env["latest"])
    print(
        f"对齐模式 {env['mode']}：分片 {env['shard']}/{env['shards']}，"
        f"预算 {env['max_minutes']:.0f} 分钟，候选 {len(candidates)} 集"
    )
    run_align(
        candidates,
        shard=env["shard"],
        shards=env["shards"],
        max_minutes=env["max_minutes"],
        process=process_candidate,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


def split_blocks(text: str) -> list[str]:
    """按空行切块；统一 CRLF，避免正则里的转义在脚本里被误写。"""
    normalized = text.replace(chr(13) + chr(10), chr(10)).replace(chr(13), chr(10))
    return [block for block in normalized.split(chr(10) + chr(10)) if block.strip()]


def _seconds(match, offset: int) -> float:
    return (
        int(match.group(1 + offset)) * 3600
        + int(match.group(2 + offset)) * 60
        + float(match.group(3 + offset))
    )


def timestamp(value: float) -> str:
    ms = int(round(value * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d}.{ms % 1000:03d}"


def parse_vtt_blocks(path: Path) -> list[dict[str, Any]]:
    """通用解析：每块保留全部文本行（行数取决于文件形态）。"""
    blocks: list[dict[str, Any]] = []
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    for block in split_blocks(text):
        lines = [line.strip() for line in block.strip().split(chr(10)) if line.strip()]
        stamp = next((line for line in lines if "-->" in line), None)
        if not stamp:
            continue
        match = TIMESTAMP.search(stamp)
        if not match:
            continue
        body = [line for line in lines if "-->" not in line and not line.isdigit()]
        if not body:
            continue
        blocks.append(
            {
                "start": _seconds(match, 0),
                "end": _seconds(match, 3),
                "lines": body,
            }
        )
    return blocks


def parse_english_vtt(path: Path) -> list[dict[str, Any]]:
    """transcripts/<stem>.vtt 只有英文一行。"""
    return [
        {"start": block["start"], "end": block["end"], "en": block["lines"][0]}
        for block in parse_vtt_blocks(path)
    ]


def parse_bilingual_vtt(path: Path) -> list[dict[str, Any]]:
    """读双语 VTT：每块必须同时有英文与中文，缺译文或缺时间戳的块忽略。"""
    cues: list[dict[str, Any]] = []
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    for block in split_blocks(text):
        lines = [line.strip() for line in block.strip().split(chr(10)) if line.strip()]
        stamp = next((line for line in lines if "-->" in line), None)
        if not stamp:
            continue
        match = TIMESTAMP.search(stamp)
        if not match:
            continue
        body = [line for line in lines if "-->" not in line and not line.isdigit()]
        if len(body) < 2:
            continue
        cues.append(
            {
                "start": _seconds(match, 0),
                "end": _seconds(match, 3),
                "en": body[0],
                "zh": body[1],
            }
        )
    return cues


def render_english_vtt(cues: list[dict[str, Any]]) -> str:
    blocks = ["WEBVTT", ""]
    for index, cue in enumerate(cues, 1):
        blocks.extend(
            [
                str(index),
                f"{timestamp(cue['start'])} --> {timestamp(cue['end'])}",
                cue["en"],
                "",
            ]
        )
    return chr(10).join(blocks).rstrip() + chr(10)


def render_vtt(cues: list[dict[str, Any]]) -> str:
    blocks = ["WEBVTT", ""]
    for index, cue in enumerate(cues, 1):
        blocks.extend(
            [
                str(index),
                f"{timestamp(cue['start'])} --> {timestamp(cue['end'])}",
                cue["en"],
                cue["zh"],
                "",
            ]
        )
    return chr(10).join(blocks).rstrip() + chr(10)


def validate_vtt(text: str, blocks: int, bilingual: bool) -> None:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "WEBVTT":
        raise ValueError("缺少 WEBVTT 头")
    # 不能先过滤空行——空行正是块分隔符
    cue_blocks = split_blocks(chr(10).join(lines[1:]))
    if len(cue_blocks) != blocks or blocks < 1:
        raise ValueError(f"块数不符：{len(cue_blocks)} != {blocks}")
    previous_end = -1.0
    for block in cue_blocks:
        rows = block.strip().split(chr(10))
        expected = 4 if bilingual else 3
        if len(rows) != expected:
            raise ValueError(f"块结构异常：{len(rows)} 行")
        match = TIMESTAMP.search(rows[1])
        if not match:
            raise ValueError("时间行无法解析")
        start, end = _seconds(match, 0), _seconds(match, 3)
        if start < previous_end:
            raise ValueError("时间未单调递增")
        if not 0 < end - start < 300:
            raise ValueError(f"时长异常：{end - start:.2f}s")
        previous_end = end


CONTINUATION_PREFIXES = ("-", ".", "'", chr(8217))


def normalize_tokens(text: str) -> list[str]:
    """小写、去标点、把被拆开的续接词并回前一个词。"""
    merged: list[str] = []
    for raw in text.split():
        if merged and raw[:1] in CONTINUATION_PREFIXES:
            merged[-1] += raw
        else:
            merged.append(raw)
    cleaned = (re.sub(r"[^a-z0-9]", "", token.lower()) for token in merged)
    return [token for token in cleaned if token]


def cue_token_spans(cues) -> tuple[list[str], list[tuple[int, int]]]:
    tokens: list[str] = []
    spans: list[tuple[int, int]] = []
    for cue in cues:
        start = len(tokens)
        tokens.extend(normalize_tokens(cue["en"]))
        spans.append((start, len(tokens)))
    return tokens, spans


def map_stream(pods: list[str], ours: list[str]) -> tuple[dict[int, int], float]:
    """全局序列对齐：equal 块一一对应，replace 块按比例对应，insert/delete 不给映射。"""
    from difflib import SequenceMatcher

    matcher = SequenceMatcher(None, pods, ours, autojunk=False)
    mapping: dict[int, int] = {}
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for offset in range(i2 - i1):
                mapping[i1 + offset] = j1 + offset
        elif tag == "replace" and j2 > j1:
            for offset in range(i2 - i1):
                mapped = j1 + int((offset + 0.5) * (j2 - j1) / (i2 - i1))
                mapping[i1 + offset] = min(mapped, j2 - 1)
    return mapping, matcher.ratio()


BODY_MIN_COVERAGE = 0.70
PARTIAL_MIN_COVERAGE = 0.30
MAX_DROP_RATIO = 0.25
MIN_TOKENS_TO_DROP = 5
MIN_TEXT_SIMILARITY = 0.85
MIN_BODY_RATIO = 0.70


def classify_cues(spans, mapping) -> list[str]:
    decisions = []
    for start, end in spans:
        count = end - start
        if count == 0:
            decisions.append("partial")
            continue
        covered = sum(1 for index in range(start, end) if index in mapping)
        coverage = covered / count
        if coverage >= BODY_MIN_COVERAGE:
            decisions.append("body")
        elif coverage < PARTIAL_MIN_COVERAGE and count >= MIN_TOKENS_TO_DROP:
            decisions.append("drop")
        else:
            decisions.append("partial")
    return decisions


def episode_rejection(decisions: list[str], similarity: float) -> str | None:
    if similarity < MIN_TEXT_SIMILARITY:
        return "文本相似度过低"
    if not decisions:
        return "没有 cue"
    dropped = decisions.count("drop")
    if dropped / len(decisions) > MAX_DROP_RATIO:
        return "删除比例超过 25%"
    kept = len(decisions) - dropped
    if kept / len(decisions) < MIN_BODY_RATIO:
        return "保留 cue 占比过低"
    if "body" not in decisions:
        return "没有任何 cue 拿到映射词"
    return None


def _mapped_words(span, mapping, words) -> list[dict[str, Any]]:
    indexes = [mapping[index] for index in range(*span) if index in mapping]
    if not indexes:
        return []
    return [
        {"w": words[index]["w"], "s": words[index]["s"], "e": words[index]["e"]}
        for index in range(min(indexes), max(indexes) + 1)
    ]


def assign_times(cues, spans, decisions, mapping, words, total_seconds) -> list[dict[str, Any]]:
    """删掉 drop、给保留的 cue 定时：有词用词区间，没词的按连续空档按字数分配。"""
    kept: list[dict[str, Any]] = []
    for cue, span, decision in zip(cues, spans, decisions):
        if decision == "drop":
            continue
        mapped = _mapped_words(span, mapping, words) if decision == "body" else []
        kept.append(
            {
                "start": mapped[0]["s"] if mapped else None,
                "end": mapped[-1]["e"] if mapped else None,
                "en": cue["en"],
                "zh": cue.get("zh", ""),
                "words": mapped,
            }
        )
    index = 0
    while index < len(kept):
        if kept[index]["start"] is not None:
            index += 1
            continue
        run_end = index
        while run_end < len(kept) and kept[run_end]["start"] is None:
            run_end += 1
        left = kept[index - 1]["end"] if index else 0.0
        right = kept[run_end]["start"] if run_end < len(kept) else total_seconds
        run = kept[index:run_end]
        total_chars = sum(len(item["en"]) for item in run) or 1
        cursor = left
        for item in run:
            share = len(item["en"]) / total_chars
            item["start"] = cursor
            item["end"] = cursor + max(0.05, (right - left) * share)
            cursor = item["end"]
        index = run_end
    previous_end = 0.0
    for entry in kept:
        entry["start"] = max(previous_end, float(entry["start"]))
        entry["end"] = max(entry["start"] + 0.05, float(entry["end"]))
        previous_end = entry["end"]
    return kept


def zh_vtt_path(vtt_path: Path) -> Path:
    return vtt_path.parent / "zh" / vtt_path.name


def zh_blocks(path: Path) -> list[str]:
    """中文单语 VTT 的文本行，按块顺序；没有时间戳的块（WEBVTT 头）跳过。"""
    rows = []
    for block in split_blocks(path.read_text(encoding="utf-8-sig", errors="replace")):
        lines = [line.strip() for line in block.strip().split(chr(10)) if line.strip()]
        if not any("-->" in line for line in lines):
            continue
        body = [line for line in lines if "-->" not in line and not line.isdigit()]
        if body:
            rows.append(body[0])
    return rows


def render_zh_vtt(zh_texts: list[str], kept: list[dict[str, Any]]) -> str:
    blocks = ["WEBVTT", ""]
    for index, (zh, cue) in enumerate(zip(zh_texts, kept), 1):
        blocks.extend(
            [
                str(index),
                f"{timestamp(cue['start'])} --> {timestamp(cue['end'])}",
                zh,
                "",
            ]
        )
    return chr(10).join(blocks).rstrip() + chr(10)


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def rewrite_episode(
    vtt_path: Path,
    audio_url: str,
    model,
    *,
    workdir: Path,
    download=None,
    transcribe_audio=None,
) -> str:
    """转写→映射→分流→重写双语与 zh 字幕→写 sidecar；返回 done/rejected/failed。"""
    download = download or transcribe.download_audio
    transcribe_audio = transcribe_audio or transcribe.whisper_transcribe
    sidecar = transcribe.sidecar_path_for(vtt_path)
    audio_path = Path(workdir) / "episode.audio"
    try:
        cues = parse_english_vtt(vtt_path)
        if not cues:
            raise RuntimeError("英文 VTT 没有可用的块")
        download(audio_url, audio_path)
        our_cues, total = transcribe_audio(audio_path)
        raw_words = [word for cue in our_cues for word in cue.get("words") or []]
        our_tokens: list[str] = []
        words: list[dict[str, Any]] = []
        for word in raw_words:
            token = re.sub(r"[^a-z0-9]", "", word["w"].lower())
            if token:
                our_tokens.append(token)
                words.append(word)
        tokens, spans = cue_token_spans(cues)
        mapping, similarity = map_stream(tokens, our_tokens)
        decisions = classify_cues(spans, mapping)
        reason = episode_rejection(decisions, similarity)
        if reason:
            print(f"{vtt_path.stem}: 整集放弃（{reason}）")
            transcribe.write_sidecar_failure(
                sidecar, transcribe.sidecar_status(sidecar)[1] + 1
            )
            return "rejected"
        kept = assign_times(cues, spans, decisions, mapping, words, total)
        en_text = render_english_vtt(kept)
        validate_vtt(en_text, blocks=len(kept), bilingual=False)
        zh_source = zh_vtt_path(vtt_path)
        zh_text = None
        if zh_source.exists():
            zh_rows = parse_bilingual_vtt(zh_source)
            if len(zh_rows) != len(cues):
                raise RuntimeError("zh 字幕块数与英文版不一致")
            # 中文必须按**原始块下标**取，否则删掉一条广告后后面所有译文整体错位
            kept_zh = []
            for original_index, decision in enumerate(decisions):
                if decision == "drop":
                    continue
                cue = kept[len(kept_zh)]
                kept_zh.append(
                    {
                        "start": cue["start"],
                        "end": cue["end"],
                        "en": cue["en"],
                        "zh": zh_rows[original_index]["zh"],
                    }
                )
            zh_text = render_vtt(kept_zh)
            validate_vtt(zh_text, blocks=len(kept), bilingual=True)
    except Exception as exc:
        print(f"{vtt_path.stem}: 放弃 {type(exc).__name__}: {exc}")
        transcribe.write_sidecar_failure(sidecar, transcribe.sidecar_status(sidecar)[1] + 1)
        return "failed"
    write_atomic(vtt_path, en_text)
    if zh_text is not None:
        write_atomic(zh_source, zh_text)
    transcribe.write_word_timings(kept, sidecar, total)
    print(
        f"{vtt_path.stem}: 相似度 {similarity:.3f}，正文 {decisions.count('body')}，"
        f"部分 {decisions.count('partial')}，删除 {decisions.count('drop')}"
    )
    return "done"
