"""Exact persisted paper state, independent of market/network/storage adapters."""
from __future__ import annotations

import hashlib
import json
from datetime import date, datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any


class PaperLedgerError(ValueError):
    pass


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                      allow_nan=False, default=lambda x: str(x) if isinstance(x, Decimal) else _unsupported(x))


def _unsupported(value):
    raise TypeError(f"Unsupported ledger value: {type(value).__name__}")


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def state_digest(state: dict) -> str:
    return digest({**state, **{key: sorted(state[key], key=lambda row: row["id"])
                             for key in ("orders", "lots", "fills")}})


def number(value, places=2) -> Decimal:
    if value is None or isinstance(value, bool):
        raise PaperLedgerError("invalid_decimal")
    try:
        result = Decimal(str(value))
        if not result.is_finite() or abs(result) >= Decimal(10) ** 20:
            raise PaperLedgerError("invalid_decimal")
        rounded = result.quantize(Decimal(1).scaleb(-places))
        if rounded != result:
            raise PaperLedgerError("excess_decimal_precision")
        return rounded
    except (InvalidOperation, ValueError) as exc:
        raise PaperLedgerError("invalid_decimal") from exc


def cash_round(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def quantity(value) -> int:
    result = number(value, 0)
    if result < 0 or result > 2**53 - 1:
        raise PaperLedgerError("invalid_quantity")
    return int(result)


def timestamp(value):
    try:
        result = datetime.fromisoformat(value)
        if result.tzinfo is None or result.utcoffset() is None:
            raise ValueError()
        return result
    except (TypeError, ValueError) as exc:
        raise PaperLedgerError("timestamp_requires_timezone") from exc


def _rows(state, key):
    rows = state[key]
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise PaperLedgerError(f"invalid_{key}")
    ids = [row.get("id") for row in rows]
    if any(not isinstance(x, str) or not x.strip() for x in ids) or len(set(ids)) != len(ids):
        raise PaperLedgerError(f"duplicate_or_missing_{key}_id")
    return rows


def validate_state(raw: dict, *, opening: dict | None = None) -> dict:
    """No defaults or account reset. Return a detached state with exact monetary values."""
    try:
        state = json.loads(canonical(raw))
        if not isinstance(state, dict) or not isinstance(state.get("id"), str) or not state["id"]:
            raise PaperLedgerError("invalid_account")
        for field in ("initial_cash", "cash", "frozen_cash", "realized_pnl"):
            state[field] = number(state[field])
        if state["initial_cash"] <= 0 or min(state["cash"], state["frozen_cash"]) < 0:
            raise PaperLedgerError("invalid_balance")
        for field in ("created_at", "updated_at"):
            timestamp(state[field])
        orders = _rows(state, "orders")
        fills = _rows(state, "fills")
        lots = _rows(state, "lots")
        order_map = {row["id"]: row for row in orders}
        opening_cash, opening_realized = Decimal(0), Decimal(0)
        opening_holdings, opening_lots = {}, {}
        if opening is not None:
            # Explicit review-only input; ordinary reads/imports do not opt in.
            if not isinstance(opening, dict) or opening.get("schemaVersion") != 1:
                raise PaperLedgerError("invalid_opening_baseline")
            opening_cash = number(opening["cashAdjustment"])
            opening_realized = number(opening["realizedPnlAdjustment"])
            lot_map = {row["id"]: row for row in lots}
            seen = set()
            for item in opening["lots"]:
                lot = lot_map.get(item["lotId"])
                if not lot or item["lotId"] in seen or not lot.get("restore_source"):
                    raise PaperLedgerError("opening_lot_requires_unique_restore_source")
                seen.add(item["lotId"])
                qty, price = quantity(item["quantity"]), number(item["costPrice"], 3)
                if (qty <= 0 or qty != quantity(lot["quantity"]) or price != number(lot["cost_price"], 3)
                        or item["code"] != lot["code"] or item["source"] != lot["restore_source"]):
                    raise PaperLedgerError("opening_lot_source_mismatch")
                code = lot["code"]
                opening_holdings[code] = opening_holdings.get(code, 0) + qty
                key = (code, price)
                opening_lots[key] = opening_lots.get(key, 0) + qty
        reserved = Decimal(0)
        frozen_sell = {}
        for row in orders:
            if row["side"] not in {"buy", "sell"} or row["status"] not in {
                "submitted", "partially_filled", "filled", "cancelled", "rejected"
            } or not isinstance(row["code"], str) or not row["code"]:
                raise PaperLedgerError("invalid_order")
            row["quantity"], row["remaining_quantity"] = quantity(row["quantity"]), quantity(row["remaining_quantity"])
            row["limit_price"] = number(row["limit_price"], 3)
            if row["quantity"] <= 0 or row["remaining_quantity"] > row["quantity"] or row["limit_price"] <= 0:
                raise PaperLedgerError("invalid_order_quantity_or_price")
            for key in ("created_at", "updated_at"):
                timestamp(row[key])
            if row["status"] == "filled" and row["remaining_quantity"] != 0:
                raise PaperLedgerError("filled_order_has_remaining_quantity")
            if row["status"] in {"submitted", "partially_filled"}:
                if row["remaining_quantity"] == 0:
                    raise PaperLedgerError("open_order_has_no_remaining_quantity")
                if row["side"] == "buy":
                    reserved += cash_round(row["limit_price"] * row["remaining_quantity"])
                else:
                    frozen_sell[row["code"]] = frozen_sell.get(row["code"], 0) + row["remaining_quantity"]
        if reserved != state["frozen_cash"]:
            raise PaperLedgerError("frozen_cash_does_not_match_orders")
        net_cash = state["initial_cash"] + opening_cash
        filled_quantities, holdings, realized = {}, dict(opening_holdings), opening_realized
        purchased_lots = dict(opening_lots)
        for row in fills:
            order = order_map.get(row["order_id"])
            if not order or row["code"] != order["code"] or row["side"] != order["side"]:
                raise PaperLedgerError("fill_order_mismatch")
            row["quantity"] = quantity(row["quantity"])
            row["price"], row["amount"] = number(row["price"], 3), number(row["amount"])
            if row["quantity"] <= 0 or row["price"] <= 0 or row["amount"] != cash_round(row["price"] * row["quantity"]):
                raise PaperLedgerError("fill_amount_mismatch")
            if ((row["side"] == "buy" and row["price"] > order["limit_price"]) or
                    (row["side"] == "sell" and row["price"] < order["limit_price"])):
                raise PaperLedgerError("fill_exceeds_limit_price")
            timestamp(row["filled_at"])
            sign = 1 if row["side"] == "buy" else -1
            net_cash -= sign * row["amount"]
            holdings[row["code"]] = holdings.get(row["code"], 0) + sign * row["quantity"]
            filled_quantities[order["id"]] = filled_quantities.get(order["id"], 0) + row["quantity"]
            if row["side"] == "buy":
                lot_key = (row["code"], row["price"])
                purchased_lots[lot_key] = purchased_lots.get(lot_key, 0) + row["quantity"]
            if row["side"] == "sell":
                row["realized_pnl"] = number(row["realized_pnl"])
                realized += row["realized_pnl"]
        if net_cash != state["cash"] + state["frozen_cash"] or realized != state["realized_pnl"]:
            raise PaperLedgerError("cash_or_realized_pnl_not_conserved")
        for order in orders:
            if filled_quantities.get(order["id"], 0) != order["quantity"] - order["remaining_quantity"]:
                raise PaperLedgerError("order_fill_quantity_mismatch")
            filled = filled_quantities.get(order["id"], 0)
            if ((order["status"] in {"submitted", "rejected"} and filled != 0) or
                    (order["status"] == "partially_filled" and not 0 < filled < order["quantity"])):
                raise PaperLedgerError("order_status_fill_mismatch")
        remaining, original_lots = {}, {}
        for row in lots:
            row["quantity"], row["remaining_quantity"] = quantity(row["quantity"]), quantity(row["remaining_quantity"])
            row["cost_price"] = number(row["cost_price"], 3)
            if row["quantity"] <= 0 or row["remaining_quantity"] > row["quantity"] or row["cost_price"] <= 0:
                raise PaperLedgerError("invalid_lot")
            date.fromisoformat(row["trade_date"])
            timestamp(row["created_at"])
            remaining[row["code"]] = remaining.get(row["code"], 0) + row["remaining_quantity"]
            lot_key = (row["code"], row["cost_price"])
            original_lots[lot_key] = original_lots.get(lot_key, 0) + row["quantity"]
        if original_lots != purchased_lots:
            raise PaperLedgerError("position_cost_basis_does_not_match_fills")
        if any(holdings.get(code, 0) != remaining.get(code, 0) for code in holdings.keys() | remaining.keys()):
            raise PaperLedgerError("positions_not_conserved")
        if any(amount > remaining.get(code, 0) for code, amount in frozen_sell.items()):
            raise PaperLedgerError("sell_reservation_exceeds_position")
        return state
    except (KeyError, TypeError, ValueError) as exc:
        if isinstance(exc, PaperLedgerError):
            raise
        raise PaperLedgerError("incomplete_or_malformed_account") from exc


def validate_transition(before: dict, after: dict):
    if before.get('recovery_baseline') != after.get('recovery_baseline'):
        raise PaperLedgerError('immutable_recovery_baseline')
    for key in ("id", "initial_cash", "created_at"):
        if before[key] != after[key]:
            raise PaperLedgerError("immutable_account_identity")
    for collection in ("orders", "lots", "fills"):
        following = {row["id"]: row for row in after[collection]}
        for old in before[collection]:
            new = following.get(old["id"])
            if new is None:
                raise PaperLedgerError("ledger_history_cannot_be_deleted")
            mutable = ({"status", "remaining_quantity", "updated_at", "status_note", "reject_reason", "lastMatchedQuoteId", "calendarVersion"}
                       if collection == "orders" else {"remaining_quantity"} if collection == "lots" else set())
            if {k: v for k, v in old.items() if k not in mutable} != {k: v for k, v in new.items() if k not in mutable}:
                raise PaperLedgerError("ledger_history_cannot_be_rewritten")
            if collection != "fills" and new["remaining_quantity"] > old["remaining_quantity"]:
                raise PaperLedgerError("remaining_quantity_cannot_increase")
            if collection == "orders" and old["status"] in {"filled", "cancelled", "rejected"} and new != old:
                raise PaperLedgerError("terminal_order_is_immutable")
