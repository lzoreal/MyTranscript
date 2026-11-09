import hashlib
import importlib.util
import json
import logging
import os
import sys
import tempfile
import time
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

# 别的测试文件可能已经装了更简的 google 桩（setdefault 不覆盖），
# 这里取回真正生效的模块再补属性，否则整包跑时翻译用例会缺 GenerateContentConfig。
google = sys.modules.setdefault("google", types.ModuleType("google"))
genai = sys.modules.setdefault("google.genai", types.ModuleType("google.genai"))
genai_types = sys.modules.setdefault(
    "google.genai.types", types.ModuleType("google.genai.types")
)
genai.Client = object
genai.types = genai_types
google.genai = genai
if not hasattr(genai_types, "GenerateContentConfig"):
    genai_types.GenerateContentConfig = lambda **kwargs: kwargs

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

    def test_add_transcript_tag_removes_stale_raw_json_link(self):
        old = f"{transcriber.word_transcript.RAW_BASE}/json/pod/Old.json"
        new = f"{transcriber.word_transcript.RAW_BASE}/json/pod/New.json"
        item = etree.fromstring(
            f"""
            <item xmlns:podcast="https://podcastindex.org/namespace/1.0">
              <podcast:transcript url="{old}" type="application/json"/>
              <podcast:transcript url="https://external.test/transcript.vtt"/>
            </item>
            """
        )
        transcriber.add_transcript_tag(item, new)

        urls = item.xpath("*[local-name()='transcript']/@url")
        self.assertEqual(urls, ["https://external.test/transcript.vtt", new])

    def test_remove_project_transcript_tags_removes_raw_json(self):
        raw = f"{transcriber.word_transcript.RAW_BASE}/json/pod/Ep.json"
        channel = etree.fromstring(
            f"""
            <channel xmlns:podcast="https://podcastindex.org/namespace/1.0">
              <item>
                <podcast:transcript url="{raw}" type="application/json"/>
                <podcast:transcript url="https://external.test/transcript.vtt"/>
              </item>
            </channel>
            """
        )
        removed = transcriber.remove_project_transcript_tags(channel)

        self.assertEqual(removed, 1)
        urls = channel.xpath("//*[local-name()='transcript']/@url")
        self.assertEqual(urls, ["https://external.test/transcript.vtt"])

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
    def setUp(self):
        # 冷却等待在真实环境是 90 秒；测试里归零，断言只看"等过"。
        self._cooldown = patch.object(transcriber, "GEMINI_QUOTA_COOLDOWN", 0.0)
        self._cooldown.start()
        self.addCleanup(self._cooldown.stop)

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
        with patch.object(transcriber, "wait_for_gemini_rate_limit"), patch.object(
            transcriber.time, "sleep"
        ):
            with self.assertRaises(transcriber.QuotaExhausted):
                transcriber.translate_blocks(ring, [(0, {"en": "Hello there friend"})], {})
        self.assertEqual(ring.cooldowns, transcriber.GEMINI_QUOTA_COOLDOWNS)

    def test_transient_429_on_every_key_cools_down_then_retries(self):
        # 线上事故：10 个 job 同时跑，4 把 key 在一分钟内全被 429 判死，
        # 整片直接暂停。限流会自己恢复，等一轮就该继续。
        calls = []

        class Client:
            def __init__(self, api_key):
                self.api_key = api_key

            @property
            def models(self):
                return self

            def generate_content(self, model, contents, config):
                calls.append(self.api_key)
                if len(calls) <= 2:
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
        self.assertEqual(translated, {0: "译0"})
        self.assertEqual(ring.cooldowns, 1)
        sleep.assert_called_once()
        self.assertEqual(calls, ["k1", "k2", "k1"])

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

    def test_quota_switches_model_before_giving_up(self):
        # 一个模型的日额度用完不等于本轮结束：请求要按轮换表打到下一个模型上，
        # 只有所有模型都耗尽才抛 QuotaExhausted 让分片暂停。
        calls = []

        class Client:
            def __init__(self, api_key):
                self.api_key = api_key

            @property
            def models(self):
                return self

            def generate_content(self, model=None, contents=None, config=None):
                calls.append((model, self.api_key))
                if model == "gemini-3.5-flash-lite":
                    raise _QuotaError("429 RESOURCE_EXHAUSTED")
                return SimpleNamespace(text=json.dumps({"0": "译0"}))

        ring = transcriber.GeminiKeyRing(
            ["k1"],
            factory=Client,
            models=["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"],
        )
        translated = {}
        with patch.object(transcriber, "wait_for_gemini_rate_limit"):
            transcriber.translate_blocks(
                ring, [(0, {"en": "Hello there friend"})], translated
            )
        self.assertEqual(translated, {0: "译0"})
        self.assertEqual(
            calls,
            [
                ("gemini-3.5-flash-lite", "k1"),
                ("gemini-3.1-flash-lite", "k1"),
            ],
        )

    def test_quota_error_asks_for_more_models_than_the_ring_would_reach(self):
        # 两个模型都耗尽才停：单模型时 2 把 key 只要 2 次请求，双模型要 4 次。
        seen = []

        class Client:
            @property
            def models(self):
                return self

            def generate_content(self, model=None, contents=None, config=None):
                seen.append(model)
                raise _QuotaError("429 RESOURCE_EXHAUSTED")

        ring = transcriber.GeminiKeyRing(
            ["k1", "k2"], factory=lambda api_key: Client(), models=["m-a", "m-b"]
        )
        with patch.object(transcriber, "wait_for_gemini_rate_limit"), patch.object(
            transcriber.time, "sleep"
        ):
            with self.assertRaises(transcriber.QuotaExhausted):
                transcriber.translate_blocks(
                    ring, [(0, {"en": "Hello there friend"})], {}
                )
        self.assertEqual(
            seen[:4], ["m-a", "m-a", "m-b", "m-b"], "耗尽顺序要先走完一个模型的所有 key"
        )
        self.assertEqual(set(seen), {"m-a", "m-b"})

    def test_health_records_the_model_that_just_failed(self):
        # 健康度按 (key, model) 判死：3.5 耗尽不该让 3.1 也跳过这把 key。
        with tempfile.TemporaryDirectory() as temp_dir:
            health = Path(temp_dir) / "shard-7.json"

            class Client:
                @property
                def models(self):
                    return self

                def generate_content(self, model=None, contents=None, config=None):
                    if model == "gemini-3.5-flash-lite":
                        raise _QuotaError("429 RESOURCE_EXHAUSTED")
                    return SimpleNamespace(text=json.dumps({"0": "译0"}))

            ring = transcriber.GeminiKeyRing(
                ["k1"],
                factory=lambda api_key: Client(),
                models=["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"],
            )
            with patch.object(
                transcriber, "wait_for_gemini_rate_limit"
            ), patch.dict(
                os.environ,
                {"GEMINI_HEALTH_DIR": temp_dir, "SHARD": "7"},
                clear=False,
            ):
                translated = {}
                transcriber.translate_blocks(
                    ring, [(0, {"en": "Hello there friend"})], translated
                )
            self.assertEqual(translated, {0: "译0"})
            entry = json.loads(health.read_text(encoding="utf-8"))
            self.assertEqual(len(entry), 1, "只记刚失败的那一把 key")
            recorded = next(iter(entry.values()))
            self.assertEqual(recorded["kind"], "quota")
            self.assertEqual(recorded["model"], "gemini-3.5-flash-lite")

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

        def make_ring(keys, factory=None, start=0, models=None, dead=None):
            # 只替换底层 client；轮换逻辑仍走真实的 GeminiKeyRing。
            return real_ring(["test-key"], factory=lambda api_key: fake, models=models, dead=dead)

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

    def test_domain_only_cue_is_copied_verbatim(self):
        # 真实事故：整集 2979 条字幕，卡在 "howwemadeyourmother.com" 这一条上，
        # 模型原样返回，被当成"疑似未翻译"重试到整集失败。
        cues = [
            {"start": 0.0, "end": 1.0, "en": "howwemadeyourmother.com"},
            {"start": 1.0, "end": 2.0, "en": "Yeah."},
        ]
        fake, _ = self.run_translation([], cues=cues)
        self.assertEqual(cues[0]["zh"], "howwemadeyourmother.com")
        self.assertEqual(fake.requests, [["0"]], "域名不该被送进模型")
        self.assertEqual(cues[1]["zh"], "译0::Yeah.")

    def test_multi_label_hostname_is_treated_as_untranslatable(self):
        # 真实事故（Hidden Brain "Unleashing Your Creativity"）：apple.co.hiddenbrain.
        # 末尾不是常见 TLD，靠老规则认不出来，模型原样返回后单条重试到整集失败。
        self.assertTrue(transcriber.is_untranslatable("apple.co.hiddenbrain."))
        self.assertTrue(transcriber.is_untranslatable("apple.co.hiddenbrain"))
        self.assertFalse(transcriber.is_untranslatable("U.S."))
        self.assertFalse(transcriber.is_untranslatable("Hello there."))

    def test_domain_with_a_few_words_is_copied_verbatim(self):
        # 真实事故（smartless 补译）：'Cost Plus Drugs.com,' 与 'hiddenbrain at npr.org'
        # 整条都是品牌/联系方式，模型只会原样返回，单条重试会拖垮整批。
        self.assertTrue(transcriber.is_untranslatable("Cost Plus Drugs.com,"))
        self.assertTrue(transcriber.is_untranslatable("hiddenbrain at npr.org"))
        self.assertFalse(transcriber.is_untranslatable("I bought it at the store."))

    def test_spelled_out_letters_are_treated_as_untranslatable(self):
        # 真实事故（99% Invisible 补译）：模型对拼读串只能原样返回，单条重试到整档失败。
        spelled = "E-S-L-C-A-V-A-D-A-O-6-E-G-N-U-5-F-Z-B-D-4-O-F-L-C-T-A-P-E-O-2-5-E-V-O-T-Z-2."
        self.assertTrue(transcriber.is_untranslatable(spelled))
        self.assertFalse(transcriber.is_untranslatable("state-of-the-art"))

    def test_persistent_single_cue_failure_keeps_the_source(self):
        # 翻不出来的单条保留英文，不影响整批——补译阶段会再试。
        _, result = self.run_translation([{"0"}] * 100, cues=[self.cues[0]])
        self.assertEqual(result[0]["zh"], "Yeah.")


