# 插件体系加固（2026-11-20）

来自外部审视的五条优先项，按“先能锁住行为，再扩生态”的顺序推进。

## 进度

| # | 事项 | 状态 |
| --- | --- | --- |
| 1 | 依赖环 + 插件宿主最小测试 | 已完成 |
| 2 | 收紧公开 API（白名单 host、只读 cues、版本协商） | 已完成 |
| 3 | 卸载/软重载生命周期（setup 返回 dispose、资源记账） | 已完成 |
| 4 | 信任模型（首次启用授权 + 撤销 + CSP + 签名/指纹） | 已完成：授权门禁 + 内容钉扎 + Ed25519 验签 |
| 5 | 可替换插件接缝（ASR 引擎 + 核心能力） | 已完成：三个 ASR 适配器；catalog / playback / downloads / queue 四接缝 |
| 6 | Rust 拆分（插件 + 离线下载 + 识别模型成模块） | 已完成；`main.rs` 1 321 行 |
| 7 | 内置插件升级策略（基线指纹） | 已完成 |
| 8 | 桌面 IPC 收口（插件不得直接调 Tauri 命令） | 已完成：`installIpcGuard` |
| 9 | 签名私钥轮换（多公钥验签） | 已完成：`PLUGIN_PUBKEYS` 两把钥并行 |
| 10 | 前端脚本真正模块化 | 已完成第一步：`player.js` 为 ES module，kernel 独立导出 |
| 11 | 复核后五条修正（权限定位、失败清理、内核归属、Provider 栈、摘要覆盖） | 已完成 |
| 12 | 学习数据与 SRS 迁到 study 插件（阶段一） | 已完成 |
| 13 | 学习 AI 请求/播放控制迁到 study 插件（阶段三） | 已完成 |
| 14 | 学习渲染迁到 study 插件（阶段二） | 代码完成，待实机验收 |

## 1. 依赖与宿主测试

- `PluginHost.available()` 遇到环现在返回 false（原实现 `stack.has(key) → true` 把 A→B→A 当合法）；
  每层用独立 path 集合，菱形依赖 a→(b,c)→d 不会被误判成环。
- 新增 `tests/test_plugin_host.py`：从分片切出 `PluginHost` 对象，在 node 里用最小桩跑
  环 / 自依赖 / 菱形 / 停用依赖 / 能力冲突五组断言。
- 同一 id 出现两次时只加载第一个，第二个记为「插件 id 重复」。

## 2. API 面

- `api.host` 换成冻结门面：`can / owner / status / available / registerKernel`，不再暴露
  `PluginHost.kernels` 与能力表本体。
- `api.cues()` 返回 `Object.freeze` 的深拷贝快照（cue 与 words 都复制），插件改不动宿主状态。
- `PLUGIN_API_VERSION = '2.0'`；`api.apiVersion`、`MyTPlugins.apiVersion` 同源；
  `register()` 接受 `apiVersion`，主版本不一致直接拒绝。

## 3. 生命周期

- `setup(api)` 可返回清理函数，保存在 `definition.__dispose`；
- 宿主按插件记账（`trackPlugin`）：页面、事件监听、命令、插件 CSS、能力占用；
- `MyTPlugins.stop(id)` + `reloadPlugins()` 软重载：回收注册物、重新 `loadPlugins`，
  设置页「重新加载」不再 `location.reload()`；
- `start()` 失败会回滚 `__started`，并以停用同一条路径回收已注册物（`abortPluginStart`：
  逆序清理、释放能力、清权限授予），不会把半启动插件的页面/事件/CSS 留在宿主里；

## 4. 信任模型（已落地：首次启用弹授权）

选型：只装可信代码 + 首次启用第三方插件弹页内授权，签名清单留作后续。

- Rust `plugin_list` 返回 `builtin` 字段，`subtitles` / `study` 自动放行；
- 第三方插件未记录授权时，注入脚本前弹层：列出“读页面内容 / 发网络请求 / 调桌面能力”，
  背景点按等同拒绝；选择写入 `localStorage` 的 `myt-plugin-consent:<id>`（allow / deny）；
