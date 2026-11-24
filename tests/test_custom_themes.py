"""自定义主题卡片：数据迁移、预览取色与页面接线。

纯函数现在住在 13-theme（2026-11-22 从 01 搬出），切出来丢给 node 跑；
接线部分做静态断言，避免卡片入口被删掉。
"""
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
SHELL = ROOT / "src" / "player-js" / "01-theme-reader-shell.js"
THEME = ROOT / "src" / "player-js" / "13-theme.js"
PAGE = ROOT / "site" / "player.html"
CSS = ROOT / "site" / "player.css"
NAV = ROOT / "src" / "player-js" / "05-transport-transcript-nav.js"


def shell_and_theme() -> str:
    """主题代码现在横跨 01（转发/阅读器杂项）与 13（主题本体），接线断言两片一起看。"""
    return SHELL.read_text(encoding="utf-8") + "\n" + THEME.read_text(encoding="utf-8")


def page_text() -> str:
    """设置页的 DOM 归骨架管（src/skeletons/base.html → site/skeletons-defaults.js），断言要看运行时的样子。"""
    import json

    page = PAGE.read_text(encoding="utf-8")
    skel = ROOT / "site" / "skeletons-defaults.js"
    if skel.is_file():
        text = skel.read_text(encoding="utf-8")
        packs = json.loads(text[text.index("{"): text.rindex("}") + 1])
        page = page.replace('<div id="shellMount"></div>', packs.get("base", ""))
    return page


def function_block(text: str, name: str, next_name: str) -> str:
    """按下一个函数起点切片：函数体里含有正则花括号，不能只靠配平。"""
    return text[text.index("function " + name):text.index("function " + next_name)]


SCOPES = r"""
// 4. 主题只有一个当前值：当前 id 就是内置档，或一张卡
assert(packScopeMatches('rail', 'ledger') === true, 'rail 覆盖编辑部');
assert(packScopeMatches('rail', 'console') === false, 'rail 不覆盖播控台');
assert(packScopeMatches('console', 'console') === true, '专属档匹自己');

const twoPacks = normalizeCustomTheme({
  enabled: true,
  presets: [
    { id: 'ct-a', name: '玻璃', css: 'A', scope: 'rail' },
    { id: 'ct-b', name: '台灯', css: 'B', scope: 'console' },
  ],
});
assert(themeStyle(twoPacks, 'ct-a').css === 'A', '当前是这张卡时要取它自己的整套 CSS');
assert(themeStyle(twoPacks, 'ct-b').css === 'B', '另一张卡也是整套');
assert(themeStyle(twoPacks, 'ledger').css === '', '内置档不再被「按档指针」套上别的卡');
assert(!('activeByTheme' in twoPacks), '按档指针已删除，配置里不该再有该字段');

const legacyCfg = normalizeCustomTheme({ enabled: true, activeId: 'ct-a', presets: [{ id: 'ct-a', css: 'A' }] });
assert(legacyCfg.activeId === 'ct-a', '老 activeId 仍可读');
assert(!('activeByTheme' in legacyCfg), '老数据也不再生成按档指针');

// 4.2 按档草稿折成卡片：老 perTheme 读入即变卡，配置里不再出现 perTheme
const legacyDraft = normalizeCustomTheme({
  perTheme: { news: { css: 'html[data-theme="news"]{--accent:#c00}', html: '' }, plate: { css: '  ', html: '' } },
});
assert(!('perTheme' in legacyDraft), 'perTheme 应彻底移除，实际仍有该字段');
assert(legacyDraft.presets.length === 1, '有内容的草稿折成一张卡、空的丢掉，实际：' + legacyDraft.presets.length);
assert(legacyDraft.presets[0].id === 'ct-draft-news', '折出来的卡要记原档 id');
assert(legacyDraft.presets[0].scope === 'news', '折出来的卡骨架要记原档');
assert(themeStyle(legacyDraft, 'news').mode === 'none', '内置档不再有 draft 模式');
assert(themeStyle(legacyDraft, 'ct-draft-news').mode === 'pack', '折出来的草稿卡是整套卡');
assert(themeStyle(normalizeCustomTheme({ perTheme: { news: { css: 'x' } } }), 'ct-draft-news').name === '报纸自写稿', '草稿卡名字要能看懂');

// 4.5 卡就是完整主题：点哪张卡就整套切过去（原样注入，不剪裁几何、不掺内置档）
const railCss = 'html[data-theme] { --bg:#000; --ink:#fff; --accent:#f0b45a }\n'
  + 'html[data-theme] .sidebar { width:262px; height:100vh; background:rgba(255,255,255,.06) }';
const railOnly = normalizeCustomTheme({
  presets: [{ id: 'ct-x', name: '玻璃', scope: 'rail', css: railCss, html: '<b>x</b>' }],
});
const picked = themeStyle(railOnly, 'ct-x');
assert(picked.mode === 'pack', '当前是卡时应走 pack 模式，实际：' + picked.mode);
assert(picked.css === railCss, '整套切换必须原样注入，不能剪裁几何');
assert(picked.html === '<b>x</b>', '卡自带的 HTML 也要一起上');
assert(picked.skeleton === 'rail', '卡自带骨架要一起判定，实际：' + picked.skeleton);
assert(themeStyle(railOnly, 'console').mode === 'none', '内档不该借卡的样式');
"""

