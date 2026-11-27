import { $, ASR_MODEL_DEFAULT, audio, box, host, prefs, setState, state, tauriHost } from './00-runtime.js';
import { closeOverlays, closeTypeSheet, emptyLine, esc, fmt, isBracket, isJsonTranscript, loaderHTML, pluginPageKey, reader, seekTo, setImmersive, setWallpaper, showToast, splitLabel, statHTML, syncCustomThemeEditor } from './01-theme-reader-shell.js';
import { syncLiveLeadSelect } from './02-live-caption-wasm.js';
import { selectEpisode } from './03-native-asr-service-worker.js';
import { PLUGIN_PAGES, applySlotMounts, backfillWallArt, coverSrc, destroyV2Page, emitPlugin, loadShow, pluginPlayerState, pluginReportError, refreshPluginSettings, renderPluginPage, renderV2Page, smallArtwork, subtitlePluginOn } from './04-local-audio-plugin-host.js';
import { BACK_PAGES, LOCAL_KEY, PAGE_NAMES, QUEUE_KEY, THEME_NAMES, absoluteFeed, app, catalogLatest, epStatusBadges, episodeFilterMatch, episodesOf, firstShowKey, fmtBytes, fmtDuration, formatDate, hash32, hostOf, idxGetAll, inboxCount, isFavorite, isPlayed, isSubscribed, moduleOn, navigate, notifyPlayTargetFailure, offlineKeyFor, parseRoute, plainText, playTarget, playTargetLabel, readAllProgress, readJSON, refreshShows, renderAfterStateChange, refreshOffline, renderDownloads, renderOfflineList, renderPlaylists, returnToCue, routeHash, routeModuleAllows, showByKey, showPrefFor, syncDockBadge, syncDockSleep, syncIndexCount, syncRateSeg, writeJSON } from './05-transport-transcript-nav.js';
import { coverHTML, ensureShowFeed, episodeCover, hasFreshFeed, memoryFeed, renderChartPanel, renderOnlineResults } from './06-catalog-feeds-search.js';
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
    if (currentPage === 'home') {
      app.homeScroll = sc.scrollTop;
      app.homeScrollX = sc.scrollLeft;
      app.homeWallCount = document.getElementById('homeRecommended')?.querySelectorAll('.pod-card').length || 0;
      /* 连“当时选中的是哪一块”一起记下来：从详情页退回来只还原滚动位置的话，
         墙停在原地但没有选中框，看不出自己刚点的是哪一档。 */
      const cur = document.querySelector('#homeRecommended .pod-card.is-cursor');
      app.homeCursorSlug = cur ? tileSlugOf(cur) : '';
    }
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
  /* 返回按钮要「从哪来回哪去」：只有无参页面进栈，单集/播放器不占位。
     否则首页 → 节目 → 单集 →（历史返回）节目的路径会把 lastPage 落成 episode，
     按钮退化成「返回播客库」，回不到首页。 */
  if (BACK_PAGES.includes(route.page)) {
    const trail = app.pageTrail = Array.isArray(app.pageTrail) ? app.pageTrail : [];
    if (trail[trail.length - 1] !== route.page) {
      trail.push(route.page);
      if (trail.length > 8) trail.shift();
    }
  }
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
  // 新页面渲染时焦点/滚动锚点会把 .main 顶到半截；渲染完再归零，别让统计页从首页的几百像素处开始
  if (route.page !== 'home' && sc) {
    const zero = () => {
      if (app.routePage !== route.page) return;
      sc.scrollTop = 0;
      sc.scrollLeft = 0;
    };
    requestAnimationFrame(zero);
    setTimeout(zero, 90);
  }
  if (route.page === 'home' && currentPage && currentPage !== 'home') {
    const top = app.homeScroll || 0;
    const plane = foliaPlane();
    const left = app.homeScrollX != null ? app.homeScrollX : Number(plane?.dataset.blockW || 0);
    if (sc) {
      /* 正在播放时回首页：镜头直接追到播放的那块（Folia 的 locate 也是这个含义），
         不再“还原上次滚到哪儿”——两者一起做会互相拉扯，镜头刚追过去又被拉回原位。
         没有播放才回落到上次的滚动位置 / 选中的那块。 */
      const playing = state.current ? (() => {
        syncPlayingTiles();
        return document.querySelector('#homeRecommended .pod-card.is-playing-tile');
      })() : null;
      if (playing) {
        requestAnimationFrame(() => {
          if (app.routePage !== 'home') return;
          const r = playing.getBoundingClientRect();
          const offX = Math.abs((r.left + r.width / 2) - sc.clientWidth / 2);
          const offY = Math.abs((r.top + r.height / 2) - sc.clientHeight / 2);
          if (r.width < 1 || offX > 40 || offY > 40) centerTileAnywhere(playing);
        });
        if (!audio.paused) startTileLyricLoop();
        updateDocumentTitle();
        syncMini();
        return;
      }
      // 墙会先补回上次的纵深再能滚到底；高度不够时多试几次，别把位置截在旧墙底
      let tries = 0;
      const restore = () => {
        if (app.routePage !== 'home') return;
        jumpTop(top);
        if (left) {
          const prev = sc.style.scrollBehavior;
          sc.style.scrollBehavior = 'auto';
          sc.scrollLeft = left;
          sc.style.scrollBehavior = prev;
        }
        const slug = app.homeCursorSlug;
        if (slug) {
          const card = [...document.querySelectorAll('#homeRecommended .pod-card')].find(c => tileSlugOf(c) === slug);
          if (card) {
            setWallCursor(card, { pan: false });
            const r = card.getBoundingClientRect();
            const offX = Math.abs((r.left + r.width / 2) - sc.clientWidth / 2);
            const offY = Math.abs((r.top + r.height / 2) - sc.clientHeight / 2);
            if (r.width < 1 || offX > 80 || offY > 80) centerTileAnywhere(card);
          }
        }
        // 墙在这一屏还没铺够时滚动会被截住，多试几轮，直到位置真的落回原处
        if ((Math.abs(sc.scrollTop - top) > 4 || sc.scrollHeight < top + sc.clientHeight) && tries++ < 8) setTimeout(restore, 150);
      };
      requestAnimationFrame(restore);
    }
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
  } else if (subtitlePluginOn() && box && box.dataset.nativeAudio === '1') {
    /* 之前在「字幕插件未启用」的音频模式下停过这一集：插件刚被重新启用，
       阅读区还挂着那条旧说明，cue 数据也是空的。回到本集时补载一次文字稿，
       否则用户只能去点别的单集再点回来才会恢复。 */
    selectEpisode(state.current, true);
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
  else if (page === 'bookmarks') {
    /* 书签是「按句收藏」，字幕能力关掉后连入口都收起了：直接的手打 hash 也改道收藏页，
       不留在空页面上。 */
    if (!subtitlePluginOn()) { navigate('favorites'); return; }
    renderBookmarks();
  }
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
  /* 插件关掉就当作“这个应用没有字幕”，卡片上不再挂任何相关徽章。 */
  return cap === 'web' ? '网页版仅音频' : '';
}
function subtitleShowSuffix(show) {
  const cap = subtitleCapability();
  if (cap === 'on') return show?.builtin ? ' · 双语词级文字稿' : ' · 站外节目仅音频';
  if (cap === 'web') return show?.builtin ? ' · 网页版仅音频（桌面版支持字幕）' : ' · 站外节目仅音频';
  return '';
}
function subtitleKvLabel(show) {
  const cap = subtitleCapability();
  if (cap === 'on') return show?.builtin ? '双语词级' : '无';
  /* 空串＝这一行整行不渲染，节目资料里不再出现“文字稿”一栏。 */
  return cap === 'web' ? '网页版仅音频' : '';
}
function subtitleEpisodeLabel(show, ep) {
  const cap = subtitleCapability();
  if (cap === 'web') return '网页版仅音频';
  if (cap === 'desktop-off') return '';
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
  const badgeLabel = show.builtin ? subtitleCardBadge(show) : '站外 · 仅音频';
  const badge = badgeLabel
    ? '<span class="pill' + (show.builtin && subtitleCapability() === 'on' ? '' : ' dim') + '">' + badgeLabel + '</span>'
    : '';
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
    '" data-open-podcast="' + esc(show.slug) + '">' + coverHTML(show, null, 640) +
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
/* 首页瓦片：正在播放的那个节目的瓦片亮起珊瑚描边（Folia 的“正在播放”标记）。
   二维墙里同一档节目每列各有一块，"正在播放"却只该有一块——以前是每列各标一块，
   两列同框时就会看到两块一模一样的封面同时挂着字幕。现在全墙只挑一块：
   优先保留已经露着大半的，其次挑离镜头中心最近的那块；墙一平移就跟着搬过去。 */
function syncPlayingTiles() {
  const folia = document.documentElement.dataset.theme === FOLIA_THEME_ID;
  const key = (state.current && state.current.showKey) || '';
  const el = document.querySelector('audio');
  const live = el ? !el.paused : false;
  const cards = [...document.querySelectorAll('#homeRecommended .pod-card')];
  let target = null;
  if (folia && key) {
    const sc = document.querySelector('.main');
    const sr = (sc || document.documentElement).getBoundingClientRect();
    const score = (card) => {
      const r = card.getBoundingClientRect();
      const ix = Math.max(0, Math.min(r.right, sr.right) - Math.max(r.left, sr.left));
      const iy = Math.max(0, Math.min(r.bottom, sr.bottom) - Math.max(r.top, sr.top));
      const area = (ix * iy) / Math.max(1, r.width * r.height);
      const dx = r.left + r.width / 2 - (sr.left + sr.width / 2);
      const dy = r.top + r.height / 2 - (sr.top + sr.height / 2);
      return { area, d: Math.hypot(dx, dy) };
    };
    // 迟滞：现在这块还露着 45% 以上就别搬——搬一次要 FLIP + 重建字幕，不能每滚一点都搬
    const keep = cards.find(c => c.classList.contains('is-playing-tile') && tileSlugOf(c) === key && score(c).area > 0.45);
    const cands = cards.filter(c => tileSlugOf(c) === key);
    target = keep || cands.sort((a, b) => {
      const sa = score(a), sb = score(b);
      if ((sa.area > 0) !== (sb.area > 0)) return sa.area > 0 ? -1 : 1;
      return sa.d - sb.d;
    })[0] || null;
  }
  let grew = false;
  cards.forEach(card => {
    const on = card === target;
    const was = card.classList.contains('is-playing-tile');
    const changed = on !== was;
    const apply = () => {
      card.classList.toggle('is-playing-tile', on);
      card.classList.toggle('is-playing-tile-live', on && live);
      if (on) {
        // 播放态接管这一块的重排（6×6 钉在原槽位）：手动展开的卡已经钉好了，别重算
        if (changed && !card.classList.contains('is-peek')) applyBlockLayout(card.closest('#homeRecommended'));
        ensureTileLyric(card);
      } else {
        paintTileArt(card, false);
        const full = card.querySelector('.tile-full');
        if (full) full.remove();
        const lyric = card.querySelector('.tile-live-lyric');
        if (lyric) lyric.remove();
        card.classList.remove('has-tile-lyric');
        if (!folia) clearTileSpan(card);
        else if (changed && foliaPlane()) {
          // 退出播放态：这一块要还原成图样（手动展开的那张此时已经不是 is-playing，同样按块重排）
          applyBlockLayout(card.closest('#homeRecommended'));
        } else if (!card.classList.contains('is-peek')) {
          restoreTileSpan(card);
        }
      }
    };
    // 播放状态变化会让瓦片从小格长成大格：和点开一样走 FLIP，别让整墙硬跳
    if (changed) { flipTile(card, apply); if (on) grew = true; } else apply();
  });
  // 瓦片撑成 6×6 会多占两行，密排会留下一个洞；二维墙靠块内重排吸收，单列墙才补块
  if (grew) setTimeout(() => { const w = foliaWall(); if (w && homeActive() && !foliaPlane()) extendWall(w); }, 520);
  updateLocateBtn();
  if (target) warmTileLyric();
}
/* 字幕数据是异步到的：播放态瓦片先被标出来，cue 还在路上时字幕块是空的，
   如果这时按了暂停（没有 timeupdate）就会一直空着。这里短轮询几次把它填上。 */
let tileLyricWarm = 0;
function warmTileLyric() {
  if (tileLyricWarm) return;
  let tries = 0;
  tileLyricWarm = setInterval(() => {
    tries += 1;
    updateTileLyric();
    const box = document.querySelector('#homeRecommended .pod-card.is-playing-tile .tile-live-lyric');
    if ((box && box.innerHTML) || tries >= 40) { clearInterval(tileLyricWarm); tileLyricWarm = 0; }
  }, 400);
}
/* 墙平移时换"正在播放"那块：滚完 160ms 再算一次，别拖成每帧一次 FLIP。
   有瓦片正撑开（is-peek）时不算：这时它 neighbourhood 的槽位正在变，
   重排一次就把撑开的卡挤走，镜头去追、再挤，就是"左右来回闪"。 */
let playingSyncTimer = 0;
function schedulePlayingSync() {
  if (playingSyncTimer) return;
  playingSyncTimer = setTimeout(() => {
    playingSyncTimer = 0;
    if (document.querySelector('#homeRecommended .pod-card.is-peek')) return;
    if (homeActive() && state.current) syncPlayingTiles();
  }, 160);
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
      // 已经标好播放瓦片就别再算一遍：syncPlayingTiles 会顺手 FLIP 放大/补墙，
      // 和紧接着的整墙滑动叠在一起，看起来就是"大瓦片在闪"。
      if (!document.querySelector('#homeRecommended .pod-card.is-playing-tile')) syncPlayingTiles();
      const key = (state.current && state.current.showKey) || '';
      const cards = [...document.querySelectorAll('#homeRecommended .pod-card')];
      const sc = document.querySelector('.main');
      const cx = sc ? sc.getBoundingClientRect().left + sc.clientWidth / 2 : 0;
      const cy = sc ? sc.getBoundingClientRect().top + sc.clientHeight / 2 : 0;
      const dist = c => { const r = c.getBoundingClientRect(); return (r.left + r.width / 2 - cx) ** 2 + (r.top + r.height / 2 - cy) ** 2; };
      // 二维墙同一档节目每列各有一块：定位到离视口中心最近的那块，不要跨两列回左上
      const card = cards.filter(c => c.classList.contains('is-playing-tile')).sort((a, b) => dist(a) - dist(b))[0] ||
        cards.find(c => tileSlugOf(c) === key);
      if (!card) return;
      centerTile(card);
      /* 描边闪烁必须等墙面滑稳再打。原来是一边 smooth 滑 460ms、一边给 6×6 的大瓦片
         逐帧动画 box-shadow，整块在动 + 整块重绘叠在一起，WebView2 上就是"大瓦片闪"。
         有 scrollend 就等它，没有就按实测的 520ms 兜底。 */
      const flash = () => {
        card.classList.remove('locate-flash');
        void card.offsetWidth;
        card.classList.add('locate-flash');
        setTimeout(() => card.classList.remove('locate-flash'), 900);
      };
      const scroller = sc && sc.closest('.main');
      if (scroller && typeof scroller.addEventListener === 'function') {
        let fired = false;
        const once = () => {
          if (fired) return;
          fired = true;
          scroller.removeEventListener('scrollend', once);
          flash();
        };
        scroller.addEventListener('scrollend', once);
        setTimeout(once, 620);
      } else {
        flash();
      }
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
  new MutationObserver(() => { syncPlayingTiles(); ensureWallDepth(); syncFoliaPlane(); }).observe(host, { childList: true });
  syncPlayingTiles();
}
document.addEventListener('DOMContentLoaded', () => { bindPlayingRowSync(); watchHomeTiles(); bindCoverStage(); });

/* ---- Folia「海报墙」主题的三件交互：瓦片原地展开 / 墙无限补块 / 播放瓦片压歌词 ---- */
const FOLIA_THEME_ID = 'ct-pack-folia-poster';
const foliaWall = () => (document.documentElement.dataset.theme === FOLIA_THEME_ID
  ? document.getElementById('homeRecommended') : null);
const homeActive = () => !!$('page-home')?.classList.contains('active');
const TILE_SET_SIZE = 12;   // 一块 = 12 席，12 栏 × 8 行严格铺满（BLOCK_TEMPLATES）
const TILE_MAX = 120;       // 单列瀑布的硬上限：120 块 ≈ 10 屏，再往后全是重复节目，白白占内存
/* Folia 的二维墙按列算：48 = 12×4，四整块；纵向搬块要上下各留一块缓冲，三列合计 144 块。
   原来 84/列（三列 252 块）在 1180×880 的窗口里根本没有一屏能同时看到，只贡献 DOM 和合成层。 */
const FOLIA_COL_CAP = 48;
const FOLIA_COLUMNS = 3;    // 二维墙：三列 12 栏块并排，左右各留一块，走到边上就原地倒块
/* 窄屏（<=900，与 CSS 的移动端断点一致：这个宽度起底栏导航已经接管）不铺二维墙，退回单页瀑布 */
const foliaNarrow = () => !!(window.matchMedia && window.matchMedia('(max-width: 900px)').matches);

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
  let closed = false;
  document.querySelectorAll('#homeRecommended .pod-card.is-peek').forEach(card => {
    if (card !== except) {
      closed = true;
      flipTile(card, () => { card.classList.remove('is-peek'); restoreTileSpan(card); });
    }
  });
  // 收起后槽位又变了，补一次播放瓦片的同步（撑开期间是被主动跳过的）
  if (closed) setTimeout(schedulePlayingSync, 320);
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
    fitLyricBox(box, 34);
    refreshLyricPalette(box, null);
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
/* 共享元素转场：先在页面上放一张和卡片封面同位置同裁切的克隆图，让它长到整屏，
   长满后再在它下面 showModal 真舞台；对话框创建那一下的卡顿被克隆图挡掉。 */
let coverMorph = null;
let coverSourceCard = null;
let coverMorphReverse = false;
function ensureCoverMorph() {
  if (coverMorph) return coverMorph;
  const wrap = document.createElement('div');
  wrap.id = 'coverMorph';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.style.cssText = 'position:fixed;inset:0;z-index:120;display:none;pointer-events:none;';
  const scrim = document.createElement('div');
  scrim.style.cssText = 'position:absolute;inset:0;background:#040406;opacity:0;transition:opacity .26s linear;';
  const im = document.createElement('img');
  im.alt = '';
  im.style.cssText = 'position:absolute;object-fit:cover;object-position:center;border:0;border-radius:0;box-shadow:none;margin:0;max-width:none;max-height:none;opacity:1;will-change:left,top,width,height;';
  wrap.append(scrim, im);
  document.body.appendChild(wrap);
  coverMorph = { wrap: wrap, scrim: scrim, img: im };
  return coverMorph;
}
function abortCoverMorph() {
  if (!coverMorph) return;
  coverMorph.wrap.style.display = 'none';
  coverMorph.wrap.style.pointerEvents = 'none';
  coverMorph.img.removeAttribute('src');
}
function startCoverMorph(src, rect, done, reverse) {
  const m = ensureCoverMorph();
  const wrap = m.wrap, scrim = m.scrim, im = m.img;
  im.src = src;
  im.style.transition = 'none';
  if (reverse) {
    im.style.left = '0px';
    im.style.top = '0px';
    im.style.width = window.innerWidth + 'px';
    im.style.height = window.innerHeight + 'px';
    scrim.style.opacity = '1';
  } else {
    im.style.left = rect.left + 'px';
    im.style.top = rect.top + 'px';
    im.style.width = rect.width + 'px';
    im.style.height = rect.height + 'px';
    scrim.style.opacity = '0';
  }
  wrap.style.display = 'block';
  wrap.style.pointerEvents = 'auto';
  void im.offsetWidth;
  requestAnimationFrame(() => {
    const ease = 'cubic-bezier(.22,.9,.2,1)';
    im.style.transition = 'left .46s ' + ease + ', top .46s ' + ease + ', width .46s ' + ease + ', height .46s ' + ease;
    if (reverse) {
      im.style.left = rect.left + 'px';
      im.style.top = rect.top + 'px';
      im.style.width = rect.width + 'px';
      im.style.height = rect.height + 'px';
      scrim.style.opacity = '0';
    } else {
      im.style.left = '0px';
      im.style.top = '0px';
      im.style.width = window.innerWidth + 'px';
      im.style.height = window.innerHeight + 'px';
      scrim.style.opacity = '1';
    }
  });
  setTimeout(done, 470);
}
function closeCoverStage() {
  const layer = $('coverStage');
  if (!layer || !layer.open || layer.dataset.closing === '1') return;
  layer.dataset.closing = '1';
  coverLoadToken++;
  stopCoverLyricLoop();
  const card = coverSourceCard;
  const box = card && card.isConnected ? (card.querySelector('.pod-art') || card) : null;
  const r = box ? box.getBoundingClientRect() : null;
  const canReverse = !motionReduced() && r && r.width > 40 && r.height > 40
    && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth
    && /folia-poster/.test(document.documentElement.getAttribute('data-theme') || '');
  const im = $('csImg');
  if (canReverse) {
    /* 反向共享元素：先把整屏克隆图盖上去，再在它下面关 dialog（关闭那一下卡顿被同图挡住），
       然后让克隆图缩回卡片原位。舞台不做淡出，少一次整屏重绘。 */
    coverMorphReverse = true;
    startCoverMorph(im && im.src ? im.src : '', r, () => {
      coverMorphReverse = false;
      abortCoverMorph();
    }, true);
    requestAnimationFrame(() => { if (layer.open) layer.close(); });
    return;
  }
  layer.classList.remove('on', 'lyric-on');
  setTimeout(() => { if (layer.open) layer.close(); }, motionReduced() ? 0 : 440);
}
function openCoverStage(card) {
  const layer = $('coverStage');
  if (!layer || !card || layer.open) return;
  coverSourceCard = card;
  const playing = card.classList.contains('is-playing-tile');
  const artImg = card.querySelector('.pod-art img');
  const epImg = playing && state.current && state.current.img ? state.current.img : '';
  const show = showByKey(tileSlugOf(card));
  const showArt = show && show.artwork ? show.artwork : '';
  /* 分集封面优先，但外站封面经常 403 / 超时：候选按顺序退，最后一张也失败时
     落到 CSS 生成的深色底，不再把整块窗口留成纯黑。 */
  const candidates = [...new Set([epImg, showArt, artImg ? artImg.getAttribute('src') : '']
    .filter(Boolean)
    .filter(src => !/^http:\/\/mytmedia\.localhost/i.test(src)))];
  if (!candidates.length) { showToast('这张封面还没有图。', 'warn'); return; }
  const titleEl = card.querySelector('.pod-card-main > strong');
  const title = (playing && state.current && state.current.title) ? state.current.title : (titleEl ? titleEl.textContent.trim() : '');
  const showName = (playing && state.show && state.show.name) ? state.show.name : (card.querySelector('.pod-meta') ? card.querySelector('.pod-meta').textContent.trim() : '');
  const img = $('csImg'), bg = $('csBg');
  const token = ++coverLoadToken;
  /* 共享元素：全屏封面从卡片里那块封面长出来，而不是先黑一下再原地淡入。
     只有 Folia 的封面是全屏铺满的，其它主题的封面是小卡片，硬套裁切会算错边。 */
  const artBox = artImg || card.querySelector('.pod-art');
  const srcRect = artBox ? artBox.getBoundingClientRect() : card.getBoundingClientRect();
  const clipFromRect = /folia-poster/.test(document.documentElement.getAttribute('data-theme') || '')
    && !!(img && srcRect && srcRect.width > 40 && srcRect.height > 40);
  layer.classList.add('cover-empty');
  const paintCover = (src) => {
    if (token !== coverLoadToken) return;
    /* 舞台/底图都走同一条代理链路：命中本地缓存时开全屏不用再等远端。 */
    const real = coverSrc(src);
    if (img) { img.src = real; img.alt = title || '节目封面'; }
    if (bg) bg.style.backgroundImage = 'url(' + JSON.stringify(real) + ')';
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
  const first = candidates.shift();
  paintCover(first);
  const startStage = (instant) => {
    if (token !== coverLoadToken) return;
    const k = $('csKicker'), t = $('csTitle'), s = $('csSub');
    if (k) k.textContent = playing ? '正在播放' : '节目封面';
    if (t) t.textContent = title || '未命名节目';
    if (s) s.textContent = showName || '';
    const hasLyric = !!(playing && state.cues && state.cues.length);
    delete layer.dataset.closing;
    layer.classList.toggle('lyric-on', hasLyric);
    if (instant) {
      /* 克隆图已经长满整屏：真舞台必须一帧到位，不能再走 0→1 的淡入 */
      layer.style.transition = 'none';
      if (img) {
        img.style.transition = 'none';
        img.style.opacity = '1';
        img.style.transform = 'none';
        img.style.inset = '0';
        img.style.left = '';
        img.style.top = '';
        img.style.width = '';
        img.style.height = '';
      }
    } else if (clipFromRect) {
      img.style.transition = 'none';
      img.style.opacity = '1';
      img.style.transform = 'none';
      img.style.inset = 'auto';
      img.style.left = srcRect.left + 'px';
      img.style.top = srcRect.top + 'px';
      img.style.width = srcRect.width + 'px';
      img.style.height = srcRect.height + 'px';
      void img.offsetWidth;   // 先把起始盒提交一帧，否则和终点同帧写入会被压成瞬移
    }
    layer.showModal();
    if (hasLyric) updateCoverLyric();
    const lyricBox = $('csLyric');
    if (lyricBox && !hasLyric) { lyricBox.replaceChildren(); lyricBox.dataset.signature = ''; }
    if (instant) {
      layer.classList.add('on');
      requestAnimationFrame(() => requestAnimationFrame(() => {
        abortCoverMorph();
        layer.style.transition = '';
      }));
    } else {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (layer.open && layer.dataset.closing !== '1') {
          layer.classList.add('on');
          if (clipFromRect) {
            const ease = 'cubic-bezier(.22,.9,.2,1)';
            img.style.transition = 'left .46s ' + ease + ', top .46s ' + ease + ', width .46s ' + ease + ', height .46s ' + ease;
            img.style.left = '0px';
            img.style.top = '0px';
            img.style.width = window.innerWidth + 'px';
            img.style.height = window.innerHeight + 'px';
          }
        }
      }));
    }
    if (hasLyric) startCoverLyricLoop();
  };
  // 3k 封面解码/首帧光栅化会顶掉一整帧；先把图解码好再开 dialog，过渡里只做合成层动画
  const ready = (img && first && img.decode)
    ? Promise.race([img.decode().catch(() => {}), new Promise(r => setTimeout(r, 140))])
    : Promise.resolve();
  ready.then(() => {
    if (!clipFromRect || !img || motionReduced()) { startStage(false); return; }
    // 先在页面上长克隆图，长满后再换真舞台：模态层那一下的卡顿被同图挡掉
    startCoverMorph(img.src, srcRect, () => startStage(true));
  });
}
function bindCoverStage() {
  const layer = $('coverStage');
  if (!layer || layer.dataset.bound) return;
  layer.dataset.bound = '1';
  const close = $('csClose');
  if (close) close.addEventListener('click', closeCoverStage);
  const backdrop = $('csBackdrop');
  if (backdrop) backdrop.addEventListener('click', closeCoverStage);
  /* 窗口全屏/改尺寸时，已经铺满的封面要跟着长，不能被钉在打开那一刻的像素尺寸上 */
  window.addEventListener('resize', () => {
    const stage = $('coverStage');
    if (!stage || !stage.open) return;
    const im = $('csImg');
    if (!im || !im.style.width) return;
    im.style.transition = 'none';
    im.style.width = window.innerWidth + 'px';
    im.style.height = window.innerHeight + 'px';
  });
  layer.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeCoverStage();
  });
  layer.addEventListener('close', () => {
    stopCoverLyricLoop();
    layer.classList.remove('on', 'lyric-on');
    const ci = $('csImg');
    if (ci) {
      ci.style.transition = ''; ci.style.clipPath = ''; ci.style.opacity = ''; ci.style.transform = '';
      ci.style.inset = ''; ci.style.left = ''; ci.style.top = ''; ci.style.width = ''; ci.style.height = '';
    }
    const box = $('csLyric');
    if (box) { box.replaceChildren(); box.dataset.signature = ''; }
    if (!coverMorphReverse) abortCoverMorph();
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
  if (typeof motionReduced === 'function' && motionReduced()) { mutate(); return card.getBoundingClientRect(); }
  const wall = card.closest('#homeRecommended');
  const cards = wall ? [...wall.querySelectorAll('.pod-card')].filter(c => {
    const r = c.getBoundingClientRect();
    // 只动视口内（含一点预看）的瓦片；1.6 屏外的也做 FLIP 会把整列几十块一起拉起
    return r.width > 0 && r.bottom > -40 && r.top < window.innerHeight + 40;
  }) : [card];
  const before = new Map(cards.map(c => [c, c.getBoundingClientRect()]));
  mutate();
  let finalRect = null;
  cards.forEach(c => {
    const a = before.get(c);
    const b = c.getBoundingClientRect();
    if (c === card) finalRect = b;
    if (!a || !b.width || !a.width) return;
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    const sx = a.width / b.width;
    const sy = a.height / b.height;
    const scaled = Math.abs(sx - 1) > 0.02 || Math.abs(sy - 1) > 0.02;
    /* 槽位变化时宽高比也会变（4×6 方卡 → 6×6 播放卡、展开的 6×6 等）。
       对宽高比差异大的瓦片不再用 scale(sx, sy) 硬拉：非等比缩放会把封面里的斜线、人像
       暂时拉歪，看着就是“封面斜了一下”。这类只做位移 + 淡入，保持画面比例不畸变。 */
    const distorted = Math.abs(sx / sy - 1) > 0.08;
    if (distorted) {
      /* 被点开的这一块只做位移。以前这里补间 width/height（border-box）+ opacity 0.86→1：
         宽高不是合成属性，4K 宽的墙上每帧都要整块重排重绘，带字幕/大封面的播放瓦片最明显，
         看上去就是"点一下这块闪一下"。宽高直接落到新值，只补一段位移。
         旁边被挤动的也只位移，不做 opacity 一闪（几十块一起闪比不动更刺眼）。 */
      if (c === card && a.width > 0 && b.width > 0 && (Math.abs(dx) > 1 || Math.abs(dy) > 1)) {
        c.animate([
          { transform: 'translate(' + dx + 'px,' + dy + 'px)' },
          { transform: 'translate(0,0)' }
        ], {
          duration: 320,
          easing: 'cubic-bezier(0.22, 0.9, 0.2, 1)'
        });
        return;
      }
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      c.animate([
        { transform: 'translate(' + dx + 'px,' + dy + 'px)' },
        { transform: 'translate(0,0)' }
      ], {
        duration: 260,
        easing: 'cubic-bezier(0.22, 0.9, 0.2, 1)'
      });
      return;
    }
    if (!scaled && Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    c.animate([
      { transformOrigin: 'top left', transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + (scaled ? sx : 1) + ',' + (scaled ? sy : 1) + ')' },
      { transformOrigin: 'top left', transform: 'translate(0,0) scale(1,1)' }
    ], {
      duration: c === card ? 440 : 360,
      easing: c === card ? 'cubic-bezier(0.2, 0.9, 0.2, 1)' : 'cubic-bezier(0.25, 0.9, 0.2, 1)'
    });
  });
  return finalRect;
}

function bindTilePeek() {
  // 捕获阶段拦：宿主自己的 data-open-podcast 路由监听比 bubble 更早跑，晚了就压不住跳转
  document.addEventListener('click', (e) => {
    // 二维墙里镜头可能正对着复制列；容器要用整块平面，不能只认原始的那一列
    const wall = foliaPlane() || foliaWall();
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
    if (!card || !wall.contains(card)) { collapseTiles(); clearWallCursor(); return; }
    if (e.target.closest('.tile-peek-actions a, .pod-actions')) return;   // 让链接与快钮各自干活
    const main = e.target.closest('.pod-card-main');
    if (!main) return;
    // 左右两列也是墙的一部分：点击同样「放大居中」，不再直跳节目页——
    // 想进详情就点展开后描述层里的「进入节目页」。
    e.preventDefault();
    e.stopPropagation();
    setWallCursor(card, { pan: false });
    if (card.classList.contains('is-peek')) {
      flipTile(card, () => { card.classList.remove('is-peek'); restoreTileSpan(card); });
      setTimeout(schedulePlayingSync, 320);
      return;
    }
    collapseTiles(card);
    const final = flipTile(card, () => {
      card.classList.add('is-peek');
      applyBlockLayout(card.closest('#homeRecommended'));
      ensureTilePeek(card);
    });
    // 用“撑开后的最终矩形”算镜头目标；动画中途量到的是补间宽高，会把大卡推偏
    if (final) centerTileAnywhere(card, final);
    /* 撑开之后封面/描述/字号还在陆续落位，瓦片会被再挤一两次。
       以前挂 500/950/1500 三个定时器、每个都走 centerTileAnywhere（smooth 460ms），
       一次点击能滚三四趟，看上去就是“这块瓦片在左右闪来闪去最后才停”。
       现在只留一个观察器：等第一趟滑停（520ms）后再守 1.1s，最多修两次，
       偏差不到 24px 一律不动，修正用 auto（几十像素的位移肉眼看不出来）。 */
    scheduleSettle(card);
    // 二维墙本身有几十块纵深，撑开不会把墙走到底；单列短墙才需要补块填洞
    // 展开改成块内重排（anchorExpandedTile）后，二维墙不再往墙尾补新块
    if (!foliaPlane() && !card.classList.contains('is-playing-tile')) {
      setTimeout(() => { const w = foliaWall(); if (w && homeActive()) extendWall(w); }, 520);
    }
  }, true);
  document.addEventListener('keydown', (e) => {
    const arrow = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key);
    if (arrow) {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (!homeActive() || !foliaWall()) return;
      const target = e.target;
      if (target.closest('input, select, textarea, [contenteditable="true"], .dock, .docksheet.on')) return;
      if (document.querySelector('dialog[open], .details.on, .drawer.on, .typesheet.on')) return;
      if ($('modal')?.open) return;
      e.preventDefault();
      e.stopPropagation();
      if (document.querySelectorAll('#homeRecommended .pod-card.is-peek').length) collapseTiles();
      moveWallCursor({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[e.key]);
      return;
    }
    if (e.key !== 'Escape') return;
    /* 有真正的弹层在前台时，Escape 先归弹层，别顺手把瓦片动作层也收掉。 */
    if (document.querySelector('dialog[open], .details.on, .drawer.on, .docksheet.on, .typesheet.on')) return;
    const open = document.querySelectorAll('#homeRecommended .pod-card.is-peek');
    if (!open.length) {
      if (wallCursorCard()) {
        e.preventDefault();
        clearWallCursor();
        const active = document.activeElement;
        if (active && active.closest && active.closest('.pod-card-main')) active.blur();
      }
      return;
    }
    e.preventDefault();
    collapseTiles();
    clearWallCursor();
  }, true);
}

/* 当前句压到正在播放的瓦片上：Folia 播放态瓦片显示上一句 / 当前句 / 下一句三行。
   句间停顿（`state.activeCue` 变 -1）不是"没字幕"，是"这句话还在屏幕上"：
   停在刚读完的那句上，直到下一句开口再换——壁纸早就这么做了（wpCueIndex），
   瓦片和全屏舞台跟着来，不然每句话之间字幕整块闪一下。 */
let tileCueHold = -1;
let tileCueTag = '';
function tileLyricLines() {
  const cues = state.cues || [];
  if (!cues.length) return [];
  const tag = [state.current && state.current.id, cues.length, cues[0] && cues[0].start].join('|');
  if (tag !== tileCueTag) { tileCueTag = tag; tileCueHold = -1; }
  let i = state.activeCue;
  if (i >= 0 && cues[i]) tileCueHold = i;
  else if (tileCueHold >= 0 && cues[tileCueHold]) i = tileCueHold;
  if (i < 0 || !cues[i]) return [];
  /* 往回拖进度：留住的那句如果还没轮到，就先别顶上来 */
  const now = (Number(audio.currentTime) || 0) + (Number(state.offset) || 0);
  if ((Number(cues[i].start) || 0) > now + 0.25) return [];
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
/* ---------- 封面字幕：不丢词 + 按封面亮度自动取色 ----------
   两件事一起治：
   1) 字幕行原来是「两行 clamp + flex 收缩」，三行抢高度时每行被压成一行，
      浏览器直接吐省略号，句尾半截消失。现在行不再裁，字号按可用高度逐档下调
      （fitLyricBox），三句都完整放下为止。
   2) 逐词高亮原来是固定的「30% 主题色 + 白字」，压在 SmartLess 那种米色海报上
      就是一块看不清的糊色。现在把封面缩成 32×32 亮度网格（缓存），
      字幕带按平均亮度选深/浅字色，高亮词按它自己身后的亮度选
      「深底白字」还是「主题色深字」。封面走 mytmedia 代理（带 CORS），
      canvas 不会被污染；拿不到像素时自动退回原来的配色。
   低亮度 → 白字；高亮度 → 近黑字。阈值 0.6/0.52 是拿深浅两类海报实测的折中。 */
const LYRIC_LUMA = new Map();
function lyricLumaMap(src) {
  if (!src) return null;
  const hit = LYRIC_LUMA.get(src);
  if (hit) return hit;
  const entry = { ready: false, failed: false, N: 32, grid: null, waiters: [] };
  LYRIC_LUMA.set(src, entry);
  const flush = () => entry.waiters.splice(0).forEach(fn => { try { fn(); } catch (e) {} });
  const im = new Image();
  im.crossOrigin = 'anonymous';
  im.onload = () => {
    try {
      const N = entry.N;
      const cv = document.createElement('canvas');
      cv.width = N; cv.height = N;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(im, 0, 0, N, N);
      const px = cx.getImageData(0, 0, N, N).data;
      const grid = new Float32Array(N * N);
      for (let i = 0, j = 0; i < px.length; i += 4, j++) {
        grid[j] = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
      }
      entry.grid = grid; entry.ready = true;
    } catch (e) { entry.failed = true; }
    flush();
  };
  im.onerror = () => { entry.failed = true; flush(); };
  im.src = src;
  return entry;
}
function lyricLumaAt(entry, nx, ny) {
  if (!entry || !entry.ready) return -1;
  const N = entry.N, g = entry.grid;
  const cx = Math.min(N - 1, Math.max(0, Math.floor(nx * N)));
  const cy = Math.min(N - 1, Math.max(0, Math.floor(ny * N)));
  let sum = 0, n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= N || y >= N) continue;
      sum += g[y * N + x]; n++;
    }
  }
  return n ? sum / n : -1;
}
/* 一条字幕常常横跨亮暗两块（SmartLess 的米色名字压着深色底），
   只看中心点会漏掉最亮的那一段。取字幕框内 3×3 个采样里的峰值，
   按「最亮处」决定要不要垫底板——宁可多垫一点，也不让半句话看不清。 */
