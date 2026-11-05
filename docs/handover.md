# MyTranscript 交接文档

最后更新：2026-11-03。面向接手者：先读本文件，再看 [AGENTS.md](../AGENTS.md) 的作业规则。

## 一、这个项目是什么

把播客做成**带字幕的增强版 RSS**，托管在 GitHub Pages：

| 站点 | 地址 |
| --- | --- |
| hwmym（自转录） | https://lzoreal.github.io/MyTranscript |
| 其余节目 | https://lzoreal.github.io/MyTranscript/podcasts.html |

Pages 站点约 **646 MB**（`site/`）；词级 JSON 另存仓库 `json/`，约 **369 MB**，由
raw.githubusercontent 提供，不进 Pages。

**字幕来源现在是三条**（数据与状态文件仍然彼此独立，不要合并成一套流程）：

| | hwmym | office-ladies / smartless | 其余 11 个节目 |
| --- | --- | --- | --- |
| 英文字幕来源 | 自己的 Whisper 转写 | 统一管线：PodScripts 文本映射到我们的 ASR 词流 | PodScripts 抓取 |
| 主状态文件 | `state.json` | `data/<slug>/state-*.json` + `progress.json` | `progress.json` |
| 翻译 | `transcribe.py` 内部调 Gemini | `run_pipeline.py` 内部调 Gemini | `translate_vtt.py` |
| 发布 | `transcribe.py` 写 feed/index | `transcripts.yml` 的 publish job 写 JSON/feed/index | crawl / align 写 VTT |

## 二、数据流

```
Crawl（周一 05:00 UTC / 手动）
  RSS → PodScripts 搜索 → 英文 VTT → progress.json → feed.xml + index.html
        │ push
        ├─→ Deploy Pages（任何 push 到 main）
        └─→ Align Word Timings（workflow_run；另有手动分片回填）
              每集：下载音频 → 我们自己的 ASR → 文本映射 → 删广告 → 重写两份 VTT + sidecar

Transcript Pipeline（手动 dispatch，10 分片）
  RSS → ASR 词流 → PodScripts 文本映射 → Gemini 翻译 → data/<slug>/<guid>.json
        → publish job：导出 json/<slug>/<stem>.json → feed.xml + index.html → progress.json
  （已迁移节目：office-ladies、smartless；hwmym 的 data 也由这条链路产出）

Transcribe（周一 12:00 UTC / 手动，含回填分片）
  仅 hwmym：下载(中国代理) → turbo 转写(词时间) → Gemini 翻译 → 双语 VTT + timings sidecar
        → 若 data 里已有该集，导出 json/ 并把 feed 标签切到 JSON

Translate（每天 19:00 UTC + crawl/transcribe 成功后 + 手动）
  未迁移节目：transcripts/zh/*.vtt + feed-zh.xml + translations.json
```

各 workflow 有独立 concurrency group，可并行；提交一律走 `scripts/git_push_retry.sh`（只 `git add` 自己的 pathspec，push 被拒就 rebase 重试）。

## 三、脚本职责

