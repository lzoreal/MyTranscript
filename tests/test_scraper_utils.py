import hashlib
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "scraper.py"
SPEC = importlib.util.spec_from_file_location("scraper", MODULE_PATH)
scraper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(scraper)


class UrlTests(unittest.TestCase):
    def test_path_segment_encodes_percent_once(self):
        self.assertEqual(scraper.url_path_segment("99%-invisible"), "99%25-invisible")

    def test_public_url_encodes_each_segment(self):
        self.assertEqual(
            scraper.public_url("https://example.test/MyTranscript/", "99%-invisible", "feed.xml"),
            "https://example.test/MyTranscript/99%25-invisible/feed.xml",
        )


class FilenameTests(unittest.TestCase):
    def test_safe_filename_replaces_unsafe_characters(self):
        self.assertEqual(scraper.safe_filename("A/B: C?"), "A_B_C")
        self.assertEqual(scraper.safe_filename(""), "episode")

    def test_unique_filename_reuses_own_record(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            site_dir = Path(temp_dir) / "site"
            transcript_dir = site_dir / "pod" / "transcripts"
            transcript_dir.mkdir(parents=True)
            (transcript_dir / "Same.vtt").write_text("WEBVTT", encoding="utf-8")
            with patch.object(scraper, "SITE_DIR", site_dir):
                name = scraper.unique_vtt_filename(
                    "Same", "guid-1", "pod", {"guid-1": {"vtt_filename": "Same.vtt"}}
                )
            self.assertEqual(name, "Same.vtt")

    def test_unique_filename_avoids_other_guid(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            site_dir = Path(temp_dir) / "site"
            transcript_dir = site_dir / "pod" / "transcripts"
            transcript_dir.mkdir(parents=True)
            with patch.object(scraper, "SITE_DIR", site_dir):
                name = scraper.unique_vtt_filename(
                    "Same", "guid-2", "pod", {"guid-1": {"vtt_filename": "Same.vtt"}}
                )
            suffix = hashlib.sha1(b"guid-2").hexdigest()[:8]
            self.assertEqual(name, f"Same_{suffix}.vtt")

    def test_unique_filename_avoids_unknown_existing_file(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            site_dir = Path(temp_dir) / "site"
            transcript_dir = site_dir / "pod" / "transcripts"
            transcript_dir.mkdir(parents=True)
            (transcript_dir / "Same.vtt").write_text("WEBVTT", encoding="utf-8")
            with patch.object(scraper, "SITE_DIR", site_dir):
                name = scraper.unique_vtt_filename("Same", "guid-3", "pod", {})
            suffix = hashlib.sha1(b"guid-3").hexdigest()[:8]
            self.assertEqual(name, f"Same_{suffix}.vtt")


class TitleTests(unittest.TestCase):
    def test_normalize_title_strips_episode_prefix_and_punctuation(self):
        self.assertEqual(
            scraper.normalize_episode_title("Episode 12: Hello, World!"),
            "hello world",
        )

    def test_search_variants_include_colon_halves(self):
        variants = scraper.build_search_variants("Part 1: The Beginning")
        self.assertIn("Part 1: The Beginning", variants)
        self.assertIn("Part 1", variants)
        self.assertIn("The Beginning", variants)

    def test_similarity_prefers_containment(self):
        self.assertGreater(
            scraper.title_similarity("The Office", "The Office Revisited"), 0.9
        )


class VttTests(unittest.TestCase):
    def test_cues_to_vtt_uses_next_start_and_final_duration(self):
        vtt = scraper.cues_to_vtt(
            [
                {"start_seconds": 0, "text": "one"},
                {"start_seconds": 2, "text": "two"},
            ]
        )
        self.assertIn("00:00:00.000 --> 00:00:02.000", vtt)
        self.assertIn("00:00:02.000 --> 00:00:07.000", vtt)
        self.assertTrue(vtt.startswith("WEBVTT\n"))


if __name__ == "__main__":
    unittest.main()
