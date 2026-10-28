# 抓取节目词级时间戳（移植 TMLT 对齐）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 12 个抓取节目也产出 `site/<slug>/timings/<vtt 同名>.json` 逐词时间轴，覆盖每节目最近 20 集 + 之后滚动新集。

**Architecture:** 新增 `scripts/align_timings.py`：把 PodScripts 的 VTT 按 cue 起点分组（≤900 字符 / ≤100 秒），切出带 ±3 秒余量的音频窗口，用 `stable_whisper` 的 turbo 模型做文本↔音频对齐，逐句做合理性检查后写出与 hwmym 同构的 sidecar；边角料（sidecar 读写、断点、分片、下载、代理）全部复用 `transcribe.py` 已验证的实现。

**Tech Stack:** Python 3.11（CI）/ 3.10（本机）、stable-ts 2.19.1、faster-whisper + CTranslate2 turbo（int8）、av、lxml、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-10-29-scraped-shows-word-timestamps-design.md`

## Global Constraints

- **不改 VTT**：只写 sidecar；VTT 一个字节都不动。
- **sidecar 结构与 hwmym 完全一致**：`{episode, audio_seconds, complete, attempts, segments:[{start,end,speaker,text,words:[[词,起始ms,时长ms]]}]}`，紧凑 JSON；不新增字段。
- **断点 = sidecar**：`complete:true` 跳过；`attempts >= 2`（`transcribe.BACKFILL_MAX_ATTEMPTS`）不再重试。
- **整集守卫**：全集中位首词偏移 `|median| > 3.0` 秒 ⇒ 写 `complete:false`、`attempts+1`、不写词；**不做全局平移校正**。
- **窗口上界不能用 `cue.end`**（实测普遍少报 ~18 秒）：用 `cue_span` 按文本长度估算。
- 只提交 `site/*/timings`；不得写 `state.json` / `feed.xml` / `index.html` / `progress.json`。
- 单元测试不联网、不解码音频：模型、下载、解码全部注入。
- CI 用 Python **3.11**；本机跑测试用系统 `python`（3.14），跑 stable-ts 用 `C:\Users\游梦\AppData\Local\Programs\Python\Python310\python.exe`。
- 提交策略：用户说"提交"才提交，不 push。

---

### Task 1: VTT 解析与 cue 分组

**Files:**
- Create: `scripts/align_timings.py`
- Create: `tests/test_align_timings.py`

**Interfaces:**
- Consumes: 无（纯函数）
- Produces:
  - `GROUP_MAX_CHARS = 900`、`GROUP_MAX_SPAN = 100.0`
  - `parse_vtt_cues(path: Path) -> list[dict]`，元素 `{"start": float, "end": float, "en": str}`
  - `group_cues(cues: list[dict]) -> list[list[dict]]`

- [ ] **Step 1: 写失败测试**

```python
import importlib.util
import unittest
from pathlib import Path

MODULE = Path(__file__).parents[1] / "scripts" / "align_timings.py"
SPEC = importlib.util.spec_from_file_location("align_timings", MODULE)
aligner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(aligner)


class VttParseTests(unittest.TestCase):
    def test_reads_only_the_english_line_of_a_bilingual_vtt(self):
        import tempfile

        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "ep.vtt"
            path.write_text(
                "WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nHello there.\n你好。\n\n"
                "2\n00:01:00.500 --> 00:01:02.000\nSecond cue.\n第二句。\n",
                encoding="utf-8",
            )
            cues = aligner.parse_vtt_cues(path)
        self.assertEqual(len(cues), 2)
        self.assertEqual(cues[0]["en"], "Hello there.")
        self.assertAlmostEqual(cues[0]["start"], 1.0)
        self.assertAlmostEqual(cues[1]["start"], 60.5)

    def test_skips_empty_text_blocks(self):
        import tempfile

        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "ep.vtt"
            path.write_text(
                "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n\n"
                "2\n00:00:03.000 --> 00:00:04.000\nReal text.\n",
                encoding="utf-8",
            )
            cues = aligner.parse_vtt_cues(path)
        self.assertEqual([c["en"] for c in cues], ["Real text."])


class GroupTests(unittest.TestCase):
    def cue(self, start, end, text):
        return {"start": start, "end": end, "en": text}

    def test_splits_when_characters_exceed_the_limit(self):
        cues = [self.cue(i, i + 1, "x" * 400) for i in range(3)]
        groups = aligner.group_cues(cues)
        self.assertEqual([len(g) for g in groups], [2, 1], "900 字符上限")

    def test_splits_when_span_exceeds_the_limit(self):
        cues = [self.cue(i * 40, i * 40 + 30, "short line") for i in range(4)]
        groups = aligner.group_cues(cues)
        self.assertGreater(len(groups), 1, "100 秒上限")
        for group in groups:
            span = group[-1]["start"] - group[0]["start"]
            self.assertLessEqual(span, aligner.GROUP_MAX_SPAN)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_align_timings.py`
Expected: `ModuleNotFoundError` / `FileNotFoundError`（`scripts/align_timings.py` 还不存在）

- [ ] **Step 3: 实现**

```python
"""把抓取来的 VTT 对齐到音频，产出逐词时间 sidecar（TMLT 机制的移植）。"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

GROUP_MAX_CHARS = 900
GROUP_MAX_SPAN = 100.0

TIMESTAMP = re.compile(
    r"(\d+):(\d\d):([\d.]+)\s*-->\s*(\d+):(\d\d):([\d.]+)"
)


def parse_vtt_cues(path: Path) -> list[dict[str, Any]]:
    """取每个 cue 的时间与英文行（双语 VTT 里第二行是译文）。"""
    cues: list[dict[str, Any]] = []
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    for block in re.split(r"\r?\n\r?\n", text):
        lines = [line.strip() for line in block.strip().split("\n")]
        stamp = next((line for line in lines if "-->" in line), None)
        if not stamp:
            continue
        match = TIMESTAMP.search(stamp)
        if not match:
            continue
        h1, m1, s1, h2, m2, s2 = match.groups()
        start = int(h1) * 3600 + int(m1) * 60 + float(s1)
        end = int(h2) * 3600 + int(m2) * 60 + float(s2)
        body = [
            line
            for line in lines
            if "-->" not in line and line and not line.isdigit()
        ]
        if not body:
            continue
        cues.append({"start": start, "end": end, "en": body[0]})
    return cues


def group_cues(cues: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    groups: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    for cue in cues:
        if current:
            chars = sum(len(item["en"]) for item in current)
            span = max(cue["start"], cue["end"]) - current[0]["start"]
            if chars + len(cue["en"]) > GROUP_MAX_CHARS or span > GROUP_MAX_SPAN:
                groups.append(current)
                current = []
        current.append(cue)
    if current:
        groups.append(current)
    return groups
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_align_timings.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/align_timings.py tests/test_align_timings.py
git commit -m "feat: parse VTT cues and group them for windowed alignment"
```

---

### Task 2: 窗口边界（不用 cue.end）

**Files:**
- Modify: `scripts/align_timings.py`
- Test: `tests/test_align_timings.py`

**Interfaces:**
- Produces:
  - `PAD = 3.0`、`TAIL_PAD = 8.0`、`NOMINAL_CPS = 15.0`、`SLOWEST_CPS = 4.0`
  - `cue_span(cue: dict) -> float`
  - `window_for(group: list[dict], total_seconds: float) -> tuple[float, float]`

- [ ] **Step 1: 写失败测试**

```python
class WindowTests(unittest.TestCase):
    def test_span_floor_is_text_length_not_declared_end(self):
        # 实测 cue.end 普遍少报约 18 秒，窗口必须按字数兜底
        cue = {"start": 100.0, "end": 101.0, "en": "word " * 60}  # 300 字符 → 20 秒
        self.assertAlmostEqual(aligner.cue_span(cue), 20.0)

    def test_span_is_capped_for_very_long_text(self):
        cue = {"start": 0.0, "end": 999.0, "en": "x" * 4000}  # 4000/4+5 = 1005
        self.assertAlmostEqual(aligner.cue_span(cue), 1005.0)

    def test_window_pads_the_start_and_tails_with_bound(self):
        group = [{"start": 100.0, "end": 101.0, "en": "hello there"}]
        lo, hi = aligner.window_for(group, total_seconds=500.0)
        self.assertAlmostEqual(lo, 97.0)
        self.assertGreater(hi, 101.0)
        self.assertLessEqual(hi, 500.0)

    def test_window_never_exceeds_audio(self):
        group = [{"start": 2.0, "end": 3.0, "en": "hi"}]
        lo, hi = aligner.window_for(group, total_seconds=10.0)
        self.assertEqual(lo, 0.0)
        self.assertLessEqual(hi, 10.0)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_align_timings.py`
Expected: ERROR `has no attribute 'cue_span'`

- [ ] **Step 3: 实现**

```python
PAD = 3.0
TAIL_PAD = 8.0
NOMINAL_CPS = 15.0
SLOWEST_CPS = 4.0


def cue_span(cue: dict[str, Any]) -> float:
    """本句语音时长的合理上界：取声明时长与按字数估算的交集，再用最慢语速兜底。"""
    declared = max(0.0, cue["end"] - cue["start"])
    natural = len(cue["en"]) / NOMINAL_CPS
    ceiling = len(cue["en"]) / SLOWEST_CPS + 5.0
    return min(max(declared, natural), ceiling)


def window_for(
    group: list[dict[str, Any]], total_seconds: float
) -> tuple[float, float]:
    lo = max(0.0, group[0]["start"] - PAD)
    hi = min(
        total_seconds,
        max(cue["start"] + cue_span(cue) for cue in group) + TAIL_PAD,
    )
    return lo, hi
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_align_timings.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/align_timings.py tests/test_align_timings.py
git commit -m "feat: compute alignment windows from text length, not cue ends"
```

---

### Task 3: 词的可信度检查与逐句分配

**Files:**
- Modify: `scripts/align_timings.py`
- Test: `tests/test_align_timings.py`

**Interfaces:**
- Produces:
  - `EARLY_TOLERANCE = 8.0`、`LATE_TOLERANCE = 8.0`
  - `words_plausible(cue: dict, next_start: float | None, words: list[dict]) -> bool`
  - `cue_words(segments, group: list[dict], offset: float) -> dict[int, list[dict]]`
    其中 `segments` 是 stable-ts 结果里的 `.segments`（元素有 `.id`、`.words`，词有 `.word/.start/.end`），
    返回 `{group 内下标: [{"w":str,"s":float,"e":float}]}`，时间已加回 `offset`。

- [ ] **Step 1: 写失败测试**

```python
class FakeWord:
    def __init__(self, word, start, end):
        self.word, self.start, self.end = word, start, end


class FakeSegment:
    def __init__(self, seg_id, words):
        self.id, self.words = seg_id, words


class FakeAligned:
    def __init__(self, segments):
        self.segments = segments


class PlausibilityTests(unittest.TestCase):
    def cue(self, start, end, text):
        return {"start": start, "end": end, "en": text}

    def test_accepts_words_that_match_text_and_stay_in_range(self):
        cue = self.cue(10.0, 14.0, "hello there friend")
        words = [
            {"w": "hello", "s": 10.2, "e": 10.6},
            {"w": "there", "s": 10.6, "e": 11.0},
            {"w": "friend", "s": 11.0, "e": 11.6},
        ]
        self.assertTrue(aligner.words_plausible(cue, next_start=20.0, words=words))

    def test_rejects_when_token_count_differs(self):
        cue = self.cue(10.0, 14.0, "hello there friend")
        words = [{"w": "hello", "s": 10.2, "e": 10.6}]
        self.assertFalse(aligner.words_plausible(cue, None, words))

    def test_rejects_when_first_word_is_far_before_the_cue(self):
        cue = self.cue(100.0, 104.0, "hello there friend")
        words = [
            {"w": "hello", "s": 80.0, "e": 80.4},
            {"w": "there", "s": 80.4, "e": 81.0},
            {"w": "friend", "s": 81.0, "e": 81.4},
        ]
        self.assertFalse(aligner.words_plausible(cue, None, words))

    def test_rejects_when_last_word_overruns_the_next_cue(self):
        cue = self.cue(10.0, 14.0, "hello there friend")
        words = [
            {"w": "hello", "s": 10.2, "e": 10.6},
            {"w": "there", "s": 10.6, "e": 11.0},
            {"w": "friend", "s": 40.0, "e": 41.0},
        ]
        self.assertFalse(aligner.words_plausible(cue, next_start=20.0, words=words))


class CueWordsTests(unittest.TestCase):
    def test_maps_segments_by_position_and_applies_offset(self):
        group = [
            {"start": 97.0, "end": 100.0, "en": "hello there"},
            {"start": 100.0, "end": 104.0, "en": "second cue here"},
        ]
        aligned = FakeAligned(
            [
                FakeSegment(0, [FakeWord(" hello", 1.0, 1.4), FakeWord(" there", 1.4, 1.9)]),
                FakeSegment(1, [FakeWord(" second", 4.0, 4.5)]),
            ]
        )
        got = aligner.cue_words(aligned.segments, group, offset=97.0)
        self.assertEqual([w["w"] for w in got[0]], ["hello", "there"])
        self.assertAlmostEqual(got[0][0]["s"], 98.0)
        self.assertAlmostEqual(got[1][0]["s"], 101.0)

    def test_skips_segments_without_words(self):
        group = [{"start": 0.0, "end": 2.0, "en": "hello"}]
        aligned = FakeAligned([FakeSegment(0, [])])
        self.assertEqual(aligner.cue_words(aligned.segments, group, offset=0.0), {})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_align_timings.py`
Expected: ERROR `has no attribute 'words_plausible'`

- [ ] **Step 3: 实现**

```python
EARLY_TOLERANCE = 8.0
LATE_TOLERANCE = 8.0


def words_plausible(
    cue: dict[str, Any], next_start: float | None, words: list[dict[str, Any]]
) -> bool:
    """词集与词位置是否可信；不可信就丢该句的词，而不是写错数据。"""
    if not words:
        return False
    if [w["w"] for w in words] != cue["en"].split():
        return False
    first, last = words[0]["s"], words[-1]["e"]
    if first < cue["start"] - EARLY_TOLERANCE:
        return False
    limit = (next_start if next_start is not None else cue["start"] + LATE_TOLERANCE * 10)
    return last <= limit + LATE_TOLERANCE


def cue_words(segments, group, offset: float) -> dict[int, list[dict[str, Any]]]:
    by_id = {getattr(segment, "id", None): segment for segment in segments}
    result: dict[int, list[dict[str, Any]]] = {}
    for position, cue in enumerate(group):
        segment = by_id.get(position)
        words = list(getattr(segment, "words", None) or []) if segment else []
        mapped = [
            {
                "w": word.word.strip(),
                "s": float(word.start) + offset,
                "e": float(word.end) + offset,
            }
            for word in words
            if word.word.strip()
        ]
        if mapped:
            result[position] = mapped
    return result
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_align_timings.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/align_timings.py tests/test_align_timings.py
git commit -m "feat: map aligned words back to cues with plausibility checks"
```

---

### Task 4: 整集对齐与版本守卫

**Files:**
- Modify: `scripts/align_timings.py`
- Test: `tests/test_align_timings.py`

**Interfaces:**
- Consumes: `parse_vtt_cues`（T1）、`group_cues`（T1）、`window_for`/`cue_span`（T2）、`cue_words`/`words_plausible`（T3）
- Produces:
  - `MISMATCH_MEDIAN = 3.0`
  - `class AudioMismatch(RuntimeError)`
  - `align_cues(model, audio, cues, total_seconds) -> tuple[list[dict], dict]`
    返回 `(cues_with_words, stats)`：`cues` 每条为 `{"start","end","en","words"}`（`words` 可为 `[]`），
    `stats = {"groups": int, "aligned_cues": int, "failed_groups": int, "median_offset": float}`；
    中位偏移 `|x| > MISMATCH_MEDIAN` 时抛 `AudioMismatch`（消息含中位值）。

- [ ] **Step 1: 写失败测试**

```python
class AlignCuesTests(unittest.TestCase):
    def cue(self, start, end, text):
        return {"start": start, "end": end, "en": text}

    class Model:
        def __init__(self, words_per_group):
            self.words_per_group = words_per_group

        def align(self, clip, text, language="en", original_split=True):
            words = self.words_per_group
            return FakeAligned([FakeSegment(0, [FakeWord(w, s, e) for w, s, e in words])])

    def audio(self, seconds):
        import numpy as np

        return np.zeros(int(seconds * 16000), dtype="float32")

    def test_aligned_words_get_absolute_times(self):
        cues = [self.cue(100.0, 104.0, "hello there")]
        model = self.Model([(" hello", 4.0, 4.4), (" there", 4.4, 4.9)])
        out, stats = aligner.align_cues(model, self.audio(200.0), cues, 200.0)
        self.assertAlmostEqual(out[0]["words"][0]["s"], 101.0, places=2)
        self.assertEqual(stats["aligned_cues"], 1)
        self.assertLess(abs(stats["median_offset"]), aligner.MISMATCH_MEDIAN)

    def test_guard_trips_when_the_audio_version_differs(self):
        cues = [self.cue(100.0, 104.0, "hello there")]
        model = self.Model([(" hello", 30.0, 30.4), (" there", 30.4, 30.9)])
        with self.assertRaises(aligner.AudioMismatch):
            aligner.align_cues(model, self.audio(200.0), cues, 200.0)

    def test_failed_group_keeps_cues_without_words(self):
        cues = [self.cue(10.0, 14.0, "hello there")]

        class Broken:
            def align(self, *args, **kwargs):
                raise RuntimeError("boom")

        out, stats = aligner.align_cues(Broken(), self.audio(60.0), cues, 60.0)
        self.assertEqual(out[0]["words"], [])
        self.assertEqual(stats["failed_groups"], 1)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_align_timings.py`
Expected: ERROR `has no attribute 'align_cues'`

- [ ] **Step 3: 实现**

```python
import statistics

SR = 16000
MISMATCH_MEDIAN = 3.0


class AudioMismatch(RuntimeError):
    """中位偏移过大：下载到的音频与转写来源不是同一个版本。"""


def align_cues(model, audio, cues, total_seconds: float):
    stats = {"groups": 0, "aligned_cues": 0, "failed_groups": 0, "median_offset": 0.0}
    offsets: list[float] = []
    result: list[dict[str, Any]] = [
        {"start": cue["start"], "end": cue["end"], "en": cue["en"], "words": []}
        for cue in cues
    ]
    index_of = {id(cue): position for position, cue in enumerate(cues)}
    for group in group_cues(cues):
        stats["groups"] += 1
        lo, hi = window_for(group, total_seconds)
        clip = audio[int(lo * SR) : int(hi * SR)]
        text = "\n".join(cue["en"] for cue in group)
        try:
            aligned = model.align(clip, text, language="en", original_split=True)
        except Exception:
            stats["failed_groups"] += 1
            continue
        mapped = cue_words(aligned.segments, group, offset=lo)
        for position, cue in enumerate(group):
            words = mapped.get(position) or []
            if not words:
                continue
            next_start = None
            try:
                next_cue = cues[index_of[id(cue)] + 1]
                next_start = next_cue["start"]
            except (KeyError, IndexError):
                pass
            if not words_plausible(cue, next_start, words):
                continue
            result[index_of[id(cue)]]["words"] = words
            stats["aligned_cues"] += 1
            offsets.append(words[0]["s"] - cue["start"])
    if offsets:
        median = statistics.median(offsets)
        stats["median_offset"] = round(median, 3)
        if abs(median) > MISMATCH_MEDIAN:
            raise AudioMismatch(
                f"中位首词偏移 {median:+.2f}s 超过 {MISMATCH_MEDIAN}s：音频版本可能不同"
            )
    return result, stats
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_align_timings.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/align_timings.py tests/test_align_timings.py
git commit -m "feat: align a whole episode and reject mismatched audio versions"
```

---

### Task 5: 单集落盘（sidecar + 失败记账）

**Files:**
- Modify: `scripts/align_timings.py`
- Test: `tests/test_align_timings.py`

**Interfaces:**
- Consumes: `transcribe.write_word_timings/write_sidecar_failure/sidecar_status/sidecar_path_for/BACKFILL_MAX_ATTEMPTS`、`transcribe.clean_text`
- Produces: `align_episode_file(vtt_path, audio_url, model, *, workdir, download=None, decode=None, total_seconds=None) -> str`
  返回 `"done" | "partial" | "failed" | "mismatch"`；写 sidecar 到 `sidecar_path_for(vtt_path)`。

- [ ] **Step 1: 写失败测试**

```python
class AlignFileTests(unittest.TestCase):
    def setUp(self):
        import tempfile

        import transcribe as _t  # 由测试文件顶部 importlib 加载后注入 sys.modules

        self.transcribe = _t
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.site = self.root / "site"
        self.vtt_dir = self.site / "pod" / "transcripts"
        self.vtt_dir.mkdir(parents=True)
        self.timing_dir = self.site / "pod" / "timings"
        self.vtt = self.vtt_dir / "Ep.vtt"
        self.vtt.write_text(
            "WEBVTT\n\n1\n00:00:01.000 --> 00:00:05.000\nHello there.\n你好。\n",
            encoding="utf-8",
        )
        self.patches = [
            unittest.mock.patch.object(self.transcribe, "TIMING_DIR", self.timing_dir),
            unittest.mock.patch.object(self.transcribe, "PODCAST_DIR", self.site / "pod"),
            unittest.mock.patch.object(self.transcribe, "SITE_DIR", self.site),
        ]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def fake_model(self, words):
        class Model:
            def align(self, clip, text, language="en", original_split=True):
                return FakeAligned([FakeSegment(0, [FakeWord(w, s, e) for w, s, e in words])])

        return Model()

    def test_writes_successful_sidecar(self):
        status = aligner.align_episode_file(
            self.vtt,
            "https://cdn.test/a.mp3",
            self.fake_model([(" Hello", 1.0, 1.4), (" there.", 1.4, 2.0)]),
            workdir=self.root,
            download=lambda url, path: path.write_bytes(b"x"),
            decode=lambda path: __import__("numpy").zeros(60 * 16000, dtype="float32"),
        )
        self.assertEqual(status, "done")
        sidecar = self.timing_dir / "Ep.json"
        self.assertEqual(self.transcribe.sidecar_status(sidecar), (True, 1))

    def test_mismatch_writes_failure_and_bumps_attempts(self):
        status = aligner.align_episode_file(
            self.vtt,
            "https://cdn.test/a.mp3",
            self.fake_model([(" Hello", 40.0, 40.4), (" there.", 40.4, 41.0)]),
            workdir=self.root,
            download=lambda url, path: path.write_bytes(b"x"),
            decode=lambda path: __import__("numpy").zeros(120 * 16000, dtype="float32"),
        )
        self.assertEqual(status, "mismatch")
        sidecar = self.timing_dir / "Ep.json"
        self.assertEqual(self.transcribe.sidecar_status(sidecar), (False, 1))
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_align_timings.py`
Expected: ERROR `has no attribute 'align_episode_file'`

- [ ] **Step 3: 实现**

```python
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import transcribe  # noqa: E402  （复用下载、sidecar、断点语义）


def align_episode_file(
    vtt_path: Path,
    audio_url: str,
    model,
    *,
    workdir: Path,
    download=None,
    decode=None,
    total_seconds: float | None = None,
) -> str:
    download = download or transcribe.download_audio
    decode = decode or decode_audio
    sidecar = transcribe.sidecar_path_for(vtt_path)
    audio_path = Path(workdir) / "episode.audio"
    try:
        download(audio_url, audio_path)
        audio = decode(audio_path)
        total = total_seconds or len(audio) / SR
        cues = parse_vtt_cues(vtt_path)
        if not cues:
            raise RuntimeError("VTT 没有可用 cue")
        aligned, stats = align_cues(model, audio, cues, total)
    except AudioMismatch:
        attempts = transcribe.sidecar_status(sidecar)[1] + 1
        transcribe.write_sidecar_failure(sidecar, attempts)
        return "mismatch"
    except Exception:
        attempts = transcribe.sidecar_status(sidecar)[1] + 1
        transcribe.write_sidecar_failure(sidecar, attempts)
        return "failed"
    transcribe.write_word_timings(aligned, sidecar, total)
    aligned_cues = stats["aligned_cues"]
    log_summary(vtt_path, stats, aligned_cues, len(aligned))
    return "done" if aligned_cues else "partial"


def log_summary(vtt_path: Path, stats: dict, aligned_cues: int, total_cues: int) -> None:
    print(
        f"{vtt_path.stem}: 组 {stats['groups']}（失败 {stats['failed_groups']}），"
        f"带词 {aligned_cues}/{total_cues}，中位偏移 {stats['median_offset']:+.2f}s"
    )


def decode_audio(path: Path):
    import av
    import numpy as np

    chunks = []
    with av.open(str(path)) as container:
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="flt", layout="mono", rate=SR)
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray().reshape(-1))
    return np.concatenate(chunks).astype("float32")
```

测试顶部需要把 `transcribe` 注入 `sys.modules`：

```python
import sys
import types

import types as _types

faster_whisper = _types.ModuleType("faster_whisper")
faster_whisper.WhisperModel = object
sys.modules.setdefault("faster_whisper", faster_whisper)

for name in ("google", "google.genai", "google.genai.types"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["google"].genai = sys.modules["google.genai"]
sys.modules["google.genai"].types = sys.modules["google.genai.types"]
for attr in ("Client", "GenerateContentConfig"):
    if not hasattr(sys.modules["google.genai"], attr):
        setattr(sys.modules["google.genai"], attr, object)
sys.modules.setdefault("feedparser", types.ModuleType("feedparser"))
sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
import transcribe  # noqa: E402
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_align_timings.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/align_timings.py tests/test_align_timings.py
git commit -m "feat: write per-episode word timing sidecars with failure bookkeeping"
```

---

### Task 6: 选片与分片执行器

**Files:**
- Modify: `scripts/align_timings.py`
- Test: `tests/test_align_timings.py`

**Interfaces:**
- Consumes: `transcribe.shard_of`、`transcribe.sidecar_path_for`、`transcribe.sidecar_status`、`transcribe.is_valid_bilingual_vtt`、`transcribe.BACKFILL_MAX_ATTEMPTS`
- Produces:
  - `RECENT_DAYS = 30`
  - `build_candidates(podcasts, progresses, mode, latest_per_show=20, now=None) -> list[dict]`
    元素 `{"slug","identity","title","audio_url","vtt_path"}`；`mode` ∈ {"recent","latest"}
  - `run_align(candidates, shard, shards, max_minutes, process=None, clock=None) -> dict`
    `process(item) -> "done"|"partial"|"failed"|"mismatch"`；返回 `{"done","partial","failed","mismatch","skipped"}`

- [ ] **Step 1: 写失败测试**

```python
class CandidateTests(unittest.TestCase):
    def test_latest_mode_takes_n_newest_per_show(self):
        entries = [
            {"guid": f"g{i}", "title": f"Ep {i}", "published": "", "url": f"https://cdn/{i}.mp3"}
            for i in range(5)
        ]
        processed = {f"g{i}": {"vtt_filename": f"Ep_{i}.vtt"} for i in range(5)}
        with unittest.mock.patch.object(
            aligner.transcribe, "is_valid_bilingual_vtt", return_value=True
        ), unittest.mock.patch.object(
            aligner.transcribe, "sidecar_status", return_value=(False, 0)
        ), unittest.mock.patch.object(
            aligner.transcribe, "SITE_DIR", Path("site")
        ):
            got = aligner.build_candidates(
                [{"slug": "pod", "entries": entries, "processed": processed}],
                mode="latest",
                latest_per_show=2,
            )
        self.assertEqual([c["identity"] for c in got], ["g4", "g3"])

    def test_recent_mode_skips_old_and_finished(self):
        now = datetime(2026, 10, 29, tzinfo=timezone.utc)
        entries = [
            {"guid": "new", "title": "New", "published": "Wed, 28 Oct 2026 00:00:00 +0000", "url": "https://cdn/n.mp3"},
            {"guid": "old", "title": "Old", "published": "Wed, 01 Jan 2025 00:00:00 +0000", "url": "https://cdn/o.mp3"},
            {"guid": "done", "title": "Done", "published": "Wed, 28 Oct 2026 00:00:00 +0000", "url": "https://cdn/d.mp3"},
        ]
        processed = {g: {"vtt_filename": f"{g}.vtt"} for g in ("new", "old", "done")}
        with unittest.mock.patch.object(
            aligner.transcribe, "is_valid_bilingual_vtt", return_value=True
        ), unittest.mock.patch.object(
            aligner.transcribe, "sidecar_status", side_effect=lambda p: (p.name == "done.json", 1)
        ), unittest.mock.patch.object(aligner.transcribe, "SITE_DIR", Path("site")):
            got = aligner.build_candidates(
                [{"slug": "pod", "entries": entries, "processed": processed}],
                mode="recent",
                now=now,
            )
        self.assertEqual([c["identity"] for c in got], ["new"])


class RunAlignTests(unittest.TestCase):
    def items(self, n):
        return [{"slug": "pod", "identity": f"g{i}", "title": f"E{i}",
                 "audio_url": "u", "vtt_path": Path("x")} for i in range(n)]

    def test_budget_and_shard_and_mismatch_accounting(self):
        seen = []
        stats = aligner.run_align(
            self.items(6), shard=0, shards=1, max_minutes=1,
            process=lambda item: seen.append(item["identity"]) or "done",
            clock=iter([0.0, 0.0, 0.0, 99999.0, 99999.0]).__next__,
        )
        self.assertLess(len(seen), 6)
        self.assertEqual(stats["done"], len(seen))

    def test_mismatch_is_counted_separately(self):
        stats = aligner.run_align(
            self.items(2), shard=0, shards=1, max_minutes=10,
            process=lambda item: "mismatch", clock=lambda: 0.0,
        )
        self.assertEqual(stats["mismatch"], 2)
        self.assertEqual(stats["failed"], 0)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_align_timings.py`
Expected: ERROR `has no attribute 'build_candidates'`

- [ ] **Step 3: 实现**

```python
import time
from datetime import datetime, timedelta, timezone

RECENT_DAYS = 30


def _published(entry) -> datetime | None:
    raw = entry.get("published") or ""
    try:
        from email.utils import parsedate_to_datetime

        stamp = parsedate_to_datetime(raw)
        return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def build_candidates(
    shows: list[dict],
    mode: str,
    latest_per_show: int = 20,
    now: datetime | None = None,
) -> list[dict]:
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=RECENT_DAYS)
    candidates: list[dict] = []
    seen_paths: set[Path] = set()
    for show in shows:
        slug, entries, processed = show["slug"], show["entries"], show["processed"]
        picked = []
        for entry in entries:
            info = processed.get(entry["guid"])
            if not info or not info.get("vtt_filename"):
                continue
            vtt_path = transcribe.SITE_DIR / slug / "transcripts" / info["vtt_filename"]
            if not vtt_path.exists() or not transcribe.is_valid_bilingual_vtt(vtt_path):
                continue
            complete, attempts = transcribe.sidecar_status(
                transcribe.sidecar_path_for(vtt_path)
            )
            if complete or attempts >= transcribe.BACKFILL_MAX_ATTEMPTS:
                continue
            if mode == "recent":
                stamp = _published(entry)
                if stamp is None or stamp < cutoff:
                    continue
            picked.append((entry, vtt_path))
        if mode == "latest":
            picked = picked[:latest_per_show]
        for entry, vtt_path in picked:
            if vtt_path in seen_paths:
                continue
            seen_paths.add(vtt_path)
            candidates.append(
                {
                    "slug": slug,
                    "identity": entry["guid"],
                    "title": entry["title"],
                    "audio_url": entry["url"],
                    "vtt_path": vtt_path,
                }
            )
    return candidates


def run_align(
    candidates, shard, shards, max_minutes, process=None, clock=None
) -> dict[str, int]:
    process = process or process_candidate
    clock = clock or time.monotonic
    deadline = clock() + max_minutes * 60
    stats = {"done": 0, "partial": 0, "failed": 0, "mismatch": 0, "skipped": 0}
    for item in candidates:
        if transcribe.shard_of(item["identity"], shards) != shard:
            stats["skipped"] += 1
            continue
        if clock() >= deadline:
            print(f"分片 {shard} 预算用完，已完成 {stats['done'] + stats['partial']} 集")
            break
        outcome = process(item)
        stats[outcome] = stats.get(outcome, 0) + 1
    print(
        f"分片 {shard} 结束：done {stats['done']}，partial {stats['partial']}，"
        f"failed {stats['failed']}，mismatch {stats['mismatch']}，skipped {stats['skipped']}"
    )
    return stats
```

> `run_align` 的 `process` 形参默认 `None`：本任务只测注入路径；
> 真正的默认实现 `process_candidate` 依赖模型加载，放在 Task 7 定义并在 `main()` 里传入。

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_align_timings.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/align_timings.py tests/test_align_timings.py
git commit -m "feat: select alignment candidates and run them per shard"
```

---

### Task 7: 模型加载与 CLI 入口

**Files:**
- Modify: `scripts/align_timings.py`
- Test: `tests/test_align_timings.py`

**Interfaces:**
- Produces:
  - `load_model()`（`stable_whisper.load_faster_whisper(transcribe.WHISPER_MODEL, device="cpu", compute_type="int8", cpu_threads=N)`）
  - `align_env() -> dict`：读 `ALIGN_MODE`（默认 `recent`）、`ALIGN_SHARD`/`ALIGN_SHARDS`/`ALIGN_MAX_MINUTES`（默认 0/20/150）、`ALIGN_LATEST_PER_SHOW`（默认 20）
  - `main() -> int`

- [ ] **Step 1: 写失败测试**

```python
class EnvTests(unittest.TestCase):
    def test_defaults(self):
        with unittest.mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(
                aligner.align_env(),
                {"mode": "recent", "shard": 0, "shards": 20, "max_minutes": 150.0, "latest": 20},
            )

    def test_reads_overrides_and_rejects_bad_values(self):
        with unittest.mock.patch.dict(
            os.environ,
            {"ALIGN_MODE": "latest", "ALIGN_SHARD": "3", "ALIGN_SHARDS": "20",
             "ALIGN_MAX_MINUTES": "90", "ALIGN_LATEST_PER_SHOW": "5"},
        ):
            got = aligner.align_env()
        self.assertEqual(got["mode"], "latest")
        self.assertEqual(got["shard"], 3)
        self.assertEqual(got["latest"], 5)
        with unittest.mock.patch.dict(os.environ, {"ALIGN_MODE": "bogus"}):
            with self.assertRaises(ValueError):
                aligner.align_env()
        with unittest.mock.patch.dict(os.environ, {"ALIGN_SHARD": "5", "ALIGN_SHARDS": "4"}):
            with self.assertRaises(ValueError):
                aligner.align_env()
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_align_timings.py`
Expected: ERROR `has no attribute 'align_env'`

- [ ] **Step 3: 实现**

```python
import json
import os
import tempfile
from pathlib import Path


def process_candidate(item: dict) -> str:
    model = load_model()
    with tempfile.TemporaryDirectory(prefix="align-audio-") as temp_dir:
        return align_episode_file(
            item["vtt_path"], item["audio_url"], model, workdir=Path(temp_dir)
        )


def load_model():
    import stable_whisper as sw

    threads = int(os.getenv("ALIGN_THREADS", "0")) or (os.cpu_count() or 1)
    return sw.load_faster_whisper(
        transcribe.WHISPER_MODEL, device="cpu", compute_type="int8", cpu_threads=threads
    )


def align_env() -> dict[str, Any]:
    mode = (os.getenv("ALIGN_MODE", "recent") or "recent").strip().lower()
    if mode not in ("recent", "latest"):
        raise ValueError(f"ALIGN_MODE 只能是 recent 或 latest：{mode}")
    shards = int(os.getenv("ALIGN_SHARDS", "20") or 20)
    shard = int(os.getenv("ALIGN_SHARD", "0") or 0)
    max_minutes = float(os.getenv("ALIGN_MAX_MINUTES", "150") or 150)
    latest = int(os.getenv("ALIGN_LATEST_PER_SHOW", "20") or 20)
    if shards < 1 or not 0 <= shard < shards:
        raise ValueError(f"分片配置非法：shard={shard} shards={shards}")
    if max_minutes <= 0:
        raise ValueError(f"预算非法：{max_minutes}")
    return {
        "mode": mode,
        "shard": shard,
        "shards": shards,
        "max_minutes": max_minutes,
        "latest": latest,
    }


def main() -> int:
    env = align_env()
    podcasts = json.loads((ROOT / "podcasts.json").read_text(encoding="utf-8"))
    progress = json.loads((ROOT / "progress.json").read_text(encoding="utf-8"))
    shows = []
    for podcast in podcasts:
        slug = podcast["slug"]
        parsed, entries = transcribe.get_feed_entries(podcast["feed_url"])
        processed = progress.get("podcasts", {}).get(slug, {}).get("processed", {})
        shows.append(
            {
                "slug": slug,
                "entries": [
                    {
                        "guid": str(getattr(entry, "id", "") or ""),
                        "title": transcribe.clean_text(getattr(entry, "title", "") or ""),
                        "published": str(getattr(entry, "published", "") or ""),
                        "url": transcribe.get_entry_audio_url(entry),
                    }
                    for entry in entries
                ],
                "processed": processed,
            }
        )
    candidates = build_candidates(
        shows, mode=env["mode"], latest_per_show=env["latest"]
    )
    print(
        f"对齐模式 {env['mode']}：分片 {env['shard']}/{env['shards']}，"
        f"预算 {env['max_minutes']:.0f} 分钟，候选 {len(candidates)} 集"
    )
    run_align(
        candidates,
        shard=env["shard"],
        shards=env["shards"],
        max_minutes=env["max_minutes"],
        process=process_candidate,
    )
    return 0


ROOT = Path(__file__).resolve().parent.parent

if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_align_timings.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/align_timings.py tests/test_align_timings.py
git commit -m "feat: add alignment CLI with recent/latest modes"
```

---

### Task 8: CI 接线

**Files:**
- Create: `requirements-align.txt`
- Create: `.github/workflows/align.yml`

**Interfaces:**
- Consumes: `ALIGN_MODE` / `ALIGN_SHARD` / `ALIGN_SHARDS` / `ALIGN_MAX_MINUTES` / `ALIGN_LATEST_PER_SHOW`、`transcribe.WHISPER_MODEL`

- [ ] **Step 1: 依赖文件**

```text
-r requirements-transcribe.txt
stable-ts==2.19.1
av==17.1.0
```

- [ ] **Step 2: workflow**

```yaml
name: Align word timings

on:
  workflow_run:
    workflows: ["Crawl Transcripts"]
    types: [completed]
  workflow_dispatch:
    inputs:
      mode:
        description: "recent（最近 30 天）或 latest（每节目最新 N 集）"
        default: "recent"
      shard:
        description: "本分片号（0 起）"
        default: "0"
      shards:
        description: "分片总数"
        default: "20"
      max_minutes:
        description: "本分片时间预算（分钟）"
        default: "150"
      latest_per_show:
        description: "latest 模式每节目取几集"
        default: "20"

permissions:
  contents: write

concurrency:
  group: align-timings
  cancel-in-progress: false

jobs:
  align:
    if: github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    timeout-minutes: 330
    steps:
      - uses: actions/checkout@v4
        with:
          token: ${{ secrets.MY_CUSTOM_PAT }}

      - name: 同步到远程最新
        run: |
          git fetch origin
          git checkout "${GITHUB_REF_NAME}"
          git reset --hard "origin/${GITHUB_REF_NAME}"

      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"

      - name: 安装依赖
        run: |
          python -m pip install --upgrade pip
          pip install -r requirements-align.txt

      - name: Cache whisper model
        id: cache-model
        uses: actions/cache@v4
        with:
          path: ${{ github.workspace }}/models/ct2-turbo
          key: ct2-turbo-v1

      - name: Download whisper model (if cache miss)
        if: steps.cache-model.outputs.cache-hit != 'true'
        run: |
          pip install --quiet huggingface_hub
          python - <<'PY'
          from pathlib import Path
          from huggingface_hub import snapshot_download

          target = Path("models/ct2-turbo")
          snapshot_download("deepdml/faster-whisper-large-v3-turbo-ct2", local_dir=str(target))
          size = (target / "model.bin").stat().st_size
          if size < 1_000_000_000:
              raise SystemExit(f"model.bin 异常：{size} 字节")
          print(f"model ready: {size / 2**30:.2f} GiB")
          PY

      - name: 检查模型
        run: |
          for f in model.bin config.json; do
            [ -f "models/ct2-turbo/$f" ] || { echo "::error::缺少 models/ct2-turbo/$f"; exit 1; }
          done

      - name: 对齐
        id: align
        continue-on-error: true
        env:
          WHISPER_MODEL: models/ct2-turbo
          ALIGN_MODE: ${{ github.event.inputs.mode || 'recent' }}
          ALIGN_SHARD: ${{ github.event.inputs.shard || '0' }}
          ALIGN_SHARDS: ${{ github.event.inputs.shards || '20' }}
          ALIGN_MAX_MINUTES: ${{ github.event.inputs.max_minutes || '150' }}
          ALIGN_LATEST_PER_SHOW: ${{ github.event.inputs.latest_per_show || '20' }}
        run: python -u scripts/align_timings.py

      - name: 提交 sidecar
        if: always()
        env:
          MY_PAT: ${{ secrets.MY_CUSTOM_PAT }}
        run: |
          git remote set-url origin "https://${MY_PAT}@github.com/${GITHUB_REPOSITORY}.git"
          bash scripts/git_push_retry.sh "auto: align word timings (${GITHUB_EVENT_NAME})" \
            site \
            ':(exclude)site/*/transcripts/**' \
            ':(exclude)site/*/feed.xml' \
            ':(exclude)site/*/feed-zh.xml' \
            ':(exclude)site/*/index.html' \
            ':(exclude)site/index.html' \
            ':(exclude)site/podcasts.html' \
            ':(exclude)**/*.tmp' \
            ':(exclude)**/*.part'

      - name: 失败则红
        if: always()
        run: |
          if [ "${{ steps.align.outcome }}" = "failure" ]; then
            echo "::error::对齐步骤失败"
            exit 1
          fi
