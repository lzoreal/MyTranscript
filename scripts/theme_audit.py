"""主题 × 页面截图审计：把 6 套随包主题 × 全部页面在 1440 / 390 两档宽度各拍一遍，
同时收集对比度、过小字号、过小命中区、横向溢出四类指标，输出联系表方便一眼扫全。

用法（仓库根目录）：
    python -m pip install playwright        # 首次，只装 Python 包，不下载浏览器
    python scripts/theme_audit.py           # 默认 6 套主题 × 18 页 × 两种宽度
    python scripts/theme_audit.py --themes liquid-glass,glass2 --widths 1440 --routes home,settings

产物在 .tmp-theme-audit/（已在 .gitignore 的 .tmp-* 规则里）：
    <宽>-<主题>-<页>.png     单页截图
    sheet-<宽>-<主题>.jpg    联系表（6 列）
    audit.json               每页的指标明细

浏览器用的是本机 Edge（channel="msedge"），不额外拉 chromium。
"""
import argparse
import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")
OUT = os.path.join(ROOT, ".tmp-theme-audit")
PORT = 8899
BASE = f"http://127.0.0.1:{PORT}/player.html"

THEMES = [
    ("ct-pack-liquid-glass", "liquid-glass"),
    ("ct-pack-glass2", "glass2"),
    ("ct-pack-minimal-maxi", "minimal-maxi"),
    ("ct-pack-mono-tech", "mono-tech"),
    ("ct-pack-surveillance", "surveillance"),
    ("ct-pack-folia-poster", "folia-poster"),
]

ROUTES = [
    ("home", "#/home"), ("library", "#/library"), ("discover", "#/discover"),
    ("search", "#/search/design"), ("podcast", None), ("episode", None), ("player", None),
    ("local", "#/local"), ("downloads", "#/downloads"), ("inbox", "#/inbox"),
    ("queue", "#/queue"), ("history", "#/history"), ("favorites", "#/favorites"),
    ("bookmarks", "#/bookmarks"), ("notes", "#/notes"), ("listening", "#/listening"),
    ("settings", "#/settings"), ("stats", "#/stats"),
]

# 只查「看得见的页面内容」：对比度只在纯色底上算，渐变/图片底跳过，避免报假阳性
AUDIT_JS = r"""() => {
  const bad = { contrast: [], tinyText: [], smallTarget: [], overflow: [] };
  const vis = el => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const parse = c => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({r, g, b}) => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); };
  const bgOf = el => {
    let n = el;
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      const c = parse(cs.backgroundColor);
      if (c && c.a >= 0.92) return c;
      n = n.parentElement;
    }
    const b = parse(getComputedStyle(document.body).backgroundColor);
    return b && b.a > 0 ? b : parse(getComputedStyle(document.documentElement).backgroundColor);
  };
  const ownText = el => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 0);

  document.querySelectorAll('.page.active *').forEach(el => {
    if (!vis(el)) return;
    if (ownText(el)) {
      const cs = getComputedStyle(el);
      const fs = parseFloat(cs.fontSize);
      const fw = parseInt(cs.fontWeight, 10) || 400;
      const txt = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ').trim();
      if (txt.length > 1) {
        if (fs < 11) bad.tinyText.push({ sel: el.className || el.tagName, fs, txt: txt.slice(0, 30) });
        const fg = parse(cs.color);
        const bg = bgOf(el);
        if (fg && bg && fg.a > 0.6) {
          const large = fs >= 24 || (fs >= 18.66 && fw >= 600);
          const need = large ? 3 : 4.5;
          const ct = ratio(fg, bg);
          if (ct < need) bad.contrast.push({ sel: (el.className || el.tagName).toString().slice(0, 40), fs, ct: +ct.toFixed(2), need, txt: txt.slice(0, 28) });
        }
      }
    }
    if (el.matches('button, a, [role="button"], .ep-row')) {
      const r = el.getBoundingClientRect();
      const label = (el.getAttribute('aria-label') || el.title || el.textContent || '').trim().slice(0, 24);
      if (r.height < 30) bad.smallTarget.push({ sel: (el.className || el.tagName).toString().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height), label });
    }
  });
  const m = document.querySelector('.main');
  if (m && m.scrollWidth - m.clientWidth > 2) bad.overflow.push({ where: 'main', by: m.scrollWidth - m.clientWidth });
  if (document.documentElement.scrollWidth - document.documentElement.clientWidth > 2) bad.overflow.push({ where: 'doc' });
  return bad;
}"""

PROBE = """() => {
  const row = document.querySelector('#page-podcast [data-open-episode]');
  const rows = [...document.querySelectorAll('#page-podcast [data-open-episode]')].slice(0, 12);
  return { key: row ? row.dataset.key : '', eps: rows.map(r => ({ ep: r.dataset.ep, title: (r.querySelector('.ep-title')||{}).textContent || '' })) };
}"""


def load_subs():
    cat = json.load(open(os.path.join(SITE, "catalog.json"), encoding="utf-8"))
    return [{
        "key": s["slug"], "feed": s["feed"], "name": s["name"], "builtin": True,
        "artwork": s.get("artwork", ""), "description": (s.get("description") or "")[:160],
        "addedAt": 1700000000000,
    } for s in cat["shows"][:8]]


def start_server():
    proc = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--directory", SITE, "--bind", "127.0.0.1"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(30):
        time.sleep(0.2)
        try:
            import urllib.request
            urllib.request.urlopen(BASE, timeout=2)
            return proc
        except Exception:
            continue
    return proc


