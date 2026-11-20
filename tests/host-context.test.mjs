import { readFileSync } from 'node:fs';
import { contextKeysFor } from '../src/player-js/host/contract.js';
import { createContributionContext, projectApi, describeContext } from '../src/player-js/host/context.js';

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL: ' + message);
    process.exit(1);
  }
}

const api = {
  id: 'demo',
  version: '2.2',
  apiVersion: '2.2',
  host: {},
  toast: () => {},
  navigate: () => {},
  openEpisode: () => {},
  el: () => null,
  on: () => () => {},
  command: () => {},
  storage: {},
  player: { state: () => ({}) },
  cues: () => [],
  subtitles: { claim: () => true },
  study: { engine: () => null },
};
const kits = {
  ui: () => ({ esc: String }),
  catalog: () => ({ subs: () => [] }),
  progress: () => ({ all: () => ({}) }),
  downloads: () => ({ entries: () => [] }),
  settings: () => ({ prefs: {} }),
};
const capability = name => ({ owner: () => '', active: () => false });

// 1. 2.2 槽位：没有 settings/downloads...（按档案）、api 只留白名单字段
const slotCtx = createContributionContext({
  type: 'slots', id: 'x.one', apiVersion: '2.2', api, kits, capability,
});
assert(slotCtx.contextVersion === '2.2', '上下文规则版本应为 2.2');
assert(slotCtx.payloadKind === 'slot', '槽位 payload 类型错误：' + slotCtx.payloadKind);
assert(slotCtx.payloadVersion === 1, '槽位 payload 版本应为 1');
assert(!('settings' in slotCtx), '2.2 槽位不应拿到 settings');
assert(slotCtx.ui && slotCtx.catalog, '槽位应保留 ui/catalog');
assert(!('subtitles' in slotCtx.api), '槽位 api 不应暴露 subtitles');
assert(!('study' in slotCtx.api), '槽位 api 不应暴露 study');
assert(typeof slotCtx.api.toast === 'function', '槽位 api 保留 toast');

// 2. 主题：什么都没有，但仍然能读到版本与信号
const themeCtx = createContributionContext({ type: 'themes', id: 'sunset', apiVersion: '2.2', api, kits });
assert(Object.keys(themeCtx).sort().join(',') ===
  'apiVersion,contribution,contextVersion,id,payloadKind,payloadVersion,signal'.split(',').sort().join(','),
  '主题上下文只应有版本字段：' + Object.keys(themeCtx).join(','));
assert(!('api' in themeCtx) && !('ui' in themeCtx), '主题不应拿到 api/ui');

// 3. 2.1 插件：完整兼容档案，api 不投影
const legacyCtx = createContributionContext({
  type: 'slots', id: 'x.legacy', apiVersion: '2.1', api, kits, capability,
});
for (const key of ['player', 'events', 'storage', 'navigate', 'capability', 'api', 'ui',
  'catalog', 'progress', 'downloads', 'settings']) {
  assert(key in legacyCtx, '2.1 兼容档案缺组：' + key);
}
assert(legacyCtx.api.subtitles, '2.1 插件保留完整 api');
assert(legacyCtx.payloadVersion === 1, '兼容档案也要带 payload 版本');

// 4. 显式覆盖 payload 版本 + 外部信号
const controller = new AbortController();
const pageCtx = createContributionContext({
  type: 'pages', id: 'home', apiVersion: '2.2', api, kits, capability,
  signal: controller.signal, payloadVersion: 3,
});
assert(pageCtx.payloadVersion === 3, 'payload 版本应可按锚点覆盖');
assert(pageCtx.signal === controller.signal, 'ctx.signal 必须是外部传进来的那个');
assert(Object.isFrozen(pageCtx), '上下文必须冻结');

// 5. 投影函数：白名单只保留存在的键
const projected = projectApi(api, ['id', 'toast', 'nope']);
assert(JSON.stringify(Object.keys(projected)) === JSON.stringify(['id', 'toast']),
  '投影应只保留白名单且存在的方法：' + Object.keys(projected).join(','));

// 6. describeContext：用于设置页/诊断，不构造对象
const described = describeContext('searchSources', '2.2');
assert(described.payloadKind === 'searchResult', '搜索源的 payload 类型应为 searchResult');
assert(described.keys.indexOf('api') >= 0 && described.keys.indexOf('settings') === -1,
  '搜索源档案不应包含 settings');

// 7. 旧插件持续验证新宿主：同一份清单的 2.1 与 2.2 装配必须分道
const builtinDirs = ['home', 'library', 'downloads', 'settings', 'subtitles', 'study'];
for (const id of builtinDirs) {
  const manifest = JSON.parse(readFileSync(
    new URL(`../apps/windows/builtin-plugins/${id}/plugin.json`, import.meta.url), 'utf8'));
  assert(manifest.id === id, '内置包目录名应与 id 一致：' + id);
  const legacyKeys = contextKeysFor('slots', manifest.apiVersion);
  const narrowKeys = contextKeysFor('slots', '2.2');
  assert(legacyKeys.length === 11, id + ' 的 2.1 清单应走完整档案');
  assert(narrowKeys.length < legacyKeys.length, '2.2 槽位档案必须真的更窄');
  assert(narrowKeys.indexOf('settings') === -1, '2.2 槽位不应有 settings');
}
const exampleManifest = JSON.parse(readFileSync(
  new URL('../examples/plugins/search-echo/plugin.json', import.meta.url), 'utf8'));
const exampleCtx = createContributionContext({
  type: 'slots', id: 'searchAfter', apiVersion: exampleManifest.apiVersion, api, kits, capability,
});
assert(!('settings' in exampleCtx), '2.2 示例槽位不应拿到 settings');
assert('downloads' in exampleCtx, 'downloads.empty 槽位仍需要下载服务');

console.log('host context OK');
