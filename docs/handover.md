# MyTranscript 交接文档

最后更新：2026-11-14。面向接手者：先读本文件，再看 [AGENTS.md](../AGENTS.md) 的作业规则。

## 一、这个项目是什么

把播客做成**带字幕的增强版 RSS**，托管在 GitHub Pages：

| 站点 | 地址 |
| --- | --- |
| hwmym（自转录） | https://lzoreal.github.io/MyTranscript |
| 其余节目 | https://lzoreal.github.io/MyTranscript/podcasts.html |

Pages 站点清理旧字幕后约 **40 MB**（`site/`）；词级数据 `data/`、`json/` 放在独立的
**`data` 分支**（main 只有代码和 `site/`），由 raw.githubusercontent 提供，不进 Pages。

**字幕来源现在只有一条**（状态文件仍彼此独立）：

| | 13 个已发布节目 | hwmym |
| --- | --- | --- |
| 英文字幕来源 | 统一管线：RSS → 我们的 ASR 词流（`text_source: asr`） | `transcribe.py`（Whisper 词时间） |
| 主状态文件 | `data/<slug>/state-*.json` + `progress.json` | `state.json` + `data/<slug>/state-*.json` |
| 翻译 | `run_pipeline.py` 内部调 Gemini | `transcribe.py` 内部调 Gemini |
| 发布 | `transcripts.yml` 的 publish job 写 JSON/feed/index | `transcribe.py` 写 feed/index，尾部导出 JSON |

旧 VTT 翻译 / 对齐链路（`translate_vtt.py`、`generate_zh_feed.py`、`translate.yml`、`align.yml`）
已于 2026-11-14 随全量迁移一起删除。只剩一处历史遗留：7 集尚未回填的 VTT 仍按 `text/vtt` 发布。

## 二、数据流

```
Crawl（周一 05:00 UTC / 手动）
  只处理 podcasts.json 里 migrated=false 的节目（目前已迁移的全部跳过）
  → progress.json → 根索引 index.html / podcasts.html
        └─→ Deploy Pages（任何 push 到 main）

Transcript Pipeline（手动 dispatch；分片数 = min(待办集数, 20)）
  RSS → ASR 词流 → Gemini 翻译 → data/<slug>/<guid>.json
        → publish job：只对内容有改动的节目导出 json/、重建 feed.xml + index.html → progress.json
  （13 个节目都走这条；hwmym 的 data 同格式，但 feed 仍由 transcribe.yml 收尾）

Transcribe（周一 12:00 UTC / 手动，含回填分片）
  仅 hwmym：下载(中国代理) → turbo 转写(词时间) → Gemini 翻译 → 双语 VTT + timings sidecar
        → 导出 json/ 并把 feed 标签切到 JSON
```

各 workflow 有独立 concurrency group，可并行；提交一律走 `scripts/git_push_retry.sh`（只 `git add` 自己的 pathspec，push 被拒就 rebase 重试）。

## 三、脚本职责

