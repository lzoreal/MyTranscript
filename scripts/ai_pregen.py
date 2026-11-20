"""整集 AI 资产预生成：摘要 / 主题时间戳 / 广告点 / 重点 / 词汇 / 难句 / 问题。

产物结构与播放器「整集」页签读到的一致（version=3、prompt=ads-v1），
落盘到 <out>/<slug>/<stem>.ai.json；发布时把它拷进 data 分支的 json/<slug>/ 目录，
播放页会先读它，读不到才现场调模型（这样既省 token，也躲开 Gemini 503）。

用法：
    python scripts/ai_pregen.py --show how-we-made-your-mother --limit 2
    python scripts/ai_pregen.py --all --out build/ai
    python scripts/ai_pregen.py --show x --dry-run          # 只看要处理哪些集
    python scripts/ai_pregen.py --show x --resume           # 只补没生成过的集

环境变量：GEMINI_API_KEY / GEMINI_API_KEYS、GEMINI_MODEL(S)，与流水线一致。
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

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "site" / "catalog.json"
DEFAULT_OUT = ROOT / "build" / "ai"
CACHE_DIR = ROOT / "build" / "ai_cache"

AI_VERSION = 3
AI_PROMPT = "ads-v1"
CHUNKS = 3
TARGET_LANG = "简体中文"
MAX_TOPICS = 24
MAX_ADS = 24
MAX_VOCAB = 30
MAX_HARD = 20


# ---------------------------------------------------------------- 文本工具
def clock_seconds(value) -> float | None:
    """把 'mm:ss' / 'hh:mm:ss' / 秒数 统一成秒。"""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if not text:
        return None
    if re.fullmatch(r"\d+(\.\d+)?", text):
        return float(text)
    parts = text.split(":")
    try:
        nums = [float(p) for p in parts]
    except ValueError:
        return None
    if len(nums) == 2:
        return nums[0] * 60 + nums[1]
    if len(nums) == 3:
        return nums[0] * 3600 + nums[1] * 60 + nums[2]
    return None


def stamp(seconds: float) -> str:
    total = max(0, int(seconds))
    return f"{total // 60}:{total % 60:02d}"


def slug_stem(transcript_url: str) -> str:
    name = transcript_url.split("/")[-1].split("?")[0]
    from urllib.parse import unquote

    name = unquote(name)
    return re.sub(r"\.json$", "", name, flags=re.I)


# ---------------------------------------------------------------- 取数据
def http_get_json(url: str, timeout: int = 120) -> dict:
    import urllib.request

    req = urllib.request.Request(url, headers={"User-Agent": "MyTranscript-pregen/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def load_transcript(url: str, slug: str, use_cache: bool = True) -> dict:
    cache = CACHE_DIR / slug / (slug_stem(url) + ".json")
    if use_cache and cache.exists() and cache.stat().st_size > 1000:
        return json.loads(cache.read_text(encoding="utf-8"))
    doc = http_get_json(url)
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    return doc


def segments_of(doc: dict) -> list[dict]:
    segs = doc.get("segments") or doc.get("sentences") or []
    out = []
    for seg in segs:
        start = seg.get("start")
        if start is None:
            start = seg.get("startTime", 0)
        start_ms = float(start) if float(start) > 10000 else float(start) * 1000
        text = str(seg.get("text") or seg.get("body") or "").strip()
        if not text:
            continue
        en = text.split("\n")[0].strip()
        if not en:
            continue
        out.append({"start": start_ms / 1000.0, "text": en})
    return out


def build_chunks(segments: list[dict], parts: int = CHUNKS) -> list[str]:
    if not segments:
        return []
    per = max(1, -(-len(segments) // parts))
    chunks = []
    for i in range(parts):
        part = segments[i * per : (i + 1) * per]
        if part:
            chunks.append("\n".join(f"[{stamp(s['start'])}] {s['text']}" for s in part))
    return chunks


# ---------------------------------------------------------------- 模型
def build_ring():
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from gemini_keys import GeminiKeyRing, gemini_models, parse_gemini_keys

    keys = parse_gemini_keys(os.getenv("GEMINI_API_KEYS", "") or os.getenv("GEMINI_API_KEY", ""))
    if not keys:
        raise SystemExit("没有 GEMINI_API_KEY / GEMINI_API_KEYS，无法调用模型。")
    return GeminiKeyRing(keys, models=gemini_models())


SYSTEM_PROMPT = (
    "You are a podcast editor summarizing a transcript chunk for a Chinese-speaking listener. "
    "Return ONLY a JSON object, no markdown fences, with keys: summary (string in "
    + TARGET_LANG
    + "), topics (array of {title, start, end, summary}), ads (array of {start, end, label}), "
    "keyPoints (array of strings), vocabulary (array of {word, phonetic, meaning, example, exampleZh, "
    "rootBreakdown, rootMeaning, sameRootWords, memoryHook}), hardSentences (array of {en, zh, why}), "
    "questions (array of strings). "
    "For topics: title and summary must be in "
    + TARGET_LANG
    + "; start/end must be copied from the [mm:ss] timestamps in the transcript, in \"mm:ss\" format; "
    "create 2-8 chronological topics covering the chunk, with no overlap. "
    "For ads: identify only explicit sponsor reads, host-read advertisements, ad breaks, or promo/discount "
    "endorsements; start/end must be copied from the [mm:ss] timestamps; label must be a short "
    + TARGET_LANG
    + " description such as \"赞助口播\" or \"优惠码推广\"; return [] when there is no ad. "
    "Do not mark ordinary brand mentions outside an ad segment. "
    "For vocabulary root fields: rootBreakdown (prefix + root + suffix with Chinese gloss), "
    "rootMeaning (literal meaning), sameRootWords (up to 2 real words {word, meaning} sharing the root), "
    "memoryHook (one short Chinese memory sentence). Never invent roots or etymology; leave them empty when unsure. "
    "Write a faithful content summary; keyPoints should be substantive claims, examples or takeaways. "
    "Keep vocabulary to at most 8 items."
)


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


def call_model(ring, chunk: str, index: int, total: int, retries: int = 3) -> dict:
    from google.genai import types

    prompt = f"Chunk {index + 1} of {total}:\n{chunk}"
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            model = ring.current_model() or os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite")
            response = ring.client().models.generate_content(
                model=model,
                contents=prompt,
                config=types.GenerateContentConfig(
                    system_instruction=SYSTEM_PROMPT,
                    response_mime_type="application/json",
                    temperature=0.3,
                ),
            )
            return parse_json_object(response.text or "")
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            text = str(exc).lower()
            if any(k in text for k in ("resource_exhausted", "quota", "429")):
                if not ring.mark_exhausted():
                    raise
                continue
            wait = 5 * (attempt + 1) + 5
            print(f"  ! 第 {index + 1} 块失败（{exc}），{wait}s 后重试", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"第 {index + 1} 块连续失败：{last_error}")


# ---------------------------------------------------------------- 合并
def merge_parts(parts: list[dict]) -> dict:
    summary, topics, ads, points, vocab, hard, questions = [], [], [], [], [], [], []
    seen_topic, seen_ad, seen_point, seen_vocab, seen_hard = set(), set(), set(), set(), set()

    for part in parts:
        if part.get("summary"):
            summary.append(str(part["summary"]))
        for t in part.get("topics") or []:
            title = str(t.get("title") or "").strip()
            start = clock_seconds(t.get("start"))
            if not title or start is None:
                continue
            key = f"{title.lower()}|{round(start)}"
            if key in seen_topic:
                continue
            seen_topic.add(key)
            topics.append(
                {
                    "title": title,
                    "start": round(start),
                    "end": round(clock_seconds(t.get("end"))) if clock_seconds(t.get("end")) else None,
                    "summary": str(t.get("summary") or "").strip(),
                }
            )
        for ad in part.get("ads") or []:
            start, end = clock_seconds(ad.get("start")), clock_seconds(ad.get("end"))
            if start is None or end is None or end <= start:
                continue
            key = f"{round(start)}|{round(end)}"
            if key in seen_ad:
                continue
            seen_ad.add(key)
            ads.append({"start": round(start), "end": round(end), "label": str(ad.get("label") or "广告")})
        for p in part.get("keyPoints") or []:
            p = str(p or "").strip()
            if p and p not in seen_point:
                seen_point.add(p)
                points.append(p)
        for v in part.get("vocabulary") or []:
            w = str(v.get("word") or "").strip()
            if w and w.lower() not in seen_vocab:
                seen_vocab.add(w.lower())
                vocab.append(v)
        for h in part.get("hardSentences") or []:
            en = str(h.get("en") or "").strip()
            if en and en.lower() not in seen_hard:
                seen_hard.add(en.lower())
                hard.append(h)
        for q in part.get("questions") or []:
            q = str(q or "").strip()
            if q and q not in seen_point:
                seen_point.add(q)
                questions.append(q)

    topics.sort(key=lambda t: t["start"])
    ads.sort(key=lambda a: a["start"])
    return {
        "summary": "\n\n".join(summary),
        "topics": topics[:MAX_TOPICS],
        "ads": ads[:MAX_ADS],
        "keyPoints": points,
        "vocabulary": vocab[:MAX_VOCAB],
        "hardSentences": hard[:MAX_HARD],
        "questions": questions,
    }


# ---------------------------------------------------------------- 主流程
def show_episodes(catalog: dict, slug: str | None, source: str = "feed") -> list[tuple[str, dict]]:
    """枚举待处理单集：默认读 site/<slug>/feed.xml（含全部单集），读不到再退回 catalog.latest。"""
    out = []
    for show in catalog.get("shows", []):
        s = show.get("slug")
        if slug and s != slug:
            continue
        episodes = episodes_from_feed(s) if source == "feed" else []
        if not episodes:
            episodes = [
                ep for ep in (show.get("latest") or []) if ((ep.get("transcript") or {}).get("url") or "")
            ]
        for ep in episodes:
            if ((ep.get("transcript") or {}).get("url") or ""):
                out.append((s, ep))
    return out


def episodes_from_feed(slug: str) -> list[dict]:
    """从已发布的 feed.xml 里读出全部单集（标题 + guid + 词级 JSON 地址）。"""
    import html as html_mod

    path = ROOT / "site" / slug / "feed.xml"
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8", errors="ignore")
    out = []
    for chunk in re.split(r"<item>", text)[1:]:
        title = re.search(r"<title>(.*?)</title>", chunk, re.S)
        guid = re.search(r"<guid[^>]*>(.*?)</guid>", chunk, re.S)
        tr = re.search(r'<podcast:transcript[^>]*url="([^"]+)"[^>]*type="application/json"', chunk)
        if not tr:
            tr = re.search(r'<podcast:transcript[^>]*type="application/json"[^>]*url="([^"]+)"', chunk)
        if not (title and tr):
            continue
        name = html_mod.unescape(re.sub(r"<!\[CDATA\[(.*?)\]\]>", r"\1", title.group(1), flags=re.S)).strip()
        out.append(
            {
                "id": html_mod.unescape((guid.group(1) if guid else name)).strip(),
                "title": name,
                "transcript": {"url": html_mod.unescape(tr.group(1)).strip(), "type": "application/json"},
            }
        )
    return out


def episode_paths(out_dir: Path, slug: str, url: str) -> Path:
    return out_dir / slug / (slug_stem(url) + ".ai.json")


def process(out_dir: Path, slug: str, ep: dict, ring, force: bool) -> str:
    url = ep["transcript"]["url"]
    target = episode_paths(out_dir, slug, url)
    if target.exists() and not force:
        return "skip"
    doc = load_transcript(url, slug)
    segments = segments_of(doc)
    chunks = build_chunks(segments)
    if not chunks:
        return "empty"
    parts = [call_model(ring, chunk, i, len(chunks)) for i, chunk in enumerate(chunks)]
    data = merge_parts(parts)
    payload = {
        "version": AI_VERSION,
        "prompt": AI_PROMPT,
        "model": ring.current_model() or os.getenv("GEMINI_MODEL", ""),
        "generator": "scripts/ai_pregen.py",
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "show": slug,
        "episode_id": ep.get("id", ""),
        "title": ep.get("title", ""),
        "audio_seconds": doc.get("audio_seconds", 0),
        "chunks": len(chunks),
        "data": data,
    }
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    return "ok"


def main() -> int:
    ap = argparse.ArgumentParser(description="预生成整集 AI 资产（摘要/章节/金句素材）")
    ap.add_argument("--show", help="只处理某个 slug")
    ap.add_argument("--all", action="store_true", help="处理目录里所有节目")
    ap.add_argument("--source", choices=["feed", "catalog"], default="feed",
                    help="单集来源：feed=站内 feed.xml 全量（默认），catalog=目录里的最新 20 集")
    ap.add_argument("--limit", type=int, default=0, help="最多处理多少集（0=不限）")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="产物目录，默认 build/ai")
    ap.add_argument("--resume", action="store_true", help="跳过已生成的集（默认行为）")
    ap.add_argument("--force", action="store_true", help="覆盖已有产物")
    ap.add_argument("--dry-run", action="store_true", help="只打印计划，不调用模型")
    args = ap.parse_args()

    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    slug = None if args.all else args.show
    if not slug and not args.all:
        ap.error("需要 --show <slug> 或 --all")
    targets = show_episodes(catalog, slug, args.source)
    if args.limit:
        targets = targets[: args.limit]
    out_dir = Path(args.out)

    print(f"目标：{len(targets)} 集 → {out_dir}")
    if args.dry_run:
        for s, ep in targets:
            mark = "已生成" if episode_paths(out_dir, s, ep["transcript"]["url"]).exists() else "待生成"
            print(f"  [{mark}] {s} · {ep.get('title', '')[:60]}")
        return 0

    ring = build_ring()
    counts = {"ok": 0, "skip": 0, "empty": 0, "fail": 0}
    for i, (show_slug, ep) in enumerate(targets, 1):
        label = f"{show_slug} · {str(ep.get('title', ''))[:50]}"
        print(f"[{i}/{len(targets)}] {label}")
        try:
            result = process(out_dir, show_slug, ep, ring, args.force)
            counts[result] += 1
            print(f"  -> {result}")
        except Exception as exc:  # noqa: BLE001
            counts["fail"] += 1
            print(f"  -> 失败：{exc}", file=sys.stderr)
    print("完成：", counts)
    return 0 if counts["fail"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
