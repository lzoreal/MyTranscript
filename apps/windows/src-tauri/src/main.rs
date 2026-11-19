#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod asr;
mod captions;
mod localasr;
mod punct;
mod translate;
mod wasapi;

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, State};

/// 识别模型清单。文件只内置「下载地址 + 规范化文件名」，
/// 模型本体不放仓库、不上我们的服务器（体积大、也没必要）。
struct ModelSpec {
    id: &'static str,
    name: &'static str,
    lang: &'static str,
    desc: &'static str,
    repo: &'static str,
    /// (远端文件名, 本地规范化文件名)
    files: &'static [(&'static str, &'static str)],
}

const MODELS: [ModelSpec; 4] = [
    ModelSpec {
        id: "en-mini",
        name: "英文 · 迷你",
        lang: "en",
        desc: "约 41 MB · 最快，英文播客日常够用",
        repo: "csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17",
        files: &[
            ("encoder-epoch-99-avg-1.int8.onnx", "encoder.onnx"),
            ("decoder-epoch-99-avg-1.int8.onnx", "decoder.onnx"),
            ("joiner-epoch-99-avg-1.int8.onnx", "joiner.onnx"),
            ("tokens.txt", "tokens.txt"),
        ],
    },
    ModelSpec {
        id: "en-standard",
        name: "英文 · 标准",
        lang: "en",
        desc: "约 69 MB · 比迷你准，口音和背景噪声更稳",
        repo: "csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26",
        files: &[
            (
                "encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx",
                "encoder.onnx",
            ),
            (
                "decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx",
                "decoder.onnx",
            ),
            (
                "joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx",
                "joiner.onnx",
            ),
            ("tokens.txt", "tokens.txt"),
        ],
    },
    ModelSpec {
        id: "en-large",
        name: "英文 · 大",
        lang: "en",
        desc: "约 253 MB · 精度最高，机器较慢时会跟不上实时",
        repo: "csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26",
        files: &[
            (
                "encoder-epoch-99-avg-1-chunk-16-left-128.onnx",
                "encoder.onnx",
            ),
            (
                "decoder-epoch-99-avg-1-chunk-16-left-128.onnx",
                "decoder.onnx",
            ),
            (
                "joiner-epoch-99-avg-1-chunk-16-left-128.onnx",
                "joiner.onnx",
            ),
            ("tokens.txt", "tokens.txt"),
        ],
    },
    ModelSpec {
        id: "zh-en",
        name: "中英 · 双语",
        lang: "zh-en",
        desc: "约 189 MB · 中文播客或中英混说时用",
        repo: "csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20",
        files: &[
            ("encoder-epoch-99-avg-1.int8.onnx", "encoder.onnx"),
            ("decoder-epoch-99-avg-1.int8.onnx", "decoder.onnx"),
            ("joiner-epoch-99-avg-1.int8.onnx", "joiner.onnx"),
            ("tokens.txt", "tokens.txt"),
        ],
    },
];

// 国内直连官方的 Hugging Face 经常超时，镜像放前面先试；镜像挂了再回官方。
const MODEL_MIRRORS: [&str; 2] = ["https://hf-mirror.com/", "https://huggingface.co/"];

struct AppState {
    engines: Mutex<HashMap<u32, asr::Asr>>,
    next_id: Mutex<u32>,
    /// 正在下载的模型 id；页面点「取消」时塞进来，下载循环每个分块检查一次。
    asr_cancel: Mutex<HashSet<String>>,
    /// 全局字幕会话；None 表示没在听。
    captions: Mutex<Option<captions::Session>>,
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

fn offline_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("定位数据目录失败：{e}"))?;
    let dir = base.join("offline");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建离线目录失败：{e}"))?;
    Ok(dir)
}

/// 只留 ASCII 字母数字和 - _，避免中文/表情进入文件名（Windows 上还要躲非法字符）。
fn safe_name(raw: &str) -> String {
    let mut s = String::new();
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            s.push(ch);
        } else if ch == '.' || ch == ':' || ch == '/' || ch == '\\' {
            s.push('_');
        }
    }
    if s.is_empty() {
        s.push_str("episode");
    }
    s.truncate(120);
    s
}

/// 离线文件扩展名：先看 URL 路径末尾，再看响应 content-type。
/// 原来不管源是什么一律存 .mp3，m4a/aac 的音频会被 asset 协议按 audio/mpeg 交出去，
/// WebView 有可能解不出来；顺带离线列表也只认 .mp3。
fn ext_from_url(url: &str) -> Option<&'static str> {
    let path = url
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    for ext in [".mp3", ".m4a", ".mp4", ".aac", ".ogg", ".oga", ".opus", ".wav", ".flac"] {
        if path.ends_with(ext) {
            return Some(&ext[1..]);
        }
    }
    None
}

fn ext_from_ctype(ct: &str) -> Option<&'static str> {
    let c = ct.to_ascii_lowercase();
    if c.contains("mpeg") {
        Some("mp3")
    } else if c.contains("mp4") || c.contains("aac") {
        Some("m4a")
    } else if c.contains("opus") {
        Some("opus")
    } else if c.contains("ogg") {
        Some("ogg")
    } else if c.contains("wav") {
        Some("wav")
    } else {
        None
    }
}

/// 把响应体逐块写进 tmp，同时按整数百分比推进度事件；返回 (已收字节, 总字节)。
async fn download_stream(
    app: &tauri::AppHandle,
    mut res: reqwest::Response,
    tmp: &std::path::Path,
    key: &str,
) -> Result<(u64, u64), String> {
    let total = res.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(tmp).map_err(|e| format!("创建文件失败：{e}"))?;
    use std::io::Write;
    let mut got: u64 = 0;
    let mut last_pct: i64 = -2;
    while let Some(chunk) = res.chunk().await.map_err(|e| format!("读取失败：{e}"))? {
        file.write_all(&chunk).map_err(|e| format!("写文件失败：{e}"))?;
        got += chunk.len() as u64;
        let pct = if total > 0 { (got * 100 / total) as i64 } else { -1 };
        if pct != last_pct {
            last_pct = pct;
            let _ = app.emit(
                "myt://offline",
                serde_json::json!({ "key": key, "got": got, "total": total, "pct": pct }),
            );
        }
    }
    file.flush().map_err(|e| format!("写文件失败：{e}"))?;
    Ok((got, total))
}

