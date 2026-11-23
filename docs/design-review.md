# 设计评审：MyTranscript 的深模块化（2026-11-22）

按 `codebase-design` 的词汇（module / interface / implementation / depth / seam / adapter /
leverage / locality / deletion test）对整个仓库做一次盘点，结论是**设计判断，不是待办清单**。
运维与数据流事实仍以 [handover.md](handover.md) 为准。

## 一句话结论

真正深的地方是**插件契约层**（`src/player-js/host/contract.js`）和**流水线层**（`pipeline_*`）；
播放器那 12 层是"接口极大、实现也在里面"的浅切片——seam 按**文件**切了，而不是按**能力**切。

## 盘点数据（2026-11-22 实测）

- 播放器 12 层、746 个顶层函数（`check_layers.py` 报的数字）。
- 每层 `registerLayer('<id>', {...})` 把几乎所有内部名字都导出去：

| 层 | 导出名字数 | 体量（行） |
| --- | --- | --- |
| `05-transport-transcript-nav` | **222** | 2135 |
| `01-theme-reader-shell` | **129** | 1710 |
| `04-local-audio-plugin-host` | **106** | 2150 |
| `08-study-ai` | 80 | 212 |
| `02-live-caption-wasm` | 72 | 1138 |
| `07-routes-pages` | 63 | 1592 |
| `06-catalog-feeds-search` | 55 | 736 |
| `03-native-asr-service-worker` | 34 | 1074 |
| `10-desktop-bridge-tail` | 30 | 2116 |
| `09-player-integration` | 26 | 311 |
| `00-runtime` | 19 | 104 |

- 跨层取用 **184 处**，全部是 `lazyFn('<layer>', '<name>')` 在调用时按字符串解析：

```
01 → 03 04 05 06 07 08 09 10      (29 处)
04 → 05 06 07 08 09 10            (83 处)
03 → 04 05 07 08 09               (28 处)
05 → 06 07 08 09 10               (26 处)
07 → 05 08 09 10                  ( 9 处)
02 → 03                           ( 5 处)
06 → 10                           ( 3 处)
08 → 10                           ( 1 处)
```

- **层号不是依赖方向**：`01` 和 `04` 反向依赖 `09/10`。`check_layers.py` 只能保证
  "无循环 import、746 个顶层函数无重名、23 个模块可达"，保证不了依赖方向合理。
- Rust 侧 65 条 `#[tauri::command]`（`main.rs` 独占 33 条，其余分散在 models/offline/plugins…）。
- `scripts/transcribe.py` 2718 行、约 100 个顶层函数。

## 逐模块评级

| Module | 评级 | 依据（skill 判据） |
| --- | --- | --- |
| `host/contract.js` | **深（本仓库范例）** | 纯数据、`HOST_API_VERSION` 版本化、不碰 DOM 与播放器、node 可单测；接口只有十几个导出 |
| `pipeline_config / deps / store / site / text / episode / publish` | **深** | 单一职责，彼此走接口；改动集中在各自文件 |
| Rust `media_proxy / asr / localasr / wasapi / punct / captions` | **深** | 复杂实现被少量命令包住 |
| `main.rs` + 其余命令模块 | 可接受的 adapter | IPC 本身就是 adapter 槽位；但 65 条命令平铺仍是"大接口"，可按域收 |
| `01 / 04 / 05 / 07 / 10` | **浅** | 每层 30~222 个导出、混 5~8 种无关能力；调用方必须知道"222 个名字里的哪几个" |
| `00-runtime` | 通过 deletion test，但接口危险 | 删掉它，audio/state/LIVE 会在 12 处各自重建；但当前形态是"全局可变对象"，`setState` 是唯一写入口（好），读面无约束（坏） |
| `scripts/transcribe.py` | **浅的大杂烩** | 文件状态 IO + 代理池 + 下载 + ASR + 切句 + Gemini 翻译 + VTT/feed 生成 + 回填 + CLI，八类能力一个文件 |

## 三个放错的 seam

**① 字幕真相被切成三块。** `01` 持有 `cuesFromJson / locateCue / paintWords / renderCueWindow /
scrollCue / scrollWord / scrollIntoBox`，`07` 持有 `TR / trPrimeCues / trReady / trNoteError`。
同一个能力（"给定 t，渲染并跟随"）横跨两层 ⇒ 任何跟字幕有关的改动都要动两层 + 一个测试文件。
这也是 2026-11-22 性能诊断里"改一处看不出单独收益"的结构原因：每帧路径本身就散在两层。

