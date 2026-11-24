# 插件接口

当前运行时是单宿主 `2.2`：插件与宿主同处一个 JS 环境，插件目录在
`C:\ProgramData\MyTranscript\plugins`。下一版“内核能力服务 + 声明式贡献点”的宿主设计见
[host-v2.md](host-v2.md)，对应决策见 [docs/adr](adr/)。

桌面壳从 2026-11-20 起扫描本机插件目录。插件默认拥有**完整页面与网络权限**（和主页面同一个 JS 环境），清单里写 `permissions` 可以按能力收窄；这只约束宿主 API，不是安全边界，只装自己信得过的代码。

## 目录

```text
C:\ProgramData\MyTranscript\plugins\
  enabled.json              # 启用状态，由设置页维护
  hello-world\
    plugin.json
    main.js
    style.css
```

每个插件一个子目录。`plugin.json`：

```json
{
  "id": "hello-world",
  "name": "Hello World",
  "version": "0.1.0",
  "description": "一句话说明",
  "author": "you",
  "enabled": true,
  "permissions": ["ui.dom", "net"],
  "scripts": ["kernel.js"],
  "main": "main.js",
  "style": "style.css"
}
```

- `id` 只能包含字母、数字、`-`、`_`，启停状态以它为准。
- `enabled` 只是首次发现的默认值；之后以 `enabled.json` 为准。
- `permissions` 可选，字符串数组，声明插件要用的能力；不写（或非数组）= 老行为，全权限。写了就只放行声明项，`ui.dom` 自动附带。可用值：`ui.dom`、`net`、`player`、`storage`、`providers`、`subtitles`、`study`、`media`、`llm`。缺 `net` 时插件里的 `fetch`/`XMLHttpRequest`/`WebSocket`/`EventSource` 只放行同源、`blob:`、`data:`、`asset:`；`api.player`/`api.storage`/`api.subtitles`/`api.study`/`api.media`/`api.llm`/`api.openEpisode`/`api.registerProvider` 缺权限会抛错。**这是 API 层约束，不是安全边界**：插件与宿主同一 JS 环境，仍可直接用 `window.fetch` 或 `__TAURI__`。
- `requires` 可选，字符串数组或 `{ "subtitles": "^0.3.0" }` 对象；对象值按 semver 范围校验。依赖插件被停用或不满足版本时，本插件进入 `blocked`，不会注入 JS。
- `apiVersion` 可选，旧清单缺省按 `2.0`；`2.x` 次版本不能高于宿主，`3.x` 直接拒绝。声明 `2.2` 才拿到按贡献类型收窄的 `ctx`
  （`ctx.signal`、`ctx.payloadVersion`），`2.0/2.1` 继续拿完整上下文。
- `contributions` 可选，声明式贡献点；v2 插件通过 `MyTPlugins.define(id, { contributions })` 登记。旧清单缺省为空对象，仍走 `register / page / on / command`。新清单字段与槽位见 [host-v2.md](host-v2.md)。
- 清单可以先脱离宿主校验：`node scripts/check_plugin_manifest.mjs <插件目录>`，多插件加 `--set`，旧清单加 `--legacy`。
- `scripts` 可选，按数组顺序先于 `main` 拼进同一个插件脚本；适合把解析/渲染内核拆成独立文件。
- `main` / `style` / `scripts` 只能是插件目录内的文件名，不能带路径。
- 加载前会先过一遍 v2 契约的旧清单兼容校验：id、路径、权限、未知槽位不合法会直接拒载；校验不会改写旧宿主仍要用的 `requires` 数组。

设置 → 插件：导入插件目录、打开目录、重新加载、生成示例插件、逐个启停。导入后默认停用，启用并授权后点「重新加载」生效。

应用默认**不带任何插件**，首次安装不会向插件目录铺文件；`apps/windows/builtin-plugins/` 只是随仓库提供的可选手动导入包，不参与启动。旧的 `.builtin.json` 指纹文件仅用于识别历史安装，导入不会复制它。

仓库里的六个官方包都已是声明式清单（`apiVersion: "2.1"` + `contributions`），导入后与第三方插件一样默认停用、首次启用需授权：

