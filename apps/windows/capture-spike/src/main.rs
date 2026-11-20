//! 采集 spike 入口：设备级 WASAPI loopback → 16 kHz 单声道 → sherpa 流式识别。
//!
//! 用法：
//!   cargo run --release -- --seconds 30
//!   cargo run --release -- --seconds 60 --model C:\ProgramData\MyTranscript\models\en-standard
//!
//! 运行期间请用任意播放器放一段英文音频（Chrome / VLC / 系统 TTS 都行）。
//! 输出的是「音频送入时刻 - 最后一个词时间戳」，也就是识别滞后，
//! 不是端到端字幕延迟（那还要加上窗口渲染，通常 < 50 ms）。

#[path = "../../src-tauri/src/asr.rs"]
mod asr;
#[path = "../../src-tauri/src/wasapi.rs"]
mod wasapi;

use std::time::{Duration, Instant};

use windows::Win32::Foundation::FILETIME;
use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};

fn main() {
    if let Err(e) = run() {
        eprintln!("\n[失败] {e}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut seconds = 30u64;
    let mut model = std::env::var("MT_MODEL_DIR").unwrap_or_else(|_| {
        r"C:\ProgramData\MyTranscript\models\en-mini".to_string()
    });
    let mut dump: Option<String> = None;
    let mut file: Option<String> = None;
    let mut pad: f64 = 0.0;
    let mut chunk_ms: usize = 100;
    let mut threads: i32 = 2;
    let mut pid: Option<u32> = None;
    let mut list_sessions = false;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--seconds" | "-s" => {
                seconds = args
                    .next()
                    .ok_or("--seconds 缺少数值")?
                    .parse()
                    .map_err(|_| "--seconds 需要整数")?;
            }
            "--model" | "-m" => model = args.next().ok_or("--model 缺少路径")?,
            "--dump" => dump = Some(args.next().ok_or("--dump 缺少路径")?),
            "--file" => file = Some(args.next().ok_or("--file 缺少路径")?),
            "--pad" => {
                pad = args
                    .next()
                    .ok_or("--pad 缺少数值")?
                    .parse()
                    .map_err(|_| "--pad 需要秒数（可带小数）")?
            }
            "--chunk" => {
                chunk_ms = args
                    .next()
                    .ok_or("--chunk 缺少数值")?
                    .parse()
                    .map_err(|_| "--chunk 需要毫秒整数")?
            }
            "--threads" => {
                threads = args
                    .next()
                    .ok_or("--threads 缺少数值")?
                    .parse()
                    .map_err(|_| "--threads 需要整数")?
            }
            "--pid" => {
                pid = Some(
                    args.next()
                        .ok_or("--pid 缺少数值")?
                        .parse()
                        .map_err(|_| "--pid 需要进程号")?,
                )
            }
            "--list-sessions" => list_sessions = true,
            other => return Err(format!("未知参数：{other}")),
        }
    }
    if !std::path::Path::new(&model).join("tokens.txt").exists() {
        return Err(format!(
            "模型目录里没有 tokens.txt：{model}\n先让桌面端下载模型，或用 --model 指定目录"
        ));
    }

    if let Some(path) = file {
        return run_file(&path, &model, pad, chunk_ms, threads);
    }

    if list_sessions {
        let list = wasapi::audio_sessions()?;
        println!("{:<8} {:<6} {}", "PID", "状态", "应用");
        for s in list {
            println!(
                "{:<8} {:<6} {}",
                s.pid,
                if s.active { "出声" } else { "空闲" },
                s.name
            );
        }
        return Ok(());
    }

    let mut cap = match pid {
        Some(pid) => {
            println!("进程级 loopback：只抓 PID {pid} 及其子进程");
            wasapi::Capture::open_process(pid)?
        }
        None => wasapi::Capture::open()?,
    };
    println!("[main] capture open 完成");
    println!("设备混音格式：{} Hz / {} ch / {} / {} bit", cap.src_rate, cap.channels,
        if cap.is_float { "float" } else { "pcm" }, cap.bits);
    println!("目标：16000 Hz mono；模型：{model}，{threads} 线程");
    println!("开始采集 {seconds} 秒 —— 请现在开始播放英文音频……\n");

    if std::env::var("MT_NO_ASR").is_ok() {
        let mut buf: Vec<f32> = Vec::new();
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(4) {
            cap.pump(&mut buf)?;
            std::thread::sleep(Duration::from_millis(40));
        }
        println!("raw samples = {}", buf.len());
        return Ok(());
    }

    let engine = asr::Asr::new(&model, threads)?;

    let wall0 = Instant::now();
    let cpu0 = cpu_seconds();
    let mut pending: Vec<f32> = Vec::with_capacity(16000);
    let mut recorded: Vec<f32> = Vec::new();
    let mut fed = 0usize;
    let mut last_text = String::new();
    let mut first_text_at: Option<f64> = None;
    let mut lags: Vec<f64> = Vec::new();
    let mut silent_frames = 0usize;
    let mut total_frames = 0usize;
    let mut last_report = 0.0f64;

    while wall0.elapsed() < Duration::from_secs(seconds) {
        let before = pending.len();
        if let Err(e) = cap.pump(&mut pending) {
            eprintln!("[采集中断] {e}");
            break;
        }
        if dump.is_some() {
            recorded.extend_from_slice(&pending[before..]);
        }

        // 统计静音占比（只在原始 16k 流上粗算 RMS）
        for &s in pending.iter().rev().take(1600) {
            total_frames += 1;
            if s.abs() < 0.0005 {
                silent_frames += 1;
            }
        }

        if pending.len() >= 1600 {
            engine.feed(&pending, 16000);
            fed += pending.len();
            pending.clear();

            let json = engine.result().unwrap_or_else(|_| "{}".to_string());
            let (text, last_ts) = parse_result(&json);
            if !text.is_empty() && text != last_text {
                let fed_secs = fed as f64 / 16000.0;
                let lag = last_ts.map(|t| (fed_secs - t).max(0.0));
                if first_text_at.is_none() {
                    first_text_at = Some(wall0.elapsed().as_secs_f64());
                }
                if let Some(l) = lag {
                    lags.push(l);
                }
                println!(
                    "[{:>6.2}s] {}{}",
                    wall0.elapsed().as_secs_f64(),
                    text,
                    lag.map(|l| format!("   (lag {l:.2}s)")).unwrap_or_default()
                );
                last_text = text;
            }
        }

        let now = wall0.elapsed().as_secs_f64();
        if now - last_report >= 5.0 {
            last_report = now;
            let fed_secs = fed as f64 / 16000.0;
            let cpu = (cpu_seconds() - cpu0) / now.max(0.001) * 100.0;
            println!(
                "        …… t={:>5.1}s 音频={:>5.1}s 滞后={} CPU={:.0}%",
                now,
                fed_secs,
                lags.last().map(|l| format!("{l:.2}s")).unwrap_or_else(|| "-".into()),
                cpu
            );
        }

        std::thread::sleep(Duration::from_millis(10));
    }

    if !pending.is_empty() {
        engine.feed(&pending, 16000);
        fed += pending.len();
    }
    let _ = engine.result();

    cap.stop();
    let wall = wall0.elapsed().as_secs_f64();
    let cpu = (cpu_seconds() - cpu0) / wall.max(0.001) * 100.0;

    println!("\n=== 汇总 ===");
    println!("采集时长：{wall:.1}s，送入识别：{:.1}s", fed as f64 / 16000.0);
    println!(
        "首行出现：{}",
        first_text_at
            .map(|t| format!("{t:.2}s"))
            .unwrap_or_else(|| "未出现文字（可能没声音 / 麦克风静音 / 独占模式）".into())
    );
    if !lags.is_empty() {
        let mut sorted = lags.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let median = sorted[sorted.len() / 2];
        let p95 = sorted[(sorted.len() as f64 * 0.95) as usize % sorted.len()];
        let max = *sorted.last().unwrap();
        println!(
            "识别滞后：中位 {median:.2}s / p95 {p95:.2}s / 最大 {max:.2}s（样本 {}）",
            lags.len()
        );
    } else {
        println!("识别滞后：没有可用样本");
    }
    println!("CPU：{cpu:.0}%（单核百分比，{threads} 线程识别）");
    if total_frames > 0 {
        println!(
            "静音占比：{:.0}%",
            silent_frames as f64 / total_frames as f64 * 100.0
        );
    }
    if let Some(path) = dump {
        write_wav(&path, &recorded)?;
        println!(
            "已写出采集音频：{path}（{:.1}s，{} 样本）",
            recorded.len() as f64 / 16000.0,
            recorded.len()
        );
    }
    Ok(())
}

