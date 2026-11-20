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

/// 随应用发布的插件。用户目录不存在时铺一份；已有文件绝不覆盖，
/// 这样用户可以自由改 main.js / style.css，升级也不会把手改内容冲掉。
fn seed_builtin_plugin(name: &str, files: &[(&str, &str)]) -> Result<(), String> {
    let root = plugins_root()?;
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建内置插件 {name} 失败：{e}"))?;
    for (file, content) in files {
        let path = dir.join(file);
        if !path.exists() {
            std::fs::write(&path, content)
                .map_err(|e| format!("写入内置插件 {name}/{file} 失败：{e}"))?;
        }
    }
    Ok(())
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
            .unwrap_or(&dir_name)
            .to_string();
        if !safe_plugin_id(&id) {
            out.push(serde_json::json!({
                "id": dir_name,
                "name": dir_name,
                "version": "",
                "description": "",
                "author": "",
                "enabled": false,
                "dir": dir.to_string_lossy(),
                "error": "插件 id 只能包含字母、数字、- 和 _",
            }));
            continue;
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
        out.push(serde_json::json!({
            "id": id,
            "builtin": builtin,
            "name": manifest.get("name").and_then(|v| v.as_str()).unwrap_or(&dir_name),
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
        }));
    }
    out.sort_by(|a, b| {
        a.get("name").and_then(|v| v.as_str()).unwrap_or("")
            .to_lowercase()
            .cmp(&b.get("name").and_then(|v| v.as_str()).unwrap_or("").to_lowercase())
    });
    Ok(out)
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
