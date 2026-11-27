//! 视频同源代理：`http://mytmedia.localhost/?u=<远端地址>`
//!
//! 为什么需要：播放器里 `<video>` 直接指向 libsyn 的 mp4，响应里没有 CORS 头，
//! `createMediaElementSource` 拿到的音频会被浏览器判定为“被污染”的静默流，
//! 于是边看边转写拿不到 PCM。把画面改走本进程代理后，视频与页面同源
//! （并显式回 `Access-Control-Allow-Origin`），AudioWorklet 就能取到真实采样。
//!
//! 三个约束：
//! - 只做 GET / HEAD，只透传 http(s)，不做 https 卸载（rustls 走 reqwest）。
//! - 每次最多回 [`MAX_SLICE`]，靠 206 + Content-Range 让浏览器自己续着拉；
//!   整段 381MB 一次性塞进内存会直接被打爆。
//! - 落盘缓存按 URL 哈希命名，同一个 URL 的切片不重复下载（重复观看不再走网络）。

use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use reqwest::header::{
    ACCEPT, ACCEPT_RANGES, ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_ALLOW_HEADERS,
    ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_EXPOSE_HEADERS, CACHE_CONTROL, CONTENT_LENGTH,
    CONTENT_RANGE, CONTENT_TYPE, RANGE, USER_AGENT,
};
use sha2::{Digest, Sha256};
use std::time::Duration;
use tauri::http::{Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};
use tokio::time::sleep;

/// 单次响应的上限：8MB 够浏览器播好几秒，也不会把内存顶起来。
const MAX_SLICE: u64 = 8 * 1024 * 1024;
/// 封面整张进内存的上限：再大就不该整张缓存，退回直连。
const IMG_MAX: u64 = 16 * 1024 * 1024;
/// 封面请求用浏览器 UA：不少播客 CDN 对非浏览器 UA 直接回 403。
const IMG_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("MyTranscript/desktop media proxy")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        let resp = match request.method().as_str() {
            "OPTIONS" => empty(StatusCode::NO_CONTENT),
            "GET" | "HEAD" => serve(app, request).await,
            _ => empty(StatusCode::METHOD_NOT_ALLOWED),
        };
        responder.respond(resp);
    });
}

