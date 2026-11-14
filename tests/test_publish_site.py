import importlib.util
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location(
    "publish_site", ROOT / "scripts" / "publish_site.py"
)
ps = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ps)


class MergeStateTests(unittest.TestCase):
    def test_exported_episode_switches_to_json_and_vtt_only_stays(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            json_dir = Path(temp_dir)
            (json_dir / "pod").mkdir()
            (json_dir / "pod" / "Ep_One.json").write_text("{}", encoding="utf-8")
            state = {
                "podcasts": {
                    "pod": {
                        "transcripts": [
                            {"identity": "g1", "title": "One",
                             "path": "pod/transcripts/Ep_One.vtt"},
                            {"identity": "g2", "title": "Two",
                             "path": "pod/transcripts/Two.vtt"},
                        ]
                    }
                }
            }
            progress = {"podcasts": {}}
            changed = ps.merge_state_records(progress, state, "pod", json_dir)
            entries = progress["podcasts"]["pod"]["processed"]
            self.assertEqual(changed, 2)
            self.assertEqual(entries["g1"]["transcript_filename"], "Ep_One.json")
            self.assertEqual(entries["g1"]["transcript_type"], "application/json")
            self.assertTrue(entries["g1"]["url"].startswith(
                "https://raw.githubusercontent.com/lzoreal/MyTranscript/data/json/pod/"
            ))
            self.assertEqual(entries["g2"]["transcript_filename"], "Two.vtt")
            self.assertEqual(entries["g2"]["transcript_type"], "text/vtt")
            self.assertNotIn("url", entries["g2"])

    def test_existing_progress_entries_are_not_overwritten(self):
        state = {"podcasts": {"pod": {"transcripts": [
            {"identity": "g1", "title": "One", "path": "pod/transcripts/One.vtt"}
        ]}}}
        progress = {"podcasts": {"pod": {"processed": {
            "g1": {"transcript_filename": "Custom.json",
                   "transcript_type": "application/json", "url": "u"}
        }}}}
        changed = ps.merge_state_records(progress, state, "pod", Path("nope"))
        self.assertEqual(changed, 1)
        self.assertEqual(
            progress["podcasts"]["pod"]["processed"]["g1"]["transcript_filename"],
            "Custom.json",
        )


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
