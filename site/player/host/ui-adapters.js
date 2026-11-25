/* 插件扩展入口的 UI 适配：菜单、导入器、搜索源、主题。
   这一层只认 DOM 与贡献注册表，通过 port 拿到宿主动作，不再和播放器/学习/字幕状态耦合。
   主宿主只负责创建实例、在页面渲染后调用 applyAll、以及停用时的回收。 */
import { isAbortError } from './faults.js';

export const PLUGIN_THEME_KEY = 'myt-plugin-theme';

/* 搜索结果允许两种形态：旧插件直接返回字符串/节点；2.2 起可返回
   { version, items }，宿主按版本解释。形状不认识就按 1 处理，不静默吞掉。 */
export function normalizeSearchResult(value) {
  if (Array.isArray(value)) return { version: 1, items: value };
  if (value && typeof value === 'object') {
    if (Number.isFinite(Number(value.version)) && Array.isArray(value.items)) {
      return { version: Number(value.version), items: value.items };
    }
    if (typeof value.html === 'string') return { version: 1, items: [value.html] };
  }
  return { version: 1, items: [value] };
}

export function createPluginExtensionAdapters(port = {}) {
  const doc = port.document;
  const $ = port.$;
  const esc = port.esc;
  const labelOf = rec => port.recordLabel(rec);
  let themeStyle = null;

  function records(type) {
    return port.registry.list(type);
  }

  function renderMenu() {
    const button = $('pluginMenuBtn');
    const pop = $('pluginMenuPop');
    if (!button || !pop) return;
    const list = records('menus').filter(rec => typeof rec.impl?.run === 'function');
    button.hidden = !list.length;
    button.style.display = list.length ? '' : 'none';
    pop.innerHTML = list.map(rec =>
      '<button role="menuitem" data-plugin-contribution="menu" data-plugin-owner="' + esc(rec.pluginId) +
      '" data-plugin-id="' + esc(rec.id) + '">' + esc(labelOf(rec)) + '</button>').join('');
    pop.hidden = !list.length;
    if (!list.length) { pop.classList.remove('on'); pop.style.display = 'none'; }
  }

  function renderImporters() {
    const box = $('pluginImporters');
    if (!box) return;
    const list = records('importers').filter(rec => typeof rec.impl?.run === 'function');
    box.innerHTML = list.map(rec => port.contributionButton('importer', rec, labelOf(rec))).join('');
    box.hidden = !list.length;
    box.style.display = list.length ? 'flex' : 'none';
  }

  function renderSearchSources() {
    const box = $('pluginSearchSources');
    const results = $('pluginSearchResults');
    if (!box) return;
    const list = records('searchSources').filter(rec => typeof rec.impl?.search === 'function');
    box.innerHTML = list.length
      ? '<span class="smalltext">插件搜索源</span>'
        + list.map(rec => port.contributionButton('searchSource', rec, labelOf(rec))).join('')
      : '';
    box.hidden = !list.length;
    box.style.display = list.length ? 'flex' : 'none';
    const activeKey = port.searchGate.snapshot().key;
    const stale = activeKey && !list.some(rec => rec.pluginId + ':' + rec.id === activeKey);
    if ((!list.length || stale) && results) {
      port.searchGate.invalidate();
      results.replaceChildren();
      results.hidden = true;
      results.style.display = 'none';
    }
  }

  function showSearchResult(rec, value) {
    const box = $('pluginSearchResults');
    if (!box) return;
    const normalized = normalizeSearchResult(value);
    box.hidden = false;
    box.style.display = 'flex';
    const panel = doc.createElement('div');
    panel.className = 'plugin-search-result';
    panel.dataset.resultVersion = String(normalized.version);
    const title = doc.createElement('div');
    title.className = 'section-title';
    title.textContent = '插件搜索 · ' + (labelOf(rec) || rec.id);
    const body = doc.createElement('div');
    body.className = 'plugin-search-body';
    const append = item => {
      if (item == null) return;
      if (typeof item === 'string') body.insertAdjacentHTML('beforeend', item);
      else if (item.nodeType) body.append(item);
      else body.insertAdjacentHTML('beforeend', String(item));
    };
    normalized.items.forEach(append);
    if (!body.childNodes.length) body.textContent = '这个搜索源没有返回结果。';
    panel.append(title);
    panel.append(body);
    box.replaceChildren();
    box.append(panel);
  }

  function themeCss(rec) {
    return String(rec?.impl?.css || rec?.impl?.style || '').trim();
  }

  function ensureThemeStyle() {
    if (themeStyle && themeStyle.isConnected) return themeStyle;
    themeStyle = doc.createElement('style');
    themeStyle.id = 'pluginThemeStyle';
    doc.head.append(themeStyle);
    return themeStyle;
  }

  function syncThemeCards() {
    let active = '';
    try { active = port.storage.getItem(PLUGIN_THEME_KEY) || ''; } catch (e) {}
    doc.querySelectorAll('[data-plugin-theme]').forEach(card => {
      card.setAttribute('aria-checked', String(card.dataset.pluginTheme === active));
    });
    return active;
  }

  function clearTheme() {
    const style = themeStyle || doc.getElementById('pluginThemeStyle');
    if (style) { style.textContent = ''; style.remove(); }
    themeStyle = null;
    try { port.storage.removeItem(PLUGIN_THEME_KEY); } catch (e) {}
    syncThemeCards();
  }

  function applyTheme(rec, silent = false) {
    const css = themeCss(rec);
    if (!rec || !css) { port.notify('这个插件主题没有可用样式。', 'warn'); return false; }
    if (typeof port.preparePluginTheme === 'function') port.preparePluginTheme();
    ensureThemeStyle().textContent = css;
    try { port.storage.setItem(PLUGIN_THEME_KEY, rec.pluginId + ':' + rec.id); } catch (e) {}
    syncThemeCards();
    if (!silent) port.notify('已应用插件主题「' + (labelOf(rec) || rec.id) + '」。');
    return true;
  }

  function renderThemes() {
    const grid = $('themeGrid');
    if (!grid) return;
    const saved = syncThemeCards();
    const savedRec = saved && port.contributionRecord('themes', saved.split(':')[0], saved.split(':').slice(1).join(':'));
    if (savedRec && themeCss(savedRec) && typeof port.preparePluginTheme === 'function') port.preparePluginTheme();
    grid.querySelectorAll('[data-plugin-theme]').forEach(node => node.remove());
    records('themes').filter(rec => themeCss(rec)).forEach(rec => {
      const card = doc.createElement('button');
      card.type = 'button';
      card.className = 'theme-card plugin-theme';
      card.dataset.pluginTheme = rec.pluginId + ':' + rec.id;
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', 'false');
      card.innerHTML = '<span class="sw plugin-theme-sw"></span>' + esc(labelOf(rec) || rec.id);
      grid.append(card);
    });
    const active = syncThemeCards();
    if (!active) { if (themeStyle) themeStyle.textContent = ''; return; }
    const rec = port.contributionRecord('themes', active.split(':')[0], active.split(':').slice(1).join(':'));
    if (!rec) clearTheme();
    else if (themeCss(rec)) ensureThemeStyle().textContent = themeCss(rec);
  }

  function applyAll() {
    renderMenu();
    renderImporters();
    renderSearchSources();
    renderThemes();
  }

  function closeMenu() {
    const pop = $('pluginMenuPop');
    if (pop) { pop.hidden = true; pop.classList.remove('on'); pop.style.display = 'none'; }
  }

  function bindEvents() {
    doc.addEventListener('click', async event => {
      const toggle = event.target.closest('#pluginMenuBtn');
      if (toggle) {
        const pop = $('pluginMenuPop');
        if (pop) {
          const on = !pop.classList.contains('on');
          pop.hidden = !on;
          pop.classList.toggle('on', on);
          pop.style.display = on ? 'flex' : 'none';
          toggle.setAttribute('aria-expanded', String(on));
        }
        return;
      }
      if (!event.target.closest('#pluginMenuPop')) closeMenu();
      const themeCard = event.target.closest('[data-plugin-theme]');
      if (themeCard) {
        const at = themeCard.dataset.pluginTheme.indexOf(':');
        if (at > 0) {
          const rec = port.contributionRecord('themes',
            themeCard.dataset.pluginTheme.slice(0, at), themeCard.dataset.pluginTheme.slice(at + 1));
          if (rec) applyTheme(rec);
        }
        return;
      }
      const trigger = event.target.closest('[data-plugin-contribution]');
      if (!trigger) return;
      const kind = trigger.dataset.pluginContribution;
      const owner = trigger.dataset.pluginOwner;
      const id = trigger.dataset.pluginId;
      if (kind === 'menu') {
        closeMenu();
        try { await port.runContribution(owner, 'menus', id, 'run'); }
        catch (err) { if (!isAbortError(err)) port.notify('菜单命令失败：' + (err.message || err), 'warn'); }
        return;
      }
      if (kind === 'importer') {
        trigger.disabled = true;
        try {
          await port.runContribution(owner, 'importers', id, 'run');
          port.notify('插件导入已完成。');
        } catch (err) {
          if (!isAbortError(err)) port.notify('导入失败：' + (err.message || err), 'warn');
        } finally { trigger.disabled = false; }
        return;
      }
      if (kind === 'searchSource') {
        const query = String($('searchInput')?.value || '').trim();
        if (!query) { port.notify('先输入搜索词。', 'warn'); return; }
        const searchKey = owner + ':' + id;
        const seq = port.searchGate.begin(searchKey);
        const signal = port.searchGate.signal();
        const results = $('pluginSearchResults');
        if (results) {
          results.hidden = false;
          results.style.display = 'flex';
          results.innerHTML = port.loaderHTML('正在用插件搜索源查询…');
        }
        trigger.disabled = true;
        try {
          const value = await port.runContribution(owner, 'searchSources', id, 'search', [query], { signal });
          if (!port.searchGate.current(seq, searchKey)) return;
          const rec = port.contributionRecord('searchSources', owner, id);
          if (!rec) return;
          showSearchResult(rec, value);
        } catch (err) {
          if (port.searchGate.current(seq, searchKey) && results && !isAbortError(err)) {
            results.innerHTML = '<div class="smalltext err">搜索源失败：' + esc(err.message || err) + '</div>';
          }
        } finally { trigger.disabled = false; }
      }
    });
    doc.addEventListener('myt:theme-change', () => { clearTheme(); });
    doc.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
  }

  const api = {
    renderMenu, renderImporters, renderSearchSources, renderThemes,
    showSearchResult, applyTheme, clearTheme, applyAll, bindEvents,
  };
  api.ready = true;
  Object.freeze(api);
  return api;
}
