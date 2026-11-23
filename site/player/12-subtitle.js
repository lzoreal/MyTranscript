/* layer: subtitle —— 字幕的真相
   这个模块只回答四件事：现在讲到哪一句/哪个词、怎么把这一段画出来、要不要跟着滚、
   以及"用户刚自己滚过"的抑制。它不该知道主题、插件、路由、下载队列。

   接口（小）：
     locateCue(t)       → 句索引（纯函数，只读 state.cues / state.offset / state.activeCue 提示）
     paintWords(ci, t)  → 把「当前词」从上一位置推到新位置（只改那一段的 class）
     scrollCue / scrollWord / liveFollow → 跟随策略
     canFollow / stopScroll / scrollIntoBox / scrollTarget / reduceMotion → 跟随的地基

   藏起来的（实现）：附近 6~13 句的局部扫描、越界回退全量扫描、
   「偏移小于视口 18% 就不动」的抖动抑制、平滑/瞬时的选择、长距离跳转降级。

   为什么单独成层：2026-11-22 的性能诊断里，每帧路径（定位 + 逐词上色 + 跟随滚动）
   散在 view 层里，和主题/路由混在一起；把它收成一处之后，这条路径的改动与测试只在一个文件里。

   迁移方式：实现搬到这里，`01-theme-reader-shell` 保留同名薄转发（lazyFn），
   所以调用方（包括 05 的 scrollCue / stopScroll）零改动。 */
import { layerObject, layerValue, lazyFn, registerLayer } from './00-layers.js';
import { $, LIVE, audio, box, setState, state } from './00-runtime.js';

let scrollTarget = -1;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function stopScroll() { scrollTarget = -1; }

function scrollIntoBox(el, mode) {
  const br = box.getBoundingClientRect(), er = el.getBoundingClientRect();
  let top = null;
  if (mode === 'center') top = box.scrollTop + (er.top - br.top) - (box.clientHeight - er.height)/2;
  else if (er.top < br.top + 80) top = box.scrollTop + (er.top - br.top) - 80;
  else if (er.bottom > br.bottom - 80) top = box.scrollTop + (er.bottom - br.bottom) + 80;
  if (top === null) return;
  const target = Math.max(0, Math.min(top, box.scrollHeight - box.clientHeight));
  if (target === scrollTarget) return;
  scrollTarget = target;
  const far = Math.abs(target - box.scrollTop) > box.clientHeight * 1.2;
  box.scrollTo({ top: target, behavior: reduceMotion || document.hidden || far ? 'auto' : 'smooth' });
}

function canFollow(force) {
  return state.scroll !== 'off'
    && (force || Date.now() >= state.userScrollUntil)
    && (force || !audio.paused);
}

function scrollCue(el, force) {
  if (!canFollow(force)) return;
  const r = el.getBoundingClientRect(), br = box.getBoundingClientRect();
  const edge = r.top < br.top + 90 || r.bottom > br.bottom - 90;
  if (force || state.scroll === 'center' || edge) scrollIntoBox(el, state.scroll === 'center' ? 'center' : 'edge');
}

function scrollWord(el) {
  if (!canFollow(false)) return;
  if (state.scroll === 'center') {
    // 居中档要跟着“当前词”走，而不是只在一句开始时居中；偏移小于 18% 视口就不动，避免每词抖一下。
    const r = el.getBoundingClientRect(), br = box.getBoundingClientRect();
    const off = Math.abs((r.top + r.height / 2) - (br.top + box.clientHeight / 2));
    if (off > box.clientHeight * 0.18) scrollIntoBox(el, 'center');
    return;
  }
  const r = el.getBoundingClientRect(), br = box.getBoundingClientRect();
  if (r.top < br.top + 60 || r.bottom > br.bottom - 60) scrollIntoBox(el, 'edge');
}

