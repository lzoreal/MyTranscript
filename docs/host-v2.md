# 宿主 v2 与插件公共契约

Status: accepted（2026-11-20）

## 实施状态

- 2026-11-20：公共契约与注册表已落成 `src/player-js/host/contract.js`、`src/player-js/host/registry.js`，配套测试宿主 `tests/host/test-host.mjs` 与契约测试 `tests/host-contract.test.mjs`；旧清单适配器 `src/player-js/host/legacy.js` 已接入 `loadPlugins` 做最小校验。
- 2026-11-20：`MyTPlugins.define` 已接入现有 `start`。v2 插件走 `HOST_V2.register`，`pages` 桥到原生页面或 `registerPluginPage`，`providers` 桥到 `registerCoreProvider`，`commands` 桥到 `PLUGIN_COMMANDS`，`capabilities` 仍走 `PluginHost.claim`。
- 官方插件已全部改声明式清单（`apiVersion 2.1` + `contributions`）：`home`、`library`、`downloads`、`settings` 贡献原生页面，`subtitles` 贡献 `page:center` + `capability:subtitles`，`study` 贡献独立 `page:study` + `capability:study` 并依赖 `subtitles ^0.3.0`。六个插件已在真机装配验证：页面接管、字幕 claim、播放不中断、设置页无报错。
- 官方插件仍按第三方同一流程手动导入并首次授权，本机默认不带插件；`builtin` 信任分层未实现，ADR-0003 已按此口径收敛。
- 2026-11-20：槽位与设置分区已在真实宿主落地。页面锚点用 `data-plugin-slot` 标出全部 11 个固定槽位，
  `applySlotMounts()` 在渲染后扫描挂载，`applySettingsPanes(pane)` 在切换设置分区时渲染；
  每个贡献给独立包装元素，`mount / unmount / render` 抛错只回收自己那一格。插件停用、启动失败、
  软重载都会先 `releaseSurfaces(id)` 再回收其余注册物，锚点回到空态。
- 2026-11-21：`menus`、`themes`、`importers`、`searchSources` 已接宿主入口：菜单进顶栏「⋯」，
  导入器进播客库工具栏，搜索源进搜索页，主题进设置的主题网格；实现契约见下文「聚合贡献点接口」。
- 2026-11-21：插件的事件、页面渲染、槽位挂载、命令和启动统一走 10 秒超时边界；同步异常、异步拒绝和
  超时都会进入按插件隔离的诊断记录，设置页提供「重试加载」和「复制诊断」。
- 2026-11-21：故障边界继续覆盖聚合贡献点执行，以及页面 `destroy`、插件 `dispose` 和清理函数；异步清理
  拒绝同样进入诊断。搜索源只允许最新一次请求回写，搜索源移除或插件停用会作废在途响应。
  聚合贡献的 id 按插件隔离，插件主题与内置/自定义主题互斥。
- 2026-11-21（2.2）：`ctx` 改为按贡献类型装配，`host/context.js` 只挂该类型需要的组；每类 payload 有独立
  版本号（`ctx.payloadVersion`），槽位锚点可用 `data-slot-payload-version` 覆盖。2.0/2.1 清单继续拿 2.1 的
  完整上下文（一个发布周期的兼容层）。菜单、搜索源、主题、导入器的 DOM 适配移到 `host/ui-adapters.js`。
- 2026-11-21（2.2）：每次贡献调用带 `AbortSignal`；停用插件、页面销毁、槽位卸载、发起新搜索都会真的
  中止底层任务（`ctx.signal`），不再只是丢弃结果。取消走 `AbortError`，不写插件诊断。
- 2026-11-21：`scripts/check_plugin_manifest.mjs` 提供清单校验 CLI（单插件 / `--set` 集合 / `--legacy`），
  `examples/plugins/search-echo` 是 2.2 契约示例，测试宿主同时模拟 `ctx` 与取消信号。
- `commands` / `providers` 已桥接但暂无官方包使用。

把宿主从“播放器 + 插件”改成“能力服务内核 + 功能域插件”的组合运行时。本文是实施口径；决策背景见
[ADR-0001](adr/0001-host-kernel-boundary.md)、[ADR-0002](adr/0002-public-plugin-contract.md)、
[ADR-0003](adr/0003-official-vs-third-party-trust.md)、[ADR-0004](adr/0004-plugin-failure-isolation.md)、
[ADR-0005](adr/0005-narrow-context-and-cancellation.md)。

## 目标

- 内核只保留能力服务；业务页面全部由插件声明。
- 官方插件与第三方插件使用同一套公共契约。
- 插件失败只影响自己的槽位，壳始终可用。
- 公共 API `2.x` 只增不破。

## 非目标