function lyricBandPeak(entry, br, hr) {
  let peak = -1;
  for (let iy = 0; iy < 3; iy++) {
    for (let ix = 0; ix < 3; ix++) {
      const nx = (br.left + br.width * (0.12 + 0.38 * ix) - hr.left) / hr.width;
      const ny = (br.top + br.height * (0.12 + 0.38 * iy) - hr.top) / hr.height;
      peak = Math.max(peak, lyricLumaAt(entry, nx, ny));
    }
  }
  return peak;
}
/* 字幕只保留一种字色（白字 + 双层黑阴影）：封面是照片/插画，一条字幕往往
   一半压在亮色、一半压在暗色上，整行翻成深字必然有一截看不清。
   真正需要动态处理的是「底板」和「高亮块」——见下面两处。 */
function lyricHostOf(box) {
  return box ? (box.closest('.cover-stage') || box.closest('.pod-card')) : null;
}
function lyricCoverSrcOf(box) {
  const host = lyricHostOf(box);
  if (!host) return '';
  const img = host.querySelector('.cs-img, .pod-art img');
  return img ? (img.currentSrc || img.src || '') : '';
}
/* 主题色有时带 alpha（Folia 的 --accent 就是半透明的），
   直接拿来铺高亮底会在浅海报上二次混色。这里把它还原成实色再铺。 */
