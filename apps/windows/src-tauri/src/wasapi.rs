//! WASAPI 设备级 loopback 采集（spike 版）。
//!
//! 只做最小闭环：默认渲染设备的混音 → 下混单声道 → 低通 → 降到 16 kHz。
//! 不做设备热插拔恢复、不做进程级捕获，这两件事等延迟数据出来再说。

use std::ffi::c_void;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use windows::core::{implement, Interface, Ref, PWSTR};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Media::Audio::{
    eConsole, eRender, ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
    IAudioCaptureClient, IAudioClient, IAudioSessionControl2, IAudioSessionManager2,
    IMMDeviceEnumerator, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
    AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, AudioSessionStateActive, MMDeviceEnumerator,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED, BLOB,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Variant::VT_BLOB;

const WAVE_FORMAT_PCM: u16 = 1;
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;

static TRACE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

pub fn trace_on() -> bool {
    *TRACE.get_or_init(|| std::env::var("MT_TRACE").is_ok())
}

macro_rules! trace {
    ($($t:tt)*) => {
        if crate::wasapi::trace_on() {
            eprintln!($($t)*);
        }
    };
}

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct ActivationHandler {
    done: Arc<AtomicBool>,
}
impl IActivateAudioInterfaceCompletionHandler_Impl for ActivationHandler_Impl {
    fn ActivateCompleted(
        &self,
        _op: Ref<'_, IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        self.done.store(true, Ordering::SeqCst);
        Ok(())
    }
}

#[derive(Clone)]
pub struct AudioSessionInfo {
    pub pid: u32,
    pub name: String,
    pub active: bool,
}

fn process_name(pid: u32) -> String {
    if pid == 0 {
        return String::new();
    }
    unsafe {
        let handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(h) => h,
            Err(_) => return String::new(),
        };
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(handle);
        if !ok || len == 0 {
            return String::new();
        }
        let full = String::from_utf16_lossy(&buf[..len as usize]);
        std::path::Path::new(&full)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or(full)
    }
}

/// 枚举默认播放设备上正在/最近出声的会话，按「正在出声优先、名字排序」返回。
pub fn audio_sessions() -> Result<Vec<AudioSessionInfo>, String> {
    unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(None, COINIT_MULTITHREADED);
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|e| format!("创建设备枚举器失败：{e}"))?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|e| format!("没有默认播放设备：{e}"))?;
        let manager: IAudioSessionManager2 = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| format!("打开音频会话管理器失败：{e}"))?;
        let list = manager
            .GetSessionEnumerator()
            .map_err(|e| format!("取会话列表失败：{e}"))?;
        let count = list.GetCount().map_err(|e| format!("读会话数量失败：{e}"))?;

        let mut out: Vec<AudioSessionInfo> = Vec::new();
        for i in 0..count {
            let Ok(ctrl) = list.GetSession(i) else { continue };
            let Ok(ctrl2) = ctrl.cast::<IAudioSessionControl2>() else { continue };
            let pid = ctrl2.GetProcessId().unwrap_or(0);
            if pid == 0 || pid == std::process::id() {
                continue;
            }
            if out.iter().any(|s| s.pid == pid) {
                continue;
            }
            let active = ctrl
                .GetState()
                .map(|s| s.0 == AudioSessionStateActive.0)
                .unwrap_or(false);
            let name = process_name(pid);
            if name.is_empty() {
                continue;
            }
            out.push(AudioSessionInfo { pid, name, active });
        }
        out.sort_by(|a, b| (!a.active, a.name.to_lowercase()).cmp(&(!b.active, b.name.to_lowercase())));
        Ok(out)
    }
}

pub struct Capture {
    client: IAudioClient,
    capture: IAudioCaptureClient,
    pub device_id: String,
    pub channels: usize,
    pub is_float: bool,
    pub bits: u16,
    step: f64,
    phase: f64,
    lp: Option<Biquad>,
}

