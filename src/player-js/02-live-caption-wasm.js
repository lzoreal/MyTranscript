import { $, LIVE, LIVE_BUDGET_MS, LIVE_FETCH, LIVE_LEAD_DEFAULT, LIVE_RATE, LIVE_SLICE, LIVE_TR_BATCH, audio, host, prefs, state, tauriHost } from './00-runtime.js';

import { lazyFn, registerLayer } from './00-layers.js';
const liveClearRows = lazyFn('03-native-asr-service-worker', 'liveClearRows');
const liveDisable = lazyFn('03-native-asr-service-worker', 'liveDisable');
const liveNativeLoad = lazyFn('03-native-asr-service-worker', 'liveNativeLoad');
const liveRebuildStream = lazyFn('03-native-asr-service-worker', 'liveRebuildStream');
const liveRenderLine = lazyFn('03-native-asr-service-worker', 'liveRenderLine');
/* layer: bridge —— 实时字幕桥、平台宿主入口
   本片只做该层的事，跨层调用走 kernel / host() / setState。 */

/* ---------- 实时逐词字幕（实验功能，默认关闭） ----------
   链路：音频 URL（需 CORS）→ 拉取整个音频文件 → 扫 MP3 帧建「字节↔时间」索引
    → 按「播放位置 + 提前量」解码出 16 kHz 单声道 PCM 喂给 Moonshine 流式识别
    （cross-attention + DTW 的词级时间戳）→ 时间轴映射 → 正文逐词渲染。
   用解码而不是 Web Audio 采集，是因为采集只能拿到「已经播出去」的音频，永远
   落后于播放头；要提前 s 秒生成，必须自己把还没播到的音频解出来。关闭后正文
   立刻回到原本的 VTT / 词级 JSON 渲染，原有播放、重试、跳转逻辑不受影响。 */
const LIVE_ENGINE = 'https://cdn.jsdelivr.net/npm/@moonshine-ai/moonshine-wasm@0.1.6/dist/index.js';
/* 识别引擎接缝：适配器只暴露 { load() → engine }，engine 形状由 liveStartStream 约定
   （addAudio / transcribe / stop / close）。换引擎时只加一个适配器，不动调用方。 */
const TRANSCRIBER_ADAPTERS = new Map();
function registerTranscriber(kind, adapter) {
  if (!kind || !adapter || typeof adapter.load !== 'function') throw new Error('识别适配器需要 kind 和 load()');
  TRANSCRIBER_ADAPTERS.set(String(kind), adapter);
}
function transcriberFor(kind) { return TRANSCRIBER_ADAPTERS.get(String(kind)) || null; }

/* 核心能力接缝：目录 / 播放 / 下载 / 队列都可以被插件替换。
   默认实现就是宿主原来的函数；插件用 api.registerProvider(name, impl) 覆盖，
   停用或重载时自动回退。覆盖实现可以调 provider.fallback 回到原行为。 */
const CORE_PROVIDER_NAMES = ['catalog', 'playback', 'downloads', 'queue'];
const CORE_PROVIDER_DEFAULTS = new Map();
const CORE_PROVIDER_STACKS = new Map();
function defineCoreProvider(name, impl) {
  const key = String(name);
  if (!CORE_PROVIDER_NAMES.includes(key)) throw new Error('未知核心能力：' + key);
  if (!CORE_PROVIDER_DEFAULTS.has(key)) CORE_PROVIDER_DEFAULTS.set(key, impl);
}
/* 覆盖实现按注册顺序入栈；停用/重载只摘掉自己那层，恢复上一层（最后回到默认实现）。 */
function registerCoreProvider(ownerId, name, impl) {
  const key = String(name);
  if (!CORE_PROVIDER_NAMES.includes(key)) throw new Error('未知核心能力：' + key);
  const shape = CORE_PROVIDER_DEFAULTS.get(key) || {};
  Object.keys(shape).forEach(fn => {
    if (typeof (impl && impl[fn]) !== 'function') {
      throw new Error('核心能力 ' + key + ' 需要实现 ' + fn + '()');
    }
  });
  const stack = CORE_PROVIDER_STACKS.get(key) || [];
  stack.push({ owner: String(ownerId), impl });
  CORE_PROVIDER_STACKS.set(key, stack);
}
function coreProviderLayer(name) {
  const stack = CORE_PROVIDER_STACKS.get(String(name)) || [];
  return stack.length ? stack[stack.length - 1] : null;
}
function coreProvider(name) {
  const key = String(name);
  const fallback = CORE_PROVIDER_DEFAULTS.get(key) || {};
  const hit = coreProviderLayer(key);
  return Object.freeze({ ...(hit ? hit.impl : fallback), owner: hit ? hit.owner : '', fallback });
}
function releaseCoreProviders(ownerId) {
  const key = String(ownerId);
  CORE_PROVIDER_STACKS.forEach((stack, name) => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (stack[i].owner === key) stack.splice(i, 1);
    }
    if (!stack.length) CORE_PROVIDER_STACKS.delete(name);
  });
}
function coreProviderOwner(name) {
  const hit = coreProviderLayer(name);
  return hit ? hit.owner : '';
}

const LIVE_ARCH = (() => {
  // ModelArch：2=TinyStreaming（默认）、3=BaseStreaming、4=SmallStreaming、5=MediumStreaming。
  // 加 ?arch=3 这类参数可以临时换成更大的模型做对比，不用改代码再刷一遍。
  const m = /[?&]arch=(\d+)/.exec(location.search);
  const v = m ? Number(m[1]) : 2;
  return [2, 3, 4, 5].includes(v) ? v : 2;
})();
// 识别引擎：默认 sherpa-onnx 流式 zipformer（带逐 token 时间戳）。
// 桌面壳（Tauri）里优先走「原生推理」：ASR 在 Rust 侧跑 sherpa-onnx 的 DLL，
// 不占 WebView 的 JS 线程，也不依赖 COOP/COEP。没有壳时退回 WASM 版 sherpa；
// 加 ?engine=moonshine 退回 Moonshine 流式（它基本不给词时间，逐词高亮只能均分）。
const LIVE_ENGINE_ARG = (() => {
  const m = /[?&]engine=(\w+)/.exec(location.search);
  return m ? m[1] : '';
})();
const LIVE_ENGINE_KIND = LIVE_ENGINE_ARG === 'moonshine' ? 'moonshine'
  : LIVE_ENGINE_ARG === 'wasm' ? 'sherpa'
  : (tauriHost() && tauriHost().core ? 'native' : 'sherpa');
const SHERPA_CDN = 'https://cdn.jsdelivr.net/npm/@siteed/sherpa-onnx.rn@1.1.2/wasm/';
// github 的 tar.bz2 在浏览器里解不了，所以从 Hugging Face 按单文件取（和我们取音频一样走 XHR）。
const SHERPA_BASE = 'https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17/resolve/main/';
const SHERPA_FILES = {
  encoder: 'encoder-epoch-99-avg-1.int8.onnx',
  decoder: 'decoder-epoch-99-avg-1.int8.onnx',
  joiner: 'joiner-epoch-99-avg-1.int8.onnx',
  tokens: 'tokens.txt',
};
// 流式 zipformer 在「发出 token 的 encoder 帧」上报时间，比词的真实起点晚一个 chunk。
// AntennaPod 在 en-20M 上实测中位 400 ms，这里照抄同一个常数。
const SHERPA_LAG = 0.4;
const SHERPA_CACHE = 'myt-sherpa-model';

function liveMediaTime() {
  return (audio.currentTime || 0) + (state.timeScale - 1) * state.seekRaw;
}
// 喂给识别的是媒体时间上连续的 PCM，倍速不影响这条时间轴，所以只是一个起点偏移。
function liveMediaOf(sec) {
  return LIVE.anchorMedia + Number(sec || 0);
}
let liveBarHideTimer = 0;
function clearLiveBarTimer() {
  if (liveBarHideTimer) { clearTimeout(liveBarHideTimer); liveBarHideTimer = 0; }
}
function liveSetText(text, cls) {
  $('liveText').textContent = text;
  const bar = $('liveBar');
  bar.classList.toggle('err', cls === 'err');
  bar.classList.toggle('busy', cls === 'busy');
  // 正常识别时状态条不该常驻在正文顶上：等状态稳定 2.5 秒自动收起，
  // 只有启动/下载/出错/重试这些需要人看一眼的状态才留在屏幕上。
  if (cls === 'on') {
    if (!liveBarHideTimer) {
      liveBarHideTimer = setTimeout(() => {
        liveBarHideTimer = 0;
        if (LIVE.on) bar.hidden = true;
      }, 2500);
    }
    return;
  }
  if (liveBarHideTimer) { clearTimeout(liveBarHideTimer); liveBarHideTimer = 0; }
  bar.hidden = false;
}
function liveProgressText(a, b, c) {
  let pct = null;
  if (typeof b === 'string') { const f = Number(a); if (Number.isFinite(f)) pct = Math.round(f * 100); }
  else if (typeof b === 'number' && b > 0 && Number.isFinite(Number(a))) pct = Math.round(Number(a) / b * 100);
  const file = typeof b === 'string' ? b : (typeof c === 'string' ? c : '');
  const name = file ? String(file).split(/[\\/]/).pop() : '';
  return '下载识别模型' + (pct === null ? '…' : ' ' + Math.max(0, Math.min(100, pct)) + '%') + (name ? '（' + name + '）' : '');
}

// 音频只用来拿字节、按时间解码；<audio> 本身保持原样，不建音频图、不改 crossOrigin。
function livePlayhead() { return audio.currentTime || 0; }
// 当前这段音频自己还剩多少秒缓冲。用户那边 megaphone 只有一两百 KB/s，
// 提前生成要抢带宽，音频缓冲见底时得先让播放。
function liveBufferAhead() {
  try {
    // 单流模式缓冲在 SourceBuffer 上，元素侧的 buffered 不一定会跟着更新。
    const m = LIVE.mse;
    if (m && m.sb) {
      const b = m.sb.buffered, t = audio.currentTime || 0;
      for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && t < b.end(i)) return b.end(i) - t;
      return 0;
    }
    const b = audio.buffered, t = audio.currentTime || 0;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && t < b.end(i)) return b.end(i) - t;
  } catch (e) {}
  return 0;
}

function liveAudioDuration() {
  return Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Infinity;
}

function liveLeadSec() {
  const v = Number(prefs.liveLead);
  if (Number.isFinite(v) && v >= 0) return Math.min(600, v);
  return LIVE_LEAD_DEFAULT;
}

// 设置页那个下拉只有 0/15/30/60/120/300 六个值。提前量算出来的值不在列表里（比如
// 老缓存里没这个键、或者曾被写成别的数字）时，直接把 select 设成那个值会被浏览器
// 拒绝、停在第一项 “0 秒”，用户看到的就是“设置显示 0 秒、实际提前 60 秒”。
function syncLiveLeadSelect() {
  const el = $('setLiveLead');
  if (!el) return;
  const sec = String(liveLeadSec());
  if (Array.prototype.some.call(el.options, o => o.value === sec)) el.value = sec;
  else el.value = String(LIVE_LEAD_DEFAULT);
}

// 只取需要的那一段字节：整集顺序下载既慢又重，而且一跳到别处就没法用。
// 用 XHR 而不是 fetch：COEP: credentialless 会把页面的跨域 fetch 转成 credentialless
// 请求，在代理/VPN 后面会被 Chrome 的地址空间策略拦掉（控制台报
// “target IP address space of public yet the resource is in address space unknown”）。
// 同一个 Range 请求走 XHR 不做这个转换，实测 206 能拿到字节。
// 桌面壳（Electron）和手机壳（Capacitor）会在启动时挂一个取字节桥：由原生侧发请求，
// 完全不受浏览器 CORS 约束，所以那些「音频源不给 CORS 头」的节目在壳里也能实时识别。
// 壳会挂一个取字节 + 原生识别的桥：取字节由原生侧发请求，完全不受浏览器 CORS 约束，
// 所以那些「音频源不给 CORS 头」的节目在壳里也能实时识别；
// 识别交给原生 sherpa-onnx（多线程、不占 JS 线程、不需要 COOP/COEP）。
// Tauri 壳提供 tauriHost()，这里就地包出一个同形状的宿主对象；
// 别的壳（比如安卓 WebView）可以在页面脚本之前自己挂 window.MyTranscriptHost。
// 唯一的平台检测点：其余分片只问「有没有桌面宿主」，不再直接摸 window.__TAURI__。
/* IPC 收口：插件脚本从 blob: URL 注入，宿主脚本从 player.js 来。
   把 invoke 包一层，调用栈里只要出现 blob: 帧就拒绝——插件拿不到任意桌面命令，
   只能走宿主给的 api。注意这是栈检查（同一 JS 环境下的尽力而为），不是权限沙箱。 */
