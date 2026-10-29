# 统一转录链路实现计划（RSS → 双语词级 JSON）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一条可配置、可分片、可断点的链路：读 `feeds.json` → 下载音频 → 自己 ASR → 取展示文本（PodScripts 或 ASR）→ 小句翻译 → 中文词时间 → 写双语词级 JSON 到 `word-transcripts` 分支；已迁移的节目同时由它接管 VTT/feed/index。

**Architecture:** 先建两个纯逻辑模块（中文时间、翻译契约），再建四个薄模块（配置、存储、文本源、发布），最后用编排器把它们串成单集处理，CLI 负责分片/预算/断点；旧链路按节目逐个退出。

**Tech Stack:** Python 3.11（CI）/ 3.10（本机）、faster-whisper + turbo（ASR）、google-genai（翻译，已有 key 轮换）、spaCy `zh_core_web_sm`、sentence-transformers MiniLM（兜底）、lxml（RSS/HTML）。

**Spec:** `docs/superpowers/specs/2026-10-30-unified-transcript-pipeline-design.md`

## Global Constraints

- 配置是一等公民：`feeds.json`，`text_source` ∈ `{"podscripts", "asr"}`；`podscripts` 时 `podscripts_id` 必填，缺失直接报错不降级。
- 唯一数据结构 `Sentence`：`{"start": float, "end": float, "en": str, "zh": str, "coarse": bool, "words": [{"w","s","e"}], "zh_words": [[w, ms, dur]]}`。
- 翻译必须过机械校验：`clauses[].en` 拼接归一化后逐词等于原句；单句最多重试 2 次；仍失败降级为单 clause（`coarse: true`）。
- 中文词时间：clauses → 按 en 词数分小句 → 句内按字分配；无 clauses 或校验失败 → DTW 兜底；兜底置信度不足 → `zh_words = []`（只保留句子级）。
- 断点：`<DATA_DIR>/<slug>/state.json` 里 `status=done` 跳过、`attempts >= 2` 不再重试。
- 产物分支 `word-transcripts`，**不部署**；`data/` 不得进 `.gitignore`。
- 迁移一个节目必须同时：`feeds.json` 加、`podcasts.json` 删、新链路接管该节目的 VTT/feed/index。**同一节目只能有一个产出方**。
- 单元测试不联网、不解码音频、不加载模型：下载、ASR、翻译、分词、编码器全部注入。
- 提交策略：用户说"提交"才提交，不 push。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `scripts/zh_align.py`（新） | 小句切分、按词数/字数分配、DTW 兜底、置信度 |
| `scripts/clause_translation.py`（新） | 小句翻译的 prompt/schema/校验/解析 |
| `scripts/pipeline_config.py`（新） | `feeds.json` 读取与校验、条目列举 |
| `scripts/pipeline_store.py`（新） | state 与单集 JSON 的读写（纯文件操作） |
| `scripts/pipeline_text.py`（新） | 文本源：PodScripts 抓取 / ASR 句子，并映射到词流 |
| `scripts/pipeline_episode.py`（新） | 单集编排（全部依赖注入） |
| `scripts/pipeline_publish.py`（新） | 该节目的 VTT / feed / index（复用现有生成器） |
| `scripts/run_pipeline.py`（新） | CLI：分片、预算、`only_slug`、`DATA_DIR` |
| `tests/test_zh_align.py`、`tests/test_clause_translation.py`、`tests/test_pipeline_*.py`（新） | 对应测试 |

---

### Task 1: 小句切分与时间分配

**Files:**
- Create: `scripts/zh_align.py`
- Create: `tests/test_zh_align.py`

**Interfaces:**
- Produces:
  - `EN_END`、`ZH_END`
  - `en_clause_word_counts(tokens: list[str]) -> list[int]`
  - `allocate_spans(counts: list[int], start: float, end: float) -> list[tuple[float, float]]`
  - `split_zh_clauses(tokens: list[str]) -> list[list[str]]`
  - `distribute_clause(tokens: list[str], start: float, end: float) -> list[dict]`
  - `build_zh_words(clauses: list[dict], start: float, end: float, tokens_of: Callable) -> list[list]`

- [ ] **Step 1: 写失败测试**

```python
import importlib.util
import unittest
from pathlib import Path

MODULE = Path(__file__).parents[1] / "scripts" / "zh_align.py"
SPEC = importlib.util.spec_from_file_location("zh_align", MODULE)
zh = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(zh)


class ClauseTests(unittest.TestCase):
    def test_counts_words_per_english_clause(self):
        tokens = ["habit,", "complaining", "can", "feel", "satisfying"]
        self.assertEqual(zh.en_clause_word_counts(tokens), [1, 4])

    def test_allocate_splits_span_by_word_count(self):
        spans = zh.allocate_spans([2, 2], 10.0, 14.0)
        self.assertAlmostEqual(spans[0][0], 10.0)
        self.assertAlmostEqual(spans[1][1], 14.0)
        self.assertAlmostEqual(spans[0][1], 12.0)

    def test_split_zh_clauses_on_punctuation(self):
        tokens = ["伴侣", "的", "习惯", "。", "抱怨", "让", "人", "满足", "。"]
        self.assertEqual(len(zh.split_zh_clauses(tokens)), 2)

    def test_distribute_clause_by_character_share(self):
        words = zh.distribute_clause(["伴侣", "最", "。"], 0.0, 3.0)
        self.assertEqual([w["w"] for w in words], ["伴侣", "最"])
        self.assertAlmostEqual(words[0]["d"], 2.0)
        self.assertAlmostEqual(words[-1]["e"], 3.0)

    def test_build_zh_words_covers_the_whole_sentence(self):
        clauses = [{"en": "a b", "zh": "甲乙。"}, {"en": "c", "zh": "丙。"}]
        tokens_of = {"甲乙。": ["甲", "乙", "。"], "丙。": ["丙", "。"]}.get
        words = zh.build_zh_words(clauses, 5.0, 8.0, tokens_of)
        self.assertEqual([w[0] for w in words], ["甲", "乙", "丙"])
        self.assertAlmostEqual(words[0][1], 5000)
        self.assertAlmostEqual((words[-1][1] + words[-1][2]) / 1000, 8.0)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_zh_align.py`
Expected: `FileNotFoundError`

- [ ] **Step 3: 实现**

