import hashlib
import importlib.util
import json
import logging
import os
import sys
import tempfile
import types
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from lxml import etree


# faster-whisper and google-genai are heavy/optional at test time; the module
# only needs their names at import.
faster_whisper = types.ModuleType("faster_whisper")
faster_whisper.WhisperModel = object
sys.modules.setdefault("faster_whisper", faster_whisper)

google = types.ModuleType("google")
genai = types.ModuleType("google.genai")
genai_types = types.ModuleType("google.genai.types")
genai.Client = object
genai.types = genai_types
if not hasattr(genai_types, "GenerateContentConfig"):
    genai_types.GenerateContentConfig = lambda **kwargs: kwargs
google.genai = genai
sys.modules.setdefault("google", google)
sys.modules.setdefault("google.genai", genai)
sys.modules.setdefault("google.genai.types", genai_types)

MODULE_PATH = Path(__file__).parents[1] / "scripts" / "transcribe.py"
SPEC = importlib.util.spec_from_file_location("transcribe", MODULE_PATH)
transcriber = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(transcriber)


@contextmanager
def captured_messages(logger):
    """收集所有级别的日志消息文本；assertLogs 要求至少一条，安静路径用这个。"""
    messages = []

    class _Handler(logging.Handler):
        def emit(self, record):
            messages.append(record.getMessage())

    handler = _Handler()
    logger.addHandler(handler)
    try:
        yield messages
    finally:
        logger.removeHandler(handler)


