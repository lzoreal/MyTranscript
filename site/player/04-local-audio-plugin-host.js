import { $, LIVE, audio, box, host, listBox, prefs, setState, state, tauriHost } from './00-runtime.js';
import { applyCustomTheme, applyReader, closeTypeSheet, cuesFromJson, directAudioUrl, emptyLine, esc, fmt, getJson, loaderHTML, parseFeed, pluginPageKey, readCustomTheme, reader, rebuildCues, renderCustomThemeGrid, saveProgress, seekTo, showToast, statHTML, status, studyNormText, syncCustomThemeEditor, syncJumpPill, writeCustomTheme } from './01-theme-reader-shell.js';
import { CORE_PROVIDER_NAMES, coreProvider, coreProviderOwner, defineCoreProvider, registerCoreProvider, releaseCoreProviders, syncLiveLeadSelect } from './02-live-caption-wasm.js';
import { applyEpisodeData, liveDisable, liveEnable, mergeAdRanges, sanitizeAdRanges, selectEpisode, studyAdRangesFromData, studyApplyAiAdRanges } from './03-native-asr-service-worker.js';




import { apiCompatible, HOST_API_VERSION, satisfies } from './host/contract.js';
import { createContributionRegistry } from './host/registry.js';
import { validateLegacyManifest } from './host/legacy.js';
import { DEFAULT_PLUGIN_TIMEOUT_MS, createPluginDiagnostics, createPluginFaultBoundary, describePluginError, runPluginTask } from './host/faults.js';
import { isAbortError } from './host/faults.js';
import { createContributionContext } from './host/context.js';
import { createPluginExtensionAdapters } from './host/ui-adapters.js';
import { motionEnter, motionFlip, motionLeave } from './11-motion.js';
import { createRequestGate } from './host/requests.js';
import { createGuardedView } from './host/views.js';
import { layerObject, layerValue, lazyFn, registerLayer } from './00-layers.js';
const absoluteFeed = lazyFn('05-transport-transcript-nav', 'absoluteFeed');
const applyModules = lazyFn('05-transport-transcript-nav', 'applyModules');
const applySidebarCustomization = lazyFn('05-transport-transcript-nav', 'applySidebarCustomization');
const asrModelName = lazyFn('05-transport-transcript-nav', 'asrModelName');
const bindModuleSwitches = lazyFn('05-transport-transcript-nav', 'bindModuleSwitches');
const catalogLatest = lazyFn('05-transport-transcript-nav', 'catalogLatest');
const cleanFeedTitle = lazyFn('05-transport-transcript-nav', 'cleanFeedTitle');
const cleanWord = lazyFn('05-transport-transcript-nav', 'cleanWord');
const closeDockSheet = lazyFn('05-transport-transcript-nav', 'closeDockSheet');
const closeWordPanel = lazyFn('05-transport-transcript-nav', 'closeWordPanel');
const copyPlain = lazyFn('05-transport-transcript-nav', 'copyPlain');
const downloadInfo = lazyFn('05-transport-transcript-nav', 'downloadInfo');
const downloadsHTML = lazyFn('05-transport-transcript-nav', 'downloadsHTML');
const episodesOf = lazyFn('05-transport-transcript-nav', 'episodesOf');
const fmtBytes = lazyFn('05-transport-transcript-nav', 'fmtBytes');
const inboxCount = lazyFn('05-transport-transcript-nav', 'inboxCount');
const isSubscribed = lazyFn('05-transport-transcript-nav', 'isSubscribed');
const localAsrModelId = lazyFn('05-transport-transcript-nav', 'localAsrModelId');
const moduleOn = lazyFn('05-transport-transcript-nav', 'moduleOn');
const navigate = lazyFn('05-transport-transcript-nav', 'navigate');
const offlineEntries = lazyFn('05-transport-transcript-nav', 'offlineEntries');
const offlineKeyFor = lazyFn('05-transport-transcript-nav', 'offlineKeyFor');
const parseRoute = lazyFn('05-transport-transcript-nav', 'parseRoute');
const readAllProgress = lazyFn('05-transport-transcript-nav', 'readAllProgress');
const readJSON = lazyFn('05-transport-transcript-nav', 'readJSON');
const refreshShows = lazyFn('05-transport-transcript-nav', 'refreshShows');
const seekBy = lazyFn('05-transport-transcript-nav', 'seekBy');
const showByKey = lazyFn('05-transport-transcript-nav', 'showByKey');
const syncDockBadge = lazyFn('05-transport-transcript-nav', 'syncDockBadge');
const syncDockSleep = lazyFn('05-transport-transcript-nav', 'syncDockSleep');
const syncRateSeg = lazyFn('05-transport-transcript-nav', 'syncRateSeg');
const writeJSON = lazyFn('05-transport-transcript-nav', 'writeJSON');
/* 插件看到的播放接口与 UI / 系统媒体键是同一个入口（14-transport）。 */
const transportPlay = lazyFn('14-transport', 'play');
const transportPause = lazyFn('14-transport', 'pause');
const transportToggle = lazyFn('14-transport', 'toggle');
const transportRate = lazyFn('14-transport', 'rate');
const coverHTML = lazyFn('06-catalog-feeds-search', 'coverHTML');
const ensureShowFeed = lazyFn('06-catalog-feeds-search', 'ensureShowFeed');
const exportSubtitle = lazyFn('06-catalog-feeds-search', 'exportSubtitle');
const fetchFeedText = lazyFn('06-catalog-feeds-search', 'fetchFeedText');
const hasFreshFeed = lazyFn('06-catalog-feeds-search', 'hasFreshFeed');
const loadCatalog = lazyFn('06-catalog-feeds-search', 'loadCatalog');
const loadLocalState = lazyFn('06-catalog-feeds-search', 'loadLocalState');
const memoryFeed = lazyFn('06-catalog-feeds-search', 'memoryFeed');
const mergeCatalog = lazyFn('06-catalog-feeds-search', 'mergeCatalog');
const rememberFeed = lazyFn('06-catalog-feeds-search', 'rememberFeed');
const TR = lazyFn('07-routes-pages', 'TR');
const applyRoute = lazyFn('07-routes-pages', 'applyRoute');
const episodeRowHTML = lazyFn('07-routes-pages', 'episodeRowHTML');
const podCardHTML = lazyFn('07-routes-pages', 'podCardHTML');
const renderPage = lazyFn('07-routes-pages', 'renderPage');
const syncTranslateSettings = lazyFn('07-routes-pages', 'syncTranslateSettings');
const trBatch = lazyFn('07-routes-pages', 'trBatch');
const trNative = lazyFn('07-routes-pages', 'trNative');
const trNoteError = lazyFn('07-routes-pages', 'trNoteError');
const trPrimeCues = lazyFn('07-routes-pages', 'trPrimeCues');
const trReady = lazyFn('07-routes-pages', 'trReady');
const trSave = lazyFn('07-routes-pages', 'trSave');
const trStatus = lazyFn('07-routes-pages', 'trStatus');
const applyStudyEngine = lazyFn('08-study-ai', 'applyStudyEngine');
const applyStudyRuntime = lazyFn('08-study-ai', 'applyStudyRuntime');
const bindStudyUI = lazyFn('08-study-ai', 'bindStudyUI');
const closeStudySheet = lazyFn('08-study-ai', 'closeStudySheet');
const openSettingsPane = lazyFn('08-study-ai', 'openSettingsPane');
const openStudySheet = lazyFn('08-study-ai', 'openStudySheet');
const LOCAL_KEY = () => layerValue('05-transport-transcript-nav', 'LOCAL_KEY');
const wordCurrentMeaning = () => layerValue('05-transport-transcript-nav', 'wordCurrentMeaning');
const studyAutoPause = () => layerValue('08-study-ai', 'studyAutoPause');
const studyView = () => layerValue('08-study-ai', 'studyView');
const studyVocab = () => layerValue('08-study-ai', 'studyVocab');
const setStudyAutoPause = lazyFn('08-study-ai', 'setStudyAutoPause');
const setStudyView = lazyFn('08-study-ai', 'setStudyView');
const studyDueItems = lazyFn('08-study-ai', 'studyDueItems');
const studyOpenEpisodeSummary = lazyFn('08-study-ai', 'studyOpenEpisodeSummary');
const syncStudySettings = lazyFn('08-study-ai', 'syncStudySettings');
const syncThemeSwatches = lazyFn('08-study-ai', 'syncThemeSwatches');
const bindLedgerUI = lazyFn('09-player-integration', 'bindLedgerUI');
const syncMiniCaption = lazyFn('09-player-integration', 'syncMiniCaption');
const syncReaderTop = lazyFn('09-player-integration', 'syncReaderTop');
const bindShell = lazyFn('10-desktop-bridge-tail', 'bindShell');
const playEpisode = lazyFn('10-desktop-bridge-tail', 'playEpisode');
const startAutoRefresh = lazyFn('10-desktop-bridge-tail', 'startAutoRefresh');
const THEME_NAMES = layerObject('05-transport-transcript-nav', 'THEME_NAMES');
const app = layerObject('05-transport-transcript-nav', 'app');
const TR_CACHE = layerObject('07-routes-pages', 'TR_CACHE');
const STUDY = layerObject('08-study-ai', 'STUDY');
const studyCache = layerObject('08-study-ai', 'studyCache');
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
    if (idx >= 0) { app.local[idx].transcript = item.transcript; writeJSON(LOCAL_KEY(), app.local); }
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
  motionEnter(pop);
  pop.innerHTML = '<div class="cue-clip-head"><span>精听刚才 · 最近 ' + Math.round(span) + ' 秒 · ' +
    esc(asrModelName(localAsrModelId())) + '</span><button type="button" data-clip-close title="关闭">×</button></div>' +
    '<div class="cue-clip-text loading">正在准备音频…</div>';
  pop.querySelector('[data-clip-close]').onclick = () => { motionLeave(pop); };
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
  /* 过滤/排序只做位置过渡；首次渲染与后台刷新不触发，因为没有可比对的旧位置。 */
  motionFlip(listBox, '.ep', () => {
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
  });
}

