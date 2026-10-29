"""单集编排：下载 → ASR → 文本 → 翻译 → 中文词时间 → 落盘 → 记账。"""

from __future__ import annotations

import tempfile
from datetime import datetime, timezone
from pathlib import Path

import pipeline_store as store
import pipeline_text as ptext
import zh_align
from gemini_keys import GeminiAuthFailed, QuotaExhausted


def _stamp(now) -> str:
    if now is None:
        return datetime.now(timezone.utc).isoformat(timespec="seconds")
    return now() if callable(now) else str(now)


def _record(state, guid, status, updated, *, attempts=None):
    entry = state["episodes"].setdefault(guid, {})
    entry["status"] = status
    entry["updated_at"] = updated
    if attempts is not None:
        entry["attempts"] = attempts
    else:
        entry.setdefault("attempts", 0)


def process_episode(show, episode, deps, data_dir: Path, now=None) -> str:
    guid = episode["guid"]
    suffix = show.get("state_suffix", "")
    state = store.load_state(data_dir, show["slug"], suffix)
    if not store.needs_work(state, guid):
        return "skipped"
    updated = _stamp(now)
    attempts = int(state["episodes"].get(guid, {}).get("attempts") or 0) + 1
    try:
        with tempfile.TemporaryDirectory(prefix="pipeline-audio-") as temp_dir:
            audio = Path(temp_dir) / "episode.audio"
            deps["download"](episode["audio_url"], audio)
            asr_cues, seconds = deps["asr"](audio)
        if show["text_source"] == "asr":
            sentences = ptext.asr_sentences(asr_cues)
        else:
            sentences = ptext.map_external_text(deps["text"](show, episode), asr_cues, seconds)
        if not sentences:
            raise RuntimeError("没有任何句子")
        deps["translate"](sentences)
        for sentence in sentences:
            if sentence.get("clauses") and not sentence.get("coarse"):
                sentence["zh_words"] = zh_align.build_zh_words(
                    sentence["clauses"], sentence["start"], sentence["end"], deps["segment"]
                )
                if not sentence["zh_words"]:
                    sentence["zh_words"] = zh_align.fallback_zh_words(
                        sentence["words"], sentence["zh"], deps["segment"], deps["encode"],
                        sentence["start"], sentence["end"],
                    )
            else:
                sentence["zh_words"] = []
    except (QuotaExhausted, GeminiAuthFailed):
        # 配额用完/配置失效不是这一集的锅：记 attempts 会让它在两轮之后永久出局。
        raise
    except Exception as exc:
        print(f"{show['slug']}/{guid}: 失败 {type(exc).__name__}: {exc}")
        _record(state, guid, "failed", updated, attempts=attempts)
        store.save_state(data_dir, show["slug"], state, suffix)
        return "failed"

    document = {
        "version": 2,
        "slug": show["slug"],
        "guid": guid,
        "title": episode.get("title", ""),
        "published": episode.get("published", ""),
        "audio_seconds": seconds,
        "sentences": sentences,
        "generated_at": updated,
    }
    store.write_episode(store.episode_path(data_dir, show["slug"], guid), document)
    coarse = any(sentence.get("coarse") for sentence in sentences)
    _record(state, guid, "done", updated, attempts=attempts)
    state["episodes"][guid]["coarse"] = coarse
    store.save_state(data_dir, show["slug"], state, suffix)
    print(f"{show['slug']}/{guid}: done，{len(sentences)} 句，coarse={coarse}")
    return "done"
