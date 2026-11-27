import { $, ASR_MODEL_DEFAULT, LIVE, LIVE_RATE, audio, box, host, listBox, prefs, setState, state, tauriHost } from './00-runtime.js';
import { closeDrawer, cuesFromJson, deriveTimingsUrl, deriveZhUrl, esc, fmt, getJson, getText, isJsonTranscript, liveFollow, loaderHTML, mergeCues, paint, parseVttSmart, parseZhVTT, preferredAudioUrl, progressKey, readProgress, reader, renderCues, resetImportUI, resetWordPanelForEpisode, saveProgress, seekTo, showToast, sitePath, status, syncJumpPill, updateTimeScale, vttFromSidecar, wallpaperRefresh } from './01-theme-reader-shell.js';
import { LIVE_ENGINE_KIND, clearLiveBarTimer, liveEmitTokens, liveLoadEngine, liveMediaOf, liveMseBegin, liveMseCapable, liveMseReanchor, liveMseStop, livePlayhead, liveProbeAudio, liveRetry, liveSetText, liveSherpaStream, liveStartPump, liveStopPump, liveUpdateMeter, liveWaitAudioReady } from './02-live-caption-wasm.js';





import { layerObject, lazyFn, registerLayer } from './00-layers.js';
const openLocalTranscript = lazyFn('04-local-audio-plugin-host', 'openLocalTranscript');
const subtitlePluginOn = lazyFn('04-local-audio-plugin-host', 'subtitlePluginOn');
const applyLoudness = lazyFn('05-transport-transcript-nav', 'applyLoudness');
const ensureAudioGraph = lazyFn('05-transport-transcript-nav', 'ensureAudioGraph');
const indexCurrentEpisode = lazyFn('05-transport-transcript-nav', 'indexCurrentEpisode');
const loadChapters = lazyFn('05-transport-transcript-nav', 'loadChapters');
const moduleOn = lazyFn('05-transport-transcript-nav', 'moduleOn');
const offlineKeyFor = lazyFn('05-transport-transcript-nav', 'offlineKeyFor');
const readTranscriptDoc = lazyFn('05-transport-transcript-nav', 'readTranscriptDoc');
const refreshOffline = lazyFn('05-transport-transcript-nav', 'refreshOffline');
const routeHash = lazyFn('05-transport-transcript-nav', 'routeHash');
const saveOfflineTranscript = lazyFn('05-transport-transcript-nav', 'saveOfflineTranscript');
const setAlignMode = lazyFn('05-transport-transcript-nav', 'setAlignMode');
const showPrefFor = lazyFn('05-transport-transcript-nav', 'showPrefFor');
const syncChapterNow = lazyFn('05-transport-transcript-nav', 'syncChapterNow');
const syncDockBadge = lazyFn('05-transport-transcript-nav', 'syncDockBadge');
const trNoteError = lazyFn('07-routes-pages', 'trNoteError');
const trReady = lazyFn('07-routes-pages', 'trReady');
const trText = lazyFn('07-routes-pages', 'trText');
const updateDocumentTitle = lazyFn('07-routes-pages', 'updateDocumentTitle');
const studyClockSeconds = lazyFn('08-study-ai', 'studyClockSeconds');
const studyResetContext = lazyFn('08-study-ai', 'studyResetContext');
const studyResetPlayback = lazyFn('08-study-ai', 'studyResetPlayback');
const syncBookmarkBtn = lazyFn('09-player-integration', 'syncBookmarkBtn');
const syncMini = lazyFn('09-player-integration', 'syncMini');
const syncReaderTop = lazyFn('09-player-integration', 'syncReaderTop');
const app = layerObject('05-transport-transcript-nav', 'app');
const studyCache = layerObject('08-study-ai', 'studyCache');
/* layer: bridge —— Tauri 原生 ASR、跨域隔离 SW、离线跳过
   本片只做该层的事，跨层调用走 kernel / host() / setState。 */
/* ---------- 原生推理（Tauri 壳）：sherpa-onnx 的 Windows DLL ----------
   和上面 WASM 版是同一个模型、同一套切词规则，只是把 decode 挪到了 Rust 侧：
   WebView 只负责喂 PCM、取 JSON，主线程不再被推理占住。 */
async function liveNativeLoad() {
  if (LIVE.busy) liveSetText('准备原生识别模型（未安装时会先下载）…', 'busy');
  const dir = await host().asrPrepare(prefs.asrModel || ASR_MODEL_DEFAULT);
  // 线程数留一个核给播放/界面；sherpa 的 intra-op 线程超过 4 收益很小。
  const cores = navigator.hardwareConcurrency || 4;
  const threads = Math.max(2, Math.min(4, cores > 4 ? cores - 1 : 2));
  const id = await host().asrOpen(dir, threads);
  if (typeof id !== 'number') throw new Error('原生识别器创建失败');
  return { kind: 'native', id, threads };
}

function liveNativeStream(session, anchor) {
  const id = LIVE.engine.id;
  const seg = { fed: 0, segBase: 0, lineId: 0, cursor: 0, lastSig: '' };
  let closed = false;
  let buf = null;        // 还没交给原生侧的那部分 PCM
  let inflight = false;  // 同一条命令通道串行，避免 feed/result 乱序
  const flush = async () => {
    if (closed || inflight || session !== LIVE.session) return;
    if (!buf || !buf.length) return;
    const samples = Array.from(buf);
    buf = null;
    inflight = true;
    try {
      await host().asrFeed(id, samples, 16000);
      if (closed || session !== LIVE.session) return;
      const json = await host().asrResult(id);
      if (closed || session !== LIVE.session) return;
      let r = null;
      try { r = JSON.parse(json || '{}'); } catch (e) { r = null; }
      if (!r) return;
      const needReset = liveEmitTokens(session, seg, r.tokens, r.timestamps);
      if (needReset) {
        await host().asrReset(id);
        seg.cursor = 0;
        seg.segBase = seg.fed;
      }
    } catch (err) {
      console.warn('[live] 原生识别失败', err && err.message ? err.message : err);
    } finally {
      inflight = false;
    }
  };
  return {
    addAudio(chunk, rate) {
      if (closed || !chunk || !chunk.length) return;
      buf = buf && buf.length ? liveConcatFloat(buf, chunk) : chunk;
      seg.fed += chunk.length / rate;
    },
    transcribe() { flush(); },
    stop() {},
    close() {
      if (closed) return;
      closed = true;
      buf = null;
      // 原生识别器是 LIVE.engine 共享的（整页只开一个），重建一段流只该「重置」它，
      // 绝不能 asrClose：关掉之后所有后续 asrFeed 都会回「识别器已关闭」，实时识别从此
      // 永远空白（实测跳一次进度、换一次集就会中招，跟音频格式无关，MP3 也一样）。
      try { host().asrReset(id); } catch (e) {}
    },
  };
}

