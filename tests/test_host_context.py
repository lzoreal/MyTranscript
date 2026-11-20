"""按贡献类型的上下文档案与 payload 版本。

真正的断言在 tests/host-context.test.mjs；这里只保证 CI 用统一入口跑 node。
"""
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
CASE = ROOT / "tests" / "host-context.test.mjs"


class HostContextTests(unittest.TestCase):
    def test_context_profiles(self):
        proc = subprocess.run(["node", str(CASE)], cwd=str(ROOT), capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("host context OK", proc.stdout)


if __name__ == "__main__":
    unittest.main()
