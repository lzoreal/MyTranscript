# capture-spike

WASAPI 设备级 loopback 采集 + 现有 sherpa 流式识别的验证工具。
**不是产品代码**，只用来量延迟、CPU 和前端丢音频的边界。

## 用法

```powershell
cd apps/windows/capture-spike
$env:CARGO_TARGET_DIR="C:\tmp\cargo-target-spike"   # D 盘 target 会撞 proc-macro2 的 os error 145
cargo build

# 实时采集 30 秒（运行期间用任意播放器放英文）
C:\tmp\cargo-target-spike\debug\capture-spike.exe --seconds 30 --threads 1

# 同时把采集到的 16k mono 音频存下来，事后复现
capture-spike.exe --seconds 25 --dump C:\tmp\capture.wav

# 离线识别同一个 dump（区分「采集丢」和「识别丢」）
capture-spike.exe --file C:\tmp\capture.wav

# 其它参数
--model <dir>   模型目录，默认 C:\ProgramData\MyTranscript\models\en-mini
--threads N     识别线程数，默认 2（实测 1 更划算，见下）
--pad S         先喂 S 秒静音（用来验证前置 padding 能否救回开头）
--chunk MS      每次喂给识别的音频长度，默认 100ms
--pid N         进程级 loopback：只抓 PID N 及其子进程渲染的声音
```

进程级模式走 `ActivateAudioInterfaceAsync` + `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`，
需要 Windows 10 build 20348 以上；听不到目标进程时反而会完全不出包（不会误抓系统混音）。

注意：激活参数（`PROPVARIANT` + `AUDIOCLIENT_ACTIVATION_PARAMS`）必须比 `IAudioClient`
活得久，spike 里用 `Box::leak` 固定住；如果放在栈上，函数返回时堆会直接损坏（0xC0000374）。

## 进程级隔离实测（2026-11-19）

两个独立 pwsh 同时播放：A 念 pangram，B 念水果词。spike 只抓 A：

| 目标 | 首行 | 滞后中位 | 滞后 p95 | CPU | 结果 |
| --- | --- | --- | --- | --- | --- |
| PID A（pangram） | 1.38 s | 0.25 s | 0.46 s | 5% | 全文只有 pangram，B 的水果词 0 次出现 |
| PID B（水果词） | 1.68 s | 0.30 s | 0.40 s | 5% | 全文只有水果词，A 的 pangram 0 次出现 |

静音占比 37% / 24%，正好对应“目标进程没出声、另一个进程在出声”的时段——说明没有混入系统混音。

## 实测（2026-11-19，本机 Windows 10.0 build 26300 / 26H2）

设备混音格式：48000 Hz / 2 ch / float32。

| 指标 | 1 线程 | 2 线程 |
| --- | --- | --- |
| 识别滞后 中位 | 0.25 s | 0.27 s |
| 识别滞后 p95 | 0.44 s | 0.44 s |
| CPU（单核百分比） | **3%** | 31% |
| 首行出现 | 7.0 s（含 2 s 起步 + 5 s 语音） | 7.9 s |

结论：**用 1 线程**。2 线程没有降低滞后，CPU 却高一个数量级（ONNX Runtime 的 intra-op 线程自旋）。

## 已知问题

1. **每段音频开头约 1.4 s 不进结果。**
   干净 TTS 音频实测：`timestamps` 从 1.48 s 才开始，前面 "This is a" / "Hello" 整段消失。
   模型元数据：`decode_chunk_len=32`、`left_context_len=64`，与现象吻合。
   试过先喂 1.5 / 2.0 s 静音，无效（反而更差），说明不是简单的 padding 问题。
   影响：字幕流每次启动会吞掉第一句话的一部分；持续收听不受影响。
2. 设备热插拔、默认设备切换：spike 不做；桌面壳 `captions.rs` 已补 2 秒巡检重连。
   进程级模式不跟默认设备走，目标进程退出后重连会失败并结束字幕。
3. 独占模式 / DRM 内容：loopback 拿到静音，不会报错，靠 RMS 判断。
4. 没有音频时 loopback **完全不产包**（不是产静音包），所以「采集时长」小于墙钟时间是正常的。

## 与主程序的关系

`src/asr.rs` 通过 `#[path]` 直接复用 `apps/windows/src-tauri/src/asr.rs`，
链接同一份 `vendor/sherpa`。所以这里量到的延迟/CPU/前端丢词，就是桌面壳的量级。
