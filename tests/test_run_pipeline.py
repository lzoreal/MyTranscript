import importlib.util
import unittest
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
