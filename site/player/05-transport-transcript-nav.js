import { $, ASR_MODEL_DEFAULT, LIVE, audio, box, host, prefs, setState, state, tauriHost } from './00-runtime.js';
import { alignZhLines, applyReader, clearProgress, closeDetails, closeDrawer, closeOverlays, closeTypeSheet, cuesFromJson, directAudioUrl, emptyLine, epKey, esc, findNorm, fmt, getJson, isJsonTranscript, onAudioError, openDetails, openDrawer, paint, parseFeed, progressAll, rawSeek, reader, rebuildCues, rememberOverlayTrigger, renderCueWindow, renderCues, restoreOverlayFocus, saveProgress, scrollCue, seekTo, setImmersive, setWallpaper, showToast, status, stopScroll, syncJumpPill, syncWallpaperPlay, toggleWallpaperPlay, transcriptMirror, updateTimeScale } from './01-theme-reader-shell.js';
import { coreProvider, defineCoreProvider } from './02-live-caption-wasm.js';
import { findSkipRange, liveDisable, skipUrlOf } from './03-native-asr-service-worker.js';
import { loadShow, renderList, studyPluginOn, subtitlePluginOn } from './04-local-audio-plugin-host.js';
import { motionEnter, motionFlip, motionLeave } from './11-motion.js';




import { layerValue, lazyFn, registerLayer } from './00-layers.js';
const feedKey = lazyFn('06-catalog-feeds-search', 'feedKey');
const fetchFeedText = lazyFn('06-catalog-feeds-search', 'fetchFeedText');
const memoryFeed = lazyFn('06-catalog-feeds-search', 'memoryFeed');
const rememberFeed = lazyFn('06-catalog-feeds-search', 'rememberFeed');
const TR = lazyFn('07-routes-pages', 'TR');
const renderPage = lazyFn('07-routes-pages', 'renderPage');
const renderSearch = lazyFn('07-routes-pages', 'renderSearch');
const saveQueue = lazyFn('07-routes-pages', 'saveQueue');
const syncTranslateSettings = lazyFn('07-routes-pages', 'syncTranslateSettings');
const trSave = lazyFn('07-routes-pages', 'trSave');
const bindWordStatusButtons = lazyFn('08-study-ai', 'bindWordStatusButtons');
const closeStudySheet = lazyFn('08-study-ai', 'closeStudySheet');
const openStudySheet = lazyFn('08-study-ai', 'openStudySheet');
const wordStatusHTML = lazyFn('08-study-ai', 'wordStatusHTML');
const stepEpisode = lazyFn('09-player-integration', 'stepEpisode');
const syncMini = lazyFn('09-player-integration', 'syncMini');
const autoCleanup = lazyFn('10-desktop-bridge-tail', 'autoCleanup');
const closeModal = lazyFn('10-desktop-bridge-tail', 'closeModal');
const desktopNotify = lazyFn('10-desktop-bridge-tail', 'desktopNotify');
const openModal = lazyFn('10-desktop-bridge-tail', 'openModal');
const playEpisode = lazyFn('10-desktop-bridge-tail', 'playEpisode');
const playNextAuto = lazyFn('10-desktop-bridge-tail', 'playNextAuto');
const savePrefs = lazyFn('10-desktop-bridge-tail', 'savePrefs');
const setSleep = lazyFn('10-desktop-bridge-tail', 'setSleep');
/* layer: view —— transport、进度、文字稿交互、章节、离线与模型管理
   本片只做该层的事，跨层调用走 kernel / host() / setState。 */

/* transport */
$('play').onclick = () => {
  if (!state.current) { openDrawer(); return; }
  if (!audio.getAttribute('src')) { status('该集没有音频地址。', 'warn'); showToast('该集没有音频地址。'); return; }
  audio.paused
    ? audio.play().catch(e => { status('播放失败：' + e.message, 'warn'); showToast('播放失败：' + e.message); })
    : audio.pause();
};
audio.addEventListener('play', () => { $('play').classList.add('playing'); $('play').setAttribute('aria-label','暂停'); document.body.classList.add('playing'); syncWallpaperPlay(); });
audio.addEventListener('pause', () => { $('play').classList.remove('playing'); $('play').setAttribute('aria-label','播放'); document.body.classList.remove('playing'); saveProgress(true); syncWallpaperPlay(); });
let buffering = false;
function setBuffering(on) {
  if (buffering === on) return;
  buffering = on;
  document.body.classList.toggle('buffering', on);
  $('play').classList.toggle('buffering', on);
  $('play').setAttribute('aria-label', on ? '正在缓冲' : (audio.paused ? '播放' : '暂停'));
}
audio.addEventListener('waiting', () => { if (!audio.paused) setBuffering(true); });
audio.addEventListener('stalled', () => { if (!audio.paused) setBuffering(true); });
audio.addEventListener('seeking', () => { if (!audio.paused) setBuffering(true); });
audio.addEventListener('playing', () => setBuffering(false));
audio.addEventListener('canplay', () => setBuffering(false));
audio.addEventListener('pause', () => setBuffering(false));
audio.addEventListener('emptied', () => setBuffering(false));
audio.addEventListener('loadedmetadata', () => {
  if (state.current && state.resumeEp === state.current.id && audio.dataset.ep === state.current.id) {
    const t = state.resumeAt;
    setState('resumeEp', ''); setState('resumeAt', 0);
    const dur = audio.duration;
    if (t > 5 && Number.isFinite(dur) && dur > 0 && t < dur - 10) {
      audio.currentTime = t;
      setState('seekRaw', t);
      setState('pendingFollow', true);
    }
  }
  if (app.pendingSeek > 0 && app.pendingSeekEp === audio.dataset.ep) {
    const dur = audio.duration;
    if (Number.isFinite(dur) && dur > 0) {
      audio.currentTime = Math.min(app.pendingSeek, Math.max(0, dur - 1));
      setState('seekRaw', audio.currentTime);
      setState('pendingFollow', true);
    }
    app.pendingSeek = 0;
    app.pendingSeekEp = '';
  } else if (app.pendingSeekEp && app.pendingSeekEp !== audio.dataset.ep) {
    // 目标集换了（比如上一集的跳转没来得及生效）：别把这个时间点带到下一集。
    app.pendingSeek = 0;
    app.pendingSeekEp = '';
  }
  updateTimeScale(); paint(false);
});
audio.addEventListener('timeupdate', () => {
  // 播放时有 8Hz 播放时钟负责重绘；timeupdate 只做写盘和规则，避免重复 paint。
  if (!document.hidden && !playTick) paint();
  saveProgress(false); applySkipRules(); skipSilenceTick(audio.currentTime || 0);
});
audio.addEventListener('seeked', () => saveProgress(true));
audio.addEventListener('ended', () => {
  markCurrentPlayed();
  clearProgress(); paint(true);
  if (app.auto.deletePlayed) setTimeout(() => autoCleanup(), 1200);
});
audio.addEventListener('error', () => { onAudioError(); });
window.addEventListener('pagehide', () => saveProgress(true));
document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress(true); });
function seekBy(seconds) {
  const t = (audio.currentTime || 0) + (state.timeScale - 1) * state.seekRaw + seconds;
  rawSeek(t / (state.timeScale || 1));
  paint(true);
}
function applySkipRules() {
  if (!state.current || audio.paused) return;
  const pref = showPrefFor(state.show?.slug);
  const dur = Number(audio.duration) || 0;
  const now = audio.currentTime || 0;
  if (Number(pref.skipIntro) > 0 && !state.introSkipped && now > 0.2 && now < Number(pref.skipIntro)) {
    setState('introSkipped', true);
    rawSeek(Number(pref.skipIntro));
    return;
  }
  if (prefs.skipAds && state.skipPlan && state.skipPlan.ranges.length) {
    const hit = findSkipRange(now);
    if (hit) {
      state.skipDone.add(hit.id);
      rawSeek(Math.min(hit.end, now + 120));
      showToast('已跳过「' + (hit.label || hit.tag) + '」' + fmt(hit.end - hit.start) + '（可在设置关闭）', 3000);
      return;
    }
  }
  // 没有逐句标签的集沿用旧行为：AI 区间 + 文字稿关键词。
  if (prefs.skipAds && Array.isArray(state.adRanges) && state.adRanges.length) {
    const index = state.adRanges.findIndex(range => now >= range.start && now < range.end - 0.3);
    if (index >= 0 && !state.adSkipped?.has(index)) {
      setState('adSkipped', state.adSkipped || new Set());
      state.adSkipped.add(index);
      rawSeek(state.adRanges[index].end);
      return;
    }
  }
  if (prefs.skipChapterAds && Array.isArray(state.chapters) && state.chapters.length) {
    setState('chapterAdsSkipped', state.chapterAdsSkipped || new Set());
    const ci = state.chapters.reduce((cur, c, i) => (now + 0.4 >= c.start ? i : cur), -1);
    const chapter = ci >= 0 ? state.chapters[ci] : null;
    if (chapter && now - chapter.start < 25 && !state.chapterAdsSkipped.has(ci) && /(^|\b)(ads?|advert\w*|sponsor\w*|intro|outro)\b|广告|赞助|推广|片头|片尾/i.test(chapter.title || '')) {
      state.chapterAdsSkipped.add(ci);
      const next = state.chapters[ci + 1];
      const target = next ? next.start : dur;
      if (target > now) { rawSeek(target); return; }
    }
  }
  if (Number(pref.skipOutro) > 0 && dur > 0 && !state.outroSkipped && dur - now <= Number(pref.skipOutro)) {
    setState('outroSkipped', true);
    if (app.cont !== 'single') playNextAuto(app.cont === 'radio');
    else audio.pause();
  }
}
$('back').onclick = () => seekBy(-15);
$('forward').onclick = () => seekBy(30);
/* ---- 底栏「⋯」工具面板：速度/高亮/实时/详情/列表/排版/沉浸/主题全部在这里，
        任何时刻只允许一个二级面板打开（openDockSheet 负责关掉其它三个）。 ---- */
const dockSheet = $('dockSheet'), dockToolsBtn = $('dockToolsBtn');
function syncDockBadge() {
  const bits = [];
  if (prefs.muted) bits.push('静音');
  if (LIVE.on) bits.push('实时');
  const badge = $('dockBadge');
  badge.textContent = bits.join(' · ');
  badge.hidden = !bits.length;
  dockToolsBtn.setAttribute('aria-label', bits.length ? '播放工具（' + bits.join('、') + '）' : '播放工具');
  const modeLabel = $('dockModeLabel');
  if (modeLabel) modeLabel.textContent = state.mode === 'sentence' ? '逐句' : '逐词';
  const modeBtn = $('dockModeBtn');
  if (modeBtn) {
    modeBtn.classList.toggle('on', state.mode === 'sentence');
    modeBtn.setAttribute('aria-pressed', String(state.mode === 'sentence'));
  }
  syncDockLang();
}
function syncDockLang() {
  const btn = $('dockLangBtn'), label = $('dockLangLabel');
  if (!btn) return;
  const on = reader.lang === 'both';
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', String(on));
  btn.setAttribute('aria-label', on ? '关闭双语字幕' : '开启双语字幕');
  if (label) label.textContent = on ? '双语' : (reader.lang === 'zh' ? '中文' : 'EN');
}
function openDockSheet() {
  if (dockSheet.classList.contains('on')) return;
  rememberOverlayTrigger('dockSheet', dockSheet);
  closeDrawer(false); closeDetails(false); closeTypeSheet(false);
  dockSheet.removeAttribute('inert');
  dockSheet.classList.add('on');
  dockSheet.setAttribute('aria-hidden', 'false');
  dockToolsBtn.setAttribute('aria-expanded', 'true');
  syncDockBadge();
  syncRateSeg();
  syncVolUI();
  syncDockSleep();
  $('dockSheetClose').focus();
}
function closeDockSheet(restore = true) {
  const had = dockSheet.classList.contains('on');
  const hadFocus = dockSheet.contains(document.activeElement);
  dockSheet.classList.remove('on');
  dockSheet.setAttribute('aria-hidden', 'true');
  dockSheet.setAttribute('inert', '');
  dockToolsBtn.setAttribute('aria-expanded', 'false');
  if (restore && had && hadFocus) restoreOverlayFocus('dockSheet');
}
dockToolsBtn.onclick = e => {
  e.stopPropagation();
  dockSheet.classList.contains('on') ? closeDockSheet() : openDockSheet();
};
$('dockSheetClose').onclick = () => closeDockSheet();
document.addEventListener('click', e => {
  if (!dockSheet.classList.contains('on')) return;
  if (e.target.closest('#dockSheet') || e.target.closest('#dockToolsBtn')) return;
  closeDockSheet(false);
});
function syncRateSeg() {
  const rate = Number(prefs.speed) || 1;
  const seg = $('rateSeg');
  if (seg) [...seg.children].forEach(b => b.setAttribute('aria-checked', String(Number(b.dataset.rate) === rate)));
  const sel = $('setSpeed'); if (sel) sel.value = String(rate);
  const label = $('dockRateLabel'); if (label) label.textContent = rate + '×';
  const btn = $('dockRateBtn'); if (btn) btn.setAttribute('aria-label', '播放速度（当前 ' + rate + ' 倍）');
}
const DOCK_RATES = [1, 1.25, 1.5, 1.75, 2, 0.75];
$('dockRateBtn').onclick = () => {
  const cur = Number(prefs.speed) || 1;
  const at = DOCK_RATES.indexOf(cur);
  applyRate(DOCK_RATES[(at >= 0 ? at + 1 : 0) % DOCK_RATES.length]);
};
function applyRate(rate, persist = true) {
  const r = Number(rate) || 1;
  audio.playbackRate = r;
  prefs.speed = r;
  if (persist) savePrefs();
  syncRateSeg();
  syncDockBadge();
}
const rateSegEl = $('rateSeg');
if (rateSegEl) rateSegEl.addEventListener('click', e => {
  const b = e.target.closest('button[data-rate]');
  if (b) applyRate(b.dataset.rate);
});

