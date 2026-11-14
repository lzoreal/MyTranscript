"""按待办集数决定分片数：20 集以内一片一集，超过 20 集才用满 20 片。

输出（stdout，供 GitHub Actions 写 $GITHUB_OUTPUT）：
    count=<分片数>
    pending=<待办集数>
    shards=[0,1,...]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pipeline_config as pconfig  # noqa: E402
import pipeline_store as pstore  # noqa: E402

# 账号级并发上限，矩阵再大也只会排队。
MAX_SHARDS = 20


def effective_shards(pending: int, cap: int = MAX_SHARDS) -> int:
    cap = int(cap or MAX_SHARDS)
    cap = max(1, min(cap, MAX_SHARDS))
    return max(1, min(cap, int(pending)))


def pending_by_show(shows, data_dir, list_episodes=None,
                    rss_cache=None) -> dict[str, list[dict]]:
    import requests

    list_episodes = list_episodes or pconfig.list_episodes
    pending = {}
    for show in shows:
        blocked = pstore.blocked_guids(Path(data_dir), show["slug"])
        feed_url = show["feed_url"]
        if rss_cache:
            data = requests.get(feed_url, timeout=60).content
            path = pconfig.rss_cache_path(rss_cache, feed_url)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            episodes = list_episodes(feed_url, fetch=lambda url, data=data: data)
        else:
            episodes = list_episodes(feed_url)
        pending[show["slug"]] = [
            episode for episode in episodes if episode["guid"] not in blocked
        ]
    return pending


def pending_total(shows, data_dir, list_episodes=None) -> int:
    return sum(len(episodes) for episodes in
               pending_by_show(shows, data_dir, list_episodes).values())


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--feeds", type=Path, default=Path("feeds.json"))
    parser.add_argument("--data-dir", type=Path, default=Path("data"))
    parser.add_argument("--only-slug", default="")
    parser.add_argument("--cap", type=int, default=MAX_SHARDS)
    parser.add_argument("--write-plans", action="store_true",
                        help="把每片的全局切片写进 data/.plans/<run_id>-<shard>.json")
    parser.add_argument("--run-id", default="")
    parser.add_argument("--rss-cache", default="",
                        help="把原始 RSS 存到这个目录，供 publish/chain_next 复用")
    args = parser.parse_args(argv)

    shows = pconfig.load_feeds(args.feeds)
    if args.only_slug:
        shows = [show for show in shows if show["slug"] == args.only_slug]
    pending_map = pending_by_show(shows, args.data_dir, rss_cache=args.rss_cache)
    pending = sum(len(episodes) for episodes in pending_map.values())
    count = effective_shards(pending, args.cap)
    if args.write_plans:
        run_id = args.run_id or os.environ.get("GITHUB_RUN_ID", "")
        if run_id:
            for shard in range(count):
                picked = pconfig.global_shard(pending_map, shard, count)
                pstore.save_shard_plan(
                    args.data_dir, run_id, shard,
                    {slug: [episode["guid"] for episode in episodes]
                     for slug, episodes in picked.items()},
                )
        else:
            print("没有 run_id，跳过写分片计划", file=sys.stderr)
    print(f"待办 {pending} 集，分片 {count}", file=sys.stderr)
    print(f"count={count}")
    print(f"pending={pending}")
    print(f"shards={json.dumps(list(range(count)))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
