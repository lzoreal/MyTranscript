"""跨分片共享的 Gemini key 健康度：各分片只写自己的文件，启动时合并读取。

分片之间不能改同一个文件（并发 push 会撞），所以写入按分片分文件，读取全量合并。
文件里只存 key 的 sha256 前缀，不存原文。
"""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

# 鉴权失败不会自愈，隔天再试；配额（含每分钟限流）会自己恢复，半小时后再试。
AUTH_TTL = 24 * 3600
QUOTA_TTL = 30 * 60


def key_id(key: str) -> str:
    return hashlib.sha256((key or "").encode("utf-8")).hexdigest()[:12]


def record(path: Path, key: str, kind: str, model: str | None = None,
           now: float | None = None) -> None:
    """记下某个 key 在某个时刻因 quota/auth 不可用；同一文件内后写覆盖先写。

    quota 按模型计，记下模型名，免得换模型后还被上个模型的额度记录挡住；
    auth 是 key 本身的问题，对所有模型生效。
    """
    if not key:
        return
    now = time.time() if now is None else now
    path = Path(path)
    data = _read(path)
    entry = {"kind": "auth" if kind == "auth" else "quota", "at": now}
    if entry["kind"] == "quota" and model:
        entry["model"] = model
    data[key_id(key)] = entry
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)


def dead_ids(directory: Path, model: str | None = None,
             now: float | None = None) -> set[str]:
    """合并目录下所有分片文件，返回当前仍处于不可用窗口内的 key 指纹。

    只算当前模型的 quota 记录；没写模型的老记录按对全部模型有效处理。
    """
    now = time.time() if now is None else now
    dead: set[str] = set()
    for path in sorted(Path(directory).glob("*.json")):
        for identifier, entry in _read(path).items():
            if not isinstance(entry, dict):
                continue
            at = entry.get("at")
            if not isinstance(at, (int, float)):
                continue
            is_auth = entry.get("kind") == "auth"
            if not is_auth and model is not None:
                recorded = entry.get("model")
                if recorded is not None and recorded != model:
                    continue
            ttl = AUTH_TTL if is_auth else QUOTA_TTL
            if 0 <= now - at < ttl:
                dead.add(identifier)
    return dead


def usable_keys(keys, dead: set[str]) -> list[str]:
    return [key for key in keys if key_id(key) not in dead]


def _read(path: Path) -> dict:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}
