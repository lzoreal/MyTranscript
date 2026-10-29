# MyTranscript 交接文档

最后更新：2026-10-29。面向接手者：先读本文件，再看 [AGENTS.md](../AGENTS.md) 的作业规则。

## 一、这个项目是什么

把播客做成**带字幕的增强版 RSS**，托管在 GitHub Pages：

| 站点 | 地址 |
| --- | --- |
| hwmym（自转录） | https://lzoreal.github.io/MyTranscript |
| 其余 12 个节目 | https://lzoreal.github.io/MyTranscript/podcasts.html |

仓库里的站点产物约 **798 MB**（VTT 为主），`progress.json` 2.4 MB、`translations.json` 1.1 MB、`state.json` 156 KB。

**两条互不相干的字幕来源**（这是全项目最重要的一条边界）：

| | hwmym | 其余 12 个节目 |
| --- | --- | --- |
| 英文字幕来源 | 自己用 Whisper 转写 | PodScripts 抓取 |
| 主状态文件 | `state.json` | `progress.json` |
| 翻译 | `transcribe.py` 内部调 Gemini | `translate_vtt.py` |
| 特色 | 词级时间原生可用 | 段落级、时间轴原本错约 30 秒（由 align 修正） |

## 二、数据流

```
Crawl（周一 05:00 UTC / 手动）
  RSS → PodScripts 搜索 → 英文 VTT → progress.json → feed.xml + index.html
        │ push
        ├─→ Deploy Pages（任何 push 到 main）
        └─→ Align Word Timings（workflow_run；另有手动分片回填）
              每集：下载音频 → 我们自己的 ASR → 文本映射 → 删广告 → 重写两份 VTT + sidecar

Transcribe（周一 12:00 UTC / 手动，含回填分片）
  仅 hwmym：下载(中国代理) → turbo 转写(词时间) → Gemini 翻译 → 双语 VTT + timings sidecar

Translate（每天 19:00 UTC + crawl/transcribe 成功后 + 手动）
  transcripts/zh/*.vtt + feed-zh.xml + translations.json
```

各 workflow 有独立 concurrency group，可并行；提交一律走 `scripts/git_push_retry.sh`（只 `git add` 自己的 pathspec，push 被拒就 rebase 重试）。

## 三、脚本职责

| 文件 | 行数 | 职责 | 关键函数 |
| --- | --- | --- | --- |
| `scripts/scraper.py` | 935 | 抓取字幕、生成增强版英文 Feed 与索引 | `process_podcast`、`generate_podcast_feed`、`parse_transcript` |
| `scripts/transcribe.py` | 2075 | hwmym 全流程：下载、转写、翻译、写 VTT/sidecar、回填 | `whisper_transcribe`、`translate_cues_with_gemini`、`write_word_timings`、`process_episode`、`run_backfill`、`backfill_env` |
| `scripts/translate_vtt.py` | 1106 | 抓取节目的中译（不改英文） | `gemini_batch_translate`、`build_ring` |
| `scripts/generate_zh_feed.py` | 423 | 中文 Feed 与中文索引 | `process_podcast` |
| `scripts/align_timings.py` | 641 | 抓取节目的时间轴修正 + 词级时间 + 删广告 | `parse_english_vtt`、`map_stream`、`classify_cues`、`assign_times`、`rewrite_episode` |
| `scripts/gemini_keys.py` | 106 | Gemini 多 key 顺序轮换与错误分类（两条链路共用） | `GeminiKeyRing`、`is_quota_error`、`is_auth_error` |
| `scripts/git_push_retry.sh` | 51 | 并发安全的提交与推送 | — |

## 四、持久化与站点结构

### 三个状态文件

- `progress.json`：`{ "podcasts": { "<slug>": { "processed": { "<guid>": {vtt_filename, title, processed_at, skipped, reason, source_url, audio_master?} }, "total_processed", "updated_at", "audio_master_gate"? } } }`（Crawl 独占）
- `state.json`：`{ "version", "podcasts": { "<slug>": { "feed_url", "processed", "transcripts": [...], "total_processed", "last_run", "feed_title" } } }`（Transcribe 独占）
- `translations.json`：翻译缓存（Translate 独占）

三者的键都是 **GUID**，所以任何"改音频地址/改时间轴"都不会让缓存失效、不会触发重转。

### 站点结构

```
site/
  index.html                 根索引（Transcribe 生成）
  podcasts.html              抓取节目索引（Crawl 生成）
  <slug>/
    feed.xml / feed-zh.xml
    index.html
    transcripts/<stem>.vtt        ← 形态因来源而异，见下
    transcripts/zh/<stem>.vtt
    timings/<stem>.json           ← 词级时间（sidecar）
```

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

## 八、当前状态（2026-10-29）

**已推送**：`27c85e4`（远端 main 一致）。包含：Gemini 按编号配对修复、hwmym 词级时间 + 分片回填、抓取节目映射式对齐 v2、Gemini key 轮换共享、全部设计与计划文档。

**进行中**：hwmym 全量回填 run `40903075694`（`backfill=true, shards=10, max_minutes=150`）。注意矩阵是固定 20 个 job，`shards=10` 时 shard 10–19 会做完准备工作后空跑退出。

**未完成**：

1. 抓取节目的 240 集回填（`align.yml`，每节目最新 20 集）尚未跑；单集冒烟已通过。
2. **句子级切分**：抓取节目目前仍是段落级 cue（20–40 秒），要做句子级需要新增"按句切分 + 用词时间定位"的一步。
3. 本地 `origin` URL 仍是坏的（`https://…@github.com/.git`），需手动修：
   `git remote set-url origin https://github.com/lzoreal/MyTranscript.git`。
4. 备份分支 `backup/pre-push` 未删。

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
| push 被拒 | `git_push_retry.sh` 会 rebase 重试；持续失败多半是 pathspec 越界改了别人的文件 |