async function loadShow(slug, episodeId, options = {}) {
  const strict = !!options.strict;
  saveProgress(true);
  const show = state.shows.find(s => s.slug === slug || s.key === slug);
  if (!show) return false;
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
    const target = state.episodes.find(ep => ep.id === wanted) || (!strict ? state.episodes[0] : null);
    if (target) { selectEpisode(target, true); return true; }
    box.innerHTML = '<div class="empty">' + (wanted ? '这个本地文件已经不在列表里了。' : '这里还没有本地文件。') + '</div>';
    status(wanted ? '这个本地文件已经不在列表里了。' : '这里还没有本地文件。', 'warn');
    return false;
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
    return true;
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
    return false;
  }
  try {
    let feed = memoryFeed(show);
    if (!feed) {
      const xml = await fetchFeedText(show.feed);
      if (seq !== state.loadSeq) return false;
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
    const exact = episodeId ? state.episodes.find(e => e.id === episodeId) : null;
    const first = exact || (!strict ? ((saved && state.episodes.find(e => e.id === saved)) || state.episodes[0]) : null);
    if (first) { selectEpisode(first, true); return true; }
    if (episodeId && strict) {
      box.innerHTML = '<div class="empty">这一集已经不在节目源里了。</div>';
      status('这一集已经不在节目源里了。', 'warn');
      return false;
    }
    box.innerHTML = '<div class="empty">该节目还没有剧集。</div>';
    status('该节目还没有剧集。', 'warn');
    return false;
  } catch (err) {
    if (seq !== state.loadSeq) return;
    setState('episodes', []);
    renderList();
    box.innerHTML = '<div class="empty"><b>读取 feed 失败</b>' + esc(err.message) + '</div>';
    status('读取 feed 失败：' + err.message, 'warn');
    return false;
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
  [...set].reverse().forEach(fn => { PLUGIN_FAULTS.invoke(String(id), 'cleanup', fn); });
  set.clear();
}
let pluginApiReady = false;
const PLUGIN_DIAGNOSTICS = createPluginDiagnostics({ limit: 20 });
const PLUGIN_FAULTS = createPluginFaultBoundary({ reportError: pluginReportError });

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
    const requires = Array.isArray(plugin.requires)
      ? plugin.requires.map(req => [req, '*'])
      : Object.entries(plugin.requires && typeof plugin.requires === 'object' ? plugin.requires : {});
    return requires.every(([req, range]) => {
      const dep = (list || []).find(p => p && p.id === String(req));
      if (!dep) return false;
      if (!PluginHost.available(req, list, new Set(path))) return false;
      return !dep.version || satisfies(dep.version, String(range || '*'));
    });
  },
  missingRequires(plugin, list) {
    const requires = Array.isArray(plugin?.requires)
      ? plugin.requires
      : Object.keys(plugin?.requires && typeof plugin.requires === 'object' ? plugin.requires : {});
    return requires.filter(req => !PluginHost.available(req, list));
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
  registerKernel(ownerId, name, impl) {
    if (!name || !impl) throw new Error('registerKernel 需要名称和实现');
    const key = String(name), owner = String(ownerId || '');
    const hit = PluginHost.kernels.get(key);
    if (hit && hit.owner && owner && hit.owner !== owner) {
      throw new Error('内核 ' + key + ' 已由插件 ' + hit.owner + ' 注册，先停用对方再接管');
    }
    PluginHost.kernels.set(key, { owner, impl });
    if (owner) {
      // 停用/软重载时只摘掉自己这一层；同名内核已被别人接走就不动。
      trackPlugin(owner, () => {
        const cur = PluginHost.kernels.get(key);
        if (cur && cur.impl === impl) PluginHost.kernels.delete(key);
      });
    }
    return true;
  },
  kernel(name) {
    const hit = PluginHost.kernels.get(String(name));
    return hit ? hit.impl : null;
  },
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

/* ---------- 宿主 v2：声明式贡献点 ---------- */
const HOST_V2 = createContributionRegistry();
const HOST_V2_PAGES = new Map();
let HOST_V2_PAGE_ACTIVE = null;
/* 官方功能域插件暂时复用宿主的 UI 视图助手；这些是只读视图服务，不是内核表。
   ctx.ui 只保留纯展示原语，状态与动作按域拆到 catalog / progress / downloads / settings。
   真正的窄运行时 API 由 ctx.player / ctx.events / ctx.storage / ctx.navigate 提供。 */
function v2UiKit() {
  return Object.freeze({
    $, esc, fmt, emptyLine, statHTML, coverHTML, episodeRowHTML, podCardHTML,
  });
}
function v2CatalogKit() {
  return Object.freeze({
    subs: () => app.subs,
    show: key => showByKey(String(key)),
    episodes: show => episodesOf(show),
    builtinShows: () => app.builtinShows,
    bookmarks: () => app.bookmarks,
    latest: show => catalogLatest(show),
    isSubscribed: key => isSubscribed(key),
    absoluteFeed: feed => absoluteFeed(feed),
  });
}
function v2ProgressKit() {
  return Object.freeze({ all: () => readAllProgress() });
}
function v2DownloadsKit() {
  return Object.freeze({
    entries: () => offlineEntries(),
    html: (entries, query) => downloadsHTML(entries, query),
    info: rec => downloadInfo(rec),
    fmtBytes: n => fmtBytes(n),
  });
}
function v2SettingsKit() {
  return Object.freeze({
    prefs, reader,
    moduleOn: name => moduleOn(name),
    auto: () => app.auto,
    cont: () => app.cont,
    themeNames: () => THEME_NAMES,
    inboxCount: () => inboxCount(),
    syncCustomThemeEditor, refreshPluginSettings, syncRateSeg, syncDockBadge,
    syncDockSleep, syncStudySettings, syncThemeSwatches, syncTranslateSettings,
    syncLiveLeadSelect,
  });
}
/* 插件调用可以被真取消：每个作用域一个 AbortController，按插件记账。
   停用、切集、新搜索、页面销毁、槽位卸载都会 abort，底层 fetch/等待循环能停就停。 */
const PLUGIN_ABORTS = new Map();   // pluginId -> Set<scope>
function pluginAbortScope(pluginId, label, externalSignal = null) {
  const key = String(pluginId || '');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const scope = {
    label: String(label || ''),
    aborted: false,
    signal: controller ? controller.signal : null,
    abort() {
      if (scope.aborted) return false;
      scope.aborted = true;
      if (controller) { try { controller.abort(); } catch (e) {} }
      const set = PLUGIN_ABORTS.get(key);
      if (set) set.delete(scope);
      return true;
    },
    release() {
      const set = PLUGIN_ABORTS.get(key);
      if (set) set.delete(scope);
    },
  };
  if (!PLUGIN_ABORTS.has(key)) PLUGIN_ABORTS.set(key, new Set());
  PLUGIN_ABORTS.get(key).add(scope);
  if (externalSignal) {
    if (externalSignal.aborted) scope.abort();
    else if (typeof externalSignal.addEventListener === 'function') {
      externalSignal.addEventListener('abort', () => scope.abort(), { once: true });
    }
  }
  return scope;
}
function abortPluginScopes(pluginId) {
  const key = String(pluginId || '');
  const set = PLUGIN_ABORTS.get(key);
  if (!set) return 0;
  const scopes = [...set];
  scopes.forEach(scope => scope.abort());
  PLUGIN_ABORTS.delete(key);
  return scopes.length;
}
const V2_KIT_FACTORIES = {
  ui: v2UiKit,
  catalog: v2CatalogKit,
  progress: v2ProgressKit,
  downloads: v2DownloadsKit,
  settings: v2SettingsKit,
};
function v2CapabilityFacade(id) {
  return name => Object.freeze({
    owner: () => PluginHost.owner(String(name)),
    active: () => PluginHost.owner(String(name)) === id,
  });
}
function pluginDeclaredApiVersion(id) {
  const source = pluginManifestFor(id);
  // 缺省按 2.0：没写 apiVersion 的旧插件不能因为宿主升级就突然拿到窄上下文。
  return (source && source.apiVersion) || '2.0';
}
/* 2.2 起按贡献类型只挂需要的组；2.0/2.1 插件走 context.js 里的完整兼容档案。 */
function v2Context(pluginId, type, options = {}) {
  const id = String(pluginId || '');
  const contributionType = String(type || 'pages');
  const apiVersion = options.apiVersion || pluginDeclaredApiVersion(id);
  return createContributionContext({
    type: contributionType,
    id,
    apiVersion,
    api: pluginApiFor(id),
    kits: V2_KIT_FACTORIES,
    capability: v2CapabilityFacade(id),
    signal: options.signal || null,
    payloadVersion: options.payloadVersion,
  });
}
function destroyV2Page() {
  if (!HOST_V2_PAGE_ACTIVE) return;
  const rec = HOST_V2_PAGE_ACTIVE;
  HOST_V2_PAGE_ACTIVE = null;
  if (typeof rec.destroy === 'function') {
    guardedPluginCall(rec.pluginId, 'page:destroy', () => rec.destroy());
  }
  if (rec.scope) rec.scope.abort();
  rec.scope = null;
}
function renderV2Page(page) {
  const rec = HOST_V2_PAGES.get(String(page));
  if (!rec) return false;
  if (HOST_V2_PAGE_ACTIVE && HOST_V2_PAGE_ACTIVE !== rec) destroyV2Page();
  HOST_V2_PAGE_ACTIVE = rec;
  const el = document.getElementById('page-' + page) || document.body;
  if (rec.scope) rec.scope.abort();
  rec.scope = pluginAbortScope(rec.pluginId, 'page:' + page);
  try {
    const result = rec.render(el, v2Context(rec.pluginId, 'pages', { signal: rec.scope.signal }));
    watchPluginPromise(rec.pluginId, 'page:' + page, result, () => {
      if (el) el.innerHTML = '<div class="empty">插件页面出错，已隔离该插件。</div>';
    });
    return true;
  } catch (err) {
    pluginReportError(rec.pluginId, err, 'page:' + page);
    return false;
  }
}

/* ---------- 贡献点落地：槽位与设置分区 ----------
   宿主只给锚点元素，插件在 mount(el, ctx, payload) / render(el, ctx) 里自己填。
   页面用 data-plugin-slot="<固定槽位名>" 标锚点，渲染后扫描挂载；
   插件停用、失败或重新加载时按 pluginId 回收，锚点回到空态。 */
const SURFACE_OWNERS = new Map();   // pluginId -> Set<entry>
const SURFACE_ANCHORS = new Map();  // 锚点元素 -> Set<entry>

function detachSurface(entry) {
  const owners = SURFACE_OWNERS.get(entry.pluginId);
  if (owners) owners.delete(entry);
  const anchors = SURFACE_ANCHORS.get(entry.anchor);
  if (anchors) anchors.delete(entry);
  if (entry.impl && typeof entry.impl.unmount === 'function') {
    try {
      // 卸载本身要能跑完：给它一份不带取消信号的上下文，清理完再 abort 在途工作。
      const result = entry.impl.unmount(entry.node, v2Context(entry.pluginId, entry.type || 'slots'));
      watchPluginPromise(entry.pluginId, 'surface:unmount', result);
    } catch (err) {
      pluginReportError(entry.pluginId, err, 'surface:unmount');
    }
  }
  if (entry.scope) entry.scope.abort();
  entry.scope = null;
  if (entry.node && entry.node.parentNode) entry.node.remove();
}

function attachSurface(entry, type, draw, contextOptions = {}) {
  if (!SURFACE_OWNERS.has(entry.pluginId)) SURFACE_OWNERS.set(entry.pluginId, new Set());
  SURFACE_OWNERS.get(entry.pluginId).add(entry);
  if (!SURFACE_ANCHORS.has(entry.anchor)) SURFACE_ANCHORS.set(entry.anchor, new Set());
  SURFACE_ANCHORS.get(entry.anchor).add(entry);
  entry.type = type;
  entry.scope = pluginAbortScope(entry.pluginId, 'surface:' + type + ':' + (entry.node?.dataset?.slot || ''));
  try {
    const result = draw(v2Context(entry.pluginId, type, { signal: entry.scope.signal, ...contextOptions }));
    watchPluginPromise(entry.pluginId, 'surface:mount', result, () => detachSurface(entry));
    return true;
  } catch (err) {
    pluginReportError(entry.pluginId, err, 'surface:mount');
    detachSurface(entry);
    return false;
  }
}

function releaseSurfaces(pluginId) {
  const owners = SURFACE_OWNERS.get(String(pluginId));
  if (!owners) return 0;
  let count = 0;
  [...owners].forEach(entry => { detachSurface(entry); count++; });
  SURFACE_OWNERS.delete(String(pluginId));
  return count;
}

function clearSurfaces() {
  let count = 0;
  [...SURFACE_OWNERS.values()].forEach(set => {
    [...set].forEach(entry => { detachSurface(entry); count++; });
  });
  SURFACE_OWNERS.clear();
  SURFACE_ANCHORS.clear();
  document.querySelectorAll('[data-plugin-slot], [data-plugin-settings]').forEach(el => {
    delete el.dataset.slotReady;
    delete el.dataset.paneReady;
  });
  return count;
}

function slotPayload(anchor) {
  const raw = anchor.dataset.slotPayload;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (err) { return null; }
}
/* 锚点可以声明自己这份 payload 的版本；没写按 1 处理，插件在 ctx.payloadVersion 里读到。 */
function slotPayloadVersion(anchor) {
  const raw = Number(anchor.dataset.slotPayloadVersion);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/* 页面整块重绘后旧锚点会脱离文档；顺手摘掉挂在死锚点上的贡献，避免泄漏。 */
function pruneDetachedSurfaces() {
  [...SURFACE_OWNERS.values()].forEach(set => {
    [...set].forEach(entry => {
      if (entry.anchor && entry.anchor.isConnected === false) detachSurface(entry);
    });
  });
}

function applySlotMounts(root = document) {
  pruneDetachedSurfaces();
  const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
  let count = 0;
  scope.querySelectorAll('[data-plugin-slot]').forEach(anchor => {
    const name = String(anchor.dataset.pluginSlot || '');
    if (!name || anchor.dataset.slotReady === '1') return;
    anchor.dataset.slotReady = '1';
    const payload = slotPayload(anchor);
    const payloadVersion = slotPayloadVersion(anchor);
    HOST_V2.slot(name, payload).forEach(rec => {
      const impl = rec.impl || {};
      if (typeof impl.mount !== 'function') return;
      const node = document.createElement('div');
      node.className = 'plugin-slot-item';
      node.dataset.pluginId = rec.pluginId;
      node.dataset.slot = name;
      anchor.append(node);
      const entry = { pluginId: rec.pluginId, impl, anchor, node };
      if (attachSurface(entry, 'slots', ctx => impl.mount(node, ctx, payload), { payloadVersion })) count++;
    });
  });
  applyPluginExtensions();
  return count;
}

function applySettingsPanes(pane) {
  const name = String(pane || '');
  const paneEl = name ? document.getElementById('pane-' + name) : null;
  if (!paneEl) return 0;
  let anchor = paneEl.querySelector('[data-plugin-settings="' + name + '"]');
  if (!anchor) {
    anchor = document.createElement('div');
    anchor.className = 'plugin-settings';
    anchor.dataset.pluginSettings = name;
    paneEl.append(anchor);
    delete anchor.dataset.paneReady;
  }
  if (anchor.dataset.paneReady === '1') return 0;
  anchor.dataset.paneReady = '1';
  let count = 0;
  HOST_V2.settings(name).forEach(rec => {
    const impl = rec.impl || {};
    if (typeof impl.render !== 'function') return;
    const node = document.createElement('div');
    node.className = 'plugin-settings-pane';
    node.dataset.pluginId = rec.pluginId;
    anchor.append(node);
    const entry = { pluginId: rec.pluginId, impl, anchor, node };
    if (attachSurface(entry, 'settings', ctx => impl.render(node, ctx))) count++;
  });
  applyPluginExtensions();
  return count;
}

/* 插件装卸或重载后重算所有已挂载的贡献；设置页只重算当前激活分区。 */
function refreshSurfaces() {
  clearSurfaces();
  applySlotMounts(document);
  const active = document.querySelector('#settingsMenu button.active');
  if (active) applySettingsPanes(active.dataset.pane);
  applyPluginExtensions();
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
  const typeSheet = $('typeSheet');
  if (typeSheet && typeSheet.classList.contains('on')) closeTypeSheet(false);
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
function pluginReportError(id, err, scope = 'runtime') {
  const msg = describePluginError(err);
  PLUGIN_DIAGNOSTICS.report(id, scope, err);
  app.pluginErrors = app.pluginErrors || new Map();
  app.pluginErrors.set(id, msg);
  console.warn('[plugin ' + id + '][' + scope + ']', err);
}
function pluginDiagnosticsText(id) {
  return PLUGIN_DIAGNOSTICS.text(id);
}
/* 插件事件、渲染和命令都可能返回 Promise；同步异常仍当场处理，
   异步拒绝和超时统一记到诊断，回调负责把当前界面退回安全态。 */
function watchPluginPromise(id, scope, value, onError) {
  return PLUGIN_FAULTS.watch(id, scope, value, onError);
}
function guardedPluginCall(id, scope, fn) {
  return PLUGIN_FAULTS.invoke(id, scope, fn);
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
const PLUGIN_NAV_ICONS = { subtitles: 'i-captions', soundbite: 'i-soundbite', distill: 'i-distill' };
function renderPluginNav() {
  const nav = $('pluginNav');
  const label = $('pluginNavLabel');
  if (!nav) return;
  const pages = [...PLUGIN_PAGES.values()];
  nav.innerHTML = pages.map(page => {
    const icon = PLUGIN_NAV_ICONS[page.pluginId] || 'i-plugin';
    return '<button data-plugin-page="' + esc(pluginPageKey(page.pluginId, page.pageId)) +
      '"><svg class="nav-ico" viewBox="0 0 24 24" aria-hidden="true"><use href="#' + icon + '"/></svg>' +
      esc(page.title) + '</button>';
  }).join('');
  const has = pages.length > 0;
  nav.hidden = !has;
  nav.style.display = has ? '' : 'none';
  if (label) { label.hidden = !has; label.style.display = has ? '' : 'none'; }
}

/* ---------- 四类聚合贡献点：菜单、导入器、搜索源、主题 ----------
   DOM 适配已经在 host/ui-adapters.js；这里只提供 port：
   注册表查询、调用分发、搜索代次、主题前置动作。宿主体不再认识具体 DOM 结构。 */
const PLUGIN_SEARCH_GATE = createRequestGate();

function contributionRecord(type, pluginId, id) {
  return HOST_V2.list(type).find(rec => rec.pluginId === String(pluginId) && rec.id === String(id)) || null;
}
function contributionButton(type, rec, label, extra = '') {
  return '<button class="btn ghost small" data-plugin-contribution="' + esc(type) +
    '" data-plugin-owner="' + esc(rec.pluginId) + '" data-plugin-id="' + esc(rec.id) + '"' + extra + '>' +
    esc(label) + '</button>';
}
function pluginRecordLabel(rec) {
  return String(rec?.entry?.title || rec?.entry?.label || rec?.impl?.name || rec?.impl?.label || rec?.id || '');
}
function disableCustomThemeForPlugin() {
  const cfg = readCustomTheme();
  if (!cfg.enabled) return;
  const next = { ...cfg, enabled: false, updatedAt: Date.now() };
  writeCustomTheme(next);
  applyCustomTheme(next);
  renderCustomThemeGrid();
}
const PLUGIN_EXTENSIONS = createPluginExtensionAdapters({
  document,
  $, esc, loaderHTML, showToast,
  registry: HOST_V2,
  contributionRecord, contributionButton, recordLabel: pluginRecordLabel,
  runContribution: (owner, type, id, method, args, options) =>
    runPluginContribution(owner, type, id, method, args, options),
  searchGate: PLUGIN_SEARCH_GATE,
  storage: localStorage,
  notify: (message, type) => showToast(message, type),
  preparePluginTheme: disableCustomThemeForPlugin,
});
PLUGIN_EXTENSIONS.bindEvents();
async function runPluginContribution(pluginId, type, id, method, args = [], options = {}) {
  const rec = contributionRecord(type, pluginId, id);
  const fn = rec?.impl?.[method];
  if (typeof fn !== 'function') throw new Error(type + ':' + id + ' 没有 ' + method + ' 实现');
  const scope = pluginAbortScope(rec.pluginId, type + ':' + id + ':' + method, options.signal || null);
  try {
    return await PLUGIN_FAULTS.run(rec.pluginId, type + ':' + id,
      signal => fn(v2Context(rec.pluginId, type, { signal }), ...args),
      { signal: scope.signal });
  } finally { scope.release(); }
}
/* 兼容旧调用点：这些名字仍由宿主导出，实际实现都在 adapter 里。 */
function renderPluginMenu() { return PLUGIN_EXTENSIONS.renderMenu(); }
function renderPluginImporters() { return PLUGIN_EXTENSIONS.renderImporters(); }
function renderPluginSearchSources() { return PLUGIN_EXTENSIONS.renderSearchSources(); }
function renderPluginThemes() { return PLUGIN_EXTENSIONS.renderThemes(); }
function applyPluginExtensions() { return PLUGIN_EXTENSIONS.applyAll(); }
function applyPluginTheme(pluginId, id, silent = false) {
  const rec = contributionRecord('themes', pluginId, id);
  return rec ? PLUGIN_EXTENSIONS.applyTheme(rec, silent) : false;
}
function clearPluginTheme() { return PLUGIN_EXTENSIONS.clearTheme(); }
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
    try {
      const result = rec.fn(payload);
      watchPluginPromise(rec.pluginId, 'event:' + event, result);
    } catch (err) { pluginReportError(rec.pluginId, err, 'event:' + event); }
  });
}
function pluginPlayerState() {
  const item = state.current;
  let localPath = (item && item.localPath) || '';
  try {
    const off = app.offline && app.offline.size && state.show
      ? app.offline.get(offlineKeyFor(state.show, item || {}))
      : null;
    if (!localPath && off && off.path) localPath = off.path;
  } catch (e) {}
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
    // 插件要「裁本机这一段」或「只取音轨」时，得拿到真实文件路径；
    // 远程单集这里是空字符串，插件应提示先下载，而不是自己去拉流。
    localPath: localPath,
    kind: item?.video ? 'video' : 'audio',
    videoUrl: item?.videoUrl || '',
  };
}
const PLUGIN_API_VERSION = HOST_API_VERSION;
function assertPluginApi(version) {
  const want = String(version || '');
  if (!apiCompatible(want, PLUGIN_API_VERSION)) {
    throw new Error('插件要求 API ' + want + '，宿主只支持 ' + PLUGIN_API_VERSION);
  }
}
let pluginHostFacadeCache = null;
/* 对外只给能力查询与内核注册，不把 PluginHost 的内部表（kernels / 能力映射）交出去。
   内核注册按插件 id 记账：同一个门面实例只代表一个插件（或宿主自己，owner 为空）。 */
