"""插件宿主：依赖解析（含环）与能力占用的行为测试。

从 04 分片里切出 PluginHost 对象文本，在 node 里用最小桩执行，不依赖浏览器。
"""
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
PART = ROOT / "src" / "player-js" / "04-local-audio-plugin-host.js"

PRELUDE = """
const app = { capabilities: {}, plugins: [], pluginErrors: new Map() };
const document = { body: { dataset: {} } };
function definitionStarted() { return false; }
function host() { return null; }
const pluginCleanups = new Map();
function trackPlugin(id, fn) {
  const key = String(id);
  if (!pluginCleanups.has(key)) pluginCleanups.set(key, []);
  pluginCleanups.get(key).push(fn);
}
const PLUGIN_FAULTS = { invoke(id, scope, fn) { try { return fn(); } catch (e) { return undefined; } } };
function guardedPluginCall(id, scope, fn) { return PLUGIN_FAULTS.invoke(id, scope, fn); }
"""

CASES = r"""
function plugin(id, requires, enabled = true) {
  return { id, requires, enabled };
}

function assert(cond, msg) { if (!cond) { console.error('FAIL: ' + msg); process.exit(1); } }

// 1. A→B→A 的环必须判为不满足
const cyc = [plugin('a', ['b']), plugin('b', ['a'])];
assert(PluginHost.available('a', cyc) === false, '环 a→b→a 应不满足');
assert(PluginHost.available('b', cyc) === false, '环 b→a→b 应不满足');
assert(PluginHost.missingRequires(cyc[0], cyc).length === 1, '环应报缺失依赖');

// 2. 自依赖
const self = [plugin('s', ['s'])];
assert(PluginHost.available('s', self) === false, '自依赖应不满足');

// 3. 菱形依赖不能误伤：a→(b,c)→d
const dia = [plugin('a', ['b', 'c']), plugin('b', ['d']), plugin('c', ['d']), plugin('d', [])];
assert(PluginHost.available('a', dia) === true, '菱形依赖应满足');
assert(PluginHost.available('d', dia) === true, '叶子应满足');

// 4. 停用的依赖不满足
const off = [plugin('x', ['y']), plugin('y', [], false)];
assert(PluginHost.available('x', off) === false, '依赖被停用应不满足');

// 5. 能力占用：同一能力不能被两个插件拿走
PluginHost.applyLayout = () => {};
PluginHost.claim('p1', 'subtitles');
assert(PluginHost.owner('subtitles') === 'p1', 'owner 应是 p1');
let threw = false;
try { PluginHost.claim('p2', 'subtitles'); } catch (e) { threw = true; }
assert(threw, '第二个插件 claim 同一能力应抛错');
assert(PluginHost.claim('p1', 'subtitles') === true, '同一插件重复 claim 应允许');

// 6. 内核注册要带 owner：别人不能覆盖，停用后按 owner 回收
PluginHost.registerKernel('p1', 'transcript', { render: () => 'p1' });
assert(PluginHost.kernel('transcript').render() === 'p1', '内核应按名字取回');
threw = false;
try { PluginHost.registerKernel('p2', 'transcript', { render: () => 'p2' }); } catch (e) { threw = true; }
assert(threw, '另一个插件不能直接覆盖已注册内核');
pluginCleanups.get('p1').forEach(fn => fn());
assert(PluginHost.kernel('transcript') === null, '插件停用后内核必须移除');

console.log('plugin host OK');
"""