const LYRIC_SOLID = new Map();
function lyricSolid(host, varName) {
  const raw = getComputedStyle(host).getPropertyValue(varName).trim();
  if (!raw) return '';
  if (LYRIC_SOLID.has(raw)) return LYRIC_SOLID.get(raw);
  const probe = document.createElement('span');
  probe.style.color = raw;
  probe.style.position = 'absolute';
  probe.style.opacity = '0';
  probe.style.pointerEvents = 'none';
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color;
  probe.remove();
  const solid = /^rgb\(/.test(rgb) ? rgb : '';
  LYRIC_SOLID.set(raw, solid);
  return solid;
}
function refreshLyricPalette(box, wordEl) {
  if (!box) return;
  const host = lyricHostOf(box);
  if (!host) return;
  const entry = lyricLumaMap(lyricCoverSrcOf(box));
  if (!entry || entry.failed) return;
  if (!entry.ready) {
    if (!box.dataset.lumaWait) {
      box.dataset.lumaWait = '1';
      entry.waiters.push(() => {
        delete box.dataset.lumaWait;
        refreshLyricPalette(box, box.querySelector('.tl-cur .tl-word.on'));
      });
    }
    return;
  }
  const hr = host.getBoundingClientRect();
  const br = box.getBoundingClientRect();
  if (hr.width < 8 || hr.height < 8 || br.width < 8) return;
  /* 字幕不再需要"看底色换字色"：Folia 的展开海报是先给整块瓦片压一层
     底+左的两段黑幕（`.lattice-poster.is-expanded .lattice-poster-shade`），
     字永远用主题的近白色，靠字形自带的描边/辉光读。这里同理，字色交给 CSS。 */
  if (!wordEl) return;
  const wr = wordEl.getBoundingClientRect();
  if (wr.width < 1) return;
  const wordLuma = lyricLumaAt(entry, (wr.left + wr.width / 2 - hr.left) / hr.width,
    (wr.top + wr.height / 2 - hr.top) / hr.height);
  if (wordLuma < 0) return;
  /* 高亮块：底幕已经把字幕区压暗，固定用主题色实心块 + 近黑字，
     不再按局部亮度切深色块（深块压在黑幕上等于消失）。 */
  const key = 'hl-accent';
  if (box.dataset.hlKey === key) return;
  box.dataset.hlKey = key;
  box.style.setProperty('--tl-hl-bg', lyricSolid(host, '--accent') || 'var(--accent)');
  box.style.setProperty('--tl-hl-ink', '#0a0a0b');
  box.style.setProperty('--tl-hl-ring', 'transparent');
  box.style.setProperty('--tl-hl-glow', '0 0 18px color-mix(in srgb, var(--accent) 55%, transparent)');
}
/* 字号阶梯：从设计上限往下试，第一个能完整放下的档位留下。
   一屏最多 14 次重排，且只在换句时跑，不在每帧跑。 */
/* 字号只按「固定预算」算，不跟当前这句的长短走。Folia 的 resolveLatticeTypography
   就是这么定的（"Fits a fixed lyric budget, never the current sentence, so line changes
   cannot pump the font size"）。按句量高度的话，长句压到 18px、短句又弹回 26px，
   播放时整块字幕像在呼吸。 */
const LYRIC_FS_CACHE = new Map();
function lyricBudgetPx(avail, maxPx) {
  const cap = Number(maxPx) || 26;
  const key = Math.round(avail) + ':' + cap;
  const hit = LYRIC_FS_CACHE.get(key);
  if (hit) return hit;
  /* 预算 = 3 行 × 1.3 行高 + 两处 0.55em 行距 + 余量 ≈ 5.5em，按 6.2em 反推字号 */
  const px = Math.max(13, Math.min(cap, Math.floor(avail / 6.2)));
  LYRIC_FS_CACHE.set(key, px);
  return px;
}
function fitLyricBox(box, maxPx) {
  if (!box) return;
  const host = lyricHostOf(box);
  if (!host) return;
  const h = host.getBoundingClientRect().height;
  if (!h) return;
  const avail = host.classList.contains('cover-stage') ? h * 0.44 : h * 0.62;
  box.style.setProperty('--tl-fs', lyricBudgetPx(avail, maxPx) + 'px');
  /* 固定字号之后，超长的一句会顶出预算。Folia 的处理是把整块上移、让正在读的那一行
     留在框里（resolveLatticeLongLineOffset），既不缩字号也不吃字。 */
  const cur = box.querySelector('.tl-cur');
  const overflow = box.scrollHeight - avail;
  const shift = overflow > 3 && cur
    ? Math.max(0, Math.min(overflow, cur.getBoundingClientRect().bottom - box.getBoundingClientRect().top - avail))
    : 0;
  box.style.setProperty('--tl-shift', Math.round(shift) + 'px');
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
  /* 高亮块的颜色跟着「这个词身后的封面亮度」走，换词就换配色键，但同一键不重复写样式 */
  refreshLyricPalette(el.closest('.tile-live-lyric, .cs-lyric'), idx >= 0 ? words[idx] : null);
}
function tileWordPaint() {
  document.querySelectorAll('#homeRecommended .pod-card.is-playing-tile .tile-live-lyric .tl-cur')
    .forEach(el => paintCueWordEl(el));
}
let tileLyricRaf = 0;
function startTileLyricLoop() {
  const el = document.querySelector('audio');
  if (!el || el.paused || tileLyricRaf) return;
  if (!homeActive() || !foliaWall()) return;
  const step = () => {
    if (!el || el.paused || !homeActive() || !foliaWall()) { tileLyricRaf = 0; return; }
    /* 墙面正在滚（bindFoliaCamera 挂的 wall-scrolling）就只续帧、不上色：
       这块播放瓦片 589×589、歌词还带四向 text-shadow，滚动时每帧改一次 class
       等于每帧把整块重绘一遍，WebView2 上就是"带字幕的瓦片在闪"。停稳 180ms 后补画一次。 */
    if (!document.documentElement.classList.contains('wall-scrolling')) tileWordPaint();
    tileLyricRaf = requestAnimationFrame(step);
  };
  tileLyricRaf = requestAnimationFrame(step);
  document.documentElement.classList.remove('wall-scrolling');
}
function stopTileLyricLoop() {
  if (tileLyricRaf) cancelAnimationFrame(tileLyricRaf);
  tileLyricRaf = 0;
}
function updateTileLyric() {
  document.querySelectorAll('#homeRecommended .pod-card.is-playing-tile').forEach(syncTileLyric);
  tileWordPaint();
}
/* 有分集封面就优先用分集封面；没有才沿用节目封面。 */
function paintTileArt(card, on) {
  const art = card && card.querySelector('.pod-art');
  if (!art) return;
  if (!card.dataset.baseArtHtml) card.dataset.baseArtHtml = art.innerHTML;
  const ep = on ? state.current : null;
  const epRaw = ep && ep.img ? (smallArtwork(ep.img) || ep.img) : '';
  if (epRaw) {
    let img = art.querySelector('img[data-ep-art]');
    if (!img) {
      img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.dataset.epArt = '1';
      img.onerror = () => {
        if (img.dataset.raw && img.getAttribute('src') !== img.dataset.raw) { img.setAttribute('src', img.dataset.raw); return; }
        img.remove();
      };
      art.insertBefore(img, art.firstChild);
    }
    img.dataset.raw = epRaw;
    const src = coverSrc(ep.img, 640);
    if (img.getAttribute('src') !== src) img.setAttribute('src', src);
    art.classList.add('has-ep-art');
  } else if (card.dataset.baseArtHtml) {
    art.innerHTML = card.dataset.baseArtHtml;
    art.classList.remove('has-ep-art');
  }
}
/* 有句子才留字幕位：没有字幕的集子不该在播放瓦片底部空出 112px（Folia 遇到无歌词
   就是一张干净的封面 + 标题，不会留一条空band）。`has-tile-lyric` 同时驱动 CSS 留白。 */
function syncTileLyric(card) {
  const html = tileLyricHTML();
  let el = card.querySelector('.tile-live-lyric');
  if (!html) {
    if (el) { el.remove(); el = null; }
    card.classList.remove('has-tile-lyric');
    return null;
  }
  if (!el) {
    el = document.createElement('span');
    el.className = 'tile-live-lyric';
    card.appendChild(el);
  }
  card.classList.add('has-tile-lyric');
  if (el.dataset.signature !== html) {
    el.innerHTML = html;
    el.dataset.signature = html;
    fitLyricBox(el, 26);
    refreshLyricPalette(el, null);
  }
  return el;
}
function ensureTileLyric(card) {
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
  const el = syncTileLyric(card);
  tileWordPaint();
  return el;
}

/* ---- 模板块（对照 Folia 的 blockTemplates）----
   一块 = 12 栏 × 8 行 = 96 格，正好 12 席铺满，不留空格。块高恒定是后面两件事的前提：
   ① 展开时只在这一块里重切，块底不动，下面的瓦片一格都不挪；
   ② 纵向搬块时位移是整数块高，补偿量精确，不会整屏抖。
   以前是 14 块一套，变体 2 只有 140 格（有 4 格空缺），整块搬行总高就变，补偿对不上——
   这正是之前纵向无限试一版又撤掉的原因。 */
const BLOCK_COLS = 12;
const BLOCK_ROWS = 8;
const BLOCK_SLOTS = 12;
/* 四套 12 席图样，每套都精确 96 格。尺寸组合故意做得不一样（6×4 / 4×4 / 6×2 / 3×4 / 2×2 混排），
   块与块按坐标哈希换图样、再按哈希做左右镜像，往下滚就不会看到同一幅墙在原地复制。 */
const BLOCK_TEMPLATES = [
  [[0, 0, 6, 4], [6, 0, 3, 2], [9, 0, 3, 2], [6, 2, 3, 2], [9, 2, 3, 2], [0, 4, 3, 2], [3, 4, 3, 2], [6, 4, 3, 4], [9, 4, 3, 2], [9, 6, 3, 2], [0, 6, 4, 2], [4, 6, 2, 2]],
  [[0, 0, 3, 2], [3, 0, 3, 2], [6, 0, 6, 4], [0, 2, 3, 2], [3, 2, 3, 2], [0, 4, 3, 2], [3, 4, 3, 2], [0, 6, 2, 2], [2, 6, 2, 2], [4, 6, 2, 2], [6, 4, 6, 2], [6, 6, 6, 2]],
  [[0, 0, 6, 2], [6, 0, 3, 4], [9, 0, 3, 4], [0, 2, 3, 2], [3, 2, 3, 2], [0, 4, 6, 4], [6, 4, 2, 2], [8, 4, 2, 2], [10, 4, 2, 2], [6, 6, 2, 2], [8, 6, 2, 2], [10, 6, 2, 2]],
  [[0, 0, 4, 4], [4, 0, 4, 4], [8, 0, 2, 2], [10, 0, 2, 2], [8, 2, 2, 2], [10, 2, 2, 2], [0, 4, 6, 2], [6, 4, 6, 2], [0, 6, 3, 2], [3, 6, 3, 2], [6, 6, 3, 2], [9, 6, 3, 2]]
];
function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
/* 块用哪一套图样：坐标哈希（Folia 里是 hash 选朝向），相邻块基本不会同款。 */
function blockTemplateOf(col, block) {
  const seed = ((Number(col.dataset.wallVariant || 0) * 2654435761) + block * 40503) >>> 0;
  let h = (seed ^ (seed >>> 15)) * 2246822519; h >>>= 0;
  h = (h ^ (h >>> 13)) * 3266489917; h >>>= 0;
  const tpl = BLOCK_TEMPLATES[h % BLOCK_TEMPLATES.length];
  const mirror = (h & 16) !== 0;
  return tpl.map(([x, y, w, hh]) => ({ x: mirror ? BLOCK_COLS - x - w : x, y, w, h: hh }));
}
/* 把一块矩形切成 k 份，份数/面积都要满足（每份至少 2×2）；回溯挑最匀的切法，切不出来就回退。 */
function partitionRect(x, y, w, h, k, out) {
  if (k === 1) { out.push({ x, y, w, h }); return true; }
  if (w < 2 || h < 2 || w * h < 4 * k) return false;
  const cuts = [];
  for (let cut = 2; cut <= w - 2; cut++) {
    const a1 = cut * h, a2 = (w - cut) * h;
    for (let k1 = 1; k1 < k; k1++) {
      if (a1 >= 4 * k1 && a2 >= 4 * (k - k1)) cuts.push({ axis: 0, cut, k1, skew: Math.abs(a1 / k1 - a2 / (k - k1)) });
    }
  }
  for (let cut = 2; cut <= h - 2; cut++) {
    const a1 = w * cut, a2 = w * (h - cut);
    for (let k1 = 1; k1 < k; k1++) {
      if (a1 >= 4 * k1 && a2 >= 4 * (k - k1)) cuts.push({ axis: 1, cut, k1, skew: Math.abs(a1 / k1 - a2 / (k - k1)) });
    }
  }
  cuts.sort((a, b) => a.skew - b.skew);
  for (const c of cuts) {
    const mark = out.length;
    const ok = c.axis === 0
      ? partitionRect(x, y, c.cut, h, c.k1, out) && partitionRect(x + c.cut, y, w - c.cut, h, k - c.k1, out)
      : partitionRect(x, y, w, c.cut, c.k1, out) && partitionRect(x, y + c.cut, w, h - c.cut, k - c.k1, out);
    if (ok) return true;
    out.length = mark;
  }
  return false;
}
/* 展开态：6×6 钉在原槽位（夹进能放下的范围），剩下 60 格按面积比例分给另外 11 席，
   每份重新切成长方形。整块还是 96 格，所以块高不变、后面的块一格都不动。 */
function reflowBlockRects(ax, ay) {
  const free = [];
  if (ay > 0) free.push({ x: 0, y: 0, w: BLOCK_COLS, h: ay });
  if (ay + 6 < BLOCK_ROWS) free.push({ x: 0, y: ay + 6, w: BLOCK_COLS, h: BLOCK_ROWS - ay - 6 });
  if (ax > 0) free.push({ x: 0, y: ay, w: ax, h: 6 });
  if (ax + 6 < BLOCK_COLS) free.push({ x: ax + 6, y: ay, w: BLOCK_COLS - ax - 6, h: 6 });
  const K = BLOCK_SLOTS - 1;
  const counts = free.map(() => 1);
  let assigned = free.length;
  while (assigned < K) {
    let pick = -1, best = -1;
    free.forEach((r, i) => {
      if (counts[i] >= Math.floor((r.w * r.h) / 4)) return;
      const per = (r.w * r.h) / counts[i];
      if (per > best) { best = per; pick = i; }
    });
    if (pick < 0) break;
    counts[pick] += 1;
    assigned += 1;
  }
  const out = [];
  const ok = free.every((r, i) => partitionRect(r.x, r.y, r.w, r.h, counts[i], out));
  if (!ok || out.length !== K) return null;
  return [{ x: ax, y: ay, w: 6, h: 6 }].concat(out);
}
function placeCardSlot(card, x, y, w, h, rowOffset) {
  card.dataset.span = w + '/' + h;
  card.dataset.tile = (w >= 4 || w * h >= 12) ? 'big' : 'small';
  card.style.gridColumn = (x + 1) + ' / span ' + w;
  card.style.gridRow = (rowOffset + y + 1) + ' / span ' + h;
}
/* 一列按块重排：没有展开的块照图样铺；有展开的块把 6×6 钉回原槽位、其余 11 席在块内重新切。
   坐标全部显式写死，CSS 的 dense 不再参与决策——这才是 Folia 的“块 footprint 不变”。 */
function applyBlockLayout(col) {
  if (!col || !foliaPlane()) return;   // 窄屏退回单列瀑布时由 CSS 的普通跨度接管
  const cards = [...col.querySelectorAll('.pod-card')];
  if (!cards.length) return;
  for (let b = 0; b * BLOCK_SLOTS < cards.length; b++) {
    const from = b * BLOCK_SLOTS;
    const block = cards.slice(from, from + BLOCK_SLOTS);
    const tpl = blockTemplateOf(col, b);
    const off = b * BLOCK_ROWS;
    tpl.forEach((s, i) => {
      const card = block[i];
      if (!card) return;
      card.dataset.baseX = String(s.x);
      card.dataset.baseY = String(s.y);
    });
    const ex = block.find(c => c.classList.contains('is-peek') || c.classList.contains('is-playing-tile'));
    if (!ex || block.length < BLOCK_SLOTS) {
      block.forEach((card, i) => {
        const s = tpl[i % tpl.length];
        placeCardSlot(card, s.x, s.y, s.w, s.h, off);
      });
      continue;
    }
    const bx = Number(ex.dataset.baseX || 0), by = Number(ex.dataset.baseY || 0);
    /* 6×6 只能落在 0/2 行上：落在中间会剩两条 1 行高的横带，2×2 的邻居塞不进去。
       左右同理，避开 1 栏宽的竖带（那一条没法切出 2×2）。 */
    const ax = Math.max(0, Math.min(BLOCK_COLS - 6, bx === 1 ? 2 : (bx === 5 ? 4 : bx)));
    const ay = by <= 1 ? 0 : 2;
    const rects = reflowBlockRects(ax, ay) || [{ x: ax, y: ay, w: 6, h: 6 }].concat(
      tpl.filter((s, i) => block[i] !== ex).map(s => ({ x: s.x, y: s.y, w: s.w, h: s.h })));
    /* 11 个空位按“离自己原槽位中心最近”分配，重排后邻居关系尽量不变，FLIP 才不像洗牌 */
    const pool = rects.slice(1).map(r => ({ r, cx: r.x + r.w / 2, cy: r.y + r.h / 2 }));
    block.filter(card => card !== ex).forEach(card => {
      const ox = Number(card.dataset.baseX || 0) + 0.5, oy = Number(card.dataset.baseY || 0) + 0.5;
      let pick = 0, best = Infinity;
      pool.forEach((p, i) => {
        const d = (p.cx - ox) * (p.cx - ox) + (p.cy - oy) * (p.cy - oy);
        if (d < best) { best = d; pick = i; }
      });
      const item = pool.splice(pick, 1)[0];
      placeCardSlot(card, item.r.x, item.r.y, item.r.w, item.r.h, off);
    });
    placeCardSlot(ex, ax, ay, 6, 6, off);
    ex.dataset.expX = String(ax);
    ex.dataset.expY = String(ay);
  }
  if (foliaPlane()) layoutFoliaPlane();
}
/* 单列墙没有块图样，按 data-span 还回去；二维墙整块重排（展开时邻居尺寸被改过）。 */
function clearTileSpan(card) {
  card.style.removeProperty('grid-column');
  card.style.removeProperty('grid-row');
}
function restoreTileSpan(card) {
  const col = card && card.closest('#homeRecommended');
  if (col && foliaPlane()) { applyBlockLayout(col); return; }
  const span = (card.dataset.span || '').split('/');
  if (span.length === 2 && span[0]) {
    card.style.gridColumn = 'span ' + span[0];
    card.style.gridRow = 'span ' + span[1];
  }
}
/* 一块瓦片对应哪档节目；补块和“别撞同一档”都靠它认人。 */
function extendWallOne(wall, exclude) {
  const cards = [...wall.querySelectorAll('.pod-card')];
  const plane = wall.closest('.folia-wall-plane');
  const cap = plane ? FOLIA_COL_CAP : TILE_MAX;
  if (cards.length >= cap) return;
  // 只补到“下一整套”的边界：首屏不足 14 块时先把当前这套补满，之后每次 +14
  const need = Math.min(TILE_SET_SIZE - (cards.length % TILE_SET_SIZE), cap - cards.length);
  if (need <= 0) return;
  const pool = [];
  {
    const srcs = cards.filter(c => !c.dataset.wallClone);
    /* 侧列整列都是复制出来的（没有“原型”卡），不能因此停止生长，否则三列深浅不一，
       左右平移时某一列先到底。 */
    const all = srcs.length ? srcs : cards;
    if (!all.length) return;
    const fresh = exclude && exclude.size ? all.filter(c => !exclude.has(tileSlugOf(c))) : all;
    const pick = fresh.length >= need ? fresh : all;
    while (pool.length < need) pool.push(...shuffle(pick.slice()));
  }
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
  /* 一次补一整段可能越过上限（之前实测长到 89/列，84 的硬上限没拦住），补完再削一次。 */
  const grown = [...wall.querySelectorAll('.pod-card')];
  if (grown.length > cap) grown.slice(cap).forEach(c => c.remove());
  applyBlockLayout(wall);
}
/* 二维墙里三列必须一起长，否则左右平移时会看到某一列提前到底。 */
function extendWall(wall) {
  const cols = wall && wall.closest('.folia-wall-plane') ? wallColumns() : [wall];
  /* 三列一起长时共用同一份“刚出现过”的名单：新补的瓦片落在现有内容下面，
     紧挨着的左右两格要是同一档节目，一滚就露出来。 */
  const exclude = new Set();
  cols.forEach(col => {
    [...col.querySelectorAll('.pod-card')].slice(-TILE_SET_SIZE * 2)
      .forEach(card => { const slug = tileSlugOf(card); if (slug) exclude.add(slug); });
  });
  cols.forEach(col => extendWallOne(col, exclude));
  layoutFoliaPlane();
  syncPlayingTiles();
}
function ensureWallDepth() {
  const wall = foliaWall();
  if (!wall) return;
  if (!wall.querySelectorAll('.pod-card').length) return;
  if (!wall.dataset.wallVariant) wall.dataset.wallVariant = String(Math.floor(Math.random() * BLOCK_TEMPLATES.length));
  applyBlockLayout(wall);
  // 二维墙铺满四整块（纵向搬块上下各留一块缓冲）；单列墙两套够用
  const target = foliaPlane() ? TILE_SET_SIZE * 4 : TILE_SET_SIZE * 2;
  let guard = 0;
  while (wall.querySelectorAll('.pod-card').length < target && guard++ < 8) extendWall(wall);
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
/* ---- Folia 二维画布：三列 12 栏块并排 ----
   Folia 的墙是横向无限重复的块；这里用三列同宽块做环：镜头走到最右列时，
   把最左列整列搬到右边，再把三列和 scrollLeft 一起左移一格，画面像素不变，
   但右边又长出一整块。列里的瓦片都是真实节点，不做镜像，播放态和歌词跟着节点走。 */
const foliaPlane = () => document.querySelector('.folia-wall-plane');
function wallColumns() {
  const plane = foliaPlane();
  return plane ? [...plane.querySelectorAll(':scope > #homeRecommended')] : [];
}
function wallColumnOf(card) {
  return card && card.closest ? card.closest('#homeRecommended') : null;
}

function layoutFoliaPlane() {
  const plane = foliaPlane();
  if (!plane) return;
  const cols = wallColumns();
  if (!cols.length) return;
  const W = Math.round(plane.parentElement ? plane.parentElement.clientWidth : 0) || Number(plane.dataset.blockW);
  if (!W) return;
  plane.dataset.blockW = String(W);
  plane.style.setProperty('--folia-block-w', W + 'px');
  let height = 0;
  cols.forEach((col, index) => {
    if (col.dataset.foliaX == null) col.dataset.foliaX = String(index * W);
    col.style.width = W + 'px';
    col.style.left = Number(col.dataset.foliaX) + 'px';
    height = Math.max(height, col.offsetHeight);
  });
  plane.style.width = (cols.length * W) + 'px';
  plane.style.height = height + 'px';
}
/* 一块的宽度就是“一屏宽”，列位置是块的整数倍。窗口改尺寸后不同步这块宽度的话，
   列还停在旧尺寸上，镜头算出来的目标全对不准——表现就是“点哪块都可能滑到别处去”。 */
function resizeFoliaPlane() {
  if (foliaNarrow()) { teardownFoliaPlane(); return; }
  const plane = foliaPlane();
  const sc = wallScroller(foliaWall());
  if (!plane || !sc) return;
  const oldW = Number(plane.dataset.blockW);
  const newW = Math.round(sc.clientWidth || (plane.parentElement && plane.parentElement.clientWidth) || 0);
  if (!newW || Math.abs(newW - oldW) < 2) return;
  const cols = wallColumns().slice().sort((a, b) => Number(a.dataset.foliaX) - Number(b.dataset.foliaX));
  const prevBehavior = sc.style.scrollBehavior;
  const prevLeft = sc.scrollLeft;
  sc.style.scrollBehavior = 'auto';
  plane.dataset.blockW = String(newW);
  plane.style.setProperty('--folia-block-w', newW + 'px');
  cols.forEach((col, i) => {
    col.dataset.foliaX = String(i * newW);
    col.style.width = newW + 'px';
    col.style.left = (i * newW) + 'px';
  });
  layoutFoliaPlane();
  const maxLeft = Math.max(0, sc.scrollWidth - sc.clientWidth);
  sc.scrollLeft = Math.min(maxLeft, Math.max(0, Math.round(prevLeft * (oldW ? newW / oldW : 1))));
  /* 宽度换了，块宽也换了，但纵向没跟着动：把窗口改矮时展开的卡会留在原来的纵向位置，
     直接从画面上方飞出去（实测 h 880→680 后卡顶在 -455）。所以重排完按新视口再对准一次。 */
  const focus = sc.querySelector('.pod-card.is-peek, .pod-card.is-playing-tile');
  if (focus) {
    const r = focus.getBoundingClientRect();
    const sr = sc.getBoundingClientRect();
    const top = sc.scrollTop + (r.top - sr.top) - Math.max(0, (sc.clientHeight - r.height) / 2);
    const left = sc.scrollLeft + (r.left - sr.left) - Math.max(0, (sc.clientWidth - r.width) / 2);
    foliaRecycleLock = Date.now() + 900;
    sc.scrollTo({ top, left: Math.min(maxLeft, Math.max(0, left)), behavior: 'auto' });
  }
  sc.style.scrollBehavior = prevBehavior;
  syncPlayingTiles();
}
function rebuildFoliaSides() {
  const plane = foliaPlane();
  const host = document.getElementById('homeRecommended');
  if (!plane || !host) return;
  const W = Number(plane.dataset.blockW) || Math.round(plane.parentElement.clientWidth);
  if (!W) return;
  wallColumns().forEach(col => { if (col !== host) col.remove(); });
  host.dataset.foliaCol = '0';
  host.dataset.foliaX = '0';
  /* 三列的节目顺序统一由 arrangeWallCycle 排（侧列先按同一份内容克隆出来）：
     每列各自打乱同一套的话，相邻两格随时会撞同一档节目。 */
  for (let i = 1; i < FOLIA_COLUMNS; i++) {
    const col = host.cloneNode(true);
    col.dataset.foliaCol = String(i);
    col.dataset.foliaX = String(i * W);
    col.style.width = W + 'px';
    col.style.left = (i * W) + 'px';
    col.removeAttribute('data-myt-tile-sync');
    plane.appendChild(col);
  }
  plane.dataset.render = host.dataset.foliaRender || '';
  arrangeWallCycle(host);
  syncPlayingTiles();
}
/* 三列的节目顺序排成同一条循环序列，按列错开一个步长：订阅节目少的时候
   每列本来就只能循环播放那十几档，各自打乱必然并排撞同一档；统一排成
   S[i + k*stride] 之后，同一横排三列永远是三个不同的节目（stride = N/列数）。 */
function arrangeWallCycle(host) {
  if (!foliaWall()) return;
  const cols = wallColumns();
  if (!cols.length) return;
  const all = [...host.querySelectorAll('.pod-card')];
  if (!all.length) return;
  const slugs = [...new Set(all.map(tileSlugOf).filter(Boolean))];
  if (slugs.length < 2) return;
  const S = shuffle(slugs.slice());
  const N = S.length;
  const stride = Math.max(1, Math.floor(N / cols.length));
  /* 直接把一列铺到四整块（48）：以前只按当前 15 块铺，剩下的靠 extendWallOne 随机克隆，
     克隆不看“最近出现过谁”，块里就会冒出两张同款封面。铺满之后再补块也不会走到 48 以上。 */
  const depth = Math.max(all.length, TILE_SET_SIZE * 4);
  // 每档节目留一张“原型”卡，所有列都从它克隆，保证内容一致、顺序可控
  const proto = new Map();
  all.forEach(card => { const slug = tileSlugOf(card); if (slug && !proto.has(slug)) proto.set(slug, card); });
  /* 一列 42 块、只有 14 档节目，等于同一份顺序每 14 块原样重来一次：上下隔一屏就会
     撞回同一批封面。Folia 的格子靠「模板 + 朝向」按坐标哈希来打散，这里等价地给每个
     周期（每 N 块）换一份顺序，而同一周期内三列仍按 stride 错开。 */
  const permOf = (cycle) => {
    if (!cycle) return S;
    const arr = S.slice();
    let seed = (0x9e3779b1 ^ (cycle * 0x85ebca6b)) >>> 0;
    const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr;
  };
  const perms = new Map();
  cols.forEach((col, k) => {
    const offset = k * stride;
    [...col.querySelectorAll('.pod-card')].forEach(card => card.remove());
    let localPerm = null, localCycle = -1;
    /* 一列只有 14 档节目、48 块，块里 12 席要是撞上最近出现过的同一档，
       并排就会看到两张一样的封面。留一个 11 块的滑动窗口，撞了就往后换一席。 */
    const recent = [];
    for (let i = 0; i < depth; i++) {
      const cycle = Math.floor(i / N);
      if (cycle !== localCycle) {
        localCycle = cycle;
        let perm = perms.get(cycle);
        if (!perm) { perm = permOf(cycle); perms.set(cycle, perm); }
        localPerm = perm.slice();   // 每列单独调序，别把别的列的顺序也改了
      }
      let at = (i % N + offset) % N;
      if (recent.indexOf(localPerm[at]) >= 0) {
        /* 这一席撞上最近 11 块里的同一档：在本周期里挑一档没出现过的换上。
           14 档节目、窗口 11，永远挑得到，不会换回原样 */
        for (let j = 0; j < N; j++) {
          if (recent.indexOf(localPerm[j]) < 0) {
            [localPerm[at], localPerm[j]] = [localPerm[j], localPerm[at]];
            break;
          }
        }
      }
      const slug = localPerm[at];
      recent.push(slug);
      if (recent.length > 11) recent.shift();
      const src = proto.get(slug);
      if (!src) continue;
      const node = src.cloneNode(true);
      node.removeAttribute('id');
      node.classList.remove('is-cursor', 'is-peek', 'is-playing-tile', 'is-playing-tile-live');
      node.querySelectorAll('.tile-peek, .tile-live-lyric').forEach(n => n.remove());
      if (k > 0) node.dataset.wallClone = '1';   // 侧列仍算补块来的，补块时不会把它当原型
      col.appendChild(node);
    }
    applyBlockLayout(col);
  });
  syncPlayingTiles();
}
function setupFoliaPlane() {
  if (!foliaWall()) return;
  /* 窄屏不做二维墙：一块 = 一屏宽，三列加起来三屏，切到手机尺寸就只剩半张海报，
     左右邻居还会从边上插进来。窄屏退回普通瀑布（主题的移动端规则接管列数）。 */
  if (foliaNarrow()) { teardownFoliaPlane(); return; }
  const host = document.getElementById('homeRecommended');
  if (!host || !host.querySelectorAll('.pod-card').length) return;
  let plane = foliaPlane();
  if (!plane) {
    plane = document.createElement('div');
    plane.className = 'folia-wall-plane';
    host.parentNode.insertBefore(plane, host);
    plane.appendChild(host);
  }
  const W = Math.round(plane.parentElement ? plane.parentElement.clientWidth : host.getBoundingClientRect().width);
  if (!W) return;
  plane.dataset.blockW = String(W);
  plane.style.setProperty('--folia-block-w', W + 'px');
  rebuildFoliaSides();
  applyBlockLayout(host);
  layoutFoliaPlane();
  const sc = wallScroller(host);
  if (sc) {
    // 首屏落在中间那一列，左右都有整整一块可以走
    sc.style.scrollBehavior = 'auto';
    sc.scrollLeft = W;
    sc.style.scrollBehavior = '';
    sc.dataset.foliaCamera = '1';
    bindFoliaCamera(sc);
    bindWallDragPan(sc);
  }
  if (!setupFoliaPlane.boundResize) {
    setupFoliaPlane.boundResize = true;
    let timer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(timer);
      // 变窄时 plane 会被拆掉；再拉宽回来要重新搭，否则墙停在拆掉后的普通网格里
      timer = setTimeout(() => { if (foliaPlane()) resizeFoliaPlane(); else setupFoliaPlane(); }, 140);
    });
  }
}
function syncFoliaPlane() {
  if (!foliaWall()) return;
  if (foliaNarrow()) { teardownFoliaPlane(); return; }
  const plane = foliaPlane();
  if (!plane) { setupFoliaPlane(); return; }
  const cols = wallColumns();
  if (cols.length !== FOLIA_COLUMNS) { setupFoliaPlane(); return; }
  const host = document.getElementById('homeRecommended');
  if (!host) return;
  const n = host.querySelectorAll('.pod-card').length;
  if (!n) return;
  const counts = cols.map(col => col.querySelectorAll('.pod-card').length);
  // 块内布局要求块是完整的：目标深度取整到 12 的倍数
  const target = Math.max(TILE_SET_SIZE * 4,
    Math.ceil(Math.max(n, ...counts, Number(app.homeWallCount) || 0) / TILE_SET_SIZE) * TILE_SET_SIZE);
  // 页面重画会把主列换回 15 块；按上次离开首页时的纵深把缺的列补回来，别让滚动位置被截断
  if (Math.min(...counts) < target) {
    let guard = 0;
    while (Math.min(...cols.map(col => col.querySelectorAll('.pod-card').length)) < target && guard++ < 8) {
      cols.forEach(col => {
        if (col.querySelectorAll('.pod-card').length < target) extendWallOne(col);
      });
    }
  }
  layoutFoliaPlane();
}
/* 镜头走到最右 / 最左列时，把最远那一列搬到另一头，再整世界平移一格。
   三列内容不同，但同宽同高；平移后选中卡在屏幕上的位置不变。 */
