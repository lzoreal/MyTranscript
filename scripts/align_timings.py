"""把抓取来的 VTT 对齐到音频，产出逐词时间 sidecar（TMLT 机制的移植）。"""

from __future__ import annotations

import re
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
