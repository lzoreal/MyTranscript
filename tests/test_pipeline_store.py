import importlib.util
import tempfile
import unittest
from pathlib import Path

MODULE = Path(__file__).parents[1] / "scripts" / "pipeline_store.py"
SPEC = importlib.util.spec_from_file_location("pipeline_store", MODULE)
pstore = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pstore)


class StoreTests(unittest.TestCase):
    def test_state_round_trips_atomically(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            data = Path(temp_dir)
            pstore.save_state(data, "pod", {"episodes": {"g1": {"status": "done", "attempts": 1}}})
            state = pstore.load_state(data, "pod")
        self.assertEqual(state["episodes"]["g1"]["status"], "done")

    def test_shard_suffixes_keep_states_apart(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            data = Path(temp_dir)
            pstore.save_state(data, "pod", {"episodes": {"a": {"status": "done"}}})
            pstore.save_state(data, "pod", {"episodes": {"b": {"status": "done"}}}, "-3")
            self.assertEqual(set(pstore.load_state(data, "pod")["episodes"]), {"a"})
            self.assertEqual(set(pstore.load_state(data, "pod", "-3")["episodes"]), {"b"})
            self.assertEqual(
                sorted(p.name for p in (data / "pod").glob("state*.json")),
                ["state-3.json", "state.json"],
            )

    def test_needs_work_rules(self):
        self.assertTrue(pstore.needs_work({"episodes": {}}, "g1"))
        self.assertFalse(pstore.needs_work({"episodes": {"g1": {"status": "done"}}}, "g1"))
        self.assertFalse(pstore.needs_work({"episodes": {"g1": {"status": "failed", "attempts": 2}}}, "g1"))
        self.assertTrue(pstore.needs_work({"episodes": {"g1": {"status": "failed", "attempts": 1}}}, "g1"))

    def test_episode_document_is_compact_and_complete(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "g1.json"
            pstore.write_episode(path, {"sentences": [{"en": "hi", "zh": "你好"}]})
            text = path.read_text(encoding="utf-8")
        self.assertNotIn(": ", text, "必须是紧凑 JSON")
        self.assertIn('"sentences"', text)


if __name__ == "__main__":
    unittest.main()
