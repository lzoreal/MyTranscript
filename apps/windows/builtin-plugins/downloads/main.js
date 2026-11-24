// 下载管理功能域插件：接管下载页的分组渲染与空态。
MyTPlugins.define('downloads', {
  contributions: {
    'page:downloads': {
      render(el, ctx) {
        const { $ } = ctx.ui;
        const { entries, refresh } = ctx.downloads;
        const box = $('downloadsGroups');
        if (!box) return;
        /* 正文交给宿主画：宿主那份带「下载中」行、也带没有刷新就看不到新条目的问题修复。
           插件只负责补装饰（视频徽标、「只取音频轨」）。自己再画一份会和宿主打架：
           进度行被抹掉、装饰又被宿主下一次重绘冲掉。 */
        refresh();
        decorateVideoRows(box, entries(), ctx.api);
      },
    },
  },
});

/* 视频集在下载页原来和音频长得一模一样：几百 MB 看不出区别，也拿不到「只要音频」。
   这里在宿主渲染完之后补一个「视频」徽标和一个「只取音频轨」动作——
   输出走本机 media 命令，落盘到 clips/，不动原视频。 */
const VIDEO_RE = /\.(mp4|m4v|mov|webm|mkv|avi)$/i;

function decorateVideoRows(box, entries, api) {
  if (!box || !Array.isArray(entries)) return;
  box.querySelectorAll('.qrow').forEach(row => {
    const playBtn = row.querySelector('[data-play-offline]');
    if (!playBtn) return;
    const key = playBtn.dataset.playOffline;
    const rec = entries.find(item => item && item.key === key);
    if (!rec || !VIDEO_RE.test(String(rec.path || ''))) return;
    const main = row.querySelector('.qmain');
    if (!main || main.querySelector('.dl-video-tag')) return;
    const tag = document.createElement('span');
    tag.className = 'dl-video-tag';
    tag.textContent = '视频';
    (main.querySelector('span') || main).appendChild(tag);
    const actions = playBtn.parentElement;
    const btn = document.createElement('button');
    btn.className = 'mini-btn';
    btn.type = 'button';
    btn.textContent = '只取音频轨';
    btn.onclick = async ev => {
      ev.stopPropagation();
      if (!api.media || !api.media.available()) { api.toast('当前壳没有本机媒体能力。', 'warn'); return; }
      btn.disabled = true;
      btn.textContent = '提取中…';
      try {
        const res = await api.media.extractAudio(rec.path);
        api.toast('已提取音频 · ' + fmtBytes(res.bytes) + ' → ' + res.path, 6000);
        try {
          await navigator.clipboard.writeText(res.path);
        } catch (e) {}
      } catch (err) {
        api.toast('提取失败：' + (err.message || err), 'warn');
      } finally {
        btn.disabled = false;
        btn.textContent = '只取音频轨';
      }
    };
    actions.insertBefore(btn, playBtn);
  });
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
  return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
