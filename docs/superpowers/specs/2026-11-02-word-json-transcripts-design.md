# 词级 JSON 字幕与单 Feed 改造 — 设计

**日期**：2026-11-02
**状态**：已实施（2026-11-02）；JSON 改为仓库 `json/` + raw.githubusercontent 提供
**范围**：已迁移的 618 集（office-ladies 497 + how-we-made-your-mother 121）；其余节目不动。

> 2026-11-03：smartless（382 集）复用本方案迁移。publish job 自动遍历 `feeds.json` 里
> `publish: true` 的节目，无需改代码；分批回填期间未产出 JSON 的集必须继续用 VTT
> （`merged_processed` 按文件存在与否回退），否则 feed 会整批删条目。

## 1. 目标

1. 已迁移节目的 transcript 从句级 VTT 换成一个**双语词级 JSON**（放仓库 `json/`，
   由 raw.githubusercontent 提供）；
2. `podcast:transcript` 指向该 JSON（`type="application/json"`）；
3. 已迁移节目只保留一个 Feed（`feed.xml`），下线 `feed-zh.xml`；
4. 旧的句级 VTT 不重写、不丢弃，移到 `data/<slug>/legacy-vtt/` 归档；
5. 生成动作由现有的 feed/publish job 完成，不引入新的常驻 job。

## 2. 产物格式

### 2.1 路径

`json/<slug>/<stem>.json`，`<stem>` 沿用现有 VTT 文件名（来自 `progress.json` 的
`vtt_filename`），因此 feed URL 由 `.vtt` 变为 `.json`，文件名其余部分不变。

JSON **不进 Pages**（实测 386 MB，会把站点推过 1 GB 上限），改由仓库直接提供：
`https://raw.githubusercontent.com/lzoreal/MyTranscript/main/json/<slug>/<stem>.json`。
Pages 站点只保留 feed/index 与其余 11 个节目的 VTT。

**每集一个双语文件**，英文 feed 与原来的中文 feed 都指向它；不再生成 `transcripts/zh/`。

### 2.2 结构（Podcasting 2.0 官方字段 + AntennaPod fork 扩展）

官方示例（podcasting2.org `examples/transcripts`）定义的是
`{version, segments:[{speaker, startTime, endTime, body}]}`，时间为**秒**，
没有 `words` 字段。这里采用它的字段作为标准核心，并额外写一组同义的扩展字段，
供本仓库的 AntennaPod fork 走词级分支：

```json
{
  "version": "1.0.0",
  "audio_seconds": 4469.24,
  "segments": [
    {
      "startTime": 3.92,
      "endTime": 4.76,
      "body": "I'm Jenna Fisher.\n我是珍娜·费舍尔。",
      "start": 3920,
      "end": 4760,
      "text": "I'm Jenna Fisher.\n我是珍娜·费舍尔。",
      "words": [["I'm", 3920, 360], ["Jenna", 4280, 180], ["Fisher.", 4460, 300]]
    }
  ]
}
```

- 标准核心：`version="1.0.0"`、`segments[]`、`startTime/endTime`（秒，3 位小数）、
  `body`（英文句 + `\n` + 中文句）；`speaker` 无数据时省略；
- fork 扩展：`start/end`（整数毫秒）、`text`（与 `body` 相同）、
  `words`（`[词, 起始ms, 时长ms]`，**只放英文词**）；
- 中英词不能混进同一个 `words`：fork 解析器要求起始时间递增，中文词起点早于句尾英文词
  会被整段丢弃；中文仍作为 `body` 第二行显示；
- 缺失 `words`（纯标点句）时写空数组。

体积：618 集实测 **386.3 MB**（内部完整格式 560 MB），单独放仓库的 `json/`；
归档 VTT 后 Pages 站点约 653 MB，仍低于 1 GB 上限。

## 3. Feed

### 3.1 标签

已迁移节目的每集：

```xml
<podcast:transcript url="https://raw.githubusercontent.com/lzoreal/MyTranscript/main/json/<slug>/<stem>.json"
                    type="application/json" rel="captions" language="…"/>
```

- `language`：office-ladies 为 `en`（节目语言），hwmym 保持 `zh-CN`；
- 未迁移节目继续使用 `type="text/vtt"`，URL 不变。

### 3.2 单 Feed

- office-ladies：只生成 `site/office-ladies/feed.xml`；删除 `feed-zh.xml`，publish 不再调用
  `generate_zh_feed.process_podcast`；
- hwmym：只保留 `site/how-we-made-your-mother/feed.xml`；删除 `feed-zh.xml`，
  并把 hwmym 从 `podcasts_translate.json` 移除（Translate job 不再写它的字幕与 zh feed）；
- 其它 11 个节目：`feed.xml` 与 `feed-zh.xml` 均保持现状。

## 4. 数据流与写权限

唯一数据源是 `data/<slug>/<guid>.json`（统一管线产物）。公开 JSON 一律由它导出，
不再从 VTT 反推。

| 节目 | 生产者 | 触发 |
| --- | --- | --- |
| office-ladies | `transcripts.yml` 的 publish job | 每次 workflow 运行 |
| how-we-made-your-mother | `transcribe.yml` 的 site/feed 步骤 | 每周 cron 或手动 dispatch |

导出后两处都用现有的 feed 生成器（`scraper.generate_podcast_feed` /
`transcribe.build_feed`）写标签，保证每集只有一个 transcript 标签。

### 4.1 模块

