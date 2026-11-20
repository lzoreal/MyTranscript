// 学英语的运行时：AI 请求、provider 配置解析、cue 定位与音频循环/自动暂停。
// 数据由 engine.js 持有；渲染仍由宿主 08-study-ai.js 负责（阶段三）。
function createStudyRuntime(api, host) {
  const STUDY_PROVIDERS = {
    openai: { name: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    claude: { name: 'Claude', endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-3-5-sonnet-latest' },
    gemini: { name: 'Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' },
    deepseek: { name: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    kimi: { name: 'Kimi', endpoint: 'https://api.moonshot.cn/v1', model: 'kimi-k2-0905-preview' },
    glm: { name: 'GLM', endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
    custom: { name: '自定义兼容接口', endpoint: '', model: '' },
  };
  const settings = () => {
    const engine = api.study.engine();
    return (engine && engine.settings) || {};
  };
  let loop = null;
  let autoPauseDone = -1;
  let cueWaitTimer = 0;
  let cueWaitFn = null;

  function hash(text) {
    let h = 5381;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  function langName() {
    const target = settings().target;
    return target === 'zh-TW' ? 'Traditional Chinese' : target === 'en' ? 'English' : 'Simplified Chinese';
  }
  function providerMeta() {
    return STUDY_PROVIDERS[settings().provider] || STUDY_PROVIDERS.openai;
  }
  function config() {
    const s = settings();
    return { engine: s.provider || 'openai', endpoint: s.endpoint, key: s.key, model: s.model, target: s.target };
  }
  function native() { const t = host.tauriHost(); return !!(t && t.core); }
  function ready() {
    const s = settings();
    return native() && !!String(s.key || '').trim() && !!String(s.model || '').trim() &&
      (s.provider !== 'custom' || !!String(s.endpoint || '').trim());
  }
  async function chat(system, user) {
    const s = settings();
    if (!native()) throw new Error('AI 学英语需要在桌面版使用。');
    if (!ready()) throw new Error(s.provider === 'custom'
      ? '请先在「设置 → AI 学英语」填写接口地址、API Key 和模型。'
      : '请先在「设置 → AI 学英语」填写 API Key 和模型。');
    return await host.tauriHost().core.invoke('llm_chat', { req: { config: config(), system, user } });
  }
  function parseJson(text) {
    let s = String(text || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    try { return JSON.parse(s); } catch (e) { return { raw: String(text || '').trim() }; }
  }
  function currentCue() {
    const cues = host.state.cues || [];
    if (!cues.length) return null;
    let ci = host.state.activeCue;
    if (ci < 0 || !cues[ci]) ci = 0;
    return { cue: cues[ci], ci };
  }
  function withCues(fn) {
    if ((host.state.cues || []).length) { fn(); return; }
    if (!host.state.current) return;
    cueWaitFn = fn;
    if (cueWaitTimer) return;
    cueWaitTimer = setInterval(() => {
      if (!(host.state.cues || []).length) return;
      clearInterval(cueWaitTimer);
      cueWaitTimer = 0;
      const fn2 = cueWaitFn;
      cueWaitFn = null;
      if (fn2) fn2();
    }, 700);
    setTimeout(() => {
      if (cueWaitTimer) { clearInterval(cueWaitTimer); cueWaitTimer = 0; cueWaitFn = null; }
    }, 15000);
  }
  function currentKey(cur) {
    const ep = host.state.current ? host.state.current.id : 'none';
    return ep + ':' + cur.ci + ':' + hash(cur.cue.text || '');
  }
  function sourceLabel() {
    const show = host.state.show ? (host.state.show.name || host.state.show.slug) : '';
    const ep = host.state.current ? (host.state.current.title || '') : '';
    return [show, ep].filter(Boolean).join(' · ');
  }
  function cueBounds(cue) {
    const s = Number.isFinite(Number(cue.speechStart)) ? Number(cue.speechStart) : Number(cue.start);
    const e = Number.isFinite(Number(cue.speechEnd)) ? Number(cue.speechEnd) : Number(cue.end);
    return { start: s + (host.state.offset || 0), end: Math.max(s + 0.4, e) + (host.state.offset || 0) };
  }
  function stopAudio() {
    loop = null;
    if (!host.audio.paused) host.audio.pause();
  }
  function playRange(start, end, loops = 1) {
    const s = Number(start), e = Number(end);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) {
      host.showToast('这一句没有可用的音频时间。', 2200);
      return;
    }
    host.seekTo(s);
    autoPauseDone = -1;
    loop = { start: s, end: e, left: Math.max(1, loops) };
    host.audio.play().catch(() => {});
  }
  function playCue(cue, loops = 1) {
    const b = cueBounds(cue);
    playRange(b.start, b.end, loops);
  }
  function playItem(item) {
    if (item.episodeId && host.state.current && String(item.episodeId) !== String(host.state.current.id)) {
      host.showToast('这条来自另一集，切到该集后可以听原句。', 3200);
      return;
    }
    const s = Number(item.speechStart ?? item.start), e = Number(item.speechEnd ?? item.end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) { host.showToast('这条还没有绑定原句音频。', 2400); return; }
    playRange(s + (host.state.offset || 0), e + (host.state.offset || 0), 1);
  }
  function audioTick() {
    const t = host.audio.currentTime || 0;
    if (loop) {
      if (t >= loop.end - 0.06) {
        if (loop.left > 1) {
          loop.left -= 1;
          host.audio.currentTime = loop.start;
          host.audio.play().catch(() => {});
        } else {
          loop = null;
          autoPauseDone = host.state.activeCue;
          host.audio.pause();
        }
      }
      return;
    }
    if (!host.studyAutoPause || host.audio.paused) return;
    const cur = currentCue();
    if (!cur) return;
    if (autoPauseDone === cur.ci || autoPauseDone === -2) return;
    const end = (Number.isFinite(Number(cur.cue.speechEnd)) ? Number(cur.cue.speechEnd) : Number(cur.cue.end)) + (host.state.offset || 0);
    if (t >= end - 0.1) {
      autoPauseDone = cur.ci;
      host.audio.pause();
    }
  }
  function notePlaybackStart() {
    if (autoPauseDone === host.state.activeCue) autoPauseDone = -2;
  }
  function notePlaybackEnded() { loop = null; }
  function resetAutoPause() { autoPauseDone = -1; }

  return {
    hash, langName, providerMeta, config, native, ready, chat, parseJson,
    currentCue, withCues, currentKey, sourceLabel,
    cueBounds, stopAudio, playRange, playCue, playItem, audioTick,
    notePlaybackStart, notePlaybackEnded, resetAutoPause,
  };
}
