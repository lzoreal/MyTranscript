import json
import shutil
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).parents[1]
SITE = ROOT / "site"
TRANSCRIPT_NS = "{https://podcastindex.org/namespace/1.0}transcript"


def load_shows():
    return json.loads((SITE / "shows.json").read_text(encoding="utf-8"))


def own_transcripts(item):
    found = []
    for entry in item.findall(TRANSCRIPT_NS):
        url = entry.get("url") or ""
        if url.startswith("https://lzoreal.github.io/MyTranscript/"):
            found.append(("vtt", url))
        elif url.startswith("https://raw.githubusercontent.com/lzoreal/MyTranscript/main/"):
            found.append(("json", url))
    return found


class PlayerManifestTests(unittest.TestCase):
    def test_manifest_covers_every_podcast(self):
        shows = load_shows()
        site_slugs = {
            path.parent.name
            for path in SITE.glob("*/index.html")
            if path.parent.name != "assets"
        }
        self.assertEqual(len(shows), len(site_slugs))
        self.assertEqual({s["slug"] for s in shows}, site_slugs)
        self.assertTrue(all(s["name"] for s in shows))
        for show in shows:
            feed = show["feed"]
            expected = f"{show['slug']}/feed.xml"
            self.assertEqual(unquote(feed) if feed else None, expected if feed else None)
            if feed is not None:
                self.assertTrue((SITE / unquote(feed)).is_file(), feed)


class PlayerTranscriptTests(unittest.TestCase):
    def test_each_feed_episode_has_one_own_transcript(self):
        for show in load_shows():
            if show["feed"] is None:
                continue
            xml = (SITE / unquote(show["feed"])).read_bytes()
            root = ET.fromstring(xml)
            for item in root.findall("./channel/item"):
                ours = own_transcripts(item)
                self.assertLessEqual(len(ours), 1, item.findtext("title"))
                if not ours:
                    continue
                kind, url = ours[0]
                parsed = urlparse(url)
                if kind == "json":
                    self.assertTrue(url.endswith(".json"))
                    self.assertIn(f"/json/{show['slug']}/", url)
                else:
                    path = unquote(parsed.path)
                    self.assertIn(f"/{show['slug']}/transcripts/", path)
                    self.assertTrue(path.endswith(".vtt"))


class PlayerProgressTests(unittest.TestCase):
    def test_player_persists_and_restores_playback_position(self):
        page = (SITE / "player.html").read_text(encoding="utf-8")
        self.assertIn("myt-progress", page)
        self.assertIn("saveProgress(true)", page)
        self.assertIn("state.resumeAt", page)
        self.assertIn("audio.currentTime = t", page)


class PlayerWordTimingTests(unittest.TestCase):
    """词级 JSON 用 ASR 原生时间，不能再被 VTT 压缩时间轴的修补改写。"""

    HARNESS = """
const assert = require('assert');
const reader = { lang: 'en', segment: false };
%s

const vtt = [
  { start: 0, end: 3, text: 'One two', speaker: '' },
  { start: 2, end: 5, text: 'And then', speaker: '' },
];
const segments = [
  { start: 0, end: 3000, text: 'One two',
    words: [['One', 0, 1000], ['two', 1000, 2000]] },
  { start: 2000, end: 5000, text: 'And then',
    words: [['And', 2000, 2000], ['then', 4000, 1000]] },
];
const nativeCues = mergeCues(vtt, { native: true, segments }, null);
const repairedCues = mergeCues(vtt, { segments }, null);
assert.strictEqual(nativeCues[1].speechStart, 2,
  'native 首词 2.0s 起说话，不能被当成上一句粘过来的尾巴');
assert.strictEqual(repairedCues[1].speechStart, 4,
  '修正过的 sidecar 仍要跳过被拉长的首词');

const fastVtt = [{ start: 0, end: 3, text: 'A B C D', speaker: '' }];
const fastSegments = [{ start: 0, end: 3000, text: 'A B C D',
  words: [['A', 0, 50], ['B', 50, 50], ['C', 100, 50], ['D', 2000, 500]] }];
const fastNative = mergeCues(fastVtt, { native: true, segments: fastSegments }, null);
const fastRepaired = mergeCues(fastVtt, { segments: fastSegments }, null);
const starts = cues => cues[0].words.map(w => Number(w.s.toFixed(2)));
assert.deepStrictEqual(starts(fastNative), [0, 0.05, 0.1, 2],
  '原生词时间必须原样保留');
assert.deepStrictEqual(starts(fastRepaired), [0, 0.6, 1.2, 2],
  '压缩词串在修正过的 sidecar 上仍按停顿铺开');
"""

    def test_native_word_timing_is_not_repaired(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node 不在 PATH，跳过播放器逻辑测试")
        page = (SITE / "player.html").read_text(encoding="utf-8")
        start = page.index("function splitBilingual(text)")
        end = page.index("function splitLabel(text, words)")
        source = self.HARNESS % page[start:end]
        with tempfile.TemporaryDirectory() as temp_dir:
            script = Path(temp_dir) / "player_word_timing.js"
            script.write_text(source, encoding="utf-8")
            proc = subprocess.run(
                [node, str(script)], capture_output=True, text=True, encoding="utf-8"
            )
        self.assertEqual(proc.returncode, 0, proc.stderr)


class PlayerOffsetTests(unittest.TestCase):
    def test_align_button_enters_pick_cue_mode(self):
        page = (SITE / "player.html").read_text(encoding="utf-8")
        self.assertIn('id="alignCue"', page)
        self.assertIn("function toggleAlignMode", page)
        self.assertIn("function alignToCue", page)
        self.assertIn("state.alignMode", page)
        self.assertIn("body.classList.toggle('aligning'", page)


class SiteIconTests(unittest.TestCase):
    def test_icon_assets_exist_and_every_page_links_them(self):
        self.assertTrue((SITE / "favicon.svg").is_file())
        self.assertTrue((SITE / "apple-touch-icon.png").is_file())
        player = (SITE / "player.html").read_text(encoding="utf-8")
        self.assertIn('href="favicon.svg"', player)
        self.assertIn('href="apple-touch-icon.png"', player)
        for page in [SITE / "index.html", SITE / "podcasts.html"]:
            self.assertIn('href="favicon.svg"', page.read_text(encoding="utf-8"))
        for show in load_shows():
            page = (SITE / show["slug"] / "index.html").read_text(encoding="utf-8")
            self.assertIn('href="../favicon.svg"', page)


class PlayerEntryTests(unittest.TestCase):
    def test_player_page_is_wired_to_manifest(self):
        page = (SITE / "player.html").read_text(encoding="utf-8")
        self.assertIn("shows.json", page)
        self.assertIn('id="showSel"', page)

    def test_index_pages_link_to_player(self):
        self.assertIn("player.html", (SITE / "podcasts.html").read_text(encoding="utf-8"))
        self.assertIn("player.html", (SITE / "index.html").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