function pluginHostFacade(ownerId) {
  const key = String(ownerId || '');
  if (!pluginHostFacadeCache) pluginHostFacadeCache = new Map();
  if (!pluginHostFacadeCache.has(key)) {
    pluginHostFacadeCache.set(key, Object.freeze({
      can: name => PluginHost.can(name),
      owner: name => PluginHost.owner(name),
      status: id => PluginHost.status(id),
      available: id => PluginHost.available(id),
      registerKernel: (name, impl) => PluginHost.registerKernel(key, name, impl),
      providerOwner: name => coreProviderOwner(name),
    }));
  }
  return pluginHostFacadeCache.get(key);
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
  // 先叫停在途任务，再回收注册物：插件停用后不该还有请求在后台跑。
  abortPluginScopes(key);
  const activeSearch = PLUGIN_SEARCH_GATE.snapshot().key;
  if (activeSearch && activeSearch.startsWith(key + ':')) PLUGIN_SEARCH_GATE.invalidate(activeSearch);
  const def = PLUGIN_REGISTRY.get(key);
  if (def && typeof def.__dispose === 'function') {
    const dispose = def.__dispose;
    def.__dispose = null;
    guardedPluginCall(key, 'dispose', dispose);
  }
  runPluginCleanup(key);
  releasePluginCapabilities(key);
  releaseSurfaces(key);
  PLUGIN_GRANTS.delete(key);
  if (def) def.__started = false;
}
/* setup 中途失败：已注册的页面/事件/CSS/能力必须按停用同样的路径回收。 */
function abortPluginStart(id, definition) {
  const key = String(id);
  abortPluginScopes(key);
  if (definition && typeof definition.__dispose === 'function') {
    const dispose = definition.__dispose;
    definition.__dispose = null;
    guardedPluginCall(key, 'dispose', dispose);
  }
  runPluginCleanup(key);
  releasePluginCapabilities(key);
  releaseSurfaces(key);
  PLUGIN_GRANTS.delete(key);
  if (definition) { definition.__started = false; definition.__dispose = null; }
}
function captionInvoke(command, args) {
  const T = tauriHost();
  if (!T || !T.core || typeof T.core.invoke !== 'function') {
    return Promise.reject(new Error('当前壳没有桌面字幕能力'));
  }
  return T.core.invoke(command, args || {});
}
/* 本机媒体处理只存在于桌面壳：网页版没有 invoke，直接拒绝而不是静默返回空数据，
   免得插件把「失败」当成「这个文件没音轨」。 */
