/* 宿主 v2 公共契约：清单校验、版本判断、依赖排序。
   这一层不碰 DOM、不碰播放器，只做纯数据判断，方便在 node 里单测，
   也方便以后把旧宿主换成贡献点宿主时逐条迁移。 */

/* 2.2：按贡献类型收窄 ctx，并给每类 payload 独立版本号。
   2.0/2.1 插件继续拿 2.1 的全量 ctx（兼容档案见 contextKeysFor）。 */
export const HOST_API_VERSION = '2.2';
export const API_MAJOR = 2;
export const CONTEXT_RULES_VERSION = '2.2';

export const CONTRIBUTION_TYPES = Object.freeze([
  'pages',
  'slots',
  'settings',
  'commands',
  'providers',
  'capabilities',
  'importers',
  'searchSources',
  'menus',
  'themes',
]);

/* 清单用复数（pages），运行时实现键用单数（page:home），这里给唯一映射，
   避免两边各写一套前缀。 */
export const CONTRIBUTION_PREFIXES = Object.freeze({
  pages: 'page',
  slots: 'slot',
  settings: 'settings',
  commands: 'command',
  providers: 'provider',
  capabilities: 'capability',
  importers: 'importer',
  searchSources: 'searchSource',
  menus: 'menu',
  themes: 'theme',
});

export function contributionKey(type, id) {
  const prefix = CONTRIBUTION_PREFIXES[type];
  if (!prefix) throw new Error('未知贡献点类型：' + type);
  return prefix + ':' + String(id);
}

/* 槽位名从 2.1 起固定；追加新槽位算 2.x，改名或删除算 3.0。 */
export const FIXED_SLOTS = Object.freeze([
  'nav.main',
  'home.hero.after',
  'home.continue.actions',
  'episode.header.actions',
  'episode.body.before',
  'player.dock.actions',
  'player.sidebar',
  'settings.panes',
  'library.toolbar',
  'downloads.empty',
  'search.results.after',
]);

export const KNOWN_PERMISSIONS = Object.freeze([
  'ui.dom',
  'net',
  'player',
  'storage',
  'providers',
  'subtitles',
  'study',
  // 2.2 追加：本机媒体处理（探测 / 裁片段 / 只取音轨），只走桌面壳命令，不给网页版。
  'media',
  // 2.2 追加：LLM 问答，复用「设置 → AI 学英语」里已填的 provider / key / model。
  'llm',
]);

/* 2.2 起每种贡献只拿自己需要的上下文组，插件公共 API 不再随功能堆积无限膨胀。
   2.0/2.1 清单走 LEGACY_CONTEXT_KEYS，保持 2.1 的完整上下文（一个版本周期的兼容层）。 */
export const CONTEXT_KEYS = Object.freeze([
  'player', 'events', 'storage', 'navigate', 'capability',
  'api', 'ui', 'catalog', 'progress', 'downloads', 'settings',
]);
export const LEGACY_CONTEXT_KEYS = Object.freeze([...CONTEXT_KEYS]);
export const CONTEXT_PROFILES = Object.freeze({
  pages: Object.freeze([...CONTEXT_KEYS]),
  slots: Object.freeze(['player', 'events', 'storage', 'navigate', 'capability',
    'api', 'ui', 'catalog', 'progress', 'downloads']),
  settings: Object.freeze(['events', 'storage', 'navigate', 'capability', 'api', 'ui', 'settings']),
  commands: Object.freeze(['player', 'events', 'storage', 'navigate', 'capability',
    'api', 'ui', 'catalog', 'progress', 'downloads']),
  providers: Object.freeze(['api']),
  capabilities: Object.freeze(['player', 'events', 'storage', 'navigate', 'capability', 'api']),
  importers: Object.freeze(['events', 'storage', 'navigate', 'api', 'ui', 'catalog', 'progress']),
  searchSources: Object.freeze(['events', 'storage', 'navigate', 'api', 'ui', 'player']),
  menus: Object.freeze(['events', 'storage', 'navigate', 'api', 'player']),
  themes: Object.freeze([]),
});

/* api 对象的投影：null 表示整份（页面与能力接管需要完整 api），数组表示白名单。
   收益不是少几个键，而是 subtitles/study/storage 这些大组不再出现在菜单、搜索源里。 */
