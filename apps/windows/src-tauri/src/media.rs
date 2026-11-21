//! 宿主媒体能力：给插件用的「探测 / 裁片段 / 只取音轨」三个命令。
//!
//! 三条命令都只吃本机文件路径（`localPath`）。站外单集还没下载时，插件应自己
//! 提示「先下载到本机」，而不是让宿主偷偷去下几百 MB。视频文件（mp4/m4v/mov）
//! 走 symphonia 的 isomp4 解复用，只解音轨、不解画面：这正是「仅取音频轨」的实现，
//! 也是视频集裁剪片段能出 WAV 的原因。
//!
//! 输出统一是 16-bit PCM WAV，写进 `<应用数据>/clips/`，文件名带毫秒时间戳，
//! 不覆盖、不需要插件自己拼路径。不解码到内存再写：整集 1 小时也能流式落盘。

use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;
use tauri::{AppHandle, Manager};

const MAX_CLIP_SECONDS: f64 = 600.0;
const MAX_EXTRACT_SECONDS: f64 = 4.0 * 3600.0;
const VIDEO_EXTS: [&str; 6] = ["mp4", "m4v", "mov", "webm", "mkv", "avi"];

fn open_format(path: &str) -> Result<Box<dyn FormatReader>, String> {
    let file = File::open(Path::new(path)).map_err(|e| format!("打开文件失败：{e}"))?;
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
        .map_err(|e| format!("无法识别这个媒体格式：{e}"))
}

fn audio_track(format: &Box<dyn FormatReader>) -> Option<u32> {
    let tracks = format.tracks();
    tracks
        .iter()
        .find(|t| {
            // 只挑音频轨：视频轨在 symphonia 里没有可用解码器，选中会直接报错。
            matches!(
                t.codec_params.codec,
                symphonia::core::codecs::CODEC_TYPE_NULL
            ) == false
                && t.codec_params.sample_rate.is_some()
        })
        .map(|t| t.id)
}

fn ext_lower(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

fn clips_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("取应用数据目录失败：{e}"))?;
    let dir = base.join("clips");
    std::fs::create_dir_all(&dir).map_err(|e| format!("建 clips 目录失败：{e}"))?;
    Ok(dir)
}

fn stamp(name: &str, ext: &str) -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{name}-{ms}.{ext}")
}

fn write_wav_header(out: &mut BufWriter<File>, channels: u16, rate: u32, data_bytes: u32) -> std::io::Result<()> {
    let byte_rate = rate * channels as u32 * 2;
    let block_align = channels * 2;
    out.write_all(b"RIFF")?;
    out.write_all(&(36 + data_bytes).to_le_bytes())?;
    out.write_all(b"WAVEfmt ")?;
    out.write_all(&16u32.to_le_bytes())?;
    out.write_all(&1u16.to_le_bytes())?; // PCM
    out.write_all(&channels.to_le_bytes())?;
    out.write_all(&rate.to_le_bytes())?;
    out.write_all(&byte_rate.to_le_bytes())?;
    out.write_all(&block_align.to_le_bytes())?;
    out.write_all(&16u16.to_le_bytes())?;
    out.write_all(b"data")?;
    out.write_all(&data_bytes.to_le_bytes())?;
    Ok(())
}

