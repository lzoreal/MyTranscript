"""学习界面的注册生命周期：失败回滚、停用 dispose、重复注册与宿主全局泄漏。"""

import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
PART = ROOT / "src" / "player-js" / "04-local-audio-plugin-host.js"
UI = ROOT / "apps" / "windows" / "builtin-plugins" / "study" / "ui.js"

PRELUDE = """
let STUDY_UI = null, STUDY_UI_OWNER = '';
const cleanups = new Map();
function trackPlugin(id, fn) {
  const key = String(id);
  if (!cleanups.has(key)) cleanups.set(key, []);
  cleanups.get(key).push(fn);
}
function runCleanup(id) {
  const list = cleanups.get(String(id)) || [];
  [...list].reverse().forEach(fn => fn());
}
function assert(cond, msg) { if (!cond) { console.error('FAIL: ' + msg); process.exit(1); } }
"""


def extract_ui_lifecycle():
    text = PART.read_text(encoding="utf-8")
    head = text.index("function disposeStudyUi")
    tail = text.index("function registerStudyRuntime")
    return text[head:tail]


def run_source(source: str) -> subprocess.CompletedProcess:
    with tempfile.TemporaryDirectory() as tmp:
        script = Path(tmp) / "study_ui_lifecycle.js"
        script.write_text(source, encoding="utf-8")
        return subprocess.run(
            ["node", str(script)], capture_output=True, text=True, encoding="utf-8"
        )


class StudyUiLifecycleTests(unittest.TestCase):
    def test_register_and_dispose(self):
        source = PRELUDE + extract_ui_lifecycle() + r"""
let binds = 0, disposed = 0;
const first = {
  bindStudyUI() { binds += 1; },
  disposeStudyUI() { disposed += 1; },
};
registerStudyUi('study', first);
assert(binds === 1, '注册时应绑定一次');
assert(studyUi() === first, '注册后槽位应指向实现');
runCleanup('study');
assert(disposed === 1, '停用应调用 disposeStudyUI');
assert(studyUi() === null, '停用后槽位必须清空');

let secondDisposed = 0;
const second = {
  bindStudyUI() { binds += 1; },
  disposeStudyUI() { secondDisposed += 1; },
};
registerStudyUi('study', second);
assert(binds === 2, '重新启用应重新绑定');
assert(studyUi() === second, '重新启用后槽位应指向新实现');
runCleanup('study');
assert(secondDisposed === 1, '重新启用后停用也要 dispose');
console.log('register/dispose OK');
"""
        proc = run_source(source)
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_bind_failure_rolls_back_without_track(self):
        source = PRELUDE + extract_ui_lifecycle() + r"""
let disposed = 0;
const bad = {
  bindStudyUI() { throw new Error('bind boom'); },
  disposeStudyUI() { disposed += 1; },
};
let threw = false;
try { registerStudyUi('study', bad); } catch (e) { threw = true; }
assert(threw, '绑定失败必须抛回给 setup');
assert(studyUi() === null, '绑定失败不能留下半初始化 UI');
assert(disposed === 1, '绑定失败应撤销已挂的监听');
assert(!cleanups.has('study'), '绑定失败不应提前登记一个成功 cleanup');
console.log('bind failure OK');
"""
        proc = run_source(source)
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_owner_is_exclusive_and_replacement_disposes_old(self):
        source = PRELUDE + extract_ui_lifecycle() + r"""
let oldDisposed = 0;
const old = { bindStudyUI() {}, disposeStudyUI() { oldDisposed += 1; } };
registerStudyUi('p1', old);
let threw = false;
try { registerStudyUi('p2', { bindStudyUI() {} }); } catch (e) { threw = true; }
assert(threw, '第二个插件不能覆盖已注册 UI');
assert(studyUi() === old, '冲突注册不能换掉原实现');

const next = { bindStudyUI() {}, disposeStudyUI() {} };
registerStudyUi('p1', next);
assert(oldDisposed === 1, '同一 owner 替换实现时应先 dispose 旧实现');
assert(studyUi() === next, '替换后槽位应指向新实现');
console.log('owner OK');
"""
        proc = run_source(source)
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_plugin_ui_has_no_named_global_leaks(self):
        text = UI.read_text(encoding="utf-8")
        self.assertIsNone(
            re.search(r"(?<![\w.$])app\.", text),
            "插件 UI 不能再依赖浏览器命名全局 app（实际会命中 #app 元素）",
        )
        self.assertNotIn("window.__studyAudioBound", text)
        self.assertIn("disposeStudyUI", text)
        self.assertIn("beginUiBindings", text)
        self.assertIn("host.player.setAutoplay(false)", text)


    def test_translation_settings_are_bound_by_plugin(self):
        ui = UI.read_text(encoding="utf-8")
        host08 = (ROOT / "src" / "player-js" / "08-study-ai.js").read_text(encoding="utf-8")
        host10 = (ROOT / "src" / "player-js" / "10-desktop-bridge-tail.js").read_text(encoding="utf-8")
        self.assertIn("host.translate.TR.on", ui)
        self.assertIn("bindTranslateUI();", ui)
        self.assertNotIn("function bindTranslateUI", host08)
        self.assertNotIn("bindTranslateUI()", host10)


    def test_host_does_not_write_migrated_study_state(self):
        for name in ("01-theme-reader-shell.js", "03-native-asr-service-worker.js"):
            text = (ROOT / "src" / "player-js" / name).read_text(encoding="utf-8")
            for ident in ("studyLoop", "studyAutoPauseDone", "studyExercise",
                          "studyVocabContext", "studyVocabContextMode"):
                self.assertIsNone(
                    re.search(rf"(?<![\w.]){ident}\s*=", text),
                    f"{name} 不能直接写已迁到插件的 {ident}",
                )
        host08 = (ROOT / "src" / "player-js" / "08-study-ai.js").read_text(encoding="utf-8")
        for name in ("studyResetPlayback", "studyResetAutoPause", "studyResetContext"):
            self.assertIn(f"function {name}", host08)


if __name__ == "__main__":
    unittest.main()
