/* layer: kernel —— 纯函数，不读 DOM、不碰 state。
   拼接后先于主 IIFE 执行；主脚本用同名解构接回，调用点不用改。 */
const MYTK = (() => {
  const fmt = s => { s = Math.max(0, Number(s) || 0); const h = Math.floor(s/3600), m = Math.floor(s%3600/60), x = Math.floor(s%60);
    return h ? `${h}:${String(m).padStart(2,'0')}:${String(x).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(x).padStart(2,'0')}`; };
  const isBracket = t => /^\s*\[.*\]\s*[.!?]?\s*$/.test(t);
  const esc = t => String(t).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const loaderHTML = text => '<div class="loader"><span class="bars"><i></i><i></i><i></i></span><span>' + esc(text) + '</span></div>';
  function findNorm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  function epKey(showKey, epId) { return String(showKey || '') + ':' + String(epId || ''); }
function studyRegexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function studyNormText(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9'’\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function emptyLine(text, action) {
  return '<div class="empty-line">' + esc(text) + (action ? '<div style="margin-top:10px">' + action + '</div>' : '') + '</div>';
}
function statHTML(label, value, note) {
  return '<div class="stat"><label>' + esc(label) + '</label><strong>' + esc(value) + '</strong><em>' + esc(note || '') + '</em></div>';
}
function pluginPageKey(pluginId, pageId) { return String(pluginId) + ':' + String(pageId); }
function isJsonTranscript(transcript) {
  return !!transcript && (transcript.type === 'application/json' || /\.json(?:$|\?)/i.test(transcript.url || ''));
}
  return { fmt, isBracket, esc, loaderHTML, findNorm, epKey, studyRegexEscape, studyNormText, emptyLine, statHTML, pluginPageKey, isJsonTranscript };
})();
