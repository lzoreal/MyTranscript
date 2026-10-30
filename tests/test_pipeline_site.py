import importlib.util
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
MODULE = ROOT / "scripts" / "pipeline_site.py"
SPEC = importlib.util.spec_from_file_location("pipeline_site", MODULE)
site = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(site)

SENTENCES = [
    {"start": 0.0, "end": 2.5, "en": "Hello there.", "zh": "你好。"},
    {"start": 2.5, "end": 4.0, "en": "Bye.", "zh": "再见。"},
]


class RenderTests(unittest.TestCase):
    def test_english_vtt_has_no_chinese(self):
        text = site.render_english(SENTENCES)
        self.assertTrue(text.startswith("WEBVTT"))
        self.assertIn("00:00:00.000 --> 00:00:02.500", text)
        self.assertNotIn("你好", text)

    def test_bilingual_requires_both_languages(self):
        broken = [{"start": 0.0, "end": 1.0, "en": "Hi", "zh": ""}]
        with self.assertRaises(ValueError):
            site._bilingual(broken)

    def test_invalid_span_is_rejected(self):
        with self.assertRaises(ValueError):
            site.render_english([{"start": 2.0, "end": 2.0, "en": "Hi"}])


class NamingTests(unittest.TestCase):
    def test_existing_filename_wins(self):
        processed = {"g1": {"vtt_filename": "Old Title.vtt"}}
        self.assertEqual(site.stem_for({"guid": "g1", "title": "New"}, "pod", processed),
                         "Old Title")

    def test_collision_gets_a_stable_suffix(self):
        processed = {"other": {"vtt_filename": "Same.vtt"}}
        with tempfile.TemporaryDirectory() as temp_dir:
            import scraper

            old = scraper.SITE_DIR
            scraper.SITE_DIR = Path(temp_dir)
            try:
                stem = site.stem_for({"guid": "g1", "title": "Same"}, "pod", processed)
            finally:
                scraper.SITE_DIR = old
        self.assertTrue(stem.startswith("Same_"))
        self.assertEqual(len(stem.split("_")[-1]), 8)


class MergeTests(unittest.TestCase):
    def test_old_and_new_episodes_are_merged(self):
        progress = {"podcasts": {"pod": {"processed": {
            "old": {"vtt_filename": "Old.vtt", "skipped": False},
            "skipped": {"vtt_filename": None, "skipped": True},
        }}}}
        merged = site.merged_processed(progress, "pod", {"new": "New_Ep"})
        self.assertEqual(merged["old"]["vtt_filename"], "Old.vtt")
        self.assertEqual(merged["new"]["vtt_filename"], "New_Ep.vtt")
        self.assertIn("skipped", merged, "旧记录原样保留，删不删由 feed 构建器决定")

    def test_status_entry_marks_translated_with_a_hash(self):
        entry = site.status_entry("WEBVTT\n", now="2026-10-30T00:00:00.000+00:00")
        self.assertTrue(entry["translated"])
        self.assertEqual(len(entry["hash"]), 64)
        self.assertEqual(entry["updated"], "2026-10-30T00:00:00.000+00:00")


if __name__ == "__main__":
    unittest.main()