CASES = r"""
function assert(cond, msg) { if (!cond) { console.error('FAIL: ' + msg); process.exit(1); } }

// 1. 旧数据（只有一套 CSS/HTML）读进来不能丢内容
const legacy = normalizeCustomTheme({ css: ':root{--bg:#000}', html: '<b>x</b>', enabled: true, updatedAt: 5 });
assert(legacy.css === ':root{--bg:#000}', '旧 css 应保留');
assert(legacy.html === '<b>x</b>', '旧 html 应保留');
assert(legacy.enabled === true, '旧 enabled 应保留');
assert(legacy.presets.length === 0, '旧数据应补空 presets');
assert(legacy.activeId === '', '旧数据没有 activeId');

// 2. 卡片数据保留；activeId 指向不存在的卡要清掉
const saved = normalizeCustomTheme({
  css: '', html: '', enabled: true, activeId: 'ct-2',
  presets: [
    { id: 'ct-1', name: '夜读', css: ':root{--bg:#101820}', html: '' },
    { id: 'ct-2', name: '晨光', css: ':root{--bg:#eef2ee}', createdAt: 3 },
    { id: '', name: '坏卡' },
    { name: '没有 id' },
  ],
});
assert(saved.presets.length === 2, '只保留有 id 的卡：' + saved.presets.length);
assert(saved.activeId === 'ct-2', 'activeId 应保留');
assert(saved.presets[0].name === '夜读' && saved.presets[0].createdAt === 0, '卡字段应归一化');
assert(saved.presets[1].createdAt === 3, 'createdAt 应保留');
const stale = normalizeCustomTheme({ presets: [{ id: 'ct-1' }], activeId: 'gone' });
assert(stale.activeId === '', 'activeId 指向不存在的卡必须清掉');

// 3. 预览取色：只认三个变量，非法值回退
const colors = (css) => [
  customPreviewColor(css, 'bg', '#111'),
  customPreviewColor(css, 'accent', '#222'),
  customPreviewColor(css, 'accent2', '#333'),
];
const drawn = colors(':root{--bg:#101820;--accent:#e0a45c;--accent2:#7fb4ff}');
assert(drawn[0] === '#101820', '应取到 --bg');
assert(drawn[1] === '#e0a45c', '应取到 --accent');
assert(drawn[2] === '#7fb4ff', '应取到 --accent2');
const evil = colors(':root{--bg:url(javascript:alert(1));--accent:" onmouseover=alert(1);--accent2:}');
assert(evil[0] === '#111', '含括号/引号的非法颜色要回退：' + evil[0]);
assert(evil[1] === '#222', '带引号的非法颜色要回退：' + evil[1]);
assert(evil[2] === '#333', '空值要回退');
assert(colors('').join('|') === '#111|#222|#333', '没有变量时全部回退');

console.log('custom themes OK');
"""


