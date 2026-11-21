//! 宿主侧旁路转写：不解画面、只解音轨，PCM 直接喂本机 sherpa。
//!
//! 为什么另起一条：网页里的 `<video>` 声音在 WebView2 的媒体栈里，想拿 PCM 只能
//! 走 `captureStream`/`MediaElementSource`，还要看自动播放策略和倍速的脸色。
//! 这条把解码整个搬到宿主：symphonia 逐帧解 aac 得到 16k 单声道，时间戳来自容器
//! 而不是播放器时钟——播放卡不卡、几倍速都跟识别无关，还能跑在播放前面。
//!
//! 边下边解：libsyn 这些 mp4 是 faststart（moov 在文件头，实测偏移 28），所以
//! 不用等整段下完。下载器按 8MB 续传追加，解码器用 [`GrowingFile`] 读——读到
//! 当前末尾但下载还没完，就等一会儿再读，对 symphonia 来说只是「慢一点的磁盘」。
//!
//! 线程模型：
//! - 下载在 `tauri::async_runtime` 里跑（reqwest 异步）；
//! - 解码在独立 `std::thread`（symphonia + sherpa 都是同步阻塞 CPU 活）；
//! - 进度/结果放 `JOBS`，前端 0.9 秒轮询一次增量。

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::{FormatOptions, FormatReader};
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tauri::{AppHandle, Runtime};

use crate::asr::Asr;

/// 一次下载的分块；和代理的切片上限一致，远端不用被我们反复小请求。
const SLICE: u64 = 8 * 1024 * 1024;
/// 喂给 sherpa 的批量：1 秒。再小会白耗解码开销，再大字幕就一坨一坨冒。
const CHUNK: usize = 16000;
const TARGET_RATE: f64 = 16000.0;
/// 等下载的耐心上限：超了就按「文件已到头」处理，宁可少最后几秒也不要卡死。
const WAIT_LIMIT: Duration = Duration::from_secs(180);

struct Job {
    stage: String,
    downloaded: u64,
    total: u64,
    audio_sec: f64,
    tokens: Vec<(f64, String)>,
    text: String,
    error: String,
    cancel: Arc<AtomicBool>,
}

impl Job {
    fn new() -> Job {
        Job {
            stage: "download".into(),
            downloaded: 0,
            total: 0,
            audio_sec: 0.0,
            tokens: Vec::new(),
            text: String::new(),
            error: String::new(),
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }
}

static JOBS: OnceLock<Mutex<HashMap<u32, Arc<Mutex<Job>>>>> = OnceLock::new();
static NEXT: AtomicU32 = AtomicU32::new(1);

fn jobs() -> &'static Mutex<HashMap<u32, Arc<Mutex<Job>>>> {
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_job(job: &Arc<Mutex<Job>>) -> std::sync::MutexGuard<'_, Job> {
    job.lock().unwrap_or_else(|e| e.into_inner())
}

/// 旁路转写排查日志：写到 `<LOCALAPPDATA>\com.myt.transcript.desktop\videoasr.log`。
/// 默认只在 `MYT_ASR_DEBUG` 下写，免得平时刷盘。
fn dlog(msg: &str) {
    if std::env::var("MYT_ASR_DEBUG").is_err() {
        return;
    }
    use std::io::Write as _;
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    let dir = Path::new(&base).join("com.myt.transcript.desktop");
    let _ = fs::create_dir_all(&dir);
    let path = dir.join("videoasr.log");
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(
            f,
            "{} {msg} [dbg={}]",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            std::env::var("MYT_ASR_DEBUG").unwrap_or_else(|_| "-".into())
        );
    }
}

