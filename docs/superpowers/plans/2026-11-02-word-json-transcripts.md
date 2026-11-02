# 词级 JSON 字幕与单 Feed 改造 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已迁移的 618 集（office-ladies 497 + how-we-made-your-mother 121）站点的 transcript 从句级 VTT 换成词级 JSON，feed 只保留一个，旧 VTT 归档进 `data/`。

**Architecture:** 新增 `scripts/word_transcript.py` 负责“内部 data JSON → Podcasting 2.0 官方字段 + AntennaPod 词级扩展”的转换与导出。office-ladies 由 `publish` job、hwmym 由 `transcribe` job 各自调用它；feed 生成器按 progress/state 记录里的 `transcript_filename` / `transcript_type` 写标签，缺字段回退 VTT。旧 VTT 一次性搬到 `data/<slug>/legacy-vtt/`，站点不再提供 VTT。

**Tech Stack:** Python 3.11/3.14（脚本与测试均用系统 python）、lxml（feed）、unittest（每个测试文件单独运行）。

**Spec:** `docs/superpowers/specs/2026-11-02-word-json-transcripts-design.md`

> **实施修正（2026-11-02，以代码为准）**：实测导出 386.3 MB，放进 Pages 会使站点达到
> 1,070.6 MB 超过 1 GB 上限。最终改为 JSON 存仓库 `json/<slug>/<stem>.json`，feed 指向
> `https://raw.githubusercontent.com/lzoreal/MyTranscript/main/json/...`。因此下文 T1–T5
> 片段里的 `site_dir`/`site/<slug>/transcripts` 参数已由 `json_dir`/`json/` 取代；
> T6–T8 已按新方案更新。

## Global Constraints

- 提交策略（AGENTS.md）：用户没有说“提交”前不 `git commit`/`git push`；执行时先完成实现与测试，把 diff 与结果汇报给用户，得到授权后再提交。
- 测试必须真跑：本仓库没有 pytest 配置，逐个文件 `python tests/test_xxx.py`；全部通过输出 `OK`。
- 不得把密钥写进日志；不打印完整 key。
- GitHub Pages 站点总量必须 < 1 GB（JSON 已移出 Pages，站点约 653 MB）。
- 同一节目只能有一个产出方：office-ladies 只由 `transcripts.yml` 的 publish job 写，hwmym 只由 `transcribe.yml` 写。
- Windows 上不要用 heredoc 写含 `\n` 的 Python 字符串；需要换行时用 `chr(10)` 或直接写文件。
- 其余 11 个节目的站点文件与 feed 行为不得改变。

---

## 文件结构

| 文件 | 责任 |
| --- | --- |
| `scripts/word_transcript.py`（新建） | 内部 JSON → 站点词级 JSON；批量导出 |
| `scripts/pipeline_site.py` | publish 侧：写 JSON、单 feed；删除 VTT 渲染 |
| `scripts/publish_site.py` | progress 登记 JSON 字段；不再写 translations.json |
| `scripts/scraper.py` | feed 标签按记录选 JSON；`is_episode_processed` 认 JSON |
| `scripts/transcribe.py` | hwmym：导出 JSON、切 feed/index 链接、缓存判断 |
| `scripts/export_word_json.py`（新建） | 一次性迁移/手动补导出的 CLI |
| `tests/test_word_transcript.py`（新建） | 转换与导出 |
| `tests/test_publish_site.py`（新建） | progress 字段 |
| `tests/test_export_word_json.py`（新建） | stem 解析 |
| `tests/test_pipeline_site.py` / `test_scraper_utils.py` / `test_transcribe_utils.py` | 更新与新增用例 |
| `docs/handover.md`、`AGENTS.md` | 记录新产物与单 feed 规则 |

---

### Task 1: 词级 JSON 转换与导出模块

**Files:**
- Create: `scripts/word_transcript.py`
- Test: `tests/test_word_transcript.py`

**Interfaces:**
- Produces:
  - `build(document: dict) -> dict`：返回 `{"version":"1.0.0","audio_seconds":float,"segments":[...]}`；
  - `dumps(document: dict) -> str`：紧凑 JSON 文本；
  - `export_show(data_dir, site_dir, slug: str, stems: dict[str, str]) -> int`：
    按 `stems[guid]` 写 `site/<slug>/transcripts/<stem>.json`，返回写出数量。

- [ ] **Step 1: 写失败测试**

