#!/usr/bin/env python3
"""cue 级跳过标签离线生成：<stem>.skip.json

设计见 docs/superpowers/specs/2026-11-19-cue-level-smart-skip-design.md。

用法：
    python scripts/ai_skip.py --transcript build/skip-sample/a.json --dry-run
    python scripts/ai_skip.py --transcript build/skip-sample/a.json --heuristic
    GEMINI_API_KEYS=... python scripts/ai_skip.py --transcript build/skip-sample/a.json

产物与 transcript 同目录同名 + .skip.json；--out 可改目录。--dry-run 只打印切块与请求数。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gemini_keys  # noqa: E402

VERSION = 1
PROMPT_ID = "skip-v1"
MIN_CONF = 0.55
DEFAULT_CHUNK_CHARS = 16000
MERGE_GAP_SECONDS = 8.0
MIN_RANGE_SECONDS = 6.0

TAGS = ("ad", "promo", "filler", "content")

SYSTEM_PROMPT = (
    "You label lines of a podcast transcript for a skip feature. Each input line is "
    "'<index> [mm:ss] <text>'. Return ONLY a JSON object: "
    '{"segments":[{"i":<index int>,"tag":"ad|promo|filler","conf":<0-1>,"label":"<short Chinese label>"}]}. '
    "Rules: "
    "ad = a paid advertisement, sponsor read, ad break, promo/discount code for a paid partner. "
    "promo = the hosts promoting themselves or the show: subscribe, rate/review, Patreon, merch, tour, "
    "newsletter, cross-promoting another show. "
    "filler = pure small talk, jokes, greetings, tangents with no informational content, "
    "or housekeeping about recording/production. "
    "Everything else is content and MUST be omitted from the output. "
    "Be conservative: ordinary mentions of brands, books, products or people inside a normal "
    "conversation are content, not ad/promo. Only label a line when it is clearly part of a "
    "sponsor read, a self-promotion segment, or genuinely empty chatter. "
    "Prefer whole contiguous blocks: if a sponsor read spans 20 lines, label all 20. "
    "conf must reflect how sure you are (0-1). label must be short Chinese. "
    "Never invent indices; only use indices present in the input."
)

AD_RE = re.compile(
    r"(sponsored by|this episode is sponsored|ad break|promo code|use code|discount code|"
    r"广告|赞助|优惠码|折扣码|sponsor)", re.I
)
PROMO_RE = re.compile(
    r"(subscribe|rate us|rate the show|leave a review|review us|patreon|merch|merchandise|"
    r"our tour|tickets|newsletter|follow us|follow the show|cross[- ]?promo|"
    r"订阅|打分|评分|留下评论|打赏|周边|巡演|购票|关注我们|邮件列表)", re.I
)
# 广告壳：动态插播的广告在转写里没有文字，但主持人会念一句进出场，配对后按时间跳。
SHELL_OPEN = re.compile(
    r"(and now,? ?(a word from our sponsor|our sponsor|commercials?|a break)|"
    r"we(?:'ll| will) be right back|after the break|广告之后|稍后回来|一段广告)", re.I
)
SHELL_CLOSE = re.compile(
    r"(end of commercials?|back to the show|back to the podcast|and we'?re back|"
    r"回到节目|广告结束|欢迎回来)", re.I
)
# 标签与 label 自相矛盾时以 label 为准：「插播广告」被标成 filler 会让级别 1 漏跳。
AD_LABEL = re.compile(r"(广告|赞助|commercial|sponsor)", re.I)


# ---------------------------------------------------------------- 读取与切块
def fetch(url: str) -> str:
    import requests

    resp = requests.get(url, timeout=60)
    resp.raise_for_status()
    return resp.text


def load_transcript(src: str) -> dict:
    if src.startswith(("http://", "https://")):
        return json.loads(fetch(src))
    return json.loads(Path(src).read_text(encoding="utf-8"))


def cue_english(seg: dict) -> str:
    text = str(seg.get("text") or seg.get("body") or "")
    return text.split("\n")[0].strip()


def clock(seconds: float) -> str:
    total = max(0, int(seconds))
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def build_chunks(segments: list[dict], max_chars: int = DEFAULT_CHUNK_CHARS) -> list[dict]:
    chunks: list[dict] = []
    lines: list[str] = []
    start_i = 0
    used = 0
    for i, seg in enumerate(segments):
        text = cue_english(seg) or "(silence)"
        line = f"{i} [{clock(float(seg.get('startTime') or 0))}] {text}"
        if lines and used + len(line) + 1 > max_chars:
            chunks.append({"start": start_i, "end": i - 1, "text": "\n".join(lines)})
            lines, used, start_i = [], 0, i
        lines.append(line)
        used += len(line) + 1
    if lines:
        chunks.append({"start": start_i, "end": len(segments) - 1, "text": "\n".join(lines)})
    return chunks


# ---------------------------------------------------------------- 模型
def parse_json_object(text: str) -> dict:
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        first, last = text.find("{"), text.rfind("}")
        if first >= 0 and last > first:
            return json.loads(text[first : last + 1])
        raise


def call_chunk(ring, chunk: dict, index: int, total: int, retries: int = 3) -> dict:
    from google.genai import types

    body = f"Lines {chunk['start']}-{chunk['end']}:\n{chunk['text']}"
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            model = ring.current_model() or os.getenv("GEMINI_MODEL", gemini_keys.DEFAULT_MODEL)
            resp = ring.client().models.generate_content(
                model=model,
                contents=body,
                config=types.GenerateContentConfig(
                    system_instruction=SYSTEM_PROMPT,
                    response_mime_type="application/json",
                    temperature=0.2,
                ),
            )
            ring.requests += 1
            return parse_json_object(resp.text or "")
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if gemini_keys.is_quota_error(exc):
                if not ring.mark_exhausted():
                    raise gemini_keys.QuotaExhausted("所有 (key, model) 配额都用完了") from exc
                continue
            wait = 5 * (attempt + 1)
            print(f"  ! 块 {index + 1} 失败（{exc}），{wait}s 后重试", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"块 {index + 1} 连续失败：{last_error}")


def normalize_tag(tag: str, label: str) -> str:
    """label 说「广告」但 tag 是 filler 时以 label 为准，否则级别 1 会漏跳。"""
    if label and AD_LABEL.search(label):
        return "ad"
    return tag


def collect_tags(parts: list[dict], cue_count: int) -> dict[int, dict]:
    seen: dict[int, dict] = {}
    for part in parts:
        for raw in part.get("segments") or []:
            if not isinstance(raw, dict):
                continue
            try:
                i = int(raw.get("i"))
            except (TypeError, ValueError):
                continue
            if i < 0 or i >= cue_count:
                continue
            tag = str(raw.get("tag") or "").strip().lower()
            if tag not in TAGS or tag == "content":
                continue
            try:
                conf = float(raw.get("conf"))
            except (TypeError, ValueError):
                conf = 0.0
            if conf < MIN_CONF:
                continue
            label = str(raw.get("label") or "").strip()[:40]
            if label and AD_LABEL.search(label):
                tag = normalize_tag(tag, label)
            item = {"tag": tag, "conf": round(min(1.0, max(0.0, conf)), 2)}
            if label:
                item["label"] = label
            old = seen.get(i)
            if old is None or item["conf"] > old["conf"]:
                seen[i] = item
    return seen


# ---------------------------------------------------------------- 基线（不调模型）
def heuristic_tags(segments: list[dict]) -> dict[int, dict]:
    tags: dict[int, dict] = {}
    for i, seg in enumerate(segments):
        text = str(seg.get("text") or seg.get("body") or "")
        if AD_RE.search(text):
            tags[i] = {"tag": "ad", "conf": 0.6, "label": "关键词命中"}
        elif PROMO_RE.search(text):
            tags[i] = {"tag": "promo", "conf": 0.6, "label": "关键词命中"}
    return tags


# ---------------------------------------------------------------- 派生
def shell_ranges(segments: list[dict]) -> list[dict]:
    """广告壳配对：开场句 → 最近的收尾句，中间即使没有文字也按时间整段跳过。"""
    out: list[dict] = []
    for i, seg in enumerate(segments):
        if not SHELL_OPEN.search(str(seg.get("text") or seg.get("body") or "")):
            continue
        start = float(seg.get("startTime") or 0)
        for j in range(i + 1, len(segments)):
            nxt = segments[j]
            at = float(nxt.get("startTime") or 0)
            if at - start > 300:
                break
            if not SHELL_CLOSE.search(str(nxt.get("text") or nxt.get("body") or "")):
                continue
            end = float(nxt.get("endTime") or at)
            if end > start:
                out.append({
                    "start": round(start, 1),
                    "end": round(end, 1),
                    "tag": "ad",
                    "conf": 0.95,
                    "label": "广告壳",
                    "id": f"ad:{int(round(start * 10))}",
                    "rule": "shell",
                })
            break
    return out


def merge_ranges(ranges: list[dict]) -> list[dict]:
    out: list[dict] = []
    for r in sorted(ranges, key=lambda x: x["start"]):
        last = out[-1] if out else None
        if last and r["start"] <= last["end"] + 1:
            last["end"] = max(last["end"], r["end"])
            # 广告壳优先级最高：模型把「We'll be right back」标成 filler 时不能把 ad 降级。
            if r.get("rule") == "shell" and last.get("rule") != "shell":
                last.update({k: r[k] for k in ("tag", "conf", "label", "id", "rule") if k in r})
            elif last.get("rule") != "shell" and r["conf"] > last["conf"]:
                last.update({k: r[k] for k in ("tag", "conf", "label", "id") if k in r})
            continue
        out.append(dict(r))
    return out


def derive_ranges(segments: list[dict], tags: dict[int, dict]) -> list[dict]:
    ranges: list[dict] = []
    group: list[int] = []

    def flush() -> None:
        if not group:
            return
        first, last = segments[group[0]], segments[group[-1]]
        start = float(first.get("startTime") or 0)
        end = float(last.get("endTime") or start)
        tag = tags[group[0]]["tag"]
        conf = min(tags[i]["conf"] for i in group)
        if end - start >= MIN_RANGE_SECONDS:
            label = next((tags[i].get("label") for i in group if tags[i].get("label")), "")
            item = {
                "start": round(start, 1),
                "end": round(end, 1),
                "tag": tag,
                "conf": round(conf, 2),
                "id": f"{tag}:{int(round(start * 10))}",
            }
            if label:
                item["label"] = label
            ranges.append(item)

    for i in sorted(tags):
        if group and tags[i]["tag"] == tags[group[-1]]["tag"]:
            gap = float(segments[i].get("startTime") or 0) - float(segments[group[-1]].get("endTime") or 0)
            if gap <= MERGE_GAP_SECONDS:
                group.append(i)
                continue
            flush()
            group = [i]
        else:
            flush()
            group = [i]
    flush()
    ranges.sort(key=lambda r: r["start"])
    return ranges


def make_payload(segments: list[dict], tags: dict[int, dict], audio_seconds: float, model: str) -> dict:
    ranges = merge_ranges(derive_ranges(segments, tags) + shell_ranges(segments))
    skippable = sum(r["end"] - r["start"] for r in ranges)
    payload = {
        "version": VERSION,
        "prompt": PROMPT_ID,
        "model": model,
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "audio_seconds": round(audio_seconds, 2),
        "cue_count": len(segments),
        "segments": [
            dict({"i": i, "start": round(float(segments[i].get("startTime") or 0), 1)}, **tags[i])
            for i in sorted(tags)
        ],
        "ranges": ranges,
        "stats": {
            "content_seconds": round(max(0.0, audio_seconds - skippable), 1),
            "skippable_seconds": round(skippable, 1),
        },
    }
    return payload


def write_payload(dest: Path, payload: dict) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(dest)


def summarize(payload: dict, name: str) -> None:
    counts: dict[str, int] = {}
    for seg in payload["segments"]:
        counts[seg["tag"]] = counts.get(seg["tag"], 0) + 1
    dur = payload["audio_seconds"]
    skip = payload["stats"]["skippable_seconds"]
    pct = (skip / dur * 100) if dur else 0
    print(f"\n== {name} ==")
    print(f"  cue {payload['cue_count']} / 标签 {len(payload['segments'])} 句 {counts}")
    print(f"  区间 {len(payload['ranges'])} 段 / 可跳 {clock(skip)}（{pct:.1f}%）")
    for r in payload["ranges"][:8]:
        print(f"    {clock(r['start'])}-{clock(r['end'])} {r['tag']} {r.get('label', '')} conf={r['conf']}")


# ---------------------------------------------------------------- 主流程
def target_path(src: str, out_dir: str | None) -> Path:
    if src.startswith(("http://", "https://")):
        name = src.rsplit("/", 1)[-1]
        stem = re.sub(r"\.json$", "", name)
        base = Path(out_dir or "build/skip-sample")
    else:
        path = Path(src)
        stem = path.stem
        base = Path(out_dir) if out_dir else path.parent
    return base / f"{stem}.skip.json"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="生成 cue 级跳过标签 <stem>.skip.json")
    ap.add_argument("--transcript", action="append", required=True, help="transcript JSON 路径或 URL，可多次")
    ap.add_argument("--out", help="产物目录；默认与 transcript 同目录")
    ap.add_argument("--dry-run", action="store_true", help="只打印切块与请求数，不写文件")
    ap.add_argument("--heuristic", action="store_true", help="不调模型，只用关键词基线")
    ap.add_argument("--repost", action="store_true", help="不调模型，按已有 skip.json 的标签重算区间（规则修正后使用）")
    ap.add_argument("--force", action="store_true", help="忽略已有产物重新生成")
    ap.add_argument("--max-chars", type=int, default=DEFAULT_CHUNK_CHARS)
    args = ap.parse_args(argv)

    ok = 0
    for src in args.transcript:
        name = src.rsplit("/", 1)[-1]
        dest = target_path(src, args.out)
        if dest.exists() and not args.force and not args.repost:
            try:
                old = json.loads(dest.read_text(encoding="utf-8"))
                if old.get("version") == VERSION and old.get("prompt") == PROMPT_ID:
                    print(f"跳过（已有产物）：{dest}")
                    ok += 1
                    continue
            except Exception:
                pass
        data = load_transcript(src)
        segments = data.get("segments") or []
        if not segments:
            print(f"! {name} 没有 segments，跳过", file=sys.stderr)
            continue
        audio = float(data.get("audio_seconds") or segments[-1].get("endTime") or 0)
        chunks = build_chunks(segments, args.max_chars)
        print(f"\n{name}: {len(segments)} 句 → {len(chunks)} 块（上限 {args.max_chars} 字符）")

        if args.dry_run:
            for c in chunks:
                print(f"  块 {c['start']}-{c['end']}，{len(c['text'])} 字符")
            ok += 1
            continue

        if args.repost:
            if not dest.exists():
                print(f"! {dest} 不存在，无法 repost", file=sys.stderr)
                continue
            old = json.loads(dest.read_text(encoding="utf-8"))
            tags: dict[int, dict] = {}
            for raw in old.get("segments") or []:
                try:
                    i = int(raw.get("i"))
                except (TypeError, ValueError):
                    continue
                tag = str(raw.get("tag") or "")
                if tag not in TAGS or tag == "content":
                    continue
                label = str(raw.get("label") or "")[:40]
                tags[i] = {
                    "tag": normalize_tag(tag, label),
                    "conf": round(float(raw.get("conf") or 0), 2),
                    **({"label": label} if label else {}),
                }
            payload = make_payload(segments, tags, audio, old.get("model") or "repost")
            write_payload(dest, payload)
            print(f"重算 {dest}")
            summarize(payload, name)
            ok += 1
            continue

        if args.heuristic:
            tags = heuristic_tags(segments)
            payload = make_payload(segments, tags, audio, "heuristic-v0")
        else:
            keys = gemini_keys.parse_gemini_keys(
                os.getenv("GEMINI_API_KEYS", "") or os.getenv("GEMINI_API_KEY", "")
            )
            if not keys:
                print("! 没有 GEMINI_API_KEYS / GEMINI_API_KEY，无法调模型", file=sys.stderr)
                return 2
            ring = gemini_keys.GeminiKeyRing(keys, models=gemini_keys.gemini_models())
            print(f"  密钥 {ring.label()}，模型 {ring.current_model()}")
            parts = []
            for idx, chunk in enumerate(chunks):
                parts.append(call_chunk(ring, chunk, idx, len(chunks)))
                print(f"  块 {idx + 1}/{len(chunks)} ok")
            tags = collect_tags(parts, len(segments))
            payload = make_payload(segments, tags, audio, ring.current_model() or "")

        write_payload(dest, payload)
        print(f"写入 {dest}")
        summarize(payload, name)
        ok += 1
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