function rotateWallWorld(dir) {
  const plane = foliaPlane();
  const sc = wallScroller(foliaWall());
  if (!plane || !sc) return false;
  const W = Number(plane.dataset.blockW);
  const cols = wallColumns();
  if (!W || cols.length !== FOLIA_COLUMNS) return false;
  const sorted = cols.slice().sort((a, b) => Number(a.dataset.foliaX) - Number(b.dataset.foliaX));
  const prevBehavior = sc.style.scrollBehavior;
  sc.style.scrollBehavior = 'auto';
  if (dir === 'right') {
    sorted.forEach(col => { col.dataset.foliaX = String(Number(col.dataset.foliaX) - W); });
    sorted[0].dataset.foliaX = String((FOLIA_COLUMNS - 1) * W);
    sc.scrollLeft -= W;
  } else if (dir === 'left') {
    sorted.forEach(col => { col.dataset.foliaX = String(Number(col.dataset.foliaX) + W); });
    sorted[FOLIA_COLUMNS - 1].dataset.foliaX = '0';
    sc.scrollLeft += W;
  } else {
    sc.style.scrollBehavior = prevBehavior;
    return false;
  }
  sorted.forEach(col => { col.style.left = Number(col.dataset.foliaX) + 'px'; });
  sc.style.scrollBehavior = prevBehavior;
  return true;
}
/* 纵向无限：块高恒定（12 栏 × 8 行），所以整块上下搬的位移是精确的一块高。
   往下滚快到底时把第一块搬到末尾、scrollTop 减一块高；往上滚快到顶时反过来。
   因为块的 footprint 一样，搬完重排的行号只差整数块，补偿量对得上，画面一像素不抖。 */
