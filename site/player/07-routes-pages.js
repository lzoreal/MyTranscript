import { $, ASR_MODEL_DEFAULT, audio, box, host, prefs, setState, state, tauriHost } from './00-runtime.js';
import { closeOverlays, closeTypeSheet, emptyLine, esc, fmt, isBracket, isJsonTranscript, loaderHTML, pluginPageKey, reader, seekTo, setImmersive, setWallpaper, showToast, splitLabel, statHTML, syncCustomThemeEditor } from './01-theme-reader-shell.js';
import { syncLiveLeadSelect } from './02-live-caption-wasm.js';
import { selectEpisode } from './03-native-asr-service-worker.js';
import { PLUGIN_PAGES, applySlotMounts, destroyV2Page, emitPlugin, loadShow, pluginPlayerState, pluginReportError, refreshPluginSettings, renderPluginPage, renderV2Page, smallArtwork, subtitlePluginOn } from './04-local-audio-plugin-host.js';
import { LOCAL_KEY, PAGE_NAMES, QUEUE_KEY, THEME_NAMES, absoluteFeed, app, catalogLatest, epStatusBadges, episodeFilterMatch, episodesOf, firstShowKey, fmtBytes, fmtDuration, formatDate, hash32, hostOf, idxGetAll, inboxCount, isFavorite, isPlayed, isSubscribed, moduleOn, navigate, notifyPlayTargetFailure, offlineKeyFor, parseRoute, plainText, playTarget, playTargetLabel, readAllProgress, readJSON, refreshShows, renderAfterStateChange, refreshOffline, renderDownloads, renderOfflineList, renderPlaylists, returnToCue, routeHash, routeModuleAllows, showByKey, showPrefFor, syncDockBadge, syncDockSleep, syncIndexCount, syncRateSeg, writeJSON } from './05-transport-transcript-nav.js';
import { coverHTML, ensureShowFeed, episodeCover, hasFreshFeed, memoryFeed, renderOnlineResults } from './06-catalog-feeds-search.js';
import { motionFlip, motionReduced } from './11-motion.js';



