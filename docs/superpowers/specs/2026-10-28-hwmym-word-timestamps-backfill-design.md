# hwmym 词级时间戳：CI 分片回填设计

日期：2026-10-28 状态：待评审

## 目标

把 `how-we-made-your-mother` 全部 119 集重转一遍：Whisper 换成 turbo、cue 时间改用真实词时间、
每集在 `site/how-we-made-your-mother/timings/<vtt 同名>.json` 产出逐词时间轴（TMLT 同构）。
新集与老集最终一致，不再有两套文本风格。

## 实测规模（2026-10-28，来自 feed 与本机跑批）

| 项 | 数值 |
| --- | --- |
| 音频总量 | 100.5 小时（121 条，中位 53 分钟） |
| 需下载 | 8.1 GB（@192kbps 估算） |
| turbo 转录 | 本机 RTF 0.49（24 线程）；2 核 runner 按 2–4 倍保守估计，单集约 100 分钟 |
| 重新翻译 | 88,878 条 cue ≈ 1,777 次 Gemini 请求（50 条/批），15 RPM 下限约 2 小时 |
| 产出 | 119 个 VTT 重写 + 119 个 sidecar（约 33 MB） |

据此：**约 3 轮、每轮 ≤20 个分片 × 280 分钟**。冒烟必须先跑一集拿到真实 RTF，再定轮数。

## 一、模式与入口

`transcribe.yml` 增加 `workflow_dispatch` 输入，其余步骤共用：

| 输入 | 默认 | 作用 |
| --- | --- | --- |
| `backfill` | `false` | 进入回填模式（矩阵 20 分片） |
| `shard` / `shards` | matrix / 20 | 分片号与总数 |
| `max_minutes` | `280` | 单个分片的时间预算（job 上限 360 分钟留余量） |

回填 job 用 `strategy.matrix.shard: [0..19]`，`max-parallel` 不限制；正常模式仍是单 job。
分片归属按 `sha1(identity) % shards` 决定，**与顺序无关**，跨轮稳定。

## 二、选片与断点（以 sidecar 为唯一真相）

回填候选 = "已有合格双语 VTT 且 sidecar 不完整"的集：

- sidecar 存在且 `complete: true` → 完成，跳过；
- sidecar 不存在，或 `complete: false` 且 `attempts < 2` → 待做；
- `attempts >= 2` 的确定性失败 → 跳过并在日志里点名，不再每轮烧一次下载和部分 CPU。

失败时也要写 sidecar：`{complete: false, attempts: n, segments: []}`。这样断点、重试上限、
"哪集坏了"三件事共用一个文件，不需要新增状态文件，也不需要改 `state.json`。

## 三、事务边界：不碰 state.json / feed.xml / index.html

回填模式只产出两件事：VTT 和 sidecar，**不写 `state.json`、不重建 feed 与 index**，
原因是 20 个分片并行写同一个 `state.json` 必然互相覆盖，而 feed/index 的重建属于正常模式。

- VTT 与 sidecar 先写 `.tmp`、校验通过后原子替换；翻译失败则两样都不落盘，老 VTT 保持原样。
  唯一的半成品窗口是"VTT 已换、sidecar 还没写"就被杀掉：下一轮看到合格 VTT + 缺 sidecar，
  会整集重做——结果正确，只是浪费一集；这是有意的取舍，不做跨文件两阶段提交。
- 提交按**分片**做（每分片 1 次），并在 `trap` 里补一次，避免超时被杀丢掉整片成果；
  pathspec 只含本分片产出的文件，与其它分片天然不相交，`git_push_retry.sh` 的 rebase 不会冲突。
- 每轮最多 20 次 push → 最多 20 次 deploy，不会撞 Pages 的构建频率限制。

## 四、模型供应（回填与正常模式共用）

`actions/cache` 缓存 `models/ct2-turbo`（key `ct2-turbo-v1`，与 TMLT 一致），miss 时用
`huggingface_hub.snapshot_download("deepdml/faster-whisper-large-v3-turbo-ct2")` 拉取并校验
`model.bin` 大小。`WHISPER_MODEL=models/ct2-turbo`，**正常模式也切过去**，否则新集又变回 base.en。

**硬失败不降级**：回填模式下模型目录缺失或无 `model.bin` 直接 `exit 1`。绝不能静默回退到
base.en——那会用旧模型把 119 集重写一遍，而且看不出来。

## 五、配额与失败处理

- Gemini 返回 `RESOURCE_EXHAUSTED` / 429：**停止本分片、退出码 0**，提交已完成部分，
  日志写一行 "quota exhausted, resume next round"。下一轮由人手动派发。
- 单集其它异常（下载失败、音频损坏、转录为空）：写 `complete:false` sidecar 后继续下一集。
- 下载沿用现有中国代理竞速；单集下载失败不重试超过一次，避免占满分片预算。

