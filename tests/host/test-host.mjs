/* 测试宿主：用真实契约 + 注册表 + 上下文构造器装配插件，验证失败只影响自己的槽位。
   这不是产品运行时，只用于 node 侧的契约测试。2.2 起它也负责模拟 AbortSignal：
   槽位卸载/设置分区回收/停用插件都会 abort 对应的 ctx.signal。 */
import { validateManifest } from '../../src/player-js/host/contract.js';
import { createContributionRegistry } from '../../src/player-js/host/registry.js';
import { createContributionContext } from '../../src/player-js/host/context.js';

const MOCK_KITS = {
  ui: () => Object.freeze({ esc: value => String(value ?? ''), statHTML: () => '', coverHTML: () => '' }),
  catalog: () => Object.freeze({ subs: () => [], show: () => null, episodes: () => [] }),
  progress: () => Object.freeze({ all: () => ({}) }),
  downloads: () => Object.freeze({ entries: () => [] }),
  settings: () => Object.freeze({ prefs: {} }),
};

function mockApi(pluginId) {
  return {
    id: String(pluginId),
    version: '2.2',
    apiVersion: '2.2',
    host: {
      can: () => false,
      owner: () => '',
      status: () => ({ id: String(pluginId), state: 'active' }),
      available: () => true,
      registerKernel: () => true,
      providerOwner: () => '',
    },
    toast: () => {},
    navigate: () => {},
    el: () => null,
    on: () => () => {},
    command: () => {},
    storage: { get: (key, fallback = null) => fallback, set: () => {}, remove: () => {} },
    player: { state: () => ({}), play: async () => {}, pause: () => {}, seek: () => {} },
    cues: () => [],
  };
}

