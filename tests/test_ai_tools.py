"""预生成 / 术语质检两个脚本的单元测试：不联网，只测纯函数与 feed 解析。"""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import ai_pregen  # noqa: E402
import qa_terms  # noqa: E402


class PregenChunkTests(unittest.TestCase):
    def test_clock_seconds(self):
        self.assertEqual(ai_pregen.clock_seconds("12:34"), 754)
        self.assertEqual(ai_pregen.clock_seconds("1:02:03"), 3723)
        self.assertEqual(ai_pregen.clock_seconds(42), 42)
        self.assertIsNone(ai_pregen.clock_seconds(""))

    def test_build_chunks_keeps_timestamps(self):
        segs = [{"start": i * 10, "text": f"line {i}"} for i in range(9)]
        chunks = ai_pregen.build_chunks(segs, parts=3)
        self.assertEqual(len(chunks), 3)
        self.assertTrue(chunks[0].startswith("[0:00] line 0"))
        self.assertTrue(chunks[1].startswith("[0:30] line 3"))
        self.assertTrue(chunks[2].startswith("[1:00] line 6"))

    def test_build_chunks_empty(self):
        self.assertEqual(ai_pregen.build_chunks([]), [])


class PregenMergeTests(unittest.TestCase):
    def test_merge_dedupes_and_sorts(self):
        parts = [
            {
                "summary": "第一段",
                "topics": [
                    {"title": "开场", "start": "5:00", "summary": "a"},
                    {"title": "重播", "start": "5:00", "summary": "dup"},
                ],
                "ads": [{"start": "1:00", "end": "2:00", "label": "赞助口播"}],
                "keyPoints": ["p1"],
                "vocabulary": [{"word": "Himym"}],
                "hardSentences": [{"en": "A b c."}],
                "questions": ["q?"],
            },
            {
                "summary": "第二段",
                "topics": [{"title": "回忆", "start": "1:00", "summary": "b"}],
                "ads": [{"start": "1:00", "end": "3:00", "label": "重复"}],
                "keyPoints": ["p1", "p2"],
                "vocabulary": [{"word": "himym"}, {"word": "Mosby"}],
                "hardSentences": [{"en": "a b c."}],
                "questions": ["q?"],
            },
        ]
        data = ai_pregen.merge_parts(parts)
        self.assertEqual([t["title"] for t in data["topics"]], ["回忆", "开场", "重播"])
        self.assertEqual(len(data["topics"]), 3)
        self.assertEqual(len(data["ads"]), 2)
        self.assertEqual(data["ads"][0]["start"], 60)
        self.assertEqual(data["keyPoints"], ["p1", "p2"])
        self.assertEqual([v["word"] for v in data["vocabulary"]], ["Himym", "Mosby"])
        self.assertEqual(len(data["hardSentences"]), 1)
        self.assertEqual(data["questions"], ["q?"])

    def test_merge_caps(self):
        parts = [
            {
                "topics": [{"title": f"t{i}", "start": i * 60} for i in range(40)],
                "vocabulary": [{"word": f"w{i}"} for i in range(40)],
                "hardSentences": [{"en": f"s{i}"} for i in range(30)],
            }
        ]
        data = ai_pregen.merge_parts(parts)
        self.assertLessEqual(len(data["topics"]), ai_pregen.MAX_TOPICS)
        self.assertLessEqual(len(data["vocabulary"]), ai_pregen.MAX_VOCAB)
        self.assertLessEqual(len(data["hardSentences"]), ai_pregen.MAX_HARD)


class FeedEpisodeTests(unittest.TestCase):
    def test_feed_lists_all_episodes(self):
        episodes = ai_pregen.episodes_from_feed("how-we-made-your-mother")
        if not episodes:
            self.skipTest("本地没有该节目的 feed.xml")
        self.assertGreater(len(episodes), 100)
        first = episodes[0]
        self.assertTrue(first["title"])
        self.assertTrue(first["transcript"]["url"].endswith(".json"))


class QaTokenTests(unittest.TestCase):
    def test_norm_name_strips_possessive(self):
        self.assertEqual(qa_terms.norm_name("Thomas'"), "thomas")
        self.assertEqual(qa_terms.norm_name("Bays"), "bays")
        self.assertEqual(qa_terms.norm_name("Mosby"), "mosby")

    def test_month_and_day_are_skipped(self):
        self.assertEqual(qa_terms.reasons_for("November", 3, set(), set(), [{"initial": False}]), [])
        self.assertEqual(qa_terms.reasons_for("Monday", 2, set(), set(), [{"initial": False}]), [])

    def test_sentence_initial_capital_is_skipped(self):
        samples = [{"initial": True}, {"initial": True}]
        self.assertEqual(qa_terms.reasons_for("Could", 2, set(), set(), samples), [])

    def test_internal_capital_flagged(self):
        reasons = qa_terms.reasons_for("McLaren's", 1, set(), set(), [{"initial": False}])
        self.assertIn("大小写异常（不像正常专名）", reasons)

    def test_low_frequency_proper_noun_flagged(self):
        reasons = qa_terms.reasons_for("Himyam", 3, set(), set(), [{"initial": False}])
        self.assertIn("低频专名，词表里没有", reasons)

    def test_known_proper_noun_not_flagged(self):
        reasons = qa_terms.reasons_for("Mosby", 3, {"mosby"}, {"mosby"}, [{"initial": False}])
        self.assertEqual(reasons, [])


if __name__ == "__main__":
    unittest.main()