/* ---- 进度条：拖动只预览（时间气泡跟着走），松手才 seek；双击回到当前句 ---- */
const trackEl = $('track'), seekTip = $('seekTip');
const seekDur = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (state.audioSeconds || 0));
function seekPreviewAt(pct) {
  pct = Math.min(1, Math.max(0, pct));
  setState('seekPreview', pct);
  const dur = seekDur();
  const text = fmt(pct * dur);
  $('now').textContent = text;
  $('pfill').style.width = (pct * 100).toFixed(2) + '%';
  seekTip.textContent = text;
  seekTip.style.left = (pct * 100).toFixed(2) + '%';
  seekTip.classList.add('on');
  $('seek').setAttribute('aria-valuetext', text + ' / ' + fmt(dur));
}
function endSeekPreview(commit) {
  const pct = state.seekPreview;
  setState('seekPreview', null);
  // 预览期间是直接写 DOM 的，缓存必须作废，否则松手后的 paint 会以为「没变」而不落值。
  setState('lastNowText', null); setState('lastAriaText', null); setState('lastSeekBucket', -1);
  seekTip.classList.remove('on');
  if (commit && pct != null && seekDur() > 0) {
    rawSeek(pct * seekDur());
    paint(true);
    saveProgress(true);
  }
}
$('seek').addEventListener('input', () => seekPreviewAt(Number($('seek').value) / 1000));
$('seek').addEventListener('change', () => endSeekPreview(true));
$('seek').addEventListener('pointercancel', () => endSeekPreview(false));
$('seek').addEventListener('blur', () => { if (state.seekPreview != null) { endSeekPreview(false); paint(true); } });
trackEl.addEventListener('dblclick', e => {
  e.preventDefault();
  const cue = state.cues[state.activeCue];
  if (!cue) { showToast('这一集还没有可跳回的句子。', 2600); return; }
  endSeekPreview(false);
  seekTo(cue.speechStart + state.offset);
  showToast('回到当前句 · ' + fmt(cue.speechStart + state.offset), 1800);
});

/* ---- 音量 / 静音（原来整个播放页没有音量入口，只有系统音量） ---- */
function syncVolUI() {
  const muted = !!prefs.muted;
  const vol = Number.isFinite(prefs.volume) ? prefs.volume : 1;
  const pct = Math.round(vol * 100);
  $('volRange').value = String(muted ? 0 : pct);
  $('volOut').textContent = muted ? '静音' : pct + '%';
  $('muteBtn').setAttribute('aria-pressed', String(muted));
  $('muteBtn').setAttribute('aria-label', muted ? '取消静音' : '静音');
}
function applyVolume(persist = true) {
  audio.volume = Math.min(Number(prefs.volumeCap) || 1, 1, Math.max(0, Number.isFinite(prefs.volume) ? prefs.volume : 1));
  audio.muted = !!prefs.muted;
  if (persist) savePrefs();
  syncVolUI();
  syncDockBadge();
}
/* ---- 实验性：本地/离线音频的 WebAudio 图（跳过静音、响度均衡） ---- */
let webAudioGraph = null;
function canAnalyseAudio() {
  try {
    const u = new URL(audio.src || audio.currentSrc || '', location.href);
    return u.origin === location.origin || u.hostname === 'asset.localhost' || u.protocol === 'asset:' || u.protocol === 'tauri:';
  } catch (e) { return false; }
}
function ensureAudioGraph() {
  if (webAudioGraph) return webAudioGraph;
  if (!canAnalyseAudio()) return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    const ctx = new AC();
    const source = ctx.createMediaElementSource(audio);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -26; comp.knee.value = 26; comp.ratio.value = 4;
    comp.attack.value = 0.004; comp.release.value = 0.22;
    const gain = ctx.createGain(); gain.gain.value = 1.12;
    const analyser = ctx.createAnalyser(); analyser.fftSize = 512;
    source.connect(gain); gain.connect(ctx.destination); gain.connect(analyser);
    webAudioGraph = { ctx, source, comp, gain, analyser, loudness: false, quietSince: 0, lastSkip: 0 };
    ctx.resume().catch(() => {});
    return webAudioGraph;
  } catch (e) { return null; }
}
function applyLoudness(enabled) {
  if (!enabled) {
    if (webAudioGraph && webAudioGraph.loudness) {
      try {
        webAudioGraph.source.disconnect();
        webAudioGraph.source.connect(webAudioGraph.gain);
        webAudioGraph.gain.connect(webAudioGraph.ctx.destination);
        webAudioGraph.loudness = false;
      } catch (e) {}
    }
    return true;
  }
  if (!canAnalyseAudio()) return false;
  const graph = ensureAudioGraph();
  if (!graph) return false;
  if (graph.loudness) return true;
  try {
    graph.source.disconnect();
    graph.source.connect(graph.comp);
    graph.comp.connect(graph.gain);
    graph.loudness = true;
    graph.ctx.resume().catch(() => {});
  } catch (e) { return false; }
  return true;
}
function skipSilenceTick(now) {
  if (!prefs.skipSilence) return;
  const graph = webAudioGraph;
  if (!graph || !graph.analyser) return;
  if (audio.paused || audio.seeking) return;
  const data = new Uint8Array(graph.analyser.fftSize);
  graph.analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
  const rms = Math.sqrt(sum / data.length);
  const quiet = rms < 0.008;   // 约 -42 dB
  if (!quiet) { graph.quietSince = 0; return; }
  if (!graph.quietSince) graph.quietSince = now;
  if (now - graph.quietSince > 1.2 && now - graph.lastSkip > 2) {
    graph.lastSkip = now;
    graph.quietSince = 0;
    rawSeek(Math.min(now + 0.9, audio.duration || now + 0.9));
  }
}
audio.addEventListener('play', () => { if (webAudioGraph) webAudioGraph.ctx.resume().catch(() => {}); });
function toggleMute() {
  prefs.muted = !prefs.muted;
  if (!prefs.muted && !(Number(prefs.volume) > 0)) prefs.volume = 0.5;
  applyVolume();
  showToast(prefs.muted ? '已静音（M 取消）' : '已取消静音', 1800);
}
$('muteBtn').onclick = toggleMute;
$('volRange').addEventListener('input', e => {
  const v = Number(e.target.value) / 100;
  prefs.volume = v;
  prefs.muted = v === 0 ? prefs.muted : false;
  // 拖动时每次 input 都同步写 localStorage 会拖慢手势，松手（change）再落盘。
  applyVolume(false);
});
$('volRange').addEventListener('change', () => applyVolume());

/* ---- 上一集 / 下一集（复用 stepEpisode，和迷你窗、媒体键同一套口径） ---- */
$('prevEpBtn').onclick = () => stepEpisode(-1);
$('nextEpBtn').onclick = () => stepEpisode(1);