/// 整集下载到本地。进度用 `myt://offline` 事件推给前端（按百分比变化节流）。
#[tauri::command]
async fn offline_save(
    app: tauri::AppHandle,
    url: String,
    key: String,
) -> Result<String, String> {
    let dir = offline_dir(&app)?;
    let stem = safe_name(&key);
    if let Some(ext) = ext_from_url(&url) {
        let p = dir.join(format!("{stem}.{ext}"));
        if p.exists() {
            return Ok(p.to_string_lossy().to_string());
        }
    }
    let res = http_long()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;
    if !res.status().is_success() {
        return Err(format!("音频源返回 HTTP {}", res.status()));
    }
    let ct = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let ext = ext_from_url(&url)
        .or_else(|| ext_from_ctype(&ct))
        .unwrap_or("mp3");
    let path = dir.join(format!("{stem}.{ext}"));
    if path.exists() {
        return Ok(path.to_string_lossy().to_string());
    }
    let tmp = path.with_extension("part");
    let (got, total) = match download_stream(&app, res, &tmp, &key).await {
        Ok(v) => v,
        Err(e) => {
            // 中断/失败留下的 .part 必须清掉，否则下次会看到一堆残包。
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
    };
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("落盘失败：{e}"));
    }
    let _ = app.emit(
        "myt://offline",
        serde_json::json!({ "key": key, "got": got, "total": total, "pct": 100, "done": true }),
    );
    Ok(path.to_string_lossy().to_string())
}

/// 精听用的音频缓存，和「离线下载」分开存：离线列表会扫 offline 目录，
/// 缓存文件混进去会在用户列表里冒出一堆莫名其妙的条目。
fn clip_cache_dir() -> Result<std::path::PathBuf, String> {
    let program_data = std::env::var("ProgramData")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("C:\\ProgramData"));
    let dir = program_data.join("MyTranscript").join("cache").join("audio");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建精听缓存目录失败：{e}"))?;
    Ok(dir)
}

/// 在线单集首次精听时把整集音频拉到缓存；已缓存就直接返回路径。
#[tauri::command]
async fn clip_audio_cache(
    app: tauri::AppHandle,
    url: String,
    key: String,
) -> Result<String, String> {
    let dir = clip_cache_dir()?;
    let stem = safe_name(&key);
    if let Some(ext) = ext_from_url(&url) {
        let p = dir.join(format!("{stem}.{ext}"));
        if p.exists() {
            return Ok(p.to_string_lossy().to_string());
        }
    }
    let res = http_long()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;
    if !res.status().is_success() {
        return Err(format!("音频源返回 HTTP {}", res.status()));
    }
    let ct = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let ext = ext_from_url(&url)
        .or_else(|| ext_from_ctype(&ct))
        .unwrap_or("mp3");
    let path = dir.join(format!("{stem}.{ext}"));
    if path.exists() {
        return Ok(path.to_string_lossy().to_string());
    }
    let tmp = path.with_extension("part");
    match download_stream(&app, res, &tmp, &key).await {
        Ok(_) => {}
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("落盘失败：{e}"));
    }
    Ok(path.to_string_lossy().to_string())
}

/// MP3 头：跳过 ID3v2，找到第一个合法帧，取出比特率和采样率。
fn mp3_frame_at(bytes: &[u8], from: usize) -> Option<(usize, u32, u32)> {
    let mut i = from;
    while i + 4 <= bytes.len() {
        if bytes[i] == 0xFF && (bytes[i + 1] & 0xE0) == 0xE0 {
            let ver = (bytes[i + 1] >> 3) & 0x03;
            let layer = (bytes[i + 1] >> 1) & 0x03;
            let br_idx = ((bytes[i + 2] >> 4) & 0x0F) as usize;
            let sr_idx = ((bytes[i + 2] >> 2) & 0x03) as usize;
            if layer == 1 && br_idx >= 1 && br_idx <= 14 && sr_idx < 3 {
                let table: [u32; 15] = if ver == 3 {
                    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
                } else {
                    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
                };
                let rates = if ver == 3 {
                    [44100u32, 48000, 32000]
                } else if ver == 2 {
                    [22050, 24000, 16000]
                } else {
                    [11025, 12000, 8000]
                };
                return Some((i, table[br_idx], rates[sr_idx]));
            }
        }
        i += 1;
    }
    None
}

fn mp3_audio_start(bytes: &[u8]) -> usize {
    if bytes.len() >= 10 && &bytes[0..3] == b"ID3" {
        let mut size = 0usize;
        for b in &bytes[6..10] {
            size = (size << 7) | ((*b as usize) & 0x7F);
        }
        (10 + size).min(bytes.len())
    } else {
        0
    }
}

