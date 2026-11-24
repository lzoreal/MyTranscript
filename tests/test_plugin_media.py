"""本机媒体能力（media 权限 + api.media）与四个 2.2 实验插件的静态约束。

这一层没有 DOM 可跑，所以只钉「接线是否还在」：Rust 命令有没有注册、清单里
权限与槽位是否合法、宿主 API 有没有把 media 组暴露出去、单集槽位是否带载荷。
真正的解码正确性在 Rust 单测里（`cargo test media::`）。
"""
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUST = ROOT / "apps" / "windows" / "src-tauri" / "src"
PLAYER = ROOT / "src" / "player-js"
PLUGINS = ROOT / "apps" / "windows" / "builtin-plugins"

MEDIA_COMMANDS = ["media_probe", "media_cut", "media_extract_audio"]


class MediaHostTest(unittest.TestCase):
    def test_rust_commands_registered(self):
        src = (RUST / "media.rs").read_text(encoding="utf-8")
        for name in MEDIA_COMMANDS:
            self.assertIn(f"pub fn {name}", src, f"media.rs 缺 {name}")
        main = (RUST / "main.rs").read_text(encoding="utf-8")
        self.assertIn("mod media;", main)
        for name in MEDIA_COMMANDS:
            self.assertIn(f"media::{name}", main, f"命令 {name} 没进 invoke_handler")

    def test_media_never_downloads_remote(self):
        src = (RUST / "media.rs").read_text(encoding="utf-8")
        self.assertNotIn("reqwest", src, "媒体命令不该自己去下载远程单集")
        self.assertIn("Path::new(&path).exists()", src, "本机文件不存在要报错")

    def test_contract_lists_media_permission(self):
        contract = (PLAYER / "host" / "contract.js").read_text(encoding="utf-8")
        self.assertIn("'media'", contract)
        self.assertRegex(contract, r"'cues', 'storage', 'media', 'llm'",
                         "槽位 api 投影要带 storage / media / llm")

    def test_host_api_exposes_media_group(self):
        host = (PLAYER / "04-local-audio-plugin-host.js").read_text(encoding="utf-8")
        self.assertIn("media: '本机媒体处理", host, "权限标签缺失")
        self.assertIn("media: only('media', {", host, "api.media 组缺失")
        for method in ["probe:", "cut:", "extractAudio:", "available:"]:
            self.assertIn(method, host, f"api.media 缺 {method}")
        self.assertIn("localPath:", host, "pluginPlayerState 要暴露 localPath")
        self.assertIn("function mediaInvoke(", host)

    def test_feeds_parse_podcast20_fields(self):
        shell = (PLAYER / "01-theme-reader-shell.js").read_text(encoding="utf-8")
        self.assertIn("function podcastPersons(", shell)
        self.assertIn("function podcastAlternates(", shell)
        self.assertIn("persons: podcastPersons(it)", shell)
        self.assertIn("alternates: podcastAlternates(it)", shell)

    def test_episode_slots_carry_payload(self):
        routes = (PLAYER / "07-routes-pages.js").read_text(encoding="utf-8")
        self.assertIn("function epSlotPayload(", routes)
        for slot in ["episode.header.actions", "episode.body.before"]:
            self.assertIn(f'data-plugin-slot="{slot}" data-slot-payload=', routes,
                          f"{slot} 缺 data-slot-payload")

    def test_video_page_remembers_position(self):
        routes = (PLAYER / "07-routes-pages.js").read_text(encoding="utf-8")
        self.assertIn("myt-video-progress:", routes)
        self.assertIn("bindVideoExtras(video, ep)", routes)
        # 正文归骨架管，锚点要按运行时（base 已内联）的样子断。
        html = (ROOT / "site" / "player.html").read_text(encoding="utf-8")
        skel = ROOT / "site" / "skeletons-defaults.js"
        if skel.is_file():
            import json

            text = skel.read_text(encoding="utf-8")
            packs = json.loads(text[text.index("{"): text.rindex("}") + 1])
            html = html.replace('<div id="shellMount"></div>', packs.get("base", ""))
        self.assertIn('id="videoCues"', html)

    def test_new_plugin_manifests(self):
        expected = {
            "distill": {"slots": 2, "pages": 1},
            "soundbite": {"slots": 1, "pages": 1},
            "podcast20": {"slots": 1, "pages": 0},
            "adscan": {"slots": 1, "pages": 0},
            "ask": {"slots": 1, "pages": 0},
        }
        for plugin_id, counts in expected.items():
            manifest = json.loads((PLUGINS / plugin_id / "plugin.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["id"], plugin_id)
            self.assertEqual(manifest["apiVersion"], "2.2")
            self.assertTrue((PLUGINS / plugin_id / "main.js").exists())
            contributions = manifest.get("contributions", {})
            self.assertEqual(len(contributions.get("slots", [])), counts["slots"], plugin_id)
            self.assertEqual(len(contributions.get("pages", [])), counts["pages"], plugin_id)
            for perm in manifest.get("permissions", []):
                self.assertIn(perm, {"ui.dom", "net", "player", "storage", "providers",
                                    "subtitles", "study", "media", "llm"},
                              f"{plugin_id} 声明了未知权限 {perm}")
            for slot in contributions.get("slots", []):
                self.assertIn(slot["slot"], {
                    "nav.main", "home.hero.after", "home.continue.actions",
                    "episode.header.actions", "episode.body.before", "player.dock.actions",
                    "player.sidebar", "settings.panes", "library.toolbar",
                    "downloads.empty", "search.results.after",
                }, f"{plugin_id} 用了未知槽位 {slot['slot']}")

    def test_plugins_declare_media_permission_when_using_it(self):
        for plugin_id in ["distill", "soundbite"]:
            body = (PLUGINS / plugin_id / "main.js").read_text(encoding="utf-8")
            manifest = json.loads((PLUGINS / plugin_id / "plugin.json").read_text(encoding="utf-8"))
            if "api.media" in body:
                self.assertIn("media", manifest.get("permissions", []),
                              f"{plugin_id} 用了 api.media 却没声明权限")

    def test_adscan_is_text_only(self):
        body = (PLUGINS / "adscan" / "main.js").read_text(encoding="utf-8")
        self.assertIn("文本启发式", body, "广告检测要在界面上写明是启发式")
        self.assertNotIn("api.media.cut", body, "广告区间插件不该裁音频做指纹")
        self.assertRegex(body, r"const PATTERNS = \[")


    def test_downloads_marks_video_and_extracts_audio(self):
        body = (PLUGINS / "downloads" / "main.js").read_text(encoding="utf-8")
        self.assertIn("decorateVideoRows", body)
        self.assertIn("api.media.extractAudio", body, "视频集要能只取音频轨")
        self.assertIn("只取音频轨", body)
        # 视频集整集下载前必须确认，不能静默拉几百 MB
        core = (PLAYER / "05-transport-transcript-nav.js").read_text(encoding="utf-8")
        self.assertIn("ep.video", core)
        self.assertIn("这是视频单集", core)

    def test_ask_is_retrieval_then_llm(self):
        body = (PLUGINS / "ask" / "main.js").read_text(encoding="utf-8")
        manifest = json.loads((PLUGINS / "ask" / "plugin.json").read_text(encoding="utf-8"))
        # 先本地检索再让模型基于片段作答，两条路都得在
        self.assertIn("function search(", body)
        self.assertIn("function pickContext(", body)
        self.assertIn("api.llm.chat(", body)
        self.assertIn("ASK_SYSTEM", body)
        self.assertIn("这集里没提到", body, "没有依据时要让模型直说没有")
        self.assertIn("llm", manifest.get("permissions", []))
        self.assertIn("subtitles", manifest.get("requires", {}), "检索依赖字幕插件提供的语料")
        self.assertIn("不得", body.replace("不要", "不得"), "提示词要约束模型不要自由发挥")

    def test_host_exposes_llm_group(self):
        host = (PLAYER / "04-local-audio-plugin-host.js").read_text(encoding="utf-8")
        self.assertIn("llm: only('llm', {", host)
        self.assertIn("ready: () => llmReady()", host)
        self.assertIn("chat: (system, user) => llmChat(system, user)", host)
        # 配置只有一份，复用的是 study 引擎设置，不另存 Key
        self.assertIn("studyEngine()", host)
        self.assertIn("keyHint", host, "只回密钥末四位")
        self.assertNotIn("apiKey:", host)


if __name__ == "__main__":
    unittest.main(verbosity=2)