| 文件 | 行数 | 职责 | 关键函数 |
| --- | --- | --- | --- |
| `scripts/scraper.py` | 959 | 生成增强版 Feed 与索引（publish 侧仍在用）；PodScripts 抓取只服务未迁移节目 | `process_podcast`、`generate_podcast_feed`、`parse_transcript` |
| `scripts/transcribe.py` | 2279 | hwmym 全流程：下载、转写、翻译、写 VTT/sidecar、回填、导出 JSON | `whisper_transcribe`、`translate_cues_with_gemini`、`sync_data_transcripts`、`process_episode`、`run_backfill` |
| `scripts/align_timings.py` | 641 | 词流映射与测时工具；`map_stream`/`classify_cues`/`assign_times` 仍被 `pipeline_text.py` 使用（CLI 随 `align.yml` 下线，文件保留） | `map_stream`、`classify_cues`、`assign_times` |
| `scripts/run_pipeline.py` | 116 | 统一管线 CLI：分片、预算、`ONLY_SLUG`、`DATA_DIR` | `main` |
| `scripts/pipeline_site.py` | 81 | 已迁移节目发布：导出 JSON、建 feed/index | `publish_show`、`merged_processed`、`stem_for` |
| `scripts/publish_site.py` | 111 | publish job 入口：读 progress、写 `json/`、登记 progress；无改动的节目跳过重建 | `main`、`merge_progress` |
| `scripts/plan_shards.py` | 55 | 按待办集数决定分片数（≤20，一片一集为下限） | `effective_shards`、`pending_total` |
| `scripts/changed_shows.py` | 40 | 发布后从 `git status` 列出改动过的节目目录，供增量提交 | `show_dirs` |
| `scripts/word_transcript.py` | 97 | 内部 JSON → 公开词级 JSON（官方字段 + fork 扩展）与 raw URL | `build`、`export_show`、`public_url` |
| `scripts/export_word_json.py` | 69 | 手动补导出：`--progress` 或 `--state` | `stems_from_progress`、`stems_from_state` |
| `scripts/gemini_keys.py` | 149 | Gemini 配额桶（模型 × key）顺序轮换与错误分类（两条链路共用） | `GeminiKeyRing`、`gemini_models`、`is_quota_error`、`is_auth_error` |
| `scripts/git_push_retry.sh` | 57 | 并发安全的提交与推送 | — |

## 四、持久化与站点结构

### 两个状态文件

- `progress.json`：`{ "podcasts": { "<slug>": { "processed": { "<guid>": {vtt_filename, title, processed_at, skipped, reason, source_url, audio_master?} }, "total_processed", "updated_at", "audio_master_gate"? } } }`（Crawl / publish 写）
- `state.json`：`{ "version", "podcasts": { "<slug>": { "feed_url", "processed", "transcripts": [...], "total_processed", "last_run", "feed_title" } } }`（Transcribe 独占）

两者的键都是 **GUID**，所以任何"改音频地址/改时间轴"都不会让缓存失效、不会触发重转。
`data/<slug>/state-*.json` 是统一管线的分片进度，与上面两个文件互不替代。

### 数据分支（`data`）

`data/`（内部双语 JSON + 分片 state）和 `json/`（对外词级 JSON）在 **`data` 分支**，
main 不存。CI 任务用两次 checkout 把 data 分支放到 `data-repo/`，再软链回根目录：

```bash
rm -rf data json
ln -s "$PWD/data-repo/data" data
ln -s "$PWD/data-repo/json" json
```

提交时用 `GIT_WORKTREE="$PWD/data-repo" scripts/git_push_retry.sh ...` 推 data 分支；
站点/状态文件仍推 main。feed 里的 transcript URL 指向 `.../MyTranscript/data/json/...`。
本地克隆可用 `--filter=blob:none --sparse` 跳过 `data/`、`json/`，需要时再按需拉取。

### 站点结构

```
data/ + json/                  ← 在 data 分支（词级母版与导出，raw.githubusercontent 提供）
site/
  index.html                 根索引（Crawl 生成）
  podcasts.html              节目索引（Crawl 生成）
  player.html                多节目播放器（静态；读 shows.json + 各节目 feed）
  shows.json                 播放器节目清单（新增节目时同步更新；无 feed 的节目 feed 为 null）
  <slug>/
    feed.xml                 ← 唯一的字幕 Feed（feed-zh.xml 已下线）
    index.html
    transcripts/<stem>.vtt   ← 只剩 7 集未回填的历史字幕（hwmym 3、taproot 4）
    transcripts/zh/<stem>.vtt ← 只剩 taproot 那 4 集的播放器译文
    timings/<stem>.json      ← 只保留上述 hwmym 3 集的词级 sidecar
```

### 播放器（`site/player.html`）取字幕规则

- 只认 feed 里属于本项目的 `podcast:transcript`（host 为 `lzoreal.github.io/MyTranscript` 或
  `raw.githubusercontent.com/lzoreal/MyTranscript`），忽略 Buzzsprout 等外部字幕链接；
- `application/json` 直接按 `segments` 画词级并取 `body` 第二行中文；JSON 的 `words` 是 ASR
  原生时间，播放器不再做压缩词串平滑和首词重叠跳过（这两项修补只用于 VTT + `timings/` sidecar）；
