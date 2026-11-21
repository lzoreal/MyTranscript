/* 本集问答：检索 + 让模型基于检索到的原话作答。
 *
 * 两段式，故意的：
 * 1) 先在已加载的文字稿里做本地检索（可解释的打分，不调模型），把最相关的 8 段原话
 *    连同 [mm:ss] 一起挑出来；
 * 2) 只把这 8 段喂给模型，要求「只用这些片段回答、每个结论标时间点、没有就说没有」。
 *
 * 这样回答里每个说法都能点回原话，模型编不出来的部分会直接说「这集里没提到」。
 * 不做全文塞进上下文：一集 40 分钟的文字稿几百 KB，既贵又容易让模型自由发挥。
 * 也保留纯检索入口——问题只是想找原话时，不该动模型、不该等。
 */

const ASK_TOP = 8;
const ASK_SYSTEM = [
  '你是播客文字稿的问答助手。',
  '规则：',
  '1. 只使用用户给出的 <片段> 作答，不要用片段之外的知识补全。',
  '2. 每个结论后面标出来源时间点，格式必须是 [m:ss] 或 [h:mm:ss]。',
  '3. 片段里没有相关信息时，直接回答「这集里没提到」，不要猜。',
  '4. 中文作答，简洁，最多 5 句；不要复述问题。',
].join('\n');

MyTPlugins.define('ask', {
  contributions: {
    'slot:ask-episode': {
      mount(node, ctx, payload) {
        const api = ctx.api;
        if (!payload || !payload.episodeId) return;
        const episodeId = payload.episodeId;
        let timer = 0;
        let busy = false;

        node.innerHTML =
          '<div class="ask-panel">' +
            '<div class="ask-head"><b>本集问答</b><span class="ask-muted ask-mode">检索 + AI 作答 · 复用「AI 学英语」的 Key</span></div>' +
            '<div class="ask-box">' +
              '<input class="ask-input" type="search" placeholder="问这一集：他为什么这么说？/ 这集提过哪些车？" aria-label="对本集文字稿提问">' +
              '<button class="btn ghost ask-search" type="button">检索原话</button>' +
              '<button class="btn primary ask-ask" type="button">AI 回答</button>' +
            '</div>' +
            '<div class="ask-answer" hidden></div>' +
            '<div class="ask-results"></div>' +
            '<div class="ask-note">回答只基于本集文字稿里的 8 段原话，时间点可点跳；没有依据时会直接说没有。</div>' +
          '</div>';

        const input = node.querySelector('.ask-input');
        const answerBox = node.querySelector('.ask-answer');
        const results = node.querySelector('.ask-results');
        const askBtn = node.querySelector('.ask-ask');
        const searchBtn = node.querySelector('.ask-search');

        const corpus = () => {
          const st = api.player.state();
          if (st.episodeId !== episodeId) return null;
          const cues = api.cues ? api.cues() : [];
          return cues.length ? cues : null;
        };
        const needCues = () => {
          const cues = corpus();
          if (!cues) {
            results.innerHTML = '<div class="ask-muted">这一集还没有加载文字稿。先点「▶ 播放单集」，等字幕出来再问。</div>';
            return null;
          }
          return cues;
        };

        const renderHits = (hits) => {
          if (!hits.length) {
            results.innerHTML = '<div class="ask-muted">没有找到相关原话。换个更短的说法试试。</div>';
            return;
          }
          results.innerHTML = hits.map((h, i) =>
            '<div class="ask-row" data-ask-i="' + i + '">' +
              '<span class="ask-time">' + fmtClock(h.start) + '</span>' +
              '<span class="ask-text">' + highlight(h.text, input.value) + '</span>' +
            '</div>').join('');
          results.querySelectorAll('[data-ask-i]').forEach(row => {
            row.onclick = () => {
              const hit = hits[Number(row.dataset.askI)];
              if (hit) jumpTo(api, hit.start);
            };
          });
        };

        const doSearch = () => {
          const cues = needCues();
          if (!cues) return;
          const q = String(input.value || '').trim();
          if (!q) { results.innerHTML = ''; return; }
          renderHits(search(cues, q).slice(0, 6));
        };

        const doAsk = async () => {
          if (busy) return;
          const cues = needCues();
          if (!cues) return;
          const q = String(input.value || '').trim();
          if (!q) { api.toast('先写一个问题。'); return; }
          if (!api.llm || !api.llm.ready()) {
            const cfg = api.llm && api.llm.config ? api.llm.config() : {};
            answerBox.hidden = false;
            answerBox.innerHTML = '<div class="ask-muted">还没配置 AI。打开「设置 → AI 学英语」，填 API Key 与模型，问答和学英语共用这一份配置。' +
              (cfg.model ? '（当前模型：' + escapeHtml(cfg.model) + '）' : '') + '</div>';
            return;
          }
          busy = true;
          askBtn.disabled = true;
          answerBox.hidden = false;
          answerBox.innerHTML = '<div class="ask-muted">正在检索原话并让模型作答…</div>';
          try {
            const hits = pickContext(cues, q, ASK_TOP);
            if (!hits.length) {
              answerBox.innerHTML = '<div class="ask-muted">文字稿里没有和这个问题相关的原话，模型没有依据可讲。换个说法再问。</div>';
              return;
            }
            renderHits(hits);
            const reply = await api.llm.chat(ASK_SYSTEM, buildPrompt(q, hits));
            if (ctx.signal && ctx.signal.aborted) return;
            answerBox.innerHTML = renderAnswer(reply);
            answerBox.querySelectorAll('[data-ask-t]').forEach(btn => {
              btn.onclick = () => {
                const sec = parseClock(btn.dataset.askT);
                if (sec != null) jumpTo(api, sec);
              };
            });
          } catch (err) {
            answerBox.innerHTML = '<div class="ask-muted">回答失败：' + escapeHtml(err && err.message ? err.message : err) + '</div>';
          } finally {
            busy = false;
            askBtn.disabled = false;
          }
        };

        input.oninput = () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(doSearch, 350);
        };
        input.onkeydown = ev => {
          if (ev.key !== 'Enter') return;
          ev.preventDefault();
          if (timer) { clearTimeout(timer); timer = 0; }
          doSearch();
        };
        searchBtn.onclick = doSearch;
        askBtn.onclick = doAsk;

        this._cleanup = () => { if (timer) { clearTimeout(timer); timer = 0; } };
      },
      unmount() {
        if (this._cleanup) this._cleanup();
        this._cleanup = null;
      },
    },
  },
});