function blockHeightOf(col) {
  if (!col) return 0;
  const cs = getComputedStyle(col);
  const row = parseFloat(cs.gridAutoRows);
  const gap = parseFloat(cs.rowGap) || 0;
  if (!row || !Number.isFinite(row)) return 0;
  return Math.round((row + gap) * BLOCK_ROWS);
}
function rotateWallRows(dir) {
  const sc = wallScroller(foliaWall());
  if (!sc || !homeActive()) return false;
  const cols = wallColumns();
  if (!cols.length) return false;
  /* 正在手动撑开时不动：那一块里有 6×6，整块搬走会把镜头里的卡换掉 */
  if (sc.querySelector('#homeRecommended .pod-card.is-peek')) return false;
  const bh = blockHeightOf(cols[0]);
  if (!bh) return false;
  const cards = [...cols[0].querySelectorAll('.pod-card')];
  if (cards.length <= TILE_SET_SIZE * 2) return false;
  const prevBehavior = sc.style.scrollBehavior;
  sc.style.scrollBehavior = 'auto';
  if (dir === 'down') {
    cols.forEach(col => {
      [...col.querySelectorAll('.pod-card')].slice(0, TILE_SET_SIZE)
        .forEach(card => col.appendChild(card));
    });
  } else if (dir === 'up') {
    cols.forEach(col => {
      const anchor = col.firstElementChild;
      [...col.querySelectorAll('.pod-card')].slice(-TILE_SET_SIZE)
        .forEach(card => col.insertBefore(card, anchor));
    });
  } else {
    sc.style.scrollBehavior = prevBehavior;
    return false;
  }
  cols.forEach(col => applyBlockLayout(col));
  // 内容整体挪了一块高：滚动量反向补回去，画面留在原地
  sc.scrollTop = Math.max(0, sc.scrollTop + (dir === 'down' ? -bh : bh));
  sc.style.scrollBehavior = prevBehavior;
  foliaRecycleLock = Date.now() + 300;
  return true;
}
function teardownFoliaPlane() {
  const plane = foliaPlane();
  if (!plane) return;
  const host = document.getElementById('homeRecommended');
  wallColumns().forEach(col => { if (col !== host) col.remove(); });
  if (host && plane.parentNode) plane.parentNode.insertBefore(host, plane);
  if (host) {
    host.removeAttribute('data-folia-col');
    host.removeAttribute('data-folia-x');
    host.style.left = '';
    host.style.width = '';
    // 块图样的显式坐标只在二维墙里成立，拆掉 plane 就还给 CSS 的普通跨度
    host.querySelectorAll('.pod-card').forEach(clearTileSpan);
  }
  plane.remove();
  const sc = document.querySelector('.main');
  if (sc) {
    sc.style.scrollBehavior = 'auto';
    sc.scrollLeft = 0;
    sc.style.scrollBehavior = '';
    delete sc.dataset.foliaCamera;
  }
}