| 目录 | 贡献 | 说明 |
| --- | --- | --- |
| `home/` | `page:home`（native） | 首页；停用后宿主兜底渲染原生首页 |
| `library/` | `page:library`（native） | 播客库 |
| `downloads/` | `page:downloads`（native） | 下载管理 |
| `settings/` | `page:settings`（native） | 设置页 |
| `subtitles/` | `page:center` + `capability:subtitles` | 字幕中心与字幕能力 |
| `study/` | `page:study` + `capability:study`，依赖 `subtitles ^0.3.0` | 学习中心与学英语能力 |

`home/library/downloads/settings` 的页面代码通过按域拆开的只读服务复用宿主数据：`ctx.ui` 只放纯展示原语，订阅/节目数据在 `ctx.catalog`，进度在 `ctx.progress`，离线数据在 `ctx.downloads`，偏好与设置动作在 `ctx.settings`。`subtitles/study` 仍通过 `ctx.api` 使用各自的能力 API；实时识别与桌面字幕的会话生命周期都在字幕插件里。

**主题查询**：`data-theme` 现在是唯一真源，它的值可能是内置档 id（`ledger`），也可能是一张随包卡的 id（`ct-pack-<slug>`）——插件**不要**自己比字符串判断深浅或骨架，统一问 `ctx.settings`：

| 方法 | 返回 |
| --- | --- |
| `themeNames()` | 七档内置色板 `{id: 显示名}`，用来画设置页色板 |
| `themeId()` | 当前主题 id（内置档或卡） |
| `themeBase()` | 卡上点「停用」会回到的内置档 |
| `themeIsLight()` | 当前主题是否浅色（读 `html[data-scheme]`） |
| `themeSkeleton()` | 当前骨架：`rail / strip / print / grid`（读 `html[data-skel]`） |
| `themePacks()` | 随包卡清单 `{id, name, skeleton, light, active}`，`active` 只标当前那张 |

配色不要写死：插件页面的颜色全用宿主变量（`--panel / --panel2 / --line / --ink / --muted / --bright / --accent`，`--card` 由 `--panel` 派生），随包主题切过去时变量会跟着换，插件面板自动适配深浅。

另有四个 2.2 的实验包，贴在既有槽位上、不改播放内核：

| 目录 | 贡献 | 说明 |
| --- | --- | --- |
| `distill/` | `player.dock.actions` + `episode.body.before` + `page:distill`，依赖 `subtitles` | 随手摘录：当前句前后各一句收成卡片，可回跳、可导出 JSON；本机单集顺手裁 6 秒音频 |
| `soundbite/` | `episode.header.actions` + `page:soundbite` | 片段收藏：把正在听的 60 秒裁成本机 WAV，记路径；远程单集只提示先下载 |
| `podcast20/` | `episode.body.before` | 显示 `podcast:person` 嘉宾与 `podcast:alternateEnclosure` 音源，可复制直链；不接管选源 |
| `adscan/` | `episode.body.before`，依赖 `subtitles` | 广告区间文本弱版：只认字幕里明说的赞助句式，手动跳过 + 可关的自动跳过 |
| `ask/` | `episode.body.before`，依赖 `subtitles` | 本集问答：先本地检索原话，再把 8 段喂给模型作答，结论带 `[m:ss]` 可点跳；也支持纯检索 |

## 本机媒体能力（`api.media`，仅桌面壳）

插件不自己做音频解码，统一走宿主命令，输出固定是 16-bit PCM WAV，落在 `<应用数据>/clips/`：

- `api.media.available()`：判断当前壳有没有这项能力（网页版返回 `false`）。
- `api.media.probe(path)`：返回 `bytes / durationMs / sampleRate / channels / codec / hasAudio / kind`；`kind` 按扩展名区分 `video` 与 `audio`。`codec` 用解码器短名（`pcm_s16le`、`aac`），没注册的退回调试串；mp4 里的 aac 采样率/声道读自解码器，仍读不到时 `channels` 给 `0` 表示未知。纯视频文件没有音轨，`durationMs` 用视频轨的 `time_base` 兜底。
- `api.media.cut(path, startMs, endMs)`：按毫秒裁一段，单次最长 600 秒；返回 `path / bytes / seconds`。
- `api.media.extractAudio(path)`：整轨解码成 WAV，用来「视频只取音轨」；超过 4 小时拒绝。