export function createTestHost(options = {}) {
  const registry = createContributionRegistry(options);
  const states = new Map();
  const aborts = new Map();   // pluginId -> Set<AbortController>

  function registerAbort(pluginId) {
    const key = String(pluginId);
    if (!aborts.has(key)) aborts.set(key, new Set());
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    if (controller) aborts.get(key).add(controller);
    return {
      signal: controller ? controller.signal : null,
      abort() { if (controller) controller.abort(); aborts.get(key)?.delete(controller); },
    };
  }

  function abortPlugin(pluginId) {
    const key = String(pluginId);
    const set = aborts.get(key);
    if (!set) return 0;
    const list = [...set];
    list.forEach(controller => { try { controller.abort(); } catch (e) {} });
    aborts.delete(key);
    return list.length;
  }

  function contextFor(pluginId, type, id, manifest, signal, payloadVersion) {
    return createContributionContext({
      type,
      id,
      apiVersion: manifest?.apiVersion,
      api: mockApi(pluginId),
      kits: MOCK_KITS,
      capability: name => Object.freeze({ owner: () => '', active: () => false }),
      signal,
      payloadVersion,
    });
  }

  function add(manifest, implementations) {
    const id = String(manifest?.id || '');
    const report = validateManifest(manifest, { strict: true, ...options });
    if (!report.ok) {
      states.set(id, { state: 'error', errors: report.errors, manifest: report.manifest });
      return report;
    }
    const registered = registry.register(report.manifest.id, report.manifest, implementations);
    if (!registered.ok) {
      states.set(report.manifest.id, { state: 'error', errors: registered.errors, manifest: report.manifest });
      return { ...registered, manifest: report.manifest };
    }
    states.set(report.manifest.id, {
      state: 'active',
      errors: [],
      manifest: report.manifest,
      dispose: registered.dispose,
    });
    return { ok: true, errors: [], manifest: report.manifest };
  }

  function stop(id) {
    const key = String(id);
    const state = states.get(key);
    if (!state || state.state === 'disabled') return false;
    abortPlugin(key);
    if (typeof state.dispose === 'function') state.dispose();
    states.set(key, { ...state, state: 'disabled', dispose: null });
    return true;
  }

  function status(id) {
    const key = String(id);
    const state = states.get(key);
    if (!state) return { id: key, state: 'missing', errors: [] };
    return { id: key, state: state.state, errors: state.errors || [] };
  }

  function markError(pluginId, err) {
    const state = states.get(pluginId) || { state: 'error', errors: [] };
    states.set(pluginId, { ...state, state: 'error', errors: [...(state.errors || []), String(err?.message || err)] });
  }

  function renderPage(id) {
    const key = String(id);
    const record = registry.record('pages', key);
    const impl = registry.page(key);
    if (!impl) return { ok: false, error: '页面不存在：' + key };
    const scope = registerAbort(record.pluginId);
    try {
      impl.render(null, contextFor(record.pluginId, 'pages', key,
        states.get(record.pluginId)?.manifest, scope.signal));
      return { ok: true };
    } catch (err) {
      scope.abort();
      markError(record.pluginId, err);
      return { ok: false, error: String(err?.message || err) };
    }
  }

  function runCommand(id) {
    const key = String(id);
    const record = registry.record('commands', key);
    const impl = registry.command(key);
    if (!impl) return { ok: false, error: '命令不存在：' + key };
    const scope = registerAbort(record.pluginId);
    try {
      return { ok: true, value: impl.run(contextFor(record.pluginId, 'commands', key,
        states.get(record.pluginId)?.manifest, scope.signal)) };
    } catch (err) {
      scope.abort();
      markError(record.pluginId, err);
      return { ok: false, error: String(err?.message || err) };
    }
  }

  /* 与真实宿主同口径：槽位由插件自己 mount，抛错只回收自己那一格。 */
  function mountSlot(name, payload = null, payloadVersion = 1) {
    const element = { children: [] };
    const live = [];
    registry.slot(name, payload).forEach(rec => {
      const impl = rec.impl || {};
      if (typeof impl.mount !== 'function') return;
      const node = { children: [], pluginId: rec.pluginId };
      const scope = registerAbort(rec.pluginId);
      try {
        impl.mount(node, contextFor(rec.pluginId, 'slots', rec.id,
          states.get(rec.pluginId)?.manifest, scope.signal, payloadVersion), payload);
        element.children.push(node);
        live.push({ rec, node, scope });
      } catch (err) {
        scope.abort();
        markError(rec.pluginId, err);
      }
    });
    return {
      element,
      dispose() {
        live.forEach(({ rec, node, scope }) => {
          try {
            if (typeof rec.impl.unmount === 'function') {
              rec.impl.unmount(node, contextFor(rec.pluginId, 'slots', rec.id, states.get(rec.pluginId)?.manifest));
            }
          } catch (err) { /* 回收失败不影响其他槽位 */ }
          scope.abort();
          element.children = element.children.filter(item => item !== node);
        });
      },
    };
  }

  /* 设置分区：pane 过滤 + 停用回收。 */
  function mountSettings(pane) {
    const element = { children: [] };
    const live = [];
    registry.settings(pane).forEach(rec => {
      const impl = rec.impl || {};
      if (typeof impl.render !== 'function') return;
      const node = { children: [], pluginId: rec.pluginId };
      const scope = registerAbort(rec.pluginId);
      try {
        impl.render(node, contextFor(rec.pluginId, 'settings', rec.id,
          states.get(rec.pluginId)?.manifest, scope.signal));
        element.children.push(node);
        live.push({ rec, node, scope });
      } catch (err) {
        scope.abort();
        markError(rec.pluginId, err);
      }
    });
    return { element, live };
  }

  return {
    add,
    stop,
    status,
    renderPage,
    runCommand,
    slot: registry.slot,
    list: registry.list,
    settings: registry.settings,
    provider: registry.provider,
    providerOwner: registry.providerOwner,
    claimOwner: registry.claimOwner,
    snapshot: registry.snapshot,
    mountSlot,
    mountSettings,
    abortPlugin,
    contextFor,
  };
}