function mediaInvoke(command, args) {
  const T = tauriHost();
  if (!T || !T.core || typeof T.core.invoke !== 'function') {
    return Promise.reject(new Error('当前壳没有本机媒体能力（网页版不支持裁片段）'));
  }
  return T.core.invoke(command, args || {});
}
/* LLM 服务：配置只有一份，在「设置 → AI 学英语」里填（provider / key / model / endpoint），
   存在 study 插件的引擎设置里。这里读过来复用，不另开一套配置，免得用户填两次 Key。
   插件只拿到「够不够用 + 模型名」，拿不到 Key 原文。 */
function llmSettings() {
  try {
    const engine = studyEngine();
    if (engine && engine.settings) return engine.settings;
  } catch (e) {}
  // 学习插件停用时没有 engine，但「设置 → AI 学英语」里的 Key 仍然有效；
  // 本集问答只借这份配置，不应该因为学习面板被关掉就判定未配置。
  try {
    const raw = localStorage.getItem('myt-study');
    const saved = raw ? JSON.parse(raw) : null;
    if (saved && typeof saved === 'object' && Object.keys(saved).length) return saved;
  } catch (e) {}
  return null;
}
function llmReady() {
  const s = llmSettings();
  if (!s) return false;
  if (!(tauriHost() && tauriHost().core)) return false;
  return !!String(s.key || '').trim() && !!String(s.model || '').trim() &&
    (s.provider !== 'custom' || !!String(s.endpoint || '').trim());
}
function llmConfigSummary() {
  const s = llmSettings() || {};
  return {
    provider: s.provider || '',
    model: s.model || '',
    endpoint: s.endpoint || '',
    configured: llmReady(),
    // 只回末四位，和别处「密钥只露末4位」的口径一致。
    keyHint: String(s.key || '').trim() ? String(s.key).slice(-4) : '',
  };
}
async function llmChat(system, user) {
  if (!llmReady()) {
    throw new Error('还没配置 AI：先在「设置 → AI 学英语」里填 Key 与模型（问答复用同一份配置）。');
  }
  const s = llmSettings() || {};
  return tauriHost().core.invoke('llm_chat', {
    req: {
      config: { engine: s.provider || 'openai', endpoint: s.endpoint, key: s.key, model: s.model, target: s.target },
      system: String(system || ''),
      user: String(user || ''),
    },
  });
}
function pluginApiFor(id) {
  const storagePrefix = 'myt-plugin:' + id + ':';
  // 每个能力组只在方法调用时校验一次，属性读取（比如 api.player.state）不受影响。
  const only = (perm, group) => new Proxy(group, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      return (...args) => { pluginRequire(id, perm); return value.apply(target, args); };
    },
  });
  return {
    id,
    version: PLUGIN_API_VERSION,
    apiVersion: PLUGIN_API_VERSION,
    host: pluginHostFacade(id),
    toast: (message, type) => showToast(String(message || ''), type === 'warn' ? 5000 : 3000),
    navigate: (page, args = [], params = {}) => navigate(page, args, params),
    openSettings: (pane = 'study', options = {}) => {
      navigate('settings');
      setTimeout(() => openSettingsPane(pane, options), 0);
    },
    openEpisode: (showKey, episodeId) => {
      pluginRequire(id, 'player');
      return playEpisode(showKey, episodeId);
    },
    el: elementId => $(elementId),
    page: (pageId, opts) => registerPluginPage(id, pageId, opts),
    on: (event, fn) => addPluginListener(id, event, fn),
    command: (name, fn) => {
      const key = id + ':' + name;
      PLUGIN_COMMANDS.set(key, fn);
      trackPlugin(id, () => PLUGIN_COMMANDS.delete(key));
    },
    registerProvider: (name, impl) => {
      pluginRequire(id, 'providers');
      registerCoreProvider(id, name, impl);
      // 同一插件重复覆盖只保留最后一次；回收时统一回退默认实现。
      trackPlugin(id, () => releaseCoreProviders(id));
      return true;
    },
    providers: () => Object.freeze(Object.fromEntries(
      CORE_PROVIDER_NAMES.map(name => [name, coreProvider(name).owner || 'default'])),
    ),
    cues: () => cuesSnapshot(),
    player: only('player', {
      state: pluginPlayerState,
      play: () => transportPlay(),
      pause: () => transportPause(),
      toggle: () => transportToggle(),
      seek: seconds => seekTo(Math.max(0, Number(seconds) || 0)),
      seekBy: delta => seekBy(Number(delta) || 0),
      setRate: rate => transportRate(rate),
    }),
    /* 本机媒体：只写 clips/ 目录，不给插件任意写盘能力。
       cut 的返回值带 path / bytes / durationMs，插件拿去做分享卡或下载提示。 */
    media: only('media', {
      available: () => !!(tauriHost() && tauriHost().core && typeof tauriHost().core.invoke === 'function'),
      probe: path => mediaInvoke('media_probe', { path: String(path || '') }),
      cut: (path, startMs, endMs) => mediaInvoke('media_cut', {
        path: String(path || ''),
        startMs: Math.max(0, Number(startMs) || 0),
        endMs: Math.max(0, Number(endMs) || 0),
      }),
      extractAudio: path => mediaInvoke('media_extract_audio', { path: String(path || '') }),
    }),
    /* AI 问答：不是通用代理入口，只暴露 chat / ready / config 三件事。 */
    llm: only('llm', {
      ready: () => llmReady(),
      config: () => llmConfigSummary(),
      chat: (system, user) => llmChat(system, user),
    }),
    subtitles: only('subtitles', {
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
        const live = subtitleLive();
        if (live && typeof live.toggle === 'function') return await live.toggle();
        return false;
      },
      liveEngine: {
        enable: () => liveEnable(),
        disable: hint => liveDisable(hint),
        follow: resume => liveFollowCurrentEpisode(resume),
        status: () => ({ on: !!LIVE.on, busy: !!LIVE.busy, mode: LIVE.mode }),
      },
      registerLive: impl => registerSubtitleLive(id, impl),
      live: () => subtitleLive(),
      captions: {
        available: () => !!(tauriHost() && tauriHost().core && typeof tauriHost().core.invoke === 'function'),
        start: pid => captionInvoke(pid ? 'captions_start_process' : 'captions_start', pid ? { pid } : {}),
        stop: () => captionInvoke('captions_stop', {}),
        active: () => captionInvoke('captions_active', {}),
        list: () => captionInvoke('captions_list_sessions', {}),
        picker: () => captionInvoke('captions_open_picker', {}),
        setLookup: on => captionInvoke('captions_set_lookup', { on: !!on }),
        setZh: on => captionInvoke('captions_set_zh', { on: !!on }),
        setCommit: on => captionInvoke('captions_set_commit', { on: !!on }),
        setDrag: on => captionInvoke('captions_set_drag', { on: !!on }),
        setOpacity: alpha => captionInvoke('captions_set_opacity', { alpha: Number(alpha) || 0.9 }),
      },
      clipNow: span => clipNow(Number(span) || 15),
      exportSubtitle: kind => exportSubtitle(kind || 'txt'),
    }),
    study: only('study', {
      claim: () => PluginHost.claim(id, 'study'),
      active: () => PluginHost.owner('study') === id,
      cleanWord: raw => cleanWord(raw),
      registerEngine: impl => registerStudyEngine(id, impl),
      engine: () => studyEngine(),
      registerRuntime: impl => registerStudyRuntime(id, impl),
      runtime: () => studyRuntime(),
      registerUi: impl => registerStudyUi(id, impl),
      ui: () => studyUi(),
      runHook: (name, ...args) => runStudyUiHook(name, ...args),
      host: () => studyHostBridge(),
      status: () => ({
        owner: app.studyOwner,
        subtitles: subtitlePluginOn(),
        vocab: studyVocab().length,
        due: studyDueItems().length,
        cache: Object.keys(studyCache).length,
        provider: STUDY.provider,
        configured: !!(STUDY.key && STUDY.model),
        view: studyView(),
        episode: pluginPlayerState(),
      }),
      open: view => openStudySheet(view),
      close: () => closeStudySheet(),
      openEpisode: (showKey, episodeId) => studyOpenEpisodeSummary(showKey, episodeId),
      openSettings: () => {
        navigate('settings');
        setTimeout(() => openSettingsPane('study'), 0);
      },
    }),
    storage: only('storage', {
      get: (key, fallback = null) => readJSON(storagePrefix + key, fallback),
      set: (key, value) => writeJSON(storagePrefix + key, value),
      remove: key => { try { localStorage.removeItem(storagePrefix + key); } catch (e) {} },
    }),
  };
}
/* 学习实现的宿主侧接缝：内置 study 插件注册引擎后，数据/设置/复习算法由插件持有，
   宿主只保留渲染与播放控制。没有引擎时宿主用本地回退，保证网页版与旧安装仍可用。 */