只吃本机路径（`api.player.state().localPath` 或单集槽位载荷的 `localPath`），不会替插件下载远程单集。对应权限 `media`，清单不声明就调用被拒。

槽位里的 `api` 也带 `storage`（按插件 id 命名空间隔离）。摘录卡片、广告跳过开关、片段库都靠它落盘；少了它槽位挂载会直接抛 `Cannot read properties of undefined (reading 'get')`。

## 大模型问答能力（`api.llm`，仅桌面壳）

配置只有一份：**「设置 → AI 学英语」** 里的 provider / API Key / 模型 / 接口地址，存在 study 插件的引擎设置里。
`api.llm` 只读过来复用，不另开一套配置，也不会把 Key 原文交给插件。

- `api.llm.ready()`：是否可用（桌面壳 + 已填 Key 与模型 + custom 供应商已填 endpoint）。
- `api.llm.config()`：`provider / model / endpoint / configured / keyHint`，`keyHint` 只给密钥末四位。
- `api.llm.chat(system, user)`：单轮问答，返回纯文本。提示词由调用方给，宿主不内置任何人设。

对应权限 `llm`。实测前提：study 插件要启用（否则没有配置来源），且 AI 已配置好。
`ask` 插件是这套能力的第一个使用者：本地检索 8 段原话 → 只把这几段喂给模型 → 要求逐条标 `[m:ss]`、没有依据就说「这集里没提到」。

## 字幕插件（可选手动导入）

`apps/windows/builtin-plugins/subtitles/` 是一个可选的插件包，需要时在设置 → 插件里导入并启用；应用不会自动铺设或默认启用。它通过 `api.subtitles.claim()` 接管字幕功能：

- 接管后播放器才加载/解析文字稿，显示逐词字幕、实时识别、迷你字幕、壁纸字幕、本集搜索、学习与精听入口；
- 停用后播放器保持原生状态：点击播放**留在当前列表/单集页**，音频在迷你播放器里开始，不强制进入播放页，不下载/解析文字稿，也不提示或引导启用插件；下载、收听历史、收藏等基础功能不受影响；
- 桌面全局字幕也受这个插件门控：插件停用时 `captions_start` 直接报错，托盘入口不会启动会话；
- 插件自己的「字幕中心」页面可以查看当前句数/词数、切换双语、开关实时识别、精听刚才、导出字幕、开关桌面全局字幕、选择采集应用和打开阅读设置。
- 实时识别与桌面字幕的生命周期由插件拥有：`live.js` 注册为唯一实时控制器并绑定播放器按钮，`captions.js` 负责桌面会话/状态/应用选择；宿主只保留低层引擎与系统采集适配器。
- 文件分工：`kernel.js`（数据内核）、`view.js`（视图内核）、`live.js`（实时识别控制）、`captions.js`（桌面字幕控制）、`main.js`（claim + 字幕中心页面）、`style.css`；`plugin.json` 的 `scripts` 按 `kernel → view → live → captions` 顺序声明。

底层只剩**引擎与系统采集**作为桌面壳的宿主服务：`03` 的 `liveEnable / liveDisable / liveFollowCurrentEpisode` 与 `02` 的取字节/解码/推理泵，以及 Rust 的 WASAPI/浮窗/识别进程。**字幕数据与视图内核已经移进插件**：`kernel.js` 负责 JSON/VTT 解析、词级对齐、句子切分和双语合并，`view.js` 负责句块 DOM、240 句窗口渲染和双语列对齐，两者通过 `api.host.registerKernel('transcript', …)` 合并注册。主程序只保留 `cuesFromJson / parseVttSmart / parseZhVTT / vttFromSidecar / mergeCues / renderCues` 几个桥接函数，并把 `state / box / reader` 作为适配器交给插件。插件停用后内核不会注册，解析和渲染入口都不会执行。

