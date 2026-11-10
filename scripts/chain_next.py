"""一轮结束后决定要不要立刻派下一轮。

只有"还有待办"并且"这一轮确实产出了新集"才链：配额打空的那一轮产出为 0，
再链只会空转，所以交给下一轮配额重置时人工/定时派发。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import pipeline_config as pconfig  # noqa: E402
import pipeline_store as pstore  # noqa: E402


def _parse_time(value):
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def pending_guids(episode_guids, done):
    return [guid for guid in episode_guids if guid not in done]


def count_newly_done(states, since):
    cutoff = _parse_time(since)
    if cutoff is None:
        return 0
    total = 0
    for state in states:
        for record in (state.get("episodes") or {}).values():
            if not isinstance(record, dict) or record.get("status") != "done":
                continue
            stamp = _parse_time(record.get("updated_at"))
            if stamp is not None and stamp >= cutoff:
                total += 1
    return total


def should_chain(pending: int, progressed: int) -> bool:
    return pending > 0 and progressed > 0


def dispatch_payload(slug, shards, max_minutes, gemini_model, translate_batch,
                     proxy_region=""):
    return {
        "ref": "main",
        "inputs": {
            "only_slug": slug,
            "shards": shards,
            "max_minutes": max_minutes,
            "gemini_model": gemini_model,
            "translate_batch": translate_batch,
            "proxy_region": proxy_region,
        },
    }


def _api(token, method, path, body=None):
    repo = os.environ.get("REPO", "")
    args = ["curl", "-sS", "-L", "--max-time", "60", "-X", method,
            "-H", "Authorization: Bearer " + token,
            "-H", "Accept: application/vnd.github+json",
            "-H", "Content-Type: application/json",
            f"https://api.github.com/repos/{repo}{path}"]
    if body is not None:
        args += ["-d", json.dumps(body)]
    result = subprocess.run(args, capture_output=True)
    text = result.stdout.decode("utf-8", "replace").strip()
    try:
        return json.loads(text) if text else {}
    except Exception:
        return {"raw": text[:200]}


def main() -> int:
    run_id = os.environ.get("RUN_ID", "").strip()
    token = os.environ.get("MY_PAT", "").strip()
    if not run_id or not token:
        print("没有 RUN_ID 或 token，跳过链式派发")
        return 0

    started = _api(token, "GET", f"/actions/runs/{run_id}").get("run_started_at", "")
    data_dir = Path(os.environ.get("DATA_DIR", "data"))
    only_slug = os.environ.get("ONLY_SLUG", "").strip()
    shows = pconfig.load_feeds(Path("feeds.json"))
    if only_slug:
        shows = [show for show in shows if show["slug"] == only_slug]
    else:
        shows = [show for show in shows if show.get("publish")]

    pending_total, states = 0, []
    for show in shows:
        done = pstore.done_guids(data_dir, show["slug"])
        episodes = pconfig.list_episodes(show["feed_url"])
        pending = pending_guids([episode["guid"] for episode in episodes], done)
        pending_total += len(pending)
        for path in sorted(pstore.show_dir(data_dir, show["slug"]).glob("state*.json")):
            try:
                states.append(json.loads(path.read_text(encoding="utf-8")))
            except Exception:
                continue
        print(f"{show['slug']}: 已完成 {len(done)}，待办 {len(pending)}")

    progressed = count_newly_done(states, started)
    print(f"本轮新完成 {progressed} 集（run 开始于 {started or '?'}）")
    if not should_chain(pending_total, progressed):
        print("不链式派发：" + ("没有待办了" if pending_total == 0 else "本轮没有新产出"))
        return 0

    payload = dispatch_payload(
        only_slug,
        os.environ.get("SHARDS", "20"),
        os.environ.get("MAX_MINUTES", "230"),
        os.environ.get("GEMINI_MODEL_INPUT", ""),
        os.environ.get("TRANSLATE_BATCH_INPUT", "150"),
        os.environ.get("PROXY_REGION_INPUT", ""),
    )
    got = _api(token, "POST", "/actions/workflows/transcripts.yml/dispatches", payload)
    print("已派发下一轮:", json.dumps(got, ensure_ascii=False)[:200] or "204 accepted")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
