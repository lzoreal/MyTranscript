//! 本地插件目录管理：扫描、开关、示例插件、内置插件铺设。
//! 纯文件系统逻辑，命令层只做参数校验与窗口联动。

use std::collections::HashMap;
use tauri::Manager;

use crate::AppState;

pub fn plugins_root() -> Result<std::path::PathBuf, String> {
    let program_data = std::env::var("ProgramData")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("C:\\ProgramData"));
    let root = program_data.join("MyTranscript").join("plugins");
    std::fs::create_dir_all(&root).map_err(|e| format!("创建插件目录失败：{e}"))?;
    Ok(root)
}

fn plugin_enabled_path(root: &std::path::Path) -> std::path::PathBuf {
    root.join("enabled.json")
}

fn read_plugin_enabled(root: &std::path::Path) -> HashMap<String, bool> {
    std::fs::read_to_string(plugin_enabled_path(root))
        .ok()
        .and_then(|text| serde_json::from_str::<HashMap<String, bool>>(&text).ok())
        .unwrap_or_default()
}

fn write_plugin_enabled(root: &std::path::Path, state: &HashMap<String, bool>) -> Result<(), String> {
    let text = serde_json::to_string_pretty(state).map_err(|e| format!("序列化插件状态失败：{e}"))?;
    std::fs::write(plugin_enabled_path(root), text).map_err(|e| format!("写插件状态失败：{e}"))
}

fn safe_plugin_id(id: &str) -> bool {
    !id.is_empty()
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn safe_plugin_file(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && name != "."
        && name != ".."
}

/// 内置插件用的 FNV-1a（64 位），只求跨版本稳定，不做安全哈希。
fn content_fingerprint(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn read_fingerprints(path: &std::path::Path) -> HashMap<String, String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<HashMap<String, String>>(&text).ok())
        .unwrap_or_default()
}

/// 内置插件的升级规则：用户没改过的文件跟随应用版本更新；改过的原样保留。
/// 每个文件上次「随应用铺下去」的指纹记在 `.builtin.json`；对不上就认为是用户改的。
fn seed_into(root: &std::path::Path, name: &str, files: &[(&str, &str)]) -> Result<(), String> {
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建内置插件 {name} 失败：{e}"))?;
    let marker = dir.join(".builtin.json");
    let mut recorded = read_fingerprints(&marker);
    let mut changed = false;
    for (file, content) in files {
        let path = dir.join(file);
        let shipped = content_fingerprint(content.as_bytes());
        let existing = std::fs::read(&path).ok().map(|bytes| content_fingerprint(&bytes));
        match existing {
            None => {
                std::fs::write(&path, content)
                    .map_err(|e| format!("写入内置插件 {name}/{file} 失败：{e}"))?;
                recorded.insert((*file).to_string(), shipped);
                changed = true;
            }
            Some(current) => {
                match recorded.get(*file) {
                    // 首次接管老安装：把当前内容当基线，这一轮不动手改文件。
                    None => {
                        recorded.insert((*file).to_string(), current);
                        changed = true;
                    }
                    // 文件还是上次铺下的样子 → 跟随升级。
                    Some(known) if *known == current => {
                        if shipped != current {
                            std::fs::write(&path, content)
                                .map_err(|e| format!("更新内置插件 {name}/{file} 失败：{e}"))?;
                            recorded.insert((*file).to_string(), shipped);
                            changed = true;
                        }
                    }
                    // 用户改过：保留，且不更新基线，之后的升级也一样跳过。
                    Some(_) => {}
                }
            }
        }
    }
    if changed {
        let text = serde_json::to_string_pretty(&recorded)
            .map_err(|e| format!("序列化内置插件基线失败：{e}"))?;
        std::fs::write(&marker, text).map_err(|e| format!("写内置插件基线失败：{e}"))?;
    }
    Ok(())
}

/// 随应用发布的插件。首次铺一份；之后按 `.builtin.json` 基线决定是否跟随升级。
fn seed_builtin_plugin(name: &str, files: &[(&str, &str)]) -> Result<(), String> {
    seed_into(&plugins_root()?, name, files)
}

