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
const setNavCollapsed = lazyFn('09-player-integration', 'setNavCollapsed');
const closeThemePop = lazyFn('10-desktop-bridge-tail', 'closeThemePop');
const whenIdle = lazyFn('05-transport-transcript-nav', 'whenIdle');

const readJSON = lazyFn('15-store', 'readJSON');
const writeJSON = lazyFn('15-store', 'writeJSON');

const CUSTOM_THEME_KEY = 'myt-theme-custom';

/* 自定义主题的数据层：主题只有一个当前值（存在 myt-theme 里，内置档 id 或卡 id）。
   - scope：这张卡照哪种骨架写的（rail / strip / print / grid，或旧的某档 id）；
   - presets：所有可选主题卡（随包 + 用户自建），每张自带完整 CSS/HTML，是**唯一**的持久层；
   - 没有 perTheme：老版本「按档草稿」在读入时一次性折成卡片（见 normalizeCustomTheme），
     之后再也不会写回。旧数据里的 activeByTheme（按档指针）同样读进来直接丢掉。 */
function packScopeMatches(scope, theme) {
  const s = scope || 'rail';
  if (s === 'all') return true;
  if (s === 'rail') return ['prototype', 'ledger', 'apple', 'spotify'].includes(theme);
  return s === theme;
}
function packScopeLabel(scope) {
  if (scope === 'all') return '全部档位';
  if (scope === 'rail') return '竖栏档';
  const label = { news: '报纸', plate: '影集', console: '播控台', prototype: '竖栏', ledger: '竖栏', apple: '竖栏', spotify: '竖栏' }[scope];
  return label || String(scope || '竖栏');
}

/* ---------- 自定义主题的数据层 ----------
   一套配置加多张“卡片”：每张卡片记一份 CSS/HTML 快照，点卡即应用到它归属的那一档；
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
        /* 老卡片的 CSS 都是照竖栏骨架写的，默认归 rail；新卡片存的时候会写自己的档。 */
        scope: String(item.scope || 'rail'),
      };
    }) : [];
  const activeId = presets.some(item => item.id === base.activeId) ? String(base.activeId) : '';
  /* 迁移：老版本把「内置档上的自写稿」存在 perTheme[档] 里，是第二套持久层，和卡片打架。
     这里把它折成卡片（每档最多一张，重复读入幂等），之后配置里不再出现 perTheme。 */
  if (base.perTheme && typeof base.perTheme === 'object') {
    Object.entries(base.perTheme).forEach(([theme, value]) => {
      if (!value || typeof value !== 'object') return;
      const css = typeof value.css === 'string' ? value.css : '';
      const html = typeof value.html === 'string' ? value.html : '';
      if (!css.trim() && !html.trim()) return;
      const id = 'ct-draft-' + theme;
      if (presets.some(item => item.id === id)) return;
      presets.push({
        id,
        name: (packScopeLabel(theme) + '自写稿').slice(0, 24),
        css,
        html,
        createdAt: Number(base.updatedAt) || Date.now(),
        builtin: false,
        scope: String(theme),
      });
    });
  }
  /* 迁移：老配置只有 enabled + activeId（全局一份）——那时候「当前样式」就等于 activeId 那张卡。
     现在当前主题只剩 myt-theme 一个真源，所以这里只保留字段，不再往按档指针里塞。 */
  return {
    css: typeof base.css === 'string' ? base.css : '',
    html: typeof base.html === 'string' ? base.html : '',
    enabled: !!base.enabled,
    updatedAt: Number(base.updatedAt) || 0,
    presets,
    activeId,
  };
}

/* 主题模型只有一层：当前主题就是一个 id，可能是内置档，也可能是一张包卡。
   所以这里判断的是「当前选中的这个 id 本身是不是一张卡」，不再有「这一档配了哪张卡」这种按档记忆。 */
function activePackForTheme(cfg, theme) {
  const id = String(theme || '');
  if (!id) return null;
  return cfg.presets.find(item => item.id === id) || null;
}
/* 骨架种类：竖栏 rail / 横条 strip / 报纸 print / 栅格 grid。内置档有固定归属，
   包卡把骨架写在 scope 上（随包那批全是 rail，也就是它们自己的浮岛侧栏骨架）。 */
const SKELETON_OF = {
  prototype: 'rail', ledger: 'rail', apple: 'rail', spotify: 'rail',
  console: 'strip', news: 'print', plate: 'grid',
  rail: 'rail', strip: 'strip', print: 'print', grid: 'grid',
};
function themeStyle(cfg, theme) {
  /* 当前主题就是一张包卡：整套样式原样注入。data-theme 直接写成包的 id（见 setTheme），
     内置档的版面规则全都挂在 html[data-theme="某一档"] 上，一条都不会命中，
     页面上只剩基础骨架 + 这张卡自己的完整设计——这就是「点一下就换到另一套的全部样式」。 */
  const pack = activePackForTheme(cfg, theme);
  if (pack) {
    const skeleton = String(pack.scope || 'rail');
    return {
      css: pack.css || '', html: pack.html || '', name: pack.name, from: pack.id,
      mode: 'pack', skeleton: SKELETON_OF[skeleton] || 'rail',
    };
  }
  /* 内置档没有附加样式：所有自定义都必须是卡片。 */
  return { css: '', html: '', name: '', from: '', mode: 'none', skeleton: '' };
}

