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
            patch.object(transcriber, "TIMING_DIR", self.site_dir / "pod" / "timings"),
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
            transcriber, "whisper_transcribe", return_value=(cues, 1.0)
        ), patch.object(transcriber, "translate_cues_with_gemini", return_value=cues):
            record, _ = transcriber.process_episode(
                entry, "guid-2", "https://example.test/a.mp3", owner
            )

        suffix = hashlib.sha1(b"guid-2").hexdigest()[:8]
        self.assertEqual(record["path"], f"pod/transcripts/Same_{suffix}.vtt")
        self.assertTrue((self.transcript_dir / f"Same_{suffix}.vtt").exists())
        self.assertTrue(
            (self.site_dir / "pod" / "timings" / f"Same_{suffix}.json").exists(),
            "逐词时间轴应与字幕同名写到 timings/",
        )


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


class GeminiKeyRingTests(unittest.TestCase):
    def test_parse_splits_and_dedupes(self):
        self.assertEqual(
            transcriber.parse_gemini_keys("k1, k2\nk3 ,k1"),
            ["k1", "k2", "k3"],
        )
        self.assertEqual(transcriber.parse_gemini_keys("   "), [])

    def test_ring_starts_at_first_key_and_rotates(self):
        made = []
        ring = transcriber.GeminiKeyRing(
            ["key-aaaa", "key-bbbb"], factory=lambda api_key: made.append(api_key) or object()
        )
        self.assertEqual(ring.current(), "key-aaaa")
        self.assertIn("aaaa", ring.label())
        self.assertNotIn("key-aaaa", ring.label(), "日志标签不能泄露完整 key")
        ring.client()
        ring.client()
        self.assertEqual(made, ["key-aaaa"], "同一个 key 只建一次 client")
        self.assertTrue(ring.mark_exhausted())
        self.assertEqual(ring.current(), "key-bbbb")
        self.assertEqual(made, ["key-aaaa"])

    def test_ring_raises_when_every_key_is_exhausted(self):
        ring = transcriber.GeminiKeyRing(["only-key"], factory=lambda api_key: object())
        self.assertFalse(ring.mark_exhausted())
        self.assertFalse(ring.available)
        with self.assertRaises(transcriber.QuotaExhausted):
            ring.current()
        with self.assertRaises(transcriber.QuotaExhausted):
            ring.client()

    def test_label_hides_short_key_entirely(self):
        ring = transcriber.GeminiKeyRing(["abcd"], factory=lambda api_key: object())
        self.assertEqual(ring.label(), "#1（…****）")

    def test_label_is_safe_after_every_key_is_exhausted(self):
        ring = transcriber.GeminiKeyRing(["only-key"], factory=lambda api_key: object())
        self.assertFalse(ring.mark_exhausted())
        self.assertFalse(ring.available)
        self.assertEqual(ring.label(), "#-（…****）", "耗尽后 label() 不能抛异常")

    def test_ring_rejects_empty_key_list(self):
        with self.assertRaises(transcriber.QuotaExhausted):
            transcriber.GeminiKeyRing([])


class _QuotaError(Exception):
    code = "RESOURCE_EXHAUSTED"


class _AuthError(Exception):
    code = 403


