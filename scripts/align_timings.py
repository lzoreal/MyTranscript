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

GROUP_MAX_CHARS = 900
GROUP_MAX_SPAN = 100.0

TIMESTAMP = re.compile(r"(\d+):(\d\d):([\d.]+)\s*-->\s*(\d+):(\d\d):([\d.]+)")


def parse_vtt_cues(path: Path) -> list[dict[str, Any]]:
    """取每个 cue 的时间与英文行（双语 VTT 里第二行是译文）。"""
    cues: list[dict[str, Any]] = []
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    for block in re.split(r"\r?\n\r?\n", text):
        lines = [line.strip() for line in block.strip().split("\n")]
        stamp = next((line for line in lines if "-->" in line), None)
        if not stamp:
            continue
        match = TIMESTAMP.search(stamp)
        if not match:
            continue
        h1, m1, s1, h2, m2, s2 = match.groups()
        start = int(h1) * 3600 + int(m1) * 60 + float(s1)
        end = int(h2) * 3600 + int(m2) * 60 + float(s2)
        body = [line for line in lines if "-->" not in line and line and not line.isdigit()]
        if not body:
            continue
        cues.append({"start": start, "end": end, "en": body[0]})
    return cues


def group_cues(cues: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    groups: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    for cue in cues:
        if current:
            chars = sum(len(item["en"]) for item in current)
            span = max(cue["start"], cue["end"]) - current[0]["start"]
            if chars + len(cue["en"]) > GROUP_MAX_CHARS or span > GROUP_MAX_SPAN:
                groups.append(current)
                current = []
        current.append(cue)
    if current:
        groups.append(current)
    return groups


PAD = 3.0
TAIL_PAD = 8.0
NOMINAL_CPS = 15.0
SLOWEST_CPS = 4.0


def cue_span(cue: dict[str, Any]) -> float:
    """本句语音时长的合理上界：取声明时长与按字数估算的交集，再用最慢语速兜底。"""
    declared = max(0.0, cue["end"] - cue["start"])
    natural = len(cue["en"]) / NOMINAL_CPS
    ceiling = len(cue["en"]) / SLOWEST_CPS + 5.0
    return min(max(declared, natural), ceiling)


def window_for(group: list[dict[str, Any]], total_seconds: float) -> tuple[float, float]:
    lo = max(0.0, group[0]["start"] - PAD)
    hi = min(total_seconds, max(cue["start"] + cue_span(cue) for cue in group) + TAIL_PAD)
    return lo, hi


EARLY_TOLERANCE = 8.0
LATE_TOLERANCE = 8.0
# 单条 cue 的锚点误差实测可达 ±25 秒，时间边界必须比它宽
CUE_TIME_TOLERANCE = 60.0


CONTINUATION_PREFIXES = ("-", ".", "'", "’")


def _merge_continuations(tokens: list[str]) -> list[str]:
    """合并被拆开的续接词：don + 't、re + -watching、com + .com。"""
    merged: list[str] = []
    for token in tokens:
        if merged and token[:1] in CONTINUATION_PREFIXES:
            merged[-1] = merged[-1] + token
        else:
            merged.append(token)
    return merged


def _normalize(tokens: list[str]) -> list[str]:
    cleaned = (re.sub(r"[^a-z0-9]", "", token.lower()) for token in tokens)
    return [token for token in cleaned if token]


def tokens_match(want: list[str], got: list[str]) -> bool:
    """归一化后比相似度。

    两边的文本来自不同 ASR（PodScripts 一次、我们对音频再一次），长段落里个别词
    本来就不同，所以不用严格相等：序列相似度 ≥90% 且词数差不超过 5% 即视为同一段话。
    """
    if want == got:
        return True
    if not want or not got:
        return False
    tolerance = max(3, int(len(want) * 0.05))
    if abs(len(want) - len(got)) > tolerance:
        return False
    from difflib import SequenceMatcher

    return SequenceMatcher(None, want, got).ratio() >= 0.9


def words_plausible(
    cue: dict[str, Any], next_start: float | None, words: list[dict[str, Any]]
) -> bool:
    """词集与词位置是否可信；不可信就丢该句的词，而不是写错数据。"""
    if not words:
        return False
    want = _normalize(cue["en"].split())
    got = _normalize(_merge_continuations([word["w"] for word in words]))
    if not tokens_match(want, got):
        return False
    # 对齐失败时 stable-ts 会把一整行的词压在同一个时间点（时长 0）：这不是可用数据。
    positive = [word for word in words if word["e"] > word["s"]]
    if len(positive) < max(1, int(len(words) * 0.8)):
        return False
    # PodScripts 单条 cue 的起点实测可偏 ±25 秒，时间不能贴 cue 判；这里只拦
    # 明显跑到别处的对齐，真正的防线是上面的文本相似度与整集的偏移守卫。
    first, last = words[0]["s"], words[-1]["e"]
    if first < cue["start"] - CUE_TIME_TOLERANCE:
        return False
    return last <= cue["start"] + cue_span(cue) + CUE_TIME_TOLERANCE


def cue_words(segments, group, offset: float) -> dict[int, list[dict[str, Any]]]:
    by_id = {getattr(segment, "id", None): segment for segment in segments}
    result: dict[int, list[dict[str, Any]]] = {}
    for position, _cue in enumerate(group):
        segment = by_id.get(position)
        words = list(getattr(segment, "words", None) or []) if segment else []
        mapped = [
            {
                "w": word.word.strip(),
                "s": float(word.start) + offset,
                "e": float(word.end) + offset,
            }
            for word in words
            if word.word.strip()
        ]
        if mapped:
            result[position] = mapped
    return result


SR = 16000
MISMATCH_MEDIAN = 3.0


class AudioMismatch(RuntimeError):
    """中位偏移过大：下载到的音频与转写来源不是同一个版本。"""


def align_cues(model, audio, cues, total_seconds: float):
    """整集对齐：返回 (带词的 cues, 统计)；中位偏移超限时抛 AudioMismatch。"""
    stats: dict[str, Any] = {
        "groups": 0,
        "aligned_cues": 0,
        "failed_groups": 0,
        "median_offset": 0.0,
    }
    offsets: list[float] = []
    result = [
        {"start": cue["start"], "end": cue["end"], "en": cue["en"], "words": []}
        for cue in cues
    ]
    index_of = {id(cue): position for position, cue in enumerate(cues)}
    for group in ([cue] for cue in cues):
        stats["groups"] += 1
        lo, hi = window_for(group, total_seconds)
        clip = audio[int(lo * SR) : int(hi * SR)]
        text = "\n".join(cue["en"] for cue in group)
        try:
            aligned = model.align(clip, text, language="en", original_split=True)
        except Exception:
            stats["failed_groups"] += 1
            continue
        mapped = cue_words(aligned.segments, group, offset=lo)
        for position, cue in enumerate(group):
            words = mapped.get(position) or []
            if not words:
                continue
            index = index_of[id(cue)]
            next_start = cues[index + 1]["start"] if index + 1 < len(cues) else None
            if not words_plausible(cue, next_start, words):
                continue
            result[index]["words"] = words
            stats["aligned_cues"] += 1
            offsets.append(words[0]["s"] - cue["start"])
    if (
        stats["groups"]
        and not stats["aligned_cues"]
        and not stats["failed_groups"]
    ):
        raise AudioMismatch(
            f"{stats['groups']} 个窗口没有一句对齐成功：音频与转写来源可能不是同一版本"
        )
    if offsets:
        median = statistics.median(offsets)
        stats["median_offset"] = round(median, 3)
        if abs(median) > MISMATCH_MEDIAN:
            raise AudioMismatch(
                f"中位首词偏移 {median:+.2f}s 超过 {MISMATCH_MEDIAN}s：音频版本可能不同"
            )
    return result, stats


sys.path.insert(0, str(Path(__file__).resolve().parent))
import transcribe  # noqa: E402  （复用下载、sidecar 结构、断点语义）


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


def log_summary(vtt_path: Path, stats: dict, total_cues: int) -> None:
    print(
        f"{vtt_path.stem}: 组 {stats['groups']}（失败 {stats['failed_groups']}），"
        f"带词 {stats['aligned_cues']}/{total_cues}，中位偏移 {stats['median_offset']:+.2f}s"
    )


def align_episode_file(
    vtt_path: Path,
    audio_url: str,
    model,
    *,
    workdir: Path,
    download=None,
    decode=None,
    total_seconds: float | None = None,
) -> str:
    """对齐一集并写 sidecar；返回 done/partial/failed/mismatch。"""
    download = download or transcribe.download_audio
    decode = decode or decode_audio
    sidecar = transcribe.sidecar_path_for(vtt_path)
    audio_path = Path(workdir) / "episode.audio"
    try:
        download(audio_url, audio_path)
        audio = decode(audio_path)
        total = total_seconds or len(audio) / SR
        cues = parse_vtt_cues(vtt_path)
        if not cues:
            raise RuntimeError("VTT 没有可用 cue")
        aligned, stats = align_cues(model, audio, cues, total)
    except AudioMismatch as exc:
        print(f"{vtt_path.stem}: {exc}")
        transcribe.write_sidecar_failure(sidecar, transcribe.sidecar_status(sidecar)[1] + 1)
        return "mismatch"
    except Exception as exc:
        print(f"{vtt_path.stem}: 对齐失败 {type(exc).__name__}: {exc}")
        transcribe.write_sidecar_failure(sidecar, transcribe.sidecar_status(sidecar)[1] + 1)
        return "failed"
    if not stats["aligned_cues"]:
        raise RuntimeError(
            f"{stats['groups']} 个窗口全部对齐失败（对齐器报错），本集留给下一轮"
        )
    transcribe.write_word_timings(aligned, sidecar, total)
    log_summary(vtt_path, stats, len(aligned))
    return "done" if stats["aligned_cues"] else "partial"


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
    stats = {"done": 0, "partial": 0, "failed": 0, "mismatch": 0, "skipped": 0}
    for item in candidates:
        if transcribe.shard_of(item["identity"], shards) != shard:
            stats["skipped"] += 1
            continue
        if clock() >= deadline:
            print(f"分片 {shard} 预算用完，已完成 {stats['done'] + stats['partial']} 集")
            break
        outcome = process(item)
        stats[outcome] = stats.get(outcome, 0) + 1
    print(
        f"分片 {shard} 结束：done {stats['done']}，partial {stats['partial']}，"
        f"failed {stats['failed']}，mismatch {stats['mismatch']}，skipped {stats['skipped']}"
    )
    return stats


ROOT = Path(__file__).resolve().parent.parent


def process_candidate(item: dict[str, Any], model=None) -> str:
    """对齐一集：下载音频 → 解码 → 对齐 → 写 sidecar。"""
    model = model or load_model()
    with tempfile.TemporaryDirectory(prefix="align-audio-") as temp_dir:
        return align_episode_file(
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
    body = [line for line in lines[1:] if line.strip()]
    cue_blocks = split_blocks(chr(10).join(body))
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