function pluginFrameInStack(stack) {
  const lines = String(stack || '').split('\n');
  // 只看紧邻 guard 的那一帧：宿主自己调的放行，blob: 里的插件代码直接拒绝。
  const caller = lines.find(line => /\bat\b/.test(line) && !/mytIpcGuard/.test(line));
  return Boolean(caller) && /blob:/.test(caller);
}
function mytIpcGuard(original) {
  const guarded = function (cmd, args) {
    if (pluginFrameInStack(new Error().stack)) {
      throw new Error('插件不能直接调用桌面命令：' + cmd);
    }
    return original(cmd, args);
  };
  guarded.__mytGuard = true;
  return guarded;
}
function installIpcGuard(T) {
  if (!T) return;
  if (T.core && typeof T.core.invoke === 'function' && !T.core.invoke.__mytGuard) {
    try { T.core.invoke = mytIpcGuard(T.core.invoke.bind(T.core)); } catch (e) {}
  }
  const internals = window.__TAURI_INTERNALS__;
  if (internals && typeof internals.invoke === 'function' && !internals.invoke.__mytGuard) {
    try { internals.invoke = mytIpcGuard(internals.invoke.bind(internals)); } catch (e) {}
  }
}
installIpcGuard(tauriHost());

function liveHostFetch(url, from, to) {
  if (!host() || typeof host().fetchRange !== 'function') {
    throw new Error('没有原生取字节桥');
  }
  return host().fetchRange(url, from, to).then(buf => new Uint8Array(buf));
}

// 取字节的唯一入口：有壳就走壳，没有壳就走浏览器 XHR。
async function liveGetBytes(url, from, to, timeoutMs) {
  if (host() && typeof host().fetchRange === 'function') {
    const bytes = await liveHostFetch(url, from, to);
    if (!bytes.length) throw new Error('取不到音频数据（空响应）');
    return bytes;
  }
  return liveHttpGet(url, from, to, timeoutMs);
}

function liveHttpGet(url, from, to, timeoutMs) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';
    if (from !== null && from !== undefined) xhr.setRequestHeader('Range', 'bytes=' + from + '-' + to);
    let timer = 0, settled = false;
    const done = fn => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = 0; }
      fn();
    };
    xhr.onload = () => done(() => {
      if (xhr.status >= 400) { reject(new Error('音频源返回 HTTP ' + xhr.status)); return; }
      if (!xhr.response) { reject(new Error('取不到音频数据（空响应）')); return; }
      resolve(new Uint8Array(xhr.response));
    });
    xhr.onerror = () => done(() => {
      // XHR 走到 onerror 基本只有两种：网络断了，或者响应没给 CORS 头被浏览器拦掉。
      // 后者是确定性的（重试也不会好），带个标记上去，让上层直接报原因、别空转重试。
      const err = new Error('取音频数据失败（网络错误或跨域被拦）');
      err.cors = true;
      reject(err);
    });
    // abort() 触发的是 abort 事件，不是 error；不接这个事件，超时 abort 之后 Promise
    // 会永远 pending，整条 pump 就卡在那里（实测卡 40 秒才被别的分支重建救回来）。
    xhr.onabort = () => done(() => reject(new Error('取音频请求被中断（超时后自动重试）')));
    // 源站偶发会把一个 Range 请求挂住几十秒（实测卡 35 秒），串行 await 它等于把识别饿死。
    // 超时就 abort 掉交给下一轮重试，比干等一个已经死掉的连接快得多。
    if (timeoutMs) {
      timer = setTimeout(() => {
        try { xhr.abort(); } catch (e) {}
        done(() => reject(new Error('取音频超时（' + Math.round(timeoutMs / 1000) + ' 秒没有返回）')));
      }, timeoutMs);
    }
    xhr.send();
  });
}

// decodeAudioData 在极端情况下会既不回调成功也不回调失败（实测整条识别就此停住，
// 表现为“已识别 N 句”再也不涨、播放还在走）。给解码也加个超时，超时就当这次窗口失败。
function liveDecodeAudio(ab, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('音频解码超时'));
    }, timeoutMs);
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(v);
    };
    LIVE.ctx.decodeAudioData(
      ab,
      buf => finish(resolve, buf),
      err => finish(reject, err || new Error('音频解码失败')),
    );
  });
}

async function liveFetchRange(from, to, timeoutMs = 15000) {
  const bytes = await liveGetBytes(LIVE.audioUrl, from, to, timeoutMs);
  // 流量账：MSE 接管后播放用的就是这里取回来的字节，统计它才知道「只播音轨」省了多少。
  LIVE.net = LIVE.net || { bytes: 0, reqs: 0 };
  LIVE.net.bytes += bytes.length;
  LIVE.net.reqs += 1;
  if (!bytes.length) throw new Error('这个音频源不允许分段读取，取不到音频数据');
  return bytes;
}

