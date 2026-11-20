# cue 级智能跳过设计（分段语义标签 + 跳过级别）

日期：2026-11-19
状态：待确认（方向已选定，本文件为设计稿，未开始实现）
范围：`site/player.html` 播放侧 + 新增离线标注脚本；不改 ASR/翻译管线

## 目标

把现在「关键词正则 + AI 整段广告区间」的粗粒度跳过，升级为**逐句语义标签**，
再用一个「跳过级别」滑杆决定跳哪些类别：

- 只跳广告 → 跳广告+自我推广 → 再跳寒暄跑题 → 激进（含低置信度）
- 每次跳过都要可回看、可撤销、有上限保护，误判不会把正文吞掉

不追求「实时判断」。标签离线预生成，播放侧只读标签做决策，行为可预测、可回放。

## 现状盘点（代码级）

| 位置 | 现在做什么 |
| --- | --- |
| `site/player.html` `AD_RE` / `detectAdRanges()` | 对 `cue.text + cue.zh` 跑正则（sponsored by / 广告 / 赞助 / 优惠码…），命中句并入区间，相邻间隔 <8 s 合并 |
| `mergeAdRanges()` | 合并「正则区间」与「AI 区间」，重叠/相邻 1 s 内并成一条 |
| `studyApplyAiAdRanges()` | 从 `studyCache['ep:<id>']` 的 `data.ads` 取区间（`version === 3` 才认） |
| `applySkipRules()` | `timeupdate` 驱动；顺序：跳过开头 → 跳广告区间（`state.adSkipped` 记录已跳过的下标）→ 跳广告章节 → 跳过结尾 |
| `scripts/ai_pregen.py` | 生成 `<stem>.ai.json`（`version: 3`、`prompt: "ads-v1"`），`ads` 是**整段时间区间**，不是逐句标签 |
| `prefs.skipAds` / `prefs.skipChapterAds` | 两个布尔开关，实验性质，默认关 |
| `showPrefFor()` | 每档 `skipIntro` / `skipOutro`（秒），与本节独立 |

也就是说：AI 已经「知道哪一段是广告」，但只知道**成段的时间范围**；
「这一段是寒暄 / 自我推广 / 跑题」这类信息完全没有，关键词正则也覆盖不到。

## 实测约束

- 站点无构建工具，播放器脚本是 `site/player.js` 里的单文件单 IIFE（约 12.4k 行，`player.html` 只负责外链），扩展必须写在主 IIFE 内
  （2026-11-19 踩过：外层 `<script>` 读不到 `state` / 私有函数）。
- `tests/test_player.py` 用字符串钉住了若干部件与行为，改动要同步测试。
- `.ai.json` 只在预生成过的集存在；命中率不足时必须有降级路径。
- 数据只能进 `data` 分支；`deploy.yml` 不带数据，不影响 Pages 体积。
- 免费 LLM 额度按**请求数**计；不能对每集做多轮判定，也不能在播放中转 LLM。
- 「每个 job 只写自己的文件」：新产物必须能被独立 pathspec 圈住，不能和
  `transcripts.yml` 抢同一个 `data/<slug>/` 目录的其它文件。

## 样本实测（2026-11-19，3 集，正则基线）

用 `scripts/ai_skip.py --heuristic` 在三集真实转写上跑出的基线（不调模型，只验证数据链路）：

| 样本 | cue 数 | 命中句 | 可跳区间 |
| --- | --- | --- | --- |
| hwmym S4E6 | 907 | ad 2 + promo 3 | 3 段，29 s（1.0%） |
| smartless / Bill Hader | 1492 | ad 1 + promo 3 | 2 段，14 s（0.4%） |
| speaking-of-psychology / 怀旧 | 280 | promo 2 | 0 段（命中句 <6 s 门槛） |

三个结论直接改变了这个功能的定位：

1. **动态插播广告不在我们的转写里。** hwmym 有「And now, commercials.」「End of commercials.」，
   但两句之间没有任何广告文本；smartless 是「a word from our sponsor」→「back to the show」，
   中间只隔 5 秒。中国区音频没有 CDN 插播，所以「跳广告」对这批节目**几乎无收益**——
   这不是标签不准，是广告本来就不在音频内容里。
