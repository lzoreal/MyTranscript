import importlib.util
import unittest
from pathlib import Path

MODULE = Path(__file__).parents[1] / "scripts" / "zh_align.py"
SPEC = importlib.util.spec_from_file_location("zh_align", MODULE)
zh = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(zh)


class ClauseTests(unittest.TestCase):
    def test_counts_words_per_english_clause(self):
        tokens = ["habit,", "complaining", "can", "feel", "satisfying"]
        self.assertEqual(zh.en_clause_word_counts(tokens), [1, 4])

    def test_allocate_splits_span_by_word_count(self):
        spans = zh.allocate_spans([2, 2], 10.0, 14.0)
        self.assertAlmostEqual(spans[0][0], 10.0)
        self.assertAlmostEqual(spans[1][1], 14.0)
        self.assertAlmostEqual(spans[0][1], 12.0)

    def test_split_zh_clauses_on_punctuation(self):
        tokens = ["伴侣", "的", "习惯", "。", "抱怨", "让", "人", "满足", "。"]
        self.assertEqual(len(zh.split_zh_clauses(tokens)), 2)

    def test_distribute_clause_by_character_share(self):
        words = zh.distribute_clause(["伴侣", "最", "。"], 0.0, 3.0)
        self.assertEqual([w["w"] for w in words], ["伴侣", "最"])
        self.assertAlmostEqual(words[0]["d"], 2.0)
        self.assertAlmostEqual(words[-1]["e"], 3.0)

    def test_build_zh_words_covers_the_whole_sentence(self):
        clauses = [{"en": "a b", "zh": "甲乙。"}, {"en": "c", "zh": "丙。"}]
        tokens_of = {"甲乙。": ["甲", "乙", "。"], "丙。": ["丙", "。"]}.get
        words = zh.build_zh_words(clauses, 5.0, 8.0, tokens_of)
        self.assertEqual([w[0] for w in words], ["甲", "乙", "丙"])
        self.assertAlmostEqual(words[0][1], 5000)
        self.assertAlmostEqual((words[-1][1] + words[-1][2]) / 1000, 8.0)


if __name__ == "__main__":
    unittest.main()