// 开实时识别时第一枪经常是网络/代理的抖动（同一 URL 重试就通），
// 一次失败就判「不可用」太脆，这里给几次重试再放弃。
async function liveRetry(fn, times, delayMs) {
  let last = null;
  for (let i = 0; i < times; i++) {
    try { return await fn(); } catch (err) {
      last = err;
      // 跨域被拦是确定性的：这个节目的音频源不给我们字节，重试多少次都一样。
      // fatal 同理：格式不对（MP4/AAC、WAV…）重试也是在烧时间——探测每轮要拉
      // 128 KB → 8 MB，慢源上一轮一分多钟，界面上就是「正在重试（第 4 次）」转几分钟。
      if (err && (err.cors || err.fatal)) throw err;
      if (i < times - 1) liveSetText('取音频数据失败，正在重试（第 ' + (i + 2) + ' 次）…', 'busy');
      if (i < times - 1) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw last;
}

// 在一个字节窗口里找第一段连续帧：返回 {offset, bps, sr, spf}，找不到返回 null。
function liveProbeScan(head) {
  let origin = 0;
  if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
    // ID3v2 头：只有 size 字段靠谱时才按它跳；有的文件（Lavf 出的）size 明显偏小，
    // 这时先按 size 跳，再从 size 之后一路扫，靠「连续帧」自己定位。
    const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
    origin = Math.min(10 + size, head.length);
  }
  let i = origin;
  while (i + 4 <= head.length) {
    if (head[i] === 0xFF && (head[i + 1] & 0xE0) === 0xE0) {
      const h = liveMp3Frame(head, i);
      // 连续两帧都对上才算真的帧边界，避免把帧内数据误当同步字。
      if (h && i + h.len + 4 <= head.length && liveMp3Frame(head, i + h.len)) break;
    }
    i += 1;
  }
  if (i + 4 > head.length) return null;
  const first = liveMp3Frame(head, i);
  let p = i, frames = 0, br = first.br, sr = first.sr, spf = first.spf, cbr = true;
  while (p + 4 <= head.length && frames < 256) {
    const h = liveMp3Frame(head, p);
    if (!h || p + h.len > head.length) break;
    if (h.br !== br || h.sr !== sr) cbr = false;
    p += h.len;
    frames += 1;
  }
  if (frames < 8) return null;
  if (!cbr) throw new Error('这个音频是可变码率 MP3，暂时不支持提前生成');
  return { offset: i, bps: br / 8, sr, spf };
}

// 一眼能认出来的非 MP3 容器。命中就说明「这套按字节找 MP3 帧」的管线从原理上用不了，
// 不该再放大窗口、更不该当网络抖动重试。
// 实测没这层判断时，Talking Cars 那集（364 MB 的 MP4 视频）会连做 4 轮
// 128 KB → 2 MB → 8 MB 的探测（本机实测 2.6s / 15.5s / 45.4s，一轮一分多钟），
// 界面上就是「取音频数据失败，正在重试（第 4 次）」转好几分钟。
function liveContainerKind(head) {
  if (!head || head.length < 12) return null;
  const at = (i) => String.fromCharCode(head[i], head[i + 1], head[i + 2], head[i + 3]);
  const fourCC = at(4);
  if (fourCC === 'ftyp') {
    const brand = at(8);
    return { kind: 'mp4', label: (brand === 'M4A ' || brand === 'M4B ') ? 'M4A/AAC 音频' : 'MP4 视频（AAC 音轨）' };
  }
  if (['moov', 'mdat', 'free', 'skip', 'wide', 'styp', 'sidx', 'moof'].indexOf(fourCC) !== -1) {
    return { kind: 'mp4', label: 'MP4 容器' };
  }
  const first = at(0);
  if (first === 'RIFF') return { kind: 'wav', label: 'WAV 音频' };
  if (first === 'OggS') return { kind: 'ogg', label: 'Ogg 音频' };
  if (first === 'fLaC') return { kind: 'flac', label: 'FLAC 音频' };
  if (first === 'ADIF') return { kind: 'aac', label: 'AAC（ADIF）音频' };
  return null;
}

// ── MP4/M4A：按样本表只读音轨（2026-11-22 起） ────────────────────────────────
// 以前这集（364 MB 的 MP4 视频）只能快速失败退出，用户要的是「所有视频只播音频时
// 也能实时识别」。实测（docs/spike-aac-live.md）：同一集取前 60 秒音频只要 144 次
// range、0.94 MB（放大 1.00×，一字节视频都不读），4 路连接复用下 3.3× 实时。
// 所以这里不做转码、不下整集：从 moov 的 stbl 拿到样本表，按 chunk 分段取字节，
// 用 WebCodecs（AudioDecoder + 裸 AAC + ASC 当 description）解成 PCM 喂识别。
// 播放侧仍是原生 <audio>，流量优化（fMP4+MSE）留到下一期。

function liveU32(u8, i) {
  return ((u8[i] << 24) | (u8[i + 1] << 16) | (u8[i + 2] << 8) | u8[i + 3]) >>> 0;
}

function liveFourCCAt(u8, i) {
  return String.fromCharCode(u8[i], u8[i + 1], u8[i + 2], u8[i + 3]);
}

// 读一个 box 头。size=1 表示 64 位长度，size=0 表示「一直到父容器末尾」。
function liveBoxAt(u8, pos, end) {
  if (pos + 8 > end) return null;
  let size = liveU32(u8, pos);
  const type = liveFourCCAt(u8, pos + 4);
  let hdr = 8;
  if (size === 1) {
    if (pos + 16 > end) return null;
    size = liveU32(u8, pos + 8) * 4294967296 + liveU32(u8, pos + 12);
    hdr = 16;
  } else if (size === 0) {
    size = end - pos;
  }
  if (size < hdr || pos + size > end) {
    // 首窗口是截断的：moov 常常有 1 MB，128 KB 的窗口里它必然「越界」。这时不能当坏 box
    // 直接丢弃（丢了就误判成「索引在文件尾部」），留一条 truncated 记录，让调用方按
    // 自己的长度再精确取一次。
    if (size >= hdr && type && /^[\x20-\x7e]{4}$/.test(type)) {
      return { type, pos, size, body: pos + hdr, end: pos + size, truncated: true };
    }
    return null;
  }
  return { type, pos, size, body: pos + hdr, end: pos + size };
}

// 扫同一层的所有 box；遇到坏长度就停（不猜、不硬恢复）。
function liveBoxes(u8, start, end) {
  const out = [];
  let pos = start;
  while (pos + 8 <= end) {
    const b = liveBoxAt(u8, pos, end);
    if (!b) break;
    out.push(b);
    if (b.truncated) break;
    pos = b.end;
  }
  return out;
}

function liveBoxChild(u8, box, type) {
  const kids = liveBoxes(u8, box.body, box.end);
  for (const k of kids) if (k.type === type) return k;
  return null;
}

// esds → 音频的 AudioSpecificConfig（WebCodecs 的 description 就它）。
// 描述符是 tag + 变长 size 的嵌套结构：0x03 ES → 0x04 DecoderConfig → 0x05 ASC。
function liveEsdsAsc(u8, box) {
  let asc = null;

  const readSize = (pos, limit) => {
    let size = 0, q = pos;
    for (let i = 0; i < 4 && q < limit; i++) {
      const b = u8[q++];
      size = (size << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return { size, next: q };
  };

  const walk = (pos, limit, depth) => {
    while (pos + 2 <= limit && !asc) {
      const tag = u8[pos];
      const { size, next } = readSize(pos + 1, limit);
      const body = next, bodyEnd = Math.min(limit, next + size);
      if (body > bodyEnd) return;
      if (tag === 0x03) {
        // ES_Descriptor：ES_ID(2) + flags(1) + 可选字段，然后才是子描述符
        const flags = u8[body + 2];
        let p = body + 3;
        if (flags & 0x80) p += 2;
        if (flags & 0x40) p += 1 + u8[p];
        if (flags & 0x20) p += 2;
        if (p < bodyEnd) walk(p, bodyEnd, depth + 1);
      } else if (tag === 0x04) {
        // DecoderConfigDescriptor 固定 13 字节头，后面是子描述符
        walk(body + 13, bodyEnd, depth + 1);
      } else if (tag === 0x05) {
        asc = u8.slice(body, bodyEnd);
        return;
      }
      pos = bodyEnd;
    }
  };

  // esds 自己的 4 字节 version/flags 之后才是描述符
  walk(box.body + 4, box.end, 0);
  return asc;
}

// mdhd 里的 timescale（每秒多少时间单位），v0 / v1 布局不同。
function liveMdhdTimescale(u8, box) {
  const v = u8[box.body];
  const at = v === 1 ? box.body + 20 : box.body + 12;
  return liveU32(u8, at) || 0;
}

// 把 moov 里的 stbl 解释成「第 i 个音频样本在文件里的偏移 / 字节数 / 起始秒」。
function liveParseMoov(u8, moov) {
  const fail = (msg) => {
    const err = new Error(msg);
    err.fatal = true;
    throw err;
  };
  const traks = liveBoxes(u8, moov.body, moov.end).filter(b => b.type === 'trak');
  for (const trak of traks) {
    const mdia = liveBoxChild(u8, trak, 'mdia');
    if (!mdia) continue;
    const hdlr = liveBoxChild(u8, mdia, 'hdlr');
    if (!hdlr || liveFourCCAt(u8, hdlr.body + 8) !== 'soun') continue;
    const minf = liveBoxChild(u8, mdia, 'minf');
    if (!minf) continue;
    const stbl = liveBoxChild(u8, minf, 'stbl');
    if (!stbl) continue;
    const mdhd = liveBoxChild(u8, mdia, 'mdhd');
    const timescale = mdhd ? liveMdhdTimescale(u8, mdhd) : 0;
    if (!timescale) fail('这个 MP4 的音轨没有时间刻度（mdhd 缺失）');

    const stsd = liveBoxChild(u8, stbl, 'stsd');
    if (!stsd) fail('这个 MP4 没有样本描述（stsd 缺失）');
    // stsd: version/flags(4) + entry_count(4)，后面就是 sample entry
    const entry = liveBoxAt(u8, stsd.body + 8, stsd.end);
    if (!entry) fail('这个 MP4 的音轨样本描述读不出来');
    const codec = entry.type;
    if (codec !== 'mp4a') fail('这集音轨是 ' + codec + '，实时识别目前只支持 AAC（mp4a）');
    // AudioSampleEntry 的固定头 28 字节，之后才是 esds 之类的子 box
    const esdsAsc = (() => {
      const kidsStart = entry.body + 28;
      if (kidsStart >= entry.end) return null;
      const esds = liveBoxChild(u8, { body: kidsStart, end: entry.end }, 'esds');
      return esds ? liveEsdsAsc(u8, esds) : null;
    })();
    // 少数封装（QuickTime 的版本、某些 remuxer）把 esds 藏在 wave 里，这里够不着。
    // 解不了就按 sample entry 里自己带的字段拼一个 LC 的 ASC，不至于整集判死。
    let asc = esdsAsc;
    if (!asc || asc.length < 2) {
      const chField = u8[entry.body + 17] | (u8[entry.body + 16] << 8);
      const rateRaw = liveU32(u8, entry.body + 24);
      const srField = Math.round((rateRaw / 65536) * 1000) / 1000;
      const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
        16000, 12000, 11025, 8000, 7350];
      const idx = rates.findIndex(r => Math.abs(r - srField) < 1);
      if (idx < 0) fail('这个 AAC 音轨缺 AudioSpecificConfig，sample entry 里的采样率也读不出来');
      const bitsAsc = (2 << 11) | (idx << 7) | ((chField || 2) << 3);
      asc = new Uint8Array([(bitsAsc >> 8) & 0xff, bitsAsc & 0xff]);
    }

    // ASC 头 5 位是 audioObjectType：2=AAC-LC，5=HE-AAC(SBR)，29=HE-AACv2(PS)
    const bits = asc[0].toString(2).padStart(8, '0') + asc[1].toString(2).padStart(8, '0');
    const aot = parseInt(bits.slice(0, 5), 2);
    const sfIdx = parseInt(bits.slice(5, 9), 2);
    const chCfg = parseInt(bits.slice(9, 13), 2);
    const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
      16000, 12000, 11025, 8000, 7350];
    const sr = rates[sfIdx] || 0;
    const ch = chCfg || 2;
    if (aot !== 2 && aot !== 5 && aot !== 29) {
      fail('这集音轨的 AAC 类型是 ' + aot + '（只支持 AAC-LC / HE-AAC）');
    }
    if (!sr) fail('这个 AAC 音轨的采样率读不出来');
    // WebCodecs 的 codec 串要跟着 ASC 走：HE-AAC 是 mp4a.40.5，硬写 40.2 会被判不支持。
    const codecStr = 'mp4a.40.' + aot;

    const stsz = liveBoxChild(u8, stbl, 'stsz');
    if (!stsz) fail('这个 MP4 缺样本大小表（stsz）');
    const stsc = liveBoxChild(u8, stbl, 'stsc');
    if (!stsc) fail('这个 MP4 缺 chunk 表（stsc）');
    const stco = liveBoxChild(u8, stbl, 'stco') || liveBoxChild(u8, stbl, 'co64');
    if (!stco) fail('这个 MP4 缺 chunk 偏移表（stco）');
    const stts = liveBoxChild(u8, stbl, 'stts');
    if (!stts) fail('这个 MP4 缺时间表（stts）');

    // stsz：恒定大小时只给一个值，否则逐样本给
    const fixedSize = liveU32(u8, stsz.body + 4);
    const n = liveU32(u8, stsz.body + 8);
    if (!n) fail('这个 MP4 的音轨里没有音频样本');
    const sizes = new Uint32Array(n);
    if (fixedSize) {
      sizes.fill(fixedSize);
    } else {
      let p = stsz.body + 12;
      for (let i = 0; i < n; i++, p += 4) sizes[i] = liveU32(u8, p);
    }

    // stsc：chunk → 每个 chunk 里有几个样本（按「首 chunk 序号」分段给）
    const stscCount = liveU32(u8, stsc.body + 4);
    const stscRuns = [];
    for (let i = 0, p = stsc.body + 8; i < stscCount; i++, p += 12) {
      stscRuns.push({
        first: liveU32(u8, p),
        spc: liveU32(u8, p + 4),
      });
    }
    const co64 = stco.type === 'co64';
    const chunkCount = liveU32(u8, stco.body + 4);
    const chunkOff = (i) => {
      const p = stco.body + 8 + i * (co64 ? 8 : 4);
      return co64 ? liveU32(u8, p) * 4294967296 + liveU32(u8, p + 4) : liveU32(u8, p);
    };

    // 拼出每个样本的绝对偏移：chunk 起点 + 前面样本的累计大小
    const offs = new Float64Array(n);
    let sIdx = 0;
    for (let ch = 1; ch <= chunkCount && sIdx < n; ch++) {
      let spc = stscRuns.length ? stscRuns[0].spc : 0;
      for (let r = 0; r < stscRuns.length; r++) {
        if (stscRuns[r].first <= ch) spc = stscRuns[r].spc;
      }
      let off = chunkOff(ch - 1);
      for (let k = 0; k < spc && sIdx < n; k++, sIdx++) {
        offs[sIdx] = off;
        off += sizes[sIdx];
      }
    }
    if (sIdx < n) fail('这个 MP4 的 chunk 表和样本数对不上（' + sIdx + '/' + n + '）');

    // stts：每个样本的时长（时间单位），累计成秒
    const sttsCount = liveU32(u8, stts.body + 4);
    const ticks = new Float64Array(n);
    let acc = 0, s = 0;
    for (let i = 0, p = stts.body + 8; i < sttsCount && s < n; i++, p += 8) {
      const cnt = liveU32(u8, p), delta = liveU32(u8, p + 4);
      for (let k = 0; k < cnt && s < n; k++, s++) {
        ticks[s] = acc;
        acc += delta;
      }
    }
    for (; s < n; s++) ticks[s] = acc;
    const times = new Float64Array(n);
    for (let i = 0; i < n; i++) times[i] = ticks[i] / timescale;

    return {
      kind: 'mp4', sr, ch, asc, n, offs, sizes, times, ticks, timescale, codec: codecStr,
      mseType: 'audio/mp4; codecs="' + codecStr + '"',
      durSec: (acc || 0) / timescale,
      label: 'AAC' + (aot === 2 ? '-LC' : aot === 5 ? '（HE-AAC）' : '（HE-AACv2）') + ' ' + (sr / 1000) + ' kHz',
    };
  }
  return fail('这个 MP4 里没有音频轨（soun）');
}

// 找 moov。首窗口里没有（索引放在文件尾部，没做 faststart）时不能直接判死：
// 顶层 box 的长度都写在头部，按长度一跳一跳找就行，mdat 那几个 GB 一字节都不用下。
async function liveFindMoov(head) {
  const inHead = liveBoxes(head, 0, head.length).find(b => b.type === 'moov');
  if (inHead) return inHead;
  let pos = 0;
  for (let hop = 0; hop < 64; hop++) {
    const local = liveBoxAt(head, pos, head.length);
    if (local && !local.truncated) {
      if (local.type === 'moov') return local;
      pos = local.end;
      continue;
    }
    // 这个 box 越出首窗口了：只取它的 16 字节头来读长度/类型
    const hdr = await liveFetchRange(pos, pos + 15);
    if (!hdr || hdr.length < 8) return null;
    let size = liveU32(hdr, 0);
    const type = liveFourCCAt(hdr, 4);
    let hdrLen = 8;
    if (size === 1) {
      if (hdr.length < 16) return null;
      size = liveU32(hdr, 8) * 4294967296 + liveU32(hdr, 12);
      hdrLen = 16;
    } else if (size === 0) {
      return null;   // 这个 box 一直铺到文件尾，后面没有 moov
    }
    if (size < hdrLen) return null;
    if (type === 'moov') return { type, pos, size, body: pos + hdrLen, end: pos + size };
    pos += size;
  }
  return null;
}

// 首窗口里找 moov。moov 常常比首窗口大（本集 1.02 MB），超出就按它自己的位置精确再取一次。
async function liveProbeMp4(head) {
  const fail = (msg) => {
    const err = new Error(msg);
    err.fatal = true;
    throw err;
  };
  const moov = await liveFindMoov(head);
  if (!moov) {
    // 连顶层 box 都跳不到 moov（少见的分段/异常文件），这种只能整集下载后再识别。
    fail('这个 MP4 的索引（moov）找不到，没法只读音轨；实时识别暂不支持这一集');
  }
  let u8 = head, box = moov;
  if (moov.end > head.length) {
    u8 = await liveFetchRange(moov.pos, moov.pos + moov.size - 1);
    box = liveBoxAt(u8, 0, u8.length);
    if (!box || box.type !== 'moov') fail('这个 MP4 的索引读不出来（分段返回的长度不对）');
  }
  const desc = liveParseMoov(u8, box);
  // 留住原片 moov 字节：MSE 的 init segment 直接从这里「移植」，编码配置与原片一致。
  desc.moovRaw = u8.slice(box.pos, box.end);
  desc.trackId = 1;
  // 原片是「视频 + 音频」两条轨，轨道号不能取第一条 trak（那是视频轨）：
  // 取音频轨自己的 tkhd track_ID，否则 init 里的 trex 和分片里的 tfhd 会指向不存在的轨。
  const audioTrak = liveBoxes(u8, box.body, box.end).find(k => {
    if (k.type !== 'trak') return false;
    const md = liveBoxChild(u8, k, 'mdia');
    const hd = md && liveBoxChild(u8, md, 'hdlr');
    return !!hd && liveFourCCAt(u8, hd.body + 8) === 'soun';
  });
  const tkhd = audioTrak && liveBoxChild(u8, audioTrak, 'tkhd');
  if (tkhd) {
    const p = tkhd.body - box.pos;
    desc.trackId = liveU32(desc.moovRaw, p + (desc.moovRaw[p] === 1 ? 20 : 12)) || 1;
  }
  if (typeof AudioDecoder === 'undefined') {
    fail('这个壳没有 WebCodecs 音频解码（AudioDecoder），AAC 音轨没法识别');
  }
  let support = null;
  try {
    support = await AudioDecoder.isConfigSupported({
      codec: desc.codec, sampleRate: desc.sr, numberOfChannels: desc.ch,
      description: desc.asc,
    });
  } catch (e) { support = null; }
  if (!support || !support.supported) fail('这个浏览器解不了 ' + desc.label + '（WebCodecs 不支持该 AAC 配置）');
  return desc;
}

// 头部探针：跳 ID3v2，找到第一帧，确认是 CBR（恒定码率）才能用「字节 = 时间 × 码率」定位。
// 有的节目把 3000×3000 封面塞进 ID3（实测光封面就 ~1.4 MB），128 KB 的窗口根本到不了
// 第一帧，以前会误报「这个音频不是 MP3」。所以按 128 KB → 2 MB → 8 MB 递进取窗口。
// MP4/M4A 走另一条路（样本表 + WebCodecs），不再一律判死。
async function liveProbeAudio() {
  let head = await liveFetchRange(0, 131072 - 1);
  const container = liveContainerKind(head);
  if (container && container.kind === 'mp4') return liveProbeMp4(head);
  if (container) {
    const err = new Error('这集是 ' + container.label + '，实时识别暂不支持这种封装');
    err.fatal = true;
    throw err;
  }
  let last = null;
  for (const size of [131072, 2 * 1024 * 1024, 8 * 1024 * 1024]) {
    if (size > head.length) head = await liveFetchRange(0, size - 1);
    try {
      const r = liveProbeScan(head);
      if (r) return { kind: 'mp3', origin: r.offset, bps: r.bps, sr: r.sr, spf: r.spf };
    } catch (err) {
      // 已经认出是 VBR 就没必要再放大窗口了，直接把这个错误交给调用方。
      last = err;
      break;
    }
    last = null;
  }
  if (last) throw last;
  const err = new Error('这集不是 MP3（别的封装），实时识别暂不支持');
  err.fatal = true;
  throw err;
}

// 二分找第一个 times[i] >= sec 的样本序号。
function liveSampleAt(times, sec) {
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < sec) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// 4 路并发取一段段字节。实测 4 路是最好的：8 路中位延迟从 227 ms 涨到 644 ms，
// 3 路以下又喂不满 3× 实时的余量。
async function liveFetchRuns(runs, par = 4) {
  const out = new Array(runs.length);
  let idx = 0;
  const worker = async () => {
    while (idx < runs.length) {
      const k = idx++;
      const r = runs[k];
      out[k] = await liveFetchRange(r.from, r.to - 1);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(par, runs.length)) }, worker));
  return out;
}