/// 离线跑同一个音频文件：用来区分「采集团丢音频」和「识别丢开头」。
fn run_file(path: &str, model: &str, pad: f64, chunk_ms: usize, threads: i32) -> Result<(), String> {
    let (samples, rate) = read_wav(path)?;
    if rate != 16000 {
        return Err(format!("只支持 16 kHz 的 dump，当前 {rate} Hz"));
    }
    let chunk = (16000 * chunk_ms / 1000).max(160);
    println!(
        "离线识别：{path}（{:.1}s），前置静音 {pad:.1}s，块 {chunk_ms}ms",
        samples.len() as f64 / 16000.0
    );
    let engine = asr::Asr::new(model, threads)?;
    let mut fed = 0usize;
    if pad > 0.0 {
        // 关键：静音也要按小块喂，跟真实采集节奏一致；一次性塞 1.5 秒会走另一条路径。
        let zeros = vec![0.0f32; (pad * 16000.0) as usize];
        let mut off = 0usize;
        while off < zeros.len() {
            let end = (off + chunk).min(zeros.len());
            engine.feed(&zeros[off..end], 16000);
            let _ = engine.result();
            off = end;
        }
        fed = zeros.len();
    }
    let mut last = String::new();
    while fed < samples.len() {
        let end = (fed + chunk).min(samples.len());
        engine.feed(&samples[fed..end], 16000);
        fed = end;
        let json = engine.result().unwrap_or_else(|_| "{}".to_string());
        let (text, _ts) = parse_result(&json);
        if !text.is_empty() && text != last {
            println!("[{:>6.2}s] {text}", fed as f64 / 16000.0);
            last = text;
        }
    }
    let json = engine.result().unwrap_or_else(|_| "{}".to_string());
    let (text, _) = parse_result(&json);
    println!("\n最终文本：\n{text}");
    let head: String = json.chars().take(600).collect();
    println!("\n原始 JSON 前 600 字：\n{head}");
    Ok(())
}