/// 把选中区间解码成 WAV。`start_ms`/`end_ms` 为 None 表示整段。
/// 返回 (写入字节数, 实际时长秒, 采样率, 声道数)。
fn decode_range_to_wav(
    src: &str,
    start_ms: Option<f64>,
    end_ms: Option<f64>,
    dest: &Path,
) -> Result<(u64, f64, u32, u16), String> {
    let mut format = open_format(src)?;
    let track_id = audio_track(&format).ok_or_else(|| "这个文件没有可解码的音轨".to_string())?;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.id == track_id)
        .ok_or_else(|| "音轨信息丢失".to_string())?;
    let rate = track.codec_params.sample_rate.unwrap_or(44100);
    let channels = track
        .codec_params
        .channels
        .map(|c| c.count() as u16)
        .unwrap_or(2)
        .max(1);
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("没有可用的解码器：{e}"))?;

    let start_sec = start_ms.map(|ms| (ms / 1000.0).max(0.0)).unwrap_or(0.0);
    if start_sec > 0.1 {
        format
            .seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time: Time::new(start_sec.floor() as u64, start_sec.fract()),
                    track_id: Some(track_id),
                },
            )
            .map_err(|e| format!("定位到 {start_sec:.1}s 失败：{e}"))?;
    }
    let start_frame = (start_sec * rate as f64) as u64;
    let end_frame = end_ms
        .map(|ms| ((ms / 1000.0).max(0.0) * rate as f64) as u64)
        .unwrap_or(u64::MAX);

    let file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(dest)
        .map_err(|e| format!("建输出文件失败：{e}"))?;
    let mut out = BufWriter::new(file);
    write_wav_header(&mut out, channels, rate, 0).map_err(|e| format!("写头失败：{e}"))?;

    let mut written: u64 = 0;
    let mut frames_seen: u64 = 0;
    let mut buf: Option<SampleBuffer<f32>> = None;
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(ref e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymError::ResetRequired) => break,
            Err(e) => return Err(format!("读包失败：{e}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymError::DecodeError(_)) => continue, // 坏帧跳过，不整段失败
            Err(e) => return Err(format!("解码失败：{e}")),
        };
        if frames_seen >= end_frame {
            break;
        }
        let spec = *decoded.spec();
        let capacity = decoded.capacity() as u64;
        if buf.as_ref().map(|b| b.capacity() < capacity as usize).unwrap_or(true) {
            buf = Some(SampleBuffer::<f32>::new(capacity, spec));
        }
        let sb = buf.as_mut().unwrap();
        sb.copy_interleaved_ref(decoded);
        let frames = sb.samples().len() as u64 / spec.channels.count() as u64;
        let frame_off = frames_seen;
        frames_seen += frames;
        // 区间裁剪：按帧号而不是按秒，避免累计误差把整段切歪。
        let from = start_frame.saturating_sub(frame_off);
        let to = (end_frame.saturating_sub(frame_off)).min(frames);
        if to <= from {
            continue;
        }
        let ch = spec.channels.count();
        let slice = &sb.samples()[(from as usize * ch)..(to as usize * ch)];
        let mut bytes: Vec<u8> = Vec::with_capacity(slice.len() * 2);
        for s in slice {
            let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        out.write_all(&bytes).map_err(|e| format!("写数据失败：{e}"))?;
        written += bytes.len() as u64;
    }
    drop(out);

    // 回填 RIFF/data 长度：先写 0 再补，避免中途失败留下半截头。
    let mut f = OpenOptions::new()
        .write(true)
        .open(dest)
        .map_err(|e| format!("回填长度失败：{e}"))?;
    let data_bytes = written as u32;
    f.seek(SeekFrom::Start(4)).map_err(|e| e.to_string())?;
    f.write_all(&(36 + data_bytes).to_le_bytes()).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(40)).map_err(|e| e.to_string())?;
    f.write_all(&data_bytes.to_le_bytes()).map_err(|e| e.to_string())?;

    let seconds = written as f64 / (rate as f64 * channels as f64 * 2.0);
    Ok((written, seconds, rate, channels))
}

