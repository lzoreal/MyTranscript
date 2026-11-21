import { $, box, host, prefs, setState, state, tauriHost } from './00-runtime.js';
import { emptyLine, esc, fmt, isBracket, isJsonTranscript, loaderHTML, pluginPageKey, reader, seekTo, showToast, statHTML, syncCustomThemeEditor } from './01-theme-reader-shell.js';
import { syncLiveLeadSelect } from './02-live-caption-wasm.js';
import { selectEpisode } from './03-native-asr-service-worker.js';
import { PLUGIN_PAGES, applySlotMounts, destroyV2Page, emitPlugin, loadShow, pluginPlayerState, pluginReportError, refreshPluginSettings, renderPluginPage, renderV2Page } from './04-local-audio-plugin-host.js';
import { LOCAL_KEY, PAGE_NAMES, QUEUE_KEY, THEME_NAMES, absoluteFeed, app, catalogLatest, epStatusBadges, episodeFilterMatch, episodesOf, firstShowKey, fmtBytes, fmtDuration, formatDate, hash32, hostOf, idxGetAll, inboxCount, isFavorite, isPlayed, isSubscribed, moduleOn, navigate, offlineKeyFor, parseRoute, plainText, readAllProgress, refreshShows, renderAfterStateChange, renderDownloads, renderOfflineList, renderPlaylists, returnToCue, routeHash, routeModuleAllows, showByKey, showPrefFor, syncDockBadge, syncDockSleep, syncIndexCount, syncRateSeg, writeJSON } from './05-transport-transcript-nav.js';
import { coverHTML, ensureShowFeed, episodeCover, hasFreshFeed, memoryFeed, renderOnlineResults } from './06-catalog-feeds-search.js';
import { motionFlip, motionReduced } from './11-motion.js';



import { lazyFn, registerLayer } from './00-layers.js';
const syncStudySettings = lazyFn('08-study-ai', 'syncStudySettings');
const syncThemeSwatches = lazyFn('08-study-ai', 'syncThemeSwatches');
const syncBookmarkBtn = lazyFn('09-player-integration', 'syncBookmarkBtn');
const syncMini = lazyFn('09-player-integration', 'syncMini');
const syncMiniCaption = lazyFn('09-player-integration', 'syncMiniCaption');
const syncReaderTop = lazyFn('09-player-integration', 'syncReaderTop');
const closeThemePop = lazyFn('10-desktop-bridge-tail', 'closeThemePop');
const syncAutoNextSwitch = lazyFn('10-desktop-bridge-tail', 'syncAutoNextSwitch');
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
let pageExitTimer = 0;
let pageExitToken = 0;
function applyRoute() {
  const route = parseRoute();
  if (route.page === 'echo') { navigate('stats'); return; }
  pageExitToken += 1;
  const token = pageExitToken;
  clearTimeout(pageExitTimer);
  document.querySelectorAll('.page.anim-page-leave').forEach(el => el.classList.remove('anim-page-leave'));
  const current = document.querySelector('.page.active');
  const nextId = 'page-' + route.page;
  /* 页面退出只做一次短淡出；减少动态效果或标签页不可见时直接切换。 */
  if (current && current.id !== nextId && !motionReduced() && !document.hidden) {
    current.classList.add('anim-page-leave');
    pageExitTimer = setTimeout(() => {
      if (token !== pageExitToken) return;
      current.classList.remove('anim-page-leave');
      applyRouteNow(route);
    }, 130);
    return;
  }
  applyRouteNow(route);
}
function applyRouteNow(route) {
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
  if (isPlayer) { destroyV2Page(); openPlayerRoute(route); return; }
  if (!PAGE_NAMES[route.page]) { navigate('home'); return; }
  app.lastPage = route.page;
  renderPage(route.page, route);  emitPlugin('route:change', { page: route.page, args: route.args });
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
  if (renderV2Page(page)) {
    enhanceClickableRows();
    applySlotMounts(document);
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
  applySlotMounts(document);
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
function setSearchTab(value) { searchTab = String(value || 'all'); }
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
  motionFlip($('searchResults'), '.ep-row', () => {
    $('searchResults').innerHTML = html || emptyLine('没有找到匹配结果，试试其他关键词。');
  });
  enhanceClickableRows();
}

/* ---------- podcast / episode ---------- */
function renderLocal() {
  const hint = $('localHint');
  if (hint) hint.textContent = app.local.length ? app.local.length + ' 个本地音频 · 只读本机文件' : '从本机文件夹导入音频；不会上传，也不占离线目录。';
  const localBox = $('localList');
  motionFlip(localBox, '.ep-row', () => {
  localBox.innerHTML = app.local.length
    ? '<div class="ep-filter-row"><span class="smalltext">' + app.local.length + ' 个文件</span></div>' +
      app.local.map(ep => '<div class="ep-row" data-motion-key="' + esc(ep.id) + '" ' + (ep.kind === 'video'
        ? 'data-open-video="' + esc(ep.id) + '"'
        : 'data-play-episode data-key="local-files" data-ep="' + esc(ep.id) + '"') + '>' +
        '<span class="ep-art">' + (ep.kind === 'video' ? '▶' : esc((ep.title || '?').slice(0, 2).toUpperCase())) + '</span>' +
        '<div class="ep-body"><span class="ep-title">' + esc(ep.title || ep.name) + '</span><span class="ep-sub">' +
        esc(ep.localPath || '') + ' · ' + fmtBytes(ep.size) + (ep.kind === 'video' ? ' · 视频' : '') + '</span></div>' +
        '<button class="mini-btn" data-del-local="' + esc(ep.id) + '" title="从列表移除">✕</button></div>').join('')
    : emptyLine('还没有本地音频。点右上角「导入文件夹」，会递归扫描 3 层内的音频文件。');
  });
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
    bindVideoExtras(video, ep);
  }
}
/* 视频页原来只有一个裸 <video>：关掉就忘了看到哪，字幕也完全不显示。
   这里补两件小事——按集记住播放位置、有 cue 时把当前句叠在画面上。
   字幕只对「已经加载过文字稿的这一集」生效：本地视频本来就没有文字稿。 */