import { lazyFn, registerLayer } from './00-layers.js';
const syncStudySettings = lazyFn('08-study-ai', 'syncStudySettings');
const syncThemeSwatches = lazyFn('08-study-ai', 'syncThemeSwatches');
const asrModelName = lazyFn('05-transport-transcript-nav', 'asrModelName');
const syncBookmarkBtn = lazyFn('09-player-integration', 'syncBookmarkBtn');
const syncMini = lazyFn('09-player-integration', 'syncMini');
const setRailOpen = lazyFn('09-player-integration', 'setRailOpen');
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
  /* routePage 是此刻真正打开的页面，lastPage 只留给返回按钮用「上一页」。
     两者混用会让播放器/视频页把自己的页面记成上一页，返回按钮就原地跳。 */
  const currentPage = app.routePage || '';
  /* 先排除别名与未知路由，别让一次无效跳转先保存/清零首页位置。 */
  if (route.page === 'echo') { navigate('stats'); return; }
  if (!PAGE_NAMES[route.page]) { navigate('home'); return; }
  /* 全屏封面是原生 dialog，盖在整个应用上；换页（尤其 Alt+左键/历史返回）时
     不关它，就会回到首页后仍被一整屏封面糊住，而且 Esc 之外没有任何出口。 */
  if ($('coverStage')?.open) closeCoverStage();
  /* 首页和别的页共用一个滚动容器：离开首页时把墙的位置记下来，回来时还原。
     任何别的页面切换也一并归零，否则播客库滚到一半再切发现页，会从半截开始。 */
  const sc = document.querySelector('.main');
  const jumpTop = top => {
    if (!sc) return;
    try { sc.scrollTo({ top, behavior: 'instant' }); }
    catch (e) { sc.scrollTop = top; }
  };
  if (sc && currentPage) {
    if (currentPage === 'home') app.homeScroll = sc.scrollTop;
    if (route.page !== 'home') jumpTop(0);
  }
  // 离开视频页就一起收：画面停、旁路转写停（进度已由 timeupdate 落盘，回来自动接上）。
  if (currentPage === 'video' && route.page !== 'video') leaveVideoPage();
  /* 播放器的沉浸/壁纸/侧栏是播放页专属，离开后必须退回普通外壳，
     否则首页会带着 body.immersive 把底栏藏掉，或者整屏壁纸盖住应用。 */
  if (currentPage === 'player' && route.page !== 'player') {
    if (state.wallpaper) setWallpaper(false).catch(() => {});
    if (state.immersive) setImmersive(false);
    closeOverlays(false);
    closeTypeSheet(false);
    if (typeof setRailOpen === 'function') {
      setRailOpen('series', false, false);
      setRailOpen('notes', false, false);
    }
  }
  app.routePage = route.page;
  if (currentPage && currentPage !== route.page) app.lastPage = currentPage;
  const isPlayer = route.page === 'player';
  document.body.classList.toggle('player-open', isPlayer);
  // 首页自己的 hero 已经有搜索框，顶栏那个不再重复出现。
  document.body.classList.toggle('on-home', route.page === 'home');
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
  renderPage(route.page, route);  emitPlugin('route:change', { page: route.page, args: route.args });
  if (route.page === 'home' && currentPage && currentPage !== 'home') {
    const top = app.homeScroll || 0;
    if (sc) requestAnimationFrame(() => { if (app.routePage === 'home') jumpTop(top); });
  }
  if (route.page === 'home' && !audio.paused) startTileLyricLoop();
  updateDocumentTitle();
  syncMini();
}
async function openPlayerRoute(route) {
  const key = route.args[0] || state.current?.showKey || app.lastShowKey || firstShowKey();
  const ep = route.args[1] || '';
  const t = Number(route.params.get('t')) || 0;
  app.pendingSeek = t > 0 ? t : 0;
  app.pendingSeekEp = t > 0 ? ep : '';
  if (!key) { showToast('先选择一集再开始收听。', 5000); box.innerHTML = '<div class="empty">先选择一集开始收听。</div>'; return; }
  const show = showByKey(key);
  if (!show) {
    notifyPlayTargetFailure(playTarget(key, ep || 'x'));
    navigate('home');
    return;
  }
  if (ep) {
    const target = playTarget(key, ep);
    if (!target.ok) {
      notifyPlayTargetFailure(target);
      navigate(show.local ? 'local' : 'podcast', show.local ? [] : [show.slug]);
      return;
    }
  }
  setState('pendingFollow', true);
  if (state.show?.slug !== show.slug || (ep && state.current?.id !== ep)) {
    const loaded = await loadShow(show.slug, ep || undefined, { strict: !!ep });
    if (!loaded && ep) {
      app.pendingSeek = 0; app.pendingSeekEp = '';
      showToast(show.local ? '这个本地文件已经不在列表里了。' : '这一集打不开，节目源可能暂时不可用。', 7000);
      navigate(show.local ? 'local' : 'podcast', show.local ? [] : [show.slug]);
      return;
    }
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
  if (page === 'downloads') {
    /* 进下载页先按磁盘实际内容重读一次。壳推的 myt://offline 事件可能没到
       （窗口失焦、监听还没挂上、限流），只信事件的话页面就是进应用时的旧快照，
       表现就是「下载完了，列表里没有，刷新一下才出来」。 */
    refreshOffline();
  }
  if (renderV2Page(page)) {
    enhanceClickableRows();
    applySlotMounts(document);
    // 首页现在由 home 插件渲染，宿主只在它画完之后补一张「继续看视频」卡。
    if (page === 'home') {
      // 首页由 home 插件渲染，但「继续收听」必须由宿主再校验一次：
      // 插件可能来自旧安装，仍会把已删除本地文件的孤儿进度画成卡片。
      renderHomeContinue();
      appendHomeVideoCard();
      renderHomeOnboard();
      setTimeout(() => { renderHomeContinue(); appendHomeVideoCard(); renderHomeOnboard(); }, 0);
    }
    return;
  }
  if (page === 'home') renderHome();
  else if (page === 'library') renderLibrary();
  else if (page === 'local') renderLocal();
  else if (page === 'downloads') renderDownloads();
  else if (page === 'video') renderVideo();
  else if (page === 'discover') renderDiscover();
  else if (page === 'search') renderSearch(route.args[0] || '');
  else if (page === 'podcast') {
    /* #/podcast 不带 slug 是「回主页」的入口（顶栏的 ← 主页），不是某一档节目：
       以前按空 key 去查节目，查不到就弹「找不到这档节目」再跳回家，每次回主页都闪一个假错误。 */
    const showKey = route.args[0] || '';
    if (!showKey) { navigate('home'); return; }
    renderPodcast(showKey); afterPodcastRender();
  }
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
/* 字幕是桌面插件能力。网页版没有宿主，不能沿用“100% 覆盖”的说法；
   所有徽章、详情、单集页统一走这里，避免文案说有、点进去却没有。 */
function subtitleCapability() {
  try { if (subtitlePluginOn()) return 'on'; } catch (e) {}
  return host() ? 'desktop-off' : 'web';
}
function subtitleCardBadge(show) {
  const cap = subtitleCapability();
  if (cap === 'on') return show?.transcript_count ? '双语词级文字稿' : '增强文字稿';
  return cap === 'web' ? '网页版仅音频' : '字幕插件未启用';
}
function subtitleShowSuffix(show) {
  const cap = subtitleCapability();
  if (cap === 'on') return show?.builtin ? ' · 双语词级文字稿' : ' · 站外节目仅音频';
  if (cap === 'web') return show?.builtin ? ' · 网页版仅音频（桌面版支持字幕）' : ' · 站外节目仅音频';
  return ' · 字幕插件未启用，仅音频';
}
function subtitleKvLabel(show) {
  const cap = subtitleCapability();
  if (cap === 'on') return show?.builtin ? '双语词级' : '无';
  return cap === 'web' ? '网页版仅音频' : '字幕插件未启用';
}
function subtitleEpisodeLabel(show, ep) {
  const cap = subtitleCapability();
  if (cap === 'web') return '网页版仅音频';
  if (cap === 'desktop-off') return '字幕插件未启用';
  if (ep?.transcript) return '含双语文字稿';
  return show?.builtin ? '无字幕' : '仅音频';
}
function coverageHTML(show) {
  const total = Number(show?.episode_count) || 0;
  const done = Number(show?.transcript_count) || 0;
  if (!show?.builtin || !total || !done) return '';
  // 网页版没有字幕插件，覆盖率数字只会制造“点了却没有”的落差。
  if (subtitleCapability() !== 'on') return '';
  return '<span class="pill">文字稿 ' + done + '/' + total + ' 集 · ' + transcriptCoverage(show) + '%</span>';
}
function podCardHTML(show) {
  const count = show.episode_count || catalogLatest(show).length || 0;
  const meta = [showCategoryText(show), showLanguageLabel(show)].filter(Boolean).join(' · ');
  const desc = plainText(show.description || '');
  const latest = catalogLatest(show)[0] || null;
  const badge = show.builtin
    ? '<span class="pill' + (subtitleCapability() === 'on' ? '' : ' dim') + '">' + subtitleCardBadge(show) + '</span>'
    : '<span class="pill dim">站外 · 仅音频</span>';
  // 内置订阅→进节目页管理；内置未订阅→订阅；站外订阅→进节目页（不把“＋”做成退订）
  const subscribed = isSubscribed(show.slug);
  const actionLabel = show.builtin ? (subscribed ? '管理中' : '订阅') : '打开';
  const action = show.builtin
    ? (subscribed
      ? '<button class="btn small ghost" data-open-podcast="' + esc(show.slug) + '" data-quick="manage" title="管理中" aria-label="管理中">管理中</button>'
      : '<button class="btn small primary" data-sub-toggle="' + esc(show.slug) + '" data-quick="add" title="订阅" aria-label="订阅">订阅</button>')
    : '<button class="btn small ghost" data-open-podcast="' + esc(show.slug) + '" data-quick="open" title="打开节目" aria-label="打开节目">打开</button>';
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
/* ---- 主题动效钩子：瓦片 → 节目页封面延续；正在播放的单集行标记 ---- */
let coverFeFrom = null;
document.addEventListener('pointerdown', (e) => {
  const card = e.target && e.target.closest ? e.target.closest('.pod-card') : null;
  if (!card) return;
  const r = card.getBoundingClientRect();
  if (!r.width || !r.height) return;
  coverFeFrom = { x: r.left, y: r.top, w: r.width, h: r.height, at: Date.now() };
}, true);

function afterPodcastRender() {
  bindPlayingRowSync();
  applyCoverFe();
  syncPlayingRows();
}

/* 把瓦片的位置写成 CSS 变量喂给封面：主题用它能做“从这块瓦片原位放大成通栏封面”。 */
function applyCoverFe() {
  const hero = document.querySelector('#page-podcast .show-hero');
  const from = coverFeFrom;
  coverFeFrom = null;
  if (!hero || !from || Date.now() - from.at > 1200 || motionReduced()) return;
  const r = hero.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const top = Math.max(0, Math.round(from.y - r.top));
  const left = Math.max(0, Math.round(from.x - r.left));
  const right = Math.max(0, Math.round(r.right - (from.x + from.w)));
  const bottom = Math.max(0, Math.round(r.bottom - (from.y + from.h)));
  hero.style.setProperty('--fe-inset', top + 'px ' + right + 'px ' + bottom + 'px ' + left + 'px');
  hero.style.setProperty('--fe-radius', Math.max(2, Math.min(14, Math.round(from.w * 0.03))) + 'px');
  hero.classList.add('is-fe');
  const clear = () => {
    hero.classList.add('is-fe-done');
    hero.classList.remove('is-fe');
    hero.style.removeProperty('--fe-inset');
    hero.style.removeProperty('--fe-radius');
  };
  hero.addEventListener('animationend', clear, { once: true });
  setTimeout(clear, 900);
}

function syncPlayingRows() {
  const cur = state.current;
  const key = (cur && cur.showKey) || '';
  const id = (cur && cur.id) || '';
  const el = document.querySelector('audio');
  const live = el ? !el.paused : false;
  document.querySelectorAll('.ep-row').forEach(row => {
    const on = !!key && row.dataset.key === key && row.dataset.ep === id;
    row.classList.toggle('is-playing', on);
    if (on) row.classList.toggle('is-playing-live', live);
    else row.classList.remove('is-playing-live');
  });
}
/* 播放器 <audio> 由 00-runtime 建好挂到 body 上，这里只能到运行时再取，不能在模块顶层引用。 */
function bindPlayingRowSync() {
  const el = document.querySelector('audio');
  if (!el || el.dataset.mytPlayingSync) return;
  el.dataset.mytPlayingSync = '1';
  el.addEventListener('play', () => { syncPlayingRows(); syncPlayingTiles(); startTileLyricLoop(); });
  el.addEventListener('pause', () => { syncPlayingRows(); syncPlayingTiles(); stopTileLyricLoop(); });
  let lyricQueued = 0;
  el.addEventListener('timeupdate', () => {
    if (lyricQueued) return;
    lyricQueued = requestAnimationFrame(() => { lyricQueued = 0; updateTileLyric(); });
  });
  el.addEventListener('seeked', () => tileWordPaint());
}
/* 首页瓦片：正在播放的那个节目的瓦片亮起珊瑚描边（Folia 的“正在播放”标记） */
function syncPlayingTiles() {
  const folia = document.documentElement.dataset.theme === FOLIA_THEME_ID;
  const key = (state.current && state.current.showKey) || '';
  const el = document.querySelector('audio');
  const live = el ? !el.paused : false;
  let marked = false;   // 墙会克隆同一档节目：只在第一块上标记/展开，别让整墙同时长出好几块
  let grew = false;
  document.querySelectorAll('#homeRecommended .pod-card').forEach(card => {
    const link = card.querySelector('[data-open-podcast]');
    const slug = link ? link.getAttribute('data-open-podcast') : '';
    const on = folia && !!key && slug === key && !marked;
    if (on) marked = true;
    const was = card.classList.contains('is-playing-tile');
    const apply = () => {
      card.classList.toggle('is-playing-tile', on);
      card.classList.toggle('is-playing-tile-live', on && live);
      if (on) {
        clearTileSpan(card);
        ensureTileLyric(card);
      } else {
        paintTileArt(card, false);
        const full = card.querySelector('.tile-full');
        if (full) full.remove();
        if (!folia) clearTileSpan(card);
        else if (!card.classList.contains('is-peek')) {
          // 手动撑开的瓦片别被“恢复槽位”压回小格
          restoreTileSpan(card);
        }
      }
    };
    // 播放状态变化会让瓦片从小格长成大格：和点开一样走 FLIP，别让整墙硬跳
    if (on !== was) { flipTile(card, apply); if (on) grew = true; } else apply();
  });
  // 瓦片撑成 6×6 会多占两行，密排会留下一个洞；补一套把洞填掉
  if (grew) setTimeout(() => { const w = foliaWall(); if (w && homeActive()) extendWall(w); }, 520);
  updateLocateBtn();
}

/* 墙页右下角的「回到正在播放」：点了就把正在播放的瓦片滚到视口正中并闪一圈珊瑚边 */
function updateLocateBtn() {
  let btn = document.querySelector('.folia-locate');
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'folia-locate';
    btn.setAttribute('aria-label', '定位到正在播放');
    btn.innerHTML = '<span class="folia-locate-bars"><i></i><i></i><i></i></span>' +
      '<span class="folia-locate-label">正在播放</span>';
    btn.addEventListener('click', () => {
      syncPlayingTiles();
      const key = (state.current && state.current.showKey) || '';
      const card = document.querySelector('#homeRecommended .pod-card.is-playing-tile') ||
        [...document.querySelectorAll('#homeRecommended .pod-card')].find(c => tileSlugOf(c) === key);
      if (!card) return;
      centerTile(card);
      card.classList.remove('locate-flash');
      void card.offsetWidth;
      card.classList.add('locate-flash');
      setTimeout(() => card.classList.remove('locate-flash'), 1000);
    });
    document.body.appendChild(btn);
  }
  const playing = !!(state.current && state.current.showKey);
  const onHome = location.hash.indexOf('#/home') === 0 || location.hash === '' || location.hash === '#/';
  btn.classList.toggle('on', playing && onHome && document.documentElement.dataset.theme === FOLIA_THEME_ID);
}
document.addEventListener('hashchange', () => updateLocateBtn());
/* 切主题不会走 hashchange：Folia 的定位钮要立刻收掉，切回 Folia 时再按当前页状态恢复 */
document.addEventListener('myt:theme-change', () => updateLocateBtn());
/* 首页由 home 插件渲染，宿主只挂一个观察器：墙重画完就把描边补回去 */
function watchHomeTiles() {
  const host = document.getElementById('homeRecommended');
  if (!host || host.dataset.mytTileSync) return;
  host.dataset.mytTileSync = '1';
  new MutationObserver(() => { syncPlayingTiles(); ensureWallDepth(); }).observe(host, { childList: true });
  syncPlayingTiles();
}
document.addEventListener('DOMContentLoaded', () => { bindPlayingRowSync(); watchHomeTiles(); bindCoverStage(); });

/* ---- Folia「海报墙」主题的三件交互：瓦片原地展开 / 墙无限补块 / 播放瓦片压歌词 ---- */
const FOLIA_THEME_ID = 'ct-pack-folia-poster';
const foliaWall = () => (document.documentElement.dataset.theme === FOLIA_THEME_ID
  ? document.getElementById('homeRecommended') : null);
const homeActive = () => !!$('page-home')?.classList.contains('active');
const TILE_SET_SIZE = 14;   // 与主题 14n 的铺满周期一致：12 席整块 + 两块 6×4
const TILE_MAX = 400;       // Folia MAX_RENDERED_INSTANCES

function tileSlugOf(card) {
  const link = card && card.querySelector('[data-open-podcast]');
  return link ? link.getAttribute('data-open-podcast') : '';
}

function ensureTilePeek(card) {
  let peek = card.querySelector('.tile-peek');
  if (peek) return peek;
  const slug = tileSlugOf(card);
  if (!slug) return null;
  const count = card.querySelector('.pod-badges .pill.dim');
  peek = document.createElement('div');
  peek.className = 'tile-peek';
  peek.innerHTML = '<span class="tile-peek-kicker">' + esc((count ? count.textContent : '').trim() || '节目') +
    '</span><div class="tile-peek-actions"><a class="tile-peek-btn primary" href="' +
    esc(routeHash('podcast', [slug])) + '" data-open-podcast="' + esc(slug) + '">进入节目页</a>' +
    '<button type="button" class="tile-peek-btn" data-tile-full>全屏</button>' +
    '<button type="button" class="tile-peek-btn" data-tile-collapse>收起</button></div>';
  card.appendChild(peek);
  return peek;
}

function collapseTiles(except) {
  document.querySelectorAll('#homeRecommended .pod-card.is-peek').forEach(card => {
    if (card !== except) flipTile(card, () => { card.classList.remove('is-peek'); restoreTileSpan(card); });
  });
}

/* ---------- 封面全屏：把瓦片里正在看的那张封面铺满窗口 ---------- */
let coverLyricRaf = 0;
let coverLoadToken = 0;
function updateCoverLyric() {
  const layer = $('coverStage');
  const box = $('csLyric');
  if (!layer || !layer.open || !box || !layer.classList.contains('lyric-on')) return;
  const html = tileLyricHTML();
  if (box.dataset.signature !== html) {
    box.innerHTML = html;
    box.dataset.signature = html;
  }
  paintCueWordEl(box.querySelector('.tl-cur'));
}
function startCoverLyricLoop() {
  const layer = $('coverStage');
  if (!layer || !layer.open || !layer.classList.contains('lyric-on') || coverLyricRaf) return;
  const step = () => {
    if (!layer.open || !layer.classList.contains('on')) {
      coverLyricRaf = 0;
      return;
    }
    updateCoverLyric();
    coverLyricRaf = requestAnimationFrame(step);
  };
  coverLyricRaf = requestAnimationFrame(step);
}
function stopCoverLyricLoop() {
  if (coverLyricRaf) cancelAnimationFrame(coverLyricRaf);
  coverLyricRaf = 0;
}
function closeCoverStage() {
  const layer = $('coverStage');
  if (!layer || !layer.open || layer.dataset.closing === '1') return;
  layer.dataset.closing = '1';
  coverLoadToken++;
  stopCoverLyricLoop();
  layer.classList.remove('on', 'lyric-on');
  setTimeout(() => { if (layer.open) layer.close(); }, motionReduced() ? 0 : 240);
}
function openCoverStage(card) {
  const layer = $('coverStage');
  if (!layer || !card || layer.open) return;
  const playing = card.classList.contains('is-playing-tile');
  const artImg = card.querySelector('.pod-art img');
  const epImg = playing && state.current && state.current.img ? state.current.img : '';
  const show = showByKey(tileSlugOf(card));
  const showArt = show && show.artwork ? show.artwork : '';
  /* 分集封面优先，但外站封面经常 403 / 超时：候选按顺序退，最后一张也失败时
     落到 CSS 生成的深色底，不再把整块窗口留成纯黑。 */
  const candidates = [...new Set([epImg, showArt, artImg ? artImg.getAttribute('src') : ''].filter(Boolean))];
  if (!candidates.length) { showToast('这张封面还没有图。', 'warn'); return; }
  const titleEl = card.querySelector('.pod-card-main > strong');
  const title = (playing && state.current && state.current.title) ? state.current.title : (titleEl ? titleEl.textContent.trim() : '');
  const showName = (playing && state.show && state.show.name) ? state.show.name : (card.querySelector('.pod-meta') ? card.querySelector('.pod-meta').textContent.trim() : '');
  const img = $('csImg'), bg = $('csBg');
  const token = ++coverLoadToken;
  layer.classList.add('cover-empty');
  const paintCover = (src) => {
    if (token !== coverLoadToken) return;
    if (img) { img.src = src; img.alt = title || '节目封面'; }
    if (bg) bg.style.backgroundImage = 'url(' + JSON.stringify(src) + ')';
    if (img && img.complete && img.naturalWidth) layer.classList.remove('cover-empty');
  };
  const coverLoaded = () => {
    if (token !== coverLoadToken) return;
    layer.classList.remove('cover-empty');
  };
  const coverFailed = () => {
    if (token !== coverLoadToken) return;
    const src = candidates.shift();
    if (src) paintCover(src);
    else {
      if (bg) bg.style.backgroundImage = 'none';
      layer.classList.add('cover-empty');
    }
  };
  if (img) {
    img.onload = coverLoaded;
    img.onerror = coverFailed;
  }
  paintCover(candidates.shift());
  const k = $('csKicker'), t = $('csTitle'), s = $('csSub');
  if (k) k.textContent = playing ? '正在播放' : '节目封面';
  if (t) t.textContent = title || '未命名节目';
  if (s) s.textContent = showName || '';
  const hasLyric = !!(playing && state.cues && state.cues.length);
  delete layer.dataset.closing;
  layer.classList.toggle('lyric-on', hasLyric);
  layer.showModal();
  if (hasLyric) updateCoverLyric();
  const lyricBox = $('csLyric');
  if (lyricBox && !hasLyric) { lyricBox.replaceChildren(); lyricBox.dataset.signature = ''; }
  requestAnimationFrame(() => layer.classList.add('on'));
  if (hasLyric) startCoverLyricLoop();
}
function bindCoverStage() {
  const layer = $('coverStage');
  if (!layer || layer.dataset.bound) return;
  layer.dataset.bound = '1';
  const close = $('csClose');
  if (close) close.addEventListener('click', closeCoverStage);
  const backdrop = $('csBackdrop');
  if (backdrop) backdrop.addEventListener('click', closeCoverStage);
  layer.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeCoverStage();
  });
  layer.addEventListener('close', () => {
    stopCoverLyricLoop();
    layer.classList.remove('on', 'lyric-on');
    const box = $('csLyric');
    if (box) { box.replaceChildren(); box.dataset.signature = ''; }
    delete layer.dataset.closing;
  });
  document.addEventListener('play', () => {
    if (layer.open && layer.classList.contains('lyric-on')) startCoverLyricLoop();
  }, true);
  document.addEventListener('pause', stopCoverLyricLoop, true);
  document.addEventListener('timeupdate', () => {
    if (layer.open) updateCoverLyric();
  }, true);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindCoverStage);