class GeminiRotationTranslateTests(unittest.TestCase):
    def test_switches_key_after_quota_error(self):
        calls = []

        class Client:
            def __init__(self, api_key):
                self.api_key = api_key

            @property
            def models(self):
                return self

            def generate_content(self, model, contents, config):
                calls.append(self.api_key)
                if self.api_key == "k1":
                    raise _QuotaError("429 RESOURCE_EXHAUSTED")
                return SimpleNamespace(text=json.dumps({"0": "译0"}))

        ring = transcriber.GeminiKeyRing(["k1", "k2"], factory=Client)
        translated = {}
        with patch.object(transcriber, "wait_for_gemini_rate_limit"):
            transcriber.translate_blocks(ring, [(0, {"en": "Hello there friend"})], translated)
        self.assertEqual(translated, {0: "译0"})
        self.assertEqual(calls, ["k1", "k2"])

    def test_all_keys_exhausted_raises(self):
        class Client:
            @property
            def models(self):
                return self

            def generate_content(self, **kwargs):
                raise _QuotaError("429 RESOURCE_EXHAUSTED")

        ring = transcriber.GeminiKeyRing(["k1"], factory=lambda api_key: Client())
        with patch.object(transcriber, "wait_for_gemini_rate_limit"):
            with self.assertRaises(transcriber.QuotaExhausted):
                transcriber.translate_blocks(ring, [(0, {"en": "Hello there friend"})], {})

    def test_error_classification(self):
        self.assertTrue(transcriber.is_quota_error(_QuotaError("x")))
        self.assertFalse(transcriber.is_quota_error(TimeoutError("x")))
        self.assertTrue(transcriber.is_auth_error(_AuthError("x")))

    def test_rotation_log_never_prints_the_key(self):
        class Client:
            @property
            def models(self):
                return self

            def generate_content(self, **kwargs):
                raise _QuotaError("429 RESOURCE_EXHAUSTED")

        ring = transcriber.GeminiKeyRing(
            ["AIzaSySECRET-1111", "AIzaSySECRET-2222"],
            factory=lambda api_key: Client(),
        )
        with patch.object(transcriber, "wait_for_gemini_rate_limit"), self.assertLogs(
            transcriber.log, level="WARNING"
        ) as captured:
            with self.assertRaises(transcriber.QuotaExhausted):
                transcriber.translate_blocks(
                    ring, [(0, {"en": "Hello there friend"})], {}
                )
        output = "\n".join(captured.output)
        self.assertIn("…1111", output)
        self.assertNotIn("AIzaSySECRET", output)


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
        real_ring = transcriber.GeminiKeyRing

        def make_ring(keys, factory=None):
            # 只替换底层 client；轮换逻辑仍走真实的 GeminiKeyRing。
            return real_ring(["test-key"], factory=lambda api_key: fake)

        with patch.object(transcriber, "GeminiKeyRing", make_ring), patch.object(
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


class WordTimingTests(unittest.TestCase):
    def segment(self, start, end, text, words=None):
        seg = {"start": start, "end": end, "text": text}
        if words is not None:
            seg["words"] = [{"w": w, "s": s, "e": e} for w, s, e in words]
        return seg

    def test_cue_bounds_come_from_real_word_times(self):
        seg = self.segment(
            0.0,
            4.0,
            "Hello there. Bye now.",
            [
                ("Hello", 0.2, 0.6),
                ("there.", 0.6, 1.0),
                ("Bye", 3.0, 3.4),
                ("now.", 3.4, 3.9),
            ],
        )
        cues = transcriber.resegment_whisper_segments([seg])
        self.assertEqual(len(cues), 2)
        self.assertAlmostEqual(cues[0]["start"], 0.2)
        self.assertAlmostEqual(cues[0]["end"], 1.0)
        self.assertAlmostEqual(cues[1]["start"], 3.0)
        self.assertAlmostEqual(cues[1]["end"], 3.9)
        self.assertEqual([w["w"] for w in cues[0]["words"]], ["Hello", "there."])

    def test_long_segment_keeps_words_in_order(self):
        text = "First part here, second part follows, third part ends."
        tokens = text.split()
        words = [(t.strip(".,"), 1.0 + i * 0.5, 1.4 + i * 0.5) for i, t in enumerate(tokens)]
        seg = self.segment(1.0, 1.0 + len(words) * 0.5, text, words)
        cues = transcriber.resegment_whisper_segments([seg], max_chars=20)
        self.assertGreater(len(cues), 1)
        joined = [w["w"] for cue in cues for w in cue["words"]]
        self.assertEqual(joined, [t.strip(".,") for t in tokens], "词不能丢也不能乱序")
        for cue in cues:
            self.assertLess(cue["start"], cue["end"])
            self.assertAlmostEqual(cue["start"], cue["words"][0]["s"])
            self.assertAlmostEqual(cue["end"], cue["words"][-1]["e"])

    def test_missing_words_fall_back_to_proportional(self):
        cues = transcriber.resegment_whisper_segments(
            [self.segment(0.0, 4.0, "One. Two.")]
        )
        self.assertEqual(len(cues), 2)
        self.assertAlmostEqual(cues[0]["start"], 0.0)
        self.assertAlmostEqual(cues[-1]["end"], 4.0)
        self.assertFalse(any("words" in cue for cue in cues))

    def test_token_count_mismatch_still_assigns_words(self):
        # Whisper 的词切分和文本 token 数可能对不上；按比例分词，保住词级时间。
        seg = self.segment(
            0.0, 2.0, "We don't stop.", [("We", 0.0, 0.3), ("stop.", 1.0, 1.4)]
        )
        cues = transcriber.resegment_whisper_segments([seg])
        self.assertEqual(len(cues), 1)
        self.assertEqual([w["w"] for w in cues[0]["words"]], ["We", "stop."])
        self.assertAlmostEqual(cues[0]["start"], 0.0)
        self.assertAlmostEqual(cues[0]["end"], 1.4)

    def test_hyphenated_compound_merges_into_one_word(self):
        # Whisper 会把 Whim-Yim 切成 'Whim' + '-Yim.'；合并后词数才对得上文本。
        seg = self.segment(
            0.0,
            2.0,
            "Whim-Yim, I say let's commit.",
            [
                ("Whim", 0.0, 0.3),
                ("-Yim,", 0.3, 0.6),
                ("I", 0.6, 0.7),
                ("say", 0.7, 0.9),
                ("let's", 0.9, 1.2),
                ("commit.", 1.2, 1.8),
            ],
        )
        cues = transcriber.resegment_whisper_segments([seg])
        self.assertEqual(len(cues), 1)
        self.assertEqual([w["w"] for w in cues[0]["words"]],
                         ["Whim-Yim,", "I", "say", "let's", "commit."])
        self.assertAlmostEqual(cues[0]["start"], 0.0)
        self.assertAlmostEqual(cues[0]["end"], 1.8)

    def test_domain_continuation_merges(self):
        seg = self.segment(
            0.0,
            2.0,
            "Learn more at HowWeMadeYourMother.com.",
            [
                ("Learn", 0.0, 0.2),
                ("more", 0.2, 0.4),
                ("at", 0.4, 0.5),
                ("HowWeMadeYourMother", 0.5, 1.4),
                (".com.", 1.4, 1.8),
            ],
        )
        cues = transcriber.resegment_whisper_segments([seg])
        self.assertEqual(len(cues), 1)
        self.assertEqual(
            [w["w"] for w in cues[0]["words"]],
            ["Learn", "more", "at", "HowWeMadeYourMother.com."],
        )

    def test_unmatched_counts_share_words_proportionally(self):
        # 词数对不上且没有可合并的续接词时，按 cue 文本长度比例分词，保证不丢词。
        words = [("Hello", 0.0, 0.3), ("big", 0.6, 0.9), ("world", 1.2, 1.6)]
        seg = self.segment(0.0, 2.0, "Hello big world.", words)
        cues = transcriber.resegment_whisper_segments([seg], max_chars=10)
        self.assertEqual(len(cues), 1, "这段没有可切分的标点，应保持一段")
        self.assertEqual([w["w"] for w in cues[0]["words"]], ["Hello", "big", "world"])

    def test_degenerate_word_time_falls_back(self):
        seg = self.segment(1.0, 2.0, "That", [("That", 1.5, 1.5)])
        cues = transcriber.resegment_whisper_segments([seg])
        self.assertEqual(len(cues), 1)
        self.assertAlmostEqual(cues[0]["start"], 1.0)
        self.assertAlmostEqual(cues[0]["end"], 2.0)
        self.assertNotIn("words", cues[0])


class WordTimingsFileTests(unittest.TestCase):
    def cues(self):
        return [
            {
                "start": 0.2,
                "end": 1.0,
                "en": "Hello there.",
                "zh": "你好。",
                "words": [
                    {"w": "Hello", "s": 0.2, "e": 0.6},
                    {"w": "there.", "s": 0.6, "e": 1.0},
                ],
            },
            {"start": 1.0, "end": 2.0, "en": "No words here.", "zh": "没有词。"},
        ]

    def test_writes_tmlt_schema(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "timings" / "episode.json"
            transcriber.write_word_timings(self.cues(), path, audio_seconds=12.5)
            doc = json.loads(path.read_text(encoding="utf-8"))
        self.assertTrue(doc["complete"])
        self.assertEqual(doc["attempts"], 1)
        self.assertEqual(doc["audio_seconds"], 12.5)
        first, second = doc["segments"]
        self.assertEqual(first["text"], "Hello there.")
        self.assertEqual(first["start"], 200)
        self.assertEqual(first["end"], 1000)
        self.assertEqual(first["words"], [["Hello", 200, 400], ["there.", 600, 400]])
        self.assertNotIn("zh", first, "sidecar 只带英文词，不带译文")
        self.assertIsNone(second["end"], "没有词的 cue end 置空，消费方回退到 VTT")
        self.assertEqual(second["words"], [])

    def test_clamps_zero_length_word_duration(self):
        cues = [
            {
                "start": 1.0,
                "end": 1.5,
                "en": "That",
                "zh": "那",
                "words": [{"w": "That", "s": 1.2, "e": 1.2}],
            }
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "x.json"
            transcriber.write_word_timings(cues, path, audio_seconds=3.0)
            doc = json.loads(path.read_text(encoding="utf-8"))
        seg = doc["segments"][0]
        self.assertEqual(seg["words"], [["That", 1200, 0]])
        self.assertEqual(seg["end"], 1500, "词时间退化时用 cue 自身的结束时间")

    def test_writes_nothing_for_empty_cues(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "x.json"
            with self.assertRaises(ValueError):
                transcriber.write_word_timings([], path, audio_seconds=0.0)
            self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
