import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location("seed_state", ROOT / "scripts" / "seed_state.py")
seed = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(seed)


class SeedTests(unittest.TestCase):
    def write_progress(self, path, processed):
        path.write_text(
            json.dumps({"podcasts": {"pod": {"processed": processed}}}), encoding="utf-8"
        )

    def test_seeds_only_published_episodes_into_their_own_shard(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            progress = root / "progress.json"
            self.write_progress(progress, {
                "g1": {"vtt_filename": "A.vtt"},
                "g2": {"vtt_filename": "B.vtt"},
                "g3": {"vtt_filename": None, "skipped": True},
            })
            counts = seed.seed(progress, "pod", root / "data", shards=4)
            total = sum(counts.values())
            shards = sorted(p.name for p in (root / "data" / "pod").glob("state*.json"))
            states = [json.loads((root / "data" / "pod" / name).read_text(encoding="utf-8"))
                      for name in shards]
        self.assertEqual(total, 2, "没有 vtt_filename 的集不种")
        seeded = {guid for state in states for guid in state["episodes"]}
        self.assertEqual(seeded, {"g1", "g2"})
        self.assertTrue(all(e.get("seeded") for s in states for e in s["episodes"].values()))

    def test_second_run_is_a_no_op_and_keeps_done_entries(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            progress = root / "progress.json"
            self.write_progress(progress, {"g1": {"vtt_filename": "A.vtt"}})
            seed.seed(progress, "pod", root / "data", shards=2)
            again = seed.seed(progress, "pod", root / "data", shards=2)
            self.assertEqual(sum(again.values()), 0)

    def test_existing_done_entry_is_left_alone(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            progress = root / "progress.json"
            self.write_progress(progress, {"g1": {"vtt_filename": "A.vtt"}})
            shard = seed.shard_of("g1", 2)
            path = root / "data" / "pod" / f"state-{shard}.json"
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({"episodes": {"g1": {"status": "done", "attempts": 0}}}),
                            encoding="utf-8")
            counts = seed.seed(progress, "pod", root / "data", shards=2)
            entry = json.loads(path.read_text(encoding="utf-8"))["episodes"]["g1"]
        self.assertEqual(sum(counts.values()), 0)
        self.assertNotIn("seeded", entry, "已有记录不被覆盖")


if __name__ == "__main__":
    unittest.main()