let STUDY_ENGINE = null;
let STUDY_ENGINE_OWNER = '';
let STUDY_RUNTIME = null;
let SUBTITLE_LIVE = null;
let SUBTITLE_LIVE_OWNER = '';
function registerSubtitleLive(pluginId, impl) {
  const owner = String(pluginId || '');
  if (SUBTITLE_LIVE_OWNER && SUBTITLE_LIVE_OWNER !== owner) {
    throw new Error('实时字幕控制器已由插件 ' + SUBTITLE_LIVE_OWNER + ' 注册');
  }
  const next = impl || null;
  if (SUBTITLE_LIVE && SUBTITLE_LIVE_OWNER === owner && SUBTITLE_LIVE !== next) {
    try { if (typeof SUBTITLE_LIVE.dispose === 'function') SUBTITLE_LIVE.dispose(); } catch (e) {}
    SUBTITLE_LIVE = null;
    SUBTITLE_LIVE_OWNER = '';
  }
  SUBTITLE_LIVE = next;
  SUBTITLE_LIVE_OWNER = owner;
  trackPlugin(owner, () => {
    if (SUBTITLE_LIVE_OWNER !== owner) return;
    try { if (typeof SUBTITLE_LIVE.dispose === 'function') SUBTITLE_LIVE.dispose(); } catch (e) {}
    SUBTITLE_LIVE = null;
    SUBTITLE_LIVE_OWNER = '';
  });
  return true;
}
function subtitleLive() { return SUBTITLE_LIVE; }

let STUDY_RUNTIME_OWNER = '';
let STUDY_UI = null;
let STUDY_UI_OWNER = '';
const STUDY_UI_HOOKS = new Map();
/* 桌面壳对学习渲染的扩展（磁盘缓存徽标、前情、时间线、盲听入口、学习计划）
   通过 hook 挂到插件渲染之后，不再赋值覆盖全局渲染函数。 */