```python
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location(
    "word_transcript", ROOT / "scripts" / "word_transcript.py"
)
wt = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(wt)

DOC = {
    "version": 2,
    "slug": "pod",
    "guid": "g1",
    "title": "Ep",
    "audio_seconds": 12.5,
    "sentences": [
        {
            "start": 0.0,
            "end": 2.5,
            "en": "Hello there.",
            "zh": "你好。",
            "words": [
                {"w": "Hello", "s": 0.0, "e": 1.0},
                {"w": "there.", "s": 1.0, "e": 2.5},
            ],
            "zh_words": [["你好", 0, 2500]],
        },
        {
            "start": 2.5,
            "end": 3.0,
            "en": "Bye.",
            "zh": "",
            "words": [{"w": "Bye.", "s": 2.5, "e": 3.0}],
        },
    ],
}


class BuildTests(unittest.TestCase):
    def test_standard_fields_match_podcasting_2_0(self):
        out = wt.build(DOC)
        self.assertEqual(out["version"], "1.0.0")
        self.assertEqual(out["audio_seconds"], 12.5)
        seg = out["segments"][0]
        self.assertEqual(seg["startTime"], 0.0)
        self.assertEqual(seg["endTime"], 2.5)
        self.assertEqual(seg["body"], "Hello there.\n你好。")
        self.assertEqual(seg["text"], seg["body"])

    def test_extension_fields_are_ms_and_monotonic(self):
        seg = wt.build(DOC)["segments"][0]
        self.assertEqual(seg["start"], 0)
        self.assertEqual(seg["end"], 2500)
        self.assertEqual(seg["words"], [["Hello", 0, 1000], ["there.", 1000, 1500]])
        starts = [word[1] for word in seg["words"]]
        self.assertEqual(starts, sorted(starts))

    def test_missing_chinese_keeps_english_only(self):
        seg = wt.build(DOC)["segments"][1]
        self.assertEqual(seg["body"], "Bye.")
        self.assertEqual(seg["words"], [["Bye.", 2500, 500]])

    def test_invalid_sentence_is_skipped(self):
        broken = {
            "audio_seconds": 1.0,
            "sentences": [{"start": 2.0, "end": 2.0, "en": "Bad.", "words": []}],
        }
        self.assertEqual(wt.build(broken)["segments"], [])


class ExportTests(unittest.TestCase):
    def test_export_show_writes_only_mapped_stems(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            show_dir = root / "data" / "pod"
            show_dir.mkdir(parents=True)
            (show_dir / "g1.json").write_text(json.dumps(DOC), encoding="utf-8")
            unmapped = dict(DOC, guid="g2")
            (show_dir / "g2.json").write_text(json.dumps(unmapped), encoding="utf-8")
            (show_dir / "state-0.json").write_text("{}", encoding="utf-8")

            written = wt.export_show(root / "data", root / "site", "pod", {"g1": "Ep_One"})

            self.assertEqual(written, 1)
            out = root / "site" / "pod" / "transcripts" / "Ep_One.json"
            self.assertTrue(out.exists())
            self.assertFalse((out.parent / "Ep_One.vtt").exists())
            doc = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(doc["segments"][0]["body"], "Hello there.\n你好。")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `python tests/test_word_transcript.py`
Expected: `ModuleNotFoundError` / `FileNotFoundError`（模块不存在）

- [ ] **Step 3: 实现模块**

创建 `scripts/word_transcript.py`：

```python
"""把内部双语 JSON 导出为 Podcasting 2.0 transcript JSON（含 AntennaPod 词级扩展）。

标准字段：version / segments[].startTime|endTime|body（秒）。
扩展字段：segments[].start|end|text|words（毫秒），供本仓库 AntennaPod fork 的词级高亮。
"""

from __future__ import annotations

import json
from pathlib import Path


def _ms(value) -> int:
    return int(round(float(value) * 1000))


def _segment(sentence: dict) -> dict | None:
    en = (sentence.get("en") or "").strip()
    if not en:
        return None
    start, end = float(sentence["start"]), float(sentence["end"])
    if end <= start:
        return None
    zh = (sentence.get("zh") or "").strip()
    body = en if not zh else en + chr(10) + zh
    words = []
    for word in sentence.get("words") or []:
        token = (word.get("w") or "").strip()
        if not token:
            continue
        w_start, w_end = _ms(word["s"]), _ms(word["e"])
        if w_end < w_start:
            continue
        words.append([token, w_start, w_end - w_start])
    words.sort(key=lambda item: item[1])
    return {
        "startTime": round(start, 3),
        "endTime": round(end, 3),
        "body": body,
        "start": _ms(start),
        "end": _ms(end),
        "text": body,
        "words": words,
    }


def build(document: dict) -> dict:
    segments = []
    for sentence in document.get("sentences") or []:
        segment = _segment(sentence)
        if segment is not None:
            segments.append(segment)
    return {
        "version": "1.0.0",
        "audio_seconds": float(document.get("audio_seconds") or 0),
        "segments": segments,
    }


def dumps(document: dict) -> str:
    return json.dumps(build(document), ensure_ascii=False, separators=(",", ":"))


def export_show(data_dir, site_dir, slug: str, stems: dict[str, str]) -> int:
    written = 0
    for path in sorted((Path(data_dir) / slug).glob("*.json")):
        if path.name.startswith("state"):
            continue
        document = json.loads(path.read_text(encoding="utf-8"))
        stem = stems.get(document.get("guid"))
        if not stem:
            continue
        target = Path(site_dir) / slug / "transcripts" / f"{stem}.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(target.name + ".tmp")
        tmp.write_text(dumps(document), encoding="utf-8")
        tmp.replace(target)
        written += 1
    return written
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `python tests/test_word_transcript.py`
Expected: `OK`

- [ ] **Step 5: 提交（获得用户授权后）**

```bash
git add scripts/word_transcript.py tests/test_word_transcript.py
git commit -m "feat: export word-level transcript JSON for podcast feeds"
```

---

### Task 2: publish 侧只写 JSON、只发一个 feed

**Files:**
- Modify: `scripts/pipeline_site.py`
- Modify: `scripts/publish_site.py`
- Test: `tests/test_pipeline_site.py`, `tests/test_publish_site.py`（新建）

**Interfaces:**
- Consumes: `word_transcript.export_show(data_dir, site_dir, slug, stems) -> int`
- Produces:
  - `pipeline_site.write_episode(document, site_dir, slug, stem) -> str`（返回 JSON 文本）；
  - `pipeline_site.merged_processed(progress, slug, stems)` 的每条记录含
    `transcript_filename="<stem>.json"`、`transcript_type="application/json"`；
  - `pipeline_site.publish_show(...) -> {"episodes": int, "stems": dict}`（不再有 `status`）；
  - `publish_site.merge_progress(...)` 写 `url/path/transcript_filename/transcript_type`。

- [ ] **Step 1: 改测试（先失败）**

把 `tests/test_pipeline_site.py` 里的 `RenderTests` 和 `test_status_entry_marks_translated_with_a_hash`
删掉，换成（顶部补 `import json` 与 `from unittest.mock import patch`）：