export const SCOPED_API_FIELDS = Object.freeze({
  pages: null,
  slots: Object.freeze(['id', 'version', 'apiVersion', 'host', 'toast', 'navigate',
    'openEpisode', 'el', 'on', 'command', 'player', 'cues', 'storage', 'media', 'llm']),
  settings: Object.freeze(['id', 'version', 'apiVersion', 'host', 'toast', 'navigate',
    'el', 'on', 'command', 'storage', 'media']),
  commands: Object.freeze(['id', 'version', 'apiVersion', 'host', 'toast', 'navigate',
    'openEpisode', 'on', 'command', 'player', 'storage', 'cues', 'media']),
  providers: Object.freeze(['id', 'version', 'apiVersion', 'host', 'toast']),
  capabilities: null,
  importers: Object.freeze(['id', 'version', 'apiVersion', 'host', 'toast', 'navigate',
    'el', 'on', 'storage']),
  searchSources: Object.freeze(['id', 'version', 'apiVersion', 'host', 'toast', 'navigate',
    'openEpisode', 'on', 'player']),
  menus: Object.freeze(['id', 'version', 'apiVersion', 'host', 'toast', 'navigate',
    'openEpisode', 'on', 'player']),
  themes: Object.freeze([]),
});

/* 每类 payload 独立版本：槽位、设置分区、搜索结果、页面各自演进，不互相绑死。
   宿主按版本号决定怎么解释，插件在 ctx.payloadVersion 里读到当前期望值。 */
export const PAYLOAD_KINDS = Object.freeze({
  pages: 'page',
  slots: 'slot',
  settings: 'settings',
  commands: 'command',
  providers: 'provider',
  capabilities: 'capability',
  importers: 'importer',
  searchSources: 'searchResult',
  menus: 'menu',
  themes: 'theme',
});
export const PAYLOAD_VERSIONS = Object.freeze({
  page: 1,
  slot: 1,
  settings: 1,
  command: 1,
  provider: 1,
  capability: 1,
  importer: 1,
  searchResult: 1,
  menu: 1,
  theme: 1,
});

export function payloadKindFor(type) {
  return PAYLOAD_KINDS[String(type)] || '';
}

export function payloadVersionFor(type) {
  const kind = payloadKindFor(type);
  return kind ? PAYLOAD_VERSIONS[kind] : 0;
}

/* apiVersion 低于 2.2 的插件仍按 2.1 的完整上下文装配；2.2 起按类型收窄。
   未知类型退回完整档案：宁可多给，也不要让插件因为宿主漏配而静默变成 undefined。 */
export function contextKeysFor(type, apiVersion) {
  const wanted = parseVersion(apiVersion);
  if (!wanted || wanted.major < API_MAJOR || wanted.minor < 2) return LEGACY_CONTEXT_KEYS;
  const profile = CONTEXT_PROFILES[String(type)];
  return profile || LEGACY_CONTEXT_KEYS;
}

export function scopedApiFieldsFor(type, apiVersion) {
  const wanted = parseVersion(apiVersion);
  if (!wanted || wanted.major < API_MAJOR || wanted.minor < 2) return null;
  const fields = SCOPED_API_FIELDS[String(type)];
  return fields === undefined ? null : fields;
}

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SEMVER_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function error(code, message, pluginId = '') {
  return { code, message, pluginId };
}

function pushError(errors, code, message, pluginId = '') {
  errors.push(error(code, message, pluginId));
}

export function parseVersion(version) {
  const match = SEMVER_RE.exec(String(version || '').trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2] || 0),
    patch: Number(match[3] || 0),
  };
}

export function compareVersions(a, b) {
  const left = typeof a === 'string' ? parseVersion(a) : a;
  const right = typeof b === 'string' ? parseVersion(b) : b;
  if (!left || !right) return null;
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  return 0;
}

/* 只认主机点：次版本必须不高于宿主。2.0 插件在 2.1 宿主上仍然可用，
   2.2 插件在 2.1 宿主上拒绝，3.x 一律拒绝。空值按旧插件兼容处理。 */
export function apiCompatible(version, hostVersion = HOST_API_VERSION) {
  const want = asString(version);
  if (!want) return true;
  const wanted = parseVersion(want);
  const host = parseVersion(hostVersion);
  if (!wanted || !host) return false;
  if (wanted.major !== host.major) return false;
  if (wanted.minor > host.minor) return false;
  return true;
}

