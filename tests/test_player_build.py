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

    def test_bundle_is_kernel_then_one_iife(self):
        text = (ROOT / "site" / "player.js").read_text(encoding="utf-8")
        self.assertTrue(text.lstrip().startswith("/* layer: kernel"),
                        "没有以 kernel 分片开头（分片顺序错了）")
        self.assertIn("(() => {", text[:2000], "主 IIFE 不在主脚本开头")
        self.assertTrue(text.rstrip().endswith("})();"), "结尾不在最后一个分片")


if __name__ == "__main__":
    unittest.main()
