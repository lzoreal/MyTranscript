# 中英双语词级 transcript 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每集产出一份中英双语词级 JSON：英文词时间来自 ASR，中文词时间由"小句对齐 + 句内按字分配"派生，低置信句子只保留句子级中文。

**Architecture:** 新增两个纯逻辑模块——`scripts/clause_translation.py`（结构化翻译的输出契约与机械校验）与 `scripts/zh_align.py`（中文分词、小句切分、句内分配、DTW 兜底、置信度）；两条翻译链路（`transcribe.py` 的 hwmym、`translate_vtt.py` 的 12 个抓取节目）都改成"小句级译文 + 校验 + 单句重试"，并把结果写进 sidecar v2。

**Tech Stack:** Python 3.11（CI）/ 3.10（本机）、google-genai（现有）、spaCy + `zh_core_web_sm`、sentence-transformers + `paraphrase-multilingual-MiniLM-L12-v2`（仅兜底用）。

**Spec:** `docs/superpowers/specs/2026-10-30-bilingual-word-transcripts-design.md`

## Global Constraints

- 翻译输出必须是 `{"index": N, "clauses": [{"en": "...", "zh": "..."}]}`；**`en` 拼接归一化后必须逐词等于原句**，否则该句判失败。
- 单句重试上限 **2 次**；仍失败 → 降级为单 clause（`coarse: true`），不失败整批。
- 中文词时间的兜底阈值：`|中文小句数 − 英文小句数| >= 3` 或"某小句分配时长/字数比偏离中位数 50%" → `zh_words` 置空。
- sidecar v2 字段：`version: 2`、`sentences[].{start,end,en,zh,coarse,words,zh_words}`；**旧的 `segments` 同时保留**一个版本周期。
- 不写 `state.json` / `feed.xml` / `index.html` / `progress.json`（除两条翻译链原本就写的缓存/状态）。
- 单元测试不联网、不加载嵌入模型：分词器与编码器全部注入。
- 提交策略：用户说"提交"才提交，不 push。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `scripts/clause_translation.py`（新） | 结构化翻译的 prompt/schema/解析/校验，纯函数 |
| `scripts/zh_align.py`（新） | 中文分词驱动的时间分配、DTW 兜底、置信度，纯函数（分词器/编码器注入） |
| `scripts/transcribe.py`（改） | hwmym 翻译改为 clauses；sidecar 写 v2 字段 |
| `scripts/translate_vtt.py`（改） | 抓取节目的翻译改成同一契约 |
| `tests/test_clause_translation.py`（新）、`tests/test_zh_align.py`（新） | 两个新模块的测试 |
| `requirements-transcribe.txt` / `requirements.txt`（改）、`.github/workflows/*.yml`（改） | 新依赖与模型缓存 |

---

### Task 1: 小句切分与按词数分配时间

**Files:**
- Create: `scripts/zh_align.py`
- Create: `tests/test_zh_align.py`

**Interfaces:**
- Produces:
  - `EN_END: tuple[str, ...]`、`ZH_END: tuple[str, ...]`
  - `en_clause_word_counts(tokens: list[str]) -> list[int]`
  - `allocate_spans(counts: list[int], start: float, end: float) -> list[tuple[float, float]]`

- [ ] **Step 1: 写失败测试**

```python
import importlib.util
import sys
import unittest
from pathlib import Path

MODULE = Path(__file__).parents[1] / "scripts" / "zh_align.py"
SPEC = importlib.util.spec_from_file_location("zh_align", MODULE)
zh = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(zh)


class ClauseSplitTests(unittest.TestCase):
    def test_counts_words_per_english_clause(self):
        tokens = ["spouse's", "most", "annoying", "habit,", "complaining", "can", "feel", "satisfying"]
        self.assertEqual(zh.en_clause_word_counts(tokens), [4, 4])

    def test_counts_trailing_clause_without_punctuation(self):
        self.assertEqual(zh.en_clause_word_counts(["a", "b", "c,"]), [3])

    def test_empty_tokens(self):
        self.assertEqual(zh.en_clause_word_counts([]), [])


class AllocateTests(unittest.TestCase):
    def test_splits_span_by_word_counts(self):
        spans = zh.allocate_spans([4, 4], 10.0, 18.0)
        self.assertAlmostEqual(spans[0][0], 10.0)
        self.assertAlmostEqual(spans[0][1], 14.0)
        self.assertAlmostEqual(spans[1][0], 14.0)
        self.assertAlmostEqual(spans[1][1], 18.0)

    def test_handles_zero_counts(self):
        spans = zh.allocate_spans([0, 3], 0.0, 3.0)
        self.assertAlmostEqual(spans[1][1], 3.0)
        self.assertLessEqual(spans[0][0], spans[0][1])

    def test_never_returns_inverted_spans(self):
        for span in zh.allocate_spans([1, 1, 1], 5.0, 5.0):
            self.assertLessEqual(span[0], span[1])
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_zh_align.py`
Expected: `FileNotFoundError`（模块不存在）

