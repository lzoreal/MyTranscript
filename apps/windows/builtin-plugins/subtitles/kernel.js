// 字幕数据内核：JSON/VTT 解析、词级对齐、句子切分、双语合并。
// 这个文件由 Rust 在注入 main.js 之前拼进同一个脚本作用域，不依赖播放器私有变量。
const tsec = t => {
  const m = /^(\d+):(\d{2}):(\d{2})\.(\d{3})$/.exec(t);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000 : NaN;
};
function jsonWords(words) {
  if (!Array.isArray(words)) return [];
  return words.map(w => Array.isArray(w) ? w : [w.w, Math.round((w.s || 0) * 1000), Math.round(((w.e || 0) - (w.s || 0)) * 1000)]);
}
function splitJsonBody(text) {
  // 导出格式固定是「英文\n译文」。第二行没有汉字就当作缺译文：模型偶尔把英文
  // 原文写进译文位，交给 splitBilingual 按脚本猜会把两行英文拼成一句。
  const raw = String(text || '');
  const cut = raw.indexOf('\n');
  if (cut < 0) return { en: raw.trim(), zh: '' };
  const second = raw.slice(cut + 1).trim();
  return { en: raw.slice(0, cut).trim(), zh: /[\u3400-\u9fff]/.test(second) ? second : '' };
}
function splitBilingual(text) {
  const raw = String(text || '');
  if (!raw.includes('\n')) return { en: raw.trim(), zh: '' };
  const cut = languageSplitIndex(raw);
  if (cut < 0) {
    const lines = raw.split('\n');
    return { en: lines.filter(l => scriptOf(l) !== 'cjk').join(' ').trim(),
             zh: lines.filter(l => scriptOf(l) === 'cjk').join(' ').trim() };
  }
  return { en: raw.slice(0, cut).trim(), zh: raw.slice(cut + 1).trim() };
}
/* 词级 JSON 的 segments 是「英文 + 译文」同段导出的，中文和英文天然一一对应。
   旧版曾用时长短/汉字数做相关，猜「译文整体落后几句」；这个启发式会被一句长停顿
   误导，一旦锁到负偏移就永不回退，把本来对齐的译文整体左移（SmartLess 13:19 就是
   这样错的）。中文时间戳本来就跟着同段英文，merge() 会按时间窗口配对，所以这里
   不再做任何猜测，原样交给 merge()。 */