async fn serve<R: Runtime>(app: tauri::AppHandle<R>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let target = match query_url(request.uri().query()) {
        Some(url) => url,
        None => return text(StatusCode::BAD_REQUEST, "缺少 u= 参数"),
    };
    if !(target.starts_with("http://") || target.starts_with("https://")) {
        return text(StatusCode::BAD_REQUEST, "只代理 http(s) 地址");
    }
    // 封面模式：整张取回并按 URL 落盘，命中就不出网（二次启动零远端请求）。
    // `w=320` 让壳把封面按宽度缩一次再进浏览器：海报墙上 3000×3000 的原图
    // 显示出来只有 195px，却要占 ~34MB 位图 + 同样大的纹理，几十张就是几百 MB。
    if query_flag(request.uri().query(), "img") {
        let want_w = query_num(request.uri().query(), "w").filter(|w| (16..=1600).contains(w));
        return serve_image(app, target, want_w).await;
    }
    let meta_dir = match cache_dir(&app) {
        Some(dir) => dir,
        None => return text(StatusCode::INTERNAL_SERVER_ERROR, "拿不到缓存目录"),
    };
    let key = cache_key(&target);
    let meta = read_meta(&meta_dir, &key);
    let total = match meta {
        Some(m) => m.total,
        None => match probe(&target).await {
            Ok(m) => {
                let _ = write_meta(&meta_dir, &key, &m);
                m.total
            }
            Err(err) => return text(StatusCode::BAD_GATEWAY, &err),
        },
    };
    let (start, end, partial) = match parse_range(request.headers().get(RANGE), total) {
        Some(spec) => spec,
        None => return text(StatusCode::RANGE_NOT_SATISFIABLE, "范围超出长度"),
    };
    let ctype = read_meta(&meta_dir, &key).map(|m| m.ctype).unwrap_or_else(|| "video/mp4".into());
    let path = meta_dir.join(format!("{key}.bin"));
    let want = end - start + 1;

    let body: Vec<u8> = match read_cached(&path, start, want) {
        Some(bytes) => bytes,
        None => match fetch_slice(&target, start, end).await {
            Ok(bytes) => {
                // 缓存写失败不影响这次播放：能播就行。
                let _ = write_cached(&path, start, &bytes);
                bytes
            }
            Err(err) => return text(StatusCode::BAD_GATEWAY, &err),
        },
    };
    let last = start + body.len() as u64;
    let last = if last == 0 { 0 } else { last - 1 };
    let mut builder = Response::builder()
        .status(if partial || (start > 0) || last + 1 < total {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(ACCEPT_RANGES, "bytes")
        .header(ACCESS_CONTROL_EXPOSE_HEADERS, "content-range, content-length, accept-ranges")
        .header(CACHE_CONTROL, "public, max-age=3600")
        .header(CONTENT_TYPE, ctype)
        .header(CONTENT_LENGTH, body.len().to_string());
    if total > 0 {
        builder = builder.header(CONTENT_RANGE, format!("bytes {start}-{last}/{total}"));
    }
    builder.body(body).unwrap_or_else(|_| text(StatusCode::INTERNAL_SERVER_ERROR, "响应构建失败"))
}

struct Meta {
    total: u64,
    ctype: String,
}

/// 封面：一次取整张，同一 URL 之后只读磁盘。缓存键与切片缓存同一套哈希，
/// `<key>.bin` 里就是完整图片、`<key>.json` 里是长度与 Content-Type。
async fn serve_image<R: Runtime>(
    app: tauri::AppHandle<R>,
    target: String,
    want_w: Option<u32>,
) -> Response<Vec<u8>> {
    let dir = match cache_dir(&app) {
        Some(dir) => dir,
        None => return text(StatusCode::INTERNAL_SERVER_ERROR, "拿不到缓存目录"),
    };
    // 缩放结果要有自己的缓存键，否则第二次要原图时会拿到缩略版（全屏封面糊成一片）。
    let key = match want_w {
        Some(w) => cache_key(&format!("{target}#w={w}")),
        None => cache_key(&target),
    };
    let path = dir.join(format!("{key}.bin"));
    if let Some(meta) = read_meta(&dir, &key) {
        if meta.total > 0 {
            if let Ok(bytes) = fs::read(&path) {
                if bytes.len() as u64 == meta.total {
                    return image_ok(bytes, &meta.ctype);
                }
            }
        }
    }
    // 没命中（首次或缓存残片）：抓整张，连接被掐这类瞬时失败给两次重试。
    let mut last = String::new();
    for attempt in 0..3u32 {
        match fetch_image(&target).await {
            Ok((bytes, ctype)) => {
                let mut body = bytes;
                let mut kind = ctype;
                if let Some(w) = want_w {
                    if let Some((small, small_kind)) = shrink_image(&body, w) {
                        body = small;
                        kind = small_kind;
                    }
                }
                let meta = Meta { total: body.len() as u64, ctype: kind.clone() };
                let _ = fs::write(&path, &body);
                let _ = write_meta(&dir, &key, &meta);
                return image_ok(body, &kind);
            }
            Err(err) => {
                last = err;
                if attempt < 2 {
                    sleep(Duration::from_millis(300 * (attempt as u64 + 1))).await;
                }
            }
        }
    }
    // 让前端 onerror 回落到直连地址，而不是把封面永久丢掉。
    text(StatusCode::BAD_GATEWAY, &last)
}

/// 按宽度缩封面。解码失败（avif/webp 之类的少见编码）就返回 `None`，
/// 调用方照旧发原图——缩略是优化，不是正确性依赖。
fn shrink_image(bytes: &[u8], want: u32) -> Option<(Vec<u8>, String)> {
    use image::imageops::FilterType;
    let img = image::load_from_memory(bytes).ok()?;
    if img.width() <= want {
        return None;
    }
    let w = want;
    let h = ((img.height() as f64) * (w as f64) / (img.width() as f64)).round().max(1.0) as u32;
    let small = img.resize_exact(w, h.max(1), FilterType::Triangle);
    let alpha = small.color().has_alpha();
    let fmt = if alpha { image::ImageFormat::Png } else { image::ImageFormat::Jpeg };
    let mut out = Vec::new();
    small.write_to(&mut std::io::Cursor::new(&mut out), fmt).ok()?;
    if out.is_empty() {
        return None;
    }
    let kind = if alpha { "image/png" } else { "image/jpeg" };
    Some((out, kind.to_string()))
}

async fn fetch_image(url: &str) -> Result<(Vec<u8>, String), String> {
    let resp = client()
        .get(url)
        .header(USER_AGENT, IMG_UA)
        .header(ACCEPT, "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5")
        .timeout(Duration::from_secs(12))
        .send()
        .await
        .map_err(|e| format!("下载失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("远端返回 {}", resp.status()));
    }
    let ctype = header_str(&resp, CONTENT_TYPE, "image/jpeg");
    let bytes = resp.bytes().await.map_err(|e| format!("读取失败：{e}"))?;
    if bytes.is_empty() {
        return Err("远端返回空内容".into());
    }
    if bytes.len() as u64 > IMG_MAX {
        return Err(format!("封面过大（{} 字节）", bytes.len()));
    }
    Ok((bytes.to_vec(), ctype))
}

fn image_ok(bytes: Vec<u8>, ctype: &str) -> Response<Vec<u8>> {
    cors(Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, ctype.to_string())
        .header(CONTENT_LENGTH, bytes.len().to_string())
        // 本地缓存已经命中过一次，浏览器这层再长缓存就没有意义地重复读盘。
        .header(CACHE_CONTROL, "public, max-age=2592000"))
        .body(bytes)
        .unwrap_or_else(|_| text(StatusCode::INTERNAL_SERVER_ERROR, "响应构建失败"))
}

fn cache_dir<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    let base = app.path().app_local_data_dir().ok()?.join("media-cache");
    fs::create_dir_all(&base).ok()?;
    Some(base)
}

/// 给宿主侧旁路转写用：拿同一个缓存目录，读已经下过的切片不重复走网络。
pub fn cache_dir_for<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    cache_dir(app)
}

