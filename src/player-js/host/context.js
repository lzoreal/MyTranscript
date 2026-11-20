/* 贡献点上下文构造：只装配该类型声明过的能力组，并给每类 payload 带独立版本号。
   这一层不碰 DOM、不碰播放器，可在 node 里直接测；宿主只负责把 api 与 kit 工厂传进来。 */
import {
  CONTEXT_RULES_VERSION, HOST_API_VERSION,
  contextKeysFor, payloadKindFor, payloadVersionFor, scopedApiFieldsFor,
} from './contract.js';

const KIT_KEYS = Object.freeze(['ui', 'catalog', 'progress', 'downloads', 'settings']);

export function projectApi(api, fields) {
  if (!fields) return api;
  const out = {};
  fields.forEach(key => {
    if (Object.prototype.hasOwnProperty.call(api, key)) out[key] = api[key];
  });
  return Object.freeze(out);
}

/* options:
     type            贡献类型（复数的 contributions 键）
     id              贡献 id
     apiVersion      插件清单声明的 API 版本（决定走 2.2 窄档案还是 2.1 兼容档案）
     api             宿主为这个插件构造的 api 对象
     kits            { ui, catalog, progress, downloads, settings } 工厂
     signal          AbortSignal（可空）
     payloadVersion  覆盖默认 payload 版本（宿主按锚点标记传入）
   返回冻结对象；未在档案里的组不会出现，读取即为 undefined。 */
export function createContributionContext(options = {}) {
  const type = String(options.type || '');
  const id = String(options.id || '');
  // 没写 apiVersion 按 2.0：收窄必须是插件明确声明的结果，不能是宿主默认。
  const apiVersion = options.apiVersion || '2.0';
  const keys = options.keys || contextKeysFor(type, apiVersion);
  const api = options.api || {};
  const kits = options.kits || {};
  const payloadKind = payloadKindFor(type);
  const payloadVersion = Number.isFinite(Number(options.payloadVersion))
    ? Number(options.payloadVersion)
    : payloadVersionFor(type);
  const ctx = {
    id,
    apiVersion: HOST_API_VERSION,
    contextVersion: CONTEXT_RULES_VERSION,
    contribution: type,
    payloadKind,
    payloadVersion,
    signal: options.signal || null,
  };
  if (keys.includes('api')) ctx.api = projectApi(api, scopedApiFieldsFor(type, apiVersion));
  if (keys.includes('player') && api.player) ctx.player = api.player;
  if (keys.includes('events') && typeof api.on === 'function') ctx.events = Object.freeze({ on: api.on });
  if (keys.includes('storage') && api.storage) ctx.storage = api.storage;
  if (keys.includes('navigate') && typeof api.navigate === 'function') ctx.navigate = api.navigate;
  if (keys.includes('capability')) {
    ctx.capability = options.capability || null;
  }
  KIT_KEYS.forEach(name => {
    if (!keys.includes(name)) return;
    const factory = kits[name];
    ctx[name] = typeof factory === 'function' ? factory() : factory;
  });
  return Object.freeze(ctx);
}

/* 给设置页/诊断用：报告某类型当前拿到哪些组，不构造对象。 */
export function describeContext(type, apiVersion) {
  const keys = contextKeysFor(type, apiVersion);
  const apiFields = scopedApiFieldsFor(type, apiVersion);
  return {
    type: String(type || ''),
    apiVersion,
    keys: [...keys],
    apiFields: apiFields ? [...apiFields] : null,
    payloadKind: payloadKindFor(type),
    payloadVersion: payloadVersionFor(type),
  };
}