// 48 kHz → 16 kHz。整数倍就按块平均，否则线性插值。识别模型只在乎 16 k 的内容，
// 别为了「保真」把重采样做成几百毫秒的卷积。
function liveResampleMono(mono, sr, rate) {
  if (sr === rate) return mono;
  const ratio = sr / rate;
  const nOut = Math.floor(mono.length / ratio);
  const out = new Float32Array(nOut);
  if (Number.isInteger(ratio)) {
    const k = ratio;
    for (let i = 0; i < nOut; i++) {
      let s = 0;
      for (let j = 0; j < k; j++) s += mono[i * k + j];
      out[i] = s / k;
    }
    return out;
  }
  for (let i = 0; i < nOut; i++) {
    const x = i * ratio, i0 = Math.floor(x), f = x - i0;
    const a = mono[i0] || 0, b = mono[i0 + 1] === undefined ? a : mono[i0 + 1];
    out[i] = a + (b - a) * f;
  }
  return out;
}

// 把样本表里第 i0..i1 个样本解成 16 kHz 单声道。裸 AAC 没有 ADTS 头，帧边界全靠 stsz，
// 时间戳用 stts 算出来的秒，这样 AudioDecoder 输出和播放时间轴对得上。
async function liveDecodeMp4Window(desc, flat, marks, i0, i1) {
  if (typeof AudioDecoder === 'undefined') throw new Error('这个浏览器没有 WebCodecs 音频解码');
  const out = [];
  let decErr = null;
  const dec = new AudioDecoder({
    output: ad => { out.push(ad); },
    error: e => { decErr = decErr || e; },
  });
  dec.configure({
    codec: desc.codec, sampleRate: desc.sr, numberOfChannels: desc.ch,
    description: desc.asc,
  });
  const nSamples = i1 - i0;
  for (let j = 0; j < nSamples; j++) {
    const t0 = desc.times[i0 + j];
    const t1 = i0 + j + 1 < desc.n ? desc.times[i0 + j + 1] : t0 + 1024 / desc.sr;
    dec.decode(new EncodedAudioChunk({
      type: 'key',
      timestamp: Math.round(t0 * 1e6),
      duration: Math.max(1, Math.round((t1 - t0) * 1e6)),
      data: flat.subarray(marks[j], marks[j + 1]),
    }));
  }
  try { await dec.flush(); } catch (e) { decErr = decErr || e; }
  try { dec.close(); } catch (e) {}
  if (decErr) throw decErr;
  if (!out.length) return null;

  let frames = 0;
  for (const ad of out) frames += ad.numberOfFrames;
  const mono = new Float32Array(frames);
  let at = 0;
  for (const ad of out) {
    const nf = ad.numberOfFrames;
    const plane = new Float32Array(nf);
    ad.copyTo(plane, { planeIndex: 0, format: 'f32-planar' });
    if (ad.numberOfChannels > 1) {
      const plane2 = new Float32Array(nf);
      ad.copyTo(plane2, { planeIndex: 1, format: 'f32-planar' });
      for (let i = 0; i < nf; i++) plane[i] = (plane[i] + plane2[i]) / 2;
    }
    mono.set(plane, at);
    at += nf;
    ad.close();
  }
  // 起点以样本表为准：解码输出的 timestamp 在有些实现里是相对值，差太多就丢掉不用。
  let startSec = out[0].timestamp / 1e6;
  if (!Number.isFinite(startSec) || Math.abs(startSec - desc.times[i0]) > 0.05) {
    startSec = desc.times[i0];
  }
  return { pcm: liveResampleMono(mono, desc.sr, LIVE_RATE), start: startSec };
}

// 取 MP4 的 [startSec, startSec+seconds)：按样本表把这段样本按「地址连续」合成若干段 range
// （同一个 chunk 里的样本本来就是连着的），4 路并发取回来，再把裸 AAC 帧按样本边界重排成
// 一整块带 marks 的字节（marks[j] / marks[j+1] 就是第 j 个样本在 flat 里的起止）。
async function liveFetchSamplesMp4(startSec, seconds) {
  const d = LIVE.cbr;
  const i0 = Math.min(d.n - 1, liveSampleAt(d.times, Math.max(0, startSec)));
  const i1 = Math.min(d.n, Math.max(i0 + 1, liveSampleAt(d.times, startSec + seconds + 1)));
  const runs = [];
  for (let j = i0; j < i1; j++) {
    const from = d.offs[j], to = d.offs[j] + d.sizes[j];
    const last = runs[runs.length - 1];
    if (last && from === last.to) { last.to = to; last.count += 1; } else runs.push({ from, to, count: 1 });
  }
  const parts = await liveFetchRuns(runs, 4);
  // 服务端忽略 Range 时会回整段文件：长度一眼就能看出来，直接判这一轮失败，
  // 不解错帧（错帧进模型只会吐一堆乱词）。
  let total = 0;
  for (let k = 0; k < parts.length; k++) {
    const want = runs[k].to - runs[k].from;
    if (parts[k].length !== want) {
      throw new Error('这个音频源不支持分段读取（返回了 ' + parts[k].length + ' 字节，期望 ' + want + '）');
    }
    total += want;
  }
  const flat = new Uint8Array(total);
  const marks = new Int32Array(i1 - i0 + 1);
  let pos = 0, si = i0;
  for (let k = 0; k < runs.length; k++) {
    flat.set(parts[k], pos);
    marks[si - i0] = pos;
    let q = 0;
    for (let m = 0; m < runs[k].count; m++) {
      q += d.sizes[si + m];
      marks[si + m + 1 - i0] = pos + q;
    }
    pos += parts[k].length;
    si += runs[k].count;
  }
  return { i0, i1, flat, marks };
}

async function liveFetchWindowMp4(startSec, seconds) {
  const s = await liveFetchSamplesMp4(startSec, seconds);
  return liveDecodeMp4Window(LIVE.cbr, s.flat, s.marks, s.i0, s.i1);
}

/* ---------- fMP4 + MSE：只播音频，流量从 24.5 MB/分钟降到约 1.5 MB/分钟 ----------
   原生 <audio> 指着整个 MP4 时，浏览器会把视频帧一起下下来（实测一分钟 24.5 MB，
   而音轨只占 6~8%）。这里把样本表拼成一段 init segment + 一串 moof/mdat 的音频分片，
   喂给 MediaSource，元素只认 blob，视频字节一个都不用下。
   同一份取回来的字节照旧喂 WebCodecs → 识别，所以「省流量」和「实时识别」共用一次下载。 */

function liveU8Cat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function liveW32(u8, i, v) {
  u8[i] = (v >>> 24) & 0xff;
  u8[i + 1] = (v >>> 16) & 0xff;
  u8[i + 2] = (v >>> 8) & 0xff;
  u8[i + 3] = v & 0xff;
}

function liveW16(u8, i, v) {
  u8[i] = (v >>> 8) & 0xff;
  u8[i + 1] = v & 0xff;
}

function liveAscii(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function liveZeros(n) {
  return new Uint8Array(n);
}

function liveBoxB(type, ...kids) {
  const body = kids.length ? liveU8Cat(kids) : new Uint8Array(0);
  const out = new Uint8Array(8 + body.length);
  liveW32(out, 0, out.length);
  out.set(liveAscii(type), 4);
  out.set(body, 8);
  return out;
}

function liveFullB(type, ver, flags, ...kids) {
  const head = new Uint8Array(4);
  liveW32(head, 0, ((ver & 0xff) << 24) | (flags & 0xffffff));
  return liveBoxB(type, head, ...kids);
}

// init segment 不再手搓字段，而是「移植」原片自己的 moov：
// tkhd / mdhd / hdlr / smhd / dinf / stsd（含 mp4a + esds + ASC）全部按原字节搬过来，
// 编码配置因此和能在原生播放器里正常播放的那份逐字节一致（手搓的 esds/stsd 被
// Chromium 的 MSE 解析器拒过一次，没必要再赌字段细节）。
// 只做三处改造：stbl 的样本表清空（fragmented 形态）、moov 末尾加 mvex/trex、
// mvhd/tkhd/mdhd 的 duration 归零。
function liveAacInitSegment(d) {
  const src = d.moovRaw;
  if (!src || !src.length) throw new Error('原片 moov 没有留在内存里');
  const u8 = src;
  const moov = liveBoxAt(u8, 0, u8.length);
  if (!moov || moov.type !== 'moov') throw new Error('原片 moov 读不出来');
  const raw = (b) => u8.slice(b.pos, b.end);
  let trackId = 1;
  // duration 归零：version 0/1 的字段偏移不同，这里按各自的布局改。
  const noDur = (b) => {
    const out = raw(b);
    const p = b.body - b.pos;
    const v = out[p];
    const off = b.type === 'tkhd'
      ? (v === 1 ? 28 : 20)
      : (v === 1 ? 24 : 16);
    out.fill(0, p + off, p + off + (v === 1 ? 8 : 4));
    if (b.type === 'tkhd') trackId = liveU32(out, p + (v === 1 ? 20 : 12));
    return out;
  };
  const kids = (b) => liveBoxes(u8, b.body, b.end);
  const stbl = (b) => {
    const stsd = kids(b).filter(k => k.type === 'stsd');
    if (stsd.length !== 1) throw new Error('原片 stsd 结构不对');
    return liveBoxB('stbl', raw(stsd[0]),
      liveFullB('stts', 0, 0, liveZeros(4)),
      liveFullB('stsc', 0, 0, liveZeros(4)),
      liveFullB('stsz', 0, 0, liveZeros(8)),
      liveFullB('stco', 0, 0, liveZeros(4)));
  };
  const minf = (b) => liveBoxB('minf', ...kids(b).map(k =>
    (k.type === 'stbl' ? stbl(k) : raw(k))));
  const mdia = (b) => liveBoxB('mdia', ...kids(b).map(k =>
    (k.type === 'minf' ? minf(k) : k.type === 'mdhd' ? noDur(k) : raw(k))));
  const trak = (b) => {
    const parts = [];
    for (const k of kids(b)) {
      if (k.type === 'edts') continue;                 // 分片模式下编辑列表没有意义
      parts.push(k.type === 'mdia' ? mdia(k) : k.type === 'tkhd' ? noDur(k) : raw(k));
    }
    return liveBoxB('trak', ...parts);
  };
  // 原片是「视频+音频」两条轨：MSE 的 mime 只声明音频，init 里再塞一条 avc1 的轨会被
  // 解析器直接拒掉（track 类型和 mime 对不上）。所以只留 hdlr=soun 的那条。
  const isAudioTrak = (b) => {
    const md = liveBoxChild(u8, b, 'mdia');
    const hd = md && liveBoxChild(u8, md, 'hdlr');
    return !!hd && liveFourCCAt(u8, hd.body + 8) === 'soun';
  };
  const moovKids = kids(moov).filter(k => k.type !== 'mvex' && k.type !== 'free').map(k =>
    (k.type === 'trak' ? (isAudioTrak(k) ? trak(k) : null) : k.type === 'mvhd' ? noDur(k) : raw(k))
  ).filter(Boolean);
  const trex = liveFullB('trex', 0, 0, liveU8Cat([
    new Uint8Array([0, 0, (trackId >>> 8) & 0xff, trackId & 0xff]), // track_ID（从 tkhd 读到的值）
    new Uint8Array([0, 0, 0, 1]),              // default_sample_description_index
    new Uint8Array([0, 0, 0, 0]),              // default_sample_duration
    new Uint8Array([0, 0, 0, 0]),              // default_sample_size
    liveZeros(4),                              // default_sample_flags
  ]));
  const moovNew = liveBoxB('moov', ...moovKids, liveBoxB('mvex', trex));
  const ftyp = liveBoxB('ftyp', liveAscii('isom'), liveZeros(4),
    liveAscii('isom'), liveAscii('iso2'), liveAscii('mp41'));
  return { ftyp, moov: moovNew, trackId, bytes: liveU8Cat([ftyp, moovNew]) };
}

// 一个媒体分片：moof(mfhd + traf[tfhd/tfdt/trun]) + mdat。
// tfdt 用样本表里的 tick 作 baseMediaDecodeTime，时间轴和原片完全一致，播放头/进度条不受影响。
function liveAacFragment(d, seq, i0, i1, flat, marks) {
  const n = i1 - i0;
  const build = (dataOffset) => {
    const entries = new Uint8Array(n * 8);
    for (let j = 0; j < n; j++) {
      const t0 = d.ticks[i0 + j];
      const t1 = i0 + j + 1 < d.n ? d.ticks[i0 + j + 1] : t0 + (i0 + j > 0 ? d.ticks[i0 + j] - d.ticks[i0 + j - 1] : 1024);
      liveW32(entries, j * 8, Math.max(1, Math.round(t1 - t0)));
      liveW32(entries, j * 8 + 4, marks[j + 1] - marks[j]);
    }
    const trun = liveFullB('trun', 0, 0x000301, liveU8Cat([
      new Uint8Array([0, 0, 0, n]),
      new Uint8Array([(dataOffset >>> 24) & 0xff, (dataOffset >>> 16) & 0xff,
        (dataOffset >>> 8) & 0xff, dataOffset & 0xff]),
      entries,
    ]));
    const base = Math.round(d.ticks[i0]);
    // tfdt 用 version 0（32 位 baseMediaDecodeTime）：这一集 1853 秒 × 48000 ≈ 8900 万，
    // 32 位装得下；version 1 要求 64 位字段，写短了整段 moof 会被解析器丢掉。
    const tfdt = liveFullB('tfdt', 0, 0,
      new Uint8Array([(base >>> 24) & 0xff, (base >>> 16) & 0xff, (base >>> 8) & 0xff, base & 0xff]));
    // 0x020000 = default-base-is-moof，trun 的 data_offset 就相对 moof 起点算
    const tfhd = liveFullB('tfhd', 0, 0x020000,
      new Uint8Array([0, 0, (d.trackId >>> 8) & 0xff, d.trackId & 0xff]));
    const mfhd = liveFullB('mfhd', 0, 0, new Uint8Array([0, 0, 0, seq]));
    return liveBoxB('moof', mfhd, liveBoxB('traf', tfhd, tfdt, trun));
  };
  const moof = build(0);
  const moof2 = build(moof.length + 8);   // data_offset = moof 长度 + mdat 头
  const mdat = liveBoxB('mdat', flat);
  return { bytes: liveU8Cat([moof2, mdat]), start: d.times[i0] };
}

// 一个窗口切成一串小分片再 append。实测 WebView2 的 MSE 解析器对单次 append 的样本数
// 很挑：同一个 10 秒窗口（200 KB、610 个样本）整段塞进去，buffered 只长出 2 秒；
// 切成每片 100 个样本（约 35 KB）就整段落地（12 片连续 append 后有完整 13 秒）。
// 分片头每个约 (16 + 8×样本数) 字节，相对音轨数据可以忽略。
function liveAacSplit(d, s, per) {
  const out = [];
  const step = per || 100;
  for (let a = s.i0; a < s.i1; a += step) {
    const b = Math.min(s.i1, a + step);
    const base = s.marks[a - s.i0];
    const data = s.flat.subarray(base, s.marks[b - s.i0]);
    const marks = new Int32Array(b - a + 1);
    for (let j = 0; j <= b - a; j++) marks[j] = s.marks[a - s.i0 + j] - base;
    out.push(liveAacFragment(d, ++LIVE.fseq, a, b, data, marks));
  }
  return out;
}

function liveSbAppend(sb, bytes) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      sb.removeEventListener('updateend', onEnd);
      sb.removeEventListener('error', onErr);
    };
    const onEnd = () => { if (settled) return; settled = true; cleanup(); resolve(); };
    const onErr = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const e = sb.error || {};
      reject(new Error('MSE append 失败（' + (e.message || e.name || '源数据被拒绝') + '）'));
    };
    sb.addEventListener('updateend', onEnd);
    sb.addEventListener('error', onErr);
    try { sb.appendBuffer(bytes); } catch (e) {
      if (!settled) { settled = true; cleanup(); reject(e); }
    }
  });
}