| 文件 | 行数 | 职责 | 关键函数 |
| --- | --- | --- | --- |
| `scripts/scraper.py` | 959 | 抓取字幕、生成增强版英文 Feed 与索引 | `process_podcast`、`generate_podcast_feed`、`parse_transcript` |
| `scripts/transcribe.py` | 2279 | hwmym 全流程：下载、转写、翻译、写 VTT/sidecar、回填、导出 JSON | `whisper_transcribe`、`translate_cues_with_gemini`、`sync_data_transcripts`、`process_episode`、`run_backfill` |
| `scripts/translate_vtt.py` | 1106 | 未迁移节目的中译（不改英文） | `gemini_batch_translate`、`build_ring` |
| `scripts/generate_zh_feed.py` | 423 | 未迁移节目的中文 Feed 与中文索引 | `process_podcast` |
| `scripts/align_timings.py` | 641 | 抓取节目的时间轴修正 + 词级时间 + 删广告 | `parse_english_vtt`、`map_stream`、`classify_cues`、`assign_times`、`rewrite_episode` |
| `scripts/run_pipeline.py` | 116 | 统一管线 CLI：分片、预算、`ONLY_SLUG`、`DATA_DIR` | `main` |
| `scripts/pipeline_site.py` | 81 | 已迁移节目发布：导出 JSON、建 feed/index | `publish_show`、`merged_processed`、`stem_for` |
| `scripts/publish_site.py` | 111 | publish job 入口：读 progress、写 `json/`、登记 progress | `main`、`merge_progress` |
| `scripts/word_transcript.py` | 97 | 内部 JSON → 公开词级 JSON（官方字段 + fork 扩展）与 raw URL | `build`、`export_show`、`public_url` |
| `scripts/export_word_json.py` | 69 | 手动补导出：`--progress` 或 `--state` | `stems_from_progress`、`stems_from_state` |
| `scripts/gemini_keys.py` | 149 | Gemini 配额桶（模型 × key）顺序轮换与错误分类（两条链路共用） | `GeminiKeyRing`、`gemini_models`、`is_quota_error`、`is_auth_error` |
| `scripts/git_push_retry.sh` | 57 | 并发安全的提交与推送 | — |

## 四、持久化与站点结构

### 三个状态文件

- `progress.json`：`{ "podcasts": { "<slug>": { "processed": { "<guid>": {vtt_filename, title, processed_at, skipped, reason, source_url, audio_master?} }, "total_processed", "updated_at", "audio_master_gate"? } } }`（Crawl 独占）
- `state.json`：`{ "version", "podcasts": { "<slug>": { "feed_url", "processed", "transcripts": [...], "total_processed", "last_run", "feed_title" } } }`（Transcribe 独占）
- `translations.json`：翻译缓存（Translate 独占）

三者的键都是 **GUID**，所以任何"改音频地址/改时间轴"都不会让缓存失效、不会触发重转。

### 站点结构

```
json/<slug>/<stem>.json        ← 已迁移节目的词级 JSON（raw.githubusercontent 提供，不进 Pages）
site/
  index.html                 根索引（Transcribe 生成）
  podcasts.html              抓取节目索引（Crawl 生成）
  player.html                多节目播放器（静态；读 shows.json + 各节目 feed）
  shows.json                 播放器节目清单（新增节目时同步更新；无 feed 的节目 feed 为 null）
  <slug>/
    feed.xml / feed-zh.xml   ← 已迁移节目只有 feed.xml
    index.html
    transcripts/<stem>.vtt        ← 未迁移节目；形态因来源而异，见下
    transcripts/zh/<stem>.vtt
    timings/<stem>.json           ← 词级时间（sidecar）
```

### 播放器（`site/player.html`）取字幕规则

- 只认 feed 里属于本项目的 `podcast:transcript`（host 为 `lzoreal.github.io/MyTranscript` 或
  `raw.githubusercontent.com/lzoreal/MyTranscript`），忽略 Buzzsprout 等外部字幕链接；
- `application/json` 直接按 `segments` 画词级并取 `body` 第二行中文；
- `text/vtt` 解析后，英文单语再取 `transcripts/zh/<stem>.vtt`；`shows.json` 里该节目 `timings: true`
  时才请求 `timings/<stem>.json`（目前只有 hwmym），否则按句级显示；
- 没有字幕的集仍然可以播放音频；
- 音频优先用 feed enclosure（多跳跟踪 URL）；播放出错时自动重试、解析最终 CDN 地址、退回
  `media:content` 直链，并在播放器上方显示可点击重试的提示；
- `audio_seconds` 与浏览器 `duration` 相差超过 1% 时不做整体缩放（通常是动态插播广告导致音频内容不同）；
- 播放进度存在 localStorage `myt-progress`（键 `show:episode`，值为 `{t,d,at}`）；播放中每 5 秒写一次，
  暂停/seek/页面隐藏时强制写入；加载音频元数据后，若上次停在 5 秒之后且离结尾超过 10 秒则自动恢复；
  播放结束清除该集记录；