- `text/vtt` 只用于尚未回填的 7 集历史字幕：英文单语再取 `transcripts/zh/<stem>.vtt`；
  `shows.json` 里该节目 `timings: true` 时才请求 `timings/<stem>.json`（目前只有 hwmym）；
- 没有字幕的集仍然可以播放音频；
- 音频优先用 feed enclosure（多跳跟踪 URL）；播放出错时自动重试、解析最终 CDN 地址、退回
  `media:content` 直链，并在播放器上方显示可点击重试的提示；
- `audio_seconds` 与浏览器 `duration` 相差超过 1% 时不做整体缩放（通常是动态插播广告导致音频内容不同）；
- 播放进度存在 localStorage `myt-progress`（键 `show:episode`，值为 `{t,d,at}`）；播放中每 5 秒写一次，
  暂停/seek/页面隐藏时强制写入；加载音频元数据后，若上次停在 5 秒之后且离结尾超过 10 秒则自动恢复；
  播放结束清除该集记录；
- 详情面板的“对齐到当前句”进入选句模式：先锁定按下按钮时的播放位置，再点击任意一句作为该时刻
  应高亮的句子，按 `offset = 锁定时间 − 该句 speechStart` 更新偏移；Esc 或再次点按钮取消。

### 残余 VTT 有两种形态（必须区分）

现在只剩 7 集历史字幕，但形态规则不变：

| 文件 | 形态 | 行/块 |
| --- | --- | --- |
| hwmym 的 `transcripts/*.vtt`（3 集） | **中英双语** | 4（序号/时间/英文/中文） |
| taproot 的 `transcripts/*.vtt`（4 集） | **英文单语** | 3（序号/时间/英文） |
| taproot 的 `transcripts/zh/*.vtt`（4 集） | **中英双语** | 4 |

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
| `crawl.yml` | 周一 05:00 UTC / 手动 | `progress.json`、未迁移节目的 VTT/feed、根索引 |
| `transcribe.yml` | 周一 12:00 UTC / 手动（`backfill` 输入进入分片回填） | `state.json`、hwmym 的双语 VTT、`timings/`、hwmym feed/index（main）；`data/`、`json/`（data 分支） |
| `transcripts.yml` | 手动 dispatch | `data/`、`json/`（**推 data 分支**）、各节目 feed/index、`progress.json`（main） |
| `fix-zh.yml` | 手动 | 修正 data 里的中文（推 data 分支）并重新发布（main） |
| `deploy.yml` | push 到 main | Pages（从最新 main 重新 checkout） |

### 密钥

| Secret | 必需 | 说明 |
| --- | --- | --- |
| `MY_CUSTOM_PAT` | ✅ | 各 job 的 push；必须是 PAT，默认 `GITHUB_TOKEN` 的 push 不会触发下游 workflow |
| `GEMINI_API_KEYS` | 推荐 | 逗号分隔多把 key（**不同项目**才有意义），顺序轮换 |
| `GEMINI_API_KEY` | 可选 | 单 key 兼容写法；与上面任一存在即可 |

### 平台限制（个人账号 + 公共仓库）

- 标准 runner **分钟数免费无限**；
- **并发作业数 20（账号级，所有仓库共享）**，macOS 上限 5；
- 缓存 10 GB/仓库（turbo 模型 1.6 GB）；
- 单 job 超时上限 **6 小时**：`timeout-minutes: 360` 已顶格，预算 + 最坏单集必须 < 360；
- 公共仓库的定时 workflow **60 天无仓库活动会被禁用**。

### 音频下载代理池（2026-11-10 支持按地区切换）

| 来源 | 地址 | 规模（2026-11-10 本机实测） |
| --- | --- | --- |
| ProxyScrape | `api.proxyscrape.com/v4/...&country=<region>` | CI 里 33–47 个（CN） |
| JustFreeProxies | `justfreeproxies.com/free-proxy-list/<region>.json` | CN 约 380，AU 只有 3 |
| HProxy | `hproxy.com/api/proxy-list?format=json&country=<REGION>&limit=240` | CN 234，AU 12（带 `protocols`/`tls_intercepted`/`uptime_24h`） |
| Databay | `databay.com/free-proxy-list/<country-slug>` | 每个国家约 10 个（AU 10，出口是真 AU） |
| FreeProxyWorld | `www.freeproxy.world/?country=<REGION>&page=N` | CN 262，AU 245（HTML 表格，最多 6 页） |