LIFECYCLE_CASES = r"""
const PLUGIN_REGISTRY = new Map();
const PLUGIN_GRANTS = new Map();
const PLUGIN_FAULTS = { invoke(id, scope, fn) { try { return fn(); } catch (e) { return undefined; } } };
function guardedPluginCall(id, scope, fn) { return PLUGIN_FAULTS.invoke(id, scope, fn); }
function pluginReportError(id, err) { throw err; }
function abortPluginScopes() { return 0; }
const PLUGIN_SEARCH_GATE = { snapshot: () => ({ key: '' }), invalidate: () => true };
const releasedCaps = [];
function releasePluginCapabilities(id) { releasedCaps.push(String(id)); }
function releaseSurfaces(id) { releasedCaps.push('surface:' + String(id)); }
let disposed = 0;
PLUGIN_REGISTRY.set('demo', { __started: true, __dispose() { disposed += 1; } });

const calls = [];
trackPlugin('demo', () => calls.push('a'));
trackPlugin('demo', () => calls.push('b'));
trackPlugin('other', () => calls.push('x'));
runPluginCleanup('demo');
assert(calls.join(',') === 'b,a', '应按注册逆序回收本插件注册物：' + calls.join(','));
runPluginCleanup('demo');
assert(calls.length === 2, '重复回收不应再调用');
stopPlugin('demo');
assert(disposed === 1, 'stopPlugin 应调用一次 dispose');
const def = PLUGIN_REGISTRY.get('demo');
assert(def.__dispose === null, 'dispose 用过后应清空');
assert(def.__started === false, 'stopPlugin 应把 __started 置 false');

// 单个清理函数抛错不影响后续回收
const seen = [];
trackPlugin('bad', () => { seen.push(1); throw new Error('boom'); });
trackPlugin('bad', () => seen.push(2));
runPluginCleanup('bad');
assert(seen.length === 2, '抛错的清理函数不应中断其余回收');

// setup 中途失败：已注册物、能力、权限都要回收，和停用走同一条路径
const failed = { __started: true };
PLUGIN_REGISTRY.set('boom', failed);
PLUGIN_GRANTS.set('boom', new Set(['ui.dom']));
trackPlugin('boom', () => calls.push('cleanup-on-fail'));
abortPluginStart('boom', failed);
assert(calls.includes('cleanup-on-fail'), 'setup 失败必须回收已注册物');
assert(releasedCaps.includes('boom'), 'setup 失败必须释放已接管的能力');
assert(!PLUGIN_GRANTS.has('boom'), 'setup 失败必须清掉权限授予');
assert(failed.__started === false, 'setup 失败必须复位 __started');

console.log('lifecycle OK');
"""

CONSENT_CASES = r"""
const key = 'demo';
assert(pluginConsentState(key) === '', '未授权时应为空');
setPluginConsent(key, true);
assert(pluginConsentState(key) === 'allow', '允许后应记 allow');
setPluginConsent(key, false);
assert(pluginConsentState(key) === 'deny', '拒绝后应记 deny');
clearPluginConsent(key);
assert(pluginConsentState(key) === '', '撤销后应清空');

// 文件指纹钉扎：授权时记下内容，之后变了就要重新授权
setPluginConsent(key, true);
setPluginPinnedHash(key, 'h1');
assert(pluginPinnedHash(key) === 'h1', '授权时要把指纹钉住');
assert(pluginConsentChanged({ id: key, hash: 'h1' }) === false, '内容没变不必重新授权');
assert(pluginConsentChanged({ id: key, hash: 'h2' }) === true, '内容变了必须重新授权');
assert(pluginConsentChanged({ id: key, builtin: true, hash: 'h2' }) === false, '内置插件不参与钉扎');
assert(pluginConsentChanged({ id: key }) === false, '没有指纹时不做变更判断');
clearPluginConsent(key);
assert(pluginPinnedHash(key) === '', '撤销授权要连指纹一起清掉');
console.log('consent OK');
"""


def slice_block(text: str, starts: int, open_char: str = "{", close_char: str = "}") -> str:
    """从 starts 处的开括号起配平，返回完整块（含首尾括号）。"""
    depth = 0
    for i in range(starts, len(text)):
        if text[i] == open_char:
            depth += 1
        elif text[i] == close_char:
            depth -= 1
            if depth == 0:
                return text[starts:i + 1]
    raise AssertionError("块没有闭合")


def extract_lifecycle() -> str:
    """切出插件注册物记账（trackPlugin / runPluginCleanup）与 stopPlugin。"""
    text = PART.read_text(encoding="utf-8")
    head = text.index("const PLUGIN_CLEANUP")
    tail = text.index("let pluginApiReady")
    body = text[head:tail]
    stop_at = text.index("function stopPlugin(id)")
    brace = text.index("{", stop_at)
    abort_at = text.index("function abortPluginStart")
    abort_brace = text.index("{", abort_at)
    return (body + text[stop_at:brace] + slice_block(text, brace)
            + text[abort_at:abort_brace] + slice_block(text, abort_brace))

def extract_consent() -> str:
    text = PART.read_text(encoding="utf-8")
    head = text.index("const PLUGIN_CONSENT_PREFIX")
    tail_at = text.index("function clearPluginConsent")
    tail = text.index("{", tail_at)
    return text[head:tail_at] + text[tail_at:tail] + slice_block(text, tail)


