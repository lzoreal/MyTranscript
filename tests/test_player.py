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


def run_node(testcase, name, source):
    """在临时目录里跑一段从 player.html 抽出的 JS，返回 CompletedProcess。"""
    node = shutil.which("node")
    if not node:
        testcase.skipTest("node 不在 PATH，跳过播放器逻辑测试")
    with tempfile.TemporaryDirectory() as temp_dir:
        script = Path(temp_dir) / name
        script.write_text(source, encoding="utf-8")
        return subprocess.run([node, str(script)], capture_output=True, text=True, encoding="utf-8")


def player_page():
    return (SITE / "player.html").read_text(encoding="utf-8")


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
                       'myt-subs', 'parseOpml', 'el.dataset.openEpisode !== undefined']:
            self.assertIn(needle, page)


class PlayerMiniTransportTests(unittest.TestCase):
    HARNESS = """
const assert = require('assert');
%s
const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
assert.strictEqual(stepTarget(list, 'b', -1).id, 'a');
assert.strictEqual(stepTarget(list, 'b', 1).id, 'c');
assert.strictEqual(stepTarget(list, 'a', -1), null);
assert.strictEqual(stepTarget(list, 'c', 1), null);
assert.strictEqual(stepTarget(list, 'missing', 1), null);
"""

    def test_mini_player_steps_episodes_and_shows_live_caption(self):
        page = (SITE / "player.html").read_text(encoding="utf-8")
        for needle in ['id="miniPrev"', 'id="miniNext"', 'aria-label="上一集"', 'aria-label="下一集"',
                       'function stepTarget', 'function stepEpisode', 'id="miniCaption"',
                       'function syncMiniCaption', 'syncMiniCaption();',
                       "$('miniPrev').disabled = index <= 0", "$('miniNext').disabled = index < 0"]:
            self.assertIn(needle, page)
        self.assertIn("!document.body.classList.contains('player-open') && !!state.current && !!cue && !!cue.text", page)

    def test_mini_caption_row_merges_into_panel_and_toggles(self):
        page = (SITE / "player.html").read_text(encoding="utf-8")
        for needle in ['<div class="mini-main">', 'id="miniExpand"', 'aria-expanded=',
                       'function toggleMiniCaption', "MINI_CAPTION_KEY = 'myt-mini-caption'",
                       "classList.toggle('caption-collapsed'",
                       "$('miniExpand').onclick = () => toggleMiniCaption();",
                       "localStorage.setItem(MINI_CAPTION_KEY"]:
            self.assertIn(needle, page)
        self.assertNotIn("miniExpand').onclick = () => navigate('player'", page)

    def test_mini_play_button_uses_centered_svg_icons(self):
        page = (SITE / "player.html").read_text(encoding="utf-8")
        self.assertIn("$('miniPlay').innerHTML = playing", page)
        self.assertIn('M9.5 7.4v9.2L17.2 12z', page)
        self.assertIn('M9 7.5h2.2v9H9zM12.8 7.5H15v9h-2.2z', page)
        self.assertNotIn("$('miniPlay').textContent = audio.paused", page)

    def test_step_target_walks_the_episode_list(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node 不在 PATH，跳过播放器逻辑测试")
        page = (SITE / "player.html").read_text(encoding="utf-8")
        source = self.HARNESS % page[page.index("function stepTarget"):page.index("function stepEpisode")]
        with tempfile.TemporaryDirectory() as temp_dir:
            script = Path(temp_dir) / "step_target.js"
            script.write_text(source, encoding="utf-8")
            proc = subprocess.run([node, str(script)], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(proc.returncode, 0, proc.stderr)


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
  {title: 'Beta', author: 'B', url: 'https://b/feed', image: 'https://img/b', episodeCount: 7, description: 'Feed blurb'},
  {title: 'No url'},
]});
assert.deepStrictEqual(pi.map(x => x.title), ['Beta']);
assert.strictEqual(pi[0].genre, '');
assert.strictEqual(pi[0].description, 'Feed blurb');
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

    def test_online_results_open_a_detail_preview(self):
        page = (SITE / "player.html").read_text(encoding="utf-8")
        for needle in ['data-online-detail="', 'function openOnlineDetail', 'function openOnlinePreview',
                       'function onlineDetailHTML', 'class="online-detail-desc"',
                       '[role="link"][data-online-detail]']:
            self.assertIn(needle, page)
        self.assertIn('if (el.dataset.onlineDetail) { openOnlineDetail(el.dataset.onlineDetail); return; }', page)


