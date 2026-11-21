/* 随手摘录：把「听到这一句」变成一条能回跳的卡片。
 *
 * 设计取舍：
 * - 不做总结、不调 LLM。摘录的价值在「当时的语境 + 精确时间点」，生成摘要反而
 *   会把它变成另一份需要读的东西。观点/摘要交给 study 插件。
 * - 文本来自 api.cues()，所以本插件依赖 subtitles 插件；没有文字稿的单集只能
 *   记时间点，不写这条路径（免得用户以为坏了）。
 * - 音频片段是「顺手」：只有本机文件（localPath 存在）才裁，远程单集不替用户
 *   下载几百 MB。裁失败只丢片段，卡片照样留下。
 */

const DST_KEY = 'cards';
const DST_MAX = 500;

MyTPlugins.define('distill', {
  contributions: {
    'slot:distill-dock': {
      mount(node, ctx) {
        const api = ctx.api;
        node.innerHTML = '<button class="btn ghost dst-dock" type="button">✂ 摘录<span class="dst-count"></span></button>';
        const btn = node.querySelector('.dst-dock');
        const count = node.querySelector('.dst-count');
        const paint = () => {
          const n = readCards(api).length;
          count.textContent = n ? ' ' + n : '';
        };
        btn.onclick = () => capture(api);
        paint();
        this._off = api.on('player:open', paint);
      },
      unmount() {
        if (this._off) { try { this._off(); } catch (e) {} this._off = null; }
      },
    },
    'slot:distill-episode': {
      mount(node, ctx, payload) {
        const api = ctx.api;
        if (!payload || !payload.episodeId) return;
        const draw = () => {
          const list = readCards(api).filter(c => c.episodeId === payload.episodeId);
          if (!list.length) { node.innerHTML = ''; return; }
          node.innerHTML =
            '<div class="dst-panel">' +
              '<div class="dst-head"><b>本集摘录</b><span class="dst-muted">' + list.length + ' 条</span></div>' +
              list.map(cardRow).join('') +
            '</div>';
          node.querySelectorAll('[data-dst-jump]').forEach(el => {
            el.onclick = () => jumpTo(api, el.dataset.dstJump, Number(el.dataset.dstT));
          });
        };
        draw();
        this._off = api.on('player:open', draw);
      },
      unmount() {
        if (this._off) { try { this._off(); } catch (e) {} this._off = null; }
      },
    },
    'page:distill': {
      render(el, ctx) {
        const api = ctx.api;
        const draw = () => {
          const cards = readCards(api).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
          el.innerHTML =
            '<div class="page-head"><div><div class="eyebrow">DISTILL</div><h1>摘录本</h1>' +
            '<div class="subtitle">' + (cards.length ? cards.length + ' 条摘录 · 点标题回到那一集' : '还没有摘录。在播放器底部点「✂ 摘录」。') + '</div></div>' +
            (cards.length ? '<div class="head-actions"><button class="btn ghost" id="dstExport">⇧ 导出 JSON</button>' +
              '<button class="btn ghost" id="dstClear">清空</button></div>' : '') +
            '</div>' +
            '<div class="card card-pad">' +
              (cards.length ? cards.map(cardRow).join('') : '<div class="dst-muted">摘录会出现在这里，按节目分组显示。</div>') +
            '</div>';
          el.querySelectorAll('[data-dst-jump]').forEach(row => {
            row.onclick = () => jumpTo(api, row.dataset.dstJump, Number(row.dataset.dstT));
          });
          el.querySelectorAll('[data-dst-del]').forEach(row => {
            row.onclick = ev => {
              ev.stopPropagation();
              const id = row.dataset.dstDel;
              api.storage.set(DST_KEY, readCards(api).filter(c => c.id !== id));
              draw();
            };
          });
          const exportBtn = el.querySelector('#dstExport');
          if (exportBtn) {
            exportBtn.onclick = () => {
              const payload = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), cards }, null, 2);
              try {
                const blob = new Blob([payload], { type: 'application/json' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'mytranscript-distill.json';
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 1000);
                api.toast('已导出 ' + cards.length + ' 条摘录');
              } catch (err) { api.toast('导出失败：' + (err.message || err), 'warn'); }
            };
          }
          const clearBtn = el.querySelector('#dstClear');
          if (clearBtn) {
            clearBtn.onclick = () => {
              if (!confirm('清空全部摘录？这个操作不能撤销。')) return;
              api.storage.set(DST_KEY, []);
              draw();
            };
          }
        };
        draw();
        const off = api.on('player:open', draw);
        this._cleanup = () => { try { off(); } catch (e) {} };
      },
      destroy() {
        if (this._cleanup) this._cleanup();
        this._cleanup = null;
      },
    },
  },
});