QUERIES = r"""
// 6. 插件侧的主题查询：答案全部来自 dataset，不靠 data-theme 的字面值去猜
globalThis.document = { documentElement: { dataset: {} } };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
function setDs(theme, base, scheme, skel) {
  document.documentElement.dataset = { theme: theme, themeBase: base, scheme: scheme, skel: skel };
}
const SKELETON_OF = {
  prototype: 'rail', ledger: 'rail', apple: 'rail', spotify: 'rail',
  console: 'strip', news: 'print', plate: 'grid',
  rail: 'rail', strip: 'strip', print: 'print', grid: 'grid',
};
function readCustomTheme() {
  return { presets: [
    { id: 'ct-pack-a', name: 'A', scope: 'grid', css: 'html[data-theme]{--bg:#ffffff}' },
    { id: 'ct-pack-b', name: 'B', scope: 'rail', css: 'html[data-theme]{--bg:#111111}' },
  ] };
}

setDs('ct-pack-a', 'plate', 'light', 'grid');
assert(themeId() === 'ct-pack-a', 'themeId 要给卡 id');
assert(themeBase() === 'plate', 'themeBase 要给回哪一档');
assert(themeIsLight() === true, '浅色卡要认浅');
assert(themeSkeleton() === 'grid', '骨架要读 skel');
const packs = themePacks();
assert(packs.length === 2, '卡清单条数');
assert(packs[0].active === true && packs[1].active === false, '只标当前那张');
assert(packs[0].skeleton === 'grid' && packs[1].skeleton === 'rail', '骨架跟着 scope');
assert(packs[0].light === true && packs[1].light === false, '深浅按 --bg 判');

setDs('ledger', 'ledger', 'dark', 'rail');
assert(themeIsLight() === false, '深色档');
assert(themeSkeleton() === 'rail', '竖栏骨架');
assert(themeBase() === 'ledger', '内置档的回退目标就是它自己');

setDs('', '', '', '');
assert(themeId() === '', '空 id');
assert(themeSkeleton() === 'rail', '骨架缺省 rail');

console.log('theme queries OK');
"""


