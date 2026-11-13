import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location(
    "publish_site", ROOT / "scripts" / "publish_site.py"
)
ps = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ps)


class MergeProgressTests(unittest.TestCase):
    def test_merge_progress_records_json_transcript(self):
        progress = {"podcasts": {}}
        changed = ps.merge_progress(
            progress,
            "pod",
            [{"guid": "g1", "title": "T", "generated_at": "x"}],
            {"g1": "Ep_One"},
        )
        self.assertEqual(changed, 1)
        entry = progress["podcasts"]["pod"]["processed"]["g1"]
        self.assertEqual(entry["transcript_filename"], "Ep_One.json")
        self.assertEqual(entry["transcript_type"], "application/json")
        self.assertEqual(
            entry["url"],
            "https://raw.githubusercontent.com/lzoreal/MyTranscript/data"
            "/json/pod/Ep_One.json",
        )
        self.assertEqual(entry["path"], "json/pod/Ep_One.json")


if __name__ == "__main__":
    unittest.main()
