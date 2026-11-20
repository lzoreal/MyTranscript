import {
  DEFAULT_PLUGIN_TIMEOUT_MS,
  createPluginDiagnostics,
  createPluginFaultBoundary,
  describePluginError,
  runPluginTask,
} from '../src/player-js/host/faults.js';

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL: ' + message);
    process.exit(1);
  }
}

assert(DEFAULT_PLUGIN_TIMEOUT_MS >= 1000, '默认超时必须是可感知的真实时长');
assert(describePluginError(new Error('boom')) === 'boom', 'Error 取 message');
assert(describePluginError('plain') === 'plain', '字符串原样保留');
assert(describePluginError({ message: 'shaped' }) === 'shaped', '带 message 的对象取 message');

const diagnostics = createPluginDiagnostics({ limit: 2 });
diagnostics.report('demo', 'event:play', new Error('一'), 1);
diagnostics.report('demo', 'command:review', '二', 2);
diagnostics.report('demo', 'surface:slot', '三', 3);
const entries = diagnostics.get('demo');
assert(entries.length === 2, '诊断记录必须按上限裁剪');
assert(entries[0].scope === 'command:review' && entries[0].message === '二', '应保留最近两条');
assert(diagnostics.get('other').length === 0, '诊断按插件隔离');
const text = diagnostics.text('demo');
assert(/command:review: 二/.test(text) && /surface:slot: 三/.test(text), '诊断文本要带范围和消息');
diagnostics.clear('demo');
assert(diagnostics.get('demo').length === 0, '清空后不应残留');

const ok = await runPluginTask(() => Promise.resolve(42), { timeoutMs: 100, label: '测试' });
assert(ok === 42, '异步结果应原样返回');

let syncCaught = '';
try {
  await runPluginTask(() => { throw new Error('sync boom'); }, { timeoutMs: 100, label: '测试' });
} catch (err) {
  syncCaught = err.message;
}
assert(syncCaught === 'sync boom', '同步异常应转成拒绝');

let asyncCaught = '';
try {
  await runPluginTask(() => Promise.reject(new Error('async boom')), { timeoutMs: 100, label: '测试' });
} catch (err) {
  asyncCaught = err.message;
}
assert(asyncCaught === 'async boom', '异步拒绝应原样抛回');

let timeoutCaught = '';
try {
  await runPluginTask(() => new Promise(() => {}), { timeoutMs: 20, label: '页面渲染' });
} catch (err) {
  timeoutCaught = err.message;
}
assert(/页面渲染超时/.test(timeoutCaught), '超时必须带调用范围：' + timeoutCaught);

const reported = [];
const boundary = createPluginFaultBoundary({
  timeoutMs: 30,
  reportError: (id, scope, err) => reported.push([id, scope, describePluginError(err)]),
});

let boundaryAsync = '';
try {
  await boundary.run('demo', 'menu:export', () => Promise.reject(new Error('贡献点失败')));
} catch (err) { boundaryAsync = err.message; }
assert(boundaryAsync === '贡献点失败', '同步/异步失败要原样抛给调用方');
assert(reported.length === 1 && reported[0].join('|') === 'demo|menu:export|贡献点失败',
  '贡献点失败必须进入插件诊断：' + JSON.stringify(reported));

const cleanupResult = boundary.invoke('demo', 'cleanup', () => Promise.reject(new Error('清理失败')));
assert(cleanupResult === undefined, 'invoke 不把异步清理结果交给宿主');
await new Promise(resolve => setTimeout(resolve, 0));
assert(reported.some(item => item.join('|') === 'demo|cleanup|清理失败'),
  '异步清理拒绝也必须进入诊断：' + JSON.stringify(reported));
assert(boundary.invoke('demo', 'cleanup', () => 7) === 7, '同步清理结果应原样返回');

let watchError = '';
boundary.watch('demo', 'event:play', new Promise(() => {}), err => { watchError = err.message; });
await new Promise(resolve => setTimeout(resolve, 45));
assert(/超时/.test(watchError), 'watch 超时要回调错误并进入诊断：' + watchError);
assert(reported.some(item => item[0] === 'demo' && item[1] === 'event:play' && /超时/.test(item[2])),
  'watch 超时必须进入诊断');

console.log('host faults OK');