# hwmym 词级时间戳 · CI 分片回填 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 hwmym 的 119 集用 turbo 重转一遍，产出 `site/how-we-made-your-mother/timings/<vtt 同名>.json`，且分批任务可在 CI 上分片、断点续跑、按 key 轮换绕开 Gemini 配额。

**Architecture:** 同一个 `scripts/transcribe.py` 增加"回填模式"入口：按 `sha1(identity) % shards` 分片，以 sidecar 文件为唯一断点真相；分片只写 VTT 与 sidecar，不碰 `state.json`/`feed.xml`/`index.html`；Gemini 轮换由进程内的 `GeminiKeyRing` 承担，全 key 耗尽时该分片干净退出（退出码 0）。

**Tech Stack:** Python 3.11（CI）/ 3.10（本机跑 Whisper）、faster-whisper + CTranslate2（turbo, int8）、google-genai、lxml、GitHub Actions（matrix + actions/cache）。

**Spec:** `docs/superpowers/specs/2026-10-28-hwmym-word-timestamps-backfill-design.md`

## Global Constraints

- CI 用 Python **3.11**；本机跑测试用系统 `python`（3.14），跑 Whisper 相关命令用 `C:\Users\游梦\AppData\Local\Programs\Python\Python310\python.exe`。
- **绝不打印 API key**：日志只允许 `#<序号>（…<末4位>）`。
- 回填模式**不得**写 `state.json`、`feed.xml`、`index.html`。
- 模型目录固定 `models/ct2-turbo`，缓存 key 固定 `ct2-turbo-v1`；回填模式下模型缺失必须 `exit 1`，**不得回退 base.en**。
- sidecar 结构固定为 TMLT 结构：`{episode, audio_seconds, complete, attempts, segments:[{start,end,speaker,text,words:[[词,起始ms,时长ms]]}]}`；紧凑 JSON（`separators=(",",":")`）。
- 单元测试不联网：所有网络调用必须能被注入或 patch。
- **提交策略**：本计划中的 commit 步骤在用户明确说"提交"后才执行；之前只允许改文件、跑测试。

---

### Task 1: Gemini key 解析与轮换环

**Files:**
- Modify: `scripts/transcribe.py`（在 `GEMINI_API_KEY` 常量后新增）
- Test: `tests/test_transcribe_utils.py`

**Interfaces:**
- Consumes: `genai.Client`（可注入工厂）
- Produces:
  - `parse_gemini_keys(raw: str) -> list[str]`
  - `class QuotaExhausted(RuntimeError)`
  - `class GeminiKeyRing: __init__(keys: list[str], factory=None); available -> bool; label() -> str; current() -> str; client(); mark_exhausted() -> bool`

- [ ] **Step 1: 写失败测试**

```python
class GeminiKeyRingTests(unittest.TestCase):
    def test_parse_splits_and_dedupes(self):
        self.assertEqual(
            transcriber.parse_gemini_keys("k1, k2\nk3 ,k1"),
            ["k1", "k2", "k3"],
        )
        self.assertEqual(transcriber.parse_gemini_keys("   "), [])

    def test_ring_starts_at_first_key_and_rotates(self):
        made = []
        ring = transcriber.GeminiKeyRing(
            ["key-aaaa", "key-bbbb"], factory=lambda api_key: made.append(api_key) or object()
        )
        self.assertEqual(ring.current(), "key-aaaa")
        self.assertIn("aaaa", ring.label())
        self.assertNotIn("key-aaaa", ring.label(), "日志标签不能泄露完整 key")
        ring.client()
        ring.client()
        self.assertEqual(made, ["key-aaaa"], "同一个 key 只建一次 client")
        self.assertTrue(ring.mark_exhausted())
        self.assertEqual(ring.current(), "key-bbbb")
        self.assertEqual(made, ["key-aaaa"])

    def test_ring_raises_when_every_key_is_exhausted(self):
        ring = transcriber.GeminiKeyRing(["only-key"], factory=lambda api_key: object())
        self.assertFalse(ring.mark_exhausted())
        self.assertFalse(ring.available)
        with self.assertRaises(transcriber.QuotaExhausted):
            ring.current()
        with self.assertRaises(transcriber.QuotaExhausted):
            ring.client()
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_transcribe_utils.py`
Expected: ERROR `module 'transcribe' has no attribute 'parse_gemini_keys'`

- [ ] **Step 3: 实现**

