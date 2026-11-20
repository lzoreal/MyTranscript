/* 公共动画生命周期：进入、退出、列表位移。
   纯 DOM 层，不依赖播放器状态；所有调用方共用同一套令牌与媒体查询。 */
const OPEN_CLASS = 'on';
const LEAVE_CLASS = 'anim-leaving';
const DONE_PROPS = ['opacity', 'translate', 'transform', 'visibility'];
const FLIP_SELECTOR_TRANSITION = 'translate var(--motion-slow) var(--motion-ease-standard)';

export function motionReduced() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* 取消进行中的退出收尾（重新打开弹层时用），不会把元素藏起来。 */
export function motionCancel(el) {
  if (!el) return;
  if (el.__motionCancel) el.__motionCancel();
  el.__motionToken = (el.__motionToken || 0) + 1;
  el.classList.remove('anim-leaving');
}

export function motionKeyOf(el) {
  if (!el || !el.dataset) return '';
  const data = el.dataset;
  if (data.motionKey) return data.motionKey;
  if (data.ep) return (data.key || '') + '|' + data.ep;
  if (data.openPodcast) return 'pod:' + data.openPodcast;
  if (data.idxKey) return 'idx:' + data.idxKey + '@' + (data.idxT || '');
  if (data.cueSeek) return 'cue:' + data.cueSeek;
  return el.id ? 'id:' + el.id : '';
}

/* 进入：先解除 hidden，等一帧让关闭形态成立，再挂 .on。
   重复调用是幂等的；正在退出时会被取消并从当前位置反向。 */
export function motionEnter(el, options = {}) {
  if (!el) return Promise.resolve();
  const openClass = options.openClass || OPEN_CLASS;
  if (el.__motionCancel) el.__motionCancel();
  const token = (el.__motionToken || 0) + 1;
  el.__motionToken = token;
  el.classList.remove(LEAVE_CLASS);
  if (el.hidden) el.hidden = false;
  if (el.classList.contains(openClass)) return Promise.resolve();
  if (motionReduced() || typeof el.addEventListener !== 'function') {
    el.classList.add(openClass);
    return Promise.resolve();
  }
  /* 先量一次布局，确保 display 从 none 切回后起始帧已经生效。 */
  void el.offsetWidth;
  return new Promise(resolve => {
    let settled = false;
    let timer = 0;
    const finish = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener('transitionend', onEnd);
      el.removeEventListener('animationend', onEnd);
      if (timer) clearTimeout(timer);
      resolve();
    };
    const onEnd = event => {
      if (event.target !== el) return;
      if (event.type === 'transitionend' && !DONE_PROPS.includes(event.propertyName)) return;
      finish();
    };
    el.addEventListener('transitionend', onEnd);
    el.addEventListener('animationend', onEnd);
    requestAnimationFrame(() => {
      if (el.__motionToken !== token) { finish(); return; }
      el.classList.add(openClass);
    });
    /* 事件丢失兜底：正常时长 + 140ms，避免等待方永远挂起。 */
    timer = setTimeout(finish, (Number(options.duration) || 220) + 140);
  });
}

/* 退出：移除 .on、立刻禁止交互，等过渡结束才设置 hidden。
   等待期间重新进入会取消这次收尾，不会把元素藏起来。 */
export function motionLeave(el, options = {}) {
  if (!el) return Promise.resolve();
  const openClass = options.openClass || OPEN_CLASS;
  const hide = options.hide !== false;
  const duration = Number(options.duration) || 220;
  if (el.__motionCancel) el.__motionCancel();
  const token = (el.__motionToken || 0) + 1;
  el.__motionToken = token;
  el.classList.remove(openClass);
  el.classList.add(LEAVE_CLASS);
  if (motionReduced() || typeof el.addEventListener !== 'function') {
    el.classList.remove(LEAVE_CLASS);
    if (hide) el.hidden = true;
    return Promise.resolve();
  }
  return new Promise(resolve => {
    let settled = false;
    let timer = 0;
    const cleanup = () => {
      el.removeEventListener('transitionend', onEnd);
      el.removeEventListener('animationend', onEnd);
      if (timer) clearTimeout(timer);
      if (el.__motionCancel === cancel) el.__motionCancel = null;
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (el.__motionToken === token) {
        el.classList.remove(LEAVE_CLASS);
        if (hide) el.hidden = true;
      }
      resolve();
    };
    const cancel = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onEnd = event => {
      if (event.target !== el) return;
      if (event.type === 'transitionend' && !DONE_PROPS.includes(event.propertyName)) return;
      settle();
    };
    el.addEventListener('transitionend', onEnd);
    el.addEventListener('animationend', onEnd);
    el.__motionCancel = cancel;
    timer = setTimeout(settle, duration + 140);
  });
}

/* 列表位移：只处理同一容器里“更新前后都在”的条目。
   mutate 里做真正的 DOM 更新；返回值可用于等待动画结束。 */
export function motionFlip(container, selector, mutate, options = {}) {
  if (!container) { if (typeof mutate === 'function') mutate(); return Promise.resolve(); }
  if (motionReduced()) {
    if (typeof mutate === 'function') mutate();
    return Promise.resolve();
  }
  const before = new Map();
  const view = container.getBoundingClientRect();
  for (const el of container.querySelectorAll(selector)) {
    const key = motionKeyOf(el);
    if (!key) continue;
    const rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) continue;
    /* 只测量容器可视区附近的条目，长列表滚动到很远的项不参与位移。 */
    if (rect.bottom < view.top - 60 || rect.top > view.bottom + 60) continue;
    before.set(key, rect);
  }
  if (typeof mutate === 'function') mutate();
  const moved = [];
  for (const el of container.querySelectorAll(selector)) {
    const key = motionKeyOf(el);
    if (!key) continue;
    const prev = before.get(key);
    if (!prev) continue;
    const next = el.getBoundingClientRect();
    const dx = prev.left - next.left;
    const dy = prev.top - next.top;
    if (!dx && !dy) continue;
    moved.push({ el, dx, dy });
  }
  if (!moved.length) return Promise.resolve();
  const duration = Number(options.duration) || 240;
  moved.forEach(({ el, dx, dy }) => {
    el.style.transition = 'none';
    el.style.translate = dx + 'px ' + dy + 'px';
  });
  void container.offsetWidth;
  requestAnimationFrame(() => {
    moved.forEach(({ el }) => {
      el.style.transition = FLIP_SELECTOR_TRANSITION;
      el.style.translate = '0 0';
    });
  });
  return new Promise(resolve => {
    setTimeout(() => {
      moved.forEach(({ el }) => {
        el.style.transition = '';
        el.style.translate = '';
      });
      resolve();
    }, duration + 80);
  });
}
