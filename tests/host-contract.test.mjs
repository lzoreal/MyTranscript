import { readFileSync } from 'node:fs';
import {
  CONTEXT_PROFILES, CONTRIBUTION_PREFIXES, CONTRIBUTION_TYPES, FIXED_SLOTS, HOST_API_VERSION, KNOWN_PERMISSIONS,
  PAYLOAD_VERSIONS, SCOPED_API_FIELDS,
  apiCompatible, contextKeysFor, payloadKindFor, payloadVersionFor, satisfies,
  validateManifest, validatePluginSet,
} from '../src/player-js/host/contract.js';
import { validateLegacyManifest } from '../src/player-js/host/legacy.js';
import { createTestHost } from './host/test-host.mjs';

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL: ' + message);
    process.exit(1);
  }
}

const base = {
  id: 'home',
  name: '首页',
  version: '1.0.0',
  apiVersion: '2.1',
  permissions: ['ui.dom', 'player'],
  contributions: {
    pages: [{ id: 'home', title: '首页' }],
    slots: [{ id: 'home.hero', slot: 'home.hero.after', order: 10 }],
  },
};

// 1. 合法清单会被归一化
const valid = validateManifest(base);
assert(valid.ok, '合法清单应通过：' + JSON.stringify(valid.errors));
assert(valid.manifest.contributions.pages[0].id === 'home', '贡献点应保留 id');
assert(valid.manifest.contributions.slots[0].slot === 'home.hero.after', '槽位应保留');

// 2. v2 必须声明贡献点；旧插件可以显式放宽
const missing = validateManifest({ ...base, contributions: undefined });
assert(!missing.ok, '严格模式缺 contributions 必须拒绝');
const legacy = validateManifest({ ...base, contributions: undefined, apiVersion: '2.0' }, { strict: false });
assert(legacy.ok, '非严格模式应允许旧插件');

// 2.1 现有官方插件清单：新契约严格模式会拒绝，旧清单适配器必须放行
const studyManifest = JSON.parse(readFileSync(
  new URL('../apps/windows/builtin-plugins/study/plugin.json', import.meta.url),
  'utf8',
));
const oldManifest = {
  ...studyManifest,
  apiVersion: undefined,
  contributions: undefined,
  requires: ['subtitles'],
};
assert(validateManifest(studyManifest).ok, '改后的官方清单应通过 v2 严格校验');
assert(!validateManifest(oldManifest).ok, '旧清单应无法通过 v2 严格校验');
const studyLegacy = validateLegacyManifest({
  ...oldManifest,
  apiVersion: null,
  permissions: null,
  js: '',
  css: '',
  dir: 'C:/plugins/study',
});
assert(studyLegacy.ok, '旧清单应通过适配器：' + JSON.stringify(studyLegacy.errors));
assert(studyLegacy.manifest.apiVersion === '2.0', '缺 apiVersion 应按 2.0 处理');
assert(studyLegacy.manifest.requires.subtitles === '*', '数组依赖应归一化为 *');
assert(studyLegacy.manifest.legacyRequires[0] === 'subtitles', '原依赖数组要保留给旧宿主');

// 2.2 仓库里的六个官方包：严格清单、页面 id 不互斥、贡献键在 main.js 里落地
const officialDirs = ['home', 'library', 'downloads', 'settings', 'subtitles', 'study'];
const officialPages = new Set();
for (const id of officialDirs) {
  const manifestUrl = new URL(`../apps/windows/builtin-plugins/${id}/plugin.json`, import.meta.url);
  const mainUrl = new URL(`../apps/windows/builtin-plugins/${id}/main.js`, import.meta.url);
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
  const src = readFileSync(mainUrl, 'utf8');
  assert(manifest.id === id, '官方包目录名应与 id 一致：' + id);
  assert(String(manifest.apiVersion || '').startsWith('2.'), '官方包应声明 2.x apiVersion：' + id);
  const checked = validateManifest(manifest);
  assert(checked.ok, '官方包应通过严格校验：' + id + ' ' + JSON.stringify(checked.errors));
  for (const page of manifest.contributions.pages || []) {
    assert(!officialPages.has(page.id), '官方包页面 id 不能重复：' + page.id);
    officialPages.add(page.id);
    assert(src.includes(`'page:${page.id}'`), id + ' 的 main.js 缺少 page:' + page.id);
  }
  for (const cap of manifest.contributions.capabilities || []) {
    assert(src.includes(`'capability:${cap.id}'`), id + ' 的 main.js 缺少 capability:' + cap.id);
  }
}

