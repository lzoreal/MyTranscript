import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

MODULE = Path(__file__).parents[1] / "scripts" / "ai_skip.py"
sys.path.insert(0, str(MODULE.parent))
SPEC = importlib.util.spec_from_file_location("ai_skip", MODULE)
skipmod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(skipmod)


def seg(i, start, end, text):
    return {"startTime": start, "endTime": end, "text": text}


class ChunkTests(unittest.TestCase):
    def test_chunks_cover_every_cue_once_and_respect_budget(self):
        segments = [seg(i, i * 10, i * 10 + 8, "word " * 8) for i in range(20)]
        chunks = skipmod.build_chunks(segments, max_chars=500)
        self.assertEqual(chunks[0]["start"], 0)
        self.assertEqual(chunks[-1]["end"], 19)
        for prev, cur in zip(chunks, chunks[1:]):
            self.assertEqual(prev["end"] + 1, cur["start"])
        for c in chunks[:-1]:
            self.assertLessEqual(len(c["text"]), 500)

    def test_clock_formats(self):
        self.assertEqual(skipmod.clock(95), "01:35")
        self.assertEqual(skipmod.clock(3700), "1:01:40")


class TagTests(unittest.TestCase):
    def test_collect_tags_drops_content_low_conf_and_bad_index(self):
        parts = [
            {"segments": [
                {"i": 1, "tag": "content", "conf": 0.9},
                {"i": 2, "tag": "ad", "conf": 0.4},
                {"i": 3, "tag": "ad", "conf": 0.8, "label": "赞助"},
                {"i": 99, "tag": "promo", "conf": 0.9},
                {"i": "x", "tag": "promo", "conf": 0.9},
            ]},
            {"segments": [{"i": 3, "tag": "promo", "conf": 0.9, "label": "更高"}]},
        ]
        tags = skipmod.collect_tags(parts, cue_count=10)
        self.assertNotIn(1, tags)
        self.assertNotIn(2, tags)
        self.assertNotIn(99, tags)
        self.assertEqual(tags[3]["tag"], "promo")
        self.assertEqual(tags[3]["label"], "更高")

    def test_label_saying_ad_overrides_filler_tag(self):
        parts = [{"segments": [{"i": 2, "tag": "filler", "conf": 0.9, "label": "插播广告"}]}]
        tags = skipmod.collect_tags(parts, cue_count=5)
        self.assertEqual(tags[2]["tag"], "ad")

    def test_heuristic_flags_ad_and_promo(self):
        segments = [
            seg(0, 0, 5, "This episode is sponsored by Acme."),
            seg(1, 5, 10, "Please subscribe and leave a review."),
            seg(2, 10, 15, "We talked about attention."),
        ]
        tags = skipmod.heuristic_tags(segments)
        self.assertEqual(tags[0]["tag"], "ad")
        self.assertEqual(tags[1]["tag"], "promo")
        self.assertNotIn(2, tags)


