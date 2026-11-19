//! 本地音频整集预转写：symphonia 解码 → sherpa 流式识别 → 词级 JSON。
//!
//! 产物写在音频旁边：`<音频文件名>.transcript.json`，格式与站点导出的
//! `segments[].start/end/text/words` 一致，播放页可以直接当文字稿读。
//! 一次只跑一个任务；进度通过 `myt://localasr` 事件推给页面。

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tauri::{AppHandle, Emitter};

use crate::asr::Asr;

#[derive(Clone, Default)]
struct JobState {
    running: bool,
    phase: String,
    pct: f32,
    seconds: f64,
    total: f64,
    error: Option<String>,
    doc: Option<String>,
    path: String,
}

fn state() -> &'static Mutex<JobState> {
    static S: OnceLock<Mutex<JobState>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(JobState::default()))
}

fn cancel_flag() -> &'static AtomicBool {
    static C: OnceLock<AtomicBool> = OnceLock::new();
    C.get_or_init(|| AtomicBool::new(false))
}

fn trace(msg: &str) {
    if std::env::var("MT_TRACE").is_err() {
        return;
    }
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("C:\\tmp\\localasr-decode.log")
    {
        let _ = writeln!(f, "{msg}");
    }
}

fn emit(app: &AppHandle, st: &JobState) {    let _ = app.emit(
        "myt://localasr",
        json!({
            "path": st.path,
            "running": st.running,
            "phase": st.phase,
            "pct": st.pct,
            "seconds": st.seconds,
            "total": st.total,
            "error": st.error,
            "doc": st.doc,
        }),
    );
}

fn set(app: &AppHandle, f: impl FnOnce(&mut JobState)) {
    let mut guard = state().lock().unwrap_or_else(|e| e.into_inner());
    f(&mut guard);
    let snapshot = guard.clone();
    drop(guard);
    emit(app, &snapshot);
}

pub fn doc_path(audio: &str) -> PathBuf {
    PathBuf::from(format!("{audio}.transcript.json"))
}

/// 启动整集转写；立即返回，进度与结果走事件。
pub fn start(app: AppHandle, audio_path: String, model_dir: String) -> Result<(), String> {
    {
        let guard = state().lock().unwrap_or_else(|e| e.into_inner());
        if guard.running {
            return Err("已经有一个整集转写在跑".into());
        }
    }
    let p = PathBuf::from(&audio_path);
    if !p.is_file() {
        return Err(format!("找不到音频文件：{audio_path}"));
    }
    cancel_flag().store(false, Ordering::SeqCst);
    set(&app, |s| {
        *s = JobState {
            running: true,
            phase: "decode".into(),
            pct: 0.0,
            seconds: 0.0,
            total: 0.0,
            error: None,
            doc: None,
            path: audio_path.clone(),
        };
    });

    std::thread::spawn(move || {
        let result = run(&app, &audio_path, &model_dir);
        match result {
            Ok((mut doc, secs)) => {
                if let Some(name) = Path::new(&model_dir).file_name() {
                    doc["model"] = json!(name.to_string_lossy());
                }
                let doc_path = doc_path(&audio_path);
                let write = serde_json::to_vec(&doc)
                    .map_err(|e| e.to_string())
                    .and_then(|bytes| std::fs::write(&doc_path, bytes).map_err(|e| e.to_string()));
                match write {
                    Ok(()) => set(&app, |s| {
                        s.running = false;
                        s.phase = "done".into();
                        s.pct = 100.0;
                        s.seconds = secs;
                        s.doc = Some(doc_path.to_string_lossy().to_string());
                    }),
                    Err(e) => set(&app, |s| {
                        s.running = false;
                        s.phase = "error".into();
                        s.error = Some(format!("写文字稿失败：{e}"));
                    }),
                }
            }
            Err(e) => set(&app, |s| {
                s.running = false;
                s.phase = "error".into();
                s.error = Some(e);
            }),
        }
    });
    Ok(())
}

pub fn status() -> Value {
    let s = state().lock().unwrap_or_else(|e| e.into_inner()).clone();
    json!({
        "path": s.path,
        "running": s.running,
        "phase": s.phase,
        "pct": s.pct,
        "seconds": s.seconds,
        "total": s.total,
        "error": s.error,
        "doc": s.doc,
    })
}

pub fn stop() {
    cancel_flag().store(true, Ordering::SeqCst);
}

pub fn load(audio_path: &str) -> Result<String, String> {
    let p = doc_path(audio_path);
    std::fs::read_to_string(&p).map_err(|e| format!("读取文字稿失败：{e}"))
}