- `PROXY_REGION`（dispatch 输入 `proxy_region`）是逗号分隔的两字母国家代码，默认 `cn`，
  例如 `au` 或 `cn,au`；GeoIP 出口必须落在所选地区集合里，否则该代理判死。
  换地区会改变拿到的音频版本（cn 是无插播的中国区音频）。
- 主来源（ProxyScrape/JustFreeProxies/HProxy/Databay）各自打乱后**轮流出队**，每个来源在 200 个名额里
  各占一份；FreeProxyWorld 是兜底来源，只在主来源不足 200 个时才补位。
- 下载前用 `GeoIP`（`ipwho.is`）确认出口地区；不是所选地区、连不上、下到 HTML 的代理都进 `BAD_PROXIES`。
  `MAX_PROXY_ATTEMPTS=200` 截断。
- Databay 的 `https://` 代理用**自签证书**：`is_tls_proxy()` 会对这类代理关掉证书校验
  （`verify=False`，GeoIP 探测和音频下载都一样），代价是这些代理下的目标 TLS 也不校验。
  这是接 AU 的唯一可用来源（AU 出口是真的），接受这点风险才用。
- 实测可用率（2026-11-10，真实音频、无 Range）：HProxy CN 在 megaphone 音频上 2/12，
  在 Simplecast 上 0/12（`fallback-audio-cdn.simplecast.com` 对这些机房 IP 直接 401
  `oauth_error`）；FreeProxyWorld CN 0/50、AU 0/120（只会 HTTP 转发的透明代理）；
  JustFreeProxies CN 约 1%；Databay AU 6/8（megaphone）。
- **AU 出口能下 CN 下不到的节目**：2026-11-10 实测 Databay AU 对 speaking-of-psychology、
  the-psychology-of-your-20s、casefile-true-crime、algorithms-data-structures-programs、
  the-taproot-podcast、the-aspiring-psychologist-podcast、programming-throwdown
  都是 5–6/6 成功（megaphone/omny/acast/buzzsprout/podbean/captivate/feedburner）。
- `scripts/probe_proxies.py` + `proxy-probe.yml`：只读探测某地区的池子大小、GeoIP 出口分布、
  音频成功率；换地区前先跑它。
- 站点 `protocol` 字段不可信：标的 `HTTP` 也可能是不能对 https 建 CONNECT 的代理。
  2026-11-09 全池实测 281 个里只有 4 个过 GeoIP，其中 1 个真能下音频；仍值得接入，
  因为竞速只等第一个成功。
- 缓存 `.proxy_cache.json` 里记 `regions`，地区不符直接重抓（不能拿 CN 的列表去跑 AU）；
  `PROXY_JSON_MAX_PAGES`（默认 5）/`PROXY_HTML_MAX_PAGES`（默认 6）限制翻页数。

## 七、测试与本地验证

```bash
for f in tests/test_*.py; do python "$f"; done     # 6 个文件、174 个用例
```

- 没有 pytest；测试都是 `unittest`，直接跑文件。
- `scripts/transcribe.py` 的重依赖（faster-whisper / google-genai / feedparser）在测试里用 `sys.modules` 桩替代；`align_timings.py` 复用 `transcribe` 的下载与 sidecar，所以测试文件顶部先打桩再 import。
- 真实转写只在 Python 3.10 上可跑（本机 `C:\Users\游梦\AppData\Local\Programs\Python\Python310\python.exe`），3.14 装不了 faster-whisper。

## 八、当前状态（2026-11-14）

**线上**：

- 13 个已发布节目的 transcript 标签全部指向 `json/` 词级 JSON；`data/`、`json/` 覆盖全部节目，
  旧 VTT 归档在 `data/<slug>/legacy-vtt/`；