- 详情面板的“对齐到当前句”进入选句模式：先锁定按下按钮时的播放位置，再点击任意一句作为该时刻
  应高亮的句子，按 `offset = 锁定时间 − 该句 speechStart` 更新偏移；Esc 或再次点按钮取消。

### VTT 有两种形态（必须区分）

| 文件 | 形态 | 行/块 |
| --- | --- | --- |
| hwmym 的 `transcripts/*.vtt` | **中英双语** | 4（序号/时间/英文/中文） |
| 抓取节目的 `transcripts/*.vtt` | **英文单语** | 3（序号/时间/英文） |
| 所有节目的 `transcripts/zh/*.vtt` | **中英双语** | 4 |

> 这一条是 2026-10-29 冒烟时才纠正的：早期设计文档假设"抓取节目的英文文件也是双语"，实现因此解析出 0 块。

### 词级时间 sidecar（与 TMLT 同构）

```json
{"episode":"<vtt stem>","audio_seconds":1479.11,"complete":true,"attempts":1,
 "segments":[{"start":1000,"end":2500,"speaker":null,"text":"Hello there",
              "words":[["Hello",1000,400],["there",1400,600]]}]}
```

- 紧凑 JSON；`start/end` 毫秒整数；`words` 元素 `[词, 起始ms, 时长ms]`；
- **断点即 sidecar**：`complete:true` 跳过；`attempts >= 2` 不再重试；
- hwmym 与抓取节目共用同一结构，`segments[i]` 对应**重写后**第 i 条 cue。

## 五、词级时间戳的两条路径

### hwmym（原生）

`transcribe.whisper_transcribe` 开 `word_timestamps=True`，词时间穿过二次切句（`resegment_whisper_segments` + `measured_cue_times`：合并续接词、按字数比例兜底），实测 100% 覆盖、0 越界。

### 抓取节目（映射式，2026-10-29 实现）

**不要试图用 PodScripts 的时间当锚点**——已证伪：

1. PodScripts 202 s 处声称的句子，与实际音频内容完全不同；其 cue 时间是均匀切出来的（约 34 秒一条）。
2. 原因：PodScripts 转写的是**带广告的版本**，我们下载的中国区版本没有插播，因此整体漂移约 30 秒。
3. 更早的"首词偏移中位 −2.2 秒"是 3 秒 pad 造成的假象。

正确做法：

```
下载音频（transcribe.download_audio，中国代理竞速）
  → 自己转写（turbo + 词时间）
  → PodScripts token ↔ 我们的词 token 全局序列映射（difflib）
  → 按覆盖率分流 → 重写 VTT + sidecar
```

**阈值（`scripts/align_timings.py` 顶部常量，改动需重新评估）**

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `BODY_MIN_COVERAGE` | 0.70 | ≥70% → 正文：用真实词时间 |
| `PARTIAL_MIN_COVERAGE` | 0.30 | 30–70% → 保留文本但按字数插值定时，不写词 |
| （无常量） | <30% | 判为广告 → 整块删除 |
| `MIN_TOKENS_TO_DROP` | 5 | 少于 5 词不删（防误删碎片） |
| `MAX_DROP_RATIO` | 0.25 | 单集删除超 25% → 整集放弃（判为映射失败） |
| `MIN_TEXT_SIMILARITY` | 0.85 | 整篇相似度不足 → 整集放弃 |
| `MIN_BODY_RATIO` | 0.70 | 保留 cue 占比过低 → 整集放弃 |

实测依据：广告覆盖 0–63%、正文 97–100%，阈值 30/70 落在空档里。单集冒烟（2026-10-29）：相似度 0.961、删 2 条广告、4,571 词中 99.8% 有正时长。

**中文配对必须按原始块下标**，不能按"保留序号"——否则删掉一条广告后后面所有译文整体错位（这是踩过的真 bug）。

## 六、CI