/* 这两处读写只碰 localStorage：启动微任务时 15-store 可能还没 registerLayer，
   lazyFn 会返回 undefined，种子主题就写不进去（表现为弹层里一张包卡都没有）。 */
function readCustomTheme() {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_THEME_KEY) || 'null');
    return normalizeCustomTheme(raw);
  } catch (e) { return normalizeCustomTheme(null); }
}
function writeCustomTheme(cfg) {
  try {
    localStorage.setItem(CUSTOM_THEME_KEY, JSON.stringify(normalizeCustomTheme(cfg)));
    return true;
  } catch (e) {
    try { return !!writeJSON(CUSTOM_THEME_KEY, normalizeCustomTheme(cfg)); } catch (err) { return false; }
  }
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

function customThemeActiveName(cfg, theme = themeId()) {
  const preset = activePackForTheme(cfg, theme);
  return preset ? preset.name : '';
}

function newCustomPresetId() {
  return 'ct-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/* 只收内置色球：弹层里还有随包的 .sw-pack（data-pack），setTheme 不该去动它们的选中态。 */
const themeBtns = () => [...document.querySelectorAll('.swatch[data-theme]')];

const LIGHT_THEMES = new Set(['mist', 'prototype', 'ledger', 'apple', 'news']);
/* 撤掉的色板把老用户的存档迁到最接近的现存色板，不然启动时会因为“存档主题不在色板里”被兜底到编辑部。
   午夜蓝/纸张这两个默认档也走同一张表：深色落 Spotify，浅色落编辑部。 */
const REMOVED_THEME_FALLBACK = {
  brass: 'spotify', forest: 'spotify', oxblood: 'spotify', midnight: 'spotify',
  celadon: 'ledger', mist: 'ledger', paper: 'ledger',
};
/* 随包主题只在第一次种一次；用户自己删掉的卡片不会被重新塞回来。 */
const DEFAULT_PACKS_KEY = 'myt-theme-packs-seeded';
/* 当前主题 id：内置档 id，或一张包卡的 id（ct-pack-<slug>）。只有一个真源。 */
function themeId() {
  return document.documentElement.dataset.theme || '';
}
/* 包卡是浅色还是深色：看它自己写的 --bg 亮度。弹层的「切到浅/深色」和 meta theme-color 靠它。 */
function packIsLight(preset) {
  const bg = customPreviewColor(preset && preset.css, 'bg', '');
  if (!bg) return false;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(bg.trim());
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 150;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(bg.trim());
  if (rgb) {
    const parts = rgb[1].split(',').map(x => parseFloat(x));
    return (0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]) > 150;
  }
  return false;
}
let lastDark = 'spotify', lastLight = 'ledger', lastBuiltin = 'ledger';
/* 启动早期 readJSON 还没注册，readCustomTheme 会读到空配置；这时按 id 找包要能直接从
   localStorage 里捞，否则「上次停在某张卡」会被当成内置档，回退目标也会被写坏。 */
function rawPackById(id) {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_THEME_KEY) || 'null');
    const list = (raw && Array.isArray(raw.presets)) ? raw.presets : [];
    const item = list.find(preset => preset && preset.id === id);
    if (!item) return null;
    return {
      id: String(item.id), name: String(item.name || ''),
      css: typeof item.css === 'string' ? item.css : '',
      html: typeof item.html === 'string' ? item.html : '',
      scope: String(item.scope || 'rail'),
    };
  } catch (e) { return null; }
}
/* 插件侧的主题查询：插件不要去猜 data-theme 的值——它现在可能是内置档 id，也可能是
   ct-pack-<slug> 这样的卡 id。深浅、骨架、回哪一档都从这里拿。 */
function themeBase() {
  return document.documentElement.dataset.themeBase || lastBuiltin;
}
function themeIsLight() {
  return document.documentElement.dataset.scheme === 'light';
}
function themeSkeleton() {
  return document.documentElement.dataset.skel || 'rail';
}
function themePacks() {
  const cfg = readCustomTheme();
  const list = Array.isArray(cfg.presets) ? cfg.presets : [];
  const current = themeId();
  return list.map(preset => ({
    id: String(preset.id || ''),
    name: String(preset.name || ''),
    skeleton: SKELETON_OF[String(preset.scope || 'rail')] || 'rail',
    light: packIsLight(preset),
    active: String(preset.id || '') === current,
  }));
}
/* 唯一的切换入口：既接内置档 id，也接包卡 id。
   切到包卡时 data-theme 就写成包的 id —— 内置档的版面规则一条都不命中，
   页面按这张卡自己的骨架与配色整套重画；切回内置档时照旧按档画。 */