**② 播放真相被切成三块。** `04`（音频图 / 单流 MSE / 代理）、`05`（播放时钟 / seek / skip）、
`09`（mini 与 reader 的同步投影）。而且 `04` 反过来依赖 `09/10`。

**③ 持久化没有归属。** `05` 的 `readJSON / writeJSON` 被别层跨层取用，而 `progress / favorites /
notes / playlists / queue / prefs` 各自一套 key 与读写习惯，没有一处知道整体 schema；
跨窗同步靠 `10` 里 600ms 轮询 `pushMini() + msSync()`。

## 建议的四个深模块

原则：**小接口 + 大量行为**，adapter 只放在真的会变的地方（"一个 adapter 是假想 seam，两个才是真 seam"）。
下面的接口是契约，不是实现细节；括号里是"藏什么"。

### A. `subtitle`（建议先做）

```js
load(doc)                      // 换成纯数据：cues + words，不碰 DOM
at(t)        -> { cue, word }  // 纯函数，可表驱动测试
render(t, {mode})              // 只画当前句窗口 + 当前词
follow(t)                      // 跟随滚动（含"用户刚手动滚过"的抑制）
stop()                         // 停掉跟随，回前台由外呼 render/follow 追平
on('cue', fn)
```

藏：JSON 解析与窗口计算、词节点池、平滑滚动策略、`.decor-idle` / `--lg-glass` 降级判定。
测：`at()` 纯函数直接喂时间表；`render()` 给假 DOM，断言"只有当前词 active、旧句全 pending"。

### B. `transport`

```js
open(ep) / play() / pause() / seek(t) / rate(x)
on('tick'|'ended'|'error'|'buffer', fn)
```

藏：单流 MSE 生命周期、代理轮换、`timeScale` 与 `seekRaw` 的补偿、skip 规则、loudness/压缩器。
测：假 audio + 假 `invoke`，只断言"第 N 次 seek 后时钟与预期对齐""代理坏一个能换下一个"。

### C. `theme`

```js
apply(slug) / packs() / degrade(reason) / restore()
```

藏：自定义主题读写、内置包 seed、`--lg-glass` 数值切换、`.decor-idle` 挂类。
现状是"降级"写在三处（`05` 挂类、`01` 跳绘制、CSS 变量），改一处要动三个文件——
这正是 2026-11-22 那套性能机制需要的家。

### D. `store`

```js
get(key) / set(key, value) / list(prefix) / migrate() / subscribe(key, fn)
```

藏：localStorage 分片、JSON 容错、版本迁移、跨窗订阅（替掉 `10` 的 600ms 轮询可挂进来）。

## Python 侧的一刀

`transcribe.py` 按上面的证据至少可切出六个模块：`proxy_pool`、`download`、`asr`、
`cue_split`、`translate`、`publish`；`transcribe.py` 只留"编排 + CLI"。
这与 AGENTS.md 里"它只保留作下载/代理工具库与历史回填"的定位一致。

## 迁移方式（不重写）

1. **抽深模块 = 把现有函数搬进新文件，老层留薄转发**，一次一个模块；
2. 每个模块先写契约测试钉住旧行为（`tests/test_player.py` 已是这个角色），再删旧实现；
3. `check_layers.py` 全程守住无环无重名，`build_player_js.py` 保成品同步；
4. 顺序：**A → C → B → D**。A 先做，因为它是性能落点、测试最好写，并且能把 `01` 的 129 个导出压到个位数。

## 落地状态（2026-11-22）

**A 第一刀：已完成。** 新建 `src/player-js/12-subtitle.js`（`registerLayer('12-subtitle')`），
把 `locateCue / paintWords / scrollCue / scrollWord / scrollIntoBox / canFollow / liveFollow /
stopScroll` 的实现搬进去；`01-theme-reader-shell.js` 只留 `lazyFn('12-subtitle', ...)` 的同名转发，
`05` 的 `scrollCue / stopScroll` 调用零改动。`reduceMotion` 与 `scrollTarget` 的归属也一并移到 12。

- 实机验证（CDP 驱动，绕过失焦降级单独测这条路径）：`active` 词恒为 1 个、词索引在推进
  （`cue 89→90`、`widx 3→2`）、`scrollTop 6314→6383` 在跟随。三项全 PASS。
- **仍留在原处**：`renderCueWindow / renderCues`（画句子窗口）与 `07` 的 `TR / trPrimeCues`。
  下一刀把这两块并进 12，`01` 的导出面才能真的压到个位数。

**C 第一刀：已完成。** 新建 `src/player-js/13-theme.js`（`registerLayer('13-theme')`），
拥有 `isDegraded() / sync()` 与三个事件监听；`05-transport-transcript-nav.js` 里原来的
`syncIdleDecor()` 与其监听整段删除。消费方（`01` 的 `paint()` 读 `.decor-idle`、主题 CSS 的
`html.decor-idle` 规则）一行没动。

