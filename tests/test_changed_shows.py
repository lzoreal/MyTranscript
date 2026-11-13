import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location(
    "changed_shows", ROOT / "scripts" / "changed_shows.py"
)
changed = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(changed)


class ShowDirsTests(unittest.TestCase):
    def test_maps_changed_files_to_show_directories(self):
        lines = [
            " M site/pod/feed.xml",
            " M json/pod/Ep One.json",
            "?? site/other/feed.xml",
            " M progress.json",
            " M scripts/publish_site.py",
        ]
        self.assertEqual(
            changed.show_dirs(lines),
            ["json/pod", "site/other", "site/pod"],
        )

    def test_empty_status_is_empty(self):
        self.assertEqual(changed.show_dirs([]), [])


if __name__ == "__main__":
    unittest.main()
