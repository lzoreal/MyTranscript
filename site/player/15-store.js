/* layer: store —— localStorage 的唯一读写口
   这个仓库里有 16 个 key（`myt-theme*`、`myt-reader`、`myt-prefs`、`myt-showprefs`、
   `myt-scroll`、`myt-mode`、`progress.json` 的前端副本 `myt-progress-*`…），
   外加两族动态键（`myt-ep-<id>`、`myt-rail-<slug>`）。以前 `readJSON / writeJSON`
   住在 05，其余 60 多处直接 `localStorage.getItem/setItem`。

   接口：
     readJSON(key, fallback)        —— 读，坏数据回退到 fallback，不抛
     writeJSON(key, value)          —— 写，配额满时静默失败（用户不该看到 toast）
     removeKey(key)                 —— 删
     listKeys(prefix)               —— 按前缀列键（动态键族的唯一遍历入口）
     migrateKey(from, to, normalize) —— 老键迁到新键，保留原值、迁完删老键

   `subscribe` 故意没做：目前没有任何跨层"写入后要通知"的真实场景，
   等出现第二个真实订阅方再加，别先造一个没人挂的适配器。 */
import { registerLayer } from './00-layers.js';

function readJSON(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    return value == null ? fallback : value;
  } catch (e) { return fallback; }
}

function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch (e) { return false; }
}

function removeKey(key) {
  try { localStorage.removeItem(key); return true; } catch (e) { return false; }
}

function listKeys(prefix = '') {
  const out = [];
  try {
    const p = String(prefix);
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(p)) out.push(key);
    }
  } catch (e) {}
  return out;
}

function migrateKey(from, to, normalize) {
  const raw = readJSON(from, null);
  if (raw == null) {
    removeKey(to);
    return removeKey(from);
  }
  writeJSON(to, typeof normalize === 'function' ? normalize(raw) : raw);
  return removeKey(from);
}

export { listKeys, migrateKey, readJSON, removeKey, writeJSON };
registerLayer('15-store', { readJSON, writeJSON, removeKey, listKeys, migrateKey });
