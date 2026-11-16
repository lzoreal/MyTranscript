import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
import build_catalog  # noqa: E402

FEED = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:podcast="https://podcastindex.org/namespace/1.0">
  <channel>
    <title>Demo Show</title>
    <description>Demo description</description>
    <language>en-US</language>
    <itunes:image href="https://img.example/cover.jpg"/>
    <itunes:category text="News">
      <itunes:category text="Daily News"/>
    </itunes:category>
    <item>
      <title>Older episode</title>
      <pubDate>Mon, 10 Nov 2026 08:00:00 +0000</pubDate>
      <guid>old</guid>
      <enclosure url="https://cdn.example/old.mp3"/>
      <itunes:duration>10:00</itunes:duration>
    </item>
    <item>
      <title>Newer episode</title>
      <pubDate>Thu, 12 Nov 2026 08:00:00 +0000</pubDate>
      <guid>new</guid>
      <enclosure url="https://cdn.example/new.mp3"/>
      <itunes:duration>01:00:00</itunes:duration>
      <podcast:transcript
          url="https://raw.githubusercontent.com/lzoreal/MyTranscript/data/json/demo/new.json"
          type="application/json"/>
    </item>
  </channel>
</rss>
"""


class CatalogTests(unittest.TestCase):
    def test_catalog_shape_and_transcript(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            feed = Path(temp_dir) / "feed.xml"
            feed.write_text(FEED, encoding="utf-8")
            document = build_catalog.build_catalog([("99%-invisible", feed)])

        show = document["shows"][0]
        self.assertEqual(show["name"], "Demo Show")
        self.assertEqual(show["artwork"], "https://img.example/cover.jpg")
        self.assertEqual(show["feed"], "99%25-invisible/feed.xml")
        self.assertEqual(show["episode_count"], 2)
        self.assertEqual([e["id"] for e in show["latest"]], ["new", "old"])
        self.assertEqual(show["latest"][0]["transcript"]["type"], "application/json")
        self.assertEqual(show["latest"][0]["duration"], "01:00:00")
        self.assertIsNone(show["latest"][1]["transcript"])

    def test_catalog_reports_language_categories_and_coverage(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            feed = Path(temp_dir) / "feed.xml"
            feed.write_text(FEED, encoding="utf-8")
            document = build_catalog.build_catalog([("demo", feed)], latest=1)

        show = document["shows"][0]
        self.assertEqual(show["language"], "en-us")
        self.assertEqual(show["categories"], ["News", "Daily News"])
        # 总集数与真正带本站文字稿的集数分开统计。
        self.assertEqual(show["transcript_count"], 1)
        self.assertEqual(show["latest_transcript_count"], 1)
        self.assertEqual(show["latest_published_at"], "2026-11-12T08:00:00Z")

    def test_coverage_counts_all_items_not_only_latest(self):
        older_with_transcript = FEED.replace(
            '<guid>old</guid>',
            '<guid>old</guid>'
            '<podcast:transcript url="https://raw.githubusercontent.com/lzoreal/MyTranscript/data/json/demo/old.json"'
            ' type="application/json"/>',
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            feed = Path(temp_dir) / "feed.xml"
            feed.write_text(older_with_transcript, encoding="utf-8")
            document = build_catalog.build_catalog([("demo", feed)], latest=1)

        show = document["shows"][0]
        self.assertEqual(show["episode_count"], 2)
        self.assertEqual(show["transcript_count"], 2)
        self.assertEqual(show["latest_transcript_count"], 1)

    def test_latest_limit(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            feed = Path(temp_dir) / "feed.xml"
            feed.write_text(FEED, encoding="utf-8")
            document = build_catalog.build_catalog([("demo", feed)], latest=1)
        self.assertEqual(len(document["shows"][0]["latest"]), 1)

    def test_external_transcript_is_ignored(self):
        feed_text = FEED.replace(
            "https://raw.githubusercontent.com/lzoreal/MyTranscript/data/json/demo/new.json",
            "https://example.com/transcript.vtt",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            feed = Path(temp_dir) / "feed.xml"
            feed.write_text(feed_text, encoding="utf-8")
            document = build_catalog.build_catalog([("demo", feed)])
        self.assertIsNone(document["shows"][0]["latest"][0]["transcript"])

    def test_cli_does_not_rewrite_unchanged_catalog(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            site_dir = Path(temp_dir) / "site"
            show_dir = site_dir / "demo"
            show_dir.mkdir(parents=True)
            (show_dir / "feed.xml").write_text(FEED, encoding="utf-8")
            output = site_dir / "catalog.json"
            args = ["--site-dir", str(site_dir), "--output", str(output)]
            self.assertEqual(build_catalog.main(args), 0)
            first = output.read_text(encoding="utf-8")
            self.assertEqual(build_catalog.main(args), 0)
            self.assertEqual(output.read_text(encoding="utf-8"), first)


if __name__ == "__main__":
    unittest.main()
