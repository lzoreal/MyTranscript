import { MYTK } from './00-kernel.js';
import { $, LIVE, audio, box, host, prefs, setState, state, tauriHost } from './00-runtime.js';







import { layerObject, layerValue, lazyFn, registerLayer } from './00-layers.js';
const liveAdvance = lazyFn('03-native-asr-service-worker', 'liveAdvance');
const clipListen = lazyFn('04-local-audio-plugin-host', 'clipListen');
const emitPlugin = lazyFn('04-local-audio-plugin-host', 'emitPlugin');
const localAsrAvailable = lazyFn('04-local-audio-plugin-host', 'localAsrAvailable');
const subtitlePluginOn = lazyFn('04-local-audio-plugin-host', 'subtitlePluginOn');
const alignToCue = lazyFn('05-transport-transcript-nav', 'alignToCue');
const closeDockSheet = lazyFn('05-transport-transcript-nav', 'closeDockSheet');
const lookupWord = lazyFn('05-transport-transcript-nav', 'lookupWord');
const offlineKeyOf = lazyFn('05-transport-transcript-nav', 'offlineKeyOf');
const placeFrame = lazyFn('05-transport-transcript-nav', 'placeFrame');
const readJSON = lazyFn('05-transport-transcript-nav', 'readJSON');
const syncChapterNow = lazyFn('05-transport-transcript-nav', 'syncChapterNow');
const syncDockLang = lazyFn('05-transport-transcript-nav', 'syncDockLang');
const whenIdle = lazyFn('05-transport-transcript-nav', 'whenIdle');
const writeJSON = lazyFn('05-transport-transcript-nav', 'writeJSON');
const shareCurrentCue = lazyFn('06-catalog-feeds-search', 'shareCurrentCue');
const renderListening = lazyFn('07-routes-pages', 'renderListening');
const trPrimeCues = lazyFn('07-routes-pages', 'trPrimeCues');
const closeStudySheet = lazyFn('08-study-ai', 'closeStudySheet');
const studyApplyWordMarks = lazyFn('08-study-ai', 'studyApplyWordMarks');
const studyResetAutoPause = lazyFn('08-study-ai', 'studyResetAutoPause');
const studyResetPlayback = lazyFn('08-study-ai', 'studyResetPlayback');
const syncMini = lazyFn('09-player-integration', 'syncMini');
const syncMiniCaption = lazyFn('09-player-integration', 'syncMiniCaption');
const closeThemePop = lazyFn('10-desktop-bridge-tail', 'closeThemePop');
const openModal = lazyFn('10-desktop-bridge-tail', 'openModal');
const PluginHost = layerObject('04-local-audio-plugin-host', 'PluginHost');
const app = layerObject('05-transport-transcript-nav', 'app');
/* layer: view —— 主题、阅读器、导入、壁纸；module 入口与 kernel 解构
   本片只做该层的事，跨层调用走 kernel / host() / setState。 */

const overlayTriggers = { drawer: null, details: null, typeSheet: null, dockSheet: null };
function rememberOverlayTrigger(key, overlay) {
  const active = document.activeElement;
  if (active && active !== document.body && !overlay.contains(active)) overlayTriggers[key] = active;
}
function restoreOverlayFocus(key) {
  const target = overlayTriggers[key];
  overlayTriggers[key] = null;
  if (target && document.contains(target)) target.focus();
}
function setDrawerBackgroundInert(on) {
  ['.reader', '.dock', '.reader-top-actions'].forEach(selector => {
    const element = document.querySelector(selector);
    if (element) element.inert = on;
  });
}
/* 主题的一切（应用、卡片、编辑器、随包主题种子、初始恢复）都在 13-theme；
   这里只留同名转发，04 / 07 / 08 / 10 的 lazyFn 调用零改动。 */
const setTheme = lazyFn('13-theme', 'setTheme');
const applyCustomTheme = lazyFn('13-theme', 'applyCustomTheme');
const applyCustomThemePreset = lazyFn('13-theme', 'applyCustomThemePreset');
const renderCustomThemeGrid = lazyFn('13-theme', 'renderCustomThemeGrid');
const syncCustomThemeEditor = lazyFn('13-theme', 'syncCustomThemeEditor');
const bindCustomThemeEditor = lazyFn('13-theme', 'bindCustomThemeEditor');
const seedDefaultThemePacks = lazyFn('13-theme', 'seedDefaultThemePacks');
const importCustomTheme = lazyFn('13-theme', 'importCustomTheme');
const saveCustomThemePreset = lazyFn('13-theme', 'saveCustomThemePreset');
const themeBtns = lazyFn('13-theme', 'themeBtns');
const readCustomTheme = lazyFn('13-theme', 'readCustomTheme');
const writeCustomTheme = lazyFn('13-theme', 'writeCustomTheme');
const normalizeCustomTheme = lazyFn('13-theme', 'normalizeCustomTheme');
const sanitizeCustomHtml = lazyFn('13-theme', 'sanitizeCustomHtml');
const customPreviewColor = lazyFn('13-theme', 'customPreviewColor');
const customThemeActiveName = lazyFn('13-theme', 'customThemeActiveName');
const newCustomPresetId = lazyFn('13-theme', 'newCustomPresetId');
/* 导出字幕 / 分享当前句仍是本层的事：弹层与分享都走 10 / 06。 */
$('exportSubBtn').onclick = () => {
  openModal('<div class="modal-head"><h3>导出字幕</h3><button class="mini-btn" data-close-modal>✕</button></div>' +
    '<div class="modal-note">导出当前单集的文字稿；双语会同时写入两种语言。</div>' +
    '<div class="modal-actions" style="flex-wrap:wrap"><button class="btn ghost" data-export-sub="srt">SRT</button>' +
    '<button class="btn ghost" data-export-sub="vtt">VTT</button><button class="btn ghost" data-export-sub="txt">纯文本</button>' +
    '<button class="btn ghost" data-close-modal>取消</button></div>');
};
$('shareCueBtn').onclick = shareCurrentCue;


const READER_DEFAULTS = { width: 780, scale: 100, lh: 1.78, gap: 4, ls: 0.06, pending: 42, segment: true, lang: 'en' };
const readerFields = [
  ['width', 'rdWidth', 'outWidth', v => v + ' px'],
  ['scale', 'rdScale', 'outScale', v => v + '%'],
  ['lh', 'rdLh', 'outLh', v => Number(v).toFixed(2)],
  ['gap', 'rdGap', 'outGap', v => v + ' px'],
  ['ls', 'rdLs', 'outLs', v => Number(v).toFixed(2) + ' px'],
  ['pending', 'rdPending', 'outPending', v => v + '%'],
];
let reader = { ...READER_DEFAULTS };
/* 大屏默认把版心放宽：用户没动过宽度（仍是默认 780）时，1700 宽下约 1100，
   两侧不再空出近 500px；一旦用户自己拖过滑块，就完全按用户的值。 */