```python
GEMINI_API_KEYS_RAW = os.getenv("GEMINI_API_KEYS", "").strip()


def parse_gemini_keys(raw: str) -> list[str]:
    keys: list[str] = []
    for part in re.split(r"[,\s]+", raw or ""):
        key = part.strip()
        if key and key not in keys:
            keys.append(key)
    return keys


GEMINI_KEYS = parse_gemini_keys(GEMINI_API_KEYS_RAW) or (
    [GEMINI_API_KEY] if GEMINI_API_KEY else []
)


class QuotaExhausted(RuntimeError):
    """所有 Gemini key 都用尽；调用方应停止本轮、下轮再续。"""


class GeminiKeyRing:
    """顺序轮换 key：同一时刻只用一把，耗尽就切下一把，全部耗尽即不可用。

    轮换状态只活在进程内——配额按天重置，跨轮沿用会把恢复的 key 永久排除。
    """

    def __init__(self, keys: list[str], factory=None):
        if not keys:
            raise QuotaExhausted("没有任何可用的 Gemini key")
        self._keys = list(keys)
        self._clients: dict[str, Any] = {}
        self._index = 0
        self._factory = factory or (lambda api_key: genai.Client(api_key=api_key))
        self.requests = 0

    @property
    def available(self) -> bool:
        return self._index < len(self._keys)

    def label(self) -> str:
        key = self._keys[self._index]
        tail = key[-4:] if len(key) > 4 else "****"
        return f"#{self._index + 1}（…{tail}）"

    def current(self) -> str:
        if not self.available:
            raise QuotaExhausted("所有 Gemini key 都已耗尽")
        return self._keys[self._index]

    def client(self):
        if not self.available:
            raise QuotaExhausted("所有 Gemini key 都已耗尽")
        key = self._keys[self._index]
        if key not in self._clients:
            self._clients[key] = self._factory(api_key=key)
        return self._clients[key]

    def mark_exhausted(self) -> bool:
        self._index += 1
        return self.available
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_transcribe_utils.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认后再执行）**

```bash
git add scripts/transcribe.py tests/test_transcribe_utils.py
git commit -m "feat: add Gemini key ring with sequential rotation"
```

---

### Task 2: 配额错误分类与翻译路径轮换

**Files:**
- Modify: `scripts/transcribe.py`（`create_gemini_client` / `translate_blocks` / `translate_cues_with_gemini`）
- Test: `tests/test_transcribe_utils.py`

**Interfaces:**
- Consumes: `GeminiKeyRing`（Task 1）
- Produces:
  - `is_quota_error(exc: Exception) -> bool`
  - `is_auth_error(exc: Exception) -> bool`
  - `translate_blocks(ring: GeminiKeyRing, blocks, translated) -> None`（签名由 `client` 改为 `ring`）
  - `translate_cues_with_gemini(cues) -> list[dict]`（内部改用 `GEMINI_KEYS` 造 ring）

- [ ] **Step 1: 写失败测试**

```python
class _QuotaError(Exception):
    code = "RESOURCE_EXHAUSTED"


class _AuthError(Exception):
    code = 403


class GeminiRotationTranslateTests(unittest.TestCase):
    def test_switches_key_after_quota_error(self):
        calls = []

        class Client:
            def __init__(self, api_key):
                self.api_key = api_key

            @property
            def models(self):
                return self

            def generate_content(self, model, contents, config):
                calls.append(self.api_key)
                if self.api_key == "k1":
                    raise _QuotaError("429 RESOURCE_EXHAUSTED")
                return SimpleNamespace(text=json.dumps({"0": "译0"}))

        ring = transcriber.GeminiKeyRing(["k1", "k2"], factory=Client)
        translated = {}
        with patch.object(transcriber, "wait_for_gemini_rate_limit"):
            transcriber.translate_blocks(ring, [(0, {"en": "Hello there friend"})], translated)
        self.assertEqual(translated, {0: "译0"})
        self.assertEqual(calls, ["k1", "k2"])

    def test_all_keys_exhausted_raises(self):
        class Client:
            @property
            def models(self):
                return self

            def generate_content(self, **kwargs):
                raise _QuotaError("429 RESOURCE_EXHAUSTED")

        ring = transcriber.GeminiKeyRing(["k1"], factory=lambda api_key: Client())
        with patch.object(transcriber, "wait_for_gemini_rate_limit"):
            with self.assertRaises(transcriber.QuotaExhausted):
                transcriber.translate_blocks(ring, [(0, {"en": "Hello there friend"})], {})

    def test_error_classification(self):
        self.assertTrue(transcriber.is_quota_error(_QuotaError("x")))
        self.assertFalse(transcriber.is_quota_error(TimeoutError("x")))
        self.assertTrue(transcriber.is_auth_error(_AuthError("x")))
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_transcribe_utils.py`
Expected: FAIL/ERROR（`is_quota_error` 不存在、`translate_blocks` 仍接受 client）

- [ ] **Step 3: 实现**

```python
def is_quota_error(exc: Exception) -> bool:
    text = f"{exc}".upper()
    code = getattr(exc, "code", None) or getattr(exc, "status_code", None)
    return (
        code in (429, "429", "RESOURCE_EXHAUSTED")
        or "RESOURCE_EXHAUSTED" in text
        or "QUOTA" in text
    )


def is_auth_error(exc: Exception) -> bool:
    text = f"{exc}".upper()
    code = getattr(exc, "code", None) or getattr(exc, "status_code", None)
    return code in (401, 403, "401", "403", "PERMISSION_DENIED", "UNAUTHENTICATED") or (
        "API_KEY_INVALID" in text
    )
