# MyTranscript 桌面壳（Windows / Tauri 2）

网页版实时字幕有两个浏览器级限制：跨域音频源读不到字节（`Access-Control-Allow-Origin` 缺失就彻底
没戏），识别只能跑在 WebView 的 JS 线程里。这个壳用 Tauri 2（系统 WebView2，不打包 Chromium）
把这两件事都绕开：

- **取字节交给 Rust**：`read_range` 用 reqwest 带 `Range` 头请求，不受 CORS 约束，所以网页版
  降级的那些节目在这里能正常做实时字幕。
- **识别交给原生库**：直接手写 FFI 调 `sherpa-onnx-c-api`（不依赖 WASM、不需要 COOP/COEP、
  可用多线程），PCM 从 WebView 传给 Rust 推理，CPU 比 WASM 版低。

网页版行为不变：壳只是把 `site/player.html` 里的宿主桥（`LIVE_HOST`）从“浏览器 XHR”换成
“Tauri invoke”，页面代码本身是同一份。

## 目录

```
apps/windows/
  fetch-deps.ps1            下载 sherpa-onnx 的 DLL（13 MB，不入库）
  src-tauri/
    build.rs                链接 vendor/sherpa/lib + 把 DLL 拷到 target/{debug,release}
    src/main.rs             命令层：read_range / asr_prepare / asr_open / asr_feed / asr_result / asr_reset / asr_close
    src/asr.rs              手写 #[repr(C)] FFI 的流式识别器
    tauri.conf.json         窗口、frontendDist=../../../site、bundle.resources
    capabilities/default.json
    vendor/sherpa/lib/      sherpa-onnx-c-api.dll/.lib、onnxruntime.dll、onnxruntime_providers_shared.dll
```

## 构建

依赖：Rust 工具链 + **VS2022 的 MSVC**（`link.exe` 不必在 PATH）+ WebView2 运行时。
第一次先抓 DLL：

```powershell
pwsh -File apps/windows/fetch-deps.ps1
```

**target 目录一定要放 C 盘**。放 D 盘时 `thiserror`/`proc-macro2` 的 build script 会报
`Failed to clean up ...out\probe: 目录不是空的 (os error 145)`，`cargo clean` 也好不了：

```powershell
cd apps/windows/src-tauri
$env:CARGO_TARGET_DIR = "C:\Users\<you>\AppData\Local\Temp\myt-tauri-target"
cargo build            # 首次约 1m20s，增量约 9s
```

产物在 `%CARGO_TARGET_DIR%\debug\mytranscript-desktop.exe`（debug 约 23 MB），同目录已被
`build.rs` 拷好 3 个 DLL，直接双击或 `Start-Process` 就能跑。

打包（可选，需要 NSIS，未签名会有 SmartScreen 提示）：

```powershell
cargo build --release
```

## 模型

首次开实时识别时 `asr_prepare` 自动下载到 **`%ProgramData%\MyTranscript\sherpa-en-20M`**
（约 41 MB，HF 直连会超时，代码里带 `hf-mirror.com` 兜底）。

目录必须是纯 ASCII：sherpa 内部用 `std::ifstream` 判文件存在，路径里有中文（例如用户名「游梦」）
会报 `tokens.txt does not exist`，识别器直接创建失败。旧版下在 `app_data` 里的模型会被自动搬过来。

## 页面侧的接口

`site/player.html` 里 `LIVE_HOST` 检测到 `window.__TAURI__.core` 时把引擎切成 `native`：

| 宿主方法 | 对应命令 | 说明 |
| --- | --- | --- |
| `fetchRange(url, from, to)` | `read_range` | 返回 `Uint8Array`，`to` 省略时默认 from+1MB |
| `asrPrepare()` | `asr_prepare` | 返回模型目录（缺哪个下哪个） |
| `asrOpen(dir, threads)` | `asr_open` | 建流式识别器，线程数 = `clamp(2, 4, cores-1)` |
| `asrFeed(id, pcm, rate)` | `asr_feed` | f32 PCM，单声道 16 kHz |
| `asrResult(id)` | `asr_result` | 返回结果 JSON 字符串（含 token/timestamp） |
| `asrReset(id)` / `asrClose(id)` | `asr_reset` / `asr_close` | 攒够 200 词重置一次；关掉时释放 |

`?live=1` 是联调用开关：开局自动 `liveEnable()` + `audio.play()`，省掉手点。

## 窗口是沉浸式的（没有系统标题栏）

`tauri.conf.json` 里 `"decorations": false`，窗口边框和白色标题栏全部交给页面自己画：
`site/player.html` 的 `shellFrame()`（检测到 `window.__TAURI__` 才执行）把顶栏、面包屑、侧栏品牌
标成 `data-tauri-drag-region` 当拖拽区，并在右上角补一组最小化/最大化/关闭按钮；播放页是全屏
阅读器，顶部浮层 `pointer-events:none` 拖不动，所以另铺一条 38px 的透明拖拽带。

