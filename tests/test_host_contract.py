"""宿主 v2 公共契约与测试宿主的行为测试。

真正的断言在 tests/host-contract.test.mjs；这里只保证 CI 用统一入口跑 node。
"""
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
CASE = ROOT / "tests" / "host-contract.test.mjs"


class HostContractTests(unittest.TestCase):
    def test_contract_and_test_host(self):
        proc = subprocess.run(
            ["node", str(CASE)],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("host contract OK", proc.stdout)


if __name__ == "__main__":
    unittest.main()
