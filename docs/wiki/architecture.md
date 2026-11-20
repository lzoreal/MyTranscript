# 播放器脚本结构

2026-11-20 起，播放器脚本是 **显式 ES module 图**，不再是拼接出来的单文件：
`src/player-js/player.js` 是入口，逐个 import `00`–`10` 与 `host/**`；
`scripts/build_player_js.py` 只把源码**逐文件复制**到 `site/player/`，并让 `site/player.js` 保持一行
`import './player/player.js';`（成品入仓库，运行时零构建）。

## 为什么不再是“拼接”

拼接时代所有分片共享一个 IIFE 作用域：函数声明靠提升、`state` 是同一份可变绑定、
扩展段直接重新赋值 `studyRenderVocab`。拆成独立模块后这些隐式约定必须显式化，否则会静默失效
（2026-11-19 与 2026-11-20 各踩过一次）。现在的三条替代规则：

1. 共享可变单例集中在 `00-runtime.js`（`$ / audio / state / LIVE / prefs / tauriHost`），
   其它模块只 import；
2. `state` 只读，写入一律走 `setState(key, value)`（定义在 `01`）；
3. 需要反向调用（后序模块调用前序模块、或页面回调运行时）走 `00-layers.js` 的
   `registerLayer` / `lazyFn` / `layerObject`：先到的调用排队，注册后补执行。

## 模块与层

| 模块 | 层 | 职责 |
| --- | --- | --- |
| `00-kernel.js` | kernel | `MYTK`：28 个纯函数（时间、转义、括号、URL/hash、统计 HTML 等），不碰 DOM / `state` |
| `00-runtime.js` | runtime | 共享单例与平台句柄，不 import 任何功能模块 |
| `00-layers.js` | runtime | 运行时就绪注册表，消除静态 import 环 |
| `player.js` | 入口 | 只 import 全部分片，再调 `initPlayer()` / `initXai()` |
| `01-theme-reader-shell.js` | view | 主题、阅读器、导入、壁纸、`setState` |
| `02-live-caption-wasm.js` | bridge | Moonshine / sherpa WASM 实时字幕、`tauriHost()` / `host()` |
| `03-native-asr-service-worker.js` | bridge | Tauri 原生推理、跨域隔离 Service Worker、实时引擎适配器 |
| `04-local-audio-plugin-host.js` | bridge | 插件宿主：授权、清单、生命周期、能力 API、宿主 v2 贡献点装配 |
| `05-transport-transcript-nav.js` | view | transport、进度、文字稿交互、章节、离线、模型管理 |
| `06-catalog-feeds-search.js` | bridge | 目录、feed 缓存、OPML、在线搜索 |
| `07-routes-pages.js` | view | 路由与各页面渲染 |
| `08-study-ai.js` | view | 学英语宿主包装、设置页辅助与跨文档转发 |
| `09-player-integration.js` | view | 播放器与页面集成 |
| `10-desktop-bridge-tail.js` | bridge | MediaSession、托盘、迷你窗、`initXai()` |
| `host/contract.js` | host | 清单校验、版本判断、依赖排序、固定槽位、ctx 档案与 payload 版本 |
| `host/context.js` | host | 按贡献类型装配 ctx、api 白名单投影、旧版完整档案 |
| `host/registry.js` | host | 贡献点注册、冲突规则、排序、provider 栈、回收 |
| `host/legacy.js` | host | 旧清单归一化（缺 `contributions` 的 2.0 插件） |
| `host/faults.js` | host | 超时 / AbortSignal 取消 / 诊断，纯逻辑可在 node 里跑 |
| `host/requests.js` | host | 请求代次 + 每轮一个 AbortController |
| `host/ui-adapters.js` | host | 菜单、导入器、搜索源、主题的 DOM 适配；宿主只给 port |

层归属是一次人工判断，判定表见 `docs/superpowers/specs/2026-11-20-player-js-layering.md`。

## 插件宿主 v2 的装配面

- 页面：`MyTPlugins.define` → `HOST_V2.register` → `pages` 桥到原生页面或 `renderPluginPage`；
- 槽位：页面锚点写 `data-plugin-slot="<固定槽位名>"`，渲染后由 `applySlotMounts()` 扫描挂载，
  插件用 `mount(el, ctx, payload)` / `unmount(el)` 自己填内容；
- 设置分区：`openSettingsPane` 切到哪个 pane，就由 `applySettingsPanes(pane)` 渲染该 pane 的贡献；
- 上下文：`host/context.js` 按贡献类型装配 `ctx`（2.2 起收窄，2.1 清单走完整兼容档案），
  `ctx.signal` 在停用、页面销毁、槽位卸载、新搜索时 abort；
- 聚合入口（菜单/导入器/搜索源/主题）：DOM 全在 `host/ui-adapters.js`，宿主只创建实例、渲染后 `applyAll`；
- 停用或启动失败：`releaseSurfaces(id)` 先摘掉该插件的槽位与设置分区，再回收页面、命令、能力；
- 失败只影响自己：任一 `mount` / `render` 抛错只回收那一格，并记进插件错误，壳继续可用。

契约细节见 `docs/host-v2.md`，锚点与固定槽位表由 `tests/test_plugin_host.py` 对齐校验。

## 机器校验

```bash
python scripts/build_player_js.py --check   # site/player/ 逐文件与 src/player-js 一致
python scripts/check_layers.py              # kernel 纯净、函数不跨片重名、17 模块无环、入口可达
python tests/test_player_build.py           # 入口一行 import、模块头、kernel 导出
```

`check_layers.py` 对 kernel 的硬规则：不出现 `state` / `app` / `document` / `fetch(` 等副作用符号；
`window.__TAURI__` 只允许出现在 `tauriHost()` 一处，`LIVE_HOST` 只允许出现在 `host()` 一处。

## 不做的事

- 不引入打包器：`site/player.js` 与 `site/player/**` 直接可被浏览器当作 ES module 加载；
- 不改数据格式（词级 JSON / sidecar / progress），因此不触发 `docs/handover.md` 的数据章节更新；
- 不给插件做沙箱：插件仍与宿主同一 JS 环境，权限只是 API 层约束。