else bindCoverStage();

/* Folia 的手感：格子尺寸变化本身不能过渡，用 FLIP 把“旧矩形”先画出来再收回新矩形；
   旁边被挤动的瓦片只做位移，避免整墙一起缩放。 */
function flipTile(card, mutate) {
  if (typeof motionReduced === 'function' && motionReduced()) { mutate(); return; }
  const wall = card.closest('#homeRecommended');
  const cards = wall ? [...wall.querySelectorAll('.pod-card')].filter(c => {
    const r = c.getBoundingClientRect();
    return r.width > 0 && r.bottom > 0 && r.top < window.innerHeight * 1.6;
  }) : [card];
  const before = new Map(cards.map(c => [c, c.getBoundingClientRect()]));
  mutate();
  cards.forEach(c => {
    const a = before.get(c);
    const b = c.getBoundingClientRect();
    if (!a || !b.width || !a.width) return;
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    const sx = a.width / b.width;
    const sy = a.height / b.height;
    const scaled = Math.abs(sx - 1) > 0.02 || Math.abs(sy - 1) > 0.02;
    if (!scaled && Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    c.animate([
      { transformOrigin: 'top left', transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + (scaled ? sx : 1) + ',' + (scaled ? sy : 1) + ')' },
      { transformOrigin: 'top left', transform: 'translate(0,0) scale(1,1)' }
    ], {
      duration: c === card ? 440 : 360,
      easing: c === card ? 'cubic-bezier(0.2, 0.9, 0.2, 1)' : 'cubic-bezier(0.25, 0.9, 0.2, 1)'
    });
  });
}

function bindTilePeek() {
  // 捕获阶段拦：宿主自己的 data-open-podcast 路由监听比 bubble 更早跑，晚了就压不住跳转
  document.addEventListener('click', (e) => {
    const wall = foliaWall();
    if (!wall) return;
    /* 底栏 / 播放工具面板 / 任何浮层都是控件，不是“点空白”：不要顺手把展开的播放封面收掉。 */
    if (e.target.closest('.dock, .mini-player, #dockSheet, dialog, .anim-sheet, .drawer, .details')) return;
    const collapse = e.target.closest('[data-tile-collapse]');
    if (collapse) { e.preventDefault(); e.stopPropagation(); collapseTiles(); return; }
    const full = e.target.closest('[data-tile-full]');
    if (full) {
      e.preventDefault();
      e.stopPropagation();
      openCoverStage(full.closest('.pod-card'));
      return;
    }
    const card = e.target.closest('.pod-card');
    if (!card || !wall.contains(card)) { collapseTiles(); return; }
    if (e.target.closest('.tile-peek-actions a, .pod-actions')) return;   // 让链接与快钮各自干活
    const main = e.target.closest('.pod-card-main');
    if (!main) return;
    e.preventDefault();
    e.stopPropagation();
    if (card.classList.contains('is-peek')) {
      flipTile(card, () => { card.classList.remove('is-peek'); restoreTileSpan(card); });
      return;
    }
    collapseTiles(card);
    flipTile(card, () => { card.classList.add('is-peek'); clearTileSpan(card); ensureTilePeek(card); });
    // Folia 的镜头：瓦片撑开后把它挪到视口正中，别让放大后的封面一半在屏幕外
    setTimeout(() => centerTile(card), 440);
    // 撑开占了两行，密排可能留洞：补一套让后面的瓦片把洞填上
    setTimeout(() => { const w = foliaWall(); if (w && homeActive()) extendWall(w); }, 520);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    /* 有真正的弹层在前台时，Escape 先归弹层，别顺手把瓦片动作层也收掉。 */
    if (document.querySelector('dialog[open], .details.on, .drawer.on, .docksheet.on, .typesheet.on')) return;
    const open = document.querySelectorAll('#homeRecommended .pod-card.is-peek');
    if (!open.length) return;
    e.preventDefault();
    collapseTiles();
  }, true);
}

/* 当前句压到正在播放的瓦片上：Folia 播放态瓦片显示上一句 / 当前句 / 下一句三行 */
function tileLyricLines() {
  const cues = state.cues || [];
  const i = state.activeCue;
  if (i < 0 || !cues[i]) return [];
  const out = [];
  for (const rel of [-1, 0, 1]) {
    const cue = cues[i + rel];
    const text = cue ? String(cue.text || '').trim() : '';
    if (text) out.push({ rel, text, cue });
  }
  return out;
}
/* 当前句拆成词级 span：首页封面上也要看得到“现在读到哪个词”，
   不再只换整句（整句切换会让播放中的封面像一块静态海报）。 */
function tileCueMarkup(cue, text) {
  if (!cue || !cue.hasWords || !Array.isArray(cue.words) || !cue.words.length) return esc(text);
  const parts = splitLabel(text, cue.words);
  if (parts.mismatch) return esc(text);
  const label = parts.label ? '<span class="tl-label">' + esc(parts.label) + ' </span>' : '';
  return label + parts.words.map(w =>
    '<span class="tl-word" data-s="' + (Number(w.s) || 0) + '">' + esc(w.t) + '</span>').join(' ');
}
function tileLyricHTML() {
  return tileLyricLines().map(l => '<span class="tl-line tl-' +
    (l.rel < 0 ? 'prev' : l.rel > 0 ? 'next' : 'cur') + '">' +
    (l.rel === 0 ? tileCueMarkup(l.cue, l.text) : esc(l.text)) + '</span>').join('');
}
/* 按音频时钟给当前句的词上色；首页瓦片和全屏封面共用同一套词级状态。 */
function paintCueWordEl(el) {
  if (!el) return;
  const words = el.querySelectorAll('.tl-word');
  if (!words.length) return;
  const t = (Number(audio.currentTime) || 0) + (Number(state.offset) || 0);
  let idx = -1;
  for (let i = 0; i < words.length; i++) {
    if (t >= (Number(words[i].dataset.s) || 0)) idx = i;
    else break;
  }
  for (let i = 0; i < words.length; i++) {
    words[i].classList.toggle('on', i === idx);
    words[i].classList.toggle('past', i >= 0 && i < idx);
  }
}
function tileWordPaint() {
  paintCueWordEl(document.querySelector('#homeRecommended .pod-card.is-playing-tile .tile-live-lyric .tl-cur'));
}
let tileLyricRaf = 0;
function startTileLyricLoop() {
  const el = document.querySelector('audio');
  if (!el || el.paused || tileLyricRaf) return;
  if (!homeActive() || !foliaWall()) return;
  const step = () => {
    if (!el || el.paused || !homeActive() || !foliaWall()) { tileLyricRaf = 0; return; }
    tileWordPaint();
    tileLyricRaf = requestAnimationFrame(step);
  };
  tileLyricRaf = requestAnimationFrame(step);
}
function stopTileLyricLoop() {
  if (tileLyricRaf) cancelAnimationFrame(tileLyricRaf);
  tileLyricRaf = 0;
}
function updateTileLyric() {
  const html = tileLyricHTML();
  document.querySelectorAll('#homeRecommended .pod-card.is-playing-tile .tile-live-lyric').forEach(el => {
    if (el.dataset.signature === html) return;
    el.innerHTML = html;
    el.dataset.signature = html;
  });
  tileWordPaint();
}
/* 有分集封面就优先用分集封面；没有才沿用节目封面。 */
function paintTileArt(card, on) {
  const art = card && card.querySelector('.pod-art');
  if (!art) return;
  if (!card.dataset.baseArtHtml) card.dataset.baseArtHtml = art.innerHTML;
  const ep = on ? state.current : null;
  const epImg = ep && ep.img ? (smallArtwork(ep.img) || ep.img) : '';
  if (epImg) {
    let img = art.querySelector('img[data-ep-art]');
    if (!img) {
      img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.dataset.epArt = '1';
      img.onerror = () => img.remove();
      art.insertBefore(img, art.firstChild);
    }
    if (img.getAttribute('src') !== epImg) img.src = epImg;
    art.classList.add('has-ep-art');
  } else if (card.dataset.baseArtHtml) {
    art.innerHTML = card.dataset.baseArtHtml;
    art.classList.remove('has-ep-art');
  }
}
function ensureTileLyric(card) {
  let el = card.querySelector('.tile-live-lyric');
  if (!el) { el = document.createElement('span'); el.className = 'tile-live-lyric'; card.appendChild(el); }
  let full = card.querySelector('.tile-full');
  if (!full) {
    full = document.createElement('button');
    full.type = 'button';
    full.className = 'tile-full';
    full.setAttribute('data-tile-full', '');
    full.setAttribute('aria-label', '全屏显示封面');
    full.title = '全屏显示封面';
    full.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/></svg>';
    card.appendChild(full);
  }
  paintTileArt(card, true);
  const html = tileLyricHTML();
  if (html && el.dataset.signature !== html) {
    el.innerHTML = html;
    el.dataset.signature = html;
  }
  tileWordPaint();
  return el;
}

/* 无限墙：墙底快到了就再铺一整套（14 块 = 12 席 + 两块 6×4，正好接上）。
   每一套换一个块模板（源码 blockTemplates 的 4 个变体），并把节目打乱后重新分槽，
   所以往下滚不会看到同一幅墙在原地复制。 */
const SLOT_VARIANTS = [
  [[3, 2], [6, 4], [3, 2], [3, 2], [3, 4], [4, 4], [2, 2], [3, 2], [2, 2], [2, 2], [2, 2], [2, 2]],
  [[2, 3], [2, 3], [2, 3], [6, 4], [6, 2], [2, 4], [2, 4], [2, 2], [2, 3], [2, 3], [2, 3], [2, 2]],
  [[6, 4], [6, 3], [4, 3], [2, 2], [4, 2], [2, 2], [2, 3], [2, 2], [2, 2], [2, 2], [2, 2], [2, 2]],
  [[2, 2], [2, 2], [4, 3], [2, 4], [2, 4], [2, 3], [2, 2], [4, 3], [2, 2], [4, 4], [2, 3], [6, 2]]
];
const SET_FILLERS = [[6, 4], [6, 4]];
function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
function slotsOf(variantIndex) {
  return SLOT_VARIANTS[variantIndex % SLOT_VARIANTS.length].concat(SET_FILLERS);
}
/* 按“整墙绝对序号”分槽：第 i 块永远落在第 floor(i/14) 套模板的第 i%14 席。
   订阅节目少于 14 个时，一套模板里会有重复节目，但槽位是齐的，墙上不会留洞。 */
function applyWallPattern(wall) {
  const seed = Number(wall.dataset.wallVariant || 0);
  const cards = [...wall.querySelectorAll('.pod-card')];
  cards.forEach((card, i) => {
    const slot = slotsOf(seed + Math.floor(i / TILE_SET_SIZE))[i % TILE_SET_SIZE];
    card.dataset.span = slot[0] + '/' + slot[1];
    card.dataset.tile = (slot[0] >= 4 || slot[0] * slot[1] >= 12) ? 'big' : 'small';
    // 正撑开的瓦片由展开态自己占 6×6，别被槽位覆盖
    if (card.classList.contains('is-peek') || card.classList.contains('is-playing-tile')) return;
    card.style.gridColumn = 'span ' + slot[0];
    card.style.gridRow = 'span ' + slot[1];
  });
}
/* 展开态要盖过每块自己的内联槽位，否则 inline 的 span 会把 6×6 压回去 */
function clearTileSpan(card) {
  card.style.removeProperty('grid-column');
  card.style.removeProperty('grid-row');
}
function restoreTileSpan(card) {
  /* 播放态由主题固定占 6×6；收起动作层时不能把内联槽位写回去，否则播放封面会缩回一格。 */
  if (card.classList.contains('is-playing-tile')) { clearTileSpan(card); return; }
  const span = (card.dataset.span || '').split('/');
  if (span.length === 2 && span[0]) {
    card.style.gridColumn = 'span ' + span[0];
    card.style.gridRow = 'span ' + span[1];
  }
}
function extendWall(wall) {
  const cards = [...wall.querySelectorAll('.pod-card')];
  if (cards.length >= TILE_MAX) return;
  const srcs = cards.filter(c => !c.dataset.wallClone);
  if (!srcs.length) return;
  // 只补到“下一整套”的边界：首屏不足 14 块时先把当前这套补满，之后每次 +14
  const need = TILE_SET_SIZE - (cards.length % TILE_SET_SIZE);
  const pool = [];
  while (pool.length < need) pool.push(...shuffle(srcs));
  const clones = pool.slice(0, need).map((src, index) => {
    const clone = src.cloneNode(true);
    clone.removeAttribute('id');
    clone.classList.remove('is-peek', 'is-playing-tile', 'is-playing-tile-live');
    clone.dataset.wallClone = '1';
    clone.dataset.wallFresh = '1';
    clone.style.setProperty('--i', String(index));   // 新补的这批瓦片按序号轻微错峰淡入
    clone.querySelectorAll('.tile-peek, .tile-live-lyric').forEach(n => n.remove());
    return clone;
  });
  const frag = document.createDocumentFragment();
  clones.forEach(c => frag.appendChild(c));
  wall.appendChild(frag);
  applyWallPattern(wall);
  syncPlayingTiles();
}
function ensureWallDepth() {
  const wall = foliaWall();
  if (!wall) return;
  if (!wall.querySelectorAll('.pod-card').length) return;
  if (!wall.dataset.wallVariant) wall.dataset.wallVariant = String(Math.floor(Math.random() * SLOT_VARIANTS.length));
  applyWallPattern(wall);
  // 不足两整套就补齐，够两整套就随滚动继续长
  let guard = 0;
  while (wall.querySelectorAll('.pod-card').length < TILE_SET_SIZE * 2 && guard++ < 8) extendWall(wall);
}
/* 切出 Folia 时把这张墙还给普通主题：补块、展开态、内联网格槽位和歌词层都是 Folia 专属，
   留着会在 4 列基础网格里撑出隐式列，或者把歌词当普通文本塞回卡片。 */
function resetWallForTheme() {
  const wall = document.getElementById('homeRecommended');
  if (!wall) return;
  wall.querySelectorAll('.pod-card[data-wall-clone]').forEach(card => card.remove());
  wall.querySelectorAll('.pod-card').forEach(card => {
    card.classList.remove('is-peek', 'is-playing-tile', 'is-playing-tile-live');
    card.querySelectorAll('.tile-full, .tile-peek, .tile-live-lyric').forEach(node => node.remove());
    card.removeAttribute('data-span');
    card.removeAttribute('data-tile');
    clearTileSpan(card);
  });
}
function syncWallTheme() {
  if (!document.body) return;
  if (foliaWall()) {
    ensureWallDepth();
    syncPlayingTiles();
    if (!audio.paused) startTileLyricLoop();
  } else {
    resetWallForTheme();
    syncPlayingTiles();
  }
}
new MutationObserver(syncWallTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
function wallScroller(wall) {
  if (!wall) return null;   // 路由切换时墙可能还没挂载：拿不到墙就别猜滚动容器，否则整次跳转会被异常打断
  let el = wall.parentElement;
  while (el && el !== document.documentElement) {
    const cs = getComputedStyle(el);
    if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') return el;
    el = el.parentElement;
  }
  return null;
}
/* 把某块瓦片推到滚动视口的正中（Folia 的镜头跟随） */
function centerTile(card) {
  if (!card || !card.isConnected || (typeof motionReduced === 'function' && motionReduced())) return;
  if (!homeActive()) return;
  const sc = wallScroller(foliaWall() || card.closest('#homeRecommended'));
  if (!sc) return;
  const r = card.getBoundingClientRect();
  const sr = sc.getBoundingClientRect();
  const top = sc.scrollTop + (r.top - sr.top) - Math.max(0, (sc.clientHeight - r.height) / 2);
  sc.scrollTo({ top, behavior: 'smooth' });
}
function nearWallBottom(wall) {
  const sc = wallScroller(wall);
  if (!sc) return window.scrollY + window.innerHeight + 1000 >= document.documentElement.scrollHeight;
  return sc.scrollTop + sc.clientHeight + 1000 >= sc.scrollHeight;
}
function bindInfiniteWall() {
  let queued = 0;
  let lastAt = 0;
  const onScroll = () => {
    if (queued) return;
    queued = requestAnimationFrame(() => {
      queued = 0;
      const wall = foliaWall();
      if (!wall) return;
      if (!homeActive()) return;
      if (Date.now() - lastAt < 900) return;   // 平滑滚动会连续触发 scroll，别一口气补几十套
      if (nearWallBottom(wall)) { lastAt = Date.now(); extendWall(wall); }
    });
  };
  window.addEventListener('scroll', onScroll, { passive: true, capture: true });
  const wall = foliaWall();
  const sc = wall ? wallScroller(wall) : null;
  if (sc) sc.addEventListener('scroll', onScroll, { passive: true });
  ensureWallDepth();
}

/* 侧栏只剩图标，标签转成悬停提示（Folia 的 rail 也是图标 + 浮出名字） */
function labelSidebarNav() {
  document.querySelectorAll('.sidebar .nav button, .sidebar .nav a').forEach(el => {
    const text = (el.textContent || '').trim();
    if (text && text.length <= 12) el.setAttribute('data-label', text);
  });
}

document.addEventListener('DOMContentLoaded', () => { bindTilePeek(); bindInfiniteWall(); labelSidebarNav(); });


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
function renderHomeContinue() {
  const progress = readAllProgress();
  const entries = Object.entries(progress).filter(([, rec]) => Number(rec.t) > 5);
  const resolved = entries.map(([progressId, rec]) => {
    const key = rec.key || progressId.split(':')[0];
    const epId = progressId.slice(key.length + 1).replace(/^:/, '');
    return { progressId, rec, key, epId, target: playTarget(key, epId) };
  });
  const continuing = resolved.filter(({ rec }) => !rec.d || rec.t < rec.d - 30);
  const continueEntry = continuing
    .filter(item => item.target.ok)
    .sort((a, b) => (b.rec.at || 0) - (a.rec.at || 0))[0];
  const staleCount = continuing.filter(item => !item.target.ok).length;
  const hasVideo = !!homeVideoCard();
  if (continueEntry) {
    const { rec, key, epId } = continueEntry;
    const show = continueEntry.target.show;
    const pct = rec.d ? Math.min(100, Math.round((rec.t / rec.d) * 100)) : 0;
    $('homeContinue').innerHTML = '<div class="continue" data-resume data-key="' + esc(key) + '" data-ep="' +
      esc(epId) + '" data-t="' + Number(rec.t || 0) + '">' +
      coverHTML(show, 'pod-art') + '<div class="continue-main"><strong>' + esc(rec.title || show.name || '继续收听') +
      '</strong><span>' + esc(rec.show || show.name || '') + ' · 已听 ' + fmt(rec.t) + (rec.d ? ' / ' + fmt(rec.d) : '') +
      '</span><div class="progress"><i style="width:' + pct + '%"></i></div></div>' +
      '<button class="round-play" data-resume data-key="' + esc(key) + '" data-ep="' +
      esc(epId) + '" data-t="' + Number(rec.t || 0) + '">▶</button></div>';
    $('continueHint').textContent = staleCount ? '上次停在这里 · ' + staleCount + ' 条失效记录' : '上次停在这里';
  } else if (hasVideo) {
    $('homeContinue').replaceChildren();
    $('continueHint').textContent = '上次看到这里';
  } else if (staleCount) {
    $('homeContinue').innerHTML = emptyLine('上次收听的内容已经失效了。',
      '<button class="btn ghost" data-route="local">检查本地文件</button>');
    $('continueHint').textContent = staleCount + ' 条记录已失效';
  } else {
    $('homeContinue').innerHTML = emptyLine('还没有收听记录。', '<button class="btn primary" data-route="discover">去发现节目</button>');
    $('continueHint').textContent = '';
  }
  return { entries, staleCount };
}
function renderHome() {
  const subs = app.subs.map(s => showByKey(s.key)).filter(Boolean);
  $('heroSubCount').textContent = subs.length;
  const dateEl = $('ledgerDate');
  if (dateEl && dateEl.textContent.trim() === '—') {
    dateEl.textContent = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  }
  const { entries } = renderHomeContinue();
  appendHomeVideoCard();
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

  // 海报墙要“无限”：全部有 feed 的内置节目都上墙，不再截断成 4 张
  const recommended = app.builtinShows
    .filter(show => show.feed)
    .toSorted((a, b) => String(a.slug).localeCompare(String(b.slug)));
  $('homeRecommended').innerHTML = recommended.length
    ? recommended.map(podCardHTML).join('')
    : emptyLine('所有内置节目都已订阅。');
  renderHomeOnboard(subs, entries);
}

/* 首启三步：产品第一次打开时，首页最缺的是“下一步做什么”。
   三步都真实可判定：订阅数、播放记录、打开过阅读器；做完或跳过就永久收起。 */
function renderHomeOnboard(subs, entries) {
  const host = $('homeOnboard');
  if (!host) return;
  if (!subs) subs = app.subs.map(s => showByKey(s.key)).filter(Boolean);
  if (!entries) entries = Object.entries(readAllProgress()).filter(([, rec]) => Number(rec.t) > 5);
  let done = false;
  try { done = localStorage.getItem('myt-onboard-done') === '1'; } catch (e) {}
  if (done) { host.hidden = true; host.replaceChildren(); return; }
  let openedReader = false;
  try { openedReader = localStorage.getItem('myt-reader-opened') === '1'; } catch (e) {}
  const steps = [
    { ok: subs.length > 0, text: '订阅一档节目' },
    { ok: entries.length > 0, text: '播放任意一集' },
    { ok: openedReader, text: '打开一集文字稿' },
  ];
  const finished = steps.filter(step => step.ok).length;
  if (finished >= steps.length) {
    try { localStorage.setItem('myt-onboard-done', '1'); } catch (e) {}
    host.hidden = true;
    host.replaceChildren();
    return;
  }
  const route = !subs.length ? 'discover' : (!entries.length ? 'discover' : 'listening');
  const action = route === 'discover' ? '去发现节目' : '回去继续听';
  host.hidden = false;
  host.innerHTML =
    '<header><strong>三步开始用 MyTranscript</strong><span>' + finished + ' / ' + steps.length + ' 完成</span></header>' +
    '<div class="onb-steps">' + steps.map((step, index) =>
      '<div class="onb-step' + (step.ok ? ' done' : '') + '"><b>' + (step.ok ? '✓' : index + 1) + '</b><span>' + esc(step.text) + '</span></div>'
    ).join('') + '</div>' +
    '<footer><small>不用配置也能离线听；AI 功能之后在设置里再开。</small><div style="display:flex;gap:8px">' +
      '<button class="btn ghost small" type="button" data-onboard-skip>跳过引导</button>' +
      '<button class="btn primary small" type="button" data-route="' + route + '">' + esc(action) + '</button>' +
    '</div></footer>';
}

/* 视频看到一半回主页，原来就彻底找不回去了：这里给它留一张卡。
   首页在插件手里（page:home），宿主只负责把这张卡追到 #homeContinue 末尾。 */
function appendHomeVideoCard() {
  const box = $('homeContinue');
  if (!box || box.querySelector('[data-video-resume]')) return;
  const card = homeVideoCard();
  if (!card) return;
  box.insertAdjacentHTML('beforeend', card);
  /* 卡片自己的元信息写「看到 11:37」，节标题就别再统一写「上次停在这里」。
     只有音频续播卡也在时，标题才回到中性的说法。 */
  const hint = $('continueHint');
  if (hint && !/条失效记录/.test(hint.textContent)) {
    hint.textContent = box.querySelectorAll('.continue:not([data-video-resume])').length
      ? '上次停在这里' : '上次看到这里';
  }
}
function homeVideoCard() {
  const ep = readJSON('myt-video-ep', null);
  if (!ep || !ep.id) return '';
  // 本地视频已经从「本地文件」移除时，首页不要再挂一张点开必然失败的卡。
  if (ep.localPath && !app.local.some(item => item.kind === 'video' && (item.localPath === ep.localPath || item.id === ep.id))) return '';
  const rec = readJSON(videoProgressKey(ep), null);
  if (!rec || Number(rec.t) <= 5) return '';
  const dur = Number(rec.duration) || 0;
  const t = Number(rec.t) || 0;
  if (dur && t > dur - 10) return ''; // 快看完了就别再提示
  const pct = dur ? Math.min(100, Math.round((t / dur) * 100)) : 0;
  const title = ep.title || ep.name || ep.showName || '继续看视频';
  const meta = [ep.showName, '看到 ' + fmtClock(t) + (dur ? ' / ' + fmtClock(dur) : '')].filter(Boolean).join(' · ');
  return '<div class="continue" data-video-resume>' +
    '<div class="pod-art" aria-hidden="true">▶</div>' +
    '<div class="continue-main"><strong>' + esc(title) + '</strong><span>' + esc(meta) +
    '</span><div class="progress"><i style="width:' + pct + '%"></i></div></div>' +
    '<button class="round-play" data-video-resume>▶</button></div>';
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
  if (d.sort === 'latest') list = list.toSorted((a, b) => latestAt(b) - latestAt(a));
  else if (d.sort === 'episodes') list = list.toSorted((a, b) => (Number(b.episode_count) || 0) - (Number(a.episode_count) || 0));
  else if (d.sort === 'name') list = list.toSorted((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));
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
  // 站外视频集只在内存里记着，刷新/重开就丢；顺手落一份，重开还能直接看。
  const saved = state.videoEp || readJSON('myt-video-ep', null);
  const ep = saved || local;
  const video = $('localVideo');
  if (!ep) {
    $('videoSub').textContent = '没有可播放的视频';
    stopVideoAsr();
    video.removeAttribute('src');
    video.load();
    return;
  }
  $('videoSub').textContent = [ep.showName, ep.title || ep.name || ''].filter(Boolean).join(' · ');
  const direct = ep.videoUrl || '';
  const proxied = direct ? mytMediaUrl(direct) : '';
  const src = ep.localPath && host() && typeof host().asset === 'function'
    ? host().asset(ep.localPath)
    : (proxied || direct);
  if (video.dataset.src !== src) {
    stopVideoAsr();
    video.dataset.src = src;
    video.dataset.direct = direct;
    video.dataset.proxied = proxied || '';
    // 代理地址要显式走 CORS 请求，否则 createMediaElementSource 依旧是脏流。
    if (proxied && src === proxied) video.setAttribute('crossorigin', 'anonymous');
    else video.removeAttribute('crossorigin');
    video.src = src;
    video.load();
    bindVideoExtras(video, ep);
  }
}
/* 离开视频页：画面和声音一起收，旁路转写也停。
   以前这里什么都不做，回主页后画面看不见、声音还在放，又没有入口点回去。 */
function leaveVideoPage() {
  const video = $('localVideo');
  if (video && !video.paused) video.pause();
  stopVideoAsr();
}
/* 视频页原来只有一个裸 <video>：关掉就忘了看到哪，字幕也完全不显示。
   这里补两件小事——按集记住播放位置、有 cue 时把当前句叠在画面上。
   字幕只对「已经加载过文字稿的这一集」生效：本地视频本来就没有文字稿。 */
function videoProgressKey(ep) { return 'myt-video-progress:' + String(ep && ep.id ? ep.id : ''); }
function bindVideoExtras(video, ep) {
  video._mytEp = ep || null;
  if (video.dataset.extrasBound !== '1') {
    video.dataset.extrasBound = '1';
    let lastSave = 0;
    video.addEventListener('timeupdate', () => {
      const cuesBox = $('videoCues');
      const playing = video._mytEp || null;
      const cues = (state.current && playing && state.current.id === playing.id) ? state.cues : [];
      const overlay = syncVideoCues(cuesBox, cues, video.currentTime) || sideCueText(video.currentTime) || videoLiveText(video.currentTime);
      if (cuesBox) {
        cuesBox.hidden = !overlay;
        if (!cuesBox.hidden && cuesBox.textContent !== overlay) cuesBox.textContent = overlay;
      }
      const now = Date.now();
      if (playing && video.currentTime > 0 && now - lastSave > 2000) {
        lastSave = now;
        writeJSON(videoProgressKey(playing), {
          t: Math.round(video.currentTime), duration: Math.round(video.duration || 0), updatedAt: now,
        });
      }
    });
    video.addEventListener('loadedmetadata', () => {
      const ep2 = video._mytEp;
      if (!ep2) return;
      const saved = readJSON(videoProgressKey(ep2), null);
      if (!saved || !saved.t) return;
      const total = Number(video.duration) || 0;
      if (total && saved.t > total - 10) return; // 快看完了就别跳回去
      if (saved.t < 8) return;
      video.currentTime = saved.t;
      showToast('从 ' + fmtClock(saved.t) + ' 继续', 3000);
    });
    // 先把 AudioContext 在「真实点击」的激活窗口里建起来：Chromium 只认手势，
    // 在 play 事件里现建的 ctx 会是 suspended，接到 MediaElementSource 之后
    // video 会卡在 waiting（看得到画面、时间不往前走）。点一下视频区域就补上。
    video.addEventListener('pointerdown', () => { kickVideoAudio(video); }, true);
    video.addEventListener('play', () => {
      kickVideoAudio(video);
      // 优先让宿主自己解音轨（不跟播放抢 WebAudio）；宿主这条路不通才退回实时抽流。
      startSideAsr(video, video._mytEp).then(ok => {
        if (ok) { videoAsrMute(true); return; }
        videoAsrMute(false);
        startVideoAsr(video, video._mytEp);
      }).catch(() => {
        videoAsrMute(false);
        startVideoAsr(video, video._mytEp);
      });
    });
    video.addEventListener('pause', () => { videoAsrMute(true); });
    video.addEventListener('seeking', () => { videoAsrAnchor(video); });
    video.addEventListener('ratechange', () => {
      // 旁路转写跟播放器时钟无关，倍速不用停；只有实时抽流这条路要停。
      if (sideActive()) return;
      if (Math.abs(Number(video.playbackRate) || 1) > 1.01) {
        VIDEO_ASR.hold = true;
        videoAsrMute(true);
        videoAsrStatus('倍速播放时暂停转写，回到 1× 自动继续');
      } else if (VIDEO_ASR.id) {
        VIDEO_ASR.hold = false;
        videoAsrMute(false);
        videoAsrStatus(videoAsrLabel());
      }
    });
    video.addEventListener('error', () => {
      const direct = video.dataset.direct || '';
      // 代理挂了不能连累播放：切回直连，只是没有边看边转写。
      if (direct && video.dataset.src === video.dataset.proxied) {
        stopVideoAsr();
        video.removeAttribute('crossorigin');
        video.dataset.src = direct;
        video.src = direct;
        video.load();
        videoAsrStatus('代理没接上，已切回直连（这一集没有字幕）', true);
      } else {
        showToast(ep?.localPath ? '这个本地视频文件不见了，请重新导入。' : '视频加载失败，地址可能已经失效。', 7000);
      }
    });
  }
}
/* ---------- 视频：同源代理 + 边看边转写 ----------
   画面走 mytmedia（本进程代理，Range 透传 + 落盘缓存），音频从 MediaElementSource
   进 AudioWorklet 降成 16k，攒约 1 秒喂一次原生 sherpa，只取增量文本。
   字幕按「播放时刻」对齐：喂进去的采样属于刚播过的那一段，所以 cue 起点 = 起喂时的
   currentTime + token 相对时间。 */
const VIDEO_ASR = {
  video: null, ep: null, graph: null, ctx: null,
  id: 0, base: 0, fed: 0, pending: [], pendingLen: 0,
  inflight: false, cue: null, cues: [], lastTs: -1, timer: 0, model: '', hold: false,
};

/* 用户点击（真的鼠标手势）时把 AudioContext 建起来/唤醒。
   Chromium 的自动播放策略只认手势：suspended 的 ctx 一旦接上
   MediaElementAudioSourceNode，媒体元素会停在 waiting，画面不动。 */
function kickVideoAudio(video) {
  if (VIDEO_ASR.graph && VIDEO_ASR.graph.ctx) {
    const c = VIDEO_ASR.graph.ctx;
    if (c.state !== 'running') { try { c.resume().catch(() => {}); } catch (e) {} }
    return;
  }
  if (!VIDEO_ASR.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { VIDEO_ASR.ctx = new AC(); } catch (e) { return; }
  }
  const c = VIDEO_ASR.ctx;
  if (c.state !== 'running') { try { c.resume().catch(() => {}); } catch (e) {} }
}

function mytMediaUrl(url) {
  if (!url || !/^https?:/i.test(url)) return '';
  const T = tauriHost();
  if (!T || !T.core || typeof T.core.convertFileSrc !== 'function') return '';
  return 'http://mytmedia.localhost/?u=' + encodeURIComponent(url);
}

function videoAsrBox() { return $('videoAsrStatus'); }
function videoAsrStatus(text, warn) {
  const box = videoAsrBox();
  if (!box) return;
  if (!text) { box.hidden = true; box.textContent = ''; return; }
  box.hidden = false;
  box.textContent = text;
  box.className = 'video-asr' + (warn ? ' warn' : '');
}
function videoAsrLabel() {
  const name = videoAsrModelName(VIDEO_ASR.model);
  const at = VIDEO_ASR.video ? Number(VIDEO_ASR.video.currentTime) || 0 : 0;
  return '边看边转写 · ' + name + (at ? ' · 播到 ' + fmtClock(at) : '');
}
function videoAsrModelName(id) {
  try { return asrModelName(id); } catch (e) { return id || '本机模型'; }
}
function videoAsrMute(on) {
  const node = VIDEO_ASR.graph && VIDEO_ASR.graph.node;
  if (!node) return;
  try { node.port.postMessage({ type: 'mute', value: Boolean(on) }); } catch (e) {}
}
function videoAsrAnchor(video) {
  if (!VIDEO_ASR.id) return;
  VIDEO_ASR.base = Number(video.currentTime) || 0;
  VIDEO_ASR.fed = 0;
  VIDEO_ASR.seg = null;
  VIDEO_ASR.cues = [];
  VIDEO_ASR.lastTs = -1;
  VIDEO_ASR.pending = [];
  VIDEO_ASR.pendingLen = 0;
  videoAsrMute(true);
  try { host().asrReset(VIDEO_ASR.id); } catch (e) {}
  setTimeout(() => videoAsrMute(false), 400);
}

async function startVideoAsr(video, ep) {
  if (!ep || !ep.videoUrl) return;                       // 本地文件走「整集预转写」，不走这一支
  const H = host();
  if (!H || typeof H.asrOpen !== 'function') return;
  if (prefs.modules && prefs.modules.liveAsr === false) return;
  if (VIDEO_ASR.video !== video) stopVideoAsr();
  if (VIDEO_ASR.id) return;
  try {
    videoAsrStatus('准备本机识别模型…');
    const model = prefs.asrModel || ASR_MODEL_DEFAULT;
    const dir = await H.asrPrepare(model);
    const id = await H.asrOpen(dir, 2);
    if (typeof id !== 'number') throw new Error('识别器创建失败');
    let graph = VIDEO_ASR.graph;
    if (!graph || graph.video !== video) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('这个壳没有 AudioContext');
      const ctx = VIDEO_ASR.ctx || new AC();
      VIDEO_ASR.ctx = ctx;
      await ctx.audioWorklet.addModule('./asr-worklet.js');
      // captureStream 只「旁听」元素的声音，不动它的输出通路，播放不会卡；
      // 拿不到流才退回 MediaElementSource（对这种源有卡在 waiting 的风险）。
      let srcNode = null;
      let tapped = 'element';
      try {
        if (typeof video.captureStream === 'function') {
          const stream = video.captureStream();
          if (stream && stream.getAudioTracks().length) {
            srcNode = ctx.createMediaStreamSource(stream);
            tapped = 'stream';
          }
        }
      } catch (e) {}
      if (!srcNode) srcNode = ctx.createMediaElementSource(video);
      const node = new AudioWorkletNode(ctx, 'myt-asr-tap');
      srcNode.connect(node);
      if (tapped === 'element') srcNode.connect(ctx.destination);   // 声音照常从扬声器出来
      node.port.onmessage = ev => videoAsrPush(ev.data);
      graph = { video, ctx, srcNode, node, tapped };
    }
    if (graph.ctx.state === 'suspended') { try { await graph.ctx.resume(); } catch (e) {} }
    if (graph.ctx.state !== 'running') {
      videoAsrStatus('音频通道被浏览器挡着（' + graph.ctx.state + '）：点一下画面再播', true);
    }
    VIDEO_ASR.graph = graph;
    VIDEO_ASR.video = video;
    VIDEO_ASR.ep = ep;
    VIDEO_ASR.id = id;
    VIDEO_ASR.model = model;
    try { window.__mytAsr = VIDEO_ASR; } catch (e) {}
    VIDEO_ASR.base = Number(video.currentTime) || 0;
    VIDEO_ASR.fed = 0;
    VIDEO_ASR.seg = null;
    VIDEO_ASR.cues = [];
    VIDEO_ASR.lastTs = -1;
    VIDEO_ASR.pending = [];
    VIDEO_ASR.pendingLen = 0;
    videoAsrMute(false);
    videoAsrStatus(videoAsrLabel());
    if (!VIDEO_ASR.timer) VIDEO_ASR.timer = setInterval(flushVideoAsr, 900);
  } catch (err) {
    stopVideoAsr();
    videoAsrStatus('转写没起来：' + ((err && err.message) || err), true);
  }
}

function stopVideoAsr() {
  if (VIDEO_ASR.timer) { clearInterval(VIDEO_ASR.timer); VIDEO_ASR.timer = 0; }
  const id = VIDEO_ASR.id;
  VIDEO_ASR.id = 0;
  VIDEO_ASR.pending = [];
  VIDEO_ASR.pendingLen = 0;
  VIDEO_ASR.inflight = false;
  VIDEO_ASR.seg = null;
  VIDEO_ASR.cues = [];
  VIDEO_ASR.lastTs = -1;
  VIDEO_ASR.fed = 0;
  VIDEO_ASR.ep = null;
  if (id) { try { host().asrClose(id); } catch (e) {} }
  sideReset();
}

function videoAsrPush(msg) {
  if (!VIDEO_ASR.id || !msg || !msg.pcm || !msg.pcm.length) return;
  const rate = Number(msg.rate) || 16000;
  VIDEO_ASR.pending.push({ pcm: msg.pcm, rate });
  VIDEO_ASR.pendingLen += msg.pcm.length;
  if (VIDEO_ASR.pendingLen >= rate) flushVideoAsr();
}

function videoAsrBatch() {
  const parts = VIDEO_ASR.pending;
  if (!parts.length) return null;
  let len = 0;
  parts.forEach(p => { len += p.pcm.length; });
  const out = new Float32Array(len);
  let at = 0;
  parts.forEach(p => { out.set(p.pcm, at); at += p.pcm.length; });
  return { pcm: out, rate: parts[0].rate || 16000 };
}

async function flushVideoAsr() {
  if (!VIDEO_ASR.id || VIDEO_ASR.inflight) return;
  const batch = videoAsrBatch();
  if (!batch || !batch.pcm.length) return;
  VIDEO_ASR.pending = [];
  VIDEO_ASR.pendingLen = 0;
  const id = VIDEO_ASR.id;
  VIDEO_ASR.inflight = true;
  try {
    // 时间对齐改成「这一批开始喂时的播放位置」：暂停、缓冲都不会把时间轴拖歪。
    const t0 = VIDEO_ASR.video ? Number(VIDEO_ASR.video.currentTime) || 0 : 0;
    await host().asrFeed(id, Array.from(batch.pcm), Math.round(batch.rate));
    if (VIDEO_ASR.id !== id) return;
    const json = await host().asrResult(id);
    if (VIDEO_ASR.id !== id) return;
    videoAsrParse(json, t0);
    if (!VIDEO_ASR.hold) videoAsrStatus(videoAsrLabel());
  } catch (err) {
    if (VIDEO_ASR.id === id) videoAsrStatus('识别停了一下：' + ((err && err.message) || err), true);
  } finally {
    VIDEO_ASR.inflight = false;
  }
}

function videoAsrParse(json, t0) {
  let r = null;
  try { r = JSON.parse(json || '{}'); } catch (e) { return; }
  const toks = (r && r.tokens) || [];
  const ts = (r && r.timestamps) || [];
  if (!toks.length || !ts.length) return;
  const startRel = Number(ts[0]) || 0;
  if (!VIDEO_ASR.seg || startRel < VIDEO_ASR.seg.lastRel - 0.02) {
    // 流内断句（或换集）：新段的绝对起点 = 这一批开始喂时的播放位置。
    VIDEO_ASR.seg = { base: Number(t0) || 0, ts: [], toks: [], lastRel: -1 };
  }
  VIDEO_ASR.seg.lastRel = startRel;
  VIDEO_ASR.seg.ts = ts.map(Number);
  VIDEO_ASR.seg.toks = toks.map(String);
}

function videoLiveText(now) {
  // 叠层只显示滚动的最近十秒：在线模型一句话可以很长，整段贴上去会糊住画面。
  const seg = VIDEO_ASR.seg;
  if (!seg || !seg.ts.length) return '';
  const newest = seg.base + seg.ts[seg.ts.length - 1];
  const from = Math.max(now - 11, newest - 9);
  let out = '';
  for (let i = 0; i < seg.ts.length; i += 1) {
    if (seg.base + seg.ts[i] >= from) out += seg.toks[i];
  }
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > 240 ? out.slice(-240) : out;
}
/* ---------- 旁路转写（宿主解码） ----------
   网页里那套 WebAudio 取 PCM 只是兜底：它受自动播放手势、倍速、缓冲影响。
   宿主这条更干净——Rust 把 mp4 音轨逐帧解成 16k 单声道直接喂 sherpa，
   时间戳来自容器，跟播放器时钟无关；播放暂停时它照样在后台往前跑，
   所以字幕常常是你还没看到就已经在了。 */
const VASR = {
  sid: 0, since: 0, tokens: [], audio: 0, stage: '', total: 0, downloaded: 0,
  timer: 0, video: null, ep: null, starting: false, failed: false,
};
try { window.__mytVasr = VASR; } catch (e) {}

function sideActive() { return !!(VASR.sid && VASR.stage !== 'error' && VASR.stage !== 'cancel'); }

function sideReset() {
  if (VASR.timer) { clearInterval(VASR.timer); VASR.timer = 0; }
  if (VASR.sid) { try { host().videoAsrCancel(VASR.sid); } catch (e) {} }
  if (VASR.sid) { try { host().videoAsrClose(VASR.sid); } catch (e) {} }
  VASR.sid = 0; VASR.since = 0; VASR.tokens = []; VASR.audio = 0;
  VASR.stage = ''; VASR.total = 0; VASR.downloaded = 0;
  VASR.video = null; VASR.ep = null; VASR.starting = false; VASR.failed = false;
}

async function startSideAsr(video, ep) {
  if (VASR.sid) return true;
  const H = host();
  if (!H || typeof H.videoAsrStart !== 'function') return false;
  if (!ep || !ep.videoUrl) return false;
  if (VASR.starting) return true;
  VASR.starting = true;
  VASR.video = video;
  VASR.ep = ep;
  try {
    const model = prefs.asrModel || ASR_MODEL_DEFAULT;
    const dir = await H.asrPrepare(model);
    if (!dir) throw new Error('模型没准备好');
    const sid = await H.videoAsrStart(ep.videoUrl, String(dir), 2);
    VASR.sid = Number(sid) || 0;
    if (!VASR.sid) throw new Error('宿主没给会话号');
    VASR.stage = 'download';
    videoAsrStatus('旁路转写 · 准备中…');
    VASR.timer = setInterval(() => { pollSideAsr(); }, 900);
    return true;
  } catch (err) {
    VASR.failed = true;
    videoAsrStatus('旁路转写没起来，改用实时识别：' + ((err && err.message) || err), true);
    return false;
  } finally {
    VASR.starting = false;
  }
}

async function pollSideAsr() {
  const H = host();
  if (!VASR.sid || !H || typeof H.videoAsrPoll !== 'function') return;
  let r = null;
  try { r = await H.videoAsrPoll(VASR.sid, VASR.since); } catch (e) { return; }
  if (!r || !VASR.sid) return;
  if (Array.isArray(r.tokens) && r.tokens.length) {
    for (const pair of r.tokens) {
      if (!Array.isArray(pair)) continue;
      const at = Number(pair[0]) || 0;
      const word = String(pair[1] || '');
      if (word) VASR.tokens.push([at, word]);
    }
    VASR.since = Number(r.index) || VASR.tokens.length;
  }
  VASR.audio = Number(r.audioSec) || 0;
  VASR.total = Number(r.total) || 0;
  VASR.downloaded = Number(r.downloaded) || 0;
  VASR.stage = String(r.stage || '');
  const name = videoAsrModelName(prefs.asrModel || ASR_MODEL_DEFAULT);
  if (VASR.stage === 'download') {
    const pct = VASR.total ? Math.round((VASR.downloaded / VASR.total) * 100) : 0;
    videoAsrStatus('旁路转写 · ' + name + ' · 下载 ' + pct + '%');
  } else if (VASR.stage === 'decode') {
    videoAsrStatus('旁路转写 · ' + name + ' · 已转写 ' + fmtClock(VASR.audio));
  } else if (VASR.stage === 'done') {
    videoAsrStatus('旁路转写 · ' + name + ' · 完成 ' + fmtClock(VASR.audio));
    if (VASR.timer) { clearInterval(VASR.timer); VASR.timer = 0; }
  } else if (VASR.stage === 'error') {
    videoAsrStatus('旁路转写失败：' + (r.error || '未知原因') + '，改用实时识别', true);
    if (VASR.timer) { clearInterval(VASR.timer); VASR.timer = 0; }
    // 宿主这条路垮了不能连累字幕：会话号丢掉，立刻退回网页抽流那条。
    const video = VASR.video;
    const ep = VASR.ep;
    VASR.sid = 0;
    if (video) { videoAsrMute(false); startVideoAsr(video, ep); }
  }
}

/* 按播放位置从「已经转好在手」的词里取最近 9 秒：不再有追着喂、追着认的问题。 */
function sideCueText(now) {
  const list = VASR.tokens;
  if (!list.length) return '';
  const at = Number(now) || 0;
  let out = '';
  let last = -1;
  for (let i = 0; i < list.length; i += 1) {
    const t = list[i][0];
    if (t > at + 4) break;
    if (t < at - 9) continue;
    // 播放位置落在两词之间时，把更近的那个也带上，避免一开播空一行
    if (t > at && last >= 0 && out === '') out += list[last][1];
    out += list[i][1];
    last = i;
  }
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > 260 ? out.slice(-260) : out;
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
  if (!show) { showToast('找不到这档节目，可能已经退订。', 6000); navigate('home'); return; }
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
    subtitleShowSuffix(show) + '</div></div><button class="btn ghost" data-route="library">← 返回播客库</button></div>' +
    '<div class="detail-hero show-hero">' + coverHTML(show, 'pod-art') + '<div style="min-width:0;flex:1"><div class="detail-meta"><span>' +
    (show.builtin ? '内置增强 Feed' : '站外订阅') + '</span><span>' + esc(show.builtin ? '本站' : hostOf(show.feed || '')) + '</span><span>' +
    (count ? count + ' 集' : '—') + '</span></div><div class="show-desc-wrap">' + '<p class="show-desc">' + esc(desc || '暂无简介。') + '</p>' + (desc && desc.length > 260 ? '<button class="textbtn show-desc-toggle" type="button">展开简介</button>' : '') + '</div><div class="detail-actions">' +
    (episodes[0] ? '<button class="btn primary" data-play-episode data-key="' + esc(show.slug) + '" data-ep="' + esc(episodes[0].id) + '">▶ 播放最新</button>' : '') +
    (show.local
      ? '<button class="btn ghost" data-route="local">管理本地文件</button>'
      : (show.builtin
        ? '<button class="btn ghost" data-sub-toggle="' + esc(show.slug) + '" title="点击退订">' + (subscribed ? '✓ 已订阅 · 退订' : '＋ 订阅') + '</button>'
        : '<button class="btn ghost" data-remove-sub="' + esc(show.slug) + '">移除订阅</button>')) +
    '</div>' + (error ? '<div class="modal-note err" style="margin-top:10px">' + esc(error) + '</div>' : '') + '</div></div>' +
    '<div class="grid two" style="margin-top:16px"><div class="card card-pad"><h3 class="section-title">单集 <small>' +
    (feed ? episodes.length + ' 集' : (show.episode_count && episodes.length < show.episode_count
      ? '最近 ' + episodes.length + ' / ' + show.episode_count + ' 集' : episodes.length + ' 集')) + '</small>' + loadAll + '</h3>' + filterChips + (filtered.length
      ? filtered.map(ep => episodeRowHTML(ep, show)).join('')
      : emptyLine(episodes.length ? '这个筛选下没有单集。' : (feed ? '该 feed 没有单集。' : '还没有读取单集。'))) + '</div><div class="card card-pad"><h3 class="section-title">节目资料</h3>' +
    '<div class="kv"><span>类型</span><b>' + (show.builtin ? '内置' : '站外') + '</b></div>' +
    '<div class="kv"><span>Feed</span><b>' + (show.feed ? '增强 RSS' : '—') + '</b></div>' +
    '<div class="kv"><span>文字稿</span><b>' + subtitleKvLabel(show) + '</b></div>' +
    '<div class="kv"><span>宿主</span><b>' + esc(show.builtin ? '本站 GitHub Pages' : hostOf(show.feed || '')) + '</b></div>' +
    '<div style="margin-top:14px;display:flex;gap:7px;flex-wrap:wrap">' +
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
  if (!show) { showToast('找不到这档节目，可能已经退订。', 6000); navigate('home'); return; }
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
  const moreActions = [
    (moduleOn('study') && subtitleCapability() === 'on' && ep.transcript?.url ? '<button class="btn ghost" data-ai-episode data-key="' + esc(show.slug) + '" data-ep="' + esc(ep.id) + '" title="用 LLM 总结本集，并生成可跳转的主题时间戳">AI 总结</button>' : ''),
    (ep.videoUrl ? '<button class="btn ghost" data-open-video-ep data-key="' + esc(show.slug) + '" data-ep="' + esc(ep.id) + '">▶ 视频</button>' : ''),
    '<button class="btn ghost" data-queue-episode data-key="' + esc(show.slug) + '" data-ep="' + esc(ep.id) + '">＋ 队列</button>',
    '<button class="btn ghost" data-fav-episode data-key="' + esc(show.slug) + '" data-ep="' + esc(ep.id) + '">' +
      (isFavorite(show.slug, ep.id) ? '★ 已收藏' : '☆ 收藏') + '</button>',
    '<button class="btn ghost" data-played-episode data-key="' + esc(show.slug) + '" data-ep="' + esc(ep.id) + '">' +
      (isPlayed(show.slug, ep.id) ? '✓ 已听' : '○ 标记已听') + '</button>',
    '<button class="btn ghost" data-list-episode data-key="' + esc(show.slug) + '" data-ep="' + esc(ep.id) + '">＋ 列表</button>',
    '<button class="btn ghost" data-copy-link data-key="' + esc(show.slug) + '" data-ep="' + esc(ep.id) + '">复制链接</button>',
  ].join('');
  view.innerHTML = '<div class="ep-head"><button class="crumb-link" type="button" data-open-podcast="' + esc(show.slug) + '">← ' +
    esc(show.name) + '</button><span class="ep-head-meta">' + (ep.date ? formatDate(ep.date) : '') +
    (fmtDuration(ep.duration) ? ' · ' + esc(fmtDuration(ep.duration)) : '') + '</span></div>' +
    '<div class="detail-hero ep-hero">' + episodeCover(ep, show) + '<div class="ep-hero-body">' +
    '<div class="eyebrow">EPISODE</div><h1 class="ep-title">' + esc(ep.title || '(无标题)') + '</h1>' +
    '<div class="detail-meta"><span>' + esc(show.name) + '</span><span>' + subtitleEpisodeLabel(show, ep) + '</span></div>' +
    '<div class="detail-actions">' +
    '<button class="btn primary" data-play-episode data-key="' + esc(show.slug) + '" data-ep="' + esc(ep.id) + '">▶ 播放单集</button>' +
    (host() ? '<button class="btn ghost" data-offline-episode data-key="' + esc(show.slug) + '" data-ep="' + esc(ep.id) + '" title="整集下载会同时保存文字稿">' +
      offlineAction + '</button>' : '') +
    (moreActions ? '<details class="more-menu"><summary class="btn ghost">更多</summary><div class="more-list">' + moreActions + '</div></details>' : '') +
    '<span class="plugin-slot" data-plugin-slot="episode.header.actions" data-slot-payload="' + epSlotPayload(show, ep, offlineRec) + '" data-slot-payload-version="1"></span>' +
    '</div></div></div>' +
    '<div class="plugin-slot" data-plugin-slot="episode.body.before" data-slot-payload="' + epSlotPayload(show, ep, offlineRec) + '" data-slot-payload-version="1"></div>' +
    '<div class="card card-pad" style="margin-top:16px"><h3 class="section-title">简介</h3><p class="smalltext ep-desc">' +
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
  // 空态里没有可清的内容，清空按钮不该出现（§8.4：不展示无用的支撑操作）
  const clearBtn = $('inboxClearBtn');
  if (clearBtn) clearBtn.hidden = !app.inbox.length;
  const inboxBox = $('inboxList');
  motionFlip(inboxBox, '.ep-row', () => {
  inboxBox.innerHTML = app.inbox.length
    ? app.inbox.map(item => {
      const { show, ep } = inboxEpisode(item);
      const target = playTarget(show.slug, ep.id);
      return '<div class="ep-row' + (target.ok ? '' : ' is-stale') + '" data-play-episode data-key="' + esc(show.slug) + '" data-ep="' + esc(ep.id) + '">' +
        episodeCover(ep, show) + '<div class="ep-body"><span class="ep-title">' + esc(item.title || ep.title || '(无标题)') +
        '</span><span class="ep-sub">' + esc(item.show || show.name || '') + (item.date ? ' · ' + formatDate(item.date) : '') +
        (target.ok ? '' : ' · ' + playTargetLabel(target)) +
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
      const target = playTarget(item.showKey, item.epId);
      const show = target.show || { slug: item.showKey, name: item.showKey, key: item.showKey };
      const ep = episodesOf(show).find(entry => entry.id === item.epId) || { id: item.epId, title: '单集 ' + item.epId.slice(0, 8) };
      return '<div class="ep-row' + (target.ok ? '' : ' is-stale') + '" data-play-episode data-key="' + esc(show.slug) + '" data-ep="' + esc(ep.id) + '">' +
        episodeCover(ep, show) + '<div class="ep-body"><span class="ep-title">' + esc(ep.title || '(无标题)') +
        '</span><span class="ep-sub">' + esc(show.name || '') + (ep.date ? ' · ' + formatDate(ep.date) : '') +
        (target.ok ? '' : ' · ' + playTargetLabel(target)) +
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
      const target = playTarget(item.key, item.ep);
      const show = target.show || { slug: item.key, name: item.show, key: item.key };
      return '<div class="ep-row' + (target.ok ? '' : ' is-stale') + '" data-play-episode data-key="' + esc(item.key) + '" data-ep="' + esc(item.ep) + '">' +
        '<span class="ep-dur">' + String(index + 1).padStart(2, '0') + '</span>' +
        episodeCover({ id: item.ep, img: item.img }, show) + '<div class="ep-body"><span class="ep-title">' +
        esc(item.title || '(无标题)') + '</span><span class="ep-sub">' + esc(show.name || item.show || '') +
        (item.date ? ' · ' + formatDate(item.date) : '') + (target.ok ? '' : ' · ' + playTargetLabel(target)) + '</span></div><span class="ep-dur">' +
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
      const target = playTarget(key, epId);
      const show = target.show || { slug: key, name: rec.show || key, key };
      const pct = rec.d ? Math.min(100, Math.round((rec.t / rec.d) * 100)) : 0;
      return '<div class="ep-row' + (target.ok ? '' : ' is-stale') + '" data-resume data-key="' + esc(key) + '" data-ep="' + esc(epId) + '" data-t="' + Number(rec.t || 0) + '">' +
        episodeCover({ id: epId, img: rec.img }, show) + '<div class="ep-body"><span class="ep-title">' +
        esc(rec.title || '(无标题)') + '</span><span class="ep-sub">' + esc(rec.show || show.name || '') + ' · ' +
        fmt(rec.t) + (rec.d ? ' / ' + fmt(rec.d) : '') + (target.ok ? '' : ' · ' + playTargetLabel(target)) + '</span><div class="progress"><i style="width:' + pct + '%"></i></div></div>' +
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
        (playTarget(item.key, item.ep).ok ? '' : ' · ' + playTargetLabel(playTarget(item.key, item.ep))) +
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