function parseJson(doc) {
  const sentences = Array.isArray(doc.sentences) ? doc.sentences.map(s => ({
    startTime: s.start, endTime: s.end,
    body: [s.en, s.zh].filter(Boolean).join('\n'),
    words: jsonWords(s.words),
  })) : [];
  const segs = Array.isArray(doc.segments) ? doc.segments : sentences;
  const vtt = [], side = [], zh = [];
  for (const s of segs) {
    const start = Number.isFinite(s.start) ? s.start / 1000 : Number(s.startTime) || 0;
    const endMs = Number.isFinite(s.end) ? s.end : Math.round((Number(s.endTime) || start + 2) * 1000);
    const end = endMs / 1000;
    const split = splitJsonBody(s.body ?? s.text ?? '');
    const en = split.en || (scriptOf(s.text || '') === 'cjk' ? '' : (s.text || ''));
    if (!en && !split.zh) continue;
    vtt.push({ start, end, speaker: s.speaker || '', text: en });
    side.push({ start: Math.round(start * 1000), end: endMs, speaker: s.speaker || '', text: en || split.zh, words: jsonWords(s.words) });
    // 永远 push：译文偶尔缺失，索引也必须和英文一一对应，否则整集会错位。
    zh.push({ start, end, text: split.zh });
  }
  return {
    vtt,
    sidecar: { audio_seconds: Number(doc.audio_seconds) || 0, complete: true, native: true, segments: side },
    zhVtt: zh.length ? zh : null,
  };
}
// 英文 VTT 已不发布时，用词级 sidecar 的段文本当作 cue 源。
function vttFromSidecar(sidecar) {
  const segs = Array.isArray(sidecar?.segments) ? sidecar.segments : [];
  return segs.map(s => {
    const words = Array.isArray(s.words) ? s.words : [];
    const last = words.length ? words[words.length - 1] : null;
    const start = Number.isFinite(s.start) ? s.start : 0;
    const fallbackEnd = last ? last[1] + Math.max(0, last[2]) : start + 1000;
    const end = Number.isFinite(s.end) ? s.end : fallbackEnd;
    return { start: start / 1000, end: end / 1000, speaker: s.speaker || '', text: s.text || '' };
  });
}
function parseZhVTT(text) {
  const out = [];
  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n').filter(l => l.trim() !== '');
    if (!lines.length || /^WEBVTT/.test(lines[0])) continue;
    let i = 0;
    if (!lines[i].includes('-->') && /^\d+$/.test(lines[i].trim())) i++;
    const line = lines[i];
    if (!line || !line.includes('-->')) continue;
    const m = line.match(/(\d+:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d+:\d{2}:\d{2}\.\d{3})/);
    if (!m) continue;
    const parsed = lines.slice(i + 1).map(l => {
      const v = l.match(/^<v\s+([^>]+)>\s*([\s\S]*)$/);
      return { speaker: v ? v[1].trim() : '', text: (v ? v[2] : l).replace(/<[^>]+>/g, '').trim() };
    }).filter(l => l.text);
    const zh = parsed.find(l => scriptOf(l.text) === 'cjk') || null;
    out.push({ start: tsec(m[1]), end: tsec(m[2]), speaker: zh ? zh.speaker : '', text: zh ? zh.text : '' });
  }
  return out;
}
function parseVtt(text) {
  const primary = [], zh = [];
  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n').filter(l => l.trim() !== '');
    if (!lines.length || /^WEBVTT/.test(lines[0])) continue;
    let i = 0;
    if (!lines[i].includes('-->') && /^\d+$/.test(lines[i].trim())) i++;
    const line = lines[i];
    if (!line || !line.includes('-->')) continue;
    const m = line.match(/(\d+:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d+:\d{2}:\d{2}\.\d{3})/);
    if (!m) continue;
    const parsed = lines.slice(i + 1).map(l => {
      const v = l.match(/^<v\s+([^>]+)>\s*([\s\S]*)$/);
      return { speaker: v ? v[1].trim() : '', text: (v ? v[2] : l).replace(/<[^>]+>/g, '').trim() };
    }).filter(l => l.text);
    const lat = parsed.filter(l => scriptOf(l.text) !== 'cjk');
    const cjk = parsed.filter(l => scriptOf(l.text) === 'cjk');
    const start = tsec(m[1]), end = tsec(m[2]);
    if (lat.length) primary.push({ start, end, speaker: lat[0].speaker, text: lat.map(x => x.text).join(' ') });
    if (cjk.length) zh.push({ start, end, speaker: cjk[0].speaker, text: cjk.map(x => x.text).join(' ') });
  }
  return { primary, zh, hasLatin: primary.length > 0, hasCjk: zh.length > 0 };
}
function scriptOf(text) {
  let latin = 0, cjk = 0, other = 0;
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;
    const cp = ch.codePointAt(0);
    if (/\p{Script=Latin}/u.test(ch)) latin++;
    else if ((cp >= 0x3040 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7af)) cjk++;
    else other++;
  }
  if (!latin && !cjk) return other ? 'other' : 'unknown';
  if (cjk >= latin && cjk >= other) return 'cjk';
  if (latin >= cjk && latin >= other) return 'latin';
  return 'other';
}
function languageSplitIndex(text) {
  const first = text.indexOf('\n');
  if (first < 0) return -1;
  let firstScript = 'unknown', lineStart = 0;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd < 0) lineEnd = text.length;
    firstScript = scriptOf(text.slice(lineStart, lineEnd));
    if (firstScript !== 'unknown') break;
    if (lineEnd === text.length) break;
    lineStart = lineEnd + 1;
  }
  if (firstScript === 'unknown') return first;
  let logicalEnd = text.length;
  while (logicalEnd > 0 && text[logicalEnd - 1] === '\n') logicalEnd--;
  let lastLineEnd = logicalEnd;
  while (lastLineEnd > 0) {
    const lastLineStart = text.lastIndexOf('\n', lastLineEnd - 1) + 1;
    if (scriptOf(text.slice(lastLineStart, lastLineEnd)) === firstScript) {
      return lastLineEnd === logicalEnd ? -1 : lastLineEnd;
    }
    if (lastLineStart === 0) break;
    lastLineEnd = lastLineStart - 1;
  }
  return first;
}
function isTrailingChar(c) {
  return '"\'”“’!?)]】」』》。！？…'.includes(c);
}
function isSentenceEnd(text, index, length) {
  const c = text[index];
  if ('。！？…!?'.includes(c)) return true;
  if (c !== '.') return false;
  if (index + 1 >= length) return true;
  const prev = text[index - 1], next = text[index + 1];
  if (index > 0 && /\d/.test(prev) && /\d/.test(next)) return false;
  return /\s/.test(next) || next === '\u00a0' || '"”“\''.includes(next);
}
function chunkStarts(text, length) {
  const starts = [0];
  let last = 0;
  for (let i = 0; i < length; i++) {
    if (!isSentenceEnd(text, i, length)) continue;
    let boundary = i + 1;
    while (boundary < length && isTrailingChar(text[boundary])) boundary++;
    if (boundary > last) { starts.push(boundary); last = boundary; }
  }
  if (length > last) starts.push(length);
  return starts;
}
function sentenceRanges(text) {
  const out = [];
  const split = languageSplitIndex(text);
  const blocks = split >= 0 ? [[0, split], [split + 1, text.length]] : [[0, text.length]];
  for (const [bs, be] of blocks) {
    if (be <= bs) continue;
    const block = text.slice(bs, be);
    const starts = chunkStarts(block, block.length);
    for (let i = 0; i + 1 < starts.length; i++) {
      let s = bs + starts[i], e = bs + starts[i + 1];
      while (s < e && /\s/.test(text[s])) s++;
      while (e > s && /\s/.test(text[e - 1])) e--;
      if (e > s) out.push({ s, e, text: text.slice(s, e) });
    }
  }
  return out;
}
function wordOffsets(text, words) {
  if (!words.length) return null;
  const toks = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) toks.push({ t: m[0], s: m.index, e: m.index + m[0].length });
  const wt = words.map(w => w.t);
  let base = -1;
  for (let k = 0; k + wt.length <= toks.length && base < 0; k++) {
    let ok = true;
    for (let j = 0; j < wt.length; j++) if (toks[k + j].t !== wt[j]) { ok = false; break; }
    if (ok) base = k;
  }
  if (base < 0) return null;
  return words.map((w, j) => ({ w, s: toks[base + j].s, e: toks[base + j].e }));
}
function splitCueIntoSentences(cue) {
  const ranges = sentenceRanges(cue.text);
  if (ranges.length < 2) return [cue];
  const total = Math.max(1, cue.text.length);
  const start = cue.start;
  const end = cue.end != null ? cue.end : start + Math.max(2, total / 15);
  const bounds = ranges.map(r => start + (end - start) * (r.s / total));
  const parts = ranges.map((r, i) => ({
    i: 0, start: bounds[i], end: i + 1 < ranges.length ? bounds[i + 1] : end,
    speaker: cue.speaker, text: r.text, words: [], native: cue.native, fromJson: cue.fromJson, hasWords: false
  }));
  const mapped = wordOffsets(cue.text, cue.words);
  if (mapped) {
    for (const { w, s } of mapped) {
      let k = ranges.findIndex(r => s >= r.s && s < r.e);
      if (k < 0) k = ranges.length - 1;
      parts[k].words.push(w);
    }
  } else {
    for (const w of cue.words) {
      let k = -1;
      for (let j = 0; j < parts.length; j++) {
        if (w.s >= parts[j].start && w.s < parts[j].end) { k = j; break; }
      }
      if (k < 0) k = w.s < parts[0].start ? 0 : parts.length - 1;
      parts[k].words.push(w);
    }
  }
  parts.forEach(p => {
    if (p.words.length) {
      p.start = Math.min(...p.words.map(w => w.s));
      p.end = Math.max(...p.words.map(w => w.e));
    } else p.quiet = true;
  });
  return parts;
}
function splitCueZh(cue) {
  const ranges = sentenceRanges(cue.zh);
  if (ranges.length < 2) return [{ ...cue, text: cue.zh, words: [], quiet: true }];
  const total = Math.max(1, cue.zh.length);
  const start = cue.start;
  const end = cue.end != null ? cue.end : start + Math.max(2, total / 8);
  const bounds = ranges.map(r => start + (end - start) * (r.s / total));
  return ranges.map((r, i) => ({
    i: 0, start: bounds[i], end: i + 1 < ranges.length ? bounds[i + 1] : end,
    speaker: cue.speaker, text: r.text, words: [], native: cue.native, fromJson: cue.fromJson, hasWords: false, quiet: true
  }));
}
function attachZh(parts, cue) {
  if (!cue.zh) return;
  const zs = sentenceRanges(cue.zh).map(r => r.text);
  if (!zs.length) return;
  parts.forEach((p, i) => { p.zh = zs[i] || ''; });
  if (zs.length > parts.length) parts[parts.length - 1].zh = zs.slice(parts.length - 1).join('');
}
function finalizeCues(cues) {
  cues.forEach((c, i) => {
    const fallbackEnd = c.end != null ? c.end : c.start + Math.max(2, (c.text || '').length / 15);
    let speechStart = c.words.length ? c.words[0].s : c.start;
    // 不因首词与第二词之间有较长停顿就直接跳过首词：这可能是真实停顿，
    // 跳过会让整句直到第二个词才激活。真正异常的长首词由下面的重叠检测单独处理。
    const speechEnd = c.words.length ? Math.max(...c.words.map(w => w.e)) : fallbackEnd;
    c.i = i; c.speechStart = speechStart; c.speechEnd = speechEnd; c.hasWords = c.words.length > 0;
  });
  // 首词被拉成 >1.5 秒、且压住上一句的句尾：它是对齐粘过来的上一句尾巴，
  // 实际语音从第二个词开始（899 的 "And" 2.7 秒）。激活起点跳过它。
  // 只对修正过的 sidecar 生效；词级 JSON 的首词就是 ASR 判定的词，跳过会漏字。
  for (let i = 1; i < cues.length; i++) {
    const c = cues[i], lead = c.words[0];
    if (!c.native && c.words.length > 1 && lead && lead.e - lead.s > 1.5 && lead.s < cues[i - 1].speechEnd - 0.2) {
      c.speechStart = c.words[1].s;
    }
  }
  return cues;
}
function smoothCompressedWords(words) {
  let i = 0;
  while (i < words.length) {
    let j = i;
    while (j < words.length && (words[j].e - words[j].s) < 0.12) j++;
    const n = j - i;
    if (n >= 3 && j < words.length) {
      const start = words[i].s, runEnd = words[j - 1].e, next = words[j].s;
      const gap = next - runEnd;
      if (gap > 0.8 && (runEnd - start) < 0.4) {
        const step = Math.min(0.6, Math.max(0.18, gap / n));
        for (let k = i; k < j; k++) {
          words[k].s = start + step * (k - i);
          words[k].e = Math.min(next, start + step * (k - i + 1));
        }
      }
    }
    i = j > i ? j : i + 1;
  }
}
function merge(vtt, sidecar, zhVtt, options = {}) {
  const segs = Array.isArray(sidecar?.segments) ? sidecar.segments : [];
  const native = sidecar?.native === true;
  // 长度相等也可能是两条流各自漂移；先按时间抽查，抽不上再退回逐条匹配。
  const aligned = segs.length === vtt.length && vtt.every((c, i) =>
    Math.abs((Number(segs[i]?.start) || 0) / 1000 - c.start) < 1.5);
  const zh = Array.isArray(zhVtt) ? zhVtt : [];
  // 中文永远按时间找，不再“长度相等就按下标取”。
  // 规则：译文起点必须落在本句起点前 0.8s ~ 本句结束+0.25s 的窗口里；
  // 找不到就宁可留空，也不把上一句/下一句的译文贴过来。
  const zhForCue = cue => {
    const start = Number(cue.start) || 0;
    const end = Number.isFinite(cue.end) ? cue.end : start + 2;
    const lo = start - 0.8, hi = end + 0.25;
    let best = null, gap = Infinity;
    for (const z of zh) {
      const zs = Number(z.start);
      if (!Number.isFinite(zs) || zs < lo || zs > hi) continue;
      const d = Math.abs(zs - start);
      if (d < gap) { gap = d; best = z; }
    }
    return best;
  };
  let cues = vtt.map((c, i) => {
    const s = aligned ? segs[i] : (segs[i] && Math.abs((Number(segs[i].start) || 0) / 1000 - c.start) < 1 ? segs[i] : null);
    const words = (s?.words || []).map(([t, st, dur]) => ({ t, s: st / 1000, e: (st + Math.max(0, dur)) / 1000 }));
    if (!native) smoothCompressedWords(words);
    for (let k = 0; k < words.length; k++) {
      if (words[k].e <= words[k].s) {
        const nx = words.slice(k + 1).find(w => w.s > words[k].s);
        words[k].e = nx ? nx.s : Math.max(words[k].s + 0.12, (s?.end ? s.end / 1000 : c.end));
      }
    }
    const start = s && Number.isFinite(s.start) ? s.start / 1000 : c.start;
    const end = s && s.end != null ? s.end / 1000 : null;
    return { i, start, end, speaker: s?.speaker || c.speaker || '',
             text: c.text || s?.text || '', zh: (zhForCue({ start, end }) || {}).text || '',
             words, native, fromJson: !!s, hasWords: words.length > 0 };
  });
  let lang = options.lang || 'en';
  const segment = !!options.segment;
  if (lang === 'zh' && !cues.some(c => c.zh)) lang = 'en';
  if (lang === 'zh') {
    const out = [];
    for (const cue of cues) {
      if (!cue.zh) { out.push({ ...cue, words: [], quiet: true }); continue; }
      out.push(...(segment ? splitCueZh(cue) : [{ ...cue, text: cue.zh, words: [], quiet: true }]));
    }
    cues = out;
  } else if (segment) {
    const out = [];
    for (const cue of cues) {
      const parts = splitCueIntoSentences(cue);
      if (lang === 'both' && cue.zh) attachZh(parts, cue);
      out.push(...parts);
    }
    cues = out;
  }
  return finalizeCues(cues);
}
window.MytSubtitleKernel = {
  parseJson, merge, parseVtt, parseZhVTT, vttFromSidecar, splitBilingual,
};
