"""CLI：按 feeds.json 分片跑，带预算与断点。"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pipeline_config as pconfig
import pipeline_episode as pepisode


def pipeline_env(env) -> dict:
    shards = int(env.get("SHARDS", "1") or 1)
    shard = int(env.get("SHARD", "0") or 0)
    if shards < 1 or not 0 <= shard < shards:
        raise ValueError(f"分片配置非法：shard={shard} shards={shards}")
    return {
        "shard": shard,
        "shards": shards,
        "max_minutes": float(env.get("MAX_MINUTES", "150") or 150),
        "only_slug": (env.get("ONLY_SLUG", "") or "").strip() or None,
        "data_dir": Path(env.get("DATA_DIR", "data") or "data"),
        "feeds_file": Path(env.get("FEEDS_FILE", "feeds.json") or "feeds.json"),
    }


def run(shows, *, deps_factory, data_dir, max_minutes, clock=None, process=None):
    process = process or pepisode.process_episode
    clock = clock or time.monotonic
    deadline = clock() + max_minutes * 60
    stats = {"done": 0, "skipped": 0, "failed": 0}
    for show in shows:
        deps = deps_factory(show)
        for episode in show["episodes"]:
            if clock() >= deadline:
                print("预算用完，剩余留给下一轮")
                return stats
            outcome = process(show, episode, deps, data_dir)
            stats[outcome] = stats.get(outcome, 0) + 1
    return stats


def build_default_deps(show):
    import pipeline_deps

    return pipeline_deps.build(show)


def main() -> int:
    env = pipeline_env(os.environ)
    shows = pconfig.select_shows(
        pconfig.load_feeds(env["feeds_file"]),
        only_slug=env["only_slug"],
        shard=env["shard"],
        shards=env["shards"],
    )
    prepared = [
        {"slug": show["slug"], "text_source": show["text_source"],
         "config": show, "episodes": pconfig.list_episodes(show["feed_url"])}
        for show in shows
    ]
    print(f"分片 {env['shard']}/{env['shards']}：节目 {len(prepared)}，"
          f"候选集 {sum(len(s['episodes']) for s in prepared)}")
    stats = run(prepared, deps_factory=build_default_deps, data_dir=env["data_dir"],
                max_minutes=env["max_minutes"])
    print(f"结束：{json.dumps(stats, ensure_ascii=False)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
