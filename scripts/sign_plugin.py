#!/usr/bin/env python3
"""给本地插件签名 / 验签。

摘要算法必须和 `apps/windows/src-tauri/src/plugins.rs` 的 `plugin_digest` 完全一致：
    sha256(id + "\\n" + version + 每个文件("\\nfile " + 文件名 + "\\n" + 内容))，
文件按文件名排序，只算 manifest 里 scripts + main + style 指向且真实存在的文件。

私钥默认读 `~/.config/myt/plugin-signing.json`（`private_hex`），可用环境变量
`MYT_PLUGIN_SIGNING_KEY` 指到别的路径。私钥永不进仓库。

用法：
    python scripts/sign_plugin.py <插件目录>            # 写 signature 进 plugin.json
    python scripts/sign_plugin.py <插件目录> --verify   # 只校验，不改文件
"""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey


def key_path() -> pathlib.Path:
    env = os.environ.get("MYT_PLUGIN_SIGNING_KEY")
    if env:
        return pathlib.Path(env)
    return pathlib.Path.home() / ".config" / "myt" / "plugin-signing.json"


def read_text(path: pathlib.Path) -> str:
    # newline="" 保留原始 CRLF，和 Rust 的 read_to_string 字节一致
    with open(path, encoding="utf-8", newline="") as handle:
        return handle.read()


def plugin_files(dir_path: pathlib.Path, manifest: dict) -> list[tuple[str, str]]:
    main = manifest.get("main") or "main.js"
    style = manifest.get("style") or "style.css"
    scripts = [name for name in manifest.get("scripts") or [] if isinstance(name, str)]
    out: list[tuple[str, str]] = []
    for name in scripts + [main, style]:
        target = dir_path / name
        if target.is_file():
            out.append((name, read_text(target)))
    return out


def digest(plugin_id: str, version: str, files: list[tuple[str, str]]) -> str:
    body = plugin_id + "\n" + version
    for name, text in sorted(files, key=lambda item: item[0]):
        body += "\nfile " + name + "\n" + text
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def load_key() -> dict:
    path = key_path()
    if not path.exists():
        raise SystemExit(f"找不到私钥：{path}（先运行生成脚本，或用 MYT_PLUGIN_SIGNING_KEY 指定）")
    return json.loads(path.read_text(encoding="utf-8"))


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    dir_path = pathlib.Path(argv[1]).resolve()
    manifest_path = dir_path / "plugin.json"
    if not manifest_path.is_file():
        raise SystemExit(f"{dir_path} 里没有 plugin.json")
    manifest = json.loads(read_text(manifest_path))
    plugin_id = str(manifest.get("id") or dir_path.name)
    version = str(manifest.get("version") or "")
    files = plugin_files(dir_path, manifest)
    if not files:
        raise SystemExit("manifest 指向的文件一个都不存在，没什么可签的")
    value = digest(plugin_id, version, files)
    verify_only = "--verify" in argv[2:]
    keys = load_key()
    public = Ed25519PublicKey.from_public_bytes(bytes.fromhex(keys["public_hex"]))

    if verify_only:
        sig = str(manifest.get("signature") or "").strip()
        if not sig:
            print("未签名")
            return 1
        try:
            public.verify(bytes.fromhex(sig), value.encode("utf-8"))
        except Exception:
            print("签名无效：内容或版本已改动")
            return 1
        print("签名有效：" + value)
        return 0

    private = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(keys["private_hex"]))
    manifest["signature"] = private.sign(value.encode("utf-8")).hex()
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"已签名 {plugin_id}@{version or '-'}：{value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
