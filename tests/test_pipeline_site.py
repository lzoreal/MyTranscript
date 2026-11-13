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


class IncrementalPublishTests(unittest.TestCase):
    def test_second_publish_skips_when_data_did_not_change(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data = root / "data" / "pod"
            data.mkdir(parents=True)
            (data / "g1.json").write_text(json.dumps(DOCUMENT), encoding="utf-8")
            calls = []

            def feed(*args, **kwargs):
                calls.append("feed")
                target = root / "site" / "pod" / "feed.xml"
                target.parent.mkdir(parents=True, exist_ok=True)
                url = site.word_transcript.public_url("pod", "Ep_One.json")
                target.write_text(f"<rss><u>{url}</u></rss>", encoding="utf-8")

            def index(*args, **kwargs):
                calls.append("index")
                target = root / "site" / "pod" / "index.html"
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("<html/>", encoding="utf-8")

            show = {"slug": "pod"}
            kwargs = dict(
                data_dir=root / "data",
                json_dir=root / "json",
                site_dir=root / "site",
                progress={"podcasts": {}},
                site_base_url="https://pages.test",
                podcast={"slug": "pod", "feed_url": "u", "language": "en"},
            )
            with patch.object(site.scraper, "generate_podcast_feed", feed), patch.object(
                site.scraper, "generate_podcast_index", index
            ):
                first = site.publish_show(show, **kwargs)
                second = site.publish_show(show, **kwargs)
                # feed 里缺少 JSON 链接（上次导出后中断）时必须重建。
                (root / "site" / "pod" / "feed.xml").write_text("<rss/>", encoding="utf-8")
                third = site.publish_show(show, **kwargs)

            self.assertTrue(first["published"])
            self.assertFalse(second["published"])
            self.assertTrue(third["published"])
            self.assertEqual(calls, ["feed", "index", "feed", "index"])


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


class DuplicateTitleTests(unittest.TestCase):
    def _stems(self, documents, processed=None, exported=None):
        import scraper

        with tempfile.TemporaryDirectory() as temp_dir:
            old = scraper.SITE_DIR
            scraper.SITE_DIR = Path(temp_dir)
            try:
                return site.assign_stems(
                    documents, "pod", processed or {}, exported
                )
            finally:
                scraper.SITE_DIR = old

    def test_colliding_titles_get_distinct_stems(self):
        stems = self._stems(
            [{"guid": "g1", "title": "Same"}, {"guid": "g2", "title": "Same"}]
        )
        self.assertEqual(len(set(stems.values())), 2)
        self.assertEqual(stems["g1"], "Same")
        self.assertTrue(stems["g2"].startswith("Same_"))

    def test_existing_export_owner_keeps_the_base_name(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            exported = Path(temp_dir) / "json" / "pod"
            exported.mkdir(parents=True)
            (exported / "Same.json").write_text(
                json.dumps({"guid": "g2"}), encoding="utf-8"
            )
            stems = self._stems(
                [{"guid": "g1", "title": "Same"}, {"guid": "g2", "title": "Same"}],
                exported=exported,
            )
        self.assertEqual(stems["g2"], "Same")
        self.assertNotEqual(stems["g1"], "Same")

    def test_foreign_export_does_not_switch_old_episode_to_json(self):
        progress = {
            "podcasts": {
                "pod": {
                    "processed": {"old": {"vtt_filename": "Same.vtt"}},
                }
            }
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            exported = Path(temp_dir) / "json" / "pod"
            exported.mkdir(parents=True)
            (exported / "Same.json").write_text(
                json.dumps({"guid": "other"}), encoding="utf-8"
            )
            merged = site.merged_processed(
                progress, "pod", {}, Path(temp_dir) / "json"
            )
        self.assertNotIn("transcript_filename", merged["old"])
        self.assertEqual(merged["old"]["vtt_filename"], "Same.vtt")


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
        with tempfile.TemporaryDirectory() as temp_dir:
            json_dir = Path(temp_dir) / "json"
            (json_dir / "pod").mkdir(parents=True)
            (json_dir / "pod" / "Old.json").write_text("{}", encoding="utf-8")
            merged = site.merged_processed(progress, "pod", {"new": "New_Ep"}, json_dir)
        self.assertEqual(merged["old"]["vtt_filename"], "Old.vtt")
        self.assertEqual(merged["new"]["transcript_filename"], "New_Ep.json")
        self.assertEqual(merged["new"]["transcript_type"], "application/json")
        self.assertIn("skipped", merged, "旧记录原样保留，删不删由 feed 构建器决定")

    def test_old_episode_points_to_json_only_after_export(self):
        progress = {
            "podcasts": {
                "pod": {
                    "processed": {
                        "old": {"vtt_filename": "Old.vtt", "skipped": False},
                    }
                }
            }
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            json_dir = Path(temp_dir) / "json"
            (json_dir / "pod").mkdir(parents=True)
            (json_dir / "pod" / "Old.json").write_text("{}", encoding="utf-8")
            merged = site.merged_processed(progress, "pod", {}, json_dir)
        self.assertEqual(merged["old"]["transcript_filename"], "Old.json")
        self.assertEqual(merged["old"]["transcript_type"], "application/json")

    def test_old_episode_without_json_stays_vtt(self):
        progress = {
            "podcasts": {
                "pod": {
                    "processed": {
                        "old": {"vtt_filename": "Old.vtt", "skipped": False},
                    }
                }
            }
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            merged = site.merged_processed(progress, "pod", {}, Path(temp_dir) / "json")
        self.assertNotIn("transcript_filename", merged["old"])
        self.assertEqual(merged["old"]["vtt_filename"], "Old.vtt")


if __name__ == "__main__":
    unittest.main()