function liveConcatFloat(a, b) {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// 宿主侧识别器一整页只会开一个，页面真要关掉时才释放它。
window.addEventListener('beforeunload', () => {
  if (LIVE.engine && LIVE.engine.kind === 'native') {
    try { host().asrClose(LIVE.engine.id); } catch (e) {}
  }
});



function liveCloseStream() {
  if (!LIVE.stream) return;
  try { LIVE.stream.stop(); } catch (e) {}
  try { LIVE.stream.close(); } catch (e) {}
  LIVE.stream = null;
}

function liveClearRows() {
  LIVE.order.forEach(id => { const row = LIVE.rows.get(id); if (row) row.el.remove(); });
  LIVE.rows.clear();
  LIVE.order.length = 0;
  LIVE.activeRow = '';
  LIVE.cursor = 0;
}

// 跳转后只砍掉“落在播放头之后”的行：往前跳时新识别会从播放头接着往下走，
// 留着旧行会时间倒退（新行会被单调校验挡掉，高亮就卡住）；往后跳时后面的行本来就作废。
// 播放头之前的行是这段话的真识别结果，保留下来读者不会看到整屏突然清空。
function liveTrimRowsAfter(t) {
  let cut = false;
  while (LIVE.order.length) {
    const key = LIVE.order[LIVE.order.length - 1];
    const row = LIVE.rows.get(key);
    if (!row || row.start < t - 0.5) break;
    LIVE.order.pop();
    LIVE.rows.delete(key);
    row.el.remove();
    cut = true;
  }
  if (cut) { LIVE.activeRow = ''; LIVE.cursor = 0; }
}

// 换集、跳转、倍速都会让“PCM 时间轴”和播放器时间轴脱钩，直接重建一段新流。
function liveRebuildStream() {
  if (!LIVE.engine) return;
  liveCloseStream();
  LIVE.session += 1;
  const session = LIVE.session;
  // 锚点要在建流之前定：sherpa 那一路流自己要把 t=0 对到媒体时间上。
  const anchor = livePlayhead();
  if (LIVE.engine.kind === 'sherpa') {
    LIVE.stream = liveSherpaStream(session, anchor);
  } else if (LIVE.engine.kind === 'native') {
    LIVE.stream = liveNativeStream(session, anchor);
  } else {
    const stream = LIVE.engine.createStream({ updateInterval: 0.5 });
    stream.addListener({
      onLineStarted: e => liveRenderLine(session, e.line),
      onLineTextChanged: e => liveRenderLine(session, e.line),
      onLineUpdated: e => liveRenderLine(session, e.line),
      onLineCompleted: e => liveRenderLine(session, e.line),
      onError: e => console.warn('[live] ASR', e.error && e.error.message ? e.error.message : e.error),
    });
    stream.start();
    LIVE.stream = stream;
  }
  LIVE.fed = 0;
  LIVE.lastTr = 0;
  LIVE.pcm = null;
  LIVE.anchorMedia = anchor;
  LIVE.next = LIVE.anchorMedia;   // 从这个播放点开始往后喂
  LIVE.prefetchQ = [];            // 预取队列里的窗口是按旧位置取的，重建时必须丢掉
  LIVE.prefetchFrom = LIVE.next;
  LIVE.prefetchWin = null;
  // 单流模式的字节游标要跟着新锚点走，否则 append 的时间轴会和播放头错开。
  if (LIVE.mse && LIVE.cbr && LIVE.cbr.kind === 'mp3') {
    LIVE.byteSec = LIVE.next;
    LIVE.bytePos = LIVE.cbr.origin + Math.round(LIVE.cbr.bps * LIVE.next);
  }
  LIVE.fail = 0;
  LIVE.text = '';
  liveStopPump();
  liveStartPump();
}

// Moonshine 的 `line.words` 里只有最前面几个词带真实时间，后面补进来的词 `start/end`
// 常常是 0（偶尔还会出现 end < start、时间倒退）。直接拿它们做逐词高亮，表现就是：
// 前几个词正常走，然后高亮卡住，接着一下子跳到行尾 —— 也就是“不跟随、乱跳”。
// 行的 `startTime` 和 `duration` 是可靠的，所以先看引擎给的时间能不能用（单调、落在
// 行区间内、长度非负），不能用就按词长把整行的词均分到 [start, start+duration]，
// 至少保证单调、连续、跟得上。
function liveWordTimes(line) {
  const ws = line.words || [];
  if (!ws.length) return [];
  const start = Number(line.startTime) || 0;
  const dur = Number(line.duration) || 0;
  const span = dur > 0.05 ? dur : Math.max(0.4, ws.length * 0.45);
  const engineOk = ws.every((w, i) => {
    const s = Number(w.start), e = Number(w.end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) return false;
    if (s < -0.02 || s > span + 0.02) return false;   // 词的 start 是相对行起点的
    if (e < s - 0.02) return false;
    if (i > 0 && s < Number(ws[i - 1].start) - 0.02) return false;
    return true;
  });
  if (engineOk) {
    return { engine: true, times: ws.map(w => ({ t: w.text, s: liveMediaOf(start + Number(w.start)), e: liveMediaOf(start + Number(w.end)) })) };
  }
  const weights = ws.map(w => Math.max(1, String(w.text || '').trim().length + 1));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  return { engine: false, times: ws.map((w, i) => {
    const a = acc;
    acc += weights[i] / total * span;
    const s = liveMediaOf(start + a);
    const e = liveMediaOf(start + (i === ws.length - 1 ? span : acc));
    return { t: w.text, s, e: Math.max(s + 0.05, e) };
  }) };
}

// 实时行译文：等这一行文字稳定 0.7 秒再翻，避免流式更新时反复请求；
// 译完作为该行下面的灰色小字，和原文字稿的 .zh 用同一套样式。
function liveRowZh(row) {
  if (!row || !row.zhText) return;
  let z = row.el.querySelector('.live-zh');
  if (!z) {
    z = document.createElement('span');
    z.className = 'zh live-zh';
    z.lang = 'zh-CN';
    row.el.append(z);
  }
  z.textContent = row.zhText;
}
function liveTranslateRow(row, text) {
  if (!row || !trReady()) return;
  clearTimeout(row.trTimer);
  row.trTimer = setTimeout(() => {
    if (!row.el.isConnected) return;
    const source = String(text || '').trim();
    if (!source) return;
    trText(source).then(zh => {
      if (!zh || row.trSource === source) return;
      row.trSource = source;
      row.zhText = zh;
      liveRowZh(row);
    }).catch(trNoteError);
  }, 700);
}

function liveRenderLine(session, line) {  if (session !== LIVE.session || !line) return;
  if (box.querySelector('.empty')) box.replaceChildren();
  // 每次重建流 line.id 都会从头开始，带上 session 才不会把旧行覆盖掉。
  const key = session + ':' + line.id;
  let row = LIVE.rows.get(key);
  if (!row) {
    const start = liveMediaOf(line.startTime);
    // 行必须按时间递增入列：重建流/跳转的瞬间偶尔会迟到半句旧时间，插进来会
    // 让游标定位错行、高亮跳到别的句子上去。时间倒退的直接丢掉。
    const prevKey = LIVE.order[LIVE.order.length - 1];
    const prevRow = prevKey ? LIVE.rows.get(prevKey) : null;
    if (prevRow && start < prevRow.start - 0.5) return;
    row = { el: document.createElement('div'), words: [], lastIdx: -1, sig: '', start };
    row.el.className = 'cue live';
    LIVE.rows.set(key, row);
    LIVE.order.push(key);
    box.append(row.el);
    if (LIVE.order.length > 240) {      // 只留最近若干句，长播客不会把 DOM 撑爆
      const drop = LIVE.order.shift();
      const old = LIVE.rows.get(drop);
      if (old) { old.el.remove(); LIVE.rows.delete(drop); }
    }
    liveUpdateMeter();
  }
  const wt = liveWordTimes(line);
  const words = wt.times;
  const sameWords = words.length === row.words.length
    && words.every((w, i) => w.t === row.words[i].t);
  const stampText = fmt(liveMediaOf(line.startTime));
  if (row.sig !== '' && sameWords) {
    // 流式识别每 0.5 秒会重发一次同一句：词数没变时只改文字，不动 DOM 结构。
    // 之前每次整行 replaceChildren，会把 .word.active 一起抹掉，高亮看起来在乱跳，
    // 重建节点还会连续触发重排，播放也跟着卡。
    words.forEach((w, i) => {
      const el = row.words[i].el;
      if (el.textContent !== w.t) el.textContent = w.t;
      // 时间会随行不断变长而重算（尤其是兜底均分那条路径），原地更新，
      // 不然高亮还按建行时那套旧时间去比，越到后面越对不上。
      row.words[i].s = w.s;
      row.words[i].e = w.e;
    });
    const stampEl = row.el.firstChild;
    if (stampEl && stampEl.className === 'stamp' && stampEl.textContent !== stampText) stampEl.textContent = stampText;
    row.sig = line.text + '|' + words.length + '|' + (line.isComplete ? '1' : '0');
    row.el.classList.toggle('done', !!line.isComplete);
    liveTranslateRow(row, line.text);
    return;
  }
  const sig = line.text + '|' + words.length + '|' + (line.isComplete ? '1' : '0');
  if (row.sig !== sig) {
    row.sig = sig;
    row.lastIdx = -1;
    const frag = document.createDocumentFragment();
    const stamp = document.createElement('span');
    stamp.className = 'stamp';
    stamp.textContent = fmt(liveMediaOf(line.startTime));
    frag.append(stamp);
    row.words = [];
    if (words.length) {
      words.forEach(w => {
        const span = document.createElement('span');
        span.className = 'word pending';
        span.textContent = w.t;
        span.addEventListener('click', ev => { ev.stopPropagation(); seekTo(w.s); });
        frag.append(span, document.createTextNode(' '));
        row.words.push({ el: span, s: w.s, e: w.e });
      });
    } else {
      const span = document.createElement('span');
      span.textContent = line.text;
      frag.append(span);
    }
    row.el.replaceChildren(frag);
    row.el.classList.toggle('done', !!line.isComplete);
    liveRowZh(row);
    liveTranslateRow(row, line.text);
  }
  // 视野跟着播放头走，而不是跟着“已经生成到哪”：提前量一大，最新一行还在
  // 60 秒之后，滚过去会把读者从正在读的位置拽走。
}

// 实时模式下由 paint() 转到这里：只驱动逐词高亮与进度显示。
function liveAdvance() {
  // 用音频元素的真实时间轴：识别喂进去的 PCM 就是这条时间轴上的位置，
  // 不能走 liveMediaTime()（它带倍速估算项，倍速时会和音频对不上，高亮越跑越偏）。
  const t = audio.currentTime || 0;
  if (state.seekPreview == null) {
    const nowText = fmt(t);
    $('now').textContent = nowText;
    setState('lastNowText', nowText);
    $('seek').setAttribute('aria-valuetext', fmt(t) + ' / ' + fmt(state.audioSeconds || audio.duration || 0));
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      const pct = Math.min(100, Math.max(0, (audio.currentTime || 0) / audio.duration * 100));
      setState('lastSeekBucket', Math.round(pct * 10));
      $('seek').value = String(state.lastSeekBucket);
      $('pfill').style.width = pct + '%';
    }
  }
  // paint() 在实时模式下直接转到这里，章节条得自己跟，否则 #chapterChip 会冻在旧章。
  syncChapterNow(t);
  const order = LIVE.order;
  if (!order.length) return;
  // 行按时间递增。提前量会把最新一行排到播放头之后几十秒，所以不能只看末尾几行：
  // 用游标前后微调，找到播放头所在行，再只给它和相邻行上色。
  const startOf = i => { const r = LIVE.rows.get(order[i]); return r ? r.start : Infinity; };
  let ci = Math.max(0, Math.min(LIVE.cursor, order.length - 1));
  while (ci > 0 && startOf(ci) > t) ci -= 1;
  while (ci < order.length - 1 && startOf(ci + 1) <= t) ci += 1;
  LIVE.cursor = ci;
  // 驾驶模式隐藏正文，上色和滚动都没有意义；退出驾驶时会把 lastIdx 全部置脏再重画。
  if (document.body.classList.contains('car-mode')) return;
  // 播放头可能正好落在一条“刚建出来、词还没到”的行上（流式识别先给文本再给词）。
  // 这种行不能算当前行，否则上一行会立刻被收成 past、又没有新的词接上，
  // 高亮就会空一帧再回来。往下退一行，退到最近一条真的有词的行。
  let ai = ci;
  while (ai > 0 && !(LIVE.rows.get(order[ai]) || { words: [] }).words.length) ai -= 1;
  let activeId = '';
  for (let i = Math.max(0, ai - 1); i <= Math.min(order.length - 1, ai + 1); i++) {
    const id = order[i];
    const row = LIVE.rows.get(id);
    if (!row || !row.words.length) continue;
    // 只有播放头所在的那一行在推进；它前面的收成 past，后面的保持 pending，
    // 否则两行时间有重叠时会出现两个 .word.active。
    let idx;
    if (i < ai) idx = row.words.length;
    else if (i > ai) idx = -1;
    else {
      idx = -1;
      for (let k = 0; k < row.words.length; k++) { if (t >= row.words[k].s) idx = k; else break; }
      // 行起点比它的第一个词早零点几秒：这时不要退出高亮，否则每换一句话
      // 高亮都会消失一下再回来（看起来就是“跳动”）。直接先压住第一个词。
      if (idx < 0 && t >= row.start) idx = 0;
    }
    if (idx >= 0) activeId = id;
    if (idx === row.lastIdx) continue;
    row.words.forEach((w, k) => {
      const el = w.el;
      el.classList.remove('active', 'past', 'pending');
      el.classList.add(k === idx ? 'active' : (k < idx ? 'past' : 'pending'));
    });
    row.lastIdx = idx;
    row.el.classList.toggle('active', idx >= 0 && i === ai);
    if (idx >= 0 && i === ai) liveFollow(row.words[idx].el);
  }
  // 活动行换人时把上一行彻底收尾（这里不动滚动，滚动只跟着高亮词）。
  if (LIVE.activeRow !== activeId) {
    const prev = LIVE.rows.get(LIVE.activeRow);
    if (prev && prev.words.length) {
      prev.words.forEach(w => { w.el.classList.remove('active', 'pending'); w.el.classList.add('past'); });
      prev.lastIdx = prev.words.length - 1;
      prev.el.classList.remove('active');
    }
    LIVE.activeRow = activeId;
  }
}