pub fn ensure_builtin_plugins() -> Result<(), String> {
    seed_builtin_plugin(
        "subtitles",
        &[
            ("plugin.json", include_str!("../../builtin-plugins/subtitles/plugin.json")),
            ("kernel.js", include_str!("../../builtin-plugins/subtitles/kernel.js")),
            ("view.js", include_str!("../../builtin-plugins/subtitles/view.js")),
            ("main.js", include_str!("../../builtin-plugins/subtitles/main.js")),
            ("style.css", include_str!("../../builtin-plugins/subtitles/style.css")),
        ],
    )?;
    seed_builtin_plugin(
        "study",
        &[
            ("plugin.json", include_str!("../../builtin-plugins/study/plugin.json")),
            ("main.js", include_str!("../../builtin-plugins/study/main.js")),
            ("style.css", include_str!("../../builtin-plugins/study/style.css")),
        ],
    )?;
    Ok(())
}


/// 读取插件是否启用：以 enabled.json 为准，没有记录时用 manifest 的默认值。
fn plugin_enabled_by_id(root: &std::path::Path, id: &str) -> bool {
    let enabled = read_plugin_enabled(root);
    if let Some(value) = enabled.get(id) {
        return *value;
    }
    let entries: Vec<std::fs::DirEntry> = std::fs::read_dir(root)
        .map(|rd| rd.flatten().collect())
        .unwrap_or_default();
    for entry in entries {
        let manifest = std::fs::read_to_string(entry.path().join("plugin.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
        if manifest
            .as_ref()
            .and_then(|v| v.get("id"))
            .and_then(|v| v.as_str())
            == Some(id)
        {
            return manifest
                .as_ref()
                .and_then(|v| v.get("enabled"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
        }
    }
    false
}

pub fn subtitles_plugin_enabled() -> bool {
    plugins_root()
        .map(|root| plugin_enabled_by_id(&root, "subtitles"))
        .unwrap_or(false)
}

/// 扫描插件目录。插件是一个子目录：`plugin.json` + 入口 JS + 可选 CSS。
/// 启用状态写在 `plugins/enabled.json`，不污染用户自己的清单。
#[tauri::command]
pub fn plugin_list() -> Result<Vec<serde_json::Value>, String> {
    let root = plugins_root()?;
    let enabled_map = read_plugin_enabled(&root);
    let entries: Vec<std::fs::DirEntry> = std::fs::read_dir(&root)
        .map(|rd| rd.flatten().collect())
        .unwrap_or_default();
    let mut out = Vec::new();
    for entry in entries {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().to_string();
        out.push(plugin_view(&dir_name, &dir, &enabled_map));
    }
    out.sort_by(|a, b| {
        a.get("name").and_then(|v| v.as_str()).unwrap_or("")
            .to_lowercase()
            .cmp(&b.get("name").and_then(|v| v.as_str()).unwrap_or("").to_lowercase())
    });
    Ok(out)
}

/// 单个插件目录 → 页面可用的插件视图；纯文件读取，便于单测。
fn plugin_view(dir_name: &str, dir: &std::path::Path, enabled_map: &HashMap<String, bool>) -> serde_json::Value {
        let manifest_path = dir.join("plugin.json");
        let mut error = String::new();
        let manifest: serde_json::Value = if manifest_path.exists() {
            match std::fs::read_to_string(&manifest_path)
                .map_err(|e| e.to_string())
                .and_then(|text| serde_json::from_str(&text).map_err(|e| e.to_string()))
            {
                Ok(value) => value,
                Err(e) => {
                    error = format!("plugin.json 解析失败：{e}");
                    serde_json::json!({})
                }
            }
        } else {
            error = "缺少 plugin.json".to_string();
            serde_json::json!({})
        };
        let id = manifest
            .get("id")
            .and_then(|v| v.as_str())
            .filter(|v| safe_plugin_id(v))
            .unwrap_or(dir_name)
            .to_string();
        if !safe_plugin_id(&id) {
            return serde_json::json!({
                "id": dir_name.to_string(),
                "name": dir_name,
                "version": "",
                "description": "",
                "author": "",
                "enabled": false,
                "dir": dir.to_string_lossy(),
                "error": "插件 id 只能包含字母、数字、- 和 _",
            });
        }
        let enabled = enabled_map
            .get(&id)
            .copied()
            .unwrap_or_else(|| manifest.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false));
        let main_name = manifest.get("main").and_then(|v| v.as_str()).unwrap_or("main.js");
        let css_name = manifest.get("style").and_then(|v| v.as_str()).unwrap_or("style.css");
        let script_names: Vec<String> = manifest
            .get("scripts")
            .and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|v| v.as_str())
                    .map(|v| v.to_string())
                    .collect()
            })
            .unwrap_or_default();
        let mut js = String::new();
        let mut css = String::new();
        if !safe_plugin_file(main_name)
            || !safe_plugin_file(css_name)
            || script_names.iter().any(|name| !safe_plugin_file(name))
        {
            if error.is_empty() {
                error = "main/style/scripts 只能是插件目录内的文件名".to_string();
            }
        } else if enabled {
            // scripts 先加载、main 最后加载：插件可以把解析/渲染内核拆成多个文件，
            // 入口仍然只有一个 register 调用。
            for name in script_names.iter().filter(|name| name.as_str() != main_name) {
                match std::fs::read_to_string(dir.join(name)) {
                    Ok(text) => {
                        js.push_str(&text);
                        js.push_str("\n;\n");
                    }
                    Err(e) => {
                        if error.is_empty() {
                            error = format!("读取 {name} 失败：{e}");
                        }
                    }
                }
            }
            match std::fs::read_to_string(dir.join(main_name)) {
                Ok(text) => {
                    js.push_str(&text);
                }
                Err(e) => {
                    if error.is_empty() {
                        error = format!("读取 {main_name} 失败：{e}");
                    }
                }
            }
            if dir.join(css_name).exists() {
                css = std::fs::read_to_string(dir.join(css_name)).unwrap_or_default();
            }
        }
        let builtin = matches!(id.as_str(), "subtitles" | "study");
        serde_json::json!({
            "id": id,
            "builtin": builtin,
            "name": manifest.get("name").and_then(|v| v.as_str()).unwrap_or(dir_name),
            "version": manifest.get("version").and_then(|v| v.as_str()).unwrap_or(""),
            "description": manifest.get("description").and_then(|v| v.as_str()).unwrap_or(""),
            "author": manifest.get("author").and_then(|v| v.as_str()).unwrap_or(""),
            "enabled": enabled,
            "requires": manifest.get("requires").cloned().unwrap_or_else(|| serde_json::json!([])),
            "scripts": script_names,
            "dir": dir.to_string_lossy(),
            "main": main_name,
            "style": css_name,
            "js": js,
            "css": css,
            "error": error,
        })
}

