"""把 themes/<slug>.json 汇总成 site/themes-defaults.js（随包主题清单）。

为什么要有这个脚本：`site/themes-defaults.js` 是生成物，之前只在文档里记了「重新生成」，
没有可执行入口，改一套包就容易和 themes/ 目录脱节（tests/test_custom_themes.py 会比对两者）。

顺序由 ORDER 决定（新增包追加在末尾，别插队，否则老用户的卡片顺序会变）；
每套包的 `scope` 决定它归属哪一档主题，缺省 `rail`（竖栏四档）。
"""
import io
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
THEMES = ROOT / "themes"
OUT = ROOT / "site" / "themes-defaults.js"

ORDER = [
    "liquid-glass",
    "glass2",
    "minimal-maxi",
    "mono-tech",
    "surveillance",
    "folia-poster",
]

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def main() -> int:
    packs = []
    for slug in ORDER:
        path = THEMES / (slug + ".json")
        if not path.is_file():
            print("缺包：%s" % path)
            return 1
        data = json.loads(path.read_text(encoding="utf-8"))
        """CSS 以同名的 .css 文件为准：包全是手写 CSS，json 里再嵌一份副本迟早
        会和 .css 脱节（改 .css 忘了同步 json，生成出来的还是旧样式）。"""
        cssfile = THEMES / (slug + ".css")
        css = cssfile.read_text(encoding="utf-8") if cssfile.is_file() else (data.get("css") or "")
        if cssfile.is_file() and data.get("css") != css:
            """json 是能被导入的包文件，里面的 css 副本别允许和 .css 分家：
            这里顺手把 .css 写回 json，两边就永远不会岔。"""
            print("同步：%s 的 json 内嵌 CSS 已按 .css 更新" % slug)
            data["css"] = css
            path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                            encoding="utf-8", newline="\n")
        if len(css) < 5000:
            print("%s 的 CSS 只有 %d 字，太短" % (slug, len(css)))
            return 1
        item = {
            "slug": slug,
            "format": data.get("format", "myt-theme"),
            "name": data.get("name") or slug,
            "description": data.get("description") or "",
            "scope": data.get("scope") or "rail",
            "css": css,
            "html": data.get("html") or "",
        }
        # 缩进重排会在 CSS 里塞进多余空格，所以整块用紧凑分隔符输出
        packs.append(item)
    payload = json.dumps(packs, ensure_ascii=False, separators=(",", ":"))
    OUT.write_text("window.MYT_THEME_DEFAULTS = " + payload + ";\n", encoding="utf-8", newline="\n")
    print("已写 %s：%d 套（%s）" % (OUT, len(packs), ", ".join(p["slug"] for p in packs)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