- [ ] **Step 3: 实现**

```python
"""中文词时间派生：小句对齐 + 句内按字分配 + DTW 兜底（分词器与编码器注入）。"""

from __future__ import annotations

from typing import Any, Callable

EN_END = (".", ",", "!", "?", ";", ":")
ZH_END = ("，", "。", "！", "？", "；", "：", "、", "…")


def en_clause_word_counts(tokens: list[str]) -> list[int]:
    counts: list[int] = []
    current = 0
    for token in tokens:
        current += 1
        if token.endswith(EN_END):
            counts.append(current)
            current = 0
    if current:
        counts.append(current)
    return counts


def allocate_spans(
    counts: list[int], start: float, end: float
) -> list[tuple[float, float]]:
    """按词数占比把一句的时间跨度切给小句；零词小句得到零宽区间。"""
    total = sum(counts)
    if not counts or total <= 0:
        return [(start, start) for _ in counts]
    spans, cursor = [], start
    for count in counts:
        piece = (end - start) * count / total
        spans.append((cursor, cursor + piece))
        cursor += piece
    return spans
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_zh_align.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/zh_align.py tests/test_zh_align.py
git commit -m "feat: split english clauses and allocate spans by word count"
```

---

### Task 2: 中文分词与句内按字分配

**Files:**
- Modify: `scripts/zh_align.py`
- Test: `tests/test_zh_align.py`

**Interfaces:**
- Consumes: `allocate_spans`（Task 1）
- Produces:
  - `segment_zh(text: str) -> list[str]`（模块级默认分词器，懒加载 spaCy；测试里可替换）
  - `split_zh_clauses(tokens: list[str]) -> list[list[str]]`
  - `distribute_clause(tokens: list[str], start: float, end: float) -> list[dict]`
  - `build_zh_words(clauses: list[dict], start: float, end: float, tokens_of: Callable) -> list[list]`

- [ ] **Step 1: 写失败测试**

```python
class SegmentTests(unittest.TestCase):
    def test_splits_into_clauses_by_chinese_punctuation(self):
        tokens = ["伴侣", "最", "烦人", "的", "习惯", "。", "抱怨", "让", "人", "满足", "。"]
        self.assertEqual(
            zh.split_zh_clauses(tokens),
            [["伴侣", "最", "烦人", "的", "习惯", "。"], ["抱怨", "让", "人", "满足", "。"]],
        )

    def test_distributes_by_character_share_and_skips_punctuation(self):
        words = zh.distribute_clause(["伴侣", "最", "烦人", "。"], 10.0, 16.0)
        self.assertEqual([w["w"] for w in words], ["伴侣", "最", "烦人"])
        self.assertAlmostEqual(words[0]["s"], 10.0)
        self.assertAlmostEqual(words[0]["d"], 3.0)   # 2/4 的比例
        self.assertAlmostEqual(words[-1]["e"], 16.0)

    def test_build_zh_words_walks_clauses_and_allocates_their_spans(self):
        clauses = [{"en": "spouse's most annoying habit,", "zh": "伴侣最烦人的习惯。"},
                   {"en": "complaining can feel satisfying.", "zh": "抱怨会让人满足。"}]
        tokens_of = {"伴侣最烦人的习惯。": ["伴侣", "最", "烦人", "的", "习惯", "。"],
                     "抱怨会让人满足。": ["抱怨", "会", "让", "人", "满足", "。"]}.get
        words = zh.build_zh_words(clauses, 10.0, 20.0, tokens_of)
        self.assertEqual(len(words), 9)
        self.assertAlmostEqual(words[0]["s"], 10.0)
        self.assertAlmostEqual(words[-1]["e"], 20.0)
        self.assertTrue(all(a["s"] <= b["s"] for a, b in zip(words, words[1:])))
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_zh_align.py`
Expected: ERROR `has no attribute 'split_zh_clauses'`

