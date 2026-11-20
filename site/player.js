/* layer: kernel —— 纯函数，不读 DOM、不碰 state。
   拼接后先于主 IIFE 执行；主脚本用同名解构接回，调用点不用改。 */
const MYTK = (() => {
  const fmt = s => { s = Math.max(0, Number(s) || 0); const h = Math.floor(s/3600), m = Math.floor(s%3600/60), x = Math.floor(s%60);
    return h ? `${h}:${String(m).padStart(2,'0')}:${String(x).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(x).padStart(2,'0')}`; };
  const isBracket = t => /^\s*\[.*\]\s*[.!?]?\s*$/.test(t);
  const esc = t => String(t).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const loaderHTML = text => '<div class="loader"><span class="bars"><i></i><i></i><i></i></span><span>' + esc(text) + '</span></div>';
  function findNorm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  function epKey(showKey, epId) { return String(showKey || '') + ':' + String(epId || ''); }
function studyRegexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function studyNormText(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9'’\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function emptyLine(text, action) {
  return '<div class="empty-line">' + esc(text) + (action ? '<div style="margin-top:10px">' + action + '</div>' : '') + '</div>';
}
function statHTML(label, value, note) {
  return '<div class="stat"><label>' + esc(label) + '</label><strong>' + esc(value) + '</strong><em>' + esc(note || '') + '</em></div>';
}
function pluginPageKey(pluginId, pageId) { return String(pluginId) + ':' + String(pageId); }
function isJsonTranscript(transcript) {
  return !!transcript && (transcript.type === 'application/json' || /\.json(?:$|\?)/i.test(transcript.url || ''));
}
  return { fmt, isBracket, esc, loaderHTML, findNorm, epKey, studyRegexEscape, studyNormText, emptyLine, statHTML, pluginPageKey, isJsonTranscript };
})();
/* layer: view —— 主题、阅读器、导入、壁纸；IIFE 入口与 kernel 解构
   本片只做该层的事，跨层调用走 kernel / host() / setState。 */
(() => {
const $ = id => document.getElementById(id);
const audio = (() => { const a = document.createElement('audio'); a.preload = 'metadata'; document.body.append(a); return a; })();
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

const overlayTriggers = { drawer: null, details: null, typeSheet: null, dockSheet: null };
const themeBtns = () => [...document.querySelectorAll('.swatch')];
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
const LIGHT_THEMES = new Set(['paper', 'mist', 'prototype', 'ledger']);
const CUSTOM_THEME_KEY = 'myt-theme-custom';
let lastDark = 'brass', lastLight = 'ledger';
function setTheme(id, persist = true) {
  const light = LIGHT_THEMES.has(id);
  document.documentElement.dataset.theme = id;
  document.documentElement.dataset.scheme = light ? 'light' : 'dark';
  if (light) lastLight = id; else lastDark = id;
  themeBtns().forEach(b => b.setAttribute('aria-checked', String(b.dataset.theme === id)));
  const btn = $('themeBtn');
  if (btn) {
    const label = light ? '切换到深色主题' : '切换到浅色主题';
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }
  const themeLabel = $('themeLabel');
  if (themeLabel) themeLabel.textContent = light ? '浅色主题' : '深色主题';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (bg) meta.setAttribute('content', bg);
  }
  if (persist) {
    try {
      localStorage.setItem('myt-theme', id);
      localStorage.setItem('myt-theme-dark', lastDark);
      localStorage.setItem('myt-theme-light', lastLight);
    } catch (e) {}
  }
  closeThemePop();
}
document.addEventListener('click', e => { const b = e.target.closest('.swatch[data-theme]'); if (b) setTheme(b.dataset.theme); });
$('themeBtn').onclick = () => {
  const light = LIGHT_THEMES.has(document.documentElement.dataset.theme);
  setTheme(light ? lastDark : lastLight);
};
$('exportSubBtn').onclick = () => {
  openModal('<div class="modal-head"><h3>导出字幕</h3><button class="mini-btn" data-close-modal>✕</button></div>' +
    '<div class="modal-note">导出当前单集的文字稿；双语会同时写入两种语言。</div>' +
    '<div class="modal-actions" style="flex-wrap:wrap"><button class="btn ghost" data-export-sub="srt">SRT</button>' +
    '<button class="btn ghost" data-export-sub="vtt">VTT</button><button class="btn ghost" data-export-sub="txt">纯文本</button>' +
    '<button class="btn ghost" data-close-modal>取消</button></div>');
};
$('shareCueBtn').onclick = shareCurrentCue;
try {
  lastDark = localStorage.getItem('myt-theme-dark') || lastDark;
  lastLight = localStorage.getItem('myt-theme-light') || lastLight;
  let savedTheme = localStorage.getItem('myt-theme');
  /* 编辑部方向首次落地：把旧的浅紫原型一次性迁到暖纸主题，之后用户仍可自由切换。 */
  if (!localStorage.getItem('myt-ui-ledger') && (!savedTheme || savedTheme === 'prototype')) {
    savedTheme = 'ledger';
    localStorage.setItem('myt-theme', 'ledger');
  }
  localStorage.setItem('myt-ui-ledger', '1');
  setTheme(savedTheme && themeBtns().some(b => b.dataset.theme === savedTheme) ? savedTheme : 'ledger', false);
} catch (e) { setTheme('ledger', false); }

/* ---------- 自定义主题（CSS / HTML） ---------- */
function readCustomTheme() {
  const raw = readJSON(CUSTOM_THEME_KEY, null);
  return {
    css: typeof raw?.css === 'string' ? raw.css : '',
    html: typeof raw?.html === 'string' ? raw.html : '',
    enabled: !!raw?.enabled,
    updatedAt: Number(raw?.updatedAt) || 0,
  };
}
function writeCustomTheme(cfg) {
  writeJSON(CUSTOM_THEME_KEY, cfg);
}
function sanitizeCustomHtml(text) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(text || '');
  tpl.content.querySelectorAll('script,iframe,object,embed,link,meta,base,form').forEach(node => node.remove());
  [tpl.content, ...tpl.content.querySelectorAll('*')].forEach(node => {
    if (!node.attributes) return;
    [...node.attributes].forEach(attr => {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(attr.value))) {
        node.removeAttribute(attr.name);
      }
    });
  });
  return tpl.innerHTML;
}
function applyCustomTheme(cfg = readCustomTheme()) {
  let style = $('ctStyle');
  if (!style) {
    style = document.createElement('style');
    style.id = 'ctStyle';
    document.head.append(style);
  }
  style.textContent = cfg.enabled ? (cfg.css || '') : '';
  const mount = $('customHomeMount');
  if (mount) {
    const html = cfg.enabled ? String(cfg.html || '').trim() : '';
    mount.innerHTML = html ? sanitizeCustomHtml(html) : '';
    mount.hidden = !html;
  }
  document.body.classList.toggle('custom-theme-on', !!cfg.enabled);
  const ctState = $('ctState');
  if (ctState) ctState.textContent = cfg.enabled ? '已启用' + (cfg.updatedAt ? ' · ' + new Date(cfg.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '') : '未启用';
}
function syncCustomThemeEditor() {
  const cfg = readCustomTheme();
  const css = $('ctCss'), html = $('ctHtml');
  if (css) css.value = cfg.enabled || cfg.css ? cfg.css : (css.value || '');
  if (html) html.value = cfg.html || '';
  applyCustomTheme(cfg);
}
function bindCustomThemeEditor() {
  const apply = enable => {
    const cfg = {
      css: $('ctCss')?.value || '',
      html: $('ctHtml')?.value || '',
      enabled: enable,
      updatedAt: Date.now(),
    };
    writeCustomTheme(cfg);
    applyCustomTheme(cfg);
    showToast(enable ? '自定义主题已应用。' : '已停用自定义主题，回到当前主题。');
  };
  if ($('ctApply')) $('ctApply').onclick = () => apply(true);
  if ($('ctDisable')) $('ctDisable').onclick = () => apply(false);
  if ($('ctTemplate')) $('ctTemplate').onclick = () => {
    if ($('ctCss')) $('ctCss').value = ':root{\n  --accent:#d7a35a;\n  --accent2:#8fb3ff;\n  --bg:#0b1018;\n  --panel:#111927;\n  --panel2:#0f1724;\n}\n\n/* 首页横幅 */\n.my-banner{\n  padding:18px 22px;border:1px solid var(--line);border-radius:12px;\n  background:var(--panel);color:var(--ink);font:600 14px/1.7 var(--sans);\n}';
    if ($('ctHtml')) $('ctHtml').value = '<div class="my-banner">今天想听点什么？<span style="color:var(--muted)">在下面挑一集，或从上次停下的地方继续。</span></div>';
    showToast('模板已填入，点「保存并应用」生效。');
  };
  if ($('ctCopy')) $('ctCopy').onclick = () => {
    const cfg = readCustomTheme();
    navigator.clipboard.writeText(JSON.stringify({ css: cfg.css, html: cfg.html }, null, 2))
      .then(() => showToast('配置已复制，可存成 .json 或发给别人。'))
      .catch(() => showToast('复制失败。', 'warn'));
  };
  if ($('ctReset')) $('ctReset').onclick = () => {
    if (!confirm('恢复默认会删除这段自定义 CSS 和 HTML，继续？')) return;
    localStorage.removeItem(CUSTOM_THEME_KEY);
    if ($('ctCss')) $('ctCss').value = '';
    if ($('ctHtml')) $('ctHtml').value = '';
    applyCustomTheme({ css: '', html: '', enabled: false });
    showToast('已恢复默认主题。');
  };
}
applyCustomTheme();
bindCustomThemeEditor();

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
function applyReader(persist = true) {
  const rs = document.documentElement.style;
  rs.setProperty('--reader-w', reader.width + 'px');
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
  if (!item || !item.url || audio.dataset.ep !== item.id) return;
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
function subtitleKernel() { return PluginHost.kernel('transcript'); }
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

function mergeCues(vtt, sidecar, zhVtt) {
  const kernel = subtitleKernel();
  if (!kernel || typeof kernel.merge !== 'function') {
    throw new Error('字幕内核未加载：请启用 subtitles 插件');
  }
  return kernel.merge(vtt, sidecar, zhVtt, { lang: reader.lang, segment: reader.segment });
}
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

function subtitleViewHost() {
  return {
    state, box, reader,
    pluginOn: subtitlePluginOn,
    liveOn: () => !!LIVE.on,
    fmt, splitLabel, isBracket,
    localAsrAvailable, clipListen, lookupWord, alignToCue, seekTo,
    whenIdle, studyApplyWordMarks, paint, syncMiniCaption, syncJumpPill,
    resetFind: () => { if (window.mytFindReset) window.mytFindReset(); },
    el: $,
  };
}
function alignZhLines() {
  const kernel = subtitleKernel();
  if (kernel && typeof kernel.alignZhLines === 'function') kernel.alignZhLines(subtitleViewHost());
}
function renderCueWindow(center, force) {
  const kernel = subtitleKernel();
  if (kernel && typeof kernel.renderWindow === 'function') kernel.renderWindow(subtitleViewHost(), center, force);
}
function renderCues() {
  if (!subtitlePluginOn()) { box.innerHTML = ''; syncMiniCaption(); return; }
  const kernel = subtitleKernel();
  if (!kernel || typeof kernel.renderCues !== 'function') {
    box.innerHTML = '<div class="empty">字幕内核未加载：请启用 subtitles 插件。</div>';
    return;
  }
  kernel.renderCues(subtitleViewHost());
}
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
function seekTo(t) { if (!state.current) return; studyLoop = null; rawSeek(t / (state.timeScale || 1)); audio.play().catch(() => {}); paint(true); }

function locateCue(t) {
  // 正常播放时先扫当前句附近，避免每 120ms 线性扫几千句；跳转/越界时再全量扫描。
  const cues = state.cues;
  const hint = state.activeCue;
  if (hint >= 0 && cues[hint]) {
    const h = cues[hint];
    const hs = h.speechStart + state.offset, he = h.speechEnd + state.offset;
    if (t >= hs - 2 && t <= he + 5) {
      let ans = -1, latestStart = -Infinity;
      const from = Math.max(0, hint - 6), to = Math.min(cues.length, hint + 13);
      for (let i = from; i < to; i++) {
        const c = cues[i];
        const start = c.speechStart + state.offset;
        if (start <= t && start >= latestStart) { latestStart = start; ans = i; }
      }
      const outside = cues[to];
      if (ans >= 0 && (!outside || outside.speechStart + state.offset > t)
        && t <= cues[ans].speechEnd + state.offset + 0.35) return ans;
    }
  }
  let ans = -1;
  let latestStart = -Infinity;
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const start = c.speechStart + state.offset;
    if (start <= t && start >= latestStart) {
      latestStart = start;
      ans = i;
    }
  }
  if (ans < 0) return -1;
  const c = cues[ans];
  return t <= c.speechEnd + state.offset + 0.35 ? ans : -1;
}

function paint(force = false) {
  if (LIVE.on) { liveAdvance(); return; }
  // 驾驶模式把正文整块隐藏了，滚动和逐词上色都没有显示意义，直接不干这活。
  const carUi = document.body.classList.contains('car-mode');
  if (!state.cues.length) { syncJumpPill(); return; }
  const raw = audio.currentTime || 0;
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
    studyAutoPauseDone = -1;
    if (state.wallpaper) wallpaperRefresh();
    if (ci >= 0) trPrimeCues(ci);
    if (ci >= 0) {
      const n = state.nodes[ci];
      if (!n) return;
      n.el.classList.add('active');
      // 刚进入播放器时即使暂停也要把当前句带回视野；之后仍按用户滚动和播放状态跟随。
      const follow = force || state.pendingFollow;
      setState('pendingFollow', false);
      if (!carUi) scrollCue(n.el, follow);
    }
  } else if (ci >= 0 && state.pendingFollow) {
    setState('pendingFollow', false);
    if (!carUi) scrollCue(state.nodes[ci].el, true);
  }
  if (ci >= 0 && state.mode === 'word' && !carUi) paintWords(ci, t);
  if (state.wallpaper) wallpaperWordPaint(t);
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
  if (!carUi && (force || Date.now() - state.lastPillAt > 400)) { setState('lastPillAt', Date.now()); syncJumpPill(); }
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

function paintWords(ci, t) {
  const cue = state.cues[ci], n = state.nodes[ci];
  if (!cue || !n || !cue.hasWords || !n.words.length) return;
  let idx = -1;
  for (let i = 0; i < cue.words.length; i++) { if (t >= cue.words[i].s + state.offset) idx = i; else break; }
  const prev = n.lastIdx;
  if (idx === prev) return;
  // 只重设「上次的当前词」到「这次的当前词」之间那一段：正常播放每次只挪一个词，
  // 原来每次都要遍历整句 30+ 个词并反复 add/remove class。
  const start = prev < 0 ? 0 : Math.max(0, Math.min(prev, idx));
  const end = Math.max(prev, idx);
  for (let i = start; i <= end; i++) {
    const w = n.words[i];
    if (i === idx) { w.classList.remove('pending','past'); w.classList.add('active'); }
    else if (i < idx) { w.classList.remove('pending','active'); w.classList.add('past'); }
    else { w.classList.remove('active','past'); w.classList.add('pending'); }
  }
  n.lastIdx = idx; setState('wordIdx', idx);
  if (idx >= 0 && n.words[idx]) scrollWord(n.words[idx]);
}

let scrollTarget = -1;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
function stopScroll() { scrollTarget = -1; }
function scrollIntoBox(el, mode) {
  const br = box.getBoundingClientRect(), er = el.getBoundingClientRect();
  let top = null;
  if (mode === 'center') top = box.scrollTop + (er.top - br.top) - (box.clientHeight - er.height)/2;
  else if (er.top < br.top + 80) top = box.scrollTop + (er.top - br.top) - 80;
  else if (er.bottom > br.bottom - 80) top = box.scrollTop + (er.bottom - br.bottom) + 80;
  if (top === null) return;
  const target = Math.max(0, Math.min(top, box.scrollHeight - box.clientHeight));
  if (target === scrollTarget) return;
  scrollTarget = target;
  const far = Math.abs(target - box.scrollTop) > box.clientHeight * 1.2;
  box.scrollTo({ top: target, behavior: reduceMotion || document.hidden || far ? 'auto' : 'smooth' });
}
function canFollow(force) { return state.scroll !== 'off' && (force || Date.now() >= state.userScrollUntil) && (force || !audio.paused); }
function scrollCue(el, force) {
  if (!canFollow(force)) return;
  const r = el.getBoundingClientRect(), br = box.getBoundingClientRect();
  const edge = r.top < br.top + 90 || r.bottom > br.bottom - 90;
  if (force || state.scroll === 'center' || edge) scrollIntoBox(el, state.scroll === 'center' ? 'center' : 'edge');
}
function scrollWord(el) {
  if (!canFollow(false)) return;
  if (state.scroll === 'center') {
    // 居中档要跟着“当前词”走，而不是只在一句开始时居中；偏移小于 18% 视口就不动，避免每词抖一下。
    const r = el.getBoundingClientRect(), br = box.getBoundingClientRect();
    const off = Math.abs((r.top + r.height / 2) - (br.top + box.clientHeight / 2));
    if (off > box.clientHeight * 0.18) scrollIntoBox(el, 'center');
    return;
  }
  const r = el.getBoundingClientRect(), br = box.getBoundingClientRect();
  if (r.top < br.top + 60 || r.bottom > br.bottom - 60) scrollIntoBox(el, 'edge');
}
// 实时模式没有原来的 scrollCue 可用（它按 VTT 的行推进，实时行不在它的窗口里），
// 而且 scrollWord 在「居中」模式下直接 return——所以实时正文要靠这个函数自己跟：
// 居中档要求高亮词始终落在正文框中间附近，边缘档只在快滚出去时挪一下。
function liveFollow(el) {
  if (!el || state.scroll === 'off') return;
  if (Date.now() < state.userScrollUntil || audio.paused) return;
  const br = box.getBoundingClientRect(), er = el.getBoundingClientRect();
  if (state.scroll === 'center') {
    const off = (er.top + er.height / 2) - (br.top + box.clientHeight / 2);
    if (Math.abs(off) > box.clientHeight * 0.16) scrollIntoBox(el, 'center');
    return;
  }
  if (er.top < br.top + 90 || er.bottom > br.bottom - 90) scrollIntoBox(el, 'edge');
}

/* layer: bridge —— 实时字幕桥、tauriHost()/host() 唯一平台入口
   本片只做该层的事，跨层调用走 kernel / host() / setState。 */
/* ---------- 实时逐词字幕（实验功能，默认关闭） ----------
   链路：音频 URL（需 CORS）→ 拉取整个音频文件 → 扫 MP3 帧建「字节↔时间」索引
    → 按「播放位置 + 提前量」解码出 16 kHz 单声道 PCM 喂给 Moonshine 流式识别
    （cross-attention + DTW 的词级时间戳）→ 时间轴映射 → 正文逐词渲染。
   用解码而不是 Web Audio 采集，是因为采集只能拿到「已经播出去」的音频，永远
   落后于播放头；要提前 s 秒生成，必须自己把还没播到的音频解出来。关闭后正文
   立刻回到原本的 VTT / 词级 JSON 渲染，原有播放、重试、跳转逻辑不受影响。 */
const LIVE_RATE = 16000;
const LIVE_ENGINE = 'https://cdn.jsdelivr.net/npm/@moonshine-ai/moonshine-wasm@0.1.6/dist/index.js';
/* 识别引擎接缝：适配器只暴露 { load() → engine }，engine 形状由 liveStartStream 约定
   （addAudio / transcribe / stop / close）。换引擎时只加一个适配器，不动调用方。 */
const TRANSCRIBER_ADAPTERS = new Map();
function registerTranscriber(kind, adapter) {
  if (!kind || !adapter || typeof adapter.load !== 'function') throw new Error('识别适配器需要 kind 和 load()');
  TRANSCRIBER_ADAPTERS.set(String(kind), adapter);
}
function transcriberFor(kind) { return TRANSCRIBER_ADAPTERS.get(String(kind)) || null; }

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
const LIVE_LEAD_DEFAULT = 60;   // 默认提前 60 秒（用户最初要的 1 分钟）。单流接管后识别侧能稳定跑在
                                // 播放前面 60 秒（实测 59~60 秒连续 60 秒不抖），所以不再需要为了
                                // “堆不满”把它压到 15 秒；想要低延迟的读者可以在设置里选 15 秒。
const LIVE_FETCH = 10;          // 每次按 Range 取多少秒的音频字节。取小单次快但弱网下请求次数太多、
                                // 一轮赶不上播放；取 10 秒把请求数砍掉四成，decodeAudioData 在后台线程解码，峰值可接受。
const LIVE_BUDGET_MS = 220;     // 每轮最多让识别占用多久，避免卡住界面/播放。实测单次 transcribe
                                // 就要 100~120 ms，140 ms 预算下一轮基本只能跑一次识别（喂 0.5~1 秒），
                                // 吞吐被卡在 2.4~4 倍实时；放到 220 ms 一轮能喂两批。
const LIVE_SLICE = LIVE_RATE / 2;  // 每次喂进去多少 PCM：片越小，单次识别越短（主线程不卡）
const LIVE_TR_BATCH = LIVE_RATE * 2;  // 攒够多少 PCM 才跑一次识别：transcribe 有固定开销（实测 1 秒批
                                   // 100~120 ms），2 秒批一次把调用次数砍半、单次仍只涨到 ~200 ms，
                                   // 识别侧实时因子从 2.4~4 倍推到 8 倍上下。
const LIVE = {
  on: false, busy: false,
  engine: null, stream: null, session: 0,
  ctx: null, audioUrl: '', cbr: null, fail: 0,  anchorMedia: 0, next: 0, fed: 0, lastTr: 0, pcm: null, pumpTimer: 0, pumpGen: 0, pumping: false, text: '',
  rows: new Map(), order: [], progressText: '', mode: 'idle', activeRow: '', cursor: 0,
  mse: null, bytePos: 0, byteSec: 0,
  prefetchWin: null, prefetching: false, prefetchQ: [], prefetchFrom: 0,
};

function liveMediaTime() {
  return (audio.currentTime || 0) + (state.timeScale - 1) * state.seekRaw;
}
// 喂给识别的是媒体时间上连续的 PCM，倍速不影响这条时间轴，所以只是一个起点偏移。
function liveMediaOf(sec) {
  return LIVE.anchorMedia + Number(sec || 0);
}
let liveBarHideTimer = 0;
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
function tauriHost() { return window.__TAURI__ || null; }
const LIVE_HOST = (() => {
  if (window.MyTranscriptHost) return window.MyTranscriptHost;
  const T = tauriHost();
  if (!T || !T.core || typeof T.core.invoke !== 'function') return null;
  const call = (cmd, args) => T.core.invoke(cmd, args || {});
  return {
    kind: 'tauri',
    // 原生发 Range 请求，返回 ArrayBuffer（Tauri 的 ipc::Response 直接给字节）。
    fetchRange: (url, from, to) => call('read_range', { url, from, to }),
    // 原生识别：prepare 落盘模型（首次会下载），open 建一路流。
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
    // 小文件文本（章节 JSON、词典释义）
    httpText: url => call('http_text', { url }),
    // 离线：整集落盘、列目录、删除；本地文件通过 asset: 协议取用
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
    pluginExample: () => call('plugin_example', {}),
    notify: (title, body) => call('notify', { title, body }),
    asset: p => (T.core.convertFileSrc ? T.core.convertFileSrc(p) : p),
  };
})();
// 唯一宿主句柄：其余代码只经 host() 读取，不再直接引用 LIVE_HOST。
function host() { return LIVE_HOST; }

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
      if (err && err.cors) throw err;
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

// 头部探针：跳 ID3v2，找到第一帧，确认是 CBR（恒定码率）才能用「字节 = 时间 × 码率」定位。
// 有的节目把 3000×3000 封面塞进 ID3（实测光封面就 ~1.4 MB），128 KB 的窗口根本到不了
// 第一帧，以前会误报「这个音频不是 MP3」。所以按 128 KB → 2 MB → 8 MB 递进取窗口。
async function liveProbeAudio() {
  const sizes = [131072, 2 * 1024 * 1024, 8 * 1024 * 1024];
  let last = null;
  for (const size of sizes) {
    const head = await liveFetchRange(0, size - 1);
    try {
      const r = liveProbeScan(head);
      if (r) return { origin: r.offset, bps: r.bps, sr: r.sr, spf: r.spf };
    } catch (err) {
      // 已经认出是 VBR 就没必要再放大窗口了，直接把这个错误交给调用方。
      last = err;
      break;
    }
    last = null;
  }
  if (last) throw last;
  throw new Error('这个音频不是 MP3，暂时只支持 MP3 的提前生成');
}

// 取 [startSec, startSec+seconds) 这段：按码率算出字节范围 → 重同步到帧边界 → 解码成 16k 单声道。
async function liveFetchWindow(startSec, seconds) {
  const c = LIVE.cbr;
  if (!c || !LIVE.ctx) return null;
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

// ── 单流播放（实验，Chrome/Edge）─────────────────────────────────────────────
// 同一份字节只下载一次：解析出的 MP3 帧既 append 给 MediaSource 播放，又随
// decodeAudioData 成 PCM 喂识别，所以识别能真正跑到播放前面，不再受“播放器
// 只缓冲十几秒”的限制。默认关闭（prefs.liveMse）；Safari 的 MSE 不支持
// audio/mpeg，会自动退回原生播放 + Range 取音频的老路径。
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
    return !!(window.MediaSource && MediaSource.isTypeSupported && MediaSource.isTypeSupported('audio/mpeg'));
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
  if (!liveMseCapable() || !LIVE.cbr) return false;
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
    m.lastErr = e && e.name ? e.name : String(e);
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
  if (!c || !LIVE.ctx) return null;
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
      const m = LIVE.mse, b = m.sb.buffered, head0 = audio.currentTime || 0;
      if (!m.reanchoring && b.length && (head0 < b.start(0) - 1 || head0 > b.end(b.length - 1) + 1)) {
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

/* layer: bridge —— Tauri 原生 ASR、跨域隔离 SW、离线跳过
   本片只做该层的事，跨层调用走 kernel / host() / setState。 */
/* ---------- 原生推理（Tauri 壳）：sherpa-onnx 的 Windows DLL ----------
   和上面 WASM 版是同一个模型、同一套切词规则，只是把 decode 挪到了 Rust 侧：
   WebView 只负责喂 PCM、取 JSON，主线程不再被推理占住。 */
async function liveNativeLoad() {
  if (LIVE.busy) liveSetText('准备原生识别模型（未安装时会先下载）…', 'busy');
  const dir = await host().asrPrepare(prefs.asrModel || ASR_MODEL_DEFAULT);
  // 线程数留一个核给播放/界面；sherpa 的 intra-op 线程超过 4 收益很小。
  const cores = navigator.hardwareConcurrency || 4;
  const threads = Math.max(2, Math.min(4, cores > 4 ? cores - 1 : 2));
  const id = await host().asrOpen(dir, threads);
  if (typeof id !== 'number') throw new Error('原生识别器创建失败');
  return { kind: 'native', id, threads };
}

function liveNativeStream(session, anchor) {
  const id = LIVE.engine.id;
  const seg = { fed: 0, segBase: 0, lineId: 0, cursor: 0, lastSig: '' };
  let closed = false;
  let buf = null;        // 还没交给原生侧的那部分 PCM
  let inflight = false;  // 同一条命令通道串行，避免 feed/result 乱序
  const flush = async () => {
    if (closed || inflight || session !== LIVE.session) return;
    if (!buf || !buf.length) return;
    const samples = Array.from(buf);
    buf = null;
    inflight = true;
    try {
      await host().asrFeed(id, samples, 16000);
      if (closed || session !== LIVE.session) return;
      const json = await host().asrResult(id);
      if (closed || session !== LIVE.session) return;
      let r = null;
      try { r = JSON.parse(json || '{}'); } catch (e) { r = null; }
      if (!r) return;
      const needReset = liveEmitTokens(session, seg, r.tokens, r.timestamps);
      if (needReset) {
        await host().asrReset(id);
        seg.cursor = 0;
        seg.segBase = seg.fed;
      }
    } catch (err) {
      console.warn('[live] 原生识别失败', err && err.message ? err.message : err);
    } finally {
      inflight = false;
    }
  };
  return {
    addAudio(chunk, rate) {
      if (closed || !chunk || !chunk.length) return;
      buf = buf && buf.length ? liveConcatFloat(buf, chunk) : chunk;
      seg.fed += chunk.length / rate;
    },
    transcribe() { flush(); },
    stop() {},
    close() {
      if (closed) return;
      closed = true;
      buf = null;
      try { host().asrClose(id); } catch (e) {}
    },
  };
}

function liveConcatFloat(a, b) {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}



function liveCloseStream() {
  if (!LIVE.stream) return;
  try { LIVE.stream.stop(); } catch (e) {}
  try { LIVE.stream.close(); } catch (e) {}
  LIVE.stream = null;
}

function liveClearRows() {
  LIVE.order.forEach(id => { const row = LIVE.rows.get(id); if (row) row.el.remove(); });
  LIVE.rows.clear();
  LIVE.order.length = 0;
  LIVE.activeRow = '';
  LIVE.cursor = 0;
}

// 跳转后只砍掉“落在播放头之后”的行：往前跳时新识别会从播放头接着往下走，
// 留着旧行会时间倒退（新行会被单调校验挡掉，高亮就卡住）；往后跳时后面的行本来就作废。
// 播放头之前的行是这段话的真识别结果，保留下来读者不会看到整屏突然清空。
function liveTrimRowsAfter(t) {
  let cut = false;
  while (LIVE.order.length) {
    const key = LIVE.order[LIVE.order.length - 1];
    const row = LIVE.rows.get(key);
    if (!row || row.start < t - 0.5) break;
    LIVE.order.pop();
    LIVE.rows.delete(key);
    row.el.remove();
    cut = true;
  }
  if (cut) { LIVE.activeRow = ''; LIVE.cursor = 0; }
}

// 换集、跳转、倍速都会让“PCM 时间轴”和播放器时间轴脱钩，直接重建一段新流。
function liveRebuildStream() {
  if (!LIVE.engine) return;
  liveCloseStream();
  LIVE.session += 1;
  const session = LIVE.session;
  // 锚点要在建流之前定：sherpa 那一路流自己要把 t=0 对到媒体时间上。
  const anchor = livePlayhead();
  if (LIVE.engine.kind === 'sherpa') {
    LIVE.stream = liveSherpaStream(session, anchor);
  } else if (LIVE.engine.kind === 'native') {
    LIVE.stream = liveNativeStream(session, anchor);
  } else {
    const stream = LIVE.engine.createStream({ updateInterval: 0.5 });
    stream.addListener({
      onLineStarted: e => liveRenderLine(session, e.line),
      onLineTextChanged: e => liveRenderLine(session, e.line),
      onLineUpdated: e => liveRenderLine(session, e.line),
      onLineCompleted: e => liveRenderLine(session, e.line),
      onError: e => console.warn('[live] ASR', e.error && e.error.message ? e.error.message : e.error),
    });
    stream.start();
    LIVE.stream = stream;
  }
  LIVE.fed = 0;
  LIVE.lastTr = 0;
  LIVE.pcm = null;
  LIVE.anchorMedia = anchor;
  LIVE.next = LIVE.anchorMedia;   // 从这个播放点开始往后喂
  LIVE.prefetchQ = [];            // 预取队列里的窗口是按旧位置取的，重建时必须丢掉
  LIVE.prefetchFrom = LIVE.next;
  LIVE.prefetchWin = null;
  // 单流模式的字节游标要跟着新锚点走，否则 append 的时间轴会和播放头错开。
  if (LIVE.mse && LIVE.cbr) {
    LIVE.byteSec = LIVE.next;
    LIVE.bytePos = LIVE.cbr.origin + Math.round(LIVE.cbr.bps * LIVE.next);
  }
  LIVE.fail = 0;
  LIVE.text = '';
  liveStopPump();
  liveStartPump();
}

// Moonshine 的 `line.words` 里只有最前面几个词带真实时间，后面补进来的词 `start/end`
// 常常是 0（偶尔还会出现 end < start、时间倒退）。直接拿它们做逐词高亮，表现就是：
// 前几个词正常走，然后高亮卡住，接着一下子跳到行尾 —— 也就是“不跟随、乱跳”。
// 行的 `startTime` 和 `duration` 是可靠的，所以先看引擎给的时间能不能用（单调、落在
// 行区间内、长度非负），不能用就按词长把整行的词均分到 [start, start+duration]，
// 至少保证单调、连续、跟得上。
function liveWordTimes(line) {
  const ws = line.words || [];
  if (!ws.length) return [];
  const start = Number(line.startTime) || 0;
  const dur = Number(line.duration) || 0;
  const span = dur > 0.05 ? dur : Math.max(0.4, ws.length * 0.45);
  const engineOk = ws.every((w, i) => {
    const s = Number(w.start), e = Number(w.end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) return false;
    if (s < -0.02 || s > span + 0.02) return false;   // 词的 start 是相对行起点的
    if (e < s - 0.02) return false;
    if (i > 0 && s < Number(ws[i - 1].start) - 0.02) return false;
    return true;
  });
  if (engineOk) {
    return { engine: true, times: ws.map(w => ({ t: w.text, s: liveMediaOf(start + Number(w.start)), e: liveMediaOf(start + Number(w.end)) })) };
  }
  const weights = ws.map(w => Math.max(1, String(w.text || '').trim().length + 1));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  return { engine: false, times: ws.map((w, i) => {
    const a = acc;
    acc += weights[i] / total * span;
    const s = liveMediaOf(start + a);
    const e = liveMediaOf(start + (i === ws.length - 1 ? span : acc));
    return { t: w.text, s, e: Math.max(s + 0.05, e) };
  }) };
}

// 实时行译文：等这一行文字稳定 0.7 秒再翻，避免流式更新时反复请求；
// 译完作为该行下面的灰色小字，和原文字稿的 .zh 用同一套样式。
function liveRowZh(row) {
  if (!row || !row.zhText) return;
  let z = row.el.querySelector('.live-zh');
  if (!z) {
    z = document.createElement('span');
    z.className = 'zh live-zh';
    z.lang = 'zh-CN';
    row.el.append(z);
  }
  z.textContent = row.zhText;
}
function liveTranslateRow(row, text) {
  if (!row || !trReady()) return;
  clearTimeout(row.trTimer);
  row.trTimer = setTimeout(() => {
    if (!row.el.isConnected) return;
    const source = String(text || '').trim();
    if (!source) return;
    trText(source).then(zh => {
      if (!zh || row.trSource === source) return;
      row.trSource = source;
      row.zhText = zh;
      liveRowZh(row);
    }).catch(trNoteError);
  }, 700);
}

function liveRenderLine(session, line) {  if (session !== LIVE.session || !line) return;
  if (box.querySelector('.empty')) box.innerHTML = '';
  // 每次重建流 line.id 都会从头开始，带上 session 才不会把旧行覆盖掉。
  const key = session + ':' + line.id;
  let row = LIVE.rows.get(key);
  if (!row) {
    const start = liveMediaOf(line.startTime);
    // 行必须按时间递增入列：重建流/跳转的瞬间偶尔会迟到半句旧时间，插进来会
    // 让游标定位错行、高亮跳到别的句子上去。时间倒退的直接丢掉。
    const prevKey = LIVE.order[LIVE.order.length - 1];
    const prevRow = prevKey ? LIVE.rows.get(prevKey) : null;
    if (prevRow && start < prevRow.start - 0.5) return;
    row = { el: document.createElement('div'), words: [], lastIdx: -1, sig: '', start };
    row.el.className = 'cue live';
    LIVE.rows.set(key, row);
    LIVE.order.push(key);
    box.append(row.el);
    if (LIVE.order.length > 240) {      // 只留最近若干句，长播客不会把 DOM 撑爆
      const drop = LIVE.order.shift();
      const old = LIVE.rows.get(drop);
      if (old) { old.el.remove(); LIVE.rows.delete(drop); }
    }
    liveUpdateMeter();
  }
  const wt = liveWordTimes(line);
  const words = wt.times;
  const sameWords = words.length === row.words.length
    && words.every((w, i) => w.t === row.words[i].t);
  const stampText = fmt(liveMediaOf(line.startTime));
  if (row.sig !== '' && sameWords) {
    // 流式识别每 0.5 秒会重发一次同一句：词数没变时只改文字，不动 DOM 结构。
    // 之前每次整行 replaceChildren，会把 .word.active 一起抹掉，高亮看起来在乱跳，
    // 重建节点还会连续触发重排，播放也跟着卡。
    words.forEach((w, i) => {
      const el = row.words[i].el;
      if (el.textContent !== w.t) el.textContent = w.t;
      // 时间会随行不断变长而重算（尤其是兜底均分那条路径），原地更新，
      // 不然高亮还按建行时那套旧时间去比，越到后面越对不上。
      row.words[i].s = w.s;
      row.words[i].e = w.e;
    });
    const stampEl = row.el.firstChild;
    if (stampEl && stampEl.className === 'stamp' && stampEl.textContent !== stampText) stampEl.textContent = stampText;
    row.sig = line.text + '|' + words.length + '|' + (line.isComplete ? '1' : '0');
    row.el.classList.toggle('done', !!line.isComplete);
    liveTranslateRow(row, line.text);
    return;
  }
  const sig = line.text + '|' + words.length + '|' + (line.isComplete ? '1' : '0');
  if (row.sig !== sig) {
    row.sig = sig;
    row.lastIdx = -1;
    const frag = document.createDocumentFragment();
    const stamp = document.createElement('span');
    stamp.className = 'stamp';
    stamp.textContent = fmt(liveMediaOf(line.startTime));
    frag.append(stamp);
    row.words = [];
    if (words.length) {
      words.forEach(w => {
        const span = document.createElement('span');
        span.className = 'word pending';
        span.textContent = w.t;
        span.addEventListener('click', ev => { ev.stopPropagation(); seekTo(w.s); });
        frag.append(span, document.createTextNode(' '));
        row.words.push({ el: span, s: w.s, e: w.e });
      });
    } else {
      const span = document.createElement('span');
      span.textContent = line.text;
      frag.append(span);
    }
    row.el.replaceChildren(frag);
    row.el.classList.toggle('done', !!line.isComplete);
    liveRowZh(row);
    liveTranslateRow(row, line.text);
  }
  // 视野跟着播放头走，而不是跟着“已经生成到哪”：提前量一大，最新一行还在
  // 60 秒之后，滚过去会把读者从正在读的位置拽走。
}

// 实时模式下由 paint() 转到这里：只驱动逐词高亮与进度显示。
function liveAdvance() {
  // 用音频元素的真实时间轴：识别喂进去的 PCM 就是这条时间轴上的位置，
  // 不能走 liveMediaTime()（它带倍速估算项，倍速时会和音频对不上，高亮越跑越偏）。
  const t = audio.currentTime || 0;
  if (state.seekPreview == null) {
    const nowText = fmt(t);
    $('now').textContent = nowText;
    setState('lastNowText', nowText);
    $('seek').setAttribute('aria-valuetext', fmt(t) + ' / ' + fmt(state.audioSeconds || audio.duration || 0));
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      const pct = Math.min(100, Math.max(0, (audio.currentTime || 0) / audio.duration * 100));
      setState('lastSeekBucket', Math.round(pct * 10));
      $('seek').value = String(state.lastSeekBucket);
      $('pfill').style.width = pct + '%';
    }
  }
  // paint() 在实时模式下直接转到这里，章节条得自己跟，否则 #chapterChip 会冻在旧章。
  syncChapterNow(t);
  const order = LIVE.order;
  if (!order.length) return;
  // 行按时间递增。提前量会把最新一行排到播放头之后几十秒，所以不能只看末尾几行：
  // 用游标前后微调，找到播放头所在行，再只给它和相邻行上色。
  const startOf = i => { const r = LIVE.rows.get(order[i]); return r ? r.start : Infinity; };
  let ci = Math.max(0, Math.min(LIVE.cursor, order.length - 1));
  while (ci > 0 && startOf(ci) > t) ci -= 1;
  while (ci < order.length - 1 && startOf(ci + 1) <= t) ci += 1;
  LIVE.cursor = ci;
  // 驾驶模式隐藏正文，上色和滚动都没有意义；退出驾驶时会把 lastIdx 全部置脏再重画。
  if (document.body.classList.contains('car-mode')) return;
  // 播放头可能正好落在一条“刚建出来、词还没到”的行上（流式识别先给文本再给词）。
  // 这种行不能算当前行，否则上一行会立刻被收成 past、又没有新的词接上，
  // 高亮就会空一帧再回来。往下退一行，退到最近一条真的有词的行。
  let ai = ci;
  while (ai > 0 && !(LIVE.rows.get(order[ai]) || { words: [] }).words.length) ai -= 1;
  let activeId = '';
  for (let i = Math.max(0, ai - 1); i <= Math.min(order.length - 1, ai + 1); i++) {
    const id = order[i];
    const row = LIVE.rows.get(id);
    if (!row || !row.words.length) continue;
    // 只有播放头所在的那一行在推进；它前面的收成 past，后面的保持 pending，
    // 否则两行时间有重叠时会出现两个 .word.active。
    let idx;
    if (i < ai) idx = row.words.length;
    else if (i > ai) idx = -1;
    else {
      idx = -1;
      for (let k = 0; k < row.words.length; k++) { if (t >= row.words[k].s) idx = k; else break; }
      // 行起点比它的第一个词早零点几秒：这时不要退出高亮，否则每换一句话
      // 高亮都会消失一下再回来（看起来就是“跳动”）。直接先压住第一个词。
      if (idx < 0 && t >= row.start) idx = 0;
    }
    if (idx >= 0) activeId = id;
    if (idx === row.lastIdx) continue;
    row.words.forEach((w, k) => {
      const el = w.el;
      el.classList.remove('active', 'past', 'pending');
      el.classList.add(k === idx ? 'active' : (k < idx ? 'past' : 'pending'));
    });
    row.lastIdx = idx;
    row.el.classList.toggle('active', idx >= 0 && i === ai);
    if (idx >= 0 && i === ai) liveFollow(row.words[idx].el);
  }
  // 活动行换人时把上一行彻底收尾（这里不动滚动，滚动只跟着高亮词）。
  if (LIVE.activeRow !== activeId) {
    const prev = LIVE.rows.get(LIVE.activeRow);
    if (prev && prev.words.length) {
      prev.words.forEach(w => { w.el.classList.remove('active', 'pending'); w.el.classList.add('past'); });
      prev.lastIdx = prev.words.length - 1;
      prev.el.classList.remove('active');
    }
    LIVE.activeRow = activeId;
  }
}

function liveDisable(hint) {
  LIVE.on = false;
  LIVE.mode = 'idle';
  LIVE.session += 1;
  liveStopPump();
  liveCloseStream();
  if (LIVE.mse) liveMseStop();   // 单流接管着播放，停实时识别前先把播放还回去
  liveClearRows();
  document.body.classList.remove('live-on');
  $('liveBtn').setAttribute('aria-pressed', 'false');
  $('liveBtn').classList.remove('on');
  if (liveBarHideTimer) { clearTimeout(liveBarHideTimer); liveBarHideTimer = 0; }
  $('liveBar').hidden = true;
  $('liveMeter').style.width = '0%';
  if (state.base) renderCues();
  syncDockBadge();
  if (hint) showToast(hint, 5000);
}

// 页面默认不是跨域隔离的（GitHub Pages 不能设响应头）。同源 Service Worker 会在
// 下一次导航时给文档补 COOP/COEP:credentialless，所以这里只负责注册并请用户刷新一次。
async function liveEnsureIsolation() {
  if (self.crossOriginIsolated) return 'ready';
  if (!('serviceWorker' in navigator)) return 'unsupported';
  try {
    await navigator.serviceWorker.register('live-sw.js', { scope: './' });
    await navigator.serviceWorker.ready;
    return 'reload';
  } catch (e) {
    return 'unsupported';
  }
}

async function liveEnable() {
  if (!subtitlePluginOn()) { showToast('字幕插件未启用，实时识别不可用。', 'warn'); return; }
  if (LIVE.busy || LIVE.on) return;
  if (!state.current) { showToast('先选一集，再开启实时识别。'); return; }
  const src = audio.currentSrc || audio.getAttribute('src') || '';
  if (!src) { showToast('这一集没有可采集的音频地址。'); return; }
  LIVE.busy = true;
  LIVE.mode = 'busy';
  LIVE.progressText = '';
  LIVE.text = '';
  $('liveBtn').classList.add('busy');
  $('liveBar').hidden = false;
  $('liveStopBtn').textContent = '停止';
  liveSetText('检查运行环境…', 'busy');
  try {
    // 跨域隔离只为 Moonshine 的多线程 WASM 准备；sherpa（WASM 单线程构建）和
    // 原生推理都不需要这一关。
    if (LIVE_ENGINE_KIND === 'moonshine') {
      const iso = await liveEnsureIsolation();
      if (iso !== 'ready') {
        LIVE.mode = 'needReload';
        $('liveStopBtn').textContent = iso === 'reload' ? '刷新页面' : '关闭';
        if (iso === 'reload') {
          // 记住这次意图，刷新回来自动接着开，不用再点一次。
          try { sessionStorage.setItem('myt-live-auto', '1'); } catch (e) {}
          liveSetText('需要刷新一次以启用跨域隔离，刷新后会自动继续', 'busy');
        } else {
          liveSetText('这个浏览器不支持 Service Worker，实时识别不可用', 'err');
        }
        return;
      }
    }
    LIVE.session += 1;
    const session = LIVE.session;
    if (LIVE.audioUrl !== src || !LIVE.cbr) {
      LIVE.audioUrl = src;
      LIVE.cbr = null;
      liveSetText('解析音频格式…', 'busy');
      LIVE.cbr = await liveRetry(() => liveProbeAudio(), 4, 900);
    }
    if (LIVE.session !== session) return;
    if (!LIVE.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('这个浏览器不支持 Web Audio 解码');
      LIVE.ctx = new Ctx({ sampleRate: LIVE_RATE });
    }
    liveSetText('下载识别模型…', 'busy');
    const engine = await Promise.race([
      liveLoadEngine(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('识别引擎加载超时（首次需下载约 40 MB 模型，缓存后秒开）')), 240000)),
    ]);
    if (!engine) throw new Error('识别引擎未就绪');
    LIVE.on = true;
    LIVE.mode = 'on';
    document.body.classList.add('live-on');
    $('liveBtn').setAttribute('aria-pressed', 'true');
    $('liveBtn').classList.add('on');
    syncDockBadge();
    // 单流播放：模型就绪后才接管播放，免得下模型失败时把用户的播放也搭进去。
    if (prefs.liveMse && liveMseCapable() && LIVE.cbr) {
      const wasPlaying = !audio.paused;   // 接管过程中会先暂停，这个状态要在这里先记住
      try {
        await liveMseBegin();
        if (wasPlaying || app.autoplay) { app.autoplay = false; audio.play().catch(() => {}); }
        status('单流播放已接管：同一份音频既用于播放也用于识别。', 'good');
      } catch (err) {
        liveMseStop();   // 接管失败就退回原生播放，实时识别照旧可用
        showToast('单流播放启动失败，已退回普通播放：' + (err && err.message ? err.message : err), 6000);
      }
    }
    liveClearRows();
    liveRebuildStream();
    liveSetText('实时识别中', 'on');
    status('实时识别已开启：正文显示本次播放的实时识别结果，原文字稿未被改动。', 'good');
  } catch (err) {
    // 音频源不给 CORS 头（stitcher/simplecast 那类 CDN 就是这样）：浏览器读不到字节，
    // 实时字幕在原理上就用不了，也别让它重试一阵再报错。
    const msg = err && err.cors
      ? '这个节目的音频源不允许跨域读取字节，实时字幕用不了（播放和原文字稿不受影响）'
      : (err && err.message ? err.message : String(err));
    LIVE.mode = 'failed';
    document.body.classList.remove('live-on');
    liveSetText('实时识别不可用：' + msg, 'err');
    showToast('实时识别不可用：' + msg, 9000);
    $('liveBtn').setAttribute('aria-pressed', 'false');
    $('liveBtn').classList.remove('on');
    LIVE.on = false;
    liveStopPump();
    liveCloseStream();
    $('liveMeter').style.width = '0%';
  } finally {
    LIVE.busy = false;
    $('liveBtn').classList.remove('busy');
  }
}

// 换集之后音频换了：重新探测格式，识别流从新的播放点重建。
// 这里用自己的 generation 判断“这次跟进是否还有效”，不再借用 LIVE.session：
// liveRebuildStream()（重建识别流）本身就会把 session 加一，用它当 token 会被自己
// 作废；而换集时可能同时来两次跟进，也需要“最新的那次赢、旧的自己退场”。
async function liveFollowCurrentEpisode(resumePlay) {
  if (!LIVE.on) return;
  const gen = LIVE.followGen = (LIVE.followGen || 0) + 1;
  const alive = () => LIVE.followGen === gen && LIVE.on;
  // 换集瞬间 audio.currentSrc 可能还是空（新的 src 刚 load、资源还没选好），
  // 这里等它落定再探测。以前直接取一次就拿去探测，换集后第一次探测必然失败，
  // 整条识别会停在“取音频数据失败”再也不恢复。
  let src = '';
  for (let i = 0; i < 6 && !src; i++) {
    src = audio.currentSrc || '';
    if (src) break;
    await new Promise(r => setTimeout(r, 1000));
    if (!alive()) return;
  }
  if (!src) {
    // 还没选出可读的音频地址：过一会儿再跟一次，别把识别判死。
    // 只在自己还是最新那次跟进时才排这一次重试，否则会把正在跑的那次顶掉。
    const p = resumePlay;
    if (alive()) setTimeout(() => { if (LIVE.on && LIVE.followGen === gen) liveFollowCurrentEpisode(p); }, 5000);
    return;
  }
  LIVE.audioUrl = src;
  LIVE.cbr = null;
  try {
    liveSetText('解析音频格式…', 'on');
    // 源站首字节偶发失败（实测换集后很常见），这里和首次开启一样带重试。
    LIVE.cbr = await liveRetry(() => liveProbeAudio(), 4, 900);
    if (!alive()) return;
    liveClearRows();
    liveRebuildStream();
    // 换集后自动重新接管：单流在 loadEpisode 里已经停掉（播放还给原生），这里等新一集
    // 拿到元数据再接管一次，用户不用手动开关「实时识别」。
    if (prefs.liveMse && liveMseCapable()) {
      const wasPlaying = !!resumePlay || !audio.paused || app.autoplay;
      try {
        const ready = await liveWaitAudioReady(15000);
        if (!alive()) return;
        // 新一集还在加载（源站慢时元数据十几秒才到）：这时候去接管会先把正在加载的原生
        // src 摘掉，结果两边都读不到数据，界面一直停在“等待音频加载…”。等它加载好再接管。
        if (!ready) {
          if (LIVE.on) setTimeout(() => { if (LIVE.on && LIVE.followGen === gen) liveFollowCurrentEpisode(resumePlay); }, 8000);
          return;
        }
        await liveMseBegin();
        if (wasPlaying) { app.autoplay = false; audio.play().catch(() => {}); }
      } catch (err) {
        if (LIVE.mse) liveMseStop();
        // 接管半途失败时元素可能已经被我们摘掉 src：把原生地址挂回去，别让播放停在这。
        else if (LIVE.audioUrl && audio.src !== LIVE.audioUrl) {
          audio.src = LIVE.audioUrl; try { audio.load(); } catch (e) {}
        }
        if (wasPlaying) audio.play().catch(() => {});
      }
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    liveSetText('正在等待新一集音频（' + msg + '）…', 'busy');
    // 探测失败不等于这一集不能用：源站偶发失败过几秒就好，等一会儿重新跟一次。
    const p = resumePlay;
    if (alive()) {
      setTimeout(() => { if (LIVE.on && LIVE.followGen === gen) liveFollowCurrentEpisode(p); }, 6000);
    }
  }
}

$('liveBtn').onclick = () => { if (LIVE.on) liveDisable('已停止实时识别，正文回到原文字稿。'); else liveEnable(); };
$('liveStopBtn').onclick = () => {
  if (LIVE.mode === 'needReload') { location.reload(); return; }
  liveDisable('已停止实时识别，正文回到原文字稿。');
};
audio.addEventListener('seeked', () => {
  if (!LIVE.on) return;
  const head = audio.currentTime || 0;
  // 音频重载、缓冲重试也会发 seeked，位置没变时不能把刚识别出来的行清掉；
  // 但“这段已经识别过”只能按**现有的行本身**判断，不能只看第一行起点 + LIVE.next：
  // 往回跳时 pump 会先按新位置重锚、重建流（next 变了），保留下来的旧行是跳转前那一段，
  // 只比首尾就会把中间的大空档也当成已识别 —— 于是既不裁行也不重建，新识别出来的行
  // 全被 liveRenderLine 里“时间倒退就丢掉”的守卫拦下。实测表现：识别还在跑、
  // 「已提前」仍是 14~15 秒，但正文永久停在跳转前那几句上。
  // 判据：找到起点不晚于播放头的那一行，再要求播放头离下一个已知起点不超过 30 秒
  // （中间空了这么久说明这段确实没识别过，得裁行重来）。
  const coversHead = (t) => {
    let last = null;
    let nextStart = Infinity;
    for (const key of LIVE.order) {
      const row = LIVE.rows.get(key);
      if (!row) continue;
      if (row.start <= t + 0.5) last = row;
      else { nextStart = row.start; break; }
    }
    if (!last) return false;
    const end = Number.isFinite(nextStart) ? nextStart : LIVE.next;
    return end - t <= 30;
  };
  if (LIVE.order.length && LIVE.next > head && coversHead(head)) {
    LIVE.cursor = 0;
    paint(true);
    return;
  }
  // 跳到已识别区间之外：不整屏清空，只砍掉播放头之后的行再接着识别，
  // 前面已经识别好的句子留在原地（清屏会让读者以为功能坏了，还要白等几秒）。
  liveTrimRowsAfter(head);
  if (LIVE.mse) {
    // seeked 会因为数据迟到才触发（MSE 里元素在拿到新位置数据前不发这个事件），
    // 等它到的时候 pump 往往已经把新位置重锚好了。数据在区间里就别再重建一次，
    // 否则每跳一次都会白清一遍行、白等几秒。
    const b = LIVE.mse.sb && LIVE.mse.sb.buffered;
    if (b && b.length && head >= b.start(0) - 1 && head <= b.end(b.length - 1) + 1) {
      LIVE.cursor = 0;
      paint(true);
      return;
    }
    liveMseReanchor(head).then(ok => { if (LIVE.on && ok) liveRebuildStream(); });
    return;
  }
  liveRebuildStream();
});
audio.addEventListener('ended', () => {
  if (LIVE.on && LIVE.stream) { try { LIVE.stream.transcribe(1); } catch (e) {} }
});

// 桌面壳：窗口去掉了系统标题栏（tauri.conf 里 decorations:false），这里把应用自己的
// 顶栏当标题栏用——顶栏/面包屑/侧栏品牌可以拖动窗口，右侧补一组自绘的最小化/最大化/关闭。
// 网页版没有 __TAURI__，整段不执行，行为不变。
(function shellFrame() {
  const T = tauriHost();
  if (!T || !T.window) return;
  let win = null;
  try {
    if (T.window.getCurrentWindow) win = T.window.getCurrentWindow();
    else if (T.window.getCurrent) win = T.window.getCurrent();
  } catch (e) { win = null; }
  if (!win) return;
  document.body.classList.add('deco');

  // 拖拽只认“mousedown 落点自己带属性”的元素，所以要把容器里的文本叶子一起标上；
  // 按钮/输入框保持不标，否则点不动。
  const markDrag = (el) => {
    if (!el) return;
    el.setAttribute('data-tauri-drag-region', '');
    el.querySelectorAll('*').forEach((kid) => {
      if (/^(BUTTON|INPUT|A|SELECT|TEXTAREA|SVG|PATH)$/.test(kid.tagName)) return;
      if (kid.dataset && kid.dataset.action) return;
      kid.setAttribute('data-tauri-drag-region', '');
    });
  };
  markDrag(document.querySelector('.topbar'));
  markDrag(document.querySelector('.brand'));

  // 播放页是全屏阅读器，顶部那圈浮层是 pointer-events:none，拖不动。
  // 不铺透明拖拽带了（它会盖住顶部 38px 的控件和字幕首行）；直接把阅读区容器本身
  // 标成拖拽区——Tauri 的裸属性只在“落点就是该元素”时生效，所以点句子照样能跳转。
  [document.querySelector('.reader'), document.getElementById('transcript')].forEach((el) => {
    if (el) el.setAttribute('data-tauri-drag-region', '');
  });

  const makeCtl = () => {
    const box = document.createElement('div');
    box.className = 'win-ctl';
    box.innerHTML =
      '<button type="button" data-win="mini" title="迷你窗" aria-label="迷你窗">⧉</button>' +
      '<button type="button" data-win="min" title="收进托盘" aria-label="收进托盘">－</button>' +
      '<button type="button" data-win="max" title="最大化" aria-label="最大化">▢</button>' +
      '<button type="button" data-win="close" title="关闭" aria-label="关闭">✕</button>';
    box.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-win]');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const k = btn.dataset.win;
      try {
        // 最小化 = 收进托盘继续播：音频留在主窗，托盘图标能把它叫回来。
        if (k === 'min') win.hide();
        else if (k === 'mini') { if (T.core && T.core.invoke) T.core.invoke('open_mini'); }
        else if (k === 'max') win.toggleMaximize();
        else if (k === 'close') win.close();
      } catch (err) { /* 权限缺失就静默，不把按钮点成异常 */ }
      if (k === 'max') {
        try {
          const maxed = await win.isMaximized();
          btn.textContent = maxed ? '❐' : '▢';
          btn.title = maxed ? '还原' : '最大化';
        } catch (err) {}
      }
    });
    return box;
  };
  const topActions = document.querySelector('.top-actions');
  if (topActions) { const c = makeCtl(); c.classList.add('win-ctl-app'); topActions.appendChild(c); }
  const readerRight = document.querySelector('.reader-top-right');
  if (readerRight) readerRight.appendChild(makeCtl());
})();

// 刷新回来接着开：第一次启用要先装 Service Worker 再刷新，不该让用户再点一次。
// ?live=1 是给桌面壳联调用的：开局就播、直接开实时识别，省掉手动点两下。
(function liveAutoResume() {
  let flag = '';
  try { flag = sessionStorage.getItem('myt-live-auto') || ''; } catch (e) {}
  const forced = /[?&]live=1/.test(location.search);
  if (!flag && !forced) return;
  let tries = 0;
  const attempt = () => {
    tries += 1;
    // 非强开路径仍然要求跨域隔离（Moonshine 的多线程 WASM 需要它）。
    if ((!forced && !self.crossOriginIsolated) || !document.body.classList.contains('player-open') || !state.current) {
      if (tries < 60) setTimeout(attempt, 250);
      return;
    }
    try { sessionStorage.removeItem('myt-live-auto'); } catch (e) {}
    liveEnable();
    if (audio.paused) audio.play().catch(() => {});
  };
  setTimeout(attempt, 600);
})();

function applyEpisodeData(vtt, sidecar, zhVtt) {
  if (!subtitlePluginOn()) return;
  setState('vtt', vtt); setState('sidecar', sidecar); setState('zhVtt', zhVtt);
  setState('base', { vtt, sidecar, zhVtt });
  setState('audioSeconds', Number(sidecar?.audio_seconds) || 0);
  updateTimeScale();
  setState('cues', mergeCues(vtt, sidecar, zhVtt));
  detectAdRanges();
  studyApplyCachedAdRanges();
  renderCues();
  if (state.show && state.current) indexCurrentEpisode(state.show, state.current);
}
const AD_RE = /(sponsored by|this episode is sponsored|ad break|promo code|use code|广告|赞助|优惠码|折扣码)/i;
function sanitizeAdRanges(ranges, fallbackSource = 'ai') {
  const out = [];
  for (const raw of (Array.isArray(ranges) ? ranges : [])) {
    if (!raw || typeof raw !== 'object') continue;
    const start = studyClockSeconds(raw.start ?? raw.from ?? raw.time);
    const end = studyClockSeconds(raw.end ?? raw.to);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const label = String(raw.label || raw.title || raw.reason || '').trim().slice(0, 80);
    out.push({ start, end, label: label || '广告', source: String(raw.source || fallbackSource) });
  }
  return out;
}
function mergeAdRanges(lists) {
  const all = [].concat(...lists).filter(range => range && Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const range of all) {
    const last = out[out.length - 1];
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
      if ((!last.label || last.label === '广告') && range.label) last.label = range.label;
    } else {
      out.push(Object.assign({}, range));
    }
  }
  return out;
}
function detectAdRanges() {
  const ranges = [];
  for (const cue of state.cues || []) {
    const text = String(cue.text || '') + ' ' + String(cue.zh || '');
    if (!AD_RE.test(text)) continue;
    const start = Number(cue.start) || 0;
    const end = Number(cue.end) || start + 2;
    const last = ranges[ranges.length - 1];
    if (last && start - last.end < 8) last.end = Math.max(last.end, end);
    else ranges.push({ start, end, label: '文字稿广告标记', source: 'transcript' });
  }
  setState('regexAdRanges', ranges);
  setState('adRanges', mergeAdRanges([ranges, state.aiAdRanges || []]));
}
function studyAdRangesFromData(data) {
  return sanitizeAdRanges(Array.isArray(data?.ads) ? data.ads : []);
}
function studyApplyAiAdRanges(data, epId) {
  if (!state.current || (epId && state.current.id !== epId)) return;
  setState('aiAdRanges', studyAdRangesFromData(data));
  setState('adSkipped', new Set());
  detectAdRanges();
}
function studyApplyCachedAdRanges() {
  const ep = state.current;
  if (!ep) return;
  try {
    const cached = studyCache['ep:' + ep.id];
    if (cached?.data?.version === 3) studyApplyAiAdRanges(cached.data, ep.id);
  } catch (e) {}
}
/* ---- cue 级跳过：只对「离线音频 + 本机文字稿」生效（2026-11-19 P0）
   为什么加这个门：skip.json 的标签是按本机转写切句算的，只有同一份本地音频 + 本地文字稿，
   时间轴才对得上；站外/动态插播的集套标签会跳错位置。 ---- */
function skipUrlOf(url) {
  return String(url || '').replace(/\.json(\?[^#]*)?$/i, '.skip.json$1');
}
function nearestCueIndex(cues, t) {
  let lo = 0, hi = cues.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = Number(cues[mid].start) || 0;
    if (s <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}
function localAudioOn() {
  const src = String(audio.currentSrc || audio.src || '');
  const prefer = state.current ? String(preferredAudioUrl(state.current) || '') : '';
  return /^asset:/i.test(src) || /asset\.localhost/i.test(src) || /^asset:/i.test(prefer) || /asset\.localhost/i.test(prefer);
}
function skipEligible() {
  return state.localTranscript === true && localAudioOn() && !!(host() && host().kind === 'tauri');
}
function skipWanted(tag, conf) {
  const lv = Number(prefs.skipLevel) || 0;
  if (!prefs.skipAds || lv <= 0) return false;
  if (tag === 'ad') return conf >= 0.5;
  if (tag === 'promo') return lv >= 2 && conf >= 0.55;
  if (tag === 'filler') return lv >= 3 && conf >= (lv >= 4 ? 0.5 : 0.8);
  return false;
}
function buildSkipPlan(doc) {
  const cues = state.cues || [];
  const tags = new Map();
  for (const raw of (Array.isArray(doc && doc.segments) ? doc.segments : [])) {
    if (!raw || !raw.tag) continue;
    const t = Number(raw.start);
    let idx = Number.isInteger(raw.i) ? raw.i : -1;
    if (!(idx >= 0 && idx < cues.length) || Math.abs((Number(cues[idx].start) || 0) - t) > 1.5) {
      idx = nearestCueIndex(cues, t);
    }
    if (idx >= 0) tags.set(idx, { tag: String(raw.tag), conf: Number(raw.conf) || 0, label: String(raw.label || '') });
  }
  const dur = Number(doc && doc.audio_seconds) || Number(state.audioSeconds) || 0;
  let ranges = (Array.isArray(doc && doc.ranges) ? doc.ranges : [])
    .filter(r => r && Number(r.end) > Number(r.start))
    .map(r => ({
      start: Number(r.start),
      end: Number(r.end),
      tag: String(r.tag || 'ad'),
      conf: Number(r.conf) || 0,
      label: String(r.label || ''),
      id: String(r.id || (String(r.tag || 'ad') + ':' + Math.round(Number(r.start) * 10))),
    }))
    .sort((a, b) => a.start - b.start);
  // 单集最多跳 40%：从置信度最低的区间开始砍，宁可少跳也不吞掉整集。
  let limited = false;
  const budget = dur > 0 ? dur * 0.4 : Infinity;
  const total = () => ranges.reduce((n, r) => n + (r.end - r.start), 0);
  while (ranges.length && total() > budget) {
    let worst = 0;
    for (let i = 1; i < ranges.length; i++) if (ranges[i].conf < ranges[worst].conf) worst = i;
    ranges.splice(worst, 1);
    limited = true;
  }
  return { source: doc ? 'disk' : 'none', tags, ranges, limited, duration: dur };
}
async function loadSkipPlan(show, ep, isLocal) {
  setState('skipPlan', null);
  if (!isLocal || !ep || !ep.transcript || !isJsonTranscript(ep.transcript)) return;
  if (!skipEligible()) return;
  let doc = null;
  const key = offlineKeyFor(show, ep);
  // 优先读本机：只有随文字稿一起落盘的标签，才保证和本地音频是同一版。
  if (host() && typeof host().offlineSkipLoad === 'function') {
    try {
      const text = await host().offlineSkipLoad(key);
      if (text) doc = JSON.parse(text);
    } catch (e) {}
  }
  if (!doc) {
    const url = skipUrlOf(ep.transcript.url);
    if (!url || url === ep.transcript.url) return;
    try { doc = await getJson(url); } catch (e) { return; }
    // 顺手落盘一份：这次联网拿到了，下次断网也能跳过。
    if (host() && typeof host().offlineSkipSave === 'function') {
      host().offlineSkipSave(url, key).catch(() => {});
    }
  }
  if (!doc || !state.current || state.current.id !== ep.id) return;
  if (!skipEligible()) return;
  setState('skipPlan', buildSkipPlan(doc));
}
function findSkipRange(now) {
  const plan = state.skipPlan;
  if (!plan || !plan.ranges.length) return null;
  for (const r of plan.ranges) {
    if (now < r.start || now >= r.end - 0.3) continue;
    if (!skipWanted(r.tag, r.conf)) continue;
    if (state.skipDone.has(r.id) || state.skipMuted.has(r.id)) continue;
    // 进入区间超过 0.5 秒还在这里 = 用户自己拖进来的，本次不再自动跳。
    if (now - r.start > 0.5 || r.end - now < 3) { state.skipMuted.add(r.id); continue; }
    return r;
  }
  return null;
}
function transcriptFailure(err) {
  box.innerHTML = '<div class="empty"><div><b>字幕加载失败</b>' + esc(err.message) +
    '<br><span style="font-size:12px">音频仍可播放。</span></div></div>';
  status('字幕加载失败：' + err.message + '（音频仍可播放）', 'warn');
}
function selectEpisode(item, keepDrawer = false) {
  if (!item) return;
  saveProgress(true);
  setAlignMode(false);
  setState('current', item);
  studyLoop = null; studyAutoPauseDone = -1; studyExercise = null; studyVocabContext = null; studyVocabContextMode = null;
  item.showKey = state.show.slug;
  if (document.body.classList.contains('player-open')) {
    const want = routeHash('player', [state.show.slug, item.id]);
    if (location.hash !== want) history.replaceState(null, '', want);
  }
  try { localStorage.setItem('myt-ep-' + state.show.slug, item.id); } catch (e) {}
  syncReaderTop();
  updateDocumentTitle();
  [...listBox.children].forEach(el => el.classList.toggle('active', el.dataset.ep === item.id));
  const activeEl = [...listBox.children].find(el => el.dataset.ep === item.id);
  if (activeEl) {
    const lr = listBox.getBoundingClientRect(), ar = activeEl.getBoundingClientRect();
    if (ar.top < lr.top || ar.bottom > lr.bottom) listBox.scrollTop += ar.top - lr.top - 6;
  }
  $('epNum').textContent = (state.show.name || '') + (item.num ? ' · #' + item.num : '');
  $('epTitle').textContent = item.title || (state.show.name || '');
  $('dTitle').textContent = item.title || (state.show.name || '');
  $('epMeta').textContent = item.date ? new Date(item.date).toLocaleDateString('zh-CN') : '';
  $('dMeta').textContent = [item.date ? new Date(item.date).toLocaleDateString('zh-CN') : '',
    item.transcript ? '字幕' : '无字幕', state.show.name].filter(Boolean).join(' · ');
  const cover = $('cover');
  const themeCss = getComputedStyle(document.documentElement);
  const tAccent = themeCss.getPropertyValue('--accent').trim() || '#d8b277';
  const tPanel = themeCss.getPropertyValue('--panel2').trim() || '#111111';
  const tBg = themeCss.getPropertyValue('--bg').trim() || '#111111';
  const coverFallback = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="88" height="88"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="' + tPanel + '"/><stop offset="1" stop-color="' + tBg + '"/></linearGradient></defs><rect width="88" height="88" fill="url(#g)"/><circle cx="44" cy="44" r="13" fill="none" stroke="' + tAccent + '" stroke-opacity=".3"/><circle cx="44" cy="44" r="3" fill="' + tAccent + '" fill-opacity=".35"/></svg>');
  cover.onerror = () => { cover.onerror = null; cover.src = coverFallback; };
  if (item.img) { cover.src = item.img; cover.hidden = false; } else { cover.src = coverFallback; cover.hidden = false; }
  const frameCover = $('frameCover');
  frameCover.onerror = () => { frameCover.onerror = null; frameCover.src = coverFallback; };
  frameCover.src = item.img || coverFallback;
  setState('audioRetried', 0);
  const audioUrl = preferredAudioUrl(item);
  loadChapters(item);
  setState('audioUsed', new Set([item.url, audioUrl].filter(Boolean)));
  state.audioToken += 1;
  setState('resumeEp', item.id);
  setState('resumeAt', readProgress(item));
  const showPref = showPrefFor(state.show.slug);
  setState('introSkipped', state.resumeAt > Number(showPref.skipIntro || 0));
  setState('outroSkipped', false);
  setState('adSkipped', new Set());
  setState('adRanges', []);
  setState('aiAdRanges', []);
  setState('regexAdRanges', []);
  setState('localTranscript', false);
  setState('skipPlan', null);
  setState('skipDone', new Set());
  setState('skipMuted', new Set());
  setState('audioKey', progressKey(item));
  setState('progressSavedAt', 0);
  audio.dataset.ep = item.id;
  // 换集：单流模式把播放交给原生元素（下面这段会重设 src），实时识别继续走
  // Range 路径；这里等新一集就绪后会自动再接管一次。
  // 先记下换集前是不是在播：下面 audio.pause() 之后这个状态就没了，等重新接管完
  // 要靠它决定是否接着播（否则换集后音频会停在原地不动，看起来像卡死）。
  const wasPlaying = !audio.paused;
  if (LIVE.mse) liveMseStop();
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  if (audioUrl) { audio.src = audioUrl; audio.load(); }
  if (prefs.skipSilence) ensureAudioGraph();
  applyLoudness(!!prefs.loudness);
  audio.playbackRate = Number(showPref.speed) || prefs.speed || 1;
  // 换集会换掉音频字节与时间轴：上一集的实时结果必须清掉，再按新音频重建。
  if (LIVE.on) { liveClearRows(); liveRebuildStream(); liveFollowCurrentEpisode(wasPlaying); }
  if (app.autoplay) { app.autoplay = false; audio.play().catch(() => {}); }
  setState('audioSeconds', 0); setState('timeScale', 1); setState('seekRaw', 0);
  $('total').textContent = '00:00'; $('now').textContent = '00:00';
  $('seek').value = '0'; $('pfill').style.width = '0%';
  setState('lastNowText', '00:00'); setState('lastAriaText', null); setState('lastSeekBucket', 0);
  box.innerHTML = '<div class="empty">' + loaderHTML('正在加载字幕…') + '</div>';
  setState('cues', []); setState('nodes', []); setState('activeCue', -1); setState('vtt', null); setState('sidecar', null); setState('zhVtt', null);
  setState('base', null); setState('experiment', null); resetImportUI();
  if (state.wallpaper) { wpEpId = String(state.current && state.current.id || ''); wpCueIndex = 0; wpPrevIndex = -1; wpLastKey = ''; wallpaperRefresh(); }
  syncJumpPill();
  syncMini();
  syncBookmarkBtn();
  if (!keepDrawer) closeDrawer();
  const seq = ++state.transcriptSeq;
  if (!subtitlePluginOn()) {
    // 字幕插件未接管：不下载、不解析、不渲染任何文字稿，只保留音频。
    box.innerHTML = '';
    setState('cues', []); setState('nodes', []); setState('activeCue', -1); setState('vtt', null); setState('sidecar', null); setState('zhVtt', null); setState('base', null);
    syncJumpPill(); syncMini(); syncBookmarkBtn();
    return;
  }
  if (!moduleOn('transcript')) {
    box.innerHTML = '<div class="empty">文字稿模块已关闭，可在「设置 → 模块开关」重新开启。</div>';
    setState('cues', []); setState('nodes', []); setState('activeCue', -1); setState('vtt', null); setState('sidecar', null); setState('zhVtt', null); setState('base', null);
    syncJumpPill(); syncMini(); syncBookmarkBtn();
    return;
  }
  if (item.localPath && (!item.transcript || item.transcript.url === 'local-asr')) {
    openLocalTranscript(item, seq);
    return;
  }
  if (!item.transcript) {
    box.innerHTML = '<div class="empty">该集没有字幕，可直接播放音频。</div>';
    status('该集没有字幕，可直接播放音频。', 'warn');
    return;
  }
  status('正在加载字幕…');
  const transcript = item.transcript;
  if (transcript.type === 'application/json' || /\.json(?:$|\?)/i.test(transcript.url)) {
    const showAtLoad = state.show;
    const itemAtLoad = item;
    readTranscriptDoc(showAtLoad, itemAtLoad).then(({ doc, local }) => {
      if (seq !== state.transcriptSeq) return;
      if (!doc) throw new Error(local ? '本机文字稿已损坏，且无法连接网络' : 'JSON 加载失败');
      const built = cuesFromJson(doc);
      if (!built.vtt.length) throw new Error('JSON 中没有可显示的段落');
      applyEpisodeData(built.vtt, built.sidecar, built.zhVtt);
      setState('localTranscript', !!local);
      loadSkipPlan(showAtLoad, itemAtLoad, !!local);
      const words = state.cues.reduce((n, c) => n + c.words.length, 0);
      status((local ? '已从本机离线文字稿加载 ' : '已加载 ') + built.vtt.length + ' 段，' + words.toLocaleString() + ' 个词级时间点。' +
        (reader.lang !== 'en' && !state.zhVtt ? ' 该集暂无中文，已显示英文。' : ''), 'good');
      // 旧版本只下了音频的整集，打开时顺手补下文字稿；失败只影响下次，不打扰阅读。
      if (!local && app.offline && app.offline.get(offlineKeyFor(showAtLoad, itemAtLoad))) {
        saveOfflineTranscript(showAtLoad, itemAtLoad)
          .then(ok => { if (ok) refreshOffline(); })
          .catch(() => {});
      }
    }).catch(err => { if (seq === state.transcriptSeq) transcriptFailure(err); });
    return;
  }
  const vttUrl = sitePath(transcript.url);
  const timingsUrl = state.show.timings ? deriveTimingsUrl(vttUrl) : null;
  Promise.all([
    getText(vttUrl),
    timingsUrl ? getJson(timingsUrl) : Promise.resolve(null),
  ]).then(async ([vttText, sidecar]) => {
    if (seq !== state.transcriptSeq) return;
    if (!vttText) throw new Error('VTT 加载失败');
    const parsed = parseVttSmart(vttText);
    const zhText = parsed.hasCjk ? null : await getText(deriveZhUrl(vttUrl));
    if (seq !== state.transcriptSeq) return;
    let vtt = parsed.primary;
    if (!vtt.length) vtt = vttFromSidecar(sidecar);
    if (!vtt.length) throw new Error('VTT 解析为空');
    const zhVtt = parsed.hasCjk ? parsed.zh : (zhText ? parseZhVTT(zhText) : null);
    applyEpisodeData(vtt, sidecar, zhVtt);
    const aligned = sidecar && Array.isArray(sidecar.segments) && sidecar.segments.length === vtt.length;
    const complete = sidecar?.complete === true;
    if (!sidecar) status('未找到词级时间轴，按句级时间显示。', 'warn');
    else if (!complete) status('该集的修正时间轴尚未完成（' + (sidecar.rejected || '未完成') + '），按句级时间显示。', 'warn');
    else if (!aligned) status('词级时间轴与 VTT 段落数不一致（' + (sidecar.segments?.length || 0) + ' vs ' + vtt.length + '），已按可匹配部分合并。', 'warn');
    else status('已加载 ' + vtt.length + ' 段，' + state.cues.reduce((n, c) => n + c.words.length, 0).toLocaleString() + ' 个词级时间点。' +
      (reader.lang !== 'en' && !zhVtt ? ' 该集暂无中文，已显示英文。' : ''), 'good');
  }).catch(err => { if (seq === state.transcriptSeq) transcriptFailure(err); });
}

/* layer: bridge —— 本地音频插件宿主与预转写
   本片只做该层的事，跨层调用走 kernel / host() / setState。 */
/* ---------- 本地无稿音频：整集预转写 ---------- */
function localAsrAvailable() {
  return host() && host().kind === 'tauri' && tauriHost() && tauriHost().core;
}
function applyLocalDoc(item, doc) {
  const built = cuesFromJson(doc);
  if (!built.vtt.length) throw new Error('预转写结果里没有可显示的段落');
  applyEpisodeData(built.vtt, built.sidecar, built.zhVtt);
  setState('localTranscript', true);
  item.transcript = { type: 'application/json', url: 'local-asr', local: true };
  try {
    const idx = app.local.findIndex(ep => ep.localPath === item.localPath);
    if (idx >= 0) { app.local[idx].transcript = item.transcript; writeJSON(LOCAL_KEY, app.local); }
  } catch (e) {}
  const words = state.cues.reduce((n, c) => n + c.words.length, 0);
  const who = doc && doc.model ? '（' + asrModelName(doc.model) + '）' : '';
  status('已预转写 ' + built.vtt.length + ' 段，' + words.toLocaleString() + ' 个词级时间点' + who + '。', 'good');
}
async function openLocalTranscript(item, seq) {
  if (!localAsrAvailable()) {
    box.innerHTML = '<div class="empty">该集没有字幕，可直接播放音频。</div>';
    return;
  }
  try {
    const raw = await tauriHost().core.invoke('local_transcript_load', { path: item.localPath });
    if (seq !== state.transcriptSeq) return;
    applyLocalDoc(item, JSON.parse(raw));
    return;
  } catch (e) {
    // 没有现成稿子：给个预转写入口
  }
  box.innerHTML = '<div class="empty"><div>这一集还没有文字稿。</div>' +
    '<div class="smalltext" style="margin:8px 0 12px">可以用本机模型「' + esc(asrModelName(localAsrModelId())) + '」整集预转写，跑完就存到音频旁边，下次直接读。</div>' +
    '<button class="btn primary small" data-local-asr="' + esc(item.localPath) + '">整集预转写</button>' +
    '<div id="localAsrBarWrap" style="display:none;height:4px;border-radius:99px;background:var(--hover);margin:12px auto 0;max-width:320px;overflow:hidden">' +
    '<i id="localAsrBar" style="display:block;height:100%;width:0;background:var(--accent);transition:width .25s linear"></i></div>' +
    '<div class="smalltext" id="localAsrMsg" style="margin-top:10px"></div></div>';
  status('这一集还没有文字稿，可整集预转写。', 'warn');
}
function startLocalTranscribe(path) {
  const msg = $('localAsrMsg');
  const btn = document.querySelector('[data-local-asr]');
  const model = localAsrModelId();
  if (btn) { btn.disabled = true; btn.textContent = '正在预转写…'; }
  tauriHost().core.invoke('local_transcribe_start', { path, model }).catch(err => {
    if (msg) msg.textContent = '启动失败：' + (err && err.message ? err.message : err);
    if (btn) { btn.disabled = false; btn.textContent = '整集预转写'; }
    return;
  });
  const timer = setInterval(async () => {
    let st;
    try { st = await tauriHost().core.invoke('local_transcribe_status'); } catch (e) { return; }
    const pct = Math.max(0, Math.min(99, Math.round(Number(st.pct) || 0)));
    const bar = $('localAsrBar');
    const wrap = $('localAsrBarWrap');
    if (st.running && wrap) wrap.style.display = 'block';
    if (bar) bar.style.width = (st.running ? pct : 100) + '%';
    if (msg) {
      if (st.running) {
        const done = fmt(Math.round(Number(st.seconds) || 0));
        const total = Number(st.total) > 0 ? fmt(Math.round(Number(st.total))) : '';
        msg.textContent = (st.phase === 'load' ? '加载模型…' : (st.phase === 'decode' ? '解码中 ' : '识别中 ')) + pct + '%' +
          ' · ' + done + (total ? ' / ' + total : '');
      } else if (st.error) {
        msg.textContent = '失败：' + st.error;
      } else {
        msg.textContent = '转写完成，正在加载…';
      }
    }
    if (st.running) return;
    clearInterval(timer);
    if (st.error) {
      if (btn) { btn.disabled = false; btn.textContent = '重新预转写'; }
      return;
    }
    const item = state.current;
    if (!item || item.localPath !== path) return;
    try {
      const raw = await tauriHost().core.invoke('local_transcript_load', { path });
      applyLocalDoc(item, JSON.parse(raw));
    } catch (e) {
      if (msg) msg.textContent = '已转写但加载失败：' + (e && e.message ? e.message : e);
    }
  }, 1200);
}

/* 单句精听 / 精听刚才：把一小段音频交给本机模型重转，不动整集稿子。
   不依赖官方稿：没有 cue 的时候按当前播放位置截取最近十几秒。 */
function clipPanelHost(el) {
  let panel = el.nextElementSibling;
  if (panel && panel.classList.contains('cue-clip')) return panel;
  panel = document.createElement('div');
  panel.className = 'cue-clip';
  el.insertAdjacentElement('afterend', panel);
  return panel;
}
function clipTargetInfo() {
  const item = state.current;
  if (!item) return null;
  let path = item.localPath || '';
  const offKey = offlineKeyFor(state.show, item);
  if (!path) {
    const off = app.offline.get(offKey);
    if (off && off.path) path = off.path;
  }
  const remoteUrl = path ? '' : (directAudioUrl(item.url) || item.url || '');
  return { item, offKey, path, remoteUrl };
}
async function clipRun(startSec, endSec, panel, btn, onRetry) {
  if (!subtitlePluginOn()) { showToast('字幕插件未启用，精听不可用。', 'warn'); return; }
  const target = clipTargetInfo();
  const note = text => {
    const b = panel.querySelector('.cue-clip-text');
    if (b) { b.classList.add('loading'); b.textContent = text; }
  };
  if (!target) { note('没有正在播放的单集。'); return; }
  if (!target.path && !target.remoteUrl) { note('这条单集没有音频地址，没法精听。'); return; }
  const started = performance.now();
  const startMs = Math.max(0, Math.round(Number(startSec) * 1000));
  const endMs = Math.max(startMs + 1500, Math.round(Number(endSec) * 1000));
  const model = localAsrModelId();
  note(target.remoteUrl ? '正在取这句附近的音频…' : '正在切片…');
  if (btn) btn.disabled = true;
  let doc;
  let unlisten = null;
  try {
    if (target.remoteUrl) {
      // 服务器不支持 Range 时后端会退回整集缓存，这时才有下载进度事件。
      if (tauriHost().event && tauriHost().event.listen) {
        unlisten = await tauriHost().event.listen('myt://offline', e => {
          if (e.payload && e.payload.key === target.offKey) note('正在缓存整集音频 ' + Math.round(Number(e.payload.pct) || 0) + '%…');
        });
      }
      doc = await tauriHost().core.invoke('remote_clip_transcribe', {
        url: target.remoteUrl, key: target.offKey, startMs, endMs, model,
      });
    } else {
      doc = await tauriHost().core.invoke('local_clip_transcribe', {
        path: target.path, startMs, endMs, model,
      });
    }
  } catch (e) {
    const text = panel.querySelector('.cue-clip-text');
    if (text) { text.classList.remove('loading'); text.textContent = '精听失败：' + ((e && e.message) || e); }
    if (btn) btn.disabled = false;
    return;
  } finally {
    if (unlisten) { try { unlisten(); } catch (e) {} }
  }
  if (btn) btn.disabled = false;
  const text = ((doc.segments || []).map(s => s.text).filter(Boolean).join(' ')).trim() || '（这段没有识别出内容）';
  const secs = ((performance.now() - started) / 1000).toFixed(1);
  const box = panel.querySelector('.cue-clip-text');
  if (!box) return;
  box.classList.remove('loading');
  box.textContent = text;
  const old = panel.querySelector('.cue-clip-foot');
  if (old) old.remove();
  const foot = document.createElement('div');
  foot.className = 'cue-clip-foot';
  foot.innerHTML = '<span>' + esc((doc.model || '') + ' · ' + secs + ' s') + '</span>' +
    '<div><button type="button" data-clip-copy>复制</button><button type="button" data-clip-again>再来一次</button></div>';
  panel.append(foot);
  foot.querySelector('[data-clip-copy]').onclick = () => {
    navigator.clipboard.writeText(text).then(() => showToast('已复制这句。')).catch(() => showToast('复制失败。', 'warn'));
  };
  foot.querySelector('[data-clip-again]').onclick = () => { if (typeof onRetry === 'function') onRetry(); };
}
function clipListen(cue, ci, el, btn) {
  const item = state.current;
  if (!item) { showToast('没有正在播放的单集。', 'warn'); return; }
  const panel = clipPanelHost(el);
  panel.innerHTML = '<div class="cue-clip-head"><span>单句精听 · ' + esc(asrModelName(localAsrModelId())) +
    '</span><button type="button" data-clip-close title="关闭">×</button></div>' +
    '<div class="cue-clip-text loading">正在准备音频…</div>';
  panel.querySelector('[data-clip-close]').onclick = () => panel.remove();
  clipRun(
    Math.max(0, Number(cue.start) + state.offset - 1.2),
    Number(cue.end) + state.offset + 1.0,
    panel, btn, () => clipListen(cue, ci, el, btn)
  );
}
function clipNow(span = 15) {
  const item = state.current;
  if (!item) { showToast('没有正在播放的单集。', 'warn'); return; }
  const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
  const now = Number(audio.currentTime) || 0;
  let end = now + (audio.paused ? 0.4 : 1.0);
  if (dur > 0) end = Math.min(dur, end);
  const start = Math.max(0, end - span);
  if (end - start < 1.5) { showToast('先播放几秒，再来精听刚才这一句。', 'warn'); return; }
  const pop = $('clipNowPop');
  pop.hidden = false;
  pop.innerHTML = '<div class="cue-clip-head"><span>精听刚才 · 最近 ' + Math.round(span) + ' 秒 · ' +
    esc(asrModelName(localAsrModelId())) + '</span><button type="button" data-clip-close title="关闭">×</button></div>' +
    '<div class="cue-clip-text loading">正在准备音频…</div>';
  pop.querySelector('[data-clip-close]').onclick = () => { pop.hidden = true; };
  clipRun(start, end, pop, $('clipNowBtn'), () => clipNow(span));
}

function smallArtwork(url) {  try {
    const u = new URL(url);
    if (u.hostname === 'image.simplecastcdn.com') {
      const small = u.href.replace(/\/(\d+)x(\d+)(?=\/)/, '/300x300');
      return small === u.href ? '' : small;
    }
    if (u.hostname.endsWith('.imgix.net') && u.searchParams.has('max-w')) {
      u.searchParams.set('max-w', '300');
      u.searchParams.set('max-h', '300');
      return u.href;
    }
    if (u.hostname.endsWith('mzstatic.com')) {
      const small = u.href.replace(/\/\d+x\d+bb\.(jpg|png)$/i, '/200x200bb.$1');
      return small === u.href ? '' : small;
    }
  } catch (e) {}
  return '';
}
function renderList(filter = '') {
  const q = filter.trim().toLowerCase();
  const items = state.episodes.filter(e => !q || String(e.num).includes(q) || (e.title || '').toLowerCase().includes(q));
  listBox.innerHTML = '';
  $('epCount').textContent = items.length + ' / ' + state.episodes.length;
  if (!items.length) { listBox.innerHTML = '<div class="empty">没有匹配的剧集。</div>'; return; }
  for (const e of items) {
    const el = document.createElement('div');
    el.className = 'ep'; el.dataset.ep = e.id; el.tabIndex = 0;
    el.innerHTML = '<img class="epArt" alt="" hidden loading="lazy" decoding="async" referrerpolicy="no-referrer"><div class="epText"><div class="num"></div><div class="t"></div><div class="d"></div></div><span class="eq"><i></i><i></i><i></i></span>';
    const art = el.querySelector('.epArt');
    const artFallback = () => { const ph = document.createElement('div'); ph.className = 'epArt noart'; art.replaceWith(ph); };
    if (e.img) {
      art.hidden = false;
      const small = smallArtwork(e.img);
      art.onerror = small ? () => { art.onerror = artFallback; art.src = e.img; } : artFallback;
      art.src = small || e.img;
    } else artFallback();
    el.querySelector('.num').textContent = e.num ? '#' + e.num : '';
    el.querySelector('.t').textContent = e.title || '(无标题)';
    el.querySelector('.d').textContent = e.date ? new Date(e.date).toLocaleDateString('zh-CN') : '';
    if (state.current?.id === e.id) el.classList.add('active');
    el.addEventListener('click', () => selectEpisode(e));
    el.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectEpisode(e); } });
    listBox.append(el);
  }
}

async function loadShow(slug, episodeId) {
  saveProgress(true);
  const show = state.shows.find(s => s.slug === slug || s.key === slug) || state.shows[0];
  if (!show) return;
  let savedEpisode = '';
  try { savedEpisode = localStorage.getItem('myt-ep-' + show.slug) || ''; } catch (e) {}
  const catalogEps = show.builtin && !hasFreshFeed(show.slug) ? catalogLatest(show) : [];
  const wanted = episodeId || savedEpisode;
  // 本地文件没有 feed，不能走下面的“等 feed”分支，直接按 app.local 建列表。
  if (show.local) {
    const seq = ++state.loadSeq;
    setState('show', show);
    app.lastShowKey = show.slug;
    try { localStorage.setItem('myt-show', show.slug); } catch (e) {}
    $('showSel').value = show.slug;
    syncReaderTop();
    $('epCount').textContent = '';
    $('epTitle').textContent = show.name;
    $('epNum').textContent = show.name;
    $('epMeta').textContent = '';
    setState('episodes', episodesOf(show));
    setState('current', null);
    renderList();
    const target = state.episodes.find(ep => ep.id === wanted) || state.episodes[0];
    if (target) selectEpisode(target, true);
    return;
  }
  const fastTarget = catalogEps.find(ep => ep.id === wanted);
  if (catalogEps.length && (!wanted || fastTarget)) {
    const seq = ++state.loadSeq;
    setState('show', show);
    app.lastShowKey = show.slug;
    try { localStorage.setItem('myt-show', show.slug); } catch (e) {}
    $('showSel').value = show.slug;
    syncReaderTop();
    $('epCount').textContent = '';
    $('epTitle').textContent = show.name;
    $('epNum').textContent = show.name;
    $('epMeta').textContent = '';
    setState('episodes', catalogEps.map(ep => ({ ...ep, showKey: show.slug })));
    setState('current', null);
    renderList();
    const first = fastTarget || state.episodes[0];
    if (first) selectEpisode(first, true);
    ensureShowFeed(show).then(feed => {
      if (state.loadSeq !== seq || state.show?.slug !== show.slug) return;
      setState('episodes', feed.episodes);
      renderList();
    }).catch(err => {
      if (state.show?.slug === show.slug) {
        status('完整单集列表加载失败：' + err.message + '（当前单集仍可播放）', 'warn');
      }
    });
    return;
  }
  const seq = ++state.loadSeq;
  setState('show', show);
  app.lastShowKey = show.slug;
  try { localStorage.setItem('myt-show', show.slug); } catch (e) {}
  $('showSel').value = show.slug;
  syncReaderTop();
  $('epCount').textContent = '';
  $('epTitle').textContent = show.name;
  $('epNum').textContent = show.name;
  $('epMeta').textContent = '';
  listBox.innerHTML = '<div class="empty">' + loaderHTML('正在读取 feed…') + '</div>';
  setState('episodes', []); setState('current', null);
  if (!show.feed) {
    renderList();
    box.innerHTML = '<div class="empty">该节目暂时没有已发布的增强 Feed。</div>';
    status('该节目暂时没有已发布 Feed。', 'warn');
    return;
  }
  try {
    let feed = memoryFeed(show);
    if (!feed) {
      const xml = await fetchFeedText(show.feed);
      if (seq !== state.loadSeq) return;
      if (!xml) throw new Error('feed 加载失败');
      feed = parseFeed(xml);
      rememberFeed(show.slug, feed);
      if (!show.builtin && feed.title) show.name = cleanFeedTitle(feed.title);
      if (feed.artwork && !show.artwork) show.artwork = feed.artwork;
      if (feed.description && !show.description) show.description = feed.description;
    }
    setState('episodes', feed.episodes);
    renderList();
    let saved = null;
    try { saved = localStorage.getItem('myt-ep-' + show.slug); } catch (e) {}
    const first = (episodeId && state.episodes.find(e => e.id === episodeId))
      || (saved && state.episodes.find(e => e.id === saved))
      || state.episodes[0];
    if (first) selectEpisode(first, true);
    else {
      box.innerHTML = '<div class="empty">该节目还没有剧集。</div>';
      status('该节目还没有剧集。', 'warn');
    }
  } catch (err) {
    if (seq !== state.loadSeq) return;
    setState('episodes', []);
    renderList();
    box.innerHTML = '<div class="empty"><b>读取 feed 失败</b>' + esc(err.message) + '</div>';
    status('读取 feed 失败：' + err.message, 'warn');
  }
}

const SHELL_TIMEOUT = 8000, CATALOG_TIMEOUT = 12000;
/* ================== 插件运行时 ==================
   插件是本地目录里的 JS/CSS，拥有完整页面与网络权限（用户明确选择这一档）。
   这里只提供注册页面、事件、快捷播放器操作和一个命名空间存储，不做沙箱。 */
const PLUGIN_REGISTRY = new Map();
const PLUGIN_PAGES = new Map();
const PLUGIN_HOOKS = new Map();
const PLUGIN_COMMANDS = new Map();
/* 每个插件注册出去的东西都记账：停用/重载时按插件回收，不靠刷新整页。 */
const PLUGIN_CLEANUP = new Map();
function trackPlugin(id, fn) {
  const key = String(id);
  if (!PLUGIN_CLEANUP.has(key)) PLUGIN_CLEANUP.set(key, new Set());
  PLUGIN_CLEANUP.get(key).add(fn);
  return fn;
}
function runPluginCleanup(id) {
  const set = PLUGIN_CLEANUP.get(String(id));
  if (!set) return;
  [...set].reverse().forEach(fn => { try { fn(); } catch (err) { console.warn('[plugin cleanup]', err); } });
  set.clear();
}
let pluginApiReady = false;

/* 插件宿主：能力图 + 依赖解析 + 内核注册 + 生命周期。字幕/学习等功能不再由主程序写死开关，
   而是插件通过 claim(capability) 登记，主程序只按能力是否被接管来装配界面。 */
const PluginHost = {
  kernels: new Map(),
  can(name) { return !!app.capabilities[name]; },
  owner(name) { return app.capabilities[name] || ''; },
  claim(pluginId, name) {
    const id = String(pluginId), cap = String(name);
    const current = app.capabilities[cap];
    if (current && current !== id) throw new Error('能力 ' + cap + ' 已由插件 ' + current + ' 接管');
    app.capabilities[cap] = id;
    // 兼容旧调用点，owner 字段仍是单一真相的投影，不参与判断。
    if (cap === 'subtitles') { app.subtitleOwner = id; document.body.dataset.subtitlePlugin = id; }
    if (cap === 'study') { app.studyOwner = id; document.body.dataset.studyPlugin = id; }
    PluginHost.applyLayout();
    return true;
  },
  available(id, list = app.plugins, stack = new Set()) {
    const key = String(id);
    const plugin = (list || []).find(p => p && p.id === key);
    if (!plugin || !plugin.enabled) return false;
    // 依赖环直接判不满足（历史实现返回 true，会把 A→B→A 当合法配置）。
    if (stack.has(key)) return false;
    const path = new Set(stack);
    path.add(key);
    return (Array.isArray(plugin.requires) ? plugin.requires : [])
      .every(req => PluginHost.available(req, list, new Set(path)));
  },
  missingRequires(plugin, list) {
    return (Array.isArray(plugin?.requires) ? plugin.requires : []).filter(req => !PluginHost.available(req, list));
  },
  status(id) {
    const plugin = (app.plugins || []).find(p => p.id === id);
    if (!plugin) return { id, state: 'missing' };
    const missing = PluginHost.missingRequires(plugin, app.plugins);
    const error = app.pluginErrors.get(id) || '';
    if (!plugin.enabled) return { id, state: 'disabled', missing, error };
    if (missing.length) return { id, state: 'blocked', missing, error };
    if (error) return { id, state: 'error', missing, error };
    return { id, state: definitionStarted(id) ? 'active' : 'ready', missing, error };
  },
  registerKernel(name, impl) {
    if (!name || !impl) throw new Error('registerKernel 需要名称和实现');
    PluginHost.kernels.set(String(name), impl);
    return true;
  },
  kernel(name) { return PluginHost.kernels.get(String(name)) || null; },
  applyLayout() {
    const sig = Object.keys(app.capabilities).sort().map(k => k + '=' + app.capabilities[k]).join('|');
    if (PluginHost.__layoutReady && sig === PluginHost.__layoutSig) return;
    PluginHost.__layoutSig = sig;
    PluginHost.__layoutReady = true;
    applySubtitleAvailability();
    applyStudyAvailability();
  },
};
function definitionStarted(id) {
  return !!(PLUGIN_REGISTRY.get(String(id) || '')?.__started);
}

/* 字幕功能由插件接管：插件调用 api.subtitles.claim() 后才点亮字幕链路。
   没有插件时主程序只保留音频、节目信息和播放控制，不下载文字稿。 */
function subtitlePluginOn() { return PluginHost.can('subtitles'); }
function syncSubtitleSettingsVisibility() {
  const off = !subtitlePluginOn();
  ['transcript', 'liveAsr', 'translate', 'floatWindow', 'exportShare', 'study'].forEach(name => {
    const btn = document.querySelector('[data-module="' + name + '"]');
    const row = btn && btn.closest('.setting-row');
    if (row) row.classList.toggle('subs-off-hide', off);
  });
}
function applySubtitleAvailability() {
  const on = subtitlePluginOn();
  document.body.classList.toggle('subs-off', !on);
  syncSubtitleSettingsVisibility();
  if (on) return;
  if (LIVE.on) liveDisable('字幕插件未启用，实时识别已停止。');
  setState('cues', []); setState('nodes', []); setState('activeCue', -1); setState('wordIdx', -1);
  setState('vtt', null); setState('sidecar', null); setState('zhVtt', null); setState('base', null);
  box.innerHTML = '';
  syncMiniCaption();
  syncJumpPill();
}

/* 学英语是独立插件：它只负责学习侧（句子卡、整集总结、复习、生词本、词卡）。
   字幕插件关掉时没有 cue 可用，学习插件即使启用也不生效。 */
function studyPluginOn() { return PluginHost.can('study') && PluginHost.can('subtitles'); }
function syncStudySettingsVisibility() {
  const off = !studyPluginOn();
  const btn = document.querySelector('[data-module="study"]');
  const row = btn && btn.closest('.setting-row');
  if (row) row.classList.toggle('study-off-hide', off);
}
function applyStudyAvailability() {
  const on = studyPluginOn();
  document.body.classList.toggle('study-off', !on);
  syncStudySettingsVisibility();
  if (on) return;
  const sheet = $('studySheet');
  if (sheet && sheet.classList.contains('on')) closeStudySheet();
  const word = $('wordPanel');
  if (word && word.classList.contains('on')) closeWordPanel();
}
function pluginReportError(id, err) {
  const msg = err && (err.stack || err.message) ? (err.stack || err.message) : String(err);
  app.pluginErrors = app.pluginErrors || new Map();
  app.pluginErrors.set(id, msg);
  console.warn('[plugin ' + id + ']', err);
}
function registerPluginPage(pluginId, pageId, opts) {
  if (!pluginId || !pageId) throw new Error('页面需要 pluginId 和 pageId');
  const key = pluginPageKey(pluginId, pageId);
  const rec = {
    pluginId, pageId,
    title: String(opts?.title || pageId),
    subtitle: String(opts?.subtitle || ''),
    render: typeof opts?.render === 'function' ? opts.render : null,
    destroy: typeof opts?.destroy === 'function' ? opts.destroy : null,
  };
  PLUGIN_PAGES.set(key, rec);
  trackPlugin(pluginId, () => {
    PLUGIN_PAGES.delete(key);
    if (app.pluginPageActive === rec) app.pluginPageActive = null;
    renderPluginNav();
  });
  renderPluginNav();
}
function renderPluginNav() {
  const nav = $('pluginNav');
  const label = $('pluginNavLabel');
  if (!nav) return;
  const pages = [...PLUGIN_PAGES.values()];
  nav.innerHTML = pages.map(page => '<button data-plugin-page="' + esc(pluginPageKey(page.pluginId, page.pageId)) +
    '"><span class="nav-ico">◇</span>' + esc(page.title) + '</button>').join('');
  const has = pages.length > 0;
  nav.hidden = !has;
  nav.style.display = has ? '' : 'none';
  if (label) { label.hidden = !has; label.style.display = has ? '' : 'none'; }
}
function addPluginListener(pluginId, event, fn) {
  if (typeof fn !== 'function') throw new Error('事件回调必须是函数');
  if (!PLUGIN_HOOKS.has(event)) PLUGIN_HOOKS.set(event, new Set());
  const rec = { pluginId, fn };
  PLUGIN_HOOKS.get(event).add(rec);
  const off = () => { PLUGIN_HOOKS.get(event)?.delete(rec); };
  trackPlugin(pluginId, off);
  return off;
}
function emitPlugin(event, payload) {
  const set = PLUGIN_HOOKS.get(event);
  if (!set || !set.size) return;
  set.forEach(rec => {
    try { rec.fn(payload); }
    catch (err) { pluginReportError(rec.pluginId, err); }
  });
}
function pluginPlayerState() {
  const item = state.current;
  return {
    showKey: state.show?.slug || '',
    showName: state.show?.name || '',
    episodeId: item?.id || '',
    title: item?.title || '',
    time: Number(audio.currentTime) || 0,
    duration: Number.isFinite(audio.duration) ? audio.duration : 0,
    paused: audio.paused,
    rate: audio.playbackRate,
    cueIndex: state.activeCue,
  };
}
const PLUGIN_API_VERSION = '2.0';
/* 兼容只谈主版本：插件写 2.x 都认，3.x 直接拒绝；空值视为不声明，按当前版本跑。 */
function pluginApiCompatible(version) {
  const want = String(version || '');
  return !want || want.split('.')[0] === PLUGIN_API_VERSION.split('.')[0];
}
let pluginHostFacadeCache = null;
/* 对外只给能力查询与内核注册，不把 PluginHost 的内部表（kernels / 能力映射）交出去。 */
function pluginHostFacade() {
  if (!pluginHostFacadeCache) {
    pluginHostFacadeCache = Object.freeze({
      can: name => PluginHost.can(name),
      owner: name => PluginHost.owner(name),
      status: id => PluginHost.status(id),
      available: id => PluginHost.available(id),
      registerKernel: (name, impl) => PluginHost.registerKernel(name, impl),
    });
  }
  return pluginHostFacadeCache;
}
/* 插件拿到的字幕是一份只读快照：改它不会影响宿主状态。 */
function cuesSnapshot() {
  return Object.freeze(state.cues.map(cue => Object.freeze({
    ...cue,
    words: Array.isArray(cue.words)
      ? Object.freeze(cue.words.map(word => (Array.isArray(word) ? Object.freeze([...word])
        : (word && typeof word === 'object' ? Object.freeze({ ...word }) : word))))
      : cue.words,
  })));
}
function releasePluginCapabilities(id) {
  const key = String(id);
  Object.keys(app.capabilities || {}).forEach(cap => {
    if (app.capabilities[cap] !== key) return;
    app.capabilities[cap] = '';
    if (cap === 'subtitles') { app.subtitleOwner = ''; delete document.body.dataset.subtitlePlugin; }
    if (cap === 'study') { app.studyOwner = ''; delete document.body.dataset.studyPlugin; }
  });
  PluginHost.applyLayout();
}
function stopPlugin(id) {
  const key = String(id);
  const def = PLUGIN_REGISTRY.get(key);
  if (def && typeof def.__dispose === 'function') {
    try { def.__dispose(); } catch (err) { pluginReportError(key, err); }
    def.__dispose = null;
  }
  runPluginCleanup(key);
  releasePluginCapabilities(key);
  if (def) def.__started = false;
}
function pluginApiFor(id) {
  const storagePrefix = 'myt-plugin:' + id + ':';
  return {
    id,
    version: PLUGIN_API_VERSION,
    apiVersion: PLUGIN_API_VERSION,
    host: pluginHostFacade(),
    toast: (message, type) => showToast(String(message || ''), type === 'warn' ? 5000 : 3000),
    navigate: (page, args = [], params = {}) => navigate(page, args, params),
    openEpisode: (showKey, episodeId) => playEpisode(showKey, episodeId),
    el: elementId => $(elementId),
    page: (pageId, opts) => registerPluginPage(id, pageId, opts),
    on: (event, fn) => addPluginListener(id, event, fn),
    command: (name, fn) => {
      const key = id + ':' + name;
      PLUGIN_COMMANDS.set(key, fn);
      trackPlugin(id, () => PLUGIN_COMMANDS.delete(key));
    },
    cues: () => cuesSnapshot(),
    player: {
      state: pluginPlayerState,
      play: () => audio.play().catch(() => {}),
      pause: () => audio.pause(),
      toggle: () => (audio.paused ? audio.play().catch(() => {}) : audio.pause()),
      seek: seconds => seekTo(Math.max(0, Number(seconds) || 0)),
      seekBy: delta => seekBy(Number(delta) || 0),
      setRate: rate => { audio.playbackRate = Math.max(0.5, Math.min(3, Number(rate) || 1)); },
    },
    subtitles: {
      claim: () => PluginHost.claim(id, 'subtitles'),
      active: () => PluginHost.owner('subtitles') === id,
      status: () => ({
        owner: app.subtitleOwner,
        cues: state.cues.length,
        words: state.cues.reduce((n, cue) => n + ((cue.words || []).length), 0),
        lang: reader.lang,
        mode: state.mode,
        live: !!LIVE.on,
        wallpaper: !!state.wallpaper,
        episode: pluginPlayerState(),
      }),
      setLang: lang => {
        if (!['en', 'zh', 'both'].includes(String(lang))) return false;
        reader.lang = String(lang);
        applyReader();
        rebuildCues();
        return true;
      },
      openSettings: () => {
        navigate('settings');
        setTimeout(() => openSettingsPane('reader'), 0);
      },
      toggleLive: async () => {
        if (LIVE.on) liveDisable('已停止实时识别。');
        else await liveEnable();
        return !!LIVE.on;
      },
      clipNow: span => clipNow(Number(span) || 15),
      exportSubtitle: kind => exportSubtitle(kind || 'txt'),
    },
    study: {
      claim: () => PluginHost.claim(id, 'study'),
      active: () => PluginHost.owner('study') === id,
      status: () => ({
        owner: app.studyOwner,
        subtitles: subtitlePluginOn(),
        vocab: studyVocab.length,
        due: studyDueItems().length,
        cache: Object.keys(studyCache).length,
        provider: STUDY.provider,
        configured: !!(STUDY.key && STUDY.model),
        view: studyView,
        episode: pluginPlayerState(),
      }),
      open: view => openStudySheet(view),
      close: () => closeStudySheet(),
      openEpisode: (showKey, episodeId) => studyOpenEpisodeSummary(showKey, episodeId),
      openSettings: () => {
        navigate('settings');
        setTimeout(() => openSettingsPane('study'), 0);
      },
    },
    storage: {
      get: (key, fallback = null) => readJSON(storagePrefix + key, fallback),
      set: (key, value) => writeJSON(storagePrefix + key, value),
      remove: key => { try { localStorage.removeItem(storagePrefix + key); } catch (e) {} },
    },
  };
}
function ensurePluginApi() {
  if (pluginApiReady) return;
  pluginApiReady = true;
  window.MyTPlugins = {
    version: PLUGIN_API_VERSION,
    apiVersion: PLUGIN_API_VERSION,
    host: pluginHostFacade(),
    register(id, definition) {
      if (!id || !definition || typeof definition.setup !== 'function') {
        throw new Error('MyTPlugins.register 需要 id 和 setup(api)');
      }
      const want = definition.apiVersion ? String(definition.apiVersion) : '';
      if (!pluginApiCompatible(want)) {
        throw new Error('插件要求 API ' + want + '，宿主只支持 ' + PLUGIN_API_VERSION);
      }
      PLUGIN_REGISTRY.set(String(id), definition);
    },
    start(id) {
      const key = String(id);
      const definition = PLUGIN_REGISTRY.get(key);
      if (!definition) throw new Error('插件没有调用 MyTPlugins.register(' + id + ')');
      if (definition.__started) return;
      definition.__started = true;
      try {
        const ret = definition.setup(pluginApiFor(key));
        if (typeof ret === 'function') definition.__dispose = ret;
      } catch (err) {
        definition.__started = false;
        throw err;
      }
    },
    stop(id) { stopPlugin(id); },
    _error(id, err) { pluginReportError(id, err); },
    runCommand(pluginId, name) {
      const fn = PLUGIN_COMMANDS.get(String(pluginId) + ':' + String(name));
      if (typeof fn === 'function') return fn();
      return undefined;
    },
  };
}
const PLUGIN_CONSENT_PREFIX = 'myt-plugin-consent:';
/* 开了 CSP 之后，Tauri 会给页面注入 nonce；带 nonce 的 CSP 会让 'unsafe-inline' 失效。
   插件的脚本和样式都是运行时建的，必须自带同一个 nonce，否则整段被拦。 */
function cspNonceValue() {
  const el = document.querySelector('script[nonce], style[nonce]');
  if (!el) return '';
  return el.nonce || el.getAttribute('nonce') || '';
}
function applyCspNonce(el) {
  const nonce = cspNonceValue();
  if (nonce) el.setAttribute('nonce', nonce);
}
function pluginConsentState(id) {
  try { return localStorage.getItem(PLUGIN_CONSENT_PREFIX + id) || ''; } catch (e) { return ''; }
}
function setPluginConsent(id, allow) {
  try { localStorage.setItem(PLUGIN_CONSENT_PREFIX + id, allow ? 'allow' : 'deny'); } catch (e) {}
}
function clearPluginConsent(id) {
  try { localStorage.removeItem(PLUGIN_CONSENT_PREFIX + id); } catch (e) {}
}
/* 第三方插件在同一个 WebView 里跑，与页面同权：首次启用必须显式授权。
   用页面内弹层而不是 window.confirm —— wry 默认不实现 JS 对话框。 */
function askPluginConsent(plugin) {
  return new Promise(resolve => {
    const name = String(plugin.name || plugin.id || '');
    const wrap = document.createElement('div');
    wrap.dataset.pluginConsent = '1';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;' +
      'justify-content:center;background:rgba(8,10,16,.55);backdrop-filter:blur(2px);';
    wrap.innerHTML =
      '<div role="dialog" aria-modal="true" aria-labelledby="pluginConsentTitle" ' +
      'style="width:min(520px,calc(100vw - 48px));background:var(--panel,#111826);color:var(--ink,#f2eadb);' +
      'border:1px solid var(--line,#343b4a);border-radius:16px;padding:22px 24px;box-shadow:0 30px 80px -30px #000;' +
      'font:14px/1.7 var(--sans,system-ui);">' +
      '<h3 id="pluginConsentTitle" style="margin:0 0 10px;font-size:17px;">允许「' + esc(name) + '」运行？</h3>' +
      '<p style="margin:0 0 12px;color:var(--soft,#ccbfa9);">这个插件不是随应用内置的。启用后它将获得页面与网络的完整权限：</p>' +
      '<ul style="margin:0 0 16px;padding-left:18px;color:var(--soft,#ccbfa9);">' +
      '<li>读取页面上显示的内容（节目、字幕、学习数据）</li>' +
      '<li>发起任意网络请求、加载远程脚本</li>' +
      '<li>调用桌面壳暴露的能力</li></ul>' +
      '<div style="display:flex;gap:10px;justify-content:flex-end;">' +
      '<button type="button" data-consent="deny" style="padding:8px 16px;border-radius:10px;border:1px solid var(--line,#343b4a);' +
      'background:transparent;color:inherit;cursor:pointer;">取消</button>' +
      '<button type="button" data-consent="allow" style="padding:8px 16px;border-radius:10px;border:0;' +
      'background:var(--accent,#e0bd92);color:var(--accentText,#141008);cursor:pointer;font-weight:600;">允许</button>' +
      '</div></div>';
    const done = allow => { wrap.remove(); resolve(allow); };
    wrap.addEventListener('click', event => {
      const btn = event.target.closest('[data-consent]');
      if (btn) done(btn.dataset.consent === 'allow');
      else if (event.target === wrap) done(false);
    });
    document.addEventListener('keydown', function onKey(event) {
      if (!wrap.isConnected) { document.removeEventListener('keydown', onKey); return; }
      if (event.key === 'Escape') { document.removeEventListener('keydown', onKey); done(false); }
    });
    document.body.append(wrap);
  });
}
async function loadPlugins() {
  ensurePluginApi();
  if (!host() || typeof host().pluginList !== 'function') return;
  let list = [];
  try {
    list = await host().pluginList();
  } catch (err) {
    app.plugins = [];
    app.pluginLoadError = err && err.message ? err.message : String(err);
    return;
  }
  app.plugins = Array.isArray(list) ? list : [];
  app.pluginErrors = new Map();
  const seenIds = new Set();
  for (const plugin of app.plugins) {
    if (!plugin || !plugin.enabled) continue;
    if (plugin.error) { pluginReportError(plugin.id, plugin.error); continue; }
    const id = String(plugin.id || '');
    if (!id) continue;
    if (seenIds.has(id)) { pluginReportError(id, '插件 id 重复，只加载第一个：' + id); continue; }
    seenIds.add(id);
    if (!plugin.builtin) {
      const consent = pluginConsentState(id);
      if (consent === 'deny') { pluginReportError(id, '未授权：已跳过该插件'); continue; }
      if (consent !== 'allow') {
        if (!(await askPluginConsent(plugin))) {
          setPluginConsent(id, false);
          pluginReportError(id, '未授权：已跳过该插件');
          continue;
        }
        setPluginConsent(id, true);
      }
    }
    if (plugin.apiVersion && !pluginApiCompatible(plugin.apiVersion)) {
      pluginReportError(id, '插件要求 API ' + plugin.apiVersion + '，宿主只支持 ' + PLUGIN_API_VERSION);
      continue;
    }
    const missing = PluginHost.missingRequires(plugin, app.plugins);
    if (missing.length) {
      pluginReportError(id, '需要先启用插件：' + missing.join('、'));
      continue;
    }
    if (plugin.css) {
      const style = document.createElement('style');
      style.dataset.pluginCss = id;
      applyCspNonce(style);
      style.textContent = plugin.css;
      document.head.append(style);
      trackPlugin(id, () => style.remove());
    }
    if (!plugin.js) { pluginReportError(id, '入口 JS 为空，检查 plugin.json 的 main 字段'); continue; }
    const script = document.createElement('script');
    script.dataset.plugin = id;
    const code = '(function(){try{\n' + plugin.js + '\n}catch(e){MyTPlugins._error(' +
      JSON.stringify(id) + ', e);}})();';
    // CSP 生效后，运行时拼出来的内联脚本拿不到宿主 nonce 就会被拦；改走 blob: URL，
    // 这样脚本是「外部源」而不是内联块，只要 script-src 放行 blob: 就能跑。
    let blobUrl = '';
    try {
      blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      script.src = blobUrl;
    } catch (e) {
      script.textContent = code;
      applyCspNonce(script);
    }
    document.body.append(script);
    // blob 脚本是异步执行的：等它跑完（插件在顶层调 register）再 start。
    await new Promise(resolve => {
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 3000);
    });
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      script.remove();
    } else {
      script.remove();
    }
    try {
      window.MyTPlugins.start(id);
      app.pluginStartedIds = app.pluginStartedIds || [];
      app.pluginStartedIds.push(id);
    }
    catch (err) { pluginReportError(id, err); }
  }
}
/* 软重载：按插件回收注册物后重新加载，不刷新整页。 */
async function reloadPlugins() {
  (app.pluginStartedIds || []).forEach(id => stopPlugin(id));
  app.pluginStartedIds = [];
  app.pluginErrors = new Map();
  await loadPlugins();
  renderPluginNav();
  if (typeof applyStudyAvailability === 'function') applyStudyAvailability();
}
function renderPluginPage(pluginId, pageId) {
  const body = $('pluginPageBody');
  if (!body) return;
  const def = PLUGIN_PAGES.get(pluginPageKey(pluginId, pageId));
  if (!def) {
    body.innerHTML = '<div class="empty">插件页面不存在：' + esc(pluginId + '/' + pageId) + '</div>';
    return;
  }
  if (app.pluginPageActive && app.pluginPageActive !== def && typeof app.pluginPageActive.destroy === 'function') {
    try { app.pluginPageActive.destroy(); } catch (err) { pluginReportError(app.pluginPageActive.pluginId, err); }
  }
  app.pluginPageActive = def;
  $('pluginPageTitle').textContent = def.title;
  $('pluginPageSub').textContent = def.subtitle || ('来自插件 ' + def.pluginId);
  const crumb = $('crumbName');
  if (crumb) crumb.textContent = def.title;
  document.title = def.title + ' · MyTranscript';
  body.innerHTML = '';
  if (def.render) {
    try {
      const ret = def.render(body, pluginApiFor(def.pluginId));
      if (ret && typeof ret.catch === 'function') ret.catch(err => pluginReportError(def.pluginId, err));
    } catch (err) {
      pluginReportError(def.pluginId, err);
      body.innerHTML = '<div class="empty">插件页面出错：' + esc(err.message || err) + '</div>';
    }
  }
}
async function refreshPluginSettings() {
  const box = $('pluginList');
  const status = $('pluginStatus');
  if (!box) return;
  if (!host() || typeof host().pluginList !== 'function') {
    box.innerHTML = emptyLine('插件只在桌面版可用。');
    if (status) status.textContent = '网页版没有本地插件目录权限。';
    return;
  }
  box.innerHTML = '<div class="smalltext">正在读取插件目录…</div>';
  try {
    const list = await host().pluginList();
    app.plugins = Array.isArray(list) ? list : [];
    if (!app.plugins.length) {
      box.innerHTML = emptyLine('还没有插件。点「生成示例插件」，或把插件目录放进 plugins 文件夹。');
      if (status) status.textContent = '插件目录：C:\\ProgramData\\MyTranscript\\plugins';
      return;
    }
    box.innerHTML = app.plugins.map(plugin => {
      const err = plugin.error || (app.pluginErrors && app.pluginErrors.get(plugin.id)) || '';
      const missing = PluginHost.missingRequires(plugin, app.plugins);
      const dep = missing.length ? '需要先启用：' + missing.join('、') : '';
      const consent = plugin.builtin ? ''
        : (pluginConsentState(plugin.id) === 'allow' ? '已授权运行'
          : (pluginConsentState(plugin.id) === 'deny' ? '已拒绝运行' : '待授权，下次加载时会询问'));
      const revoke = plugin.builtin ? ''
        : '<button data-plugin-revoke="' + esc(plugin.id) +
          '" style="margin-left:8px;border:0;background:none;padding:0;cursor:pointer;' +
          'font:11px/1 var(--sans);color:var(--muted);text-decoration:underline">撤销授权</button>';
      return '<div class="ep-row"><div class="ep-body"><span class="ep-title">' + esc(plugin.name || plugin.id) +
        ' <span class="pill dim">' + esc(plugin.id) + '</span></span><span class="ep-sub">' +
        esc([plugin.version ? 'v' + plugin.version : '', plugin.author, plugin.description].filter(Boolean).join(' · ') || '无描述') +
        (consent ? '<br><span class="pill dim">' + esc(consent) + '</span> ' + revoke : '') +
        (dep ? '<br><span style="color:#e08a7a">' + esc(dep) + '</span>' : '') +
        (err && !dep ? '<br><span style="color:#e08a7a">' + esc(err) + '</span>' : '') + '</span></div>' +
        '<button class="switch" role="switch" aria-checked="' + (plugin.enabled ? 'true' : 'false') +
        '" data-plugin-toggle="' + esc(plugin.id) + '" title="' + (plugin.enabled ? '停用' : '启用') + '"></button></div>';
    }).join('');
    if (status) status.textContent = '共 ' + app.plugins.length + ' 个插件，' +
      app.plugins.filter(p => p.enabled).length + ' 个已启用；改完状态后点「重新加载」生效。';
  } catch (err) {
    box.innerHTML = emptyLine('读取插件失败：' + esc(err.message || err));
  }
}

async function initPlayer() {
  const params = new URLSearchParams(location.search);
  try {
    const data = await getJson('shows.json', SHELL_TIMEOUT);
    if (!Array.isArray(data) || !data.length) throw new Error('shows.json 格式错误');
    app.builtinShows = data.map((s, index) => ({
      ...s, builtin: true, key: s.slug, artwork: s.artwork || '',
      description: s.description || '', latest: [], episode_count: 0, transcript_count: 0,
      latest_transcript_count: 0, latest_published_at: '', language: '', categories: [], order: index,
    }));
  } catch (err) {
    app.builtinShows = [];
    listBox.innerHTML = '<div class="empty"><b>读取节目清单失败</b>' + esc(err.message) + '</div>';
    status('读取节目清单失败：' + err.message, 'warn');
  }
  loadLocalState();
  refreshShows();
  // 插件要在壳绑定之前就完成 claim：字幕插件决定了是否装配字幕链路。
  await loadPlugins();
  applySubtitleAvailability();
  applyStudyAvailability();
  bindShell();
  bindLedgerUI();
  const legacy = params.get('show');
  if (legacy) navigate('player', [legacy, params.get('ep') || '']);
  else if (!location.hash) navigate('home');
  applyRoute();
  bindModuleSwitches();
  bindStudyUI();
  applyModules();
  startAutoRefresh();
  // 目录体积较大，后台加载；外壳、路由和交互先可用。
  app.catalogPromise = loadCatalog().then(ready => {
    app.catalogPending = false;
    if (!ready) { app.catalogFailed = true; refreshCatalogPages(); return; }
    mergeCatalog();
    refreshShows();
    refreshCatalogPages();
  });
}
function refreshCatalogPages() {
  if (document.body.classList.contains('player-open')) return;
  const route = app.route || parseRoute();
  if (route.page === 'search') {
    renderPage('search', { ...route, args: [$('searchInput')?.value || route.args[0] || ''] });
    return;
  }
  if (['home', 'discover', 'library'].includes(route.page)) renderPage(route.page, route);
}

/* layer: view —— transport、进度、文字稿交互、章节、离线与模型管理
   本片只做该层的事，跨层调用走 kernel / host() / setState。 */
/* transport */
$('play').onclick = () => {
  if (!state.current) { openDrawer(); return; }
  if (!audio.getAttribute('src')) { status('该集没有音频地址。', 'warn'); showToast('该集没有音频地址。'); return; }
  audio.paused
    ? audio.play().catch(e => { status('播放失败：' + e.message, 'warn'); showToast('播放失败：' + e.message); })
    : audio.pause();
};
audio.addEventListener('play', () => { $('play').classList.add('playing'); $('play').setAttribute('aria-label','暂停'); document.body.classList.add('playing'); syncWallpaperPlay(); });
audio.addEventListener('pause', () => { $('play').classList.remove('playing'); $('play').setAttribute('aria-label','播放'); document.body.classList.remove('playing'); saveProgress(true); syncWallpaperPlay(); });
let buffering = false;
function setBuffering(on) {
  if (buffering === on) return;
  buffering = on;
  document.body.classList.toggle('buffering', on);
  $('play').classList.toggle('buffering', on);
  $('play').setAttribute('aria-label', on ? '正在缓冲' : (audio.paused ? '播放' : '暂停'));
}
audio.addEventListener('waiting', () => { if (!audio.paused) setBuffering(true); });
audio.addEventListener('stalled', () => { if (!audio.paused) setBuffering(true); });
audio.addEventListener('seeking', () => { if (!audio.paused) setBuffering(true); });
audio.addEventListener('playing', () => setBuffering(false));
audio.addEventListener('canplay', () => setBuffering(false));
audio.addEventListener('pause', () => setBuffering(false));
audio.addEventListener('emptied', () => setBuffering(false));
audio.addEventListener('loadedmetadata', () => {
  if (state.current && state.resumeEp === state.current.id && audio.dataset.ep === state.current.id) {
    const t = state.resumeAt;
    setState('resumeEp', ''); setState('resumeAt', 0);
    const dur = audio.duration;
    if (t > 5 && Number.isFinite(dur) && dur > 0 && t < dur - 10) {
      audio.currentTime = t;
      setState('seekRaw', t);
      setState('pendingFollow', true);
    }
  }
  if (app.pendingSeek > 0 && app.pendingSeekEp === audio.dataset.ep) {
    const dur = audio.duration;
    if (Number.isFinite(dur) && dur > 0) {
      audio.currentTime = Math.min(app.pendingSeek, Math.max(0, dur - 1));
      setState('seekRaw', audio.currentTime);
      setState('pendingFollow', true);
    }
    app.pendingSeek = 0;
    app.pendingSeekEp = '';
  } else if (app.pendingSeekEp && app.pendingSeekEp !== audio.dataset.ep) {
    // 目标集换了（比如上一集的跳转没来得及生效）：别把这个时间点带到下一集。
    app.pendingSeek = 0;
    app.pendingSeekEp = '';
  }
  updateTimeScale(); paint(false);
});
audio.addEventListener('timeupdate', () => {
  // 播放时有 8Hz 播放时钟负责重绘；timeupdate 只做写盘和规则，避免重复 paint。
  if (!document.hidden && !playTick) paint();
  saveProgress(false); applySkipRules(); skipSilenceTick(audio.currentTime || 0);
});
audio.addEventListener('seeked', () => saveProgress(true));
audio.addEventListener('ended', () => {
  markCurrentPlayed();
  clearProgress(); paint(true);
  if (app.auto.deletePlayed) setTimeout(() => autoCleanup(), 1200);
});
audio.addEventListener('error', () => { onAudioError(); });
window.addEventListener('pagehide', () => saveProgress(true));
document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress(true); });
function seekBy(seconds) {
  const t = (audio.currentTime || 0) + (state.timeScale - 1) * state.seekRaw + seconds;
  rawSeek(t / (state.timeScale || 1));
  paint(true);
}
function applySkipRules() {
  if (!state.current || audio.paused) return;
  const pref = showPrefFor(state.show?.slug);
  const dur = Number(audio.duration) || 0;
  const now = audio.currentTime || 0;
  if (Number(pref.skipIntro) > 0 && !state.introSkipped && now > 0.2 && now < Number(pref.skipIntro)) {
    setState('introSkipped', true);
    rawSeek(Number(pref.skipIntro));
    return;
  }
  if (prefs.skipAds && state.skipPlan && state.skipPlan.ranges.length) {
    const hit = findSkipRange(now);
    if (hit) {
      state.skipDone.add(hit.id);
      rawSeek(Math.min(hit.end, now + 120));
      showToast('已跳过「' + (hit.label || hit.tag) + '」' + fmt(hit.end - hit.start) + '（可在设置关闭）', 3000);
      return;
    }
  }
  // 没有逐句标签的集沿用旧行为：AI 区间 + 文字稿关键词。
  if (prefs.skipAds && Array.isArray(state.adRanges) && state.adRanges.length) {
    const index = state.adRanges.findIndex(range => now >= range.start && now < range.end - 0.3);
    if (index >= 0 && !state.adSkipped?.has(index)) {
      setState('adSkipped', state.adSkipped || new Set());
      state.adSkipped.add(index);
      rawSeek(state.adRanges[index].end);
      return;
    }
  }
  if (prefs.skipChapterAds && Array.isArray(state.chapters) && state.chapters.length) {
    setState('chapterAdsSkipped', state.chapterAdsSkipped || new Set());
    const ci = state.chapters.reduce((cur, c, i) => (now + 0.4 >= c.start ? i : cur), -1);
    const chapter = ci >= 0 ? state.chapters[ci] : null;
    if (chapter && now - chapter.start < 25 && !state.chapterAdsSkipped.has(ci) && /(^|\b)(ads?|advert\w*|sponsor\w*|intro|outro)\b|广告|赞助|推广|片头|片尾/i.test(chapter.title || '')) {
      state.chapterAdsSkipped.add(ci);
      const next = state.chapters[ci + 1];
      const target = next ? next.start : dur;
      if (target > now) { rawSeek(target); return; }
    }
  }
  if (Number(pref.skipOutro) > 0 && dur > 0 && !state.outroSkipped && dur - now <= Number(pref.skipOutro)) {
    setState('outroSkipped', true);
    if (app.cont !== 'single') playNextAuto(app.cont === 'radio');
    else audio.pause();
  }
}
$('back').onclick = () => seekBy(-15);
$('forward').onclick = () => seekBy(30);
/* ---- 底栏「⋯」工具面板：速度/高亮/实时/详情/列表/排版/沉浸/主题全部在这里，
        任何时刻只允许一个二级面板打开（openDockSheet 负责关掉其它三个）。 ---- */
const dockSheet = $('dockSheet'), dockToolsBtn = $('dockToolsBtn');
function syncDockBadge() {
  const bits = [];
  if (prefs.muted) bits.push('静音');
  if (LIVE.on) bits.push('实时');
  const badge = $('dockBadge');
  badge.textContent = bits.join(' · ');
  badge.hidden = !bits.length;
  dockToolsBtn.setAttribute('aria-label', bits.length ? '播放工具（' + bits.join('、') + '）' : '播放工具');
  const modeLabel = $('dockModeLabel');
  if (modeLabel) modeLabel.textContent = state.mode === 'sentence' ? '逐句' : '逐词';
  const modeBtn = $('dockModeBtn');
  if (modeBtn) {
    modeBtn.classList.toggle('on', state.mode === 'sentence');
    modeBtn.setAttribute('aria-pressed', String(state.mode === 'sentence'));
  }
  syncDockLang();
}
function syncDockLang() {
  const btn = $('dockLangBtn'), label = $('dockLangLabel');
  if (!btn) return;
  const on = reader.lang === 'both';
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', String(on));
  btn.setAttribute('aria-label', on ? '关闭双语字幕' : '开启双语字幕');
  if (label) label.textContent = on ? '双语' : (reader.lang === 'zh' ? '中文' : 'EN');
}
function openDockSheet() {
  if (dockSheet.classList.contains('on')) return;
  rememberOverlayTrigger('dockSheet', dockSheet);
  closeDrawer(false); closeDetails(false); closeTypeSheet(false);
  dockSheet.removeAttribute('inert');
  dockSheet.classList.add('on');
  dockSheet.setAttribute('aria-hidden', 'false');
  dockToolsBtn.setAttribute('aria-expanded', 'true');
  syncDockBadge();
  syncRateSeg();
  syncVolUI();
  syncDockSleep();
  $('dockSheetClose').focus();
}
function closeDockSheet(restore = true) {
  const had = dockSheet.classList.contains('on');
  const hadFocus = dockSheet.contains(document.activeElement);
  dockSheet.classList.remove('on');
  dockSheet.setAttribute('aria-hidden', 'true');
  dockSheet.setAttribute('inert', '');
  dockToolsBtn.setAttribute('aria-expanded', 'false');
  if (restore && had && hadFocus) restoreOverlayFocus('dockSheet');
}
dockToolsBtn.onclick = e => {
  e.stopPropagation();
  dockSheet.classList.contains('on') ? closeDockSheet() : openDockSheet();
};
$('dockSheetClose').onclick = () => closeDockSheet();
document.addEventListener('click', e => {
  if (!dockSheet.classList.contains('on')) return;
  if (e.target.closest('#dockSheet') || e.target.closest('#dockToolsBtn')) return;
  closeDockSheet(false);
});
function syncRateSeg() {
  const rate = Number(prefs.speed) || 1;
  const seg = $('rateSeg');
  if (seg) [...seg.children].forEach(b => b.setAttribute('aria-checked', String(Number(b.dataset.rate) === rate)));
  const sel = $('setSpeed'); if (sel) sel.value = String(rate);
  const label = $('dockRateLabel'); if (label) label.textContent = rate + '×';
  const btn = $('dockRateBtn'); if (btn) btn.setAttribute('aria-label', '播放速度（当前 ' + rate + ' 倍）');
}
const DOCK_RATES = [1, 1.25, 1.5, 1.75, 2, 0.75];
$('dockRateBtn').onclick = () => {
  const cur = Number(prefs.speed) || 1;
  const at = DOCK_RATES.indexOf(cur);
  applyRate(DOCK_RATES[(at >= 0 ? at + 1 : 0) % DOCK_RATES.length]);
};
function applyRate(rate, persist = true) {
  const r = Number(rate) || 1;
  audio.playbackRate = r;
  prefs.speed = r;
  if (persist) savePrefs();
  syncRateSeg();
  syncDockBadge();
}
const rateSegEl = $('rateSeg');
if (rateSegEl) rateSegEl.addEventListener('click', e => {
  const b = e.target.closest('button[data-rate]');
  if (b) applyRate(b.dataset.rate);
});

/* ---- 进度条：拖动只预览（时间气泡跟着走），松手才 seek；双击回到当前句 ---- */
const trackEl = $('track'), seekTip = $('seekTip');
const seekDur = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (state.audioSeconds || 0));
function seekPreviewAt(pct) {
  pct = Math.min(1, Math.max(0, pct));
  setState('seekPreview', pct);
  const dur = seekDur();
  const text = fmt(pct * dur);
  $('now').textContent = text;
  $('pfill').style.width = (pct * 100).toFixed(2) + '%';
  seekTip.textContent = text;
  seekTip.style.left = (pct * 100).toFixed(2) + '%';
  seekTip.classList.add('on');
  $('seek').setAttribute('aria-valuetext', text + ' / ' + fmt(dur));
}
function endSeekPreview(commit) {
  const pct = state.seekPreview;
  setState('seekPreview', null);
  // 预览期间是直接写 DOM 的，缓存必须作废，否则松手后的 paint 会以为「没变」而不落值。
  setState('lastNowText', null); setState('lastAriaText', null); setState('lastSeekBucket', -1);
  seekTip.classList.remove('on');
  if (commit && pct != null && seekDur() > 0) {
    rawSeek(pct * seekDur());
    paint(true);
    saveProgress(true);
  }
}
$('seek').addEventListener('input', () => seekPreviewAt(Number($('seek').value) / 1000));
$('seek').addEventListener('change', () => endSeekPreview(true));
$('seek').addEventListener('pointercancel', () => endSeekPreview(false));
$('seek').addEventListener('blur', () => { if (state.seekPreview != null) { endSeekPreview(false); paint(true); } });
trackEl.addEventListener('dblclick', e => {
  e.preventDefault();
  const cue = state.cues[state.activeCue];
  if (!cue) { showToast('这一集还没有可跳回的句子。', 2600); return; }
  endSeekPreview(false);
  seekTo(cue.speechStart + state.offset);
  showToast('回到当前句 · ' + fmt(cue.speechStart + state.offset), 1800);
});

/* ---- 音量 / 静音（原来整个播放页没有音量入口，只有系统音量） ---- */
function syncVolUI() {
  const muted = !!prefs.muted;
  const vol = Number.isFinite(prefs.volume) ? prefs.volume : 1;
  const pct = Math.round(vol * 100);
  $('volRange').value = String(muted ? 0 : pct);
  $('volOut').textContent = muted ? '静音' : pct + '%';
  $('muteBtn').setAttribute('aria-pressed', String(muted));
  $('muteBtn').setAttribute('aria-label', muted ? '取消静音' : '静音');
}
function applyVolume(persist = true) {
  audio.volume = Math.min(Number(prefs.volumeCap) || 1, 1, Math.max(0, Number.isFinite(prefs.volume) ? prefs.volume : 1));
  audio.muted = !!prefs.muted;
  if (persist) savePrefs();
  syncVolUI();
  syncDockBadge();
}
/* ---- 实验性：本地/离线音频的 WebAudio 图（跳过静音、响度均衡） ---- */
let webAudioGraph = null;
function canAnalyseAudio() {
  try {
    const u = new URL(audio.src || audio.currentSrc || '', location.href);
    return u.origin === location.origin || u.hostname === 'asset.localhost' || u.protocol === 'asset:' || u.protocol === 'tauri:';
  } catch (e) { return false; }
}
function ensureAudioGraph() {
  if (webAudioGraph) return webAudioGraph;
  if (!canAnalyseAudio()) return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    const ctx = new AC();
    const source = ctx.createMediaElementSource(audio);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -26; comp.knee.value = 26; comp.ratio.value = 4;
    comp.attack.value = 0.004; comp.release.value = 0.22;
    const gain = ctx.createGain(); gain.gain.value = 1.12;
    const analyser = ctx.createAnalyser(); analyser.fftSize = 512;
    source.connect(gain); gain.connect(ctx.destination); gain.connect(analyser);
    webAudioGraph = { ctx, source, comp, gain, analyser, loudness: false, quietSince: 0, lastSkip: 0 };
    ctx.resume().catch(() => {});
    return webAudioGraph;
  } catch (e) { return null; }
}
function applyLoudness(enabled) {
  if (!enabled) {
    if (webAudioGraph && webAudioGraph.loudness) {
      try {
        webAudioGraph.source.disconnect();
        webAudioGraph.source.connect(webAudioGraph.gain);
        webAudioGraph.gain.connect(webAudioGraph.ctx.destination);
        webAudioGraph.loudness = false;
      } catch (e) {}
    }
    return true;
  }
  if (!canAnalyseAudio()) return false;
  const graph = ensureAudioGraph();
  if (!graph) return false;
  if (graph.loudness) return true;
  try {
    graph.source.disconnect();
    graph.source.connect(graph.comp);
    graph.comp.connect(graph.gain);
    graph.loudness = true;
    graph.ctx.resume().catch(() => {});
  } catch (e) { return false; }
  return true;
}
function skipSilenceTick(now) {
  if (!prefs.skipSilence) return;
  const graph = webAudioGraph;
  if (!graph || !graph.analyser) return;
  if (audio.paused || audio.seeking) return;
  const data = new Uint8Array(graph.analyser.fftSize);
  graph.analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
  const rms = Math.sqrt(sum / data.length);
  const quiet = rms < 0.008;   // 约 -42 dB
  if (!quiet) { graph.quietSince = 0; return; }
  if (!graph.quietSince) graph.quietSince = now;
  if (now - graph.quietSince > 1.2 && now - graph.lastSkip > 2) {
    graph.lastSkip = now;
    graph.quietSince = 0;
    rawSeek(Math.min(now + 0.9, audio.duration || now + 0.9));
  }
}
audio.addEventListener('play', () => { if (webAudioGraph) webAudioGraph.ctx.resume().catch(() => {}); });
function toggleMute() {
  prefs.muted = !prefs.muted;
  if (!prefs.muted && !(Number(prefs.volume) > 0)) prefs.volume = 0.5;
  applyVolume();
  showToast(prefs.muted ? '已静音（M 取消）' : '已取消静音', 1800);
}
$('muteBtn').onclick = toggleMute;
$('volRange').addEventListener('input', e => {
  const v = Number(e.target.value) / 100;
  prefs.volume = v;
  prefs.muted = v === 0 ? prefs.muted : false;
  // 拖动时每次 input 都同步写 localStorage 会拖慢手势，松手（change）再落盘。
  applyVolume(false);
});
$('volRange').addEventListener('change', () => applyVolume());

/* ---- 上一集 / 下一集（复用 stepEpisode，和迷你窗、媒体键同一套口径） ---- */
$('prevEpBtn').onclick = () => stepEpisode(-1);
$('nextEpBtn').onclick = () => stepEpisode(1);

/* ---- 睡眠定时：面板里给常用档，剩余时间直接写回标签 ---- */
function syncDockSleep() {
  const out = $('sleepOut');
  if (out) {
    let text = '';
    if (app.sleepEnd) text = '本集结束';
    else if (app.sleepUntil) text = '剩 ' + fmt(Math.max(1, Math.ceil((app.sleepUntil - Date.now()) / 1000)));
    out.textContent = text;
  }
  const quickLabel = $('dockSleepLabel');
  if (quickLabel) {
    quickLabel.textContent = app.sleepEnd ? '本集'
      : app.sleepUntil ? Math.max(1, Math.ceil((app.sleepUntil - Date.now()) / 60000)) + '′'
      : '睡眠';
  }
  const quickBtn = $('dockSleepBtn');
  if (quickBtn) {
    const on = !!(app.sleepEnd || app.sleepUntil);
    quickBtn.classList.toggle('on', on);
    quickBtn.setAttribute('aria-pressed', String(on));
  }
  // 30′/60′ 也要能被认出来：按剩余时间倒推（误差 1 分钟），否则只有「结束/关」会高亮。
  const remainMin = app.sleepUntil ? (app.sleepUntil - Date.now()) / 60000 : -1;
  const seg = $('sleepSeg');
  if (seg) [...seg.children].forEach(b => {
    const v = b.dataset.sleepQuick;
    const on = v === 'end' ? !!app.sleepEnd
      : v === 'off' ? (!app.sleepEnd && !app.sleepUntil)
      : (remainMin > 0 && Math.abs(remainMin - Number(v)) <= 1);
    b.classList.toggle('on', on);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(on));
  });
}
const sleepSegEl = $('sleepSeg');
if (sleepSegEl) sleepSegEl.addEventListener('click', e => {
  const b = e.target.closest('button[data-sleep-quick]');
  if (!b) return;
  const v = b.dataset.sleepQuick;
  setSleep(v === 'off' ? 'off' : v);
  syncDockSleep();
});
$('dockSleepBtn').onclick = () => {
  const remainMin = app.sleepUntil ? (app.sleepUntil - Date.now()) / 60000 : -1;
  const next = app.sleepEnd ? 'off'
    : app.sleepUntil ? (remainMin <= 30 ? '60' : 'end')
    : '30';
  setSleep(next);
};
$('scroll').onchange = e => {
  setState('scroll', e.target.value);
  try { localStorage.setItem('myt-scroll', state.scroll); } catch (err) {}
  if (state.scroll === 'off') { syncJumpPill(); return; }
  setState('userScrollUntil', 0);
  if (state.activeCue >= 0 && state.nodes[state.activeCue]) scrollCue(state.nodes[state.activeCue].el, true);
  syncJumpPill();
};
function setAlignMode(on, at = 0) {
  setState('alignMode', on);
  setState('alignAt', on ? at : 0);
  document.body.classList.toggle('aligning', on);
  $('alignCue').textContent = on ? '取消对齐' : '对齐到当前句';
  $('alignCue').setAttribute('aria-pressed', String(on));
}
function toggleAlignMode() {
  if (state.alignMode) { setAlignMode(false); showToast('已取消对齐。', 2500); return; }
  if (!state.current || !audio.getAttribute('src')) { showToast('该集没有音频地址。'); return; }
  if (!state.cues.length) { showToast('该集没有字幕。'); return; }
  setAlignMode(true, (audio.currentTime || 0) + (state.timeScale - 1) * state.seekRaw);
  showToast('点击一句应高亮的句子（已锁定当前播放位置，Esc 取消）', 8000);
}
function alignToCue(cue) {
  const offset = Math.round((state.alignAt - cue.speechStart) * 100) / 100;
  setState('offset', offset);
  $('offset').value = String(offset);
  setAlignMode(false);
  renderCues();
  showToast('偏移已设为 ' + offset.toFixed(2) + ' 秒', 4000);
}
$('alignCue').onclick = toggleAlignMode;
$('offset').addEventListener('change', e => { setState('offset', Number(e.target.value) || 0); renderCues(); });
function returnToCue() {
  setState('userScrollUntil', 0);
  setState('pendingFollow', false);
  stopScroll();
  if (state.activeCue >= 0 && state.nodes[state.activeCue]) scrollCue(state.nodes[state.activeCue].el, true);
  syncJumpPill();
}
$('follow').onclick = () => { returnToCue(); closeDetails(); };
$('search').addEventListener('input', e => renderList(e.target.value));
function setReadMode(mode) {
  if (mode !== 'word' && mode !== 'sentence') return;
  if (mode === state.mode) return;
  setState('mode', mode);
  try { localStorage.setItem('myt-mode', state.mode); } catch (err) {}
  const seg = $('modeSeg');
  if (seg) [...seg.children].forEach(b => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
  syncDockBadge();
  renderCues();
  paint(true);
}
const modeSegEl = $('modeSeg');
if (modeSegEl) modeSegEl.addEventListener('click', e => {
  const btn = e.target.closest('button[data-mode]');
  if (btn) setReadMode(btn.dataset.mode);
});
$('dockModeBtn').onclick = () => setReadMode(state.mode === 'word' ? 'sentence' : 'word');
$('dockLangBtn').onclick = () => {
  reader.lang = reader.lang === 'both' ? 'en' : 'both';
  applyReader();
  rebuildCues();
};
$('drawerBtn').onclick = openDrawer;
$('drawerClose').onclick = closeDrawer;
$('scrim').onclick = closeOverlays;
$('detailsBtn').onclick = (e) => { e.stopPropagation(); $('details').classList.contains('on') ? closeDetails() : openDetails(); };
$('openDetailsText').onclick = openDetails;
$('cover').onclick = openDetails;
$('detailsClose').onclick = closeDetails;
$('immersiveBtn').onclick = () => setImmersive(!state.immersive);
$('wallpaperBtn').onclick = () => { closeDockSheet(false); setWallpaper(true); };
$('wpPlay').onclick = e => { e.preventDefault(); e.stopPropagation(); toggleWallpaperPlay(); };
$('wpExit').onclick = () => setWallpaper(false);

let framePos = null, frameMoved = false, frameDrag = null;
const frameEl = $('frameBtn');
function clampFrame(x, y) {
  const w = frameEl.offsetWidth || 72, h = frameEl.offsetHeight || 72;
  return { x: Math.max(8, Math.min(x, innerWidth - w - 8)), y: Math.max(8, Math.min(y, innerHeight - h - 8)) };
}
function placeFrame(x, y) {
  framePos = clampFrame(x, y);
  frameEl.style.left = framePos.x + 'px';
  frameEl.style.top = framePos.y + 'px';
  frameEl.style.bottom = 'auto';
  frameEl.style.right = 'auto';
}
function onFrameMove(e) {
  if (!frameDrag) return;
  if (!frameMoved) {
    if (Math.abs(e.clientX - frameDrag.sx) + Math.abs(e.clientY - frameDrag.sy) <= 4) return;
    frameMoved = true;
  }
  placeFrame(e.clientX - frameDrag.dx, e.clientY - frameDrag.dy);
}
function endFrameDrag() {
  if (!frameDrag) return;
  frameDrag = null;
  frameEl.classList.remove('dragging');
  removeEventListener('pointermove', onFrameMove);
  removeEventListener('pointerup', endFrameDrag);
  removeEventListener('pointercancel', endFrameDrag);
  if (frameMoved) setTimeout(() => { frameMoved = false; }, 300);
}
frameEl.addEventListener('pointerdown', e => {
  if (!state.immersive || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const r = frameEl.getBoundingClientRect();
  frameDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY };
  frameMoved = false;
  frameEl.classList.add('dragging');
  addEventListener('pointermove', onFrameMove);
  addEventListener('pointerup', endFrameDrag);
  addEventListener('pointercancel', endFrameDrag);
});
frameEl.addEventListener('dragstart', e => e.preventDefault());
frameEl.onclick = () => { if (frameMoved) { frameMoved = false; return; } setImmersive(false); };
$('jumpPill').onclick = () => returnToCue();
addEventListener('resize', () => {
  if (framePos && state.immersive) placeFrame(framePos.x, framePos.y);
  alignZhLines();
  syncJumpPill();
});
document.addEventListener('click', e => {
  const d = $('details');
  if (d.classList.contains('on') && !d.contains(e.target) && e.target !== $('detailsBtn') && e.target !== $('cover') && e.target !== $('openDetailsText')) closeDetails();
});
// 滚动事件一秒能来几十次，每次都量两个 rect 会强制同步布局；合并到一帧算一次。
let pillRAF = 0;
function queueJumpPill() {
  if (pillRAF) return;
  pillRAF = requestAnimationFrame(() => { pillRAF = 0; syncJumpPill(); });
}
box.addEventListener('scroll', queueJumpPill, { passive: true });
box.addEventListener('wheel', () => { stopScroll(); setState('pendingFollow', false); setState('userScrollUntil', Date.now() + 3000); }, { passive: true });
box.addEventListener('touchmove', () => { stopScroll(); setState('pendingFollow', false); setState('userScrollUntil', Date.now() + 3000); }, { passive: true });
function jumpCue(delta) {
  if (!state.cues.length) return;
  const base = state.activeCue >= 0 ? state.activeCue : 0;
  const index = Math.max(0, Math.min(state.cues.length - 1, base + delta));
  if (!state.nodes[index]) renderCueWindow(index, true);
  const cue = state.cues[index], node = state.nodes[index];
  if (!cue) return;
  seekTo(cue.start + state.offset);
  stopScroll();
  if (node) scrollCue(node.el, true);
}

/* ---------- 文字稿交互：本集内搜索 / 划句文字卡 ---------- */
const findBar = $('findBar'), findInput = $('findInput'), findCount = $('findCount'), selTools = $('selTools');
let findHits = [], findAt = -1, selCueIdx = -1, selText = '';

function clearFindMarks() {
  state.nodes.forEach(n => { if (n && n.el) n.el.classList.remove('find-hit', 'find-cur'); });
  findHits = []; findAt = -1;
  if (findCount) findCount.textContent = '0/0';
}

function showFindAt(target, seek) {
  if (!findHits.length) { if (findCount) findCount.textContent = '0/0'; return; }
  findAt = Math.max(0, Math.min(findHits.length - 1, target));
  state.nodes.forEach(n => { if (n && n.el) n.el.classList.remove('find-cur'); });
  const ci = findHits[findAt], cue = state.cues[ci];
  if (!state.nodes[ci]) renderCueWindow(ci, true);
  const node = state.nodes[ci];
  if (findCount) findCount.textContent = (findAt + 1) + ' / ' + findHits.length;
  if (!node) return;
  node.el.classList.add('find-cur');
  stopScroll();
  scrollCue(node.el, true);
  if (seek && cue) seekTo(cue.start + state.offset);
}

function runFind(query) {
  clearFindMarks();
  const q = findNorm(query);
  if (!q) return;
  state.cues.forEach((cue, ci) => {
    const hay = findNorm(cue.text) + ' ' + findNorm(cue.zh);
    if (hay.includes(q)) {
      findHits.push(ci);
      const n = state.nodes[ci];
      if (n && n.el) n.el.classList.add('find-hit');
    }
  });
  if (!findHits.length) { if (findCount) findCount.textContent = '0/0'; return; }
  // 从当前播放位置往后找第一处，符合“接着往下找”的直觉
  const from = state.activeCue >= 0 ? state.activeCue : 0;
  const start = findHits.findIndex(ci => ci >= from);
  showFindAt(start >= 0 ? start : 0, false);
}

function openFind() {
  if (!subtitlePluginOn()) { showToast('字幕插件未启用，本集搜索不可用。', 'warn'); return; }
  if (!state.cues.length) { showToast('这集还没有文字稿。'); return; }
  findBar.hidden = false; findBar.classList.add('on');
  findInput.value = '';
  clearFindMarks();
  findInput.focus();
}
function closeFind() {
  findBar.classList.remove('on'); findBar.hidden = true;
  clearFindMarks();
  try { getSelection().removeAllRanges(); } catch (e) {}
}

function hideSelTools() {
  selTools.classList.remove('on'); selTools.hidden = true;
  selCueIdx = -1; selText = '';
}

function pickedCue() {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  let text = sel.toString().replace(/\s+/g, ' ').trim();
  // 拖选时容易把行首的时间戳一起选进来（"00:14You feel…"），去掉它再进卡片
  text = text.replace(/^\d{1,2}:\d{2}(?::\d{2})?\s*/, '').trim();
  if (!text) return null;
  let node = sel.anchorNode;
  if (node && node.nodeType === 3) node = node.parentElement;
  if (!node || !box.contains(node)) return null;
  const cueEl = node.closest('.cue');
  if (!cueEl) return null;
  const ci = Number(cueEl.dataset.ci);
  if (!state.cues[ci]) return null;
  return { ci, text };
}

function placeSelTools(rect) {
  const w = selTools.offsetWidth || 118, h = selTools.offsetHeight || 32;
  let x = rect.left + rect.width / 2 - w / 2;
  let y = rect.top - h - 8;
  if (y < 8) y = rect.bottom + 8;
  x = Math.max(8, Math.min(window.innerWidth - w - 8, x));
  selTools.style.left = Math.round(x) + 'px';
  selTools.style.top = Math.round(y) + 'px';
}

function cardLink(slug, id) {
  const hash = '#/player/' + slug + '/' + id;
  const host = location.hostname || '';
  // 桌面壳里 location 是 tauri.localhost，粘出去没用；一律换成发布站点
  if (host === 'tauri.localhost' || host === 'localhost' || host === '127.0.0.1') {
    return 'https://lzoreal.github.io/MyTranscript/player.html' + hash;
  }
  return location.origin + location.pathname + hash;
}

function cardFor(ci, text) {
  const cue = state.cues[ci] || {};
  const show = state.show || {}, ep = state.current || {};
  const head = [show.name, ep.title].filter(Boolean).join(' · ');
  const link = (show.slug && ep.id) ? cardLink(show.slug, ep.id) : location.href;
  const lines = ['> ' + text];
  if (cue.zh) lines.push('> ' + String(cue.zh).replace(/\s+/g, ' ').trim());
  lines.push('');
  lines.push('— ' + (head ? head + ' · ' : '') + fmt((cue.start || 0) + state.offset));
  lines.push(link);
  return lines.join('\n');
}

async function copyPlain(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (err) { return false; }
}

document.addEventListener('mouseup', e => {
  if (e.target && e.target.closest && e.target.closest('#selTools')) return;
  setTimeout(() => {
    const hit = pickedCue();
    if (!hit) { hideSelTools(); return; }
    const sel = getSelection();
    const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    const rect = range ? range.getBoundingClientRect() : null;
    if (!rect || (!rect.width && !rect.height)) { hideSelTools(); return; }
    selCueIdx = hit.ci; selText = hit.text;
    selTools.hidden = false; selTools.classList.add('on');
    placeSelTools(rect);
  }, 0);
}, true);

selTools.addEventListener('click', async e => {
  const btn = e.target.closest('[data-sel]');
  if (!btn) return;
  e.preventDefault(); e.stopPropagation();
  if (selCueIdx < 0 || !selText) return;
  const isCard = btn.dataset.sel === 'card';
  const payload = isCard ? cardFor(selCueIdx, selText) : selText;
  const ok = await copyPlain(payload);
  hideSelTools();
  try { getSelection().removeAllRanges(); } catch (err) {}
  showToast(ok ? (isCard ? '文字卡已复制' : '已复制选中文字') : '复制失败，请手动选择后再试', ok ? 2200 : 3200);
});

box.addEventListener('scroll', () => { if (selTools.classList.contains('on')) hideSelTools(); }, { passive: true });
window.mytFindReset = () => { hideSelTools(); if (findBar.classList.contains('on')) closeFind(); };

/* ================== 章节导航 ================== */
async function fetchTextAny(url) {
  if (host() && typeof host().httpText === 'function') return host().httpText(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}
function loadChapters(ep) {
  const seq = ++state.chapterSeq;
  setState('chapterKey', '');   // 换集后必须重写一次章节文字，不能沿用上一集的缓存键
  setState('chapters', Array.isArray(ep && ep.chapters) ? ep.chapters.slice() : []);
  setState('chapterAdsSkipped', new Set());
  setState('chapterIdx', -2);
  renderChapters();
  if (!ep || !ep.chaptersUrl) return;
  const cached = app.chaptersCache.get(ep.chaptersUrl);
  if (cached) {
    setState('chapters', cached.slice());
    setState('chapterIdx', -2);
    renderChapters();
    return;
  }
  fetchTextAny(ep.chaptersUrl).then(text => {
    if (seq !== state.chapterSeq) return;
    const data = JSON.parse(text);
    const list = (data.chapters || [])
      .map(c => ({ start: Number(c.startTime) || 0, title: String(c.title || '').trim() }))
      .filter(c => c.title)
      .sort((a, b) => a.start - b.start);
    if (!list.length) return;
    app.chaptersCache.set(ep.chaptersUrl, list);
    setState('chapters', list);
    setState('chapterAdsSkipped', new Set());
    setState('chapterIdx', -2);
    renderChapters();
  }).catch(() => {});
}
function renderChapters() {
  const sheet = $('chapterSheet'), list = $('chapterList'), chip = $('chapterChip'), now = $('chapterNow');
  if (!sheet || !list) return;
  if (!state.chapters.length) {
    list.innerHTML = '<div class="chapter-empty">该集没有章节信息。<br>带章节的节目会从 feed 自动读取。</div>';
    if (now) now.textContent = '—';
    if (chip) { chip.hidden = true; chip.textContent = ''; }
    return;
  }
  list.innerHTML = state.chapters.map((c, i) =>
    '<button type="button" class="chapter-item" data-chapter="' + i + '"><time>' + fmt(c.start || 0) +
    '</time><span>' + esc(c.title) + '</span></button>').join('');
  syncChapterNow(audio.currentTime || 0);
}
function syncChapterNow(t) {
  if (!state.chapters.length) return;
  let idx = -1;
  for (let i = 0; i < state.chapters.length; i++) {
    if (t + 0.4 >= state.chapters[i].start) idx = i;
  }
  const title = idx >= 0 ? state.chapters[idx].title : '';
  // 这句话/这一章没变就不必每帧重写两个标签
  const key = idx + '|' + title;
  if (key !== state.chapterKey) {
    setState('chapterKey', key);
    const now = $('chapterNow'), chip = $('chapterChip');
    if (now) now.textContent = title || '—';
    if (chip) {
      chip.hidden = !title;
      chip.textContent = title ? '§ ' + title : '';
      chip.title = title;
    }
  }
  if (idx !== state.chapterIdx) {
    setState('chapterIdx', idx);
    const list = $('chapterList');
    if (list) [...list.children].forEach((el, i) => el.classList.toggle('now', i === idx));
  }
}
function seekChapter(i) {
  const c = state.chapters[i];
  if (!c) return;
  seekTo(c.start);
  audio.play().catch(() => {});
}
function toggleChapterSheet(force) {
  const sheet = $('chapterSheet');
  if (!sheet) return;
  const on = force === undefined ? !sheet.classList.contains('on') : !!force;
  sheet.classList.toggle('on', on);
  sheet.hidden = false;
  $('chapterBtn')?.classList.toggle('on', on);
  if (on) renderChapters();
}

/* ================== 点词查义 ================== */
const wordCache = new Map();
const cleanWordCache = new Map();
let wordCurrent = '', wordCurrentMeaning = '';
function cleanWord(raw) {
  const source = String(raw || '');
  const hit = cleanWordCache.get(source);
  if (hit !== undefined) return hit;
  const word = source.replace(/[^A-Za-z'’-]/g, '').replace(/^['’-]+|['’-]+$/g, '').toLowerCase();
  if (cleanWordCache.size > 20000) cleanWordCache.clear();
  cleanWordCache.set(source, word);
  return word;
}
function closeWordPanel() {
  const panel = $('wordPanel');
  if (panel) { panel.classList.remove('on'); panel.hidden = true; }
  wordSeq += 1;
}
let wordSeq = 0;
async function lookupWord(raw) {
  if (!studyPluginOn()) return;
  const word = cleanWord(raw);
  const panel = $('wordPanel');
  if (!word || !panel) return;
  // 每次查词都领一个序号：先发的慢请求回来时，如果面板已经换成别的词，
  // 就不能再把旧词条写进正文（否则标题是新词、释义是旧词）。
  const seq = ++wordSeq;
  wordCurrent = word;
  panel.classList.add('on');
  panel.hidden = false;
  $('wordTitle').textContent = word;
  $('wordPhon').textContent = '';
  $('wordBody').innerHTML = '<div class="word-note">正在查词…</div>';
  let entry = wordCache.get(word);
  if (!entry) {
    try {
      const text = await fetchTextAny('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word));
      entry = JSON.parse(text);
      wordCache.set(word, entry);
    } catch (err) {
      if (seq !== wordSeq) return;
      wordCurrentMeaning = '';
      $('wordBody').innerHTML = '<div class="word-note">查不到这个词（离线词典源不可用）。</div>' + wordStatusHTML(word);
      bindWordStatusButtons(word);
      if (window.__xai) window.__xai.attachWord(word, true);
      return;
    }
  }
  if (seq !== wordSeq) return;
  const first = Array.isArray(entry) ? entry[0] : null;
  const phon = (first && (first.phonetic || (first.phonetics || []).map(p => p.text).find(Boolean))) || '';
  $('wordPhon').textContent = phon;
  const meanings = (first && first.meanings) || [];
  const firstDef = meanings[0]?.definitions?.[0]?.definition || '';
  wordCurrentMeaning = firstDef;
  $('wordBody').innerHTML = (meanings.length
    ? meanings.slice(0, 4).map(m => {
      const defs = (m.definitions || []).slice(0, 2)
        .map(d => esc(d.definition || '')).filter(Boolean).join('<br>');
      return '<div class="word-sense"><i>' + esc(m.partOfSpeech || '') + '</i>' + (defs || '—') + '</div>';
    }).join('')
    : '<div class="word-note">这个词在词典里没有释义。</div>') + wordStatusHTML(word);
  bindWordStatusButtons(word);
  if (window.__xai) window.__xai.attachWord(word, false);
}

/* ================== 播放列表 ================== */
function savePlaylists() { writeJSON(PLAYLIST_KEY, app.playlists); }
function findPlaylist(id) { return app.playlists.find(p => p.id === id) || null; }
function defaultPlaylist() {
  let p = app.playlists[0];
  if (!p) {
    p = { id: 'pl-' + Date.now().toString(36), name: '稍后听', items: [], at: Date.now() };
    app.playlists.unshift(p);
    savePlaylists();
  }
  return p;
}
function episodeRef(show, ep) {
  return {
    key: show.slug, ep: ep.id, title: ep.title || '', show: show.name || '',
    date: ep.date || '', duration: ep.duration || '', img: ep.img || '',
  };
}
function addToPlaylist(show, ep, listId) {
  if (!show || !ep) return;
  const p = listId ? findPlaylist(listId) : defaultPlaylist();
  if (!p) return;
  if (p.items.some(it => it.key === show.slug && it.ep === ep.id)) { showToast('已在「' + p.name + '」里。'); return; }
  p.items.push(episodeRef(show, ep));
  p.at = Date.now();
  savePlaylists();
  showToast('已加入播放列表「' + p.name + '」。');
  renderAfterStateChange();
}
function playPlaylist(id) {
  const p = findPlaylist(id);
  if (!p || !p.items.length) return;
  // 队列里已经有东西时别静默替换：用户可能刚攒了一队通勤要听的。
  if (app.queue.length && !confirm('播放列表「' + p.name + '」会替换当前播放队列（' + app.queue.length + ' 集），继续？')) return;
  app.queue = p.items.map(it => Object.assign({}, it, { at: Date.now() }));
  saveQueue();
  const first = p.items[0];
  showToast('播放列表「' + p.name + '」开始播放，共 ' + p.items.length + ' 集。');
  playEpisode(first.key, first.ep);
}
function removePlaylist(id) {
  const p = findPlaylist(id);
  if (!p) return;
  app.playlists = app.playlists.filter(x => x.id !== id);
  savePlaylists();
  showToast('已删除播放列表「' + p.name + '」。');
  renderAfterStateChange();
}
function addToPlaylistDialog(showArg, epArg) {
  // 列表卡片上的「＋ 列表」是给「这一集」用的，不能顺手把 state.current 改成它：
  // state.current 是正在播放的那一集，标题、迷你窗、续播进度都靠它。
  const show = showArg || state.show;
  const ep = epArg || state.current;
  if (!show || !ep) { showToast('先打开一集再收藏。', 'warn'); return; }
  const lists = app.playlists;
  openModal('<h3>加入播放列表</h3><p class="smalltext">' + esc(show.name) + ' · ' + esc(ep.title || '') + '</p>' +
    '<div class="note-form"><label>选择列表</label><select id="plPick">' +
    lists.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + '（' + p.items.length + '）</option>').join('') +
    '</select><label>或新建</label><input id="plNew" placeholder="新列表名，例如「通勤」「睡前」"></div>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">' +
    '<button class="btn ghost" data-close-modal>取消</button>' +
    '<button class="btn primary" id="plConfirm">加入</button></div>');
  $('plConfirm').addEventListener('click', () => {
    const name = ($('plNew').value || '').trim();
    if (name) {
      const p = { id: 'pl-' + Date.now().toString(36), name, items: [], at: Date.now() };
      app.playlists.unshift(p);
      savePlaylists();
      addToPlaylist(show, ep, p.id);
    } else {
      addToPlaylist(show, ep, $('plPick').value);
    }
    closeModal();
  });
}
function renderPlaylists() {
  const box = $('playlistList');
  const hint = $('playlistHint');
  if (!box) return;
  if (hint) hint.textContent = app.playlists.length ? app.playlists.length + ' 个列表' : '保存在本机';
  box.innerHTML = app.playlists.length
    ? app.playlists.map(p => {
      const preview = p.items.slice(0, 3).map(it => esc(it.title || it.ep)).join('<br>');
      const more = p.items.length > 3 ? '<br><span class="smalltext">…其余 ' + (p.items.length - 3) + ' 集</span>' : '';
      return '<div class="qrow"><div class="qmain"><strong>' + esc(p.name) + '</strong>' +
        '<span>' + p.items.length + ' 集' + (p.items[0] ? ' · 首集 ' + esc(p.items[0].title || '') : '') + '</span>' +
        (preview ? '<span class="smalltext" style="margin-top:4px">' + preview + more + '</span>' : '<span class="smalltext">还是空的：单集页点「＋ 列表」加入。</span>') +
        '</div><div style="display:flex;gap:6px">' +
        '<button class="mini-btn" data-play-playlist="' + esc(p.id) + '"' + (p.items.length ? '' : ' disabled') + '>▶ 播放</button>' +
        '<button class="mini-btn" data-del-playlist="' + esc(p.id) + '">✕</button></div></div>';
    }).join('')
    : emptyLine('还没有播放列表。在单集页点「＋ 列表」建一个。', '<button class="btn ghost" data-route="library">去播客库</button>');
}

/* ================== 离线下载 ================== */
function offlineKeyOf(key, epId) {
  const clean = v => String(v || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return clean(key) + '-' + clean(epId);
}
function offlineKeyFor(show, ep) { return offlineKeyOf(show && show.slug, ep && ep.id); }
async function saveOfflineTranscript(show, ep) {
  if (!host() || typeof host().offlineTranscriptSave !== 'function') return false;
  if (!show || !ep || !isJsonTranscript(ep.transcript)) return false;
  const key = offlineKeyFor(show, ep);
  if (app.offline.get(key)?.hasTranscript) return true;
  if (app.transcriptDownloads?.has(key)) return false;
  app.transcriptDownloads = app.transcriptDownloads || new Set();
  app.transcriptDownloads.add(key);
  try {
    const url = ep.transcript.url;
    try {
      await host().offlineTranscriptSave(url, key);
    } catch (firstErr) {
      const mirror = transcriptMirror(url);
      if (!mirror) throw firstErr;
      await host().offlineTranscriptSave(mirror, key);
    }
    // 跳过标签跟文字稿一起下；没有这个文件不影响播放，只是「跳过」用不了。
    if (typeof host().offlineSkipSave === 'function') {
      const skipUrl = skipUrlOf(url);
      if (skipUrl && skipUrl !== url) {
        host().offlineSkipSave(skipUrl, key).catch(() => {});
      }
    }
    return true;
  } finally {
    app.transcriptDownloads.delete(key);
  }
}
// 下载过的整集优先读本机文字稿；文件被删或解析失败时再回落到远端。
async function readTranscriptDoc(show, ep) {
  const transcript = ep && ep.transcript;
  if (!transcript || !transcript.url) return { doc: null, local: false };
  const key = offlineKeyFor(show, ep);
  const rec = app.offline ? app.offline.get(key) : null;
  if (rec && rec.hasTranscript && host() && typeof host().offlineTranscriptLoad === 'function' && isJsonTranscript(transcript)) {
    try {
      const text = await host().offlineTranscriptLoad(key);
      if (text) return { doc: JSON.parse(text), local: true };
    } catch (e) {}
  }
  return { doc: await getJson(transcript.url), local: false };
}
async function refreshOffline() {
  if (!host() || typeof host().offlineList !== 'function') return;
  try {
    const list = await host().offlineList();
    app.offline = new Map((list || []).map(rec => [rec.key, rec]));
  } catch (e) { app.offline = new Map(); }
  renderOfflineList();
  renderDownloads();
}

/* ---- 实时识别模型管理（桌面壳）---- */
function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  if (n >= 1024 * 1024) return Math.round(n / 1024 / 1024) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}
function asrModelName(id) {
  const found = (app.asrModels || []).find(model => model.id === id);
  return found ? found.name : id;
}
function localAsrModelId() {
  return prefs.asrModel || ASR_MODEL_DEFAULT;
}
function renderLocalAsrModelHint() {
  const el = $('localAsrModelNow');
  if (!el) return;
  const id = localAsrModelId();
  const found = (app.asrModels || []).find(model => model.id === id);
  el.textContent = (found ? found.name : id) + (found && found.installed === false ? '（未安装，会先下载）' : '') +
    ' · 整集预转写会用这一档';
}
async function refreshAsrModels() {
  if (!host() || typeof host().asrModels !== 'function') {
    renderAsrModels();
    return;
  }
  try {
    app.asrModels = await host().asrModels() || [];
    app.asrModelsErr = '';
  } catch (e) {
    app.asrModels = [];
    app.asrModelsErr = (e && e.message) || String(e);
  }
  renderAsrModels();
}
function renderAsrModels() {
  const boxEl = $('asrModelList');
  if (!boxEl) return;
  if (!host() || typeof host().asrModels !== 'function') {
    boxEl.innerHTML = '<div class="smalltext">模型管理只在桌面版可用；网页版固定使用内置的 WASM 模型。</div>';
    return;
  }
  const list = app.asrModels || [];
  if (!list.length) {
    boxEl.innerHTML = '<div class="smalltext">' + esc(app.asrModelsErr || '正在读取模型…') + '</div>';
    return;
  }
  let active = prefs.asrModel || ASR_MODEL_DEFAULT;
  // 目录被手工删掉时选择会指空，回落到默认模型，别让 prepare 拿着未知 id 去下载。
  if (!list.some(model => model.id === active)) {
    prefs.asrModel = ASR_MODEL_DEFAULT;
    savePrefs();
    active = ASR_MODEL_DEFAULT;
  }
  boxEl.innerHTML = '';
  list.forEach(model => {
    const busy = app.asrBusy.get(model.id);
    const row = document.createElement('div');
    row.className = 'asr-model' + (model.id === active ? ' on' : '');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const title = document.createElement('b');
    title.textContent = model.name + (model.id === active ? ' · 使用中' : '');
    const sub = document.createElement('span');
    let size = model.installed ? '已安装 ' + fmtBytes(model.bytes) : '未安装';
    if (!model.installed && model.part > 0) size = '已下载 ' + fmtBytes(model.part) + '，可续传';
    if (busy) size = '下载中 ' + busy.pct + '%' + (busy.total ? '（' + fmtBytes(busy.got) + ' / ' + fmtBytes(busy.total) + '）' : '');
    sub.textContent = [model.desc, size].filter(Boolean).join(' · ');
    meta.append(title, sub);
    const ops = document.createElement('div');
    ops.className = 'ops';
    if (busy) {
      const cancel = document.createElement('button');
      cancel.className = 'btn ghost small';
      cancel.textContent = '取消';
      cancel.dataset.asrCancel = model.id;
      ops.append(cancel);
    } else {
      if (!model.installed) {
        const get = document.createElement('button');
        get.className = 'btn primary small';
        get.textContent = model.part > 0 ? '继续下载' : '下载';
        get.dataset.asrInstall = model.id;
        ops.append(get);
      }
      if (model.id !== active) {
        const use = document.createElement('button');
        use.className = 'btn ghost small';
        use.textContent = model.installed ? '使用' : '下载并使用';
        use.dataset.asrPick = model.id;
        ops.append(use);
      }
      if (model.installed) {
        const open = document.createElement('button');
        open.className = 'btn ghost small';
        open.textContent = '目录';
        open.title = '在资源管理器里打开模型目录';
        open.dataset.asrOpen = model.id;
        ops.append(open);
        const del = document.createElement('button');
        del.className = 'btn ghost small';
        del.textContent = '删除';
        del.dataset.asrRemove = model.id;
        del.disabled = model.id === active;
        if (model.id === active) del.title = '正在使用，先切到别的模型再删';
        ops.append(del);
      }
    }
    row.append(meta, ops);
    boxEl.append(row);
  });
  renderLocalAsrModelHint();
}
function paintAsrSoon() {
  if (app.asrPaintPending) return;
  app.asrPaintPending = true;
  requestAnimationFrame(() => {
    app.asrPaintPending = false;
    renderAsrModels();
  });
}
async function installAsrModel(id) {
  if (!host() || typeof host().asrPrepare !== 'function') return;
  const model = (app.asrModels || []).find(item => item.id === id);
  const label = model ? model.name : asrModelName(id);
  app.asrBusy.set(id, { pct: 0, got: 0, total: 0 });
  renderAsrModels();
  showToast('开始下载「' + label + '」模型…', 4000);
  try {
    await host().asrPrepare(id);
    app.asrBusy.delete(id);
    await refreshAsrModels();
    showToast('模型已就绪：' + label, 4000);
  } catch (e) {
    const msg = (e && e.message) || String(e || '');
    app.asrBusy.delete(id);
    await refreshAsrModels();
    if (/取消/.test(msg)) showToast('已取消下载，进度保留，下次可续传。', 5000);
    else showToast('模型下载失败：' + msg, 9000);
  }
}
async function cancelAsrModel(id) {
  if (!host() || typeof host().asrCancel !== 'function') return;
  try {
    await host().asrCancel(id);
    showToast('正在取消下载…', 3000);
  } catch (e) {
    showToast('取消失败：' + ((e && e.message) || e), 6000);
  }
}
async function openAsrDir(id) {
  if (!host() || typeof host().asrOpenDir !== 'function') return;
  try {
    await host().asrOpenDir(id);
  } catch (e) {
    showToast('打开目录失败：' + ((e && e.message) || e), 6000);
  }
}
function pickAsrModel(id) {
  if (!id || id === prefs.asrModel) return;
  const model = (app.asrModels || []).find(item => item.id === id);
  if (model && !model.installed) {
    installAsrModel(id).then(() => {
      prefs.asrModel = id;
      savePrefs();
      renderAsrModels();
    });
    return;
  }
  prefs.asrModel = id;
  savePrefs();
  renderAsrModels();
  showToast('已切换到「' + asrModelName(id) + '」，下次开启实时识别生效。', 4000);
}
async function removeAsrModel(id) {
  if (!host() || typeof host().asrRemove !== 'function') return;
  if (id === (prefs.asrModel || ASR_MODEL_DEFAULT)) {
    showToast('这是正在使用的模型，先切到别的模型再删。', 4000);
    return;
  }
  const model = (app.asrModels || []).find(item => item.id === id);
  if (!confirm('删除模型「' + ((model && model.name) || id) + '」？下次用要重新下载。')) return;
  try {
    await host().asrRemove(id);
    await refreshAsrModels();
    showToast('已删除模型。');
  } catch (e) {
    showToast('删除失败：' + ((e && e.message) || e), 8000);
  }
}
async function importAsrModel() {
  if (!host() || typeof host().asrImport !== 'function') {
    showToast('导入只在桌面版可用。', 'warn');
    return;
  }
  try {
    const picked = await tauriHost().core.invoke('plugin:dialog|open', {
      options: { directory: true, multiple: false, title: '选择 sherpa-onnx 模型文件夹' },
    });
    const dir = Array.isArray(picked) ? picked[0] : picked;
    if (!dir) return;
    showToast('正在导入模型…', 8000);
    const res = await host().asrImport(dir);
    if (res && res.id) {
      prefs.asrModel = res.id;
      savePrefs();
    }
    await refreshAsrModels();
    showToast('已导入模型：' + ((res && res.name) || dir), 5000);
  } catch (e) {
    showToast('导入失败：' + ((e && e.message) || e), 9000);
  }
}
async function downloadEpisode(show, ep, opts = {}) {
  if (!show || !ep) return;
  const quiet = !!opts.quiet;
  if (!host() || typeof host().offlineSave !== 'function') {
    if (!quiet) showToast('离线下载只在桌面壳里可用（网页版没有本地目录权限）。', 'warn');
    return;
  }
  const src = directAudioUrl(ep.url) || ep.url || '';
  if (!src) { if (!quiet) showToast('这一集没有音频地址。', 'warn'); return; }
  const key = offlineKeyFor(show, ep);
  rememberDownloadMeta(key, show, ep);
  const existing = app.offline.get(key);
  if (existing && existing.hasTranscript) { if (!quiet) showToast('这一集和文字稿都已离线。'); return; }
  if (app.downloading.has(key)) { if (!quiet) showToast('这一集正在下载。'); return; }
  const transcriptable = isJsonTranscript(ep.transcript);
  if (!quiet) showToast(existing ? '正在补下文字稿「' + (ep.title || ep.id) + '」…' : '开始下载「' + (ep.title || ep.id) + '」…');
  app.downloading.add(key);
  let transcriptErr = '';
  try {
    let audioPath = existing && existing.path ? existing.path : '';
    if (!audioPath) {
      audioPath = await host().offlineSave(src, key);
      app.offline.set(key, Object.assign({}, existing || {}, { key, path: audioPath, size: existing?.size || 0, hasTranscript: false }));
    }
    let hasTranscript = !!app.offline.get(key)?.hasTranscript;
    if (transcriptable) {
      try {
        hasTranscript = await saveOfflineTranscript(show, ep);
      } catch (err) {
        hasTranscript = false;
        transcriptErr = (err && err.message) ? err.message : String(err);
      }
    }
    app.offline.set(key, Object.assign({}, app.offline.get(key) || {}, { key, path: audioPath, hasTranscript }));
    await refreshOffline();
    if (!quiet) {
      if (transcriptErr) showToast('音频已下载；文字稿下载失败：' + transcriptErr, 7000);
      else if (hasTranscript) showToast('已下载音频与文字稿，断网也能跟读。');
      else if (ep.transcript && !transcriptable) showToast('音频已下载；此集文字稿格式暂不支持离线。', 6000);
      else showToast('已下载到本机；该集没有文字稿。');
      renderOfflineList();
      renderAfterStateChange();
    }
  } catch (err) {
    if (!quiet) showToast('下载失败：' + (err && err.message ? err.message : err), 'warn');
    else desktopNotify('下载失败', (show.name || '') + ' · ' + (ep.title || ep.id));
  } finally {
    app.downloading.delete(key);
  }
}
async function removeOffline(key) {
  if (!host() || typeof host().offlineRemove !== 'function') return;
  try {
    await host().offlineRemove(key);
    app.offline.delete(key);
    showToast('已删除本地文件。');
    renderOfflineList();
    renderAfterStateChange();
  } catch (err) { showToast('删除失败：' + (err && err.message ? err.message : err), 'warn'); }
}
function offlineEntries() {
  return [...(app.offline ? app.offline.values() : [])];
}
// 离线键是「show slug + '-' + episode id」，两边自己都带连字符（UUID 更是四段），
// 不能用贪婪正则切；按已知 show slug 逐段试，剩下的整段当 episode id 去匹配。
function resolveOfflineRef(key) {
  const s = String(key || '');
  for (let i = s.indexOf('-'); i > 0; i = s.indexOf('-', i + 1)) {
    const show = showByKey(s.slice(0, i));
    if (!show) continue;
    const ep = episodesOf(show).find(e => e.id === s.slice(i + 1));
    if (ep) return { show, ep };
  }
  return null;
}
function offlineLabel(key) {
  const ref = resolveOfflineRef(key);
  if (ref) return (ref.show.name || ref.show.slug) + ' · ' + (ref.ep.title || ref.ep.id);
  const s = String(key || '');
  // 单集列表还没加载时也至少把节目名分出来，不要把整串内部键直接丢给用户看。
  for (let i = s.indexOf('-'); i > 0; i = s.indexOf('-', i + 1)) {
    const show = showByKey(s.slice(0, i));
    if (show) return (show.name || show.slug) + ' · 单集 ' + s.slice(i + 1).slice(0, 8);
  }
  return s;
}
/* 下载时把节目/单集标题记一笔：离线文件只存内部键，节目列表没加载时也能分类、显示标题。 */
function downloadMetaStore() {
  const raw = readJSON(DL_META_KEY, {});
  return raw && typeof raw === 'object' ? raw : {};
}
function rememberDownloadMeta(key, show, ep) {
  if (!key) return;
  const store = downloadMetaStore();
  store[key] = {
    showSlug: show?.slug || show?.key || '',
    showName: show?.name || '',
    artwork: show?.artwork || '',
    epTitle: ep?.title || '',
    epId: ep?.id || '',
    at: Date.now(),
  };
  // 只留最近 500 条，避免长期使用后 localStorage 无限膨胀。
  const keys = Object.keys(store);
  if (keys.length > 500) {
    keys.sort((a, b) => (Number(store[a]?.at) || 0) - (Number(store[b]?.at) || 0));
    keys.slice(0, keys.length - 500).forEach(k => { delete store[k]; });
  }
  writeJSON(DL_META_KEY, store);
}
function showForOfflineKey(key) {
  const s = String(key || '');
  let best = null, bestLen = 0;
  (state.shows || []).forEach(show => {
    const slug = show?.slug || show?.key || '';
    if (!slug || slug.length <= bestLen) return;
    if (s.startsWith(slug + '-')) { best = show; bestLen = slug.length; }
  });
  return best;
}
function downloadInfo(rec) {
  const meta = downloadMetaStore()[rec.key] || {};
  const ref = resolveOfflineRef(rec.key);
  const show = ref?.show || (meta.showSlug ? showByKey(meta.showSlug) : null) || showForOfflineKey(rec.key);
  const s = String(rec.key || '');
  const tail = show ? s.slice((show.slug || show.key || '').length + 1) : s;
  return {
    show,
    groupKey: show?.slug || meta.showSlug || ('name:' + (meta.showName || '未知节目')),
    groupName: show?.name || meta.showName || '未知节目',
    artwork: show?.artwork || meta.artwork || '',
    title: ref?.ep?.title || meta.epTitle || ('单集 ' + tail.slice(0, 12)),
    ep: ref?.ep || null,
  };
}
function downloadsHTML(entries, query) {
  const q = String(query || '').trim().toLowerCase();
  const groups = new Map();
  entries.forEach(rec => {
    const info = downloadInfo(rec);
    if (q && !(info.groupName + ' ' + info.title).toLowerCase().includes(q)) return;
    if (!groups.has(info.groupKey)) groups.set(info.groupKey, { name: info.groupName, artwork: info.artwork, items: [] });
    groups.get(info.groupKey).items.push({ rec, info });
  });
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh')).map(group => {
    const total = group.items.reduce((n, x) => n + (Number(x.rec.size) || 0) + (Number(x.rec.transcriptSize) || 0), 0);
    const rows = group.items.sort((a, b) => String(a.info.title).localeCompare(String(b.info.title), 'zh')).map(({ rec, info }) => {
      const canAddTranscript = !rec.hasTranscript && info.ep && isJsonTranscript(info.ep.transcript);
      const transcript = rec.hasTranscript ? '文字稿 ' + fmtBytes(Number(rec.transcriptSize) || 0) : '仅音频';
      return '<div class="qrow"><div class="qmain"><strong>' + esc(info.title) + '</strong><span>' +
        fmtBytes(Number(rec.size) || 0) + ' · ' + transcript + '</span></div>' +
        '<div style="display:flex;gap:6px">' +
        (canAddTranscript ? '<button class="mini-btn" data-offline-transcript="' + esc(rec.key) + '">＋ 字幕</button>' : '') +
        '<button class="mini-btn" data-play-offline="' + esc(rec.key) + '">▶ 播放</button>' +
        '<button class="mini-btn" data-del-offline="' + esc(rec.key) + '">✕ 删除</button></div></div>';
    }).join('');
    return '<div class="dl-pod"><div class="dl-pod-head">' +
      (group.artwork ? '<img class="dl-art" src="' + esc(group.artwork) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '<div class="dl-art"></div>') +
      '<div><strong>' + esc(group.name) + '</strong><span class="dl-pod-meta">' + group.items.length + ' 集 · ' + fmtBytes(total) + '</span></div></div>' +
      '<div class="dl-rows">' + rows + '</div></div>';
  }).join('');
}
function renderDownloads() {
  const box = $('downloadsGroups');
  if (!box) return;
  const entries = offlineEntries();
  const totalBytes = entries.reduce((n, e) => n + (Number(e.size) || 0) + (Number(e.transcriptSize) || 0), 0);
  const groups = new Set(entries.map(rec => downloadInfo(rec).groupKey)).size;
  const hint = $('downloadsHint');
  if (hint) hint.textContent = entries.length
    ? entries.length + ' 集 · ' + groups + ' 个节目 · 共 ' + fmtBytes(totalBytes)
    : '还没有下载到本机的单集。';
  const q = $('downloadsFilter') ? $('downloadsFilter').value : '';
  const html = entries.length ? downloadsHTML(entries, q) : '';
  box.innerHTML = html || (entries.length
    ? '<div class="dl-empty">没有匹配的下载。换个关键词试试。</div>'
    : emptyLine('还没有下载到本机的单集。在单集页点「⤓ 整集下载」。'));
}
function renderOfflineList() {
  const box = $('offlineList');
  const hint = $('offlineHint');
  if (!box) return;
  const entries = offlineEntries();
  const totalBytes = entries.reduce((n, e) => n + (Number(e.size) || 0) + (Number(e.transcriptSize) || 0), 0);
  if (hint) hint.textContent = entries.length
    ? entries.length + ' 集 · ' + fmtBytes(totalBytes) + ' · ' + entries.filter(e => e.hasTranscript).length + ' 集含字幕'
    : '断网也能听';
  box.innerHTML = entries.length
    ? entries.map(rec => {
      const ref = resolveOfflineRef(rec.key);
      const ep = ref && ref.ep;
      const size = fmtBytes(Number(rec.size) || 0);
      const transcript = rec.hasTranscript
        ? '文字稿 ' + fmtBytes(Number(rec.transcriptSize) || 0)
        : (ep && isJsonTranscript(ep.transcript) ? '仅音频 · 可补字幕' : '仅音频');
      const canAddTranscript = !rec.hasTranscript && ep && isJsonTranscript(ep.transcript);
      return '<div class="qrow"><div class="qmain"><strong>' + esc(offlineLabel(rec.key)) +
        '</strong><span>' + size + ' · ' + transcript + ' · 存在本机</span></div>' +
        '<div style="display:flex;gap:6px">' +
        (canAddTranscript ? '<button class="mini-btn" data-offline-transcript="' + esc(rec.key) + '">＋ 字幕</button>' : '') +
        '<button class="mini-btn" data-play-offline="' + esc(rec.key) + '">▶ 播放</button>' +
        '<button class="mini-btn" data-del-offline="' + esc(rec.key) + '">✕</button></div></div>';
    }).join('')
    : emptyLine('还没有离线单集。在单集页点「⤓ 整集下载」，音频和文字稿会一起保存。');
}
function playOffline(key) {
  const rec = app.offline.get(key);
  if (!rec || !host() || typeof host().asset !== 'function') { showToast('本地文件不见了。', 'warn'); return; }
  const ref = resolveOfflineRef(key);
  if (ref) { playEpisode(ref.show.slug, ref.ep.id); return; }
  audio.src = host().asset(rec.path);
  audio.load();
  audio.play().catch(() => {});
}


findInput.addEventListener('input', () => runFind(findInput.value));
findInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    showFindAt(findAt + (e.shiftKey ? -1 : 1), true);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeFind();
  }
});
$('findPrev').addEventListener('click', () => showFindAt(findAt - 1, true));
$('findNext').addEventListener('click', () => showFindAt(findAt + 1, true));
$('findClose').addEventListener('click', closeFind);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (state.wallpaper) { setWallpaper(false); return; }
    if (state.seekPreview != null) { endSeekPreview(false); paint(true); return; }
    if ($('modal').open) { closeModal(); return; }
    if ($('studySheet')?.classList.contains('on')) { closeStudySheet(); return; }
    if ($('wordPanel')?.classList.contains('on')) { closeWordPanel(); return; }
    if ($('chapterSheet')?.classList.contains('on')) { toggleChapterSheet(false); return; }
    if (findBar.classList.contains('on')) { closeFind(); return; }
    if (selTools.classList.contains('on')) { hideSelTools(); return; }
    if (state.alignMode) { setAlignMode(false); showToast('已取消对齐。', 2500); }
    else if ($('typeSheet').classList.contains('on')) closeTypeSheet();
    else if (dockSheet.classList.contains('on')) closeDockSheet();
    else if ($('drawer').classList.contains('on') || $('details').classList.contains('on')) closeOverlays();
    else if (state.immersive) setImmersive(false);
    return;
  }
  if ($('modal').open) return;
  // Ctrl/Cmd+F 与 / 打开本集内搜索（输入框里的按键不劫持）。
  // 进度条/音量是 range input，点过之后焦点会留在上面；它们不算「正在打字」，
  // 否则 Space、方向键、/ 会被这里的早退全部吞掉。
  const typing = e.target.closest('input:not([type="range"]), select, textarea, [contenteditable="true"]');
  if (!typing && (e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault(); openFind(); return;
  }
  if (typing) return;
  // 组件自己已经处理过这个键（单选组用方向键切项、滑杆用方向键调值）就别再触发全局快捷键，
  // 否则方向键会同时「切下一项」和「跳下一句」，看起来像乱跳。
  if (e.defaultPrevented) return;
  const onRange = e.target.closest('input[type="range"]');
  if (onRange && (e.code === 'ArrowLeft' || e.code === 'ArrowRight' || e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
    // 进度条保持「15s / 30s」的跳法，别退化成原生 range 的 0.1%（长节目里几乎没反应）；
    // 音量条等其它滑杆交还原生，方向键按它们的 step 调。
    if (e.target.id === 'seek' && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
      e.preventDefault();
      seekBy(e.code === 'ArrowLeft' ? -15 : 30);
    }
    return;
  }
  // 只有我们会接管的键才把焦点从底栏/面板按钮上抢回来：Enter、Tab 之类留给按钮自己，
  // 否则键盘就没法激活面板里的按钮了。
  const shortcutKey = e.code === 'Space' || e.code === 'ArrowLeft' || e.code === 'ArrowRight'
    || e.code === 'ArrowUp' || e.code === 'ArrowDown'
    || ['/', 'j', 'J', 'k', 'K', '[', ']', 'm', 'M', 'n', 'N', 'p', 'P', 's', 'S'].includes(e.key);
  if (shortcutKey && e.target.closest('button, a, summary, [role="link"], [role="button"]')) {
    // 焦点停在底栏/面板按钮上时（很多是点过一次就留下焦点），把键盘交回全局快捷键，
    // 并先 blur 掉按钮，否则 Space 会在 keyup 时又触发一次按钮自己。
    if (!e.target.closest('.dock, .docksheet')) return;
    if (typeof e.target.blur === 'function') e.target.blur();
  }
  if (e.key === '/') { e.preventDefault(); openFind(); }
  else if (e.code === 'Space') { e.preventDefault(); $('play').click(); }
  else if (e.code === 'ArrowLeft') { e.preventDefault(); seekBy(-15); }
  else if (e.code === 'ArrowRight') { e.preventDefault(); seekBy(30); }
  else if (e.code === 'ArrowUp' || e.key === 'k' || e.key === 'K') { e.preventDefault(); jumpCue(-1); }
  else if (e.code === 'ArrowDown' || e.key === 'j' || e.key === 'J') { e.preventDefault(); jumpCue(1); }
  else if (e.key === '[') { e.preventDefault(); jumpCue(-1); }
  else if (e.key === ']') { e.preventDefault(); jumpCue(1); }
  else if (e.key === 'm' || e.key === 'M') { e.preventDefault(); toggleMute(); }
  else if (e.key === 's' || e.key === 'S') { e.preventDefault(); toggleStudySheet(); }
  else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); stepEpisode(1); }
  else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); stepEpisode(-1); }
});
/* S = 打开/收起 AI 学英语面板。原来只能点右下角「⋯ → AI 学英语」，
   鼠标点不到或纯键盘场景就没入口；面板里已有 Tab/Enter/Escape 通道，补齐这个开关即可。 */
function toggleStudySheet() {
  if (typeof moduleOn === 'function' && !moduleOn('study')) { showToast('AI 学英语模块已关闭。', 5000); return; }
  if ($('studySheet')?.classList.contains('on')) { closeStudySheet(); return; }
  openStudySheet();
}
/* 播放时钟：只在播放时按 ~8Hz 刷新，暂停/窗口隐藏时彻底停表。
   原来是无条件 60fps 的 requestAnimationFrame 常驻循环——即使暂停也在每秒唤醒 60 次，
   而且每帧都要写时间标签、读两次 getBoundingClientRect（强制同步布局）。 */
const PLAY_TICK_MS = 120;
const IDLE_TICK_MS = 500;
let playTick = 0, playTickMs = 0;
function desiredPlayTick() {
  if (document.hidden) return 0;
  return document.hasFocus() ? PLAY_TICK_MS : IDLE_TICK_MS;
}
function startPlayTick(force = false) {
  const ms = desiredPlayTick();
  if (!ms) { stopPlayTick(); return; }
  if (playTick && !force && playTickMs === ms) return;
  stopPlayTick();
  playTickMs = ms;
  playTick = setInterval(() => {
    if (audio.paused) { stopPlayTick(); paint(); return; }
    paint();
  }, ms);
}
function stopPlayTick() { if (playTick) { clearInterval(playTick); playTick = 0; playTickMs = 0; } }
audio.addEventListener('play', () => { startPlayTick(); paint(true); });
audio.addEventListener('pause', () => { stopPlayTick(); paint(true); });
audio.addEventListener('ended', () => { stopPlayTick(); paint(true); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopPlayTick(); return; }
  if (!audio.paused) { startPlayTick(true); paint(true); }
});
window.addEventListener('blur', () => { if (!audio.paused) startPlayTick(true); });
window.addEventListener('focus', () => { if (!audio.paused && !document.hidden) { startPlayTick(true); paint(true); } });
if (!audio.paused) startPlayTick();
/* ===================== app shell ===================== */
const SUBS_KEY = 'myt-subs', QUEUE_KEY = 'myt-queue', BOOKMARK_KEY = 'myt-bookmarks',
  NOTE_KEY = 'myt-notes', PREFS_KEY = 'myt-prefs', PLAYLIST_KEY = 'myt-playlists',
  AUTO_KEY = 'myt-auto', FAV_KEY = 'myt-favorites', PLAYED_KEY = 'myt-played',
  INBOX_KEY = 'myt-inbox', SEEN_KEY = 'myt-seen', SHOWPREFS_KEY = 'myt-showprefs',
  LOCAL_KEY = 'myt-local', DL_META_KEY = 'myt-download-meta';
const AUTO_DEFAULTS = {
  refreshHours: 0, autoDownload: false, downloadCount: 1, deletePlayed: false,
  deleteNotInQueue: false, keepFavorites: true, capMB: 2048, notify: true,
  lastRefreshAt: 0,
};
const app = {
  builtinShows: [], catalog: null, catalogBySlug: new Map(), subs: [], queue: [], bookmarks: [], notes: [],
  playlists: [], offline: new Map(), feedCache: new Map(), route: { page: 'home', args: [], params: new URLSearchParams() },
  plugins: [], pluginErrors: new Map(), pluginPageActive: null, subtitleOwner: '', studyOwner: '', capabilities: Object.create(null),
  lastPage: 'home', lastShowKey: '', appearance: 'default', cont: 'single', sleepUntil: 0, sleepEnd: false,
  sleepTimer: 0, pendingSeek: 0, pendingSeekEp: '', autoplay: false, feedErrors: null, initialized: false,
  catalogPending: true, catalogFailed: false, catalogPromise: null,
  discover: { query: '', category: '', sort: 'default', sub: 'all', transcripts: false },
  online: { query: '', loading: false, results: [], sources: [], piError: '', error: '', seq: 0, cache: new Map(), visible: 20 },
  asrModels: [], asrBusy: new Map(), asrModelsErr: '', chaptersCache: new Map(),
  auto: { ...AUTO_DEFAULTS }, favorites: new Set(), played: {}, inbox: [], seen: {}, showPrefs: {},
  downloading: new Set(), transcriptDownloads: new Set(), autoTimer: 0, refreshBusy: false, epFilter: 'all', local: [],
};
const ASR_MODEL_DEFAULT = 'en-mini';
let prefs = { speed: 1, autoNext: false, remember: true, liveLead: LIVE_LEAD_DEFAULT, liveMse: false, volume: 1, volumeCap: 1, muted: false, asrModel: ASR_MODEL_DEFAULT, queueOrder: 'sequential', skipAds: false, skipLevel: 2, skipSilence: false, loudness: false, skipChapterAds: false, modules: { discover: true, search: true, local: true, inbox: true, queue: true, history: true, stats: true, favorites: true, bookmarks: true, notes: true, listening: true, video: true, transcript: true, liveAsr: true, translate: true, floatWindow: true, chapters: true, offline: true, exportShare: true, study: true } };
const PAGE_NAMES = {
  home: '首页', library: '播客库', local: '本地文件', downloads: '下载管理', video: '视频播放', discover: '发现', search: '搜索', podcast: '节目详情',
  episode: '单集详情', player: '播放器', inbox: '收件箱', queue: '播放队列', history: '收听历史',
  favorites: '收藏', bookmarks: '书签', notes: '笔记', listening: '收听模式', settings: '设置', stats: '统计与回顾', plugin: '插件',
};
const SIDEBAR_TOP = ['home', 'library', 'local', 'downloads', 'discover', 'search'];
const SIDEBAR_BOTTOM = ['inbox', 'queue', 'history', 'stats', 'favorites', 'bookmarks', 'notes', 'listening', 'settings'];
const SIDEBAR_META = {
  home: ['⌂', '首页'], library: ['▦', '播客库'], local: ['▤', '本地文件'], downloads: ['⤓', '下载管理'], discover: ['✦', '发现'], search: ['⌕', '搜索'],
  inbox: ['◫', '收件箱'], queue: ['☷', '播放队列'], history: ['◷', '收听历史'], stats: ['▥', '统计与回顾'],
  favorites: ['★', '收藏'], bookmarks: ['☆', '书签'], notes: ['▤', '笔记'], listening: ['♫', '收听模式'], settings: ['⚙', '设置'],
};
const THEME_NAMES = {
  brass: '档案', midnight: '午夜蓝', forest: '墨绿', oxblood: '酒红',
  celadon: '青瓷', paper: '纸张', mist: '雾白', prototype: '原型', ledger: '编辑部',
};

function readJSON(key, fallback) {
  try { const value = JSON.parse(localStorage.getItem(key) || 'null'); return value == null ? fallback : value; }
  catch (e) { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
}
function whenIdle(fn, timeout = 1200) {
  if ('requestIdleCallback' in window) return requestIdleCallback(fn, { timeout });
  return setTimeout(fn, 0);
}
const IDX_DB = 'myt-transcript-index', IDX_STORE = 'episodes';
let idxDbPromise = null;
function idxDb() {
  if (idxDbPromise) return idxDbPromise;
  idxDbPromise = new Promise(resolve => {
    if (!window.indexedDB) { resolve(null); return; }
    const req = indexedDB.open(IDX_DB, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(IDX_STORE)) req.result.createObjectStore(IDX_STORE, { keyPath: 'id' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return idxDbPromise;
}
async function idxPut(record) {
  const db = await idxDb(); if (!db) return false;
  return new Promise(resolve => {
    const tx = db.transaction(IDX_STORE, 'readwrite');
    tx.objectStore(IDX_STORE).put(record);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}
async function idxGetAll() {
  const db = await idxDb(); if (!db) return [];
  return new Promise(resolve => {
    const tx = db.transaction(IDX_STORE, 'readonly');
    const req = tx.objectStore(IDX_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}
async function idxGet(id) {
  const db = await idxDb(); if (!db) return null;
  return new Promise(resolve => {
    const tx = db.transaction(IDX_STORE, 'readonly');
    const req = tx.objectStore(IDX_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}
async function idxClear() {
  const db = await idxDb(); if (!db) return;
  await new Promise(resolve => {
    const tx = db.transaction(IDX_STORE, 'readwrite');
    tx.objectStore(IDX_STORE).clear();
    tx.oncomplete = resolve; tx.onerror = resolve;
  });
}
async function idxCount() { return (await idxGetAll()).length; }
async function indexEpisode(show, ep, quiet = true) {
  if (!show || !ep || !ep.transcript?.url) return false;
  const key = epKey(show.slug, ep.id);
  const existing = await idxGet(key);
  if (existing) return true;
  const { doc } = await readTranscriptDoc(show, ep);
  if (!doc) return false;
  const built = cuesFromJson(doc);
  const lines = (built.vtt || []).map(cue => ({ s: Number(cue.start) || 0, t: String(cue.text || '').trim(), z: String(cue.zh || '').trim() }))
    .filter(line => line.t || line.z);
  if (!lines.length) return false;
  const text = lines.map(line => line.t + ' ' + line.z).join('\n').toLowerCase();
  await idxPut({ id: key, show: show.slug, showName: show.name || '', title: ep.title || '', url: ep.transcript.url, lines, text, at: Date.now() });
  if (!quiet) showToast('已索引：' + (ep.title || ''), 2000);
  return true;
}
async function indexCurrentEpisode(show, ep) {
  if (!show || !ep) return;
  try { await indexEpisode(show, ep, true); syncIndexCount(); } catch (e) {}
}
async function indexAllShows() {
  const shows = state.shows.filter(show => show.feed || show.builtin);
  if (!shows.length) { showToast('还没有可索引的节目。', 'warn'); return; }
  let total = 0, done = 0, ok = 0;
  showToast('开始索引全部订阅，共 ' + shows.length + ' 档；可以继续做别的事。', 8000);
  for (let si = 0; si < shows.length; si++) {
    const show = shows[si];
    let episodes = memoryFeed(show)?.episodes;
    if (!episodes && show.feed) {
      try {
        const xml = await fetchFeedText(show.feed);
        const feed = parseFeed(xml);
        rememberFeed(show.slug, feed);
        episodes = feed.episodes;
      } catch (e) {}
    }
    episodes = (episodes || []).filter(ep => ep.transcript?.url);
    total += episodes.length;
    if (!episodes.length) continue;
    for (const ep of episodes) {
      if (await indexEpisode(show, ep, true)) ok++;
      done++;
      const status = $('idxStatus');
      if (status && done % 5 === 0) status.textContent = '索引中 ' + done + ' 集（成功 ' + ok + '）· ' + show.name;
      syncIndexCount();
      await new Promise(resolve => setTimeout(resolve, 80));
    }
  }
  const status = $('idxStatus');
  if (status) status.textContent = '索引完成：' + ok + ' / ' + total + ' 集';
  showToast('全部索引完成：' + ok + ' / ' + total + ' 集。', 8000);
  syncIndexCount();
  if (searchTab === 'library') renderSearch($('searchInput')?.value || '');
}
async function indexCurrentShow() {
  const show = state.show;
  if (!show) { showToast('先打开一档节目。', 'warn'); return; }
  const episodes = (state.episodes.length ? state.episodes : episodesOf(show)).filter(ep => ep.transcript?.url);
  if (!episodes.length) { showToast('这档节目没有可索引的文字稿。', 'warn'); return; }
  let done = 0, ok = 0;
  showToast('开始索引「' + show.name + '」共 ' + episodes.length + ' 集…', 8000);
  for (const ep of episodes) {
    if (await indexEpisode(show, ep, true)) ok++;
    done++;
    if (done % 5 === 0 || done === episodes.length) {
      const status = $('idxStatus');
      if (status) status.textContent = '索引中 ' + done + ' / ' + episodes.length + '（成功 ' + ok + '）';
      syncIndexCount();
    }
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  showToast('索引完成：' + ok + ' / ' + episodes.length + ' 集。', 6000);
  syncIndexCount();
  if (searchTab === 'library') renderSearch($('searchInput')?.value || '');
}
function syncIndexCount() {
  idxCount().then(count => { const el = $('idxCount'); if (el) el.textContent = String(count); });
}
function hash32(text) {
  let h = 2166136261;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
function normalizeFeedUrl(url) {
  let s = String(url || '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  return s;
}
function extSlug(url) { return 'ext-' + hash32(normalizeFeedUrl(url)); }
function hostOf(url) {
  try { return new URL(url, location.href).hostname.replace(/^www\./, ''); } catch (e) { return String(url || ''); }
}
function absoluteUrl(url) {
  try { return new URL(url, location.href).href; } catch (e) { return String(url || ''); }
}
function absoluteFeed(feed) { return feed ? absoluteUrl(feed) : ''; }
function cleanFeedTitle(title) {
  return String(title || '')
    .replace(/\s*\((?:unofficial|非官方)[^)]*\)\s*/gi, ' ')
    .replace(/\s*[-–—]\s*transcripts?\s*$/i, '')
    .replace(/\s+/g, ' ').trim();
}
function findBuiltinByFeed(url) {
  const want = feedKey(url);
  if (!want) return null;
  return app.builtinShows.find(show => show.feed && feedKey(absoluteFeed(show.feed)) === want) || null;
}
function showByKey(key) {
  return state.shows.find(s => s.slug === key || s.key === key)
    || app.builtinShows.find(s => s.slug === key) || null;
}
function externalShow(rec) {
  return {
    slug: rec.key, key: rec.key, name: rec.name || hostOf(rec.feed), feed: rec.feed || '',
    builtin: false, artwork: rec.artwork || '', description: rec.description || '',
    latest: [], episode_count: 0,
  };
}
function localShowRecord() {
  return {
    slug: 'local-files', key: 'local-files', name: '本地文件', builtin: false, local: true,
    feed: '', artwork: '', description: '从本机文件夹导入的音频，不会上传。',
    latest: [], episode_count: app.local.length, transcript_count: 0, categories: [], order: 999,
  };
}
function refreshShows() {
  const ext = app.subs.filter(s => !s.builtin).map(externalShow);
  setState('shows', [...app.builtinShows, ...ext]);
  if (app.local.length) state.shows.push(localShowRecord());
  syncShowSelect();
}
function syncShowSelect() {
  const select = $('showSel');
  if (!select) return;
  select.innerHTML = state.shows.map(s => '<option value="' + esc(s.slug) + '">' + esc(s.name) + '</option>').join('');
  if (state.show?.slug) select.value = state.show.slug;
  select.onchange = e => loadShow(e.target.value);
}
function isSubscribed(key) { return app.subs.some(s => s.key === key); }
function saveSubs() {
  writeJSON(SUBS_KEY, app.subs.map(s => ({
    key: s.key, feed: s.feed || '', name: s.name || '', builtin: !!s.builtin,
    artwork: s.artwork || '', description: s.description || '', addedAt: s.addedAt || Date.now(),
  })));
}
function subscribeShow(show) {
  if (!show || isSubscribed(show.slug)) return false;
  app.subs.push({
    key: show.slug, feed: show.feed || '', name: show.name || '', builtin: !!show.builtin,
    artwork: show.artwork || '', description: show.description || '', addedAt: Date.now(),
  });
  saveSubs(); refreshShows(); return true;
}
function subscribeRecord(rec) {
  if (!rec || !rec.key || isSubscribed(rec.key)) return false;
  app.subs.push(rec); saveSubs(); refreshShows(); return true;
}
function removalLeavesCurrentShow(route, key) {
  return !!key && ['podcast', 'episode', 'player'].includes(route?.page) && (route?.args?.[0] || '') === key;
}
function unsubscribeKey(key) {
  app.subs = app.subs.filter(s => s.key !== key);
  app.feedErrors?.delete(key);
  saveSubs(); refreshShows();
  if (removalLeavesCurrentShow(parseRoute(), key)) { navigate('home'); return; }
  renderAfterStateChange();
}
function catalogLatest(show) {
  return (show && show.latest && show.latest.length ? show.latest : app.catalogBySlug.get(show?.slug)?.latest) || [];
}
function episodesOf(show) {
  if (show?.local) return app.local.map(ep => ({ ...ep, showKey: show.slug }));
  const feed = memoryFeed(show);
  if (feed?.episodes?.length) return feed.episodes;
  return catalogLatest(show).map(ep => ({ ...ep, showKey: show.slug }));
}
function readAllProgress() { return progressAll(); }
/* ---------- 收藏 / 已听 / 收件箱 / 订阅自动化 ---------- */
function saveFavorites() { writeJSON(FAV_KEY, [...app.favorites]); }
function savePlayed() { writeJSON(PLAYED_KEY, app.played); }
function saveInbox() { writeJSON(INBOX_KEY, app.inbox); }
function saveSeen() { writeJSON(SEEN_KEY, app.seen); }
function saveShowPrefs() { writeJSON(SHOWPREFS_KEY, app.showPrefs); }
function showPrefFor(showKey) {
  return Object.assign({ autoDownload: true, autoDelete: true, notify: true, speed: 0, skipIntro: 0, skipOutro: 0 }, app.showPrefs[showKey] || {});
}
function setShowPref(showKey, patch) {
  app.showPrefs[showKey] = Object.assign(showPrefFor(showKey), patch || {});
  saveShowPrefs();
}
function isFavorite(showKey, epId) { return app.favorites.has(epKey(showKey, epId)); }
function toggleFavorite(showKey, epId) {
  const key = epKey(showKey, epId);
  if (app.favorites.has(key)) app.favorites.delete(key); else app.favorites.add(key);
  saveFavorites();
  return app.favorites.has(key);
}
function isPlayed(showKey, epId) {
  const key = epKey(showKey, epId);
  if (app.played[key]) return true;
  const rec = readAllProgress()[key];
  return !!(rec && Number(rec.d) > 0 && Number(rec.t) >= Number(rec.d) - 30);
}
function setPlayed(showKey, epId, value) {
  const key = epKey(showKey, epId);
  if (value) app.played[key] = Date.now(); else delete app.played[key];
  savePlayed();
  renderAfterStateChange();
}
function markCurrentPlayed() {
  if (!state.show?.slug || !state.current?.id) return;
  app.played[epKey(state.show.slug, state.current.id)] = Date.now();
  savePlayed();
}
function addInboxItem(show, ep) {
  if (!show || !ep) return false;
  const key = epKey(show.slug, ep.id);
  if (app.inbox.some(item => item.key === key)) return false;
  app.inbox.unshift({
    key, showKey: show.slug, ep: ep.id, show: show.name || show.slug, title: ep.title || '',
    date: ep.date || '', duration: ep.duration || '', img: ep.img || '', at: Date.now(),
  });
  saveInbox();
  return true;
}
function inboxRemove(key) {
  app.inbox = app.inbox.filter(item => item.key !== key);
  saveInbox();
}
function inboxCount() { return app.inbox.length; }
function episodeFilterMatch(showKey, ep, filter) {
  if (filter === 'unplayed') return !isPlayed(showKey, ep.id);
  if (filter === 'played') return isPlayed(showKey, ep.id);
  if (filter === 'favorite') return isFavorite(showKey, ep.id);
  if (filter === 'offline') return app.offline.has(offlineKeyFor(showByKey(showKey), ep));
  return true;
}
function epStatusBadges(showKey, ep) {
  const bits = [];
  if (isFavorite(showKey, ep.id)) bits.push('<span class="pill">★ 收藏</span>');
  if (isPlayed(showKey, ep.id)) bits.push('<span class="pill dim">已听</span>');
  const rec = app.offline ? app.offline.get(offlineKeyFor(showByKey(showKey), ep)) : null;
  if (rec) bits.push('<span class="pill dim">离线' + (rec.hasTranscript ? ' · 字幕' : '') + '</span>');
  return bits.length ? '<span class="ep-badges">' + bits.join('') + '</span>' : '';
}
function formatDate(value) {
  const d = Date.parse(value || '');
  return Number.isFinite(d) ? new Date(d).toLocaleDateString('zh-CN') : '';
}
function fmtDuration(value) {
  if (value == null || value === '') return '';
  const text = String(value);
  if (text.includes(':')) return text;
  const seconds = Number(text);
  return Number.isFinite(seconds) && seconds > 0 ? fmt(seconds) : '';
}
function plainText(text) {
  const holder = document.createElement('div');
  holder.innerHTML = String(text || '');
  return (holder.textContent || '').replace(/\s+/g, ' ').trim();
}
function routeHash(page, args = [], params = {}) {
  const path = '#/' + [page, ...args.filter(x => x != null && x !== '').map(encodeURIComponent)].join('/');
  const query = new URLSearchParams(params).toString();
  return path + (query ? '?' + query : '');
}
const MODULE_ROUTES = {
  discover: 'discover', search: 'search', local: 'local', inbox: 'inbox', queue: 'queue',
  history: 'history', stats: 'stats', favorites: 'favorites', bookmarks: 'bookmarks',
  notes: 'notes', listening: 'listening', video: 'video', downloads: 'offline',
};
function moduleOn(key) { return !prefs.modules || prefs.modules[key] !== false; }
function routeModuleAllows(page) { const key = MODULE_ROUTES[page]; return !key || moduleOn(key); }
function setNodeVisible(node, visible) {
  if (!node) return;
  node.style.display = visible ? '' : 'none';
}
function normalizeSidebarPrefs(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const order = src.order && typeof src.order === 'object' ? src.order : {};
  const clean = (list, defaults) => {
    const picked = (Array.isArray(list) ? list : []).filter(route => defaults.includes(route));
    return [...new Set([...picked, ...defaults])];
  };
  return {
    order: { top: clean(order.top, SIDEBAR_TOP), bottom: clean(order.bottom, SIDEBAR_BOTTOM) },
    hidden: [...new Set((Array.isArray(src.hidden) ? src.hidden : []).filter(route => SIDEBAR_META[route]))],
  };
}
function sidebarOrder(group) {
  if (!prefs.sidebar) prefs.sidebar = normalizeSidebarPrefs(null);
  return prefs.sidebar.order[group] || (group === 'top' ? SIDEBAR_TOP : SIDEBAR_BOTTOM);
}
function applySidebarCustomization() {
  if (!prefs.sidebar) prefs.sidebar = normalizeSidebarPrefs(null);
  const hidden = new Set(prefs.sidebar.hidden);
  [['top', 'sideNav'], ['bottom', 'sideNav2']].forEach(([group, id]) => {
    const nav = $(id);
    if (!nav) return;
    sidebarOrder(group).forEach(route => {
      const btn = nav.querySelector('[data-route="' + route + '"]');
      if (!btn) return;
      nav.appendChild(btn);
      setNodeVisible(btn, !hidden.has(route) && routeModuleAllows(route));
    });
  });
  const mobile = $('mobileNav');
  if (mobile) {
    mobile.querySelectorAll('[data-route]').forEach(btn => {
      const route = btn.dataset.route;
      setNodeVisible(btn, !hidden.has(route) && routeModuleAllows(route));
    });
  }
}
function applyModules() {
  Object.keys(MODULE_ROUTES).forEach(page => {
    const on = moduleOn(MODULE_ROUTES[page]);
    ['sideNav', 'sideNav2', 'mobileNav'].forEach(id => {
      const nav = $(id);
      if (nav) nav.querySelectorAll('[data-route="' + page + '"]').forEach(btn => setNodeVisible(btn, on));
    });
    setNodeVisible($('page-' + page), on);
  });
  const route = parseRoute();
  if (!routeModuleAllows(route.page) && !document.body.classList.contains('player-open')) navigate('home');
  const flags = {
    'mod-off-liveAsr': !moduleOn('liveAsr'),
    'mod-off-translate': !moduleOn('translate'),
    'mod-off-floatWindow': !moduleOn('floatWindow'),
    'mod-off-chapters': !moduleOn('chapters'),
    'mod-off-offline': !moduleOn('offline'),
    'mod-off-exportShare': !moduleOn('exportShare'),
    'mod-off-study': !moduleOn('study'),
  };
  Object.keys(flags).forEach(cls => document.body.classList.toggle(cls, flags[cls]));
  if (!moduleOn('study') && $('studySheet')?.classList.contains('on')) closeStudySheet();
  if (!moduleOn('liveAsr') && typeof LIVE !== 'undefined' && LIVE.on) liveDisable('实时识别模块已关闭。');
  if (!moduleOn('chapters') && $('chapterSheet')?.classList.contains('on')) toggleChapterSheet(false);
  if (!moduleOn('translate') && typeof TR !== 'undefined' && TR.on) { TR.on = false; trSave(); syncTranslateSettings(); }
  if (!moduleOn('transcript') && state.cues.length) {
    box.innerHTML = '<div class="empty">文字稿模块已关闭，可在「设置 → 模块开关」重新开启。</div>';
    setState('cues', []); setState('nodes', []); setState('activeCue', -1);
  }
  applySidebarCustomization();
}
function bindModuleSwitches() {
  document.querySelectorAll('[data-module]').forEach(btn => {
    btn.onclick = () => {
      const key = btn.dataset.module;
      prefs.modules[key] = !moduleOn(key);
      savePrefs();
      btn.setAttribute('aria-checked', String(moduleOn(key)));
      applyModules();
      showToast((moduleOn(key) ? '已开启：' : '已关闭：') + (btn.closest('.setting-row')?.querySelector('strong')?.textContent || key));
    };
  });
}
function navigate(page, args = [], params = {}) {
  if (!routeModuleAllows(page)) page = 'home';
  if (page !== 'player' && $('clipNowPop')) $('clipNowPop').hidden = true;
  location.hash = routeHash(page, args, params);
}
function parseRoute() {
  const raw = String(location.hash || '').replace(/^#\/?/, '');
  const [pathPart, queryPart = ''] = raw.split('?');
  const args = pathPart.split('/').filter(Boolean).map(part => {
    try { return decodeURIComponent(part); } catch (e) { return part; }
  });
  return { page: args[0] || 'home', args: args.slice(1), params: new URLSearchParams(queryPart) };
}
function firstShowKey() {
  const sub = app.subs.find(s => showByKey(s.key)?.feed);
  return sub?.key || app.builtinShows.find(s => s.feed)?.slug || '';
}
function renderAfterStateChange() {
  if (document.body.classList.contains('player-open')) { syncMini(); return; }
  const r = parseRoute();
  renderPage(r.page, r);
  syncMini();
}

/* layer: bridge —— 目录/feed 缓存、OPML、在线搜索
   本片只做该层的事，跨层调用走 kernel / host() / setState。 */
/* ---------- catalog + local state ---------- */
async function loadCatalog() {
  app.catalogPending = true;
  try {
    const catalog = await getJson('catalog.json', CATALOG_TIMEOUT);
    if (!catalog || !Array.isArray(catalog.shows)) return false;
    app.catalog = catalog;
    catalog.shows.forEach(show => app.catalogBySlug.set(show.slug, show));
    return true;
  } catch (e) {
    return false;
  } finally {
    app.catalogPending = false;
  }
}
function catalogFields(cat) {
  return {
    artwork: cat.artwork || '',
    description: cat.description || '',
    episode_count: Number(cat.episode_count) || 0,
    transcript_count: Number(cat.transcript_count) || 0,
    latest_transcript_count: Number(cat.latest_transcript_count) || 0,
    latest_published_at: cat.latest_published_at || '',
    language: cat.language || '',
    categories: Array.isArray(cat.categories) ? cat.categories : [],
    latest: Array.isArray(cat.latest) ? cat.latest : [],
  };
}
function mergeCatalog() {
  if (!app.catalog) return;
  app.builtinShows = app.builtinShows.map(show => {
    const cat = app.catalogBySlug.get(show.slug);
    if (!cat) return show;
    const fields = catalogFields(cat);
    return {
      ...show,
      ...fields,
      feed: show.feed || cat.feed,
      artwork: fields.artwork || show.artwork || '',
      description: fields.description || show.description || '',
    };
  });
  for (const cat of app.catalog.shows) {
    if (app.builtinShows.some(show => show.slug === cat.slug)) continue;
    const fields = catalogFields(cat);
    app.builtinShows.push({
      slug: cat.slug, key: cat.slug, name: cleanFeedTitle(cat.name) || cat.slug, feed: cat.feed,
      builtin: true, ...fields,
    });
  }
}
function loadLocalState() {
  app.queue = readJSON(QUEUE_KEY, []) || [];
  app.playlists = readJSON(PLAYLIST_KEY, []) || [];
  app.bookmarks = readJSON(BOOKMARK_KEY, []) || [];
  app.notes = readJSON(NOTE_KEY, []) || [];
  app.auto = Object.assign({}, AUTO_DEFAULTS, readJSON(AUTO_KEY, {}) || {});
  app.favorites = new Set(readJSON(FAV_KEY, []) || []);
  app.played = readJSON(PLAYED_KEY, {}) || {};
  app.inbox = readJSON(INBOX_KEY, []) || [];
  app.seen = readJSON(SEEN_KEY, {}) || {};
  app.showPrefs = readJSON(SHOWPREFS_KEY, {}) || {};
  app.local = readJSON(LOCAL_KEY, []) || [];
  prefs = Object.assign({ speed: 1, autoNext: false, remember: true, liveLead: LIVE_LEAD_DEFAULT, liveMse: false, volume: 1, muted: false, asrModel: ASR_MODEL_DEFAULT }, readJSON(PREFS_KEY, {}) || {});
  prefs.modules = Object.assign({
    discover: true, search: true, local: true, inbox: true, queue: true, history: true,
    stats: true, favorites: true, bookmarks: true, notes: true, listening: true,
    video: true, transcript: true, liveAsr: true, translate: true, floatWindow: true,
    chapters: true, offline: true, exportShare: true, study: true,
  }, prefs.modules || {});
  prefs.sidebar = normalizeSidebarPrefs(prefs.sidebar);
applyVolume(false);
  const stored = localStorage.getItem(SUBS_KEY);
  if (stored == null) {
    app.subs = [];
    saveSubs();
  } else {
    app.subs = (readJSON(SUBS_KEY, []) || []).map(rec => {
      const builtin = app.builtinShows.find(s => s.slug === rec.key);
      return Object.assign({}, rec, {
        builtin: !!builtin || rec.builtin === true,
        feed: rec.feed || builtin?.feed || '',
        name: rec.name || builtin?.name || '',
        artwork: rec.artwork || builtin?.artwork || '',
        description: rec.description || builtin?.description || '',
      });
    });
  }
  // 界面与续播拆成两组独立设置；旧的 myt-play-mode 一次性迁移后再删掉。
  const legacyMode = localStorage.getItem('myt-play-mode') || '';
  app.appearance = localStorage.getItem('myt-appearance') || (legacyMode === 'car' ? 'car' : 'default');
  app.cont = localStorage.getItem('myt-continue') || (legacyMode === 'continuous' || legacyMode === 'radio' ? legacyMode : (prefs.autoNext ? 'continuous' : 'single'));
  if (legacyMode) { try { localStorage.removeItem('myt-play-mode'); } catch (e) {} }
  document.body.classList.toggle('car-mode', app.appearance === 'car');
  // 阅读模式记忆：逐词/逐句、跟随方式都按上次留下的恢复，否则每次启动都偷偷回到默认。
  try {
    const savedMode = localStorage.getItem('myt-mode');
    if (savedMode === 'word' || savedMode === 'sentence') setState('mode', savedMode);
    const savedScroll = localStorage.getItem('myt-scroll');
    if (savedScroll && $('scroll').querySelector('option[value="' + savedScroll + '"]')) setState('scroll', savedScroll);
  } catch (e) {}
  const modeSeg = $('modeSeg');
  if (modeSeg) [...modeSeg.children].forEach(b => {
    const on = b.dataset.mode === state.mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
  if ($('scroll').value !== state.scroll) $('scroll').value = state.scroll;
  try {
    const sleep = JSON.parse(localStorage.getItem('myt-sleep') || 'null');
    if (sleep && sleep.until && sleep.until > Date.now()) { app.sleepUntil = sleep.until; startSleepTimer(); }
    else if (sleep && sleep.end) app.sleepEnd = true;
  } catch (e) {}
  syncDockSleep();
}

/* ---------- cross-origin feed cache ---------- */
let feedDbPromise = null;
function feedDb() {
  return feedDbPromise || (feedDbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('no indexeddb')); return; }
    const request = indexedDB.open('myt-feeds', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('xml');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}
async function feedCacheGet(key) {
  try {
    const db = await feedDb();
    return await new Promise((resolve, reject) => {
      const request = db.transaction('xml', 'readonly').objectStore('xml').get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } catch (e) { return null; }
}
async function feedCachePut(key, xml) {
  try {
    const db = await feedDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('xml', 'readwrite');
      tx.objectStore('xml').put({ xml, at: Date.now() }, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {}
}
const FEED_CACHE_TTL = 6 * 60 * 60 * 1000;
function feedCacheFresh(entry, now = Date.now()) {
  const at = Number(entry?.at);
  return !!entry?.xml && Number.isFinite(at) && now - at <= FEED_CACHE_TTL;
}
// 内存里的解析结果同样遵守 TTL；否则长时间不刷新页面会一直用旧 feed。
function rememberFeed(key, feed) {
  if (!key || !feed) return;
  const at = Date.now();
  app.feedCache.set(key, { feed, at });
  state.feeds.set(key, feed);
}
function memoryFeed(key, now = Date.now()) {
  const id = typeof key === 'string' ? key : (key?.slug || key?.key || '');
  if (!id) return null;
  const entry = app.feedCache.get(id);
  if (!entry) return null;
  const at = Number(entry.at);
  if (!entry.feed || !Number.isFinite(at) || now - at > FEED_CACHE_TTL) {
    app.feedCache.delete(id);
    state.feeds.delete(id);
    return null;
  }
  return entry.feed;
}
function hasFreshFeed(key) { return !!memoryFeed(key); }

async function fetchFeedText(url, options = {}) {
  const abs = absoluteUrl(url);
  const sameOrigin = abs.startsWith(location.origin);
  const cached = sameOrigin ? null : await feedCacheGet(abs);
  if (!options.force && feedCacheFresh(cached)) return cached.xml;
  try {
    const response = await fetch(abs, { cache: 'no-cache' });
    if (response.ok) {
      const text = await response.text();
      if (!sameOrigin) await feedCachePut(abs, text);
      return text;
    }
  } catch (e) {}
  const template = (localStorage.getItem('myt-cors-proxy') || '').trim();
  if (template) {
    try {
      const target = template.includes('{url}')
        ? template.replace('{url}', encodeURIComponent(abs))
        : template + encodeURIComponent(abs);
      const response = await fetch(target, { cache: 'no-cache' });
      if (response.ok) {
        const text = await response.text();
        if (!sameOrigin) await feedCachePut(abs, text);
        return text;
      }
    } catch (e) {}
  }
  if (cached?.xml) return cached.xml;
  const err = new Error('无法读取该 feed：该站点不允许浏览器跨域。可在设置里配置 CORS 代理，或粘贴 RSS 内容导入。');
  err.cors = true;
  throw err;
}
async function ensureShowFeed(show, options = {}) {
  if (!show) throw new Error('节目不存在');
  if (!show.feed) throw new Error('该节目没有 feed 地址。');
  const cached = memoryFeed(show);
  if (cached && !options.force) return cached;
  const xml = await fetchFeedText(show.feed, options);
  const feed = parseFeed(xml);
  if (!feed.title && !feed.episodes.length) throw new Error('返回内容不是可识别的 RSS。');
  rememberFeed(show.slug, feed);
  if (feed.title && !show.builtin) show.name = cleanFeedTitle(feed.title) || show.name;
  if (feed.artwork && !show.artwork) show.artwork = feed.artwork;
  if (feed.description && !show.description) show.description = feed.description;
  if (feed.episodes.length) show.episode_count = feed.episodes.length;
  if (!show.builtin) {
    const rec = app.subs.find(s => s.key === show.slug);
    if (rec) {
      rec.name = show.name || rec.name;
      rec.artwork = show.artwork || rec.artwork;
      rec.description = show.description || rec.description;
      saveSubs();
    }
  }
  return feed;
}

/* ---------- OPML ---------- */
function decodeXml(text) {
  return String(text || '').replace(/&(amp|lt|gt|quot|apos|#\d+);/g, (m, code) => {
    if (code === 'amp') return '&';
    if (code === 'lt') return '<';
    if (code === 'gt') return '>';
    if (code === 'quot') return '"';
    if (code === 'apos') return "'";
    if (code[0] === '#') return String.fromCharCode(Number(code.slice(1)));
    return m;
  });
}
function parseOpml(text) {
  const items = [];
  const re = /<outline\b[^>]*>/gi;
  let match;
  while ((match = re.exec(String(text || '')))) {
    const tag = match[0];
    const attr = name => {
      const found = new RegExp(name + '\\s*=\\s*(["\'])(.*?)\\1', 'i').exec(tag);
      return found ? decodeXml(found[2]) : '';
    };
    const xmlUrl = attr('xmlUrl') || attr('xmlurl');
    if (xmlUrl) items.push({ title: attr('text') || attr('title'), xmlUrl });
  }
  return items;
}
function buildOpml(items, origin) {
  const escapeXml = value => String(value == null ? '' : value).replace(/[&<>"]/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]
  ));
  const rows = items.map(item =>
    '    <outline type="rss" text="' + escapeXml(item.title) + '" title="' + escapeXml(item.title) +
    '" xmlUrl="' + escapeXml(item.xmlUrl) + '"/>').join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>MyTranscript subscriptions</title></head>\n  <body>\n' +
    rows + '\n  </body>\n</opml>\n';
}
function downloadFile(name, content, type) {
  const blob = new Blob([content], { type: type || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function checkSubscriptions() {
  const box = $('subHealth');
  if (box) box.textContent = '正在检查 ' + app.subs.length + ' 个订阅…';
  const results = [];
  const feeds = new Map();
  for (const sub of app.subs) {
    const show = showByKey(sub.key);
    const origin = show?.feed ? absoluteFeed(show.feed) : (sub.feed || '');
    if (origin) feeds.set(origin, (feeds.get(origin) || 0) + 1);
    let status = 'ok', detail = '', latest = 0;
    if (!origin) { status = 'bad'; detail = '没有 feed 地址'; }
    else {
      try {
        const xml = await fetchFeedText(origin, { force: true });
        const feed = parseFeed(xml);
        latest = feed.episodes.reduce((max, ep) => Math.max(max, Date.parse(ep.date) || 0), 0);
        if (!feed.episodes.length) { status = 'bad'; detail = 'feed 里没有单集'; }
        else if (latest && latest < Date.now() - 90 * 86400000) { status = 'stale'; detail = '最后更新 ' + new Date(latest).toLocaleDateString('zh-CN'); }
        else detail = feed.episodes.length + ' 集';
      } catch (e) { status = 'bad'; detail = '读取失败'; }
    }
    results.push({ sub, show, origin, status, detail });
  }
  for (const item of results) if (feeds.get(item.origin) > 1) { item.status = item.status === 'ok' ? 'dup' : item.status; item.detail += ' · 重复订阅'; }
  const bad = results.filter(item => item.status === 'bad').length;
  const stale = results.filter(item => item.status === 'stale').length;
  const dup = results.filter(item => item.status === 'dup').length;
  if (box) {
    box.innerHTML = '<div style="margin:6px 0 8px;color:var(--ink)">检查完成：' + results.length + ' 个订阅，失效 ' + bad + '，长期未更新 ' + stale + '，重复 ' + dup + '。</div>' +
      results.map(({ show, sub, status, detail }) => {
        const label = status === 'bad' ? '失效' : status === 'stale' ? '久未更新' : status === 'dup' ? '重复' : '正常';
        const tone = status === 'bad' ? 'warn' : '';
        return '<div class="ep-row" style="cursor:default"><div class="ep-body"><span class="ep-title">' + esc(show?.name || sub.name || sub.key) +
          '</span><span class="ep-sub">' + esc(detail) + '</span></div><span class="pill ' + tone + '">' + label + '</span>' +
          (status === 'bad' ? '<button class="mini-btn" data-remove-sub="' + esc(sub.key) + '" title="移除失效订阅">✕</button>' : '') + '</div>';
      }).join('');
  }
  showToast('订阅检查完成：' + results.length + ' 个，失效 ' + bad + ' 个。', 6000);
}
function stamp(seconds, comma) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, r = ms % 1000;
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':') + (comma ? ',' : '.') + String(r).padStart(3, '0');
}
function exportSubtitle(kind) {
  if (!subtitlePluginOn()) { showToast('字幕插件未启用，没有可导出的字幕。', 'warn'); return; }
  if (!state.cues.length) { showToast('当前单集没有可导出的文字稿。', 'warn'); return; }
  const cues = state.cues.filter(cue => (cue.text || '').trim());
  const safe = (state.current?.title || 'transcript').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
  if (kind === 'txt') {
    downloadFile(safe + '.txt', cues.map(cue => (cue.text || '') + (cue.zh ? '\n' + cue.zh : '')).join('\n\n'), 'text/plain;charset=utf-8');
    return;
  }
  if (kind === 'vtt') {
    downloadFile(safe + '.vtt', 'WEBVTT\n\n' + cues.map(cue => stamp(cue.start, false) + ' --> ' + stamp(cue.end, false) + '\n' + (cue.text || '') + (cue.zh ? '\n' + cue.zh : '')).join('\n\n'), 'text/vtt;charset=utf-8');
    return;
  }
  downloadFile(safe + '.srt', cues.map((cue, i) => (i + 1) + '\n' + stamp(cue.start, true) + ' --> ' + stamp(cue.end, true) + '\n' + (cue.text || '') + (cue.zh ? '\n' + cue.zh : '')).join('\n\n'), 'application/x-subrip;charset=utf-8');
}
function shareCurrentCue() {
  const cue = state.cues[state.activeCue];
  if (!cue || !(cue.text || cue.zh)) { showToast('先播放到一句再分享。', 'warn'); return; }
  const W = 1080, H = 1080;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#101216'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#e9c46a'; ctx.fillRect(72, 96, 10, 96);
  ctx.fillStyle = '#f4f1ea';
  ctx.font = '700 42px "Noto Sans SC","Microsoft YaHei",system-ui,sans-serif';
  const wrap = (text, max) => {
    const lines = []; let line = '';
    for (const ch of String(text || '')) {
      if (ctx.measureText(line + ch).width > max) { lines.push(line); line = ch; } else line += ch;
    }
    if (line) lines.push(line);
    return lines;
  };
  const en = wrap(cue.text, 880).slice(0, 5);
  const zh = wrap(cue.zh, 880).slice(0, 4);
  let y = 300;
  ctx.font = '700 52px "Noto Sans SC","Microsoft YaHei",system-ui,sans-serif';
  ctx.fillStyle = '#f4f1ea';
  en.forEach(line => { ctx.fillText(line, 82, y); y += 74; });
  y += 22;
  ctx.font = '400 40px "Noto Sans SC","Microsoft YaHei",system-ui,sans-serif';
  ctx.fillStyle = '#9fb0c7';
  zh.forEach(line => { ctx.fillText(line, 82, y); y += 60; });
  ctx.fillStyle = '#4a5568';
  ctx.fillRect(82, H - 210, 916, 1);
  ctx.fillStyle = '#e9c46a'; ctx.font = '600 26px system-ui,sans-serif';
  ctx.fillText(fmt(cue.start + (state.offset || 0)), 82, H - 150);
  ctx.fillStyle = '#8b98a9'; ctx.font = '400 26px "Noto Sans SC",system-ui,sans-serif';
  ctx.fillText((state.show?.name || 'MyTranscript').slice(0, 28), 82, H - 104);
  ctx.fillStyle = '#5c6a7d'; ctx.font = '400 22px system-ui,sans-serif';
  ctx.fillText('MyTranscript · 逐词字幕', 82, H - 58);
  canvas.toBlob(blob => {
    if (!blob) { showToast('分享图生成失败。', 'warn'); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'cue-' + Math.round(cue.start) + '.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast('分享图已保存。', 3000);
  }, 'image/png');
}
function exportOpml() {
  const items = app.subs.map(sub => {
    const show = showByKey(sub.key);
    return { title: show?.name || sub.name || sub.key, xmlUrl: show?.feed ? absoluteFeed(show.feed) : sub.feed };
  }).filter(item => item.xmlUrl);
  if (!items.length) { showToast('还没有订阅可以导出。'); return; }
  downloadFile('mytranscript-subscriptions.opml', buildOpml(items, location.href), 'text/x-opml;charset=utf-8');
  showToast('已导出 ' + items.length + ' 个订阅。');
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制：' + text, 4000);
  } catch (e) {
    window.prompt('复制链接', text);
  }
}

/* ---------- artwork ---------- */
const COVER_GRADS = [
  ['#141a2b', '#4d6a8a'], ['#1b1410', '#8a6a3f'], ['#101d18', '#3f7a63'],
  ['#20101a', '#8a4d6d'], ['#141021', '#5f4d9a'], ['#1d1a0f', '#9a8240'],
  ['#0f1a20', '#3f7a8a'], ['#1a1010', '#8a4d4d'],
];
function coverGrad(key) {
  const pair = COVER_GRADS[parseInt(hash32(key || 'show'), 36) % COVER_GRADS.length];
  return 'background:linear-gradient(145deg,' + pair[0] + ',' + pair[1] + ')';
}
function initialsOf(name) {
  const words = String(name || 'MT').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'MT';
  if (/[\u3400-\u9fff]/.test(words[0])) return words[0].slice(0, 2);
  return words.slice(0, 2).map(word => word[0]).join('').toUpperCase();
}
function coverHTML(show, cls) {
  const name = show?.name || show?.slug || 'Podcast';
  const art = show?.artwork || '';
  const img = art
    ? '<img src="' + esc(smallArtwork(art) || art) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">'
    : '';
  return '<div class="' + (cls || 'pod-art') + '" style="' + coverGrad(show?.key || show?.slug || name) + '"><span>' +
    esc(initialsOf(name)) + '</span>' + img + '</div>';
}
function episodeCover(ep, show) {
  const art = ep?.img || show?.artwork || '';
  const img = art
    ? '<img src="' + esc(smallArtwork(art) || art) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">'
    : '';
  return '<div class="ep-art" style="' + coverGrad(show?.key || show?.slug || ep?.id) + '"><span>' +
    esc(initialsOf(show?.name || '')) + '</span>' + img + '</div>';
}

/* ---------- online podcast search ---------- */
// AntennaPod bundles these public Podcast Index credentials in
// net/discovery/build.gradle. They are not secrets, but they are visible here too.
const PODCAST_INDEX = {
  key: 'XTMMQGA2YZ4WJUBYY4HK',
  secret: 'XAaAhk4^2YBsTE33vdbwbZNj82ZRLABDDqFdKe7x',
};
const ONLINE_PAGE = 20;
function appleSearchUrl(query) {
  return 'https://itunes.apple.com/search?media=podcast&entity=podcast&term=' +
    encodeURIComponent(String(query || '').trim()) + '&limit=30';
}
function mapAppleResults(doc) {
  const results = Array.isArray(doc?.results) ? doc.results : [];
  return results.filter(item => item && item.feedUrl).map(item => ({
    title: item.collectionName || item.trackName || 'Unknown',
    author: item.artistName || '',
    feedUrl: item.feedUrl,
    image: item.artworkUrl600 || item.artworkUrl100 || '',
    imageSmall: item.artworkUrl100 || '',
    genre: item.primaryGenreName || '',
    episodeCount: Number(item.trackCount) || 0,
    description: item.description || '',
    source: 'apple',
  }));
}
function podcastIndexSearchUrl(query) {
  return 'https://api.podcastindex.org/api/1.0/search/byterm?q=' +
    encodeURIComponent(String(query || '').trim()) + '&max=30';
}
function mapPodcastIndexResults(doc) {
  const feeds = Array.isArray(doc?.feeds) ? doc.feeds : [];
  return feeds.filter(feed => feed && feed.url).map(feed => ({
    title: feed.title || 'Unknown',
    author: feed.author || '',
    feedUrl: feed.url,
    image: feed.image || '',
    imageSmall: feed.image || '',
    genre: feed.categories && typeof feed.categories === 'object' && !Array.isArray(feed.categories)
      ? (Object.values(feed.categories)[0] || '') : '',
    episodeCount: Number(feed.episodeCount) || 0,
    description: feed.description || '',
    source: 'podcastindex',
  }));
}
async function sha1Hex(text) {
  const bytes = new TextEncoder().encode(String(text));
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function podcastIndexAuth(key, secret, seconds) {
  const time = String(seconds);
  return {
    'X-Auth-Date': time,
    'X-Auth-Key': key,
    'Authorization': await sha1Hex(key + secret + time),
  };
}
function searchTitleKey(value) {
  return String(value || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}
function findBuiltinForTitle(title, shows) {
  const key = searchTitleKey(title);
  if (!key) return null;
  return (shows || []).find(show => show && show.feed && searchTitleKey(show.name) === key) || null;
}
function feedKey(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(normalizeFeedUrl(raw));
    const port = parsed.port ? ':' + parsed.port : '';
    return parsed.protocol.toLowerCase() + '//' + parsed.hostname.toLowerCase() + port +
      parsed.pathname.replace(/\/+$/, '') + parsed.search;
  } catch (e) {
    return raw.replace(/\/+$/, '').toLowerCase();
  }
}
function mergeSearchMeta(base, extra) {
  const merged = { ...base };
  ['title', 'author', 'image', 'imageSmall', 'genre', 'description'].forEach(field => {
    if (!merged[field] && extra[field]) merged[field] = extra[field];
  });
  merged.episodeCount = Math.max(Number(base.episodeCount) || 0, Number(extra.episodeCount) || 0);
  const sources = new Set([...(base.sources || [base.source]), ...(extra.sources || [extra.source])]
    .filter(Boolean));
  merged.sources = [...sources];
  return merged;
}
function mergeSearchResults(lists) {
  const scores = new Map();
  const byUrl = new Map();
  (lists || []).forEach(list => {
    (list || []).forEach((item, position) => {
      if (!item || !item.feedUrl) return;
      const key = feedKey(item.feedUrl);
      if (!byUrl.has(key)) byUrl.set(key, { ...item });
      else byUrl.set(key, mergeSearchMeta(byUrl.get(key), item));
      scores.set(key, (scores.get(key) || 0) + 1 / (position + 1));
    });
  });
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => byUrl.get(key));
}
function subscribedShowForFeed(url) {
  const key = feedKey(url);
  if (!key) return null;
  return app.subs.map(sub => showByKey(sub.key))
    .find(show => show && show.feed && feedKey(absoluteFeed(show.feed)) === key) || null;
}
async function fetchJson(url, options = {}, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}
async function searchApple(query) {
  try {
    return mapAppleResults(await fetchJson(appleSearchUrl(query), {}, 9000));
  } catch (err) {
    throw new Error('Apple Podcasts：' + (err.name === 'AbortError' ? '请求超时' : err.message));
  }
}
async function searchPodcastIndex(query) {
  if (!globalThis.crypto?.subtle) throw new Error('浏览器不支持 Web Crypto');
  const headers = await podcastIndexAuth(PODCAST_INDEX.key, PODCAST_INDEX.secret, Math.floor(Date.now() / 1000));
  try {
    return mapPodcastIndexResults(await fetchJson(podcastIndexSearchUrl(query), { headers }, 6000));
  } catch (err) {
    throw new Error('Podcast Index：' + (err.name === 'AbortError' ? '请求超时' : err.message));
  }
}
async function runOnlineSearch(query) {
  const q = String(query || '').trim();
  const seq = ++app.online.seq;
  if (!q) {
    Object.assign(app.online, {
      query: '', loading: false, results: [], sources: [], piError: '', error: '', visible: ONLINE_PAGE,
    });
    renderOnlineResults();
    return;
  }
  const cacheKey = q.toLowerCase();
  const cached = app.online.cache.get(cacheKey);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) {
    Object.assign(app.online, {
      query: q, loading: false, results: cached.results, sources: cached.sources,
      piError: cached.piError || '', error: '', visible: ONLINE_PAGE,
    });
    renderOnlineResults();
    return;
  }
  Object.assign(app.online, { query: q, loading: true, results: [], sources: [], piError: '', error: '', visible: ONLINE_PAGE });
  renderOnlineResults();
  const [apple, podcastIndex] = await Promise.allSettled([searchApple(q), searchPodcastIndex(q)]);
  if (seq !== app.online.seq) return;
  const lists = [];
  const sources = [];
  const errors = [];
  if (apple.status === 'fulfilled') { lists.push(apple.value); sources.push('Apple Podcasts'); }
  else errors.push(apple.reason?.message || 'Apple Podcasts 不可用');
  let piError = '';
  if (podcastIndex.status === 'fulfilled') { lists.push(podcastIndex.value); sources.push('Podcast Index'); }
  else piError = podcastIndex.reason?.message || 'Podcast Index 不可用';
  const results = mergeSearchResults(lists);
  app.online.cache.set(cacheKey, { results, sources, piError, at: Date.now() });
  Object.assign(app.online, {
    loading: false, results, sources, piError,
    error: lists.length ? '' : (errors.join('；') || '在线搜索失败'),
  });
  renderOnlineResults();
}
function onlineRowHTML(result) {
  const builtin = findBuiltinForTitle(result.title, app.builtinShows);
  const subscribed = subscribedShowForFeed(result.feedUrl);
  const show = { key: result.feedUrl, name: result.title, artwork: result.image };
  let action;
  if (builtin) {
    action = '<button class="btn small primary" data-online-builtin="' + esc(builtin.slug) + '">打开增强版</button>';
  } else if (subscribed) {
    action = '<button class="btn small ghost" data-online-open="' + esc(subscribed.slug) + '">已订阅</button>';
  } else {
    action = '<button class="btn small primary" data-online-subscribe="' + esc(result.feedUrl) + '">订阅</button>';
  }
  const meta = [result.author, result.genre, result.episodeCount ? result.episodeCount + ' 集' : '',
    hostOf(result.feedUrl)].filter(Boolean).join(' · ');
  return '<div class="online-row" data-online-detail="' + esc(result.feedUrl) + '" role="link" tabindex="0">' + coverHTML(show, 'online-art') +
    '<div class="online-body"><span class="online-title">' + esc(result.title) + '</span>' +
    '<span class="online-sub">' + esc(meta) + '</span>' +
    (builtin ? '<div class="online-badge"><span class="pill">本站增强版</span></div>' : '') +
    '</div><div class="online-actions">' + action + '</div></div>';
}
function onlineDetailHTML(result, feed, note) {
  const title = feed?.title ? cleanFeedTitle(feed.title) : result.title;
  const show = { key: result.feedUrl, name: title, artwork: feed?.artwork || result.image };
  const count = feed?.episodes?.length || result.episodeCount || 0;
  const meta = [result.author, result.genre, count ? count + ' 集' : '', hostOf(result.feedUrl)]
    .filter(Boolean).join(' · ');
  const desc = plainText(feed?.description || result.description || '');
  const body = note === 'loading'
    ? '<div class="online-state">' + loaderHTML('正在读取节目详情…') + '</div>'
    : '<p class="online-detail-desc">' + esc(desc || '该节目没有提供简介。') + '</p>' +
      (note ? '<div class="modal-note err" style="margin-bottom:12px">' + esc(note) + '</div>' : '');
  return '<div class="modal-head"><h3>节目详情</h3><button class="mini-btn" data-close-modal aria-label="关闭">✕</button></div>' +
    '<div class="online-detail"><div class="online-detail-hero">' + coverHTML(show, 'online-art') +
    '<div style="min-width:0"><div class="online-detail-title">' + esc(title) + '</div>' +
    '<div class="online-sub">' + esc(meta) + '</div></div></div>' + body +
    '<div class="modal-actions"><button class="btn primary" data-online-subscribe="' + esc(result.feedUrl) + '">订阅</button>' +
    '<button class="btn ghost" data-close-modal>关闭</button></div></div>';
}
let onlinePreviewSeq = 0;
async function openOnlinePreview(result) {
  const token = ++onlinePreviewSeq;
  openModal(onlineDetailHTML(result, null, 'loading'));
  const card = $('modalCard');
  card.dataset.onlinePreview = String(token);
  const stillOpen = () => $('modal').open && card.dataset.onlinePreview === String(token) && !!card.querySelector('.online-detail');
  try {
    const xml = await fetchFeedText(result.feedUrl);
    if (!xml) throw new Error('feed 加载失败');
    const feed = parseFeed(xml);
    if (!feed.title && !feed.episodes.length) throw new Error('返回内容不是可识别的 RSS。');
    if (!stillOpen()) return;
    card.innerHTML = onlineDetailHTML(result, feed, '');
  } catch (err) {
    if (!stillOpen()) return;
    card.innerHTML = onlineDetailHTML(result, null, '无法读取节目详情：' + err.message);
  }
}
function openOnlineDetail(feedUrl) {
  const result = (app.online.results || []).find(item => feedKey(item.feedUrl) === feedKey(feedUrl));
  if (!result) return;
  const builtin = findBuiltinForTitle(result.title, app.builtinShows) || findBuiltinByFeed(result.feedUrl);
  if (builtin) { navigate('podcast', [builtin.slug]); return; }
  const subscribed = subscribedShowForFeed(result.feedUrl);
  if (subscribed) { navigate('podcast', [subscribed.slug]); return; }
  openOnlinePreview(result);
}
function renderOnlineResults() {
  const box = $('onlineResults');
  if (!box) return;
  const online = app.online;
  const input = $('onlineSearchInput');
  if (input && document.activeElement !== input && input.value !== online.query) input.value = online.query;
  const source = $('onlineSource');
  if (source) {
    source.textContent = online.loading ? '正在搜索…'
      : online.sources.length
        ? '来源：' + online.sources.join(' · ') + (online.piError ? '（Podcast Index 不可用）' : '') +
          (online.results.length ? ' · ' + online.results.length + ' 个结果' : '')
        : 'Apple Podcasts · Podcast Index';
  }
  if (online.loading) {
    box.innerHTML = '<div class="online-state">' + loaderHTML('正在搜索线上播客…') + '</div>';
    return;
  }
  if (online.error) {
    box.innerHTML = '<div class="online-state err">' + esc(online.error) +
      '<div style="margin-top:10px"><button class="btn ghost small" data-retry-online>重试</button></div></div>';
    return;
  }
  if (!online.query) { box.innerHTML = ''; return; }
  if (!online.results.length) {
    box.innerHTML = '<div class="online-state">没有找到“' + esc(online.query) + '”相关的播客。</div>';
    return;
  }
  const visible = Math.max(ONLINE_PAGE, Number(online.visible) || ONLINE_PAGE);
  const shown = online.results.slice(0, visible);
  const rest = online.results.length - shown.length;
  box.innerHTML = shown.map(onlineRowHTML).join('') +
    (rest > 0
      ? '<div class="online-more"><button class="btn ghost small" data-online-more>加载更多（还有 ' +
        rest + ' 个）</button></div>'
      : '');
}
function subscribeFromOnline(feedUrl) {
  if (!feedUrl) return;
  const subscribed = subscribedShowForFeed(feedUrl);
  if (subscribed) { navigate('podcast', [subscribed.slug]); return; }
  addFeedFromUrl(feedUrl);
}

/* layer: view —— 路由与页面渲染（renderPage 派发）
   本片只做该层的事，跨层调用走 kernel / host() / setState。 */
/* ---------- routing ---------- */
function updateDocumentTitle() {
  const route = app.route || parseRoute();
  let label = PAGE_NAMES[route.page] || 'MyTranscript';
  if (route.page === 'podcast') {
    label = showByKey(route.args[0])?.name || label;
  } else if (route.page === 'episode') {
    const show = showByKey(route.args[0]);
    const ep = show ? episodesOf(show).find(item => item.id === route.args[1]) : null;
    label = ep?.title || show?.name || label;
  } else if (route.page === 'player') {
    label = state.current?.title || showByKey(route.args[0])?.name || label;
  } else if (route.page === 'plugin') {
    label = PLUGIN_PAGES.get(pluginPageKey(route.args[0] || '', route.args[1] || ''))?.title || label;
  }
  document.title = label ? label + ' · MyTranscript' : 'MyTranscript';
}
function applyRoute() {
  const route = parseRoute();
  app.route = route;
  if (route.page === 'echo') { navigate('stats'); return; }
  const isPlayer = route.page === 'player';
  document.body.classList.toggle('player-open', isPlayer);
  document.querySelectorAll('.page').forEach(el => el.classList.toggle('active', el.id === 'page-' + route.page));
  document.querySelectorAll('[data-route]').forEach(el => {
    const active = el.dataset.route === route.page;
    el.classList.toggle('active', active);
    if (active) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
  const pluginKey = route.page === 'plugin' ? pluginPageKey(route.args[0] || '', route.args[1] || '') : '';
  if (app.pluginPageActive && route.page !== 'plugin') {
    try { app.pluginPageActive.destroy?.(); } catch (err) { pluginReportError(app.pluginPageActive.pluginId, err); }
    app.pluginPageActive = null;
  }
  document.querySelectorAll('[data-plugin-page]').forEach(el => {
    const active = !!pluginKey && el.dataset.pluginPage === pluginKey;
    el.classList.toggle('active', active);
    if (active) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
  const crumb = $('crumbName');
  if (crumb) crumb.textContent = PAGE_NAMES[route.page] || '首页';
  updateDocumentTitle();
  closeThemePop();
  if (isPlayer) { openPlayerRoute(route); return; }
  if (!PAGE_NAMES[route.page]) { navigate('home'); return; }
  app.lastPage = route.page;
  renderPage(route.page, route);
  emitPlugin('route:change', { page: route.page, args: route.args });
  updateDocumentTitle();
  syncMini();
}
async function openPlayerRoute(route) {
  const key = route.args[0] || state.current?.showKey || app.lastShowKey || firstShowKey();
  const ep = route.args[1] || '';
  const t = Number(route.params.get('t')) || 0;
  app.pendingSeek = t > 0 ? t : 0;
  app.pendingSeekEp = t > 0 ? ep : '';
  if (!key) { box.innerHTML = '<div class="empty">先选择一集开始收听。</div>'; return; }
  const show = showByKey(key);
  if (!show) { navigate('home'); return; }
  setState('pendingFollow', true);
  if (state.show?.slug !== show.slug || (ep && state.current?.id !== ep)) {
    await loadShow(show.slug, ep || undefined);
  } else if (!state.current) {
    const episodes = state.episodes.length ? state.episodes : episodesOf(show);
    if (episodes.length) selectEpisode(episodes[0], true);
  }
  if (t > 0 && state.current?.id === ep && state.show?.slug === show.slug) {
    setState('resumeAt', 0);
    seekTo(t);
  }
  syncReaderTop(); syncMini(); syncBookmarkBtn();
  // 从悬浮栏或别的页面进入时，当前句可能已经高亮，但 reader 之前是隐藏的，
  // 高亮句并不在视野内；布局可同步读取，直接带回视野。
  // 字幕尚未加载时保留 pendingFollow，由首帧 paint 在句子上线后强制滚动。
  if (state.cues.length) {
    returnToCue();
    setState('pendingFollow', false);
  }
  emitPlugin('player:open', pluginPlayerState());
}
function renderPage(page, route) {
  if (!routeModuleAllows(page)) {
    if (page !== 'home') navigate('home');
    return;
  }
  if (page === 'home') renderHome();
  else if (page === 'library') renderLibrary();
  else if (page === 'local') renderLocal();
  else if (page === 'downloads') renderDownloads();
  else if (page === 'video') renderVideo();
  else if (page === 'discover') renderDiscover();
  else if (page === 'search') renderSearch(route.args[0] || '');
  else if (page === 'podcast') renderPodcast(route.args[0] || '');
  else if (page === 'episode') renderEpisode(route.args[0] || '', route.args[1] || '');
  else if (page === 'inbox') renderInbox();
  else if (page === 'queue') renderQueue();
  else if (page === 'history') renderHistory();
  else if (page === 'stats') renderStats();
  else if (page === 'favorites') renderFavorites();
  else if (page === 'bookmarks') renderBookmarks();
  else if (page === 'notes') renderNotes();
  else if (page === 'listening') renderListening();
  else if (page === 'settings') renderSettings();
  else if (page === 'plugin') renderPluginPage(route.args[0] || '', route.args[1] || '');
  enhanceClickableRows();
}

/* ---------- shared page fragments ---------- */
function enhanceClickableRows() {
  document.querySelectorAll('[data-open-episode],[data-open-podcast],[data-resume],[data-play-episode]').forEach(el => {
    if (el.matches('button, a, input, select, textarea') || el.closest('button, a')) return;
    if (!el.hasAttribute('role')) el.setAttribute('role', 'link');
    if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
  });
}
const CATEGORY_LABELS = {
  'Arts': '艺术', 'Design': '设计', 'Performing Arts': '表演艺术', 'Visual Arts': '视觉艺术',
  'Technology': '科技', 'Tech News': '科技新闻', 'True Crime': '真实犯罪',
  'Science': '科学', 'Social Sciences': '社会科学', 'Life Sciences': '生命科学',
  'TV & Film': '影视', 'TV Reviews': '影视评论', 'Comedy': '喜剧',
  'Education': '教育', 'How To': '方法', 'News': '新闻', 'Daily News': '每日新闻',
  'Health & Fitness': '健康', 'Mental Health': '心理健康', 'Fitness': '健身',
  'Alternative Health': '替代疗法', 'Self-Improvement': '自我提升',
  'History': '历史', 'Society & Culture': '社会与文化', 'Documentary': '纪实',
  'Relationships': '关系', 'Business': '商业', 'Sports': '体育', 'Fiction': '虚构',
};
function categoryLabel(value) {
  const text = String(value || '').trim();
  return CATEGORY_LABELS[text] || text;
}
function showCategories(show) {
  return (show && Array.isArray(show.categories) ? show.categories : []).filter(Boolean);
}
function showCategoryText(show, limit = 2) {
  const labels = [];
  for (const value of showCategories(show)) {
    const label = categoryLabel(value);
    if (label && !labels.includes(label)) labels.push(label);
    if (labels.length >= limit) break;
  }
  return labels.join(' · ');
}
function showLanguageLabel(show) {
  const lang = String(show?.language || '').toLowerCase();
  if (lang.startsWith('en')) return '英语';
  if (lang.startsWith('zh')) return '中文';
  return lang ? lang.toUpperCase() : '';
}
function transcriptCoverage(show) {
  const total = Number(show?.episode_count) || 0;
  const done = Number(show?.transcript_count) || 0;
  return total > 0 && done > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
}
function coverageHTML(show) {
  const total = Number(show?.episode_count) || 0;
  const done = Number(show?.transcript_count) || 0;
  if (!show?.builtin || !total || !done) return '';
  return '<span class="pill">文字稿 ' + done + '/' + total + ' 集 · ' + transcriptCoverage(show) + '%</span>';
}
function podCardHTML(show) {
  const count = show.episode_count || catalogLatest(show).length || 0;
  const subscribed = isSubscribed(show.slug);
  const meta = [showCategoryText(show), showLanguageLabel(show)].filter(Boolean).join(' · ');
  const desc = plainText(show.description || '');
  const latest = catalogLatest(show)[0] || null;
  const badge = show.builtin
    ? '<span class="pill">' + (show.transcript_count ? '双语词级文字稿' : '增强文字稿') + '</span>'
    : '<span class="pill dim">站外 · 仅音频</span>';
  const action = show.builtin
    ? '<button class="btn small ' + (subscribed ? 'ghost' : 'primary') + '" data-sub-toggle="' + esc(show.slug) + '">' +
      (subscribed ? '已订阅' : '订阅') + '</button>'
    : '<button class="btn small ghost" data-remove-sub="' + esc(show.slug) + '">移除</button>';
  const latestLine = latest
    ? '<span class="pod-latest">最新：' + esc(latest.title || '(无标题)') +
      (latest.date ? ' · ' + formatDate(latest.date) : '') + '</span>'
    : '';
  return '<div class="pod-card"><a class="pod-card-main" href="' + esc(routeHash('podcast', [show.slug])) +
    '" data-open-podcast="' + esc(show.slug) + '">' + coverHTML(show) +
    '<strong>' + esc(show.name || show.slug) + '</strong>' +
    (meta ? '<span class="pod-meta">' + esc(meta) + '</span>' : '') +
    (desc ? '<span class="pod-desc">' + esc(desc) + '</span>' : '') +
    '<div class="pod-badges">' + badge + coverageHTML(show) +
    '<span class="pill dim">' + (count ? count + ' 集' : '—') + '</span></div>' + latestLine +
    '</a><div class="pod-actions">' + action + '</div></div>';
}
function episodeRowHTML(ep, show, actions) {
  const key = show?.slug || ep.showKey || '';
  const acts = actions === false ? '' :
    '<div class="ep-actions"><button class="mini-btn" data-play-episode data-key="' + esc(key) + '" data-ep="' +
      esc(ep.id) + '" title="播放">▶</button><button class="mini-btn" data-queue-episode data-key="' +
      esc(key) + '" data-ep="' + esc(ep.id) + '" title="加入队列">＋</button></div>';
  return '<div class="ep-row" data-open-episode data-key="' + esc(key) + '" data-ep="' + esc(ep.id) + '">' +
    episodeCover(ep, show) + '<div class="ep-body"><span class="ep-title">' + esc(ep.title || '(无标题)') +
    epStatusBadges(key, ep) + '</span><span class="ep-sub">' + esc(show?.name || '') + (ep.date ? ' · ' + formatDate(ep.date) : '') +
    '</span></div><span class="ep-dur">' + esc(fmtDuration(ep.duration)) + '</span>' + acts + '</div>';
}
function fmtHours(seconds) {
  const total = Number(seconds) || 0;
  if (!total) return '—';
  if (total < 3600) return Math.max(1, Math.round(total / 60)) + ' 分钟';
  return (total / 3600).toFixed(1) + ' 小时';
}

/* ---------- home ---------- */
function renderHome() {
  const subs = app.subs.map(s => showByKey(s.key)).filter(Boolean);
  $('heroSubCount').textContent = subs.length;
  const dateEl = $('ledgerDate');
  if (dateEl && dateEl.textContent.trim() === '—') {
    dateEl.textContent = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  }
  const progress = readAllProgress();
  const entries = Object.entries(progress).filter(([, rec]) => Number(rec.t) > 5);
  const continueEntry = entries
    .filter(([, rec]) => !rec.d || rec.t < rec.d - 30)
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))[0];
  if (continueEntry) {
    const [progressId, rec] = continueEntry;
    const key = rec.key || progressId.split(':')[0];
    const show = showByKey(key) || { slug: key, name: rec.show || key };
    const pct = rec.d ? Math.min(100, Math.round((rec.t / rec.d) * 100)) : 0;
    $('homeContinue').innerHTML = '<div class="continue" data-resume data-key="' + esc(key) + '" data-ep="' +
      esc(progressId.slice(key.length + 1).replace(/^:/, '')) + '" data-t="' + Number(rec.t || 0) + '">' +
      coverHTML(show, 'pod-art') + '<div class="continue-main"><strong>' + esc(rec.title || show.name || '继续收听') +
      '</strong><span>' + esc(rec.show || show.name || '') + ' · 已听 ' + fmt(rec.t) + (rec.d ? ' / ' + fmt(rec.d) : '') +
      '</span><div class="progress"><i style="width:' + pct + '%"></i></div></div>' +
      '<button class="round-play" data-resume data-key="' + esc(key) + '" data-ep="' +
      esc(progressId.slice(key.length + 1).replace(/^:/, '')) + '" data-t="' + Number(rec.t || 0) + '">▶</button></div>';
    $('continueHint').textContent = '上次停在这里';
  } else {
    $('homeContinue').innerHTML = emptyLine('还没有收听记录。', '<button class="btn primary" data-route="discover">去发现节目</button>');
    $('continueHint').textContent = '';
  }
  $('homeStats').innerHTML = statHTML('订阅节目', subs.length, '含内置与站外')
    + statHTML('开始收听', entries.length, '有播放位置的单集')
    + statHTML('收藏片段', app.bookmarks.length, '播放器里点 ☆');

  const recent = [];
  for (const show of subs) {
    for (const ep of episodesOf(show).slice(0, 3)) recent.push({ ep, show });
  }
  recent.sort((a, b) => (Date.parse(b.ep.date) || 0) - (Date.parse(a.ep.date) || 0));
  $('homeRecent').innerHTML = recent.length
    ? recent.slice(0, 8).map(item => episodeRowHTML(item.ep, item.show)).join('')
    : emptyLine('订阅节目的最近更新会出现在这里。');
  $('homeRecentCount').textContent = recent.length ? '来自 ' + subs.length + ' 个节目' : '';

  const recommended = app.builtinShows.filter(show => show.feed && !isSubscribed(show.slug)).slice(0, 4);
  $('homeRecommended').innerHTML = recommended.length
    ? recommended.map(podCardHTML).join('')
    : emptyLine('所有内置节目都已订阅。');
}

/* ---------- library / discover ---------- */
function renderLibrary() {
  const query = ($('libraryFilter')?.value || '').trim().toLowerCase();
  const shows = app.subs.map(s => showByKey(s.key)).filter(Boolean)
    .filter(show => !query || (show.name + ' ' + (show.description || '')).toLowerCase().includes(query));
  $('libraryCount').textContent = app.subs.length + ' 个订阅' + (query ? ' · 匹配 ' + shows.length : '');
  $('libraryGrid').innerHTML = shows.length
    ? shows.map(podCardHTML).join('')
    : emptyLine(query ? '没有匹配的播客。' : '还没有订阅。', query ? '' : '<button class="btn primary" data-action="import-builtin">选择导入内置源</button> <button class="btn ghost" data-route="discover">去发现页</button>');
}
function primaryCategory(show) {
  return showCategories(show)[0] || '';
}
function filterCatalogShows(shows, options) {
  const d = Object.assign({ query: '', category: '', sort: 'default', sub: 'all', transcripts: false }, options || {});
  const query = String(d.query || '').trim().toLowerCase();
  let list = (shows || []).filter(show => show && show.feed);
  if (query) {
    list = list.filter(show => [show.name, show.description, showCategoryText(show, 4), showLanguageLabel(show)]
      .filter(Boolean).join(' ').toLowerCase().includes(query));
  }
  if (d.category) list = list.filter(show => showCategories(show).includes(d.category));
  if (d.transcripts) list = list.filter(show => (app.catalog ? Number(show.transcript_count) > 0 : true));
  if (d.sub === 'sub') list = list.filter(show => isSubscribed(show.slug));
  else if (d.sub === 'unsub') list = list.filter(show => !isSubscribed(show.slug));
  const latestAt = show => Date.parse(show.latest_published_at || catalogLatest(show)[0]?.date || '') || 0;
  if (d.sort === 'latest') list = [...list].sort((a, b) => latestAt(b) - latestAt(a));
  else if (d.sort === 'episodes') list = [...list].sort((a, b) => (Number(b.episode_count) || 0) - (Number(a.episode_count) || 0));
  else if (d.sort === 'name') list = [...list].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));
  return list;
}
function syncDiscoverControls(shows) {
  const filter = $('discoverFilter');
  if (filter && document.activeElement !== filter && filter.value !== app.discover.query) filter.value = app.discover.query;
  const sort = $('discoverSort');
  if (sort) sort.value = app.discover.sort;
  const sub = $('discoverSub');
  if (sub) sub.value = app.discover.sub;
  const transcripts = $('discoverTranscript');
  if (transcripts) transcripts.checked = !!app.discover.transcripts;
  const select = $('discoverCategory');
  if (!select) return;
  const cats = [...new Set(shows.map(primaryCategory).filter(Boolean))]
    .sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b), 'zh-CN'));
  const signature = cats.join('|');
  if (select.dataset.options !== signature) {
    select.dataset.options = signature;
    select.innerHTML = '<option value="">全部分类</option>' + cats
      .map(c => '<option value="' + esc(c) + '">' + esc(categoryLabel(c)) + '</option>').join('');
  }
  if (app.discover.category && !cats.includes(app.discover.category)) app.discover.category = '';
  select.value = app.discover.category;
}
function renderDiscover() {
  const all = app.builtinShows.filter(show => show.feed);
  syncDiscoverControls(all);
  const shows = filterCatalogShows(all, app.discover);
  const count = $('discoverCount');
  if (count) {
    count.textContent = app.catalogPending ? '目录加载中…'
      : app.catalog ? shows.length + ' / ' + all.length + ' 个节目' : shows.length + ' 个节目';
  }
  const note = $('discoverCatalogNote');
  if (note) {
    note.textContent = app.catalogFailed
      ? '完整目录读取失败或超时，已降级为节目清单（暂无简介、分类和集数）。'
      : app.catalogPending ? '正在后台加载完整目录，先显示节目清单…' : '';
  }
  $('discoverGrid').innerHTML = shows.length
    ? shows.map(podCardHTML).join('')
    : emptyLine(app.discover.query || app.discover.category
      ? '没有匹配的节目，试试其他关键词或分类。'
      : '内置节目目录还没有生成。');
  const external = app.subs.filter(s => !s.builtin).map(s => showByKey(s.key)).filter(Boolean);
  $('discoverExt').innerHTML = '<h3 class="section-title">站外订阅 <small>' + external.length + ' 个 · 仅音频</small></h3>' +
    (external.length
      ? '<div class="card card-pad">' + external.map(show => '<div class="ep-row" data-open-podcast="' + esc(show.slug) + '">' +
        coverHTML(show, 'ep-art') + '<div class="ep-body"><span class="ep-title">' + esc(show.name) +
        '</span><span class="ep-sub">' + esc(hostOf(show.feed)) + '</span></div><button class="mini-btn" data-remove-sub="' +
        esc(show.slug) + '" title="移除">✕</button></div>').join('') + '</div>'
      : emptyLine('还没有站外订阅。', '<button class="btn ghost" data-action="add-feed">＋ 添加 RSS</button>'));
  renderOnlineResults();
}

/* ---------- search ---------- */
let searchTab = 'all';
function searchIndex() {
  const shows = app.subs.map(s => showByKey(s.key)).filter(Boolean);
  const subscribed = new Set(shows.map(show => show.slug));
  const catalog = app.builtinShows.filter(show => show.feed && !subscribed.has(show.slug));
  const episodes = [];
  for (const show of shows) {
    for (const ep of episodesOf(show).slice(0, 40)) episodes.push({ ep, show });
  }
  return { shows, catalog, episodes };
}
async function idxSearch(q, limit = 60) {
  const records = await idxGetAll();
  const hits = [];
  for (const rec of records) {
    if (!rec.text || !rec.text.includes(q)) continue;
    const lines = (rec.lines || []).filter(line => (line.t + ' ' + line.z).toLowerCase().includes(q)).slice(0, 3);
    if (!lines.length) continue;
    for (const line of lines) hits.push({ rec, line });
    if (hits.length >= limit) break;
  }
  return hits;
}
async function renderSearch(query) {
  const input = $('searchInput');
  if (input && input.value !== query) input.value = query || '';
  const q = String(query || '').trim().toLowerCase();
  if (!q) { $('searchResults').innerHTML = emptyLine('输入关键词，在我的播客中搜索。', '<button class="btn ghost small" data-route="discover">去发现页添加新播客</button>'); syncIndexCount(); return; }
  const { shows, catalog, episodes } = searchIndex();
  const matchShow = show => (show.name + ' ' + (show.description || '')).toLowerCase().includes(q);
  let html = '';
  if (searchTab === 'all' || searchTab === 'podcasts') {
    const matched = shows.filter(matchShow);
    const matchedCatalog = catalog.filter(matchShow);
    html += matched.map(show => '<div class="ep-row" data-open-podcast="' + esc(show.slug) + '">' + coverHTML(show, 'ep-art') +
      '<div class="ep-body"><span class="ep-title">' + esc(show.name) + '</span><span class="ep-sub">播客 · ' +
      esc(show.builtin ? '内置增强文字稿' : '站外') + '</span></div><span class="pill">播客</span></div>').join('');
    if (matchedCatalog.length) {
      html += '<div class="smalltext" style="margin:14px 0 2px">本站目录 · 未订阅</div>' +
        matchedCatalog.map(show => '<div class="ep-row" data-open-podcast="' + esc(show.slug) + '">' + coverHTML(show, 'ep-art') +
          '<div class="ep-body"><span class="ep-title">' + esc(show.name) + '</span><span class="ep-sub">' +
          esc([showCategoryText(show), showLanguageLabel(show)].filter(Boolean).join(' · ') || '内置增强文字稿') +
          '</span></div><span class="pill dim">本站目录</span></div>').join('');
    }
  }
  if (searchTab === 'all' || searchTab === 'episodes') {
    const matched = episodes.filter(({ ep, show }) => ((ep.title || '') + ' ' + (show.name || '')).toLowerCase().includes(q));
    html += matched.slice(0, 40).map(({ ep, show }) => episodeRowHTML(ep, show)).join('');
  }
  if (searchTab === 'library') {
    const hits = await idxSearch(q);
    html += '<div class="smalltext" style="margin-bottom:8px">跨已索引单集搜索；点击结果跳到对应句子。</div>' +
      (hits.length ? hits.map(({ rec, line }) => '<div class="ep-row" data-index-jump data-idx-key="' + esc(rec.id) +
        '" data-idx-t="' + Math.round(line.s) + '"><span class="ep-dur">' + fmt(line.s) + '</span><div class="ep-body"><span class="ep-title">' +
        esc(line.t || line.z) + '</span><span class="ep-sub">' + esc(rec.showName) + ' · ' + esc(rec.title) +
        (line.z ? '<br>' + esc(line.z) : '') + '</span></div></div>').join('')
        : emptyLine('没有匹配的文字稿。先在节目页点「索引当前节目」。'));
  }
  if (searchTab === 'transcripts') {
    if (!state.cues.length) {
      html += emptyLine('当前还没有加载文字稿。先在播放器里打开一集。');
    } else {
      const matched = state.cues.map((cue, index) => ({ cue, index }))
        .filter(({ cue }) => ((cue.text || '') + ' ' + (cue.zh || '')).toLowerCase().includes(q)).slice(0, 30);
      html += '<div class="smalltext" style="margin-bottom:8px">当前单集：' + esc(state.current?.title || '—') + '</div>' +
        matched.map(({ cue, index }) => '<div class="ep-row" data-cue-seek="' + Math.round(cue.start + state.offset) + '">' +
          '<span class="ep-dur">' + fmt(cue.start + state.offset) + '</span><div class="ep-body"><span class="ep-title">' +
          esc(cue.text || '') + '</span>' + (cue.zh ? '<span class="ep-sub">' + esc(cue.zh) + '</span>' : '') + '</div></div>').join('');
    }
  }
  $('searchResults').innerHTML = html || emptyLine('没有找到匹配结果，试试其他关键词。');
  enhanceClickableRows();
}

/* ---------- podcast / episode ---------- */
function renderLocal() {
  const hint = $('localHint');
  if (hint) hint.textContent = app.local.length ? app.local.length + ' 个本地音频 · 只读本机文件' : '从本机文件夹导入音频；不会上传，也不占离线目录。';
  $('localList').innerHTML = app.local.length
    ? '<div class="ep-filter-row"><span class="smalltext">' + app.local.length + ' 个文件</span></div>' +
      app.local.map(ep => '<div class="ep-row" ' + (ep.kind === 'video'
        ? 'data-open-video="' + esc(ep.id) + '"'
        : 'data-play-episode data-key="local-files" data-ep="' + esc(ep.id) + '"') + '>' +
        '<span class="ep-art">' + (ep.kind === 'video' ? '▶' : esc((ep.title || '?').slice(0, 2).toUpperCase())) + '</span>' +
        '<div class="ep-body"><span class="ep-title">' + esc(ep.title || ep.name) + '</span><span class="ep-sub">' +
        esc(ep.localPath || '') + ' · ' + fmtBytes(ep.size) + (ep.kind === 'video' ? ' · 视频' : '') + '</span></div>' +
        '<button class="mini-btn" data-del-local="' + esc(ep.id) + '" title="从列表移除">✕</button></div>').join('')
    : emptyLine('还没有本地音频。点右上角「导入文件夹」，会递归扫描 3 层内的音频文件。');
  enhanceClickableRows();
}
async function importLocalFolder() {
  if (!host() || typeof host().kind !== 'string' || host().kind !== 'tauri') {
    showToast('本地文件夹只在桌面壳里可用。', 'warn');
    return;
  }
  try {
    const picked = await tauriHost().core.invoke('plugin:dialog|open', {
      options: { directory: true, multiple: false, title: '选择本地音频文件夹' },
    });
    const dir = Array.isArray(picked) ? picked[0] : picked;
    if (!dir) return;
    showToast('正在扫描文件夹…', 6000);
    const files = await tauriHost().core.invoke('local_scan', { path: dir });
    if (!Array.isArray(files) || !files.length) { showToast('这个文件夹里没有找到音频文件。', 5000); return; }
    const existing = new Set(app.local.map(ep => ep.localPath));
    let added = 0;
    files.forEach(file => {
      if (existing.has(file.path)) return;
      const name = String(file.name || '').replace(/\.[^.]+$/, '');
      const video = /\.(mp4|m4v|webm|mov|mkv)$/i.test(String(file.name || ''));
      app.local.push({
        id: 'local-' + hash32(file.path), title: name || file.name, name: file.name,
        localPath: file.path, size: Number(file.size) || 0, modified: Number(file.modified) || 0,
        date: file.modified ? new Date(Number(file.modified) * 1000).toISOString() : '', duration: 0,
        img: '', transcript: null, kind: video ? 'video' : 'audio',
      });
      added++;
    });
    writeJSON(LOCAL_KEY, app.local);
    refreshShows();
    renderLocal();
    showToast('已导入 ' + added + ' 个音频文件。', 4000);
  } catch (err) {
    showToast('导入失败：' + (err && err.message ? err.message : err), 'warn');
  }
}
function renderVideo() {
  const videos = app.local.filter(ep => ep.kind === 'video');
  const local = videos.find(item => item.id === state.videoId) || videos[0];
  const ep = state.videoEp || local;
  const video = $('localVideo');
  if (!ep) {
    $('videoSub').textContent = '没有可播放的视频';
    video.removeAttribute('src');
    video.load();
    return;
  }
  $('videoSub').textContent = [ep.showName, ep.title || ep.name || ''].filter(Boolean).join(' · ');
  const src = ep.localPath && host() && typeof host().asset === 'function'
    ? host().asset(ep.localPath)
    : (ep.videoUrl || '');
  if (video.dataset.src !== src) {
    video.dataset.src = src;
    video.src = src;
    video.load();
  }
}
function renderPodcast(key) {

  const show = showByKey(key);
  const view = $('podcastView');
  if (!show) { navigate('home'); return; }
  const subscribed = isSubscribed(show.slug);
  const feed = memoryFeed(show);
  const episodes = show.local ? episodesOf(show) : (feed?.episodes || catalogLatest(show));
  const count = show.episode_count || episodes.length;
  const desc = plainText(show.description || app.catalogBySlug.get(show.slug)?.description || '');
  const error = app.feedErrors?.get(show.slug);
  const feedUrl = show.feed ? absoluteFeed(show.feed) : '';
  const loadAll = !feed && show.feed
    ? '<button class="btn ghost small" data-load-full="' + esc(show.slug) + '">' + (show.builtin ? '加载全部单集' : '重新读取 feed') + '</button>'
    : '';
  const filter = app.epFilter || 'all';
  const showPref = showPrefFor(show.slug);
  const filtered = episodes.filter(ep => episodeFilterMatch(show.slug, ep, filter));
  const filterChips = '<div class="ep-filter-row">' + [
    ['all', '全部'], ['unplayed', '未听'], ['played', '已听'], ['favorite', '收藏'], ['offline', '离线'],
  ].map(([id, label]) => '<button data-ep-filter="' + id + '" class="' + (filter === id ? 'on' : '') + '">' + label + '</button>').join('') + '</div>';
  view.innerHTML = '<div class="page-head"><div><div class="eyebrow">' + (show.builtin ? 'BUILT-IN SHOW' : 'EXTERNAL FEED') +
    '</div><h1>' + esc(show.name) + '</h1><div class="subtitle">' + (count ? count + ' 集' : '') +
    (show.builtin ? ' · 双语词级文字稿' : ' · 站外节目仅音频') + '</div></div><button class="btn ghost" data-route="library">← 返回播客库</button></div>' +
    '<div class="detail-hero">' + coverHTML(show, 'pod-art') + '<div style="min-width:0;flex:1"><div class="detail-meta"><span>' +
    (show.builtin ? '内置增强 Feed' : '站外订阅') + '</span><span>' + esc(show.builtin ? '本站' : hostOf(show.feed || '')) + '</span><span>' +
    (count ? count + ' 集' : '—') + '</span></div><p>' + esc(desc || '暂无简介。') + '</p><div class="detail-actions">' +
    (show.local
      ? '<button class="btn ghost" data-route="local">管理本地文件</button>'
      : (show.builtin
        ? '<button class="btn ' + (subscribed ? 'ghost' : 'primary') + '" data-sub-toggle="' + esc(show.slug) + '">' + (subscribed ? '✓ 已订阅' : '订阅') + '</button>'
        : '<button class="btn ghost" data-remove-sub="' + esc(show.slug) + '">移除订阅</button>')) +
    (episodes[0] ? '<button class="btn ghost" data-play-episode data-key="' + esc(show.slug) + '" data-ep="' + esc(episodes[0].id) + '">▶ 播放最新</button>' : '') +
    '</div>' + (error ? '<div class="modal-note err" style="margin-top:10px">' + esc(error) + '</div>' : '') + '</div></div>' +
    '<div class="grid two" style="margin-top:16px"><div class="card card-pad"><h3 class="section-title">单集 <small>' +
    (feed ? episodes.length + ' 集' : (show.episode_count && episodes.length < show.episode_count
      ? '最近 ' + episodes.length + ' / ' + show.episode_count + ' 集' : episodes.length + ' 集')) + '</small></h3>' + filterChips + (filtered.length
      ? filtered.map(ep => episodeRowHTML(ep, show)).join('')
      : emptyLine(episodes.length ? '这个筛选下没有单集。' : (feed ? '该 feed 没有单集。' : '还没有读取单集。'))) + '</div><div class="card card-pad"><h3 class="section-title">节目资料</h3>' +
    '<div class="kv"><span>类型</span><b>' + (show.builtin ? '内置' : '站外') + '</b></div>' +
    '<div class="kv"><span>Feed</span><b>' + (show.feed ? '增强 RSS' : '—') + '</b></div>' +
    '<div class="kv"><span>文字稿</span><b>' + (show.builtin ? '双语词级' : '无') + '</b></div>' +
    '<div class="kv"><span>宿主</span><b>' + esc(show.builtin ? '本站 GitHub Pages' : hostOf(show.feed || '')) + '</b></div>' +
    '<div style="margin-top:14px;display:flex;gap:7px;flex-wrap:wrap">' + loadAll +
    (show.feed ? '<button class="btn ghost small" data-copy-feed="' + esc(feedUrl) + '">复制 Feed 地址</button>' : '') +
    '</div></div></div>' +
    '<div class="card card-pad" style="margin-top:16px"><h3 class="section-title">这档节目的设置 <small>只影响本节目</small></h3>' +
    '<div class="setting-row"><div><strong>播放速度</strong><p>进入本节目时使用；播放器里改速度只影响本次</p></div><select data-show-speed="' + esc(show.slug) + '">' +
    [0.75, 1, 1.25, 1.5, 1.75, 2].map(v => '<option value="' + v + '"' + (Number(showPref.speed) === v ? ' selected' : '') + '>' + v + '×</option>').join('') + '</select></div>' +
    '<div class="setting-row"><div><strong>自动下载新集</strong><p>只对刷新发现的新单集生效</p></div><button class="switch" data-show-auto="' + esc(show.slug) + '" role="switch" aria-checked="' + String(showPref.autoDownload !== false) + '"></button></div>' +
    '<div class="setting-row"><div><strong>新集通知</strong><p>这档节目有新集时发通知</p></div><button class="switch" data-show-notify="' + esc(show.slug) + '" role="switch" aria-checked="' + String(showPref.notify !== false) + '"></button></div>' +
    '<div class="setting-row"><div><strong>跳过开头</strong><p>从第几秒开始播放，0 表示关闭</p></div><input type="number" min="0" max="600" step="1" data-show-intro="' + esc(show.slug) + '" value="' + (Number(showPref.skipIntro) || 0) + '"></div>' +
    '<div class="setting-row"><div><strong>跳过结尾</strong><p>剩余多少秒时结束或续播，0 表示关闭</p></div><input type="number" min="0" max="600" step="1" data-show-outro="' + esc(show.slug) + '" value="' + (Number(showPref.skipOutro) || 0) + '"></div>' +
    '</div>';
  if (!show.builtin && !feed && !error && show.feed) {
    ensureShowFeed(show).then(() => renderPodcast(key)).catch(err => {
      app.feedErrors = app.feedErrors || new Map();
      app.feedErrors.set(show.slug, err.message);
      renderPodcast(key);
    });
  }
  enhanceClickableRows();
}
async function renderEpisode(key, epId) {
  const show = showByKey(key);
  const view = $('episodeView');
  if (!show) { navigate('home'); return; }
  let episodes = episodesOf(show);
  let ep = episodes.find(item => item.id === epId);
  if (!ep && show.feed && !hasFreshFeed(show.slug)) {
    view.innerHTML = '<div class="empty">' + loaderHTML('正在读取单集…') + '</div>';
    try {
      const feed = await ensureShowFeed(show);
      episodes = feed.episodes;
      ep = episodes.find(item => item.id === epId);
    } catch (err) {
      view.innerHTML = emptyLine(err.message, '<button class="btn ghost" data-load-full="' + esc(show.slug) + '">重试</button>');
      return;
    }
  }
  if (!ep) { view.innerHTML = emptyLine('找不到这一集。', '<button class="btn ghost" data-open-podcast="' + esc(show.slug) + '">返回节目</button>'); return; }
  const desc = plainText(ep.description || '');
  const offlineRec = app.offline ? app.offline.get(offlineKeyFor(show, ep)) : null;
  const offlineAction = !offlineRec ? '⤓ 整集下载'
    : (offlineRec.hasTranscript ? '✓ 离线+字幕' : (isJsonTranscript(ep.transcript) ? '＋ 补字幕' : '✓ 仅音频'));
  view.innerHTML = '<div class="page-head"><div><div class="eyebrow">EPISODE</div><h1>' + esc(show.name) +
    '</h1><div class="subtitle">' + formatDate(ep.date) + '</div></div><button class="btn ghost" data-open-podcast="' +
    esc(show.slug) + '">← 返回节目</button></div><div class="detail-hero">' + episodeCover(ep, show) +
    '<div style="min-width:0;flex:1"><h2>' + esc(ep.title || '(无标题)') + '</h2><div class="detail-meta">' +
    '<span>' + esc(show.name) + '</span>' + (ep.date ? '<span>' + formatDate(ep.date) + '</span>' : '') +
    (fmtDuration(ep.duration) ? '<span>' + esc(fmtDuration(ep.duration)) + '</span>' : '') +
    '<span>' + (ep.transcript ? '含双语文字稿' : (show.builtin ? '无字幕' : '仅音频')) + '</span></div><div class="detail-actions">' +
    '<button class="btn primary" data-play-episode data-key="' + esc(show.slug) + '" data-ep="' + esc(ep.id) + '">▶ 播放单集</button>' +
    (moduleOn('study') && ep.transcript?.url ? '<button class="btn ghost" data-ai-episode data-key="' + esc(show.slug) + '" data-ep="' + esc(ep.id) + '" title="用 LLM 总结本集，并生成可跳转的主题时间戳">AI 总结</button>' : '') +
    (ep.videoUrl ? '<button class="btn ghost" data-open-video-ep data-key="' + esc(show.slug) + '" data-ep="' + esc(ep.id) + '">▶ 视频</button>' : '') +
    '<button class="btn ghost" data-queue-episode data-key="' + esc(show.slug) + '" data-ep="' + esc(ep.id) + '">＋ 队列</button>' +
    '<button class="btn ghost" data-fav-episode data-key="' + esc(show.slug) + '" data-ep="' + esc(ep.id) + '">' +
    (isFavorite(show.slug, ep.id) ? '★ 已收藏' : '☆ 收藏') + '</button>' +
    '<button class="btn ghost" data-played-episode data-key="' + esc(show.slug) + '" data-ep="' + esc(ep.id) + '">' +
    (isPlayed(show.slug, ep.id) ? '✓ 已听' : '○ 标记已听') + '</button>' +
    '<button class="btn ghost" data-list-episode data-key="' + esc(show.slug) + '" data-ep="' + esc(ep.id) + '">＋ 列表</button>' +
    '<button class="btn ghost" data-offline-episode data-key="' + esc(show.slug) + '" data-ep="' + esc(ep.id) + '" title="整集下载会同时保存文字稿">' +
    offlineAction + '</button>' +
    '<button class="btn ghost" data-copy-link data-key="' + esc(show.slug) + '" data-ep="' + esc(ep.id) + '">复制链接</button>' +
    '</div></div></div><div class="card card-pad" style="margin-top:16px"><h3 class="section-title">简介</h3><p class="smalltext" style="margin:0">' +
    esc(desc || '该 feed 没有提供单集简介。') + '</p></div>';
  enhanceClickableRows();
}

/* ---------- inbox / favorites / queue / history ---------- */
function inboxEpisode(item) {
  const show = showByKey(item.showKey) || { slug: item.showKey, name: item.show || item.showKey, key: item.showKey };
  const ep = episodesOf(show).find(entry => entry.id === item.ep) || {
    id: item.ep, title: item.title, date: item.date, duration: item.duration, img: item.img,
  };
  return { show, ep };
}
function renderInbox() {
  const hint = $('inboxHint');
  if (hint) hint.textContent = app.inbox.length ? app.inbox.length + ' 集待处理 · 新单集先放这里' : '新单集先放这里，决定入队、收藏或标记已听。';
  $('inboxList').innerHTML = app.inbox.length
    ? app.inbox.map(item => {
      const { show, ep } = inboxEpisode(item);
      return '<div class="ep-row" data-play-episode data-key="' + esc(show.slug) + '" data-ep="' + esc(ep.id) + '">' +
        episodeCover(ep, show) + '<div class="ep-body"><span class="ep-title">' + esc(item.title || ep.title || '(无标题)') +
        '</span><span class="ep-sub">' + esc(item.show || show.name || '') + (item.date ? ' · ' + formatDate(item.date) : '') +
        '</span></div><div class="ep-actions">' +
        '<button class="mini-btn" data-queue-episode data-key="' + esc(show.slug) + '" data-ep="' + esc(ep.id) + '" title="加入队列">＋</button>' +
        '<button class="mini-btn" data-fav-episode data-key="' + esc(show.slug) + '" data-ep="' + esc(ep.id) + '" title="收藏">' + (isFavorite(show.slug, ep.id) ? '★' : '☆') + '</button>' +
        '<button class="mini-btn" data-inbox-played data-key="' + esc(show.slug) + '" data-ep="' + esc(ep.id) + '" title="标记已听并移出收件箱">✓</button>' +
        '<button class="mini-btn" data-inbox-remove="' + esc(item.key) + '" title="忽略">✕</button></div></div>';
    }).join('')
    : emptyLine('收件箱是空的。开启「订阅自动化」并定时刷新后，新单集会自动进来。', '<button class="btn ghost" data-route="settings">去设置</button>');
  enhanceClickableRows();
}
function renderFavorites() {
  const items = [...app.favorites].map(key => {
    const at = key.indexOf(':');
    return { showKey: key.slice(0, at), epId: key.slice(at + 1) };
  }).filter(item => item.showKey && item.epId);
  $('favoriteList').innerHTML = items.length
    ? items.map(item => {
      const show = showByKey(item.showKey) || { slug: item.showKey, name: item.showKey, key: item.showKey };
      const ep = episodesOf(show).find(entry => entry.id === item.epId) || { id: item.epId, title: '单集 ' + item.epId.slice(0, 8) };
      return '<div class="ep-row" data-play-episode data-key="' + esc(show.slug) + '" data-ep="' + esc(ep.id) + '">' +
        episodeCover(ep, show) + '<div class="ep-body"><span class="ep-title">' + esc(ep.title || '(无标题)') +
        '</span><span class="ep-sub">' + esc(show.name || '') + (ep.date ? ' · ' + formatDate(ep.date) : '') +
        '</span></div><div class="ep-actions"><button class="mini-btn" data-fav-episode data-key="' + esc(show.slug) +
        '" data-ep="' + esc(ep.id) + '" title="取消收藏">★</button></div></div>';
    }).join('')
    : emptyLine('还没有收藏的单集。在单集页点「☆ 收藏」。');
  enhanceClickableRows();
}
function saveQueue() { writeJSON(QUEUE_KEY, app.queue); }
function addToQueue(show, ep) {
  if (!show || !ep) return;
  if (app.queue.some(item => item.key === show.slug && item.ep === ep.id)) { showToast('已在队列中。'); return; }
  app.queue.push({
    key: show.slug, ep: ep.id, title: ep.title || '', show: show.name || '',
    date: ep.date || '', duration: ep.duration || '', img: ep.img || '', at: Date.now(),
  });
  saveQueue(); showToast('已加入播放队列。'); renderAfterStateChange();
}
function renderQueue() {
  $('queueHint').textContent = app.queue.length ? app.queue.length + ' 集待播' : '队列是空的。';
  $('queueList').innerHTML = app.queue.length
    ? app.queue.map((item, index) => {
      const show = showByKey(item.key) || { slug: item.key, name: item.show, key: item.key };
      return '<div class="ep-row" data-play-episode data-key="' + esc(item.key) + '" data-ep="' + esc(item.ep) + '">' +
        '<span class="ep-dur">' + String(index + 1).padStart(2, '0') + '</span>' +
        episodeCover({ id: item.ep, img: item.img }, show) + '<div class="ep-body"><span class="ep-title">' +
        esc(item.title || '(无标题)') + '</span><span class="ep-sub">' + esc(show.name || item.show || '') +
        (item.date ? ' · ' + formatDate(item.date) : '') + '</span></div><span class="ep-dur">' +
        esc(fmtDuration(item.duration)) + '</span><button class="mini-btn" data-remove-queue="' + index + '">✕</button></div>';
    }).join('')
    : emptyLine('队列是空的。在播客或单集页点“＋ 队列”。', '<button class="btn ghost" data-route="library">去播客库</button>');
  enhanceClickableRows();
}
function renderHistory() {
  const all = readAllProgress();
  const entries = Object.entries(all).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  const finished = entries.filter(([, rec]) => rec.d && rec.t >= rec.d - 30).length;
  $('historyStats').innerHTML = statHTML('收听记录', entries.length, '有播放位置的单集')
    + statHTML('听完', finished, '接近结尾')
    + statHTML('最近一次', entries[0]?.[1]?.at ? new Date(entries[0][1].at).toLocaleDateString('zh-CN') : '—', '');
  $('historyList').innerHTML = entries.length
    ? entries.map(([progressId, rec]) => {
      const key = rec.key || progressId.split(':')[0];
      const epId = progressId.slice(key.length + 1).replace(/^:/, '');
      const show = showByKey(key) || { slug: key, name: rec.show || key, key };
      const pct = rec.d ? Math.min(100, Math.round((rec.t / rec.d) * 100)) : 0;
      return '<div class="ep-row" data-resume data-key="' + esc(key) + '" data-ep="' + esc(epId) + '" data-t="' + Number(rec.t || 0) + '">' +
        episodeCover({ id: epId, img: rec.img }, show) + '<div class="ep-body"><span class="ep-title">' +
        esc(rec.title || '(无标题)') + '</span><span class="ep-sub">' + esc(rec.show || show.name || '') + ' · ' +
        fmt(rec.t) + (rec.d ? ' / ' + fmt(rec.d) : '') + '</span><div class="progress"><i style="width:' + pct + '%"></i></div></div>' +
        '<button class="mini-btn" data-resume data-key="' + esc(key) + '" data-ep="' + esc(epId) + '" data-t="' + Number(rec.t || 0) + '">▶</button></div>';
    }).join('')
    : emptyLine('还没有收听记录。');
  enhanceClickableRows();
}
function renderStats() {
  const all = readAllProgress();
  const records = Object.entries(all).map(([key, rec]) => ({ key, ...rec }));
  const total = records.reduce((sum, rec) => sum + Math.min(Number(rec.t) || 0, Number(rec.d) || Number(rec.t) || 0), 0);
  const finished = records.filter(rec => rec.d && Number(rec.t) >= Number(rec.d) - 30).length;
  const byShow = new Map();
  for (const rec of records) {
    const key = rec.key || rec.show || '未知';
    const name = rec.show || showByKey(key)?.name || key;
    byShow.set(key, { name, seconds: (byShow.get(key)?.seconds || 0) + (Number(rec.t) || 0), count: (byShow.get(key)?.count || 0) + 1 });
  }
  const top = [...byShow.values()].sort((a, b) => b.seconds - a.seconds).slice(0, 6);
  $('statsCards').innerHTML = statHTML('累计收听', (total / 3600).toFixed(1) + ' 小时', '按播放位置估算')
    + statHTML('听过的单集', records.length, '有播放记录')
    + statHTML('听完', finished, '接近结尾');
  $('statsShows').innerHTML = top.length
    ? top.map(item => {
      const max = top[0].seconds || 1;
      return '<div class="stat-bar"><div class="stat-bar-head"><span>' + esc(item.name) + '</span><b>' + fmtHours(item.seconds) + ' · ' + item.count + ' 集</b></div>' +
        '<div class="stat-track"><i style="width:' + Math.max(2, Math.round(item.seconds / max * 100)) + '%"></i></div></div>';
    }).join('')
    : emptyLine('还没有足够的收听记录。');
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    const next = new Date(d); next.setDate(next.getDate() + 1);
    const recs = records.filter(rec => Number(rec.at) >= d.getTime() && Number(rec.at) < next.getTime());
    days.push({ label: d.toLocaleDateString('zh-CN', { weekday: 'short' }), seconds: recs.reduce((sum, rec) => sum + (Number(rec.t) || 0), 0), count: recs.length });
  }
  const maxDay = Math.max(1, ...days.map(day => day.seconds));
  $('statsDays').innerHTML = days.map(day =>
    '<div class="stat-bar"><div class="stat-bar-head"><span>' + day.label + '</span><b>' + (day.seconds ? (day.seconds / 60).toFixed(0) + ' 分钟 · ' + day.count + ' 集' : '—') + '</b></div>' +
    '<div class="stat-track"><i style="width:' + Math.max(2, Math.round(day.seconds / maxDay * 100)) + '%"></i></div></div>').join('');
  renderEcho();
}
function renderEcho() {
  const all = readAllProgress();
  const records = Object.entries(all).map(([key, rec]) => ({ key, ...rec }));
  const years = [...new Set(records.map(rec => new Date(Number(rec.at) || 0).getFullYear()).filter(year => year > 1970))];
  const currentYear = new Date().getFullYear();
  if (!years.includes(currentYear)) years.push(currentYear);
  years.sort((a, b) => b - a);
  const select = $('echoYear');
  const wanted = Number(select?.value) || Number(app.echoYear) || years[0];
  if (select) select.innerHTML = years.map(year => '<option value="' + year + '"' + (year === wanted ? ' selected' : '') + '>' + year + ' 年</option>').join('');
  app.echoYear = wanted;
  const items = records.filter(rec => new Date(Number(rec.at) || 0).getFullYear() === wanted);
  const total = items.reduce((sum, rec) => sum + Math.min(Number(rec.t) || 0, Number(rec.d) || Number(rec.t) || 0), 0);
  const finished = items.filter(rec => rec.d && Number(rec.t) >= Number(rec.d) - 30).length;
  const shows = new Map();
  const months = Array.from({ length: 12 }, () => 0);
  items.forEach(rec => {
    const key = rec.key || rec.show || '未知';
    const name = rec.show || showByKey(key)?.name || key;
    shows.set(key, { name, seconds: (shows.get(key)?.seconds || 0) + (Number(rec.t) || 0), count: (shows.get(key)?.count || 0) + 1 });
    const month = new Date(Number(rec.at) || 0).getMonth();
    if (month >= 0 && month < 12) months[month] += Number(rec.t) || 0;
  });
  const top = [...shows.values()].sort((a, b) => b.seconds - a.seconds);
  const busiest = months.indexOf(Math.max(...months));
  $('echoCards').innerHTML = statHTML('这一年听了', fmtHours(total), items.length + ' 集有记录')
    + statHTML('听完', finished, '接近结尾')
    + statHTML('最忙月份', total ? (busiest + 1) + ' 月' : '—', total ? fmtHours(months[busiest]) : '');
  const maxMonth = Math.max(1, ...months);
  $('echoBody').innerHTML = items.length
    ? '<div class="section-title">年度最常听 <small>按累计播放位置</small></div>' +
      top.slice(0, 5).map((item, index) => '<div class="stat-bar"><div class="stat-bar-head"><span>' + (index + 1) + '. ' +
        esc(item.name) + '</span><b>' + fmtHours(item.seconds) + ' · ' + item.count + ' 集</b></div>' +
        '<div class="stat-track"><i style="width:' + Math.max(2, Math.round(item.seconds / (top[0].seconds || 1) * 100)) + '%"></i></div></div>').join('') +
      '<div class="section-title" style="margin-top:22px">每月收听 <small>按最后播放时间归属</small></div>' +
      months.map((seconds, index) => '<div class="stat-bar"><div class="stat-bar-head"><span>' + (index + 1) + ' 月</span><b>' +
        (seconds ? fmtHours(seconds) : '—') + '</b></div><div class="stat-track"><i style="width:' +
        Math.max(2, Math.round(seconds / maxMonth * 100)) + '%"></i></div></div>').join('')
    : emptyLine('这一年还没有收听记录。');
}
function renderBookmarks() {
  $('bookmarkList').innerHTML = app.bookmarks.length
    ? app.bookmarks.map(item => '<div class="ep-row" data-resume data-key="' + esc(item.key) + '" data-ep="' +
      esc(item.ep) + '" data-t="' + Number(item.t || 0) + '"><span class="ep-dur">' + fmt(item.t) + '</span>' +
      '<div class="ep-body"><span class="ep-title">“' + esc(item.en || '') + '”</span><span class="ep-sub">' +
      esc(item.show || '') + ' · ' + esc(item.title || '') + (item.zh ? ' · ' + esc(item.zh) : '') +
      '</span></div><button class="mini-btn" data-del-bookmark="' + esc(item.id) + '">✕</button></div>').join('')
    : emptyLine('还没有书签。播放时点右上角 ☆ 收藏当前句。');
  enhanceClickableRows();
}
function renderNotes() {
  const select = $('noteShow');
  if (select && select.dataset.filled !== String(app.subs.length)) {
    select.innerHTML = '<option value="">不关联节目</option>' + app.subs.map(sub => {
      const show = showByKey(sub.key);
      return '<option value="' + esc(sub.key) + '">' + esc(show?.name || sub.name || sub.key) + '</option>';
    }).join('');
    select.dataset.filled = String(app.subs.length);
  }
  $('noteCount').textContent = app.notes.length + ' 条';
  $('notesList').innerHTML = app.notes.length
    ? app.notes.map(item => '<div class="note-item"><strong>' + esc(item.title) + '</strong><p>' + esc(item.body) +
      '</p><small>' + esc(item.show || '') + ' · ' + new Date(item.at).toLocaleString('zh-CN') +
      '</small><div style="margin-top:6px"><button class="mini-btn" data-del-note="' + esc(item.id) + '">✕</button></div></div>').join('')
    : emptyLine('还没有笔记。');
  enhanceClickableRows();
}

/* ---------- listening / settings ---------- */
// 原来一个 LISTEN_MODES 把「外观」和「续播」混成四个互斥值：选驾驶就等于不续播，
// 选连续播放就不能同时用驾驶界面。现在拆成两组独立设置。
const LISTEN_APPEARANCE = {
  default: { name: '默认界面', icon: '◱', desc: '正文与底栏都在，适合边听边读。', note: '日常使用' },
  car: { name: '简洁驾驶', icon: '◖', desc: '隐藏正文，放大核心播放按钮。', note: '驾驶或走路时用' },
};
const LISTEN_CONTINUE = {
  single: { name: '播完即停', icon: '■', desc: '这一集播完就停下，不自动往下走。', note: '适合精听一集' },
  continuous: { name: '连续播放', icon: '⟲', desc: '播完接着放队列里的下一集。', note: '适合长时间收听' },
  radio: { name: '节目电台', icon: '⌁', desc: '围绕当前节目连续往下播。', note: '适合连听一档节目' },
};
function renderListenGroup(id, map, active, attr) {
  const grid = $(id);
  if (!grid) return;
  grid.innerHTML = Object.entries(map).map(([key, mode]) => {
    const on = active === key;
    return '<button class="listen-card ' + (on ? 'selected' : '') + '" data-' + attr + '="' + key + '" role="radio" aria-checked="' + on + '">' +
      '<span class="listen-ico">' + mode.icon + '</span><strong>' + mode.name + '</strong><small>' + mode.desc +
      '</small><em>' + mode.note + '</em></button>';
  }).join('');
}
function renderListening() {
  renderListenGroup('listenAppearance', LISTEN_APPEARANCE, app.appearance, 'appearance');
  renderListenGroup('listenContinue', LISTEN_CONTINUE, app.cont, 'continue');
  syncAutoNextSwitch();
  document.querySelectorAll('[data-sleep]').forEach(button => {
    const value = button.dataset.sleep;
    // 剩余时间随秒在掉，用「整分钟严格相等」会让选中态在下一分钟立刻消失；
    // 和底栏一样按 ±1 分钟认。
    const remainMin = app.sleepUntil ? (app.sleepUntil - Date.now()) / 60000 : -1;
    const on = value === 'end' ? app.sleepEnd
      : value === 'off' ? (!app.sleepUntil && !app.sleepEnd)
      : (remainMin > 0 && Math.abs(remainMin - Number(value)) <= 1);
    button.classList.toggle('active', !!on);
  });
  const status = $('sleepStatus');
  if (status) {
    if (app.sleepEnd) status.textContent = '本集结束后自动暂停';
    else if (app.sleepUntil) status.textContent = '将在 ' + new Date(app.sleepUntil).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + ' 暂停';
    else status.textContent = '未设置睡眠定时';
  }
  renderPlaylists();
  renderOfflineList();
}
function renderAutoSettings() {
  const auto = app.auto;
  const refresh = $('autoRefresh'); if (refresh) refresh.value = String(Number(auto.refreshHours) || 0);
  const count = $('autoCount'); if (count) count.value = String(Number(auto.downloadCount) || 1);
  const cap = $('autoCap'); if (cap) cap.value = String(Number(auto.capMB) || 0);
  const switches = [['autoDownload', !!auto.autoDownload], ['autoDeletePlayed', !!auto.deletePlayed],
    ['autoDeleteQueue', !!auto.deleteNotInQueue], ['autoKeepFav', !!auto.keepFavorites], ['autoNotify', !!auto.notify]];
  switches.forEach(([id, on]) => { const el = $(id); if (el) el.setAttribute('aria-checked', String(on)); });
  const status = $('autoStatus');
  if (status) {
    status.textContent = auto.lastRefreshAt
      ? '上次刷新：' + new Date(Number(auto.lastRefreshAt)).toLocaleString('zh-CN', { hour12: false }) +
        ' · 收件箱 ' + inboxCount() + ' 集'
      : '尚未刷新 · 收件箱 ' + inboxCount() + ' 集';
  }
}
function renderSettings() {
  document.querySelectorAll('[data-module]').forEach(btn => btn.setAttribute('aria-checked', String(moduleOn(btn.dataset.module))));
  syncStudySettings();
  const themes = $('themeGrid');
  if (themes) {
    themes.innerHTML = Object.entries(THEME_NAMES).map(([id, name]) =>
      '<button class="theme-card swatch" data-theme="' + id + '" role="radio" aria-checked="false"><span class="sw"></span>' +
      esc(name) + '</button>').join('');
  }
  if ($('ctCss')) syncCustomThemeEditor();
  if ($('pluginList')) refreshPluginSettings();
  const subList = $('settingsSubs');
  if (subList) {
    subList.innerHTML = app.subs.map(sub => {
      const show = showByKey(sub.key);
      return '<div class="ep-row"><div class="ep-body"><span class="ep-title">' + esc(show?.name || sub.name || sub.key) +
        '</span><span class="ep-sub">' + esc(show?.feed ? absoluteFeed(show.feed) : '仅保存链接') + '</span></div>' +
        '<span class="pill ' + (sub.builtin ? '' : 'dim') + '">' + (sub.builtin ? '内置' : '站外') + '</span>' +
        '<button class="mini-btn" data-remove-sub="' + esc(sub.key) + '" title="移除">✕</button></div>';
    }).join('') || emptyLine('还没有订阅。');
  }
  const speed = $('setSpeed'); if (speed) speed.value = String(prefs.speed || 1);
  if (typeof syncRateSeg === 'function') syncRateSeg();
  if (typeof syncDockBadge === 'function') syncDockBadge();
  if (typeof syncDockSleep === 'function') syncDockSleep();
  const auto = $('setAutoNext'); if (auto) auto.setAttribute('aria-checked', String(app.cont !== 'single'));
  const remember = $('setRemember'); if (remember) remember.setAttribute('aria-checked', String(prefs.remember !== false));
  const lang = $('setLang'); if (lang) lang.value = reader.lang;
  const lead = $('setLiveLead'); if (lead) syncLiveLeadSelect();
  const mse = $('setLiveMse'); if (mse) mse.setAttribute('aria-checked', String(!!prefs.liveMse));
  const qo = $('setQueueOrder'); if (qo) qo.value = prefs.queueOrder || 'sequential';
  const vc = $('setVolumeCap'); if (vc) vc.value = String(Number(prefs.volumeCap) || 1);
  const sa = $('setSkipAds'); if (sa) sa.setAttribute('aria-checked', String(!!prefs.skipAds));
  const sl = $('setSkipLevel'); if (sl) sl.value = String(Math.max(1, Math.min(3, Number(prefs.skipLevel) || 2)));
  [['setSkipSilence', 'skipSilence'], ['setLoudness', 'loudness'], ['setSkipChapterAds', 'skipChapterAds']].forEach(([id, key]) => {
    const el = $(id); if (el) el.setAttribute('aria-checked', String(!!prefs[key]));
  });
  const fields = [['setScale', reader.scale, 'setScaleOut', reader.scale + '%'], ['setLh', reader.lh, 'setLhOut', Number(reader.lh).toFixed(2)],
    ['setWidth', reader.width, 'setWidthOut', reader.width + ' px'], ['setGap', reader.gap, 'setGapOut', reader.gap + ' px'],
    ['setPending', reader.pending, 'setPendingOut', reader.pending + '%']];
  fields.forEach(([id, value, outId, label]) => { const input = $(id); if (input) input.value = value; const out = $(outId); if (out) out.textContent = label; });
  const proxy = $('corsProxy'); if (proxy) proxy.value = localStorage.getItem('myt-cors-proxy') || '';
  const aboutShows = $('aboutShows'); if (aboutShows) aboutShows.textContent = app.builtinShows.length + ' 个';
  renderAutoSettings();
  syncThemeSwatches();
  if (typeof syncTranslateSettings === 'function') syncTranslateSettings();
}

/* ---------- 自动翻译 ---------- */
const TR_KEY = 'myt-translate';
const TR_DEFAULTS = { on: false, engine: 'mymemory', target: 'zh-CN', endpoint: '', key: '', region: '', model: '' };
let TR = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(TR_KEY) || 'null');
    if (saved && typeof saved === 'object') return Object.assign({}, TR_DEFAULTS, saved);
  } catch (e) {}
  return Object.assign({}, TR_DEFAULTS);
})();
const TR_CACHE = new Map();
let trLastErrorAt = 0;
function trNative() { return !!(tauriHost() && tauriHost().core); }
function trReady() {
  if (!TR.on || !trNative()) return false;
  if (TR.engine === 'google' || TR.engine === 'mymemory') return true;
  return !!String(TR.key || '').trim();
}
function trSave() { try { localStorage.setItem(TR_KEY, JSON.stringify(TR)); } catch (e) {} }
function trStatus(text, bad) {
  const el = $('trStatus');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = bad ? '#c96363' : '';
}
function trConfig() {
  return { engine: TR.engine, target: TR.target, endpoint: TR.endpoint || '', key: TR.key || '', region: TR.region || '', model: TR.model || '' };
}
async function trBatch(texts) {
  const host = tauriHost();
  if (!host || !host.core) throw new Error('自动翻译只在桌面版可用');
  const out = await host.core.invoke('tr_translate', { req: { config: trConfig(), texts } });
  if (!Array.isArray(out) || out.length !== texts.length) throw new Error('翻译返回条数不对');
  return out;
}
async function trText(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  if (TR_CACHE.has(value)) return TR_CACHE.get(value);
  const [out] = await trBatch([value]);
  if (out) TR_CACHE.set(value, out);
  return out || '';
}
function trNoteError(err) {
  const msg = err && err.message ? err.message : String(err);
  trStatus('翻译失败：' + msg, true);
  if (Date.now() - trLastErrorAt > 30000) {
    trLastErrorAt = Date.now();
    showToast('自动翻译失败：' + msg, 7000);
  }
}
// 原文字稿：只翻播放头附近还没有中文的句子；译完写回 cue.zh 并补到已渲染的句子上。
function trPrimeCues(ci) {
  if (!trReady() || ci < 0) return;
  const want = [];
  for (let i = ci; i < Math.min(state.cues.length, ci + 3); i++) {
    const cue = state.cues[i];
    if (!cue || !cue.text || cue.zh || cue.trPending || cue.quiet || isBracket(cue.text)) continue;
    cue.trPending = true;
    want.push(cue);
  }
  if (!want.length) return;
  trBatch(want.map(cue => cue.text)).then(out => {
    want.forEach((cue, i) => {
      cue.trPending = false;
      if (out[i]) {
        cue.zh = out[i];
        TR_CACHE.set(cue.text, out[i]);
      }
      const idx = state.cues.indexOf(cue);
      const node = idx >= 0 ? state.nodes[idx] : null;
      if (node && cue.zh && reader.lang === 'both' && !node.el.querySelector('.zh')) {
        const z = document.createElement('span');
        z.className = 'zh'; z.lang = 'zh-CN'; z.textContent = cue.zh;
        node.el.append(z);
      }
    });
    syncMiniCaption();
  }).catch(err => {
    want.forEach(cue => { cue.trPending = false; });
    trNoteError(err);
  });
}
function syncTranslateSettings() {
  const on = $('trOn'); if (on) on.setAttribute('aria-checked', String(!!TR.on));
  const engine = $('trEngine'); if (engine) engine.value = TR.engine;
  const target = $('trTarget'); if (target) target.value = TR.target;
  const endpoint = $('trEndpoint'); if (endpoint) endpoint.value = TR.endpoint || '';
  const key = $('trKey'); if (key) key.value = TR.key || '';
  const region = $('trRegion'); if (region) region.value = TR.region || '';
  const model = $('trModel'); if (model) model.value = TR.model || '';
  const builtin = TR.engine === 'google' || TR.engine === 'mymemory';
  const rowEndpoint = $('trRowEndpoint'); if (rowEndpoint) rowEndpoint.hidden = builtin;
  const rowKey = $('trRowKey'); if (rowKey) rowKey.hidden = builtin;
  const rowRegion = $('trRowRegion'); if (rowRegion) rowRegion.hidden = TR.engine !== 'microsoft';
  const rowModel = $('trRowModel'); if (rowModel) rowModel.hidden = TR.engine !== 'openai';
  if (!trNative()) trStatus('自动翻译需要在桌面版使用（网页版受跨域限制）', false);
  else if (!TR.on) trStatus('未开启', false);
  else if (!trReady()) trStatus('还缺 API Key', true);
}

/* layer: view —— 自动翻译与 AI 学英语
   本片只做该层的事，跨层调用走 kernel / host() / setState。 */
/* ================== AI 学英语 ================== */
const STUDY_KEY = 'myt-study', STUDY_CACHE_KEY = 'myt-study-cache', STUDY_VOCAB_KEY = 'myt-study-vocab', STUDY_STATUS_KEY = 'myt-study-status';
const STUDY_SUMMARY_CHUNKS = 3;
const STUDY_PROVIDERS = {
  openai: { name: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini', hint: 'OpenAI 官方或任意 OpenAI 兼容接口', modelHint: '建议用支持中文的通用模型，如 gpt-4o-mini', keyHint: 'sk-...' },
  claude: { name: 'Claude', endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-3-5-sonnet-latest', hint: 'Anthropic Messages API，Key 以 sk-ant- 开头', modelHint: '如 claude-3-5-sonnet-latest，可手动换成当前可用模型', keyHint: 'sk-ant-...' },
  gemini: { name: 'Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash', hint: 'Google Generative Language API，填 AI Studio 的 API Key', modelHint: '如 gemini-2.5-flash，可手动换模型', keyHint: 'AIza...' },
  deepseek: { name: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-chat', hint: 'OpenAI 兼容接口，适合长文总结', modelHint: '如 deepseek-chat', keyHint: 'sk-...' },
  kimi: { name: 'Kimi', endpoint: 'https://api.moonshot.cn/v1', model: 'kimi-k2-0905-preview', hint: 'Moonshot 开放平台，OpenAI 兼容接口', modelHint: '如 kimi-k2-0905-preview，可换当前模型', keyHint: 'sk-...' },
  glm: { name: 'GLM', endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', hint: '智谱开放平台，OpenAI 兼容接口', modelHint: '如 glm-4-plus，可换当前模型', keyHint: 'API Key' },
  custom: { name: '自定义兼容接口', endpoint: '', model: '', hint: '任意 OpenAI 兼容 /chat/completions 接口', modelHint: '填写服务商提供的模型名', keyHint: 'API Key' }
};
const STUDY_DEFAULTS = { provider: 'openai', endpoint: 'https://api.openai.com/v1', key: '', model: 'gpt-4o-mini', target: 'zh-CN' };
let STUDY = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(STUDY_KEY) || 'null');
    if (saved && typeof saved === 'object') return Object.assign({}, STUDY_DEFAULTS, saved);
  } catch (e) {}
  return Object.assign({}, STUDY_DEFAULTS);
})();
if (!STUDY.provider || !STUDY_PROVIDERS[STUDY.provider]) STUDY.provider = 'openai';
let studyCache = (() => { try { return JSON.parse(localStorage.getItem(STUDY_CACHE_KEY) || '{}') || {}; } catch (e) { return {}; } })();
let studyVocab = (() => { try { const v = JSON.parse(localStorage.getItem(STUDY_VOCAB_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } })();
let studyStatus = (() => { try { const v = JSON.parse(localStorage.getItem(STUDY_STATUS_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; } })();
let studyView = 'card', studyRenderedVocab = [];
let studyTermData = new Map(), studyTermPinned = false, studyTermFocusKeys = new Set();
let studyTranscriptTermData = new Map();
let studyReviewRevealed = false, studyHideZh = false, studyAutoPause = false;
let studyExercise = null, studyLoop = null, studyAutoPauseDone = -1, studyVocabContext = null, studyVocabContextMode = null;
let pendingStudyEpisode = '';
studyVocab.forEach(v => {
  if (!v.status) v.status = 'learning';
  if (!Number.isFinite(Number(v.ease))) v.ease = 2.5;
  if (!Number.isFinite(Number(v.interval))) v.interval = 0;
  if (!Number.isFinite(Number(v.reps))) v.reps = 0;
  if (!Number.isFinite(Number(v.lapses))) v.lapses = 0;
  if (!Number.isFinite(Number(v.due))) v.due = Date.now();
  const k = cleanWord(v.word);
  if (k && !studyStatus[k]) studyStatus[k] = v.status;
});

function saveStudy() { try { localStorage.setItem(STUDY_KEY, JSON.stringify(STUDY)); } catch (e) {} }
function saveStudyCache() {
  try {
    const keys = Object.keys(studyCache);
    if (keys.length > 300) keys.slice(0, keys.length - 300).forEach(k => delete studyCache[k]);
    localStorage.setItem(STUDY_CACHE_KEY, JSON.stringify(studyCache));
  } catch (e) {}
}
function saveStudyVocab() { try { localStorage.setItem(STUDY_VOCAB_KEY, JSON.stringify(studyVocab)); } catch (e) {} }
function saveStudyStatus() { try { localStorage.setItem(STUDY_STATUS_KEY, JSON.stringify(studyStatus)); } catch (e) {} }
function studyWordStatusOf(raw) {
  const k = cleanWord(raw);
  return k ? (studyStatus[k] || '') : '';
}
function studyMarkWord(raw, status) {
  const k = cleanWord(raw);
  if (!k) return;
  if (status) studyStatus[k] = status; else delete studyStatus[k];
  saveStudyStatus();
  const item = studyVocab.find(v => cleanWord(v.word) === k);
  if (item) {
    item.status = status || 'learning';
    saveStudyVocab();
  }
  studyApplyWordMarks();
  studyUpdateDueBadge();
}
function wordStatusHTML(word) {
  const status = studyWordStatusOf(word);
  const inVocab = studyVocab.some(v => cleanWord(v.word) === cleanWord(word));
  return '<div class="word-status">' +
    [['learning', '学习中'], ['known', '已掌握'], ['ignored', '忽略']].map(([key, label]) =>
      '<button data-word-status="' + key + '" aria-pressed="' + String(status === key) + '">' + label + '</button>').join('') +
    (inVocab ? '<span class="study-badge">已在生词本</span>' :
      '<button data-word-add="1">＋ 生词本</button>') +
    '</div>';
}
function bindWordStatusButtons(word) {
  const row = document.querySelector('.word-status');
  if (!row) return;
  row.querySelectorAll('[data-word-status]').forEach(btn => {
    btn.onclick = () => {
      const status = btn.dataset.wordStatus;
      studyMarkWord(word, status);
      row.outerHTML = wordStatusHTML(word);
      bindWordStatusButtons(word);
    };
  });
  const add = row.querySelector('[data-word-add]');
  if (add) add.onclick = () => {
    studyAddVocab({ word, phonetic: $('wordPhon')?.textContent || '', meaning: wordCurrentMeaning || '', example: '', exampleZh: '' }, studyCurrentCue()?.cue || null);
    row.outerHTML = wordStatusHTML(word);
    bindWordStatusButtons(word);
  };
}
function studyTranscriptMarkData() {
  const map = new Map();
  const add = item => {
    const key = cleanWord(item?.word || '');
    if (key && !map.has(key)) map.set(key, item);
  };
  studyVocab.forEach(add);
  const cur = studyCurrentCue();
  if (cur) {
    const cached = studyCache[studyCurrentKey(cur)];
    if (cached && cached.data && Array.isArray(cached.data.vocabulary)) cached.data.vocabulary.forEach(add);
  }
  const epId = state.current?.id;
  if (epId) {
    const cached = studyCache['ep:' + epId];
    if (cached && cached.data && Array.isArray(cached.data.vocabulary)) cached.data.vocabulary.forEach(add);
    const partial = studyCache['ep:' + epId + ':partial'];
    if (partial && partial.data && Array.isArray(partial.data.vocabulary)) partial.data.vocabulary.forEach(add);
  }
  return map;
}
function studyApplyWordMarks() {
  if (!studyPluginOn()) return;
  if (!Array.isArray(state.nodes)) return;
  studyTranscriptTermData = studyTranscriptMarkData();
  const phraseItem = key => {
    const item = studyTranscriptTermData.get(key);
    return item && /\s/.test(String(item.word || '').trim()) ? item : null;
  };
  state.nodes.forEach(n => {
    if (!n || !n.words) return;
    n.words.forEach(w => {
      const key = cleanWord(w.textContent || '');
      const st = studyWordStatusOf(w.textContent || '');
      w.classList.remove('study-learning', 'study-known', 'study-ignored', 'vocab-mark');
      delete w.dataset.term;
      if (st) w.classList.add('study-' + st);
      if (key && studyTranscriptTermData.has(key)) {
        w.classList.add('vocab-mark');
        w.dataset.term = key;
      }
    });
    const words = n.words;
    for (let i = 0; i < words.length; i++) {
      let joined = '';
      for (let len = 1; len <= 4 && i + len <= words.length; len++) {
        joined += (len > 1 ? ' ' : '') + (words[i + len - 1].textContent || '');
        const key = cleanWord(joined);
        const item = phraseItem(key);
        if (!item) continue;
        for (let j = i; j < i + len; j++) {
          words[j].classList.add('vocab-mark');
          words[j].dataset.term = key;
        }
      }
    }
  });
}
function studyDueItems() {
  const now = Date.now();
  return studyVocab
    .filter(v => v.status !== 'known' && v.status !== 'ignored' && Number(v.due || 0) <= now)
    .sort((a, b) => Number(a.due || 0) - Number(b.due || 0));
}
function studyUpdateDueBadge() {
  const el = $('studyDueCount');
  if (el) {
    const n = studyDueItems().length;
    el.textContent = String(n);
    el.style.display = n ? '' : 'none';
  }
}
function studyDueLabel(ms) {
  if (!Number.isFinite(Number(ms))) return '未排期';
  const diff = Number(ms) - Date.now();
  if (diff <= 0) return '现在';
  const mins = Math.round(diff / 60000);
  if (mins < 60) return mins + ' 分钟后';
  const hours = Math.round(mins / 60);
  if (hours < 36) return hours + ' 小时后';
  return Math.round(hours / 24) + ' 天后';
}
function studySrsGrade(item, grade) {
  const ease = Math.max(1.3, Number(item.ease) || 2.5);
  let interval = Math.max(0, Number(item.interval) || 0);
  if (grade === 0) {
    interval = 0;
    item.ease = Math.max(1.3, ease - 0.2);
    item.lapses = (Number(item.lapses) || 0) + 1;
  } else if (grade === 1) {
    interval = interval ? Math.max(1, Math.round(interval * 1.2)) : 1;
    item.ease = Math.max(1.3, ease - 0.15);
  } else if (grade === 2) {
    interval = interval ? Math.round(interval * ease) : 1;
  } else {
    interval = interval ? Math.round(interval * ease * 1.3) : 2;
    item.ease = Math.min(4, ease + 0.15);
  }
  item.interval = interval;
  item.reps = (Number(item.reps) || 0) + 1;
  item.lastReview = Date.now();
  item.due = interval ? Date.now() + interval * 86400000 : Date.now() + 600000;
}
function studyStats() {
  const total = studyVocab.length;
  const known = studyVocab.filter(v => v.status === 'known').length;
  const due = studyDueItems().length;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const reviewed = studyVocab.filter(v => Number(v.lastReview || 0) >= today.getTime()).length;
  return { total, known, due, reviewed };
}
function studyCoverage() {
  const seen = new Set(), known = new Set();
  (state.cues || []).forEach(cue => {
    (cue.words || []).forEach(w => {
      const k = cleanWord(w.t);
      if (!k) return;
      seen.add(k);
      if (studyWordStatusOf(k) === 'known') known.add(k);
    });
  });
  return { total: seen.size, known: known.size, pct: seen.size ? Math.round(known.size / seen.size * 100) : 0 };
}
function studyCueContext(text, fallbackCue) {
  const t = String(text || '').trim().toLowerCase();
  const cues = state.cues || [];
  let cue = fallbackCue || null;
  if (!cue && t) {
    cue = cues.find(c => String(c.text || '').trim().toLowerCase() === t) ||
      cues.find(c => String(c.text || '').toLowerCase().includes(t.slice(0, 40))) || null;
  }
  if (!cue) return {};
  return {
    start: Number(cue.start),
    end: Number(cue.end),
    speechStart: Number(Number.isFinite(Number(cue.speechStart)) ? cue.speechStart : cue.start),
    speechEnd: Number(Number.isFinite(Number(cue.speechEnd)) ? cue.speechEnd : cue.end),
    episodeId: state.current ? state.current.id : '',
    showSlug: state.show ? state.show.slug : '',
    showName: state.show ? (state.show.name || '') : '',
    episodeTitle: state.current ? (state.current.title || '') : '',
  };
}
function studyCueBounds(cue) {
  const s = Number.isFinite(Number(cue.speechStart)) ? Number(cue.speechStart) : Number(cue.start);
  const e = Number.isFinite(Number(cue.speechEnd)) ? Number(cue.speechEnd) : Number(cue.end);
  return { start: s + (state.offset || 0), end: Math.max(s + 0.4, e) + (state.offset || 0) };
}
function studyStopAudio() {
  studyLoop = null;
  if (!audio.paused) audio.pause();
}
function studyPlayRange(start, end, loops = 1) {
  const s = Number(start), e = Number(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) { showToast('这一句没有可用的音频时间。', 2200); return; }
  seekTo(s);
  studyAutoPauseDone = -1;
  studyLoop = { start: s, end: e, left: Math.max(1, loops) };
  audio.play().catch(() => {});
}
function studyPlayCue(cue, loops = 1) {
  const b = studyCueBounds(cue);
  studyPlayRange(b.start, b.end, loops);
}
function studyPlayItem(item) {
  if (item.episodeId && state.current && String(item.episodeId) !== String(state.current.id)) {
    showToast('这条来自另一集，切到该集后可以听原句。', 3200);
    return;
  }
  const s = Number(item.speechStart ?? item.start), e = Number(item.speechEnd ?? item.end);
  if (!Number.isFinite(s) || !Number.isFinite(e)) { showToast('这条还没有绑定原句音频。', 2400); return; }
  studyPlayRange(s + (state.offset || 0), e + (state.offset || 0), 1);
}
function studyAudioTick() {
  const t = audio.currentTime || 0;
  if (studyLoop) {
    if (t >= studyLoop.end - 0.06) {
      if (studyLoop.left > 1) {
        studyLoop.left -= 1;
        audio.currentTime = studyLoop.start;
        audio.play().catch(() => {});
      } else {
        studyLoop = null;
        studyAutoPauseDone = state.activeCue;
        audio.pause();
      }
    }
    return;
  }
  if (!studyAutoPause || audio.paused) return;
  const cur = studyCurrentCue();
  if (!cur) return;
  if (studyAutoPauseDone === cur.ci || studyAutoPauseDone === -2) return;
  const end = (Number.isFinite(Number(cur.cue.speechEnd)) ? Number(cur.cue.speechEnd) : Number(cur.cue.end)) + (state.offset || 0);
  if (t >= end - 0.1) {
    studyAutoPauseDone = cur.ci;
    audio.pause();
  }
}
function studyCsvCell(value) {
  const s = String(value == null ? '' : value);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function studyExportCsv() {
  if (!studyVocab.length) { showToast('生词本还是空的。', 2400); return; }
  const head = ['word', 'phonetic', 'meaning', 'example', 'exampleZh', 'source', 'status', 'due', 'interval', 'ease', 'reps', 'lapses', 'speechStart', 'speechEnd', 'episodeId', 'rootBreakdown', 'rootMeaning', 'sameRootWords', 'memoryHook'];
  const rows = studyVocab.map(v => [
    v.word, v.phonetic, v.meaning, v.example, v.exampleZh, v.source, v.status,
    v.due ? new Date(Number(v.due)).toISOString() : '', v.interval, v.ease, v.reps, v.lapses,
    v.speechStart, v.speechEnd, v.episodeId, v.rootBreakdown, v.rootMeaning, studySameRootText(v), v.memoryHook,
  ].map(studyCsvCell).join(','));
  const blob = new Blob(['\ufeff' + head.join(',') + '\n' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'myt-study-vocab-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  showToast('已导出生词本 CSV。', 2400);
}
function studyLangName() {
  return STUDY.target === 'zh-TW' ? 'Traditional Chinese' : STUDY.target === 'en' ? 'English' : 'Simplified Chinese';
}
function studyHash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
function studyProviderMeta() {
  return STUDY_PROVIDERS[STUDY.provider] || STUDY_PROVIDERS.openai;
}
function studyConfig() {
  return { engine: STUDY.provider || 'openai', endpoint: STUDY.endpoint, key: STUDY.key, model: STUDY.model, target: STUDY.target };
}
function studyNative() { return !!(tauriHost() && tauriHost().core); }
function studyReady() {
  return studyNative() && !!String(STUDY.key || '').trim() && !!String(STUDY.model || '').trim() &&
    (STUDY.provider !== 'custom' || !!String(STUDY.endpoint || '').trim());
}
async function studyChat(system, user) {
  if (!studyNative()) throw new Error('AI 学英语需要在桌面版使用。');
  if (!studyReady()) throw new Error(STUDY.provider === 'custom' ? '请先在「设置 → AI 学英语」填写接口地址、API Key 和模型。' : '请先在「设置 → AI 学英语」填写 API Key 和模型。');
  const host = tauriHost();
  return await host.core.invoke('llm_chat', { req: { config: studyConfig(), system, user } });
}
function studyParseJson(text) {
  let s = String(text || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch (e) { return { raw: String(text || '').trim() }; }
}
function studyCurrentCue() {
  const cues = state.cues || [];
  if (!cues.length) return null;
  let ci = state.activeCue;
  if (ci < 0 || !cues[ci]) ci = 0;
  return { cue: cues[ci], ci };
}
/* 面板可能在文字稿还没到手时就被打开（S 快捷键尤其容易抢在 fetch 前面），
   原来会直接定格在「没有可用的文字稿」。这里等 cue 到齐后补渲一次，最多等 15 秒。 */
let studyCueWaitTimer = 0, studyCueWaitFn = null;
function studyWithCues(fn) {
  if ((state.cues || []).length) { fn(); return; }
  if (!state.current) return;
  studyCueWaitFn = fn;
  if (studyCueWaitTimer) return;
  studyCueWaitTimer = setInterval(() => {
    if (!(state.cues || []).length) return;
    clearInterval(studyCueWaitTimer);
    studyCueWaitTimer = 0;
    const fn2 = studyCueWaitFn;
    studyCueWaitFn = null;
    if (fn2) fn2();
  }, 700);
  setTimeout(() => {
    if (studyCueWaitTimer) { clearInterval(studyCueWaitTimer); studyCueWaitTimer = 0; studyCueWaitFn = null; }
  }, 15000);
}
function studyCurrentKey(cur) {
  const ep = state.current ? state.current.id : 'none';
  return ep + ':' + cur.ci + ':' + studyHash(cur.cue.text || '');
}
function studySourceLabel() {
  const show = state.show ? (state.show.name || state.show.slug) : '';
  const ep = state.current ? (state.current.title || '') : '';
  return [show, ep].filter(Boolean).join(' · ');
}
function studyEmpty(text) { return '<div class="study-empty">' + esc(text) + '</div>'; }
function studyLoading(text) {
  return '<div class="study-loading"><span class="loader"><span class="bars"><i></i><i></i><i></i></span></span><span>' + esc(text) + '</span></div>';
}
function studyLines(value) {
  return String(value || '').split(/\n+/).filter(Boolean).map(line => '<p>' + esc(line) + '</p>').join('');
}
function studySameRootList(item) {
  const arr = Array.isArray(item?.sameRootWords) ? item.sameRootWords : [];
  return arr.map(x => typeof x === 'string'
    ? { word: String(x || '').trim(), meaning: '' }
    : { word: String(x?.word || '').trim(), meaning: String(x?.meaning || '').trim() })
    .filter(x => x.word).slice(0, 4);
}
function studyRootHTML(item) {
  if (!item) return '';
  const breakdown = String(item.rootBreakdown || '').trim();
  const meaning = String(item.rootMeaning || '').trim();
  const roots = studySameRootList(item);
  const hook = String(item.memoryHook || '').trim();
  if (!breakdown && !meaning && !roots.length && !hook) return '';
  let html = '<div class="study-root">';
  if (breakdown) html += '<div class="study-root-line"><span class="study-root-tag">词根</span><b>' + esc(breakdown) + '</b></div>';
  if (meaning) html += '<div class="study-root-line"><span class="study-root-tag">字面</span><span>' + esc(meaning) + '</span></div>';
  if (roots.length) html += '<div class="study-root-line"><span class="study-root-tag">同根</span><span>' +
    roots.map(x => esc(x.word) + (x.meaning ? '（' + esc(x.meaning) + '）' : '')).join(' · ') + '</span></div>';
  if (hook) html += '<div class="study-root-line"><span class="study-root-tag">记忆</span><span>' + esc(hook) + '</span></div>';
  return html + '</div>';
}
function studySameRootText(item) {
  return studySameRootList(item).map(x => x.word + (x.meaning ? '=' + x.meaning : '')).join(' | ');
}
function studySetVocabulary(vocab) {
  studyTermData = new Map();
  (Array.isArray(vocab) ? vocab : []).forEach(item => {
    const key = String(item?.word || '').trim().toLowerCase();
    if (key && !studyTermData.has(key)) studyTermData.set(key, item);
  });
  studyTermFocusKeys = new Set();
}
function studyTermChipHTML(word) {
  const raw = String(word || '').trim();
  const key = raw.toLowerCase();
  const item = studyTermData.get(key);
  if (!item) return esc(raw);
  const label = raw + (item.meaning ? '：' + String(item.meaning) : '');
  return '<span class="study-term" data-term="' + esc(key) + '" tabindex="0" aria-label="' + esc(label) + '">' + esc(raw) + '</span>';
}
function studyAnnotateText(value) {
  const raw = String(value == null ? '' : value);
  if (!raw) return '';
  if (!studyTermData.size) return esc(raw);
  const terms = [...studyTermData.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!terms.length) return esc(raw);
  let matcher;
  try {
    matcher = new RegExp('(?<![A-Za-z])(' + terms.map(studyRegexEscape).join('|') + ')(?![A-Za-z])', 'gi');
  } catch (e) {
    return esc(raw);
  }
  let html = '', last = 0;
  raw.replace(matcher, (match, word, offset) => {
    const key = String(match).toLowerCase();
    const item = studyTermData.get(key);
    if (!item) return match;
    html += esc(raw.slice(last, offset));
    const focus = !studyTermFocusKeys.has(key);
    if (focus) studyTermFocusKeys.add(key);
    const label = String(item.word || match) + (item.meaning ? '：' + String(item.meaning) : '');
    html += '<span class="study-term" data-term="' + esc(key) + '"' +
      (focus ? ' tabindex="0"' : '') + ' aria-label="' + esc(label) + '">' + esc(match) + '</span>';
    last = offset + String(match).length;
    return match;
  });
  return html + esc(raw.slice(last));
}
function studyAnnotatedLines(value) {
  return String(value || '').split(/\n+/).filter(Boolean).map(line => '<p>' + studyAnnotateText(line) + '</p>').join('');
}
function studyTermTipElement() {
  let tip = $('studyTermTip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'studyTermTip';
    tip.className = 'study-term-tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.appendChild(tip);
  }
  return tip;
}
function studyTermTipHTML(item) {
  if (!item) return '';
  const word = String(item.word || '').trim();
  return '<div class="tt-head"><b>' + esc(word) + '</b>' +
    (item.phonetic ? '<em>' + esc(item.phonetic) + '</em>' : '') + '</div>' +
    '<div class="tt-meaning">' + esc(item.meaning || '暂无释义') + '</div>' +
    (item.example ? '<div class="tt-example"><b>例</b> ' + esc(item.example) +
      (item.exampleZh ? '<br>' + esc(item.exampleZh) : '') + '</div>' : '') +
    studyRootHTML(item);
}
function studyShowTermTip(term, itemOverride) {
  if (!term) return;
  const key = term.dataset.term || cleanWord(term.textContent || '');
  const item = itemOverride || studyTermData.get(key) || studyTranscriptTermData.get(key);
  if (!item) return;
  const tip = studyTermTipElement();
  tip.innerHTML = studyTermTipHTML(item);
  tip.hidden = false;
  tip.classList.add('on');
  tip.dataset.term = key;
  tip.style.left = '0px';
  tip.style.top = '0px';
  const rect = term.getBoundingClientRect();
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  let left = rect.left + rect.width / 2 - width / 2;
  left = Math.max(10, Math.min(left, window.innerWidth - width - 10));
  let top = rect.top - height - 9;
  if (top < 10) top = rect.bottom + 9;
  top = Math.max(10, Math.min(top, window.innerHeight - height - 10));
  tip.style.left = Math.round(left) + 'px';
  tip.style.top = Math.round(top) + 'px';
}
function studyHideTermTip() {
  const tip = $('studyTermTip');
  if (tip) {
    tip.classList.remove('on');
    tip.hidden = true;
  }
  document.querySelectorAll('.study-term.on,.word.vocab-mark.on').forEach(el => el.classList.remove('on'));
}
function studyHoverTerm(target) {
  if (!target || !target.closest) return null;
  return target.closest('.study-term, .word.vocab-mark');
}
function studyTermItemOf(term) {
  if (!term) return null;
  const key = term.dataset.term || cleanWord(term.textContent || '');
  return studyTermData.get(key) || studyTranscriptTermData.get(key);
}
function bindStudyTermTips() {
  if (app.studyTermTipsBound) return;
  app.studyTermTipsBound = true;
  document.addEventListener('mouseover', event => {
    const term = studyHoverTerm(event.target);
    const item = studyTermItemOf(term);
    if (!term || !item || term.contains(event.relatedTarget)) return;
    term.classList.add('on');
    studyShowTermTip(term, item);
  });
  document.addEventListener('mouseout', event => {
    const term = studyHoverTerm(event.target);
    if (!term || term.contains(event.relatedTarget) || studyTermPinned) return;
    term.classList.remove('on');
    studyHideTermTip();
  });
  document.addEventListener('focusin', event => {
    const term = studyHoverTerm(event.target);
    const item = studyTermItemOf(term);
    if (term && item) { term.classList.add('on'); studyShowTermTip(term, item); }
  });
  document.addEventListener('focusout', event => {
    if (studyTermPinned) return;
    if (studyHoverTerm(event.target)) studyHideTermTip();
  });
  document.addEventListener('click', event => {
    const term = event.target.closest && event.target.closest('.study-term');
    if (term) {
      event.preventDefault();
      const item = studyTermItemOf(term);
      const tip = $('studyTermTip');
      const same = studyTermPinned && tip && tip.dataset.term === (term.dataset.term || '');
      studyTermPinned = !same;
      document.querySelectorAll('.study-term.on,.word.vocab-mark.on').forEach(el => el.classList.remove('on'));
      if (studyTermPinned && item) { term.classList.add('on'); studyShowTermTip(term, item); }
      else studyHideTermTip();
      return;
    }
    if (!event.target.closest || !event.target.closest('#studyTermTip')) {
      studyTermPinned = false;
      studyHideTermTip();
    }
  }, true);
  document.addEventListener('scroll', () => {
    studyTermPinned = false;
    studyHideTermTip();
  }, true);
}
function studyVocabCards(items, addable) {
  studyRenderedVocab = addable ? (items || []) : [];
  return (items || []).map((v, i) => {
    const word = String(v.word || '').trim();
    if (!word) return '';
    const inVocab = studyVocab.some(x => cleanWord(x.word) === cleanWord(word));
    return '<div class="study-vocab"><strong>' + studyTermChipHTML(word) + '</strong>' +
      (v.phonetic ? '<em>' + esc(v.phonetic) + '</em>' : '') +
      '<small>' + esc(v.meaning || '') + '</small>' +
      (v.example ? '<small><b>例：</b>' + esc(v.example) + (v.exampleZh ? '<br>' + esc(v.exampleZh) : '') + '</small>' : '') +
      studyRootHTML(v) +
      (addable ? (inVocab ? '<span class="study-badge">已在生词本</span>' :
        '<button class="btn ghost small vocab-add" data-study-add="' + i + '">＋ 生词本（含原句音频）</button>') : '') +
      '</div>';
  }).join('');
}
function studyCardHTML(data) {
  if (!data) return '';
  studySetVocabulary(data.vocabulary);
  if (data.raw) return '<div class="study-section"><h4>模型原文</h4><p>' + esc(data.raw).replace(/\n/g, '<br>') + '</p></div>';
  let html = '';
  if (data.translation) html += '<div class="study-section"><h4>参考译文</h4>' + studyAnnotatedLines(data.translation) + '</div>';
  if (data.literal && data.literal !== data.translation) html += '<div class="study-section"><h4>直译</h4>' + studyAnnotatedLines(data.literal) + '</div>';
  if (data.explanation) html += '<div class="study-section"><h4>这句话在说什么</h4>' + studyAnnotatedLines(data.explanation) + '</div>';
  if (data.paraphrase) html += '<div class="study-section"><h4>换一种说法</h4>' + studyAnnotatedLines(data.paraphrase) + '</div>';
  if (Array.isArray(data.grammar) && data.grammar.length) {
    html += '<div class="study-section"><h4>语法点</h4>' + data.grammar.map(g =>
      '<p><b>' + esc(g.point || '') + '</b>　' + studyAnnotateText(g.detail || '') + '</p>').join('') + '</div>';
  }
  if (Array.isArray(data.vocabulary) && data.vocabulary.length) {
    html += '<div class="study-section"><h4>词汇与表达</h4>' + studyVocabCards(data.vocabulary, true) + '</div>';
  }
  return html;
}
function studyClockSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  const s = String(value || '').trim().replace(/[\[\]]/g, '');
  if (!s) return NaN;
  const parts = s.split(':').map(part => Number(part));
  if (parts.some(part => !Number.isFinite(part))) return NaN;
  if (parts.length === 1) return Math.max(0, parts[0]);
  if (parts.length === 2) return Math.max(0, parts[0] * 60 + parts[1]);
  if (parts.length === 3) return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
  return NaN;
}
function studyTopicHTML(data) {
  const topics = Array.isArray(data?.topics) ? data.topics : [];
  if (!topics.length) return '';
  return '<div class="study-section"><h4>主题时间戳</h4>' + topics.map(topic => {
    if (!topic || typeof topic !== 'object') return '';
    const title = String(topic.title || topic.topic || '').trim();
    const start = studyClockSeconds(topic.start ?? topic.time ?? topic.timestamp);
    if (!title && !Number.isFinite(start)) return '';
    const when = Number.isFinite(start) ? fmt(start) : '';
    return '<div class="study-topic">' +
      (when ? '<button class="btn ghost small" data-study-act="topic" data-study-t="' + Math.round(start) + '">▶ ' + esc(when) + '</button>' : '') +
      '<div><strong>' + studyAnnotateText(title || '未命名主题') + '</strong>' +
      (topic.summary ? '<p>' + studyAnnotateText(topic.summary) + '</p>' : '') + '</div></div>';
  }).join('') + '</div>';
}
function studyAdHTML(data) {
  const ads = studyAdRangesFromData(data);
  if (!ads.length) return '';
  return '<div class="study-section"><h4>广告点</h4>' + ads.map(ad => {
    return '<div class="study-topic study-ad">' +
      '<button class="btn ghost small" data-study-act="ad" data-study-t="' + Math.round(ad.end) + '">跳过</button>' +
      '<div><strong>' + esc(ad.label || '广告') + '</strong><p>' + esc(fmt(ad.start)) + ' – ' + esc(fmt(ad.end)) + '</p></div></div>';
  }).join('') + '</div>';
}
function studyEpisodeHTML(data) {
  if (!data) return '';
  studySetVocabulary(data.vocabulary);
  let html = '<div class="study-section"><h4>内容摘要</h4>' + studyAnnotatedLines(data.summary || '') + '</div>';
  html += studyAdHTML(data);
  html += studyTopicHTML(data);
  if (Array.isArray(data.keyPoints) && data.keyPoints.length) {
    html += '<div class="study-section"><h4>重点</h4>' + data.keyPoints.map(x => '<p>· ' + studyAnnotateText(x) + '</p>').join('') + '</div>';
  }
  if (Array.isArray(data.hardSentences) && data.hardSentences.length) {
    html += '<div class="study-section"><h4>难句</h4>' + data.hardSentences.map(x =>
      '<div class="study-vocab"><strong>' + studyAnnotateText(x.en || '') + '</strong><small>' + esc(x.zh || '') +
      (x.why ? '<br><b>难点：</b>' + studyAnnotateText(x.why) : '') + '</small></div>').join('') + '</div>';
  }
  if (Array.isArray(data.questions) && data.questions.length) {
    html += '<div class="study-section"><h4>可以想一下</h4>' + data.questions.map(x => '<p>· ' + studyAnnotateText(x) + '</p>').join('') + '</div>';
  }
  if (Array.isArray(data.vocabulary) && data.vocabulary.length) {
    html += '<div class="study-section"><h4>词汇与表达</h4>' + studyVocabCards(data.vocabulary, true) + '</div>';
  }
  return html;
}
function applyStudyProvider(id, fillDefaults) {
  const meta = STUDY_PROVIDERS[id];
  if (!meta) return;
  STUDY.provider = id;
  if (fillDefaults) {
    STUDY.endpoint = meta.endpoint;
    STUDY.model = meta.model;
  }
  studyClearModels();
  const modelStatus = $('studyModelStatus'); if (modelStatus) { modelStatus.textContent = ''; modelStatus.style.color = ''; }
  saveStudy();
  syncStudySettings();
}
function syncStudySettings() {
  const provider = $('studyProvider'); if (provider) provider.value = STUDY.provider || 'openai';
  const meta = studyProviderMeta();
  const hint = $('studyProviderHint'); if (hint) hint.textContent = meta.hint;
  const modelHint = $('studyModelHint'); if (modelHint) modelHint.textContent = meta.modelHint;
  const endpoint = $('studyEndpoint');
  if (endpoint) {
    endpoint.value = STUDY.endpoint || '';
    endpoint.placeholder = meta.endpoint || 'https://example.com/v1';
  }
  const key = $('studyKey');
  if (key) {
    key.value = STUDY.key || '';
    key.placeholder = meta.keyHint;
  }
  const model = $('studyModel');
  if (model) {
    model.value = STUDY.model || '';
    model.placeholder = meta.model || 'model-name';
  }
  const target = $('studyTarget'); if (target) target.value = STUDY.target || 'zh-CN';
  const status = $('studyStatus');
  if (status) {
    const hasKey = !!String(STUDY.key || '').trim();
    const hasModel = !!String(STUDY.model || '').trim();
    status.textContent = !studyNative() ? '桌面版才能用'
      : !String(STUDY.endpoint || '').trim() && STUDY.provider === 'custom' ? '还缺接口地址'
      : !hasKey ? '还缺 API Key'
      : !hasModel ? '还缺模型'
      : '已配置 · ' + meta.name;
    status.style.color = '';
  }
}
function setStudyView(view) {
  studyView = view;
  studyTermPinned = false;
  studyHideTermTip();
  if (view === 'review') studyReviewRevealed = false;
  if (view === 'practice') studyExercise = null;
  document.querySelectorAll('[data-study-view]').forEach(btn => btn.setAttribute('aria-checked', String(btn.dataset.studyView === view)));
  if (view === 'card') studyRenderCurrent();
  else if (view === 'episode') studyRenderEpisode();
  else if (view === 'ask') studyRenderAsk();
  else if (view === 'review') studyRenderReview();
  else if (view === 'practice') studyRenderPractice();
  else studyRenderVocab();
}
function openStudySheet(view) {
  if (!subtitlePluginOn()) { showToast('字幕插件未启用，AI 学英语不可用。', 'warn'); return; }
  if (!studyPluginOn()) { showToast('学英语插件未启用。', 'warn'); return; }
  if (!moduleOn('study')) return;
  const sheet = $('studySheet');
  if (!sheet) return;
  closeDockSheet(false);
  sheet.hidden = false;
  sheet.classList.add('on');
  $('studyBtn')?.classList.add('on');
  setStudyView(view || studyView || 'card');
  // 打开后把焦点放进当前页签，键盘用户（含 S 快捷键）可以直接用 → 切页签。
  const onTab = sheet.querySelector('[data-study-view][aria-checked="true"]');
  if (onTab && typeof onTab.focus === 'function') onTab.focus({ preventScroll: true });
}
function closeStudySheet() {
  studyTermPinned = false;
  studyHideTermTip();
  studyCloseQuoteCard();
  const sheet = $('studySheet');
  if (!sheet) return;
  sheet.classList.remove('on');
  sheet.hidden = true;
  $('studyBtn')?.classList.remove('on');
}
function studyRenderNow() {
  const cur = studyCurrentCue();
  const now = $('studyNow');
  if (now) now.textContent = cur ? fmt(cur.cue.start + state.offset) + ' · ' + String(cur.cue.text || '').slice(0, 34) : '—';
  studyUpdateDueBadge();
}
function studyRenderCurrent() {
  const body = $('studyBody');
  if (!body) return;
  const cur = studyCurrentCue();
  studyRenderNow();
  if (!cur) {
    body.innerHTML = studyEmpty(state.current ? '字幕加载中…' : '这一集没有可用的文字稿。');
    if (state.current) studyWithCues(() => { if (studyView === 'card') studyRenderCurrent(); });
    return;
  }
  const key = studyCurrentKey(cur);
  const cached = studyCache[key];
  studyVocabContext = cur.cue; studyVocabContextMode = 'card';
  let html = '<p class="study-cue">' + esc(cur.cue.text || '') + '</p>';
  if (cur.cue.zh && !studyHideZh) html += '<p class="study-empty">' + esc(cur.cue.zh) + '</p>';
  html += '<div class="study-actions">' +
    '<button class="btn ghost small" data-study-act="playCue">▶ 听本句</button>' +
    '<button class="btn ghost small" data-study-act="loopCue">循环 3 次</button>' +
    '<button class="study-toggle" data-study-act="autoPause" aria-pressed="' + String(studyAutoPause) + '">自动暂停</button>' +
    '<button class="study-toggle" data-study-act="hideZh" aria-pressed="' + String(studyHideZh) + '">隐藏译文</button>' +
    '</div>';
  html += '<div class="study-actions"><button class="btn primary small" data-study-act="current">' +
    (cached ? '重新分析当前句' : '分析当前句') + '</button>' +
    '<span class="study-badge">' + (cached ? '已缓存' : '按需调用') + '</span></div>';
  if (cached && cached.data) html += studyCardHTML(cached.data);
  body.innerHTML = html;
  bindStudyActButtons();
  studyApplyWordMarks();
}
function studyRenderEpisode() {
  const body = $('studyBody');
  if (!body) return;
  if (!state.current) { body.innerHTML = studyEmpty('先选择一集。'); return; }
  studyVocabContext = null; studyVocabContextMode = 'episode';
  const key = 'ep:' + state.current.id;
  const cached = studyCache[key];
  const chapters = studyChapterEntry();
  const quotes = studyQuoteEntry();
  let html = '<p class="study-empty">' + esc(state.current.title || '当前单集') + '</p>';
  html += '<div class="study-actions"><button class="btn primary small" data-study-act="episode">' +
    (cached ? '重新总结整集' : '总结整集') + '</button>' +
    '<button class="btn ghost small" data-study-act="chapters">' + (chapters ? '重新生成章节' : '生成章节') + '</button>' +
    '<button class="btn ghost small" data-study-act="quotes">' + (quotes ? '重新挑金句' : '挑金句') + '</button>' +
    (cached && cached.data ? '<button class="btn ghost small" data-study-act="copyEpisode">复制总结</button>' : '') +
    '<span class="study-badge">' + (cached ? '已缓存' : '按段分块请求') + '</span></div>';
  html += studyChaptersHTML(chapters && chapters.data);
  if (cached && cached.data) {
    studyApplyAiAdRanges(cached.data, state.current.id);
    html += studyEpisodeHTML(cached.data);
    if (cached.data.version !== 3) html += '<p class="study-empty">旧版缓存没有广告点，点「重新总结整集」生成。</p>';
  } else {
    html += '<p class="study-empty">整集会按文字稿分成 3 块分析；每块单独请求，并生成主题时间戳。中途失败只重试失败的块。章节和金句都按文字稿行号映射时间，不会让模型自己编时间戳。</p>';
  }
  html += studyQuotesHTML(quotes && quotes.data);
  body.innerHTML = html;
  bindStudyActButtons();
  studyApplyWordMarks();
}
function studyRenderVocab() {
  const body = $('studyBody');
  if (!body) return;
  studyVocabContext = null; studyVocabContextMode = null;
  studyRenderNow();
  if (!studyVocab.length) { body.innerHTML = studyEmpty('生词本还是空的。在句子卡片里点「＋ 生词本」就会收进来。'); return; }
  studySetVocabulary(studyVocab);
  const st = studyStats(), cov = studyCoverage();
  body.innerHTML = '<div class="study-actions"><span class="study-badge">' + st.total + ' 个词条</span>' +
    '<span class="study-badge">待复习 ' + st.due + '</span>' +
    '<span class="study-badge">已掌握 ' + st.known + '</span>' +
    '<span class="study-badge">本集覆盖 ' + cov.pct + '%</span>' +
    '<button class="btn ghost small" data-study-export="1">导出 CSV</button></div>' +
    studyVocab.map((v, i) => {
      const status = v.status === 'known' ? '已掌握' : v.status === 'ignored' ? '已忽略' : '学习中';
      return '<div class="study-vocab"><strong>' + studyTermChipHTML(v.word) + '</strong>' +
        (v.phonetic ? '<em>' + esc(v.phonetic) + '</em>' : '') +
        '<span class="study-badge">' + status + '</span>' +
        '<small>' + esc(v.meaning || '') + '</small>' +
        (v.example ? '<small><b>例：</b>' + esc(v.example) + (v.exampleZh ? '<br>' + esc(v.exampleZh) : '') + '</small>' : '') +
        studyRootHTML(v) +
        (v.source ? '<small>' + esc(v.source) + '</small>' : '') +
        '<small>' + (v.due ? '下次复习：' + studyDueLabel(v.due) : '未排期') + ' · 复习 ' + (v.reps || 0) + ' 次</small>' +
        '<div class="study-actions">' +
        (Number.isFinite(Number(v.start)) ? '<button class="btn ghost small" data-study-play-vocab="' + i + '">▶ 原句</button>' : '') +
        '<button class="btn ghost small" data-study-status-vocab="' + i + '">' + (v.status === 'known' ? '恢复学习' : '标记已掌握') + '</button>' +
        '<button class="btn ghost small vocab-add" data-study-del-vocab="' + i + '">移出生词本</button></div></div>';
    }).join('');
  body.querySelectorAll('[data-study-del-vocab]').forEach(btn => {
    btn.onclick = () => {
      const i = Number(btn.dataset.studyDelVocab);
      if (!Number.isFinite(i)) return;
      const word = studyVocab[i]?.word;
      if (word) studyMarkWord(word, '');
      studyVocab.splice(i, 1);
      saveStudyVocab();
      studyApplyWordMarks();
      studyRenderVocab();
    };
  });
  body.querySelectorAll('[data-study-play-vocab]').forEach(btn => {
    btn.onclick = () => studyPlayItem(studyVocab[Number(btn.dataset.studyPlayVocab)]);
  });
  body.querySelectorAll('[data-study-status-vocab]').forEach(btn => {
    btn.onclick = () => {
      const i = Number(btn.dataset.studyStatusVocab);
      const item = studyVocab[i];
      if (!item) return;
      studyMarkWord(item.word, item.status === 'known' ? 'learning' : 'known');
      studyRenderVocab();
    };
  });
  const exportBtn = body.querySelector('[data-study-export]');
  if (exportBtn) exportBtn.onclick = studyExportCsv;
}
function studyRenderReview() {
  const body = $('studyBody');
  if (!body) return;
  studyVocabContext = null; studyVocabContextMode = null;
  studyRenderNow();
  const st = studyStats();
  if (!studyVocab.length) { body.innerHTML = studyEmpty('生词本还是空的。先在句子卡片里收几个词，再回来复习。'); return; }
  const due = studyDueItems();
  const head = '<div class="study-actions"><span class="study-badge">待复习 ' + due.length + '</span>' +
    '<span class="study-badge">已掌握 ' + st.known + '</span>' +
    '<span class="study-badge">今日已复习 ' + st.reviewed + '</span></div>';
  if (!due.length) {
    const next = studyVocab.filter(v => v.status !== 'known' && v.status !== 'ignored' && v.due)
      .sort((a, b) => Number(a.due) - Number(b.due))[0];
    body.innerHTML = head + '<div class="study-section"><h4>今天清空了</h4><p>' +
      (next ? '下一次复习：' + studyDueLabel(next.due) + '（' + esc(next.word) + '）' : '还没有排期的词条。') +
      '</p></div>';
    return;
  }
  const v = due[0];
  const source = [v.source, v.example ? '原句：' + v.example : ''].filter(Boolean).join('\n');
  let html = head + '<div class="study-review-word">' + esc(v.word) + '</div>' +
    (v.phonetic ? '<div class="study-review-meta">' + esc(v.phonetic) + '</div>' : '') +
    '<div class="study-actions">' +
    (Number.isFinite(Number(v.start)) ? '<button class="btn ghost small" data-study-act="playReview">▶ 听原句</button>' : '') +
    '<button class="btn primary small" data-study-act="reveal">显示答案</button></div>';
  if (studyReviewRevealed) {
    html += '<div class="study-answer"><strong>' + esc(v.meaning || '（没有释义）') + '</strong>' +
      (v.example ? '<div style="margin-top:6px">' + esc(v.example) + '</div>' : '') +
      (v.exampleZh ? '<div class="study-empty">' + esc(v.exampleZh) + '</div>' : '') +
      studyRootHTML(v) +
      (v.source ? '<div class="study-review-meta" style="margin-top:6px">' + esc(v.source) + '</div>' : '') + '</div>' +
      '<div class="study-grade">' +
      '<button data-study-grade="0">忘记</button><button data-study-grade="1">模糊</button>' +
      '<button data-study-grade="2">记得</button><button data-study-grade="3">很简单</button></div>' +
      '<p class="study-empty">忘记：10 分钟后；模糊/记得/很简单：按记忆曲线往后排。</p>';
  } else {
    html += '<p class="study-empty">先在心里回想，再显示答案。' + (source ? '上下文已保存。' : '') + '</p>';
  }
  body.innerHTML = html;
  bindStudyActButtons();
}
function studyExerciseTarget(cue) {
  const words = (cue.words || []).map(w => String(w.t || '').trim()).filter(w => /^[A-Za-z][A-Za-z'’-]*$/.test(w));
  return words.sort((a, b) => b.length - a.length)[0] || String(cue.text || '').split(/\s+/).find(w => w.length > 4) || 'word';
}
function studyStartExercise(type) {
  const cur = studyCurrentCue();
  if (!cur) return;
  const cue = cur.cue;
  const target = studyExerciseTarget(cue);
  const key = studyCurrentKey(cur);
  let sentence = String(cue.text || '');
  if (type === 'cloze' && target) {
    const idx = sentence.toLowerCase().indexOf(target.toLowerCase());
    if (idx >= 0) sentence = sentence.slice(0, idx) + '____' + sentence.slice(idx + target.length);
  }
  studyExercise = { type, key, cue, target, sentence, answer: type === 'cloze' ? target : String(cue.text || ''), checked: false, correct: false, pct: 0 };
}
function studyRenderPractice() {
  const body = $('studyBody');
  if (!body) return;
  const cur = studyCurrentCue();
  studyRenderNow();
  if (!cur) {
    body.innerHTML = studyEmpty(state.current ? '字幕加载中…' : '这一集没有可用的文字稿。');
    if (state.current) studyWithCues(() => { if (studyView === 'practice') studyRenderPractice(); });
    return;
  }
  if (!studyExercise || studyExercise.key !== studyCurrentKey(cur)) {
    body.innerHTML = '<div class="study-actions"><button class="btn primary small" data-study-ex="cloze">填空练习</button>' +
      '<button class="btn ghost small" data-study-ex="dictation">听写练习</button></div>' +
      '<p class="study-empty">填空：挖掉原句里最有信息量的词。听写：先听原句，再写下你听到的内容。两者都不调用 LLM。</p>';
    bindStudyActButtons();
    return;
  }
  const ex = studyExercise;
  let html = '<div class="study-actions"><button class="study-toggle" data-study-ex="cloze" aria-pressed="' + String(ex.type === 'cloze') + '">填空</button>' +
    '<button class="study-toggle" data-study-ex="dictation" aria-pressed="' + String(ex.type === 'dictation') + '">听写</button>' +
    '<button class="btn ghost small" data-study-act="playEx">▶ 听本句</button>' +
    '<button class="btn ghost small" data-study-act="nextEx">换一句</button></div>';
  if (ex.type === 'cloze') {
    html += '<p class="study-cue">' + esc(ex.sentence) + '</p>';
  } else {
    html += '<p class="study-empty">听原句，然后写下你听到的完整句子。可以重复听。</p>';
  }
  html += '<input class="study-input" id="studyPracticeInput" autocomplete="off" spellcheck="false" placeholder="' +
    (ex.type === 'cloze' ? '填入被挖掉的词' : '写下你听到的句子') + '" value="' + esc(ex.input || '') + '">';
  html += '<div class="study-actions"><button class="btn primary small" data-study-act="checkEx">检查答案</button>' +
    '<button class="btn ghost small" data-study-act="showEx">显示答案</button></div>';
  if (ex.checked) {
    html += '<div class="study-answer"><div class="' + (ex.correct ? 'study-ok' : 'study-bad') + '">' +
      (ex.correct ? '✓ 正确' : (ex.type === 'dictation' ? '正确率约 ' + ex.pct + '%' : '再试一次')) + '</div>' +
      '<div style="margin-top:6px">答案：' + esc(ex.answer) + '</div></div>';
  }
  body.innerHTML = html;
  const input = $('studyPracticeInput');
  if (input) {
    input.oninput = () => { if (studyExercise) studyExercise.input = input.value; };
    input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); studyCheckExercise(); } };
    input.focus();
  }
  bindStudyActButtons();
}
function studyCheckExercise(showOnly) {
  const ex = studyExercise;
  if (!ex) return;
  const input = $('studyPracticeInput');
  if (input) ex.input = input.value;
  if (showOnly) {
    ex.checked = false;
    if (ex.type === 'cloze') ex.answer = ex.target;
    studyExercise = ex;
    const body = $('studyBody');
    if (body) body.innerHTML = '<div class="study-section"><h4>答案</h4><p>' + esc(ex.answer) + '</p>' +
      '<button class="btn ghost small" data-study-act="backEx">继续练习</button></div>';
    bindStudyActButtons();
    return;
  }
  if (ex.type === 'cloze') {
    ex.correct = studyNormText(ex.input).replace(/\s+/g, '') === studyNormText(ex.target).replace(/\s+/g, '');
    ex.pct = ex.correct ? 100 : 0;
    if (!ex.correct) studyMarkWord(ex.target, 'learning');
  } else {
    const a = studyNormText(ex.input).split(' ').filter(Boolean);
    const b = studyNormText(ex.answer).split(' ').filter(Boolean);
    const hit = a.filter((w, i) => w === b[i]).length;
    ex.pct = b.length ? Math.round(hit / b.length * 100) : 0;
    ex.correct = ex.pct >= 90;
  }
  ex.checked = true;
  studyRenderPractice();
}
function bindStudyVocabButtons() {
  document.querySelectorAll('[data-study-add]').forEach(btn => {
    btn.onclick = () => {
      const i = Number(btn.dataset.studyAdd);
      const item = studyRenderedVocab[i];
      if (!item) return;
      const cue = studyVocabContextMode === 'card' ? (studyCurrentCue()?.cue || null) : null;
      studyAddVocab(item, cue);
      btn.textContent = '✓ 已在生词本';
      btn.disabled = true;
    };
  });
}
function studyAddVocab(item, cueOverride) {
  const word = String(item.word || '').trim();
  if (!word) return;
  if (studyVocab.some(v => String(v.word || '').toLowerCase() === word.toLowerCase())) {
    showToast('生词本里已经有「' + word + '」了。', 2500);
    return;
  }
  const fallback = cueOverride || (studyVocabContextMode === 'card' ? studyVocabContext : null);
  const ctx = studyCueContext(item.example || '', fallback);
  studyVocab.unshift({
    word, phonetic: item.phonetic || '', meaning: item.meaning || '',
    example: item.example || '', exampleZh: item.exampleZh || '',
    rootBreakdown: item.rootBreakdown || '', rootMeaning: item.rootMeaning || '',
    sameRootWords: studySameRootList(item), memoryHook: item.memoryHook || '',
    source: studySourceLabel(), at: Date.now(),
    status: 'learning', due: Date.now(), interval: 0, ease: 2.5, reps: 0, lapses: 0,
    start: ctx.start, end: ctx.end, speechStart: ctx.speechStart, speechEnd: ctx.speechEnd,
    episodeId: ctx.episodeId || '', showSlug: ctx.showSlug || '', episodeTitle: ctx.episodeTitle || '',
  });
  studyMarkWord(word, 'learning');
  saveStudyVocab();
  studyUpdateDueBadge();
  showToast('已加入生词本：' + word + '（已排入复习）', 3000);
}
async function studyAnalyzeCurrent() {
  const cur = studyCurrentCue();
  if (!cur) return;
  const body = $('studyBody');
  const key = studyCurrentKey(cur);
  if (!studyReady()) { body.innerHTML = studyEmpty('请先在「设置 → AI 学英语」填写 API Key 和模型。'); return; }
  body.innerHTML = studyLoading('正在分析当前句…');
  const prev = state.cues[cur.ci - 1]?.text || '';
  const next = state.cues[cur.ci + 1]?.text || '';
  const system = 'You are an English-learning coach for Chinese learners. Explain the target sentence accurately and ' +
    'concisely in ' + studyLangName() + '. Return ONLY a JSON object, no markdown fences, with keys: ' +
    'translation (string), literal (string, word-for-word if useful), explanation (string), ' +
    'grammar (array of {point, detail}), vocabulary (array of {word, phonetic, meaning, example, exampleZh, rootBreakdown, rootMeaning, sameRootWords, memoryHook}), ' +
    'paraphrase (string). For vocabulary, add root analysis only when the word is morphologically transparent: ' +
    'rootBreakdown = prefix + root + suffix with hyphens and Chinese gloss; rootMeaning = literal meaning; ' +
    'sameRootWords = array of up to 2 real English words {word, meaning} sharing the same root; memoryHook = one short Chinese memory sentence. ' +
    'Never invent roots or etymology; leave these fields empty when unsure. Keep vocabulary to at most 6 useful items. ' +
    'Do not invent facts about the episode.';
  const user = JSON.stringify({ target: cur.cue.text, previous: prev, next, show: state.show?.name || '', episode: state.current?.title || '' });
  try {
    const out = await studyChat(system, user);
    const data = studyParseJson(out);
    studyCache[key] = { at: Date.now(), data };
    saveStudyCache();
    studyRenderCurrent();
  } catch (err) {
    body.innerHTML = '<div class="study-section"><h4>分析失败</h4><p>' + esc(err.message || err) + '</p>' +
      '<button class="btn ghost small" data-study-act="current">重试</button></div>';
    bindStudyActButtons();
  }
}
async function studyAnalyzeEpisode() {
  const body = $('studyBody');
  if (!state.current) return;
  if (!studyReady()) { body.innerHTML = studyEmpty('请先在「设置 → AI 学英语」填写 API Key 和模型。'); return; }
  const cues = state.cues || [];
  if (!cues.length) { body.innerHTML = studyEmpty('这一集没有文字稿，无法分析整集。'); return; }
  const lines = cues.map(cue => '[' + fmt(cue.start + state.offset) + '] ' + (cue.text || ''));
  if (!lines.length) { body.innerHTML = studyEmpty('没有可分析的文字稿。'); return; }
  const partCount = Math.min(STUDY_SUMMARY_CHUNKS, lines.length);
  const perPart = Math.ceil(lines.length / partCount);
  const chunks = [];
  for (let i = 0; i < partCount; i++) {
    const part = lines.slice(i * perPart, (i + 1) * perPart);
    if (part.length) chunks.push(part.join('\n'));
  }
  const totalChunks = chunks.length;
  if (!totalChunks) { body.innerHTML = studyEmpty('没有可分析的文字稿。'); return; }
  const system = 'You are a podcast editor summarizing a transcript chunk for a Chinese-speaking listener. ' +
    'Return ONLY a JSON object, no markdown fences, with keys: summary (string in ' + studyLangName() + '), ' +
    'topics (array of {title, start, end, summary}), ads (array of {start, end, label}), keyPoints (array of strings), ' +
    'vocabulary (array of {word, phonetic, meaning, example, exampleZh, rootBreakdown, rootMeaning, sameRootWords, memoryHook}), ' +
    'hardSentences (array of {en, zh, why}), questions (array of strings). ' +
    'For topics: title and summary must be in ' + studyLangName() + '; start/end must be copied from the [mm:ss] timestamps ' +
    'in the transcript, in "mm:ss" format; create 2-8 chronological topics covering the chunk, with no overlap. ' +
    'For ads: identify only explicit sponsor reads, host-read advertisements, ad breaks, or promo/discount endorsements; ' +
    'start/end must be copied from the [mm:ss] timestamps in the transcript, in "mm:ss" format; label must be a short ' +
    studyLangName() + ' description such as "赞助口播" or "优惠码推广"; return [] when there is no ad. ' +
    'Do not mark ordinary brand mentions outside an ad segment. ' +
    'For vocabulary root fields: use rootBreakdown (prefix + root + suffix with hyphens and Chinese gloss), rootMeaning (literal meaning), ' +
    'sameRootWords (up to 2 real English words {word, meaning} sharing the root), memoryHook (one short Chinese memory sentence). ' +
    'Never invent roots or etymology; leave those fields empty when unsure. ' +
    'Write a faithful content summary; keyPoints should be substantive claims, examples or takeaways, not lesson meta. ' +
    'Keep vocabulary to at most 8 items.';
  const epKey = 'ep:' + state.current.id;
  const epId = state.current.id;
  const partialKey = epKey + ':partial';
  const sig = [STUDY.provider, STUDY.endpoint, STUDY.model, STUDY.target, 'ads-v1'].join('|');
  const merged = { summary: [], topics: [], ads: [], keyPoints: [], vocabulary: [], hardSentences: [], questions: [], chunks: totalChunks };
  let resume = 0;
  if (studyCache[epKey] && studyCache[epKey].data && studyCache[epKey].data.version === 3) {
    // 已完整的结果：用户点「重新总结」就是从零开始。
    delete studyCache[partialKey];
  } else {
    const saved = studyCache[partialKey];
    if (saved && saved.sig === sig && Number(saved.chunks) === totalChunks && Number(saved.done) > 0) {
      const data = saved.data || {};
      if (Array.isArray(data.summary)) merged.summary = data.summary.map(x => String(x));
      if (Array.isArray(data.topics)) merged.topics = data.topics.map(t => Object.assign({}, t));
      if (Array.isArray(data.ads)) merged.ads = sanitizeAdRanges(data.ads, 'ai');
      if (Array.isArray(data.keyPoints)) merged.keyPoints = data.keyPoints.slice();
      if (Array.isArray(data.vocabulary)) merged.vocabulary = data.vocabulary.map(v => Object.assign({}, v));
      if (Array.isArray(data.hardSentences)) merged.hardSentences = data.hardSentences.map(x => Object.assign({}, x));
      if (Array.isArray(data.questions)) merged.questions = data.questions.slice();
      resume = Math.min(Number(saved.done) || 0, totalChunks);
    } else if (saved) {
      delete studyCache[partialKey];
    }
  }
  const seenVocab = new Set(merged.vocabulary.map(v => String(v.word || '').trim().toLowerCase()).filter(Boolean));
  const seenHard = new Set(merged.hardSentences.map(x => String(x.en || '').trim().toLowerCase()).filter(Boolean));
  const seenPoint = new Set(merged.keyPoints.concat(merged.questions).map(x => String(x || '').trim()).filter(Boolean));
  const seenTopic = new Set(merged.topics.map(t => String(t.title || '').toLowerCase() + '|' + Math.round(Number(t.start) || 0)));
  const seenAd = new Set(merged.ads.map(ad => Math.round(ad.start) + '|' + Math.round(ad.end)));
  let completed = resume;
  try {
    for (let i = resume; i < totalChunks; i++) {
      body.innerHTML = studyLoading((resume
        ? '继续总结第 ' + (i + 1) + ' / ' + totalChunks + ' 块（已完成 ' + completed + ' 块）'
        : '正在总结第 ' + (i + 1) + ' / ' + totalChunks + ' 块…'));
      const out = await studyChat(system, 'Chunk ' + (i + 1) + ' of ' + totalChunks + ':\n' + chunks[i]);
      const part = studyParseJson(out);
      if (part.raw) { merged.summary.push(part.raw); continue; }
      if (part.summary) merged.summary.push(String(part.summary));
      (Array.isArray(part.topics) ? part.topics : []).forEach(t => {
        if (!t || typeof t !== 'object') return;
        const title = String(t.title || t.topic || '').trim();
        const start = studyClockSeconds(t.start ?? t.time ?? t.timestamp);
        if (!title || !Number.isFinite(start)) return;
        const k = title.toLowerCase() + '|' + Math.round(start);
        if (!seenTopic.has(k)) {
          seenTopic.add(k);
          merged.topics.push({
            title,
            start: Math.round(start),
            end: Number.isFinite(studyClockSeconds(t.end)) ? Math.round(studyClockSeconds(t.end)) : null,
            summary: String(t.summary || '').trim(),
          });
        }
      });
      (Array.isArray(part.ads) ? part.ads : []).forEach(rawAd => {
        const ad = sanitizeAdRanges([rawAd], 'ai')[0];
        if (!ad) return;
        const k = Math.round(ad.start) + '|' + Math.round(ad.end);
        if (!seenAd.has(k)) {
          seenAd.add(k);
          merged.ads.push(ad);
        }
      });
      (Array.isArray(part.keyPoints) ? part.keyPoints : []).forEach(x => {
        const k = String(x || '').trim();
        if (k && !seenPoint.has(k)) { seenPoint.add(k); merged.keyPoints.push(k); }
      });
      (Array.isArray(part.vocabulary) ? part.vocabulary : []).forEach(v => {
        const w = String(v.word || '').trim().toLowerCase();
        if (w && !seenVocab.has(w)) { seenVocab.add(w); merged.vocabulary.push(v); }
      });
      (Array.isArray(part.hardSentences) ? part.hardSentences : []).forEach(x => {
        const k = String(x.en || '').trim().toLowerCase();
        if (k && !seenHard.has(k)) { seenHard.add(k); merged.hardSentences.push(x); }
      });
      (Array.isArray(part.questions) ? part.questions : []).forEach(x => {
        const k = String(x || '').trim();
        if (k && !seenPoint.has(k)) { seenPoint.add(k); merged.questions.push(k); }
      });
      completed = i + 1;
      studyCache[partialKey] = {
        at: Date.now(), sig, chunks: totalChunks, done: completed,
        data: {
          summary: merged.summary.slice(),
          topics: merged.topics.map(t => Object.assign({}, t)),
          ads: merged.ads.map(ad => Object.assign({}, ad)),
          keyPoints: merged.keyPoints.slice(),
          vocabulary: merged.vocabulary.map(v => Object.assign({}, v)),
          hardSentences: merged.hardSentences.map(x => Object.assign({}, x)),
          questions: merged.questions.slice(),
        },
      };
      saveStudyCache();
      studyApplyWordMarks();
    }
    merged.summary = merged.summary.join('\n\n');
    merged.version = 3;
    merged.topics.sort((a, b) => a.start - b.start);
    merged.topics = merged.topics.slice(0, 24);
    merged.ads.sort((a, b) => a.start - b.start);
    merged.ads = sanitizeAdRanges(mergeAdRanges([merged.ads]), 'ai').slice(0, 24);
    merged.vocabulary = merged.vocabulary.slice(0, 30);
    merged.hardSentences = merged.hardSentences.slice(0, 20);
    studyCache[epKey] = { at: Date.now(), data: merged };
    delete studyCache[partialKey];
    saveStudyCache();
    studyApplyAiAdRanges(merged, epId);
    studyRenderEpisode();
  } catch (err) {
    const failed = Math.min(completed + 1, totalChunks);
    const kept = completed ? '已保留前 ' + completed + ' / ' + totalChunks + ' 块。' : '';
    body.innerHTML = '<div class="study-section"><h4>分析失败</h4><p>第 ' + failed + ' / ' + totalChunks + ' 块失败。' + kept +
      (completed < totalChunks ? ' 点「继续剩余块」只重试第 ' + (completed + 1) + ' 块。' : '') +
      '</p><p class="smalltext">' + esc(err.message || err) + '</p><div class="study-actions">' +
      '<button class="btn ghost small" data-study-act="episode">' + (completed ? '继续剩余块' : '重试') + '</button>' +
      (completed ? '<button class="btn ghost small" data-study-act="episodeFresh">从头开始</button>' : '') +
      '</div></div>';
    bindStudyActButtons();
  }
}
function studyRestartEpisodeSummary() {
  if (!state.current) return;
  delete studyCache['ep:' + state.current.id + ':partial'];
  saveStudyCache();
  studyAnalyzeEpisode();
}
function studyEpisodeText(data) {
  if (!data) return '';
  const title = state.current?.title || '当前单集';
  const lines = ['# ' + title, '', '## 内容摘要', String(data.summary || '').trim()].filter(Boolean);
  const ads = studyAdRangesFromData(data);
  if (ads.length) {
    lines.push('', '## 广告点');
    ads.forEach(ad => {
      lines.push('- ' + fmt(ad.start) + '–' + fmt(ad.end) + ' ' + String(ad.label || '广告').trim());
    });
  }
  if (Array.isArray(data.topics) && data.topics.length) {
    lines.push('', '## 主题时间戳');
    data.topics.forEach(topic => {
      const start = studyClockSeconds(topic.start);
      const when = Number.isFinite(start) ? fmt(start) : '';
      const summary = String(topic.summary || '').trim();
      lines.push('- ' + (when ? '[' + when + '] ' : '') + String(topic.title || '').trim() + (summary ? ' — ' + summary : ''));
    });
  }
  if (Array.isArray(data.keyPoints) && data.keyPoints.length) {
    lines.push('', '## 重点');
    data.keyPoints.forEach(point => lines.push('- ' + String(point || '').trim()));
  }
  return lines.join('\n').trim();
}
/* ---- 单集问答：只喂文字稿，引用用行号回查 ASR 时间 ---- */
const STUDY_ASK_KEY = 'myt-study-ask';
const STUDY_ASK_MAX_MESSAGES = 16;
let studyAskStore = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(STUDY_ASK_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch (e) { return {}; }
})();
let studyAskBusy = false;

function studyCueStamp(cue) {
  return fmt(Number(cue && cue.start || 0) + Number(state.offset || 0));
}
function studyAskThread(epId) {
  if (!studyAskStore[epId] || typeof studyAskStore[epId] !== 'object') studyAskStore[epId] = { at: 0, messages: [] };
  if (!Array.isArray(studyAskStore[epId].messages)) studyAskStore[epId].messages = [];
  return studyAskStore[epId];
}
function saveStudyAsk() {
  try {
    const ids = Object.keys(studyAskStore);
    if (ids.length > 40) {
      ids.map(id => ({ id, at: Number(studyAskStore[id].at || 0) }))
        .sort((a, b) => a.at - b.at)
        .slice(0, ids.length - 40)
        .forEach(item => delete studyAskStore[item.id]);
    }
    localStorage.setItem(STUDY_ASK_KEY, JSON.stringify(studyAskStore));
  } catch (e) {}
}
/* 整集太长时按关键词挑最相关的段落，避免把几万字全塞进请求 */
function studyAskContext(question) {
  const cues = state.cues || [];
  const lineOf = (cue, index) => '#' + index + ' [' + studyCueStamp(cue) + '] ' + String(cue.text || '');
  const totalChars = cues.reduce((sum, cue) => sum + String(cue.text || '').length, 0);
  if (totalChars <= 12000 || cues.length <= 360) {
    return { full: true, count: cues.length, text: cues.map(lineOf).join('\n') };
  }
  const terms = [];
  String(question || '').toLowerCase().replace(/[^a-z0-9\u3400-\u9fff\s'-]/g, ' ').split(/\s+/)
    .filter(term => term.length > 1 && !/^(the|and|for|that|this|with|what|how|why|does|did|was|are|you|they)$/.test(term))
    .forEach(term => terms.push(term));
  (String(question || '').match(/[\u3400-\u9fff]{2,}/g) || []).forEach(word => {
    for (let i = 0; i < word.length - 1; i++) terms.push(word.slice(i, i + 2));
  });
  const size = 16;
  const parts = [];
  for (let i = 0; i < cues.length; i += size) parts.push({ from: i, to: Math.min(cues.length, i + size) });
  const scoreOf = part => {
    let score = 0;
    for (let i = part.from; i < part.to; i++) {
      const text = String(cues[i].text || '').toLowerCase();
      terms.forEach(term => { if (term && text.includes(term)) score += 1; });
    }
    return score;
  };
  const picked = parts.map(part => ({ part, score: scoreOf(part) }))
    .sort((a, b) => b.score - a.score || a.part.from - b.part.from)
    .slice(0, 8)
    .map(item => item.part)
    .sort((a, b) => a.from - b.from);
  return {
    full: false,
    count: cues.length,
    text: picked.map(part => {
      const lines = [];
      for (let i = part.from; i < part.to; i++) lines.push(lineOf(cues[i], i));
      return lines.join('\n');
    }).join('\n…\n'),
  };
}
function studyAskTimeCue(text) {
  const cues = state.cues || [];
  const match = /(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/.exec(String(text || ''));
  if (!match) return -1;
  const seconds = Number(match[1]) * 60 + Number(match[2]);
  let best = -1, bestDiff = Infinity;
  cues.forEach((cue, index) => {
    const diff = Math.abs(Number(cue.start || 0) - seconds);
    if (diff < bestDiff) { bestDiff = diff; best = index; }
  });
  return bestDiff <= 3 ? best : -1;
}
/* 只接受真实存在的行号；模型编的、越界的、重复的全部丢掉 */
function studyAskCites(raw) {
  const cues = state.cues || [];
  const out = [];
  const add = index => {
    if (Number.isInteger(index) && index >= 0 && index < cues.length && !out.includes(index)) out.push(index);
  };
  (Array.isArray(raw) ? raw : []).forEach(value => {
    if (typeof value === 'number') add(Math.round(value));
    else if (typeof value === 'string') {
      const trimmed = value.trim();
      if (/^#?\d{1,5}$/.test(trimmed)) add(Number(trimmed.replace('#', '')));
      else {
        const hit = studyAskTimeCue(trimmed);
        if (hit >= 0) add(hit);
      }
    } else if (value && typeof value === 'object') {
      add(Number(value.cue ?? value.line ?? value.index));
    }
  });
  return out.slice(0, 4);
}
function studyAskCitesFromText(text) {
  const found = [];
  String(text || '').replace(/\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?/g, (all, stamp) => {
    const index = studyAskTimeCue(stamp);
    if (index >= 0 && !found.includes(index)) found.push(index);
    return all;
  });
  return found.slice(0, 4);
}
function studyAskSuggestions() {
  const cur = studyCurrentCue();
  const items = ['这集的核心观点是什么？', '有哪些值得记下来的方法或例子？', '主持人和嘉宾在哪些地方意见不同？'];
  if (cur && cur.cue && String(cur.cue.text || '').trim()) {
    items.push('「' + String(cur.cue.text || '').trim().slice(0, 22) + '」在上下文里是什么意思？');
  }
  return items.slice(0, 4);
}
function studyAskMsgHTML(message) {
  if (!message || !message.role) return '';
  if (message.role === 'user') return '<div class="study-ask-msg user">' + esc(message.text) + '</div>';
  const chips = (Array.isArray(message.cites) ? message.cites : []).map(index => {
    const cue = (state.cues || [])[index];
    if (!cue) return '';
    return '<button class="btn ghost small" data-study-act="askCite" data-cue="' + index + '">▶ ' +
      esc(studyCueStamp(cue)) + '</button>';
  }).join('');
  return '<div class="study-ask-msg bot' + (message.error ? ' bad' : '') + '">' +
    (message.error ? '<p>' + esc(message.text) + '</p>' : studyAnnotatedLines(message.text || '')) +
    (chips ? '<div class="ask-src">' + chips + '</div>' : '') +
    '</div>';
}
function studyRenderAsk(busy) {
  const body = $('studyBody');
  if (!body) return;
  studyRenderNow();
  studyVocabContext = null; studyVocabContextMode = null;
  const epId = state.current ? state.current.id : '';
  if (!epId) { body.innerHTML = studyEmpty('先选择一集。'); return; }
  const thread = studyAskThread(epId);
  let html = '<p class="study-empty">问这一集的内容。答案只依据本集文字稿，引用按钮直接跳到原句；文字稿里没有的内容它会直说不知道。</p>';
  if (!thread.messages.length) {
    html += '<div class="study-actions">' + studyAskSuggestions().map(question =>
      '<button class="btn ghost small" data-study-act="askAsk" data-study-q="' + esc(question) + '">' +
      esc(question.length > 20 ? question.slice(0, 20) + '…' : question) + '</button>').join('') + '</div>';
  }
  html += '<div class="study-ask-log">' + thread.messages.map(studyAskMsgHTML).join('') + '</div>';
  if (busy || studyAskBusy) html += studyLoading('正在读文字稿并回答…');
  html += '<div class="study-ask-form"><textarea id="studyAskInput" rows="2" placeholder="例如：这集说的三个方法是什么？"' +
    (studyAskBusy ? ' disabled' : '') + '></textarea>' +
    '<button class="btn primary small" data-study-act="askSend"' + (studyAskBusy ? ' disabled' : '') + '>提问</button></div>';
  body.innerHTML = html;
  bindStudyActButtons();
  bindStudyAskForm();
}
function bindStudyAskForm() {
  const input = $('studyAskInput');
  if (!input) return;
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!studyAskBusy) studyAsk(input.value);
    }
  });
}
async function studyAsk(question) {
  const body = $('studyBody');
  const epId = state.current ? state.current.id : '';
  if (!epId) return;
  if (!(state.cues || []).length) { if (body) body.innerHTML = studyEmpty('这一集没有文字稿，无法问答。'); return; }
  if (!studyReady()) { if (body) body.innerHTML = studyEmpty('请先在「设置 → AI 学英语」填写 API Key 和模型。'); return; }
  const text = String(question || '').trim();
  if (!text || studyAskBusy) return;
  const thread = studyAskThread(epId);
  thread.messages.push({ role: 'user', text, at: Date.now() });
  while (thread.messages.length > STUDY_ASK_MAX_MESSAGES) thread.messages.shift();
  thread.at = Date.now();
  saveStudyAsk();
  studyAskBusy = true;
  studyRenderAsk(true);
  try {
    const context = studyAskContext(text);
    const history = thread.messages.slice(-5, -1)
      .filter(message => message && message.text)
      .map(message => ({
        role: message.role === 'user' ? 'user' : 'assistant',
        text: String(message.text || '').slice(0, 300),
      }));
    const system = 'You answer questions about one podcast episode for a Chinese-speaking learner. ' +
      'Use ONLY the transcript lines provided. Lines are prefixed "#<line number> [mm:ss]". ' +
      'Return ONLY a JSON object, no markdown fences: {"answer": string in ' + studyLangName() + ', ' +
      '"cites": array of 1-4 integer line numbers you actually relied on}. ' +
      'Every factual claim must be supported by a cited line. Never invent facts, names, numbers or timestamps. ' +
      'If the transcript does not contain the answer, say so plainly in ' + studyLangName() + ' and return "cites": []. ' +
      'Be direct and specific; at most 200 words unless the user asks for detail. Do not add a bibliography.';
    const user = JSON.stringify({
      show: state.show ? state.show.name : '',
      episode: state.current ? state.current.title : '',
      question: text,
      transcript: context.text,
      full_transcript: context.full,
      total_lines: context.count,
      previous_turns: history,
    });
    const out = await studyChat(system, user);
    const data = studyParseJson(out);
    const answer = String(data.answer || data.text || data.raw || '').trim();
    let cites = studyAskCites(data.cites);
    if (!cites.length) cites = studyAskCitesFromText(answer);
    thread.messages.push({ role: 'bot', text: answer || '模型没有返回内容。', cites, at: Date.now() });
  } catch (err) {
    thread.messages.push({ role: 'bot', text: '回答失败：' + String(err && err.message ? err.message : err), error: true, cites: [] });
  } finally {
    studyAskBusy = false;
    saveStudyAsk();
    if (studyView === 'ask') studyRenderAsk();
  }
}
/* ---- 自动章节：模型只给行号，时间由 ASR cue 决定 ---- */
function studyChapterEntry() {
  const epId = state.current ? state.current.id : '';
  const entry = epId ? studyCache['ch:' + epId] : null;
  return entry && entry.data && Array.isArray(entry.data.chapters) ? entry : null;
}
function studyChaptersHTML(data) {
  const chapters = Array.isArray(data && data.chapters) ? data.chapters : [];
  if (!chapters.length) return '';
  const rows = chapters.map((chapter, index) => {
    if (!chapter || typeof chapter !== 'object') return '';
    const ci = Number(chapter.ci);
    const cues = state.cues || [];
    const cue = Number.isInteger(ci) && ci >= 0 && ci < cues.length ? cues[ci] : null;
    const start = cue ? Number(cue.start) : Number(chapter.start);
    const title = String(chapter.title || '').trim();
    if (!title && !Number.isFinite(start)) return '';
    const when = Number.isFinite(start) ? fmt(start + (Number(state.offset) || 0)) : '';
    return '<div class="study-topic study-chapter">' +
      (Number.isFinite(start)
        ? '<button class="btn ghost small" data-study-act="topic" data-study-t="' + Math.round(start) + '">▶ ' + esc(when) + '</button>'
        : '<span class="study-chapter-no">' + (index + 1) + '</span>') +
      '<div><strong>' + studyAnnotateText(title || '未命名章节') + '</strong>' +
      (chapter.summary ? '<p>' + studyAnnotateText(chapter.summary) + '</p>' : '') + '</div></div>';
  }).join('');
  if (!rows) return '';
  return '<div class="study-section"><h4>章节</h4>' + rows + '</div>';
}
async function studyAnalyzeChapters() {
  const body = $('studyBody');
  if (!state.current) return;
  const epId = state.current.id;
  const cues = state.cues || [];
  if (!cues.length) { showToast('这一集没有文字稿，无法生成章节。', 5000); return; }
  if (!studyReady()) { showToast('请先在「设置 → AI 学英语」填写 API Key 和模型。', 6000); return; }
  const sig = [STUDY.provider, STUDY.endpoint, STUDY.model, STUDY.target, cues.length, 'chapter-v1'].join('|');
  const key = 'ch:' + epId;
  const lines = cues.map((cue, index) => '#' + index + ' [' + studyCueStamp(cue) + '] ' + String(cue.text || ''));
  const chunkCount = Math.max(1, Math.min(3, Math.ceil(lines.join('\n').length / 7000)));
  const per = Math.ceil(lines.length / chunkCount);
  const system = 'You build a chapter list for one podcast episode. ' +
    'Transcript lines are prefixed "#<line number> [mm:ss]". ' +
    'Return ONLY a JSON object, no markdown fences: {"chapters":[{"cue": integer line number, ' +
    '"title": string in ' + studyLangName() + ', "summary": string in ' + studyLangName() + '}]}. ' +
    'Each chapter must start at a natural topic boundary, never inside a sentence. ' +
    'Only use line numbers that literally appear in the given lines. Produce 2-6 chronological chapters for this chunk. ' +
    'Titles must be <= 18 characters, summaries <= 40 characters. Never invent content that is not in the transcript.';
  const merged = [];
  const seenCue = new Set();
  try {
    for (let i = 0; i < chunkCount; i++) {
      const from = i * per, to = Math.min(lines.length, from + per);
      if (from >= to) continue;
      if (body) body.innerHTML = studyLoading('正在生成章节…第 ' + (i + 1) + ' / ' + chunkCount + ' 块');
      const user = 'Chunk ' + (i + 1) + ' of ' + chunkCount + ' (lines #' + from + ' to #' + (to - 1) + '):\n' +
        lines.slice(from, to).join('\n');
      const out = await studyChat(system, user);
      const part = studyParseJson(out);
      (Array.isArray(part.chapters) ? part.chapters : []).forEach(chapter => {
        if (!chapter || typeof chapter !== 'object') return;
        const ci = Number(chapter.cue ?? chapter.line ?? chapter.index);
        if (!Number.isInteger(ci) || ci < Math.max(0, from - 2) || ci >= Math.min(cues.length, to + 2)) return;
        if (seenCue.has(ci)) return;
        const title = String(chapter.title || '').trim();
        if (!title) return;
        seenCue.add(ci);
        merged.push({ ci, title, summary: String(chapter.summary || '').trim(), start: Number(cues[ci].start) || 0 });
      });
    }
    merged.sort((a, b) => a.ci - b.ci);
    const chapters = merged.slice(0, 18);
    if (!chapters.length) throw new Error('模型没有返回可用的章节。');
    studyCache[key] = { at: Date.now(), sig, data: { version: 1, chapters } };
    saveStudyCache();
    if (studyView === 'episode') studyRenderEpisode();
    showToast('已生成 ' + chapters.length + ' 个章节。', 3000);
  } catch (err) {
    if (studyView === 'episode') studyRenderEpisode();
    showToast('章节生成失败：' + String(err && err.message ? err.message : err), 7000);
  }
}
/* ---- 金句卡片：挑句子用行号，卡片在本地画，不依赖模型出图 ---- */
function studyQuoteEntry() {
  const epId = state.current ? state.current.id : '';
  const entry = epId ? studyCache['q:' + epId] : null;
  return entry && entry.data && Array.isArray(entry.data.quotes) ? entry : null;
}
function studyQuotesHTML(data) {
  const quotes = Array.isArray(data && data.quotes) ? data.quotes : [];
  if (!quotes.length) return '';
  const cues = state.cues || [];
  const rows = quotes.map(quote => {
    if (!quote || typeof quote !== 'object') return '';
    const ci = Number(quote.ci);
    if (!Number.isInteger(ci) || ci < 0 || ci >= cues.length) return '';
    const cue = cues[ci];
    return '<div class="study-quote">' +
      '<p class="study-quote-en">' + esc(cue.text || '') + '</p>' +
      (cue.zh ? '<p class="study-quote-zh">' + esc(cue.zh) + '</p>' : '') +
      (quote.reason ? '<small>' + studyAnnotateText(quote.reason) + '</small>' : '') +
      '<div class="study-actions">' +
      '<button class="btn ghost small" data-study-act="topic" data-study-t="' + Math.round(Number(cue.start) || 0) + '">▶ ' + esc(studyCueStamp(cue)) + '</button>' +
      '<button class="btn ghost small" data-study-act="quoteCard" data-cue="' + ci + '">生成卡片</button>' +
      '</div></div>';
  }).join('');
  if (!rows) return '';
  return '<div class="study-section"><h4>金句卡片</h4>' + rows + '</div>';
}
async function studyAnalyzeQuotes() {
  const body = $('studyBody');
  if (!state.current) return;
  const epId = state.current.id;
  const cues = state.cues || [];
  if (!cues.length) { showToast('这一集没有文字稿。', 5000); return; }
  if (!studyReady()) { showToast('请先在「设置 → AI 学英语」填写 API Key 和模型。', 6000); return; }
  const sig = [STUDY.provider, STUDY.endpoint, STUDY.model, STUDY.target, cues.length, 'quote-v1'].join('|');
  const key = 'q:' + epId;
  const lines = cues.map((cue, index) => '#' + index + ' [' + studyCueStamp(cue) + '] ' + String(cue.text || ''));
  const chunkCount = Math.max(1, Math.min(3, Math.ceil(lines.join('\n').length / 7000)));
  const per = Math.ceil(lines.length / chunkCount);
  const system = 'You pick memorable quotes from one podcast episode for study cards. ' +
    'Transcript lines are prefixed "#<line number> [mm:ss]". ' +
    'Return ONLY a JSON object, no markdown fences: {"quotes":[{"cue": integer line number, ' +
    '"reason": string in ' + studyLangName() + '}]}. ' +
    'Pick 2-3 lines per chunk that are self-contained, insightful, vivid or useful. ' +
    'Only use line numbers that literally appear in the given lines. Reason must be <= 24 characters. ' +
    'Never invent content that is not in the transcript.';
  const merged = [];
  const seenCue = new Set();
  try {
    for (let i = 0; i < chunkCount; i++) {
      const from = i * per, to = Math.min(lines.length, from + per);
      if (from >= to) continue;
      if (body) body.innerHTML = studyLoading('正在挑金句…第 ' + (i + 1) + ' / ' + chunkCount + ' 块');
      const user = 'Chunk ' + (i + 1) + ' of ' + chunkCount + ' (lines #' + from + ' to #' + (to - 1) + '):\n' +
        lines.slice(from, to).join('\n');
      const out = await studyChat(system, user);
      const part = studyParseJson(out);
      (Array.isArray(part.quotes) ? part.quotes : []).forEach(quote => {
        if (!quote || typeof quote !== 'object') return;
        const ci = Number(quote.cue ?? quote.line ?? quote.index);
        if (!Number.isInteger(ci) || ci < Math.max(0, from - 2) || ci >= Math.min(cues.length, to + 2)) return;
        if (seenCue.has(ci)) return;
        seenCue.add(ci);
        merged.push({ ci, reason: String(quote.reason || '').trim() });
      });
    }
    merged.sort((a, b) => a.ci - b.ci);
    const quotes = merged.slice(0, 8);
    if (!quotes.length) throw new Error('模型没有返回可用的金句。');
    studyCache[key] = { at: Date.now(), sig, data: { version: 1, quotes } };
    saveStudyCache();
    if (studyView === 'episode') studyRenderEpisode();
    showToast('已挑出 ' + quotes.length + ' 句金句。', 3000);
  } catch (err) {
    if (studyView === 'episode') studyRenderEpisode();
    showToast('金句生成失败：' + String(err && err.message ? err.message : err), 7000);
  }
}
function studyWrapCanvasText(ctx, text, max, maxLines) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const byWord = /\s/.test(raw);
  const units = byWord ? raw.split(/\s+/) : Array.from(raw);
  const lines = [];
  let line = '';
  units.forEach(unit => {
    if (!line && ctx.measureText(unit).width > max) {
      Array.from(unit).forEach(ch => {
        const trial = line ? line + ch : ch;
        if (line && ctx.measureText(trial).width > max) { lines.push(line); line = ch; }
        else line = trial;
      });
      return;
    }
    const trial = line ? line + (byWord ? ' ' : '') + unit : unit;
    if (line && ctx.measureText(trial).width > max) { lines.push(line); line = unit; }
    else line = trial;
  });
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/.$/, '') + '…';
    return kept;
  }
  return lines;
}
let studyQuoteUrl = '';
let studyQuoteEsc = null;
function studyCloseQuoteCard() {
  const wrap = $('quoteCardWrap');
  if (wrap) wrap.remove();
  if (studyQuoteEsc) { document.removeEventListener('keydown', studyQuoteEsc); studyQuoteEsc = null; }
  if (studyQuoteUrl) {
    try { URL.revokeObjectURL(studyQuoteUrl); } catch (e) {}
    studyQuoteUrl = '';
  }
}
function studyOpenQuoteCard(rawCue) {
  if (!studyPluginOn()) return;
  const ci = Number(rawCue);
  const cue = (state.cues || [])[ci];
  if (!cue) { showToast('这一句不在当前文字稿里。', 4000); return; }
  const W = 1080, H = 1350;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) { showToast('卡片生成失败。', 4000); return; }
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#15181f');
  bg.addColorStop(0.55, '#0e1116');
  bg.addColorStop(1, '#1a2431');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(233,196,106,.10)';
  ctx.beginPath(); ctx.arc(920, 170, 250, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#e9c46a'; ctx.fillRect(76, 118, 12, 104);
  ctx.fillStyle = '#8b98a9';
  ctx.font = '600 24px "Noto Sans SC","Microsoft YaHei",system-ui,sans-serif';
  ctx.fillText('MYTRANSCRIPT · 金句卡片', 108, 154);
  let y = 372;
  ctx.fillStyle = '#f6f3ea';
  ctx.font = '600 58px "Noto Serif SC","Songti SC","Noto Sans SC",serif';
  studyWrapCanvasText(ctx, cue.text, 900, 7).forEach(line => { ctx.fillText(line, 84, y); y += 82; });
  y += 34;
  if (cue.zh) {
    ctx.fillStyle = '#a8b5c6';
    ctx.font = '400 36px "Noto Sans SC","Microsoft YaHei",system-ui,sans-serif';
    studyWrapCanvasText(ctx, cue.zh, 900, 4).forEach(line => { ctx.fillText(line, 84, y); y += 56; });
  }
  ctx.fillStyle = '#e9c46a'; ctx.fillRect(84, H - 250, 900, 2);
  ctx.font = '600 30px "Noto Sans SC",system-ui,sans-serif';
  ctx.fillText(studyCueStamp(cue), 84, H - 190);
  ctx.fillStyle = '#d6dbe4';
  ctx.font = '400 28px "Noto Sans SC","Microsoft YaHei",system-ui,sans-serif';
  let ty = H - 140;
  studyWrapCanvasText(ctx, state.current ? state.current.title : '', 900, 2)
    .forEach(line => { ctx.fillText(line, 84, ty); ty += 38; });
  ctx.fillStyle = '#7d8b9d';
  ctx.font = '400 24px "Noto Sans SC",system-ui,sans-serif';
  ctx.fillText((state.show ? state.show.name : 'MyTranscript').slice(0, 34), 84, H - 62);
  canvas.toBlob(blob => {
    if (!blob) { showToast('卡片生成失败。', 4000); return; }
    studyCloseQuoteCard();
    studyQuoteUrl = URL.createObjectURL(blob);
    const wrap = document.createElement('div');
    wrap.className = 'quote-card-wrap';
    wrap.id = 'quoteCardWrap';
    wrap.innerHTML = '<div class="quote-card" role="dialog" aria-label="金句卡片">' +
      '<header><span>分享</span><b>' + esc(studyCueStamp(cue)) + ' · ' + esc((state.show ? state.show.name : '') || '') + '</b>' +
      '<button type="button" data-quote-close aria-label="关闭">✕</button></header>' +
      '<img src="' + studyQuoteUrl + '" alt="金句卡片预览">' +
      '<div class="study-actions">' +
      '<button class="btn primary small" data-quote-download>下载 PNG</button>' +
      '<button class="btn ghost small" data-quote-copy>复制文字</button>' +
      '</div></div>';
    document.body.append(wrap);
    wrap.addEventListener('click', event => { if (event.target === wrap) studyCloseQuoteCard(); });
    wrap.querySelector('[data-quote-close]').onclick = studyCloseQuoteCard;
    wrap.querySelector('[data-quote-download]').onclick = () => {
      if (!studyQuoteUrl) return;
      const link = document.createElement('a');
      link.href = studyQuoteUrl;
      link.download = 'myt-quote-' + Math.round(Number(cue.start) || 0) + '.png';
      document.body.append(link);
      link.click();
      link.remove();
      showToast('金句卡片已保存。', 3000);
    };
    wrap.querySelector('[data-quote-copy]').onclick = async () => {
      const text = [cue.text, cue.zh, '— ' + [(state.show ? state.show.name : ''), (state.current ? state.current.title : ''), studyCueStamp(cue)].filter(Boolean).join(' · ')]
        .filter(Boolean).join('\n');
      if (await copyPlain(text)) showToast('已复制卡片文字。', 3000);
      else showToast('复制失败，请手动选择文本。', 4000);
    };
    studyQuoteEsc = event => { if (event.key === 'Escape') studyCloseQuoteCard(); };
    document.addEventListener('keydown', studyQuoteEsc);
  }, 'image/png');
}
async function studyCopyEpisode() {
  const key = state.current ? 'ep:' + state.current.id : '';
  const data = key ? studyCache[key]?.data : null;
  if (!data) { showToast('还没有整集总结。', 3000); return; }
  const text = studyEpisodeText(data);
  if (!text) { showToast('总结为空。', 3000); return; }
  if (await copyPlain(text)) showToast('已复制整集总结。', 3000);
  else showToast('复制失败，请手动选择文本。', 4000);
}
function studyOpenEpisodeSummary(key, epId) {
  if (!studyPluginOn()) { showToast('学英语插件未启用。', 'warn'); return; }
  const show = showByKey(key);
  const ep = show ? episodesOf(show).find(item => item.id === epId) : null;
  if (!show || !ep) { showToast('找不到这一集。', 5000); return; }
  if (!moduleOn('study')) { showToast('AI 学英语模块已关闭。', 5000); return; }
  if (!ep.transcript?.url) { showToast('这一集没有文字稿，无法总结。', 5000); return; }
  if (!studyReady()) {
    showToast('请先在「设置 → AI 学英语」填写 API Key 和模型。', 8000);
    navigate('settings');
    return;
  }
  pendingStudyEpisode = epId;
  app.autoplay = false;
  navigate('player', [key, epId]);
  waitStudyEpisodeSummary(epId, 0);
}
function waitStudyEpisodeSummary(epId, tries) {
  if (pendingStudyEpisode !== epId) return;
  if (state.current?.id === epId && (state.cues || []).length) {
    pendingStudyEpisode = '';
    openStudySheet('episode');
    if (studyCache['ep:' + epId]?.data?.version !== 3) studyAnalyzeEpisode();
    return;
  }
  if (tries < 80) { setTimeout(() => waitStudyEpisodeSummary(epId, tries + 1), 250); return; }
  pendingStudyEpisode = '';
  showToast('文字稿还没准备好，请打开播放页后再试。', 6000);
}
function bindStudyActButtons() {
  document.querySelectorAll('[data-study-act]').forEach(btn => {
    btn.onclick = () => {
      const act = btn.dataset.studyAct;
      if (act === 'current') studyAnalyzeCurrent();
      else if (act === 'episode') studyAnalyzeEpisode();
      else if (act === 'episodeFresh') studyRestartEpisodeSummary();
      else if (act === 'copyEpisode') studyCopyEpisode();
      else if (act === 'ad' || act === 'topic') {
        const t = Number(btn.dataset.studyT);
        if (Number.isFinite(t) && t >= 0) seekTo(t);
      }
      else if (act === 'playCue') { const cur = studyCurrentCue(); if (cur) studyPlayCue(cur.cue, 1); }
      else if (act === 'loopCue') { const cur = studyCurrentCue(); if (cur) studyPlayCue(cur.cue, 3); }
      else if (act === 'autoPause') { studyAutoPause = !studyAutoPause; studyAutoPauseDone = -1; studyRenderCurrent(); }
      else if (act === 'hideZh') { studyHideZh = !studyHideZh; studyRenderCurrent(); }
      else if (act === 'playReview') {
        const due = studyDueItems();
        if (due[0]) studyPlayItem(due[0]);
      } else if (act === 'reveal') {
        studyReviewRevealed = true;
        studyRenderReview();
      } else if (act === 'playEx') {
        if (studyExercise) studyPlayCue(studyExercise.cue, 1);
      } else if (act === 'nextEx') {
        const cur = studyCurrentCue();
        if (cur && state.cues[cur.ci + 1]) {
          studyExercise = null;
          seekTo(state.cues[cur.ci + 1].start + state.offset);
          setTimeout(() => studyRenderPractice(), 80);
        }
      } else if (act === 'checkEx') studyCheckExercise(false);
      else if (act === 'showEx') studyCheckExercise(true);
      else if (act === 'backEx') { if (studyExercise) studyExercise.checked = false; studyRenderPractice(); }
      else if (act === 'chapters') studyAnalyzeChapters();
      else if (act === 'quotes') studyAnalyzeQuotes();
      else if (act === 'quoteCard') studyOpenQuoteCard(btn.dataset.cue);
      else if (act === 'askSend') {
        const input = $('studyAskInput');
        if (input) studyAsk(input.value);
      } else if (act === 'askAsk') studyAsk(btn.dataset.studyQ || '');
      else if (act === 'askCite') {
        const cue = (state.cues || [])[Number(btn.dataset.cue)];
        if (cue) seekTo(Number(cue.start) || 0);
      }
    };
  });
  document.querySelectorAll('[data-study-grade]').forEach(btn => {
    btn.onclick = () => {
      const due = studyDueItems();
      const v = due[0];
      if (!v) return;
      studySrsGrade(v, Number(btn.dataset.studyGrade));
      studyReviewRevealed = false;
      saveStudyVocab();
      studyUpdateDueBadge();
      studyRenderReview();
    };
  });
  document.querySelectorAll('[data-study-ex]').forEach(btn => {
    btn.onclick = () => { studyStartExercise(btn.dataset.studyEx); studyRenderPractice(); };
  });
  bindStudyVocabButtons();
}
async function studyTestConnection() {
  const status = $('studyStatus');
  if (status) { status.textContent = '测试中…'; status.style.color = ''; }
  try {
    const out = await studyChat('You are a connection tester. Reply with exactly OK.', 'OK?');
    if (status) { status.textContent = '连接正常：' + String(out || '').trim().slice(0, 40); status.style.color = '#6fbf8f'; }
  } catch (err) {
    if (status) { status.textContent = String(err.message || err); status.style.color = '#c96363'; }
  }
}
function studyModelStatus(text, color) {
  const status = $('studyModelStatus');
  if (!status) return;
  status.textContent = text || '';
  status.style.color = color || '';
}
function studyClearModels() {
  const picker = $('studyModelPicker');
  const list = $('studyModelList');
  const count = $('studyModelCount');
  const search = $('studyModelSearch');
  if (list) list.innerHTML = '';
  if (count) count.textContent = '';
  if (search) search.value = '';
  if (picker) picker.hidden = true;
}
function studyFilterModels() {
  const list = $('studyModelList');
  const count = $('studyModelCount');
  if (!list || !count) return;
  const q = String(($('studyModelSearch') && $('studyModelSearch').value) || '').trim().toLowerCase();
  const items = [...list.querySelectorAll('.study-model-item')];
  let visible = 0;
  items.forEach(btn => {
    const hit = !q || btn.textContent.toLowerCase().includes(q);
    btn.hidden = !hit;
    if (hit) visible++;
  });
  count.textContent = q
    ? '显示 ' + visible + ' / ' + items.length + ' 个'
    : '共 ' + items.length + ' 个，可滚动查看全部';
}
function studyOpenModels() {
  const picker = $('studyModelPicker');
  if (!picker) return;
  picker.hidden = false;
  studyFilterModels();
}
function studyRenderModelList(models) {
  const list = $('studyModelList');
  if (!list) return;
  list.innerHTML = models.map(item => {
    const id = String(item.id);
    const name = String(item.name || id);
    const selected = id === String(STUDY.model || '');
    return '<button type="button" class="study-model-item" role="option" data-model="' + esc(id) + '" aria-selected="' + (selected ? 'true' : 'false') + '">' +
      '<span>' + esc(name) + '</span>' + (name === id ? '' : '<span class="id">' + esc(id) + '</span>') + '</button>';
  }).join('');
  if (!models.length) {
    list.innerHTML = '<div class="study-model-empty">没有可用模型，可直接手动填写模型名。</div>';
  }
  studyOpenModels();
}
function studyPickModel(id) {
  STUDY.model = id;
  saveStudy();
  syncStudySettings();
  const picker = $('studyModelPicker');
  if (picker) picker.hidden = true;
  studyModelStatus('已选择：' + id, '#6fbf8f');
}
async function studyFetchModels() {
  if (!studyNative()) { studyModelStatus('桌面版才能获取模型列表', '#c96363'); return; }
  if (!String(STUDY.key || '').trim()) { studyModelStatus('先填写 API Key，再获取模型列表', '#c96363'); return; }
  if (STUDY.provider === 'custom' && !String(STUDY.endpoint || '').trim()) {
    studyModelStatus('先填写自定义接口地址', '#c96363'); return;
  }
  studyModelStatus('正在获取模型列表…');
  try {
    const host = tauriHost();
    const list = await host.core.invoke('llm_models', { config: studyConfig() });
    const models = (Array.isArray(list) ? list : []).filter(item => item && String(item.id || '').trim());
    if (!models.length) { studyModelStatus('厂商没有返回可用模型，可手动填写模型名', '#c96363'); return; }
    if (!String(STUDY.model || '').trim()) {
      STUDY.model = models[0].id;
      saveStudy();
      syncStudySettings();
    }
    studyRenderModelList(models.map(item => ({ id: String(item.id), name: String(item.name || item.id) })));
    studyModelStatus('已获取 ' + models.length + ' 个模型，请在下方列表中选择', '#6fbf8f');
  } catch (err) {
    studyModelStatus(String(err.message || err), '#c96363');
  }
}
function bindStudyUI() {
  $('studyBtn').onclick = e => { e.stopPropagation(); openStudySheet(); };
  $('studyClose').onclick = closeStudySheet;
  document.querySelectorAll('[data-study-view]').forEach(btn => {
    btn.onclick = () => setStudyView(btn.dataset.studyView);
  });
  // 页签按 ARIA tabs 的惯例支持左右方向键与 Home/End，省得一个个 Tab 过去。
  const studyTabBar = $('studySheet')?.querySelector('.study-tabs');
  if (studyTabBar) {
    studyTabBar.addEventListener('keydown', ev => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return;
      const btns = [...studyTabBar.querySelectorAll('[data-study-view]')];
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      ev.preventDefault();
      const n = ev.key === 'ArrowLeft' ? (i + btns.length - 1) % btns.length
        : ev.key === 'ArrowRight' ? (i + 1) % btns.length
        : ev.key === 'Home' ? 0 : btns.length - 1;
      btns[n].focus({ preventScroll: true });
      setStudyView(btns[n].dataset.studyView);
    });
  }
  const provider = $('studyProvider');
  if (provider) provider.addEventListener('change', () => applyStudyProvider(provider.value, true));
  const fields = [['studyEndpoint', 'endpoint'], ['studyKey', 'key'], ['studyModel', 'model'], ['studyTarget', 'target']];
  fields.forEach(([id, key]) => {
    const el = $(id); if (!el) return;
    el.addEventListener('change', () => {
      STUDY[key] = el.value;
      if (key === 'endpoint') {
        studyClearModels();
        const modelStatus = $('studyModelStatus'); if (modelStatus) { modelStatus.textContent = ''; modelStatus.style.color = ''; }
      }
      saveStudy();
      syncStudySettings();
    });
  });
  const modelSearch = $('studyModelSearch');
  if (modelSearch) modelSearch.addEventListener('input', studyFilterModels);
  const modelClose = $('studyModelClose');
  if (modelClose) modelClose.onclick = () => { const picker = $('studyModelPicker'); if (picker) picker.hidden = true; };
  const modelList = $('studyModelList');
  if (modelList) modelList.addEventListener('click', e => {
    const btn = e.target.closest('.study-model-item');
    if (btn) studyPickModel(btn.dataset.model || '');
  });
  const modelInput = $('studyModel');
  if (modelInput) modelInput.addEventListener('focus', () => {
    const list = $('studyModelList');
    if (list && list.querySelectorAll('.study-model-item').length) studyOpenModels();
  });
  $('studyModelFetch').onclick = studyFetchModels;
  $('studyTestBtn').onclick = studyTestConnection;
  $('studyClearCache').onclick = () => {
    studyCache = {}; saveStudyCache();
    showToast('已清空 AI 学习缓存。', 3000);
    if ($('studySheet').classList.contains('on')) setStudyView(studyView);
  };
  $('studySheet').addEventListener('click', e => e.stopPropagation());
  if (!window.__studyAudioBound) {
    window.__studyAudioBound = true;
    audio.addEventListener('timeupdate', studyAudioTick);
    audio.addEventListener('play', () => {
      if (studyAutoPauseDone === state.activeCue) studyAutoPauseDone = -2;
    });
    audio.addEventListener('ended', () => { studyLoop = null; });
  }
  studyUpdateDueBadge();
  bindStudyActButtons();
  bindStudyTermTips();
}
function bindTranslateUI() {
  const on = $('trOn');
  if (on) on.onclick = () => {
    TR.on = !TR.on;
    trSave();
    // 开自动翻译时如果正文只显示英文，顺手切到双语，否则译完也看不见。
    if (TR.on && reader.lang === 'en') { reader.lang = 'both'; applyReader(); rebuildCues(); }
    syncTranslateSettings();
    trStatus(TR.on ? (trReady() ? '已开启，播放时自动翻译' : '还缺 API Key') : '未开启', TR.on && !trReady());
    if (TR.on && state.cues.length && state.activeCue >= 0) trPrimeCues(state.activeCue);
  };
  const engine = $('trEngine');
  if (engine) engine.onchange = () => { TR.engine = engine.value; trSave(); syncTranslateSettings(); };
  const target = $('trTarget');
  if (target) target.onchange = () => { TR.target = target.value; TR_CACHE.clear(); trSave(); };
  [['trEndpoint', 'endpoint'], ['trKey', 'key'], ['trRegion', 'region'], ['trModel', 'model']].forEach(([id, field]) => {
    const el = $(id);
    if (el) el.oninput = () => { TR[field] = el.value; trSave(); };
    if (el) el.onchange = () => syncTranslateSettings();
  });
  const test = $('trTest');
  if (test) test.onclick = async () => {
    if (!trNative()) { trStatus('自动翻译需要在桌面版使用', true); return; }
    test.disabled = true;
    trStatus('测试中…', false);
    try {
      const [out] = await trBatch(['Hello, this is a translation test.']);
      trStatus('译文：' + (out || ''), false);
    } catch (err) {
      trNoteError(err);
    } finally {
      test.disabled = false;
    }
  };
}
function syncThemeSwatches() {
  const current = document.documentElement.dataset.theme;
  themeBtns().forEach(button => button.setAttribute('aria-checked', String(button.dataset.theme === current)));
}
function renderSidebarSettings() {
  const hidden = new Set(prefs.sidebar?.hidden || []);
  const row = (route, group, index, total) => {
    const [icon, label] = SIDEBAR_META[route] || ['•', route];
    const checked = !hidden.has(route);
    return '<div class="setting-row sidebar-custom-row">' +
      '<div><strong><span class="sidebar-custom-ico">' + icon + '</span>' + esc(label) + '</strong>' +
      '<p>' + (checked ? '显示在侧边栏' : '已从侧边栏隐藏') + '</p></div>' +
      '<div class="sidebar-custom-actions">' +
      '<button class="btn ghost small" data-sidebar-move="up" data-sidebar-group="' + group + '" data-sidebar-route="' + route + '" aria-label="上移' + esc(label) + '"' + (index === 0 ? ' disabled' : '') + '>↑</button>' +
      '<button class="btn ghost small" data-sidebar-move="down" data-sidebar-group="' + group + '" data-sidebar-route="' + route + '" aria-label="下移' + esc(label) + '"' + (index === total - 1 ? ' disabled' : '') + '>↓</button>' +
      '<button class="switch" data-sidebar-toggle="' + route + '" role="switch" aria-checked="' + String(checked) + '"></button>' +
      '</div></div>';
  };
  const top = $('sidebarTopList');
  if (top) top.innerHTML = sidebarOrder('top').map((route, i, list) => row(route, 'top', i, list.length)).join('');
  const bottom = $('sidebarBottomList');
  if (bottom) bottom.innerHTML = sidebarOrder('bottom').map((route, i, list) => row(route, 'bottom', i, list.length)).join('');
  document.querySelectorAll('[data-sidebar-move]').forEach(btn => {
    btn.onclick = () => moveSidebarRoute(btn.dataset.sidebarRoute, btn.dataset.sidebarGroup, btn.dataset.sidebarMove === 'up' ? -1 : 1);
  });
  document.querySelectorAll('[data-sidebar-toggle]').forEach(btn => {
    btn.onclick = () => toggleSidebarRoute(btn.dataset.sidebarToggle);
  });
}
function moveSidebarRoute(route, group, delta) {
  if (!prefs.sidebar || !prefs.sidebar.order[group]) return;
  const order = [...prefs.sidebar.order[group]];
  const index = order.indexOf(route);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= order.length) return;
  [order[index], order[target]] = [order[target], order[index]];
  prefs.sidebar.order[group] = order;
  savePrefs();
  applySidebarCustomization();
  renderSidebarSettings();
}
function toggleSidebarRoute(route) {
  if (!prefs.sidebar) prefs.sidebar = normalizeSidebarPrefs(null);
  const hidden = new Set(prefs.sidebar.hidden);
  if (hidden.has(route)) hidden.delete(route); else hidden.add(route);
  prefs.sidebar.hidden = [...hidden];
  savePrefs();
  applySidebarCustomization();
  renderSidebarSettings();
}
function resetSidebarSettings() {
  prefs.sidebar = normalizeSidebarPrefs(null);
  savePrefs();
  applySidebarCustomization();
  renderSidebarSettings();
  showToast('侧边栏已恢复默认。');
}
function openSettingsPane(pane) {
  if (!subtitlePluginOn() && ['reader', 'study', 'models'].includes(pane)) pane = 'plugins';
  if (!studyPluginOn() && pane === 'study') pane = 'plugins';
  document.querySelectorAll('#settingsMenu button').forEach(button => button.classList.toggle('active', button.dataset.pane === pane));
  document.querySelectorAll('.settings-pane').forEach(el => el.classList.toggle('active', el.id === 'pane-' + pane));
  if (pane === 'sidebar') renderSidebarSettings();
  if (pane === 'models') { refreshAsrModels(); renderLocalAsrModelHint(); }
}

/* layer: view —— 播放器集成
   本片只做该层的事，跨层调用走 kernel / host() / setState。 */
/* ---------- player integration ---------- */
function setNavCollapsed(collapsed, persist = true) {
  document.body.classList.toggle('nav-collapsed', !!collapsed);
  const btn = $('sidebarToggle');
  if (btn) {
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.title = collapsed ? '展开侧栏' : '收起侧栏';
  }
  if (persist) try { localStorage.setItem('myt-nav-collapsed', collapsed ? '1' : '0'); } catch (e) {}
}

function syncRailButtons() {
  const pairs = [['series', 'seriesRailBtn'], ['notes', 'notesRailBtn']];
  pairs.forEach(([name, id]) => {
    const btn = $(id);
    const open = document.body.classList.contains('reader-' + name + '-open');
    if (!btn) return;
    btn.classList.toggle('on', open);
    btn.setAttribute('aria-expanded', String(open));
    btn.title = (open ? '收起' : '展开') + (name === 'series' ? '剧集栏' : '笔记栏');
  });
}

function setRailOpen(name, open, persist = true) {
  document.body.classList.toggle('reader-' + name + '-open', !!open);
  if (persist) try { localStorage.setItem('myt-rail-' + name, open ? '1' : '0'); } catch (e) {}
  syncRailButtons();
  if (open) renderReaderRails();
}

function railCoverHTML(ep, show) {
  const art = ep?.img || show?.artwork || '';
  const img = art ? '<img src="' + esc(smallArtwork(art) || art) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">' : '';
  return '<div class="rail-art" style="' + coverGrad(show?.key || show?.slug || ep?.title || 'podcast') + '"><span>' +
    esc(initialsOf(show?.name || show?.slug || 'Podcast')) + '</span>' + img + '</div>';
}

function renderReaderRails() {
  const seriesTitle = $('seriesRailTitle');
  const seriesBody = $('seriesRailBody');
  const notesBody = $('notesRailBody');
  if (!seriesBody || !notesBody) return;
  if (!state.show) {
    if (seriesTitle) seriesTitle.textContent = '当前节目';
    seriesBody.innerHTML = '<div class="rail-empty">还没有打开单集。</div>';
    notesBody.innerHTML = '<div class="rail-empty">打开一集后，这里会显示封面、笔记和快捷阅读操作。</div>';
    return;
  }
  if (seriesTitle) seriesTitle.textContent = state.show.name || state.show.slug;
  let eps = state.episodes || [];
  if (eps.length > 60) {
    const at = eps.findIndex(ep => ep.id === state.current?.id);
    eps = at >= 60 ? [eps[at], ...eps.slice(0, 59)] : eps.slice(0, 60);
  }
  seriesBody.innerHTML = eps.map((ep, index) => {
    const on = ep.id === state.current?.id ? ' on' : '';
    const num = ep.num ? '#' + ep.num : String(index + 1).padStart(2, '0');
    return '<button class="rail-ep' + on + '" type="button" data-rail-ep="' + esc(ep.id) + '"><i>' +
      esc(num) + '</i><span>' + esc(ep.title || '(无标题)') + '</span></button>';
  }).join('') || '<div class="rail-empty">这档节目还没有可显示的剧集。</div>';

  if (!state.current) {
    notesBody.innerHTML = '<div class="rail-empty">从左侧剧集栏选一集开始。</div>';
    return;
  }
  const key = state.show.slug;
  const cNotes = (app.notes || []).filter(note => note.key === key).slice(0, 5);
  const notesHTML = cNotes.length ? cNotes.map(note =>
    '<div class="rail-note" data-rail-note="' + Number(note.t || 0) + '"><strong>' + esc(note.title || '笔记') +
    '</strong><span>' + esc(String(note.body || '').slice(0, 120)) +
    (note.t ? ' · ' + fmt(Number(note.t)) : '') + '</span></div>'
  ).join('') : '<div class="rail-empty">还没有这集的笔记。点上面的“记笔记”或在下方正文里选中一句。</div>';
  notesBody.innerHTML =
    '<div class="rail-current">' + railCoverHTML(state.current, state.show) +
      '<div><strong>' + esc(state.current.title || '(无标题)') + '</strong><span>' + esc(state.show.name || '') +
      (state.current.date ? ' · ' + esc(formatDate(state.current.date)) : '') + '</span></div></div>' +
    '<div class="rail-actions">' +
      '<button class="rail-action" type="button" data-rail-action="study">✎ 学英语</button>' +
      '<button class="rail-action" type="button" data-rail-action="bookmark">☆ 收藏当前句</button>' +
      '<button class="rail-action" type="button" data-rail-action="chapter">☰ 章节</button>' +
      '<button class="rail-action" type="button" data-rail-action="info">ⓘ 单集信息</button>' +
    '</div>' +
    '<div class="rail-label"><span>本集笔记</span><span>' + cNotes.length + '</span></div>' + notesHTML;
}

function bindLedgerUI() {
  if (app.ledgerBound) return;
  app.ledgerBound = true;
  try { setNavCollapsed(localStorage.getItem('myt-nav-collapsed') === '1', false); } catch (e) { setNavCollapsed(false, false); }
  const wide = window.innerWidth >= 1200;
  ['series', 'notes'].forEach(name => {
    let saved = null;
    try { saved = localStorage.getItem('myt-rail-' + name); } catch (e) {}
    setRailOpen(name, saved === null ? wide : saved === '1', false);
  });
  const navBtn = $('sidebarToggle');
  if (navBtn) navBtn.onclick = () => setNavCollapsed(!document.body.classList.contains('nav-collapsed'));
  const seriesBtn = $('seriesRailBtn');
  if (seriesBtn) seriesBtn.onclick = () => setRailOpen('series', !document.body.classList.contains('reader-series-open'));
  const notesBtn = $('notesRailBtn');
  if (notesBtn) notesBtn.onclick = () => setRailOpen('notes', !document.body.classList.contains('reader-notes-open'));
  const seriesClose = $('seriesRailClose');
  if (seriesClose) seriesClose.onclick = () => setRailOpen('series', false);
  const notesClose = $('notesRailClose');
  if (notesClose) notesClose.onclick = () => setRailOpen('notes', false);
  document.addEventListener('click', event => {
    const epBtn = event.target.closest('[data-rail-ep]');
    if (epBtn) {
      const ep = (state.episodes || []).find(item => item.id === epBtn.dataset.railEp);
      if (ep) selectEpisode(ep);
      return;
    }
    const action = event.target.closest('[data-rail-action]');
    if (action) {
      const ids = { study: 'studyBtn', bookmark: 'readerBookmarkBtn', chapter: 'chapterBtn', info: 'readerInfoBtn' };
      const target = $(ids[action.dataset.railAction]);
      if (target) target.click();
      return;
    }
    const note = event.target.closest('[data-rail-note]');
    if (note) {
      const t = Number(note.dataset.railNote);
      if (t > 0 && state.current) seekTo(t);
    }
  });
  renderReaderRails();
}
function syncReaderTop() {
  const pill = $('readerShowPill');
  if (pill) pill.textContent = state.show ? 'NOW PLAYING · ' + String(state.show.name || '').toUpperCase() : 'NOW PLAYING';
  const back = $('readerBack');
  if (back) back.title = '返回' + (PAGE_NAMES[app.lastPage] || '首页');
  renderReaderRails();
  syncRailButtons();
  if (state.wallpaper) { wpLastKey = ''; wallpaperRefresh(); }
}
function syncBookmarkBtn() {
  const button = $('readerBookmarkBtn');
  if (!button) return;
  if (!state.current || !state.show) { button.classList.remove('on'); return; }
  const cue = state.cues[state.activeCue];
  const time = cue ? Math.round(cue.start + state.offset) : Math.round(audio.currentTime || 0);
  const on = app.bookmarks.some(item => item.key === state.show.slug && item.ep === state.current.id && Math.abs(Number(item.t) - time) <= 2);
  button.classList.toggle('on', on);
}
function toggleBookmarkCue() {
  if (!state.current || !state.show) { showToast('先播放一集。'); return; }
  const cue = state.cues[state.activeCue] || state.cues[0];
  if (!cue) { showToast('当前没有可收藏的句子。'); return; }
  const time = Math.round(cue.start + state.offset);
  const id = state.show.slug + '|' + state.current.id + '|' + time;
  const index = app.bookmarks.findIndex(item => item.id === id);
  if (index >= 0) {
    app.bookmarks.splice(index, 1);
    writeJSON(BOOKMARK_KEY, app.bookmarks);
    showToast('已移除书签。');
  } else {
    app.bookmarks.unshift({
      id, key: state.show.slug, ep: state.current.id, show: state.show.name || '',
      title: state.current.title || '', t: time, en: cue.text || '', zh: cue.zh || '', at: Date.now(),
    });
    writeJSON(BOOKMARK_KEY, app.bookmarks);
    showToast('已收藏当前句。');
  }
  syncBookmarkBtn();
}
function currentPlaylist() {
  return state.episodes.length ? state.episodes : (state.show ? episodesOf(state.show) : []);
}
function stepTarget(list, currentId, delta) {
  const index = list.findIndex(item => item.id === currentId);
  return index >= 0 ? list[index + delta] || null : null;
}
function nextTarget(list, currentId, showKey) {
  if (prefs.queueOrder === 'shuffle' && list.length > 1) {
    const rest = list.filter(item => item.id !== currentId);
    return rest[Math.floor(Math.random() * rest.length)] || null;
  }
  if (prefs.queueOrder === 'unplayed') {
    const index = list.findIndex(item => item.id === currentId);
    const after = list.slice(index + 1).filter(item => !isPlayed(showKey, item.id));
    if (after.length) return after[0];
  }
  return stepTarget(list, currentId, 1);
}
function stepEpisode(delta) {
  if (!state.current) return;
  const target = delta > 0 ? nextTarget(currentPlaylist(), state.current.id, state.show?.slug) : stepTarget(currentPlaylist(), state.current.id, delta);
  if (!target) { showToast(delta > 0 ? '这档节目没有下一集了。' : '这档节目没有上一集了。'); return; }
  const wasPlaying = !audio.paused;
  selectEpisode(target, true);
  if (wasPlaying) audio.play().catch(() => {});
  syncMini();
}
let miniCaptionKey = '', miniCaptionIdx = -1;
const MINI_CAPTION_KEY = 'myt-mini-caption';
let miniCaptionPref = null;
function miniCaptionExpanded() {
  if (miniCaptionPref === null) {
    try { miniCaptionPref = localStorage.getItem(MINI_CAPTION_KEY) !== '0'; } catch (e) { miniCaptionPref = true; }
  }
  return miniCaptionPref;
}
function toggleMiniCaption() {
  const open = !miniCaptionExpanded();
  miniCaptionPref = open;
  try { localStorage.setItem(MINI_CAPTION_KEY, open ? '1' : '0'); } catch (e) {}
  syncMiniCaption();
}
function miniCaptionMarkup(cue, wi) {
  if (state.mode === 'word' && cue.hasWords) {
    const { label, words, mismatch } = splitLabel(cue.text, cue.words);
    if (!mismatch) {
      return (label ? '<span class="label">' + esc(label) + ' </span>' : '') +
        words.map((w, i) => '<span' + (i === wi ? ' class="hot"' : '') + '>' + esc(w.t) + '</span>').join(' ');
    }
  }
  return esc(cue.text);
}
function syncMiniCaption() {
  const el = $('miniCaption'), out = $('miniCaptionText');
  if (!el || !out) return;
  if (!subtitlePluginOn()) {
    el.hidden = true;
    const toggle = $('miniExpand');
    if (toggle) toggle.hidden = true;
    const bar = $('miniPlayer');
    if (bar) bar.classList.remove('caption-collapsed');
    return;
  }
  if (!state.cues.length) miniCaptionIdx = -1;
  if (state.activeCue >= 0) miniCaptionIdx = state.activeCue;
  if (miniCaptionIdx >= state.cues.length) miniCaptionIdx = state.cues.length - 1;
  // 句间停顿里保持上一句，避免字幕条反复消失造成跳动。
  const live = state.activeCue >= 0;
  const cue = miniCaptionIdx >= 0 ? state.cues[miniCaptionIdx] : null;
  const hasCue = !document.body.classList.contains('player-open') && !!state.current && !!cue && !!cue.text;
  const open = hasCue && miniCaptionExpanded();
  const toggle = $('miniExpand');
  if (toggle) {
    toggle.hidden = !hasCue;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? '隐藏字幕' : '展开字幕');
    toggle.title = open ? '隐藏字幕' : '展开字幕';
  }
  const bar = $('miniPlayer');
  if (bar) bar.classList.toggle('caption-collapsed', hasCue && !open);
  el.hidden = !open;
  if (!open) { miniCaptionKey = ''; return; }
  const wi = live && state.mode === 'word' ? state.wordIdx : -1;
  const key = [state.show?.slug, state.current.id, miniCaptionIdx, wi, state.mode, reader.lang].join('|');
  if (key === miniCaptionKey) return;
  miniCaptionKey = key;
  out.innerHTML = miniCaptionMarkup(cue, wi);
}
let miniCoverKey = '', miniPlayOn = null, miniTimeText = '', miniPctBucket = -1;
function syncMini() {
  const el = $('miniPlayer');
  if (!el) return;
  const has = !!state.current;
  el.hidden = !has || document.body.classList.contains('player-open');
  if (!has) return;
  $('miniTitle').textContent = state.current.title || '(无标题)';
  $('miniMeta').textContent = (state.show?.name || '') + (state.current.date ? ' · ' + formatDate(state.current.date) : '');
  const img = state.current.img || state.show?.artwork || '';
  // 这函数挂在 timeupdate 上（约 4Hz）：封面 innerHTML 每次都重设会把 <img> 重新建一次，
  // 播客封面被反复解码/重绘，白烧 CPU。只在集/封面变化时才重建。
  const coverKey = (state.show?.slug || '') + '|' + img;
  if (coverKey !== miniCoverKey) {
    miniCoverKey = coverKey;
    $('miniCover').innerHTML = (img ? '<img src="' + esc(smallArtwork(img) || img) + '" alt="" referrerpolicy="no-referrer" onerror="this.remove()">' : '') +
      '<span>' + esc(initialsOf(state.show?.name || '')) + '</span>';
  }
  const duration = audio.duration || 0;
  const current = audio.currentTime || 0;
  const pct = duration > 0 ? Math.min(100, current / duration * 100) : 0;
  const bucket = Math.round(pct * 10);
  if (bucket !== miniPctBucket) {
    miniPctBucket = bucket;
    $('miniFill').style.width = pct + '%';
  }
  const timeText = fmt(current) + ' / ' + fmt(duration);
  if (timeText !== miniTimeText) {
    miniTimeText = timeText;
    $('miniTime').textContent = timeText;
  }
  const playing = !audio.paused;
  if (playing !== miniPlayOn) {
    miniPlayOn = playing;
    $('miniPlay').innerHTML = playing
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7.5h2.2v9H9zM12.8 7.5H15v9h-2.2z"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 7.4v9.2L17.2 12z"/></svg>';
    $('miniPlay').setAttribute('aria-label', playing ? '暂停' : '播放');
  }
  const list = currentPlaylist();
  const index = list.findIndex(item => item.id === state.current.id);
  $('miniPrev').disabled = index <= 0;
  $('miniNext').disabled = index < 0 || index >= list.length - 1;
  syncMiniCaption();
}

/* layer: bridge —— MediaSession、托盘、迷你窗、IIFE 收尾
   本片只做该层的事，跨层调用走 kernel / host() / setState。 */
/* 桌面壳桥：系统媒体控件（MediaSession）、托盘菜单、独立迷你窗。
   网页版没有 __TAURI__，整段不执行；播放状态仍然只有 audio 一份，这里只做转发。 */
(function desktopBridge() {
  const T = tauriHost();
  if (!T || !T.event) return;

  const jump = (delta) => {
    if (!state.current) return;
    rawSeek((audio.currentTime || 0) + delta);
    paint(true);
  };

  // 1) 系统媒体控件：Windows 媒体浮层、键盘媒体键、耳机键。
  //    先走 WebView 的 MediaSession（零成本）；实测按键不响应再换 Rust 侧 SMTC。
  const ms = 'mediaSession' in navigator ? navigator.mediaSession : null;
  let msKey = '';
  if (ms) {
    const bind = (action, fn) => { try { ms.setActionHandler(action, fn); } catch (e) {} };
    bind('play', () => { if (state.current) audio.play().catch(() => {}); });
    bind('pause', () => audio.pause());
    bind('stop', () => audio.pause());
    bind('seekbackward', (d) => jump(-Math.max(1, (d && d.seekOffset) || 10)));
    bind('seekforward', (d) => jump(Math.max(1, (d && d.seekOffset) || 30)));
    bind('previoustrack', () => stepEpisode(-1));
    bind('nexttrack', () => stepEpisode(1));
  }
  function msSync() {
    if (!ms) return;
    if (!state.current) {
      try { ms.metadata = null; ms.playbackState = 'none'; } catch (e) {}
      return;
    }
    const key = state.current.id + '|' + (state.show?.name || '');
    if (key !== msKey) {
      msKey = key;
      const art = state.current.img || state.show?.artwork || '';
      try {
        ms.metadata = new MediaMetadata({
          title: state.current.title || '未在播放',
          artist: state.show?.name || 'MyTranscript',
          album: 'MyTranscript',
          artwork: art ? [{ src: art, sizes: '512x512' }] : [],
        });
      } catch (e) {}
    }
    try {
      ms.playbackState = audio.paused ? 'paused' : 'playing';
      const dur = audio.duration || 0;
      if (dur > 0 && ms.setPositionState) {
        ms.setPositionState({
          duration: dur,
          position: Math.min(audio.currentTime || 0, dur),
          playbackRate: audio.playbackRate || 1,
        });
      }
    } catch (e) {}
  }

  // 2) 迷你窗：状态往那边推，按钮命令从那边收回。
  let miniCueIdx = -1, miniCueEp = '';
  function pushMini() {
    if (!state.current) {
      miniCueIdx = -1; miniCueEp = '';
      try { T.event.emit('myt://mini-state', { empty: true }); } catch (e) {}
      return;
    }
    // 句间停顿里保持上一句，换集则从头开始，别把上一集的字幕带过去。
    if (miniCueEp !== state.current.id) { miniCueEp = state.current.id; miniCueIdx = -1; }
    let cap = '', capZh = '', capLive = false;
    if (LIVE.on) {
      const key = LIVE.order[LIVE.order.length - 1];
      const row = key ? LIVE.rows.get(key) : null;
      cap = row ? row.words.map((w) => w.t).join(' ') : '等待识别输出…';
      capZh = row && row.zhText ? row.zhText : '';
      capLive = true;
    } else if (state.cues.length) {
      if (state.activeCue >= 0) miniCueIdx = state.activeCue;
      if (miniCueIdx >= state.cues.length) miniCueIdx = state.cues.length - 1;
      const cue = miniCueIdx >= 0 ? state.cues[miniCueIdx] : null;
      if (cue) { cap = cue.text || ''; capZh = cue.zh || ''; }
    }
    const list = currentPlaylist();
    const index = list.findIndex((item) => item.id === state.current.id);
    const img = state.current.img || state.show?.artwork || '';
    try {
      T.event.emit('myt://mini-state', {
        title: state.current.title || '(无标题)',
        meta: (state.show?.name || '') + (state.current.date ? ' · ' + formatDate(state.current.date) : ''),
        cover: img ? (smallArtwork(img) || img) : '',
        pos: audio.currentTime || 0,
        dur: audio.duration || 0,
        playing: !audio.paused,
        canPrev: index > 0,
        canNext: index >= 0 && index < list.length - 1,
        cap,
        capZh,
        capLive,
      });
    } catch (e) {}
  }
  T.event.listen('myt://mini-cmd', (ev) => {
    const p = ev.payload || {};
    if (p.cmd === 'toggle') { audio.paused ? audio.play().catch(() => {}) : audio.pause(); }
    else if (p.cmd === 'prev') stepEpisode(-1);
    else if (p.cmd === 'next') stepEpisode(1);
    else if (p.cmd === 'seekRel') jump(Number(p.value) || 0);
    else if (p.cmd === 'seekTo') {
      const dur = audio.duration || 0;
      if (dur > 0) { rawSeek(Math.max(0, Math.min(1, Number(p.value) || 0)) * dur); paint(true); }
    }
  });

  // 3) 托盘菜单：播放控制统一交给前端执行，壳层不另存一份状态。
  T.event.listen('myt://tray', (ev) => {
    const cmd = String(ev.payload || '');
    if (cmd === 'play') { audio.paused ? audio.play().catch(() => {}) : audio.pause(); }
    else if (cmd === 'prev') stepEpisode(-1);
    else if (cmd === 'next') stepEpisode(1);
    else if (cmd === 'mini') { if (T.core && T.core.invoke) T.core.invoke('open_mini'); }
  });
  // 键盘媒体键（桌面壳注册全局热键后转发）
  T.event.listen('myt://media', (ev) => {
    const cmd = String(ev.payload || '');
    if (cmd === 'playpause') { audio.paused ? audio.play().catch(() => {}) : audio.pause(); }
    else if (cmd === 'prev') stepEpisode(-1);
    else if (cmd === 'next') stepEpisode(1);
  });

  pushMini(); msSync();
  try { T.core.invoke('dbg_note', { msg: 'bridge ready current=' + (state.current ? state.current.id : 'null') }); } catch (e) {}
  setInterval(() => { pushMini(); msSync(); }, 600);
})();

function saveSleep() {
  if (app.sleepUntil || app.sleepEnd) localStorage.setItem('myt-sleep', JSON.stringify({ until: app.sleepUntil, end: app.sleepEnd }));
  else localStorage.removeItem('myt-sleep');
}
function startSleepTimer() {
  clearInterval(app.sleepTimer);
  app.sleepTimer = setInterval(() => {
    if (dockSheet.classList.contains('on')) syncDockSleep();
    if (app.sleepUntil && Date.now() >= app.sleepUntil) {
      audio.pause();
      app.sleepUntil = 0;
      clearInterval(app.sleepTimer); app.sleepTimer = 0;
      saveSleep(); renderListening();
      if (dockSheet.classList.contains('on')) syncDockSleep();
      showToast('睡眠定时结束，已暂停。');
    }
  }, 1000);
}
function setSleep(value) {
  clearInterval(app.sleepTimer); app.sleepTimer = 0; app.sleepUntil = 0; app.sleepEnd = false;
  if (value === 'end') app.sleepEnd = true;
  else if (value !== 'off') { app.sleepUntil = Date.now() + Number(value) * 60000; startSleepTimer(); }
  saveSleep(); renderListening();
  syncDockSleep();
  showToast(value === 'off' ? '已关闭睡眠定时。' : value === 'end' ? '本集结束后自动暂停。' : '已设置 ' + value + ' 分钟睡眠定时。');
}
function applyAppearance(value, toast) {
  const wasCar = app.appearance === 'car';
  app.appearance = value;
  try { localStorage.setItem('myt-appearance', value); } catch (e) {}
  document.body.classList.toggle('car-mode', value === 'car');
  // 驾驶界面把正文整块藏掉，散落的浮层没有意义；和阅读沉浸叠加会得到一块空屏。
  if (value === 'car') { closeOverlays(false); if (state.immersive) setImmersive(false); }
  // 离开驾驶界面后，正文高亮在隐藏期间没更新过，按「重新定位一遍」的方式复活。
  if (wasCar && value !== 'car') {
    setState('activeCue', -1); setState('wordIdx', -1);
    // 只把 lastIdx 置脏不够：活着的句子挂着 .active、词还停在隐藏前的颜色，
    // 而 paint 在 activeCue=-1 时不会去清理上一句，于是新旧两句会同时亮着。
    state.nodes.forEach(n => {
      n.el.classList.remove('active');
      n.words.forEach(w => { w.classList.remove('active', 'past'); w.classList.add('pending'); });
      n.lastIdx = -1;
    });
    LIVE.rows.forEach(r => {
      r.el.classList.remove('active');
      r.words.forEach(w => { w.el.classList.remove('active', 'past', 'pending'); w.el.classList.add('pending'); });
      r.lastIdx = -1;
    });
    setState('pendingFollow', true);
  }
  renderListening(); syncMini();
  paint(true);
  if (toast) showToast('界面：' + LISTEN_APPEARANCE[value].name);
}
function setAppearance(value) {
  if (!LISTEN_APPEARANCE[value] || app.appearance === value) return;
  applyAppearance(value, true);
}
function setContinueMode(value) {
  if (!LISTEN_CONTINUE[value] || app.cont === value) return;
  app.cont = value;
  try { localStorage.setItem('myt-continue', value); } catch (e) {}
  // 「自动连续播放」开关只是这一项的快捷开关，状态必须跟着走，别留两个真值来源。
  prefs.autoNext = value !== 'single';
  savePrefs();
  syncAutoNextSwitch();
  renderListening();
  showToast('播完之后：' + LISTEN_CONTINUE[value].name);
}
function syncAutoNextSwitch() {
  const auto = $('setAutoNext');
  if (auto) auto.setAttribute('aria-checked', String(app.cont !== 'single'));
}
async function playNextAuto(radioOnly) {
  const current = state.current;
  if (!current) return;
  const list = currentPlaylist();
  const next = nextTarget(list, current.id, state.show?.slug);
  if (next) { selectEpisode(next, true); audio.play().catch(() => {}); return; }
  if (!radioOnly && app.queue.length) {
    let index = 0;
    if (prefs.queueOrder === 'shuffle') index = Math.floor(Math.random() * app.queue.length);
    else if (prefs.queueOrder === 'unplayed') {
      index = app.queue.findIndex(item => !isPlayed(item.key, item.ep));
      if (index < 0) index = 0;
    }
    const item = app.queue.splice(index, 1)[0];
    saveQueue();
    const show = showByKey(item.key);
    if (show) { await loadShow(show.slug, item.ep); audio.play().catch(() => {}); renderAfterStateChange(); return; }
  }
  showToast(radioOnly ? '这档节目没有下一集了。' : '队列和节目都没有下一集了。');
}

/* ---------- add feed ---------- */
function openModal(html) {
  const modal = $('modal'), card = $('modalCard');
  card.innerHTML = html;
  const heading = card.querySelector('h3');
  if (heading) {
    heading.id = 'modalTitle';
    modal.setAttribute('aria-labelledby', 'modalTitle');
    modal.removeAttribute('aria-label');
  } else {
    modal.removeAttribute('aria-labelledby');
    modal.setAttribute('aria-label', '对话框');
  }
  if (!modal.open) modal.showModal();
}
function closeModal() { const modal = $('modal'); if (modal.open) modal.close(); }
function openBuiltinImport() {
  const available = app.builtinShows.filter(show => show.feed && !isSubscribed(show.slug));
  if (!available.length) {
    openModal('<div class="modal-head"><h3>导入内置源</h3><button class="mini-btn" data-close-modal>✕</button></div>' +
      '<div class="online-state">所有内置源都已订阅。</div>' +
      '<div class="modal-actions"><button class="btn ghost" data-close-modal>关闭</button></div>');
    return;
  }
  openModal('<div class="modal-head"><h3>导入内置源</h3><span class="smalltext" style="margin-left:auto">选择要订阅的节目</span><button class="mini-btn" data-close-modal>✕</button></div>' +
    '<div style="display:flex;gap:7px;margin-bottom:8px"><button class="btn ghost small" id="builtinSelectAll">全选</button><button class="btn ghost small" id="builtinClear">清空</button></div>' +
    '<div class="builtin-pick-list">' + available.map(show => {
      const count = show.episode_count || catalogLatest(show).length || 0;
      return '<label class="ep-row" style="cursor:pointer"><input class="import-pick" type="checkbox" value="' +
        esc(show.slug) + '" data-builtin-pick>' + coverHTML(show, 'ep-art') +
        '<div class="ep-body"><span class="ep-title">' + esc(show.name) + '</span><span class="ep-sub">' +
        (count ? count + ' 集 · ' : '') + '双语文字稿</span></div></label>';
    }).join('') + '</div>' +
    '<div class="modal-actions"><button class="btn ghost" data-close-modal>取消</button><button class="btn primary" id="builtinImportGo">导入所选</button></div>');
  $('builtinSelectAll').onclick = () => document.querySelectorAll('[data-builtin-pick]').forEach(box => { box.checked = true; });
  $('builtinClear').onclick = () => document.querySelectorAll('[data-builtin-pick]').forEach(box => { box.checked = false; });
  $('builtinImportGo').onclick = () => {
    const keys = [...document.querySelectorAll('[data-builtin-pick]:checked')].map(box => box.value);
    if (!keys.length) { showToast('先选择至少一个节目。'); return; }
    let added = 0;
    for (const key of keys) {
      const show = app.builtinShows.find(item => item.slug === key);
      if (show && subscribeShow(show)) added++;
    }
    closeModal();
    showToast('已导入 ' + added + ' 个内置源。');
    renderAfterStateChange();
  };
}
function openAddFeed() {
  openModal('<div class="modal-head"><h3>添加播客</h3><button class="mini-btn" data-close-modal>✕</button></div>' +
    '<div class="modal-tabs"><button class="active" data-feed-tab="url">RSS 链接</button><button data-feed-tab="paste">粘贴 RSS 内容</button><button data-feed-tab="opml">OPML 文件</button></div>' +
    '<div class="modal-pane active" data-feed-pane="url"><div class="modal-row"><label>播客 RSS 地址</label><input id="feedUrl" placeholder="https://example.com/feed.xml"></div>' +
    '<div class="modal-note">本站内置的增强 Feed 会自动识别为内置订阅；站外节目只播放音频，不提供增强字幕。</div>' +
    '<div class="modal-actions"><button class="btn ghost" data-close-modal>取消</button><button class="btn primary" id="feedAdd">添加</button></div></div>' +
    '<div class="modal-pane" data-feed-pane="paste"><div class="modal-row"><label>Feed 地址（可选，便于以后刷新）</label><input id="pasteUrl" placeholder="https://example.com/feed.xml"></div>' +
    '<div class="modal-row"><label>RSS 内容</label><textarea id="pasteXml" placeholder="&lt;?xml version=&quot;1.0&quot; ..."></textarea></div>' +
    '<div class="modal-note">适合 feed 站点不允许跨域时使用：在浏览器里保存 RSS 再粘贴进来。</div>' +
    '<div class="modal-actions"><button class="btn ghost" data-close-modal>取消</button><button class="btn primary" id="pasteAdd">导入内容</button></div></div>' +
    '<div class="modal-pane" data-feed-pane="opml"><div class="modal-note">选择一个 OPML 文件，批量导入订阅；站外 feed 导入后会逐个读取。</div>' +
    '<div class="modal-actions"><button class="btn ghost" data-close-modal>取消</button><button class="btn primary" id="opmlPick">选择 OPML 文件</button></div></div>');
  $('feedAdd').onclick = () => addFeedFromUrl($('feedUrl').value);
  $('feedUrl').addEventListener('keydown', event => { if (event.key === 'Enter') addFeedFromUrl($('feedUrl').value); });
  $('pasteAdd').onclick = () => addFeedFromPaste($('pasteXml').value, $('pasteUrl').value);
  $('opmlPick').onclick = () => { closeModal(); $('opmlFile').click(); };
  setTimeout(() => $('feedUrl')?.focus(), 30);
}
async function addFeedFromUrl(url) {
  const normalized = normalizeFeedUrl(url);
  if (!normalized) { showToast('请输入 RSS 地址。'); return; }
  const builtin = findBuiltinByFeed(normalized);
  if (builtin) {
    subscribeShow(builtin);
    closeModal();
    showToast('已订阅 ' + builtin.name);
    navigate('podcast', [builtin.slug]);
    return;
  }
  const key = extSlug(normalized);
  if (isSubscribed(key)) { closeModal(); navigate('podcast', [key]); return; }
  closeModal();
  showToast('正在读取 feed…', 8000);
  try {
    const xml = await fetchFeedText(normalized, { force: true });
    const feed = parseFeed(xml);
    if (!feed.title && !feed.episodes.length) throw new Error('返回内容不是可识别的 RSS。');
    const rec = {
      key, feed: normalized, name: cleanFeedTitle(feed.title) || hostOf(normalized), builtin: false,
      artwork: feed.artwork || '', description: feed.description || '', addedAt: Date.now(),
    };
    subscribeRecord(rec);
    rememberFeed(key, feed);
    app.feedErrors?.delete(key);
    showToast('已订阅 ' + rec.name);
    navigate('podcast', [key]);
  } catch (err) {
    subscribeRecord({
      key, feed: normalized, name: hostOf(normalized), builtin: false,
      artwork: '', description: '', addedAt: Date.now(),
    });
    app.feedErrors = app.feedErrors || new Map();
    app.feedErrors.set(key, err.message);
    showToast('订阅已保存，但 feed 读取失败。', 9000);
    navigate('podcast', [key]);
  }
}
function addFeedFromPaste(xml, url) {
  const text = String(xml || '').trim();
  if (!text) { showToast('请粘贴 RSS 内容。'); return; }
  const feed = parseFeed(text);
  if (!feed.title && !feed.episodes.length) { showToast('这段内容不是可识别的 RSS。'); return; }
  const normalized = normalizeFeedUrl(url) || 'inline:' + hash32(text);
  const key = extSlug(normalized);
  const rec = {
    key, feed: normalized, name: cleanFeedTitle(feed.title) || '手动导入', builtin: false,
    artwork: feed.artwork || '', description: feed.description || '', addedAt: Date.now(),
  };
  subscribeRecord(rec);
  rememberFeed(key, feed);
  feedCachePut(absoluteUrl(normalized), text);
  closeModal();
  showToast('已导入 ' + rec.name);
  navigate('podcast', [key]);
}
function importOpmlText(text) {
  const items = parseOpml(text);
  if (!items.length) { showToast('没有在 OPML 里找到订阅。'); return 0; }
  let added = 0, existing = 0;
  for (const item of items) {
    const url = normalizeFeedUrl(item.xmlUrl);
    if (!url) continue;
    const builtin = findBuiltinByFeed(url);
    if (builtin) {
      if (isSubscribed(builtin.slug)) existing++;
      else { subscribeShow(builtin); added++; }
      continue;
    }
    const key = extSlug(url);
    if (isSubscribed(key)) { existing++; continue; }
    subscribeRecord({
      key, feed: url, name: item.title || hostOf(url), builtin: false,
      artwork: '', description: '', addedAt: Date.now(),
    });
    added++;
  }
  showToast('导入完成：新增 ' + added + ' 个，已存在 ' + existing + ' 个。', 7000);
  renderAfterStateChange();
  lazyLoadExternal();
  return added;
}
async function lazyLoadExternal() {
  const pending = app.subs.filter(sub => !sub.builtin && !hasFreshFeed(sub.key) && !app.feedErrors?.get(sub.key));
  for (const sub of pending.slice(0, 4)) {
    const show = showByKey(sub.key);
    if (!show) continue;
    try { await ensureShowFeed(show); }
    catch (err) {
      app.feedErrors = app.feedErrors || new Map();
      app.feedErrors.set(show.slug, err.message);
    }
  }
  if (pending.length) renderAfterStateChange();
}

/* ---------- 订阅自动化：定时刷新 / 新集收件箱 / 自动下载 / 自动清理 ---------- */
const autoDelay = ms => new Promise(resolve => setTimeout(resolve, ms));
function desktopNotify(title, body) {
  try {
    if (host() && host().notify) { host().notify(title, body); showToast(body, 8000); return; }
    if (!('Notification' in window)) { showToast(body, 8000); return; }
    const fire = () => { try { new Notification(title, { body, silent: false }); } catch (e) {} };
    if (Notification.permission === 'granted') fire();
    else if (Notification.permission === 'default') {
      Notification.requestPermission().then(permission => { if (permission === 'granted') fire(); }).catch(() => {});
    }
    showToast(body, 8000);
  } catch (e) {}
}
function queueHasEpisode(showKey, epId) {
  return app.queue.some(item => item.key === showKey && item.ep === epId);
}
async function autoDownloadNew(show, fresh) {
  if (!app.auto.autoDownload || !show) return;
  if (!showPrefFor(show.slug).autoDownload) return;
  const limit = Math.max(1, Number(app.auto.downloadCount) || 1);
  const candidates = (fresh || []).filter(ep => ep && !isPlayed(show.slug, ep.id)
    && !app.offline.has(offlineKeyFor(show, ep)) && !app.downloading.has(offlineKeyFor(show, ep)));
  for (const ep of candidates.slice(0, limit)) {
    try { await downloadEpisode(show, ep, { quiet: true }); }
    catch (e) {}
  }
}
async function refreshSubscriptions(manual = false) {
  if (app.refreshBusy) { if (manual) showToast('正在刷新订阅，请稍候…', 3000); return; }
  const subs = app.subs.filter(sub => showByKey(sub.key)?.feed);
  if (!subs.length) { if (manual) showToast('还没有可刷新的订阅。'); return; }
  app.refreshBusy = true;
  let checked = 0, failed = 0, freshCount = 0;
  const statusEl = $('autoStatus');
  try {
    for (const sub of subs) {
      const show = showByKey(sub.key);
      if (!show?.feed) continue;
      checked++;
      if (statusEl) statusEl.textContent = '正在刷新 ' + checked + ' / ' + subs.length + '：' + (show.name || show.slug);
      try {
        const hadSeen = Object.prototype.hasOwnProperty.call(app.seen, show.slug);
        const known = new Set(app.seen[show.slug] || []);
        const feed = await ensureShowFeed(show, { force: true });
        const ids = feed.episodes.map(ep => ep.id);
        if (!hadSeen) {
          app.seen[show.slug] = ids;
          continue;
        }
        const fresh = feed.episodes.filter(ep => ep && ep.id && !known.has(ep.id));
        app.seen[show.slug] = ids;
        if (fresh.length) {
          freshCount += fresh.length;
          fresh.slice(0, 30).forEach(ep => addInboxItem(show, ep));
          await autoDownloadNew(show, fresh);
          if (app.auto.notify && showPrefFor(show.slug).notify) {
            desktopNotify('MyTranscript · ' + (show.name || '新单集'),
              fresh.length + ' 集新单集：' + (fresh[0].title || '（无标题）'));
          }
        }
      } catch (err) {
        failed++;
        app.feedErrors = app.feedErrors || new Map();
        app.feedErrors.set(show.slug, err.message);
      }
      await autoDelay(250);
    }
    app.auto.lastRefreshAt = Date.now();
    saveSeen(); saveAuto();
    await autoCleanup();
    if (statusEl) statusEl.textContent = '上次刷新：' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      + ' · 检查 ' + checked + ' 个 · 新集 ' + freshCount + (failed ? ' · 失败 ' + failed : '');
    if (manual || freshCount) {
      showToast(freshCount ? '刷新完成：' + freshCount + ' 集新单集已放进收件箱。' : '刷新完成，没有新单集。', 6000);
      renderAfterStateChange();
    }
  } finally {
    app.refreshBusy = false;
  }
}
function startAutoRefresh() {
  if (app.autoTimer) { clearInterval(app.autoTimer); app.autoTimer = 0; }
  const hours = Number(app.auto.refreshHours) || 0;
  if (!hours) return;
  if (!app.auto.lastRefreshAt) { app.auto.lastRefreshAt = Date.now(); saveAuto(); }
  const maybe = () => {
    if (app.refreshBusy || document.hidden) return;
    if (Date.now() - Number(app.auto.lastRefreshAt || 0) < hours * 3600000) return;
    refreshSubscriptions(false);
  };
  app.autoTimer = setInterval(maybe, 5 * 60 * 1000);
  setTimeout(maybe, 15000);
}
async function deleteOfflineQuiet(key) {
  if (!host() || typeof host().offlineRemove !== 'function') return false;
  try {
    await host().offlineRemove(key);
    app.offline.delete(key);
    return true;
  } catch (e) { return false; }
}
async function autoCleanup() {
  if (!host() || typeof host().offlineRemove !== 'function') return;
  const entries = offlineEntries();
  if (!entries.length) return;
  const protectedKey = state.show && state.current ? offlineKeyFor(state.show, state.current) : '';
  const remove = [];
  for (const rec of entries) {
    if (rec.key === protectedKey) continue;
    const ref = resolveOfflineRef(rec.key);
    if (!ref) continue;
    const favorite = isFavorite(ref.show.slug, ref.ep.id);
    if (app.auto.keepFavorites && favorite) continue;
    if (app.auto.deletePlayed && isPlayed(ref.show.slug, ref.ep.id)) { remove.push(rec.key); continue; }
    if (app.auto.deleteNotInQueue && !queueHasEpisode(ref.show.slug, ref.ep.id)) remove.push(rec.key);
  }
  let total = entries.reduce((sum, rec) => sum + (Number(rec.size) || 0) + (Number(rec.transcriptSize) || 0), 0);
  const capMB = Number(app.auto.capMB) || 0;
  if (capMB > 0 && total > capMB * 1048576) {
    for (const rec of entries) {
      if (total <= capMB * 1048576) break;
      if (remove.includes(rec.key) || rec.key === protectedKey) continue;
      const ref = resolveOfflineRef(rec.key);
      if (ref && app.auto.keepFavorites && isFavorite(ref.show.slug, ref.ep.id)) continue;
      if (ref && queueHasEpisode(ref.show.slug, ref.ep.id)) continue;
      remove.push(rec.key);
      total -= (Number(rec.size) || 0) + (Number(rec.transcriptSize) || 0);
    }
  }
  let removed = 0;
  for (const key of remove) {
    if (await deleteOfflineQuiet(key)) removed++;
  }
  if (removed) {
    showToast('自动清理了 ' + removed + ' 个离线文件。', 4000);
    renderOfflineList();
  }
}

/* ---------- shell bindings ---------- */
function savePrefs() { writeJSON(PREFS_KEY, prefs); }
function playEpisode(key, epId, time) {
  if (!key || !epId) return;
  app.autoplay = true;
  if (Number(time) > 0) { app.pendingSeek = Number(time); app.pendingSeekEp = epId; }
  if (document.body.classList.contains('player-open')) {
    const wanted = routeHash('player', [key, epId], Number(time) > 0 ? { t: Number(time) } : {});
    if (location.hash !== wanted) history.replaceState(null, '', wanted);
    openPlayerRoute({ args: [key, epId], params: new URLSearchParams(Number(time) > 0 ? { t: Number(time) } : {}) });
  } else {
    navigate('player', [key, epId], Number(time) > 0 ? { t: Number(time) } : {});
  }
}
function closeThemePop() { $('themePop')?.classList.remove('on'); }
function bindShell() {
  if (app.initialized) return;
  app.initialized = true;
  const skipLink = $('skipLink');
  if (skipLink) skipLink.onclick = () => {
    const main = $('shellMain');
    if (!main) return;
    main.focus();
    const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    main.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  };
  addEventListener('hashchange', applyRoute);

  document.addEventListener('change', event => {
    const el = event.target;
    if (!el || !el.dataset) return;
    if (el.dataset.showSpeed) {
      const value = Number(el.value) || 1;
      setShowPref(el.dataset.showSpeed, { speed: value });
      if (state.show?.slug === el.dataset.showSpeed) audio.playbackRate = value;
      showToast('这档节目的默认速度已设为 ' + value + '×。', 2500);
      return;
    }
    if (el.dataset.showIntro) {
      setShowPref(el.dataset.showIntro, { skipIntro: Math.max(0, Number(el.value) || 0) });
      if (state.show?.slug === el.dataset.showIntro) setState('introSkipped', false);
      return;
    }
    if (el.dataset.showOutro) {
      setShowPref(el.dataset.showOutro, { skipOutro: Math.max(0, Number(el.value) || 0) });
      if (state.show?.slug === el.dataset.showOutro) setState('outroSkipped', false);
      return;
    }
    if (el.id === 'echoYear') { app.echoYear = Number(el.value); renderEcho(); return; }
  });

  document.addEventListener('click', event => {
    const el = event.target.closest('[data-route],[data-open-podcast],[data-open-episode],[data-play-episode],[data-queue-episode],[data-list-episode],[data-offline-episode],[data-offline-transcript],[data-ai-episode],[data-play-playlist],[data-del-playlist],[data-play-offline],[data-del-offline],[data-chapter],[data-resume],[data-sub-toggle],[data-remove-sub],[data-copy-feed],[data-copy-link],[data-load-full],[data-remove-queue],[data-del-bookmark],[data-del-note],[data-cue-seek],[data-appearance],[data-continue],[data-sleep],[data-asr-pick],[data-asr-install],[data-asr-remove],[data-asr-cancel],[data-asr-open],[data-feed-tab],[data-close-modal],[data-action],[data-online-builtin],[data-online-open],[data-online-subscribe],[data-online-detail],[data-retry-online],[data-online-chip],[data-online-more],[data-ep-filter],[data-fav-episode],[data-played-episode],[data-inbox-remove],[data-inbox-played],[data-show-auto],[data-show-notify],[data-del-local],[data-open-video],[data-index-jump],[data-open-video-ep],[data-export-sub],[data-local-asr]');
    if (!el) return;
    if (el.dataset.route) { navigate(el.dataset.route); return; }
    if (el.dataset.exportSub) { closeModal(); exportSubtitle(el.dataset.exportSub); return; }
    if (el.dataset.openVideo) { setState('videoId', el.dataset.openVideo); setState('videoEp', null); navigate('video'); return; }
    if (el.dataset.openVideoEp) {
      const show = showByKey(el.dataset.key);
      const ep = episodesOf(show).find(item => item.id === el.dataset.ep);
      if (show && ep && ep.videoUrl) {
        setState('videoEp', { ...ep, showName: show.name, videoUrl: ep.videoUrl });
        setState('videoId', '');
        navigate('video');
      }
      return;
    }
    if (el.dataset.indexJump !== undefined) {
      const key = el.dataset.idxKey || '';
      const at = key.indexOf(':');
      const showKey = at >= 0 ? key.slice(0, at) : key;
      const epId = at >= 0 ? key.slice(at + 1) : '';
      const t = Number(el.dataset.idxT) || 0;
      if (showKey && epId) navigate('player', [showKey, epId], { t: String(Math.round(t)) });
      return;
    }
    if (el.dataset.onlineBuiltin) { navigate('podcast', [el.dataset.onlineBuiltin]); return; }
    if (el.dataset.onlineOpen) { navigate('podcast', [el.dataset.onlineOpen]); return; }
    if (el.dataset.onlineSubscribe) { subscribeFromOnline(el.dataset.onlineSubscribe); return; }
    if (el.dataset.onlineDetail) { openOnlineDetail(el.dataset.onlineDetail); return; }
    if (el.dataset.retryOnline !== undefined) { runOnlineSearch(app.online.query); return; }
    if (el.dataset.onlineMore !== undefined) {
      app.online.visible = (Number(app.online.visible) || ONLINE_PAGE) + ONLINE_PAGE;
      renderOnlineResults();
      return;
    }
    if (el.dataset.onlineChip) {
      const input = $('onlineSearchInput');
      if (input) input.value = el.dataset.onlineChip;
      runOnlineSearch(el.dataset.onlineChip);
      return;
    }
    if (el.dataset.closeModal !== undefined) { closeModal(); return; }
    if (el.dataset.openPodcast) { navigate('podcast', [el.dataset.openPodcast]); return; }
    if (el.dataset.openEpisode !== undefined) { navigate('episode', [el.dataset.key, el.dataset.ep]); return; }
    if (el.dataset.playEpisode !== undefined) {
      event.stopPropagation();
      playEpisode(el.dataset.key, el.dataset.ep);
      return;
    }
    if (el.dataset.localAsr !== undefined) {
      event.stopPropagation();
      startLocalTranscribe(el.dataset.localAsr);
      return;
    }
    if (el.dataset.aiEpisode !== undefined) {
      event.stopPropagation();
      studyOpenEpisodeSummary(el.dataset.key, el.dataset.ep);
      return;
    }
    if (el.dataset.queueEpisode !== undefined) {
      event.stopPropagation();
      const show = showByKey(el.dataset.key);
      const ep = show ? episodesOf(show).find(item => item.id === el.dataset.ep) : null;
      if (show && ep) addToQueue(show, ep);
      return;
    }
    if (el.dataset.epFilter) {
      app.epFilter = el.dataset.epFilter;
      const pageKey = (app.route?.page === 'podcast' && app.route.args[0]) || state.show?.slug || '';
      if (pageKey) renderPodcast(pageKey);
      return;
    }
    if (el.dataset.favEpisode !== undefined) {
      event.stopPropagation();
      const on = toggleFavorite(el.dataset.key, el.dataset.ep);
      showToast(on ? '已收藏这一集。' : '已取消收藏。', 2500);
      renderAfterStateChange();
      return;
    }
    if (el.dataset.playedEpisode !== undefined) {
      event.stopPropagation();
      setPlayed(el.dataset.key, el.dataset.ep, !isPlayed(el.dataset.key, el.dataset.ep));
      return;
    }
    if (el.dataset.inboxRemove !== undefined) {
      event.stopPropagation();
      inboxRemove(el.dataset.inboxRemove);
      renderInbox();
      return;
    }
    if (el.dataset.inboxPlayed !== undefined) {
      event.stopPropagation();
      app.played[epKey(el.dataset.key, el.dataset.ep)] = Date.now();
      savePlayed();
      inboxRemove(epKey(el.dataset.key, el.dataset.ep));
      renderInbox();
      renderHome();
      showToast('已标记为已听。', 2500);
      return;
    }
    if (el.dataset.showAuto !== undefined) {
      event.stopPropagation();
      const key = el.dataset.showAuto;
      const next = !(showPrefFor(key).autoDownload !== false);
      setShowPref(key, { autoDownload: next });
      el.setAttribute('aria-checked', String(next));
      showToast(next ? '这档节目会自动下载新集。' : '这档节目不自动下载。', 2500);
      return;
    }
    if (el.dataset.showNotify !== undefined) {
      event.stopPropagation();
      const key = el.dataset.showNotify;
      const next = !(showPrefFor(key).notify !== false);
      setShowPref(key, { notify: next });
      el.setAttribute('aria-checked', String(next));
      return;
    }
    if (el.dataset.delLocal !== undefined) {
      event.stopPropagation();
      app.local = app.local.filter(ep => ep.id !== el.dataset.delLocal);
      writeJSON(LOCAL_KEY, app.local);
      refreshShows();
      renderLocal();
      return;
    }
    if (el.dataset.listEpisode !== undefined) {
      event.stopPropagation();
      const show = showByKey(el.dataset.key);
      const ep = show ? episodesOf(show).find(item => item.id === el.dataset.ep) : null;
      if (show && ep) addToPlaylistDialog(show, ep);
      else showToast('找不到这一集。', 'warn');
      return;
    }
    if (el.dataset.offlineEpisode !== undefined) {
      event.stopPropagation();
      const show = showByKey(el.dataset.key);
      const ep = show ? episodesOf(show).find(item => item.id === el.dataset.ep) : null;
      if (show && ep) {
        const key = offlineKeyFor(show, ep);
        const rec = app.offline.get(key);
        // 已完整下载再点才是删除；只有音频时点击是补下文字稿。
        if (rec && (rec.hasTranscript || !isJsonTranscript(ep.transcript))) removeOffline(key);
        else downloadEpisode(show, ep);
      } else showToast('找不到这一集。', 'warn');
      return;
    }
    if (el.dataset.playPlaylist !== undefined) { playPlaylist(el.dataset.playPlaylist); return; }
    if (el.dataset.delPlaylist !== undefined) { removePlaylist(el.dataset.delPlaylist); return; }
    if (el.dataset.playOffline !== undefined) { playOffline(el.dataset.playOffline); return; }
    if (el.dataset.offlineTranscript !== undefined) {
      const ref = resolveOfflineRef(el.dataset.offlineTranscript);
      if (ref) downloadEpisode(ref.show, ref.ep); else showToast('找不到这一集。', 'warn');
      return;
    }
    if (el.dataset.delOffline !== undefined) { removeOffline(el.dataset.delOffline); return; }
    if (el.dataset.chapter !== undefined) {
      seekChapter(Number(el.dataset.chapter));
      toggleChapterSheet(false);
      return;
    }
    if (el.dataset.resume !== undefined) {
      event.stopPropagation();
      if (el.dataset.key && el.dataset.ep) playEpisode(el.dataset.key, el.dataset.ep, Number(el.dataset.t) || 0);
      return;
    }
    if (el.dataset.subToggle) {
      const key = el.dataset.subToggle;
      if (isSubscribed(key)) { unsubscribeKey(key); showToast('已取消订阅。'); }
      else {
        const show = showByKey(key);
        if (show) { subscribeShow(show); showToast('已订阅 ' + show.name); }
      }
      renderAfterStateChange();
      return;
    }
    if (el.dataset.removeSub) { unsubscribeKey(el.dataset.removeSub); showToast('已移除订阅。'); return; }
    if (el.dataset.copyFeed) { copyText(el.dataset.copyFeed); return; }
    if (el.dataset.copyLink !== undefined) {
      copyText(location.origin + location.pathname + routeHash('episode', [el.dataset.key, el.dataset.ep]));
      return;
    }
    if (el.dataset.loadFull) {
      const show = showByKey(el.dataset.loadFull);
      if (!show) return;
      showToast('正在读取 feed，可能较慢…', 10000);
      ensureShowFeed(show, { force: true }).then(feed => {
        app.feedErrors?.delete(show.slug);
        showToast('已加载 ' + feed.episodes.length + ' 集。');
        renderAfterStateChange();
      }).catch(err => {
        app.feedErrors = app.feedErrors || new Map();
        app.feedErrors.set(show.slug, err.message);
        showToast(err.message, 10000);
        renderAfterStateChange();
      });
      return;
    }
    if (el.dataset.removeQueue !== undefined) {
      app.queue.splice(Number(el.dataset.removeQueue), 1);
      saveQueue(); renderQueue();
      return;
    }
    if (el.dataset.delBookmark) {
      app.bookmarks = app.bookmarks.filter(item => item.id !== el.dataset.delBookmark);
      writeJSON(BOOKMARK_KEY, app.bookmarks); renderBookmarks();
      return;
    }
    if (el.dataset.delNote) {
      app.notes = app.notes.filter(item => item.id !== el.dataset.delNote);
      writeJSON(NOTE_KEY, app.notes); renderNotes();
      return;
    }
    if (el.dataset.cueSeek) {
      if (state.current && state.show) {
        playEpisode(state.show.slug, state.current.id, Number(el.dataset.cueSeek));
      } else showToast('先在播放器里打开一集。');
      return;
    }
    if (el.dataset.appearance) { setAppearance(el.dataset.appearance); return; }
    if (el.dataset.continue) { setContinueMode(el.dataset.continue); return; }
    if (el.dataset.sleep) { setSleep(el.dataset.sleep); return; }
    if (el.dataset.asrPick !== undefined) { pickAsrModel(el.dataset.asrPick); return; }
    if (el.dataset.asrInstall !== undefined) { installAsrModel(el.dataset.asrInstall); return; }
    if (el.dataset.asrRemove !== undefined) { removeAsrModel(el.dataset.asrRemove); return; }
    if (el.dataset.asrCancel !== undefined) { cancelAsrModel(el.dataset.asrCancel); return; }
    if (el.dataset.asrOpen !== undefined) { openAsrDir(el.dataset.asrOpen); return; }
    if (el.dataset.feedTab) {
      document.querySelectorAll('[data-feed-tab]').forEach(tab => tab.classList.toggle('active', tab === el));
      document.querySelectorAll('[data-feed-pane]').forEach(pane => pane.classList.toggle('active', pane.dataset.feedPane === el.dataset.feedTab));
      return;
    }
    if (el.dataset.action === 'add-feed') { openAddFeed(); return; }
    if (el.dataset.action === 'import-builtin') { openBuiltinImport(); return; }
  });

  $('themeTopBtn').onclick = event => {
    event.stopPropagation();
    const opening = !$('themePop').classList.contains('on');
    $('themePop').classList.toggle('on', opening);
    if (opening) $('themePop').querySelector('.swatch')?.focus();
  };
  document.addEventListener('click', event => {
    if (!event.target.closest('#themePop') && !event.target.closest('#themeTopBtn')) closeThemePop();
  });
  $('settingsTopBtn').onclick = () => navigate('settings');
  $('modal').addEventListener('click', event => { if (event.target.id === 'modal') closeModal(); });

  const runSearch = query => { if (String(query || '').trim()) navigate('search', [String(query).trim()]); };
  $('globalSearch').addEventListener('keydown', event => { if (event.key === 'Enter') runSearch(event.target.value); });
  $('heroSearch').addEventListener('keydown', event => { if (event.key === 'Enter') runSearch(event.target.value); });
  $('heroSearchBtn').onclick = () => runSearch($('heroSearch').value);
  $('searchBtn').onclick = () => runSearch($('searchInput').value);
  $('searchInput').addEventListener('input', event => renderSearch(event.target.value));
  $('searchInput').addEventListener('keydown', event => { if (event.key === 'Enter') runSearch(event.target.value); });
  document.querySelectorAll('[data-search-tab]').forEach(button => {
    button.onclick = () => {
      searchTab = button.dataset.searchTab;
      document.querySelectorAll('[data-search-tab]').forEach(tab => tab.classList.toggle('active', tab === button));
      renderSearch($('searchInput').value);
    };
  });
  $('idxShowBtn').onclick = () => indexCurrentShow();
  $('idxAllBtn').onclick = () => indexAllShows();
  $('idxClearBtn').onclick = async () => {
    if (!confirm('清空本机文字稿索引？不会删除任何单集或字幕文件。')) return;
    await idxClear();
    syncIndexCount();
    showToast('索引已清空。', 3000);
    if (searchTab === 'library') renderSearch($('searchInput')?.value || '');
  };
  syncIndexCount();

  $('libraryFilter').addEventListener('input', renderLibrary);
  $('discoverFilter').addEventListener('input', event => {
    app.discover.query = event.target.value;
    renderDiscover();
  });
  $('discoverCategory').addEventListener('change', event => {
    app.discover.category = event.target.value;
    renderDiscover();
  });
  $('discoverSort').addEventListener('change', event => {
    app.discover.sort = event.target.value;
    renderDiscover();
  });
  $('discoverSub').addEventListener('change', event => {
    app.discover.sub = event.target.value;
    renderDiscover();
  });
  $('discoverTranscript').addEventListener('change', event => {
    app.discover.transcripts = event.target.checked;
    renderDiscover();
  });
  $('libAddBtn').onclick = openAddFeed;
  $('libBuiltinBtn').onclick = openBuiltinImport;
  $('discoverBuiltinBtn').onclick = openBuiltinImport;
  $('discoverAddBtn').onclick = openAddFeed;
  $('rssAddBtn').onclick = openAddFeed;
  $('libOpmlBtn').onclick = () => $('opmlFile').click();
  $('rssImportBtn').onclick = () => $('opmlFile').click();
  $('libExportBtn').onclick = exportOpml;
  $('rssExportBtn').onclick = exportOpml;
  if ($('subHealthBtn')) $('subHealthBtn').onclick = () => checkSubscriptions();
  if ($('videoBack')) $('videoBack').onclick = () => navigate(app.lastPage || 'local');
  $('opmlFile').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try { importOpmlText(await file.text()); }
    catch (err) { showToast('OPML 读取失败：' + err.message); }
    event.target.value = '';
  });

  document.querySelectorAll('#settingsMenu button').forEach(button => {
    button.onclick = () => openSettingsPane(button.dataset.pane);
  });
  document.querySelectorAll('[data-open-pane]').forEach(button => {
    button.onclick = () => openSettingsPane(button.dataset.openPane);
  });
  if ($('sidebarReset')) $('sidebarReset').onclick = resetSidebarSettings;
  renderSidebarSettings();
  $('setSpeed').onchange = event => { applyRate(event.target.value); };
  $('setAutoNext').onclick = () => {
  // 开关 = 「续播」是否为「播完即停」：关 → 播完即停，开 → 连续播放（电台档保持原样不动作）
  setContinueMode(app.cont === 'single' ? 'continuous' : 'single');
};
  $('setRemember').onclick = () => { prefs.remember = prefs.remember === false; savePrefs(); $('setRemember').setAttribute('aria-checked', String(prefs.remember !== false)); };
  $('setLang').onchange = event => { reader.lang = event.target.value; applyReader(); rebuildCues(); };
  bindTranslateUI();
  $('setLiveLead').onchange = event => {
    prefs.liveLead = Math.max(0, Math.min(600, Number(event.target.value) || 0));
    savePrefs();
    if (LIVE.on) liveUpdateMeter();
  };
  $('setLiveMse').onclick = () => {
    prefs.liveMse = !prefs.liveMse;
    savePrefs();
    $('setLiveMse').setAttribute('aria-checked', String(!!prefs.liveMse));
    if (LIVE.on && !prefs.liveMse) liveMseStop();   // 中途关掉就把播放还给原生元素
    showToast(prefs.liveMse
      ? '单流播放已打开：下次开启实时识别时，同一份音频同时用于播放与识别。'
      : '单流播放已关闭，播放退回浏览器原生方式。', 5000);
  };
  $('setQueueOrder').onchange = event => { prefs.queueOrder = event.target.value; savePrefs(); showToast('队列顺序已更新。', 2500); };
  $('setVolumeCap').onchange = event => { prefs.volumeCap = Number(event.target.value) || 1; applyVolume(); showToast('音量上限已更新。', 2500); };
  $('setSkipAds').onclick = () => {
    prefs.skipAds = !prefs.skipAds;
    savePrefs();
    $('setSkipAds').setAttribute('aria-checked', String(!!prefs.skipAds));
    showToast(prefs.skipAds
      ? '已开启跳过：只对「离线音频 + 本机文字稿」的单集生效；误判可在播放器里手动拖回。'
      : '已关闭跳过。', 4000);
  };
  const skipLevelSel = $('setSkipLevel');
  if (skipLevelSel) skipLevelSel.onchange = event => {
    prefs.skipLevel = Math.max(1, Math.min(3, Number(event.target.value) || 2));
    savePrefs();
    showToast('跳过级别已更新：' + prefs.skipLevel, 2500);
  };
  $('setSkipSilence').onclick = () => {
    const el = $('setSkipSilence');
    prefs.skipSilence = !prefs.skipSilence;
    if (prefs.skipSilence && !ensureAudioGraph()) {
      prefs.skipSilence = false;
      showToast('当前音频是跨域地址，浏览器不允许分析波形；本地或离线音频可用。', 6000);
    }
    savePrefs();
    el.setAttribute('aria-checked', String(!!prefs.skipSilence));
    showToast(prefs.skipSilence ? '已开启跳过静音。' : '已关闭跳过静音。', 3000);
  };
  $('setLoudness').onclick = () => {
    const el = $('setLoudness');
    const next = !prefs.loudness;
    if (next && !applyLoudness(true)) {
      showToast('当前音频是跨域地址，无法启用响度均衡；本地或离线音频可用。', 6000);
      return;
    }
    prefs.loudness = next;
    applyLoudness(next);
    savePrefs();
    el.setAttribute('aria-checked', String(!!prefs.loudness));
    showToast(prefs.loudness ? '已开启响度均衡。' : '已关闭响度均衡。', 3000);
  };
  $('setSkipChapterAds').onclick = () => {
    prefs.skipChapterAds = !prefs.skipChapterAds;
    savePrefs();
    $('setSkipChapterAds').setAttribute('aria-checked', String(!!prefs.skipChapterAds));
    showToast(prefs.skipChapterAds ? '已开启广告章节跳过。' : '已关闭广告章节跳过。', 3000);
  };
  const bindAutoSwitch = (id, key, after) => {
    const el = $(id);
    if (!el) return;
    el.onclick = () => {
      app.auto[key] = !app.auto[key];
      saveAuto();
      el.setAttribute('aria-checked', String(!!app.auto[key]));
      if (key === 'notify' && app.auto[key] && 'Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
      }
      if (after) after();
    };
  };
  bindAutoSwitch('autoDownload', 'autoDownload');
  bindAutoSwitch('autoDeletePlayed', 'deletePlayed');
  bindAutoSwitch('autoDeleteQueue', 'deleteNotInQueue');
  bindAutoSwitch('autoKeepFav', 'keepFavorites');
  bindAutoSwitch('autoNotify', 'notify', () => { if (app.auto.notify) desktopNotify('MyTranscript', '新单集通知已打开。'); });
  $('autoRefresh').onchange = event => {
    app.auto.refreshHours = Math.max(0, Number(event.target.value) || 0);
    if (app.auto.refreshHours && !app.auto.lastRefreshAt) app.auto.lastRefreshAt = Date.now();
    saveAuto(); startAutoRefresh();
    showToast(app.auto.refreshHours ? '已开启订阅定时刷新。' : '已关闭订阅定时刷新。', 3500);
  };
  $('autoCount').onchange = event => { app.auto.downloadCount = Math.max(1, Number(event.target.value) || 1); saveAuto(); };
  $('autoCap').onchange = event => { app.auto.capMB = Math.max(0, Number(event.target.value) || 0); saveAuto(); };
  $('autoRefreshNow').onclick = async () => {
    const button = $('autoRefreshNow');
    if (button.disabled) return;
    button.disabled = true;
    const old = button.textContent;
    button.textContent = '刷新中…';
    try { await refreshSubscriptions(true); }
    finally { button.disabled = false; button.textContent = old; renderAutoSettings(); }
  };
  [['setScale', 'scale', 'setScaleOut', value => value + '%'], ['setLh', 'lh', 'setLhOut', value => Number(value).toFixed(2)],
    ['setWidth', 'width', 'setWidthOut', value => value + ' px'], ['setGap', 'gap', 'setGapOut', value => value + ' px'],
    ['setPending', 'pending', 'setPendingOut', value => value + '%']].forEach(([id, key, outId, label]) => {
    const input = $(id);
    input.addEventListener('input', event => {
      reader[key] = Number(event.target.value);
      applyReader();
      $(outId).textContent = label(event.target.value);
    });
  });
  $('corsSave').onclick = () => {
    const value = $('corsProxy').value.trim();
    if (value) localStorage.setItem('myt-cors-proxy', value);
    else localStorage.removeItem('myt-cors-proxy');
    showToast(value ? '已保存 CORS 代理。' : '已清除 CORS 代理。');
  };
  if ($('pluginOpenDir')) $('pluginOpenDir').onclick = async () => {
    try { await host().pluginOpenDir(); }
    catch (err) { showToast('打开失败：' + ((err && err.message) || err), 5000); }
  };
  if ($('pluginReload')) $('pluginReload').onclick = async () => {
    try {
      await reloadPlugins();
      showToast('插件已重新加载', 3000);
    } catch (err) {
      showToast('重新加载失败：' + ((err && err.message) || err), 5000);
    }
  };
  if ($('pluginExample')) $('pluginExample').onclick = async () => {
    try {
      const dir = await host().pluginExample();
      showToast('示例插件已生成：' + dir + '，点「重新加载」后生效。', 7000);
      await refreshPluginSettings();
    } catch (err) { showToast('生成失败：' + ((err && err.message) || err), 6000); }
  };
  document.addEventListener('click', event => {
    const link = event.target.closest('[data-plugin-page]');
    if (!link) return;
    const raw = String(link.dataset.pluginPage || '');
    const at = raw.indexOf(':');
    if (at < 0) return;
    navigate('plugin', [raw.slice(0, at), raw.slice(at + 1)]);
  });
  document.addEventListener('click', async event => {
    const revoke = event.target.closest('[data-plugin-revoke]');
    if (revoke) {
      clearPluginConsent(revoke.dataset.pluginRevoke);
      await refreshPluginSettings();
      showToast('已撤销授权，下次加载会重新询问。', 4000);
      return;
    }
    const el = event.target.closest('[data-plugin-toggle]');
    if (!el) return;
    const id = el.dataset.pluginToggle;
    const on = el.getAttribute('aria-checked') === 'true';
    el.disabled = true;
    try {
      await host().pluginSetEnabled(id, !on);
      el.setAttribute('aria-checked', String(!on));
      await refreshPluginSettings();
      showToast('已' + (!on ? '启用' : '停用') + ' ' + id + '，点「重新加载」生效。', 5000);
    } catch (err) {
      showToast('切换失败：' + ((err && err.message) || err), 6000);
    } finally {
      el.disabled = false;
    }
  });
  $('dataExport').onclick = () => {
    const data = {
      exported_at: new Date().toISOString(), subs: app.subs, progress: readAllProgress(),
      queue: app.queue, bookmarks: app.bookmarks, notes: app.notes,
      favorites: [...app.favorites], played: app.played, inbox: app.inbox, auto: app.auto, showPrefs: app.showPrefs,
      theme: localStorage.getItem('myt-theme'), reader, prefs, customTheme: readCustomTheme(),
    };
    downloadFile('mytranscript-data.json', JSON.stringify(data, null, 2), 'application/json;charset=utf-8');
    showToast('已导出本地数据。');
  };
  $('dataImportBtn').onclick = () => $('dataImportFile').click();
  $('dataImportFile').onchange = async event => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data !== 'object') throw new Error('不是有效的 MyTranscript 数据文件');
      const mergeBy = (list, incoming, keyFn) => {
        const map = new Map((list || []).map(item => [keyFn(item), item]));
        (incoming || []).forEach(item => { const key = keyFn(item); if (key) map.set(key, item); });
        return [...map.values()];
      };
      app.subs = mergeBy(app.subs, data.subs, item => item.key);
      const progress = readAllProgress();
      Object.entries(data.progress || {}).forEach(([key, rec]) => {
        if (!progress[key] || Number(rec.at) > Number(progress[key].at || 0)) progress[key] = rec;
      });
      writeProgressAll(progress);
      app.queue = mergeBy(app.queue, data.queue, item => String(item.key) + ':' + String(item.ep));
      app.bookmarks = mergeBy(app.bookmarks, data.bookmarks, item => item.id || String(item.key) + ':' + String(item.t));
      app.notes = mergeBy(app.notes, data.notes, item => item.id || String(item.at) + ':' + String(item.title));
      (data.favorites || []).forEach(key => app.favorites.add(key));
      Object.assign(app.played, data.played || {});
      app.inbox = mergeBy(app.inbox, data.inbox, item => item.key);
      app.auto = Object.assign({}, app.auto, data.auto || {});
      app.showPrefs = Object.assign({}, app.showPrefs, data.showPrefs || {});
      if (data.prefs && typeof data.prefs === 'object') prefs = Object.assign({}, prefs, data.prefs);
      if (data.customTheme && typeof data.customTheme === 'object') {
        const cfg = {
          css: String(data.customTheme.css || ''),
          html: String(data.customTheme.html || ''),
          enabled: !!data.customTheme.enabled,
          updatedAt: Date.now(),
        };
        writeCustomTheme(cfg);
        applyCustomTheme(cfg);
        syncCustomThemeEditor();
      }
      saveQueue(); saveFavorites(); savePlayed(); saveInbox(); saveAuto(); saveShowPrefs(); savePrefs(); saveSubs();
      writeJSON(BOOKMARK_KEY, app.bookmarks);
      writeJSON(NOTE_KEY, app.notes);
      loadLocalState();
      refreshShows();
      startAutoRefresh();
      renderAfterStateChange();
      showToast('同步完成：订阅 ' + app.subs.length + ' 个，进度 ' + Object.keys(progress).length + ' 条。', 6000);
    } catch (err) {
      showToast('同步失败：' + (err && err.message ? err.message : err), 'warn');
    }
  };
  $('asrImportBtn').onclick = () => importAsrModel();
  $('localImportBtn').onclick = () => importLocalFolder();
  $('localClearBtn').onclick = () => {
    if (!app.local.length) return;
    if (!confirm('清空本地文件列表？不会删除磁盘上的文件。')) return;
    app.local = [];
    writeJSON(LOCAL_KEY, app.local);
    refreshShows();
    renderLocal();
  };
  $('dataClear').onclick = () => {
    if (!confirm('清除本机的订阅、进度、书签、笔记与设置？此操作不可撤销。')) return;
    Object.keys(localStorage).filter(key => key.startsWith('myt-')).forEach(key => localStorage.removeItem(key));
    location.reload();
  };
  $('queueClearBtn').onclick = () => { if (app.queue.length && confirm('清空播放队列？')) { app.queue = []; saveQueue(); renderQueue(); } };
  $('historyClearBtn').onclick = () => { if (confirm('清除全部收听历史？')) { localStorage.removeItem(PROGRESS_KEY); progressAllCache = null; renderHistory(); showToast('已清除收听历史。'); } };
  $('noteSave').onclick = () => {
    const title = $('noteTitle').value.trim();
    const body = $('noteBody').value.trim();
    if (!title || !body) { showToast('请填写标题和内容。'); return; }
    const key = $('noteShow').value;
    const show = key ? showByKey(key) : null;
    app.notes.unshift({
      id: 'n' + Date.now() + hash32(title), title, body, show: show?.name || '', key,
      t: key && key === state.show?.slug ? Math.round(audio.currentTime || 0) : 0, at: Date.now(),
    });
    writeJSON(NOTE_KEY, app.notes);
    $('noteTitle').value = ''; $('noteBody').value = '';
    renderNotes(); showToast('笔记已保存。');
  };

  $('readerBack').onclick = () => navigate(app.lastPage || 'home');
  if ($('clipNowBtn')) $('clipNowBtn').onclick = () => clipNow(15);
  $('readerInfoBtn').onclick = () => openDetails();
  $('readerBookmarkBtn').onclick = toggleBookmarkCue;
  $('floatBtn').onclick = () => {
    const host = tauriHost();
    if (!(host && host.core)) { $('floatBtn').hidden = true; return; }
    closeDockSheet(false);
    try { host.core.invoke('open_mini'); } catch (e) { showToast('悬浮窗打开失败：' + (e && e.message ? e.message : e), 5000); }
  };
  if (!(tauriHost() && tauriHost().core)) $('floatBtn').hidden = true;
  $('chapterBtn').onclick = e => { e.stopPropagation(); closeDockSheet(false); toggleChapterSheet(); };
  $('wordClose').onclick = closeWordPanel;
  $('miniPlay').onclick = () => $('play').click();
  $('miniPrev').onclick = () => stepEpisode(-1);
  $('miniNext').onclick = () => stepEpisode(1);
  $('miniOpen').onclick = () => navigate('player', [state.show?.slug || '', state.current?.id || '']);
  $('miniCover').onclick = () => navigate('player', [state.show?.slug || '', state.current?.id || '']);
  $('miniExpand').onclick = () => toggleMiniCaption();

  // 面板/浮层的「点空白关掉」
  document.addEventListener('click', e => {
    const sheet = $('chapterSheet');
    if (sheet && sheet.classList.contains('on') && !e.target.closest('#chapterSheet,#chapterBtn')) toggleChapterSheet(false);
    const wp = $('wordPanel');
    if (wp && wp.classList.contains('on') && !e.target.closest('#wordPanel,.word')) closeWordPanel();
  }, true);

  // 离线下载进度（壳里由 offline_save 推 myt://offline）
  if (tauriHost() && tauriHost().event) {
    tauriHost().event.listen('myt://offline', e => {
      const p = (e && e.payload) || {};
      if (p.done) {
        refreshOffline();
        showToast('下载完成：' + (offlineLabel(p.key) || p.key));
      } else if (typeof p.pct === 'number' && p.pct > 0 && p.pct < 100 && p.pct % 25 === 0) {
        showToast('下载 ' + p.pct + '%：' + (offlineLabel(p.key) || p.key), 2000);
      }
    }).catch(() => {});
    // 识别模型的下载/导入/删除进度（壳里推 myt://asr-model）
    tauriHost().event.listen('myt://asr-model', e => {
      const p = (e && e.payload) || {};
      const statusEl = $('asrModelStatus');
      if (p.removed) {
        refreshAsrModels();
        if (statusEl) statusEl.textContent = '已删除模型：' + (p.name || p.id);
        return;
      }
      if (p.cancelled) {
        app.asrBusy.delete(p.id);
        refreshAsrModels();
        if (statusEl) statusEl.textContent = '已取消下载：' + (p.name || p.id) + '（进度已保留）';
        return;
      }
      if (p.done) {
        app.asrBusy.delete(p.id);
        refreshAsrModels();
        if (statusEl) statusEl.textContent = '模型就绪：' + (p.name || p.id);
        return;
      }
      if (p.importing) {
        if (statusEl) statusEl.textContent = '正在导入「' + (p.name || p.id) + '」…';
        return;
      }
      if (typeof p.pct === 'number') {
        app.asrBusy.set(p.id, { pct: p.pct, got: p.got || 0, total: p.total || 0 });
        paintAsrSoon();
        if (statusEl) {
          statusEl.textContent = '正在下载 ' + (p.name || p.id) + '：' + p.pct + '%' +
            (p.total ? '（' + fmtBytes(p.total) + '）' : '');
        }
      }
    }).catch(() => {});
  }
  if ($('downloadsRefresh')) $('downloadsRefresh').onclick = () => refreshOffline();
  if ($('downloadsFilter')) $('downloadsFilter').oninput = () => renderDownloads();
  refreshOffline();
  refreshAsrModels();
  audio.addEventListener('timeupdate', () => {
    syncMini(); syncBookmarkBtn();
    const now = Date.now();
    if (now - (app.pluginLastTime || 0) >= 1000) {
      app.pluginLastTime = now;
      emitPlugin('player:time', pluginPlayerState());
    }
  });
  audio.addEventListener('play', () => { syncMini(); emitPlugin('player:play', pluginPlayerState()); });
  audio.addEventListener('pause', () => { syncMini(); emitPlugin('player:pause', pluginPlayerState()); });
  audio.addEventListener('ended', () => {
    emitPlugin('player:ended', pluginPlayerState());
    if (app.sleepEnd) { app.sleepEnd = false; saveSleep(); syncDockSleep(); showToast('本集结束，睡眠定时已暂停。'); return; }
    if (app.cont !== 'single') {
      playNextAuto(app.cont === 'radio');
    }
  });
  function upgradeArrowGroup(container, selector, activate) {
    if (!container) return;
    const items = () => [...container.querySelectorAll(selector)];
    const sync = () => items().forEach(button => {
      const on = button.classList.contains('on') || button.getAttribute('aria-selected') === 'true';
      button.tabIndex = on ? 0 : -1;
    });
    container.addEventListener('click', event => {
      if (event.target.closest(selector)) setTimeout(sync, 0);
    });
    container.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      const list = items();
      const index = list.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
      const next = list[(index + delta + list.length) % list.length];
      next.focus();
      if (activate) next.click();
    });
    sync();
  }
  upgradeArrowGroup($('modeSeg'), 'button', true);
  upgradeArrowGroup($('langSeg'), 'button', true);
  upgradeArrowGroup($('rateSeg'), 'button[data-rate]', false);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('themePop').classList.contains('on')) { closeThemePop(); $('themeTopBtn').focus(); return; }
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('[role="link"][data-open-episode],[role="link"][data-open-podcast],[role="link"][data-resume],[role="link"][data-play-episode],[role="link"][data-online-detail]');
    if (!row || event.target !== row) return;
    event.preventDefault();
    row.click();
  });
  const onlineSearchInput = $('onlineSearchInput');
  $('onlineSearchBtn').onclick = () => runOnlineSearch(onlineSearchInput.value);
  onlineSearchInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') runOnlineSearch(event.target.value);
  });
  syncThemeSwatches();
}

initPlayer();
/* ============================================================
   扩展模块（2026-11 功能批次）
   1) 磁盘缓存：整集分析优先读预生成结果（data 分支 <stem>.ai.json）
   2) 点词即查：本集例句 / AI 查词 / 入生词本 / 朗读
   3) 听力练习：多空填空 / 盲听听写 / 慢速朗读
   4) 前情卡：按整集摘要生成人物、线索、呼应
   5) 学习计划：今日计划 + Anki 导出
   6) 跨集主题时间线：按关键字串起已缓存单集的主题
   ============================================================ */
(function () {
  'use strict';

  var XAI_VERSION = 3;
  var XAI_PROMPT = 'ads-v1';
  var diskPending = {};
  var diskMissed = {};

  function say(msg, ms) { try { showToast(msg, ms || 2600); } catch (e) {} }
  function store(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveStore(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function curEpId() { return state && state.current ? String(state.current.id) : ''; }
  function epCacheKey(id) { return 'ep:' + (id || curEpId()); }
  function hasCache(id) {
    var c = studyCache[epCacheKey(id)];
    return !!(c && c.data && typeof c.data === 'object');
  }

  /* ---------- 1. 磁盘缓存 ---------- */
  function aiUrls() {
    var out = [];
    var t = String((state.current && state.current.transcript && state.current.transcript.url) || '');
    if (t) {
      if (/^https?:/i.test(t)) {
        out.push(t.replace(/\.json(\?.*)?$/i, '.ai.json$1'));
      }
      try {
        var u = new URL(t, location.href);
        var p = u.pathname.replace(/\.json$/i, '');
        out.push(u.origin + p + '.ai.json');
      } catch (e) {}
    }
    var base = state.show && state.show.feed ? String(state.show.feed).replace(/feed\.xml$/i, '') : '';
    if (t && base) {
      try {
        var seg = decodeURIComponent(new URL(t, location.href).pathname.split('/').pop() || '');
        seg = seg.replace(/\.json$/i, '.ai.json');
        if (seg) out.push(base + 'ai/' + encodeURIComponent(seg));
      } catch (e) {}
    }
    var uniq = [];
    out.forEach(function (x) { if (x && uniq.indexOf(x) < 0) uniq.push(x); });
    return uniq;
  }

  async function loadDisk(id) {
    if (hasCache(id)) return true;
    var urls = aiUrls();
    for (var i = 0; i < urls.length; i++) {
      var doc = await getJson(urls[i], 15000);
      if (!doc || typeof doc !== 'object') continue;
      if (Number(doc.version) !== XAI_VERSION || !doc.data || typeof doc.data !== 'object') continue;
      var data = {};
      for (var k in doc.data) {
        if (Object.prototype.hasOwnProperty.call(doc.data, k)) data[k] = doc.data[k];
      }
      data.version = XAI_VERSION;
      studyCache[epCacheKey(id)] = {
        at: Date.now(), data: data, source: 'disk',
        model: String(doc.model || ''), prompt: String(doc.prompt || XAI_PROMPT),
        generatedAt: String(doc.generated_at || '')
      };
      saveStudyCache();
      return true;
    }
    return false;
  }

  function ensureDisk(id) {
    if (!id || hasCache(id) || diskPending[id] || diskMissed[id]) return;
    diskPending[id] = true;
    loadDisk(id).then(function (hit) {
      delete diskPending[id];
      if (!hit) { diskMissed[id] = true; xaiRefreshBadge(); return; }
      if (state.current && String(state.current.id) === String(id) && studyView === 'episode') studyRenderEpisode();
      else xaiRefreshBadge();
    }).catch(function () {
      delete diskPending[id];
      diskMissed[id] = true;
      xaiRefreshBadge();
    });
  }

  function shortStamp(text) {
    var s = String(text || '');
    if (!s) return '';
    var d = new Date(s);
    if (isNaN(d.getTime())) return s.slice(0, 10);
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  }

  function xaiRefreshBadge() {
    var el = document.getElementById('xaiCacheBadge');
    if (!el) return;
    var id = curEpId();
    var c = studyCache[epCacheKey(id)];
    if (c && c.data) {
      el.textContent = c.source === 'disk'
        ? '磁盘缓存' + (c.generatedAt ? ' · ' + shortStamp(c.generatedAt) : '')
        : '本地缓存';
      return;
    }
    if (diskPending[id]) { el.textContent = '正在查磁盘缓存…'; return; }
    if (diskMissed[id]) { el.textContent = '缓存未命中（首次需要现场生成）'; return; }
    el.textContent = '准备读取缓存';
  }

  var origRenderEpisode = studyRenderEpisode;
  studyRenderEpisode = function () {
    var id = curEpId();
    if (id && !hasCache(id)) ensureDisk(id);
    var r = origRenderEpisode.apply(this, arguments);
    var body = document.getElementById('studyBody');
    if (body && studyView === 'episode' && state.current) {
      var row = document.createElement('div');
      row.className = 'study-actions';
      row.id = 'xaiCacheRow';
      row.innerHTML = '<span class="study-badge" id="xaiCacheBadge"></span>';
      body.insertBefore(row, body.firstChild);
      xaiRefreshBadge();
      // 没生成过整集摘要时 studyEpisodeHTML 不会被调用，前情/时间线就会消失。
      // 这里补挂一次，保证首次使用也能看到这两块。
      if (!document.getElementById('xaiRecapBox')) {
        var extra = document.createElement('div');
        extra.id = 'xaiExtraWrap';
        extra.innerHTML = '<div class="study-section"><h4>前情回顾</h4><div id="xaiRecapBox">' + recapHTML() + '</div></div>' +
          '<div class="study-section"><h4>跨集主题时间线</h4>' +
          '<div class="study-actions"><input class="study-input" id="xaiTlInput" placeholder="关键词，如某个人名或话题" style="max-width:220px">' +
          '<button class="btn ghost small" data-xai-tl-go="1">搜索</button></div>' +
          '<div id="xaiTlBox">' + timelineHTML([], '') + '</div></div>';
        body.appendChild(extra);
      }
    }
    bindEpisodeExtras();
    return r;
  };

  /* ---------- 2. 点词即查 ---------- */
  var wordAiStore = store('myt-word-ai');

  function wordCues(word, limit) {
    var q = cleanWord(word).toLowerCase();
    if (!q) return [];
    var hits = [];
    (state.cues || []).forEach(function (c) {
      var t = String(c.text || '').toLowerCase();
      if (t.indexOf(q) >= 0) hits.push(c);
    });
    return hits.slice(0, limit || 3);
  }

  function speak(text) {
    try {
      if (!window.speechSynthesis) { say('当前环境不支持朗读。'); return; }
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(String(text || ''));
      u.lang = 'en-US';
      u.rate = 0.9;
      window.speechSynthesis.speak(u);
    } catch (e) { say('朗读失败。'); }
  }

  async function wordAi(word) {
    var box = document.getElementById('xaiWordAiBox');
    if (!box) return;
    if (wordAiStore[word.toLowerCase()]) { renderWordAi(box, wordAiStore[word.toLowerCase()]); return; }
    if (!studyReady()) { box.innerHTML = '<div class="word-note">先在「设置 → AI 学英语」配好 Key 和模型。</div>'; return; }
    box.innerHTML = '<div class="word-note">AI 正在查这个词…</div>';
    var system = 'You are a bilingual dictionary for Chinese learners. Return ONLY a JSON object, no markdown fences, ' +
      'with keys: phonetic (IPA wrapped in slashes), meaning (Chinese definition, <=40 characters), ' +
      'senses (array of {pos, zh}), example (one English sentence using the word), exampleZh (its Chinese translation), ' +
      'collocations (array of up to 3 short English collocations). Use the given podcast context when it helps.';
    var user = JSON.stringify({
      word: word,
      context: (wordCues(word, 1)[0] || {}).text || '',
      show: state.show && state.show.name, episode: state.current && state.current.title
    });
    try {
      var out = await studyChat(system, user);
      var d = studyParseJson(out);
      if (!d || d.raw) throw new Error(String((d && d.raw) || '返回格式不对'));
      wordAiStore[word.toLowerCase()] = d;
      saveStore('myt-word-ai', wordAiStore);
      renderWordAi(box, d);
    } catch (err) {
      box.innerHTML = '<div class="word-note">AI 查词失败：' + esc(err.message || err) + '</div>';
    }
  }

  function renderWordAi(box, d) {
    var senses = (d.senses || []).map(function (s) { return '<b>' + esc(s.pos || '') + '</b> ' + esc(s.zh || ''); }).join('<br>');
    box.innerHTML = '<div class="word-sense">' + esc(d.meaning || '') +
      (senses ? '<br><small>' + senses + '</small>' : '') +
      (d.example ? '<br><small>例：' + esc(d.example) + (d.exampleZh ? '<br>' + esc(d.exampleZh) : '') + '</small>' : '') +
      ((d.collocations || []).length ? '<br><small>搭配：' + esc(d.collocations.join(' / ')) + '</small>' : '') +
      '</div>';
    if (d.phonetic) {
      var phon = document.getElementById('wordPhon');
      if (phon && !phon.textContent) phon.textContent = d.phonetic;
    }
  }

  function attachWordExtra(word, failed) {
    var body = document.getElementById('wordBody');
    if (!body) return;
    var old = document.getElementById('xaiWordExtra');
    if (old) old.parentNode.removeChild(old);
    var cues = wordCues(word, 3);
    var wrap = document.createElement('div');
    wrap.id = 'xaiWordExtra';
    var html = '';
    if (failed) html += '<div class="word-note">词典源没返回结果，可以用 AI 查。</div>';
    if (cues.length) {
      html += '<div class="word-note">本集出现 ' + cues.length + ' 处：</div>';
      cues.forEach(function (c, i) {
        html += '<button class="btn ghost small" data-xai-cue="' + i + '">▶ ' + fmt(Number(c.start) + (state.offset || 0)) +
          ' ' + esc(String(c.text || '').slice(0, 26)) + '</button> ';
      });
    }
    html += '<div class="study-actions">' +
      '<button class="btn ghost small" data-xai-word="add">＋ 生词本</button>' +
      '<button class="btn ghost small" data-xai-word="say">朗读</button>' +
      '<button class="btn ghost small" data-xai-word="ai">AI 查这个词</button></div>' +
      '<div id="xaiWordAiBox"></div>';
    wrap.innerHTML = html;
    body.appendChild(wrap);
    var cached = wordAiStore[String(word).toLowerCase()];
    if (cached) renderWordAi(document.getElementById('xaiWordAiBox'), cached);
    wrap.querySelectorAll('[data-xai-cue]').forEach(function (btn) {
      btn.onclick = function () {
        var c = cues[Number(btn.dataset.xaiCue)];
        if (!c) return;
        var s = Number(c.speechStart != null ? c.speechStart : c.start) + (state.offset || 0);
        var e = Number(c.speechEnd != null ? c.speechEnd : c.end) + (state.offset || 0);
        seekTo(s);
        if (Number.isFinite(e) && e > s) { audio.play(); }
      };
    });
    wrap.querySelectorAll('[data-xai-word]').forEach(function (btn) {
      btn.onclick = function () {
        var act = btn.dataset.xaiWord;
        if (act === 'add') {
          studyAddVocab({
            word: word,
            phonetic: (document.getElementById('wordPhon') || {}).textContent || '',
            meaning: wordCurrentMeaning || '', example: cues[0] ? String(cues[0].text || '') : ''
          }, cues[0] || null);
          btn.textContent = '✓ 已加入';
          btn.disabled = true;
        } else if (act === 'say') {
          speak(word);
        } else if (act === 'ai') {
          wordAi(word);
        }
      };
    });
  }

  /* ---------- 3. 听力练习 ---------- */
  var STOP = ('a an the and or but if of to in on at for with from by is am are was were be been being it its this that ' +
    'these those i you he she we they me him her us them my your his our their not no do did does have has had so as ' +
    'just like well yeah okay oh').split(' ');
  var drill = null;

  function drillWords(cue) {
    var out = [];
    (cue.words || []).forEach(function (w) {
      var t = String(w.t || w[0] || '');
      if (!/^[A-Za-z][A-Za-z'’-]*$/.test(t)) return;
      var low = t.toLowerCase();
      if (STOP.indexOf(low) >= 0 || t.length < 4) return;
      if (out.indexOf(t) < 0) out.push(t);
    });
    if (out.length <= 2) {
      String(cue.text || '').split(/\s+/).forEach(function (t) {
        var clean = t.replace(/[^A-Za-z'’-]/g, '');
        if (clean.length >= 4 && STOP.indexOf(clean.toLowerCase()) < 0 && out.indexOf(clean) < 0) out.push(clean);
      });
    }
    return out;
  }

  function openDrill(kind) {
    var cur = studyCurrentCue();
    if (!cur) { say('这一集没有可用文字稿。'); return; }
    var cue = cur.cue;
    var sentence = String(cue.text || '');
    if (kind === 'multi') {
      var words = drillWords(cue).sort(function (a, b) { return b.length - a.length; }).slice(0, 3);
      if (!words.length) { say('这一句没有合适的空。'); return; }
      var blanks = words.map(function (w) {
        var idx = sentence.toLowerCase().indexOf(w.toLowerCase());
        return { word: w, at: idx };
      }).filter(function (b) { return b.at >= 0; });
      var masked = sentence;
      blanks.slice().sort(function (a, b) { return b.at - a.at; }).forEach(function (b) {
        masked = masked.slice(0, b.at) + '____' + masked.slice(b.at + b.word.length);
      });
      drill = { kind: 'multi', cue: cue, sentence: masked, blanks: blanks.map(function (b) { return b.word; }), input: '', checked: false, pct: 0 };
    } else if (kind === 'blind') {
      drill = { kind: 'blind', cue: cue, answer: sentence, input: '', checked: false, pct: 0 };
    } else if (kind === 'slow') {
      drill = { kind: 'slow', cue: cue, answer: sentence };
      speakSlow(sentence);
    }
    renderDrill();
  }

  function speakSlow(text) {
    try {
      if (!window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(String(text || ''));
      u.lang = 'en-US';
      u.rate = 0.72;
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }

  function renderDrill() {
    var body = document.getElementById('studyBody');
    if (!body || !drill) return;
    var d = drill;
    var head = '<div class="study-actions">' +
      '<span class="study-badge">' + (d.kind === 'multi' ? '多空填空' : d.kind === 'blind' ? '盲听听写' : '慢速朗读') + '</span>' +
      '<button class="btn ghost small" data-xai-drill="play">▶ 听本句</button>' +
      (d.kind === 'slow' ? '<button class="btn ghost small" data-xai-drill="slow">慢速再读</button>' : '') +
      '<button class="btn ghost small" data-xai-drill="back">返回练习</button></div>';
    var html = head;
    if (d.kind === 'multi') {
      html += '<p class="study-cue">' + esc(d.sentence) + '</p>' +
        '<input class="study-input" id="xaiDrillInput" placeholder="按顺序填 ' + d.blanks.length + ' 个空，用空格隔开" value="' + esc(d.input) + '">';
    } else if (d.kind === 'blind') {
      html += '<p class="study-empty">先听原句（可重复），再把你听到的整句写下来。</p>' +
        '<input class="study-input" id="xaiDrillInput" placeholder="写下你听到的句子" value="' + esc(d.input) + '">';
    } else {
      html += '<p class="study-cue">' + esc(d.answer) + '</p><p class="study-empty">已用 0.72 倍速朗读，可以跟着读两遍。</p>';
    }
    if (d.kind !== 'slow') {
      html += '<div class="study-actions"><button class="btn primary small" data-xai-drill="check">检查</button>' +
        '<button class="btn ghost small" data-xai-drill="show">看答案</button></div>';
    }
    if (d.checked) {
      var ok = d.pct >= 90;
      html += '<div class="study-answer"><div class="' + (ok ? 'study-ok' : 'study-bad') + '">正确率 ' + d.pct + '%</div>' +
        '<div style="margin-top:6px">答案：' + esc(d.kind === 'multi' ? d.blanks.join(' / ') : d.answer) + '</div>' +
        (d.kind === 'blind' && d.diff ? '<div style="margin-top:8px;line-height:1.9">' + d.diff + '</div>' : '') + '</div>';
    }
    body.innerHTML = html;
    var input = document.getElementById('xaiDrillInput');
    if (input) {
      input.oninput = function () { drill.input = input.value; };
      input.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); checkDrill(); } };
      input.focus();
    }
    body.querySelectorAll('[data-xai-drill]').forEach(function (btn) {
      btn.onclick = function () {
        var act = btn.dataset.xaiDrill;
        if (act === 'play') { var b = studyCueBounds(d.cue); studyPlayRange(b.start, b.end, 1); }
        else if (act === 'slow') { speakSlow(d.answer); }
        else if (act === 'back') { drill = null; studyRenderPractice(); }
        else if (act === 'check') { checkDrill(); }
        else if (act === 'show') {
          var box = document.createElement('div');
          box.className = 'study-answer';
          box.innerHTML = '<div style="margin-top:6px">答案：' + esc(d.kind === 'multi' ? d.blanks.join(' / ') : d.answer) + '</div>';
          body.appendChild(box);
        }
      };
    });
  }

  function checkDrill() {
    if (!drill) return;
    var d = drill;
    var input = document.getElementById('xaiDrillInput');
    if (input) d.input = input.value;
    if (d.kind === 'multi') {
      var parts = String(d.input || '').trim().split(/\s+/).filter(Boolean);
      var hit = 0;
      d.blanks.forEach(function (w, i) {
        if (parts[i] && studyNormText(parts[i]) === studyNormText(w)) { hit++; d.blanksHit = (d.blanksHit || []); }
      });
      d.pct = d.blanks.length ? Math.round(hit / d.blanks.length * 100) : 0;
      d.checked = true;
      if (d.pct < 100) d.blanks.forEach(function (w) { studyMarkWord(w, 'learning'); });
    } else {
      var a = studyNormText(d.input).split(' ').filter(Boolean);
      var b = studyNormText(d.answer).split(' ').filter(Boolean);
      var hits = 0;
      for (var i = 0; i < b.length; i++) { if (a[i] === b[i]) hits++; }
      d.pct = b.length ? Math.round(hits / b.length * 100) : 0;
      d.diff = b.map(function (w, i) {
        var good = a[i] === w;
        return '<span style="color:' + (good ? 'inherit' : '#c0392b') + ';text-decoration:' + (good ? 'none' : 'underline') + '">' + esc(w) + '</span>';
      }).join(' ');
      d.checked = true;
    }
    renderDrill();
  }

  var origPractice = studyRenderPractice;
  studyRenderPractice = function () {
    var r = origPractice.apply(this, arguments);
    var body = document.getElementById('studyBody');
    if (body && !document.getElementById('xaiDrillRow') && body.querySelector('[data-study-ex]') && !document.getElementById('studyPracticeInput')) {
      var row = document.createElement('div');
      row.className = 'study-actions';
      row.id = 'xaiDrillRow';
      row.innerHTML = '<button class="btn ghost small" data-xai-open="multi">多空填空</button>' +
        '<button class="btn ghost small" data-xai-open="blind">盲听听写</button>' +
        '<button class="btn ghost small" data-xai-open="slow">慢速朗读</button>';
      body.insertBefore(row, body.firstChild);
      row.querySelectorAll('[data-xai-open]').forEach(function (btn) {
        btn.onclick = function () { openDrill(btn.dataset.xaiOpen); };
      });
    }
    return r;
  };

  /* ---------- 4. 前情卡 ---------- */
  var recapStore = store('myt-ai-recap');
  var recapBusy = false;

  function recapKeyOf() { return String((state.show && state.show.slug) || '') + '|' + curEpId(); }

  function recapHTML() {
    var item = recapStore[recapKeyOf()];
    if (!item || !item.data) {
      return '<p class="study-empty">用当前整集摘要生成人物、线索和前后呼应；结果会缓存，换集再回来不用重新生成。</p>' +
        '<div class="study-actions"><button class="btn ghost small" data-xai-recap="gen">生成前情回顾</button></div>';
    }
    var d = item.data;
    var html = '<p>' + esc(d.recap || '') + '</p>';
    if ((d.characters || []).length) {
      html += '<div class="study-vocab"' + '' + '><strong>人物</strong>';
      html += (d.characters || []).map(function (c) {
        return '<small><b>' + esc(c.name || '') + '</b>' + (c.role ? '（' + esc(c.role) + '）' : '') + ' ' + esc(c.note || '') + '</small>';
      }).join('');
      html += '</div>';
    }
    if ((d.threads || []).length) {
      html += '<div class="study-vocab"><strong>线索</strong>' + (d.threads || []).map(function (t) {
        return '<small><b>' + esc(t.title || '') + '</b> ' + esc(t.detail || '') + '</small>';
      }).join('') + '</div>';
    }
    if ((d.callbacks || []).length) {
      html += '<div class="study-vocab"><strong>前后呼应</strong>' + (d.callbacks || []).map(function (c) {
        return '<small>' + esc(c.when || '') + ' ' + esc(c.text || '') + '</small>';
      }).join('') + '</div>';
    }
    html += '<div class="study-actions"><button class="btn ghost small" data-xai-recap="gen">重新生成</button>' +
      '<span class="study-badge">' + shortStamp(new Date(item.at).toISOString()) + '</span></div>';
    return html;
  }

  async function genRecap() {
    if (recapBusy) return;
    var box = document.getElementById('xaiRecapBox');
    if (!box) return;
    if (!studyReady()) { box.innerHTML = '<p class="study-empty">先在「设置 → AI 学英语」配好 Key 和模型。</p>'; return; }
    var data = (studyCache[epCacheKey()] || {}).data || {};
    if (!data.summary && !(data.topics || []).length) {
      box.innerHTML = '<p class="study-empty">先给这一集生成整集摘要，再生成前情。</p>';
      return;
    }
    recapBusy = true;
    box.innerHTML = '<p class="study-empty">正在整理人物与线索…</p>';
    var system = 'You are a podcast story editor helping a Chinese-speaking listener follow a long-running show. ' +
      'Return ONLY a JSON object, no markdown fences, with keys: recap (string, 2-4 sentences in ' + studyLangName() + '), ' +
      'characters (array of {name, role, note}), threads (array of {title, detail}), callbacks (array of {text, when}). ' +
      'Only use facts present in the provided summary and topics; never invent plot details. ' +
      'If something is unclear, leave the array empty.';
    var user = JSON.stringify({
      show: state.show && state.show.name,
      episode: state.current && state.current.title,
      summary: String(data.summary || '').slice(0, 2200),
      topics: (data.topics || []).slice(0, 12),
      keyPoints: (data.keyPoints || []).slice(0, 8)
    });
    try {
      var out = await studyChat(system, user);
      var d = studyParseJson(out);
      if (!d || d.raw || !d.recap) throw new Error(String((d && d.raw) || '返回格式不对'));
      recapStore[recapKeyOf()] = { at: Date.now(), data: d };
      saveStore('myt-ai-recap', recapStore);
      renderRecapBox();
    } catch (err) {
      box.innerHTML = '<p class="study-empty">生成失败：' + esc(err.message || err) + '</p>' +
        '<div class="study-actions"><button class="btn ghost small" data-xai-recap="gen">重试</button></div>';
      bindEpisodeExtras();
    } finally {
      recapBusy = false;
    }
  }

  function renderRecapBox() {
    var box = document.getElementById('xaiRecapBox');
    if (!box) return;
    box.innerHTML = recapHTML();
    bindEpisodeExtras();
  }

  /* ---------- 5. 跨集主题时间线 ---------- */
  var tlResult = [];

  function showEpisodes() {
    if (state.episodes && state.episodes.length) return state.episodes;
    try { return episodesOf(state.show) || []; } catch (e) { return []; }
  }

  function timelineSearch(query) {
    var q = String(query || '').trim().toLowerCase();
    var out = [];
    showEpisodes().forEach(function (ep) {
      var c = studyCache['ep:' + ep.id];
      if (!c || !c.data) return;
      var d = c.data;
      (d.topics || []).forEach(function (t) {
        var blob = (String(t.title || '') + ' ' + String(t.summary || '')).toLowerCase();
        if (q && blob.indexOf(q) < 0) return;
        out.push({
          epId: String(ep.id), epTitle: String(ep.title || ''),
          start: studyClockSeconds(t.start), title: String(t.title || ''),
          detail: String(t.summary || ''), kind: 'topic'
        });
      });
      if (q) {
        var s = String(d.summary || '').toLowerCase();
        if (s.indexOf(q) >= 0) {
          out.push({ epId: String(ep.id), epTitle: String(ep.title || ''), start: null, title: '摘要命中', detail: '', kind: 'summary' });
        }
      }
    });
    out.sort(function (a, b) { return (Number(a.start) || 0) - (Number(b.start) || 0); });
    return out.slice(0, 24);
  }

  function timelineHTML(results, query) {
    if (!results || !results.length) {
      var cached = showEpisodes().filter(function (ep) { return !!studyCache['ep:' + ep.id]; }).length;
      return '<p class="study-empty">本节目已缓存 ' + cached + ' 集。' +
        (cached ? '输入关键词（人物名、话题、地名）再搜一次。' : '还没有任何单集摘要：先跑预生成脚本，或给某集生成整集摘要。') + '</p>';
    }
    return '<div class="study-section">' + results.map(function (r, i) {
      var isCur = r.epId === curEpId();
      var when = Number.isFinite(r.start) ? fmt(r.start) : '—';
      return '<div class="study-topic"><button class="btn ghost small" data-xai-tl="' + i + '">' + when + '</button>' +
        '<div><strong>' + esc(r.title || '') + '</strong>' +
        '<p class="study-empty">' + esc(r.epTitle.slice(0, 42)) + (isCur ? ' · 本集' : '') + '</p></div></div>';
    }).join('') + '</div>';
  }

  function bindTimeline(results) {
    document.querySelectorAll('[data-xai-tl]').forEach(function (btn) {
      btn.onclick = function () {
        var r = results[Number(btn.dataset.xaiTl)];
        if (!r) return;
        if (r.epId !== curEpId()) { say('这条来自另一集：' + r.epTitle.slice(0, 30), 3200); return; }
        if (!Number.isFinite(r.start)) return;
        seekTo(r.start + (state.offset || 0));
        audio.play();
      };
    });
  }

  /* ---------- 6. 整集页扩展区块 ---------- */
  var origEpisodeHTML = studyEpisodeHTML;
  studyEpisodeHTML = function (data) {
    var base = origEpisodeHTML.apply(this, arguments);
    if (!data) return base;
    return base +
      '<div class="study-section"><h4>前情回顾</h4><div id="xaiRecapBox">' + recapHTML() + '</div></div>' +
      '<div class="study-section"><h4>跨集主题时间线</h4>' +
      '<div class="study-actions"><input class="study-input" id="xaiTlInput" placeholder="关键词，如某个人名或话题" style="max-width:220px">' +
      '<button class="btn ghost small" data-xai-tl-go="1">搜索</button></div>' +
      '<div id="xaiTlBox">' + timelineHTML([], '') + '</div></div>';
  };

  function bindEpisodeExtras() {
    document.querySelectorAll('[data-xai-recap]').forEach(function (btn) {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.onclick = genRecap;
    });
    var go = document.querySelector('[data-xai-tl-go]');
    if (go && !go.dataset.bound) {
      go.dataset.bound = '1';
      var run = function () {
        var input = document.getElementById('xaiTlInput');
        var q = input ? input.value : '';
        tlResult = timelineSearch(q);
        var box = document.getElementById('xaiTlBox');
        if (box) box.innerHTML = timelineHTML(tlResult, q);
        bindTimeline(tlResult);
      };
      go.onclick = run;
      var input = document.getElementById('xaiTlInput');
      if (input) input.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); run(); } };
    }
    if (tlResult.length) bindTimeline(tlResult);
  }

  /* ---------- 7. 学习计划与 Anki ---------- */
  function planStats() {
    var st = studyStats();
    var newWords = studyVocab.filter(function (v) { return v.status !== 'known' && v.status !== 'ignored' && !Number(v.reps); });
    var weak = studyVocab.filter(function (v) { return v.status !== 'known' && v.status !== 'ignored' && Number(v.lapses) >= 2; });
    var due = studyDueItems();
    var minutes = Math.round(due.length * 0.6 + Math.min(newWords.length, 5) * 1.4) || 0;
    return { st: st, due: due, fresh: newWords, weak: weak, minutes: minutes };
  }

  function planHTML(expanded) {
    var p = planStats();
    var head = '<div class="study-actions"><span class="study-badge">今日约 ' + p.minutes + ' 分钟</span>' +
      '<span class="study-badge">待复习 ' + p.due.length + '</span>' +
      '<span class="study-badge">新词 ' + p.fresh.length + '</span>' +
      '<span class="study-badge">薄弱 ' + p.weak.length + '</span>' +
      '<button class="btn ghost small" data-xai-plan="build">' + (expanded ? '重新排' : '生成今日计划') + '</button>' +
      '<button class="btn ghost small" data-xai-plan="anki">导出 Anki</button>' +
      '<button class="btn ghost small" data-xai-plan="csv">导出 CSV</button></div>';
    if (!expanded) return '<div class="study-section"><h4>学习计划</h4>' + head + '</div>';
    var steps = [];
    if (p.due.length) {
      steps.push('<b>1. 清复习（' + p.due.length + ' 个）</b><br>' + p.due.slice(0, 6).map(function (v) {
        return esc(v.word) + (v.meaning ? '（' + esc(String(v.meaning).slice(0, 18)) + '）' : '');
      }).join('、') + (p.due.length > 6 ? '…' : ''));
    } else {
      steps.push('<b>1. 复习队列已清空</b><br>可以直接进入下一段。');
    }
    var picks = p.weak.concat(p.fresh).slice(0, 6);
    if (picks.length) {
      steps.push('<b>2. 精练 ' + picks.length + ' 个词</b><br>' + picks.map(function (v) {
        return esc(v.word) + (Number(v.lapses) >= 2 ? '（错得多）' : '（新词）');
      }).join('、'));
    }
    steps.push('<b>3. 听力 3 句</b><br>练习页的「盲听听写」抽 3 句；正确率 < 90% 的句子再听两遍。');
    steps.push('<b>4. 收尾</b><br>回复习页用「记得 / 模糊」给刚练的词定下次时间。');
    return '<div class="study-section"><h4>今日计划</h4>' + head +
      '<div class="study-answer">' + steps.map(function (s) { return '<div style="margin-top:8px">' + s + '</div>'; }).join('') + '</div></div>';
  }

  var planOpen = false;

  function ankiExport() {
    var lines = ['#separator:tab', '#html:false', '#columns:word\tmeaning\texample\tphonetic'];
    var seen = {};
    studyVocab.forEach(function (v) {
      var w = String(v.word || '').trim();
      if (!w || seen[w.toLowerCase()]) return;
      seen[w.toLowerCase()] = 1;
      lines.push([w, String(v.meaning || '').replace(/\t/g, ' '), String(v.example || '').replace(/\t/g, ' '), String(v.phonetic || '')].join('\t'));
    });
    if (lines.length === 3) { say('生词本还是空的。'); return; }
    downloadFile('myt-anki-' + new Date().toISOString().slice(0, 10) + '.txt', lines.join('\n'), 'text/plain;charset=utf-8');
    say('已导出 Anki 文本（' + (lines.length - 3) + ' 个词）。', 3200);
  }

  var origVocab = studyRenderVocab;
  studyRenderVocab = function () {
    var r = origVocab.apply(this, arguments);
    var body = document.getElementById('studyBody');
    if (body) {
      var box = document.createElement('div');
      box.id = 'xaiPlanBox';
      box.innerHTML = planHTML(planOpen);
      body.insertBefore(box, body.firstChild);
      box.querySelectorAll('[data-xai-plan]').forEach(function (btn) {
        btn.onclick = function () {
          var act = btn.dataset.xaiPlan;
          if (act === 'anki') ankiExport();
          else if (act === 'csv') { try { studyExportCsv(); } catch (e) {} }
          else { planOpen = true; var b = document.getElementById('xaiPlanBox'); if (b) { b.innerHTML = planHTML(true); bindPlan(); } }
        };
      });
      bindPlan();
    }
    return r;
  };

  function bindPlan() {
    var box = document.getElementById('xaiPlanBox');
    if (!box) return;
    box.querySelectorAll('[data-xai-plan]').forEach(function (btn) {
      btn.onclick = function () {
        var act = btn.dataset.xaiPlan;
        if (act === 'anki') ankiExport();
        else if (act === 'csv') { try { studyExportCsv(); } catch (e) {} }
        else { planOpen = true; var b = document.getElementById('xaiPlanBox'); if (b) { b.innerHTML = planHTML(true); bindPlan(); } }
      };
    });
  }

  /* ---------- 对外挂接 ---------- */
  window.__xai = {
    version: XAI_VERSION, prompt: XAI_PROMPT,
    aiUrls: aiUrls, loadDisk: loadDisk, hasCache: hasCache,
    wordCues: wordCues, attachWord: attachWordExtra,
    openDrill: openDrill, timelineSearch: timelineSearch, planStats: planStats
  };
})();
/* 左右两栏底边对齐浮动 dock 顶边：dock 高度随内容变化，用实测值而不是固定值 */
(function(){
  var root=document.documentElement, dock=document.querySelector('.dock');
  if(!dock) return;
  function sync(){
    if(document.body.classList.contains('immersive')){ root.style.setProperty('--rail-bottom','16px'); return; }
    var top=dock.getBoundingClientRect().top;
    var v=Math.max(0,Math.round(window.innerHeight-top));
    root.style.setProperty('--rail-bottom',v+'px');
  }
  sync();
  window.addEventListener('resize',sync);
  if(window.ResizeObserver){ new ResizeObserver(sync).observe(dock); }
})();
})();
