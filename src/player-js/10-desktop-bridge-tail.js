import { $, LIVE, audio, host, prefs, replacePrefs, setState, state, tauriHost } from './00-runtime.js';
import { PROGRESS_KEY, applyCustomTheme, applyReader, closeOverlays, epKey, esc, fmt, getJson, invalidateProgressCache, isJsonTranscript, openDetails, paint, parseFeed, rawSeek, readCustomTheme, reader, rebuildCues, seekTo, setImmersive, showToast, studyNormText, syncCustomThemeEditor, writeCustomTheme, writeProgressAll } from './01-theme-reader-shell.js';
import { coreProvider, defineCoreProvider, liveMseStop, liveUpdateMeter } from './02-live-caption-wasm.js';
import { selectEpisode } from './03-native-asr-service-worker.js';
import { clearPluginConsent, clipNow, emitPlugin, loadShow, pluginDiagnosticsText, pluginPlayerState, refreshPluginSettings, registerStudyUiHook, reloadPlugins, smallArtwork, startLocalTranscribe, subtitlePluginOn } from './04-local-audio-plugin-host.js';
import { BOOKMARK_KEY, LOCAL_KEY, NOTE_KEY, PREFS_KEY, absoluteUrl, addInboxItem, addToPlaylistDialog, app, applyLoudness, applyRate, applyVolume, cancelAsrModel, catalogLatest, cleanFeedTitle, cleanWord, closeDockSheet, closeWordPanel, dockSheet, downloadEpisode, ensureAudioGraph, episodesOf, extSlug, findBuiltinByFeed, fmtBytes, formatDate, hash32, hostOf, idxClear, importAsrModel, inboxRemove, indexAllShows, indexCurrentShow, installAsrModel, isFavorite, isPlayed, isSubscribed, navigate, normalizeFeedUrl, offlineEntries, offlineKeyFor, offlineLabel, openAsrDir, paintAsrSoon, pickAsrModel, playOffline, playPlaylist, readAllProgress, refreshAsrModels, refreshOffline, refreshShows, removeAsrModel, removeOffline, removePlaylist, renderAfterStateChange, renderDownloads, renderOfflineList, resolveOfflineRef, routeHash, saveFavorites, saveInbox, savePlayed, saveSeen, saveShowPrefs, saveSubs, seekChapter, setPlayed, setShowPref, showByKey, showPrefFor, subscribeRecord, subscribeShow, syncDockSleep, syncIndexCount, toggleChapterSheet, toggleFavorite, unsubscribeKey, wordCurrentMeaning, writeJSON } from './05-transport-transcript-nav.js';
import { ONLINE_PAGE, checkSubscriptions, copyText, coverHTML, downloadFile, ensureShowFeed, exportOpml, exportSubtitle, feedCachePut, fetchFeedText, hasFreshFeed, loadLocalState, openOnlineDetail, parseOpml, rememberFeed, renderOnlineResults, runOnlineSearch, subscribeFromOnline } from './06-catalog-feeds-search.js';
import { LISTEN_APPEARANCE, LISTEN_CONTINUE, addToQueue, applyRoute, importLocalFolder, openPlayerRoute, renderAutoSettings, renderBookmarks, renderDiscover, renderEcho, renderHistory, renderHome, renderInbox, renderLibrary, renderListening, renderLocal, renderNotes, renderPodcast, renderQueue, renderSearch, saveQueue, searchTab, setSearchTab } from './07-routes-pages.js';
import { openSettingsPane, renderSidebarSettings, resetSidebarSettings, saveStudyCache, studyAddVocab, studyCache, studyChat, studyClockSeconds, studyCueBounds, studyCurrentCue, studyDueItems, studyExportCsv, studyLangName, studyMarkWord, studyOpenEpisodeSummary, studyParseJson, studyPlayRange, studyReady, studyRenderEpisode, studyRenderPractice, studyStats, studyView, studyVocab, syncThemeSwatches } from './08-study-ai.js';
import { currentPlaylist, nextTarget, stepEpisode, syncBookmarkBtn, syncMini, toggleBookmarkCue, toggleMiniCaption } from './09-player-integration.js';
import { registerLayer } from './00-layers.js';
import { motionCancel, motionEnter, motionLeave } from './11-motion.js';
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
/* 队列接缝：下一集怎么选可以被插件替换（比如换随机/按标签排序策略）。 */
defineCoreProvider('queue', { next: radioOnly => defaultPlayNextAuto(radioOnly) });
function playNextAuto(radioOnly) { return coreProvider('queue').next(radioOnly); }
async function defaultPlayNextAuto(radioOnly) {
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
  motionCancel(modal);
}
function closeModal() {
  const modal = $('modal');
  if (!modal || !modal.open) return Promise.resolve();
  /* 原生 dialog 关闭会立刻离开顶层，先播完淡出再 close；重开时 token 失效，不再关闭。 */
  const token = (modal.__motionToken = (modal.__motionToken || 0) + 1);
  modal.classList.add('anim-leaving');
  return new Promise(resolve => {
    let timer = 0;
    const done = () => {
      if (timer) clearTimeout(timer);
      modal.removeEventListener('transitionend', onEnd);
      if (modal.__motionToken !== token) { resolve(); return; }
      modal.classList.remove('anim-leaving');
      if (modal.open) modal.close();
      resolve();
    };
    const onEnd = event => {
      if (event.target === modal && event.propertyName === 'opacity') done();
    };
    if (typeof window !== 'undefined' && window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      done();
      return;
    }
    modal.addEventListener('transitionend', onEnd);
    timer = setTimeout(done, 260);
  });
}
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
/* 播放接缝：插件可以覆盖 play()（比如换播放器内核），不覆盖时就是原行为。 */
defineCoreProvider('playback', { play: (key, epId, time) => defaultPlayEpisode(key, epId, time) });
function playEpisode(key, epId, time) { return coreProvider('playback').play(key, epId, time); }
function defaultPlayEpisode(key, epId, time) {
  if (!key || !epId) return;
  app.autoplay = true;
  if (Number(time) > 0) { app.pendingSeek = Number(time); app.pendingSeekEp = epId; }
  // 没有字幕插件时保持最原生的列表/单集页：点播放只在原地开始音频，
  // 由迷你播放器接管控制，不强制跳进全屏播放页。
  if (!subtitlePluginOn()) {
    const show = showByKey(key);
    if (!show) { app.autoplay = false; return; }
    if (state.show?.slug === show.slug && state.current?.id === epId && (audio.currentSrc || audio.getAttribute('src'))) {
      if (Number(time) > 0) seekTo(Number(time));
      audio.play().catch(() => {});
      return;
    }
    loadShow(show.slug, epId).catch(() => { app.autoplay = false; });
    return;
  }
  if (document.body.classList.contains('player-open')) {
    const wanted = routeHash('player', [key, epId], Number(time) > 0 ? { t: Number(time) } : {});
    if (location.hash !== wanted) history.replaceState(null, '', wanted);
    openPlayerRoute({ args: [key, epId], params: new URLSearchParams(Number(time) > 0 ? { t: Number(time) } : {}) });
  } else {
    navigate('player', [key, epId], Number(time) > 0 ? { t: Number(time) } : {});
  }
}
function closeThemePop() { const pop = $('themePop'); if (pop) motionLeave(pop); }
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
    if (el.dataset.openVideoEp !== undefined) {
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
    const pop = $('themePop');
    if (pop.classList.contains('on')) { motionLeave(pop); return; }
    motionEnter(pop).then(() => pop.querySelector('.swatch')?.focus());
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
      setSearchTab(button.dataset.searchTab);
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
  if ($('pluginImport')) $('pluginImport').onclick = async () => {
    try {
      const picked = await tauriHost().core.invoke('plugin:dialog|open', {
        options: { directory: true, multiple: false, title: '选择插件文件夹（含 plugin.json）' }
      });
      const dir = Array.isArray(picked) ? picked[0] : picked;
      if (!dir) return;
      const id = await host().pluginImport(dir);
      showToast('已导入插件 ' + id + '，默认停用；启用并授权后点「重新加载」生效。', 7000);
      await refreshPluginSettings();
    } catch (err) { showToast('导入失败：' + ((err && err.message) || err), 6000); }
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
    const retry = event.target.closest('[data-plugin-retry]');
    if (retry) {
      retry.disabled = true;
      try {
        await reloadPlugins();
        showToast('已重新加载插件。', 4000);
      } catch (err) {
        showToast('重试失败：' + ((err && err.message) || err), 5000);
      } finally { retry.disabled = false; }
      return;
    }
    const diagnostics = event.target.closest('[data-plugin-diagnostics]');
    if (diagnostics) {
      const text = pluginDiagnosticsText(diagnostics.dataset.pluginDiagnostics) || '没有诊断记录。';
      try {
        await navigator.clipboard.writeText(text);
        showToast('诊断信息已复制。', 3000);
      } catch (err) {
        showToast('复制失败：' + ((err && err.message) || err), 5000);
      }
      return;
    }
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
      if (data.prefs && typeof data.prefs === 'object') replacePrefs(Object.assign({}, prefs, data.prefs));
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
  $('historyClearBtn').onclick = () => { if (confirm('清除全部收听历史？')) { localStorage.removeItem(PROGRESS_KEY); invalidateProgressCache(); renderHistory(); showToast('已清除收听历史。'); } };
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

/* ============================================================
   扩展模块（2026-11 功能批次）
   1) 磁盘缓存：整集分析优先读预生成结果（data 分支 <stem>.ai.json）
   2) 点词即查：本集例句 / AI 查词 / 入生词本 / 朗读
   3) 听力练习：多空填空 / 盲听听写 / 慢速朗读
   4) 前情卡：按整集摘要生成人物、线索、呼应
   5) 学习计划：今日计划 + Anki 导出
   6) 跨集主题时间线：按关键字串起已缓存单集的主题
   ============================================================ */
function initXai() {
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

  registerStudyUiHook('beforeEpisode', function () {
    var id = curEpId();
    if (id && !hasCache(id)) ensureDisk(id);
  });
  registerStudyUiHook('episode', function (body) {
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
  });

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

  registerStudyUiHook('practice', function (body) {
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
  });

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
  registerStudyUiHook('episodeHtml', function (base, data) {
    if (!data) return base;
    return base +
      '<div class="study-section"><h4>前情回顾</h4><div id="xaiRecapBox">' + recapHTML() + '</div></div>' +
      '<div class="study-section"><h4>跨集主题时间线</h4>' +
      '<div class="study-actions"><input class="study-input" id="xaiTlInput" placeholder="关键词，如某个人名或话题" style="max-width:220px">' +
      '<button class="btn ghost small" data-xai-tl-go="1">搜索</button></div>' +
      '<div id="xaiTlBox">' + timelineHTML([], '') + '</div></div>';
  });

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

  registerStudyUiHook('vocab', function (body) {
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
  });

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
}
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
export { addFeedFromPaste, addFeedFromUrl, applyAppearance, autoCleanup, autoDelay, autoDownloadNew, bindShell, closeModal, closeThemePop, defaultPlayEpisode, defaultPlayNextAuto, deleteOfflineQuiet, desktopNotify, importOpmlText, lazyLoadExternal, openAddFeed, openBuiltinImport, openModal, playEpisode, playNextAuto, queueHasEpisode, refreshSubscriptions, savePrefs, saveSleep, setAppearance, setContinueMode, setSleep, startAutoRefresh, startSleepTimer, syncAutoNextSwitch };
export { initXai };
registerLayer('10-desktop-bridge-tail', { addFeedFromPaste, addFeedFromUrl, applyAppearance, autoCleanup, autoDelay, autoDownloadNew, bindShell, closeModal, closeThemePop, defaultPlayEpisode, defaultPlayNextAuto, deleteOfflineQuiet, desktopNotify, importOpmlText, lazyLoadExternal, openAddFeed, openBuiltinImport, openModal, playEpisode, playNextAuto, queueHasEpisode, refreshSubscriptions, savePrefs, saveSleep, setAppearance, setContinueMode, setSleep, startAutoRefresh, startSleepTimer, syncAutoNextSwitch });
