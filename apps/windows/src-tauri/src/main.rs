#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod asr;
mod captions;
mod localasr;
mod media;
mod media_proxy;
mod models;
mod offline;
mod plugins;
mod punct;
mod translate;
mod video_asr;
mod wasapi;

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

pub(crate) struct AppState {
    engines: Mutex<HashMap<u32, asr::Asr>>,
    next_id: Mutex<u32>,
    /// 正在下载的模型 id；页面点「取消」时塞进来，下载循环每个分块检查一次。
    asr_cancel: Mutex<HashSet<String>>,
    /// 全局字幕会话；None 表示没在听。
    pub(crate) captions: Mutex<Option<captions::Session>>,
    /// 字幕窗是否可拖动（false = 鼠标穿透）。
    captions_drag: Mutex<bool>,
    /// 字幕条背景不透明度（0.3–1.0）。
    captions_alpha: Mutex<f64>,
    /// 查词模式：字幕条接收鼠标点击，单词可点。
    captions_lookup: Mutex<bool>,
    /// 中文字幕：英文句子稳定后加一行译文。
    captions_zh: Mutex<bool>,
    /// 成句模式：只显示已断句的整句，避免半句逐字蹦。
    captions_commit: Mutex<bool>,
    /// 最近一次查词结果，词卡窗口起来后自取。
    word_last: Mutex<Option<serde_json::Value>>,
}

use crate::models::{model_dir_for, models_root};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, State};

pub(crate) fn dbg_log(line: &str) {
    if std::env::var("MYT_DEBUG").is_err() {
        return;
    }
    use std::io::Write;
    if let Ok(dir) = std::env::var("TEMP") {
        let path = std::path::Path::new(&dir).join("myt-mini.log");
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{line}");
        }
    }
}

/// 识别模型清单。文件只内置「下载地址 + 规范化文件名」，
/// 模型本体不放仓库、不上我们的服务器（体积大、也没必要）。
fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// 整集下载用的客户端。90 秒总额是给小文件（章节 JSON、词典）的预算，
/// 几十 MB 的音频在慢网下会下载到一半就被这个总额度掐断。
fn http_long() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(1800))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// 取远端字节（Range 可选）。走主进程，所以没有浏览器的 CORS 限制——
/// 这正是播放页在壳里能读 stitcher/simplecast 那些不给 CORS 头的音频的原因。
#[tauri::command]
async fn read_range(
    url: String,
    from: Option<u64>,
    to: Option<u64>,
) -> Result<tauri::ipc::Response, String> {
    let mut req = http().get(&url);
    if let Some(from) = from {
        let to = to.unwrap_or(from.saturating_add(1 << 20));
        req = req.header("Range", format!("bytes={from}-{to}"));
    }
    let res = req.send().await.map_err(|e| format!("请求失败：{e}"))?;
    if !res.status().is_success() {
        return Err(format!("音频源返回 HTTP {}", res.status()));
    }
    let bytes = res.bytes().await.map_err(|e| format!("读取响应失败：{e}"))?;
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}

/// 取远端文本（章节 JSON、词典释义这类小文件）。同样走主进程，绕开浏览器 CORS。
#[tauri::command]
async fn http_text(url: String) -> Result<String, String> {
    let res = http()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;
    if !res.status().is_success() {
        return Err(format!("远端返回 HTTP {}", res.status()));
    }
    res.text().await.map_err(|e| format!("读取响应失败：{e}"))
}

/// 迷你窗页面自己报一句“我起来了”，用来分清「没加载」还是「加载了没渲染」。
#[tauri::command]
fn dbg_note(msg: String) {
    dbg_log(&format!("boot {msg}"));
}

/// 本地音频整集预转写：立即返回，进度走 `myt://localasr` 事件。
/// `model` 为空时用实时字幕的默认模型；指定了就用指定模型（设置页里选的那档）。
#[tauri::command]
fn local_transcribe_start(
    app: tauri::AppHandle,
    path: String,
    model: Option<String>,
) -> Result<(), String> {
    let id = model.unwrap_or_else(|| "en-mini".to_string());
    let dir = model_dir_for(&id)?;
    if !dir.join("tokens.txt").exists() {
        return Err(format!("模型「{id}」还没下载，请先在设置 → 模型管理里下载。"));
    }
    localasr::start(app, path, dir.to_string_lossy().to_string())
}

#[tauri::command]
fn local_transcribe_status() -> serde_json::Value {
    localasr::status()
}

/// 单句精听：同步等结果，前端那一下会转圈几秒。
#[tauri::command]
async fn local_clip_transcribe(
    path: String,
    start_ms: i64,
    end_ms: i64,
    model: Option<String>,
) -> Result<serde_json::Value, String> {
    let id = model.unwrap_or_else(|| "en-mini".to_string());
    let dir = model_dir_for(&id)?;
    if !dir.join("tokens.txt").exists() {
        return Err(format!("模型「{id}」还没下载，请先在设置 → 模型管理里下载。"));
    }
    let dir = dir.to_string_lossy().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        localasr::transcribe_clip(
            &path,
            start_ms as f64 / 1000.0,
            end_ms as f64 / 1000.0,
            &dir,
        )
    })
    .await
    .map_err(|e| format!("精听失败：{e}"))?
}