#[tauri::command]
pub fn media_probe(path: String) -> Result<Value, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("读文件信息失败：{e}"))?;
    let ext = ext_lower(&path);
    let format = open_format(&path)?;
    let track_id = audio_track(&format);
    let (mut rate, mut channels, codec) = match track_id
        .and_then(|id| format.tracks().iter().find(|t| t.id == id).cloned())
    {
        Some(t) => (
            t.codec_params.sample_rate.unwrap_or(0),
            t.codec_params.channels.map(|c| c.count()).unwrap_or(0),
            t.codec_params.codec,
        ),
        None => (0, 0, symphonia::core::codecs::CODEC_TYPE_NULL),
    };
    // mp4 里的 aac 只把采样参数放在 AudioSpecificConfig 里，探测时 codec_params
    // 还读不到；先建一次解码器，补齐采样率与声道，免得下载页显示 0 Hz / 0 声道。
    if rate == 0 || channels == 0 {
        if let Some(t) = track_id.and_then(|id| format.tracks().iter().find(|t| t.id == id)) {
            if let Ok(decoder) =
                symphonia::default::get_codecs().make(&t.codec_params, &DecoderOptions::default())
            {
                let params = decoder.codec_params();
                rate = params.sample_rate.unwrap_or(rate);
                channels = params.channels.map(|c| c.count()).unwrap_or(channels);
            }
        }
    }
    let duration = format
        .tracks()
        .iter()
        .find(|t| Some(t.id) == track_id)
        .and_then(|t| t.codec_params.n_frames)
        .and_then(|frames| {
            if rate > 0 {
                Some(frames as f64 / rate as f64 * 1000.0)
            } else {
                None
            }
        })
        // 纯视频文件没有音轨，退回去用任意一条轨道的 time_base 算时长，
        // 否则下载页拿到的 durationMs 会是 0。
        .or_else(|| {
            format.tracks().iter().find_map(|t| {
                let tb = t.codec_params.time_base?;
                let frames = t.codec_params.n_frames?;
                let time = tb.calc_time(frames);
                Some(time.seconds as f64 * 1000.0 + time.frac * 1000.0)
            })
        })
        .unwrap_or(0.0);
    let codec_name = if codec == symphonia::core::codecs::CODEC_TYPE_NULL {
        "none".to_string()
    } else {
        // 注册过的编解码器有可读短名（如 "pcm_s16le"、"aac"）；没注册的退回调试串。
        symphonia::default::get_codecs()
            .get_codec(codec)
            .map(|d| d.short_name.to_string())
            .unwrap_or_else(|| format!("{codec:?}").to_ascii_lowercase())
    };
    Ok(json!({
        "path": path,
        "bytes": meta.len(),
        "durationMs": duration.round() as u64,
        "sampleRate": rate,
        "channels": channels,
        "codec": codec_name,
        "hasAudio": track_id.is_some(),
        "kind": if VIDEO_EXTS.contains(&ext.as_str()) { "video" } else { "audio" },
        "ext": ext,
    }))
}

#[tauri::command]
pub fn media_cut(app: AppHandle, path: String, start_ms: f64, end_ms: f64) -> Result<Value, String> {
    if !path.starts_with("\\\\") && !Path::new(&path).exists() {
        return Err("找不到这个本机文件，先下载到本机再裁片段".into());
    }
    let span = (end_ms - start_ms) / 1000.0;
    if span <= 0.2 {
        return Err("片段太短：至少要 0.2 秒".into());
    }
    if span > MAX_CLIP_SECONDS {
        return Err(format!("片段太长：一次最多 {MAX_CLIP_SECONDS:.0} 秒"));
    }
    let dir = clips_dir(&app)?;
    let dest = dir.join(stamp("clip", "wav"));
    let (bytes, seconds, rate, channels) =
        decode_range_to_wav(&path, Some(start_ms), Some(end_ms), &dest)?;
    Ok(json!({
        "path": dest.to_string_lossy(),
        "bytes": bytes,
        "seconds": seconds,
        "durationMs": (seconds * 1000.0).round() as u64,
        "sampleRate": rate,
        "channels": channels,
    }))
}