```

`translate_blocks` 改为接受 ring，并在每次尝试前取当前 client；配额/鉴权错误先切 key 再重试同一个批次：

```python
def translate_blocks(ring: GeminiKeyRing, blocks, translated) -> None:
    pending = [pair for pair in blocks if pair[0] not in translated]
    if not pending:
        return
    attempt = 0
    last_error: Exception | None = None
    while pending:
        try:
            ring.requests += 1
            translated.update(translate_batch_once(ring.client(), pending))
            return
        except QuotaExhausted:
            raise
        except Exception as exc:
            last_error = exc
            if is_quota_error(exc) or is_auth_error(exc):
                kind = "配额耗尽" if is_quota_error(exc) else "key 无效"
                if not ring.mark_exhausted():
                    raise QuotaExhausted(
                        f"{kind}，所有 key 已用尽（本进程已发 {ring.requests} 次请求）"
                    ) from exc
                log.warning("Gemini key %s %s，切到 %s", ring.label(), kind, ring.label())
                continue
            if isinstance(exc, IncompleteTranslation):
                translated.update(exc.partial)
                pending = [pair for pair in pending if pair[0] not in translated]
                if not pending:
                    return
            if attempt < TRANSLATE_MAX_RETRIES:
                delay = min(60.0, TRANSLATE_BASE_DELAY * (2**attempt))
                log.warning(
                    "Gemini 批次失败（%d/%d）：%s；%.1f 秒后只补 %d 条",
                    attempt + 1,
                    TRANSLATE_MAX_RETRIES + 1,
                    exc,
                    delay,
                    len(pending),
                )
                time.sleep(delay)
                attempt += 1
                continue
            if len(pending) > 1:
                half = len(pending) // 2
                translate_blocks(ring, pending[:half], translated)
                translate_blocks(ring, pending[half:], translated)
                return
            raise RuntimeError(
                f"单条字幕翻译最终失败：{pending[0][1].get('en', '')[:160]!r}"
            ) from last_error
