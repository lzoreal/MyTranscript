//! 全局实时字幕：WASAPI loopback → 16k mono → sherpa 流式识别 → 浮窗事件。
//!
//! 采集和识别都在这个工作线程里闭环，PCM 不进 WebView；
//! 只把文本和状态 emit 出去（`myt://caption`）。
//!
//! 实测约束（见 docs/superpowers/specs/2026-11-19-windows-universal-captions-design.md）：
//! - 识别线程数用 1；2 线程只会把 CPU 抬到 10 倍，滞后不变；
//! - 每路流开头约 1.4 秒不会出字，UI 必须显示「正在听…」，不能假装听到了。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::Emitter;

use crate::asr;

const SAMPLE_RATE: usize = 16000;
const CHUNK: usize = 1600; // 100 ms
const SILENT_RMS: f32 = 0.0005;

pub struct Session {
    stop: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl Session {
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.join.take() {
            let _ = handle.join();
        }
    }
}

pub fn start(app: tauri::AppHandle, model_dir: String, threads: i32, pid: Option<u32>) -> Session {
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let join = std::thread::spawn(move || run(app, &model_dir, threads, pid, flag));
    Session {
        stop,
        join: Some(join),
    }
}

fn emit(
    app: &tauri::AppHandle,
    text: &str,
    listening: bool,
    silent: bool,
    active: bool,
    error: Option<&str>,
) {
    let _ = app.emit(
        "myt://caption",
        serde_json::json!({
            "text": text,
            "listening": listening,
            "silent": silent,
            "active": active,
            "error": error,
        }),
    );
}

