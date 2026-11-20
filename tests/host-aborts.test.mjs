import {
  createPluginFaultBoundary, isAbortError, runPluginTask,
} from '../src/player-js/host/faults.js';
import { createRequestGate } from '../src/player-js/host/requests.js';

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL: ' + message);
    process.exit(1);
  }
}

async function main() {
  // 1. 新请求会 abort 上一轮：旧信号是"真的断了"，不是只被忽略
  const gate = createRequestGate();
  const first = gate.begin('a:local');
  const firstSignal = gate.signal();
  assert(firstSignal && !firstSignal.aborted, '第一轮应有未中止的信号');
  const second = gate.begin('b:web');
  assert(firstSignal.aborted, '发起新搜索时上一轮必须被 abort');
  assert(gate.current(second, 'b:web'), '新请求仍应有效');
  assert(!gate.current(first, 'a:local'), '旧请求代次作废');
  gate.invalidate('b:web');
  assert(gate.signal() === null, '归属失效后不应再留信号');

  // 2. runPluginTask 把 signal 交给任务，并在 abort 时立刻结算
  const controller = new AbortController();
  let seen = null;
  const pending = runPluginTask(signal => {
    seen = signal;
    return new Promise(resolve => { signal.addEventListener('abort', () => resolve('stopped')); });
  }, { label: '演示任务', signal: controller.signal, timeoutMs: 5000 });
  controller.abort();
  await pending.then(
    () => { throw new Error('abort 后不应正常 resolve'); },
    err => assert(isAbortError(err), 'abort 应给 AbortError，实际：' + (err && err.message)),
  );
  assert(seen === controller.signal, '任务必须收到同一个 signal');

  // 3. 已经 aborted 的信号：进任务前就拒绝
  const dead = new AbortController();
  dead.abort();
  await runPluginTask(() => 'never', { label: '已取消', signal: dead.signal, timeoutMs: 5000 })
    .then(
      () => { throw new Error('已中止的信号不应执行任务'); },
      err => assert(isAbortError(err), '已中止信号应直接拒绝'),
    );

  // 4. 取消不写插件诊断：停用不该在设置页留下一条假故障
  const reports = [];
  const boundary = createPluginFaultBoundary({ reportError: (id, scope, err) => reports.push({ id, scope, err }) });
  const stop = new AbortController();
  const scoped = boundary.run('demo', 'menus:export', () => new Promise(() => {}), {
    signal: stop.signal,
    timeoutMs: 60000,
  });
  stop.abort();
  await scoped.catch(err => assert(isAbortError(err), '边界也要返回 AbortError'));
  assert(reports.length === 0, '取消被当成故障写进了诊断：' + JSON.stringify(reports.map(r => String(r.err))));

  // 5. 超时仍然算故障，不能因为加了 signal 就漏报
  const timeoutErr = await runPluginTask(() => new Promise(() => {}), { label: '超时', timeoutMs: 30 })
    .then(() => null, err => err);
  assert(timeoutErr && !isAbortError(timeoutErr) && /超时/.test(timeoutErr.message),
    '超时必须是普通错误：' + (timeoutErr && timeoutErr.message));

  console.log('host aborts OK');
}

main().catch(err => {
  console.error('FAIL: ' + (err && err.stack || err));
  process.exit(1);
});