class RetranslateEnglishZhTests(unittest.TestCase):
    """模型偶尔把英文原文当译文返回：要单独补译，且不能因此让整集失败。"""

    class Client:
        def __init__(self, echo, always=False):
            self.echo = echo
            self.always = always
            self.echoed = False
            self.requests = []
            self.models = SimpleNamespace(generate_content=self._generate)

        def _generate(self, model=None, contents=None, config=None):
            source = _decode_trailing_object(contents)
            self.requests.append(dict(source))
            result = {}
            for key, value in source.items():
                if value == self.echo and (self.always or not self.echoed):
                    result[key] = value          # 把英文原文当成译文
                    self.echoed = True
                else:
                    result[key] = f"译文{key}"
            return SimpleNamespace(text=json.dumps(result, ensure_ascii=False))

    def run_with(self, client, cues):
        real_ring = transcriber.GeminiKeyRing

        def make_ring(keys, factory=None, start=0, models=None, dead=None):
            return real_ring(["test-key"], factory=lambda api_key: client, models=models, dead=dead)

        with patch.object(transcriber, "GeminiKeyRing", make_ring), patch.object(
            transcriber, "wait_for_gemini_rate_limit", lambda: None
        ), patch.object(transcriber, "TRANSLATE_BASE_DELAY", 0.0), patch.object(
            transcriber, "TRANSLATE_BATCH_DELAY", 0.0
        ):
            return transcriber.translate_cues_with_gemini(cues)

    def test_needs_translation_flags_english_reply(self):
        self.assertTrue(transcriber.needs_translation({"en": "Hello there.", "zh": "Hello there."}))
        self.assertFalse(transcriber.needs_translation({"en": "Hello there.", "zh": "你好。"}))
        self.assertTrue(transcriber.needs_translation({"en": "Hello there."}))

    def test_link_copied_verbatim_is_not_retranslated(self):
        cue = {"en": "example.com", "zh": "example.com"}
        self.assertFalse(transcriber.needs_translation(cue))

    def test_single_token_entities_are_accepted_without_chinese(self):
        # 实测残留：拼读缩写、品牌、域名、编号，模型给不出中文，也没有中文可给。
        for en in ("Skype.", "O-A.", "Instagram.", "Creedthoughts.gov.", "B9.", "80%?"):
            self.assertFalse(transcriber.needs_translation({"en": en, "zh": en}),
                             en)

    def test_multi_word_english_reply_is_still_flagged(self):
        self.assertTrue(transcriber.needs_translation(
            {"en": "Let's go now.", "zh": "Let's go now."}))

    def test_english_reply_is_retranslated_alone(self):
        cues = [
            {"start": 0.0, "end": 1.0, "en": "First line."},
            {"start": 1.0, "end": 2.0, "en": "Second line."},
        ]
        client = self.Client(echo="Second line.")
        self.run_with(client, cues)
        self.assertIn("译文", cues[1]["zh"])
        self.assertEqual(len(client.requests), 2, "应只补发缺中文的那一条")
        self.assertEqual(list(client.requests[1].values()), ["Second line."])

    def test_persistent_english_reply_is_kept_not_fatal(self):
        cues = [{"start": 0.0, "end": 1.0, "en": "Stubborn line."}]
        client = self.Client(echo="Stubborn line.", always=True)
        with captured_messages(transcriber.log) as messages:
            self.run_with(client, cues)
        self.assertEqual(cues[0]["zh"], "Stubborn line.")
        self.assertTrue(any("不含中文" in m for m in messages), messages)


