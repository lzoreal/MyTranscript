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
/* 只收内置色球：弹层里还有随包的 .sw-pack（data-pack），setTheme 不该去动它们的选中态。 */
const themeBtns = () => [...document.querySelectorAll('.swatch[data-theme]')];
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
/* 内置色板只留午夜蓝/纸张/原型/编辑部；被撤掉的五个色板把老用户的存档迁到最接近的现存色板，
   不然启动时会因为“存档主题不在色板里”被兜底到编辑部。 */
const REMOVED_THEME_FALLBACK = {
  brass: 'midnight', forest: 'midnight', oxblood: 'midnight', celadon: 'ledger', mist: 'paper',
};
/* 随包主题只在第一次种一次；用户自己删掉的卡片不会被重新塞回来。 */
const DEFAULT_PACKS_KEY = 'myt-theme-packs-seeded';
let lastDark = 'midnight', lastLight = 'ledger';
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
    /* 自定义主题的样式注在 head 末尾，选择器与内置主题同权重，靠层叠顺序压过所有内置配色。
       所以用户主动点内置色板时，必须先把自定义主题停用，否则点了看不出任何变化。 */
    const custom = readCustomTheme();
    if (custom.enabled) {
      const next = { ...custom, enabled: false };
      writeCustomTheme(next);
      applyCustomTheme(next);
      renderCustomThemeGrid();
      showToast('已切到内置主题，自定义主题已停用。');
    }
    if (typeof CustomEvent === 'function') {
      document.dispatchEvent(new CustomEvent('myt:theme-change', { detail: { kind: 'builtin', id } }));
    }
  }
  closeThemePop();
}
document.addEventListener('click', e => { const b = e.target.closest('.swatch[data-theme]'); if (b) setTheme(b.dataset.theme); });
document.addEventListener('click', e => {
  const pack = e.target.closest('#themePop [data-pack]');
  if (!pack) return;
  e.preventDefault();
  applyCustomThemePreset('ct-pack-' + pack.dataset.pack);
  closeThemePop();
});
/* 每次打开弹层都重排一次：随包主题要跟着主题卡变，内置色球在自定义主题开着时不能显示选中。 */
const themeTopButton = $('themeTopBtn');
if (themeTopButton) {
  themeTopButton.addEventListener('click', () => {
    const cfg = readCustomTheme();
    renderThemePopPacks();
    if (cfg.enabled) document.querySelectorAll('.swatch[data-theme]').forEach(btn => btn.setAttribute('aria-checked', 'false'));
  });
}
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
  if (savedTheme && REMOVED_THEME_FALLBACK[savedTheme]) {
    savedTheme = REMOVED_THEME_FALLBACK[savedTheme];
    localStorage.setItem('myt-theme', savedTheme);
  }
  /* 编辑部方向首次落地：把旧的浅紫原型一次性迁到暖纸主题，之后用户仍可自由切换。 */
  if (!localStorage.getItem('myt-ui-ledger') && (!savedTheme || savedTheme === 'prototype')) {
    savedTheme = 'ledger';
    localStorage.setItem('myt-theme', 'ledger');
  }
  localStorage.setItem('myt-ui-ledger', '1');
  setTheme(savedTheme && themeBtns().some(b => b.dataset.theme === savedTheme) ? savedTheme : 'ledger', false);
} catch (e) { setTheme('ledger', false); }

/* ---------- 自定义主题（CSS / HTML + 卡片） ----------
   一套配置加多张“卡片”：每张卡片记一份 CSS/HTML 快照，点卡即应用；
   旧数据只有 {css,html,enabled}，读入时补 presets: []，不丢已有内容。 */
