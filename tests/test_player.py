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


def rust_sources() -> str:
    """桌面壳全部 Rust 源码；模块会继续拆分，测试按内容找符号而不是认死 main.rs。"""
    root = Path(__file__).parents[1] / "apps" / "windows" / "src-tauri" / "src"
    return "\n".join(f.read_text(encoding="utf-8") for f in sorted(root.glob("*.rs")))

SITE = ROOT / "site"
BUILTIN = ROOT / "apps" / "windows" / "builtin-plugins"
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
    """把拆出去的外链样式与脚本内联回文档，还原成单文件形态再做文本断言。"""
    page = (SITE / "player.html").read_text(encoding="utf-8")
    css_path = SITE / "player.css"
    js_path = SITE / "player.js"
    if css_path.is_file():
        page = page.replace(
            '<link rel="stylesheet" href="player.css">',
            "<style>\n" + css_path.read_text(encoding="utf-8") + "</style>",
        )
    if js_path.is_file():
        page = page.replace(
            '<script src="player.js"></script>',
            "<script>\n" + js_path.read_text(encoding="utf-8") + "</script>",
        )
    return page


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
        page = player_page()
        self.assertIn("myt-progress", page)
        self.assertIn("saveProgress(true)", page)
        self.assertIn("state.resumeAt", page)
        self.assertIn("audio.currentTime = t", page)


class PlayerOfflineTranscriptTests(unittest.TestCase):
    def test_whole_episode_download_includes_transcript(self):
        page = player_page()
        self.assertIn("offlineTranscriptSave", page)
        self.assertIn("offlineTranscriptLoad", page)
        self.assertIn("hasTranscript", page)
        self.assertIn("saveOfflineTranscript", page)
        self.assertIn("readTranscriptDoc", page)
        self.assertIn("整集下载", page)
        self.assertIn("[data-offline-transcript]", page)

    def test_desktop_offline_storage_persists_transcript_sidecar(self):
        rust = rust_sources()
        self.assertIn("fn offline_save_transcript", rust)
        self.assertIn("fn offline_transcript_load", rust)
        self.assertIn("TRANSCRIPT_SUFFIX", rust)
        self.assertIn(".transcript.json", rust)
        self.assertIn("\"hasTranscript\"", rust)


