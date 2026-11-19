//! sherpa-onnx 流式识别器的薄封装。
//!
//! 这里不引 bindgen（本机没有 libclang），而是按 k2-fsa/sherpa-onnx 的 c-api.h
//! 手写 FFI：结构体字段顺序与头文件一致，函数签名也一一对应。
//! 模型是 streaming zipformer（en-20M），结果里带逐 token 的时间戳。

use std::ffi::{c_char, c_int, CStr, CString};

#[repr(C)]
#[derive(Default)]
struct Transducer {
    encoder: *const c_char,
    decoder: *const c_char,
    joiner: *const c_char,
}

#[repr(C)]
#[derive(Default)]
struct Paraformer {
    encoder: *const c_char,
    decoder: *const c_char,
}

#[repr(C)]
#[derive(Default)]
struct Zipformer2Ctc {
    model: *const c_char,
}

#[repr(C)]
#[derive(Default)]
struct NemoCtc {
    model: *const c_char,
}

#[repr(C)]
#[derive(Default)]
struct ToneCtc {
    model: *const c_char,
}

#[repr(C)]
#[derive(Default)]
struct OnlineModelConfig {
    transducer: Transducer,
    paraformer: Paraformer,
    zipformer2_ctc: Zipformer2Ctc,
    tokens: *const c_char,
    num_threads: c_int,
    provider: *const c_char,
    debug: c_int,
    model_type: *const c_char,
    modeling_unit: *const c_char,
    bpe_vocab: *const c_char,
    tokens_buf: *const c_char,
    tokens_buf_size: c_int,
    nemo_ctc: NemoCtc,
    t_one_ctc: ToneCtc,
}

#[repr(C)]
#[derive(Default)]
struct FeatureConfig {
    sample_rate: c_int,
    feature_dim: c_int,
}

#[repr(C)]
#[derive(Default)]
struct CtcFstDecoderConfig {
    graph: *const c_char,
    max_active: c_int,
}

#[repr(C)]
#[derive(Default)]
struct HomophoneReplacerConfig {
    dict_dir: *const c_char,
    lexicon: *const c_char,
    rule_fsts: *const c_char,
}

#[repr(C)]
#[derive(Default)]
struct OnlineRecognizerConfig {
    feat_config: FeatureConfig,
    model_config: OnlineModelConfig,
    decoding_method: *const c_char,
    max_active_paths: c_int,
    enable_endpoint: c_int,
    rule1_min_trailing_silence: f32,
    rule2_min_trailing_silence: f32,
    rule3_min_utterance_length: f32,
    hotwords_file: *const c_char,
    hotwords_score: f32,
    ctc_fst_decoder_config: CtcFstDecoderConfig,
    rule_fsts: *const c_char,
    rule_fars: *const c_char,
    blank_penalty: f32,
    hotwords_buf: *const c_char,
    hotwords_buf_size: c_int,
    hr: HomophoneReplacerConfig,
}

enum Recognizer {}
enum Stream {}

extern "C" {
    fn SherpaOnnxCreateOnlineRecognizer(
        config: *const OnlineRecognizerConfig,
    ) -> *const Recognizer;
    fn SherpaOnnxDestroyOnlineRecognizer(r: *const Recognizer);
    fn SherpaOnnxCreateOnlineStream(r: *const Recognizer) -> *const Stream;
    fn SherpaOnnxDestroyOnlineStream(s: *const Stream);
    fn SherpaOnnxOnlineStreamAcceptWaveform(
        s: *const Stream,
        sample_rate: c_int,
        samples: *const f32,
        n: c_int,
    );
    fn SherpaOnnxIsOnlineStreamReady(r: *const Recognizer, s: *const Stream) -> c_int;
    fn SherpaOnnxDecodeOnlineStream(r: *const Recognizer, s: *const Stream);
    fn SherpaOnnxGetOnlineStreamResultAsJson(r: *const Recognizer, s: *const Stream)
        -> *const c_char;
    fn SherpaOnnxDestroyOnlineStreamResultJson(s: *const c_char);
    fn SherpaOnnxOnlineStreamReset(r: *const Recognizer, s: *const Stream);
}

/// 模型目录里的 `model.json` 决定用哪套文件、哪种结构。
/// 老版本只有固定的 epoch 文件名，没有 model.json，按 transducer 兜底。
pub struct ModelSpec {
    pub kind: String,
    pub encoder: String,
    pub decoder: String,
    pub joiner: String,
}

impl ModelSpec {
    fn load(dir: &str) -> ModelSpec {
        let mut spec = ModelSpec {
            kind: "transducer".to_string(),
            encoder: "encoder-epoch-99-avg-1.int8.onnx".to_string(),
            decoder: "decoder-epoch-99-avg-1.int8.onnx".to_string(),
            joiner: "joiner-epoch-99-avg-1.int8.onnx".to_string(),
        };
        let raw = match std::fs::read_to_string(format!("{dir}/model.json")) {
            Ok(text) => text,
            Err(_) => return spec,
        };
        let v: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => return spec,
        };
        if let Some(kind) = v.get("type").and_then(|x| x.as_str()) {
            spec.kind = kind.to_string();
        }
        let file = |key: &str| v
            .get("files")
            .and_then(|f| f.get(key))
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        if let Some(x) = file("encoder") {
            spec.encoder = x;
        }
        if let Some(x) = file("decoder") {
            spec.decoder = x;
        }
        if let Some(x) = file("joiner") {
            spec.joiner = x;
        }
        spec
    }
}