function registerStudyUiHook(name, fn) {
  if (typeof fn === 'function') STUDY_UI_HOOKS.set(String(name), fn);
}
function runStudyUiHook(name, ...args) {
  const fn = STUDY_UI_HOOKS.get(String(name));
  return fn ? fn(...args) : args[0];
}
function disposeStudyUi(impl) {
  if (!impl || typeof impl.disposeStudyUI !== 'function') return;
  try { impl.disposeStudyUI(); } catch (err) { console.warn('[study ui dispose]', err); }
}
function registerStudyUi(pluginId, impl) {
  const owner = String(pluginId || '');
  if (STUDY_UI_OWNER && STUDY_UI_OWNER !== owner) throw new Error('学习界面已由插件 ' + STUDY_UI_OWNER + ' 注册');
  const next = impl || null;
  if (STUDY_UI && STUDY_UI_OWNER === owner && STUDY_UI !== next) {
    disposeStudyUi(STUDY_UI);
    STUDY_UI = null;
    STUDY_UI_OWNER = '';
  }
  if (next && typeof next.bindStudyUI === 'function') {
    try {
      next.bindStudyUI();
    } catch (err) {
      // 绑定失败不能留下一个半初始化的界面实现；按停用同路径撤销已挂的监听。
      disposeStudyUi(next);
      STUDY_UI = null;
      STUDY_UI_OWNER = '';
      throw err;
    }
  }
  STUDY_UI = next;
  STUDY_UI_OWNER = owner;
  trackPlugin(owner, () => {
    if (STUDY_UI_OWNER !== owner) return;
    disposeStudyUi(STUDY_UI);
    STUDY_UI = null;
    STUDY_UI_OWNER = '';
  });
  return true;
}
function studyUi() { return STUDY_UI; }
function registerStudyRuntime(pluginId, impl) {
  const owner = String(pluginId || '');
  if (STUDY_RUNTIME_OWNER && STUDY_RUNTIME_OWNER !== owner) {
    throw new Error('学习运行时已由插件 ' + STUDY_RUNTIME_OWNER + ' 注册');
  }
  STUDY_RUNTIME = impl || null;
  STUDY_RUNTIME_OWNER = owner;
  if (typeof applyStudyRuntime === 'function') applyStudyRuntime(STUDY_RUNTIME);
  trackPlugin(owner, () => {
    if (STUDY_RUNTIME_OWNER !== owner) return;
    STUDY_RUNTIME = null;
    STUDY_RUNTIME_OWNER = '';
    if (typeof applyStudyRuntime === 'function') applyStudyRuntime(null);
  });
  return true;
}
function studyRuntime() { return STUDY_RUNTIME; }
const STUDY_STATE_VIEW = createGuardedView(() => state, {
  read: ['current', 'show', 'cues', 'nodes', 'activeCue', 'offset'],
  label: '播放器状态',
});
const STUDY_AUDIO_VIEW = createGuardedView(() => audio, {
  read: ['paused', 'currentTime', 'duration', 'playbackRate', 'play', 'pause', 'addEventListener', 'removeEventListener'],
  write: ['currentTime', 'playbackRate', 'volume', 'muted'],
  label: '播放器音频',
});
const STUDY_TR_VIEW = createGuardedView(() => TR, {
  read: ['on', 'engine', 'target', 'endpoint', 'key', 'region', 'model'],
  write: ['on', 'engine', 'target', 'endpoint', 'key', 'region', 'model'],
  label: '翻译设置',
});
const STUDY_TR_CACHE_VIEW = createGuardedView(() => TR_CACHE, {
  read: ['clear', 'size'],
  label: '翻译缓存',
});
const STUDY_READER_VIEW = createGuardedView(() => reader, {
  read: ['lang'],
  write: ['lang'],
  label: '阅读设置',
});
function studyStateView() { return STUDY_STATE_VIEW; }
function studyAudioView() { return STUDY_AUDIO_VIEW; }
function studyTranslateView() { return STUDY_TR_VIEW; }
function studyTranslateCacheView() { return STUDY_TR_CACHE_VIEW; }
function studyReaderView() { return STUDY_READER_VIEW; }
function studyHostBridge() {
  return {
    player: {
      get state() { return studyStateView(); },
      get audio() { return studyAudioView(); },
      seekTo: at => seekTo(at),
      getAutoPause: () => studyAutoPause(),
      setAutoPause: setStudyAutoPause,
      setView: setStudyView,
      setAutoplay: value => { app.autoplay = !!value; },
    },
    ui: {
      toast: (text, ms) => showToast(text, ms),
      navigate: (page, args, params) => navigate(page, args, params),
      openSettingsPane: pane => openSettingsPane(pane),
      closeDockSheet: (restore = true) => closeDockSheet(restore),
      applySidebarCustomization: () => applySidebarCustomization(),
      esc: text => esc(text),
      fmt: value => fmt(value),
      cleanWord: raw => cleanWord(raw),
      copyPlain: text => copyPlain(text),
    },
    catalog: {
      showByKey: key => showByKey(key),
      episodesOf: show => episodesOf(show),
      moduleOn: name => moduleOn(name),
      studyPluginOn: () => studyPluginOn(),
      subtitlePluginOn: () => subtitlePluginOn(),
    },
    translate: {
      get TR() { return studyTranslateView(); },
      get TR_CACHE() { return studyTranslateCacheView(); },
      get reader() { return studyReaderView(); },
      save: () => trSave(),
      status: (text, bad) => trStatus(text, bad),
      ready: () => trReady(),
      native: () => trNative(),
      primeCues: ci => trPrimeCues(ci),
      batch: texts => trBatch(texts),
      noteError: err => trNoteError(err),
      sync: () => syncTranslateSettings(),
      rebuildCues: () => rebuildCues(),
      applyReader: () => applyReader(),
    },
    support: {
      wordCurrentMeaning: () => wordCurrentMeaning(),
      sanitizeAdRanges: (ranges, fallbackSource) => sanitizeAdRanges(ranges, fallbackSource),
      mergeAdRanges: lists => mergeAdRanges(lists),
      adRangesFromData: data => studyAdRangesFromData(data),
      applyAiAdRanges: (data, epId) => studyApplyAiAdRanges(data, epId),
      normText: text => studyNormText(text),
    },
    shell: { tauriHost: () => tauriHost() },
  };
}
function registerStudyEngine(pluginId, impl) {
  const owner = String(pluginId || '');
  if (STUDY_ENGINE_OWNER && STUDY_ENGINE_OWNER !== owner) {
    throw new Error('学习引擎已由插件 ' + STUDY_ENGINE_OWNER + ' 注册');
  }
  STUDY_ENGINE = impl || null;
  STUDY_ENGINE_OWNER = owner;
  if (typeof applyStudyEngine === 'function') applyStudyEngine(STUDY_ENGINE);
  trackPlugin(owner, () => {
    if (STUDY_ENGINE_OWNER !== owner) return;
    STUDY_ENGINE = null;
    STUDY_ENGINE_OWNER = '';
    if (typeof applyStudyEngine === 'function') applyStudyEngine(null);
  });
  return true;
}
function studyEngine() { return STUDY_ENGINE; }

/* v2 插件的启动：清单贡献点先过注册表，再把页面/能力/provider/命令桥到现有 UI。
   这只是把旧的 UI 入口接到新契约，插件仍然拿窄上下文，不直接摸宿主内部表。 */
function pluginManifestFor(id) {
  return (app.plugins || []).find(plugin => plugin && plugin.id === String(id)) || null;
}
async function startV2Plugin(id, definition) {
  const source = pluginManifestFor(id);
  if (!source) throw new Error('找不到插件清单：' + id);
  const report = validateLegacyManifest(source);
  if (!report.ok) throw new Error('插件清单校验失败：' + report.errors.map(item => item.message).join('；'));
  const manifest = report.manifest;
  const registered = HOST_V2.register(id, manifest, definition.contributions);
  if (!registered.ok) throw new Error(registered.errors.join('；'));
  definition.__dispose = () => { HOST_V2.unregister(id); };
  const pages = manifest.contributions.pages || [];
  pages.forEach(page => {
    const impl = definition.contributions['page:' + page.id];
    if (!impl || typeof impl.render !== 'function') return;
    const native = Boolean(document.getElementById('page-' + page.id));
    if (native) {
      const rec = {
        pluginId: id, id: page.id, render: impl.render,
        destroy: typeof impl.destroy === 'function' ? impl.destroy : null,
      };
      HOST_V2_PAGES.set(page.id, rec);
      trackPlugin(id, () => {
        if (HOST_V2_PAGES.get(page.id) !== rec) return;
        HOST_V2_PAGES.delete(page.id);
        if (HOST_V2_PAGE_ACTIVE === rec) HOST_V2_PAGE_ACTIVE = null;
      });
    } else {
      let pageScope = null;
      registerPluginPage(id, page.id, {
        title: page.title || page.id,
        subtitle: page.subtitle || '',
        render: el => {
          if (pageScope) pageScope.abort();
          pageScope = pluginAbortScope(id, 'page:' + page.id);
          return impl.render(el, v2Context(id, 'pages', { signal: pageScope.signal }));
        },
        destroy: () => {
          if (pageScope) { pageScope.abort(); pageScope = null; }
          if (typeof impl.destroy === 'function') return impl.destroy();
          return undefined;
        },
      });
    }
  });
  for (const cap of (manifest.contributions.capabilities || [])) {
    PluginHost.claim(id, cap.id);
    const impl = definition.contributions['capability:' + cap.id];
    if (impl && typeof impl.claim === 'function') {
      const scope = pluginAbortScope(id, 'capability:' + cap.id);
      try {
        const cleanup = await runPluginTask(signal => impl.claim(v2Context(id, 'capabilities', { signal })), {
          timeoutMs: DEFAULT_PLUGIN_TIMEOUT_MS,
          label: '插件 ' + id + ' 接管能力 ' + cap.id,
          signal: scope.signal,
        });
        if (typeof cleanup === 'function') trackPlugin(id, cleanup);
      } finally { scope.release(); }
    }
  }
  (manifest.contributions.providers || []).forEach(provider => {
    const impl = definition.contributions['provider:' + provider.id];
    if (!impl) return;
    registerCoreProvider(id, provider.id, impl);
    trackPlugin(id, () => releaseCoreProviders(id));
  });
  (manifest.contributions.commands || []).forEach(command => {
    const impl = definition.contributions['command:' + command.id];
    if (!impl || typeof impl.run !== 'function') return;
    const key = id + ':' + command.id;
    PLUGIN_COMMANDS.set(key, impl.run);
    trackPlugin(id, () => PLUGIN_COMMANDS.delete(key));
  });
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
      assertPluginApi(definition.apiVersion);
      PLUGIN_REGISTRY.set(String(id), definition);
    },
    define(id, definition) {
      if (!id || !definition || !definition.contributions || typeof definition.contributions !== 'object') {
        throw new Error('MyTPlugins.define 需要 id 和 contributions');
      }
      assertPluginApi(definition.apiVersion);
      PLUGIN_REGISTRY.set(String(id), { ...definition, __v2: true });
    },
    async start(id) {
      const key = String(id);
      const definition = PLUGIN_REGISTRY.get(key);
      if (!definition) throw new Error('插件没有调用 MyTPlugins.register/define(' + id + ')');
      if (definition.__started) return;
      definition.__started = true;
      const startScope = pluginAbortScope(key, 'setup');
      try {
        if (definition.__v2) await startV2Plugin(key, definition);
        else {
          const ret = await runPluginTask(() => definition.setup(pluginApiFor(key)), {
            timeoutMs: DEFAULT_PLUGIN_TIMEOUT_MS,
            label: '插件 ' + key + ' 初始化',
            signal: startScope.signal,
          });
          if (typeof ret === 'function') definition.__dispose = ret;
        }
      } catch (err) {
        // 初始化失败要和停用一样清理，否则已注册的页面/事件/能力会留在宿主里。
        abortPluginStart(key, definition);
        throw err;
      } finally { startScope.release(); }
    },
    stop(id) { stopPlugin(id); },
    _error(id, err) { pluginReportError(id, err, 'load'); },
    runCommand(pluginId, name) {
      const fn = PLUGIN_COMMANDS.get(String(pluginId) + ':' + String(name));
      if (typeof fn !== 'function') return Promise.resolve(undefined);
      const scope = pluginAbortScope(pluginId, 'command:' + name);
      return runPluginTask(signal => fn(v2Context(pluginId, 'commands', { signal })), {
        timeoutMs: DEFAULT_PLUGIN_TIMEOUT_MS,
        label: '插件 ' + pluginId + ' 命令 ' + name,
        signal: scope.signal,
      }).catch(err => {
        if (!isAbortError(err)) pluginReportError(pluginId, err, 'command:' + name);
        return undefined;
      }).finally(() => scope.release());
    },
  };
}
const PLUGIN_CONSENT_PREFIX = 'myt-plugin-consent:';
const PLUGIN_HASH_PREFIX = 'myt-plugin-hash:';
/* 能力粒度授权：清单声明 permissions 就按声明收窄；没声明（老清单）沿用全权限，
   内置插件始终全权限。权限是宿主 API 层的调用约束，不是安全边界：插件与宿主共用
   同一个 JS 环境，仍可以直接摸 window.fetch / __TAURI__，真正隔离要换进程或独立 WebView。 */
