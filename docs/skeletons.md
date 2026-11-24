# 骨架（skeleton）：正文归主题，`player.html` 只留开屏外壳

决策背景见 [adr/0006-skeleton-belongs-to-theme.md](adr/0006-skeleton-belongs-to-theme.md)。这里只记怎么用、怎么改。

## 文件

| 路径 | 是什么 | 谁能改 |
| --- | --- | --- |
| `src/skeletons/base.html` | 全部正文 markup，含 `<!--@region:…-->` 区域标记 | 手改 |
| `src/skeletons/<id>/*.html` | 变体：`shell` / `topbar` / `home` / `reader-top` / `dock` 中任选几个整块替换 | 手改 |
| `scripts/build_skeletons.py` | 拼装成 `window.MYT_SKELETONS`；`--check` 只比对 | 一般不动 |
| `site/skeletons-defaults.js` | 生成物，别手改 | 生成 |

区域是**整块替换**，不是字符串拼接：变体真的可以换掉侧栏、顶栏、首页与阅读页顶条的结构，
没覆盖的区域照旧用 base。构建时如果变体覆盖了不存在的区域名，直接报错。

## 开屏顺序

```
<body>
  <svg class="icon-sprite">…</svg>   图标精灵留在外壳，主题不用抄 28 个 symbol
  <div id="shellMount"></div>
  <script src="skeletons-defaults.js"></script>
  <script>…按 ?skeleton= 注入骨架、挂 variants/<id>.css…</script>
  <script src="themes-defaults.js"></script>
  <script type="module" src="player.js"></script>
</body>
```

注入必须是**普通 script 且放在 body 末尾**：`00-runtime.js` 在模块顶层就抓
`epList` / `transcript`，module 又是天然 defer，所以这段一定先于绑定跑完。放进 `head` 会抓不到节点。

JS 要往页面塞东西时，找骨架锚点而不是类名：

- `[data-anchor="window-controls"]` —— 顶栏右上角的窗口控件位（没有就回落到 `.top-actions`）
- `[data-anchor="reader-controls"]` —— 阅读页顶条的右侧控件位
- `[data-anchor="drag-top"]` —— 当标题栏拖的容器

## 变体预览

```powershell
cd site; python -m http.server 8765
# 然后开
http://127.0.0.1:8765/player.html            base（与引入骨架之前完全一致）
http://127.0.0.1:8765/player.html?skeleton=a 桌面应用体
http://127.0.0.1:8765/player.html?skeleton=b 阅读器优先
http://127.0.0.1:8765/player.html?skeleton=c 仪表台
```

三条硬约束：

1. **变体预览会关掉自定义主题**（`window.__MYT_SKIP_CUSTOM_THEME`）。自定义主题是整包重排，
   会把变体的版面盖掉；预览期间配色只由 `site/variants/<id>.css` 决定。base 不受影响。
2. **窗口控件只有壳里能看到**。浏览器里没有 `window.__TAURI__`，`shellFrame()` 整段不执行，
   所以 `.win-ctl` 不会出现——窗控那一层要 `cargo build` 进壳里才验得了。
3. **切到骨架不同的档要重载页面**。骨架在开屏时注入，不能热切；同一个骨架内切主题照旧即时。

## 改完必跑

```powershell
python scripts\build_skeletons.py          # 重新生成 site/skeletons-defaults.js
python tests\test_skeletons.py             # 生成物一致 + 变体不许丢 base 的 id
python scripts\build_player_js.py --check
python scripts\check_layers.py
```

`test_skeletons.py` 里那条 id 检查是有用的：骨架换结构时最容易丢的是某个 `id`，
而丢掉的后果是一个按钮静默失效——截图上看不出来。真要丢，就显式加进 `OPTIONAL_IDS`。
