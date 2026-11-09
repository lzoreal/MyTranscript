import importlib.util
import os
import unittest
from pathlib import Path
from unittest import mock

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

    def test_rotates_through_every_model_before_giving_up(self):
        # 日额度按 (key, model) 计：一个模型的 key 全耗尽只是少了一份额度，
        # 必须继续换下一个模型；轮换表上所有模型的所有 key 都用完才算耗尽。
        ring = keys_mod.GeminiKeyRing(
            ["key-aaaa", "key-bbbb"],
            factory=lambda k: object(),
            models=["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"],
        )
        seen = []
        while ring.available:
            seen.append((ring.current_model(), ring.current()))
            ring.mark_exhausted()
        self.assertEqual(
            seen,
            [
                ("gemini-3.5-flash-lite", "key-aaaa"),
                ("gemini-3.5-flash-lite", "key-bbbb"),
                ("gemini-3.1-flash-lite", "key-aaaa"),
                ("gemini-3.1-flash-lite", "key-bbbb"),
            ],
        )

    def test_label_shows_the_current_model(self):
        ring = keys_mod.GeminiKeyRing(
            ["key-aaaa"], factory=lambda k: object(), models=["m-one", "m-two"]
        )
        ring.mark_exhausted()
        self.assertEqual(ring.current_model(), "m-two")
        self.assertIn("m-two", ring.label(), "换模型的日志要能看出现在用哪个模型")
        self.assertNotIn("key-aaaa", ring.label(), "标签不能泄露完整 key")

    def test_start_offset_spreads_shards_over_models(self):
        # 各分片从不同槽位起跑：2 模型 × 2 key 时，第 4 片落在第二个模型上。
        ring = keys_mod.GeminiKeyRing(
            ["k1", "k2"], factory=lambda k: object(), models=["m1", "m2"], start=3
        )
        self.assertEqual((ring.current_model(), ring.current()), ("m2", "k2"))

    def test_single_model_keeps_the_old_shape(self):
        ring = keys_mod.GeminiKeyRing(["k1", "k2"], factory=lambda k: object())
        self.assertEqual(len(ring), 2)
        self.assertIsNone(ring.current_model())
        self.assertEqual(ring.label(), "#1（…****）")


class ModelListTests(unittest.TestCase):
    def test_rotation_list_from_env_dedupes_and_keeps_order(self):
        with mock.patch.dict(
            os.environ, {"GEMINI_MODELS": "m2, m1\nm2", "GEMINI_MODEL": "m0"}
        ):
            self.assertEqual(keys_mod.gemini_models(), ["m2", "m1"])

    def test_falls_back_to_the_single_model_variable(self):
        with mock.patch.dict(os.environ, {"GEMINI_MODELS": "", "GEMINI_MODEL": "m0"}):
            self.assertEqual(keys_mod.gemini_models(), ["m0"])

    def test_unconfigured_falls_back_to_the_default_model(self):
        with mock.patch.dict(os.environ, {"GEMINI_MODELS": "", "GEMINI_MODEL": ""}):
            self.assertEqual(keys_mod.gemini_models(), [keys_mod.DEFAULT_MODEL])


class ClientFactoryTests(unittest.TestCase):
    def test_default_client_sets_request_timeout(self):
        import sys
        import types as pytypes
        from unittest import mock

        captured = {}
        fake_genai = pytypes.ModuleType("google.genai")

        class HttpOptions:
            def __init__(self, **kwargs):
                self.kwargs = kwargs

        fake_genai.types = pytypes.SimpleNamespace(HttpOptions=HttpOptions)
        fake_genai.Client = lambda **kwargs: captured.update(kwargs) or object()
        fake_pkg = pytypes.ModuleType("google")
        fake_pkg.genai = fake_genai

        with mock.patch.dict(
            sys.modules, {"google": fake_pkg, "google.genai": fake_genai}
        ):
            keys_mod._default_factory("key-aaaa")

        self.assertEqual(captured.get("api_key"), "key-aaaa")
        timeout = captured.get("http_options").kwargs.get("timeout")
        self.assertGreater(timeout, 0)


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


class DeadBucketTests(unittest.TestCase):
    """同一个 job 里反复新建环时，已判死的 (模型, key) 桶必须直接跳过。"""

    def test_ring_skips_buckets_marked_dead(self):
        ring = keys_mod.GeminiKeyRing(
            ["k1", "k2"], models=["m1", "m2"], dead={"m1": {"k1"}, "m2": {"k2"}}
        )
        self.assertEqual(len(ring), 2)
        self.assertEqual((ring.current_model(), ring.current()), ("m1", "k2"))
        ring.mark_exhausted()
        self.assertEqual((ring.current_model(), ring.current()), ("m2", "k1"))

    def test_every_bucket_dead_is_unavailable(self):
        ring = keys_mod.GeminiKeyRing(["k1"], models=["m1"], dead={"m1": {"k1"}})
        self.assertFalse(ring.available)
        with self.assertRaises(keys_mod.QuotaExhausted):
            ring.current()


if __name__ == "__main__":
    unittest.main()