2. **真正有收益的是 baked-in 的部分**：主持人口播的订阅/周边/巡演/求评价（promo）、
   开场的长时间寒暄、结尾的致谢与 housekeeping。SmartLess 开场闲聊常在 5 分钟以上，
   这才是「省时间」的主战场。
3. **「广告壳」可以单独配对**：主持人念的进出场句即使中间没有文字（只有 Jingle/音乐），
   按两句的时间跨度整段跳过仍然成立；这条规则不依赖模型，已实现为 `shell_ranges()`。

由此把默认档从「只跳广告」改为「广告 + 推广」（级别 2），并把 `filler` 明确定位成
「用户主动开启才生效的高收益档」。设计稿下文已按这个结论调整。

### Gemini 标注结果（同日，同 3 集）

用 `gemini-3.1-flash-lite` 实跑（每块一次请求，全部成功）：

| 样本 | 标签句 | 区间 | 可跳 | 主要命中 |
| --- | --- | --- | --- | --- |
| hwmym S4E6 | 41（ad 3 / promo 29 / filler 9） | 6 段 | 3:08（6.3%） | 制作名单 1:37、结尾订阅与个人作品、开场广告壳 |
| smartless / Bill Hader | 41（promo 16 / ad 4 / filler 21） | 5 段 | 1:25（2.3%） | 周边口播 21 s、两次广告壳、收尾闲聊 38 s |
| speaking-of-psychology | 10（promo 3 / filler 7） | 2 段 | 0:40（2.1%） | 结尾节目推广 30 s、中段休息提示 10 s |

对比正则基线（0.2%–1.0%），模型把可跳比例抬到 2.1%–6.3%，且抓到了基线完全漏掉的
制作人员名单、订阅引导、周边口播。人工逐条核对 92 条标签，两个真问题当场修掉：

1. **tag 与 label 打架**：「We'll be right back」被标成 `filler` + label「插播广告」，
   会让级别 1 漏跳。现在 label 命中「广告/赞助/commercial/sponsor」就强制 `tag = ad`。
2. **广告壳被模型区间降级**：合并时按置信度取高，壳（0.8）输给 filler（0.9），
   `ad` 变成 `filler`。现在壳区间带 `rule: "shell"`、优先级最高、置信度 0.95，
   合并时不允许被覆盖。

其它边界判断（保留原样，等听感确认）：hwmym 的「推荐电影」「听众互动引导」被算作
`promo`，属于「推广但不一定是硬广」；`filler` 的「C block」段子是节目结构玩笑，
级别 3 才会跳。

## 设计

### 1. 数据格式：`<stem>.skip.json`（data 分支）

与单集 JSON 同目录，文件名 = transcript stem + `.skip.json`；另备一条
`data/<slug>/skip/<stem>.skip.json` 作为回退（与 `.ai.json` 的双路径一致）。

独立文件而不是塞进 `.ai.json`：跳过标签的生成频率、失败重试、回填批次都与 AI 总结不同，
混在一起会让 `studyCache` 的版本号语义失控。

```json
{
  "version": 1,
  "prompt": "skip-v1",
  "model": "gemini-2.5-flash",
  "generatedAt": "2026-11-19T00:00:00Z",
  "audio_seconds": 1891.5,
  "cue_count": 1024,
  "segments": [
    {"i": 12, "start": 95.4, "tag": "ad",    "conf": 0.94, "label": "赞助口播"},
    {"i": 13, "start": 101.2, "tag": "ad",    "conf": 0.91},
    {"i": 88, "start": 640.0, "tag": "filler","conf": 0.72}
  ],
  "ranges": [
    {"start": 95.4, "end": 178.9, "tag": "ad", "label": "赞助口播", "conf": 0.93}
  ],
  "stats": {"content_seconds": 1450.2, "skippable_seconds": 441.3}
}
```