async function liveAacMseBegin(atSec) {
  const d = LIVE.cbr;
  if (!d || d.kind !== 'mp4') return false;
  if (!(window.MediaSource && MediaSource.isTypeSupported && MediaSource.isTypeSupported(d.mseType))) {
    throw new Error('这个浏览器不支持只播音轨（' + d.mseType + '）');
  }
  const anchor = Math.max(0, Number.isFinite(atSec) ? atSec : liveMseAnchor());
  try { audio.pause(); } catch (e) {}
  try { audio.removeAttribute('src'); audio.load(); } catch (e) {}
  await new Promise(r => setTimeout(r, 250));
  const ms = new MediaSource();
  const m = {
    media: ms, sb: null, url: '', first: false, total: d.durSec,
    seq: 0, pending: [], queuedBytes: 0, base: anchor, playing: false, kind: 'aac',
  };
  LIVE.mse = m;
  m.url = URL.createObjectURL(ms);
  let opened = false;
  for (let attempt = 0; attempt < 5 && !opened; attempt++) {
    try { audio.pause(); } catch (e) {}
    audio.src = m.url;
    try { audio.load(); } catch (e) {}
    opened = await new Promise(resolve => {
      if (ms.readyState === 'open') { resolve(true); return; }
      const on = () => { ms.removeEventListener('sourceopen', on); clearTimeout(timer); resolve(true); };
      ms.addEventListener('sourceopen', on);
      const timer = setTimeout(() => {
        ms.removeEventListener('sourceopen', on);
        resolve(false);
      }, 3000);
    });
  }
  if (!opened) throw new Error('MediaSource 打不开（不支持只播音轨）');
  if (audio.src !== m.url) { audio.src = m.url; try { audio.load(); } catch (e) {} }
  m.sb = ms.addSourceBuffer(d.mseType);
  // SourceBuffer 进入 error 状态后，后面每次 appendBuffer 都只会抛 InvalidStateError，
  // 真正的原因（哪一段被解析器拒绝）只在第一次的 error 事件里，所以把它记下来。
  m.sb.addEventListener('error', () => {
    const e = m.sb.error || {};
    m.lastErr = 'sb error: ' + (e.message || e.name || '?') + ' @seq=' + (m.seq || 0)
      + ' @ready=' + ms.readyState;
  });
  // 队列里有下一段就立刻推进：不然要等下一次 pump（约 1 秒）才 append 第二段，
  // 播放侧多出来的空档会被「等待播放缓冲」判定放大成停顿。
  m.sb.addEventListener('updateend', () => { if (LIVE.mse === m) liveMseKick(); });
  const init = liveAacInitSegment(d);
  m.init = init.bytes;
  await liveSbAppend(m.sb, init.bytes);
  try { if (d.durSec > 0) ms.duration = d.durSec; } catch (e) {}
  try { audio.currentTime = anchor; } catch (e) {}
  audio.playbackRate = prefs.speed || 1;
  return true;
}

// 单流模式下 MP4 的取窗：同一份字节既拼分片喂 MSE，又解成 PCM 喂识别。
async function liveFetchWindowAacMse(startSec, seconds) {
  const d = LIVE.cbr;
  const m = LIVE.mse;
  const s = await liveFetchSamplesMp4(startSec, seconds);
  if (!m || !m.sb) return liveDecodeMp4Window(d, s.flat, s.marks, s.i0, s.i1);
  // 按样本切成小片入队（原因见 liveAacSplit）；播放侧的时间轴由每片的 tfdt 自报。
  const parts = liveAacSplit(d, s, 100);
  for (const p of parts) liveMsePush(new Uint8Array(p.bytes), p.start);
  return liveDecodeMp4Window(d, s.flat, s.marks, s.i0, s.i1);
}

// 取 [startSec, startSec+seconds) 这段：按码率算出字节范围 → 重同步到帧边界 → 解码成 16k 单声道。
// MP4 走样本表路径（liveFetchWindowMp4），不再按码率猜字节位置。
async function liveFetchWindow(startSec, seconds) {
  const c = LIVE.cbr;
  if (!c) return null;
  if (c.kind === 'mp4') return liveFetchWindowMp4(startSec, seconds);
  if (!LIVE.ctx) return null;
  const from = Math.max(0, c.origin + Math.floor(startSec * c.bps) - 8192);
  const to = c.origin + Math.ceil((startSec + seconds) * c.bps) + 16384;
  const bytes = await liveFetchRange(from, to);
  let i = 0;
  while (i + 4 <= bytes.length) {
    if (bytes[i] === 0xFF && (bytes[i + 1] & 0xE0) === 0xE0) {
      const h = liveMp3Frame(bytes, i);
      // 连续两帧都对上才算真的帧边界，避免把帧内数据误当同步字。
      if (h && i + h.len + 4 <= bytes.length && liveMp3Frame(bytes, i + h.len)) break;
    }
    i += 1;
  }
  if (i + 4 > bytes.length) return null;
  let p = i, frames = 0;
  while (p + 4 <= bytes.length) {
    const h = liveMp3Frame(bytes, p);
    if (!h || p + h.len > bytes.length) break;
    p += h.len;
    frames += 1;
    if (frames * c.spf / c.sr >= seconds + 2) break;   // 别因为服务端忽略 Range 就解出一整集
  }
  if (p <= i) return null;
  const slice = bytes.slice(i, p);
  const start = Math.max(0, (from + i - c.origin) / c.bps);
  const buf = await liveDecodeAudio(slice.buffer);
  return { pcm: buf.getChannelData(0), start };
}

// ── 单流播放 ──────────────────────────────────────────────────────────────
// 同一份字节只下载一次：MP3 走帧解析、MP4/AAC 走样本表，取回来的字节既 append 给
// MediaSource 播放，又解码成 PCM 喂识别，所以识别能真正跑到播放前面，不再受“播放器
// 只缓冲十几秒”的限制。默认开启（prefs.liveMse）；MSE 不支持该 mime 时自动退回
// 原生播放 + Range 取音频的老路径。
// 等音频拿到元数据；换集后要在这里等新一集的音频，否则锚点会算成 0。
function liveWaitAudioReady(timeoutMs) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const step = () => {
      if (audio.readyState >= 1 && audio.duration > 0) { resolve(true); return; }
      if (Date.now() - t0 > timeoutMs) { resolve(false); return; }
      setTimeout(step, 300);
    };
    step();
  });
}

function liveMseCapable() {
  try {
    const c = LIVE.cbr;
    const mime = c && c.kind === 'mp4' ? (c.mseType || '') : 'audio/mpeg';
    return !!(window.MediaSource && MediaSource.isTypeSupported && mime
      && MediaSource.isTypeSupported(mime));
  } catch (e) { return false; }
}

// 接管起点：当前播放头；还没开始播就用记住的位置（恢复进度会 seek 到这里，
// 锚在 0 上等它跳过来就会正好落到没有数据的区间，卡住不动）。
function liveMseAnchor() {
  const head = livePlayhead();
  if (head > 1) return head;
  const resume = Number(state.resumeAt);
  return Number.isFinite(resume) && resume > 1 ? resume : head;
}

async function liveMseBegin(atSec) {
  if (!LIVE.cbr) return false;
  // AAC 走 fMP4 分片（只播音轨，不下视频帧）；MP3 还是原来那套自由字节流。
  if (LIVE.cbr.kind === 'mp4') return liveAacMseBegin(atSec);
  if (!liveMseCapable()) return false;
  const c = LIVE.cbr;
  const d0 = liveAudioDuration();
  const total = Number.isFinite(d0) && d0 > 0 ? d0
    : (Number.isFinite(state.audioSeconds) && state.audioSeconds > 0 ? state.audioSeconds : 0);
  // 起点必须和元素当前的播放头一致：append 的时间轴从 base 开始，元素也 seek 到
  // base，两边差一点点（比如往前挪 0.25 秒）就会落到没有数据的区间、停在那里不动。
  const anchor = Math.max(0, Number.isFinite(atSec) ? atSec : liveMseAnchor());
  // 先把上一个 MediaSource 从元素上彻底摘掉再建新的。同一个标签页里反复
  // new MediaSource() 时，旧实例还挂在元素上会让新实例一直停在 'closed'
  // （实测第三次接管开始必现，换新标签页就正常）。先 removeAttribute + load
  // 断开，等一拍让 detach 生效，再建新实例。
  try { audio.pause(); } catch (e) {}
  try { audio.removeAttribute('src'); audio.load(); } catch (e) {}
  await new Promise(r => setTimeout(r, 250));
  const ms = new MediaSource();
  const m = {
    media: ms, sb: null, url: '', first: true, total, seq: 0, pending: [], queuedBytes: 0,
    base: anchor, playing: false,
  };
  LIVE.mse = m;
  LIVE.byteSec = anchor;
  LIVE.bytePos = c.origin + Math.round(c.bps * anchor);
  m.url = URL.createObjectURL(ms);
  // 页面自己的载入流程可能还在跑（它会把 src 换回原始地址），所以连续重试几次，
  // 直到 MediaSource 真的打开；同一实例重复挂 src 是安全的。
  let opened = false;
  for (let attempt = 0; attempt < 5 && !opened; attempt++) {
    try { audio.pause(); } catch (e) {}
    audio.src = m.url;
    try { audio.load(); } catch (e) {}
    opened = await new Promise(resolve => {
      if (ms.readyState === 'open') { resolve(true); return; }
      const done = ok => { ms.removeEventListener('sourceopen', on); clearTimeout(timer); resolve(ok); };
      const on = () => done(true);
      ms.addEventListener('sourceopen', on);
      const timer = setTimeout(() => done(false), 3000);
    });
  }
  if (!opened) throw new Error('MediaSource 打不开（这个浏览器不支持 MP3 单流播放）');
  if (audio.src !== m.url) { audio.src = m.url; try { audio.load(); } catch (e) {} }
  m.sb = ms.addSourceBuffer('audio/mpeg');
  // duration 必须在没有 SourceBuffer 正在 updating 时设，否则报 updating is true。
  try { if (m.total) ms.duration = m.total; } catch (e) {}
  try { audio.currentTime = anchor; } catch (e) {}
  audio.playbackRate = prefs.speed || 1;
  return true;
}

