// 字幕视图内核：句块 DOM、窗口渲染、双语对齐。
// 宿主只提供音频/状态适配器，所有字幕排版逻辑放在插件里。
const SUBTITLE_WINDOW_SIZE = 240;
function subtitleAlignZhLines(host) {
  const items = [];
  for (const el of host.box.querySelectorAll('.cue')) {
    const z = el.querySelector('.zh');
    if (!z) continue;
    const wrap = z.previousElementSibling;
    if (!wrap) continue;
    const pad = parseFloat(getComputedStyle(el).paddingLeft) || 0;
    items.push([z, Math.max(0, wrap.offsetLeft - pad)]);
  }
  for (const [z, d] of items) z.style.marginLeft = d ? d + 'px' : '';
}
function subtitleCueNode(host, cue, ci) {
  const { state, reader } = host;
  const el = document.createElement('div');
  el.className = 'cue'; el.dataset.ci = ci;
  const stamp = document.createElement('span'); stamp.className = 'stamp'; stamp.textContent = host.fmt(cue.start + state.offset);
  el.append(stamp);
  // 桌面壳里所有音频都能精听：本地文件直接切片，离线和在线流先缓存整集再切片。
  if (state.current && host.localAsrAvailable()) {
    const clip = document.createElement('button');
    clip.type = 'button'; clip.className = 'cue-clip-btn'; clip.textContent = '精听';
    clip.title = '用当前模型单独重转这句；在线单集首次会先缓存音频';
    clip.addEventListener('click', e => {
      e.stopPropagation();
      host.clipListen(cue, ci, el, clip);
    });
    el.append(clip);
  }
  if (cue.speaker) { const sp = document.createElement('span'); sp.className = 'spk'; sp.textContent = cue.speaker; el.append(sp); }
  const wrap = document.createElement('span');
  wrap.lang = 'en';
  let wordEls = [];
  if (state.mode === 'word' && cue.hasWords) {
    const { label, words, mismatch } = host.splitLabel(cue.text, cue.words);
    if (!mismatch) {
      if (label) { const lb = document.createElement('span'); lb.className = 'label'; lb.textContent = label + ' '; wrap.append(lb); }
      words.forEach((w, wi) => {
        const sp = document.createElement('span');
        sp.className = 'word pending'; sp.textContent = w.t; sp.dataset.wi = wi;
        sp.addEventListener('click', e => {
          e.stopPropagation();
          const sel = getSelection();
          if (sel && !sel.isCollapsed) return;
          if (e.altKey) { host.lookupWord(w.t); return; }
          if (state.alignMode) { host.alignToCue(cue); return; }
          host.seekTo(w.s + state.offset);
        });
        sp.addEventListener('contextmenu', e => {
          e.preventDefault(); e.stopPropagation();
          host.lookupWord(w.t);
        });
        wrap.append(sp); wrap.append(document.createTextNode(' ')); wordEls.push(sp);
      });
    } else { wrap.textContent = cue.text; wordEls = []; }
  } else {
    wrap.textContent = cue.text;
    if (state.mode === 'word' && !host.isBracket(cue.text) && !cue.quiet) {
      const b = document.createElement('span'); b.className = 'badge'; b.textContent = cue.fromJson ? '句级' : '官网';
      wrap.append(b);
    }
  }
  el.append(wrap);
  if (reader.lang === 'both' && cue.zh) {
    const z = document.createElement('span'); z.className = 'zh'; z.lang = 'zh-CN'; z.textContent = cue.zh;
    el.append(z);
  }
  el.addEventListener('click', () => {
    const sel = getSelection();
    if (sel && !sel.isCollapsed) return;
    if (state.alignMode) { host.alignToCue(cue); return; }
    host.seekTo(cue.start + state.offset);
  });
  return { el, wrap, words: wordEls, lastIdx: -1 };
}
function subtitleRenderWindow(host, center, force) {
  const { state } = host;
  const total = state.cues.length;
  if (!total) return;
  let start = Math.max(0, Math.min(center - 60, total - SUBTITLE_WINDOW_SIZE));
  start = Math.max(0, start);
  const end = Math.min(total, start + SUBTITLE_WINDOW_SIZE);
  if (!force && state.windowStart >= 0 && start === state.windowStart && end === state.windowEnd && state.nodes[center]) return;
  state.windowStart = start; state.windowEnd = end;
  host.box.innerHTML = '';
  state.nodes = [];
  for (let ci = start; ci < end; ci++) {
    const node = subtitleCueNode(host, state.cues[ci], ci);
    state.nodes[ci] = node;
    host.box.append(node.el);
  }
  state.activeCue = -1; state.wordIdx = -1; state.pendingFollow = true;
  subtitleAlignZhLines(host);
  host.whenIdle(() => host.studyApplyWordMarks(), 900);
}
function subtitleRenderCues(host) {
  const { state } = host;
  if (!host.pluginOn()) { host.box.innerHTML = ''; host.syncMiniCaption(); return; }
  if (host.liveOn()) return;   // 实时模式自己管正文 DOM，别被 VTT 渲染覆盖
  host.box.innerHTML = ''; state.nodes = []; state.activeCue = -1; state.wordIdx = -1;
  state.windowStart = -1; state.windowEnd = 0;
  host.resetFind();
  if (!state.cues.length) { host.box.innerHTML = '<div class="empty">没有可显示的逐字稿。</div>'; host.syncJumpPill(); return; }
  subtitleRenderWindow(host, 0, true);
  let wordCount = 0, fallback = 0;
  state.cues.forEach(cue => {
    if (state.mode === 'word' && cue.hasWords) wordCount += (cue.words || []).length;
    else if (state.mode === 'word' && !host.isBracket(cue.text) && !cue.quiet) fallback++;
  });
  host.el('statCues').textContent = state.cues.length.toLocaleString();
  host.el('statWords').textContent = wordCount.toLocaleString();
  host.el('statFallback').textContent = fallback.toLocaleString();
  const axis = wordCount ? (fallback ? '混合' : '词级') : '句级';
  host.el('statAxis').textContent = axis; host.el('axisChip').textContent = axis;
  host.el('legend').textContent = state.mode === 'word'
    ? '逐词模式：当前词加粗、已读正常、未读弱化；无词时间戳的句子显示“句级”并回退 VTT 时间。键盘：[ / ] 切换句子。'
    : '逐句模式：按句子的起止时间高亮；点击任意句跳转。键盘：[ / ] 切换句子。';
  host.paint(false);
  host.syncMiniCaption();
}
window.MytSubtitleView = {
  renderCues: subtitleRenderCues,
  renderWindow: subtitleRenderWindow,
  alignZhLines: subtitleAlignZhLines,
  cueNode: subtitleCueNode,
};