class FragmentMergeTests(unittest.TestCase):
    """Whisper 关闭上文后按 30 秒窗口切，边界常落在词组中间。"""

    def cue(self, en, start, end, words=()):
        return {"en": en, "start": start, "end": end,
                "words": [{"w": w, "s": s, "e": e} for w, s, e in words]}

    def test_unpunctuated_fragment_absorbs_lowercase_continuation(self):
        cues = [
            self.cue("Can we hit the gym a few", 0.0, 1.7,
                     [("Can", 0.0, 0.3), ("few", 1.4, 1.68)]),
            self.cue("times?", 1.7, 2.1, [("times?", 1.7, 2.1)]),
        ]
        merged = transcriber.merge_fragment_cues(cues)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["en"], "Can we hit the gym a few times?")
        self.assertEqual(merged[0]["end"], 2.1)
        self.assertEqual([w["w"] for w in merged[0]["words"]], ["Can", "few", "times?"])

    def test_finished_sentence_is_left_alone(self):
        cues = [self.cue("He stopped.", 0.0, 1.0), self.cue("we kept going.", 1.0, 2.0)]
        self.assertEqual(len(transcriber.merge_fragment_cues(cues)), 2)

    def test_uppercase_continuation_starts_a_new_sentence(self):
        # 前一句漏了句号，但下一句大写开头：大概率是新句子，不能粘。
        cues = [self.cue("And that's", 0.0, 1.0), self.cue("Sort of his plan.", 1.0, 2.0)]
        self.assertEqual(len(transcriber.merge_fragment_cues(cues)), 2)

    def test_merge_stops_at_the_length_limit(self):
        cues = [
            self.cue("x" * 100, 0.0, 1.0),
            self.cue("y" * 100, 1.0, 2.0),
        ]
        self.assertEqual(len(transcriber.merge_fragment_cues(cues, max_chars=150)), 2)

    def test_merge_stops_across_a_long_gap(self):
        cues = [self.cue("and then", 0.0, 1.0), self.cue("we left.", 40.0, 41.0)]
        self.assertEqual(len(transcriber.merge_fragment_cues(cues, max_span=20.0)), 2)

    def test_three_fragments_collapse_into_one_sentence(self):
        cues = [
            self.cue("he was", 0.0, 0.5),
            self.cue("trying to help, but they", 0.5, 1.5),
            self.cue("all focus on attributes.", 1.5, 2.5),
        ]
        merged = transcriber.merge_fragment_cues(cues)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["en"], "he was trying to help, but they all focus on attributes.")

    def test_capitalised_function_word_joins_when_there_is_no_pause(self):
        # whisper 经常把后半句首词大写；间隔很小 + 虚词开头，仍然是同一句。
        cues = [
            self.cue("he kept walking", 0.0, 1.0, [("he", 0.0, 0.2), ("walking", 0.8, 1.0)]),
            self.cue("And then he stopped.", 1.2, 2.4, [("And", 1.2, 1.3), ("stopped.", 2.0, 2.4)]),
        ]
        merged = transcriber.merge_fragment_cues(cues)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["en"], "he kept walking And then he stopped.")

    def test_capitalised_content_word_does_not_join(self):
        cues = [
            self.cue("he kept walking", 0.0, 1.0, [("walking", 0.8, 1.0)]),
            self.cue("Sort of his plan.", 1.2, 2.0, [("Sort", 1.2, 1.3)]),
        ]
        self.assertEqual(len(transcriber.merge_fragment_cues(cues)), 2)

    def test_long_pause_stops_merging_even_for_lowercase(self):
        cues = [self.cue("and then", 0.0, 1.0, [("then", 0.8, 1.0)]),
                self.cue("we left.", 2.2, 3.0, [("we", 2.2, 2.4)])]
        self.assertEqual(len(transcriber.merge_fragment_cues(cues)), 2)

    def test_tight_pause_still_merges_lowercase(self):
        cues = [self.cue("and then", 0.0, 1.0, [("then", 0.8, 1.0)]),
                self.cue("we left.", 1.2, 2.0, [("we", 1.2, 1.4)])]
        self.assertEqual(len(transcriber.merge_fragment_cues(cues)), 1)


