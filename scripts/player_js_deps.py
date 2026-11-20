"""扫描 src/player-js/*.js，列出顶层声明被哪些分片引用，生成依赖清单。

只做静态文本统计，不改任何脚本。用于 L2/L3 搬迁时判断耦合面。
"""
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PARTS = ROOT / "src" / "player-js"
OUT = ROOT / "docs" / "player-js-dependency-map.md"

DECL = re.compile(r"^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)|^class\s+([A-Za-z_$][\w$]*)")


def main() -> int:
    parts = sorted(PARTS.glob("*.js"))
    texts = {p.name: p.read_text(encoding="utf-8") for p in parts}

    decls = {}
    for name, text in texts.items():
        for line in text.split("\n"):
            match = DECL.match(line)
            if not match:
                continue
            ident = next(g for g in match.groups() if g)
            decls.setdefault(ident, name)

    refs = defaultdict(lambda: defaultdict(int))
    for name, text in texts.items():
        for ident in decls:
            count = len(re.findall(r"(?<![\w$.])" + re.escape(ident) + r"(?![\w$])", text))
            if count:
                refs[ident][name] = count

    rows = []
    cross = 0
    for ident, owner in decls.items():
        users = {p: c for p, c in refs[ident].items() if p != owner}
        total = sum(refs[ident].values())
        if users:
            cross += 1
            rows.append((ident, owner, users, total))

    rows.sort(key=lambda r: -len(r[2]))

    lines = [
        "# 播放器脚本依赖清单",
        "",
        "由 `python scripts/player_js_deps.py` 生成，只统计顶层声明与跨分片引用。",
        "新搬一段代码前先查这里，确认它的外部依赖是否只有少数几项。",
        "",
        f"- 分片：{len(parts)} 个；顶层声明：{len(decls)} 个；跨分片引用：{cross} 个。",
        "",
        "| 声明 | 定义片 | 引用分片（次数） | 总引用 |",
        "| --- | --- | --- | --- |",
    ]
    for ident, owner, users, total in rows:
        used = "<br>".join(f"{p} {c}" for p, c in sorted(users.items()))
        lines.append(f"| `{ident}` | {owner} | {used} | {total} |")

    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"{OUT} | 分片 {len(parts)} | 声明 {len(decls)} | 跨片 {cross}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