function readerWidth() {
  const base = Number(reader.width) || READER_DEFAULTS.width;
  if (base !== READER_DEFAULTS.width || !window.innerWidth) return base;
  const adaptive = Math.round(window.innerWidth * 0.66);
  return Math.max(base, Math.min(1100, adaptive));
}
function applyReader(persist = true) {
  const rs = document.documentElement.style;
  rs.setProperty('--reader-w', readerWidth() + 'px');
  rs.setProperty('--cue-scale', String(reader.scale / 100));
  rs.setProperty('--cue-lh', String(reader.lh));
  rs.setProperty('--cue-gap', reader.gap + 'px');
  rs.setProperty('--cue-ls', Number(reader.ls).toFixed(2) + 'px');
  rs.setProperty('--pending-op', String(reader.pending / 100));
  readerFields.forEach(([k, inp, out, fmt]) => { $(inp).value = reader[k]; $(out).textContent = fmt(reader[k]); });
  $('rdSegment').setAttribute('aria-checked', String(!!reader.segment));
  document.body.classList.toggle('lang-both', reader.lang === 'both');
  [...$('langSeg').children].forEach(b => {
    const on = b.dataset.lang === reader.lang;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });
  syncDockLang();
  if (persist) { try { localStorage.setItem('myt-reader', JSON.stringify(reader)); } catch (e) {} }
  syncJumpPill();
}
function rebuildCues() {
  if (!state.vtt) return;
  setState('cues', mergeCues(state.vtt, state.sidecar, state.zhVtt));
  renderCues();
  try { document.dispatchEvent(new Event('myt:cues-ready')); } catch (e) {}
}
readerFields.forEach(([k, inp]) => $(inp).addEventListener('input', e => { reader[k] = Number(e.target.value); applyReader(); }));
$('rdSegment').onclick = () => {
  reader.segment = !reader.segment;
  applyReader();
  rebuildCues();
};
$('langSeg').addEventListener('click', e => {
  const b = e.target.closest('button[data-lang]');
  if (!b) return;
  reader.lang = b.dataset.lang;
  applyReader();
  rebuildCues();
});
try {
  const saved = JSON.parse(localStorage.getItem('myt-reader') || 'null');
  if (saved && typeof saved === 'object') {
    readerFields.forEach(([k, inp]) => {
      const v = Number(saved[k]);
      if (Number.isFinite(v)) reader[k] = Math.min(Number($(inp).max), Math.max(Number($(inp).min), v));
    });
    if (typeof saved.segment === 'boolean') reader.segment = saved.segment;
    if (['en', 'zh', 'both'].includes(saved.lang)) reader.lang = saved.lang;
  }
} catch (e) {}
applyReader(false);
window.addEventListener('resize', () => applyReader(false));