两个必须知道的点：

- Tauri 的拖拽只认 **mousedown 落点自身**带 `data-tauri-drag-region` 的元素，属性在父容器上不生效；
  所以 `shellFrame()` 会把容器内的文本叶子一起标上，按钮/输入框不标（否则点不动）。
- 这些操作要靠 capabilities 授权：`core:window:allow-start-dragging`（拖拽）、
  `core:window:allow-internal-toggle-maximize`（双击标题栏最大化）、`allow-minimize`、
  `allow-toggle-maximize`、`allow-is-maximized`、`allow-hide`（收进托盘）、`allow-close`。
  迷你窗共享同一份权限，所以 capabilities 的 `windows` 写成 `["main", "mini"]`。

## 托盘、迷你窗与系统媒体键

壳层三件套，都是网页版没有的能力：

- **托盘常驻**（`build_tray`）：左键点图标 = 显示/隐藏主窗，右键菜单 = 显示/隐藏、播放/暂停、
  上一集、下一集、迷你窗、退出。菜单里的播放控制不存状态，只 `emit_to("main", "myt://tray", …)`
  交给前端执行，播放状态仍然只有 `audio` 一份。
- **✕ 仍是退出，－ 改成「收进托盘」**：`win.hide()`，音频留在主窗继续播（主窗和迷你窗都设了
  `backgroundThrottling: "disabled"`，否则窗口一隐藏 JS 定时器就被节流，实时识别和进度上报会停）。
- **独立迷你窗**（`open_mini` / `close_mini` + `site/mini.html`）：置顶、无边框、不占任务栏，
  344×132。它**不加载音频**——按钮把 `myt://mini-cmd` emit 给主窗，主窗每 800ms 把
  `myt://mini-state`（标题/封面/进度/播放态/能否切集）推回来，避免两个 WebView 各播一遍。
- **系统媒体键走 MediaSession**（`player.html` 的 `desktopBridge()`）：Windows 媒体浮层、键盘
  媒体键、耳机键都能播/停/跳。若实测按键不响应（WebView2 该版本不支持），下一步换 Rust 侧 SMTC。

## 已知坑

| 现象 | 原因 / 处理 |
| --- | --- |
| `Failed to clean up ... os error 145` | target 目录在 D 盘，换 `CARGO_TARGET_DIR` 到 C 盘 |
| `tokens.txt does not exist` 但文件明明在 | 模型路径含非 ASCII，改到 `%ProgramData%` |
| 报「这个音频不是 MP3」 | 有的节目把 3000×3000 封面塞进 ID3（约 1.4 MB），128 KB 探针到不了第一帧。`liveProbeAudio` 已按 128 KB→2 MB→8 MB 递进取窗口 |
| 窗口位置/点不到按钮 | `tauri.conf.json` 里窗口坐标固定为 x=60,y=40，改布局后要重新算点击位置 |
| 改了 `site/` 但壳里没变 | `frontendDist` 是编译期内嵌的，必须重新 `cargo build` |
| `Failed to setup app: WebView2 error 0x800700AA 请求的资源在使用中` / `os error 5` | exe 所在目录被标成了**低完整性级别**（`icacls` 里能看到 `Mandatory Label\Low Mandatory Level:(NW)`，比如本仓库的 `D:\MyTranscript` 就被沙箱写成了 Low IL）。从 Low IL 文件启动的进程也是 Low IL，WebView2 拒绝在该完整性级别下建环境。把它解压到桌面/下载目录（普通 Medium 目录）再运行就正常；`icacls <目录> /setintegritylevel "(OI)(CI)M" /T` 也能改，但要在提权窗口里做 |

## 当前状态

- speaking-of-psychology 集：原生命中识别跑通，逐词高亮跟随正常。
- 99% Invisible（CORS 受限、ID3 大封面）：壳里取字节成功、探针自适应后识别跑通（实测 38 句）。
- Android 端未动工（计划是原生 Kotlin + WebView，推理仍走同一套 C API 的 JNI 包）。

## CI 打包（.github/workflows/app-build.yml）

两条入口：

- **手动 run**（Actions → Build Windows App）：只产出 Actions 产物，不建 Release。
- **推 pp-v* 标签**：自动发 Release，附件同样是安装包 + 便携 zip（标签得人推，workflow 不建 tag）。

流程固定为：etch-deps.ps1 抓 sherpa DLL → 重建 player.js/主题包/骨架 → 41 个 Python 测试 +
cargo test → 
px @tauri-apps/cli build（NSIS）→ 打 MyTranscript-portable.zip（exe + 3 个 DLL）。

本地等价验证（2026-11-24 实跑）：release 编译 4m24s，产出
undle/nsis/MyTranscript_0.1.0_x64-setup.exe（10.8 MB）、便携 zip 13.3 MB。
安装包未签名，首次运行仍会弹 SmartScreen。