/// 写 16 kHz / mono / 16-bit WAV（只为拿证据，不做通用编码）。
fn write_wav(path: &str, samples: &[f32]) -> Result<(), String> {
    let data_bytes = samples.len() * 2;
    let mut out: Vec<u8> = Vec::with_capacity(44 + data_bytes);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((36 + data_bytes) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&16000u32.to_le_bytes());
    out.extend_from_slice(&32000u32.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_bytes as u32).to_le_bytes());
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    std::fs::write(path, out).map_err(|e| format!("写 WAV 失败：{e}"))
}

fn read_wav(path: &str) -> Result<(Vec<f32>, u32), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读 WAV 失败：{e}"))?;
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("不是合法的 WAV".to_string());
    }
    let mut rate = 0u32;
    let mut channels = 0u16;
    let mut bits = 0u16;
    let mut data: Option<(usize, usize)> = None;
    let mut pos = 12usize;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let body = pos + 8;
        if id == b"fmt " {
            let fmt = u16::from_le_bytes(bytes[body..body + 2].try_into().unwrap());
            if fmt != 1 {
                return Err(format!("只支持 PCM WAV，当前格式 {fmt}"));
            }
            channels = u16::from_le_bytes(bytes[body + 2..body + 4].try_into().unwrap());
            rate = u32::from_le_bytes(bytes[body + 4..body + 8].try_into().unwrap());
            bits = u16::from_le_bytes(bytes[body + 14..body + 16].try_into().unwrap());
        } else if id == b"data" {
            data = Some((body, (body + size).min(bytes.len())));
        }
        pos = body + size + (size & 1);
    }
    let (start, end) = data.ok_or("WAV 里没有 data 段")?;
    if channels != 1 || bits != 16 {
        return Err(format!("只支持 mono/16bit，当前 {channels}ch/{bits}bit"));
    }
    let count = (end - start) / 2;
    let mut samples = Vec::with_capacity(count);
    for i in 0..count {
        let v = i16::from_le_bytes(bytes[start + i * 2..start + i * 2 + 2].try_into().unwrap());
        samples.push(v as f32 / 32768.0);
    }
    Ok((samples, rate))
}

fn parse_result(json: &str) -> (String, Option<f64>) {
    let v: serde_json::Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return (String::new(), None),
    };
    let text = v
        .get("text")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let last_ts = v
        .get("timestamps")
        .and_then(|t| t.as_array())
        .and_then(|a| a.last())
        .and_then(|x| x.as_f64());
    (text, last_ts)
}

fn cpu_seconds() -> f64 {
    unsafe {
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let ok = GetProcessTimes(
            GetCurrentProcess(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        );
        if ok.is_err() {
            return 0.0;
        }
        (to_u64(&kernel) + to_u64(&user)) as f64 / 10_000_000.0
    }
}

fn to_u64(t: &FILETIME) -> u64 {
    ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64
}
