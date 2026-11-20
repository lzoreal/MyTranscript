/* 异步请求代次：只允许最后一次发起、且归属仍存在的请求写回界面。
   每次 begin 同时换一个 AbortController：新请求到来、归属失效或插件停用时，
   旧请求不只是"结果被忽略"，而是真的被叫停。 */
export function createRequestGate() {
  let version = 0;
  let key = '';
  let controller = null;

  function abortCurrent() {
    if (!controller) return false;
    const current = controller;
    controller = null;
    try { current.abort(); } catch (e) {}
    return true;
  }

  return {
    begin(nextKey) {
      abortCurrent();
      version += 1;
      key = String(nextKey || '');
      controller = typeof AbortController === 'function' ? new AbortController() : null;
      return version;
    },
    current(candidate, expectedKey) {
      return candidate === version && key === String(expectedKey || '');
    },
    invalidate(expectedKey) {
      if (expectedKey !== undefined && key !== String(expectedKey || '')) return false;
      abortCurrent();
      version += 1;
      key = '';
      return true;
    },
    signal() {
      return controller ? controller.signal : null;
    },
    snapshot() {
      return { version, key };
    },
    abort() {
      return abortCurrent();
    },
  };
}
