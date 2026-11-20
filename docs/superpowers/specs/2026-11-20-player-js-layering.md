# 播放器脚本分层（kernel / view / bridge）

日期：2026-11-20
范围：`src/player-js/*.js`（拼成 `site/player.js`）与 `site/player.html`
状态：L0 / L0.5 / L1 / L2 / L3 / L4 全部完成并实测（分层边界由 `scripts/check_layers.py` 锁定）

## 现状

- 播放器脚本是**一个 IIFE**：`(() => { … })();`，拼接后约 12.4k 行、553 KB。
- 已外置为 `src/player-js/01…10`，`scripts/build_player_js.py` 纯字符拼接，成品 `site/player.js`
  与拆分前逐字节一致（SHA256 `66819ADE…A6E10`）；`tests/test_player_build.py` 守护同步。
- 共享绑定全部在 IIFE 私有作用域：`$`、`audio`、`state`（29 个字段）、`prefs`、以及 636 个函数。
- 测试大量依赖「从页面文本里切片」：`page[page.index("function A"):page.index("function B")]` 后丢给 node 跑，
  因此**函数之间的相对顺序**也是被测试锁定的契约。

## 为什么不直接切成独立文件

1. **函数提升**：同一 script 内函数声明会被提升，顶层代码可以调用后面才定义的函数；
   拆成多个 `<script>` 后，后加载的声明对前面的脚本不可见，会在加载期抛 ReferenceError。
2. **可变绑定**：`studyRenderVocab` 等会被扩展段重新赋值（`var origVocab = studyRenderVocab; … = function`）。
   拆文件后变成各自作用域的副本，包装失效（2026-11-19 已经踩过一次）。
3. **测试切片顺序**：跨文件的函数顺序变化会让 `page.index()` 切片抓到别的段落。

结论：分层只能在**同一个拼接文件内**做，先建命名空间，再逐段搬，保证任一时刻成品可运行。

## 目标

| 层 | 职责 | 判定 |
| --- | --- | --- |
| kernel | 纯函数：时间解析/格式化、广告区间、章节切分、URL 归一、hash | 不读 DOM、不碰 `state`、无副作用；单测可直接在 node 里跑 |
| view | 渲染与 DOM 组装：各页面 HTML、列表、字幕行、主题应用 | 只读数据、只写 DOM，不发起网络请求 |
| bridge | 宿主适配：浏览器 XHR / Tauri invoke、WASM 与原生 ASR、Service Worker、媒体键、托盘 | 唯一允许出现平台分支（`window.__TAURI__`、`LIVE_HOST`）的地方 |

## 分期

### L0（已完成）

- `player.html` 只留标记；样式 `site/player.css`；脚本十个分片 + 拼接脚本 + 守护测试。

### L1：层标记与依赖清单（已完成）

- 在每个分片首行加一段层注释（`/* layer: view */`），说明该片属于哪层、对外暴露什么。
- 产出 `docs/player-js-dependency-map.md`：每个顶层声明 → 定义片 / 被引用片 / 引用次数，
  由一次性脚本扫描生成，人工复核。
- 结果：11 个分片（`00`–`10`）首行都有 `/* layer: … */`；`docs/player-js-dependency-map.md` 由
  `scripts/player_js_deps.py` 重新生成，现记录 11 个分片 / 768 个顶层声明 / 375 处跨片引用；
  `tests/test_player_build.py` 断言成品以 kernel 注释开头，`tests/` 全绿。

### L2：kernel 收口（已完成）

- 新增 `src/player-js/00-kernel.js`，挂 `const MYTK`，已搬 12 个纯函数：
  `fmt` / `isBracket` / `esc` / `loaderHTML` / `findNorm` / `epKey` / `studyRegexEscape` /
  `studyNormText` / `emptyLine` / `statHTML` / `pluginPageKey` / `isJsonTranscript`；
- 主脚本用同名解构接回，调用点零改动；
- `scripts/check_layers.py`（+`tests/test_layers.py`）守护三条边界：kernel 无 `state`/`app`/`document`/`fetch(` 等；
  633 个顶层函数跨分片不重名；`window.__TAURI__` 只出现在 `tauriHost()` 一处。
- 收口过程中查出真实缺陷：`fetchJson` 跨分片重名导致 `getJson()` 的超时被覆盖成 7000 ms，
  已改名 `fetchJsonTimed` 修正（详见 `docs/wiki/refactor-log.md`）。

推进规则：- 在 IIFE 顶部建 `const K = {…}` 命名空间，先把**纯函数**逐个搬进去，调用点改成 `K.xxx`。
- 每次只搬一个主题簇（如时间工具、广告区间、URL），搬完跑 `tests/` + 桌面壳实测。
- 禁止一次性搬完；跨测试切片的函数必须成组搬，或同步改测试只读对应分片。

### L3：bridge 收口（已完成）

- 平台检测只留一个函数：`tauriHost()`（`02` 分片），其余分片不再直接读 `window.__TAURI__`；
- 宿主能力只留一个句柄：`host()`（`02` 分片），原先散在 8 个分片的 94 处 `LIVE_HOST` 引用统一改走
  `host()`，定义行之外不再出现 `LIVE_HOST`；
- `check_layers.py` 锁定两条规则，越界即失败。

### L4：view 收敛（已完成）

- 路由渲染仍只有 `renderPage(page, route)` 一个派发入口（`07` 分片），页面函数不自行导航；
- `state` 读保持只读；写入全部改走 `setState(key, value)`（`01` 分片），146 处直接赋值与
  29 处同行多赋值共 175 处已迁移，0 处残留，由 `check_layers.py` 守护；
- 局部刷新（下载完成、收件箱更新、本地文件变化）仍直接调用对应 render 函数，不伪造路由。

## 护栏

- 每个阶段结束都要求：`tests/` 全绿、`python scripts/build_player_js.py --check` 通过、桌面壳实测。
- 一次只动一个层/一个主题簇；不合并提交。
- 出现白屏或识别链路异常，直接回滚该次提交，不带着问题往前叠。

## 不做的事

- 不引入 React/Vue、不引入打包器；`site/player.js` 不需要构建即可运行（拼接脚本只是文本合并）。
- 不改数据格式（词级 JSON/sidecar/progress），因此不触发 `docs/handover.md` 的数据章节更新。
