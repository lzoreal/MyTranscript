import { $, audio, prefs, state } from './00-runtime.js';
import { esc, fmt, invalidateWordPanelKey, reader, seekTo, showToast, splitLabel, wallpaperRefresh } from './01-theme-reader-shell.js';
import { selectEpisode } from './03-native-asr-service-worker.js';
import { smallArtwork, subtitlePluginOn } from './04-local-audio-plugin-host.js';
import { BOOKMARK_KEY, NOTE_KEY, PAGE_NAMES, app, episodesOf, formatDate, isPlayed, writeJSON } from './05-transport-transcript-nav.js';
import { coverGrad, initialsOf } from './06-catalog-feeds-search.js';
import { registerLayer } from './00-layers.js';
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

function setMobileMore(open) {
  document.body.classList.toggle('mobile-more', !!open);
  const scrim = $('mobileScrim');
  if (scrim) scrim.hidden = !open;
  const btn = $('mobileMoreBtn');
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}
function mobileNarrow() {
  return typeof matchMedia === 'function' && matchMedia('(max-width: 900px)').matches;
}

function bindLedgerUI() {
  if (app.ledgerBound) return;
  app.ledgerBound = true;
  try { setNavCollapsed(localStorage.getItem('myt-nav-collapsed') === '1', false); } catch (e) { setNavCollapsed(false, false); }
  const wide = window.innerWidth >= 1200;
  ['series', 'notes'].forEach(name => {
    let saved = null;
    try { saved = localStorage.getItem('myt-rail-' + name); } catch (e) {}
    // 窄窗侧栏是覆盖式抽屉，两栏同时开会把正文全盖住；窄窗一律先收起。
    setRailOpen(name, wide && (saved === null ? true : saved === '1'), false);
  });
  let wasNarrow = window.innerWidth <= 860;
  window.addEventListener('resize', () => {
    const narrow = window.innerWidth <= 860;
    if (narrow && !wasNarrow) ['series', 'notes'].forEach(name => setRailOpen(name, false, false));
    wasNarrow = narrow;
  });
  const navBtn = $('sidebarToggle');
  if (navBtn) navBtn.onclick = () => {
    // 窄窗里侧栏按布局隐藏，左上角按钮改成“打开页面导航”，
    // 否则设置/下载/笔记这些页只能靠猜路由。
    if (mobileNarrow()) { setMobileMore(!document.body.classList.contains('mobile-more')); return; }
    setNavCollapsed(!document.body.classList.contains('nav-collapsed'));
  };
  const moreBtn = $('mobileMoreBtn');
  if (moreBtn) moreBtn.onclick = () => setMobileMore(!document.body.classList.contains('mobile-more'));
  const intensiveBar = $('intensiveBar');
  if (intensiveBar) {
    const intensiveShow = $('intensiveShowBtn');
    if (intensiveShow) intensiveShow.addEventListener('click', toggleIntensiveCollapsed);
    intensiveBar.addEventListener('click', event => {
      const step = event.target.closest('[data-intensive]');
      if (step) { runIntensiveStep(Number(step.dataset.intensive)); return; }
      if (event.target.closest('#intensiveReset')) { resetIntensive(); return; }
      if (event.target.closest('#intensiveCollapse')) { toggleIntensiveCollapsed(); return; }
      if (event.target.closest('#intensiveNoteSave')) { saveIntensiveNote(); }
    });
    document.addEventListener('myt:cues-ready', renderIntensive);
    /* 正常播放时字幕是在 syncReaderTop 之后才画出来的；等 DOM 真出现句子再把四步条亮出来。 */
    const transcript = $('transcript');
    if (transcript) {
      let timer = 0;
      new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(() => { if (state.current && state.cues.length) renderIntensive(); }, 80);
      }).observe(transcript, { childList: true, subtree: true });
    }
  }
  // 节目页「展开简介」与单集页「更多」菜单：都是轻量内联交互，挂在文档上即可，
  // 页面重渲染后不用重新绑定。
  document.addEventListener('click', event => {
    const toggle = event.target.closest('.show-desc-toggle');
    if (toggle) {
      const wrap = toggle.closest('.show-desc-wrap');
      const open = wrap.classList.toggle('open');
      toggle.textContent = open ? '收起简介' : '展开简介';
      return;
    }
    if (!event.target.closest('.more-menu')) {
      document.querySelectorAll('.more-menu[open]').forEach(node => node.removeAttribute('open'));
    } else if (event.target.closest('.more-list')) {
      const menu = event.target.closest('.more-menu');
      if (menu) menu.removeAttribute('open');
    }
  });
  const moreClose = $('mobileMoreClose');
  if (moreClose) moreClose.onclick = () => setMobileMore(false);
  const scrim = $('mobileScrim');
  if (scrim) scrim.onclick = () => setMobileMore(false);
  if (window.addEventListener) {
    window.addEventListener('resize', () => { if (!mobileNarrow()) setMobileMore(false); });
    // 侧栏抽屉里的路由点击后自动收起，不把遮罩留在页面上。
    document.addEventListener('click', event => {
      if (!document.body.classList.contains('mobile-more')) return;
      if (event.target.closest('#sideNav [data-route],#sideNav2 [data-route],.sidebar-add')) setMobileMore(false);
    }, true);
  }
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
      const ids = { study: 'studyBtn', bookmark: 'readerBookmarkBtn', chapter: 'chapterBtn', info: 'detailsBtn' };
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
/* ---------- 精听四步 ----------
   盲听 → 看稿 → 跟读 → 复述。状态按“节目+单集”存在本机，
   换集、重启都接得上；复述可以直接落成这集的笔记。 */