- 设置页插件行显示授权状态，并给「撤销授权」，撤销后下次加载重新询问；
- `tauri.conf.json` 已启用 CSP：`script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net`，
  `style-src` 允许内联，`img/media/connect` 放行 https + asset 协议；
- 关键坑：Tauri 会给 CSP 注入 nonce，带 nonce 后 `'unsafe-inline'` 对内联脚本失效，插件脚本改走
  `blob:` URL 注入并用 `await load` 等它执行完再 `start()`；否则字幕插件不加载、整块文字稿空白；
- 已验证：启用 CSP 后首页、播放页（文字稿 + 词级高亮 + 播放）、设置页插件列表均正常。

## 4.5 签名与内容钉扎

- `plugin.json` 可带 `signature`（Ed25519 hex）：`plugins.rs` 对 `id + version + 生效清单字段`
  （`main`/`style`/`scripts`/`requires`/`permissions`/`apiVersion` 的紧凑 JSON）+ `每个脚本/样式的
  「文件名 + 内容」`做 SHA-256 摘要，用编译进二进制的公钥验签；不符 → 设 `signature: "bad"`，
  JS 加载前直接拒绝，设置页显示「签名校验失败」；
- 私钥只存在 `~/.config/myt/plugin-signing.json`（可用 `MYT_PLUGIN_SIGNING_KEY` 改路径），
  `scripts/sign_plugin.py <插件目录>` 签名、`--verify` 校验；私钥不进仓库、不进安装包；
- 未签名插件仍走首次启用授权，但授权时把内容指纹（`content_sha256(摘要)`，SHA-256）写进
  `localStorage` 的 `myt-plugin-hash:<id>`；之后文件或清单字段变动 → 指纹不符 → 撤销授权并弹「文件已被修改，
  旧指纹 → 新指纹」重新确认；
- 常量向量锁定两侧一致：`demo/1.0/main.js=console.log(1)\n` 的摘要
  `f7ab…48e3` 同时出现在 `plugins.rs` 单测与 `tests/test_sign_plugin.py`；
- 边界：内置插件不打签名（随应用铺下 + `.builtin.json` 基线），签名只解决「谁允许改」和
  「装的是不是原来那份」，不提供沙箱。

## 4.6 能力粒度授权

清单 `permissions` 声明式收窄，缺省（老清单）= 全权限，内置插件始终全权限。

- 取值：`ui.dom`（自动附带）、`net`、`player`、`storage`、`providers`、`subtitles`、`study`；
  （原来的 `desktop` 没有对应 API 入口，已移除，避免挂名权限）
- 宿主 API 按组校验：`api.player` / `api.storage` / `api.subtitles` / `api.study` 用 `Proxy` 包一层，
  方法调用时 `pluginRequire` 抛错；`api.openEpisode` 单独检查 `player`；`registerProvider` 需要 `providers`；
- **定位是 API 层约束，不是安全边界**：插件仍在同一 JS 环境，直接 `window.fetch`、直接摸 `__TAURI__`
  都不受 `permissions` 约束；CSP 的 `connect-src` 也放行 http/https；IPC 守卫只是拦 blob 帧的调用栈检查。
  真要隔离得换进程或独立 WebView，当前未做；
- 网络门：注入插件脚本时用 IIFE 参数遮蔽 `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource`，
  无 `net` 时只放行同源、`blob:`、`data:`、`asset:`；
- 授权层列出的是「实际可用能力」，不再是笼统的“完整权限”；权限集合变化会触发重新授权；
- 边界：同域 JS 环境，插件仍可 `window.fetch` 或 `document` 绕过（这是防手滑与误扩权，不是沙箱）。

## 4.7 桌面 IPC 收口

插件脚本和宿主在同一个 WebView、同一套全局对象里，`withGlobalTauri: true` 又让
`window.__TAURI__` 直接可见——插件写一行 `__TAURI__.core.invoke('plugin_*')` 就能绕过插件 API。

