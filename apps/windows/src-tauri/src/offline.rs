//! 离线下载：整集音频落盘、片段缓存、文字稿/跳过点旁挂文件、目录列表与删除。
//! 这里只碰文件系统和 http 客户端，不持有窗口状态。

use std::collections::HashMap;

use tauri::{Emitter, Manager};

use crate::{asr, http_long, localasr, model_dir_for};

pub fn offline_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("定位数据目录失败：{e}"))?;
    let dir = base.join("offline");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建离线目录失败：{e}"))?;
    Ok(dir)
}

/// 只留 ASCII 字母数字和 - _，避免中文/表情进入文件名（Windows 上还要躲非法字符）。
pub fn safe_name(raw: &str) -> String {
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
pub fn ext_from_url(url: &str) -> Option<&'static str> {
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

pub fn ext_from_ctype(ct: &str) -> Option<&'static str> {
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
pub async fn download_stream(
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
pub async fn offline_save(
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
pub fn clip_cache_dir() -> Result<std::path::PathBuf, String> {
    let program_data = std::env::var("ProgramData")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("C:\\ProgramData"));
    let dir = program_data.join("MyTranscript").join("cache").join("audio");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建精听缓存目录失败：{e}"))?;
    Ok(dir)
}

/// 在线单集首次精听时把整集音频拉到缓存；已缓存就直接返回路径。
#[tauri::command]
pub async fn clip_audio_cache(
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
pub fn mp3_frame_at(bytes: &[u8], from: usize) -> Option<(usize, u32, u32)> {
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

pub fn mp3_audio_start(bytes: &[u8]) -> usize {
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
pub async fn remote_clip_transcribe(
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
pub async fn offline_save_transcript(
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
pub async fn offline_transcript_load(app: tauri::AppHandle, key: String) -> Result<String, String> {
    let dir = offline_dir(&app)?;
    let path = dir.join(format!("{}{}", safe_name(&key), TRANSCRIPT_SUFFIX));
    if !path.exists() {
        return Err("没有离线文字稿".to_string());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("读取离线文字稿失败：{e}"))
}

/// cue 级跳过标签：跟文字稿分开存，缺了不影响播放，只让「跳过」不可用。
#[tauri::command]
pub async fn offline_save_skip(app: tauri::AppHandle, url: String, key: String) -> Result<String, String> {
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
pub async fn offline_skip_load(app: tauri::AppHandle, key: String) -> Result<String, String> {
    let dir = offline_dir(&app)?;
    let path = dir.join(format!("{}{}", safe_name(&key), SKIP_SUFFIX));
    if !path.exists() {
        return Err("没有离线跳过标签".to_string());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("读取离线跳过标签失败：{e}"))
}

#[tauri::command]
pub async fn offline_list(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
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
pub async fn offline_remove(app: tauri::AppHandle, key: String) -> Result<(), String> {
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
