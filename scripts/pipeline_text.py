"""展示文本来源：PodScripts 抓取或 ASR 句子；统一产出 Sentence。"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import align_timings  # noqa: E402


def _sentence(start, end, en, words, zh="", zh_words=None, coarse=False):
    return {
        "start": float(start),
        "end": float(end),
        "en": en,
        "zh": zh,
        "coarse": coarse,
        "words": words,
        "zh_words": list(zh_words or []),
    }


def asr_sentences(asr_cues) -> list[dict[str, Any]]:
    return [
        _sentence(cue["start"], cue["end"], cue.get("en", ""), cue.get("words") or [])
        for cue in asr_cues
        if (cue.get("en") or "").strip()
    ]


def map_external_text(text_blocks, asr_cues, total_seconds: float) -> list[dict[str, Any]]:
    """把外部文本贴到 ASR 词流上：复用 align_timings 的映射/分流/定时。"""
    blocks = [
        {"start": 0.0, "end": total_seconds, "en": (block.get("en") or "").strip()}
        for block in text_blocks
        if (block.get("en") or "").strip()
    ]
    if not blocks:
        return []
    words = [word for cue in asr_cues for word in (cue.get("words") or [])]
    our_tokens, kept_words = [], []
    for word in words:
        token = "".join(ch for ch in word["w"].lower() if ch.isalnum())
        if token:
            our_tokens.append(token)
            kept_words.append(word)
    tokens, spans = align_timings.cue_token_spans(blocks)
    mapping, _similarity = align_timings.map_stream(tokens, our_tokens)
    decisions = align_timings.classify_cues(spans, mapping)
    kept = align_timings.assign_times(blocks, spans, decisions, mapping, kept_words, total_seconds)
    dropped = [cue for cue, decision in zip(blocks, decisions) if decision == "drop"]
    if dropped:
        chars = sum(len(cue["en"]) for cue in dropped)
        print(
            f"  丢弃 {len(dropped)} 段广告/无关块（{chars} 字），"
            f"示例：{dropped[0]['en'][:60]}"
        )
    return [
        _sentence(cue["start"], cue["end"], cue["en"], cue.get("words") or [])
        for cue in kept
    ]
