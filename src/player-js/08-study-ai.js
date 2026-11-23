import { $, prefs } from './00-runtime.js';
import { esc, showToast, themeBtns } from './01-theme-reader-shell.js';
import { applySettingsPanes, studyEngine, studyPluginOn, studyRuntime, studyUi, subtitlePluginOn } from './04-local-audio-plugin-host.js';
import { SIDEBAR_META, applySidebarCustomization, normalizeSidebarPrefs, refreshAsrModels, renderLocalAsrModelHint, sidebarOrder } from './05-transport-transcript-nav.js';

import { lazyFn, registerLayer } from './00-layers.js';
const savePrefs = lazyFn('10-desktop-bridge-tail', 'savePrefs');
/* layer: view —— AI 学英语的宿主薄包装
   阶段二后，学习面板/复习/词卡/整集总结/AI 设置的实现都在内置 study 插件的 ui.js；
   本片只保留宿主包装、数据引用与桌面补丁需要的纯函数。跨层调用仍走 kernel / host()。 */
const STUDY_KEY = 'myt-study', STUDY_CACHE_KEY = 'myt-study-cache', STUDY_VOCAB_KEY = 'myt-study-vocab', STUDY_STATUS_KEY = 'myt-study-status';
let STUDY = { provider: 'openai', endpoint: 'https://api.openai.com/v1', key: '', model: 'gpt-4o-mini', target: 'zh-CN' };
let studyCache = {}, studyVocab = [], studyStatus = {};
let studyView = 'card';
let studyAutoPause = false;
function setStudyAutoPause(value) { studyAutoPause = !!value; }
function setStudyView(value) { studyView = String(value || 'card'); }

function applyStudyEngine(engine) {
  if (engine) {
    if (engine.settings) STUDY = engine.settings;
    if (engine.cache) studyCache = engine.cache;
    if (engine.vocab) studyVocab = engine.vocab;
    if (engine.status) studyStatus = engine.status;
  }
  try { syncStudySettings(); } catch (e) {}
  try { studyUpdateDueBadge(); } catch (e) {}
  try { studyApplyWordMarks(); } catch (e) {}
}
function applyStudyRuntime() { /* runtime 由插件注册，宿主无需镜像状态 */ }
function studyUiCall(name, ...args) {
  const ui = typeof studyUi === 'function' ? studyUi() : null;
  if (!ui || typeof ui[name] !== 'function') return undefined;
  return ui[name](...args);
}
function saveStudy() {
  const engine = studyEngine();
  if (engine && engine.saveSettings) { engine.saveSettings(); return; }
  try { localStorage.setItem(STUDY_KEY, JSON.stringify(STUDY)); } catch (e) {}
}
function saveStudyCache() {
  const engine = studyEngine();
  if (engine && engine.saveCache) { engine.saveCache(); return; }
  try { localStorage.setItem(STUDY_CACHE_KEY, JSON.stringify(studyCache)); } catch (e) {}
}
function saveStudyVocab() {
  const engine = studyEngine();
  if (engine && engine.saveVocab) { engine.saveVocab(); return; }
  try { localStorage.setItem(STUDY_VOCAB_KEY, JSON.stringify(studyVocab)); } catch (e) {}
}
function saveStudyStatus() {
  const engine = studyEngine();
  if (engine && engine.saveStatus) { engine.saveStatus(); return; }
  try { localStorage.setItem(STUDY_STATUS_KEY, JSON.stringify(studyStatus)); } catch (e) {}
}

