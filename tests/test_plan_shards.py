import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location(
    "plan_shards", ROOT / "scripts" / "plan_shards.py"
)
plan = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(plan)


class EffectiveShardsTests(unittest.TestCase):
    def test_one_shard_per_pending_episode_up_to_twenty(self):
        self.assertEqual(plan.effective_shards(0), 1)
        self.assertEqual(plan.effective_shards(5), 5)
        self.assertEqual(plan.effective_shards(20), 20)
        self.assertEqual(plan.effective_shards(21), 20)
        self.assertEqual(plan.effective_shards(240), 20)

    def test_requested_cap_can_only_lower_the_shard_count(self):
        self.assertEqual(plan.effective_shards(240, cap=8), 8)
        self.assertEqual(plan.effective_shards(3, cap=8), 3)
        self.assertEqual(plan.effective_shards(3, cap=0), 3)
        self.assertEqual(plan.effective_shards(40, cap=99), 20)


class PendingTests(unittest.TestCase):
    def test_pending_excludes_done_and_exhausted_failures(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            show_dir = Path(temp_dir) / "pod"
            show_dir.mkdir(parents=True)
            (show_dir / "state-0.json").write_text(
                json.dumps(
                    {
                        "episodes": {
                            "a": {"status": "done"},
                            "b": {"status": "failed", "attempts": 3},
                            "c": {"status": "failed", "attempts": 1},
                        }
                    }
                ),
                encoding="utf-8",
            )
            episodes = lambda url: [  # noqa: E731
                {"guid": guid, "title": guid} for guid in ("a", "b", "c", "d")
            ]
            self.assertEqual(
                plan.pending_total(
                    [{"slug": "pod", "feed_url": "u"}],
                    Path(temp_dir),
                    list_episodes=episodes,
                ),
                2,
            )


if __name__ == "__main__":
    unittest.main()