| workflow | 触发 | 写什么 |
| --- | --- | --- |
| `crawl.yml` | 周一 05:00 UTC / 手动 | `progress.json`、12 个节目的英文 VTT、feed、index |
| `transcribe.yml` | 周一 12:00 UTC / 手动（`backfill` 输入进入分片回填） | `state.json`、hwmym 的双语 VTT、`timings/`、hwmym feed/index |
| `translate.yml` | 每天 19:00 UTC / crawl、transcribe 成功后 / 手动 | `site/*/transcripts/zh/`、`feed-zh.xml`、`translations.json` |
| `deploy.yml` | push 到 main | Pages（从最新 main 重新 checkout） |
| `align.yml` | crawl 成功后 / 手动分片 | 重写两份 VTT + `timings/` |

### 密钥

| Secret | 必需 | 说明 |
| --- | --- | --- |
| `MY_CUSTOM_PAT` | ✅ | 四个 job 的 push；必须是 PAT，默认 `GITHUB_TOKEN` 的 push 不会触发下游 workflow |
| `GEMINI_API_KEYS` | 推荐 | 逗号分隔多把 key（**不同项目**才有意义），顺序轮换 |
| `GEMINI_API_KEY` | 可选 | 单 key 兼容写法；与上面任一存在即可 |

### 平台限制（个人账号 + 公共仓库）

- 标准 runner **分钟数免费无限**；
- **并发作业数 20（账号级，所有仓库共享）**，macOS 上限 5；
- 缓存 10 GB/仓库（turbo 模型 1.6 GB）；
- 单 job 超时上限 **6 小时**：`timeout-minutes: 360` 已顶格，预算 + 最坏单集必须 < 360；
- 公共仓库的定时 workflow **60 天无仓库活动会被禁用**。

## 七、测试与本地验证

```bash
for f in tests/test_*.py; do python "$f"; done     # 6 个文件、174 个用例
```

- 没有 pytest；测试都是 `unittest`，直接跑文件。
- `scripts/transcribe.py` 的重依赖（faster-whisper / google-genai / feedparser）在测试里用 `sys.modules` 桩替代；`align_timings.py` 复用 `transcribe` 的下载与 sidecar，所以测试文件顶部先打桩再 import。
- 真实转写只在 Python 3.10 上可跑（本机 `C:\Users\游梦\AppData\Local\Programs\Python\Python310\python.exe`），3.14 装不了 faster-whisper。

## 八、当前状态（2026-11-03）

**线上**：

- hwmym 121/121、office-ladies 497/497 的词级数据已完成；feed 的 transcript 标签指向
  `raw.githubusercontent.com/.../json/`，旧 VTT 归档在 `data/<slug>/legacy-vtt/`；
- 两个已迁移节目只保留 `feed.xml`，`feed-zh.xml` 已下线；
- smartless 迁移进行中：382 集旧字幕仍以 VTT 标签提供服务，回填完成的集逐批切到 JSON；
  该节目 PodScripts 页面无内容，`text_source` 已改为 `asr`，直接用自己的转写文本；
- Pages 站点约 646 MB，词级 JSON 约 369 MB（仓库内，不进 Pages）。

**未完成 / 注意**：

1. smartless 382 集回填完成后，需要归档 `site/smartless/transcripts/` 并删除 `feed-zh.xml`；
2. 抓取节目的 240 集 align 回填尚未跑（只影响未迁移节目）；
3. `align_timings.collect_shows` 遇到单个畸形 RSS 会整 job 失败（2026-11-03 实测某个 Substack 源），
   与字幕数据无关。

## 九、已否证的方案（不要再提）

| 方案 | 否证依据 |
| --- | --- |
| 把 enclosure 改写成"干净 master 地址"以去广告 | 广告由 CDN 按听众 IP 插入；同 IP 下 wrapper 与 master 是同一个文件，改写只丢发布方统计 |
| 用 PodScripts 的 cue 时间当锚点做窗口对齐（TMLT 原方案） | PodScripts 时间是均匀切的、且含我们音频里没有的广告，窗口对齐会把整行词压成一个瞬间（实测 54% 词零时长） |
| 用别人的音频/归档找"无广告母版" | 没有公开渠道；archive.org 只有 hwmym 第一季的第三方上传 |