/// 在线精听：优先只取目标时间附近的字节（MP3 CBR 可直接按码率换算），
/// 服务器不支持 Range 或格式不是 MP3 时，退回整集缓存。
#[tauri::command]
async fn remote_clip_transcribe(
    app: tauri::AppHandle,
    url: String,
    key: String,
    start_ms: i64,
    end_ms: i64,
    model: Option<String>,
) -> Result<serde_json::Value, String> {
    let id = model.unwrap_or_else(|| "en-mini".to_string());
    let model_path = model_dir_for(&id)?;
    if !model_path.join("tokens.txt").exists() {
        return Err(format!("模型「{id}」还没下载，请先在设置 → 模型管理里下载。"));
    }
    let model_dir = model_path.to_string_lossy().to_string();
    let start_s = (start_ms.max(0) as f64) / 1000.0;
    let end_s = ((end_ms.max(start_ms + 1500)) as f64) / 1000.0;
    let dir = clip_cache_dir()?.join("clips");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建片段缓存失败：{e}"))?;
    let stem = format!("{}-{}", safe_name(&key), start_ms.max(0));
    let frag = dir.join(format!("{stem}.mp3"));

    if frag.is_file() {
        let len = std::fs::metadata(&frag).map(|m| m.len()).unwrap_or(0) as usize;
        if len > 1024 {
            let mut frame = 1u32;
            if let Ok(prefix) = std::fs::read(&frag) {
                let audio_start = mp3_audio_start(&prefix);
                if let Some((_, br, _)) = mp3_frame_at(&prefix, audio_start) {
                    frame = br;
                }
            }
            let secs = (len as f64 / (frame as f64 * 1000.0 / 8.0)).min(86.0);
            let p = frag.to_string_lossy().to_string();
            let d = model_dir.clone();
            return tauri::async_runtime::spawn_blocking(move || {
                localasr::transcribe_clip(&p, 0.0, secs.max(3.0), &d)
            })
            .await
            .map_err(|e| format!("精听失败：{e}"))?;
        }
    }

    let prefix = http_long()
        .get(&url)
        .header("Range", "bytes=0-131071")
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;
    if prefix.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        let total = prefix
            .headers()
            .get("content-range")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit('/').next())
            .and_then(|v| v.trim().parse::<u64>().ok())
            .unwrap_or(0);
        if total > 0 {
            let bytes = prefix.bytes().await.map_err(|e| format!("读取音频头失败：{e}"))?;
            let audio_start = mp3_audio_start(&bytes);
            if let Some((pos, br, _rate)) = mp3_frame_at(&bytes, audio_start) {
                // Xing/Info 头说明是 VBR：按首帧码率算字节偏移会越走越偏，直接走整集兜底。
                let vbr = bytes[pos..(pos + 256).min(bytes.len())]
                    .windows(4)
                    .any(|w| w == b"Xing" || w == b"Info");
                if !vbr {
                let bps = br as f64 * 1000.0 / 8.0;
                let offset = pos as f64 + start_s * bps;
                let from = (offset as u64).saturating_sub((2.5 * bps) as u64).max(pos as u64);
                let span = ((end_s - start_s + 5.0) * bps) as u64 + 64 * 1024;
                let to = (from + span).min(total.saturating_sub(1));
                let res = http_long()
                    .get(&url)
                    .header("Range", format!("bytes={from}-{to}"))
                    .send()
                    .await
                    .map_err(|e| format!("取片段失败：{e}"))?;
                if res.status() == reqwest::StatusCode::PARTIAL_CONTENT {
                    let mut data = res.bytes().await.map_err(|e| format!("读取片段失败：{e}"))?.to_vec();
                    if let Some((sync, _, _)) = mp3_frame_at(&data, 0) {
                        data.drain(0..sync);
                        std::fs::write(&frag, &data).map_err(|e| format!("写片段失败：{e}"))?;
                        let secs = (data.len() as f64 / bps).clamp(3.0, 86.0);
                        let p = frag.to_string_lossy().to_string();
                        let d = model_dir.clone();
                        return tauri::async_runtime::spawn_blocking(move || {
                            localasr::transcribe_clip(&p, 0.0, secs, &d)
                        })
                        .await
                        .map_err(|e| format!("精听失败：{e}"))?;
                    }
                }
                }
            }
        }
    }

    // 兜底：整集缓存（支持非 MP3 / 服务器忽略 Range）。
    let path = clip_audio_cache(app, url, key).await?;
    tauri::async_runtime::spawn_blocking(move || {
        localasr::transcribe_clip(&path, start_s, end_s, &model_dir)
    })
    .await
    .map_err(|e| format!("精听失败：{e}"))?
}

const AUDIO_EXTS: [&str; 9] = ["mp3", "m4a", "mp4", "aac", "ogg", "oga", "opus", "wav", "flac"];
const TRANSCRIPT_SUFFIX: &str = ".transcript.json";
const SKIP_SUFFIX: &str = ".skip.json";

/// 整集下载时顺带把词级 JSON 落到同一目录。音频和文字稿分开存：
/// 音频可能几十 MB，文字稿几 MB，任一失败都不该拖垮另一个。
#[tauri::command]
async fn offline_save_transcript(
    app: tauri::AppHandle,
    url: String,
    key: String,
) -> Result<String, String> {
    let dir = offline_dir(&app)?;
    let stem = safe_name(&key);
    let path = dir.join(format!("{stem}{TRANSCRIPT_SUFFIX}"));
    if path.exists() {
        return Ok(path.to_string_lossy().to_string());
    }
    let res = http_long()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("文字稿请求失败：{e}"))?;
    if !res.status().is_success() {
        return Err(format!("文字稿返回 HTTP {}", res.status()));
    }
    let text = res
        .text()
        .await
        .map_err(|e| format!("读取文字稿失败：{e}"))?;
    // 校验一下再落盘：某些源会把登录页/HTML 当成 200 返回，存下来只会让播放页报错。
    let doc: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("文字稿不是有效 JSON：{e}"))?;
    if !doc.is_object() {
        return Err("文字稿 JSON 不是对象".to_string());
    }
    let tmp = dir.join(format!("{stem}.transcript.part"));
    if let Err(e) = std::fs::write(&tmp, text.as_bytes()) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("写文字稿失败：{e}"));
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("文字稿落盘失败：{e}"));
    }
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn offline_transcript_load(app: tauri::AppHandle, key: String) -> Result<String, String> {
    let dir = offline_dir(&app)?;
    let path = dir.join(format!("{}{}", safe_name(&key), TRANSCRIPT_SUFFIX));
    if !path.exists() {
        return Err("没有离线文字稿".to_string());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("读取离线文字稿失败：{e}"))
}

/// cue 级跳过标签：跟文字稿分开存，缺了不影响播放，只让「跳过」不可用。
#[tauri::command]
async fn offline_save_skip(app: tauri::AppHandle, url: String, key: String) -> Result<String, String> {
    let dir = offline_dir(&app)?;
    let stem = safe_name(&key);
    let path = dir.join(format!("{stem}{SKIP_SUFFIX}"));
    if path.exists() {
        return Ok(path.to_string_lossy().to_string());
    }
    let res = http_long()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("跳过标签请求失败：{e}"))?;
    if !res.status().is_success() {
        return Err(format!("跳过标签返回 HTTP {}", res.status()));
    }
    let text = res
        .text()
        .await
        .map_err(|e| format!("读取跳过标签失败：{e}"))?;
    let doc: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("跳过标签不是有效 JSON：{e}"))?;
    if !doc.is_object() {
        return Err("跳过标签 JSON 不是对象".to_string());
    }
    let tmp = dir.join(format!("{stem}.skip.part"));
    if let Err(e) = std::fs::write(&tmp, text.as_bytes()) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("写跳过标签失败：{e}"));
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("跳过标签落盘失败：{e}"));
    }
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn offline_skip_load(app: tauri::AppHandle, key: String) -> Result<String, String> {
    let dir = offline_dir(&app)?;
    let path = dir.join(format!("{}{}", safe_name(&key), SKIP_SUFFIX));
    if !path.exists() {
        return Err("没有离线跳过标签".to_string());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("读取离线跳过标签失败：{e}"))
}

