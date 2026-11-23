/* layer: theme —— 主题降级的家
   这个模块只负责一件事：判断"窗口还在不在前台"，并据此给 <html> 挂/摘 .decor-idle。
   主题侧（themes/*.css 与 site/player.css）与逻辑侧（01 的 paint()）都消费这一个类。

   接口（极小）：sync() / isDegraded()。事件监听在模块加载时自己挂一次，谁都不用再管。

   判据：visibilityState 与 hasFocus 两个一起看——Tauri 里最小化只变 visibility，
   点别的窗口只变 focus，任一为"不在前台"都算降级。
   背景见 docs/handover.md「十二、性能」：光斑/模糊面板只要每帧有变化就要重采背景，
   后台挂着听时纯粹是白烧 CPU/GPU。

   为什么单独成层：降级这件事原来是 05（挂类）+ 01（跳绘制）+ CSS（变量）三处各写一段，
   改一处要动三个文件；现在"谁降级"只有一处，"怎么表现"仍在各层里。 */
import { lazyFn, registerLayer } from './00-layers.js';
import { $ } from './00-runtime.js';

const esc = lazyFn('01-theme-reader-shell', 'esc');
const showToast = lazyFn('01-theme-reader-shell', 'showToast');
const closeThemePop = lazyFn('10-desktop-bridge-tail', 'closeThemePop');
const whenIdle = lazyFn('05-transport-transcript-nav', 'whenIdle');

const readJSON = lazyFn('15-store', 'readJSON');
const writeJSON = lazyFn('15-store', 'writeJSON');

const CUSTOM_THEME_KEY = 'myt-theme-custom';

/* ---------- 自定义主题的数据层 ----------
   一套配置加多张“卡片”：每张卡片记一份 CSS/HTML 快照，点卡即应用；
   旧数据只有 {css,html,enabled}，读入时补 presets: []，不丢已有内容。
   这里只做「读 / 写 / 规范化 / 清洗」，不做应用与渲染——那部分仍在 01。
   搬出来是因为 04（插件设置）与 10（弹层）都会写这份配置，schema 必须只有一个owner。 */
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

function readCustomTheme() { return normalizeCustomTheme(readJSON(CUSTOM_THEME_KEY, null)); }
function writeCustomTheme(cfg) { writeJSON(CUSTOM_THEME_KEY, normalizeCustomTheme(cfg)); }

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

/* 只收内置色球：弹层里还有随包的 .sw-pack（data-pack），setTheme 不该去动它们的选中态。 */
const themeBtns = () => [...document.querySelectorAll('.swatch[data-theme]')];

const LIGHT_THEMES = new Set(['paper', 'mist', 'prototype', 'ledger', 'apple']);
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
  if (themeLabel) themeLabel.textContent = '外观与主题';
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
    // 与内置四色同一套结构：缩略 + 名称，当前态靠 aria-checked 打 ✓。
    const cap = document.createElement('span');
    cap.className = 'sw-cap';
    const label = document.createElement('span');
    label.className = 'sw-name';
    label.textContent = preset.name;
    btn.append(cap, label);
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
function isDegraded() { return document.hidden || !document.hasFocus(); }

function sync() {
  document.documentElement.classList.toggle('decor-idle', isDegraded());
}

document.addEventListener('visibilitychange', sync);
window.addEventListener('blur', sync);
window.addEventListener('focus', sync);
sync();

export {
  CUSTOM_THEME_KEY, LIGHT_THEMES, REMOVED_THEME_FALLBACK, applyCustomTheme, applyCustomThemePreset,
  bindCustomThemeEditor, customPreviewColor, customThemeActiveName, importCustomTheme, isDegraded,
  lastDark, lastLight, newCustomPresetId, normalizeCustomTheme, readCustomTheme,
  renderCustomThemeGrid, sanitizeCustomHtml, saveCustomThemePreset, seedDefaultThemePacks,
  setTheme, sync, syncCustomThemeEditor, themeBtns, writeCustomTheme,
};
registerLayer('13-theme', {
  sync, isDegraded, CUSTOM_THEME_KEY, LIGHT_THEMES, REMOVED_THEME_FALLBACK,
  normalizeCustomTheme, readCustomTheme, writeCustomTheme, sanitizeCustomHtml,
  customPreviewColor, customThemeActiveName, newCustomPresetId,
  setTheme, applyCustomTheme, applyCustomThemePreset, renderCustomThemeGrid,
  syncCustomThemeEditor, bindCustomThemeEditor, seedDefaultThemePacks,
  importCustomTheme, saveCustomThemePreset, themeBtns,
});
