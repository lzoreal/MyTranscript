// 字幕插件：播放器里的文字稿、实时识别、迷你字幕、壁纸字幕、学习与精听都
// 由这一个人插件统一接管。停用后主程序只保留音频与播放控制。
// 解析/对齐内核在同目录的 kernel.js，由宿主按 plugin.json 的 scripts 先拼进来。
MyTPlugins.register('subtitles', {
  setup(api) {
    const subs = api.subtitles;
    if (!subs || typeof subs.claim !== 'function') {
      console.warn('[subtitles] 当前壳没有字幕宿主 API，插件不生效');
      return;
    }
    if (api.host && typeof api.host.registerKernel === 'function') {
      const kernel = Object.assign({}, window.MytSubtitleKernel || {}, window.MytSubtitleView || {});
      if (Object.keys(kernel).length) api.host.registerKernel('transcript', kernel);
    }
    subs.claim();
    document.body.classList.add('subs-plugin-on');
    let cleanup = null;

    const pct = (a, b) => {
      if (!b) return '0%';
      return Math.round((a / b) * 100) + '%';
    };
    const mmss = value => {
      const total = Math.max(0, Math.floor(Number(value) || 0));
      const m = Math.floor(total / 60);
      const s = total % 60;
      return m + ':' + String(s).padStart(2, '0');
    };
    const describe = s => {
      if (!s || !s.episode || !s.episode.episodeId) return '还没有打开单集';
      return s.episode.showName + ' · ' + s.episode.title;
    };

    api.page('center', {
      title: '字幕中心',
      subtitle: '字幕插件 · 播放器与桌面字幕统一入口',
      render(el) {
        const unsubs = [];
        let destroyed = false;
        const draw = () => {
          if (destroyed) return;
          const s = subs.status();
          const ep = s.episode || {};
          const progress = ep.duration ? ' · ' + mmss(ep.time) + ' / ' + mmss(ep.duration) + '（' + pct(ep.time, ep.duration) + '）' : '';
          el.innerHTML =
            '<div class="subsx-card">' +
              '<div class="subsx-kicker">SUBTITLES PLUGIN</div>' +
              '<h3>字幕已由插件接管</h3>' +
              '<p class="subsx-sub">' + (s.cues ? (s.cues + ' 句 · ' + s.words + ' 个词级时间点') : '当前没有文字稿') +
                ' · 高亮模式 ' + (s.mode === 'word' ? '逐词' : '逐句') +
                ' · 语言 ' + (s.lang === 'both' ? '双语' : s.lang === 'zh' ? '中文' : '英文') + '</p>' +
              '<p class="subsx-ep">' + (describe(s) || '') + progress + '</p>' +
              '<div class="subsx-actions">' +
                '<button class="btn primary" data-subsx="player">打开播放器</button>' +
                '<button class="btn ghost" data-subsx="settings">字幕与阅读设置</button>' +
                '<button class="btn ghost" data-subsx="lang">切换双语/英文</button>' +
                '<button class="btn ghost" data-subsx="live">' + (s.live ? '停止实时识别' : '开启实时识别') + '</button>' +
                '<button class="btn ghost" data-subsx="clip">精听刚才 15 秒</button>' +
                '<button class="btn ghost" data-subsx="export">导出当前字幕</button>' +
              '</div>' +
              '<p class="subsx-note">插件停用后，播放器不再加载文字稿、不再显示任何字幕或学习入口，只保留音频和节目信息。</p>' +
            '</div>';
          el.querySelector('[data-subsx="player"]').onclick = () => {
            if (!ep.showKey || !ep.episodeId) { api.toast('先在播放器里打开一集。'); return; }
            api.navigate('player', [ep.showKey, ep.episodeId]);
          };
          el.querySelector('[data-subsx="settings"]').onclick = () => subs.openSettings();
          el.querySelector('[data-subsx="lang"]').onclick = () => {
            const next = s.lang === 'both' ? 'en' : 'both';
            subs.setLang(next);
            draw();
          };
          el.querySelector('[data-subsx="live"]').onclick = async () => {
            try { await subs.toggleLive(); } catch (err) { api.toast('实时识别失败：' + (err.message || err), 'warn'); }
            draw();
          };
          el.querySelector('[data-subsx="clip"]').onclick = () => subs.clipNow(15);
          el.querySelector('[data-subsx="export"]').onclick = () => subs.exportSubtitle('txt');
        };
        draw();
        ['player:open', 'player:cue', 'player:play', 'player:pause', 'route:change'].forEach(name => {
          unsubs.push(api.on(name, () => {
            if (el.isConnected) draw();
          }));
        });
        cleanup = () => {
          destroyed = true;
          unsubs.forEach(fn => { try { fn(); } catch (e) {} });
        };
      },
      destroy() {
        if (cleanup) cleanup();
        cleanup = null;
      },
    });
  },
});