function setTheme(id, persist = true) {
  id = String(id || '');
  const cfg = readCustomTheme();
  const pack = activePackForTheme(cfg, id) || (id.indexOf('ct-pack-') === 0 ? rawPackById(id) : null);
  const light = pack ? packIsLight(pack) : LIGHT_THEMES.has(id);
  const el = document.documentElement;
  el.dataset.theme = id;
  el.dataset.scheme = light ? 'light' : 'dark';
  /* Folia 的侧栏只靠自动隐藏/左缘唤回，进来时把上一套主题留下的手动收起状态清掉。 */
  if (id === 'ct-pack-folia-poster') {
    if (typeof setNavCollapsed === 'function') setNavCollapsed(false, true);
    else {
      document.body.classList.remove('nav-collapsed');
      const navBtn = $('sidebarToggle');
      if (navBtn) navBtn.setAttribute('aria-expanded', 'true');
      try { localStorage.setItem('myt-nav-collapsed', '0'); } catch (e) {}
    }
  }
  el.dataset.skel = pack
    ? (SKELETON_OF[String(pack.scope || 'rail')] || 'rail')
    : (SKELETON_OF[id] || 'rail');
  if (pack) {
    /* 包卡不带「回哪一档」的记忆，回内置用最近用过的那一档。 */
    el.dataset.themeBase = lastBuiltin;
    if (light) lastLight = lastBuiltin; else lastDark = lastBuiltin;
  } else {
    lastBuiltin = id;
    el.dataset.themeBase = lastBuiltin;
    if (light) lastLight = id; else lastDark = id;
  }
  themeBtns().forEach(b => b.setAttribute('aria-checked', String(!pack && b.dataset.theme === id)));
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
      localStorage.setItem('myt-theme-base', lastBuiltin);
    } catch (e) {}
    /* 点包卡本身就是「我要这套主题」：自定义主题总开关关着就顺手打开。
       否则 data-theme 换了、CSS 一条没注入，用户看到的是「点了没反应」。 */
    if (pack && !cfg.enabled) writeCustomTheme({ ...cfg, enabled: true });
    applyCustomTheme();
    renderCustomThemeGrid();
    renderThemePopPacks();
    if (typeof CustomEvent === 'function') {
      document.dispatchEvent(new CustomEvent('myt:theme-change', { detail: { kind: pack ? 'pack' : 'builtin', id } }));
    }
  }
  closeThemePop();
}
document.addEventListener('click', e => { const b = e.target.closest('.swatch[data-theme]'); if (b) setTheme(b.dataset.theme); });
document.addEventListener('click', e => {
  const pack = e.target.closest('#themePop [data-pack]');
  if (!pack) return;
  e.preventDefault();
  setTheme('ct-pack-' + pack.dataset.pack);
});
/* 每次打开弹层都重排一次：随包主题要跟着主题卡变。 */
const themeTopButton = $('themeTopBtn');
if (themeTopButton) {
  themeTopButton.addEventListener('click', () => {
    renderThemePopPacks();
  });
}
$('themeBtn').onclick = () => {
  const light = document.documentElement.dataset.scheme === 'light';
  setTheme(light ? lastDark : lastLight);
};
try {
  lastDark = localStorage.getItem('myt-theme-dark') || lastDark;
  lastLight = localStorage.getItem('myt-theme-light') || lastLight;
  lastBuiltin = localStorage.getItem('myt-theme-base') || lastBuiltin;
  /* 撤档后旧 profile 里的 lastDark/lastLight 可能指向已删的档，切换键会落到不存在的色板；
     这里按同一张迁移表洗一遍，迁不到就回默认。 */
  const known = id => id && themeBtns().some(b => b.dataset.theme === id) ? id : '';
  lastDark = known(REMOVED_THEME_FALLBACK[lastDark] || lastDark) || 'spotify';
  lastLight = known(REMOVED_THEME_FALLBACK[lastLight] || lastLight) || 'ledger';
  lastBuiltin = known(REMOVED_THEME_FALLBACK[lastBuiltin] || lastBuiltin) || 'ledger';
  localStorage.setItem('myt-theme-dark', lastDark);
  localStorage.setItem('myt-theme-light', lastLight);
  localStorage.setItem('myt-theme-base', lastBuiltin);
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
  /* 当前主题只有一个真源：内置档 id 或包卡 id。存着的那张卡要是被删了，
     回最近用过的内置档，别开着空白版面。 */
  const savedPacks = (() => {
    try {
      const raw = JSON.parse(localStorage.getItem(CUSTOM_THEME_KEY) || 'null');
      return (raw && Array.isArray(raw.presets)) ? raw.presets : [];
    } catch (e) { return []; }
  })();
  const isBuiltin = id => themeBtns().some(b => b.dataset.theme === id);
  const isPack = id => savedPacks.some(item => item && item.id === id);
  const start = (savedTheme && (isBuiltin(savedTheme) || isPack(savedTheme))) ? savedTheme : lastBuiltin;
  setTheme(start, false);
} catch (e) { setTheme('ledger', false); }


