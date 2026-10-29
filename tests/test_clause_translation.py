import importlib.util
import json
import unittest
from pathlib import Path

MODULE = Path(__file__).parents[1] / "scripts" / "clause_translation.py"
SPEC = importlib.util.spec_from_file_location("clause_translation", MODULE)
cmod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cmod)


class ContractTests(unittest.TestCase):
    def test_accepts_faithful_split(self):
        ok, _ = cmod.validate_clauses(
            "But psychologists who study complaining say there's a right way.",
            [{"en": "But psychologists who study complaining say", "zh": "但研究抱怨的心理学家说"},
             {"en": "there's a right way.", "zh": "有正确的方法。"}],
        )
        self.assertTrue(ok)

    def test_rejects_dropped_reordered_and_empty(self):
        self.assertFalse(cmod.validate_clauses("one two three", [{"en": "one three", "zh": "一三"}])[0])
        self.assertFalse(cmod.validate_clauses("one two three", [{"en": "two one three", "zh": "二一三"}])[0])
        self.assertFalse(cmod.validate_clauses("one two", [{"en": "", "zh": "空"}])[0])
        self.assertFalse(cmod.validate_clauses("one two", [{"en": "one two", "zh": "，坏"}])[0])

    def test_parse_joins_chinese_and_drops_invalid(self):
        raw = json.dumps({
            "1": {"clauses": [{"en": "hi", "zh": "你好"}, {"en": "there.", "zh": "那边。"}]},
            "2": {"clauses": [{"en": "wrong", "zh": "错"}]},
        })
        got = cmod.parse_clause_object(raw, {1: "hi there.", 2: "something else"})
        self.assertEqual(got[1]["zh"], "你好那边。")
        self.assertNotIn(2, got)


if __name__ == "__main__":
    unittest.main()
