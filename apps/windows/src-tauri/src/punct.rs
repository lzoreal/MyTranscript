//! 离线标点：sherpa-onnx 的流式英文标点模型（cnn_bilstm + bpe.vocab）。
//! 纯本地，不联网；模型目录里优先用 int8。
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};

#[repr(C)]
struct PunctModelConfig {
    cnn_bilstm: *const c_char,
    bpe_vocab: *const c_char,
    num_threads: c_int,
    debug: c_int,
    provider: *const c_char,
}

#[repr(C)]
struct PunctConfig {
    model: PunctModelConfig,
}

enum Punctuation {}

extern "C" {
    fn SherpaOnnxCreateOnlinePunctuation(
        config: *const PunctConfig,
    ) -> *const Punctuation;
    fn SherpaOnnxDestroyOnlinePunctuation(p: *const Punctuation);
    fn SherpaOnnxOnlinePunctuationAddPunct(
        p: *const Punctuation,
        text: *const c_char,
    ) -> *const c_char;
    fn SherpaOnnxOnlinePunctuationFreeText(text: *const c_char);
}

pub struct Punct {
    p: *const Punctuation,
    last_in: std::sync::Mutex<String>,
    last_out: std::sync::Mutex<String>,
}

unsafe impl Send for Punct {}
unsafe impl Sync for Punct {}

impl Punct {
    pub fn new(model_dir: &str) -> Option<Punct> {
        let dir = std::path::Path::new(model_dir);
        let model = ["model.int8.onnx", "model.onnx"]
            .iter()
            .map(|n| dir.join(n))
            .find(|p| p.exists())?;
        let vocab = dir.join("bpe.vocab");
        if !vocab.exists() {
            return None;
        }
        let model_c = CString::new(model.to_string_lossy().to_string()).ok()?;
        let vocab_c = CString::new(vocab.to_string_lossy().to_string()).ok()?;
        let cfg = PunctConfig {
            model: PunctModelConfig {
                cnn_bilstm: model_c.as_ptr(),
                bpe_vocab: vocab_c.as_ptr(),
                num_threads: 1,
                debug: 0,
                provider: std::ptr::null(),
            },
        };
        unsafe {
            let p = SherpaOnnxCreateOnlinePunctuation(&cfg);
            if p.is_null() {
                return None;
            }
            Some(Punct {
                p,
                last_in: std::sync::Mutex::new(String::new()),
                last_out: std::sync::Mutex::new(String::new()),
            })
        }
    }

    pub fn add(&self, text: &str) -> String {
        if text.is_empty() {
            return String::new();
        }
        {
            let last = self.last_in.lock().unwrap_or_else(|e| e.into_inner());
            if *last == text {
                return self
                    .last_out
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone();
            }
        }
        let Ok(c) = CString::new(text) else {
            return text.to_string();
        };
        let out = unsafe {
            let p = SherpaOnnxOnlinePunctuationAddPunct(self.p, c.as_ptr());
            if p.is_null() {
                None
            } else {
                let s = CStr::from_ptr(p).to_string_lossy().into_owned();
                SherpaOnnxOnlinePunctuationFreeText(p);
                Some(s)
            }
        };
        let out = out.unwrap_or_else(|| text.to_string());
        *self.last_in.lock().unwrap_or_else(|e| e.into_inner()) = text.to_string();
        *self.last_out.lock().unwrap_or_else(|e| e.into_inner()) = out.clone();
        out
    }
}

impl Drop for Punct {
    fn drop(&mut self) {
        unsafe { SherpaOnnxDestroyOnlinePunctuation(self.p) }
    }
}