pub struct Asr {
    rec: *const Recognizer,
    st: *const Stream,
}

// sherpa 的 recognizer/stream 内部自带锁，这里只是把裸指针交给别的线程用。
unsafe impl Send for Asr {}

impl Asr {
    pub fn new(model_dir: &str, threads: i32) -> Result<Asr, String> {
        let spec = ModelSpec::load(model_dir);
        let path = |name: &str| -> *const c_char {
            CString::new(format!("{model_dir}/{name}"))
                .map(|c| c.into_raw() as *const c_char)
                .unwrap_or(std::ptr::null())
        };
        let mut cfg: OnlineRecognizerConfig = Default::default();
        cfg.feat_config.sample_rate = 16000;
        cfg.feat_config.feature_dim = 80;
        if spec.kind == "paraformer" {
            cfg.model_config.paraformer = Paraformer {
                encoder: path(&spec.encoder),
                decoder: path(&spec.decoder),
            };
            cfg.model_config.model_type = CString::new("paraformer").unwrap().into_raw();
        } else {
            cfg.model_config.transducer = Transducer {
                encoder: path(&spec.encoder),
                decoder: path(&spec.decoder),
                joiner: path(&spec.joiner),
            };
        }
        cfg.model_config.tokens = path("tokens.txt");
        cfg.model_config.num_threads = threads.max(1);
        cfg.model_config.provider = CString::new("cpu").unwrap().into_raw();
        // 端点检测关掉：播客里几乎一直在说话，端点在连续语音里会连续为真，
        // 断句交给页面按「一行最长 12 秒 / 40 词」自己切。
        cfg.enable_endpoint = 0;
        cfg.decoding_method = CString::new("greedy_search").unwrap().into_raw();
        cfg.rule1_min_trailing_silence = 2.4;
        cfg.rule2_min_trailing_silence = 1.2;
        cfg.rule3_min_utterance_length = 20.0;
        unsafe {
            let rec = SherpaOnnxCreateOnlineRecognizer(&cfg);
            if rec.is_null() {
                return Err(format!("sherpa 识别器创建失败（模型目录：{model_dir}）"));
            }
            let st = SherpaOnnxCreateOnlineStream(rec);
            if st.is_null() {
                SherpaOnnxDestroyOnlineRecognizer(rec);
                return Err("sherpa 流创建失败".to_string());
            }
            Ok(Asr { rec, st })
        }
    }

    /// 喂一段 16 kHz 单声道浮点采样（[-1,1]）。
    pub fn feed(&self, samples: &[f32], sample_rate: i32) {
        if samples.is_empty() {
            return;
        }
        unsafe {
            SherpaOnnxOnlineStreamAcceptWaveform(
                self.st,
                sample_rate as c_int,
                samples.as_ptr(),
                samples.len() as c_int,
            );
        }
    }

    /// 把攒够的特征帧解完，返回当前结果 JSON（`{text,tokens,timestamps}`）。
    pub fn result(&self) -> Result<String, String> {
        unsafe {
            let mut loops = 0;
            while SherpaOnnxIsOnlineStreamReady(self.rec, self.st) == 1 && loops < 32 {
                SherpaOnnxDecodeOnlineStream(self.rec, self.st);
                loops += 1;
            }
            let p = SherpaOnnxGetOnlineStreamResultAsJson(self.rec, self.st);
            if p.is_null() {
                return Ok("{}".to_string());
            }
            let s = CStr::from_ptr(p).to_string_lossy().into_owned();
            SherpaOnnxDestroyOnlineStreamResultJson(p);
            Ok(s)
        }
    }

    pub fn reset(&self) {
        unsafe { SherpaOnnxOnlineStreamReset(self.rec, self.st) }
    }

    /// 还有没有攒着没解的特征帧。
    pub fn ready(&self) -> bool {
        unsafe { SherpaOnnxIsOnlineStreamReady(self.rec, self.st) == 1 }
    }

    /// 一直解到没有可解的帧为止；返回最后一次结果 JSON。
    /// 整集转写必须用这个，不然一次 `result()` 只解 32 帧，
    /// 长音频会越积越多，最后只出开头几秒。
    pub fn drain(&self) -> Result<String, String> {
        let mut last = String::from("{}");
        loop {
            last = self.result()?;
            if !self.ready() {
                break;
            }
        }
        Ok(last)
    }
}

impl Drop for Asr {
    fn drop(&mut self) {
        unsafe {
            SherpaOnnxDestroyOnlineStream(self.st);
            SherpaOnnxDestroyOnlineRecognizer(self.rec);
        }
    }
}