#[tauri::command]
async fn offline_list(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let dir = offline_dir(&app)?;
    let mut out = Vec::new();
    let entries: Vec<std::fs::DirEntry> = std::fs::read_dir(&dir)
        .map(|rd| rd.flatten().collect())
        .unwrap_or_default();
    // 先扫文字稿与跳过标签，再扫音频，这样每个音频条目都能带上 hasTranscript / hasSkip。
    let mut transcripts: HashMap<String, u64> = HashMap::new();
    let mut skips: HashMap<String, u64> = HashMap::new();
    for entry in &entries {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if let Some(stem) = name.strip_suffix(TRANSCRIPT_SUFFIX) {
            transcripts.insert(stem.to_string(), size);
        } else if let Some(stem) = name.strip_suffix(SKIP_SUFFIX) {
            skips.insert(stem.to_string(), size);
        }
    }
    for entry in entries {
        let path = entry.path();
        let ok = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| AUDIO_EXTS.contains(&e.to_ascii_lowercase().as_str()))
            .unwrap_or(false);
        if !ok {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        let key = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let transcript_size = transcripts.get(&key).copied().unwrap_or(0);
        let skip_size = skips.get(&key).copied().unwrap_or(0);
        out.push(serde_json::json!({
            "key": key,
            "path": path.to_string_lossy(),
            "size": size,
            "hasTranscript": transcript_size > 0,
            "transcriptSize": transcript_size,
            "hasSkip": skip_size > 0,
            "skipSize": skip_size,
        }));
    }
    // read_dir 的顺序跟文件系统有关，会随增删变化；按 key 排一下，页面列表才稳定。
    out.sort_by(|a, b| {
        a.get("key")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .cmp(b.get("key").and_then(|v| v.as_str()).unwrap_or(""))
    });
    Ok(out)
}

#[tauri::command]
async fn offline_remove(app: tauri::AppHandle, key: String) -> Result<(), String> {
    let dir = offline_dir(&app)?;
    let stem = safe_name(&key);
    for ext in AUDIO_EXTS {
        let path = dir.join(format!("{stem}.{ext}"));
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("删除失败：{e}"))?;
        }
    }
    let transcript = dir.join(format!("{stem}{TRANSCRIPT_SUFFIX}"));
    if transcript.exists() {
        std::fs::remove_file(&transcript).map_err(|e| format!("删除文字稿失败：{e}"))?;
    }
    let skip = dir.join(format!("{stem}{SKIP_SUFFIX}"));
    if skip.exists() {
        std::fs::remove_file(&skip).map_err(|e| format!("删除跳过标签失败：{e}"))?;
    }
    Ok(())
}

/// 模型目录必须是纯 ASCII：
/// sherpa 内部用 std::ifstream 判「文件是否存在」，路径里有中文（比如用户名「游梦」）
/// 就会报 “tokens.txt does not exist”，识别器直接创建失败。
/// 所以固定放进 ProgramData（全平台都是 ASCII 路径），历史版本放在 app_data 里的
/// 模型顺手搬过来，别让用户再下一次 41 MB。
fn models_root() -> Result<std::path::PathBuf, String> {
    let program_data = std::env::var("ProgramData")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("C:\\ProgramData"));
    let root = program_data.join("MyTranscript").join("models");
    if !root.to_string_lossy().is_ascii() {
        return Err(format!("模型目录路径含非 ASCII 字符：{}", root.display()));
    }
    std::fs::create_dir_all(&root).map_err(|e| format!("创建模型目录失败：{e}"))?;
    Ok(root)
}

fn spec_by_id(id: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|spec| spec.id == id)
}

fn model_dir_for(id: &str) -> Result<std::path::PathBuf, String> {
    let root = models_root()?;
    let dir = root.join(id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建模型目录失败：{e}"))?;
    Ok(dir)
}

fn dir_bytes(dir: &std::path::Path) -> u64 {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|entry| entry.metadata().ok())
                .filter(|meta| meta.is_file())
                .map(|meta| meta.len())
                .sum()
        })
        .unwrap_or(0)
}

fn installed(dir: &std::path::Path) -> bool {
    let nonempty = |name: &str| {
        std::fs::metadata(dir.join(name))
            .map(|meta| meta.len() > 0)
            .unwrap_or(false)
    };
    nonempty("encoder.onnx") && nonempty("decoder.onnx") && nonempty("tokens.txt")
}

/// 老版本的模型放在 `sherpa-en-20M`（文件名是 epoch 原名），新版统一进
/// `models/<id>/` 并重命名成 encoder.decoder.joiner.onnx。这里做一次性搬迁，
/// 让已经下过 41 MB 的用户不用再下一遍。
fn migrate_legacy(app: &tauri::AppHandle) {
    let Ok(root) = models_root() else { return };
    let dir = root.join("en-mini");
    let _ = std::fs::create_dir_all(&dir);
    if installed(&dir) {
        return;
    }
    let mut sources: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(program_data) = std::env::var("ProgramData") {
        sources.push(
            std::path::PathBuf::from(program_data)
                .join("MyTranscript")
                .join("sherpa-en-20M"),
        );
    }
    if let Ok(old) = app.path().app_data_dir() {
        sources.push(old.join("sherpa-en-20M"));
    }
    for src in sources {
        for (remote, local) in spec_by_id("en-mini").map(|s| s.files).unwrap_or(&[]) {
            let dst = dir.join(local);
            let from = src.join(remote);
            if !dst.exists() && from.exists() {
                let _ = std::fs::copy(&from, &dst);
            }
        }
    }
    if installed(&dir) {
        let _ = write_model_json(&dir, "en-mini", "英文 · 迷你", "transducer");
    }
}

fn write_model_json(
    dir: &std::path::Path,
    id: &str,
    name: &str,
    kind: &str,
) -> Result<(), String> {
    let manifest = serde_json::json!({
        "id": id,
        "name": name,
        "type": kind,
        "files": { "encoder": "encoder.onnx", "decoder": "decoder.onnx", "joiner": "joiner.onnx" },
    });
    std::fs::write(dir.join("model.json"), manifest.to_string())
        .map_err(|e| format!("写模型清单失败：{e}"))
}