function liveDisable(hint) {
  LIVE.on = false;
  LIVE.mode = 'idle';
  LIVE.session += 1;
  liveStopPump();
  liveCloseStream();
  if (LIVE.mse) liveMseStop();   // 单流接管着播放，停实时识别前先把播放还回去
  liveClearRows();
  document.body.classList.remove('live-on');
  $('liveBtn').setAttribute('aria-pressed', 'false');
  $('liveBtn').classList.remove('on');
  clearLiveBarTimer();
  $('liveBar').hidden = true;
  $('liveMeter').style.width = '0%';
  if (state.base) renderCues();
  syncDockBadge();
  if (hint) showToast(hint, 5000);
}

// 页面默认不是跨域隔离的（GitHub Pages 不能设响应头）。同源 Service Worker 会在
// 下一次导航时给文档补 COOP/COEP:credentialless，所以这里只负责注册并请用户刷新一次。
async function liveEnsureIsolation() {
  if (self.crossOriginIsolated) return 'ready';
  if (!('serviceWorker' in navigator)) return 'unsupported';
  try {
    await navigator.serviceWorker.register('live-sw.js', { scope: './' });
    await navigator.serviceWorker.ready;
    return 'reload';
  } catch (e) {
    return 'unsupported';
  }
}

async function liveEnable() {
  if (!subtitlePluginOn()) { showToast('这一集没有可识别的文字稿。', 'warn'); return; }
  if (LIVE.busy || LIVE.on) return;
  if (!state.current) { showToast('先选一集，再开启实时识别。'); return; }
  const src = audio.currentSrc || audio.getAttribute('src') || '';
  if (!src) { showToast('这一集没有可采集的音频地址。'); return; }
  LIVE.busy = true;
  LIVE.mode = 'busy';
  LIVE.progressText = '';
  LIVE.text = '';
  $('liveBtn').classList.add('busy');
  $('liveBar').hidden = false;
  $('liveStopBtn').textContent = '停止';
  liveSetText('检查运行环境…', 'busy');
  try {
    // 跨域隔离只为 Moonshine 的多线程 WASM 准备；sherpa（WASM 单线程构建）和
    // 原生推理都不需要这一关。
    if (LIVE_ENGINE_KIND === 'moonshine') {
      const iso = await liveEnsureIsolation();
      if (iso !== 'ready') {
        LIVE.mode = 'needReload';
        $('liveStopBtn').textContent = iso === 'reload' ? '刷新页面' : '关闭';
        if (iso === 'reload') {
          // 刷新后是否续开由字幕插件决定：它会在 enable() 返回 needReload 时记下意图。
          liveSetText('需要刷新一次以启用跨域隔离，刷新后会自动继续', 'busy');
        } else {
          liveSetText('这个浏览器不支持 Service Worker，实时识别不可用', 'err');
        }
        return;
      }
    }
    LIVE.session += 1;
    const session = LIVE.session;
    if (LIVE.audioUrl !== src || !LIVE.cbr) {
      LIVE.audioUrl = src;
      LIVE.cbr = null;
      liveSetText('解析音频格式…', 'busy');
      LIVE.cbr = await liveRetry(() => liveProbeAudio(), 4, 900);
    }
    if (LIVE.session !== session) return;
    if (!LIVE.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('这个浏览器不支持 Web Audio 解码');
      LIVE.ctx = new Ctx({ sampleRate: LIVE_RATE });
    }
    liveSetText('下载识别模型…', 'busy');
    const engine = await Promise.race([
      liveLoadEngine(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('识别引擎加载超时（首次需下载约 40 MB 模型，缓存后秒开）')), 240000)),
    ]);
    if (!engine) throw new Error('识别引擎未就绪');
    LIVE.on = true;
    LIVE.mode = 'on';
    document.body.classList.add('live-on');
    $('liveBtn').setAttribute('aria-pressed', 'true');
    $('liveBtn').classList.add('on');
    syncDockBadge();
    // 单流播放：模型就绪后才接管播放，免得下模型失败时把用户的播放也搭进去。
    if (prefs.liveMse && LIVE.cbr && liveMseCapable()) {
      const wasPlaying = !audio.paused;   // 接管过程中会先暂停，这个状态要在这里先记住
      try {
        await liveMseBegin();
        if (wasPlaying || app.autoplay) { app.autoplay = false; audio.play().catch(() => {}); }
        status('单流播放已接管：同一份音频既用于播放也用于识别。', 'good');
      } catch (err) {
        liveMseStop();   // 接管失败就退回原生播放，实时识别照旧可用
        showToast('单流播放启动失败，已退回普通播放：' + (err && err.message ? err.message : err), 6000);
      }
    }
    liveClearRows();
    liveRebuildStream();
    liveSetText('实时识别中', 'on');
    status('实时识别已开启：正文显示本次播放的实时识别结果，原文字稿未被改动。', 'good');
  } catch (err) {
    // 音频源不给 CORS 头（stitcher/simplecast 那类 CDN 就是这样）：浏览器读不到字节，
    // 实时字幕在原理上就用不了，也别让它重试一阵再报错。
    const msg = err && err.cors
      ? '这个节目的音频源不允许跨域读取字节，实时字幕用不了（播放和原文字稿不受影响）'
      : (err && err.message ? err.message : String(err));
    LIVE.mode = 'failed';
    document.body.classList.remove('live-on');
    liveSetText('实时识别不可用：' + msg, 'err');
    showToast('实时识别不可用：' + msg, 9000);
    $('liveBtn').setAttribute('aria-pressed', 'false');
    $('liveBtn').classList.remove('on');
    LIVE.on = false;
    liveStopPump();
    liveCloseStream();
    $('liveMeter').style.width = '0%';
  } finally {
    LIVE.busy = false;
    $('liveBtn').classList.remove('busy');
  }
}