/* ---- 睡眠定时：面板里给常用档，剩余时间直接写回标签 ---- */
function syncDockSleep() {
  const out = $('sleepOut');
  if (out) {
    let text = '';
    if (app.sleepEnd) text = '本集结束';
    else if (app.sleepUntil) text = '剩 ' + fmt(Math.max(1, Math.ceil((app.sleepUntil - Date.now()) / 1000)));
    out.textContent = text;
  }
  const quickLabel = $('dockSleepLabel');
  if (quickLabel) {
    quickLabel.textContent = app.sleepEnd ? '本集'
      : app.sleepUntil ? Math.max(1, Math.ceil((app.sleepUntil - Date.now()) / 60000)) + '′'
      : '睡眠';
  }
  const quickBtn = $('dockSleepBtn');
  if (quickBtn) {
    const on = !!(app.sleepEnd || app.sleepUntil);
    quickBtn.classList.toggle('on', on);
    quickBtn.setAttribute('aria-pressed', String(on));
  }
  // 30′/60′ 也要能被认出来：按剩余时间倒推（误差 1 分钟），否则只有「结束/关」会高亮。
  const remainMin = app.sleepUntil ? (app.sleepUntil - Date.now()) / 60000 : -1;
  const seg = $('sleepSeg');
  if (seg) [...seg.children].forEach(b => {
    const v = b.dataset.sleepQuick;
    const on = v === 'end' ? !!app.sleepEnd
      : v === 'off' ? (!app.sleepEnd && !app.sleepUntil)
      : (remainMin > 0 && Math.abs(remainMin - Number(v)) <= 1);
    b.classList.toggle('on', on);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(on));
  });
}
const sleepSegEl = $('sleepSeg');
if (sleepSegEl) sleepSegEl.addEventListener('click', e => {
  const b = e.target.closest('button[data-sleep-quick]');
  if (!b) return;
  const v = b.dataset.sleepQuick;
  setSleep(v === 'off' ? 'off' : v);
  syncDockSleep();
});
$('dockSleepBtn').onclick = () => {
  const remainMin = app.sleepUntil ? (app.sleepUntil - Date.now()) / 60000 : -1;
  const next = app.sleepEnd ? 'off'
    : app.sleepUntil ? (remainMin <= 30 ? '60' : 'end')
    : '30';
  setSleep(next);
};
$('scroll').onchange = e => {
  setState('scroll', e.target.value);
  try { localStorage.setItem('myt-scroll', state.scroll); } catch (err) {}
  if (state.scroll === 'off') { syncJumpPill(); return; }
  setState('userScrollUntil', 0);
  if (state.activeCue >= 0 && state.nodes[state.activeCue]) scrollCue(state.nodes[state.activeCue].el, true);
  syncJumpPill();
};
function setAlignMode(on, at = 0) {
  setState('alignMode', on);
  setState('alignAt', on ? at : 0);
  document.body.classList.toggle('aligning', on);
  $('alignCue').textContent = on ? '取消对齐' : '对齐到当前句';
  $('alignCue').setAttribute('aria-pressed', String(on));
}
function toggleAlignMode() {
  if (state.alignMode) { setAlignMode(false); showToast('已取消对齐。', 2500); return; }
  if (!state.current || !audio.getAttribute('src')) { showToast('该集没有音频地址。'); return; }
  if (!state.cues.length) { showToast('该集没有字幕。'); return; }
  setAlignMode(true, (audio.currentTime || 0) + (state.timeScale - 1) * state.seekRaw);
  showToast('点击一句应高亮的句子（已锁定当前播放位置，Esc 取消）', 8000);
}
function alignToCue(cue) {
  const offset = Math.round((state.alignAt - cue.speechStart) * 100) / 100;
  setState('offset', offset);
  $('offset').value = String(offset);
  setAlignMode(false);
  renderCues();
  showToast('偏移已设为 ' + offset.toFixed(2) + ' 秒', 4000);
}
$('alignCue').onclick = toggleAlignMode;
$('offset').addEventListener('change', e => { setState('offset', Number(e.target.value) || 0); renderCues(); });
function returnToCue() {
  setState('userScrollUntil', 0);
  setState('pendingFollow', false);
  stopScroll();
  if (state.activeCue >= 0 && state.nodes[state.activeCue]) scrollCue(state.nodes[state.activeCue].el, true);
  syncJumpPill();
}
$('follow').onclick = () => { returnToCue(); closeDetails(); };
$('search').addEventListener('input', e => renderList(e.target.value));
function setReadMode(mode) {
  if (mode !== 'word' && mode !== 'sentence') return;
  if (mode === state.mode) return;
  setState('mode', mode);
  try { localStorage.setItem('myt-mode', state.mode); } catch (err) {}
  const seg = $('modeSeg');
  if (seg) [...seg.children].forEach(b => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
  syncDockBadge();
  renderCues();
  paint(true);
}
const modeSegEl = $('modeSeg');
if (modeSegEl) modeSegEl.addEventListener('click', e => {
  const btn = e.target.closest('button[data-mode]');
  if (btn) setReadMode(btn.dataset.mode);
});
$('dockModeBtn').onclick = () => setReadMode(state.mode === 'word' ? 'sentence' : 'word');
$('dockLangBtn').onclick = () => {
  reader.lang = reader.lang === 'both' ? 'en' : 'both';
  applyReader();
  rebuildCues();
};
$('drawerBtn').onclick = openDrawer;
$('drawerClose').onclick = closeDrawer;
$('scrim').onclick = closeOverlays;
$('detailsBtn').onclick = (e) => { e.stopPropagation(); $('details').classList.contains('on') ? closeDetails() : openDetails(); };
$('openDetailsText').onclick = openDetails;
$('cover').onclick = openDetails;
$('detailsClose').onclick = closeDetails;
$('immersiveBtn').onclick = () => setImmersive(!state.immersive);
$('wallpaperBtn').onclick = () => { closeDockSheet(false); setWallpaper(true); };
$('wpPlay').onclick = e => { e.preventDefault(); e.stopPropagation(); toggleWallpaperPlay(); };
$('wpExit').onclick = () => setWallpaper(false);

let framePos = null, frameMoved = false, frameDrag = null;
const frameEl = $('frameBtn');
function clampFrame(x, y) {
  const w = frameEl.offsetWidth || 72, h = frameEl.offsetHeight || 72;
  return { x: Math.max(8, Math.min(x, innerWidth - w - 8)), y: Math.max(8, Math.min(y, innerHeight - h - 8)) };
}
function placeFrame(x, y) {
  framePos = clampFrame(x, y);
  frameEl.style.left = framePos.x + 'px';
  frameEl.style.top = framePos.y + 'px';
  frameEl.style.bottom = 'auto';
  frameEl.style.right = 'auto';
}
function onFrameMove(e) {
  if (!frameDrag) return;
  if (!frameMoved) {
    if (Math.abs(e.clientX - frameDrag.sx) + Math.abs(e.clientY - frameDrag.sy) <= 4) return;
    frameMoved = true;
  }
  placeFrame(e.clientX - frameDrag.dx, e.clientY - frameDrag.dy);
}
function endFrameDrag() {
  if (!frameDrag) return;
  frameDrag = null;
  frameEl.classList.remove('dragging');
  removeEventListener('pointermove', onFrameMove);
  removeEventListener('pointerup', endFrameDrag);
  removeEventListener('pointercancel', endFrameDrag);
  if (frameMoved) setTimeout(() => { frameMoved = false; }, 300);
}
frameEl.addEventListener('pointerdown', e => {
  if (!state.immersive || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const r = frameEl.getBoundingClientRect();
  frameDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY };
  frameMoved = false;
  frameEl.classList.add('dragging');
  addEventListener('pointermove', onFrameMove);
  addEventListener('pointerup', endFrameDrag);
  addEventListener('pointercancel', endFrameDrag);
});
frameEl.addEventListener('dragstart', e => e.preventDefault());
frameEl.onclick = () => { if (frameMoved) { frameMoved = false; return; } setImmersive(false); };
$('jumpPill').onclick = () => returnToCue();
addEventListener('resize', () => {
  if (framePos && state.immersive) placeFrame(framePos.x, framePos.y);
  alignZhLines();
  syncJumpPill();
});
document.addEventListener('click', e => {
  const d = $('details');
  if (d.classList.contains('on') && !d.contains(e.target) && e.target !== $('detailsBtn') && e.target !== $('cover') && e.target !== $('openDetailsText')) closeDetails();
});
// 滚动事件一秒能来几十次，每次都量两个 rect 会强制同步布局；合并到一帧算一次。
let pillRAF = 0;
function queueJumpPill() {
  if (pillRAF) return;
  pillRAF = requestAnimationFrame(() => { pillRAF = 0; syncJumpPill(); });
}
box.addEventListener('scroll', queueJumpPill, { passive: true });
box.addEventListener('wheel', () => { stopScroll(); setState('pendingFollow', false); setState('userScrollUntil', Date.now() + 3000); }, { passive: true });
box.addEventListener('touchmove', () => { stopScroll(); setState('pendingFollow', false); setState('userScrollUntil', Date.now() + 3000); }, { passive: true });
function jumpCue(delta) {
  if (!state.cues.length) return;
  const base = state.activeCue >= 0 ? state.activeCue : 0;
  const index = Math.max(0, Math.min(state.cues.length - 1, base + delta));
  if (!state.nodes[index]) renderCueWindow(index, true);
  const cue = state.cues[index], node = state.nodes[index];
  if (!cue) return;
  seekTo(cue.start + state.offset);
  stopScroll();
  if (node) scrollCue(node.el, true);
}

/* ---------- 文字稿交互：本集内搜索 / 划句文字卡 ---------- */
const findBar = $('findBar'), findInput = $('findInput'), findCount = $('findCount'), selTools = $('selTools');
let findHits = [], findAt = -1, selCueIdx = -1, selText = '';

function clearFindMarks() {
  state.nodes.forEach(n => { if (n && n.el) n.el.classList.remove('find-hit', 'find-cur'); });
  findHits = []; findAt = -1;
  if (findCount) findCount.textContent = '0/0';
}

function showFindAt(target, seek) {
  if (!findHits.length) { if (findCount) findCount.textContent = '0/0'; return; }
  findAt = Math.max(0, Math.min(findHits.length - 1, target));
  state.nodes.forEach(n => { if (n && n.el) n.el.classList.remove('find-cur'); });
  const ci = findHits[findAt], cue = state.cues[ci];
  if (!state.nodes[ci]) renderCueWindow(ci, true);
  const node = state.nodes[ci];
  if (findCount) findCount.textContent = (findAt + 1) + ' / ' + findHits.length;
  if (!node) return;
  node.el.classList.add('find-cur');
  stopScroll();
  scrollCue(node.el, true);
  if (seek && cue) seekTo(cue.start + state.offset);
}

function runFind(query) {
  clearFindMarks();
  const q = findNorm(query);
  if (!q) return;
  state.cues.forEach((cue, ci) => {
    const hay = findNorm(cue.text) + ' ' + findNorm(cue.zh);
    if (hay.includes(q)) {
      findHits.push(ci);
      const n = state.nodes[ci];
      if (n && n.el) n.el.classList.add('find-hit');
    }
  });
  if (!findHits.length) { if (findCount) findCount.textContent = '0/0'; return; }
  // 从当前播放位置往后找第一处，符合“接着往下找”的直觉
  const from = state.activeCue >= 0 ? state.activeCue : 0;
  const start = findHits.findIndex(ci => ci >= from);
  showFindAt(start >= 0 ? start : 0, false);
}

function openFind() {
  if (!subtitlePluginOn()) { showToast('字幕插件未启用，本集搜索不可用。', 'warn'); return; }
  if (!state.cues.length) { showToast('这集还没有文字稿。'); return; }
  motionEnter(findBar);
  findInput.value = '';
  clearFindMarks();
  findInput.focus();
}
function closeFind() {
  motionLeave(findBar);
  clearFindMarks();
  try { getSelection().removeAllRanges(); } catch (e) {}
}

function hideSelTools() {
  motionLeave(selTools);
  selCueIdx = -1; selText = '';
}

function pickedCue() {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  let text = sel.toString().replace(/\s+/g, ' ').trim();
  // 拖选时容易把行首的时间戳一起选进来（"00:14You feel…"），去掉它再进卡片
  text = text.replace(/^\d{1,2}:\d{2}(?::\d{2})?\s*/, '').trim();
  if (!text) return null;
  let node = sel.anchorNode;
  if (node && node.nodeType === 3) node = node.parentElement;
  if (!node || !box.contains(node)) return null;
  const cueEl = node.closest('.cue');
  if (!cueEl) return null;
  const ci = Number(cueEl.dataset.ci);
  if (!state.cues[ci]) return null;
  return { ci, text };
}

function placeSelTools(rect) {
  const w = selTools.offsetWidth || 118, h = selTools.offsetHeight || 32;
  let x = rect.left + rect.width / 2 - w / 2;
  let y = rect.top - h - 8;
  if (y < 8) y = rect.bottom + 8;
  x = Math.max(8, Math.min(window.innerWidth - w - 8, x));
  selTools.style.left = Math.round(x) + 'px';
  selTools.style.top = Math.round(y) + 'px';
}

function cardLink(slug, id) {
  const hash = '#/player/' + slug + '/' + id;
  const host = location.hostname || '';
  // 桌面壳里 location 是 tauri.localhost，粘出去没用；一律换成发布站点
  if (host === 'tauri.localhost' || host === 'localhost' || host === '127.0.0.1') {
    return 'https://lzoreal.github.io/MyTranscript/player.html' + hash;
  }
  return location.origin + location.pathname + hash;
}

function cardFor(ci, text) {
  const cue = state.cues[ci] || {};
  const show = state.show || {}, ep = state.current || {};
  const head = [show.name, ep.title].filter(Boolean).join(' · ');
  const link = (show.slug && ep.id) ? cardLink(show.slug, ep.id) : location.href;
  const lines = ['> ' + text];
  if (cue.zh) lines.push('> ' + String(cue.zh).replace(/\s+/g, ' ').trim());
  lines.push('');
  lines.push('— ' + (head ? head + ' · ' : '') + fmt((cue.start || 0) + state.offset));
  lines.push(link);
  return lines.join('\n');
}

async function copyPlain(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (err) { return false; }
}

document.addEventListener('mouseup', e => {
  if (e.target && e.target.closest && e.target.closest('#selTools')) return;
  setTimeout(() => {
    const hit = pickedCue();
    if (!hit) { hideSelTools(); return; }
    const sel = getSelection();
    const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    const rect = range ? range.getBoundingClientRect() : null;
    if (!rect || (!rect.width && !rect.height)) { hideSelTools(); return; }
    selCueIdx = hit.ci; selText = hit.text;
    placeSelTools(rect);
    motionEnter(selTools);
  }, 0);
}, true);

selTools.addEventListener('click', async e => {
  const btn = e.target.closest('[data-sel]');
  if (!btn) return;
  e.preventDefault(); e.stopPropagation();
  if (selCueIdx < 0 || !selText) return;
  const isCard = btn.dataset.sel === 'card';
  const payload = isCard ? cardFor(selCueIdx, selText) : selText;
  const ok = await copyPlain(payload);
  hideSelTools();
  try { getSelection().removeAllRanges(); } catch (err) {}
  showToast(ok ? (isCard ? '文字卡已复制' : '已复制选中文字') : '复制失败，请手动选择后再试', ok ? 2200 : 3200);
});

box.addEventListener('scroll', () => { if (selTools.classList.contains('on')) hideSelTools(); }, { passive: true });
window.mytFindReset = () => { hideSelTools(); if (findBar.classList.contains('on')) closeFind(); };

/* ================== 章节导航 ================== */
async function fetchTextAny(url) {
  if (host() && typeof host().httpText === 'function') return host().httpText(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}
function loadChapters(ep) {
  const seq = ++state.chapterSeq;
  setState('chapterKey', '');   // 换集后必须重写一次章节文字，不能沿用上一集的缓存键
  setState('chapters', Array.isArray(ep && ep.chapters) ? ep.chapters.slice() : []);
  setState('chapterAdsSkipped', new Set());
  setState('chapterIdx', -2);
  renderChapters();
  if (!ep || !ep.chaptersUrl) return;
  const cached = app.chaptersCache.get(ep.chaptersUrl);
  if (cached) {
    setState('chapters', cached.slice());
    setState('chapterIdx', -2);
    renderChapters();
    return;
  }
  fetchTextAny(ep.chaptersUrl).then(text => {
    if (seq !== state.chapterSeq) return;
    const data = JSON.parse(text);
    const list = (data.chapters || [])
      .map(c => ({ start: Number(c.startTime) || 0, title: String(c.title || '').trim() }))
      .filter(c => c.title)
      .sort((a, b) => a.start - b.start);
    if (!list.length) return;
    app.chaptersCache.set(ep.chaptersUrl, list);
    setState('chapters', list);
    setState('chapterAdsSkipped', new Set());
    setState('chapterIdx', -2);
    renderChapters();
  }).catch(() => {});
}
function renderChapters() {
  const sheet = $('chapterSheet'), list = $('chapterList'), chip = $('chapterChip'), now = $('chapterNow');
  if (!sheet || !list) return;
  if (!state.chapters.length) {
    list.innerHTML = '<div class="chapter-empty">该集没有章节信息。<br>带章节的节目会从 feed 自动读取。</div>';
    if (now) now.textContent = '—';
    if (chip) { chip.hidden = true; chip.textContent = ''; }
    return;
  }
  list.innerHTML = state.chapters.map((c, i) =>
    '<button type="button" class="chapter-item" data-chapter="' + i + '"><time>' + fmt(c.start || 0) +
    '</time><span>' + esc(c.title) + '</span></button>').join('');
  syncChapterNow(audio.currentTime || 0);
}
function syncChapterNow(t) {
  if (!state.chapters.length) return;
  let idx = -1;
  for (let i = 0; i < state.chapters.length; i++) {
    if (t + 0.4 >= state.chapters[i].start) idx = i;
  }
  const title = idx >= 0 ? state.chapters[idx].title : '';
  // 这句话/这一章没变就不必每帧重写两个标签
  const key = idx + '|' + title;
  if (key !== state.chapterKey) {
    setState('chapterKey', key);
    const now = $('chapterNow'), chip = $('chapterChip');
    if (now) now.textContent = title || '—';
    if (chip) {
      chip.hidden = !title;
      chip.textContent = title ? '§ ' + title : '';
      chip.title = title;
    }
  }
  if (idx !== state.chapterIdx) {
    setState('chapterIdx', idx);
    const list = $('chapterList');
    if (list) [...list.children].forEach((el, i) => el.classList.toggle('now', i === idx));
  }
}
function seekChapter(i) {
  const c = state.chapters[i];
  if (!c) return;
  seekTo(c.start);
  audio.play().catch(() => {});
}
function toggleChapterSheet(force) {
  const sheet = $('chapterSheet');
  if (!sheet) return;
  const on = force === undefined ? !sheet.classList.contains('on') : !!force;
  sheet.classList.toggle('on', on);
  sheet.hidden = false;
  $('chapterBtn')?.classList.toggle('on', on);
  if (on) renderChapters();
}

/* ================== 点词查义 ================== */
const wordCache = new Map();
const cleanWordCache = new Map();
let wordCurrent = '', wordCurrentMeaning = '';
function cleanWord(raw) {
  const source = String(raw || '');
  const hit = cleanWordCache.get(source);
  if (hit !== undefined) return hit;
  const word = source.replace(/[^A-Za-z'’-]/g, '').replace(/^['’-]+|['’-]+$/g, '').toLowerCase();
  if (cleanWordCache.size > 20000) cleanWordCache.clear();
  cleanWordCache.set(source, word);
  return word;
}
function closeWordPanel() {
  const panel = $('wordPanel');
  if (panel) panel.classList.remove('on');
  wordSeq += 1;
}
let wordSeq = 0;
async function lookupWord(raw) {
  if (!studyPluginOn()) return;
  const word = cleanWord(raw);
  const panel = $('wordPanel');
  if (!word || !panel) return;
  // 每次查词都领一个序号：先发的慢请求回来时，如果面板已经换成别的词，
  // 就不能再把旧词条写进正文（否则标题是新词、释义是旧词）。
  const seq = ++wordSeq;
  wordCurrent = word;
  panel.classList.add('on');
  panel.hidden = false;
  $('wordTitle').textContent = word;
  $('wordPhon').textContent = '';
  $('wordBody').innerHTML = '<div class="word-note">正在查词…</div>';
  let entry = wordCache.get(word);
  if (!entry) {
    try {
      const text = await fetchTextAny('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word));
      entry = JSON.parse(text);
      wordCache.set(word, entry);
    } catch (err) {
      if (seq !== wordSeq) return;
      wordCurrentMeaning = '';
      $('wordBody').innerHTML = '<div class="word-note">查不到这个词（离线词典源不可用）。</div>' + wordStatusHTML(word);
      bindWordStatusButtons(word);
      if (window.__xai) window.__xai.attachWord(word, true);
      return;
    }
  }
  if (seq !== wordSeq) return;
  const first = Array.isArray(entry) ? entry[0] : null;
  const phon = (first && (first.phonetic || (first.phonetics || []).map(p => p.text).find(Boolean))) || '';
  $('wordPhon').textContent = phon;
  const meanings = (first && first.meanings) || [];
  const firstDef = meanings[0]?.definitions?.[0]?.definition || '';
  wordCurrentMeaning = firstDef;
  $('wordBody').innerHTML = (meanings.length
    ? meanings.slice(0, 4).map(m => {
      const defs = (m.definitions || []).slice(0, 2)
        .map(d => esc(d.definition || '')).filter(Boolean).join('<br>');
      return '<div class="word-sense"><i>' + esc(m.partOfSpeech || '') + '</i>' + (defs || '—') + '</div>';
    }).join('')
    : '<div class="word-note">这个词在词典里没有释义。</div>') + wordStatusHTML(word);
  bindWordStatusButtons(word);
  if (window.__xai) window.__xai.attachWord(word, false);
}

/* ================== 播放列表 ================== */
function savePlaylists() { writeJSON(PLAYLIST_KEY, app.playlists); }
function findPlaylist(id) { return app.playlists.find(p => p.id === id) || null; }
function defaultPlaylist() {
  let p = app.playlists[0];
  if (!p) {
    p = { id: 'pl-' + Date.now().toString(36), name: '稍后听', items: [], at: Date.now() };
    app.playlists.unshift(p);
    savePlaylists();
  }
  return p;
}
function episodeRef(show, ep) {
  return {
    key: show.slug, ep: ep.id, title: ep.title || '', show: show.name || '',
    date: ep.date || '', duration: ep.duration || '', img: ep.img || '',
  };
}
function addToPlaylist(show, ep, listId) {
  if (!show || !ep) return;
  const p = listId ? findPlaylist(listId) : defaultPlaylist();
  if (!p) return;
  if (p.items.some(it => it.key === show.slug && it.ep === ep.id)) { showToast('已在「' + p.name + '」里。'); return; }
  p.items.push(episodeRef(show, ep));
  p.at = Date.now();
  savePlaylists();
  showToast('已加入播放列表「' + p.name + '」。');
  renderAfterStateChange();
}
function playPlaylist(id) {
  const p = findPlaylist(id);
  if (!p || !p.items.length) return;
  // 队列里已经有东西时别静默替换：用户可能刚攒了一队通勤要听的。
  if (app.queue.length && !confirm('播放列表「' + p.name + '」会替换当前播放队列（' + app.queue.length + ' 集），继续？')) return;
  app.queue = p.items.map(it => Object.assign({}, it, { at: Date.now() }));
  saveQueue();
  const first = p.items[0];
  showToast('播放列表「' + p.name + '」开始播放，共 ' + p.items.length + ' 集。');
  playEpisode(first.key, first.ep);
}
function removePlaylist(id) {
  const p = findPlaylist(id);
  if (!p) return;
  app.playlists = app.playlists.filter(x => x.id !== id);
  savePlaylists();
  showToast('已删除播放列表「' + p.name + '」。');
  renderAfterStateChange();
}
function addToPlaylistDialog(showArg, epArg) {
  // 列表卡片上的「＋ 列表」是给「这一集」用的，不能顺手把 state.current 改成它：
  // state.current 是正在播放的那一集，标题、迷你窗、续播进度都靠它。
  const show = showArg || state.show;
  const ep = epArg || state.current;
  if (!show || !ep) { showToast('先打开一集再收藏。', 'warn'); return; }
  const lists = app.playlists;
  openModal('<h3>加入播放列表</h3><p class="smalltext">' + esc(show.name) + ' · ' + esc(ep.title || '') + '</p>' +
    '<div class="note-form"><label>选择列表</label><select id="plPick">' +
    lists.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + '（' + p.items.length + '）</option>').join('') +
    '</select><label>或新建</label><input id="plNew" placeholder="新列表名，例如「通勤」「睡前」"></div>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">' +
    '<button class="btn ghost" data-close-modal>取消</button>' +
    '<button class="btn primary" id="plConfirm">加入</button></div>');
  $('plConfirm').addEventListener('click', () => {
    const name = ($('plNew').value || '').trim();
    if (name) {
      const p = { id: 'pl-' + Date.now().toString(36), name, items: [], at: Date.now() };
      app.playlists.unshift(p);
      savePlaylists();
      addToPlaylist(show, ep, p.id);
    } else {
      addToPlaylist(show, ep, $('plPick').value);
    }
    closeModal();
  });
}
function renderPlaylists() {
  const box = $('playlistList');
  const hint = $('playlistHint');
  if (!box) return;
  if (hint) hint.textContent = app.playlists.length ? app.playlists.length + ' 个列表' : '保存在本机';
  motionFlip(box, '.qrow', () => {
  box.innerHTML = app.playlists.length
    ? app.playlists.map(p => {
      const preview = p.items.slice(0, 3).map(it => esc(it.title || it.ep)).join('<br>');
      const more = p.items.length > 3 ? '<br><span class="smalltext">…其余 ' + (p.items.length - 3) + ' 集</span>' : '';
      return '<div class="qrow" data-motion-key="' + esc(p.id) + '"><div class="qmain"><strong>' + esc(p.name) + '</strong>' +
        '<span>' + p.items.length + ' 集' + (p.items[0] ? ' · 首集 ' + esc(p.items[0].title || '') : '') + '</span>' +
        (preview ? '<span class="smalltext" style="margin-top:4px">' + preview + more + '</span>' : '<span class="smalltext">还是空的：单集页点「＋ 列表」加入。</span>') +
        '</div><div style="display:flex;gap:6px">' +
        '<button class="mini-btn" data-play-playlist="' + esc(p.id) + '"' + (p.items.length ? '' : ' disabled') + '>▶ 播放</button>' +
        '<button class="mini-btn" data-del-playlist="' + esc(p.id) + '">✕</button></div></div>';
    }).join('')
    : emptyLine('还没有播放列表。在单集页点「＋ 列表」建一个。', '<button class="btn ghost" data-route="library">去播客库</button>');
  });
}

/* ================== 离线下载 ================== */
function offlineKeyOf(key, epId) {
  const clean = v => String(v || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return clean(key) + '-' + clean(epId);
}
function offlineKeyFor(show, ep) { return offlineKeyOf(show && show.slug, ep && ep.id); }
async function saveOfflineTranscript(show, ep) {
  if (!host() || typeof host().offlineTranscriptSave !== 'function') return false;
  if (!show || !ep || !isJsonTranscript(ep.transcript)) return false;
  const key = offlineKeyFor(show, ep);
  if (app.offline.get(key)?.hasTranscript) return true;
  if (app.transcriptDownloads?.has(key)) return false;
  app.transcriptDownloads = app.transcriptDownloads || new Set();
  app.transcriptDownloads.add(key);
  try {
    const url = ep.transcript.url;
    try {
      await host().offlineTranscriptSave(url, key);
    } catch (firstErr) {
      const mirror = transcriptMirror(url);
      if (!mirror) throw firstErr;
      await host().offlineTranscriptSave(mirror, key);
    }
    // 跳过标签跟文字稿一起下；没有这个文件不影响播放，只是「跳过」用不了。
    if (typeof host().offlineSkipSave === 'function') {
      const skipUrl = skipUrlOf(url);
      if (skipUrl && skipUrl !== url) {
        host().offlineSkipSave(skipUrl, key).catch(() => {});
      }
    }
    return true;
  } finally {
    app.transcriptDownloads.delete(key);
  }
}
// 下载过的整集优先读本机文字稿；文件被删或解析失败时再回落到远端。
async function readTranscriptDoc(show, ep) {
  const transcript = ep && ep.transcript;
  if (!transcript || !transcript.url) return { doc: null, local: false };
  const key = offlineKeyFor(show, ep);
  const rec = app.offline ? app.offline.get(key) : null;
  if (rec && rec.hasTranscript && host() && typeof host().offlineTranscriptLoad === 'function' && isJsonTranscript(transcript)) {
    try {
      const text = await host().offlineTranscriptLoad(key);
      if (text) return { doc: JSON.parse(text), local: true };
    } catch (e) {}
  }
  return { doc: await getJson(transcript.url), local: false };
}
async function refreshOffline() {
  if (!host() || typeof host().offlineList !== 'function') return;
  try {
    const list = await host().offlineList();
    app.offline = new Map((list || []).map(rec => [rec.key, rec]));
  } catch (e) { app.offline = new Map(); }
  renderOfflineList();
  renderDownloads();
}

/* ---- 实时识别模型管理（桌面壳）---- */
function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  if (n >= 1024 * 1024) return Math.round(n / 1024 / 1024) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}
function asrModelName(id) {
  const found = (app.asrModels || []).find(model => model.id === id);
  return found ? found.name : id;
}
function localAsrModelId() {
  return prefs.asrModel || ASR_MODEL_DEFAULT;
}
function renderLocalAsrModelHint() {
  const el = $('localAsrModelNow');
  if (!el) return;
  const id = localAsrModelId();
  const found = (app.asrModels || []).find(model => model.id === id);
  el.textContent = (found ? found.name : id) + (found && found.installed === false ? '（未安装，会先下载）' : '') +
    ' · 整集预转写会用这一档';
}
async function refreshAsrModels() {
  if (!host() || typeof host().asrModels !== 'function') {
    renderAsrModels();
    return;
  }
  try {
    app.asrModels = await host().asrModels() || [];
    app.asrModelsErr = '';
  } catch (e) {
    app.asrModels = [];
    app.asrModelsErr = (e && e.message) || String(e);
  }
  renderAsrModels();
}
function renderAsrModels() {
  const boxEl = $('asrModelList');
  if (!boxEl) return;
  if (!host() || typeof host().asrModels !== 'function') {
    boxEl.innerHTML = '<div class="smalltext">模型管理只在桌面版可用；网页版固定使用内置的 WASM 模型。</div>';
    return;
  }
  const list = app.asrModels || [];
  if (!list.length) {
    boxEl.innerHTML = '<div class="smalltext">' + esc(app.asrModelsErr || '正在读取模型…') + '</div>';
    return;
  }
  let active = prefs.asrModel || ASR_MODEL_DEFAULT;
  // 目录被手工删掉时选择会指空，回落到默认模型，别让 prepare 拿着未知 id 去下载。
  if (!list.some(model => model.id === active)) {
    prefs.asrModel = ASR_MODEL_DEFAULT;
    savePrefs();
    active = ASR_MODEL_DEFAULT;
  }
  boxEl.innerHTML = '';
  list.forEach(model => {
    const busy = app.asrBusy.get(model.id);
    const row = document.createElement('div');
    row.className = 'asr-model' + (model.id === active ? ' on' : '');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const title = document.createElement('b');
    title.textContent = model.name + (model.id === active ? ' · 使用中' : '');
    const sub = document.createElement('span');
    let size = model.installed ? '已安装 ' + fmtBytes(model.bytes) : '未安装';
    if (!model.installed && model.part > 0) size = '已下载 ' + fmtBytes(model.part) + '，可续传';
    if (busy) size = '下载中 ' + busy.pct + '%' + (busy.total ? '（' + fmtBytes(busy.got) + ' / ' + fmtBytes(busy.total) + '）' : '');
    sub.textContent = [model.desc, size].filter(Boolean).join(' · ');
    meta.append(title, sub);
    const ops = document.createElement('div');
    ops.className = 'ops';
    if (busy) {
      const cancel = document.createElement('button');
      cancel.className = 'btn ghost small';
      cancel.textContent = '取消';
      cancel.dataset.asrCancel = model.id;
      ops.append(cancel);
    } else {
      if (!model.installed) {
        const get = document.createElement('button');
        get.className = 'btn primary small';
        get.textContent = model.part > 0 ? '继续下载' : '下载';
        get.dataset.asrInstall = model.id;
        ops.append(get);
      }
      if (model.id !== active) {
        const use = document.createElement('button');
        use.className = 'btn ghost small';
        use.textContent = model.installed ? '使用' : '下载并使用';
        use.dataset.asrPick = model.id;
        ops.append(use);
      }
      if (model.installed) {
        const open = document.createElement('button');
        open.className = 'btn ghost small';
        open.textContent = '目录';
        open.title = '在资源管理器里打开模型目录';
        open.dataset.asrOpen = model.id;
        ops.append(open);
        const del = document.createElement('button');
        del.className = 'btn ghost small';
        del.textContent = '删除';
        del.dataset.asrRemove = model.id;
        del.disabled = model.id === active;
        if (model.id === active) del.title = '正在使用，先切到别的模型再删';
        ops.append(del);
      }
    }
    row.append(meta, ops);
    boxEl.append(row);
  });
  renderLocalAsrModelHint();
}
function paintAsrSoon() {
  if (app.asrPaintPending) return;
  app.asrPaintPending = true;
  requestAnimationFrame(() => {
    app.asrPaintPending = false;
    renderAsrModels();
  });
}
async function installAsrModel(id) {
  if (!host() || typeof host().asrPrepare !== 'function') return;
  const model = (app.asrModels || []).find(item => item.id === id);
  const label = model ? model.name : asrModelName(id);
  app.asrBusy.set(id, { pct: 0, got: 0, total: 0 });
  renderAsrModels();
  showToast('开始下载「' + label + '」模型…', 4000);
  try {
    await host().asrPrepare(id);
    app.asrBusy.delete(id);
    await refreshAsrModels();
    showToast('模型已就绪：' + label, 4000);
  } catch (e) {
    const msg = (e && e.message) || String(e || '');
    app.asrBusy.delete(id);
    await refreshAsrModels();
    if (/取消/.test(msg)) showToast('已取消下载，进度保留，下次可续传。', 5000);
    else showToast('模型下载失败：' + msg, 9000);
  }
}
async function cancelAsrModel(id) {
  if (!host() || typeof host().asrCancel !== 'function') return;
  try {
    await host().asrCancel(id);
    showToast('正在取消下载…', 3000);
  } catch (e) {
    showToast('取消失败：' + ((e && e.message) || e), 6000);
  }
}
async function openAsrDir(id) {
  if (!host() || typeof host().asrOpenDir !== 'function') return;
  try {
    await host().asrOpenDir(id);
  } catch (e) {
    showToast('打开目录失败：' + ((e && e.message) || e), 6000);
  }
}
function pickAsrModel(id) {
  if (!id || id === prefs.asrModel) return;
  const model = (app.asrModels || []).find(item => item.id === id);
  if (model && !model.installed) {
    installAsrModel(id).then(() => {
      prefs.asrModel = id;
      savePrefs();
      renderAsrModels();
    });
    return;
  }
  prefs.asrModel = id;
  savePrefs();
  renderAsrModels();
  showToast('已切换到「' + asrModelName(id) + '」，下次开启实时识别生效。', 4000);
}
async function removeAsrModel(id) {
  if (!host() || typeof host().asrRemove !== 'function') return;
  if (id === (prefs.asrModel || ASR_MODEL_DEFAULT)) {
    showToast('这是正在使用的模型，先切到别的模型再删。', 4000);
    return;
  }
  const model = (app.asrModels || []).find(item => item.id === id);
  if (!confirm('删除模型「' + ((model && model.name) || id) + '」？下次用要重新下载。')) return;
  try {
    await host().asrRemove(id);
    await refreshAsrModels();
    showToast('已删除模型。');
  } catch (e) {
    showToast('删除失败：' + ((e && e.message) || e), 8000);
  }
}
async function importAsrModel() {
  if (!host() || typeof host().asrImport !== 'function') {
    showToast('导入只在桌面版可用。', 'warn');
    return;
  }
  try {
    const picked = await tauriHost().core.invoke('plugin:dialog|open', {
      options: { directory: true, multiple: false, title: '选择 sherpa-onnx 模型文件夹' },
    });
    const dir = Array.isArray(picked) ? picked[0] : picked;
    if (!dir) return;
    showToast('正在导入模型…', 8000);
    const res = await host().asrImport(dir);
    if (res && res.id) {
      prefs.asrModel = res.id;
      savePrefs();
    }
    await refreshAsrModels();
    showToast('已导入模型：' + ((res && res.name) || dir), 5000);
  } catch (e) {
    showToast('导入失败：' + ((e && e.message) || e), 9000);
  }
}
/* 下载接缝：插件可以接管整集落盘（比如换成自己的缓存/转码管线）。 */
defineCoreProvider('downloads', { save: (show, ep, opts) => defaultDownloadEpisode(show, ep, opts) });
function downloadEpisode(show, ep, opts) { return coreProvider('downloads').save(show, ep, opts); }
async function defaultDownloadEpisode(show, ep, opts = {}) {
  if (!show || !ep) return;
  const quiet = !!opts.quiet;
  // 视频集的整集下载会把完整 mp4 落盘（Talking Cars 那种一集 300–400 MB），
  // 静默开始会把用户的磁盘和流量当成无成本。给一次明确确认，别做成「点一下就开始」。
  if (!quiet && ep.video) {
    const ok = confirm('这是视频单集，整集下载会保存完整视频文件（常见几百 MB）。\n' +
      '只想留音频？下载后在「下载管理」里点「只取音频轨」。\n\n继续下载？');
    if (!ok) return;
  }
  if (!host() || typeof host().offlineSave !== 'function') {
    if (!quiet) showToast('离线下载只在桌面壳里可用（网页版没有本地目录权限）。', 'warn');
    return;
  }
  const src = directAudioUrl(ep.url) || ep.url || '';
  if (!src) { if (!quiet) showToast('这一集没有音频地址。', 'warn'); return; }
  const key = offlineKeyFor(show, ep);
  rememberDownloadMeta(key, show, ep);
  const existing = app.offline.get(key);
  if (existing && existing.hasTranscript) { if (!quiet) showToast('这一集和文字稿都已离线。'); return; }
  if (app.downloading.has(key)) { if (!quiet) showToast('这一集正在下载。'); return; }
  const transcriptable = isJsonTranscript(ep.transcript);
  if (!quiet) showToast(existing ? '正在补下文字稿「' + (ep.title || ep.id) + '」…' : '开始下载「' + (ep.title || ep.id) + '」…');
  app.downloading.add(key);
  let transcriptErr = '';
  try {
    let audioPath = existing && existing.path ? existing.path : '';
    if (!audioPath) {
      audioPath = await host().offlineSave(src, key);
      app.offline.set(key, Object.assign({}, existing || {}, { key, path: audioPath, size: existing?.size || 0, hasTranscript: false }));
    }
    let hasTranscript = !!app.offline.get(key)?.hasTranscript;
    if (transcriptable) {
      try {
        hasTranscript = await saveOfflineTranscript(show, ep);
      } catch (err) {
        hasTranscript = false;
        transcriptErr = (err && err.message) ? err.message : String(err);
      }
    }
    app.offline.set(key, Object.assign({}, app.offline.get(key) || {}, { key, path: audioPath, hasTranscript }));
    await refreshOffline();
    if (!quiet) {
      if (transcriptErr) showToast('音频已下载；文字稿下载失败：' + transcriptErr, 7000);
      else if (hasTranscript) showToast('已下载音频与文字稿，断网也能跟读。');
      else if (ep.transcript && !transcriptable) showToast('音频已下载；此集文字稿格式暂不支持离线。', 6000);
      else showToast('已下载到本机；该集没有文字稿。');
      renderOfflineList();
      renderAfterStateChange();
    }
  } catch (err) {
    if (!quiet) showToast('下载失败：' + (err && err.message ? err.message : err), 'warn');
    else desktopNotify('下载失败', (show.name || '') + ' · ' + (ep.title || ep.id));
  } finally {
    app.downloading.delete(key);
  }
}
async function removeOffline(key) {
  if (!host() || typeof host().offlineRemove !== 'function') return;
  try {
    await host().offlineRemove(key);
    app.offline.delete(key);
    showToast('已删除本地文件。');
    renderOfflineList();
    renderAfterStateChange();
  } catch (err) { showToast('删除失败：' + (err && err.message ? err.message : err), 'warn'); }
}
function offlineEntries() {
  return [...(app.offline ? app.offline.values() : [])];
}
// 离线键是「show slug + '-' + episode id」，两边自己都带连字符（UUID 更是四段），
// 不能用贪婪正则切；按已知 show slug 逐段试，剩下的整段当 episode id 去匹配。
function resolveOfflineRef(key) {
  const s = String(key || '');
  for (let i = s.indexOf('-'); i > 0; i = s.indexOf('-', i + 1)) {
    const show = showByKey(s.slice(0, i));
    if (!show) continue;
    const ep = episodesOf(show).find(e => e.id === s.slice(i + 1));
    if (ep) return { show, ep };
  }
  return null;
}
function offlineLabel(key) {
  const ref = resolveOfflineRef(key);
  if (ref) return (ref.show.name || ref.show.slug) + ' · ' + (ref.ep.title || ref.ep.id);
  const s = String(key || '');
  // 单集列表还没加载时也至少把节目名分出来，不要把整串内部键直接丢给用户看。
  for (let i = s.indexOf('-'); i > 0; i = s.indexOf('-', i + 1)) {
    const show = showByKey(s.slice(0, i));
    if (show) return (show.name || show.slug) + ' · 单集 ' + s.slice(i + 1).slice(0, 8);
  }
  return s;
}
/* 下载时把节目/单集标题记一笔：离线文件只存内部键，节目列表没加载时也能分类、显示标题。 */
function downloadMetaStore() {
  const raw = readJSON(DL_META_KEY, {});
  return raw && typeof raw === 'object' ? raw : {};
}
function rememberDownloadMeta(key, show, ep) {
  if (!key) return;
  const store = downloadMetaStore();
  store[key] = {
    showSlug: show?.slug || show?.key || '',
    showName: show?.name || '',
    artwork: show?.artwork || '',
    epTitle: ep?.title || '',
    epId: ep?.id || '',
    at: Date.now(),
  };
  // 只留最近 500 条，避免长期使用后 localStorage 无限膨胀。
  const keys = Object.keys(store);
  if (keys.length > 500) {
    keys.sort((a, b) => (Number(store[a]?.at) || 0) - (Number(store[b]?.at) || 0));
    keys.slice(0, keys.length - 500).forEach(k => { delete store[k]; });
  }
  writeJSON(DL_META_KEY, store);
}
function showForOfflineKey(key) {
  const s = String(key || '');
  let best = null, bestLen = 0;
  (state.shows || []).forEach(show => {
    const slug = show?.slug || show?.key || '';
    if (!slug || slug.length <= bestLen) return;
    if (s.startsWith(slug + '-')) { best = show; bestLen = slug.length; }
  });
  return best;
}
function downloadInfo(rec) {
  const meta = downloadMetaStore()[rec.key] || {};
  const ref = resolveOfflineRef(rec.key);
  const show = ref?.show || (meta.showSlug ? showByKey(meta.showSlug) : null) || showForOfflineKey(rec.key);
  const s = String(rec.key || '');
  const tail = show ? s.slice((show.slug || show.key || '').length + 1) : s;
  return {
    show,
    groupKey: show?.slug || meta.showSlug || ('name:' + (meta.showName || '未知节目')),
    groupName: show?.name || meta.showName || '未知节目',
    artwork: show?.artwork || meta.artwork || '',
    title: ref?.ep?.title || meta.epTitle || ('单集 ' + tail.slice(0, 12)),
    ep: ref?.ep || null,
  };
}
function downloadsHTML(entries, query) {
  const q = String(query || '').trim().toLowerCase();
  const groups = new Map();
  entries.forEach(rec => {
    const info = downloadInfo(rec);
    if (q && !(info.groupName + ' ' + info.title).toLowerCase().includes(q)) return;
    if (!groups.has(info.groupKey)) groups.set(info.groupKey, { key: info.groupKey, name: info.groupName, artwork: info.artwork, items: [] });
    groups.get(info.groupKey).items.push({ rec, info });
  });
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh')).map(group => {
    const total = group.items.reduce((n, x) => n + (Number(x.rec.size) || 0) + (Number(x.rec.transcriptSize) || 0), 0);
    const rows = group.items.sort((a, b) => String(a.info.title).localeCompare(String(b.info.title), 'zh')).map(({ rec, info }) => {
      const canAddTranscript = !rec.hasTranscript && info.ep && isJsonTranscript(info.ep.transcript);
      const transcript = rec.hasTranscript ? '文字稿 ' + fmtBytes(Number(rec.transcriptSize) || 0) : '仅音频';
      return '<div class="qrow"><div class="qmain"><strong>' + esc(info.title) + '</strong><span>' +
        fmtBytes(Number(rec.size) || 0) + ' · ' + transcript + '</span></div>' +
        '<div style="display:flex;gap:6px">' +
        (canAddTranscript ? '<button class="mini-btn" data-offline-transcript="' + esc(rec.key) + '">＋ 字幕</button>' : '') +
        '<button class="mini-btn" data-play-offline="' + esc(rec.key) + '">▶ 播放</button>' +
        '<button class="mini-btn" data-del-offline="' + esc(rec.key) + '">✕ 删除</button></div></div>';
    }).join('');
    return '<div class="dl-pod" data-motion-key="' + esc(group.key) + '"><div class="dl-pod-head">' +
      (group.artwork ? '<img class="dl-art" src="' + esc(group.artwork) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '<div class="dl-art"></div>') +
      '<div><strong>' + esc(group.name) + '</strong><span class="dl-pod-meta">' + group.items.length + ' 集 · ' + fmtBytes(total) + '</span></div></div>' +
      '<div class="dl-rows">' + rows + '</div></div>';
  }).join('');
}
function renderDownloads() {
  const box = $('downloadsGroups');
  if (!box) return;
  const entries = offlineEntries();
  const totalBytes = entries.reduce((n, e) => n + (Number(e.size) || 0) + (Number(e.transcriptSize) || 0), 0);
  const groups = new Set(entries.map(rec => downloadInfo(rec).groupKey)).size;
  const hint = $('downloadsHint');
  if (hint) hint.textContent = entries.length
    ? entries.length + ' 集 · ' + groups + ' 个节目 · 共 ' + fmtBytes(totalBytes)
    : '还没有下载到本机的单集。';
  const q = $('downloadsFilter') ? $('downloadsFilter').value : '';
  const html = entries.length ? downloadsHTML(entries, q) : '';
  motionFlip(box, '.dl-pod', () => {
  box.innerHTML = html || (entries.length
    ? '<div class="dl-empty">没有匹配的下载。换个关键词试试。</div>'
    : emptyLine('还没有下载到本机的单集。在单集页点「⤓ 整集下载」。'));
  });
}
function renderOfflineList() {
  const box = $('offlineList');
  const hint = $('offlineHint');
  if (!box) return;
  const entries = offlineEntries();
  const totalBytes = entries.reduce((n, e) => n + (Number(e.size) || 0) + (Number(e.transcriptSize) || 0), 0);
  if (hint) hint.textContent = entries.length
    ? entries.length + ' 集 · ' + fmtBytes(totalBytes) + ' · ' + entries.filter(e => e.hasTranscript).length + ' 集含字幕'
    : '断网也能听';
  motionFlip(box, '.qrow', () => {
  box.innerHTML = entries.length
    ? entries.map(rec => {
      const ref = resolveOfflineRef(rec.key);
      const ep = ref && ref.ep;
      const size = fmtBytes(Number(rec.size) || 0);
      const transcript = rec.hasTranscript
        ? '文字稿 ' + fmtBytes(Number(rec.transcriptSize) || 0)
        : (ep && isJsonTranscript(ep.transcript) ? '仅音频 · 可补字幕' : '仅音频');
      const canAddTranscript = !rec.hasTranscript && ep && isJsonTranscript(ep.transcript);
      return '<div class="qrow" data-motion-key="' + esc(rec.key) + '"><div class="qmain"><strong>' + esc(offlineLabel(rec.key)) +
        '</strong><span>' + size + ' · ' + transcript + ' · 存在本机</span></div>' +
        '<div style="display:flex;gap:6px">' +
        (canAddTranscript ? '<button class="mini-btn" data-offline-transcript="' + esc(rec.key) + '">＋ 字幕</button>' : '') +
        '<button class="mini-btn" data-play-offline="' + esc(rec.key) + '">▶ 播放</button>' +
        '<button class="mini-btn" data-del-offline="' + esc(rec.key) + '">✕</button></div></div>';
    }).join('')
    : emptyLine('还没有离线单集。在单集页点「⤓ 整集下载」，音频和文字稿会一起保存。');
  });
}
function playOffline(key) {
  const rec = app.offline.get(key);
  if (!rec || !host() || typeof host().asset !== 'function') { showToast('本地文件不见了。', 'warn'); return; }
  const ref = resolveOfflineRef(key);
  if (ref) { playEpisode(ref.show.slug, ref.ep.id); return; }
  audio.src = host().asset(rec.path);
  audio.load();
  audio.play().catch(() => {});
}


findInput.addEventListener('input', () => runFind(findInput.value));
findInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    showFindAt(findAt + (e.shiftKey ? -1 : 1), true);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeFind();
  }
});
$('findPrev').addEventListener('click', () => showFindAt(findAt - 1, true));
$('findNext').addEventListener('click', () => showFindAt(findAt + 1, true));
$('findClose').addEventListener('click', closeFind);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (state.wallpaper) { setWallpaper(false); return; }
    if (state.seekPreview != null) { endSeekPreview(false); paint(true); return; }
    if ($('modal').open) { closeModal(); return; }
    if ($('studySheet')?.classList.contains('on')) { closeStudySheet(); return; }
    if ($('wordPanel')?.classList.contains('on')) { closeWordPanel(); return; }
    if ($('chapterSheet')?.classList.contains('on')) { toggleChapterSheet(false); return; }
    if (findBar.classList.contains('on')) { closeFind(); return; }
    if (selTools.classList.contains('on')) { hideSelTools(); return; }
    if (state.alignMode) { setAlignMode(false); showToast('已取消对齐。', 2500); }
    else if ($('typeSheet').classList.contains('on')) closeTypeSheet();
    else if (dockSheet.classList.contains('on')) closeDockSheet();
    else if ($('drawer').classList.contains('on') || $('details').classList.contains('on')) closeOverlays();
    else if (state.immersive) setImmersive(false);
    return;
  }
  if ($('modal').open) return;
  // Ctrl/Cmd+F 与 / 打开本集内搜索（输入框里的按键不劫持）。
  // 进度条/音量是 range input，点过之后焦点会留在上面；它们不算「正在打字」，
  // 否则 Space、方向键、/ 会被这里的早退全部吞掉。
  const typing = e.target.closest('input:not([type="range"]), select, textarea, [contenteditable="true"]');
  if (!typing && (e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault(); openFind(); return;
  }
  if (typing) return;
  // 组件自己已经处理过这个键（单选组用方向键切项、滑杆用方向键调值）就别再触发全局快捷键，
  // 否则方向键会同时「切下一项」和「跳下一句」，看起来像乱跳。
  if (e.defaultPrevented) return;
  const onRange = e.target.closest('input[type="range"]');
  if (onRange && (e.code === 'ArrowLeft' || e.code === 'ArrowRight' || e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
    // 进度条保持「15s / 30s」的跳法，别退化成原生 range 的 0.1%（长节目里几乎没反应）；
    // 音量条等其它滑杆交还原生，方向键按它们的 step 调。
    if (e.target.id === 'seek' && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
      e.preventDefault();
      seekBy(e.code === 'ArrowLeft' ? -15 : 30);
    }
    return;
  }
  // 只有我们会接管的键才把焦点从底栏/面板按钮上抢回来：Enter、Tab 之类留给按钮自己，
  // 否则键盘就没法激活面板里的按钮了。
  const shortcutKey = e.code === 'Space' || e.code === 'ArrowLeft' || e.code === 'ArrowRight'
    || e.code === 'ArrowUp' || e.code === 'ArrowDown'
    || ['/', 'j', 'J', 'k', 'K', '[', ']', 'm', 'M', 'n', 'N', 'p', 'P', 's', 'S'].includes(e.key);
  if (shortcutKey && e.target.closest('button, a, summary, [role="link"], [role="button"]')) {
    // 焦点停在底栏/面板按钮上时（很多是点过一次就留下焦点），把键盘交回全局快捷键，
    // 并先 blur 掉按钮，否则 Space 会在 keyup 时又触发一次按钮自己。
    if (!e.target.closest('.dock, .docksheet')) return;
    if (typeof e.target.blur === 'function') e.target.blur();
  }
  if (e.key === '/') { e.preventDefault(); openFind(); }
  else if (e.code === 'Space') { e.preventDefault(); $('play').click(); }
  else if (e.code === 'ArrowLeft') { e.preventDefault(); seekBy(-15); }
  else if (e.code === 'ArrowRight') { e.preventDefault(); seekBy(30); }
  else if (e.code === 'ArrowUp' || e.key === 'k' || e.key === 'K') { e.preventDefault(); jumpCue(-1); }
  else if (e.code === 'ArrowDown' || e.key === 'j' || e.key === 'J') { e.preventDefault(); jumpCue(1); }
  else if (e.key === '[') { e.preventDefault(); jumpCue(-1); }
  else if (e.key === ']') { e.preventDefault(); jumpCue(1); }
  else if (e.key === 'm' || e.key === 'M') { e.preventDefault(); toggleMute(); }
  else if (e.key === 's' || e.key === 'S') { e.preventDefault(); toggleStudySheet(); }
  else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); stepEpisode(1); }
  else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); stepEpisode(-1); }
});
/* S = 打开/收起 AI 学英语面板。原来只能点右下角「⋯ → AI 学英语」，
   鼠标点不到或纯键盘场景就没入口；面板里已有 Tab/Enter/Escape 通道，补齐这个开关即可。 */