#[tauri::command]
pub async fn video_asr_start<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    model_dir: String,
    threads: Option<i32>,
) -> Result<u32, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("只支持 http(s) 地址".into());
    }
    if !Path::new(&model_dir).join("tokens.txt").exists() {
        return Err("识别模型目录里没有 tokens.txt".into());
    }
    let sid = NEXT.fetch_add(1, Ordering::SeqCst);
    let job = Arc::new(Mutex::new(Job::new()));
    jobs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(sid, job.clone());

    let threads = threads.unwrap_or(2).clamp(1, 8);
    let cancel = lock_job(&job).cancel.clone();
    tauri::async_runtime::spawn(async move {
        let (path, tail) = match prepare_file(&app, &url, &job, &cancel).await {
            Ok(p) => p,
            Err(err) => {
                finish(&job, &cancel, Err(err));
                return;
            }
        };
        let done = Arc::new(AtomicBool::new(false));
        let decoder = {
            let path = path.clone();
            let dir = model_dir.clone();
            let job = job.clone();
            let cancel = cancel.clone();
            let done = done.clone();
            let tail = tail.clone();
            std::thread::spawn(move || decode_file(&path, &dir, threads, job, cancel, done, tail))
        };
        let result = download(&url, &path, &job, &cancel).await;
        done.store(true, Ordering::SeqCst);
        let _ = decoder.join();
        finish(&job, &cancel, result);
    });
    Ok(sid)
}

fn finish(job: &Arc<Mutex<Job>>, cancel: &Arc<AtomicBool>, result: Result<(), String>) {
    let mut j = lock_job(job);
    if cancel.load(Ordering::SeqCst) {
        j.stage = "cancel".into();
        return;
    }
    match result {
        Ok(()) => {
            if j.stage != "error" {
                j.stage = "done".into();
            }
        }
        Err(e) => {
            j.stage = "error".into();
            j.error = e;
        }
    }
}

/// 打开本地缓存文件，先把代理已经下过的前缀复制过来，免得重复走网络。
async fn prepare_file<R: Runtime>(
    app: &AppHandle<R>,
    url: &str,
    job: &Arc<Mutex<Job>>,
    cancel: &Arc<AtomicBool>,
) -> Result<(PathBuf, Option<(u64, Vec<u8>)>), String> {
    let dir = crate::media_proxy::cache_dir_for(app).ok_or_else(|| "拿不到缓存目录".to_string())?;
    let key = crate::media_proxy::key_for(url);
    let ours = dir.join(format!("{key}.asr.bin"));
    let proxy = dir.join(format!("{key}.bin"));

    let (total, _ctype) = crate::media_proxy::meta_for(app, url).await?;
    {
        let mut j = lock_job(job);
        j.total = total;
    }
    if !ours.exists() {
        if let Ok(meta) = fs::metadata(&proxy) {
            let _ = copy_prefix(&proxy, &ours, meta.len());
        }
    }
    let have = fs::metadata(&ours).map(|m| m.len()).unwrap_or(0);
    if total > 0 && have > total {
        let _ = fs::remove_file(&ours);
    }
    let have = fs::metadata(&ours).map(|m| m.len()).unwrap_or(0);
    lock_job(job).downloaded = have;
    // 解封装时 symphonia 会去读文件尾（实测 seek 到 total-64KB），顺带把末尾先抢下来，
    // 这样解码不用等整段下完就能开始。
    let tail = fetch_tail(url, total, cancel).await;
    dlog(&format!(
        "prepare: file={} have={} total={} tail={}",
        ours.display(),
        have,
        total,
        tail.as_ref().map(|(at, b)| format!("{at}+{}", b.len())).unwrap_or_else(|| "-".into())
    ));
    if cancel.load(Ordering::SeqCst) {
        return Err("cancelled".into());
    }
    Ok((ours, tail))
}

/// 抢最后 8MB（含 mp4 尾部的索引/收尾块）。拿不到就算了，退回整段下完再解。
async fn fetch_tail(url: &str, total: u64, cancel: &Arc<AtomicBool>) -> Option<(u64, Vec<u8>)> {
    if total == 0 {
        return None;
    }
    let want = 8 * 1024 * 1024u64;
    let start = total.saturating_sub(want.min(total));
    if cancel.load(Ordering::SeqCst) {
        return None;
    }
    match crate::media_proxy::fetch_bytes(url, start, total - 1).await {
        Ok(bytes) if !bytes.is_empty() => Some((start, bytes)),
        _ => None,
    }
}