## 插件宿主

播放器不再用一个个布尔开关判断功能是否可用，而是由 `PluginHost` 维护一张能力图：

```js
MyTPlugins.host.status('study');
// { id, state: 'active' | 'blocked' | 'disabled' | 'error', missing: [], error: '' }
MyTPlugins.host.can('subtitles');   // 能力是否已被插件 claim
MyTPlugins.host.available('study'); // 插件自身及依赖是否都启用
```

- 插件在 `setup` 里通过 `api.subtitles.claim()` / `api.study.claim()` 登记能力，同一能力只能有一个 owner；
- 依赖按 manifest 的 `requires` 递归解析，依赖被停用时插件不加载，设置页会显示“需要先启用：……”，不会出现半加载状态；
- 布局只在能力图变化时重算一次，不在每次播放事件里扫描 DOM；
- 兼容字段 `app.subtitleOwner` / `app.studyOwner` 仍保留，但只是能力图的投影，判断统一走 `PluginHost`；
- 依赖环会被判为“不满足”（A→B→A 不再当成合法配置），设置页显示缺失依赖而不是半加载；
- `api.host` 只暴露 `can / owner / status / available / registerKernel`，不再把 `PluginHost.kernels` 和能力表本体交给插件。

## 生命周期

- `setup(api)` 可以返回清理函数，也可以返回会解析出清理函数的 Promise；宿主等待初始化完成后再判定启动成功，停用时调用清理；
- 事件、页面渲染、槽位挂载、命令、能力、`setup` 和聚合贡献点执行统一有 10 秒超时；页面 `destroy`、
  插件 `dispose` 和清理函数也会等待异步结果。同步异常、异步拒绝和超时都会按插件隔离，不拖垮壳，
  并写入设置页可复制的诊断记录；
- `MyTPlugins.stop(id)` 停用单个插件；设置页的「重新加载」走软重载（`stop` → 重新 `loadPlugins`），不再刷新整页；
  出错插件行提供「重试加载」和「复制诊断」；
- 初始化失败时 `__started` 会回滚，插件状态显示为 error，不会留下半注册的页面或监听。

## 声明式贡献点

新插件用 `MyTPlugins.define(id, { contributions })` 登记，清单里逐个声明，宿主核对
`type:id` 后再装配；实现键是 `page:xxx` / `slot:xxx` / `settings:xxx` / `command:xxx` /
`provider:xxx` / `capability:xxx`。

```js
MyTPlugins.define('hello', {
  contributions: {
    'slot:hello.dock': {
      mount(el, ctx, payload) { el.innerHTML = '<button class="dockquickbtn">你好</button>'; },
      unmount(el) { el.innerHTML = ''; },
    },
    'settings:hello.pane': {
      render(el, ctx) { el.innerHTML = '<div class="setting-row"><strong>你好插件</strong></div>'; },
    },
  },
});
```

槽位只能挂到 `docs/host-v2.md` 里写死的 11 个名字，页面用 `data-plugin-slot` 标锚点；
设置贡献用 `pane` 指定挂到哪个设置分区。宿主给的是独立包装元素，插件不要自己决定插入位置。
`mount / render` 抛错只会回收自己那一格；插件停用或启动失败时宿主先调 `unmount` 再摘掉节点，
锚点回到空态。

四类聚合贡献点已经有宿主入口，实现键分别是 `menu:xxx` / `importer:xxx` / `searchSource:xxx` / `theme:xxx`：

```js
MyTPlugins.define('demo', {
  contributions: {
    'menu:export': { run(ctx) { /* 顶栏「⋯」 */ } },
    'importer:opml': { run(ctx) { /* 播客库工具栏 */ } },
    'searchSource:local': { search(ctx, query) { return '<div>…</div>'; } },
    'theme:ocean': { name: '海洋', css: ':root{--accent:#22aaff}' },
  },
});
```

聚合贡献允许不同插件使用同一个 id，宿主按 pluginId 分别保存，停用只回收自己的项。搜索源只允许最新一次
请求回写，源被移除或插件停用后旧响应不会落盘。插件主题、内置主题和自定义主题同一时间只生效一个。

