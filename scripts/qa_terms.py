"""文字稿术语质检：从词级 JSON 里挑出「大概率被 ASR 听错」的专名/缩写，出一份人工可核对的清单。

不调用模型也能跑（默认）；加 --llm 才会让模型复核候选，且失败不影响报告生成。

用法：
    python scripts/qa_terms.py --show how-we-made-your-mother
    python scripts/qa_terms.py --all --out build/qa
    python scripts/qa_terms.py --show x --llm --llm-top 20

产物：<out>/<slug>.md，每条给出判定、建议和首次出现的上下文。
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from ai_pregen import CATALOG, load_transcript, segments_of, stamp, episodes_from_feed  # noqa: E402

TOKEN_OK = re.compile(r"^[A-Za-z][A-Za-z'’\-]*$")
STOPWORDS = {
    "i", "you", "he", "she", "we", "they", "it", "the", "a", "an", "and", "or", "but", "so", "as",
    "of", "to", "in", "on", "at", "for", "with", "from", "by", "is", "are", "was", "were", "be",
    "been", "being", "do", "does", "did", "have", "has", "had", "not", "no", "yes", "oh", "okay",
    "yeah", "well", "just", "like", "that", "this", "these", "those", "my", "your", "his", "her",
}


def load_glossary() -> tuple[set[str], set[str]]:
    """返回（全部词，小写），以及专名集合（原文大写开头的词）。"""
    path = ROOT / "GLOSSARY.md"
    if not path.exists():
        return set(), set()
    words: set[str] = set()
    proper: set[str] = set()
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        for token in re.findall(r"[A-Za-z][A-Za-z'’\-]{1,}", line):
            words.add(token.lower())
            if token[0].isupper():
                proper.add(token.lower())
    return words, proper


def show_vocab(catalog: dict) -> tuple[set[str], set[str]]:
    """节目名/单集标题里出现过的词，兼作专名词表。"""
    words: set[str] = set()
    proper: set[str] = set()
    for show in catalog.get("shows", []):
        for source in [show.get("name", "")] + [ep.get("title", "") for ep in (show.get("latest") or [])]:
            for token in re.findall(r"[A-Za-z][A-Za-z'’\-]{1,}", source):
                words.add(token.lower())
                if token[0].isupper():
                    proper.add(token.lower())
    return words, proper


def token_stats(doc: dict) -> tuple[Counter, dict[str, list[dict]]]:
    counter: Counter = Counter()
    samples: dict[str, list[dict]] = defaultdict(list)
    for seg in doc.get("segments") or []:
        words = seg.get("words") or []
        text = str(seg.get("text") or "").split("\n")[0]
        tokens = []
        if words:
            for item in words:
                token = str(item[0] if isinstance(item, (list, tuple)) else item).strip()
                tokens.append(token.strip(".,!?;:\"()[]"))
        else:
            tokens = re.findall(r"[A-Za-z][A-Za-z'’\-]*", text)
        first_word = (text.strip().split(" ")[0] if text.strip() else "").strip(".,!?;:\"()[]").lower()
        for token in tokens:
            if not TOKEN_OK.match(token):
                continue
            counter[token] += 1
            if len(samples[token]) < 3:
                samples[token].append(
                    {
                        "time": seg.get("start", 0) / 1000.0,
                        "text": text,
                        "initial": token.lower() == first_word,
                    }
                )
    return counter, samples


MONTHS_DAYS = {
    "january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
    "november", "december", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    "christmas", "thanksgiving", "halloween", "easter",
}


def norm_name(token: str) -> str:
    """去掉所有格与复数尾，用来判断两个专名是不是同一个词。"""
    low = token.lower().replace("’", "'")
    low = re.sub(r"'s$|'$", "", low)
    return low


def reasons_for(token: str, count: int, glossary: set[str], proper: set[str], samples: list[dict]) -> list[str]:
    """只挑「专名类」问题：小写常用词、只在句首出现的词、月份星期一律不进来。"""
    reasons: list[str] = []
    low = token.lower()
    if norm_name(token) in MONTHS_DAYS or low in MONTHS_DAYS:
        return reasons
    internal_cap = bool(re.search(r"[a-z][A-Z]", token))
    if token[0].islower() and not internal_cap:
        return reasons
    if not internal_cap and all(s.get("initial") for s in samples):
        # 只出现在句首的 Capitalized 词多半只是句首大写，不是专名。
        return reasons
    if internal_cap:
        reasons.append("大小写异常（不像正常专名）")
    if re.search(r"\d", token):
        reasons.append("含数字，疑似识别碎片")
    if token.isupper() and len(token) <= 5 and count <= 3:
        reasons.append("短全大写，可能是缩写误听")
    if token.istitle() and low not in glossary and low not in proper and count <= 3 and len(low) >= 3:
        reasons.append("低频专名，词表里没有")
    return reasons


def context_of(samples: list[dict]) -> str:
    if not samples:
        return ""
    s = samples[0]
    text = s["text"]
    if len(text) > 92:
        text = text[:92] + "…"
    return f"[{stamp(s['time'])}] {text}"


def llm_review(candidates: list[dict], top: int, slug: str) -> dict[str, str]:
    try:
        from run_pipeline import build_ring  # type: ignore
    except Exception:
        try:
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            from gemini_keys import GeminiKeyRing, gemini_models, parse_gemini_keys

            keys = parse_gemini_keys(os.getenv("GEMINI_API_KEYS", "") or os.getenv("GEMINI_API_KEY", ""))
            if not keys:
                print("  (--llm 跳过：没有 GEMINI_API_KEY)", file=sys.stderr)
                return {}
            ring = GeminiKeyRing(keys, models=gemini_models())
        except Exception as exc:  # noqa: BLE001
            print(f"  (--llm 跳过：{exc})", file=sys.stderr)
            return {}
    else:
        ring = build_ring()

    from google.genai import types

    reviews: dict[str, str] = {}
    for item in candidates[:top]:
        prompt = (
            "你在校对播客文字稿的专有名词。下面这些词是从同一集里抽出的候选，请判断它们在上下文里"
            "是否拼错了；如果拼错，给出最常见的正确拼写；如果不确定就写「保留」。"
            "只返回 JSON 数组：[{\"token\":\"...\",\"verdict\":\"正确|拼错|不确定\",\"suggestion\":\"...\"}]。"
            f"\n节目：{slug}\n候选："
            + json.dumps([{"token": c["token"], "count": c["count"], "context": c["context"]} for c in candidates[:top]], ensure_ascii=False)
        )
        try:
            response = ring.client().models.generate_content(
                model=ring.current_model() or os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite"),
                contents=prompt,
                config=types.GenerateContentConfig(response_mime_type="application/json", temperature=0.2),
            )
            text = (response.text or "").strip()
            first, last = text.find("["), text.rfind("]")
            data = json.loads(text[first : last + 1]) if first >= 0 else []
            for row in data:
                token = str(row.get("token") or "")
                if token:
                    reviews[token] = f"{row.get('verdict', '')} {row.get('suggestion', '')}".strip()
        except Exception as exc:  # noqa: BLE001
            print(f"  (--llm 复核失败：{exc})", file=sys.stderr)
            break
    return reviews


def render(slug: str, name: str, candidates: list[dict], total_eps: int, reviews: dict[str, str]) -> str:
    lines = [
        f"# 文字稿术语巡检 · {name}（{slug}）",
        "",
        f"- 生成时间：{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}",
        f"- 覆盖：{total_eps} 集",
        f"- 候选：{len(candidates)} 个 token",
        "",
        "| 词 | 次数 | 判定 | 建议 | 首次出现 |",
        "| --- | --- | --- | --- | --- |",
    ]
    for c in candidates:
        suggestion = reviews.get(c["token"], "")
        judge = "；".join(c["reasons"])
        if suggestion:
            judge = (judge + " / AI：" + suggestion).strip(" /")
        ctx = c["context"].replace("|", "\\|")
        lines.append(
            f"| `{c['token']}` | {c['count']} | {judge} | {suggestion or '待人工确认'} | {ctx} |"
        )
    lines.append("")
    lines.append("判定规则：大小写异常 > 与已知词高度相似 > 低频专名 > 含数字。"
                 "建议逐条对照上下文人工确认，确认后再改词级 JSON（不要直接改文本稿）。")
    return "\n".join(lines)


def analyze(slug: str, catalog: dict, show: dict, limit: int, llm_top: int) -> str:
    glossary, proper_g = load_glossary()
    words, proper_s = show_vocab(catalog)
    known = words | glossary
    proper = proper_g | proper_s
    counter_total: Counter = Counter()
    samples_all: dict[str, list[dict]] = defaultdict(list)
    episodes = episodes_from_feed(slug) or (show.get("latest") or [])
    if limit:
        episodes = episodes[:limit]
    used = 0
    for ep in episodes:
        url = ((ep.get("transcript") or {}).get("url") or "")
        if not url:
            continue
        try:
            doc = load_transcript(url, slug)
        except Exception as exc:  # noqa: BLE001
            print(f"  ! {ep.get('title')}: {exc}", file=sys.stderr)
            continue
        used += 1
        counter, samples = token_stats(doc)
        counter_total.update(counter)
        for token, rows in samples.items():
            for row in rows:
                if len(samples_all[token]) < 2:
                    samples_all[token].append(row)

    candidates = []
    for token, count in counter_total.items():
        if token.lower() in STOPWORDS:
            continue
        reasons = reasons_for(token, count, glossary, proper, samples_all[token])
        if not reasons:
            continue
        score = 0
        if "大小写异常（不像正常专名）" in reasons:
            score += 3
        if any("近形" in r for r in reasons):
            score += 2
        if "含数字，疑似识别碎片" in reasons:
            score += 1
        candidates.append(
            {
                "token": token,
                "count": count,
                "reasons": reasons,
                "score": score,
                "context": context_of(samples_all[token]),
            }
        )

    # 同一集里两个只差一两个字母的专名，多半是同一个名字被听成了两种拼法。
    for i, a in enumerate(candidates):
        for b in candidates[i + 1 :]:
            if a["count"] > 6 or b["count"] > 6:
                continue
            na, nb = norm_name(a["token"]), norm_name(b["token"])
            if not na or not nb or na == nb:
                continue
            if na[:1] != nb[:1]:
                continue
            if na.startswith(nb) or nb.startswith(na):
                continue
            if difflib.SequenceMatcher(None, na, nb).ratio() < 0.9:
                continue
            note = f"与同集「{b['token']}」近形（疑似同一名字两种拼法）"
            if note not in a["reasons"]:
                a["reasons"].append(note)
                a["score"] += 2
            note = f"与同集「{a['token']}」近形（疑似同一名字两种拼法）"
            if note not in b["reasons"]:
                b["reasons"].append(note)
                b["score"] += 2

    candidates.sort(key=lambda c: (-c["score"], -c["count"], c["token"].lower()))
    reviews = llm_review(candidates, llm_top, slug) if llm_top else {}
    return render(slug, show.get("name", slug), candidates, used, reviews)


def main() -> int:
    ap = argparse.ArgumentParser(description="文字稿术语巡检")
    ap.add_argument("--show", help="只跑某个 slug")
    ap.add_argument("--all", action="store_true", help="跑目录里所有节目")
    ap.add_argument("--limit", type=int, default=10, help="每个节目最多扫多少集（默认 10）")
    ap.add_argument("--out", default=str(ROOT / "build" / "qa"), help="报告目录")
    ap.add_argument("--llm-top", type=int, default=0, help="让模型复核前 N 个候选（0=不调用）")
    args = ap.parse_args()

    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    shows = catalog.get("shows", [])
    if args.show:
        shows = [s for s in shows if s.get("slug") == args.show]
        if not shows:
            ap.error(f"目录里没有 slug={args.show}")

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    for show in shows:
        slug = show.get("slug", "")
        print(f"扫描 {slug} …")
        report = analyze(slug, catalog, show, args.limit, args.llm_top)
        target = out_dir / f"{slug}.md"
        target.write_text(report, encoding="utf-8")
        print(f"  -> {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
