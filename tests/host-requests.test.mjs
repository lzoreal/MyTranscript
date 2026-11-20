import { createRequestGate } from '../src/player-js/host/requests.js';

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL: ' + message);
    process.exit(1);
  }
}

const gate = createRequestGate();
const slow = gate.begin('a:local');
const fast = gate.begin('b:web');
assert(!gate.current(slow, 'a:local'), '新请求开始后旧请求必须失效');
assert(gate.current(fast, 'b:web'), '最新请求应保持有效');
assert(!gate.current(fast, 'a:local'), '请求归属也必须匹配');

assert(!gate.invalidate('a:local'), '不能清掉不是当前归属的结果');
assert(gate.current(fast, 'b:web'), '无关失效不能影响当前请求');
assert(gate.invalidate('b:web'), '当前归属失效应成功');
assert(!gate.current(fast, 'b:web'), '失效后旧响应不能再写界面');

const next = gate.begin('c:local');
assert(gate.invalidate(), '无参数失效应清空当前请求');
assert(!gate.current(next, 'c:local'), '全局失效后所有在途请求都应作废');

console.log('host requests OK');