- 实机验证：最小化窗口后 `<html>` 挂上 `decor-idle`（PASS）；窗口失去焦点时同样挂上（PASS）。
  「回前台摘掉」在本次自动化里没能验到——脚本抢不到真实焦点（`document.hasFocus()` 一直为 false），
  属测试环境限制，不是行为回归；这一条仍需要你实机点一下确认。
- **仍留在 01**：`setTheme / applyCustomTheme / readCustomTheme / writeCustomTheme /
  renderCustomThemeGrid / bindCustomThemeEditor / seedDefaultThemePacks`（约 430 行，被
  04 / 07 / 10 通过 `lazyFn` 调用）。下一刀按 `apply(slug) / packs() / degrade()` 收口。

**C 第二刀：已完成。** 自定义主题的**数据层**搬进 `13-theme.js`：
`CUSTOM_THEME_KEY / normalizeCustomTheme / readCustomTheme / writeCustomTheme /
sanitizeCustomHtml / customPreviewColor / customThemeActiveName / newCustomPresetId`。
这样"这份配置长什么样、写进去之前怎么规范化"只有 13 一个 owner——`04`（插件设置）和
`10`（弹层）都在写它，之前 schema 住在 01 里属于错位。`13` 通过 `lazyFn` 借 `05` 的
`readJSON / writeJSON`，`01` 只留同名转发。

- 实机验证（CDP）：顶栏主题弹层里点「玻璃拟态 2.0」→ `activeId` 变 `ct-pack-glass2`、
  落盘 CSS 从 36309 字节变 14985、`--bg` 由 `#060a13` 变 `#e9eef7`；点回「液态玻璃」→
  CSS 复原 36309、`--bg` 回到 `#060a13`；`window.onerror` 零条。三项 PASS。
- 踩到的坑：`normalizeCustomTheme` 在 01 里还有一处内部调用（`saveCustomThemePreset`），
  漏了转发就会在点卡片时抛 `ReferenceError`；另外 Tauri 的 `site/` 是**编译期**打进 exe 的，
  只重建 `site/player.js` 而不 `cargo build`，跑的还是旧 JS——这个假 RED 值得记。

**C 第三刀：已完成。** 主题的**应用与渲染**也搬进 13：`setTheme / applyCustomTheme /
applyCustomThemePreset / renderCustomThemeGrid / syncCustomThemeEditor / bindCustomThemeEditor /
seedDefaultThemePacks / importCustomTheme / saveCustomThemePreset / themeBtns`，连常量
`LIGHT_THEMES / REMOVED_THEME_FALLBACK / DEFAULT_PACKS_KEY / lastDark / lastLight` 与
`01` 求值期的那串副作用（`.swatch` 点击、`#themePop [data-pack]` 点击、`themeTopBtn`、
`themeBtn.onclick`、初始主题恢复与老主题迁移、`myt-ui-ledger` 打标、`queueMicrotask(bootCustomTheme)`、
`bindCustomThemeEditor()`）一起过去。`01` 只剩同名 `lazyFn` 转发，04 / 07 / 08 / 10 的调用点零改动。
导出字幕 / 分享当前句（`exportSubBtn`、`shareCueBtn`）和 overlay 焦点辅助留在 01。

- 实机验证（CDP，逐路径）：启动即 `dataset.scheme=dark` 且 `--bg=#060a13`（初始恢复走了 13）；
  点「纸张」`scheme=light`、`--bg=#f6f1e7`；点 themeBtn 翻回深色 `scheme=dark`；设置页网格 7 张卡
  + 「存为自定义主题」入口；编辑器写入 `--probe:#123456` 后点「保存并应用」，变量真的注进
  `body`；再点「液态玻璃」卡复原。`window.onerror` 零条。
- 踩到的坑：机械切块把 `exportSubBtn / shareCueBtn` 两个 handler 和三个 overlay 辅助函数
  （`rememberOverlayTrigger / restoreOverlayFocus / setDrawerBackgroundInert`）一起卷走了，
  结果 13 顶层抛 `ReferenceError`、`registerLayer` 没跑，启动时 `dataset.scheme` 为空——
  症状是"主题能点但初始态不对"。切块务必按语义边界，不按行号边界。
- 附带验证：前一轮手工测试把液态玻璃卡的 CSS 改坏了，重启时 `seedDefaultThemePacks` 用
  `site/themes-defaults.js` 自动把内置卡刷回 36309 字节——这条"随包主题自愈"路径顺带过了。

