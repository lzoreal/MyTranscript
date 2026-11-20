#!/usr/bin/env python3
"""把 src/player-js/*.js 按文件名顺序拼成 site/player.js。

站点运行时仍然零构建：Pages 发布的是提交进仓库的 site/player.js 成品。
修改分片后跑一次本脚本；`--check` 只校验是否同步（测试里用）。
拼接是纯字符连接，不插入任何分隔符，因此结果必须与拆分前逐字节一致。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PARTS = ROOT / "src" / "player-js"
OUT = ROOT / "site" / "player.js"


def read(path: Path) -> str:
    with open(path, encoding="utf-8", newline="") as handle:
        return handle.read()


def build() -> str:
    parts = sorted(PARTS.glob("*.js"))
    if not parts:
        raise SystemExit(f"没有分片：{PARTS}")
    return "".join(read(part) for part in parts)


def main() -> int:
    text = build()
    current = read(OUT) if OUT.is_file() else None

    if "--check" in sys.argv:
        if current != text:
            print("site/player.js 与 src/player-js 不一致："
                  "跑 python scripts/build_player_js.py")
            return 1
        print("site/player.js 与分片一致")
        return 0

    if current == text:
        print("site/player.js 未变化")
        return 0

    os_chars = len(text)
    with open(OUT, "w", encoding="utf-8", newline="") as handle:
        handle.write(text)
    print(f"已重建 site/player.js（{os_chars} 字符）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
