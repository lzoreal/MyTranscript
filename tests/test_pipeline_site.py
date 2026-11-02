import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).parents[1]
MODULE = ROOT / "scripts" / "pipeline_site.py"
SPEC = importlib.util.spec_from_file_location("pipeline_site", MODULE)
site = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(site)

DOCUMENT = {
    "guid": "g1",
    "title": "Ep One",
    "audio_seconds": 2.0,
    "sentences": [
        {
            "start": 0.0,
            "end": 1.0,
            "en": "Hi.",
            "zh": "嗨。",
            "words": [{"w": "Hi.", "s": 0.0, "e": 1.0}],
        }
    ],
}


class JsonWriteTests(unittest.TestCase):
    def test_publish_show_writes_json_and_no_zh_feed(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data = root / "data" / "pod"
            data.mkdir(parents=True)
            (data / "g1.json").write_text(json.dumps(DOCUMENT), encoding="utf-8")
            calls = []
            with patch.object(
                site.scraper,
                "generate_podcast_feed",
                lambda *a, **k: calls.append("feed"),
            ), patch.object(
                site.scraper,
                "generate_podcast_index",
                lambda *a, **k: calls.append("index"),
            ):
                result = site.publish_show(
                    {"slug": "pod"},
                    data_dir=root / "data",
                    json_dir=root / "json",
                    site_dir=root / "site",
                    progress={"podcasts": {}},
                    site_base_url="https://pages.test",
                    podcast={"slug": "pod", "feed_url": "u", "language": "en"},
                )
            self.assertEqual(result["episodes"], 1)
            self.assertEqual(calls, ["feed", "index"])
            self.assertTrue((root / "json" / "pod" / "Ep_One.json").exists())
            self.assertFalse((root / "site" / "pod" / "feed-zh.xml").exists())


class NamingTests(unittest.TestCase):
    def test_existing_filename_wins(self):
        processed = {"g1": {"vtt_filename": "Old Title.vtt"}}
        self.assertEqual(
            site.stem_for({"guid": "g1", "title": "New"}, "pod", processed),
            "Old Title",
        )

    def test_json_filename_wins_when_vtt_is_archived(self):
        processed = {"g1": {"transcript_filename": "Old Title.json"}}
        self.assertEqual(
            site.stem_for({"guid": "g1", "title": "New"}, "pod", processed),
            "Old Title",
        )

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
        progress = {
            "podcasts": {
                "pod": {
                    "processed": {
                        "old": {"vtt_filename": "Old.vtt", "skipped": False},
                        "skipped": {"vtt_filename": None, "skipped": True},
                    }
                }
            }
        }
        merged = site.merged_processed(progress, "pod", {"new": "New_Ep"})
        self.assertEqual(merged["old"]["vtt_filename"], "Old.vtt")
        self.assertEqual(merged["new"]["transcript_filename"], "New_Ep.json")
        self.assertEqual(merged["new"]["transcript_type"], "application/json")
        self.assertIn("skipped", merged, "旧记录原样保留，删不删由 feed 构建器决定")

    def test_records_point_to_json_transcripts(self):
        progress = {
            "podcasts": {
                "pod": {
                    "processed": {
                        "old": {"vtt_filename": "Old.vtt", "skipped": False},
                    }
                }
            }
        }
        merged = site.merged_processed(progress, "pod", {"new": "New_Ep"})
        self.assertEqual(merged["old"]["transcript_filename"], "Old.json")
        self.assertEqual(merged["old"]["transcript_type"], "application/json")
        self.assertEqual(merged["new"]["transcript_filename"], "New_Ep.json")


if __name__ == "__main__":
    unittest.main()