def sheet(paths, out_path, cols=6, tile_w=360):
    from PIL import Image, ImageDraw
    imgs = []
    for p in paths:
        im = Image.open(p).convert("RGB")
        imgs.append((os.path.basename(p)[:-4], im.resize((tile_w, int(im.height * tile_w / im.width)), Image.LANCZOS)))
    rows = (len(imgs) + cols - 1) // cols
    row_h = max(i.height for _, i in imgs) + 18
    out = Image.new("RGB", (cols * tile_w, rows * row_h), (24, 24, 26))
    d = ImageDraw.Draw(out)
    for i, (name, im) in enumerate(imgs):
        x, y = (i % cols) * tile_w, (i // cols) * row_h
        d.text((x + 4, y + 3), name.split("-", 1)[-1], fill=(220, 220, 220))
        out.paste(im, (x, y + 18))
    out.save(out_path, quality=88)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--themes", default="")
    ap.add_argument("--routes", default="")
    ap.add_argument("--widths", default="1440,390")
    ap.add_argument("--no-serve", action="store_true", help="端口上已有站点服务时不再自起 http.server")
    args = ap.parse_args()

    from playwright.sync_api import sync_playwright

    themes = THEMES
    if args.themes:
        want = set(args.themes.split(","))
        themes = [t for t in THEMES if t[1] in want or t[0] in want]
    widths = [int(w) for w in args.widths.split(",")]
    allow = set(args.routes.split(",")) if args.routes else None
    os.makedirs(OUT, exist_ok=True)
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    server = None if args.no_serve else start_server()
    subs = load_subs()
    report = {}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="msedge", headless=True, args=["--force-color-profile=srgb"])
            for width in widths:
                ctx = browser.new_context(viewport={"width": width, "height": 900 if width >= 1000 else 844})
                page = ctx.new_page()
                page.goto(BASE + "#/library")
                page.wait_for_timeout(1200)
                page.evaluate("""(subs) => {
                    localStorage.setItem('myt-ui-ledger', '1');
                    localStorage.setItem('myt-subs', JSON.stringify(subs));
                    const raw = JSON.parse(localStorage.getItem('myt-theme-custom') || '{}');
                    raw.enabled = true;
                    localStorage.setItem('myt-theme-custom', JSON.stringify(raw));
                }""", subs)
                page.reload()
                page.wait_for_timeout(2000)
                page.evaluate("location.hash = '#/home'")
                page.wait_for_timeout(800)
                page.evaluate("location.hash = '#/podcast/' + (JSON.parse(localStorage.getItem('myt-subs'))[0].key)")
                page.wait_for_timeout(1800)
                probe = page.evaluate(PROBE)
                key, eps = probe["key"], probe["eps"]
                if eps:   # 造一份“用过一阵子”的本地状态，让队列/历史/书签页有内容
                    page.evaluate("""({key, eps}) => {
                        const now = Date.now(), prog = {};
                        eps.slice(0, 3).forEach((e, i) => { prog[key + ':' + e.ep] = { t: 600 + i * 240, d: 4200, at: now - i * 3600e3, key }; });
                        localStorage.setItem('myt-progress', JSON.stringify(prog));
                        localStorage.setItem('myt-favorites', JSON.stringify(eps.slice(1, 5).map(e => key + ':' + e.ep)));
                        localStorage.setItem('myt-queue', JSON.stringify(eps.slice(2, 6).map(e => ({ key, ep: e.ep, title: e.title, show: 'Office Ladies', duration: 4200 }))));
                        localStorage.setItem('myt-bookmarks', JSON.stringify([{ key, ep: eps[0].ep, cue: 3, t: 55, text: '片头的来龙去脉。', at: now }]));
                    }""", {"key": key, "eps": eps})
                for tid, name in themes:
                    page.evaluate("id => localStorage.setItem('myt-theme', id)", tid)
                    page.evaluate("location.hash = '#/home'")
                    page.reload()
                    page.wait_for_timeout(1400)
                    for rname, h in ROUTES:
                        if allow and rname not in allow:
                            continue
                        if rname == "podcast":
                            h = f"#/podcast/{key}"
                        elif rname in ("episode", "player"):
                            if not eps:
                                continue
                            h = f"#/{rname}/{key}/{eps[0]['ep']}"
                        page.evaluate("h => { location.hash = h; }", h)
                        page.wait_for_timeout(900)
                        page.evaluate("(() => { const m = document.querySelector('.main'); if (m) { m.scrollTop = 0; m.scrollLeft = 0; } })()")
                        shot = os.path.join(OUT, f"{width}-{name}-{rname}.png")
                        page.screenshot(path=shot)
                        report[f"{width}-{name}-{rname}"] = {
                            "theme": page.evaluate("document.documentElement.dataset.theme"),
                            "page": page.evaluate("((document.querySelector('.page.active') || {}).id || '')"),
                            "metrics": page.evaluate(AUDIT_JS),
                        }
                print(f"[done] width={width}", flush=True)
                ctx.close()
            browser.close()
    finally:
        if server:
            server.terminate()

    json.dump(report, open(os.path.join(OUT, "audit.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    for width in widths:
        for _, name in themes:
            paths = [os.path.join(OUT, f"{width}-{name}-{r}.png") for r, _ in ROUTES
                     if (not allow or r in allow) and os.path.exists(os.path.join(OUT, f"{width}-{name}-{r}.png"))]
            if paths:
                sheet(paths, os.path.join(OUT, f"sheet-{width}-{name}.jpg"))

    contrast = sum(len(v["metrics"]["contrast"]) for v in report.values())
    tiny = sum(len(v["metrics"]["tinyText"]) for v in report.values())
    small = sum(len(v["metrics"]["smallTarget"]) for v in report.values())
    over = sum(len(v["metrics"]["overflow"]) for v in report.values())
    print(f"pages={len(report)} contrast={contrast} tiny={tiny} smallTarget={small} overflow={over} -> {OUT}")


if __name__ == "__main__":
    main()
