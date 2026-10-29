import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import types

fw = types.ModuleType("faster_whisper")
fw.WhisperModel = object
sys.modules.setdefault("faster_whisper", fw)
for _name in ("google", "google.genai", "google.genai.types"):
    sys.modules.setdefault(_name, types.ModuleType(_name))
sys.modules["google"].genai = sys.modules["google.genai"]
sys.modules["google"].genai.types = sys.modules["google.genai.types"]
for _attr in ("Client", "GenerateContentConfig"):
    if not hasattr(sys.modules["google"].genai, _attr):
        setattr(sys.modules["google"].genai, _attr, object)
sys.modules.setdefault("feedparser", types.ModuleType("feedparser"))

MODULE = Path(__file__).parents[1] / "scripts" / "run_pipeline.py"
SPEC = importlib.util.spec_from_file_location("run_pipeline", MODULE)
runmod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runmod)


class EnvTests(unittest.TestCase):
    def test_defaults_and_overrides(self):
        got = runmod.pipeline_env({})
        self.assertEqual(got["shards"], 1)
        self.assertEqual(got["data_dir"], Path("data"))
        got = runmod.pipeline_env({"SHARDS": "10", "SHARD": "3", "MAX_MINUTES": "150", "ONLY_SLUG": "x"})
        self.assertEqual(got["shard"], 3)
        self.assertEqual(got["only_slug"], "x")

    def test_rejects_bad_shard(self):
        with self.assertRaises(ValueError):
            runmod.pipeline_env({"SHARDS": "10", "SHARD": "10"})

    def test_run_stops_when_budget_is_spent(self):
        seen = []
        stats = runmod.run(
            [{"slug": "a", "text_source": "asr", "episodes": [1, 2, 3]}],
            deps_factory=lambda show: {},
            data_dir=Path("unused"),
            max_minutes=1,
            clock=iter([0.0, 0.0, 99999.0]).__next__,
            process=lambda show, episode, deps, data_dir: seen.append(episode) or "done",
        )
        self.assertLess(len(seen), 3)
        self.assertEqual(stats["done"], len(seen))

    def test_prepared_shows_partition_episodes_and_name_their_state(self):
        episodes = [{"guid": f"g{i}"} for i in range(40)]
        shows = [{"slug": "a", "feed_url": "u", "text_source": "asr"}]
        a = runmod.prepare_shows(shows, shard=0, shards=4, list_episodes=lambda url: episodes)
        b = runmod.prepare_shows(shows, shard=1, shards=4, list_episodes=lambda url: episodes)
        self.assertEqual(a[0]["state_suffix"], "-0")
        self.assertEqual(b[0]["state_suffix"], "-1")
        self.assertFalse({e["guid"] for e in a[0]["episodes"]} & {e["guid"] for e in b[0]["episodes"]})
        parts = [
            runmod.prepare_shows(shows, shard=i, shards=4, list_episodes=lambda url: episodes)[0]["episodes"]
            for i in range(4)
        ]
        self.assertEqual(sum(len(part) for part in parts), len(episodes))

    def test_single_shard_keeps_the_plain_state_file(self):
        shows = [{"slug": "a", "feed_url": "u", "text_source": "asr"}]
        got = runmod.prepare_shows(shows, shard=0, shards=1, list_episodes=lambda url: [{"guid": "g1"}])
        self.assertEqual(got[0]["state_suffix"], "")
        self.assertEqual(len(got[0]["episodes"]), 1)

    def test_run_leaves_room_for_one_more_episode(self):
        # 单集动辄 40 分钟且不可中断：剩 45 分钟时开新一集，这一块就会越过截止线，
        # 分块提交跟着变稀。留一集余量后，45 分钟的块只干一集就收尾。
        seen = []
        times = iter([0.0, 0.0, 10 * 60.0, 10 * 60.0, 20 * 60.0])
        stats = runmod.run(
            [{"slug": "a", "text_source": "asr", "episodes": [1, 2, 3]}],
            deps_factory=lambda show: {},
            data_dir=Path("unused"),
            max_minutes=45,
            reserve_minutes=40,
            clock=lambda: next(times),
            process=lambda show, episode, deps, data_dir: seen.append(episode) or "done",
        )
        self.assertEqual(len(seen), 1, "剩 35 分钟不够一集，不能再开")
        self.assertEqual(stats["done"], 1)

    def test_run_pauses_on_quota_instead_of_failing_episodes(self):
        seen = []

        def process(show, episode, deps, data_dir):
            seen.append(episode)
            if episode == 2:
                raise runmod.pepisode.QuotaExhausted("all keys spent")
            return "done"

        stats = runmod.run(
            [{"slug": "a", "text_source": "asr", "episodes": [1, 2, 3]}],
            deps_factory=lambda show: {},
            data_dir=Path("unused"),
            max_minutes=60,
            clock=lambda: 0.0,
            process=process,
        )
        self.assertEqual(seen, [1, 2], "配额用尽后不再继续下一集")
        self.assertEqual(stats["done"], 1)
        self.assertTrue(stats["paused"], "配额暂停要让调用方知道，好停下来提交断点")


if __name__ == "__main__":
    unittest.main()
