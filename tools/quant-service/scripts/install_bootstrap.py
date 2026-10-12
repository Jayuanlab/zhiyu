"""Private installer entry; no provider request, old account import or env fallback."""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    parser = argparse.ArgumentParser()
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--check", action="store_true")
    modes.add_argument("--initialize", action="store_true")
    modes.add_argument("--health", action="store_true")
    args = parser.parse_args()
    event = "quant_install_checked" if args.check else "quant_install_initialized" if args.initialize else "quant_install_health"
    try:
        from app.install_bootstrap import check_dependencies, health, initialize
        value = check_dependencies() if args.check else initialize() if args.initialize else health()
        print(json.dumps({"event": event, **value}, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as error:
        # Never emit driver messages, SQL, credentials or environment values.
        import re
        message = str(error)
        code = "quant_install_dependency_missing" if isinstance(error, ModuleNotFoundError) else "quant_install_dependency_load_failed" if isinstance(error, ImportError) else message if re.fullmatch(r"[a-z][a-z0-9_]{0,100}", message) else "quant_install_bootstrap_failed"
        result = {"event": event, "ok": False, "code": code, "error": code}
        driver_code = getattr(error, "sqlstate", None)
        if isinstance(driver_code, str) and re.fullmatch(r"[0-9A-Z]{5}", driver_code):
            result["driverCode"] = driver_code
        print(json.dumps(result, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    sys.exit(main())
