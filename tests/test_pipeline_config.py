import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

MODULE = Path(__file__).parents[1] / "scripts" / "pipeline_config.py"
SPEC = importlib.util.spec_from_file_location("pipeline_config", MODULE)
pcfg = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pcfg)


class ConfigTests(unittest.TestCase):
    def test_rejects_unknown_text_source_and_missing_podscripts_id(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "feeds.json"
            path.write_text(json.dumps([{"slug": "a", "feed_url": "u", "text_source": "nope"}]), encoding="utf-8")
            with self.assertRaises(ValueError):
                pcfg.load_feeds(path)
            path.write_text(json.dumps([{"slug": "a", "feed_url": "u", "text_source": "podscripts"}]), encoding="utf-8")
            with self.assertRaises(ValueError):
                pcfg.load_feeds(path)

    def test_sharding_is_stable_and_partitions_shows(self):
        shows = [{"slug": f"s{i}", "feed_url": "u", "text_source": "asr"} for i in range(10)]
        first = pcfg.select_shows(shows, shard=0, shards=2)
        second = pcfg.select_shows(shows, shard=1, shards=2)
        self.assertEqual(len(first) + len(second), 10)
        self.assertFalse({s["slug"] for s in first} & {s["slug"] for s in second})
        self.assertEqual(first, pcfg.select_shows(shows, shard=0, shards=2))

    def test_only_slug_wins(self):
        shows = [{"slug": "a", "feed_url": "u", "text_source": "asr"}]
        self.assertEqual(pcfg.select_shows(shows, only_slug="a", shard=0, shards=1), shows)
        self.assertEqual(pcfg.select_shows(shows, only_slug="b", shard=0, shards=1), [])


if __name__ == "__main__":
    unittest.main()
