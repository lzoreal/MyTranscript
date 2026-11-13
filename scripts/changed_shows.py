"""发布后列出被改动的节目目录（`site/<slug>`、`json/<slug>`），供增量提交。

只输出空格安全的节目目录，不输出具体文件——文件名里可能有空格。
"""

from __future__ import annotations

import subprocess
import sys


def show_dirs(lines) -> list[str]:
    dirs: set[str] = set()
    for line in lines:
        if len(line) < 4 or line[2] != " ":
            continue
        path = line[3:].strip()
        if not path:
            continue
        parts = path.split("/")
        if len(parts) >= 2 and parts[0] in ("site", "json"):
            dirs.add(f"{parts[0]}/{parts[1]}")
    return sorted(dirs)


def main() -> int:
    result = subprocess.run(
        ["git", "status", "--porcelain", "-z", "--", "site", "json"],
        capture_output=True,
        check=True,
    )
    lines = result.stdout.decode("utf-8", "replace").split("\0")
    for directory in show_dirs(lines):
        print(directory)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