// 换集之后音频换了：重新探测格式，识别流从新的播放点重建。
// 这里用自己的 generation 判断“这次跟进是否还有效”，不再借用 LIVE.session：
// liveRebuildStream()（重建识别流）本身就会把 session 加一，用它当 token 会被自己
// 作废；而换集时可能同时来两次跟进，也需要“最新的那次赢、旧的自己退场”。
async function liveFollowCurrentEpisode(resumePlay) {
  if (!LIVE.on) return;
  const gen = LIVE.followGen = (LIVE.followGen || 0) + 1;
  const alive = () => LIVE.followGen === gen && LIVE.on;
  // 换集瞬间 audio.currentSrc 可能还是空（新的 src 刚 load、资源还没选好），
  // 这里等它落定再探测。以前直接取一次就拿去探测，换集后第一次探测必然失败，
  // 整条识别会停在“取音频数据失败”再也不恢复。
  let src = '';
  for (let i = 0; i < 6 && !src; i++) {
    src = audio.currentSrc || '';
    if (src) break;
    await new Promise(r => setTimeout(r, 1000));
    if (!alive()) return;
  }
  if (!src) {
    // 还没选出可读的音频地址：过一会儿再跟一次，别把识别判死。
    // 只在自己还是最新那次跟进时才排这一次重试，否则会把正在跑的那次顶掉。
    const p = resumePlay;
    if (alive()) setTimeout(() => { if (LIVE.on && LIVE.followGen === gen) liveFollowCurrentEpisode(p); }, 5000);
    return;
  }
  LIVE.audioUrl = src;
  LIVE.cbr = null;
  try {
    liveSetText('解析音频格式…', 'on');
    // 源站首字节偶发失败（实测换集后很常见），这里和首次开启一样带重试。
    LIVE.cbr = await liveRetry(() => liveProbeAudio(), 4, 900);
    if (!alive()) return;
    liveClearRows();
    liveRebuildStream();
    // 换集后自动重新接管：单流在 loadEpisode 里已经停掉（播放还给原生），这里等新一集
    // 拿到元数据再接管一次，用户不用手动开关「实时识别」。
    if (prefs.liveMse && LIVE.cbr && liveMseCapable()) {
      const wasPlaying = !!resumePlay || !audio.paused || app.autoplay;
      try {
        const ready = await liveWaitAudioReady(15000);
        if (!alive()) return;
        // 新一集还在加载（源站慢时元数据十几秒才到）：这时候去接管会先把正在加载的原生
        // src 摘掉，结果两边都读不到数据，界面一直停在“等待音频加载…”。等它加载好再接管。
        if (!ready) {
          if (LIVE.on) setTimeout(() => { if (LIVE.on && LIVE.followGen === gen) liveFollowCurrentEpisode(resumePlay); }, 8000);
          return;
        }
        await liveMseBegin();
        if (wasPlaying) { app.autoplay = false; audio.play().catch(() => {}); }
      } catch (err) {
        if (LIVE.mse) liveMseStop();
        // 接管半途失败时元素可能已经被我们摘掉 src：把原生地址挂回去，别让播放停在这。
        else if (LIVE.audioUrl && audio.src !== LIVE.audioUrl) {
          audio.src = LIVE.audioUrl; try { audio.load(); } catch (e) {}
        }
        if (wasPlaying) audio.play().catch(() => {});
      }
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    liveSetText('正在等待新一集音频（' + msg + '）…', 'busy');
    // 探测失败不等于这一集不能用：源站偶发失败过几秒就好，等一会儿重新跟一次。
    const p = resumePlay;
    if (alive()) {
      setTimeout(() => { if (LIVE.on && LIVE.followGen === gen) liveFollowCurrentEpisode(p); }, 6000);
    }
  }
}

audio.addEventListener('seeked', () => {
  if (!LIVE.on) return;
  const head = audio.currentTime || 0;
  // 音频重载、缓冲重试也会发 seeked，位置没变时不能把刚识别出来的行清掉；
  // 但“这段已经识别过”只能按**现有的行本身**判断，不能只看第一行起点 + LIVE.next：
  // 往回跳时 pump 会先按新位置重锚、重建流（next 变了），保留下来的旧行是跳转前那一段，
  // 只比首尾就会把中间的大空档也当成已识别 —— 于是既不裁行也不重建，新识别出来的行
  // 全被 liveRenderLine 里“时间倒退就丢掉”的守卫拦下。实测表现：识别还在跑、
  // 「已提前」仍是 14~15 秒，但正文永久停在跳转前那几句上。
  // 判据：找到起点不晚于播放头的那一行，再要求播放头离下一个已知起点不超过 30 秒
  // （中间空了这么久说明这段确实没识别过，得裁行重来）。
  const coversHead = (t) => {
    let last = null;
    let nextStart = Infinity;
    for (const key of LIVE.order) {
      const row = LIVE.rows.get(key);
      if (!row) continue;
      if (row.start <= t + 0.5) last = row;
      else { nextStart = row.start; break; }
    }
    if (!last) return false;
    const end = Number.isFinite(nextStart) ? nextStart : LIVE.next;
    return end - t <= 30;
  };
  if (LIVE.order.length && LIVE.next > head && coversHead(head)) {
    LIVE.cursor = 0;
    paint(true);
    return;
  }
  // 跳到已识别区间之外：不整屏清空，只砍掉播放头之后的行再接着识别，
  // 前面已经识别好的句子留在原地（清屏会让读者以为功能坏了，还要白等几秒）。
  liveTrimRowsAfter(head);
  if (LIVE.mse) {
    // seeked 会因为数据迟到才触发（MSE 里元素在拿到新位置数据前不发这个事件），
    // 等它到的时候 pump 往往已经把新位置重锚好了。数据在区间里就别再重建一次，
    // 否则每跳一次都会白清一遍行、白等几秒。
    const b = LIVE.mse.sb && LIVE.mse.sb.buffered;
    if (b && b.length && head >= b.start(0) - 1 && head <= b.end(b.length - 1) + 1) {
      LIVE.cursor = 0;
      paint(true);
      return;
    }
    liveMseReanchor(head).then(ok => { if (LIVE.on && ok) liveRebuildStream(); });
    return;
  }
  liveRebuildStream();
});
audio.addEventListener('ended', () => {
  if (LIVE.on && LIVE.stream) { try { LIVE.stream.transcribe(1); } catch (e) {} }
});

// 桌面壳：窗口去掉了系统标题栏（tauri.conf 里 decorations:false），这里把应用自己的
// 顶栏当标题栏用——顶栏/面包屑/侧栏品牌可以拖动窗口，右侧补一组自绘的最小化/最大化/关闭。
// 网页版没有 __TAURI__，整段不执行，行为不变。
(function shellFrame() {
  const T = tauriHost();
  if (!T || !T.window) return;
  let win = null;
  try {
    if (T.window.getCurrentWindow) win = T.window.getCurrentWindow();
    else if (T.window.getCurrent) win = T.window.getCurrent();
  } catch (e) { win = null; }
  if (!win) return;
  document.body.classList.add('deco');

  // 拖拽只认“mousedown 落点自己带属性”的元素，所以要把容器里的文本叶子一起标上；
  // 按钮/输入框保持不标，否则点不动。
  const markDrag = (el) => {
    if (!el) return;
    el.setAttribute('data-tauri-drag-region', '');
    el.querySelectorAll('*').forEach((kid) => {
      if (/^(BUTTON|INPUT|A|SELECT|TEXTAREA|SVG|PATH)$/.test(kid.tagName)) return;
      if (kid.dataset && kid.dataset.action) return;
      kid.setAttribute('data-tauri-drag-region', '');
    });
  };
  markDrag(document.querySelector('[data-anchor="drag-top"]') || document.querySelector('.topbar'));
  markDrag(document.querySelector('.brand'));
  // 播放页自己的 58px 顶栏也要能拖；按钮/窗口控件在 markDrag 里已经排除。
  markDrag(document.getElementById('readerTop') || document.querySelector('.reader-top-actions'));

  // 播放页是全屏阅读器，顶部那圈浮层是 pointer-events:none，拖不动。
  // 不铺透明拖拽带了（它会盖住顶部 38px 的控件和字幕首行）；直接把阅读区容器本身
  // 标成拖拽区——Tauri 的裸属性只在“落点就是该元素”时生效，所以点句子照样能跳转。
  [document.querySelector('.reader'), document.getElementById('transcript')].forEach((el) => {
    if (el) el.setAttribute('data-tauri-drag-region', '');
  });

  // 播放页保持原样：正文优先选字/点句跳转，只有顶栏和两侧空白能拖窗口。
  // 其它页面（首页/播客库/设置等）没有“选一段字幕”的需求，整页按住拖都能移动窗口；
  // 用移动阈值区分点击和拖动，避免把卡片、按钮的点击吞掉。
  let pageDrag = null;
  const noDragTarget = (el) => el && el.closest &&
    el.closest('button,input,textarea,select,a,summary,[contenteditable="true"],[role="button"],[data-no-drag]');
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || document.body.classList.contains('player-open')) return;
    if (noDragTarget(e.target)) return;
    pageDrag = { x: e.clientX, y: e.clientY, id: e.pointerId };
  }, true);
  document.addEventListener('pointermove', (e) => {
    if (!pageDrag || e.pointerId !== pageDrag.id) return;
    const dx = e.clientX - pageDrag.x;
    const dy = e.clientY - pageDrag.y;
    if (Math.hypot(dx, dy) < 8) return;
    pageDrag = null;
    try { window.getSelection()?.removeAllRanges(); } catch (err) {}
    e.preventDefault();
    try { win.startDragging(); } catch (err) {}
  }, { capture: true, passive: false });
  const endPageDrag = () => { pageDrag = null; };
  document.addEventListener('pointerup', endPageDrag, true);
  document.addEventListener('pointercancel', endPageDrag, true);

  const makeCtl = () => {
    const box = document.createElement('div');
    box.className = 'win-ctl';
    const svg = (id) => '<svg class="wc-ico" viewBox="0 0 24 24" aria-hidden="true"><use href="#' + id + '"/></svg>';
    box.innerHTML =
      '<button type="button" data-win="mini" title="迷你窗" aria-label="迷你窗">' + svg('i-win-mini') + '</button>' +
      '<button type="button" data-win="min" title="收进托盘" aria-label="收进托盘">' + svg('i-win-min') + '</button>' +
      '<button type="button" data-win="max" title="最大化" aria-label="最大化">' + svg('i-win-max') + '</button>' +
      '<button type="button" data-win="close" title="关闭" aria-label="关闭">' + svg('i-close') + '</button>';
    box.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-win]');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const k = btn.dataset.win;
      try {
        // 最小化 = 收进托盘继续播：音频留在主窗，托盘图标能把它叫回来。
        if (k === 'min') win.hide();
        else if (k === 'mini') { if (T.core && T.core.invoke) T.core.invoke('open_mini'); }
        else if (k === 'max') win.toggleMaximize();
        else if (k === 'close') win.close();
      } catch (err) { /* 权限缺失就静默，不把按钮点成异常 */ }
      if (k === 'max') {
        try {
          const maxed = await win.isMaximized();
          btn.innerHTML = svg(maxed ? 'i-win-restore' : 'i-win-max');
          btn.title = maxed ? '还原' : '最大化';
        } catch (err) {}
      }
    });
    return box;
  };
  // 骨架锚点优先：主题自带骨架时，窗口控件挂在骨架留出的那个位置上；
  // 没有锚点（老骨架）才回落到 .top-actions，两套骨架都能用。
  const topActions = document.querySelector('[data-anchor="window-controls"]') || document.querySelector('.top-actions');
  if (topActions) { const c = makeCtl(); c.classList.add('win-ctl-app'); topActions.appendChild(c); }
  const readerRight = document.querySelector('[data-anchor="reader-controls"]') || document.querySelector('.reader-top-right');
  if (readerRight) readerRight.appendChild(makeCtl());
})();

