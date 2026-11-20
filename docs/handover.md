# MyTranscript 交接文档

最后更新：2026-11-18。面向接手者：先读本文件，再看 [AGENTS.md](../AGENTS.md) 的作业规则。

## 一、这个项目是什么

把播客做成**带字幕的增强版 RSS**，托管在 GitHub Pages：

| 站点 | 地址 |
| --- | --- |
| hwmym（自转录） | https://lzoreal.github.io/MyTranscript |
| 其余节目 | https://lzoreal.github.io/MyTranscript/podcasts.html |

Pages 站点清理旧字幕后约 **40 MB**（`site/`）；词级数据 `data/`、`json/` 放在独立的
**`data` 分支**（main 只有代码和 `site/`），由 raw.githubusercontent 提供，不进 Pages。

**字幕来源现在只有一条**：13 个已发布节目（含 hwmym）都走
`feeds.json` → `transcripts.yml`：RSS → ASR 词流 → Gemini → `data` 分支的 JSON →
publish job 写 feed/index。hwmym 的旧 `state.json` 只作为历史记录读取
（`publish_site.merge_state_records` 在首次发布时把它并入 `progress.json`），
`transcribe.py` 不再有独立 workflow。

旧 VTT 翻译 / 对齐链路（`translate_vtt.py`、`generate_zh_feed.py`、`translate.yml`、`align.yml`）
已于 2026-11-14 随全量迁移一起删除。13 个节目的 feed 现在全部是
`application/json`，`site/` 里已无 VTT 与 `timings/` 资源。

## 二、数据流

```
Crawl（周一 05:00 UTC / 手动）
  只处理 podcasts.json 里 migrated=false 的节目（目前已迁移的全部跳过）
  → progress.json → 根索引 index.html / podcasts.html
        └─→ Deploy Pages（任何 push 到 main）

Transcript Pipeline（手动 dispatch；分片数 = min(待办集数, 20)）
  RSS → ASR 词流 → Gemini 翻译 → data/<slug>/<guid>.json
        → publish job：只对内容有改动的节目导出 json/、重建 feed.xml + index.html → progress.json
  （13 个节目包括 hwmym 都走这条；没有单独的 transcribe 流程）

```

`transcribe.yml` 已删除；hwmym 的 3 集历史 VTT 与 `timings/` 在 2026-11-14 切到
JSON 后已删除，`state.json` 只作为历史记录保留。

各 workflow 有独立 concurrency group，可并行；提交一律走 `scripts/git_push_retry.sh`（只 `git add` 自己的 pathspec，push 被拒就 rebase 重试）。

## 三、脚本职责

