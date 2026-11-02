import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location(
    "export_word_json", ROOT / "scripts" / "export_word_json.py"
)
cli = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cli)


class StemTests(unittest.TestCase):
    def test_stems_from_progress_use_existing_vtt_names(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "progress.json"
            path.write_text(
                json.dumps(
                    {
                        "podcasts": {
                            "pod": {
                                "processed": {
                                    "g1": {"vtt_filename": "Ep One.vtt"},
                                    "g2": {"skipped": True},
                                }
                            }
                        }
                    }
                ),
                encoding="utf-8",
            )
            self.assertEqual(cli.stems_from_progress(path, "pod"), {"g1": "Ep One"})

    def test_stems_from_state_use_record_paths(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "state.json"
            path.write_text(
                json.dumps(
                    {
                        "podcasts": {
                            "pod": {
                                "transcripts": [
                                    {"identity": "g1", "path": "pod/transcripts/Ep One.vtt"},
                                    {"identity": "g2"},
                                ]
                            }
                        }
                    }
                ),
                encoding="utf-8",
            )
            self.assertEqual(cli.stems_from_state(path, "pod"), {"g1": "Ep One"})


if __name__ == "__main__":
    unittest.main()