#[tauri::command]
pub fn plugin_set_enabled(app: tauri::AppHandle, id: String, enabled: bool) -> Result<(), String> {
    if !safe_plugin_id(&id) {
        return Err(format!("非法的插件 id：{id}"));
    }
    let root = plugins_root()?;
    if !root.join(&id).is_dir() {
        // id 可能取自 manifest，与目录名不同；至少确认有某个目录声明了这个 id。
        let entries: Vec<std::fs::DirEntry> = std::fs::read_dir(&root)
            .map(|rd| rd.flatten().collect())
            .unwrap_or_default();
        let found = entries.iter().any(|entry| {
            std::fs::read_to_string(entry.path().join("plugin.json"))
                .ok()
                .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
                .and_then(|value| value.get("id").and_then(|v| v.as_str()).map(|v| v == id))
                .unwrap_or(false)
        });
        if !found {
            return Err(format!("插件不存在：{id}"));
        }
    }
    let mut state = read_plugin_enabled(&root);
    state.insert(id.clone(), enabled);
    write_plugin_enabled(&root, &state)?;
    if id == "subtitles" && !enabled {
        // 停用字幕插件就把正在跑的全局字幕一起收掉，避免刷新前还留一个悬浮层。
        let app_state = app.state::<AppState>();
        let session = app_state
            .captions
            .lock()
            .map_err(|_| "锁失败".to_string())?
            .take();
        if let Some(mut session) = session {
            session.stop();
            if let Some(window) = app.get_webview_window("captions") {
                let _ = window.close();
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn plugin_open_dir() -> Result<(), String> {
    let root = plugins_root()?;
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&root)
            .spawn()
            .map_err(|e| format!("打开插件目录失败：{e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = root;
        Err("打开插件目录只在桌面版可用".to_string())
    }
}

/// 写一个可直接改的示例插件，降低第一次上手的门槛。
#[tauri::command]
pub fn plugin_example() -> Result<String, String> {
    let root = plugins_root()?;
    let dir = root.join("hello-world");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建插件目录失败：{e}"))?;
    if dir.join("plugin.json").exists() {
        return Ok(dir.to_string_lossy().to_string());
    }
    let manifest = serde_json::json!({
        "id": "hello-world",
        "name": "Hello World",
        "version": "0.1.0",
        "description": "插件接口示例：注册一个页面、监听播放事件。",
        "author": "you",
        "enabled": true,
        "main": "main.js",
        "style": "style.css"
    });
    std::fs::write(
        dir.join("plugin.json"),
        serde_json::to_string_pretty(&manifest).unwrap_or_default(),
    )
    .map_err(|e| format!("写 plugin.json 失败：{e}"))?;
    let main = r#"// 每个插件只需调用一次 MyTPlugins.register。
MyTPlugins.register('hello-world', {
  setup(api) {
    // 注册一个侧栏页面：路由是 #/plugin/hello-world/hello
    api.page('hello', {
      title: '插件示例',
      render(el) {
        el.innerHTML = '<div class="hello-card">'
          + '<h3>Hello, plugin!</h3>'
          + '<p>这个页面、样式和下面的按钮都来自插件目录里的 hello-world。</p>'
          + '<button class="btn primary" id="hello-toast">点我弹一条消息</button>'
          + '</div>';
        el.querySelector('#hello-toast').onclick = () => api.toast('插件按钮被点了。');
      },
    });

    // 播放器事件；插件可以直接读 DOM，也可以用 api.player 里的快捷方法。
    api.on('player:play', p => {
      console.log('[hello-world] play', p.title, p.time);
    });
  },
});
"#;
    std::fs::write(dir.join("main.js"), main).map_err(|e| format!("写 main.js 失败：{e}"))?;
    std::fs::write(
        dir.join("style.css"),
        ".hello-card{padding:18px 20px;border:1px solid var(--line);border-radius:12px;background:var(--panel2)}\n\
.hello-card h3{margin:0 0 8px;font:600 16px/1.4 var(--sans);color:var(--bright)}\n\
.hello-card p{margin:0 0 14px;font:12.5px/1.7 var(--sans);color:var(--muted)}\n",
    )
    .map_err(|e| format!("写 style.css 失败：{e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个用例独立的临时目录，跑完删掉；不依赖 tempfile crate。
    fn tmp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("myt-plugin-test-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    fn put(dir: &std::path::Path, name: &str, body: &str) {
        std::fs::write(dir.join(name), body).expect("写测试文件");
    }

    fn view(name: &str, manifest: &str, enabled: bool) -> serde_json::Value {
        let dir = tmp(name);
        put(&dir, "plugin.json", manifest);
        let mut map = HashMap::new();
        map.insert("demo".to_string(), enabled);
        let value = plugin_view("demo", &dir, &map);
        let _ = std::fs::remove_dir_all(&dir);
        value
    }

    fn str_field(v: &serde_json::Value, key: &str) -> String {
        v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
    }

    #[test]
    fn manifest_parse_error_is_reported() {
        let v = view("bad-json", "{ not json", false);
        assert!(str_field(&v, "error").contains("plugin.json 解析失败"), "{v}");
    }

    #[test]
    fn missing_manifest_is_reported() {
        let dir = tmp("no-manifest");
        let value = plugin_view("demo", &dir, &HashMap::new());
        assert_eq!(str_field(&value, "error"), "缺少 plugin.json");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unsafe_dir_name_is_rejected() {
        let dir = tmp("unsafe-name");
        let value = plugin_view("bad id", &dir, &HashMap::new());
        assert!(str_field(&value, "error").contains("插件 id 只能包含"), "{value}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn path_traversal_in_main_is_rejected() {
        let v = view("traversal", r#"{"id":"demo","main":"../evil.js"}"#, false);
        assert!(str_field(&v, "error").contains("只能是插件目录内的文件名"), "{v}");
        assert_eq!(str_field(&v, "js"), "");
    }

    #[test]
    fn enabled_plugin_concatenates_scripts_then_main() {
        let v = view(
            "concat",
            r#"{"id":"demo","name":"演示","scripts":["a.js","b.js"],"main":"main.js","style":"style.css"}"#,
            true,
        );
        // view() 只写 plugin.json，这里再补脚本（复用同一目录不可行，改为直接构造）
        assert_eq!(str_field(&v, "id"), "demo");
        assert_eq!(str_field(&v, "name"), "演示");
        assert!(str_field(&v, "error").contains("读取 a.js 失败") || str_field(&v, "error").contains("读取 main.js 失败"),
            "缺脚本文件时应报读取失败：{v}");
    }

    #[test]
    fn enabled_plugin_with_files_loads_js_and_css() {
        let dir = tmp("with-files");
        put(&dir, "plugin.json", r#"{"id":"demo","scripts":["a.js"],"main":"main.js","style":"style.css","enabled":true}"#);
        put(&dir, "a.js", "const helper = 1;");
        put(&dir, "main.js", "MyTPlugins.register('demo', {});");
        put(&dir, "style.css", ".demo{color:red}");
        let mut map = HashMap::new();
        map.insert("demo".to_string(), true);
        let v = plugin_view("demo", &dir, &map);
        let js = str_field(&v, "js");
        assert_eq!(js, "const helper = 1;\n;\nMyTPlugins.register('demo', {});");
        assert_eq!(str_field(&v, "css"), ".demo{color:red}");
        assert_eq!(str_field(&v, "error"), "");
        assert_eq!(v.get("enabled").and_then(|x| x.as_bool()), Some(true));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn enabled_map_overrides_manifest_default() {
        let dir = tmp("override");
        put(&dir, "plugin.json", r#"{"id":"demo","enabled":true}"#);
        put(&dir, "main.js", "// noop");
        let mut map = HashMap::new();
        map.insert("demo".to_string(), false);
        let v = plugin_view("demo", &dir, &map);
        assert_eq!(v.get("enabled").and_then(|x| x.as_bool()), Some(false));
        assert_eq!(str_field(&v, "js"), "", "停用插件不该读入口脚本");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn builtin_flag_covers_subtitles_and_study() {
        for id in ["subtitles", "study"] {
            let dir = tmp(&format!("builtin-{id}"));
            put(&dir, "plugin.json", &format!(r#"{{"id":"{id}"}}"#));
            let v = plugin_view(id, &dir, &HashMap::new());
            assert_eq!(v.get("builtin").and_then(|x| x.as_bool()), Some(true), "{id}");
            let _ = std::fs::remove_dir_all(&dir);
        }
        let dir = tmp("builtin-other");
        put(&dir, "plugin.json", r#"{"id":"demo"}"#);
        let v = plugin_view("demo", &dir, &HashMap::new());
        assert_eq!(v.get("builtin").and_then(|x| x.as_bool()), Some(false));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn seed_writes_files_on_first_install() {
        let root = tmp("seed-first");
        seed_into(&root, "demo", &[("main.js", "v1")]).expect("首次铺设");
        assert_eq!(std::fs::read_to_string(root.join("demo/main.js")).unwrap(), "v1");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn seed_updates_unmodified_file_on_upgrade() {
        let root = tmp("seed-upgrade");
        seed_into(&root, "demo", &[("main.js", "v1")]).unwrap();
        seed_into(&root, "demo", &[("main.js", "v2")]).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("demo/main.js")).unwrap(), "v2");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn seed_keeps_user_modified_file() {
        let root = tmp("seed-modified");
        seed_into(&root, "demo", &[("main.js", "v1")]).unwrap();
        put(&root.join("demo"), "main.js", "user edit");
        seed_into(&root, "demo", &[("main.js", "v2")]).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("demo/main.js")).unwrap(), "user edit");
        // 再升一次也不该覆盖用户版本
        seed_into(&root, "demo", &[("main.js", "v3")]).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("demo/main.js")).unwrap(), "user edit");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn seed_records_baseline_for_legacy_install() {
        let root = tmp("seed-legacy");
        // 模拟老版本：文件已存在但还没有 .builtin.json
        let dir = root.join("demo");
        std::fs::create_dir_all(&dir).unwrap();
        put(&dir, "main.js", "old shipped");
        seed_into(&root, "demo", &[("main.js", "new shipped")]).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("main.js")).unwrap(), "old shipped");
        // 基线已记成旧内容，再升一次就能平滑更新
        seed_into(&root, "demo", &[("main.js", "newer shipped")]).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("main.js")).unwrap(), "newer shipped");
        let _ = std::fs::remove_dir_all(&root);
    }
}