- 旧翻译 / 对齐链路已删除：`translate.yml`、`align.yml`、`translate_vtt.py`、
  `generate_zh_feed.py`、`translations.json`、`podcasts_translate.json`；
- 站点资源已清理：`feed-zh.xml`、未引用的 `transcripts/*.vtt` 与 `transcripts/zh/` 已删除，
  `site/` 从 646 MB 降到约 40 MB；
- 仍以 VTT 发布的只有 7 集：hwmym 3 集、taproot 4 集；保留它们的 VTT、
  taproot 的 4 个中文 VTT、hwmym 的 3 个 timings。

**未完成 / 注意**：

1. 这 7 集补转并导出 JSON 后，删除对应 VTT/timings，并从 `shows.json` 去掉 `timings`；
2. crawl 仍每周运行，只服务 pragmatic-engineer（无已发布 feed）与根索引；
3. `align_timings.collect_shows` 遇到单个畸形 RSS 会整 job 失败（2026-11-03 实测某个 Substack 源）。

## 九、已否证的方案（不要再提）

| 方案 | 否证依据 |
| --- | --- |
| 把 enclosure 改写成"干净 master 地址"以去广告 | 广告由 CDN 按听众 IP 插入；同 IP 下 wrapper 与 master 是同一个文件，改写只丢发布方统计 |
| 用 PodScripts 的 cue 时间当锚点做窗口对齐（TMLT 原方案） | PodScripts 时间是均匀切的、且含我们音频里没有的广告，窗口对齐会把整行词压成一个瞬间（实测 54% 词零时长） |
| 用别人的音频/归档找"无广告母版" | 没有公开渠道；archive.org 只有 hwmym 第一季的第三方上传 |

## 十、排障速查

| 现象 | 先看什么 |
| --- | --- |
| 字幕与音频差约 30 秒 | 只可能是残余 VTT 集：看 `timings/` 里有没有对应 sidecar；词级 JSON 不需要 align |
| 某集反复被回填选中 | sidecar 的 `attempts`；`complete` 是否为 false |
| 翻译整批缺几条 | `translate_blocks` 的"只补缺失编号"日志；Gemini 是否返回了不完整对象 |
| job 绿但什么都没做 | 分片参数被 `continue-on-error` 吞掉？看"检查回填参数"步骤与 `候选 N 集` |
| push 被拒 | `git_push_retry.sh` 会 rebase 重试；同名集产物的 add/add 冲突自动保留远程版本，仍失败多半是 pathspec 越界改了别人的文件 |

## 十一、统一链路

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
| `scripts/pipeline_store.py` | `data/<slug>/state<suffix>.json`、`data/.plans/` 分片计划与单集 JSON 的原子写 |
| `scripts/pipeline_episode.py` | 单集编排（依赖注入，可单测） |
| `scripts/pipeline_publish.py` | 双语 VTT 渲染 |
| `scripts/pipeline_deps.py` | 把 ASR/翻译/抓取/嵌入装配成 deps |
| `scripts/run_pipeline.py` | CLI：分片、预算、`ONLY_SLUG`、`DATA_DIR` |
| `scripts/fill_zh_words.py` | 离线补齐：门控放弃的句子按字数均分，写 `zh_word_mode="even"` |
| `scripts/word_transcript.py` | `data/` 内部 JSON → 公开词级 JSON（官方字段 + fork 扩展）与 raw URL |
| `scripts/publish_site.py` | publish job 入口：导出 JSON、重建 feed/index、登记 progress；内容未变则跳过 |
| `scripts/export_word_json.py` | 手动补导出：`--progress`（office-ladies）或 `--state`（hwmym） |

### 分片与续跑

- 分片数由 `plan_shards.py` 在 plan job 里算：`min(输入上限, 20, 待办集数)`，至少 1 片；
  待办 20 集以内一片一集，超出 20 集才用满 20 片。待办数 = RSS 条目 − state 里 done/失败到上限的集。
- 分片的单位是**集**，不是节目：plan job 把所有节目的待办集合并成一条序列，按 guid 排序后
  全局轮流分配（`pipeline_config.global_shard`），各片待办数差不超过 1。
  > 2026-11-14 踩过：按节目分别取模时，分片数（全局待办数）大于某节目的待办数，会出现
  > 2 个分片 0 集、2 个分片 2 集；17 集待办开 17 片却有 15 个分片才拿到活。