const PLUGIN_PERMISSIONS = {
  'ui.dom': '读写页面内容（节目、字幕、学习数据）',
  net: '发起外部网络请求',
  player: '控制播放（播放 / 暂停 / 跳转 / 倍速 / 打开某集）',
  storage: '读写插件自己的本地存储',
  providers: '接管核心能力（目录 / 播放 / 下载 / 队列）',
  subtitles: '接管字幕功能',
  study: '接管学英语功能',
  media: '本机媒体处理（探测 / 裁片段 / 只取音轨）',
  llm: '调用大模型（复用 AI 学英语里已配置的 Key 与模型）',
};
const PLUGIN_PERMISSION_ALL = Object.keys(PLUGIN_PERMISSIONS);
const PLUGIN_GRANTS = new Map();
const PLUGIN_PERMS_KEY_PREFIX = 'myt-plugin-perms:';
function pluginPermissionSignature(plugin) {
  return [...pluginPermissions(plugin)].sort().join(',');
}
function pluginPermissionChanged(plugin) {
  if (!plugin || plugin.builtin) return false;
  try {
    const saved = localStorage.getItem(PLUGIN_PERMS_KEY_PREFIX + plugin.id) || '';
    return Boolean(saved) && saved !== pluginPermissionSignature(plugin);
  } catch (e) { return false; }
}
function setPluginPermissionSignature(plugin) {
  try { localStorage.setItem(PLUGIN_PERMS_KEY_PREFIX + plugin.id, pluginPermissionSignature(plugin)); } catch (e) {}
}
function pluginPermissions(plugin) {
  if (!plugin) return new Set();
  if (plugin.builtin) return new Set(PLUGIN_PERMISSION_ALL);
  if (!Array.isArray(plugin.permissions)) return new Set(PLUGIN_PERMISSION_ALL);
  const set = new Set(['ui.dom']);
  plugin.permissions.forEach(name => { if (PLUGIN_PERMISSIONS[name]) set.add(name); });
  return set;
}
function pluginRequire(id, name) {
  const granted = PLUGIN_GRANTS.get(String(id)) || new Set(PLUGIN_PERMISSION_ALL);
  if (!granted.has(name)) throw new Error('插件未声明 ' + name + ' 权限，调用被拒绝');
  return true;
}
function pluginPermissionLabels(plugin) {
  const granted = pluginPermissions(plugin);
  return PLUGIN_PERMISSION_ALL.filter(name => granted.has(name))
    .map(name => PLUGIN_PERMISSIONS[name]);
}
/* 外部请求门：没 net 权限时只放行同源、blob/data/asset 这些本地资源。 */
function pluginUrlIsLocal(input) {
  try {
    const url = new URL(typeof input === 'string' ? input : (input && input.url) || '', location.href);
    if (url.origin === location.origin) return true;
    return url.protocol === 'blob:' || url.protocol === 'data:' || url.protocol === 'asset:'
      || url.hostname === 'asset.localhost';
  } catch (e) {
    return true; // 相对路径解析失败交给底层抛错，不当成外泄
  }
}
function guardedFetchFor(id) {
  const allowNet = (PLUGIN_GRANTS.get(String(id)) || new Set()).has('net');
  return function guardedFetch(input, init) {
    if (!allowNet && !pluginUrlIsLocal(input)) {
      return Promise.reject(new Error('插件未声明 net 权限，已阻止外部请求：' + String(input && input.url || input)));
    }
    return window.fetch(input, init);
  };
}
function guardedXhrFor(id) {
  const allowNet = (PLUGIN_GRANTS.get(String(id)) || new Set()).has('net');
  return class GuardedXhr extends window.XMLHttpRequest {
    open(method, url, ...rest) {
      if (!allowNet && !pluginUrlIsLocal(url)) {
        throw new Error('插件未声明 net 权限，已阻止外部请求：' + String(url));
      }
      return super.open(method, url, ...rest);
    }
  };
}
function guardedSocketFor(id) {
  const allowNet = (PLUGIN_GRANTS.get(String(id)) || new Set()).has('net');
  return function GuardedSocket(url, protocols) {
    if (!allowNet) throw new Error('插件未声明 net 权限，不能建立 WebSocket');
    return new window.WebSocket(url, protocols);
  };
}
function guardedEventsourceFor(id) {
  const allowNet = (PLUGIN_GRANTS.get(String(id)) || new Set()).has('net');
  return function GuardedEventSource(url, config) {
    if (!allowNet) throw new Error('插件未声明 net 权限，不能建立 EventSource');
    return new window.EventSource(url, config);
  };
}
window.MyTGuard = {
  fetch: guardedFetchFor,
  xhr: guardedXhrFor,
  ws: guardedSocketFor,
  es: guardedEventsourceFor,
};
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
/* 授权时把插件内容指纹一起钉住：之后文件被改（哪怕只是加一行）都要重新授权。 */
function pluginPinnedHash(id) {
  try { return localStorage.getItem(PLUGIN_HASH_PREFIX + id) || ''; } catch (e) { return ''; }
}
function setPluginPinnedHash(id, hash) {
  try {
    if (hash) localStorage.setItem(PLUGIN_HASH_PREFIX + id, hash);
    else localStorage.removeItem(PLUGIN_HASH_PREFIX + id);
  } catch (e) {}
}
function pluginConsentChanged(plugin) {
  if (!plugin || plugin.builtin || !plugin.hash) return false;
  const pinned = pluginPinnedHash(plugin.id);
  return Boolean(pinned) && pinned !== plugin.hash;
}
function clearPluginConsent(id) {
  try { localStorage.removeItem(PLUGIN_CONSENT_PREFIX + id); } catch (e) {}
  try { localStorage.removeItem(PLUGIN_PERMS_KEY_PREFIX + id); } catch (e) {}
  setPluginPinnedHash(id, '');
}
/* 第三方插件在同一个 WebView 里跑，与页面同权：首次启用必须显式授权。
   用页面内弹层而不是 window.confirm —— wry 默认不实现 JS 对话框。 */
function askPluginConsent(plugin, reason) {
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
      (reason ? '<p style="margin:0 0 12px;color:#e08a7a;">' + esc(reason) + '</p>' : '') +
      '<p style="margin:0 0 12px;color:var(--soft,#ccbfa9);">这个插件不是随应用内置的。启用后它将获得下列权限（其余调用会被宿主拒绝）：</p>' +
      '<ul style="margin:0 0 16px;padding-left:18px;color:var(--soft,#ccbfa9);">' +
      pluginPermissionLabels(plugin).map(text => '<li>' + esc(text) + '</li>').join('') + '</ul>' +
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
    // 旧清单先过 v2 契约的兼容校验：id、路径、权限、依赖字段不合法就拒绝。
    // 注意这里不替换 plugin.requires，旧宿主仍按数组做可用性判断。
    const manifestReport = validateLegacyManifest(plugin);
    if (!manifestReport.ok) {
      pluginReportError(id, '插件清单校验失败：' +
        manifestReport.errors.map(item => item.message).join('；'));
      continue;
    }
    if (plugin.signature === 'bad') {
      pluginReportError(id, '签名校验失败：文件与 plugin.json 里的 signature 不符，已拒绝加载');
      continue;
    }
    if (!plugin.builtin) {
      const consent = pluginConsentState(id);
      if (consent === 'deny') { pluginReportError(id, '未授权：已跳过该插件'); continue; }
      const changed = pluginConsentChanged(plugin);
      const permChanged = pluginPermissionChanged(plugin);
      const pinnedBefore = changed ? pluginPinnedHash(id) : '';
      if (changed) clearPluginConsent(id);
      if (consent !== 'allow' || changed || permChanged) {
        const reason = changed
          ? '插件文件自上次授权后被修改（指纹 ' + pinnedBefore + ' → ' + plugin.hash + '），需要重新确认。'
          : (permChanged ? '插件申请的权限变了（' + pluginPermissionSignature(plugin) + '），需要重新确认。' : '');
        if (!(await askPluginConsent(plugin, reason))) {
          setPluginConsent(id, false);
          pluginReportError(id, '未授权：已跳过该插件');
          continue;
        }
        setPluginConsent(id, true);
        setPluginPinnedHash(id, plugin.hash || '');
        setPluginPermissionSignature(plugin);
      } else if (!pluginPinnedHash(id) && plugin.hash) {
        // 老安装：早先授权时还没记指纹，这次补记，之后就能发现改动。
        setPluginPinnedHash(id, plugin.hash);
        setPluginPermissionSignature(plugin);
      }
    }
    PLUGIN_GRANTS.set(id, pluginPermissions(plugin));
    if (!apiCompatible(plugin.apiVersion, PLUGIN_API_VERSION)) {
      pluginReportError(id, '插件要求 API ' + plugin.apiVersion + '，宿主只支持 ' + PLUGIN_API_VERSION, 'manifest');
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
    const code = '(function(fetch, XMLHttpRequest, WebSocket, EventSource){try{\n' + plugin.js +
      '\n}catch(e){MyTPlugins._error(' + JSON.stringify(id) + ', e);}})' +
      '(MyTGuard.fetch(' + JSON.stringify(id) + '), MyTGuard.xhr(' + JSON.stringify(id) + '), ' +
      'MyTGuard.ws(' + JSON.stringify(id) + '), MyTGuard.es(' + JSON.stringify(id) + '));';
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
      await window.MyTPlugins.start(id);
      app.pluginStartedIds = app.pluginStartedIds || [];
      app.pluginStartedIds.push(id);
    }
    catch (err) { pluginReportError(id, err, 'start'); }
  }
  refreshSurfaces();
}
/* 软重载：按插件回收注册物后重新加载，不刷新整页。 */
async function reloadPlugins() {
  (app.pluginStartedIds || []).forEach(id => stopPlugin(id));
  (app.plugins || []).forEach(plugin => PLUGIN_DIAGNOSTICS.clear(plugin.id));
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
  const previousPage = app.pluginPageActive;
  if (previousPage && previousPage !== def && typeof previousPage.destroy === 'function') {
    guardedPluginCall(previousPage.pluginId, 'page:destroy', () => previousPage.destroy());
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
      watchPluginPromise(def.pluginId, 'page:' + def.pageId, ret, err => {
        body.innerHTML = '<div class="empty">插件页面出错：' + esc(err.message || err) + '</div>';
      });
    } catch (err) {
      pluginReportError(def.pluginId, err, 'page:' + def.pageId);
      body.innerHTML = '<div class="empty">插件页面出错：' + esc(err.message || err) + '</div>';
    }
  }
}
async function refreshPluginSettings() {
  const box = $('pluginList');
  const status = $('pluginStatus');
  if (!box) return;
  if (!host() || typeof host().pluginList !== 'function') {
    box.innerHTML = emptyLine('网页版不加载本地插件；字幕、学习、问答等能力在桌面版可用。');
    if (status) status.textContent = '网页版没有本地插件目录权限。';
    return;
  }
  box.innerHTML = '<div class="smalltext">正在读取插件目录…</div>';
  try {
    const list = await host().pluginList();
    app.plugins = Array.isArray(list) ? list : [];
    if (!app.plugins.length) {
      box.innerHTML = emptyLine('还没有插件。点「导入插件」选择插件文件夹，或把插件目录放进 plugins 文件夹。');
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
      const sig = plugin.builtin ? '内置插件，随应用升级'
        : plugin.signature === 'ok' ? '签名已验证'
          : plugin.signature === 'bad' ? '签名校验失败，已拒绝加载'
            : '未签名（首次启用需授权）';
      const changedNote = pluginConsentChanged(plugin) ? '文件已变更，需重新授权' : '';
      const permNote = plugin.builtin ? '全部权限（内置）'
        : (Array.isArray(plugin.permissions)
          ? (plugin.permissions.length ? '权限：' + plugin.permissions.join('、') : '权限：仅 ui.dom')
          : '权限：全部（老清单未声明）');
      const revoke = plugin.builtin ? ''
        : '<button data-plugin-revoke="' + esc(plugin.id) +
          '" style="margin-left:8px;border:0;background:none;padding:0;cursor:pointer;' +
          'font:11px/1 var(--sans);color:var(--muted);text-decoration:underline">撤销授权</button>';
      const failure = err || (PLUGIN_DIAGNOSTICS.get(plugin.id).length ? app.pluginErrors.get(plugin.id) : '');
      const recovery = failure
        ? '<div style="margin-top:6px;display:flex;gap:8px"><button class="btn ghost small" data-plugin-retry="' +
          esc(plugin.id) + '">重试加载</button><button class="btn ghost small" data-plugin-diagnostics="' +
          esc(plugin.id) + '">复制诊断</button></div>'
        : '';
      return '<div class="ep-row"><div class="ep-body"><span class="ep-title">' + esc(plugin.name || plugin.id) +
        ' <span class="pill dim">' + esc(plugin.id) + '</span></span><span class="ep-sub">' +
        esc([plugin.version ? 'v' + plugin.version : '', plugin.author, plugin.description].filter(Boolean).join(' · ') || '无描述') +
        (consent ? '<br><span class="pill dim">' + esc(consent) + '</span> ' + revoke : '') +
        '<br><span class="pill dim">' + esc(sig) + '</span>' +
        (changedNote ? ' <span style="color:#e08a7a">' + esc(changedNote) + '</span>' : '') +
        (permNote ? '<br><span class="pill dim">' + esc(permNote) + '</span>' : '') +
        (dep ? '<br><span style="color:#e08a7a">' + esc(dep) + '</span>' : '') +
        (err && !dep ? '<br><span style="color:#e08a7a">' + esc(err) + '</span>' : '') +
        recovery + '</span></div>' +
        '<button class="switch" role="switch" aria-checked="' + (plugin.enabled ? 'true' : 'false') +
        '" data-plugin-toggle="' + esc(plugin.id) + '" title="' + (plugin.enabled ? '停用' : '启用') + '"></button></div>';
    }).join('');
    if (status) status.textContent = '共 ' + app.plugins.length + ' 个插件，' +
      app.plugins.filter(p => p.enabled).length + ' 个已启用；改完状态后点「重新加载」生效。';
  } catch (err) {
    box.innerHTML = emptyLine('读取插件失败：' + esc(err.message || err));
  }
}