**B 第一刀：已完成。** 新建 `src/player-js/14-transport.js`，播放有了单一入口：
`play() / pause() / toggle() / rate() / now() / on()`。它只认 `00-runtime` 的 `audio` 单例，
前置校验（有当前集、有 src）与失败提示都在这里，倍速钳制 0.5–3 只在这里发生。

搬进来的调用点：
- 插件接口 `player.play/pause/toggle/setRate`（04）——以前三处各写一遍
  `audio.play().catch(()=>{})`，插件侧失败静默、UI 侧有 toast，行为不一致；
- 系统媒体键 / 托盘 / 迷你窗 / 睡眠定时（10）：`play`、`pause`、`stop`、`toggle`、
  `playpause`、节目默认速度；
- 底栏播放键与倍速（05）：`$('play').onclick` → `transportToggle()`，
  `applyRate()` 里的 `audio.playbackRate` → `transportRate()`。

- 实机验证（CDP）：点继续收听卡开播（`paused=false`、`t≈3.1s`、`body.playing`）；
  点底栏播放键暂停（`paused=true`）；再点恢复（`t` 继续推进）；点倍速键
  `1× → 1.5×`，`prefs.speed` 与 `dockRateLabel` 同步；`window.onerror` 零条。
- **仍直连 `audio` 的地方**（有意留下，下一刀再收）：05 的 `seekChapter()` / `playOffline()`
  自己设 `src` 后起播（此刻 `state.current` 未必就绪，走 14 会被前置校验挡掉）；
  02（实时字幕接管前后 `audio.pause()/play()` 与 `playbackRate` 复原）、03（换集重接管）
  属于各自流程的"恢复播放"，不是用户意图入口。等 14 长出 `attach/restore` 再搬。

**D 第一刀：已完成。** 新建 `src/player-js/15-store.js`，localStorage 的 JSON 读写有了唯一入口：
`readJSON / writeJSON / removeKey / listKeys / migrateKey`。`readJSON` 坏数据回退不抛，
`writeJSON` 配额满时静默返回 `false`（用户不该看到 toast），`listKeys` 是动态键族
（`myt-ep-<id>` / `myt-rail-<slug>`）的唯一遍历口，`migrateKey` 给老键迁移用。

- 05 的 `readJSON / writeJSON` 实现搬进 15，05 只留同名转发（顶部声明，避免 TDZ），
  01 / 04 / 10 的 `lazyFn('05', 'readJSON')` 零改动；13 直接改指向 15（主题不该为了存一个键去借 05）。
- **故意没做 `subscribe`**：目前没有任何跨层"写完要通知"的真实场景，先造一个没人挂的
  适配器就是假 seam；等第二个真实订阅方出现再加。
- 实机验证（CDP）：启动读到 71 个键、主题卡 `activeId=ct-pack-liquid-glass` / CSS 36309 /
  `--bg=#060a13`、订阅 2 条、进度 11 条；播放 3s 后暂停，进度条目 `at` 时间戳刷新
  （写入真的过 15 落盘）；`window.onerror` 零条。
- **仍直连 `localStorage` 的地方**（下一刀）：单值键 `myt-scroll / myt-mode / myt-theme /
  myt-theme-dark / myt-theme-light / myt-ui-ledger / myt-reader / myt-showprefs / myt-sleep`
  这类 `getItem` 直接取字符串的调用共 60 余处，散在 01 / 04 / 05 / 07 / 08 / 09 / 10。
  它们不是 JSON，15 的 `readJSON` 不覆盖；要么给 15 加 `readText / writeText`，要么
  逐族收口（先主题族、再 reader 族）。

**契约测试**：`tests/test_player.py` 的 `PlayerSeamTests` 钉住"谁拥有这段行为"
（定义位置、转发形式、入口 import、构建产物存在），新增五条：字幕内核适配只在 12、
自定义主题 schema 只在 13、主题应用路径（含 `queueMicrotask(bootCustomTheme)`）只在 13、
播放/暂停/倍速只在 14、localStorage 的 JSON 读写只在 15。
`tests/test_custom_themes.py` 改用 `shell_and_theme()` 合并取样。当前 **87 项全绿**。


## 反例（不要这么做）

- 不要为了"分层好看"给每层加一层转发函数——那会把浅接口变成"更薄的浅接口"，deletion test 立刻失败。
- 不要给 `subtitle` 同时开三套 adapter（VTT / 词级 JSON / 实时 ASR）再抽象——实时那条真的有差异才算真 seam；
  在确认"两种以上真实变体"之前，保持一个实现。