```python
import json

class JsonWriteTests(unittest.TestCase):
    def test_write_episode_writes_json_and_no_vtt(self):
        document = {
            "guid": "g1",
            "audio_seconds": 5.0,
            "sentences": [
                {"start": 0.0, "end": 1.0, "en": "Hi.", "zh": "嗨。",
                 "words": [{"w": "Hi.", "s": 0.0, "e": 1.0}]},
            ],
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            text = site.write_episode(document, Path(temp_dir), "pod", "Ep_One")
            out = Path(temp_dir) / "pod" / "transcripts" / "Ep_One.json"
            self.assertTrue(out.exists())
            self.assertFalse((out.parent / "Ep_One.vtt").exists())
            self.assertFalse((out.parent / "zh").exists())
            self.assertEqual(text, out.read_text(encoding="utf-8"))
            self.assertEqual(json.loads(text)["segments"][0]["body"], "Hi.\n嗨。")

    def test_publish_show_writes_json_and_no_zh_feed(self):
        document = {
            "guid": "g1",
            "title": "Ep One",
            "audio_seconds": 2.0,
            "sentences": [{"start": 0.0, "end": 1.0, "en": "Hi.", "zh": "嗨。",
                           "words": [{"w": "Hi.", "s": 0.0, "e": 1.0}]}],
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data = root / "data" / "pod"
            data.mkdir(parents=True)
            (data / "g1.json").write_text(json.dumps(document), encoding="utf-8")
            calls = []
            with patch.object(
                site.scraper, "generate_podcast_feed",
                lambda *a, **k: calls.append("feed"),
            ), patch.object(
                site.scraper, "generate_podcast_index",
                lambda *a, **k: calls.append("index"),
            ):
                result = site.publish_show(
                    {"slug": "pod"},
                    data_dir=root / "data",
                    site_dir=root / "site",
                    progress={"podcasts": {}},
                    site_base_url="https://pages.test",
                    podcast={"slug": "pod", "feed_url": "u", "language": "en"},
                )
            self.assertEqual(result["episodes"], 1)
            self.assertEqual(calls, ["feed", "index"])
            self.assertTrue(
                (root / "site" / "pod" / "transcripts" / "Ep_One.json").exists()
            )
            self.assertFalse((root / "site" / "pod" / "feed-zh.xml").exists())
```

同时把 `MergeTests.test_old_and_new_episodes_are_merged` 的最后两行断言改成：

```python
        self.assertEqual(merged["new"]["transcript_filename"], "New_Ep.json")
        self.assertEqual(merged["new"]["transcript_type"], "application/json")
        self.assertIn("skipped", merged, "旧记录原样保留，删不删由 feed 构建器决定")
```

并在 `MergeTests` 里追加：

```python
    def test_records_point_to_json_transcripts(self):
        progress = {"podcasts": {"pod": {"processed": {
            "old": {"vtt_filename": "Old.vtt", "skipped": False},
        }}}}
        merged = site.merged_processed(progress, "pod", {"new": "New_Ep"})
        self.assertEqual(merged["old"]["transcript_filename"], "Old.json")
        self.assertEqual(merged["old"]["transcript_type"], "application/json")
        self.assertEqual(merged["new"]["transcript_filename"], "New_Ep.json")
```

新建 `tests/test_publish_site.py`：

```python
import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location(
    "publish_site", ROOT / "scripts" / "publish_site.py"
)
ps = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ps)


class MergeProgressTests(unittest.TestCase):
    def test_merge_progress_records_json_transcript(self):
        progress = {"podcasts": {}}
        changed = ps.merge_progress(
            progress, "pod", [{"guid": "g1", "title": "T", "generated_at": "x"}],
            {"g1": "Ep_One"}, "https://pages.test",
        )
        self.assertEqual(changed, 1)
        entry = progress["podcasts"]["pod"]["processed"]["g1"]
        self.assertEqual(entry["transcript_filename"], "Ep_One.json")
        self.assertEqual(entry["transcript_type"], "application/json")
        self.assertEqual(entry["url"], "https://pages.test/pod/transcripts/Ep_One.json")
        self.assertEqual(entry["path"], "pod/transcripts/Ep_One.json")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `python tests/test_pipeline_site.py` 和 `python tests/test_publish_site.py`
Expected: 失败（仍写 VTT / 无 `transcript_filename`）

- [ ] **Step 3: 改 `pipeline_site.py`**

- 顶部 import 加 `import word_transcript`（与 `import scraper` 同一段 sys.path 之后）；
- 删除 `_timestamp`、`render_english`、`_bilingual`、`status_entry`；
- `write_episode`：

```python
def write_episode(document, site_dir: Path, slug: str, stem: str) -> str:
    """写词级 JSON，返回文本（供需要指纹的调用方使用）。"""
    text = word_transcript.dumps(document)
    target = Path(site_dir) / slug / "transcripts" / f"{stem}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(target)
    return text
```

- `merged_processed`：

```python
def merged_processed(progress: dict, slug: str, stems: dict[str, str]) -> dict:
    """老 progress 的条目 + 本管线产出的集，统一指向 JSON。"""
    old = {}
    for guid, info in (
        ((progress.get("podcasts") or {}).get(slug) or {}).get("processed") or {}
    ).items():
        item = dict(info)
        vtt = item.get("vtt_filename")
        if vtt:
            item["transcript_filename"] = f"{Path(vtt).stem}.json"
            item["transcript_type"] = "application/json"
        old[guid] = item
    for guid, stem in stems.items():
        item = dict(old.get(guid) or {})
        item["transcript_filename"] = f"{stem}.json"
        item["transcript_type"] = "application/json"
        item.pop("skipped", None)
        old[guid] = item
    return old
```

- `publish_show`：

```python
def publish_show(show, *, data_dir, site_dir, progress, site_base_url, podcast) -> dict:
    """发布一个节目：导出词级 JSON → 建 feed → 建 index（单 feed）。"""
    slug = show["slug"]
    processed = merged_processed(progress, slug, {})
    documents = load_documents(data_dir, slug)
    stems = {}
    for document in documents:
        stems[document["guid"]] = stem_for(document, slug, processed)
    word_transcript.export_show(data_dir, site_dir, slug, stems)

    merged = merged_processed(progress, slug, stems)
    scraper.SITE_DIR = Path(site_dir)
    scraper.generate_podcast_feed({"processed": merged}, podcast, site_base_url)
    scraper.generate_podcast_index({"processed": merged}, podcast, site_base_url)
    return {"episodes": len(documents), "stems": stems}
```

- [ ] **Step 4: 改 `publish_site.py`**

- `merge_progress` 的 `merged` 改成：

```python
        merged = {
            "title": document.get("title", ""),
            "url": f"{base_url.rstrip('/')}/{slug}/transcripts/{stem}.json",
            "path": f"{slug}/transcripts/{stem}.json",
            "completed_at": document.get("generated_at", ""),
            "transcript_filename": f"{stem}.json",
            "transcript_type": "application/json",
        }