```

- [ ] **Step 3: 校验**

Run: `python -c "import yaml; yaml.safe_load(open('.github/workflows/align.yml', encoding='utf-8')); print('yaml ok')"`
Expected: `yaml ok`

- [ ] **Step 4: 提交（等用户确认）**

```bash
git add requirements-align.txt .github/workflows/align.yml
git commit -m "ci: run word-timing alignment after crawl and on dispatch"
```

---

### Task 9: 冒烟与放行（运维）

- [ ] **Step 1: 冒烟 1 集**：dispatch `align.yml`，`mode=latest`、`latest_per_show=1`、`shards=1`、`max_minutes=60`。
  Expected：日志出现 `对齐模式 latest：… 候选 12 集` 与 12 条 `… 带词 x/y，中位偏移 ±z`；
  仓库新增 12 个 sidecar（也可能少于 12，取决于各节目最新集是否已有 VTT）；`state.json` 无变化。
- [ ] **Step 2: 记录实测**：单集中位偏移、带词率、耗时、RTF。
- [ ] **Step 3: 正式回填**：`mode=latest`、`latest_per_show=20`、`shards=20`、`max_minutes=150`，重复派发直到候选归零。
- [ ] **Step 4: 验收**：每个节目 `timings/` 里 sidecar 数 ≥ min(20, 该节目 VTT 数)；
  抽 3 集：带词率 ≥90%、越界词 0、无 |中位偏移| > 3 s。

---

## Self-Review

- **Spec 覆盖**：机制（T1–T4）、sidecar 与断点（T5）、音频获取（T5 调 `transcribe.download_audio`）、选片（T6）、CI（T8）、验收（T9）逐条有任务。
- **占位符**：无 TBD；每个代码步骤都有可粘贴实现。
- **类型一致性**：`parse_vtt_cues`/`group_cues`/`cue_span`/`window_for`/`words_plausible`/`cue_words`/`align_cues`/`align_episode_file`/`build_candidates`/`run_align`/`align_env` 在后续任务中均按首次定义的名字与签名使用；`align_cues` 返回的 cue 形状 `{"start","end","en","words"}` 与 `transcribe.write_word_timings` 的输入契约一致。