- [ ] **Step 3: 实现**

```python
_NLP = None


def segment_zh(text: str) -> list[str]:
    """默认分词器：spaCy 中文模型，懒加载；测试里可用任意 callable 替换。"""
    global _NLP
    if _NLP is None:
        import spacy

        _NLP = spacy.load("zh_core_web_sm")
    return [token.text for token in _NLP(text) if not token.is_space]


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
    """小句内按字符占比分配时间；标点不参与、也不占时间。"""
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


def build_zh_words(
    clauses: list[dict], start: float, end: float, tokens_of: Callable[[str], list[str]]
) -> list[list]:
    """clauses 已按顺序覆盖整句；按 en 词数分配小句跨度，再句内按字分配。"""
    counts = [len((clause.get("en") or "").split()) for clause in clauses]
    spans = allocate_spans(counts, start, end)
    out: list[list] = []
    for clause, (clause_start, clause_end) in zip(clauses, spans):
        tokens = tokens_of(clause.get("zh") or "")
        for word in distribute_clause(tokens, clause_start, clause_end):
            out.append([word["w"], int(round(word["s"] * 1000)), int(round(word["d"] * 1000))])
    return out
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_zh_align.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/zh_align.py tests/test_zh_align.py
git commit -m "feat: distribute chinese word times inside each clause"
```

---

### Task 3: 置信度与 DTW 兜底

**Files:**
- Modify: `scripts/zh_align.py`
- Test: `tests/test_zh_align.py`

**Interfaces:**
- Consumes: `split_zh_clauses`、`distribute_clause`（Task 2）
- Produces:
  - `MAX_CLAUSE_DELTA = 3`、`MAX_ALLOCATION_SKEW = 0.5`
  - `clauses_confident(en_counts: list[int], zh_clauses: list[list[str]]) -> bool`
  - `dtw_path(sim) -> list[tuple[int, int]]`（入参为二维 list 或 numpy 数组的相似度矩阵）
  - `fallback_zh_words(en_words: list[dict], zh_text: str, segment: Callable, encode: Callable, start: float, end: float) -> list[list]`

- [ ] **Step 1: 写失败测试**

```python
class ConfidenceTests(unittest.TestCase):
    def test_rejects_large_clause_count_delta(self):
        self.assertFalse(zh.clauses_confident([4, 4], [["甲"], ["乙"], ["丙"], ["丁"], ["戊"]]))

    def test_accepts_small_delta(self):
        self.assertTrue(zh.clauses_confident([4, 4], [["甲"], ["乙"], ["丙"]]))

    def test_rejects_skewed_allocation(self):
        # 手工构造：1 个字的小句拿到 5 秒，10 个字的小句只拿到 6 秒
        spans = [(0.0, 5.0), (5.0, 11.0)]
        self.assertFalse(
            zh.allocation_plausible(spans, [["一"], ["一二三四五六七八九十"]])
        )

    def test_accepts_proportional_allocation(self):
        spans = [(0.0, 1.0), (1.0, 11.0)]
        self.assertTrue(
            zh.allocation_plausible(spans, [["一"], ["一二三四五六七八九十"]])
        )


class DtwFallbackTests(unittest.TestCase):
    def test_dtw_prefers_the_diagonal_for_identical_signals(self):
        sim = [[1.0, 0.0], [0.0, 1.0]]
        self.assertEqual(zh.dtw_path(sim), [(0, 0), (1, 1)])

    def test_fallback_distributes_shared_clauses_without_overlap(self):
        en_words = [
            {"w": "a", "s": 0.0, "e": 1.0}, {"w": "b", "s": 1.0, "e": 2.0},
            {"w": "c", "s": 2.0, "e": 3.0}, {"w": "d", "s": 3.0, "e": 4.0},
        ]
        zh_text = "一二三，四五六。"
        encode = lambda texts: [[1.0, 0.0] if "a" in t or "一" in t else [0.0, 1.0] for t in texts]
        words = zh.fallback_zh_words(en_words, zh_text, lambda t: list(t), encode, 0.0, 4.0)
        self.assertGreaterEqual(len(words), 2)
        starts = [w[1] for w in words]
        self.assertEqual(starts, sorted(starts), "中文词时间必须单调")
        self.assertLessEqual(words[-1][1] + words[-1][2], 4001)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_zh_align.py`
