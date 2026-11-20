# 播放器脚本分层结构

2026-11-20 起，播放器脚本不再是一个 553 KB 的单文件，而是 `src/player-js/` 下的 11 个分片，
由 `scripts/build_player_js.py` 纯字符拼接成 `site/player.js`（成品入仓库，运行时零构建）。

## 为什么拼接而不是拆独立 `<script>`

2026-11-19 的教训：主脚本是 `(() => { … })()`，`state`、`studyRender*` 都是 IIFE 私有绑定，
放到第二个 `<script>` 里包装会静默失效（见 `docs/handover.md` 学习侧扩展一节）。
另外同一 script 内函数声明会提升，拆开后后加载的声明对前面不可见。所以只在拼接文件内部切分。

## 分片与层

| 分片 | 层 | 职责（2026-11-20） |
| --- | --- | --- |
| `00-kernel.js` | kernel | `MYTK`：12 个纯函数（`fmt`、`isBracket`、`esc`、`loaderHTML`、`findNorm`、`epKey`、`studyRegexEscape`、`studyNormText`、`emptyLine`、`statHTML`、`pluginPageKey`、`isJsonTranscript`） |
| `01-theme-reader-shell.js` | view | 主题、阅读器、导入、壁纸；主 IIFE 开头，解构接回 kernel |
| `02-live-caption-wasm.js` | bridge | Moonshine / sherpa WASM 实时字幕 |
| `03-native-asr-service-worker.js` | bridge | Tauri 原生推理、跨域隔离 SW |
| `04-local-audio-plugin-host.js` | bridge | 本地音频插件宿主、预转写、精听 |
| `05-transport-transcript-nav.js` | view | transport、进度、文字稿交互、章节、离线、模型管理 |
| `06-catalog-feeds-search.js` | bridge | 目录、feed 缓存、OPML、在线搜索 |
| `07-routes-pages.js` | view | 路由与各页面 |
| `08-study-ai.js` | view | 自动翻译、AI 学英语 |
| `09-player-integration.js` | view | 播放器集成 |
| `10-desktop-bridge-tail.js` | bridge | MediaSession、托盘、迷你窗、IIFE 收尾 |

层归属是一次人工判断，不是强制边界；判断依据见 spec 的判定表。

## kernel 的接入方式

`00-kernel.js` 在 IIFE 之前定义 `const MYTK = (() => {…})()`；`01` 的 IIFE 内用同名解构接回：

```js
const { fmt, isBracket, esc, loaderHTML, findNorm, epKey, studyRegexEscape, studyNormText, emptyLine, statHTML, pluginPageKey, isJsonTranscript } = MYTK;
```

调用点一处未改，这是搬迁能保持零行为差异的原因。

## 层边界（L3 / L4 收口后）

- 平台检测：`tauriHost()`（`02`），全仓只此一处读 `window.__TAURI__`；
- 宿主能力：`host()`（`02`），其余分片只经它取 `LIVE_HOST`，字面量只出现在定义行；
- 状态写入：`setState(key, value)`（`01`），`state` 只读；路由派发只有 `renderPage(page, route)`。

上述四条由 `python scripts/check_layers.py` 机器校验，越界直接失败。