fn copy_prefix(src: &Path, dest: &Path, len: u64) -> std::io::Result<()> {
    let mut input = BufReader::new(File::open(src)?);
    let mut out = File::create(dest)?;
    let mut left = len;
    let mut buf = [0u8; 64 * 1024];
    while left > 0 {
        let cap = left.min(buf.len() as u64) as usize;
        let n = input.read(&mut buf[..cap])?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n])?;
        left -= n as u64;
    }
    Ok(())
}

/// 顺序续传：从当前长度追加到 `total`。解码线程同时在读这个文件。
async fn download(
    url: &str,
    path: &Path,
    job: &Arc<Mutex<Job>>,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    let mut have = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let total = lock_job(job).total;
    if total == 0 {
        return Err("远端没给长度".into());
    }
    while have < total {
        if cancel.load(Ordering::SeqCst) {
            return Err("cancelled".into());
        }
        let end = (have + SLICE - 1).min(total - 1);
        let bytes = crate::media_proxy::fetch_bytes(url, have, end).await?;
        if bytes.is_empty() {
            return Err("远端没有返回数据".into());
        }
        let mut f = OpenOptions::new()
            .append(true)
            .create(true)
            .open(path)
            .map_err(|e| format!("写缓存失败：{e}"))?;
        f.write_all(&bytes).map_err(|e| format!("写缓存失败：{e}"))?;
        have += bytes.len() as u64;
        lock_job(job).downloaded = have;
    }
    Ok(())
}

/// 边下边解的「会长大的文件」：读到还没下到的位置就等 30ms 再读；
/// 末尾那块单独缓存在 `tail` 里（解封装会去读文件尾，等它下到那儿太久）。
struct GrowingFile {
    file: File,
    pos: u64,
    done: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
    waited: Duration,
    total: Option<u64>,
    tail: Option<(u64, Vec<u8>)>,
}

impl GrowingFile {
    fn open(
        path: &Path,
        done: Arc<AtomicBool>,
        cancel: Arc<AtomicBool>,
        total: Option<u64>,
        tail: Option<(u64, Vec<u8>)>,
    ) -> std::io::Result<GrowingFile> {
        Ok(GrowingFile {
            file: File::open(path)?,
            pos: 0,
            done,
            cancel,
            waited: Duration::ZERO,
            total,
            tail,
        })
    }
}

impl Read for GrowingFile {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        loop {
            if let Some((start, bytes)) = &self.tail {
                let end = *start + bytes.len() as u64;
                if self.pos >= *start && self.pos < end {
                    let i = (self.pos - start) as usize;
                    let n = buf.len().min(bytes.len() - i);
                    buf[..n].copy_from_slice(&bytes[i..i + n]);
                    self.pos += n as u64;
                    return Ok(n);
                }
            }
            let len = self.file.metadata()?.len();
            if self.pos < len {
                self.file.seek(SeekFrom::Start(self.pos))?;
                let n = self.file.read(buf)?;
                if n > 0 {
                    self.pos += n as u64;
                    return Ok(n);
                }
            }
            if self.done.load(Ordering::SeqCst)
                || self.cancel.load(Ordering::SeqCst)
                || self.waited > WAIT_LIMIT
            {
                return Ok(0);
            }
            std::thread::sleep(Duration::from_millis(30));
            self.waited += Duration::from_millis(30);
            if self.waited > Duration::from_secs(1) && (self.waited.as_millis() % 3000) < 40 {
                dlog(&format!(
                    "read wait: pos={} len={len} total={:?}",
                    self.pos, self.total
                ));
            }
        }
    }
}

impl Seek for GrowingFile {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        // 只挪逻辑位置，真正的「等数据」交给 read：seek 一旦阻塞，
        // 调用方就会在探测阶段被卡住（原来就是这么卡住的）。
        let base = self.total.unwrap_or(u64::MAX);
        let target = match pos {
            SeekFrom::Start(n) => n,
            SeekFrom::End(n) => {
                let b = base as i64;
                (b.saturating_add(n)).max(0) as u64
            }
            SeekFrom::Current(n) => (self.pos as i64).saturating_add(n).max(0) as u64,
        };
        self.pos = target.min(base);
        Ok(self.pos)
    }
}

