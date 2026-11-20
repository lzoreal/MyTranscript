use std::env;
use std::fs;
use std::path::PathBuf;

/// 与 src-tauri 的 build.rs 同样的链接方式：直接连预编译的 C API。
/// 库在 `apps/windows/src-tauri/vendor/sherpa`，这里按相对路径找。
fn link_sherpa() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let vendor = manifest
        .parent()
        .expect("capture-spike 应在 apps/windows 下")
        .join("src-tauri")
        .join("vendor")
        .join("sherpa");
    let lib_dir = vendor.join("lib");
    let bin_dir = vendor.join("bin");
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!("cargo:rustc-link-lib=dylib=sherpa-onnx-c-api");
    println!("cargo:rerun-if-changed={}", vendor.display());

    // 运行期 DLL 拷到 target/{debug,release} 旁边，cargo run 才能直接启动。
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let mut target = out.clone();
    while let Some(parent) = target.parent() {
        if parent.ends_with("debug") || parent.ends_with("release") {
            target = parent.to_path_buf();
            break;
        }
        target = parent.to_path_buf();
    }
    for dll in [
        "sherpa-onnx-c-api.dll",
        "onnxruntime.dll",
        "onnxruntime_providers_shared.dll",
    ] {
        let src = if bin_dir.join(dll).exists() {
            bin_dir.join(dll)
        } else {
            lib_dir.join(dll)
        };
        let dst = target.join(dll);
        if src.exists() && !dst.exists() {
            let _ = fs::copy(&src, &dst);
        }
    }
}

fn main() {
    link_sherpa();
}
