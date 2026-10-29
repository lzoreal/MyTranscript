"""生产依赖：把现有实现装配成 process_episode 需要的 deps。"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scraper  # noqa: E402
import transcribe  # noqa: E402
import zh_align  # noqa: E402

_ENCODER = None


def _segment(text: str) -> list[str]:
    return zh_align.segment_zh(text)


def _encode(texts: list[str]):
    global _ENCODER
    if _ENCODER is None:
        from sentence_transformers import SentenceTransformer

        _ENCODER = SentenceTransformer("paraphrase-multilingual-MiniLM-L12-v2")
    return _ENCODER.encode(texts, normalize_embeddings=True).tolist()


def _text(show, episode):
    episode_url = scraper.search_podscripts(episode["title"], show["podscripts_id"])
    if not episode_url:
        raise RuntimeError(f"未匹配到字幕页：{episode['title'][:60]}")
    html = scraper.request_text(episode_url)
    if not html:
        raise RuntimeError("字幕页抓取失败")
    cues = scraper.parse_transcript(html)
    if not cues:
        raise RuntimeError("字幕页没有内容")
    return [{"en": scraper.clean_text(cue["text"])} for cue in cues]


def build(show) -> dict:
    return {
        "download": transcribe.download_audio,
        "asr": transcribe.whisper_transcribe,
        "translate": transcribe.translate_cues_with_gemini,
        "text": _text,
        "segment": _segment,
        "encode": _encode,
    }