// 把一段原始字节入队；真正的 append 由 pump 每轮推进一次（SourceBuffer 一次只能
// 有一个 append 在跑，等在 updateend 上等不到就会把整条队列挂死）。
function liveMsePush(slice, startSec) {
  const m = LIVE.mse;
  if (!m || !m.sb || !slice || !slice.length) return;
  m.pending.push({ slice, start: Math.max(0, startSec) });
  m.queuedBytes += slice.length;
  liveMseKick();
}

function liveMseKick() {
  const m = LIVE.mse;
  if (!m || !m.sb || !m.pending.length) return;
  const sb = m.sb;
  if (sb.updating) return;
  const item = m.pending.shift();
  m.queuedBytes -= item.slice.length;
  try {
    if (m.first) { sb.timestampOffset = item.start; m.first = false; }
    m.seq = (m.seq || 0) + 1;
    sb.appendBuffer(item.slice);
  } catch (e) {
    m.lastErr = (e && e.name ? e.name : String(e)) + ': ' + (e && e.message ? e.message : '')
      + ' @ready=' + (m.media ? m.media.readyState : '?');
  }
}

// 跳转后重锚：不复用同一个 MediaSource —— 换过 timestampOffset 之后元素侧的
// buffered 会和老区间对不上（实测新数据落进 sb 了，元素却只认旧区间，停在空地方
// 不动）。整条管线按新位置重建一次，比在一个 ms 上改时间轴可靠。
async function liveMseReanchor(head) {
  const wasPlaying = !audio.paused;
  LIVE.prefetchQ = [];
  LIVE.prefetchFrom = head;
  const old = LIVE.mse;
  if (old) {
    LIVE.mse = null;
    try { if (old.sb) old.sb.abort(); } catch (e) {}
    setTimeout(() => { try { URL.revokeObjectURL(old.url); } catch (e) {} }, 500);
  }
  let ok = false;
  try { ok = await liveMseBegin(head); } catch (e) { ok = false; }
  if (!ok) { liveMseStop(); return false; }
  if (wasPlaying) audio.play().catch(() => {});
  return true;
}

// 缓冲只留最近 40 秒，否则一整集会一直堆在内存里。
function liveMseTrim(head) {
  const m = LIVE.mse;
  if (!m || !m.sb || m.sb.updating) return;
  const b = m.sb.buffered;
  if (!b.length) return;
  const start = b.start(0);
  if (head - start > 40) { try { m.sb.remove(start, head - 20); } catch (e) {} }
}

// 关单流：把播放还回原生元素，并接着上次的位置继续。
function liveMseStop(why) {
  const m = LIVE.mse;
  if (!m) return;
  LIVE.mseWhy = (why || 'call') + ' @' + Math.round(audio.currentTime || 0)
    + ' src=' + String(audio.src).slice(0, 24) + ' err=' + (m.lastErr || '-');
  LIVE.mse = null;
  const pos = audio.currentTime || 0;
  const wasPlaying = !audio.paused;
  const src = LIVE.audioUrl || '';
  try { if (m.sb) m.sb.abort(); } catch (e) {}
  try { audio.pause(); } catch (e) {}
  const restore = () => {
    try { if (pos > 0.5) audio.currentTime = pos; } catch (e) {}
    audio.playbackRate = prefs.speed || 1;
    if (wasPlaying) audio.play().catch(() => {});
  };
  if (src) {
    audio.src = src;
    try { audio.load(); } catch (e) {}
    let done = false;
    const once = () => { if (done) return; done = true; restore(); };
    audio.addEventListener('loadedmetadata', once, { once: true });
    setTimeout(once, 3000);
  }
  setTimeout(() => { try { URL.revokeObjectURL(m.url); } catch (e) {} }, 800);
}

async function liveFetchWindowMse(startSec, seconds) {
  const c = LIVE.cbr;
  if (!c) return null;
  if (c.kind === 'mp4') return liveFetchWindowAacMse(startSec, seconds);
  if (!LIVE.ctx) return null;
  const from = Math.max(0, LIVE.bytePos);
  const to = from + Math.ceil(seconds * c.bps) + 16384;
  const bytes = await liveFetchRange(from, to);
  let i = 0;
  while (i + 4 <= bytes.length) {
    if (bytes[i] === 0xFF && (bytes[i + 1] & 0xE0) === 0xE0) {
      const h = liveMp3Frame(bytes, i);
      if (h && i + h.len + 4 <= bytes.length && liveMp3Frame(bytes, i + h.len)) break;
    }
    i += 1;
  }
  if (i + 4 > bytes.length) return null;
  let p = i, frames = 0;
  while (p + 4 <= bytes.length) {
    const h = liveMp3Frame(bytes, p);
    if (!h || p + h.len > bytes.length) break;
    p += h.len;
    frames += 1;
    if (frames * c.spf / c.sr >= seconds) break;
  }
  if (p <= i) return null;
  const start = Math.max(0, LIVE.byteSec + i / c.bps);
  const slice = bytes.slice(i, p);
  LIVE.bytePos = from + p;
  LIVE.byteSec = start + frames * c.spf / c.sr;
  liveMsePush(slice, start);
  try {
    const buf = await liveDecodeAudio(slice.buffer);
    return { pcm: buf.getChannelData(0), start };
  } catch (e) {
    return null;
  }
}

const MP3_BR_V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_BR_V2L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MP3_SR_V1 = [44100, 48000, 32000];
const MP3_SR_V2 = [22050, 24000, 16000];
function liveMp3Frame(u8, i) {
  const b1 = u8[i + 1], b2 = u8[i + 2];
  if ((b1 & 0xE0) !== 0xE0) return null;
  const ver = (b1 >> 3) & 3;        // 3=MPEG1 2=MPEG2 0=MPEG2.5
  const layer = (b1 >> 1) & 3;      // 1 = Layer III
  if (ver === 1 || layer !== 1) return null;
  const brIdx = (b2 >> 4) & 15, srIdx = (b2 >> 2) & 3, pad = (b2 >> 1) & 1;
  if (!brIdx || brIdx === 15 || srIdx === 3) return null;
  const bitrate = (ver === 3 ? MP3_BR_V1L3 : MP3_BR_V2L3)[brIdx] * 1000;
  const sr = (ver === 3 ? MP3_SR_V1 : MP3_SR_V2)[srIdx];
  const spf = ver === 3 ? 1152 : 576;
  const len = Math.floor((ver === 3 ? 144 : 72) * bitrate / sr) + pad;
  return len > 0 ? { len, sr, spf, br: bitrate } : null;
}

function liveUpdateMeter() {
  const lead = liveLeadSec();
  const ahead = LIVE.on ? Math.max(0, LIVE.next - livePlayhead()) : 0;
  $('liveMeter').style.width = (lead > 0
    ? Math.min(100, Math.round(ahead / lead * 100))
    : (LIVE.on ? 100 : 0)) + '%';
  if (!LIVE.on) return;
  if (!LIVE.order.length) {
    // 还一句都没出来时也要更新文案，否则取音频失败会一直停在“实时识别中”，
    // 用户完全看不到问题（之前就踩过这个坑）。
    const wait = LIVE.fail
      ? '实时识别中 · 正在重试取音频（失败 ' + LIVE.fail + ' 次）'
      : '实时识别中 · 正在取音频…';
    if (wait !== LIVE.text) { LIVE.text = wait; liveSetText(wait, 'on'); }
    return;
  }
  const text = '实时识别中 · 已识别 ' + LIVE.order.length + ' 句'
    + (lead > 0 ? ' · 已提前 ' + Math.round(ahead) + ' 秒' : '');
  if (text !== LIVE.text) { LIVE.text = text; liveSetText(text, 'on'); }
}

