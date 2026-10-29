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


if __name__ == "__main__":
    unittest.main()
