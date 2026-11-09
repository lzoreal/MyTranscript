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


class BatchedFlowTests(unittest.TestCase):
    """按集发请求会很慢（全局限速下 1520 集 ≈ 12 小时），必须跨集凑批。"""

    def make_show(self, temp_dir, docs):
        root = Path(temp_dir) / "pod"
        root.mkdir()
        for name, sentences in docs.items():
            (root / name).write_text(json.dumps(document(sentences)), encoding="utf-8")
        return Path(temp_dir)

    def test_collect_pulls_missing_sentences_across_episodes(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            data = self.make_show(temp_dir, {
                "a.json": [{"en": "Good line.", "zh": "好。"},
                            {"en": "Bad line.", "zh": "Bad line."}],
                "b.json": [{"en": "Also bad line.", "zh": "Also bad line."}],
            })
            entries = fix.collect_entries(data, "pod")
        self.assertEqual(len(entries), 2)
        self.assertEqual(sorted(path.name for path, _, _ in entries), ["a.json", "b.json"])

    def test_all_episodes_go_through_one_translate_call(self):
        entries = [
            (Path("a.json"), 1, {"en": "Bad.", "zh": "Bad."}),
            (Path("b.json"), 0, {"en": "Also bad.", "zh": "Also bad."}),
        ]
        calls = []

        def translate(cues):
            calls.append(len(cues))
            for cue in cues:
                cue["zh"] = "中文。"

        fixed = fix.translate_entries(entries, translate)
        self.assertEqual(calls, [2], "两集应该合成一次调用")
        self.assertEqual(fixed, 2)

    def test_write_back_updates_only_changed_sentences(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            data = self.make_show(temp_dir, {
                "a.json": [{"en": "Good.", "zh": "好。"}, {"en": "Bad.", "zh": "Bad."}],
            })
            path = data / "pod" / "a.json"
            entries = [(path, 1, {"en": "Bad.", "zh": "修好了。"})]
            changed = fix.write_back(entries)
            saved = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(changed, 1)
        self.assertEqual(saved["sentences"][0]["zh"], "好。")
        self.assertEqual(saved["sentences"][1]["zh"], "修好了。")

    def test_write_back_skips_still_english_entries(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            data = self.make_show(temp_dir, {"a.json": [{"en": "Bad.", "zh": "Bad."}]})
            path = data / "pod" / "a.json"
            self.assertEqual(fix.write_back([(path, 0, {"en": "Bad.", "zh": "Bad."})]), 0)

    def test_one_failing_batch_does_not_abort_the_show(self):
        entries = [(Path("a.json"), i, {"en": f"Line {i}.", "zh": f"Line {i}."}) for i in range(300)]
        calls = []

        def translate(cues):
            calls.append(len(cues))
            if len(calls) == 1:
                raise RuntimeError("单条字幕翻译最终失败")
            for cue in cues:
                cue["zh"] = "中文。"

        fixed = fix.translate_entries(entries, translate, chunk=150)
        self.assertEqual(calls, [150, 150], "应该分两批，而不是一次性整档失败")
        self.assertEqual(fixed, 150, "失败批之外的句子要保留")

    def test_quota_exhaustion_stops_cleanly(self):
        entries = [(Path("a.json"), i, {"en": f"Line {i}.", "zh": f"Line {i}."}) for i in range(300)]
        calls = []

        def translate(cues):
            calls.append(len(cues))
            raise fix.transcribe.QuotaExhausted("所有模型的所有 key 已用尽")

        self.assertEqual(fix.translate_entries(entries, translate, chunk=150), 0)
        self.assertEqual(len(calls), 1, "配额用尽后不该继续撞下一批")


if __name__ == "__main__":
    unittest.main()
