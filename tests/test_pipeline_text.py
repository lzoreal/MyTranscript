import contextlib
import importlib.util
import io
import sys
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

MODULE = ROOT / "scripts" / "pipeline_text.py"
SPEC = importlib.util.spec_from_file_location("pipeline_text", MODULE)
ptext = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ptext)


class TextSourceTests(unittest.TestCase):
    def test_asr_source_passes_words_through(self):
        cues = [{"start": 0.0, "end": 2.0, "en": "hi there",
                 "words": [{"w": "hi", "s": 0.0, "e": 1.0}, {"w": "there", "s": 1.0, "e": 2.0}]}]
        sentences = ptext.asr_sentences(cues)
        self.assertEqual(sentences[0]["en"], "hi there")
        self.assertEqual(len(sentences[0]["words"]), 2)
        self.assertEqual(sentences[0]["zh"], "")

    def test_external_text_maps_to_asr_words(self):
        blocks = [{"en": "hi there"}, {"en": "buy our sponsor now please"}]
        asr = [{"start": 0.0, "end": 2.0, "en": "hi there",
                "words": [{"w": "hi", "s": 0.0, "e": 1.0}, {"w": "there", "s": 1.0, "e": 2.0}]}]
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            sentences = ptext.map_external_text(blocks, asr, 2.0)
        printed = buffer.getvalue()
        self.assertEqual([s["en"] for s in sentences], ["hi there"], "广告块应被丢弃")
        self.assertEqual(sentences[0]["zh_words"], [])
        self.assertIn("丢弃 1 段", printed, "丢弃必须留一行可查的日志")

    def test_external_text_keeps_real_times(self):
        blocks = [{"en": "hello there friend"}]
        asr = [{"start": 10.0, "end": 11.5, "en": "hello there friend",
                "words": [{"w": "hello", "s": 10.0, "e": 10.5},
                          {"w": "there", "s": 10.5, "e": 11.0},
                          {"w": "friend", "s": 11.0, "e": 11.5}]}]
        sentences = ptext.map_external_text(blocks, asr, 20.0)
        self.assertAlmostEqual(sentences[0]["start"], 10.0)
        self.assertAlmostEqual(sentences[0]["end"], 11.5)


if __name__ == "__main__":
    unittest.main()
