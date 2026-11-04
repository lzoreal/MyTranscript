"""feeds.json 的读取、校验、分片与条目列举。"""

from __future__ import annotations

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


def select_shows(shows, only_slug=None):
    if only_slug:
        return [show for show in shows if show["slug"] == only_slug]
    return list(shows)


def shard_episodes(episodes, shard: int = 0, shards: int = 1, done=None):
    """按待办集平均分片：已完成的集先剔除，剩下的按 guid 排序后轮流分配。

    轮流分配让各片待办数差不超过 1；按 guid 排序保证同一份候选集每次切出
    相同结果，不受 RSS 条目顺序变化影响。
    """
    if shards <= 1:
        return list(episodes)
    pending = [episode for episode in episodes
               if not done or episode["guid"] not in done]
    pending.sort(key=lambda episode: episode["guid"])
    return [episode for index, episode in enumerate(pending) if index % shards == shard]


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
