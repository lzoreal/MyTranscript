# 主题模型（现行版）

一句话：**一个当前 id，就是全部。** 点哪个 id 就整套换哪个，没有覆盖层、没有「让位」提示。
这份文档是主题的当前真相；历史迭代（O / P / Q 三版怎么演进来的）留在
[handover.md](handover.md) 的 Q 节，遇到「为什么这么定」再去翻。

## 数据

| 键 | 内容 |
| --- | --- |
| `localStorage.myt-theme` | 当前主题 id：内置档（`ledger` 等）或一张卡（`ct-pack-<slug>` / `ct-<n>`） |
| `localStorage.myt-theme-base` | 回退用的内置档（「停用」卡时回到这里） |
| `localStorage.myt-theme-custom` | `{ css, html, enabled, updatedAt, presets, activeId }`；**`presets` 是唯一的持久层** |

`normalizeCustomTheme` 是 schema 的唯一入口，读写都过它。已退役的字段读进来直接丢掉：
`activeByTheme`（按档指针）、`perTheme`（按档草稿，见下）。

`perTheme` 的迁移：老配置里每个非空的 `perTheme[档]` 会在读入时折成一张卡
（`ct-draft-<档>`，名字「<档名>自写稿」，scope 记原档），之后配置里不再出现该字段。
所以「在某个内置档上写了一段 CSS」这件事现在的落点是**卡**，不是草稿。

## 应用

- `setTheme(id)` 是唯一入口；内置色球、包色块、卡片、插件都调它。
- `html[data-theme]` 直接写这个 id。内置档的版面规则全挂在 `html[data-theme="某一档"]` 上，
  换成卡 id 时它们一条都不命中，页面上只剩基础骨架 + 这张卡自己的完整 CSS/HTML。
- `themeStyle(cfg, theme)` 只回答两件事：这个 id 是不是卡（`mode: 'pack'`，原样注入），
  否则 `mode: 'none'`（内置档，不加任何自定义样式）。**没有 `draft` 模式了。**
- `data-skel` 记当前骨架（`rail / strip / print / grid`），`SKELETON_OF` 是内置档 → 骨架的映射；
  卡的骨架写在 `scope` 上。
- 插件不猜字面值，问 `ctx.settings`：`themeId()` / `themeBase()` / `themeIsLight()` /
  `themeSkeleton()` / `themePacks()`（见 [plugins.md](plugins.md)）。

## 六套随包主题

`liquid-glass, glass2, minimal-maxi, mono-tech, surveillance, folia-poster`（后者是「海报墙」，
元素取自 Folia 播放器的无缝海报瓦片墙：近黑底 + 双色光晕 + 2px 暗缝 + 角标编号 + 底部渐变压字），
卡 id 为 `ct-pack-<slug>`。源文件 `themes/<slug>.{css,json}`，`scripts/build_theme_packs.py`
以同名 `.css` 为唯一真源生成 `site/themes-defaults.js` 并回写 json。随包卡删不掉；
清单里撤掉的包，启动时 `seedDefaultThemePacks` 会把机器上的卡一起撤掉。

## 卡必须自带的三类几何

底座 `.ledger-home .pod-card{padding:0}` 是给「无框、封面出血」设计的；卡一旦加了描边，
就得自己补：页沟（`.ledger-home` 左右 padding）、卡片内衬（`.pod-card-main > :not(.pod-art)` 的
左右 margin）、按钮行 margin。漏了就是「文字和订阅按钮贴边」。
另外 `.brand-mark` 在底座锁了 `flex:0 0 auto`，避免长品牌名把方标压扁。

## 坑

1. **启动顺序**：模块顶层的 `setTheme(savedTheme, false)` 早于 `readJSON` 注册，
   所以 `setTheme` 里对包卡直接从 localStorage 捞（`rawPackById`），否则上次停在卡上会被误判成内置档。
2. **删掉正在用的卡**：先 `setTheme(lastBuiltin)` 再渲染，否则停在一张不存在的卡上（整页空白）。
3. **同一选择器多处追加**：内置档的补丁层（E17/E18/E19…）里存在同选择器重复定义，后写的胜。
   合并这些规则时，如果两次出现之间夹着 `@media`，媒体块里可能有同主体同属性的规则在起作用
   （例：`html[data-theme="plate"] #homeRecommended` 的 padding 由 `@media(max-width:1320px)` 决定）。
   机械合并必须把这种媒体内的「同主体 + 属性撞车」当作阻断，否则会悄悄改掉窄屏下的几何。
4. **测试**：`python tests/test_custom_themes.py`；纯函数用 Node 子进程跑，改 schema 记得同步断言。