/// 缺哪个下哪个，边下边把进度 emit 给设置页。
/// 支持断点续传（`.part` 留着，下次带 Range 接着下）与取消（页面塞进 `asr_cancel`）。
async fn download_model_file(
    app: &tauri::AppHandle,
    state: &AppState,
    client: &reqwest::Client,
    spec: &ModelSpec,
    remote: &str,
    local: &str,
    dest: &std::path::Path,
) -> Result<(), String> {
    use std::io::Write;
    let tmp = dest.with_file_name(format!("{local}.part"));
    let cancelled = |state: &AppState| {
        state
            .asr_cancel
            .lock()
            .map(|set| set.contains(spec.id))
            .unwrap_or(false)
    };
    let mut last = String::from("未知错误");
    for mirror in MODEL_MIRRORS {
        if cancelled(state) {
            let _ = app.emit(
                "myt://asr-model",
                serde_json::json!({ "id": spec.id, "name": spec.name, "cancelled": true }),
            );
            return Err("已取消下载".to_string());
        }
        let url = format!("{mirror}{}/resolve/main/{remote}", spec.repo);
        let resume = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
        let mut req = client.get(&url);
        if resume > 0 {
            req = req.header(reqwest::header::RANGE, format!("bytes={resume}-"));
        }
        // 镜像有时连上了却迟迟不回响应头；60 秒拿不到就换下一个源，别整页干等。
        let res = match tokio::time::timeout(Duration::from_secs(60), req.send()).await {
            Err(_) => {
                last = "响应超时".to_string();
                continue;
            }
            Ok(Ok(res)) if res.status().is_success() => res,
            Ok(Ok(res)) => {
                last = format!("HTTP {}", res.status());
                continue;
            }
            Ok(Err(e)) => {
                last = format!("连接失败：{e}");
                continue;
            }
        };
        // 服务器认 Range 才续传；回 200 说明它把整个文件重新发了，只能从头写。
        let resuming = resume > 0 && res.status() == reqwest::StatusCode::PARTIAL_CONTENT;
        let start_at = if resuming { resume } else { 0 };
        let total = res.content_length().map(|len| len + start_at);
        let mut file = match if resuming {
            std::fs::OpenOptions::new().append(true).open(&tmp)
        } else {
            std::fs::File::create(&tmp)
        } {
            Ok(f) => f,
            Err(e) => return Err(format!("写模型文件失败：{e}")),
        };
        let mut res = res;
        let mut got: u64 = start_at;
        let mut last_pct: u64 = u64::MAX;
        let mut failed: Option<String> = None;
        loop {
            if cancelled(state) {
                drop(file);
                let _ = app.emit(
                    "myt://asr-model",
                    serde_json::json!({
                        "id": spec.id, "name": spec.name, "file": local,
                        "cancelled": true, "got": got, "total": total,
                    }),
                );
                return Err("已取消下载".to_string());
            }
            // 镜像偶尔会卡住几十秒；给每个分块 3 分钟上限，真断了自己失败退出，
            // 别让设置页一直停在「下载中」等 30 分钟总额超时。
            match tokio::time::timeout(Duration::from_secs(180), res.chunk()).await {
                Err(_) => {
                    failed = Some("读取超时（断点已保留）".to_string());
                    break;
                }
                Ok(Ok(Some(chunk))) => {
                    if let Err(e) = file.write_all(&chunk) {
                        let _ = std::fs::remove_file(&tmp);
                        return Err(format!("写模型文件失败：{e}"));
                    }
                    got += chunk.len() as u64;
                    if let Some(total) = total.filter(|t| *t > 0) {
                        let pct = (got.saturating_mul(100) / total).min(100);
                        if pct != last_pct {
                            last_pct = pct;
                            let _ = app.emit(
                                "myt://asr-model",
                                serde_json::json!({
                                    "id": spec.id, "name": spec.name, "file": local,
                                    "pct": pct, "got": got, "total": total, "resumed": resuming,
                                }),
                            );
                        }
                    }
                }
                Ok(Ok(None)) => break,
                Ok(Err(e)) => {
                    failed = Some(format!("读取失败：{e}"));
                    break;
                }
            }
        }
        drop(file);
        if let Some(reason) = failed {
            // 保留 .part，下次进来能从断点接着下。
            last = reason;
            continue;
        }
        if got > 0 && tmp.exists() {
            let meta = std::fs::metadata(&tmp).map_err(|e| format!("校验模型文件失败：{e}"))?;
            let complete = match total {
                Some(total) => meta.len() == total,
                None => meta.len() == got,
            };
            if !complete {
                last = "模型文件下载不完整（保留断点，可重试）".to_string();
                continue;
            }
            std::fs::rename(&tmp, dest).map_err(|e| format!("保存模型文件失败：{e}"))?;
            return Ok(());
        }
        let _ = std::fs::remove_file(&tmp);
        last = "下载到空文件".to_string();
    }
    Err(format!("下载模型 {remote} 失败（{last}）"))
}

/// 列出内置模型与导入模型的安装状态。
/// 首次启动会搬老目录里的 41 MB 模型——这个拷贝放进阻塞线程池，别卡住设置页/主线程。
#[tauri::command]
async fn asr_models(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || list_models(&app))
        .await
        .map_err(|e| format!("读取模型列表失败：{e}"))?
}

fn list_models(app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
    migrate_legacy(app);
    let root = models_root()?;
    let mut items: Vec<serde_json::Value> = Vec::new();
    for spec in MODELS.iter() {
        let dir = root.join(spec.id);
        items.push(serde_json::json!({
            "id": spec.id, "name": spec.name, "lang": spec.lang, "desc": spec.desc,
            "custom": false, "installed": installed(&dir),
            "bytes": dir_bytes(&dir), "part": part_bytes(&dir),
        }));
    }
    let known: Vec<&str> = MODELS.iter().map(|spec| spec.id).collect();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().to_string();
            if known.contains(&id.as_str()) {
                continue;
            }
            let manifest = std::fs::read_to_string(dir.join("model.json")).unwrap_or_default();
            let parsed: serde_json::Value =
                serde_json::from_str(&manifest).unwrap_or(serde_json::Value::Null);
            if parsed.is_null() {
                continue;
            }
            let name = parsed
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or(&id)
                .to_string();
            items.push(serde_json::json!({
                "id": id, "name": name, "lang": "custom",
                "desc": "本地导入", "custom": true,
                "installed": installed(&dir),
                "bytes": dir_bytes(&dir), "part": part_bytes(&dir),
            }));
        }
    }
    Ok(serde_json::Value::Array(items))
}