Expected: ERROR `has no attribute 'clauses_confident'`

- [ ] **Step 3: 实现**

```python
MAX_CLAUSE_DELTA = 3
MAX_ALLOCATION_SKEW = 0.5


def clauses_confident(en_counts: list[int], zh_clauses: list[list[str]]) -> bool:
    return abs(len(zh_clauses) - len(en_counts)) < MAX_CLAUSE_DELTA


def allocation_plausible(
    spans: list[tuple[float, float]], zh_clauses: list[list[str]]
) -> bool:
    """每个小句分到的时长 / 字数占比，不能偏离中位数 50% 以上。"""
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


def fallback_zh_words(
    en_words: list[dict],
    zh_text: str,
    segment: Callable[[str], list[str]],
    encode: Callable[[list[str]], list[list[float]]],
    start: float,
    end: float,
) -> list[list]:
    """旧数据兜底：英文小句 ↔ 中文小句 单调 DTW，共享区间按字数切分。"""
    en_tokens = [word["w"] for word in en_words]
    en_counts = en_clause_word_counts(en_tokens)
    zh_tokens = segment(zh_text)
    zh_clauses = split_zh_clauses(zh_tokens)
    if not en_counts or not zh_clauses or not clauses_confident(en_counts, zh_clauses):
        return []

    en_clause_texts, en_clause_spans, cursor = [], [], 0
    for count in en_counts:
        chunk = en_words[cursor : cursor + count]
        cursor += count
        en_clause_texts.append(" ".join(word["w"] for word in chunk))
        en_clause_spans.append((chunk[0]["s"], chunk[-1]["e"]))

    zh_clause_texts = ["".join(clause) for clause in zh_clauses]
    embeddings = encode(en_clause_texts + zh_clause_texts)
    n = len(en_clause_texts)
    sim = [
        [sum(a * b for a, b in zip(embeddings[i], embeddings[n + j])) for j in range(len(zh_clauses))]
        for i in range(n)
    ]
    shared: dict[int, list[int]] = {}
    for en_i, zh_j in dtw_path(sim):
        shared.setdefault(en_i, []).append(zh_j)

    spans: dict[int, tuple[float, float]] = {}
    for en_i, zh_list in shared.items():
        zh_list = sorted(zh_list)
        clause_start, clause_end = en_clause_spans[en_i]
        weights = [
            max(1, sum(len(w) for w in zh_clauses[j] if w not in ZH_END)) for j in zh_list
        ]
        total = sum(weights) or 1
        cursor_time = clause_start
        for zh_j, weight in zip(zh_list, weights):
            piece = (clause_end - clause_start) * weight / total
            spans[zh_j] = (cursor_time, cursor_time + piece)
            cursor_time += piece

    ordered_spans = [spans[j] for j in sorted(spans)]
    ordered_clauses = [zh_clauses[j] for j in sorted(spans)]
    if not allocation_plausible(ordered_spans, ordered_clauses):
        return []

    out: list[list] = []
    for zh_j in sorted(spans):
        for word in distribute_clause(zh_clauses[zh_j], *spans[zh_j]):
            out.append([word["w"], int(round(word["s"] * 1000)), int(round(word["d"] * 1000))])
    return out
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_zh_align.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/zh_align.py tests/test_zh_align.py
git commit -m "feat: gate and fall back when chinese clauses disagree"
```

---

### Task 4: 结构化翻译的输出契约

**Files:**
- Create: `scripts/clause_translation.py`
- Create: `tests/test_clause_translation.py`

**Interfaces:**
- Produces:
  - `normalize_tokens(text: str) -> list[str]`
  - `validate_clauses(source: str, clauses: list[dict]) -> tuple[bool, str]`
  - `parse_clause_object(raw: str, sources: dict[int, str]) -> dict[int, dict]`
    每项 `{"zh": str, "clauses": list[dict], "coarse": bool}`
  - `build_clause_prompt(blocks) -> str`、`build_clause_schema(indices) -> dict`

