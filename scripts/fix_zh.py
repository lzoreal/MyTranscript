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
        if segment and encode:
            words = zh_align.fallback_zh_words(
                sentence.get("words") or [], zh, segment, encode,
                sentence.get("start", 0.0), sentence.get("end", 0.0),
            )
            if words:
                sentence["zh_words"] = words
                sentence.pop("zh_word_mode", None)
            else:
                even = zh_align.evenly_timed_words(
                    segment(zh), sentence.get("start", 0.0), sentence.get("end", 0.0)
                )
                if even:
                    sentence["zh_words"] = even
                    sentence["zh_word_mode"] = "even"
        fixed += 1
    return fixed


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

    scanned = affected = sentences = 0
    deps = None
    for name, path, document in iter_documents(args.data_dir, args.slug.strip()):
        scanned += 1
        missing = missing_indices(document)
        if not missing:
            continue
        affected += 1
        print(f"{name}/{path.name}: 缺中文 {len(missing)} 句", flush=True)
        if args.dry_run:
            sentences += len(missing)
            continue
        if deps is None:
            deps = build_deps()
        fixed = apply_translations(document, deps["translate"], deps["segment"], deps["encode"])
        if fixed:
            pstore.write_episode(path, document)
            sentences += fixed
            print(f"{name}/{path.name}: 补译 {fixed} 句", flush=True)
    mode = "（dry-run）" if args.dry_run else ""
    print(f"扫描 {scanned} 集，涉及 {affected} 集，补译 {sentences} 句{mode}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