function normalizeCustomTheme(raw) {
  const base = raw && typeof raw === 'object' ? raw : {};
  const presets = Array.isArray(base.presets) ? base.presets
    .filter(item => item && typeof item.id === 'string' && item.id.trim())
    .map(item => {
      const id = String(item.id);
      return {
        id,
        name: String(item.name || '自定义主题'),
        css: typeof item.css === 'string' ? item.css : '',
        html: typeof item.html === 'string' ? item.html : '',
        createdAt: Number(item.createdAt) || 0,
        /* 随包主题（ct-pack-<slug>）是默认主题，删不掉；老数据没有这个字段，靠 id 兜底识别。 */
        builtin: !!item.builtin || id.startsWith('ct-pack-'),
      };
    }) : [];
  const activeId = presets.some(item => item.id === base.activeId) ? String(base.activeId) : '';
  return {
    css: typeof base.css === 'string' ? base.css : '',
    html: typeof base.html === 'string' ? base.html : '',
    enabled: !!base.enabled,
    updatedAt: Number(base.updatedAt) || 0,
    presets,
    activeId,
  };
}
function readCustomTheme() {
  return normalizeCustomTheme(readJSON(CUSTOM_THEME_KEY, null));
}
function writeCustomTheme(cfg) {
  writeJSON(CUSTOM_THEME_KEY, normalizeCustomTheme(cfg));
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
/* 卡片预览只用 CSS 里的三个变量；值做白名单过滤，避免把任意文本塞进 style。 */
function customPreviewColor(css, name, fallback) {
  const match = new RegExp('--' + name + '\\s*:\\s*([^;\\n}]+)', 'i').exec(String(css || ''));
  const value = match ? match[1].trim() : '';
  return /^[#a-zA-Z0-9(),.%\s/-]{1,40}$/.test(value) ? value : fallback;
}
function customThemeActiveName(cfg) {
  const preset = cfg.presets.find(item => item.id === cfg.activeId);
  return preset ? preset.name : '';
}
function newCustomPresetId() {
  return 'ct-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
/* 顶栏「切换主题」弹层里也要能看到随包主题：内置四色在前，七套主题包接在后面。
   包色块用各自 CSS 的 --bg/--accent/--accent2 取色，点一下就直接应用那张卡。 */
function renderThemePopPacks() {
  const pop = $('themePop');
  if (!pop) return;
  pop.querySelectorAll('[data-pack]').forEach(node => node.remove());
  const packs = readCustomTheme().presets.filter(item => item.builtin);
  if (!packs.length) return;
  packs.forEach(preset => {
    const slug = preset.id.replace(/^ct-pack-/, '');
    const bg = customPreviewColor(preset.css, 'bg', '#1b2430');
    const accent = customPreviewColor(preset.css, 'accent', '#d7a35a');
    const accent2 = customPreviewColor(preset.css, 'accent2', '#8fb3ff');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch sw-pack';
    btn.dataset.pack = slug;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', 'false');
    btn.title = preset.name;
    btn.setAttribute('aria-label', preset.name);
    btn.style.setProperty('--sw-bg', bg);
    btn.style.setProperty('--sw-accent', accent);
    btn.style.setProperty('--sw-accent2', accent2);
    pop.append(btn);
  });
  syncThemePopPacks();
}
function syncThemePopPacks(cfg = readCustomTheme()) {
  const pack = cfg.enabled && cfg.activeId ? cfg.activeId.replace(/^ct-pack-/, '') : '';
  document.querySelectorAll('#themePop [data-pack]').forEach(btn => {
    btn.setAttribute('aria-checked', String(cfg.enabled && btn.dataset.pack === pack));
  });
}

function renderCustomThemeGrid() {
  const grid = $('themeGrid');
  if (!grid) return;
  grid.querySelectorAll('[data-custom-preset],[data-custom-add]').forEach(node => node.remove());
  const cfg = readCustomTheme();
  cfg.presets.forEach(preset => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'theme-card custom-card';
    card.dataset.customPreset = preset.id;
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', String(cfg.enabled && cfg.activeId === preset.id));
    const bg = customPreviewColor(preset.css, 'bg', '#1b2430');
    const accent = customPreviewColor(preset.css, 'accent', '#d7a35a');
    const accent2 = customPreviewColor(preset.css, 'accent2', '#8fb3ff');
    card.innerHTML = '<span class="sw custom-sw" style="background:' + esc(bg) + '">' +
      '<i style="background:' + esc(accent) + '"></i><b style="background:' + esc(accent2) + '"></b></span>' +
      '<span class="custom-card-name">' + esc(preset.name) + '</span>' +
      (preset.builtin
        ? ''
        : '<span class="custom-card-del" data-custom-remove="' + esc(preset.id) + '" role="button" aria-label="删除这套主题" title="删除">✕</span>');
    /* 默认主题没有角标也没有删除键，只在 tooltip 里说明，卡片外观和用户自己存的一模一样。 */
    if (preset.builtin) card.dataset.customBuiltin = '1';
    card.title = preset.builtin ? preset.name + '（默认主题）' : preset.name;
    grid.append(card);
  });
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'theme-card custom-card custom-add';
  add.dataset.customAdd = '1';
  add.innerHTML = '<span class="custom-add-plus">＋</span><span>存为自定义主题</span>';
  grid.append(add);
}
function saveCustomThemePreset(name) {
  const cfg = readCustomTheme();
  const css = $('ctCss')?.value || '';
  const html = $('ctHtml')?.value || '';
  if (!css.trim() && !html.trim()) {
    showToast('先写一点 CSS 或 HTML，再存成主题卡。', 'warn');
    return null;
  }
  const preset = {
    id: newCustomPresetId(),
    name: String(name || '').trim().slice(0, 24) || '自定义 ' + (cfg.presets.length + 1),
    css,
    html,
    createdAt: Date.now(),
  };
  const next = { ...cfg, css, html, enabled: true, activeId: preset.id, updatedAt: Date.now(), presets: [...cfg.presets, preset] };
  writeCustomTheme(next);
  applyCustomTheme(next);
  const nameInput = $('ctName');
  if (nameInput) nameInput.value = '';
  renderCustomThemeGrid();
  showToast('已存为「' + preset.name + '」并应用。');
  return preset;
}
function applyCustomThemePreset(id) {
  const cfg = readCustomTheme();
  const preset = cfg.presets.find(item => item.id === String(id));
  if (!preset) return false;
  const next = { ...cfg, css: preset.css, html: preset.html, enabled: true, activeId: preset.id, updatedAt: Date.now() };
  writeCustomTheme(next);
  applyCustomTheme(next);
  if ($('ctCss')) $('ctCss').value = preset.css;
  if ($('ctHtml')) $('ctHtml').value = preset.html;
  renderCustomThemeGrid();
  showToast('已应用「' + preset.name + '」。');
  return true;
}
function removeCustomThemePreset(id) {
  const cfg = readCustomTheme();
  const preset = cfg.presets.find(item => item.id === String(id));
  if (!preset) return false;
  if (preset.builtin) {
    showToast('「' + preset.name + '」是默认主题，不能删除。', 'warn');
    return false;
  }
  if (!confirm('删除「' + preset.name + '」这张主题卡？已经应用的样式会保留在当前页面。')) return false;
  const next = { ...cfg, presets: cfg.presets.filter(item => item.id !== preset.id) };
  if (next.activeId === preset.id) next.activeId = '';
  writeCustomTheme(next);
  renderCustomThemeGrid();
  showToast('已删除「' + preset.name + '」。');
  return true;
}
function applyCustomTheme(cfg = readCustomTheme()) {
  cfg = normalizeCustomTheme(cfg);
  let style = $('ctStyle');
  if (!style) {
    style = document.createElement('style');
    style.id = 'ctStyle';
    document.head.append(style);
  }
  style.textContent = cfg.enabled ? (cfg.css || '') : '';
  if (cfg.enabled && typeof CustomEvent === 'function') {
    document.dispatchEvent(new CustomEvent('myt:theme-change', { detail: { kind: 'custom', id: cfg.activeId || '' } }));
  }
  const mount = $('customHomeMount');
  if (mount) {
    const html = cfg.enabled ? String(cfg.html || '').trim() : '';
    mount.innerHTML = html ? sanitizeCustomHtml(html) : '';
    mount.hidden = !html;
  }
  document.body.classList.toggle('custom-theme-on', !!cfg.enabled);
  document.querySelectorAll('[data-custom-preset]').forEach(card => {
    card.setAttribute('aria-checked', String(!!cfg.enabled && card.dataset.customPreset === cfg.activeId));
  });
  syncThemePopPacks(cfg);
  /* 自定义主题开着的时候，内置色球不该继续显示选中，否则弹层里两个圈同时亮。 */
  if (cfg.enabled) {
    document.querySelectorAll('.swatch[data-theme]').forEach(btn => btn.setAttribute('aria-checked', 'false'));
  } else if (document.documentElement.dataset.theme) {
    setTheme(document.documentElement.dataset.theme, false);
  }
  const ctState = $('ctState');
  if (ctState) {
    const name = customThemeActiveName(cfg);
    ctState.textContent = cfg.enabled
      ? '已启用' + (name ? ' · ' + name : '') + (cfg.updatedAt ? ' · ' + new Date(cfg.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '')
      : '未启用';
  }
}
function syncCustomThemeEditor() {
  const cfg = readCustomTheme();
  const css = $('ctCss'), html = $('ctHtml');
  if (css) css.value = cfg.enabled || cfg.css ? cfg.css : (css.value || '');
  if (html) html.value = cfg.html || '';
  applyCustomTheme(cfg);
  renderCustomThemeGrid();
}
/* 导入一份主题：接受 {name,css,html} 的 JSON，也接受直接拖一份 .css。
   导入后立即存成网格卡片并应用，后续点卡、写回、删除都走卡片那套逻辑。 */
function importCustomTheme(text, filename) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  let data = null;
  try { data = JSON.parse(raw); } catch (e) { data = null; }
  let css = '';
  let html = '';
  let name = '';
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    if (typeof data.css === 'string') css = data.css;
    if (typeof data.html === 'string') html = data.html;
    if (typeof data.name === 'string') name = data.name;
  } else {
    css = raw;
  }
  if (!css.trim() && !html.trim()) {
    showToast('这个文件里没有 CSS 或 HTML。', 'warn');
    return null;
  }
  const cfg = readCustomTheme();
  const fallback = String(filename || '').replace(/\.(json|css)$/i, '') || '导入 ' + (cfg.presets.length + 1);
  const preset = {
    id: newCustomPresetId(),
    name: (name || fallback).trim().slice(0, 24) || '导入 ' + (cfg.presets.length + 1),
    css,
    html,
    createdAt: Date.now(),
  };
  const next = { ...cfg, css, html, enabled: true, activeId: preset.id, updatedAt: Date.now(), presets: [...cfg.presets, preset] };
  writeCustomTheme(next);
  applyCustomTheme(next);
  if ($('ctCss')) $('ctCss').value = css;
  if ($('ctHtml')) $('ctHtml').value = html;
  if ($('ctName')) $('ctName').value = '';
  renderCustomThemeGrid();
  showToast('已导入「' + preset.name + '」并应用。');
  return preset;
}
/* 随包主题：themes-defaults.js 带来七套设计师主题（液态玻璃、玻璃拟态 2.0、极简放大、
   技术单色、新粗野主义、复古印刷、监控美学）。随包主题是默认主题，删不掉也不该缺：
   每次启动都补齐缺的卡（幂等），标记只用来判断“是不是第一次”——第一次才顺手启用第一套，
   免得用户已经把别的主题设成当前时被强行切走。 */
function seedDefaultThemePacks() {
  const packs = Array.isArray(window.MYT_THEME_DEFAULTS) ? window.MYT_THEME_DEFAULTS : [];
  if (!packs.length) return 0;
  let firstTime = true;
  try { firstTime = !localStorage.getItem(DEFAULT_PACKS_KEY); } catch (e) {}
  const cfg = readCustomTheme();
  const known = new Set(cfg.presets.map(item => item.id));
  const added = [];
  const bySlug = new Map();
  packs.forEach(pack => {
    const slug = String(pack && pack.slug || '').trim();
    const css = String(pack && pack.css || '');
    if (!slug || !css.trim()) return;
    bySlug.set(slug, pack);
    if (known.has('ct-pack-' + slug)) return;
    added.push({ id: 'ct-pack-' + slug, name: String(pack.name || slug).trim().slice(0, 24), css, html: String(pack.html || ''), createdAt: Date.now(), builtin: true });
  });
  /* 主题包本身升级了（比如补了播放工具面板样式）：已存在的默认主题卡跟着换新 CSS，
     不靠用户手动删卡重导。 */
  let refreshed = 0;
  let activeRefreshed = false;
  cfg.presets.forEach(preset => {
    if (!preset.builtin) return;
    const pack = bySlug.get(preset.id.replace(/^ct-pack-/, ''));
    if (!pack) return;
    const css = String(pack.css || '');
    if (!css.trim() || css === preset.css) return;
    preset.css = css;
    preset.html = String(pack.html || '');
    preset.name = String(pack.name || preset.name).trim().slice(0, 24) || preset.name;
    refreshed += 1;
    if (preset.id === cfg.activeId) activeRefreshed = true;
  });
  const activePreset = cfg.presets.find(item => item.id === cfg.activeId);
  if (!added.length && !refreshed) {
    try { localStorage.setItem(DEFAULT_PACKS_KEY, '1'); } catch (e) {}
    return 0;
  }
  const take = firstTime ? added[0] : null;
  const next = {
    ...cfg,
    presets: [...cfg.presets, ...added],
    css: take ? take.css : (activeRefreshed && activePreset ? activePreset.css : cfg.css),
    html: take ? take.html : (activeRefreshed && activePreset ? activePreset.html : cfg.html),
    enabled: take ? true : cfg.enabled,
    activeId: take ? take.id : cfg.activeId,
    updatedAt: (take || refreshed) ? Date.now() : cfg.updatedAt,
  };
  writeCustomTheme(next);
  try { localStorage.setItem(DEFAULT_PACKS_KEY, '1'); } catch (e) {}
  renderCustomThemeGrid();
  return added.length + refreshed;
}
function bindCustomThemeEditor() {
  const apply = enable => {
    const cfg = readCustomTheme();
    const css = $('ctCss')?.value || '';
    const html = $('ctHtml')?.value || '';
    const preset = cfg.presets.find(item => item.id === cfg.activeId);
    // 正在用某张卡片时，编辑器里的改动写回那张卡，下次点卡还是这套样子。
    if (preset) { preset.css = css; preset.html = html; }
    const next = {
      ...cfg,
      css, html,
      enabled: enable,
      updatedAt: Date.now(),
    };
    writeCustomTheme(next);
    applyCustomTheme(next);
    renderCustomThemeGrid();
    showToast(enable ? '自定义主题已应用。' : '已停用自定义主题，回到当前主题。');
  };
  if ($('ctApply')) $('ctApply').onclick = () => apply(true);
  if ($('ctDisable')) $('ctDisable').onclick = () => apply(false);
  const grid = $('themeGrid');
  if (grid) {
    grid.addEventListener('click', event => {
      const remove = event.target.closest('[data-custom-remove]');
      if (remove) {
        event.preventDefault();
        event.stopPropagation();
        removeCustomThemePreset(remove.dataset.customRemove);
        return;
      }
      const add = event.target.closest('[data-custom-add]');
      if (add) {
        event.preventDefault();
        saveCustomThemePreset($('ctName')?.value || '');
        return;
      }
      const card = event.target.closest('[data-custom-preset]');
      if (card) {
        event.preventDefault();
        applyCustomThemePreset(card.dataset.customPreset);
      }
    });
  }
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
  if ($('ctImport')) $('ctImport').onclick = () => $('ctImportFile')?.click();
  if ($('ctImportFile')) $('ctImportFile').onchange = () => {
    const input = $('ctImportFile');
    const file = input?.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      importCustomTheme(String(reader.result || ''), file.name);
      input.value = '';
    };
    reader.onerror = () => showToast('读文件失败。', 'warn');
    reader.readAsText(file);
  };
  if ($('ctReset')) $('ctReset').onclick = () => {
    if (!confirm('恢复默认会清空这段自定义 CSS 和 HTML，以及你自己存的主题卡（默认主题保留），继续？')) return;
    /* 随包主题是默认主题，恢复默认只清用户自己加的东西。 */
    const keep = readCustomTheme().presets.filter(item => item.builtin);
    const next = { css: '', html: '', enabled: false, updatedAt: Date.now(), presets: keep, activeId: '' };
    writeCustomTheme(next);
    if ($('ctCss')) $('ctCss').value = '';
    if ($('ctHtml')) $('ctHtml').value = '';
    if ($('ctName')) $('ctName').value = '';
    applyCustomTheme(next);
    renderCustomThemeGrid();
    showToast('已恢复默认主题（七套随包主题保留）。');
  };
}
/* 启动时 05 里的 readJSON 可能还没注册（lazy 版会直接返回 undefined，看起来像“没有配置”），
   所以把「种随包主题 + 应用自定义主题」压到微任务里，等各层都 registerLayer 完再读。 */