- 不能关 `withGlobalTauri`：mini 播放器、字幕浮层、取词窗都依赖它；
- 改为在 `02-live-caption-wasm.js` 顶层装守卫 `installIpcGuard(tauriHost())`，同时包住
  `__TAURI__.core.invoke` 与 `__TAURI_INTERNALS__.invoke`；
- 判据只看**紧邻 guard 的那一帧**（`pluginFrameInStack(new Error().stack)`）：栈里第一条
  `at ...` 且不含 `mytIpcGuard` 的帧，若含 `blob:` 就认定调用者是插件脚本，直接抛
  「插件不能直接调用桌面命令」；
- 这样插件通过宿主 API 间接触发 IPC（宿主函数在中间）不会被误伤，宿主自己的调用照常放行；
- 已实测：设置 → 模型管理页完整渲染（`asr_models` 等命令正常），播放页字幕/播放正常。
- 边界：栈帧检查可被刻意构造的间接调用绕过，属于“提高门槛”，不是权限隔离。

## 4.8 签名密钥轮换

`PLUGIN_PUBKEYS` 从单钥改为 `[&str; 2]`，`verify_plugin_signature` 遍历任一公钥验签，
因此新旧钥可以并行一个发布周期：

1. 追加新公钥 → 发布；
2. 用新私钥重签自签插件并分发；
3. 留一个周期后再删旧钥。

单测 `second_rotation_key_is_accepted` 用第二把钥的签名验同一摘要（`f7ab…48e3`）通过，
随机串被拒。轮换步骤也写进了 `docs/plugins.md`。

## 5. 可替换接缝：识别引擎

`src/player-js/02-live-caption-wasm.js` 里 `TRANSCRIBER_ADAPTERS` + `registerTranscriber(kind, {load})`，
引擎只暴露 `load() → engine`，engine 形状由 `liveStartStream` 约定（addAudio / transcribe / stop / close）。

- 三个适配器全覆盖：`native`（Rust 侧 sherpa）、`sherpa`（WASM 流式 zipformer）、
  `moonshine`（WASM 备用，词时间靠均分）；
- `liveLoadEngine()` 只剩查表 + 未知引擎报错，原来内联的 Moonshine 加载逻辑整段搬进
  `liveMoonshineLoad()`；
- 选引擎仍走 `?engine=moonshine|wasm`，没有壳时默认 sherpa。

## 5.5 可替换接缝：核心能力

`src/player-js/02-live-caption-wasm.js` 的 `CORE_PROVIDER_NAMES / defineCoreProvider /
registerCoreProvider / coreProvider / releaseCoreProviders`，插件侧入口
`api.registerProvider(name, impl)`：

| name | 必须实现 | 默认实现 |
| --- | --- | --- |
| `catalog` | `loadShows()` | `getJson('shows.json')` |
| `playback` | `play(showKey, episodeId, time?)` | `defaultPlayEpisode`（原 `playEpisode` 函数体） |
| `downloads` | `save(show, ep, opts?)` | `defaultDownloadEpisode`（原整集落盘逻辑） |
| `queue` | `next(radioOnly)` | `defaultPlayNextAuto`（节目内顺播 + 播放队列） |

- 覆盖实现能拿到 `fallback`，可以只在特定条件下接管、其余转调原逻辑；
- 覆盖按注册顺序入栈：后注册者在栈顶；停用/软重载只摘自己那层，恢复前一个插件，
  全部退出后才回默认（早期实现只有单个槽位，后注册会顶掉先注册，停用直接掉回默认）；
- `registerProvider` 记账进 `trackPlugin`，停用/软重载时 `releaseCoreProviders` 回退；
- 内核（`api.host.registerKernel`）也按插件 id 记账：已被别的插件占用时直接拒绝，
  停用时从 `PluginHost.kernels` 移除，不会留下旧内核（`kernel()` 返回的是实现本体）；
- 形状校验在登记时做（缺方法、未知名字直接报错），不会留半接管状态。

## 6. Rust 拆分：插件 / 离线下载 / 识别模型各自成模块