- `segments` 只列**非 content** 的句子，`content` 是默认值、不落盘（体积可控）。
- `i` 是 cue 序号快路径；`start`（秒，保留 1 位）是权威锚点。加载时先按 `i`
  匹配、再校验 `|cue.start - start| <= 1.5`，不通过就按 `start` 二分找最近句。
  这样 ASR 重跑导致重新切句时不会整集错位，最多丢几条标签。
- `ranges` 由 `segments` 合并派生：连续同 tag 且 gap < 8 s，且合并后 ≥ 6 s 才成段；
  便于播放侧一次性判断，也方便人工核对。
- `version` 与 `prompt` 任一不匹配即视为过期，重新生成。

### 2. 标签体系（封闭集合，4 类）

| tag | 含义 | 例 |
| --- | --- | --- |
| `ad` | 付费广告、赞助口播、优惠码、插播广告 | "this episode is sponsored by…" |
| `promo` | 自我推广：订阅/打赏/巡演/周边/交叉宣传、求评分 | "rate us on Apple Podcasts" |
| `filler` | 寒暄、玩笑、寒暄式离题、节目事务（设备/录音/致谢） | 开场互相打趣、跑题闲聊 |
| `content` | 其余全部（默认） | 正文 |

`intro` / `outro` 仍由现有 `showPref.skipIntro` / `skipOutro` 与章节正则处理，不进标签体系，
避免两套机制抢同一个区间。

判定口径写进 prompt，并且要求模型**宁缺毋滥**：只在明确出现付费关系或明确自我推广时
才标 `ad` / `promo`；普通品牌提及、嘉宾推荐的书和产品一律 `content`。

### 3. 生成链路：`scripts/ai_skip.py`

- 输入：`data/<slug>/<guid>.json`（内部双语 JSON），按 cue 顺序拼
  `[mm:ss] <英文句>`，字符预算 16k 切块（与翻译一致）。
- 每块 prompt 要求返回 `{segments: [{i, tag, conf, label}]}`，只允许上面 4 个 tag，
  `conf` 0–1；**不要求模型给时间**，索引即时间，避免模型把 mm:ss 抄错。
- 合并：按 `i` 去重（保留 `conf` 高者）；`conf < 0.55` 的段直接丢弃（不入库）。
- 派生 `ranges`，并算 `stats`。
- **广告壳配对（规则层，与模型无关）**：`shell_ranges()` 把「And now, commercials / a word from
  our sponsor / we'll be right back」与最近的「End of commercials / back to the show」配成一对，
  中间即使只有 Jingle 也按时间整段跳过；跨度上限 300 s，找不到收尾句就不生成。
  规则区间与模型区间在 `merge_ranges()` 里按起点合并，重叠时保留置信度高的一侧。
- 幂等：文件存在且 `version`/`prompt` 匹配即跳过；`--force` 重算；`--slug` / `--limit`
  限定批次；`--dry-run` 只打印将要发多少请求。
- 密钥复用 `scripts/gemini_keys.py` 的配额桶与错误分类，配额耗尽时正常退出（同
  `run_pipeline` 的口径），下次续跑。
- 写盘走「临时文件 + rename」，避免半截 JSON 被播放器读到。

**不做的**：不在 ASR/翻译管线里内联调用（会把单集 35–40 分钟的链路风险放大），
而是一个独立 workflow/手动脚本，按节目批量回填。

### 4. 播放侧：`skipPlan` 与合并优先级

新增 `buildSkipPlan()`，在 `applyEpisodeData()` 之后、`renderCues()` 之前调用；
`skip.json` 异步到达（fetch transcript URL 把 `.json` 换成 `.skip.json`，
失败再试 `skip/<stem>.skip.json`）时重算一次，只更新徽标与区间，不重建字幕。

优先级（高 → 低）：

1. `skip.json` 的逐句 tag（磁盘，最可信）
2. `studyCache['ep:<id>'].data.ads`（AI 总结区间）
3. `AD_RE` 正则命中的句子（原文/译文关键词）
4. 章节标题正则（现有 `skipChapterAds`）

合并成一张统一表：

```js
state.skipPlan = {
  source: 'disk' | 'ai' | 'regex' | 'none',
  tags: Map<cueIndex, {tag, conf}>,      // 句级
  ranges: [{start, end, tag, label, conf, id}],  // 区间级，按 start 排序
  limited: false                          // 是否触发上限保护
}
```