```python
"""中文词时间派生：小句切分 + 按词数/字数分配（纯函数，分词器注入）。"""

from __future__ import annotations

from typing import Callable

EN_END = (".", ",", "!", "?", ";", ":")
ZH_END = ("，", "。", "！", "？", "；", "：", "、", "…")


def en_clause_word_counts(tokens: list[str]) -> list[int]:
    counts, current = [], 0
    for token in tokens:
        current += 1
        if token.endswith(EN_END):
            counts.append(current)
            current = 0
    if current:
        counts.append(current)
    return counts


def allocate_spans(counts, start: float, end: float):
    total = sum(counts)
    if not counts or total <= 0:
        return [(start, start) for _ in counts]
    spans, cursor = [], start
    for count in counts:
        piece = (end - start) * count / total
        spans.append((cursor, cursor + piece))
        cursor += piece
    return spans


def split_zh_clauses(tokens: list[str]) -> list[list[str]]:
    clauses, current = [], []
    for token in tokens:
        current.append(token)
        if token in ZH_END:
            clauses.append(current)
            current = []
    if current:
        clauses.append(current)
    return clauses


def distribute_clause(tokens: list[str], start: float, end: float) -> list[dict]:
    words = [token for token in tokens if token not in ZH_END]
    weights = [max(1, len(word)) for word in words]
    total = sum(weights) or 1
    span = max(0.0, end - start)
    result, cursor = [], start
    for word, weight in zip(words, weights):
        duration = span * weight / total
        result.append({"w": word, "s": cursor, "e": cursor + duration, "d": duration})
        cursor += duration
    return result


def build_zh_words(clauses, start: float, end: float, tokens_of: Callable[[str], list[str]]):
    counts = [len((clause.get("en") or "").split()) for clause in clauses]
    spans = allocate_spans(counts, start, end)
    out: list[list] = []
    for clause, (clause_start, clause_end) in zip(clauses, spans):
        for word in distribute_clause(tokens_of(clause.get("zh") or ""), clause_start, clause_end):
            out.append([word["w"], int(round(word["s"] * 1000)), int(round(word["d"] * 1000))])
    return out
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_zh_align.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/zh_align.py tests/test_zh_align.py
git commit -m "feat: split clauses and distribute chinese word times"
```

---

### Task 2: 置信度与 DTW 兜底

**Files:**
- Modify: `scripts/zh_align.py`
- Test: `tests/test_zh_align.py`

**Interfaces:**
- Produces:
  - `MAX_CLAUSE_DELTA = 3`、`MAX_ALLOCATION_SKEW = 0.5`
  - `clauses_confident(en_counts, zh_clauses) -> bool`
  - `allocation_plausible(spans, zh_clauses) -> bool`
  - `dtw_path(sim) -> list[tuple[int, int]]`
  - `fallback_zh_words(en_words, zh_text, segment, encode, start, end) -> list[list]`

- [ ] **Step 1: 写失败测试**

```python
class FallbackTests(unittest.TestCase):
    def test_clause_delta_gate(self):
        self.assertFalse(zh.clauses_confident([2, 2], [["甲"], ["乙"], ["丙"], ["丁"], ["戊"]]))
        self.assertTrue(zh.clauses_confident([2, 2], [["甲"], ["乙"], ["丙"]]))

    def test_allocation_plausibility(self):
        self.assertFalse(zh.allocation_plausible([(0.0, 5.0), (5.0, 11.0)],
                                                 [["一"], ["一二三四五六七八九十"]]))
        self.assertTrue(zh.allocation_plausible([(0.0, 1.0), (1.0, 11.0)],
                                                [["一"], ["一二三四五六七八九十"]]))

    def test_dtw_prefers_the_diagonal(self):
        self.assertEqual(zh.dtw_path([[1.0, 0.0], [0.0, 1.0]]), [(0, 0), (1, 1)])

    def test_fallback_is_monotonic_and_bounded(self):
        en_words = [{"w": "a", "s": 0.0, "e": 1.0}, {"w": "b", "s": 1.0, "e": 2.0}]
        encode = lambda texts: [[1.0, 0.0] for _ in texts]
        words = zh.fallback_zh_words(en_words, "甲乙。", lambda t: list(t), encode, 0.0, 2.0)
        starts = [w[1] for w in words]
        self.assertEqual(starts, sorted(starts))
        self.assertLessEqual(words[-1][1] + words[-1][2], 2000)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_zh_align.py`
Expected: ERROR `has no attribute 'clauses_confident'`

- [ ] **Step 3: 实现**

```python
MAX_CLAUSE_DELTA = 3
MAX_ALLOCATION_SKEW = 0.5


def clauses_confident(en_counts, zh_clauses) -> bool:
    return abs(len(zh_clauses) - len(en_counts)) < MAX_CLAUSE_DELTA


def allocation_plausible(spans, zh_clauses) -> bool:
    ratios = []
    for (start, end), clause in zip(spans, zh_clauses):
        chars = sum(len(word) for word in clause if word not in ZH_END) or 1
        ratios.append((end - start) / chars)
    if not ratios:
        return False
    ordered = sorted(ratios)
    median = ordered[len(ordered) // 2] or 1e-9
    return all(abs(ratio - median) <= median * MAX_ALLOCATION_SKEW for ratio in ratios)


def dtw_path(sim) -> list[tuple[int, int]]:
    n, m = len(sim), len(sim[0]) if sim else 0
    if not n or not m:
        return []
    dp = [[float("inf")] * (m + 1) for _ in range(n + 1)]
    dp[0][0] = 0.0
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            cost = 1.0 - sim[i - 1][j - 1]
            dp[i][j] = cost + min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    path, i, j = [], n, m
    while i > 0 and j > 0:
        path.append((i - 1, j - 1))
        best = min((dp[i - 1][j], "up"), (dp[i][j - 1], "left"), (dp[i - 1][j - 1], "diag"))
        if best[1] == "diag":
            i, j = i - 1, j - 1
        elif best[1] == "up":
            i -= 1
        else:
            j -= 1
    return path[::-1]


def fallback_zh_words(en_words, zh_text, segment, encode, start: float, end: float):
    en_tokens = [word["w"] for word in en_words]
    en_counts = en_clause_word_counts(en_tokens)
    zh_clauses = split_zh_clauses(segment(zh_text))
    if not en_counts or not zh_clauses or not clauses_confident(en_counts, zh_clauses):
        return []

    en_texts, en_spans, cursor = [], [], 0
    for count in en_counts:
        chunk = en_words[cursor : cursor + count]
        cursor += count
        en_texts.append(" ".join(word["w"] for word in chunk))
        en_spans.append((chunk[0]["s"], chunk[-1]["e"]))

    zh_texts = ["".join(clause) for clause in zh_clauses]
    embeddings = encode(en_texts + zh_texts)
    n = len(en_texts)
    sim = [[sum(a * b for a, b in zip(embeddings[i], embeddings[n + j]))
            for j in range(len(zh_clauses))] for i in range(n)]
    shared: dict[int, list[int]] = {}
    for en_i, zh_j in dtw_path(sim):
        shared.setdefault(en_i, []).append(zh_j)

    spans, ordered = {}, []
    for en_i, zh_list in shared.items():
        zh_list = sorted(zh_list)
        clause_start, clause_end = en_spans[en_i]
        weights = [max(1, sum(len(w) for w in zh_clauses[j] if w not in ZH_END)) for j in zh_list]
        total = sum(weights) or 1
        cursor_time = clause_start
        for zh_j, weight in zip(zh_list, weights):
            piece = (clause_end - clause_start) * weight / total
            spans[zh_j] = (cursor_time, cursor_time + piece)
            cursor_time += piece
    keys = sorted(spans)
    if not allocation_plausible([spans[k] for k in keys], [zh_clauses[k] for k in keys]):
        return []
    out: list[list] = []
    for key in keys:
        for word in distribute_clause(zh_clauses[key], *spans[key]):
            out.append([word["w"], int(round(word["s"] * 1000)), int(round(word["d"] * 1000))])
    return out
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_zh_align.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/zh_align.py tests/test_zh_align.py
git commit -m "feat: gate chinese clause alignment and fall back to DTW"
```