// 刷新回来接着开：第一次启用要先装 Service Worker 再刷新，不该让用户再点一次。
// 自动开实时识别（?live=1 / 刷新后续开）现在由字幕插件负责；宿主只保留引擎原语。

function applyEpisodeData(vtt, sidecar, zhVtt) {
  if (!subtitlePluginOn()) return;
  setState('vtt', vtt); setState('sidecar', sidecar); setState('zhVtt', zhVtt);
  setState('base', { vtt, sidecar, zhVtt });
  setState('audioSeconds', Number(sidecar?.audio_seconds) || 0);
  updateTimeScale();
  setState('cues', mergeCues(vtt, sidecar, zhVtt));
  detectAdRanges();
  studyApplyCachedAdRanges();
  renderCues();
  if (state.show && state.current) indexCurrentEpisode(state.show, state.current);
}
const AD_RE = /(sponsored by|this episode is sponsored|ad break|promo code|use code|广告|赞助|优惠码|折扣码)/i;
function sanitizeAdRanges(ranges, fallbackSource = 'ai') {
  const out = [];
  for (const raw of (Array.isArray(ranges) ? ranges : [])) {
    if (!raw || typeof raw !== 'object') continue;
    const start = studyClockSeconds(raw.start ?? raw.from ?? raw.time);
    const end = studyClockSeconds(raw.end ?? raw.to);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const label = String(raw.label || raw.title || raw.reason || '').trim().slice(0, 80);
    out.push({ start, end, label: label || '广告', source: String(raw.source || fallbackSource) });
  }
  return out;
}
function mergeAdRanges(lists) {
  const all = [].concat(...lists).filter(range => range && Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const range of all) {
    const last = out[out.length - 1];
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
      if ((!last.label || last.label === '广告') && range.label) last.label = range.label;
    } else {
      out.push(Object.assign({}, range));
    }
  }
  return out;
}
function detectAdRanges() {
  const ranges = [];
  for (const cue of state.cues || []) {
    const text = String(cue.text || '') + ' ' + String(cue.zh || '');
    if (!AD_RE.test(text)) continue;
    const start = Number(cue.start) || 0;
    const end = Number(cue.end) || start + 2;
    const last = ranges[ranges.length - 1];
    if (last && start - last.end < 8) last.end = Math.max(last.end, end);
    else ranges.push({ start, end, label: '文字稿广告标记', source: 'transcript' });
  }
  setState('regexAdRanges', ranges);
  setState('adRanges', mergeAdRanges([ranges, state.aiAdRanges || []]));
}
function studyAdRangesFromData(data) {
  return sanitizeAdRanges(Array.isArray(data?.ads) ? data.ads : []);
}
function studyApplyAiAdRanges(data, epId) {
  if (!state.current || (epId && state.current.id !== epId)) return;
  setState('aiAdRanges', studyAdRangesFromData(data));
  setState('adSkipped', new Set());
  detectAdRanges();
}
function studyApplyCachedAdRanges() {
  const ep = state.current;
  if (!ep) return;
  try {
    const cached = studyCache['ep:' + ep.id];
    if (cached?.data?.version === 3) studyApplyAiAdRanges(cached.data, ep.id);
  } catch (e) {}
}
/* ---- cue 级跳过：只对「离线音频 + 本机文字稿」生效（2026-11-19 P0）
   为什么加这个门：skip.json 的标签是按本机转写切句算的，只有同一份本地音频 + 本地文字稿，
   时间轴才对得上；站外/动态插播的集套标签会跳错位置。 ---- */
