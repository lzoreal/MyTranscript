#!/usr/bin/env python3
"""学习运行时（AI 请求 + cue 定位 + 音频循环）迁到插件后的行为锁。"""
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
RUNTIME = ROOT / "apps" / "windows" / "builtin-plugins" / "study" / "runtime.js"

CASES = r"""
function assert(c, m) { if (!c) { console.error('FAIL: ' + m); process.exit(1); } }
const settings = { provider: 'openai', endpoint: 'https://api.openai.com/v1', key: 'sk-test', model: 'gpt-4o-mini', target: 'zh-CN' };
const api = { study: { engine: () => ({ settings }), host: () => host } };
const audio = {
  paused: true, currentTime: 0, played: 0,
  play() { this.paused = false; this.played++; return Promise.resolve(); },
  pause() { this.paused = true; },
};
const state = {
  cues: [{ start: 1, end: 3, speechStart: 1.2, speechEnd: 2.8, text: 'hello world' }],
  activeCue: 0, offset: 0.5,
  current: { id: 'ep1', title: 'Episode 1' }, show: { name: 'Show', slug: 'show' },
};
const calls = { seek: [], toast: [] };
const host = {
  state, audio, studyAutoPause: true,
  seekTo: at => calls.seek.push(at),
  showToast: (t, ms) => calls.toast.push(t),
  tauriHost: () => ({ core: { invoke: async (cmd, args) => {
    if (cmd === 'llm_chat') return '{"ok":true}';
    if (cmd === 'llm_models') return [{ id: 'm1' }];
    return null;
  } } }),
};
const runtime = createStudyRuntime(api, host);

assert(runtime.cueBounds(state.cues[0]).start === 1.7, 'cue 起点要加 offset');
assert(runtime.cueBounds(state.cues[0]).end === 3.3, 'cue 终点要加 offset');
assert(runtime.currentCue().ci === 0 && runtime.currentCue().cue.text === 'hello world', '当前句取 activeCue');
assert(runtime.currentKey({ ci: 0, cue: { text: 'hello world' } }).startsWith('ep1:0:'), '缓存键前缀');
assert(runtime.config().model === 'gpt-4o-mini', '配置来自引擎设置');

runtime.playRange(10, 12, 2);
assert(calls.seek[0] === 10 && !audio.paused, 'playRange 要 seek 并播放');
audio.currentTime = 11.95;
runtime.audioTick();
assert(audio.currentTime === 10 && audio.played === 2, '循环第一遍要回到起点重播');
audio.currentTime = 11.95;
runtime.audioTick();
assert(audio.paused, '循环用完后要暂停');

audio.paused = false; audio.currentTime = 3.25;
runtime.resetAutoPause();
runtime.audioTick();
assert(audio.paused, '自动暂停要在句末停住');

(async () => {
  const out = await runtime.chat('sys', 'user');
  assert(out === '{"ok":true}', 'chat 走宿主 llm_chat');
  assert(runtime.parseJson('```json\n{"a":1}\n```').a === 1, 'parseJson 要去围栏');
  assert(runtime.langName() === 'Simplified Chinese', '语言名按 target');
  console.log('study runtime OK');
})().catch(e => { console.error(e); process.exit(1); });
"""


class StudyRuntimeTests(unittest.TestCase):
    def test_runtime_behaviour(self):
        script = RUNTIME.read_text(encoding="utf-8") + "\n" + CASES
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as fh:
            fh.write(script)
            path = fh.name
        proc = subprocess.run(["node", path], capture_output=True, text=True)
        Path(path).unlink(missing_ok=True)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("study runtime OK", proc.stdout)


if __name__ == "__main__":
    unittest.main()