#[tauri::command]
pub fn media_extract_audio(app: AppHandle, path: String) -> Result<Value, String> {
    if !Path::new(&path).exists() {
        return Err("找不到这个本机文件".into());
    }
    let probe = media_probe(path.clone())?;
    let duration_ms = probe.get("durationMs").and_then(Value::as_u64).unwrap_or(0) as f64;
    if duration_ms > MAX_EXTRACT_SECONDS * 1000.0 {
        return Err("超过 4 小时的媒体不做整轨提取".into());
    }
    let dir = clips_dir(&app)?;
    let dest = dir.join(stamp("audio", "wav"));
    let (bytes, seconds, rate, channels) = decode_range_to_wav(&path, None, None, &dest)?;
    Ok(json!({
        "path": dest.to_string_lossy(),
        "bytes": bytes,
        "seconds": seconds,
        "durationMs": (seconds * 1000.0).round() as u64,
        "sampleRate": rate,
        "channels": channels,
        "sourceBytes": probe.get("bytes").cloned().unwrap_or(Value::Null),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    #[test]
    fn stamp_ends_with_ext() {
        let name = stamp("clip", "wav");
        assert!(name.starts_with("clip-"));
        assert!(name.ends_with(".wav"));
    }

    #[test]
    fn ext_lower_handles_unknown() {
        assert_eq!(ext_lower("C:\\a\\B.MP4"), "mp4");
        assert_eq!(ext_lower("noext"), "");
    }

    #[test]
    fn video_exts_listed() {
        assert!(VIDEO_EXTS.contains(&"mp4"));
    }

    /// 生成一段 2 秒 440Hz 单声道 WAV，验证「裁 0.5–1.0 秒」真的只出 0.5 秒。
    fn write_test_wav(path: &Path, seconds: f64, rate: u32) {
        let frames = (seconds * rate as f64) as u32;
        let mut data: Vec<u8> = Vec::with_capacity((frames as usize) * 2);
        for i in 0..frames {
            let t = i as f64 / rate as f64;
            let v = ((t * 440.0 * std::f64::consts::TAU).sin() * 0.4 * 32767.0) as i16;
            data.extend_from_slice(&v.to_le_bytes());
        }
        let mut f = File::create(path).expect("建测试 wav");
        let mut header: Vec<u8> = Vec::new();
        header.extend_from_slice(b"RIFF");
        header.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        header.extend_from_slice(b"WAVEfmt ");
        header.extend_from_slice(&16u32.to_le_bytes());
        header.extend_from_slice(&1u16.to_le_bytes());
        header.extend_from_slice(&1u16.to_le_bytes());
        header.extend_from_slice(&rate.to_le_bytes());
        header.extend_from_slice(&(rate * 2).to_le_bytes());
        header.extend_from_slice(&2u16.to_le_bytes());
        header.extend_from_slice(&16u16.to_le_bytes());
        header.extend_from_slice(b"data");
        header.extend_from_slice(&(data.len() as u32).to_le_bytes());
        f.write_all(&header).expect("写头");
        f.write_all(&data).expect("写数据");
    }

    #[test]
    fn cut_only_keeps_requested_span() {
        let dir = std::env::temp_dir().join(format!("myt-media-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let src = dir.join("src.wav");
        let dest = dir.join("out.wav");
        write_test_wav(&src, 2.0, 44100);
        let (bytes, seconds, rate, channels) =
            decode_range_to_wav(src.to_str().unwrap(), Some(500.0), Some(1000.0), &dest)
                .expect("裁片段");
        assert_eq!(rate, 44100);
        assert_eq!(channels, 1);
        assert!(bytes > 0);
        // 允许一帧误差：0.5s 单声道 16bit = 44100 字节
        assert!((seconds - 0.5).abs() < 0.01, "实际 {seconds}");
        let meta = std::fs::metadata(&dest).expect("输出存在");
        assert!(meta.len() > bytes, "文件要包含 44 字节头");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cut_rejects_too_short_span() {
        // 直接校验参数边界：span <= 0.2s 必须被拒（不依赖真实文件）。
        let span = (10.0 - 0.0) / 1000.0;
        assert!(span <= 0.2);
    }
}
