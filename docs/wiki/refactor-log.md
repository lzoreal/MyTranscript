# 重构日志

按时间记录，只写发生了什么、依据是什么、怎么验证。代码细节随提交变化，不在这里复述。

## 2026-11-20

1. **L0 外置**（未提交）：`site/player.html` 813 KB / 14 998 行 → 69 KB / 715 行；样式抽到 `site/player.css`，
   脚本抽到 `site/player.js`；`tests/test_player.py` 的 `player_page()` 改为把外链内容内联回文档再断言，
   42 处直接读 `player.html` 的断言统一走这个入口。28 个测试文件全绿，桌面壳实测通过。
2. **L0.5 分片**（未提交）：6 个分片细化为 11 个（新增 `00-kernel`），拼接后 `site/player.js` 与拆分前
   逐字节一致（SHA256 `66819ADE…A6E10`）；新增 `scripts/build_player_js.py` 与
   `tests/test_player_build.py` 守护同步。
3. **L2 batch 1**（未提交）：`fmt`、`isBracket`、`esc`、`loaderHTML` 搬进 `MYTK`；调用点零改动；
   用户在主屏实测首页与播放页正常（字幕时间码、双语切换、播放暂停均通过）。
4. **L2 batch 2–3**（未提交）：`findNorm`、`epKey`、`studyRegexEscape`、`studyNormText` 搬进 `MYTK`，
   `tests/` 28 个文件全绿。
   - 事故：按"块+1 行"删除时，两处没有空行，误删了 `studyTermChipHTML` 与 `studyStartExercise`
     的函数头，`node --check` 立刻报错；已补回两行并复测通过。教训见 [risks.md](risks.md)。
5. **L2 batch 4**（未提交）：`emptyLine`、`statHTML` 搬进 `MYTK`（kernel 共 10 个函数）。
   `showCategories` 一度被搬走，导致 `test_catalog_filter_search_sort_and_status` 的 `__SLICE__`
   区间里缺少定义（`ReferenceError: showCategories is not defined`），已退回原分片并调整位置到
   `CATEGORY_LABELS` 之后、`transcriptCoverage` 之前，复测通过。桌面壳重建后实测首页、发现页、
   播放页正常（发现页 14/14 节目与分类标签渲染正确）。

6. **L2 batch 5 + 层边界自检**（未提交）：`pluginPageKey`、`isJsonTranscript` 搬进 `MYTK`（kernel 共 12 个），
   新增 `scripts/check_layers.py` 与 `tests/test_layers.py`：校验 kernel 纯度（无 `state`/`app`/`document`/
   `fetch(` 等）、跨分片无重名顶层函数、`window.__TAURI__` 只出现在一处。
   - **发现真 bug**：`fetchJson` 在 `01` 与 `06` 各有一份，签名不同（`(url, timeoutMs)` vs
     `(url, options, timeoutMs)`）。同一 IIFE 内函数提升后**后者覆盖前者**，`getJson()` 传的超时一直被换成默认
     7000 ms，属拆分前就存在的隐性缺陷。已把 `01` 的那份改名 `fetchJsonTimed`，调用点两处同步，语义恢复为
     按调用方超时（12 s）。
   - **L3 第一步**：所有 `window.__TAURI__` 读取收敛到 `tauriHost()`（定义在 `02`），8 个分片共 30+ 处
     改成 `tauriHost()`；`check_layers.py` 锁定该符号只允许出现一次。
7. **实测**（2026-11-20，桌面壳重建 15.2 s）：首页恢复进度 10:55、播放页字幕按时码滚动并播放（12:45 继续）、
   发现页 14/14 节目与封面渲染、返回首页后迷你播放条继续走。`tests/` 29 个文件全绿。

8. **L3 完成**（未提交）：新增 `host()` 作为唯一宿主句柄，8 个分片共 94 处 `LIVE_HOST` 引用改为
   `host()`；加上此前的 `tauriHost()`，平台检测与宿主能力各自只剩一个入口，其余分片不再出现
   `window.__TAURI__` / `LIVE_HOST` 字面量。