- 不做不可信插件沙箱：插件仍与宿主同处一个 JS 环境。
- 不做插件市场、在线发现或自动更新；仓库里的官方包与第三方包都手动导入，应用启动不铺设。
- 不保留运行时双壳；旧宿主在一次发布中替换。

## 目录

```text
apps/windows/
  builtin-plugins/                  # 随仓库提供的可选手动导入包，不参与启动
    home/
    library/
    downloads/
    settings/
    subtitles/
    study/
  src/player-js/
    host/
      contract.js                   # 清单校验、贡献点、槽位、版本、ctx 档案
      context.js                    # 按贡献类型装配 ctx、api 投影、payload 版本
      registry.js                   # 贡献点注册、冲突规则、槽位排序
      legacy.js                     # 旧清单归一化
      faults.js                     # 超时 / 取消 / 诊断边界
      requests.js                   # 请求代次 + AbortController
      ui-adapters.js                # 菜单、导入器、搜索源、主题的 DOM 适配
    plugins/                        # 第一期未使用；页面代码直接留在上面六个目录
      home/
      library/
      downloads/
      subtitles/
      study/
```

插件运行目录仍是 `C:\ProgramData\MyTranscript\plugins`，官方包与第三方包都从这里导入。仓库里的
`builtin-plugins/` 不会在启动时复制到用户目录。

`scripts/build_player_js.py` 需要复制 `src/player-js/host/**`，并校验 `site/player/` 与源码一致。

## 插件清单

```json
{
  "id": "study",
  "name": "学英语",
  "version": "1.0.0",
  "apiVersion": "2.1",
  "description": "一句话说明",
  "requires": { "subtitles": "^1.0.0" },
  "permissions": ["ui.dom", "player", "storage", "net", "study"],
  "contributions": {
    "pages": [{ "id": "study", "title": "学习中心", "nav": "plugins", "order": 20 }],
    "slots": [{ "id": "study.episode", "slot": "episode.actions", "order": 20 }],
    "settings": [{ "id": "study.ai", "pane": "study" }],
    "commands": [{ "id": "study.review", "title": "开始复习" }],
    "providers": [],
    "capabilities": [{ "id": "study" }],
    "importers": [],
    "searchSources": [],
    "menus": [],
    "themes": []
  },
  "scripts": ["engine.js", "runtime.js", "ui.js"],
  "main": "main.js",
  "style": "style.css"
}
```

- `id` 只允许字母、数字、`-`、`_`。
- `requires` 的值是 semver 范围；宿主拓扑排序，缺依赖进 `blocked`，环直接拒绝。
- 没有 `official` 字段，也不按目录区分官方与第三方；仓库里的官方包导入后同样默认停用、首次授权。
- `signature` 对任何插件都是可选的；签名覆盖清单生效字段和全部脚本/样式，验签失败直接拒载。

## 运行时注册

```js
MyTPlugins.define('study', {
  contributions: {
    'page:study': { render(el, ctx) {} },
    'slot:study.episode': { mount(el, ctx, payload) {} },
    'settings:study.ai': { render(el, ctx) {} },
    'command:study.review': { run(ctx, args) {} },
    'capability:study': { claim(ctx) {} },
  },
});
```

`define` 不执行任意全局挂载。宿主核对每个 `type:id` 都在清单里声明过；多出、重复或未授权的贡献拒绝加载。

`ctx` 从 `2.2` 起按贡献类型装配，不再把所有服务塞给每个贡献。所有类型都带 `ctx.id`、`ctx.apiVersion`、
`ctx.contextVersion`、`ctx.contribution`、`ctx.payloadKind`、`ctx.payloadVersion`、`ctx.signal`；其余组按下表发放：

| 贡献类型 | player | events | storage | navigate | capability | api | ui | catalog | progress | downloads | settings |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `pages` | ✓ | ✓ | ✓ | ✓ | ✓ | 完整 | ✓ | ✓ | ✓ | ✓ | ✓ |
| `slots` | ✓ | ✓ | ✓ | ✓ | ✓ | 投影 | ✓ | ✓ | ✓ | ✓ | — |
| `settings` | — | ✓ | ✓ | ✓ | ✓ | 投影 | ✓ | — | — | — | ✓ |
| `commands` | ✓ | ✓ | ✓ | ✓ | ✓ | 投影 | ✓ | ✓ | ✓ | ✓ | — |
| `providers` | — | — | — | — | — | 最小 | — | — | — | — | — |
| `capabilities` | ✓ | ✓ | ✓ | ✓ | ✓ | 完整 | — | — | — | — | — |
| `importers` | — | ✓ | ✓ | ✓ | ✓ | 投影 | ✓ | ✓ | ✓ | — | — |
| `searchSources` | ✓ | ✓ | ✓ | ✓ | ✓ | 投影 | ✓ | — | — | — | — |
| `menus` | ✓ | ✓ | ✓ | ✓ | ✓ | 投影 | — | — | — | — | — |
| `themes` | — | — | — | — | — | — | — | — | — | — | — |

