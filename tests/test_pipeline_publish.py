import importlib.util
import unittest
from pathlib import Path

MODULE = Path(__file__).parents[1] / "scripts" / "pipeline_publish.py"
SPEC = importlib.util.spec_from_file_location("pipeline_publish", MODULE)
ppublish = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ppublish)


class PublishTests(unittest.TestCase):
    def test_render_vtt_pairs_english_and_chinese(self):
        text = ppublish.render_vtt([
            {"start": 0.0, "end": 2.5, "en": "hi there", "zh": "你好 那边"},
        ])
        self.assertTrue(text.startswith("WEBVTT"))
        self.assertIn("00:00:00.000 --> 00:00:02.500", text)
        self.assertIn("hi there", text)
        self.assertIn("你好 那边", text)

    def test_render_vtt_requires_both_languages(self):
        with self.assertRaises(ValueError):
            ppublish.render_vtt([{"start": 0.0, "end": 1.0, "en": "hi", "zh": ""}])


if __name__ == "__main__":
    unittest.main()
