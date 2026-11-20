/* 插件调用的统一故障边界：同步异常、异步拒绝和超时都收敛到同一个结果，
   诊断按插件累计，供设置页重试与复制。这里不依赖 DOM，可在 node 里直接测。 */
export const DEFAULT_PLUGIN_TIMEOUT_MS = 10000;

/* 取消不是失败：插件停用、切集或发起新搜索时，底层任务应该收到 AbortError，
   宿主按这个 code 判定「是我叫停的」，不写诊断、也不弹错误。 */
export function createAbortError(label) {
  const err = new Error(String(label || '插件调用') + '已取消');
  err.name = 'AbortError';
  err.code = 'plugin_aborted';
  return err;
}

export function isAbortError(err) {
  return Boolean(err) && (err.name === 'AbortError' || err.code === 'plugin_aborted');
}

export function describePluginError(err) {
  if (typeof err === 'string') return err;
  if (err && typeof err.message === 'string' && err.message) return err.message;
  if (err && typeof err.stack === 'string' && err.stack) return err.stack;
  try { return JSON.stringify(err); } catch (e) { return String(err); }
}

export function createPluginDiagnostics(options = {}) {
  const limit = Math.max(1, Number(options.limit) || 20);
  const records = new Map();
  return {
    report(pluginId, scope, err, at = Date.now()) {
      const key = String(pluginId || '');
      const list = records.get(key) || [];
      const entry = {
        at: Number(at) || Date.now(),
        scope: String(scope || 'runtime'),
        message: describePluginError(err),
      };
      list.push(entry);
      while (list.length > limit) list.shift();
      records.set(key, list);
      return entry;
    },
    get(pluginId) {
      return [...(records.get(String(pluginId || '')) || [])];
    },
    text(pluginId) {
      return (records.get(String(pluginId || '')) || [])
        .map(entry => new Date(entry.at).toISOString() + ' ' + entry.scope + ': ' + entry.message)
        .join('\n');
    },
    clear(pluginId) {
      records.delete(String(pluginId || ''));
    },
  };
}

export function createPluginFaultBoundary(options = {}) {
  const reportError = typeof options.reportError === 'function' ? options.reportError : () => {};
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1, Number(options.timeoutMs))
    : DEFAULT_PLUGIN_TIMEOUT_MS;

  function run(pluginId, scope, task, runOptions = {}) {
    return runPluginTask(task, {
      timeoutMs: runOptions.timeoutMs || timeoutMs,
      label: '插件 ' + pluginId + ' ' + scope,
      signal: runOptions.signal || null,
    }).catch(err => {
      // 主动取消不记诊断，否则每次停用都会留下一条假故障。
      if (isAbortError(err)) throw err;
      reportError(pluginId, scope, err);
      throw err;
    });
  }

  function watch(pluginId, scope, value, onError) {
    if (!value || typeof value.then !== 'function') return value;
    run(pluginId, scope, () => value).catch(err => {
      if (isAbortError(err)) return;
      if (typeof onError === 'function') onError(err);
    });
    return value;
  }

  function invoke(pluginId, scope, task) {
    try {
      const result = task();
      watch(pluginId, scope, result);
      return result && typeof result.then === 'function' ? undefined : result;
    } catch (err) {
      reportError(pluginId, scope, err);
      return undefined;
    }
  }

  return { invoke, run, watch };
}

export function runPluginTask(task, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1, Number(options.timeoutMs))
    : DEFAULT_PLUGIN_TIMEOUT_MS;
  const label = String(options.label || '插件调用');
  const signal = options.signal || null;
  return new Promise((resolve, reject) => {
    let done = false;
    let timer = null;
    let onAbort = null;
    const finish = (settle, value) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (signal && onAbort && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
      settle(value);
    };
    if (signal && signal.aborted) { finish(reject, createAbortError(label)); return; }
    if (signal && typeof signal.addEventListener === 'function') {
      onAbort = () => finish(reject, createAbortError(label));
      signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => finish(reject, new Error(label + '超时（' + timeoutMs + 'ms）')), timeoutMs);
    Promise.resolve().then(() => task(signal)).then(
      value => finish(resolve, value),
      err => finish(reject, err),
    );
  });
}