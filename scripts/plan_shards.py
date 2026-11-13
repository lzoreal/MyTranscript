"""按待办集数决定分片数：20 集以内一片一集，超过 20 集才用满 20 片。

输出（stdout，供 GitHub Actions 写 $GITHUB_OUTPUT）：
    count=<分片数>
    pending=<待办集数>
    shards=[0,1,...]
"""

from __future__ import annotations

import argparse
import json
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


def pending_total(shows, data_dir, list_episodes=None) -> int:
    list_episodes = list_episodes or pconfig.list_episodes
    total = 0
    for show in shows:
        blocked = pstore.blocked_guids(Path(data_dir), show["slug"])
        total += sum(
            1 for episode in list_episodes(show["feed_url"])
            if episode["guid"] not in blocked
        )
    return total


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--feeds", type=Path, default=Path("feeds.json"))
    parser.add_argument("--data-dir", type=Path, default=Path("data"))
    parser.add_argument("--only-slug", default="")
    parser.add_argument("--cap", type=int, default=MAX_SHARDS)
    args = parser.parse_args(argv)

    shows = pconfig.load_feeds(args.feeds)
    if args.only_slug:
        shows = [show for show in shows if show["slug"] == args.only_slug]
    pending = pending_total(shows, args.data_dir)
    count = effective_shards(pending, args.cap)
    print(f"待办 {pending} 集，分片 {count}", file=sys.stderr)
    print(f"count={count}")
    print(f"pending={pending}")
    print(f"shards={json.dumps(list(range(count)))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