class LongCueSplitTests(unittest.TestCase):
    """合并后偶尔会粘出 35 词以上的长句，在最大停顿处再切一刀。"""

    def cue(self, n_words, gap_at=None, gap=0.6):
        words, start = [], 0.0
        for i in range(n_words):
            s = start
            if gap_at is not None and i == gap_at:
                s += gap
            e = s + 0.3
            words.append({"w": f"w{i}", "s": round(s, 2), "e": round(e, 2)})
            start = e
        return {"en": " ".join(w["w"] for w in words), "start": 0.0,
                "end": words[-1]["e"], "words": words}

    def test_long_cue_is_split_at_the_pause(self):
        cues = [self.cue(40, gap_at=20)]
        parts = transcriber.split_long_cues(cues)
        self.assertEqual([len(p["words"]) for p in parts], [20, 20])
        self.assertEqual(parts[0]["end"], cues[0]["words"][19]["e"])
        self.assertEqual(parts[1]["start"], cues[0]["words"][20]["s"])

    def test_short_cue_is_left_alone(self):
        self.assertEqual(len(transcriber.split_long_cues([self.cue(20)])), 1)

    def test_no_pause_means_no_split(self):
        cues = [self.cue(40)]
        self.assertEqual(len(transcriber.split_long_cues(cues)), 1)

    def test_words_not_aligned_with_text_are_left_alone(self):
        cue = self.cue(40, gap_at=20)
        cue["en"] = "totally different text"
        self.assertEqual(len(transcriber.split_long_cues([cue])), 1)


