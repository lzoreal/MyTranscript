import importlib.util
import unittest
from pathlib import Path

MODULE = Path(__file__).parents[1] / "scripts" / "gemini_keys.py"
SPEC = importlib.util.spec_from_file_location("gemini_keys", MODULE)
keys_mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(keys_mod)


class ParseTests(unittest.TestCase):
    def test_splits_dedupes_and_ignores_blank(self):
        self.assertEqual(
            keys_mod.parse_gemini_keys("k1, k2\nk3 ,k1"), ["k1", "k2", "k3"]
        )
        self.assertEqual(keys_mod.parse_gemini_keys("   "), [])


class RingTests(unittest.TestCase):
    def test_rotates_and_caches_clients_per_key(self):
        made = []
        ring = keys_mod.GeminiKeyRing(
            ["key-aaaa", "key-bbbb"], factory=lambda k: made.append(k) or object()
        )
        self.assertEqual(ring.current(), "key-aaaa")
        self.assertIn("aaaa", ring.label())
        self.assertNotIn("key-aaaa", ring.label())
        ring.client()
        ring.client()
        self.assertEqual(made, ["key-aaaa"])
        self.assertTrue(ring.mark_exhausted())
        self.assertEqual(ring.current(), "key-bbbb")

    def test_exhausted_ring_is_unavailable(self):
        ring = keys_mod.GeminiKeyRing(["only"], factory=lambda k: object())
        self.assertFalse(ring.mark_exhausted())
        self.assertFalse(ring.available)
        self.assertEqual(ring.label(), "#-（…****）")
        with self.assertRaises(keys_mod.QuotaExhausted):
            ring.current()

    def test_empty_list_is_rejected(self):
        with self.assertRaises(keys_mod.QuotaExhausted):
            keys_mod.GeminiKeyRing([])


class PredicateTests(unittest.TestCase):
    class _Error(Exception):
        def __init__(self, message, code=None):
            super().__init__(message)
            self.code = code

    def test_quota_markers_from_both_scripts(self):
        for message in (
            "429 RESOURCE_EXHAUSTED",
            "exceeded your current quota",
            "quota limit reached",
        ):
            self.assertTrue(keys_mod.is_quota_error(self._Error(message)), message)
        self.assertFalse(keys_mod.is_quota_error(TimeoutError("network")))

    def test_auth_shapes(self):
        self.assertTrue(keys_mod.is_auth_error(self._Error("x", code=403)))
        self.assertTrue(
            keys_mod.is_auth_error(
                self._Error("400 INVALID_ARGUMENT: API key not valid. Please pass a valid API key.", 400)
            )
        )
        self.assertFalse(keys_mod.is_auth_error(TimeoutError("network")))


if __name__ == "__main__":
    unittest.main()
