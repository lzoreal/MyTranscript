"""清单校验 CLI：内置插件集合、2.2 示例插件、坏清单与读不出来的路径。

真正跑的是 scripts/check_plugin_manifest.mjs；这里保证 CI 有统一入口。
"""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
CLI = ROOT / "scripts" / "check_plugin_manifest.mjs"
BUILTIN = ROOT / "apps" / "windows" / "builtin-plugins"


def run(*args):
    return subprocess.run(
        ["node", str(CLI), *args],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )


class PluginManifestCliTests(unittest.TestCase):
    def test_builtin_set_passes_and_orders_by_dependency(self):
        dirs = [str(BUILTIN / name) for name in
                ("home", "library", "downloads", "settings", "subtitles", "study")]
        proc = run("--set", *dirs)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("加载顺序：", proc.stdout)
        order = proc.stdout.split("加载顺序：", 1)[1].strip()
        self.assertLess(order.index("subtitles"), order.index("study"),
                        "study 依赖 subtitles，顺序反了：" + order)

    def test_example_plugin_passes(self):
        proc = run(str(ROOT / "examples" / "plugins" / "search-echo"))
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("OK search-echo@0.1.0", proc.stdout)

    def test_broken_manifest_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "plugin.json"
            path.write_text(json.dumps({
                "id": "bad id",
                "version": "1.0.0",
                "apiVersion": "3.0",
                "contributions": {"slots": [{"id": "s", "slot": "nope"}]},
            }), encoding="utf-8")
            proc = run(str(path))
            self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
            self.assertIn("ERR", proc.stderr, "错误必须逐条打印")
            self.assertNotIn("OK", proc.stdout, "失败时不应报告 OK")

    def test_legacy_manifest_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "plugin.json"
            path.write_text(json.dumps({
                "id": "legacy-demo",
                "version": "0.1.0",
                "requires": ["subtitles"],
                "main": "main.js",
            }), encoding="utf-8")
            self.assertEqual(run(str(path)).returncode, 1, "严格模式应拒绝旧清单")
            proc = run("--legacy", str(path))
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            self.assertIn("OK legacy-demo@0.1.0", proc.stdout)

    def test_missing_path_is_reported(self):
        proc = run(str(ROOT / "examples" / "plugins" / "nope"))
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn("读取失败", proc.stderr)


if __name__ == "__main__":
    unittest.main()
