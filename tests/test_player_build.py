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

    def test_bundle_is_module_graph(self):
        entry = (ROOT / "site" / "player.js").read_text(encoding="utf-8")
        self.assertEqual(entry.strip(), "import './player/player.js';",
                         "站点入口只负责导入模块入口")
        player = (ROOT / "site" / "player" / "player.js").read_text(encoding="utf-8")
        self.assertIn("initPlayer();", player, "启动调用留在入口，不在分片顶层")
        for name in ("01-theme-reader-shell.js", "02-live-caption-wasm.js",
                     "03-native-asr-service-worker.js", "04-local-audio-plugin-host.js"):
            text = (ROOT / "site" / "player" / name).read_text(encoding="utf-8")
            self.assertRegex(text, r"^import \{", f"{name} 必须有显式 import")
            self.assertIn("export {", text, f"{name} 必须显式导出")
        kernel = (ROOT / "site" / "player" / "00-kernel.js").read_text(encoding="utf-8")
        self.assertIn("export const MYTK", kernel)
        self.assertNotIn("import ", kernel, "kernel 不能反向依赖功能模块")

    def test_player_page_loads_bundle_as_module(self):
        page = (ROOT / "site" / "player.html").read_text(encoding="utf-8")
        self.assertIn('<script type="module" src="player.js"></script>', page,
                      "player.js 是 ES module，页面必须按 module 加载")

    def test_subs_off_keeps_player_stage_and_shows_notice(self):
        css = (ROOT / "site" / "player.css").read_text(encoding="utf-8")
        self.assertNotIn("body.subs-off .reader,", css,
                         "字幕插件停用时不能隐藏整个播放器阅读区，否则播放页会空白")
        self.assertNotIn("body.subs-off #dockquick", css,
                         "倍速等基础播放控制不能随字幕插件一起隐藏")
        self.assertNotIn("body.subs-off .reader-top-actions", css,
                         "返回主页/剧集栏等基础导航不能随字幕插件一起隐藏")
        src = (PARTS / "03-native-asr-service-worker.js").read_text(encoding="utf-8")
        self.assertIn("音频播放模式", src,
                      "插件停用时阅读区要显示原生音频模式，不能留空")
        routes = (PARTS / "07-routes-pages.js").read_text(encoding="utf-8")
        self.assertNotIn("播放页不可用", routes,
                         "没有插件时不应拦截播放路由，也不应提示用户去启用插件")
        bridge = (PARTS / "10-desktop-bridge-tail.js").read_text(encoding="utf-8")
        self.assertIn("if (!subtitlePluginOn())", bridge,
                      "没有插件时播放要走原生驻留分支")
        self.assertIn("loadShow(show.slug, epId)", bridge,
                      "没有插件时应在原页面加载并播放，而不是跳播放页")



if __name__ == "__main__":
    unittest.main()