class DeadBucketTests(unittest.TestCase):
    def test_health_records_map_back_to_keys_per_model(self):
        import key_health

        with tempfile.TemporaryDirectory() as temp_dir:
            key_health.record(Path(temp_dir) / "shard-90.json", "key-aaaa",
                              "quota", model="m1")
            dead = transcriber._dead_key_buckets(
                temp_dir, ["m1", "m2"], ["key-aaaa", "key-bbbb"])
        self.assertEqual(dead["m1"], {"key-aaaa"})
        self.assertEqual(dead["m2"], set())

    def test_ring_starts_on_a_live_bucket(self):
        ring = transcriber.GeminiKeyRing(
            ["key-aaaa", "key-bbbb"], models=["m1", "m2"],
            dead={"m1": {"key-aaaa"}, "m2": set()})
        self.assertEqual((ring.current_model(), ring.current()), ("m1", "key-bbbb"))


class BatchSizingTests(unittest.TestCase):
    """配额是每天请求数：单次装多少条，直接决定一天能出几集。"""

    def test_default_batch_fits_150_cues(self):
        cues = [{"start": i, "end": i + 1, "en": "Hi."} for i in range(400)]
        batches = transcriber.build_translation_batches(cues)
        self.assertEqual([len(batch) for batch in batches], [150, 150, 100])

    def test_character_cap_still_splits_long_blocks(self):
        cues = [{"start": i, "end": i + 1, "en": "x" * 700} for i in range(60)]
        batches = transcriber.build_translation_batches(cues)
        self.assertGreater(len(batches), 1, "16k 字符上限必须继续生效")
        for batch in batches:
            self.assertLessEqual(sum(len(cue["en"]) for cue in batch), 16000)

    def test_schema_covers_a_full_batch(self):
        # 结构化输出原来只覆盖 60 条以内，放大批次后大块批次会退化成只靠提示词。
        seen = {}

        class Client:
            def __init__(self):
                self.models = SimpleNamespace(generate_content=self._generate)

            def _generate(self, model=None, contents=None, config=None):
                seen["config"] = config
                source = _decode_trailing_object(contents)
                return SimpleNamespace(
                    text=json.dumps({key: "译" for key in source}, ensure_ascii=False)
                )

        blocks = [(index, {"en": f"line {index}"}) for index in range(120)]
        with patch.object(transcriber, "wait_for_gemini_rate_limit", lambda: None):
            transcriber.translate_batch_once(Client(), "m", blocks)
        schema = seen["config"].get("response_schema") or {}
        self.assertEqual(len(schema.get("properties") or {}), 120)