function toggleStudySheet() {
  if (typeof moduleOn === 'function' && !moduleOn('study')) { showToast('AI 学英语模块已关闭。', 5000); return; }
  if ($('studySheet')?.classList.contains('on')) { closeStudySheet(); return; }
  openStudySheet();
}
/* 播放时钟：只在播放时按 ~8Hz 刷新，暂停/窗口隐藏时彻底停表。
   原来是无条件 60fps 的 requestAnimationFrame 常驻循环——即使暂停也在每秒唤醒 60 次，
   而且每帧都要写时间标签、读两次 getBoundingClientRect（强制同步布局）。 */
const PLAY_TICK_MS = 120;
const IDLE_TICK_MS = 500;
let playTick = 0, playTickMs = 0;
function desiredPlayTick() {
  if (document.hidden) return 0;
  return document.hasFocus() ? PLAY_TICK_MS : IDLE_TICK_MS;
}
function startPlayTick(force = false) {
  const ms = desiredPlayTick();
  if (!ms) { stopPlayTick(); return; }
  if (playTick && !force && playTickMs === ms) return;
  stopPlayTick();
  playTickMs = ms;
  playTick = setInterval(() => {
    if (audio.paused) { stopPlayTick(); paint(); return; }
    paint();
  }, ms);
}
function stopPlayTick() { if (playTick) { clearInterval(playTick); playTick = 0; playTickMs = 0; } }
audio.addEventListener('play', () => { startPlayTick(); paint(true); });
audio.addEventListener('pause', () => { stopPlayTick(); paint(true); });
audio.addEventListener('ended', () => { stopPlayTick(); paint(true); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopPlayTick(); return; }
  if (!audio.paused) { startPlayTick(true); paint(true); }
});
window.addEventListener('blur', () => { if (!audio.paused) startPlayTick(true); });
window.addEventListener('focus', () => { if (!audio.paused && !document.hidden) { startPlayTick(true); paint(true); } });
if (!audio.paused) startPlayTick();
/* ===================== app shell ===================== */
const SUBS_KEY = 'myt-subs', QUEUE_KEY = 'myt-queue', BOOKMARK_KEY = 'myt-bookmarks',
  NOTE_KEY = 'myt-notes', PREFS_KEY = 'myt-prefs', PLAYLIST_KEY = 'myt-playlists',
  AUTO_KEY = 'myt-auto', FAV_KEY = 'myt-favorites', PLAYED_KEY = 'myt-played',
  INBOX_KEY = 'myt-inbox', SEEN_KEY = 'myt-seen', SHOWPREFS_KEY = 'myt-showprefs',
  LOCAL_KEY = 'myt-local', DL_META_KEY = 'myt-download-meta';