/// 同一套哈希：代理写 `<key>.bin`，旁路转写写 `<key>.asr.bin`，前缀可以互相复用。
pub fn key_for(url: &str) -> String {
    cache_key(url)
}

/// 远端总长 + 类型；代理已经探过的直接读 meta，省一次 HEAD。
pub async fn meta_for<R: Runtime>(app: &tauri::AppHandle<R>, url: &str) -> Result<(u64, String), String> {
    if let Some(dir) = cache_dir(app) {
        if let Some(m) = read_meta(&dir, &key_for(url)) {
            if m.total > 0 {
                return Ok((m.total, m.ctype));
            }
        }
    }
    probe(url).await.map(|m| (m.total, m.ctype))
}

/// 拉一段字节（闭区间），给续传用。
pub async fn fetch_bytes(url: &str, start: u64, end: u64) -> Result<Vec<u8>, String> {
    fetch_slice(url, start, end).await
}

fn cache_key(url: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(url.as_bytes());
    let digest = hasher.finalize();
    let hex: String = digest.iter().take(16).map(|b| format!("{:02x}", b)).collect();
    let ext = url
        .split('?')
        .next()
        .and_then(|u| u.rsplit('.').next())
        .filter(|e| e.len() <= 4 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or("bin");
    format!("{hex}.{ext}")
}

fn meta_path(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{key}.json"))
}

fn read_meta(dir: &Path, key: &str) -> Option<Meta> {
    let raw = fs::read_to_string(meta_path(dir, key)).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    Some(Meta {
        total: v.get("total").and_then(|x| x.as_u64()).unwrap_or(0),
        ctype: v.get("ctype").and_then(|x| x.as_str()).unwrap_or("video/mp4").to_string(),
    })
}

fn write_meta(dir: &Path, key: &str, meta: &Meta) -> std::io::Result<()> {
    let body = serde_json::json!({ "total": meta.total, "ctype": meta.ctype });
    fs::write(meta_path(dir, key), body.to_string())
}

async fn probe(url: &str) -> Result<Meta, String> {
    // libsyn 这类源对 HEAD 不一定给长度（甚至直接 403），所以先试 HEAD，拿不到再
    // 用 `Range: bytes=0-0` 探一次，从 `Content-Range: bytes 0-0/12345` 反推总长。
    if let Ok(resp) = client().head(url).send().await {
        if resp.status().is_success() {
            let ctype = header_str(&resp, CONTENT_TYPE, "video/mp4");
            if let Some(total) = resp.content_length().or_else(|| total_from_range(&resp)) {
                if total > 0 {
                    return Ok(Meta { total, ctype });
                }
            }
        }
    }
    let resp = client()
        .get(url)
        .header(RANGE, "bytes=0-0")
        .send()
        .await
        .map_err(|e| format!("探测失败：{e}"))?;
    let ctype = header_str(&resp, CONTENT_TYPE, "video/mp4");
    if let Some(total) = total_from_range(&resp).or_else(|| resp.content_length()) {
        if total > 0 {
            return Ok(Meta { total, ctype });
        }
    }
    Err(format!("远端没有给长度（HTTP {}）", resp.status()))
}

fn header_str(resp: &reqwest::Response, name: reqwest::header::HeaderName, fallback: &str) -> String {
    resp.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or(fallback)
        .to_string()
}

fn total_from_range(resp: &reqwest::Response) -> Option<u64> {
    resp.headers()
        .get(CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.rsplit('/').next())
        .and_then(|v| v.parse::<u64>().ok())
}

fn parse_range(header: Option<&tauri::http::HeaderValue>, total: u64) -> Option<(u64, u64, bool)> {
    // 返回 (start, end, 是否只回了片段)；None 表示越界。end 会被 MAX_SLICE 截断。
    if total == 0 {
        return None;
    }
    let raw = header.and_then(|v| v.to_str().ok()).unwrap_or("");
    let spec = raw.strip_prefix("bytes=").unwrap_or("");
    let first = spec.split(',').next().unwrap_or("").trim();
    let (s, e) = match first.split_once('-') {
        Some(pair) => pair,
        None => {
            let end = total.saturating_sub(1).min(MAX_SLICE - 1);
            return Some((0, end, true));
        }
    };
    let start = s.parse::<u64>().unwrap_or(0);
    if start >= total {
        return None;
    }
    let mut end = e.parse::<u64>().unwrap_or(total.saturating_sub(1));
    if end >= total {
        end = total - 1;
    }
    if end < start {
        end = start;
    }
    // 一次别给太多：浏览器会按 Content-Range 继续要。
    if end - start + 1 > MAX_SLICE {
        end = start + MAX_SLICE - 1;
    }
    Some((start, end, true))
}

async fn fetch_slice(url: &str, start: u64, end: u64) -> Result<Vec<u8>, String> {
    let resp = client()
        .get(url)
        .header(RANGE, format!("bytes={start}-{end}"))
        .send()
        .await
        .map_err(|e| format!("下载失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("远端返回 {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("读取失败：{e}"))?;
    Ok(bytes.to_vec())
}

fn read_cached(path: &Path, start: u64, want: u64) -> Option<Vec<u8>> {
    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len < start + want {
        return None;
    }
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = vec![0u8; want as usize];
    file.read_exact(&mut buf).ok()?;
    Some(buf)
}

fn write_cached(path: &Path, start: u64, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)?;
    file.seek(SeekFrom::Start(start))?;
    file.write_all(bytes)?;
    Ok(())
}

fn query_url(query: Option<&str>) -> Option<String> {
    let query = query?;
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=')?;
        if name == "u" {
            return Some(percent_decode(value));
        }
    }
    None
}

fn query_flag(query: Option<&str>, flag: &str) -> bool {
    let Some(query) = query else { return false };
    query.split('&').any(|pair| {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        name == flag && !value.is_empty() && value != "0"
    })
}

fn query_num(query: Option<&str>, key: &str) -> Option<u32> {
    let query = query?;
    for pair in query.split('&') {
        let Some((name, value)) = pair.split_once('=') else { continue };
        if name == key {
            return value.parse::<u32>().ok();
        }
    }
    None
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(h) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(h);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn cors(builder: tauri::http::response::Builder) -> tauri::http::response::Builder {
    builder
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
        .header(ACCESS_CONTROL_ALLOW_HEADERS, "range")
}

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    cors(Response::builder().status(status))
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn text(status: StatusCode, msg: &str) -> Response<Vec<u8>> {
    cors(Response::builder().status(status).header(CONTENT_TYPE, "text/plain; charset=utf-8"))
        .body(msg.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::http::HeaderValue;

    fn hv(raw: &str) -> HeaderValue {
        HeaderValue::from_str(raw).unwrap()
    }

    #[test]
    fn range_closed_and_capped() {
        let (s, e, part) = parse_range(Some(&hv("bytes=0-1023")), 5000).unwrap();
        assert_eq!((s, e, part), (0, 1023, true));
    }

    #[test]
    fn range_open_ends_is_capped() {
        let (s, e, _) = parse_range(Some(&hv("bytes=100-")), 20_000_000).unwrap();
        assert_eq!(s, 100);
        assert_eq!(e, 100 + MAX_SLICE - 1);
    }

    #[test]
    fn range_beyond_total_is_none() {
        assert!(parse_range(Some(&hv("bytes=9000-")), 1000).is_none());
    }

    #[test]
    fn range_absent_is_first_slice() {
        let (s, e, part) = parse_range(None, 10_000).unwrap();
        assert_eq!((s, part), (0, true));
        assert_eq!(e, 9_999);
    }

    #[test]
    fn url_query_decodes() {
        let url = "https%3A%2F%2Frss.libsyn.com%2Fa.mp4%3Fx%3D1";
        assert_eq!(query_url(Some("u=")).as_deref(), Some(""));
        assert_eq!(
            query_url(Some(&format!("u={url}"))).as_deref(),
            Some("https://rss.libsyn.com/a.mp4?x=1")
        );
    }
}
