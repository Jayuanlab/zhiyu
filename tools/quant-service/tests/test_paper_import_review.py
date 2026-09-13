import json
import tempfile
import unittest
from pathlib import Path
from app.paper_import_review import review_file, review_snapshot
from app.paper_ledger_model import validate_state, PaperLedgerError


class ImportReviewTests(unittest.TestCase):
    def snapshot(self):
        return {"id": "fixture", "initial_cash": "1000.00", "cash": "900.00", "frozen_cash": "0.00",
                "realized_pnl": "-2.00", "created_at": "2026-09-08T10:00:00+08:00",
                "updated_at": "2026-09-08T10:00:00+08:00", "orders": [], "fills": [], "lots": []}

    def test_residual_is_evidence_not_permission(self):
        report = review_snapshot(json.dumps(self.snapshot()).encode())
        self.assertEqual(report["evidence"]["unexplainedCash"], "-100.00")
        self.assertEqual(report["evidence"]["unexplainedRealizedPnl"], "-2.00")
        self.assertFalse(report["importAllowed"])
        self.assertEqual(report["validation"]["status"], "rejected")

    def test_source_hash_and_read_only(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "account.json"
            raw = json.dumps(self.snapshot()).encode()
            path.write_bytes(raw)
            before = path.stat().st_mtime_ns
            first = review_file(path)
            self.assertEqual(first, review_file(path))
            self.assertEqual(path.read_bytes(), raw)
            self.assertEqual(path.stat().st_mtime_ns, before)
            self.assertNotEqual(first["sourceHash"], review_snapshot(raw + b" ")["sourceHash"])

    def test_malformed_never_becomes_approved(self):
        for raw in (b"null", b"[]", b"{", b"{}", b"\xff"):
            report = review_snapshot(raw)
            self.assertFalse(report["importAllowed"])
            self.assertIn("evidenceUnavailable", report)

    def test_recovery_proposal_preserves_history_and_requires_explicit_review(self):
        state = self.snapshot()
        state['restore'] = {'source':'isolated snapshot'}
        state['lots'] = [{'id':'recovered', 'code':'159278.SZ', 'quantity':100, 'remaining_quantity':100,
                          'cost_price':'1.000', 'created_at':state['created_at'], 'trade_date':'2026-09-08',
                          'restore_source':'isolated snapshot'}]
        raw = json.dumps(state).encode()
        report = review_snapshot(raw)
        self.assertEqual(report['openingProposal']['status'], 'needs_owner_review')
        self.assertFalse(report['openingProposal']['sourceVerified'])
        self.assertFalse(report['importAllowed'])
        baseline = report['openingProposal']['baseline']
        self.assertEqual(validate_state(state, opening=baseline)['fills'], [])
        self.assertEqual(json.dumps(state).encode(), raw)
        with self.assertRaises(PaperLedgerError):
            validate_state(state)
        baseline['lots'][0]['quantity'] = 200
        with self.assertRaisesRegex(PaperLedgerError, 'opening_lot_source_mismatch'):
            validate_state(state, opening=baseline)

    def test_recovery_does_not_hide_invalid_order_or_unbacked_lots(self):
        state = self.snapshot()
        state['restore'] = {'source':'isolated snapshot'}
        state['lots'] = [{'id':'unbacked', 'code':'159278.SZ', 'quantity':100, 'remaining_quantity':100,
                          'cost_price':'1.000', 'created_at':state['created_at'], 'trade_date':'2026-09-08'}]
        self.assertEqual(review_snapshot(json.dumps(state).encode())['openingProposal']['status'], 'rejected')