impl Capture {
    pub fn open() -> Result<Capture, String> {
        unsafe {
            let init = windows::Win32::System::Com::CoInitializeEx(
                None,
                COINIT_MULTITHREADED,
            );
            // RPC_E_CHANGED_MODE 之类不算致命，继续往下走。
            let _ = init;

            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                    .map_err(|e| format!("创建设备枚举器失败：{e}"))?;
            let device = enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(|e| format!("没有默认播放设备：{e}"))?;
            let device_id = device
                .GetId()
                .map(|id| pwstr_to_string(id))
                .unwrap_or_default();
            let client: IAudioClient = device
                .Activate(CLSCTX_ALL, None)
                .map_err(|e| format!("打开播放设备失败：{e}"))?;

            let fmt = client
                .GetMixFormat()
                .map_err(|e| format!("读取混音格式失败：{e}"))?;
            // WAVEFORMATEX 是 packed 结构，不能直接取字段引用，先按值拷出来。
            let wf = ptr::read_unaligned(fmt as *const WAVEFORMATEX);
            let tag = wf.wFormatTag;
            let mut channels = wf.nChannels as usize;
            let mut bits = wf.wBitsPerSample;
            let mut is_float = tag == WAVE_FORMAT_IEEE_FLOAT;
            let mut is_pcm16 = tag == WAVE_FORMAT_PCM && bits == 16;
            let mut is_pcm32 = tag == WAVE_FORMAT_PCM && bits == 32;

            if tag == WAVE_FORMAT_EXTENSIBLE {
                if wf.cbSize < 22 {
                    return Err("EXTENSIBLE 格式缺子格式信息".to_string());
                }
                let ext = ptr::read_unaligned(fmt as *const WAVEFORMATEXTENSIBLE);
                channels = ext.Format.nChannels as usize;
                bits = ext.Format.wBitsPerSample;
                // data1 == 3 → IEEE float，== 1 → PCM（GUID 其余字节固定）
                match ext.SubFormat.data1 {
                    3 => {
                        is_float = true;
                        is_pcm16 = false;
                        is_pcm32 = false;
                    }
                    1 => {
                        is_float = false;
                        is_pcm16 = bits == 16;
                        is_pcm32 = bits == 32;
                    }
                    other => {
                        return Err(format!("不支持的混音子格式 data1={other}"));
                    }
                }
            }

            if !(is_float || is_pcm16 || is_pcm32) {
                return Err(format!(
                    "不支持的混音格式 tag={} bits={} ch={}",
                    tag, bits, channels
                ));
            }

            client
                .Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_LOOPBACK,
                    0,
                    0,
                    fmt,
                    None,
                )
                .map_err(|e| format!("初始化 loopback 失败：{e}"))?;
            CoTaskMemFree(Some(fmt as *const c_void));

            let capture: IAudioCaptureClient = client
                .GetService()
                .map_err(|e| format!("取捕获接口失败：{e}"))?;
            client.Start().map_err(|e| format!("启动采集失败：{e}"))?;

            let src_rate = wf.nSamplesPerSec;
            let step = src_rate as f64 / 16000.0;
            let lp = if src_rate > 16000 {
                Some(Biquad::lowpass(7000.0, src_rate as f64))
            } else {
                None
            };

            Ok(Capture {
                client,
                capture,
                device_id,
                channels,
                is_float,
                bits,
                step,
                phase: 0.0,
                lp,
            })
        }
    }

    /// 进程级 loopback：只抓指定进程树（含子进程）渲染出来的声音。
    ///
    /// 走 `ActivateAudioInterfaceAsync` + `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`，
    /// 需要 Windows 10 build 20348 以上；旧系统会直接返回错误。
    pub fn open_process(pid: u32) -> Result<Capture, String> {
        unsafe {
            let _ = windows::Win32::System::Com::CoInitializeEx(None, COINIT_MULTITHREADED);

            let mut params = AUDIOCLIENT_ACTIVATION_PARAMS::default();
            params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
            params.Anonymous.ProcessLoopbackParams = AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
            };
            // 激活参数必须比 IAudioClient 活得久：引擎在流启动后仍可能读这块内存。
            // 用 Box + leak 固定住，一次会话只泄漏这几十字节。
            let params = Box::leak(Box::new(params));
            let pv = Box::leak(Box::new(PROPVARIANT::default()));
            {
                // PROPVARIANT 里是 ManuallyDrop，必须显式解引用再写。
                let inner: &mut windows::Win32::System::Com::StructuredStorage::PROPVARIANT_0_0 =
                    &mut *pv.Anonymous.Anonymous;
                inner.vt = VT_BLOB;
                inner.Anonymous.blob = BLOB {
                    cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                    pBlobData: params as *mut AUDIOCLIENT_ACTIVATION_PARAMS as *mut u8,
                };
            }

            let done = Arc::new(AtomicBool::new(false));
            let handler: IActivateAudioInterfaceCompletionHandler =
                ActivationHandler { done: done.clone() }.into();
            trace!("[proc] 准备 ActivateAudioInterfaceAsync");
            let op = ActivateAudioInterfaceAsync(
                VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                &IAudioClient::IID,
                Some(&*pv),
                &handler,
            )
            .map_err(|e| format!("发起进程 loopback 激活失败：{e}"))?;
            // 系统会在回调完成后自己释放 handler；这里故意不 drop，避免重复释放。
            std::mem::forget(handler);
            trace!("[proc] 已发起，等回调");

            for _ in 0..400 {
                if done.load(Ordering::SeqCst) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            trace!("[proc] 回调完成={}", done.load(Ordering::SeqCst));
            if !done.load(Ordering::SeqCst) {
                return Err("等待进程 loopback 激活超时".to_string());
            }

            let mut hr = windows::core::HRESULT(0);
            let mut unk: Option<windows::core::IUnknown> = None;
            trace!("[proc] 取激活结果");
            op.GetActivateResult(&mut hr, &mut unk)
                .map_err(|e| format!("取进程 loopback 激活结果失败：{e}"))?;
            trace!("[proc] hr={hr:?} unk={}", unk.is_some());
            if hr.is_err() {
                return Err(format!("进程 loopback 激活返回错误：{hr:?}"));
            }
            let client: IAudioClient = unk
                .ok_or_else(|| "进程 loopback 没有返回接口".to_string())?
                .cast()
                .map_err(|e| format!("进程 loopback 接口转换失败：{e}"))?;
            trace!("[proc] 拿到 IAudioClient");

            // 引擎会按给定格式重采样；先试最常见的几种。
            let mut chosen: Option<WAVEFORMATEX> = None;
            for (tag, bits, rate, ch) in [
                (WAVE_FORMAT_PCM, 16u16, 48000u32, 2u16),
                (WAVE_FORMAT_PCM, 16, 44100, 2),
                (WAVE_FORMAT_IEEE_FLOAT, 32, 48000, 2),
            ] {
                let block = ch * bits / 8;
                let wf = WAVEFORMATEX {
                    wFormatTag: tag,
                    nChannels: ch,
                    nSamplesPerSec: rate,
                    nAvgBytesPerSec: rate * block as u32,
                    nBlockAlign: block,
                    wBitsPerSample: bits,
                    cbSize: 0,
                };
                if client
                    .Initialize(
                        AUDCLNT_SHAREMODE_SHARED,
                        AUDCLNT_STREAMFLAGS_LOOPBACK,
                        0,
                        0,
                        &wf,
                        None,
                    )
                    .is_ok()
                {
                    trace!("[proc] 格式被接受：{rate}/{ch}ch/{bits}bit tag={tag}");
                    chosen = Some(wf);
                    break;
                } else {
                    trace!("[proc] 格式被拒：{rate}/{ch}ch/{bits}bit tag={tag}");
                }
            }
            let wf = chosen.ok_or_else(|| {
                "进程 loopback 初始化失败：常见格式都不被接受".to_string()
            })?;
            let tag = wf.wFormatTag;
            let channels = wf.nChannels as usize;
            let bits = wf.wBitsPerSample;
            let is_float = tag == WAVE_FORMAT_IEEE_FLOAT;
            let src_rate = wf.nSamplesPerSec;

            let capture: IAudioCaptureClient = client
                .GetService()
                .map_err(|e| format!("取进程捕获接口失败：{e}"))?;
            trace!("[proc] 拿到 IAudioCaptureClient");
            client
                .Start()
                .map_err(|e| format!("启动进程 loopback 失败：{e}"))?;
            trace!("[proc] 已 Start");

            let step = src_rate as f64 / 16000.0;
            let lp = if src_rate > 16000 {
                Some(Biquad::lowpass(7000.0, src_rate as f64))
            } else {
                None
            };

            trace!("[proc] 构造 Capture");
            std::mem::forget(op);
            Ok(Capture {
                client,
                capture,
                device_id: format!("pid:{pid}"),
                channels,
                is_float,
                bits,
                step,
                phase: 0.0,
                lp,
            })
        }
    }

    /// 把缓冲区里现成的包全部取走，追加成 16 kHz 单声道样本。
    pub fn pump(&mut self, out: &mut Vec<f32>) -> Result<usize, String> {
        let mut produced = 0usize;
        loop {
            trace!("[pump] 读包大小");
            let packet = unsafe { self.capture.GetNextPacketSize() }
                .map_err(|e| format!("读包大小失败：{e}"))?;
            if packet == 0 {
                break;
            }
            trace!("[pump] packet={packet}");

            let mut data: *mut u8 = ptr::null_mut();
            let mut frames = 0u32;
            let mut flags = 0u32;
            let ok = unsafe {
                self.capture.GetBuffer(
                    &mut data,
                    &mut frames,
                    &mut flags,
                    None,
                    None,
                )
            };
            if let Err(e) = ok {
                // 设备被拔掉 / 格式变了：spike 里直接结束，交给上层报错。
                return Err(format!("取音频包失败（设备可能已变更）：{e}"));
            }

            let before = out.len();
            trace!("[pump] frames={frames} flags={flags:#x} null={}", data.is_null());
            if frames > 0 {
                let silent = flags & 0x2 != 0; // AUDCLNT_BUFFERFLAGS_SILENT
                if silent || data.is_null() {
                    out.extend(std::iter::repeat(0.0f32).take(frames as usize));
                } else {
                    unsafe { self.convert(data, frames, out) };
                }
                produced += out.len() - before;
            }

            unsafe { self.capture.ReleaseBuffer(frames) }
                .map_err(|e| format!("释放音频包失败：{e}"))?;
        }
        Ok(produced)
    }

    unsafe fn convert(&mut self, data: *mut u8, frames: u32, out: &mut Vec<f32>) {
        let ch = self.channels.max(1);
        for f in 0..frames as usize {
            let mut sum = 0.0f32;
            for c in 0..ch {
                let idx = f * ch + c;
                let s = if self.is_float {
                    *(data as *const f32).add(idx)
                } else if self.bits == 16 {
                    (*(data as *const i16).add(idx) as f32) / 32768.0
                } else {
                    (*(data as *const i32).add(idx) as f32) / 2147483648.0
                };
                sum += s;
            }
            let mono = sum / ch as f32;
            let filtered = match &mut self.lp {
                Some(lp) => lp.process(mono),
                None => mono,
            };

            // 最近邻抽取（前面已经低通，抽取抖动在 44.1k 上也只有 ±11µs）
            self.phase += 1.0;
            while self.phase >= self.step {
                self.phase -= self.step;
                out.push(filtered);
            }
        }
    }

    pub fn stop(&self) {
        unsafe {
            let _ = self.client.Stop();
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        unsafe {
            let _ = self.client.Stop();
        }
    }
}

