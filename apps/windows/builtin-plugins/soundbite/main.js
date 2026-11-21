/* 片段收藏：用宿主新增的 media 能力裁本机音频。
 *
 * 为什么只支持本机：远程单集要裁片段，得先整集下载（几百 MB）。静默替用户拉一遍
 * 不符合「听播客」这个场景的成本预期，所以远程单集直接提示先下载。
 * 输出是 WAV（宿主解码后写的 PCM），不追求平台兼容，只保证「能听、能定位」。
 */

const SBT_KEY = 'bites';
const SBT_MAX = 60;
const SBT_SPAN = 60; // 默认裁 60 秒

MyTPlugins.define('soundbite', {
  contributions: {
    'slot:soundbite-episode': {
      mount(node, ctx, payload) {
        const api = ctx.api;
        if (!payload || !payload.episodeId) return;
        node.innerHTML = '<button class="btn ghost sbt-btn" type="button" title="把正在听的 60 秒裁成本机音频片段">✂ 片段</button>';
        const btn = node.querySelector('.sbt-btn');
        const paint = () => {
          const n = readBites(api).filter(b => b.episodeId === payload.episodeId).length;
          btn.textContent = n ? '✂ 片段（' + n + '）' : '✂ 片段';
        };
        btn.onclick = async () => {
          btn.disabled = true;
          try {
            const res = await cutNow(api, payload);
            if (res) paint();
          } finally {
            btn.disabled = false;
          }
        };
        paint();
        this._off = api.on('player:open', paint);
      },
      unmount() {
        if (this._off) { try { this._off(); } catch (e) {} this._off = null; }
      },
    },
    'page:soundbite': {
      render(el, ctx) {
        const api = ctx.api;
        const draw = () => {
          const bites = readBites(api).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
          el.innerHTML =
            '<div class="page-head"><div><div class="eyebrow">SOUNDBITE</div><h1>片段库</h1>' +
            '<div class="subtitle">' + (bites.length ? bites.length + ' 个片段 · 文件在应用数据目录 clips/ 下' : '还没有片段。在单集页点「✂ 片段」。') + '</div></div></div>' +
            '<div class="card card-pad">' + (bites.length ? bites.map(biteRow).join('')
              : '<div class="sbt-muted">片段只对已下载到本机的单集生效：远程单集先点「⤓ 整集下载」。</div>') + '</div>';
          el.querySelectorAll('[data-sbt-copy]').forEach(btn => {
            btn.onclick = async () => {
              const path = btn.dataset.sbtCopy;
              try {
                await navigator.clipboard.writeText(path);
                api.toast('片段路径已复制');
              } catch (err) {
                api.toast('复制失败：' + (err.message || err), 'warn');
              }
            };
          });
          el.querySelectorAll('[data-sbt-del]').forEach(btn => {
            btn.onclick = () => {
              api.storage.set(SBT_KEY, readBites(api).filter(b => b.id !== btn.dataset.sbtDel));
              draw();
            };
          });
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

function readBites(api) {
  const raw = api.storage.get(SBT_KEY, []);
  return Array.isArray(raw) ? raw.filter(b => b && b.id) : [];
}

function fmtClock(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function biteRow(bite) {
  return '<div class="sbt-row">' +
    '<div class="sbt-meta"><span class="sbt-time">' + fmtClock(bite.t) + ' → ' + fmtClock(bite.end) + '</span>' +
    '<span class="sbt-muted">' + fmtClock(bite.seconds) + ' · ' + fmtBytes(bite.bytes) + '</span></div>' +
    '<div class="sbt-title">' + escapeHtml(bite.title || '') + '</div>' +
    '<div class="sbt-path">' + escapeHtml(bite.path || '') + '</div>' +
    '<div class="sbt-actions"><button class="btn ghost" type="button" data-sbt-copy="' + escapeAttr(bite.path || '') + '">复制路径</button>' +
    '<button class="btn ghost" type="button" data-sbt-del="' + escapeAttr(bite.id) + '">删除</button></div>' +
    '</div>';
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  return (v / 1024 / 1024).toFixed(1) + ' MB';
}

async function cutNow(api, payload) {
  const st = api.player.state();
  if (!api.media || !api.media.available()) {
    api.toast('当前壳没有本机媒体能力（网页版不支持裁片段）。', 'warn');
    return null;
  }
  if (!st.episodeId || st.episodeId !== payload.episodeId) {
    api.toast('先点「▶ 播放单集」，播放这一集时再裁片段。');
    return null;
  }
  const localPath = st.localPath || payload.localPath || '';
  if (!localPath) {
    api.toast('这一集还没下到本机。先点「⤓ 整集下载」，再回来裁片段。', 'warn');
    return null;
  }
  const duration = Number(st.duration) || Number(payload.duration) || 0;
  const now = Number(st.time) || 0;
  // 以「听到的位置」为中心取 60 秒，贴开头/结尾时自动内移，不裁出半个空段。
  let start = Math.max(0, now - SBT_SPAN / 3);
  let end = start + SBT_SPAN;
  if (duration && end > duration - 1) {
    end = Math.max(start + 5, duration - 1);
    start = Math.max(0, end - SBT_SPAN);
  }
  try {
    const res = await api.media.cut(localPath, Math.round(start * 1000), Math.round(end * 1000));
    if (!res || !res.path) throw new Error('宿主没有返回片段路径');
    const bites = readBites(api);
    const bite = {
      id: 'sbt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      showKey: st.showKey, showName: st.showName, episodeId: st.episodeId, title: st.title,
      t: Math.round(start), end: Math.round(start + (Number(res.seconds) || SBT_SPAN)),
      seconds: Math.round(Number(res.seconds) || 0),
      bytes: Number(res.bytes) || 0,
      path: res.path,
      createdAt: Date.now(),
    };
    bites.unshift(bite);
    api.storage.set(SBT_KEY, bites.slice(0, SBT_MAX));
    api.toast('已裁好 ' + fmtClock(bite.seconds) + ' 片段 · 共 ' + Math.min(bites.length, SBT_MAX) + ' 个');
    return bite;
  } catch (err) {
    api.toast('裁片段失败：' + (err.message || err), 'warn');
    return null;
  }
}

function escapeHtml(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(text) { return escapeHtml(text).replace(/\n/g, ' '); }
