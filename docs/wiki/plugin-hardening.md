# 插件体系加固（2026-11-20）

来自外部审视的五条优先项，按“先能锁住行为，再扩生态”的顺序推进。

## 进度

| # | 事项 | 状态 |
| --- | --- | --- |
| 1 | 依赖环 + 插件宿主最小测试 | 已完成 |
| 2 | 收紧公开 API（白名单 host、只读 cues、版本协商） | 已完成 |
| 3 | 卸载/软重载生命周期（setup 返回 dispose、资源记账） | 已完成（Rust 侧升级策略未动） |
| 4 | 信任模型（首次启用授权 + 撤销） | 已落地；签名 / CSP 未做 |
| 5 | 可替换插件接缝（ASR 引擎 PoC） | 已完成：native / sherpa / moonshine 三个适配器 |
| 6 | Rust 拆分（插件目录成模块） | 已完成；`main.rs` 约 2 520 行 |

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
- `start()` 失败会回滚 `__started`，不会留下半注册状态。

## 4. 信任模型（已落地：首次启用弹授权）

选型：只装可信代码 + 首次启用第三方插件弹页内授权，签名清单留作后续。

- Rust `plugin_list` 返回 `builtin` 字段，`subtitles` / `study` 自动放行；
- 第三方插件未记录授权时，注入脚本前弹层：列出“读页面内容 / 发网络请求 / 调桌面能力”，
  背景点按等同拒绝；选择写入 `localStorage` 的 `myt-plugin-consent:<id>`（allow / deny）；
- 设置页插件行显示授权状态，并给「撤销授权」，撤销后下次加载重新询问；
- `tauri.conf.json` 的 `"csp": null` 仍未动，弹层是产品级门禁，不替代 CSP / 签名。

## 5. 可替换接缝：识别引擎

`src/player-js/02-live-caption-wasm.js` 里 `TRANSCRIBER_ADAPTERS` + `registerTranscriber(kind, {load})`，
引擎只暴露 `load() → engine`，engine 形状由 `liveStartStream` 约定（addAudio / transcribe / stop / close）。

- 三个适配器全覆盖：`native`（Rust 侧 sherpa）、`sherpa`（WASM 流式 zipformer）、
  `moonshine`（WASM 备用，词时间靠均分）；
- `liveLoadEngine()` 只剩查表 + 未知引擎报错，原来内联的 Moonshine 加载逻辑整段搬进
  `liveMoonshineLoad()`；
- 选引擎仍走 `?engine=moonshine|wasm`，没有壳时默认 sherpa。

## 6. Rust 拆分：插件目录独立成模块

- `apps/windows/src-tauri/src/plugins.rs`：插件目录、`enabled.json`、清单扫描、内置插件铺设、
  示例插件生成、`plugin_list / plugin_set_enabled / plugin_open_dir / plugin_example` 四个命令；
- `main.rs` 只保留 `mod plugins;`、`plugins::…` 调用与 `AppState`（`captions` 字段放开给同 crate）；
- 行数从 2 888 降到约 2 520，插件相关逻辑不再和下载、模型、字幕窗口混在一起。

## 7. 测试

- `tests/test_plugin_host.py` 现在两组：依赖/能力规则 + 授权三态（未授权 → allow → deny → 撤销）；
- 清单校验、重复 id、脚本加载失败、生命周期回滚仍缺 Rust 侧测试（`plugin_list` 需要
  可注入目录的纯函数才好测，留作下一步）。

