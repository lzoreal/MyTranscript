import importlib.util
import json
import os
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "generate_zh_feed.py"
SPEC = importlib.util.spec_from_file_location("generate_zh_feed", MODULE_PATH)
feed_generator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(feed_generator)

PODCAST_NS = feed_generator.PODCAST_NS
ATOM_NS = feed_generator.ATOM_NS
ITUNES_NS = feed_generator.ITUNES_NS


class ZhFeedTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.old_cwd = os.getcwd()
        os.chdir(self.temp_dir.name)
        Path("site/pod").mkdir(parents=True)
        self.write_json("podcasts_translate.json", [{"slug": "pod"}])
        self.write_json(
            "translations.json",
            {"pod": {"Episode_One": {"translated": True}}},
        )

    def tearDown(self):
        os.chdir(self.old_cwd)
        self.temp_dir.cleanup()

    @staticmethod
    def write_json(path, data):
        Path(path).write_text(json.dumps(data), encoding="utf-8")

    def write_feed(self, items, channel_extras=None):
        rss = ET.Element("rss", {"version": "2.0"})
        channel = ET.SubElement(rss, "channel")
        ET.SubElement(channel, "title").text = "Test Podcast"
        ET.SubElement(channel, "description").text = "Original description"
        for extra in channel_extras or []:
            channel.append(extra)
        for item_data in items:
            item = ET.SubElement(channel, "item")
            ET.SubElement(item, "guid").text = item_data.get("guid", item_data["title"])
            ET.SubElement(item, "title").text = item_data["title"]
            for url in item_data.get("transcripts", []):
                node = ET.SubElement(item, f"{{{PODCAST_NS}}}transcript")
                node.set("url", url)
                node.set("type", "text/vtt")
                node.set("language", "en")
        ET.ElementTree(rss).write(
            "site/pod/feed.xml", encoding="utf-8", xml_declaration=True
        )

    def output_channel(self):
        root = ET.parse("site/pod/feed-zh.xml").getroot()
        return feed_generator.find_child(root, "channel")

    def test_build_public_feed_url_encodes_percent(self):
        self.assertEqual(
            feed_generator.build_public_feed_url(
                "https://example.test/MyTranscript", "99%-invisible"
            ),
            "https://example.test/MyTranscript/99%25-invisible/feed-zh.xml",
        )

    def test_episode_id_accepts_english_and_chinese_layouts(self):
        self.assertEqual(
            feed_generator.episode_id_from_transcript_url(
                "https://example.test/pod/transcripts/Episode_One.vtt"
            ),
            "Episode_One",
        )
        self.assertEqual(
            feed_generator.episode_id_from_transcript_url(
                "https://example.test/pod/transcripts/zh/Episode_One.vtt"
            ),
            "Episode_One",
        )
        self.assertEqual(
            feed_generator.episode_id_from_transcript_url(
                "https://example.test/pod/transcripts/zh/How%20We%20Met.vtt"
            ),
            "How We Met",
        )
        self.assertEqual(
            feed_generator.episode_id_from_transcript_url(
                "https://example.test/pod/transcripts/other/Episode_One.vtt"
            ),
            "",
        )

    def test_keeps_only_translated_episodes_and_rewrites_url(self):
        self.write_json(
            "translations.json",
            {
                "pod": {
                    "Episode_One": {"translated": True},
                    "Episode_Two": {"translated": False},
                }
            },
        )
        self.write_feed(
            [
                {
                    "title": "Episode One",
                    "transcripts": [
                        "https://example.test/pod/transcripts/Episode_One.vtt"
                    ],
                },
                {
                    "title": "Episode Two",
                    "transcripts": [
                        "https://example.test/pod/transcripts/Episode_Two.vtt"
                    ],
                },
            ]
        )

        kept, removed = feed_generator.process_podcast(
            "pod", "https://example.test/MyTranscript", {"pod": {"Episode_One": {"translated": True}, "Episode_Two": {"translated": False}}}
        )

        self.assertEqual((kept, removed), (1, 1))
        channel = self.output_channel()
        items = feed_generator.find_children(channel, "item")
        self.assertEqual(len(items), 1)
        transcript = feed_generator.find_child(items[0], "transcript")
        self.assertEqual(
            transcript.get("url"),
            "https://example.test/pod/transcripts/zh/Episode_One.vtt",
        )
        self.assertEqual(transcript.get("language"), "zh-CN")
        title = feed_generator.find_child(channel, "title")
        self.assertTrue(title.text.endswith(" 中文双语 Transcript Feed"))

    def test_already_chinese_url_is_preserved(self):
        self.write_feed(
            [
                {
                    "title": "Episode One",
                    "transcripts": [
                        "https://example.test/pod/transcripts/zh/Episode_One.vtt"
                    ],
                }
            ]
        )

        kept, removed = feed_generator.process_podcast(
            "pod",
            "https://example.test/MyTranscript",
            {"pod": {"Episode_One": {"translated": True}}},
        )

        self.assertEqual((kept, removed), (1, 0))
        channel = self.output_channel()
        transcript = feed_generator.find_child(
            feed_generator.find_child(channel, "item"), "transcript"
        )
        self.assertEqual(
            transcript.get("url"),
            "https://example.test/pod/transcripts/zh/Episode_One.vtt",
        )

    def test_removes_stale_english_transcript_tag(self):
        self.write_feed(
            [
                {
                    "title": "Episode One",
                    "transcripts": [
                        "https://example.test/pod/transcripts/Episode_One.vtt",
                        "https://example.test/pod/transcripts/zh/Episode_One.vtt",
                    ],
                }
            ]
        )

        feed_generator.process_podcast(
            "pod",
            "https://example.test/MyTranscript",
            {"pod": {"Episode_One": {"translated": True}}},
        )

        item = feed_generator.find_child(self.output_channel(), "item")
        transcripts = [
            node
            for node in list(item)
            if node.tag == f"{{{PODCAST_NS}}}transcript"
        ]
        self.assertEqual(len(transcripts), 1)
        self.assertIn("/transcripts/zh/", transcripts[0].get("url"))

    def test_missing_podcast_status_preserves_existing_feed(self):
        self.write_feed(
            [
                {
                    "title": "Episode One",
                    "transcripts": [
                        "https://example.test/pod/transcripts/Episode_One.vtt"
                    ],
                }
            ]
        )
        output = Path("site/pod/feed-zh.xml")
        output.write_text("sentinel", encoding="utf-8")

        kept, removed = feed_generator.process_podcast(
            "pod", "https://example.test/MyTranscript", {"other": {}}
        )

        self.assertEqual((kept, removed), (0, 0))
        self.assertEqual(output.read_text(encoding="utf-8"), "sentinel")

    def test_zero_matches_does_not_overwrite_existing_feed(self):
        self.write_feed(
            [
                {
                    "title": "Episode One",
                    "transcripts": [
                        "https://example.test/pod/transcripts/Episode_One.vtt"
                    ],
                }
            ]
        )
        output = Path("site/pod/feed-zh.xml")
        output.write_text("sentinel", encoding="utf-8")

        kept, removed = feed_generator.process_podcast(
            "pod", "https://example.test/MyTranscript", {"pod": {}}
        )

        self.assertEqual((kept, removed), (0, 1))
        self.assertEqual(output.read_text(encoding="utf-8"), "sentinel")

    def test_missing_translations_file_is_rejected(self):
        os.remove("translations.json")
        self.assertIsNone(feed_generator.load_status())

    def test_atom_self_and_new_feed_url_are_normalized(self):
        self_1 = ET.Element(
            f"{{{ATOM_NS}}}link",
            {"rel": "self", "href": "https://official.test/feed"},
        )
        self_2 = ET.Element(
            f"{{{ATOM_NS}}}link",
            {"rel": "self", "href": "https://example.test/old/feed.xml"},
        )
        new_feed = ET.Element(f"{{{ITUNES_NS}}}new-feed-url")
        new_feed.text = "https://official.test/feed"
        self.write_feed(
            [
                {
                    "title": "Episode One",
                    "transcripts": [
                        "https://example.test/pod/transcripts/Episode_One.vtt"
                    ],
                }
            ],
            channel_extras=[self_1, self_2, new_feed],
        )

        feed_generator.process_podcast(
            "pod",
            "https://example.test/MyTranscript",
            {"pod": {"Episode_One": {"translated": True}}},
        )

        channel = self.output_channel()
        self_links = [
            node
            for node in channel.iter()
            if node.tag == f"{{{ATOM_NS}}}link" and node.get("rel") == "self"
        ]
        self.assertEqual(len(self_links), 1)
        self.assertEqual(
            self_links[0].get("href"),
            "https://example.test/MyTranscript/pod/feed-zh.xml",
        )
        new_feed_nodes = [
            node
            for node in channel.iter()
            if node.tag == f"{{{ITUNES_NS}}}new-feed-url"
        ]
        self.assertEqual(len(new_feed_nodes), 1)
        self.assertEqual(
            new_feed_nodes[0].text,
            "https://example.test/MyTranscript/pod/feed-zh.xml",
        )

    def test_second_run_does_not_duplicate_title_suffix(self):
        self.write_feed(
            [
                {
                    "title": "Episode One",
                    "transcripts": [
                        "https://example.test/pod/transcripts/Episode_One.vtt"
                    ],
                }
            ]
        )
        status = {"pod": {"Episode_One": {"translated": True}}}

        feed_generator.process_podcast(
            "pod", "https://example.test/MyTranscript", status
        )
        first = Path("site/pod/feed-zh.xml").read_text(encoding="utf-8")
        feed_generator.process_podcast(
            "pod", "https://example.test/MyTranscript", status
        )
        second = Path("site/pod/feed-zh.xml").read_text(encoding="utf-8")

        channel = self.output_channel()
        title = feed_generator.find_child(channel, "title").text
        self.assertEqual(title.count(" 中文双语 Transcript Feed"), 1)
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