// 3. id、权限、路径、槽位、重复贡献都要拦住
const badId = validateManifest({ ...base, id: '../home' });
assert(!badId.ok && badId.errors.some(e => e.code === 'id_invalid'), '路径式 id 必须拒绝');
const badPerm = validateManifest({ ...base, permissions: ['ui.dom', 'desktop'] });
assert(!badPerm.ok && badPerm.errors.some(e => e.code === 'permission_unknown'), '未知权限必须拒绝');
const badPath = validateManifest({ ...base, main: '../outside.js' });
assert(!badPath.ok && badPath.errors.some(e => e.code === 'path_invalid'), '越界入口必须拒绝');
const badSlot = validateManifest({ ...base, contributions: { slots: [{ id: 'x', slot: 'nope' }] } });
assert(!badSlot.ok && badSlot.errors.some(e => e.code === 'slot_unknown'), '未知槽位必须拒绝');
const dup = validateManifest({
  ...base,
  contributions: { pages: [{ id: 'p' }, { id: 'p' }] },
});
assert(!dup.ok && dup.errors.some(e => e.code === 'contribution_duplicate'), '同一类型重复 id 必须拒绝');

// 4. API 版本：同主版本且次版本不高于宿主
assert(apiCompatible('2.0') === true, '2.0 在 2.2 宿主上应兼容');
assert(apiCompatible('2.1') === true, '2.1 应兼容');
assert(apiCompatible('2.2') === true, '2.2 应兼容');
assert(apiCompatible('2.2', '2.1') === false, '2.2 插件不应在 2.1 宿主上运行');
assert(apiCompatible('2.3') === false, '2.3 不应在 2.2 宿主上运行');
assert(apiCompatible('3.0') === false, '3.x 必须拒绝');
assert(apiCompatible('') === true, '空版本按旧插件兼容');

// 5. semver 范围
assert(satisfies('1.2.3', '^1.0.0'), '^1.0.0 应匹配 1.2.3');
assert(!satisfies('2.0.0', '^1.0.0'), '^1.0.0 不应匹配 2.0.0');
assert(satisfies('1.2.5', '~1.2.0'), '~1.2.0 应匹配 1.2.5');
assert(!satisfies('1.3.0', '~1.2.0'), '~1.2.0 不应匹配 1.3.0');
assert(satisfies('1.9.0', '1.x'), '1.x 应匹配 1.9.0');
assert(!satisfies('1.2.0', '>=1.3.0'), '>=1.3.0 不应匹配 1.2.0');

// 6. 依赖图：顺序、版本不满足、成环、重复 id
const dep = validatePluginSet([
  { ...base, id: 'study', requires: { subtitles: '^1.0.0' } },
  { ...base, id: 'subtitles', contributions: { pages: [{ id: 'subtitles' }] } },
]);
assert(dep.ok, '满足依赖的集合应通过：' + JSON.stringify(dep.errors));
assert(dep.order.join(',') === 'subtitles,study', '依赖必须先排：' + dep.order.join(','));

const mismatch = validatePluginSet([
  { ...base, id: 'study', requires: { subtitles: '^2.0.0' } },
  { ...base, id: 'subtitles' },
]);
assert(!mismatch.ok && mismatch.errors.some(e => e.code === 'requires_version_mismatch'), '版本不满足必须拒绝');

const cycle = validatePluginSet([
  { ...base, id: 'a', requires: { b: '^1.0.0' } },
  { ...base, id: 'b', requires: { a: '^1.0.0' } },
]);
assert(!cycle.ok && cycle.errors.some(e => e.code === 'requires_cycle'), '依赖环必须拒绝');

const duplicate = validatePluginSet([base, { ...base }]);
assert(!duplicate.ok && duplicate.errors.some(e => e.code === 'id_duplicate'), '重复 id 必须拒绝');

// 7. 测试宿主：槽位排序、页面冲突、能力独占、provider 栈、停用回收
const host = createTestHost();
const home = host.add(base, {
  'page:home': { render: () => 'home' },
  'slot:home.hero': { mount: () => 'hero' },
});
assert(home.ok, '首页插件应装配成功：' + JSON.stringify(home.errors));
assert(host.status('home').state === 'active', '首页插件应为 active');
assert(host.slot('home.hero.after')[0].pluginId === 'home', '槽位应能取到首页插件');