区间 `id = tag + ':' + round(start*10)`，**不再用数组下标**做 `adSkipped` 的键
（合并规则一变，下标就会错位跳错地方）。这是对现有实现的直接修正。

### 5. 跳过级别（`prefs.skipLevel`）

| 级别 | 名称 | 跳什么 |
| --- | --- | --- |
| 0 | 关闭 | 不跳（旧行为） |
| 1 | 只跳广告 | `ad` |
| 2 | 广告 + 自我推广 | `ad` + `promo`（默认档） |
| 3 | 再跳寒暄 | `ad` + `promo` + `filler`（`conf >= 0.8`） |
| 4 | 激进 | 同上，`filler` 门槛降到 0.55，且「连续 ≥2 句非 content」即跳 |

默认用 2（广告 + 推广），不是 1：样本实测证明动态广告本来就不在音频里，`ad` 这一档
收益接近 0，`promo`（订阅/周边/巡演/结尾求评价）才是稳定可跳的部分。`filler` 是时间
收益最大的一档（SmartLess 开场闲聊常在 5 分钟以上），但必须先让用户自己开，避免
「把节目当论文听」的误伤。

- 迁移：旧 `prefs.skipAds === true` 读一次 → `skipLevel = 1`，然后删键；
  `skipChapterAds` 保留为独立开关（章节级，和句级互补）。
- 没有 `skip.json` 的集：级别 3/4 自动降级为「AI 区间 + 正则」（即级别 1/2 的效果），
  并在详情面板标「本集无逐句标签」。

### 6. 上限保护（必须实现，否则不敢开）

四条硬约束，任一触发即停止跳过该段并留日志：

1. **单段 ≤ 120 秒**：一次最多跳 120 s，超出部分不跳；界面标「区间过长，已截断」。
2. **单集 ≤ 40%**：可跳总时长超过音频 40% 时，按置信度从低到高砍掉尾部区间，
   `skipPlan.limited = true`，面板显示「标签疑似过度，已限制」。
3. **在区间内不反复弹**：只有「进入区间后 0.5 s 内」且「区间剩余 ≥ 3 s」才跳；
   跳过后写 `skipDone`，同一区间本次播放不再触发。
4. **用户手动 seek 进区间 → 静音该区间**：`state.skipMuted.add(id)`，本次播放不再自动跳；
   换集清空。跳过时给一次可点击的「已跳过 广告 1:32 · 回跳」提示，
   点击则回跳并静音该区间（撤销）。

结尾区间不做自动续播判断（那是 `skipOutro` 的职责），句级跳过只负责「往前走」。

### 7. UI

- **设置 → 收听**：把「自动跳过广告（实验）」开关换成「跳过级别」4+1 档单选
  （`role=radio`、`aria-checked`），每档一行说明；下方显示「本集：内容 24:10 · 跳过 5:31」。
- **播放页详情面板**：给被标记的句子加小徽标（`ad` / `promo` / `filler`），
  点徽标可单独回跳该段；顶部一行来源说明（磁盘标签 / AI 区间 / 关键词 / 无）。
- **底栏「⋯」**：一行「跳过 · 级别 2 · 省 5:31」，与现有徽标同一套去重逻辑。
- **进度条**：可跳区间在轨道上叠半透明底纹（不新增控件、不改 `#seek` 的原生 range 行为）。
- 全部文案中文；驾驶界面下只保留徽标，不弹提示条。

### 8. 验收（必须先本地实测再谈提交）

用 3 集真实数据（hwmym 1 集、smartless 1 集、speaking-of-psychology 1 集）人工标一遍后：

- 广告区间起止与听感一致，误差 ≤ 5 s；
- 级别 1 只跳广告：正文句子一句不少，随机抽 20 句核对；
- 误判率：被标成 `ad`/`promo` 的 `content` 句 < 3%（人工抽样 100 句）；
- 手动拖进区间不被弹走；跳到区间前的 0.4 s 处能正常听；
- 单集 40% 上限生效（构造一集标签密集的极端样本）；
- 关闭级别 0 后行为与当前版本完全一致（可回滚）；
- `tests/test_player.py` 新增：合并优先级、`id` 去重、120 s 截断、40% 上限、
  静音区间、级别 0 直通。

