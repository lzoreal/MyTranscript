"""离线补齐中文词时间：门控放弃的句子按字数均分（不需要 ASR / Gemini）。

只动 zh_words 为空的句子；补过的句子写 ``zh_word_mode="even"``，
消费方据此知道这一句是近似对齐而不是逐词推出来的。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import zh_align  # noqa: E402


def even_words(zh_text: str, start: float, end: float, segment) -> list[list]:
    return zh_align.evenly_timed_words(segment(zh_text), start, end)


def fill_document(doc: dict, segment) -> int:
    filled = 0
    for sentence in doc.get("sentences") or []:
        if sentence.get("zh_words") or not (sentence.get("zh") or "").strip():
            continue
        words = even_words(
            sentence["zh"], float(sentence["start"]), float(sentence["end"]), segment
        )
        if not words:
            continue
        sentence["zh_words"] = words
        sentence["zh_word_mode"] = "even"
        filled += 1
    return filled


def iter_documents(data_dir: Path):
    for path in sorted(Path(data_dir).glob("*/*.json")):
        if path.parent.name.startswith(".") or path.name.startswith("state"):
            continue
        yield path


def write_document(path: Path, doc: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    tmp.replace(path)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("data_dir", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    episodes = sentences = 0
    for path in iter_documents(args.data_dir):
        doc = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(doc.get("sentences"), list):
            continue
        filled = fill_document(doc, zh_align.segment_zh)
        if not filled:
            continue
        episodes += 1
        sentences += filled
        if not args.dry_run:
            write_document(path, doc)
        print(f"{path.parent.name}/{path.name}: 补 {filled} 句")
    print(f"合计：{episodes} 集，{sentences} 句")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