/* ---------- 自定义主题（CSS / HTML + 卡片） ----------
   一套配置加多张“卡片”：每张卡片记一份 CSS/HTML 快照，点卡即应用；
   旧数据只有 {css,html,enabled}，读入时补 presets: []，不丢已有内容。 */
/* 顶栏「切换主题」弹层：内置色板在前，整套主题包接在后面，点一下就是切换主题。
   包色块用各自 CSS 的 --bg/--accent/--accent2 取色。 */
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
    btn.dataset.scope = preset.scope || 'rail';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', 'false');
    btn.title = preset.name + '（整套主题 · ' + packScopeLabel(preset.scope) + '骨架）';
    btn.setAttribute('aria-label', btn.title);
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
  const current = themeId();
  document.querySelectorAll('#themePop [data-pack]').forEach(btn => {
    btn.setAttribute('aria-checked', String('ct-pack-' + btn.dataset.pack === current));
  });
}

function renderCustomThemeGrid() {
  const grid = $('themeGrid');
  if (!grid) return;
  grid.querySelectorAll('[data-custom-preset],[data-custom-add]').forEach(node => node.remove());
  const cfg = readCustomTheme();
  const theme = themeId();
  cfg.presets.forEach(preset => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'theme-card custom-card';
    card.dataset.customPreset = preset.id;
    card.dataset.customScope = preset.scope;
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', String(preset.id === theme));
    const bg = customPreviewColor(preset.css, 'bg', '#1b2430');
    const accent = customPreviewColor(preset.css, 'accent', '#d7a35a');
    const accent2 = customPreviewColor(preset.css, 'accent2', '#8fb3ff');
    card.innerHTML = '<span class="sw custom-sw" style="background:' + esc(bg) + '">' +
      '<i style="background:' + esc(accent) + '"></i><b style="background:' + esc(accent2) + '"></b></span>' +
      '<span class="custom-card-name">' + esc(preset.name) + '</span>' +
      '<span class="custom-card-scope">' + esc(packScopeLabel(preset.scope)) + '</span>' +
      (preset.builtin
        ? ''
        : '<span class="custom-card-del" data-custom-remove="' + esc(preset.id) + '" role="button" aria-label="删除这套主题" title="删除">✕</span>');
    /* 默认主题没有角标也没有删除键，只在 tooltip 里说明，卡片外观和用户自己存的一模一样。 */
    if (preset.builtin) card.dataset.customBuiltin = '1';
    card.title = preset.name + '（整套主题 · ' + packScopeLabel(preset.scope) + '骨架' + (preset.builtin ? ' · 默认主题' : '') + '）';
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
  const current = themeId();
  const css = $('ctCss')?.value || '';
  const html = $('ctHtml')?.value || '';
  if (!css.trim() && !html.trim()) {
    showToast('先写一点 CSS 或 HTML，再存成主题卡。', 'warn');
    return null;
  }
  /* 新卡记下它照哪套骨架写的：正在用一张卡，就沿用那张卡的骨架；否则用当前内置档的骨架。 */
  const pack = activePackForTheme(cfg, current);
  const scope = pack ? String(pack.scope || 'rail') : (SKELETON_OF[current] || 'rail');
  const preset = {
    id: newCustomPresetId(),
    name: String(name || '').trim().slice(0, 24) || '自定义 ' + (cfg.presets.length + 1),
    css,
    html,
    createdAt: Date.now(),
    scope,
  };
  writeCustomTheme({ ...cfg, enabled: true, updatedAt: Date.now(), presets: [...cfg.presets, preset] });
  const nameInput = $('ctName');
  if (nameInput) nameInput.value = '';
  /* 存完直接切过去：用户按下「存为自定义主题」就是要用这套。 */
  setTheme(preset.id);
  showToast('已存为「' + preset.name + '」并切了过去。');
  return preset;
}
function applyCustomThemePreset(id) {
  const cfg = readCustomTheme();
  const preset = cfg.presets.find(item => item.id === String(id));
  if (!preset) return false;
  /* 点卡就是切换主题本身：不再「套在某一档上」，也不写按档指针。 */
  setTheme(preset.id);
  if ($('ctCss')) $('ctCss').value = preset.css;
  if ($('ctHtml')) $('ctHtml').value = preset.html;
  showToast('已切换到「' + preset.name + '」。');
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
  if (!confirm('删除「' + preset.name + '」这张主题卡？')) return false;
  const next = { ...cfg, presets: cfg.presets.filter(item => item.id !== preset.id) };
  if (next.activeId === preset.id) next.activeId = '';
  writeCustomTheme(next);
  /* 删掉的正好是当前主题：回最近用过的内置档，别停在一张已不存在的卡上。 */
  if (themeId() === preset.id) setTheme(lastBuiltin);
  else { renderCustomThemeGrid(); renderThemePopPacks(); applyCustomTheme(next); }
  showToast('已删除「' + preset.name + '」。');
  return true;
}
function applyCustomTheme(cfg = readCustomTheme()) {
  cfg = normalizeCustomTheme(cfg);
  const current = themeId();
  /* 变体预览（?skeleton=a|b|c）由 player.html 的骨架引导挂上这个开关：自定义主题是整包重排，
     会把变体自己的版面盖掉，所以预览期间一律不生效，配色只由变体 CSS 决定。 */
  const skipped = !!window.__MYT_SKIP_CUSTOM_THEME;
  const picked = themeStyle(cfg, current);
  const live = !skipped && !!cfg.enabled && !!(picked.css || picked.html);
  const style = (() => {
    let node = $('ctStyle');
    if (!node) {
      node = document.createElement('style');
      node.id = 'ctStyle';
      document.head.append(node);
    }
    return node;
  })();
  style.textContent = live ? picked.css : '';
  if (live && typeof CustomEvent === 'function') {
    document.dispatchEvent(new CustomEvent('myt:theme-change', { detail: { kind: 'custom', id: picked.from || '' } }));
  }
  const mount = $('customHomeMount');
  if (mount) {
    const html = live ? String(picked.html || '').trim() : '';
    mount.innerHTML = html ? sanitizeCustomHtml(html) : '';
    mount.hidden = !html;
  }
  document.body.classList.toggle('custom-theme-on', live);
  document.querySelectorAll('[data-custom-preset]').forEach(card => {
    card.setAttribute('aria-checked', String(live && card.dataset.customPreset === picked.from));
  });
  syncThemePopPacks(cfg);
  /* 当前主题是包卡时，内置色球不该显示选中——一个圈只能亮一个。 */
  if (picked.mode === 'pack') {
    document.querySelectorAll('.swatch[data-theme]').forEach(btn => btn.setAttribute('aria-checked', 'false'));
  }
  const ctState = $('ctState');
  if (ctState) {
    ctState.textContent = !cfg.enabled
      ? '未启用'
      : live
        ? '已切换到「' + (picked.name || '未命名主题') + '」' + (cfg.updatedAt ? ' · ' + new Date(cfg.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '')
        : '当前是内置主题';
  }
}
function syncCustomThemeEditor() {
  const cfg = readCustomTheme();
  const theme = themeId();
  const picked = themeStyle(cfg, theme);
  const css = $('ctCss'), html = $('ctHtml');
  if (css) css.value = picked.css || (css.value || '');
  if (html) html.value = picked.html || '';
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
  const current = themeId();
  const pack = activePackForTheme(cfg, current);
  const fallback = String(filename || '').replace(/\.(json|css)$/i, '') || '导入 ' + (cfg.presets.length + 1);
  const preset = {
    id: newCustomPresetId(),
    name: (name || fallback).trim().slice(0, 24) || '导入 ' + (cfg.presets.length + 1),
    css,
    html,
    createdAt: Date.now(),
    scope: pack ? String(pack.scope || 'rail') : (SKELETON_OF[current] || 'rail'),
  };
  writeCustomTheme({ ...cfg, enabled: true, updatedAt: Date.now(), presets: [...cfg.presets, preset] });
  if ($('ctCss')) $('ctCss').value = css;
  if ($('ctHtml')) $('ctHtml').value = html;
  if ($('ctName')) $('ctName').value = '';
  setTheme(preset.id);
  showToast('已导入「' + preset.name + '」并切了过去。');
  return preset;
}
/* 随包主题：themes-defaults.js 带来当前这批设计师主题（液态玻璃、玻璃拟态 2.0、极简放大、
   技术单色、监控美学、海报墙）。随包主题是默认主题，删不掉也不该缺：
   每次启动都补齐缺的卡（幂等），**不再顺手把某几档切过去**——当前主题只有一个，由用户点。 */
function seedDefaultThemePacks() {
  const packs = Array.isArray(window.MYT_THEME_DEFAULTS) ? window.MYT_THEME_DEFAULTS : [];
  if (!packs.length) return 0;
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
    added.push({
      id: 'ct-pack-' + slug,
      name: String(pack.name || slug).trim().slice(0, 24),
      css,
      html: String(pack.html || ''),
      createdAt: Date.now(),
      builtin: true,
      /* 随包自带的归属：清单里没写 scope 的包一律给竖栏四档 */
      scope: String(pack.scope || 'rail'),
    });
  });
  /* 主题包本身升级了（比如补了播放工具面板样式）：已存在的默认主题卡跟着换新 CSS，
     不靠用户手动删卡重导。 */
  let refreshed = 0;
  cfg.presets.forEach(preset => {
    if (!preset.builtin) return;
    const pack = bySlug.get(preset.id.replace(/^ct-pack-/, ''));
    if (!pack) return;
    const css = String(pack.css || '');
    /* 归属也跟着清单走：给某套包改了 scope，已种下的卡片要跟上。 */
    const scope = String(pack.scope || 'rail');
    let changed = false;
    if (scope !== preset.scope) { preset.scope = scope; changed = true; }
    if (css.trim() && css !== preset.css) {
      preset.css = css;
      preset.html = String(pack.html || '');
      preset.name = String(pack.name || preset.name).trim().slice(0, 24) || preset.name;
      changed = true;
    }
    if (changed) refreshed += 1;
  });
  /* 清单里被删掉的包（比如试过又撤掉的某档专属包）：用户机器上的随包卡片跟着撤，
     否则会留一张指向已不存在样式的幽灵卡。用户自己做的卡一律不动。
     老版本把包 CSS 抄进 perTheme 的那条隐患已经随 perTheme 一起消失。 */
  const liveIds = new Set(packs.map(pack => 'ct-pack-' + String(pack.slug || '').trim()));
  const dropped = cfg.presets.filter(preset => preset.builtin && !liveIds.has(preset.id)).map(preset => preset.id);
  const keptPresets = cfg.presets.filter(preset => preset.builtin ? liveIds.has(preset.id) : true);
  /* 当前主题正好是撤掉的随包卡：先回最近的内置档，再保存收窄后的清单。
     否则 data-theme 还挂着 ct-pack-xxx，卡没了、内置档的规则也一条不命中，会直接变成裸页面。 */
  if (dropped.includes(themeId())) setTheme(lastBuiltin, true);
  /* 清单里后加的包会排在老卡后面，随包卡片一律按清单顺序排，
     用户自己做的卡保持原顺序跟在后面。 */
  const orderIdx = new Map(packs.map((pack, i) => ['ct-pack-' + String(pack.slug || '').trim(), i]));
  const rank = preset => (orderIdx.has(preset.id) ? orderIdx.get(preset.id) : Infinity);
  const merged = [...keptPresets, ...added];
  const ordered = merged.filter(p => p.builtin).sort((a, b) => rank(a) - rank(b))
    .concat(merged.filter(p => !p.builtin));
  const orderChanged = ordered.some((p, i) => p !== cfg.presets[i]) || ordered.length !== cfg.presets.length;
  if (!added.length && !refreshed && !dropped.length && !orderChanged) {
    try { localStorage.setItem(DEFAULT_PACKS_KEY, '1'); } catch (e) {}
    return 0;
  }
  const next = {
    ...cfg,
    presets: ordered,
    enabled: cfg.enabled,
    updatedAt: Date.now(),
  };
  writeCustomTheme(next);
  try { localStorage.setItem(DEFAULT_PACKS_KEY, '1'); } catch (e) {}
  renderCustomThemeGrid();
  return added.length + refreshed;
}
function bindCustomThemeEditor() {
  const apply = enable => {
    const cfg = readCustomTheme();
    const current = themeId();
    const css = $('ctCss')?.value || '';
    const html = $('ctHtml')?.value || '';
    const preset = activePackForTheme(cfg, current);
    /* 卡是唯一持久层：在卡片上点「保存并应用」写回这张卡；在内置档上点它，就把编辑区存成
       一张新卡再整套切过去。没有「按档草稿」这条第二路径了，所以也不存在两份账对不上。
       「停用」在卡上是回最近用过的内置档（卡还在，随时能点回来）。 */
    if (preset) {
      if (enable) {
        const presets = cfg.presets.map(item => item.id === preset.id ? { ...item, css, html } : item);
        writeCustomTheme({ ...cfg, enabled: true, presets, updatedAt: Date.now() });
        setTheme(preset.id);
        showToast('已更新「' + preset.name + '」。');
      } else {
        setTheme(lastBuiltin);
        showToast('已回到' + packScopeLabel(lastBuiltin) + '。');
      }
      renderCustomThemeGrid();
      return;
    }
    if (!enable) {
      /* 内置档没有草稿可停用：只清编辑区，回到内置样子。 */
      if ($('ctCss')) $('ctCss').value = '';
      if ($('ctHtml')) $('ctHtml').value = '';
      applyCustomTheme();
      showToast('当前是' + packScopeLabel(current) + '，没有自定义样式。');
      return;
    }
    if (!css.trim() && !html.trim()) {
      showToast('先写点 CSS 或 HTML 再保存。', 'warn');
      return;
    }
    const name = (($('ctName')?.value || '').trim() || (packScopeLabel(current) + '自写稿')).slice(0, 24);
    const card = {
      id: newCustomPresetId(), name, css, html,
      createdAt: Date.now(), builtin: false, scope: String(current),
    };
    writeCustomTheme({ ...cfg, enabled: true, presets: [...cfg.presets, card], updatedAt: Date.now() });
    if ($('ctName')) $('ctName').value = '';
    setTheme(card.id);
    renderCustomThemeGrid();
    showToast('已存成「' + card.name + '」并切了过去。');
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
    const picked = themeStyle(cfg, themeId());
    navigator.clipboard.writeText(JSON.stringify({ css: picked.css, html: picked.html }, null, 2))
      .then(() => showToast('本档配置已复制，可存成 .json 或发给别人。'))
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
  /* 每一步单独兜住：种子那步一旦抛异常，弹层和实际应用都会跟着跳过，
     用户看到的就是「随包主题一张都点不到」。 */
  try { seedDefaultThemePacks(); } catch (e) { console.warn('seed theme packs failed', e); }
  try { renderThemePopPacks(); } catch (e) { console.warn('render theme packs failed', e); }
  /* 启动早期解析时随包卡片可能还没种下，存着的包 id 会被当成「卡已删」退回内置档。
     种完之后按存储里的原意补一次，否则包卡每次都被随便一个内置档顶掉。 */
  try {
    const saved = String(localStorage.getItem('myt-theme') || '');
    if (saved.indexOf('ct-pack-') === 0 && themeId() !== saved) {
      const cfg = readCustomTheme();
      if (cfg.presets.some(item => item.id === saved && item.css)) setTheme(saved, false);
    }
  } catch (e) { console.warn('restore theme pack failed', e); }
  try { applyCustomTheme(); } catch (e) { console.warn('apply custom theme failed', e); }
  /* 其它层启动时还会 setTheme 一次同步内置色球，空闲时再刷一遍，保证弹层只亮当前主题。 */
  whenIdle(() => { try { applyCustomTheme(); } catch (e) {} });
}
if (typeof queueMicrotask === 'function') queueMicrotask(bootCustomTheme);
else setTimeout(bootCustomTheme, 0);
/* 微任务时层可能还没注册完；DOM 就绪 / 整页加载完 / 启动 1s 后各补一次（幂等）。 */
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootCustomTheme, { once: true });
window.addEventListener('load', bootCustomTheme, { once: true });
setTimeout(bootCustomTheme, 1000);
bindCustomThemeEditor();
function isDegraded() { return document.hidden || !document.hasFocus(); }

