"""把已产出数据里"译文不含中文"的句子单独补译。

只改这些句子的 zh（以及对应的 zh_words），不动 ASR、时轴和其它字段；
补完由 workflow 重新发布，站点上的 JSON 才会更新。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import pipeline_store as pstore  # noqa: E402
import transcribe  # noqa: E402
import zh_align  # noqa: E402


def missing_indices(document) -> list[int]:
    return [
        index
        for index, sentence in enumerate(document.get("sentences") or [])
        if transcribe.needs_translation(sentence)
    ]


def _rebuild_zh_words(sentence, segment=None, encode=None) -> None:
    zh = (sentence.get("zh") or "").strip()
    if not zh or not segment or not encode:
        return
    words = zh_align.fallback_zh_words(
        sentence.get("words") or [], zh, segment, encode,
        sentence.get("start", 0.0), sentence.get("end", 0.0),
    )
    if words:
        sentence["zh_words"] = words
        sentence.pop("zh_word_mode", None)
        return
    even = zh_align.evenly_timed_words(
        segment(zh), sentence.get("start", 0.0), sentence.get("end", 0.0)
    )
    if even:
        sentence["zh_words"] = even
        sentence["zh_word_mode"] = "even"


def apply_translations(document, translate, segment=None, encode=None) -> int:
    """只重译缺中文的句子，返回真正补好的条数。"""
    indices = missing_indices(document)
    if not indices:
        return 0
    cues = [
        {
            "en": document["sentences"][index].get("en", ""),
            "zh": document["sentences"][index].get("zh", ""),
            "start": document["sentences"][index].get("start", 0.0),
            "end": document["sentences"][index].get("end", 0.0),
        }
        for index in indices
    ]
    translate(cues)
    fixed = 0
    for index, cue in zip(indices, cues):
        sentence = document["sentences"][index]
        zh = (cue.get("zh") or "").strip()
        probe = dict(sentence)
        probe["zh"] = zh
        if transcribe.needs_translation(probe):
            # 模型又回了英文（或空）：保留原样，下次再试。
            continue
        sentence["zh"] = zh
        _rebuild_zh_words(sentence, segment, encode)
        fixed += 1
    return fixed


def collect_entries(data_dir: Path, slug: str = ""):
    """收集所有缺中文的句子，返回 [(path, index, cue)]；文档本身不常驻内存。"""
    entries = []
    for _name, path, document in iter_documents(data_dir, slug):
        for index, sentence in enumerate(document.get("sentences") or []):
            if not transcribe.needs_translation(sentence):
                continue
            entries.append((path, index, {
                "en": sentence.get("en", ""),
                "zh": sentence.get("zh", ""),
                "start": sentence.get("start", 0.0),
                "end": sentence.get("end", 0.0),
            }))
    return entries


def translate_entries(entries, translate) -> int:
    """把全部缺中文的句子合成一次翻译（内部按 150 条切批），返回补好的条数。"""
    cues = [cue for _, _, cue in entries]
    if not cues:
        return 0
    translate(cues)
    return sum(1 for _, _, cue in entries if not transcribe.needs_translation(cue))


def write_back(entries, segment=None, encode=None) -> int:
    """按文档分组写回，返回有改动的文档数。"""
    groups: dict[Path, list[tuple[int, dict]]] = {}
    for path, index, cue in entries:
        groups.setdefault(path, []).append((index, cue))
    changed_docs = 0
    for path, items in groups.items():
        document = json.loads(path.read_text(encoding="utf-8"))
        changed = 0
        for index, cue in items:
            if transcribe.needs_translation(cue):
                continue
            sentence = document["sentences"][index]
            if (sentence.get("zh") or "") == cue.get("zh"):
                continue
            sentence["zh"] = cue["zh"]
            _rebuild_zh_words(sentence, segment, encode)
            changed += 1
        if changed:
            pstore.write_episode(path, document)
            changed_docs += 1
    return changed_docs


def build_deps():
    import pipeline_deps

    return pipeline_deps.build({"slug": "fix-zh"})


def iter_documents(data_dir: Path, slug: str = ""):
    shows = [slug] if slug else sorted(
        path.name for path in data_dir.glob("*")
        if path.is_dir() and not path.name.startswith(".")
    )
    for name in shows:
        folder = data_dir / name
        if not folder.is_dir():
            print(f"跳过不存在的节目：{name}")
            continue
        for path in sorted(folder.glob("*.json")):
            if path.name.startswith(("state", "plan")):
                continue
            try:
                document = json.loads(path.read_text(encoding="utf-8"))
            except Exception as exc:
                print(f"读不了 {path}: {exc}")
                continue
            if isinstance(document.get("sentences"), list):
                yield name, path, document


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--slug", default="", help="只处理某个节目（留空=data/ 下全部）")
    parser.add_argument("--data-dir", type=Path, default=Path("data"))
    parser.add_argument("--dry-run", action="store_true", help="只统计，不发请求")
    args = parser.parse_args()

    entries = collect_entries(args.data_dir, args.slug.strip())
    episodes = len({path for path, _, _ in entries})
    print(f"缺中文 {len(entries)} 句，涉及 {episodes} 集", flush=True)
    if args.dry_run or not entries:
        print("（dry-run）" if args.dry_run else "没有需要补译的句子")
        return 0

    deps = build_deps()
    # 关键：所有集合成一次翻译，内部按批切分。按集发请求会撞全局限速，
    # 1520 集 × 30 秒 ≈ 12 小时，远超过 job 的 6 小时上限。
    fixed = translate_entries(entries, deps["translate"])
    changed = write_back(entries, deps["segment"], deps["encode"])
    print(f"补译 {fixed} 句，写回 {changed} 集", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