```

- `main()` 删除 `translations.json` 的读取、`merge_translations`、`status` 参数与写回；
  `publish_show` 调用去掉 `status=`；
- `merge_translations` 函数删除；
- 打印改为：

```python
    print(f"{args.slug}: 发布 {result['episodes']} 集（词级 JSON），progress 更新 {progress_changed} 条")
```

- 模块 docstring 改成“词级 JSON → feed.xml → index.html（单 feed）”。

- [ ] **Step 5: 运行测试**

Run: `python tests/test_pipeline_site.py && python tests/test_publish_site.py`
Expected: `OK`（两个文件都输出 OK）

- [ ] **Step 6: 提交（获得用户授权后）**

```bash
git add scripts/pipeline_site.py scripts/publish_site.py tests/test_pipeline_site.py tests/test_publish_site.py
git commit -m "feat: publish word-level JSON transcripts instead of VTT"
```

---

### Task 3: feed 生成器认 JSON，归档后仍识别已处理

**Files:**
- Modify: `scripts/scraper.py:521-530`（`is_episode_processed`）、`scripts/scraper.py:778-807`（标签）
- Test: `tests/test_scraper_utils.py`

**Interfaces:**
- Consumes: progress 记录里的 `transcript_filename`、`transcript_type`
- Produces: `<podcast:transcript type="application/json">`；`is_episode_processed(info, slug)` 对 JSON 文件返回 True

- [ ] **Step 1: 写失败测试**

在 `tests/test_scraper_utils.py` 的 `FeedWriteTests` 后追加：

```python
class TranscriptFormatTests(unittest.TestCase):
    def _feed(self):
        return etree.fromstring(
            (
                "<rss><channel><title>Show</title><item><guid>g0</guid>"
                '<enclosure url="https://cdn.test/a.mp3" type="audio/mpeg"/>'
                "</item></channel></rss>"
            ).encode("utf-8")
        )

    def test_tag_points_to_json_when_record_says_so(self):
        original_cwd = os.getcwd()
        with tempfile.TemporaryDirectory() as temp_dir:
            os.chdir(temp_dir)
            try:
                site_dir = Path("site")
                transcripts = site_dir / "pod" / "transcripts"
                transcripts.mkdir(parents=True)
                (transcripts / "one.json").write_text(
                    '{"version":"1.0.0","segments":[{"startTime":0,'
                    '"endTime":1,"body":"hi"}]}',
                    encoding="utf-8",
                )
                pc = {"processed": {"g0": {
                    "title": "one",
                    "transcript_filename": "one.json",
                    "transcript_type": "application/json",
                }}}
                with patch.object(scraper, "fetch_rss", lambda url: self._feed()), patch.object(
                    scraper, "SITE_DIR", site_dir
                ):
                    scraper.generate_podcast_feed(
                        pc,
                        {"slug": "pod", "feed_url": "https://feed.test/x", "language": "en"},
                        "https://pages.test",
                    )
                feed = etree.parse("site/pod/feed.xml")
                node = feed.xpath("//*[local-name()='transcript']")[0]
                self.assertTrue(node.get("url").endswith("/transcripts/one.json"))
                self.assertEqual(node.get("type"), "application/json")
                self.assertEqual(node.get("language"), "en")
            finally:
                os.chdir(original_cwd)

    def test_is_episode_processed_accepts_valid_json(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            site_dir = Path(temp_dir)
            transcripts = site_dir / "pod" / "transcripts"
            transcripts.mkdir(parents=True)
            (transcripts / "one.json").write_text(
                '{"segments":[{"startTime":0,"endTime":1,"body":"hi"}]}',
                encoding="utf-8",
            )
            with patch.object(scraper, "SITE_DIR", site_dir):
                info = {"transcript_filename": "one.json",
                        "transcript_type": "application/json"}
                self.assertTrue(scraper.is_episode_processed(info, "pod"))

    def test_is_episode_processed_rejects_broken_json(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            site_dir = Path(temp_dir)
            transcripts = site_dir / "pod" / "transcripts"
            transcripts.mkdir(parents=True)
            (transcripts / "one.json").write_text("{not json", encoding="utf-8")
            with patch.object(scraper, "SITE_DIR", site_dir):
                info = {"transcript_filename": "one.json",
                        "transcript_type": "application/json"}
                self.assertFalse(scraper.is_episode_processed(info, "pod"))
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `python tests/test_scraper_utils.py`
Expected: 失败（仍要求 `vtt_filename`）

- [ ] **Step 3: 实现**

`is_episode_processed` 改为：

```python
def is_episode_processed(info, slug):
    if not info or info.get("skipped"):
        return False
    filename = info.get("transcript_filename") or info.get("vtt_filename")
    if not filename:
        return False
    path = vtt_path_for(slug, filename)
    if not path.exists() or path.stat().st_size < 10:
        return False
    if info.get("transcript_type") == "application/json" or filename.endswith(".json"):
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return False
        return isinstance(document.get("segments"), list) and bool(document["segments"])
    try:
        return path.read_text(encoding="utf-8-sig").lstrip().startswith("WEBVTT")
    except Exception:
        return False
```

标签部分（`generate_podcast_feed` 里）：

```python
        filename = info.get("transcript_filename") or info.get("vtt_filename")
        if not filename:
            channel.remove(item)
            removed += 1
            continue
        transcript_url = public_url(base_url, slug, "transcripts", filename)
        transcript_type = info.get("transcript_type") or "text/vtt"
```

把原来两处 `vtt_url` 改名为 `transcript_url`，`matching.set("type", transcript_type)`。

确认 `scraper.py` 顶部已 `import json`（已有，用于 progress 读写）。

- [ ] **Step 4: 运行测试**

Run: `python tests/test_scraper_utils.py`
Expected: `OK`

- [ ] **Step 5: 提交（获得用户授权后）**

```bash
git add scripts/scraper.py tests/test_scraper_utils.py
git commit -m "feat: point feed transcript tags at word-level JSON"
```

---

### Task 4: transcribe 导出 hwmym 的 JSON 并切换链接

**Files:**
- Modify: `scripts/transcribe.py`（imports、`add_transcript_tag`、新 `sync_data_transcripts`、`public_url_for`、`main`、`build_podcast_index` 文案）
- Test: `tests/test_transcribe_utils.py`

**Interfaces:**
- Consumes: `word_transcript.export_show`、`pipeline_store.episode_path`
- Produces:
  - `transcribe.sync_data_transcripts(records, data_dir, site_dir, slug) -> (written: int, switched: int)`
  - `transcribe.has_word_json(data_dir, slug, identity) -> bool`
  - `add_transcript_tag` 按 URL 后缀写 `application/json` 或 `text/vtt`

- [ ] **Step 1: 写失败测试**

在 `tests/test_transcribe_utils.py` 的 `TranscriptTagTests` 追加：

```python
    def test_json_url_sets_json_type(self):
        item = etree.fromstring(
            '<item xmlns:podcast="https://podcastindex.org/namespace/1.0"></item>'
        )
        transcriber.add_transcript_tag(
            item, "https://example.test/transcripts/new.json"
        )
        node = item.find("{https://podcastindex.org/namespace/1.0}transcript")
        self.assertEqual(node.get("type"), "application/json")

    def test_vtt_url_keeps_vtt_type(self):
        item = etree.fromstring(
            '<item xmlns:podcast="https://podcastindex.org/namespace/1.0"></item>'
        )
        transcriber.add_transcript_tag(
            item, "https://example.test/transcripts/new.vtt"
        )
        node = item.find("{https://podcastindex.org/namespace/1.0}transcript")
        self.assertEqual(node.get("type"), "text/vtt")
```

新建测试类（放在文件末尾、`if __name__` 之前）：

```python
class WordJsonSyncTests(unittest.TestCase):
    def test_export_and_switch_urls_only_for_episodes_with_data(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data_dir = root / "data"
            site_dir = root / "site"
            show = data_dir / "pod"
            show.mkdir(parents=True)
            document = {
                "guid": "g1",
                "audio_seconds": 2.0,
                "sentences": [{"start": 0.0, "end": 1.0, "en": "Hi.",
                               "words": [{"w": "Hi.", "s": 0.0, "e": 1.0}]}],
            }
            (show / "g1.json").write_text(json.dumps(document), encoding="utf-8")
            records = {
                "g1": {"path": "pod/transcripts/Old.vtt", "url": "https://x/Old.vtt"},
                "g2": {"path": "pod/transcripts/Other.vtt", "url": "https://x/Other.vtt"},
            }
            old_base = transcriber.BASE_URL
            transcriber.BASE_URL = "https://pages.test"
            try:
                written, switched = transcriber.sync_data_transcripts(
                    records, data_dir=data_dir, site_dir=site_dir, slug="pod"
                )
            finally:
                transcriber.BASE_URL = old_base
            self.assertEqual((written, switched), (1, 1))
            out = site_dir / "pod" / "transcripts" / "Old.json"
            self.assertTrue(out.exists())
            self.assertEqual(
                records["g1"]["url"], "https://pages.test/pod/transcripts/Old.json"
            )
            self.assertEqual(records["g2"]["url"], "https://x/Other.vtt")
```

测试文件顶部若没有 `import json`，补上。

- [ ] **Step 2: 运行测试，确认失败**

Run: `python tests/test_transcribe_utils.py`
Expected: `AttributeError: sync_data_transcripts` / type 断言失败

- [ ] **Step 3: 实现**

`scripts/transcribe.py`：

- imports 增加：

```python
import pipeline_store as store
import word_transcript
```

- `add_transcript_tag` 里两处 `node.set("type", "text/vtt")` 改为：

```python
    transcript_type = "application/json" if url.lower().endswith(".json") else "text/vtt"
```

并 `node.set("type", transcript_type)`。

- 新增辅助函数（放在 `make_public_url` 附近）：

```python
def public_url_for(path: Path, site_dir: Path) -> str:
    rel = Path(path).relative_to(Path(site_dir)).as_posix()
    encoded = "/".join(quote(part, safe="-._~") for part in rel.split("/"))
    return f"{BASE_URL}/{encoded}" if BASE_URL else encoded


def has_word_json(data_dir, slug: str, identity: str) -> bool:
    return store.episode_path(Path(data_dir), slug, identity).exists()


def sync_data_transcripts(records, *, data_dir, site_dir, slug) -> tuple[int, int]:
    """给有 data JSON 的集导出站点 JSON，并把记录 URL 切过去。"""
    stems = {}
    for identity, record in records.items():
        path = (record.get("path") or "").strip()
        if path:
            stems[identity] = Path(path).stem
    written = word_transcript.export_show(data_dir, site_dir, slug, stems)
    switched = 0
    for identity, record in records.items():
        stem = stems.get(identity)
        if not stem or not has_word_json(data_dir, slug, identity):
            continue
        url = public_url_for(
            Path(site_dir) / slug / "transcripts" / f"{stem}.json", site_dir
        )
        if record.get("url") != url:
            record["url"] = url
            switched += 1
    return written, switched
```

- `make_public_url(path)` 改为复用：

```python
def make_public_url(path: Path) -> str:
    return public_url_for(path, SITE_DIR)
```

- `main()` 缓存判断（约 2105 行）：

```python
        path = get_existing_path(identity, processed, records)
        cached = bool(
            processed.get(identity)
            and path
            and path.exists()
            and is_valid_bilingual_vtt(path)
        ) or bool(processed.get(identity) and has_word_json(DATA_DIR, PODCAST_SLUG, identity))
        if cached:
            ...
```

- 顶部常量区加 `DATA_DIR = Path(os.getenv("DATA_DIR", "data"))`（`SITE_DIR` 定义之后）。

- `main()` 末尾、`make_enhanced_feed` 之前：

```python
    try:
        written, switched = sync_data_transcripts(
            records, data_dir=DATA_DIR, site_dir=SITE_DIR, slug=PODCAST_SLUG
        )
        if written:
            log.info("已导出词级 JSON：%d 集；transcript 链接切换 %d 条", written, switched)
    except Exception:
        log.exception("词级 JSON 导出失败；继续使用旧 VTT 链接")
```

- `build_podcast_index` 的说明文案：
  `英文原文与简体中文译文合并显示的 WebVTT 字幕。` →
  `英文原文与简体中文译文合并显示的词级字幕（JSON）。`

- [ ] **Step 4: 运行测试**

Run: `python tests/test_transcribe_utils.py`
Expected: `OK`

- [ ] **Step 5: 相关回归**

Run: `python tests/test_align_timings.py && python tests/test_translate_vtt.py`
Expected: 两个都 `OK`（这些流程不读新字段，应无影响）

- [ ] **Step 6: 提交（获得用户授权后）**

```bash
git add scripts/transcribe.py tests/test_transcribe_utils.py
git commit -m "feat: serve hwmym transcripts as word-level JSON"
```

---

### Task 5: 一次性迁移 CLI（stem 解析 + 导出）

**Files:**
- Create: `scripts/export_word_json.py`
- Test: `tests/test_export_word_json.py`

**Interfaces:**
- Produces:
  - `stems_from_progress(path, slug) -> dict[guid, stem]`
  - `stems_from_state(path, slug) -> dict[identity, stem]`
  - CLI：`python scripts/export_word_json.py <slug> [--data-dir data] [--site-dir site] [--progress progress.json | --state state.json]`

- [ ] **Step 1: 写失败测试**

```python
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location(
    "export_word_json", ROOT / "scripts" / "export_word_json.py"
)
cli = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cli)


class StemTests(unittest.TestCase):
    def test_stems_from_progress_use_existing_vtt_names(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "progress.json"
            path.write_text(json.dumps({"podcasts": {"pod": {"processed": {
                "g1": {"vtt_filename": "Ep One.vtt"},
                "g2": {"skipped": True},
            }}}}), encoding="utf-8")
            self.assertEqual(cli.stems_from_progress(path, "pod"), {"g1": "Ep One"})

    def test_stems_from_state_use_record_paths(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "state.json"
            path.write_text(json.dumps({"podcasts": {"pod": {"transcripts": [
                {"identity": "g1", "path": "pod/transcripts/Ep One.vtt"},
                {"identity": "g2"},
            ]}}}), encoding="utf-8")
            self.assertEqual(cli.stems_from_state(path, "pod"), {"g1": "Ep One"})


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `python tests/test_export_word_json.py`
Expected: 模块不存在

- [ ] **Step 3: 实现**

```python
"""把 data/<slug>/*.json 导出为站点词级 JSON（一次性迁移或手动补导出）。

用法：
  python scripts/export_word_json.py office-ladies --progress progress.json
  python scripts/export_word_json.py how-we-made-your-mother --state state.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import word_transcript  # noqa: E402


def _load(path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def stems_from_progress(path, slug: str) -> dict[str, str]:
    data = _load(path)
    processed = ((data.get("podcasts") or {}).get(slug) or {}).get("processed") or {}
    return {
        guid: Path(info["vtt_filename"]).stem
        for guid, info in processed.items()
        if info.get("vtt_filename")
    }


def stems_from_state(path, slug: str) -> dict[str, str]:
    data = _load(path)
    records = ((data.get("podcasts") or {}).get(slug) or {}).get("transcripts") or []
    return {
        record["identity"]: Path(record["path"]).stem
        for record in records
        if record.get("identity") and record.get("path")
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("slug")
    parser.add_argument("--data-dir", type=Path, default=Path("data"))
    parser.add_argument("--site-dir", type=Path, default=Path("site"))
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--progress", type=Path)
    group.add_argument("--state", type=Path)
    args = parser.parse_args(argv)

    if args.progress:
        stems = stems_from_progress(args.progress, args.slug)
    else:
        stems = stems_from_state(args.state, args.slug)
    written = word_transcript.export_show(
        args.data_dir, args.site_dir, args.slug, stems
    )
    total = sum(
        path.stat().st_size
        for path in (args.site_dir / args.slug / "transcripts").glob("*.json")
    )
    print(f"{args.slug}: 导出 {written} 集，JSON 共 {total / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: 运行测试**

Run: `python tests/test_export_word_json.py`
Expected: `OK`

- [ ] **Step 5: 提交（获得用户授权后）**

```bash
git add scripts/export_word_json.py tests/test_export_word_json.py
git commit -m "feat: add word JSON export CLI for the migration"
```

---

### Task 6: 执行一次性数据迁移

**Files:**
- Modify: `site/office-ladies/**`、`site/how-we-made-your-mother/**`（移走 VTT、删 feed-zh）
- Modify: `data/office-ladies/legacy-vtt/**`、`data/how-we-made-your-mother/legacy-vtt/**`（新增归档）
- Modify: `json/office-ladies/**`、`json/how-we-made-your-mother/**`（新增 618 个）
- Modify: `podcasts_translate.json`

**Interfaces:**
- Consumes: Task 5 的 CLI、Task 2/4 的发布逻辑（由后续 job 重建 feed）

- [ ] **Step 1: 归档 VTT**

```bash
mkdir -p data/office-ladies/legacy-vtt/zh
git mv site/office-ladies/transcripts/*.vtt data/office-ladies/legacy-vtt/
git mv site/office-ladies/transcripts/zh/*.vtt data/office-ladies/legacy-vtt/zh/
rmdir site/office-ladies/transcripts/zh

mkdir -p data/how-we-made-your-mother/legacy-vtt/zh
git mv site/how-we-made-your-mother/transcripts/*.vtt data/how-we-made-your-mother/legacy-vtt/
git mv site/how-we-made-your-mother/transcripts/zh/*.vtt data/how-we-made-your-mother/legacy-vtt/zh/
rmdir site/how-we-made-your-mother/transcripts/zh
```

- [ ] **Step 2: 确认数量**

```bash
ls data/office-ladies/legacy-vtt/*.vtt | wc -l        # 期望 497
ls data/office-ladies/legacy-vtt/zh/*.vtt | wc -l     # 期望 497
ls data/how-we-made-your-mother/legacy-vtt/*.vtt | wc -l   # 期望 121
ls data/how-we-made-your-mother/legacy-vtt/zh/*.vtt | wc -l # 期望 121
ls site/office-ladies/transcripts/*.vtt 2>/dev/null | wc -l      # 期望 0
ls site/how-we-made-your-mother/transcripts/*.vtt 2>/dev/null | wc -l # 期望 0
```

- [ ] **Step 3: 导出 JSON**

```bash
python scripts/export_word_json.py office-ladies --progress progress.json
python scripts/export_word_json.py how-we-made-your-mother --state state.json
ls json/office-ladies/*.json | wc -l               # 期望 497
ls json/how-we-made-your-mother/*.json | wc -l     # 期望 121
du -sm json site   # 期望约 370 / 650 MB
```

JSON 不进 Pages（实测 1,070 MB 超限），由 raw.githubusercontent 提供。

若 `state.json` 不在根目录，先确认 hwmym 的 state 文件位置（`ls state.json`）；缺失时改用
`--progress progress.json`（hwmym 的 progress 不在 progress.json 时，先用 Task 4 的 transcribe 导出，
再跳过本步）。

- [ ] **Step 4: 删 zh feed、移除 hwmym 的旧翻译归属**

```bash
git rm site/office-ladies/feed-zh.xml site/how-we-made-your-mother/feed-zh.xml
python - <<'PY'
import json
path = "podcasts_translate.json"
items = json.load(open(path, encoding="utf-8"))
items = [item for item in items if item.get("slug") != "how-we-made-your-mother"]
open(path, "w", encoding="utf-8").write(json.dumps(items, ensure_ascii=False, indent=2) + chr(10))
print("remaining", len(items))
PY
```

期望输出 `remaining 11`。注意：这里用真实换行会破坏 heredoc，`chr(10)` 已按仓库惯例。

- [ ] **Step 5: 校验结构**

```bash
python - <<'PY'
import json, glob, os
total = 0
for slug in ("office-ladies", "how-we-made-your-mother"):
    files = glob.glob(f"json/{slug}/*.json")
    assert len(files) == (497 if slug == "office-ladies" else 121), (slug, len(files))
    for path in files:
        doc = json.loads(open(path, encoding="utf-8").read())
        assert doc["version"] == "1.0.0", path
        assert isinstance(doc["segments"], list) and doc["segments"], path
        for seg in doc["segments"]:
            assert isinstance(seg["start"], int) and isinstance(seg["end"], int), path
            assert seg["end"] > seg["start"], path
            starts = [w[1] for w in seg["words"]]
            assert starts == sorted(starts), path
        total += os.path.getsize(path)
print("files ok; total MB", round(total / 1e6, 1))
PY
```

Expected: `files ok; total MB 386.3`。

- [ ] **Step 6: 全量测试**

Run:

```bash
for f in tests/test_*.py; do python "$f" || { echo "FAIL $f"; exit 1; }; done; echo ALL OK
```

Expected: `ALL OK`

- [ ] **Step 7: 提交（获得用户授权后）**

```bash
git add data/office-ladies/legacy-vtt data/how-we-made-your-mother/legacy-vtt
git add json/office-ladies json/how-we-made-your-mother
git add site/office-ladies site/how-we-made-your-mother podcasts_translate.json \
        .github/workflows/transcripts.yml
git commit -m "chore: archive legacy VTTs and publish word-level JSON"
```

---

### Task 7: 文档与本地端到端验证

**Files:**
- Modify: `docs/handover.md`（§十一）
- Modify: `AGENTS.md`（文件归属表）
- Verify: 站点与 feed 结构

- [ ] **Step 1: 更新 docs/handover.md**

在 §十一 增加：

```markdown
### 词级 JSON 字幕（2026-11-02）

- 已迁移节目（office-ladies、hwmym）的 transcript 是仓库里的
  `json/<slug>/<stem>.json`，由 raw.githubusercontent 直接提供（不进 Pages）；
- JSON = Podcasting 2.0 官方字段（`version`、`segments[].startTime/endTime/body`，秒）
  + AntennaPod 词级扩展（`segments[].start/end/text/words`，毫秒）；
- 每集一个双语文件，`body/text` 是「英文句 + 换行 + 中文句」；`words` 只含英文词；
- 已迁移节目只保留 `feed.xml`，不再生成 `feed-zh.xml`；
- 旧 VTT 原样归档在 `data/<slug>/legacy-vtt/`（含 `zh/`），不再发布；
- 导出只读 `data/`，publish job（office-ladies）与 transcribe job（hwmym）各自负责。
```

- [ ] **Step 2: 更新 AGENTS.md 表格**

把 Transcript Pipeline 那一行的产物描述改为：

```markdown
| `data/**`、已迁移节目的 `json/<slug>/*.json`、`feed.xml`、`index.html`、`progress.json` | Transcript Pipeline（`transcripts.yml`） | ✅ |
```

- [ ] **Step 3: 本地验证 feed 生成（不推 CI）**

```bash
python - <<'PY'
import json, sys
sys.path.insert(0, "scripts")
import publish_site, pipeline_site
from pathlib import Path

progress = {"podcasts": {}}
feeds = json.load(open("feeds.json", encoding="utf-8"))
show = next(s for s in feeds if s["slug"] == "office-ladies")
podcasts = json.load(open("podcasts.json", encoding="utf-8"))
result = pipeline_site.publish_show(
    show,
    data_dir=Path("data"),
    json_dir=Path("json"),
    site_dir=Path("site"),
    progress=progress,
    site_base_url="https://lzoreal.github.io/MyTranscript",
    podcast=publish_site.podcast_config(show, podcasts),
)
print(result["episodes"])
PY
python - <<'PY'
import re
text = open("site/office-ladies/feed.xml", encoding="utf-8").read()
tags = re.findall(r'<podcast:transcript[^>]*>', text)
print("tags", len(tags))
print("json tags", sum('type="application/json"' in t for t in tags))
print("raw urls", sum('raw.githubusercontent.com/lzoreal/MyTranscript/main/json/' in t for t in tags))
print("vtt tags", sum('text/vtt' in t for t in tags))
print("items", text.count("<item>"))
PY
```

Expected: `497`；`tags 497`；`json tags 497`；`raw urls 497`；`vtt tags 0`；`items 497`。
这一步会重写 site 文件（feed 时间戳变化），属预期。

- [ ] **Step 4: 检查 hwmym 的 record URL 切换（离线）**

`transcribe.py` 需要真实 RSS 才会跑 main；这里只验证纯函数：

```bash
python - <<'PY'
import json, sys
sys.path.insert(0, "scripts")
import transcribe
from pathlib import Path

records = {
    "gid-1": {"path": "how-we-made-your-mother/transcripts/Some Episode.vtt",
              "url": "https://lzoreal.github.io/MyTranscript/how-we-made-your-mother/transcripts/Some%20Episode.vtt"}
}
# 找一个真实 guid：state.json 里第一条
state = json.load(open("state.json", encoding="utf-8"))
real = next(r for r in state["podcasts"]["how-we-made-your-mother"]["transcripts"] if r.get("identity"))
records = {real["identity"]: dict(real)}
written, switched = transcribe.sync_data_transcripts(
    records,
    data_dir=Path("data"),
    json_dir=Path("json"),
    slug="how-we-made-your-mother",
)
print("written", written, "switched", switched)
print(records[real["identity"]]["url"])
PY
```

Expected: `written 121`、`switched 1`、URL 指向 `raw.githubusercontent.com/.../json/`。

- [ ] **Step 5: 全量测试 + YAML 校验**

```bash
for f in tests/test_*.py; do python "$f" || { echo "FAIL $f"; exit 1; }; done; echo ALL OK
python -c "import yaml; yaml.safe_load(open('.github/workflows/transcripts.yml',encoding='utf-8')); print('yaml ok')"
```

Expected: `ALL OK`、`yaml ok`

- [ ] **Step 6: 提交（获得用户授权后）**

```bash
git add docs/handover.md AGENTS.md site/office-ladies site/how-we-made-your-mother
git commit -m "docs: describe word-level JSON transcripts"
```

---

### Task 8: CI 发布验证（推送后）

**Files:** 无代码改动；验证线上产物。

- [ ] **Step 1: 推送并等待部署**

推送 main 后，`deploy.yml` 因 `site/**` 变更触发；等它 `completed/success`。

- [ ] **Step 2: 触发 office-ladies 发布**

```bash
# 用 REST 触发（仓库现有做法）
python - <<'PY'
import json, subprocess, urllib.request
out = subprocess.run(["git", "credential", "fill"], input="protocol=https\nhost=github.com\n\n",
                     capture_output=True, text=True, check=True).stdout
pat = next(l.split("=", 1)[1] for l in out.splitlines() if l.startswith("password="))
req = urllib.request.Request(
    "https://api.github.com/repos/lzoreal/MyTranscript/actions/workflows/transcripts.yml/dispatches",
    method="POST",
    data=json.dumps({"ref": "main", "inputs": {"only_slug": "office-ladies",
                                               "shards": "20", "max_minutes": "45"}}).encode(),
    headers={"Authorization": f"token {pat}", "Accept": "application/vnd.github+json",
             "Content-Type": "application/json"},
)
urllib.request.urlopen(req)
print("dispatched")
PY
```

- [ ] **Step 3: 核对线上**

```bash
python - <<'PY'
import urllib.request
base = "https://lzoreal.github.io/MyTranscript/office-ladies"
feed = urllib.request.urlopen(base + "/feed.xml", timeout=60).read().decode()
print("items", feed.count("<item>"))
print("json tags", feed.count('type="application/json"'))
print("vtt tags", feed.count('type="text/vtt"'))
for name in ("Office_Olympics_w_Paul_Feig.json",):
    body = urllib.request.urlopen(
        "https://raw.githubusercontent.com/lzoreal/MyTranscript/main/json/office-ladies/" + name,
        timeout=60,
    ).read()
    print(name, len(body), body[:15])
try:
    urllib.request.urlopen(base + "/feed-zh.xml", timeout=30)
    print("feed-zh still present")
except Exception as exc:
    print("feed-zh gone:", type(exc).__name__)
PY
```

Expected: `items 497`、`json tags 497`、`vtt tags 0`、raw JSON 200 且以 `{"version":"1.0.0"` 开头、
`feed-zh gone: HTTPError`。

- [ ] **Step 4: 核对 hwmym**

手动 dispatch `transcribe.yml`（`backfill` 不填），等它结束后：

```bash
python - <<'PY'
import urllib.request
feed = urllib.request.urlopen(
    "https://lzoreal.github.io/MyTranscript/how-we-made-your-mother/feed.xml", timeout=60
).read().decode()
print("items", feed.count("<item>"), "json", feed.count('type="application/json"'))
PY
```

Expected: `items 121 json 121`。

- [ ] **Step 5: 核对 Pages 体积与未迁移节目**

- Actions 的 Pages 部署日志里没有 1 GB 超限错误；
- `site/smartless/feed.xml` 的 transcript 标签仍含 `type="text/vtt"`，URL 未变。

---

## Self-Review

- **Spec 覆盖**：产物路径/格式（T1、T6）、feed 单标签与单 feed（T2、T3、T6）、
  数据流与写权限（T2、T4）、归档（T6）、错误处理（T1 跳过坏句、T3 JSON 校验、T4 导出异常回退）、
  测试与验收（T1–T5 单测、T7 本地端到端、T8 线上）。
- **占位符**：无 TBD/TODO；每一步都有命令与期望输出。
- **类型一致性**：`export_show(data_dir, json_dir, slug, stems) -> int`、
  `sync_data_transcripts(records, *, data_dir, json_dir, slug) -> (written, switched)`、
  `merged_processed` 新增字段名 `transcript_filename` / `transcript_type` 在 T2、T3、T4 一致。
- **隐藏风险已纳入**：T3 的 `is_episode_processed`（否则归档后 feed 会清空）、
  T4 的缓存判断（否则 hwmym 会被整批重转）都是归档 VTT 后必须同步改的地方。