function jumpTo(api, at) {
  api.player.seek(Math.max(0, Number(at) - 0.4));
  api.toast('跳到 ' + fmtClock(at));
}

/* 检索打分保持可解释：整句命中原串最高，其次命中词数，再按覆盖率。
   不做同义扩展、不做编辑距离——错配比漏配更伤信任。 */
function search(cues, query) {
  const q = String(query).toLowerCase();
  const terms = q.split(/[\s,，。.、;；:：!?！？]+/).filter(t => t.length > 1);
  const phrase = q.replace(/\s+/g, ' ').trim();
  return cues.map((cue, index) => {
    const text = String(cue.text || '');
    const low = text.toLowerCase();
    let score = 0;
    if (phrase && low.includes(phrase)) score += 100;
    let matched = 0;
    terms.forEach(t => { if (low.includes(t)) matched += 1; });
    if (terms.length) {
      score += matched * 12;
      if (matched === terms.length) score += 12;
      score += Math.min(6, Math.floor((matched / Math.max(1, terms.length)) * 6));
    }
    return { index, start: Number(cue.start) || 0, end: Number(cue.end) || 0, text, score };
  }).filter(hit => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.start - b.start);
}

/* 取前 N 段，并把每段的下一句带上：单句常常是半句话，只喂一句模型容易接错。 */
function pickContext(cues, query, limit) {
  const hits = search(cues, query).slice(0, limit);
  return hits.map(hit => ({
    start: hit.start,
    end: hit.end,
    text: [hit.text, String(cues[hit.index + 1] && cues[hit.index + 1].text || '')]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
  }));
}

function buildPrompt(question, hits) {
  const body = hits.map(hit => '[' + fmtClock(hit.start) + '] ' + hit.text).join('\n');
  return '<片段>\n' + body + '\n</片段>\n\n问题：' + question;
}

/* 回答里的 [m:ss] 变成可点的时间点；其余全部转义，避免模型输出把页面结构带坏。 */
function renderAnswer(text) {
  const raw = escapeHtml(String(text || '').trim());
  const withCites = raw.replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g,
    '<button class="ask-cite" type="button" data-ask-t="$1">$1</button>');
  return '<div class="ask-answer-body">' + withCites.replace(/\n/g, '<br>') + '</div>';
}

function parseClock(text) {
  const parts = String(text || '').split(':').map(Number);
  if (!parts.length || parts.some(Number.isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

function highlight(text, query) {
  const raw = escapeHtml(text);
  const terms = String(query).toLowerCase().split(/[\s,，。.、;；:：!?！？]+/).filter(t => t.length > 1);
  if (!terms.length) return raw;
  let out = raw;
  terms.forEach(term => {
    const safe = escapeHtml(term);
    out = out.replace(new RegExp('(' + safe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'), '<mark>$1</mark>');
  });
  return out;
}

function fmtClock(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
    : m + ':' + String(s).padStart(2, '0');
}

function escapeHtml(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