fn run(app: &AppHandle, audio_path: &str, model_dir: &str) -> Result<(Value, f64), String> {
    set(app, |s| s.phase = "load".into());
    // 整集转写是离线批处理，能吃满核心；字幕实时那条链路仍然只给 2 线程。
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(8) as i32;
    let asr = Asr::new(model_dir, threads)?;
    let mut format = open_format(audio_path)?;
    let track = format
        .default_track()
        .ok_or_else(|| "音频里没有可解码的音轨".to_string())?
        .clone();
    let track_id = track.id;
    let src_rate = track.codec_params.sample_rate.unwrap_or(0);
    let total_frames = track.codec_params.n_frames.unwrap_or(0);
    let total_secs = if total_frames > 0 && src_rate > 0 {
        total_frames as f64 / src_rate as f64
    } else {
        0.0
    };
    set(app, |s| s.total = total_secs);
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("解码器初始化失败：{e}"))?;

    let mut decoded_frames: u64 = 0;
    let mut packets: u64 = 0;
    let mut pending: Vec<f32> = Vec::new();
    let mut last_report = std::time::Instant::now();

    loop {
        if cancel_flag().load(Ordering::SeqCst) {
            return Err("已取消".into());
        }
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                trace(&format!("eof packets={packets} frames={decoded_frames}"));
                break
            }
            Err(SymError::ResetRequired) => {
                trace(&format!("reset packets={packets} frames={decoded_frames}"));
                break
            }
            Err(e) => return Err(format!("读音频失败：{e}")),
        };
        packets += 1;
        if packet.track_id() != track_id {
            continue;
        }
        let buf = decoder
            .decode(&packet)
            .map_err(|e| format!("解码失败：{e}"))?;
        let spec = *buf.spec();
        let frames = buf.capacity() as u64;
        let mut sbuf = SampleBuffer::<f32>::new(frames, spec);
        sbuf.copy_interleaved_ref(buf);
        let samples = sbuf.samples();
        let channels = spec.channels.count().max(1);
        let mut mono = Vec::with_capacity((frames as usize).min(samples.len()));
        if channels == 1 {
            mono.extend_from_slice(samples);
        } else {
            mono.resize(frames as usize, 0.0);
            for i in 0..frames as usize {
                let base = i * channels;
                let mut sum = 0.0f32;
                for c in 0..channels {
                    sum += samples.get(base + c).copied().unwrap_or(0.0);
                }
                mono[i] = sum / channels as f32;
            }
        }
        let feed_rate = if src_rate > 0 { src_rate as i32 } else { spec.rate as i32 };
        pending.extend_from_slice(&mono);
        decoded_frames += frames;
        // 攒到半秒就喂一次，并立刻把能解的帧解干净：整段一次性灌进去会让
        // sherpa 的特征队列爆掉，最后只吐出开头几秒。
        let chunk = (feed_rate.max(8000) as usize / 2).max(4000);
        if pending.len() >= chunk {
            asr.feed(&pending, feed_rate);
            pending.clear();
            asr.drain()?;
            if last_report.elapsed().as_secs() >= 1 {
                last_report = std::time::Instant::now();
                let pct = if total_frames > 0 {
                    (decoded_frames as f32 / total_frames as f32 * 100.0).min(99.0)
                } else {
                    30.0
                };
                let secs = if src_rate > 0 {
                    decoded_frames as f64 / src_rate as f64
                } else {
                    0.0
                };
                set(app, |s| {
                    s.phase = "asr".into();
                    s.pct = pct;
                    s.seconds = secs;
                });
            }
        }
    }
    if !pending.is_empty() {
        asr.feed(&pending, if src_rate > 0 { src_rate as i32 } else { 16000 });
    }
    let raw = asr.drain()?;
    trace(&format!("done packets={packets} frames={decoded_frames}"));
    if std::env::var("MT_TRACE").is_ok() {
        let _ = std::fs::write("C:\\tmp\\localasr-raw.json", raw.as_bytes());
    }
    let doc = build_doc(&raw)?;
    let secs = doc
        .get("audio_seconds")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    Ok((doc, secs))
}

