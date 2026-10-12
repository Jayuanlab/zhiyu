"""Build-only, stdlib-only helpers for the private Windows Python payload."""
from __future__ import annotations

import base64
import csv
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sys
import zipfile
from email.parser import Parser


def digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def canonical(name):
    return name.lower().replace("_", "-").replace(".", "-")


def wheel_inventory(directory, output=None):
    packages = []
    for wheel in sorted(Path(directory).glob("*.whl")):
        with zipfile.ZipFile(wheel) as archive:
            name = next(name for name in archive.namelist() if name.endswith(".dist-info/METADATA"))
            metadata = Parser().parsestr(archive.read(name).decode("utf-8"))
            packages.append({"name": metadata["Name"], "version": metadata["Version"],
                             "filename": wheel.name, "sha256": digest(wheel),
                             "license": metadata["License-Expression"] or metadata["License"] or "SEE BUNDLED LICENSES",
                             "requiresDist": metadata.get_all("Requires-Dist", [])})
    data = json.dumps(packages)
    if output:
        Path(output).write_text(data + "\n", encoding="utf-8")
    else:
        print(data)


def audit_source_wheel(wheel_path, source_path):
    import tarfile
    with tarfile.open(source_path, "r:gz") as source:
        source_files = {"/".join(PurePosixPath(info.name).parts[1:]): source.extractfile(info).read()
                        for info in source.getmembers() if info.isfile()}
    checked = []
    with zipfile.ZipFile(wheel_path) as archive:
        for info in archive.infolist():
            if info.is_dir() or ".dist-info/" in info.filename:
                continue
            if info.filename not in source_files or archive.read(info) != source_files[info.filename]:
                raise ValueError("source_wheel_payload_mismatch:" + info.filename)
            checked.append(info.filename)
    if not checked:
        raise ValueError("source_wheel_has_no_payload")
    print(json.dumps({"event": "source_wheel_verified", "files": checked}))


def safe_name(name):
    path = PurePosixPath(name)
    if name.startswith(("/", "\\")) or "\\" in name or ":" in name or ".." in path.parts:
        raise ValueError("python_archive_path_escape")
    return path


