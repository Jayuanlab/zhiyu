import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from app import paper_trading as paper


class ReadViewTests(unittest.TestCase):
    def test_recovery_history_is_explicit_in_account_view(self):
        account={"id":"fixture","initial_cash":1000,"cash":1000,"frozen_cash":0,"realized_pnl":0,
                 "lots":[],"fills":[],"orders":[],"updated_at":"2026-09-08T10:00:00+08:00"}
        self.assertTrue(paper._account_view(account,{})['historicalPerformanceComplete'])
        for field in ('restore','recovery_baseline'):
            account[field]={'source':'fixture'}
            self.assertFalse(paper._account_view(account,{})['historicalPerformanceComplete'])
            del account[field]

    def test_missing_and_corrupt_accounts_are_not_created_or_repaired(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "account.json"
            with patch.object(paper, "PAPER_ACCOUNT_PATH", target):
                for read in (paper.read_paper_account, paper.get_paper_account, paper.list_paper_orders, paper.list_paper_fills):
                    with self.assertRaises(paper.PaperTradingError):
                        read()
                self.assertFalse(target.exists())
                target.write_text("broken", encoding="utf-8")
                for read in (paper.read_paper_account, paper.get_paper_account, paper.list_paper_orders, paper.list_paper_fills):
                    with self.assertRaises(paper.PaperTradingError):
                        read()
                self.assertEqual(target.read_text(), "broken")
                self.assertEqual(len(list(Path(directory).iterdir())), 1)

    def test_read_does_not_match_or_save_and_preserves_timestamp(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "account.json"
            target.write_text(json.dumps({"id": "test", "initial_cash": 1000, "cash": 1000, "frozen_cash": 0, "realized_pnl": 0, "lots": [], "fills": [], "updated_at": "2026-09-04T15:00:00+08:00", "orders": [{"status": "submitted"}]}), encoding="utf-8")
            before = target.read_bytes(), target.stat().st_mtime_ns
            with patch.object(paper, "PAPER_ACCOUNT_PATH", target), patch.object(paper, "_account_view", return_value={}), patch.object(paper, "_reconcile_open_orders", side_effect=AssertionError("no matching")), patch.object(paper, "_save_account", side_effect=AssertionError("no saving")):
                self.assertEqual(paper.read_paper_account()["stateChangedAt"], "2026-09-04T15:00:00+08:00")
                self.assertEqual(paper.get_paper_account()["stateChangedAt"], "2026-09-04T15:00:00+08:00")
                self.assertEqual(paper.list_paper_orders(), {"orders": [{"status": "submitted"}]})
                self.assertEqual(paper.list_paper_fills(), {"fills": []})
            self.assertEqual(before, (target.read_bytes(), target.stat().st_mtime_ns))