/* 目录接缝：节目清单从哪来可以被插件替换（比如换成远端索引或本地缓存）。 */
defineCoreProvider('catalog', { loadShows: () => getJson('shows.json', SHELL_TIMEOUT) });
async function initPlayer() {
  const params = new URLSearchParams(location.search);
  try {
    const data = await coreProvider('catalog').loadShows();
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
export { CATALOG_TIMEOUT, HOST_V2, HOST_V2_PAGES, PLUGIN_API_VERSION, PLUGIN_CLEANUP, PLUGIN_COMMANDS, PLUGIN_CONSENT_PREFIX, PLUGIN_GRANTS, PLUGIN_HASH_PREFIX, PLUGIN_HOOKS, PLUGIN_PAGES, PLUGIN_PERMISSIONS, PLUGIN_PERMISSION_ALL, PLUGIN_PERMS_KEY_PREFIX, PLUGIN_REGISTRY, PluginHost, SHELL_TIMEOUT, STUDY_ENGINE, STUDY_ENGINE_OWNER, STUDY_RUNTIME, STUDY_RUNTIME_OWNER, STUDY_UI, STUDY_UI_HOOKS, STUDY_UI_OWNER, abortPluginStart, addPluginListener, applyCspNonce, applyLocalDoc, applyStudyAvailability, applySubtitleAvailability, askPluginConsent, clearPluginConsent, clipListen, clipNow, clipPanelHost, clipRun, clipTargetInfo, cspNonceValue, cuesSnapshot, definitionStarted, destroyV2Page, disposeStudyUi, emitPlugin, ensurePluginApi, guardedEventsourceFor, guardedFetchFor, guardedSocketFor, guardedXhrFor, initPlayer, loadPlugins, loadShow, localAsrAvailable, openLocalTranscript, apiCompatible, pluginApiFor, pluginApiReady, pluginConsentChanged, pluginConsentState, pluginHostFacade, pluginHostFacadeCache, pluginManifestFor, pluginPermissionChanged, pluginPermissionLabels, pluginPermissionSignature, pluginPermissions, pluginPinnedHash, pluginPlayerState, pluginReportError, pluginRequire, pluginUrlIsLocal, refreshCatalogPages, refreshPluginSettings, registerPluginPage, registerStudyEngine, registerStudyRuntime, registerStudyUi, registerStudyUiHook, releasePluginCapabilities, reloadPlugins, renderList, renderPluginNav, renderPluginPage, renderV2Page, runPluginCleanup, runStudyUiHook, setPluginConsent, setPluginPermissionSignature, setPluginPinnedHash, smallArtwork, startLocalTranscribe, startV2Plugin, stopPlugin, studyEngine, studyHostBridge, studyPluginOn, studyRuntime, studyUi, subtitlePluginOn, syncStudySettingsVisibility, syncSubtitleSettingsVisibility, trackPlugin, v2UiKit };
registerLayer('04-local-audio-plugin-host', { CATALOG_TIMEOUT, HOST_V2, HOST_V2_PAGES, PLUGIN_API_VERSION, PLUGIN_CLEANUP, PLUGIN_COMMANDS, PLUGIN_CONSENT_PREFIX, PLUGIN_GRANTS, PLUGIN_HASH_PREFIX, PLUGIN_HOOKS, PLUGIN_PAGES, PLUGIN_PERMISSIONS, PLUGIN_PERMISSION_ALL, PLUGIN_PERMS_KEY_PREFIX, PLUGIN_REGISTRY, PluginHost, SHELL_TIMEOUT, STUDY_ENGINE, STUDY_ENGINE_OWNER, STUDY_RUNTIME, STUDY_RUNTIME_OWNER, STUDY_UI, STUDY_UI_HOOKS, STUDY_UI_OWNER, abortPluginStart, addPluginListener, applyCspNonce, applyLocalDoc, applySettingsPanes, applySlotMounts, applyStudyAvailability, applySubtitleAvailability, askPluginConsent, clearPluginConsent, clipListen, clipNow, clipPanelHost, clipRun, clipTargetInfo, cspNonceValue, cuesSnapshot, definitionStarted, destroyV2Page, disposeStudyUi, emitPlugin, ensurePluginApi, guardedEventsourceFor, guardedFetchFor, guardedSocketFor, guardedXhrFor, initPlayer, loadPlugins, loadShow, localAsrAvailable, openLocalTranscript, apiCompatible, pluginApiFor, pluginApiReady, pluginConsentChanged, pluginConsentState, pluginHostFacade, pluginHostFacadeCache, pluginManifestFor, pluginPermissionChanged, pluginPermissionLabels, pluginPermissionSignature, pluginPermissions, pluginPinnedHash, pluginPlayerState, pluginReportError, pluginRequire, pluginUrlIsLocal, refreshCatalogPages, refreshPluginSettings, refreshSurfaces, registerPluginPage, registerStudyEngine, registerStudyRuntime, registerStudyUi, registerStudyUiHook, releasePluginCapabilities, releaseSurfaces, reloadPlugins, renderList, renderPluginNav, renderPluginPage, renderV2Page, runPluginCleanup, runStudyUiHook, setPluginConsent, setPluginPermissionSignature, setPluginPinnedHash, smallArtwork, startLocalTranscribe, startV2Plugin, stopPlugin, studyEngine, studyHostBridge, studyPluginOn, studyRuntime, studyUi, subtitlePluginOn, syncStudySettingsVisibility, syncSubtitleSettingsVisibility, trackPlugin, v2UiKit });
export { applySettingsPanes, applySlotMounts, refreshSurfaces, releaseSurfaces };
export { PLUGIN_DIAGNOSTICS, applyPluginExtensions, clearPluginTheme, pluginDiagnosticsText, renderPluginImporters, renderPluginMenu, renderPluginSearchSources, renderPluginThemes, runPluginContribution, studyAudioView, studyStateView, studyTranslateCacheView, studyTranslateView };
