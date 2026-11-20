#!/usr/bin/env python3
"""把 src/player-js/*.js 拼成站点运行时产物。

从 2026-11-20 起产物是 **ES module**：
  site/player-kernel.js  ← 00-kernel.js 改成 `export const MYTK = …`
  site/player.js         ← `import { MYTK } from './player-kernel.js';` + 其余分片
页面用 <script type="module" src="player.js"> 加载，等于把 675 个顶层函数收进模块作用域，
不再泄漏成 window 全局；kernel 也真正成为独立模块，而不是拼在同一个文件里的一段注释。
其余分片之间仍共享同一个模块作用域（按顺序拼接），要再拆成独立模块得把跨片引用改成
显式 import/export，那是下一步。

修改分片后跑一次本脚本；`--check` 只校验是否同步（测试里用）。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PARTS = ROOT / "src" / "player-js"
OUT = ROOT / "site" / "player.js"
KERNEL_OUT = ROOT / "site" / "player-kernel.js"
KERNEL_MARK = "const MYTK = (() => {"


def read(path: Path) -> str:
    with open(path, encoding="utf-8", newline="") as handle:
        return handle.read()


def write(path: Path, text: str) -> None:
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(text)


def build() -> tuple[str, str]:
    parts = sorted(PARTS.glob("*.js"))
    if not parts:
        raise SystemExit(f"没有分片：{PARTS}")
    kernel_src = read(parts[0])
    if KERNEL_MARK not in kernel_src:
        raise SystemExit("00-kernel.js 里找不到 MYTK 定义，无法导出")
    kernel = kernel_src.replace(KERNEL_MARK, "export const MYTK = (() => {", 1)
    body = "".join(read(part) for part in parts[1:])
    bundle = "import { MYTK } from './player-kernel.js';\n" + body
    return kernel, bundle


def main() -> int:
    kernel, text = build()
    current = read(OUT) if OUT.is_file() else None
    current_kernel = read(KERNEL_OUT) if KERNEL_OUT.is_file() else None

    if "--check" in sys.argv:
        problems = []
        if current != text:
            problems.append("site/player.js")
        if current_kernel != kernel:
            problems.append("site/player-kernel.js")
        if problems:
            print("产物与 src/player-js 不一致：" + "、".join(problems) +
                  "；跑 python scripts/build_player_js.py")
            return 1
        print("site/player.js、player-kernel.js 与分片一致")
        return 0

    if current == text and current_kernel == kernel:
        print("site/player.js 未变化")
        return 0

    write(KERNEL_OUT, kernel)
    write(OUT, text)
    print(f"已重建 site/player.js（{len(text)} 字符）与 player-kernel.js（{len(kernel)} 字符）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
