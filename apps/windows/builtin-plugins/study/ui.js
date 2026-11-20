/* 学英语的界面实现（阶段二）：面板、复习、词卡、整集总结、AI 设置。
   通过 createStudyUi(api, host) 注入宿主原语，stop/软重载由宿主注销。 */
function createStudyUi(api, host) {
  const $ = id => document.getElementById(id);
  const studyEngine = () => api.study.engine();
  const studyRuntime = () => api.study.runtime();
  host.player.setView('card');
  let studyView = 'card';
  let studyRenderedVocab = [];
  let studyTermData = new Map(), studyTermPinned = false, studyTermFocusKeys = new Set();
  let studyTranscriptTermData = new Map();
  let studyReviewRevealed = false, studyHideZh = false;
  let studyExercise = null, studyVocabContext = null, studyVocabContextMode = null;
  let pendingStudyEpisode = '';
  let uiAbort = null;
  let studyTermTipsBound = false;
  function beginUiBindings() {
    if (uiAbort) { try { uiAbort.abort(); } catch (e) {} }
    uiAbort = new AbortController();
    studyTermTipsBound = false;
  }
  function uiListen(target, type, fn, opts) {
    if (!target) return;
    if (!uiAbort) uiAbort = new AbortController();
    const options = Object.assign({}, opts || {});
    if (!options.signal) options.signal = uiAbort.signal;
    target.addEventListener(type, fn, options);
  }
  function disposeStudyUI() {
    try { closeStudySheet(); } catch (e) {}
    pendingStudyEpisode = '';
    if (uiAbort) { try { uiAbort.abort(); } catch (e) {} uiAbort = null; }
    studyTermTipsBound = false;
  }
  function resetStudyContext() {
    studyExercise = null;
    studyVocabContext = null;
    studyVocabContextMode = null;
  }
/* ================== AI 学英语 ================== */
const STUDY_KEY = 'myt-study', STUDY_CACHE_KEY = 'myt-study-cache', STUDY_VOCAB_KEY = 'myt-study-vocab', STUDY_STATUS_KEY = 'myt-study-status';
const STUDY_SUMMARY_CHUNKS = 3;
const STUDY_DEFAULTS = { provider: 'openai', endpoint: 'https://api.openai.com/v1', key: '', model: 'gpt-4o-mini', target: 'zh-CN' };
const engine = api.study.engine();
if (!engine) throw new Error('学习引擎未注册，先 registerEngine');
const STUDY = engine.settings;
let studyCache = engine.cache;
let studyVocab = engine.vocab;
let studyStatus = engine.status;


function saveStudy() {
  const engine = studyEngine();
  if (engine && typeof engine.saveSettings === 'function') { engine.saveSettings(); return; }
  try { localStorage.setItem(STUDY_KEY, JSON.stringify(STUDY)); } catch (e) {}
}
function saveStudyCache() {
  const engine = studyEngine();
  if (engine && typeof engine.saveCache === 'function') { engine.saveCache(); return; }
  try {
    const keys = Object.keys(studyCache);
    if (keys.length > 300) keys.slice(0, keys.length - 300).forEach(k => delete studyCache[k]);
    localStorage.setItem(STUDY_CACHE_KEY, JSON.stringify(studyCache));
  } catch (e) {}
}
function saveStudyVocab() {
  const engine = studyEngine();
  if (engine && typeof engine.saveVocab === 'function') { engine.saveVocab(); return; }
  try { localStorage.setItem(STUDY_VOCAB_KEY, JSON.stringify(studyVocab)); } catch (e) {}
}
function saveStudyStatus() {
  const engine = studyEngine();
  if (engine && typeof engine.saveStatus === 'function') { engine.saveStatus(); return; }
  try { localStorage.setItem(STUDY_STATUS_KEY, JSON.stringify(studyStatus)); } catch (e) {}
}
function studyWordStatusOf(raw) {
  const engine = studyEngine();
  if (engine && typeof engine.wordStatusOf === 'function') return engine.wordStatusOf(raw);
  const k = host.ui.cleanWord(raw);
  return k ? (studyStatus[k] || '') : '';
}
function studyMarkWord(raw, status) {
  const engine = studyEngine();
  if (engine && typeof engine.markWord === 'function') engine.markWord(raw, status);
  else {
    const k = host.ui.cleanWord(raw);
    if (!k) return;
    if (status) studyStatus[k] = status; else delete studyStatus[k];
    saveStudyStatus();
    const item = studyVocab.find(v => host.ui.cleanWord(v.word) === k);
    if (item) {
      item.status = status || 'learning';
      saveStudyVocab();
    }
  }
  studyApplyWordMarks();
  studyUpdateDueBadge();
}
function wordStatusHTML(word) {
  const status = studyWordStatusOf(word);
  const inVocab = studyVocab.some(v => host.ui.cleanWord(v.word) === host.ui.cleanWord(word));
  return '<div class="word-status">' +
    [['learning', '学习中'], ['known', '已掌握'], ['ignored', '忽略']].map(([key, label]) =>
      '<button data-word-status="' + key + '" aria-pressed="' + String(status === key) + '">' + label + '</button>').join('') +
    (inVocab ? '<span class="study-badge">已在生词本</span>' :
      '<button data-word-add="1">＋ 生词本</button>') +
    '</div>';
}
function bindWordStatusButtons(word) {
  const row = document.querySelector('.word-status');
  if (!row) return;
  row.querySelectorAll('[data-word-status]').forEach(btn => {
    btn.onclick = () => {
      const status = btn.dataset.wordStatus;
      studyMarkWord(word, status);
      row.outerHTML = wordStatusHTML(word);
      bindWordStatusButtons(word);
    };
  });
  const add = row.querySelector('[data-word-add]');
  if (add) add.onclick = () => {
    studyAddVocab({ word, phonetic: $('wordPhon')?.textContent || '', meaning: host.support.wordCurrentMeaning() || '', example: '', exampleZh: '' }, studyCurrentCue()?.cue || null);
    row.outerHTML = wordStatusHTML(word);
    bindWordStatusButtons(word);
  };
}
function studyTranscriptMarkData() {
  const map = new Map();
  const add = item => {
    const key = host.ui.cleanWord(item?.word || '');
    if (key && !map.has(key)) map.set(key, item);
  };
  studyVocab.forEach(add);
  const cur = studyCurrentCue();
  if (cur) {
    const cached = studyCache[studyCurrentKey(cur)];
    if (cached && cached.data && Array.isArray(cached.data.vocabulary)) cached.data.vocabulary.forEach(add);
  }
  const epId = host.player.state.current?.id;
  if (epId) {
    const cached = studyCache['ep:' + epId];
    if (cached && cached.data && Array.isArray(cached.data.vocabulary)) cached.data.vocabulary.forEach(add);
    const partial = studyCache['ep:' + epId + ':partial'];
    if (partial && partial.data && Array.isArray(partial.data.vocabulary)) partial.data.vocabulary.forEach(add);
  }
  return map;
}
function studyApplyWordMarks() {
  if (!host.catalog.studyPluginOn()) return;
  if (!Array.isArray(host.player.state.nodes)) return;
  studyTranscriptTermData = studyTranscriptMarkData();
  const phraseItem = key => {
    const item = studyTranscriptTermData.get(key);
    return item && /\s/.test(String(item.word || '').trim()) ? item : null;
  };
  host.player.state.nodes.forEach(n => {
    if (!n || !n.words) return;
    n.words.forEach(w => {
      const key = host.ui.cleanWord(w.textContent || '');
      const st = studyWordStatusOf(w.textContent || '');
      w.classList.remove('study-learning', 'study-known', 'study-ignored', 'vocab-mark');
      delete w.dataset.term;
      if (st) w.classList.add('study-' + st);
      if (key && studyTranscriptTermData.has(key)) {
        w.classList.add('vocab-mark');
        w.dataset.term = key;
      }
    });
    const words = n.words;
    for (let i = 0; i < words.length; i++) {
      let joined = '';
      for (let len = 1; len <= 4 && i + len <= words.length; len++) {
        joined += (len > 1 ? ' ' : '') + (words[i + len - 1].textContent || '');
        const key = host.ui.cleanWord(joined);
        const item = phraseItem(key);
        if (!item) continue;
        for (let j = i; j < i + len; j++) {
          words[j].classList.add('vocab-mark');
          words[j].dataset.term = key;
        }
      }
    }
  });
}
function studyDueItems() {
  const engine = studyEngine();
  if (engine && typeof engine.dueItems === 'function') return engine.dueItems();
  const now = Date.now();
  return studyVocab
    .filter(v => v.status !== 'known' && v.status !== 'ignored' && Number(v.due || 0) <= now)
    .sort((a, b) => Number(a.due || 0) - Number(b.due || 0));
}
function studyUpdateDueBadge() {
  const el = $('studyDueCount');
  if (el) {
    const n = studyDueItems().length;
    el.textContent = String(n);
    el.style.display = n ? '' : 'none';
  }
}
function studyDueLabel(ms) {
  if (!Number.isFinite(Number(ms))) return '未排期';
  const diff = Number(ms) - Date.now();
  if (diff <= 0) return '现在';
  const mins = Math.round(diff / 60000);
  if (mins < 60) return mins + ' 分钟后';
  const hours = Math.round(mins / 60);
  if (hours < 36) return hours + ' 小时后';
  return Math.round(hours / 24) + ' 天后';
}
function studySrsGrade(item, grade) {
  const engine = studyEngine();
  if (engine && typeof engine.srsGrade === 'function') { engine.srsGrade(item, grade); return; }
  const ease = Math.max(1.3, Number(item.ease) || 2.5);
  let interval = Math.max(0, Number(item.interval) || 0);
  if (grade === 0) {
    interval = 0;
    item.ease = Math.max(1.3, ease - 0.2);
    item.lapses = (Number(item.lapses) || 0) + 1;
  } else if (grade === 1) {
    interval = interval ? Math.max(1, Math.round(interval * 1.2)) : 1;
    item.ease = Math.max(1.3, ease - 0.15);
  } else if (grade === 2) {
    interval = interval ? Math.round(interval * ease) : 1;
  } else {
    interval = interval ? Math.round(interval * ease * 1.3) : 2;
    item.ease = Math.min(4, ease + 0.15);
  }
  item.interval = interval;
  item.reps = (Number(item.reps) || 0) + 1;
  item.lastReview = Date.now();
  item.due = interval ? Date.now() + interval * 86400000 : Date.now() + 600000;
}
function studyStats() {
  const engine = studyEngine();
  if (engine && typeof engine.stats === 'function') return engine.stats();
  const total = studyVocab.length;
  const known = studyVocab.filter(v => v.status === 'known').length;
  const due = studyDueItems().length;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const reviewed = studyVocab.filter(v => Number(v.lastReview || 0) >= today.getTime()).length;
  return { total, known, due, reviewed };
}
function studyCoverage() {
  const seen = new Set(), known = new Set();
  (host.player.state.cues || []).forEach(cue => {
    (cue.words || []).forEach(w => {
      const k = host.ui.cleanWord(w.t);
      if (!k) return;
      seen.add(k);
      if (studyWordStatusOf(k) === 'known') known.add(k);
    });
  });
  return { total: seen.size, known: known.size, pct: seen.size ? Math.round(known.size / seen.size * 100) : 0 };
}
function studyCueContext(text, fallbackCue) {
  const t = String(text || '').trim().toLowerCase();
  const cues = host.player.state.cues || [];
  let cue = fallbackCue || null;
  if (!cue && t) {
    cue = cues.find(c => String(c.text || '').trim().toLowerCase() === t) ||
      cues.find(c => String(c.text || '').toLowerCase().includes(t.slice(0, 40))) || null;
  }
  if (!cue) return {};
  return {
    start: Number(cue.start),
    end: Number(cue.end),
    speechStart: Number(Number.isFinite(Number(cue.speechStart)) ? cue.speechStart : cue.start),
    speechEnd: Number(Number.isFinite(Number(cue.speechEnd)) ? cue.speechEnd : cue.end),
    episodeId: host.player.state.current ? host.player.state.current.id : '',
    showSlug: host.player.state.show ? host.player.state.show.slug : '',
    showName: host.player.state.show ? (host.player.state.show.name || '') : '',
    episodeTitle: host.player.state.current ? (host.player.state.current.title || '') : '',
  };
}
function studyCueBounds(cue) { const r = studyRuntime(); return r ? r.cueBounds(cue) : { start: Number(cue.start), end: Number(cue.end) }; }
function studyStopAudio() { const r = studyRuntime(); if (r) r.stopAudio(); }
function studyPlayRange(start, end, loops = 1) { const r = studyRuntime(); if (r) r.playRange(start, end, loops); }
function studyPlayCue(cue, loops = 1) { const r = studyRuntime(); if (r) r.playCue(cue, loops); }
function studyPlayItem(item) { const r = studyRuntime(); if (r) r.playItem(item); }
function studyAudioTick() { const r = studyRuntime(); if (r) r.audioTick(); }
function studyCsvCell(value) {
  const s = String(value == null ? '' : value);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function studyExportCsv() {
  if (!studyVocab.length) { host.ui.toast('生词本还是空的。', 2400); return; }
  const head = ['word', 'phonetic', 'meaning', 'example', 'exampleZh', 'source', 'status', 'due', 'interval', 'ease', 'reps', 'lapses', 'speechStart', 'speechEnd', 'episodeId', 'rootBreakdown', 'rootMeaning', 'sameRootWords', 'memoryHook'];
  const rows = studyVocab.map(v => [
    v.word, v.phonetic, v.meaning, v.example, v.exampleZh, v.source, v.status,
    v.due ? new Date(Number(v.due)).toISOString() : '', v.interval, v.ease, v.reps, v.lapses,
    v.speechStart, v.speechEnd, v.episodeId, v.rootBreakdown, v.rootMeaning, studySameRootText(v), v.memoryHook,
  ].map(studyCsvCell).join(','));
  const blob = new Blob(['\ufeff' + head.join(',') + '\n' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'myt-study-vocab-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  host.ui.toast('已导出生词本 CSV。', 2400);
}
/* 阶段三：AI 请求、provider 解析和播放循环都归插件 runtime.js；
   宿主只保留同签名包装，供渲染与桌面补丁调用。 */
function studyLangName() { const r = studyRuntime(); return r ? r.langName() : 'Simplified Chinese'; }
function studyHash(text) { const r = studyRuntime(); return r ? r.hash(text) : String(text || '').length.toString(36); }
function studyProviderMeta() {
  const r = studyRuntime();
  if (r) return r.providerMeta();
  const list = (studyEngine() && studyEngine().providers) || {};
  return list[STUDY.provider] || list.openai || {};
}
function studyConfig() { const r = studyRuntime(); return r ? r.config() : { engine: STUDY.provider || 'openai', endpoint: STUDY.endpoint, key: STUDY.key, model: STUDY.model, target: STUDY.target }; }
function studyNative() { const r = studyRuntime(); return r ? r.native() : !!(host.shell.tauriHost() && host.shell.tauriHost().core); }
function studyReady() { const r = studyRuntime(); return r ? r.ready() : false; }
async function studyChat(system, user) {
  const r = studyRuntime();
  if (!r) throw new Error('学英语插件未启用，AI 功能不可用。');
  return await r.chat(system, user);
}
function studyParseJson(text) { const r = studyRuntime(); return r ? r.parseJson(text) : { raw: String(text || '').trim() }; }
function studyCurrentCue() { const r = studyRuntime(); return r ? r.currentCue() : null; }
function studyWithCues(fn) { const r = studyRuntime(); if (r) r.withCues(fn); }
function studyCurrentKey(cur) { const r = studyRuntime(); return r ? r.currentKey(cur) : 'none'; }
function studySourceLabel() { const r = studyRuntime(); return r ? r.sourceLabel() : ''; }
function studyEmpty(text) { return '<div class="study-empty">' + host.ui.esc(text) + '</div>'; }
function studyLoading(text) {
  return '<div class="study-loading"><span class="loader"><span class="bars"><i></i><i></i><i></i></span></span><span>' + host.ui.esc(text) + '</span></div>';
}
function studyLines(value) {
  return String(value || '').split(/\n+/).filter(Boolean).map(line => '<p>' + host.ui.esc(line) + '</p>').join('');
}
function studySameRootList(item) {
  const arr = Array.isArray(item?.sameRootWords) ? item.sameRootWords : [];
  return arr.map(x => typeof x === 'string'
    ? { word: String(x || '').trim(), meaning: '' }
    : { word: String(x?.word || '').trim(), meaning: String(x?.meaning || '').trim() })
    .filter(x => x.word).slice(0, 4);
}
function studyRootHTML(item) {
  if (!item) return '';
  const breakdown = String(item.rootBreakdown || '').trim();
  const meaning = String(item.rootMeaning || '').trim();
  const roots = studySameRootList(item);
  const hook = String(item.memoryHook || '').trim();
  if (!breakdown && !meaning && !roots.length && !hook) return '';
  let html = '<div class="study-root">';
  if (breakdown) html += '<div class="study-root-line"><span class="study-root-tag">词根</span><b>' + host.ui.esc(breakdown) + '</b></div>';
  if (meaning) html += '<div class="study-root-line"><span class="study-root-tag">字面</span><span>' + host.ui.esc(meaning) + '</span></div>';
  if (roots.length) html += '<div class="study-root-line"><span class="study-root-tag">同根</span><span>' +
    roots.map(x => host.ui.esc(x.word) + (x.meaning ? '（' + host.ui.esc(x.meaning) + '）' : '')).join(' · ') + '</span></div>';
  if (hook) html += '<div class="study-root-line"><span class="study-root-tag">记忆</span><span>' + host.ui.esc(hook) + '</span></div>';
  return html + '</div>';
}
function studySameRootText(item) {
  return studySameRootList(item).map(x => x.word + (x.meaning ? '=' + x.meaning : '')).join(' | ');
}
function studySetVocabulary(vocab) {
  studyTermData = new Map();
  (Array.isArray(vocab) ? vocab : []).forEach(item => {
    const key = String(item?.word || '').trim().toLowerCase();
    if (key && !studyTermData.has(key)) studyTermData.set(key, item);
  });
  studyTermFocusKeys = new Set();
}
function studyTermChipHTML(word) {
  const raw = String(word || '').trim();
  const key = raw.toLowerCase();
  const item = studyTermData.get(key);
  if (!item) return host.ui.esc(raw);
  const label = raw + (item.meaning ? '：' + String(item.meaning) : '');
  return '<span class="study-term" data-term="' + host.ui.esc(key) + '" tabindex="0" aria-label="' + host.ui.esc(label) + '">' + host.ui.esc(raw) + '</span>';
}
function studyAnnotateText(value) {
  const raw = String(value == null ? '' : value);
  if (!raw) return '';
  if (!studyTermData.size) return host.ui.esc(raw);
  const terms = [...studyTermData.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!terms.length) return host.ui.esc(raw);
  let matcher;
  try {
    matcher = new RegExp('(?<![A-Za-z])(' + terms.map(studyRegexEscape).join('|') + ')(?![A-Za-z])', 'gi');
  } catch (e) {
    return host.ui.esc(raw);
  }
  let html = '', last = 0;
  raw.replace(matcher, (match, word, offset) => {
    const key = String(match).toLowerCase();
    const item = studyTermData.get(key);
    if (!item) return match;
    html += host.ui.esc(raw.slice(last, offset));
    const focus = !studyTermFocusKeys.has(key);
    if (focus) studyTermFocusKeys.add(key);
    const label = String(item.word || match) + (item.meaning ? '：' + String(item.meaning) : '');
    html += '<span class="study-term" data-term="' + host.ui.esc(key) + '"' +
      (focus ? ' tabindex="0"' : '') + ' aria-label="' + host.ui.esc(label) + '">' + host.ui.esc(match) + '</span>';
    last = offset + String(match).length;
    return match;
  });
  return html + host.ui.esc(raw.slice(last));
}
function studyAnnotatedLines(value) {
  return String(value || '').split(/\n+/).filter(Boolean).map(line => '<p>' + studyAnnotateText(line) + '</p>').join('');
}
function studyTermTipElement() {
  let tip = $('studyTermTip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'studyTermTip';
    tip.className = 'study-term-tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.appendChild(tip);
  }
  return tip;
}
function studyTermTipHTML(item) {
  if (!item) return '';
  const word = String(item.word || '').trim();
  return '<div class="tt-head"><b>' + host.ui.esc(word) + '</b>' +
    (item.phonetic ? '<em>' + host.ui.esc(item.phonetic) + '</em>' : '') + '</div>' +
    '<div class="tt-meaning">' + host.ui.esc(item.meaning || '暂无释义') + '</div>' +
    (item.example ? '<div class="tt-example"><b>例</b> ' + host.ui.esc(item.example) +
      (item.exampleZh ? '<br>' + host.ui.esc(item.exampleZh) : '') + '</div>' : '') +
    studyRootHTML(item);
}
function studyShowTermTip(term, itemOverride) {
  if (!term) return;
  const key = term.dataset.term || host.ui.cleanWord(term.textContent || '');
  const item = itemOverride || studyTermData.get(key) || studyTranscriptTermData.get(key);
  if (!item) return;
  const tip = studyTermTipElement();
  tip.innerHTML = studyTermTipHTML(item);
  tip.hidden = false;
  tip.classList.add('on');
  tip.dataset.term = key;
  tip.style.left = '0px';
  tip.style.top = '0px';
  const rect = term.getBoundingClientRect();
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  let left = rect.left + rect.width / 2 - width / 2;
  left = Math.max(10, Math.min(left, window.innerWidth - width - 10));
  let top = rect.top - height - 9;
  if (top < 10) top = rect.bottom + 9;
  top = Math.max(10, Math.min(top, window.innerHeight - height - 10));
  tip.style.left = Math.round(left) + 'px';
  tip.style.top = Math.round(top) + 'px';
}
function studyHideTermTip() {
  const tip = $('studyTermTip');
  if (tip) {
    tip.classList.remove('on');
    tip.hidden = true;
  }
  document.querySelectorAll('.study-term.on,.word.vocab-mark.on').forEach(el => el.classList.remove('on'));
}
function studyHoverTerm(target) {
  if (!target || !target.closest) return null;
  return target.closest('.study-term, .word.vocab-mark');
}
function studyTermItemOf(term) {
  if (!term) return null;
  const key = term.dataset.term || host.ui.cleanWord(term.textContent || '');
  return studyTermData.get(key) || studyTranscriptTermData.get(key);
}
function bindStudyTermTips() {
  if (studyTermTipsBound) return;
  studyTermTipsBound = true;
  uiListen(document, 'mouseover', event => {
    const term = studyHoverTerm(event.target);
    const item = studyTermItemOf(term);
    if (!term || !item || term.contains(event.relatedTarget)) return;
    term.classList.add('on');
    studyShowTermTip(term, item);
  });
  uiListen(document, 'mouseout', event => {
    const term = studyHoverTerm(event.target);
    if (!term || term.contains(event.relatedTarget) || studyTermPinned) return;
    term.classList.remove('on');
    studyHideTermTip();
  });
  uiListen(document, 'focusin', event => {
    const term = studyHoverTerm(event.target);
    const item = studyTermItemOf(term);
    if (term && item) { term.classList.add('on'); studyShowTermTip(term, item); }
  });
  uiListen(document, 'focusout', event => {
    if (studyTermPinned) return;
    if (studyHoverTerm(event.target)) studyHideTermTip();
  });
  uiListen(document, 'click', event => {
    const term = event.target.closest && event.target.closest('.study-term');
    if (term) {
      event.preventDefault();
      const item = studyTermItemOf(term);
      const tip = $('studyTermTip');
      const same = studyTermPinned && tip && tip.dataset.term === (term.dataset.term || '');
      studyTermPinned = !same;
      document.querySelectorAll('.study-term.on,.word.vocab-mark.on').forEach(el => el.classList.remove('on'));
      if (studyTermPinned && item) { term.classList.add('on'); studyShowTermTip(term, item); }
      else studyHideTermTip();
      return;
    }
    if (!event.target.closest || !event.target.closest('#studyTermTip')) {
      studyTermPinned = false;
      studyHideTermTip();
    }
  }, { capture: true });
  uiListen(document, 'scroll', () => {
    studyTermPinned = false;
    studyHideTermTip();
  }, { capture: true });
}
function studyVocabCards(items, addable) {
  studyRenderedVocab = addable ? (items || []) : [];
  return (items || []).map((v, i) => {
    const word = String(v.word || '').trim();
    if (!word) return '';
    const inVocab = studyVocab.some(x => host.ui.cleanWord(x.word) === host.ui.cleanWord(word));
    return '<div class="study-vocab"><strong>' + studyTermChipHTML(word) + '</strong>' +
      (v.phonetic ? '<em>' + host.ui.esc(v.phonetic) + '</em>' : '') +
      '<small>' + host.ui.esc(v.meaning || '') + '</small>' +
      (v.example ? '<small><b>例：</b>' + host.ui.esc(v.example) + (v.exampleZh ? '<br>' + host.ui.esc(v.exampleZh) : '') + '</small>' : '') +
      studyRootHTML(v) +
      (addable ? (inVocab ? '<span class="study-badge">已在生词本</span>' :
        '<button class="btn ghost small vocab-add" data-study-add="' + i + '">＋ 生词本（含原句音频）</button>') : '') +
      '</div>';
  }).join('');
}
function studyCardHTML(data) {
  if (!data) return '';
  studySetVocabulary(data.vocabulary);
  if (data.raw) return '<div class="study-section"><h4>模型原文</h4><p>' + host.ui.esc(data.raw).replace(/\n/g, '<br>') + '</p></div>';
  let html = '';
  if (data.translation) html += '<div class="study-section"><h4>参考译文</h4>' + studyAnnotatedLines(data.translation) + '</div>';
  if (data.literal && data.literal !== data.translation) html += '<div class="study-section"><h4>直译</h4>' + studyAnnotatedLines(data.literal) + '</div>';
  if (data.explanation) html += '<div class="study-section"><h4>这句话在说什么</h4>' + studyAnnotatedLines(data.explanation) + '</div>';
  if (data.paraphrase) html += '<div class="study-section"><h4>换一种说法</h4>' + studyAnnotatedLines(data.paraphrase) + '</div>';
  if (Array.isArray(data.grammar) && data.grammar.length) {
    html += '<div class="study-section"><h4>语法点</h4>' + data.grammar.map(g =>
      '<p><b>' + host.ui.esc(g.point || '') + '</b>　' + studyAnnotateText(g.detail || '') + '</p>').join('') + '</div>';
  }
  if (Array.isArray(data.vocabulary) && data.vocabulary.length) {
    html += '<div class="study-section"><h4>词汇与表达</h4>' + studyVocabCards(data.vocabulary, true) + '</div>';
  }
  return html;
}
function studyClockSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  const s = String(value || '').trim().replace(/[\[\]]/g, '');
  if (!s) return NaN;
  const parts = s.split(':').map(part => Number(part));
  if (parts.some(part => !Number.isFinite(part))) return NaN;
  if (parts.length === 1) return Math.max(0, parts[0]);
  if (parts.length === 2) return Math.max(0, parts[0] * 60 + parts[1]);
  if (parts.length === 3) return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
  return NaN;
}
function studyTopicHTML(data) {
  const topics = Array.isArray(data?.topics) ? data.topics : [];
  if (!topics.length) return '';
  return '<div class="study-section"><h4>主题时间戳</h4>' + topics.map(topic => {
    if (!topic || typeof topic !== 'object') return '';
    const title = String(topic.title || topic.topic || '').trim();
    const start = studyClockSeconds(topic.start ?? topic.time ?? topic.timestamp);
    if (!title && !Number.isFinite(start)) return '';
    const when = Number.isFinite(start) ? host.ui.fmt(start) : '';
    return '<div class="study-topic">' +
      (when ? '<button class="btn ghost small" data-study-act="topic" data-study-t="' + Math.round(start) + '">▶ ' + host.ui.esc(when) + '</button>' : '') +
      '<div><strong>' + studyAnnotateText(title || '未命名主题') + '</strong>' +
      (topic.summary ? '<p>' + studyAnnotateText(topic.summary) + '</p>' : '') + '</div></div>';
  }).join('') + '</div>';
}
function studyAdHTML(data) {
  const ads = host.support.adRangesFromData(data);
  if (!ads.length) return '';
  return '<div class="study-section"><h4>广告点</h4>' + ads.map(ad => {
    return '<div class="study-topic study-ad">' +
      '<button class="btn ghost small" data-study-act="ad" data-study-t="' + Math.round(ad.end) + '">跳过</button>' +
      '<div><strong>' + host.ui.esc(ad.label || '广告') + '</strong><p>' + host.ui.esc(host.ui.fmt(ad.start)) + ' – ' + host.ui.esc(host.ui.fmt(ad.end)) + '</p></div></div>';
  }).join('') + '</div>';
}
function studyEpisodeHTML(data) {
  if (!data) return '';
  studySetVocabulary(data.vocabulary);
  let html = '<div class="study-section"><h4>内容摘要</h4>' + studyAnnotatedLines(data.summary || '') + '</div>';
  html += studyAdHTML(data);
  html += studyTopicHTML(data);
  if (Array.isArray(data.keyPoints) && data.keyPoints.length) {
    html += '<div class="study-section"><h4>重点</h4>' + data.keyPoints.map(x => '<p>· ' + studyAnnotateText(x) + '</p>').join('') + '</div>';
  }
  if (Array.isArray(data.hardSentences) && data.hardSentences.length) {
    html += '<div class="study-section"><h4>难句</h4>' + data.hardSentences.map(x =>
      '<div class="study-vocab"><strong>' + studyAnnotateText(x.en || '') + '</strong><small>' + host.ui.esc(x.zh || '') +
      (x.why ? '<br><b>难点：</b>' + studyAnnotateText(x.why) : '') + '</small></div>').join('') + '</div>';
  }
  if (Array.isArray(data.questions) && data.questions.length) {
    html += '<div class="study-section"><h4>可以想一下</h4>' + data.questions.map(x => '<p>· ' + studyAnnotateText(x) + '</p>').join('') + '</div>';
  }
  if (Array.isArray(data.vocabulary) && data.vocabulary.length) {
    html += '<div class="study-section"><h4>词汇与表达</h4>' + studyVocabCards(data.vocabulary, true) + '</div>';
  }
  return api.study.runHook('episodeHtml', html, data);
}
function applyStudyProvider(id, fillDefaults) {
  const list = (studyEngine() && studyEngine().providers) || {};
  const meta = list[id];
  if (!meta) return;
  STUDY.provider = id;
  if (fillDefaults) {
    STUDY.endpoint = meta.endpoint;
    STUDY.model = meta.model;
  }
  studyClearModels();
  const modelStatus = $('studyModelStatus'); if (modelStatus) { modelStatus.textContent = ''; modelStatus.style.color = ''; }
  saveStudy();
  syncStudySettings();
}
function syncStudySettings() {
  const provider = $('studyProvider'); if (provider) provider.value = STUDY.provider || 'openai';
  const meta = studyProviderMeta();
  const hint = $('studyProviderHint'); if (hint) hint.textContent = meta.hint;
  const modelHint = $('studyModelHint'); if (modelHint) modelHint.textContent = meta.modelHint;
  const endpoint = $('studyEndpoint');
  if (endpoint) {
    endpoint.value = STUDY.endpoint || '';
    endpoint.placeholder = meta.endpoint || 'https://example.com/v1';
  }
  const key = $('studyKey');
  if (key) {
    key.value = STUDY.key || '';
    key.placeholder = meta.keyHint;
  }
  const model = $('studyModel');
  if (model) {
    model.value = STUDY.model || '';
    model.placeholder = meta.model || 'model-name';
  }
  const target = $('studyTarget'); if (target) target.value = STUDY.target || 'zh-CN';
  const status = $('studyStatus');
  if (status) {
    const hasKey = !!String(STUDY.key || '').trim();
    const hasModel = !!String(STUDY.model || '').trim();
    status.textContent = !studyNative() ? '桌面版才能用'
      : !String(STUDY.endpoint || '').trim() && STUDY.provider === 'custom' ? '还缺接口地址'
      : !hasKey ? '还缺 API Key'
      : !hasModel ? '还缺模型'
      : '已配置 · ' + meta.name;
    status.style.color = '';
  }
}
function setStudyView(view) {
  studyView = view;
  host.player.setView(view);
  studyTermPinned = false;
  studyHideTermTip();
  if (view === 'review') studyReviewRevealed = false;
  if (view === 'practice') studyExercise = null;
  document.querySelectorAll('[data-study-view]').forEach(btn => btn.setAttribute('aria-checked', String(btn.dataset.studyView === view)));
  if (view === 'card') studyRenderCurrent();
  else if (view === 'episode') studyRenderEpisode();
  else if (view === 'ask') studyRenderAsk();
  else if (view === 'review') studyRenderReview();
  else if (view === 'practice') studyRenderPractice();
  else studyRenderVocab();
}
function openStudySheet(view) {
  if (!host.catalog.subtitlePluginOn()) { host.ui.toast('字幕插件未启用，AI 学英语不可用。', 'warn'); return; }
  if (!host.catalog.studyPluginOn()) { host.ui.toast('学英语插件未启用。', 'warn'); return; }
  if (!host.catalog.moduleOn('study')) return;
  const sheet = $('studySheet');
  if (!sheet) return;
  host.ui.closeDockSheet(false);
  sheet.hidden = false;
  sheet.classList.add('on');
  $('studyBtn')?.classList.add('on');
  setStudyView(view || studyView || 'card');
  // 打开后把焦点放进当前页签，键盘用户（含 S 快捷键）可以直接用 → 切页签。
  const onTab = sheet.querySelector('[data-study-view][aria-checked="true"]');
  if (onTab && typeof onTab.focus === 'function') onTab.focus({ preventScroll: true });
}
function closeStudySheet() {
  studyTermPinned = false;
  studyHideTermTip();
  studyCloseQuoteCard();
  const sheet = $('studySheet');
  if (!sheet) return;
  sheet.classList.remove('on');
  sheet.hidden = true;
  $('studyBtn')?.classList.remove('on');
}
function studyRenderNow() {
  const cur = studyCurrentCue();
  const now = $('studyNow');
  if (now) now.textContent = cur ? host.ui.fmt(cur.cue.start + host.player.state.offset) + ' · ' + String(cur.cue.text || '').slice(0, 34) : '—';
  studyUpdateDueBadge();
}
function studyRenderCurrent() {
  const body = $('studyBody');
  if (!body) return;
  const cur = studyCurrentCue();
  studyRenderNow();
  if (!cur) {
    body.innerHTML = studyEmpty(host.player.state.current ? '字幕加载中…' : '这一集没有可用的文字稿。');
    if (host.player.state.current) studyWithCues(() => { if (studyView === 'card') studyRenderCurrent(); });
    return;
  }
  const key = studyCurrentKey(cur);
  const cached = studyCache[key];
  studyVocabContext = cur.cue; studyVocabContextMode = 'card';
  let html = '<p class="study-cue">' + host.ui.esc(cur.cue.text || '') + '</p>';
  if (cur.cue.zh && !studyHideZh) html += '<p class="study-empty">' + host.ui.esc(cur.cue.zh) + '</p>';
  html += '<div class="study-actions">' +
    '<button class="btn ghost small" data-study-act="playCue">▶ 听本句</button>' +
    '<button class="btn ghost small" data-study-act="loopCue">循环 3 次</button>' +
    '<button class="study-toggle" data-study-act="autoPause" aria-pressed="' + String(host.player.getAutoPause()) + '">自动暂停</button>' +
    '<button class="study-toggle" data-study-act="hideZh" aria-pressed="' + String(studyHideZh) + '">隐藏译文</button>' +
    '</div>';
  html += '<div class="study-actions"><button class="btn primary small" data-study-act="current">' +
    (cached ? '重新分析当前句' : '分析当前句') + '</button>' +
    '<span class="study-badge">' + (cached ? '已缓存' : '按需调用') + '</span></div>';
  if (cached && cached.data) html += studyCardHTML(cached.data);
  body.innerHTML = html;
  bindStudyActButtons();
  studyApplyWordMarks();
}
function studyRenderEpisode() {
  const body = $('studyBody');
  if (!body) return;
  api.study.runHook('beforeEpisode');
  if (!host.player.state.current) { body.innerHTML = studyEmpty('先选择一集。'); return; }
  studyVocabContext = null; studyVocabContextMode = 'episode';
  const key = 'ep:' + host.player.state.current.id;
  const cached = studyCache[key];
  const chapters = studyChapterEntry();
  const quotes = studyQuoteEntry();
  let html = '<p class="study-empty">' + host.ui.esc(host.player.state.current.title || '当前单集') + '</p>';
  html += '<div class="study-actions"><button class="btn primary small" data-study-act="episode">' +
    (cached ? '重新总结整集' : '总结整集') + '</button>' +
    '<button class="btn ghost small" data-study-act="chapters">' + (chapters ? '重新生成章节' : '生成章节') + '</button>' +
    '<button class="btn ghost small" data-study-act="quotes">' + (quotes ? '重新挑金句' : '挑金句') + '</button>' +
    (cached && cached.data ? '<button class="btn ghost small" data-study-act="copyEpisode">复制总结</button>' : '') +
    '<span class="study-badge">' + (cached ? '已缓存' : '按段分块请求') + '</span></div>';
  html += studyChaptersHTML(chapters && chapters.data);
  if (cached && cached.data) {
    host.support.applyAiAdRanges(cached.data, host.player.state.current.id);
    html += studyEpisodeHTML(cached.data);
    if (cached.data.version !== 3) html += '<p class="study-empty">旧版缓存没有广告点，点「重新总结整集」生成。</p>';
  } else {
    html += '<p class="study-empty">整集会按文字稿分成 3 块分析；每块单独请求，并生成主题时间戳。中途失败只重试失败的块。章节和金句都按文字稿行号映射时间，不会让模型自己编时间戳。</p>';
  }
  html += studyQuotesHTML(quotes && quotes.data);
  body.innerHTML = html;
  bindStudyActButtons();
  studyApplyWordMarks();
  api.study.runHook('episode', body);
}
function studyRenderVocab() {
  const body = $('studyBody');
  if (!body) return;
  studyVocabContext = null; studyVocabContextMode = null;
  studyRenderNow();
  if (!studyVocab.length) {
    body.innerHTML = studyEmpty('生词本还是空的。在句子卡片里点「＋ 生词本」就会收进来。');
    api.study.runHook('vocab', body);
    return;
  }
  studySetVocabulary(studyVocab);
  const st = studyStats(), cov = studyCoverage();
  body.innerHTML = '<div class="study-actions"><span class="study-badge">' + st.total + ' 个词条</span>' +
    '<span class="study-badge">待复习 ' + st.due + '</span>' +
    '<span class="study-badge">已掌握 ' + st.known + '</span>' +
    '<span class="study-badge">本集覆盖 ' + cov.pct + '%</span>' +
    '<button class="btn ghost small" data-study-export="1">导出 CSV</button></div>' +
    studyVocab.map((v, i) => {
      const status = v.status === 'known' ? '已掌握' : v.status === 'ignored' ? '已忽略' : '学习中';
      return '<div class="study-vocab"><strong>' + studyTermChipHTML(v.word) + '</strong>' +
        (v.phonetic ? '<em>' + host.ui.esc(v.phonetic) + '</em>' : '') +
        '<span class="study-badge">' + status + '</span>' +
        '<small>' + host.ui.esc(v.meaning || '') + '</small>' +
        (v.example ? '<small><b>例：</b>' + host.ui.esc(v.example) + (v.exampleZh ? '<br>' + host.ui.esc(v.exampleZh) : '') + '</small>' : '') +
        studyRootHTML(v) +
        (v.source ? '<small>' + host.ui.esc(v.source) + '</small>' : '') +
        '<small>' + (v.due ? '下次复习：' + studyDueLabel(v.due) : '未排期') + ' · 复习 ' + (v.reps || 0) + ' 次</small>' +
        '<div class="study-actions">' +
        (Number.isFinite(Number(v.start)) ? '<button class="btn ghost small" data-study-play-vocab="' + i + '">▶ 原句</button>' : '') +
        '<button class="btn ghost small" data-study-status-vocab="' + i + '">' + (v.status === 'known' ? '恢复学习' : '标记已掌握') + '</button>' +
        '<button class="btn ghost small vocab-add" data-study-del-vocab="' + i + '">移出生词本</button></div></div>';
    }).join('');
  body.querySelectorAll('[data-study-del-vocab]').forEach(btn => {
    btn.onclick = () => {
      const i = Number(btn.dataset.studyDelVocab);
      if (!Number.isFinite(i)) return;
      const word = studyVocab[i]?.word;
      if (word) studyMarkWord(word, '');
      studyVocab.splice(i, 1);
      saveStudyVocab();
      studyApplyWordMarks();
      studyRenderVocab();
    };
  });
  body.querySelectorAll('[data-study-play-vocab]').forEach(btn => {
    btn.onclick = () => studyPlayItem(studyVocab[Number(btn.dataset.studyPlayVocab)]);
  });
  body.querySelectorAll('[data-study-status-vocab]').forEach(btn => {
    btn.onclick = () => {
      const i = Number(btn.dataset.studyStatusVocab);
      const item = studyVocab[i];
      if (!item) return;
      studyMarkWord(item.word, item.status === 'known' ? 'learning' : 'known');
      studyRenderVocab();
    };
  });
  const exportBtn = body.querySelector('[data-study-export]');
  if (exportBtn) exportBtn.onclick = studyExportCsv;
  api.study.runHook('vocab', body);
}
function studyRenderReview() {
  const body = $('studyBody');
  if (!body) return;
  studyVocabContext = null; studyVocabContextMode = null;
  studyRenderNow();
  const st = studyStats();
  if (!studyVocab.length) { body.innerHTML = studyEmpty('生词本还是空的。先在句子卡片里收几个词，再回来复习。'); return; }
  const due = studyDueItems();
  const head = '<div class="study-actions"><span class="study-badge">待复习 ' + due.length + '</span>' +
    '<span class="study-badge">已掌握 ' + st.known + '</span>' +
    '<span class="study-badge">今日已复习 ' + st.reviewed + '</span></div>';
  if (!due.length) {
    const next = studyVocab.filter(v => v.status !== 'known' && v.status !== 'ignored' && v.due)
      .sort((a, b) => Number(a.due) - Number(b.due))[0];
    body.innerHTML = head + '<div class="study-section"><h4>今天清空了</h4><p>' +
      (next ? '下一次复习：' + studyDueLabel(next.due) + '（' + host.ui.esc(next.word) + '）' : '还没有排期的词条。') +
      '</p></div>';
    return;
  }
  const v = due[0];
  const source = [v.source, v.example ? '原句：' + v.example : ''].filter(Boolean).join('\n');
  let html = head + '<div class="study-review-word">' + host.ui.esc(v.word) + '</div>' +
    (v.phonetic ? '<div class="study-review-meta">' + host.ui.esc(v.phonetic) + '</div>' : '') +
    '<div class="study-actions">' +
    (Number.isFinite(Number(v.start)) ? '<button class="btn ghost small" data-study-act="playReview">▶ 听原句</button>' : '') +
    '<button class="btn primary small" data-study-act="reveal">显示答案</button></div>';
  if (studyReviewRevealed) {
    html += '<div class="study-answer"><strong>' + host.ui.esc(v.meaning || '（没有释义）') + '</strong>' +
      (v.example ? '<div style="margin-top:6px">' + host.ui.esc(v.example) + '</div>' : '') +
      (v.exampleZh ? '<div class="study-empty">' + host.ui.esc(v.exampleZh) + '</div>' : '') +
      studyRootHTML(v) +
      (v.source ? '<div class="study-review-meta" style="margin-top:6px">' + host.ui.esc(v.source) + '</div>' : '') + '</div>' +
      '<div class="study-grade">' +
      '<button data-study-grade="0">忘记</button><button data-study-grade="1">模糊</button>' +
      '<button data-study-grade="2">记得</button><button data-study-grade="3">很简单</button></div>' +
      '<p class="study-empty">忘记：10 分钟后；模糊/记得/很简单：按记忆曲线往后排。</p>';
  } else {
    html += '<p class="study-empty">先在心里回想，再显示答案。' + (source ? '上下文已保存。' : '') + '</p>';
  }
  body.innerHTML = html;
  bindStudyActButtons();
}
function studyExerciseTarget(cue) {
  const words = (cue.words || []).map(w => String(w.t || '').trim()).filter(w => /^[A-Za-z][A-Za-z'’-]*$/.test(w));
  return words.sort((a, b) => b.length - a.length)[0] || String(cue.text || '').split(/\s+/).find(w => w.length > 4) || 'word';
}
function studyStartExercise(type) {
  const cur = studyCurrentCue();
  if (!cur) return;
  const cue = cur.cue;
  const target = studyExerciseTarget(cue);
  const key = studyCurrentKey(cur);
  let sentence = String(cue.text || '');
  if (type === 'cloze' && target) {
    const idx = sentence.toLowerCase().indexOf(target.toLowerCase());
    if (idx >= 0) sentence = sentence.slice(0, idx) + '____' + sentence.slice(idx + target.length);
  }
  studyExercise = { type, key, cue, target, sentence, answer: type === 'cloze' ? target : String(cue.text || ''), checked: false, correct: false, pct: 0 };
}
function studyRenderPractice() {
  const body = $('studyBody');
  if (!body) return;
  const cur = studyCurrentCue();
  studyRenderNow();
  if (!cur) {
    body.innerHTML = studyEmpty(host.player.state.current ? '字幕加载中…' : '这一集没有可用的文字稿。');
    api.study.runHook('practice', body);
    if (host.player.state.current) studyWithCues(() => { if (studyView === 'practice') studyRenderPractice(); });
    return;
  }
  if (!studyExercise || studyExercise.key !== studyCurrentKey(cur)) {
    body.innerHTML = '<div class="study-actions"><button class="btn primary small" data-study-ex="cloze">填空练习</button>' +
      '<button class="btn ghost small" data-study-ex="dictation">听写练习</button></div>' +
      '<p class="study-empty">填空：挖掉原句里最有信息量的词。听写：先听原句，再写下你听到的内容。两者都不调用 LLM。</p>';
    bindStudyActButtons();
    api.study.runHook('practice', body);
    return;
  }
  const ex = studyExercise;
  let html = '<div class="study-actions"><button class="study-toggle" data-study-ex="cloze" aria-pressed="' + String(ex.type === 'cloze') + '">填空</button>' +
    '<button class="study-toggle" data-study-ex="dictation" aria-pressed="' + String(ex.type === 'dictation') + '">听写</button>' +
    '<button class="btn ghost small" data-study-act="playEx">▶ 听本句</button>' +
    '<button class="btn ghost small" data-study-act="nextEx">换一句</button></div>';
  if (ex.type === 'cloze') {
    html += '<p class="study-cue">' + host.ui.esc(ex.sentence) + '</p>';
  } else {
    html += '<p class="study-empty">听原句，然后写下你听到的完整句子。可以重复听。</p>';
  }
  html += '<input class="study-input" id="studyPracticeInput" autocomplete="off" spellcheck="false" placeholder="' +
    (ex.type === 'cloze' ? '填入被挖掉的词' : '写下你听到的句子') + '" value="' + host.ui.esc(ex.input || '') + '">';
  html += '<div class="study-actions"><button class="btn primary small" data-study-act="checkEx">检查答案</button>' +
    '<button class="btn ghost small" data-study-act="showEx">显示答案</button></div>';
  if (ex.checked) {
    html += '<div class="study-answer"><div class="' + (ex.correct ? 'study-ok' : 'study-bad') + '">' +
      (ex.correct ? '✓ 正确' : (ex.type === 'dictation' ? '正确率约 ' + ex.pct + '%' : '再试一次')) + '</div>' +
      '<div style="margin-top:6px">答案：' + host.ui.esc(ex.answer) + '</div></div>';
  }
  body.innerHTML = html;
  const input = $('studyPracticeInput');
  if (input) {
    input.oninput = () => { if (studyExercise) studyExercise.input = input.value; };
    input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); studyCheckExercise(); } };
    input.focus();
  }
  bindStudyActButtons();
  api.study.runHook('practice', body);
}
function studyCheckExercise(showOnly) {
  const ex = studyExercise;
  if (!ex) return;
  const input = $('studyPracticeInput');
  if (input) ex.input = input.value;
  if (showOnly) {
    ex.checked = false;
    if (ex.type === 'cloze') ex.answer = ex.target;
    studyExercise = ex;
    const body = $('studyBody');
    if (body) body.innerHTML = '<div class="study-section"><h4>答案</h4><p>' + host.ui.esc(ex.answer) + '</p>' +
      '<button class="btn ghost small" data-study-act="backEx">继续练习</button></div>';
    bindStudyActButtons();
    return;
  }
  if (ex.type === 'cloze') {
    ex.correct = host.support.normText(ex.input).replace(/\s+/g, '') === host.support.normText(ex.target).replace(/\s+/g, '');
    ex.pct = ex.correct ? 100 : 0;
    if (!ex.correct) studyMarkWord(ex.target, 'learning');
  } else {
    const a = host.support.normText(ex.input).split(' ').filter(Boolean);
    const b = host.support.normText(ex.answer).split(' ').filter(Boolean);
    const hit = a.filter((w, i) => w === b[i]).length;
    ex.pct = b.length ? Math.round(hit / b.length * 100) : 0;
    ex.correct = ex.pct >= 90;
  }
  ex.checked = true;
  studyRenderPractice();
}
function bindStudyVocabButtons() {
  document.querySelectorAll('[data-study-add]').forEach(btn => {
    btn.onclick = () => {
      const i = Number(btn.dataset.studyAdd);
      const item = studyRenderedVocab[i];
      if (!item) return;
      const cue = studyVocabContextMode === 'card' ? (studyCurrentCue()?.cue || null) : null;
      studyAddVocab(item, cue);
      btn.textContent = '✓ 已在生词本';
      btn.disabled = true;
    };
  });
}
function studyAddVocab(item, cueOverride) {
  const word = String(item.word || '').trim();
  if (!word) return;
  if (studyVocab.some(v => String(v.word || '').toLowerCase() === word.toLowerCase())) {
    host.ui.toast('生词本里已经有「' + word + '」了。', 2500);
    return;
  }
  const fallback = cueOverride || (studyVocabContextMode === 'card' ? studyVocabContext : null);
  const ctx = studyCueContext(item.example || '', fallback);
  studyVocab.unshift({
    word, phonetic: item.phonetic || '', meaning: item.meaning || '',
    example: item.example || '', exampleZh: item.exampleZh || '',
    rootBreakdown: item.rootBreakdown || '', rootMeaning: item.rootMeaning || '',
    sameRootWords: studySameRootList(item), memoryHook: item.memoryHook || '',
    source: studySourceLabel(), at: Date.now(),
    status: 'learning', due: Date.now(), interval: 0, ease: 2.5, reps: 0, lapses: 0,
    start: ctx.start, end: ctx.end, speechStart: ctx.speechStart, speechEnd: ctx.speechEnd,
    episodeId: ctx.episodeId || '', showSlug: ctx.showSlug || '', episodeTitle: ctx.episodeTitle || '',
  });
  studyMarkWord(word, 'learning');
  saveStudyVocab();
  studyUpdateDueBadge();
  host.ui.toast('已加入生词本：' + word + '（已排入复习）', 3000);
}
async function studyAnalyzeCurrent() {
  const cur = studyCurrentCue();
  if (!cur) return;
  const body = $('studyBody');
  const key = studyCurrentKey(cur);
  if (!studyReady()) { body.innerHTML = studyEmpty('请先在「设置 → AI 学英语」填写 API Key 和模型。'); return; }
  body.innerHTML = studyLoading('正在分析当前句…');
  const prev = host.player.state.cues[cur.ci - 1]?.text || '';
  const next = host.player.state.cues[cur.ci + 1]?.text || '';
  const system = 'You are an English-learning coach for Chinese learners. Explain the target sentence accurately and ' +
    'concisely in ' + studyLangName() + '. Return ONLY a JSON object, no markdown fences, with keys: ' +
    'translation (string), literal (string, word-for-word if useful), explanation (string), ' +
    'grammar (array of {point, detail}), vocabulary (array of {word, phonetic, meaning, example, exampleZh, rootBreakdown, rootMeaning, sameRootWords, memoryHook}), ' +
    'paraphrase (string). For vocabulary, add root analysis only when the word is morphologically transparent: ' +
    'rootBreakdown = prefix + root + suffix with hyphens and Chinese gloss; rootMeaning = literal meaning; ' +
    'sameRootWords = array of up to 2 real English words {word, meaning} sharing the same root; memoryHook = one short Chinese memory sentence. ' +
    'Never invent roots or etymology; leave these fields empty when unsure. Keep vocabulary to at most 6 useful items. ' +
    'Do not invent facts about the episode.';
  const user = JSON.stringify({ target: cur.cue.text, previous: prev, next, show: host.player.state.show?.name || '', episode: host.player.state.current?.title || '' });
  try {
    const out = await studyChat(system, user);
    const data = studyParseJson(out);
    studyCache[key] = { at: Date.now(), data };
    saveStudyCache();
    studyRenderCurrent();
  } catch (err) {
    body.innerHTML = '<div class="study-section"><h4>分析失败</h4><p>' + host.ui.esc(err.message || err) + '</p>' +
      '<button class="btn ghost small" data-study-act="current">重试</button></div>';
    bindStudyActButtons();
  }
}
async function studyAnalyzeEpisode() {
  const body = $('studyBody');
  if (!host.player.state.current) return;
  if (!studyReady()) { body.innerHTML = studyEmpty('请先在「设置 → AI 学英语」填写 API Key 和模型。'); return; }
  const cues = host.player.state.cues || [];
  if (!cues.length) { body.innerHTML = studyEmpty('这一集没有文字稿，无法分析整集。'); return; }
  const lines = cues.map(cue => '[' + host.ui.fmt(cue.start + host.player.state.offset) + '] ' + (cue.text || ''));
  if (!lines.length) { body.innerHTML = studyEmpty('没有可分析的文字稿。'); return; }
  const partCount = Math.min(STUDY_SUMMARY_CHUNKS, lines.length);
  const perPart = Math.ceil(lines.length / partCount);
  const chunks = [];
  for (let i = 0; i < partCount; i++) {
    const part = lines.slice(i * perPart, (i + 1) * perPart);
    if (part.length) chunks.push(part.join('\n'));
  }
  const totalChunks = chunks.length;
  if (!totalChunks) { body.innerHTML = studyEmpty('没有可分析的文字稿。'); return; }
  const system = 'You are a podcast editor summarizing a transcript chunk for a Chinese-speaking listener. ' +
    'Return ONLY a JSON object, no markdown fences, with keys: summary (string in ' + studyLangName() + '), ' +
    'topics (array of {title, start, end, summary}), ads (array of {start, end, label}), keyPoints (array of strings), ' +
    'vocabulary (array of {word, phonetic, meaning, example, exampleZh, rootBreakdown, rootMeaning, sameRootWords, memoryHook}), ' +
    'hardSentences (array of {en, zh, why}), questions (array of strings). ' +
    'For topics: title and summary must be in ' + studyLangName() + '; start/end must be copied from the [mm:ss] timestamps ' +
    'in the transcript, in "mm:ss" format; create 2-8 chronological topics covering the chunk, with no overlap. ' +
    'For ads: identify only explicit sponsor reads, host-read advertisements, ad breaks, or promo/discount endorsements; ' +
    'start/end must be copied from the [mm:ss] timestamps in the transcript, in "mm:ss" format; label must be a short ' +
    studyLangName() + ' description such as "赞助口播" or "优惠码推广"; return [] when there is no ad. ' +
    'Do not mark ordinary brand mentions outside an ad segment. ' +
    'For vocabulary root fields: use rootBreakdown (prefix + root + suffix with hyphens and Chinese gloss), rootMeaning (literal meaning), ' +
    'sameRootWords (up to 2 real English words {word, meaning} sharing the root), memoryHook (one short Chinese memory sentence). ' +
    'Never invent roots or etymology; leave those fields empty when unsure. ' +
    'Write a faithful content summary; keyPoints should be substantive claims, examples or takeaways, not lesson meta. ' +
    'Keep vocabulary to at most 8 items.';
  const epKey = 'ep:' + host.player.state.current.id;
  const epId = host.player.state.current.id;
  const partialKey = epKey + ':partial';
  const sig = [STUDY.provider, STUDY.endpoint, STUDY.model, STUDY.target, 'ads-v1'].join('|');
  const merged = { summary: [], topics: [], ads: [], keyPoints: [], vocabulary: [], hardSentences: [], questions: [], chunks: totalChunks };
  let resume = 0;
  if (studyCache[epKey] && studyCache[epKey].data && studyCache[epKey].data.version === 3) {
    // 已完整的结果：用户点「重新总结」就是从零开始。
    delete studyCache[partialKey];
  } else {
    const saved = studyCache[partialKey];
    if (saved && saved.sig === sig && Number(saved.chunks) === totalChunks && Number(saved.done) > 0) {
      const data = saved.data || {};
      if (Array.isArray(data.summary)) merged.summary = data.summary.map(x => String(x));
      if (Array.isArray(data.topics)) merged.topics = data.topics.map(t => Object.assign({}, t));
      if (Array.isArray(data.ads)) merged.ads = host.support.sanitizeAdRanges(data.ads, 'ai');
      if (Array.isArray(data.keyPoints)) merged.keyPoints = data.keyPoints.slice();
      if (Array.isArray(data.vocabulary)) merged.vocabulary = data.vocabulary.map(v => Object.assign({}, v));
      if (Array.isArray(data.hardSentences)) merged.hardSentences = data.hardSentences.map(x => Object.assign({}, x));
      if (Array.isArray(data.questions)) merged.questions = data.questions.slice();
      resume = Math.min(Number(saved.done) || 0, totalChunks);
    } else if (saved) {
      delete studyCache[partialKey];
    }
  }
  const seenVocab = new Set(merged.vocabulary.map(v => String(v.word || '').trim().toLowerCase()).filter(Boolean));
  const seenHard = new Set(merged.hardSentences.map(x => String(x.en || '').trim().toLowerCase()).filter(Boolean));
  const seenPoint = new Set(merged.keyPoints.concat(merged.questions).map(x => String(x || '').trim()).filter(Boolean));
  const seenTopic = new Set(merged.topics.map(t => String(t.title || '').toLowerCase() + '|' + Math.round(Number(t.start) || 0)));
  const seenAd = new Set(merged.ads.map(ad => Math.round(ad.start) + '|' + Math.round(ad.end)));
  let completed = resume;
  try {
    for (let i = resume; i < totalChunks; i++) {
      body.innerHTML = studyLoading((resume
        ? '继续总结第 ' + (i + 1) + ' / ' + totalChunks + ' 块（已完成 ' + completed + ' 块）'
        : '正在总结第 ' + (i + 1) + ' / ' + totalChunks + ' 块…'));
      const out = await studyChat(system, 'Chunk ' + (i + 1) + ' of ' + totalChunks + ':\n' + chunks[i]);
      const part = studyParseJson(out);
      if (part.raw) { merged.summary.push(part.raw); continue; }
      if (part.summary) merged.summary.push(String(part.summary));
      (Array.isArray(part.topics) ? part.topics : []).forEach(t => {
        if (!t || typeof t !== 'object') return;
        const title = String(t.title || t.topic || '').trim();
        const start = studyClockSeconds(t.start ?? t.time ?? t.timestamp);
        if (!title || !Number.isFinite(start)) return;
        const k = title.toLowerCase() + '|' + Math.round(start);
        if (!seenTopic.has(k)) {
          seenTopic.add(k);
          merged.topics.push({
            title,
            start: Math.round(start),
            end: Number.isFinite(studyClockSeconds(t.end)) ? Math.round(studyClockSeconds(t.end)) : null,
            summary: String(t.summary || '').trim(),
          });
        }
      });
      (Array.isArray(part.ads) ? part.ads : []).forEach(rawAd => {
        const ad = host.support.sanitizeAdRanges([rawAd], 'ai')[0];
        if (!ad) return;
        const k = Math.round(ad.start) + '|' + Math.round(ad.end);
        if (!seenAd.has(k)) {
          seenAd.add(k);
          merged.ads.push(ad);
        }
      });
      (Array.isArray(part.keyPoints) ? part.keyPoints : []).forEach(x => {
        const k = String(x || '').trim();
        if (k && !seenPoint.has(k)) { seenPoint.add(k); merged.keyPoints.push(k); }
      });
      (Array.isArray(part.vocabulary) ? part.vocabulary : []).forEach(v => {
        const w = String(v.word || '').trim().toLowerCase();
        if (w && !seenVocab.has(w)) { seenVocab.add(w); merged.vocabulary.push(v); }
      });
      (Array.isArray(part.hardSentences) ? part.hardSentences : []).forEach(x => {
        const k = String(x.en || '').trim().toLowerCase();
        if (k && !seenHard.has(k)) { seenHard.add(k); merged.hardSentences.push(x); }
      });
      (Array.isArray(part.questions) ? part.questions : []).forEach(x => {
        const k = String(x || '').trim();
        if (k && !seenPoint.has(k)) { seenPoint.add(k); merged.questions.push(k); }
      });
      completed = i + 1;
      studyCache[partialKey] = {
        at: Date.now(), sig, chunks: totalChunks, done: completed,
        data: {
          summary: merged.summary.slice(),
          topics: merged.topics.map(t => Object.assign({}, t)),
          ads: merged.ads.map(ad => Object.assign({}, ad)),
          keyPoints: merged.keyPoints.slice(),
          vocabulary: merged.vocabulary.map(v => Object.assign({}, v)),
          hardSentences: merged.hardSentences.map(x => Object.assign({}, x)),
          questions: merged.questions.slice(),
        },
      };
      saveStudyCache();
      studyApplyWordMarks();
    }
    merged.summary = merged.summary.join('\n\n');
    merged.version = 3;
    merged.topics.sort((a, b) => a.start - b.start);
    merged.topics = merged.topics.slice(0, 24);
    merged.ads.sort((a, b) => a.start - b.start);
    merged.ads = host.support.sanitizeAdRanges(host.mergeAdRanges([merged.ads]), 'ai').slice(0, 24);
    merged.vocabulary = merged.vocabulary.slice(0, 30);
    merged.hardSentences = merged.hardSentences.slice(0, 20);
    studyCache[epKey] = { at: Date.now(), data: merged };
    delete studyCache[partialKey];
    saveStudyCache();
    host.support.applyAiAdRanges(merged, epId);
    studyRenderEpisode();
  } catch (err) {
    const failed = Math.min(completed + 1, totalChunks);
    const kept = completed ? '已保留前 ' + completed + ' / ' + totalChunks + ' 块。' : '';
    body.innerHTML = '<div class="study-section"><h4>分析失败</h4><p>第 ' + failed + ' / ' + totalChunks + ' 块失败。' + kept +
      (completed < totalChunks ? ' 点「继续剩余块」只重试第 ' + (completed + 1) + ' 块。' : '') +
      '</p><p class="smalltext">' + host.ui.esc(err.message || err) + '</p><div class="study-actions">' +
      '<button class="btn ghost small" data-study-act="episode">' + (completed ? '继续剩余块' : '重试') + '</button>' +
      (completed ? '<button class="btn ghost small" data-study-act="episodeFresh">从头开始</button>' : '') +
      '</div></div>';
    bindStudyActButtons();
  }
}
function studyRestartEpisodeSummary() {
  if (!host.player.state.current) return;
  delete studyCache['ep:' + host.player.state.current.id + ':partial'];
  saveStudyCache();
  studyAnalyzeEpisode();
}
function studyEpisodeText(data) {
  if (!data) return '';
  const title = host.player.state.current?.title || '当前单集';
  const lines = ['# ' + title, '', '## 内容摘要', String(data.summary || '').trim()].filter(Boolean);
  const ads = host.support.adRangesFromData(data);
  if (ads.length) {
    lines.push('', '## 广告点');
    ads.forEach(ad => {
      lines.push('- ' + host.ui.fmt(ad.start) + '–' + host.ui.fmt(ad.end) + ' ' + String(ad.label || '广告').trim());
    });
  }
  if (Array.isArray(data.topics) && data.topics.length) {
    lines.push('', '## 主题时间戳');
    data.topics.forEach(topic => {
      const start = studyClockSeconds(topic.start);
      const when = Number.isFinite(start) ? host.ui.fmt(start) : '';
      const summary = String(topic.summary || '').trim();
      lines.push('- ' + (when ? '[' + when + '] ' : '') + String(topic.title || '').trim() + (summary ? ' — ' + summary : ''));
    });
  }
  if (Array.isArray(data.keyPoints) && data.keyPoints.length) {
    lines.push('', '## 重点');
    data.keyPoints.forEach(point => lines.push('- ' + String(point || '').trim()));
  }
  return lines.join('\n').trim();
}
/* ---- 单集问答：只喂文字稿，引用用行号回查 ASR 时间 ---- */
const STUDY_ASK_KEY = 'myt-study-ask';
const STUDY_ASK_MAX_MESSAGES = 16;
let studyAskStore = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(STUDY_ASK_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch (e) { return {}; }
})();
let studyAskBusy = false;

function studyCueStamp(cue) {
  return host.ui.fmt(Number(cue && cue.start || 0) + Number(host.player.state.offset || 0));
}
function studyAskThread(epId) {
  if (!studyAskStore[epId] || typeof studyAskStore[epId] !== 'object') studyAskStore[epId] = { at: 0, messages: [] };
  if (!Array.isArray(studyAskStore[epId].messages)) studyAskStore[epId].messages = [];
  return studyAskStore[epId];
}
function saveStudyAsk() {
  try {
    const ids = Object.keys(studyAskStore);
    if (ids.length > 40) {
      ids.map(id => ({ id, at: Number(studyAskStore[id].at || 0) }))
        .sort((a, b) => a.at - b.at)
        .slice(0, ids.length - 40)
        .forEach(item => delete studyAskStore[item.id]);
    }
    localStorage.setItem(STUDY_ASK_KEY, JSON.stringify(studyAskStore));
  } catch (e) {}
}
/* 整集太长时按关键词挑最相关的段落，避免把几万字全塞进请求 */
function studyAskContext(question) {
  const cues = host.player.state.cues || [];
  const lineOf = (cue, index) => '#' + index + ' [' + studyCueStamp(cue) + '] ' + String(cue.text || '');
  const totalChars = cues.reduce((sum, cue) => sum + String(cue.text || '').length, 0);
  if (totalChars <= 12000 || cues.length <= 360) {
    return { full: true, count: cues.length, text: cues.map(lineOf).join('\n') };
  }
  const terms = [];
  String(question || '').toLowerCase().replace(/[^a-z0-9\u3400-\u9fff\s'-]/g, ' ').split(/\s+/)
    .filter(term => term.length > 1 && !/^(the|and|for|that|this|with|what|how|why|does|did|was|are|you|they)$/.test(term))
    .forEach(term => terms.push(term));
  (String(question || '').match(/[\u3400-\u9fff]{2,}/g) || []).forEach(word => {
    for (let i = 0; i < word.length - 1; i++) terms.push(word.slice(i, i + 2));
  });
  const size = 16;
  const parts = [];
  for (let i = 0; i < cues.length; i += size) parts.push({ from: i, to: Math.min(cues.length, i + size) });
  const scoreOf = part => {
    let score = 0;
    for (let i = part.from; i < part.to; i++) {
      const text = String(cues[i].text || '').toLowerCase();
      terms.forEach(term => { if (term && text.includes(term)) score += 1; });
    }
    return score;
  };
  const picked = parts.map(part => ({ part, score: scoreOf(part) }))
    .sort((a, b) => b.score - a.score || a.part.from - b.part.from)
    .slice(0, 8)
    .map(item => item.part)
    .sort((a, b) => a.from - b.from);
  return {
    full: false,
    count: cues.length,
    text: picked.map(part => {
      const lines = [];
      for (let i = part.from; i < part.to; i++) lines.push(lineOf(cues[i], i));
      return lines.join('\n');
    }).join('\n…\n'),
  };
}
function studyAskTimeCue(text) {
  const cues = host.player.state.cues || [];
  const match = /(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/.exec(String(text || ''));
  if (!match) return -1;
  const seconds = Number(match[1]) * 60 + Number(match[2]);
  let best = -1, bestDiff = Infinity;
  cues.forEach((cue, index) => {
    const diff = Math.abs(Number(cue.start || 0) - seconds);
    if (diff < bestDiff) { bestDiff = diff; best = index; }
  });
  return bestDiff <= 3 ? best : -1;
}
/* 只接受真实存在的行号；模型编的、越界的、重复的全部丢掉 */
function studyAskCites(raw) {
  const cues = host.player.state.cues || [];
  const out = [];
  const add = index => {
    if (Number.isInteger(index) && index >= 0 && index < cues.length && !out.includes(index)) out.push(index);
  };
  (Array.isArray(raw) ? raw : []).forEach(value => {
    if (typeof value === 'number') add(Math.round(value));
    else if (typeof value === 'string') {
      const trimmed = value.trim();
      if (/^#?\d{1,5}$/.test(trimmed)) add(Number(trimmed.replace('#', '')));
      else {
        const hit = studyAskTimeCue(trimmed);
        if (hit >= 0) add(hit);
      }
    } else if (value && typeof value === 'object') {
      add(Number(value.cue ?? value.line ?? value.index));
    }
  });
  return out.slice(0, 4);
}
function studyAskCitesFromText(text) {
  const found = [];
  String(text || '').replace(/\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?/g, (all, stamp) => {
    const index = studyAskTimeCue(stamp);
    if (index >= 0 && !found.includes(index)) found.push(index);
    return all;
  });
  return found.slice(0, 4);
}
function studyAskSuggestions() {
  const cur = studyCurrentCue();
  const items = ['这集的核心观点是什么？', '有哪些值得记下来的方法或例子？', '主持人和嘉宾在哪些地方意见不同？'];
  if (cur && cur.cue && String(cur.cue.text || '').trim()) {
    items.push('「' + String(cur.cue.text || '').trim().slice(0, 22) + '」在上下文里是什么意思？');
  }
  return items.slice(0, 4);
}
function studyAskMsgHTML(message) {
  if (!message || !message.role) return '';
  if (message.role === 'user') return '<div class="study-ask-msg user">' + host.ui.esc(message.text) + '</div>';
  const chips = (Array.isArray(message.cites) ? message.cites : []).map(index => {
    const cue = (host.player.state.cues || [])[index];
    if (!cue) return '';
    return '<button class="btn ghost small" data-study-act="askCite" data-cue="' + index + '">▶ ' +
      host.ui.esc(studyCueStamp(cue)) + '</button>';
  }).join('');
  return '<div class="study-ask-msg bot' + (message.error ? ' bad' : '') + '">' +
    (message.error ? '<p>' + host.ui.esc(message.text) + '</p>' : studyAnnotatedLines(message.text || '')) +
    (chips ? '<div class="ask-src">' + chips + '</div>' : '') +
    '</div>';
}
function studyRenderAsk(busy) {
  const body = $('studyBody');
  if (!body) return;
  studyRenderNow();
  studyVocabContext = null; studyVocabContextMode = null;
  const epId = host.player.state.current ? host.player.state.current.id : '';
  if (!epId) { body.innerHTML = studyEmpty('先选择一集。'); return; }
  const thread = studyAskThread(epId);
  let html = '<p class="study-empty">问这一集的内容。答案只依据本集文字稿，引用按钮直接跳到原句；文字稿里没有的内容它会直说不知道。</p>';
  if (!thread.messages.length) {
    html += '<div class="study-actions">' + studyAskSuggestions().map(question =>
      '<button class="btn ghost small" data-study-act="askAsk" data-study-q="' + host.ui.esc(question) + '">' +
      host.ui.esc(question.length > 20 ? question.slice(0, 20) + '…' : question) + '</button>').join('') + '</div>';
  }
  html += '<div class="study-ask-log">' + thread.messages.map(studyAskMsgHTML).join('') + '</div>';
  if (busy || studyAskBusy) html += studyLoading('正在读文字稿并回答…');
  html += '<div class="study-ask-form"><textarea id="studyAskInput" rows="2" placeholder="例如：这集说的三个方法是什么？"' +
    (studyAskBusy ? ' disabled' : '') + '></textarea>' +
    '<button class="btn primary small" data-study-act="askSend"' + (studyAskBusy ? ' disabled' : '') + '>提问</button></div>';
  body.innerHTML = html;
  bindStudyActButtons();
  bindStudyAskForm();
}
function bindStudyAskForm() {
  const input = $('studyAskInput');
  if (!input) return;
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!studyAskBusy) studyAsk(input.value);
    }
  });
}
async function studyAsk(question) {
  const body = $('studyBody');
  const epId = host.player.state.current ? host.player.state.current.id : '';
  if (!epId) return;
  if (!(host.player.state.cues || []).length) { if (body) body.innerHTML = studyEmpty('这一集没有文字稿，无法问答。'); return; }
  if (!studyReady()) { if (body) body.innerHTML = studyEmpty('请先在「设置 → AI 学英语」填写 API Key 和模型。'); return; }
  const text = String(question || '').trim();
  if (!text || studyAskBusy) return;
  const thread = studyAskThread(epId);
  thread.messages.push({ role: 'user', text, at: Date.now() });
  while (thread.messages.length > STUDY_ASK_MAX_MESSAGES) thread.messages.shift();
  thread.at = Date.now();
  saveStudyAsk();
  studyAskBusy = true;
  studyRenderAsk(true);
  try {
    const context = studyAskContext(text);
    const history = thread.messages.slice(-5, -1)
      .filter(message => message && message.text)
      .map(message => ({
        role: message.role === 'user' ? 'user' : 'assistant',
        text: String(message.text || '').slice(0, 300),
      }));
    const system = 'You answer questions about one podcast episode for a Chinese-speaking learner. ' +
      'Use ONLY the transcript lines provided. Lines are prefixed "#<line number> [mm:ss]". ' +
      'Return ONLY a JSON object, no markdown fences: {"answer": string in ' + studyLangName() + ', ' +
      '"cites": array of 1-4 integer line numbers you actually relied on}. ' +
      'Every factual claim must be supported by a cited line. Never invent facts, names, numbers or timestamps. ' +
      'If the transcript does not contain the answer, say so plainly in ' + studyLangName() + ' and return "cites": []. ' +
      'Be direct and specific; at most 200 words unless the user asks for detail. Do not add a bibliography.';
    const user = JSON.stringify({
      show: host.player.state.show ? host.player.state.show.name : '',
      episode: host.player.state.current ? host.player.state.current.title : '',
      question: text,
      transcript: context.text,
      full_transcript: context.full,
      total_lines: context.count,
      previous_turns: history,
    });
    const out = await studyChat(system, user);
    const data = studyParseJson(out);
    const answer = String(data.answer || data.text || data.raw || '').trim();
    let cites = studyAskCites(data.cites);
    if (!cites.length) cites = studyAskCitesFromText(answer);
    thread.messages.push({ role: 'bot', text: answer || '模型没有返回内容。', cites, at: Date.now() });
  } catch (err) {
    thread.messages.push({ role: 'bot', text: '回答失败：' + String(err && err.message ? err.message : err), error: true, cites: [] });
  } finally {
    studyAskBusy = false;
    saveStudyAsk();
    if (studyView === 'ask') studyRenderAsk();
  }
}
/* ---- 自动章节：模型只给行号，时间由 ASR cue 决定 ---- */
function studyChapterEntry() {
  const epId = host.player.state.current ? host.player.state.current.id : '';
  const entry = epId ? studyCache['ch:' + epId] : null;
  return entry && entry.data && Array.isArray(entry.data.chapters) ? entry : null;
}
function studyChaptersHTML(data) {
  const chapters = Array.isArray(data && data.chapters) ? data.chapters : [];
  if (!chapters.length) return '';
  const rows = chapters.map((chapter, index) => {
    if (!chapter || typeof chapter !== 'object') return '';
    const ci = Number(chapter.ci);
    const cues = host.player.state.cues || [];
    const cue = Number.isInteger(ci) && ci >= 0 && ci < cues.length ? cues[ci] : null;
    const start = cue ? Number(cue.start) : Number(chapter.start);
    const title = String(chapter.title || '').trim();
    if (!title && !Number.isFinite(start)) return '';
    const when = Number.isFinite(start) ? host.ui.fmt(start + (Number(host.player.state.offset) || 0)) : '';
    return '<div class="study-topic study-chapter">' +
      (Number.isFinite(start)
        ? '<button class="btn ghost small" data-study-act="topic" data-study-t="' + Math.round(start) + '">▶ ' + host.ui.esc(when) + '</button>'
        : '<span class="study-chapter-no">' + (index + 1) + '</span>') +
      '<div><strong>' + studyAnnotateText(title || '未命名章节') + '</strong>' +
      (chapter.summary ? '<p>' + studyAnnotateText(chapter.summary) + '</p>' : '') + '</div></div>';
  }).join('');
  if (!rows) return '';
  return '<div class="study-section"><h4>章节</h4>' + rows + '</div>';
}
async function studyAnalyzeChapters() {
  const body = $('studyBody');
  if (!host.player.state.current) return;
  const epId = host.player.state.current.id;
  const cues = host.player.state.cues || [];
  if (!cues.length) { host.ui.toast('这一集没有文字稿，无法生成章节。', 5000); return; }
  if (!studyReady()) { host.ui.toast('请先在「设置 → AI 学英语」填写 API Key 和模型。', 6000); return; }
  const sig = [STUDY.provider, STUDY.endpoint, STUDY.model, STUDY.target, cues.length, 'chapter-v1'].join('|');
  const key = 'ch:' + epId;
  const lines = cues.map((cue, index) => '#' + index + ' [' + studyCueStamp(cue) + '] ' + String(cue.text || ''));
  const chunkCount = Math.max(1, Math.min(3, Math.ceil(lines.join('\n').length / 7000)));
  const per = Math.ceil(lines.length / chunkCount);
  const system = 'You build a chapter list for one podcast episode. ' +
    'Transcript lines are prefixed "#<line number> [mm:ss]". ' +
    'Return ONLY a JSON object, no markdown fences: {"chapters":[{"cue": integer line number, ' +
    '"title": string in ' + studyLangName() + ', "summary": string in ' + studyLangName() + '}]}. ' +
    'Each chapter must start at a natural topic boundary, never inside a sentence. ' +
    'Only use line numbers that literally appear in the given lines. Produce 2-6 chronological chapters for this chunk. ' +
    'Titles must be <= 18 characters, summaries <= 40 characters. Never invent content that is not in the transcript.';
  const merged = [];
  const seenCue = new Set();
  try {
    for (let i = 0; i < chunkCount; i++) {
      const from = i * per, to = Math.min(lines.length, from + per);
      if (from >= to) continue;
      if (body) body.innerHTML = studyLoading('正在生成章节…第 ' + (i + 1) + ' / ' + chunkCount + ' 块');
      const user = 'Chunk ' + (i + 1) + ' of ' + chunkCount + ' (lines #' + from + ' to #' + (to - 1) + '):\n' +
        lines.slice(from, to).join('\n');
      const out = await studyChat(system, user);
      const part = studyParseJson(out);
      (Array.isArray(part.chapters) ? part.chapters : []).forEach(chapter => {
        if (!chapter || typeof chapter !== 'object') return;
        const ci = Number(chapter.cue ?? chapter.line ?? chapter.index);
        if (!Number.isInteger(ci) || ci < Math.max(0, from - 2) || ci >= Math.min(cues.length, to + 2)) return;
        if (seenCue.has(ci)) return;
        const title = String(chapter.title || '').trim();
        if (!title) return;
        seenCue.add(ci);
        merged.push({ ci, title, summary: String(chapter.summary || '').trim(), start: Number(cues[ci].start) || 0 });
      });
    }
    merged.sort((a, b) => a.ci - b.ci);
    const chapters = merged.slice(0, 18);
    if (!chapters.length) throw new Error('模型没有返回可用的章节。');
    studyCache[key] = { at: Date.now(), sig, data: { version: 1, chapters } };
    saveStudyCache();
    if (studyView === 'episode') studyRenderEpisode();
    host.ui.toast('已生成 ' + chapters.length + ' 个章节。', 3000);
  } catch (err) {
    if (studyView === 'episode') studyRenderEpisode();
    host.ui.toast('章节生成失败：' + String(err && err.message ? err.message : err), 7000);
  }
}
/* ---- 金句卡片：挑句子用行号，卡片在本地画，不依赖模型出图 ---- */
function studyQuoteEntry() {
  const epId = host.player.state.current ? host.player.state.current.id : '';
  const entry = epId ? studyCache['q:' + epId] : null;
  return entry && entry.data && Array.isArray(entry.data.quotes) ? entry : null;
}
function studyQuotesHTML(data) {
  const quotes = Array.isArray(data && data.quotes) ? data.quotes : [];
  if (!quotes.length) return '';
  const cues = host.player.state.cues || [];
  const rows = quotes.map(quote => {
    if (!quote || typeof quote !== 'object') return '';
    const ci = Number(quote.ci);
    if (!Number.isInteger(ci) || ci < 0 || ci >= cues.length) return '';
    const cue = cues[ci];
    return '<div class="study-quote">' +
      '<p class="study-quote-en">' + host.ui.esc(cue.text || '') + '</p>' +
      (cue.zh ? '<p class="study-quote-zh">' + host.ui.esc(cue.zh) + '</p>' : '') +
      (quote.reason ? '<small>' + studyAnnotateText(quote.reason) + '</small>' : '') +
      '<div class="study-actions">' +
      '<button class="btn ghost small" data-study-act="topic" data-study-t="' + Math.round(Number(cue.start) || 0) + '">▶ ' + host.ui.esc(studyCueStamp(cue)) + '</button>' +
      '<button class="btn ghost small" data-study-act="quoteCard" data-cue="' + ci + '">生成卡片</button>' +
      '</div></div>';
  }).join('');
  if (!rows) return '';
  return '<div class="study-section"><h4>金句卡片</h4>' + rows + '</div>';
}
async function studyAnalyzeQuotes() {
  const body = $('studyBody');
  if (!host.player.state.current) return;
  const epId = host.player.state.current.id;
  const cues = host.player.state.cues || [];
  if (!cues.length) { host.ui.toast('这一集没有文字稿。', 5000); return; }
  if (!studyReady()) { host.ui.toast('请先在「设置 → AI 学英语」填写 API Key 和模型。', 6000); return; }
  const sig = [STUDY.provider, STUDY.endpoint, STUDY.model, STUDY.target, cues.length, 'quote-v1'].join('|');
  const key = 'q:' + epId;
  const lines = cues.map((cue, index) => '#' + index + ' [' + studyCueStamp(cue) + '] ' + String(cue.text || ''));
  const chunkCount = Math.max(1, Math.min(3, Math.ceil(lines.join('\n').length / 7000)));
  const per = Math.ceil(lines.length / chunkCount);
  const system = 'You pick memorable quotes from one podcast episode for study cards. ' +
    'Transcript lines are prefixed "#<line number> [mm:ss]". ' +
    'Return ONLY a JSON object, no markdown fences: {"quotes":[{"cue": integer line number, ' +
    '"reason": string in ' + studyLangName() + '}]}. ' +
    'Pick 2-3 lines per chunk that are self-contained, insightful, vivid or useful. ' +
    'Only use line numbers that literally appear in the given lines. Reason must be <= 24 characters. ' +
    'Never invent content that is not in the transcript.';
  const merged = [];
  const seenCue = new Set();
  try {
    for (let i = 0; i < chunkCount; i++) {
      const from = i * per, to = Math.min(lines.length, from + per);
      if (from >= to) continue;
      if (body) body.innerHTML = studyLoading('正在挑金句…第 ' + (i + 1) + ' / ' + chunkCount + ' 块');
      const user = 'Chunk ' + (i + 1) + ' of ' + chunkCount + ' (lines #' + from + ' to #' + (to - 1) + '):\n' +
        lines.slice(from, to).join('\n');
      const out = await studyChat(system, user);
      const part = studyParseJson(out);
      (Array.isArray(part.quotes) ? part.quotes : []).forEach(quote => {
        if (!quote || typeof quote !== 'object') return;
        const ci = Number(quote.cue ?? quote.line ?? quote.index);
        if (!Number.isInteger(ci) || ci < Math.max(0, from - 2) || ci >= Math.min(cues.length, to + 2)) return;
        if (seenCue.has(ci)) return;
        seenCue.add(ci);
        merged.push({ ci, reason: String(quote.reason || '').trim() });
      });
    }
    merged.sort((a, b) => a.ci - b.ci);
    const quotes = merged.slice(0, 8);
    if (!quotes.length) throw new Error('模型没有返回可用的金句。');
    studyCache[key] = { at: Date.now(), sig, data: { version: 1, quotes } };
    saveStudyCache();
    if (studyView === 'episode') studyRenderEpisode();
    host.ui.toast('已挑出 ' + quotes.length + ' 句金句。', 3000);
  } catch (err) {
    if (studyView === 'episode') studyRenderEpisode();
    host.ui.toast('金句生成失败：' + String(err && err.message ? err.message : err), 7000);
  }
}
function studyWrapCanvasText(ctx, text, max, maxLines) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const byWord = /\s/.test(raw);
  const units = byWord ? raw.split(/\s+/) : Array.from(raw);
  const lines = [];
  let line = '';
  units.forEach(unit => {
    if (!line && ctx.measureText(unit).width > max) {
      Array.from(unit).forEach(ch => {
        const trial = line ? line + ch : ch;
        if (line && ctx.measureText(trial).width > max) { lines.push(line); line = ch; }
        else line = trial;
      });
      return;
    }
    const trial = line ? line + (byWord ? ' ' : '') + unit : unit;
    if (line && ctx.measureText(trial).width > max) { lines.push(line); line = unit; }
    else line = trial;
  });
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/.$/, '') + '…';
    return kept;
  }
  return lines;
}
let studyQuoteUrl = '';
let studyQuoteEsc = null;
function studyCloseQuoteCard() {
  const wrap = $('quoteCardWrap');
  if (wrap) wrap.remove();
  if (studyQuoteEsc) { document.removeEventListener('keydown', studyQuoteEsc); studyQuoteEsc = null; }
  if (studyQuoteUrl) {
    try { URL.revokeObjectURL(studyQuoteUrl); } catch (e) {}
    studyQuoteUrl = '';
  }
}
function studyOpenQuoteCard(rawCue) {
  if (!host.catalog.studyPluginOn()) return;
  const ci = Number(rawCue);
  const cue = (host.player.state.cues || [])[ci];
  if (!cue) { host.ui.toast('这一句不在当前文字稿里。', 4000); return; }
  const W = 1080, H = 1350;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) { host.ui.toast('卡片生成失败。', 4000); return; }
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#15181f');
  bg.addColorStop(0.55, '#0e1116');
  bg.addColorStop(1, '#1a2431');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(233,196,106,.10)';
  ctx.beginPath(); ctx.arc(920, 170, 250, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#e9c46a'; ctx.fillRect(76, 118, 12, 104);
  ctx.fillStyle = '#8b98a9';
  ctx.font = '600 24px "Noto Sans SC","Microsoft YaHei",system-ui,sans-serif';
  ctx.fillText('MYTRANSCRIPT · 金句卡片', 108, 154);
  let y = 372;
  ctx.fillStyle = '#f6f3ea';
  ctx.font = '600 58px "Noto Serif SC","Songti SC","Noto Sans SC",serif';
  studyWrapCanvasText(ctx, cue.text, 900, 7).forEach(line => { ctx.fillText(line, 84, y); y += 82; });
  y += 34;
  if (cue.zh) {
    ctx.fillStyle = '#a8b5c6';
    ctx.font = '400 36px "Noto Sans SC","Microsoft YaHei",system-ui,sans-serif';
    studyWrapCanvasText(ctx, cue.zh, 900, 4).forEach(line => { ctx.fillText(line, 84, y); y += 56; });
  }
  ctx.fillStyle = '#e9c46a'; ctx.fillRect(84, H - 250, 900, 2);
  ctx.font = '600 30px "Noto Sans SC",system-ui,sans-serif';
  ctx.fillText(studyCueStamp(cue), 84, H - 190);
  ctx.fillStyle = '#d6dbe4';
  ctx.font = '400 28px "Noto Sans SC","Microsoft YaHei",system-ui,sans-serif';
  let ty = H - 140;
  studyWrapCanvasText(ctx, host.player.state.current ? host.player.state.current.title : '', 900, 2)
    .forEach(line => { ctx.fillText(line, 84, ty); ty += 38; });
  ctx.fillStyle = '#7d8b9d';
  ctx.font = '400 24px "Noto Sans SC",system-ui,sans-serif';
  ctx.fillText((host.player.state.show ? host.player.state.show.name : 'MyTranscript').slice(0, 34), 84, H - 62);
  canvas.toBlob(blob => {
    if (!blob) { host.ui.toast('卡片生成失败。', 4000); return; }
    studyCloseQuoteCard();
    studyQuoteUrl = URL.createObjectURL(blob);
    const wrap = document.createElement('div');
    wrap.className = 'quote-card-wrap';
    wrap.id = 'quoteCardWrap';
    wrap.innerHTML = '<div class="quote-card" role="dialog" aria-label="金句卡片">' +
      '<header><span>分享</span><b>' + host.ui.esc(studyCueStamp(cue)) + ' · ' + host.ui.esc((host.player.state.show ? host.player.state.show.name : '') || '') + '</b>' +
      '<button type="button" data-quote-close aria-label="关闭">✕</button></header>' +
      '<img src="' + studyQuoteUrl + '" alt="金句卡片预览">' +
      '<div class="study-actions">' +
      '<button class="btn primary small" data-quote-download>下载 PNG</button>' +
      '<button class="btn ghost small" data-quote-copy>复制文字</button>' +
      '</div></div>';
    document.body.append(wrap);
    wrap.addEventListener('click', event => { if (event.target === wrap) studyCloseQuoteCard(); });
    wrap.querySelector('[data-quote-close]').onclick = studyCloseQuoteCard;
    wrap.querySelector('[data-quote-download]').onclick = () => {
      if (!studyQuoteUrl) return;
      const link = document.createElement('a');
      link.href = studyQuoteUrl;
      link.download = 'myt-quote-' + Math.round(Number(cue.start) || 0) + '.png';
      document.body.append(link);
      link.click();
      link.remove();
      host.ui.toast('金句卡片已保存。', 3000);
    };
    wrap.querySelector('[data-quote-copy]').onclick = async () => {
      const text = [cue.text, cue.zh, '— ' + [(host.player.state.show ? host.player.state.show.name : ''), (host.player.state.current ? host.player.state.current.title : ''), studyCueStamp(cue)].filter(Boolean).join(' · ')]
        .filter(Boolean).join('\n');
      if (await host.ui.copyPlain(text)) host.ui.toast('已复制卡片文字。', 3000);
      else host.ui.toast('复制失败，请手动选择文本。', 4000);
    };
    studyQuoteEsc = event => { if (event.key === 'Escape') studyCloseQuoteCard(); };
    document.addEventListener('keydown', studyQuoteEsc);
  }, 'image/png');
}
async function studyCopyEpisode() {
  const key = host.player.state.current ? 'ep:' + host.player.state.current.id : '';
  const data = key ? studyCache[key]?.data : null;
  if (!data) { host.ui.toast('还没有整集总结。', 3000); return; }
  const text = studyEpisodeText(data);
  if (!text) { host.ui.toast('总结为空。', 3000); return; }
  if (await host.ui.copyPlain(text)) host.ui.toast('已复制整集总结。', 3000);
  else host.ui.toast('复制失败，请手动选择文本。', 4000);
}
function studyOpenEpisodeSummary(key, epId) {
  if (!host.catalog.studyPluginOn()) { host.ui.toast('学英语插件未启用。', 'warn'); return; }
  const show = host.catalog.showByKey(key);
  const ep = show ? host.catalog.episodesOf(show).find(item => item.id === epId) : null;
  if (!show || !ep) { host.ui.toast('找不到这一集。', 5000); return; }
  if (!host.catalog.moduleOn('study')) { host.ui.toast('AI 学英语模块已关闭。', 5000); return; }
  if (!ep.transcript?.url) { host.ui.toast('这一集没有文字稿，无法总结。', 5000); return; }
  if (!studyReady()) {
    host.ui.toast('请先在「设置 → AI 学英语」填写 API Key 和模型。', 8000);
    host.ui.navigate('settings');
    return;
  }
  pendingStudyEpisode = epId;
  host.player.setAutoplay(false);
  host.ui.navigate('player', [key, epId]);
  waitStudyEpisodeSummary(epId, 0);
}
function waitStudyEpisodeSummary(epId, tries) {
  if (pendingStudyEpisode !== epId) return;
  if (host.player.state.current?.id === epId && (host.player.state.cues || []).length) {
    pendingStudyEpisode = '';
    openStudySheet('episode');
    if (studyCache['ep:' + epId]?.data?.version !== 3) studyAnalyzeEpisode();
    return;
  }
  if (tries < 80) { setTimeout(() => waitStudyEpisodeSummary(epId, tries + 1), 250); return; }
  pendingStudyEpisode = '';
  host.ui.toast('文字稿还没准备好，请打开播放页后再试。', 6000);
}
function bindStudyActButtons() {
  document.querySelectorAll('[data-study-act]').forEach(btn => {
    btn.onclick = () => {
      const act = btn.dataset.studyAct;
      if (act === 'current') studyAnalyzeCurrent();
      else if (act === 'episode') studyAnalyzeEpisode();
      else if (act === 'episodeFresh') studyRestartEpisodeSummary();
      else if (act === 'copyEpisode') studyCopyEpisode();
      else if (act === 'ad' || act === 'topic') {
        const t = Number(btn.dataset.studyT);
        if (Number.isFinite(t) && t >= 0) host.player.seekTo(t);
      }
      else if (act === 'playCue') { const cur = studyCurrentCue(); if (cur) studyPlayCue(cur.cue, 1); }
      else if (act === 'loopCue') { const cur = studyCurrentCue(); if (cur) studyPlayCue(cur.cue, 3); }
      else if (act === 'autoPause') { host.player.setAutoPause(!host.player.getAutoPause()); const r = studyRuntime(); if (r && r.resetAutoPause) r.resetAutoPause(); studyRenderCurrent(); }
      else if (act === 'hideZh') { studyHideZh = !studyHideZh; studyRenderCurrent(); }
      else if (act === 'playReview') {
        const due = studyDueItems();
        if (due[0]) studyPlayItem(due[0]);
      } else if (act === 'reveal') {
        studyReviewRevealed = true;
        studyRenderReview();
      } else if (act === 'playEx') {
        if (studyExercise) studyPlayCue(studyExercise.cue, 1);
      } else if (act === 'nextEx') {
        const cur = studyCurrentCue();
        if (cur && host.player.state.cues[cur.ci + 1]) {
          studyExercise = null;
          host.player.seekTo(host.player.state.cues[cur.ci + 1].start + host.player.state.offset);
          setTimeout(() => studyRenderPractice(), 80);
        }
      } else if (act === 'checkEx') studyCheckExercise(false);
      else if (act === 'showEx') studyCheckExercise(true);
      else if (act === 'backEx') { if (studyExercise) studyExercise.checked = false; studyRenderPractice(); }
      else if (act === 'chapters') studyAnalyzeChapters();
      else if (act === 'quotes') studyAnalyzeQuotes();
      else if (act === 'quoteCard') studyOpenQuoteCard(btn.dataset.cue);
      else if (act === 'askSend') {
        const input = $('studyAskInput');
        if (input) studyAsk(input.value);
      } else if (act === 'askAsk') studyAsk(btn.dataset.studyQ || '');
      else if (act === 'askCite') {
        const cue = (host.player.state.cues || [])[Number(btn.dataset.cue)];
        if (cue) host.player.seekTo(Number(cue.start) || 0);
      }
    };
  });
  document.querySelectorAll('[data-study-grade]').forEach(btn => {
    btn.onclick = () => {
      const due = studyDueItems();
      const v = due[0];
      if (!v) return;
      studySrsGrade(v, Number(btn.dataset.studyGrade));
      studyReviewRevealed = false;
      saveStudyVocab();
      studyUpdateDueBadge();
      studyRenderReview();
    };
  });
  document.querySelectorAll('[data-study-ex]').forEach(btn => {
    btn.onclick = () => { studyStartExercise(btn.dataset.studyEx); studyRenderPractice(); };
  });
  bindStudyVocabButtons();
}
async function studyTestConnection() {
  const status = $('studyStatus');
  if (status) { status.textContent = '测试中…'; status.style.color = ''; }
  try {
    const out = await studyChat('You are a connection tester. Reply with exactly OK.', 'OK?');
    if (status) { status.textContent = '连接正常：' + String(out || '').trim().slice(0, 40); status.style.color = '#6fbf8f'; }
  } catch (err) {
    if (status) { status.textContent = String(err.message || err); status.style.color = '#c96363'; }
  }
}
function studyModelStatus(text, color) {
  const status = $('studyModelStatus');
  if (!status) return;
  status.textContent = text || '';
  status.style.color = color || '';
}
function studyClearModels() {
  const picker = $('studyModelPicker');
  const list = $('studyModelList');
  const count = $('studyModelCount');
  const search = $('studyModelSearch');
  if (list) list.innerHTML = '';
  if (count) count.textContent = '';
  if (search) search.value = '';
  if (picker) picker.hidden = true;
}
function studyFilterModels() {
  const list = $('studyModelList');
  const count = $('studyModelCount');
  if (!list || !count) return;
  const q = String(($('studyModelSearch') && $('studyModelSearch').value) || '').trim().toLowerCase();
  const items = [...list.querySelectorAll('.study-model-item')];
  let visible = 0;
  items.forEach(btn => {
    const hit = !q || btn.textContent.toLowerCase().includes(q);
    btn.hidden = !hit;
    if (hit) visible++;
  });
  count.textContent = q
    ? '显示 ' + visible + ' / ' + items.length + ' 个'
    : '共 ' + items.length + ' 个，可滚动查看全部';
}
function studyOpenModels() {
  const picker = $('studyModelPicker');
  if (!picker) return;
  picker.hidden = false;
  studyFilterModels();
}
function studyRenderModelList(models) {
  const list = $('studyModelList');
  if (!list) return;
  list.innerHTML = models.map(item => {
    const id = String(item.id);
    const name = String(item.name || id);
    const selected = id === String(STUDY.model || '');
    return '<button type="button" class="study-model-item" role="option" data-model="' + host.ui.esc(id) + '" aria-selected="' + (selected ? 'true' : 'false') + '">' +
      '<span>' + host.ui.esc(name) + '</span>' + (name === id ? '' : '<span class="id">' + host.ui.esc(id) + '</span>') + '</button>';
  }).join('');
  if (!models.length) {
    list.innerHTML = '<div class="study-model-empty">没有可用模型，可直接手动填写模型名。</div>';
  }
  studyOpenModels();
}
function studyPickModel(id) {
  STUDY.model = id;
  saveStudy();
  syncStudySettings();
  const picker = $('studyModelPicker');
  if (picker) picker.hidden = true;
  studyModelStatus('已选择：' + id, '#6fbf8f');
}
async function studyFetchModels() {
  if (!studyNative()) { studyModelStatus('桌面版才能获取模型列表', '#c96363'); return; }
  if (!String(STUDY.key || '').trim()) { studyModelStatus('先填写 API Key，再获取模型列表', '#c96363'); return; }
  if (STUDY.provider === 'custom' && !String(STUDY.endpoint || '').trim()) {
    studyModelStatus('先填写自定义接口地址', '#c96363'); return;
  }
  studyModelStatus('正在获取模型列表…');
  try {
    const tauri = host.shell.tauriHost();
    const list = await tauri.core.invoke('llm_models', { config: studyConfig() });
    const models = (Array.isArray(list) ? list : []).filter(item => item && String(item.id || '').trim());
    if (!models.length) { studyModelStatus('厂商没有返回可用模型，可手动填写模型名', '#c96363'); return; }
    if (!String(STUDY.model || '').trim()) {
      STUDY.model = models[0].id;
      saveStudy();
      syncStudySettings();
    }
    studyRenderModelList(models.map(item => ({ id: String(item.id), name: String(item.name || item.id) })));
    studyModelStatus('已获取 ' + models.length + ' 个模型，请在下方列表中选择', '#6fbf8f');
  } catch (err) {
    studyModelStatus(String(err.message || err), '#c96363');
  }
}
function bindTranslateUI() {
  const on = $('trOn');
  if (on) uiListen(on, 'click', () => {
    host.translate.TR.on = !host.translate.TR.on;
    host.translate.save();
    // 开自动翻译时如果正文只显示英文，顺手切到双语，否则译完也看不见。
    if (host.translate.TR.on && host.translate.reader.lang === 'en') {
      host.translate.reader.lang = 'both';
      host.translate.applyReader();
      host.translate.rebuildCues();
    }
    host.translate.sync();
    host.translate.status(host.translate.TR.on
      ? (host.translate.ready() ? '已开启，播放时自动翻译' : '还缺 API Key')
      : '未开启', host.translate.TR.on && !host.translate.ready());
    if (host.translate.TR.on && host.player.state.cues.length && host.player.state.activeCue >= 0) {
      host.translate.primeCues(host.player.state.activeCue);
    }
  });
  const engine = $('trEngine');
  if (engine) uiListen(engine, 'change', () => {
    host.translate.TR.engine = engine.value;
    host.translate.save();
    host.translate.sync();
  });
  const target = $('trTarget');
  if (target) uiListen(target, 'change', () => {
    host.translate.TR.target = target.value;
    host.translate.TR_CACHE.clear();
    host.translate.save();
  });
  [['trEndpoint', 'endpoint'], ['trKey', 'key'], ['trRegion', 'region'], ['trModel', 'model']].forEach(([id, field]) => {
    const el = $(id);
    if (!el) return;
    uiListen(el, 'input', () => { host.translate.TR[field] = el.value; host.translate.save(); });
    uiListen(el, 'change', () => host.translate.sync());
  });
  const test = $('trTest');
  if (test) uiListen(test, 'click', async () => {
    if (!host.translate.native()) { host.translate.status('自动翻译需要在桌面版使用', true); return; }
    test.disabled = true;
    host.translate.status('测试中…', false);
    try {
      const [out] = await host.translate.batch(['Hello, this is a translation test.']);
      host.translate.status('译文：' + (out || ''), false);
    } catch (err) {
      host.translate.noteError(err);
    } finally {
      test.disabled = false;
    }
  });
}
function bindStudyUI() {
  beginUiBindings();
  uiListen($('studyBtn'), 'click', e => { e.stopPropagation(); openStudySheet(); });
  uiListen($('studyClose'), 'click', closeStudySheet);
  document.querySelectorAll('[data-study-view]').forEach(btn => {
    uiListen(btn, 'click', () => setStudyView(btn.dataset.studyView));
  });
  // 页签按 ARIA tabs 的惯例支持左右方向键与 Home/End，省得一个个 Tab 过去。
  const studyTabBar = $('studySheet')?.querySelector('.study-tabs');
  if (studyTabBar) {
    uiListen(studyTabBar, 'keydown', ev => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return;
      const btns = [...studyTabBar.querySelectorAll('[data-study-view]')];
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      ev.preventDefault();
      const n = ev.key === 'ArrowLeft' ? (i + btns.length - 1) % btns.length
        : ev.key === 'ArrowRight' ? (i + 1) % btns.length
        : ev.key === 'Home' ? 0 : btns.length - 1;
      btns[n].focus({ preventScroll: true });
      setStudyView(btns[n].dataset.studyView);
    });
  }
  const provider = $('studyProvider');
  if (provider) uiListen(provider, 'change', () => applyStudyProvider(provider.value, true));
  const fields = [['studyEndpoint', 'endpoint'], ['studyKey', 'key'], ['studyModel', 'model'], ['studyTarget', 'target']];
  fields.forEach(([id, key]) => {
    const el = $(id); if (!el) return;
    uiListen(el, 'change', () => {
      STUDY[key] = el.value;
      if (key === 'endpoint') {
        studyClearModels();
        const modelStatus = $('studyModelStatus'); if (modelStatus) { modelStatus.textContent = ''; modelStatus.style.color = ''; }
      }
      saveStudy();
      syncStudySettings();
    });
  });
  const modelSearch = $('studyModelSearch');
  if (modelSearch) uiListen(modelSearch, 'input', studyFilterModels);
  uiListen($('studyModelClose'), 'click', () => { const picker = $('studyModelPicker'); if (picker) picker.hidden = true; });
  const modelList = $('studyModelList');
  if (modelList) uiListen(modelList, 'click', e => {
    const btn = e.target.closest('.study-model-item');
    if (btn) studyPickModel(btn.dataset.model || '');
  });
  const modelInput = $('studyModel');
  if (modelInput) uiListen(modelInput, 'focus', () => {
    const list = $('studyModelList');
    if (list && list.querySelectorAll('.study-model-item').length) studyOpenModels();
  });
  uiListen($('studyModelFetch'), 'click', studyFetchModels);
  uiListen($('studyTestBtn'), 'click', studyTestConnection);
  uiListen($('studyClearCache'), 'click', () => {
    Object.keys(studyCache).forEach(k => delete studyCache[k]); saveStudyCache();
    host.ui.toast('已清空 AI 学习缓存。', 3000);
    if ($('studySheet').classList.contains('on')) setStudyView(studyView);
  });
  uiListen($('studySheet'), 'click', e => e.stopPropagation());
  uiListen(host.player.audio, 'timeupdate', studyAudioTick);
  uiListen(host.player.audio, 'play', () => {
    const r = studyRuntime(); if (r && r.notePlaybackStart) r.notePlaybackStart();
  });
  uiListen(host.player.audio, 'ended', () => {
    const r = studyRuntime(); if (r && r.notePlaybackEnded) r.notePlaybackEnded();
  });
  studyUpdateDueBadge();
  bindStudyActButtons();
  bindStudyTermTips();
  bindTranslateUI();
}

  return {applyStudyProvider,bindStudyUI,bindWordStatusButtons,closeStudySheet,disposeStudyUI,openStudySheet,resetStudyContext,setStudyView,studyAddVocab,studyAnalyzeCurrent,studyAnalyzeEpisode,studyApplyWordMarks,studyAsk,studyChat,studyCheckExercise,studyClearModels,studyConfig,studyCueBounds,studyCurrentCue,studyCurrentKey,studyDueItems,studyEpisodeHTML,studyExportCsv,studyFetchModels,studyHash,studyLangName,studyMarkWord,studyModelStatus,studyNative,studyOpenEpisodeSummary,studyOpenModels,studyParseJson,studyPickModel,studyPlayCue,studyPlayItem,studyPlayRange,studyProviderMeta,studyReady,studyRenderCurrent,studyRenderEpisode,studyRenderModelList,studyRenderNow,studyRenderPractice,studyRenderReview,studyRenderVocab,studySourceLabel,studyStartExercise,studyStats,studyTestConnection,studyUpdateDueBadge,studyWithCues,syncStudySettings,wordStatusHTML};
}
