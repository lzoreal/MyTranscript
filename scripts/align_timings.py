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
