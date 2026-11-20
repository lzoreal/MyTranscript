function isPlainContainer(value) {
  if (Array.isArray(value)) return true;
  if (!value || Object.prototype.toString.call(value) !== '[object Object]') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/* 只代理普通对象和数组；DOM 节点、类实例保持原引用，否则方法会丢 this。 */
function readonlyValue(value, cache) {
  if (!isPlainContainer(value)) return value;
  if (cache.has(value)) return cache.get(value);
  const proxy = new Proxy(value, {
    get(target, prop) {
      return readonlyValue(Reflect.get(target, prop), cache);
    },
    set(_, prop) { throw new Error('状态是只读的，不能写 ' + String(prop)); },
    deleteProperty() { throw new Error('状态是只读的，不能删除字段'); },
    defineProperty() { throw new Error('状态是只读的，不能定义字段'); },
    setPrototypeOf() { throw new Error('状态是只读的，不能改原型'); },
  });
  cache.set(value, proxy);
  return proxy;
}

/* 给旧插件桥用的白名单视图：只暴露声明过的字段与方法，
   未声明的读取和写入都当场报错，避免把宿主内部对象整块交出去。 */
export function createGuardedView(source, options = {}) {
  const read = new Set(options.read || []);
  const write = new Set(options.write || []);
  const label = String(options.label || '对象');
  const target = typeof source === 'function' ? source : () => source;
  const cache = new WeakMap();
  return new Proxy({}, {
    get(_, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (!read.has(prop)) throw new Error(label + '不向插件暴露 ' + String(prop));
      const value = target()[prop];
      if (typeof value === 'function') return value.bind(target());
      return options.deepRead === false ? value : readonlyValue(value, cache);
    },
    set(_, prop, value) {
      if (!write.has(prop)) throw new Error(label + '是只读的，不能写 ' + String(prop));
      target()[prop] = value;
      return true;
    },
    has(_, prop) {
      return typeof prop === 'string' && read.has(prop);
    },
  });
}