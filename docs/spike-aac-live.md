# AAC 视频集「只读音轨」实测（2026-11-22 spike）

目的：判断「MP4/M4A 视频集只播音频时也能实时识别」这条路是否成立，以及要不要顺手把播放流量降下来。

样本：Talking Cars (Video) #2026 · 2「2026 LA Auto Show」
`https://traffic.libsyn.com/secure/talkingcarshq/2611CRO_Talking_Cars_533_HD.mp4?dest-id=212364`
364 MB / 1852.9 s / `ftyp mp42` / moov 在最前（offset 24）/ 音轨是第 2 个 trak（`soun`）

## 一、编码结论：AAC-LC 48 kHz 立体声，symphonia 能吃

从 `stsd → mp4a → esds` 拿到真实参数（不再靠猜）：

| 项 | 值 |
| --- | --- |
| esds | `0319000010041140150006000005aa300001e9bd05021190060102` |
| objectTypeIndication | `0x40`（MPEG-4 Audio） |
| AudioSpecificConfig | `0x1190` → audioObjectType **2 = AAC-LC** |
| 采样率 / 声道 | **48000 Hz / 2** |
| 平均码率 | 125 kbps（max 371 kbps） |
| moov | 1.02 MB，1 次 range 请求，冷连接 3.8 s |
| 音频窗口 | 60 s = 144 chunk，纯音频 0.94 MB（≈15 KB/s） |
| ADTS 头 | **没有**（chunk 首帧字节 `21 0a 10 28`，是裸 AAC 帧；帧边界只能靠 `stsz` 表还原） |

结论：**不需要转码**，缺的只是「把样本表翻译成字节偏移」和「按样本切帧」。风险只剩 HE-AAC（SBR/PS）——本集已确认不是。

## 二、只读音轨的代价：字节 1.00×，延迟是瓶颈

同样取前 N 秒音频，两种取法（连接复用 + 多线程）：

| 取法 | 请求数 | 字节 | 放大 | 耗时 | 实时比 |
| --- | --- | --- | --- | --- | --- |
| 逐 chunk，新建连接（首测） | 144 | 0.90 MB | 1.00× | 434 s | 0.14×（不可用） |
| 逐 chunk，keep-alive 4 路 / 30 s 窗口 | 72 | 0.45 MB | 1.00× | 10.3 s | **2.9×** |
| 逐 chunk，keep-alive 4 路 / 300 s 窗口 | 720 | 4.49 MB | 1.00× | 92.0 s | **3.3×** |
| 逐 chunk，keep-alive 8 路 / 60 s 窗口 | 144 | 0.90 MB | 1.00× | 21.2 s | 2.8×（更差） |
| 一整段连续 range（含中间视频字节） | 1 | 12.38 MB | 13.2× | 25.4 s | 2.4× |

延迟分布（4 路、300 s 窗口）：中位 227 ms，p90 887 ms，最慢 7.2 s；没有 429/超时退化。

合并策略（空隙小于阈值就合成一个请求）对比 60 s 窗口：

| 阈值 | 请求数 | 字节 | 放大 |
| --- | --- | --- | --- |
| 不合并 | 144 | 0.94 MB | 1.0× |
| 16 KB | 143 | 0.96 MB | 1.0× |
| 64 KB | 71 | 4.67 MB | **5.0×** |
| 全并 | 1 | 12.38 MB | 13.2× |

**空隙太大（平均 50~80 KB，中间全是视频帧），合并只省请求不省流量。逐 chunk 取才是正解。**

## 三、冷启动

- moov 1.02 MB：3.8 s（冷连接、无复用）；复用一个连接再取首 chunk：0.205 s。
- 也就是「点了播放到能识别」大约是 4 s 的一次性成本（moov 可缓存复用）。

## 四、浏览器侧能力（当前 WebView2 实测）

在运行中的实例里查（`cap-aac.js`）：

```json
{"webcodecs":"function","mse_mp4":true,"mse_aac":true,"wc_support":true}
```

- `AudioDecoder.isConfigSupported({codec:'mp4a.40.2',…})` → **true**（可直接解裸 AAC，只要把 ASC `0x1190` 当 description）
- `MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"')` → **true**（fMP4 可直接喂 MSE，实现「只播音频」）

