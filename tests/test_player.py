import json
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