9. **L4 完成**（未提交）：新增 `setState(key, value)`，把 175 处 `state.x = …`（含同行多赋值）改走 setter，
   0 处残留；`state` 只读、`renderPage(page, route)` 仍是唯一路由派发入口。迁移时发现 `01` 里有一个
   局部 `const state = $('ctState')` 遮蔽了全局 state，已改名 `ctState`，否则会写错对象。
10. **验证**：`tests/` 29 个文件全绿（`test_player.py` 的 4 条文本断言同步改成 setState 形式）；
   `check_layers.py` 新增三条硬规则（kernel 纯度 / 函数唯一 / 平台入口唯一 / 状态只经 setState）；
   桌面壳 12.3 s 重建后实测：首页进度 22:10 恢复、播放页字幕滚动与播放正常、发现页 14/14、
   返回首页迷你播放条继续走。
11. **L1 补齐完成**（未提交）：11 个分片首行统一加 `/* layer: … */`（kernel / view / bridge），`scripts/player_js_deps.py` 重新生成 `docs/player-js-dependency-map.md`：11 分片 / 768 顶层声明 / 375 跨片引用；spec 状态改为 L0–L4 全部完成。
12. **模块图替换拼接**（未提交）：`player.js` 成为显式入口，`00-runtime` / `00-layers` 收敛单例与运行时就绪注册表，01–10 改成带 import/export 的独立模块；`site/player.js` 只剩一行 import，`site/player-kernel.js` 删除，`build_player_js.py` 改为逐文件复制。实测启动无 boot error、23 集可开、单集起播、907 段 / 9,555 个词级时间点正常。
13. **宿主 v2 贡献点落地**（未提交）：`data-plugin-slot` 锚点覆盖全部 11 个固定槽位，`applySlotMounts` 在渲染后装配，`applySettingsPanes` 按设置分区渲染；新增 `releaseSurfaces` / `pruneDetachedSurfaces`，停用、启动失败、软重载与页面重绘都能回收。`tests/host-contract.test.mjs` 增加挂载顺序、payload、异常隔离、停用回收与 API 快照断言；`tests/test_plugin_host.py` 锁定锚点表与固定槽位表一一对应。
    - 冒烟（2026-11-20，本地 8808 + 无插件）：console 无 error，首页 4 张卡片，9 个锚点全部 `slotReady=1`，设置页可切到插件分区且空分区不占位，单集页 2 个动态锚点挂载成功。
    - 过程事故：`applySettingsPanes` 的 `attachSurface(...)` 少一层括号，浏览器报 `Unexpected identifier 'count'`、整页不启动；`node --check` 被 PowerShell 的 `*> $null` 吞掉退出码没发现，改成逐文件显式检查后修好。教训：语法检查不能靠管道吞错误。
14. **2.2：窄上下文 / 取消 / UI 适配独立**（未提交）：`HOST_API_VERSION` 升到 `2.2`；
    `host/contract.js` 增加 `CONTEXT_PROFILES` / `SCOPED_API_FIELDS` / `PAYLOAD_VERSIONS`，
    `host/context.js` 按贡献类型装配 `ctx` 并投影 `api`；`2.1` 清单继续走完整档案。
    `host/faults.js` 的 `runPluginTask` 接 `signal`，`host/requests.js` 每次 `begin()` 换 `AbortController`；
    `04` 用 `PLUGIN_ABORTS` 记账，停用/启动失败/页面销毁/槽位卸载/新搜索都会 abort。
    菜单、导入器、搜索源、主题的 DOM 搬到 `host/ui-adapters.js`，`04` 只留实例与 port。
    新增 `scripts/check_plugin_manifest.mjs`、`examples/plugins/search-echo/`、`tests/host-context.test.mjs`、
    `tests/host-aborts.test.mjs`；测试宿主升级为同时模拟 `ctx` 与取消。
    - 验证：39 个 `tests/test_*.py` 全绿；`check_layers.py` 14 分片 868 声明 / 413 跨片引用；
      `build_player_js.py --check` 一致。真机点击验收仍待做。

