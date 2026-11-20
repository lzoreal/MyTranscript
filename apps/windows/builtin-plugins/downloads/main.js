// 下载管理功能域插件：接管下载页的分组渲染与空态。
MyTPlugins.define('downloads', {
  contributions: {
    'page:downloads': {
      render(el, ctx) {
        const { $, emptyLine } = ctx.ui;
        const { entries: offlineEntries, html: downloadsHTML, info: downloadInfo, fmtBytes } = ctx.downloads;
        const box = $('downloadsGroups');
        if (!box) return;
        const entries = offlineEntries();
        const totalBytes = entries.reduce((n, e) => n + (Number(e.size) || 0) + (Number(e.transcriptSize) || 0), 0);
        const groups = new Set(entries.map(rec => downloadInfo(rec).groupKey)).size;
        const hint = $('downloadsHint');
        if (hint) hint.textContent = entries.length
          ? entries.length + ' 集 · ' + groups + ' 个节目 · 共 ' + fmtBytes(totalBytes)
          : '还没有下载到本机的单集。';
        const q = $('downloadsFilter') ? $('downloadsFilter').value : '';
        const html = entries.length ? downloadsHTML(entries, q) : '';
        box.innerHTML = html || (entries.length
          ? '<div class="dl-empty">没有匹配的下载。换个关键词试试。</div>'
          : emptyLine('还没有下载到本机的单集。在单集页点「⤓ 整集下载」。'));
      },
    },
  },
});
