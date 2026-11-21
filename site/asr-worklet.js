/* 视频边看边转写的取音器：把 <video> 的采样降成 16k 左右单声道，攒满一帧就发出去。
 *
 * 为什么放在 AudioWorklet 而不是页面主线程：主线程要渲染、要跑播放器状态机，
 * 音频采样一抖就会丢块；worklet 跑在音频线程，每次 process 拿到固定 128 帧，
 * 丢块只影响一两句，不会让整段识别停住。
 *
 * 只做减采样，不做重采样重构：每 ratio 个样本取平均后当作一个 16k 样本。
 * 对识别（sherpa 自己还有一层特征提取）够用，代价是极高频被削掉——本来也不是
 * 给耳朵听的，出声仍然走原生的 MediaElementSource → destination 那条路。
 */
class MytAsrTap extends AudioWorkletProcessor {
  constructor() {
    super();
    const inRate = Number(sampleRate) || 48000;
    this.ratio = Math.max(1, Math.round(inRate / 16000));
    this.rate = inRate / this.ratio;
    this.out = new Float32Array(1024);
    this.n = 0;
    this.acc = 0;
    this.cnt = 0;
    this.muted = false;
    // 页面侧能随时告诉我们“别喂了”（暂停、拖动、换集）。
    this.port.onmessage = ev => {
      if (ev.data && ev.data.type === 'mute') this.muted = Boolean(ev.data.value);
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i += 1) {
      if (this.muted) continue;
      this.acc += ch[i];
      this.cnt += 1;
      if (this.cnt >= this.ratio) {
        this.out[this.n] = this.acc / this.cnt;
        this.n += 1;
        this.acc = 0;
        this.cnt = 0;
        if (this.n >= this.out.length) {
          this.port.postMessage({ pcm: this.out.slice(0, this.n), rate: this.rate });
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('myt-asr-tap', MytAsrTap);