function upperForCaret(base) {
  if (base.major > 0) return { major: base.major + 1, minor: 0, patch: 0 };
  if (base.minor > 0) return { major: 0, minor: base.minor + 1, patch: 0 };
  return { major: 0, minor: 0, patch: base.patch + 1 };
}

function upperForTilde(base) {
  if (base.major > 0) return { major: base.major, minor: base.minor + 1, patch: 0 };
  return { major: base.major, minor: base.minor, patch: base.patch + 1 };
}

function expandRangeToken(token) {
  const raw = String(token || '').trim();
  if (!raw || raw === '*' || raw === 'x' || raw === 'X' || raw === 'latest') {
    return [{ op: '>=', version: { major: 0, minor: 0, patch: 0 } }];
  }
  if (raw.includes('||')) return null;
  const caret = raw.startsWith('^');
  const tilde = raw.startsWith('~');
  if (caret || tilde) {
    const base = parseVersion(raw.slice(1));
    if (!base) return null;
    const upper = caret ? upperForCaret(base) : upperForTilde(base);
    return [
      { op: '>=', version: base },
      { op: '<', version: upper },
    ];
  }
  const wildcard = raw.match(/^v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/);
  if (wildcard) {
    const major = Number(wildcard[1]);
    const minorRaw = wildcard[2];
    const patchRaw = wildcard[3];
    if (minorRaw === undefined || /^[xX*]$/.test(minorRaw)) {
      return [
        { op: '>=', version: { major, minor: 0, patch: 0 } },
        { op: '<', version: { major: major + 1, minor: 0, patch: 0 } },
      ];
    }
    const minor = Number(minorRaw);
    if (patchRaw === undefined || /^[xX*]$/.test(patchRaw)) {
      return [
        { op: '>=', version: { major, minor, patch: 0 } },
        { op: '<', version: { major, minor: minor + 1, patch: 0 } },
      ];
    }
  }
  const comparator = raw.match(/^(>=|<=|>|<|=)?\s*(.+)$/);
  if (!comparator) return null;
  const base = parseVersion(comparator[2]);
  if (!base) return null;
  return [{ op: comparator[1] || '=', version: base }];
}

export function satisfies(version, range) {
  const base = parseVersion(version);
  if (!base) return false;
  const text = asString(range);
  if (!text) return true;
  const alternatives = text.split('||').map(part => part.trim()).filter(Boolean);
  if (!alternatives.length) return true;
  return alternatives.some(part => {
    const tokens = part.split(/\s+/).filter(Boolean);
    const groups = tokens.map(expandRangeToken);
    if (groups.some(group => !group)) return false;
    return groups.every(group => group.every(item => {
      const cmp = compareVersions(base, item.version);
      if (cmp === null) return false;
      if (item.op === '>=') return cmp >= 0;
      if (item.op === '<=') return cmp <= 0;
      if (item.op === '>') return cmp > 0;
      if (item.op === '<') return cmp < 0;
      return cmp === 0;
    }));
  });
}

function safeRelativePath(value) {
  const path = asString(value);
  if (!path) return false;
  if (path.startsWith('/') || path.startsWith('\\') || /^[a-zA-Z]:/.test(path)) return false;
  return !path.split(/[\\/]/).some(part => part === '..');
}

function validateContributionEntry(type, entry, pluginId, errors, slotNames) {
  if (!isObject(entry)) {
    pushError(errors, 'contribution_invalid', type + ' 的贡献项必须是对象', pluginId);
    return null;
  }
  const id = asString(entry.id);
  if (!id) {
    pushError(errors, 'contribution_id_missing', type + ' 的贡献项缺少 id', pluginId);
    return null;
  }
  if (type === 'slots') {
    const slot = asString(entry.slot);
    if (!slot) {
      pushError(errors, 'slot_missing', '槽位贡献 ' + id + ' 缺少 slot', pluginId);
    } else if (!slotNames.includes(slot)) {
      pushError(errors, 'slot_unknown', '槽位 ' + slot + ' 不在宿主固定槽位表里', pluginId);
    }
  }
  if (type === 'settings' && !asString(entry.pane)) {
    pushError(errors, 'settings_pane_missing', '设置贡献 ' + id + ' 缺少 pane', pluginId);
  }
  if (entry.order !== undefined && !Number.isFinite(Number(entry.order))) {
    pushError(errors, 'order_invalid', '贡献 ' + id + ' 的 order 必须是数字', pluginId);
  }
  return { ...entry, id: String(id) };
}