function skipUrlOf(url) {
  return String(url || '').replace(/\.json(\?[^#]*)?$/i, '.skip.json$1');
}
function nearestCueIndex(cues, t) {
  let lo = 0, hi = cues.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = Number(cues[mid].start) || 0;
    if (s <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}
function localAudioOn() {
  const src = String(audio.currentSrc || audio.src || '');
  const prefer = state.current ? String(preferredAudioUrl(state.current) || '') : '';
  return /^asset:/i.test(src) || /asset\.localhost/i.test(src) || /^asset:/i.test(prefer) || /asset\.localhost/i.test(prefer);
}
function skipEligible() {
  return state.localTranscript === true && localAudioOn() && !!(host() && host().kind === 'tauri');
}
function skipWanted(tag, conf) {
  const lv = Number(prefs.skipLevel) || 0;
  if (!prefs.skipAds || lv <= 0) return false;
  if (tag === 'ad') return conf >= 0.5;
  if (tag === 'promo') return lv >= 2 && conf >= 0.55;
  if (tag === 'filler') return lv >= 3 && conf >= (lv >= 4 ? 0.5 : 0.8);
  return false;
}
function buildSkipPlan(doc) {
  const cues = state.cues || [];
  const tags = new Map();
  for (const raw of (Array.isArray(doc && doc.segments) ? doc.segments : [])) {
    if (!raw || !raw.tag) continue;
    const t = Number(raw.start);
    let idx = Number.isInteger(raw.i) ? raw.i : -1;
    if (!(idx >= 0 && idx < cues.length) || Math.abs((Number(cues[idx].start) || 0) - t) > 1.5) {
      idx = nearestCueIndex(cues, t);
    }
    if (idx >= 0) tags.set(idx, { tag: String(raw.tag), conf: Number(raw.conf) || 0, label: String(raw.label || '') });
  }
  const dur = Number(doc && doc.audio_seconds) || Number(state.audioSeconds) || 0;
  let ranges = (Array.isArray(doc && doc.ranges) ? doc.ranges : [])
    .filter(r => r && Number(r.end) > Number(r.start))
    .map(r => ({
      start: Number(r.start),
      end: Number(r.end),
      tag: String(r.tag || 'ad'),
      conf: Number(r.conf) || 0,
      label: String(r.label || ''),
      id: String(r.id || (String(r.tag || 'ad') + ':' + Math.round(Number(r.start) * 10))),
    }))
    .sort((a, b) => a.start - b.start);
  // 单集最多跳 40%：从置信度最低的区间开始砍，宁可少跳也不吞掉整集。
  let limited = false;
  const budget = dur > 0 ? dur * 0.4 : Infinity;
  const total = () => ranges.reduce((n, r) => n + (r.end - r.start), 0);
  while (ranges.length && total() > budget) {
    let worst = 0;
    for (let i = 1; i < ranges.length; i++) if (ranges[i].conf < ranges[worst].conf) worst = i;
    ranges.splice(worst, 1);
    limited = true;
  }
  return { source: doc ? 'disk' : 'none', tags, ranges, limited, duration: dur };
}
async function loadSkipPlan(show, ep, isLocal) {
  setState('skipPlan', null);
  if (!isLocal || !ep || !ep.transcript || !isJsonTranscript(ep.transcript)) return;
  if (!skipEligible()) return;
  let doc = null;
  const key = offlineKeyFor(show, ep);
  // 优先读本机：只有随文字稿一起落盘的标签，才保证和本地音频是同一版。
  if (host() && typeof host().offlineSkipLoad === 'function') {
    try {
      const text = await host().offlineSkipLoad(key);
      if (text) doc = JSON.parse(text);
    } catch (e) {}
  }
  if (!doc) {
    const url = skipUrlOf(ep.transcript.url);
    if (!url || url === ep.transcript.url) return;
    try { doc = await getJson(url); } catch (e) { return; }
    // 顺手落盘一份：这次联网拿到了，下次断网也能跳过。
    if (host() && typeof host().offlineSkipSave === 'function') {
      host().offlineSkipSave(url, key).catch(() => {});
    }
  }
  if (!doc || !state.current || state.current.id !== ep.id) return;
  if (!skipEligible()) return;
  setState('skipPlan', buildSkipPlan(doc));
}
function findSkipRange(now) {
  const plan = state.skipPlan;
  if (!plan || !plan.ranges.length) return null;
  for (const r of plan.ranges) {
    if (now < r.start || now >= r.end - 0.3) continue;
    if (!skipWanted(r.tag, r.conf)) continue;
    if (state.skipDone.has(r.id) || state.skipMuted.has(r.id)) continue;
    // 进入区间超过 0.5 秒还在这里 = 用户自己拖进来的，本次不再自动跳。
    if (now - r.start > 0.5 || r.end - now < 3) { state.skipMuted.add(r.id); continue; }
    return r;
  }
  return null;
}
function transcriptFailure(err) {
  box.innerHTML = '<div class="empty"><div><b>字幕加载失败</b>' + esc(err.message) +
    '<br><span style="font-size:12px">音频仍可播放。</span></div></div>';
  status('字幕加载失败：' + err.message + '（音频仍可播放）', 'warn');
}
function selectEpisode(item, keepDrawer = false) {
  if (!item) return;
  saveProgress(true);
  setAlignMode(false);
  setState('current', item);
  // 下载后整集转写会落一份 localasr 稿在音频旁边；重新进应用后靠离线记录把它接回来，
  // 否则只有本次运行能读、重启就丢稿。
  try {
    const rec = app.offline && app.offline.get(offlineKeyFor(state.show, item));
    if (rec && rec.localTranscript && rec.path) {
      item.localPath = rec.path;
      item.transcript = { type: 'application/json', url: 'local-asr', local: true };
    }
  } catch (e) {}
  studyResetPlayback(); studyResetContext();
  item.showKey = state.show.slug;
  if (document.body.classList.contains('player-open')) {
    const want = routeHash('player', [state.show.slug, item.id]);
    if (location.hash !== want) history.replaceState(null, '', want);
  }
  try { localStorage.setItem('myt-ep-' + state.show.slug, item.id); } catch (e) {}
  syncReaderTop();
  updateDocumentTitle();
  [...listBox.children].forEach(el => el.classList.toggle('active', el.dataset.ep === item.id));
  const activeEl = [...listBox.children].find(el => el.dataset.ep === item.id);
  if (activeEl) {
    const lr = listBox.getBoundingClientRect(), ar = activeEl.getBoundingClientRect();
    if (ar.top < lr.top || ar.bottom > lr.bottom) listBox.scrollTop += ar.top - lr.top - 6;
  }
  $('epNum').textContent = (state.show.name || '') + (item.num ? ' · #' + item.num : '');
  $('epTitle').textContent = item.title || (state.show.name || '');
  $('dTitle').textContent = item.title || (state.show.name || '');
  $('epMeta').textContent = item.date ? new Date(item.date).toLocaleDateString('zh-CN') : '';
  $('dMeta').textContent = [item.date ? new Date(item.date).toLocaleDateString('zh-CN') : '',
    subtitlePluginOn() ? (item.transcript ? '字幕' : '无字幕') : '', state.show.name].filter(Boolean).join(' · ');
  const cover = $('cover');
  const themeCss = getComputedStyle(document.documentElement);
  const tAccent = themeCss.getPropertyValue('--accent').trim() || '#d8b277';
  const tPanel = themeCss.getPropertyValue('--panel2').trim() || '#111111';
  const tBg = themeCss.getPropertyValue('--bg').trim() || '#111111';
  const coverFallback = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="88" height="88"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="' + tPanel + '"/><stop offset="1" stop-color="' + tBg + '"/></linearGradient></defs><rect width="88" height="88" fill="url(#g)"/><circle cx="44" cy="44" r="13" fill="none" stroke="' + tAccent + '" stroke-opacity=".3"/><circle cx="44" cy="44" r="3" fill="' + tAccent + '" fill-opacity=".35"/></svg>');
  cover.onerror = () => { cover.onerror = null; cover.src = coverFallback; };
  if (item.img) { cover.src = item.img; cover.hidden = false; } else { cover.src = coverFallback; cover.hidden = false; }
  const frameCover = $('frameCover');
  frameCover.onerror = () => { frameCover.onerror = null; frameCover.src = coverFallback; };
  frameCover.src = item.img || coverFallback;
  setState('audioRetried', 0);
  const audioUrl = preferredAudioUrl(item);
  loadChapters(item);
  setState('audioUsed', new Set([item.url, audioUrl].filter(Boolean)));
  state.audioToken += 1;
  setState('resumeEp', item.id);
  setState('resumeAt', readProgress(item));
  const showPref = showPrefFor(state.show.slug);
  setState('introSkipped', state.resumeAt > Number(showPref.skipIntro || 0));
  setState('outroSkipped', false);
  setState('adSkipped', new Set());
  setState('adRanges', []);
  setState('aiAdRanges', []);
  setState('regexAdRanges', []);
  setState('localTranscript', false);
  setState('skipPlan', null);
  setState('skipDone', new Set());
  setState('skipMuted', new Set());
  setState('audioKey', progressKey(item));
  setState('progressSavedAt', 0);
  audio.dataset.ep = item.id;
  // 换集：单流模式把播放交给原生元素（下面这段会重设 src），实时识别继续走
  // Range 路径；这里等新一集就绪后会自动再接管一次。
  // 先记下换集前是不是在播：下面 audio.pause() 之后这个状态就没了，等重新接管完
  // 要靠它决定是否接着播（否则换集后音频会停在原地不动，看起来像卡死）。
  const wasPlaying = !audio.paused;
  if (LIVE.mse) liveMseStop();
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  if (audioUrl) { audio.src = audioUrl; audio.load(); }
  if (prefs.skipSilence) ensureAudioGraph();
  applyLoudness(!!prefs.loudness);
  audio.playbackRate = Number(showPref.speed) || prefs.speed || 1;
  // 换集会换掉音频字节与时间轴：上一集的实时结果必须清掉，再按新音频重建。
  if (LIVE.on) { liveClearRows(); liveRebuildStream(); liveFollowCurrentEpisode(wasPlaying); }
  if (app.autoplay) { app.autoplay = false; audio.play().catch(() => {}); }
  setState('audioSeconds', 0); setState('timeScale', 1); setState('seekRaw', 0);
  $('total').textContent = '00:00'; $('now').textContent = '00:00';
  $('seek').value = '0'; $('pfill').style.width = '0%';
  setState('lastNowText', '00:00'); setState('lastAriaText', null); setState('lastSeekBucket', 0);
  box.innerHTML = '<div class="empty">' + loaderHTML('正在加载字幕…') + '</div>';
  setState('cues', []); setState('nodes', []); setState('activeCue', -1); setState('vtt', null); setState('sidecar', null); setState('zhVtt', null);
  setState('base', null); setState('experiment', null); resetImportUI();
  if (state.wallpaper) { resetWordPanelForEpisode(state.current && state.current.id); wallpaperRefresh(); }
  syncJumpPill();
  syncMini();
  syncBookmarkBtn();
  if (!keepDrawer) closeDrawer();
  const seq = ++state.transcriptSeq;
  if (!subtitlePluginOn()) {
    // 没有字幕能力时保持最原生状态：只播放音频，不加载/解析/渲染任何文字稿。
    // 文案不解释“为什么没有字幕”——这个开关一关，应用本来就只做音频。
    box.innerHTML = '<div class="empty">音频播放模式<br><span style="font-size:12px">本集只播放音频，播放、进度和倍速照常可用。</span></div>';
    box.dataset.nativeAudio = '1';
    setState('cues', []); setState('nodes', []); setState('activeCue', -1); setState('vtt', null); setState('sidecar', null); setState('zhVtt', null); setState('base', null);
    status('音频播放模式。');
    syncJumpPill(); syncMini(); syncBookmarkBtn();
    return;
  }
  if (!moduleOn('transcript')) {
    box.innerHTML = '<div class="empty">文字稿模块已关闭，可在「设置 → 模块开关」重新开启。</div>';
    setState('cues', []); setState('nodes', []); setState('activeCue', -1); setState('vtt', null); setState('sidecar', null); setState('zhVtt', null); setState('base', null);
    syncJumpPill(); syncMini(); syncBookmarkBtn();
    return;
  }
  if (item.localPath && (!item.transcript || item.transcript.url === 'local-asr')) {
    openLocalTranscript(item, seq);
    return;
  }
  if (!item.transcript) {
    box.innerHTML = '<div class="empty">该集没有字幕，可直接播放音频。</div>';
    status('该集没有字幕，可直接播放音频。', 'warn');
    return;
  }
  status('正在加载字幕…');
  const transcript = item.transcript;
  if (transcript.type === 'application/json' || /\.json(?:$|\?)/i.test(transcript.url)) {
    const showAtLoad = state.show;
    const itemAtLoad = item;
    readTranscriptDoc(showAtLoad, itemAtLoad).then(({ doc, local }) => {
      if (seq !== state.transcriptSeq) return;
      if (!doc) throw new Error(local ? '本机文字稿已损坏，且无法连接网络' : 'JSON 加载失败');
      const built = cuesFromJson(doc);
      if (!built.vtt.length) throw new Error('JSON 中没有可显示的段落');
      applyEpisodeData(built.vtt, built.sidecar, built.zhVtt);
      setState('localTranscript', !!local);
      loadSkipPlan(showAtLoad, itemAtLoad, !!local);
      const words = state.cues.reduce((n, c) => n + c.words.length, 0);
      status((local ? '已从本机离线文字稿加载 ' : '已加载 ') + built.vtt.length + ' 段，' + words.toLocaleString() + ' 个词级时间点。' +
        (reader.lang !== 'en' && !state.zhVtt ? ' 该集暂无中文，已显示英文。' : ''), 'good');
      // 旧版本只下了音频的整集，打开时顺手补下文字稿；失败只影响下次，不打扰阅读。
      if (!local && app.offline && app.offline.get(offlineKeyFor(showAtLoad, itemAtLoad))) {
        saveOfflineTranscript(showAtLoad, itemAtLoad)
          .then(ok => { if (ok) refreshOffline(); })
          .catch(() => {});
      }
    }).catch(err => { if (seq === state.transcriptSeq) transcriptFailure(err); });
    return;
  }
  const vttUrl = sitePath(transcript.url);
  const timingsUrl = state.show.timings ? deriveTimingsUrl(vttUrl) : null;
  Promise.all([
    getText(vttUrl),
    timingsUrl ? getJson(timingsUrl) : Promise.resolve(null),
  ]).then(async ([vttText, sidecar]) => {
    if (seq !== state.transcriptSeq) return;
    if (!vttText) throw new Error('VTT 加载失败');
    const parsed = parseVttSmart(vttText);
    const zhText = parsed.hasCjk ? null : await getText(deriveZhUrl(vttUrl));
    if (seq !== state.transcriptSeq) return;
    let vtt = parsed.primary;
    if (!vtt.length) vtt = vttFromSidecar(sidecar);
    if (!vtt.length) throw new Error('VTT 解析为空');
    const zhVtt = parsed.hasCjk ? parsed.zh : (zhText ? parseZhVTT(zhText) : null);
    applyEpisodeData(vtt, sidecar, zhVtt);
    const aligned = sidecar && Array.isArray(sidecar.segments) && sidecar.segments.length === vtt.length;
    const complete = sidecar?.complete === true;
    if (!sidecar) status('未找到词级时间轴，按句级时间显示。', 'warn');
    else if (!complete) status('该集的修正时间轴尚未完成（' + (sidecar.rejected || '未完成') + '），按句级时间显示。', 'warn');
    else if (!aligned) status('词级时间轴与 VTT 段落数不一致（' + (sidecar.segments?.length || 0) + ' vs ' + vtt.length + '），已按可匹配部分合并。', 'warn');
    else status('已加载 ' + vtt.length + ' 段，' + state.cues.reduce((n, c) => n + c.words.length, 0).toLocaleString() + ' 个词级时间点。' +
      (reader.lang !== 'en' && !zhVtt ? ' 该集暂无中文，已显示英文。' : ''), 'good');
  }).catch(err => { if (seq === state.transcriptSeq) transcriptFailure(err); });
}
export { AD_RE, applyEpisodeData, buildSkipPlan, detectAdRanges, findSkipRange, liveAdvance, liveClearRows, liveCloseStream, liveConcatFloat, liveDisable, liveEnable, liveEnsureIsolation, liveFollowCurrentEpisode, liveNativeLoad, liveNativeStream, liveRebuildStream, liveRenderLine, liveRowZh, liveTranslateRow, liveTrimRowsAfter, liveWordTimes, loadSkipPlan, localAudioOn, mergeAdRanges, nearestCueIndex, sanitizeAdRanges, selectEpisode, skipEligible, skipUrlOf, skipWanted, studyAdRangesFromData, studyApplyAiAdRanges, studyApplyCachedAdRanges, transcriptFailure };
registerLayer('03-native-asr-service-worker', { AD_RE, applyEpisodeData, buildSkipPlan, detectAdRanges, findSkipRange, liveAdvance, liveClearRows, liveCloseStream, liveConcatFloat, liveDisable, liveEnable, liveEnsureIsolation, liveFollowCurrentEpisode, liveNativeLoad, liveNativeStream, liveRebuildStream, liveRenderLine, liveRowZh, liveTranslateRow, liveTrimRowsAfter, liveWordTimes, loadSkipPlan, localAudioOn, mergeAdRanges, nearestCueIndex, sanitizeAdRanges, selectEpisode, skipEligible, skipUrlOf, skipWanted, studyAdRangesFromData, studyApplyAiAdRanges, studyApplyCachedAdRanges, transcriptFailure });