class PlayerStudySummaryTests(unittest.TestCase):
    def test_episode_summary_has_topics_and_jump_actions(self):
        page = player_page()
        self.assertIn("data-ai-episode", page)
        self.assertIn("studyOpenEpisodeSummary", page)
        self.assertIn("studyTopicHTML", page)
        self.assertIn("topics (array of {title, start, end, summary})", page)
        self.assertIn("ads (array of {start, end, label})", page)
        self.assertIn("function studyAdHTML", page)
        self.assertIn('data-study-act="ad"', page)
        self.assertIn("studyApplyCachedAdRanges", page)
        self.assertIn("setState('adRanges', mergeAdRanges(", page)
        self.assertIn("merged.version = 3", page)
        self.assertIn('data-study-act="topic"', page)
        self.assertIn("studyCopyEpisode", page)

    def test_ad_ranges_from_ai_merge_into_playback_skip_ranges(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node 不在 PATH，跳过播放器逻辑测试")
        page = player_page()
        clock = page[page.index("function studyClockSeconds"):page.index("function studyTopicHTML")]
        ranges = page[page.index("function sanitizeAdRanges"):page.index("function detectAdRanges")]
        source = """
const assert = require('assert');
%s
%s
const ai = sanitizeAdRanges([
  {start: '01:00', end: '01:30', label: '赞助口播'},
  {start: '00:50', end: '01:05', label: ''},
]);
assert.strictEqual(ai.length, 2);
assert.strictEqual(ai[0].start, 60);
assert.strictEqual(ai[1].label, '广告');
const merged = mergeAdRanges([ai, [{start: 40, end: 55, label: '文字稿广告标记', source: 'transcript'}]]);
assert.strictEqual(merged.length, 1);
assert.strictEqual(merged[0].start, 40);
assert.strictEqual(merged[0].end, 90);
""" % (clock, ranges)
        proc = run_node(self, "ai_ad_ranges.js", source)
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_ai_provider_picker_and_native_adapters(self):
        page = player_page()
        self.assertIn('id="studyProvider"', page)
        for provider in ("openai", "claude", "gemini", "deepseek", "kimi", "glm", "custom"):
            self.assertIn(f'value="{provider}"', page)
        self.assertIn("STUDY_PROVIDERS", page)
        self.assertIn("engine: STUDY.provider", page)
        self.assertIn("studyModelFetch", page)
        self.assertIn("studyModelList", page)
        self.assertIn("studyModelPicker", page)
        self.assertIn("studyPickModel", page)
        self.assertIn("STUDY_SUMMARY_CHUNKS = 3", page)
        self.assertIn("':partial'", page)
        self.assertIn("episodeFresh", page)
        rust = (ROOT / "apps" / "windows" / "src-tauri" / "src" / "translate.rs").read_text(encoding="utf-8")
        self.assertIn("async fn openai_chat", rust)
        self.assertIn("async fn claude_chat", rust)
        self.assertIn("async fn gemini_chat", rust)
        self.assertIn("pub async fn llm_models", rust)
        self.assertIn("fn parse_gemini_models", rust)
        self.assertIn("llm_models", rust_sources())
        self.assertIn('"x-api-key"', rust)
        self.assertIn('"anthropic-version"', rust)
        self.assertIn('"x-goog-api-key"', rust)
        self.assertIn(":generateContent", rust)


class PlayerStudyAskTests(unittest.TestCase):
    """问答、章节、金句都只让模型给行号，时间一律回查 ASR cue。"""

    def test_ask_tab_is_grounded_and_citable(self):
        page = player_page()
        self.assertIn('data-study-view="ask"', page)
        self.assertIn("function studyRenderAsk", page)
        self.assertIn("function studyAskContext", page)
        self.assertIn("function studyAskCites", page)
        self.assertIn("function studyAskCitesFromText", page)
        self.assertIn("1-4 integer line numbers you actually relied on", page)
        self.assertIn("total_lines: context.count", page)
        self.assertIn("previous_turns", page)
        self.assertIn('data-study-act="askCite"', page)
        self.assertIn("if (!cites.length) cites = studyAskCitesFromText(answer);", page)
        self.assertIn("return out.slice(0, 4)", page)
        self.assertIn("studyCache['ch:'", page)
        self.assertIn("const STUDY_ASK_KEY = 'myt-study-ask'", page)

    def test_citations_are_sanitized_against_cues(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node 不在 PATH，跳过播放器逻辑测试")
        page = player_page()
        block = page[page.index("function studyAskTimeCue"):page.index("function studyAskSuggestions")]
        source = """
const assert = require('assert');
const state = { cues: [
  { start: 0, text: 'intro' },
  { start: 61, text: 'second' },
  { start: 185, text: 'third' },
] };
%s
assert.deepStrictEqual(studyAskCites([2, 99, '1', { cue: 0 }]), [2, 1, 0]);
assert.deepStrictEqual(studyAskCites(['#0', 'garbage', [], null, 0]), [0]);
assert.deepStrictEqual(studyAskCites([2, '02:00']), [2]);
assert.deepStrictEqual(studyAskCitesFromText('he said [01:01], then 03:05 and 99:99'), [1, 2]);
assert.deepStrictEqual(studyAskCitesFromText('no timestamps here'), []);
""" % block
        proc = run_node(self, "study_ask_cites.js", source)
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_chapters_and_quotes_map_line_numbers_to_cue_time(self):
        page = player_page()
        self.assertIn("function studyAnalyzeChapters", page)
        self.assertIn("function studyChaptersHTML", page)
        self.assertIn('data-study-act="chapters"', page)
        self.assertIn("line numbers that literally appear in the given lines", page)
        self.assertIn("if (!Number.isInteger(ci) || ci < Math.max(0, from - 2)", page)
        self.assertIn("function studyAnalyzeQuotes", page)
        self.assertIn("function studyQuotesHTML", page)
        self.assertIn('data-study-act="quotes"', page)
        self.assertIn('data-study-act="quoteCard"', page)
        self.assertIn("function studyWrapCanvasText", page)
        self.assertIn("data-quote-download", page)
        self.assertIn("data-quote-copy", page)
        self.assertIn("studyCueStamp(cue)", page)


class PlayerWordTimingTests(unittest.TestCase):
    """词级 JSON 用 ASR 原生时间，不能再被 VTT 压缩时间轴的修补改写。"""

    HARNESS = """
const assert = require('assert');
const opts = { lang: 'en', segment: false };
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
const nativeCues = merge(vtt, { native: true, segments }, null, opts);
const repairedCues = merge(vtt, { segments }, null, opts);
assert.strictEqual(nativeCues[1].speechStart, 2,
  'native 首词 2.0s 起说话，不能被当成上一句粘过来的尾巴');
assert.strictEqual(repairedCues[1].speechStart, 4,
  '修正过的 sidecar 仍要跳过被拉长的首词');

const fastVtt = [{ start: 0, end: 3, text: 'A B C D', speaker: '' }];
const fastSegments = [{ start: 0, end: 3000, text: 'A B C D',
  words: [['A', 0, 50], ['B', 50, 50], ['C', 100, 50], ['D', 2000, 500]] }];
const fastNative = merge(fastVtt, { native: true, segments: fastSegments }, null, opts);
const fastRepaired = merge(fastVtt, { segments: fastSegments }, null, opts);
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
        kernel = (BUILTIN / "subtitles" / "kernel.js").read_text(encoding="utf-8")
        source = "global.window = global;\n" + (self.HARNESS % kernel)
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
        page = player_page()
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
        page = player_page()
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
        page = player_page()
        self.assertIn('rel="preconnect" href="https://stitcher.simplecastaudio.com"', page)
        self.assertIn("const audioUrl = preferredAudioUrl(item);", page)
        self.assertIn("audio.src = audioUrl;", page)
        self.assertIn("tryAudioSource(item.url) || tryAudioSource(item.directUrl)", page)

    def test_episode_artwork_is_lazy_loaded(self):
        page = player_page()
        self.assertIn('loading="lazy" decoding="async" referrerpolicy="no-referrer"', page)


class PlayerOffsetTests(unittest.TestCase):
    def test_align_button_enters_pick_cue_mode(self):
        page = player_page()
        self.assertIn('id="alignCue"', page)
        self.assertIn("function toggleAlignMode", page)
        self.assertIn("function alignToCue", page)
        self.assertIn("state.alignMode", page)
        self.assertIn("body.classList.toggle('aligning'", page)


class SiteIconTests(unittest.TestCase):
    def test_icon_assets_exist_and_every_page_links_them(self):
        self.assertTrue((SITE / "favicon.svg").is_file())
        self.assertTrue((SITE / "apple-touch-icon.png").is_file())
        player = player_page()
        self.assertIn('href="favicon.svg"', player)
        self.assertIn('href="apple-touch-icon.png"', player)
        for page in [SITE / "index.html", SITE / "podcasts.html"]:
            self.assertIn('href="favicon.svg"', page.read_text(encoding="utf-8"))
        for show in load_shows():
            page = (SITE / show["slug"] / "index.html").read_text(encoding="utf-8")
            self.assertIn('href="../favicon.svg"', page)


class PlayerEntryTests(unittest.TestCase):
    def test_player_page_is_wired_to_manifest(self):
        page = player_page()
        self.assertIn("shows.json", page)
        self.assertIn('id="showSel"', page)

    def test_index_pages_link_to_player(self):
        self.assertIn("player.html", (SITE / "podcasts.html").read_text(encoding="utf-8"))
        self.assertIn("player.html", (SITE / "index.html").read_text(encoding="utf-8"))


class PlayerShellTests(unittest.TestCase):
    def test_shell_and_routes_exist(self):
        page = player_page()
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
        page = player_page()
        for needle in ['id="miniPrev"', 'id="miniNext"', 'aria-label="上一集"', 'aria-label="下一集"',
                       'function stepTarget', 'function stepEpisode', 'id="miniCaption"',
                       'function syncMiniCaption', 'syncMiniCaption();',
                       "$('miniPrev').disabled = index <= 0", "$('miniNext').disabled = index < 0"]:
            self.assertIn(needle, page)
        self.assertIn("!document.body.classList.contains('player-open') && !!state.current && !!cue && !!cue.text", page)

    def test_mini_caption_row_merges_into_panel_and_toggles(self):
        page = player_page()
        for needle in ['<div class="mini-main">', 'id="miniExpand"', 'aria-expanded=',
                       'function toggleMiniCaption', "MINI_CAPTION_KEY = 'myt-mini-caption'",
                       "classList.toggle('caption-collapsed'",
                       "$('miniExpand').onclick = () => toggleMiniCaption();",
                       "localStorage.setItem(MINI_CAPTION_KEY"]:
            self.assertIn(needle, page)
        self.assertNotIn("miniExpand').onclick = () => navigate('player'", page)

    def test_mini_play_button_uses_centered_svg_icons(self):
        page = player_page()
        self.assertIn("$('miniPlay').innerHTML = playing", page)
        self.assertIn('M9.5 7.4v9.2L17.2 12z', page)
        self.assertIn('M9 7.5h2.2v9H9zM12.8 7.5H15v9h-2.2z', page)
        self.assertNotIn("$('miniPlay').textContent = audio.paused", page)

    def test_step_target_walks_the_episode_list(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node 不在 PATH，跳过播放器逻辑测试")
        page = player_page()
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
        page = player_page()
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
        page = player_page()
        source = self.HARNESS % page[page.index("function hash32"):page.index("function hostOf")]
        with tempfile.TemporaryDirectory() as temp_dir:
            script = Path(temp_dir) / "feed_url.js"
            script.write_text(source, encoding="utf-8")
            proc = subprocess.run([node, str(script)], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(proc.returncode, 0, proc.stderr)



class PlayerReaderLayoutTests(unittest.TestCase):
    def test_flat_layout_honours_width_and_gap_sliders(self):
        page = player_page()
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
        page = player_page()
        source = self.HARNESS % page[page.index("function appleSearchUrl"):page.index("function subscribedShowForFeed")]
        with tempfile.TemporaryDirectory() as temp_dir:
            script = Path(temp_dir) / "online_search.js"
            script.write_text(source, encoding="utf-8")
            proc = subprocess.run([node, str(script)], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_online_search_entry_exists(self):
        page = player_page()
        for needle in ['id="onlineSearchInput"', 'function runOnlineSearch',
                       'PODCAST_INDEX', 'function searchPodcastIndex',
                       'data-online-subscribe']:
            self.assertIn(needle, page)

    def test_online_results_open_a_detail_preview(self):
        page = player_page()
        for needle in ['data-online-detail="', 'function openOnlineDetail', 'function openOnlinePreview',
                       'function onlineDetailHTML', 'class="online-detail-desc"',
                       '[role="link"][data-online-detail]']:
            self.assertIn(needle, page)
        self.assertIn('if (el.dataset.onlineDetail) { openOnlineDetail(el.dataset.onlineDetail); return; }', page)


class PlayerPodcastDetailTests(unittest.TestCase):
    def test_detail_shows_full_intro_without_feed_url_line(self):
        page = player_page()
        self.assertNotIn("class=\"feed-line\"", page)
        self.assertNotIn("max-width:680px;display:-webkit-box;-webkit-line-clamp:4", page)
        self.assertIn("const feedUrl = show.feed ? absoluteFeed(show.feed) : '';", page)


class PlayerMiniOpenTests(unittest.TestCase):
    def test_mini_cover_opens_the_transcript(self):
        page = player_page()
        self.assertIn("$('miniCover').onclick = () => navigate('player'", page)
        self.assertIn('id="miniCover" title="打开播放器"', page)


class PlayerCueFollowTests(unittest.TestCase):
    def test_entering_the_player_forces_the_active_cue_into_view(self):
        page = player_page()
        self.assertIn("setState('pendingFollow', true);", page)
        self.assertIn("if (state.cues.length) {\n    returnToCue();", page)
        self.assertIn("const follow = force || state.pendingFollow;", page)
        self.assertIn("} else if (ci >= 0 && state.pendingFollow) {", page)
        self.assertIn("setState('pendingFollow', false); setState('userScrollUntil', Date.now() + 3000);", page)
        self.assertIn("setState('seekRaw', t);\n      setState('pendingFollow', true);", page)



class PlayerTranscriptToolbarTests(unittest.TestCase):
    def test_b_layout_moves_secondary_controls_into_more_sheet(self):
        page = player_page()
        self.assertIn('id="dockLangBtn"', page)
        self.assertIn("function syncDockLang", page)
        self.assertIn('id="studyBtn" class="dstile"', page)
        self.assertIn('id="floatBtn" class="dstile"', page)
        self.assertIn('id="dockSleepBtn" class="dstile"', page)
        self.assertIn('id="immersiveBtn" class="dstile"', page)
        self.assertIn('id="drawerBtn" class="dstile"', page)
        self.assertIn("body.player-open .reader-top-actions", page)
        self.assertIn(">剧集</button>", page)
        self.assertIn(">笔记</button>", page)

    def test_collapsed_nav_uses_one_grid_column(self):
        page = player_page()
        self.assertIn("body.nav-collapsed .app{grid-template-columns:minmax(0,1fr)}", page)
        self.assertNotIn("body.nav-collapsed .app{grid-template-columns:0 minmax(0,1fr)}", page)

    def test_wallpaper_mode_has_fullscreen_and_minimal_controls(self):
        page = player_page()
        self.assertIn('id="wallpaper"', page)
        self.assertIn('id="wallpaperBtn"', page)
        self.assertIn('id="wpLines"', page)
        self.assertIn('id="wpPlay"', page)
        self.assertIn('id="wpExit"', page)
        self.assertIn("async function setWallpaper", page)
        self.assertIn("win.setFullscreen(true)", page)
        self.assertIn("requestFullscreen", page)
        self.assertIn("body.wallpaper-mode .dock", page)
        self.assertIn("windowSize = 7", page)
        self.assertIn("wp-word", page)
        self.assertIn("wallpaperWordPaint", page)
        self.assertIn("if (state.wallpaper) wallpaperWordPaint(t);", page)
        self.assertIn("if (state.wallpaper) wallpaperRefresh();", page)
        self.assertIn("if (state.wallpaper) { setWallpaper(false); return; }", page)


class PlayerStudyTermTooltipTests(unittest.TestCase):
    def test_generated_summary_terms_have_hover_definitions(self):
        page = player_page()
        self.assertIn("function studyAnnotateText", page)
        self.assertIn("studySetVocabulary(data.vocabulary)", page)
        self.assertIn("studyAnnotatedLines(data.summary", page)
        self.assertIn('class="study-term" data-term=', page)
        self.assertIn("bindStudyTermTips();", page)
        self.assertIn(".study-term-tip{", page)

    def test_whole_transcript_marks_wordbook_and_generated_vocabulary(self):
        page = player_page()
        self.assertIn("function studyTranscriptMarkData", page)
        self.assertIn("w.classList.add('vocab-mark')", page)
        self.assertIn(".word.vocab-mark{", page)
        self.assertIn("studySetVocabulary(studyVocab)", page)
        self.assertIn("studyTermChipHTML(v.word)", page)
        self.assertIn("for (let len = 1; len <= 4", page)


class PlayerPrototypeThemeTests(unittest.TestCase):
    def test_prototype_theme_is_registered(self):
        page = player_page()
        self.assertIn('[data-theme="prototype"]{', page)
        self.assertIn("prototype: '原型'", page)
        self.assertIn("LIGHT_THEMES = new Set(['paper', 'mist', 'prototype', 'ledger'])", page)
        self.assertIn('data-theme="prototype"', page)
        self.assertIn('[data-theme="ledger"]{', page)
        self.assertIn("ledger: '编辑部'", page)


class PlayerThemeContrastTests(unittest.TestCase):
    THEMES = ["brass", "midnight", "forest", "oxblood", "celadon", "paper", "mist", "prototype", "ledger"]

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
        page = player_page()
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
        page = player_page()
        source = self.HARNESS % page[page.index("function removalLeavesCurrentShow"):page.index("function unsubscribeKey")]
        with tempfile.TemporaryDirectory() as temp_dir:
            script = Path(temp_dir) / "removal_route.js"
            script.write_text(source, encoding="utf-8")
            proc = subprocess.run([node, str(script)], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(proc.returncode, 0, proc.stderr)


class PlayerBuiltinImportTests(unittest.TestCase):
    def test_builtin_sources_require_explicit_import(self):
        page = player_page()
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
        page = player_page()
        source = self.HARNESS % page[page.index("const FEED_CACHE_TTL"):page.index("async function fetchFeedText")]
        with tempfile.TemporaryDirectory() as temp_dir:
            script = Path(temp_dir) / "feed_cache.js"
            script.write_text(source, encoding="utf-8")
            proc = subprocess.run([node, str(script)], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(proc.returncode, 0, proc.stderr)


class PlayerAccessibilityTests(unittest.TestCase):
    def test_overlays_keyboard_and_labels_are_accessibly_wired(self):
        page = player_page()
        # 字幕视图已搬到 subtitles 插件，无障碍标记分散在宿主和插件两处。
        page += (BUILTIN / "subtitles" / "view.js").read_text(encoding="utf-8")
        for needle in ['<dialog class="modal"', 'showModal()', 'aria-modal="true"',
                       'aria-labelledby="drawerTitle"', 'role="region" aria-label="文字稿"',
                       "wrap.lang = 'en'", "z.lang = 'zh-CN'", 'function updateDocumentTitle',
                       "el.setAttribute('role', 'link')",
                       'aria-valuetext', 'aria-label="搜索我的播客和单集"',
                       'input:focus-visible',
                       # 底栏收敛：速度/高亮/睡眠/剧集都已一级化，面板不再重复这些控件
                       'id="dockSheet"', 'aria-label="播放工具"',
                       'aria-controls="dockSheet"', 'id="dockRateBtn"', 'aria-label="播放速度"']:
            self.assertIn(needle, page)
        # 旧的底栏速度下拉菜单已经搬进面板，不能再回到「bar 内 popover」
        self.assertNotIn('id="speedMenu"', page)


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


class AsrModelManagerTests(unittest.TestCase):
    def test_settings_pane_and_bridge_are_wired(self):
        html = player_page()
        self.assertIn('id="asrModelList"', html)
        self.assertIn('id="asrImportBtn"', html)
        self.assertIn('id="asrModelStatus"', html)
        self.assertIn("asr_prepare', { model:", html)
        self.assertIn("asr_models", html)
        self.assertIn("asr_remove", html)
        self.assertIn("asr_import", html)
        self.assertIn("asr_cancel", html)
        self.assertIn("asr_open_dir", html)
        self.assertIn("plugin:dialog|open", html)
        self.assertIn("prefs.asrModel", html)

    def test_model_rows_offer_resume_and_cancel(self):
        html = player_page()
        self.assertIn("继续下载", html)
        self.assertIn("data-asr-cancel", html)
        self.assertIn("data-asr-open", html)
        self.assertIn("chaptersCache", html)
        self.assertIn("pendingSeekEp", html)

    def test_live_status_bar_auto_hides_when_steady(self):
        html = player_page()
        self.assertIn("liveBarHideTimer", html)
        self.assertIn("if (LIVE.on) bar.hidden = true;", html)


class PlayerMiniTranscriptTests(unittest.TestCase):
    def test_floating_window_carries_the_current_caption(self):
        html = player_page()
        self.assertIn("capZh", html)
        self.assertIn("capLive", html)
        self.assertIn("id=\"floatBtn\"", html)
        self.assertIn("open_mini", html)

        mini = (SITE / "mini.html").read_text(encoding="utf-8")
        self.assertIn('id="capEn"', mini)
        self.assertIn('id="capZh"', mini)
        self.assertIn('id="capToggle"', mini)
        self.assertIn("mini_fit", mini)
        self.assertIn("myt-mini-cap", mini)

        rust = rust_sources()
        self.assertIn("async fn mini_fit", rust)
        self.assertIn("mini_fit,", rust)


class PlayerAutoTranslateTests(unittest.TestCase):
    def test_translation_is_configurable_and_wired(self):
        html = player_page()
        self.assertIn('id="trOn"', html)
        self.assertIn('id="trEngine"', html)
        self.assertIn('id="trTarget"', html)
        self.assertIn('id="trTest"', html)
        self.assertIn("tr_translate", html)
        self.assertIn("myt-translate", html)
        self.assertIn("trPrimeCues", html)
        self.assertIn("liveTranslateRow", html)
        for engine in ("mymemory", "openai", "deepl", "microsoft", "libre", "google"):
            self.assertIn(f'value="{engine}"', html)

        rust = (ROOT / "apps" / "windows" / "src-tauri" / "src" / "translate.rs").read_text(encoding="utf-8")
        self.assertIn("async fn mymemory", rust)
        self.assertIn("async fn openai", rust)
        self.assertIn("async fn deepl", rust)
        self.assertIn("async fn libre", rust)
        self.assertIn("async fn microsoft", rust)
        self.assertIn("async fn google", rust)
        self.assertIn("tr_translate", rust_sources())


class PlayerPodcastManagerTests(unittest.TestCase):
    def test_per_show_settings_skip_rules_and_queue_order_are_wired(self):
        html = player_page()
        for needle in ("这档节目的设置", "data-show-speed", "data-show-intro", "data-show-outro",
                       "setQueueOrder", "setVolumeCap", "applySkipRules", "nextTarget"):
            self.assertIn(needle, html)

    def test_cue_skip_plan_logic_runs_in_node(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node 不在 PATH，跳过播放器逻辑测试")
        page = player_page()
        block = page[page.index("function skipUrlOf"):page.index("function transcriptFailure")]
        source = """
const assert = require('assert');
const prefs = {skipAds: true, skipLevel: 2};
const state = {cues: [], audioSeconds: 0, skipPlan: null, skipDone: new Set(), skipMuted: new Set()};
__BLOCK__
// 1) i 命中且 start 对得上 → 直接按索引落标签
state.cues = [{start: 0}, {start: 10}, {start: 20}];
state.audioSeconds = 100;
let plan = buildSkipPlan({
  audio_seconds: 100,
  segments: [{i: 2, start: 20, tag: 'promo', conf: 0.9}],
  ranges: [],
});
assert.strictEqual(plan.tags.get(2).tag, 'promo');
// 2) 索引对不上时按 start 找最近句，不整集错位
plan = buildSkipPlan({audio_seconds: 100, segments: [{i: 1, start: 60, tag: 'ad', conf: 0.9}], ranges: []});
assert.strictEqual(plan.tags.get(2).tag, 'ad');
assert.strictEqual(plan.tags.size, 1);
// 3) 单集 40% 上限：从置信度最低的区间开始砍
plan = buildSkipPlan({
  audio_seconds: 100,
  segments: [],
  ranges: [
    {start: 0, end: 30, tag: 'ad', conf: 0.9},
    {start: 40, end: 60, tag: 'promo', conf: 0.5},
    {start: 70, end: 95, tag: 'filler', conf: 0.6},
  ],
});
assert.strictEqual(plan.limited, true);
assert.ok(plan.ranges.reduce((n, r) => n + (r.end - r.start), 0) <= 40);
assert.ok(plan.ranges.every(r => Math.round(r.start) !== 40));
// 4) 区间内 0.4 秒才跳；1 秒以上就是用户自己拖进来的，本次不再跳
state.skipPlan = buildSkipPlan({audio_seconds: 100, ranges: [{start: 10, end: 40, tag: 'promo', conf: 0.9}]});
state.skipDone = new Set(); state.skipMuted = new Set();
assert.ok(findSkipRange(10.2));
state.skipMuted = new Set(); state.skipDone = new Set();
assert.strictEqual(findSkipRange(12), null);
assert.ok(state.skipMuted.size > 0);
state.skipMuted = new Set(); state.skipDone = new Set();
const hit = findSkipRange(10.1);
state.skipDone.add(hit.id);
assert.strictEqual(findSkipRange(10.2), null);
// 5) 级别门槛：filler 只有 3 级且 conf >= 0.8 才跳
prefs.skipLevel = 2;
assert.strictEqual(skipWanted('filler', 0.95), false);
prefs.skipLevel = 3;
assert.strictEqual(skipWanted('filler', 0.75), false);
assert.strictEqual(skipWanted('filler', 0.85), true);
"""
        source = source.replace("__BLOCK__", block)
        proc = run_node(self, "cue_skip_plan.js", source)
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_cue_skip_plan_is_gated_to_offline_audio_and_local_transcript(self):
        html = player_page()
        for needle in ("buildSkipPlan", "loadSkipPlan", "skipUrlOf", "skipEligible", "skipWanted",
                       "findSkipRange", "state.skipMuted", "state.skipDone", "setSkipLevel",
                       "offlineSkipLoad", "offlineSkipSave",
                       "只对「离线音频 + 本机文字稿」的单集生效"):
            self.assertIn(needle, html)
        # 上限保护：单段 120 秒、单集 40%、手动 seek 进区间不跳。
        self.assertIn("Math.min(hit.end, now + 120)", html)
        self.assertIn("dur * 0.4", html)
        self.assertIn("now - r.start > 0.5", html)
        rust = rust_sources()
        for needle in ("fn offline_save_skip", "fn offline_skip_load", "offline_save_skip,",
                       "offline_skip_load,", "hasSkip"):
            self.assertIn(needle, rust)

    def test_p2_stats_echo_ad_skip_and_local_folder_are_wired(self):
        html = player_page()
        for page in ("page-stats", "page-local", "page-video"):
            self.assertIn(f'id="{page}"', html)
        # 年度回顾已并入统计页，不再单独占一个导航页。
        for part in ("echoYear", "echoCards", "echoBody"):
            self.assertIn(f'id="{part}"', html)
        for needle in ("setSkipAds", "detectAdRanges", "renderStats", "renderEcho", "renderLocal",
                       "local_scan", "importLocalFolder", "myt-local", "dataImportFile"):
            self.assertIn(needle, html)
        rust = rust_sources()
        self.assertIn("fn local_scan", rust)
        self.assertIn("local_scan,", rust)
        conf = (ROOT / "apps" / "windows" / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8")
        self.assertIn('"**"', conf)


class PlayerStudyShortcutTests(unittest.TestCase):
    """AI 面板原本只有鼠标入口，S 键开关是纯键盘场景的唯一通道，别被后续改动弄丢。"""

    def setUp(self):
        self.html = player_page()

    def test_s_key_toggles_study_sheet(self):
        self.assertRegex(self.html, r"e\.key === 's' \|\| e\.key === 'S'")
        self.assertIn("function toggleStudySheet()", self.html)
        self.assertIn("closeStudySheet(); return;", self.html)
        self.assertIn("openStudySheet();", self.html)

    def test_s_key_is_claimed_from_dock_buttons(self):
        self.assertIn("'s', 'S']", self.html)
        self.assertIn("'s', 'S'", self.html)

    def test_toggle_respects_module_switch(self):
        body = self.html.split("function toggleStudySheet()", 1)[1].split("\n}", 1)[0]
        self.assertIn("moduleOn('study')", body)
        self.assertIn("AI 学英语模块已关闭", body)

    def test_dock_hint_mentions_shortcut(self):
        hint = re.search(r'id="dockHint">([^<]+)<', self.html).group(1)
        self.assertIn("S AI 学英语", hint)

    def test_study_sheet_waits_for_late_cues(self):
        """S 键可能抢在字幕 fetch 之前打开面板，空态必须能自愈而不是停在「没有文字稿」。"""
        self.assertIn("function studyWithCues(fn)", self.html)
        self.assertIn("字幕加载中…", self.html)
        self.assertNotIn("if (!cur) { body.innerHTML = studyEmpty('这一集没有可用的文字稿。'); return; }", self.html)
        self.assertEqual(self.html.count("studyWithCues(() =>"), 2)

    def test_study_tabs_are_keyboard_operable(self):
        """打开面板后焦点要落在当前页签，页签之间用 →/← 切换。"""
        self.assertIn('onTab.focus({ preventScroll: true })', self.html)
        self.assertIn("['ArrowLeft', 'ArrowRight', 'Home', 'End']", self.html)
        self.assertIn("setStudyView(btns[n].dataset.studyView)", self.html)

    def test_extension_module_shares_main_iife_scope(self):
        """扩展模块必须写在主 IIFE 内：另起 <script> 拿不到 state / studyRender* 等私有绑定，
        包装会静默失效（缓存徽标、前情回顾、练习扩展按钮曾经整块消失）。"""
        self.assertEqual(self.html.count("<script"), 1)
        self.assertNotIn("</script>\n<script", self.html)
        self.assertIn("window.__xai", self.html)


if __name__ == "__main__":
    unittest.main()
