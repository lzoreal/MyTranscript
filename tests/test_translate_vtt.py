import importlib.util
import json
import sys
import tempfile
from types import ModuleType
import os
import unittest
from unittest import mock
from unittest.mock import patch
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "translate_vtt.py"
google_module = ModuleType("google")
genai_module = ModuleType("google.genai")
genai_module.types = ModuleType("google.genai.types")
google_module.genai = genai_module
sys.modules.setdefault("google", google_module)
sys.modules.setdefault("google.genai", genai_module)
sys.modules.setdefault("google.genai.types", genai_module.types)
SPEC = importlib.util.spec_from_file_location("translate_vtt", MODULE_PATH)
translator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(translator)


class TranslationResponseTests(unittest.TestCase):
    def test_text_response_requires_each_index_once(self):
        result, valid, message = translator.parse_translation_response_text(
            "0|||第一行\n0|||重复行", {0}
        )

        self.assertEqual(result, {0: "第一行"})
        self.assertFalse(valid)
        self.assertIn("Duplicate", message)

    def test_json_response_rejects_duplicate_keys(self):
        result, valid, message = translator.parse_translation_response_json(
            '{"0": "第一行", "0": "重复行"}', {0}
        )

        self.assertEqual(result, {0: "第一行"})
        self.assertFalse(valid)
        self.assertIn("Duplicate", message)

    def test_json_response_requires_all_expected_indices(self):
        result, valid, message = translator.parse_translation_response_json(
            json.dumps({"0": "第一行"}), {0, 1}
        )

        self.assertEqual(result, {0: "第一行"})
        self.assertFalse(valid)
        self.assertIn("missing", message)

    def test_incomplete_batch_defers_missing_cues_for_episode_recovery(self):
        batches = []

        def translate(batch, _cache_meta):
            batches.append(batch)
            raise translator.IndexMismatchError(
                "missing final cue", {0: "甲", 1: "乙"}
            )

        blocks = [(0, "one"), (1, "two"), (2, "three")]
        with patch.object(translator, "gemini_batch_translate", side_effect=translate):
            result = translator.safe_translate_batch(blocks, {})

        self.assertEqual(result, {0: "甲", 1: "乙"})
        self.assertEqual(batches, [blocks])

    def test_detects_deadline_exceeded_error(self):
        self.assertTrue(translator.is_deadline_exceeded("504 DEADLINE_EXCEEDED"))
        self.assertFalse(translator.is_deadline_exceeded("429 RESOURCE_EXHAUSTED"))

    def test_deadline_cooldown_waits_without_splitting_batches(self):
        with patch.object(translator.time, "sleep") as sleep:
            translator.cooldown_after_deadline()

        sleep.assert_called_once_with(translator.DEADLINE_COOLDOWN_SECONDS)


class VttParsingTests(unittest.TestCase):
    def test_parse_cues_skips_metadata_and_preserves_identifier(self):
        content = """WEBVTT

NOTE metadata
ignored

first-cue
00:00.000 --> 00:01.000
Hello
there
"""

        self.assertEqual(
            translator.parse_vtt_cues(content),
            [{"identifier": "first-cue", "timestamp": "00:00.000 --> 00:01.000", "text": "Hello\nthere"}],
        )


def write_vtt(path, cues):
    lines = ["WEBVTT", ""]
    for index, (timestamp, text) in enumerate(cues, 1):
        lines.extend([str(index), timestamp, text, ""])
    path.write_text("\n".join(lines), encoding="utf-8")


class BilingualCueTests(unittest.TestCase):
    def test_multiline_original_with_translation_on_last_line(self):
        text = "First English line\nSecond English line\n中文译文"

        self.assertTrue(translator.is_bilingual_cue(text))
        self.assertEqual(
            translator.get_original_text(text), "First English line\nSecond English line"
        )
        self.assertEqual(translator.get_existing_translation(text), "中文译文")
        self.assertEqual(
            translator.prepare_gemini_text(text),
            "First English line Second English line",
        )

    def test_translate_episode_reuses_existing_bilingual_text_without_api(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "episode.vtt"
            target = Path(temp_dir) / "zh" / "episode.vtt"
            write_vtt(
                source,
                [
                    ("00:00:00.000 --> 00:00:01.000", "Hello\n你好"),
                    ("00:00:01.000 --> 00:00:02.000", "Goodbye\n再见"),
                ],
            )

            with patch.object(
                translator,
                "gemini_batch_translate",
                side_effect=AssertionError("API should not be called"),
            ):
                translator.translate_episode(source, target, {})

            output = target.read_text(encoding="utf-8")
            self.assertIn("Hello\n你好", output)
            self.assertIn("Goodbye\n再见", output)

    def test_existing_translation_keeps_speaker_tag(self):
        self.assertEqual(
            translator.restore_speaker_translation("<v Bob>Hello\n你好", "你好"),
            "<v Bob>你好",
        )

    def test_episode_recovery_retries_only_missing_cues(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "episode.vtt"
            target = Path(temp_dir) / "zh" / "episode.vtt"
            write_vtt(
                source,
                [
                    ("00:00:00.000 --> 00:00:01.000", "one"),
                    ("00:00:01.000 --> 00:00:02.000", "two"),
                    ("00:00:02.000 --> 00:00:03.000", "three"),
                ],
            )

            calls = []

            def translate(batch, _cache_meta):
                calls.append(batch)
                if len(calls) == 1:
                    raise translator.IndexMismatchError(
                        "missing final cue", {0: "甲", 1: "乙"}
                    )
                return {2: "丙"}

            with patch.object(
                translator, "gemini_batch_translate", side_effect=translate
            ):
                translator.translate_episode(source, target, {})

            self.assertEqual(
                calls,
                [
                    [(0, "one"), (1, "two"), (2, "three")],
                    [(2, "three")],
                ],
            )
            output = target.read_text(encoding="utf-8")
            self.assertIn("甲", output)
            self.assertIn("乙", output)
            self.assertIn("丙", output)


class KeyRingWiringTests(unittest.TestCase):
    def test_build_ring_prefers_the_multi_key_secret(self):
        with mock.patch.dict(
            os.environ, {"GEMINI_API_KEYS": "k1,k2", "GEMINI_API_KEY": "single"}
        ):
            ring = translator.build_ring()
        self.assertEqual(len(ring), 2)
        self.assertEqual(ring.current(), "k1")

    def test_build_ring_falls_back_to_single_key(self):
        with mock.patch.dict(os.environ, {"GEMINI_API_KEYS": "", "GEMINI_API_KEY": "single"}):
            ring = translator.build_ring()
        self.assertEqual(len(ring), 1)

    def test_build_ring_requires_a_key(self):
        with mock.patch.dict(os.environ, {"GEMINI_API_KEYS": "", "GEMINI_API_KEY": ""}):
            with self.assertRaises(RuntimeError):
                translator.build_ring()


if __name__ == "__main__":
    unittest.main()