菜单按钮使用清单里的 `title`，导入器和搜索源使用 `label`，主题使用 `name`；缺省都回退到贡献 id。
搜索源可以返回 HTML 字符串、DOM 节点或它们的数组，结果显示在搜索页的独立插件区域；主题样式注入
`#pluginThemeStyle`，切换回内置主题时自动移除。插件停用或启动失败时四类入口一起回收。

## 学英语插件（可选手动导入）

`apps/windows/builtin-plugins/study/` 同样是可选手动导入包，启用后和字幕插件拆开工作：

- 启用条件：`study` 已启用且 `subtitles` 已启用（没有文字稿就没有学习素材）；
- 负责播放器里的 AI 学英语入口、句子卡、整集总结、复习、练习、生词本、词卡和 AI 服务设置；
- 停用后隐藏学习入口、学习面板、词卡、生词本设置和单集页的 AI 总结按钮；字幕本身继续正常显示；
- 「学习中心」页面显示生词本数量、今日到期、缓存条数和 AI 服务配置状态，并能打开当前句卡、整集总结、复习和生词本。
- 数据引擎在插件里（`engine.js`）：AI 服务设置、缓存、生词本、词状态和 SRS 复习节奏由插件持有并写回原来的
  `myt-study*` localStorage 键；渲染层在 `ui.js`（`createStudyUi(api, host)`），宿主 `08-study-ai.js`
  只保留同名转发包装和没有插件时的本地回退。
  `api.study.engine()` / `api.study.ui()` 返回当前实现，`registerEngine` / `registerUi` 由插件注册（同一时间只允许一个 owner）。
- 循环、自动暂停、练习与生词上下文都属于插件闭包；宿主切集/seek 不直接写这些变量，而是调用
  `studyResetPlayback` / `studyResetAutoPause` / `studyResetContext`，由 `08` 转发给插件的
  `resetPlayback` / `resetAutoPause` / `resetStudyContext`。停用插件时这些调用是空操作。
- 桌面壳的增强补丁通过宿主 hook 接在插件渲染之后：`10-desktop-bridge-tail.js` 注册
  `beforeEpisode` / `episode` / `practice` / `vocab` / `episodeHtml`，由 `ui.js` 在对应视图里调用
  `api.study.runHook(...)`。补丁仍可读宿主 `state`，但不再覆盖 `studyRender*`。

## 入口

`main.js` 顶层调用一次 `MyTPlugins.register(id, { setup(api) { ... } })`。`setup` 在页面初始化、路由渲染之前执行。

```js
MyTPlugins.register('hello-world', {
  setup(api) {
    api.page('hello', {
      title: '插件示例',
      render(el) {
        el.innerHTML = '<div class="hello-card">Hello, plugin!</div>';
      },
    });
    const off = api.on('player:play', p => console.log('play', p.title));
    return () => off();
  },
});
```

## API

`api` 对象：

