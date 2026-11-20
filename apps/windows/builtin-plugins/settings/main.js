// 设置功能域插件：最后迁移的页面。宿主只保留设置项控件与持久化，页面装配归插件。
MyTPlugins.define('settings', {
  contributions: {
    'page:settings': {
      render(el, ctx) {
        const { $, esc, emptyLine } = ctx.ui;
        const { show: showByKey, subs: subsOf, builtinShows, absoluteFeed } = ctx.catalog;
        const {
          moduleOn, prefs, reader, themeNames, auto: autoOf, cont: contOf, inboxCount,
          syncCustomThemeEditor, refreshPluginSettings, syncRateSeg,
          syncDockBadge, syncDockSleep, syncStudySettings, syncThemeSwatches,
          syncTranslateSettings, syncLiveLeadSelect,
        } = ctx.settings;

        const renderAuto = () => {
          const auto = autoOf();
          const refresh = $('autoRefresh'); if (refresh) refresh.value = String(Number(auto.refreshHours) || 0);
          const count = $('autoCount'); if (count) count.value = String(Number(auto.downloadCount) || 1);
          const cap = $('autoCap'); if (cap) cap.value = String(Number(auto.capMB) || 0);
          const switches = [['autoDownload', !!auto.autoDownload], ['autoDeletePlayed', !!auto.deletePlayed],
            ['autoDeleteQueue', !!auto.deleteNotInQueue], ['autoKeepFav', !!auto.keepFavorites], ['autoNotify', !!auto.notify]];
          switches.forEach(([id, on]) => { const node = $(id); if (node) node.setAttribute('aria-checked', String(on)); });
          const status = $('autoStatus');
          if (status) {
            status.textContent = auto.lastRefreshAt
              ? '上次刷新：' + new Date(Number(auto.lastRefreshAt)).toLocaleString('zh-CN', { hour12: false }) +
                ' · 收件箱 ' + inboxCount() + ' 集'
              : '尚未刷新 · 收件箱 ' + inboxCount() + ' 集';
          }
        };

        document.querySelectorAll('[data-module]').forEach(btn => btn.setAttribute('aria-checked', String(moduleOn(btn.dataset.module))));
        syncStudySettings();
        const themes = $('themeGrid');
        if (themes) {
          themes.innerHTML = Object.entries(themeNames()).map(([id, name]) =>
            '<button class="theme-card swatch" data-theme="' + id + '" role="radio" aria-checked="false"><span class="sw"></span>' +
            esc(name) + '</button>').join('');
        }
        if ($('ctCss')) syncCustomThemeEditor();
        if ($('pluginList')) refreshPluginSettings();
        const subList = $('settingsSubs');
        if (subList) {
          subList.innerHTML = subsOf().map(sub => {
            const show = showByKey(sub.key);
            return '<div class="ep-row"><div class="ep-body"><span class="ep-title">' + esc(show?.name || sub.name || sub.key) +
              '</span><span class="ep-sub">' + esc(show?.feed ? absoluteFeed(show.feed) : '仅保存链接') + '</span></div>' +
              '<span class="pill ' + (sub.builtin ? '' : 'dim') + '">' + (sub.builtin ? '内置' : '站外') + '</span>' +
              '<button class="mini-btn" data-remove-sub="' + esc(sub.key) + '" title="移除">✕</button></div>';
          }).join('') || emptyLine('还没有订阅。');
        }
        const speed = $('setSpeed'); if (speed) speed.value = String(prefs.speed || 1);
        syncRateSeg();
        syncDockBadge();
        syncDockSleep();
        const autoNext = $('setAutoNext'); if (autoNext) autoNext.setAttribute('aria-checked', String(contOf() !== 'single'));
        const remember = $('setRemember'); if (remember) remember.setAttribute('aria-checked', String(prefs.remember !== false));
        const lang = $('setLang'); if (lang) lang.value = reader.lang;
        const lead = $('setLiveLead'); if (lead) syncLiveLeadSelect();
        const mse = $('setLiveMse'); if (mse) mse.setAttribute('aria-checked', String(!!prefs.liveMse));
        const qo = $('setQueueOrder'); if (qo) qo.value = prefs.queueOrder || 'sequential';
        const vc = $('setVolumeCap'); if (vc) vc.value = String(Number(prefs.volumeCap) || 1);
        const sa = $('setSkipAds'); if (sa) sa.setAttribute('aria-checked', String(!!prefs.skipAds));
        const sl = $('setSkipLevel'); if (sl) sl.value = String(Math.max(1, Math.min(3, Number(prefs.skipLevel) || 2)));
        [['setSkipSilence', 'skipSilence'], ['setLoudness', 'loudness'], ['setSkipChapterAds', 'skipChapterAds']].forEach(([id, key]) => {
          const node = $(id); if (node) node.setAttribute('aria-checked', String(!!prefs[key]));
        });
        const fields = [['setScale', reader.scale, 'setScaleOut', reader.scale + '%'], ['setLh', reader.lh, 'setLhOut', Number(reader.lh).toFixed(2)],
          ['setWidth', reader.width, 'setWidthOut', reader.width + ' px'], ['setGap', reader.gap, 'setGapOut', reader.gap + ' px'],
          ['setPending', reader.pending, 'setPendingOut', reader.pending + '%']];
        fields.forEach(([id, value, outId, label]) => { const input = $(id); if (input) input.value = value; const out = $(outId); if (out) out.textContent = label; });
        const proxy = $('corsProxy'); if (proxy) proxy.value = localStorage.getItem('myt-cors-proxy') || '';
        const aboutShows = $('aboutShows'); if (aboutShows) aboutShows.textContent = builtinShows().length + ' 个';
        renderAuto();
        syncThemeSwatches();
        syncTranslateSettings();
      },
    },
  },
});