| 文件 | 行数 | 职责 | 关键函数 |
| --- | --- | --- | --- |
| `scripts/scraper.py` | 959 | 生成增强版 Feed 与索引（publish 侧仍在用）；PodScripts 抓取只服务未迁移节目 | `process_podcast`、`generate_podcast_feed`、`parse_transcript` |
| `scripts/transcribe.py` | 2279 | 历史回填与下载/代理工具库（hwmym 已并入统一管线；不再有 workflow） | `whisper_transcribe`、`download_audio`、`run_backfill` |
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
- `state.json`：`{ "version", "podcasts": { "<slug>": { "feed_url", "processed", "transcripts": [...], "total_processed", "last_run", "feed_title" } } }`（hwmym 历史记录，只读；首次发布时并入 `progress.json`）

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
  player.html                多节目播放器 + 站点外壳的标记（静态；读 shows.json / catalog.json + 各节目 feed）
  player.js                  播放器全部脚本的成品（由 src/player-js/*.js 拼接，勿手改）
  player.css                 播放器全部样式（外置，player.html 用 <link> 引入）
  shows.json                 播放器节目清单（新增节目时同步更新；无 feed 的节目 feed 为 null）
  catalog.json               首屏轻量目录（build_catalog.py 生成：封面、简介、最近 20 集）
  <slug>/
    feed.xml                 ← 唯一的字幕 Feed（feed-zh.xml 已下线）
    index.html

src/player-js/               播放器脚本分片（00…10，按文件名顺序拼接，内容顺序与原脚本一致）
  00-kernel.js                      纯函数层（时间格式化、HTML 转义、括号判定、loader），挂 `MYTK`
  01-theme-reader-shell.js          主题、阅读器、导入、壁纸（主 IIFE 开头，用同名解构接回 kernel）
  02-live-caption-wasm.js           实时逐词字幕 + Moonshine/sherpa WASM 引擎
  03-native-asr-service-worker.js   Tauri 原生推理（sherpa C API）、跨域隔离 Service Worker
  04-local-audio-plugin-host.js     本地预转写、精听、插件宿主（能力图/生命周期）
  05-transport-transcript-nav.js    transport、进度/音量、文字稿交互、章节、点词、播放列表、离线下载、模型管理
  06-catalog-feeds-search.js        目录与本地状态、feed 缓存、OPML、封面、在线搜索
  07-routes-pages.js                路由、页面片段、首页/库/发现/搜索/节目/收件箱/设置
  08-study-ai.js                    自动翻译、AI 学英语（含 window.__xai 挂接）
  09-player-integration.js          播放器与页面集成入口
  10-desktop-bridge-tail.js         桌面壳桥（MediaSession/托盘/迷你窗）与主 IIFE 收尾
```

改分片后必须重建成品，否则站点加载的还是旧脚本：

```bash
python scripts/build_player_js.py          # 拼接 src/player-js/*.js → site/player.js
python scripts/build_player_js.py --check  # 只校验是否同步（tests/test_player_build.py 用）
```


`catalog.json` 由 `scripts/build_catalog.py` 在 publish job 发布后重建；内容未变时不重写，
避免空提交。每个节目含封面、简介、语言、分类、总集数、有本站文字稿的集数、
最近更新时间、最近 20 集（标题、日期、时长、音频、字幕、400 字以内简介），
只服务首页、播客库、发现和节目页的首屏；完整单集仍按需解析 `feed.xml`。

- `episode_count` 是 feed 里的全部 item 数；`transcript_count` 只数真正带本站
  `podcast:transcript` 的 item，`latest_transcript_count` 只数最近 20 集里的相应数量。
- `language` 取 channel 的 `<language>`（小写），`categories` 收集 iTunes 主分类与子分类。
- `latest_published_at` 是最近一集的 UTC 时间（`YYYY-MM-DDTHH:MM:SSZ`），发现页“最新更新优先”用它排序。

根 `index.html` 现在是跳转到 `player.html#/home` 的入口页；逐节目清单保留在
`podcasts.html`。两者的生成器在 `scripts/transcribe.py` / `scripts/scraper.py`。

### 播放器外壳与本地状态（2026-11-16）

`site/player.html` 同时是应用外壳和播放器（样式在 `site/player.css`、脚本在 `site/player.js`，
HTML 只留标记与外链），hash 路由（`#/home`、`#/library`、
`#/discover`、`#/search`、`#/podcast/<key>`、`#/episode/<key>/<ep>`、
`#/player/<key>/<ep>`、`#/queue`、`#/history`、`#/bookmarks`、`#/notes`、
`#/listening`、`#/settings`）。旧的 `?show=&ep=` 深链仍可用。

浏览器本地键：

| 键 | 内容 |
| --- | --- |
| `myt-subs` | 订阅；不存在时为空（不再自动订阅内置源），通过「选择导入内置源」或单节目订阅显式导入 |
| `myt-progress` | 每集 `{t,d,at,show,title,img,key,feed}`；兼容旧 `{t,d,at}` |
| `myt-queue` / `myt-bookmarks` / `myt-notes` | 队列、句级书签、笔记 |
| `myt-prefs` | 默认倍速、自动连播、记住位置 |
| `myt-play-mode` / `myt-sleep` | 收听模式、睡眠定时 |
| `myt-theme*` / `myt-reader` | 主题与阅读排版 |
| `myt-cors-proxy` | 站外 feed 直连失败时的代理模板（`{url}` 占位） |
| `myt-mini-caption` | 悬浮底栏字幕展开状态（`1` / `0`，默认展开） |

站外 feed 先直连（Simplecast / Megaphone / Amperwave / Libsyn / Art19 等返回
`Access-Control-Allow-Origin: *`），失败后尝试 `myt-cors-proxy`，再失败可由用户粘贴
RSS 内容；原始 XML 缓存在 IndexedDB `myt-feeds`（6 小时），内存里的解析结果
（`app.feedCache`，值是 `{feed, at}`）同样按 6 小时过期，过期后重新请求，
避免长时间不刷新页面一直用旧 feed。站外节目只有音频，不提供增强字幕。

悬浮底栏（`#miniPlayer`）和实时字幕合成一个面板：字幕是面板顶行（`#miniCaption`），
下面一行是封面、标题、上一集/播放/下一集和进度。右侧箭头（`#miniExpand`）只在有 cue 时
出现，行为是展开/隐藏字幕（展开时朝下、收起时朝上，`aria-expanded` 同步），默认展开，
选择写入 `myt-mini-caption`；收起后面板回到单行高度。封面和标题仍打开完整播放器。
播放/暂停按钮使用几何居中的 SVG 图标（`▶` / `Ⅱ` 文本字形已不再使用）。

### 播放器启动顺序（2026-11-16）

`initPlayer()` 先读 `shows.json`（8 秒超时）和本地状态，然后立即 `bindShell()`、
`applyRoute()`；`catalog.json`（12 秒超时）在后台加载，成功后 `mergeCatalog()` 并重绘
首页、发现、播客库和搜索页，失败或超时则降级为 `shows.json` 的节目清单并在发现页提示。
`getJson()` 统一带 `AbortController` 超时，任何清单请求都不会无限挂起。

### 发现页目录（2026-11-16）

发现页在在线搜索下方提供本站目录：搜索框、分类、排序（目录顺序 / 最新更新 / 集数最多 /
名称）、订阅状态（全部 / 已订阅 / 未订阅）和“只看有增强文字稿”。筛选逻辑集中在
`filterCatalogShows()`，只处理有 feed 的内置节目。节目卡片拆成链接（`a.pod-card-main`）
和独立的订阅按钮，展示分类、语言、两行简介、文字稿覆盖率（`transcript_count/episode_count`）
和最新单集；顶部搜索结果也会额外列出未订阅的本站目录节目。

### 线上播客搜索（2026-11-16）

发现页的在线搜索并行请求 Apple Podcasts（iTunes Search API）与 Podcast Index，
按 feedUrl 去重并参考 AntennaPod 的排名权重合并。Podcast Index 使用 AntennaPod
`net/discovery/build.gradle` 里的公开默认凭据（会出现在网页源码里；不是机密），
请求失败、超时或 CORS 被拦时静默回退 Apple 结果，来源标注会写明实际来源。
Apple 搜索返回 `feedUrl/collectionName/artistName/artworkUrl600/trackCount`；
Podcast Index 返回 `feeds[].url/title/author/image/episodeCount`。结果按规范化后的
feed URL 去重（忽略大小写、默认端口和尾部斜杠），重复项的简介、封面、分类等非空字段
互相补齐；每次搜索先递增请求序号，空查询会清空结果并作废仍在路上的旧请求。
合并后默认显示 20 条，可点“加载更多”。搜索结果标题与内置节目名精确匹配时，
优先提供“打开增强版”（按产品决定保留标题优先；同名但 feed 不同的站外节目仍可能被
标成本站增强版）；手动添加 RSS / OPML 导入则按规范化 feed URL 识别本站节目。

`site/` 里不再有字幕文件：feed 只引用 data 分支的 JSON；播放器仍保留 VTT/侧车
导入能力，供本地实验用。

### 播放器（`site/player.html`）取字幕规则

- 只认 feed 里属于本项目的 `podcast:transcript`（host 为 `lzoreal.github.io/MyTranscript` 或
  `raw.githubusercontent.com/lzoreal/MyTranscript`），忽略 Buzzsprout 等外部字幕链接；
- `application/json` 直接按 `segments` 画词级并取 `body` 第二行中文；JSON 的 `words` 是 ASR
  原生时间，播放器不再做压缩词串平滑和首词重叠跳过（这两项修补只用于 VTT + `timings/` sidecar）；
- `text/vtt` / `timings/` 解析只保留给本地导入的实验数据；线上 feed 已不再有 VTT，
  `shows.json` 里也去掉了 `timings` 标记；
- 没有字幕的集仍然可以播放音频；
- 音频优先用 feed enclosure（多跳跟踪 URL）；播放出错时自动重试、解析最终 CDN 地址、退回
  `media:content` 直链，并在播放器上方显示可点击重试的提示；
- `audio_seconds` 与浏览器 `duration` 相差超过 1% 时不做整体缩放（通常是动态插播广告导致音频内容不同）；
- 播放进度存在 localStorage `myt-progress`（键 `show:episode`，值为 `{t,d,at}`）；播放中每 5 秒写一次，
  暂停/seek/页面隐藏时强制写入；加载音频元数据后，若上次停在 5 秒之后且离结尾超过 10 秒则自动恢复；
  播放结束清除该集记录；
- 详情面板的“对齐到当前句”进入选句模式：先锁定按下按钮时的播放位置，再点击任意一句作为该时刻
  应高亮的句子，按 `offset = 锁定时间 − 该句 speechStart` 更新偏移；Esc 或再次点按钮取消。

### VTT 导入格式（仅本地实验）

线上已不发布任何 VTT；播放器仍能导入 VTT/侧车做对比实验，旧形态规则保留在这里：

| 文件 | 形态 | 行/块 |
| --- | --- | --- |
| hwmym 风格 | **中英双语** | 4（序号/时间/英文/中文） |
| 抓取节目风格 | **英文单语** | 3（序号/时间/英文） |
| 中文轨 | **中英双语** | 4 |

> 2026-10-29 冒烟教训：早期设计假设"抓取节目的英文文件也是双语"，解析出 0 块。

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
- 站点资源已清理：`feed-zh.xml`、全部 VTT 与 `timings/` 已删除，`shows.json` 去掉了
  `timings` 标记，`site/` 约 32 MB；
- hwmym 也已迁到统一管线：`transcribe.yml` 删除，旧 `state.json` 首次发布时并入
  `progress.json`（124 条），feed 124 集全部为 JSON。

**未完成 / 注意**：

1. psych20s / algorithms 各有 1 集在中国代理池下载失败（attempts=3，已被判阻塞），
   需要 AU 出口重跑并先清 attempts；
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
| 字幕与音频差约 30 秒 | 词级 JSON 的时间来自 ASR，不需要 align；本地导入的 VTT 才看 `timings/` |
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

全量迁移后，旧链路只剩 crawl（未迁移节目 + 根索引）；
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
- 所有节目（含 hwmym）都由 `transcripts.yml` 的 publish job 导出；
  `scripts/export_word_json.py` 供手动补导出；hwmym 的旧 `state.json` 记录在
  `publish_site.merge_state_records` 里首次并入 `progress.json`，其中 3 集只有 VTT 的
  记录继续按 VTT 发布，直到它们跑出 JSON；
- `scraper.is_episode_processed` 认得 `json/` 下的产物，VTT 归档后 feed 不会被清空。

### 文字稿交互：本集内搜索 / 文字卡 / 键盘逐句（2026-11-17）

- **本集内搜索**：`Ctrl+F` 或 `/` 打开顶部搜索条（`#findBar`）；输入即按句子匹配（`cue.text` + `cue.zh`，
  小写、空白折叠），命中句加 `.find-hit`，当前命中再加 `.find-cur`；`Enter`/`↓` 下一处、`Shift+Enter`/`↑`
  上一处，每次跳转会 `seekTo(cue.start)` 并滚到那句，`Esc` 关闭并清标记。输入时只高亮+滚动、不改播放位置，
  避免边打字边把音频拖走。范围只有当前单集（跨集搜索是库搜索，不是这个）。
- **文字卡**：在文字稿里拖选任意文字 → 浮出 `#selTools`（复制 / 文字卡）。「文字卡」拼成 Markdown：
  `> 原文` + `> 译文`（有中文时）+ 空行 + `— 节目 · 集标题 · mm:ss` + 回跳链接（`origin+pathname#/player/<slug>/<id>`）。
  复制优先 `navigator.clipboard`，失败退回 `textarea + execCommand`。
- 拖选完立刻松手会触发 `.cue` 的 click（原本是「点句跳转」），两个 click 处理器都加了
  `if (!getSelection().isCollapsed) return`，否则一拖选就把播放位置跳走。
- 浮条位置取 `range.getBoundingClientRect()`，上方放不下就翻到选区下方，左右夹在窗口内；文字稿一滚动就收起。
- **键盘逐句**：`↑`/`↓`、`j`/`k`、`[`/`]` 都是上/下一句（`jumpCue(±1)`，跳转即 seek + 滚到该句）；
  `Space` 播放/暂停，`←`/`→` −15/+30 秒。输入框、按钮等可交互元素上的按键不劫持。
- 换集/重新渲染时由 `window.mytFindReset`（在 `renderCues()` 开头调用）关掉搜索条与浮条，
  避免把上一集的命中标记带进新的一集。

### 播放页实时逐词字幕（2026-11-16）

- 链路：`fetch(音频 URL, {headers:{Range}})` 按时间窗抓字节（需 CORS）→ 按 CBR 码率把 `播放位置 + 提前量` 换算成字节偏移，前后留余量 → 扫 MP3 帧重同步到帧边界 → 走帧到目标时长（防止服务端忽略 Range 解出整集）→ `AudioContext({sampleRate:16000})` 解成 16 kHz 单声道 PCM → `Moonshine tiny-streaming`（`@moonshine-ai/moonshine-wasm@0.1.6`，jsDelivr 动态 import）→ 正文逐词行渲染。**`<audio>` 完全不动**：不改 `crossOrigin`、不建 `createMediaElementSource`，所以失败模式只是「拿不到字节」，不会把音频图锁死或变哑。
- 为什么不用 `MediaElementAudioSource` 采集：采集拿到的永远是「已经播出去」的音频，比播放头晚，不可能「提前 s 秒」生成。要提前，必须自己解还没播到的音频。
- 为什么不是整文件下载：megaphone 顺序下载实测只有 150~240 KB/s，45 MB 的整集约 3~5 分钟；而且播放器常从记住的位置（如 918 秒）直接开播，顺序下载完全服务不了那个位置。Range 窗口方案在 918 秒处开启 4 秒内就出词级行。
- 格式探针：先用 Range 取 0~128 KB，跳过 ID3v2（读 size 字段）找首帧，再走 256 帧确认码率/采样率恒定，得到 `{origin, bps = br/8, sr, spf}` 的 CBR 描述。VBR 与非 MP3 直接给明确错误（「这个音频是可变码率 MP3，暂时不支持提前生成」/「这个音频不是 MP3，暂时只支持 MP3 的提前生成」），不再兜底整集下载。
- 「提前量」是设置页「实时字幕提前量」（`prefs.liveLead`，默认 60 秒，可选 0/15/30/60/120/300，0 表示只跟随播放）。pump 每 160 ms 把音频喂到 `min(总时长, 播放位置 + 提前量)`，每轮 70 ms CPU 预算、每次按 Range 取 10 秒窗口。解码窗口按帧对齐会多带一两秒，喂之前要截到 `本轮起点 + 需要多少秒`，否则提前量会系统性偏大（实测 15 秒档偏移到 17~18 秒）。
- **取回来的 PCM 必须缓存跨轮复用**（`LIVE.pcm = {start, data}`）：早期每轮都重新取 30 秒字节 + `decodeAudioData` 整段，却只喂得进 1~2 秒、其余丢弃，一轮实测 1.5~3.6 秒，界面和播放一起卡，`next` 永远追不上播放头。现在按 0.5 秒一片喂、片间 `await setTimeout(0)` 让出事件循环，**一轮只跑一次 `transcribe()`**（它要按积压音频整跑一遍模型，积压多少秒就慢多少：12 秒积压一次 500 ms 以上），喂到窗口尾才置空重取。
- 高亮抖动的两个坑：①流式文本每 0.5 秒重发一次同一句，早先每次 `replaceChildren` 整行重建会抹掉 `.word.active` 并连续重排，现在词数与各词起点不变时只改 span 文本；②行起点比它的首词早零点几秒、以及刚建出来还没带词的行会让 `.word.active` 空一帧（看起来像高亮消失再跳回来），所以无词行要回退到最近一条真的有词的行，行首之前先压住第一个词。取时一律用 `audio.currentTime`，`liveMediaTime()` 带倍速估算项，和音频时间轴对不上。
- 播放头行用游标定位（行按时间递增），提前量会让最新一行排到播放头之后几十秒，所以**不能**用「最后几行」判断高亮；未播到的词是 `pending` 样式，视野跟着播放头走。游标行之前的行整体收成 `past`、之后整体保持 `pending`，只有游标行推进 `.word.active`——两行时间有重叠时否则会同时出现两个 active。
- 三种「播放头与喂音频起点脱钩」的入口都要管住：①`seeked` 里如果位置和当前起点差不到 2 秒就**不清行也不重建**（音频重载、缓冲重试也会发 `seeked`，否则会把刚识别出来的行清掉）；②pump 每轮开头若发现 `播放头 - next > 20 秒`，说明播放头跑到前面去了（换过音频、长时间缓冲、进度恢复），**只重建流、不清行**，超过 120 秒才清行（阈值不能小：慢网取一个窗口要一两秒，`next` 天然落后一两秒，按 2 秒判会每轮都重建、音频永远喂不进，表现是高亮停在某一句不动）；③重建时 `next` 重置到当前播放头。跳到已识别区间之外时用 `liveTrimRowsAfter(head)` 只砍播放头之后的行，之前的识别结果留着（整屏清空会让读者以为坏了，还得白等几秒）。
- 实时模式自己是会滚的：原来的 `scrollWord()` 在「居中」档直接 `return`，实时行完全不动，所以另走 `liveFollow()`——居中档要求高亮词中心与正文框中心偏差超过框高 16% 才 `scrollIntoBox(el,'center')`，边缘档 90 px 边距。配套必须有 `body.live-on .transcript{padding-bottom:calc(48vh + 60px)}`：实时行往下长，末尾不留半屏空白时 `scrollTop` 早早触顶、最新一行永远贴底，怎么滚都居不了中（实测 `st` 卡在 420 / `off` 卡在 +289 px）。
- 时间轴一次性错位最狠的来源是「音频元数据还没到就开始喂」：`readyState 0` 时 `currentTime` 是 0、时长是 `NaN`，按 0 锚定会产出一串 `00:11` 之类错时间的行，随后播放器恢复到记住的位置（如 28:55），整屏时间都对不上。现在 `readyState<1 || !(duration>0)` 只写「等待音频加载…」不喂；行必须按时间单调入列（迟到半句旧时间直接丢弃），否则游标会定位到错行、高亮跳到别的句子。
- 播放优先：音频缓冲（`buffered` 里包含播放头那一段的剩余秒数）低于 2.5 秒时，本轮不取新窗口，状态条写「等待播放缓冲…」。源站只有一两百 KB/s，抢带宽会让播放卡；阈值也不能太大（6 秒在弱网下等于一直让路，识别几乎不长行，看起来就是「不可用」）。首枪探测失败会自动重试 4 次（同一 URL 重试通常就通）。
- pump 的重启不能被「正在跑」挡住：重建经常是在一次 pump 内部同步触发的，此时 `pumping` 仍是 true，若 `liveStartPump()` 因此提前 return，就再也没人调度下一轮，表现为「状态条停在实时识别中、一行都不出」。在飞的旧泵靠 `pumpGen` 代际号判断自己过期，不会重复喂音频。
- 状态条文案每轮都更新（`liveUpdateMeter`）：一句都没识别出来时也要显示「正在取音频…」或「音频片段取不到，正在重试（第 N 次）」，否则取字节失败会被完全静默掉（之前出现过 24 秒无输出、界面却停在“实时识别中”）。
- `site/live-sw.js` 是同源 Service Worker，只给 `mode==='navigate'` 的同源文档响应补 `COOP: same-origin` + `COEP: credentialless`。Moonshine 默认构建是多线程 WASM，`SharedArrayBuffer` 只在跨域隔离页面可用，而 GitHub Pages 不能自定义响应头，所以靠 SW 补；用 `credentialless` 而不是 `require-corp`，避免挡掉没有 CORP 的封面图。首次点「实时识别」会提示刷新一次，此时把意图写进 `sessionStorage['myt-live-auto']`，刷新回来后自动接着开（不用再点）。
- 词级时间戳依赖 `decoder_kv_with_attention.ort`，而目录加载 `Transcriber.load` 的清单里没有这个文件：必须 `JSON.parse(wasm.sttDependencies('en','2',false))`（ABI 返回 JSON 字符串，不是对象）拿到 `base_url`，自己补上 attention 解码器的 URL 再走 `Transcriber.loadFromUrls`。只设 `word_timestamps:'true'` 不给文件，只会得到没有 `words` 的句子（已实测）。
- 首轮要下载约 40 MB 模型（进浏览器 Cache Storage），之后秒开；`updateInterval` 用 0.5 s。本机用 `python -m http.server 8765 --directory site`（不设任何响应头）即可验证全链路，因为隔离头来自 SW。
- 已知约束：只支持 CBR MP3（m4a/aac、VBR MP3 会明确报错）；直播/边录边播的流不在支持范围。停止实时识别、退出页面、刷新都会让正文回到原本的 VTT / 词级 JSON 渲染，原文字稿不受影响（实测 288 句 / 3881 词原样恢复，播放不中断）。

### 播放页单流播放（MSE 接管播放器生命周期，2026-11-17）

- 目标：不再让播放器和识别各下一份音频。自建 MSE 管线把 Range 取回的同一条 MP3
  字节既 `appendBuffer` 给 `<audio>` 播放，又解成 16 kHz PCM 喂 Moonshine，
  这样识别能真正跑到播放前面，不再受“播放器只缓冲十几秒”的限制。
- 开关：设置页「单流播放（实验）」（`prefs.liveMse`，默认关）。能力检测
  `MediaSource.isTypeSupported('audio/mpeg')` 为真才接管；Safari/iOS 不支持
  audio/mpeg，自动留在原生播放 + Range 取音频的老路径。VBR/非 MP3 同样留在老路径。
- 接管时机在 `liveEnable`：模型与 CBR 探针都成功之后才接管，接管抛错就
  `liveMseStop()` 退回原生并把原因 toast 出来，不让“识别失败”连带播放一起坏。
- 时间轴对齐是整个方案的关键，踩了三个坑：
  ① **起点必须等于元素播放头**。`liveMseBegin` 的锚点取 `currentTime`，若还没开播
  就用记住的进度（`state.resumeAt`）；append 的第一段 `timestampOffset` 用同一个
  值，元素也 `seek` 到它。早先为了“不缺开头”往前挪 0.25 秒，结果元素落在没有数据的
  区间，停在那里不动。
  ② **换过 timestampOffset 就不要复用同一个 MediaSource**。实测新数据已经落进
  `sb.buffered`，元素侧 `audio.buffered` 却只认旧区间（例如只报 `[160.1,170.1]`），
  播放头一进去就卡住。现在跳转/重锚一律丢掉旧 ms、按新位置重建整条管线
  （`liveMseReanchor`）。
  ③ **MSE 里元素在拿到新位置数据之前不发 `seeked`**，靠事件重锚会死锁。所以 pump
  每轮自己检查一次：播放头落在 `sb.buffered` 之外就重建（`seeked` 只当第二道保险，
  且数据已在区间内时只重排游标、不重复重建）。
- 生命周期接管：`loadEpisode` 先 `liveMseStop()` 把播放还给原生再换集；
  `liveFollowCurrentEpisode` 重新探到新音频后等元数据、再自动接管一次（用户不必手动
  开关识别）。停实时识别 / 关开关 / 接管失败都走 `liveMseStop`：记下 `currentTime`
  与播放态，还原原始 `src`，在 `loadedmetadata`（或 3 秒兜底）后回到原位置继续播。
- 播放侧两个必须遵守的规则：`appendBuffer` 一次只能有一个在跑，**不要在
  `sb.updating` 上挂 `updateend` 等回调**（等不到就把整条队列永久挂死），改成 pump
  每轮 tick 调 `liveMseKick()`；`ms.duration` 必须在没有 SourceBuffer 正在 updating
  时设，否则报 `The updating attribute is true`。
- append 的尾部必须落在帧边界上：随意截断会“append 成功、`updateend` 照样触发、
  `buffered` 却是空区间”，所以窗口一律按帧扫描后 `slice`，两头都对帧。
- 吞吐实测（本机 Chrome，单集 1891.5 秒）：`transcribe()` 单次约 100~120 ms，按 1 秒
  PCM 攒一批调用（`LIVE_TR_BATCH`），识别侧实时因子 2.4~4 倍；单流模式下
  `audio.buffered` 能领先播放 30~70 秒；识别批从 1 秒放到 2 秒、每轮预算 140→220 ms
  之后「已提前」稳定在 14~16 秒；把提前量调到 30 秒和 60 秒再测，识别侧同样跟得上
  （30 秒档 100 秒采样稳定 29~31 秒；60 秒档 60 秒采样稳定 59~60 秒，播放不中断、
  `audio.buffered` 始终领先播放同等距离）。所以默认提前量已恢复到用户最初要的 60 秒。
  **结论：下载不再是瓶颈，真正的天花板是“取窗 + 解码”偶发卡死**（实测一次
  `decodeAudioData` 不回调就让整条识别停住 40 秒）。现在两处都加了超时（Range 15 秒、
  解码 10 秒），超时即当这次窗口失败、下一轮重取。
- 喂音频这一步还踩过一个更隐蔽的坑：字节游标（`byteSec`）在重建/跳转后可能跑到“已喂到的位置”前面，窗口起点大于 `LIVE.next` 时裁剪只会剩 1 个采样，`LIVE.next` 再也不动，表现为「已提前」一路掉到 0 之后再也不恢复（实测卡了 30 秒才被 20 秒阈值救回来重建）。现在窗口起点明显领先时直接把喂点对齐到窗口起点。
- 单流模式下 `LIVE.bytePos` 是播放与识别共用的字节游标，**不能并发取窗**：预取只在
  不接管播放（原生 + Range）时启用，单流模式里仍然串行取；两路同时取会让游标错开
  （实测请求 624 秒的窗，回来的是 745 秒的窗）。
- 换集：`loadEpisode` 先记下“换集前是否在播”，再停单流、把播放还给原生，然后
  `liveFollowCurrentEpisode(wasPlaying)` 等 `audio.currentSrc` 落定（最多 6 秒）→
  带重试地探测新音频格式（原来源站首字节偶发失败会让整条识别停在“取音频数据失败”）→
  重建识别流 → 等新一集元数据后自动接管一次 → 按换集前的播放态决定是否接着播。
  探测失败不再判死：6 秒后用当前状态再跟一次。
- 同一标签页里连续接管（关掉再开、换集再接管）：以前第 3 次起 `new MediaSource()`
  会一直停在 `'closed'`，表现是接管静默失败、退回原生。根因不是浏览器的环境特性，
  而是**建新实例前没把旧实例从元素上摘掉**；`liveMseBegin` 现在先
  `audio.pause()` → `removeAttribute('src')` → `load()`，等 250 ms 再建新的，
  实测连续四次开关接管全部成功（每次 src 都变 `blob:`、buffered 随播放头增长）。
- 换集后再接管原来有两个 token 陷阱：①`liveRebuildStream()` 自己也会 `LIVE.session += 1`
  （它要作废旧流的回调），而换集流程是先重建流、再接管，进函数时抓的 session 快照必然
  “过期”，接管一路 abort；②重试是 setTimeout 再调一次，会把正在跑的那次顶掉。现在换集
  流程用独立的 `LIVE.followGen`（最新那次赢、旧的自己退场），重建后不再依赖 session，
  重试也只在自己仍是最新时才排。
  还有一条：新一集原生音频可能十几秒才加载好（源站慢），这时接管会先把正在加载的原生
  src 摘掉，两边都读不到数据、界面停在“等待音频加载…”。现在 `liveWaitAudioReady` 返回
  false 就不接管、8 秒后再跟一次，接管半途失败也会把原生地址挂回去。
  实测连续换集 5 次：3 次当场接管（`src=blob:`、已提前 13~15 秒），2 次因为新一集还没
  加载完而先留在原生，随后自动补接管成功（buf 0-64 → `解析音频格式…` → `src=blob:`、
  已提前 15 秒）。播放全程不中断。
- 跳转后正文永久冻结（长播 + 多次跳转压测抓到的）：往回跳时识别仍在跑、「已提前」
  稳定 14~16 秒、缓冲也在长，但句数与正文永远停在跳转前那几句。根因在 `seeked` 里
  “这个位置已经识别过、只挪游标就行”的判据，先后错了两版：
  ① 用 `LIVE.anchorMedia` 判“位置没变”——可往回跳时 pump 会先按新位置重锚并重建流，
  等 `seeked` 迟到触发时锚点已经等于新 head，这次真跳转被当成“没动”直接 return；
  ② 改成只比“第一行起点 + `LIVE.next`”——旧行是跳转前那一段，中间的大空档会被算成
  已识别。现在按**行本身**判断：找到起点不晚于播放头的那一行，再看播放头离下一个
  已知起点是否超过 30 秒，有空档就裁行 + 重锚 + 重建。这样“点在实时字幕某个词上”
  依旧只挪游标、不白清屏，真跳转则一定会裁掉过期行。
  实测连续 1200 → 900 → 600 → 1500 四次跳转：行数每次都按新位置重排并继续增长
  （16→24、7→13、9→16、22→27），已提前全程 14~15 秒，播放不中断。
- 逐词高亮不跟随（用户反馈“高亮跟随不准确、乱跳”）：根因不在时间映射，而是
  Moonshine 返回的 `line.words` 只有最前面几个词带真实时间，后面补进来的词
  `start/end` 是 0（偶尔还会 `end < start`、时间倒退）。实测同一行：
  `Things 385.35-386.29 / like 386.29-389.11 / hobbies, 389.11-389.33 /
  I 389.33-385.35（负长度）/ enjoyed 及之后的词全是 385.35`。高亮是按“第一个
  `s` 大于播放头的词就 break”找当前词，遇到非单调就卡住；全部 `s` 等于行起点时
  又会一下跳到行尾。行的 `startTime` / `duration` 是可靠的，所以新增
  `liveWordTimes()`：先校验引擎时间（单调、落在 `[0, duration]`、长度非负），
  可用就用；不可用就按词长把整行词均分到 `[startTime, startTime+duration]`。
  「词没变就不重建 DOM」的判据也从比 `s` 改成比文本，并在原地更新每个词的 `s/e`
  （行越长 `duration` 越大，兜底时间会重算，不同步会越跑越偏）。实测高亮按词顺序
  推进，播放头与当前词起点差 0.0~0.8 秒。
- 验证方法：`python -m http.server 8765 --directory site`，开「单流播放」后点实时识别，
  看 `audio.src` 是否变 `blob:`、`audio.buffered` 是否随播放头推进增长、「已提前」是否
  稳定在提前量附近；跳转一次确认能重锚继续播；停识别确认回到原生且播放位置不丢。

### 换识别引擎：sherpa-onnx 流式 zipformer（2026-11-17）

**为什么换**：`liveWordTimes()` 的兜底能救“不跟随”，救不了精度——Moonshine 流式压根
不给可靠的词时间。逐行统计同一集：`tiny` 有真实词时间的行 4/102，`small` 2/126，
其余行只能按词长均分，均分到 12 秒长的一行里误差就有零点几秒，看起来永远是“慢半拍/
乱跳”。所以不修算法，换引擎。

**对照 AntennaPod**（`D:\AntennaPod`，本地读代码，未跑真机）：它高亮稳的原因也在引擎，
`asr/AsrResultMapper.toSegment(text, tokens, timestamps,…)` 拿的是 **token 级 float
timestamps**，先做 `TOKEN_EMISSION_LAG_MS = 400`（token 在发射它的 encoder 帧上报，
比词起点晚约一个 chunk；casefile 14056 中位 400 ms、14049 434 ms）再 clamp 到
`[startMs, endMs]`；`AsrTokenizer` 按 `▁`/空格前缀把 SentencePiece 片段拼成词；
缺词尾用 `computeWordEndTimes`（下一个更大 start / `max(start+120, segmentEnd)`）。
它同样做“预读 PCM 喂识别”（`PreReadPcmPipeline` / `LookaheadPlanner` / `MediaRange`），
和我们 MSE 单流取窗是同一套思路。

**实现（`site/player.html`）**：默认引擎现在是 sherpa（`?engine=moonshine` 可退回）。

- 资源不自托管：wasm 走 `@siteed/sherpa-onnx.rn@1.1.2/wasm/`（jsDelivr，那个包自带完整
  wasm 产物，JS 只挂 `window.SherpaOnnx` / `OnlineRecognizer`，不依赖 React Native）；
  模型走 `csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17`（HF 单文件
  `encoder/decoder/joiner .int8.onnx` + `tokens.txt`，合计约 43 MB）。二进制**用 XHR 取**
  再写进 Emscripten 的虚拟 FS：页面是 `COEP: credentialless`，让 Emscripten 自己 fetch
  跨域资源会被地址空间策略拦（`target IP address space of public yet the resource is in
  address space unknown`）。字节按文件名存进 Cache Storage `myt-sherpa-model`，第二次
  秒开。
- `liveSherpaWords()`：按空格 / `▁` 前缀拼词，词尾取下一个词起点，最后一词用“已喂到哪”
  夹；整段前移 `SHERPA_LAG = 0.4` 秒（照抄 AntennaPod 的实测值，本集未重新标定），
  并保证不倒退、不为负。
- `liveSherpaStream()` 包成和 Moonshine 同形的流对象（`addAudio / transcribe / stop /
  close`），`liveRenderLine` 那一套一行都不用改。
- **断句不能交给 `isEndpoint`**：播客里几乎一直在说话，endpoint 判完还会连着几轮为真，
  靠它 reset 就变成每轮重置、正文一行一个词（实测行数飙到 60）。现在 `enableEndpoint: 0`，
  按显示需要自己断行：**一行最长 12 秒或 40 个词**，只断显示（`cursor` 往后切、`lineId += 1`），
  解码器不动，时间轴不断；攒够 200 个词才 reset 一次（不然流里的特征帧一直涨）。
- pump 里 sherpa 的识别批从 2 秒改成 0.5 秒（增量解码单次便宜，跟得上词）；Moonshine
  仍是 2 秒一批。
- 实测（本机 Chrome，`?engine=sherpa`，从 24:38 起播）：`已提前` 稳定 12~14 秒；行按
  12 秒左右自然断开（每行 2~29 词）；**当前词起点与播放头差 0.1~0.7 秒**（高频采样
  8 次全部对齐），跳转 1600 秒后继续出词、高亮照样跟随。行数与词数随时间单调增长，
  没有重复行。

**已知代价/未决**：①文本准确率低于 Moonshine（人名、生词更容易错，spike 里把“squalid”
拼成“SQUALID”级别）；②首轮要下 12 MB wasm + 43 MB 模型；③`SHERPA_LAG` 是别人的实测值；
④Safari/iOS 走原生 + Range 的老路径，未真机验证；⑤`spikes/sherpa-wasm.html` 是这轮的
最小验证页（0.5 秒块喂 `test_wavs/0.wav`，token 31 / timestamps 31 对齐），保留作回归用。

**有些节目就是不能实时识别（不是引擎的问题）**：`99% Invisible` 的音频落在
`stitcher.simplecastaudio.com`，那个域名**完全不带 CORS 头**（直连实测：Range 请求返回
206，响应里没有 `Access-Control-Allow-Origin`；播放地址还要先经 `mgln.ai` →
`dts.podtrac.com` 两跳重定向）。浏览器拿不到字节，实时识别从原理上做不了，
单流 MSE 也一样不行（它同样要读字节）。所以 `liveHttpGet` 的 `onerror` 会给错误打
`err.cors` 标记，`liveRetry` 见到就直接放弃（重试没有意义），`liveEnable` 报
「这个节目的音频源不允许跨域读取字节，实时字幕用不了（播放和原文字稿不受影响）」。
实测这一集：点实时识别 4 秒内给出该提示，播放正常、434 句原文字稿照常渲染。
想覆盖这类节目只能自建中继代理（与本仓库“不自托管”的前提冲突，暂不做）。


### 桌面壳：Tauri 2 + sherpa-onnx 原生推理（2026-11-17）

**为什么做壳**：网页版有两个浏览器级天花板——①音频源不给 `Access-Control-Allow-Origin`
就彻底读不到字节（`99% Invisible` 那类落在 `stitcher.simplecastaudio.com` 的节目只能降级提示）；②识别跑在 WebView 的 JS 线程里，
WASM 单线程还要背 COOP/COEP。桌面壳把这两件事同时绕开：字节走 Rust（reqwest 带 Range，
不受 CORS 约束），识别走原生 `sherpa-onnx-c-api`（多线程、体积小、CPU 低）。
选型过程中否掉了 Electron（自带 Chromium 200 MB / 250–400 MB 内存）和 Capacitor。

**结构（`apps/windows/`，详见该目录 README）**：

- `src/main.rs` 命令层：`read_range(url, from, to)`（reqwest + `Range`，返回 `tauri::ipc::Response`）、
  `asr_prepare / asr_open / asr_feed / asr_result / asr_reset / asr_close`，状态
  `AppState{engines: Mutex<HashMap<u32, Asr>>, next_id}`。
- `src/asr.rs` 手写 `#[repr(C)]` FFI。`sherpa-rs` 在 crates.io 只封装离线模型、没有 streaming
  模块，`sherpa-rs-sys` 的 build.rs 又强制 bindgen（本机无 libclang），所以直接对着
  `c-api.h`（v1.12.15）写结构体和签名：16 kHz/80 维、`num_threads`、`provider=cpu`、
  `model_type=zipformer`、`enable_endpoint=0`、`greedy_search`。
- `build.rs` 链接 `vendor/sherpa/lib` 并把 3 个 DLL 拷到 `target/{debug,release}`。
- `tauri.conf.json`：`frontendDist="../../../site"`（直接用仓库 site，不复制副本），
  窗口 x=60/y=40 固定位置（GUI 联调时坐标可复算），`withGlobalTauri=true`。
- 页面侧只加了宿主桥：`LIVE_HOST` 从 `window.__TAURI__.core.invoke` 包出
  `{kind:'tauri', fetchRange, asrPrepare, asrOpen, asrFeed, asrResult, asrReset, asrClose}`，
  `LIVE_ENGINE_KIND` 变成 `native`；`liveEmitTokens()` 抽出来给 sherpa-wasm 和原生共用
  （切词/断行/`cursor` 定稿逻辑一份）。网页版分支完全不动。
- 窗口去掉了系统标题栏（`decorations: false`），顶栏当标题栏用：`shellFrame()` 把 `.topbar`、
  `.brand` 里的文本叶子标 `data-tauri-drag-region`（Tauri 只认 mousedown 落点自身带属性的元素，
  标在父容器上无效，也不标按钮/输入框），右上角自绘最小化/最大化/关闭；播放页另铺 38px 透明
  拖拽带。对应要在 capabilities 里放 `core:window:allow-start-dragging`、
  `allow-internal-toggle-maximize`、`allow-minimize`、`allow-toggle-maximize`、
  `allow-is-maximized`、`allow-hide`、`allow-close`（迷你窗共用同一份，`windows: ["main","mini"]`）。
- 桌面集成三件套（2026-11-17 追加）：
  - **托盘**（`build_tray`）：左键显示/隐藏主窗，右键菜单 显示/隐藏、播放/暂停、上一集、下一集、
    迷你窗、退出。播放控制一律 `emit_to("main", "myt://tray", …)` 交给前端，壳层不存第二份状态。
  - **－ = 收进托盘**（`win.hide()`），✕ 仍是退出；主窗与迷你窗都设
    `backgroundThrottling: "disabled"`，否则窗口一隐藏 JS 定时器被节流，实时识别与进度上报会停。
  - **独立迷你窗**（`open_mini` / `close_mini` + `site/mini.html`）：置顶、无边框、不占任务栏，
    344×132。它不加载音频，只发 `myt://mini-cmd`，主窗每 800ms 回推 `myt://mini-state`
    （标题/封面/进度/播放态/能否切集），所以音频实例永远只有一个。
  - **系统媒体键**走页面里的 `MediaSession`（`desktopBridge()`）：Windows 媒体浮层、键盘媒体键、
    耳机键都能播/停/前后跳/切集；若实测按键不响应，再换 Rust 侧 SMTC。
  - **整集下载含词级文字稿**（2026-11-18）：`offline_save_transcript(url, key)` 把 feed 里的
    `podcast:transcript` JSON 落成 `<key>.transcript.json`，与音频同目录；`offline_list` 为每个
    音频条目补 `hasTranscript` / `transcriptSize`。播放页 `readTranscriptDoc` 先读本机 JSON，
    再回落远端；旧版本只下过音频的集，在播放或离线列表点「＋ 字幕」会补下文字稿。
    删除离线时音频和 `.transcript.json` 一起删，容量统计也把文字稿算进去。
  - **AI 整集总结与主题时间戳**（2026-11-18）：单集页「AI 总结」按钮先以暂停态打开播放页，
    等文字稿就绪后打开学习面板并调用 `studyAnalyzeEpisode()`。整集按字幕条数均分成 3 块
    （短集只发 1 块），不再按 13k 字符切 6 块；每块 prompt 要求返回
    `summary` + `topics[{title,start,end,summary}]`，前端把分块结果按 `start` 排序去重，
    主题按钮点击走 `seekTo()`。每完成一块就写 `ep:<id>:partial` 断点；某块失败时重试只跑
    失败块及剩余块，`episodeFresh` 才从头开始。`version:2` 标记新缓存；旧缓存会提示重新总结。
    结果可「复制总结」为纯文本。
    设置里的 AI 服务商可选 OpenAI / Claude / Gemini / DeepSeek / Kimi / GLM / 自定义兼容接口；
    前端把 `provider` 作为 `config.engine` 传给 `llm_chat`，Rust 侧分发：OpenAI 系走
    `/chat/completions`，Claude 走 `/v1/messages`（`x-api-key` + `anthropic-version`），
    Gemini 走 `/models/{model}:generateContent`（`x-goog-api-key`）。
    设置里的「获取列表」通过 `llm_models` 请求厂商模型目录：OpenAI 系 `GET /models`，
    Claude `GET /v1/models`，Gemini `GET /v1beta/models` 并过滤 `supportedGenerationMethods`
    含 `generateContent` 的条目；前端把结果渲染成可滚动、可筛选的模型列表，点选后写回输入框，
    也可手动填写。

**踩过的坑（都会复现，别猜）**：

| 坑 | 结论 |
| --- | --- |
| `cargo build` 报 `Failed to clean up ...out\probe: 目录不是空的 (os error 145)` | target 目录放在 D 盘必挂（`thiserror`/`proc-macro2` 的 build script），`cargo clean` 无效；`CARGO_TARGET_DIR` 换到 C 盘一次通过 |
| 点 `⧉` 后整个窗口卡死（转圈、不响应） | Windows 上 `WebviewWindowBuilder::build()` **在同步命令或事件回调里会死锁**（都跑在主线程，Tauri 文档 `webview_window.rs` 明说）。建窗只能走 `async fn` 命令或独立线程；托盘菜单回调同理，`"mini"` 分支已改成 `std::thread::spawn` |
| 播放页（字幕页）点 ⧉/－/▢/✕ 没反应 | `.reader-top-actions` 是 `pointer-events:none`，只有「← 主页」「ⓘ」「☆」单独设了 `auto`，这些窗口按钮挂在 `.reader-top-right` 下就继承了 `none`，点击穿透到下面的透明拖拽带。`.win-ctl` 必须自己写 `pointer-events:auto` |
| 播放页顶部 38px 的控件/字幕首行点不着 | 早期为了拖窗口铺了一条 `top:0;height:38px` 的全宽透明 `.win-drag` 带（`z-index:11`），它盖住了 `z-index:1` 的 `.reader`。已删除，改为把 `.reader` / `#transcript` **容器本身**标 `data-tauri-drag-region`：Tauri 的裸属性只在「按下点就是该元素」时才拖，点句子照样跳转 |
| 迷你窗开局是一块纯白矩形 | 窗口创建即可见、页面首帧没画完，露出 WebView2 默认白底。改 `visible(false)` + `background_color(Color(22,24,29,255))`，页面画完 600ms 再 `show()`（`on_page_load` 打点确认加载成功） |
| 整集下载时 raw.githubusercontent 返回 503，音频已下但文字稿失败 | `saveOfflineTranscript` 首次失败会用 `transcriptMirror()` 的 jsDelivr 地址重试；仍失败则保留音频，离线列表显示「仅音频 · 可补字幕」，点「＋ 字幕」重试 |
| 迷你窗显示「未在播放」但其实在播 | 多半是**两个 app 实例**各自开了一个迷你窗（重叠），你看到的是没在播的那个。排查前先 `Get-Process mytranscript-desktop` 清干净。通道本身可用 `MYT_DEBUG=1` 验证：日志里应出现主窗推送 + 迷你窗 `state {…}` |
| 识别器创建失败、日志说 `tokens.txt does not exist` 但文件在 | sherpa 用 `std::ifstream` 判存在，路径含非 ASCII（用户名「游梦」）就挂；模型固定放 `%ProgramData%\MyTranscript\sherpa-en-20M`，旧 `app_data` 目录自动搬 |
| 第一次下 DLL 得 404 | v1.12.15 的 Windows 资产名是 `sherpa-onnx-v1.12.15-win-x64-shared-no-tts.tar.bz2`（带 `-no-tts`） |
| HF 直连下模型超时 | 改 `hf-mirror.com` + `curl -L --retry 5` |
| 壳里报「这个音频不是 MP3」 | 这集 ID3v2.4 里嵌了 3000×3000 PNG 封面（APIC 帧约 1,364,202 B），128 KB 探针到不了第一帧。`liveProbeAudio` 改成 128 KB→2 MB→8 MB 递进取窗口，并把“连续两帧都对上”才算帧边界 |
| 发行版启动报 `WebView2 error 0x800700AA 请求的资源在使用中` / `os error 5` | exe 所在目录是**低完整性级别**（`icacls` 显示 `Mandatory Label\Low Mandatory Level:(NW)`）。本仓库 `D:\MyTranscript` 被沙箱写成 Low IL，从那里启动的进程也是 Low IL，WebView2 不肯建环境；解压到桌面/下载目录（Medium）即正常 |
| 加了 `assetProtocol` 后 `cargo build` 直接失败 | `tauri.conf.json` 的 `app.security.assetProtocol` 与 `Cargo.toml` 的 tauri features 必须同时存在：报错原文「The `tauri` dependency features ... does not match the allowlist ... add the `protocol-asset` feature」。两处都要改 |
| 离线文件名里出现中文/emoji | Rust 侧落盘前统一走 `safe_name()`（只留 ASCII 字母数字 `- _`，其他字符换 `_`，截断 120）；JS 侧 `offlineKeyOf()` 用同一套规则拼 `<showSlug>-<epId>`，两边规则必须一致，否则「已离线」判断和实际文件对不上 |

**播放侧四项（2026-11-17 追加，都在 `site/player.html`）**

- **章节导航**：`parseFeed` 每条 item 增收 `chaptersUrl`（`podcast:chapters` 的 `url`）与
  `chapters`（Podlove `<psc:chapter start="…">`，用遍历匹配 `tagName` 末尾是否 `chapter`，
  别按前缀取——命名空间前缀在各家 feed 里不统一）。选中单集后 `loadChapters()`：先用手上已有的
  内嵌章节，有 URL 再走壳的 `http_text` 取章节 JSON（读 `chapters[].startTime`）。
  面板是阅读页右上角的 `☰` + 右侧 `#chapterSheet`，点一条 = `seekTo(start)`；当前章节同步到
  `#chapterNow` 与底栏 `#chapterChip`（`syncChapterNow(t)` 在 `paint()` 里跑）。
- **播放列表**：存储键 `myt-playlists`，形如
  `[{id,name,items:[{key,ep,title,show,date,duration,img}],at}]`。单集页「＋ 列表」开对话框
  选已有列表或新建；「收听模式」页多一张列表卡片，`▶ 播放` 把整批 items 塞进 `app.queue`
  （`saveQueue()`）再播首集，连播直接沿用既有队列逻辑，不另建播放通道。
- **点词查义**：词 span 上右键或 `Alt+点击` → `#wordPanel`（音标 + 词性 + 最多 4 组释义）。
  取词走壳的 `http_text` 打 `https://api.dictionaryapi.dev/api/v2/entries/en/<word>`（绕 CORS），
  结果在内存 `wordCache` 里缓存；这个词不在词典库里时接口返回 404，面板显示「查不到这个词」。
  点击只查词，不动播放位置，也不参与拖选/划句那套浮条。
- **离线下载**：`offline_save(url, key)` 流式写 `app_local_data_dir()/offline/<safe_name(key)>.mp3`
  （先写 `.part` 再 `rename`），进度事件 `myt://offline`（`{key,got,total,pct}`，完成带 `done:true`）；
  `offline_list()` / `offline_remove(key)` 负责列表与删除。播放本地文件走
  `convertFileSrc()` + `asset:` 协议，所以 `tauri.conf.json` 要开
  `app.security.assetProtocol={enable:true, scope:["$APPLOCALDATA/offline/**"]}`，
  Cargo 的 tauri features 也要带 `protocol-asset`。`preferredAudioUrl(item)` 命中离线副本时
  直接返回 asset URL，因此「下载过的单集」在断网时也能播，不用另开一条播放路径。

验收方式（壳里用 DOM 探针，`webview.eval` 看不到 IIFE 里的 `state`）：导入一条带
`psc:chapters` 的测试 feed → 单集页播放 → 章节面板列出 3 条并能跳；Alt+点词出 4 条释义；
点「⤓ 离线」约 9 s 落盘 0.1 MB 后按钮变「✓ 已离线」、收听页出现 1 行；再播这一集时
`audio.src` 实测是 `http://asset.localhost/...offline/...mp3`；「＋ 列表」→ 收听页出现列表卡片 →
`▶ 播放` 跳到 `#/player/<key>/<ep>` 且队列被写入。

**底栏收敛（2026-11-17 追加，`site/player.html`）**

底栏原先一条 bar 里塞了 8 个控件（速度下拉、分隔线、实时、详情、列表、沉浸、主题、Aa），
窗口一窄就换成两行 grid、bar 高度变化顶到字幕区；四种二级容器（bar 内 popover、右下 sheet、
全屏抽屉、右侧栏）各有一套关闭规则，容易残留。现在：

- 底栏只留三块：进度条（时间 / 轨道 / 总时长）、`−15″` / 播放 / `+30″`、当前节目信息（含
  `#chapterChip` 章节名），右侧只剩一个「⋯」`#dockToolsBtn`。速度、逐词/逐句、实时识别、
  剧集信息、剧集列表、阅读排版、沉浸、主题全部搬进 `#dockSheet`，没有任何第二个入口。
- 互斥只有一条：`openDockSheet()` 先关 drawer/details/typeSheet，`openDrawer/openDetails/
  openTypeSheet/closeOverlays/setImmersive` 反过来都先关面板；点面板外、按 Esc、选完动作都走
  `closeDockSheet()`，并把焦点还给触发按钮。非默认状态（非 1× 速度、实时开、逐句）显示在
  「⋯」右上角的小徽标 `#dockBadge` 上，收起来也能一眼看到。
- 进度条改成「拖动预览 + 松手跳」：`input` 只更新预览（`#now` 文本、`#pfill` 填充、轨道上方
  时间气泡 `#seekTip`），`change` 才 `rawSeek`；单击轨道因为原生 range 的 input+change 连着
  来，等于直接跳；双击轨道 `seekTo(当前句 speechStart + offset)`，并把预览收掉。
- 关键约束：`paint()` 与 `liveAdvance()` 都在 `state.seekPreview != null` 时跳过对
  `#now/#seek/#pfill` 的写入，否则拖动会被每一帧的时间回写抢回去；`blur`/`pointercancel`/Esc
  都会丢弃预览并 `paint(true)` 复原。

**实机结果**：speaking-of-psychology 集原生命中识别通过（逐词高亮跟随）；99% Invisible
（CORS + 大封面）在壳里取到 206/131072 字节、探针放大后定位到真正的第一帧、原生识别
连出词（实测 38 句）。网页版行为未变。

**未决**：Windows 分发形态（单 exe+同目录 3 DLL vs NSIS 安装包，未签名有 SmartScreen）——
已定为先用便携 zip，等 UI 稳定再上 NSIS + GitHub Releases 自动更新；系统媒体键若在 WebView2 上
实测不响应，改用 Rust 侧 SMTC；模型分发（首次下载 41 MB vs 随包内置）；`SHERPA_LAG=0.4` 未在本集重标；原生 CPU 只采到
“追赶提前量”时的瞬时值（约 62% 单核），稳态对比未做；Android 未动工（计划原生 Kotlin
WebView + 同一套 C API 的 JNI 包）。
## 底栏补三项基本播放能力（2026-11-17 追加）

自查发现播放页有三个基本功能空洞，补在 `#dockSheet` 里（不再往底栏加控件，维持三块结构）：

- **音量 / 静音**：原来整个播放器没有任何音量入口（仓库里只有 `--muted` 颜色变量）。
  现在面板里一行：`#muteBtn`（扬声器图标，静音时画斜线、`aria-pressed=true`）+ `#volRange`
  + `#volOut` 百分比。音量存在 `prefs.volume`（0–1）、静音存 `prefs.muted`，随
  `myt-prefs` 一起落盘；启动时 `applyVolume(false)` 恢复。键盘 `M` 切换静音（静音且音量
  为 0 时恢复 0.5）。静音状态也会进底栏「⋯」的徽标。
- **上一集 / 下一集**：`stepEpisode(±1)` 早就存在，但只绑了迷你窗按钮、媒体键和托盘菜单，
  播放页没有入口。现在面板里给「上一集 / 下一集」两个按钮，和迷你窗同一套口径（走
  `currentPlaylist()` → `stepTarget()` → `selectEpisode()`，在播就接着播）；键盘 `N` 下一集、
  `P` 上一集。
- **睡眠定时快捷档**：原来只在设置页 `#sleepOptions` 里。现在面板里 30′ / 60′ / 本集 / 关
  四个档，直接复用 `setSleep()`；`syncDockSleep()` 把剩余时间写成「剩 mm:ss」贴在标签后，
  面板开着时每秒刷新，`end`/`off` 用 `.on` 标出当前档。

**键盘守卫的坑**：底栏和面板里的按钮点过一次就会留下焦点，原来的
`if (e.target.closest('button, a, ...')) return;` 会让之后的 Space / 方向键 / 快捷键全部失灵。
现在这条守卫对 `.dock`、`.docksheet` 内的焦点放行，并先 `e.target.blur()`——不 blur 的话
Space 会在 keyup 时再触发一次那个按钮自己的动作。

## 播放时钟降频与 DOM 写入去重（2026-11-17 追加）

原来驱动播放头的是一个常驻 `requestAnimationFrame` 循环：

```js
(function loop() { if (!audio.paused) paint(); requestAnimationFrame(loop); })();
```

即使暂停，它也在每秒唤醒 60 次；播放时每帧 `paint()` 会写三次 DOM（`#now` 文本、`#seek`
的 `value` 与 `aria-valuetext`、`#pfill` 的宽度），再调 `syncJumpPill()` 读两次
`getBoundingClientRect()`——后者是**每帧一次强制同步布局**，是长列表页面最贵的一步。实时识别
模式也吃这条循环。

现在改成「有播放才走表」：

- `PLAY_TICK_MS = 120` 的 `setInterval`，`play` 启动、`pause` / `ended` / `visibilitychange`
  停表；暂停和窗口隐藏时是 0 唤醒（原来始终 60 Hz 空转）。
- `paint()` 里三个写入各自带缓存（`state.lastNowText` / `lastAriaText` / `lastSeekBucket`），
  值没变就不写；`#now` 也只有跨过整秒才变，实际写入掉到约 1 次/秒。
- `syncJumpPill()` 限流 400 ms（或 `force`）；`syncChapterNow()` 用 `idx|title` 记忆，
  不再每帧重写 `#chapterNow` 和 `#chapterChip`。
- `paintWords()` 只重设 `lastIdx → idx` 之间那几个词，不再每次遍历整句 30+ 个词。
  同时修了一个隐藏 bug：切句时把旧句单词重置为 pending，却没有清 `old.lastIdx`，回看同一句
  会命中「idx 没变」的早退，整句停在 pending、没有高亮。
- **缓存作废**：`seekPreviewAt()` 是绕过 `paint()` 直接写 DOM 的，所以 `endSeekPreview()`
  必须把三个缓存置空，否则松手后的 `paint()` 会认为「值没变」而不落值，进度条停在预览位置；
  `liveAdvance()` 里同样的写入也顺手回写缓存，避免实时模式与普通模式互相污染。

效果（结构层面）：播放时 DOM 写入从 60 Hz 降到约 8 Hz，强制布局读取从 120 次/秒降到
≤2.5 次/秒；空闲时不再有任何定时唤醒。撤销方式：把这段 ticker 换回原 rAF 即可，其余缓存
都是纯性能优化、不改变行为。

## 模式记忆与模式冲突（2026-11-17 追加）

播放器里其实有四组互相独立的「模式」：收听模式（`app.playMode`：沉浸收听 / 连续播放 /
节目电台 / 简洁驾驶）、高亮模式（`state.mode`：逐词 / 逐句）、跟随滚动（`state.scroll`：
边缘 / 居中 / 关闭）、阅读沉浸（`state.immersive`，不是收听模式里的那个「沉浸」）。只有收听
模式被持久化了，其余每次启动都悄悄回到默认，用户以为自己的选择没生效。

- **记忆**：`state.mode` 存 `myt-mode`，`state.scroll` 存 `myt-scroll`；启动时在
  `initApp()` 里读回并同步 `#modeSeg`（`aria-selected`）与 `#scroll` 的选中值。切同一个
  模式不再重建整张字幕（原来点「逐词」已经选中时也会 `renderCues()`）。
- **两个「沉浸」会互相踩**：驾驶模式（`body.car-mode`）隐藏正文，阅读沉浸（`body.immersive`）
  隐藏底栏，叠在一起就是一块空屏。现在进驾驶模式会先收起浮层并退出阅读沉浸；进阅读沉浸
  会先把收听模式切回「沉浸收听」（直接改状态和 `car-mode`，不弹两次 toast）。
- **驾驶模式不再空转**：`paint()` 和 `liveAdvance()` 在 `car-mode` 下跳过逐词上色、
  字幕滚动和 `syncJumpPill()`（它要读两次 rect），只更新时间和进度——正文本来就看不见。
  退出驾驶模式时把 `state.nodes[*].lastIdx` 与 `LIVE.rows` 的 `lastIdx` 全部置脏、
  `activeCue = -1`，下一次 `paint(true)` 按「重新定位」的方式一次画对，不会停在旧高亮上。
- `setPlayMode()` 末尾补了 `paint(true)`：切换模式后跟随策略立刻按新模式生效。

### 收听模式拆成两组独立设置（同日追加）

原来一个 `LISTEN_MODES` 把「外观」和「续播」塞进四个互斥值（`immersive` / `continuous` /
`radio` / `car`），于是**选驾驶就等于关掉连续播放**，选电台就不能用驾驶界面，而且 `immersive`
那一档没有任何视觉差异——四个值里只有一个真改布局。现在拆开：

- `LISTEN_APPEARANCE` = `default` / `car`，只切 `body.car-mode`（正文显隐、按钮尺寸）。
  存 `myt-appearance`。
- `LISTEN_CONTINUE` = `single` / `continuous` / `radio`，只决定 `ended` 之后怎么走。
  存 `myt-continue`。两组合法组合都能成立（例如「驾驶界面 + 节目电台」）。
- **迁移**：旧 `myt-play-mode` 读一次，`car` → 驾驶界面、`continuous`/`radio` → 续播，
  然后删掉这个键；旧的 `prefs.autoNext` 只作为 `single`/`continuous` 的兜底。
- **去重真值来源**：设置页那个「自动连续播放」开关不再是独立状态，它现在就是
  「播完之后 ≠ 播完即停」的快捷开关（`syncAutoNextSwitch()`），点它等于切
  `continuous`/`single`，两处永远一致，不会出现「开关开着但续播设置是播完即停」。
- 页面拆成「界面」与「播完之后」两组卡片（`#listenAppearance` / `#listenContinue`），
  选中态用 `role=radio` + `aria-checked`；点击委托从 `[data-mode]` 改成
  `[data-appearance]` / `[data-continue]`，不再和底栏「逐词/逐句」（那个也用 `data-mode`）
  抢同一个 CSS 选择器。

### 桌面壳：识别模型管理（2026-11-18）

原来原生识别只有一个写死的模型（英文 20M，`%ProgramData%\MyTranscript\sherpa-en-20M`，
文件名带 epoch），想换模型只能改代码重编。现在拆成「清单 + 目录 + 选用」三件事：

- **目录**：`%ProgramData%\MyTranscript\models\<id>\`，每个模型一个 ASCII 目录，
  文件名一律规范化成 `encoder.onnx` / `decoder.onnx` / `joiner.onnx` / `tokens.txt`，
  再加一个 `model.json` 记录 `{id,name,type,files}`。`asr.rs` 的 `ModelSpec::load()`
  先读 `model.json`，没有就按老的 epoch 名兜底——所以老用户不用重下。
- **内置清单**（`main.rs` 的 `MODELS`）：英文迷你 41 MB（en-20M int8）、英文标准 69 MB
  （zipformer-en-2023 int8 left-128）、英文大 253 MB（同仓库 fp32）、中英双语 189 MB
  （bilingual zh-en int8）。远端文件名与仓库都在清单里，HF 连不上自动退 `hf-mirror.com`，
  下载用 `http_long()`（1800 s）并按块写文件、边下边 `emit("myt://asr-model", {pct})`。
- **命令**：`asr_models` 列安装状态与体积（含手工导入的目录）、`asr_prepare(model)` 缺哪个
  下哪个、`asr_remove(model)` 删目录、`asr_import(path)` 把本地文件夹复制成新模型。
  选择状态只存在页面（`prefs.asrModel`，默认 `en-mini`），壳里不存第二份。
- **导入**：任意目录（中文路径也行）只要是 sherpa-onnx 结构就复制进 ASCII 模型目录，
  自动挑 `encoder*/decoder*/joiner*.onnx`（同槽位优先 int8）+ `tokens.txt`；
  有 joiner 记 transducer，没有记 paraformer（`Asr::new` 按 `type` 分别填
  `transducer` / `paraformer` 结构）。
- **删除保护**：正在使用的模型按钮直接禁用；前端再拦一次，删之前要 confirm。
  是否「使用中」由页面判断，壳只校验 id 合法（防目录穿越）。
- **设置页**：`设置 → 文字稿与字幕 → 实时识别模型`，列出每档的说明/体积/安装状态，
  可「使用 / 下载并使用 / 删除」；「导入模型」走 `tauri-plugin-dialog` 的目录选择
  （capabilities 加 `dialog:allow-open`）。切换后提示「下次开启实时识别生效」——
  已开着的识别会话不会中途换模型。
**补强（同日追加）**：下载改成可中断/可续传——`.part` 留着，下次带 `Range` 从断点接着下；
设置页每行有「取消」（`asr_cancel`，保留断点），下载中显示百分比与体积，非安装态若已有断点
显示「已下载 X MB，可续传」并把按钮改成「继续下载」。下载加了两个上限：响应头 60 秒、
每个分块 180 秒，镜像卡住会失败退出而不是把界面吊在「下载中」。另外每一行加了「目录」
按钮（`explorer` 打开模型目录），`asr_models` 现在跑在阻塞线程池里（首次搬 41 MB 老模型不再
卡主线程），并额外返回 `part` 字节数。
## 桌面壳：自动翻译（2026-11-18）

设置 → 文字稿与字幕里新增「自动翻译」。翻译请求由 Rust 代发（`tr_translate`，`src/translate.rs`），
避开浏览器 CORS；引擎、地址、Key、模型、目标语言全部由前端 `myt-translate` 配置传入，壳不落盘。

- 引擎：`mymemory`（默认，免费无需 Key，国内可直连）、`google`（网页接口，海外网络）、
  `openai`（兼容 Chat Completions，批量 JSON 数组）、`deepl`（按 Key 后缀自动选 free/pro）、
  `libre`（自建或公共实例）。
- 范围：原文字稿里播放头附近缺中文的句子按需翻译并写回 `cue.zh`；实时识别的行在文字稳定
  0.7 秒后翻译，作为该行下面的 `.zh.live-zh` 显示。译文缓存在内存 `TR_CACHE`，按原文去重。
- 开启时如果正文只显示英文，会自动切到「双语」，否则译完也看不见。
- 目标语言：zh-CN / zh-TW / en / ja。
## 桌面壳：订阅自动化与单集管理（2026-11-18，P0）

新增本机状态键：`myt-auto`（刷新/下载/清理/通知配置）、`myt-favorites`（单集收藏 key 列表）、
`myt-played`（已听时间表）、`myt-inbox`（新单集收件箱）、`myt-seen`（每档已见过的单集 id）、
`myt-showprefs`（每档播客偏好，P1 用）。键格式统一为 `showSlug:episodeId`。

- 定时刷新：`auto.refreshHours` 为 0 时关闭；开启后每 5 分钟检查一次，到期才真正刷新。
  首次刷新只建立 `seen` 基线，不把全部历史集塞进收件箱。
- 新单集：写入收件箱，按 `auto.notify` 发系统通知（Rust `notify` 命令，走
  `tauri-plugin-notification`，不依赖 WebView 的 Notification 权限）。
- 自动下载：`autoDownload` + `downloadCount`，只下未听、未离线、未在下载中的新集。
- 自动清理：`deletePlayed` / `deleteNotInQueue` / `keepFavorites` / `capMB`；
  永远跳过正在播放的单集，收藏保护优先。
- 播放结束：`markCurrentPlayed()` 写入已听表；`deletePlayed` 打开时延迟触发一次清理。
- 节目页支持筛选：全部 / 未听 / 已听 / 收藏 / 离线；单集行显示收藏、已听、离线徽章。
- 媒体键：Windows 下 `RegisterHotKey` 注册播放/暂停、上一集、下一集，经 `myt://media` 交给前端；
  注册失败就静默跳过，不影响托盘菜单。

