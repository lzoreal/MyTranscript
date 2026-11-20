// 学英语的运行时：AI 请求、provider 配置解析、cue 定位与音频循环/自动暂停。
// 数据由 engine.js 持有，渲染由 ui.js 负责；本文件不碰 DOM。
function createStudyRuntime(api, host) {
  const settings = () => {
    const engine = api.study.engine();
    return (engine && engine.settings) || {};
  };
  const providers = () => {
    const engine = api.study.engine();
    return (engine && engine.providers) || {};
  };
  let loop = null;
  let autoPauseDone = -1;
  let cueWaitTimer = 0;
  let cueWaitTimeout = 0;
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
    const list = providers();
    return list[settings().provider] || list.openai || {};
  }
  function config() {
    const s = settings();
    return { engine: s.provider || 'openai', endpoint: s.endpoint, key: s.key, model: s.model, target: s.target };
  }
  function native() { const t = host.shell.tauriHost(); return !!(t && t.core); }
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
    return await host.shell.tauriHost().core.invoke('llm_chat', { req: { config: config(), system, user } });
  }
  function parseJson(text) {
    let s = String(text || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    try { return JSON.parse(s); } catch (e) { return { raw: String(text || '').trim() }; }
  }
  function currentCue() {
    const cues = host.player.state.cues || [];
    if (!cues.length) return null;
    let ci = host.player.state.activeCue;
    if (ci < 0 || !cues[ci]) ci = 0;
    return { cue: cues[ci], ci };
  }
  function withCues(fn) {
    if ((host.player.state.cues || []).length) { fn(); return; }
    if (!host.player.state.current) return;
    cueWaitFn = fn;
    if (cueWaitTimer) return;
    cueWaitTimer = setInterval(() => {
      if (!(host.player.state.cues || []).length) return;
      clearInterval(cueWaitTimer);
      clearTimeout(cueWaitTimeout);
      cueWaitTimer = 0;
      cueWaitTimeout = 0;
      const fn2 = cueWaitFn;
      cueWaitFn = null;
      if (fn2) fn2();
    }, 700);
    cueWaitTimeout = setTimeout(() => {
      if (cueWaitTimer) { clearInterval(cueWaitTimer); cueWaitTimer = 0; cueWaitFn = null; }
      cueWaitTimeout = 0;
    }, 15000);
  }
  function currentKey(cur) {
    const ep = host.player.state.current ? host.player.state.current.id : 'none';
    return ep + ':' + cur.ci + ':' + hash(cur.cue.text || '');
  }
  function sourceLabel() {
    const show = host.player.state.show ? (host.player.state.show.name || host.player.state.show.slug) : '';
    const ep = host.player.state.current ? (host.player.state.current.title || '') : '';
    return [show, ep].filter(Boolean).join(' · ');
  }
  function cueBounds(cue) {
    const s = Number.isFinite(Number(cue.speechStart)) ? Number(cue.speechStart) : Number(cue.start);
    const e = Number.isFinite(Number(cue.speechEnd)) ? Number(cue.speechEnd) : Number(cue.end);
    return { start: s + (host.player.state.offset || 0), end: Math.max(s + 0.4, e) + (host.player.state.offset || 0) };
  }
  function stopAudio() {
    loop = null;
    if (!host.player.audio.paused) host.player.audio.pause();
  }
  function playRange(start, end, loops = 1) {
    const s = Number(start), e = Number(end);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) {
      host.ui.toast('这一句没有可用的音频时间。', 2200);
      return;
    }
    host.player.seekTo(s);
    autoPauseDone = -1;
    loop = { start: s, end: e, left: Math.max(1, loops) };
    host.player.audio.play().catch(() => {});
  }
  function playCue(cue, loops = 1) {
    const b = cueBounds(cue);
    playRange(b.start, b.end, loops);
  }
  function playItem(item) {
    if (item.episodeId && host.player.state.current && String(item.episodeId) !== String(host.player.state.current.id)) {
      host.ui.toast('这条来自另一集，切到该集后可以听原句。', 3200);
      return;
    }
    const s = Number(item.speechStart ?? item.start), e = Number(item.speechEnd ?? item.end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) { host.ui.toast('这条还没有绑定原句音频。', 2400); return; }
    playRange(s + (host.player.state.offset || 0), e + (host.player.state.offset || 0), 1);
  }
  function audioTick() {
    const t = host.player.audio.currentTime || 0;
    if (loop) {
      if (t >= loop.end - 0.06) {
        if (loop.left > 1) {
          loop.left -= 1;
          host.player.audio.currentTime = loop.start;
          host.player.audio.play().catch(() => {});
        } else {
          loop = null;
          autoPauseDone = host.player.state.activeCue;
          host.player.audio.pause();
        }
      }
      return;
    }
    if (!host.player.getAutoPause() || host.player.audio.paused) return;
    const cur = currentCue();
    if (!cur) return;
    if (autoPauseDone === cur.ci || autoPauseDone === -2) return;
    const end = (Number.isFinite(Number(cur.cue.speechEnd)) ? Number(cur.cue.speechEnd) : Number(cur.cue.end)) + (host.player.state.offset || 0);
    if (t >= end - 0.1) {
      autoPauseDone = cur.ci;
      host.player.audio.pause();
    }
  }
  function notePlaybackStart() {
    if (autoPauseDone === host.player.state.activeCue) autoPauseDone = -2;
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