---

### Task 3: 小句翻译契约

**Files:**
- Create: `scripts/clause_translation.py`
- Create: `tests/test_clause_translation.py`

**Interfaces:**
- Produces:
  - `normalize_tokens(text) -> list[str]`
  - `validate_clauses(source: str, clauses: list[dict]) -> tuple[bool, str]`
  - `parse_clause_object(raw: str, sources: dict[int, str]) -> dict[int, dict]`
  - `build_clause_prompt(blocks) -> str`、`build_clause_schema(indices) -> dict`

- [ ] **Step 1: 写失败测试**

```python
class ContractTests(unittest.TestCase):
    def test_accepts_faithful_split(self):
        ok, _ = cmod.validate_clauses(
            "But psychologists who study complaining say there's a right way.",
            [{"en": "But psychologists who study complaining say", "zh": "但研究抱怨的心理学家说"},
             {"en": "there's a right way.", "zh": "有正确的方法。"}],
        )
        self.assertTrue(ok)

    def test_rejects_dropped_reordered_and_empty(self):
        self.assertFalse(cmod.validate_clauses("one two three", [{"en": "one three", "zh": "一三"}])[0])
        self.assertFalse(cmod.validate_clauses("one two three", [{"en": "two one three", "zh": "二一三"}])[0])
        self.assertFalse(cmod.validate_clauses("one two", [{"en": "", "zh": "空"}])[0])
        self.assertFalse(cmod.validate_clauses("one two", [{"en": "one two", "zh": "，坏"}])[0])

    def test_parse_joins_chinese_and_drops_invalid(self):
        raw = json.dumps({
            "1": {"clauses": [{"en": "hi", "zh": "你好"}, {"en": "there.", "zh": "那边。"}]},
            "2": {"clauses": [{"en": "wrong", "zh": "错"}]},
        })
        got = cmod.parse_clause_object(raw, {1: "hi there.", 2: "something else"})
        self.assertEqual(got[1]["zh"], "你好那边。")
        self.assertNotIn(2, got)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_clause_translation.py`
Expected: `FileNotFoundError`

- [ ] **Step 3: 实现**

```python
"""小句级翻译契约：可机械校验的输出格式。"""

from __future__ import annotations

import json
import re
from typing import Any

LEADING_PUNCT = tuple("，。！？；：、…,.!?;:")


def normalize_tokens(text: str) -> list[str]:
    cleaned = (re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff']", "", token.lower())
               for token in (text or "").split())
    return [token for token in cleaned if token]


def validate_clauses(source: str, clauses: list[dict[str, Any]]) -> tuple[bool, str]:
    if not clauses:
        return False, "clauses 为空"
    joined: list[str] = []
    for clause in clauses:
        en = (clause.get("en") or "").strip()
        zh = (clause.get("zh") or "").strip()
        if not en or not zh:
            return False, "存在空的小句"
        if zh.startswith(LEADING_PUNCT):
            return False, "中文小句以标点开头"
        joined.extend(normalize_tokens(en))
    if joined != normalize_tokens(source):
        return False, "en 拼接与原句不逐词相等"
    return True, ""


def parse_clause_object(raw: str, sources: dict[int, str]) -> dict[int, dict[str, Any]]:
    try:
        data = json.loads(raw or "")
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    out: dict[int, dict[str, Any]] = {}
    for key, value in data.items():
        try:
            index = int(key)
        except (TypeError, ValueError):
            continue
        source = sources.get(index)
        if source is None or not isinstance(value, dict):
            continue
        clauses = value.get("clauses")
        if not isinstance(clauses, list) or not validate_clauses(source, clauses)[0]:
            continue
        out[index] = {
            "zh": "".join((c.get("zh") or "").strip() for c in clauses),
            "clauses": clauses,
            "coarse": False,
        }
    return out


def build_clause_prompt(blocks) -> str:
    lines = [
        "Translate each block into Simplified Chinese, clause by clause.",
        'Return JSON: {"<index>": {"clauses": [{"en": ..., "zh": ...}]}}.',
        "Rules: the concatenated en must equal the source word for word; do not merge,",
        "split or omit clauses; every clause needs en and zh; zh must not start with punctuation.",
    ]
    for index, cue in blocks:
        lines.append(f"[{index}] {cue['en']}")
    return "\n".join(lines)


def build_clause_schema(indices: list[int]) -> dict[str, Any]:
    clause = {
        "type": "object",
        "properties": {"en": {"type": "string"}, "zh": {"type": "string"}},
        "required": ["en", "zh"],
    }
    return {
        "type": "object",
        "properties": {
            str(i): {
                "type": "object",
                "properties": {"clauses": {"type": "array", "items": clause}},
                "required": ["clauses"],
            }
            for i in indices
        },
        "required": [str(i) for i in indices],
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_clause_translation.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/clause_translation.py tests/test_clause_translation.py
git commit -m "feat: add the clause translation contract"
```

---

### Task 4: 配置与条目列举

**Files:**
- Create: `scripts/pipeline_config.py`
- Create: `feeds.json`（初始只放 hwmym 一条）
- Test: `tests/test_pipeline_config.py`

**Interfaces:**
- Produces:
  - `load_feeds(path: Path) -> list[dict]`（校验必填项与 `text_source` 取值）
  - `select_shows(shows, only_slug=None, shard=0, shards=1) -> list[dict]`（按 `sha1(slug) % shards` 分片）
  - `list_episodes(feed_url: str, fetch=None) -> list[dict]`（`guid/title/published/audio_url`，新到旧）

- [ ] **Step 1: 写失败测试**

