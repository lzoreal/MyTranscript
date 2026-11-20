/* 字幕插件：桌面全局字幕的会话入口。
   WASAPI 采集、浮窗和识别进程留在 Rust（系统级能力）；插件负责会话开关、状态、
   应用选择与显示选项，宿主只把它转成一个 captions 命令适配器。 */
(function () {
  function createSubtitleCaptions(api) {
    const captions = api.subtitles && api.subtitles.captions;
    let on = false;
    let lastError = '';
    const listeners = new Set();

    function emit() {
      for (const fn of listeners) {
        try { fn({ on, error: lastError }); } catch (e) {}
      }
    }
    function requireApi() {
      if (!captions) throw new Error('宿主没有提供桌面字幕能力');
      return captions;
    }
    function available() { return !!(captions && captions.available()); }

    async function refresh() {
      if (!available()) { on = false; return false; }
      try { on = !!(await requireApi().active()); lastError = ''; }
      catch (err) { on = false; lastError = err.message || String(err); }
      emit();
      return on;
    }

    async function start(pid) {
      if (!available()) throw new Error('当前壳没有桌面字幕能力');
      await requireApi().start(pid);
      on = true; lastError = ''; emit();
      return true;
    }

    async function stop() {
      if (!available()) return false;
      await requireApi().stop();
      on = false; emit();
      return false;
    }

    async function toggle() {
      return on ? stop() : start();
    }

    async function picker() {
      if (!available()) throw new Error('当前壳没有桌面字幕能力');
      await requireApi().picker();
      return true;
    }

    async function sessions() {
      if (!available()) return [];
      return requireApi().list();
    }

    function subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }

    return {
      available, refresh, start, stop, toggle, picker, sessions, subscribe,
      status: () => ({ on, error: lastError }),
    };
  }
  window.MytSubtitleCaptions = { create: createSubtitleCaptions };
})();