function readCards(api) {
  const raw = api.storage.get(DST_KEY, []);
  return Array.isArray(raw) ? raw.filter(c => c && c.id) : [];
}

function fmtClock(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
    : m + ':' + String(s).padStart(2, '0');
}

function cardRow(card) {
  const clip = card.clipPath ? '<span class="dst-tag">有声片段</span>' : '';
  return '<div class="dst-row" data-dst-jump="' + escapeAttr(card.showKey) + '|' + escapeAttr(card.episodeId) +
    '" data-dst-t="' + Number(card.t || 0) + '">' +
    '<div class="dst-meta"><span class="dst-time">' + fmtClock(card.t) + '</span>' +
    '<span class="dst-muted">' + escapeAttr(card.showName || card.showKey || '') + '</span>' + clip + '</div>' +
    '<div class="dst-text">' + escapeHtml(card.text || '') + '</div>' +
    '<div class="dst-ep">' + escapeHtml(card.title || '') +
    '<button class="dst-del" type="button" data-dst-del="' + escapeAttr(card.id) + '" aria-label="删除这条摘录">✕</button></div>' +
    '</div>';
}

function capture(api) {
  const st = api.player.state();
  if (!st.episodeId) { api.toast('先在播放器里打开一集。'); return; }
  const cues = api.cues ? api.cues() : [];
  if (!cues.length) { api.toast('这一集还没有文字稿，暂时只能记时间点（未保存）。'); return; }
  const idx = cueIndexAt(cues, st.time, st.cueIndex);
  if (idx < 0) { api.toast('还没播到有字幕的位置，再放几秒。'); return; }
  const window_ = cues.slice(Math.max(0, idx - 1), idx + 2);
  const text = window_.map(c => String(c.text || '')).join(' ').replace(/\s+/g, ' ').trim();
  const t = Number(window_[0].start) || st.time;
  const end = Number(window_[window_.length - 1].end) || st.time;
  const cards = readCards(api);
  const card = {
    id: 'dst-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    showKey: st.showKey, showName: st.showName, episodeId: st.episodeId, title: st.title,
    t, end, text, createdAt: Date.now(), clipPath: '',
  };
  cards.unshift(card);
  api.storage.set(DST_KEY, cards.slice(0, DST_MAX));
  api.toast('已收进摘录本 · 共 ' + Math.min(cards.length, DST_MAX) + ' 条');
  // 本机单集顺手裁 6 秒上下文；远程单集跳过，不偷偷下载。
  if (st.localPath && api.media && api.media.available()) {
    api.media.cut(st.localPath, Math.max(0, (t - 1) * 1000), (end + 1) * 1000).then(res => {
      if (!res || !res.path) return;
      const next = readCards(api).map(c => (c.id === card.id ? Object.assign({}, c, { clipPath: res.path }) : c));
      api.storage.set(DST_KEY, next);
    }).catch(() => {});
  }
}

function cueIndexAt(cues, time, hint) {
  if (Number.isInteger(hint) && hint >= 0 && cues[hint]) return hint;
  let idx = -1;
  for (let i = 0; i < cues.length; i += 1) {
    if (Number(cues[i].start) <= Number(time) + 0.05) idx = i;
    else break;
  }
  return idx;
}

function jumpTo(api, packed, t) {
  const parts = String(packed || '').split('|');
  const showKey = parts[0];
  const episodeId = parts[1];
  if (!showKey || !episodeId) return;
  const st = api.player.state();
  if (st.episodeId === episodeId) { api.player.seek(t); return; }
  Promise.resolve(api.openEpisode(showKey, episodeId)).then(() => {
    setTimeout(() => { try { api.player.seek(t); } catch (e) {} }, 400);
  }).catch(err => api.toast('打开这一集失败：' + (err.message || err), 'warn'));
}

function escapeHtml(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(text) { return escapeHtml(text).replace(/\n/g, ' '); }