const AUTO_DEFAULTS = {
  refreshHours: 0, autoDownload: false, downloadCount: 1, deletePlayed: false,
  deleteNotInQueue: false, keepFavorites: true, capMB: 2048, notify: true,
  lastRefreshAt: 0,
};
const app = {
  builtinShows: [], catalog: null, catalogBySlug: new Map(), subs: [], queue: [], bookmarks: [], notes: [],
  playlists: [], offline: new Map(), feedCache: new Map(), route: { page: 'home', args: [], params: new URLSearchParams() },
  plugins: [], pluginErrors: new Map(), pluginPageActive: null, subtitleOwner: '', studyOwner: '', capabilities: Object.create(null),
  lastPage: 'home', lastShowKey: '', appearance: 'default', cont: 'single', sleepUntil: 0, sleepEnd: false,
  sleepTimer: 0, pendingSeek: 0, pendingSeekEp: '', autoplay: false, feedErrors: null, initialized: false,
  catalogPending: true, catalogFailed: false, catalogPromise: null,
  discover: { query: '', category: '', sort: 'default', sub: 'all', transcripts: false },
  online: { query: '', loading: false, results: [], sources: [], piError: '', error: '', seq: 0, cache: new Map(), visible: 20 },
  asrModels: [], asrBusy: new Map(), asrModelsErr: '', chaptersCache: new Map(),
  auto: { ...AUTO_DEFAULTS }, favorites: new Set(), played: {}, inbox: [], seen: {}, showPrefs: {},
  downloading: new Set(), transcriptDownloads: new Set(), autoTimer: 0, refreshBusy: false, epFilter: 'all', local: [],
};
const PAGE_NAMES = {
  home: '首页', library: '播客库', local: '本地文件', downloads: '下载管理', video: '视频播放', discover: '发现', search: '搜索', podcast: '节目详情',
  episode: '单集详情', player: '播放器', inbox: '收件箱', queue: '播放队列', history: '收听历史',
  favorites: '收藏', bookmarks: '书签', notes: '笔记', listening: '收听模式', settings: '设置', stats: '统计与回顾', plugin: '插件',
};
const SIDEBAR_TOP = ['home', 'library', 'local', 'downloads', 'discover', 'search'];
const SIDEBAR_BOTTOM = ['inbox', 'queue', 'history', 'stats', 'favorites', 'bookmarks', 'notes', 'listening', 'settings'];
const SIDEBAR_META = {
  home: ['⌂', '首页'], library: ['▦', '播客库'], local: ['▤', '本地文件'], downloads: ['⤓', '下载管理'], discover: ['✦', '发现'], search: ['⌕', '搜索'],
  inbox: ['◫', '收件箱'], queue: ['☷', '播放队列'], history: ['◷', '收听历史'], stats: ['▥', '统计与回顾'],
  favorites: ['★', '收藏'], bookmarks: ['☆', '书签'], notes: ['▤', '笔记'], listening: ['♫', '收听模式'], settings: ['⚙', '设置'],
};
/* 内置色板只剩四个：档案/墨绿/酒红/青瓷/雾白已撤掉（老存档由 01 的 REMOVED_THEME_FALLBACK 迁走），
   视觉主题改成随包的七套自定义主题卡，不再占内置色板位。 */