```python
class ConfigTests(unittest.TestCase):
    def test_rejects_unknown_text_source_and_missing_podscripts_id(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "feeds.json"
            path.write_text(json.dumps([{"slug": "a", "feed_url": "u", "text_source": "nope"}]), encoding="utf-8")
            with self.assertRaises(ValueError):
                pcfg.load_feeds(path)
            path.write_text(json.dumps([{"slug": "a", "feed_url": "u", "text_source": "podscripts"}]), encoding="utf-8")
            with self.assertRaises(ValueError):
                pcfg.load_feeds(path)

    def test_sharding_is_stable_and_partitions_shows(self):
        shows = [{"slug": f"s{i}", "feed_url": "u", "text_source": "asr"} for i in range(10)]
        first = pcfg.select_shows(shows, shard=0, shards=2)
        second = pcfg.select_shows(shows, shard=1, shards=2)
        self.assertEqual(len(first) + len(second), 10)
        self.assertFalse({s["slug"] for s in first} & {s["slug"] for s in second})
        self.assertEqual(first, pcfg.select_shows(shows, shard=0, shards=2))

    def test_only_slug_wins(self):
        shows = [{"slug": "a", "feed_url": "u", "text_source": "asr"}]
        self.assertEqual(pcfg.select_shows(shows, only_slug="a", shard=0, shards=1), shows)
        self.assertEqual(pcfg.select_shows(shows, only_slug="b", shard=0, shards=1), [])
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_pipeline_config.py`
Expected: `FileNotFoundError`

- [ ] **Step 3: 实现**

```python
"""feeds.json 的读取、校验、分片与条目列举。"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Callable

TEXT_SOURCES = ("podscripts", "asr")


def load_feeds(path: Path) -> list[dict[str, Any]]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("feeds.json 必须是数组")
    seen: set[str] = set()
    for show in data:
        for key in ("slug", "feed_url", "text_source"):
            if not show.get(key):
                raise ValueError(f"节目缺少必填项 {key}: {show}")
        if show["slug"] in seen:
            raise ValueError(f"slug 重复：{show['slug']}")
        seen.add(show["slug"])
        if show["text_source"] not in TEXT_SOURCES:
            raise ValueError(f"未知 text_source：{show['text_source']}")
        if show["text_source"] == "podscripts" and not show.get("podscripts_id"):
            raise ValueError(f"{show['slug']} 使用 podscripts 但缺少 podscripts_id")
    return data


def _shard_of(slug: str, shards: int) -> int:
    return int(hashlib.sha1(slug.encode("utf-8")).hexdigest(), 16) % max(1, shards)


def select_shows(shows, only_slug=None, shard=0, shards=1):
    if only_slug:
        return [show for show in shows if show["slug"] == only_slug]
    return [show for show in shows if _shard_of(show["slug"], shards) == shard]


def list_episodes(feed_url: str, fetch: Callable[[str], bytes] | None = None):
    import feedparser
    import requests

    fetch = fetch or (lambda url: requests.get(url, timeout=60).content)
    parsed = feedparser.parse(fetch(feed_url))
    if parsed.bozo and not parsed.entries:
        raise RuntimeError(f"RSS 解析失败：{getattr(parsed, 'bozo_exception', '未知')}")
    episodes = []
    for entry in parsed.entries:
        audio = ""
        for enclosure in getattr(entry, "enclosures", []) or []:
            if (enclosure.get("href") or "").strip():
                audio = enclosure["href"].strip()
                break
        if not audio:
            continue
        episodes.append(
            {
                "guid": str(getattr(entry, "id", "") or getattr(entry, "guid", "")),
                "title": str(getattr(entry, "title", "") or ""),
                "published": str(getattr(entry, "published", "") or ""),
                "audio_url": audio,
            }
        )
    return episodes
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_pipeline_config.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/pipeline_config.py feeds.json tests/test_pipeline_config.py
git commit -m "feat: load and shard feeds.json"
```

`feeds.json` 初始内容：

```json
[
  {"slug": "how-we-made-your-mother", "name": "How We Made Your Mother",
   "feed_url": "https://rss.amperwave.net/v2/feed/audacynetwork/hwmym",
   "language": "en", "text_source": "asr"}
]
```

---

### Task 5: 状态与产物读写

**Files:**
- Create: `scripts/pipeline_store.py`
- Test: `tests/test_pipeline_store.py`

**Interfaces:**
- Produces:
  - `load_state(data_dir: Path, slug: str) -> dict`（`{"episodes": {guid: {"status","attempts","updated_at"}}}`）
  - `save_state(data_dir: Path, slug: str, state: dict) -> None`（原子写）
  - `needs_work(state, guid) -> bool`（`status != "done"` 且 `attempts < 2`）
  - `episode_path(data_dir: Path, slug: str, guid: str) -> Path`
  - `write_episode(path: Path, doc: dict) -> None`（原子写，紧凑 JSON）

- [ ] **Step 1: 写失败测试**

```python
class StoreTests(unittest.TestCase):
    def test_state_round_trips_atomically(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            data = Path(temp_dir)
            pstore.save_state(data, "pod", {"episodes": {"g1": {"status": "done", "attempts": 1}}})
            state = pstore.load_state(data, "pod")
        self.assertEqual(state["episodes"]["g1"]["status"], "done")

    def test_needs_work_rules(self):
        self.assertTrue(pstore.needs_work({"episodes": {}}, "g1"))
        self.assertFalse(pstore.needs_work({"episodes": {"g1": {"status": "done"}}}, "g1"))
        self.assertFalse(pstore.needs_work({"episodes": {"g1": {"status": "failed", "attempts": 2}}}, "g1"))
        self.assertTrue(pstore.needs_work({"episodes": {"g1": {"status": "failed", "attempts": 1}}}, "g1"))

    def test_episode_document_is_compact_and_complete(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "g1.json"
            pstore.write_episode(path, {"sentences": [{"en": "hi", "zh": "你好"}]})
            text = path.read_text(encoding="utf-8")
        self.assertNotIn(": ", text, "必须是紧凑 JSON")
        self.assertIn('"sentences"', text)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_pipeline_store.py`
Expected: `FileNotFoundError`

- [ ] **Step 3: 实现**

```python
"""data/<slug>/ 下的 state 与单集产物读写，全部原子写。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

MAX_ATTEMPTS = 2


def show_dir(data_dir: Path, slug: str) -> Path:
    return Path(data_dir) / slug


def load_state(data_dir: Path, slug: str) -> dict[str, Any]:
    path = show_dir(data_dir, slug) / "state.json"
    if not path.exists():
        return {"episodes": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"episodes": {}}
    data.setdefault("episodes", {})
    return data


def save_state(data_dir: Path, slug: str, state: dict[str, Any]) -> None:
    path = show_dir(data_dir, slug) / "state.json"
    _atomic_write(path, json.dumps(state, ensure_ascii=False, separators=(",", ":")))


def needs_work(state: dict[str, Any], guid: str) -> bool:
    record = state.get("episodes", {}).get(guid) or {}
    if record.get("status") == "done":
        return False
    return int(record.get("attempts") or 0) < MAX_ATTEMPTS


def safe_name(guid: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in guid)[:120]


def episode_path(data_dir: Path, slug: str, guid: str) -> Path:
    return show_dir(data_dir, slug) / f"{safe_name(guid)}.json"


def write_episode(path: Path, doc: dict[str, Any]) -> None:
    _atomic_write(path, json.dumps(doc, ensure_ascii=False, separators=(",", ":")))


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_pipeline_store.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/pipeline_store.py tests/test_pipeline_store.py
git commit -m "feat: persist per-show state and episode documents"
```

