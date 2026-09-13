"""Read/write interleaving probe. Uses temporary data; no network or real orders."""
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "quant-service"))
from app import paper_trading

original = paper_trading.PAPER_ACCOUNT_PATH
try:
    with tempfile.TemporaryDirectory(prefix="zhiyu-review-") as directory:
        paper_trading.PAPER_ACCOUNT_PATH = Path(directory) / "account.json"
        # Two request handlers can load the same initial account before either saves.
        first = paper_trading._load_account()
        second = paper_trading._load_account()
        first["orders"].append({"id": "review-a"})
        second["orders"].append({"id": "review-b"})
        paper_trading._save_account(first)
        paper_trading._save_account(second)
        final = paper_trading._load_account()
        print(json.dumps({"probe": "two_read_modify_write_interleaving", "expected_orders": 2, "actual_orders": len(final["orders"]), "remaining_ids": [row["id"] for row in final["orders"]]}))
finally:
    paper_trading.PAPER_ACCOUNT_PATH = original