class SharedKeyHealthTests(unittest.TestCase):
    def test_other_shards_dead_keys_are_skipped_and_start_is_offset(self):
        # 10 个分片同时轮换会把同一把 key 打爆；跳过别人判死的 key，并从不同位置起跑。
        used = []

        class Client:
            def __init__(self, api_key):
                self.api_key = api_key

            @property
            def models(self):
                return self

            def generate_content(self, model=None, contents=None, config=None):
                used.append(self.api_key)
                source = _decode_trailing_object(contents)
                return SimpleNamespace(
                    text=json.dumps({k: "译" + k for k in source}, ensure_ascii=False)
                )

        real_ring = transcriber.GeminiKeyRing

        def make_ring(keys, factory=None, start=0, models=None, dead=None):
            return real_ring(
                keys, factory=lambda api_key: Client(api_key), start=start, models=models,
                dead=dead,
            )

        cues = [{"start": 0.0, "end": 1.0, "en": "Hello there friend"}]
        with patch.object(transcriber, "GEMINI_KEYS", ["k1", "k2", "k3"]), patch.object(
            transcriber, "GeminiKeyRing", make_ring
        ), patch.object(
            transcriber, "wait_for_gemini_rate_limit", lambda: None
        ), patch.dict(
            "os.environ",
            {
                "GEMINI_EXCLUDE_KEYS": transcriber.key_health.key_id("k1"),
                "GEMINI_KEY_OFFSET": "1",
            },
        ):
            transcriber.translate_cues_with_gemini(cues)
        self.assertEqual(used, ["k3"], "k1 被排除，起点偏移 2，只剩 k3")

    def test_every_key_excluded_pauses_instead_of_burning_requests(self):
        cues = [{"start": 0.0, "end": 1.0, "en": "Hello there friend"}]
        excluded = ",".join(transcriber.key_health.key_id(k) for k in ("k1", "k2"))
        with patch.object(transcriber, "GEMINI_KEYS", ["k1", "k2"]), patch.dict(
            "os.environ", {"GEMINI_EXCLUDE_KEYS": excluded}
        ):
            with self.assertRaises(transcriber.QuotaExhausted):
                transcriber.translate_cues_with_gemini(cues)

    def test_failed_key_is_recorded_for_the_other_shards(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            class Client:
                def __init__(self, api_key):
                    self.api_key = api_key

                @property
                def models(self):
                    return self

                def generate_content(self, model=None, contents=None, config=None):
                    if self.api_key == "k1":
                        raise _QuotaError("429 RESOURCE_EXHAUSTED")
                    source = _decode_trailing_object(contents)
                    return SimpleNamespace(
                        text=json.dumps({k: "译" + k for k in source}, ensure_ascii=False)
                    )

            with patch.object(
                transcriber, "wait_for_gemini_rate_limit", lambda: None
            ), patch.object(transcriber.time, "sleep"), patch.dict(
                "os.environ",
                {"GEMINI_HEALTH_DIR": temp_dir, "SHARD": "7", "GEMINI_EXCLUDE_KEYS": ""},
            ):
                ring = transcriber.GeminiKeyRing(
                    ["k1", "k2"], factory=lambda api_key: Client(api_key)
                )
                transcriber.translate_blocks(
                    ring, [(0, {"en": "Hello there friend"})], {}
                )
            dead = transcriber.key_health.dead_ids(Path(temp_dir), now=time.time())
            files = sorted(p.name for p in Path(temp_dir).glob("*.json"))
        self.assertEqual(dead, {transcriber.key_health.key_id("k1")})
        self.assertEqual(files, ["shard-7.json"], "每个分片只写自己的文件")


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


class ProxyPreferenceTests(unittest.TestCase):
    def test_preferred_proxy_comes_first_and_survives_shuffle(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            cache = Path(temp_dir) / "cache.json"
            cache.write_text(json.dumps({
                "created_at": time.time(),
                "proxies": ["a", "b", "c", "d"],
                "preferred": "c",
            }), encoding="utf-8")
            with patch.object(transcriber, "PROXY_CACHE_FILE", cache):
                for _ in range(5):
                    self.assertEqual(transcriber.load_proxy_cache()[0], "c")

    def test_promote_records_the_winner(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            cache = Path(temp_dir) / "cache.json"
            with patch.object(transcriber, "PROXY_CACHE_FILE", cache):
                transcriber.promote_proxy("http://win:1")
                data = json.loads(cache.read_text(encoding="utf-8"))
        self.assertEqual(data["preferred"], "http://win:1")
        self.assertIn("http://win:1", data["proxies"])


class DegenerateCueTests(unittest.TestCase):
    def test_word_level_flood_is_degenerate(self):
        cues = [{"words": [{"w": "and"}]} for _ in range(5000)]
        self.assertTrue(transcriber.degenerate_cues(cues, 5954.0))

    def test_normal_cues_are_not_flagged(self):
        cues = [{"words": [{"w": str(i)}] * 9} for i in range(1365)]
        self.assertFalse(transcriber.degenerate_cues(cues, 3561.0))

    def test_short_episode_with_few_cues_is_not_flagged(self):
        cues = [{"words": [{"w": "hi"}]} for _ in range(3)]
        self.assertFalse(transcriber.degenerate_cues(cues, 2.0))

    def test_retry_switches_context_off_when_output_is_fragmented(self):
        calls = []

        class Model:
            def transcribe(self, path, **kwargs):
                calls.append(kwargs["condition_on_previous_text"])

                class Word:
                    def __init__(self, w, s, e):
                        self.word, self.start, self.end = w, s, e

                class Seg:
                    def __init__(self, s, e, text, words):
                        self.start, self.end, self.text, self.words = s, e, text, words

                # 第一次：一词一条（碎片化）；第二次：正常句子。
                if kwargs["condition_on_previous_text"]:
                    segs = [Seg(i, i + 0.2, "and", [Word("and", i, i + 0.2)]) for i in range(200)]
                else:
                    segs = [Seg(i * 3, i * 3 + 2.8, "and then we talked about it.",
                                [Word(w, i * 3 + k * 0.5, i * 3 + k * 0.5 + 0.4)
                                 for k, w in enumerate("and then we talked about it".split())])
                            for i in range(10)]
                return segs, SimpleNamespace(duration=20.0, language="en")

        with patch.object(transcriber, "WhisperModel", lambda *a, **k: Model()), \
             patch.object(transcriber, "resegment_whisper_segments", lambda raw: raw):
            cues, _ = transcriber.whisper_transcribe(Path("x"))
        self.assertEqual(calls, [True, False])
        self.assertEqual(len(cues), 10)


class WordJsonSyncTests(unittest.TestCase):
    def test_export_and_switch_urls_only_for_episodes_with_data(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data_dir = root / "data"
            show = data_dir / "pod"
            show.mkdir(parents=True)
            document = {
                "guid": "g1",
                "audio_seconds": 2.0,
                "sentences": [{
                    "start": 0.0,
                    "end": 1.0,
                    "en": "Hi.",
                    "words": [{"w": "Hi.", "s": 0.0, "e": 1.0}],
                }],
            }
            (show / "g1.json").write_text(json.dumps(document), encoding="utf-8")
            records = {
                "g1": {"path": "pod/transcripts/Old.vtt", "url": "https://x/Old.vtt"},
                "g2": {"path": "pod/transcripts/Other.vtt", "url": "https://x/Other.vtt"},
            }
            json_dir = root / "json"
            written, switched = transcriber.sync_data_transcripts(
                records, data_dir=data_dir, json_dir=json_dir, slug="pod"
            )
            self.assertEqual((written, switched), (1, 1))
            out = json_dir / "pod" / "Old.json"
            self.assertTrue(out.exists())
            self.assertEqual(
                records["g1"]["url"],
                "https://raw.githubusercontent.com/lzoreal/MyTranscript/main"
                "/json/pod/Old.json",
            )
            self.assertEqual(records["g2"]["url"], "https://x/Other.vtt")


if __name__ == "__main__":
    unittest.main()