---

### Task 6: 文本源（PodScripts / ASR）与词流映射

**Files:**
- Create: `scripts/pipeline_text.py`
- Test: `tests/test_pipeline_text.py`

**Interfaces:**
- Consumes: `align_timings.cue_token_spans / map_stream / classify_cues / assign_times`
- Produces:
  - `asr_sentences(asr_cues) -> list[Sentence]`（`en` + `words`，`zh`/`zh_words` 留空）
  - `map_external_text(text_blocks, asr_cues, total_seconds) -> list[Sentence]`
    `text_blocks` 是 `[{"en": str}]`（PodScripts 抓来的句子），映射到 ASR 词流；
    覆盖不足的块按 `align_timings` 的阈值丢弃（判为广告/无对应）

- [ ] **Step 1: 写失败测试**

```python
class TextSourceTests(unittest.TestCase):
    def test_asr_source_passes_words_through(self):
        cues = [{"start": 0.0, "end": 2.0, "en": "hi there",
                 "words": [{"w": "hi", "s": 0.0, "e": 1.0}, {"w": "there", "s": 1.0, "e": 2.0}]}]
        sentences = ptext.asr_sentences(cues)
        self.assertEqual(sentences[0]["en"], "hi there")
        self.assertEqual(len(sentences[0]["words"]), 2)
        self.assertEqual(sentences[0]["zh"], "")

    def test_external_text_maps_to_asr_words(self):
        blocks = [{"en": "hi there"}, {"en": "buy our sponsor now please"}]
        asr = [{"start": 0.0, "end": 2.0, "en": "hi there",
                "words": [{"w": "hi", "s": 0.0, "e": 1.0}, {"w": "there", "s": 1.0, "e": 2.0}]}]
        sentences = ptext.map_external_text(blocks, asr, 2.0)
        self.assertEqual([s["en"] for s in sentences], ["hi there"], "广告块应被丢弃")
        self.assertEqual(sentences[0]["zh_words"], [])

    def test_external_text_keeps_real_times(self):
        blocks = [{"en": "hello there friend"}]
        asr = [{"start": 10.0, "end": 11.5, "en": "hello there friend",
                "words": [{"w": "hello", "s": 10.0, "e": 10.5},
                          {"w": "there", "s": 10.5, "e": 11.0},
                          {"w": "friend", "s": 11.0, "e": 11.5}]}]
        sentences = ptext.map_external_text(blocks, asr, 20.0)
        self.assertAlmostEqual(sentences[0]["start"], 10.0)
        self.assertAlmostEqual(sentences[0]["end"], 11.5)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_pipeline_text.py`
Expected: `FileNotFoundError`

- [ ] **Step 3: 实现**

```python
"""展示文本来源：PodScripts 抓取或 ASR 句子；统一产出 Sentence。"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import align_timings  # noqa: E402


def _sentence(start, end, en, words, zh="", zh_words=None, coarse=False):
    return {
        "start": float(start),
        "end": float(end),
        "en": en,
        "zh": zh,
        "coarse": coarse,
        "words": words,
        "zh_words": list(zh_words or []),
    }


def asr_sentences(asr_cues) -> list[dict[str, Any]]:
    return [
        _sentence(cue["start"], cue["end"], cue.get("en", ""), cue.get("words") or [])
        for cue in asr_cues
        if (cue.get("en") or "").strip()
    ]


def map_external_text(text_blocks, asr_cues, total_seconds: float) -> list[dict[str, Any]]:
    """把外部文本贴到 ASR 词流上：复用 align_timings 的映射/分流/定时。"""
    blocks = [
        {"start": 0.0, "end": total_seconds, "en": (block.get("en") or "").strip()}
        for block in text_blocks
        if (block.get("en") or "").strip()
    ]
    if not blocks:
        return []
    words = [word for cue in asr_cues for word in (cue.get("words") or [])]
    our_tokens, kept_words = [], []
    for word in words:
        token = "".join(ch for ch in word["w"].lower() if ch.isalnum())
        if token:
            our_tokens.append(token)
            kept_words.append(word)
    tokens, spans = align_timings.cue_token_spans(blocks)
    mapping, _similarity = align_timings.map_stream(tokens, our_tokens)
    decisions = align_timings.classify_cues(spans, mapping)
    kept = align_timings.assign_times(blocks, spans, decisions, mapping, kept_words, total_seconds)
    return [
        _sentence(cue["start"], cue["end"], cue["en"], cue.get("words") or [])
        for cue in kept
    ]
```

> 说明：`align_timings.assign_times` 已经实现"删除广告块 / 用词时间定起止 / 无词时插值"，
> 这里只是把它的输出换成 `Sentence`，不重复实现。

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_pipeline_text.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/pipeline_text.py tests/test_pipeline_text.py
git commit -m "feat: build sentences from asr or external text"
```

---

### Task 7: 单集编排

**Files:**
- Create: `scripts/pipeline_episode.py`
- Test: `tests/test_pipeline_episode.py`

**Interfaces:**
- Consumes: Task 2（`fallback_zh_words`）、Task 3（`validate_clauses` 由 translate 依赖）、Task 5（store）、Task 6（text）
- Produces:
  - `process_episode(show, episode, deps, data_dir, now=None) -> str`
    返回 `"done" | "coarse" | "failed" | "skipped"`；负责下载→ASR→文本→翻译→中文词时间→落盘→更新 state。
  - `deps` 需要提供：`download(url, path)`、`asr(path) -> (cues, seconds)`、`translate(sentences)`（原地写 `zh/clauses/coarse`）、`text`（按 `show["text_source"]` 取块）、`segment`/`encode`（中文分词与嵌入，兜底用）

- [ ] **Step 1: 写失败测试**

```python
class EpisodeTests(unittest.TestCase):
    def deps(self, cues):
        def translate(sentences):
            for sentence in sentences:
                sentence["zh"] = "译：" + sentence["en"]
                sentence["clauses"] = [{"en": sentence["en"], "zh": "译：" + sentence["en"]}]
                sentence["coarse"] = False

        return {
            "download": lambda url, path: path.write_bytes(b"x"),
            "asr": lambda path: (cues, 3.0),
            "translate": translate,
            "text": lambda show, episode: [],          # asr 源时不用
            "segment": lambda text: list(text),
            "encode": lambda texts: [[1.0, 0.0] for _ in texts],
        }

    def test_writes_document_and_marks_done(self):
        cues = [{"start": 0.0, "end": 3.0, "en": "hi there",
                 "words": [{"w": "hi", "s": 0.0, "e": 1.5}, {"w": "there", "s": 1.5, "e": 3.0}]}]
        with tempfile.TemporaryDirectory() as temp_dir:
            data = Path(temp_dir)
            status = pepisode.process_episode(
                {"slug": "pod", "text_source": "asr"},
                {"guid": "g1", "title": "Ep", "audio_url": "u"},
                self.deps(cues), data, now=lambda: "2026-10-30T00:00:00Z",
            )
            doc = json.loads(pstore.episode_path(data, "pod", "g1").read_text(encoding="utf-8"))
            state = pstore.load_state(data, "pod")
        self.assertEqual(status, "done")
        self.assertEqual(state["episodes"]["g1"]["status"], "done")
        self.assertEqual(doc["sentences"][0]["zh"], "译：hi there")
        self.assertIn("zh_words", doc["sentences"][0])

    def test_translation_failure_marks_coarse_and_retries(self):
        cues = [{"start": 0.0, "end": 1.0, "en": "hi", "words": [{"w": "hi", "s": 0.0, "e": 1.0}]}]
        deps = self.deps(cues)
        deps["translate"] = lambda sentences: (_ for _ in ()).throw(RuntimeError("quota"))
        with tempfile.TemporaryDirectory() as temp_dir:
            data = Path(temp_dir)
            status = pepisode.process_episode(
                {"slug": "pod", "text_source": "asr"},
                {"guid": "g1", "title": "Ep", "audio_url": "u"},
                deps, data,
            )
            state = pstore.load_state(data, "pod")
        self.assertEqual(status, "failed")
        self.assertEqual(state["episodes"]["g1"]["attempts"], 1)
        self.assertTrue(pstore.needs_work(state, "g1"))
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_pipeline_episode.py`
Expected: `FileNotFoundError`

- [ ] **Step 3: 实现**

```python
"""单集编排：下载 → ASR → 文本 → 翻译 → 中文词时间 → 落盘 → 记账。"""