- `api` 投影只保留该类型需要的入口：`subtitles` / `study` / `storage` 这些大组不再出现在菜单、搜索源、
  导入器里；`pages` 与 `capabilities` 拿完整 `api` 是因为它们要接管字幕/学习链路。
- `2.0` / `2.1` 清单走 `LEGACY_CONTEXT_KEYS`，装配与 2.1 完全一致；插件把 `apiVersion` 改成 `2.2` 才收窄。
  这是版本兼容层：旧插件不需要改，新插件不能再靠“多拿几个组”搭顺风车。
- `ctx.ui` 仍是纯展示原语（`$ / esc / fmt / emptyLine / statHTML / coverHTML / episodeRowHTML / podCardHTML`）。
- `ctx.capability(name)` 只在插件 claim 成功后返回可用对象；`themes` 不需要。

## payload 版本与取消

- 每类贡献的 payload 有独立版本：`page / slot / settings / command / provider / capability / importer /
  searchResult / menu / theme` 各自从 1 起，`ctx.payloadVersion` 读出当前期望值。槽位锚点可以写
  `data-slot-payload-version` 覆盖；搜索源可以返回 `{ version, items }`，宿主也继续接受字符串、DOM 节点与数组。
- 每次贡献调用都带 `AbortSignal`（`ctx.signal`）。插件停用、启动失败、页面销毁、槽位卸载、设置分区回收、
  发起新的搜索都会 abort 对应作用域；底层 `fetch` / `XHR` / 等待循环可以真正停下。
- 取消的结果是 `AbortError`（`code: plugin_aborted`），不写插件诊断、不弹错误；超时仍然是普通故障并进诊断。
- 搜索代次与取消是同一份控制器：`begin()` 换新控制器并 abort 上一轮，`invalidate()` 同时清代次与信号。

不主动向插件暴露内核模块、原始 DOM 引用或内部服务对象。实时识别的 `enable / disable / follow`
仍由宿主引擎提供，但“何时开、刷新后续开、插件停用时停止”已经归字幕插件；全局桌面字幕的
会话开关、状态、应用选择也在字幕插件，Rust 只保留 WASAPI 采集与识别进程。

## 贡献点

| 类型 | 宿主行为 | 冲突规则 |
| --- | --- | --- |
| `pages` | 注册路由与导航项，激活时渲染 | ID 唯一，重复拒绝 |
| `slots` | 固定槽位内装配，按 `order` 排序 | 可多；同序按插件 id |
| `settings` | 设置页分区/pane | 可多；同序按插件 id |
| `commands` | 命令表与菜单入口 | ID 带插件命名空间，重复拒绝 |
| `providers` | 栈式覆盖内核能力服务 | 后进在栈顶，停用只摘自己 |
| `capabilities` | 独占 claim | 同一能力只允许一个 owner |
| `importers` | 文件/URL 导入入口 | 同一插件内 id 唯一；跨插件按 pluginId 隔离 |
| `searchSources` | 跨集搜索来源 | 同一插件内 id 唯一；只允许最新请求回写 |
| `menus` | 菜单项贡献 | 同一插件内 id 唯一；跨插件按 pluginId 隔离 |
| `themes` | 主题包 | 同一插件内 id 唯一；全局只激活一个 |

## 聚合贡献点接口

```js
MyTPlugins.define('demo', {
  contributions: {
    'menu:export': { run(ctx) { /* 顶栏「⋯」菜单 */ } },
    'importer:opml': { run(ctx) { /* 播客库工具栏按钮 */ } },
    'searchSource:local': {
      search(ctx, query) { return '<div>…</div>'; }, // 字符串、DOM 节点或数组
    },
    'theme:ocean': {
      name: '海洋',
      css: ':root{--accent:#22aaff}',
    },
  },
});
```

- `menus[].title` / `importers[].label` / `searchSources[].label` / `themes[].name` 是按钮或卡片标签，
  缺省回退到贡献 id。
- 菜单、导入器在点击时执行 `run(ctx)`；搜索源读取当前搜索框并执行 `async search(ctx, query)`；
  返回值可以是字符串、DOM 节点、数组，或 2.2 的 `{ version, items }`；主题按 `themes[].css` 注入
  `<style id="pluginThemeStyle">`，内置或自定义主题生效时自动移除。
- 四类入口都会在插件停用或启动失败时自动消失；同名贡献不会覆盖其他插件，停用只摘自己的那一项。
- 搜索源只允许最新一次请求回写，并且每次 `begin()` 会 abort 上一轮；切换到另一个源、移除搜索源或停用
  插件都会中止在途请求。