class CustomThemeTests(unittest.TestCase):
    def test_pure_helpers_migrate_and_preview(self):
        source = THEME.read_text(encoding="utf-8")
        script = "function assert(c,m){ if(!c){console.error('FAIL: '+m);process.exit(1);} }\n" + \
            function_block(source, "packScopeMatches", "packScopeLabel") + "\n" + \
            function_block(source, "packScopeLabel", "normalizeCustomTheme") + "\n" + \
            function_block(source, "normalizeCustomTheme", "activePackForTheme") + "\n" + \
            function_block(source, "activePackForTheme", "readCustomTheme") + "\n" + \
            function_block(source, "customPreviewColor", "customThemeActiveName") + "\n" + SCOPES + "\n" + CASES
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as fh:
            fh.write(script)
            path = fh.name
        proc = subprocess.run(["node", path], capture_output=True, text=True)
        Path(path).unlink(missing_ok=True)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("custom themes OK", proc.stdout)

    def test_cards_are_wired_into_theme_grid(self):
        source = shell_and_theme()
        page = page_text()
        css = CSS.read_text(encoding="utf-8")
        for fn in ("renderCustomThemeGrid", "saveCustomThemePreset", "applyCustomThemePreset", "removeCustomThemePreset"):
            self.assertIn("function " + fn, source, "缺少 " + fn)
        self.assertIn("data-custom-add", source, "网格里没有“存为自定义主题”的入口")
        self.assertIn("data-custom-preset", source, "网格里没有自定义主题卡")
        self.assertIn("data-custom-remove", source, "卡片没有删除入口")
        self.assertIn("preset.css = css", source, "编辑时没有把改动写回当前卡片")
        self.assertIn("presets: [...cfg.presets, preset]", source, "保存时应追加卡片")
        self.assertIn('id="ctName"', page, "设置页缺少主题名称输入框")
        self.assertIn("renderCustomThemeGrid()", source, "同步编辑器时应重绘卡片")
        for rule in (".custom-card{", ".custom-card-del{", ".custom-add{", ".ct-name{"):
            self.assertIn(rule, css, "缺少样式 " + rule)

    def test_theme_packs_are_importable(self):
        """themes/*.json 都是可直接导入的主题包：结构合法、选择器挂 data-theme、不夹带标签。"""
        import json

        packs = sorted((ROOT / "themes").glob("*.json"))
        self.assertGreaterEqual(len(packs), 7, "主题包数量不对：" + str(len(packs)))
        seen = set()
        for pack in packs:
            data = json.loads(pack.read_text(encoding="utf-8"))
            self.assertEqual(data.get("format"), "myt-theme", pack.name + " 缺 format")
            self.assertTrue(data.get("name"), pack.name + " 缺 name")
            self.assertNotIn(data["name"], seen, "主题名重复：" + data["name"])
            seen.add(data["name"])
            css = data.get("css") or ""
            self.assertGreater(len(css), 5000, pack.name + " CSS 太短")
            self.assertIn("html[data-theme", css, pack.name + " 选择器必须挂 data-theme")
            self.assertNotIn("</style", css.lower(), pack.name + " CSS 夹带了标签")
            self.assertNotIn("lg-on", css, pack.name + " 依赖了插件标记")

    def test_set_theme_reapplies_scoped_pack(self):
        """自定义样式是按档存的：切档后要按新档重取一份，不能沿用上一档，也不能一刀切全停。"""
        source = THEME.read_text(encoding="utf-8")
        block = source[source.index("function setTheme"):source.index("document.addEventListener('click'")]
        self.assertIn("applyCustomTheme()", block, "切档后没有按新档重新应用自定义样式")
        self.assertIn("renderCustomThemeGrid()", block, "切档后没有重绘主题卡（归属角标要跟着变）")
        self.assertIn("renderThemePopPacks()", block, "切档后没有重排弹层里的包色块")
        self.assertNotIn("enabled: false", block, "不应再把某一档的切换当成全局停用")

    def test_default_packs_and_builtin_swatches(self):
        """随包主题不用手动导入（全部只给竖栏四档），内置色板七个。"""
        import json
        import re

        defaults = (ROOT / "site" / "themes-defaults.js").read_text(encoding="utf-8")
        self.assertIn("window.MYT_THEME_DEFAULTS", defaults, "缺少随包主题清单")
        packs = json.loads(defaults[defaults.index("["):defaults.rindex("]") + 1])
        slugs = [pack["slug"] for pack in packs]
        self.assertEqual(slugs, ["liquid-glass", "glass2", "minimal-maxi", "mono-tech",
                                 "neubrutalism", "riso-print", "surveillance", "broadcast-archive"],
                         "随包主题顺序/数量不对")
        for pack in packs:
            self.assertGreater(len(pack["css"]), 5000, pack["slug"] + " CSS 太短")
            theme = json.loads((ROOT / "themes" / (pack["slug"] + ".json")).read_text(encoding="utf-8"))
            self.assertEqual(pack["css"], theme["css"], pack["slug"] + " 的 site 版与 themes 版不同步，请重新生成")
            self.assertIn(pack.get("scope") or "rail", ["rail", "news", "plate", "console", "all"],
                          pack["slug"] + " 的 scope 不合法")
        self.assertTrue((ROOT / "scripts" / "build_theme_packs.py").is_file(),
                        "缺少生成入口，site 版只能手改")

        page = page_text()
        ids = re.findall(r'class="swatch" data-theme="([a-z]+)"', page)
        self.assertEqual(sorted(set(ids)), ["apple", "console", "ledger", "news", "plate", "prototype", "spotify"], "内置色板残留旧主题")
        self.assertIn("themes-defaults.js", page, "页面没有加载随包主题清单")

        source = shell_and_theme()
        self.assertIn("function seedDefaultThemePacks", source, "缺少随包主题种卡函数")
        self.assertIn("queueMicrotask(bootCustomTheme)", source, "启动应用没有压到微任务，readJSON 可能还没注册")
        # 随包主题是默认主题：不可删除，恢复默认时也要保留
        self.assertIn("builtin: true", source, "种卡没有标记默认主题")
        self.assertIn("preset.builtin", source, "删除卡片时没有拦住默认主题")
        self.assertIn("默认主题，不能删除", source, "默认主题缺少拒绝删除的提示")
        self.assertIn("filter(item => item.builtin)", source, "恢复默认会把默认主题一起清掉")
        # 每次启动补齐缺的默认主题卡，而不是“只种一次”；当前主题由用户点，不再自动切档
        self.assertIn("if (known.has('ct-pack-' + slug)) return;", source,
                      "种卡要每次补齐缺少的默认主题")
        self.assertNotIn("activeByTheme:", source, "按档指针字段应已彻底删除（只剩说明注释）")
        self.assertNotIn("cfg.perTheme", source, "编辑器不应再读写按档草稿（只留迁移用的 base.perTheme）")
        for gone in ("brass", "forest", "oxblood", "celadon", "mist"):
            self.assertNotIn(gone + ": '", NAV.read_text(encoding="utf-8").split("const THEME_NAMES")[1][:400],
                             "THEME_NAMES 还留着已撤掉的色板 " + gone)

    def test_plugin_theme_queries_answer_by_dataset(self):
        source = THEME.read_text(encoding="utf-8")
        script = "function assert(c,m){ if(!c){console.error('FAIL: '+m);process.exit(1);} }\n" + \
            function_block(source, "themeId", "packIsLight") + "\n" + \
            function_block(source, "packIsLight", "rawPackById") + "\n" + \
            function_block(source, "themeBase", "setTheme") + "\n" + \
            function_block(source, "customPreviewColor", "customThemeActiveName") + "\n" + QUERIES
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as fh:
            fh.write(script)
            path = fh.name
        proc = subprocess.run(["node", path], capture_output=True, text=True)
        Path(path).unlink(missing_ok=True)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("theme queries OK", proc.stdout)

    def test_plugin_theme_queries_are_exported_and_mounted(self):
        theme = THEME.read_text(encoding="utf-8")
        host = (ROOT / "src" / "player-js" / "04-local-audio-plugin-host.js").read_text(encoding="utf-8")
        block = theme.rsplit("export {", 1)[1].split("};", 1)[0]
        for fn in ("themeId", "themeBase", "themeIsLight", "themeSkeleton", "themePacks"):
            self.assertIn(fn, block, "13-theme 没有导出 " + fn)
        kit = host.split("function v2SettingsKit()", 1)[1].split("function ", 1)[0]
        for key in ("themeId:", "themeBase:", "themeIsLight:", "themeSkeleton:", "themePacks:"):
            self.assertIn(key, kit, "ctx.settings 没有暴露 " + key)
        self.assertIn("dataset.scheme === 'light'", theme, "themeIsLight 必须读 scheme，不能靠 data-theme 猜")
        self.assertIn("dataset.skel", theme, "themeSkeleton 必须读 skel")
        self.assertIn("String(preset.id || '') === current", theme, "themePacks 要标出当前卡")

    def test_theme_import_is_wired_and_theme_file_valid(self):
        import json

        source = shell_and_theme()
        page = page_text()
        self.assertIn("function importCustomTheme", source, "缺少 importCustomTheme")
        self.assertIn("importCustomTheme(String(reader.result", source, "文件读完后没有接入导入")
        self.assertIn("FileReader", source, "导入没有读文件")
        self.assertIn('id="ctImport"', page, "设置页缺少导入按钮")
        self.assertIn('id="ctImportFile"', page, "设置页缺少文件输入")

        theme = json.loads((ROOT / "themes" / "liquid-glass.json").read_text(encoding="utf-8"))
        css = theme["css"]
        self.assertGreater(len(css), 15000, "主题 CSS 太短，可能没写全")
        self.assertIn("html[data-theme]", css, "主题选择器必须挂 data-theme 才能压过内置主题")
        self.assertNotIn("lg-on", css, "自定义主题不能依赖插件标记")
        self.assertIn("body::before", css, "自定义主题没有 DOM 层，光斑要用伪元素")
        self.assertNotIn("</style", css.lower(), "CSS 不能夹带标签")
        self.assertEqual(theme["name"], "液态玻璃")


if __name__ == "__main__":
    unittest.main()