class BilingualVttTests(unittest.TestCase):
    def test_accepts_english_then_chinese(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "ok.vtt"
            path.write_text(
                "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n你好\n",
                encoding="utf-8",
            )
            self.assertTrue(transcriber.is_valid_bilingual_vtt(path))

    def test_rejects_english_only_multiline_cue(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "english.vtt"
            path.write_text(
                "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\nThere\n",
                encoding="utf-8",
            )
            self.assertFalse(transcriber.is_valid_bilingual_vtt(path))

    def test_rejects_single_transcript_line(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "short.vtt"
            path.write_text(
                "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n",
                encoding="utf-8",
            )
            self.assertFalse(transcriber.is_valid_bilingual_vtt(path))

    def test_accepts_a_few_untranslated_legacy_cues(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "mostly.vtt"
            blocks = ["WEBVTT", ""]
            for index in range(10):
                blocks.extend(
                    [
                        str(index + 1),
                        "00:00:00.000 --> 00:00:01.000",
                        "Hello",
                        "你好" if index < 9 else "There",
                        "",
                    ]
                )
            path.write_text("\n".join(blocks), encoding="utf-8")
            self.assertTrue(transcriber.is_valid_bilingual_vtt(path))

    def test_rejects_mostly_english_file(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "mostly-english.vtt"
            blocks = ["WEBVTT", ""]
            for index in range(10):
                blocks.extend(
                    [
                        str(index + 1),
                        "00:00:00.000 --> 00:00:01.000",
                        "Hello",
                        "你好" if index == 0 else "There",
                        "",
                    ]
                )
            path.write_text("\n".join(blocks), encoding="utf-8")
            self.assertFalse(transcriber.is_valid_bilingual_vtt(path))


class UrlAndSortingTests(unittest.TestCase):
    def test_make_public_url_encodes_percent_space_and_brackets(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            site_dir = Path(temp_dir) / "site"
            path = site_dir / "99%-invisible" / "transcripts" / "How We Met [Pilot].vtt"
            with patch.object(transcriber, "SITE_DIR", site_dir), patch.object(
                transcriber, "BASE_URL", "https://example.test/MyTranscript"
            ):
                url = transcriber.make_public_url(path)
            self.assertEqual(
                url,
                "https://example.test/MyTranscript/99%25-invisible/transcripts/"
                "How%20We%20Met%20%5BPilot%5D.vtt",
            )

    def test_published_dates_sort_chronologically(self):
        older = transcriber.published_sort_key("Mon, 01 Jan 2024 00:00:00 +0000")
        newer = transcriber.published_sort_key("Tue, 02 Jan 2024 00:00:00 +0000")
        self.assertLess(older, newer)
        self.assertEqual(transcriber.published_sort_key("not a date"), 0.0)


class TranscriptTagTests(unittest.TestCase):
    def test_add_transcript_tag_removes_stale_project_link(self):
        item = etree.fromstring(
            """
            <item xmlns:podcast="https://podcastindex.org/namespace/1.0">
              <podcast:transcript url="https://example.test/transcripts/old.vtt"/>
              <podcast:transcript url="https://external.test/transcript.vtt"/>
            </item>
            """
        )
        transcriber.add_transcript_tag(
            item, "https://example.test/transcripts/new.vtt"
        )

        urls = [node.get("url") for node in item.findall(
            "{https://podcastindex.org/namespace/1.0}transcript"
        )]
        self.assertIn("https://example.test/transcripts/new.vtt", urls)
        self.assertIn("https://external.test/transcript.vtt", urls)
        self.assertNotIn("https://example.test/transcripts/old.vtt", urls)

    def test_remove_project_transcript_tags_keeps_external(self):
        channel = etree.fromstring(
            """
            <channel xmlns:podcast="https://podcastindex.org/namespace/1.0">
              <item>
                <podcast:transcript url="https://example.test/transcripts/old.vtt"/>
                <podcast:transcript url="https://external.test/transcript.vtt"/>
              </item>
            </channel>
            """
        )
        removed = transcriber.remove_project_transcript_tags(channel)

        self.assertEqual(removed, 1)
        urls = channel.xpath("//*[local-name()='transcript']/@url")
        self.assertEqual(urls, ["https://external.test/transcript.vtt"])

    def test_finds_namespaced_guid(self):
        root = etree.fromstring(
            """
            <rss xmlns:x="https://example.test/ns">
              <channel>
                <item><x:guid>guid-1</x:guid><x:title>Episode</x:title></item>
              </channel>
            </rss>
            """
        )
        item = transcriber.find_feed_item(root, "guid-1", "")
        self.assertIsNotNone(item)


class EpisodeFilenameTests(unittest.TestCase):
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

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp_dir.cleanup()

    def write_bilingual(self, path):
        transcriber.write_bilingual_vtt(
            [{"start": 0.0, "end": 1.0, "en": "Hello", "zh": "你好"}], path
        )

    def test_reuses_existing_bilingual_file_for_same_owner(self):
        path = self.transcript_dir / "Same.vtt"
        self.write_bilingual(path)
        entry = SimpleNamespace(title="Same", published="")
        owner = {"pod/transcripts/Same.vtt": "guid-1"}

        with patch.object(
            transcriber, "download_audio", side_effect=AssertionError("no download")
        ):
            record, _ = transcriber.process_episode(
                entry, "guid-1", "https://example.test/a.mp3", owner
            )

        self.assertEqual(record["path"], "pod/transcripts/Same.vtt")

    def test_same_title_for_other_identity_gets_stable_suffix(self):
        self.write_bilingual(self.transcript_dir / "Same.vtt")
        entry = SimpleNamespace(title="Same", published="")
        owner = {"pod/transcripts/Same.vtt": "guid-1"}
        cues = [{"start": 0.0, "end": 1.0, "en": "Hello", "zh": "你好"}]

        with patch.object(transcriber, "download_audio", return_value={}), patch.object(
            transcriber, "whisper_transcribe", return_value=(cues, 1.0)
        ), patch.object(transcriber, "translate_cues_with_gemini", return_value=cues):
            record, _ = transcriber.process_episode(
                entry, "guid-2", "https://example.test/a.mp3", owner
            )

        suffix = hashlib.sha1(b"guid-2").hexdigest()[:8]
        self.assertEqual(record["path"], f"pod/transcripts/Same_{suffix}.vtt")
        self.assertTrue((self.transcript_dir / f"Same_{suffix}.vtt").exists())
        self.assertTrue(
            (self.site_dir / "pod" / "timings" / f"Same_{suffix}.json").exists(),
            "逐词时间轴应与字幕同名写到 timings/",
        )


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

    def test_quota_pause_propagates_without_writing_a_sidecar(self):
        # 配额暂停不是这一集的失败：写了 complete:false 就会把它算进
        # BACKFILL_MAX_ATTEMPTS，两轮之后这集永久退出回填候选。
        target = self.transcript_dir / "Ep.vtt"
        transcriber.write_bilingual_vtt(
            [{"start": 0.0, "end": 1.0, "en": "Old", "zh": "旧"}], target
        )
        old_bytes = target.read_bytes()
        with patch.object(transcriber, "download_audio", return_value={}), patch.object(
            transcriber, "whisper_transcribe", return_value=(self.cues, 42.0)
        ), patch.object(
            transcriber,
            "translate_cues_with_gemini",
            side_effect=transcriber.QuotaExhausted("done for today"),
        ):
            with self.assertRaises(transcriber.QuotaExhausted):
                transcriber.process_episode(
                    self.entry,
                    "g1",
                    "https://cdn.test/a.mp3",
                    {},
                    force=True,
                    output_path=target,
                )
        sidecar = self.site_dir / "pod" / "timings" / "Ep.json"
        self.assertFalse(sidecar.exists(), "配额暂停不能写失败 sidecar")
        self.assertEqual(target.read_bytes(), old_bytes, "旧 VTT 必须原样保留")
        self.assertTrue(
            transcriber.needs_backfill(target, sidecar),
            "配额暂停之后这集必须还留在回填候选里",
        )

    def test_dead_keys_abort_without_recording_an_attempt(self):
        # 鉴权全失效是配置故障，不是这一集的失败：记 attempts 会把这集
        # 挤出回填候选，修好 key 之后也再也补不回来。
        target = self.transcript_dir / "Ep.vtt"
        transcriber.write_bilingual_vtt(
            [{"start": 0.0, "end": 1.0, "en": "Old", "zh": "旧"}], target
        )
        with patch.object(transcriber, "download_audio", return_value={}), patch.object(
            transcriber, "whisper_transcribe", return_value=(self.cues, 42.0)
        ), patch.object(
            transcriber,
            "translate_cues_with_gemini",
            side_effect=transcriber.GeminiAuthFailed("所有 key 都被拒绝"),
        ):
            with self.assertRaises(transcriber.GeminiAuthFailed):
                transcriber.process_episode(
                    self.entry,
                    "g1",
                    "https://cdn.test/a.mp3",
                    {},
                    force=True,
                    output_path=target,
                )
        sidecar = self.site_dir / "pod" / "timings" / "Ep.json"
        self.assertFalse(sidecar.exists(), "鉴权失败不能写失败 sidecar")
        self.assertTrue(
            transcriber.needs_backfill(target, sidecar),
            "修好 key 之后这集必须还留在回填候选里",
        )

    def test_quota_pause_leaves_an_existing_sidecar_untouched(self):
        target = self.transcript_dir / "Ep.vtt"
        transcriber.write_bilingual_vtt(
            [{"start": 0.0, "end": 1.0, "en": "Old", "zh": "旧"}], target
        )
        sidecar = self.site_dir / "pod" / "timings" / "Ep.json"
        transcriber.write_sidecar_failure(sidecar, attempts=1)
        before = sidecar.read_bytes()
        with patch.object(transcriber, "download_audio", return_value={}), patch.object(
            transcriber, "whisper_transcribe", return_value=(self.cues, 42.0)
        ), patch.object(
            transcriber,
            "translate_cues_with_gemini",
            side_effect=transcriber.QuotaExhausted("done for today"),
        ):
            with self.assertRaises(transcriber.QuotaExhausted):
                transcriber.process_episode(
                    self.entry,
                    "g1",
                    "https://cdn.test/a.mp3",
                    {},
                    force=True,
                    output_path=target,
                )
        self.assertEqual(sidecar.read_bytes(), before, "配额暂停不能改已有 sidecar")
        self.assertEqual(transcriber.sidecar_status(sidecar), (False, 1))
        self.assertTrue(transcriber.needs_backfill(target, sidecar))

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

    def test_force_failure_after_an_earlier_failure_increments_attempts(self):
        sidecar = self.site_dir / "pod" / "timings" / "Ep.json"
        transcriber.write_sidecar_failure(sidecar, attempts=1)
        with patch.object(transcriber, "download_audio", return_value={}), patch.object(
            transcriber, "whisper_transcribe", side_effect=RuntimeError("boom")
        ):
            with self.assertRaises(RuntimeError):
                transcriber.process_episode(
                    self.entry, "g1", "https://cdn.test/a.mp3", {}, force=True
                )
        self.assertEqual(transcriber.sidecar_status(sidecar), (False, 2))

    def test_force_failure_after_vtt_write_restores_old_vtt(self):
        # 新 VTT 已经 replace 成功、写 sidecar 才失败：老字节必须被恢复。
        existing = self.transcript_dir / "Ep.vtt"
        transcriber.write_bilingual_vtt(
            [{"start": 0.0, "end": 1.0, "en": "Old", "zh": "旧"}], existing
        )
        old_bytes = existing.read_bytes()
        with patch.object(transcriber, "download_audio", return_value={}), patch.object(
            transcriber, "whisper_transcribe", return_value=(self.cues, 42.0)
        ), patch.object(
            transcriber, "translate_cues_with_gemini", return_value=self.cues
        ), patch.object(
            transcriber, "write_word_timings", side_effect=OSError("disk full")
        ):
            with self.assertRaises(OSError):
                transcriber.process_episode(
                    self.entry, "g1", "https://cdn.test/a.mp3", {}, force=True
                )
        self.assertEqual(existing.read_bytes(), old_bytes, "老 VTT 必须逐字节恢复")
        self.assertNotIn("Hello", existing.read_text(encoding="utf-8"))
        self.assertFalse(existing.with_name("Ep.vtt.tmp").exists(), "不能留下临时文件")
        sidecar = self.site_dir / "pod" / "timings" / "Ep.json"
        self.assertEqual(transcriber.sidecar_status(sidecar), (False, 1))

    def test_failed_force_keeps_complete_sidecar(self):
        # 已完成的 sidecar 是既有成果：失败的 force 尝试不得把它降级成
        # complete:false、也不能把 attempts 顶到上限。
        existing = self.transcript_dir / "Ep.vtt"
        transcriber.write_bilingual_vtt(
            [{"start": 0.0, "end": 1.0, "en": "Old", "zh": "旧"}], existing
        )
        sidecar = self.site_dir / "pod" / "timings" / "Ep.json"
        transcriber.write_word_timings(self.cues, sidecar, 42.0)
        before = sidecar.read_bytes()
        with patch.object(transcriber, "download_audio", return_value={}), patch.object(
            transcriber, "whisper_transcribe", side_effect=RuntimeError("boom")
        ):
            with self.assertRaises(RuntimeError):
                transcriber.process_episode(
                    self.entry, "g1", "https://cdn.test/a.mp3", {}, force=True
                )
        self.assertEqual(sidecar.read_bytes(), before, "已完成的 sidecar 必须原样保留")
        self.assertEqual(transcriber.sidecar_status(sidecar), (True, 1))
        self.assertFalse(
            transcriber.needs_backfill(existing, sidecar),
            "已完成的 sidecar 不能被标记成需要回填",
        )

    def test_bookkeeping_failure_does_not_mask_transcription_error(self):
        with patch.object(transcriber, "download_audio", return_value={}), patch.object(
            transcriber, "whisper_transcribe", side_effect=RuntimeError("boom")
        ), patch.object(
            transcriber, "write_sidecar_failure", side_effect=OSError("no sidecar")
        ):
            with self.assertRaises(RuntimeError) as caught:
                transcriber.process_episode(
                    self.entry, "g1", "https://cdn.test/a.mp3", {}, force=True
                )
        self.assertEqual(str(caught.exception), "boom", "记账失败不能掩盖真实异常")

    def test_without_force_existing_vtt_is_reused(self):
        existing = self.transcript_dir / "Ep.vtt"
        transcriber.write_bilingual_vtt(
            [{"start": 0.0, "end": 1.0, "en": "Old", "zh": "旧"}], existing
        )
        with patch.object(
            transcriber, "download_audio", side_effect=AssertionError("不应下载")
        ):
            transcriber.process_episode(self.entry, "g1", "https://cdn.test/a.mp3", {})

    def test_force_with_explicit_output_path_uses_that_stem(self):
        # 109/119 的既有 hwmym 文件名与标题推导名不一致：force 重转必须写到
        # 调用方给的路径，否则会多出一份文件、旧文件永远没有 sidecar。
        target = self.transcript_dir / "Original Name.vtt"
        transcriber.write_bilingual_vtt(
            [{"start": 0.0, "end": 1.0, "en": "Old", "zh": "旧"}], target
        )
        with patch.object(transcriber, "download_audio", return_value={}), patch.object(
            transcriber, "whisper_transcribe", return_value=(self.cues, 42.0)
        ), patch.object(transcriber, "translate_cues_with_gemini", return_value=self.cues):
            record, _ = transcriber.process_episode(
                self.entry,
                "g1",
                "https://cdn.test/a.mp3",
                {},
                force=True,
                output_path=target,
            )
        self.assertIn("Hello", target.read_text(encoding="utf-8"))
        self.assertEqual(record["path"], "pod/transcripts/Original Name.vtt")
        sidecar = self.site_dir / "pod" / "timings" / "Original Name.json"
        self.assertEqual(transcriber.sidecar_status(sidecar), (True, 1))
        self.assertFalse(
            (self.transcript_dir / "Ep.vtt").exists(), "不能另外写出标题推导名的文件"
        )

    def test_explicit_output_path_skips_title_collision_suffix(self):
        # 标题推导名正好是被 guid-1 占用的名字：不给 output_path 时必然加 sha1
        # 后缀（本次先证明碰撞是活的），给了 output_path 才证明碰撞分支被跳过。
        self.entry.title = "Original Name"
        target = self.transcript_dir / "Original Name.vtt"
        owner = {"pod/transcripts/Original Name.vtt": "guid-1"}
        suffix = hashlib.sha1(b"guid-2").hexdigest()[:8]

        with patch.object(transcriber, "download_audio", return_value={}), patch.object(
            transcriber, "whisper_transcribe", return_value=(self.cues, 42.0)
        ), patch.object(transcriber, "translate_cues_with_gemini", return_value=self.cues):
            record, _ = transcriber.process_episode(
                self.entry,
                "guid-2",
                "https://cdn.test/a.mp3",
                owner,
                force=True,
                output_path=target,
            )

        self.assertEqual(record["path"], "pod/transcripts/Original Name.vtt")
        self.assertTrue(target.exists())
        self.assertFalse(
            (self.transcript_dir / f"Original Name_{suffix}.vtt").exists(),
            "output_path 已由调用方指定，不能再加同标题后缀",
        )

        # 同一份 owner 表、同一个调用者，不给 output_path 时必须走后缀分支，
        # 否则上面的断言即使删掉 output_path 支持也照样通过。
        with patch.object(transcriber, "download_audio", return_value={}), patch.object(
            transcriber, "whisper_transcribe", return_value=(self.cues, 42.0)
        ), patch.object(transcriber, "translate_cues_with_gemini", return_value=self.cues):
            record, _ = transcriber.process_episode(
                self.entry, "guid-2", "https://cdn.test/a.mp3", owner, force=True
            )

        self.assertEqual(
            record["path"], f"pod/transcripts/Original Name_{suffix}.vtt"
        )
        self.assertTrue((self.transcript_dir / f"Original Name_{suffix}.vtt").exists())


class RootIndexTests(unittest.TestCase):
    def test_root_index_percent_encodes_slug(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            site_dir = Path(temp_dir) / "site"
            (site_dir / "99%-invisible").mkdir(parents=True)
            (site_dir / "99%-invisible" / "index.html").write_text(
                "ok", encoding="utf-8"
            )
            with patch.object(transcriber, "SITE_DIR", site_dir):
                transcriber.rebuild_root_index()

            page = (site_dir / "index.html").read_text(encoding="utf-8")
            self.assertIn('href="99%25-invisible/index.html"', page)


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

    def test_label_hides_short_key_entirely(self):
        ring = transcriber.GeminiKeyRing(["abcd"], factory=lambda api_key: object())
        self.assertEqual(ring.label(), "#1（…****）")

    def test_label_is_safe_after_every_key_is_exhausted(self):
        ring = transcriber.GeminiKeyRing(["only-key"], factory=lambda api_key: object())
        self.assertFalse(ring.mark_exhausted())
        self.assertFalse(ring.available)
        self.assertEqual(ring.label(), "#-（…****）", "耗尽后 label() 不能抛异常")

    def test_ring_rejects_empty_key_list(self):
        with self.assertRaises(transcriber.QuotaExhausted):
            transcriber.GeminiKeyRing([])


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

    def test_invalid_key_400_is_an_auth_error(self):
        # google-genai 的 ClientError 真实形状：HTTP 400 + INVALID_ARGUMENT。
        class _InvalidKey(Exception):
            code = 400

        exc = _InvalidKey(
            "400 INVALID_ARGUMENT. {'error': {'code': 400, 'message': "
            "'API key not valid. Please pass a valid API key.', "
            "'status': 'INVALID_ARGUMENT'}}"
        )
        self.assertTrue(
            transcriber.is_auth_error(exc),
            "400 + 'API key not valid' 必须触发换 key，不能走退避重试",
        )
        self.assertFalse(transcriber.is_quota_error(exc))

    def test_invalid_key_text_is_auth_error_without_status_code(self):
        exc = Exception("API key not valid. Please pass a valid API key.")
        self.assertTrue(transcriber.is_auth_error(exc))

    def test_api_key_invalid_literal_is_an_auth_error(self):
        self.assertTrue(transcriber.is_auth_error(Exception("API_KEY_INVALID")))

    def test_generic_400_stays_a_normal_error(self):
        class _BadRequest(Exception):
            code = 400

        self.assertFalse(
            transcriber.is_auth_error(_BadRequest("400 INVALID_ARGUMENT: bad JSON"))
        )

    def test_quota_rotation_consumes_no_backoff(self):
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
        with patch.object(
            transcriber, "wait_for_gemini_rate_limit"
        ), patch.object(transcriber.time, "sleep") as sleep:
            transcriber.translate_blocks(
                ring, [(0, {"en": "Hello there friend"})], translated
            )
        sleep.assert_not_called()
        self.assertEqual(translated, {0: "译0"})
        self.assertEqual(calls, ["k1", "k2"])

    def test_rotation_log_never_prints_the_key(self):
        class Client:
            @property
            def models(self):
                return self

            def generate_content(self, **kwargs):
                raise _QuotaError("429 RESOURCE_EXHAUSTED")

        ring = transcriber.GeminiKeyRing(
            ["AIzaSySECRET-1111", "AIzaSySECRET-2222"],
            factory=lambda api_key: Client(),
        )
        with patch.object(transcriber, "wait_for_gemini_rate_limit"), self.assertLogs(
            transcriber.log, level="WARNING"
        ) as captured:
            with self.assertRaises(transcriber.QuotaExhausted):
                transcriber.translate_blocks(
                    ring, [(0, {"en": "Hello there friend"})], {}
                )
        output = "\n".join(captured.output)
        self.assertIn("…1111", output)
        self.assertNotIn("AIzaSySECRET", output)

    def test_all_keys_rejected_by_auth_raises_gemini_auth_failed(self):
        # 无效/吊销的 key 不能表现成「配额用完」：回填会当干净暂停、退出 0，
        # 每个分片先下载+转录 1~2 小时才发现 key 是死的。
        class Client:
            @property
            def models(self):
                return self

            def generate_content(self, **kwargs):
                raise _AuthError("403 PERMISSION_DENIED")

        ring = transcriber.GeminiKeyRing(["k1", "k2"], factory=lambda api_key: Client())
        with patch.object(transcriber, "wait_for_gemini_rate_limit"):
            with self.assertRaises(transcriber.GeminiAuthFailed):
                transcriber.translate_blocks(
                    ring, [(0, {"en": "Hello there friend"})], {}
                )

    def test_single_invalid_key_raises_gemini_auth_failed(self):
        class Client:
            @property
            def models(self):
                return self

            def generate_content(self, **kwargs):
                raise _AuthError("403 PERMISSION_DENIED")

        ring = transcriber.GeminiKeyRing(["k1"], factory=lambda api_key: Client())
        with patch.object(transcriber, "wait_for_gemini_rate_limit"):
            with self.assertRaises(transcriber.GeminiAuthFailed):
                transcriber.translate_blocks(
                    ring, [(0, {"en": "Hello there friend"})], {}
                )

    def test_quota_then_auth_still_counts_as_quota_exhaustion(self):
        # 先耗尽的 key 明天会恢复，不能因为后面一把 key 无效就把整个 job 判死。
        class Client:
            def __init__(self, api_key):
                self.api_key = api_key

            @property
            def models(self):
                return self

            def generate_content(self, model=None, contents=None, config=None):
                if self.api_key == "k1":
                    raise _QuotaError("429 RESOURCE_EXHAUSTED")
                raise _AuthError("403 PERMISSION_DENIED")

        ring = transcriber.GeminiKeyRing(["k1", "k2"], factory=Client)
        with patch.object(transcriber, "wait_for_gemini_rate_limit"):
            with self.assertRaises(transcriber.QuotaExhausted):
                transcriber.translate_blocks(
                    ring, [(0, {"en": "Hello there friend"})], {}
                )

    def test_auth_failed_is_not_a_quota_error(self):
        exc = transcriber.GeminiAuthFailed("所有 key 都被拒绝")
        self.assertFalse(transcriber.is_quota_error(exc))
        self.assertFalse(transcriber.is_auth_error(exc))
        self.assertNotIsInstance(exc, transcriber.QuotaExhausted)


class LogScrubbingTests(unittest.TestCase):
    def test_log_line_with_a_configured_key_is_scrubbed(self):
        logger = logging.getLogger("transcribe-scrub-test")
        logger.propagate = False
        logger.addFilter(transcriber.SecretScrubbingFilter(["AIzaSyLEAK-9999"]))
        try:
            with self.assertLogs(logger, level="ERROR") as captured:
                logger.error(
                    "下载失败：https://cdn.test/a.mp3?key=%s",
                    "AIzaSyLEAK-9999",
                )
        finally:
            logger.filters.clear()
        output = "\n".join(captured.output)
        self.assertNotIn("AIzaSyLEAK-9999", output)
        self.assertIn("***", output)

    def test_log_exception_with_a_key_in_the_traceback_is_scrubbed(self):
        # log.exception 的行内消息只是一半：traceback 里的 str(exc) 同样带 key。
        logger = logging.getLogger("transcribe-scrub-exc-test")
        logger.propagate = False
        logger.addFilter(transcriber.SecretScrubbingFilter(["AIzaSyLEAK-9999"]))
        try:
            with self.assertLogs(logger, level="ERROR") as captured:
                try:
                    raise RuntimeError(
                        "GET https://cdn.test/a.mp3?key=AIzaSyLEAK-9999 failed"
                    )
                except RuntimeError as exc:
                    logger.exception("下载失败：%s", exc)
        finally:
            logger.filters.clear()
        output = "\n".join(captured.output)
        self.assertNotIn("AIzaSyLEAK-9999", output)
        self.assertIn("***", output)

    def test_scrubber_is_idempotent_and_tolerates_non_string_messages(self):
        scrubber = transcriber.SecretScrubbingFilter(["k-secret"])
        record = logging.LogRecord(
            "x", logging.INFO, __file__, 1, "a k-secret b", None, None
        )
        scrubber.filter(record)
        scrubber.filter(record)
        self.assertEqual(record.getMessage(), "a *** b")

        numeric = logging.LogRecord("x", logging.INFO, __file__, 1, 42, None, None)
        self.assertTrue(scrubber.filter(numeric))
        self.assertEqual(numeric.getMessage(), "42")

    def test_module_logger_has_a_scrubber_installed(self):
        self.assertTrue(
            any(
                isinstance(item, transcriber.SecretScrubbingFilter)
                for item in transcriber.log.filters
            )
        )


def _decode_trailing_object(prompt):
    """取出 prompt 末尾那段待翻译 JSON，用来模拟模型只看到编号和英文。"""
    start = prompt.rfind("{")
    while start >= 0:
        try:
            value, _ = json.JSONDecoder().raw_decode(prompt[start:])
        except json.JSONDecodeError:
            start = prompt.rfind("{", 0, start)
            continue
        if isinstance(value, dict) and value:
            return value
        start = prompt.rfind("{", 0, start)
    raise AssertionError("prompt 末尾没有 JSON 对象：" + prompt[-200:])


class FakeGemini:
    """按编号作答的假客户端；drops 逐个复现「合并重复短句导致漏条目」的真实故障。"""

    def __init__(self, drops=()):
        self.drops = [set(d) for d in drops]
        self.requests = []
        self.models = SimpleNamespace(generate_content=self._generate)

    def _generate(self, model=None, contents=None, config=None):
        source = _decode_trailing_object(contents)
        self.requests.append(sorted(source, key=int))
        drop = self.drops.pop(0) if self.drops else set()
        # 故意倒序返回，配对不能依赖返回顺序。
        result = {
            key: f"译{key}::{source[key]}"
            for key in reversed(sorted(source, key=int))
            if key not in drop
        }
        return SimpleNamespace(text=json.dumps(result, ensure_ascii=False))


class TranslationPairingTests(unittest.TestCase):
    def setUp(self):
        # 真实 hwmym 字幕里 "Yeah." 这类短句会重复十几遍，最容易触发模型合并。
        self.cues = [
            {"start": 0.0, "end": 1.0, "en": "Yeah."},
            {"start": 1.0, "end": 2.0, "en": "So for our second season we united forces."},
            {"start": 2.0, "end": 3.0, "en": "Yeah."},
            {"start": 3.0, "end": 4.0, "en": "Right."},
            {"start": 4.0, "end": 5.0, "en": "Yeah."},
            {"start": 5.0, "end": 6.0, "en": "And Angela over at OLN."},
        ]

    def run_translation(self, drops, cues=None):
        fake = FakeGemini(drops)
        cues = self.cues if cues is None else cues
        real_ring = transcriber.GeminiKeyRing

        def make_ring(keys, factory=None):
            # 只替换底层 client；轮换逻辑仍走真实的 GeminiKeyRing。
            return real_ring(["test-key"], factory=lambda api_key: fake)

        with patch.object(transcriber, "GeminiKeyRing", make_ring), patch.object(
            transcriber, "wait_for_gemini_rate_limit", lambda: None
        ), patch.object(transcriber, "TRANSLATE_BASE_DELAY", 0.0), patch.object(
            transcriber, "TRANSLATE_BATCH_DELAY", 0.0
        ):
            result = transcriber.translate_cues_with_gemini(cues)
        return fake, result

    def test_translates_every_duplicate_short_phrase(self):
        _, result = self.run_translation([])
        for index, cue in enumerate(self.cues):
            self.assertEqual(cue["zh"], f"译{index}::{cue['en']}")
        self.assertEqual(result, self.cues)

    def test_missing_cues_are_retried_without_resending_the_batch(self):
        fake, _ = self.run_translation([{"2", "4"}])
        self.assertEqual(len(fake.requests), 2, "漏两条不该把整批 6 条重发")
        self.assertEqual(fake.requests[1], ["2", "4"])
        for index, cue in enumerate(self.cues):
            self.assertEqual(cue["zh"], f"译{index}::{cue['en']}")

    def test_persistent_single_cue_failure_names_the_cue(self):
        with self.assertRaises(RuntimeError) as caught:
            self.run_translation([{"0"}] * 8, cues=[self.cues[0]])
        self.assertIn("Yeah.", str(caught.exception))


class WordTimingTests(unittest.TestCase):
    def segment(self, start, end, text, words=None):
        seg = {"start": start, "end": end, "text": text}
        if words is not None:
            seg["words"] = [{"w": w, "s": s, "e": e} for w, s, e in words]
        return seg

    def test_cue_bounds_come_from_real_word_times(self):
        seg = self.segment(
            0.0,
            4.0,
            "Hello there. Bye now.",
            [
                ("Hello", 0.2, 0.6),
                ("there.", 0.6, 1.0),
                ("Bye", 3.0, 3.4),
                ("now.", 3.4, 3.9),
            ],
        )
        cues = transcriber.resegment_whisper_segments([seg])
        self.assertEqual(len(cues), 2)
        self.assertAlmostEqual(cues[0]["start"], 0.2)
        self.assertAlmostEqual(cues[0]["end"], 1.0)
        self.assertAlmostEqual(cues[1]["start"], 3.0)
        self.assertAlmostEqual(cues[1]["end"], 3.9)
        self.assertEqual([w["w"] for w in cues[0]["words"]], ["Hello", "there."])

    def test_long_segment_keeps_words_in_order(self):
        text = "First part here, second part follows, third part ends."
        tokens = text.split()
        words = [(t.strip(".,"), 1.0 + i * 0.5, 1.4 + i * 0.5) for i, t in enumerate(tokens)]
        seg = self.segment(1.0, 1.0 + len(words) * 0.5, text, words)
        cues = transcriber.resegment_whisper_segments([seg], max_chars=20)
        self.assertGreater(len(cues), 1)
        joined = [w["w"] for cue in cues for w in cue["words"]]
        self.assertEqual(joined, [t.strip(".,") for t in tokens], "词不能丢也不能乱序")
        for cue in cues:
            self.assertLess(cue["start"], cue["end"])
            self.assertAlmostEqual(cue["start"], cue["words"][0]["s"])
            self.assertAlmostEqual(cue["end"], cue["words"][-1]["e"])

    def test_missing_words_fall_back_to_proportional(self):
        cues = transcriber.resegment_whisper_segments(
            [self.segment(0.0, 4.0, "One. Two.")]
        )
        self.assertEqual(len(cues), 2)
        self.assertAlmostEqual(cues[0]["start"], 0.0)
        self.assertAlmostEqual(cues[-1]["end"], 4.0)
        self.assertFalse(any("words" in cue for cue in cues))

    def test_token_count_mismatch_still_assigns_words(self):
        # Whisper 的词切分和文本 token 数可能对不上；按比例分词，保住词级时间。
        seg = self.segment(
            0.0, 2.0, "We don't stop.", [("We", 0.0, 0.3), ("stop.", 1.0, 1.4)]
        )
        cues = transcriber.resegment_whisper_segments([seg])
        self.assertEqual(len(cues), 1)
        self.assertEqual([w["w"] for w in cues[0]["words"]], ["We", "stop."])
        self.assertAlmostEqual(cues[0]["start"], 0.0)
        self.assertAlmostEqual(cues[0]["end"], 1.4)

    def test_hyphenated_compound_merges_into_one_word(self):
        # Whisper 会把 Whim-Yim 切成 'Whim' + '-Yim.'；合并后词数才对得上文本。
        seg = self.segment(
            0.0,
            2.0,
            "Whim-Yim, I say let's commit.",
            [
                ("Whim", 0.0, 0.3),
                ("-Yim,", 0.3, 0.6),
                ("I", 0.6, 0.7),
                ("say", 0.7, 0.9),
                ("let's", 0.9, 1.2),
                ("commit.", 1.2, 1.8),
            ],
        )
        cues = transcriber.resegment_whisper_segments([seg])
        self.assertEqual(len(cues), 1)
        self.assertEqual([w["w"] for w in cues[0]["words"]],
                         ["Whim-Yim,", "I", "say", "let's", "commit."])
        self.assertAlmostEqual(cues[0]["start"], 0.0)
        self.assertAlmostEqual(cues[0]["end"], 1.8)

    def test_domain_continuation_merges(self):
        seg = self.segment(
            0.0,
            2.0,
            "Learn more at HowWeMadeYourMother.com.",
            [
                ("Learn", 0.0, 0.2),
                ("more", 0.2, 0.4),
                ("at", 0.4, 0.5),
                ("HowWeMadeYourMother", 0.5, 1.4),
                (".com.", 1.4, 1.8),
            ],
        )
        cues = transcriber.resegment_whisper_segments([seg])
        self.assertEqual(len(cues), 1)
        self.assertEqual(
            [w["w"] for w in cues[0]["words"]],
            ["Learn", "more", "at", "HowWeMadeYourMother.com."],
        )

    def test_unmatched_counts_share_words_proportionally(self):
        # 词数对不上且没有可合并的续接词时，按 cue 文本长度比例分词，保证不丢词。
        words = [("Hello", 0.0, 0.3), ("big", 0.6, 0.9), ("world", 1.2, 1.6)]
        seg = self.segment(0.0, 2.0, "Hello big world.", words)
        cues = transcriber.resegment_whisper_segments([seg], max_chars=10)
        self.assertEqual(len(cues), 1, "这段没有可切分的标点，应保持一段")
        self.assertEqual([w["w"] for w in cues[0]["words"]], ["Hello", "big", "world"])

    def test_degenerate_word_time_falls_back(self):
        seg = self.segment(1.0, 2.0, "That", [("That", 1.5, 1.5)])
        cues = transcriber.resegment_whisper_segments([seg])
        self.assertEqual(len(cues), 1)
        self.assertAlmostEqual(cues[0]["start"], 1.0)
        self.assertAlmostEqual(cues[0]["end"], 2.0)
        self.assertNotIn("words", cues[0])


class WordTimingsFileTests(unittest.TestCase):
    def cues(self):
        return [
            {
                "start": 0.2,
                "end": 1.0,
                "en": "Hello there.",
                "zh": "你好。",
                "words": [
                    {"w": "Hello", "s": 0.2, "e": 0.6},
                    {"w": "there.", "s": 0.6, "e": 1.0},
                ],
            },
            {"start": 1.0, "end": 2.0, "en": "No words here.", "zh": "没有词。"},
        ]

    def test_writes_tmlt_schema(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "timings" / "episode.json"
            transcriber.write_word_timings(self.cues(), path, audio_seconds=12.5)
            doc = json.loads(path.read_text(encoding="utf-8"))
        self.assertTrue(doc["complete"])
        self.assertEqual(doc["attempts"], 1)
        self.assertEqual(doc["audio_seconds"], 12.5)
        first, second = doc["segments"]
        self.assertEqual(first["text"], "Hello there.")
        self.assertEqual(first["start"], 200)
        self.assertEqual(first["end"], 1000)
        self.assertEqual(first["words"], [["Hello", 200, 400], ["there.", 600, 400]])
        self.assertNotIn("zh", first, "sidecar 只带英文词，不带译文")
        self.assertIsNone(second["end"], "没有词的 cue end 置空，消费方回退到 VTT")
        self.assertEqual(second["words"], [])

    def test_clamps_zero_length_word_duration(self):
        cues = [
            {
                "start": 1.0,
                "end": 1.5,
                "en": "That",
                "zh": "那",
                "words": [{"w": "That", "s": 1.2, "e": 1.2}],
            }
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "x.json"
            transcriber.write_word_timings(cues, path, audio_seconds=3.0)
            doc = json.loads(path.read_text(encoding="utf-8"))
        seg = doc["segments"][0]
        self.assertEqual(seg["words"], [["That", 1200, 0]])
        self.assertEqual(seg["end"], 1500, "词时间退化时用 cue 自身的结束时间")

    def test_writes_nothing_for_empty_cues(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "x.json"
            with self.assertRaises(ValueError):
                transcriber.write_word_timings([], path, audio_seconds=0.0)
            self.assertFalse(path.exists())


class SidecarStatusTests(unittest.TestCase):
    def test_status_of_missing_or_broken_file_is_incomplete(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "x.json"
            self.assertEqual(transcriber.sidecar_status(path), (False, 0))
            path.write_text("{not json", encoding="utf-8")
            self.assertEqual(transcriber.sidecar_status(path), (False, 0))

    def test_status_of_non_dict_payload_is_incomplete(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "x.json"
            path.write_text(json.dumps([1, 2, 3]), encoding="utf-8")
            self.assertEqual(transcriber.sidecar_status(path), (False, 0))

    def test_status_reads_complete_and_attempts(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "x.json"
            path.write_text(
                json.dumps({"complete": True, "attempts": 2}), encoding="utf-8"
            )
            self.assertEqual(transcriber.sidecar_status(path), (True, 2))

    def test_failure_sidecar_is_incomplete_with_attempt_count(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "x.json"
            transcriber.write_sidecar_failure(path, attempts=1)
            self.assertEqual(transcriber.sidecar_status(path), (False, 1))

    def test_partial_sidecar_round_trips_complete_and_attempts(self):
        cues = [
            {
                "start": 0.0,
                "end": 1.0,
                "en": "Hello there.",
                "zh": "你好。",
                "words": [
                    {"w": "Hello", "s": 0.0, "e": 0.5},
                    {"w": "there.", "s": 0.5, "e": 1.0},
                ],
            }
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "x.json"
            transcriber.write_word_timings(
                cues, path, audio_seconds=1.0, complete=False, attempts=3
            )
            self.assertEqual(transcriber.sidecar_status(path), (False, 3))

    def test_truthy_string_complete_still_reads_as_incomplete(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "x.json"
            path.write_text(
                json.dumps({"complete": "true", "attempts": 1}), encoding="utf-8"
            )
            self.assertEqual(transcriber.sidecar_status(path), (False, 1))

    def test_non_integer_attempts_is_treated_as_unstarted(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "x.json"
            for attempts in ("abc", [1], {"n": 1}, True):
                with self.subTest(attempts=attempts):
                    path.write_text(
                        json.dumps({"complete": True, "attempts": attempts}),
                        encoding="utf-8",
                    )
                    self.assertEqual(transcriber.sidecar_status(path), (False, 0))

    def test_sidecar_path_matches_vtt_stem(self):
        vtt = Path("site/pod/transcripts/Ep 1.vtt")
        self.assertEqual(transcriber.sidecar_path_for(vtt).name, "Ep 1.json")


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

    def test_shard_does_not_depend_on_process_hash_seed(self):
        # 分片必须跨进程稳定，因此不能用内置 hash()（每个进程加盐）。
        expected = int(
            hashlib.sha1("guid-1".encode("utf-8")).hexdigest(), 16
        ) % 20
        self.assertEqual(transcriber.shard_of("guid-1", 20), expected)

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

    def test_needs_backfill_rejects_invalid_vtt_even_without_sidecar(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            vtt = Path(temp_dir) / "english.vtt"
            sidecar = Path(temp_dir) / "english.json"
            vtt.write_text(
                "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\nThere\n",
                encoding="utf-8",
            )
            self.assertFalse(transcriber.needs_backfill(vtt, sidecar))

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
        self.assertEqual(got[0]["vtt_path"], Path("site") / "pod/transcripts/Ep.vtt")

    def test_candidates_skip_entries_without_audio_or_record(self):
        no_audio = SimpleNamespace(id="g2", title="No audio", published="", enclosures=[], links=[])
        entry = SimpleNamespace(
            id="g1", title="Ep", published="",
            enclosures=[{"href": "https://cdn.test/a.mp3", "type": "audio/mpeg"}],
            links=[],
        )
        records = {"g1": {"identity": "g1", "path": "pod/transcripts/Ep.vtt", "title": "Ep"}}
        with patch.object(transcriber, "SITE_DIR", Path("site")), patch.object(
            transcriber, "needs_backfill", return_value=True
        ):
            got = transcriber.build_backfill_candidates([no_audio, entry], records)
        self.assertEqual([c["identity"] for c in got], ["g1"])

    def test_candidates_skip_records_without_path(self):
        entry = SimpleNamespace(
            id="g1", title="Ep", published="",
            enclosures=[{"href": "https://cdn.test/a.mp3", "type": "audio/mpeg"}],
            links=[],
        )
        records = {"g1": {"identity": "g1", "path": "", "title": "Ep"}}
        with patch.object(transcriber, "SITE_DIR", Path("site")), patch.object(
            transcriber, "needs_backfill", return_value=True
        ):
            got = transcriber.build_backfill_candidates([entry], records)
        self.assertEqual(got, [])

    def test_cap_exhausted_episode_is_named_in_a_warning(self):
        # 达到重试上限的集会被安静地排除在候选之外；日志必须点名（标题 + 2/2），
        # 否则「这集为什么一直没补上」永远查不到。
        with tempfile.TemporaryDirectory() as temp_dir:
            site_dir = Path(temp_dir) / "site"
            vtt = site_dir / "pod" / "transcripts" / "Gone.vtt"
            transcriber.write_bilingual_vtt(
                [{"start": 0.0, "end": 1.0, "en": "Hello", "zh": "你好"}], vtt
            )
            sidecar = site_dir / "pod" / "timings" / "Gone.json"
            transcriber.write_sidecar_failure(
                sidecar, attempts=transcriber.BACKFILL_MAX_ATTEMPTS
            )
            entry = SimpleNamespace(
                id="g1",
                title="Gone Episode",
                published="",
                enclosures=[{"href": "https://cdn.test/a.mp3", "type": "audio/mpeg"}],
                links=[],
            )
            records = {
                "g1": {
                    "identity": "g1",
                    "path": "pod/transcripts/Gone.vtt",
                    "title": "Gone Episode",
                }
            }
            with patch.object(transcriber, "SITE_DIR", site_dir), patch.object(
                transcriber, "TIMING_DIR", site_dir / "pod" / "timings"
            ), self.assertLogs(transcriber.log, level="WARNING") as captured:
                got = transcriber.build_backfill_candidates([entry], records)

        self.assertEqual(got, [], "达上限的集不能再进候选")
        output = "\n".join(captured.output)
        self.assertIn("Gone Episode", output)
        self.assertIn(
            f"{transcriber.BACKFILL_MAX_ATTEMPTS}/{transcriber.BACKFILL_MAX_ATTEMPTS}",
            output,
        )

    def test_candidates_stay_quiet_about_episodes_that_still_have_attempts(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            site_dir = Path(temp_dir) / "site"
            vtt = site_dir / "pod" / "transcripts" / "Fresh.vtt"
            transcriber.write_bilingual_vtt(
                [{"start": 0.0, "end": 1.0, "en": "Hello", "zh": "你好"}], vtt
            )
            sidecar = site_dir / "pod" / "timings" / "Fresh.json"
            transcriber.write_sidecar_failure(sidecar, attempts=1)
            entry = SimpleNamespace(
                id="g1",
                title="Fresh Episode",
                published="",
                enclosures=[{"href": "https://cdn.test/a.mp3", "type": "audio/mpeg"}],
                links=[],
            )
            records = {
                "g1": {
                    "identity": "g1",
                    "path": "pod/transcripts/Fresh.vtt",
                    "title": "Fresh Episode",
                }
            }
            with patch.object(transcriber, "SITE_DIR", site_dir), patch.object(
                transcriber, "TIMING_DIR", site_dir / "pod" / "timings"
            ), captured_messages(transcriber.log) as messages:
                got = transcriber.build_backfill_candidates([entry], records)

        self.assertEqual(len(got), 1)
        self.assertFalse(
            [message for message in messages if "Fresh Episode" in message],
            "还有重试机会的集不能出现在警告里",
        )

    def test_candidates_dedupe_by_vtt_path_keeping_first_entry(self):
        # migrate_legacy_records 可能让两个 identity 共用同一条 path；两个候选会
        # 按 identity 落到不同分片，却并发写同一份 sidecar。因此每条 path 只留
        # 第一个（feed 顺序）候选。
        first = SimpleNamespace(
            id="g1", title="Ep", published="",
            enclosures=[{"href": "https://cdn.test/a.mp3", "type": "audio/mpeg"}],
            links=[],
        )
        second = SimpleNamespace(
            id="g2", title="Ep", published="",
            enclosures=[{"href": "https://cdn.test/b.mp3", "type": "audio/mpeg"}],
            links=[],
        )
        records = {
            "g1": {"identity": "g1", "path": "pod/transcripts/Ep.vtt", "title": "Ep"},
            "g2": {"identity": "g2", "path": "pod/transcripts/Ep.vtt", "title": "Ep"},
        }
        with patch.object(transcriber, "SITE_DIR", Path("site")), patch.object(
            transcriber, "needs_backfill", return_value=True
        ):
            got = transcriber.build_backfill_candidates([first, second], records)
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["identity"], "g1")
        self.assertEqual(got[0]["audio_url"], "https://cdn.test/a.mp3")
        self.assertEqual(got[0]["vtt_path"], Path("site") / "pod/transcripts/Ep.vtt")


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
            self.items(6), shard=0, shards=2, max_minutes=10,
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

    def test_quota_pause_stops_the_shard_without_counting_a_failure(self):
        calls = []

        def process(item):
            calls.append(item["identity"])
            raise transcriber.QuotaExhausted("done for today")

        stats = transcriber.run_backfill(
            self.items(3), shard=0, shards=1, max_minutes=10,
            process=process, clock=lambda: 0.0,
        )
        self.assertEqual(len(calls), 1, "配额耗尽后不能再碰下一集")
        self.assertTrue(stats["quota"])
        self.assertEqual(stats["failed"], 0, "配额暂停不能算成失败")
        self.assertEqual(stats["done"], 0)

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

    def test_dead_keys_fail_the_shard_instead_of_pausing_it(self):
        calls = []

        def process(item):
            calls.append(item["identity"])
            raise transcriber.GeminiAuthFailed("所有 key 都被拒绝")

        with self.assertRaises(transcriber.GeminiAuthFailed):
            transcriber.run_backfill(
                self.items(3), shard=0, shards=1, max_minutes=10,
                process=process, clock=lambda: 0.0,
            )
        self.assertEqual(len(calls), 1, "鉴权失败必须立刻冒泡，不能继续下一集")

    def test_failure_line_does_not_promise_retry_for_a_capped_episode(self):
        # 这一集这次失败后 attempts 已经到 2/2：再写「下轮重试」就是骗人。
        with tempfile.TemporaryDirectory() as temp_dir:
            timings = Path(temp_dir)
            transcriber.write_sidecar_failure(
                timings / "x.json", attempts=transcriber.BACKFILL_MAX_ATTEMPTS
            )

            def process(item):
                raise RuntimeError("boom")

            with patch.object(transcriber, "TIMING_DIR", timings), self.assertLogs(
                transcriber.log, level="WARNING"
            ) as captured:
                stats = transcriber.run_backfill(
                    self.items(1), shard=0, shards=1, max_minutes=10,
                    process=process, clock=lambda: 0.0,
                )

        self.assertEqual(stats["failed"], 1)
        output = "\n".join(captured.output)
        self.assertNotIn("下轮重试", output)
        self.assertIn("Ep 0", output)
        self.assertIn(
            f"{transcriber.BACKFILL_MAX_ATTEMPTS}/{transcriber.BACKFILL_MAX_ATTEMPTS}",
            output,
        )

    def test_skipped_counts_other_shards_and_done_counts_own(self):
        seen = []
        stats = transcriber.run_backfill(
            self.items(6), shard=0, shards=2, max_minutes=10,
            process=lambda item: seen.append(item["identity"]), clock=lambda: 0.0,
        )
        self.assertEqual(stats["done"], len(seen))
        self.assertEqual(stats["skipped"], 6 - len(seen))
        self.assertEqual(stats["failed"], 0)
        self.assertFalse(stats["quota"])

    def test_default_process_writes_to_the_candidate_path(self):
        # 既有 VTT 文件名与标题推导名大多不一致：force 重转必须落在候选给的
        # 路径上，否则会多写一份新文件、旧文件永远没有 sidecar。
        item = self.items(1)[0]
        item["vtt_path"] = Path("site") / "pod" / "transcripts" / "Old Name.vtt"
        seen = {}

        def fake_process_episode(entry, identity, audio_url, **kwargs):
            seen.update(kwargs)
            seen["identity"], seen["audio_url"], seen["title"] = (
                identity, audio_url, entry.title,
            )
            return {"path": "pod/transcripts/Old Name.vtt"}, {}

        with patch.object(transcriber, "process_episode", fake_process_episode), patch.object(
            transcriber, "SITE_DIR", Path("site")
        ):
            transcriber.process_backfill_item(item)

        self.assertTrue(seen["force"])
        self.assertIsNone(seen["path_owner"])
        self.assertEqual(seen["output_path"], item["vtt_path"])
        self.assertEqual(seen["identity"], "guid-0")
        self.assertEqual(seen["audio_url"], "u")
        self.assertEqual(seen["title"], "Ep 0")

    def test_path_drift_raises_instead_of_reporting_success(self):
        # 产出写到别处却报成功，比这一集失败更糟：必须抛错让 run_backfill 记 failed。
        item = self.items(1)[0]
        item["vtt_path"] = Path("site") / "pod" / "transcripts" / "Old Name.vtt"

        def fake_process_episode(entry, identity, audio_url, **kwargs):
            return {"path": "pod/transcripts/Other Name.vtt"}, {}

        with patch.object(transcriber, "process_episode", fake_process_episode), patch.object(
            transcriber, "SITE_DIR", Path("site")
        ):
            with self.assertRaises(RuntimeError) as caught:
                transcriber.process_backfill_item(item)

        message = str(caught.exception)
        self.assertIn("Old Name.vtt", message)
        self.assertIn("Other Name.vtt", message)


class BackfillEnvTests(unittest.TestCase):
    def backfill_env(self, **overrides):
        """只留测试给的 BACKFILL_*，避免本机环境变量渗进断言。"""
        env = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith("BACKFILL_")
        }
        env.update(overrides)
        return patch.dict(os.environ, env, clear=True)

    def test_env_is_none_without_shard(self):
        with self.backfill_env():
            self.assertIsNone(transcriber.backfill_env())

    def test_blank_shard_is_not_backfill_mode(self):
        with self.backfill_env(BACKFILL_SHARD="   "):
            self.assertIsNone(transcriber.backfill_env())

    def test_env_reads_and_validates(self):
        with self.backfill_env(
            BACKFILL_SHARD="3", BACKFILL_SHARDS="20", BACKFILL_MAX_MINUTES="90"
        ):
            self.assertEqual(
                transcriber.backfill_env(),
                {"shard": 3, "shards": 20, "max_minutes": 90.0},
            )

    def test_env_defaults_match_the_documented_shard_plan(self):
        with self.backfill_env(BACKFILL_SHARD="0"):
            self.assertEqual(
                transcriber.backfill_env(),
                {"shard": 0, "shards": 20, "max_minutes": 280.0},
            )

    def test_bad_env_raises(self):
        with self.backfill_env(BACKFILL_SHARD="x"):
            with self.assertRaises(ValueError):
                transcriber.backfill_env()
        with self.backfill_env(BACKFILL_SHARD="5", BACKFILL_SHARDS="4"):
            with self.assertRaises(ValueError):
                transcriber.backfill_env()

    def test_non_numeric_shards_and_budget_raise(self):
        with self.backfill_env(BACKFILL_SHARD="1", BACKFILL_SHARDS="many"):
            with self.assertRaises(ValueError):
                transcriber.backfill_env()
        with self.backfill_env(BACKFILL_SHARD="1", BACKFILL_MAX_MINUTES="hour"):
            with self.assertRaises(ValueError):
                transcriber.backfill_env()

    def test_negative_shard_raises(self):
        with self.backfill_env(BACKFILL_SHARD="-1", BACKFILL_SHARDS="4"):
            with self.assertRaises(ValueError):
                transcriber.backfill_env()

    def test_zero_or_negative_shards_raise(self):
        for shards in ("0", "-3"):
            with self.subTest(shards=shards), self.backfill_env(
                BACKFILL_SHARD="0", BACKFILL_SHARDS=shards
            ):
                with self.assertRaises(ValueError):
                    transcriber.backfill_env()

    def test_non_positive_budget_raises(self):
        for minutes in ("0", "-5"):
            with self.subTest(minutes=minutes), self.backfill_env(
                BACKFILL_SHARD="0", BACKFILL_MAX_MINUTES=minutes
            ):
                with self.assertRaises(ValueError):
                    transcriber.backfill_env()

    def test_error_message_names_the_bad_config(self):
        with self.backfill_env(BACKFILL_SHARD="7", BACKFILL_SHARDS="4"):
            with self.assertRaises(ValueError) as caught:
                transcriber.backfill_env()
        self.assertIn("7", str(caught.exception))
        self.assertIn("4", str(caught.exception))

    def test_partial_config_without_shard_raises_naming_missing_variable(self):
        # 只设分片数/预算却漏了分片号，等于「以为在回填、实际跑正常模式」，
        # 多分片并行时会一起写 state/feed/index。必须直接报错。
        for partial in ({"BACKFILL_SHARDS": "20"}, {"BACKFILL_MAX_MINUTES": "90"}):
            with self.subTest(partial=partial), self.backfill_env(**partial):
                with self.assertRaises(ValueError) as caught:
                    transcriber.backfill_env()
                self.assertIn("BACKFILL_SHARD", str(caught.exception))

    def test_blank_shard_with_sibling_backfill_keys_raises(self):
        for blank in ("", "   "):
            for partial in (
                {"BACKFILL_SHARDS": "4"},
                {"BACKFILL_MAX_MINUTES": "60"},
                {"BACKFILL_SHARDS": "4", "BACKFILL_MAX_MINUTES": "60"},
            ):
                with self.subTest(blank=blank, partial=partial), self.backfill_env(
                    BACKFILL_SHARD=blank, **partial
                ):
                    with self.assertRaises(ValueError) as caught:
                        transcriber.backfill_env()
                    self.assertIn("BACKFILL_SHARD", str(caught.exception))

    def test_blank_sibling_values_are_still_normal_mode(self):
        # CI 把未启用的变量注入成空串时仍算「没设」，不能误判成回填模式。
        with self.backfill_env(
            BACKFILL_SHARD="", BACKFILL_SHARDS=" ", BACKFILL_MAX_MINUTES=""
        ):
            self.assertIsNone(transcriber.backfill_env())

    def test_non_finite_budget_raises(self):
        # nan/inf 会让 deadline 失效，等于静默取消预算。
        for minutes in ("nan", "inf", "-inf", "Infinity"):
            with self.subTest(minutes=minutes), self.backfill_env(
                BACKFILL_SHARD="0", BACKFILL_MAX_MINUTES=minutes
            ):
                with self.assertRaises(ValueError):
                    transcriber.backfill_env()


class MainBackfillReadOnlyTests(unittest.TestCase):
    """main() 回填分支只读 state：任何 writer 被调用都直接让测试失败。"""

    def run_main_in_backfill_mode(self, entries, env, run_backfill_error=None):
        calls = []
        seen = {}

        def writer(name):
            def explode(*_args, **_kwargs):
                calls.append(name)
                raise AssertionError(
                    f"回填模式调用了 {name}，会覆盖共享 state/feed/index"
                )

            return explode

        parsed = SimpleNamespace(feed=SimpleNamespace(title="Test Pod"))
        fake_candidates = [
            {"identity": "a", "title": "A", "audio_url": "u", "vtt_path": Path("x")}
        ]

        def fake_build_candidates(feed_entries, records):
            seen["entries"] = list(feed_entries)
            seen["records"] = records
            return list(fake_candidates)

        def fake_run_backfill(candidates, **kwargs):
            seen["candidates"] = candidates
            seen["kwargs"] = kwargs
            if run_backfill_error is not None:
                raise run_backfill_error
            return {"done": 1, "failed": 0, "skipped": 0, "quota": False}

        with patch.dict(os.environ, env, clear=True), patch.object(
            transcriber, "FEED_URL", "https://example.test/feed.xml"
        ), patch.object(
            transcriber, "PODCAST_SLUG", "pod"
        ), patch.object(
            transcriber, "GEMINI_KEYS", ["test-key"]
        ), patch.object(
            transcriber, "MAX_EPISODES", 1
        ), patch.object(
            transcriber, "ensure_directories", lambda: None
        ), patch.object(
            transcriber, "load_state", lambda: {"podcasts": {}}
        ), patch.object(
            transcriber, "get_feed_entries", lambda url: (parsed, entries)
        ), patch.object(
            transcriber, "build_backfill_candidates", fake_build_candidates
        ), patch.object(
            transcriber, "run_backfill", fake_run_backfill
        ), patch.object(
            transcriber, "save_state", writer("save_state")
        ), patch.object(
            transcriber, "make_enhanced_feed", writer("make_enhanced_feed")
        ), patch.object(
            transcriber, "build_podcast_index", writer("build_podcast_index")
        ), patch.object(
            transcriber, "rebuild_root_index", writer("rebuild_root_index")
        ):
            code = transcriber.main()
        return code, seen, calls

    def test_main_backfill_exits_zero_without_touching_writers(self):
        entries = [
            SimpleNamespace(
                id=f"guid-{i}",
                title=f"Ep {i}",
                enclosures=[{"href": f"https://example.test/{i}.mp3", "type": "audio/mpeg"}],
            )
            for i in range(3)
        ]

        code, seen, calls = self.run_main_in_backfill_mode(
            entries,
            {
                "BACKFILL_SHARD": "0",
                "BACKFILL_SHARDS": "2",
                "BACKFILL_MAX_MINUTES": "90",
            },
        )

        self.assertEqual(code, 0)
        self.assertEqual(calls, [], "回填模式不能调用 state/feed/index writer")
        self.assertEqual(
            seen["kwargs"], {"shard": 0, "shards": 2, "max_minutes": 90.0}
        )
        self.assertEqual(len(seen["candidates"]), 1)
        self.assertEqual(seen["candidates"][0]["identity"], "a")

    def test_main_backfill_passes_full_entry_list_past_max_episodes(self):
        # MAX_EPISODES=1 只该截断正常模式；回填必须看到全部条目，否则漏集。
        entries = [
            SimpleNamespace(
                id=f"guid-{i}",
                title=f"Ep {i}",
                enclosures=[{"href": f"https://example.test/{i}.mp3", "type": "audio/mpeg"}],
            )
            for i in range(3)
        ]

        _code, seen, _calls = self.run_main_in_backfill_mode(
            entries, {"BACKFILL_SHARD": "1", "BACKFILL_SHARDS": "4"}
        )

        self.assertEqual(len(seen["entries"]), 3)
        self.assertEqual(seen["entries"], entries)

    def test_main_backfill_returns_nonzero_when_every_key_is_rejected(self):
        # 死 key 不是配额暂停：分片必须红着退出，否则 20 个 job 全绿而一集没补。
        entries = [
            SimpleNamespace(
                id="guid-0",
                title="Ep 0",
                enclosures=[{"href": "https://example.test/0.mp3", "type": "audio/mpeg"}],
            )
        ]

        code, _seen, calls = self.run_main_in_backfill_mode(
            entries,
            {"BACKFILL_SHARD": "0", "BACKFILL_SHARDS": "1"},
            run_backfill_error=transcriber.GeminiAuthFailed("所有 key 都被拒绝"),
        )

        self.assertEqual(code, 1)
        self.assertEqual(calls, [], "鉴权失败也不能触发 state/feed/index writer")


if __name__ == "__main__":
    unittest.main()
