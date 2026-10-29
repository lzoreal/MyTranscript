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
