/* layer: transport —— 播放的单一入口
   谁可以播、播什么、播失败怎么提示，只在这里决定。

   之前同一件事有三个入口：05 的播放键、04 给插件的 `player.play/pause/toggle/setRate`、
   10 的 mediaSession（系统媒体键）。三处各自 `audio.play().catch(() => {})`，
   于是插件里点播放失败时静默、UI 里点播放失败时有 toast，行为不一致。

   接口（小而深）：
     play() / pause() / toggle()  —— 带前置校验（有集、有 src）与失败提示
     rate(r)                      —— 0.5–3 区间钳制，全站唯一改倍速的地方
     now()                        —— { paused, time, duration, rate } 快照
     on(type, fn)                 —— 转发到底层 audio 事件

   底层 `audio` 是 00-runtime 的单例；本模块不持有状态，也不碰字幕。
   切集、恢复进度仍由 05 决定——这里只管"当前这一集怎么放"。 */
import { audio, state } from './00-runtime.js';
import { lazyFn, registerLayer } from './00-layers.js';

const showToast = lazyFn('01-theme-reader-shell', 'showToast');
const status = lazyFn('01-theme-reader-shell', 'status');

function play() {
  if (!state.current) return false;
  if (!audio.getAttribute('src')) {
    status('该集没有音频地址。', 'warn');
    showToast('该集没有音频地址。');
    return false;
  }
  audio.play().catch(e => {
    status('播放失败：' + e.message, 'warn');
    showToast('播放失败：' + e.message);
  });
  return true;
}

function pause() {
  audio.pause();
  return true;
}

function toggle() {
  if (audio.paused) return play();
  pause();
  return false;
}

function rate(value) {
  const before = audio.playbackRate;
  const next = Math.max(0.5, Math.min(3, Number(value) || 1));
  audio.playbackRate = next;
  return next === before ? false : next;
}

function now() {
  return {
    paused: audio.paused,
    time: Number(audio.currentTime) || 0,
    duration: Number.isFinite(audio.duration) ? audio.duration : 0,
    rate: audio.playbackRate || 1,
  };
}

function on(type, fn) { audio.addEventListener(type, fn); }

export { now, on, pause, play, rate, toggle };
registerLayer('14-transport', { play, pause, toggle, rate, now, on });
