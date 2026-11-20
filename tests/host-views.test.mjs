import { createGuardedView } from '../src/player-js/host/views.js';

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL: ' + message);
    process.exit(1);
  }
}

class DomNode {
  constructor(id) { this.id = id; }
  getId() { return this.id; }
}
const dom = new DomNode('cue-el');
const state = {
  cues: [{ text: 'one' }],
  nodes: [{ el: dom }],
  current: { id: 'ep-1' },
  activeCue: 0,
  secret: 'hidden',
};
const readOnly = createGuardedView(state, {
  read: ['cues', 'nodes', 'current', 'activeCue'],
  label: '播放器状态',
});
assert(readOnly.cues[0].text === 'one' && readOnly.activeCue === 0, '白名单字段应可读');
let leaked = '';
try { void readOnly.secret; } catch (err) { leaked = err.message; }
assert(/不向插件暴露 secret/.test(leaked), '白名单外字段必须报错：' + leaked);
let wrote = '';
try { readOnly.activeCue = 2; } catch (err) { wrote = err.message; }
assert(/只读/.test(wrote), '未声明可写时必须拒绝写入');
assert(state.activeCue === 0, '拒绝写入不能改到源对象');

for (const mutate of [
  () => { readOnly.current.id = 'changed'; },
  () => { readOnly.cues[0].text = 'changed'; },
  () => { readOnly.cues.push({ text: 'two' }); },
]) {
  let nestedError = '';
  try { mutate(); } catch (err) { nestedError = err.message; }
  assert(/只读/.test(nestedError), '嵌套状态也必须拒绝写入：' + nestedError);
}
assert(state.current.id === 'ep-1' && state.cues.length === 1 && state.cues[0].text === 'one',
  '嵌套写入不能改到源对象');
assert(readOnly.nodes[0].el.getId() === 'cue-el', 'DOM 节点不能被深层代理破坏方法调用');

const audio = {
  paused: true,
  currentTime: 5,
  play() { this.paused = false; return Promise.resolve('played'); },
  remove() {},
};
const controlled = createGuardedView(audio, {
  read: ['paused', 'currentTime', 'play'],
  write: ['currentTime'],
  label: '播放器音频',
});
assert(controlled.paused === true, '音频状态可读');
controlled.currentTime = 9;
assert(audio.currentTime === 9, '声明可写的字段要落到源对象');
let removed = '';
try { void controlled.remove; } catch (err) { removed = err.message; }
assert(/不向插件暴露 remove/.test(removed), '音频只允许白名单方法');
assert((await controlled.play()) === 'played' && audio.paused === false, '方法要保持 this 绑定');

console.log('host views OK');