function syncWallTheme() {
  if (!document.body) return;
  if (foliaWall()) {
    setupFoliaPlane();
    ensureWallDepth();
    syncPlayingTiles();
    if (!audio.paused) startTileLyricLoop();
  } else {
    teardownFoliaPlane();
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
/* 撑开后过几拍才画干净：只有真的偏了才再推一次，避免“看着已经对正还抖一下”。 */
function settleCenter(card) {
  if (!card || !card.isConnected || !card.classList.contains('is-peek')) return;
  const sc = wallScroller(card.closest('#homeRecommended'));
  if (!sc) return;
  nudgeCenter(card, sc);
}
/* 只做“补正”：按当前偏差改 scrollLeft/Top，不重排世界、不做 smooth。
   偏差在 tol 以内直接返回 false（撑开时的尺寸抖动不该再触发一次镜头移动）。 */
function nudgeCenter(card, sc, tol = 24) {
  if (!sc) sc = wallScroller(card.closest('#homeRecommended'));
  if (!sc) return false;
  const r = card.getBoundingClientRect(), sr = sc.getBoundingClientRect();
  const dx = (r.left + r.width / 2) - (sr.left + sc.clientWidth / 2);
  const dy = (r.top + r.height / 2) - (sr.top + sc.clientHeight / 2);
  if (Math.abs(dx) <= tol && Math.abs(dy) <= tol) return false;
  const maxLeft = Math.max(0, sc.scrollWidth - sc.clientWidth);
  const maxTop = Math.max(0, sc.scrollHeight - sc.clientHeight);
  foliaRecycleLock = Date.now() + 900;
  sc.scrollTo({
    left: Math.min(maxLeft, Math.max(0, sc.scrollLeft + dx)),
    top: Math.min(maxTop, Math.max(0, sc.scrollTop + dy)),
    behavior: 'auto'
  });
  return true;
}
function scheduleSettle(card) {
  if (!card) return;
  const t0 = performance.now();
  let corrections = 0;
  const tick = () => {
    if (!card.isConnected || !card.classList.contains('is-peek')) return;
    if (performance.now() - t0 > 1400 || corrections >= 2) return;
    const sc = wallScroller(card.closest('#homeRecommended'));
    if (sc && nudgeCenter(card, sc)) corrections += 1;
    setTimeout(tick, 140);
  };
  setTimeout(tick, 520);
}
function centerTile(card, rect) {
  if (!card || !card.isConnected) return;
  if (!homeActive()) return;
  const sc = wallScroller(foliaWall() || card.closest('#homeRecommended'));
  if (!sc) return;
  const reduced = typeof motionReduced === 'function' && motionReduced();
  const r = rect || card.getBoundingClientRect();
  const sr = sc.getBoundingClientRect();
  const top = sc.scrollTop + (r.top - sr.top) - Math.max(0, (sc.clientHeight - r.height) / 2);
  // 二维墙还要横向跟随；普通单列墙 scrollWidth == clientWidth，left 会自然夹到 0
  const left = sc.scrollLeft + (r.left - sr.left) - Math.max(0, (sc.clientWidth - r.width) / 2);
  const maxLeft = Math.max(0, sc.scrollWidth - sc.clientWidth);
  foliaRecycleLock = Date.now() + 900;
  sc.scrollTo({
    top,
    left: Math.min(maxLeft, Math.max(0, left)),
    behavior: reduced ? 'auto' : 'smooth'
  });
}
/* 把点开的瓦片推到镜头正中。推得动就推；推到墙边会被夹住时，先看夹住之后卡还能不能
   整个露出来——能露就贴着边算了（不动世界，旁边的东西一点不换）；连整块都露不全，
   才“接一块”（rotateWallWorld 只换画面外的列、并同步平移滚动量，这一屏像素不变）。 */
function centerTileAnywhere(card, rect) {
  if (!card || !card.isConnected || !homeActive()) return;
  const sc = wallScroller(foliaWall() || card.closest('#homeRecommended'));
  if (!sc) { centerTile(card, rect); return; }
  const reduced = typeof motionReduced === 'function' && motionReduced();
  foliaRecycleLock = Date.now() + 900;
  let r = rect || card.getBoundingClientRect();
  const margin = 8;
  for (let pass = 0; pass < 3; pass++) {
    const sr = sc.getBoundingClientRect();
    const maxLeft = Math.max(0, sc.scrollWidth - sc.clientWidth);
    const vLeft = r.left - sr.left;
    const wantLeft = sc.scrollLeft + vLeft - Math.max(0, (sc.clientWidth - r.width) / 2);
    const wantTop = sc.scrollTop + (r.top - sr.top) - Math.max(0, (sc.clientHeight - r.height) / 2);
    const bounded = Math.min(maxLeft, Math.max(0, wantLeft));
    const restLeft = vLeft + (bounded - sc.scrollLeft);
    if (wantLeft >= 0 && wantLeft <= maxLeft) {
      sc.scrollTo({ top: wantTop, left: wantLeft, behavior: reduced ? 'auto' : 'smooth' });
      return;
    }
    if (restLeft >= margin && restLeft + r.width <= sc.clientWidth - margin) {
      sc.scrollTo({ top: wantTop, left: bounded, behavior: reduced ? 'auto' : 'smooth' });
      return;
    }
    if (!rotateWallWorld(wantLeft < 0 ? 'left' : 'right')) break;
    r = card.getBoundingClientRect();   // 接完一块，卡在屏幕上的位置跟着平移，重新量
  }
  /* 真的没有余量（比如列被锁死）：只做把它整个推进画面的最小位移，别再动世界。 */
  const sr = sc.getBoundingClientRect();
  const maxLeft = Math.max(0, sc.scrollWidth - sc.clientWidth);
  const vLeft = r.left - sr.left;
  const vRight = vLeft + r.width;
  const wantTop = sc.scrollTop + (r.top - sr.top) - Math.max(0, (sc.clientHeight - r.height) / 2);
  const cap = Math.max(320, Number(foliaPlane()?.dataset.blockW) || sc.clientWidth);
  let dLeft = 0;
  if (vLeft < 24) dLeft = Math.max(-cap, vLeft - 24);
  else if (vRight > sc.clientWidth - 24) dLeft = Math.min(cap, vRight - (sc.clientWidth - 24));
  foliaRecycleLock = Date.now() + 900;
  sc.scrollTo({
    top: wantTop,
    left: Math.min(maxLeft, Math.max(0, sc.scrollLeft + dLeft)),
    behavior: reduced ? 'auto' : 'smooth'
  });
}
/* 镜头快走到墙头/墙尾时，把最远那一列搬到另一头并同步平移滚动量：画面像素完全不变，
   但左右永远还剩一整块可以走。这样贴边瓦片撑开后总能推到正中，也不会露出空白条。 */
let foliaRecycleLock = 0;
function bindFoliaCamera(sc) {
  if (!sc || sc.dataset.foliaRecycle === '1') return;
  sc.dataset.foliaRecycle = '1';
  let raf = 0;
  let idle = 0;
  sc.addEventListener('scroll', () => {
    /* 滚动期间给 <html> 挂 wall-scrolling：播放瓦片的逐词上色在这个区间里让路，
       免得整块大瓦片一边被合成器平移、一边每帧重绘文字。停 180ms 后自动摘掉。 */
    document.documentElement.classList.add('wall-scrolling');
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      idle = 0;
      document.documentElement.classList.remove('wall-scrolling');
    }, 180);
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const plane = foliaPlane();
      if (!plane || !homeActive()) return;
      schedulePlayingSync();
      if (Date.now() < foliaRecycleLock) return;
      const W = Number(plane.dataset.blockW);
      if (!W) return;
      /* 纵向也无限：镜头贴近块边界时整块搬行（块高恒定，位移精确补偿） */
      const bh = blockHeightOf(sc.querySelector('#homeRecommended'));
      if (bh && sc.scrollHeight > sc.clientHeight + bh * 2) {
        const maxTop = sc.scrollHeight - sc.clientHeight;
        if (sc.scrollTop > maxTop - bh * 0.72) {
          foliaRecycleLock = Date.now() + 320;
          rotateWallRows('down');
          return;
        }
        if (sc.scrollTop > 0 && sc.scrollTop < bh * 0.72) {
          foliaRecycleLock = Date.now() + 320;
          rotateWallRows('up');
          return;
        }
      }
      const max = sc.scrollWidth - sc.clientWidth;
      if (sc.scrollLeft < W * 0.55) { foliaRecycleLock = Date.now() + 300; rotateWallWorld('left'); }
      else if (sc.scrollLeft > max - W * 0.55) { foliaRecycleLock = Date.now() + 300; rotateWallWorld('right'); }
    });
  });
}
/* ---- 墙的拖拽平移 ----
   Folia 的墙是一台相机：指针按下拖 7px 才算拖动，松手带惯性；我们的墙是原生滚动容器，
   等价地改 scrollLeft/Top。之前鼠标用户横不动这块墙（只能 Shift+滚轮或点右下角定位）。 */