function videoProgressKey(ep) { return 'myt-video-progress:' + String(ep && ep.id ? ep.id : ''); }
function bindVideoExtras(video, ep) {
  if (video.dataset.extrasBound !== '1') {
    video.dataset.extrasBound = '1';
    let lastSave = 0;
    video.addEventListener('timeupdate', () => {
      const cuesBox = $('videoCues');
      const playing = ep || null;
      const cues = (state.current && playing && state.current.id === playing.id) ? state.cues : [];
      const overlay = syncVideoCues(cuesBox, cues, video.currentTime);
      if (cuesBox) cuesBox.hidden = !overlay;
      const now = Date.now();
      if (playing && video.currentTime > 0 && now - lastSave > 2000) {
        lastSave = now;
        writeJSON(videoProgressKey(playing), {
          t: Math.round(video.currentTime), duration: Math.round(video.duration || 0), updatedAt: now,
        });
      }
    });
    video.addEventListener('loadedmetadata', () => {
      if (!ep) return;
      const saved = readJSON(videoProgressKey(ep), null);
      if (!saved || !saved.t) return;
      const total = Number(video.duration) || 0;
      if (total && saved.t > total - 10) return; // 快看完了就别跳回去
      if (saved.t < 8) return;
      video.currentTime = saved.t;
      showToast('从 ' + fmtClock(saved.t) + ' 继续', 3000);
    });
  }
}
function syncVideoCues(box, cues, time) {
  if (!box) return '';
  if (!Array.isArray(cues) || !cues.length) return '';
  let hit = null;
  for (let i = 0; i < cues.length; i += 1) {
    if (Number(cues[i].start) <= time + 0.05) hit = cues[i];
    else break;
  }
  if (!hit || time > Number(hit.end) + 1.5) return '';
  return String(hit.text || '');
}
function fmtClock(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ':' + String(s).padStart(2, '0');
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
/* 单集页给插件槽位的载荷：只放「插件自己也拿不到」的字段——当前这一集的
   id、名单、替代音源、本机路径。播放进度之类的走 api.player.state，不塞进来，
   免得同一份数据两个真源。 */
function epSlotPayload(show, ep, offlineRec) {
  const payload = {
    showKey: show.slug,
    showName: show.name || '',
    episodeId: ep.id,
    title: ep.title || '',
    duration: Number(ep.duration) || 0,
    video: !!ep.video,
    videoUrl: ep.videoUrl || '',
    hasTranscript: !!ep.transcript?.url,
    localPath: ep.localPath || (offlineRec && offlineRec.path) || '',
    persons: (ep.persons || []).slice(0, 12),
    alternates: (ep.alternates || []).slice(0, 6),
  };
  try { return esc(JSON.stringify(payload)); } catch (err) { return ''; }
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
    '</div><span class="plugin-slot" data-plugin-slot="episode.header.actions" data-slot-payload="' + epSlotPayload(show, ep, offlineRec) + '" data-slot-payload-version="1"></span></div></div>' +
    '<div class="plugin-slot" data-plugin-slot="episode.body.before" data-slot-payload="' + epSlotPayload(show, ep, offlineRec) + '" data-slot-payload-version="1"></div>' +
    '<div class="card card-pad" style="margin-top:16px"><h3 class="section-title">简介</h3><p class="smalltext" style="margin:0">' +
    esc(desc || '该 feed 没有提供单集简介。') + '</p></div>';
  enhanceClickableRows();
  applySlotMounts(view);
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
  const inboxBox = $('inboxList');
  motionFlip(inboxBox, '.ep-row', () => {
  inboxBox.innerHTML = app.inbox.length
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
  });
  enhanceClickableRows();
}
function renderFavorites() {
  const items = [...app.favorites].map(key => {
    const at = key.indexOf(':');
    return { showKey: key.slice(0, at), epId: key.slice(at + 1) };
  }).filter(item => item.showKey && item.epId);
  const favoriteBox = $('favoriteList');
  motionFlip(favoriteBox, '.ep-row', () => {
  favoriteBox.innerHTML = items.length
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
  });
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
  const queueBox = $('queueList');
  motionFlip(queueBox, '.ep-row', () => {
  queueBox.innerHTML = app.queue.length
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
  });
  enhanceClickableRows();
}
function renderHistory() {
  const all = readAllProgress();
  const entries = Object.entries(all).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  const finished = entries.filter(([, rec]) => rec.d && rec.t >= rec.d - 30).length;
  $('historyStats').innerHTML = statHTML('收听记录', entries.length, '有播放位置的单集')
    + statHTML('听完', finished, '接近结尾')
    + statHTML('最近一次', entries[0]?.[1]?.at ? new Date(entries[0][1].at).toLocaleDateString('zh-CN') : '—', '');
  const historyBox = $('historyList');
  motionFlip(historyBox, '.ep-row', () => {
  historyBox.innerHTML = entries.length
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
  });
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
  const bookmarkBox = $('bookmarkList');
  motionFlip(bookmarkBox, '.ep-row', () => {
  bookmarkBox.innerHTML = app.bookmarks.length
    ? app.bookmarks.map(item => '<div class="ep-row" data-resume data-key="' + esc(item.key) + '" data-ep="' +
      esc(item.ep) + '" data-t="' + Number(item.t || 0) + '"><span class="ep-dur">' + fmt(item.t) + '</span>' +
      '<div class="ep-body"><span class="ep-title">“' + esc(item.en || '') + '”</span><span class="ep-sub">' +
      esc(item.show || '') + ' · ' + esc(item.title || '') + (item.zh ? ' · ' + esc(item.zh) : '') +
      '</span></div><button class="mini-btn" data-del-bookmark="' + esc(item.id) + '">✕</button></div>').join('')
    : emptyLine('还没有书签。播放时点右上角 ☆ 收藏当前句。');
  });
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
  const notesBox = $('notesList');
  motionFlip(notesBox, '.note-item', () => {
  notesBox.innerHTML = app.notes.length
    ? app.notes.map(item => '<div class="note-item" data-motion-key="' + esc(item.id) + '"><strong>' + esc(item.title) + '</strong><p>' + esc(item.body) +
      '</p><small>' + esc(item.show || '') + ' · ' + new Date(item.at).toLocaleString('zh-CN') +
      '</small><div style="margin-top:6px"><button class="mini-btn" data-del-note="' + esc(item.id) + '">✕</button></div></div>').join('')
    : emptyLine('还没有笔记。');
  });
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
export { CATEGORY_LABELS, LISTEN_APPEARANCE, LISTEN_CONTINUE, TR, TR_CACHE, TR_DEFAULTS, TR_KEY, addToQueue, applyRoute, categoryLabel, coverageHTML, enhanceClickableRows, episodeRowHTML, filterCatalogShows, fmtHours, idxSearch, importLocalFolder, inboxEpisode, openPlayerRoute, podCardHTML, primaryCategory, renderAutoSettings, renderBookmarks, renderDiscover, renderEcho, renderEpisode, renderFavorites, renderHistory, renderHome, renderInbox, renderLibrary, renderListenGroup, renderListening, renderLocal, renderNotes, renderPage, renderPodcast, renderQueue, renderSearch, renderSettings, renderStats, renderVideo, saveQueue, searchIndex, searchTab, setSearchTab, showCategories, showCategoryText, showLanguageLabel, syncDiscoverControls, syncTranslateSettings, trBatch, trConfig, trLastErrorAt, trNative, trNoteError, trPrimeCues, trReady, trSave, trStatus, trText, transcriptCoverage, updateDocumentTitle };
registerLayer('07-routes-pages', { CATEGORY_LABELS, LISTEN_APPEARANCE, LISTEN_CONTINUE, TR, TR_CACHE, TR_DEFAULTS, TR_KEY, addToQueue, applyRoute, categoryLabel, coverageHTML, enhanceClickableRows, episodeRowHTML, filterCatalogShows, fmtHours, idxSearch, importLocalFolder, inboxEpisode, openPlayerRoute, podCardHTML, primaryCategory, renderAutoSettings, renderBookmarks, renderDiscover, renderEcho, renderEpisode, renderFavorites, renderHistory, renderHome, renderInbox, renderLibrary, renderListenGroup, renderListening, renderLocal, renderNotes, renderPage, renderPodcast, renderQueue, renderSearch, renderSettings, renderStats, renderVideo, saveQueue, searchIndex, searchTab, setSearchTab, showCategories, showCategoryText, showLanguageLabel, syncDiscoverControls, syncTranslateSettings, trBatch, trConfig, trLastErrorAt, trNative, trNoteError, trPrimeCues, trReady, trSave, trStatus, trText, transcriptCoverage, updateDocumentTitle });