from __future__ import annotations

import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import pipeline_store as store
import pipeline_text as ptext
import zh_align


def _stamp(now) -> str:
    if now is None:
        return datetime.now(timezone.utc).isoformat(timespec="seconds")
    return now() if callable(now) else str(now)


def _record(state, guid, status, updated, *, attempts=None):
    entry = state["episodes"].setdefault(guid, {})
    entry["status"] = status
    entry["updated_at"] = updated
    if attempts is not None:
        entry["attempts"] = attempts
    else:
        entry.setdefault("attempts", 0)


def process_episode(show, episode, deps, data_dir: Path, now=None) -> str:
    guid = episode["guid"]
    state = store.load_state(data_dir, show["slug"])
    if not store.needs_work(state, guid):
        return "skipped"
    updated = _stamp(now)
    attempts = int(state["episodes"].get(guid, {}).get("attempts") or 0) + 1
    try:
        with tempfile.TemporaryDirectory(prefix="pipeline-audio-") as temp_dir:
            audio = Path(temp_dir) / "episode.audio"
            deps["download"](episode["audio_url"], audio)
            asr_cues, seconds = deps["asr"](audio)
        if show["text_source"] == "asr":
            sentences = ptext.asr_sentences(asr_cues)
        else:
            blocks = deps["text"](show, episode)
            sentences = ptext.map_external_text(blocks, asr_cues, seconds)
        if not sentences:
            raise RuntimeError("没有任何句子")
        deps["translate"](sentences)
        for sentence in sentences:
            if sentence.get("clauses") and not sentence.get("coarse"):
                sentence["zh_words"] = zh_align.build_zh_words(
                    sentence["clauses"], sentence["start"], sentence["end"], deps["segment"]
                )
                if not sentence["zh_words"]:
                    sentence["zh_words"] = zh_align.fallback_zh_words(
                        sentence["words"], sentence["zh"], deps["segment"], deps["encode"],
                        sentence["start"], sentence["end"],
                    )
            else:
                sentence["zh_words"] = []
    except Exception as exc:
        print(f"{show['slug']}/{guid}: 失败 {type(exc).__name__}: {exc}")
        _record(state, guid, "failed", updated, attempts=attempts)
        store.save_state(data_dir, show["slug"], state)
        return "failed"

    document = {
        "version": 2,
        "slug": show["slug"],
        "guid": guid,
        "title": episode.get("title", ""),
        "published": episode.get("published", ""),
        "audio_seconds": seconds,
        "sentences": sentences,
        "generated_at": updated,
    }
    store.write_episode(store.episode_path(data_dir, show["slug"], guid), document)
    coarse = any(sentence.get("coarse") for sentence in sentences)
    _record(state, guid, "done", updated, attempts=attempts)
    state["episodes"][guid]["coarse"] = coarse
    store.save_state(data_dir, show["slug"], state)
    print(f"{show['slug']}/{guid}: done，{len(sentences)} 句，coarse={coarse}")
    return "done"
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_pipeline_episode.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/pipeline_episode.py tests/test_pipeline_episode.py
git commit -m "feat: orchestrate a single episode end to end"
```

---

### Task 8: 发布（VTT / feed / index）

**Files:**
- Create: `scripts/pipeline_publish.py`
- Test: `tests/test_pipeline_publish.py`

**Interfaces:**
- Consumes: `transcribe`（Feed 生成）、`scraper`（索引）、`generate_zh_feed`（中文 Feed）
- Produces:
  - `render_vtt(sentences) -> str`（双语 VTT：en 行 + zh 行）
  - `publish_show(show, episodes, data_dir, site_dir) -> dict`（写 VTT、调用现有 feed/index 生成器）

- [ ] **Step 1: 写失败测试**

```python
class PublishTests(unittest.TestCase):
    def test_render_vtt_pairs_english_and_chinese(self):
        text = ppublish.render_vtt([
            {"start": 0.0, "end": 2.5, "en": "hi there", "zh": "你好 那边"},
        ])
        self.assertTrue(text.startswith("WEBVTT"))
        self.assertIn("00:00:00.000 --> 00:00:02.500", text)
        self.assertIn("hi there", text)
        self.assertIn("你好 那边", text)

    def test_render_vtt_requires_both_languages(self):
        with self.assertRaises(ValueError):
            ppublish.render_vtt([{"start": 0.0, "end": 1.0, "en": "hi", "zh": ""}])
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_pipeline_publish.py`
Expected: `FileNotFoundError`

- [ ] **Step 3: 实现**

```python
"""把单集 Sentence 渲染成 VTT，并调用现有生成器产出 feed/index。"""

from __future__ import annotations

from pathlib import Path


