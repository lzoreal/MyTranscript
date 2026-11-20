#!/usr/bin/env python3
"""把 src/player-js/*.js 复制成站点 ES module 产物。

产物：
  site/player.js        ← 入口，仅 `import './player/player.js'`
  site/player/*.js      ← 每个源分片一份，跨分片依赖是显式 import/export

页面用 <script type="module" src="player.js"> 加载。源码目录本身就是模块图：
kernel / runtime / 各层功能模块，不再靠拼接顺序共享一个大 IIFE。

修改分片后跑一次本脚本；`--check` 只校验是否同步（测试里用）。
"""
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PARTS = ROOT / "src" / "player-js"
OUT = ROOT / "site" / "player.js"
OUT_DIR = ROOT / "site" / "player"
ENTRY_IMPORT = "import './player/player.js';\n"


def read(path: Path) -> str:
    with open(path, encoding="utf-8", newline="") as handle:
        return handle.read()


def write(path: Path, text: str) -> None:
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(text)


def sources() -> list[Path]:
    return sorted(PARTS.rglob("*.js"))


def build() -> dict[Path, str]:
    files = sources()
    if not files:
        raise SystemExit(f"没有分片：{PARTS}")
    entry = (PARTS / "player.js").read_text(encoding="utf-8")
    if "initPlayer();" not in entry:
        raise SystemExit("src/player-js/player.js 缺少 initPlayer() 启动调用")
    result = {OUT: ENTRY_IMPORT}
    for part in files:
        result[OUT_DIR / part.relative_to(PARTS)] = read(part)
    return result


def main() -> int:
    result = build()
    if "--check" in sys.argv:
        problems = []
        for path, text in result.items():
            if not path.is_file() or read(path) != text:
                problems.append(str(path.relative_to(ROOT)))
        if problems:
            print("产物与 src/player-js 不一致：" + "、".join(problems) +
                  "；跑 python scripts/build_player_js.py")
            return 1
        print(f"site/player.js 与 {len(result) - 1} 个模块产物一致")
        return 0

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    wanted = {path.relative_to(OUT_DIR) for path in result if path != OUT}
    stale = {path.relative_to(OUT_DIR) for path in OUT_DIR.rglob("*.js")} - wanted
    for name in stale:
        (OUT_DIR / name).unlink()
    changed = 0
    for path, text in result.items():
        if path.is_file() and read(path) == text:
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        write(path, text)
        changed += 1
    legacy = ROOT / "site" / "player-kernel.js"
    if legacy.is_file():
        legacy.unlink()
    print(f"已重建 site/player.js 与 site/player/（{len(result) - 1} 个模块，{changed} 个文件有变化）")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
