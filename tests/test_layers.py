"""守护层边界：kernel 纯净 + 跨分片无重名函数。"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import check_layers  # noqa: E402


class LayerBoundaryTest(unittest.TestCase):
    def test_layers_clean(self):
        self.assertEqual(check_layers.main(), 0, "层边界自检失败，见上方输出")


if __name__ == "__main__":
    unittest.main()
