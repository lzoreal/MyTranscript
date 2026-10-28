import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location("align_timings", ROOT / "scripts" / "align_timings.py")
aligner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(aligner)


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


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main()