const THEME_NAMES = {
  midnight: '午夜蓝', paper: '纸张', prototype: '原型', ledger: '编辑部',
};

function readJSON(key, fallback) {
  try { const value = JSON.parse(localStorage.getItem(key) || 'null'); return value == null ? fallback : value; }
  catch (e) { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
}
function whenIdle(fn, timeout = 1200) {
  if ('requestIdleCallback' in window) return requestIdleCallback(fn, { timeout });
  return setTimeout(fn, 0);
}
const IDX_DB = 'myt-transcript-index', IDX_STORE = 'episodes';
let idxDbPromise = null;
function idxDb() {
  if (idxDbPromise) return idxDbPromise;
  idxDbPromise = new Promise(resolve => {
    if (!window.indexedDB) { resolve(null); return; }
    const req = indexedDB.open(IDX_DB, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(IDX_STORE)) req.result.createObjectStore(IDX_STORE, { keyPath: 'id' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return idxDbPromise;
}
async function idxPut(record) {
  const db = await idxDb(); if (!db) return false;
  return new Promise(resolve => {
    const tx = db.transaction(IDX_STORE, 'readwrite');
    tx.objectStore(IDX_STORE).put(record);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}
async function idxGetAll() {
  const db = await idxDb(); if (!db) return [];
  return new Promise(resolve => {
    const tx = db.transaction(IDX_STORE, 'readonly');
    const req = tx.objectStore(IDX_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}
async function idxGet(id) {
  const db = await idxDb(); if (!db) return null;
  return new Promise(resolve => {
    const tx = db.transaction(IDX_STORE, 'readonly');
    const req = tx.objectStore(IDX_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}
async function idxClear() {
  const db = await idxDb(); if (!db) return;
  await new Promise(resolve => {
    const tx = db.transaction(IDX_STORE, 'readwrite');
    tx.objectStore(IDX_STORE).clear();
    tx.oncomplete = resolve; tx.onerror = resolve;
  });
}
async function idxCount() { return (await idxGetAll()).length; }
async function indexEpisode(show, ep, quiet = true) {
  if (!show || !ep || !ep.transcript?.url) return false;
  const key = epKey(show.slug, ep.id);
  const existing = await idxGet(key);
  if (existing) return true;
  const { doc } = await readTranscriptDoc(show, ep);
  if (!doc) return false;
  const built = cuesFromJson(doc);
  const lines = (built.vtt || []).map(cue => ({ s: Number(cue.start) || 0, t: String(cue.text || '').trim(), z: String(cue.zh || '').trim() }))
    .filter(line => line.t || line.z);
  if (!lines.length) return false;
  const text = lines.map(line => line.t + ' ' + line.z).join('\n').toLowerCase();
  await idxPut({ id: key, show: show.slug, showName: show.name || '', title: ep.title || '', url: ep.transcript.url, lines, text, at: Date.now() });
  if (!quiet) showToast('已索引：' + (ep.title || ''), 2000);
  return true;
}
async function indexCurrentEpisode(show, ep) {
  if (!show || !ep) return;
  try { await indexEpisode(show, ep, true); syncIndexCount(); } catch (e) {}
}
async function indexAllShows() {
  const shows = state.shows.filter(show => show.feed || show.builtin);
  if (!shows.length) { showToast('还没有可索引的节目。', 'warn'); return; }
  let total = 0, done = 0, ok = 0;
  showToast('开始索引全部订阅，共 ' + shows.length + ' 档；可以继续做别的事。', 8000);
  for (let si = 0; si < shows.length; si++) {
    const show = shows[si];
    let episodes = memoryFeed(show)?.episodes;
    if (!episodes && show.feed) {
      try {
        const xml = await fetchFeedText(show.feed);
        const feed = parseFeed(xml);
        rememberFeed(show.slug, feed);
        episodes = feed.episodes;
      } catch (e) {}
    }
    episodes = (episodes || []).filter(ep => ep.transcript?.url);
    total += episodes.length;
    if (!episodes.length) continue;
    for (const ep of episodes) {
      if (await indexEpisode(show, ep, true)) ok++;
      done++;
      const status = $('idxStatus');
      if (status && done % 5 === 0) status.textContent = '索引中 ' + done + ' 集（成功 ' + ok + '）· ' + show.name;
      syncIndexCount();
      await new Promise(resolve => setTimeout(resolve, 80));
    }
  }
  const status = $('idxStatus');
  if (status) status.textContent = '索引完成：' + ok + ' / ' + total + ' 集';
  showToast('全部索引完成：' + ok + ' / ' + total + ' 集。', 8000);
  syncIndexCount();
  if (layerValue('07-routes-pages', 'searchTab') === 'library') renderSearch($('searchInput')?.value || '');
}
async function indexCurrentShow() {
  const show = state.show;
  if (!show) { showToast('先打开一档节目。', 'warn'); return; }
  const episodes = (state.episodes.length ? state.episodes : episodesOf(show)).filter(ep => ep.transcript?.url);
  if (!episodes.length) { showToast('这档节目没有可索引的文字稿。', 'warn'); return; }
  let done = 0, ok = 0;
  showToast('开始索引「' + show.name + '」共 ' + episodes.length + ' 集…', 8000);
  for (const ep of episodes) {
    if (await indexEpisode(show, ep, true)) ok++;
    done++;
    if (done % 5 === 0 || done === episodes.length) {
      const status = $('idxStatus');
      if (status) status.textContent = '索引中 ' + done + ' / ' + episodes.length + '（成功 ' + ok + '）';
      syncIndexCount();
    }
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  showToast('索引完成：' + ok + ' / ' + episodes.length + ' 集。', 6000);
  syncIndexCount();
  if (layerValue('07-routes-pages', 'searchTab') === 'library') renderSearch($('searchInput')?.value || '');
}
function syncIndexCount() {
  idxCount().then(count => { const el = $('idxCount'); if (el) el.textContent = String(count); });
}
function hash32(text) {
  let h = 2166136261;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
function normalizeFeedUrl(url) {
  let s = String(url || '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  return s;
}
function extSlug(url) { return 'ext-' + hash32(normalizeFeedUrl(url)); }
function hostOf(url) {
  try { return new URL(url, location.href).hostname.replace(/^www\./, ''); } catch (e) { return String(url || ''); }
}
function absoluteUrl(url) {
  try { return new URL(url, location.href).href; } catch (e) { return String(url || ''); }
}
function absoluteFeed(feed) { return feed ? absoluteUrl(feed) : ''; }
function cleanFeedTitle(title) {
  return String(title || '')
    .replace(/\s*\((?:unofficial|非官方)[^)]*\)\s*/gi, ' ')
    .replace(/\s*[-–—]\s*transcripts?\s*$/i, '')
    .replace(/\s+/g, ' ').trim();
}
function findBuiltinByFeed(url) {
  const want = feedKey(url);
  if (!want) return null;
  return app.builtinShows.find(show => show.feed && feedKey(absoluteFeed(show.feed)) === want) || null;
}
function showByKey(key) {
  return state.shows.find(s => s.slug === key || s.key === key)
    || app.builtinShows.find(s => s.slug === key) || null;
}
function externalShow(rec) {
  return {
    slug: rec.key, key: rec.key, name: rec.name || hostOf(rec.feed), feed: rec.feed || '',
    builtin: false, artwork: rec.artwork || '', description: rec.description || '',
    latest: [], episode_count: 0,
  };
}
function localShowRecord() {
  return {
    slug: 'local-files', key: 'local-files', name: '本地文件', builtin: false, local: true,
    feed: '', artwork: '', description: '从本机文件夹导入的音频，不会上传。',
    latest: [], episode_count: app.local.length, transcript_count: 0, categories: [], order: 999,
  };
}
function refreshShows() {
  const ext = app.subs.filter(s => !s.builtin).map(externalShow);
  setState('shows', [...app.builtinShows, ...ext]);
  if (app.local.length) state.shows.push(localShowRecord());
  syncShowSelect();
}
function syncShowSelect() {
  const select = $('showSel');
  if (!select) return;
  select.innerHTML = state.shows.map(s => '<option value="' + esc(s.slug) + '">' + esc(s.name) + '</option>').join('');
  if (state.show?.slug) select.value = state.show.slug;
  select.onchange = e => loadShow(e.target.value);
}
function isSubscribed(key) { return app.subs.some(s => s.key === key); }
function saveSubs() {
  writeJSON(SUBS_KEY, app.subs.map(s => ({
    key: s.key, feed: s.feed || '', name: s.name || '', builtin: !!s.builtin,
    artwork: s.artwork || '', description: s.description || '', addedAt: s.addedAt || Date.now(),
  })));
}
function subscribeShow(show) {
  if (!show || isSubscribed(show.slug)) return false;
  app.subs.push({
    key: show.slug, feed: show.feed || '', name: show.name || '', builtin: !!show.builtin,
    artwork: show.artwork || '', description: show.description || '', addedAt: Date.now(),
  });
  saveSubs(); refreshShows(); return true;
}
function subscribeRecord(rec) {
  if (!rec || !rec.key || isSubscribed(rec.key)) return false;
  app.subs.push(rec); saveSubs(); refreshShows(); return true;
}
function removalLeavesCurrentShow(route, key) {
  return !!key && ['podcast', 'episode', 'player'].includes(route?.page) && (route?.args?.[0] || '') === key;
}
function unsubscribeKey(key) {
  app.subs = app.subs.filter(s => s.key !== key);
  app.feedErrors?.delete(key);
  saveSubs(); refreshShows();
  if (removalLeavesCurrentShow(parseRoute(), key)) { navigate('home'); return; }
  renderAfterStateChange();
}
function catalogLatest(show) {
  return (show && show.latest && show.latest.length ? show.latest : app.catalogBySlug.get(show?.slug)?.latest) || [];
}
function episodesOf(show) {
  if (show?.local) return app.local.map(ep => ({ ...ep, showKey: show.slug }));
  const feed = memoryFeed(show);
  if (feed?.episodes?.length) return feed.episodes;
  return catalogLatest(show).map(ep => ({ ...ep, showKey: show.slug }));
}
function readAllProgress() { return progressAll(); }
/* ---------- 收藏 / 已听 / 收件箱 / 订阅自动化 ---------- */
function saveFavorites() { writeJSON(FAV_KEY, [...app.favorites]); }
function savePlayed() { writeJSON(PLAYED_KEY, app.played); }
function saveInbox() { writeJSON(INBOX_KEY, app.inbox); }
function saveSeen() { writeJSON(SEEN_KEY, app.seen); }
function saveShowPrefs() { writeJSON(SHOWPREFS_KEY, app.showPrefs); }
function showPrefFor(showKey) {
  return Object.assign({ autoDownload: true, autoDelete: true, notify: true, speed: 0, skipIntro: 0, skipOutro: 0 }, app.showPrefs[showKey] || {});
}
function setShowPref(showKey, patch) {
  app.showPrefs[showKey] = Object.assign(showPrefFor(showKey), patch || {});
  saveShowPrefs();
}
function isFavorite(showKey, epId) { return app.favorites.has(epKey(showKey, epId)); }
function toggleFavorite(showKey, epId) {
  const key = epKey(showKey, epId);
  if (app.favorites.has(key)) app.favorites.delete(key); else app.favorites.add(key);
  saveFavorites();
  return app.favorites.has(key);
}
function isPlayed(showKey, epId) {
  const key = epKey(showKey, epId);
  if (app.played[key]) return true;
  const rec = readAllProgress()[key];
  return !!(rec && Number(rec.d) > 0 && Number(rec.t) >= Number(rec.d) - 30);
}
function setPlayed(showKey, epId, value) {
  const key = epKey(showKey, epId);
  if (value) app.played[key] = Date.now(); else delete app.played[key];
  savePlayed();
  renderAfterStateChange();
}
function markCurrentPlayed() {
  if (!state.show?.slug || !state.current?.id) return;
  app.played[epKey(state.show.slug, state.current.id)] = Date.now();
  savePlayed();
}
function addInboxItem(show, ep) {
  if (!show || !ep) return false;
  const key = epKey(show.slug, ep.id);
  if (app.inbox.some(item => item.key === key)) return false;
  app.inbox.unshift({
    key, showKey: show.slug, ep: ep.id, show: show.name || show.slug, title: ep.title || '',
    date: ep.date || '', duration: ep.duration || '', img: ep.img || '', at: Date.now(),
  });
  saveInbox();
  return true;
}
function inboxRemove(key) {
  app.inbox = app.inbox.filter(item => item.key !== key);
  saveInbox();
}
function inboxCount() { return app.inbox.length; }
function episodeFilterMatch(showKey, ep, filter) {
  if (filter === 'unplayed') return !isPlayed(showKey, ep.id);
  if (filter === 'played') return isPlayed(showKey, ep.id);
  if (filter === 'favorite') return isFavorite(showKey, ep.id);
  if (filter === 'offline') return app.offline.has(offlineKeyFor(showByKey(showKey), ep));
  return true;
}
function epStatusBadges(showKey, ep) {
  const bits = [];
  if (isFavorite(showKey, ep.id)) bits.push('<span class="pill">★ 收藏</span>');
  if (isPlayed(showKey, ep.id)) bits.push('<span class="pill dim">已听</span>');
  const rec = app.offline ? app.offline.get(offlineKeyFor(showByKey(showKey), ep)) : null;
  if (rec) bits.push('<span class="pill dim">离线' + (rec.hasTranscript ? ' · 字幕' : '') + '</span>');
  return bits.length ? '<span class="ep-badges">' + bits.join('') + '</span>' : '';
}
function formatDate(value) {
  const d = Date.parse(value || '');
  return Number.isFinite(d) ? new Date(d).toLocaleDateString('zh-CN') : '';
}
function fmtDuration(value) {
  if (value == null || value === '') return '';
  const text = String(value);
  if (text.includes(':')) return text;
  const seconds = Number(text);
  return Number.isFinite(seconds) && seconds > 0 ? fmt(seconds) : '';
}
function plainText(text) {
  const holder = document.createElement('div');
  holder.innerHTML = String(text || '');
  return (holder.textContent || '').replace(/\s+/g, ' ').trim();
}
function routeHash(page, args = [], params = {}) {
  const path = '#/' + [page, ...args.filter(x => x != null && x !== '').map(encodeURIComponent)].join('/');
  const query = new URLSearchParams(params).toString();
  return path + (query ? '?' + query : '');
}
const MODULE_ROUTES = {
  discover: 'discover', search: 'search', local: 'local', inbox: 'inbox', queue: 'queue',
  history: 'history', stats: 'stats', favorites: 'favorites', bookmarks: 'bookmarks',
  notes: 'notes', listening: 'listening', video: 'video', downloads: 'offline',
};
function moduleOn(key) { return !prefs.modules || prefs.modules[key] !== false; }
function routeModuleAllows(page) { const key = MODULE_ROUTES[page]; return !key || moduleOn(key); }
function setNodeVisible(node, visible) {
  if (!node) return;
  node.style.display = visible ? '' : 'none';
}
function normalizeSidebarPrefs(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const order = src.order && typeof src.order === 'object' ? src.order : {};
  const clean = (list, defaults) => {
    const picked = (Array.isArray(list) ? list : []).filter(route => defaults.includes(route));
    return [...new Set([...picked, ...defaults])];
  };
  return {
    order: { top: clean(order.top, SIDEBAR_TOP), bottom: clean(order.bottom, SIDEBAR_BOTTOM) },
    hidden: [...new Set((Array.isArray(src.hidden) ? src.hidden : []).filter(route => SIDEBAR_META[route]))],
  };
}
function sidebarOrder(group) {
  if (!prefs.sidebar) prefs.sidebar = normalizeSidebarPrefs(null);
  return prefs.sidebar.order[group] || (group === 'top' ? SIDEBAR_TOP : SIDEBAR_BOTTOM);
}
function applySidebarCustomization() {
  if (!prefs.sidebar) prefs.sidebar = normalizeSidebarPrefs(null);
  const hidden = new Set(prefs.sidebar.hidden);
  [['top', 'sideNav'], ['bottom', 'sideNav2']].forEach(([group, id]) => {
    const nav = $(id);
    if (!nav) return;
    sidebarOrder(group).forEach(route => {
      const btn = nav.querySelector('[data-route="' + route + '"]');
      if (!btn) return;
      nav.appendChild(btn);
      setNodeVisible(btn, !hidden.has(route) && routeModuleAllows(route));
    });
  });
  const mobile = $('mobileNav');
  if (mobile) {
    mobile.querySelectorAll('[data-route]').forEach(btn => {
      const route = btn.dataset.route;
      setNodeVisible(btn, !hidden.has(route) && routeModuleAllows(route));
    });
  }
}
function applyModules() {
  Object.keys(MODULE_ROUTES).forEach(page => {
    const on = moduleOn(MODULE_ROUTES[page]);
    ['sideNav', 'sideNav2', 'mobileNav'].forEach(id => {
      const nav = $(id);
      if (nav) nav.querySelectorAll('[data-route="' + page + '"]').forEach(btn => setNodeVisible(btn, on));
    });
    setNodeVisible($('page-' + page), on);
  });
  const route = parseRoute();
  if (!routeModuleAllows(route.page) && !document.body.classList.contains('player-open')) navigate('home');
  const flags = {
    'mod-off-liveAsr': !moduleOn('liveAsr'),
    'mod-off-translate': !moduleOn('translate'),
    'mod-off-floatWindow': !moduleOn('floatWindow'),
    'mod-off-chapters': !moduleOn('chapters'),
    'mod-off-offline': !moduleOn('offline'),
    'mod-off-exportShare': !moduleOn('exportShare'),
    'mod-off-study': !moduleOn('study'),
  };
  Object.keys(flags).forEach(cls => document.body.classList.toggle(cls, flags[cls]));
  if (!moduleOn('study') && $('studySheet')?.classList.contains('on')) closeStudySheet();
  if (!moduleOn('liveAsr') && typeof LIVE !== 'undefined' && LIVE.on) liveDisable('实时识别模块已关闭。');
  if (!moduleOn('chapters') && $('chapterSheet')?.classList.contains('on')) toggleChapterSheet(false);
  if (!moduleOn('translate') && typeof TR !== 'undefined' && TR.on) { TR.on = false; trSave(); syncTranslateSettings(); }
  if (!moduleOn('transcript') && state.cues.length) {
    box.innerHTML = '<div class="empty">文字稿模块已关闭，可在「设置 → 模块开关」重新开启。</div>';
    setState('cues', []); setState('nodes', []); setState('activeCue', -1);
  }
  applySidebarCustomization();
}
function bindModuleSwitches() {
  document.querySelectorAll('[data-module]').forEach(btn => {
    btn.onclick = () => {
      const key = btn.dataset.module;
      prefs.modules[key] = !moduleOn(key);
      savePrefs();
      btn.setAttribute('aria-checked', String(moduleOn(key)));
      applyModules();
      showToast((moduleOn(key) ? '已开启：' : '已关闭：') + (btn.closest('.setting-row')?.querySelector('strong')?.textContent || key));
    };
  });
}
function navigate(page, args = [], params = {}) {
  if (!routeModuleAllows(page)) page = 'home';
  if (page !== 'player' && $('clipNowPop')) motionLeave($('clipNowPop'));
  location.hash = routeHash(page, args, params);
}
function parseRoute() {
  const raw = String(location.hash || '').replace(/^#\/?/, '');
  const [pathPart, queryPart = ''] = raw.split('?');
  const args = pathPart.split('/').filter(Boolean).map(part => {
    try { return decodeURIComponent(part); } catch (e) { return part; }
  });
  return { page: args[0] || 'home', args: args.slice(1), params: new URLSearchParams(queryPart) };
}
function firstShowKey() {
  const sub = app.subs.find(s => showByKey(s.key)?.feed);
  return sub?.key || app.builtinShows.find(s => s.feed)?.slug || '';
}
function renderAfterStateChange() {
  if (document.body.classList.contains('player-open')) { syncMini(); return; }
  const r = parseRoute();
  renderPage(r.page, r);
  syncMini();
}
export { AUTO_DEFAULTS, AUTO_KEY, BOOKMARK_KEY, DL_META_KEY, DOCK_RATES, FAV_KEY, IDLE_TICK_MS, IDX_DB, IDX_STORE, INBOX_KEY, LOCAL_KEY, MODULE_ROUTES, NOTE_KEY, PAGE_NAMES, PLAYED_KEY, PLAYLIST_KEY, PLAY_TICK_MS, PREFS_KEY, QUEUE_KEY, SEEN_KEY, SHOWPREFS_KEY, SIDEBAR_BOTTOM, SIDEBAR_META, SIDEBAR_TOP, SUBS_KEY, THEME_NAMES, absoluteFeed, absoluteUrl, addInboxItem, addToPlaylist, addToPlaylistDialog, alignToCue, app, applyLoudness, applyModules, applyRate, applySidebarCustomization, applySkipRules, applyVolume, asrModelName, bindModuleSwitches, buffering, canAnalyseAudio, cancelAsrModel, cardFor, cardLink, catalogLatest, clampFrame, cleanFeedTitle, cleanWord, cleanWordCache, clearFindMarks, closeDockSheet, closeFind, closeWordPanel, copyPlain, defaultDownloadEpisode, defaultPlaylist, desiredPlayTick, dockSheet, dockToolsBtn, downloadEpisode, downloadInfo, downloadMetaStore, downloadsHTML, endFrameDrag, endSeekPreview, ensureAudioGraph, epStatusBadges, episodeFilterMatch, episodeRef, episodesOf, extSlug, externalShow, fetchTextAny, findAt, findBar, findBuiltinByFeed, findCount, findHits, findInput, findPlaylist, firstShowKey, fmtBytes, fmtDuration, formatDate, frameDrag, frameEl, frameMoved, framePos, hash32, hideSelTools, hostOf, idxClear, idxCount, idxDb, idxDbPromise, idxGet, idxGetAll, idxPut, importAsrModel, inboxCount, inboxRemove, indexAllShows, indexCurrentEpisode, indexCurrentShow, indexEpisode, installAsrModel, isFavorite, isPlayed, isSubscribed, jumpCue, loadChapters, localAsrModelId, localShowRecord, lookupWord, markCurrentPlayed, modeSegEl, moduleOn, navigate, normalizeFeedUrl, normalizeSidebarPrefs, offlineEntries, offlineKeyFor, offlineKeyOf, offlineLabel, onFrameMove, openAsrDir, openDockSheet, openFind, paintAsrSoon, parseRoute, pickAsrModel, pickedCue, pillRAF, placeFrame, placeSelTools, plainText, playOffline, playPlaylist, playTick, playTickMs, queueJumpPill, rateSegEl, readAllProgress, readJSON, readTranscriptDoc, refreshAsrModels, refreshOffline, refreshShows, rememberDownloadMeta, removalLeavesCurrentShow, removeAsrModel, removeOffline, removePlaylist, renderAfterStateChange, renderAsrModels, renderChapters, renderDownloads, renderLocalAsrModelHint, renderOfflineList, renderPlaylists, resolveOfflineRef, returnToCue, routeHash, routeModuleAllows, runFind, saveFavorites, saveInbox, saveOfflineTranscript, savePlayed, savePlaylists, saveSeen, saveShowPrefs, saveSubs, seekBy, seekChapter, seekDur, seekPreviewAt, seekTip, selCueIdx, selText, selTools, setAlignMode, setBuffering, setNodeVisible, setPlayed, setReadMode, setShowPref, showByKey, showFindAt, showForOfflineKey, showPrefFor, sidebarOrder, skipSilenceTick, sleepSegEl, startPlayTick, stopPlayTick, subscribeRecord, subscribeShow, syncChapterNow, syncDockBadge, syncDockLang, syncDockSleep, syncIndexCount, syncRateSeg, syncShowSelect, syncVolUI, toggleAlignMode, toggleChapterSheet, toggleFavorite, toggleMute, toggleStudySheet, trackEl, unsubscribeKey, webAudioGraph, whenIdle, wordCache, wordCurrent, wordCurrentMeaning, wordSeq, writeJSON };
registerLayer('05-transport-transcript-nav', { AUTO_DEFAULTS, AUTO_KEY, BOOKMARK_KEY, DL_META_KEY, DOCK_RATES, FAV_KEY, IDLE_TICK_MS, IDX_DB, IDX_STORE, INBOX_KEY, LOCAL_KEY, MODULE_ROUTES, NOTE_KEY, PAGE_NAMES, PLAYED_KEY, PLAYLIST_KEY, PLAY_TICK_MS, PREFS_KEY, QUEUE_KEY, SEEN_KEY, SHOWPREFS_KEY, SIDEBAR_BOTTOM, SIDEBAR_META, SIDEBAR_TOP, SUBS_KEY, THEME_NAMES, absoluteFeed, absoluteUrl, addInboxItem, addToPlaylist, addToPlaylistDialog, alignToCue, app, applyLoudness, applyModules, applyRate, applySidebarCustomization, applySkipRules, applyVolume, asrModelName, bindModuleSwitches, buffering, canAnalyseAudio, cancelAsrModel, cardFor, cardLink, catalogLatest, clampFrame, cleanFeedTitle, cleanWord, cleanWordCache, clearFindMarks, closeDockSheet, closeFind, closeWordPanel, copyPlain, defaultDownloadEpisode, defaultPlaylist, desiredPlayTick, dockSheet, dockToolsBtn, downloadEpisode, downloadInfo, downloadMetaStore, downloadsHTML, endFrameDrag, endSeekPreview, ensureAudioGraph, epStatusBadges, episodeFilterMatch, episodeRef, episodesOf, extSlug, externalShow, fetchTextAny, findAt, findBar, findBuiltinByFeed, findCount, findHits, findInput, findPlaylist, firstShowKey, fmtBytes, fmtDuration, formatDate, frameDrag, frameEl, frameMoved, framePos, hash32, hideSelTools, hostOf, idxClear, idxCount, idxDb, idxDbPromise, idxGet, idxGetAll, idxPut, importAsrModel, inboxCount, inboxRemove, indexAllShows, indexCurrentEpisode, indexCurrentShow, indexEpisode, installAsrModel, isFavorite, isPlayed, isSubscribed, jumpCue, loadChapters, localAsrModelId, localShowRecord, lookupWord, markCurrentPlayed, modeSegEl, moduleOn, navigate, normalizeFeedUrl, normalizeSidebarPrefs, offlineEntries, offlineKeyFor, offlineKeyOf, offlineLabel, onFrameMove, openAsrDir, openDockSheet, openFind, paintAsrSoon, parseRoute, pickAsrModel, pickedCue, pillRAF, placeFrame, placeSelTools, plainText, playOffline, playPlaylist, playTick, playTickMs, queueJumpPill, rateSegEl, readAllProgress, readJSON, readTranscriptDoc, refreshAsrModels, refreshOffline, refreshShows, rememberDownloadMeta, removalLeavesCurrentShow, removeAsrModel, removeOffline, removePlaylist, renderAfterStateChange, renderAsrModels, renderChapters, renderDownloads, renderLocalAsrModelHint, renderOfflineList, renderPlaylists, resolveOfflineRef, returnToCue, routeHash, routeModuleAllows, runFind, saveFavorites, saveInbox, saveOfflineTranscript, savePlayed, savePlaylists, saveSeen, saveShowPrefs, saveSubs, seekBy, seekChapter, seekDur, seekPreviewAt, seekTip, selCueIdx, selText, selTools, setAlignMode, setBuffering, setNodeVisible, setPlayed, setReadMode, setShowPref, showByKey, showFindAt, showForOfflineKey, showPrefFor, sidebarOrder, skipSilenceTick, sleepSegEl, startPlayTick, stopPlayTick, subscribeRecord, subscribeShow, syncChapterNow, syncDockBadge, syncDockLang, syncDockSleep, syncIndexCount, syncRateSeg, syncShowSelect, syncVolUI, toggleAlignMode, toggleChapterSheet, toggleFavorite, toggleMute, toggleStudySheet, trackEl, unsubscribeKey, webAudioGraph, whenIdle, wordCache, wordCurrent, wordCurrentMeaning, wordSeq, writeJSON });