#[tauri::command]
fn local_transcribe_stop() {
    localasr::stop();
}

#[tauri::command]
fn local_transcript_load(path: String) -> Result<String, String> {
    localasr::load(&path)
}

/// 托盘左键：可见且在前台就收起，否则亮出来并聚焦。
fn toggle_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let visible = w.is_visible().unwrap_or(false);
        let focused = w.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

/// 迷你窗：独立置顶小窗，常驻在桌面角落；主窗收进托盘时它还在，音频照走。
/// 它自己不播音频，只把按钮 emit 给主窗，主窗再把状态 emit 回来——
/// 音频实例只允许有一个（两个 WebView 各播一遍就成双声道了）。
/// 注意：Windows 上 `build()` 在同步命令或事件回调（都跑在主线程）里会死锁，
/// 所以这里只留一份「真正的实现」，对外一律从异步命令或独立线程调用。
fn open_mini_from(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("mini") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(app, "mini", tauri::WebviewUrl::App("mini.html".into()))
        .title("MyTranscript")
        .inner_size(344.0, 132.0)
        .decorations(false)
        .always_on_top(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .shadow(true)
        // 先不显示，等页面画出来再亮，避免闪一块白板；底色也先铺成深色。
        .visible(false)
        .background_color(tauri::utils::config::Color(22, 24, 29, 255))
        .on_page_load(|_webview, payload| {
            dbg_log(&format!(
                "mini page_load {:?} {}",
                payload.event(),
                payload.url()
            ));
        })
        // 主窗收进托盘后 JS 定时器不能被节流，否则实时识别和进度上报会停摆。
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .build()
        .map_err(|e| format!("迷你窗打开失败：{e}"))?;
    if let Some(w) = app.get_webview_window("mini") {
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(600));
            let _ = w.show();
        });
    }
    Ok(())
}

/// 前端调用：从 WebView 点 ⧉ 走这里。必须是 async 命令，否则在 Windows 上建窗会卡死主线程。
#[tauri::command]
async fn open_mini(app: tauri::AppHandle) -> Result<(), String> {
    open_mini_from(&app)
}

#[tauri::command]
async fn close_mini(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("mini") {
        let _ = w.close();
    }
}

/// 迷你窗按字幕区有无调整高度：宽度保持调用前的逻辑宽度，只改高度。
#[tauri::command]
async fn mini_fit(window: tauri::WebviewWindow, height: f64) -> Result<(), String> {
    let h = height.clamp(120.0, 360.0);
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let w = (size.width as f64 / scale).round().max(200.0);
    window
        .set_size(tauri::LogicalSize::new(w, h))
        .map_err(|e| e.to_string())
}

