import importlib.util
import json
import sys
from types import ModuleType
import unittest
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

    def test_incomplete_batch_retries_only_missing_cues(self):
        batches = []

        def translate(batch, _cache_meta):
            batches.append(batch)
            if len(batches) == 1:
                raise translator.IndexMismatchError(
                    "missing final cue", {0: "甲", 1: "乙"}
                )
            return {2: "丙"}

        blocks = [(0, "one"), (1, "two"), (2, "three")]
        with patch.object(translator, "gemini_batch_translate", side_effect=translate):
            result = translator.safe_translate_batch(blocks, {})

        self.assertEqual(result, {0: "甲", 1: "乙", 2: "丙"})
        self.assertEqual(batches, [blocks, [blocks[2]]])

    def test_timed_out_batch_is_split_before_more_retries(self):
        batches = []

        def translate(batch, _cache_meta):
            batches.append(batch)
            if len(batch) == 4:
                raise translator.BatchDeadlineExceeded("request timed out")
            return {index: f"译文 {index}" for index, _ in batch}

        blocks = [(0, "one"), (1, "two"), (2, "three"), (3, "four")]
        with patch.object(translator, "gemini_batch_translate", side_effect=translate):
            result = translator.safe_translate_batch(blocks, {})

        self.assertEqual(result, {0: "译文 0", 1: "译文 1", 2: "译文 2", 3: "译文 3"})
        self.assertEqual(batches, [blocks, blocks[:2], blocks[2:]])

    def test_detects_deadline_exceeded_error(self):
        self.assertTrue(translator.is_deadline_exceeded("504 DEADLINE_EXCEEDED"))
        self.assertFalse(translator.is_deadline_exceeded("429 RESOURCE_EXHAUSTED"))


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


if __name__ == "__main__":
    unittest.main()