export function validateManifest(input, options = {}) {
  const strict = options.strict !== false;
  const slotNames = options.slots || FIXED_SLOTS;
  const permissions = options.permissions || KNOWN_PERMISSIONS;
  const errors = [];
  const warnings = [];
  if (!isObject(input)) {
    pushError(errors, 'manifest_invalid', 'plugin.json 必须是对象');
    return { ok: false, errors, warnings, manifest: null };
  }
  const pluginId = asString(input.id);
  if (!pluginId) {
    pushError(errors, 'id_missing', '插件缺少 id');
  } else if (!PLUGIN_ID_RE.test(pluginId)) {
    pushError(errors, 'id_invalid', '插件 id 只能用小写字母、数字、- 和 _，且不能以符号开头：' + pluginId, pluginId);
  }
  const name = asString(input.name);
  if (strict && !name) warnings.push(error('name_missing', '插件没有 name，设置页会退回显示 id', pluginId));
  const version = asString(input.version);
  if (strict && !version) {
    pushError(errors, 'version_missing', '插件缺少 version', pluginId);
  } else if (version && !parseVersion(version)) {
    pushError(errors, 'version_invalid', '插件 version 不是合法 semver：' + version, pluginId);
  }
  const apiVersion = asString(input.apiVersion);
  if (strict && !apiVersion) {
    pushError(errors, 'api_version_missing', '插件缺少 apiVersion', pluginId);
  } else if (apiVersion && !apiCompatible(apiVersion, options.hostVersion || HOST_API_VERSION)) {
    pushError(errors, 'api_version_incompatible', '插件要求 API ' + apiVersion + '，宿主只支持 ' +
      (options.hostVersion || HOST_API_VERSION), pluginId);
  }
  const permissionsList = input.permissions;
  let normalizedPermissions = null;
  if (permissionsList !== undefined) {
    if (!Array.isArray(permissionsList)) {
      pushError(errors, 'permissions_invalid', 'permissions 必须是数组', pluginId);
    } else {
      normalizedPermissions = [];
      permissionsList.forEach(item => {
        const key = asString(item);
        if (!key) return;
        if (!permissions.includes(key)) {
          pushError(errors, 'permission_unknown', '未知权限：' + key, pluginId);
          return;
        }
        if (!normalizedPermissions.includes(key)) normalizedPermissions.push(key);
      });
    }
  }
  const requires = input.requires;
  const normalizedRequires = {};
  if (requires !== undefined) {
    if (!isObject(requires)) {
      pushError(errors, 'requires_invalid', 'requires 必须是对象', pluginId);
    } else {
      Object.entries(requires).forEach(([key, range]) => {
        const dep = asString(key);
        if (!PLUGIN_ID_RE.test(dep)) {
          pushError(errors, 'requires_id_invalid', '依赖 id 不合法：' + key, pluginId);
          return;
        }
        if (!asString(range)) {
          pushError(errors, 'requires_range_missing', '依赖 ' + dep + ' 缺少版本范围', pluginId);
          return;
        }
        normalizedRequires[dep] = String(range).trim();
      });
    }
  }
  if (normalizedRequires[pluginId]) {
    pushError(errors, 'requires_self', '插件不能依赖自己：' + pluginId, pluginId);
  }
  const contributions = input.contributions;
  const normalizedContributions = {};
  if (contributions === undefined) {
    if (strict) pushError(errors, 'contributions_missing', '插件缺少 contributions 声明', pluginId);
  } else if (!isObject(contributions)) {
    pushError(errors, 'contributions_invalid', 'contributions 必须是对象', pluginId);
  } else {
    Object.keys(contributions).forEach(type => {
      if (!CONTRIBUTION_TYPES.includes(type)) {
        pushError(errors, 'contribution_type_unknown', '未知贡献点类型：' + type, pluginId);
      }
    });
    CONTRIBUTION_TYPES.forEach(type => {
      const list = contributions[type];
      if (list === undefined) return;
      if (!Array.isArray(list)) {
        pushError(errors, 'contributions_type_invalid', type + ' 必须是数组', pluginId);
        return;
      }
      const seen = new Set();
      const normalized = [];
      list.forEach(entry => {
        const checked = validateContributionEntry(type, entry, pluginId, errors, slotNames);
        if (!checked) return;
        if (seen.has(checked.id)) {
          pushError(errors, 'contribution_duplicate', type + ' 里重复的贡献 id：' + checked.id, pluginId);
          return;
        }
        seen.add(checked.id);
        normalized.push(checked);
      });
      normalizedContributions[type] = normalized;
    });
  }
  ['main', 'style'].forEach(field => {
    if (input[field] === undefined) return;
    if (!safeRelativePath(input[field])) {
      pushError(errors, 'path_invalid', field + ' 必须是插件目录内的相对路径', pluginId);
    }
  });
  if (input.scripts !== undefined) {
    if (!Array.isArray(input.scripts)) {
      pushError(errors, 'scripts_invalid', 'scripts 必须是数组', pluginId);
    } else {
      input.scripts.forEach((item, index) => {
        if (!safeRelativePath(item)) pushError(errors, 'script_path_invalid', 'scripts[' + index + '] 路径不合法', pluginId);
      });
    }
  }
  if (strict && input.official !== undefined) {
    pushError(errors, 'official_field_forbidden', 'official 不是清单字段，来源由目录决定', pluginId);
  }
  const manifest = {
    ...input,
    id: pluginId,
    name: name || pluginId,
    version,
    apiVersion,
    requires: normalizedRequires,
    contributions: normalizedContributions,
  };
  if (normalizedPermissions) manifest.permissions = normalizedPermissions;
  return { ok: errors.length === 0, errors, warnings, manifest };
}

