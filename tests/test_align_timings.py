import importlib.util
import os
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


class FakeWord:
    def __init__(self, word, start, end):
        self.word, self.start, self.end = word, start, end


class FakeSegment:
    def __init__(self, seg_id, words):
        self.id, self.words = seg_id, words


class FakeAligned:
    def __init__(self, segments):
        self.segments = segments


class FakeAudio:
    """只支持切片，避免测试里真分配几十 MB 的 numpy 数组。"""

    def __init__(self, seconds):
        self.seconds = seconds

    def __getitem__(self, span):
        return ("clip", span)

    def __len__(self):
        return int(self.seconds * 16000)


class CandidateTests(unittest.TestCase):
    def test_latest_mode_takes_n_newest_per_show(self):
        entries = [
            # feed 是新到旧，所以 g4 是最新的
            {"guid": f"g{i}", "title": f"Ep {i}", "published": "", "url": f"https://cdn/{i}.mp3"}
            for i in reversed(range(5))
        ]
        processed = {f"g{i}": {"vtt_filename": f"Ep_{i}.vtt"} for i in range(5)}
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        site = Path(temp.name) / "site"
        (site / "pod" / "transcripts").mkdir(parents=True)
        for i in range(5):
            (site / "pod" / "transcripts" / f"Ep_{i}.vtt").write_text("WEBVTT", encoding="utf-8")
        with mock.patch.object(
            aligner.transcribe, "is_valid_bilingual_vtt", return_value=True
        ), mock.patch.object(
            aligner.transcribe, "sidecar_status", return_value=(False, 0)
        ), mock.patch.object(aligner.transcribe, "SITE_DIR", site), mock.patch.object(
            aligner.transcribe, "TIMING_DIR", site / "pod" / "timings"
        ):
            got = aligner.build_candidates(
                [{"slug": "pod", "entries": entries, "processed": processed}],
                mode="latest",
                latest_per_show=2,
            )
        self.assertEqual([c["identity"] for c in got], ["g4", "g3"])

    def test_recent_mode_skips_old_and_finished(self):
        from datetime import datetime, timezone

        now = datetime(2026, 10, 29, tzinfo=timezone.utc)
        entries = [
            {"guid": "new", "title": "New", "published": "Wed, 28 Oct 2026 00:00:00 +0000", "url": "https://cdn/n.mp3"},
            {"guid": "old", "title": "Old", "published": "Wed, 01 Jan 2025 00:00:00 +0000", "url": "https://cdn/o.mp3"},
            {"guid": "done", "title": "Done", "published": "Wed, 28 Oct 2026 00:00:00 +0000", "url": "https://cdn/d.mp3"},
        ]
        processed = {g: {"vtt_filename": f"{g}.vtt"} for g in ("new", "old", "done")}
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        site = Path(temp.name) / "site"
        (site / "pod" / "transcripts").mkdir(parents=True)
        for g in ("new", "old", "done"):
            (site / "pod" / "transcripts" / f"{g}.vtt").write_text("WEBVTT", encoding="utf-8")
        with mock.patch.object(
            aligner.transcribe, "is_valid_bilingual_vtt", return_value=True
        ), mock.patch.object(
            aligner.transcribe, "sidecar_status",
            side_effect=lambda p: (p.name == "done.json", 1),
        ), mock.patch.object(aligner.transcribe, "SITE_DIR", site), mock.patch.object(
            aligner.transcribe, "TIMING_DIR", site / "pod" / "timings"
        ):
            got = aligner.build_candidates(
                [{"slug": "pod", "entries": entries, "processed": processed}],
                mode="recent",
                now=now,
            )
        self.assertEqual([c["identity"] for c in got], ["new"])


