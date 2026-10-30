import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
fw = types.ModuleType("faster_whisper")
fw.WhisperModel = object
sys.modules.setdefault("faster_whisper", fw)
for name in ("google", "google.genai", "google.genai.types"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["google"].genai = sys.modules["google.genai"]
sys.modules["google"].genai.types = sys.modules["google.genai.types"]
for attr in ("Client", "GenerateContentConfig"):
    if not hasattr(sys.modules["google"].genai, attr):
        setattr(sys.modules["google"].genai, attr, object)
sys.modules.setdefault("feedparser", types.ModuleType("feedparser"))

spec = importlib.util.spec_from_file_location("pipeline_episode", ROOT / "scripts" / "pipeline_episode.py")
pepisode = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pepisode)
pstore = pepisode.store


class EpisodeTests(unittest.TestCase):
    def deps(self, cues):
        def translate(sentences):
            for sentence in sentences:
                sentence["zh"] = "译：" + sentence["en"]
                sentence["clauses"] = [{"en": sentence["en"], "zh": "译：" + sentence["en"]}]
                sentence["coarse"] = False

        return {
            "download": lambda url, path: path.write_bytes(b"x"),
            "asr": lambda path: (cues, 3.0),
            "translate": translate,
            "text": lambda show, episode: [],
            "segment": lambda text: list(text),
            "encode": lambda texts: [[1.0, 0.0] for _ in texts],
        }

    def test_writes_document_and_marks_done(self):
        cues = [{"start": 0.0, "end": 3.0, "en": "hi there",
                 "words": [{"w": "hi", "s": 0.0, "e": 1.5}, {"w": "there", "s": 1.5, "e": 3.0}]}]
        with tempfile.TemporaryDirectory() as temp_dir:
            data = Path(temp_dir)
            status = pepisode.process_episode(
                {"slug": "pod", "text_source": "asr"},
                {"guid": "g1", "title": "Ep", "audio_url": "u"},
                self.deps(cues), data, now=lambda: "2026-10-30T00:00:00Z",
            )
            doc = json.loads(pstore.episode_path(data, "pod", "g1").read_text(encoding="utf-8"))
            state = pstore.load_state(data, "pod")
        self.assertEqual(status, "done")
        self.assertEqual(state["episodes"]["g1"]["status"], "done")
        self.assertEqual(doc["sentences"][0]["zh"], "译：hi there")
        self.assertIn("zh_words", doc["sentences"][0])

    def test_translation_failure_marks_failed_and_retries(self):
        cues = [{"start": 0.0, "end": 1.0, "en": "hi", "words": [{"w": "hi", "s": 0.0, "e": 1.0}]}]
        deps = self.deps(cues)
        deps["translate"] = lambda sentences: (_ for _ in ()).throw(RuntimeError("quota"))
        with tempfile.TemporaryDirectory() as temp_dir:
            data = Path(temp_dir)
            status = pepisode.process_episode(
                {"slug": "pod", "text_source": "asr"},
                {"guid": "g1", "title": "Ep", "audio_url": "u"},
                deps, data,
            )
            state = pstore.load_state(data, "pod")
        self.assertEqual(status, "failed")
        self.assertEqual(state["episodes"]["g1"]["attempts"], 1)
        self.assertTrue(pstore.needs_work(state, "g1"))

    def test_sentences_without_clauses_still_get_zh_words(self):
        # 线上事故：翻译器不返回 clauses，旧代码直接写空数组，1254 句全没有中文词时间。
        cues = [{"start": 0.0, "end": 2.0, "en": "a b",
                 "words": [{"w": "a", "s": 0.0, "e": 1.0}, {"w": "b", "s": 1.0, "e": 2.0}]}]
        deps = self.deps(cues)

        def translate(sentences):
            for sentence in sentences:
                sentence["zh"] = "甲乙。"

        deps["translate"] = translate
        with tempfile.TemporaryDirectory() as temp_dir:
            data = Path(temp_dir)
            status = pepisode.process_episode(
                {"slug": "pod", "text_source": "asr"},
                {"guid": "g1", "title": "Ep", "audio_url": "u"},
                deps, data,
            )
            doc = json.loads(pstore.episode_path(data, "pod", "g1").read_text(encoding="utf-8"))
        self.assertEqual(status, "done")
        self.assertTrue(doc["sentences"][0]["zh_words"], "没有 clauses 也要走 DTW 兜底")

    def test_gated_sentence_falls_back_to_even_timing(self):
        # 英中分句数差太大时 DTW 门控会拒绝；这一句仍需词级时间，标 even 供消费方降级。
        # 英文每个词都自带逗号 → 8 个小句；中文只有 2 个 → 门控必然拒绝。
        cues = [{"start": 0.0, "end": 4.0, "en": "a, b, c, d, e, f, g, h,",
                 "words": [{"w": w + ",", "s": i * 0.5, "e": i * 0.5 + 0.5}
                           for i, w in enumerate("abcdefgh")]}]
        deps = self.deps(cues)

        def translate(sentences):
            for sentence in sentences:
                sentence["zh"] = "甲，乙。"

        deps["translate"] = translate
        with tempfile.TemporaryDirectory() as temp_dir:
            data = Path(temp_dir)
            status = pepisode.process_episode(
                {"slug": "pod", "text_source": "asr"},
                {"guid": "g1", "title": "Ep", "audio_url": "u"},
                deps, data,
            )
            doc = json.loads(pstore.episode_path(data, "pod", "g1").read_text(encoding="utf-8"))
        sentence = doc["sentences"][0]
        self.assertEqual(status, "done")
        self.assertTrue(sentence["zh_words"], "门控放弃后必须均分兜底")
        self.assertEqual(sentence["zh_word_mode"], "even")

    def test_quota_pause_is_not_counted_as_an_attempt(self):
        cues = [{"start": 0.0, "end": 1.0, "en": "hi", "words": [{"w": "hi", "s": 0.0, "e": 1.0}]}]
        deps = self.deps(cues)
        deps["translate"] = lambda sentences: (_ for _ in ()).throw(
            pepisode.QuotaExhausted("all keys spent")
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            data = Path(temp_dir)
            with self.assertRaises(pepisode.QuotaExhausted):
                pepisode.process_episode(
                    {"slug": "pod", "text_source": "asr"},
                    {"guid": "g1", "title": "Ep", "audio_url": "u"},
                    deps, data,
                )
            state = pstore.load_state(data, "pod")
        self.assertNotIn("g1", state["episodes"], "配额暂停不能记账")

    def test_done_episode_is_skipped(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            data = Path(temp_dir)
            pstore.save_state(data, "pod", {"episodes": {"g1": {"status": "done", "attempts": 1}}})
            status = pepisode.process_episode(
                {"slug": "pod", "text_source": "asr"},
                {"guid": "g1", "title": "Ep", "audio_url": "u"},
                self.deps([]), data,
            )
        self.assertEqual(status, "skipped")


if __name__ == "__main__":
    unittest.main()