### 五·补 Gemini 多密钥轮换

单一 key 在 1,777 次请求的量级上很容易撞日配额，所以引入**顺序轮换**（不并行）：

- **配置**：新 secret `GEMINI_API_KEYS`，逗号或空格分隔；`GEMINI_API_KEY` 保留为单 key 兼容写法。
  生效列表 = `GEMINI_API_KEYS` 去空去重后的数组，为空则退回 `[GEMINI_API_KEY]`。
  workflow 两个都注入，检查步骤只在**两者都为空**时报错。
- **`KeyRing`**（放 `transcribe.py`，与 `create_gemini_client` 同处）：持有 key 列表、按下标缓存
  `genai.Client`、`current()` / `mark_exhausted(reason)` / `available`。**轮换状态只在进程内有效**，
  不落盘——配额按天重置，跨轮沿用会把可用 key 永久排除。
- **判定**：429 / `RESOURCE_EXHAUSTED` 先按现有退避重试一次；仍失败则视为该 key 配额耗尽 →
  标记并切下一个。401/403（key 无效）立即切换。其它异常维持原重试逻辑，不触发切换。
  全部耗尽 → 抛 `QuotaExhausted`，由分片层按上一节"停下、提交、退出 0"处理。
- **限速不变**：全局 15 RPM 的 `wait_for_gemini_rate_limit()` 保留单实例、顺序发请求。
  轮换买到的是**配额余量**而不是并发（单请求本身 10–20 秒，速率上限不是瓶颈）。
- **日志**：绝不打印 key；只打 `key #2（…a1b2）` 与累计请求数。切换时一行
  `Gemini key #2 配额耗尽，切到 #3（本片已用 412 次）`。
- **测试**（不发网络请求）：`parse_gemini_keys` 的分隔/去重/空值；`KeyRing` 的起始下标、
  耗尽后轮换、全部耗尽时 `available is False`；`is_quota_error` 对假 429 与超时的分类；
  以及"第一个 key 抛 429、第二个成功 → 翻译结果正确且 ring 已前进"的注入测试。
- **范围**：translate 流程（`translate_vtt.py`）同样用 Gemini，但本轮不改；等 `KeyRing` 稳定后
  再抽成共享模块，避免现在为一个假设的复用先加一层抽象。


## 六、运行计划

1. **冒烟**：`backfill=true, shards=1, max_minutes=60`，只做 1 集。拿到 2 核上的真实 RTF、
   单集总耗时（下载 + 转录 + 翻译），据此修正轮数与每轮分片数。
2. **第 1–3 轮**：`backfill=true`，默认分片。每轮结束看 `timings/` 增量与失败点名。
3. **收尾校验**：见下。

## 七、验收判据

- 119 个 sidecar 全部 `complete: true`，且与 VTT 同名一一对应；
- 每集 spot check：带词 cue ≥95%、越界词 0、`audio_seconds` 与 feed `<duration>` 差 ≤5 秒；
- 抽 3 集对齐人工听感：前 30 秒与前 30 分钟各取 5 个词，词起点偏差 ≤0.5 秒；
- `state.json` 未被回填改动（`git diff` 只含 `site/.../transcripts/*.vtt` 与 `timings/*.json`）；
- 站点正常发布，AntennaPod 侧 VTT 格式不变（只有时间值更准）。

## 八、不做的事

- 不动另外 12 个抓取节目的字幕（词级对齐要 TMLT 的 CT2+DTW，是独立工程）；
- 不改 VTT 格式（不加 `<c>` 卡拉OK 标签），词时间只走 sidecar；
- 不引入 stable-ts / torch（hwmym 的词时间来自 Whisper 本身，不需要强制对齐）。

## 九、风险

| 风险 | 处理 |
| --- | --- |
| 2 核 RTF 远超本机估计 | 冒烟先测；每轮分片数按实测调整，必要时降到 10 分片 × 2 轮 |
| Gemini 日配额 | 多 key 顺序轮换 + 分片级暂停 + 手动续跑；仍不够就把轮次摊到多天 |
| 重写 119 个 VTT 引起文本大改 | 已在需求中确认；VTT 文件名不变，feed 链接不断 |
| 分片并发 push | pathspec 不相交 + `git_push_retry.sh`；每轮 ≤20 次 push |

## 十、需要你先做的准备

1. 在仓库 Settings → Secrets 里加 `GEMINI_API_KEYS`（逗号分隔，2 个起有意义）；`GEMINI_API_KEY` 可保留。
2. 确认仓库是**公开**的（否则 119 集 × 数小时的 Actions 分钟会烧掉私有额度）。
3. 冒烟那一轮我会先只跑 1 集，把 2 核 RTF / 单集耗时 / 配额消耗报给你，再决定正式轮数。

