import json
import re
import shutil
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

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
        elif url.startswith("https://raw.githubusercontent.com/lzoreal/MyTranscript/data/"):
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
                    slug = quote(show["slug"], safe="-._~")
                    self.assertIn(f"/json/{slug}/", url)
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


class PlayerDirectAudioTests(unittest.TestCase):
    HARNESS = """
const assert = require('assert');
%s
assert.strictEqual(
  directAudioUrl('https://pdst.fm/e/pscrb.fm/rss/p/tracking.swap.fm/track/v9Uiw/serve.castfire.com/audio/1.mp3?rssID=1'),
  'https://serve.castfire.com/audio/1.mp3?rssID=1');
assert.strictEqual(
  directAudioUrl('https://dts.podtrac.com/redirect.mp3/pdst.fm/e/x/tracking.swap.fm/track/abc/nyt.simplecastaudio.com/e/audio/128/default.mp3?aid=1'),
  'https://nyt.simplecastaudio.com/e/audio/128/default.mp3?aid=1');
assert.strictEqual(
  directAudioUrl('https://dts.podtrac.com/redirect.mp3/stitcher.simplecastaudio.com/559b/episodes/1/audio/128/default.mp3?aid=rss_feed'),
  'https://stitcher.simplecastaudio.com/559b/episodes/1/audio/128/default.mp3?aid=rss_feed');
assert.strictEqual(directAudioUrl('https://dts.podtrac.com/redirect.mp3/pdst.fm/e/audio/1.mp3'), '');
assert.strictEqual(directAudioUrl('https://example.com/a.mp3'), '');
assert.strictEqual(
  preferredAudioUrl({url: 'https://dts.podtrac.com/redirect.mp3/stitcher.simplecastaudio.com/a/b.mp3'}),
  'https://stitcher.simplecastaudio.com/a/b.mp3');
assert.strictEqual(preferredAudioUrl({url: 'https://example.com/a.mp3'}), 'https://example.com/a.mp3');
assert.strictEqual(preferredAudioUrl({}), '');
"""

    def test_tracking_chain_falls_back_to_the_cdn_host(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node 不在 PATH，跳过播放器逻辑测试")
        page = (SITE / "player.html").read_text(encoding="utf-8")
        start = page.index("function directAudioUrl")
        end = page.index("function tryAudioSource")
        source = self.HARNESS % page[start:end]
        with tempfile.TemporaryDirectory() as temp_dir:
            script = Path(temp_dir) / "direct_audio.js"
            script.write_text(source, encoding="utf-8")
            proc = subprocess.run(
                [node, str(script)], capture_output=True, text=True, encoding="utf-8"
            )
        self.assertEqual(proc.returncode, 0, proc.stderr)


class PlayerArtworkTests(unittest.TestCase):
    HARNESS = """
const assert = require('assert');
%s
assert.strictEqual(
  smallArtwork('https://image.simplecastcdn.com/images/a/b/3000x3000/cover-3000x3000-final.jpg?aid=rss_feed'),
  'https://image.simplecastcdn.com/images/a/b/300x300/cover-3000x3000-final.jpg?aid=rss_feed');
assert.strictEqual(smallArtwork('https://example.com/a.jpg'), '');
assert.strictEqual(smallArtwork('https://image.simplecastcdn.com/images/a/b/300x300/a.jpg'), '');
assert.strictEqual(
  smallArtwork('https://is1-ssl.mzstatic.com/image/thumb/Podcasts211/v4/x/600x600bb.jpg'),
  'https://is1-ssl.mzstatic.com/image/thumb/Podcasts211/v4/x/200x200bb.jpg');
"""

    def test_list_thumbnails_use_the_small_rendition(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node 不在 PATH，跳过播放器逻辑测试")
        page = (SITE / "player.html").read_text(encoding="utf-8")
        start = page.index("function smallArtwork")
        end = page.index("function renderList")
        source = self.HARNESS % page[start:end]
        with tempfile.TemporaryDirectory() as temp_dir:
            script = Path(temp_dir) / "small_artwork.js"
            script.write_text(source, encoding="utf-8")
            proc = subprocess.run(
                [node, str(script)], capture_output=True, text=True, encoding="utf-8"
            )
        self.assertEqual(proc.returncode, 0, proc.stderr)


class PlayerNetworkTests(unittest.TestCase):
    def test_playback_starts_on_the_direct_cdn(self):
        page = (SITE / "player.html").read_text(encoding="utf-8")
        self.assertIn('rel="preconnect" href="https://stitcher.simplecastaudio.com"', page)
        self.assertIn("const audioUrl = preferredAudioUrl(item);", page)
        self.assertIn("audio.src = audioUrl;", page)
        self.assertIn("tryAudioSource(item.url) || tryAudioSource(item.directUrl)", page)

    def test_episode_artwork_is_lazy_loaded(self):
        page = (SITE / "player.html").read_text(encoding="utf-8")
        self.assertIn('loading="lazy" decoding="async" referrerpolicy="no-referrer"', page)


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


class PlayerShellTests(unittest.TestCase):
    def test_shell_and_routes_exist(self):
        page = (SITE / "player.html").read_text(encoding="utf-8")
        for needle in ['class="app"', 'id="page-home"', 'id="page-library"',
                       'id="page-discover"', 'id="page-settings"',
                       'id="miniPlayer"', 'function applyRoute', 'function routeHash',
                       'myt-subs', 'parseOpml']:
            self.assertIn(needle, page)


class PlayerOpmlTests(unittest.TestCase):
    HARNESS = """
const assert = require('assert');
%s
const items = parseOpml('<opml><body><outline text="A &amp; B" xmlUrl="https://a/feed?x=1&amp;y=2"/><outline title="B" xmlUrl="https://b/rss"/></body></opml>');
assert.deepStrictEqual(items.map(x => x.xmlUrl), ['https://a/feed?x=1&y=2', 'https://b/rss']);
assert.strictEqual(items[0].title, 'A & B');
const xml = buildOpml([{title: 'A & B', xmlUrl: 'https://a/feed?x=1&y=2'}], 'https://lzoreal.github.io/MyTranscript/');
assert.ok(xml.includes('xmlUrl="https://a/feed?x=1&amp;y=2"'));
assert.ok(xml.includes('text="A &amp; B"'));
"""

    def test_opml_round_trip(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node 不在 PATH，跳过播放器逻辑测试")
        page = (SITE / "player.html").read_text(encoding="utf-8")
        source = self.HARNESS % page[page.index("function decodeXml"):page.index("function downloadFile")]
        with tempfile.TemporaryDirectory() as temp_dir:
            script = Path(temp_dir) / "opml.js"
            script.write_text(source, encoding="utf-8")
            proc = subprocess.run([node, str(script)], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(proc.returncode, 0, proc.stderr)


class PlayerFeedUrlTests(unittest.TestCase):
    HARNESS = """
const assert = require('assert');
%s
assert.strictEqual(normalizeFeedUrl('example.com/rss'), 'https://example.com/rss');
assert.strictEqual(normalizeFeedUrl(' https://a/feed '), 'https://a/feed');
assert.strictEqual(extSlug('https://a/feed'), extSlug('https://a/feed'));
assert.notStrictEqual(extSlug('https://a/feed'), extSlug('https://b/feed'));
assert.ok(extSlug('https://a/feed').startsWith('ext-'));
"""

    def test_external_feed_keys_are_stable(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node 不在 PATH，跳过播放器逻辑测试")
        page = (SITE / "player.html").read_text(encoding="utf-8")
        source = self.HARNESS % page[page.index("function hash32"):page.index("function hostOf")]
        with tempfile.TemporaryDirectory() as temp_dir:
            script = Path(temp_dir) / "feed_url.js"
            script.write_text(source, encoding="utf-8")
            proc = subprocess.run([node, str(script)], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(proc.returncode, 0, proc.stderr)



class PlayerReaderLayoutTests(unittest.TestCase):
    def test_flat_layout_honours_width_and_gap_sliders(self):
        page = (SITE / "player.html").read_text(encoding="utf-8")
        self.assertIn("(100vw - var(--reader-w))/2", page)
        self.assertNotIn("(100vw - 850px)/2", page)
        self.assertIn("margin:var(--cue-gap) 0", page)
        self.assertIn("line-height:var(--cue-lh)", page)


class PlayerOnlineSearchTests(unittest.TestCase):
    HARNESS = """
const assert = require('assert');
%s
const apple = mapAppleResults({results: [
  {collectionName: 'Alpha', artistName: 'A', feedUrl: 'https://a/feed',
   artworkUrl600: 'https://img/600', artworkUrl100: 'https://img/100',
   trackCount: 12, primaryGenreName: 'Tech'},
  {collectionName: 'No feed', artistName: 'B'},
]});
assert.deepStrictEqual(apple.map(x => x.title), ['Alpha']);
assert.strictEqual(apple[0].image, 'https://img/600');
assert.strictEqual(apple[0].episodeCount, 12);
const pi = mapPodcastIndexResults({feeds: [
  {title: 'Beta', author: 'B', url: 'https://b/feed', image: 'https://img/b', episodeCount: 7},
  {title: 'No url'},
]});
assert.deepStrictEqual(pi.map(x => x.title), ['Beta']);
assert.strictEqual(pi[0].genre, '');
const merged = mergeSearchResults([
  [apple[0], {feedUrl: 'https://x/feed', title: 'X'}],
  [{feedUrl: 'https://x/feed', title: 'X'}, {feedUrl: 'https://c/feed', title: 'C'}],
]);
assert.deepStrictEqual(merged.map(x => x.feedUrl), ['https://x/feed', 'https://a/feed', 'https://c/feed']);
assert.ok(appleSearchUrl('a b').includes('term=a%%20b'));
assert.ok(podcastIndexSearchUrl('a b').includes('q=a%%20b'));
const shows = [{name: 'SmartLess', slug: 'smartless', feed: 'x'}];
assert.strictEqual(findBuiltinForTitle('SmartLess!', shows).slug, 'smartless');
assert.strictEqual(findBuiltinForTitle('SmartLess Presents ClueLess', shows), null);
(async () => {
  assert.strictEqual(await sha1Hex('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  const headers = await podcastIndexAuth('k', 's', 0);
  assert.strictEqual(headers['X-Auth-Key'], 'k');
  assert.strictEqual(headers['X-Auth-Date'], '0');
  assert.strictEqual(headers['Authorization'].length, 40);
})().catch(err => { console.error(err); process.exit(1); });
"""

    def test_online_search_mapping_and_merge(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node 不在 PATH，跳过播放器逻辑测试")
        page = (SITE / "player.html").read_text(encoding="utf-8")
        source = self.HARNESS % page[page.index("function appleSearchUrl"):page.index("function subscribedShowForFeed")]
        with tempfile.TemporaryDirectory() as temp_dir:
            script = Path(temp_dir) / "online_search.js"
            script.write_text(source, encoding="utf-8")
            proc = subprocess.run([node, str(script)], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_online_search_entry_exists(self):
        page = (SITE / "player.html").read_text(encoding="utf-8")
        for needle in ['id="onlineSearchInput"', 'function runOnlineSearch',
                       'PODCAST_INDEX', 'function searchPodcastIndex',
                       'data-online-subscribe']:
            self.assertIn(needle, page)



class PlayerPrototypeThemeTests(unittest.TestCase):
    def test_prototype_theme_is_registered(self):
        page = (SITE / "player.html").read_text(encoding="utf-8")
        self.assertIn('[data-theme="prototype"]{', page)
        self.assertIn("prototype: '原型'", page)
        self.assertIn("LIGHT_THEMES = new Set(['paper', 'mist', 'prototype'])", page)
        self.assertIn('data-theme="prototype"', page)


class PlayerThemeContrastTests(unittest.TestCase):
    THEMES = ["brass", "midnight", "forest", "oxblood", "celadon", "paper", "mist", "prototype"]

    def _block(self, page, name):
        if name == "brass":
            match = re.search(r":root\{\s*color-scheme:dark;(.*?)\n\}", page, re.S)
        else:
            match = re.search(r'\[data-theme="' + name + r'"\]\{(.*?)\n\}', page, re.S)
        self.assertIsNotNone(match, name)
        return dict(re.findall(r"--([A-Za-z0-9-]+):([^;]+);", match.group(1)))

    @staticmethod
    def _rgb(value):
        value = value.strip()
        if value.startswith("#"):
            return tuple(int(value[i:i + 2], 16) for i in (1, 3, 5))
        match = re.fullmatch(r"rgba?\(([^)]+)\)", value)
        return tuple(int(float(part)) for part in match.group(1).split(",")[:3])

    @staticmethod
    def _luminance(rgb):
        def channel(value):
            value /= 255
            return value / 12.92 if value <= 0.03928 else ((value + 0.055) / 1.055) ** 2.4
        r, g, b = (channel(part) for part in rgb)
        return 0.2126 * r + 0.7152 * g + 0.0722 * b

    def _contrast(self, a, b):
        high, low = sorted((self._luminance(self._rgb(a)), self._luminance(self._rgb(b))), reverse=True)
        return (high + 0.05) / (low + 0.05)

    def test_every_theme_keeps_secondary_text_readable(self):
        page = (SITE / "player.html").read_text(encoding="utf-8")
        minimum = {"muted": 5.5, "dim": 4.5, "soft": 6.5, "meta": 5.0, "accent": 4.5}
        for name in self.THEMES:
            tokens = self._block(page, name)
            for key, floor in minimum.items():
                for surface in ("bg", "panel"):
                    ratio = self._contrast(tokens[key], tokens[surface])
                    self.assertGreaterEqual(ratio, floor, f"{name}.{key} on {surface}: {ratio:.2f}")


if __name__ == "__main__":
    unittest.main()
