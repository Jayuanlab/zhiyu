"""Malicious/corrupt package boundaries; no services or provider requests."""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("python_runtime_pack", Path(__file__).resolve().parents[1] / "python-runtime-pack.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class RuntimePackageBoundaries(unittest.TestCase):
    def setUp(self):
        self.sandbox = tempfile.TemporaryDirectory(prefix="package-boundary-")
        self.root = Path(self.sandbox.name)

    def tearDown(self):
        self.sandbox.cleanup()

    def wheel(self, payload, *, corrupt_record=False):
        target = self.root / "sample-1.0-py3-none-any.whl"
        metadata = b"Name: sample\nVersion: 1.0\nLicense: MIT\n"
        records = []
        contents = {**payload, "sample-1.0.dist-info/METADATA": metadata}
        for name, data in contents.items():
            encoded = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip("=")
            if corrupt_record and name.endswith(".py"):
                encoded = "0" * 43
            records.append(f"{name},sha256={encoded},{len(data)}")
        contents["sample-1.0.dist-info/RECORD"] = ("\n".join(records) + "\nsample-1.0.dist-info/RECORD,,\n").encode()
        with zipfile.ZipFile(target, "w") as archive:
            for name, data in contents.items():
                archive.writestr(name, data)
        lock = {"allowedSitePth": [], "packages": [{"name": "sample", "version": "1.0", "filename": target.name, "sha256": helper.digest(target)}]}
        lock_path = self.root / "lock.json"
        lock_path.write_text(json.dumps(lock), encoding="utf-8")
        return target, lock_path

    def test_paths_cannot_escape_runtime(self):
        for name in ["../outside.py", "C:/outside.py", "/outside.py", "nested\\outside.py"]:
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "archive_path_escape"):
                helper.safe_name(name)

    def test_tampered_record_never_installs_python_module(self):
        _, lock = self.wheel({"sample.py": b"raise RuntimeError('never run')\n"}, corrupt_record=True)
        with self.assertRaisesRegex(ValueError, "record_mismatch"):
            helper.install_wheels(lock, self.root, self.root / "runtime")
        self.assertFalse((self.root / "runtime/Lib/site-packages/sample.py").exists())

    def test_outer_wheel_hash_is_mandatory(self):
        wheel, lock = self.wheel({"sample.py": b"pass\n"})
        wheel.write_bytes(wheel.read_bytes() + b"tampered")
        with self.assertRaisesRegex(ValueError, "wheel_hash_mismatch"):
            helper.install_wheels(lock, self.root, self.root / "runtime")

    def test_source_built_wheel_cannot_add_code(self):
        wheel, _ = self.wheel({"sample.py": b"pass\n", "injected.py": b"pass\n"})
        source = self.root / "sample-1.0.tar.gz"
        with tarfile.open(source, "w:gz") as archive:
            info = tarfile.TarInfo("sample-1.0/sample.py")
            info.size = 5
            archive.addfile(info, io.BytesIO(b"pass\n"))
        with self.assertRaisesRegex(ValueError, "source_wheel_payload_mismatch:injected.py"):
            helper.audit_source_wheel(wheel, source)


if __name__ == "__main__":
    unittest.main()