function dependencyLabel(id, range) {
  return id + '@' + range;
}

export function validatePluginSet(input, options = {}) {
  const strict = options.strict !== false;
  const errors = [];
  const warnings = [];
  const plugins = new Map();
  const enabled = new Map();
  const list = Array.isArray(input) ? input : [];
  list.forEach(item => {
    const report = validateManifest(item, { ...options, strict });
    warnings.push(...report.warnings);
    if (!report.ok) {
      errors.push(...report.errors);
      return;
    }
    const manifest = report.manifest;
    if (enabled.has(manifest.id)) {
      pushError(errors, 'id_duplicate', '插件 id 重复：' + manifest.id, manifest.id);
      return;
    }
    enabled.set(manifest.id, manifest);
  });
  enabled.forEach(plugin => plugins.set(plugin.id, plugin));
  enabled.forEach(plugin => {
    Object.entries(plugin.requires || {}).forEach(([depId, range]) => {
      const dep = enabled.get(depId);
      if (!dep) {
        pushError(errors, 'requires_missing', '需要先启用插件：' + dependencyLabel(depId, range), plugin.id);
        return;
      }
      if (!satisfies(dep.version, range)) {
        pushError(errors, 'requires_version_mismatch', '依赖版本不满足：' + depId + ' 需要 ' + range +
          '，实际 ' + dep.version, plugin.id);
      }
    });
  });

  const visiting = new Set();
  const visited = new Set();
  const cycleNodes = new Set();
  function visit(id, stack) {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      stack.slice(start >= 0 ? start : 0).forEach(node => cycleNodes.add(node));
      cycleNodes.add(id);
      return;
    }
    visiting.add(id);
    const plugin = enabled.get(id);
    Object.keys(plugin?.requires || {}).forEach(depId => {
      if (enabled.has(depId)) visit(depId, [...stack, id]);
    });
    visiting.delete(id);
    visited.add(id);
  }
  [...enabled.keys()].sort().forEach(id => visit(id, []));
  cycleNodes.forEach(id => {
    pushError(errors, 'requires_cycle', '插件依赖成环：' + id, id);
  });

  const order = [];
  const placed = new Set();
  const blocked = new Set();
  function place(id, path = []) {
    if (placed.has(id) || blocked.has(id)) return;
    if (path.includes(id)) {
      blocked.add(id);
      return;
    }
    const plugin = enabled.get(id);
    if (!plugin) return;
    let ready = true;
    Object.entries(plugin.requires || {}).forEach(([depId, range]) => {
      const dep = enabled.get(depId);
      if (!dep || !satisfies(dep.version, range)) { ready = false; return; }
      place(depId, [...path, id]);
      if (!placed.has(depId)) ready = false;
    });
    if (!ready) {
      blocked.add(id);
      return;
    }
    placed.add(id);
    order.push(id);
  }
  [...enabled.keys()].sort().forEach(id => place(id));
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    plugins,
    order,
  };
}