## 十、排障速查

| 现象 | 先看什么 |
| --- | --- |
| 字幕与音频差约 30 秒 | 该节目没跑过 align；`timings/` 里有没有对应 sidecar |
| 某集反复被回填选中 | sidecar 的 `attempts`；`complete` 是否为 false |
| 翻译整批缺几条 | `translate_blocks` 的"只补缺失编号"日志；Gemini 是否返回了不完整对象 |
| job 绿但什么都没做 | 分片参数被 `continue-on-error` 吞掉？看"检查回填参数"步骤与 `候选 N 集` |
| push 被拒 | `git_push_retry.sh` 会 rebase 重试；同名集产物的 add/add 冲突自动保留远程版本，仍失败多半是 pathspec 越界改了别人的文件 |

## 十一、统一链路（新，进行中）

2026-10-30 起，仓库里多了一条统一链路：`feeds.json` → `scripts/run_pipeline.py` → 双语词级 JSON
（写 main 的 `data/`，不部署）。设计见 `docs/superpowers/specs/2026-10-30-unified-transcript-pipeline-design.md`。

> 2026-11-02：产物原来在独立的 `word-transcripts` 分支，现已并入 main。分片直接提交 `data/`
> 到 main；`deploy.yml` 因此加了 `paths: ["site/**"]`，数据提交不再触发 Pages 部署。
> 旧分支保留作历史备份，CI 不再读取。
>
> 2026-11-04：公开词级 JSON 增加 `guid` 扩展字段，导出侧用它确认同名文件归属。同名集
> （如 smartless 的 Sandra Bullock / Stephen Colbert）不再互相覆盖，后迁移的集文件名带
> guid 指纹后缀；老 progress 条目只有在该 JSON 确实属于本集时才切到 JSON。

### 模块

| 文件 | 职责 |
| --- | --- |
| `scripts/pipeline_config.py` | 读/校验 `feeds.json`，待办集平均分片，列 RSS 条目 |
| `scripts/pipeline_text.py` | 文本源：`asr` 直接用 ASR 句子；`podscripts` 抓取后映射到词流 |
| `scripts/clause_translation.py` | 小句翻译契约（en 拼接必须等于原句） |
| `scripts/zh_align.py` | 中文分词驱动的时间分配 + DTW 兜底 |
| `scripts/pipeline_store.py` | `data/<slug>/state<suffix>.json`、`plan-<shard>.json` 与单集 JSON 的原子写 |
| `scripts/pipeline_episode.py` | 单集编排（依赖注入，可单测） |
| `scripts/pipeline_publish.py` | 双语 VTT 渲染 |
| `scripts/pipeline_deps.py` | 把 ASR/翻译/抓取/嵌入装配成 deps |
| `scripts/run_pipeline.py` | CLI：分片、预算、`ONLY_SLUG`、`DATA_DIR` |
| `scripts/fill_zh_words.py` | 离线补齐：门控放弃的句子按字数均分，写 `zh_word_mode="even"` |
| `scripts/word_transcript.py` | `data/` 内部 JSON → 公开词级 JSON（官方字段 + fork 扩展）与 raw URL |
| `scripts/publish_site.py` | publish job 入口：导出 JSON、重建 feed/index、登记 progress |
| `scripts/export_word_json.py` | 手动补导出：`--progress`（office-ladies）或 `--state`（hwmym） |

### 分片与续跑

- 分片的单位是**集**，不是节目：首切时先剔除已完成（以及重试到上限、其它片已认领）的集，
  剩下的按 guid 排序后轮流分给各片，各片待办数差不超过 1。
