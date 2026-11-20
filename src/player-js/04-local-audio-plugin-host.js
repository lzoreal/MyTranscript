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
    if (idx >= 0) { app.local[idx].transcript = item.transcript; writeJSON(LOCAL_KEY, app.local); }
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
  pop.hidden = false;
  pop.innerHTML = '<div class="cue-clip-head"><span>精听刚才 · 最近 ' + Math.round(span) + ' 秒 · ' +
    esc(asrModelName(localAsrModelId())) + '</span><button type="button" data-clip-close title="关闭">×</button></div>' +
    '<div class="cue-clip-text loading">正在准备音频…</div>';
  pop.querySelector('[data-clip-close]').onclick = () => { pop.hidden = true; };
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
}

async function loadShow(slug, episodeId) {
  saveProgress(true);
  const show = state.shows.find(s => s.slug === slug || s.key === slug) || state.shows[0];
  if (!show) return;
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
    const target = state.episodes.find(ep => ep.id === wanted) || state.episodes[0];
    if (target) selectEpisode(target, true);
    return;
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
    return;
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
    return;
  }
  try {
    let feed = memoryFeed(show);
    if (!feed) {
      const xml = await fetchFeedText(show.feed);
      if (seq !== state.loadSeq) return;
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
    const first = (episodeId && state.episodes.find(e => e.id === episodeId))
      || (saved && state.episodes.find(e => e.id === saved))
      || state.episodes[0];
    if (first) selectEpisode(first, true);
    else {
      box.innerHTML = '<div class="empty">该节目还没有剧集。</div>';
      status('该节目还没有剧集。', 'warn');
    }
  } catch (err) {
    if (seq !== state.loadSeq) return;
    setState('episodes', []);
    renderList();
    box.innerHTML = '<div class="empty"><b>读取 feed 失败</b>' + esc(err.message) + '</div>';
    status('读取 feed 失败：' + err.message, 'warn');
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
let pluginApiReady = false;

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
    if (stack.has(key)) return true;
    stack.add(key);
    return (Array.isArray(plugin.requires) ? plugin.requires : []).every(req => PluginHost.available(req, list, stack));
  },
  missingRequires(plugin, list) {
    return (Array.isArray(plugin?.requires) ? plugin.requires : []).filter(req => !PluginHost.available(req, list));
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
  registerKernel(name, impl) {
    if (!name || !impl) throw new Error('registerKernel 需要名称和实现');
    PluginHost.kernels.set(String(name), impl);
    return true;
  },
  kernel(name) { return PluginHost.kernels.get(String(name)) || null; },
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
function pluginReportError(id, err) {
  const msg = err && (err.stack || err.message) ? (err.stack || err.message) : String(err);
  app.pluginErrors = app.pluginErrors || new Map();
  app.pluginErrors.set(id, msg);
  console.warn('[plugin ' + id + ']', err);
}
function registerPluginPage(pluginId, pageId, opts) {
  if (!pluginId || !pageId) throw new Error('页面需要 pluginId 和 pageId');
  PLUGIN_PAGES.set(pluginPageKey(pluginId, pageId), {
    pluginId, pageId,
    title: String(opts?.title || pageId),
    subtitle: String(opts?.subtitle || ''),
    render: typeof opts?.render === 'function' ? opts.render : null,
    destroy: typeof opts?.destroy === 'function' ? opts.destroy : null,
  });
  renderPluginNav();
}
function renderPluginNav() {
  const nav = $('pluginNav');
  const label = $('pluginNavLabel');
  if (!nav) return;
  const pages = [...PLUGIN_PAGES.values()];
  nav.innerHTML = pages.map(page => '<button data-plugin-page="' + esc(pluginPageKey(page.pluginId, page.pageId)) +
    '"><span class="nav-ico">◇</span>' + esc(page.title) + '</button>').join('');
  const has = pages.length > 0;
  nav.hidden = !has;
  nav.style.display = has ? '' : 'none';
  if (label) { label.hidden = !has; label.style.display = has ? '' : 'none'; }
}
function addPluginListener(pluginId, event, fn) {
  if (typeof fn !== 'function') throw new Error('事件回调必须是函数');
  if (!PLUGIN_HOOKS.has(event)) PLUGIN_HOOKS.set(event, new Set());
  const rec = { pluginId, fn };
  PLUGIN_HOOKS.get(event).add(rec);
  return () => { PLUGIN_HOOKS.get(event)?.delete(rec); };
}
function emitPlugin(event, payload) {
  const set = PLUGIN_HOOKS.get(event);
  if (!set || !set.size) return;
  set.forEach(rec => {
    try { rec.fn(payload); }
    catch (err) { pluginReportError(rec.pluginId, err); }
  });
}
function pluginPlayerState() {
  const item = state.current;
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
  };
}
function pluginApiFor(id) {
  const storagePrefix = 'myt-plugin:' + id + ':';
  return {
    id,
    version: '2.0',
    host: PluginHost,
    toast: (message, type) => showToast(String(message || ''), type === 'warn' ? 5000 : 3000),
    navigate: (page, args = [], params = {}) => navigate(page, args, params),
    openEpisode: (showKey, episodeId) => playEpisode(showKey, episodeId),
    el: elementId => $(elementId),
    page: (pageId, opts) => registerPluginPage(id, pageId, opts),
    on: (event, fn) => addPluginListener(id, event, fn),
    command: (name, fn) => { PLUGIN_COMMANDS.set(id + ':' + name, fn); },
    cues: () => state.cues,
    player: {
      state: pluginPlayerState,
      play: () => audio.play().catch(() => {}),
      pause: () => audio.pause(),
      toggle: () => (audio.paused ? audio.play().catch(() => {}) : audio.pause()),
      seek: seconds => seekTo(Math.max(0, Number(seconds) || 0)),
      seekBy: delta => seekBy(Number(delta) || 0),
      setRate: rate => { audio.playbackRate = Math.max(0.5, Math.min(3, Number(rate) || 1)); },
    },
    subtitles: {
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
        if (LIVE.on) liveDisable('已停止实时识别。');
        else await liveEnable();
        return !!LIVE.on;
      },
      clipNow: span => clipNow(Number(span) || 15),
      exportSubtitle: kind => exportSubtitle(kind || 'txt'),
    },
    study: {
      claim: () => PluginHost.claim(id, 'study'),
      active: () => PluginHost.owner('study') === id,
      status: () => ({
        owner: app.studyOwner,
        subtitles: subtitlePluginOn(),
        vocab: studyVocab.length,
        due: studyDueItems().length,
        cache: Object.keys(studyCache).length,
        provider: STUDY.provider,
        configured: !!(STUDY.key && STUDY.model),
        view: studyView,
        episode: pluginPlayerState(),
      }),
      open: view => openStudySheet(view),
      close: () => closeStudySheet(),
      openEpisode: (showKey, episodeId) => studyOpenEpisodeSummary(showKey, episodeId),
      openSettings: () => {
        navigate('settings');
        setTimeout(() => openSettingsPane('study'), 0);
      },
    },
    storage: {
      get: (key, fallback = null) => readJSON(storagePrefix + key, fallback),
      set: (key, value) => writeJSON(storagePrefix + key, value),
      remove: key => { try { localStorage.removeItem(storagePrefix + key); } catch (e) {} },
    },
  };
}
function ensurePluginApi() {
  if (pluginApiReady) return;
  pluginApiReady = true;
  window.MyTPlugins = {
    version: '2.0',
    host: PluginHost,
    register(id, definition) {
      if (!id || !definition || typeof definition.setup !== 'function') {
        throw new Error('MyTPlugins.register 需要 id 和 setup(api)');
      }
      PLUGIN_REGISTRY.set(String(id), definition);
    },
    start(id) {
      const definition = PLUGIN_REGISTRY.get(String(id));
      if (!definition) throw new Error('插件没有调用 MyTPlugins.register(' + id + ')');
      if (definition.__started) return;
      definition.__started = true;
      definition.setup(pluginApiFor(String(id)));
    },
    _error(id, err) { pluginReportError(id, err); },
    runCommand(pluginId, name) {
      const fn = PLUGIN_COMMANDS.get(String(pluginId) + ':' + String(name));
      if (typeof fn === 'function') return fn();
      return undefined;
    },
  };
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
  for (const plugin of app.plugins) {
    if (!plugin || !plugin.enabled) continue;
    if (plugin.error) { pluginReportError(plugin.id, plugin.error); continue; }
    const id = String(plugin.id || '');
    if (!id) continue;
    const missing = PluginHost.missingRequires(plugin, app.plugins);
    if (missing.length) {
      pluginReportError(id, '需要先启用插件：' + missing.join('、'));
      continue;
    }
    if (plugin.css) {
      const style = document.createElement('style');
      style.dataset.pluginCss = id;
      style.textContent = plugin.css;
      document.head.append(style);
    }
    if (!plugin.js) { pluginReportError(id, '入口 JS 为空，检查 plugin.json 的 main 字段'); continue; }
    const script = document.createElement('script');
    script.dataset.plugin = id;
    script.textContent = '(function(){try{\n' + plugin.js + '\n}catch(e){MyTPlugins._error(' +
      JSON.stringify(id) + ', e);}})();';
    document.body.append(script);
    script.remove();
    try { window.MyTPlugins.start(id); }
    catch (err) { pluginReportError(id, err); }
  }
}
function renderPluginPage(pluginId, pageId) {
  const body = $('pluginPageBody');
  if (!body) return;
  const def = PLUGIN_PAGES.get(pluginPageKey(pluginId, pageId));
  if (!def) {
    body.innerHTML = '<div class="empty">插件页面不存在：' + esc(pluginId + '/' + pageId) + '</div>';
    return;
  }
  if (app.pluginPageActive && app.pluginPageActive !== def && typeof app.pluginPageActive.destroy === 'function') {
    try { app.pluginPageActive.destroy(); } catch (err) { pluginReportError(app.pluginPageActive.pluginId, err); }
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
      if (ret && typeof ret.catch === 'function') ret.catch(err => pluginReportError(def.pluginId, err));
    } catch (err) {
      pluginReportError(def.pluginId, err);
      body.innerHTML = '<div class="empty">插件页面出错：' + esc(err.message || err) + '</div>';
    }
  }
}
async function refreshPluginSettings() {
  const box = $('pluginList');
  const status = $('pluginStatus');
  if (!box) return;
  if (!host() || typeof host().pluginList !== 'function') {
    box.innerHTML = emptyLine('插件只在桌面版可用。');
    if (status) status.textContent = '网页版没有本地插件目录权限。';
    return;
  }
  box.innerHTML = '<div class="smalltext">正在读取插件目录…</div>';
  try {
    const list = await host().pluginList();
    app.plugins = Array.isArray(list) ? list : [];
    if (!app.plugins.length) {
      box.innerHTML = emptyLine('还没有插件。点「生成示例插件」，或把插件目录放进 plugins 文件夹。');
      if (status) status.textContent = '插件目录：C:\\ProgramData\\MyTranscript\\plugins';
      return;
    }
    box.innerHTML = app.plugins.map(plugin => {
      const err = plugin.error || (app.pluginErrors && app.pluginErrors.get(plugin.id)) || '';
      const missing = PluginHost.missingRequires(plugin, app.plugins);
      const dep = missing.length ? '需要先启用：' + missing.join('、') : '';
      return '<div class="ep-row"><div class="ep-body"><span class="ep-title">' + esc(plugin.name || plugin.id) +
        ' <span class="pill dim">' + esc(plugin.id) + '</span></span><span class="ep-sub">' +
        esc([plugin.version ? 'v' + plugin.version : '', plugin.author, plugin.description].filter(Boolean).join(' · ') || '无描述') +
        (dep ? '<br><span style="color:#e08a7a">' + esc(dep) + '</span>' : '') +
        (err && !dep ? '<br><span style="color:#e08a7a">' + esc(err) + '</span>' : '') + '</span></div>' +
        '<button class="switch" role="switch" aria-checked="' + (plugin.enabled ? 'true' : 'false') +
        '" data-plugin-toggle="' + esc(plugin.id) + '" title="' + (plugin.enabled ? '停用' : '启用') + '"></button></div>';
    }).join('');
    if (status) status.textContent = '共 ' + app.plugins.length + ' 个插件，' +
      app.plugins.filter(p => p.enabled).length + ' 个已启用；改完状态后点「重新加载」生效。';
  } catch (err) {
    box.innerHTML = emptyLine('读取插件失败：' + esc(err.message || err));
  }
}

async function initPlayer() {
  const params = new URLSearchParams(location.search);
  try {
    const data = await getJson('shows.json', SHELL_TIMEOUT);
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