## 桌面壳：P1 播客管理与 P2 年回顾/本地文件（2026-11-18）

P1：
- 节目页新增「这档节目的设置」：播放速度、跳过开头/结尾秒数、自动下载、新集通知；
  存 `myt-showprefs`，进入该档时覆盖全局速度与跳过规则。
- `applySkipRules()` 在 `timeupdate` 执行：开头只跳一次；结尾按 `app.cont` 自动下一集或暂停；
  广告跳过是实验项，默认关闭，只按文字稿 cue 里的赞助/广告关键词合并区间。
- 队列顺序 `prefs.queueOrder = sequential | unplayed | shuffle`，同时作用于自动续播和
  播放队列取集；`nextTarget()` 是唯一选择入口。
- 音量上限 `prefs.volumeCap` 把输出压到 100/90/80/70%，不改变单集响度曲线。
- 「统计」页按 `readAllProgress()` 汇总累计小时、听过/听完集数、节目排行和最近 7 天。

P2：
- 「年度回顾」按记录里的 `at` 年份筛选，展示年度小时、听完数、最忙月份、Top 5 节目和
  每月条形；不跨设备合并。
- 本地文件夹：Rust `local_scan(path)` 递归最多 3 层、最多 500 个音频，扩展名
  mp3/m4a/aac/ogg/opus/wav/flac/wma/mp4/m4v/webm/mov/mkv；前端存 `myt-local`，以 `local-files` 这个虚拟节目
  出现在节目页和「本地文件」页。播放走 asset 协议，`tauri.conf.json` 的 asset scope 已放宽到
  `**`。清空列表只删记录，不删磁盘文件。