class RunAlignTests(unittest.TestCase):
    def items(self, n):
        return [
            {"slug": "pod", "identity": f"g{i}", "title": f"E{i}",
             "audio_url": "u", "vtt_path": Path("x")}
            for i in range(n)
        ]

    def test_budget_stops_the_shard(self):
        seen = []
        ticks = iter([0.0, 0.0, 0.0, 99999.0, 99999.0])
        stats = aligner.run_align(
            self.items(6), shard=0, shards=1, max_minutes=1,
            process=lambda item: seen.append(item["identity"]) or "done",
            clock=lambda: next(ticks, 99999.0),
        )
        self.assertLess(len(seen), 6, "预算耗尽后必须停")
        self.assertEqual(stats["done"], len(seen))

    def test_mismatch_is_counted_separately(self):
        stats = aligner.run_align(
            self.items(2), shard=0, shards=1, max_minutes=10,
            process=lambda item: "mismatch", clock=lambda: 0.0,
        )
        self.assertEqual(stats["mismatch"], 2)
        self.assertEqual(stats["failed"], 0)


class EnvTests(unittest.TestCase):
    def test_defaults(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(
                aligner.align_env(),
                {"mode": "recent", "shard": 0, "shards": 20, "max_minutes": 150.0, "latest": 20},
            )

    def test_reads_overrides(self):
        with mock.patch.dict(
            os.environ,
            {
                "ALIGN_MODE": "latest", "ALIGN_SHARD": "3", "ALIGN_SHARDS": "20",
                "ALIGN_MAX_MINUTES": "90", "ALIGN_LATEST_PER_SHOW": "5",
            },
        ):
            got = aligner.align_env()
        self.assertEqual(got["mode"], "latest")
        self.assertEqual(got["shard"], 3)
        self.assertEqual(got["latest"], 5)

    def test_rejects_bad_values(self):
        with mock.patch.dict(os.environ, {"ALIGN_MODE": "bogus"}, clear=True):
            with self.assertRaises(ValueError):
                aligner.align_env()
        with mock.patch.dict(
            os.environ, {"ALIGN_SHARD": "5", "ALIGN_SHARDS": "4"}, clear=True
        ):
            with self.assertRaises(ValueError):
                aligner.align_env()
        with mock.patch.dict(os.environ, {"ALIGN_MAX_MINUTES": "0"}, clear=True):
            with self.assertRaises(ValueError):
                aligner.align_env()


class VttRoundTripTests(unittest.TestCase):
    def sample(self):
        return [
            {"start": 1.0, "end": 4.0, "en": "Hello there.", "zh": "你好。"},
            {"start": 60.5, "end": 62.0, "en": "Second cue.", "zh": "第二句。"},
        ]

    def test_render_then_parse_round_trips(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "ep.vtt"
            path.write_text(aligner.render_vtt(self.sample()), encoding="utf-8")
            back = aligner.parse_bilingual_vtt(path)
        self.assertEqual(back, self.sample())

    def test_parse_rejects_blocks_without_both_languages(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "ep.vtt"
            path.write_text(
                chr(10).join(["WEBVTT", "", "1", "00:00:01.000 --> 00:00:02.000", "Only english", ""]),
                encoding="utf-8",
            )
            cues = aligner.parse_bilingual_vtt(path)
        self.assertEqual(cues, [], "缺译文的块不参与重写")

    def test_validate_rejects_non_monotonic_times(self):
        text = aligner.render_vtt(
            [
                {"start": 5.0, "end": 6.0, "en": "a", "zh": "甲"},
                {"start": 2.0, "end": 3.0, "en": "b", "zh": "乙"},
            ]
        )
        with self.assertRaises(ValueError):
            aligner.validate_vtt(text, blocks=2, bilingual=True)


class MappingTests(unittest.TestCase):
    def test_normalize_lowercases_and_merges_continuations(self):
        tokens = aligner.normalize_tokens("Don't re-watch HowWeMadeYourMother.com!")
        self.assertEqual(tokens, ["dont", "rewatch", "howwemadeyourmothercom"])

    def test_cue_spans_cover_every_token_once(self):
        cues = [
            {"start": 0.0, "end": 1.0, "en": "one two", "zh": "甲"},
            {"start": 2.0, "end": 3.0, "en": "three", "zh": "乙"},
        ]
        tokens, spans = aligner.cue_token_spans(cues)
        self.assertEqual(tokens, ["one", "two", "three"])
        self.assertEqual(spans, [(0, 2), (2, 3)])

    def test_maps_identical_streams_one_to_one(self):
        mapping, similarity = aligner.map_stream(["a", "b", "c"], ["a", "b", "c"])
        self.assertEqual(mapping, {0: 0, 1: 1, 2: 2})
        self.assertAlmostEqual(similarity, 1.0)

    def test_maps_across_an_inserted_ad(self):
        pods = ["intro", "ad", "ad", "body", "end"]
        ours = ["intro", "body", "end"]
        mapping, similarity = aligner.map_stream(pods, ours)
        self.assertEqual(mapping[0], 0)
        self.assertEqual(mapping[3], 1)
        self.assertEqual(mapping[4], 2)
        self.assertNotIn(1, mapping)
        self.assertNotIn(2, mapping)
        self.assertGreater(similarity, 0.5)


class ClassifyTests(unittest.TestCase):
    def spans(self, *counts):
        spans, cursor = [], 0
        for count in counts:
            spans.append((cursor, cursor + count))
            cursor += count
        return spans

    def test_three_way_split_at_the_documented_thresholds(self):
        spans = self.spans(10, 10, 10, 10)
        mapping = {i: i for i in range(10)}
        mapping.update({10 + i: 10 + i for i in range(5)})
        mapping.update({20 + i: 20 + i for i in range(2)})
        got = aligner.classify_cues(spans, mapping)
        self.assertEqual(got, ["body", "partial", "drop", "drop"])

    def test_short_blocks_are_never_dropped(self):
        got = aligner.classify_cues(self.spans(3), {})
        self.assertEqual(got, ["partial"])

    def test_rejection_when_too_much_would_be_dropped(self):
        decisions = ["drop"] * 4 + ["body"] * 6
        self.assertEqual(aligner.episode_rejection(decisions, 0.99), "删除比例超过 25%")

    def test_rejection_on_low_similarity(self):
        self.assertEqual(aligner.episode_rejection(["body"] * 10, 0.5), "文本相似度过低")

    def test_accepts_a_healthy_episode(self):
        self.assertIsNone(aligner.episode_rejection(["body"] * 8 + ["drop"] * 2, 0.96))


class AssignTimesTests(unittest.TestCase):
    def setUp(self):
        self.words = [
            {"w": "one", "s": 1.0, "e": 1.4},
            {"w": "two", "s": 1.4, "e": 1.8},
            {"w": "three", "s": 1.8, "e": 2.2},
            {"w": "four", "s": 30.0, "e": 30.4},
            {"w": "five", "s": 30.4, "e": 31.0},
        ]

    def test_body_cue_takes_mapped_word_span(self):
        cues = [{"start": 0.0, "end": 10.0, "en": "one two three", "zh": "甲"}]
        out = aligner.assign_times(cues, [(0, 3)], ["body"], {0: 0, 1: 1, 2: 2}, self.words, 60.0)
        self.assertAlmostEqual(out[0]["start"], 1.0)
        self.assertAlmostEqual(out[0]["end"], 2.2)
        self.assertEqual([w["w"] for w in out[0]["words"]], ["one", "two", "three"])

    def test_dropped_cues_disappear(self):
        cues = [
            {"start": 0.0, "end": 10.0, "en": "one two three", "zh": "甲"},
            {"start": 10.0, "end": 20.0, "en": "four five", "zh": "乙"},
        ]
        out = aligner.assign_times(cues, [(0, 3), (3, 5)], ["body", "drop"], {0: 0, 1: 1, 2: 2}, self.words, 60.0)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["en"], "one two three")

    def test_unmapped_cue_is_interpolated_between_neighbours(self):
        cues = [
            {"start": 0.0, "end": 5.0, "en": "x" * 50, "zh": "甲"},
            {"start": 5.0, "end": 10.0, "en": "y" * 200, "zh": "乙"},
        ]
        out = aligner.assign_times(cues, [(0, 0), (0, 0)], ["partial", "partial"], {}, [], 60.0)
        self.assertAlmostEqual(out[0]["start"], 0.0)
        self.assertLess(out[0]["end"], out[1]["end"])
        self.assertEqual(out[0]["words"], [])

    def test_times_stay_monotonic_and_positive(self):
        cues = [
            {"start": 0.0, "end": 10.0, "en": "one two three", "zh": "甲"},
            {"start": 10.0, "end": 20.0, "en": "four five", "zh": "乙"},
        ]
        mapping = {0: 0, 1: 1, 2: 2, 3: 3, 4: 4}
        out = aligner.assign_times(cues, [(0, 3), (3, 5)], ["body", "body"], mapping, self.words, 60.0)
        self.assertTrue(all(cue["start"] < cue["end"] for cue in out))
        self.assertTrue(all(a["end"] <= b["start"] for a, b in zip(out, out[1:])))


VTT_BLOCKS = [
    ("00:00:01.000", "00:00:10.000", "Hello there friend we are back again", "你好朋友我们又回来了"),
    ("00:00:10.000", "00:00:20.000", "Buy our sponsor right now please", "现在就买我们的赞助"),
    ("00:00:20.000", "00:00:30.000", "Back to the show with more words here", "回到节目多说几句"),
    ("00:00:30.000", "00:00:40.000", "Another body line here with extra padding", "另一句正文再垫一点"),
    ("00:00:40.000", "00:00:50.000", "Final body line ends right about here", "最后一句正文到这里"),
]


def build_vtt(rows, bilingual=True):
    out = ["WEBVTT", ""]
    for index, (start, end, en, zh) in enumerate(rows, 1):
        out.extend([str(index), f"{start} --> {end}", en])
        if bilingual:
            out.append(zh)
        out.append("")
    return chr(10).join(out)


class RewriteEpisodeTests(unittest.TestCase):
    def setUp(self):
        import transcribe as _t

        self.transcribe = _t
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.site = root / "site"
        self.dir = self.site / "pod" / "transcripts"
        self.dir.mkdir(parents=True)
        (self.dir / "zh").mkdir()
        self.vtt = self.dir / "Ep.vtt"
        self.vtt.write_text(build_vtt(VTT_BLOCKS), encoding="utf-8")
        self.zh = self.dir / "zh" / "Ep.vtt"
        self.zh.write_text(build_vtt(VTT_BLOCKS, bilingual=False), encoding="utf-8")
        self.timing = self.site / "pod" / "timings"
        for patch_ in (
            mock.patch.object(self.transcribe, "TIMING_DIR", self.timing),
            mock.patch.object(self.transcribe, "SITE_DIR", self.site),
        ):
            patch_.start()
            self.addCleanup(patch_.stop)

    def fake_transcribe(self, path):
        lines = [
            ("Hello there friend we are back again", 1.0),
            ("Back to the show with more words here", 31.0),
            ("Another body line here with extra padding", 41.0),
            ("Final body line ends right about here", 51.0),
        ]
        cues, words = [], []
        for text, start in lines:
            line_words = []
            for offset, token in enumerate(text.split()):
                word = {"w": token, "s": start + offset * 0.4, "e": start + (offset + 1) * 0.4}
                line_words.append(word)
                words.append(word)
            cues.append({"start": start, "end": start + len(line_words) * 0.4, "en": text, "zh": "", "words": line_words})
        return cues, 60.0

    def run_rewrite(self):
        return aligner.rewrite_episode(
            self.vtt, "https://cdn.test/a.mp3", object(),
            workdir=Path(self.temp.name),
            download=lambda url, path: path.write_bytes(b"x"),
            transcribe_audio=self.fake_transcribe,
        )

    def test_ad_block_is_dropped_from_both_vtts(self):
        self.assertEqual(self.run_rewrite(), "done")
        en = self.vtt.read_text(encoding="utf-8")
        zh = self.zh.read_text(encoding="utf-8")
        self.assertNotIn("sponsor", en)
        self.assertNotIn("赞助", zh)
        self.assertEqual(en.count("-->"), 4)
        self.assertEqual(zh.count("-->"), 4)

    def test_remaining_cues_use_real_times_and_keep_chinese(self):
        self.run_rewrite()
        cues = aligner.parse_bilingual_vtt(self.vtt)
        self.assertAlmostEqual(cues[0]["start"], 1.0, places=2)
        self.assertAlmostEqual(cues[1]["start"], 31.0, places=2)
        self.assertEqual(cues[0]["zh"], "你好朋友我们又回来了")

    def test_sidecar_matches_rewritten_cues(self):
        self.run_rewrite()
        self.assertEqual(self.transcribe.sidecar_status(self.timing / "Ep.json"), (True, 1))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main()

if __name__ == "__main__":
    unittest.main()
