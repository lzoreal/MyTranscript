"""把内部双语 JSON 导出为 Podcasting 2.0 transcript JSON（含 AntennaPod 词级扩展）。

标准字段：version / segments[].startTime|endTime|body（秒）。
扩展字段：segments[].start|end|text|words（毫秒），供本仓库 AntennaPod fork 的词级高亮。
"""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import quote

RAW_BASE = "https://raw.githubusercontent.com/lzoreal/MyTranscript/main"


def public_url(slug: str, filename: str, base: str = RAW_BASE) -> str:
    """站点 JSON 不走 Pages（1 GB 上限），由 raw.githubusercontent 直接提供。"""
    return (
        f"{base.rstrip('/')}/json/{quote(slug, safe='-._~')}/"
        f"{quote(filename, safe='-._~')}"
    )


def _ms(value) -> int:
    return int(round(float(value) * 1000))


def _segment(sentence: dict) -> dict | None:
    en = (sentence.get("en") or "").strip()
    if not en:
        return None
    start, end = float(sentence["start"]), float(sentence["end"])
    if end <= start:
        return None
    zh = (sentence.get("zh") or "").strip()
    body = en if not zh else en + chr(10) + zh
    words = []
    for word in sentence.get("words") or []:
        token = (word.get("w") or "").strip()
        if not token:
            continue
        w_start, w_end = _ms(word["s"]), _ms(word["e"])
        if w_end < w_start:
            continue
        words.append([token, w_start, w_end - w_start])
    words.sort(key=lambda item: item[1])
    return {
        "startTime": round(start, 3),
        "endTime": round(end, 3),
        "body": body,
        "start": _ms(start),
        "end": _ms(end),
        "text": body,
        "words": words,
    }


def build(document: dict) -> dict:
    segments = []
    for sentence in document.get("sentences") or []:
        segment = _segment(sentence)
        if segment is not None:
            segments.append(segment)
    out = {
        "version": "1.0.0",
        "audio_seconds": float(document.get("audio_seconds") or 0),
        "segments": segments,
    }
    # 导出侧靠它确认同名文件的归属；消费方会忽略这个扩展字段。
    if document.get("guid"):
        out["guid"] = document["guid"]
    return out


def dumps(document: dict) -> str:
    return json.dumps(build(document), ensure_ascii=False, separators=(",", ":"))


def write_episode(document: dict, json_dir, slug: str, stem: str) -> tuple[str, bool]:
    """写单集 JSON，返回 (文本, 是否落盘)；内容相同就不重写，发布才能增量。"""
    text = dumps(document)
    target = Path(json_dir) / slug / f"{stem}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        if target.read_text(encoding="utf-8") == text:
            return text, False
    except OSError:
        pass
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(target)
    return text, True


def export_show(data_dir, json_dir, slug: str, stems: dict[str, str]) -> int:
    """导出该节目；返回真正改写的集数（内容没变的不计）。"""
    written = 0
    for path in sorted((Path(data_dir) / slug).glob("*.json")):
        if path.name.startswith("state"):
            continue
        document = json.loads(path.read_text(encoding="utf-8"))
        stem = stems.get(document.get("guid"))
        if not stem:
            continue
        _text, changed = write_episode(document, json_dir, slug, stem)
        written += int(changed)
    return written