- 跨设备同步：设置 → 数据 → 「从文件同步」导入另一台设备导出的 JSON，按 key 合并订阅、
  队列、书签、笔记、收藏、已听、收件箱、自动化与节目偏好；进度按 `at` 取新。
- 本地视频：扫描结果按扩展名标记 `kind=video`，点条目进入「视频播放」页，用 `<video controls>` 直接播放；
  本地视频不做文字稿/逐词高亮。

## 学习侧七项扩展（2026-11-19）

前端全部在 `site/player.js` 末尾的**主 IIFE 内部**（再接一段 `(() => { ... })()`，仍挂
`window.__xai`），通过包装 `studyRenderEpisode` / `studyEpisodeHTML` / `studyRenderPractice` /
`studyRenderVocab` 注入，不改 1.2 万行主脚本的既有分支。主脚本只在 `lookupWord` 成功/失败
两处调用 `window.__xai.attachWord`。

**坑（2026-11-19 踩过）**：这段模块曾经放在 `</script>` 之后的第二个 `<script>` 里，看起来能跑，
实际全部失效——主脚本是 `(() => { ... })()`，`state`、`studyCache`、`studyView` 与那批
`studyRender*` 都是 IIFE 私有绑定，外层脚本既读不到也改不动；`studyRenderPractice = function…`
只是在 window 上新建了同名全局，面板永远只显示旧 UI（缓存徽标、前情回顾、跨集时间线、
多空/盲听按钮全部没出现）。模块必须写在主 IIFE 里才能包装成功。以后再加同类扩展，
先确认代码在同一个 IIFE 作用域内。

