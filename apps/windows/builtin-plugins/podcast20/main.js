/* Podcasting 2.0 扩展：只做「把 feed 里已经写着的东西显示出来」。
 *
 * 这两块字段是真实存在于 RSS 里的，但换了播放器就丢：podcast:person（谁在这集里、
 * 什么角色）、podcast:alternateEnclosure（同一集还有别的音源/视频源）。
 * 本插件不接管选源播放——那要动播放内核，换个源就得重建解码与字幕时间轴，
 * 留到有真实需求再说。现在能做的：显示、复制直链、标明是视频源。
 */

MyTPlugins.define('podcast20', {
  contributions: {
    'slot:p20-episode': {
      mount(node, ctx, payload) {
        const api = ctx.api;
        if (!payload || !payload.episodeId) return;
        const persons = Array.isArray(payload.persons) ? payload.persons : [];
        const alternates = Array.isArray(payload.alternates) ? payload.alternates : [];
        if (!persons.length && !alternates.length) { node.innerHTML = ''; return; }
        const peopleHtml = persons.length
          ? '<div class="p20-block"><div class="p20-head">谁在这集里</div><div class="p20-people">' +
              persons.map(p =>
                '<span class="p20-person" title="' + escapeAttr([p.role, p.group].filter(Boolean).join(' · ')) + '">' +
                  '<b>' + escapeHtml(p.name) + '</b>' +
                  (p.role ? '<span class="p20-role">' + escapeHtml(p.role) + '</span>' : '') +
                '</span>').join('') +
            '</div></div>'
          : '';
        const altHtml = alternates.length
          ? '<div class="p20-block"><div class="p20-head">这一集的其他音源</div>' +
              alternates.map((a, i) =>
                '<div class="p20-alt">' +
                  '<span class="p20-tag' + (a.video ? ' video' : '') + '">' + (a.video ? '视频' : '音频') + '</span>' +
                  '<span class="p20-alt-title">' + escapeHtml(a.title || a.type || '未命名音源') + '</span>' +
                  (a.bytes ? '<span class="p20-muted">' + fmtBytes(a.bytes) + '</span>' : '') +
                  '<button class="btn ghost" type="button" data-p20-copy="' + i + '">复制直链</button>' +
                '</div>').join('') +
            '</div>'
          : '';
        node.innerHTML = '<div class="p20-panel">' + peopleHtml + altHtml + '</div>';
        node.querySelectorAll('[data-p20-copy]').forEach(btn => {
          btn.onclick = async () => {
            const alt = alternates[Number(btn.dataset.p20Copy)];
            if (!alt || !alt.uri) return;
            try {
              await navigator.clipboard.writeText(alt.uri);
              api.toast('已复制直链');
            } catch (err) {
              api.toast('复制失败：' + (err.message || err), 'warn');
            }
          };
        });
      },
    },
  },
});

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (!v) return '';
  if (v < 1024 * 1024) return (v / 1024).toFixed(0) + ' KB';
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
  return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function escapeHtml(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(text) { return escapeHtml(text).replace(/\n/g, ' '); }