| 方法 | 说明 |
| --- | --- |
| `api.id` | 插件 id |
| `api.apiVersion` / `api.version` | 宿主 API 版本（当前 `2.2`）；`register` / `define` 可声明 `apiVersion`，主版本不一致或次版本高于宿主都会拒绝 |
| `api.toast(message, type?)` | 弹提示；`type = 'warn'` 时长更长 |
| `api.navigate(page, args?, params?)` | 跳主程序路由，比如 `api.navigate('library')` |
| `api.openEpisode(showKey, episodeId)` | 打开并播放某一集 |
| `api.page(pageId, {title, subtitle?, render(el), destroy?})` | 注册一个插件页面，自动出现在侧栏「插件」分组；路由 `#/plugin/<pluginId>/<pageId>` |
| `api.on(event, fn)` | 监听事件，返回取消函数 |
| `api.command(name, fn)` | 注册命令，主程序可用 `MyTPlugins.runCommand(pluginId, name)` 调用 |
| `api.registerProvider(name, impl)` | 接管核心能力，见下表；停用/重载自动回退默认实现 |
| `api.providers()` | 当前每个核心能力的归属（插件 id 或 `default`），只读 |
| `api.cues()` | 当前文字稿的只读快照（`Object.freeze`），改它不影响宿主；没有文字稿时为空数组 |
| `api.player.state()` | `{showKey, showName, episodeId, title, time, duration, paused, rate, cueIndex}` |
| `api.player.play/pause/toggle()` | 播放控制 |
| `api.player.seek(seconds)` / `seekBy(delta)` | 跳转 |
| `api.player.setRate(rate)` | 0.5–3 倍速 |
| `api.subtitles.claim()` | 接管字幕功能；同一个壳只能有一个插件接管 |
| `api.subtitles.status()` | `{owner, cues, words, lang, mode, live, wallpaper, episode}` |
| `api.subtitles.setLang(lang)` | `en` / `zh` / `both` |
| `api.subtitles.openSettings()` | 打开「文字稿与字幕」设置 |
| `api.subtitles.toggleLive()` | 开关实时识别；有插件注册 `live` 时转给它，否则返回 `false` |
| `api.subtitles.liveEngine` | 宿主低层引擎：`enable / disable(hint) / follow(resume) / status()` |
| `api.subtitles.registerLive(impl)` | 注册唯一实时控制器（`toggle / dispose / status`），插件停用时自动释放 |
| `api.subtitles.captions` | 桌面全局字幕适配器：`available / start(pid?) / stop / active / list / picker / setLookup / setZh / setCommit / setDrag / setOpacity` |
| `api.subtitles.clipNow(span?)` | 精听最近 N 秒，默认 15 |
| `api.subtitles.exportSubtitle(kind?)` | 导出当前字幕，默认 `txt` |
| `api.study.claim()` | 接管学英语功能；需要字幕插件已启用 |
| `api.study.status()` | `{owner, subtitles, vocab, due, cache, provider, configured, view, episode}` |
| `api.study.open(view)` | 打开学习面板：`card` / `episode` / `review` / `practice` / `vocab` |
| `api.study.openEpisode(showKey, episodeId)` | 打开某集的整集总结 |
| `api.study.openSettings()` | 打开 AI 学英语服务设置 |
| `api.study.cleanWord(raw)` | 宿主同款单词归一（去标点、转小写），给插件数据层用 |
| `api.study.registerEngine(impl)` | 注册学习数据引擎（设置/缓存/生词本/状态/SRS），同一时间只允许一个插件 |
| `api.study.engine()` | 取当前学习引擎；没有插件时返回 `null` |
| `api.study.registerRuntime(impl)` | 注册学习运行时（AI 请求、cue 定位、音频循环/自动暂停） |
| `api.study.runtime()` | 取当前学习运行时；没有插件时返回 `null` |
| `api.study.registerUi(impl)` | 注册学习渲染实现（面板/复习/词卡/总结/设置），同一时间只允许一个插件；成功绑定后提交槽位，失败先 dispose 再抛出，停用时调用 `disposeStudyUI` |
| `api.study.ui()` | 取当前学习渲染实现；没有插件时返回 `null` |
| `api.study.runHook(name, ...args)` | 调用桌面补丁注册的 hook（`beforeEpisode` / `episode` / `practice` / `vocab` / `episodeHtml`） |
| `api.study.host()` | 学习实现需要的宿主原语，按 `player` / `ui` / `catalog` / `translate` / `support` / `shell` 六组组织；`player.state` / `audio` 和 `translate.TR` / `TR_CACHE` / `reader` 都是白名单视图：只暴露插件实际需要的字段与方法，状态只读，音频只能写时间/倍速/音量等受控字段 |
| `api.storage.get(key, fallback)` / `set` / `remove` | 插件命名空间下的 localStorage，键前缀 `myt-plugin:<id>:` |

`registerEngine` 的 `impl` 需要提供这四个活对象：`settings`（AI 服务配置）、`cache`（句子/整集缓存）、
`vocab`（生词本）、`status`（词状态表），以及 `saveSettings` / `saveCache` / `saveVocab` / `saveStatus`、
`wordStatusOf` / `markWord` / `dueItems` / `srsGrade` / `stats`；`providers` 是唯一的 AI 服务商表
（名称、默认地址、默认模型、提示文案），运行时和渲染层都从这里读，不再各存一份。宿主接管这些引用后，
设置页、词状态高亮、到期徽标和复习按钮都直接读写插件持有的对象；插件停用时回退到宿主本地实现。