class RangeTests(unittest.TestCase):
    def test_derive_ranges_merges_contiguous_and_drops_short(self):
        segments = [
            seg(0, 100, 104, "ad a"),
            seg(1, 104, 108, "ad b"),
            seg(2, 108, 112, "ad c"),
            seg(3, 400, 401, "promo"),
            seg(4, 500, 520, "content"),
        ]
        tags = {
            0: {"tag": "ad", "conf": 0.9},
            1: {"tag": "ad", "conf": 0.8},
            2: {"tag": "ad", "conf": 0.7},
            3: {"tag": "promo", "conf": 0.9},
        }
        ranges = skipmod.derive_ranges(segments, tags)
        self.assertEqual(len(ranges), 1)
        self.assertEqual((ranges[0]["start"], ranges[0]["end"]), (100, 112))
        self.assertEqual(ranges[0]["conf"], 0.7)
        self.assertEqual(ranges[0]["id"], "ad:1000")

    def test_shell_ranges_pair_open_and_close(self):
        segments = [
            seg(0, 10, 12, "And now, a word from our sponsor."),
            seg(1, 60, 62, "Back to the show."),
            seg(2, 200, 202, "we'll be right back"),
            seg(3, 900, 902, "some content"),
        ]
        ranges = skipmod.shell_ranges(segments)
        self.assertEqual(len(ranges), 1)
        self.assertEqual((ranges[0]["start"], ranges[0]["end"]), (10, 62))
        self.assertEqual(ranges[0]["tag"], "ad")

    def test_shell_ranges_ignore_unpaired_or_too_far(self):
        segments = [
            seg(0, 10, 12, "And now, commercials."),
            seg(1, 500, 502, "End of commercials."),
            seg(2, 800, 802, "we'll be right back"),
        ]
        self.assertEqual(skipmod.shell_ranges(segments), [])

    def test_merge_ranges_joins_overlapping(self):
        ranges = [
            {"start": 10, "end": 40, "tag": "ad", "conf": 0.6, "id": "ad:100"},
            {"start": 38, "end": 70, "tag": "promo", "conf": 0.9, "id": "promo:380"},
            {"start": 200, "end": 210, "tag": "ad", "conf": 0.7, "id": "ad:2000"},
        ]
        merged = skipmod.merge_ranges(ranges)
        self.assertEqual(len(merged), 2)
        self.assertEqual((merged[0]["start"], merged[0]["end"]), (10, 70))
        self.assertEqual(merged[0]["tag"], "promo")
        self.assertEqual(merged[0]["conf"], 0.9)


    def test_merge_prefers_shell_over_higher_conf_model_range(self):
        ranges = [
            {"start": 10, "end": 20, "tag": "filler", "conf": 1.0, "id": "filler:100"},
            {"start": 10, "end": 21, "tag": "ad", "conf": 0.95, "id": "ad:100", "rule": "shell"},
        ]
        merged = skipmod.merge_ranges(ranges)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["tag"], "ad")
        self.assertEqual((merged[0]["start"], merged[0]["end"]), (10, 21))


class PayloadTests(unittest.TestCase):
    def test_payload_shape_and_stats(self):
        segments = [seg(i, i * 30, i * 30 + 25, "content line") for i in range(10)]
        segments[3] = seg(3, 90, 115, "this episode is sponsored by acme")
        segments.append(seg(10, 275, 300, "And now, commercials."))
        segments.append(seg(11, 320, 340, "End of commercials."))
        tags = skipmod.heuristic_tags(segments)
        payload = skipmod.make_payload(segments, tags, 340.0, "heuristic-v0")
        self.assertEqual(payload["version"], skipmod.VERSION)
        self.assertEqual(payload["prompt"], skipmod.PROMPT_ID)
        self.assertEqual(payload["cue_count"], 12)
        self.assertEqual(payload["stats"]["skippable_seconds"], 90.0)
        self.assertEqual(payload["stats"]["content_seconds"], 250.0)
        self.assertTrue(all(s["tag"] in ("ad", "promo", "filler") for s in payload["segments"]))
        self.assertTrue(all("id" in r for r in payload["ranges"]))

    def test_cli_writes_file_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            src = Path(temp_dir) / "ep.json"
            src.write_text(json.dumps({
                "audio_seconds": 120,
                "segments": [
                    seg(0, 0, 10, "this episode is sponsored by acme"),
                    seg(1, 10, 20, "content"),
                    seg(2, 20, 30, "please subscribe and leave a review"),
                ],
            }), encoding="utf-8")
            self.assertEqual(skipmod.main(["--transcript", str(src), "--heuristic"]), 0)
            dest = Path(temp_dir) / "ep.skip.json"
            self.assertTrue(dest.exists())
            first = dest.read_text(encoding="utf-8")
            self.assertEqual(skipmod.main(["--transcript", str(src), "--heuristic"]), 0)
            self.assertEqual(dest.read_text(encoding="utf-8"), first)


if __name__ == "__main__":
    unittest.main()