impl MediaSource for GrowingFile {
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        // symphonia 把「没有长度」当成不可 seek 的流，probe 会直接报
        // `seek error: stream is not seekable`。远端总长是稳定的，直接告诉它。
        self.total
    }
}

/// 线性插值降到 16k。跨包保留缓冲，避免每个 packet 边界都插一次值。
struct Downsampler {
    step: f64,
    pos: f64,
    mono: Vec<f32>,
}

impl Downsampler {
    fn new(rate: f64) -> Downsampler {
        Downsampler {
            step: if rate > 0.0 { rate / TARGET_RATE } else { 1.0 },
            pos: 0.0,
            mono: Vec::new(),
        }
    }

    fn push(&mut self, interleaved: &[f32], channels: usize, out: &mut Vec<f32>) {
        let ch = channels.max(1);
        for frame in interleaved.chunks(ch) {
            let sum: f32 = frame.iter().take(ch).sum();
            self.mono.push(sum / ch as f32);
        }
        while self.pos + 1.0 < self.mono.len() as f64 {
            let i = self.pos.floor() as usize;
            let frac = (self.pos - i as f64) as f32;
            out.push(self.mono[i] * (1.0 - frac) + self.mono[i + 1] * frac);
            self.pos += self.step;
        }
        let drop = self.pos.floor() as usize;
        if drop > 0 {
            let n = drop.min(self.mono.len());
            self.mono.drain(0..n);
            self.pos -= n as f64;
        }
    }
}

fn open_format(file: GrowingFile) -> Result<Box<dyn FormatReader>, String> {
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    hint.with_extension("mp4");
    symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map(|p| p.format)
        .map_err(|e| format!("解封装失败：{e}"))
}

fn decode_file(
    path: &Path,
    model_dir: &str,
    threads: i32,
    job: Arc<Mutex<Job>>,
    cancel: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
    tail: Option<(u64, Vec<u8>)>,
) {
    // 先等一点点数据落盘，避免 probe 立刻撞到空文件。
    let total = {
        let t = lock_job(&job).total;
        if t > 0 { Some(t) } else { None }
    };
    let opened = {
        let mut tries = 0;
        loop {
            if cancel.load(Ordering::SeqCst) {
                return;
            }
            let len = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            if len >= 2 * 1024 * 1024 || done.load(Ordering::SeqCst) {
                break GrowingFile::open(path, done.clone(), cancel.clone(), total, tail.clone());
            }
            if tries > 600 {
                break GrowingFile::open(path, done.clone(), cancel.clone(), total, tail.clone());
            }
            tries += 1;
            std::thread::sleep(Duration::from_millis(50));
        }
    };
    let file = match opened {
        Ok(f) => f,
        Err(e) => {
            let mut j = lock_job(&job);
            j.stage = "error".into();
            j.error = format!("打开缓存失败：{e}");
            return;
        }
    };
    let asr = match Asr::new(model_dir, threads) {
        Ok(a) => a,
        Err(e) => {
            dlog(&format!("asr init failed: {e}"));
            let mut j = lock_job(&job);
            j.stage = "error".into();
            j.error = e;
            return;
        }
    };
    dlog("asr ready, start decode");
    if let Err(e) = decode_into(&asr, file, &job, &cancel) {
        dlog(&format!("decode error: {e}"));
        let mut j = lock_job(&job);
        if !j.error.is_empty() {
            // 下载侧已经报过错了，别覆盖
        } else {
            j.stage = "error".into();
            j.error = e;
        }
    }
}