fn open_format(path: &str) -> Result<Box<dyn symphonia::core::formats::FormatReader>, String> {
    let file = File::open(Path::new(path)).map_err(|e| format!("打开音频失败：{e}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map(|p| p.format)
        .map_err(|e| format!("无法识别这个音频格式：{e}"))
}

#[derive(Clone)]
struct Word {
    text: String,
    start: f64,
    end: f64,
}

fn build_doc(raw: &str) -> Result<Value, String> {
    let v: Value = serde_json::from_str(raw).map_err(|e| format!("识别结果解析失败：{e}"))?;
    let tokens = v
        .get("tokens")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let times = v
        .get("timestamps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut words: Vec<Word> = Vec::new();
    let mut pending_boundary = false;
    for (i, tok) in tokens.iter().enumerate() {
        let piece = tok.as_str().unwrap_or("");
        let ts = times.get(i).and_then(Value::as_f64).unwrap_or(0.0);
        let next_ts = times
            .get(i + 1)
            .and_then(Value::as_f64)
            .unwrap_or(ts + 0.08);
        let boundary = piece.starts_with('▁') || piece.starts_with(' ') || piece.starts_with('|');
        let text = piece.trim_start_matches(['▁', ' ', '|']).to_string();
        if text.is_empty() {
            // 模型会单独吐出 " " 这类空白 token，它只表示下一个词要另起。
            if boundary {
                pending_boundary = true;
            }
            continue;
        }
        let new_word = boundary || pending_boundary || words.is_empty();
        pending_boundary = false;
        if new_word {
            words.push(Word {
                text,
                start: ts,
                end: next_ts.max(ts + 0.02),
            });
        } else if let Some(last) = words.last_mut() {
            last.text.push_str(&text);
            last.end = next_ts.max(last.end);
        }
    }
    if words.is_empty() {
        return Err("这一集没有识别出可用文字".into());
    }
    // ASR 输出基本是大写；转成正常大小写，句首再大写。
    // 注意缩写里有撇号（IT'S / DON'T），只看字母是否全大写，别被标点骗过去。
    for w in &mut words {
        let letters: Vec<char> = w.text.chars().filter(|c| c.is_ascii_alphabetic()).collect();
        if letters.len() > 1 && letters.iter().all(|c| c.is_ascii_uppercase()) {
            w.text = w.text.to_lowercase();
        }
        // 英文里的 I 永远大写：ASR 常吐 I'M / I'VE，统一小写后会变成句中的 i'm。
        if w.text == "i" || w.text.starts_with("i'") {
            w.text.replace_range(0..1, "I");
        }
    }

    let mut segments: Vec<Value> = Vec::new();
    let mut start_idx = 0usize;
    for i in 1..=words.len() {
        let cut = i == words.len()
            || words[i].start - words[i - 1].end > 1.2
            || words[i].start - words[start_idx].start > 12.0
            || i - start_idx >= 40;
        if !cut {
            continue;
        }
        let chunk = &words[start_idx..i];
        let start = chunk.first().map(|w| w.start).unwrap_or(0.0);
        let end = chunk.last().map(|w| w.end).unwrap_or(start + 1.0);
        let mut text = chunk
            .iter()
            .map(|w| w.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        text = tidy_sentence(&text);
        let ws: Vec<Value> = chunk
            .iter()
            .map(|w| {
                json!([
                    w.text,
                    (w.start * 1000.0).round() as i64,
                    ((w.end - w.start).max(0.02) * 1000.0).round() as i64
                ])
            })
            .collect();
        segments.push(json!({
            "start": (start * 1000.0).round() as i64,
            "end": (end * 1000.0).round() as i64,
            "text": text,
            "words": ws,
        }));
        start_idx = i;
    }

    let audio_seconds = words.last().map(|w| w.end).unwrap_or(0.0);
    Ok(json!({
        "audio_seconds": audio_seconds,
        "complete": true,
        "native": true,
        "source": "local-asr",
        "segments": segments,
    }))
}

fn tidy_sentence(text: &str) -> String {
    let mut s = text.trim().to_string();
    if s.is_empty() {
        return s;
    }
    let first = s.chars().next().unwrap_or(' ');
    if first.is_ascii_lowercase() {
        s.replace_range(0..1, &first.to_ascii_uppercase().to_string());
    }
    if !s.ends_with(['.', '!', '?', '"', '\'']) {
        s.push('.');
    }
    s
}

/// 单句精听：只解码 [start_s, end_s] 这段，用指定模型重跑一遍。
/// 播放页在"听不清"的时候调用，返回带绝对时间的段落，便于直接贴在原句下面。
pub fn transcribe_clip(
    audio_path: &str,
    start_s: f64,
    end_s: f64,
    model_dir: &str,
) -> Result<Value, String> {
    if !start_s.is_finite() || !end_s.is_finite() || end_s <= start_s {
        return Err("时间范围不合法".into());
    }
    if end_s - start_s > 90.0 {
        return Err("一次最多精听 90 秒".into());
    }
    let p = PathBuf::from(audio_path);
    if !p.is_file() {
        return Err(format!("找不到音频文件：{audio_path}"));
    }
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(4) as i32;
    // 每次精听都新建引擎：复用 stream 会把上一句的尾巴带进下一句（实测过，
    // 第二次结果开头会多出上一段的话）。多花 2–3 秒加载，换来干净结果。
    let asr = Asr::new(model_dir, threads)?;

    let mut format = open_format(audio_path)?;
    let track = format
        .default_track()
        .ok_or_else(|| "音频里没有可解码的音轨".to_string())?
        .clone();
    let track_id = track.id;
    let rate = track.codec_params.sample_rate.unwrap_or(16000).max(8000) as u64;
    let start_frame = (start_s * rate as f64).round() as u64;
    let end_frame = (end_s * rate as f64).round() as u64;

    // 先退 0.6 秒再解码：mp3/aac 在关键帧前需要预热，否则开头会吞字。
    // 定位不准也没关系，下面按时间戳把多余部分切掉。
    let roof = (start_s - 0.6).max(0.0);
    let _ = format.seek(
        symphonia::core::formats::SeekMode::Accurate,
        symphonia::core::formats::SeekTo::Time {
            time: symphonia::core::units::Time::new(
                roof.floor() as u64,
                (roof - roof.floor()) as f64,
            ),
            track_id: Some(track_id),
        },
    );

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("解码器初始化失败：{e}"))?;
    let time_base = track.codec_params.time_base;
    let mut pending: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(v) => v,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymError::ResetRequired) => break,
            Err(e) => return Err(format!("读音频失败：{e}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let frame_at = time_base
            .map(|tb| {
                let t = tb.calc_time(packet.ts());
                t.seconds as f64 + t.frac
            })
            .map(|secs| (secs * rate as f64).round() as u64)
            .unwrap_or(packet.ts());
        let buf = decoder
            .decode(&packet)
            .map_err(|e| format!("解码失败：{e}"))?;
        let frames = buf.frames() as u64;
        if frame_at + frames <= start_frame {
            continue;
        }
        if frame_at >= end_frame {
            break;
        }
        let spec = *buf.spec();
        let channels = spec.channels.count().max(1);
        let mut sbuf = SampleBuffer::<f32>::new(frames, spec);
        sbuf.copy_interleaved_ref(buf);
        let samples = sbuf.samples();
        let from = start_frame.saturating_sub(frame_at) as usize;
        let to = (end_frame - frame_at).min(frames) as usize;
        if from >= to {
            continue;
        }
        if channels == 1 {
            pending.extend_from_slice(&samples[from..to]);
        } else {
            for i in from..to {
                let base = i * channels;
                let mut sum = 0.0f32;
                for c in 0..channels {
                    sum += samples.get(base + c).copied().unwrap_or(0.0);
                }
                pending.push(sum / channels as f32);
            }
        }
        let chunk = (rate as usize / 2).max(4000);
        if pending.len() >= chunk {
            asr.feed(&pending, rate as i32);
            pending.clear();
            asr.drain()?;
        }
    }
    if !pending.is_empty() {
        asr.feed(&pending, rate as i32);
    }
    let raw = asr.drain()?;
    if std::env::var("MT_TRACE").is_ok() {
        let _ = std::fs::write("C:\\tmp\\localasr-clip-raw.json", raw.as_bytes());
    }
    let mut doc = build_doc(&raw)?;
    let offset_ms = (start_s * 1000.0).round() as i64;
    if let Some(segs) = doc.get_mut("segments").and_then(Value::as_array_mut) {
        for seg in segs.iter_mut() {
            for key in ["start", "end"] {
                if let Some(v) = seg.get(key).and_then(|x| x.as_i64()) {
                    seg[key] = json!(v + offset_ms);
                }
            }
            if let Some(words) = seg.get_mut("words").and_then(Value::as_array_mut) {
                for w in words.iter_mut() {
                    if let Some(v) = w.get(1).and_then(|x| x.as_i64()) {
                        w[1] = json!(v + offset_ms);
                    }
                }
            }
        }
    }
    if let Some(name) = Path::new(model_dir).file_name() {
        doc["model"] = json!(name.to_string_lossy());
    }
    doc["clip"] = json!({ "start_ms": offset_ms, "end_ms": (end_s * 1000.0).round() as i64 });
    Ok(doc)
}