- [ ] **Step 1: 写失败测试**

```python
class ValidateTests(unittest.TestCase):
    def test_accepts_a_faithful_split(self):
        ok, reason = clause_mod.validate_clauses(
            "But psychologists who study complaining say there's a right way.",
            [{"en": "But psychologists who study complaining say", "zh": "但研究抱怨的心理学家说"},
             {"en": "there's a right way.", "zh": "有正确的方法。"}],
        )
        self.assertTrue(ok, reason)

    def test_rejects_a_dropped_word(self):
        ok, _ = clause_mod.validate_clauses(
            "one two three",
            [{"en": "one three", "zh": "一三"}],
        )
        self.assertFalse(ok)

    def test_rejects_reordered_words(self):
        ok, _ = clause_mod.validate_clauses(
            "one two three",
            [{"en": "two one three", "zh": "二一三"}],
        )
        self.assertFalse(ok)

    def test_rejects_empty_clause_or_leading_punctuation(self):
        self.assertFalse(clause_mod.validate_clauses("a b", [{"en": "", "zh": "空"}])[0])
        self.assertFalse(
            clause_mod.validate_clauses("a b", [{"en": "a b", "zh": "，开头是标点"}])[0]
        )


class ParseTests(unittest.TestCase):
    def test_parses_and_joins_chinese(self):
        raw = json.dumps({"12": {"clauses": [{"en": "hi", "zh": "你好"},
                                             {"en": "there.", "zh": "那边。"}]}})
        got = clause_mod.parse_clause_object(raw, {12: "hi there."})
        self.assertEqual(got[12]["zh"], "你好那边。")
        self.assertFalse(got[12]["coarse"])

    def test_invalid_entry_becomes_coarse_on_retry(self):
        raw = json.dumps({"12": {"clauses": [{"en": "hi", "zh": "你好"}]}})
        got = clause_mod.parse_clause_object(raw, {12: "hi there."})
        self.assertNotIn(12, got, "校验失败必须留空，交给调用方重试")
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_clause_translation.py`
Expected: `FileNotFoundError`

- [ ] **Step 3: 实现**

```python
"""结构化翻译契约：小句级 en/zh 对，可机械校验。"""

from __future__ import annotations

import json
import re
from typing import Any

LEADING_PUNCT = tuple("，。！？；：、…,.!?;:")


def normalize_tokens(text: str) -> list[str]:
    cleaned = (re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff']", "", token.lower()) for token in (text or "").split())
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
    """按编号回收；校验不过的条目直接丢弃，由调用方重试。"""
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
        if not isinstance(clauses, list):
            continue
        ok, _reason = validate_clauses(source, clauses)
        if not ok:
            continue
        out[index] = {
            "zh": "".join((clause.get("zh") or "").strip() for clause in clauses),
            "clauses": clauses,
            "coarse": False,
        }
    return out


def build_clause_prompt(blocks) -> str:
    lines = [
        "Translate each block into Simplified Chinese, clause by clause.",
        "Return JSON: {\"<index>\": {\"clauses\": [{\"en\": ..., \"zh\": ...}]}}.",
        "Rules: (1) the concatenated en of all clauses must equal the source block word for word;",
        "(2) do not merge, split or omit clauses; (3) every clause needs both en and zh;",
        "(4) zh must not start with punctuation.",
    ]
    for index, cue in blocks:
        lines.append(f"[{index}] {cue['en']}")
    return "\n".join(lines)


def build_clause_schema(indices: list[int]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            str(index): {
                "type": "object",
                "properties": {
                    "clauses": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {"en": {"type": "string"}, "zh": {"type": "string"}},
                            "required": ["en", "zh"],
                        },
                    }
                },
                "required": ["clauses"],
            }
            for index in indices
        },
        "required": [str(index) for index in indices],
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_clause_translation.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/clause_translation.py tests/test_clause_translation.py
git commit -m "feat: add a mechanically verifiable clause translation contract"
```

---

### Task 5: hwmym 翻译链路接入 + sidecar v2

**Files:**
- Modify: `scripts/transcribe.py`
- Test: `tests/test_transcribe_utils.py`

