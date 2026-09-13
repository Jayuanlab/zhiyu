"""Explicit, reversible-before-cutover paper import. Defaults to validation only."""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.paper_ledger import PaperLedger
from app.paper_ledger_model import PaperLedgerError
from app.paper_import_review import review_file


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--owner-id", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--review", action="store_true", help="Read-only reconciliation evidence; never imports or approves")
    parser.add_argument("--controllers-stopped", action="store_true")
    parser.add_argument("--backup-dir", type=Path)
    parser.add_argument("--migration-batch-id")
    parser.add_argument("--recovery-review-id", help="Previously approved owner review; verification requires database access even in dry-run")
    args = parser.parse_args()
    if args.review:
        if args.apply:
            parser.error("--review cannot be combined with --apply")
        print(json.dumps(review_file(args.source), ensure_ascii=False, indent=2))
        return
    # Dry-run does not connect; no secret is accepted on the command line.
    ledger = PaperLedger(None if args.apply or args.recovery_review_id else "dry-run-no-connection")
    result = ledger.import_file(args.owner_id, args.source, dry_run=not args.apply,
        controllers_stopped=args.controllers_stopped, backup_dir=args.backup_dir,
        migration_batch_id=args.migration_batch_id, recovery_review_id=args.recovery_review_id)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (PaperLedgerError, ValueError) as exc:
        print(json.dumps({"status": "rejected", "reasonCode": str(exc), "accountChanged": False}))
        sys.exit(1)
