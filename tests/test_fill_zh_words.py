import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

MODULE = Path(__file__).parents[1] / "scripts" / "fill_zh_words.py"
SPEC = importlib.util.spec_from_file_location("fill_zh_words", MODULE)
fill = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fill)

segment = lambda text: list(text)


class EvenWordsTests(unittest.TestCase):
    def test_words_stay_inside_the_sentence_and_in_order(self):
        words = fill.even_words("伴侣最烦人。", 14.0, 16.0, lambda t: ["伴侣", "最", "烦人", "。"])
        self.assertEqual([w[0] for w in words], ["伴侣", "最", "烦人"], "标点不占时间")
        starts = [w[1] for w in words]
        self.assertEqual(starts, sorted(starts))
        last = words[-1]
        self.assertLessEqual(last[1] + last[2], 16000)
        self.assertGreaterEqual(words[0][1], 14000)

    def test_longer_words_get_more_time(self):
        words = fill.even_words("一二三四五六七八", 0.0, 4.0, lambda t: ["一二", "三四五六七八"])
        self.assertAlmostEqual(words[1][2], words[0][2] * 3)

    def test_punctuation_only_sentence_yields_nothing(self):
        self.assertEqual(fill.even_words("。", 0.0, 1.0, segment), [])


class FillDocumentTests(unittest.TestCase):
    def doc(self):
        return {
            "sentences": [
                {"start": 0.0, "end": 2.0, "en": "a", "zh": "甲乙", "zh_words": []},
                {"start": 2.0, "end": 4.0, "en": "b", "zh": "丙丁",
                 "zh_words": [["丙", 2000, 1000]]},
                {"start": 4.0, "end": 6.0, "en": "c", "zh": "", "zh_words": []},
            ]
        }

    def test_only_empty_zh_words_are_filled_and_marked(self):
        doc = self.doc()
        self.assertEqual(fill.fill_document(doc, segment), 1)
        first, second, third = doc["sentences"]
        self.assertEqual([w[0] for w in first["zh_words"]], ["甲", "乙"])
        self.assertEqual(first["zh_word_mode"], "even")
        self.assertEqual(second["zh_words"], [["丙", 2000, 1000]])
        self.assertNotIn("zh_word_mode", second)
        self.assertEqual(third["zh_words"], [])

    def test_second_pass_is_a_no_op(self):
        doc = self.doc()
        fill.fill_document(doc, segment)
        self.assertEqual(fill.fill_document(doc, segment), 0)


class IterationTests(unittest.TestCase):
    def test_state_and_hidden_files_are_skipped(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            data = Path(temp_dir)
            (data / "pod").mkdir()
            (data / ".key-health").mkdir()
            (data / "pod" / "state-0.json").write_text("{}", encoding="utf-8")
            (data / "pod" / "ep.json").write_text(json.dumps({"sentences": []}), encoding="utf-8")
            (data / ".key-health" / "shard-0.json").write_text("{}", encoding="utf-8")
            names = [p.name for p in fill.iter_documents(data)]
        self.assertEqual(names, ["ep.json"])


if __name__ == "__main__":
    unittest.main()