fn decode_into(asr: &Asr, file: GrowingFile, job: &Arc<Mutex<Job>>, cancel: &Arc<AtomicBool>) -> Result<(), String> {
    dlog("probe start");
    let mut format = open_format(file)?;
    dlog("probe ok");
    // 哪条轨「真的能解」比参数齐不齐更靠谱：mp4 的 aac 轨常常不填 sample_rate/channels，
    // 而视频轨虽然有 codec 号但没有解码器。挨个试着建解码器，第一个成功的才是音轨。
    let mut decoder = None;
    let mut track_id = 0u32;
    let mut rate = 44100.0f64;
    for t in format.tracks().iter() {
        if t.codec_params.codec == CODEC_TYPE_NULL {
            continue;
        }
        if let Ok(d) = symphonia::default::get_codecs()
            .make(&t.codec_params, &DecoderOptions::default())
        {
            rate = d.codec_params().sample_rate.unwrap_or(44100) as f64;
            track_id = t.id;
            decoder = Some(d);
            break;
        }
    }
    let mut decoder = decoder.ok_or_else(|| "这个视频没有能解码的音轨".to_string())?;
    dlog(&format!("audio track id={track_id} rate={rate}"));

    let mut down = Downsampler::new(rate);
    let mut converted: Vec<f32> = Vec::with_capacity(CHUNK * 2);
    let mut buf: Option<SampleBuffer<f32>> = None;
    let mut fed: usize = 0;
    let mut started = false;
    let mut packets: u64 = 0;
    let mut seg_base = 0.0f64;
    let mut last_first = -1.0f64;
    let mut seg_abs: Vec<(f64, String)> = Vec::new();
    let mut committed: Vec<(f64, String)> = Vec::new();

    loop {
        if cancel.load(Ordering::SeqCst) {
            return Ok(());
        }
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(ref e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymError::ResetRequired) => break,
            Err(e) => return Err(format!("读包失败：{e}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        packets += 1;
        if packets == 1 {
            dlog("first audio packet");
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            // 坏帧跳过：长视频里偶发丢帧不该让整集转写失败。
            Err(SymError::DecodeError(_)) => continue,
            Err(e) => return Err(format!("解码失败：{e}")),
        };
        if !started {
            started = true;
            lock_job(job).stage = "decode".into();
        }
        let spec = *decoded.spec();
        let capacity = decoded.capacity() as u64;
        if buf.as_ref().map(|b| b.capacity() < capacity as usize).unwrap_or(true) {
            buf = Some(SampleBuffer::<f32>::new(capacity, spec));
        }
        let sb = buf.as_mut().unwrap();
        sb.copy_interleaved_ref(decoded);
        down.push(sb.samples(), spec.channels.count(), &mut converted);

        while converted.len() >= CHUNK {
            let chunk: Vec<f32> = converted.drain(0..CHUNK).collect();
            asr.feed(&chunk, TARGET_RATE as i32);
            fed += CHUNK;
            let json = asr.result().unwrap_or_else(|_| "{}".to_string());
            let (raw, text) = parse_tokens(&json);
            // sherpa 的 timestamps 是「当前这段」的相对时间；模型自己断段后要从 0 重新算。
            // 一旦发现首词时间回退，就把上一段的绝对结果固化，新段重新定基。
            if let Some((first, _)) = raw.first() {
                let first = *first;
                let fed_sec = fed as f64 / TARGET_RATE;
                if last_first >= 0.0 && first < last_first - 0.02 {
                    committed.append(&mut seg_abs);
                    seg_base = fed_sec - first;
                    dlog(&format!("segment reset at {fed_sec:.1}s"));
                }
                last_first = first;
                seg_abs = raw
                    .iter()
                    .map(|(t, w)| (seg_base + *t, w.clone()))
                    .collect();
            }
            let mut all = committed.clone();
            all.extend(seg_abs.iter().cloned());
            let mut j = lock_job(job);
            j.audio_sec = fed as f64 / TARGET_RATE;
            j.tokens = all;
            j.text = text;
            if fed / CHUNK % 30 == 0 {
                dlog(&format!(
                    "fed {}s tokens={} stage={}",
                    j.audio_sec,
                    j.tokens.len(),
                    j.stage
                ));
            }
        }
    }

    // 尾巴：把剩下的样本和攒着的特征帧解完，避免最后几秒丢字。
    if !converted.is_empty() {
        asr.feed(&converted, TARGET_RATE as i32);
        fed += converted.len();
    }
    let json = asr.drain().unwrap_or_else(|_| "{}".to_string());
    let (raw, text) = parse_tokens(&json);
    if let Some((first, _)) = raw.first() {
        let first = *first;
        if last_first >= 0.0 && first < last_first - 0.02 {
            committed.append(&mut seg_abs);
            seg_base = fed as f64 / TARGET_RATE - first;
        }
        seg_abs = raw
            .iter()
            .map(|(t, w)| (seg_base + *t, w.clone()))
            .collect();
    }
    committed.append(&mut seg_abs);
    let mut j = lock_job(job);
    j.audio_sec = fed as f64 / TARGET_RATE;
    j.tokens = committed;
    j.text = text;
    dlog(&format!("decode done: packets={packets} fed={fed} audioSec={}", j.audio_sec));
    Ok(())
}

fn parse_tokens(json: &str) -> (Vec<(f64, String)>, String) {
    let v: Value = serde_json::from_str(json).unwrap_or(Value::Null);
    let text = v.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string();
    let toks = v.get("tokens").and_then(|t| t.as_array());
    let ts = v.get("timestamps").and_then(|t| t.as_array());
    let mut out: Vec<(f64, String)> = Vec::new();
    if let (Some(toks), Some(ts)) = (toks, ts) {
        for (i, t) in toks.iter().enumerate() {
            let at = ts.get(i).and_then(|x| x.as_f64()).unwrap_or(0.0);
            let word = t.as_str().unwrap_or("").to_string();
            if !word.is_empty() {
                out.push((at, word));
            }
        }
    }
    (out, text)
}

#[tauri::command]
pub fn video_asr_poll(sid: u32, since: usize) -> Result<Value, String> {
    let job = jobs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&sid)
        .cloned()
        .ok_or_else(|| "会话不存在".to_string())?;
    let j = lock_job(&job);
    let from = since.min(j.tokens.len());
    let fresh: Vec<Value> = j.tokens[from..]
        .iter()
        .map(|(at, w)| json!([at, w]))
        .collect();
    Ok(json!({
        "stage": j.stage,
        "downloaded": j.downloaded,
        "total": j.total,
        "audioSec": j.audio_sec,
        "text": j.text,
        "tokens": fresh,
        "index": j.tokens.len(),
        "error": j.error,
    }))
}

#[tauri::command]
pub fn video_asr_cancel(sid: u32) -> Result<(), String> {
    if let Some(job) = jobs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&sid)
        .cloned()
    {
        lock_job(&job).cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// 会话结束后清掉会话（字幕按产品口径不落盘；缓存文件留着给下次续传）。
#[tauri::command]
pub fn video_asr_close(sid: u32) -> Result<(), String> {
    let job = jobs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&sid)
        .ok_or_else(|| "会话不存在".to_string())?;
    lock_job(&job).cancel.store(true, Ordering::SeqCst);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downsampler_48k_to_16k_keeps_one_third() {
        let mut d = Downsampler::new(48000.0);
        let mut out = Vec::new();
        let input: Vec<f32> = (0..4800).map(|i| (i as f32 / 4800.0)).collect();
        d.push(&input, 1, &mut out);
        assert!(out.len() >= 1598 && out.len() <= 1601, "got {}", out.len());
        assert!((out[0] - 0.0).abs() < 0.01);
    }

    #[test]
    fn downsampler_downmixes_stereo() {
        let mut d = Downsampler::new(16000.0);
        let mut out = Vec::new();
        let input = [0.4f32, 0.6, 0.4, 0.6, 0.4, 0.6, 0.4, 0.6];
        d.push(&input, 2, &mut out);
        // 线性插值要「下一个样本」，所以最后 1 帧留到下一包再出。
        assert_eq!(out.len(), 3);
        assert!((out[0] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn parse_tokens_reads_parallel_arrays() {
        let json = r#"{"text":"HELLO WORLD","tokens":["HELLO","WORLD"],"timestamps":[0.5,1.25]}"#;
        let (tokens, text) = parse_tokens(json);
        assert_eq!(text, "HELLO WORLD");
        assert_eq!(tokens.len(), 2);
        assert!((tokens[1].0 - 1.25).abs() < 1e-6);
    }
}
