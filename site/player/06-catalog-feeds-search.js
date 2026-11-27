import { $, ASR_MODEL_DEFAULT, LIVE_LEAD_DEFAULT, host, prefs, replacePrefs, setState, state } from './00-runtime.js';
import { esc, fmt, getJson, loaderHTML, parseFeed, showToast } from './01-theme-reader-shell.js';
import { CATALOG_TIMEOUT, coverSrc, smallArtwork, subtitlePluginOn } from './04-local-audio-plugin-host.js';
import { AUTO_DEFAULTS, AUTO_KEY, BOOKMARK_KEY, FAV_KEY, INBOX_KEY, LOCAL_KEY, NOTE_KEY, PLAYED_KEY, PLAYLIST_KEY, PREFS_KEY, QUEUE_KEY, SEEN_KEY, SHOWPREFS_KEY, SUBS_KEY, absoluteFeed, absoluteUrl, app, applyVolume, cleanFeedTitle, findBuiltinByFeed, hash32, hostOf, navigate, normalizeFeedUrl, normalizeSidebarPrefs, plainText, readJSON, saveSubs, showByKey, syncDockSleep, writeJSON } from './05-transport-transcript-nav.js';

import { lazyFn, registerLayer } from './00-layers.js';
const addFeedFromUrl = lazyFn('10-desktop-bridge-tail', 'addFeedFromUrl');
const openModal = lazyFn('10-desktop-bridge-tail', 'openModal');
const startSleepTimer = lazyFn('10-desktop-bridge-tail', 'startSleepTimer');
/* layer: bridge —— 目录/feed 缓存、OPML、在线搜索
   本片只做该层的事，跨层调用走 kernel / host() / setState。 */