- `apps/windows/src-tauri/src/plugins.rs`（599 行）：插件目录、`enabled.json`、清单扫描、内置插件铺设与升级、
  示例插件生成、四个插件命令；
- `apps/windows/src-tauri/src/offline.rs`（550 行）：整集音频落盘、片段缓存、文字稿/跳过点旁挂文件、
  `offline_list` / `offline_remove` 等 9 个命令；
- `apps/windows/src-tauri/src/models.rs`（669 行）：`ModelSpec` / `MODELS` / `MODEL_MIRRORS`、
  `models_root` / `model_dir_for`，以及模型下载（多镜像 + 断点分块）、导入、删除、状态列表与
  `asr_*` 共 11 个命令；模型命令在 `generate_handler!` 里写 `models::asr_*`；
- `main.rs` 从 2 888 行降到 1 321 行，剩下的主要是 `AppState`、字幕窗口、媒体键、代理命令与应用装配。

## 6.5 内置插件升级规则

老实现只在文件不存在时写盘，应用升级永远更新不到已有安装。现在每个插件目录多一个
`.builtin.json`（文件 → 上次随应用铺下去的内容指纹，FNV-1a）：

- 文件不存在 → 写入并记基线；
- 文件内容 == 基线 → 认为用户没改，跟随新版本覆盖并更新基线；
- 文件内容 != 基线 → 用户改过，保留不动，也不更新基线（后续升级继续跳过）；
- 老安装首次接管：把当前内容记成基线，这一轮不改文件，下一次升级起正常跟随。

## 6.6 前端脚本模块化（第一步）

原来是 11 个分片拼回同一个 IIFE，成品只有一份 `site/player.js`。

- `build_player_js.py` 改为双产物：`site/player-kernel.js`（`00-kernel.js` 的 `const MYTK`
  换成 `export const MYTK`）+ `site/player.js`（首行 `import { MYTK } from './player-kernel.js'`，
  再接 01–10）；
- `site/player.html` 改成 `<script type="module" src="player.js"></script>`，模块作用域天然严格模式；
- `01` 只有一处 `const { … } = MYTK` 解构，import 头足够接回 kernel；
- `--check` 同时校验两个产物；`tests/test_player_build.py` 断言 import 头、kernel 导出、结尾收口，
  `tests/test_player.py` 断言页面用 `type="module"` 加载；
- 已实测：重建 exe 后首页、播放页字幕/播放、设置页均正常。
- 这一步只把“整包 + kernel”变成模块，01–10 仍共享同一模块作用域；再往下拆成每片独立模块
  需要把跨片引用全部改成显式 import/export，尚未做。

## 7. 学习实现迁往插件（阶段一）

目标不是“插件里放个入口”，而是学习数据与复习算法由插件持有，宿主只做渲染和播放控制。

已完成（阶段一，数据层）：

- 宿主新增 `STUDY_ENGINE` 接缝：`api.study.registerEngine(impl)` 注册、`api.study.engine()` 读取；
  owner 唯一，注册时 `trackPlugin` 记账，插件停用/软重载自动清空；
- 内置 `study` 插件增加 `engine.js`，持有 AI 服务设置、缓存、生词本、词状态与 SRS：
  `dueItems` / `srsGrade` / `stats` / `markWord` / `wordStatusOf` 和 4 个 `save*`，继续写原来的
  `myt-study*` 键，老用户数据不用迁移；
- 宿主 `08-study-ai.js` 把 `studyVocab/studyCache/STUDY/studyStatus` 换成插件引擎对象的引用，
  `saveStudy*`、到期列表、SRS、统计优先走引擎；没有插件（网页版/旧安装/停用）时保留本地回退；
- 实机：学习中心显示「AI 学英语已由插件接管」「生词本 1 个 · 今日到期 1 个 · 已缓存 1 条」
  「AI 服务：gemini · 已配置」，说明宿主状态读到的确实是插件引擎里的数据；
- 单测 `tests/test_study_engine.py` 覆盖老数据补齐、词状态归一、到期队列、SRS 间隔、缓存上限和设置写回。