class PlayerPodcastDetailTests(unittest.TestCase):
    def test_detail_shows_full_intro_without_feed_url_line(self):
        page = (SITE / "player.html").read_text(encoding="utf-8")
        self.assertNotIn("class=\"feed-line\"", page)
        self.assertNotIn("max-width:680px;display:-webkit-box;-webkit-line-clamp:4", page)
        self.assertIn("const feedUrl = show.feed ? absoluteFeed(show.feed) : '';", page)


class PlayerMiniOpenTests(unittest.TestCase):
    def test_mini_cover_opens_the_transcript(self):
        page = (SITE / "player.html").read_text(encoding="utf-8")
        self.assertIn("$('miniCover').onclick = () => navigate('player'", page)
        self.assertIn('id="miniCover" title="打开播放器"', page)


class PlayerCueFollowTests(unittest.TestCase):
    def test_entering_the_player_forces_the_active_cue_into_view(self):
        page = (SITE / "player.html").read_text(encoding="utf-8")
        self.assertIn("state.pendingFollow = true;", page)
        self.assertIn("if (state.cues.length) {\n    returnToCue();", page)
        self.assertIn("const follow = force || state.pendingFollow;", page)
        self.assertIn("} else if (ci >= 0 && state.pendingFollow) {", page)
        self.assertIn("state.pendingFollow = false; state.userScrollUntil = Date.now() + 3000;", page)
        self.assertIn("state.seekRaw = t;\n      state.pendingFollow = true;", page)



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