/* ---------- catalog + local state ---------- */
async function loadCatalog() {
  app.catalogPending = true;
  try {
    const catalog = await getJson('catalog.json', CATALOG_TIMEOUT);
    if (!catalog || !Array.isArray(catalog.shows)) return false;
    app.catalog = catalog;
    catalog.shows.forEach(show => app.catalogBySlug.set(show.slug, show));
    return true;
  } catch (e) {
    return false;
  } finally {
    app.catalogPending = false;
  }
}
function catalogFields(cat) {
  return {
    artwork: cat.artwork || '',
    description: cat.description || '',
    episode_count: Number(cat.episode_count) || 0,
    transcript_count: Number(cat.transcript_count) || 0,
    latest_transcript_count: Number(cat.latest_transcript_count) || 0,
    latest_published_at: cat.latest_published_at || '',
    language: cat.language || '',
    categories: Array.isArray(cat.categories) ? cat.categories : [],
    latest: Array.isArray(cat.latest) ? cat.latest : [],
  };
}
function mergeCatalog() {
  if (!app.catalog) return;
  app.builtinShows = app.builtinShows.map(show => {
    const cat = app.catalogBySlug.get(show.slug);
    if (!cat) return show;
    const fields = catalogFields(cat);
    return {
      ...show,
      ...fields,
      feed: show.feed || cat.feed,
      artwork: fields.artwork || show.artwork || '',
      description: fields.description || show.description || '',
    };
  });
  for (const cat of app.catalog.shows) {
    if (app.builtinShows.some(show => show.slug === cat.slug)) continue;
    const fields = catalogFields(cat);
    app.builtinShows.push({
      slug: cat.slug, key: cat.slug, name: cleanFeedTitle(cat.name) || cat.slug, feed: cat.feed,
      builtin: true, ...fields,
    });
  }
}
function loadLocalState() {
  app.queue = readJSON(QUEUE_KEY, []) || [];
  app.playlists = readJSON(PLAYLIST_KEY, []) || [];
  app.bookmarks = readJSON(BOOKMARK_KEY, []) || [];
  app.notes = readJSON(NOTE_KEY, []) || [];
  app.auto = Object.assign({}, AUTO_DEFAULTS, readJSON(AUTO_KEY, {}) || {});
  app.favorites = new Set(readJSON(FAV_KEY, []) || []);
  app.played = readJSON(PLAYED_KEY, {}) || {};
  app.inbox = readJSON(INBOX_KEY, []) || [];
  app.seen = readJSON(SEEN_KEY, {}) || {};
  app.showPrefs = readJSON(SHOWPREFS_KEY, {}) || {};
  app.local = readJSON(LOCAL_KEY, []) || [];
  replacePrefs(Object.assign({ speed: 1, autoNext: false, remember: true, liveLead: LIVE_LEAD_DEFAULT, liveMse: true, volume: 1, muted: false, asrModel: ASR_MODEL_DEFAULT }, readJSON(PREFS_KEY, {}) || {}));
  // 「单流播放」原来默认关闭、存在本地是 false。改成默认开启后老配置会一直沿用 false，
  // 这里做一次性迁移：没写过这个标记就把它打开（之后再手动关掉照样生效）。
  if (!readJSON('myt-liveMseOn', false)) {
    prefs.liveMse = true;
    writeJSON('myt-liveMseOn', true);
  }
  prefs.modules = Object.assign({
    discover: true, search: true, local: true, inbox: true, queue: true, history: true,
    stats: true, favorites: true, bookmarks: true, notes: true, listening: true,
    video: true, transcript: true, liveAsr: true, translate: true, floatWindow: true,
    chapters: true, offline: true, exportShare: true, study: true,
  }, prefs.modules || {});
  prefs.sidebar = normalizeSidebarPrefs(prefs.sidebar);
applyVolume(false);
  const stored = localStorage.getItem(SUBS_KEY);
  if (stored == null) {
    app.subs = [];
    saveSubs();
  } else {
    app.subs = (readJSON(SUBS_KEY, []) || []).map(rec => {
      const builtin = app.builtinShows.find(s => s.slug === rec.key);
      return Object.assign({}, rec, {
        builtin: !!builtin || rec.builtin === true,
        feed: rec.feed || builtin?.feed || '',
        name: rec.name || builtin?.name || '',
        artwork: rec.artwork || builtin?.artwork || '',
        description: rec.description || builtin?.description || '',
      });
    });
  }
  // 界面与续播拆成两组独立设置；旧的 myt-play-mode 一次性迁移后再删掉。
  const legacyMode = localStorage.getItem('myt-play-mode') || '';
  app.appearance = localStorage.getItem('myt-appearance') || (legacyMode === 'car' ? 'car' : 'default');
  app.cont = localStorage.getItem('myt-continue') || (legacyMode === 'continuous' || legacyMode === 'radio' ? legacyMode : (prefs.autoNext ? 'continuous' : 'single'));
  if (legacyMode) { try { localStorage.removeItem('myt-play-mode'); } catch (e) {} }
  document.body.classList.toggle('car-mode', app.appearance === 'car');
  // 阅读模式记忆：逐词/逐句、跟随方式都按上次留下的恢复，否则每次启动都偷偷回到默认。
  try {
    const savedMode = localStorage.getItem('myt-mode');
    if (savedMode === 'word' || savedMode === 'sentence') setState('mode', savedMode);
    const savedScroll = localStorage.getItem('myt-scroll');
    if (savedScroll && $('scroll').querySelector('option[value="' + savedScroll + '"]')) setState('scroll', savedScroll);
  } catch (e) {}
  const modeSeg = $('modeSeg');
  if (modeSeg) [...modeSeg.children].forEach(b => {
    const on = b.dataset.mode === state.mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
  if ($('scroll').value !== state.scroll) $('scroll').value = state.scroll;
  try {
    const sleep = JSON.parse(localStorage.getItem('myt-sleep') || 'null');
    if (sleep && sleep.until && sleep.until > Date.now()) { app.sleepUntil = sleep.until; startSleepTimer(); }
    else if (sleep && sleep.end) app.sleepEnd = true;
  } catch (e) {}
  syncDockSleep();
}

/* ---------- cross-origin feed cache ---------- */
let feedDbPromise = null;
function feedDb() {
  return feedDbPromise || (feedDbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('no indexeddb')); return; }
    const request = indexedDB.open('myt-feeds', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('xml');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}
async function feedCacheGet(key) {
  try {
    const db = await feedDb();
    return await new Promise((resolve, reject) => {
      const request = db.transaction('xml', 'readonly').objectStore('xml').get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } catch (e) { return null; }
}
async function feedCachePut(key, xml) {
  try {
    const db = await feedDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('xml', 'readwrite');
      tx.objectStore('xml').put({ xml, at: Date.now() }, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {}
}
const FEED_CACHE_TTL = 6 * 60 * 60 * 1000;
function feedCacheFresh(entry, now = Date.now()) {
  const at = Number(entry?.at);
  return !!entry?.xml && Number.isFinite(at) && now - at <= FEED_CACHE_TTL;
}
// 内存里的解析结果同样遵守 TTL；否则长时间不刷新页面会一直用旧 feed。
function rememberFeed(key, feed) {
  if (!key || !feed) return;
  const at = Date.now();
  app.feedCache.set(key, { feed, at });
  state.feeds.set(key, feed);
}
function memoryFeed(key, now = Date.now()) {
  const id = typeof key === 'string' ? key : (key?.slug || key?.key || '');
  if (!id) return null;
  const entry = app.feedCache.get(id);
  if (!entry) return null;
  const at = Number(entry.at);
  if (!entry.feed || !Number.isFinite(at) || now - at > FEED_CACHE_TTL) {
    app.feedCache.delete(id);
    state.feeds.delete(id);
    return null;
  }
  return entry.feed;
}
function hasFreshFeed(key) { return !!memoryFeed(key); }

async function fetchFeedText(url, options = {}) {
  const abs = absoluteUrl(url);
  const sameOrigin = abs.startsWith(location.origin);
  const cached = sameOrigin ? null : await feedCacheGet(abs);
  if (!options.force && feedCacheFresh(cached)) return cached.xml;
  /* 桌面版先用原生命令直取：远端 RSS 的 CORS 经常直接失败，浏览器 fetch 在坏网络上还会
     挂很久；http_text 走主进程，既绕 CORS，也不会把「在线预览」卡死。 */
  if (!sameOrigin) {
    const bridge = host();
    if (bridge && typeof bridge.httpText === 'function') {
      try {
        const text = await nativeText(abs, 15000);
        if (text) {
          await feedCachePut(abs, text);
          return text;
        }
      } catch (e) {}
    }
  }
  try {
    const response = await fetch(abs, { cache: 'no-cache', signal: AbortSignal.timeout(9000) });
    if (response.ok) {
      const text = await response.text();
      if (!sameOrigin) await feedCachePut(abs, text);
      return text;
    }
  } catch (e) {}
  const template = (localStorage.getItem('myt-cors-proxy') || '').trim();
  if (template) {
    try {
      const target = template.includes('{url}')
        ? template.replace('{url}', encodeURIComponent(abs))
        : template + encodeURIComponent(abs);
      const response = await fetch(target, { cache: 'no-cache' });
      if (response.ok) {
        const text = await response.text();
        if (!sameOrigin) await feedCachePut(abs, text);
        return text;
      }
    } catch (e) {}
  }
  if (cached?.xml) return cached.xml;
  const err = new Error('无法读取该 feed：该站点不允许浏览器跨域。可在设置里配置 CORS 代理，或粘贴 RSS 内容导入。');
  err.cors = true;
  throw err;
}
async function ensureShowFeed(show, options = {}) {
  if (!show) throw new Error('节目不存在');
  if (!show.feed) throw new Error('该节目没有 feed 地址。');
  const cached = memoryFeed(show);
  if (cached && !options.force) return cached;
  const xml = await fetchFeedText(show.feed, options);
  const feed = parseFeed(xml);
  if (!feed.title && !feed.episodes.length) throw new Error('返回内容不是可识别的 RSS。');
  rememberFeed(show.slug, feed);
  if (feed.title && !show.builtin) show.name = cleanFeedTitle(feed.title) || show.name;
  if (feed.artwork && !show.artwork) show.artwork = feed.artwork;
  if (feed.description && !show.description) show.description = feed.description;
  if (feed.episodes.length) show.episode_count = feed.episodes.length;
  if (!show.builtin) {
    const rec = app.subs.find(s => s.key === show.slug);
    if (rec) {
      rec.name = show.name || rec.name;
      rec.artwork = show.artwork || rec.artwork;
      rec.description = show.description || rec.description;
      saveSubs();
    }
  }
  return feed;
}

/* ---------- OPML ---------- */
function decodeXml(text) {
  return String(text || '').replace(/&(amp|lt|gt|quot|apos|#\d+);/g, (m, code) => {
    if (code === 'amp') return '&';
    if (code === 'lt') return '<';
    if (code === 'gt') return '>';
    if (code === 'quot') return '"';
    if (code === 'apos') return "'";
    if (code[0] === '#') return String.fromCharCode(Number(code.slice(1)));
    return m;
  });
}
function parseOpml(text) {
  const items = [];
  const re = /<outline\b[^>]*>/gi;
  let match;
  while ((match = re.exec(String(text || '')))) {
    const tag = match[0];
    const attr = name => {
      const found = new RegExp(name + '\\s*=\\s*(["\'])(.*?)\\1', 'i').exec(tag);
      return found ? decodeXml(found[2]) : '';
    };
    const xmlUrl = attr('xmlUrl') || attr('xmlurl');
    if (xmlUrl) items.push({ title: attr('text') || attr('title'), xmlUrl });
  }
  return items;
}
function buildOpml(items, origin) {
  const escapeXml = value => String(value == null ? '' : value).replace(/[&<>"]/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]
  ));
  const rows = items.map(item =>
    '    <outline type="rss" text="' + escapeXml(item.title) + '" title="' + escapeXml(item.title) +
    '" xmlUrl="' + escapeXml(item.xmlUrl) + '"/>').join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>MyTranscript subscriptions</title></head>\n  <body>\n' +
    rows + '\n  </body>\n</opml>\n';
}
function downloadFile(name, content, type) {
  const blob = new Blob([content], { type: type || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function checkSubscriptions() {
  const box = $('subHealth');
  if (box) box.textContent = '正在检查 ' + app.subs.length + ' 个订阅…';
  const results = [];
  const feeds = new Map();
  for (const sub of app.subs) {
    const show = showByKey(sub.key);
    const origin = show?.feed ? absoluteFeed(show.feed) : (sub.feed || '');
    if (origin) feeds.set(origin, (feeds.get(origin) || 0) + 1);
    let status = 'ok', detail = '', latest = 0;
    if (!origin) { status = 'bad'; detail = '没有 feed 地址'; }
    else {
      try {
        const xml = await fetchFeedText(origin, { force: true });
        const feed = parseFeed(xml);
        latest = feed.episodes.reduce((max, ep) => Math.max(max, Date.parse(ep.date) || 0), 0);
        if (!feed.episodes.length) { status = 'bad'; detail = 'feed 里没有单集'; }
        else if (latest && latest < Date.now() - 90 * 86400000) { status = 'stale'; detail = '最后更新 ' + new Date(latest).toLocaleDateString('zh-CN'); }
        else detail = feed.episodes.length + ' 集';
      } catch (e) { status = 'bad'; detail = '读取失败'; }
    }
    results.push({ sub, show, origin, status, detail });
  }
  for (const item of results) if (feeds.get(item.origin) > 1) { item.status = item.status === 'ok' ? 'dup' : item.status; item.detail += ' · 重复订阅'; }
  const bad = results.filter(item => item.status === 'bad').length;
  const stale = results.filter(item => item.status === 'stale').length;
  const dup = results.filter(item => item.status === 'dup').length;
  if (box) {
    box.innerHTML = '<div style="margin:6px 0 8px;color:var(--ink)">检查完成：' + results.length + ' 个订阅，失效 ' + bad + '，长期未更新 ' + stale + '，重复 ' + dup + '。</div>' +
      results.map(({ show, sub, status, detail }) => {
        const label = status === 'bad' ? '失效' : status === 'stale' ? '久未更新' : status === 'dup' ? '重复' : '正常';
        const tone = status === 'bad' ? 'warn' : '';
        return '<div class="ep-row" style="cursor:default"><div class="ep-body"><span class="ep-title">' + esc(show?.name || sub.name || sub.key) +
          '</span><span class="ep-sub">' + esc(detail) + '</span></div><span class="pill ' + tone + '">' + label + '</span>' +
          (status === 'bad' ? '<button class="mini-btn" data-remove-sub="' + esc(sub.key) + '" title="移除失效订阅">✕</button>' : '') + '</div>';
      }).join('');
  }
  showToast('订阅检查完成：' + results.length + ' 个，失效 ' + bad + ' 个。', 6000);
}
function stamp(seconds, comma) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, r = ms % 1000;
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':') + (comma ? ',' : '.') + String(r).padStart(3, '0');
}
function exportSubtitle(kind) {
  if (!subtitlePluginOn()) { showToast('没有可导出的字幕。', 'warn'); return; }
  if (!state.cues.length) { showToast('当前单集没有可导出的文字稿。', 'warn'); return; }
  const cues = state.cues.filter(cue => (cue.text || '').trim());
  const safe = (state.current?.title || 'transcript').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
  if (kind === 'txt') {
    downloadFile(safe + '.txt', cues.map(cue => (cue.text || '') + (cue.zh ? '\n' + cue.zh : '')).join('\n\n'), 'text/plain;charset=utf-8');
    return;
  }
  if (kind === 'vtt') {
    downloadFile(safe + '.vtt', 'WEBVTT\n\n' + cues.map(cue => stamp(cue.start, false) + ' --> ' + stamp(cue.end, false) + '\n' + (cue.text || '') + (cue.zh ? '\n' + cue.zh : '')).join('\n\n'), 'text/vtt;charset=utf-8');
    return;
  }
  downloadFile(safe + '.srt', cues.map((cue, i) => (i + 1) + '\n' + stamp(cue.start, true) + ' --> ' + stamp(cue.end, true) + '\n' + (cue.text || '') + (cue.zh ? '\n' + cue.zh : '')).join('\n\n'), 'application/x-subrip;charset=utf-8');
}
function shareCurrentCue() {
  const cue = state.cues[state.activeCue];
  if (!cue || !(cue.text || cue.zh)) { showToast('先播放到一句再分享。', 'warn'); return; }
  const W = 1080, H = 1080;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#101216'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#e9c46a'; ctx.fillRect(72, 96, 10, 96);
  ctx.fillStyle = '#f4f1ea';
  ctx.font = '700 42px "Noto Sans SC","Microsoft YaHei",system-ui,sans-serif';
  const wrap = (text, max) => {
    const lines = []; let line = '';
    for (const ch of String(text || '')) {
      if (ctx.measureText(line + ch).width > max) { lines.push(line); line = ch; } else line += ch;
    }
    if (line) lines.push(line);
    return lines;
  };
  const en = wrap(cue.text, 880).slice(0, 5);
  const zh = wrap(cue.zh, 880).slice(0, 4);
  let y = 300;
  ctx.font = '700 52px "Noto Sans SC","Microsoft YaHei",system-ui,sans-serif';
  ctx.fillStyle = '#f4f1ea';
  en.forEach(line => { ctx.fillText(line, 82, y); y += 74; });
  y += 22;
  ctx.font = '400 40px "Noto Sans SC","Microsoft YaHei",system-ui,sans-serif';
  ctx.fillStyle = '#9fb0c7';
  zh.forEach(line => { ctx.fillText(line, 82, y); y += 60; });
  ctx.fillStyle = '#4a5568';
  ctx.fillRect(82, H - 210, 916, 1);
  ctx.fillStyle = '#e9c46a'; ctx.font = '600 26px system-ui,sans-serif';
  ctx.fillText(fmt(cue.start + (state.offset || 0)), 82, H - 150);
  ctx.fillStyle = '#8b98a9'; ctx.font = '400 26px "Noto Sans SC",system-ui,sans-serif';
  ctx.fillText((state.show?.name || 'MyTranscript').slice(0, 28), 82, H - 104);
  ctx.fillStyle = '#5c6a7d'; ctx.font = '400 22px system-ui,sans-serif';
  ctx.fillText('MyTranscript · 逐词字幕', 82, H - 58);
  canvas.toBlob(blob => {
    if (!blob) { showToast('分享图生成失败。', 'warn'); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'cue-' + Math.round(cue.start) + '.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast('分享图已保存。', 3000);
  }, 'image/png');
}
function exportOpml() {
  const items = app.subs.map(sub => {
    const show = showByKey(sub.key);
    return { title: show?.name || sub.name || sub.key, xmlUrl: show?.feed ? absoluteFeed(show.feed) : sub.feed };
  }).filter(item => item.xmlUrl);
  if (!items.length) { showToast('还没有订阅可以导出。'); return; }
  downloadFile('mytranscript-subscriptions.opml', buildOpml(items, location.href), 'text/x-opml;charset=utf-8');
  showToast('已导出 ' + items.length + ' 个订阅。');
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制：' + text, 4000);
  } catch (e) {
    window.prompt('复制链接', text);
  }
}

/* ---------- artwork ---------- */
const COVER_GRADS = [
  ['#141a2b', '#4d6a8a'], ['#1b1410', '#8a6a3f'], ['#101d18', '#3f7a63'],
  ['#20101a', '#8a4d6d'], ['#141021', '#5f4d9a'], ['#1d1a0f', '#9a8240'],
  ['#0f1a20', '#3f7a8a'], ['#1a1010', '#8a4d4d'],
];
function coverGrad(key) {
  const pair = COVER_GRADS[parseInt(hash32(key || 'show'), 36) % COVER_GRADS.length];
  return 'background:linear-gradient(145deg,' + pair[0] + ',' + pair[1] + ')';
}
function initialsOf(name) {
  const words = String(name || 'MT').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'MT';
  if (/[\u3400-\u9fff]/.test(words[0])) return words[0].slice(0, 2);
  return words.slice(0, 2).map(word => word[0]).join('').toUpperCase();
}
/* `px` = 这张封面在页面上最多显示多宽（走壳的缩略）；不传就是原图。 */
function coverHTML(show, cls, px) {
  const name = show?.name || show?.slug || 'Podcast';
  const art = show?.artwork || '';
  const img = art
    ? '<img src="' + esc(coverSrc(art, px)) + '" data-raw="' + esc(smallArtwork(art) || art) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="__coverErr(this)">'
    : '';
  return '<div class="' + (cls || 'pod-art') + '" style="' + coverGrad(show?.key || show?.slug || name) + '"><span>' +
    esc(initialsOf(name)) + '</span>' + img + '</div>';
}
function episodeCover(ep, show, px) {
  const art = ep?.img || show?.artwork || '';
  const img = art
    ? '<img src="' + esc(coverSrc(art, px)) + '" data-raw="' + esc(smallArtwork(art) || art) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="__coverErr(this)">'
    : '';
  return '<div class="ep-art" style="' + coverGrad(show?.key || show?.slug || ep?.id) + '"><span>' +
    esc(initialsOf(show?.name || '')) + '</span>' + img + '</div>';
}

/* ---------- online podcast search ---------- */
// AntennaPod bundles these public Podcast Index credentials in
// net/discovery/build.gradle. They are not secrets, but they are visible here too.
const PODCAST_INDEX = {
  key: 'XTMMQGA2YZ4WJUBYY4HK',
  secret: 'XAaAhk4^2YBsTE33vdbwbZNj82ZRLABDDqFdKe7x',
};
const ONLINE_PAGE = 20;
function appleSearchUrl(query) {
  return 'https://itunes.apple.com/search?media=podcast&entity=podcast&term=' +
    encodeURIComponent(String(query || '').trim()) + '&limit=30';
}
function mapAppleResults(doc) {
  const results = Array.isArray(doc?.results) ? doc.results : [];
  return results.filter(item => item && item.feedUrl).map(item => ({
    title: item.collectionName || item.trackName || 'Unknown',
    author: item.artistName || '',
    feedUrl: item.feedUrl,
    image: item.artworkUrl600 || item.artworkUrl100 || '',
    imageSmall: item.artworkUrl100 || '',
    genre: item.primaryGenreName || '',
    episodeCount: Number(item.trackCount) || 0,
    description: item.description || '',
    source: 'apple',
  }));
}
function podcastIndexSearchUrl(query) {
  return 'https://api.podcastindex.org/api/1.0/search/byterm?q=' +
    encodeURIComponent(String(query || '').trim()) + '&max=30';
}
function mapPodcastIndexResults(doc) {
  const feeds = Array.isArray(doc?.feeds) ? doc.feeds : [];
  return feeds.filter(feed => feed && feed.url).map(feed => ({
    title: feed.title || 'Unknown',
    author: feed.author || '',
    feedUrl: feed.url,
    image: feed.image || '',
    imageSmall: feed.image || '',
    genre: feed.categories && typeof feed.categories === 'object' && !Array.isArray(feed.categories)
      ? (Object.values(feed.categories)[0] || '') : '',
    episodeCount: Number(feed.episodeCount) || 0,
    description: feed.description || '',
    source: 'podcastindex',
  }));
}
async function sha1Hex(text) {
  const bytes = new TextEncoder().encode(String(text));
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function podcastIndexAuth(key, secret, seconds) {
  const time = String(seconds);
  return {
    'X-Auth-Date': time,
    'X-Auth-Key': key,
    'Authorization': await sha1Hex(key + secret + time),
  };
}
function searchTitleKey(value) {
  return String(value || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}
function findBuiltinForTitle(title, shows) {
  const key = searchTitleKey(title);
  if (!key) return null;
  return (shows || []).find(show => show && show.feed && searchTitleKey(show.name) === key) || null;
}
function feedKey(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(normalizeFeedUrl(raw));
    const port = parsed.port ? ':' + parsed.port : '';
    return parsed.protocol.toLowerCase() + '//' + parsed.hostname.toLowerCase() + port +
      parsed.pathname.replace(/\/+$/, '') + parsed.search;
  } catch (e) {
    return raw.replace(/\/+$/, '').toLowerCase();
  }
}
function mergeSearchMeta(base, extra) {
  const merged = { ...base };
  ['title', 'author', 'image', 'imageSmall', 'genre', 'description'].forEach(field => {
    if (!merged[field] && extra[field]) merged[field] = extra[field];
  });
  merged.episodeCount = Math.max(Number(base.episodeCount) || 0, Number(extra.episodeCount) || 0);
  const sources = new Set([...(base.sources || [base.source]), ...(extra.sources || [extra.source])]
    .filter(Boolean));
  merged.sources = [...sources];
  return merged;
}
function mergeSearchResults(lists) {
  const scores = new Map();
  const byUrl = new Map();
  (lists || []).forEach(list => {
    (list || []).forEach((item, position) => {
      if (!item || !item.feedUrl) return;
      const key = feedKey(item.feedUrl);
      if (!byUrl.has(key)) byUrl.set(key, { ...item });
      else byUrl.set(key, mergeSearchMeta(byUrl.get(key), item));
      scores.set(key, (scores.get(key) || 0) + 1 / (position + 1));
    });
  });
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => byUrl.get(key));
}
function subscribedShowForFeed(url) {
  const key = feedKey(url);
  if (!key) return null;
  return app.subs.map(sub => showByKey(sub.key))
    .find(show => show && show.feed && feedKey(absoluteFeed(show.feed)) === key) || null;
}
async function fetchJson(url, options = {}, timeoutMs = 7000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return await response.json();
}
async function searchApple(query) {
  try {
    return mapAppleResults(await fetchJson(appleSearchUrl(query), {}, 9000));
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    throw new Error('Apple Podcasts：' + (timedOut ? '请求超时' : err.message), { cause: err });
  }
}
async function searchPodcastIndex(query) {
  if (!globalThis.crypto?.subtle) throw new Error('浏览器不支持 Web Crypto');
  const headers = await podcastIndexAuth(PODCAST_INDEX.key, PODCAST_INDEX.secret, Math.floor(Date.now() / 1000));
  try {
    return mapPodcastIndexResults(await fetchJson(podcastIndexSearchUrl(query), { headers }, 6000));
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    throw new Error('Podcast Index：' + (timedOut ? '请求超时' : err.message), { cause: err });
  }
}
async function runOnlineSearch(query) {
  const q = String(query || '').trim();
  const seq = ++app.online.seq;
  if (!q) {
    Object.assign(app.online, {
      query: '', loading: false, results: [], sources: [], piError: '', error: '', visible: ONLINE_PAGE,
    });
    renderOnlineResults();
    return;
  }
  const cacheKey = q.toLowerCase();
  const cached = app.online.cache.get(cacheKey);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) {
    Object.assign(app.online, {
      query: q, loading: false, results: cached.results, sources: cached.sources,
      piError: cached.piError || '', error: '', visible: ONLINE_PAGE,
    });
    renderOnlineResults();
    return;
  }
  Object.assign(app.online, { query: q, loading: true, results: [], sources: [], piError: '', error: '', visible: ONLINE_PAGE });
  renderOnlineResults();
  const [apple, podcastIndex] = await Promise.allSettled([searchApple(q), searchPodcastIndex(q)]);
  if (seq !== app.online.seq) return;
  const lists = [];
  const sources = [];
  const errors = [];
  if (apple.status === 'fulfilled') { lists.push(apple.value); sources.push('Apple Podcasts'); }
  else errors.push(apple.reason?.message || 'Apple Podcasts 不可用');
  let piError = '';
  if (podcastIndex.status === 'fulfilled') { lists.push(podcastIndex.value); sources.push('Podcast Index'); }
  else piError = podcastIndex.reason?.message || 'Podcast Index 不可用';
  const results = mergeSearchResults(lists);
  app.online.cache.set(cacheKey, { results, sources, piError, at: Date.now() });
  Object.assign(app.online, {
    loading: false, results, sources, piError,
    error: lists.length ? '' : (errors.join('；') || '在线搜索失败'),
  });
  renderOnlineResults();
}
function onlineRowHTML(result, rank) {
  const builtin = findBuiltinForTitle(result.title, app.builtinShows);
  const subscribed = subscribedShowForFeed(result.feedUrl);
  const show = { key: result.feedUrl, name: result.title, artwork: result.image };
  let action;
  if (builtin) {
    action = '<button class="btn small primary" data-online-builtin="' + esc(builtin.slug) + '">打开增强版</button>';
  } else if (subscribed) {
    action = '<button class="btn small ghost" data-online-open="' + esc(subscribed.slug) + '">已订阅</button>';
  } else {
    action = '<button class="btn small primary" data-online-subscribe="' + esc(result.feedUrl) + '">订阅</button>';
  }
  const meta = [result.author, result.genre, result.episodeCount ? result.episodeCount + ' 集' : '',
    hostOf(result.feedUrl)].filter(Boolean).join(' · ');
  const rankHTML = rank === undefined || rank === null ? ''
    : '<span class="chart-rank' + (Number(rank) <= 3 ? ' top' : '') + '">' + esc(String(rank)) + '</span>';
  return '<div class="online-row" data-online-detail="' + esc(result.feedUrl) + '" role="link" tabindex="0">' + rankHTML +
    coverHTML(show, 'online-art', 300) +
    '<div class="online-body"><span class="online-title">' + esc(result.title) + '</span>' +
    '<span class="online-sub">' + esc(meta) + '</span>' +
    (builtin ? '<div class="online-badge"><span class="pill">本站增强版</span></div>' : '') +
    '</div><div class="online-actions">' + action + '</div></div>';
}
function onlineDetailHTML(result, feed, note) {
  const title = feed?.title ? cleanFeedTitle(feed.title) : result.title;
  const show = { key: result.feedUrl, name: title, artwork: feed?.artwork || result.image };
  const count = feed?.episodes?.length || result.episodeCount || 0;
  const meta = [result.author, result.genre, count ? count + ' 集' : '', hostOf(result.feedUrl)]
    .filter(Boolean).join(' · ');
  const desc = plainText(feed?.description || result.description || '');
  const body = note === 'loading'
    ? '<div class="online-state">' + loaderHTML('正在读取节目详情…') + '</div>'
    : '<p class="online-detail-desc">' + esc(desc || '该节目没有提供简介。') + '</p>' +
      (note ? '<div class="modal-note err" style="margin-bottom:12px">' + esc(note) + '</div>' : '');
  return '<div class="modal-head"><h3>节目详情</h3><button class="mini-btn" data-close-modal aria-label="关闭">✕</button></div>' +
    '<div class="online-detail"><div class="online-detail-hero">' + coverHTML(show, 'online-art', 300) +
    '<div style="min-width:0"><div class="online-detail-title">' + esc(title) + '</div>' +
    '<div class="online-sub">' + esc(meta) + '</div></div></div>' + body +
    '<div class="modal-actions"><button class="btn primary" data-online-subscribe="' + esc(result.feedUrl) + '">订阅</button>' +
    '<button class="btn ghost" data-close-modal>关闭</button></div></div>';
}
let onlinePreviewSeq = 0;
async function openOnlinePreview(result) {
  const token = ++onlinePreviewSeq;
  openModal(onlineDetailHTML(result, null, 'loading'));
  const card = $('modalCard');
  card.dataset.onlinePreview = String(token);
  const stillOpen = () => $('modal').open && card.dataset.onlinePreview === String(token) && !!card.querySelector('.online-detail');
  try {
    const xml = await fetchFeedText(result.feedUrl);
    if (!xml) throw new Error('feed 加载失败');
    const feed = parseFeed(xml);
    if (!feed.title && !feed.episodes.length) throw new Error('返回内容不是可识别的 RSS。');
    if (!stillOpen()) return;
    card.innerHTML = onlineDetailHTML(result, feed, '');
  } catch (err) {
    if (!stillOpen()) return;
    card.innerHTML = onlineDetailHTML(result, null, '无法读取节目详情：' + err.message);
  }
}
function openOnlineDetail(feedUrl) {
  const result = [...(app.online.results || []), ...(app.chart?.rows || [])]
    .find(item => item && item.feedUrl && feedKey(item.feedUrl) === feedKey(feedUrl));
  if (!result) return;
  const builtin = findBuiltinForTitle(result.title, app.builtinShows) || findBuiltinByFeed(result.feedUrl);
  if (builtin) { navigate('podcast', [builtin.slug]); return; }
  const subscribed = subscribedShowForFeed(result.feedUrl);
  if (subscribed) { navigate('podcast', [subscribed.slug]); return; }
  openOnlinePreview(result);
}
function renderOnlineResults() {
  const box = $('onlineResults');
  if (!box) return;
  const online = app.online;
  const input = $('onlineSearchInput');
  if (input && document.activeElement !== input && input.value !== online.query) input.value = online.query;
  const source = $('onlineSource');
  if (source) {
    source.textContent = online.loading ? '正在搜索…'
      : online.sources.length
        ? '来源：' + online.sources.join(' · ') + (online.piError ? '（Podcast Index 不可用）' : '') +
          (online.results.length ? ' · ' + online.results.length + ' 个结果' : '')
        : 'Apple Podcasts · Podcast Index';
  }
  if (online.loading) {
    box.innerHTML = '<div class="online-state">' + loaderHTML('正在搜索线上播客…') + '</div>';
    return;
  }
  if (online.error) {
    box.innerHTML = '<div class="online-state err">' + esc(online.error) +
      '<div style="margin-top:10px"><button class="btn ghost small" data-retry-online>重试</button></div></div>';
    return;
  }
  if (!online.query) { box.replaceChildren(); return; }
  if (!online.results.length) {
    box.innerHTML = '<div class="online-state">没有找到“' + esc(online.query) + '”相关的播客。</div>';
    return;
  }
  const visible = Math.max(ONLINE_PAGE, Number(online.visible) || ONLINE_PAGE);
  const shown = online.results.slice(0, visible);
  const rest = online.results.length - shown.length;
  box.innerHTML = shown.map(onlineRowHTML).join('') +
    (rest > 0
      ? '<div class="online-more"><button class="btn ghost small" data-online-more>加载更多（还有 ' +
        rest + ' 个）</button></div>'
      : '');
}
function subscribeFromOnline(feedUrl) {
  if (!feedUrl) return;
  const subscribed = subscribedShowForFeed(feedUrl);
  if (subscribed) { navigate('podcast', [subscribed.slug]); return; }
  addFeedFromUrl(feedUrl);
}

/* ---------- rankings（桌面版发现页） ---------- */
const CHART_TTL = 60 * 60 * 1000;
const CHART_PREFS_KEY = 'myt-chart-prefs';
const CHART_ROWS_PREFIX = 'myt-chart-rows:';
const CHART_STORES = [
  ['cn', '中国大陆'], ['us', '美国'], ['gb', '英国'], ['jp', '日本'], ['kr', '韩国'],
  ['hk', '中国香港'], ['tw', '中国台湾'], ['sg', '新加坡'], ['ca', '加拿大'], ['au', '澳大利亚'],
  ['de', '德国'], ['fr', '法国'], ['es', '西班牙'], ['it', '意大利'], ['nl', '荷兰'],
  ['se', '瑞典'], ['br', '巴西'], ['mx', '墨西哥'], ['in', '印度'], ['ae', '阿联酋'],
  ['za', '南非'], ['nz', '新西兰'],
];
const CHART_CATEGORIES = [
  { id: '1318', name: '科技' }, { id: '1321', name: '商业' }, { id: '1303', name: '喜剧' },
  { id: '1489', name: '新闻' }, { id: '1324', name: '社会与文化' }, { id: '1533', name: '科学' },
  { id: '1512', name: '健康' }, { id: '1487', name: '历史' }, { id: '1488', name: '真实犯罪' },
  { id: '1301', name: '艺术' },
];
let chartPrefsLoaded = false;
function chartSupported() {
  const bridge = host();
  return !!(bridge && typeof bridge.httpText === 'function');
}
function ensureChartState() {
  if (!app.chart.categories.length) app.chart.categories = CHART_CATEGORIES;
  if (chartPrefsLoaded) return;
  chartPrefsLoaded = true;
  const saved = readJSON(CHART_PREFS_KEY, null);
  if (!saved || typeof saved !== 'object') return;
  if (['charts', 'online', 'catalog'].includes(saved.tab)) app.chart.tab = saved.tab;
  if (CHART_STORES.some(([id]) => id === saved.storefront)) app.chart.storefront = saved.storefront;
  if (typeof saved.category === 'string') app.chart.category = saved.category;
  if (!chartSupported() && app.chart.tab === 'charts') app.chart.tab = 'online';
}
function saveChartPrefs() {
  writeJSON(CHART_PREFS_KEY, {
    tab: app.chart.tab, storefront: app.chart.storefront, category: app.chart.category,
  });
}
function chartStoreName(id) {
  return (CHART_STORES.find(([key]) => key === id) || [id, id])[1];
}
function chartCategoryName(id) {
  return (app.chart.categories.find(cat => cat.id === id) || {}).name || '';
}
function chartRowsKey(storefront, category) {
  return CHART_ROWS_PREFIX + storefront + ':' + (category || 'top');
}
function chartUpdatedAt(at) {
  if (!at) return '';
  try {
    return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch (e) { return ''; }
}
function nativeText(url, timeoutMs = 12000) {
  const bridge = host();
  if (!bridge || typeof bridge.httpText !== 'function') {
    return Promise.reject(new Error('排行榜仅在桌面版可用'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('请求超时')), timeoutMs);
    bridge.httpText(url).then(value => { clearTimeout(timer); resolve(value); },
      err => { clearTimeout(timer); reject(err instanceof Error ? err : new Error(String(err))); });
  });
}
function appleChartUrl(storefront) {
  return 'https://rss.applemarketingtools.com/api/v2/' + encodeURIComponent(storefront) +
    '/podcasts/top/50/podcasts.json';
}
async function fetchAppleChart(storefront) {
  let text;
  try {
    text = await nativeText(appleChartUrl(storefront), 20000);
  } catch (err) {
    throw new Error('Apple 榜单：' + (err.message || '请求失败'), { cause: err });
  }
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw new Error('Apple 榜单：返回格式无法解析'); }
  const items = Array.isArray(doc?.feed?.results) ? doc.feed.results : [];
  return items.filter(item => item && item.id).map((item, index) => ({
    rank: index + 1,
    title: item.name || 'Unknown',
    author: item.artistName || '',
    feedUrl: '',
    image: item.artworkUrl100 || '',
    imageSmall: item.artworkUrl100 || '',
    genre: Array.isArray(item.genres) ? (item.genres[0]?.name || '') : '',
    episodeCount: 0,
    description: '',
    source: 'apple',
    appleId: String(item.id),
    appleUrl: item.url || '',
  }));
}
async function resolveAppleFeeds(rows, storefront) {
  const ids = rows.map(row => row.appleId).filter(Boolean);
  const found = new Map();
  for (let start = 0; start < ids.length; start += 50) {
    const chunk = ids.slice(start, start + 50);
    try {
      const doc = await fetchJson('https://itunes.apple.com/lookup?id=' + chunk.join(',') +
        '&entity=podcast&country=' + encodeURIComponent(storefront), {}, 10000);
      (Array.isArray(doc?.results) ? doc.results : []).forEach(item => {
        if (item?.feedUrl) found.set(String(item.collectionId), item);
      });
    } catch (e) { /* 单批失败继续，最后按解析结果计数 */ }
  }
  const resolved = rows.map(row => {
    const item = found.get(row.appleId);
    if (!item) return row;
    return {
      ...row,
      feedUrl: item.feedUrl,
      title: item.collectionName || row.title,
      author: item.artistName || row.author,
      image: item.artworkUrl600 || item.artworkUrl100 || row.image,
      imageSmall: item.artworkUrl100 || row.imageSmall,
      genre: item.primaryGenreName || row.genre,
      episodeCount: Number(item.trackCount) || 0,
    };
  }).filter(row => row.feedUrl);
  return { rows: resolved, skipped: rows.length - resolved.length };
}
function appleGenreChartUrl(storefront, genreId) {
  return 'https://itunes.apple.com/' + encodeURIComponent(storefront) +
    '/rss/toppodcasts/limit=50/genre=' + encodeURIComponent(genreId) + '/json';
}
async function fetchAppleGenreChart(storefront, genreId) {
  let text;
  try {
    text = await nativeText(appleGenreChartUrl(storefront, genreId), 20000);
  } catch (err) {
    throw new Error('Apple 分类榜：' + (err.message || '请求失败'), { cause: err });
  }
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw new Error('Apple 分类榜：返回格式无法解析'); }
  const entries = Array.isArray(doc?.feed?.entry) ? doc.feed.entry : [];
  return entries.filter(entry => entry?.['im:name']?.label).map((entry, index) => {
    const images = Array.isArray(entry['im:image']) ? entry['im:image'] : [];
    const art = (images[images.length - 1] || {}).label || '';
    const appleId = String(entry.id?.attributes?.['im:id'] || '');
    return {
      rank: index + 1,
      title: entry['im:name'].label,
      author: entry['im:artist']?.label || '',
      feedUrl: '',
      image: art,
      imageSmall: art,
      genre: entry.category?.attributes?.label || entry.category?.attributes?.term || '',
      episodeCount: 0,
      description: entry.summary?.label || '',
      source: 'apple',
      appleId,
      appleUrl: entry.link?.attributes?.href || '',
    };
  }).filter(row => row.appleId);
}
function ensureChartCategories() {
  const chart = app.chart;
  if (!chart.categories.length) chart.categories = CHART_CATEGORIES;
  return chart.categories;
}
async function loadChart(force = false) {
  ensureChartState();
  if (!chartSupported()) return;
  const chart = app.chart;
  if (chart.loading && !force) return;
  const key = chartRowsKey(chart.storefront, chart.category);
  const cached = readJSON(key, null);
  if (!force && Array.isArray(cached?.rows) && cached.rows.length && Date.now() - (Number(cached.at) || 0) < CHART_TTL) {
    Object.assign(chart, { rows: cached.rows, at: Number(cached.at) || 0, loading: false, error: '', note: '' });
    renderChartPanel();
    return;
  }
  const seq = ++chart.seq;
  Object.assign(chart, { loading: true, error: '', note: '' });
  renderChartPanel();
  if (!chart.categories.length) ensureChartCategories();
  try {
    let rows;
    let note = '';
    if (chart.category) {
      ensureChartCategories();
      if (!chart.categories.some(cat => cat.id === chart.category)) throw new Error('分类榜暂不可用');
      const storefront = chart.storefront;
      const result = await resolveAppleFeeds(
        await fetchAppleGenreChart(storefront, chart.category), storefront);
      rows = result.rows;
      if (result.skipped) note = result.skipped + ' 条未能解析订阅地址，已跳过';
    } else {
      const storefront = chart.storefront;
      const result = await resolveAppleFeeds(await fetchAppleChart(storefront), storefront);
      rows = result.rows;
      if (result.skipped) note = result.skipped + ' 条未能解析订阅地址，已跳过';
    }
    if (seq !== chart.seq) return;
    if (!rows.length) throw new Error('榜单暂无数据');
    Object.assign(chart, { rows, at: Date.now(), loading: false, error: '', note });
    writeJSON(key, { at: chart.at, rows });
  } catch (err) {
    if (seq !== chart.seq) return;
    const fallback = readJSON(key, null);
    const hasFallback = Array.isArray(fallback?.rows) && fallback.rows.length;
    Object.assign(chart, {
      loading: false,
      rows: hasFallback ? fallback.rows : [],
      at: hasFallback ? (Number(fallback.at) || 0) : 0,
      error: (err?.message || '榜单加载失败') + (hasFallback ? '（显示上次缓存）' : ''),
    });
  }
  renderChartPanel();
}
function syncDiscoverTabs() {
  ensureChartState();
  const tabs = $('discoverTabs');
  if (!tabs) return;
  const supported = chartSupported();
  if (!supported) {
    /* 网页版没有排行榜：不显示 tab 条，恢复原来的「在线搜索 + 本站目录」两段式。 */
    tabs.hidden = true;
    const chart = $('discoverChartCard');
    if (chart) chart.hidden = true;
    const online = $('discoverOnlineCard');
    if (online) online.hidden = false;
    const catalog = $('discoverCatalogCard');
    if (catalog) catalog.hidden = false;
    const grid = $('discoverGrid');
    if (grid) grid.hidden = false;
    const ext = $('discoverExt');
    if (ext) ext.hidden = false;
    return;
  }
  tabs.hidden = false;
  const chartTab = tabs.querySelector('[data-discover-tab="charts"]');
  if (chartTab) chartTab.hidden = false;
  [...tabs.querySelectorAll('[data-discover-tab]')].forEach(btn => {
    btn.classList.toggle('active', btn.dataset.discoverTab === app.chart.tab);
  });
  const online = $('discoverOnlineCard');
  if (online) online.hidden = app.chart.tab !== 'online';
  const catalog = $('discoverCatalogCard');
  if (catalog) catalog.hidden = app.chart.tab !== 'catalog';
  const grid = $('discoverGrid');
  if (grid) grid.hidden = app.chart.tab !== 'catalog';
  const ext = $('discoverExt');
  if (ext) ext.hidden = app.chart.tab !== 'catalog';
}
function renderChartPanel() {
  syncDiscoverTabs();
  if (!chartSupported()) return;
  const card = $('discoverChartCard');
  if (!card) return;
  card.hidden = app.chart.tab !== 'charts';
  if (card.hidden) return;
  const chart = app.chart;
  const select = $('chartStorefront');
  if (select) {
    if (!select.options.length) {
      select.innerHTML = CHART_STORES.map(([id, name]) =>
        '<option value="' + esc(id) + '">' + esc(name) + '</option>').join('');
    }
    select.value = chart.storefront;
  }
  const chips = $('chartChips');
  if (chips) {
    chips.innerHTML = chart.categories.length
      ? chart.categories.map(cat => '<button class="' + (cat.id === chart.category ? 'active' : '') +
        '" data-chart-chip="' + esc(cat.id) + '">' + esc(cat.name) + '</button>').join('')
      : '<span class="smalltext">分类榜暂不可用，先看总榜。</span>';
  }
  const meta = $('chartMeta');
  if (meta) {
    const parts = [];
    parts.push(chart.category
      ? 'Apple Podcasts 分类榜 · ' + (chartCategoryName(chart.category) || '分类') + ' · 前 50'
      : 'Apple Podcasts 总榜 · ' + chartStoreName(chart.storefront) + ' · 前 50');
    if (chart.at) parts.push('更新于 ' + chartUpdatedAt(chart.at));
    if (chart.note) parts.push(chart.note);
    meta.textContent = parts.join(' · ');
  }
  const errBox = $('chartError');
  if (errBox) {
    if (chart.error) {
      errBox.hidden = false;
      errBox.innerHTML = '<div class="online-state err">' + esc(chart.error) +
        '<div style="margin-top:10px"><button class="btn ghost small" data-retry-chart>重试</button></div></div>';
    } else {
      errBox.hidden = true;
      errBox.replaceChildren();
    }
  }
  const box = $('chartResults');
  if (!box) return;
  if (chart.loading) {
    box.innerHTML = '<div class="online-state">' + loaderHTML('正在读取榜单…') + '</div>';
    return;
  }
  if (!chart.rows.length) {
    if (!chart.error) setTimeout(() => loadChart(false), 0);
    box.innerHTML = '<div class="online-state">还没有榜单数据。' +
      '<div style="margin-top:10px"><button class="btn ghost small" data-retry-chart>重试</button></div></div>';
    return;
  }
  box.innerHTML = chart.rows.map(row => onlineRowHTML(row, row.rank)).join('');
}
function setDiscoverTab(tab) {
  if (!['charts', 'online', 'catalog'].includes(tab)) return;
  if (tab === 'charts' && !chartSupported()) tab = 'online';
  app.chart.tab = tab;
  saveChartPrefs();
  renderChartPanel();
  if (tab === 'charts' && !app.chart.rows.length && !app.chart.loading) loadChart(false);
}
function setChartStorefront(storefront) {
  if (!CHART_STORES.some(([id]) => id === storefront)) return;
  app.chart.storefront = storefront;
  app.chart.category = '';
  app.chart.rows = [];
  app.chart.at = 0;
  app.chart.error = '';
  saveChartPrefs();
  loadChart(true);
}
function setChartCategory(category) {
  app.chart.category = app.chart.category === category ? '' : category;
  app.chart.rows = [];
  app.chart.at = 0;
  app.chart.error = '';
  saveChartPrefs();
  loadChart(true);
}
export { COVER_GRADS, CHART_STORES, CHART_TTL, FEED_CACHE_TTL, ONLINE_PAGE, PODCAST_INDEX, appleChartUrl, appleGenreChartUrl, appleSearchUrl, buildOpml, catalogFields, chartSupported, checkSubscriptions, copyText, coverGrad, coverHTML, decodeXml, downloadFile, ensureChartCategories, ensureShowFeed, episodeCover, exportOpml, exportSubtitle, feedCacheFresh, feedCacheGet, feedCachePut, feedDb, feedDbPromise, feedKey, fetchAppleChart, fetchAppleGenreChart, fetchFeedText, fetchJson, findBuiltinForTitle, hasFreshFeed, initialsOf, loadCatalog, loadChart, loadLocalState, mapAppleResults, mapPodcastIndexResults, memoryFeed, mergeCatalog, mergeSearchMeta, mergeSearchResults, onlineDetailHTML, onlinePreviewSeq, onlineRowHTML, openOnlineDetail, openOnlinePreview, parseOpml, podcastIndexAuth, podcastIndexSearchUrl, rememberFeed, renderChartPanel, renderOnlineResults, resolveAppleFeeds, runOnlineSearch, searchApple, searchPodcastIndex, searchTitleKey, setChartCategory, setChartStorefront, setDiscoverTab, sha1Hex, shareCurrentCue, stamp, subscribeFromOnline, subscribedShowForFeed, syncDiscoverTabs };
registerLayer('06-catalog-feeds-search', { COVER_GRADS, CHART_STORES, CHART_TTL, FEED_CACHE_TTL, ONLINE_PAGE, PODCAST_INDEX, appleChartUrl, appleGenreChartUrl, appleSearchUrl, buildOpml, catalogFields, chartSupported, checkSubscriptions, copyText, coverGrad, coverHTML, decodeXml, downloadFile, ensureChartCategories, ensureShowFeed, episodeCover, exportOpml, exportSubtitle, feedCacheFresh, feedCacheGet, feedCachePut, feedDb, feedDbPromise, feedKey, fetchAppleChart, fetchAppleGenreChart, fetchFeedText, fetchJson, findBuiltinForTitle, hasFreshFeed, initialsOf, loadCatalog, loadChart, loadLocalState, mapAppleResults, mapPodcastIndexResults, memoryFeed, mergeCatalog, mergeSearchMeta, mergeSearchResults, onlineDetailHTML, onlinePreviewSeq, onlineRowHTML, openOnlineDetail, openOnlinePreview, parseOpml, podcastIndexAuth, podcastIndexSearchUrl, rememberFeed, renderChartPanel, renderOnlineResults, resolveAppleFeeds, runOnlineSearch, searchApple, searchPodcastIndex, searchTitleKey, setChartCategory, setChartStorefront, setDiscoverTab, sha1Hex, shareCurrentCue, stamp, subscribeFromOnline, subscribedShowForFeed, syncDiscoverTabs });
