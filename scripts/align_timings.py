"""把抓取来的 VTT 对齐到音频，产出逐词时间 sidecar（TMLT 机制的移植）。"""

from __future__ import annotations

import re
import statistics
import sys
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


def words_plausible(
    cue: dict[str, Any], next_start: float | None, words: list[dict[str, Any]]
) -> bool:
    """词集与词位置是否可信；不可信就丢该句的词，而不是写错数据。"""
    if not words:
        return False
    if [word["w"] for word in words] != cue["en"].split():
        return False
    first, last = words[0]["s"], words[-1]["e"]
    if first < cue["start"] - EARLY_TOLERANCE:
        return False
    limit = next_start if next_start is not None else cue["start"] + LATE_TOLERANCE * 10
    return last <= limit + LATE_TOLERANCE


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
    for group in group_cues(cues):
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
    transcribe.write_word_timings(aligned, sidecar, total)
    log_summary(vtt_path, stats, len(aligned))
    return "done" if stats["aligned_cues"] else "partial"
