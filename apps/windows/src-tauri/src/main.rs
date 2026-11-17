#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod asr;

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, State};

const MODEL_FILES: [&str; 4] = [
    "encoder-epoch-99-avg-1.int8.onnx",
    "decoder-epoch-99-avg-1.int8.onnx",
    "joiner-epoch-99-avg-1.int8.onnx",
    "tokens.txt",
];
// 官方 Hugging Face 在国内经常连不上，留个镜像作为备选（内容同一个仓库）。
const MODEL_BASES: [&str; 2] = [
    "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17/resolve/main/",
    "https://hf-mirror.com/csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17/resolve/main/",
];

struct AppState {
    engines: Mutex<HashMap<u32, asr::Asr>>,
    next_id: Mutex<u32>,
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
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

/// 模型目录必须是纯 ASCII：
/// sherpa 内部用 std::ifstream 判「文件是否存在」，路径里有中文（比如用户名「游梦」）
/// 就会报 “tokens.txt does not exist”，识别器直接创建失败。
/// 所以固定放进 ProgramData（全平台都是 ASCII 路径），历史版本放在 app_data 里的
/// 模型顺手搬过来，别让用户再下一次 41 MB。
fn model_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let program_data = std::env::var("ProgramData")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("C:\\ProgramData"));
    let dir = program_data.join("MyTranscript").join("sherpa-en-20M");
    if !dir.to_string_lossy().is_ascii() {
        return Err(format!("模型目录路径含非 ASCII 字符：{}", dir.display()));
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建模型目录失败：{e}"))?;
    // 旧版本把模型下在 app_data 目录（用户名是中文时会挂），有就搬过来。
    if let Ok(old) = app.path().app_data_dir() {
        let old = old.join("sherpa-en-20M");
        for name in MODEL_FILES {
            let dst = dir.join(name);
            let src = old.join(name);
            if !dst.exists() && src.exists() {
                let _ = std::fs::copy(&src, &dst);
            }
        }
    }
    Ok(dir)
}

/// 准备模型目录：缺哪个下哪个，下完返回绝对路径。第二次进来直接返回缓存。
#[tauri::command]
async fn asr_prepare(app: tauri::AppHandle) -> Result<String, String> {
    let dir = model_dir(&app)?;
    let client = http();
    for name in MODEL_FILES {
        let path = dir.join(name);
        let ok = std::fs::metadata(&path).map(|m| m.len() > 0).unwrap_or(false);
        if ok {
            continue;
        }
        let mut last = String::from("未知错误");
        let mut done = false;
        for base in MODEL_BASES {
            let url = format!("{base}{name}");
            match client.get(&url).send().await {
                Ok(res) if res.status().is_success() => match res.bytes().await {
                    Ok(bytes) if !bytes.is_empty() => {
                        let tmp = path.with_extension("part");
                        let mut f = std::fs::File::create(&tmp)
                            .map_err(|e| format!("写模型文件失败：{e}"))?;
                        use std::io::Write;
                        f.write_all(&bytes).map_err(|e| format!("写模型文件失败：{e}"))?;
                        std::fs::rename(&tmp, &path)
                            .map_err(|e| format!("保存模型文件失败：{e}"))?;
                        done = true;
                        break;
                    }
                    Ok(_) => last = "下载到空文件".to_string(),
                    Err(e) => last = format!("读取失败：{e}"),
                },
                Ok(res) => last = format!("HTTP {}", res.status()),
                Err(e) => last = format!("连接失败：{e}"),
            }
        }
        if !done {
            return Err(format!("下载模型 {name} 失败（{last}）"));
        }
    }
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn asr_open(state: State<AppState>, model_dir: String, threads: u32) -> Result<u32, String> {
    let engine = asr::Asr::new(&model_dir, threads as i32)?;
    let mut next = state.next_id.lock().map_err(|_| "锁失败")?;
    *next += 1;
    let id = *next;
    state.engines.lock().map_err(|_| "锁失败")?.insert(id, engine);
    Ok(id)
}

#[tauri::command]
fn asr_feed(
    state: State<AppState>,
    id: u32,
    samples: Vec<f32>,
    sample_rate: Option<u32>,
) -> Result<(), String> {
    let engines = state.engines.lock().map_err(|_| "锁失败")?;
    let engine = engines.get(&id).ok_or("识别器已关闭")?;
    engine.feed(&samples, sample_rate.unwrap_or(16000) as i32);
    Ok(())
}

#[tauri::command]
fn asr_result(state: State<AppState>, id: u32) -> Result<String, String> {
    let engines = state.engines.lock().map_err(|_| "锁失败")?;
    let engine = engines.get(&id).ok_or("识别器已关闭")?;
    engine.result()
}

#[tauri::command]
fn asr_reset(state: State<AppState>, id: u32) -> Result<(), String> {
    let engines = state.engines.lock().map_err(|_| "锁失败")?;
    if let Some(engine) = engines.get(&id) {
        engine.reset();
    }
    Ok(())
}

#[tauri::command]
fn asr_close(state: State<AppState>, id: u32) -> Result<(), String> {
    state.engines.lock().map_err(|_| "锁失败")?.remove(&id);
    Ok(())
}

/// 诊断日志：只有设了 MYT_DEBUG 才写 `%TEMP%\myt-mini.log`，正常用户不受影响。
fn dbg_log(line: &str) {
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

/// 迷你窗页面自己报一句“我起来了”，用来分清「没加载」还是「加载了没渲染」。
#[tauri::command]
fn dbg_note(msg: String) {
    dbg_log(&format!("boot {msg}"));
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
#[tauri::command]
fn open_mini(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("mini") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(&app, "mini", tauri::WebviewUrl::App("mini.html".into()))
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

#[tauri::command]
fn close_mini(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("mini") {
        let _ = w.close();
    }
}

/// 托盘图标：左键显示/隐藏主窗，右键给一组最小菜单。
/// 菜单里的播放控制统一 emit 给前端执行，壳层不另存一份播放状态。
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "显示 / 隐藏窗口", true, None::<&str>)?;
    let play = MenuItem::with_id(app, "play", "播放 / 暂停", true, None::<&str>)?;
    let prev = MenuItem::with_id(app, "prev", "上一集", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "下一集", true, None::<&str>)?;
    let mini = MenuItem::with_id(app, "mini", "迷你窗", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let s1 = PredefinedMenuItem::separator(app)?;
    let s2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&toggle, &s1, &play, &prev, &next, &s2, &mini, &quit])?;
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
                if open_mini(app.clone()).is_err() {
                    let _ = app.emit_to("main", "myt://tray", "mini");
                }
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
        .setup(|app| {
            if let Err(e) = build_tray(app.handle()) {
                eprintln!("托盘创建失败：{e}");
            }
            // 联调开关：MYT_MINI_AUTO=1 时开局自动弹迷你窗（配合 MYT_DEBUG 抓日志）。
            if std::env::var("MYT_MINI_AUTO").is_ok() {
                let _ = open_mini(app.handle().clone());
            }
            Ok(())
        })
        .manage(AppState {
            engines: Mutex::new(HashMap::new()),
            next_id: Mutex::new(0),
        })
        .invoke_handler(tauri::generate_handler![
            read_range,
            asr_prepare,
            asr_open,
            asr_feed,
            asr_result,
            asr_reset,
            asr_close,
            open_mini,
            close_mini,
            dbg_note
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
