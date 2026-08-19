import os
import sys
import json
import time
import feedparser
import requests
from datetime import datetime, timezone
from faster_whisper import WhisperModel
from pathlib import Path
from lxml import etree

FEED_URL = os.environ.get("FEED_URL")
MODEL_SIZE = os.environ.get("WHISPER_MODEL", "base")
BASE_URL = os.environ.get("BASE_URL", "").rstrip("/")

STATE_FILE = Path("state.json")
SITE_DIR = Path("site")
TRANSCRIPTS_DIR = SITE_DIR / "transcripts"
SITE_DIR.mkdir(exist_ok=True)
TRANSCRIPTS_DIR.mkdir(exist_ok=True)

def load_state():
    if STATE_FILE.exists():
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"processed": {}, "total_processed": 0, "updated_at": None}

def save_state(state):
    state["updated_at"] = datetime.now(timezone.utc).isoformat()
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)

def safe_filename(title):
    keep = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_. "
    return "".join(c if c in keep else "_" for c in title).strip().replace(" ", "_")[:80]

def format_vtt_time(seconds):
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int((seconds % 1) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{millis:03d}"

def write_bilingual_vtt(translated_pairs, path):
    with open(path, "w", encoding="utf-8") as f:
        f.write("WEBVTT\n\n")
        for seg, zh in translated_pairs:
            start = format_vtt_time(seg.start)
            end = format_vtt_time(seg.end)
            en_text = seg.text.strip().replace("\n", " ")
            zh_text = zh.strip().replace("\n", " ")
            f.write(f"{start} --> {end}\n{en_text}\n{zh_text}\n\n")

def translate_with_retry(text, translator, max_retries=0, base_delay=1.0):
    """
    翻译单段文本，失败则 sleep 重试直到成功。
    max_retries=0 表示无限重试。
    """
    attempt = 0
    while True:
        try:
            result = translator.translate(text)
            return result
        except Exception as e:
            attempt += 1
            sleep_time = base_delay * (1.5 ** min(attempt, 10))  # 指数退避，上限约 30s
            print(f"   ⚠️ 翻译失败（第 {attempt} 次）: {e}, sleep {sleep_time:.1f}s 后重试...")
            time.sleep(sleep_time)

def translate_segments(segments):
    """逐段英译中，失败无限重试直到全部成功"""
    from deep_translator import GoogleTranslator
    translator = GoogleTranslator(source="en", target="zh-CN")

    results = []
    total = len(segments)
    for i, seg in enumerate(segments, 1):
        text = seg.text.strip()
        if not text:
            results.append((seg, ""))
            continue
        zh = translate_with_retry(text, translator)
        if i % 20 == 0 or i == total:
            print(f"   翻译进度: {i}/{total}")
        results.append((seg, zh))
    return results

def get_audio_url(entry):
    for enc in entry.get("enclosures", []):
        href = enc.get("href", "")
        type_ = enc.get("type", "")
        if "audio" in type_ or href.endswith((".mp3", ".m4a", ".wav")):
            return href
    return None

def find_next_entry(entries, state):
    processed = set(state.get("processed", {}).keys())
    def sort_key(e):
        t = e.get("published_parsed") or e.get("updated_parsed") or time.gmtime(0)
        return time.mktime(t)
    entries.sort(key=sort_key)
    for entry in entries:
        guid = entry.get("guid") or entry.get("id") or entry.get("title")
        if guid not in processed:
            return entry
    return None

def generate_feed(state):
    print("🔄 生成带字幕的新 RSS feed...")
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
    
    channel = root.find("channel", namespaces=root.nsmap)
    if channel is None:
        print("⚠️ 未找到 channel")
        return
    
    processed = state.get("processed", {})
    added = 0
    
    for item in channel.findall("item", namespaces=root.nsmap):
        guid_elem = item.find("guid", namespaces=root.nsmap)
        if guid_elem is None or not guid_elem.text:
            continue
        guid = guid_elem.text.strip()
        
        if guid not in processed:
            continue
        
        info = processed[guid]
        vtt_filename = info.get("vtt_filename")
        if not vtt_filename:
            continue
        
        # 检查是否已注入，避免重复
        existing = item.findall(f"{{{ns_uri}}}transcript", namespaces=root.nsmap)
        vtt_url = f"{BASE_URL}/transcripts/{vtt_filename}"
        already_injected = any(e.get("url") == vtt_url for e in existing)
        
        if not already_injected:
            t = etree.SubElement(item, f"{{{ns_uri}}}transcript")
            t.set("url", vtt_url)
            t.set("type", "text/vtt")
            t.set("rel", "captions")
            added += 1
    
    tree = etree.ElementTree(root)
    feed_path = SITE_DIR / "feed.xml"
    tree.write(feed_path, pretty_print=True, xml_declaration=True, encoding="utf-8")
    print(f"💾 Feed 已保存 ({added} 个字幕标签): {feed_path}")
    
    total = state.get("total_processed", 0)
    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Podcast Transcripts</title>
<style>
body{{font-family:system-ui,-apple-system,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6;color:#333}}
code{{background:#f4f4f4;padding:2px 6px;border-radius:4px;word-break:break-all}}
a{{color:#0366d6}}
li{{margin:6px 0}}
</style>
</head>
<body>
<h1>🎙️ 自动字幕播客 Feed</h1>
<p><strong>原播客 RSS：</strong><a href="{FEED_URL}" target="_blank">{FEED_URL}</a></p>
<p><strong>带字幕新 Feed：</strong><br><code><a href="feed.xml">{BASE_URL}/feed.xml</a></code></p>
<p>基于 <a href="https://podcastindex.org/namespace/1.0" target="_blank">Podcast Index namespace</a> 的 <code>&lt;podcast:transcript&gt;</code> 标准注入 VTT 字幕。</p>
<p>已处理 <strong>{total}</strong> 集。每集提供中英双语字幕（英文原文 + 中文翻译）。</p>
</body>
</html>"""
    (SITE_DIR / "index.html").write_text(html, encoding="utf-8")

def main():
    if not FEED_URL or not BASE_URL:
        print("❌ 错误：需要设置 FEED_URL 和 BASE_URL")
        sys.exit(1)
    
    print(f"🎙️ RSS: {FEED_URL}")
    print(f"🌐 Pages: {BASE_URL}")
    print(f"🧠 模型: {MODEL_SIZE}")
    
    state = load_state()
    print(f"📂 已处理 {state.get('total_processed', 0)} 集")
    
    feed = feedparser.parse(FEED_URL)
    entries = list(feed.entries)
    if not entries:
        print("⚠️ RSS 无条目")
        sys.exit(0)
    
    next_entry = find_next_entry(entries, state)
    if not next_entry:
        print("✅ 全部处理完毕，仅更新 Feed")
        generate_feed(state)
        sys.exit(0)
    
    title = next_entry.get("title", "untitled")
    guid = next_entry.get("guid") or next_entry.get("id") or title
    print(f"\n🎯 本次处理: {title}")
    
    audio_url = get_audio_url(next_entry)
    if not audio_url:
        print("❌ 未找到音频")
        sys.exit(1)
    
    safe_title = safe_filename(title)
    mp3_path = SITE_DIR / f"{safe_title}.mp3"
    print(f"⬇️ 下载音频...")
    try:
        r = requests.get(audio_url, timeout=300, headers={"User-Agent": "Mozilla/5.0"})
        r.raise_for_status()
        mp3_path.write_bytes(r.content)
        print(f"   {mp3_path.stat().st_size/1024/1024:.1f} MB")
    except Exception as e:
        print(f"❌ 下载失败: {e}")
        sys.exit(1)
    
    print(f"📝 转录中 ({MODEL_SIZE}, CPU int8)...")
    try:
        model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
        segments, info = model.transcribe(str(mp3_path), beam_size=5, language="en")
        segments = list(segments)
        print(f"   语言: {info.language} ({info.language_probability:.2f})")
    except Exception as e:
        print(f"❌ 转录失败: {e}")
        if mp3_path.exists():
            mp3_path.unlink()
        sys.exit(1)
    finally:
        if mp3_path.exists():
            mp3_path.unlink()
    
    # 翻译并保存双语 VTT（唯一输出）
    print("🌐 开始翻译（英→中，失败无限重试）...")
    translated = translate_segments(segments)
    
    vtt_filename = f"{safe_title}.vtt"
    vtt_path = TRANSCRIPTS_DIR / vtt_filename
    write_bilingual_vtt(translated, vtt_path)
    print(f"💾 双语 VTT: {vtt_path.name}")
    
    # 更新状态
    state["processed"][guid] = {
        "title": title,
        "vtt_filename": vtt_filename,
        "processed_at": datetime.now(timezone.utc).isoformat(),
        "audio_url": audio_url,
    }
    state["total_processed"] = state.get("total_processed", 0) + 1
    save_state(state)
    
    generate_feed(state)
    print(f"\n✅ 完成！累计 {state['total_processed']} 集")
    print(f"🎧 新 Feed: {BASE_URL}/feed.xml")

if __name__ == "__main__":
    main()