function bootCustomTheme() {
  seedDefaultThemePacks();
  renderThemePopPacks();
  applyCustomTheme();
  /* 其它层启动时还会 setTheme 一次同步内置色球，空闲时再刷一遍，保证弹层只亮当前主题。 */
  whenIdle(() => applyCustomTheme());
}
if (typeof queueMicrotask === 'function') queueMicrotask(bootCustomTheme);
else setTimeout(bootCustomTheme, 0);
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
  if (!subtitlePluginOn()) {
    // 原生播放器：没有字幕插件时阅读区只保留一条中性说明，不反复清空成空白，
    // 也不提示用户去启用插件。
    if (box.dataset.nativeAudio !== '1') {
      box.innerHTML = '<div class="empty">音频播放模式<br><span style="font-size:12px">本集只播放音频，未加载字幕。</span></div>';
      box.dataset.nativeAudio = '1';
    }
    syncMiniCaption(); return;
  }
  box.dataset.nativeAudio = '';
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
function seekTo(t) { if (!state.current) return; studyResetPlayback(); rawSeek(t / (state.timeScale || 1)); audio.play().catch(() => {}); paint(true); }

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
export { CUSTOM_THEME_KEY, LIGHT_THEMES, PROGRESS_KEY, READER_DEFAULTS, alignZhLines, applyCustomTheme, applyExperiment, applyReader, applyVttExperiment, audioFail, bindCustomThemeEditor, canFollow, chapterJsonUrl, clearProgress, closeDetails, closeDrawer, closeOverlays, closeTypeSheet, cuesFromJson, deriveTimingsUrl, deriveZhUrl, directAudioUrl, emptyLine, epKey, episodeNumber, esc, fetchJsonTimed, findNorm, fmt, getJson, getText, hideToast, importExperimentFile, invalidateProgressCache, invalidateWordPanelKey, isBracket, isJsonTranscript, isOwnTranscript, lastDark, lastLight, liveFollow, loaderHTML, locateCue, mergeCues, nativeWordDoc, onAudioError, openDetails, openDrawer, openTypeSheet, overlayTriggers, paint, paintWords, parseFeed, parseVttSmart, parseZhVTT, pickTranscript, pluginPageKey, podloveChapters, preferredAudioUrl, progressAll, progressAllCache, progressKey, rawSeek, readCustomTheme, readProgress, reader, readerFields, rebuildCues, reduceMotion, rememberOverlayTrigger, rememberPosition, renderCueWindow, renderCues, renderCustomThemeGrid, resetImportUI, resetWordPanelForEpisode, resolveFinalAudioUrl, restoreExperiment, restoreOverlayFocus, retryCurrentAudio, sanitizeCustomHtml, saveProgress, scrollCue, scrollIntoBox, scrollTarget, scrollWord, seekTo, setDrawerBackgroundInert, setImmersive, setImportNote, setTheme, setWallpaper, showToast, sitePath, splitLabel, stampSeconds, statHTML, status, stopScroll, studyNormText, studyRegexEscape, subtitleKernel, subtitleViewHost, syncCustomThemeEditor, syncJumpPill, syncWallpaperPlay, themeBtns, toastTimer, toggleWallpaperPlay, transcriptEls, transcriptMirror, tryAudioSource, updateTimeScale, vttFromSidecar, wallpaperEnMarkup, wallpaperFullscreen, wallpaperRefresh, wallpaperText, wallpaperWordPaint, wpCueIndex, wpEpId, wpLastKey, wpPrevIndex, wpWasFullscreen, wpWordCue, wpWordIdx, wpWordSpans, writeCustomTheme, writeProgressAll };
registerLayer('01-theme-reader-shell', { CUSTOM_THEME_KEY, LIGHT_THEMES, PROGRESS_KEY, READER_DEFAULTS, alignZhLines, applyCustomTheme, applyExperiment, applyReader, applyVttExperiment, audioFail, bindCustomThemeEditor, canFollow, chapterJsonUrl, clearProgress, closeDetails, closeDrawer, closeOverlays, closeTypeSheet, cuesFromJson, deriveTimingsUrl, deriveZhUrl, directAudioUrl, emptyLine, epKey, episodeNumber, esc, fetchJsonTimed, findNorm, fmt, getJson, getText, hideToast, importExperimentFile, invalidateProgressCache, invalidateWordPanelKey, isBracket, isJsonTranscript, isOwnTranscript, lastDark, lastLight, liveFollow, loaderHTML, locateCue, mergeCues, nativeWordDoc, onAudioError, openDetails, openDrawer, openTypeSheet, overlayTriggers, paint, paintWords, parseFeed, parseVttSmart, parseZhVTT, pickTranscript, pluginPageKey, podloveChapters, preferredAudioUrl, progressAll, progressAllCache, progressKey, rawSeek, readCustomTheme, readProgress, reader, readerFields, rebuildCues, reduceMotion, rememberOverlayTrigger, rememberPosition, renderCueWindow, renderCues, renderCustomThemeGrid, resetImportUI, resetWordPanelForEpisode, resolveFinalAudioUrl, restoreExperiment, restoreOverlayFocus, retryCurrentAudio, sanitizeCustomHtml, saveProgress, scrollCue, scrollIntoBox, scrollTarget, scrollWord, seekTo, setDrawerBackgroundInert, setImmersive, setImportNote, setTheme, setWallpaper, showToast, sitePath, splitLabel, stampSeconds, statHTML, status, stopScroll, studyNormText, studyRegexEscape, subtitleKernel, subtitleViewHost, syncCustomThemeEditor, syncJumpPill, syncWallpaperPlay, themeBtns, toastTimer, toggleWallpaperPlay, transcriptEls, transcriptMirror, tryAudioSource, updateTimeScale, vttFromSidecar, wallpaperEnMarkup, wallpaperFullscreen, wallpaperRefresh, wallpaperText, wallpaperWordPaint, wpCueIndex, wpEpId, wpLastKey, wpPrevIndex, wpWasFullscreen, wpWordCue, wpWordIdx, wpWordSpans, writeCustomTheme, writeProgressAll });