新增 `scripts/word_transcript.py`：

- `build(document) -> dict`：内部 JSON → 2.2 的紧凑结构；
- `dumps(document) -> str`：`ensure_ascii=False, separators=(",", ":")`；
- `export_show(data_dir, json_dir, slug, stems: dict[guid, stem]) -> int`：
  遍历 `data/<slug>/*.json`（跳过 `state*`），按调用方给的 stem 写
  `json/<slug>/<stem>.json`，返回写出数量；原子写，临时文件 `.tmp`。
  调用方负责决定 stem：publish 用 `progress.json` 的旧文件名，
  transcribe 用 state 里既有 VTT 路径的 stem；
- `public_url(slug, filename)`：生成 raw.githubusercontent 地址，feed 与
  progress/state 记录统一用它。

改造点：

- `scripts/pipeline_site.py`
  - `write_episode` → 由 `word_transcript` 写 `json/`，不落 site；
  - `publish_show` → 不再生成 zh feed；
  - `merged_processed` → 条目写 `transcript_filename` 与 `transcript_type="application/json"`；
- `scripts/scraper.py`
  - `generate_podcast_feed` → 优先用 `transcript_filename` / `transcript_type`，
    缺字段时回退 `vtt_filename` / `text/vtt`；
- `scripts/transcribe.py`
  - 新增导出步骤：对 `data/how-we-made-your-mother/` 的每一集写到 `json/`，
    并把 state 记录里的 URL 换成 raw JSON 地址；
  - `add_transcript_tag(item, url, type=...)` 支持 `application/json`；
  - 节目页字幕链接指向 JSON；
  - 没有 data JSON 的集（未来新集尚未进管线）保留旧 VTT 行为作为回退；
- `scripts/generate_zh_feed.py`：不再被已迁移节目调用，代码保留给其余 11 个节目。

## 5. 一次性迁移

1. **归档**：把 618 集在 `site/<slug>/transcripts/` 下的全部 `.vtt`（含 `zh/`）移动到
   `data/<slug>/legacy-vtt/`，目录结构保持；同一次提交删除 site 侧文件；
2. **导出**：本地运行导出（不跑 ASR），在 `json/<slug>/` 生成 618 个 JSON 并提交；
3. **删 feed**：删除 `site/office-ladies/feed-zh.xml` 与
   `site/how-we-made-your-mother/feed-zh.xml`；
4. **配置**：`podcasts_translate.json` 移除 hwmym；
5. 回滚 = revert 上述提交。

## 6. 错误处理

- 内部 JSON 缺失 `words` / `zh_words`：写空数组，不中断；
- 句子时间非法（`end <= start`）：沿用导出前校验，跳过该句并计数，不写出坏 JSON；
- 导出使用临时文件 + `replace`，中断不会留下半个文件；
- 站点文件只由对应 job 写；同一节目仍只有一个产出方。

## 7. 测试

- `word_transcript`：句子/词转换、毫秒取整、缺失字段、体积小于内部格式；
- 兼容性断言（按 AntennaPod 解析器规则）：
  - `version` 是字符串，`segments` 是对象数组，每个都有 `startTime/endTime/body`；
  - `start`/`end`/`words[*][1..2]` 都是整数毫秒，`end > start`；
  - 每段 `words` 的起始时间单调不减，且只含英文词；
- `pipeline_site`：publish 只写 JSON、不写 VTT、不生成 feed-zh；
- `scraper.generate_podcast_feed`：有 `transcript_filename` 时写 JSON 标签，缺字段回退 VTT；
- `transcribe.add_transcript_tag`：type 参数；无 data 时回退 VTT；
- `generate_zh_feed`：现有测试保持通过（其他节目仍用）。

## 8. 验收

1. 本地全量导出：618 个 JSON，结构校验通过，总体积实测 386.3 MB；
2. CI 发布一轮：
   - `site/<slug>/feed.xml` 的 transcript 标签全部为 raw JSON + `application/json`；
   - `feed-zh.xml` 不再生成；
   - Pages 部署成功，站点体积约 653 MB（< 1 GB）；
   - 线上随机抽 3 个 raw JSON 返回 200 且可解析；
3. 未迁移节目：feed 标签仍为 `.vtt`，站点文件无变化。

## 9. 风险

| 风险 | 处理 |
| --- | --- |
| 旧 `.vtt` URL 失效 | 已确认接受；文件在 `data/<slug>/legacy-vtt/` 可随时恢复 |
| 播客客户端缓存旧 VTT | URL 已变，客户端会重新取；同一附件内只保留一个标签 |
| Pages 体积逼近 1 GB | JSON 不进 Pages，改由 raw.githubusercontent 提供；归档 VTT 后站点约 653 MB |
| raw.githubusercontent 被限流/不可达 | 客户端缓存同一 URL 即可；必要时改回 Pages 或对象存储，只需改 `RAW_BASE` |
| hwmym 与管线重复转录 | 导出只读 data，不触发 ASR；transcribe 仅在有 data 时切 JSON |
| 标准消费方不认扩展字段 | 标准字段齐全，扩展字段被忽略；上游 AntennaPod 按 `body` 显示句级+双语 |
| fork 丢弃乱序词 | `words` 只放英文、按时间递增；中文只出现在 `body` 第二行 |

## 10. 不做

- 不为其余 11 个节目生成词级数据（需 ASR，另行排期）；
- 不改 VTT 内部文本（归档的就是原样文件）；
- 不新增站点页面或播放器。