// 每轮只喂到“播放位置 + 提前量”，并给每轮设 CPU 预算，避免长播客把界面拖住。
// 取回来的窗口解出的 PCM 缓存在 LIVE.pcm 里，跨轮一片一片喂；否则每轮都重新取字节
// 并整段解码、却只喂得进一两秒，剩下全扔掉，一轮就要一两秒，界面和播放都卡。
async function livePumpOnce(gen) {
  if (!LIVE.on || !LIVE.stream || !LIVE.cbr) return;
  // 音频还没拿到元数据时 currentTime 是 0、时长是 NaN，这时候按 0 锚定去喂，
  // 等播放器恢复到记住的位置（如 28:55）整段行的时间戳就全错。等它加载好再开始。
  // 单流模式下音频由我们自己 append，元素在拿到第一段数据前 readyState 一直是 0，
  // 按原生那套等就是死等，所以这里只要求 MediaSource 已经挂上 SourceBuffer。
  if (LIVE.mse) {
    liveMseKick();
    if (!LIVE.mse.sb) { liveSetText('等待音频加载…', 'busy'); return; }
    // 页面的载入流程把 src 换回原始地址了（换集、重试音源）：单流已脱管，
    // 退回普通播放路径，识别照常继续，不要卡死在这。
    if (audio.src !== LIVE.mse.url) { liveMseStop('detach'); }
    else {
      // 播放头被拖到了缓冲之外（跳转、恢复进度、拖动进度条）。MSE 模式里元素在
      // 拿到新位置的数据**之前不会发 seeked**，靠事件重锚会死锁在这里，所以每轮
      // 自己看一次：播放头不在已 append 的区间里就按新位置重建管线。
      // b.length 为 0 时也要看：从片尾（缓冲早已清空、只剩一个空 MediaSource）
      // 往回拖时 buffered 是空的、LIVE.next 还停在旧位置，只按区间判断永远等不到
      // “跳出去”那一刻，元素就一直 seeking（实测卡在 300 秒不动、也不出句）。
      const m = LIVE.mse, b = m.sb.buffered, head0 = audio.currentTime || 0;
      const inside = b.length && head0 >= b.start(0) - 1 && head0 <= b.end(b.length - 1) + 1;
      const drifted = !inside && head0 > 1
        && (b.length > 0 || m.seq > 0 || Math.abs(head0 - m.base) > 5);
      if (!m.reanchoring && drifted) {
        m.reanchoring = true;
        liveMseReanchor(head0).then(ok => { if (LIVE.on && ok) liveRebuildStream(); });
        return;
      }
    }
  } else if (audio.readyState < 1 || !(audio.duration > 0)) {
    liveSetText('等待音频加载…', 'busy');
    return;
  }
  const head = livePlayhead();
  // 播放头跑到了我们前面（换过音频、长时间缓冲、网络卡了一下、进度恢复）。
  // 这里**不清行**：以前清行重建，网络一抖读者就看到整屏行消失、高亮跳回第一行。
  // 阈值也不能小：慢网下一次取窗口要一两秒，next 天然落后播放头一两秒，
  // 按 2 秒判就会每轮都重建流、永远喂不进音频（表现为高亮停在某一句不动）。
  if (head - LIVE.next > 20) {
    if (head - LIVE.next > 120) liveClearRows();
    // 单流模式下播放头跑到缓冲外（跳转、恢复进度、网络卡顿），必须按新位置重建管线：
    // 只在同一个 MediaSource 上改时间轴，元素侧会认旧区间、停在空地方不动。
    if (LIVE.mse) { liveMseReanchor(head).then(ok => { if (LIVE.on && ok) liveRebuildStream(); }); return; }
    liveRebuildStream();
    return;
  }
  const target = Math.min(liveAudioDuration(), head + liveLeadSec());
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const elapsed = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started;
  let guard = 0;
  while (LIVE.on && gen === LIVE.pumpGen && LIVE.next < target - 1 && guard < 6 && elapsed() < LIVE_BUDGET_MS) {
    guard += 1;
    const p = LIVE.pcm;
    const covered = p && LIVE.next >= p.start - 0.05 && p.start + p.data.length / LIVE_RATE > LIVE.next + 0.05;
    if (!covered) {
      // 播放优先：音频自己快没数据了（缓冲见底）就先别抢带宽去取新窗口，
      // 源站只有一两百 KB/s，抢了播放就会卡。阈值取 2.5 秒：再大在弱网下
      // 会一直让路，识别几乎不长行（读者看到的就是“不可用”）。
      const ahead = liveBufferAhead();
      if (ahead > 0 && ahead < 2.5) { liveSetText('等待播放缓冲…', 'busy'); return; }
      const need = Math.max(4, Math.min(LIVE_FETCH, target - LIVE.next + 1));
      let win = null;
      // 预取命中：队列里已经备好了下一个窗口，直接用，不排队等网络。
      const q = LIVE.prefetchQ;
      if (q.length && Math.abs(q[0].start - LIVE.next) < 2) win = q.shift();
      try {
        if (!win) {
          win = LIVE.mse
            ? await liveFetchWindowMse(LIVE.next, need)   // 单流：同一份字节既 append 给播放又解码给识别
            : await liveFetchWindow(LIVE.next, need);
        }
      } catch (err) {
        LIVE.fail += 1;
        const msg = '音频片段取不到，正在重试（第 ' + LIVE.fail + ' 次）：'
          + (err && err.message ? err.message : err);
        if (LIVE.fail >= 6) liveSetText(msg, 'err');
        return;
      }
      if (!LIVE.on || !LIVE.stream || gen !== LIVE.pumpGen) return;
      if (!win || !win.pcm || !win.pcm.length) return;
      LIVE.fail = 0;
      // 窗口起点可能和已喂过的位置重叠几帧，切掉重叠部分，时间轴才连续；
      // 尾巴也截到本轮目标位置，提前量才准。
      let data = win.pcm, start = win.start;
      // 反面情况：窗口起点比已喂到的位置还靠前一大截（字节游标在重建/跳转后跑到前面去了）。
      // 这时 wantEnd 落在 start 之前，裁剪只会剩 1 个采样，LIVE.next 永远不动 ——
      // 实测表现就是“已提前”一路掉到 0 之后再也不恢复。直接把喂点对齐到窗口起点。
      if (start > LIVE.next + 0.05) LIVE.next = start;
      if (start < LIVE.next) {
        const skipN = Math.min(data.length, Math.round((LIVE.next - start) * LIVE_RATE));
        if (skipN > 0) { data = data.subarray(skipN); start += skipN / LIVE_RATE; }
      }
      const wantEnd = LIVE.next + need;
      if (start + data.length / LIVE_RATE > wantEnd) {
        data = data.subarray(0, Math.max(1, Math.round((wantEnd - start) * LIVE_RATE)));
      }
      if (!data.length) return;
      LIVE.pcm = { start, data };
      // 立刻把后面的窗口排进预取队列。源站单次 Range 请求实测会卡十几秒，串行地等
      // 它返回就会把识别饿死（表现是“已提前”一路掉到 0 之后不动），预取能让这段
      // 网络时间和喂音频、跑模型重叠起来。
      LIVE.prefetchFrom = win.start + win.pcm.length / LIVE_RATE;
      livePrefetchLoop();
    }
    const cur = LIVE.pcm;
    let off = Math.max(0, Math.round((LIVE.next - cur.start) * LIVE_RATE));
    try {
      // transcribe() 是最贵的一步：它要把积压的音频跑一遍模型，积压越多越慢
      // （实测一次积压 12 秒就要 500 毫秒以上，界面直接定住）。所以按 0.5 秒一片喂、
      // 一片跑一次识别，且一轮只跑一次；跑之前先看预算，宁可留到下一轮再跑。
      while (off < cur.data.length && elapsed() < LIVE_BUDGET_MS) {
        const chunk = cur.data.subarray(off, Math.min(cur.data.length, off + LIVE_SLICE));
        LIVE.stream.addAudio(chunk, LIVE_RATE);
        off += chunk.length;
        LIVE.fed += chunk.length;
        LIVE.next = cur.start + off / LIVE_RATE;
        // 识别多久跑一次：Moonshine 每 2 秒攒一批（它的 transcribe 一次 100~200 ms，
        // 跑太勤界面会顿）；sherpa 是增量解码，单次便宜得多，0.5 秒一片就跟着解一次，
        // 高亮才跟得上词。
        const trBatch = LIVE.engine && LIVE.engine.kind === 'sherpa' ? LIVE_SLICE : LIVE_TR_BATCH;
        if (LIVE.fed - LIVE.lastTr >= trBatch) {
          LIVE.stream.transcribe();
          LIVE.lastTr = LIVE.fed;
          break;   // 一轮只跑一次识别：多跑一次就多一段长任务，界面又开始顿
        }
        await new Promise(r => setTimeout(r, 0));
        if (!LIVE.on || gen !== LIVE.pumpGen) return;
      }
    } catch (err) {
      liveDisable('识别引擎出错，已停止实时识别：' + (err && err.message ? err.message : err));
      return;
    }
    if (off < cur.data.length) break;   // 预算用完，下一轮接着喂缓存里的同一段
    LIVE.pcm = null;                    // 这段喂完了，下一轮再取新的
  }
}

// 后台预取窗口（不阻塞喂音频）：队列里始终备着两段，网络卡一下也不至于把识别饿死。
function livePrefetchLoop() {
  if (!LIVE.on || !LIVE.cbr || LIVE.prefetching) return;
  // 单流模式不能并发取窗：LIVE.bytePos 是播放和识别共用的游标，两路同时取会把游标
  // 推乱（实测 pump 请求 624 秒时，预取已经把游标推到 745 秒，回来的是 745 秒的窗）。
  if (LIVE.mse) return;
  const gen = LIVE.pumpGen;
  LIVE.prefetching = true;
  (async () => {
    try {
      while (LIVE.on && gen === LIVE.pumpGen && LIVE.prefetchQ.length < 2) {
        const tail = LIVE.prefetchQ[LIVE.prefetchQ.length - 1];
        const from = tail ? tail.start + tail.pcm.length / LIVE_RATE : LIVE.prefetchFrom;
        const w = LIVE.mse
          ? await liveFetchWindowMse(from, LIVE_FETCH)
          : await liveFetchWindow(from, LIVE_FETCH);
        if (!w) { await new Promise(r => setTimeout(r, 200)); continue; }
        LIVE.prefetchQ.push(w);
      }
    } catch (e) {
      // 取不到就留给 pump 走原来的重试路径，别把队列堵死
    } finally {
      LIVE.prefetching = false;
    }
  })();
}

function liveStartPump() {
  // 不能用“正在跑”挡住重启：rebuild 常常是在一次 pump 内部同步触发的，
  // 这时 pumping 还是 true，挡住就再也不会有人调度下一轮（表现为识别停住）。
  // 在飞的旧泵靠 pumpGen 判断自己过期，不会重复喂音频。
  if (LIVE.pumpTimer) return;
  const gen = LIVE.pumpGen;
  const tick = () => {
    LIVE.pumpTimer = 0;
    if (!LIVE.on || gen !== LIVE.pumpGen) return;
    LIVE.pumping = true;
    livePumpOnce(gen).catch(() => {}).then(() => {
      LIVE.pumping = false;
      liveUpdateMeter();
      if (LIVE.on && gen === LIVE.pumpGen) LIVE.pumpTimer = setTimeout(tick, 160);
    });
  };
  LIVE.pumpTimer = setTimeout(tick, 0);
}

function liveStopPump() {
  LIVE.pumpGen += 1;          // 在飞的 pump 用它判断“自己已经过期”
  if (LIVE.pumpTimer) clearTimeout(LIVE.pumpTimer);
  LIVE.pumpTimer = 0;
}

/* ---------- 调试钩子：实时识别排障（控制台里 __live 直接调内部函数） ---------- */
if (typeof window !== 'undefined') {
  window.__live = {
    LIVE,
    prefs,
    probe: () => liveProbeAudio(),
    win: (a, b) => liveFetchWindow(a, b),
    aidx: (sec) => (LIVE.cbr && LIVE.cbr.kind === 'mp4'
      ? { i: liveSampleAt(LIVE.cbr.times, sec), t: LIVE.cbr.times[liveSampleAt(LIVE.cbr.times, sec)], n: LIVE.cbr.n }
      : null),
    init: () => (LIVE.cbr && LIVE.cbr.kind === 'mp4' ? liveAacInitSegment(LIVE.cbr).bytes : null),
    samples: (a, b) => liveFetchSamplesMp4(a, b),
    frag: (s) => {
      LIVE.fseq = (LIVE.fseq || 0) + 1;
      return liveAacFragment(LIVE.cbr, LIVE.fseq, s.i0, s.i1, s.flat, s.marks).bytes;
    },
    fragParts: (s, per) => liveAacSplit(LIVE.cbr, s, per || 100).map(f => f.bytes),
  };
}


registerTranscriber('native', { load: () => liveNativeLoad() });
registerTranscriber('sherpa', { load: () => liveSherpaLoad() });
registerTranscriber('moonshine', { load: () => liveMoonshineLoad() });

async function liveLoadEngine() {
  if (LIVE.engine) return LIVE.engine;
  const adapter = transcriberFor(LIVE_ENGINE_KIND);
  if (!adapter) throw new Error('未知识别引擎：' + LIVE_ENGINE_KIND);
  const engine = await adapter.load();
  LIVE.engine = engine;
  return engine;
}

/* ---------- 适配器：Moonshine 流式（WASM，词时间靠均分） ---------- */
async function liveMoonshineLoad() {
  // 多线程 WASM 要 SharedArrayBuffer，而 SAB 只在跨域隔离页面可用；这里提前拦，
  // 否则 Emscripten 的 pthread 引导会抛一个没人接的 DataCloneError，await 永远挂住。
  if (!self.crossOriginIsolated) throw new Error('识别引擎需要跨域隔离（COOP/COEP），请刷新页面后重试');
  const base = LIVE_ENGINE.replace(/index\.js$/, '');
  const [mod, moduleMod] = await Promise.all([import(LIVE_ENGINE), import(base + 'module.js')]);
  if (!mod || typeof mod.Transcriber !== 'function') throw new Error('识别引擎模块加载异常');
  const wasm = await moduleMod.loadMoonshineModule();
  // 目录加载接口拿不到带 attention 的解码器（catalog 清单里没有它），
  // 所以自己按清单拼 URL：词级时间戳依赖 decoder_kv_with_attention.ort，
  // 只设 word_timestamps=true 而不给这个文件，只会得到没有 words 的句子。
  const files = {};
  let baseUrl = '';
  try {
    // sttDependencies 返回的是 JSON 字符串（ABI 里是 std::string），不是对象。
    const manifest = JSON.parse(wasm.sttDependencies('en', String(LIVE_ARCH), false));
    (manifest.groups || []).forEach(group => {
      if (!baseUrl && group.base_url) baseUrl = String(group.base_url).replace(/\/$/, '');
      (group.files || []).forEach(f => { if (f && f.name && f.url) files[f.name] = f.url; });
    });
  } catch (err) {
    throw new Error('读不出模型清单：' + (err && err.message ? err.message : err));
  }
  if (!Object.keys(files).length) throw new Error('模型清单为空');
  if (baseUrl) files['decoder_kv_with_attention.ort'] = baseUrl + '/decoder_kv_with_attention.ort';
  // 模型文件同样不能用 fetch 从页面拉（同样是 credentialless 被地址空间策略拦掉），
  // 这里先用 XHR 取回字节，写进站内 “/__myt_model/” 虚拟路径的 Cache Storage，
  // 再把同源 URL 交给库：它加载时会 cache.put(url)，blob:/data: 这些 scheme 不被支持。
  const names = Object.keys(files);
  const local = {};
  const stage = 'myt-model-stage';
  let done = 0;
  const fetchOne = async name => {
    const bytes = await liveHttpGet(files[name], null, null);
    const cache = await caches.open(stage);
    // 路径里带架构号：不同架构的清单文件名是一样的（encoder.ort 等），
    // 共用同一个虚拟路径会让 Cache Storage 把小模型的字节喂给大模型。
    const url = new URL('/__myt_model/a' + LIVE_ARCH + '/' + encodeURIComponent(name), location.href).href;
    await cache.put(new Request(url), new Response(bytes, {
      headers: { 'Content-Type': 'application/octet-stream' },
    }));
    local[name] = url;
    done += 1;
    if (LIVE.busy) liveSetText('下载识别模型…（' + done + '/' + names.length + '）', 'busy');
  };
  const queue = names.slice();
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) { const name = queue.shift(); await fetchOne(name); }
  });
  try {
    await Promise.all(workers);
    const engine = await mod.Transcriber.loadFromUrls(local, {
      modelArch: LIVE_ARCH,
      module: wasm,
      options: { word_timestamps: 'true' },
      onProgress: (a, b, c) => {
        if (!LIVE.busy) return;
        const text = liveProgressText(a, b, c);
        if (text !== LIVE.progressText) { LIVE.progressText = text; liveSetText(text, 'busy'); }
      },
    });
    return engine;
  } finally {
    // 库自己会把这些 URL 再存一份，暂存区不用留着占 40 MB。
    try { await caches.delete(stage); } catch (e) {}
  }
}

