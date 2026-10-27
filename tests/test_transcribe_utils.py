import hashlib
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from lxml import etree


# faster-whisper and google-genai are heavy/optional at test time; the module
# only needs their names at import.
faster_whisper = types.ModuleType("faster_whisper")
faster_whisper.WhisperModel = object
sys.modules.setdefault("faster_whisper", faster_whisper)

google = types.ModuleType("google")
genai = types.ModuleType("google.genai")
genai_types = types.ModuleType("google.genai.types")
genai.Client = object
genai.types = genai_types
if not hasattr(genai_types, "GenerateContentConfig"):
    genai_types.GenerateContentConfig = lambda **kwargs: kwargs
google.genai = genai
sys.modules.setdefault("google", google)
sys.modules.setdefault("google.genai", genai)
sys.modules.setdefault("google.genai.types", genai_types)

MODULE_PATH = Path(__file__).parents[1] / "scripts" / "transcribe.py"
SPEC = importlib.util.spec_from_file_location("transcribe", MODULE_PATH)
transcriber = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(transcriber)


class BilingualVttTests(unittest.TestCase):
    def test_accepts_english_then_chinese(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "ok.vtt"
            path.write_text(
                "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n你好\n",
                encoding="utf-8",
            )
            self.assertTrue(transcriber.is_valid_bilingual_vtt(path))

    def test_rejects_english_only_multiline_cue(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "english.vtt"
            path.write_text(
                "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\nThere\n",
                encoding="utf-8",
            )
            self.assertFalse(transcriber.is_valid_bilingual_vtt(path))

    def test_rejects_single_transcript_line(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "short.vtt"
            path.write_text(
                "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n",
                encoding="utf-8",
            )
            self.assertFalse(transcriber.is_valid_bilingual_vtt(path))

    def test_accepts_a_few_untranslated_legacy_cues(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "mostly.vtt"
            blocks = ["WEBVTT", ""]
            for index in range(10):
                blocks.extend(
                    [
                        str(index + 1),
                        "00:00:00.000 --> 00:00:01.000",
                        "Hello",
                        "你好" if index < 9 else "There",
                        "",
                    ]
                )
            path.write_text("\n".join(blocks), encoding="utf-8")
            self.assertTrue(transcriber.is_valid_bilingual_vtt(path))

    def test_rejects_mostly_english_file(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "mostly-english.vtt"
            blocks = ["WEBVTT", ""]
            for index in range(10):
                blocks.extend(
                    [
                        str(index + 1),
                        "00:00:00.000 --> 00:00:01.000",
                        "Hello",
                        "你好" if index == 0 else "There",
                        "",
                    ]
                )
            path.write_text("\n".join(blocks), encoding="utf-8")
            self.assertFalse(transcriber.is_valid_bilingual_vtt(path))


class UrlAndSortingTests(unittest.TestCase):
    def test_make_public_url_encodes_percent_space_and_brackets(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            site_dir = Path(temp_dir) / "site"
            path = site_dir / "99%-invisible" / "transcripts" / "How We Met [Pilot].vtt"
            with patch.object(transcriber, "SITE_DIR", site_dir), patch.object(
                transcriber, "BASE_URL", "https://example.test/MyTranscript"
            ):
                url = transcriber.make_public_url(path)
            self.assertEqual(
                url,
                "https://example.test/MyTranscript/99%25-invisible/transcripts/"
                "How%20We%20Met%20%5BPilot%5D.vtt",
            )

    def test_published_dates_sort_chronologically(self):
        older = transcriber.published_sort_key("Mon, 01 Jan 2024 00:00:00 +0000")
        newer = transcriber.published_sort_key("Tue, 02 Jan 2024 00:00:00 +0000")
        self.assertLess(older, newer)
        self.assertEqual(transcriber.published_sort_key("not a date"), 0.0)


class TranscriptTagTests(unittest.TestCase):
    def test_add_transcript_tag_removes_stale_project_link(self):
        item = etree.fromstring(
            """
            <item xmlns:podcast="https://podcastindex.org/namespace/1.0">
              <podcast:transcript url="https://example.test/transcripts/old.vtt"/>
              <podcast:transcript url="https://external.test/transcript.vtt"/>
            </item>
            """
        )
        transcriber.add_transcript_tag(
            item, "https://example.test/transcripts/new.vtt"
        )

        urls = [node.get("url") for node in item.findall(
            "{https://podcastindex.org/namespace/1.0}transcript"
        )]
        self.assertIn("https://example.test/transcripts/new.vtt", urls)
        self.assertIn("https://external.test/transcript.vtt", urls)
        self.assertNotIn("https://example.test/transcripts/old.vtt", urls)

    def test_remove_project_transcript_tags_keeps_external(self):
        channel = etree.fromstring(
            """
            <channel xmlns:podcast="https://podcastindex.org/namespace/1.0">
              <item>
                <podcast:transcript url="https://example.test/transcripts/old.vtt"/>
                <podcast:transcript url="https://external.test/transcript.vtt"/>
              </item>
            </channel>
            """
        )
        removed = transcriber.remove_project_transcript_tags(channel)

        self.assertEqual(removed, 1)
        urls = channel.xpath("//*[local-name()='transcript']/@url")
        self.assertEqual(urls, ["https://external.test/transcript.vtt"])

    def test_finds_namespaced_guid(self):
        root = etree.fromstring(
            """
            <rss xmlns:x="https://example.test/ns">
              <channel>
                <item><x:guid>guid-1</x:guid><x:title>Episode</x:title></item>
              </channel>
            </rss>
            """
        )
        item = transcriber.find_feed_item(root, "guid-1", "")
        self.assertIsNotNone(item)


class EpisodeFilenameTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.site_dir = Path(self.temp_dir.name) / "site"
        self.transcript_dir = self.site_dir / "pod" / "transcripts"
        self.transcript_dir.mkdir(parents=True)
        self.patches = [
            patch.object(transcriber, "SITE_DIR", self.site_dir),
            patch.object(transcriber, "TRANSCRIPT_DIR", self.transcript_dir),
        ]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp_dir.cleanup()

    def write_bilingual(self, path):
        transcriber.write_bilingual_vtt(
            [{"start": 0.0, "end": 1.0, "en": "Hello", "zh": "你好"}], path
        )

    def test_reuses_existing_bilingual_file_for_same_owner(self):
        path = self.transcript_dir / "Same.vtt"
        self.write_bilingual(path)
        entry = SimpleNamespace(title="Same", published="")
        owner = {"pod/transcripts/Same.vtt": "guid-1"}

        with patch.object(
            transcriber, "download_audio", side_effect=AssertionError("no download")
        ):
            record, _ = transcriber.process_episode(
                entry, "guid-1", "https://example.test/a.mp3", owner
            )

        self.assertEqual(record["path"], "pod/transcripts/Same.vtt")

    def test_same_title_for_other_identity_gets_stable_suffix(self):
        self.write_bilingual(self.transcript_dir / "Same.vtt")
        entry = SimpleNamespace(title="Same", published="")
        owner = {"pod/transcripts/Same.vtt": "guid-1"}
        cues = [{"start": 0.0, "end": 1.0, "en": "Hello", "zh": "你好"}]

        with patch.object(transcriber, "download_audio", return_value={}), patch.object(
            transcriber, "whisper_transcribe", return_value=cues
        ), patch.object(transcriber, "translate_cues_with_gemini", return_value=cues):
            record, _ = transcriber.process_episode(
                entry, "guid-2", "https://example.test/a.mp3", owner
            )

        suffix = hashlib.sha1(b"guid-2").hexdigest()[:8]
        self.assertEqual(record["path"], f"pod/transcripts/Same_{suffix}.vtt")
        self.assertTrue((self.transcript_dir / f"Same_{suffix}.vtt").exists())


class RootIndexTests(unittest.TestCase):
    def test_root_index_percent_encodes_slug(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            site_dir = Path(temp_dir) / "site"
            (site_dir / "99%-invisible").mkdir(parents=True)
            (site_dir / "99%-invisible" / "index.html").write_text(
                "ok", encoding="utf-8"
            )
            with patch.object(transcriber, "SITE_DIR", site_dir):
                transcriber.rebuild_root_index()

            page = (site_dir / "index.html").read_text(encoding="utf-8")
            self.assertIn('href="99%25-invisible/index.html"', page)


def _decode_trailing_object(prompt):
    """取出 prompt 末尾那段待翻译 JSON，用来模拟模型只看到编号和英文。"""
    start = prompt.rfind("{")
    while start >= 0:
        try:
            value, _ = json.JSONDecoder().raw_decode(prompt[start:])
        except json.JSONDecodeError:
            start = prompt.rfind("{", 0, start)
            continue
        if isinstance(value, dict) and value:
            return value
        start = prompt.rfind("{", 0, start)
    raise AssertionError("prompt 末尾没有 JSON 对象：" + prompt[-200:])


class FakeGemini:
    """按编号作答的假客户端；drops 逐个复现「合并重复短句导致漏条目」的真实故障。"""

    def __init__(self, drops=()):
        self.drops = [set(d) for d in drops]
        self.requests = []
        self.models = SimpleNamespace(generate_content=self._generate)

    def _generate(self, model=None, contents=None, config=None):
        source = _decode_trailing_object(contents)
        self.requests.append(sorted(source, key=int))
        drop = self.drops.pop(0) if self.drops else set()
        # 故意倒序返回，配对不能依赖返回顺序。
        result = {
            key: f"译{key}::{source[key]}"
            for key in reversed(sorted(source, key=int))
            if key not in drop
        }
        return SimpleNamespace(text=json.dumps(result, ensure_ascii=False))


class TranslationPairingTests(unittest.TestCase):
    def setUp(self):
        # 真实 hwmym 字幕里 "Yeah." 这类短句会重复十几遍，最容易触发模型合并。
        self.cues = [
            {"start": 0.0, "end": 1.0, "en": "Yeah."},
            {"start": 1.0, "end": 2.0, "en": "So for our second season we united forces."},
            {"start": 2.0, "end": 3.0, "en": "Yeah."},
            {"start": 3.0, "end": 4.0, "en": "Right."},
            {"start": 4.0, "end": 5.0, "en": "Yeah."},
            {"start": 5.0, "end": 6.0, "en": "And Angela over at OLN."},
        ]

    def run_translation(self, drops, cues=None):
        fake = FakeGemini(drops)
        cues = self.cues if cues is None else cues
        with patch.object(transcriber, "create_gemini_client", return_value=fake), patch.object(
            transcriber, "wait_for_gemini_rate_limit", lambda: None
        ), patch.object(transcriber, "TRANSLATE_BASE_DELAY", 0.0), patch.object(
            transcriber, "TRANSLATE_BATCH_DELAY", 0.0
        ):
            result = transcriber.translate_cues_with_gemini(cues)
        return fake, result

    def test_translates_every_duplicate_short_phrase(self):
        _, result = self.run_translation([])
        for index, cue in enumerate(self.cues):
            self.assertEqual(cue["zh"], f"译{index}::{cue['en']}")
        self.assertEqual(result, self.cues)

    def test_missing_cues_are_retried_without_resending_the_batch(self):
        fake, _ = self.run_translation([{"2", "4"}])
        self.assertEqual(len(fake.requests), 2, "漏两条不该把整批 6 条重发")
        self.assertEqual(fake.requests[1], ["2", "4"])
        for index, cue in enumerate(self.cues):
            self.assertEqual(cue["zh"], f"译{index}::{cue['en']}")

    def test_persistent_single_cue_failure_names_the_cue(self):
        with self.assertRaises(RuntimeError) as caught:
            self.run_translation([{"0"}] * 8, cues=[self.cues[0]])
        self.assertIn("Yeah.", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
