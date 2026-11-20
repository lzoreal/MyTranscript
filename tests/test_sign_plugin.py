#!/usr/bin/env python3
"""插件签名工具测试：摘要要与 Rust 侧一致，签完能验过，改内容必须验不过。

`scripts/sign_plugin.py` 依赖 cryptography；本机没装时整组跳过（CI 只装
requirements.txt，不含 cryptography）。运行：python tests/test_sign_plugin.py
"""

import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "sign_plugin.py"

try:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    HAVE_CRYPTO = True
except Exception:  # pragma: no cover - 只在没装 cryptography 的机器上走
    HAVE_CRYPTO = False


@unittest.skipUnless(HAVE_CRYPTO, "未安装 cryptography，跳过签名工具测试")
class SignPluginTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.keyfile = self.root / "key.json"
        key = Ed25519PrivateKey.generate()
        private = key.private_bytes(
            serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
            serialization.NoEncryption(),
        )
        public = key.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw,
        )
        self.keyfile.write_text(
            json.dumps({"private_hex": private.hex(), "public_hex": public.hex()}),
            encoding="utf-8",
        )
        os.environ["MYT_PLUGIN_SIGNING_KEY"] = str(self.keyfile)
        spec = importlib.util.spec_from_file_location("sign_plugin", SCRIPT)
        self.mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.mod)

    def tearDown(self):
        os.environ.pop("MYT_PLUGIN_SIGNING_KEY", None)
        self.tmp.cleanup()

    def plugin(self, content="console.log(1)\n"):
        d = self.root / "demo"
        d.mkdir(exist_ok=True)
        (d / "plugin.json").write_text('{"id":"demo","version":"1.0"}', encoding="utf-8")
        (d / "main.js").write_text(content, encoding="utf-8", newline="")
        return d

    def test_digest_matches_rust_fixture(self):
        d = self.plugin()
        manifest = json.loads((d / "plugin.json").read_text(encoding="utf-8"))
        value = self.mod.digest(
            "demo", "1.0", self.mod.manifest_meta(manifest), self.mod.plugin_files(d, manifest)
        )
        # 与 src/plugins.rs 里 digest_covers_content_and_version 用的向量一致
        self.assertEqual(
            value,
            "37b8348b68714e2d84a60d4e565a78be71be360efe50b1d1d3120eeff93d49f1",
        )

    def test_manifest_fields_fixture(self):
        # 与 src/plugins.rs 的 digest_covers_manifest_fields 共用同一条向量
        d = self.plugin()
        manifest = {
            "id": "demo", "version": "1.0", "apiVersion": "2.0",
            "requires": ["subtitles"], "permissions": ["net", "player"],
        }
        value = self.mod.digest(
            "demo", "1.0", self.mod.manifest_meta(manifest), self.mod.plugin_files(d, manifest)
        )
        self.assertEqual(
            value,
            "d7a9774cb05c711a8d8eb1b260028ed667f3c59431542bc68bd43bab198ec29a",
        )

    def test_manifest_fields_are_in_digest(self):
        d = self.plugin()
        manifest = json.loads((d / "plugin.json").read_text(encoding="utf-8"))
        before = self.mod.digest(
            "demo", "1.0", self.mod.manifest_meta(manifest), self.mod.plugin_files(d, manifest)
        )
        manifest["requires"] = ["subtitles"]
        after = self.mod.digest(
            "demo", "1.0", self.mod.manifest_meta(manifest), self.mod.plugin_files(d, manifest)
        )
        self.assertNotEqual(before, after, "改 requires 必须改变摘要，旧签名才会失效")

    def test_sign_then_verify(self):
        d = self.plugin()
        self.assertEqual(self.mod.main(["sign_plugin.py", str(d)]), 0)
        self.assertEqual(self.mod.main(["sign_plugin.py", str(d), "--verify"]), 0)
        manifest = json.loads((d / "plugin.json").read_text(encoding="utf-8"))
        self.assertEqual(len(manifest["signature"]), 128)

    def test_tamper_breaks_signature(self):
        d = self.plugin()
        self.assertEqual(self.mod.main(["sign_plugin.py", str(d)]), 0)
        (d / "main.js").write_text("console.log(2)\n", encoding="utf-8", newline="")
        self.assertEqual(self.mod.main(["sign_plugin.py", str(d), "--verify"]), 1)

    def test_missing_signature_is_not_verified(self):
        d = self.plugin()
        self.assertEqual(self.mod.main(["sign_plugin.py", str(d), "--verify"]), 1)


if __name__ == "__main__":
    unittest.main()