**Interfaces:**
- Consumes: Task 1–4 的函数
- Produces:
  - `cue["clauses"]`（list）与 `cue["coarse"]`（bool）由翻译写入；
  - `write_word_timings(cues, output_path, audio_seconds, complete=True, attempts=1)` 额外输出 `version: 2` 与 `sentences`，同时保留 `segments`；
  - `zh_words_for(cue) -> list[list]`：优先用 clauses 走 `build_zh_words`，否则走兜底，失败返回 `[]`。

- [ ] **Step 1: 写失败测试**

```python
class BilingualSidecarTests(unittest.TestCase):
    def cue(self, start, end, en, zh, clauses=None):
        return {"start": start, "end": end, "en": en, "zh": zh,
                "clauses": clauses or [], "coarse": not clauses,
                "words": [{"w": w, "s": start + i * 0.3, "e": start + (i + 1) * 0.3}
                          for i, w in enumerate(en.split())]}

    def test_sidecar_v2_carries_both_languages(self):
        cue = self.cue(1.0, 2.0, "hello there", "你好 那边",
                       clauses=[{"en": "hello there", "zh": "你好那边"}])
        cues = [cue]
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "x.json"
            transcriber.write_word_timings(cues, path, 2.0)
            doc = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(doc["version"], 2)
        self.assertIn("segments", doc, "旧字段保留一个版本")
        sentence = doc["sentences"][0]
        self.assertEqual(sentence["zh"], "你好 那边")
        self.assertFalse(sentence["coarse"])
        self.assertTrue(sentence["zh_words"], "有 clauses 时必须派生中文词")

    def test_coarse_sentence_keeps_sentence_level_zh_only(self):
        cue = self.cue(1.0, 2.0, "hello there", "你好")
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "x.json"
            transcriber.write_word_timings([cue], path, 2.0)
            doc = json.loads(path.read_text(encoding="utf-8"))
        sentence = doc["sentences"][0]
        self.assertTrue(sentence["coarse"])
        self.assertEqual(sentence["zh_words"], [])
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_transcribe_utils.py`
Expected: FAIL（`version` / `sentences` 不存在）

- [ ] **Step 3: 实现要点**

在 `transcribe.py` 里：

```python
from clause_translation import build_clause_prompt, build_clause_schema, parse_clause_object
import zh_align
```

- `translate_batch_once` 改为返回 `dict[int, dict]`（`parse_clause_object` 的结果）；
- `translate_blocks` 的"只补缺失编号"逻辑不变——缺失集合就是校验失败/未返回的编号；
- `translate_cues_with_gemini` 回填：
  ```python
  for index, cue in enumerate(batch):
      entry = translated[index]
      cue["zh"] = entry["zh"]
      cue["clauses"] = entry["clauses"]
      cue["coarse"] = entry["coarse"]
  ```
- 新增 `zh_words_for(cue)`：有 `clauses` 时用 `zh_align.build_zh_words(clauses, start, end, zh_align.segment_zh)`；失败/`coarse` → `zh_align.fallback_zh_words(...)`（编码器用模块级懒加载的 MiniLM）；再失败 → `[]`；
- `write_word_timings` 在原有输出基础上追加：
  ```python
  document["version"] = 2
  document["sentences"] = [
      {
          "start": int(round(float(c["start"]) * 1000)),
          "end": int(round(float(c["end"]) * 1000)),
          "en": clean_text(c.get("en", "")),
          "zh": clean_text(c.get("zh", "")),
          "coarse": bool(c.get("coarse")),
          "words": segment["words"],
          "zh_words": zh_words_for(c),
      }
      for c, segment in zip(cues, document["segments"])
  ]
  ```

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_transcribe_utils.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/transcribe.py tests/test_transcribe_utils.py
git commit -m "feat: write bilingual word timings into the sidecar"
```

---

### Task 6: 抓取节目翻译链路接入

**Files:**
- Modify: `scripts/translate_vtt.py`
- Test: `tests/test_translate_vtt.py`

**Interfaces:**
- Consumes: 同 Task 5
- Produces: 译文缓存条目从字符串升级为 `{"zh": ..., "clauses": [...], "coarse": bool}`，读取兼容旧字符串（视为 coarse）。

- [ ] **Step 1: 写失败测试**

```python
class CacheCompatTests(unittest.TestCase):
    def test_old_string_cache_is_treated_as_coarse(self):
        entry = translator.normalize_cache_entry("旧译文")
        self.assertEqual(entry["zh"], "旧译文")
        self.assertTrue(entry["coarse"])
        self.assertEqual(entry["clauses"], [])

    def test_new_entry_round_trips(self):
        entry = translator.normalize_cache_entry(
            {"zh": "你好", "clauses": [{"en": "hi", "zh": "你好"}], "coarse": False}
        )
        self.assertFalse(entry["coarse"])
        self.assertEqual(entry["clauses"][0]["en"], "hi")
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_translate_vtt.py`
Expected: ERROR `has no attribute 'normalize_cache_entry'`

- [ ] **Step 3: 实现要点**

- 新增 `normalize_cache_entry(value)`；
- `build_prompt_json` / `build_response_schema` 换成 `clause_translation.build_clause_prompt` / `build_clause_schema`；
- 解析改用 `parse_clause_object`；缺失编号进重试；
- 写 VTT 时中文行 = `"".join(clause["zh"])`；缓存写结构化条目；
- 保持不变：`_rate_limit_wait`、`RETRY_COUNT`、`DailyLimitReached`、敏感内容重试。

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_translate_vtt.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/translate_vtt.py tests/test_translate_vtt.py
git commit -m "feat: use the clause contract for scraped-show translation"
```