### 预生成资产 `<stem>.ai.json`（data 分支）

- 位置：与单集 JSON 同目录，按 `<transcript-url>` 把 `.json` 换成 `.ai.json`；
  另有一条 `feed` 同级 `ai/<stem>.ai.json` 作为回退。
- 结构：`{ version: 3, prompt: "ads-v1", model, generatedAt, data: { summary, topics, ads,
  keyPoints, vocabulary, hardSentences, questions } }`。`data` 里的字段与 `studyCache`
  的 `ep:<id>` 形状一致，前端命中即直接灌入 `studyCache` 并标 `source: "disk"`。
- 生成：`scripts/ai_pregen.py`，从 `feed.xml` 的 `<podcast:transcript>` 枚举全部单集，
  按 3 块切分调用 Gemini，`merge_parts` 去重、按时间排序、按上限截断。
  密钥走 `scripts/gemini_keys.py`，`--dry-run` 只打印不调用。
- 未命中时前端照旧现算，并在整集页顶部显示「缓存未命中」。

### 质检脚本 `scripts/qa_terms.py`

纯离线，扫 `data/<slug>` 或 `feed.xml` 指向的 JSON，按「内部大小写异常 / 含数字 /
短全大写 / 低频专名 / 同集近形变体」几类启发式挑可疑专名，输出 `build/qa/<slug>.md`。
只收专名：小写常用词、句首大写、月份/星期一律不判。`--llm-top N` 可让模型复核前 N 条。