## 五、判定

- 实时识别可行：**3.3× 实时余量**（音频只要 15 KB/s，我们拿到 45 KB/s），代价是 144 次/分钟 的小 range 请求；不需要转码，不需要下载整集。
- 现有 `liveProbeAudio` 的 CBR 假设（`from = origin + startSec*bps`）是唯一障碍：换成「样本表 → 偏移」后，上层 `liveFetchWindow*` 与 WASM 喂 PCM 的路径可以原样复用。
- 顺带收益：播放改 fMP4+MSE 后，流量从 24.5 MB/分钟降到约 1.5 MB/分钟。

## 复现脚本（workspace，不进仓库）

- `spike-audio.py`：moov/stbl 解析 + 逐 chunk 实测
- `spike-keepalive.py <url> <seconds> <parallel>`：keep-alive + 并发（首跑因 `exec` 截断缺 `sel`、urllib 未跟重定向，已修）
- `spike-waste.py <url> <seconds>`：连续 range 的放大倍数
- `spike-merge.py <url> <seconds>`：合并阈值曲线
- `spike-coldstart.py <url>`：moov + 首 chunk 冷启动
- `asc-probe.py <url>`：esds / AudioSpecificConfig

## 六、落地后的实机复测（2026-11-22，Tauri 壳内）

发现的第一版问题：宿主 `read_range` 每个请求都新建 reqwest 客户端 → 连接不复用。同一个 10 秒
窗口的音频要 **15.5 s**（0.7× 实时，永远追不上播放）。

把客户端改成全局 `OnceLock<reqwest::Client>` 复用后的同机实测：

| 场景 | 窗口 | 耗时 | 实时比 |
| --- | --- | --- | --- |
| 抓窗口（第 1 次，含冷握手） | 10 s | 7.16 s | — |
| 抓窗口（稳态） | 10 s | 4.66~5.16 s | **约 2×** |
| 抓窗口 | 20 s | 9.19 s | 2.3× |
| 连续播 90 s | — | — | 「已提前」稳定 40~59 s，49 句，0 次失败 |

解码质量：同一窗口连解两次 PCM 完全一致（sameRatio 1.00），peak 0.75 / rms 0.109，
48 kHz→16 kHz 重采样后直接进 sherpa 原生识别，输出正常句子。

对比 Python 侧 3.3×：壳内多了 IPC（每次 Range 一次 `read_range` 调用）和同时还在给
`<audio>` 拉视频流（24.5 MB/分钟）的带宽竞争，2× 已是「识别跑在播放前面」的健康水平。

## 七、只播音轨（MSE）的落地实测（2026-11-22 晚）

fMP4 + MSE 接管后，同一集、同一台机器、连续播 60 秒：

| 指标 | 数值 |
| --- | --- |
| 媒体字节（`LIVE.net` 统计 `read_range`） | **1.52 MB / 60 s** |
| 折算 | 26 KB/s ≈ 1.52 MB/分钟 |
| 对照：原生播放整段 MP4 | 24.5 MB/分钟（≈16×） |
| 实际播放推进 | 53.9 s |
| 缓冲 | `buffered` 一路长到播放头 +60 s |
| 识别 | 12 行、提前 36 s、0 失败 |

init/分片侧踩了四个坑（细节见 `docs/handover.md`「视频集只播音轨」）：手搓 moov 被拒、
init 里多一条 avc1 轨被拒、track id 用了视频轨的 1、整窗 append 只吃下前 2 秒。
现在 init 是从原片 moov 原字节移植，样本按 100 个一片切分再 append。

跳转：+150 秒后走 `liveMseReanchor` 整条重建，重建后 `buffered` 落在新位置 [618.4, 639.4]，
识别继续出句（提前 6~15 秒）。从**片尾往回拖**（缓冲已空、`LIVE.next` 停在片尾）曾永久卡在
`seeking`，修复后 4~6 秒恢复：`buffered` 从 [300, 311] 重新长起来，识别从 0 行重新累计。
MP3 集回归正常，仍是 10 秒/10 秒地长缓冲、提前 59 秒。