function sync() {
  document.documentElement.classList.toggle('decor-idle', isDegraded());
}

document.addEventListener('visibilitychange', sync);
window.addEventListener('blur', sync);
window.addEventListener('focus', sync);
sync();

/* Folia 的“无人值守”规则：侧栏和搜索条只在手靠近时露面。
   计时只认“贴着侧栏/搜索条”的活动，不和别处的鼠标移动混在一起；
   所以用户滑动墙面时，两条浮层不会假装还在工作。 */
(function bindFoliaQuietChrome() {
  const IDLE = 4000;
  let timer = 0;
  let navHover = false;
  let searchHover = false;
  let seenFolia = false;
  const isFolia = () => document.documentElement.dataset.theme === 'ct-pack-folia-poster';
  const sideEl = () => document.querySelector('.sidebar');
  const searchEl = () => document.querySelector('#page-home .ledger-search');
  const inside = (el, e, px, py) => {
    if (!el || !e) return false;
    const r = el.getBoundingClientRect();
    return e.clientX >= r.left - px && e.clientX <= r.right + px
      && e.clientY >= r.top - py && e.clientY <= r.bottom + py;
  };
  const searchFocused = () => {
    const el = searchEl();
    const active = document.activeElement;
    return !!(el && active && el.contains(active) && active.matches(':focus-visible'));
  };
  /* 鼠标点过的按钮仍会保持 document.activeElement，但不再有 :focus-visible；
     若只判断 activeElement，点完侧栏标签后侧栏会永久挂在屏幕上，自动隐藏失效。
     键盘 Tab 进来的焦点仍保留侧栏，避免把正在操作的控件藏掉。 */
  const navFocused = () => {
    const el = sideEl();
    const active = document.activeElement;
    return !!(el && active && el.contains(active) && active.matches(':focus-visible'));
  };
  const showNav = () => document.body.classList.remove('nav-auto-idle');
  const showSearch = () => document.body.classList.remove('search-auto-idle');
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = 0;
    if (!isFolia()) {
      document.body.classList.remove('nav-auto-idle', 'search-auto-idle');
      navHover = false;
      searchHover = false;
      return;
    }
    timer = setTimeout(() => {
      timer = 0;
      if (!isFolia()) return;
      if (!navHover && !navFocused() && !document.body.classList.contains('nav-collapsed')) {
        document.body.classList.add('nav-auto-idle');
      }
      if (!searchHover && !searchFocused()) document.body.classList.add('search-auto-idle');
    }, IDLE);
  };
  const onMove = (e) => {
    if (!isFolia()) return;
    /* 只要还在动，就重置一次空闲计时。之前只在靠近侧栏/搜索条时才起表：
       光标停在栏上超过 4 秒后再移走，表已经烧完又没人重启，侧栏会一直挂着。 */
    arm();
    const side = sideEl();
    const search = searchEl();
    const edgeRail = e.clientX <= 8;
    const onSide = inside(side, e, 8, 8);
    const onSearch = inside(search, e, 18, 18);
    const onHome = document.body.classList.contains('on-home');
    const railVisible = !document.body.classList.contains('nav-auto-idle');
    /* 首页的墙面从 x=0 开始，侧栏收起时它的矩形正压在左边封面/歌词上；
       如果按 onSide 就唤出，用户一碰左侧歌词侧栏就会跳出来把它盖住。
       首页只在真正的左缘（x<=8）唤出，已经展开后再允许在侧栏内部保持。 */
    const wantRail = edgeRail || (onSide && (!onHome || railVisible));
    if (!document.body.classList.contains('nav-collapsed') && wantRail) {
      showNav();
      navHover = true;
      arm();
    } else {
      navHover = false;
    }
    if (onSearch) {
      showSearch();
      searchHover = true;
      arm();
    } else {
      searchHover = false;
    }
  };
  document.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerdown', (e) => {
    if (!isFolia()) return;
    const onHome = document.body.classList.contains('on-home');
    const railVisible = !document.body.classList.contains('nav-auto-idle');
    const railHit = e.clientX <= 8 || (inside(sideEl(), e, 8, 8) && (!onHome || railVisible));
    /* capture 阶段把侧栏叫出来会改变 pointerup 的命中目标：首页点左侧封面时
       不能用内缩的侧栏矩形抢点击，只有真左缘或侧栏已展开时才接管。 */
    if (!document.body.classList.contains('nav-collapsed') && railHit) { showNav(); navHover = true; arm(); }
    if (inside(searchEl(), e, 18, 18)) { showSearch(); searchHover = true; arm(); }
  }, true);
  document.addEventListener('focusin', (e) => {
    if (!isFolia()) return;
    if (sideEl()?.contains(e.target)) { showNav(); arm(); }
    if (searchEl()?.contains(e.target)) { showSearch(); arm(); }
  }, true);
  document.addEventListener('keydown', () => {
    if (!isFolia()) return;
    showNav();
    showSearch();
    arm();
  }, true);
  /* 主题是异步落的：监听 <html data-theme>，只在切进/切出 Folia 时起表或收表。 */
  const syncTheme = () => {
    if (isFolia()) {
      if (!seenFolia) { seenFolia = true; arm(); }
    } else if (seenFolia) {
      seenFolia = false;
      if (timer) clearTimeout(timer);
      timer = 0;
      navHover = false;
      searchHover = false;
      document.body.classList.remove('nav-auto-idle', 'search-auto-idle');
    }
  };
  new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  syncTheme();
})();

