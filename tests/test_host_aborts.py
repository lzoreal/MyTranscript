"""AbortSignal 取消链路：请求代次、任务结算、诊断不误报。

真正的断言在 tests/host-aborts.test.mjs；这里只保证 CI 用统一入口跑 node。
"""
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
CASE = ROOT / "tests" / "host-aborts.test.mjs"


class HostAbortTests(unittest.TestCase):
    def test_abort_signals(self):
        proc = subprocess.run(["node", str(CASE)], cwd=str(ROOT), capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("host aborts OK", proc.stdout)


if __name__ == "__main__":
    unittest.main()