class PlayerRemovalRoutingTests(unittest.TestCase):
    HARNESS = """
const assert = require('assert');
%s
assert.strictEqual(removalLeavesCurrentShow({page: 'podcast', args: ['ext-x']}, 'ext-x'), true);
assert.strictEqual(removalLeavesCurrentShow({page: 'episode', args: ['ext-x', 'e1']}, 'ext-x'), true);
assert.strictEqual(removalLeavesCurrentShow({page: 'player', args: ['ext-x', 'e1']}, 'ext-x'), true);
assert.strictEqual(removalLeavesCurrentShow({page: 'settings', args: []}, 'ext-x'), false);
assert.strictEqual(removalLeavesCurrentShow({page: 'podcast', args: ['ext-y']}, 'ext-x'), false);
assert.strictEqual(removalLeavesCurrentShow({page: 'podcast', args: []}, ''), false);
"""

    def test_removing_the_open_show_returns_home(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node 不在 PATH，跳过播放器逻辑测试")
        page = (SITE / "player.html").read_text(encoding="utf-8")
        source = self.HARNESS % page[page.index("function removalLeavesCurrentShow"):page.index("function unsubscribeKey")]
        with tempfile.TemporaryDirectory() as temp_dir:
            script = Path(temp_dir) / "removal_route.js"
            script.write_text(source, encoding="utf-8")
            proc = subprocess.run([node, str(script)], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(proc.returncode, 0, proc.stderr)


class PlayerBuiltinImportTests(unittest.TestCase):
    def test_builtin_sources_require_explicit_import(self):
        page = (SITE / "player.html").read_text(encoding="utf-8")
        self.assertIn("if (stored == null) {\n    app.subs = [];", page)
        self.assertIn("function openBuiltinImport", page)
        self.assertIn('id="libBuiltinBtn"', page)
        self.assertIn('id="discoverBuiltinBtn"', page)
        self.assertIn('data-action="import-builtin"', page)


class PlayerFeedCacheTests(unittest.TestCase):
    HARNESS = """
const assert = require('assert');
%s
const now = 1800000000000;
const ttl = 6 * 60 * 60 * 1000;
assert.strictEqual(feedCacheFresh({ xml: '<rss/>', at: now - 1000 }, now), true);
assert.strictEqual(feedCacheFresh({ xml: '<rss/>', at: now - ttl }, now), true);
assert.strictEqual(feedCacheFresh({ xml: '<rss/>', at: now - ttl - 1 }, now), false);
assert.strictEqual(feedCacheFresh({ xml: '<rss/>' }, now), false);
assert.strictEqual(feedCacheFresh({ at: now }, now), false);
assert.strictEqual(feedCacheFresh(null, now), false);
"""

    def test_external_feed_cache_expires_after_six_hours(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node 不在 PATH，跳过播放器逻辑测试")
        page = (SITE / "player.html").read_text(encoding="utf-8")
        source = self.HARNESS % page[page.index("const FEED_CACHE_TTL"):page.index("async function fetchFeedText")]
        with tempfile.TemporaryDirectory() as temp_dir:
            script = Path(temp_dir) / "feed_cache.js"
            script.write_text(source, encoding="utf-8")
            proc = subprocess.run([node, str(script)], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(proc.returncode, 0, proc.stderr)


class PlayerAccessibilityTests(unittest.TestCase):
    def test_overlays_keyboard_and_labels_are_accessibly_wired(self):
        page = (SITE / "player.html").read_text(encoding="utf-8")
        for needle in ['<dialog class="modal"', 'showModal()', 'aria-modal="true"',
                       'aria-labelledby="drawerTitle"', 'role="region" aria-label="文字稿"',
                       "wrap.lang = 'en'", "z.lang = 'zh-CN'", 'function updateDocumentTitle',
                       "el.setAttribute('role', 'link')",
                       'aria-valuetext', 'aria-label="搜索我的播客和单集"',
                       'input:focus-visible', 'aria-label="播放速度" inert']:
            self.assertIn(needle, page)


class PlayerStartupTests(unittest.TestCase):
    HARNESS = """
const assert = require('assert');
__SLICE__
globalThis.fetch = (url, options) => new Promise((resolve, reject) => {
  const signal = options && options.signal;
  if (signal) signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
});
(async () => {
  const started = Date.now();
  const value = await getJson('catalog.json', 40);
  assert.strictEqual(value, null, '超时应降级为 null 而不是一直挂起');
  assert.ok(Date.now() - started < 1500, '超时必须很快结束');
})().catch(err => { console.error(err); process.exit(1); });
"""

    def test_shell_and_route_start_before_catalog_finishes(self):
        page = player_page()
        body = page[page.index("const SHELL_TIMEOUT"):page.index("function refreshCatalogPages")]
        self.assertIn("async function initPlayer", body)
        self.assertNotIn("await loadCatalog()", body)
        self.assertLess(body.index("bindShell();"), body.index("applyRoute();"))
        self.assertLess(body.index("applyRoute();"), body.index("loadCatalog().then"))
        self.assertIn("app.catalogPending", body)
        self.assertIn("refreshCatalogPages()", body)
        self.assertIn("完整目录读取失败或超时", page)

    def test_json_reads_time_out(self):
        page = player_page()
        source = self.HARNESS.replace("__SLICE__", page[page.index("function getJson"):page.index("// 英文 VTT 已不发布")])
        proc = run_node(self, "get_json_timeout.js", source)
        self.assertEqual(proc.returncode, 0, proc.stderr)


class PlayerMemoryFeedCacheTests(unittest.TestCase):
    HARNESS = """
const assert = require('assert');
const app = { feedCache: new Map() };
const state = { feeds: new Map() };
__SLICE__
const ttl = 6 * 60 * 60 * 1000;
rememberFeed('a', { episodes: [{ id: '1' }] });
assert.strictEqual(memoryFeed('a').episodes[0].id, '1');
assert.strictEqual(state.feeds.has('a'), true);
assert.strictEqual(memoryFeed('a', Date.now() + ttl + 1), null);
assert.strictEqual(app.feedCache.has('a'), false, '过期后必须清除内存缓存');
assert.strictEqual(state.feeds.has('a'), false);
assert.strictEqual(hasFreshFeed('missing'), false);
rememberFeed('', { episodes: [] });
assert.strictEqual(app.feedCache.size, 0);
"""

    def test_memory_feed_cache_honours_the_same_ttl(self):
        page = player_page()
        source = self.HARNESS.replace("__SLICE__", page[page.index("const FEED_CACHE_TTL"):page.index("async function fetchFeedText")])
        proc = run_node(self, "memory_feed_cache.js", source)
        self.assertEqual(proc.returncode, 0, proc.stderr)


class PlayerOnlineSearchRaceTests(unittest.TestCase):
    HARNESS = """
const assert = require('assert');
const app = { online: { query: '', loading: false, results: [], sources: [], piError: '', error: '', seq: 0, cache: new Map(), visible: 20 } };
const ONLINE_PAGE = 20;
let renders = 0;
const renderOnlineResults = () => { renders++; };
let release;
const gate = new Promise(resolve => { release = resolve; });
let appleCalls = 0;
const searchApple = async () => { appleCalls++; await gate; return [{ feedUrl: 'https://slow/feed', title: 'Slow Show' }]; };
const searchPodcastIndex = async () => [];
const mergeSearchResults = lists => lists.flat();
__SLICE__
(async () => {
  const first = runOnlineSearch('SmartLess');
  await Promise.resolve();
  const second = runOnlineSearch('   ');
  release();
  await Promise.all([first, second]);
  assert.strictEqual(app.online.query, '', '清空查询后不能保留旧关键词');
  assert.deepStrictEqual(app.online.results, [], '过期请求不得覆盖空结果');
  assert.strictEqual(app.online.loading, false);
  assert.strictEqual(renders >= 2, true);
  app.online.cache.set('cached', { results: [{ feedUrl: 'https://c/feed', title: 'C' }], sources: ['Apple Podcasts'], piError: '', at: Date.now() });
  await runOnlineSearch(' Cached ');
  assert.strictEqual(app.online.results.length, 1);
  assert.strictEqual(app.online.query, 'Cached');
})().catch(err => { console.error(err); process.exit(1); });
"""

    def test_empty_query_invalidates_the_previous_request(self):
        page = player_page()
        source = self.HARNESS.replace("__SLICE__", page[page.index("async function runOnlineSearch"):page.index("function onlineRowHTML")])
        proc = run_node(self, "online_search_race.js", source)
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_online_results_are_paged(self):
        page = player_page()
        for needle in ["const ONLINE_PAGE = 20;", "data-online-more", "加载更多（还有 "]:
            self.assertIn(needle, page)


class PlayerSearchDedupeTests(unittest.TestCase):
    HARNESS = """
const assert = require('assert');
const app = {
  builtinShows: [{ slug: 'the-daily', name: 'The Daily (Unofficial) - Transcripts', feed: 'the-daily/feed.xml', builtin: true }],
  subs: [],
};
__SLICE__
__SLICE2__
assert.strictEqual(feedKey('https://Example.com:443/Feed/'), feedKey('https://example.com/Feed'));
assert.strictEqual(feedKey('https://example.com/feed/'), 'https://example.com/feed');
assert.notStrictEqual(feedKey('https://example.com/feed?a=1'), feedKey('https://example.com/feed'));
const merged = mergeSearchResults([
  [{ feedUrl: 'https://Example.com/feed/', title: 'Merged', source: 'apple' }],
  [{ feedUrl: 'https://example.com:443/feed', description: 'Blurb', image: 'https://img/x', source: 'podcastindex' }],
]);
assert.strictEqual(merged.length, 1, '同一 RSS 的不同写法必须去重');
assert.strictEqual(merged[0].title, 'Merged');
assert.strictEqual(merged[0].description, 'Blurb');
assert.strictEqual(merged[0].image, 'https://img/x');
assert.deepStrictEqual(merged[0].sources.sort(), ['apple', 'podcastindex']);
assert.strictEqual(findBuiltinByFeed('https://THE-DAILY:443/feed.xml/').slug, 'the-daily');
assert.strictEqual(findBuiltinByFeed('https://other.example/feed.xml'), null);
const shows = [{ name: 'The Daily', slug: 'the-daily', feed: 'the-daily/feed.xml' }];
assert.strictEqual(findBuiltinForTitle('The Daily!', shows).slug, 'the-daily');
assert.strictEqual(findBuiltinForTitle('The Daily', [{ ...shows[0], feed: null }]), null);
"""

    def test_feed_url_formats_dedupe_and_url_match_beats_title(self):
        page = player_page()
        source = (self.HARNESS
                  .replace("__SLICE2__", page[page.index("function searchTitleKey"):page.index("async function fetchJson")])
                  .replace("__SLICE__", page[page.index("function normalizeFeedUrl"):page.index("function showByKey")]))
        proc = run_node(self, "search_dedupe.js", source)
        self.assertEqual(proc.returncode, 0, proc.stderr)


class PlayerDiscoverFilterTests(unittest.TestCase):
    HARNESS = """
const assert = require('assert');
const app = { catalog: { shows: [] }, subs: [{ key: 'news' }] };
const isSubscribed = key => app.subs.some(sub => sub.key === key);
const catalogLatest = show => show.latest || [];
__SLICE__
__SLICE2__
const shows = [
  { slug: 'news', name: 'The Daily', feed: 'x', description: 'Daily news briefing', categories: ['News', 'Daily News'],
    language: 'en', episode_count: 10, transcript_count: 8, latest_published_at: '2026-11-15T11:00:00Z',
    latest: [{ date: 'Sun, 15 Nov 2026 11:00:00 +0000' }] },
  { slug: 'history', name: 'The Rest Is History', feed: 'y', description: 'History show', categories: ['History'],
    language: 'en-gb', episode_count: 741, transcript_count: 741, latest_published_at: '2026-11-14T16:00:00Z', latest: [] },
  { slug: 'comedy', name: 'SmartLess', feed: 'z', description: 'Comedy chat', categories: ['Comedy'],
    language: 'en', episode_count: 387, transcript_count: 0, latest_published_at: '2026-11-13T08:00:00Z', latest: [] },
  { slug: 'no-feed', name: 'Hidden', feed: null, categories: ['History'], episode_count: 0, transcript_count: 0 },
];
const ids = list => list.map(show => show.slug);
assert.deepStrictEqual(ids(filterCatalogShows(shows, {})), ['news', 'history', 'comedy']);
assert.deepStrictEqual(ids(filterCatalogShows(shows, { query: 'briefing' })), ['news']);
assert.deepStrictEqual(ids(filterCatalogShows(shows, { query: 'rest' })), ['history'], '未订阅也能搜到');
assert.deepStrictEqual(ids(filterCatalogShows(shows, { query: '历史' })), ['history'], '分类中文标签也能搜');
assert.deepStrictEqual(ids(filterCatalogShows(shows, { category: 'History' })), ['history']);
assert.deepStrictEqual(ids(filterCatalogShows(shows, { sub: 'sub' })), ['news']);
assert.deepStrictEqual(ids(filterCatalogShows(shows, { sub: 'unsub' })), ['history', 'comedy']);
assert.deepStrictEqual(ids(filterCatalogShows(shows, { sort: 'latest' })), ['news', 'history', 'comedy']);
assert.deepStrictEqual(ids(filterCatalogShows(shows, { sort: 'episodes' })), ['history', 'comedy', 'news']);
assert.deepStrictEqual(ids(filterCatalogShows(shows, { sort: 'name' })), ['comedy', 'news', 'history']);
assert.deepStrictEqual(ids(filterCatalogShows(shows, { transcripts: true })), ['news', 'history']);
"""

    def test_catalog_filter_search_sort_and_status(self):
        page = player_page()
        source = (self.HARNESS
                  .replace("__SLICE2__", page[page.index("function primaryCategory"):page.index("function syncDiscoverControls")])
                  .replace("__SLICE__", page[page.index("const CATEGORY_LABELS"):page.index("function transcriptCoverage")]))
        proc = run_node(self, "discover_filter.js", source)
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_discover_page_exposes_the_filter_controls(self):
        page = player_page()
        for needle in ['id="discoverFilter"', 'id="discoverCategory"', 'id="discoverSort"',
                       'id="discoverSub"', 'id="discoverTranscript"', 'id="discoverCount"',
                       'id="discoverCatalogNote"']:
            self.assertIn(needle, page)


class PlayerTranscriptCoverageTests(unittest.TestCase):
    HARNESS = """
const assert = require('assert');
__SLICE__
assert.strictEqual(transcriptCoverage({ episode_count: 0, transcript_count: 0 }), 0);
assert.strictEqual(transcriptCoverage({ episode_count: 3038, transcript_count: 1519 }), 50);
const html = coverageHTML({ builtin: true, episode_count: 3038, transcript_count: 3038 });
assert.ok(html.includes('3038/3038'));
assert.ok(html.includes('100%'));
assert.strictEqual(coverageHTML({ builtin: false, episode_count: 1, transcript_count: 1 }), '');
"""

    def test_coverage_is_reported_separately_from_episode_count(self):
        page = player_page()
        source = self.HARNESS.replace("__SLICE__", page[page.index("function transcriptCoverage"):page.index("function podCardHTML")])
        proc = run_node(self, "coverage.js", source)
        self.assertEqual(proc.returncode, 0, proc.stderr)


class PlayerCardSemanticsTests(unittest.TestCase):
    def test_card_link_and_subscribe_button_are_siblings(self):
        page = player_page()
        card = page[page.index("function podCardHTML"):page.index("function episodeRowHTML")]
        self.assertIn('class="pod-card-main" href="', card)
        self.assertIn('<div class="pod-actions">', card)
        self.assertNotIn('<div class="pod-card" data-open-podcast=', card)
        self.assertIn("coverageHTML(show)", card)
        self.assertIn("pod-latest", card)
        self.assertIn("showCategoryText(show)", card)


if __name__ == "__main__":
    unittest.main()
