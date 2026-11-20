// 播客库功能域插件：接管订阅列表页面，空态仍指向宿主已有的发现页与导入动作。
MyTPlugins.define('library', {
  contributions: {
    'page:library': {
      render(el, ctx) {
        const { $, emptyLine, podCardHTML } = ctx.ui;
        const query = ($('libraryFilter')?.value || '').trim().toLowerCase();
        const shows = ctx.catalog.subs().map(s => ctx.catalog.show(s.key)).filter(Boolean)
          .filter(show => !query || (show.name + ' ' + (show.description || '')).toLowerCase().includes(query));
        $('libraryCount').textContent = ctx.catalog.subs().length + ' 个订阅' + (query ? ' · 匹配 ' + shows.length : '');
        $('libraryGrid').innerHTML = shows.length
          ? shows.map(podCardHTML).join('')
          : emptyLine(query ? '没有匹配的播客。' : '还没有订阅。', query ? '' : '<button class="btn primary" data-action="import-builtin">选择导入内置源</button> <button class="btn ghost" data-route="discover">去发现页</button>');
      },
    },
  },
});