阶段二、三已经迁完：句子卡/整集总结/复习页/词卡/设置的渲染在 `ui.js`，AI 请求与播放控制在
`runtime.js`；宿主只保留同名包装和没有插件时的回退。

阶段三（运行时）已补上：

- 插件增加 `runtime.js`：AI provider 配置解析、`llm_chat` 调用、JSON 解析、cue 定位等待、
  音频循环与自动暂停状态都在插件里；
- 宿主 `08-study-ai.js` 只留同名包装（`studyChat` / `studyCueBounds` / `studyPlayRange` …），
  内部转发到 `api.study.runtime()`；`api.study.host()` 提供 `state`/`audio`/`studyAutoPause`
  活引用、`seekTo`/`showToast`/`tauriHost`；
- 注册走 `api.study.registerRuntime(impl)`，owner 唯一、停用/软重载自动清空；
- 单测 `tests/test_study_runtime.py` 覆盖 offset 后的句界、循环重播/用完后暂停、句末自动暂停、
  provider 配置与 `llm_chat`、JSON 围栏解析；
- 实机：学习中心正常显示，说明插件 setup 里的 engine + runtime 注册都成功。

阶段二（渲染）已实现：

- 先把 `10-desktop-bridge-tail.js` 的四处猴补改成宿主 hook：`registerStudyUiHook('beforeEpisode' /
  'episode' / 'practice' / 'vocab' / 'episodeHtml')`，由插件渲染完对应视图后调用
  `api.study.runHook(...)`；磁盘缓存徽标、前情回顾、跨集时间线、盲听/多空/慢速入口和学习计划仍由 10 提供；
- 插件增加 `ui.js`（`createStudyUi(api, host)`），整段接管 `08-study-ai.js` 的学习面板、复习、词卡、
  整集总结、AI 设置、模型选择、练习和翻译设置入口；
- 宿主 `08-study-ai.js` 重写成薄包装，只做转发与回退；`04` 增加 `STUDY_UI` 槽、
  `registerStudyUi` / `studyUi()`，并扩展 `studyHostBridge()` 提供 `state` / `audio` / `reader` /
  `TR` / `TR_CACHE` 活引用、`seekTo` / `showToast` / `navigate` / `setView` / 自动暂停读写等原语；
- `plugin.json` 的 `scripts` 增加 `ui.js`，Rust seed 列表同步；`main.js` 在 engine/runtime 之后
  调用 `registerUi(createStudyUi(api, study.host()))`；
- 静态测试已覆盖：`tests/test_player.py` 的渲染断言改为 `player_page() + study_ui()` 合并检查；
  `tests/test_study_runtime.py` 覆盖运行时的循环与自动暂停。

自动探针验收（MYT_EVAL 注入页面 + 本地日志回传，未替代用户手动点击）：

- 学习面板能打开（`#studySheet` 带 `on`），当前句/问答/整集/练习/生词本页签切换无未捕获异常；
- 生词本页显示「学习计划 / 1 个词条 / Barreling 的释义、词根、复习按钮」；
- 打开真实播放页的缓存集后，整集页显示「本地缓存 / 内容摘要」与缓存正文，前情/时间线 hook 未报错；
- 学习中心「学习服务设置」能打开设置页，服务商、API Key、模型、讲解语言字段齐全。

**待用户实测确认后提交**。

## 8. 测试

- `tests/test_plugin_host.py` 八组：依赖/能力规则（含内核归属回收）、API 主版本兼容、生命周期回收
  （逆序、幂等、抛错不中断、`dispose` 只跑一次、setup 失败清理）、授权三态、核心 Provider 栈、
  权限授予与网络门、入口权限检查；
- `src/plugins.rs` 单测共 14 条：清单解析失败、缺清单、非法目录名、`main` 路径穿越、`scripts + main`
  拼接、`enabled.json` 覆盖默认值、`builtin` 标记、内置插件铺设/升级/保留用户修改/老安装基线，
  以及签名摘要（含清单字段跨语言向量）、坏签名与第二把公钥轮换；
- `cargo test --bin mytranscript-desktop` 合计 22 条（含原有字幕分词 4 条）。