/// 没下完的 `.part` 总字节：告诉页面「已有 X MB，可续传」。
fn part_bytes(dir: &std::path::Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if name.ends_with(".part") {
                total += entry.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    total
}

/// 准备模型目录：缺哪个下哪个，下完返回绝对路径。第二次进来直接返回缓存。
#[tauri::command]
async fn asr_prepare(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    model: Option<String>,
) -> Result<String, String> {
    let id = model.unwrap_or_else(|| "en-mini".to_string());
    let spec = spec_by_id(&id).ok_or_else(|| format!("未知模型：{id}"))?;
    // 新的一次下载把上一次的「取消」清掉，否则刚重试就立刻被取消。
    if let Ok(mut set) = state.asr_cancel.lock() {
        set.remove(spec.id);
    }
    // 老目录迁移可能要拷几十 MB，放阻塞线程池里做。
    {
        let app = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || migrate_legacy(&app)).await;
    }
    let dir = model_dir_for(spec.id)?;
    let client = http_long();
    for (remote, local) in spec.files {
        let path = dir.join(local);
        let ok = std::fs::metadata(&path).map(|m| m.len() > 0).unwrap_or(false);
        if ok {
            continue;
        }
        download_model_file(&app, &state, &client, spec, remote, local, &path).await?;
    }
    write_model_json(&dir, spec.id, spec.name, "transducer")?;
    let _ = app.emit(
        "myt://asr-model",
        serde_json::json!({ "id": spec.id, "name": spec.name, "done": true }),
    );
    Ok(dir.to_string_lossy().to_string())
}

/// 取消正在进行的模型下载：保留 `.part`，下次点下载会从断点续传。
#[tauri::command]
fn asr_cancel(state: State<'_, AppState>, model: String) -> Result<(), String> {
    if model.is_empty() {
        return Err("缺少模型标识".to_string());
    }
    state
        .asr_cancel
        .lock()
        .map_err(|_| "锁失败".to_string())?
        .insert(model);
    Ok(())
}

/// 在资源管理器里打开模型目录，方便用户备份/清理。
#[tauri::command]
fn asr_open_dir(model: String) -> Result<(), String> {
    if model.is_empty()
        || !model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("非法的模型标识：{model}"));
    }
    let root = models_root()?;
    let dir = root.join(&model);
    if !dir.starts_with(&root) || !dir.is_dir() {
        return Err(format!("模型不存在：{model}"));
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("打开目录失败：{e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = dir;
        Err("打开目录只在桌面版可用".to_string())
    }
}

/// 删除一个模型目录。是否「正在使用」由页面拦（壳里不存选择状态）。
#[tauri::command]
fn asr_remove(app: tauri::AppHandle, model: String) -> Result<(), String> {
    if model.is_empty()
        || !model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("非法的模型标识：{model}"));
    }
    let root = models_root()?;
    let dir = root.join(&model);
    if !dir.starts_with(&root) || !dir.is_dir() {
        return Err(format!("模型不存在：{model}"));
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("删除模型失败：{e}"))?;
    let _ = app.emit(
        "myt://asr-model",
        serde_json::json!({ "id": model, "removed": true }),
    );
    Ok(())
}

fn slugify(name: &str) -> String {
    let mut out = String::new();
    for ch in name.chars().take(24) {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            out.push(lower);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "imported".to_string()
    } else {
        trimmed
    }
}

/// 导入本地模型文件夹：把 encoder/decoder/joiner/tokens 复制进 ASCII 目录，
/// 原目录可以随便放（中文路径也行），识别只认复制后的这一份。
#[tauri::command]
fn asr_import(app: tauri::AppHandle, path: String) -> Result<serde_json::Value, String> {
    use std::path::Path;
    let src = Path::new(&path);
    if !src.is_dir() {
        return Err(format!("不是文件夹：{path}"));
    }
    let tokens = src.join("tokens.txt");
    if !tokens.is_file() {
        return Err("文件夹里没有 tokens.txt，这不像 sherpa-onnx 模型".to_string());
    }
    let mut found: Vec<(String, String)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(src) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.to_ascii_lowercase().ends_with(".onnx") {
                continue;
            }
            let lower = name.to_ascii_lowercase();
            let slot = if lower.contains("encoder") {
                "encoder"
            } else if lower.contains("decoder") {
                "decoder"
            } else if lower.contains("joiner") {
                "joiner"
            } else {
                continue;
            };
            let int8 = lower.contains(".int8.");
            match found.iter().position(|(existing, _)| existing == slot) {
                Some(index) => {
                    let current_int8 = found[index].1.to_ascii_lowercase().contains(".int8.");
                    if int8 && !current_int8 {
                        found[index] = (slot.to_string(), name);
                    }
                }
                None => found.push((slot.to_string(), name)),
            }
        }
    }
    let encoder = found
        .iter()
        .find(|(slot, _)| slot == "encoder")
        .map(|(_, name)| name.clone())
        .ok_or("文件夹里没有 encoder*.onnx")?;
    let decoder = found
        .iter()
        .find(|(slot, _)| slot == "decoder")
        .map(|(_, name)| name.clone())
        .ok_or("文件夹里没有 decoder*.onnx")?;
    let joiner = found
        .iter()
        .find(|(slot, _)| slot == "joiner")
        .map(|(_, name)| name.clone());
    let folder = src
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "imported".to_string());
    let root = models_root()?;
    let base = slugify(&folder);
    let mut id = base.clone();
    let mut n = 2;
    while root.join(&id).exists() {
        id = format!("{base}-{n}");
        n += 1;
    }
    let dest = root.join(&id);
    std::fs::create_dir_all(&dest).map_err(|e| format!("创建模型目录失败：{e}"))?;
    let total: u64 = [Some(encoder.clone()), Some(decoder.clone()), joiner.clone(), Some("tokens.txt".to_string())]
        .iter()
        .flatten()
        .filter_map(|name| std::fs::metadata(src.join(name)).ok())
        .map(|meta| meta.len())
        .sum();
    let _ = app.emit(
        "myt://asr-model",
        serde_json::json!({ "id": id, "name": folder, "importing": true, "total": total }),
    );
    let copy = |from: &str, to: &str| -> Result<(), String> {
        std::fs::copy(src.join(from), dest.join(to))
            .map(|_| ())
            .map_err(|e| format!("复制 {from} 失败：{e}"))
    };
    copy(&encoder, "encoder.onnx")?;
    copy(&decoder, "decoder.onnx")?;
    if let Some(joiner) = &joiner {
        copy(joiner, "joiner.onnx")?;
    }
    copy("tokens.txt", "tokens.txt")?;
    let kind = if joiner.is_some() {
        "transducer"
    } else {
        "paraformer"
    };
    write_model_json(&dest, &id, &folder, kind)?;
    let _ = app.emit(
        "myt://asr-model",
        serde_json::json!({ "id": id, "name": folder, "done": true }),
    );
    Ok(serde_json::json!({ "id": id, "name": folder, "kind": kind }))
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
    if !subtitles_plugin_enabled() {
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

fn plugins_root() -> Result<std::path::PathBuf, String> {
    let program_data = std::env::var("ProgramData")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("C:\\ProgramData"));
    let root = program_data.join("MyTranscript").join("plugins");
    std::fs::create_dir_all(&root).map_err(|e| format!("创建插件目录失败：{e}"))?;
    Ok(root)
}