---

### Task 7: CI 依赖与模型缓存

**Files:**
- Modify: `requirements-transcribe.txt`、`requirements.txt`、`.github/workflows/transcribe.yml`、`.github/workflows/translate.yml`

- [ ] **Step 1: 依赖**

```text
# requirements-transcribe.txt 追加
spacy
sentence-transformers
```

- [ ] **Step 2: 模型缓存步骤（两个 workflow 各加一段）**

```yaml
      - name: Cache zh models
        id: cache-zh
        uses: actions/cache@v4
        with:
          path: |
            ~/.cache/huggingface
            ${{ github.workspace }}/zh_model
          key: zh-models-v1

      - name: Download zh models (if cache miss)
        if: steps.cache-zh.outputs.cache-hit != 'true'
        run: |
          python -m spacy download zh_core_web_sm
          python - <<'PY'
          from sentence_transformers import SentenceTransformer
          SentenceTransformer("paraphrase-multilingual-MiniLM-L12-v2")
          print("zh models ready")
          PY
```

- [ ] **Step 3: 校验**

Run: `python -c "import yaml; yaml.safe_load(open('.github/workflows/transcribe.yml', encoding='utf-8')); yaml.safe_load(open('.github/workflows/translate.yml', encoding='utf-8')); print('yaml ok')"`
Expected: `yaml ok`

- [ ] **Step 4: 提交（等用户确认）**

```bash
git add requirements-transcribe.txt .github/workflows/transcribe.yml .github/workflows/translate.yml
git commit -m "ci: cache the chinese segmentation and embedding models"
```

---

### Task 8: 端到端冒烟与验收

- [ ] **Step 1: 单集冒烟**：用已缓存的音频与现有 VTT，跑 `rewrite_episode` + 新翻译路径（Gemini 真实调用）。
- [ ] **Step 2: 记录指标**：clauses 校验通过率、`coarse` 句占比、`zh_words` 为空的比例、抽样 20 个中文词的人工核对结果。
- [ ] **Step 3: 判定**：校验通过率 100%（失败已降级）、低置信句 < 10%、抽样偏差 ≤ 0.5 秒 → 写入交接文档并放行批量。

---

## Self-Review

- **Spec 覆盖**：翻译契约（Task 4）、校验与重试（Task 4/5/6）、中文词时间（Task 1/2）、兜底与置信度（Task 3）、sidecar v2（Task 5）、两条链路（Task 5/6）、依赖与 CI（Task 7）、验收（Task 8）。
- **占位符**：Task 5/6 的"实现要点"给出了目标代码与改动点；其余任务均为可粘贴实现。
- **类型一致性**：`allocate_spans` / `distribute_clause` / `build_zh_words` / `fallback_zh_words` / `validate_clauses` / `parse_clause_object` / `zh_words_for` 在后续任务中按首次定义使用；`clauses` 元素统一为 `{"en": str, "zh": str}`。
