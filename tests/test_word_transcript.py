import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location(
    "word_transcript", ROOT / "scripts" / "word_transcript.py"
)
wt = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(wt)

DOC = {
    "version": 2,
    "slug": "pod",
    "guid": "g1",
    "title": "Ep",
    "audio_seconds": 12.5,
    "sentences": [
        {
            "start": 0.0,
            "end": 2.5,
            "en": "Hello there.",
            "zh": "你好。",
            "words": [
                {"w": "Hello", "s": 0.0, "e": 1.0},
                {"w": "there.", "s": 1.0, "e": 2.5},
            ],
            "zh_words": [["你好", 0, 2500]],
        },
        {
            "start": 2.5,
            "end": 3.0,
            "en": "Bye.",
            "zh": "",
            "words": [{"w": "Bye.", "s": 2.5, "e": 3.0}],
        },
    ],
}


class BuildTests(unittest.TestCase):
    def test_standard_fields_match_podcasting_2_0(self):
        out = wt.build(DOC)
        self.assertEqual(out["version"], "1.0.0")
        self.assertEqual(out["audio_seconds"], 12.5)
        seg = out["segments"][0]
        self.assertEqual(seg["startTime"], 0.0)
        self.assertEqual(seg["endTime"], 2.5)
        self.assertEqual(seg["body"], "Hello there.\n你好。")
        self.assertEqual(seg["text"], seg["body"])

    def test_extension_fields_are_ms_and_monotonic(self):
        seg = wt.build(DOC)["segments"][0]
        self.assertEqual(seg["start"], 0)
        self.assertEqual(seg["end"], 2500)
        self.assertEqual(seg["words"], [["Hello", 0, 1000], ["there.", 1000, 1500]])
        starts = [word[1] for word in seg["words"]]
        self.assertEqual(starts, sorted(starts))

    def test_missing_chinese_keeps_english_only(self):
        seg = wt.build(DOC)["segments"][1]
        self.assertEqual(seg["body"], "Bye.")
        self.assertEqual(seg["words"], [["Bye.", 2500, 500]])

    def test_invalid_sentence_is_skipped(self):
        broken = {
            "audio_seconds": 1.0,
            "sentences": [{"start": 2.0, "end": 2.0, "en": "Bad.", "words": []}],
        }
        self.assertEqual(wt.build(broken)["segments"], [])


class ExportTests(unittest.TestCase):
    def test_export_show_writes_only_mapped_stems(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            show_dir = root / "data" / "pod"
            show_dir.mkdir(parents=True)
            (show_dir / "g1.json").write_text(json.dumps(DOC), encoding="utf-8")
            unmapped = dict(DOC, guid="g2")
            (show_dir / "g2.json").write_text(json.dumps(unmapped), encoding="utf-8")
            (show_dir / "state-0.json").write_text("{}", encoding="utf-8")

            written = wt.export_show(root / "data", root / "json", "pod", {"g1": "Ep_One"})

            self.assertEqual(written, 1)
            out = root / "json" / "pod" / "Ep_One.json"
            self.assertTrue(out.exists())
            self.assertFalse((out.parent / "Ep_One.vtt").exists())
            doc = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(doc["segments"][0]["body"], "Hello there.\n你好。")


class PublicUrlTests(unittest.TestCase):
    def test_raw_url_encodes_slug_and_filename(self):
        self.assertEqual(
            wt.public_url("99%-invisible", "Ep One!.json"),
            "https://raw.githubusercontent.com/lzoreal/MyTranscript/main"
            "/json/99%25-invisible/Ep%20One%21.json",
        )


if __name__ == "__main__":
    unittest.main()