host.add({
  ...base,
  id: 'study',
  contributions: {
    pages: [{ id: 'study', title: '学习' }],
    slots: [{ id: 'study.episode', slot: 'episode.header.actions', order: 5 }],
  },
}, {
  'page:study': { render: () => 'study' },
  'slot:study.episode': { mount: () => 'study' },
});
assert(host.slot('episode.header.actions')[0].pluginId === 'study', 'order 小的槽位应排前面');
assert(host.list('slots').map(item => item.id).join(',') === 'study.episode,home.hero',
  '贡献点列表应按 order 返回，供四类扩展入口消费');

const pageConflict = host.add({
  ...base,
  id: 'other',
  contributions: { pages: [{ id: 'home' }] },
}, { 'page:home': { render: () => 'other' } });
assert(!pageConflict.ok && pageConflict.errors.some(text => text.includes('已被插件')), '页面 id 冲突必须拒绝');
assert(host.renderPage('home').ok, '冲突插件不能挤掉原有页面');

const missingImpl = host.add({
  ...base,
  id: 'broken',
  contributions: { pages: [{ id: 'broken' }] },
}, {});
assert(!missingImpl.ok && missingImpl.errors.some(text => text.includes('没有实现')), '声明未实现必须拒绝');

const undeclared = host.add({
  ...base,
  id: 'sneaky',
  contributions: {},
}, { 'page:home': { render: () => 'x' } });
assert(!undeclared.ok && undeclared.errors.some(text => text.includes('没声明')), '未声明的实现必须拒绝');

host.add({
  ...base,
  id: 'caps-a',
  contributions: { capabilities: [{ id: 'subtitles' }] },
}, { 'capability:subtitles': { claim: () => 'a' } });
const capConflict = host.add({
  ...base,
  id: 'caps-b',
  contributions: { capabilities: [{ id: 'subtitles' }] },
}, { 'capability:subtitles': { claim: () => 'b' } });
assert(!capConflict.ok && capConflict.errors.some(text => text.includes('已由插件')), '能力不能被两个插件同时接管');
assert(host.claimOwner('subtitles') === 'caps-a', '能力 owner 应保持第一个插件');

host.add({
  ...base,
  id: 'provider-a',
  contributions: { providers: [{ id: 'catalog' }] },
}, { 'provider:catalog': { loadShows: () => 'a' } });
host.add({
  ...base,
  id: 'provider-b',
  contributions: { providers: [{ id: 'catalog' }] },
}, { 'provider:catalog': { loadShows: () => 'b' } });
assert(host.providerOwner('catalog') === 'provider-b', '后注册 provider 应在栈顶');
host.stop('provider-b');
assert(host.providerOwner('catalog') === 'provider-a', '停用顶层 provider 应回退到下层');
host.stop('provider-a');
assert(host.providerOwner('catalog') === '', '全部停用后应回默认实现');

// 8. 单插件运行时抛错只影响自己，别的页面仍可用
host.add({
  ...base,
  id: 'page-boom',
  contributions: { pages: [{ id: 'boom' }], commands: [{ id: 'boom' }] },
}, {
  'page:boom': { render: () => { throw new Error('渲染失败'); } },
  'command:boom': { run: () => { throw new Error('命令失败'); } },
});
const boom = host.renderPage('boom');
assert(!boom.ok && boom.error.includes('渲染失败'), '插件页面异常应被捕获');
assert(host.status('page-boom').state === 'error', '异常插件应进入 error');
assert(host.renderPage('home').ok, '单个插件异常不能拖垮其他页面');

host.stop('home');
assert(host.status('home').state === 'disabled', '停用后状态应为 disabled');
assert(host.renderPage('home').ok === false, '停用后页面应被回收');

// 9. 公共 API 快照：2.x 只增不破，这些表变了就要走 3.0
assert(HOST_API_VERSION === '2.2', '宿主 API 版本快照变了：' + HOST_API_VERSION);
assert(CONTRIBUTION_TYPES.length === 10, '贡献点类型数量变了：' + CONTRIBUTION_TYPES.join(','));
assert(JSON.stringify(FIXED_SLOTS) === JSON.stringify([
  'nav.main', 'home.hero.after', 'home.continue.actions', 'episode.header.actions',
  'episode.body.before', 'player.dock.actions', 'player.sidebar', 'settings.panes',
  'library.toolbar', 'downloads.empty', 'search.results.after',
]), '固定槽位表变了：' + FIXED_SLOTS.join(','));
assert(JSON.stringify(KNOWN_PERMISSIONS) === JSON.stringify([
  // media 是 2.2 追加的本机媒体处理权限（探测 / 裁片段 / 只取音轨）；
  // 加它能改这张表，但必须同时改这里的期望值，避免悄悄扩权。
  'ui.dom', 'net', 'player', 'storage', 'providers', 'subtitles', 'study', 'media', 'llm',
]), '已知权限表变了：' + KNOWN_PERMISSIONS.join(','));

