/* 2.2 示例插件：四类贡献各一个。
   注意 ctx 是按贡献类型收窄的：搜索源拿不到 settings/downloads，
   主题上下文只有版本字段。取消信号在 ctx.signal 上。 */
MyTPlugins.define('search-echo', {
  apiVersion: '2.2',
  contributions: {
    'menu:echo': {
      run: ctx => {
        ctx.api.toast('示例插件已运行：' + ctx.contribution + ' / 上下文 ' + ctx.contextVersion + ' / 取消信号 ' + Boolean(ctx.signal));
      },
    },
    'searchSource:echo': {
      search: async (ctx, query) => {
        await new Promise(resolve => setTimeout(resolve, 200));
        if (ctx.signal && ctx.signal.aborted) throw new Error('搜索已取消');
        return {
          version: ctx.payloadVersion,
          items: ['<div class="smalltext">回声：' + String(query || '').slice(0, 80) + '</div>'],
        };
      },
    },
    'slot:searchAfter': {
      mount: (el, ctx, payload) => {
        el.textContent = payload
          ? '示例槽位 · payload v' + ctx.payloadVersion
          : '示例槽位 · 没有 payload（v' + ctx.payloadVersion + '）';
      },
      unmount: el => { el.textContent = ''; },
    },
    'theme:sunset': { css: ':root { --accent: #e08a7a; }' },
  },
});
