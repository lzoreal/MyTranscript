// 学英语插件：句子卡、整集总结、复习、练习、生词本和词卡都归它。
// 字幕插件关闭时没有 cue，学习插件即使启用也保持不可用。
MyTPlugins.define('study', {
  contributions: {
    'capability:study': {
      claim(ctx) {
        const api = ctx.api;
        const study = api.study;
        if (!study || typeof study.claim !== 'function') {
          console.warn('[study] 当前壳没有学习宿主 API，插件不生效');
          return;
        }
        study.claim();
        if (typeof study.registerEngine === 'function' && typeof createStudyEngine === 'function') {
          study.registerEngine(createStudyEngine(api));
        }
        if (typeof study.registerRuntime === 'function' && typeof createStudyRuntime === 'function') {
          study.registerRuntime(createStudyRuntime(api, study.host()));
        }
        if (typeof study.registerUi === 'function' && typeof createStudyUi === 'function') {
          study.registerUi(createStudyUi(api, study.host()));
        }
        document.body.classList.add('study-plugin-on');
        // 宿主按 claim 的返回值做卸载清理：停用插件后别把 body 的类名留在页面上。
        return () => {
          document.body.classList.remove('study-plugin-on');
          delete document.body.dataset.studyPlugin;
        };
      },
    },
    'page:study': {
      _cleanup: null,
      render(el, ctx) {
        const page = this;
        const api = ctx.api;
        const study = api.study;
        if (!study) {
          el.innerHTML = '<div class="empty">学习宿主 API 不可用。</div>';
          return;
        }
        const unsubs = [];
        let destroyed = false;
        const draw = () => {
          if (destroyed) return;
          const s = study.status();
          const ep = s.episode || {};
          const episodeLine = ep.episodeId
            ? ep.showName + ' · ' + ep.title
            : '还没有打开单集';
          const warning = !s.subtitles
            ? '<p class="studyx-warn">字幕插件未启用，学习插件现在没有可用的文字稿。</p>'
            : '';
          const aiOff = !s.configured
            ? '<p class="studyx-warn">AI 还没配置：句子卡、整集总结、金句和问答需要模型；<strong>复习、生词本、填空和听写可以离线用</strong>。先点「去配置 AI」填 Key 和模型。</p>'
            : '';
          el.innerHTML =
            '<div class="studyx-card">' +
              '<div class="studyx-kicker">STUDY PLUGIN</div>' +
              '<h3>AI 学英语已由插件接管</h3>' +
              '<p class="studyx-sub">生词本 ' + s.vocab + ' 个 · 今日到期 ' + s.due + ' 个 · 已缓存 ' + s.cache + ' 条</p>' +
              '<p class="studyx-ep">' + episodeLine + '</p>' +
              '<p class="studyx-sub">AI 服务：' + s.provider + (s.configured ? ' · 已配置' : ' · 还缺 Key 或模型') + '</p>' +
              warning + aiOff +
              '<div class="studyx-actions">' +
                (s.configured
                  ? '<button class="btn primary" data-studyx="card">当前句学习卡</button>'
                  : '<button class="btn primary" data-studyx="settings">去配置 AI</button>') +
                '<button class="btn ghost" data-studyx="episode">整集总结</button>' +
                '<button class="btn ghost" data-studyx="review">复习</button>' +
                '<button class="btn ghost" data-studyx="vocab">生词本</button>' +
                (s.configured ? '<button class="btn ghost" data-studyx="settings">学习服务设置</button>' : '') +
              '</div>' +
              '<p class="studyx-note">停用这个插件后，播放器里的 AI 学英语入口、句子卡、整集总结、词卡和生词本都会消失，字幕本身不受影响。</p>' +
            '</div>';
          const needAi = () => {
            if (s.configured) return false;
            api.toast('这条功能要先用模型：在「学习服务设置」填 API Key 和模型。复习、生词本、填空和听写不需要 AI。', 'warn');
            return true;
          };
          const open = view => {
            if (!s.subtitles) { api.toast('先启用字幕插件，学习功能需要文字稿。', 'warn'); return; }
            study.open(view);
          };
          el.querySelector('[data-studyx="card"]')?.addEventListener('click', () => { if (!needAi()) open('card'); });
          el.querySelector('[data-studyx="episode"]').onclick = () => {
            if (!s.subtitles) { api.toast('先启用字幕插件，学习功能需要文字稿。', 'warn'); return; }
            if (needAi()) return;
            if (!ep.showKey || !ep.episodeId) { api.toast('先在播放器里打开一集。'); return; }
            study.openEpisode(ep.showKey, ep.episodeId);
          };
          el.querySelector('[data-studyx="review"]').onclick = () => open('review');
          el.querySelector('[data-studyx="vocab"]').onclick = () => open('vocab');
          el.querySelector('[data-studyx="settings"]').onclick = () => study.openSettings();
        };
        draw();
        ['player:open', 'player:play', 'player:pause', 'route:change'].forEach(name => {
          unsubs.push(api.on(name, () => { if (el.isConnected) draw(); }));
        });
        page._cleanup = () => {
          destroyed = true;
          unsubs.forEach(fn => { try { fn(); } catch (e) {} });
        };
      },
      destroy() {
        if (this._cleanup) this._cleanup();
        this._cleanup = null;
      },
    },
  },
});
