"""把 site/catalog.json 的真实节目数据打包成原型要用的 data.js。

- 14 档节目：名称、分类、简介、集数、最新 12 集（标题 / 日期 / 时长 / 音频地址 / 文字稿地址）
- 封面：下载后压到 512、转 JPEG、编成 data URL（原型跑在 file:// 下也不能被跨源污染）
- 每档算一个主色（给档案盒上色），并派生一个强调色（描边 / 标签）

用法：python prototypes/broadcast-archive-3d/build_data.py
"""
from __future__ import annotations

import base64
import io
import json
import re
import sys
from datetime import datetime
from pathlib import Path

import requests
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
CATALOG = ROOT / "site" / "catalog.json"
OUT = Path(__file__).resolve().parent / "data.js"

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MyTranscript-Prototype/0.1"}
SUFFIX = re.compile(r"\s*\(Unofficial\)\s*-\s*Transcripts", re.I)


def clean_name(name: str) -> str:
    return SUFFIX.sub("", name).strip()


def cover_data_url(url: str) -> tuple[str, tuple[int, int, int]]:
    """下载封面 -> 512 方图 JPEG -> data URL；顺手算一个主色。"""
    try:
        resp = requests.get(url, headers=UA, timeout=25)
        resp.raise_for_status()
        img = Image.open(io.BytesIO(resp.content)).convert("RGB")
    except Exception as exc:  # noqa: BLE001 - 单张失败不该拖垮整批
        print(f"  cover failed: {exc}")
        return "", (120, 90, 62)

    img = img.resize((512, 512), Image.LANCZOS)
    thumb = img.resize((24, 24), Image.LANCZOS)
    pixels = list(thumb.get_flattened_data() if hasattr(thumb, "get_flattened_data") else thumb.getdata())
    sat_pixels = [p for p in pixels if max(p) - min(p) > 12]
    pool = sat_pixels or pixels
    avg = tuple(sum(p[i] for p in pool) // len(pool) for i in range(3))
    # 档案盒要压暗并保住一点饱和：浅色封面（白底、大片米色）不然会发灰白
    import colorsys

    h, s, v = colorsys.rgb_to_hsv(*[c / 255 for c in avg])
    s = min(1.0, max(0.18, s * 1.35))
    v = min(0.52, max(0.16, v * 0.78))
    base = tuple(int(c * 255) for c in colorsys.hsv_to_rgb(h, s, v))

    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=78, optimize=True, progressive=True)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{b64}", base


def accent_of(rgb: tuple[int, int, int]) -> str:
    """把主色提亮成强调色（纸黄一点，别偏粉）。"""
    r, g, b = rgb
    r = min(255, int(r * 1.55 + 62))
    g = min(255, int(g * 1.5 + 52))
    b = min(255, int(b * 1.35 + 30))
    return f"#{r:02x}{g:02x}{b:02x}"


def hex_of(rgb: tuple[int, int, int]) -> str:
    return "#{:02x}{:02x}{:02x}".format(*rgb)


def short_date(raw: str) -> str:
    for fmt in ("%a, %d %b %Y %H:%M:%S %z", "%a, %d %b %Y %H:%M:%S %Z"):
        try:
            return datetime.strptime(raw.strip(), fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return (raw or "")[:10]


def mmss(raw: str) -> str:
    """源站时常出现 00:36:62 这种秒数越界的值，统一折算成 MM:SS。"""
    raw = (raw or "").strip()
    if not raw:
        return ""
    try:
        parts = [int(p) for p in raw.split(":")]
    except ValueError:
        return raw
    if len(parts) == 3:
        total = parts[0] * 3600 + parts[1] * 60 + parts[2]
    elif len(parts) == 2:
        total = parts[0] * 60 + parts[1]
    else:
        total = parts[0]
    return f"{total // 60}:{total % 60:02d}"


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    shows = catalog.get("shows") or []
    packed = []

    for index, show in enumerate(shows):
        print(f"[{index + 1}/{len(shows)}] {show['slug']}")
        artwork, base_rgb = cover_data_url(show.get("artwork") or "")
        episodes = []
        for item in (show.get("latest") or [])[:12]:
            tr = item.get("transcript") or {}
            episodes.append(
                {
                    "title": (item.get("title") or "").strip(),
                    "date": short_date(item.get("date") or ""),
                    "duration": mmss(item.get("duration") or ""),
                    "audio": (item.get("url") or item.get("directUrl") or "").strip(),
                    "transcript": (tr.get("url") or "").strip(),
                }
            )
        packed.append(
            {
                "slug": show.get("slug"),
                "name": clean_name(show.get("name") or show.get("slug") or ""),
                "categories": (show.get("categories") or [])[:2],
                "description": (show.get("description") or "").split("\n\n")[0].strip(),
                "episodeCount": show.get("episode_count") or 0,
                "transcriptCount": show.get("transcript_count") or 0,
                "latestAt": short_date(show.get("latest_published_at") or ""),
                "artwork": artwork,
                "color": hex_of(base_rgb),
                "accent": accent_of(base_rgb),
                "episodes": episodes,
            }
        )

    payload = {
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "source": str(CATALOG.relative_to(ROOT)).replace("\\", "/"),
        "shows": packed,
    }
    OUT.write_text(
        "/* 由 build_data.py 生成，别手改。数据源：site/catalog.json */\n"
        "window.ARCHIVE_DATA = "
        + json.dumps(payload, ensure_ascii=False, indent=1)
        + ";\n",
        encoding="utf-8",
    )
    print(f"wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB, {len(packed)} shows)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