- **一个 run 内每片只切一次分片**，结果落在 `data/<slug>/plan-<shard>.json`（`run_id` 用
  `GITHUB_RUN_ID`）。后续分块复用这份计划，只去掉已完成的集。
  > 2026-11-04 踩过：改成"每个分块按当前待办集重切"后，别的片手上正在跑的那一集（单集
  > 35~40 分钟不可中断，state 要等跑完才落盘）会被重新分配过来，两片写同一个
  > `data/<slug>/<guid>.json`，提交时 rebase 撞车，整片的产出推不上去。实测同一集同时记在
  > shard 11（done）和 shard 12（failed）的 state 里。
- 每片写自己的 `data/<slug>/state-<shard>.json`（单片时仍叫 `state.json`）和
  `plan-<shard>.json`。分片之间不共享文件，并发 push 时各改各的。
  **完成的集要看所有 state 的并集。**
- `git_push_retry.sh` 普通 rebase 冲突时改用 `git rebase -X ours` 重试：同名集的产物是等价
  重复劳动，保留远程那一份，本片其它文件照常提交，不再整片卡住。
- 重试上限跨片生效：任一 state 里记满 3 次失败即不再分给任何片，要捞回来得手动改对应 state。
- 配额用尽不是失败：`process_episode` 直接上抛 `QuotaExhausted`，不记 attempts，`run_pipeline` 打印
  "Gemini 配额用尽，本轮停在这里"后正常退出——补配额后重发同一片即可续跑。
- 日额度按 **(key, model)** 计，所以轮换单位是桶而不是 key：`GEMINI_MODELS`（逗号分隔）里
  每个模型都是一份额度，先走完一个模型的所有 key 再换下一个，**表上所有模型都耗尽**才抛
  `QuotaExhausted`。实测 2026-11-04 那一轮：单模型时 20 片 15 分钟就把额度打空，只产出 1 集。
  `GEMINI_MODELS` 没配时退回单个 `GEMINI_MODEL`，行为与轮换前一致。
- 健康度（`data/.key-health/shard-<N>.json`）也按 (key, model) 判死：`run_pipeline` 启动时取
  **轮换表上每个模型都判死**的交集作为排除表——只在某个模型上耗尽的 key，换个模型还能用。
- 单个 job 的 `timeout-minutes` 是 360；`MAX_MINUTES` 要在开跑下一集前判断，所以整片时长
  ≈ `MAX_MINUTES` + 一集耗时，两者之和必须小于 360。
- 免费层的硬上限是**每天请求数**（RPD），不是 token：实测 2026-11-04 那一轮 31 集共发
  1133 次请求（平均 36.5 次/集）就把一份 (key, model) 额度打到见底。所以 `TRANSLATE_BATCH_SIZE`
  默认 150（原 50），一次请求装 3 倍字幕，同一份额度能多出约 3 倍集数；workflow 的
  `translate_batch` 输入可临时改。`TRANSLATE_SCHEMA_MAX_BLOCKS` 跟着放到 200，
  保证大块批次仍带逐键 `response_schema`；16000 字符上限保留，长段落先按字符切。

### 中文词时间的三层兜底

1. 有小句（翻译契约）：按英文词数分配小句跨度，再按字数分到词；
2. 无小句或门控不自信：`zh_align.fallback_zh_words` 做词级 DTW（要求英中小句数差 < 3 且分配比例不偏）；
3. 门控放弃：按整句字数均分，句子上写 `zh_word_mode="even"`，消费方据此降级。

第 3 层现在也会在管线里自动发生；历史语料用 `python scripts/fill_zh_words.py <data_dir>`
离线补（不碰 ASR、不花 Gemini），补完 121 集覆盖率从 79.6% 到 99.9%（剩下 109 句中文只有标点）。

### 迁移一个节目（office-ladies 2026-11-02、smartless 2026-11-03 实跑过）

1. `feeds.json` 加该节目：`text_source`（`podscripts` 优先抓取，抓不到自动回退 ASR；
   PodScripts 无内容的节目如 smartless 直接写 `asr`）、`publish: true`，用 `podscripts` 时再加 `podscripts_id`；
