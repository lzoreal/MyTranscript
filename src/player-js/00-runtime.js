
import { registerLayer } from './00-layers.js';/* layer: runtime —— 播放器共享上下文
   这里只放“谁都需要、且必须先于功能模块初始化”的单例：DOM 句柄、audio、状态容器、
   live 会话对象、宿主桥与偏好。功能模块通过 import 显式取用，不再依赖拼接顺序。 */
const $ = id => document.getElementById(id);
const audio = (() => {
  const a = document.createElement('audio');
  a.preload = 'metadata';
  document.body.append(a);
  return a;
})();
const listBox = $('epList'), box = $('transcript');

const state = { shows: [], show: null, feeds: new Map(), episodes: [], current: null,
  cues: [], nodes: [], activeCue: -1, wordIdx: -1,
  vtt: null, sidecar: null, zhVtt: null, base: null, experiment: null,
  mode: 'word', scroll: 'center', offset: 0, userScrollUntil: 0, pendingFollow: false, immersive: false,
  wallpaper: false,
  timeScale: 1, audioSeconds: 0, seekRaw: 0, loadSeq: 0, transcriptSeq: 0,
  aiAdRanges: [], regexAdRanges: [],
  localTranscript: false, skipPlan: null, skipDone: new Set(), skipMuted: new Set(),
  audioToken: 0, audioRetried: 0, audioUsed: new Set(),
  resumeEp: '', resumeAt: 0, audioKey: '', progressSavedAt: 0,
  alignMode: false, alignAt: 0,
  chapters: [], chapterIdx: -1, chapterKey: '', chapterSeq: 0, seekPreview: null,
  lastNowText: '', lastAriaText: '', lastSeekBucket: -1, lastPillAt: 0 };

// 状态写入的唯一入口：读仍是 state.x（只读），写一律 setState。
function setState(key, value) { state[key] = value; return state; }

const LIVE_RATE = 16000;
const LIVE_LEAD_DEFAULT = 60;
const LIVE_FETCH = 10;
const LIVE_BUDGET_MS = 220;
const LIVE_SLICE = LIVE_RATE / 2;
const LIVE_TR_BATCH = LIVE_RATE * 2;
const LIVE = {
  on: false, busy: false,
  engine: null, stream: null, session: 0,
  ctx: null, audioUrl: '', cbr: null, fail: 0, anchorMedia: 0, next: 0, fed: 0, lastTr: 0, pcm: null, pumpTimer: 0, pumpGen: 0, pumping: false, text: '',
  rows: new Map(), order: [], progressText: '', mode: 'idle', activeRow: '', cursor: 0,
  mse: null, bytePos: 0, byteSec: 0,
  prefetchWin: null, prefetching: false, prefetchQ: [], prefetchFrom: 0,
};

const ASR_MODEL_DEFAULT = 'en-mini';
const prefs = { speed: 1, autoNext: false, remember: true, liveLead: LIVE_LEAD_DEFAULT, liveMse: false, volume: 1, volumeCap: 1, muted: false, asrModel: ASR_MODEL_DEFAULT, queueOrder: 'sequential', skipAds: false, skipLevel: 2, skipSilence: false, loudness: false, skipChapterAds: false, modules: { discover: true, search: true, local: true, inbox: true, queue: true, history: true, stats: true, favorites: true, bookmarks: true, notes: true, listening: true, video: true, transcript: true, liveAsr: true, translate: true, floatWindow: true, chapters: true, offline: true, exportShare: true, study: true } };
function replacePrefs(next) {
  const source = next && typeof next === 'object' ? next : {};
  for (const key of Object.keys(prefs)) delete prefs[key];
  Object.assign(prefs, source);
  return prefs;
}

function tauriHost() { return window.__TAURI__ || null; }

const LIVE_HOST = (() => {
  if (window.MyTranscriptHost) return window.MyTranscriptHost;
  const T = tauriHost();
  if (!T || !T.core || typeof T.core.invoke !== 'function') return null;
  const call = (cmd, args) => T.core.invoke(cmd, args || {});
  return {
    kind: 'tauri',
    fetchRange: (url, from, to) => call('read_range', { url, from, to }),
    asrPrepare: model => call('asr_prepare', { model: model || 'en-mini' }),
    asrModels: () => call('asr_models', {}),
    asrRemove: model => call('asr_remove', { model }),
    asrImport: path => call('asr_import', { path }),
    asrCancel: model => call('asr_cancel', { model }),
    asrOpenDir: model => call('asr_open_dir', { model }),
    asrOpen: (modelDir, threads) => call('asr_open', { modelDir, threads }),
    asrFeed: (id, samples, sampleRate) => call('asr_feed', { id, samples, sampleRate }),
    asrResult: id => call('asr_result', { id }),
    asrReset: id => call('asr_reset', { id }),
    asrClose: id => call('asr_close', { id }),
    videoAsrStart: (url, modelDir, threads) => call('video_asr_start', { url, modelDir, threads }),
    videoAsrPoll: (sid, since) => call('video_asr_poll', { sid, since }),
    videoAsrCancel: sid => call('video_asr_cancel', { sid }),
    videoAsrClose: sid => call('video_asr_close', { sid }),
    httpText: url => call('http_text', { url }),
    offlineSave: (url, key) => call('offline_save', { url, key }),
    offlineTranscriptSave: (url, key) => call('offline_save_transcript', { url, key }),
    offlineTranscriptLoad: key => call('offline_transcript_load', { key }),
    offlineSkipSave: (url, key) => call('offline_save_skip', { url, key }),
    offlineSkipLoad: key => call('offline_skip_load', { key }),
    offlineList: () => call('offline_list', {}),
    offlineRemove: key => call('offline_remove', { key }),
    pluginList: () => call('plugin_list', {}),
    pluginSetEnabled: (id, enabled) => call('plugin_set_enabled', { id, enabled }),
    pluginOpenDir: () => call('plugin_open_dir', {}),
    pluginImport: path => call('plugin_import', { path }),
    pluginExample: () => call('plugin_example', {}),
    notify: (title, body) => call('notify', { title, body }),
    asset: p => (T.core.convertFileSrc ? T.core.convertFileSrc(p) : p),
  };
})();
function host() { return LIVE_HOST; }

export {
  $, audio, listBox, box, state, setState,
  LIVE_RATE, LIVE_LEAD_DEFAULT, LIVE_FETCH, LIVE_BUDGET_MS, LIVE_SLICE, LIVE_TR_BATCH,
  LIVE, ASR_MODEL_DEFAULT, prefs, replacePrefs, tauriHost, LIVE_HOST, host,
};
registerLayer('00-runtime', { $, audio, listBox, box, state, setState, LIVE_RATE, LIVE_LEAD_DEFAULT, LIVE_FETCH, LIVE_BUDGET_MS, LIVE_SLICE, LIVE_TR_BATCH, LIVE, ASR_MODEL_DEFAULT, prefs, replacePrefs, tauriHost, LIVE_HOST, host });
