"""把单集 Sentence 渲染成 VTT，并调用现有生成器产出 feed/index。"""

from __future__ import annotations

from pathlib import Path


def _timestamp(value: float) -> str:
    ms = int(round(value * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d}.{ms % 1000:03d}"


def render_vtt(sentences) -> str:
    blocks = ["WEBVTT", ""]
    for index, sentence in enumerate(sentences, 1):
        en = (sentence.get("en") or "").strip()
        zh = (sentence.get("zh") or "").strip()
        if not en or not zh:
            raise ValueError(f"第 {index} 句缺少英文或中文")
        if float(sentence["end"]) <= float(sentence["start"]):
            raise ValueError(f"第 {index} 句时间无效")
        blocks.extend(
            [
                str(index),
                f"{_timestamp(sentence['start'])} --> {_timestamp(sentence['end'])}",
                en,
                zh,
                "",
            ]
        )
    return chr(10).join(blocks).rstrip() + chr(10)


def safe_stem(title: str) -> str:
    title = (title or "episode").strip() or "episode"
    return "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in title)[:120]


def publish_show(show, episodes, data_dir: Path, site_dir: Path) -> dict:
    """写该节目所有已完成集的 VTT；feed/index 由调用方按站点约定接上。"""
    import json

    written = 0
    for episode in episodes:
        path = data_dir / show["slug"] / f"{episode['guid']}.json"
        if not path.exists():
            continue
        document = json.loads(path.read_text(encoding="utf-8"))
        vtt_path = site_dir / show["slug"] / "transcripts" / f"{safe_stem(episode.get('title', ''))}.vtt"
        vtt_path.parent.mkdir(parents=True, exist_ok=True)
        vtt_path.write_text(render_vtt(document["sentences"]), encoding="utf-8")
        written += 1
    return {"vtt_written": written}
