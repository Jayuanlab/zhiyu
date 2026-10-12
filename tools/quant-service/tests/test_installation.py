"""No database/provider access: explicit install resource and account boundaries."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app import install_paths
from app.install_bootstrap import configuration, initialize


class InstallationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="zhiyu-quant-unit-")
        self.root = Path(self.temporary.name).resolve()
        self.install = self.root / "install"
        self.data = self.root / "data"
        self.quant = self.install / "components" / "quant"
        self.quant.mkdir(parents=True)
        self.data.mkdir()
        (self.data / ".zhiyu-install-data").write_text("zhiyu-private-install-data-v1\n", encoding="utf-8")
        (self.quant / "embedded_worker.py").write_text("", encoding="utf-8")
        self.owner = "00000000-0000-4000-a000-000000000001"
        self.account = "00000000-0000-4000-a000-000000000002"
        password = "p" * 40
        self.env = {"ZHIYU_QUANT_INSTALL_MODE": "1", "ZHIYU_INSTALL_ROOT": str(self.install),
                    "ZHIYU_INSTALL_DATA_DIR": str(self.data), "QUANT_DATA_DIR": str(self.data / "quant"),
                    "ZHIYU_QUANT_RESOURCE_DIR": str(self.quant), "QUANT_PAPER_OWNER_ID": self.owner,
                    "ZHIYU_RUNTIME_OWNER_ID": self.owner, "QUANT_PAPER_ACCOUNT_ID": self.account,
                    "QUANT_INSTALL_BOOTSTRAP_COMMAND_ID": "install-init:" + self.account,
                    "QUANT_INSTALL_DATABASE_PASSWORD": password, "QUANT_PAPER_SIGNING_KEY": "s" * 40,
                    "QUANT_INTERNAL_TOKEN": "t" * 40,
                    "QUANT_PAPER_DATABASE_URL": "postgresql://zhiyu_quant:" + password + "@127.0.0.1:15432/zhiyu",
                    "QUANT_INSTALL_ADMIN_DATABASE_URL": "postgresql://zhiyu:admin@127.0.0.1:15432/zhiyu"}
        self.environment = patch.dict(os.environ, self.env, clear=True)
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.temporary.cleanup()

    def test_isolated_paths_and_relative_environment_rejected(self):
        self.assertEqual(install_paths.data_directory(), self.data / "quant")
        self.assertEqual(install_paths.config_directory(), self.quant / "config")
        self.assertEqual(install_paths.timing_log_path(), self.data / "logs" / "quant-timing.log")
        for value in ["relative", str(self.quant), str(self.data)]:
            with patch.dict(os.environ, {"QUANT_DATA_DIR": value}):
                with self.assertRaises(ValueError):
                    install_paths.data_directory()
        (self.data / ".zhiyu-install-data").unlink()
        with self.assertRaisesRegex(ValueError, "data_not_owned"):
            install_paths.resource_directory()

    def test_health_configuration_needs_no_admin_credentials(self):
        for key in ["QUANT_INSTALL_ADMIN_DATABASE_URL", "QUANT_INSTALL_DATABASE_PASSWORD", "QUANT_INSTALL_BOOTSTRAP_COMMAND_ID"]:
            os.environ.pop(key)
        self.assertEqual(configuration(bootstrap=False)["owner"], self.owner)

    def test_owner_and_database_binding_rejected_before_connection(self):
        with patch.dict(os.environ, {"ZHIYU_RUNTIME_OWNER_ID": self.account}):
            with self.assertRaisesRegex(ValueError, "owner_denied"):
                configuration()
        with patch.dict(os.environ, {"QUANT_PAPER_DATABASE_URL": self.env["QUANT_PAPER_DATABASE_URL"].replace("127.0.0.1", "remote.invalid")}):
            with self.assertRaisesRegex(ValueError, "target_invalid"):
                configuration()
        with patch.dict(os.environ, {"QUANT_INSTALL_DATABASE_PASSWORD": "different" * 8}):
            with self.assertRaisesRegex(ValueError, "role_mismatch"):
                configuration()

    def test_cluster_ownership_checked_before_sql_mutation(self):
        statements = []
        class Connection:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def execute(self, statement, *args): statements.append(statement); return self
            def fetchone(self): return {"path": str(self_wrong_cluster)}
        self_wrong_cluster = self.root / "daily-database"
        with self.assertRaisesRegex(ValueError, "cluster_not_owned"):
            initialize(connector=lambda *args, **kwargs: Connection())
        self.assertEqual(statements, ["SELECT current_setting('data_directory') AS path"])

    def test_installed_worker_uses_empty_watchlist_without_tdx_or_host_env(self):
        for folder in ["app", "config"]:
            shutil.copytree(ROOT / folder, self.quant / folder, ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copyfile(ROOT / "embedded_worker.py", self.quant / "embedded_worker.py")
        script = self.quant / "probe.py"
        script.write_text("from app import provider, tdx_local\nimport json\nprint(json.dumps({'codes':provider._watchlist_codes(),'display':provider._build_watchlist([{'code':'600519'}]),'tdx':tdx_local._candidate_tdx_roots(),'data':str(provider.WATCHLIST_CONFIG_PATH)}))\n", encoding="utf-8")
        # Isolated Python deliberately needs only its own approved resource path.
        script.write_text("import sys\nfrom pathlib import Path\nsys.path.insert(0,str(Path(__file__).resolve().parent))\n" + script.read_text(encoding="utf-8"), encoding="utf-8")
        env = {**os.environ, "SystemRoot": os.getenv("SystemRoot", "C:\\Windows"), "PYTHONPATH": str(ROOT), "QUANT_TDX_LOCAL_ENABLED": "true", "QUANT_TDX_LOCAL_PATHS": str(self.root / "daily-tdx")}
        result = subprocess.run([sys.executable, "-I", "-B", "-X", "utf8", str(script)], cwd=self.data, env=env, capture_output=True, text=True, encoding="utf-8", timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        facts = json.loads(result.stdout)
        self.assertEqual(facts["codes"], []); self.assertEqual(facts["display"], []); self.assertEqual(facts["tdx"], [])
        self.assertEqual(facts["data"], str(self.data / "quant" / "watchlist.json"))
        request = json.dumps({"id": 1, "method": "GET", "path": "/health", "headers": {}, "body": ""}) + "\n"
        request += json.dumps({"id": 2, "method": "PUT", "path": "/watchlist/config", "headers": {}, "body": "{}"}) + "\n"
        result = subprocess.run([sys.executable, "-I", "-B", "-X", "utf8", "-u", str(self.quant / "embedded_worker.py")], cwd=self.data, env=env, input=request, capture_output=True, text=True, encoding="utf-8", timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        responses = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual({item["id"]: item["status"] for item in responses}, {1: 200, 2: 401})
        self.assertFalse(list(self.quant.rglob("__pycache__")))
        self.assertFalse((self.data / "quant" / "paper_account.json").exists())


if __name__ == "__main__":
    unittest.main()