// 9.1 2.2 的按类型档案：每种贡献都有自己的上下文组与 payload 版本
for (const type of CONTRIBUTION_TYPES) {
  assert(CONTEXT_PROFILES[type], '每种贡献都要有 2.2 档案：' + type);
  assert(SCOPED_API_FIELDS[type] !== undefined, '每种贡献都要声明 api 投影：' + type);
  assert(payloadKindFor(type), '每种贡献都要有 payload 类型：' + type);
  assert(payloadVersionFor(type) >= 1, 'payload 版本必须从 1 起：' + type);
}
assert(contextKeysFor('slots', '2.2').indexOf('settings') === -1, '槽位不该拿到 settings 服务');
assert(contextKeysFor('themes', '2.2').length === 0, '主题只需要 css，不该拿到任何上下文组');
assert(contextKeysFor('pages', '2.2').length === 11, '页面保留完整 11 组：' + contextKeysFor('pages', '2.2').join(','));
assert(contextKeysFor('slots', '2.1').length === 11, '2.1 插件走完整兼容档案');
assert(contextKeysFor('searchSources', '2.1').length === 11, '2.1 搜索源同样保持完整上下文');
assert(SCOPED_API_FIELDS.pages === null, '页面拿完整 api');
assert(SCOPED_API_FIELDS.themes.length === 0, '主题不拿 api');
// 槽位也要能存自己的东西（摘录卡片、广告开关、片段库都靠它），否则 api.storage 是 undefined。
assert(SCOPED_API_FIELDS.slots.includes('storage'), '槽位必须拿到 storage');
assert(SCOPED_API_FIELDS.slots.includes('media') && SCOPED_API_FIELDS.slots.includes('llm'),
  '槽位必须拿到 media 与 llm');
// 「本集问答」这类槽位在未配置 AI 时要把用户送到设置页，投影里不能把 openSettings 过滤掉。
assert(SCOPED_API_FIELDS.slots.includes('openSettings'), '槽位必须拿到 openSettings');
assert(PAYLOAD_VERSIONS.searchResult === 1, '搜索结果独立版本号');
assert(payloadKindFor('searchSources') === 'searchResult', '搜索源的 payload 类型是 searchResult');

// 10. 槽位挂载：payload、order、异常隔离、停用回收
const mountHost = createTestHost();
mountHost.add({
  ...base, id: 'slot-a',
  contributions: { slots: [{ id: 'a.one', slot: 'home.hero.after', order: 20 }] },
}, { 'slot:a.one': { mount: (el, ctx, payload) => { el.marker = 'a'; el.payload = payload; } } });
mountHost.add({
  ...base, id: 'slot-b',
  contributions: { slots: [{ id: 'b.one', slot: 'home.hero.after', order: 10 }] },
}, { 'slot:b.one': { mount: el => { el.marker = 'b'; } } });
const mounted = mountHost.mountSlot('home.hero.after', { route: 'home' });
assert(mounted.element.children.length === 2, '两个插件都应挂进同一槽位');
assert(mounted.element.children[0].pluginId === 'slot-b', 'order 小的应排前面');
assert(mounted.element.children[0].marker === 'b', '槽位内容应由插件自己画');
assert(mounted.element.children[1].payload.route === 'home', 'payload 应原样传给插件');
mounted.dispose();
assert(mounted.element.children.length === 0, '卸载后槽位应清空');

mountHost.add({
  ...base, id: 'slot-boom',
  contributions: { slots: [{ id: 'boom.one', slot: 'home.continue.actions' }] },
}, { 'slot:boom.one': { mount: () => { throw new Error('槽位渲染失败'); } } });
mountHost.add({
  ...base, id: 'slot-ok',
  contributions: { slots: [{ id: 'ok.one', slot: 'home.continue.actions' }] },
}, { 'slot:ok.one': { mount: el => { el.marker = 'ok'; } } });
const isolated = mountHost.mountSlot('home.continue.actions');
assert(isolated.element.children.length === 1, '抛错的槽位项不能拖垮同一槽位的其他插件');
assert(isolated.element.children[0].marker === 'ok', '正常插件应继续挂载');
assert(mountHost.status('slot-boom').state === 'error', '槽位抛错的插件应进入 error');
isolated.dispose();