### 前端新增的 localStorage 键

- `myt-word-ai`：AI 查词结果（按小写词缓存）。
- `myt-ai-recap`：前情回顾（按 `ep:<id>` 缓存）。
- 学习计划、Anki 导出都从既有 `myt-study-vocab` 读，不另存。

## cue 级跳过（2026-11-19，P0）

在原有「关键词 + AI 整段区间」之上加了一层逐句标签，但**只在本机音频 + 本机文字稿的单集生效**：

- 数据：`data/<slug>/<stem>.skip.json`（或 `feed` 同级 `skip/<stem>.skip.json`），结构
  `{version, prompt:"skip-v1", model, audio_seconds, cue_count, segments[], ranges[], stats}`；
  `segments` 只列非 `content` 的句子，按 `start` 秒锚定，`i` 只是快路径。
- 生成：`scripts/ai_skip.py`（Gemini，密钥走 `gemini_keys.py`）；`--heuristic` 是纯正则基线，
  `--repost` 在规则修正后按已有标签重算区间，`--dry-run` 只打印切块。
- 标签：`ad`（赞助/广告/优惠码）、`promo`（订阅/周边/巡演/求评价/个人作品）、`filler`（寒暄/跑题/节目事务）。
- 规则层：广告壳配对（"And now, commercials" ↔ "End of commercials"、"a word from our sponsor" ↔
  "back to the show"）不依赖模型；壳区间带 `rule:"shell"`，合并时优先级最高，置信度 0.95。
