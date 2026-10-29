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

    def test_sharding_is_stable_and_partitions_episodes(self):
        # 一个节目 121 集也必须能切给多个 job：按 guid 切，同一集永远同一片。
        episodes = [{"guid": f"g{i}"} for i in range(121)]
        parts = [pcfg.shard_episodes(episodes, shard=i, shards=8) for i in range(8)]
        self.assertEqual(sum(len(part) for part in parts), 121)
        seen = [e["guid"] for part in parts for e in part]
        self.assertEqual(len(seen), len(set(seen)))
        self.assertEqual(parts[0], pcfg.shard_episodes(episodes, shard=0, shards=8))

    def test_single_shard_keeps_every_episode(self):
        episodes = [{"guid": f"g{i}"} for i in range(5)]
        self.assertEqual(pcfg.shard_episodes(episodes, shard=3, shards=1), episodes)

    def test_only_slug_wins(self):
        shows = [{"slug": "a", "feed_url": "u", "text_source": "asr"}]
        self.assertEqual(pcfg.select_shows(shows, only_slug="a"), shows)
        self.assertEqual(pcfg.select_shows(shows, only_slug="b"), [])


if __name__ == "__main__":
    unittest.main()