fn run(
    app: tauri::AppHandle,
    model_dir: &str,
    threads: i32,
    pid: Option<u32>,
    stop: Arc<AtomicBool>,
) {
    let open = || match pid {
        Some(p) => crate::wasapi::Capture::open_process(p),
        None => crate::wasapi::Capture::open(),
    };
    let mut capture = match open() {
        Ok(c) => c,
        Err(e) => {
            emit(&app, "", false, true, false, Some(&e));
            return;
        }
    };
    let mut device_id = capture.device_id.clone();
    let engine = match asr::Asr::new(model_dir, threads) {
        Ok(a) => a,
        Err(e) => {
            emit(&app, "", false, true, false, Some(&e));
            return;
        }
    };

    let mut pending: Vec<f32> = Vec::with_capacity(CHUNK * 4);
    let mut last_text = String::new();
    let mut quiet_since: Option<Instant> = None;
    let mut last_packet = Instant::now();
    let mut last_device_check = Instant::now();
    let mut last_emit = Instant::now();
    let mut emitted_key = String::from("\u{0}");

    emit(&app, "", true, false, true, None);

    // 离线标点模型（可选）：模型目录由 MYT_PUNCT 指定，缺失时退回停顿断句。
    let punctuator = std::env::var("MYT_PUNCT")
        .ok()
        .and_then(|d| crate::punct::Punct::new(&d));

    while !stop.load(Ordering::Relaxed) {
        if let Err(e) = capture.pump(&mut pending) {
            // 设备被拔掉、被独占抢占、目标进程退出：先尝试重开，失败才结束。
            match open() {
                Ok(c) => {
                    device_id = c.device_id.clone();
                    capture = c;
                    pending.clear();
                    quiet_since = None;
                    last_packet = Instant::now();
                    crate::dbg_log(&format!("capture: reconnected after error: {e}"));
                }
                Err(e2) => {
                    emit(
                        &app,
                        "",
                        false,
                        true,
                        false,
                        Some(&format!("音频设备不可用（{e}）；重连失败：{e2}")),
                    );
                    break;
                }
            }
        }

        // 2 秒巡检一次默认设备；耳机↔扬声器切换后自动重建采集，不用重开字幕。
        // 进程级捕获不跟默认设备走，跳过巡检。
        if pid.is_none() && last_device_check.elapsed() > Duration::from_secs(2) {
            last_device_check = Instant::now();
            if let Ok(current) = crate::wasapi::default_render_id() {
                if !current.is_empty() && current != device_id {
                    match open() {
                        Ok(c) => {
                            device_id = c.device_id.clone();
                            capture = c;
                            pending.clear();
                            quiet_since = None;
                            last_packet = Instant::now();
                            crate::dbg_log("capture: default device changed, reconnected");
                        }
                        Err(e) => {
                            emit(&app, "", false, true, false, Some(&format!("切换音频设备失败：{e}")));
                            break;
                        }
                    }
                }
            }
        }

        // 静音判定：只看新进来的样本，2 秒没人声就认为没音频输入。
        // loopback 在完全没声音时一个包都不产，所以还要用「多久没收到包」兜底。
        if !pending.is_empty() {
            last_packet = Instant::now();
            let mut sum = 0.0f64;
            for &s in &pending {
                sum += (s as f64) * (s as f64);
            }
            let rms = (sum / pending.len() as f64).sqrt() as f32;
            if rms < SILENT_RMS {
                quiet_since.get_or_insert_with(Instant::now);
            } else {
                quiet_since = None;
            }
        }

        while pending.len() >= CHUNK && !stop.load(Ordering::Relaxed) {
            engine.feed(&pending[..CHUNK], SAMPLE_RATE as i32);
            pending.drain(..CHUNK);
            let json = engine.result().unwrap_or_default();
            let raw = punctuate(&json).unwrap_or_else(|| parse_text(&json));
            let bounded = tail_cap(&raw, 600);
            let text = match &punctuator {
                Some(p) => p.add(&bounded),
                None => bounded,
            };
            let capped = cap_first_alpha(&tail_cap(&apply_terms(&text), 600));
            if capped != last_text {
                last_text = capped;
                crate::dbg_log(&format!("caption: {last_text}"));
                emit(&app, &last_text, false, false, true, None);
                last_emit = Instant::now();
            }
        }

        let silent = quiet_since
            .map(|t| t.elapsed() > Duration::from_secs(2))
            .unwrap_or(false)
            || last_packet.elapsed() > Duration::from_secs(2);
        let listening = last_text.is_empty();
        let key = format!("{}|{}|{}", last_text, listening, silent);
        if key != emitted_key || last_emit.elapsed() > Duration::from_secs(1) {
            emitted_key = key;
            emit(&app, &last_text, listening, silent, true, None);
            last_emit = Instant::now();
        }

        // 没声音时不用喂识别器，省 CPU；有声音再继续。
        if silent && pending.len() < CHUNK {
            std::thread::sleep(Duration::from_millis(30));
        } else {
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    capture.stop();
    emit(&app, "", false, false, false, None);
}

/// 术语纠正：`错写 => 正写`，一行一条，大小写不敏感。
/// 模型词表里没有的新词喂不进解码器（sherpa 会直接报错），所以改成识别后纠错。
fn apply_terms(text: &str) -> String {
    use std::sync::{Mutex, OnceLock};
    use std::time::SystemTime;
    static CACHE: OnceLock<Mutex<(u64, Vec<(String, String)>)>> = OnceLock::new();
    let path = match std::env::var("MYT_TERMS") {
        Ok(p) if !p.trim().is_empty() => p,
        _ => return text.to_string(),
    };
    let mtime = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let cell = CACHE.get_or_init(|| Mutex::new((0, Vec::new())));
    let mut guard = cell.lock().unwrap_or_else(|e| e.into_inner());
    if guard.0 != mtime {
        let mut list = Vec::new();
        if let Ok(src) = std::fs::read_to_string(&path) {
            for line in src.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                if let Some((from, to)) = line.split_once("=>") {
                    let from = from.trim();
                    let to = to.trim();
                    if !from.is_empty() && !to.is_empty() {
                        list.push((from.to_lowercase(), to.to_string()));
                    }
                }
            }
        }
        *guard = (mtime, list);
    }
    if guard.1.is_empty() {
        return truecase_with_terms(text, &guard.1);
    }
    let lower = text.to_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        let mut hit: Option<&(String, String)> = None;
        for pair in guard.1.iter() {
            if lower
                .get(i..)
                .map(|s| s.starts_with(pair.0.as_str()))
                .unwrap_or(false)
            {
                if hit.map(|h| pair.0.len() > h.0.len()).unwrap_or(true) {
                    hit = Some(pair);
                }
            }
        }
        match hit {
            Some(pair) => {
                out.push_str(&pair.1);
                i += pair.0.len();
            }
            None => {
                let ch = text[i..].chars().next().unwrap();
                out.push(ch);
                i += ch.len_utf8();
            }
        }
    }
    truecase_with_terms(&out, &guard.1)
}