`registerRuntime` 的 `impl` 需要提供 `chat` / `parseJson` / `config` / `ready` / `native`、
`currentCue` / `withCues` / `currentKey` / `sourceLabel`、`cueBounds` / `playRange` / `playCue` /
`playItem` / `audioTick` / `stopAudio`，以及 `notePlaybackStart` / `notePlaybackEnded` / `resetAutoPause`。
宿主的 `08-study-ai.js` 只保留同名转发包装；AI 请求、cue 定位、循环播放和自动暂停都在 `runtime.js`。
`registerUi` / `ui()` 与 `registerRuntime` 并列，学习面板的 DOM 渲染和翻译设置绑定都在 `ui.js`；
自动翻译的 `TR` 配置与请求仍由 `07-routes-pages.js` 持有，插件通过 `host.translate` 读写。
| `api.el(id)` | `document.getElementById` |

插件仍与宿主同处一个 DOM 环境：`window`、`document`、`localStorage` 都可用（`fetch` 这类网络入口受 `net` 权限约束，见「权限与限制」）。

## 核心能力接缝

`api.registerProvider(name, impl)` 可以让插件替换宿主原有的四件事；`impl` 缺方法会当场报错。
覆盖实现按注册顺序入栈：后注册者在栈顶；停用/软重载只摘掉自己那层，恢复到前一个插件，
全部退出后才回默认实现。覆盖实现可以通过 `coreProvider(name).fallback` 调用原逻辑。

内核注册（`api.host.registerKernel(name, impl)`）按插件 id 记账：同名内核已被别的插件占用时
直接报错，停用/软重载自动移除，不会留在宿主里被下一个插件取到。

| name | 必须实现 | 默认行为 |
| --- | --- | --- |
| `catalog` | `loadShows()` | 读 `shows.json` 得到节目清单 |
| `playback` | `play(showKey, episodeId, time?)` | 原来的 `playEpisode`：切路由、定位、开播 |
| `downloads` | `save(show, ep, opts?)` | 原来的整集离线落盘 |
| `queue` | `next(radioOnly)` | 原来的「下一集」策略：节目内顺播 + 播放队列 |

## 事件

| 事件 | 触发 | payload |
| --- | --- | --- |
| `player:open` | 播放器打开一集 | `player.state()` |
| `player:play` / `player:pause` | 播放/暂停 | `player.state()` |
| `player:ended` | 播完 | `player.state()` |
| `player:time` | 播放中，约每秒一次 | `player.state()` |
| `player:cue` | 当前句切换 | `{index, text, start, end}` |
| `route:change` | 主页面路由切换 | `{page, args}` |

## 权限与限制