export {
  CUSTOM_THEME_KEY, LIGHT_THEMES, REMOVED_THEME_FALLBACK, applyCustomTheme, applyCustomThemePreset,
  bindCustomThemeEditor, customPreviewColor, customThemeActiveName, importCustomTheme, isDegraded,
  lastDark, lastLight, newCustomPresetId, normalizeCustomTheme, readCustomTheme,
  renderCustomThemeGrid, sanitizeCustomHtml, saveCustomThemePreset, seedDefaultThemePacks,
  setTheme, sync, syncCustomThemeEditor, themeBase, themeBtns, themeId, themeIsLight, themePacks,
  themeSkeleton, writeCustomTheme,
};
registerLayer('13-theme', {
  sync, isDegraded, CUSTOM_THEME_KEY, LIGHT_THEMES, REMOVED_THEME_FALLBACK,
  normalizeCustomTheme, readCustomTheme, writeCustomTheme, sanitizeCustomHtml,
  customPreviewColor, customThemeActiveName, newCustomPresetId,
  setTheme, applyCustomTheme, applyCustomThemePreset, renderCustomThemeGrid,
  syncCustomThemeEditor, bindCustomThemeEditor, seedDefaultThemePacks,
  importCustomTheme, saveCustomThemePreset, themeBtns,
  themeId, themeBase, themeIsLight, themeSkeleton, themePacks,
});
