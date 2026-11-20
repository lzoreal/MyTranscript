// 学英语的数据引擎：设置、缓存、生词本、词状态与 SRS 复习节奏都由插件持有。
// 宿主只保留渲染与播放控制；没有本引擎时宿主仍用本地回退（网页版/旧安装）。
const STUDY_ENGINE_SETTINGS_KEY = 'myt-study';
const STUDY_ENGINE_CACHE_KEY = 'myt-study-cache';
const STUDY_ENGINE_VOCAB_KEY = 'myt-study-vocab';
const STUDY_ENGINE_STATUS_KEY = 'myt-study-status';
// AI 服务商的地址/模型只在这里维护一份；运行时和渲染层都通过 engine.providers 读。
const STUDY_PROVIDERS = {
  openai: { name: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini', hint: 'OpenAI 官方或任意 OpenAI 兼容接口', modelHint: '建议用支持中文的通用模型，如 gpt-4o-mini', keyHint: 'sk-...' },
  claude: { name: 'Claude', endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-3-5-sonnet-latest', hint: 'Anthropic Messages API，Key 以 sk-ant- 开头', modelHint: '如 claude-3-5-sonnet-latest，可手动换成当前可用模型', keyHint: 'sk-ant-...' },
  gemini: { name: 'Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash', hint: 'Google Generative Language API，填 AI Studio 的 API Key', modelHint: '如 gemini-2.5-flash，可手动换模型', keyHint: 'AIza...' },
  deepseek: { name: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-chat', hint: 'OpenAI 兼容接口，适合长文总结', modelHint: '如 deepseek-chat', keyHint: 'sk-...' },
  kimi: { name: 'Kimi', endpoint: 'https://api.moonshot.cn/v1', model: 'kimi-k2-0905-preview', hint: 'Moonshot 开放平台，OpenAI 兼容接口', modelHint: '如 kimi-k2-0905-preview，可换当前模型', keyHint: 'sk-...' },
  glm: { name: 'GLM', endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', hint: '智谱开放平台，OpenAI 兼容接口', modelHint: '如 glm-4-plus，可换当前模型', keyHint: 'API Key' },
  custom: { name: '自定义兼容接口', endpoint: '', model: '', hint: '任意 OpenAI 兼容 /chat/completions 接口', modelHint: '填写服务商提供的模型名', keyHint: 'API Key' },
};

function createStudyEngine(api) {
  const cleanWord = raw => api.study.cleanWord(raw);
  const settingsDefaults = { provider: 'openai', endpoint: 'https://api.openai.com/v1', key: '', model: 'gpt-4o-mini', target: 'zh-CN' };
  let settings = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STUDY_ENGINE_SETTINGS_KEY) || 'null');
      if (saved && typeof saved === 'object') return Object.assign({}, settingsDefaults, saved);
    } catch (e) {}
    return Object.assign({}, settingsDefaults);
  })();
  let cache = (() => { try { return JSON.parse(localStorage.getItem(STUDY_ENGINE_CACHE_KEY) || '{}') || {}; } catch (e) { return {}; } })();
  let vocab = (() => {
    try {
      const v = JSON.parse(localStorage.getItem(STUDY_ENGINE_VOCAB_KEY) || '[]');
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  })();
  let status = (() => {
    try {
      const v = JSON.parse(localStorage.getItem(STUDY_ENGINE_STATUS_KEY) || '{}');
      return v && typeof v === 'object' ? v : {};
    } catch (e) { return {}; }
  })();
  vocab.forEach(item => {
    if (!item.status) item.status = 'learning';
    if (!Number.isFinite(Number(item.ease))) item.ease = 2.5;
    if (!Number.isFinite(Number(item.interval))) item.interval = 0;
    if (!Number.isFinite(Number(item.reps))) item.reps = 0;
    if (!Number.isFinite(Number(item.lapses))) item.lapses = 0;
    if (!Number.isFinite(Number(item.due))) item.due = Date.now();
    const key = cleanWord(item.word);
    if (key && !status[key]) status[key] = item.status;
  });

  function saveSettings() { try { localStorage.setItem(STUDY_ENGINE_SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {} }
  function saveCache() {
    try {
      const keys = Object.keys(cache);
      if (keys.length > 300) keys.slice(0, keys.length - 300).forEach(k => delete cache[k]);
      localStorage.setItem(STUDY_ENGINE_CACHE_KEY, JSON.stringify(cache));
    } catch (e) {}
  }
  function saveVocab() { try { localStorage.setItem(STUDY_ENGINE_VOCAB_KEY, JSON.stringify(vocab)); } catch (e) {} }
  function saveStatus() { try { localStorage.setItem(STUDY_ENGINE_STATUS_KEY, JSON.stringify(status)); } catch (e) {} }

  function wordStatusOf(raw) {
    const key = cleanWord(raw);
    return key ? (status[key] || '') : '';
  }
  function markWord(raw, next) {
    const key = cleanWord(raw);
    if (!key) return;
    if (next) status[key] = next; else delete status[key];
    saveStatus();
    const item = vocab.find(v => cleanWord(v.word) === key);
    if (item) { item.status = next || 'learning'; saveVocab(); }
  }
  function dueItems() {
    const now = Date.now();
    return vocab
      .filter(v => v.status !== 'known' && v.status !== 'ignored' && Number(v.due || 0) <= now)
      .sort((a, b) => Number(a.due || 0) - Number(b.due || 0));
  }
  function srsGrade(item, grade) {
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
  function stats() {
    const total = vocab.length;
    const known = vocab.filter(v => v.status === 'known').length;
    const due = dueItems().length;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const reviewed = vocab.filter(v => Number(v.lastReview || 0) >= today.getTime()).length;
    return { total, known, due, reviewed };
  }

  return {
    settings, cache, vocab, status, providers: STUDY_PROVIDERS,
    saveSettings, saveCache, saveVocab, saveStatus,
    wordStatusOf, markWord, dueItems, srsGrade, stats,
  };
}