let wallDragSuppressUntil = 0;
let wallDragClickBound = false;
function bindWallDragPan(sc) {
  if (!sc || sc.dataset.wallDrag === '1') return;
  sc.dataset.wallDrag = '1';
  if (!wallDragClickBound) {
    wallDragClickBound = true;
    // 拖完松手会补一个 click：吃掉它，免得手一滑就把瓦片点开/进节目页
    document.addEventListener('click', (e) => {
      if (Date.now() > wallDragSuppressUntil) return;
      wallDragSuppressUntil = 0;
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }
  let drag = null, inertia = 0, vx = 0, vy = 0;
  let savedBehavior = null;   // 拖动前 .main 的 inline scroll-behavior，拖完还原
  const restoreBehavior = () => {
    if (savedBehavior === null) return;
    sc.style.scrollBehavior = savedBehavior;
    savedBehavior = null;
  };
  const stopInertia = () => { if (inertia) cancelAnimationFrame(inertia); inertia = 0; restoreBehavior(); };
  sc.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.isPrimary) return;
    if (!(e.target instanceof Element)) return;
    if (e.target.closest('button, input, select, textarea, [role="slider"], .tile-peek-actions')) return;
    stopInertia();
    vx = vy = 0;
    // .main 挂着 scroll-behavior: smooth：拖动时每帧改 scrollLeft 会被它变成补间，
    // 跟手变成拖泥带水。拖动期间强制 auto，松手/取消后还原。
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: sc.scrollLeft, top: sc.scrollTop,
      lastX: e.clientX, lastY: e.clientY, lastT: e.timeStamp, moved: false };
    savedBehavior = sc.style.scrollBehavior || '';
    sc.style.scrollBehavior = 'auto';
  });
  sc.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 7) return;
    if (!drag.moved) {
      drag.moved = true;
      sc.setPointerCapture(e.pointerId);
      sc.classList.add('is-panning');
    }
    const dt = Math.max(1, e.timeStamp - drag.lastT);
    vx = (e.clientX - drag.lastX) / dt * 1000;
    vy = (e.clientY - drag.lastY) / dt * 1000;
    drag.lastX = e.clientX; drag.lastY = e.clientY; drag.lastT = e.timeStamp;
    sc.scrollLeft = drag.left - dx;
    sc.scrollTop = drag.top - dy;
    e.preventDefault();
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = drag.moved;
    const stale = e.timeStamp - drag.lastT;
    drag = null;
    sc.classList.remove('is-panning');
    if (sc.hasPointerCapture && sc.hasPointerCapture(e.pointerId)) sc.releasePointerCapture(e.pointerId);
    if (!moved) { restoreBehavior(); return; }
    wallDragSuppressUntil = Date.now() + 400;
    if (stale > 100) { restoreBehavior(); return; }   // 停手一会儿才松：不惯性
    if (Math.hypot(vx, vy) < 60) { restoreBehavior(); return; }  // 慢拖不惯性
    let px = vx, py = vy, last = performance.now();
    const step = (now) => {
      const dt = Math.min(50, now - last);
      last = now;
      sc.scrollLeft += px * dt / 1000;
      sc.scrollTop += py * dt / 1000;
      px *= 0.94; py *= 0.94;
      if (Math.hypot(px, py) < 40) { inertia = 0; restoreBehavior(); return; }
      inertia = requestAnimationFrame(step);
    };
    inertia = requestAnimationFrame(step);
  };
  sc.addEventListener('pointerup', end);
  sc.addEventListener('pointercancel', end);
  // 封面图是 <img>，原生拖拽会把指针手势抢走（拖出半张图）；卡内一律禁掉
  sc.addEventListener('dragstart', (e) => {
    if (e.target instanceof Element && e.target.closest('.pod-card')) e.preventDefault();
  });
}
function nearWallBottom(wall) {
  const sc = wallScroller(wall);
  if (!sc) return window.scrollY + window.innerHeight + 1000 >= document.documentElement.scrollHeight;
  return sc.scrollTop + sc.clientHeight + 320 >= sc.scrollHeight;
}
/* ---- 方向键选瓦片：照 Folia 的布局候选模型走，不是“中心点最近邻” ----
   Folia 的墙先把当前瓦片周围一块的槽位都当候选，再按前进代价挑：
   候选必须整个落在当前瓦片的前进方向之外；横轴有重叠就只比前进距离，
   没有重叠才按绕行代价（横轴间距 ×2 + 一格）计。所以左右也能顺着同一行走。 */
