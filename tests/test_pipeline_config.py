import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

MODULE = Path(__file__).parents[1] / "scripts" / "pipeline_config.py"
SPEC = importlib.util.spec_from_file_location("pipeline_config", MODULE)
pcfg = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pcfg)


class RssCacheTests(unittest.TestCase):
    def test_list_episodes_prefers_the_cached_rss(self):
        rss = (b"<rss><channel><item><guid>g1</guid><title>T</title>"
               b"<enclosure url='a.mp3'/></item></channel></rss>")
        with tempfile.TemporaryDirectory() as temp_dir:
            os.environ["RSS_CACHE_DIR"] = temp_dir
            try:
                url = "https://example.test/feed"
                pcfg.rss_cache_path(temp_dir, url).write_bytes(rss)
                episodes = pcfg.list_episodes(url)
            finally:
                del os.environ["RSS_CACHE_DIR"]
        self.assertEqual([episode["guid"] for episode in episodes], ["g1"])


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
        # 一个节目 121 集也必须能切给多个 job：同一份候选集的分片结果可复现。
        episodes = [{"guid": f"g{i}"} for i in range(121)]
        parts = [pcfg.shard_episodes(episodes, shard=i, shards=8) for i in range(8)]
        self.assertEqual(sum(len(part) for part in parts), 121)
        seen = [e["guid"] for part in parts for e in part]
        self.assertEqual(len(seen), len(set(seen)))
        self.assertEqual(parts[0], pcfg.shard_episodes(episodes, shard=0, shards=8))

    def test_sharding_balances_pending_work(self):
        episodes = [{"guid": f"g{i}"} for i in range(121)]
        done = {f"g{i}" for i in range(0, 121, 3)}
        parts = [
            pcfg.shard_episodes(episodes, shard=i, shards=8, done=done)
            for i in range(8)
        ]
        counts = [len(part) for part in parts]
        self.assertLessEqual(max(counts) - min(counts), 1, counts)
        picked = {e["guid"] for part in parts for e in part}
        self.assertEqual(picked, {e["guid"] for e in episodes} - done)

    def test_single_shard_keeps_every_episode(self):
        episodes = [{"guid": f"g{i}"} for i in range(5)]
        self.assertEqual(pcfg.shard_episodes(episodes, shard=3, shards=1), episodes)

    def test_only_slug_wins(self):
        shows = [{"slug": "a", "feed_url": "u", "text_source": "asr"}]
        self.assertEqual(pcfg.select_shows(shows, only_slug="a"), shows)
        self.assertEqual(pcfg.select_shows(shows, only_slug="b"), [])


if __name__ == "__main__":
    unittest.main()
