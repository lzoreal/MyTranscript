/* layer: view —— 自动翻译与 AI 学英语
   本片只做该层的事，跨层调用走 kernel / host() / setState。 */
/* ================== AI 学英语 ================== */
const STUDY_KEY = 'myt-study', STUDY_CACHE_KEY = 'myt-study-cache', STUDY_VOCAB_KEY = 'myt-study-vocab', STUDY_STATUS_KEY = 'myt-study-status';
const STUDY_SUMMARY_CHUNKS = 3;
const STUDY_PROVIDERS = {
  openai: { name: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini', hint: 'OpenAI 官方或任意 OpenAI 兼容接口', modelHint: '建议用支持中文的通用模型，如 gpt-4o-mini', keyHint: 'sk-...' },
  claude: { name: 'Claude', endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-3-5-sonnet-latest', hint: 'Anthropic Messages API，Key 以 sk-ant- 开头', modelHint: '如 claude-3-5-sonnet-latest，可手动换成当前可用模型', keyHint: 'sk-ant-...' },
  gemini: { name: 'Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash', hint: 'Google Generative Language API，填 AI Studio 的 API Key', modelHint: '如 gemini-2.5-flash，可手动换模型', keyHint: 'AIza...' },
  deepseek: { name: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-chat', hint: 'OpenAI 兼容接口，适合长文总结', modelHint: '如 deepseek-chat', keyHint: 'sk-...' },
  kimi: { name: 'Kimi', endpoint: 'https://api.moonshot.cn/v1', model: 'kimi-k2-0905-preview', hint: 'Moonshot 开放平台，OpenAI 兼容接口', modelHint: '如 kimi-k2-0905-preview，可换当前模型', keyHint: 'sk-...' },
  glm: { name: 'GLM', endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', hint: '智谱开放平台，OpenAI 兼容接口', modelHint: '如 glm-4-plus，可换当前模型', keyHint: 'API Key' },
  custom: { name: '自定义兼容接口', endpoint: '', model: '', hint: '任意 OpenAI 兼容 /chat/completions 接口', modelHint: '填写服务商提供的模型名', keyHint: 'API Key' }
};
const STUDY_DEFAULTS = { provider: 'openai', endpoint: 'https://api.openai.com/v1', key: '', model: 'gpt-4o-mini', target: 'zh-CN' };
let STUDY = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(STUDY_KEY) || 'null');
    if (saved && typeof saved === 'object') return Object.assign({}, STUDY_DEFAULTS, saved);
  } catch (e) {}
  return Object.assign({}, STUDY_DEFAULTS);
})();
if (!STUDY.provider || !STUDY_PROVIDERS[STUDY.provider]) STUDY.provider = 'openai';
let studyCache = (() => { try { return JSON.parse(localStorage.getItem(STUDY_CACHE_KEY) || '{}') || {}; } catch (e) { return {}; } })();
let studyVocab = (() => { try { const v = JSON.parse(localStorage.getItem(STUDY_VOCAB_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } })();
let studyStatus = (() => { try { const v = JSON.parse(localStorage.getItem(STUDY_STATUS_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; } })();
let studyView = 'card', studyRenderedVocab = [];
let studyTermData = new Map(), studyTermPinned = false, studyTermFocusKeys = new Set();
let studyTranscriptTermData = new Map();
let studyReviewRevealed = false, studyHideZh = false, studyAutoPause = false;
let studyExercise = null, studyLoop = null, studyAutoPauseDone = -1, studyVocabContext = null, studyVocabContextMode = null;
let pendingStudyEpisode = '';
studyVocab.forEach(v => {
  if (!v.status) v.status = 'learning';
  if (!Number.isFinite(Number(v.ease))) v.ease = 2.5;
  if (!Number.isFinite(Number(v.interval))) v.interval = 0;
  if (!Number.isFinite(Number(v.reps))) v.reps = 0;
  if (!Number.isFinite(Number(v.lapses))) v.lapses = 0;
  if (!Number.isFinite(Number(v.due))) v.due = Date.now();
  const k = cleanWord(v.word);
  if (k && !studyStatus[k]) studyStatus[k] = v.status;
});

function saveStudy() { try { localStorage.setItem(STUDY_KEY, JSON.stringify(STUDY)); } catch (e) {} }
function saveStudyCache() {
  try {
    const keys = Object.keys(studyCache);
    if (keys.length > 300) keys.slice(0, keys.length - 300).forEach(k => delete studyCache[k]);
    localStorage.setItem(STUDY_CACHE_KEY, JSON.stringify(studyCache));
  } catch (e) {}
}
function saveStudyVocab() { try { localStorage.setItem(STUDY_VOCAB_KEY, JSON.stringify(studyVocab)); } catch (e) {} }
function saveStudyStatus() { try { localStorage.setItem(STUDY_STATUS_KEY, JSON.stringify(studyStatus)); } catch (e) {} }
function studyWordStatusOf(raw) {
  const k = cleanWord(raw);
  return k ? (studyStatus[k] || '') : '';
}
function studyMarkWord(raw, status) {
  const k = cleanWord(raw);
  if (!k) return;
  if (status) studyStatus[k] = status; else delete studyStatus[k];
  saveStudyStatus();
  const item = studyVocab.find(v => cleanWord(v.word) === k);
  if (item) {
    item.status = status || 'learning';
    saveStudyVocab();
  }
  studyApplyWordMarks();
  studyUpdateDueBadge();
}
function wordStatusHTML(word) {
  const status = studyWordStatusOf(word);
  const inVocab = studyVocab.some(v => cleanWord(v.word) === cleanWord(word));
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
    studyAddVocab({ word, phonetic: $('wordPhon')?.textContent || '', meaning: wordCurrentMeaning || '', example: '', exampleZh: '' }, studyCurrentCue()?.cue || null);
    row.outerHTML = wordStatusHTML(word);
    bindWordStatusButtons(word);
  };
}
function studyTranscriptMarkData() {
  const map = new Map();
  const add = item => {
    const key = cleanWord(item?.word || '');
    if (key && !map.has(key)) map.set(key, item);
  };
  studyVocab.forEach(add);
  const cur = studyCurrentCue();
  if (cur) {
    const cached = studyCache[studyCurrentKey(cur)];
    if (cached && cached.data && Array.isArray(cached.data.vocabulary)) cached.data.vocabulary.forEach(add);
  }
  const epId = state.current?.id;
  if (epId) {
    const cached = studyCache['ep:' + epId];
    if (cached && cached.data && Array.isArray(cached.data.vocabulary)) cached.data.vocabulary.forEach(add);
    const partial = studyCache['ep:' + epId + ':partial'];
    if (partial && partial.data && Array.isArray(partial.data.vocabulary)) partial.data.vocabulary.forEach(add);
  }
  return map;
}
function studyApplyWordMarks() {
  if (!studyPluginOn()) return;
  if (!Array.isArray(state.nodes)) return;
  studyTranscriptTermData = studyTranscriptMarkData();
  const phraseItem = key => {
    const item = studyTranscriptTermData.get(key);
    return item && /\s/.test(String(item.word || '').trim()) ? item : null;
  };
  state.nodes.forEach(n => {
    if (!n || !n.words) return;
    n.words.forEach(w => {
      const key = cleanWord(w.textContent || '');
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
        const key = cleanWord(joined);
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
  const total = studyVocab.length;
  const known = studyVocab.filter(v => v.status === 'known').length;
  const due = studyDueItems().length;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const reviewed = studyVocab.filter(v => Number(v.lastReview || 0) >= today.getTime()).length;
  return { total, known, due, reviewed };
}
function studyCoverage() {
  const seen = new Set(), known = new Set();
  (state.cues || []).forEach(cue => {
    (cue.words || []).forEach(w => {
      const k = cleanWord(w.t);
      if (!k) return;
      seen.add(k);
      if (studyWordStatusOf(k) === 'known') known.add(k);
    });
  });
  return { total: seen.size, known: known.size, pct: seen.size ? Math.round(known.size / seen.size * 100) : 0 };
}
function studyCueContext(text, fallbackCue) {
  const t = String(text || '').trim().toLowerCase();
  const cues = state.cues || [];
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
    episodeId: state.current ? state.current.id : '',
    showSlug: state.show ? state.show.slug : '',
    showName: state.show ? (state.show.name || '') : '',
    episodeTitle: state.current ? (state.current.title || '') : '',
  };
}
function studyCueBounds(cue) {
  const s = Number.isFinite(Number(cue.speechStart)) ? Number(cue.speechStart) : Number(cue.start);
  const e = Number.isFinite(Number(cue.speechEnd)) ? Number(cue.speechEnd) : Number(cue.end);
  return { start: s + (state.offset || 0), end: Math.max(s + 0.4, e) + (state.offset || 0) };
}
function studyStopAudio() {
  studyLoop = null;
  if (!audio.paused) audio.pause();
}
function studyPlayRange(start, end, loops = 1) {
  const s = Number(start), e = Number(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) { showToast('这一句没有可用的音频时间。', 2200); return; }
  seekTo(s);
  studyAutoPauseDone = -1;
  studyLoop = { start: s, end: e, left: Math.max(1, loops) };
  audio.play().catch(() => {});
}
function studyPlayCue(cue, loops = 1) {
  const b = studyCueBounds(cue);
  studyPlayRange(b.start, b.end, loops);
}
function studyPlayItem(item) {
  if (item.episodeId && state.current && String(item.episodeId) !== String(state.current.id)) {
    showToast('这条来自另一集，切到该集后可以听原句。', 3200);
    return;
  }
  const s = Number(item.speechStart ?? item.start), e = Number(item.speechEnd ?? item.end);
  if (!Number.isFinite(s) || !Number.isFinite(e)) { showToast('这条还没有绑定原句音频。', 2400); return; }
  studyPlayRange(s + (state.offset || 0), e + (state.offset || 0), 1);
}
function studyAudioTick() {
  const t = audio.currentTime || 0;
  if (studyLoop) {
    if (t >= studyLoop.end - 0.06) {
      if (studyLoop.left > 1) {
        studyLoop.left -= 1;
        audio.currentTime = studyLoop.start;
        audio.play().catch(() => {});
      } else {
        studyLoop = null;
        studyAutoPauseDone = state.activeCue;
        audio.pause();
      }
    }
    return;
  }
  if (!studyAutoPause || audio.paused) return;
  const cur = studyCurrentCue();
  if (!cur) return;
  if (studyAutoPauseDone === cur.ci || studyAutoPauseDone === -2) return;
  const end = (Number.isFinite(Number(cur.cue.speechEnd)) ? Number(cur.cue.speechEnd) : Number(cur.cue.end)) + (state.offset || 0);
  if (t >= end - 0.1) {
    studyAutoPauseDone = cur.ci;
    audio.pause();
  }
}
function studyCsvCell(value) {
  const s = String(value == null ? '' : value);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function studyExportCsv() {
  if (!studyVocab.length) { showToast('生词本还是空的。', 2400); return; }
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
  showToast('已导出生词本 CSV。', 2400);
}
function studyLangName() {
  return STUDY.target === 'zh-TW' ? 'Traditional Chinese' : STUDY.target === 'en' ? 'English' : 'Simplified Chinese';
}
function studyHash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
function studyProviderMeta() {
  return STUDY_PROVIDERS[STUDY.provider] || STUDY_PROVIDERS.openai;
}
function studyConfig() {
  return { engine: STUDY.provider || 'openai', endpoint: STUDY.endpoint, key: STUDY.key, model: STUDY.model, target: STUDY.target };
}
function studyNative() { return !!(tauriHost() && tauriHost().core); }
function studyReady() {
  return studyNative() && !!String(STUDY.key || '').trim() && !!String(STUDY.model || '').trim() &&
    (STUDY.provider !== 'custom' || !!String(STUDY.endpoint || '').trim());
}
async function studyChat(system, user) {
  if (!studyNative()) throw new Error('AI 学英语需要在桌面版使用。');
  if (!studyReady()) throw new Error(STUDY.provider === 'custom' ? '请先在「设置 → AI 学英语」填写接口地址、API Key 和模型。' : '请先在「设置 → AI 学英语」填写 API Key 和模型。');
  const host = tauriHost();
  return await host.core.invoke('llm_chat', { req: { config: studyConfig(), system, user } });
}
function studyParseJson(text) {
  let s = String(text || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch (e) { return { raw: String(text || '').trim() }; }
}
function studyCurrentCue() {
  const cues = state.cues || [];
  if (!cues.length) return null;
  let ci = state.activeCue;
  if (ci < 0 || !cues[ci]) ci = 0;
  return { cue: cues[ci], ci };
}
/* 面板可能在文字稿还没到手时就被打开（S 快捷键尤其容易抢在 fetch 前面），
   原来会直接定格在「没有可用的文字稿」。这里等 cue 到齐后补渲一次，最多等 15 秒。 */
let studyCueWaitTimer = 0, studyCueWaitFn = null;
function studyWithCues(fn) {
  if ((state.cues || []).length) { fn(); return; }
  if (!state.current) return;
  studyCueWaitFn = fn;
  if (studyCueWaitTimer) return;
  studyCueWaitTimer = setInterval(() => {
    if (!(state.cues || []).length) return;
    clearInterval(studyCueWaitTimer);
    studyCueWaitTimer = 0;
    const fn2 = studyCueWaitFn;
    studyCueWaitFn = null;
    if (fn2) fn2();
  }, 700);
  setTimeout(() => {
    if (studyCueWaitTimer) { clearInterval(studyCueWaitTimer); studyCueWaitTimer = 0; studyCueWaitFn = null; }
  }, 15000);
}
function studyCurrentKey(cur) {
  const ep = state.current ? state.current.id : 'none';
  return ep + ':' + cur.ci + ':' + studyHash(cur.cue.text || '');
}
function studySourceLabel() {
  const show = state.show ? (state.show.name || state.show.slug) : '';
  const ep = state.current ? (state.current.title || '') : '';
  return [show, ep].filter(Boolean).join(' · ');
}
function studyEmpty(text) { return '<div class="study-empty">' + esc(text) + '</div>'; }
function studyLoading(text) {
  return '<div class="study-loading"><span class="loader"><span class="bars"><i></i><i></i><i></i></span></span><span>' + esc(text) + '</span></div>';
}
function studyLines(value) {
  return String(value || '').split(/\n+/).filter(Boolean).map(line => '<p>' + esc(line) + '</p>').join('');
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
  if (breakdown) html += '<div class="study-root-line"><span class="study-root-tag">词根</span><b>' + esc(breakdown) + '</b></div>';
  if (meaning) html += '<div class="study-root-line"><span class="study-root-tag">字面</span><span>' + esc(meaning) + '</span></div>';
  if (roots.length) html += '<div class="study-root-line"><span class="study-root-tag">同根</span><span>' +
    roots.map(x => esc(x.word) + (x.meaning ? '（' + esc(x.meaning) + '）' : '')).join(' · ') + '</span></div>';
  if (hook) html += '<div class="study-root-line"><span class="study-root-tag">记忆</span><span>' + esc(hook) + '</span></div>';
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
  if (!item) return esc(raw);
  const label = raw + (item.meaning ? '：' + String(item.meaning) : '');
  return '<span class="study-term" data-term="' + esc(key) + '" tabindex="0" aria-label="' + esc(label) + '">' + esc(raw) + '</span>';
}
function studyAnnotateText(value) {
  const raw = String(value == null ? '' : value);
  if (!raw) return '';
  if (!studyTermData.size) return esc(raw);
  const terms = [...studyTermData.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!terms.length) return esc(raw);
  let matcher;
  try {
    matcher = new RegExp('(?<![A-Za-z])(' + terms.map(studyRegexEscape).join('|') + ')(?![A-Za-z])', 'gi');
  } catch (e) {
    return esc(raw);
  }
  let html = '', last = 0;
  raw.replace(matcher, (match, word, offset) => {
    const key = String(match).toLowerCase();
    const item = studyTermData.get(key);
    if (!item) return match;
    html += esc(raw.slice(last, offset));
    const focus = !studyTermFocusKeys.has(key);
    if (focus) studyTermFocusKeys.add(key);
    const label = String(item.word || match) + (item.meaning ? '：' + String(item.meaning) : '');
    html += '<span class="study-term" data-term="' + esc(key) + '"' +
      (focus ? ' tabindex="0"' : '') + ' aria-label="' + esc(label) + '">' + esc(match) + '</span>';
    last = offset + String(match).length;
    return match;
  });
  return html + esc(raw.slice(last));
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
  return '<div class="tt-head"><b>' + esc(word) + '</b>' +
    (item.phonetic ? '<em>' + esc(item.phonetic) + '</em>' : '') + '</div>' +
    '<div class="tt-meaning">' + esc(item.meaning || '暂无释义') + '</div>' +
    (item.example ? '<div class="tt-example"><b>例</b> ' + esc(item.example) +
      (item.exampleZh ? '<br>' + esc(item.exampleZh) : '') + '</div>' : '') +
    studyRootHTML(item);
}
function studyShowTermTip(term, itemOverride) {
  if (!term) return;
  const key = term.dataset.term || cleanWord(term.textContent || '');
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
  const key = term.dataset.term || cleanWord(term.textContent || '');
  return studyTermData.get(key) || studyTranscriptTermData.get(key);
}
function bindStudyTermTips() {
  if (app.studyTermTipsBound) return;
  app.studyTermTipsBound = true;
  document.addEventListener('mouseover', event => {
    const term = studyHoverTerm(event.target);
    const item = studyTermItemOf(term);
    if (!term || !item || term.contains(event.relatedTarget)) return;
    term.classList.add('on');
    studyShowTermTip(term, item);
  });
  document.addEventListener('mouseout', event => {
    const term = studyHoverTerm(event.target);
    if (!term || term.contains(event.relatedTarget) || studyTermPinned) return;
    term.classList.remove('on');
    studyHideTermTip();
  });
  document.addEventListener('focusin', event => {
    const term = studyHoverTerm(event.target);
    const item = studyTermItemOf(term);
    if (term && item) { term.classList.add('on'); studyShowTermTip(term, item); }
  });
  document.addEventListener('focusout', event => {
    if (studyTermPinned) return;
    if (studyHoverTerm(event.target)) studyHideTermTip();
  });
  document.addEventListener('click', event => {
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
  }, true);
  document.addEventListener('scroll', () => {
    studyTermPinned = false;
    studyHideTermTip();
  }, true);
}
function studyVocabCards(items, addable) {
  studyRenderedVocab = addable ? (items || []) : [];
  return (items || []).map((v, i) => {
    const word = String(v.word || '').trim();
    if (!word) return '';
    const inVocab = studyVocab.some(x => cleanWord(x.word) === cleanWord(word));
    return '<div class="study-vocab"><strong>' + studyTermChipHTML(word) + '</strong>' +
      (v.phonetic ? '<em>' + esc(v.phonetic) + '</em>' : '') +
      '<small>' + esc(v.meaning || '') + '</small>' +
      (v.example ? '<small><b>例：</b>' + esc(v.example) + (v.exampleZh ? '<br>' + esc(v.exampleZh) : '') + '</small>' : '') +
      studyRootHTML(v) +
      (addable ? (inVocab ? '<span class="study-badge">已在生词本</span>' :
        '<button class="btn ghost small vocab-add" data-study-add="' + i + '">＋ 生词本（含原句音频）</button>') : '') +
      '</div>';
  }).join('');
}
function studyCardHTML(data) {
  if (!data) return '';
  studySetVocabulary(data.vocabulary);
  if (data.raw) return '<div class="study-section"><h4>模型原文</h4><p>' + esc(data.raw).replace(/\n/g, '<br>') + '</p></div>';
  let html = '';
  if (data.translation) html += '<div class="study-section"><h4>参考译文</h4>' + studyAnnotatedLines(data.translation) + '</div>';
  if (data.literal && data.literal !== data.translation) html += '<div class="study-section"><h4>直译</h4>' + studyAnnotatedLines(data.literal) + '</div>';
  if (data.explanation) html += '<div class="study-section"><h4>这句话在说什么</h4>' + studyAnnotatedLines(data.explanation) + '</div>';
  if (data.paraphrase) html += '<div class="study-section"><h4>换一种说法</h4>' + studyAnnotatedLines(data.paraphrase) + '</div>';
  if (Array.isArray(data.grammar) && data.grammar.length) {
    html += '<div class="study-section"><h4>语法点</h4>' + data.grammar.map(g =>
      '<p><b>' + esc(g.point || '') + '</b>　' + studyAnnotateText(g.detail || '') + '</p>').join('') + '</div>';
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
    const when = Number.isFinite(start) ? fmt(start) : '';
    return '<div class="study-topic">' +
      (when ? '<button class="btn ghost small" data-study-act="topic" data-study-t="' + Math.round(start) + '">▶ ' + esc(when) + '</button>' : '') +
      '<div><strong>' + studyAnnotateText(title || '未命名主题') + '</strong>' +
      (topic.summary ? '<p>' + studyAnnotateText(topic.summary) + '</p>' : '') + '</div></div>';
  }).join('') + '</div>';
}
function studyAdHTML(data) {
  const ads = studyAdRangesFromData(data);
  if (!ads.length) return '';
  return '<div class="study-section"><h4>广告点</h4>' + ads.map(ad => {
    return '<div class="study-topic study-ad">' +
      '<button class="btn ghost small" data-study-act="ad" data-study-t="' + Math.round(ad.end) + '">跳过</button>' +
      '<div><strong>' + esc(ad.label || '广告') + '</strong><p>' + esc(fmt(ad.start)) + ' – ' + esc(fmt(ad.end)) + '</p></div></div>';
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
      '<div class="study-vocab"><strong>' + studyAnnotateText(x.en || '') + '</strong><small>' + esc(x.zh || '') +
      (x.why ? '<br><b>难点：</b>' + studyAnnotateText(x.why) : '') + '</small></div>').join('') + '</div>';
  }
  if (Array.isArray(data.questions) && data.questions.length) {
    html += '<div class="study-section"><h4>可以想一下</h4>' + data.questions.map(x => '<p>· ' + studyAnnotateText(x) + '</p>').join('') + '</div>';
  }
  if (Array.isArray(data.vocabulary) && data.vocabulary.length) {
    html += '<div class="study-section"><h4>词汇与表达</h4>' + studyVocabCards(data.vocabulary, true) + '</div>';
  }
  return html;
}
function applyStudyProvider(id, fillDefaults) {
  const meta = STUDY_PROVIDERS[id];
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
  if (!subtitlePluginOn()) { showToast('字幕插件未启用，AI 学英语不可用。', 'warn'); return; }
  if (!studyPluginOn()) { showToast('学英语插件未启用。', 'warn'); return; }
  if (!moduleOn('study')) return;
  const sheet = $('studySheet');
  if (!sheet) return;
  closeDockSheet(false);
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
  if (now) now.textContent = cur ? fmt(cur.cue.start + state.offset) + ' · ' + String(cur.cue.text || '').slice(0, 34) : '—';
  studyUpdateDueBadge();
}
function studyRenderCurrent() {
  const body = $('studyBody');
  if (!body) return;
  const cur = studyCurrentCue();
  studyRenderNow();
  if (!cur) {
    body.innerHTML = studyEmpty(state.current ? '字幕加载中…' : '这一集没有可用的文字稿。');
    if (state.current) studyWithCues(() => { if (studyView === 'card') studyRenderCurrent(); });
    return;
  }
  const key = studyCurrentKey(cur);
  const cached = studyCache[key];
  studyVocabContext = cur.cue; studyVocabContextMode = 'card';
  let html = '<p class="study-cue">' + esc(cur.cue.text || '') + '</p>';
  if (cur.cue.zh && !studyHideZh) html += '<p class="study-empty">' + esc(cur.cue.zh) + '</p>';
  html += '<div class="study-actions">' +
    '<button class="btn ghost small" data-study-act="playCue">▶ 听本句</button>' +
    '<button class="btn ghost small" data-study-act="loopCue">循环 3 次</button>' +
    '<button class="study-toggle" data-study-act="autoPause" aria-pressed="' + String(studyAutoPause) + '">自动暂停</button>' +
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
  if (!state.current) { body.innerHTML = studyEmpty('先选择一集。'); return; }
  studyVocabContext = null; studyVocabContextMode = 'episode';
  const key = 'ep:' + state.current.id;
  const cached = studyCache[key];
  const chapters = studyChapterEntry();
  const quotes = studyQuoteEntry();
  let html = '<p class="study-empty">' + esc(state.current.title || '当前单集') + '</p>';
  html += '<div class="study-actions"><button class="btn primary small" data-study-act="episode">' +
    (cached ? '重新总结整集' : '总结整集') + '</button>' +
    '<button class="btn ghost small" data-study-act="chapters">' + (chapters ? '重新生成章节' : '生成章节') + '</button>' +
    '<button class="btn ghost small" data-study-act="quotes">' + (quotes ? '重新挑金句' : '挑金句') + '</button>' +
    (cached && cached.data ? '<button class="btn ghost small" data-study-act="copyEpisode">复制总结</button>' : '') +
    '<span class="study-badge">' + (cached ? '已缓存' : '按段分块请求') + '</span></div>';
  html += studyChaptersHTML(chapters && chapters.data);
  if (cached && cached.data) {
    studyApplyAiAdRanges(cached.data, state.current.id);
    html += studyEpisodeHTML(cached.data);
    if (cached.data.version !== 3) html += '<p class="study-empty">旧版缓存没有广告点，点「重新总结整集」生成。</p>';
  } else {
    html += '<p class="study-empty">整集会按文字稿分成 3 块分析；每块单独请求，并生成主题时间戳。中途失败只重试失败的块。章节和金句都按文字稿行号映射时间，不会让模型自己编时间戳。</p>';
  }
  html += studyQuotesHTML(quotes && quotes.data);
  body.innerHTML = html;
  bindStudyActButtons();
  studyApplyWordMarks();
}
function studyRenderVocab() {
  const body = $('studyBody');
  if (!body) return;
  studyVocabContext = null; studyVocabContextMode = null;
  studyRenderNow();
  if (!studyVocab.length) { body.innerHTML = studyEmpty('生词本还是空的。在句子卡片里点「＋ 生词本」就会收进来。'); return; }
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
        (v.phonetic ? '<em>' + esc(v.phonetic) + '</em>' : '') +
        '<span class="study-badge">' + status + '</span>' +
        '<small>' + esc(v.meaning || '') + '</small>' +
        (v.example ? '<small><b>例：</b>' + esc(v.example) + (v.exampleZh ? '<br>' + esc(v.exampleZh) : '') + '</small>' : '') +
        studyRootHTML(v) +
        (v.source ? '<small>' + esc(v.source) + '</small>' : '') +
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
      (next ? '下一次复习：' + studyDueLabel(next.due) + '（' + esc(next.word) + '）' : '还没有排期的词条。') +
      '</p></div>';
    return;
  }
  const v = due[0];
  const source = [v.source, v.example ? '原句：' + v.example : ''].filter(Boolean).join('\n');
  let html = head + '<div class="study-review-word">' + esc(v.word) + '</div>' +
    (v.phonetic ? '<div class="study-review-meta">' + esc(v.phonetic) + '</div>' : '') +
    '<div class="study-actions">' +
    (Number.isFinite(Number(v.start)) ? '<button class="btn ghost small" data-study-act="playReview">▶ 听原句</button>' : '') +
    '<button class="btn primary small" data-study-act="reveal">显示答案</button></div>';
  if (studyReviewRevealed) {
    html += '<div class="study-answer"><strong>' + esc(v.meaning || '（没有释义）') + '</strong>' +
      (v.example ? '<div style="margin-top:6px">' + esc(v.example) + '</div>' : '') +
      (v.exampleZh ? '<div class="study-empty">' + esc(v.exampleZh) + '</div>' : '') +
      studyRootHTML(v) +
      (v.source ? '<div class="study-review-meta" style="margin-top:6px">' + esc(v.source) + '</div>' : '') + '</div>' +
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
    body.innerHTML = studyEmpty(state.current ? '字幕加载中…' : '这一集没有可用的文字稿。');
    if (state.current) studyWithCues(() => { if (studyView === 'practice') studyRenderPractice(); });
    return;
  }
  if (!studyExercise || studyExercise.key !== studyCurrentKey(cur)) {
    body.innerHTML = '<div class="study-actions"><button class="btn primary small" data-study-ex="cloze">填空练习</button>' +
      '<button class="btn ghost small" data-study-ex="dictation">听写练习</button></div>' +
      '<p class="study-empty">填空：挖掉原句里最有信息量的词。听写：先听原句，再写下你听到的内容。两者都不调用 LLM。</p>';
    bindStudyActButtons();
    return;
  }
  const ex = studyExercise;
  let html = '<div class="study-actions"><button class="study-toggle" data-study-ex="cloze" aria-pressed="' + String(ex.type === 'cloze') + '">填空</button>' +
    '<button class="study-toggle" data-study-ex="dictation" aria-pressed="' + String(ex.type === 'dictation') + '">听写</button>' +
    '<button class="btn ghost small" data-study-act="playEx">▶ 听本句</button>' +
    '<button class="btn ghost small" data-study-act="nextEx">换一句</button></div>';
  if (ex.type === 'cloze') {
    html += '<p class="study-cue">' + esc(ex.sentence) + '</p>';
  } else {
    html += '<p class="study-empty">听原句，然后写下你听到的完整句子。可以重复听。</p>';
  }
  html += '<input class="study-input" id="studyPracticeInput" autocomplete="off" spellcheck="false" placeholder="' +
    (ex.type === 'cloze' ? '填入被挖掉的词' : '写下你听到的句子') + '" value="' + esc(ex.input || '') + '">';
  html += '<div class="study-actions"><button class="btn primary small" data-study-act="checkEx">检查答案</button>' +
    '<button class="btn ghost small" data-study-act="showEx">显示答案</button></div>';
  if (ex.checked) {
    html += '<div class="study-answer"><div class="' + (ex.correct ? 'study-ok' : 'study-bad') + '">' +
      (ex.correct ? '✓ 正确' : (ex.type === 'dictation' ? '正确率约 ' + ex.pct + '%' : '再试一次')) + '</div>' +
      '<div style="margin-top:6px">答案：' + esc(ex.answer) + '</div></div>';
  }
  body.innerHTML = html;
  const input = $('studyPracticeInput');
  if (input) {
    input.oninput = () => { if (studyExercise) studyExercise.input = input.value; };
    input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); studyCheckExercise(); } };
    input.focus();
  }
  bindStudyActButtons();
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
    if (body) body.innerHTML = '<div class="study-section"><h4>答案</h4><p>' + esc(ex.answer) + '</p>' +
      '<button class="btn ghost small" data-study-act="backEx">继续练习</button></div>';
    bindStudyActButtons();
    return;
  }
  if (ex.type === 'cloze') {
    ex.correct = studyNormText(ex.input).replace(/\s+/g, '') === studyNormText(ex.target).replace(/\s+/g, '');
    ex.pct = ex.correct ? 100 : 0;
    if (!ex.correct) studyMarkWord(ex.target, 'learning');
  } else {
    const a = studyNormText(ex.input).split(' ').filter(Boolean);
    const b = studyNormText(ex.answer).split(' ').filter(Boolean);
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
    showToast('生词本里已经有「' + word + '」了。', 2500);
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
  showToast('已加入生词本：' + word + '（已排入复习）', 3000);
}
async function studyAnalyzeCurrent() {
  const cur = studyCurrentCue();
  if (!cur) return;
  const body = $('studyBody');
  const key = studyCurrentKey(cur);
  if (!studyReady()) { body.innerHTML = studyEmpty('请先在「设置 → AI 学英语」填写 API Key 和模型。'); return; }
  body.innerHTML = studyLoading('正在分析当前句…');
  const prev = state.cues[cur.ci - 1]?.text || '';
  const next = state.cues[cur.ci + 1]?.text || '';
  const system = 'You are an English-learning coach for Chinese learners. Explain the target sentence accurately and ' +
    'concisely in ' + studyLangName() + '. Return ONLY a JSON object, no markdown fences, with keys: ' +
    'translation (string), literal (string, word-for-word if useful), explanation (string), ' +
    'grammar (array of {point, detail}), vocabulary (array of {word, phonetic, meaning, example, exampleZh, rootBreakdown, rootMeaning, sameRootWords, memoryHook}), ' +
    'paraphrase (string). For vocabulary, add root analysis only when the word is morphologically transparent: ' +
    'rootBreakdown = prefix + root + suffix with hyphens and Chinese gloss; rootMeaning = literal meaning; ' +
    'sameRootWords = array of up to 2 real English words {word, meaning} sharing the same root; memoryHook = one short Chinese memory sentence. ' +
    'Never invent roots or etymology; leave these fields empty when unsure. Keep vocabulary to at most 6 useful items. ' +
    'Do not invent facts about the episode.';
  const user = JSON.stringify({ target: cur.cue.text, previous: prev, next, show: state.show?.name || '', episode: state.current?.title || '' });
  try {
    const out = await studyChat(system, user);
    const data = studyParseJson(out);
    studyCache[key] = { at: Date.now(), data };
    saveStudyCache();
    studyRenderCurrent();
  } catch (err) {
    body.innerHTML = '<div class="study-section"><h4>分析失败</h4><p>' + esc(err.message || err) + '</p>' +
      '<button class="btn ghost small" data-study-act="current">重试</button></div>';
    bindStudyActButtons();
  }
}
async function studyAnalyzeEpisode() {
  const body = $('studyBody');
  if (!state.current) return;
  if (!studyReady()) { body.innerHTML = studyEmpty('请先在「设置 → AI 学英语」填写 API Key 和模型。'); return; }
  const cues = state.cues || [];
  if (!cues.length) { body.innerHTML = studyEmpty('这一集没有文字稿，无法分析整集。'); return; }
  const lines = cues.map(cue => '[' + fmt(cue.start + state.offset) + '] ' + (cue.text || ''));
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
  const epKey = 'ep:' + state.current.id;
  const epId = state.current.id;
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
      if (Array.isArray(data.ads)) merged.ads = sanitizeAdRanges(data.ads, 'ai');
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
        const ad = sanitizeAdRanges([rawAd], 'ai')[0];
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
    merged.ads = sanitizeAdRanges(mergeAdRanges([merged.ads]), 'ai').slice(0, 24);
    merged.vocabulary = merged.vocabulary.slice(0, 30);
    merged.hardSentences = merged.hardSentences.slice(0, 20);
    studyCache[epKey] = { at: Date.now(), data: merged };
    delete studyCache[partialKey];
    saveStudyCache();
    studyApplyAiAdRanges(merged, epId);
    studyRenderEpisode();
  } catch (err) {
    const failed = Math.min(completed + 1, totalChunks);
    const kept = completed ? '已保留前 ' + completed + ' / ' + totalChunks + ' 块。' : '';
    body.innerHTML = '<div class="study-section"><h4>分析失败</h4><p>第 ' + failed + ' / ' + totalChunks + ' 块失败。' + kept +
      (completed < totalChunks ? ' 点「继续剩余块」只重试第 ' + (completed + 1) + ' 块。' : '') +
      '</p><p class="smalltext">' + esc(err.message || err) + '</p><div class="study-actions">' +
      '<button class="btn ghost small" data-study-act="episode">' + (completed ? '继续剩余块' : '重试') + '</button>' +
      (completed ? '<button class="btn ghost small" data-study-act="episodeFresh">从头开始</button>' : '') +
      '</div></div>';
    bindStudyActButtons();
  }
}
function studyRestartEpisodeSummary() {
  if (!state.current) return;
  delete studyCache['ep:' + state.current.id + ':partial'];
  saveStudyCache();
  studyAnalyzeEpisode();
}
function studyEpisodeText(data) {
  if (!data) return '';
  const title = state.current?.title || '当前单集';
  const lines = ['# ' + title, '', '## 内容摘要', String(data.summary || '').trim()].filter(Boolean);
  const ads = studyAdRangesFromData(data);
  if (ads.length) {
    lines.push('', '## 广告点');
    ads.forEach(ad => {
      lines.push('- ' + fmt(ad.start) + '–' + fmt(ad.end) + ' ' + String(ad.label || '广告').trim());
    });
  }
  if (Array.isArray(data.topics) && data.topics.length) {
    lines.push('', '## 主题时间戳');
    data.topics.forEach(topic => {
      const start = studyClockSeconds(topic.start);
      const when = Number.isFinite(start) ? fmt(start) : '';
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
  return fmt(Number(cue && cue.start || 0) + Number(state.offset || 0));
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
  const cues = state.cues || [];
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
  const cues = state.cues || [];
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
  const cues = state.cues || [];
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
  if (message.role === 'user') return '<div class="study-ask-msg user">' + esc(message.text) + '</div>';
  const chips = (Array.isArray(message.cites) ? message.cites : []).map(index => {
    const cue = (state.cues || [])[index];
    if (!cue) return '';
    return '<button class="btn ghost small" data-study-act="askCite" data-cue="' + index + '">▶ ' +
      esc(studyCueStamp(cue)) + '</button>';
  }).join('');
  return '<div class="study-ask-msg bot' + (message.error ? ' bad' : '') + '">' +
    (message.error ? '<p>' + esc(message.text) + '</p>' : studyAnnotatedLines(message.text || '')) +
    (chips ? '<div class="ask-src">' + chips + '</div>' : '') +
    '</div>';
}
function studyRenderAsk(busy) {
  const body = $('studyBody');
  if (!body) return;
  studyRenderNow();
  studyVocabContext = null; studyVocabContextMode = null;
  const epId = state.current ? state.current.id : '';
  if (!epId) { body.innerHTML = studyEmpty('先选择一集。'); return; }
  const thread = studyAskThread(epId);
  let html = '<p class="study-empty">问这一集的内容。答案只依据本集文字稿，引用按钮直接跳到原句；文字稿里没有的内容它会直说不知道。</p>';
  if (!thread.messages.length) {
    html += '<div class="study-actions">' + studyAskSuggestions().map(question =>
      '<button class="btn ghost small" data-study-act="askAsk" data-study-q="' + esc(question) + '">' +
      esc(question.length > 20 ? question.slice(0, 20) + '…' : question) + '</button>').join('') + '</div>';
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
  const epId = state.current ? state.current.id : '';
  if (!epId) return;
  if (!(state.cues || []).length) { if (body) body.innerHTML = studyEmpty('这一集没有文字稿，无法问答。'); return; }
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
      show: state.show ? state.show.name : '',
      episode: state.current ? state.current.title : '',
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
  const epId = state.current ? state.current.id : '';
  const entry = epId ? studyCache['ch:' + epId] : null;
  return entry && entry.data && Array.isArray(entry.data.chapters) ? entry : null;
}
function studyChaptersHTML(data) {
  const chapters = Array.isArray(data && data.chapters) ? data.chapters : [];
  if (!chapters.length) return '';
  const rows = chapters.map((chapter, index) => {
    if (!chapter || typeof chapter !== 'object') return '';
    const ci = Number(chapter.ci);
    const cues = state.cues || [];
    const cue = Number.isInteger(ci) && ci >= 0 && ci < cues.length ? cues[ci] : null;
    const start = cue ? Number(cue.start) : Number(chapter.start);
    const title = String(chapter.title || '').trim();
    if (!title && !Number.isFinite(start)) return '';
    const when = Number.isFinite(start) ? fmt(start + (Number(state.offset) || 0)) : '';
    return '<div class="study-topic study-chapter">' +
      (Number.isFinite(start)
        ? '<button class="btn ghost small" data-study-act="topic" data-study-t="' + Math.round(start) + '">▶ ' + esc(when) + '</button>'
        : '<span class="study-chapter-no">' + (index + 1) + '</span>') +
      '<div><strong>' + studyAnnotateText(title || '未命名章节') + '</strong>' +
      (chapter.summary ? '<p>' + studyAnnotateText(chapter.summary) + '</p>' : '') + '</div></div>';
  }).join('');
  if (!rows) return '';
  return '<div class="study-section"><h4>章节</h4>' + rows + '</div>';
}
async function studyAnalyzeChapters() {
  const body = $('studyBody');
  if (!state.current) return;
  const epId = state.current.id;
  const cues = state.cues || [];
  if (!cues.length) { showToast('这一集没有文字稿，无法生成章节。', 5000); return; }
  if (!studyReady()) { showToast('请先在「设置 → AI 学英语」填写 API Key 和模型。', 6000); return; }
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
    showToast('已生成 ' + chapters.length + ' 个章节。', 3000);
  } catch (err) {
    if (studyView === 'episode') studyRenderEpisode();
    showToast('章节生成失败：' + String(err && err.message ? err.message : err), 7000);
  }
}
/* ---- 金句卡片：挑句子用行号，卡片在本地画，不依赖模型出图 ---- */
function studyQuoteEntry() {
  const epId = state.current ? state.current.id : '';
  const entry = epId ? studyCache['q:' + epId] : null;
  return entry && entry.data && Array.isArray(entry.data.quotes) ? entry : null;
}
function studyQuotesHTML(data) {
  const quotes = Array.isArray(data && data.quotes) ? data.quotes : [];
  if (!quotes.length) return '';
  const cues = state.cues || [];
  const rows = quotes.map(quote => {
    if (!quote || typeof quote !== 'object') return '';
    const ci = Number(quote.ci);
    if (!Number.isInteger(ci) || ci < 0 || ci >= cues.length) return '';
    const cue = cues[ci];
    return '<div class="study-quote">' +
      '<p class="study-quote-en">' + esc(cue.text || '') + '</p>' +
      (cue.zh ? '<p class="study-quote-zh">' + esc(cue.zh) + '</p>' : '') +
      (quote.reason ? '<small>' + studyAnnotateText(quote.reason) + '</small>' : '') +
      '<div class="study-actions">' +
      '<button class="btn ghost small" data-study-act="topic" data-study-t="' + Math.round(Number(cue.start) || 0) + '">▶ ' + esc(studyCueStamp(cue)) + '</button>' +
      '<button class="btn ghost small" data-study-act="quoteCard" data-cue="' + ci + '">生成卡片</button>' +
      '</div></div>';
  }).join('');
  if (!rows) return '';
  return '<div class="study-section"><h4>金句卡片</h4>' + rows + '</div>';
}
async function studyAnalyzeQuotes() {
  const body = $('studyBody');
  if (!state.current) return;
  const epId = state.current.id;
  const cues = state.cues || [];
  if (!cues.length) { showToast('这一集没有文字稿。', 5000); return; }
  if (!studyReady()) { showToast('请先在「设置 → AI 学英语」填写 API Key 和模型。', 6000); return; }
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
    showToast('已挑出 ' + quotes.length + ' 句金句。', 3000);
  } catch (err) {
    if (studyView === 'episode') studyRenderEpisode();
    showToast('金句生成失败：' + String(err && err.message ? err.message : err), 7000);
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
  if (!studyPluginOn()) return;
  const ci = Number(rawCue);
  const cue = (state.cues || [])[ci];
  if (!cue) { showToast('这一句不在当前文字稿里。', 4000); return; }
  const W = 1080, H = 1350;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) { showToast('卡片生成失败。', 4000); return; }
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
  studyWrapCanvasText(ctx, state.current ? state.current.title : '', 900, 2)
    .forEach(line => { ctx.fillText(line, 84, ty); ty += 38; });
  ctx.fillStyle = '#7d8b9d';
  ctx.font = '400 24px "Noto Sans SC",system-ui,sans-serif';
  ctx.fillText((state.show ? state.show.name : 'MyTranscript').slice(0, 34), 84, H - 62);
  canvas.toBlob(blob => {
    if (!blob) { showToast('卡片生成失败。', 4000); return; }
    studyCloseQuoteCard();
    studyQuoteUrl = URL.createObjectURL(blob);
    const wrap = document.createElement('div');
    wrap.className = 'quote-card-wrap';
    wrap.id = 'quoteCardWrap';
    wrap.innerHTML = '<div class="quote-card" role="dialog" aria-label="金句卡片">' +
      '<header><span>分享</span><b>' + esc(studyCueStamp(cue)) + ' · ' + esc((state.show ? state.show.name : '') || '') + '</b>' +
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
      showToast('金句卡片已保存。', 3000);
    };
    wrap.querySelector('[data-quote-copy]').onclick = async () => {
      const text = [cue.text, cue.zh, '— ' + [(state.show ? state.show.name : ''), (state.current ? state.current.title : ''), studyCueStamp(cue)].filter(Boolean).join(' · ')]
        .filter(Boolean).join('\n');
      if (await copyPlain(text)) showToast('已复制卡片文字。', 3000);
      else showToast('复制失败，请手动选择文本。', 4000);
    };
    studyQuoteEsc = event => { if (event.key === 'Escape') studyCloseQuoteCard(); };
    document.addEventListener('keydown', studyQuoteEsc);
  }, 'image/png');
}
async function studyCopyEpisode() {
  const key = state.current ? 'ep:' + state.current.id : '';
  const data = key ? studyCache[key]?.data : null;
  if (!data) { showToast('还没有整集总结。', 3000); return; }
  const text = studyEpisodeText(data);
  if (!text) { showToast('总结为空。', 3000); return; }
  if (await copyPlain(text)) showToast('已复制整集总结。', 3000);
  else showToast('复制失败，请手动选择文本。', 4000);
}
function studyOpenEpisodeSummary(key, epId) {
  if (!studyPluginOn()) { showToast('学英语插件未启用。', 'warn'); return; }
  const show = showByKey(key);
  const ep = show ? episodesOf(show).find(item => item.id === epId) : null;
  if (!show || !ep) { showToast('找不到这一集。', 5000); return; }
  if (!moduleOn('study')) { showToast('AI 学英语模块已关闭。', 5000); return; }
  if (!ep.transcript?.url) { showToast('这一集没有文字稿，无法总结。', 5000); return; }
  if (!studyReady()) {
    showToast('请先在「设置 → AI 学英语」填写 API Key 和模型。', 8000);
    navigate('settings');
    return;
  }
  pendingStudyEpisode = epId;
  app.autoplay = false;
  navigate('player', [key, epId]);
  waitStudyEpisodeSummary(epId, 0);
}
function waitStudyEpisodeSummary(epId, tries) {
  if (pendingStudyEpisode !== epId) return;
  if (state.current?.id === epId && (state.cues || []).length) {
    pendingStudyEpisode = '';
    openStudySheet('episode');
    if (studyCache['ep:' + epId]?.data?.version !== 3) studyAnalyzeEpisode();
    return;
  }
  if (tries < 80) { setTimeout(() => waitStudyEpisodeSummary(epId, tries + 1), 250); return; }
  pendingStudyEpisode = '';
  showToast('文字稿还没准备好，请打开播放页后再试。', 6000);
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
        if (Number.isFinite(t) && t >= 0) seekTo(t);
      }
      else if (act === 'playCue') { const cur = studyCurrentCue(); if (cur) studyPlayCue(cur.cue, 1); }
      else if (act === 'loopCue') { const cur = studyCurrentCue(); if (cur) studyPlayCue(cur.cue, 3); }
      else if (act === 'autoPause') { studyAutoPause = !studyAutoPause; studyAutoPauseDone = -1; studyRenderCurrent(); }
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
        if (cur && state.cues[cur.ci + 1]) {
          studyExercise = null;
          seekTo(state.cues[cur.ci + 1].start + state.offset);
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
        const cue = (state.cues || [])[Number(btn.dataset.cue)];
        if (cue) seekTo(Number(cue.start) || 0);
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
    return '<button type="button" class="study-model-item" role="option" data-model="' + esc(id) + '" aria-selected="' + (selected ? 'true' : 'false') + '">' +
      '<span>' + esc(name) + '</span>' + (name === id ? '' : '<span class="id">' + esc(id) + '</span>') + '</button>';
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
    const host = tauriHost();
    const list = await host.core.invoke('llm_models', { config: studyConfig() });
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
function bindStudyUI() {
  $('studyBtn').onclick = e => { e.stopPropagation(); openStudySheet(); };
  $('studyClose').onclick = closeStudySheet;
  document.querySelectorAll('[data-study-view]').forEach(btn => {
    btn.onclick = () => setStudyView(btn.dataset.studyView);
  });
  // 页签按 ARIA tabs 的惯例支持左右方向键与 Home/End，省得一个个 Tab 过去。
  const studyTabBar = $('studySheet')?.querySelector('.study-tabs');
  if (studyTabBar) {
    studyTabBar.addEventListener('keydown', ev => {
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
  if (provider) provider.addEventListener('change', () => applyStudyProvider(provider.value, true));
  const fields = [['studyEndpoint', 'endpoint'], ['studyKey', 'key'], ['studyModel', 'model'], ['studyTarget', 'target']];
  fields.forEach(([id, key]) => {
    const el = $(id); if (!el) return;
    el.addEventListener('change', () => {
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
  if (modelSearch) modelSearch.addEventListener('input', studyFilterModels);
  const modelClose = $('studyModelClose');
  if (modelClose) modelClose.onclick = () => { const picker = $('studyModelPicker'); if (picker) picker.hidden = true; };
  const modelList = $('studyModelList');
  if (modelList) modelList.addEventListener('click', e => {
    const btn = e.target.closest('.study-model-item');
    if (btn) studyPickModel(btn.dataset.model || '');
  });
  const modelInput = $('studyModel');
  if (modelInput) modelInput.addEventListener('focus', () => {
    const list = $('studyModelList');
    if (list && list.querySelectorAll('.study-model-item').length) studyOpenModels();
  });
  $('studyModelFetch').onclick = studyFetchModels;
  $('studyTestBtn').onclick = studyTestConnection;
  $('studyClearCache').onclick = () => {
    studyCache = {}; saveStudyCache();
    showToast('已清空 AI 学习缓存。', 3000);
    if ($('studySheet').classList.contains('on')) setStudyView(studyView);
  };
  $('studySheet').addEventListener('click', e => e.stopPropagation());
  if (!window.__studyAudioBound) {
    window.__studyAudioBound = true;
    audio.addEventListener('timeupdate', studyAudioTick);
    audio.addEventListener('play', () => {
      if (studyAutoPauseDone === state.activeCue) studyAutoPauseDone = -2;
    });
    audio.addEventListener('ended', () => { studyLoop = null; });
  }
  studyUpdateDueBadge();
  bindStudyActButtons();
  bindStudyTermTips();
}
function bindTranslateUI() {
  const on = $('trOn');
  if (on) on.onclick = () => {
    TR.on = !TR.on;
    trSave();
    // 开自动翻译时如果正文只显示英文，顺手切到双语，否则译完也看不见。
    if (TR.on && reader.lang === 'en') { reader.lang = 'both'; applyReader(); rebuildCues(); }
    syncTranslateSettings();
    trStatus(TR.on ? (trReady() ? '已开启，播放时自动翻译' : '还缺 API Key') : '未开启', TR.on && !trReady());
    if (TR.on && state.cues.length && state.activeCue >= 0) trPrimeCues(state.activeCue);
  };
  const engine = $('trEngine');
  if (engine) engine.onchange = () => { TR.engine = engine.value; trSave(); syncTranslateSettings(); };
  const target = $('trTarget');
  if (target) target.onchange = () => { TR.target = target.value; TR_CACHE.clear(); trSave(); };
  [['trEndpoint', 'endpoint'], ['trKey', 'key'], ['trRegion', 'region'], ['trModel', 'model']].forEach(([id, field]) => {
    const el = $(id);
    if (el) el.oninput = () => { TR[field] = el.value; trSave(); };
    if (el) el.onchange = () => syncTranslateSettings();
  });
  const test = $('trTest');
  if (test) test.onclick = async () => {
    if (!trNative()) { trStatus('自动翻译需要在桌面版使用', true); return; }
    test.disabled = true;
    trStatus('测试中…', false);
    try {
      const [out] = await trBatch(['Hello, this is a translation test.']);
      trStatus('译文：' + (out || ''), false);
    } catch (err) {
      trNoteError(err);
    } finally {
      test.disabled = false;
    }
  };
}
function syncThemeSwatches() {
  const current = document.documentElement.dataset.theme;
  themeBtns().forEach(button => button.setAttribute('aria-checked', String(button.dataset.theme === current)));
}
function renderSidebarSettings() {
  const hidden = new Set(prefs.sidebar?.hidden || []);
  const row = (route, group, index, total) => {
    const [icon, label] = SIDEBAR_META[route] || ['•', route];
    const checked = !hidden.has(route);
    return '<div class="setting-row sidebar-custom-row">' +
      '<div><strong><span class="sidebar-custom-ico">' + icon + '</span>' + esc(label) + '</strong>' +
      '<p>' + (checked ? '显示在侧边栏' : '已从侧边栏隐藏') + '</p></div>' +
      '<div class="sidebar-custom-actions">' +
      '<button class="btn ghost small" data-sidebar-move="up" data-sidebar-group="' + group + '" data-sidebar-route="' + route + '" aria-label="上移' + esc(label) + '"' + (index === 0 ? ' disabled' : '') + '>↑</button>' +
      '<button class="btn ghost small" data-sidebar-move="down" data-sidebar-group="' + group + '" data-sidebar-route="' + route + '" aria-label="下移' + esc(label) + '"' + (index === total - 1 ? ' disabled' : '') + '>↓</button>' +
      '<button class="switch" data-sidebar-toggle="' + route + '" role="switch" aria-checked="' + String(checked) + '"></button>' +
      '</div></div>';
  };
  const top = $('sidebarTopList');
  if (top) top.innerHTML = sidebarOrder('top').map((route, i, list) => row(route, 'top', i, list.length)).join('');
  const bottom = $('sidebarBottomList');
  if (bottom) bottom.innerHTML = sidebarOrder('bottom').map((route, i, list) => row(route, 'bottom', i, list.length)).join('');
  document.querySelectorAll('[data-sidebar-move]').forEach(btn => {
    btn.onclick = () => moveSidebarRoute(btn.dataset.sidebarRoute, btn.dataset.sidebarGroup, btn.dataset.sidebarMove === 'up' ? -1 : 1);
  });
  document.querySelectorAll('[data-sidebar-toggle]').forEach(btn => {
    btn.onclick = () => toggleSidebarRoute(btn.dataset.sidebarToggle);
  });
}
function moveSidebarRoute(route, group, delta) {
  if (!prefs.sidebar || !prefs.sidebar.order[group]) return;
  const order = [...prefs.sidebar.order[group]];
  const index = order.indexOf(route);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= order.length) return;
  [order[index], order[target]] = [order[target], order[index]];
  prefs.sidebar.order[group] = order;
  savePrefs();
  applySidebarCustomization();
  renderSidebarSettings();
}
function toggleSidebarRoute(route) {
  if (!prefs.sidebar) prefs.sidebar = normalizeSidebarPrefs(null);
  const hidden = new Set(prefs.sidebar.hidden);
  if (hidden.has(route)) hidden.delete(route); else hidden.add(route);
  prefs.sidebar.hidden = [...hidden];
  savePrefs();
  applySidebarCustomization();
  renderSidebarSettings();
}
function resetSidebarSettings() {
  prefs.sidebar = normalizeSidebarPrefs(null);
  savePrefs();
  applySidebarCustomization();
  renderSidebarSettings();
  showToast('侧边栏已恢复默认。');
}
function openSettingsPane(pane) {
  if (!subtitlePluginOn() && ['reader', 'study', 'models'].includes(pane)) pane = 'plugins';
  if (!studyPluginOn() && pane === 'study') pane = 'plugins';
  document.querySelectorAll('#settingsMenu button').forEach(button => button.classList.toggle('active', button.dataset.pane === pane));
  document.querySelectorAll('.settings-pane').forEach(el => el.classList.toggle('active', el.id === 'pane-' + pane));
  if (pane === 'sidebar') renderSidebarSettings();
  if (pane === 'models') { refreshAsrModels(); renderLocalAsrModelHint(); }
}