const WALL_AXIS = {
  right: { along: 'left', cross: 'top', alongSize: 'width', crossSize: 'height', sign: 1 },
  left: { along: 'left', cross: 'top', alongSize: 'width', crossSize: 'height', sign: -1 },
  down: { along: 'top', cross: 'left', alongSize: 'height', crossSize: 'width', sign: 1 },
  up: { along: 'top', cross: 'left', alongSize: 'height', crossSize: 'width', sign: -1 },
};
function pickWallNeighbor(dir, cur, items) {
  const axis = WALL_AXIS[dir];
  if (!axis || !cur || !items || !items.length) return null;
  const sizes = items.map(item => Math.min(item.rect.width, item.rect.height)).filter(n => n > 1);
  const cell = (sizes.length ? Math.min(...sizes) : 96) / 2;
  let best = null;
  let bestCost = Infinity;
  let bestCross = Infinity;
  items.forEach(item => {
    const box = item.rect;
    if (!box || box.width < 1 || box.height < 1) return;
    const gap = axis.sign === 1
      ? box[axis.along] - (cur[axis.along] + cur[axis.alongSize])
      : cur[axis.along] - (box[axis.along] + box[axis.alongSize]);
    if (gap < -0.5) return;   // 还压在当前瓦片身上：Folia 直接跳过，不拿它当右边/下边
    const overlap = Math.min(cur[axis.cross] + cur[axis.crossSize], box[axis.cross] + box[axis.crossSize]) -
      Math.max(cur[axis.cross], box[axis.cross]);
    const crossGap = Math.abs(
      (box[axis.cross] + box[axis.crossSize] / 2) - (cur[axis.cross] + cur[axis.crossSize] / 2)
    );
    const cost = gap + (overlap > 0 ? 0 : -overlap * 2 + cell) + crossGap * 1.6;
    if (cost < bestCost - 0.01 || (Math.abs(cost - bestCost) <= 0.01 && crossGap < bestCross)) {
      best = item.value;
      bestCost = cost;
      bestCross = crossGap;
    }
  });
  return best;
}
/* 还没选中时 Folia 落的不是左上第一张，而是离视口中心最近的那张（nearest + viewportCenter）。 */
function nearestWallCard(wall, cards) {
  const sc = wallScroller(wall);
  const sr = sc ? sc.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  const cx = sr.left + sr.width / 2;
  const cy = sr.top + sr.height / 2;
  const near = cards.filter(card => {
    const r = card.getBoundingClientRect();
    return r.bottom > sr.top - 500 && r.top < sr.bottom + 500;
  });
  let best = null;
  let bestD = Infinity;
  (near.length ? near : cards).forEach(card => {
    const r = card.getBoundingClientRect();
    const dx = r.left + r.width / 2 - cx;
    const dy = r.top + r.height / 2 - cy;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = card; }
  });
  return best;
}
function wallCursorCard() {
  return document.querySelector('#homeRecommended .pod-card.is-cursor');
}
function clearWallCursor() {
  document.querySelectorAll('#homeRecommended .pod-card.is-cursor')
    .forEach(card => card.classList.remove('is-cursor'));
}
function setWallCursor(card, opts) {
  if (!card) return;
  clearWallCursor();
  card.classList.add('is-cursor');
  const main = card.querySelector('.pod-card-main');
  if (main && typeof main.focus === 'function') main.focus({ preventScroll: true });
  /* Folia 每走一步都把选中卡滑到视口正中（panTo）。点击路径先不抢跑，
     等瓦片撑开后再由 centerTile 推一次，避免连推两下。 */
  if (!opts || opts.pan !== false) centerTile(card);
}
function moveWallCursor(dir) {
  const wall = foliaWall();
  if (!wall) return false;
  const plane = foliaPlane();
  const collect = () => (plane || wall).querySelectorAll('.pod-card');
  let cards = [...collect()].filter(card => {
    const r = card.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  });
  if (!cards.length) return false;
  const cur = wallCursorCard();
  if (!cur || !cards.includes(cur)) {
    /* 第一下方向键：落在视口中心最近的瓦片上，跟 Folia 的首次 nearest 一样。 */
    const first = nearestWallCard(wall, cards);
    setWallCursor(first);
    return true;
  }
  if (plane) {
    // 走到最右 / 最左列：先把另一列搬到前方，画面不变但右边/左边又有一整块
    const cols = wallColumns().slice().sort((a, b) => Number(a.dataset.foliaX) - Number(b.dataset.foliaX));
    const index = cols.indexOf(wallColumnOf(cur));
    if (dir === 'right' && index === FOLIA_COLUMNS - 1) {
      if (!rotateWallWorld('right')) return false;
      cards = [...collect()].filter(card => {
        const r = card.getBoundingClientRect();
        return r.width > 1 && r.height > 1;
      });
    } else if (dir === 'left' && index === 0) {
      if (!rotateWallWorld('left')) return false;
      cards = [...collect()].filter(card => {
        const r = card.getBoundingClientRect();
        return r.width > 1 && r.height > 1;
      });
    }
  }
  const a = cur.getBoundingClientRect();
  const best = pickWallNeighbor(dir, a, cards
    .filter(card => card !== cur)
    .map(card => ({ value: card, rect: card.getBoundingClientRect() })));
  if (!best) return false;
  setWallCursor(best);
  return true;
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
      if (foliaPlane()) return;   // 二维墙的纵向靠块搬行，不再往墙尾补块
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
document.addEventListener('hashchange', clearWallCursor);
document.addEventListener('myt:theme-change', clearWallCursor);


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
    /* 书签是「按句收藏」，靠 .subs-off-hide 由 body class 收掉——不在渲染时判断插件状态，
       否则首页在插件加载完成前渲染会把这一格留下。 */
    + statHTML('收藏片段', app.bookmarks.length, '播放器里点 ☆', 'subs-off-hide');

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
  const wallHost = $('homeRecommended');
  if (wallHost) wallHost.dataset.foliaRender = String(Date.now());   // 二维墙据此重建两侧列
  backfillWallArt();
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
        coverHTML(show, 'ep-art', 300) + '<div class="ep-body"><span class="ep-title">' + esc(show.name) +
        '</span><span class="ep-sub">' + esc(hostOf(show.feed)) + '</span></div><button class="mini-btn" data-remove-sub="' +
        esc(show.slug) + '" title="移除">✕</button></div>').join('') + '</div>'
      : emptyLine('还没有站外订阅。', '<button class="btn ghost" data-action="add-feed">＋ 添加 RSS</button>'));
  renderOnlineResults();
  renderChartPanel();
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
  /* 字幕能力关掉后没有「文字稿库」这项能力：索引与搜索一起停，不再读旧索引。 */
  if (!subtitlePluginOn()) return [];
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
  /* 字幕能力关掉后没有「当前文字稿 / 文字稿库」两档，残留的标签值回落到全部。 */
  if (!subtitlePluginOn() && (searchTab === 'library' || searchTab === 'transcripts')) searchTab = 'all';
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
    html += matched.map(show => '<div class="ep-row" data-open-podcast="' + esc(show.slug) + '">' + coverHTML(show, 'ep-art', 300) +
      '<div class="ep-body"><span class="ep-title">' + esc(show.name) + '</span><span class="ep-sub">播客 · ' +
      esc(show.builtin ? '内置增强文字稿' : '站外') + '</span></div><span class="pill">播客</span></div>').join('');
    if (matchedCatalog.length) {
      html += '<div class="smalltext" style="margin:14px 0 2px">本站目录 · 未订阅</div>' +
        matchedCatalog.map(show => '<div class="ep-row" data-open-podcast="' + esc(show.slug) + '">' + coverHTML(show, 'ep-art', 300) +
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
  /* 返回按钮跟来源走：从首页/搜索/发现/播客库进来就回那一页；带参数的路由（单集/播放器）无法裸跳，退回播客库。 */
  const trail = app.pageTrail || [];
  let backPage = '';
  for (let i = trail.length - 1; i >= 0 && !backPage; i--) {
    const p = trail[i];
    if (p !== 'podcast' && BACK_PAGES.includes(p)) backPage = p;
  }
  if (!backPage) backPage = (app.lastPage && BACK_PAGES.includes(app.lastPage)) ? app.lastPage : 'library';
  const backLabel = PAGE_NAMES[backPage] || '播客库';
  view.innerHTML = '<div class="page-head"><div><div class="eyebrow">' + (show.builtin ? 'BUILT-IN SHOW' : 'EXTERNAL FEED') +
    '</div><h1>' + esc(show.name) + '</h1><div class="subtitle">' + (count ? count + ' 集' : '') +
    subtitleShowSuffix(show) + '</div></div><button class="btn ghost" data-route="' + backPage + '">← 返回' + backLabel + '</button></div>' +
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
    (subtitleKvLabel(show) ? '<div class="kv"><span>文字稿</span><b>' + subtitleKvLabel(show) + '</b></div>' : '') +
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
    '<div class="detail-meta"><span>' + esc(show.name) + '</span>' +
    (subtitleEpisodeLabel(show, ep) ? '<span>' + subtitleEpisodeLabel(show, ep) + '</span>' : '') + '</div>' +
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
