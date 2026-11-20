"""插件宿主：依赖解析（含环）与能力占用的行为测试。

从 04 分片里切出 PluginHost 对象文本，在 node 里用最小桩执行，不依赖浏览器。
"""
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
PART = ROOT / "src" / "player-js" / "04-local-audio-plugin-host.js"

PRELUDE = """
const app = { capabilities: {}, plugins: [], pluginErrors: new Map() };
const document = { body: { dataset: {} } };
function definitionStarted() { return false; }
function host() { return null; }
"""

CASES = r"""
function plugin(id, requires, enabled = true) {
  return { id, requires, enabled };
}

function assert(cond, msg) { if (!cond) { console.error('FAIL: ' + msg); process.exit(1); } }

// 1. A→B→A 的环必须判为不满足
const cyc = [plugin('a', ['b']), plugin('b', ['a'])];
assert(PluginHost.available('a', cyc) === false, '环 a→b→a 应不满足');
assert(PluginHost.available('b', cyc) === false, '环 b→a→b 应不满足');
assert(PluginHost.missingRequires(cyc[0], cyc).length === 1, '环应报缺失依赖');

// 2. 自依赖
const self = [plugin('s', ['s'])];
assert(PluginHost.available('s', self) === false, '自依赖应不满足');

// 3. 菱形依赖不能误伤：a→(b,c)→d
const dia = [plugin('a', ['b', 'c']), plugin('b', ['d']), plugin('c', ['d']), plugin('d', [])];
assert(PluginHost.available('a', dia) === true, '菱形依赖应满足');
assert(PluginHost.available('d', dia) === true, '叶子应满足');

// 4. 停用的依赖不满足
const off = [plugin('x', ['y']), plugin('y', [], false)];
assert(PluginHost.available('x', off) === false, '依赖被停用应不满足');

// 5. 能力占用：同一能力不能被两个插件拿走
PluginHost.applyLayout = () => {};
PluginHost.claim('p1', 'subtitles');
assert(PluginHost.owner('subtitles') === 'p1', 'owner 应是 p1');
let threw = false;
try { PluginHost.claim('p2', 'subtitles'); } catch (e) { threw = true; }
assert(threw, '第二个插件 claim 同一能力应抛错');
assert(PluginHost.claim('p1', 'subtitles') === true, '同一插件重复 claim 应允许');

console.log('plugin host OK');
"""


CONSENT_CASES = r"""
const key = 'demo';
assert(pluginConsentState(key) === '', '未授权时应为空');
setPluginConsent(key, true);
assert(pluginConsentState(key) === 'allow', '允许后应记 allow');
setPluginConsent(key, false);
assert(pluginConsentState(key) === 'deny', '拒绝后应记 deny');
clearPluginConsent(key);
assert(pluginConsentState(key) === '', '撤销后应清空');
console.log('consent OK');
"""


def slice_block(text: str, starts: int, open_char: str = "{", close_char: str = "}") -> str:
    """从 starts 处的开括号起配平，返回完整块（含首尾括号）。"""
    depth = 0
    for i in range(starts, len(text)):
        if text[i] == open_char:
            depth += 1
        elif text[i] == close_char:
            depth -= 1
            if depth == 0:
                return text[starts:i + 1]
    raise AssertionError("块没有闭合")


def extract_consent() -> str:
    text = PART.read_text(encoding="utf-8")
    head = text.index("const PLUGIN_CONSENT_PREFIX")
    tail_at = text.index("function clearPluginConsent")
    tail = text.index("{", tail_at)
    return text[head:tail_at] + text[tail_at:tail] + slice_block(text, tail)


def extract_host() -> str:
    text = PART.read_text(encoding="utf-8")
    start = text.index("const PluginHost = {")
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1] + ";"
    raise AssertionError("没有找到 PluginHost 对象的结尾")


class PluginHostTests(unittest.TestCase):
    def test_dependency_and_capability_rules(self):
        script = PRELUDE + "\n" + extract_host() + "\n" + CASES
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as fh:
            fh.write(script)
            path = fh.name
        proc = subprocess.run(["node", path], capture_output=True, text=True)
        Path(path).unlink(missing_ok=True)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("plugin host OK", proc.stdout)

    def test_consent_tristate(self):
        stub = """
function assert(cond, msg) { if (!cond) { console.error('FAIL: ' + msg); process.exit(1); } }
const store = new Map();
const localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
"""
        script = stub + extract_consent() + "\n" + CONSENT_CASES
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as fh:
            fh.write(script)
            path = fh.name
        proc = subprocess.run(["node", path], capture_output=True, text=True)
        Path(path).unlink(missing_ok=True)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("consent OK", proc.stdout)


if __name__ == "__main__":
    unittest.main()