/// 全局字幕窗：透明、置顶、不占任务栏、默认点击穿透。
/// 和迷你窗一样，Windows 上必须在非主线程建窗，否则会死锁。
fn open_captions_from(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("captions") {
        let _ = w.show();
        return Ok(());
    }
    let state = app.state::<AppState>();
    let drag = *state.captions_drag.lock().unwrap_or_else(|e| e.into_inner());
    let alpha = *state.captions_alpha.lock().unwrap_or_else(|e| e.into_inner());
    let lookup = *state
        .captions_lookup
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let zh = *state.captions_zh.lock().unwrap_or_else(|e| e.into_inner());
    let commit = *state
        .captions_commit
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let url = format!(
        "overlay.html?drag={}&alpha={:.2}&lookup={}&zh={}&commit={}&v={}",
        if drag { 1 } else { 0 },
        alpha,
        if lookup { 1 } else { 0 },
        if zh { 1 } else { 0 },
        if commit { 1 } else { 0 },
        stamp
    );
    let w = tauri::WebviewWindowBuilder::new(
        app,
        "captions",
        tauri::WebviewUrl::App(url.into()),
    )
    .title("MyTranscript Captions")
    .inner_size(900.0, 132.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .resizable(true)
    .maximizable(false)
    .minimizable(false)
    .skip_taskbar(true)
    .shadow(false)
    .visible(false)
    .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
    .build()
    .map_err(|e| format!("字幕窗打开失败：{e}"))?;

    // 高 DPI 下 builder 的 inner_size 会被 WebView 按 1.5 倍渲染又按 1 倍裁切，
    // 这里直接把窗口锁成物理像素，保证 CSS 视口和窗口同尺寸。
    let win_w = 900i32;
    let win_h = 132i32;
    let _ = w.set_size(tauri::PhysicalSize::new(win_w as u32, win_h as u32));

    // 屏幕底部居中，离任务栏留一点距离。用真实外框尺寸，避免 DPI 缩放后算偏。
    if let Ok(Some(mon)) = w.current_monitor() {
        let size = mon.size();
        let pos = mon.position();
        let scale = w.scale_factor().unwrap_or(1.0);
        let phys = w
            .outer_size()
            .unwrap_or(tauri::PhysicalSize::new(win_w as u32, win_h as u32));
        let x = pos.x + (size.width as i32 - phys.width as i32) / 2;
        let y = pos.y + size.height as i32 - phys.height as i32 - (90.0 * scale) as i32;
        let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
    }
    // 默认不挡鼠标；拖动或查词态才接收点击。
    let _ = w.set_ignore_cursor_events(!(drag || lookup));
    let _ = w.show();
    Ok(())
}

fn captions_model_dir() -> Result<String, String> {
    let dir = models_root()?.join("en-mini");
    if !dir.join("tokens.txt").exists() {
        return Err("还没有英文识别模型：设置 → 语音识别 → 下载「英文 · 迷你」".into());
    }
    Ok(dir.to_string_lossy().to_string())
}

/// 开/关全局字幕。**只能在非主线程调用**（托盘回调、热键线程、async 命令）。
/// 选择应用的小窗：列出正在出声的进程，点哪个就只抓哪个。
fn open_picker_from(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("picker") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    tauri::WebviewWindowBuilder::new(
        app,
        "picker",
        tauri::WebviewUrl::App(format!("picker.html?v={stamp}").into()),
    )
        .title("选择要加字幕的应用")
        .inner_size(420.0, 430.0)
        .resizable(false)
        .center()
        .build()
        .map(|_| ())
        .map_err(|e| format!("打开应用选择窗失败：{e}"))
}

fn start_captions_session(app: &tauri::AppHandle, pid: Option<u32>) -> Result<(), String> {
    if !plugins::subtitles_plugin_enabled() {
        return Err("字幕插件未启用：请到 设置 → 插件 打开 subtitles".into());
    }
    open_captions_from(app)?;
    let model = captions_model_dir()?;
    let session = captions::start(app.clone(), model, 1, pid);
    let state = app.state::<AppState>();
    *state
        .captions
        .lock()
        .map_err(|_| "锁失败".to_string())? = Some(session);
    Ok(())
}

fn toggle_captions(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    {
        let mut slot = state.captions.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut session) = slot.take() {
            session.stop();
            if let Some(w) = app.get_webview_window("captions") {
                let _ = w.close();
            }
            return;
        }
    }

    if let Err(e) = start_captions_session(app, None) {
        let _ = app.emit(
            "myt://caption",
            serde_json::json!({ "text": "", "listening": false, "silent": false, "active": false, "error": e }),
        );
    }
}

/// 只抓「点菜单时前台窗口所属进程」的声音；其余应用的声音一律不进字幕。
/// 托盘菜单会把焦点拿走，所以这个入口更多是给命令和热键联调用。
fn toggle_process_captions(app: &tauri::AppHandle) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId,
    };

    let state = app.state::<AppState>();
    {
        let mut slot = state.captions.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut session) = slot.take() {
            session.stop();
            if let Some(w) = app.get_webview_window("captions") {
                let _ = w.close();
            }
            return;
        }
    }

    let mut pid = 0u32;
    unsafe {
        let hwnd = GetForegroundWindow();
        if !hwnd.is_null() {
            GetWindowThreadProcessId(hwnd, &mut pid);
        }
    }
    if pid == 0 || pid == std::process::id() {
        let _ = app.emit(
            "myt://caption",
            serde_json::json!({
                "text": "", "listening": false, "silent": true, "active": false,
                "error": "没有拿到前台应用：先把要翻译的应用切到前台，再用命令或热键启动"
            }),
        );
        return;
    }

    if let Err(e) = start_captions_session(app, Some(pid)) {
        let _ = app.emit(
            "myt://caption",
            serde_json::json!({ "text": "", "listening": false, "silent": false, "active": false, "error": e }),
        );
    }
}

#[tauri::command]
async fn captions_start(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    if state
        .captions
        .lock()
        .map(|s| s.is_some())
        .unwrap_or(false)
    {
        return Ok(());
    }
    start_captions_session(&app, None)
}

/// 只抓指定进程树的声音。pid 传 0 时自动取当前前台窗口。
#[tauri::command]
async fn captions_start_process(app: tauri::AppHandle, pid: Option<u32>) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId,
    };

    let state = app.state::<AppState>();
    if let Some(mut old) = state
        .captions
        .lock()
        .map_err(|_| "锁失败".to_string())?
        .take()
    {
        old.stop();
    }

    let pid = match pid {
        Some(p) if p != 0 => p,
        _ => {
            let mut p = 0u32;
            unsafe {
                let hwnd = GetForegroundWindow();
                if !hwnd.is_null() {
                    GetWindowThreadProcessId(hwnd, &mut p);
                }
            }
            if p == 0 {
                return Err("没有拿到前台应用".into());
            }
            p
        }
    };
    if pid == std::process::id() {
        return Err("不能抓自己：请先切到目标应用".into());
    }
    start_captions_session(&app, Some(pid))
}