- **分片计划由 plan job 一次性写好**：`data/.plans/<run_id>-<shard>.json`（`run_id` 用
  `GITHUB_RUN_ID`），随 data 分支提交；run job 检出后按自己的计划取活，不再各自现切，
  也不需要用别人的认领集来避让。后续分块复用同一份计划，只去掉已完成的集。
  > 2026-11-04 踩过：每个分块按当前待办集重切，别的片正在跑的那一集（单集 35~40 分钟不可中断）
  > 会被重新分配，两片写同一个 `data/<slug>/<guid>.json`，提交时 rebase 撞车。
- 每片写自己的 `data/<slug>/state-<shard>.json`（单片时仍叫 `state.json`）。
  分片之间不共享文件，并发 push 时各改各的。**完成的集要看所有 state 的并集。**
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
- 一轮结束后会自动链式派发：publish job 最后一步跑 `chain_next.py`，**还有待办且本轮有新产出**
  就再 dispatch 一次同样的输入；本轮 0 产出（配额打空、或剩余集全被 3 次失败挡住）就停。
  workflow 的 concurrency 组只留一个 pending，所以链式派发是"上一轮跑完才开始下一轮"。
- 译文必须是中文：`needs_translation` 把"英文句子的译文里一个汉字都没有"判为未翻译——模型
  偶尔把同批**另一条**的英文原文当译文返回，长度校验和"与原文相同"都拦不住（实测 hidden-brain
  一集第 8 批尾部 20 条）。这些句子单独补译 `TRANSLATE_RETRANSLATE_PASSES`（默认 2）轮，
  仍不行就保留原文并告警，**不整集失败**。播放器读 JSON 时中文数组也按索引对齐，
  长度不齐才按时间兜底且取**最近**一条，避免个别缺失把整集中英错位。
- 历史数据补译：`scripts/fix_zh.py`（workflow `fix-zh.yml`，输入 `slug`/`dry_run`）只重译
  缺中文的句子并重建 `zh_words`，随后重新发布受影响的节目。它把**所有集缺的字幕合成一次调用**
  （内部按 150 条切批）——按集单独发请求会撞全局限速，1520 集 ≈ 12 小时；workflow 逐节目
  “补译 → 发布 → 提交”，超时也只丢当前节目。`dry_run=1` 只统计不发请求。
- 关闭上文上下文后 Whisper 按 30 秒窗口切，边界常落在词组中间。`merge_fragment_cues`
  把"前一条没有句末标点 + 后一条小写续接"的相邻片段拼回整句，并用词级停顿判断：
  间隔 ≤0.35 秒且下一句以虚词（and/but/so/that/to…）开头时，即使大写也合并；
  间隔 >0.8 秒视为真停顿不合并（180 字符 / 20 秒 / 60 词上限）。合并后再用
  `split_long_cues` 把 >35 词的句子在停顿处切开（要求词与文本 token 数一致，否则不动）。
  实测 hidden-brain 一集 1297→893 条，中位词数 10→15，无句末标点占比 41.9%→15.7%；
  暂停感知上线后再降到 8~13%。只影响新的 ASR 产出（hwmym 同路径），已有集不重新转写。

### 中文词时间的三层兜底

1. 有小句（翻译契约）：按英文词数分配小句跨度，再按字数分到词；
2. 无小句或门控不自信：`zh_align.fallback_zh_words` 做词级 DTW（要求英中小句数差 < 3 且分配比例不偏）；
3. 门控放弃：按整句字数均分，句子上写 `zh_word_mode="even"`，消费方据此降级。

第 3 层现在也会在管线里自动发生；历史语料用 `python scripts/fill_zh_words.py <data_dir>`
离线补（不碰 ASR、不花 Gemini），补完 121 集覆盖率从 79.6% 到 99.9%（剩下 109 句中文只有标点）。

### 迁移一个节目（office-ladies 2026-11-02、smartless 2026-11-03 实跑过）