2. `podcasts.json` 给该节目加 `"migrated": true` —— crawl 跳过抓取与 feed/index，但总索引仍列出；
3. `podcasts_translate.json` 移除该节目（旧翻译 job 不再碰它）；
4. **决定是否回填历史集**：
   - 只切换新集：`python scripts/seed_state.py <slug> --data-dir data --shards 10`
     把 progress 里的旧集标成 done，新链路只处理新集；
   - 要让历史集也有词级 JSON：**不要 seed**，让 `data/<slug>/` 的 state 为空，直接分波跑；
5. 分波跑 `transcripts.yml`：先用 `shards=10`、`max_minutes=45` 做金丝雀（每片约 1 集），
   验证 JSON 结构、中文覆盖率与词时间；再用 `max_minutes=270` 反复 dispatch，直到 done 集数 = 目标；
6. 全量完成并发布后收尾：VTT 移到 `data/<slug>/legacy-vtt/`（含 `zh/`），
   `git rm site/<slug>/feed-zh.xml`。

**分批迁移的硬约束**：`pipeline_site.merged_processed` 只有在
`json/<slug>/<stem>.json` 实际存在时才把记录切到 JSON，否则保留 `vtt_filename`。
破坏这条会在回填未完成时把整批集从 feed 删掉（2026-11-03 已修复并加测试）。

**验收清单**（每次迁移都按这个查）：

- `data/<slug>/` 里 done 集数 = 目标集数，失败 0；
- feed `items` = 目标集数，transcript 标签全部 `application/json`、0 个 `text/vtt`；
- 随机抽 3 个 raw JSON 返回 200，且 `version=1.0.0`；
- `site/<slug>/feed-zh.xml` 与 `site/<slug>/transcripts/` 已删除，`site/` 总量 < 1 GB；
- 未迁移节目的标签仍是 `text/vtt`，文件未变化。

**同一节目只能有一个产出方**；切换后观察一周 `git log`，确认旧链路不再产生该节目的提交。
回滚：把 slug 加回 `podcasts.json`、从 `feeds.json` 删除即可。

### 与旧链路的关系

迁移完成前，旧的四条 workflow（crawl / transcribe / translate / align）照常运行；
统一链路的产物在 main 的 `data/`，`publish` job 才写 `site/` 和 Feed。
`data/` 不进 Pages 上传（`deploy.yml` 只传 `site/`，且只由 `site/**` 的提交触发）。

### 词级 JSON 字幕（2026-11-02）

- 已迁移节目（office-ladies、smartless）与 hwmym 的 transcript 是仓库里的
  `json/<slug>/<stem>.json`，由 `https://raw.githubusercontent.com/lzoreal/MyTranscript/main/...`
  直接提供；**不进 Pages**（618 集实测 386.3 MB，放进站点会超过 1 GB）；
- JSON = Podcasting 2.0 官方字段（`version`、`segments[].startTime/endTime/body`，秒）
  + AntennaPod fork 扩展（`segments[].start/end/text/words`，毫秒）；
- 每集一个双语文件，`body/text` 是「英文句 + 换行 + 中文句」；`words` 只含英文词
  （fork 解析器要求单调递增，混入中文词会被整段丢弃）；
- 已迁移节目只保留 `feed.xml`，不再生成 `feed-zh.xml`；hwmym 与 smartless 已从
  `podcasts_translate.json` 移除；
- 旧 VTT 原样归档在 `data/<slug>/legacy-vtt/`（含 `zh/`），不再发布；
- 导出只读 `data/`：office-ladies、smartless 由 `transcripts.yml` 的 publish job，
  hwmym 由 `transcribe.yml` 在每次运行尾部完成；`scripts/export_word_json.py` 供手动补导出；
- `scraper.is_episode_processed` 认得 `json/` 下的产物，VTT 归档后 feed 不会被清空；
  `transcribe.is_cached_episode` 同理，hwmym 不会因 VTT 移动而重转。