- 门控（`skipEligible()`）：桌面壳 + 音频为 `asset:` 本地文件 + 文字稿 `local === true`。
- 存储：`<key>.skip.json` 与 `<key>.transcript.json` 同目录（Rust `offline_save_skip` /
  `offline_skip_load`，`offline_list` 增 `hasSkip/skipSize`，删除时一起删）。
- 播放：`buildSkipPlan()` 建 `state.skipPlan`（tags + ranges + limited）；`applySkipRules()`
  按 `prefs.skipLevel`（1/2/3）取标签。四条保护：单段 ≤120 s、单集 ≤40%、
  进入区间 >0.5 s 不跳（视为手动拖入）、已跳区间按 `id` 去重（`state.skipDone` / `skipMuted`）。
- 设置：`prefs.skipAds` 仍是总开关（默认关），`prefs.skipLevel` 默认 2；设置页「跳过级别」下拉。
- 实测样本（2026-11-19，3 集）：模型可跳 2.1%–6.3%，正则基线 0.2%–1.0%；
  动态插播广告不在转写里，所以收益主要来自 baked-in 推广与寒暄。
- 未验证：Rust 未出安装包、真机链路未实测；`ai_skip.py` 尚未接 workflow 与全库回填。

## 桌面壳：全局字幕（2026-11-19）

只服务"本机离线转写"的实时字幕，不改动数据格式。代码在
`apps/windows/src-tauri/src/{wasapi.rs,captions.rs,asr.rs,punct.rs,main.rs}` 与
`site/{overlay,picker,wordcard}.html`。

- 采集：设备级 WASAPI loopback（默认设备，2 秒巡检重连）；进程级
  `ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK)`，按进程树抓，
  托盘"选择应用…"用 `IAudioSessionManager2` 枚举出声会话。**激活参数必须 `Box::leak`
  活到会话结束**，否则 `open_process` 返回即 0xC0000374。
- 识别：sherpa 流式 `en-mini`，关端点、16k 单声道；首词约 1.4 秒丢字是已知代价。
- 后处理链：词流 → 停顿断句（>0.8 s 补句号）→ 离线标点模型
  `sherpa-onnx-online-punct-en-2024-08-06`（int8 7.5 MB，
  `C:\ProgramData\MyTranscript\models\punct-en\`，缺失则只走停顿规则）
  → `terms.txt`（`错写 => 正写`）→ 句首大写/术语保形 → 每句一行。
- 查词：字幕逐词 span，点词走 `dictionaryapi.dev`；词卡 `wordcard.html`（620×260）；
  收藏写 `%APPDATA%\com.myt.transcript.desktop\vocab.json`，可托盘导出 CSV（UTF-8 BOM）。
- 中文字幕：英文整句稳定后调 `captions_translate`（MyMemory，只发该句），第二行显示。
- 热词：sherpa 对词表外 token 直接报错（`Cannot find ID for token`），**解码器级热词不可用**，
  已改为识别后纠错。
- 界面坑：WebView 会缓存 `overlay/wordcard/picker`，打开时必须带 `v=<unix>`；
  本机 CSS 视口与窗口物理尺寸不成比例，右对齐会被裁，词卡因此定宽 360、窗口 620×260。

## 桌面壳：本地无稿音频预转写（2026-11-20）

给"本地文件"里的音频补文字稿，不动站点数据格式。

- 解码：symphonia（mp3 / aac+m4a / wav / flac / ogg），按原采样率喂 sherpa，
  重采样交给 sherpa；单声道由壳里求平均。没有引入 ffmpeg。
- 识别：复用 `en-mini` 流式模型（`Asr::feed`/`result`），边解码边 decode，
  长文件内存只增特征不增 PCM。
- 词边界：sherpa 的 token 有两类边界——`▁` 前缀和独立的 `" "` token；
  后者会被当成空串跳过，必须用 `pending_boundary` 接力，否则会粘成 `Thequick`。
- 产物：`<音频路径>.transcript.json`，格式
  `{audio_seconds,complete,native,source:"local-asr",segments:[{start,end,text,words:[[w,startMs,durMs]]}]}`，
  播放页 `cuesFromJson` 直接吃。
- 命令：`local_transcribe_start(path)`（立即返回）、`local_transcribe_status()`、
  `local_transcribe_stop()`、`local_transcript_load(path)`；进度事件 `myt://localasr`，
  页面同时按 1.2 s 轮询兜底。一次只允许一个任务。
- 播放页：本地单集没有稿时显示"整集预转写"入口；转完自动 `applyEpisodeData`，
  并把 `transcript={url:'local-asr'}` 写回 `myt-local`，下次直接读盘。
- 顺手修的旧 bug：`loadShow` 对 `show.local` 直接走 `episodesOf`，不再因为
  `feed` 为空显示"没有已发布的增强 Feed"（此前本地文件从列表点进去打不开）。
- 未做：多任务并行、断点续转、中文标点模型、转写期间的取消按钮。
- 速度：必须"按 0.5 s 喂一次 + 每次 drain 到没有可解帧"。一次性灌完整集会让
  sherpa 特征队列只留开头，10 分钟音频也只出 10 秒。整集转写线程数取
  `available_parallelism`（上限 8），实测 22 分钟音频 **44 秒**（约 30× 实时）。




## 桌面壳：模型管理设置（2026-11-20）

把"识别模型"从实时字幕的附属项提升成独立设置页，并让整集预转写共用同一档模型。

- 设置页新增"模型管理"栏：四档模型（迷你 41 MB / 标准 69 MB / 大 253 MB / 中英 189 MB）、
  已装大小、下载/续传/取消、切换、打开目录、删除、导入本地 sherpa 目录，都在这里。
  "文字稿与字幕"里只留一个入口按钮，不再重复一份列表（避免两个 `#asrModelList`）。
- 整集预转写：`local_transcribe_start(path, model)` 新增可选 `model`，页面传
  `prefs.asrModel`；未安装的模型直接报错并提示去模型管理，不再偷偷用默认档。
  产物 JSON 多写一个 `model` 字段，播放页完成提示会带上模型名，方便回溯是哪档跑出来的。
- 修了目录里的一个真 bug：`en-large` 之前和 `en-standard` 指向同一组 int8 文件，
  所谓"大模型"下来其实是 69 MB 的同一份。已改成 fp32
  `encoder-epoch-99-avg-1-chunk-16-left-128.onnx`（实为 250 MB），才算真的更高精度。
- 实测（同一集 SmartLess，39:55，2392 s 有效音频）：
  - 迷你：**182.6 s**（13.1× 实时），200 段 / 6715 词，64 MB 内存；
  - 标准：**270.8 s**（8.8× 实时），201 段 / 6708 词；
  - 90 秒真实切片：迷你 9 s，标准 15 s（都含加载模型）。
- 质量结论：标准档能把 `pot castead` 修成 `pod caste`、`pod castical` 修成 `podcast`，
  但 `Jason Bateman`→`jason bamen`、`Sean Hayes`→`shone haze` 依旧错。
  流式 zipformer 的英文档对人名/品牌就是弱项，换更大档只能改善一部分；
  要真正解决，得把 `terms.txt` 式纠错接进 `localasr`（目前只作用于实时字幕）。