1. `feeds.json` 加该节目：`text_source`（**2026-11-09 起统一用 `asr`**：PodScripts 页面已经解析不出内容，
   实测 hidden-brain 18/18 集都回退 ASR，`podscripts` 分支只留作历史兼容，不再配 `podscripts_id`）、
   `publish: true`；
2. `podcasts.json` 给该节目加 `"migrated": true` —— crawl 跳过抓取与 feed/index，但总索引仍列出；
3. **决定是否回填历史集**：
   - 只切换新集：`python scripts/seed_state.py <slug> --data-dir data --shards 10`
     把 progress 里的旧集标成 done，新链路只处理新集；
   - 要让历史集也有词级 JSON：**不要 seed**，让 `data/<slug>/` 的 state 为空，直接分波跑；
4. 分波跑 `transcripts.yml`：先用 `shards=10`、`max_minutes=45` 做金丝雀（每片约 1 集），
   验证 JSON 结构、中文覆盖率与词时间；再用 `max_minutes=270` 反复 dispatch，直到 done 集数 = 目标；
5. 全量完成并发布后收尾：VTT 移到 `data/<slug>/legacy-vtt/`（含 `zh/`），
   删除该节目已不被 feed 引用的 `site/<slug>/transcripts/`。

**分批迁移的硬约束**：`pipeline_site.merged_processed` 只有在
`json/<slug>/<stem>.json` 实际存在时才把记录切到 JSON，否则保留 `vtt_filename`。
破坏这条会在回填未完成时把整批集从 feed 删掉（2026-11-03 已修复并加测试）。

**验收清单**（每次迁移都按这个查）：

- `data/<slug>/` 里 done 集数 = 目标集数，失败 0；
- feed `items` = 目标集数，transcript 标签全部 `application/json`、0 个 `text/vtt`；
- 随机抽 3 个 raw JSON 返回 200，且 `version=1.0.0`；
- 未回填的集仍保留 `text/vtt` 标签与对应文件，已回填的集不再引用 VTT。

**同一节目只能有一个产出方**；切换后观察一周 `git log`，确认旧链路不再产生该节目的提交。
回滚：把 slug 加回 `podcasts.json`、从 `feeds.json` 删除即可。

### 与旧链路的关系

全量迁移后，旧链路只剩 crawl（未迁移节目 + 根索引）与 transcribe（hwmym）；
translate / align 两条已在 2026-11-14 删除。
统一链路的产物在 main 的 `data/`，`publish` job 才写 `site/` 和 Feed。
`data/` 不进 Pages 上传（`deploy.yml` 只传 `site/`，且只由 `site/**` 的提交触发）。

### 词级 JSON 字幕（2026-11-02）

- 13 个已发布节目与 hwmym 的 transcript 是仓库里的
  `json/<slug>/<stem>.json`，由 `https://raw.githubusercontent.com/lzoreal/MyTranscript/data/...`
  直接提供；**不进 Pages**（当前约 2.2 GB，放进站点会超过 1 GB）；`data/`、`json/` 在
  独立的 `data` 分支上，main 只保留代码和 `site/`；
- JSON = Podcasting 2.0 官方字段（`version`、`segments[].startTime/endTime/body`，秒）
  + AntennaPod fork 扩展（`segments[].start/end/text/words`，毫秒）；
- 每集一个双语文件，`body/text` 是「英文句 + 换行 + 中文句」；`words` 只含英文词
  （fork 解析器要求单调递增，混入中文词会被整段丢弃）；
- 所有节目只保留 `feed.xml`，不再生成 `feed-zh.xml`；
- 旧 VTT 原样归档在 `data/<slug>/legacy-vtt/`（含 `zh/`），不再发布；
- 导出只读 `data/`：其余 12 个节目由 `transcripts.yml` 的 publish job，
  hwmym 由 `transcribe.yml` 在每次运行尾部完成；`scripts/export_word_json.py` 供手动补导出；
- `scraper.is_episode_processed` 认得 `json/` 下的产物，VTT 归档后 feed 不会被清空；
  `transcribe.is_cached_episode` 同理，hwmym 不会因 VTT 移动而重转。