mountHost.stop('slot-a');
const afterStop = mountHost.mountSlot('home.hero.after');
assert(afterStop.element.children.length === 1 && afterStop.element.children[0].pluginId === 'slot-b', '停用插件后只剩自己的槽位项');
afterStop.dispose();

// 11. 设置分区：按 pane 过滤、插件自己渲染、异常隔离
const paneHost = createTestHost();
paneHost.add({
  ...base, id: 'pane-a',
  contributions: { settings: [{ id: 'a.plugins', pane: 'plugins' }] },
}, { 'settings:a.plugins': { render: el => { el.marker = 'pane'; } } });
paneHost.add({
  ...base, id: 'pane-b',
  contributions: { settings: [{ id: 'b.reader', pane: 'reader' }] },
}, { 'settings:b.reader': { render: el => { el.marker = 'reader'; } } });
const pluginsPane = paneHost.mountSettings('plugins');
assert(pluginsPane.element.children.length === 1, '只能挂到 pane 相同的设置项');
assert(pluginsPane.element.children[0].marker === 'pane', '设置分区内容应由插件自己画');
assert(paneHost.mountSettings('reader').element.children[0].marker === 'reader', '另一个 pane 应各自渲染');
assert(paneHost.mountSettings('about').element.children.length === 0, '没人认领的 pane 应为空');

// 12. 聚合贡献同名不冲突：同 id 由不同插件提供时必须并存，停用只摘自己
const aggregateHost = createTestHost();
const menuContribution = { contributions: { menus: [{ id: 'export' }] } };
aggregateHost.add({ ...base, id: 'menu-a', ...menuContribution }, {
  'menu:export': { run: () => 'a' },
});
aggregateHost.add({ ...base, id: 'menu-b', ...menuContribution }, {
  'menu:export': { run: () => 'b' },
});
assert(aggregateHost.list('menus').length === 2,
  '不同插件的同名菜单必须同时存在：' + JSON.stringify(aggregateHost.list('menus')));
assert(aggregateHost.list('menus').map(item => item.pluginId).sort().join(',') === 'menu-a,menu-b',
  '聚合列表要保留两个 owner');
aggregateHost.stop('menu-b');
assert(aggregateHost.list('menus').length === 1 &&
  aggregateHost.list('menus')[0].pluginId === 'menu-a',
  '停用一个插件不能带走另一个插件的同名贡献');

// 13. 2.2 示例插件：清单严格通过、声明与实现一一对应、测试宿主能装配
const exampleManifest = JSON.parse(readFileSync(
  new URL('../examples/plugins/search-echo/plugin.json', import.meta.url), 'utf8'));
const exampleSource = readFileSync(
  new URL('../examples/plugins/search-echo/main.js', import.meta.url), 'utf8');
assert(validateManifest(exampleManifest).ok,
  '示例插件清单应通过严格校验：' + JSON.stringify(validateManifest(exampleManifest).errors));
assert(exampleManifest.apiVersion === '2.2', '示例插件应声明 2.2');
const exampleImpls = {};
const exampleMissing = [];
for (const [type, list] of Object.entries(exampleManifest.contributions)) {
  for (const entry of list) {
    const key = CONTRIBUTION_PREFIXES[type] + ':' + entry.id;
    assert(exampleSource.includes(`'${key}'`), '示例插件 main.js 缺少实现：' + key);
    exampleImpls[key] = type === 'slots' ? { mount: () => {} }
      : type === 'searchSources' ? { search: () => 'ok' }
        : type === 'menus' ? { run: () => {} }
          : { css: ':root{}' };
    exampleMissing.push(key);
  }
}
assert(exampleMissing.length === 4, '示例插件应覆盖四类贡献：' + exampleMissing.join(','));
const exampleHost = createTestHost();
const exampleAdd = exampleHost.add(exampleManifest, exampleImpls);
assert(exampleAdd.ok, '示例插件应在测试宿主里装配成功：' + JSON.stringify(exampleAdd.errors));
assert(exampleHost.status('search-echo').state === 'active', '示例插件应为 active');
assert(exampleHost.list('searchSources').length === 1, '示例搜索源应可被宿主列出');

console.log('host contract OK');