/* 桌面补丁（10）与 04 仍按旧名字调用；全部转发到插件的 ui.js。 */
function applyStudyProvider(id, fillDefaults) { return studyUiCall('applyStudyProvider', id, fillDefaults); }
function bindStudyUI() { return studyUiCall('bindStudyUI'); }
function bindWordStatusButtons(word) { return studyUiCall('bindWordStatusButtons', word); }
function closeStudySheet() {
  const sheet = $('studySheet');
  if (sheet) sheet.classList.remove('on');
  const ui = typeof studyUi === 'function' ? studyUi() : null;
  if (ui && typeof ui.closeStudySheet === 'function') return ui.closeStudySheet();
}
function openStudySheet(view) { return studyUiCall('openStudySheet', view); }
function syncStudySettings() { return studyUiCall('syncStudySettings'); }
function studyResetContext() { return studyUiCall('resetStudyContext'); }
function studyResetPlayback() { const r = studyRuntime(); if (r && r.resetPlayback) r.resetPlayback(); }
function studyResetAutoPause() { const r = studyRuntime(); if (r && r.resetAutoPause) r.resetAutoPause(); }
function wordStatusHTML(word) { return studyUiCall('wordStatusHTML', word) || ''; }
function studyApplyWordMarks() { return studyUiCall('studyApplyWordMarks'); }
function studyUpdateDueBadge() { return studyUiCall('studyUpdateDueBadge'); }
function studyAddVocab(item, cue) { return studyUiCall('studyAddVocab', item, cue); }
function studyMarkWord(raw, status) { return studyUiCall('studyMarkWord', raw, status); }
function studyDueItems() {
  const ui = typeof studyUi === 'function' ? studyUi() : null;
  if (ui && ui.studyDueItems) return ui.studyDueItems();
  const engine = studyEngine();
  return engine && engine.dueItems ? engine.dueItems() : [];
}
function studyStats() {
  const ui = typeof studyUi === 'function' ? studyUi() : null;
  if (ui && ui.studyStats) return ui.studyStats();
  const engine = studyEngine();
  return engine && engine.stats ? engine.stats() : { total: 0, known: 0, due: 0, reviewed: 0 };
}
function studyExportCsv() { return studyUiCall('studyExportCsv'); }
function studyEpisodeHTML(data) { return studyUiCall('studyEpisodeHTML', data) || ''; }
function studyRenderEpisode() { return studyUiCall('studyRenderEpisode'); }
function studyRenderPractice() { return studyUiCall('studyRenderPractice'); }
function studyRenderVocab() { return studyUiCall('studyRenderVocab'); }
function studyRenderReview() { return studyUiCall('studyRenderReview'); }
function studyRenderCurrent() { return studyUiCall('studyRenderCurrent'); }
function studyRenderNow() { return studyUiCall('studyRenderNow'); }
function studyOpenEpisodeSummary(key, id) { return studyUiCall('studyOpenEpisodeSummary', key, id); }
function studyAnalyzeCurrent() { return studyUiCall('studyAnalyzeCurrent'); }
function studyAnalyzeEpisode() { return studyUiCall('studyAnalyzeEpisode'); }
function studyAsk() { return studyUiCall('studyAsk'); }
function studyCheckExercise(v) { return studyUiCall('studyCheckExercise', v); }
function studyStartExercise(t) { return studyUiCall('studyStartExercise', t); }
function studyFetchModels() { return studyUiCall('studyFetchModels'); }
function studyRenderModelList(models) { return studyUiCall('studyRenderModelList', models); }
function studyPickModel(id) { return studyUiCall('studyPickModel', id); }
function studyTestConnection() { return studyUiCall('studyTestConnection'); }
function studyModelStatus(text, color) { return studyUiCall('studyModelStatus', text, color); }
function studyClearModels() { return studyUiCall('studyClearModels'); }

/* 纯函数与运行时包装：保留在宿主，供 10 与外部直接调用。 */
function studyClockSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  const s = String(value || '').trim().replace(/[\[\]]/g, '');
  if (!s) return NaN;
  const parts = s.split(':').map(part => Number(part));
  if (parts.some(part => !Number.isFinite(part))) return NaN;
  if (parts.length === 1) return Math.max(0, parts[0]);
  if (parts.length === 2) return Math.max(0, parts[0] * 60 + parts[1]);
  if (parts.length === 3) return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
  return NaN;
}
function studyLangName() { const r = studyRuntime(); return r ? r.langName() : 'Simplified Chinese'; }
function studyHash(text) { const r = studyRuntime(); return r ? r.hash(text) : String(text || '').length.toString(36); }
function studyProviderMeta() { const r = studyRuntime(); return r ? r.providerMeta() : {}; }
function studyConfig() { const r = studyRuntime(); return r ? r.config() : {}; }
function studyNative() { const r = studyRuntime(); return r ? r.native() : false; }
function studyReady() { const r = studyRuntime(); return r ? r.ready() : false; }
async function studyChat(system, user) {
  const r = studyRuntime();
  if (!r) throw new Error('学英语插件未启用，AI 功能不可用。');
  return await r.chat(system, user);
}
function studyParseJson(text) { const r = studyRuntime(); return r ? r.parseJson(text) : { raw: String(text || '').trim() }; }
function studyCurrentCue() { const r = studyRuntime(); return r ? r.currentCue() : null; }
function studyWithCues(fn) { const r = studyRuntime(); if (r) r.withCues(fn); }
function studyCurrentKey(cur) { const r = studyRuntime(); return r ? r.currentKey(cur) : 'none'; }
function studySourceLabel() { const r = studyRuntime(); return r ? r.sourceLabel() : ''; }
function studyCueBounds(cue) { const r = studyRuntime(); return r ? r.cueBounds(cue) : { start: Number(cue.start), end: Number(cue.end) }; }
function studyStopAudio() { const r = studyRuntime(); if (r) r.stopAudio(); }
function studyPlayRange(start, end, loops = 1) { const r = studyRuntime(); if (r) r.playRange(start, end, loops); }
function studyPlayCue(cue, loops = 1) { const r = studyRuntime(); if (r) r.playCue(cue, loops); }
function studyPlayItem(item) { const r = studyRuntime(); if (r) r.playItem(item); }
function studyAudioTick() { const r = studyRuntime(); if (r) r.audioTick(); }