function openTypeSheet() {
  rememberOverlayTrigger('typeSheet', $('typeSheet'));
  closeDetails(false); closeDockSheet(false);
  const sheet = $('typeSheet');
  sheet.removeAttribute('inert');
  sheet.classList.add('on');
  sheet.setAttribute('aria-hidden', 'false');
  $('typeBtn').setAttribute('aria-expanded', 'true');
  $('rdWidth').focus();
}
function closeTypeSheet(restore = true) {
  const sheet = $('typeSheet');
  const hadFocus = sheet.contains(document.activeElement);
  sheet.classList.remove('on');
  sheet.setAttribute('aria-hidden', 'true');
  sheet.setAttribute('inert', '');
  $('typeBtn').setAttribute('aria-expanded', 'false');
  if (restore && hadFocus) restoreOverlayFocus('typeSheet');
}
$('typeBtn').onclick = e => {
  e.stopPropagation();
  $('typeSheet').classList.contains('on') ? closeTypeSheet() : openTypeSheet();
};
$('typeClose').onclick = closeTypeSheet;
$('typeReset').onclick = () => {
  reader = { ...READER_DEFAULTS };
  applyReader();
  rebuildCues();
};
function setImportNote(text, cls = '') {
  const n = $('importNote');
  n.textContent = text;
  n.className = 'import-note' + (cls ? ' ' + cls : '');
}
function resetImportUI() {
  setImportNote('timings sidecar、实验包 JSON，或本地 .vtt；也可直接拖进正文。');
  $('restoreBtn').disabled = true;
  $('importFile').value = '';
}
function applyExperiment(obj, name) {
  const looksVtt = s => typeof s === 'string' && (/^\s*WEBVTT/.test(s) || s.includes('-->'));
  const sc = (Array.isArray(obj?.segments)) ? obj
    : (Array.isArray(obj?.sidecar?.segments)) ? obj.sidecar
    : (Array.isArray(obj?.timings?.segments)) ? obj.timings : null;
  const vttText = looksVtt(obj?.vtt) ? obj.vtt
    : looksVtt(obj?.vttText) ? obj.vttText : null;
  const zhText = looksVtt(obj?.zh) ? obj.zh
    : looksVtt(obj?.zhText) ? obj.zhText : null;
  const base = state.base;
  if (!sc && !vttText) throw new Error('找不到 segments 或 vtt 字段');
  const parsed = vttText ? parseVttSmart(vttText) : null;
  let vtt;
  if (vttText) {
    if (parsed.hasLatin) vtt = parsed.primary;
    else if (parsed.hasCjk) vtt = base?.vtt || state.vtt;
    else vtt = [];
    if (!vtt || !vtt.length) {
      throw new Error(parsed.hasCjk && !base?.vtt ? '这是中文字幕，请先加载一集再导入' : 'VTT 解析为空');
    }
  } else {
    vtt = base?.vtt || state.vtt;
    if (!vtt || !vtt.length) throw new Error('当前没有可套用的 VTT');
  }
  const sameAsBase = !!(base?.vtt && base.vtt.length === vtt.length &&
    Math.abs((base.vtt[0]?.start || 0) - (vtt[0]?.start || 0)) < 1);
  const sidecar = sc || (sameAsBase ? base.sidecar : null);
  if (sc) sc.native = nativeWordDoc(sc);
  const zhFromVtt = parsed?.hasCjk ? parsed.zh : null;
  const zh = zhText ? parseZhVTT(zhText)
    : (zhFromVtt || (sameAsBase ? base.zhVtt : (vttText ? null : state.zhVtt)));
  setState('vtt', vtt); setState('sidecar', sidecar); setState('zhVtt', zh); setState('experiment', name);
  setState('cues', mergeCues(vtt, sidecar, zh));
  renderCues();
  status('实验数据：' + name + ' · ' + vtt.length + ' 段' + (sidecar ? ' · ' + sidecar.segments.length + ' 组词级' : ' · 无词级') + (zh ? ' · 含中文' : ''), 'good');
  setImportNote('已导入 ' + name + (zh && reader.lang === 'en' ? '（切到中文/双语查看译文）' : ''), 'on');
  $('restoreBtn').disabled = !base;
}
function applyVttExperiment(text, name) {
  const parsed = parseVttSmart(text);
  if (!parsed.hasLatin && !parsed.hasCjk) throw new Error('VTT 解析为空');
  const base = state.base;
  let vtt, sidecar = null, zhVtt = null;
  if (!parsed.hasLatin) {
    if (!base?.vtt) throw new Error('这是中文字幕，请先加载一集再导入');
    vtt = base.vtt; sidecar = base.sidecar; zhVtt = parsed.zh;
  } else {
    vtt = parsed.primary;
    const same = !!(base?.vtt && base.vtt.length === vtt.length &&
      Math.abs((base.vtt[0]?.start || 0) - (vtt[0]?.start || 0)) < 1);
    sidecar = same ? base.sidecar : null;
    zhVtt = parsed.hasCjk ? parsed.zh : (same ? base.zhVtt : null);
  }
  setState('vtt', vtt); setState('sidecar', sidecar); setState('zhVtt', zhVtt); setState('experiment', name);
  setState('cues', mergeCues(vtt, sidecar, zhVtt));
  renderCues();
  const tag = !parsed.hasLatin ? '中文字幕' : parsed.hasCjk ? '双语字幕' : '英文字幕';
  status('实验数据：' + name + ' · ' + vtt.length + ' 段 · ' + tag + (sidecar ? ' · 词级保留' : ' · 无词级'), 'good');
  setImportNote('已导入 ' + name + '（' + tag + '）' + (zhVtt && reader.lang === 'en' ? '，切到中文/双语查看译文' : ''), 'on');
  $('restoreBtn').disabled = !base;
}
function restoreExperiment() {
  if (!state.base) return;
  setState('vtt', state.base.vtt); setState('sidecar', state.base.sidecar); setState('zhVtt', state.base.zhVtt);
  setState('experiment', null);
  setState('cues', mergeCues(state.vtt, state.sidecar, state.zhVtt));
  renderCues();
  status('已还原剧集数据', 'good');
  resetImportUI();
}
function importExperimentFile(file) {
  if (!file) return;
  const isJson = /\.json$/i.test(file.name) || file.type === 'application/json';
  const isVtt = /\.vtt$/i.test(file.name) || file.type === 'text/vtt';
  if (!isJson && !isVtt) { setImportNote('请选择 .json 或 .vtt 文件', 'err'); return; }
  file.text().then(txt => {
    if (isVtt) { applyVttExperiment(txt, file.name); return; }
    let obj;
    try { obj = JSON.parse(txt); } catch (e) { throw new Error('JSON 解析失败：' + e.message); }
    applyExperiment(obj, file.name);
  }).catch(err => {
    setImportNote(err.message, 'err');
    status('实验数据导入失败：' + err.message, 'warn');
  });
}
$('importBtn').onclick = () => $('importFile').click();
$('importFile').addEventListener('change', e => { importExperimentFile(e.target.files[0]); e.target.value = ''; });
$('restoreBtn').onclick = restoreExperiment;
['dragenter', 'dragover'].forEach(t => box.addEventListener(t, e => { e.preventDefault(); box.classList.add('drop'); }));
box.addEventListener('dragleave', e => { if (!box.contains(e.relatedTarget)) box.classList.remove('drop'); });
box.addEventListener('drop', e => {
  e.preventDefault();
  box.classList.remove('drop');
  const f = e.dataTransfer?.files?.[0];
  if (f) importExperimentFile(f);
});
document.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
document.addEventListener('drop', e => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
document.addEventListener('click', e => {
  if (!$('typeSheet').contains(e.target) && e.target !== $('typeBtn')) closeTypeSheet();
});

const { fmt, isBracket, esc, loaderHTML, findNorm, epKey, studyRegexEscape, studyNormText, emptyLine, statHTML, pluginPageKey, isJsonTranscript } = MYTK;
function status(t, cls='') { $('status').textContent = t; $('status').className = 'status ' + cls; }
let toastTimer = 0;
function showToast(text, ms = 6000) {
  if (typeof ms !== 'number') ms = 6500;
  const el = $('toast');
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), ms);
}
function hideToast() { clearTimeout(toastTimer); $('toast').classList.remove('on'); }
const PROGRESS_KEY = 'myt-progress';
let progressAllCache = null;
function invalidateProgressCache() { progressAllCache = null; }
function progressAll() {
  if (progressAllCache) return progressAllCache;
  try { progressAllCache = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}') || {}; }
  catch (e) { progressAllCache = {}; }
  return progressAllCache;
}
function writeProgressAll(all) {
  progressAllCache = all;
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(all)); } catch (e) {}
}
window.addEventListener('storage', event => { if (event.key === PROGRESS_KEY) progressAllCache = null; });
function progressKey(item) { return state.show ? state.show.slug + ':' + item.id : ''; }
function readProgress(item) {
  if (!item || prefs.remember === false) return 0;
  const t = Number(progressAll()[progressKey(item)]?.t);
  return Number.isFinite(t) && t > 5 ? t : 0;
}
function saveProgress(force) {
  const item = state.current;
  if (!item || !state.audioKey || audio.dataset.ep !== item.id) return;
  if (prefs.remember === false) return;
  const dur = audio.duration;
  const t = audio.currentTime || 0;
  if (!(dur > 0) || t < 3) return;
  const now = Date.now();
  if (!force && now - state.progressSavedAt < 5000) return;
  setState('progressSavedAt', now);
  const all = progressAll();
  all[state.audioKey] = {
    t: Math.round(t), d: Math.round(dur), at: now,
    show: state.show?.name || '', title: item.title || '', img: item.img || '',
    key: state.show?.slug || '', feed: state.show?.feed || '',
  };
  writeProgressAll(all);
}
function clearProgress() {
  if (!state.audioKey) return;
  const all = progressAll();
  if (!(state.audioKey in all)) return;
  delete all[state.audioKey];
  writeProgressAll(all);
}
function rememberPosition() {
  const ep = state.current?.id || '';
  if (audio.dataset.ep === ep && Number.isFinite(audio.currentTime) && audio.currentTime > 0) {
    setState('resumeEp', ep);
    setState('resumeAt', audio.currentTime);
  }
}
function resolveFinalAudioUrl(url) {
  return new Promise(resolve => {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctrl && ctrl.abort(), 8000);
    fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined }).then(r => {
      const finalUrl = r.url;
      if (r.body) r.body.cancel().catch(() => {});
      resolve(finalUrl && finalUrl !== url ? finalUrl : null);
    }).catch(() => resolve(null)).finally(() => clearTimeout(timer));
  });
}
// 音频常包在 dts.podtrac.com / pdst.fm / tracking.swap.fm 的跳转链里；浏览器
// 追踪防护或广告拦截会拦掉这些域名，而 /track/<id>/ 和 /redirect.mp3/ 之后就是
// 直连 CDN 地址。直连省掉一次 TLS 握手和 302（实测首播快约 4 s）；广告由 CDN
// 侧按会话插播，直连拿到的仍是同一条带广告的流。
function directAudioUrl(url) {
  const s = String(url || '');
  const m = /\/track\/[^/?#]+\/([^/?#]+\/.*)$/.exec(s)
    || /\/redirect\.mp3\/([^/?#]+\/.*)$/.exec(s);
  if (!m) return '';
  try {
    const u = new URL('https://' + m[1]);
    return /(^|\.)(podtrac\.com|pdst\.fm|pscrb\.fm|swap\.fm)$/i.test(u.hostname) ? '' : u.href;
  } catch (e) { return ''; }
}
function preferredAudioUrl(item) {
  if (item?.localPath && host() && typeof host().asset === 'function') return host().asset(item.localPath);
  // 本集有离线副本就优先用本地文件（asset: 协议，断网也能播）
  const off = (typeof app !== 'undefined' && app && app.offline) || null;
  const showSlug = (item && item.showKey) || (typeof state !== 'undefined' && state.show ? state.show.slug : '');
  const local = item && off && off.size ? off.get(offlineKeyOf(showSlug, item.id)) : null;
  if (local && host() && typeof host().asset === 'function') return host().asset(local.path);
  return directAudioUrl(item?.url) || item?.url || '';
}
function tryAudioSource(url) {
  if (!url || state.audioUsed.has(url)) return false;
  rememberPosition();
  state.audioUsed.add(url);
  audio.dataset.ep = state.current?.id || '';
  audio.src = url;
  audio.load();
  audio.play().catch(() => {});
  return true;
}
function retryCurrentAudio() {
  const item = state.current;
  if (!item || !item.url) return;
  rememberPosition();
  setState('audioRetried', 0);
  const audioUrl = preferredAudioUrl(item);
  setState('audioUsed', new Set([item.url, audioUrl].filter(Boolean)));
  state.audioToken += 1;
  audio.dataset.ep = item.id;
  audio.src = audioUrl;
  audio.load();
  audio.play().catch(() => {});
}
function audioFail(code) {
  const msg = '音频加载失败' + (code ? '（错误码 ' + code + '）' : '') + '，点击提示可重试。';
  status(msg, 'warn');
  showToast(msg, 12000);
}
async function onAudioError() {
  const item = state.current;
  if (!item || audio.dataset.ep !== item.id) return;
  if (!item.url) {
    // 本地导入的音频没有远程 URL；文件被移动/删除时原来会静默失败。
    showToast(item.localPath ? '这个本地音频文件不见了，请重新导入或检查磁盘上的文件。' : '这一集没有可播放的音频地址。', 7000);
    return;
  }
  const token = state.audioToken;
  if (state.audioRetried === 0) {
    setState('audioRetried', 1);
    showToast('音频请求失败，正在重试…', 5000);
    setTimeout(() => {
      if (token !== state.audioToken) return;
      audio.load();
      audio.play().catch(() => {});
    }, 800);
    return;
  }
  if (state.audioRetried === 1) {
    setState('audioRetried', 2);
    if (tryAudioSource(item.url) || tryAudioSource(item.directUrl)) {
      showToast('正在尝试备用音频…', 10000);
      return;
    }
    showToast('正在尝试备用音频…', 10000);
    const finalUrl = await resolveFinalAudioUrl(item.url);
    if (token !== state.audioToken) return;
    if (tryAudioSource(finalUrl)) return;
    audioFail(audio.error && audio.error.code);
    return;
  }
  if (state.audioRetried === 2) {
    setState('audioRetried', 3);
    if (tryAudioSource(item.directUrl)) return;
    audioFail(audio.error && audio.error.code);
    return;
  }
  audioFail(audio.error && audio.error.code);
}
$('toast').onclick = () => { hideToast(); retryCurrentAudio(); };
function openDrawer() {
  rememberOverlayTrigger('drawer', $('drawer'));
  closeDetails(false); closeDockSheet(false); closeTypeSheet(false);
  const drawer = $('drawer');
  drawer.removeAttribute('inert');
  drawer.classList.add('on');
  $('scrim').classList.add('on');
  drawer.setAttribute('aria-hidden', 'false');
  $('drawerBtn').setAttribute('aria-expanded', 'true');
  setDrawerBackgroundInert(true);
  $('search').focus();
}
function closeDrawer(restore = true) {
  const drawer = $('drawer');
  const hadFocus = drawer.contains(document.activeElement);
  drawer.classList.remove('on');
  $('scrim').classList.remove('on');
  drawer.setAttribute('aria-hidden', 'true');
  drawer.setAttribute('inert', '');
  $('drawerBtn').setAttribute('aria-expanded', 'false');
  setDrawerBackgroundInert(false);
  if (restore && hadFocus) restoreOverlayFocus('drawer');
}
function openDetails() {
  rememberOverlayTrigger('details', $('details'));
  closeDrawer(false); closeDockSheet(false); closeTypeSheet(false);
  const details = $('details');
  details.removeAttribute('inert');
  details.classList.add('on');
  details.setAttribute('aria-hidden', 'false');
  $('detailsBtn').setAttribute('aria-expanded', 'true');
  $('detailsClose').focus();
}
function closeDetails(restore = true) {
  const details = $('details');
  const hadFocus = details.contains(document.activeElement);
  details.classList.remove('on');
  details.setAttribute('aria-hidden', 'true');
  details.setAttribute('inert', '');
  $('detailsBtn').setAttribute('aria-expanded', 'false');
  if (restore && hadFocus) restoreOverlayFocus('details');
}
function closeOverlays(restore = true) { closeDockSheet(restore); closeDrawer(restore); closeDetails(restore); }
function setImmersive(on) {
  // 驾驶界面把正文整块藏掉，阅读沉浸又把底栏藏掉，两个叠起来就是一块空屏；进沉浸前先退回默认界面。
  if (on && app.appearance === 'car') {
    app.appearance = 'default';
    try { localStorage.setItem('myt-appearance', 'default'); } catch (e) {}
    document.body.classList.remove('car-mode');
    renderListening(); syncMini();
  }
  setState('immersive', on);
  document.body.classList.toggle('immersive', on);
  document.querySelector('.dock').toggleAttribute('inert', on);
  $('frameBtn').toggleAttribute('inert', !on);
  const immersiveBtn = $('immersiveBtn');
  if (immersiveBtn) immersiveBtn.setAttribute('aria-pressed', String(on));
  if (on) { closeOverlays(false); closeDockSheet(false); closeTypeSheet(false); }
  const framePos = layerValue('05-transport-transcript-nav', 'framePos');
  if (on && framePos) placeFrame(framePos.x, framePos.y);
  setTimeout(() => {
    if (state.activeCue >= 0 && state.nodes[state.activeCue]) { stopScroll(); scrollCue(state.nodes[state.activeCue].el, true); }
    syncJumpPill();
  }, 340);
}

/* ---------- 全屏壁纸：封面模糊铺底，只留字幕、暂停、退出 ---------- */
let wpLastKey = '';
let wpWasFullscreen = false;
let wpPrevIndex = -1;
let wpCueIndex = 0;
let wpWordIdx = -2;
let wpWordSpans = null;
let wpWordCue = -1;
let wpEpId = '';
function resetWordPanelForEpisode(epId) {
  wpEpId = String(epId || '');
  wpCueIndex = 0;
  wpPrevIndex = -1;
  wpLastKey = '';
}
function invalidateWordPanelKey() { wpLastKey = ''; }

function wallpaperText(cue) {
  return String(cue && cue.text || '').trim();
}

/* 当前句在壁纸里必须有词级时间点：每个词一个 span，播放时按 ASR 词时间上色。 */
function wallpaperEnMarkup(cue) {
  if (!cue || !cue.hasWords || !Array.isArray(cue.words) || !cue.words.length) return esc(wallpaperText(cue));
  const parts = splitLabel(cue.text, cue.words);
  if (parts.mismatch) return esc(wallpaperText(cue));
  const label = parts.label ? '<span class="wp-label">' + esc(parts.label) + ' </span>' : '';
  return label + parts.words.map((w, i) =>
    '<span class="wp-word pending" data-wi="' + i + '">' + esc(w.t) + '</span>').join(' ');
}

function wallpaperWordPaint(t) {
  if (!state.wallpaper) return;
  const ci = state.activeCue >= 0 ? state.activeCue : wpCueIndex;
  if (ci !== wpWordCue || !wpWordSpans || !wpWordSpans.length) return;
  const cue = state.cues && state.cues[ci];
  if (!cue || !cue.hasWords || !cue.words || !cue.words.length) return;
  let idx = -1;
  for (let i = 0; i < cue.words.length; i++) {
    if (t >= cue.words[i].s + state.offset) idx = i;
    else break;
  }
  if (idx === wpWordIdx) return;
  wpWordIdx = idx;
  for (let i = 0; i < wpWordSpans.length; i++) {
    const el = wpWordSpans[i];
    el.classList.toggle('active', i === idx);
    el.classList.toggle('past', i >= 0 && i < idx);
    el.classList.toggle('pending', i > idx || idx < 0);
  }
}

function syncWallpaperPlay() {
  const btn = $('wpPlay');
  if (!btn) return;
  const playing = !audio.paused;
  btn.classList.toggle('playing', playing);
  btn.setAttribute('aria-label', playing ? '暂停' : '播放');
  const label = $('wpPlayLabel');
  if (label) label.textContent = playing ? '暂停' : '播放';
}

async function toggleWallpaperPlay() {
  try {
    if (audio.paused) await audio.play();
    else audio.pause();
  } catch (err) {
    showToast('播放失败：' + (err && err.message ? err.message : err), 4000);
  }
  syncWallpaperPlay();
}

function wallpaperRefresh(animate = true) {
  const layer = $('wallpaper');
  if (!layer) return;
  const cues = state.cues || [];
  const ep = state.current;
  const epId = String(ep && ep.id || '');
  if (epId !== wpEpId) { wpEpId = epId; wpCueIndex = 0; wpPrevIndex = -1; }
  let ci = state.activeCue;
  // 停顿间隙 activeCue 会是 -1；壁纸要停留在上一句，不能跳回整集第一句。
  if (ci < 0 || !cues[ci]) ci = cues.length ? Math.min(wpCueIndex, cues.length - 1) : -1;
  if (ci >= 0) wpCueIndex = ci;
  const cue = ci >= 0 ? cues[ci] : null;
  const main = wallpaperText(cue);
  const zh = cue && cue.zh ? String(cue.zh).trim() : '';
  const show = state.show;
  const title = String(ep && ep.title || show && show.name || 'MyTranscript');
  const showName = String(show && show.name || 'MyTranscript');
  const codeMatch = title.match(/\bS\d+\s*E\d+\b/i);
  const cover = String(ep && ep.img || show && show.artwork || '');
  const key = [epId, ci, main, zh, title, cover, cues.length].join('|');
  if (key === wpLastKey) return;
  wpLastKey = key;

  const kicker = $('wpKicker');
  if (kicker) kicker.textContent = [showName.toUpperCase(), codeMatch ? codeMatch[0].toUpperCase() : '', '双语逐词'].filter(Boolean).join(' · ');
  const titleEl = $('wpTitle');
  if (titleEl) titleEl.textContent = title;

  /* 壁纸不是三行提词器：显示当前句前后共 7 句，当前句大字高亮，其余铺满屏幕。 */
  const lines = $('wpLines');
  if (lines) {
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const prevCi = wpPrevIndex;
    const forward = prevCi < 0 || ci >= prevCi;
    /* 旧字幕整体上移/下移淡出，新字幕从反方向滑入，形成连续滚动的阅读感。 */
    if (animate && !reduced && prevCi >= 0 && prevCi !== ci && lines.childElementCount) {
      const ghost = lines.cloneNode(true);
      ghost.removeAttribute('id');
      ghost.classList.add('ghost');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.querySelectorAll('*').forEach(n => { n.style.animation = 'none'; });
      lines.parentNode.appendChild(ghost);
      const shift = forward ? -28 : 28;
      const ghostAnim = ghost.animate(
        [{ opacity: .48, transform: 'translateY(-50%)' }, { opacity: 0, transform: 'translateY(calc(-50% + ' + shift + 'px))' }],
        { duration: 540, easing: 'cubic-bezier(.22,.72,.2,1)', fill: 'both' }
      );
      ghostAnim.onfinish = () => ghost.remove();
      setTimeout(() => { if (ghost.isConnected) ghost.remove(); }, 700);
    }

    const total = cues.length;
    const windowSize = 7;
    let start = 0;
    if (total > windowSize && ci >= 0) start = Math.max(0, Math.min(ci - 3, total - windowSize));
    const end = Math.min(total, start + windowSize);
    const html = [];
    for (let i = start; i < end; i++) {
      const text = wallpaperText(cues[i]);
      if (!text) continue;
      const cls = i === ci ? 'active' : (i < ci ? 'past' : 'future');
      const en = i === ci ? wallpaperEnMarkup(cues[i]) : esc(text);
      const zhLine = i === ci && cues[i].zh ? '<p class="wp-zh">' + esc(String(cues[i].zh)) + '</p>' : '';
      html.push('<div class="wp-cue ' + cls + '"><p class="wp-en">' + en + '</p>' + zhLine + '</div>');
    }
    wpWordIdx = -2;
    lines.innerHTML = html.length ? html.join('') : '<div class="wp-cue active"><p class="wp-en">' + esc(cues.length ? '' : '这一集没有可显示的字幕。') + '</p></div>';
    const activeWrap = lines.querySelector('.wp-cue.active .wp-en');
    wpWordSpans = activeWrap ? activeWrap.querySelectorAll('.wp-word') : null;
    wpWordCue = ci;
    wallpaperWordPaint(audio.currentTime || 0);
    if (animate && !reduced) {
      const from = forward ? 28 : -28;
      lines.animate(
        [{ opacity: 0, transform: 'translateY(' + from + 'px)' }, { opacity: 1, transform: 'translateY(0)' }],
        { duration: 560, easing: 'cubic-bezier(.22,.72,.2,1)', fill: 'both' }
      );
    }
    wpPrevIndex = ci;
  }

  const coverEl = $('wpCover');
  if (coverEl) {
    if (cover && coverEl.getAttribute('src') !== cover) {
      coverEl.onerror = () => { coverEl.hidden = true; };
      coverEl.src = cover;
      coverEl.hidden = false;
    } else if (!cover) {
      coverEl.hidden = true;
    }
  }
}

async function wallpaperFullscreen(on) {
  const T = tauriHost();
  if (T && T.window && T.window.getCurrentWindow) {
    try {
      const win = T.window.getCurrentWindow();
      if (on) {
        wpWasFullscreen = typeof win.isFullscreen === 'function' ? !!(await win.isFullscreen()) : false;
        await win.setFullscreen(true);
        return;
      }
      await win.setFullscreen(!!wpWasFullscreen);
      return;
    } catch (e) {
      // 权限缺失时回退到浏览器全屏；壁纸版面本身仍然可用。
    }
  }
  try {
    if (on && !document.fullscreenElement && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen();
    } else if (!on && document.fullscreenElement && document.exitFullscreen) {
      await document.exitFullscreen();
    }
  } catch (e) {}
}

async function setWallpaper(on) {
  on = !!on;
  if (on && !subtitlePluginOn()) { showToast('字幕插件未启用，壁纸字幕不可用。', 'warn'); return; }
  if (on === state.wallpaper) return;
  if (on && state.immersive) setImmersive(false);
  if (on) { closeOverlays(false); closeDockSheet(false); closeTypeSheet(false); if (typeof closeStudySheet === 'function') closeStudySheet(); }
  setState('wallpaper', on);
  document.body.classList.toggle('wallpaper-mode', on);
  const layer = $('wallpaper');
  if (layer) {
    layer.toggleAttribute('inert', !on);
    layer.setAttribute('aria-hidden', String(!on));
  }
  const btn = $('wallpaperBtn');
  if (btn) btn.setAttribute('aria-pressed', String(on));
  wpLastKey = '';
  if (on) {
    wpPrevIndex = -1;
    wallpaperRefresh();
    syncWallpaperPlay();
  }
  await wallpaperFullscreen(on);
}

document.addEventListener('fullscreenchange', () => {
  if (state.wallpaper && !(tauriHost() && tauriHost().window) && !document.fullscreenElement) {
    setWallpaper(false);
  }
});

function isOwnTranscript(url) {
  return /^https?:\/\/(?:lzoreal\.github\.io\/MyTranscript|raw\.githubusercontent\.com\/lzoreal\/MyTranscript)\//.test(url);
}
function sitePath(url) {
  try {
    const u = new URL(url, location.href);
    if (u.hostname === 'lzoreal.github.io' && u.pathname.startsWith('/MyTranscript/')) {
      return u.pathname.slice('/MyTranscript/'.length) + u.search;
    }
  } catch (e) {}
  return url;
}
function transcriptEls(item) {
  const tagged = [...item.getElementsByTagName('podcast:transcript')];
  return tagged.length ? tagged : [...item.getElementsByTagNameNS('https://podcastindex.org/namespace/1.0', 'transcript')];
}
function pickTranscript(item) {
  const own = transcriptEls(item).filter(el => isOwnTranscript(el.getAttribute('url') || ''));
  const el = own.find(x => x.getAttribute('type') === 'application/json') || own[0];
  return el ? { url: el.getAttribute('url'), type: el.getAttribute('type') || '' } : null;
}
function episodeNumber(title) {
  const text = String(title || '');
  const m = text.match(/^(?:Episode\s*)?(\d{1,4})[.:\s-]/i) || text.match(/#(\d{1,4})\b/);
  return m ? Number(m[1]) : 0;
}
/* ---------- 章节：Podcast Index chapters JSON / Podlove simple chapters ---------- */
function chapterJsonUrl(item) {
  const nodes = [...item.getElementsByTagName('*')];
  const node = nodes.find(n => n.tagName.toLowerCase() === 'podcast:chapters');
  return node ? (node.getAttribute('url') || '') : '';
}
function stampSeconds(raw) {
  const m = String(raw || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (!m) return NaN;
  const h = m[1] ? Number(m[1]) : 0;
  return h * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
function podloveChapters(item) {
  const out = [];
  [...item.getElementsByTagName('*')].forEach(node => {
    const tag = node.tagName.toLowerCase();
    if (tag !== 'chapter' && tag !== 'psc:chapter') return;
    const start = stampSeconds(node.getAttribute('start'));
    if (!Number.isFinite(start)) return;
    out.push({
      start,
      title: node.getAttribute('title') || '',
      href: node.getAttribute('href') || node.getAttribute('url') || '',
    });
  });
  return out.sort((a, b) => a.start - b.start);
}

/* ---------- Podcasting 2.0：嘉宾（podcast:person）与替代音源（podcast:alternateEnclosure）
   这两块只做「读出来给界面用」，不参与选源播放：换源要动播放内核，留给后续。 */
function cxChildNodes(item) {
  return [...item.childNodes].filter(n => n.nodeType === 1);
}
function nodeLocalName(node) {
  const name = String(node.localName || node.tagName || '');
  return name.includes(':') ? name.split(':').pop().toLowerCase() : name.toLowerCase();
}
function podcastPersons(item) {
  const out = [];
  cxChildNodes(item).forEach(node => {
    if (nodeLocalName(node) !== 'person') return;
    const name = (node.getAttribute('name') || node.textContent || '').trim();
    if (!name) return;
    out.push({
      name: name.slice(0, 80),
      role: (node.getAttribute('role') || '').trim(),
      group: (node.getAttribute('group') || '').trim(),
      img: (node.getAttribute('img') || '').trim(),
      href: (node.getAttribute('href') || '').trim(),
    });
  });
  return out.slice(0, 12);
}
function podcastAlternates(item) {
  const out = [];
  cxChildNodes(item).forEach(node => {
    if (nodeLocalName(node) !== 'alternateenclosure') return;
    const sources = cxChildNodes(node)
      .filter(n => n.nodeType === 1 && nodeLocalName(n) === 'source')
      .map(n => (n.getAttribute('uri') || '').trim())
      .filter(Boolean);
    const type = (node.getAttribute('type') || '').trim();
    const title = (node.getAttribute('title') || '').trim();
    const bytes = Number(node.getAttribute('length') || 0) || 0;
    sources.slice(0, 3).forEach(uri => {
      out.push({
        uri,
        type,
        title,
        bytes,
        // 只要声明是视频或有 video/ 类型，就标成视频源，界面上单独分组。
        video: /^video\//i.test(type) || /\.(mp4|m4v|webm|mov|mkv)(?:$|\?)/i.test(uri),
      });
    });
  });
  return out.slice(0, 6);
}
function parseFeed(xml) {  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const channel = doc.querySelector('channel');
  const channelTitle = (channel?.querySelector('title')?.textContent || '').trim();
  const channelImg = channel?.getElementsByTagName('itunes:image')[0]?.getAttribute('href')
    || channel?.getElementsByTagName('image')[0]?.getElementsByTagName('url')[0]?.textContent
    || '';
  const channelDesc = (channel?.getElementsByTagName('description')[0]?.textContent || '').trim();
  const items = [...doc.getElementsByTagName('item')];
  const episodes = items.map((it, index) => {
    const title = (it.getElementsByTagName('title')[0]?.textContent || '').trim();
    const date = (it.getElementsByTagName('pubDate')[0]?.textContent || '').trim();
    const enc = it.getElementsByTagName('enclosure')[0];
    const imgEl = it.getElementsByTagName('itunes:image')[0];
    const guid = (it.getElementsByTagName('guid')[0]?.textContent || '').trim();
    const transcript = pickTranscript(it);
    const url = enc ? enc.getAttribute('url') : '';
    const encType = enc ? (enc.getAttribute('type') || '') : '';
    const media = it.getElementsByTagName('media:content')[0]?.getAttribute('url') || '';
    const mediaType = it.getElementsByTagName('media:content')[0]?.getAttribute('type') || '';
    const isVideo = /^video\//i.test(encType) || /^video\//i.test(mediaType) || /\.(mp4|m4v|webm|mov|mkv)(?:$|\?)/i.test(url || media);
    return {
      id: guid || transcript?.url || 'ep-' + index,
      title, date, url,
      directUrl: media && media !== url ? media : '',
      img: (imgEl ? imgEl.getAttribute('href') : '') || channelImg,
      description: (it.getElementsByTagName('description')[0]?.textContent || '').trim(),
      videoUrl: isVideo ? (url || media) : '',
      video: isVideo,
      transcript,
      chaptersUrl: chapterJsonUrl(it),
      chapters: podloveChapters(it),
      persons: podcastPersons(it),
      alternates: podcastAlternates(it),
    };
  }).filter(e => e.title || e.url);
  episodes.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  episodes.forEach((e, i) => { e.num = episodeNumber(e.title) || (episodes.length - i); });
  return { title: channelTitle, artwork: channelImg, description: channelDesc, episodes };
}
// 词级 JSON 导出（segments[].startTime/body）里是 ASR 原生词时间；timings sidecar
// 是压缩时间轴修正后的产物，才需要播放器的修补启发式。
function nativeWordDoc(sc) {
  return !!sc && Array.isArray(sc.segments) &&
    sc.segments.some(s => s && ('startTime' in s || 'body' in s));
}
function cuesFromJson(doc) {
  const kernel = subtitleKernel();
  if (!kernel || typeof kernel.parseJson !== 'function') {
    throw new Error('字幕内核未加载：请启用 subtitles 插件');
  }
  return kernel.parseJson(doc);
}
function deriveZhUrl(url) {
  const u = new URL(url, location.href);
  u.pathname = u.pathname.replace('/transcripts/', '/transcripts/zh/');
  return u.href;
}
function deriveTimingsUrl(url) {
  const u = new URL(url, location.href);
  const stem = decodeURIComponent((u.pathname.split('/').pop() || '').replace(/\.vtt$/i, ''));
  const base = state.show?.feed ? state.show.feed.replace(/feed\.xml$/, '') : encodeURIComponent(state.show?.slug || '') + '/';
  return base + 'timings/' + encodeURIComponent(stem) + '.json';
}
const getText = url => fetch(url).then(r => r.ok ? r.text() : null).catch(() => null);
// 带超时的 JSON 读取：外壳清单与目录都不能无限等下去。
function getJson(url, timeoutMs = 12000) {
  return fetchJsonTimed(url, timeoutMs).catch(() => {
    const mirror = transcriptMirror(url);
    return mirror ? fetchJsonTimed(mirror, timeoutMs).catch(() => null) : null;
  });
}
function fetchJsonTimed(url, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : 0;
  const options = controller ? { signal: controller.signal } : undefined;
  return fetch(url, options)
    .then(response => {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    })
    .finally(() => { if (timer) clearTimeout(timer); });
}
// GitHub raw 偶尔会回 503（Backend.max_conn），同一份 data 分支文件在 jsDelivr 上仍可读。
function transcriptMirror(url) {
  try {
    const u = new URL(url);
    const prefix = '/lzoreal/MyTranscript/data/';
    if (u.hostname === 'raw.githubusercontent.com' && u.pathname.startsWith(prefix)) {
      return 'https://cdn.jsdelivr.net/gh/lzoreal/MyTranscript@data/' + u.pathname.slice(prefix.length) + u.search;
    }
  } catch (e) {}
  return '';
}

// 英文 VTT 已不发布时，用词级 sidecar 的段文本当作 cue 源；实现在字幕插件内核里。
function vttFromSidecar(sidecar) {
  const kernel = subtitleKernel();
  return kernel && typeof kernel.vttFromSidecar === 'function' ? kernel.vttFromSidecar(sidecar) : [];
}

function parseZhVTT(text) {
  const kernel = subtitleKernel();
  return kernel && typeof kernel.parseZh === 'function' ? kernel.parseZh(text) : [];
}

function parseVttSmart(text) {
  const kernel = subtitleKernel();
  return kernel && typeof kernel.parseVtt === 'function' ? kernel.parseVtt(text) : { primary: [], zh: [], hasLatin: false, hasCjk: false };
}

/* 字幕内核的适配（subtitleKernel / subtitleViewHost / merge / renderCues / renderCueWindow /
   alignZhLines）已搬到 12-subtitle；这里只留同名转发。
   下一刀可以把 cuesFromJson 一起并过去，01 就只剩主题/阅读器/导入/壁纸。 */
function splitLabel(text, words) {
  const toks = text.trim().split(/\s+/), wt = words.map(w => w.t);
  if (!wt.length) return { label: '', words };
  for (let k = 0; k + wt.length <= toks.length; k++) {
    let ok = true;
    for (let j = 0; j < wt.length; j++) if (toks[k+j] !== wt[j]) { ok = false; break; }
    if (ok) return { label: toks.slice(0, k).join(' '), words };
  }
  return { label: '', words, mismatch: true };
}

const subtitleKernel = lazyFn('12-subtitle', 'subtitleKernel');
const subtitleViewHost = lazyFn('12-subtitle', 'subtitleViewHost');
const mergeCues = lazyFn('12-subtitle', 'mergeCues');
const renderCues = lazyFn('12-subtitle', 'renderCues');
const renderCueWindow = lazyFn('12-subtitle', 'renderCueWindow');
const alignZhLines = lazyFn('12-subtitle', 'alignZhLines');
function updateTimeScale() {
  const duration = audio.duration;
  const real = state.audioSeconds;
  const ratio = duration > 0 ? real / duration : 1;
  // 只修正 MP3 头部时长估算误差（约 0.2%）。相差超过 1% 通常说明
  // 当前 enclosure 与转写时的音频内容不同（动态插播广告），整体缩放只会更糟。
  setState('timeScale', (Number.isFinite(duration) && duration > 0
      && Number.isFinite(real) && real > 0
      && Math.abs(real - duration) > 0.5
      && ratio > 0.99 && ratio < 1.01) ? ratio : 1);
  $('total').textContent = fmt(state.timeScale !== 1 ? real : (duration || real || 0));
}

function rawSeek(r) {
  const max = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Infinity;
  const x = Math.max(0, Math.min(max, r));
  setState('seekRaw', x);
  audio.currentTime = x;
}
function seekTo(t) { if (!state.current) return; studyResetPlayback(); rawSeek(t / (state.timeScale || 1)); audio.play().catch(() => {}); paint(true); }

function paint(force = false) {
  if (LIVE.on) { liveAdvance(); return; }
  // 驾驶模式把正文整块隐藏了，滚动和逐词上色都没有显示意义，直接不干这活。
  const carUi = document.body.classList.contains('car-mode');
  /* 窗口不在前台（05 的 syncIdleDecor 挂的 decor-idle）：正文看不见，滚动与逐词上色
     纯属白干——一份整集词级字幕的 class 变更+平滑滚动能占两成多单核。只保留时间/进度写入，
     回前台时 focus 会 paint(true)，把高亮和滚动一次性追平。 */
  const idleDecor = document.documentElement.classList.contains('decor-idle');
  if (!state.cues.length) { syncJumpPill(); return; }
  const clock = audio.currentTime || 0;
  // 音频 metadata/seek 还没到位时，先按记住的进度定位文字稿，
  // 否则首屏总从 00:00 起渲染，用户要等 8–10 秒才看到当前句。
  const raw = (clock < 1 && Number(state.resumeAt) > 1 &&
    state.resumeEp === (state.current && state.current.id)) ? Number(state.resumeAt) : clock;
  // 浏览器按标称码率估算时长，seek 落点会超前，但播放时钟仍与音频 1:1；
  // 所以补偿量由最后一次 seek 的 raw 目标决定，而不是持续缩放时钟。
  const t = raw + (state.timeScale - 1) * state.seekRaw;
  let ci = locateCue(t);
  // 未开始播放时定位不到任何句，默认高亮第一句
  if (ci < 0 && t < 0.001) ci = 0;
  if (ci >= 0 && !state.nodes[ci]) renderCueWindow(ci, true);
  if (ci !== state.activeCue) {
    if (state.activeCue >= 0) {
      const old = state.nodes[state.activeCue];
      if (old) {
        old.el.classList.remove('active');
        old.words.forEach(w => { w.classList.remove('active','past'); w.classList.add('pending'); });
        old.lastIdx = -1;   // 回看时靠它触发重绘，否则会停在「整句 pending」
      }
    }
    setState('activeCue', ci); setState('wordIdx', -1);
    if (ci >= 0) {
      const cue = state.cues[ci];
      emitPlugin('player:cue', { index: ci, text: cue?.text || '', start: cue?.start, end: cue?.end });
    }
    studyResetAutoPause();
    if (state.wallpaper) wallpaperRefresh();
    if (ci >= 0) trPrimeCues(ci);
    if (ci >= 0) {
      const n = state.nodes[ci];
      if (!n) return;
      n.el.classList.add('active');
      // 刚进入播放器时即使暂停也要把当前句带回视野；之后仍按用户滚动和播放状态跟随。
      const follow = force || state.pendingFollow;
      setState('pendingFollow', false);
      if (!carUi && !idleDecor) scrollCue(n.el, follow);
    }
  } else if (ci >= 0 && state.pendingFollow) {
    setState('pendingFollow', false);
    if (!carUi && !idleDecor) scrollCue(state.nodes[ci].el, true);
  }
  if (ci >= 0 && state.mode === 'word' && !carUi && !idleDecor) paintWords(ci, t);
  if (state.wallpaper && !idleDecor) wallpaperWordPaint(t);
  syncChapterNow(t);
  // 拖动进度条时只显示预览（时间气泡 + 填充），播放头和高亮仍按真实时钟走，
  // 这里不能把 seek/时间回写成播放位置，否则拖动会被每一帧 paint 抢回去。
  if (state.seekPreview == null) {
    // 这三个写入是 paint 里最贵的（文本/属性/样式都会引起重排），值没变就不写。
    const nowText = fmt(t);
    if (nowText !== state.lastNowText) { $('now').textContent = nowText; setState('lastNowText', nowText); }
    const durText = fmt(state.audioSeconds || audio.duration || 0);
    const aria = nowText + ' / ' + durText;
    if (aria !== state.lastAriaText) { $('seek').setAttribute('aria-valuetext', aria); setState('lastAriaText', aria); }
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      const pct = Math.min(100, Math.max(0, raw / audio.duration * 100));
      const bucket = Math.round(pct * 10);
      if (bucket !== state.lastSeekBucket) {
        $('seek').value = String(bucket);
        $('pfill').style.width = pct + '%';
        setState('lastSeekBucket', bucket);
      }
    }
  }
  // syncJumpPill 每次都要读两次 getBoundingClientRect（强制同步布局），不必每帧都算。
  if (!carUi && !idleDecor && (force || Date.now() - state.lastPillAt > 400)) { setState('lastPillAt', Date.now()); syncJumpPill(); }
}

function syncJumpPill() {
  const pill = $('jumpPill');
  const node = state.nodes[state.activeCue];
  let show = false;
  if (state.activeCue >= 0 && node) {
    const r = node.el.getBoundingClientRect(), br = box.getBoundingClientRect();
    show = r.bottom < br.top + 6 || r.top > br.bottom - 6;
  }
  pill.classList.toggle('on', show);
  pill.toggleAttribute('inert', !show);
}

/* 字幕的每帧路径（定位 / 逐词上色 / 跟随滚动）已搬到 12-subtitle 层。
   这里保留同名薄转发，调用方与导出面零改动；下一步把 renderCueWindow 与 07 的 trPrimeCues 也并进去。 */
const stopScroll = lazyFn('12-subtitle', 'stopScroll');
const scrollIntoBox = lazyFn('12-subtitle', 'scrollIntoBox');
const canFollow = lazyFn('12-subtitle', 'canFollow');
const scrollCue = lazyFn('12-subtitle', 'scrollCue');
const scrollWord = lazyFn('12-subtitle', 'scrollWord');
const liveFollow = lazyFn('12-subtitle', 'liveFollow');
const locateCue = lazyFn('12-subtitle', 'locateCue');
const paintWords = lazyFn('12-subtitle', 'paintWords');
export { PROGRESS_KEY, READER_DEFAULTS, alignZhLines, applyCustomTheme, applyExperiment, applyReader, applyVttExperiment, audioFail, bindCustomThemeEditor, canFollow, chapterJsonUrl, clearProgress, closeDetails, closeDrawer, closeOverlays, closeTypeSheet, cuesFromJson, deriveTimingsUrl, deriveZhUrl, directAudioUrl, emptyLine, epKey, episodeNumber, esc, fetchJsonTimed, findNorm, fmt, getJson, getText, hideToast, importExperimentFile, invalidateProgressCache, invalidateWordPanelKey, isBracket, isJsonTranscript, isOwnTranscript, liveFollow, loaderHTML, locateCue, mergeCues, nativeWordDoc, onAudioError, openDetails, openDrawer, openTypeSheet, overlayTriggers, paint, paintWords, parseFeed, parseVttSmart, parseZhVTT, pickTranscript, pluginPageKey, podloveChapters, preferredAudioUrl, progressAll, progressAllCache, progressKey, rawSeek, readCustomTheme, readProgress, reader, readerFields, rebuildCues, rememberOverlayTrigger, rememberPosition, renderCueWindow, renderCues, renderCustomThemeGrid, resetImportUI, resetWordPanelForEpisode, resolveFinalAudioUrl, restoreExperiment, restoreOverlayFocus, retryCurrentAudio, sanitizeCustomHtml, saveProgress, scrollCue, scrollIntoBox, scrollWord, seekTo, setDrawerBackgroundInert, setImmersive, setImportNote, setTheme, setWallpaper, showToast, sitePath, splitLabel, stampSeconds, statHTML, status, stopScroll, studyNormText, studyRegexEscape, subtitleKernel, subtitleViewHost, syncCustomThemeEditor, syncJumpPill, syncWallpaperPlay, themeBtns, toastTimer, toggleWallpaperPlay, transcriptEls, transcriptMirror, tryAudioSource, updateTimeScale, vttFromSidecar, wallpaperEnMarkup, wallpaperFullscreen, wallpaperRefresh, wallpaperText, wallpaperWordPaint, wpCueIndex, wpEpId, wpLastKey, wpPrevIndex, wpWasFullscreen, wpWordCue, wpWordIdx, wpWordSpans, writeCustomTheme, writeProgressAll };
registerLayer('01-theme-reader-shell', { PROGRESS_KEY, READER_DEFAULTS, alignZhLines, applyCustomTheme, applyExperiment, applyReader, applyVttExperiment, audioFail, bindCustomThemeEditor, canFollow, chapterJsonUrl, clearProgress, closeDetails, closeDrawer, closeOverlays, closeTypeSheet, cuesFromJson, deriveTimingsUrl, deriveZhUrl, directAudioUrl, emptyLine, epKey, episodeNumber, esc, fetchJsonTimed, findNorm, fmt, getJson, getText, hideToast, importExperimentFile, invalidateProgressCache, invalidateWordPanelKey, isBracket, isJsonTranscript, isOwnTranscript, liveFollow, loaderHTML, locateCue, mergeCues, nativeWordDoc, onAudioError, openDetails, openDrawer, openTypeSheet, overlayTriggers, paint, paintWords, parseFeed, parseVttSmart, parseZhVTT, pickTranscript, pluginPageKey, podloveChapters, preferredAudioUrl, progressAll, progressAllCache, progressKey, rawSeek, readCustomTheme, readProgress, reader, readerFields, rebuildCues, rememberOverlayTrigger, rememberPosition, renderCueWindow, renderCues, renderCustomThemeGrid, resetImportUI, resetWordPanelForEpisode, resolveFinalAudioUrl, restoreExperiment, restoreOverlayFocus, retryCurrentAudio, sanitizeCustomHtml, saveProgress, scrollCue, scrollIntoBox, scrollWord, seekTo, setDrawerBackgroundInert, setImmersive, setImportNote, setTheme, setWallpaper, showToast, sitePath, splitLabel, stampSeconds, statHTML, status, stopScroll, studyNormText, studyRegexEscape, subtitleKernel, subtitleViewHost, syncCustomThemeEditor, syncJumpPill, syncWallpaperPlay, themeBtns, toastTimer, toggleWallpaperPlay, transcriptEls, transcriptMirror, tryAudioSource, updateTimeScale, vttFromSidecar, wallpaperEnMarkup, wallpaperFullscreen, wallpaperRefresh, wallpaperText, wallpaperWordPaint, wpCueIndex, wpEpId, wpLastKey, wpPrevIndex, wpWasFullscreen, wpWordCue, wpWordIdx, wpWordSpans, writeCustomTheme, writeProgressAll });
