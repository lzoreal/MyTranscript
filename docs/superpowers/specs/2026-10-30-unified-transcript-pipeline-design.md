# 统一转录链路设计（RSS → 双语词级 transcript）

日期：2026-10-30 状态：待评审
取代/合并：`2026-10-28-hwmym-word-timestamps-backfill-design.md`、`2026-10-29-scraped-shows-word-timestamps-design.md`
复用：`2026-10-30-bilingual-word-transcripts-design.md`（小句翻译契约与中文时间算法）

## 目标

一条链路：**原始 RSS → 双语词级 JSON**。加一个新播客 = 在 `feeds.json` 加一行。
现有的抓取（PodScripts）、自转录（hwmym）、翻译、对齐四条路径合并成一个管线，按节目逐步迁移（strangler）。

## 一、范围与约束

- 文本源可配置：`text_source: "podscripts" | "asr"`，两种走同一套下游。
- 产物分两处：双语词级 JSON 进 `data/<slug>/<stem>.json`（**只在 `word-transcripts` 分支，不部署**）；
  已迁移节目的 VTT / feed / index 仍由新链路的 `publish.py` 写到 `site/`，**地址与格式保持兼容**，
  否则 App 与订阅者会在迁移当天看到断更。
- 迁移期间新旧并存，**按节目切换**；切换动作有三步，缺一不可：
  ① `feeds.json` 新增该节目；② `podcasts.json` 移除该 slug（旧 crawl 不再碰它）；
  ③ 新链路的 `publish.py` 接管它的 VTT / feed / index。
- 全量约 5,000 集、单集约 1 小时（2 核）→ 约 250 小时墙钟（20 并发）。必须可分片、可断点、可随时停。

## 二、配置 `feeds.json`

```json
[
  {
    "slug": "how-we-made-your-mother",
    "name": "How We Made Your Mother",
    "feed_url": "https://rss.amperwave.net/v2/feed/audacynetwork/hwmym",
    "language": "en",
    "text_source": "asr"
  },
  {
    "slug": "office-ladies",
    "name": "Office Ladies",
    "feed_url": "https://rss.amperwave.net/v2/feed/audacynetwork/officeladies",
    "language": "en",
    "text_source": "podscripts",
    "podscripts_id": 7
  }
]
```

- `text_source: podscripts` 时 `podscripts_id` 必填；缺失则该节目直接报配置错误，不静默降级。
- `enabled: false` 可临时停摆单个节目。

## 三、模块与接口

每个模块只做一件事，纯逻辑部分可单测、外部依赖注入：

| 模块 | 职责 | 关键接口 |
| --- | --- | --- |
| `feed.py` | 读 RSS，产出条目 | `list_episodes(feed_url) -> list[Episode]`（`guid/title/published/audio_url`） |
| `audio.py` | 下载音频（中国代理竞速） | `download(url, path) -> dict`（复用现有实现） |
| `asr.py` | Whisper turbo 转写 + 词时间 | `transcribe(path) -> tuple[list[Sentence], float]` |
| `text.py` | 取展示文本 | `fetch_text(episode, show) -> list[str]`（podscripts 抓取 / ASR 句子） |
| `align.py` | 文本 ↔ 词流映射 | `map_text(our_sentences, text_blocks) -> list[Sentence]`（含弃句/广告判定） |
| `translate.py` | 小句级翻译 | `translate(sentences) -> None`（写回 `zh`/`clauses`/`coarse`） |
| `zh_time.py` | 中文词时间 | `attach_zh_words(sentence) -> list[list]`（clauses 优先，兜底 DTW） |
| `store.py` | 读写产物与断点 | `load_state(slug)`、`save_episode(slug, sentence_doc)` |
| `publish.py` | 生成 feed/索引（HTTP 地址不变） | `publish(show, episodes)` |

`Sentence` 是唯一贯穿全程的数据结构：

```python
{"start": float, "end": float, "en": str, "zh": str, "coarse": bool,
 "words": [{"w","s","e"}], "zh_words": [[w, ms, dur]]}
```

## 四、每集的处理顺序

