"""自定义主题卡片：数据迁移、预览取色与页面接线。

纯函数从 01 分片切出来丢给 node 跑；接线部分做静态断言，避免卡片入口被删掉。
"""
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
SHELL = ROOT / "src" / "player-js" / "01-theme-reader-shell.js"
PAGE = ROOT / "site" / "player.html"
CSS = ROOT / "site" / "player.css"
NAV = ROOT / "src" / "player-js" / "05-transport-transcript-nav.js"


def function_block(text: str, name: str, next_name: str) -> str:
    """按下一个函数起点切片：函数体里含有正则花括号，不能只靠配平。"""
    return text[text.index("function " + name):text.index("function " + next_name)]


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


class CustomThemeTests(unittest.TestCase):
    def test_pure_helpers_migrate_and_preview(self):
        source = SHELL.read_text(encoding="utf-8")
        script = "function assert(c,m){ if(!c){console.error('FAIL: '+m);process.exit(1);} }\n" + \
            function_block(source, "normalizeCustomTheme", "readCustomTheme") + "\n" + \
            function_block(source, "customPreviewColor", "customThemeActiveName") + "\n" + CASES
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as fh:
            fh.write(script)
            path = fh.name
        proc = subprocess.run(["node", path], capture_output=True, text=True)
        Path(path).unlink(missing_ok=True)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("custom themes OK", proc.stdout)

    def test_cards_are_wired_into_theme_grid(self):
        source = SHELL.read_text(encoding="utf-8")
        page = PAGE.read_text(encoding="utf-8")
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
        self.assertGreaterEqual(len(packs), 12, "主题包数量不对：" + str(len(packs)))
        seen = set()
        for pack in packs:
            data = json.loads(pack.read_text(encoding="utf-8"))
            self.assertEqual(data.get("format"), "myt-theme", pack.name + " 缺 format")
            self.assertTrue(data.get("name"), pack.name + " 缺 name")
            self.assertNotIn(data["name"], seen, "主题名重复：" + data["name"])
            seen.add(data["name"])
            css = data.get("css") or ""
            self.assertGreater(len(css), 5000, pack.name + " CSS 太短")
            self.assertIn("html[data-theme]", css, pack.name + " 选择器必须挂 data-theme")
            self.assertNotIn("</style", css.lower(), pack.name + " CSS 夹带了标签")
            self.assertNotIn("lg-on", css, pack.name + " 依赖了插件标记")

    def test_builtin_swatch_disables_custom_theme(self):
        """自定义 CSS 注在 head 末尾、与内置主题同权重，点内置色板时必须先停用它，否则切换无效。"""
        source = SHELL.read_text(encoding="utf-8")
        block = source[source.index("function setTheme"):source.index("document.addEventListener('click'")]
        self.assertIn("readCustomTheme()", block, "setTheme 没有检查自定义主题是否启用")
        self.assertIn("enabled: false", block, "setTheme 没有停用自定义主题")
        self.assertIn("applyCustomTheme(next)", block, "停用后没有重新应用（清空注入样式）")

    def test_default_packs_and_builtin_swatches(self):
        """七套随包主题不用手动导入；内置色板只剩午夜蓝/纸张/原型/编辑部四个。"""
        import json
        import re

        defaults = (ROOT / "site" / "themes-defaults.js").read_text(encoding="utf-8")
        self.assertIn("window.MYT_THEME_DEFAULTS", defaults, "缺少随包主题清单")
        packs = json.loads(defaults[defaults.index("["):defaults.rindex("]") + 1])
        slugs = [pack["slug"] for pack in packs]
        self.assertEqual(slugs, ["liquid-glass", "glass2", "minimal-maxi", "mono-tech",
                                 "neubrutalism", "riso-print", "surveillance"], "随包主题顺序/数量不对")
        for pack in packs:
            self.assertGreater(len(pack["css"]), 5000, pack["slug"] + " CSS 太短")
            theme = json.loads((ROOT / "themes" / (pack["slug"] + ".json")).read_text(encoding="utf-8"))
            self.assertEqual(pack["css"], theme["css"], pack["slug"] + " 的 site 版与 themes 版不同步，请重新生成")

        page = PAGE.read_text(encoding="utf-8")
        ids = re.findall(r'class="swatch" data-theme="([a-z]+)"', page)
        self.assertEqual(sorted(set(ids)), ["ledger", "midnight", "paper", "prototype"], "内置色板残留旧主题")
        self.assertIn("themes-defaults.js", page, "页面没有加载随包主题清单")

        source = SHELL.read_text(encoding="utf-8")
        self.assertIn("function seedDefaultThemePacks", source, "缺少随包主题种卡函数")
        self.assertIn("queueMicrotask(bootCustomTheme)", source, "启动应用没有压到微任务，readJSON 可能还没注册")
        # 随包主题是默认主题：不可删除，恢复默认时也要保留
        self.assertIn("builtin: true", source, "种卡没有标记默认主题")
        self.assertIn("preset.builtin", source, "删除卡片时没有拦住默认主题")
        self.assertIn("默认主题，不能删除", source, "默认主题缺少拒绝删除的提示")
        self.assertIn("filter(item => item.builtin)", source, "恢复默认会把默认主题一起清掉")
        # 每次启动补齐缺的默认主题卡，而不是“只种一次”
        self.assertIn("firstTime = !localStorage.getItem(DEFAULT_PACKS_KEY)", source,
                      "种卡要每次补齐，标记只决定第一次是否顺手启用")
        for gone in ("brass", "forest", "oxblood", "celadon", "mist"):
            self.assertNotIn(gone + ": '", NAV.read_text(encoding="utf-8").split("const THEME_NAMES")[1][:400],
                             "THEME_NAMES 还留着已撤掉的色板 " + gone)

    def test_theme_import_is_wired_and_theme_file_valid(self):
        import json

        source = SHELL.read_text(encoding="utf-8")
        page = PAGE.read_text(encoding="utf-8")
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
