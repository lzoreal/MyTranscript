//! 识别模型：清单、下载（多镜像 + 断点分块）、安装目录、导入与删除、模型状态列表。
//! 模型本体不进仓库，这里只负责按清单拼 URL 并落到 ProgramData。

use std::time::Duration;

use tauri::{Manager, State};

use tauri::Emitter;

use crate::{asr, http_long, AppState};

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


pub fn models_root() -> Result<std::path::PathBuf, String> {
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

pub(crate) fn model_dir_for(id: &str) -> Result<std::path::PathBuf, String> {
    let root = models_root()?;
    let dir = root.join(id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建模型目录失败：{e}"))?;
    Ok(dir)
}

pub fn dir_bytes(dir: &std::path::Path) -> u64 {
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

pub fn installed(dir: &std::path::Path) -> bool {
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
pub fn migrate_legacy(app: &tauri::AppHandle) {
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

pub fn write_model_json(
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
pub async fn asr_models(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || list_models(&app))
        .await
        .map_err(|e| format!("读取模型列表失败：{e}"))?
}

pub fn list_models(app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
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
pub fn part_bytes(dir: &std::path::Path) -> u64 {
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
pub async fn asr_prepare(
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
pub fn asr_cancel(state: State<'_, AppState>, model: String) -> Result<(), String> {
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
pub fn asr_open_dir(model: String) -> Result<(), String> {
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
pub fn asr_remove(app: tauri::AppHandle, model: String) -> Result<(), String> {
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

pub fn slugify(name: &str) -> String {
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
pub fn asr_import(app: tauri::AppHandle, path: String) -> Result<serde_json::Value, String> {
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
pub fn asr_open(state: State<AppState>, model_dir: String, threads: u32) -> Result<u32, String> {
    let engine = asr::Asr::new(&model_dir, threads as i32)?;
    let mut next = state.next_id.lock().map_err(|_| "锁失败")?;
    *next += 1;
    let id = *next;
    state.engines.lock().map_err(|_| "锁失败")?.insert(id, engine);
    Ok(id)
}

#[tauri::command]
pub fn asr_feed(
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
pub fn asr_result(state: State<AppState>, id: u32) -> Result<String, String> {
    let engines = state.engines.lock().map_err(|_| "锁失败")?;
    let engine = engines.get(&id).ok_or("识别器已关闭")?;
    engine.result()
}

#[tauri::command]
pub fn asr_reset(state: State<AppState>, id: u32) -> Result<(), String> {
    let engines = state.engines.lock().map_err(|_| "锁失败")?;
    if let Some(engine) = engines.get(&id) {
        engine.reset();
    }
    Ok(())
}

#[tauri::command]
pub fn asr_close(state: State<AppState>, id: u32) -> Result<(), String> {
    state.engines.lock().map_err(|_| "锁失败")?.remove(&id);
    Ok(())
}
