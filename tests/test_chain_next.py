import importlib.util
import unittest
from pathlib import Path

MODULE = Path(__file__).parents[1] / "scripts" / "chain_next.py"
SPEC = importlib.util.spec_from_file_location("chain_next", MODULE)
chain = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(chain)


class PendingTests(unittest.TestCase):
    def test_returns_feed_guids_that_are_not_done(self):
        self.assertEqual(
            chain.pending_guids(["a", "b", "c"], {"a"}), ["b", "c"]
        )

    def test_empty_when_everything_is_done(self):
        self.assertEqual(chain.pending_guids(["a"], {"a"}), [])


class ProgressTests(unittest.TestCase):
    def test_counts_only_entries_finished_after_the_run_started(self):
        states = [
            {
                "episodes": {
                    "old": {"status": "done", "updated_at": "2026-11-07T20:00:00+00:00"},
                    "new1": {"status": "done", "updated_at": "2026-11-08T05:10:00+00:00"},
                    "new2": {"status": "done", "updated_at": "2026-11-08T05:11:00+00:00"},
                    "failed": {"status": "failed", "updated_at": "2026-11-08T05:12:00+00:00"},
                }
            }
        ]
        self.assertEqual(chain.count_newly_done(states, "2026-11-08T05:05:10Z"), 2)

    def test_bad_timestamps_do_not_crash_the_chain(self):
        states = [{"episodes": {"g": {"status": "done", "updated_at": "not-a-date"}}}]
        self.assertEqual(chain.count_newly_done(states, "2026-11-08T05:05:10Z"), 0)


class DecisionTests(unittest.TestCase):
    def test_chains_only_when_work_remains_and_this_run_made_progress(self):
        self.assertTrue(chain.should_chain(pending=3, progressed=2))
        self.assertFalse(chain.should_chain(pending=3, progressed=0))
        self.assertFalse(chain.should_chain(pending=0, progressed=9))

    def test_payload_repeats_the_current_inputs(self):
        payload = chain.dispatch_payload(
            slug="hidden-brain", shards="20", max_minutes="230",
            gemini_model="", translate_batch="150")
        self.assertEqual(payload["ref"], "main")
        self.assertEqual(payload["inputs"]["only_slug"], "hidden-brain")
        self.assertEqual(payload["inputs"]["shards"], "20")
        self.assertEqual(payload["inputs"]["max_minutes"], "230")
        self.assertEqual(payload["inputs"]["gemini_model"], "")
        self.assertEqual(payload["inputs"]["translate_batch"], "150")


if __name__ == "__main__":
    unittest.main()
