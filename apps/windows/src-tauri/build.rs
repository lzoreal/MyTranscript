use std::env;
use std::fs;
use std::path::PathBuf;

/// 链接预编译的 sherpa-onnx C API（不做 bindgen，所以不需要 libclang）。
/// 库文件放在 vendor/sherpa 下，DLL 运行时要和 exe 放在一起。
fn link_sherpa() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let vendor = manifest.join("vendor/sherpa");
    let lib_dir = vendor.join("lib");
    let bin_dir = vendor.join("bin");
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!("cargo:rustc-link-lib=dylib=sherpa-onnx-c-api");
    println!("cargo:rerun-if-changed=vendor/sherpa");

    // 把运行期 DLL 拷到 target/{debug,release} 旁边（cargo run 直接能找到）。
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let mut target = out.clone();
    while let Some(parent) = target.parent() {
        if parent.ends_with("debug") || parent.ends_with("release") {
            target = parent.to_path_buf();
            break;
        }
        target = parent.to_path_buf();
    }
    for dll in ["sherpa-onnx-c-api.dll", "onnxruntime.dll", "onnxruntime_providers_shared.dll"] {
        let src = if bin_dir.join(dll).exists() { bin_dir.join(dll) } else { lib_dir.join(dll) };
        let dst = target.join(dll);
        if src.exists() && !dst.exists() {
            let _ = fs::copy(&src, &dst);
        }
    }
}

fn main() {
    link_sherpa();
    // 内置插件与站点资源不是 Rust 源，Tauri 的资源嵌入不会自动跟随改动；
    // 必须显式声明，否则只改 kernel.js/view.css 时 cargo 会复用旧的打包资源。
    println!("cargo:rerun-if-changed=../builtin-plugins");
    println!("cargo:rerun-if-changed=../../../site");
    tauri_build::build();
}