- 无沙箱：插件可以改任意 DOM、发任意请求、读页面里的数据。安装前先看代码。
- **权限是 API 层约束，不是安全边界**：`permissions` 只拦宿主的 `api.*` 入口与注入时的网络门；插件仍可直接 `window.fetch`（CSP 的 `connect-src` 放行 http/https）、直接摸 `__TAURI__`。要真正隔离需另起进程或独立 WebView，当前没做。
- 从用户目录导入的插件首次启用会弹页面内授权层，写明可读页面、可发请求、可调桌面能力；点「允许」才注入脚本，选择记在 `localStorage`（`myt-plugin-consent:<id>`）；
- 授权时同时钉住插件内容指纹（`myt-plugin-hash:<id>`）。之后 `plugin.json` 指向的脚本/样式只要改了一个字节，指纹就对不上，插件会被降级为「需重新授权」，弹层里列出旧指纹 → 新指纹；
- 授权同时记下当时的权限集合（`myt-plugin-perms:<id>`）。清单里新增权限后，下次加载会重新弹授权，不会悄悄扩权；授权层与设置页都按 `permissions` 列出实际可用能力；
- 清单可带 `signature`（Ed25519 hex），宿主用编译进二进制的公钥验签；签名不符直接拒绝加载，设置页显示「签名校验失败」。签名覆盖 `id`、`version`、**生效清单字段**（`main`/`style`/`scripts`/`requires`/`permissions`/`apiVersion`）与全部脚本/样式内容；授权指纹用 SHA-256。工具是 `python scripts/sign_plugin.py <插件目录>`（私钥默认 `~/.config/myt/plugin-signing.json`，不进仓库），验签用 `--verify`；
- 设置页的插件行会显示授权状态，并提供「撤销授权」，撤销后下次加载重新询问；当前所有插件（包括仓库里的官方包）都按这一套流程，手动导入后首次启用需要授权，没有官方免授权分层。
- `tauri.conf.json` 已启用 CSP（2026-11-20）：`script-src` 只放行自身、`blob:`、cdn.jsdelivr 与 wasm；`style-src` 允许内联（插件 CSS）；`img/media/connect` 放行 https + asset 协议 + 本机 http。授权层是产品级门禁，CSP 是第二道门，两者都不替代签名；
- 插件脚本以 `blob:` URL 注入（Tauri 的 CSP 会注入 nonce，使 `'unsafe-inline'` 对内联块失效），样式仍用内联 `<style>`；新增外部域名要在 `script-src` / `connect-src` 里显式登记。
- 桌面 IPC 收口：宿主把 `__TAURI__.core.invoke` 与 `__TAURI_INTERNALS__.invoke` 包了一层守卫（`installIpcGuard`）。紧邻调用帧是 `blob:` 时直接抛「插件不能直接调用桌面命令」，插件必须走 `api.*`（由宿主代发）。栈帧判断是尽力而为的门槛，不是沙箱。
- `withGlobalTauri` 必须保持 `true`：mini 播放器、字幕浮层、取词窗都直接用 `window.__TAURI__`；因此 IPC 只能靠上面的守卫收，不能靠关全局对象。
- 依赖环、重复 ID、无效清单这类配置错误会在插件行里显示错误，不会静默半加载（`tests/test_plugin_host.py` 锁定依赖解析与能力占用规则）。
- 示例插件通过 `MyTPlugins._error` 由壳记录错误，设置页会显示在插件行下面。
- 字幕功能由手动导入的 `subtitles` 插件接管，学英语由 `study` 插件接管；首页、播客库、下载管理等仍在主程序，尚未插件化。

## 签名密钥轮换

`plugins.rs` 的 `PLUGIN_PUBKEYS` 是**数组**，验签时任一公钥通过即放行。轮换按“先进后出”做，任意时刻插件都还能验：

1. 把新公钥追加到 `PLUGIN_PUBKEYS`（旧钥留在数组里），编译并发布这一版；
2. 确认用户都升到带新钥的版本后，用 `scripts/sign_plugin.py`（读 `~/.config/myt/plugin-signing.json` 里的新私钥）重签所有自签插件，再分发；
3. 至少留一个发布周期，之后才从数组里删旧公钥并发布。

私钥不进仓库、不进安装包；`MYT_PLUGIN_SIGNING_KEY` 可指到另一份密钥文件。`tests/test_sign_plugin.py` 与 `plugins.rs` 单测用同一条常量向量（`f7ab…48e3`）锁住两端摘要算法，轮换后仍应保持通过。

## 脚本构建与模块

- 宿主脚本现在是 **显式 ES module 图**：`site/player.js` 只写 `import './player/player.js';`，`site/player/player.js` 显式导入 `00-kernel / 00-runtime / 01…10`，再调 `initPlayer()` 与 `initXai()`；`site/player.html` 用 `<script type="module">` 加载；
- `site/player/` 由 `src/player-js/*.js` **逐文件复制**，不再把 01–10 拼进同一个模块作用域，也没有 `site/player-kernel.js`；跨分片共享的单例集中在 `00-runtime.js`，其余依赖通过 import/export 解析；
- 产物不许手改：`python scripts/build_player_js.py`，一致性校验用 `--check`（`tests/test_player_build.py` 锁定入口一行导入、各分片 import/export 与 kernel 纯度）。

