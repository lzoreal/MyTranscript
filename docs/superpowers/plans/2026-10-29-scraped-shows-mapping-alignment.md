# 抓取节目词级时间戳 v2（映射式对齐）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 12 个抓取节目用"自己转写 + 文本映射"的方式，产出逐词时间 sidecar，并顺带修正字幕时间、删除听众听不到的广告块。

**Architecture:** 每集下载音频 → 用自己的 ASR（turbo + 词时间）→ 把 PodScripts 的全篇 token 与我们词流做全局序列映射 → 按每条 cue 的映射覆盖率分流（正文/部分/删除）→ 原子重写双语与 zh 两份 VTT、写 sidecar。锚点式（TMLT 窗口对齐）已被否证，相关函数删除。

**Tech Stack:** Python 3.11（CI）/ 3.10（本机）、faster-whisper + CTranslate2 turbo（int8）、av（解码）、difflib（序列映射）、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-10-29-scraped-shows-word-timestamps-design.md`

## Global Constraints

- 阈值（与 spec 逐字一致）：`BODY_MIN_COVERAGE = 0.70`、`PARTIAL_MIN_COVERAGE = 0.30`、`MAX_DROP_RATIO = 0.25`、`MIN_TOKENS_TO_DROP = 5`、`MIN_TEXT_SIMILARITY = 0.85`、`MIN_BODY_RATIO = 0.70`。
- **展示文本不变**：只删除广告块与改时间，正文英文/中文文本逐字保留。
- **两套字幕一起重写**：`transcripts/<stem>.vtt` 与 `transcripts/zh/<stem>.vtt` 按同样块下标删除、用同样新时间；写前校验两份块数一致；zh 文件缺失则只写双语版并记一行日志。
- **不写** `state.json` / `feed.xml` / `feed-zh.xml` / `index.html` / `progress.json`。
- sidecar 结构不变（与 hwmym 同构）：`{episode, audio_seconds, complete, attempts, segments:[{start,end,speaker,text,words:[[词,起始ms,时长ms]]}]}`；`segments[i]` 对应**重写后**第 i 条 cue。
- 断点 = sidecar：`complete:true` 跳过；`attempts >= 2` 不再重试；放弃本集时只写 `complete:false` + `attempts+1`，不动任何已发布文件。
- 单元测试不联网、不解码音频、不加载模型：下载、转写、解码全部注入。
- CI 用 Python **3.11**；本机跑测试用系统 `python`（3.14），跑真实转写用 `C:\Users\游梦\AppData\Local\Programs\Python\Python310\python.exe`。
- 提交策略：用户说"提交"才提交，不 push。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `scripts/align_timings.py` | 本特性的全部逻辑：VTT 解析/渲染、token 归一化、序列映射、覆盖率分流、时间分配、单集编排、CLI |
| `scripts/transcribe.py` | 只复用：`download_audio`、`whisper_transcribe`、`write_word_timings`、`sidecar_*`、`shard_of`、`get_feed_entries` |
| `tests/test_align_timings.py` | 全部纯函数测试 + 注入式单集编排测试 |
| `.github/workflows/align.yml` | 触发、模型缓存、提交路径（新增 zh 路径） |
| `requirements-align.txt` | 精简为 transcribe 依赖 + av（不再需要 stable-ts/torch） |

---

### Task 1: 双语 VTT 解析与渲染（可往返）

**Files:**
- Modify: `scripts/align_timings.py`（用 `parse_bilingual_vtt` 取代 `parse_vtt_cues`）
- Test: `tests/test_align_timings.py`

**Interfaces:**
- Produces:
  - `parse_bilingual_vtt(path: Path) -> list[dict]`，元素 `{"start": float, "end": float, "en": str, "zh": str}`
  - `render_vtt(cues: list[dict]) -> str`（从 1 连续编号，`WEBVTT` 头，每块 index/时间/en/zh）
  - `validate_vtt(text: str, blocks: int, bilingual: bool) -> None`（不合格抛 `ValueError`）

- [ ] **Step 1: 写失败测试**

```python
class VttRoundTripTests(unittest.TestCase):
    def sample(self):
        return [
            {"start": 1.0, "end": 4.0, "en": "Hello there.", "zh": "你好。"},
            {"start": 60.5, "end": 62.0, "en": "Second cue.", "zh": "第二句。"},
        ]

    def test_render_then_parse_round_trips(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "ep.vtt"
            path.write_text(aligner.render_vtt(self.sample()), encoding="utf-8")
            back = aligner.parse_bilingual_vtt(path)
        self.assertEqual(back, self.sample())

    def test_parse_rejects_blocks_without_both_languages(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "ep.vtt"
            path.write_text(
                chr(10).join(["WEBVTT", "", "1", "00:00:01.000 --> 00:00:02.000", "Only english", ""]),
                encoding="utf-8",
            )
            cues = aligner.parse_bilingual_vtt(path)
        self.assertEqual(cues, [], "缺译文的块不参与重写")

    def test_validate_rejects_non_monotonic_times(self):
        text = aligner.render_vtt(
            [
                {"start": 5.0, "end": 6.0, "en": "a", "zh": "甲"},
                {"start": 2.0, "end": 3.0, "en": "b", "zh": "乙"},
            ]
        )
        with self.assertRaises(ValueError):
            aligner.validate_vtt(text, blocks=2, bilingual=True)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_align_timings.py`
Expected: ERROR `has no attribute 'parse_bilingual_vtt'`

- [ ] **Step 3: 实现**

```python
TIMESTAMP = re.compile(r"(\d+):(\d\d):([\d.]+)\s*-->\s*(\d+):(\d\d):([\d.]+)")


def _seconds(match, offset):
    h, m, s = match.group(1 + offset), match.group(2 + offset), match.group(3 + offset)
    return int(h) * 3600 + int(m) * 60 + float(s)


def timestamp(value: float) -> str:
    ms = int(round(value * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d}.{ms % 1000:03d}"


def parse_bilingual_vtt(path: Path) -> list[dict[str, Any]]:
    cues: list[dict[str, Any]] = []
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    for block in re.split(r"\r?\n\r?\n", text):
        lines = [line.strip() for line in block.strip().split(chr(10)) if line.strip()]
        stamp = next((line for line in lines if "-->" in line), None)
        if not stamp:
            continue
        match = TIMESTAMP.search(stamp)
        if not match:
            continue
        body = [line for line in lines if "-->" not in line and not line.isdigit()]
        if len(body) < 2:
            continue
        cues.append(
            {
                "start": _seconds(match, 0),
                "end": _seconds(match, 3),
                "en": body[0],
                "zh": body[1],
            }
        )
    return cues


def render_vtt(cues: list[dict[str, Any]]) -> str:
    blocks = ["WEBVTT", ""]
    for index, cue in enumerate(cues, 1):
        blocks.extend(
            [
                str(index),
                f"{timestamp(cue['start'])} --> {timestamp(cue['end'])}",
                cue["en"],
                cue["zh"],
                "",
            ]
        )
    return chr(10).join(blocks).rstrip() + chr(10)


def validate_vtt(text: str, blocks: int, bilingual: bool) -> None:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "WEBVTT":
        raise ValueError("缺少 WEBVTT 头")
    body = [line for line in lines[1:] if line.strip()]
    cue_blocks = [b for b in re.split(r"\r?\n\r?\n", chr(10).join(body)) if b.strip()]
    if len(cue_blocks) != blocks or blocks < 1:
        raise ValueError(f"块数不符：{len(cue_blocks)} != {blocks}")
    previous_end = -1.0
    for block in cue_blocks:
        rows = block.strip().split(chr(10))
        if len(rows) != (4 if bilingual else 3):
            raise ValueError(f"块结构异常：{len(rows)} 行")
        match = TIMESTAMP.search(rows[1])
        if not match:
            raise ValueError("时间行无法解析")
        start, end = _seconds(match, 0), _seconds(match, 3)
        if start < previous_end:
            raise ValueError("时间未单调递增")
        if not 0 < end - start < 300:
            raise ValueError(f"时长异常：{end - start:.2f}s")
        previous_end = end
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_align_timings.py`
Expected: `OK`（旧 `parse_vtt_cues` 的测试随实现一并删除）

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/align_timings.py tests/test_align_timings.py
git commit -m "feat: parse and render bilingual VTT with strict validation"
```

---

### Task 2: token 归一化与全篇映射

**Files:**
- Modify: `scripts/align_timings.py`
- Test: `tests/test_align_timings.py`

**Interfaces:**
- Produces:
  - `normalize_tokens(text: str) -> list[str]`
  - `cue_token_spans(cues) -> tuple[list[str], list[tuple[int, int]]]`：全篇 token 与每条 cue 的 `[start, end)`
  - `map_stream(pods: list[str], ours: list[str]) -> tuple[dict[int, int], float]`：`pods 下标 -> ours 下标` 与整篇相似度

- [ ] **Step 1: 写失败测试**

```python
class MappingTests(unittest.TestCase):
    def test_normalize_lowercases_and_merges_continuations(self):
        tokens = aligner.normalize_tokens("Don't re-watch HowWeMadeYourMother.com!")
        self.assertEqual(tokens, ["dont", "rewatch", "howwemadeyourmothercom"])

    def test_cue_spans_cover_every_token_once(self):
        cues = [
            {"start": 0.0, "end": 1.0, "en": "one two", "zh": "甲"},
            {"start": 2.0, "end": 3.0, "en": "three", "zh": "乙"},
        ]
        tokens, spans = aligner.cue_token_spans(cues)
        self.assertEqual(tokens, ["one", "two", "three"])
        self.assertEqual(spans, [(0, 2), (2, 3)])

    def test_maps_identical_streams_one_to_one(self):
        pods = ["a", "b", "c"]
        mapping, similarity = aligner.map_stream(pods, pods)
        self.assertEqual(mapping, {0: 0, 1: 1, 2: 2})
        self.assertAlmostEqual(similarity, 1.0)

    def test_maps_across_an_inserted_ad(self):
        pods = ["intro", "ad", "ad", "body", "end"]
        ours = ["intro", "body", "end"]
        mapping, similarity = aligner.map_stream(pods, ours)
        self.assertEqual(mapping[0], 0)
        self.assertEqual(mapping[3], 1)
        self.assertEqual(mapping[4], 2)
        self.assertNotIn(1, mapping)
        self.assertNotIn(2, mapping)
        self.assertGreater(similarity, 0.5)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_align_timings.py`
Expected: ERROR `has no attribute 'normalize_tokens'`

- [ ] **Step 3: 实现**

```python
CONTINUATION_PREFIXES = ("-", ".", "'", "\u2019")


def normalize_tokens(text: str) -> list[str]:
    """小写、去标点、合并被拆开的续接词（don 't、re -watching、com .com）。"""
    merged: list[str] = []
    for raw in text.split():
        token = raw
        if merged and token[:1] in CONTINUATION_PREFIXES:
            merged[-1] += token
        else:
            merged.append(token)
    cleaned = (re.sub(r"[^a-z0-9]", "", token.lower()) for token in merged)
    return [token for token in cleaned if token]


def cue_token_spans(cues) -> tuple[list[str], list[tuple[int, int]]]:
    tokens: list[str] = []
    spans: list[tuple[int, int]] = []
    for cue in cues:
        start = len(tokens)
        tokens.extend(normalize_tokens(cue["en"]))
        spans.append((start, len(tokens)))
    return tokens, spans


def map_stream(pods: list[str], ours: list[str]) -> tuple[dict[int, int], float]:
    """全局序列对齐：相等的块直接对应，替换块按比例对应；删除/插入块不给映射。"""
    from difflib import SequenceMatcher

    matcher = SequenceMatcher(None, pods, ours, autojunk=False)
    mapping: dict[int, int] = {}
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for offset in range(i2 - i1):
                mapping[i1 + offset] = j1 + offset
        elif tag == "replace" and j2 > j1:
            for offset in range(i2 - i1):
                mapped = j1 + int((offset + 0.5) * (j2 - j1) / (i2 - i1))
                mapping[i1 + offset] = min(mapped, j2 - 1)
    return mapping, matcher.ratio()
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_align_timings.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/align_timings.py tests/test_align_timings.py
git commit -m "feat: map PodScripts tokens onto our own word stream"
```

---

### Task 3: 覆盖率分流与整集守卫

**Files:**
- Modify: `scripts/align_timings.py`
- Test: `tests/test_align_timings.py`

**Interfaces:**
- Consumes: `cue_token_spans`、`map_stream`（Task 2）
- Produces:
  - 常量 `BODY_MIN_COVERAGE`、`PARTIAL_MIN_COVERAGE`、`MAX_DROP_RATIO`、`MIN_TOKENS_TO_DROP`、`MIN_TEXT_SIMILARITY`、`MIN_BODY_RATIO`
  - `classify_cues(spans, mapping) -> list[str]`（`"body" | "partial" | "drop"`）
  - `episode_rejection(decisions, similarity) -> str | None`（返回拒绝原因或 None）

- [ ] **Step 1: 写失败测试**

```python
class ClassifyTests(unittest.TestCase):
    def spans(self, *counts):
        spans, cursor = [], 0
        for count in counts:
            spans.append((cursor, cursor + count))
            cursor += count
        return spans

    def test_three_way_split_at_the_documented_thresholds(self):
        spans = self.spans(10, 10, 10, 10)
        mapping = {i: i for i in range(40)}
        # 第一条 100%、第二条 50%、第三条 20%、第四条 0%
        mapping = {i: i for i in range(10)}
        mapping.update({10 + i: 10 + i for i in range(5)})
        mapping.update({20 + i: 20 + i for i in range(2)})
        got = aligner.classify_cues(spans, mapping)
        self.assertEqual(got, ["body", "partial", "drop", "drop"])

    def test_short_blocks_are_never_dropped(self):
        spans = self.spans(3)  # 只有 3 个 token，低于 MIN_TOKENS_TO_DROP
        got = aligner.classify_cues(spans, {})
        self.assertEqual(got, ["partial"], "短块即使零覆盖也保留")

    def test_rejection_when_too_much_would_be_dropped(self):
        decisions = ["drop"] * 4 + ["body"] * 6
        self.assertEqual(aligner.episode_rejection(decisions, 0.99), "删除比例超过 25%")

    def test_rejection_on_low_similarity(self):
        decisions = ["body"] * 10
        self.assertEqual(aligner.episode_rejection(decisions, 0.5), "文本相似度过低")

    def test_accepts_a_healthy_episode(self):
        decisions = ["body"] * 8 + ["drop"] * 2
        self.assertIsNone(aligner.episode_rejection(decisions, 0.96))
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_align_timings.py`
Expected: ERROR `has no attribute 'classify_cues'`

- [ ] **Step 3: 实现**

```python
BODY_MIN_COVERAGE = 0.70
PARTIAL_MIN_COVERAGE = 0.30
MAX_DROP_RATIO = 0.25
MIN_TOKENS_TO_DROP = 5
MIN_TEXT_SIMILARITY = 0.85
MIN_BODY_RATIO = 0.70


def classify_cues(spans, mapping) -> list[str]:
    decisions = []
    for start, end in spans:
        count = end - start
        if count == 0:
            decisions.append("partial")
            continue
        covered = sum(1 for index in range(start, end) if index in mapping)
        coverage = covered / count
        if coverage >= BODY_MIN_COVERAGE:
            decisions.append("body")
        elif coverage < PARTIAL_MIN_COVERAGE and count >= MIN_TOKENS_TO_DROP:
            decisions.append("drop")
        else:
            decisions.append("partial")
    return decisions


def episode_rejection(decisions: list[str], similarity: float) -> str | None:
    if similarity < MIN_TEXT_SIMILARITY:
        return "文本相似度过低"
    if not decisions:
        return "没有 cue"
    dropped = decisions.count("drop")
    if dropped / len(decisions) > MAX_DROP_RATIO:
        return "删除比例超过 25%"
    kept = len(decisions) - dropped
    if kept / len(decisions) < MIN_BODY_RATIO:
        return "保留 cue 占比过低"
    if "body" not in decisions:
        return "没有任何 cue 拿到映射词"
    return None
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_align_timings.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/align_timings.py tests/test_align_timings.py
git commit -m "feat: classify cues by mapping coverage with episode guards"
```

---

### Task 4: 新时间与新 sidecar 片段

**Files:**
- Modify: `scripts/align_timings.py`
- Test: `tests/test_align_timings.py`

**Interfaces:**
- Consumes: `classify_cues`（Task 3）
- Produces:
  - `assign_times(cues, spans, decisions, mapping, words, total_seconds) -> list[dict]`
    返回**保留下来的** cue（已删 drop），每条 `{"start", "end", "en", "zh", "words"}`；
    `body` 带词（词来自 `words[mapping[i]]`），`partial` 不带词；时间单调、`start < end`。

- [ ] **Step 1: 写失败测试**

```python
class AssignTimesTests(unittest.TestCase):
    def setUp(self):
        self.cues = [
            {"start": 0.0, "end": 10.0, "en": "one two three", "zh": "甲"},
            {"start": 10.0, "end": 20.0, "en": "four five", "zh": "乙"},
            {"start": 20.0, "end": 30.0, "en": "six seven", "zh": "丙"},
        ]
        self.words = [
            {"w": "one", "s": 1.0, "e": 1.4},
            {"w": "two", "s": 1.4, "e": 1.8},
            {"w": "three", "s": 1.8, "e": 2.2},
            {"w": "four", "s": 30.0, "e": 30.4},
            {"w": "five", "s": 30.4, "e": 31.0},
            {"w": "six", "s": 40.0, "e": 40.4},
        ]

    def test_body_cue_takes_mapped_word_span(self):
        spans = [(0, 3)]
        mapping = {0: 0, 1: 1, 2: 2}
        out = aligner.assign_times(self.cues[:1], spans, ["body"], mapping, self.words, 60.0)
        self.assertAlmostEqual(out[0]["start"], 1.0)
        self.assertAlmostEqual(out[0]["end"], 2.2)
        self.assertEqual([w["w"] for w in out[0]["words"]], ["one", "two", "three"])

    def test_dropped_cues_disappear(self):
        spans = [(0, 3), (3, 5)]
        decisions = ["body", "drop"]
        mapping = {0: 0, 1: 1, 2: 2}
        out = aligner.assign_times(self.cues[:2], spans, decisions, mapping, self.words, 60.0)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["en"], "one two three")

    def test_unmapped_cue_is_interpolated_between_neighbours(self):
        spans = [(0, 0), (0, 0)]
        cues = [
            {"start": 0.0, "end": 5.0, "en": "x" * 50, "zh": "甲"},
            {"start": 5.0, "end": 10.0, "en": "y" * 200, "zh": "乙"},
        ]
        out = aligner.assign_times(cues, spans, ["partial", "partial"], {}, [], 60.0)
        self.assertAlmostEqual(out[0]["start"], 0.0)
        self.assertLess(out[0]["end"], out[1]["end"])
        self.assertEqual(out[0]["words"], [])

    def test_times_stay_monotonic_and_positive(self):
        spans = [(0, 3), (3, 5)]
        cues = self.cues[:2]
        mapping = {0: 0, 1: 1, 2: 2, 3: 3, 4: 4}
        out = aligner.assign_times(cues, spans, ["body", "body"], mapping, self.words, 60.0)
        self.assertTrue(all(cue["start"] < cue["end"] for cue in out))
        self.assertTrue(all(a["end"] <= b["start"] for a, b in zip(out, out[1:])))
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_align_timings.py`
Expected: ERROR `has no attribute 'assign_times'`

- [ ] **Step 3: 实现**

```python
def _mapped_words(span, mapping, words) -> list[dict[str, Any]]:
    indexes = [mapping[index] for index in range(*span) if index in mapping]
    if not indexes:
        return []
    return [
        {"w": words[index]["w"], "s": words[index]["s"], "e": words[index]["e"]}
        for index in range(min(indexes), max(indexes) + 1)
    ]


def assign_times(cues, spans, decisions, mapping, words, total_seconds) -> list[dict[str, Any]]:
    """删掉 drop、给保留的 cue 定时：有词用词区间，没词的按连续空档均分。"""
    kept: list[dict[str, Any]] = []
    for cue, span, decision in zip(cues, spans, decisions):
        if decision == "drop":
            continue
        mapped = _mapped_words(span, mapping, words) if decision == "body" else []
        kept.append(
            {
                "start": mapped[0]["s"] if mapped else None,
                "end": mapped[-1]["e"] if mapped else None,
                "en": cue["en"],
                "zh": cue["zh"],
                "words": mapped,
            }
        )
    # 连续没定时的 cue 成段分配：左界=前一条已定时的 end（或 0），右界=后一条已定的 start（或总长）
    index = 0
    while index < len(kept):
        if kept[index]["start"] is not None:
            index += 1
            continue
        run_end = index
        while run_end < len(kept) and kept[run_end]["start"] is None:
            run_end += 1
        left = kept[index - 1]["end"] if index else 0.0
        right = kept[run_end]["start"] if run_end < len(kept) else total_seconds
        run = kept[index:run_end]
        total_chars = sum(len(item["en"]) for item in run) or 1
        cursor = left
        for item in run:
            share = len(item["en"]) / total_chars
            item["start"] = cursor
            item["end"] = cursor + max(0.05, (right - left) * share)
            cursor = item["end"]
        index = run_end
    previous_end = 0.0
    for entry in kept:
        entry["start"] = max(previous_end, float(entry["start"]))
        entry["end"] = max(entry["start"] + 0.05, float(entry["end"]))
        previous_end = entry["end"]
    return kept


- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_align_timings.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/align_timings.py tests/test_align_timings.py
git commit -m "feat: assign real word times to cues and drop ad blocks"
```

---

### Task 5: 单集编排（转写 → 映射 → 双文件重写 → sidecar）

**Files:**
- Modify: `scripts/align_timings.py`（新增 `rewrite_episode`，删除 `group_cues`/`window_for`/`cue_words`/`words_plausible`/`align_cues`/`align_episode_file`）
- Test: `tests/test_align_timings.py`

**Interfaces:**
- Consumes: Task 1–4 的全部函数、`transcribe.whisper_transcribe`、`transcribe.write_word_timings`、`transcribe.write_sidecar_failure`、`transcribe.sidecar_status`、`transcribe.sidecar_path_for`
- Produces:
  - `rewrite_episode(vtt_path, audio_url, model, *, workdir, download=None, transcribe_audio=None) -> str`
    返回 `"done" | "failed" | "rejected"`；成功时写双语 VTT、zh VTT（如存在）、sidecar。
  - `zh_vtt_path(vtt_path: Path) -> Path`（`<parent>/zh/<name>`）

- [ ] **Step 1: 写失败测试**

```python
VTT_SAMPLE = chr(10).join([
    "WEBVTT", "",
    "1", "00:00:01.000 --> 00:00:10.000", "Hello there friend", "你好朋友", "",
    "2", "00:00:10.000 --> 00:00:20.000", "Buy our sponsor now", "买我们的赞助", "",
    "3", "00:00:20.000 --> 00:00:30.000", "Back to the show", "回到节目", "",
])


class RewriteEpisodeTests(unittest.TestCase):
    def setUp(self):
        import transcribe as _t

        self.transcribe = _t
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.site = root / "site"
        self.dir = self.site / "pod" / "transcripts"
        self.dir.mkdir(parents=True)
        (self.dir / "zh").mkdir()
        self.vtt = self.dir / "Ep.vtt"
        self.vtt.write_text(VTT_SAMPLE, encoding="utf-8")
        self.zh = self.dir / "zh" / "Ep.vtt"
        self.zh.write_text(
            chr(10).join(["WEBVTT", "", "1", "00:00:01.000 --> 00:00:10.000", "你好朋友", "",
                          "2", "00:00:10.000 --> 00:00:20.000", "买我们的赞助", "",
                          "3", "00:00:20.000 --> 00:00:30.000", "回到节目", ""]),
            encoding="utf-8",
        )
        self.timing = self.site / "pod" / "timings"
        for patch_ in (
            mock.patch.object(self.transcribe, "TIMING_DIR", self.timing),
            mock.patch.object(self.transcribe, "SITE_DIR", self.site),
        ):
            patch_.start()
            self.addCleanup(patch_.stop)

    def fake_transcribe(self, path):
        words = [
            {"w": "Hello", "s": 1.0, "e": 1.4},
            {"w": "there", "s": 1.4, "e": 1.8},
            {"w": "friend", "s": 1.8, "e": 2.2},
            {"w": "Back", "s": 31.0, "e": 31.4},
            {"w": "to", "s": 31.4, "e": 31.6},
            {"w": "the", "s": 31.6, "e": 31.9},
            {"w": "show", "s": 31.9, "e": 32.3},
        ]
        return [{"start": 1.0, "end": 2.2, "en": "Hello there friend", "zh": "", "words": words[:3]},
                {"start": 31.0, "end": 32.3, "en": "Back to the show", "zh": "", "words": words[3:]}], 60.0

    def test_ad_block_is_dropped_from_both_vtts(self):
        status = aligner.rewrite_episode(
            self.vtt, "https://cdn.test/a.mp3", object(),
            workdir=Path(self.temp.name),
            download=lambda url, path: path.write_bytes(b"x"),
            transcribe_audio=self.fake_transcribe,
        )
        self.assertEqual(status, "done")
        en = self.vtt.read_text(encoding="utf-8")
        zh = self.zh.read_text(encoding="utf-8")
        self.assertNotIn("sponsor", en)
        self.assertNotIn("赞助", zh)
        self.assertEqual(en.count("-->"), 2)
        self.assertEqual(zh.count("-->"), 2)

    def test_remaining_cues_use_real_times(self):
        aligner.rewrite_episode(
            self.vtt, "https://cdn.test/a.mp3", object(),
            workdir=Path(self.temp.name),
            download=lambda url, path: path.write_bytes(b"x"),
            transcribe_audio=self.fake_transcribe,
        )
        cues = aligner.parse_bilingual_vtt(self.vtt)
        self.assertAlmostEqual(cues[0]["start"], 1.0)
        self.assertAlmostEqual(cues[-1]["start"], 31.0, places=1)
        self.assertEqual(cues[0]["zh"], "你好朋友", "中文文本保持不变")

    def test_sidecar_matches_rewritten_cues(self):
        aligner.rewrite_episode(
            self.vtt, "https://cdn.test/a.mp3", object(),
            workdir=Path(self.temp.name),
            download=lambda url, path: path.write_bytes(b"x"),
            transcribe_audio=self.fake_transcribe,
        )
        self.assertEqual(self.transcribe.sidecar_status(self.timing / "Ep.json"), (True, 1))
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_align_timings.py`
Expected: ERROR `has no attribute 'rewrite_episode'`

- [ ] **Step 3: 实现**

```python
def zh_vtt_path(vtt_path: Path) -> Path:
    return vtt_path.parent / "zh" / vtt_path.name


def rewrite_episode(
    vtt_path: Path,
    audio_url: str,
    model,
    *,
    workdir: Path,
    download=None,
    transcribe_audio=None,
) -> str:
    download = download or transcribe.download_audio
    transcribe_audio = transcribe_audio or transcribe.whisper_transcribe
    sidecar = transcribe.sidecar_path_for(vtt_path)
    audio_path = Path(workdir) / "episode.audio"
    try:
        cues = parse_bilingual_vtt(vtt_path)
        if not cues:
            raise RuntimeError("VTT 没有可用的双语块")
        download(audio_url, audio_path)
        our_cues, total = transcribe_audio(audio_path)
        raw_words = [word for cue in our_cues for word in cue.get("words") or []]
        # token 与 words 必须一一对应（_mapped_words 用下标取时间），所以先剔掉归一化后为空的词
        our_tokens, words = [], []
        for word in raw_words:
            token = re.sub(r"[^a-z0-9]", "", word["w"].lower())
            if token:
                our_tokens.append(token)
                words.append(word)
        tokens, spans = cue_token_spans(cues)
        mapping, similarity = map_stream(tokens, our_tokens)
        decisions = classify_cues(spans, mapping)
        reason = episode_rejection(decisions, similarity)
        if reason:
            print(f"{vtt_path.stem}: 整集放弃（{reason}）")
            transcribe.write_sidecar_failure(sidecar, transcribe.sidecar_status(sidecar)[1] + 1)
            return "rejected"
        kept = assign_times(cues, spans, decisions, mapping, words, total)
        en_text = render_vtt(kept)
        validate_vtt(en_text, blocks=len(kept), bilingual=True)
        zh_source = zh_vtt_path(vtt_path)
        zh_text = None
        if zh_source.exists():
            zh_cues = zh_blocks(zh_source)
            if len(zh_cues) != len(cues):
                raise RuntimeError("zh 字幕块数与双语版不一致")
            zh_text = render_zh_vtt(
                [zh_cues[i] for i, d in enumerate(decisions) if d != "drop"], kept
            )
            validate_vtt(zh_text, blocks=len(kept), bilingual=False)
    except Exception as exc:
        print(f"{vtt_path.stem}: 放弃 {exc}")
        transcribe.write_sidecar_failure(sidecar, transcribe.sidecar_status(sidecar)[1] + 1)
        return "failed"
    write_atomic(vtt_path, en_text)
    if zh_text is not None:
        write_atomic(zh_source, zh_text)
    transcribe.write_word_timings(kept, sidecar, total)
    print(
        f"{vtt_path.stem}: 相似度 {similarity:.3f}，正文 {decisions.count('body')}，"
        f"部分 {decisions.count('partial')}，删除 {decisions.count('drop')}"
    )
    return "done"
```

同文件补充两个小工具：

```python
def zh_blocks(path: Path) -> list[str]:
    """读取中文单语 VTT 的文本行（按块顺序）。"""
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    rows = []
    for block in re.split(r"\r?\n\r?\n", text):
        lines = [line.strip() for line in block.strip().split(chr(10)) if line.strip()]
        body = [line for line in lines if "-->" not in line and not line.isdigit()]
        if body:
            rows.append(body[0])
    return rows


def render_zh_vtt(zh_texts: list[str], kept: list[dict[str, Any]]) -> str:
    blocks = ["WEBVTT", ""]
    for index, (zh, cue) in enumerate(zip(zh_texts, kept), 1):
        blocks.extend(
            [
                str(index),
                f"{timestamp(cue['start'])} --> {timestamp(cue['end'])}",
                zh,
                "",
            ]
        )
    return chr(10).join(blocks).rstrip() + chr(10)


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_align_timings.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/align_timings.py tests/test_align_timings.py
git commit -m "feat: rewrite VTTs and sidecar from our own transcription"
```

---

### Task 6: 删除 v1 死代码

**Files:**
- Modify: `scripts/align_timings.py`、`tests/test_align_timings.py`

**Interfaces:** 无新增；删除 `group_cues`、`window_for`、`cue_span`、`cue_words`、`words_plausible`、`tokens_match`、`_merge_continuations`、`_normalize`、`align_cues`、`AudioMismatch`、`align_episode_file`、`log_summary` 及其测试类。

- [ ] **Step 1: 先跑一次全量测试记录基线**

Run: `python tests/test_align_timings.py`
Expected: `OK`（记录当前测试数）

- [ ] **Step 2: 删除函数与对应测试类**

```bash
python - <<'PY'
from pathlib import Path
import re

module = Path("scripts/align_timings.py")
text = module.read_text(encoding="utf-8")
for name in (
    "group_cues", "window_for", "cue_span", "cue_words", "words_plausible",
    "tokens_match", "_merge_continuations", "_normalize", "align_cues",
    "align_episode_file", "log_summary",
):
    pattern = re.compile(rf"\n\ndef {name}\(.*?(?=\n\ndef |\n\nclass |\Z)", re.S)
    text, count = pattern.subn("\n", text)
    assert count == 1, f"{name} 删除失败（{count}）"
text = text.replace("class AudioMismatch(RuntimeError):", "class _RemovedAudioMismatch(RuntimeError):")
module.write_text(text, encoding="utf-8")
print("dead code removed")
PY
```

测试文件里同步删除引用了这些函数的测试类（`WindowTests`、`PlausibilityTests`、`CueWordsTests`、`AlignCuesTests`、`AlignFileTests`、`DegreeenericWordTests`、`ParagraphCueTests`、`ToleranceTests`、`AnchorSlackTests`、`PerCueAlignTests`），保留 Task 1–5 新增的。

- [ ] **Step 3: 跑测试确认仍全绿**

Run: `python tests/test_align_timings.py`
Expected: `OK`（测试数变少，但无失败）

- [ ] **Step 4: 静态检查无残留引用**

Run: `python -c "import ast,pathlib; tree=ast.parse(pathlib.Path('scripts/align_timings.py').read_text(encoding='utf-8')); names=[n.name for n in ast.walk(tree) if isinstance(n,(ast.FunctionDef,ast.ClassDef))]; print(sorted(names))"`
Expected: 列表里不再出现被删的名字

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/align_timings.py tests/test_align_timings.py
git commit -m "refactor: drop the disproven anchor-window alignment code"
```

---

### Task 7: CLI 与执行器接上新的单集函数

**Files:**
- Modify: `scripts/align_timings.py`（`process_candidate`、`main`）
- Test: `tests/test_align_timings.py`

**Interfaces:**
- Consumes: `rewrite_episode`（Task 5）、`build_candidates`/`run_align`/`align_env`（v1 已有，保持不变）
- Produces: `process_candidate(item) -> str` 改为调用 `rewrite_episode`，返回 `"done" | "failed"`。

- [ ] **Step 1: 写失败测试**

```python
class ProcessCandidateTests(unittest.TestCase):
    def test_delegates_to_rewrite_episode(self):
        calls = []
        with mock.patch.object(aligner, "rewrite_episode", side_effect=lambda *a, **k: calls.append(a) or "done"), \
             mock.patch.object(aligner, "load_model", return_value=object()):
            status = aligner.process_candidate(
                {"vtt_path": Path("x.vtt"), "audio_url": "u"}
            )
        self.assertEqual(status, "done")
        self.assertEqual(len(calls), 1)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_align_timings.py`
Expected: FAIL（`process_candidate` 仍调用旧函数/签名）

- [ ] **Step 3: 实现**

```python
def process_candidate(item: dict[str, Any], model=None) -> str:
    model = model or load_model()
    with tempfile.TemporaryDirectory(prefix="align-audio-") as temp_dir:
        return rewrite_episode(
            item["vtt_path"], item["audio_url"], model, workdir=Path(temp_dir)
        )
```

`run_align` 的统计字典初始值改为 `{"done": 0, "rejected": 0, "failed": 0, "skipped": 0}`，
其余逻辑不动——它本来就按 `process` 返回的字符串累加，因此 `"rejected"` 会自然计数。

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_align_timings.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/align_timings.py tests/test_align_timings.py
git commit -m "feat: route the shard runner through the mapping rewrite"
```

---

### Task 8: CI 与依赖精简

**Files:**
- Modify: `requirements-align.txt`、`.github/workflows/align.yml`

**Interfaces:** 无代码接口；提交路径与依赖变化。

- [ ] **Step 1: 精简依赖**

```text
# 逐词对齐：转写与下载复用 transcribe 的依赖，另需 av 解码音频。
-r requirements-transcribe.txt
av==17.1.0
```
（stable-ts 与 torch 不再需要，安装体积从约 300 MB 降到约 30 MB。）

- [ ] **Step 2: 提交路径加入 zh 字幕**

```yaml
          bash scripts/git_push_retry.sh "auto: align word timings (${GITHUB_EVENT_NAME})" \
            site \
            ':(exclude)site/*/feed.xml' \
            ':(exclude)site/*/feed-zh.xml' \
            ':(exclude)site/*/index.html' \
            ':(exclude)site/index.html' \
            ':(exclude)site/podcasts.html' \
            ':(exclude)**/*.tmp' \
            ':(exclude)**/*.part'
```
（去掉原先 `site/*/transcripts/**` 的排除，因为现在**要**提交重写后的双语与 zh 字幕；其余站点文件仍排除。）

- [ ] **Step 3: 校验 YAML**

Run: `python -c "import yaml; yaml.safe_load(open('.github/workflows/align.yml', encoding='utf-8')); print('yaml ok')"`
Expected: `yaml ok`

- [ ] **Step 4: 全量测试**

Run: `python tests/test_align_timings.py` 与其余四个测试文件
Expected: 全部 `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add requirements-align.txt .github/workflows/align.yml
git commit -m "ci: commit rewritten subtitles and drop stable-ts from align deps"
```

---

### Task 9: 冒烟与放行（运维）

- [ ] **Step 1: 本地单集冒烟**：跑 `rewrite_episode` 于 speaking-of-psychology 那一集（音频已缓存在
  `C:/tmp/align_probe/episode.mp3`），把真实输出写到临时目录（不碰仓库）。
  Expected：日志 `相似度 0.95x，正文 N，部分 M，删除 K`；把 K 条被删 cue 的前 60 字符逐条打印，
  人工确认都是广告。
- [ ] **Step 2: 报告数字**：相似度、正文/部分/删除条数、sidecar 体积、单集耗时。
- [ ] **Step 3: 正式回填**：`ALIGN_MODE=latest`、`ALIGN_LATEST_PER_SHOW=20`、20 分片、150 分钟预算；
  每轮结束看 `timings/` 增量与被拒集的日志点名。
- [ ] **Step 4: 验收**：
  - 240 集 sidecar `complete` 全为真；正文 cue 覆盖 ≥95%；
  - 抽 3 集：被删 cue 全是广告；正文文本与改前逐字相同；cue 时间与音频对齐（≤0.5 秒）；
  - 抽 1 集在 AntennaPod 里确认字幕同步、无广告文本。

---

## Self-Review

- **Spec 覆盖**：锚点否证与回归依据（Spec §1–2，体现在 Task 6 删除）、管线（Task 5）、
  阈值与分流（Task 3，常量逐字一致）、短块保护与删除上限（Task 3）、整集守卫（Task 3）、
  VTT 重写与校验（Task 1/5）、双文件重写（Task 5）、sidecar 契约（Task 4/5）、
  提交边界（Task 8）、验收（Task 9）——逐条有任务。
- **占位符**：无 TBD；每个代码步骤都是可粘贴实现。
- **类型一致性**：`parse_bilingual_vtt` / `render_vtt` / `validate_vtt` / `normalize_tokens` /
  `cue_token_spans` / `map_stream` / `classify_cues` / `episode_rejection` / `assign_times` /
  `rewrite_episode` / `zh_vtt_path` / `process_candidate` 在后续任务中均按首次定义的名字与签名使用；
  `assign_times` 返回的 cue 形状 `{"start","end","en","zh","words"}` 同时满足 `render_vtt` 与
  `transcribe.write_word_timings` 的输入契约。