// 实时模式没有原来的 scrollCue 可用（它按 VTT 的行推进，实时行不在它的窗口里），
// 而且 scrollWord 在「居中」模式下直接 return——所以实时正文要靠这个函数自己跟：
// 居中档要求高亮词始终落在正文框中间附近，边缘档只在快滚出去时挪一下。
function liveFollow(el) {
  if (!el || state.scroll === 'off') return;
  if (Date.now() < state.userScrollUntil || audio.paused) return;
  const br = box.getBoundingClientRect(), er = el.getBoundingClientRect();
  if (state.scroll === 'center') {
    const off = (er.top + er.height / 2) - (br.top + box.clientHeight / 2);
    if (Math.abs(off) > box.clientHeight * 0.16) scrollIntoBox(el, 'center');
    return;
  }
  if (er.top < br.top + 90 || er.bottom > br.bottom - 90) scrollIntoBox(el, 'edge');
}

function locateCue(t) {
  // 正常播放时先扫当前句附近，避免每 120ms 线性扫几千句；跳转/越界时再全量扫描。
  const cues = state.cues;
  const hint = state.activeCue;
  if (hint >= 0 && cues[hint]) {
    const h = cues[hint];
    const hs = h.speechStart + state.offset, he = h.speechEnd + state.offset;
    if (t >= hs - 2 && t <= he + 5) {
      let ans = -1, latestStart = -Infinity;
      const from = Math.max(0, hint - 6), to = Math.min(cues.length, hint + 13);
      for (let i = from; i < to; i++) {
        const c = cues[i];
        const start = c.speechStart + state.offset;
        if (start <= t && start >= latestStart) { latestStart = start; ans = i; }
      }
      const outside = cues[to];
      if (ans >= 0 && (!outside || outside.speechStart + state.offset > t)
        && t <= cues[ans].speechEnd + state.offset + 0.35) return ans;
    }
  }
  let ans = -1;
  let latestStart = -Infinity;
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const start = c.speechStart + state.offset;
    if (start <= t && start >= latestStart) {
      latestStart = start;
      ans = i;
    }
  }
  if (ans < 0) return -1;
  const c = cues[ans];
  return t <= c.speechEnd + state.offset + 0.35 ? ans : -1;
}

function paintWords(ci, t) {
  const cue = state.cues[ci], n = state.nodes[ci];
  if (!cue || !n || !cue.hasWords || !n.words.length) return;
  let idx = -1;
  for (let i = 0; i < cue.words.length; i++) { if (t >= cue.words[i].s + state.offset) idx = i; else break; }
  const prev = n.lastIdx;
  if (idx === prev) return;
  // 只重设「上次的当前词」到「这次的当前词」之间那一段：正常播放每次只挪一个词，
  // 原来每次都要遍历整句 30+ 个词并反复 add/remove class。
  const start = prev < 0 ? 0 : Math.max(0, Math.min(prev, idx));
  const end = Math.max(prev, idx);
  for (let i = start; i <= end; i++) {
    const w = n.words[i];
    if (i === idx) { w.classList.remove('pending','past'); w.classList.add('active'); }
    else if (i < idx) { w.classList.remove('pending','active'); w.classList.add('past'); }
    else { w.classList.remove('active','past'); w.classList.add('pending'); }
  }
  n.lastIdx = idx; setState('wordIdx', idx);
  if (idx >= 0 && n.words[idx]) scrollWord(n.words[idx]);
}

/* ---- 第二刀：宿主侧的字幕内核适配 ----
   renderCues / renderCueWindow 本来就只是"把视图句柄交给 subtitles 插件内核"的薄适配，
   现在连这份句柄（subtitleViewHost）一起搬过来：谁跟内核打交道，只有这一个文件。
   reader 每次现取——它在 01 里会被整体替换（恢复默认），缓存引用会拿到旧对象。 */