#[tauri::command]
fn captions_list_sessions() -> Result<Vec<serde_json::Value>, String> {
    let list = wasapi::audio_sessions()?;
    Ok(list
        .into_iter()
        .map(|s| serde_json::json!({ "pid": s.pid, "name": s.name, "active": s.active }))
        .collect())
}

#[tauri::command]
async fn captions_open_picker(app: tauri::AppHandle) -> Result<(), String> {
    open_picker_from(&app)
}

fn open_wordcard(app: &tauri::AppHandle, payload: &serde_json::Value) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("wordcard") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = app.emit_to("wordcard", "myt://word", payload.clone());
        return Ok(());
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let win = tauri::WebviewWindowBuilder::new(
        app,
        "wordcard",
        tauri::WebviewUrl::App(format!("wordcard.html?v={stamp}").into()),
    )
    .title("查词")
    .inner_size(620.0, 260.0)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .visible(false)
    .build()
    .map_err(|e| format!("打开词卡失败：{e}"))?;

    if let Some(c) = app.get_webview_window("captions") {
        if let (Ok(pos), Ok(csize), Ok(wsize)) =
            (c.outer_position(), c.outer_size(), win.outer_size())
        {
            let x = pos.x + (csize.width as i32 - wsize.width as i32) / 2;
            let y = pos.y - wsize.height as i32 - 8;
            let _ = win.set_position(tauri::PhysicalPosition::new(x.max(0), y.max(0)));
        }
    }
    let _ = win.show();
    let _ = app.emit_to("wordcard", "myt://word", payload.clone());
    Ok(())
}

