"""探测某个地区的代理池：数量、GeoIP 出口分布、能否真的拉到音频。

只读，不写仓库。用法（CI 里由 proxy-probe.yml 调用）：
  python scripts/probe_proxies.py --region au --sample 40 \
      --url https://pdst.fm/e/traffic.megaphone.fm/GLT2909363211.mp3
"""

import argparse
import sys
import tempfile
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

try:
    import faster_whisper  # noqa: F401
except ImportError:
    import types

    stub = types.ModuleType("faster_whisper")
    stub.WhisperModel = object
    sys.modules["faster_whisper"] = stub

try:
    from google import genai  # noqa: F401
except ImportError:
    import types

    google = types.ModuleType("google")
    genai_module = types.ModuleType("google.genai")
    genai_types = types.ModuleType("google.genai.types")

    class _Config:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    genai_types.GenerateContentConfig = _Config
    genai_module.Client = object
    genai_module.types = genai_types
    google.genai = genai_module
    sys.modules["google"] = google
    sys.modules["google.genai"] = genai_module
    sys.modules["google.genai.types"] = genai_types

sys.path.insert(0, str(Path(__file__).resolve().parent))
import transcribe as T  # noqa: E402

DEFAULT_URL = "https://pdst.fm/e/traffic.megaphone.fm/GLT2909363211.mp3"


def audio_ok(proxy: str, url: str) -> str:
    try:
        with T.requests.get(
            url,
            timeout=(8, 15),
            headers={"User-Agent": T.PROXY_HEADERS["User-Agent"], "Accept": "audio/mpeg,*/*"},
            proxies={"http": proxy, "https": proxy},
            allow_redirects=True,
            stream=True,
            verify=not T.is_tls_proxy(proxy),
        ) as response:
            read = 0
            for chunk in response.iter_content(65536):
                read += len(chunk)
                if read >= 65536:
                    break
            kind = (response.headers.get("Content-Type") or "")[:16]
            return f"{response.status_code} {kind}".strip()
    except Exception as exc:
        return type(exc).__name__


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", default="au")
    parser.add_argument("--sample", type=int, default=40)
    parser.add_argument("--url", default=DEFAULT_URL)
    args = parser.parse_args()

    region = args.region.strip().lower()
    url = args.url.strip() or DEFAULT_URL
    T.PROXY_CACHE_FILE = Path(tempfile.gettempdir()) / f"probe-cache-{region}.json"
    started = time.time()
    pool = T.get_china_proxies([region])
    print(f"地区 {region.upper()}，代理池 {len(pool)} 个（{round(time.time() - started, 1)}s）")

    sample = pool[: args.sample]
    with ThreadPoolExecutor(max_workers=24) as executor:
        geo = list(executor.map(T.get_proxy_geoip, sample))
    countries = Counter(
        (info or {}).get("country_code") or "失败" for info in geo
    )
    print("GeoIP 抽样", len(sample), ":", countries.most_common())
    matched = [proxy for proxy, info in zip(sample, geo)
               if info and (info.get("country_code") or "").upper() == region.upper()]
    print(f"出口在 {region.upper()} 的 {len(matched)} 个，开始拉音频：{url[:80]}")

    results = []
    with ThreadPoolExecutor(max_workers=16) as executor:
        for proxy, outcome in zip(matched, executor.map(lambda p: audio_ok(p, url), matched)):
            results.append((proxy, outcome))
            print(f"  {proxy:<36} {outcome}")
    success = [row for row in results if row[1].startswith(("200", "206"))]
    print(f"音频成功 {len(success)}/{len(results)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