def install_wheels(lock_path, wheel_dir, runtime):
    lock = json.loads(Path(lock_path).read_text(encoding="utf-8"))
    root = Path(runtime).resolve()
    site = root / "Lib" / "site-packages"
    site.mkdir(parents=True, exist_ok=True)
    license_root = root / "THIRD-PARTY-LICENSES"
    license_root.mkdir(exist_ok=True)
    installed = {}
    receipt = []
    for package in lock["packages"]:
        wheel = Path(wheel_dir) / package["filename"]
        if digest(wheel) != package["sha256"]:
            raise ValueError("python_wheel_hash_mismatch:" + package["filename"])
        package_licenses = []
        runtime_files = []
        with zipfile.ZipFile(wheel) as archive:
            records = [name for name in archive.namelist() if name.endswith(".dist-info/RECORD")]
            if len(records) != 1:
                raise ValueError("python_wheel_record_missing")
            for filename, encoded, size in csv.reader(io.StringIO(archive.read(records[0]).decode("utf-8"))):
                safe_name(filename)
                if encoded:
                    algorithm, expected = encoded.split("=", 1)
                    if algorithm != "sha256":
                        raise ValueError("python_wheel_record_algorithm")
                    data = archive.read(filename)
                    actual = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode("ascii").rstrip("=")
                    if actual != expected or (size and int(size) != len(data)):
                        raise ValueError("python_wheel_record_mismatch:" + filename)
            for info in archive.infolist():
                if info.is_dir():
                    continue
                path = safe_name(info.filename)
                if info.external_attr >> 16 & 0o170000 == 0o120000:
                    raise ValueError("python_wheel_symlink")
                parts = list(path.parts)
                if any(part in {"__pycache__", ".venv", ".env"} for part in parts) or path.suffix in {".pyc", ".pyo"}:
                    continue
                if parts[0].endswith(".data"):
                    if len(parts) < 3 or parts[1] not in {"purelib", "platlib"}:
                        # Wheel scripts/headers are developer entry points; the app
                        # runs module files with its private interpreter directly.
                        continue
                    parts = parts[2:]
                relative_name = "/".join(parts)
                if path.suffix.lower() in {".key", ".db", ".sqlite", ".sqlite3", ".pem"} and relative_name != "certifi/cacert.pem":
                    if any(part.lower() in {"test", "tests", "testing"} for part in parts):
                        continue
                    raise ValueError("python_unreviewed_private_extension:" + relative_name)
                data = archive.read(info)
                file_hash = hashlib.sha256(data).hexdigest()
                if relative_name in installed and installed[relative_name] != file_hash:
                    raise ValueError("python_wheel_file_collision:" + relative_name)
                installed[relative_name] = file_hash
                target = site.joinpath(*parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                if ".dist-info/" not in relative_name and target.suffix.lower() in {".py", ".pyd", ".dll", ".js"}:
                    runtime_files.append(relative_name)
                if "/licenses/" in relative_name.lower() or target.name.lower().startswith(("license", "licence", "copying", "notice", "copyright", "authors")) or target.name == "METADATA" or (canonical(package["name"]) == "jsonpath" and relative_name == "jsonpath.py"):
                    copy = license_root / canonical(package["name"]) / relative_name
                    copy.parent.mkdir(parents=True, exist_ok=True)
                    copy.write_bytes(data)
                    package_licenses.append(copy.relative_to(root).as_posix())
        notices = [name for name in package_licenses if not name.endswith("/METADATA")]
        if runtime_files and not notices:
            raise ValueError("python_runtime_license_notice_missing:" + package["name"])
        receipt.append({**package, "licenseFiles": package_licenses,
                        "licenseCoverage": "bundled_notices" if notices else "metadata_and_readme_only_no_runtime_code"})
    pth = sorted(path.name for path in site.glob("*.pth"))
    if pth != lock["allowedSitePth"]:
        raise ValueError("python_unreviewed_site_hook:" + repr(pth))
    cert = site / "certifi" / "cacert.pem"
    result = {"packages": receipt, "siteHooks": pth, "publicCertificateBundle": {"path": "Lib/site-packages/certifi/cacert.pem", "sha256": digest(cert)}}
    (root / "wheel-install-receipt.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"event": "python_wheels_installed", "packages": len(receipt), "files": len(installed), "siteHooks": pth}))


def smoke(lock_path, runtime):
    import importlib
    import importlib.metadata
    import site
    import socket
    root = Path(runtime).resolve()
    assert Path(sys.executable).resolve() == root / "python.exe", "private_interpreter_required"
    assert sys.flags.isolated and sys.flags.no_user_site, "python_isolation_required"
    assert not site.ENABLE_USER_SITE, "python_user_site_enabled"
    assert sys.dont_write_bytecode, "python_bytecode_writes_enabled"
    allowed_roots = [root, root.parent.parent / "components" / "quant", root.parent.parent / "components" / "wechat"]
    for entry in sys.path:
        assert entry and any(Path(entry).resolve().is_relative_to(candidate) for candidate in allowed_roots), "python_search_path_escape"
    original_socketpair = socket.socketpair
    original_connect = socket.socket.connect
    creating_private_pair = False
    def no_network(*args, **kwargs):
        raise RuntimeError("python_import_smoke_network_forbidden")
    def private_connect(channel, address):
        if creating_private_pair and isinstance(address, tuple) and address[0] in {"127.0.0.1", "::1"}:
            return original_connect(channel, address)
        return no_network()
    def private_socketpair(*args, **kwargs):
        nonlocal creating_private_pair
        creating_private_pair = True
        try:
            # Windows asyncio constructs its own wake-up socketpair on loopback.
            # This is local IPC owned by this process, not a service request.
            return original_socketpair(*args, **kwargs)
        finally:
            creating_private_pair = False
    socket.socketpair = private_socketpair
    socket.socket.connect = private_connect
    socket.socket.connect_ex = no_network
    socket.create_connection = no_network
    lock = json.loads(Path(lock_path).read_text(encoding="utf-8"))
    for package in lock["packages"]:
        assert importlib.metadata.version(package["name"]) == package["version"], "python_distribution_version_mismatch"
    names = ["fastapi", "uvicorn", "pydantic", "httpx", "akshare", "tushare", "pywencai", "psycopg",
             "psycopg_binary", "psutil", "pythoncom", "win32api", "win32gui", "win32clipboard", "win32process",
             "numpy", "pandas", "lxml.etree", "py_mini_racer", "execjs", "curl_cffi", "certifi", "ssl"]
    loaded = {}
    for name in names:
        module = importlib.import_module(name)
        location = Path(module.__file__).resolve()
        assert location.is_relative_to(root), "python_import_outside_runtime:" + name
        loaded[name] = location.relative_to(root).as_posix()
    import numpy
    import pandas
    import lxml.etree
    import psycopg.pq
    import certifi
    import ssl
    from py_mini_racer import MiniRacer
    assert int(numpy.array([2, 3]).dot(numpy.array([4, 5]))) == 23
    assert int(pandas.DataFrame({"value": [2, 3]}).value.sum()) == 5
    assert lxml.etree.fromstring(b"<root/>").tag == "root"
    with MiniRacer() as engine:
        assert engine.eval("1+2") == 3
    assert psycopg.pq.version() >= 160000
    ssl.create_default_context(cafile=certifi.where())
    result = {"event": "python_runtime_smoke", "ok": True, "version": sys.version.split()[0], "isolated": bool(sys.flags.isolated),
              "userSite": bool(site.ENABLE_USER_SITE), "bytecodeWrites": not sys.dont_write_bytecode,
              "network": "external_connections_blocked;owned_socketpair_only", "imports": loaded, "libpqVersion": psycopg.pq.version(), "sysPath": sys.path,
              "nativeChecks": ["numpy_dot", "pandas_frame", "lxml_parse", "mini_racer_eval", "libpq_version", "pywin32_imports", "ssl_ca_load"]}
    print(json.dumps(result))


if __name__ == "__main__":
    command, *args = sys.argv[1:]
    if command == "inventory":
        wheel_inventory(*args)
    elif command == "install":
        install_wheels(*args)
    elif command == "smoke":
        smoke(*args)
    elif command == "source-audit":
        audit_source_wheel(*args)
    else:
        raise ValueError("unknown_python_runtime_command")