```
list_episodes → （已完成的 guid 跳过）
  → download → asr（所有节目都做；词时间只能来自这里）
  → text：podscripts 抓取，或直接用 ASR 句子
  → align.map_text：把展示文本贴到 ASR 词流上（podscripts 源）；
                   ASR 源直接采用 ASR 句子
  → translate：小句级翻译（en 拼接校验、单句重试 2 次、失败降级 coarse）
  → zh_time：clauses → 小句分配 → 句内按字；失败/coarse → DTW 兜底；再失败 → zh_words=[]
  → store：写 JSON + 更新该节目的 state
```

**断点**：`data/<slug>/state.json` 记录 `{guid: {"status": "done|coarse|failed", "attempts": n, "updated_at"}}`；
`status=done` 跳过，`attempts >= 2` 不再重试。状态与产物同分支同目录，保证一次提交原子。

## 五、分支与部署

| 项 | 决定 |
| --- | --- |
| 产物分支 | 新分支 `word-transcripts`（不是 Pages 源） |
| Pages | **本阶段不部署**；`deploy.yml` 仍只跟随 `main` |
| 读写方式 | job 开始时 `git worktree add ../data-branch word-transcripts`，管线通过 `DATA_DIR` 读写它；
跑完在同一 worktree 里 `git add data/<本分片的节目>` 并 `git_push_retry.sh` 推送 |
| 忽略规则 | `data/` **不得加入 `.gitignore`**（它是产物）；worktree 放在仓库外，不污染主工作树 |
| 体积 | 仓库当前 233 MB；JSON 为文本，git 压缩后可接受。**分批提交、不重写历史**；若接近 1 GB，改"只保留最近 N 集 + 旧集归档到 release 资产" |
| 后期 | 迁移完成后另议：Pages 放最近 N 集、历史放 CDN/另仓，或拆分站点 |

## 六、CI

新增 `.github/workflows/transcripts.yml`：

- 触发：`workflow_dispatch`（`shard`/`shards`/`max_minutes`/`only_slug`）+ 每日 cron 增量。
- 矩阵：与现有 backfill 相同的字面量分片 + 预算；shard 归属按 `sha1(slug + guid) % shards`。
- 依赖：`requirements-transcribe.txt` + spaCy/`zh_core_web_sm` + MiniLM（沿用上一个计划的缓存步骤）。
- 模型缓存：`ct2-turbo-v1`（ASR）+ `zh-models-v1`（分词/嵌入）。
- 提交：只提交 `data/`，切分支后推送；不碰 `site/`、`state.json`、`progress.json`。

## 七、迁移清单（strangler）

| 步骤 | 动作 | 验收 |
| --- | --- | --- |
| 0 | 新链路先跑 hwmym（本来就是 ASR 源），产物只进 `word-transcripts` 分支 | 与现有 sidecar 抽样对比，词时间一致 |
| 1 | 每次迁一个抓取节目：`feeds.json` 加一行、`podcasts.json` 移除该 slug、新链路接管其 VTT/feed/index | 新产物与旧 VTT 文本抽样一致；feed 的条目数与 transcript 链接数不变 |
| 2 | 观察一周：该节目在旧链路上不再产生提交 | `git log` 确认 |
| 3 | 12 个节目全部迁完 | 旧 scraper/translate/align 三条路径删除 |
| 4 | 决定托管后，再改 `publish.py` 与 `deploy.yml` | — |

迁移期间**同一节目只能有一个产出方**，否则会出现两套字幕互相覆盖。

## 八、风险

| 风险 | 处理 |
| --- | --- |
| 全量算力 ~250 小时墙钟 | 分片 + 预算 + 断点；先跑 10 集看 RTF 再估轮数 |
| 分支仓库体积接近 1 GB | 分批提交、不重写历史；预留"最近 N 集"策略 |
| ASR 源文本质量（专名） | 与 PodScripts 相似度 0.961；专名错误可接受，后续可用术语表校正 |
| 迁移期双写 | 严格按"一次一个节目、先移除旧配置"执行 |
| Gemini 配额 | 已有 key 轮换；每集约 15 次请求 × 5,000 集，需按轮次摊开 |

## 九、验收

1. 新链路跑完 10 集：JSON 100% 有 `en/zh`，`zh_words` 非空率 ≥ 90%，coarse < 10%；
2. 与现有 VTT 抽样比对：文本差异只出现在解码/标点层面；
3. 断点有效：中断后重跑只补未完成的集；
4. 分支不触发 Pages 部署。
