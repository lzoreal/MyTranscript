import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

# transcribe 需要这些名字，导入阶段不真正加载重依赖。
sys.modules.setdefault("faster_whisper", types.SimpleNamespace(WhisperModel=object))
google = sys.modules.setdefault("google", types.ModuleType("google"))
genai = sys.modules.setdefault("google.genai", types.ModuleType("google.genai"))
genai_types = sys.modules.setdefault(
    "google.genai.types", types.ModuleType("google.genai.types"))
genai.Client = object
genai.types = genai_types
google.genai = genai
if not hasattr(genai_types, "GenerateContentConfig"):
    genai_types.GenerateContentConfig = lambda **kwargs: kwargs

SCRIPTS = Path(__file__).parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
MODULE = SCRIPTS / "fix_zh.py"
SPEC = importlib.util.spec_from_file_location("fix_zh", MODULE)
fix = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fix)


def document(sentences):
    return {"version": 2, "slug": "pod", "guid": "g1", "sentences": sentences}


class MissingIndexTests(unittest.TestCase):
    def test_only_sentences_without_chinese_are_selected(self):
        doc = document([
            {"en": "Good line.", "zh": "好句子。"},
            {"en": "Echoed line.", "zh": "Echoed line."},       # 模型回英文原文
            {"en": "Empty line.", "zh": ""},
            {"en": "example.com", "zh": "example.com"},          # 链接照抄，不算缺
        ])
        self.assertEqual(fix.missing_indices(doc), [1, 2])


class ApplyTests(unittest.TestCase):
    def test_only_missing_sentences_are_rewritten(self):
        doc = document([
            {"en": "Keep me.", "zh": "保留我。", "zh_words": [["保留", 0, 100]]},
            {"en": "Fix me.", "zh": "Fix me."},
        ])
        calls = []

        def translate(cues):
            calls.append([cue["en"] for cue in cues])
            for cue in cues:
                cue["zh"] = "修好了。"

        fixed = fix.apply_translations(doc, translate)
        self.assertEqual(fixed, 1)
        self.assertEqual(calls, [["Fix me."]])
        self.assertEqual(doc["sentences"][0]["zh"], "保留我。")
        self.assertEqual(doc["sentences"][0]["zh_words"], [["保留", 0, 100]])
        self.assertEqual(doc["sentences"][1]["zh"], "修好了。")

    def test_stubborn_english_reply_is_left_alone(self):
        doc = document([{"en": "Stubborn.", "zh": "Stubborn."}])

        def translate(cues):
            pass

        self.assertEqual(fix.apply_translations(doc, translate), 0)
        self.assertEqual(doc["sentences"][0]["zh"], "Stubborn.")

    def test_zh_words_are_rebuilt_when_helpers_are_given(self):
        doc = document([{"en": "Fix me.", "zh": "Fix me.", "start": 0.0, "end": 1.0,
                         "words": [{"w": "Fix", "s": 0.0, "e": 0.4}]}])

        def translate(cues):
            for cue in cues:
                cue["zh"] = "修好。"

        def segment(text):
            return ["修好"]

        def encode(texts):
            return [[1.0] for _ in texts]

        with patch.object(fix.zh_align, "fallback_zh_words", return_value=[["修好", 0, 800]]):
            fix.apply_translations(doc, translate, segment, encode)
        self.assertEqual(doc["sentences"][0]["zh_words"], [["修好", 0, 800]])
        self.assertNotIn("zh_word_mode", doc["sentences"][0])

    def test_even_timing_marks_the_sentence(self):
        doc = document([{"en": "Fix me.", "zh": "Fix me.", "start": 0.0, "end": 1.0}])

        def translate(cues):
            for cue in cues:
                cue["zh"] = "修好。"

        with patch.object(fix.zh_align, "fallback_zh_words", return_value=[]), patch.object(
            fix.zh_align, "evenly_timed_words", return_value=[["修好", 0, 800]]
        ):
            fix.apply_translations(doc, translate, lambda t: ["修好"], lambda t: [[1.0]])
        self.assertEqual(doc["sentences"][0]["zh_word_mode"], "even")


class ScanTests(unittest.TestCase):
    def test_iter_documents_skips_state_and_plan(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            show = root / "pod"
            show.mkdir()
            (show / "g1.json").write_text(json.dumps(document([])), encoding="utf-8")
            (show / "state-0.json").write_text("{}", encoding="utf-8")
            (show / "plan-0.json").write_text("{}", encoding="utf-8")
            names = [path.name for _, path, _ in fix.iter_documents(root, "pod")]
        self.assertEqual(names, ["g1.json"])


if __name__ == "__main__":
    unittest.main()
