/* layer: runtime —— 模块注册表
   分片之间只在启动后互相调用，静态 import 只指向 00-runtime / 00-kernel / 本文件。
   每个分片在文件末尾 registerLayer('<id>', {...})，消费者用 lazyFn / layerObject /
   layerValue 在调用时取，避免形成循环 import。 */
const registry = new Map();
const pending = new Map();

export function registerLayer(id, namespace) {
  const key = String(id);
  registry.set(key, namespace || {});
  const queue = pending.get(key);
  if (queue) {
    pending.delete(key);
    for (const call of queue) {
      try { call(); } catch (err) { console.warn('[layer] 注册后补执行失败', key, err); }
    }
  }
}

function need(id) {
  const ns = registry.get(String(id));
  if (!ns) throw new Error('模块尚未就绪：' + id);
  return ns;
}

export function lazyFn(id, name) {
  return (...args) => {
    if (!registry.has(String(id))) {
      const key = String(id);
      if (!pending.has(key)) pending.set(key, []);
      pending.get(key).push(() => {
        const fn = need(key)[name];
        if (typeof fn === 'function') fn(...args);
      });
      return undefined;
    }
    const fn = need(id)[name];
    if (typeof fn !== 'function') throw new Error('模块 ' + id + ' 没有函数 ' + name);
    return fn(...args);
  };
}

export function layerObject(id, name) {
  const target = () => need(id)[name];
  const bind = (key) => {
    const ns = target();
    const value = ns[key];
    return typeof value === 'function' ? value.bind(ns) : value;
  };
  return new Proxy({}, {
    get: (_, key) => bind(key),
    set: (_, key, value) => { target()[key] = value; return true; },
    has: (_, key) => key in target(),
    ownKeys: () => Reflect.ownKeys(target()),
    getOwnPropertyDescriptor: (_, key) => Object.getOwnPropertyDescriptor(target(), key),
  });
}

export function layerValue(id, name) {
  return need(id)[name];
}
