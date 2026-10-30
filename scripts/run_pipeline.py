"""CLI：按 feeds.json 分片跑，带预算与断点。"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import key_health as pkeyhealth
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
        "reserve_minutes": float(env.get("RESERVE_MINUTES", "0") or 0),
        "only_slug": (env.get("ONLY_SLUG", "") or "").strip() or None,
        "data_dir": Path(env.get("DATA_DIR", "data") or "data"),
        "feeds_file": Path(env.get("FEEDS_FILE", "feeds.json") or "feeds.json"),
    }


def run(shows, *, deps_factory, data_dir, max_minutes, reserve_minutes=0,
        clock=None, process=None):
    process = process or pepisode.process_episode
    clock = clock or time.monotonic
    deadline = clock() + max_minutes * 60
    stats = {"done": 0, "skipped": 0, "failed": 0}
    for show in shows:
        deps = deps_factory(show)
        for episode in show["episodes"]:
            # 单集耗时不可中断，留不够一集就别开新的，否则这一块会越过截止线。
            if clock() + reserve_minutes * 60 >= deadline:
                print("剩余时间不足一集，先提交这一块")
                return stats
            try:
                outcome = process(show, episode, deps, data_dir)
            except pepisode.QuotaExhausted as exc:
                print(f"Gemini 配额用尽，本轮停在这里：{exc}")
                stats["paused"] = True
                return stats
            stats[outcome] = stats.get(outcome, 0) + 1
    return stats


def publish_key_health(env) -> None:
    """把其它分片记下的不可用 key 转成本进程的排除表，并错开起始 key。"""
    os.environ["GEMINI_KEY_OFFSET"] = str(env["shard"])
    directory = os.getenv("GEMINI_HEALTH_DIR", "").strip()
    if not directory:
        return
    dead = sorted(pkeyhealth.dead_ids(Path(directory)))
    os.environ["GEMINI_EXCLUDE_KEYS"] = ",".join(dead)
    if dead:
        print(f"跳过其它分片标记不可用的 key：{len(dead)} 把")


def prepare_shows(shows, shard: int, shards: int, list_episodes=None):
    list_episodes = list_episodes or pconfig.list_episodes
    prepared = []
    for show in shows:
        episodes = list_episodes(show["feed_url"])
        prepared.append(
            {
                **show,
                "episodes": pconfig.shard_episodes(episodes, shard=shard, shards=shards),
                "state_suffix": "" if shards <= 1 else f"-{shard}",
            }
        )
    return prepared


def build_default_deps(show):
    import pipeline_deps

    return pipeline_deps.build(show)


def main() -> int:
    env = pipeline_env(os.environ)
    publish_key_health(env)
    shows = pconfig.select_shows(
        pconfig.load_feeds(env["feeds_file"]), only_slug=env["only_slug"]
    )
    prepared = prepare_shows(
        shows, shard=env["shard"], shards=env["shards"]
    )
    print(f"分片 {env['shard']}/{env['shards']}：节目 {len(prepared)}，"
          f"候选集 {sum(len(s['episodes']) for s in prepared)}")
    stats = run(prepared, deps_factory=build_default_deps, data_dir=env["data_dir"],
                max_minutes=env["max_minutes"],
                reserve_minutes=env["reserve_minutes"])
    paused = stats.pop("paused", False)
    print(f"结束：{json.dumps(stats, ensure_ascii=False)}")
    if paused:
        return 2
    # 3 = 本片没有可处理的集数：分块循环据此收工，不再空转。
    return 3 if not any(stats.values()) else 0


if __name__ == "__main__":
    raise SystemExit(main())
