#!/usr/bin/env python3
"""学习插件数据引擎：迁移到插件的设置/生词本/SRS 逻辑必须自洽，且兼容老 localStorage。"""
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
ENGINE = ROOT / "apps" / "windows" / "builtin-plugins" / "study" / "engine.js"

CASES = r"""
function assert(c, m) { if (!c) { console.error('FAIL: ' + m); process.exit(1); } }
const store = new Map(Object.entries({
  'myt-study-vocab': JSON.stringify([
    { word: 'Alpha', status: 'learning', ease: 2.5, interval: 0, reps: 0, lapses: 0, due: 1 },
    { word: 'beta', status: 'known' },
  ]),
  'myt-study-status': JSON.stringify({ beta: 'known' }),
}));
const localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
const api = { study: { cleanWord: raw => String(raw || '').toLowerCase().replace(/[^a-z']/g, '') } };
const engine = createStudyEngine(api);

assert(engine.vocab.length === 2, '老生词本要读进引擎');
assert(engine.vocab[1].ease === 2.5 && engine.vocab[1].due > 0, '缺失 SRS 字段要补齐');
assert(engine.wordStatusOf('BETA!') === 'known', '词状态按 cleanWord 归一');
assert(engine.dueItems().some(v => v.word === 'Alpha'), '到期词应进入复习队列');
assert(!engine.dueItems().some(v => v.word === 'beta'), '已掌握不进入复习');

engine.markWord('Alpha', 'known');
assert(engine.wordStatusOf('alpha') === 'known', '标记已掌握要落到状态表');
assert(engine.vocab[0].status === 'known', '生词本条目状态要同步');

const item = { ease: 2.5, interval: 0, reps: 0 };
engine.srsGrade(item, 3);
assert(item.interval === 2 && item.due > Date.now(), 'grade 3 要排到两天后');
assert(JSON.parse(store.get('myt-study-vocab'))[0].status === 'known', '标记后要写回 localStorage');

for (let i = 0; i < 305; i++) engine.cache['k' + i] = { data: i };
engine.saveCache();
assert(Object.keys(JSON.parse(store.get('myt-study-cache'))).length === 300, '缓存最多保留 300 条');

engine.settings.key = 'sk-test';
engine.saveSettings();
assert(JSON.parse(store.get('myt-study')).key === 'sk-test', '设置要能保存');
console.log('study engine OK');
"""


class StudyEngineTests(unittest.TestCase):
    def test_engine_behaviour(self):
        script = ENGINE.read_text(encoding="utf-8") + "\n" + CASES
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as fh:
            fh.write(script)
            path = fh.name
        proc = subprocess.run(["node", path], capture_output=True, text=True)
        Path(path).unlink(missing_ok=True)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("study engine OK", proc.stdout)


if __name__ == "__main__":
    unittest.main()