#[tauri::command]
fn captions_word_current(app: tauri::AppHandle) -> Option<serde_json::Value> {
    app.state::<AppState>()
        .word_last
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

/// 在线查词：只发单词本身到 dictionaryapi.dev，返回音标 + 最多两组释义。
#[tauri::command]
async fn captions_lookup_word(app: tauri::AppHandle, word: String) -> Result<(), String> {
    let clean: String = word
        .chars()
        .filter(|c| c.is_ascii_alphabetic() || *c == '\'' || *c == '-')
        .collect();
    if clean.is_empty() {
        return Err("没有选中有效的英文单词".into());
    }
    let url = format!(
        "https://api.dictionaryapi.dev/api/v2/entries/en/{}",
        clean.to_lowercase()
    );
    let resp = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
        .get(url)
        .send()
        .await
        .map_err(|e| format!("查词请求失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("没查到「{clean}」，可能是专有名词或拼写变体"));
    }
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析词典结果失败：{e}"))?;
    let first = v.get(0).cloned().unwrap_or(serde_json::Value::Null);
    let phonetic = first["phonetic"]
        .as_str()
        .map(|s| s.to_string())
        .or_else(|| {
            first["phonetics"]
                .as_array()
                .and_then(|a| a.iter().find_map(|p| p["text"].as_str().map(|s| s.to_string())))
        })
        .unwrap_or_default();

    let mut meanings = Vec::new();
    if let Some(arr) = first["meanings"].as_array() {
        for m in arr.iter().take(2) {
            let pos = m["partOfSpeech"].as_str().unwrap_or("");
            let mut defs = Vec::new();
            if let Some(d) = m["definitions"].as_array() {
                for def in d.iter().take(2) {
                    if let Some(text) = def["definition"].as_str() {
                        defs.push(text.to_string());
                    }
                }
            }
            if !defs.is_empty() {
                meanings.push(serde_json::json!({ "pos": pos, "defs": defs }));
            }
        }
    }

    let payload = serde_json::json!({
        "word": clean,
        "phonetic": phonetic,
        "meanings": meanings,
    });
    *app
        .state::<AppState>()
        .word_last
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(payload.clone());
    open_wordcard(&app, &payload)
}

#[tauri::command]
fn captions_add_vocab(
    app: tauri::AppHandle,
    word: String,
    meaning: String,
) -> Result<usize, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取数据目录失败：{e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("建目录失败：{e}"))?;
    let file = dir.join("vocab.json");
    let mut arr: Vec<serde_json::Value> = std::fs::read_to_string(&file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    if arr.iter().any(|v| v["word"].as_str() == Some(word.as_str())) {
        return Ok(arr.len());
    }
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    arr.push(serde_json::json!({ "word": word, "meaning": meaning, "at": at }));
    std::fs::write(
        &file,
        serde_json::to_string_pretty(&arr).unwrap_or_default(),
    )
    .map_err(|e| format!("写生词本失败：{e}"))?;
    Ok(arr.len())
}

#[tauri::command]
fn captions_export_vocab(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取数据目录失败：{e}"))?;
    let file = dir.join("vocab.json");
    let arr: Vec<serde_json::Value> = std::fs::read_to_string(&file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    if arr.is_empty() {
        return Err("生词本还是空的：先在字幕里点几个词收藏".into());
    }
    let desktop = app
        .path()
        .desktop_dir()
        .unwrap_or_else(|_| dir.clone());
    let out = desktop.join("MyTranscript-生词本.csv");
    let mut csv = String::from("\u{feff}单词,释义,收藏时间\n");
    for v in &arr {
        let word = v["word"].as_str().unwrap_or("");
        let meaning = v["meaning"].as_str().unwrap_or("");
        let at = v["at"].as_u64().unwrap_or(0);
        csv.push_str(&format!(
            "\"{}\",\"{}\",{}\n",
            word.replace('"', "\"\""),
            meaning.replace('"', "\"\""),
            at
        ));
    }
    std::fs::write(&out, csv).map_err(|e| format!("写 CSV 失败：{e}"))?;
    Ok(out.to_string_lossy().to_string())
}

#[tauri::command]
fn captions_open_vocab(app: tauri::AppHandle) -> Result<String, String> {    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取数据目录失败：{e}"))?;
    let file = dir.join("vocab.json");
    if !file.exists() {
        return Err("生词本还是空的：先在字幕里点几个词收藏".into());
    }
    std::process::Command::new("notepad")
        .arg(&file)
        .spawn()
        .map_err(|e| format!("打开生词本失败：{e}"))?;
    Ok(file.to_string_lossy().to_string())
}

#[tauri::command]
async fn captions_stop(app: tauri::AppHandle) {
    let state = app.state::<AppState>();
    let session = state.captions.lock().ok().and_then(|mut s| s.take());
    if let Some(mut s) = session {
        s.stop();
    }
    if let Some(w) = app.get_webview_window("captions") {
        let _ = w.close();
    }
}

#[tauri::command]
fn captions_active(app: tauri::AppHandle) -> bool {
    app.state::<AppState>()
        .captions
        .lock()
        .map(|s| s.is_some())
        .unwrap_or(false)
}

fn apply_caption_ui(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let drag = *state
        .captions_drag
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let lookup = *state
        .captions_lookup
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let zh = *state
        .captions_zh
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let commit = *state
        .captions_commit
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let alpha = *state
        .captions_alpha
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(w) = app.get_webview_window("captions") {
        let _ = w.set_ignore_cursor_events(!(drag || lookup));
        let _ = w.emit(
            "myt://caption-ui",
            serde_json::json!({ "drag": drag, "alpha": alpha, "lookup": lookup, "zh": zh, "commit": commit }),
        );
    }
}

fn set_caption_drag(app: &tauri::AppHandle, on: bool) {
    let state = app.state::<AppState>();
    *state
        .captions_drag
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = on;
    apply_caption_ui(app);
}

fn set_caption_zh(app: &tauri::AppHandle, on: bool) {
    let state = app.state::<AppState>();
    *state
        .captions_zh
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = on;
    crate::dbg_log(&format!("captions: zh={on}"));
    apply_caption_ui(app);
}

fn set_caption_commit(app: &tauri::AppHandle, on: bool) {
    let state = app.state::<AppState>();
    *state
        .captions_commit
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = on;
    crate::dbg_log(&format!("captions: commit={on}"));
    apply_caption_ui(app);
}

#[tauri::command]
async fn captions_set_commit(app: tauri::AppHandle, on: bool) {
    set_caption_commit(&app, on);
}

/// 中文字幕：只把“已经稳定的一句英文”发出去，不缓存、不落盘。
#[tauri::command]
async fn captions_translate(text: String) -> Result<String, String> {
    let q = text.trim();
    if q.is_empty() {
        return Ok(String::new());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .user_agent("MyTranscript/0.1")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get("https://api.mymemory.translated.net/get")
        .query(&[("q", q), ("langpair", "en|zh-CN")])
        .send()
        .await
        .map_err(|e| format!("翻译请求失败：{e}"))?;
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("翻译响应解析失败：{e}"))?;
    let zh = body["responseData"]["translatedText"]
        .as_str()
        .unwrap_or("")
        .to_string();
    Ok(zh)
}

fn set_caption_lookup(app: &tauri::AppHandle, on: bool) {
    let state = app.state::<AppState>();
    *state
        .captions_lookup
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = on;
    crate::dbg_log(&format!("captions: lookup={on}"));
    apply_caption_ui(app);
}

fn cycle_caption_alpha(app: &tauri::AppHandle) {
    const STEPS: [f64; 4] = [0.88, 0.72, 0.55, 1.0];
    let state = app.state::<AppState>();
    let mut cur = state
        .captions_alpha
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let idx = STEPS.iter().position(|v| (v - *cur).abs() < 0.01).unwrap_or(0);
    *cur = STEPS[(idx + 1) % STEPS.len()];
    drop(cur);
    apply_caption_ui(app);
}

#[tauri::command]
async fn captions_set_drag(app: tauri::AppHandle, on: bool) {
    set_caption_drag(&app, on);
}

#[tauri::command]
async fn captions_set_lookup(app: tauri::AppHandle, on: bool) {
    set_caption_lookup(&app, on);
}

#[tauri::command]
async fn captions_set_zh(app: tauri::AppHandle, on: bool) {
    set_caption_zh(&app, on);
}

#[tauri::command]
async fn captions_set_opacity(app: tauri::AppHandle, alpha: f64) {
    let state = app.state::<AppState>();
    *state
        .captions_alpha
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = alpha.clamp(0.3, 1.0);
    apply_caption_ui(&app);
}

/// 前端调用：翻译一段文本，引擎与密钥由前端传入；请求在壳里发，绕开 CORS。
#[tauri::command]
async fn tr_translate(req: translate::TrRequest) -> Result<Vec<String>, String> {
    translate::translate(req).await
}

#[tauri::command]
async fn llm_chat(req: translate::LlmRequest) -> Result<String, String> {
    translate::llm_chat(req).await
}

#[tauri::command]
async fn llm_models(config: translate::TrConfig) -> Result<Vec<translate::LlmModel>, String> {
    translate::llm_models(config).await
}

/// 托盘图标：左键显示/隐藏主窗，右键给一组最小菜单。
/// 菜单里的播放控制统一 emit 给前端执行，壳层不另存一份播放状态。
#[cfg(target_os = "windows")]
fn spawn_media_keys(app: tauri::AppHandle) {
    std::thread::spawn(move || unsafe {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            RegisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY};
        let keys: [(i32, u32, u32, &str); 4] = [
            (1, 0xB3, MOD_NOREPEAT, "playpause"),
            (2, 0xB0, MOD_NOREPEAT, "next"),
            (3, 0xB1, MOD_NOREPEAT, "prev"),
            // Ctrl+Alt+L：全局字幕显隐（开关）
            (4, 0x4C, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, "captions"),
        ];
        let mut registered = 0;
        for (id, vk, mods, _cmd) in keys {
            if RegisterHotKey(std::ptr::null_mut(), id, mods, vk) != 0 {
                registered += 1;
            }
        }
        if registered == 0 {
            return;
        }
        let mut msg: MSG = std::mem::zeroed();
        loop {
            let ret = GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0);
            if ret == 0 || ret == -1 {
                break;
            }
            if msg.message == WM_HOTKEY {
                let cmd = match msg.wParam as i32 {
                    1 => "playpause",
                    2 => "next",
                    3 => "prev",
                    4 => {
                        let app2 = app.clone();
                        std::thread::spawn(move || toggle_captions(&app2));
                        continue;
                    }
                    _ => continue,
                };
                let _ = app.emit("myt://media", cmd);
            }
        }
    });
}

#[derive(serde::Serialize)]
struct LocalAudioFile {
    path: String,
    name: String,
    size: u64,
    modified: u64,
}

#[tauri::command]
fn local_scan(path: String) -> Result<Vec<LocalAudioFile>, String> {
    use std::path::Path;
    use std::time::UNIX_EPOCH;
    const AUDIO_EXT: [&str; 13] = ["mp3", "m4a", "aac", "ogg", "opus", "wav", "flac", "wma", "mp4", "m4v", "webm", "mov", "mkv"];
    fn walk(dir: &Path, depth: usize, out: &mut Vec<LocalAudioFile>) {
        if depth > 3 || out.len() >= 500 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return; };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue; };
            if meta.is_dir() {
                walk(&path, depth + 1, out);
                continue;
            }
            let ext = path.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
            if !AUDIO_EXT.contains(&ext.as_str()) {
                continue;
            }
            let modified = meta.modified().ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            out.push(LocalAudioFile {
                path: path.to_string_lossy().to_string(),
                name: path.file_name().and_then(|v| v.to_str()).unwrap_or("audio").to_string(),
                size: meta.len(),
                modified,
            });
        }
    }
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err("选择的不是文件夹".into());
    }
    let mut files = Vec::new();
    walk(root, 0, &mut files);
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(files)
}

