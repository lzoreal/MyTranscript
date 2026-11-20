"""层边界自检：kernel 必须纯净，跨分片不得重复定义同名顶层函数。

另外校验玩家入口的模块图：`player.js` 只做导入与启动，所有模块都必须从入口可达，
且 import 图不能有环。

用法：python scripts/check_layers.py（exit 1 表示违反）
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ROOT_JS = ROOT / "src" / "player-js"
PARTS = sorted(ROOT_JS.glob("*.js"))
KERNEL = PARTS[0]

IMPORT_RE = re.compile(r"(?:from\s+|import\s+)['\"]([^'\"]+)['\"]")

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


def module_graph() -> tuple[dict[Path, list[Path]], list[Path]]:
    """从 player.js 出发的本地 import 图；返回 (邻接表, 入口模块列表)。"""
    files = sorted(ROOT_JS.rglob("*.js"))
    graph = {path: [] for path in files}
    for path in files:
        for target in IMPORT_RE.findall(path.read_text(encoding="utf-8")):
            if not target.startswith("."):
                continue
            resolved = (path.parent / target).resolve()
            if resolved.exists():
                graph[path].append(resolved)
    return graph, files


def reachable_from_entry(graph: dict[Path, list[Path]]) -> set[Path]:
    entry = ROOT_JS / "player.js"
    seen = set()
    stack = [entry] if entry.exists() else []
    while stack:
        node = stack.pop()
        if node in seen:
            continue
        seen.add(node)
        stack.extend(graph.get(node, []))
    return seen


def find_cycles(graph: dict[Path, list[Path]]) -> list[str]:
    visiting, done, cycles = set(), set(), []

    def walk(node: Path, path: list[Path]):
        if node in done:
            return
        if node in visiting:
            start = path.index(node)
            cycles.append(" → ".join(p.name for p in path[start:] + [node]))
            return
        visiting.add(node)
        for nxt in graph.get(node, []):
            walk(nxt, path + [nxt])
        visiting.discard(node)
        done.add(node)

    for node in graph:
        walk(node, [node])
    return cycles


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
    if host_refs != 4:
        problems.append(
            f"宿主句柄：LIVE_HOST 只允许出现在定义、host()、导出列表与 registerLayer 里（当前 {host_refs} 处）"
        )
    if state_writes:
        problems.append(
            "状态写入：只允许 setState()，发现直写 " + "、".join(state_writes[:10])
            + (f" 等 {len(state_writes)} 处" if len(state_writes) > 10 else "")
        )

    entry = ROOT_JS / "player.js"
    if entry.exists():
        entry_code = strip_comments(entry.read_text(encoding="utf-8"))
        declarations = [
            line.strip() for line in entry_code.splitlines()
            if re.match(r"^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\b", line.strip())
        ]
        if declarations:
            problems.append("入口纯度：player.js 只能导入与启动，发现定义 " + "；".join(declarations[:5]))
    graph, files = module_graph()
    unreachable = [p.name for p in files if p not in reachable_from_entry(graph)]
    if unreachable:
        problems.append("模块图：以下模块从 player.js 不可达 " + "、".join(unreachable))
    cycles = find_cycles(graph)
    for cycle in cycles:
        problems.append("模块图存在循环 import：" + cycle)

    if problems:
        print("\n".join(problems))
        print(f"\n{len(problems)} 项违反")
        return 1
    print(f"层边界 OK：kernel {len(KERNEL.read_text(encoding='utf-8').splitlines())} 行纯净，"
          f"{len(seen)} 个顶层函数无跨片重名，{len(files)} 个模块从 player.js 可达且 import 无环")
    return 0


if __name__ == "__main__":
    sys.exit(main())