function syncThemeSwatches() {
  const current = document.documentElement.dataset.theme;
  themeBtns().forEach(button => button.setAttribute('aria-checked', String(button.dataset.theme === current)));
}
function renderSidebarSettings() {
  const hidden = new Set(prefs.sidebar?.hidden || []);
  const row = (route, group, index, total) => {
    const [icon, label] = SIDEBAR_META[route] || ['•', route];
    const checked = !hidden.has(route);
    return '<div class="setting-row sidebar-custom-row">' +
      '<div><strong><span class="sidebar-custom-ico">' + icon + '</span>' + esc(label) + '</strong>' +
      '<p>' + (checked ? '显示在侧边栏' : '已从侧边栏隐藏') + '</p></div>' +
      '<div class="sidebar-custom-actions">' +
      '<button class="btn ghost small" data-sidebar-move="up" data-sidebar-group="' + group + '" data-sidebar-route="' + route + '" aria-label="上移' + esc(label) + '"' + (index === 0 ? ' disabled' : '') + '>↑</button>' +
      '<button class="btn ghost small" data-sidebar-move="down" data-sidebar-group="' + group + '" data-sidebar-route="' + route + '" aria-label="下移' + esc(label) + '"' + (index === total - 1 ? ' disabled' : '') + '>↓</button>' +
      '<button class="switch" data-sidebar-toggle="' + route + '" role="switch" aria-checked="' + String(checked) + '"></button>' +
      '</div></div>';
  };
  const top = $('sidebarTopList');
  if (top) top.innerHTML = sidebarOrder('top').map((route, i, list) => row(route, 'top', i, list.length)).join('');
  const bottom = $('sidebarBottomList');
  if (bottom) bottom.innerHTML = sidebarOrder('bottom').map((route, i, list) => row(route, 'bottom', i, list.length)).join('');
  document.querySelectorAll('[data-sidebar-move]').forEach(btn => {
    btn.onclick = () => moveSidebarRoute(btn.dataset.sidebarRoute, btn.dataset.sidebarGroup, btn.dataset.sidebarMove === 'up' ? -1 : 1);
  });
  document.querySelectorAll('[data-sidebar-toggle]').forEach(btn => {
    btn.onclick = () => toggleSidebarRoute(btn.dataset.sidebarToggle);
  });
}
function moveSidebarRoute(route, group, delta) {
  if (!prefs.sidebar || !prefs.sidebar.order[group]) return;
  const order = [...prefs.sidebar.order[group]];
  const index = order.indexOf(route);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= order.length) return;
  [order[index], order[target]] = [order[target], order[index]];
  prefs.sidebar.order[group] = order;
  savePrefs();
  applySidebarCustomization();
  renderSidebarSettings();
}
function toggleSidebarRoute(route) {
  if (!prefs.sidebar) prefs.sidebar = normalizeSidebarPrefs(null);
  const hidden = new Set(prefs.sidebar.hidden);
  if (hidden.has(route)) hidden.delete(route); else hidden.add(route);
  prefs.sidebar.hidden = [...hidden];
  savePrefs();
  applySidebarCustomization();
  renderSidebarSettings();
}
function resetSidebarSettings() {
  prefs.sidebar = normalizeSidebarPrefs(null);
  savePrefs();
  applySidebarCustomization();
  renderSidebarSettings();
  showToast('侧边栏已恢复默认。');
}
function openSettingsPane(pane, options = {}) {
  if (!options.force) {
    if (!subtitlePluginOn() && ['reader', 'study', 'models'].includes(pane)) pane = 'plugins';
    if (!studyPluginOn() && pane === 'study') pane = 'plugins';
  }
  document.querySelectorAll('#settingsMenu button').forEach(button => button.classList.toggle('active', button.dataset.pane === pane));
  document.querySelectorAll('.settings-pane').forEach(el => el.classList.toggle('active', el.id === 'pane-' + pane));
  if (pane === 'sidebar') renderSidebarSettings();
  if (pane === 'models') { refreshAsrModels(); renderLocalAsrModelHint(); }
  applySettingsPanes(pane);
}
export { STUDY, STUDY_CACHE_KEY, STUDY_KEY, STUDY_STATUS_KEY, STUDY_VOCAB_KEY, applyStudyEngine, applyStudyProvider, applyStudyRuntime, bindStudyUI, bindWordStatusButtons, closeStudySheet, moveSidebarRoute, openSettingsPane, openStudySheet, renderSidebarSettings, resetSidebarSettings, saveStudy, saveStudyCache, saveStudyStatus, saveStudyVocab, setStudyAutoPause, setStudyView, studyAddVocab, studyAnalyzeCurrent, studyAnalyzeEpisode, studyApplyWordMarks, studyAsk, studyAudioTick, studyAutoPause, studyCache, studyChat, studyCheckExercise, studyClearModels, studyClockSeconds, studyConfig, studyCueBounds, studyCurrentCue, studyCurrentKey, studyDueItems, studyEpisodeHTML, studyExportCsv, studyFetchModels, studyHash, studyLangName, studyMarkWord, studyModelStatus, studyNative, studyOpenEpisodeSummary, studyParseJson, studyPickModel, studyPlayCue, studyPlayItem, studyPlayRange, studyProviderMeta, studyReady, studyRenderCurrent, studyRenderEpisode, studyRenderModelList, studyRenderNow, studyRenderPractice, studyRenderReview, studyRenderVocab, studyResetAutoPause, studyResetContext, studyResetPlayback, studySourceLabel, studyStartExercise, studyStats, studyStatus, studyStopAudio, studyTestConnection, studyUiCall, studyUpdateDueBadge, studyView, studyVocab, studyWithCues, syncStudySettings, syncThemeSwatches, toggleSidebarRoute, wordStatusHTML };
registerLayer('08-study-ai', { STUDY, STUDY_CACHE_KEY, STUDY_KEY, STUDY_STATUS_KEY, STUDY_VOCAB_KEY, applyStudyEngine, applyStudyProvider, applyStudyRuntime, bindStudyUI, bindWordStatusButtons, closeStudySheet, moveSidebarRoute, openSettingsPane, openStudySheet, renderSidebarSettings, resetSidebarSettings, saveStudy, saveStudyCache, saveStudyStatus, saveStudyVocab, setStudyAutoPause, setStudyView, studyAddVocab, studyAnalyzeCurrent, studyAnalyzeEpisode, studyApplyWordMarks, studyAsk, studyAudioTick, studyAutoPause, studyCache, studyChat, studyCheckExercise, studyClearModels, studyClockSeconds, studyConfig, studyCueBounds, studyCurrentCue, studyCurrentKey, studyDueItems, studyEpisodeHTML, studyExportCsv, studyFetchModels, studyHash, studyLangName, studyMarkWord, studyModelStatus, studyNative, studyOpenEpisodeSummary, studyParseJson, studyPickModel, studyPlayCue, studyPlayItem, studyPlayRange, studyProviderMeta, studyReady, studyRenderCurrent, studyRenderEpisode, studyRenderModelList, studyRenderNow, studyRenderPractice, studyRenderReview, studyRenderVocab, studyResetAutoPause, studyResetContext, studyResetPlayback, studySourceLabel, studyStartExercise, studyStats, studyStatus, studyStopAudio, studyTestConnection, studyUiCall, studyUpdateDueBadge, studyView, studyVocab, studyWithCues, syncStudySettings, syncThemeSwatches, toggleSidebarRoute, wordStatusHTML });