def _timestamp(value: float) -> str:
    ms = int(round(value * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d}.{ms % 1000:03d}"


def render_vtt(sentences) -> str:
    blocks = ["WEBVTT", ""]
    for index, sentence in enumerate(sentences, 1):
        en = (sentence.get("en") or "").strip()
        zh = (sentence.get("zh") or "").strip()
        if not en or not zh:
            raise ValueError(f"第 {index} 句缺少英文或中文")
        if float(sentence["end"]) <= float(sentence["start"]):
            raise ValueError(f"第 {index} 句时间无效")
        blocks.extend(
            [
                str(index),
                f"{_timestamp(sentence['start'])} --> {_timestamp(sentence['end'])}",
                en,
                zh,
                "",
            ]
        )
    return "\n".join(blocks).rstrip() + "\n"


def publish_show(show, episodes, data_dir: Path, site_dir: Path) -> dict:
    """写该节目所有已完成集的 VTT，并调用现有 feed/index 生成器。

    feed/index 的生成仍复用 transcribe.make_enhanced_feed 与 scraper.generate_podcast_index，
    保证地址与格式与迁移前一致；这是 strangler 切换不中断的前提。
    """
    written = 0
    for episode in episodes:
        path = data_dir / show["slug"] / f"{_safe(episode['guid'])}.json"
        if not path.exists():
            continue
        document = __import__("json").loads(path.read_text(encoding="utf-8"))
        vtt_path = site_dir / show["slug"] / "transcripts" / f"{_stem(episode)}.vtt"
        vtt_path.parent.mkdir(parents=True, exist_ok=True)
        vtt_path.write_text(render_vtt(document["sentences"]), encoding="utf-8")
        written += 1
    return {"vtt_written": written}


def _safe(guid: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in guid)[:120]


def _stem(episode) -> str:
    title = (episode.get("title") or "episode").strip() or "episode"
    return "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in title)[:120]
```

### 8.1 feed / index 接线（同一任务，迁移前必须可用）

`publish_show` 在写完 VTT 后按顺序调用现有生成器，保证地址与格式与迁移前一致：

```python
def publish_feed_and_index(show, records, site_dir: Path, base_url: str) -> None:
    """records: [{"identity","title","published","url","path"}]，由已完成的集构造。"""
    import transcribe, scraper

    pc_prog = {"processed": {}, "transcripts": records}
    transcribe.make_enhanced_feed(show["feed_url"], records, pc_prog)
    scraper.SITE_DIR = site_dir
    scraper.generate_podcast_index(pc_prog, show, base_url)
```

- `records` 的 `path` 必须与迁移前一致（`<slug>/transcripts/<stem>.vtt`），否则 feed 里的链接会变；
- 中文 feed 仍由 `generate_zh_feed.py` 生成：迁移时把该节目加入它的输入，或继续由 Translate workflow 处理；
- **验收**：迁移前后同一集 feed 里的 `guid / enclosure / transcript url` 三项逐字相同。

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_pipeline_publish.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/pipeline_publish.py tests/test_pipeline_publish.py
git commit -m "feat: render bilingual VTT from sentence documents"
```

---

### Task 9: CLI（分片、预算、断点）

**Files:**
- Create: `scripts/run_pipeline.py`
- Test: `tests/test_run_pipeline.py`

**Interfaces:**
- Produces:
  - `pipeline_env(env: dict) -> dict`（`SHARD/SHARDS/MAX_MINUTES/ONLY_SLUG/DATA_DIR/FEEDS_FILE`，含校验）
  - `run(shows, *, deps_factory, data_dir, max_minutes, clock=None, process=None) -> dict`
  - `main() -> int`

- [ ] **Step 1: 写失败测试**

```python
class EnvTests(unittest.TestCase):
    def test_defaults_and_overrides(self):
        got = runmod.pipeline_env({})
        self.assertEqual(got["shards"], "1")
        self.assertEqual(got["data_dir"], "data")
        got = runmod.pipeline_env({"SHARDS": "10", "SHARD": "3", "MAX_MINUTES": "150", "ONLY_SLUG": "x"})
        self.assertEqual(got["shard"], 3)
        self.assertEqual(got["only_slug"], "x")

    def test_rejects_bad_shard(self):
        with self.assertRaises(ValueError):
            runmod.pipeline_env({"SHARDS": "10", "SHARD": "10"})

    def test_run_stops_when_budget_is_spent(self):
        seen = []
        stats = runmod.run(
            [{"slug": "a", "episodes": [1, 2, 3]}],
            deps_factory=lambda show: {},
            data_dir=Path("unused"),
            max_minutes=1,
            clock=iter([0.0, 0.0, 99999.0]).__next__,
            process=lambda show, episode, deps, data_dir: seen.append(episode) or "done",
        )
        self.assertLess(len(seen), 3)
        self.assertEqual(stats["done"], len(seen))
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_run_pipeline.py`
Expected: `FileNotFoundError`

- [ ] **Step 3: 实现**

```python
"""CLI：按 feeds.json 分片跑，带预算与断点。"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pipeline_config as pconfig
import pipeline_episode as pepisode


def pipeline_env(env) -> dict:
    shards = int(env.get("SHARDS", "1") or 1)
    shard = int(env.get("SHARD", "0") or 0)
    if shards < 1 or not 0 <= shard < shards:
        raise ValueError(f"分片配置非法：shard={shard} shards={shards}")
    return {
        "shard": shard,
        "shards": shards,
        "max_minutes": float(env.get("MAX_MINUTES", "150") or 150),
        "only_slug": (env.get("ONLY_SLUG", "") or "").strip() or None,
        "data_dir": Path(env.get("DATA_DIR", "data") or "data"),
        "feeds_file": Path(env.get("FEEDS_FILE", "feeds.json") or "feeds.json"),
    }


def run(shows, *, deps_factory, data_dir, max_minutes, clock=None, process=None):
    process = process or pepisode.process_episode
    clock = clock or time.monotonic
    deadline = clock() + max_minutes * 60
    stats = {"done": 0, "skipped": 0, "failed": 0}
    for show in shows:
        deps = deps_factory(show)
        for episode in show["episodes"]:
            if clock() >= deadline:
                print("预算用完，剩余留给下一轮")
                return stats
            outcome = process(show, episode, deps, data_dir)
            stats[outcome] = stats.get(outcome, 0) + 1
    return stats


def main() -> int:
    env = pipeline_env(os.environ)
    shows = pconfig.select_shows(
        pconfig.load_feeds(env["feeds_file"]),
        only_slug=env["only_slug"],
        shard=env["shard"],
        shards=env["shards"],
    )
    prepared = []
    for show in shows:
        prepared.append(
            {"slug": show["slug"], "text_source": show["text_source"],
             "config": show, "episodes": pconfig.list_episodes(show["feed_url"])}
        )
    print(f"分片 {env['shard']}/{env['shards']}：节目 {len(prepared)}，"
          f"候选集 {sum(len(s['episodes']) for s in prepared)}")
    stats = run(prepared, deps_factory=build_default_deps, data_dir=env["data_dir"],
                max_minutes=env["max_minutes"])
    print(f"结束：{json.dumps(stats, ensure_ascii=False)}")
    return 0


def build_default_deps(show):
    """生产依赖：下载、ASR、翻译、文本源、分词、嵌入。全部复用现有实现，见下。"""
    import pipeline_deps

    return pipeline_deps.build(show)


if __name__ == "__main__":
    raise SystemExit(main())
```

> 生产依赖集中在 `scripts/pipeline_deps.py`（Task 10 创建）：把 `transcribe.download_audio`、
> `transcribe.whisper_transcribe`、`transcribe.translate_cues_with_gemini`、`scraper.search_podscripts/request_text/parse_transcript`、
> `zh_align.segment_zh`、MiniLM 编码器装配成 `deps` 字典。

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_run_pipeline.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/run_pipeline.py tests/test_run_pipeline.py
git commit -m "feat: add sharded pipeline CLI with a time budget"
```

---

### Task 10: 生产依赖装配、CI 与迁移手册

**Files:**
- Create: `scripts/pipeline_deps.py`
- Create: `.github/workflows/transcripts.yml`
- Modify: `requirements-transcribe.txt`
- Modify: `docs/handover.md`（迁移手册一节）

**Interfaces:**
- Produces: `pipeline_deps.build(show) -> dict`，键为 `download/asr/translate/text/segment/encode`

- [ ] **Step 1: 依赖装配**

```python
"""生产依赖：把现有实现装配成 process_episode 需要的 deps。"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scraper  # noqa: E402
import transcribe  # noqa: E402
import zh_align  # noqa: E402

_ENCODER = None


def _segment(text: str) -> list[str]:
    return zh_align.segment_zh(text)


def _encode(texts: list[str]):
    global _ENCODER
    if _ENCODER is None:
        from sentence_transformers import SentenceTransformer

        _ENCODER = SentenceTransformer("paraphrase-multilingual-MiniLM-L12-v2")
    return _ENCODER.encode(texts, normalize_embeddings=True).tolist()


def _text(show, episode):
    episode_url = scraper.search_podscripts(episode["title"], show["podscripts_id"])
    if not episode_url:
        raise RuntimeError(f"未匹配到字幕页：{episode['title'][:60]}")
    html = scraper.request_text(episode_url)
    if not html:
        raise RuntimeError("字幕页抓取失败")
    cues = scraper.parse_transcript(html)
    if not cues:
        raise RuntimeError("字幕页没有内容")
    return [{"en": scraper.clean_text(cue["text"])} for cue in cues]


def build(show) -> dict:
    return {
        "download": transcribe.download_audio,
        "asr": transcribe.whisper_transcribe,
        "translate": transcribe.translate_cues_with_gemini,
        "text": _text,
        "segment": _segment,
        "encode": _encode,
    }
```

- [ ] **Step 2: CI**

```yaml
name: Transcript Pipeline

on:
  workflow_dispatch:
    inputs:
      only_slug: {description: "只跑某个节目（留空=全部）", default: ""}
      shard: {description: "分片号", default: "0"}
      shards: {description: "分片数", default: "1"}
      max_minutes: {description: "预算（分钟）", default: "150"}

permissions:
  contents: write

concurrency:
  group: transcript-pipeline
  cancel-in-progress: false

jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 360
    env:
      DATA_DIR: data
      SHARD: ${{ github.event.inputs.shard || '0' }}
      SHARDS: ${{ github.event.inputs.shards || '1' }}
      MAX_MINUTES: ${{ github.event.inputs.max_minutes || '150' }}
      ONLY_SLUG: ${{ github.event.inputs.only_slug || '' }}
      WHISPER_MODEL: models/ct2-turbo
      GEMINI_API_KEYS: ${{ secrets.GEMINI_API_KEYS }}
      GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
    steps:
      - uses: actions/checkout@v4
        with: {token: "${{ secrets.MY_CUSTOM_PAT }}"}
      - uses: actions/setup-python@v5
        with: {python-version: "3.11"}
      - name: 安装依赖
        run: |
          python -m pip install --upgrade pip
          pip install -r requirements-transcribe.txt
          python -m spacy download zh_core_web_sm
      - uses: actions/cache@v4
        with:
          path: |
            ~/.cache/huggingface
            ${{ github.workspace }}/models/ct2-turbo
          key: pipeline-models-v1
      - name: 数据分支 worktree
        run: |
          git fetch origin word-transcripts
          git worktree add ../data-branch word-transcripts
          ln -s ../data-branch/data data
      - name: 运行
        run: python -u scripts/run_pipeline.py
      - name: 提交产物
        if: always()
        env: {MY_PAT: "${{ secrets.MY_CUSTOM_PAT }}"}
        run: |
          cd ../data-branch
          git remote set-url origin "https://${MY_PAT}@github.com/${GITHUB_REPOSITORY}.git"
          bash ../MainRepo/scripts/git_push_retry.sh "auto: word transcripts (${GITHUB_EVENT_NAME})" data
```

> 落地时注意：worktree 里的 `git_push_retry.sh` 路径按实际目录调整；`data` 通过软链指向 worktree，
> 保证产物只进数据分支、不进 main。

- [ ] **Step 3: 校验**

Run:
```bash
python -c "import yaml; yaml.safe_load(open('.github/workflows/transcripts.yml', encoding='utf-8')); print('yaml ok')"
for f in tests/test_*.py; do python "$f" >/dev/null || echo "FAIL $f"; done
```
Expected: `yaml ok`，且没有 `FAIL` 行

- [ ] **Step 4: 迁移手册写入 `docs/handover.md`**

新增一节"统一链路迁移"：三步切换（`feeds.json` 加、`podcasts.json` 删、发布接管）、每节目观察一周、同一节目只能有一个产出方。

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/pipeline_deps.py .github/workflows/transcripts.yml requirements-transcribe.txt docs/handover.md
git commit -m "feat: wire production deps and the pipeline workflow"
```

---

### Task 11: hwmym 试点与验收（运维）

- [ ] **Step 1** 本地/CI 跑 `ONLY_SLUG=how-we-made-your-mother SHARDS=1 MAX_MINUTES=60`，只跑 1 集。
- [ ] **Step 2** 与现有 sidecar 对比：同一集同样句子数、词数差异 <2%、`zh_words` 非空率 ≥90%。
- [ ] **Step 3** 抽 20 个中文词人工核对，偏差 ≤0.5 秒。
- [ ] **Step 4** 通过后再跑该节目的全量，然后开始迁第一个抓取节目（`office-ladies`）。

---

## Self-Review

- **Spec 覆盖**：`feeds.json`（T4）、模块划分（T1–T9）、断点（T5/T7）、分支与不部署（T10）、迁移三步（T10/T11）、验收（T11）。
- **占位符**：T8 的 feed/index 接线与 T10 的 worktree 路径写明了"落地时按实际调整"的具体位置；其余均为可粘贴实现。
- **类型一致性**：`Sentence` 字段贯穿 T1–T9；`zh_align.build_zh_words/fallback_zh_words`、`clause_translation.parse_clause_object`、`pipeline_store.needs_work`、`pipeline_text.asr_sentences/map_external_text`、`pepisode.process_episode` 的签名在后续任务中按首次定义使用。