```

`translate_cues_with_gemini` 三处改动：

```python
def translate_cues_with_gemini(cues: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not cues:
        raise ValueError("没有可翻译字幕")
    ring = GeminiKeyRing(GEMINI_KEYS)
    batches = build_translation_batches(cues)
    log.info(
        "Gemini 翻译开始：%d 条字幕，%d 个初始批次，模型=%s，key=%d 把，限速=%d RPM（请求间隔至少 %.2f 秒）",
        len(cues), len(batches), GEMINI_MODEL, len(GEMINI_KEYS), GEMINI_RPM,
        GEMINI_REQUEST_INTERVAL,
    )
    for i, batch in enumerate(batches, 1):
        log.info("翻译批次 %d/%d：%d 条", i, len(batches), len(batch))
        translated: dict[int, str] = {}
        translate_blocks(ring, list(enumerate(batch)), translated)
        for index, cue in enumerate(batch):
            cue["zh"] = translated[index]
    return cues
```

并删除 `create_gemini_client()`（不再有调用点）。

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_transcribe_utils.py`
Expected: `OK`（原有 27 个 + 新增 3 个）

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/transcribe.py tests/test_transcribe_utils.py
git commit -m "feat: rotate Gemini keys on quota exhaustion"
```

---

### Task 3: sidecar 断点语义（complete / attempts）

**Files:**
- Modify: `scripts/transcribe.py`（`write_word_timings`）
- Test: `tests/test_transcribe_utils.py`

**Interfaces:**
- Produces:
  - `sidecar_status(path: Path) -> tuple[bool, int]`（complete, attempts）
  - `write_word_timings(cues, output_path, audio_seconds, complete=True, attempts=1)`
  - `write_sidecar_failure(path: Path, attempts: int) -> None`
  - `sidecar_path_for(vtt_path: Path) -> Path`
  - 常量 `BACKFILL_MAX_ATTEMPTS = 2`

- [ ] **Step 1: 写失败测试**

```python
class SidecarStatusTests(unittest.TestCase):
    def test_status_of_missing_or_broken_file_is_incomplete(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "x.json"
            self.assertEqual(transcriber.sidecar_status(path), (False, 0))
            path.write_text("{not json", encoding="utf-8")
            self.assertEqual(transcriber.sidecar_status(path), (False, 0))

    def test_status_reads_complete_and_attempts(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "x.json"
            path.write_text(json.dumps({"complete": True, "attempts": 2}), encoding="utf-8")
            self.assertEqual(transcriber.sidecar_status(path), (True, 2))

    def test_failure_sidecar_is_incomplete_with_attempt_count(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "x.json"
            transcriber.write_sidecar_failure(path, attempts=1)
            self.assertEqual(transcriber.sidecar_status(path), (False, 1))

    def test_sidecar_path_matches_vtt_stem(self):
        vtt = Path("site/pod/transcripts/Ep 1.vtt")
        self.assertEqual(
            transcriber.sidecar_path_for(vtt).name, "Ep 1.json"
        )
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_transcribe_utils.py`
Expected: ERROR `has no attribute 'sidecar_status'`

- [ ] **Step 3: 实现**

```python
BACKFILL_MAX_ATTEMPTS = 2


def sidecar_path_for(vtt_path: Path) -> Path:
    return TIMING_DIR / f"{vtt_path.stem}.json"


def sidecar_status(path: Path) -> tuple[bool, int]:
    """返回 (complete, attempts)；缺失或损坏一律按未完成、0 次处理。"""
    if not path.exists():
        return False, 0
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return False, 0
    if not isinstance(document, dict):
        return False, 0
    return document.get("complete") is True, int(document.get("attempts") or 0)


def write_sidecar_failure(path: Path, attempts: int) -> None:
    document = {
        "episode": path.stem,
        "audio_seconds": 0.0,
        "complete": False,
        "attempts": attempts,
        "segments": [],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(document, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    tmp.replace(path)
```

`write_word_timings` 增加两个关键字参数并写进文档：

```python
def write_word_timings(
    cues: list[dict[str, Any]],
    output_path: Path,
    audio_seconds: float,
    complete: bool = True,
    attempts: int = 1,
) -> None:
```
其中 `document` 里 `"complete": complete, "attempts": attempts`。

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_transcribe_utils.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/transcribe.py tests/test_transcribe_utils.py
git commit -m "feat: make sidecar the backfill checkpoint (complete/attempts)"
```

---

### Task 4: 分片与候选筛选

**Files:**
- Modify: `scripts/transcribe.py`
- Test: `tests/test_transcribe_utils.py`

**Interfaces:**
- Consumes: `sidecar_status`、`sidecar_path_for`（Task 3）、`is_valid_bilingual_vtt`
- Produces:
  - `shard_of(identity: str, shards: int) -> int`
  - `needs_backfill(vtt_path: Path, sidecar_path: Path) -> bool`
  - `build_backfill_candidates(entries, records) -> list[dict]`（元素键：`identity/title/audio_url/vtt_path`）

- [ ] **Step 1: 写失败测试**

```python
class BackfillSelectionTests(unittest.TestCase):
    def test_shard_is_stable_and_in_range(self):
        first = transcriber.shard_of("guid-1", 20)
        self.assertEqual(first, transcriber.shard_of("guid-1", 20))
        self.assertTrue(0 <= first < 20)
        self.assertNotEqual(
            [transcriber.shard_of(f"guid-{i}", 20) for i in range(20)],
            [0] * 20,
            "分片必须真的分散，不能全落一片",
        )

    def test_needs_backfill_only_for_valid_vtt_without_complete_sidecar(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            vtt = Path(temp_dir) / "Ep.vtt"
            sidecar = Path(temp_dir) / "Ep.json"
            self.assertFalse(transcriber.needs_backfill(vtt, sidecar), "没有 VTT 不是回填对象")
            vtt.write_text("WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nhi\n", encoding="utf-8")
            with patch.object(transcriber, "is_valid_bilingual_vtt", return_value=True):
                self.assertTrue(transcriber.needs_backfill(vtt, sidecar))
                sidecar.write_text(json.dumps({"complete": True, "attempts": 1}), encoding="utf-8")
                self.assertFalse(transcriber.needs_backfill(vtt, sidecar))
                sidecar.write_text(json.dumps({"complete": False, "attempts": 2}), encoding="utf-8")
                self.assertFalse(
                    transcriber.needs_backfill(vtt, sidecar), "连续失败两次的集不再重试"
                )

    def test_candidates_join_feed_entries_with_records(self):
        entry = SimpleNamespace(
            id="g1", title="Ep", published="",
            enclosures=[{"href": "https://cdn.test/a.mp3", "type": "audio/mpeg"}],
            links=[],
        )
        records = {"g1": {"identity": "g1", "path": "pod/transcripts/Ep.vtt", "title": "Ep"}}
        with patch.object(transcriber, "SITE_DIR", Path("site")), patch.object(
            transcriber, "needs_backfill", return_value=True
        ):
            got = transcriber.build_backfill_candidates([entry], records)
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["identity"], "g1")
        self.assertEqual(got[0]["title"], "Ep")
        self.assertEqual(got[0]["audio_url"], "https://cdn.test/a.mp3")
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_transcribe_utils.py`
Expected: ERROR `has no attribute 'shard_of'`

- [ ] **Step 3: 实现**

```python
def shard_of(identity: str, shards: int) -> int:
    digest = hashlib.sha1(identity.encode("utf-8")).hexdigest()
    return int(digest, 16) % max(1, shards)


def needs_backfill(vtt_path: Path, sidecar_path: Path) -> bool:
    if not vtt_path.exists() or not is_valid_bilingual_vtt(vtt_path):
        return False
    complete, attempts = sidecar_status(sidecar_path)
    return not complete and attempts < BACKFILL_MAX_ATTEMPTS


def build_backfill_candidates(entries, records) -> list[dict[str, Any]]:
    candidates = []
    for entry in entries:
        audio_url = get_entry_audio_url(entry)
        if not audio_url:
            continue
        identity = entry_identity(entry, audio_url)
        record = records.get(identity)
        if not record or not record.get("path"):
            continue
        vtt_path = SITE_DIR / record["path"]
        if not needs_backfill(vtt_path, sidecar_path_for(vtt_path)):
            continue
        candidates.append(
            {
                "identity": identity,
                "title": record.get("title") or "",
                "audio_url": audio_url,
                "vtt_path": vtt_path,
            }
        )
    return candidates
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_transcribe_utils.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/transcribe.py tests/test_transcribe_utils.py
git commit -m "feat: add shard selection and backfill candidate filtering"
```

---

### Task 5: `process_episode` 的 force 路径与失败记账

**Files:**
- Modify: `scripts/transcribe.py:1348-1461`（`process_episode`）
- Test: `tests/test_transcribe_utils.py`

**Interfaces:**
- Consumes: `write_word_timings(complete, attempts)`、`sidecar_path_for`、`sidecar_status`、`write_sidecar_failure`
- Produces: `process_episode(entry, identity, audio_url, path_owner=None, force=False)`
  - `force=False` 保留现有复用语义
  - `force=True` 忽略已存在的 VTT，重转后覆盖；异常时写 `complete:false` 的 sidecar（attempts 递增）并重新抛出

- [ ] **Step 1: 写失败测试**

```python
class ForceRetranscribeTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.site_dir = Path(self.temp_dir.name) / "site"
        self.transcript_dir = self.site_dir / "pod" / "transcripts"
        self.transcript_dir.mkdir(parents=True)
        self.patches = [
            patch.object(transcriber, "SITE_DIR", self.site_dir),
            patch.object(transcriber, "TRANSCRIPT_DIR", self.transcript_dir),
            patch.object(transcriber, "TIMING_DIR", self.site_dir / "pod" / "timings"),
        ]
        for item in self.patches:
            item.start()
        self.entry = SimpleNamespace(title="Ep", published="")
        self.cues = [{"start": 0.0, "end": 1.0, "en": "Hello", "zh": "你好",
                      "words": [{"w": "Hello", "s": 0.0, "e": 1.0}]}]

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp_dir.cleanup()

    def test_force_rewrites_existing_vtt_and_sidecar(self):
        existing = self.transcript_dir / "Ep.vtt"
        transcriber.write_bilingual_vtt(
            [{"start": 0.0, "end": 1.0, "en": "Old", "zh": "旧"}], existing
        )
        with patch.object(transcriber, "download_audio", return_value={}), patch.object(
            transcriber, "whisper_transcribe", return_value=(self.cues, 42.0)
        ), patch.object(transcriber, "translate_cues_with_gemini", return_value=self.cues):
            transcriber.process_episode(
                self.entry, "g1", "https://cdn.test/a.mp3", {}, force=True
            )
        self.assertIn("Hello", existing.read_text(encoding="utf-8"))
        sidecar = self.site_dir / "pod" / "timings" / "Ep.json"
        self.assertEqual(transcriber.sidecar_status(sidecar), (True, 1))

    def test_force_failure_records_attempt_and_keeps_old_vtt(self):
        existing = self.transcript_dir / "Ep.vtt"
        transcriber.write_bilingual_vtt(
            [{"start": 0.0, "end": 1.0, "en": "Old", "zh": "旧"}], existing
        )
        with patch.object(transcriber, "download_audio", return_value={}), patch.object(
            transcriber, "whisper_transcribe", side_effect=RuntimeError("boom")
        ):
            with self.assertRaises(RuntimeError):
                transcriber.process_episode(
                    self.entry, "g1", "https://cdn.test/a.mp3", {}, force=True
                )
        self.assertIn("Old", existing.read_text(encoding="utf-8"), "老 VTT 必须原样保留")
        sidecar = self.site_dir / "pod" / "timings" / "Ep.json"
        self.assertEqual(transcriber.sidecar_status(sidecar), (False, 1))

    def test_without_force_existing_vtt_is_reused(self):
        existing = self.transcript_dir / "Ep.vtt"
        transcriber.write_bilingual_vtt(
            [{"start": 0.0, "end": 1.0, "en": "Old", "zh": "旧"}], existing
        )
        with patch.object(
            transcriber, "download_audio", side_effect=AssertionError("不应下载")
        ):
            transcriber.process_episode(self.entry, "g1", "https://cdn.test/a.mp3", {})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_transcribe_utils.py`
Expected: FAIL（`force` 参数不存在 / 失败时不写 sidecar）

- [ ] **Step 3: 实现**

`process_episode` 头部签名与复用判断改为：

```python
def process_episode(
    entry: Any,
    identity: str,
    audio_url: str,
    path_owner: dict[str, str] | None = None,
    force: bool = False,
) -> tuple[dict[str, str], dict[str, Any]]:
```
```python
    if not force and transcript_path.exists() and is_valid_bilingual_vtt(transcript_path):
```
转录/翻译块外层包 try，失败时记 attempts：

```python
    sidecar = sidecar_path_for(transcript_path)
    try:
        with tempfile.TemporaryDirectory(prefix="podcast-audio-") as temp_dir:
            audio_path = Path(temp_dir) / f"episode{suffix}"
            proxy_info = download_audio(audio_url, audio_path)
            cues, audio_seconds = whisper_transcribe(audio_path)
        cues = translate_cues_with_gemini(cues)
        if any(not c.get("en") or not c.get("zh") for c in cues):
            raise RuntimeError("字幕校验失败：存在空的英文或中文条目")
        write_bilingual_vtt(cues, transcript_path)
        write_word_timings(cues, sidecar, audio_seconds)
    except Exception:
        _, previous_attempts = sidecar_status(sidecar)
        write_sidecar_failure(sidecar, attempts=previous_attempts + 1)
        raise
```
（原 `try/except` 包住 sidecar 写入的逻辑删除——sidecar 现在是断点依据，写失败必须显式失败。）

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_transcribe_utils.py`
Expected: `OK`（含既有 `test_same_title_for_other_identity_gets_stable_suffix`）

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/transcribe.py tests/test_transcribe_utils.py
git commit -m "feat: force re-transcription path with failure bookkeeping"
```

---

### Task 6: 回填执行器（预算 / 配额暂停 / 单集隔离）

**Files:**
- Modify: `scripts/transcribe.py`
- Test: `tests/test_transcribe_utils.py`

**Interfaces:**
- Consumes: `shard_of`、`process_episode(force=True)`
- Produces: `run_backfill(candidates, shard, shards, max_minutes, process=None, clock=None) -> dict`
  - 返回 `{"done": int, "failed": int, "skipped": int, "quota": bool}`
  - `process` 形参签名：`Callable[[dict], None]`
  - `clock` 形参默认 `time.monotonic`

- [ ] **Step 1: 写失败测试**

```python
class RunBackfillTests(unittest.TestCase):
    def items(self, n):
        return [
            {"identity": f"guid-{i}", "title": f"Ep {i}", "audio_url": "u", "vtt_path": Path("x")}
            for i in range(n)
        ]

    def test_only_my_shard_runs_and_budget_stops_cleanly(self):
        done = []
        ticks = iter([0.0, 0.0, 0.0, 99999.0, 99999.0])

        def fake_clock():
            return next(ticks, 99999.0)

        stats = transcriber.run_backfill(
            self.items(6), shard=0, shards=1, max_minutes=1,
            process=lambda item: done.append(item["identity"]), clock=fake_clock,
        )
        self.assertEqual(stats["done"], len(done))
        self.assertLess(len(done), 6, "预算耗尽后必须停下")
        self.assertFalse(stats["quota"])

    def test_other_shards_are_skipped(self):
        seen = []
        transcriber.run_backfill(
            self.items(6), shard=0, shards=2,
            process=lambda item: seen.append(item["identity"]), clock=lambda: 0.0,
        )
        self.assertTrue(seen)
        self.assertTrue(all(transcriber.shard_of(i, 2) == 0 for i in seen))

    def test_quota_exhausted_pauses_the_shard(self):
        def process(item):
            raise transcriber.QuotaExhausted("done for today")

        stats = transcriber.run_backfill(
            self.items(3), shard=0, shards=1, max_minutes=10,
            process=process, clock=lambda: 0.0,
        )
        self.assertEqual(stats["done"], 0)
        self.assertTrue(stats["quota"])

    def test_single_episode_failure_does_not_stop_the_shard(self):
        calls = []

        def process(item):
            calls.append(item["identity"])
            if len(calls) == 1:
                raise RuntimeError("boom")

        stats = transcriber.run_backfill(
            self.items(3), shard=0, shards=1, max_minutes=10,
            process=process, clock=lambda: 0.0,
        )
        self.assertEqual(stats["failed"], 1)
        self.assertEqual(stats["done"], 2)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_transcribe_utils.py`
Expected: ERROR `has no attribute 'run_backfill'`

- [ ] **Step 3: 实现**

```python
def run_backfill(
    candidates: list[dict[str, Any]],
    shard: int,
    shards: int,
    max_minutes: float,
    process=None,
    clock=None,
) -> dict[str, Any]:
    """回填一个分片：预算用完即停；配额耗尽干净退出；单集失败不影响其它集。"""
    process = process or process_backfill_item
    clock = clock or time.monotonic
    deadline = clock() + max_minutes * 60
    stats = {"done": 0, "failed": 0, "skipped": 0, "quota": False}
    for item in candidates:
        if shard_of(item["identity"], shards) != shard:
            stats["skipped"] += 1
            continue
        if clock() >= deadline:
            log.info("分片 %d 预算用完，已完成 %d 集", shard, stats["done"])
            break
        try:
            process(item)
        except QuotaExhausted:
            log.info("Gemini 配额耗尽，分片 %d 停下：本轮完成 %d 集", shard, stats["done"])
            stats["quota"] = True
            break
        except Exception:
            stats["failed"] += 1
            log.exception("回填失败（下轮重试）：%s", item.get("title", ""))
            continue
        stats["done"] += 1
        log.info("回填完成 %d 集：%s", stats["done"], item.get("title", "")[:70])
    return stats


def process_backfill_item(item: dict[str, Any]) -> None:
    entry = SimpleNamespace(
        title=item["title"], published="", id=item["identity"], guid=item["identity"]
    )
    record, _ = process_episode(
        entry, item["identity"], item["audio_url"], path_owner=None, force=True
    )
    if (SITE_DIR / record["path"]) != item["vtt_path"]:
        log.warning(
            "回填产出路径与预期不一致：%s → %s", item["vtt_path"], record["path"]
        )
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_transcribe_utils.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/transcribe.py tests/test_transcribe_utils.py
git commit -m "feat: add budgeted, quota-aware backfill runner"
```

---

### Task 7: `main()` 回填入口（不写 state / feed / index）

**Files:**
- Modify: `scripts/transcribe.py`（`main()`，`WPERMODEL` 与环境变量）
- Test: `tests/test_transcribe_utils.py`

**Interfaces:**
- Produces:
  - `backfill_env() -> dict | None`：读 `BACKFILL_SHARD` / `BACKFILL_SHARDS` / `BACKFILL_MAX_MINUTES`；未设置返回 `None`
  - `main()` 在回填模式下：只读 `state.json`，跑 `run_backfill`，返回 0，**不调用** `save_state` / `make_enhanced_feed` / `build_podcast_index`

- [ ] **Step 1: 写失败测试**

```python
class BackfillEnvTests(unittest.TestCase):
    def test_env_is_none_without_shard(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("BACKFILL_SHARD", None)
            self.assertIsNone(transcriber.backfill_env())

    def test_env_reads_and_validates(self):
        with patch.dict(
            os.environ,
            {"BACKFILL_SHARD": "3", "BACKFILL_SHARDS": "20", "BACKFILL_MAX_MINUTES": "90"},
        ):
            self.assertEqual(
                transcriber.backfill_env(),
                {"shard": 3, "shards": 20, "max_minutes": 90.0},
            )

    def test_bad_env_raises(self):
        with patch.dict(os.environ, {"BACKFILL_SHARD": "x"}):
            with self.assertRaises(ValueError):
                transcriber.backfill_env()
        with patch.dict(
            os.environ, {"BACKFILL_SHARD": "5", "BACKFILL_SHARDS": "4"}
        ):
            with self.assertRaises(ValueError):
                transcriber.backfill_env()
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python tests/test_transcribe_utils.py`
Expected: ERROR `has no attribute 'backfill_env'`

- [ ] **Step 3: 实现**

```python
def backfill_env() -> dict[str, Any] | None:
    """回填模式由环境变量开启；没设 BACKFILL_SHARD 就是正常模式。"""
    raw_shard = os.getenv("BACKFILL_SHARD", "").strip()
    if not raw_shard:
        return None
    shard = int(raw_shard)
    shards = int(os.getenv("BACKFILL_SHARDS", "20").strip() or 20)
    max_minutes = float(os.getenv("BACKFILL_MAX_MINUTES", "280").strip() or 280)
    if shards < 1 or not 0 <= shard < shards:
        raise ValueError(f"分片配置非法：shard={shard} shards={shards}")
    if max_minutes <= 0:
        raise ValueError(f"预算非法：{max_minutes}")
    return {"shard": shard, "shards": shards, "max_minutes": max_minutes}
```

`main()` 里：把 `if not GEMINI_API_KEY` 改为 `if not GEMINI_KEYS`，并在 `records = migrate_legacy_records(...)`
之后插入回填分支：

```python
    backfill = backfill_env()
    if backfill is not None:
        candidates = build_backfill_candidates(entries, records)
        log.info(
            "回填模式：分片 %d/%d，预算 %.0f 分钟，候选 %d 集，模型 %s，key %d 把",
            backfill["shard"], backfill["shards"], backfill["max_minutes"],
            len(candidates), WHISPER_MODEL, len(GEMINI_KEYS),
        )
        stats = run_backfill(
            candidates,
            shard=backfill["shard"],
            shards=backfill["shards"],
            max_minutes=backfill["max_minutes"],
        )
        log.info(
            "回填结束：完成 %d，失败 %d，非本分片 %d，配额耗尽=%s",
            stats["done"], stats["failed"], stats["skipped"], stats["quota"],
        )
        return 0
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/test_transcribe_utils.py`
Expected: `OK`

- [ ] **Step 5: 提交（等用户确认）**

```bash
git add scripts/transcribe.py tests/test_transcribe_utils.py
git commit -m "feat: add backfill entry to transcribe main"
```

---

### Task 8: workflow——模型缓存、key 注入、分片矩阵、提交边界

**Files:**
- Modify: `.github/workflows/transcribe.yml`

**Interfaces:**
- Consumes: `BACKFILL_SHARD/SHARDS/MAX_MINUTES`、`GEMINI_API_KEYS`、`WHISPER_MODEL=models/ct2-turbo`
- Produces: 可 `workflow_dispatch` 的分片回填入口

- [ ] **Step 1: 加输入**

```yaml
      backfill:
        description: "回填模式（20 分片矩阵，用于存量重转）"
        type: choice
        options: ["false", "true"]
        default: "false"
      shards:
        description: "回填分片数"
        default: "20"
      max_minutes:
        description: "单分片时间预算（分钟）"
        default: "280"
      model:
        description: "Whisper 模型（目录或模型名）"
        required: true
        default: "models/ct2-turbo"
```

- [ ] **Step 2: job 加矩阵与回填环境变量**

```yaml
  transcribe:
    runs-on: ubuntu-latest
    timeout-minutes: 360
    strategy:
      fail-fast: false
      matrix:
        shard: ${{ fromJSON(github.event.inputs.backfill == 'true' && '[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19]' || '[0]') }}
```
（`backfill=false` 时矩阵只有 `[0]`，且下面 `BACKFILL_SHARD` 不注入，走正常模式。）

- [ ] **Step 3: 模型缓存与下载**

```yaml
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
```

- [ ] **Step 4: 运行步骤注入环境变量**

```yaml
      - name: 运行转录与翻译
        continue-on-error: true
        env:
          PODCAST_SLUG: ${{ github.event.inputs.podcast_slug || 'how-we-made-your-mother' }}
          FEED_URL: ${{ github.event.inputs.feed_url || 'https://rss.amperwave.net/v2/feed/audacynetwork/hwmym' }}
          WHISPER_MODEL: ${{ github.event.inputs.model || 'models/ct2-turbo' }}
          GEMINI_API_KEYS: ${{ secrets.GEMINI_API_KEYS }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          GEMINI_MODEL: ${{ github.event.inputs.gemini_model || 'gemini-3.5-flash-lite' }}
          BACKFILL_SHARD: ${{ github.event.inputs.backfill == 'true' && matrix.shard || '' }}
          BACKFILL_SHARDS: ${{ github.event.inputs.shards || '20' }}
          BACKFILL_MAX_MINUTES: ${{ github.event.inputs.max_minutes || '280' }}
          BASE_URL: ${{ env.BASE_URL }}
        run: |
          python - <<'PY'
          import os, sys
          sys.path.insert(0, "scripts")
          from pathlib import Path
          model = os.environ["WHISPER_MODEL"]
          if model.startswith("models/") and not (Path(model) / "model.bin").exists():
              raise SystemExit(f"模型缺失：{model}（回填模式禁止回退 base.en）")
          PY
          python -u scripts/transcribe.py
```

- [ ] **Step 5: 提交步骤加 trap 与各自 pathspec**

```yaml
      - name: 提交状态与站点文件到 Git
        if: always()
        env:
          MY_PAT: ${{ secrets.MY_CUSTOM_PAT }}
          PODCAST_SLUG: ${{ github.event.inputs.podcast_slug || 'how-we-made-your-mother' }}
          BACKFILL: ${{ github.event.inputs.backfill || 'false' }}
        run: |
          git remote set-url origin "https://${MY_PAT}@github.com/${GITHUB_REPOSITORY}.git"
          if [ "$BACKFILL" = "true" ]; then
            # 回填分片只产出 VTT 与 sidecar；不碰 state.json / feed.xml / index.html。
            bash scripts/git_push_retry.sh "auto: backfill hwmym word timings (shard ${{ matrix.shard }})" \
              site/${PODCAST_SLUG}/transcripts site/${PODCAST_SLUG}/timings \
              ':(exclude)site/*/transcripts/zh/**'
          else
            bash scripts/git_push_retry.sh "auto: update ${PODCAST_SLUG} transcripts" \
              state.json site \
              ':(exclude)site/*/transcripts/zh/**' \
              ':(exclude)site/*/feed-zh.xml' \
              ':(exclude)progress.json' \
              ':(exclude)translations.json'
          fi
```

- [ ] **Step 6: 本地语法检查**

Run: `python -c "import yaml,pathlib; yaml.safe_load(pathlib.Path('.github/workflows/transcribe.yml').read_text(encoding='utf-8')); print('yaml ok')"`
Expected: `yaml ok`

- [ ] **Step 7: 提交（等用户确认）**

```bash
git add .github/workflows/transcribe.yml
git commit -m "ci: sharded backfill with cached turbo model and key rotation"
```

---

### Task 9: 冒烟与三轮放行（运维步骤，无代码）

**Files:** 无

- [ ] **Step 1: 预置 secret**（用户在 GitHub Settings → Secrets 操作）

`GEMINI_API_KEYS`：逗号分隔的 2 把以上 key；`GEMINI_API_KEY` 可保留。

- [ ] **Step 2: 冒烟一集**

在 Actions → Auto Transcribe → Run workflow：`backfill=true`、`shards=1`、`max_minutes=60`。
Expected：日志出现 `回填模式：分片 0/1 … 候选 119 集`、`回填完成 1 集：…`；
仓库新增 1 个 sidecar + 1 个被重写的 VTT；`state.json` 无变更。

- [ ] **Step 3: 记录实测口径**

把 `分类 转录/下载/翻译` 的耗时与 `RTF`、单集 Gemini 请求数写进本轮记录；若单集耗时 > 60 分钟，
把 `shards` 提到 20 并把轮数改为 4–5 轮。

- [ ] **Step 4: 正式轮次**

`backfill=true`、默认 `shards=20`、`max_minutes=280`，重复派发直到日志里
`候选 N 集` 降到 0。每轮结束检查：`ls site/how-we-made-your-mother/timings | wc -l` 递增，
且失败集在日志里被点名。

- [ ] **Step 5: 验收**

```bash
python - <<'PY'
import json
from pathlib import Path

vtt = {p.stem for p in Path("site/how-we-made-your-mother/transcripts").glob("*.vtt")}
tim = {p.stem for p in Path("site/how-we-made-your-mother/timings").glob("*.json")}
print("VTT", len(vtt), "sidecar", len(tim), "缺 sidecar", sorted(vtt - tim)[:5])
incomplete = [p.name for p in Path("site/how-we-made-your-mother/timings").glob("*.json")
              if json.loads(p.read_text(encoding="utf-8")).get("complete") is not True]
print("未完成", incomplete[:5], "共", len(incomplete))
PY
```
Expected：`缺 sidecar []`、`未完成 [] 共 0`；抽查 3 集：带词 cue ≥95%、越界词 0。

---

## Self-Review

- **Spec coverage**：模式入口（Task 7/8）、分片（Task 4/8）、断点=sidecar（Task 3/4）、事务边界与提交（Task 5/8）、
  模型供应与不回退（Task 8）、配额与 key 轮换（Task 1/2/6）、运行计划与验收（Task 9）——逐节有对应任务。
- **占位符**：无 TBD/TODO；每个代码步骤都给了可粘贴的实现。
- **类型一致性**：`GeminiKeyRing`、`translate_blocks(ring, …)`、`sidecar_status`、`shard_of`、`needs_backfill`、
  `build_backfill_candidates`、`run_backfill(..., process=None, clock=None)` 在后续任务中均按首次定义的名字与签名使用。