#[tauri::command]
fn notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "显示 / 隐藏窗口", true, None::<&str>)?;
    let play = MenuItem::with_id(app, "play", "播放 / 暂停", true, None::<&str>)?;
    let prev = MenuItem::with_id(app, "prev", "上一集", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "下一集", true, None::<&str>)?;
    let mini = MenuItem::with_id(app, "mini", "迷你窗", true, None::<&str>)?;
    let captions = MenuItem::with_id(app, "captions", "全局字幕（实验）", true, None::<&str>)?;
    let captions_proc = MenuItem::with_id(app, "captions_proc", "全局字幕：只抓前台应用（实验）", true, None::<&str>)?;
    let captions_pick = MenuItem::with_id(app, "captions_pick", "全局字幕：选择应用…", true, None::<&str>)?;
    let captions_lookup = MenuItem::with_id(app, "captions_lookup", "字幕查词（点词看释义）", true, None::<&str>)?;
    let captions_zh = MenuItem::with_id(app, "captions_zh", "中文字幕（实验）", true, None::<&str>)?;
    let captions_commit = MenuItem::with_id(app, "captions_commit", "成句显示（少回改）", true, None::<&str>)?;
    let captions_vocab = MenuItem::with_id(app, "captions_vocab", "打开生词本", true, None::<&str>)?;
    let captions_export = MenuItem::with_id(app, "captions_export", "生词本导出 CSV", true, None::<&str>)?;
    let captions_terms = MenuItem::with_id(app, "captions_terms", "术语表（识别纠错）", true, None::<&str>)?;
    let captions_drag = MenuItem::with_id(app, "captions_drag", "字幕窗可拖动", true, None::<&str>)?;
    let captions_alpha = MenuItem::with_id(app, "captions_alpha", "字幕透明度", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let s1 = PredefinedMenuItem::separator(app)?;
    let s2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &toggle,
            &s1,
            &play,
            &prev,
            &next,
            &s2,
            &mini,
            &captions,
            &captions_proc,
            &captions_pick,
            &captions_lookup,
            &captions_zh,
            &captions_commit,
            &captions_vocab,
            &captions_export,
            &captions_terms,
            &captions_drag,
            &captions_alpha,
            &quit,
        ],
    )?;
    let mut tray = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("MyTranscript")
        .show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_menu_event(|app, event| {
        match event.id().as_ref() {
            "toggle" => toggle_main(app),
            "quit" => app.exit(0),
            "mini" => {
                // 菜单回调在主线程，建窗必须挪到独立线程，否则 Windows 上会死锁。
                let app2 = app.clone();
                std::thread::spawn(move || {
                    if open_mini_from(&app2).is_err() {
                        let _ = app2.emit_to("main", "myt://tray", "mini");
                    }
                });
            }
            "captions" => {
                let app2 = app.clone();
                std::thread::spawn(move || toggle_captions(&app2));
            }
            "captions_proc" => {
                let app2 = app.clone();
                std::thread::spawn(move || toggle_process_captions(&app2));
            }
            "captions_pick" => {
                let app2 = app.clone();
                std::thread::spawn(move || {
                    if let Err(e) = open_picker_from(&app2) {
                        let _ = app2.emit("myt://caption", serde_json::json!({
                            "text": "", "listening": false, "silent": true, "active": false, "error": e
                        }));
                    }
                });
            }
            "captions_lookup" => {
                let app2 = app.clone();
                std::thread::spawn(move || {
                    let state = app2.state::<AppState>();
                    let cur = *state
                        .captions_lookup
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    set_caption_lookup(&app2, !cur);
                });
            }
            "captions_vocab" => {
                let app2 = app.clone();
                std::thread::spawn(move || {
                    if let Err(e) = captions_open_vocab(app2.clone()) {
                        let _ = app2.emit("myt://caption", serde_json::json!({
                            "text": "", "listening": false, "silent": true, "active": false, "error": e
                        }));
                    }
                });
            }
            "captions_zh" => {
                let app2 = app.clone();
                std::thread::spawn(move || {
                    let state = app2.state::<AppState>();
                    let cur = *state.captions_zh.lock().unwrap_or_else(|e| e.into_inner());
                    set_caption_zh(&app2, !cur);
                });
            }
            "captions_commit" => {
                let app2 = app.clone();
                std::thread::spawn(move || {
                    let state = app2.state::<AppState>();
                    let cur = *state
                        .captions_commit
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    set_caption_commit(&app2, !cur);
                });
            }
            "captions_export" => {
                let app2 = app.clone();
                std::thread::spawn(move || match captions_export_vocab(app2.clone()) {
                    Ok(path) => {
                        let _ = std::process::Command::new("explorer")
                            .arg(format!("/select,{path}"))
                            .spawn();
                    }
                    Err(e) => {
                        let _ = app2.emit("myt://caption", serde_json::json!({
                            "text": "", "listening": false, "silent": true, "active": false, "error": e
                        }));
                    }
                });
            }
            "captions_terms" => {
                let app2 = app.clone();
                std::thread::spawn(move || {
                    if let Ok(dir) = app2.path().app_data_dir() {
                        let file = dir.join("terms.txt");
                        let _ = std::process::Command::new("notepad").arg(file).spawn();
                    }
                });
            }
            "captions_drag" => {
                let app2 = app.clone();
                std::thread::spawn(move || {
                    let state = app2.state::<AppState>();
                    let cur = *state.captions_drag.lock().unwrap_or_else(|e| e.into_inner());
                    set_caption_drag(&app2, !cur);
                });
            }
            "captions_alpha" => {
                let app2 = app.clone();
                std::thread::spawn(move || cycle_caption_alpha(&app2));
            }
            id => {
                let _ = app.emit_to("main", "myt://tray", id);
            }
        }
    })
    .on_tray_icon_event(|tray, event| {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            toggle_main(tray.app_handle());
        }
    })
    .build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // 视频同源代理：`http://mytmedia.localhost/?u=<远端地址>`，Range 透传 + 落盘缓存。
        // 有了它，页面里的 <video> 与 Play 页同源，AudioWorklet 才能取到真实 PCM。
        .register_asynchronous_uri_scheme_protocol("mytmedia", |ctx, req, responder| {
            media_proxy::handle(ctx, req, responder)
        })
        .setup(|app| {
            // 术语纠正表：模型词表里没有的专名会被识别成同音词，这里做识别后替换。
            if let Ok(dir) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(&dir);
                let terms = dir.join("terms.txt");
                if !terms.exists() {
                    let template = "# 术语纠正：识别错的写法 => 想要的写法（一行一条，保存后约 2 秒生效）\n\
# 例：ENTHROPIC => Anthropic\n\
# 例：COULD BEAR NETS => Kubernetes\n\
# 例：POST GRASS => Postgres\n";
                    let _ = std::fs::write(&terms, template);
                }
                std::env::set_var("MYT_TERMS", &terms);
            }
            // 离线标点模型：放在 ProgramData（ASCII 路径），有就启用，没有就退回停顿断句。
            let punct = std::path::PathBuf::from(
                std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into()),
            )
            .join("MyTranscript\\models\\punct-en\\sherpa-onnx-online-punct-en-2024-08-06");
            if punct.join("model.int8.onnx").exists() || punct.join("model.onnx").exists() {
                std::env::set_var("MYT_PUNCT", &punct);
            }
            // 本机默认不带插件：插件目录保持原样，由用户在设置里手动导入。
            if let Err(e) = build_tray(app.handle()) {
                eprintln!("托盘创建失败：{e}");
            }
            #[cfg(target_os = "windows")]
            spawn_media_keys(app.handle().clone());
            // 联调开关：MYT_MINI_AUTO=1 时开局自动弹迷你窗（配合 MYT_DEBUG 抓日志）。
            if std::env::var("MYT_MINI_AUTO").is_ok() {
                let app2 = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(300));
                    let _ = open_mini_from(&app2);
                });
            }
            // 联调开关：MYT_CAPTIONS_AUTO=1 时开局自动开全局字幕（配合 MYT_DEBUG 抓日志）。
            if std::env::var("MYT_CAPTIONS_AUTO").is_ok() {
                let app2 = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(1200));
                    toggle_captions(&app2);
                });
            }
            // 联调开关：MYT_EVAL 里放一段 JS，主窗起来 2.5s 后执行（不用手点就能进播放页）。
            if let Ok(js) = std::env::var("MYT_EVAL") {
                if let Some(w) = app.get_webview_window("main") {
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(2500));
                        let _ = w.eval(&js);
                    });
                }
            }
            Ok(())
        })
        .manage(AppState {
            engines: Mutex::new(HashMap::new()),
            next_id: Mutex::new(0),
            asr_cancel: Mutex::new(HashSet::new()),
            captions: Mutex::new(None),
            captions_drag: Mutex::new(false),
            captions_alpha: Mutex::new(0.88),
            captions_lookup: Mutex::new(false),
            captions_zh: Mutex::new(false),
            captions_commit: Mutex::new(false),
            word_last: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            read_range,
            http_text,
            offline::offline_save,
            offline::clip_audio_cache,
            offline::remote_clip_transcribe,
            offline::offline_save_transcript,
            offline::offline_transcript_load,
            offline::offline_save_skip,
            offline::offline_skip_load,
            offline::offline_list,
            offline::offline_remove,
            plugins::plugin_list,
            plugins::plugin_set_enabled,
            plugins::plugin_open_dir,
            plugins::plugin_import,
            plugins::plugin_example,
            models::asr_prepare,
            models::asr_models,
            models::asr_remove,
            models::asr_import,
            models::asr_cancel,
            models::asr_open_dir,
            models::asr_open,
            models::asr_feed,
            models::asr_result,
            models::asr_reset,
            models::asr_close,
            open_mini,
            close_mini,
            mini_fit,
            captions_start,
        captions_start_process,
        captions_list_sessions,
        captions_open_picker,
        captions_set_lookup,
        captions_lookup_word,
        captions_word_current,
        captions_add_vocab,
        captions_open_vocab,
            captions_export_vocab,
            captions_translate,
            captions_set_zh,
            captions_set_commit,
            captions_stop,
            captions_active,
            captions_set_drag,
            captions_set_opacity,
            tr_translate,
            llm_chat,
            llm_models,
            notify,
            local_scan,
            local_transcribe_start,
            local_transcribe_status,
            local_clip_transcribe,
            local_transcribe_stop,
            local_transcript_load,
            media::media_probe,
            media::media_cut,
            media::media_extract_audio,
            video_asr::video_asr_start,
            video_asr::video_asr_poll,
            video_asr::video_asr_cancel,
            video_asr::video_asr_close,
            dbg_note
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
