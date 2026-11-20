/* 字幕插件：实时识别的生命周期入口。
   低层取字节/解码/推理仍由宿主引擎提供（WebView 与 Rust 能力不能交给 blob 插件），
   但“何时开、何时停、按钮与状态”由插件拥有；宿主只暴露 liveEngine 小接口。 */
(function () {
  function createSubtitleLive(api) {
    const engine = api.subtitles && api.subtitles.liveEngine;
    let bound = false;
    let disposed = false;
    let buttons = [];

    function requireEngine() {
      if (!engine) throw new Error('宿主没有提供实时识别引擎');
      return engine;
    }

    /* enable() 返回 needReload 时，把“刷新后继续”的意图记在插件这边。 */
    function markAutoReload() {
      try {
        if (engine && engine.status().mode === 'needReload') sessionStorage.setItem('myt-live-auto', '1');
      } catch (e) {}
    }

    function render() {
      const s = requireEngine().status();
      const on = !!s.on;
      const liveBtn = document.getElementById('liveBtn');
      if (liveBtn) {
        liveBtn.classList.toggle('on', on);
        liveBtn.setAttribute('aria-pressed', String(on));
        liveBtn.classList.toggle('busy', !!s.busy);
      }
      return s;
    }

    /* 自动开实时识别也归插件：桌面壳 ?live=1、以及因跨域隔离刷新后的续开。
       宿主只留引擎 enable/disable，不再自己决定何时开。 */
    function autoStart() {
      let flag = '';
      try { flag = sessionStorage.getItem('myt-live-auto') || ''; } catch (e) {}
      const forced = /[?&]live=1/.test(location.search);
      if (!flag && !forced) return;
      let tries = 0;
      const attempt = () => {
        tries += 1;
        const episode = api.player && typeof api.player.state === 'function' ? api.player.state() : null;
        if ((!forced && !self.crossOriginIsolated) || !document.body.classList.contains('player-open') || !episode) {
          if (tries < 60) setTimeout(attempt, 250);
          return;
        }
        try { sessionStorage.removeItem('myt-live-auto'); } catch (e) {}
        Promise.resolve()
          .then(() => requireEngine().enable())
          .then(() => { render(); if (api.player && api.player.state && api.player.state().paused) api.player.play(); })
          .catch(err => api.toast('实时识别失败：' + (err.message || err), 'warn'));
      };
      setTimeout(attempt, 600);
    }

    function bind() {
      if (bound || disposed) return;
      const onBtn = document.getElementById('liveBtn');
      const stopBtn = document.getElementById('liveStopBtn');
      if (!onBtn && !stopBtn) return;
      const stop = () => {
        try {
          const s = requireEngine().status();
          if (s.mode === 'needReload') { location.reload(); return; }
          requireEngine().disable('已停止实时识别，正文回到原文字稿。');
          render();
        } catch (err) { api.toast('停止实时识别失败：' + (err.message || err), 'warn'); }
      };
      const toggle = async () => {
        try {
          if (requireEngine().status().on) stop();
          else { await requireEngine().enable(); markAutoReload(); render(); }
        } catch (err) { api.toast('实时识别失败：' + (err.message || err), 'warn'); }
      };
      if (onBtn) { onBtn.onclick = toggle; buttons.push([onBtn, toggle]); }
      if (stopBtn) { stopBtn.onclick = stop; buttons.push([stopBtn, stop]); }
      bound = true;
      autoStart();
    }

    async function toggle() {
      const e = requireEngine();
      if (e.status().on) { e.disable('已停止实时识别。'); return false; }
      await e.enable();
      markAutoReload();
      render();
      return !!e.status().on;
    }

    function dispose() {
      disposed = true;
      for (const [btn, fn] of buttons) {
        if (btn && btn.onclick === fn) btn.onclick = null;
      }
      buttons = [];
      bound = false;
      try {
        if (engine && engine.status().on) engine.disable('字幕插件已停用，实时识别已停止。');
      } catch (e) {}
    }

    return { bind, toggle, render, status: () => requireEngine().status(), dispose };
  }
  window.MytSubtitleLive = { create: createSubtitleLive };
})();