- 验收：设置页切"标准"→ localStorage `asrModel` 变 `en-standard`，提示"整集预转写会用这一档"；
  本地 90 秒条目点"整集预转写"跑完自动出 8 段字幕，JSON 里 `model:"en-standard"`。

## 桌面壳：单句精听（2026-11-20）

听不清某一句时，不用重跑整集：把这一句单独切片重转。

- 后端 `localasr::transcribe_clip(audio, start_s, end_s, model_dir)`：
  symphonia 先退 0.6 s 做解码预热，再按 packet 时间戳把 `[start, end]` 之外的样本切掉；
  只喂这段 PCM 给 sherpa，产出仍是标准 `segments`，时间戳已加回绝对偏移，
  附带 `model` 与 `clip{start_ms,end_ms}`。单次上限 90 秒。
- 命令 `local_clip_transcribe(path, start_ms, end_ms, model)` 同步等结果；
  模型未安装直接报错，指向设置 → 模型管理。
- 播放页：所有音频的每一句 hover 时出现「精听」小按钮，点击后在该句下面插入结果卡：
  模型名 + 耗时 + 文本，附「复制 / 再来一次 / 关闭」。切片前后各留 1.2 s / 1.0 s 上下文，
  所以结果里可能带半句邻居的话，这是故意的，方便判断连读。
- 三种音频来源：
  - 本地文件：直接用 `localPath` 切片；
  - 已离线下载：用 `app.offline` 里的 `path`，不重复下载；
  - 在线流：优先 `remote_clip_transcribe(url,key,start_ms,end_ms,model)` 只取这一句附近的字节：
    先 `Range: bytes=0-131071` 拿头部，解析 ID3 长度与首个 MPEG 帧，按码率换算时间→字节偏移，
    往前多取 2.5 s、向后多取 5 s（约 300–400 KB），Range 拉回后裁掉同步字前的杂字节，
    再 `transcribe_clip(frag, 0, 片段时长)`。同一句再次点会复用 `clips/<key>-<start>.mp3`。
  - Range 不可用（服务器忽略 Range）、非 MP3（m4a/AAC 等）、或头部带 `Xing/Info`（VBR，
    首帧码率线性推算会漂）时，回退 `clip_audio_cache` 整集下载，卡片显示「正在缓存整集音频 X%…」。
- 缓存目录单独放 `C:\ProgramData\MyTranscript\cache\audio\`（片段在其下 `clips/`），
  **不能放进 offline 目录**：离线列表是扫目录的，混进去会在用户列表里冒出一条没有标题的假离线。
- 踩坑：**不要复用 sherpa stream**。试过缓存引擎 + `reset()`，第二次精听的开头会混进
  上一段的话（实测第二次结果以 `Puzzle now the one half dozen...` 开头）。
  改为每次新建 `Asr`，多花 2–3 秒加载，但两次调用结果完全一致。
- 实测（40 分钟 SmartLess 单集，118.4→129.8 s 这段，标准档）：
  **6.8–7.5 秒/次**，两次输出逐字相同；结果里 "Jason Bateman" 被听成 "jason bayman"，
  仍受模型上限，但足够判断原句在说什么。
- 实测（在线单集，60,657,685 B、128 kbps CBR）：`300→320 s` 用 Range 只落 **345 KB**、
  **12.9 秒**返回（其中 6–7 秒是 ASR），与整集下载后本地切同段对照，正文一致；
  首次不再需要 20 秒级整集下载、也不占 57 MB 磁盘。整集缓存仅在兜底路径出现。
- 播客官方稿的时间轴可能和实际音频有前导偏差，0:00 那句可能落在片头音乐上，
  精听结果自然不对；以播放器里的偏移校准为准。
- **没有文字稿也能精听**：播放器右上角固定一个「◉ 精听刚才」按钮，不依赖 cue。
  按当前 `audio.currentTime` 取最近 15 秒（播放中向后多留 1 秒、暂停时只留 0.4 秒），
  走同一套 `clipRun(start,end,panel)`；结果落在底栏上方的浮动卡里，带复制 / 再来一次。
  本地、离线、在线三种来源与单句精听共用同一条后端路径。
- 实测（无文字稿的本地 mp3，播到 12 秒点按钮）：**3.2 秒**返回，
  卡片显示「精听刚才 · 最近 15 秒 · 英文 · 迷你」，正文可直接读。

## 桌面壳：下载管理页（2026-11-20）

侧栏新增「下载管理」（`#/downloads`），把 `offline_list` 的平铺列表按**节目名分组**：

- 每个节目一张分组头：封面、节目名、集数、占用空间；下面列单集标题、大小、
  是否带文字稿，操作有「▶ 播放 / ＋ 字幕 / ✕ 删除」。
- 页面顶部显示总集数、节目数和总占用；带搜索框，可按节目名或单集标题过滤。
- 分组靠 `offlineKey` 前缀匹配已知 show slug；下载时另把
  `{showName, artwork, epTitle}` 记进 `localStorage['myt-download-meta']`，
  这样节目列表没加载、或订阅已移除时也能正确归类、显示标题。该表只保留最近 500 条。
- 删除走 `removeOffline`（音频 + 字幕 + 跳过标签一起删），删完当前页立即刷新。
- 实测：下载一集 69 MB 后页面显示「1 集 · 1 个节目 · 共 69 MB」，
  分组头为节目名，行内标题、大小、文字稿大小都正确；删除后回到空状态。

## 桌面壳：自定义主题（2026-11-20）

设置 → 外观与主题底部新增「自定义主题」，用 CSS / HTML 在现有九套主题之上做覆盖：

- 配置存 `localStorage['myt-theme-custom']`：`{css, html, enabled, updatedAt}`。
- CSS 写进 head 末尾的 `<style id="ctStyle">`，所以能覆盖任意主题变量和选择器；
  `:root{--accent:…;--bg:…}` 就会全站生效。停用只把 `enabled` 置 false，内容保留，改坏了能一键恢复。
- HTML 是静态区块，插到首页顶部 `#customHomeMount`，适合做横幅/公告；不是整页替换。
- HTML 经过 `sanitizeCustomHtml()`：移除 `script/iframe/object/embed/link/meta/base/form`
  和所有 `on*` 内联事件、`javascript:` 链接，再由模板写入，不执行脚本。
- 提供「插入模板 / 复制配置（JSON）/ 恢复默认」；导出的本机数据 JSON 里也带 `customTheme`。
- 启动时 `applyCustomTheme()` 在任何页面渲染前执行，刷新后仍然生效。
- 实测：`:root{--accent:#ff0055}` 应用后变量立刻变、刷新仍在；带 `onclick` 和 `<script>` 的
  HTML 落库后只剩 `<div class="my-banner">自定义横幅</div>`，两个脚本标记都没有执行；停用后变量回到主题值。

## 桌面壳：插件接口与字幕插件（2026-11-20）

插件运行时与现有页面并行；用户手册见 [plugins.md](plugins.md)。字幕功能已收编为一个内置插件 `subtitles`。

- 插件目录 `C:\ProgramData\MyTranscript\plugins\<id>\`：
  `plugin.json`（id/name/version/description/author/main/style/enabled）+ `main.js` + 可选 `style.css`。
  启用状态单独写 `plugins/enabled.json`，不改用户清单；`enabled` 只是首次默认。
- Rust 命令：`plugin_list`（扫描目录并把启用插件的 JS/CSS 源码一起返回）、
  `plugin_set_enabled`、`plugin_open_dir`、`plugin_example`（生成 hello-world 示例，已存在时不覆盖）。
- 前端启动时 `loadPlugins()` 在 `bindShell()` / `applyRoute()` 之前跑：注入 `<style data-plugin-css>`、
  用 `<script>` 执行 `main.js`（外层包 try/catch），再调 `MyTPlugins.start(id)`。
  插件用 `MyTPlugins.register(id,{setup(api)})` 注册；页面走 `api.page()`，
  路由 `#/plugin/<pluginId>/<pageId>`，侧栏单独一个「插件」分组（`#pluginNav`）。
- API：`toast / navigate / openEpisode / page / on / command / cues / player{state,play,pause,toggle,seek,seekBy,setRate} / subtitles / storage / el`。
  事件：`player:open/play/pause/ended/time`（time 约 1 秒一次）、`player:cue`、`route:change`。

### 内置 `subtitles` 插件

- 源码在 `apps/windows/builtin-plugins/subtitles/`，Rust 启动时铺到
  `C:\ProgramData\MyTranscript\plugins\subtitles\`；已存在的文件不覆盖。
- `main.js` 调用 `api.subtitles.claim()` 后才算接管。主程序 `subtitlePluginOn()`
  只看这个 claim 结果：没有插件时播放器不下载文字稿，`selectEpisode` / `renderCues` /
  `applyEpisodeData` 都直接返回，`body.subs-off` 隐藏阅读区、阅读栏、迷你字幕、壁纸、
  学习、精听、导出、分享、查找和字幕设置。
- 插件启用时现有字幕链路照常工作；插件页「字幕中心」提供句数/词数、双语切换、
  实时识别、精听刚才、导出和阅读设置入口。
- 全局字幕（overlay）在 Rust 侧也做门控：`start_captions_session` 先检查
  `subtitles_plugin_enabled()`，插件停用时 `captions_start` / 托盘入口直接报错。
- `plugin.json` 新增可选 `requires` 数组；前端 `PluginHost` 递归解析依赖，缺依赖的插件不注入 JS，
  设置页显示“需要先启用：……”。`study` 声明 `requires:["subtitles"]`。
- 插件 `plugin.json` 支持 `scripts` 数组：Rust 按顺序把脚本拼到入口 `main.js` 之前，
  因此字幕插件可以把内核拆到 `kernel.js`，入口只负责 claim 和页面。
- 当前分层：插件拥有字幕功能的装配、入口和生命周期；字幕数据内核
  （JSON/VTT 解析、词级对齐、句子切分、双语合并）在 `subtitles/kernel.js`，
  视图内核（句块 DOM、窗口渲染、双语列对齐）在 `subtitles/view.js`，两者合并后
  通过 `api.host.registerKernel('transcript', …)` 注册。主程序只保留
  `cuesFromJson / parseVttSmart / parseZhVTT / vttFromSidecar / mergeCues / renderCues`
  桥接，并把 `state / box / reader` 作为适配器交给插件。
  实时 ASR、全局字幕采集仍是宿主服务，后续继续迁移。
- 实测：插件启用时打开 how-we-made-your-mother 单集，240 句正常显示；插件页显示
  「908 句 · 9555 个词级时间点」，双语按钮切换后 239 条中文行出现；停用并刷新后
  `body` 变 `subs-off`，`#transcript` 句数为 0，阅读区/阅读栏/字幕工具全部隐藏，
  音频和集标题仍在；重新启用刷新后恢复 240 句。

### 内置 `study` 插件

- 源码 `apps/windows/builtin-plugins/study/`，第一次启动铺到
  `C:\ProgramData\MyTranscript\plugins\study\`，已有文件不覆盖；默认启用。
- 插件调用 `api.study.claim()`；`studyPluginOn()` 同时要求 `subtitles` 已 claim，
  因为学习卡、整集总结、词卡都依赖 cue。
- 停用后 `body.study-off` 隐藏 `#studyBtn`、`#studySheet`、`#wordPanel`、
  单集页 `[data-ai-episode]`、设置里的 AI 学英语页和模块开关；`openStudySheet` /
  `studyOpenEpisodeSummary` / `studyApplyWordMarks` / `lookupWord` 全部提前返回。
- 「学习中心」页显示生词本、今日到期、缓存和 AI 服务状态，并提供当前句卡、整集总结、
  复习、生词本和设置入口。
- 实测：默认两插件同时启用时，字幕插件页显示字幕正常；停用 `study` 并刷新后
  字幕仍有 240 句，`#studyBtn` 与学习设置页隐藏，词卡不弹出；重新启用后恢复。



