import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

MODULE = Path(__file__).parents[1] / "scripts" / "key_health.py"
SPEC = importlib.util.spec_from_file_location("key_health", MODULE)
kh = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(kh)


class KeyHealthTests(unittest.TestCase):
    def test_record_then_read_back_merges_shards(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            directory = Path(temp_dir)
            kh.record(directory / "shard-0.json", "key-a", "quota", now=1000.0)
            kh.record(directory / "shard-3.json", "key-b", "auth", now=1000.0)
            dead = kh.dead_ids(directory, now=1100.0)
        self.assertEqual(dead, {kh.key_id("key-a"), kh.key_id("key-b")})

    def test_quota_expires_in_half_an_hour_but_auth_lasts_a_day(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            directory = Path(temp_dir)
            kh.record(directory / "s0.json", "quota-key", "quota", now=0.0)
            kh.record(directory / "s1.json", "auth-key", "auth", now=0.0)
            later = kh.dead_ids(directory, now=kh.QUOTA_TTL + 1)
            self.assertEqual(later, {kh.key_id("auth-key")})
            tomorrow = kh.dead_ids(directory, now=kh.AUTH_TTL + 1)
        self.assertEqual(tomorrow, set())

    def test_quota_only_blocks_the_model_it_was_recorded_for(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            directory = Path(temp_dir)
            kh.record(directory / "s0.json", "key-a", "quota",
                      model="gemini-3.5-flash-lite", now=0.0)
            same = kh.dead_ids(directory, model="gemini-3.5-flash-lite", now=1.0)
            other = kh.dead_ids(directory, model="gemini-3.1-flash-lite", now=1.0)
        self.assertEqual(same, {kh.key_id("key-a")})
        self.assertEqual(other, set())

    def test_auth_blocks_the_key_for_every_model(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            directory = Path(temp_dir)
            kh.record(directory / "s0.json", "key-a", "auth",
                      model="gemini-3.5-flash-lite", now=0.0)
            dead = kh.dead_ids(directory, model="gemini-3.1-flash-lite", now=1.0)
        self.assertEqual(dead, {kh.key_id("key-a")})

    def test_corrupt_file_is_ignored(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            directory = Path(temp_dir)
            (directory / "broken.json").write_text("{not json", encoding="utf-8")
            kh.record(directory / "s0.json", "key-a", "quota", now=0.0)
            self.assertEqual(kh.dead_ids(directory, now=1.0), {kh.key_id("key-a")})

    def test_usable_keys_filters_and_keeps_order(self):
        dead = {kh.key_id("b")}
        self.assertEqual(kh.usable_keys(["a", "b", "c"], dead), ["a", "c"])

    def test_state_file_never_contains_the_key_itself(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "shard-0.json"
            kh.record(path, "AIzaSySECRET-1234", "quota", now=5.0)
            self.assertNotIn("AIzaSySECRET-1234", path.read_text(encoding="utf-8"))
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")) and True, True)


if __name__ == "__main__":
    unittest.main()
