import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).parents[1]

# align_timings 复用 transcribe 的下载/sidecar；这些重依赖在测试里只需名字。
_fw = types.ModuleType("faster_whisper")
_fw.WhisperModel = object
sys.modules.setdefault("faster_whisper", _fw)
for _name in ("google", "google.genai", "google.genai.types"):
    sys.modules.setdefault(_name, types.ModuleType(_name))
sys.modules["google"].genai = sys.modules["google.genai"]
sys.modules["google.genai"].types = sys.modules["google.genai.types"]
for _attr in ("Client", "GenerateContentConfig"):
    if not hasattr(sys.modules["google.genai"], _attr):
        setattr(sys.modules["google.genai"], _attr, object)
sys.modules.setdefault("feedparser", types.ModuleType("feedparser"))
sys.path.insert(0, str(ROOT / "scripts"))
SPEC = importlib.util.spec_from_file_location("align_timings", ROOT / "scripts" / "align_timings.py")
aligner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(aligner)


VTT_SAMPLE = chr(10).join([
    "WEBVTT", "", "1", "00:00:01.000 --> 00:00:05.000", "Hello there.", "你好。", "",
])


class VttParseTests(unittest.TestCase):
    def test_reads_only_the_english_line_of_a_bilingual_vtt(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "ep.vtt"
            path.write_text(
                "WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nHello there.\n你好。\n\n"
                "2\n00:01:00.500 --> 00:01:02.000\nSecond cue.\n第二句。\n",
                encoding="utf-8",
            )
            cues = aligner.parse_vtt_cues(path)
        self.assertEqual(len(cues), 2)
        self.assertEqual(cues[0]["en"], "Hello there.")
        self.assertAlmostEqual(cues[0]["start"], 1.0)
        self.assertAlmostEqual(cues[1]["start"], 60.5)

    def test_skips_empty_text_blocks(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "ep.vtt"
            path.write_text(
                "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n\n"
                "2\n00:00:03.000 --> 00:00:04.000\nReal text.\n",
                encoding="utf-8",
            )
            cues = aligner.parse_vtt_cues(path)
        self.assertEqual([c["en"] for c in cues], ["Real text."])


class GroupTests(unittest.TestCase):
    def cue(self, start, end, text):
        return {"start": start, "end": end, "en": text}

    def test_splits_when_characters_exceed_the_limit(self):
        cues = [self.cue(i, i + 1, "x" * 400) for i in range(3)]
        groups = aligner.group_cues(cues)
        self.assertEqual([len(g) for g in groups], [2, 1], "900 字符上限")

    def test_splits_when_span_exceeds_the_limit(self):
        cues = [self.cue(i * 40, i * 40 + 30, "short line") for i in range(4)]
        groups = aligner.group_cues(cues)
        self.assertGreater(len(groups), 1, "100 秒上限")
        for group in groups:
            self.assertLessEqual(group[-1]["start"] - group[0]["start"], aligner.GROUP_MAX_SPAN)


class WindowTests(unittest.TestCase):
    def test_span_floor_is_text_length_not_declared_end(self):
        cue = {"start": 100.0, "end": 101.0, "en": "word " * 60}
        self.assertAlmostEqual(aligner.cue_span(cue), 20.0)

    def test_span_is_capped_for_very_long_text(self):
        # 声明 3000 秒远超上限，必须被 4000/4+5 = 1005 截断
        cue = {"start": 0.0, "end": 3000.0, "en": "x" * 4000}
        self.assertAlmostEqual(aligner.cue_span(cue), 1005.0)

    def test_window_pads_the_start_and_tails_with_bound(self):
        group = [{"start": 100.0, "end": 101.0, "en": "hello there"}]
        lo, hi = aligner.window_for(group, total_seconds=500.0)
        self.assertAlmostEqual(lo, 97.0)
        self.assertGreater(hi, 101.0)
        self.assertLessEqual(hi, 500.0)

    def test_window_never_exceeds_audio(self):
        group = [{"start": 2.0, "end": 3.0, "en": "hi"}]
        lo, hi = aligner.window_for(group, total_seconds=10.0)
        self.assertEqual(lo, 0.0)
        self.assertLessEqual(hi, 10.0)


class FakeWord:
    def __init__(self, word, start, end):
        self.word, self.start, self.end = word, start, end


class FakeSegment:
    def __init__(self, seg_id, words):
        self.id, self.words = seg_id, words


class FakeAligned:
    def __init__(self, segments):
        self.segments = segments


class PlausibilityTests(unittest.TestCase):
    def cue(self, start, end, text):
        return {"start": start, "end": end, "en": text}

    def test_accepts_words_that_match_text_and_stay_in_range(self):
        cue = self.cue(10.0, 14.0, "hello there friend")
        words = [
            {"w": "hello", "s": 10.2, "e": 10.6},
            {"w": "there", "s": 10.6, "e": 11.0},
            {"w": "friend", "s": 11.0, "e": 11.6},
        ]
        self.assertTrue(aligner.words_plausible(cue, next_start=20.0, words=words))

    def test_rejects_when_token_count_differs(self):
        cue = self.cue(10.0, 14.0, "hello there friend")
        words = [{"w": "hello", "s": 10.2, "e": 10.6}]
        self.assertFalse(aligner.words_plausible(cue, None, words))

    def test_rejects_when_first_word_is_far_before_the_cue(self):
        cue = self.cue(100.0, 104.0, "hello there friend")
        words = [
            {"w": "hello", "s": 80.0, "e": 80.4},
            {"w": "there", "s": 80.4, "e": 81.0},
            {"w": "friend", "s": 81.0, "e": 81.4},
        ]
        self.assertFalse(aligner.words_plausible(cue, None, words))

    def test_rejects_when_last_word_overruns_the_next_cue(self):
        cue = self.cue(10.0, 14.0, "hello there friend")
        words = [
            {"w": "hello", "s": 10.2, "e": 10.6},
            {"w": "there", "s": 10.6, "e": 11.0},
            {"w": "friend", "s": 40.0, "e": 41.0},
        ]
        self.assertFalse(aligner.words_plausible(cue, next_start=20.0, words=words))


class CueWordsTests(unittest.TestCase):
    def test_maps_segments_by_position_and_applies_offset(self):
        group = [
            {"start": 97.0, "end": 100.0, "en": "hello there"},
            {"start": 100.0, "end": 104.0, "en": "second cue here"},
        ]
        aligned = FakeAligned([
            FakeSegment(0, [FakeWord(" hello", 1.0, 1.4), FakeWord(" there", 1.4, 1.9)]),
            FakeSegment(1, [FakeWord(" second", 4.0, 4.5)]),
        ])
        got = aligner.cue_words(aligned.segments, group, offset=97.0)
        self.assertEqual([w["w"] for w in got[0]], ["hello", "there"])
        self.assertAlmostEqual(got[0][0]["s"], 98.0)
        self.assertAlmostEqual(got[1][0]["s"], 101.0)

    def test_skips_segments_without_words(self):
        group = [{"start": 0.0, "end": 2.0, "en": "hello"}]
        aligned = FakeAligned([FakeSegment(0, [])])
        self.assertEqual(aligner.cue_words(aligned.segments, group, offset=0.0), {})


class FakeAudio:
    """只支持切片，避免测试里真分配几十 MB 的 numpy 数组。"""

    def __init__(self, seconds):
        self.seconds = seconds

    def __getitem__(self, span):
        return ("clip", span)

    def __len__(self):
        return int(self.seconds * 16000)


class AlignCuesTests(unittest.TestCase):
    def cue(self, start, end, text):
        return {"start": start, "end": end, "en": text}

    class Model:
        def __init__(self, words):
            self.words = words

        def align(self, clip, text, language="en", original_split=True):
            return FakeAligned([FakeSegment(0, [FakeWord(w, s, e) for w, s, e in self.words])])

    def test_aligned_words_get_absolute_times(self):
        cues = [self.cue(100.0, 104.0, "hello there")]
        model = self.Model([(" hello", 4.0, 4.4), (" there", 4.4, 4.9)])
        out, stats = aligner.align_cues(model, FakeAudio(200.0), cues, 200.0)
        self.assertAlmostEqual(out[0]["words"][0]["s"], 101.0, places=1)
        self.assertEqual(stats["aligned_cues"], 1)
        self.assertLess(abs(stats["median_offset"]), aligner.MISMATCH_MEDIAN)

    def test_guard_trips_when_the_audio_version_differs(self):
        cues = [self.cue(100.0, 104.0, "hello there")]
        model = self.Model([(" hello", 60.0, 60.4), (" there", 60.4, 60.9)])
        with self.assertRaises(aligner.AudioMismatch):
            aligner.align_cues(model, FakeAudio(200.0), cues, 200.0)

    def test_failed_group_keeps_cues_without_words(self):
        cues = [self.cue(10.0, 14.0, "hello there")]

        class Broken:
            def align(self, *args, **kwargs):
                raise RuntimeError("boom")

        out, stats = aligner.align_cues(Broken(), FakeAudio(60.0), cues, 60.0)
        self.assertEqual(out[0]["words"], [])
        self.assertEqual(stats["failed_groups"], 1)


class AlignFileTests(unittest.TestCase):
    def setUp(self):
        import transcribe as _t

        self.transcribe = _t
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.site = self.root / "site"
        self.vtt_dir = self.site / "pod" / "transcripts"
        self.vtt_dir.mkdir(parents=True)
        self.timing_dir = self.site / "pod" / "timings"
        self.vtt = self.vtt_dir / "Ep.vtt"
        self.vtt.write_text(
            VTT_SAMPLE,
            encoding="utf-8",
        )
        self.patches = [
            mock.patch.object(self.transcribe, "TIMING_DIR", self.timing_dir),
            mock.patch.object(self.transcribe, "PODCAST_DIR", self.site / "pod"),
            mock.patch.object(self.transcribe, "SITE_DIR", self.site),
        ]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def fake_model(self, words):
        class Model:
            def align(self, clip, text, language="en", original_split=True):
                return FakeAligned([FakeSegment(0, [FakeWord(w, s, e) for w, s, e in words])])

        return Model()

    def test_writes_successful_sidecar(self):
        status = aligner.align_episode_file(
            self.vtt, "https://cdn.test/a.mp3",
            self.fake_model([(" Hello", 1.0, 1.4), (" there.", 1.4, 2.0)]),
            workdir=self.root,
            download=lambda url, path: path.write_bytes(b"x"),
            decode=lambda path: FakeAudio(60.0),
        )
        self.assertEqual(status, "done")
        self.assertEqual(
            self.transcribe.sidecar_status(self.timing_dir / "Ep.json"), (True, 1)
        )

    def test_mismatch_writes_failure_and_bumps_attempts(self):
        status = aligner.align_episode_file(
            self.vtt, "https://cdn.test/a.mp3",
            self.fake_model([(" Hello", 40.0, 40.4), (" there.", 40.4, 41.0)]),
            workdir=self.root,
            download=lambda url, path: path.write_bytes(b"x"),
            decode=lambda path: FakeAudio(120.0),
        )
        self.assertEqual(status, "mismatch")
        self.assertEqual(
            self.transcribe.sidecar_status(self.timing_dir / "Ep.json"), (False, 1)
        )

    def test_download_error_is_counted_as_failure(self):
        def boom(url, path):
            raise RuntimeError("network down")

        status = aligner.align_episode_file(
            self.vtt, "https://cdn.test/a.mp3", self.fake_model([]),
            workdir=self.root, download=boom, decode=lambda path: FakeAudio(60.0),
        )
        self.assertEqual(status, "failed")
        self.assertEqual(
            self.transcribe.sidecar_status(self.timing_dir / "Ep.json"), (False, 1)
        )


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main()