const subtitlePluginOn = lazyFn('04-local-audio-plugin-host', 'subtitlePluginOn');
const localAsrAvailable = lazyFn('04-local-audio-plugin-host', 'localAsrAvailable');
const clipListen = lazyFn('04-local-audio-plugin-host', 'clipListen');
const lookupWord = lazyFn('04-local-audio-plugin-host', 'lookupWord');
const alignToCue = lazyFn('05-transport-transcript-nav', 'alignToCue');
const whenIdle = lazyFn('05-transport-transcript-nav', 'whenIdle');
const studyApplyWordMarks = lazyFn('08-study-ai', 'studyApplyWordMarks');
const syncMiniCaption = lazyFn('09-player-integration', 'syncMiniCaption');
const fmt = lazyFn('01-theme-reader-shell', 'fmt');
const splitLabel = lazyFn('01-theme-reader-shell', 'splitLabel');
const isBracket = lazyFn('01-theme-reader-shell', 'isBracket');
const seekTo = lazyFn('01-theme-reader-shell', 'seekTo');
const paint = lazyFn('01-theme-reader-shell', 'paint');
const syncJumpPill = lazyFn('01-theme-reader-shell', 'syncJumpPill');
const PluginHost = layerObject('04-local-audio-plugin-host', 'PluginHost');

function readerNow() { return layerValue('01-theme-reader-shell', 'reader'); }

function subtitleKernel() { return PluginHost.kernel('transcript'); }

function subtitleViewHost() {
  return {
    state, box, reader: readerNow(),
    pluginOn: subtitlePluginOn,
    liveOn: () => !!LIVE.on,
    fmt, splitLabel, isBracket,
    localAsrAvailable, clipListen, lookupWord, alignToCue, seekTo,
    whenIdle, studyApplyWordMarks, paint, syncMiniCaption, syncJumpPill,
    resetFind: () => { if (window.mytFindReset) window.mytFindReset(); },
    el: $,
  };
}

function alignZhLines() {
  const kernel = subtitleKernel();
  if (kernel && typeof kernel.alignZhLines === 'function') kernel.alignZhLines(subtitleViewHost());
}

function renderCueWindow(center, force) {
  const kernel = subtitleKernel();
  if (kernel && typeof kernel.renderWindow === 'function') kernel.renderWindow(subtitleViewHost(), center, force);
}

function renderCues() {
  if (!subtitlePluginOn()) {
    // 原生播放器：没有字幕插件时阅读区只保留一条中性说明，不反复清空成空白，
    // 也不提示用户去启用插件。
    if (box.dataset.nativeAudio !== '1') {
      box.innerHTML = '<div class="empty">音频播放模式<br><span style="font-size:12px">本集只播放音频，未加载字幕。</span></div>';
      box.dataset.nativeAudio = '1';
    }
    syncMiniCaption(); return;
  }
  box.dataset.nativeAudio = '';
  const kernel = subtitleKernel();
  if (!kernel || typeof kernel.renderCues !== 'function') {
    box.innerHTML = '<div class="empty">字幕内核未加载：请启用 subtitles 插件。</div>';
    return;
  }
  kernel.renderCues(subtitleViewHost());
}

function mergeCues(vtt, sidecar, zhVtt) {
  const kernel = subtitleKernel();
  if (!kernel || typeof kernel.merge !== 'function') {
    throw new Error('字幕内核未加载：请启用 subtitles 插件');
  }
  const r = readerNow();
  return kernel.merge(vtt, sidecar, zhVtt, { lang: r.lang, segment: r.segment });
}

export {
  alignZhLines, canFollow, liveFollow, locateCue, mergeCues, paintWords, reduceMotion,
  renderCueWindow, renderCues, scrollCue, scrollIntoBox, scrollTarget, scrollWord, stopScroll,
  subtitleKernel, subtitleViewHost,
};
registerLayer('12-subtitle', {
  alignZhLines, canFollow, liveFollow, locateCue, mergeCues, paintWords, reduceMotion,
  renderCueWindow, renderCues, scrollCue, scrollIntoBox, scrollWord, stopScroll,
  subtitleKernel, subtitleViewHost,
});