def extract_host() -> str:
    text = PART.read_text(encoding="utf-8")
    start = text.index("const PluginHost = {")
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1] + ";"
    raise AssertionError("没有找到 PluginHost 对象的结尾")


def extract_providers() -> str:
    text = (ROOT / "src" / "player-js" / "02-live-caption-wasm.js").read_text(encoding="utf-8")
    head = text.index("const CORE_PROVIDER_NAMES")
    tail_at = text.index("function coreProviderOwner")
    tail = text.index("{", tail_at)
    return text[head:tail_at] + text[tail_at:tail] + slice_block(text, tail)


def extract_permissions() -> str:
    text = PART.read_text(encoding="utf-8")
    start = text.index("const PLUGIN_PERMISSIONS")
    end = text.index("window.MyTGuard = {")
    tail = text.index("};", end) + 2
    return text[start:tail]


class PluginHostTests(unittest.TestCase):
    def test_dependency_and_capability_rules(self):
        script = PRELUDE + "\n" + extract_host() + "\n" + CASES
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as fh:
            fh.write(script)
            path = fh.name
        proc = subprocess.run(["node", path], capture_output=True, text=True)
        Path(path).unlink(missing_ok=True)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("plugin host OK", proc.stdout)

    def test_lifecycle_cleanup(self):
        script = "function assert(c, m){ if(!c){ console.error('FAIL: '+m); process.exit(1); } }\n" + extract_lifecycle() + "\n" + LIFECYCLE_CASES
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as fh:
            fh.write(script)
            path = fh.name
        proc = subprocess.run(["node", path], capture_output=True, text=True)
        Path(path).unlink(missing_ok=True)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("lifecycle OK", proc.stdout)

    def test_api_version_uses_shared_contract(self):
        text = PART.read_text(encoding="utf-8")
        self.assertIn("import { apiCompatible, HOST_API_VERSION, satisfies } from './host/contract.js';", text,
                      "宿主必须复用契约层的版本判断")
        self.assertNotIn("function pluginApiCompatible", text,
                         "不能再保留只比主版本的本地判断")
        load = text.index("async function loadPlugins()")
        self.assertIn("apiCompatible(plugin.apiVersion", text[load:],
                      "插件加载必须按次版本兼容规则校验")
        api = text.index("function ensurePluginApi()")
        self.assertGreaterEqual(text[api:].count("assertPluginApi(definition.apiVersion)"), 2,
                                "register/define 必须使用同一个版本判断")
        self.assertIn("apiCompatible(want, PLUGIN_API_VERSION)", text,
                      "版本判断本身应委托给共享契约")

    def test_api_version_comes_from_shared_contract(self):
        text = PART.read_text(encoding="utf-8")
        self.assertIn("import { apiCompatible, HOST_API_VERSION, satisfies } from './host/contract.js';", text,
                      "宿主版本号必须直接复用契约常量")
        self.assertIn("const PLUGIN_API_VERSION = HOST_API_VERSION;", text,
                      "不能在宿主再手写一份 API 版本号")

    def test_host_static_imports_are_exported_by_theme_shell(self):
        text = PART.read_text(encoding="utf-8")
        match = re.search(r"import \{([^}]+)\} from './01-theme-reader-shell.js';", text)
        self.assertIsNotNone(match, "找不到宿主对主题模块的静态 import")
        names = {name.strip() for name in match.group(1).split(",") if name.strip()}
        shell = (ROOT / "src" / "player-js" / "01-theme-reader-shell.js").read_text(encoding="utf-8")
        export_block = shell.split("export {", 1)[1].split("};", 1)[0]
        exported = {name.strip() for name in export_block.split(",") if name.strip()}
        missing = sorted(names - exported)
        self.assertEqual(missing, [], "主题模块缺少宿主静态 import 的导出，页面会整块加载失败")

    def test_fault_boundary_covers_contributions_and_cleanup(self):
        text = PART.read_text(encoding="utf-8")
        self.assertIn("createPluginFaultBoundary", text,
                      "宿主必须复用可测试的故障边界")
        self.assertIn("const PLUGIN_FAULTS = createPluginFaultBoundary({ reportError: pluginReportError });",
                      text, "故障边界必须把错误回写到插件诊断")
        contribution = text[text.index("async function runPluginContribution"):text.index("/* 兼容旧调用点")]
        self.assertIn("PLUGIN_FAULTS.run(rec.pluginId, type + ':' + id,", contribution,
                      "菜单/导入器/搜索源失败必须进入插件诊断")
        self.assertIn("pluginAbortScope(", contribution, "每次贡献调用都要有可中止的作用域")
        cleanup = text[text.index("function runPluginCleanup"):text.index("let pluginApiReady")]
        self.assertIn("PLUGIN_FAULTS.invoke(String(id), 'cleanup', fn)", cleanup,
                      "清理函数必须走异步故障边界")
        stop = text[text.index("function stopPlugin"):text.index("function abortPluginStart")]
        self.assertIn("guardedPluginCall(key, 'dispose'", stop,
                      "异步 dispose 必须被等待并诊断")
        self.assertIn("abortPluginScopes(key)", stop, "停用前必须先叫停在途任务")
        page = text[text.index("function renderPluginPage"):text.index("async function refreshPluginSettings")]
        self.assertIn("guardedPluginCall(previousPage.pluginId, 'page:destroy'", page,
                      "异步页面销毁必须被隔离")

    def test_search_generation_and_theme_exclusion_are_wired(self):
        text = PART.read_text(encoding="utf-8")
        self.assertIn("import { createRequestGate } from './host/requests.js';", text,
                      "搜索竞态必须使用可测试的请求代次")
        self.assertIn("const PLUGIN_SEARCH_GATE = createRequestGate();", text)
        adapter = (ROOT / "src" / "player-js" / "host" / "ui-adapters.js").read_text(encoding="utf-8")
        for needle in ("port.searchGate.begin(", "port.searchGate.current(",
                       "port.searchGate.invalidate()"):
            self.assertIn(needle, adapter, "搜索源扣留/覆盖/失效缺少网关校验：" + needle)
        self.assertIn("port.searchGate.signal()", adapter,
                      "搜索请求必须把 signal 传进插件任务")
        self.assertIn("runContribution(owner, 'searchSources', id, 'search', [query], { signal })", adapter,
                      "搜索调用必须带上取消信号")
        self.assertIn("preparePluginTheme", adapter, "应用插件主题前必须让宿主停用自定义主题")
        self.assertIn("preparePluginTheme: disableCustomThemeForPlugin", text,
                      "宿主要把停用自定义主题的动作交给 adapter")
        self.assertIn("function disableCustomThemeForPlugin()", text,
                      "停用自定义主题的实现仍应留在宿主（它读的是宿主配置）")
        self.assertIn("doc.addEventListener('myt:theme-change'", adapter,
                      "应用自定义/内置主题时必须回收插件主题")
        # 主题的应用与广播归 13-theme（C 第一刀把主题搬出 01），01 只留同名转发。
        theme = (ROOT / "src" / "player-js" / "13-theme.js").read_text(encoding="utf-8")
        self.assertIn("new CustomEvent('myt:theme-change'", theme,
                      "主题模块必须广播主题切换")

    def test_ui_adapters_own_the_dom_glue(self):
        host = PART.read_text(encoding="utf-8")
        adapter = (ROOT / "src" / "player-js" / "host" / "ui-adapters.js").read_text(encoding="utf-8")
        self.assertIn("import { createPluginExtensionAdapters", host,
                      "宿主必须从独立 adapter 装配扩展入口")
        self.assertIn("PLUGIN_EXTENSIONS.bindEvents()", host, "宿主必须只做一次事件绑定")
        for owned in ("pluginMenuPop", "pluginSearchResults", "themeGrid", "data-plugin-theme"):
            self.assertIn(owned, adapter, "adapter 应拥有这段 DOM：" + owned)
            if owned in ("pluginMenuPop", "themeGrid"):
                self.assertNotIn(owned, host, "宿主不应再直接操作 " + owned)
        for exported in ("renderMenu", "renderImporters", "renderSearchSources", "renderThemes", "bindEvents"):
            self.assertIn(exported, adapter, "adapter 缺少入口：" + exported)
        self.assertIn("normalizeSearchResult", adapter, "搜索结果必须按版本归一化")

    def test_async_calls_are_guarded_and_diagnosed(self):
        text = PART.read_text(encoding="utf-8")
        self.assertIn("import { DEFAULT_PLUGIN_TIMEOUT_MS, createPluginDiagnostics, createPluginFaultBoundary, describePluginError, runPluginTask }",
                      text, "宿主必须复用可测试的故障封装")
        for needle in ("const PLUGIN_DIAGNOSTICS", "function pluginDiagnosticsText",
                       "function watchPluginPromise", "watchPluginPromise(rec.pluginId, 'event:' + event"):
            self.assertIn(needle, text, "缺少异步故障入口：" + needle)
        load = text.index("async function loadPlugins()")
        self.assertIn("await window.MyTPlugins.start(id)", text[load:],
                      "异步 setup 必须被等待，失败才能回滚")

    def test_study_bridge_is_narrow(self):
        text = PART.read_text(encoding="utf-8")
        for needle in ("function studyStateView", "function studyAudioView",
                       "function studyTranslateView", "function studyTranslateCacheView",
                       "get state() { return studyStateView(); }",
                       "get audio() { return studyAudioView(); }"):
            self.assertIn(needle, text, "学习桥接未收窄：" + needle)

    def test_extension_points_have_host_consumers(self):
        text = PART.read_text(encoding="utf-8")
        for fn in ("function renderPluginMenu", "function renderPluginImporters",
                   "function renderPluginSearchSources", "function renderPluginThemes",
                   "function applyPluginExtensions"):
            self.assertIn(fn, text, "缺少贡献点消费入口：" + fn)
        page = (ROOT / "site" / "player.html").read_text(encoding="utf-8")
        for anchor in ("pluginMenuBtn", "pluginMenuPop", "pluginImporters", "pluginSearchSources"):
            self.assertIn('id="' + anchor + '"', page, "页面缺少插件贡献点锚点：" + anchor)

    def test_consent_tristate(self):
        stub = """
function assert(cond, msg) { if (!cond) { console.error('FAIL: ' + msg); process.exit(1); } }
const store = new Map();
const localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
const window = { fetch: () => Promise.resolve(), XMLHttpRequest: function Ghost(){}, WebSocket: function GhostWs(){}, EventSource: function GhostEs(){} };
"""
        script = stub + extract_consent() + "\n" + CONSENT_CASES
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as fh:
            fh.write(script)
            path = fh.name
        proc = subprocess.run(["node", path], capture_output=True, text=True)
        Path(path).unlink(missing_ok=True)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("consent OK", proc.stdout)

    def test_manifest_validation_wired_into_loader(self):
        text = PART.read_text(encoding="utf-8")
        load = text.index("async function loadPlugins()")
        self.assertIn("validateLegacyManifest(plugin)", text[load:],
                      "加载前必须过 v2 契约的旧清单兼容校验")
        self.assertIn("不替换 plugin.requires", text[load:],
                      "兼容校验不能改写旧宿主仍要用的数组依赖")

    def test_signature_gate_wired_into_loader(self):
        text = PART.read_text(encoding="utf-8")
        load = text.index("async function loadPlugins()")
        self.assertIn("plugin.signature === 'bad'", text[load:], "加载前必须拦下签名不符的插件")
        self.assertIn("setPluginPinnedHash(id, plugin.hash", text[load:], "授权通过时要把内容指纹钉住")
        self.assertIn("pluginConsentChanged(plugin)", text[load:], "已授权的插件也要复查文件是否被改")

    def test_permission_gates_on_api_entries(self):
        text = PART.read_text(encoding="utf-8")
        start = text.index("openEpisode: (showKey, episodeId) =>")
        end = text.index("},", start)
        self.assertIn("pluginRequire(id, 'player')", text[start:end], "api.openEpisode 必须检查 player 权限")
        start_fn = text.index("catch (err) {", text.index("definition.setup(pluginApiFor(key))"))
        self.assertIn("abortPluginStart(key, definition)", text[start_fn:start_fn + 300],
                      "setup 失败必须走清理路径，不能只复位 __started")
        perm_block = text[text.index("const PLUGIN_PERMISSIONS"):text.index("const PLUGIN_PERMISSION_ALL")]
        self.assertNotIn("desktop:", perm_block, "没有对应 API 的 desktop 权限不该继续挂名")

    def test_core_provider_seams(self):
        cases = r"""
defineCoreProvider('catalog', { loadShows: async () => ['default'] });
assert(coreProvider('catalog').owner === '', '没有插件接管时应回退到默认实现');
assert(coreProvider('catalog').fallback.loadShows !== undefined, '覆盖实现要能拿到 fallback');

registerCoreProvider('demo', 'catalog', { loadShows: async () => ['demo'] });
assert(coreProviderOwner('catalog') === 'demo', '登记后 owner 应指向插件');
assert(typeof coreProvider('catalog').fallback.loadShows === 'function', '覆盖后仍保留默认实现');

let threw = false;
try { registerCoreProvider('demo', 'nope', {}); } catch (e) { threw = true; }
assert(threw, '未知核心能力必须报错');

threw = false;
try { registerCoreProvider('demo', 'catalog', {}); } catch (e) { threw = true; }
assert(threw, '缺必需方法必须报错');

releaseCoreProviders('demo');
assert(coreProviderOwner('catalog') === '', '停用插件应回退默认实现');

// 两个插件先后接管：后停用要恢复到前一个，而不是直接掉回默认实现
registerCoreProvider('first', 'catalog', { loadShows: async () => ['first'] });
registerCoreProvider('second', 'catalog', { loadShows: async () => ['second'] });
assert(coreProviderOwner('catalog') === 'second', '后注册的插件应在栈顶');
releaseCoreProviders('second');
assert(coreProviderOwner('catalog') === 'first', '上层停用后应恢复下层插件');
releaseCoreProviders('first');
assert(coreProviderOwner('catalog') === '', '全部停用后才回默认实现');
threw = false;
try { defineCoreProvider('nope', {}); } catch (e) { threw = true; }
assert(threw, '默认实现也只能用认得的名字');
console.log('providers OK');
"""
        script = "function assert(c, m){ if(!c){ console.error('FAIL: '+m); process.exit(1); } }\n" + extract_providers() + "\n" + cases
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as fh:
            fh.write(script)
            path = fh.name
        proc = subprocess.run(["node", path], capture_output=True, text=True)
        Path(path).unlink(missing_ok=True)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("providers OK", proc.stdout)

    def test_permission_grants_and_network_guard(self):
        stub = r"""
function assert(c, m){ if(!c){ console.error('FAIL: '+m); process.exit(1); } }
const store = new Map();
const localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
const fetched = [];
const window = {
  fetch: (url) => { fetched.push(String(url)); return Promise.resolve('ok'); },
  XMLHttpRequest: function FakeXhr() {},
  WebSocket: function FakeWs() {},
  EventSource: function FakeEs() {},
};
const location = { href: 'http://localhost/player.html', origin: 'http://localhost' };
"""
        cases = r"""
const builtin = { id: 'b', builtin: true };
assert(pluginPermissions(builtin).size === PLUGIN_PERMISSION_ALL.length, '内置插件应全权限');
assert(pluginPermissions({ id: 'old' }).size === PLUGIN_PERMISSION_ALL.length, '老清单没声明权限时保持全权限');

const narrow = pluginPermissions({ id: 'demo', permissions: ['net'] });
assert(narrow.has('ui.dom') && narrow.has('net'), '声明的权限要生效');
assert(!narrow.has('player') && !narrow.has('storage'), '没声明的不能拿到');

PLUGIN_GRANTS.set('demo', narrow);
assert(pluginRequire('demo', 'net') === true, '声明过就该放行');
let threw = false;
try { pluginRequire('demo', 'player'); } catch (e) { threw = true; }
assert(threw, '没声明的能力调用必须被拒绝');

assert(pluginUrlIsLocal('/json/x.json'), '同源相对路径算本地');
assert(pluginUrlIsLocal('http://localhost/a.json'), '同源绝对路径算本地');
assert(pluginUrlIsLocal('blob:http://localhost/abc'), 'blob 算本地');
assert(!pluginUrlIsLocal('https://cdn.example.com/x.js'), '外域不算本地');

const noNet = new Set(['ui.dom']);
PLUGIN_GRANTS.set('plain', noNet);
const guarded = window.MyTGuard.fetch('plain');
guarded('/json/x.json').then(() => {
  assert(fetched.length === 1, '同源请求应放行');
  return guarded('https://cdn.example.com/x.js').then(
    () => { assert(false, '无 net 权限时外域请求必须被拒绝'); },
    err => {
      assert(/net/.test(err.message), '拒绝原因要说清缺 net 权限');
      assert(fetched.length === 1, '被拦的请求不应真的发出去');
      let wsThrew = false;
      try { window.MyTGuard.ws('plain')('wss://x/y'); } catch (e) { wsThrew = true; }
      assert(wsThrew, '无 net 权限时不能建 WebSocket');
      console.log('permissions OK');
    });
}).catch(err => { console.error('FAIL: ' + (err && err.message)); process.exit(1); });
"""
        script = stub + extract_permissions() + "\n" + cases
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as fh:
            fh.write(script)
            path = fh.name
        proc = subprocess.run(["node", path], capture_output=True, text=True)
        Path(path).unlink(missing_ok=True)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("permissions OK", proc.stdout)

    def test_ui_kit_is_narrow_and_domain_services_exist(self):
        source = PART.read_text(encoding="utf-8")
        ui_block = source.split("function v2UiKit()", 1)[1].split("function v2CatalogKit()", 1)[0]
        for leaked in ("app,", "prefs,", "showByKey", "offlineEntries", "readAllProgress"):
            self.assertNotIn(leaked, ui_block, f"ctx.ui 不应再暴露 {leaked}")
        for service in ("v2CatalogKit", "v2ProgressKit", "v2DownloadsKit", "v2SettingsKit"):
            self.assertIn(f"function {service}()", source, f"缺少按域服务 {service}")
        for plugin in ("home", "library", "downloads", "settings"):
            main = ROOT / "apps" / "windows" / "builtin-plugins" / plugin / "main.js"
            text = main.read_text(encoding="utf-8")
            self.assertNotIn("app.", text, f"{plugin} 仍在从 ctx.ui 取宿主状态")
            self.assertIn("ctx.", text, f"{plugin} 未使用 ctx")


    def test_live_and_captions_lifecycle_owned_by_plugin(self):
        host = (ROOT / "src" / "player-js" / "03-native-asr-service-worker.js").read_text(encoding="utf-8")
        self.assertNotIn("liveAutoResume", host, "宿主不应再自己轮询自动开实时识别")
        self.assertNotIn("myt-live-auto", host, "自动续开意图应只由插件读写")
        live = (ROOT / "apps" / "windows" / "builtin-plugins" / "subtitles" / "live.js").read_text(encoding="utf-8")
        self.assertIn("myt-live-auto", live, "插件应接管刷新后续开")
        self.assertIn("function autoStart", live, "插件应负责自动开实时识别")
        self.assertIn("engine.disable", live, "插件停用时应收掉实时识别")
        main = (ROOT / "apps" / "windows" / "builtin-plugins" / "subtitles" / "main.js").read_text(encoding="utf-8")
        self.assertIn("desktop.stop()", main, "字幕插件停用时应收回全局字幕会话")


    def test_slot_anchors_and_settings_mounts_are_wired(self):
        contract = (ROOT / "src" / "player-js" / "host" / "contract.js").read_text(encoding="utf-8")
        block = contract.split("export const FIXED_SLOTS", 1)[1].split("]);", 1)[0]
        slots = re.findall(r"'([a-z][a-z.]+)'", block)
        self.assertTrue(slots, "固定槽位表解析失败")
        page = (ROOT / "site" / "player.html").read_text(encoding="utf-8")
        routes = (ROOT / "src" / "player-js" / "07-routes-pages.js").read_text(encoding="utf-8")
        anchors = re.findall(r'data-plugin-slot="([^"]+)"', page) + re.findall(r'data-plugin-slot="([^"]+)"', routes)
        self.assertEqual(sorted(set(anchors)), sorted(slots), "页面锚点与固定槽位表必须一一对应")
        for slot in slots:
            self.assertIn(slot, anchors, f"固定槽位 {slot} 在页面上没有锚点")
        self.assertIn("applySlotMounts(document)", routes,
                      "页面渲染后没有挂载槽位")
        self.assertIn("applySlotMounts(view)", routes, "单集异步渲染后没有挂载槽位")
        study = (ROOT / "src" / "player-js" / "08-study-ai.js").read_text(encoding="utf-8")
        self.assertIn("applySettingsPanes(pane)", study, "切换设置分区时没有渲染插件分区")
        host = PART.read_text(encoding="utf-8")
        for fn in ("function applySlotMounts", "function applySettingsPanes", "function releaseSurfaces"):
            self.assertIn(fn, host, f"宿主缺少 {fn}")
        stop_block = host.split("function stopPlugin(id)", 1)[1].split("function abortPluginStart", 1)[0]
        self.assertIn("releaseSurfaces(key)", stop_block, "停用插件时必须回收槽位与设置分区")
        abort_block = host.split("function abortPluginStart", 1)[1].split("function captionInvoke", 1)[0]
        self.assertIn("releaseSurfaces(key)", abort_block, "启动失败时必须回收槽位与设置分区")


if __name__ == "__main__":
    unittest.main()
