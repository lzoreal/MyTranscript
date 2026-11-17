#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod asr;

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, State};

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

fn main() {
    tauri::Builder::default()
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
            asr_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
