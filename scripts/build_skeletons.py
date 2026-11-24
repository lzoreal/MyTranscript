"""把 src/skeletons 拼装成 site/skeletons-defaults.js（window.MYT_SKELETONS）。

base.html 里用 <!--@region:name--> / <!--@end:name--> 标出可被变体整块替换的区域；
src/skeletons/<id>/<region>.html 覆盖同名区域，其余原样保留。区域是整块换，不是拼字符串，
所以变体的骨架可以真的换结构，而不是在原骨架里塞几行。

用法：
  python scripts/build_skeletons.py          写出 site/skeletons-defaults.js
  python scripts/build_skeletons.py --check  只比对，不写（测试用）
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).parents[1]
SRC = ROOT / "src" / "skeletons"
OUT = ROOT / "site" / "skeletons-defaults.js"

REGION_RE = re.compile(r"<!--@region:(?P<name>[a-z0-9-]+)-->(?P<body>.*?)<!--@end:(?P=name)-->", re.S)


def region_names(text: str) -> list[str]:
    return [m.group("name") for m in REGION_RE.finditer(text)]


def apply_overrides(base: str, overrides: dict[str, str]) -> str:
    def repl(match: re.Match[str]) -> str:
        name = match.group("name")
        if name not in overrides:
            return match.group(0)
        return f"<!--@region:{name}-->{overrides[name].strip()}<!--@end:{name}-->"

    text = REGION_RE.sub(repl, base)
    unknown = set(overrides) - set(region_names(base))
    if unknown:
        raise SystemExit(f"变体覆盖了不存在的区域：{sorted(unknown)}")
    return text


def strip_markers(text: str) -> str:
    return REGION_RE.sub(lambda m: m.group("body"), text)


def build() -> dict[str, str]:
    base_path = SRC / "base.html"
    if not base_path.is_file():
        raise SystemExit("缺 src/skeletons/base.html")
    base = base_path.read_text(encoding="utf-8")
    if region_names(base) != ["shell", "topbar", "home", "reader-top", "dock"]:
        raise SystemExit(f"base.html 的区域顺序变了：{region_names(base)}")

    out = {"base": strip_markers(base).strip()}
    for folder in sorted(p for p in SRC.iterdir() if p.is_dir()):
        overrides = {f.stem: f.read_text(encoding="utf-8") for f in sorted(folder.glob("*.html"))}
        out[folder.name] = strip_markers(apply_overrides(base, overrides)).strip()
    return out


def render(packs: dict[str, str]) -> str:
    payload = json.dumps(packs, ensure_ascii=False, indent=0, separators=(",", ":"))
    return (
        "/* 由 scripts/build_skeletons.py 生成，别手改。改骨架去 src/skeletons/。 */\n"
        f"window.MYT_SKELETONS = {payload};\n"
    )


def main() -> None:
    packs = build()
    output = render(packs)
    if "--check" in sys.argv:
        current = OUT.read_text(encoding="utf-8") if OUT.is_file() else ""
        if current != output:
            raise SystemExit("site/skeletons-defaults.js 与 src/skeletons/ 不一致，先跑 build_skeletons.py")
        print("skeletons 产物与源一致：" + "、".join(f"{k}({len(v)}B)" for k, v in packs.items()))
        return
    OUT.write_text(output, encoding="utf-8")
    print("写出 site/skeletons-defaults.js：" + "、".join(f"{k}({len(v)}B)" for k, v in packs.items()))


if __name__ == "__main__":
    main()