fn plugin_enabled_path(root: &std::path::Path) -> std::path::PathBuf {
    root.join("enabled.json")
}

fn read_plugin_enabled(root: &std::path::Path) -> HashMap<String, bool> {
    std::fs::read_to_string(plugin_enabled_path(root))
        .ok()
        .and_then(|text| serde_json::from_str::<HashMap<String, bool>>(&text).ok())
        .unwrap_or_default()
}

fn write_plugin_enabled(root: &std::path::Path, state: &HashMap<String, bool>) -> Result<(), String> {
    let text = serde_json::to_string_pretty(state).map_err(|e| format!("序列化插件状态失败：{e}"))?;
    std::fs::write(plugin_enabled_path(root), text).map_err(|e| format!("写插件状态失败：{e}"))
}

fn safe_plugin_id(id: &str) -> bool {
    !id.is_empty()
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn safe_plugin_file(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && name != "."
        && name != ".."
}

/// 随应用发布的插件。用户目录不存在时铺一份；已有文件绝不覆盖，
/// 这样用户可以自由改 main.js / style.css，升级也不会把手改内容冲掉。
fn seed_builtin_plugin(name: &str, files: &[(&str, &str)]) -> Result<(), String> {
    let root = plugins_root()?;
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建内置插件 {name} 失败：{e}"))?;
    for (file, content) in files {
        let path = dir.join(file);
        if !path.exists() {
            std::fs::write(&path, content)
                .map_err(|e| format!("写入内置插件 {name}/{file} 失败：{e}"))?;
        }
    }
    Ok(())
}

fn ensure_builtin_plugins() -> Result<(), String> {
    seed_builtin_plugin(
        "subtitles",
        &[
            ("plugin.json", include_str!("../../builtin-plugins/subtitles/plugin.json")),
            ("kernel.js", include_str!("../../builtin-plugins/subtitles/kernel.js")),
            ("view.js", include_str!("../../builtin-plugins/subtitles/view.js")),
            ("main.js", include_str!("../../builtin-plugins/subtitles/main.js")),
            ("style.css", include_str!("../../builtin-plugins/subtitles/style.css")),
        ],
    )?;
    seed_builtin_plugin(
        "study",
        &[
            ("plugin.json", include_str!("../../builtin-plugins/study/plugin.json")),
            ("main.js", include_str!("../../builtin-plugins/study/main.js")),
            ("style.css", include_str!("../../builtin-plugins/study/style.css")),
        ],
    )?;
    Ok(())
}


/// 读取插件是否启用：以 enabled.json 为准，没有记录时用 manifest 的默认值。
fn plugin_enabled_by_id(root: &std::path::Path, id: &str) -> bool {
    let enabled = read_plugin_enabled(root);
    if let Some(value) = enabled.get(id) {
        return *value;
    }
    let entries: Vec<std::fs::DirEntry> = std::fs::read_dir(root)
        .map(|rd| rd.flatten().collect())
        .unwrap_or_default();
    for entry in entries {
        let manifest = std::fs::read_to_string(entry.path().join("plugin.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
        if manifest
            .as_ref()
            .and_then(|v| v.get("id"))
            .and_then(|v| v.as_str())
            == Some(id)
        {
            return manifest
                .as_ref()
                .and_then(|v| v.get("enabled"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
        }
    }
    false
}

fn subtitles_plugin_enabled() -> bool {
    plugins_root()
        .map(|root| plugin_enabled_by_id(&root, "subtitles"))
        .unwrap_or(false)
}

/// 扫描插件目录。插件是一个子目录：`plugin.json` + 入口 JS + 可选 CSS。
/// 启用状态写在 `plugins/enabled.json`，不污染用户自己的清单。
#[tauri::command]
fn plugin_list() -> Result<Vec<serde_json::Value>, String> {
    let root = plugins_root()?;
    let enabled_map = read_plugin_enabled(&root);
    let entries: Vec<std::fs::DirEntry> = std::fs::read_dir(&root)
        .map(|rd| rd.flatten().collect())
        .unwrap_or_default();
    let mut out = Vec::new();
    for entry in entries {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().to_string();
        let manifest_path = dir.join("plugin.json");
        let mut error = String::new();
        let manifest: serde_json::Value = if manifest_path.exists() {
            match std::fs::read_to_string(&manifest_path)
                .map_err(|e| e.to_string())
                .and_then(|text| serde_json::from_str(&text).map_err(|e| e.to_string()))
            {
                Ok(value) => value,
                Err(e) => {
                    error = format!("plugin.json 解析失败：{e}");
                    serde_json::json!({})
                }
            }
        } else {
            error = "缺少 plugin.json".to_string();
            serde_json::json!({})
        };
        let id = manifest
            .get("id")
            .and_then(|v| v.as_str())
            .filter(|v| safe_plugin_id(v))
            .unwrap_or(&dir_name)
            .to_string();
        if !safe_plugin_id(&id) {
            out.push(serde_json::json!({
                "id": dir_name,
                "name": dir_name,
                "version": "",
                "description": "",
                "author": "",
                "enabled": false,
                "dir": dir.to_string_lossy(),
                "error": "插件 id 只能包含字母、数字、- 和 _",
            }));
            continue;
        }
        let enabled = enabled_map
            .get(&id)
            .copied()
            .unwrap_or_else(|| manifest.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false));
        let main_name = manifest.get("main").and_then(|v| v.as_str()).unwrap_or("main.js");
        let css_name = manifest.get("style").and_then(|v| v.as_str()).unwrap_or("style.css");
        let script_names: Vec<String> = manifest
            .get("scripts")
            .and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|v| v.as_str())
                    .map(|v| v.to_string())
                    .collect()
            })
            .unwrap_or_default();
        let mut js = String::new();
        let mut css = String::new();
        if !safe_plugin_file(main_name)
            || !safe_plugin_file(css_name)
            || script_names.iter().any(|name| !safe_plugin_file(name))
        {
            if error.is_empty() {
                error = "main/style/scripts 只能是插件目录内的文件名".to_string();
            }
        } else if enabled {
            // scripts 先加载、main 最后加载：插件可以把解析/渲染内核拆成多个文件，
            // 入口仍然只有一个 register 调用。
            for name in script_names.iter().filter(|name| name.as_str() != main_name) {
                match std::fs::read_to_string(dir.join(name)) {
                    Ok(text) => {
                        js.push_str(&text);
                        js.push_str("\n;\n");
                    }
                    Err(e) => {
                        if error.is_empty() {
                            error = format!("读取 {name} 失败：{e}");
                        }
                    }
                }
            }
            match std::fs::read_to_string(dir.join(main_name)) {
                Ok(text) => {
                    js.push_str(&text);
                }
                Err(e) => {
                    if error.is_empty() {
                        error = format!("读取 {main_name} 失败：{e}");
                    }
                }
            }
            if dir.join(css_name).exists() {
                css = std::fs::read_to_string(dir.join(css_name)).unwrap_or_default();
            }
        }
        out.push(serde_json::json!({
            "id": id,
            "name": manifest.get("name").and_then(|v| v.as_str()).unwrap_or(&dir_name),
            "version": manifest.get("version").and_then(|v| v.as_str()).unwrap_or(""),
            "description": manifest.get("description").and_then(|v| v.as_str()).unwrap_or(""),
            "author": manifest.get("author").and_then(|v| v.as_str()).unwrap_or(""),
            "enabled": enabled,
            "requires": manifest.get("requires").cloned().unwrap_or_else(|| serde_json::json!([])),
            "scripts": script_names,
            "dir": dir.to_string_lossy(),
            "main": main_name,
            "style": css_name,
            "js": js,
            "css": css,
            "error": error,
        }));
    }
    out.sort_by(|a, b| {
        a.get("name").and_then(|v| v.as_str()).unwrap_or("")
            .to_lowercase()
            .cmp(&b.get("name").and_then(|v| v.as_str()).unwrap_or("").to_lowercase())
    });
    Ok(out)
}

#[tauri::command]
fn plugin_set_enabled(app: tauri::AppHandle, id: String, enabled: bool) -> Result<(), String> {
    if !safe_plugin_id(&id) {
        return Err(format!("非法的插件 id：{id}"));
    }
    let root = plugins_root()?;
    if !root.join(&id).is_dir() {
        // id 可能取自 manifest，与目录名不同；至少确认有某个目录声明了这个 id。
        let entries: Vec<std::fs::DirEntry> = std::fs::read_dir(&root)
            .map(|rd| rd.flatten().collect())
            .unwrap_or_default();
        let found = entries.iter().any(|entry| {
            std::fs::read_to_string(entry.path().join("plugin.json"))
                .ok()
                .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
                .and_then(|value| value.get("id").and_then(|v| v.as_str()).map(|v| v == id))
                .unwrap_or(false)
        });
        if !found {
            return Err(format!("插件不存在：{id}"));
        }
    }
    let mut state = read_plugin_enabled(&root);
    state.insert(id.clone(), enabled);
    write_plugin_enabled(&root, &state)?;
    if id == "subtitles" && !enabled {
        // 停用字幕插件就把正在跑的全局字幕一起收掉，避免刷新前还留一个悬浮层。
        let app_state = app.state::<AppState>();
        let session = app_state
            .captions
            .lock()
            .map_err(|_| "锁失败".to_string())?
            .take();
        if let Some(mut session) = session {
            session.stop();
            if let Some(window) = app.get_webview_window("captions") {
                let _ = window.close();
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn plugin_open_dir() -> Result<(), String> {
    let root = plugins_root()?;
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&root)
            .spawn()
            .map_err(|e| format!("打开插件目录失败：{e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = root;
        Err("打开插件目录只在桌面版可用".to_string())
    }
}

/// 写一个可直接改的示例插件，降低第一次上手的门槛。
#[tauri::command]
fn plugin_example() -> Result<String, String> {
    let root = plugins_root()?;
    let dir = root.join("hello-world");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建插件目录失败：{e}"))?;
    if dir.join("plugin.json").exists() {
        return Ok(dir.to_string_lossy().to_string());
    }
    let manifest = serde_json::json!({
        "id": "hello-world",
        "name": "Hello World",
        "version": "0.1.0",
        "description": "插件接口示例：注册一个页面、监听播放事件。",
        "author": "you",
        "enabled": true,
        "main": "main.js",
        "style": "style.css"
    });
    std::fs::write(
        dir.join("plugin.json"),
        serde_json::to_string_pretty(&manifest).unwrap_or_default(),
    )
    .map_err(|e| format!("写 plugin.json 失败：{e}"))?;
    let main = r#"// 每个插件只需调用一次 MyTPlugins.register。
MyTPlugins.register('hello-world', {
  setup(api) {
    // 注册一个侧栏页面：路由是 #/plugin/hello-world/hello
    api.page('hello', {
      title: '插件示例',
      render(el) {
        el.innerHTML = '<div class="hello-card">'
          + '<h3>Hello, plugin!</h3>'
          + '<p>这个页面、样式和下面的按钮都来自插件目录里的 hello-world。</p>'
          + '<button class="btn primary" id="hello-toast">点我弹一条消息</button>'
          + '</div>';
        el.querySelector('#hello-toast').onclick = () => api.toast('插件按钮被点了。');
      },
    });

    // 播放器事件；插件可以直接读 DOM，也可以用 api.player 里的快捷方法。
    api.on('player:play', p => {
      console.log('[hello-world] play', p.title, p.time);
    });
  },
});
"#;
    std::fs::write(dir.join("main.js"), main).map_err(|e| format!("写 main.js 失败：{e}"))?;
    std::fs::write(
        dir.join("style.css"),
        ".hello-card{padding:18px 20px;border:1px solid var(--line);border-radius:12px;background:var(--panel2)}\n\
.hello-card h3{margin:0 0 8px;font:600 16px/1.4 var(--sans);color:var(--bright)}\n\
.hello-card p{margin:0 0 14px;font:12.5px/1.7 var(--sans);color:var(--muted)}\n",
    )
    .map_err(|e| format!("写 style.css 失败：{e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
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
            // 内置插件：首次运行铺到插件目录，默认启用；停用后对应功能整体下线。
            if let Err(e) = ensure_builtin_plugins() {
                eprintln!("内置插件初始化失败：{e}");
            }
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
            offline_save,
            clip_audio_cache,
            remote_clip_transcribe,
            offline_save_transcript,
            offline_transcript_load,
            offline_save_skip,
            offline_skip_load,
            offline_list,
            offline_remove,
            plugin_list,
            plugin_set_enabled,
            plugin_open_dir,
            plugin_example,
            asr_prepare,
            asr_models,
            asr_remove,
            asr_import,
            asr_cancel,
            asr_open_dir,
            asr_open,
            asr_feed,
            asr_result,
            asr_reset,
            asr_close,
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
            dbg_note
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
