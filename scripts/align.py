#!/usr/bin/env python3
"""
音频-字幕对齐工具
用 faster-whisper 检测片头广告长度，自动修正 VTT 时间戳
用法: python scripts/align.py <podcast_slug> <guid_or_title>
"""

import sys
import re
import json
import tempfile
import subprocess
from pathlib import Path
from urllib.parse import urlparse
import requests
from faster_whisper import WhisperModel
from lxml import etree

PROGRESS_FILE = Path("progress.json")
PODCASTS_FILE = Path("podcasts.json")
SITE_DIR = Path("site")

MODEL_SIZE = "base"  # 对齐不需要 large，base 够快够准


def load_podcasts():
    with open(PODCASTS_FILE, "r", encoding="utf-8") as f:
        return {p["slug"]: p for p in json.load(f)}


def load_progress():
    if PROGRESS_FILE.exists():
        with open(PROGRESS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"podcasts": {}}


def save_progress(progress):
    with open(PROGRESS_FILE, "w", encoding="utf-8") as f:
        json.dump(progress, f, ensure_ascii=False, indent=2)


def get_audio_url(feed_url, guid):
    """从 RSS 中获取指定 guid 的音频 URL"""
    resp = requests.get(feed_url, timeout=60)
    root = etree.fromstring(resp.content)
    ns = {"itunes": "http://www.itunes.com/dtds/podcast-1.0.dtd"}
    for item in root.xpath("//item"):
        g = item.find("guid")
        if g is not None and g.text and g.text.strip() == guid:
            enclosure = item.find("enclosure")
            if enclosure is not None:
                return enclosure.get("url")
            # 也尝试 itunes 命名空间
            dur = item.find("itunes:duration", namespaces=ns)
            # fallback: 找 media:content
            media = item.find(".//{http://search.yahoo.com/mrss/}content")
            if media is not None:
                return media.get("url")
    return None


def download_audio_sample(url, duration=180):
    """用 ffmpeg 只下载前 N 秒音频，转为 wav"""
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    cmd = [
        "ffmpeg", "-y", "-i", url,
        "-t", str(duration), "-ar", "16000", "-ac", "1",
        "-vn", tmp.name
    ]
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
    return Path(tmp.name)


def transcribe_sample(audio_path):
    """用 faster-whisper 快速转录前 2 分钟"""
    model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        str(audio_path),
        beam_size=1,
        language="en",
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500),
        condition_on_previous_text=False,
    )
    return list(segments), info


def find_offset(podscripts_text, whisper_segments):
    """
    用 podscripts 字幕的前 3 句话，在 whisper 转录结果中查找匹配，
    返回时间偏移量（秒）
    """
    # 提取 podscripts 前几句（清理后）
    pod_lines = [l.strip() for l in podscripts_text.split("\n") if l.strip() and not l.startswith("Starting point")]
    pod_prefix = " ".join(pod_lines[:3]).lower()
    pod_prefix = re.sub(r"[^\w\s]", "", pod_prefix)
    pod_words = set(pod_prefix.split())

    best_offset = 0
    best_score = 0

    for seg in whisper_segments:
        text = re.sub(r"[^\w\s]", "", seg.text.lower())
        words = set(text.split())
        score = len(pod_words & words)
        if score > best_score:
            best_score = score
            best_offset = seg.start

    # 如果匹配度太低，可能是字幕完全不同（如嘉宾名 vs 内容），放宽条件
    if best_score < 3 and whisper_segments:
        # fallback: 取第一个语音段开始时间
        best_offset = whisper_segments[0].start

    return round(best_offset)


def main():
    if len(sys.argv) < 3:
        print("用法: python scripts/align.py <podcast_slug> <guid>")
        print("示例: python scripts/align.py office-ladies <guid>")
        sys.exit(1)

    slug = sys.argv[1]
    guid = sys.argv[2]

    podcasts = load_podcasts()
    podcast = podcasts.get(slug)
    if not podcast:
        print(f"播客 {slug} 未找到")
        sys.exit(1)

    progress = load_progress()
    pc_prog = progress.setdefault("podcasts", {}).setdefault(slug, {"processed": {}})
    processed = pc_prog.get("processed", {})

    if guid not in processed:
        print(f"剧集 {guid} 尚未在 progress.json 中，请先运行 scraper")
        sys.exit(1)

    ep_info = processed[guid]
    title = ep_info["title"]
    vtt_path = SITE_DIR / slug / "transcripts" / ep_info["vtt_filename"]

    print(f"🎙️ 对齐: {title}")
    print(f"   播客: {slug}")
    print(f"   GUID: {guid}")

    # 1. 获取音频 URL
    audio_url = get_audio_url(podcast["feed_url"], guid)
    if not audio_url:
        print("❌ 无法从 RSS 获取音频 URL")
        sys.exit(1)
    print(f"   音频: {audio_url[:80]}...")

    # 2. 下载前 2 分钟
    print("⬇️  下载音频样本 (前 120s)...")
    sample_path = download_audio_sample(audio_url, duration=120)

    # 3. 快速转录
    print(f"📝 用 {MODEL_SIZE} 快速转录...")
    segments, info = transcribe_sample(sample_path)
    print(f"   检测到 {len(segments)} 个语音段")

    # 4. 读取现有字幕内容
    with open(vtt_path, "r", encoding="utf-8") as f:
        vtt_text = f.read()

    # 提取纯文本（去掉时间戳和 WEBVTT 头）
    pod_text = re.sub(r"WEBVTT|^\d+$|\d{2}:\d{2}:\d{2}\.\d{3} --> .*", "", vtt_text, flags=re.MULTILINE)

    # 5. 计算偏移
    offset = find_offset(pod_text, segments)
    print(f"   检测到广告偏移: {offset}s")

    # 6. 更新 progress.json
    ep_info["ad_offset"] = offset
    save_progress(progress)
    print(f"   已保存到 progress.json")

    # 7. 提示重新生成 VTT
    print(f"\n✅ 完成。请重新运行 scraper.py 以生成对齐后的 VTT 文件。")
    print(f"   或手动执行: python scripts/scraper.py (仅重新生成 Feed/VTT，不重新爬取)")

    # 清理
    sample_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()