- 应用插件主题会先停用自定义主题；切回内置或应用自定义主题会回收插件主题，三者不会叠加。
- 搜索源返回的内容整体挂在 `search.results.after` 之前的独立区域，不混进宿主结果数组。

## 固定槽位

首版槽位名固定；新增槽位是 `2.x` 的追加，改名或删除是 `3.0`。

- `nav.main`
- `home.hero.after`
- `home.continue.actions`
- `episode.header.actions`
- `episode.body.before`
- `player.dock.actions`
- `player.sidebar`
- `settings.panes`
- `library.toolbar`
- `downloads.empty`
- `search.results.after`

槽位契约包含 `payload`、允许的贡献类型、排序和回收方式。插件只拿宿主给的元素，不自行决定插入位置。

## 生命周期

```text
discovered → validated → authorized → loaded → active
                    ↘ blocked / error / quarantined
```

- `discovered`：扫描用户插件目录 `C:\ProgramData\MyTranscript\plugins`，不扫描仓库或安装目录。
- `validated`：清单结构、ID、`apiVersion`、贡献点、依赖和签名。
- `authorized`：所有插件读授权、指纹和权限；没有“官方直接通过”。
- `loaded`：注入脚本并等待 `define`，超时视为 error。
- `active`：注册页面、槽位、命令、provider、监听和样式。
- 停用或失败：按插件 id 回收全部注册，槽位回退原生或空态；页面 `destroy`、插件 `dispose` 和清理函数
  的异步拒绝同样走统一故障边界与诊断。

启动时先渲染壳骨架和原生回退；插件页面在激活前被路由到时显示骨架，超时进错误页。

## 官方可导入包

| 插件 | 负责 | 依赖 |
| --- | --- | --- |
| `home` | 首页、继续收听、今日编辑选择 | 无 |
| `library` | 播客库、单集列表、订阅管理 | 无 |
| `downloads` | 下载管理、离线队列、清理 | 无 |
| `settings` | 设置页全部面板 | 无 |
| `subtitles` | 字幕、实时识别、桌面字幕、字幕中心 | 无 |
| `study` | 学英语、句子卡、复习、生词本、词卡 | `subtitles ^0.3.0` |

六个包都已完成迁移；`home/library/downloads/settings` 的页面代码已改接 `ctx.catalog / ctx.progress /
ctx.downloads / ctx.settings`，`ctx.ui` 只剩纯展示原语。没有安装任何插件时，首页/库/下载/设置由宿主原生渲染，
播放留在当前页。

## 版本与兼容

- 公共 API 从 `2.1` 起引入贡献点；`2.x` 只追加。
- `2.2` 追加按类型收窄的 `ctx`、独立 `payloadVersion` 与 `ctx.signal`。收窄只对声明 `2.2` 的插件生效，
  `2.0/2.1` 插件继续拿完整上下文，因此不需要重写旧插件；新插件想用被收掉的组，必须显式声明 `2.2` 并
  改用对应贡献类型。
- 宿主向插件公布支持的贡献点表；插件要求的贡献点缺失时拒绝加载。
- `3.0` 破坏性变更必须提供一版 `compat/3.0` 适配层。
- 清单里的 `apiVersion` 主版本必须与宿主一致；次版本按“插件要求的次版本 ≤ 宿主次版本”判断。
  清单加载和运行时 `register / define` 共用 `host/contract.js` 的同一个 `apiCompatible`，宿主版本号也只
  引用 `HOST_API_VERSION`，不再各写一套。
- 清单校验可以脱离宿主运行：`node scripts/check_plugin_manifest.mjs <插件目录>`，
  集合模式加 `--set`，旧清单加 `--legacy`。

## 迁移

1. 抽公共契约与契约测试，不改现有行为。
2. 建宿主 v2 内核服务与贡献点注册表。
3. 一次性迁 `home`、`library`、`downloads`、`subtitles`、`study`、`settings`；开发期分步，发布时一次替换。
4. 旧数据键、离线目录、播放进度原样沿用；不重命名、不清空。
5. 发布层保留上一版安装包和数据兼容；运行时没有 `MYT_HOST_V2` 双壳。

## 验收

- 官方六个包全部通过同一套测试宿主，不使用内部桥。
- 清单校验、贡献点冲突、依赖排序、停用回收各有自动化测试。
- 单个插件抛错后壳仍可用，槽位回退，设置页显示隔离状态。
- 插件页面在激活前由宿主原生页兜底，不出现空白页。
- `2.x` 公共 API 快照测试通过；新增贡献点不破坏旧插件。
- 任一插件文件指纹或权限变化后重新授权，包括仓库里的官方包。
- 停用一个插件后，页面、命令、provider、监听、样式全部消失。
