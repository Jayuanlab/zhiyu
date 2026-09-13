"""Run paper tests with temporary storage and no network/process effects."""
import hashlib
import json
import os
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app import paper_trading, provider


def fingerprint(path):
    return {"hash": hashlib.sha256(path.read_bytes()).hexdigest(), "mtime": path.stat().st_mtime_ns} if path.exists() else None


def blocked(*args, **kwargs):
    raise RuntimeError("TEST_IO_BLOCKED: inject a fake provider")


def main():
    daily = paper_trading.PAPER_ACCOUNT_PATH
    before = fingerprint(daily)
    with tempfile.TemporaryDirectory(prefix="zhiyu_test_paper_") as directory:
        temp = Path(directory)
        with patch.object(paper_trading, "PAPER_ACCOUNT_PATH", temp / "account.json"), \
             patch.dict(os.environ, {"QUANT_TIMING_LOG_PATH": str(temp / "timing.log")}), \
             patch.object(provider, "WATCHLIST_CONFIG_PATH", temp / "watchlist.json"), \
             patch.object(provider, "WATCHLIST_UNIVERSE_PATH", temp / "universe.json"), \
             patch.object(socket.socket, "connect", blocked), \
             patch.object(socket.socket, "connect_ex", blocked), \
             patch.object(subprocess, "Popen", blocked):
            suite = unittest.defaultTestLoader.discover(str(ROOT / "tests"), pattern="test_paper*.py")
            result = unittest.TextTestRunner(verbosity=2).run(suite)
    unchanged = before == fingerprint(daily)
    report = {"tests": result.testsRun, "failures": len(result.failures), "errors": len(result.errors), "skipped": len(result.skipped), "dailyAccountUnchanged": unchanged}
    stage = sys.argv[1] if len(sys.argv) > 1 else "01"
    if stage not in {"01", "03", "08"}:
        raise ValueError("unsupported regression stage")
    output = ROOT.parents[1] / f"docs/plans/2026-09-06-review-remediation/records/{stage}-python.json"
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report))
    return 0 if result.wasSuccessful() and unchanged else 1


if __name__ == "__main__":
    sys.exit(main())