fn case_word(word: &str, cap: bool, terms: &[(String, String)]) -> String {
    let low = word.to_lowercase();
    for (from, to) in terms {
        if low == *from || low == to.to_lowercase() {
            return to.clone();
        }
    }
    if low == "i" || low == "i'm" || low == "i'll" || low == "i've" || low == "i'd" {
        return format!("I{}", low.strip_prefix('i').unwrap_or(""));
    }
    if !cap {
        return low;
    }
    let mut chars = low.chars();
    let mut out = String::with_capacity(low.len());
    let mut done = false;
    for ch in chars.by_ref() {
        if !done && ch.is_alphabetic() {
            out.extend(ch.to_uppercase());
            done = true;
        } else {
            out.push(ch);
        }
    }
    out
}

/// 全大写模型输出 → 句首大写、其余小写；术语表里的词保留规范写法。
fn truecase_with_terms(text: &str, terms: &[(String, String)]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut word = String::new();
    let mut cap = true;
    for ch in text.chars() {
        let word_char = ch.is_alphanumeric() || ch == '\'' || ch == '\u{2019}' || ch == '-';
        if word_char {
            word.push(ch);
        } else {
            if !word.is_empty() {
                out.push_str(&case_word(&word, cap, terms));
                cap = false;
                word.clear();
            }
            out.push(ch);
            if matches!(ch, '.' | '!' | '?' | '\n') {
                cap = true;
            }
        }
    }
    if !word.is_empty() {
        out.push_str(&case_word(&word, cap, terms));
    }
    out
}

fn cap_first_alpha(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut done = false;
    for ch in s.chars() {
        if !done && ch.is_alphabetic() {
            out.extend(ch.to_uppercase());
            done = true;
        } else {
            out.push(ch);
        }
    }
    out
}

/// 流式模型不输出标点：用词级时间戳找词间长停顿，补句号。
/// 只在停顿处断，不改词序，避免“猜”语义。
fn punctuate(json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let toks = v.get("tokens")?.as_array()?;
    let ts = v.get("timestamps")?.as_array()?;
    if toks.is_empty() || toks.len() != ts.len() {
        return None;
    }
    let mut words: Vec<(String, f32)> = Vec::new();
    let mut cur = String::new();
    let mut start = 0f32;
    for (i, t) in toks.iter().enumerate() {
        let tok = t.as_str().unwrap_or("");
        let time = ts[i].as_f64().unwrap_or(0.0) as f32;
        let lead = tok.starts_with(' ') || tok.starts_with('\u{2581}');
        let clean = tok.trim_start_matches(' ').trim_start_matches('\u{2581}');
        if clean.is_empty() {
            continue;
        }
        if lead && !cur.is_empty() {
            words.push((cur.clone(), start));
            cur.clear();
        }
        if cur.is_empty() {
            start = time;
        }
        cur.push_str(clean);
    }
    if !cur.is_empty() {
        words.push((cur, start));
    }
    if words.is_empty() {
        return None;
    }
    let mut out = String::with_capacity(words.len() * 6);
    for i in 0..words.len() {
        if i > 0 {
            out.push(' ');
        }
        out.push_str(&words[i].0);
        if i + 1 < words.len() && words[i + 1].1 - words[i].1 > 0.8 {
            out.push('.');
        }
    }
    Some(out)
}

fn parse_text(json: &str) -> String {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|v| v.get("text").and_then(|t| t.as_str()).map(str::to_string))
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// 只保留尾部；识别结果是累积的，长会议里不能无限长。
fn tail_cap(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut start = s.len() - max;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    let cut = s[start..]
        .find(". ")
        .map(|i| start + i + 2)
        .or_else(|| s[start..].find(' ').map(|i| start + i + 1))
        .unwrap_or(start);
    s[cut..].trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truecase_sentence_and_terms() {
        let terms = vec![("postgres".to_string(), "Postgres".to_string())];
        let out = truecase_with_terms("THE QUICK BROWN FOX. POSTGRES IS FAST", &terms);
        assert_eq!(out, "The quick brown fox. Postgres is fast");
    }

    #[test]
    fn truecase_keeps_canonical_case() {
        let terms = vec![("anthropic".to_string(), "Anthropic".to_string())];
        let out = truecase_with_terms("WE USE ANTHROPIC", &terms);
        assert_eq!(out, "We use Anthropic");
    }

    #[test]
    fn punctuation_breaks_on_pause() {
        let json = r#"{"text":"ONE TWO THREE","tokens":[" ONE"," TWO"," THREE"],"timestamps":[0.0,0.3,2.0]}"#;
        assert_eq!(punctuate(json).unwrap(), "ONE TWO. THREE");
    }

    #[test]
    fn cap_first_alpha_skips_quote() {
        assert_eq!(cap_first_alpha("'s works"), "'S works");
    }
}