### 9. 规模与成本

- 全库约 1500 集、每集约 3 块请求 → 约 4500 次 LLM 请求；先跑 hwmym 与最近 50 集，
  再按「被订阅/被播放过」优先级回填。
- 每集 `skip.json` 约 1500 句 × 少量非 content 行 ≈ 10–50 KB，gzip 后更小；
  全库约 50–70 MB，放 data 分支可接受（当前 `json/` 已 2.2 GB）。
- 播放侧零额外请求（只在打开单集时拉一个几十 KB 的 JSON，可缓存 IndexedDB）。

### 10. 风险与不做

| 风险 | 处理 |
| --- | --- |
| AI 把正文标成广告 | 置信度门槛 0.55 起、40% 上限、单段 120 s 上限、可静音/可回跳 |
| 主持人开场闲聊被当 filler 跳过，用户其实想听 | 默认级别 2（不含 filler），filler 要用户主动开到 3 |
| 数据分支提交冲突 | 新 workflow 只 `git add` `data/*/*.skip.json` 与 `data/*/skip/**`，独立 concurrency group |
| 逐句标签与 ASR 切句不一致 | 以 `start` 秒为锚点，`i` 只作快路径，匹配失败就丢该条 |
| 无标签集体验退化 | 明确降级到 AI 区间/正则，并在界面标注来源 |

不做：说话人分离（先按语义，不上 pyannote）；播放中实时调 LLM；自动改写音频做
「干净版」（`docs/handover.md` 第九节已否证）。

## P0 实现（2026-11-19）

按「只用在离线音频、本机自转写」的口径落地，范围比原设计更窄：

- **门控**：`skipEligible()` 要求三件事同时成立——播放的是本机音频（`asset:`）、
  文字稿来自本机副本（`readTranscriptDoc` 的 `local === true`）、运行在桌面壳（`LIVE_HOST.kind === 'tauri'`）。
  站外节目、动态插播、远端拉取的文字稿一律不套标签，避免时间轴对不上而跳错位置。
- **本机标签**：`<key>.skip.json` 与 `<key>.transcript.json` 同目录落盘（Rust
  `offline_save_skip` / `offline_skip_load`）；播放时先读本机，读不到再按
  `transcript.url` 换 `.skip.json` 取远端。下载文字稿时顺带下标签，失败不影响播放。
- **默认**：总开关仍默认关；级别默认 2，设置页可选 1 / 2 / 3（3 含寒暄，标注为高误判档）。
- **保护**：单段最多 120 秒；单集可跳不超过 40%（超出时从置信度最低的区间开始砍）；
  进入区间超过 0.5 秒即视为用户自己拖入，本次播放不再跳；已跳过的区间按 `id` 去重。
- **标注**：`scripts/ai_skip.py`（Gemini）、`--heuristic`（正则基线）、`--repost`（规则修正后重算）。

**未验证**：Rust 侧尚未 `cargo build` 出安装包，真机（离线下载 → 播放 → 跳过）也还没跑过。
按仓库规矩，这两步都实测通过前不提交。

## 分阶段

- **P0**：`ai_skip.py` + 3 集样本标签 + 播放侧 `buildSkipPlan` + 级别 0/1/2 + 四条上限保护 + 测试。
- **P1**：级别 3/4、进度条底纹、回跳撤销、本集统计、详情面板徽标。
- **P2**：全库回填 workflow、内容变更自动重跑、抽样质检脚本（把 40% 上限触发率、
  `conf` 分布打进报告）。

## 落地后必须同步

- `docs/handover.md` 增加「cue 级跳过」小节（数据格式、优先级、四条上限、回滚方式）；
- `GLOSSARY.md` 增加 **跳过级别**、**句级标签** 两个词条；
- `AGENTS.md` 文件归属表增加 `data/<slug>/*.skip.json` 一行；
- 任何实机验证通过前不提交（用户既有规则）。
