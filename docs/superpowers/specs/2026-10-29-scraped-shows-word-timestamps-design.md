# 抓取节目词级时间戳（移植 TMLT 对齐）设计

日期：2026-10-29 状态：待评审 前序：`2026-10-28-hwmym-word-timestamps-backfill-design.md`（同构 sidecar）

## 目标

12 个抓取节目也产出逐词时间轴，写进 `site/<slug>/timings/<vtt 同名>.json`，结构与 hwmym 完全一致。
覆盖面：**每个节目最近 20 集回填（约 240 集）+ 之后新集滚动对齐**。

## 实测依据（2026-10-29 探针）

1 集（speaking-of-psychology，37 分钟）走 TMLT 的窗口逻辑对齐 10 个片段：

| 指标 | 结果 |
| --- | --- |
| 对齐成功 | 10/10，0 失败 |
| 首词偏移（对齐词 vs PodScripts cue 起点） | 中位 **−2.18 s**，范围 −2.56 ~ +2.04，0/10 超 ±3 s |
| 末词偏移 | 中位 **+17.9 s** → **cue 结束时间不可信** |
| 成本 | 10 个窗口（约 750 s 音频）耗时 420 s，**RTF ≈ 0.55**（24 线程） |
| 噪音 | stable-ts 会报 "N/M segments failed to align"，组内个别句对不上是常态 |

推论：cue **起点**可作锚点（偏 2.2 s 且稳定，来自 PodScripts 时间轴而非对齐误差）；cue **结束**不能用作窗口上界。

## 一、机制

纯文本 + 音频 → 词时间，不改 VTT。

1. **输入**：`site/<slug>/transcripts/<stem>.vtt`（取英文行作文本、cue start 作锚点）；feed 里该集的 enclosure。
2. **分组**：按 cue 顺序累加，超过 **900 字符**或 **100 秒**（最后一句起点 − 第一句起点）就切开。
3. **窗口**：`lo = start − 3`；`hi = min(音频时长, max(cue.start + cue_span(cue)) + 8)`，
   `cue_span = min(max(声明时长, 字数/15), 字数/4 + 5)`——用文本长度兜住"cue 结束时间虚报或偏短"。
4. **对齐**：`stable_whisper.load_faster_whisper(turbo, device="cpu", compute_type="int8", cpu_threads=N).align(clip, text_block, language="en", original_split=True)`，词时间加回 `lo`。
5. **每句合理性**（TMLT 的 `plausible_words`）：词非空、词序列与句子 token 一致、首词不早于 `cue.start − 8`、末词不晚于下一句起点 `+8`。不满足就丢弃该句的词（sidecar 里 `words: []`、`end: null`），**不失败整集**。
6. **整集守卫**：算全集中位首词偏移；`|中位| > 3 s` ⇒ 判定"音频版本与转写来源不符"（地域插播等），写 `complete:false`、`attempts+1`、不写词，留给下一轮或人工排查。**不做全局平移校正**——常偏移可校正，地区插播的中途插入不可。

## 二、sidecar 与断点

完全复用 hwmym 的产物与语义：`{episode, audio_seconds, complete, attempts, segments:[{start,end,speaker,text,words:[[词,起始ms,时长ms]]}]}`；
`complete:true` 即断点；`attempts >= 2` 不再重试；写失败也写 `complete:false` 记账。
**不新增字段**——每集中位偏移只进日志，不污染与 hwmym 共用的结构。

## 三、音频获取

直接复用 `scripts/transcribe.py` 的 `download_audio`（中国代理竞速，已验证）：align 脚本
`from transcribe import download_audio, get_feed_entries, clean_text`。代价是 align job 必须安装
transcribe 的依赖（faster-whisper 等），换来"只有一份下载实现"。
**align job 不需要任何 Gemini key**（只做对齐，不翻译）；`transcribe` 模块顶层只读环境变量、不校验。

## 四、选片

两种模式，同一套候选逻辑：

| 模式 | 触发 | 选片 |
| --- | --- | --- |
| 滚动 | `workflow_run` 链在 crawl 成功之后 | 所有节目里 **published 在最近 30 天**、已有合格 VTT、sidecar 不完整的集（首次启用会一次性覆盖这 30 天的积压，属预期） |
| 回填 | `workflow_dispatch` | 每个节目**最新 N 集**（默认 20），同上条件 |

分片、预算、断点、`attempts` 上限 2、提交边界（只提交 `site/*/timings`）全部复用 hwmym 回填的语义
（`sha1(identity) % shards`、预算 150 分钟、`if: always()` 但排除 `.tmp`/`.part`）。

## 五、CI

新增 `.github/workflows/align.yml`：

- 触发：`workflow_run`（crawl 完成且 success）+ `workflow_dispatch`（`shards`/`max_minutes`/`latest_per_show`）。
- 依赖：`requirements-align.txt` = `requirements-transcribe.txt` + `stable-ts==2.19.1` + `av==17.1.0`（torch CPU 由 stable-ts 带入）。
- 模型：复用 `ct2-turbo-v1` 缓存与 `model.bin`/`config.json` 双校验（同 transcribe.yml）。
- 提交：`site/*/timings`，排除 `zh/`、`.tmp`、`.part`；`state.json`/feed/index 一律不碰。
- 与 crawl 并发：独立 concurrency 组，写入路径与 crawl/translate 不相交。

## 六、验收

- 240 集 sidecar 全部 `complete: true`；带词 cue ≥ 90%（组内偶发失败可接受）；
- 越界词 0（词时间落在所属 cue 的 `±8 秒` 合理性窗内）；
- 每集中位偏移日志可查，且没有 |中位| > 3 s 的集（有则逐个人工排查音频版本）；
- 抽 3 集人工听感：随机 10 个词，词起点偏差 ≤ 0.5 s。

## 七、不做

- 不改 VTT、不加 `<c>` 卡拉OK 标签；词时间只走 sidecar。
- 不对 hwmym 做对齐（它是自转录，词时间原生来自 Whisper）。
- 不对 PodScripts 的时间轴做全局校正（2.2 s 偏差保留，词本身已贴在真实波形上）。
- 不覆盖全部 4,907 集（约 390 GB 下载）。

## 八、风险

| 风险 | 处理 |
| --- | --- |
| 5 个节目的地域插播未验证 | 整集守卫拦在中位偏移 > 3 s；日志点名，人工排查后按节目决定是否放弃 |
| stable-ts + torch 体积（约 300 MB） | 只在 align job 安装；与 transcribe job 的依赖解耦 |
| 2 核 RTF 未知（本机 0.55/24 线程） | 先跑 1 集的冒烟，按实测调整每轮分片数 |
| PodScripts 组内个别句对不上 | 丢弃该句词、其余照写；带词率门槛 90% 兜底 |
