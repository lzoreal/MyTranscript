import os
import sys
import json
import time
import re
import feedparser
import requests
from datetime import datetime, timezone
from faster_whisper import WhisperModel
from pathlib import Path
from lxml import etree

PODCAST_SLUG = os.environ.get("PODCAST_SLUG", "default")
FEED_URL = os.environ.get("FEED_URL")
MODEL_SIZE = os.environ.get("WHISPER_MODEL", "base")
BASE_URL = os.environ.get("BASE_URL", "").rstrip("/")

# 兜底：如果 BASE_URL 为空，尝试从 GITHUB_REPOSITORY 构造
if not BASE_URL:
    gh_repo = os.environ.get("GITHUB_REPOSITORY", "")
    if gh_repo and "/" in gh_repo:
        owner, repo = gh_repo.split("/", 1)
        BASE_URL = f"https://{owner}.github.io/{repo}"
        print(f"⚠️ BASE_URL 未设置，从 GITHUB_REPOSITORY 推断: {BASE_URL}")

STATE_FILE = Path("state.json")
SITE_DIR = Path("site")
PODCAST_DIR = SITE_DIR / PODCAST_SLUG
TRANSCRIPTS_DIR = PODCAST_DIR / "transcripts"
PODCAST_DIR.mkdir(parents=True, exist_ok=True)
TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)

ABBREVIATIONS = r'\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|vol|vols|inc|etc|eg|ie|et al|st|ave|blvd|rd|dept|univ|No|pp|par|Ltd|Co|Corp|Plc|LLC|U\.S|U\.K|e\.g|i\.e)\.'


def load_state():
    if STATE_FILE.exists():
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"podcasts": {}}


def save_state(state):
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def get_podcast_state(state):
    podcasts = state.setdefault("podcasts", {})
    if PODCAST_SLUG not in podcasts:
        podcasts[PODCAST_SLUG] = {
            "feed_url": FEED_URL,
            "processed": {},
            "total_processed": 0,
            "updated_at": None
        }
    return podcasts[PODCAST_SLUG]


def safe_filename(title):
    keep = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_. "
    return "".join(c if c in keep else "_" for c in title).strip().replace(" ", "_")[:80]


