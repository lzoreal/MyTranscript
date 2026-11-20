import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
PARTS = ROOT / "src" / "player-js"


class PlayerJsBuildTests(unittest.TestCase):
    def test_parts_exist(self):
        parts = sorted(PARTS.glob("*.js"))
        self.assertTrue(parts, "src/player-js 下没有分片")
        for part in parts:
            self.assertGreater(part.stat().st_size, 0, part.name)

    def test_site_bundle_matches_parts(self):
        python = shutil.which("python") or shutil.which("python3")
        if not python:
            self.skipTest("python 不在 PATH")
        proc = subprocess.run(
            [python, str(ROOT / "scripts" / "build_player_js.py"), "--check"],
            capture_output=True, text=True, encoding="utf-8", cwd=ROOT,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_bundle_is_module_with_imported_kernel(self):
        text = (ROOT / "site" / "player.js").read_text(encoding="utf-8")
        self.assertTrue(text.startswith("import { MYTK } from './player-kernel.js';"),
                        "主脚本要以 kernel 模块导入开头")
        self.assertIn("(() => {", text[:4000], "主 IIFE 不在主脚本开头")
        self.assertTrue(text.rstrip().endswith("})();"), "结尾不在最后一个分片")
        kernel = (ROOT / "site" / "player-kernel.js").read_text(encoding="utf-8")
        self.assertTrue(kernel.startswith("/* layer: kernel"), "kernel 模块要以层标记开头")
        self.assertIn("export const MYTK", kernel, "kernel 要真正导出，不再拼进同一个文件")

    def test_player_page_loads_bundle_as_module(self):
        page = (ROOT / "site" / "player.html").read_text(encoding="utf-8")
        self.assertIn('<script type="module" src="player.js"></script>', page,
                      "player.js 是 ES module，页面必须按 module 加载")


if __name__ == "__main__":
    unittest.main()
