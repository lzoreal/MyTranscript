/* 宿主 v2 贡献点注册表：只负责登记、校验冲突、排序和回收。
   不执行插件代码，也不碰 DOM；测试宿主和以后的真实宿主共用这一层。 */
import { CONTRIBUTION_TYPES, FIXED_SLOTS, contributionKey } from './contract.js';

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function orderOf(record) {
  return Number.isFinite(Number(record?.impl?.order ?? record?.entry?.order))
    ? Number(record.impl?.order ?? record.entry?.order)
    : 0;
}

function byOrder(left, right) {
  const delta = orderOf(left) - orderOf(right);
  if (delta !== 0) return delta;
  return left.pluginId.localeCompare(right.pluginId) || left.id.localeCompare(right.id);
}

/* 聚合贡献允许不同插件使用同一个 id；键必须带 owner，停用才能只摘自己。 */
const SCOPED_TYPES = new Set(['importers', 'searchSources', 'menus', 'themes']);

function tableKey(type, id, pluginId) {
  return SCOPED_TYPES.has(type) ? String(pluginId) + '\u0000' + String(id) : String(id);
}

export function createContributionRegistry(options = {}) {
  const slots = options.slots || FIXED_SLOTS;
  const types = options.types || CONTRIBUTION_TYPES;
  const tables = new Map(types.map(type => [type, new Map()]));
  const providers = new Map();
  const claims = new Map();
  const pluginRecords = new Map();
  let activeTheme = null;

  function ensurePlugin(pluginId) {
    const key = String(pluginId);
    if (!pluginRecords.has(key)) pluginRecords.set(key, new Set());
    return pluginRecords.get(key);
  }

  function register(pluginId, manifest, implementations) {
    const owner = asString(pluginId);
    const errors = [];
    if (!owner) errors.push('插件 id 为空');
    if (!isObject(manifest) || !isObject(manifest.contributions)) {
      errors.push('清单缺少 contributions');
    }
    if (!isObject(implementations)) errors.push('插件没有提供贡献实现');
    if (errors.length) return { ok: false, errors };

    const declared = new Map();
    Object.entries(manifest.contributions).forEach(([type, list]) => {
      if (!types.includes(type)) {
        errors.push('未知贡献点类型：' + type);
        return;
      }
      if (!Array.isArray(list)) {
        errors.push(type + ' 必须是数组');
        return;
      }
      list.forEach(entry => {
        const id = asString(entry?.id);
        if (!id) { errors.push(type + ' 里缺少贡献 id'); return; }
        if (type === 'slots') {
          const slot = asString(entry.slot);
          if (!slots.includes(slot)) errors.push('槽位 ' + slot + ' 不在固定槽位表里');
        }
        const key = contributionKey(type, id);
        if (declared.has(key)) errors.push('同一插件重复声明贡献：' + key);
        declared.set(key, { type, id, entry });
      });
    });
    Object.keys(implementations).forEach(key => {
      if (!declared.has(key)) errors.push('实现了清单没声明的贡献：' + key);
    });

    const incoming = [];
    declared.forEach(({ type, id, entry }) => {
      const impl = implementations[contributionKey(type, id)];
      if (!impl) {
        errors.push('清单声明了 ' + contributionKey(type, id) + '，但脚本没有实现');
        return;
      }
      if (type === 'pages' && tables.get(type).has(id)) {
        errors.push('页面 ' + id + ' 已被插件 ' + tables.get(type).get(id).pluginId + ' 注册');
      }
      if (type === 'commands' && tables.get(type).has(id)) {
        errors.push('命令 ' + id + ' 已被插件 ' + tables.get(type).get(id).pluginId + ' 注册');
      }
      if (type === 'capabilities' && claims.has(id) && claims.get(id).pluginId !== owner) {
        errors.push('能力 ' + id + ' 已由插件 ' + claims.get(id).pluginId + ' 接管');
      }
      incoming.push({ type, id, pluginId: owner, entry, impl });
    });
    if (errors.length) return { ok: false, errors };

    const records = ensurePlugin(owner);
    incoming.forEach(record => {
      const table = tables.get(record.type);
      if (record.type === 'providers') {
        if (!providers.has(record.id)) providers.set(record.id, []);
        providers.get(record.id).push(record);
      } else if (record.type === 'capabilities') {
        claims.set(record.id, record);
        table.set(record.id, record);
      } else {
        table.set(tableKey(record.type, record.id, record.pluginId), record);
      }
      records.add(record);
    });

    let disposed = false;
    return {
      ok: true,
      errors: [],
      dispose() {
        if (disposed) return false;
        disposed = true;
        unregister(owner);
        return true;
      },
    };
  }

  function unregister(pluginId) {
    const key = String(pluginId);
    const records = pluginRecords.get(key);
    if (!records) return false;
    [...records].reverse().forEach(record => {
      const table = tables.get(record.type);
      if (record.type === 'providers') {
        const stack = providers.get(record.id) || [];
        const next = stack.filter(item => item !== record);
        if (next.length) providers.set(record.id, next);
        else providers.delete(record.id);
        return;
      }
      if (record.type === 'capabilities' && claims.get(record.id) === record) claims.delete(record.id);
      const key = tableKey(record.type, record.id, record.pluginId);
      if (table.get(key) === record) table.delete(key);
    });
    pluginRecords.delete(key);
    if (activeTheme && activeTheme.pluginId === key) activeTheme = null;
    return true;
  }

  function slot(name, payload = null) {
    const slotName = asString(name);
    if (!slots.includes(slotName)) return [];
    const list = [];
    pluginRecords.forEach(records => {
      records.forEach(record => {
        const entry = record.entry || {};
        if (record.type === 'slots' && entry.slot === slotName) {
          list.push({ ...record, payload });
        }
      });
    });
    return list.sort(byOrder);
  }

  function page(id) {
    const record = tables.get('pages').get(asString(id));
    return record ? record.impl : null;
  }

  function record(type, id) {
    return tables.get(asString(type))?.get(asString(id)) || null;
  }

  function list(type) {
    const table = tables.get(asString(type));
    return table ? [...table.values()].sort(byOrder) : [];
  }

  function command(id) {
    const record = tables.get('commands').get(asString(id));
    return record ? record.impl : null;
  }

  function settings(pane = '') {
    const list = [...tables.get('settings').values()]
      .filter(record => !pane || record.entry.pane === pane)
      .sort(byOrder);
    return list;
  }

  function provider(name) {
    const stack = providers.get(asString(name)) || [];
    return stack.length ? stack[stack.length - 1].impl : null;
  }

  function providerOwner(name) {
    const stack = providers.get(asString(name)) || [];
    return stack.length ? stack[stack.length - 1].pluginId : '';
  }

  function claimOwner(name) {
    return claims.get(asString(name))?.pluginId || '';
  }

  function setTheme(pluginId, id) {
    const record = tables.get('themes').get(tableKey('themes', asString(id), pluginId));
    if (!record || record.pluginId !== String(pluginId)) return false;
    activeTheme = record;
    return true;
  }

  function theme() {
    return activeTheme ? activeTheme.impl : null;
  }

  function snapshot() {
    const result = {};
    tables.forEach((table, type) => {
      result[type] = [...table.values()].map(record => ({
        type, id: record.id, pluginId: record.pluginId,
        order: orderOf(record),
      }));
    });
    result.providers = [...providers.entries()].map(([name, stack]) => ({
      name, stack: stack.map(record => record.pluginId),
    }));
    result.activeTheme = activeTheme ? { pluginId: activeTheme.pluginId, id: activeTheme.id } : null;
    return result;
  }

  return {
    register,
    unregister,
    slot,
    page,
    record,
    list,
    command,
    settings,
    provider,
    providerOwner,
    claimOwner,
    setTheme,
    theme,
    snapshot,
  };
}