def format_vtt_time(seconds):
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int((seconds % 1) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{millis:03d}"


def split_sentences(text):
    if not text:
        return []
    protected = re.sub(ABBREVIATIONS, lambda m: m.group(0).replace(".", "##DOT##"), text)
    parts = re.split(r'(?<=[.!?])\s+', protected)
    return [p.replace("##DOT##", ".").strip() for p in parts if p.strip()]


def resegment(raw_segments):
    entries = []
    for seg in raw_segments:
        text = seg.text.strip()
        if text:
            entries.append({"start": seg.start, "end": seg.end, "text": text})

    merged = []
    buf = {"text": "", "start": 0, "end": 0}
    for e in entries:
        if not buf["text"]:
            buf = dict(e)
        else:
            buf["text"] += " " + e["text"]
            buf["end"] = e["end"]

        if re.search(r'[.!?]["\']?$', buf["text"]):
            merged.append(dict(buf))
            buf = {"text": "", "start": 0, "end": 0}
    if buf["text"]:
        merged.append(buf)

    final = []
    for m in merged:
        sentences = split_sentences(m["text"])
        if len(sentences) <= 1:
            final.append(m)
            continue
        total_chars = sum(len(s) for s in sentences)
        t = m["start"]
        duration = m["end"] - m["start"]
        for sent in sentences:
            ratio = len(sent) / total_chars if total_chars > 0 else 1 / len(sentences)
            seg_dur = max(duration * ratio, 0.5)
            final.append({"start": t, "end": t + seg_dur, "text": sent})
            t += seg_dur
    return final


def write_bilingual_vtt(sentences, path):
    with open(path, "w", encoding="utf-8") as f:
        f.write("WEBVTT\n\n")
        for item in sentences:
            start = format_vtt_time(item["start"])
            end = format_vtt_time(item["end"])
            en = item["en"].strip().replace("\n", " ")
            zh = item["zh"].strip().replace("\n", " ")
            f.write(f"{start} --> {end}\n{en}\n{zh}\n\n")


def translate_with_retry(text, translator, base_delay=1.0):
    attempt = 0
    while True:
        try:
            return translator.translate(text)
        except Exception as e:
            attempt += 1
            sleep_time = base_delay * (1.5 ** min(attempt, 10))
            print(f"   ⚠️ 第 {attempt} 次失败: {e}, sleep {sleep_time:.1f}s...")
            time.sleep(sleep_time)


def translate_sentences(sentences):
    from deep_translator import GoogleTranslator
    translator = GoogleTranslator(source="en", target="zh-CN")
    total = len(sentences)
    results = []
    for i, s in enumerate(sentences, 1):
        text = s["text"]
        if not text:
            results.append({**s, "en": "", "zh": ""})
            continue
        zh = translate_with_retry(text, translator)
        results.append({**s, "en": text, "zh": zh})
        if i % 20 == 0 or i == total:
            print(f"   翻译进度: {i}/{total}")
    return results


def get_audio_url(entry):
    for enc in entry.get("enclosures", []):
        href = enc.get("href", "")
        type_ = enc.get("type", "")
        if "audio" in type_ or href.endswith((".mp3", ".m4a", ".wav")):
            return href
    return None


def find_next_entry(entries, processed):
    def sort_key(e):
        t = e.get("published_parsed") or e.get("updated_parsed") or time.gmtime(0)
        return time.mktime(t)
    entries.sort(key=sort_key)
    for entry in entries:
        guid = entry.get("guid") or entry.get("id") or entry.get("title")
        if guid not in processed:
            return entry
    return None


def generate_podcast_feed(pc_state):
    print("🔄 生成播客 RSS feed...")
    resp = requests.get(FEED_URL, timeout=60)
    resp.raise_for_status()

    root = etree.fromstring(resp.content)
    ns_uri = "https://podcastindex.org/namespace/1.0"

    nsmap = dict(root.nsmap)
    if nsmap.get("podcast") != ns_uri:
        nsmap["podcast"] = ns_uri
        new_root = etree.Element(root.tag, attrib=root.attrib, nsmap=nsmap)
        new_root[:] = root[:]
        new_root.text = root.text
        new_root.tail = root.tail
        root = new_root

    # 修改 channel title，追加 Unofficial 标识
    channel = root.find("channel", namespaces=root.nsmap)
    if channel is not None:
        title_elem = channel.find("title", namespaces=root.nsmap)
        if title_elem is not None and title_elem.text:
            original_title = title_elem.text.strip()
            if "[Unofficial" not in original_title:
                title_elem.text = f"{original_title} [Unofficial Transcripts]"
                print(f"   RSS 标题改为: {title_elem.text}")

    processed = pc_state.get("processed", {})
    added = 0

    for item in root.xpath("//item"):
        guid_elem = item.find("guid")
        if guid_elem is None or not guid_elem.text:
            continue
        guid = guid_elem.text.strip()
        if guid not in processed:
            continue

        vtt_filename = processed[guid].get("vtt_filename")
        if not vtt_filename:
            continue

        existing = item.findall(f"{{{ns_uri}}}transcript", namespaces=root.nsmap)
        vtt_url = f"{BASE_URL}/{PODCAST_SLUG}/transcripts/{vtt_filename}"
        if any(e.get("url") == vtt_url for e in existing):
            continue

        t = etree.SubElement(item, f"{{{ns_uri}}}transcript")
        t.set("url", vtt_url)
        t.set("type", "text/vtt")
        t.set("rel", "captions")
        added += 1

    tree = etree.ElementTree(root)
    feed_path = PODCAST_DIR / "feed.xml"
    tree.write(feed_path, pretty_print=True, xml_declaration=True, encoding="utf-8")
    print(f"💾 Feed 已保存 ({added} 个字幕标签): {feed_path}")

    total = pc_state.get("total_processed", 0)
    display_name = f"{PODCAST_SLUG} (Unofficial)"

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{display_name} - Transcripts</title>
<style>
body{{font-family:system-ui,-apple-system,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6;color:#333}}
code{{background:#f4f4f4;padding:2px 6px;border-radius:4px;word-break:break-all}}
a{{color:#0366d6}}
</style>
</head>
<body>
<h1>🎙️ {display_name}</h1>
<p><strong>原 RSS：</strong><a href="{FEED_URL}" target="_blank">{FEED_URL}</a></p>
<p><strong>带字幕 Feed：</strong><br><code><a href="{BASE_URL}/{PODCAST_SLUG}/feed.xml">{BASE_URL}/{PODCAST_SLUG}/feed.xml</a></code></p>
<p>已处理 <strong>{total}</strong> 集（中英双语字幕）。</p>
</body>
</html>"""
    (PODCAST_DIR / "index.html").write_text(html, encoding="utf-8")


def generate_master_index(state):
    podcasts = state.get("podcasts", {})
    items = ""
    for slug, pc in podcasts.items():
        total = pc.get("total_processed", 0)
        display_name = f"{slug} (Unofficial)"
        items += f'<li><a href="{BASE_URL}/{slug}/">{display_name}</a> — 已处理 {total} 集 <small>(<a href="{BASE_URL}/{slug}/feed.xml">Feed</a>)</small></li>\n'

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Podcast Transcripts Hub (Unofficial)</title>
<style>
body{{font-family:system-ui,-apple-system,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6;color:#333}}
a{{color:#0366d6}}
li{{margin:8px 0}}
</style>
</head>
<body>
<h1>🎙️ Podcast Transcripts Hub (Unofficial)</h1>
<p>以下播客均已自动生成中英双语 VTT 字幕（非官方）：</p>
<ul>
{items}</ul>
</body>
</html>"""
    (SITE_DIR / "index.html").write_text(html, encoding="utf-8")


def main():
    if not FEED_URL or not BASE_URL or not PODCAST_SLUG:
        print("❌ 错误：需要设置 PODCAST_SLUG, FEED_URL, BASE_URL")
        sys.exit(1)

    print(f"🎙️ 播客: {PODCAST_SLUG}")
    print(f"📡 RSS: {FEED_URL}")
    print(f"🌐 BASE_URL: {BASE_URL}")
    print(f"🧠 模型: {MODEL_SIZE}")

    state = load_state()
    pc_state = get_podcast_state(state)
    processed = pc_state.get("processed", {})
    print(f"📂 该播客已处理 {pc_state.get('total_processed', 0)} 集")

    feed = feedparser.parse(FEED_URL)
    entries = list(feed.entries)
    if not entries:
        print("⚠️ RSS 无条目")
        sys.exit(0)

    next_entry = find_next_entry(entries, processed)
    if not next_entry:
        print("✅ 该播客全部处理完毕，仅更新 Feed")
        generate_podcast_feed(pc_state)
        generate_master_index(state)
        save_state(state)
        sys.exit(0)

    title = next_entry.get("title", "untitled")
    guid = next_entry.get("guid") or next_entry.get("id") or title
    print(f"\n🎯 本次处理: {title}")

    audio_url = get_audio_url(next_entry)
    if not audio_url:
        print("❌ 未找到音频")
        sys.exit(1)

    safe_title = safe_filename(title)
    mp3_path = PODCAST_DIR / f"{safe_title}.mp3"
    print(f"⬇️ 下载音频...")
    try:
        r = requests.get(audio_url, timeout=300, headers={"User-Agent": "Mozilla/5.0"})
        r.raise_for_status()
        mp3_path.write_bytes(r.content)
        print(f"   {mp3_path.stat().st_size/1024/1024:.1f} MB")
    except Exception as e:
        print(f"❌ 下载失败: {e}")
        sys.exit(1)

    print(f"📝 转录中 ({MODEL_SIZE}, CPU int8, VAD)...")
    try:
        model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
        segments_iter, info = model.transcribe(
            str(mp3_path),
            beam_size=5,
            language="en",
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=300),
            condition_on_previous_text=False,
            initial_prompt="Please punctuate accurately and break sentences naturally.",
            log_prob_threshold=-1.0,
            no_speech_threshold=0.6,
        )

        total_duration = getattr(info, "duration", None)
        segments = []
        for i, seg in enumerate(segments_iter, 1):
            segments.append(seg)
            if i % 10 == 0:
                if total_duration and total_duration > 0:
                    pct = seg.end / total_duration * 100
                    print(f"   转录进度: {pct:.1f}% ({seg.end:.1f}s / {total_duration:.1f}s) | 第 {i} 段")
                else:
                    print(f"   转录进度: {seg.end:.1f}s | 第 {i} 段")

        print(f"   语言: {info.language} ({info.language_probability:.2f})")
        print(f"   共 {len(segments)} 个片段")
    except Exception as e:
        print(f"❌ 转录失败: {e}")
        sys.exit(1)
    finally:
        if mp3_path.exists():
            mp3_path.unlink()

    print(f"✂️  后处理：按句子重新切分 {len(segments)} 个原始片段...")
    sentences = resegment(segments)
    print(f"   合并为 {len(sentences)} 个句子级片段")

    print("🌐 开始翻译（英→中，失败无限重试）...")
    bilingual = translate_sentences(sentences)

    vtt_filename = f"{safe_title}.vtt"
    vtt_path = TRANSCRIPTS_DIR / vtt_filename
    write_bilingual_vtt(bilingual, vtt_path)
    print(f"💾 双语 VTT: {vtt_path.name}")

    processed[guid] = {
        "title": title,
        "vtt_filename": vtt_filename,
        "processed_at": datetime.now(timezone.utc).isoformat(),
        "audio_url": audio_url,
    }
    pc_state["total_processed"] = pc_state.get("total_processed", 0) + 1
    pc_state["updated_at"] = datetime.now(timezone.utc).isoformat()
    save_state(state)

    generate_podcast_feed(pc_state)
    generate_master_index(state)
    print(f"\n✅ 完成！该播客累计 {pc_state['total_processed']} 集")
    print(f"🎧 Feed: {BASE_URL}/{PODCAST_SLUG}/feed.xml")


if __name__ == "__main__":
    main()