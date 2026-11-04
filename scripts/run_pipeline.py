"""CLI：按 feeds.json 分片跑，带预算与断点。"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import key_health as pkeyhealth
import gemini_keys as pkeys
import pipeline_config as pconfig
import pipeline_episode as pepisode
import pipeline_store as pstore


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
        # 分片计划只在同一次 run 内复用；本地手跑没有这个变量，行为不变。
        "run_id": (env.get("GITHUB_RUN_ID", "") or "").strip(),
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
    """把其它分片记下的不可用 key 转成本进程的排除表，并错开起始桶。"""
    os.environ["GEMINI_KEY_OFFSET"] = str(env["shard"])
    directory = os.getenv("GEMINI_HEALTH_DIR", "").strip()
    if not directory:
        return
    # 额度按 (key, model) 计：只在某个模型上耗尽的 key，换个模型还能用，
    # 所以只排除"轮换表上每个模型都判死"的那些。
    per_model = [
        pkeyhealth.dead_ids(Path(directory), model=model)
        for model in pkeys.gemini_models()
    ]
    dead = sorted(set.intersection(*per_model))
    os.environ["GEMINI_EXCLUDE_KEYS"] = ",".join(dead)
    if dead:
        print(f"跳过其它分片标记不可用的 key：{len(dead)} 把")


def prepare_shows(shows, shard: int, shards: int, list_episodes=None,
                  blocked_lookup=None, plan_lookup=None, claimed_lookup=None,
                  plan_save=None):
    """一个 run 内每片只切一次分片。

    每集 35~40 分钟且不可中断，本片的 state 要等这一集跑完才落盘；如果每个
    分块都按"当前待办集"重切，别的片手上正在跑的集会被当成新集抢过来，两片
    写同一个 data/<slug>/<guid>.json，提交时必然撞车。所以首切结果写进
    plan-<shard>.json，后续分块复用；首切时还要排除其它片已认领的集。
    """
    list_episodes = list_episodes or pconfig.list_episodes
    prepared = []
    for show in shows:
        episodes = list_episodes(show["feed_url"])
        blocked = blocked_lookup(show["slug"]) if blocked_lookup else set()
        planned = plan_lookup(show["slug"]) if plan_lookup else None
        if planned is not None:
            wanted = set(planned)
            picked = [episode for episode in episodes
                      if episode["guid"] in wanted and episode["guid"] not in blocked]
        else:
            claimed = claimed_lookup(show["slug"]) if claimed_lookup else set()
            picked = pconfig.shard_episodes(
                episodes, shard=shard, shards=shards, done=set(blocked) | set(claimed)
            )
            if plan_save:
                plan_save(show["slug"], [episode["guid"] for episode in picked])
        prepared.append(
            {
                **show,
                "episodes": picked,
                "state_suffix": "" if shards <= 1 else f"-{shard}",
            }
        )
    return prepared


def build_default_deps(show):
    import pipeline_deps

    return pipeline_deps.build(show)


def final_code(stats: dict, paused: bool = False) -> int:
    """分块循环的退出码：3 只表示"本片没有新活了"，skipped 不算活。"""
    if paused:
        return 2
    # 只剩 skipped 说明候选集已全部做完：必须收工，否则分块循环会空转烧预算。
    return 3 if not stats.get("done") and not stats.get("failed") else 0


def main() -> int:
    env = pipeline_env(os.environ)
    publish_key_health(env)
    shows = pconfig.select_shows(
        pconfig.load_feeds(env["feeds_file"]), only_slug=env["only_slug"]
    )
    # 单片没有争用，也不需要落 plan 文件。
    use_plan = env["shards"] > 1 and bool(env["run_id"])
    lookups = {}
    if use_plan:
        lookups = {
            "plan_lookup": lambda slug: pstore.read_plan(
                pstore.plan_path(env["data_dir"], slug, env["shard"]), env["run_id"]
            ),
            "claimed_lookup": lambda slug: pstore.claimed_guids(
                env["data_dir"], slug, env["run_id"], env["shard"]
            ),
            "plan_save": lambda slug, guids: pstore.save_plan(
                env["data_dir"], slug, env["shard"], env["run_id"], guids
            ),
        }
    prepared = prepare_shows(
        shows, shard=env["shard"], shards=env["shards"],
        blocked_lookup=lambda slug: pstore.blocked_guids(env["data_dir"], slug),
        **lookups,
    )
    print(f"分片 {env['shard']}/{env['shards']}：节目 {len(prepared)}，"
          f"候选集 {sum(len(s['episodes']) for s in prepared)}")
    stats = run(prepared, deps_factory=build_default_deps, data_dir=env["data_dir"],
                max_minutes=env["max_minutes"],
                reserve_minutes=env["reserve_minutes"])
    paused = stats.pop("paused", False)
    print(f"结束：{json.dumps(stats, ensure_ascii=False)}")
    return final_code(stats, paused)


if __name__ == "__main__":
    raise SystemExit(main())