/// 当前默认渲染设备的 id；用于字幕运行中检测「耳机/扬声器切走」。
pub fn default_render_id() -> Result<String, String> {
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| format!("创建设备枚举器失败：{e}"))?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|e| format!("没有默认播放设备：{e}"))?;
        device
            .GetId()
            .map(|id| pwstr_to_string(id))
            .map_err(|e| format!("读设备 id 失败：{e}"))
    }
}

fn pwstr_to_string(p: windows::core::PWSTR) -> String {
    unsafe {
        if p.0.is_null() {
            return String::new();
        }
        let mut len = 0usize;
        while *(p.0 as *const u16).add(len) != 0 {
            len += 1;
        }
        let s = String::from_utf16_lossy(std::slice::from_raw_parts(p.0 as *const u16, len));
        CoTaskMemFree(Some(p.0 as *const c_void));
        s
    }
}

/// RBJ 二阶低通，Q=0.707（Butterworth 响应），用来抑制抽取前的混叠。
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    fn lowpass(fc: f64, fs: f64) -> Biquad {
        let w0 = 2.0 * std::f64::consts::PI * fc / fs;
        let cos = w0.cos();
        let alpha = w0.sin() / (2.0 * 0.7071);
        let a0 = 1.0 + alpha;
        Biquad {
            b0: ((1.0 - cos) / 2.0 / a0) as f32,
            b1: ((1.0 - cos) / a0) as f32,
            b2: ((1.0 - cos) / 2.0 / a0) as f32,
            a1: (-2.0 * cos / a0) as f32,
            a2: ((1.0 - alpha) / a0) as f32,
            z1: 0.0,
            z2: 0.0,
        }
    }

    fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}
