// 首页功能域插件：原先由 07 的 renderHome 渲染，现在由贡献点接管。
// 只使用宿主的纯视图原语（ctx.ui）和按域拆开的数据服务（ctx.catalog / ctx.progress），
// 不直接改宿主状态。
MyTPlugins.define('home', {
  contributions: {
    'page:home': {
      render(el, ctx) {
        const { $, esc, fmt, emptyLine, statHTML, coverHTML, episodeRowHTML, podCardHTML } = ctx.ui;
        const { subs: subsOf, show: showByKey, episodes: episodesOf, builtinShows, isSubscribed } = ctx.catalog;
        const subs = subsOf().map(s => showByKey(s.key)).filter(Boolean);
        $('heroSubCount').textContent = subs.length;
        const dateEl = $('ledgerDate');
        if (dateEl && dateEl.textContent.trim() === '—') {
          dateEl.textContent = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
        }
        const progress = ctx.progress.all();
        const entries = Object.entries(progress).filter(([, rec]) => Number(rec.t) > 5);
        const continueEntry = entries
          .filter(([, rec]) => !rec.d || rec.t < rec.d - 30)
          .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))[0];
        if (continueEntry) {
          const [progressId, rec] = continueEntry;
          const key = rec.key || progressId.split(':')[0];
          const show = showByKey(key) || { slug: key, name: rec.show || key };
          const pct = rec.d ? Math.min(100, Math.round((rec.t / rec.d) * 100)) : 0;
          $('homeContinue').innerHTML = '<div class="continue" data-resume data-key="' + esc(key) + '" data-ep="' +
            esc(progressId.slice(key.length + 1).replace(/^:/, '')) + '" data-t="' + Number(rec.t || 0) + '">' +
            coverHTML(show, 'pod-art') + '<div class="continue-main"><strong>' + esc(rec.title || show.name || '继续收听') +
            '</strong><span>' + esc(rec.show || show.name || '') + ' · 已听 ' + fmt(rec.t) + (rec.d ? ' / ' + fmt(rec.d) : '') +
            '</span><div class="progress"><i style="width:' + pct + '%"></i></div></div>' +
            '<button class="round-play" data-resume data-key="' + esc(key) + '" data-ep="' +
            esc(progressId.slice(key.length + 1).replace(/^:/, '')) + '" data-t="' + Number(rec.t || 0) + '">▶</button></div>';
          $('continueHint').textContent = '上次停在这里';
        } else {
          $('homeContinue').innerHTML = emptyLine('还没有收听记录。', '<button class="btn primary" data-route="discover">去发现节目</button>');
          $('continueHint').textContent = '';
        }
        $('homeStats').innerHTML = statHTML('订阅节目', subs.length, '含内置与站外')
          + statHTML('开始收听', entries.length, '有播放位置的单集')
          + statHTML('收藏片段', ctx.catalog.bookmarks().length, '播放器里点 ☆');

        const recent = [];
        for (const show of subs) {
          for (const ep of episodesOf(show).slice(0, 3)) recent.push({ ep, show });
        }
        recent.sort((a, b) => (Date.parse(b.ep.date) || 0) - (Date.parse(a.ep.date) || 0));
        $('homeRecent').innerHTML = recent.length
          ? recent.slice(0, 8).map(item => episodeRowHTML(item.ep, item.show)).join('')
          : emptyLine('订阅节目的最近更新会出现在这里。');
        $('homeRecentCount').textContent = recent.length ? '来自 ' + subs.length + ' 个节目' : '';

        const recommended = builtinShows().filter(show => show.feed && !isSubscribed(show.slug)).slice(0, 4);
        $('homeRecommended').innerHTML = recommended.length
          ? recommended.map(podCardHTML).join('')
          : emptyLine('所有内置节目都已订阅。');
      },
    },
  },
});