const INTENSIVE_KEY = 'myt-intensive-v1';
const INTENSIVE_COLLAPSE_KEY = 'myt-intensive-collapsed';
const INTENSIVE_HINTS = [
  '先不看文字，听 30 秒抓大意。文字会被模糊，但不锁滚动。',
  '恢复文字：对着当前句看一遍生词和连读。',
  '当前句连播 3 遍，跟着音频开口。',
  '合上文字，用一句话复述；写下来就存进本集笔记。',
];
let intensiveLoopStop = null;
function intensiveId() {
  return state.show && state.current ? state.show.slug + '|' + state.current.id : '';
}
function intensiveSteps() {
  let all = {};
  try { all = JSON.parse(localStorage.getItem(INTENSIVE_KEY) || '{}') || {}; } catch (e) {}
  const saved = all[intensiveId()];
  return Array.isArray(saved) && saved.length === 4 ? saved.map(Boolean) : [false, false, false, false];
}
function saveIntensiveSteps(steps) {
  const id = intensiveId();
  if (!id) return;
  let all = {};
  try { all = JSON.parse(localStorage.getItem(INTENSIVE_KEY) || '{}') || {}; } catch (e) {}
  all[id] = steps;
  try { localStorage.setItem(INTENSIVE_KEY, JSON.stringify(all)); } catch (e) {}
}
function intensiveCollapsed() {
  try { return localStorage.getItem(INTENSIVE_COLLAPSE_KEY) === '1'; } catch (e) { return false; }
}
function toggleIntensiveCollapsed() {
  const next = !intensiveCollapsed();
  try { localStorage.setItem(INTENSIVE_COLLAPSE_KEY, next ? '1' : '0'); } catch (e) {}
  renderIntensive();
  document.dispatchEvent(new CustomEvent('myt:intensive-toggle', { detail: { collapsed: next } }));
}
function stopIntensiveLoop() {
  if (intensiveLoopStop) { audio.removeEventListener('timeupdate', intensiveLoopStop); intensiveLoopStop = null; }
}
function renderIntensive() {
  const bar = $('intensiveBar');
  if (!bar) return;
  if (!state.show || !state.current || !state.cues.length) {
    bar.hidden = true;
    bar.classList.remove('collapsed');
    document.body.classList.remove('intensive-on', 'intensive-collapsed');
    document.documentElement.style.setProperty('--intensive-h', '0px');
    const showBtn = $('intensiveShowBtn');
    if (showBtn) { showBtn.hidden = true; showBtn.setAttribute('aria-expanded', 'false'); }
    return;
  }
  const collapsed = intensiveCollapsed();
  bar.hidden = collapsed;
  document.body.classList.add('intensive-on');
  bar.classList.toggle('collapsed', collapsed);
  document.body.classList.toggle('intensive-collapsed', collapsed);
  const collapseBtn = $('intensiveCollapse');
  if (collapseBtn) {
    collapseBtn.textContent = collapsed ? '展开' : '收起';
    collapseBtn.setAttribute('aria-expanded', String(!collapsed));
    collapseBtn.title = collapsed ? '展开精听栏' : '收起精听栏';
  }
  const showBtn = $('intensiveShowBtn');
  if (showBtn) {
    showBtn.hidden = !collapsed;
    showBtn.setAttribute('aria-expanded', String(!collapsed));
    showBtn.title = '展开精听四步';
  }
  const steps = intensiveSteps();
  bar.querySelectorAll('[data-intensive]').forEach(button => {
    const i = Number(button.dataset.intensive) - 1;
    button.classList.toggle('done', !!steps[i]);
  });
  const next = steps.findIndex(step => !step);
  bar.querySelectorAll('[data-intensive]').forEach(button => {
    button.classList.toggle('active', Number(button.dataset.intensive) - 1 === next);
  });
  const prog = $('intensiveProg'); if (prog) prog.textContent = steps.filter(Boolean).length + '/4';
  const hint = $('intensiveHint');
  if (hint) hint.textContent = next >= 0 ? INTENSIVE_HINTS[next] : '这集四步都走完了。可以重来，或去下一集。';
  const noteWrap = $('intensiveNoteWrap');
  if (noteWrap) noteWrap.hidden = !steps[3];
  /* 顶栏是 fixed 的 58px；精听条本身也要有自己的高度，正文 padding 才能让出这块。
     收起时整条不占位，高度记 0，正文直接上移。 */
  document.documentElement.style.setProperty('--intensive-h', collapsed ? '0px' : bar.offsetHeight + 'px');
}
function markIntensive(step) {
  const steps = intensiveSteps();
  steps[step - 1] = true;
  saveIntensiveSteps(steps);
  renderIntensive();
}
function resetIntensive() {
  stopIntensiveLoop();
  document.body.classList.remove('intensive-blind');
  saveIntensiveSteps([false, false, false, false]);
  const note = $('intensiveNote'); if (note) note.value = '';
  renderIntensive();
  showToast('这集的精听进度已清空。');
}
function repeatCurrentCue(loops = 3) {
  stopIntensiveLoop();
  const cue = state.cues[state.activeCue >= 0 ? state.activeCue : 0];
  if (!cue) { showToast('当前还没有可跟读的句子。', 'warn'); return; }
  const start = Number(cue.start) || 0;
  const end = Math.min(Number(cue.end) || start + 10, start + 15);
  let left = loops;
  const onTime = () => {
    if (left <= 0 || audio.currentTime < end - 0.03) return;
    left--;
    /* 暂停瞬间还会再来一两帧 timeupdate，先摘监听，否则一次 end 会被扣成好几遍。 */
    audio.removeEventListener('timeupdate', onTime);
    audio.pause();
    if (left <= 0) { intensiveLoopStop = null; return; }
    setTimeout(() => {
      if (!state.current) { intensiveLoopStop = null; return; }
      audio.addEventListener('timeupdate', onTime);
      seekTo(start);
    }, 400);
  };
  intensiveLoopStop = onTime;
  audio.addEventListener('timeupdate', onTime);
  seekTo(start);
  showToast('连播 ' + loops + ' 遍当前句，跟着读。');
}
function runIntensiveStep(step) {
  if (!state.current || !state.show) { showToast('先播放一集。', 'warn'); return; }
  if (step === 1) {
    document.body.classList.add('intensive-blind');
  } else if (step === 2) {
    document.body.classList.remove('intensive-blind');
    const node = state.nodes[state.activeCue];
    if (node && node.el && node.el.scrollIntoView) node.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  } else if (step === 3) {
    repeatCurrentCue(3);
  } else if (step === 4) {
    document.body.classList.remove('intensive-blind');
    const noteWrap = $('intensiveNoteWrap');
    if (noteWrap) { noteWrap.hidden = false; $('intensiveNote')?.focus(); }
  }
  markIntensive(step);
}
function saveIntensiveNote() {
  const input = $('intensiveNote');
  const body = String(input?.value || '').trim();
  if (!state.show || !state.current) return;
  if (!body) { showToast('先写一句复述再保存。', 'warn'); input?.focus(); return; }
  const cue = state.cues[state.activeCue] || state.cues[0];
  const time = Math.round((cue ? cue.start : audio.currentTime || 0) + (state.offset || 0));
  app.notes.unshift({
    key: state.show.slug, ep: state.current.id, title: '精听复述', body,
    t: time, at: Date.now(),
  });
  writeJSON(NOTE_KEY, app.notes);
  showToast('复述已存进本集笔记。');
  renderReaderRails();
}
function syncReaderTop() {
  if (state.current) { try { localStorage.setItem('myt-reader-opened', '1'); } catch (e) {} }
  renderIntensive();
  const pill = $('readerShowPill');
  if (pill) pill.textContent = state.show ? 'NOW PLAYING · ' + String(state.show.name || '').toUpperCase() : 'NOW PLAYING';
  const back = $('readerBack');
  if (back) back.title = '返回' + (PAGE_NAMES[app.lastPage] || '首页');
  renderReaderRails();
  syncRailButtons();
  if (state.wallpaper) { invalidateWordPanelKey(); wallpaperRefresh(); }
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
export { MINI_CAPTION_KEY, bindLedgerUI, currentPlaylist, miniCaptionExpanded, miniCaptionIdx, miniCaptionKey, miniCaptionMarkup, miniCaptionPref, miniCoverKey, miniPctBucket, miniPlayOn, miniTimeText, nextTarget, railCoverHTML, renderReaderRails, setNavCollapsed, setRailOpen, stepEpisode, stepTarget, syncBookmarkBtn, syncMini, syncMiniCaption, syncRailButtons, syncReaderTop, toggleBookmarkCue, toggleMiniCaption };
registerLayer('09-player-integration', { MINI_CAPTION_KEY, bindLedgerUI, currentPlaylist, miniCaptionExpanded, miniCaptionIdx, miniCaptionKey, miniCaptionMarkup, miniCaptionPref, miniCoverKey, miniPctBucket, miniPlayOn, miniTimeText, nextTarget, railCoverHTML, renderReaderRails, setNavCollapsed, setRailOpen, stepEpisode, stepTarget, syncBookmarkBtn, syncMini, syncMiniCaption, syncRailButtons, syncReaderTop, toggleBookmarkCue, toggleMiniCaption });
