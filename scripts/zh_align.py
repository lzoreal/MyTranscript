"""中文词时间派生：小句切分 + 按词数/字数分配（纯函数，分词器注入）。"""

from __future__ import annotations

from typing import Callable

EN_END = (".", ",", "!", "?", ";", ":")
ZH_END = ("，", "。", "！", "？", "；", "：", "、", "…")


def en_clause_word_counts(tokens: list[str]) -> list[int]:
    counts, current = [], 0
    for token in tokens:
        current += 1
        if token.endswith(EN_END):
            counts.append(current)
            current = 0
    if current:
        counts.append(current)
    return counts


def allocate_spans(counts, start: float, end: float):
    total = sum(counts)
    if not counts or total <= 0:
        return [(start, start) for _ in counts]
    spans, cursor = [], start
    for count in counts:
        piece = (end - start) * count / total
        spans.append((cursor, cursor + piece))
        cursor += piece
    return spans


def split_zh_clauses(tokens: list[str]) -> list[list[str]]:
    clauses, current = [], []
    for token in tokens:
        current.append(token)
        if token in ZH_END:
            clauses.append(current)
            current = []
    if current:
        clauses.append(current)
    return clauses


def distribute_clause(tokens: list[str], start: float, end: float) -> list[dict]:
    words = [token for token in tokens if token not in ZH_END]
    weights = [max(1, len(word)) for word in words]
    total = sum(weights) or 1
    span = max(0.0, end - start)
    result, cursor = [], start
    for word, weight in zip(words, weights):
        duration = span * weight / total
        result.append({"w": word, "s": cursor, "e": cursor + duration, "d": duration})
        cursor += duration
    return result


def build_zh_words(clauses, start: float, end: float, tokens_of: Callable[[str], list[str]]):
    counts = [len((clause.get("en") or "").split()) for clause in clauses]
    spans = allocate_spans(counts, start, end)
    out: list[list] = []
    for clause, (clause_start, clause_end) in zip(clauses, spans):
        for word in distribute_clause(tokens_of(clause.get("zh") or ""), clause_start, clause_end):
            out.append([word["w"], int(round(word["s"] * 1000)), int(round(word["d"] * 1000))])
    return out


MAX_CLAUSE_DELTA = 3
MAX_ALLOCATION_SKEW = 0.5


def clauses_confident(en_counts, zh_clauses) -> bool:
    return abs(len(zh_clauses) - len(en_counts)) < MAX_CLAUSE_DELTA


def allocation_plausible(spans, zh_clauses) -> bool:
    ratios = []
    for (start, end), clause in zip(spans, zh_clauses):
        chars = sum(len(word) for word in clause if word not in ZH_END) or 1
        ratios.append((end - start) / chars)
    if not ratios:
        return False
    ordered = sorted(ratios)
    median = ordered[len(ordered) // 2] or 1e-9
    return all(abs(ratio - median) <= median * MAX_ALLOCATION_SKEW for ratio in ratios)


def dtw_path(sim) -> list[tuple[int, int]]:
    n, m = len(sim), len(sim[0]) if sim else 0
    if not n or not m:
        return []
    dp = [[float("inf")] * (m + 1) for _ in range(n + 1)]
    dp[0][0] = 0.0
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            cost = 1.0 - sim[i - 1][j - 1]
            dp[i][j] = cost + min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    path, i, j = [], n, m
    while i > 0 and j > 0:
        path.append((i - 1, j - 1))
        best = min((dp[i - 1][j], "up"), (dp[i][j - 1], "left"), (dp[i - 1][j - 1], "diag"))
        if best[1] == "diag":
            i, j = i - 1, j - 1
        elif best[1] == "up":
            i -= 1
        else:
            j -= 1
    return path[::-1]


def fallback_zh_words(en_words, zh_text, segment, encode, start: float, end: float):
    en_tokens = [word["w"] for word in en_words]
    en_counts = en_clause_word_counts(en_tokens)
    zh_clauses = split_zh_clauses(segment(zh_text))
    if not en_counts or not zh_clauses or not clauses_confident(en_counts, zh_clauses):
        return []

    en_texts, en_spans, cursor = [], [], 0
    for count in en_counts:
        chunk = en_words[cursor : cursor + count]
        cursor += count
        en_texts.append(" ".join(word["w"] for word in chunk))
        en_spans.append((chunk[0]["s"], chunk[-1]["e"]))

    zh_texts = ["".join(clause) for clause in zh_clauses]
    embeddings = encode(en_texts + zh_texts)
    n = len(en_texts)
    sim = [[sum(a * b for a, b in zip(embeddings[i], embeddings[n + j]))
            for j in range(len(zh_clauses))] for i in range(n)]
    shared: dict[int, list[int]] = {}
    for en_i, zh_j in dtw_path(sim):
        shared.setdefault(en_i, []).append(zh_j)

    spans, ordered = {}, []
    for en_i, zh_list in shared.items():
        zh_list = sorted(zh_list)
        clause_start, clause_end = en_spans[en_i]
        weights = [max(1, sum(len(w) for w in zh_clauses[j] if w not in ZH_END)) for j in zh_list]
        total = sum(weights) or 1
        cursor_time = clause_start
        for zh_j, weight in zip(zh_list, weights):
            piece = (clause_end - clause_start) * weight / total
            spans[zh_j] = (cursor_time, cursor_time + piece)
            cursor_time += piece
    keys = sorted(spans)
    if not allocation_plausible([spans[k] for k in keys], [zh_clauses[k] for k in keys]):
        return []
    out: list[list] = []
    for key in keys:
        for word in distribute_clause(zh_clauses[key], *spans[key]):
            out.append([word["w"], int(round(word["s"] * 1000)), int(round(word["d"] * 1000))])
    return out
