/* 广告区间：文本侧弱版。
 *
 * 明确不做的事：不做音频指纹、不做跨次下载对比、不做广告提示音检测——那需要
 * 参考音频和稳定的片源，单机 + 单文件场景下拿不到，硬做只会误杀。
 * 这里只认「字幕里明说了这是广告」的句式（sponsored by / 本节目由…赞助），
 * 命中后把相邻句子合成区间。命中率有限，所以在界面上写明「疑似」并给一次撤销：
 * 手动跳过永远可用，自动跳过默认关闭。
 */

const ADS_KEY = 'auto';
const PATTERNS = [
  /sponsored by/i,
  /brought to you by/i,
  /support for this (podcast|episode) (comes|is provided)/i,
  /our (sponsor|partners?) (is|are)/i,
  /use (the )?(promo )?code/i,
  /promo code/i,
  /this episode is sponsored/i,
  /advertisement/i,
  /we'll be right back/i,
  /本节目由.{0,20}(赞助|支持)/,
  /(感谢|由).{0,16}(赞助|冠名)/,
  /优惠码|折扣码|专属链接/,
  /广告时间|广告之后/,
];
const STRONG = [/sponsored by/i, /brought to you by/i, /本节目由.{0,20}(赞助|支持)/, /this episode is sponsored/i];

MyTPlugins.define('adscan', {
  contributions: {
    'slot:adscan-episode': {
      mount(node, ctx, payload) {
        const api = ctx.api;
        if (!payload || !payload.episodeId) return;
        const episodeId = payload.episodeId;
        const timer = { id: 0 };
        this._timer = timer;
        const draw = () => {
          const cues = api.cues ? api.cues() : [];
          const ranges = analyze(cues);
          const auto = !!api.storage.get(ADS_KEY, false);
          if (!cues.length) { node.innerHTML = ''; return; }
          node.innerHTML =
            '<div class="ads-panel">' +
              '<div class="ads-head"><b>广告区间</b><span class="ads-muted">' +
                (ranges.length ? '疑似 ' + ranges.length + ' 段 · 文本启发式' : '没找到明显的赞助句式') +
              '</span>' +
              '<label class="ads-auto"><input type="checkbox" data-ads-auto' + (auto ? ' checked' : '') + '> 自动跳过</label>' +
              '</div>' +
              (ranges.length
                ? ranges.map((r, i) =>
                    '<div class="ads-row"><span class="ads-time">' + fmtClock(r.start) + ' → ' + fmtClock(r.end) + '</span>' +
                    '<span class="ads-why">' + escapeHtml(r.why) + '</span>' +
                    '<button class="btn ghost" type="button" data-ads-skip="' + i + '">跳过这段</button>' +
                    '<button class="btn ghost" type="button" data-ads-jump="' + i + '">听开头</button></div>').join('')
                : '<div class="ads-muted">这个 feed 的文字稿里没有出现「sponsored by / 本节目由…赞助」这类句子。宁可漏，不误杀。</div>') +
              '<div class="ads-note">只认字幕里明说的赞助句式；音乐、口播软广、方言广告都抓不到。自动跳过只在播放这一集时生效。</div>' +
            '</div>';
          node.querySelectorAll('[data-ads-skip]').forEach(btn => {
            btn.onclick = () => {
              const r = ranges[Number(btn.dataset.adsSkip)];
              if (api.player.state().episodeId !== episodeId) { api.toast('先播放这一集。'); return; }
              api.player.seek(r.end + 0.2);
              api.toast('已跳过 ' + fmtClock(r.end - r.start) + ' 的疑似广告');
            };
          });
          node.querySelectorAll('[data-ads-jump]').forEach(btn => {
            btn.onclick = () => {
              const r = ranges[Number(btn.dataset.adsJump)];
              if (api.player.state().episodeId !== episodeId) { api.toast('先播放这一集。'); return; }
              api.player.seek(Math.max(0, r.start - 1));
            };
          });
          const box = node.querySelector('[data-ads-auto]');
          if (box) {
            box.onchange = () => {
              api.storage.set(ADS_KEY, !!box.checked);
              api.toast(box.checked ? '自动跳过已开启（仅本集播放时）' : '自动跳过已关闭');
              arm();
            };
          }
          arm(ranges);
        };
        const arm = ranges => {
          if (timer.id) { clearInterval(timer.id); timer.id = 0; }
          if (!ranges || !ranges.length) return;
          if (!api.storage.get(ADS_KEY, false)) return;
          timer.id = setInterval(() => {
            const st = api.player.state();
            if (st.paused || st.episodeId !== episodeId) return;
            const hit = ranges.find(r => st.time >= r.start && st.time < r.end - 0.5);
            if (!hit) return;
            // 一次跳一段，跳完等下一次 tick；避免同一 tick 连跳造成抖动。
            api.player.seek(hit.end + 0.2);
          }, 1000);
        };
        draw();
        this._off = api.on('player:open', draw);
      },
      unmount() {
        if (this._timer && this._timer.id) { clearInterval(this._timer.id); this._timer.id = 0; }
        if (this._off) { try { this._off(); } catch (e) {} this._off = null; }
      },
    },
  },
});

/* 把命中的句子按「间隔不超过 8 秒」合并成段；短于 6 秒且没有强句式的丢掉，
   因为单句「advertisement」可能只是节目里提了一句广告这个词。 */
function analyze(cues) {
  const hits = [];
  for (let i = 0; i < cues.length; i += 1) {
    const text = String(cues[i].text || '');
    const pat = PATTERNS.find(re => re.test(text));
    if (!pat) continue;
    hits.push({
      start: Number(cues[i].start) || 0,
      end: Number(cues[i].end) || (Number(cues[i].start) || 0) + 3,
      why: text.slice(0, 42) + (text.length > 42 ? '…' : ''),
      strong: STRONG.some(re => re.test(text)),
    });
  }
  const merged = [];
  hits.forEach(hit => {
    const last = merged[merged.length - 1];
    if (last && hit.start - last.end <= 8) {
      last.end = Math.max(last.end, hit.end);
      last.strong = last.strong || hit.strong;
      return;
    }
    merged.push({ ...hit });
  });
  return merged
    .filter(r => (r.end - r.start) >= 6 || r.strong)
    .slice(0, 5)
    .map(r => ({ start: Math.max(0, r.start - 1), end: r.end + 1, why: r.why }));
}

function fmtClock(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function escapeHtml(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
