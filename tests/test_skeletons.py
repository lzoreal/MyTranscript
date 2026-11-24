"""骨架机制（docs/adr/0006-skeleton-belongs-to-theme.md）的守门测试。

两件事必须一直成立：
1. site/skeletons-defaults.js 与 src/skeletons/ 一致（生成物不能手改）；
2. 变体骨架不许把 base 里的 id 弄丢。骨架允许换结构、换排版，但页面里的 id 是 JS 的
   契约面——丢一个就可能让某个按钮静默失效，而那种坏法在截图上看不出来。
"""
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import build_skeletons  # noqa: E402

SITE = ROOT / "site"
SRC = ROOT / "src" / "skeletons"

# 允许丢的 id：只放「有保护解引用、且新版式里确实不需要」的。
OPTIONAL_IDS = set()

ID_RE = re.compile(r'\bid="([^"]+)"')


def ids_of(html: str) -> set[str]:
    return set(ID_RE.findall(html))


class SkeletonBuildTests(unittest.TestCase):
    def test_generated_file_matches_sources(self):
        packs = build_skeletons.build()
        output = build_skeletons.render(packs)
        current = (SITE / "skeletons-defaults.js").read_text(encoding="utf-8")
        self.assertEqual(current, output, "site/skeletons-defaults.js 与 src/skeletons/ 不一致，先跑 build_skeletons.py")

    def test_pack_is_json_and_has_base(self):
        text = (SITE / "skeletons-defaults.js").read_text(encoding="utf-8")
        packs = json.loads(text[text.index("{"): text.rindex("}") + 1])
        self.assertIn("base", packs)
        for key, html in packs.items():
            self.assertGreater(len(html), 1000, key)
            self.assertNotIn("@region:", html, "产物里不该残留区域标记：" + key)

    def test_variants_keep_required_ids(self):
        packs = build_skeletons.build()
        base_ids = ids_of(packs["base"])
        missing_by_pack = {}
        for key, html in packs.items():
            if key == "base":
                continue
            missing = (base_ids - OPTIONAL_IDS) - ids_of(html)
            if missing:
                missing_by_pack[key] = sorted(missing)
        self.assertEqual(missing_by_pack, {})

    def test_variant_regions_exist(self):
        base = (SRC / "base.html").read_text(encoding="utf-8")
        names = set(build_skeletons.region_names(base))
        self.assertEqual(names, {"shell", "topbar", "home", "reader-top", "dock"})
        for folder in sorted(p for p in SRC.iterdir() if p.is_dir()):
            for file in sorted(folder.glob("*.html")):
                self.assertIn(file.stem, names, f"{file} 覆盖了不存在的区域")

    def test_player_page_loads_skeleton_pack(self):
        page = (SITE / "player.html").read_text(encoding="utf-8")
        self.assertIn('<div id="shellMount"></div>', page)
        self.assertIn('<script src="skeletons-defaults.js"></script>', page)
        # 引导必须在故事模块之前：module 是 defer，classic 脚本按顺序跑。
        self.assertLess(page.index("skeletons-defaults.js"), page.index('type="module"'))


if __name__ == "__main__":
    unittest.main()
