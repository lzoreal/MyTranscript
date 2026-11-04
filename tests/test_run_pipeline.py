import importlib.util
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

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

    def test_prepared_shows_spread_pending_evenly(self):
        episodes = [{"guid": f"g{i}"} for i in range(41)]
        done = {f"g{i}" for i in range(0, 41, 2)}
        shows = [{"slug": "a", "feed_url": "u", "text_source": "asr"}]
        parts = [
            runmod.prepare_shows(
                shows, shard=i, shards=4,
                list_episodes=lambda url: episodes,
                blocked_lookup=lambda slug: done,
            )[0]["episodes"]
            for i in range(4)
        ]
        counts = [len(part) for part in parts]
        self.assertLessEqual(max(counts) - min(counts), 1, counts)
        picked = {e["guid"] for part in parts for e in part}
        self.assertEqual(picked, {e["guid"] for e in episodes} - done)

    def test_plan_is_cut_once_per_run(self):
        # 每片一个 run 只切一次：后续分块不能把别的片正在跑的集抢过来，
        # 否则两片写同一个 data/<slug>/<guid>.json，提交就撞车。
        episodes = [{"guid": f"g{i}"} for i in range(11)]
        shows = [{"slug": "a", "feed_url": "u", "text_source": "asr"}]
        plans, done = {}, set()

        def prep(shard):
            return [e["guid"] for e in runmod.prepare_shows(
                shows, shard=shard, shards=3, list_episodes=lambda url: episodes,
                blocked_lookup=lambda slug: set(done),
                plan_lookup=lambda slug: plans.get((slug, shard)),
                claimed_lookup=lambda slug: {
                    guid for (slug_, other), got in plans.items()
                    if slug_ == slug and other != shard for guid in got
                },
                plan_save=lambda slug, guids: plans.__setitem__((slug, shard), list(guids)),
            )[0]["episodes"]]

        first, second, third = prep(0), prep(1), prep(2)
        self.assertEqual(len(first) + len(second) + len(third),
                         len(set(first) | set(second) | set(third)))
        done.add(first[0])
        self.assertEqual(prep(0), first[1:], "复用计划，只去掉已经做完的")

        del plans[("a", 2)]
        late = prep(2)
        self.assertFalse(set(late) & (set(first) | set(second)),
                         "晚启动的片要按别人的 plan 让开，而不是按 state")

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

    def test_exit_code_3_when_only_skips_remain(self):
        # 整片候选集都已 done 时，每块只剩 skipped；此时必须收工，
        # 否则分块循环会把 330 分钟预算耗在空转上，白占 runner。
        self.assertEqual(runmod.final_code({"done": 0, "skipped": 30, "failed": 0}), 3)

    def test_exit_code_0_while_work_or_failures_happened(self):
        self.assertEqual(runmod.final_code({"done": 1, "skipped": 5, "failed": 0}), 0)
        self.assertEqual(runmod.final_code({"done": 0, "skipped": 5, "failed": 1}), 0)
        self.assertEqual(runmod.final_code({"done": 0, "skipped": 0, "failed": 0}), 3)

    def test_exit_code_2_wins_over_stop(self):
        self.assertEqual(runmod.final_code({"done": 0, "skipped": 5}, paused=True), 2)

    def test_publish_key_health_excludes_dead_keys_and_offsets_the_start(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            runmod.pkeyhealth.record(
                Path(temp_dir) / "shard-1.json", "k-dead", "auth", now=time.time()
            )
            with patch.dict(
                "os.environ",
                {"GEMINI_HEALTH_DIR": temp_dir, "GEMINI_EXCLUDE_KEYS": ""},
            ):
                runmod.publish_key_health({"shard": 3, "shards": 10})
                self.assertEqual(os.environ["GEMINI_KEY_OFFSET"], "3")
                self.assertEqual(
                    os.environ["GEMINI_EXCLUDE_KEYS"],
                    runmod.pkeyhealth.key_id("k-dead"),
                )

    def test_publish_key_health_is_a_no_op_without_a_health_dir(self):
        with patch.dict("os.environ", {"GEMINI_HEALTH_DIR": ""}, clear=False):
            runmod.publish_key_health({"shard": 2, "shards": 10})
            self.assertEqual(os.environ["GEMINI_KEY_OFFSET"], "2")

    def test_publish_key_health_keeps_keys_dead_only_on_one_model(self):
        # 额度按 (key, model) 计：某把 key 只在轮换表的一个模型上耗尽时，
        # 别的模型还能用它，所以只有"每个模型都判死"的 key 才整体排除。
        with tempfile.TemporaryDirectory() as temp_dir:
            now = time.time()
            models = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]
            runmod.pkeyhealth.record(
                Path(temp_dir) / "shard-1.json", "k-half-dead", "quota",
                model=models[0], now=now)
            for index, model in enumerate(models):
                runmod.pkeyhealth.record(
                    Path(temp_dir) / f"shard-{2 + index}.json", "k-all-dead",
                    "quota", model=model, now=now)
            # 鉴权失败与模型无关：任何模型上都算死。
            runmod.pkeyhealth.record(
                Path(temp_dir) / "shard-9.json", "k-auth-dead", "auth",
                model=models[0], now=now)
            with patch.dict(
                "os.environ",
                {
                    "GEMINI_HEALTH_DIR": temp_dir,
                    "GEMINI_MODELS": ", ".join(models),
                    "GEMINI_EXCLUDE_KEYS": "",
                },
            ):
                runmod.publish_key_health({"shard": 0, "shards": 10})
                self.assertEqual(
                    set(os.environ["GEMINI_EXCLUDE_KEYS"].split(",")),
                    {
                        runmod.pkeyhealth.key_id("k-all-dead"),
                        runmod.pkeyhealth.key_id("k-auth-dead"),
                    },
                    "只在单个模型上耗尽的 key 不能被排除",
                )

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
