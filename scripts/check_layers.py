"""层边界自检：kernel 必须纯净，跨分片不得重复定义同名顶层函数。

用法：python scripts/check_layers.py（exit 1 表示违反）
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PARTS = sorted((ROOT / "src" / "player-js").glob("*.js"))
KERNEL = PARTS[0]

# kernel 里不允许出现的运行时依赖（纯函数层不读 DOM / 全局状态 / 不做网络）
FORBIDDEN = [
    r"\bstate\b", r"\bapp\b", r"\bprefs\b", r"\bdocument\b", r"\bwindow\b",
    r"\baudio\b", r"\bfetch\(", r"\bXHR\b", r"$\(", r"\bshowToast\b", r"\bLIVE_HOST\b",
]

DECL = re.compile(r"^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(", re.M)


def strip_comments(code: str) -> str:
    """去掉注释后再做纯度扫描，避免注释里的词造成误报。"""
    code = re.sub(r"/\*.*?\*/", "", code, flags=re.S)
    return re.sub(r"//[^\n]*", "", code)


def main() -> int:
    problems = []

    kernel_text = strip_comments(KERNEL.read_text(encoding="utf-8"))
    for pattern in FORBIDDEN:
        for m in re.finditer(pattern, kernel_text):
            line = kernel_text[: m.start()].count("\n") + 1
            problems.append(f"kernel 纯度：{KERNEL.name}:{line} 出现 {pattern}")

    seen = {}
    tauri_refs = 0
    host_refs = 0
    state_writes = []
    for part in PARTS:
        text = part.read_text(encoding="utf-8")
        code = strip_comments(text)
        tauri_refs += code.count("window.__TAURI__")
        host_refs += len(re.findall(r"\bLIVE_HOST\b", code))
        for m in re.finditer(r"\bstate\.([A-Za-z_$][\w$]*)\s*=(?!=)", code):
            line = code[: m.start()].count("\n") + 1
            state_writes.append(f"{part.name}:{line} state.{m.group(1)} =")
        for m in DECL.finditer(text):
            name = m.group(1)
            line = text[: m.start()].count("\n") + 1
            if name in seen:
                problems.append(
                    f"重复定义：function {name} 同时在 {seen[name]} 与 {part.name}:{line}"
                )
            else:
                seen[name] = f"{part.name}:{line}"

    if tauri_refs != 1:
        problems.append(
            f"平台检测点：window.__TAURI__ 只允许出现在 tauriHost() 定义里（当前 {tauri_refs} 处）"
        )
    if host_refs != 2:
        problems.append(
            f"宿主句柄：LIVE_HOST 只允许出现在定义行与 host() 里（当前 {host_refs} 处）"
        )
    if state_writes:
        problems.append(
            "状态写入：只允许 setState()，发现直写 " + "、".join(state_writes[:10])
            + (f" 等 {len(state_writes)} 处" if len(state_writes) > 10 else "")
        )

    if problems:
        print("\n".join(problems))
        print(f"\n{len(problems)} 项违反")
        return 1
    print(f"层边界 OK：kernel {len(KERNEL.read_text(encoding='utf-8').splitlines())} 行纯净，"
          f"{len(seen)} 个顶层函数无跨片重名")
    return 0


if __name__ == "__main__":
    sys.exit(main())