/* ---------- 备用识别引擎：sherpa-onnx 流式 zipformer（WASM） ----------
   它和 Moonshine 最大的差别是结果里带「逐 token 的时间戳」，这是逐词高亮能准的前提。
   模型与 wasm 都不放我们自己服务器上：wasm 走 jsdelivr、模型走 Hugging Face，
   字节用 XHR 取回后写进 Emscripten 的虚拟文件系统（跨域 fetch 在 COEP 页面会被拦）。 */
function liveLoadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('脚本加载失败：' + url));
    document.head.appendChild(s);
  });
}

// 二进制先查 Cache Storage，没有再 XHR。模型 43 MB，第二次进来就不该再下。
async function liveSherpaBytes(name, baseUrl) {
  const key = new URL('/__myt_model/sherpa/' + encodeURIComponent(name), location.href).href;
  try {
    const cache = await caches.open(SHERPA_CACHE);
    const hit = await cache.match(new Request(key));
    if (hit) {
      const buf = await hit.arrayBuffer();
      if (buf.byteLength) return new Uint8Array(buf);
    }
  } catch (e) {}
  const bytes = await liveGetBytes(baseUrl + name, null, null, 0);
  try {
    const cache = await caches.open(SHERPA_CACHE);
    await cache.put(new Request(key), new Response(bytes, {
      headers: { 'Content-Type': 'application/octet-stream' },
    }));
  } catch (e) {}
  return new Uint8Array(bytes);
}

async function liveSherpaLoad() {
  if (LIVE.busy) liveSetText('下载识别模型…（wasm）', 'busy');
  const wasm = await liveSherpaBytes('sherpa-onnx-wasm-combined.wasm', SHERPA_CDN);
  // 提前把二进制塞给 Emscripten：页面是 COEP: credentialless，跨域 fetch 会被
  // 地址空间策略拦掉，让 Emscripten 自己去 fetch 就会挂在这。
  window.Module = {
    locateFile: f => SHERPA_CDN + f,
    wasmBinary: wasm.buffer,
    print: () => {},
    printErr: () => {},
  };
  await liveLoadScript(SHERPA_CDN + 'sherpa-onnx-wasm-combined.js');
  await liveLoadScript(SHERPA_CDN + 'sherpa-onnx-core.js');
  await new Promise((resolve, reject) => {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const tick = () => {
      if (window.Module && window.Module.calledRun) return resolve();
      if ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0 > 180000) {
        return reject(new Error('WASM 初始化超时'));
      }
      setTimeout(tick, 100);
    };
    tick();
  });
  await liveLoadScript(SHERPA_CDN + 'sherpa-onnx-asr.js');
  if (!window.SherpaOnnx || !window.SherpaOnnx.ASR || !window.OnlineRecognizer) {
    throw new Error('sherpa-onnx 模块没有挂上（JS 世界不一致？）');
  }
  const FS = window.Module.FS;
  const dir = '/myt-sherpa';
  try { FS.mkdir(dir); } catch (e) {}
  const names = Object.keys(SHERPA_FILES).map(k => SHERPA_FILES[k]);
  let done = 0;
  const fetchOne = async name => {
    const bytes = await liveSherpaBytes(name, SHERPA_BASE);
    FS.writeFile(dir + '/' + name, bytes);
    done += 1;
    if (LIVE.busy) liveSetText('下载识别模型…（' + done + '/' + names.length + '）', 'busy');
  };
  const queue = names.slice();
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) await fetchOne(queue.shift());
  }));
  const rec = window.SherpaOnnx.ASR.createOnlineRecognizer({
    modelDir: dir, type: 'transducer',
    actualPaths: {
      encoder: dir + '/' + SHERPA_FILES.encoder,
      decoder: dir + '/' + SHERPA_FILES.decoder,
      joiner: dir + '/' + SHERPA_FILES.joiner,
      tokens: dir + '/' + SHERPA_FILES.tokens,
    },
  }, {
    debug: 0, sampleRate: 16000, enableEndpoint: 0,
    rule1MinTrailingSilence: 2.4, rule2MinTrailingSilence: 1.2, rule3MinUtteranceLength: 20,
  });
  if (!rec || !rec.handle) throw new Error('sherpa 识别器创建失败');
  return { kind: 'sherpa', rec };
}

// token → 词。sherpa 给的是 SentencePiece 片段（" YE"、"LL"、"OW"），
// 以空格或 ▁ 开头的 token 才是新词的开始，其余接着拼到当前词上。
function liveSherpaWords(tokens, times, fedSec) {
  const words = [];
  let cur = null;
  for (let i = 0; i < tokens.length; i++) {
    const raw = String(tokens[i] == null ? '' : tokens[i]);
    const t = Number(times[i]);
    if (!raw || !Number.isFinite(t)) continue;
    const boundary = raw.charAt(0) === ' ' || raw.charAt(0) === '▁';
    const piece = (boundary ? raw.slice(1) : raw).trim();
    if (!piece) continue;
    if (boundary || !cur) {
      cur = { text: piece, s: t, e: t };
      words.push(cur);
    } else {
      cur.text += piece;
      cur.e = t;
    }
  }
  if (!words.length) return words;
  // 词尾 = 下一个词的起点（AntennaPod 的 computeWordEndTimes 同一套兜底），
  // 最后一个词用「已喂到哪」夹一下，避免行尾一个超长的词一直亮着。
  for (let i = 0; i < words.length - 1; i++) words[i].e = words[i + 1].s;
  words[words.length - 1].e = Math.min(fedSec, Math.max(words[words.length - 1].s + 0.15, fedSec));
  // 发射滞后校正：整段往前挪 SHERPA_LAG，再保证不倒退、不为负。
  let prev = -1;
  words.forEach(w => {
    w.s = Math.max(0, prev < 0 ? w.s - SHERPA_LAG : Math.max(prev, w.s - SHERPA_LAG));
    w.e = Math.max(w.s + 0.08, w.e - SHERPA_LAG);
    prev = w.s;
  });
  return words;
}

// 把「这一路流当前的 token/时间戳」变成一行行字幕。sherpa-wasm 和原生推理共用这一套：
// 断行不看 endpoint（播客几乎一直在说话，端点会连着为真，靠它就变成一行一个词），
// 改成按显示需要自己断：一行最长 12 秒 or 40 个词；定稿的词不再回头改。
// 返回 true 表示这一路流的特征帧攒得太多了（>200 词），调用方该重置解码器。
function liveEmitTokens(session, st, tokens, times) {
  const words = liveSherpaWords(tokens || [], times || [], st.fed);
  if (!words.length) return false;
  // 只显示还没定稿的那一段：词典是只追加的，已经写进正文的词不必再动。
  const tail = words.slice(Math.min(st.cursor, words.length));
  if (!tail.length) return false;
  const lineStart = st.segBase + tail[0].s;
  const lineWords = tail.map(w => ({
    text: w.text,
    start: w.s - tail[0].s,
    end: w.e - tail[0].s,
  }));
  const duration = Math.max(0.1, lineWords[lineWords.length - 1].end);
  // zipformer 的输出习惯是全大写（" THE YELLOW LAMPS"），转小写才像正常字幕。
  const letters = lineWords.map(w => w.text).join('').replace(/[^A-Za-z]/g, '');
  if (letters.length && letters.replace(/[^A-Z]/g, '').length * 10 >= letters.length * 9) {
    lineWords.forEach(w => { w.text = w.text.toLowerCase(); });
  }
  const sig = st.lineId + '|' + lineWords.length + '|' + lineWords[lineWords.length - 1].text;
  const span = tail[tail.length - 1].e - tail[0].s;
  const needBreak = span > 12 || tail.length > 40;
  if (sig === st.lastSig && !needBreak) return false;
  st.lastSig = sig;
  liveRenderLine(session, {
    id: st.lineId, text: lineWords.map(w => w.text).join(' '),
    startTime: lineStart, duration, words: lineWords, isComplete: needBreak,
  });
  if (!needBreak) return false;
  // 只断显示、不重置解码器：识别还在同一句里继续，时间轴也没断。
  st.cursor = words.length;
  st.lineId += 1;
  st.lastSig = '';
  // 解码器迟早要重置一次，否则这一路流里的特征帧会一直攒着（每小时几十 MB）。
  return words.length > 200;
}

// 把 sherpa 的“当前句”结果转成页面已有的行模型（和 Moonshine 的 line 形状对齐），
// 这样 liveRenderLine / liveWordTimes / 高亮那一套完全不用改。
function liveSherpaStream(session, anchor) {
  const rec = LIVE.engine.rec;
  const st = rec.createStream();
  const seg = { fed: 0, segBase: 0, lineId: 0, cursor: 0, lastSig: '' };
  let closed = false;
  return {
    addAudio(chunk, rate) {
      if (closed) return;
      st.acceptWaveform(rate, chunk);
      seg.fed += chunk.length / rate;
    },
    transcribe() {
      if (closed || session !== LIVE.session) return;
      let loops = 0;
      while (rec.isReady(st) && loops < 8) { rec.decode(st); loops += 1; }
      const r = rec.getResult(st) || {};
      const needReset = liveEmitTokens(session, seg, r.tokens, r.timestamps);
      if (needReset) {
        // 攒够 200 个词（约 1 分钟语音）就重置，下一段的 token 时间从当前喂点重新起算。
        try { rec.reset(st); } catch (e) {}
        seg.cursor = 0;
        seg.segBase = seg.fed;
      }
    },
    stop() {},
    close() {
      if (closed) return;
      closed = true;
      try { st.free(); } catch (e) {}
    },
  };
}
export { CORE_PROVIDER_DEFAULTS, CORE_PROVIDER_NAMES, CORE_PROVIDER_STACKS, LIVE_ARCH, LIVE_ENGINE, LIVE_ENGINE_ARG, LIVE_ENGINE_KIND, MP3_BR_V1L3, MP3_BR_V2L3, MP3_SR_V1, MP3_SR_V2, SHERPA_BASE, SHERPA_CACHE, SHERPA_CDN, SHERPA_FILES, SHERPA_LAG, TRANSCRIBER_ADAPTERS, clearLiveBarTimer, coreProvider, coreProviderLayer, coreProviderOwner, defineCoreProvider, installIpcGuard, liveAudioDuration, liveBarHideTimer, liveBufferAhead, liveDecodeAudio, liveEmitTokens, liveFetchRange, liveFetchWindow, liveFetchWindowMse, liveGetBytes, liveHostFetch, liveHttpGet, liveLeadSec, liveLoadEngine, liveLoadScript, liveMediaOf, liveMediaTime, liveMoonshineLoad, liveMp3Frame, liveMseAnchor, liveMseBegin, liveMseCapable, liveMseKick, liveMsePush, liveMseReanchor, liveMseStop, liveMseTrim, livePlayhead, livePrefetchLoop, liveProbeAudio, liveProbeScan, liveProgressText, livePumpOnce, liveRetry, liveSetText, liveSherpaBytes, liveSherpaLoad, liveSherpaStream, liveSherpaWords, liveStartPump, liveStopPump, liveUpdateMeter, liveWaitAudioReady, mytIpcGuard, pluginFrameInStack, registerCoreProvider, registerTranscriber, releaseCoreProviders, syncLiveLeadSelect, transcriberFor };
registerLayer('02-live-caption-wasm', { CORE_PROVIDER_DEFAULTS, CORE_PROVIDER_NAMES, CORE_PROVIDER_STACKS, LIVE_ARCH, LIVE_ENGINE, LIVE_ENGINE_ARG, LIVE_ENGINE_KIND, MP3_BR_V1L3, MP3_BR_V2L3, MP3_SR_V1, MP3_SR_V2, SHERPA_BASE, SHERPA_CACHE, SHERPA_CDN, SHERPA_FILES, SHERPA_LAG, TRANSCRIBER_ADAPTERS, clearLiveBarTimer, coreProvider, coreProviderLayer, coreProviderOwner, defineCoreProvider, installIpcGuard, liveAudioDuration, liveBarHideTimer, liveBufferAhead, liveDecodeAudio, liveEmitTokens, liveFetchRange, liveFetchWindow, liveFetchWindowMse, liveGetBytes, liveHostFetch, liveHttpGet, liveLeadSec, liveLoadEngine, liveLoadScript, liveMediaOf, liveMediaTime, liveMoonshineLoad, liveMp3Frame, liveMseAnchor, liveMseBegin, liveMseCapable, liveMseKick, liveMsePush, liveMseReanchor, liveMseStop, liveMseTrim, livePlayhead, livePrefetchLoop, liveProbeAudio, liveProbeScan, liveProgressText, livePumpOnce, liveRetry, liveSetText, liveSherpaBytes, liveSherpaLoad, liveSherpaStream, liveSherpaWords, liveStartPump, liveStopPump, liveUpdateMeter, liveWaitAudioReady, mytIpcGuard, pluginFrameInStack, registerCoreProvider, registerTranscriber, releaseCoreProviders, syncLiveLeadSelect, transcriberFor });
