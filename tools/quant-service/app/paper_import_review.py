"""Read-only evidence for an owner to reconcile an incomplete legacy ledger.

Residuals are unexplained differences, never authorization or invented fills.
"""
import hashlib
import json
from decimal import Decimal
from pathlib import Path

from .paper_ledger_model import PaperLedgerError, digest, number, quantity, validate_state


def review_snapshot(raw: bytes) -> dict:
    report = {"schemaVersion": 1, "sourceHash": hashlib.sha256(raw).hexdigest(),
              "accountChanged": False, "approval": "not_requested", "importAllowed": False}
    try:
        state = json.loads(raw.decode("utf-8"), parse_float=Decimal)
        validate_state(state)
    except (PaperLedgerError, ValueError, UnicodeError, TypeError) as exc:
        report["validation"] = {"status": "rejected", "reasonCode": str(exc) if isinstance(exc, PaperLedgerError) else "incomplete_or_malformed_account"}
    else:
        report["validation"] = {"status": "valid"}
    try:
        balances = {key: number(state[key]) for key in ("initial_cash", "cash", "frozen_cash", "realized_pnl")}
        fills, lots, orders = state["fills"], state["lots"], state["orders"]
        if any(not isinstance(rows, list) for rows in (fills, lots, orders)):
            raise PaperLedgerError("invalid_collections")
        expected_cash, realized = balances["initial_cash"], Decimal(0)
        holdings, remaining, purchased, original = {}, {}, {}, {}
        for fill in fills:
            if fill["side"] not in {"buy", "sell"}:
                raise PaperLedgerError("invalid_fill_side")
            sign = 1 if fill["side"] == "buy" else -1
            code, qty = fill["code"], quantity(fill["quantity"])
            expected_cash -= sign * number(fill["amount"])
            holdings[code] = holdings.get(code, 0) + sign * qty
            if sign == -1:
                realized += number(fill["realized_pnl"])
            else:
                key = (code, str(number(fill["price"], 3)))
                purchased[key] = purchased.get(key, 0) + qty
        for lot in lots:
            code = lot["code"]
            remaining[code] = remaining.get(code, 0) + quantity(lot["remaining_quantity"])
            key = (code, str(number(lot["cost_price"], 3)))
            original[key] = original.get(key, 0) + quantity(lot["quantity"])
        report["evidence"] = {
            "accountId": state["id"], "balances": {key: str(value) for key, value in balances.items()},
            "counts": {"orders": len(orders), "fills": len(fills), "lots": len(lots)},
            "unexplainedCash": str(balances["cash"] + balances["frozen_cash"] - expected_cash),
            "unexplainedRealizedPnl": str(balances["realized_pnl"] - realized),
            "unexplainedHoldings": [{"code": code, "quantity": remaining.get(code, 0) - holdings.get(code, 0)}
                                    for code in sorted(remaining.keys() | holdings.keys()) if remaining.get(code, 0) != holdings.get(code, 0)],
            "unexplainedOriginalLots": [{"code": key[0], "costPrice": key[1], "quantity": original.get(key, 0) - purchased.get(key, 0)}
                                        for key in sorted(original.keys() | purchased.keys()) if original.get(key, 0) != purchased.get(key, 0)],
        }
    except (KeyError, TypeError, ValueError, UnboundLocalError):
        report["evidenceUnavailable"] = "incomplete_or_malformed_account"
    if "evidence" in report and isinstance(state.get("restore"), dict):
        report["recoverySource"] = {key: state["restore"].get(key) for key in ("source", "restored_at", "reason")}
        try:
            proposal = {"schemaVersion": 1,
                        "cashAdjustment": report["evidence"]["unexplainedCash"],
                        "realizedPnlAdjustment": report["evidence"]["unexplainedRealizedPnl"],
                        "lots": [{"lotId": row["id"], "code": row["code"], "quantity": row["quantity"], "tradeDate": row["trade_date"],
                                  "costPrice": str(number(row["cost_price"], 3)), "source": row["restore_source"]}
                                 for row in state["lots"] if row.get("restore_source")]}
            validate_state(state, opening=proposal)
        except (KeyError, TypeError, ValueError) as exc:
            report["openingProposal"] = {"status": "rejected", "reasonCode": str(exc) if isinstance(exc, PaperLedgerError) else "incomplete_or_malformed_account"}
        else:
            report["openingProposal"] = {"status": "needs_owner_review", "baseline": proposal,
                                         "sourceVerified": False, "historicalPerformanceComplete": False}
    report["reviewHash"] = digest(report)
    return report


def review_file(source: Path) -> dict:
    raw = source.read_bytes()
    report = review_snapshot(raw)
    if source.read_bytes() != raw:
        raise PaperLedgerError("import_source_changed")
    return report
