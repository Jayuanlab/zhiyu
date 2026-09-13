"""Paper trading domain commands. External observations are fetched before account locks."""
from __future__ import annotations

import copy
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Callable

from .paper_ledger import PaperLedger
from .paper_ledger_model import PaperLedgerError, number, quantity, cash_round, timestamp, canonical

CN_TZ = timezone(timedelta(hours=8))
OPEN = {"submitted", "partially_filled"}


@dataclass(frozen=True)
class PaperActor:
    # Constructed by the authenticated server boundary, never from order body fields.
    owner_id: str
    actor_id: str
    role: str
    execution: dict | None = None

    def require(self, action):
        allowed = {"submit": {"owner", "trader"}, "cancel": {"owner", "trader"}, "match": {"scheduler"}}
        if not self.actor_id or self.role not in allowed.get(action, set()):
            raise PaperLedgerError("paper_actor_denied")
        if self.role == "trader" and not self.execution:
            raise PaperLedgerError("paper_execution_required")


def normalize_code(value):
    value = str(value).strip().upper()
    if re.fullmatch(r"\d{6}\.(SH|SZ|BJ)", value):
        return value
    if re.fullmatch(r"\d{6}", value):
        market = "SH" if value[0] in "569" else "SZ" if value[0] in "0123" else "BJ" if value[0] in "48" else None
        if market:
            return f"{value}.{market}"
    raise PaperLedgerError("invalid_stock_code")


def precision(code):
    return 3 if re.match(r"^(159|16|18|50|51|52|56|58)\d{3}", code) else 2


def limits(quote):
    code = quote["code"]
    price = number(quote["price"], 3)
    change = number(quote.get("change_pct", 0), 4)
    previous = number(quote["previousClose"], 3) if quote.get("previousClose") is not None else price / (1 + change / 100) if change > -100 else Decimal(0)
    if price <= 0 or previous <= 0:
        raise PaperLedgerError("quote_price_unavailable")
    rate = Decimal("0.30") if code.endswith(".BJ") else Decimal("0.20") if code.startswith(("300", "301", "688")) else Decimal("0.10")
    unit = Decimal(1).scaleb(-precision(code))
    return ((previous * (1 - rate)).quantize(unit, rounding=ROUND_HALF_UP),
            (previous * (1 + rate)).quantize(unit, rounding=ROUND_HALF_UP))


def matching_gate(quote, snapshot, now):
    """Return an explicit refusal; no weekday fallback when calendar/quality is unknown."""
    local = now.astimezone(CN_TZ)
    calendar = snapshot.get("calendar") or {}
    if local.weekday() >= 5:
        return "market_weekend"
    try:
        if not calendar.get("version") or not calendar.get("source") or calendar.get("date") != local.date().isoformat():
            return "calendar_unknown"
        if timestamp(calendar["publishedAt"]) > now or timestamp(calendar["expiresAt"]) <= now:
            return "calendar_stale"
        if calendar.get("isTradingDay") is not True:
            return "market_holiday" if calendar.get("isTradingDay") is False else "calendar_unknown"
    except (KeyError, PaperLedgerError):
        return "calendar_unknown"
    if not (time(9, 30) <= local.time() < time(11, 30) or time(13) <= local.time() < time(15)):
        return "outside_matching_session"
    if not quote or not quote.get("quoteId") or quote.get("qualityStatus") != "ready":
        return "quote_quality_unavailable"
    policy = snapshot.get("quotePolicy") or {}
    source_policy = (policy.get("sources") or {}).get(quote.get("provider"), {})
    if not policy.get("version") or source_policy.get("maxAgeSeconds") is None:
        return "quote_policy_unknown"
    try:
        age_limit = number(source_policy.get("maxAgeSeconds"), 0)
        if not policy.get("version") or age_limit <= 0:
            return "quote_policy_unknown"
        observed = timestamp(quote.get("observedAt"))
        if observed > now:
            return "quote_from_future"
        if quote.get("quoteSessionDate") != local.date().isoformat() or observed.astimezone(CN_TZ).date() != local.date():
            return "quote_session_mismatch"
        if Decimal(str((now - observed).total_seconds())) > age_limit:
            return "quote_stale"
        if number(quote.get("price"), 3) <= 0:
            return "quote_price_unavailable"
    except PaperLedgerError:
        return "quote_quality_unavailable"
    return None


def available(state, code, today, *, excluding=None):
    held = sum(row["remaining_quantity"] for row in state["lots"]
               if row["code"] == code and row["trade_date"] < today)
    frozen = sum(row["remaining_quantity"] for row in state["orders"]
                 if row["code"] == code and row["side"] == "sell" and row["status"] in OPEN and row["id"] != excluding)
    return held - frozen


def current_watchlist(snapshot, code, now):
    try:
        return (bool(snapshot.get("watchlistVersion")) and code in snapshot.get("watchlist", [])
                and timestamp(snapshot.get("watchlistObservedAt")) <= now < timestamp(snapshot.get("watchlistExpiresAt")))
    except PaperLedgerError:
        return False


class PaperTradingService:
    def __init__(self, ledger: PaperLedger, observe: Callable[[], dict], *, clock=None, control_guard=None):
        self.ledger = ledger
        self.observe = observe
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        if control_guard is None:
            from .provider import assert_live_quant_control_available
            from .paper_trading import _paper_trading_enabled
            def guard():
                if not _paper_trading_enabled():
                    raise PaperLedgerError("paper_trading_disabled")
                assert_live_quant_control_available("Paper transaction control")
            control_guard = guard
        self.control_guard = control_guard

    def _observation(self):
        self.control_guard()
        try:
            return copy.deepcopy(self.observe())
        except Exception as exc:
            # Retain pending orders and surface degraded matching; never substitute sample quotes.
            return {"quotes": {}, "warning": type(exc).__name__, "qualityStatus": "unavailable"}

    def _command(self, actor, account, command_id, kind, payload, apply_factory, expected_version=None, *, observation_needed=True):
        actor.require(kind)
        if not isinstance(command_id, str) or not 1 <= len(command_id.strip()) <= 200:
            raise PaperLedgerError("invalid_command")
        intent = {**payload, "actorRole": actor.role}
        execution = actor.execution if actor.role == "trader" else None
        if execution:
            intent["execution"] = {"workshopId": execution["workshopId"], "runId": execution["runId"]}
        replay = self.ledger.replay(actor.owner_id, account, command_id, kind, actor.actor_id, intent, expected_version)
        if replay is not None:
            return replay
        observation = self._observation() if observation_needed else {}
        def apply(state):
            # Recheck the operator switch after any observation delay and account-lock wait.
            # Cancellation must remain available when trading/provider controls are disabled.
            if kind != "cancel":
                self.control_guard()
            now = self.clock()
            timestamp(now.isoformat())
            return apply_factory(state, observation, now)
        def guard(conn):
            conn.execute("SELECT public.paper_assert_execution(%s,%s,%s,%s,%s,%s)", (actor.owner_id,
                execution["workshopId"], execution["runId"], execution["workerId"], execution["token"], execution["policyHash"]))
        return self.ledger.command(actor.owner_id, account, command_id, kind, actor.actor_id, intent, apply,
                                   expected_version=expected_version, observation=observation, transaction_guard=guard if execution else None)

    def submit(self, actor, account, command_id, request, expected_version=None):
        code = normalize_code(request.get("code"))
        side = request.get("side")
        qty = quantity(request.get("quantity"))
        price = number(request.get("limit_price"), precision(code))
        planned = number(request.get("planned_price") or 0, precision(code))
        deviation = number(request.get("max_buy_deviation_pct") if request.get("max_buy_deviation_pct") is not None else 2, 4)
        if side not in {"buy", "sell"} or qty <= 0 or qty % 100 or price <= 0 or planned < 0 or deviation < 0:
            raise PaperLedgerError("invalid_order_parameters")
        payload = {"code": code, "side": side, "quantity": qty, "limit_price": str(price),
                   "planned_price": str(planned), "max_buy_deviation_pct": str(deviation),
                   "note": str(request.get("note") or ""), "strategy": str(request.get("strategy") or ""),
                   "trade_thesis": request.get("trade_thesis")}
        if payload["trade_thesis"] is not None and (not isinstance(payload["trade_thesis"], dict) or len(canonical(payload["trade_thesis"])) > 32000):
            raise PaperLedgerError("invalid_trade_thesis")
        if len(payload["note"]) > 8000 or len(payload["strategy"]) > 1000:
            raise PaperLedgerError("order_description_too_long")
        def apply(state, observation, now):
            try:
                quote = (observation.get("quotes") or {}).get(code)
                if not current_watchlist(observation, code, now):
                    raise PaperLedgerError("not_in_current_watchlist")
                if not quote or quote.get("code") != code:
                    raise PaperLedgerError("quote_price_unavailable")
                lower, upper = limits(quote)
                if not lower <= price <= upper:
                    raise PaperLedgerError("order_outside_price_limits")
                amount = cash_round(qty * price)
                if side == "buy":
                    maximum = (planned * (1 + deviation / 100)).quantize(Decimal("0.001"), rounding=ROUND_HALF_UP)
                    if planned > 0 and price > maximum:
                        raise PaperLedgerError("buy_price_exceeds_plan_tolerance")
                    if amount > state["cash"]:
                        raise PaperLedgerError("insufficient_cash")
                    if amount > state["initial_cash"] * Decimal("0.30"):
                        raise PaperLedgerError("single_order_exceeds_30_percent")
                    held = sum(row["remaining_quantity"] for row in state["lots"] if row["code"] == code)
                    pending = sum(row["remaining_quantity"] * row["limit_price"] for row in state["orders"]
                                  if row["code"] == code and row["side"] == "buy" and row["status"] in OPEN)
                    if held * number(quote["price"], 3) + pending + amount > state["initial_cash"] * Decimal("0.40"):
                        raise PaperLedgerError("position_exceeds_40_percent")
                elif qty > available(state, code, now.astimezone(CN_TZ).date().isoformat()):
                    raise PaperLedgerError("insufficient_t1_sell_quantity")
            except PaperLedgerError as exc:
                return {"status": "rejected", "reasonCode": str(exc)}
            order_id = f"po_{uuid.uuid5(uuid.UUID(account), command_id).hex}"
            order = {**payload, "id": order_id, "quantity": qty, "remaining_quantity": qty,
                     "limit_price": price, "planned_price": planned, "max_buy_deviation_pct": deviation,
                     "name": quote.get("name") or code, "order_type": "limit", "status": "submitted",
                     "created_at": now.isoformat(), "updated_at": now.isoformat(), "submitted_by": actor.actor_id,
                     "status_note": "等待显式撮合", "watchlistVersion": observation["watchlistVersion"],
                     "rule_snapshot": {"version": "paper-rules.v2", "price_limit_lower": str(lower),
                         "price_limit_upper": str(upper), "lot_size": 100, "settlement": "T+1", "paper_only": True}}
            state["orders"].append(order)
            if side == "buy":
                state["cash"] -= amount
                state["frozen_cash"] += amount
            return {"status": "accepted", "order": order}
        return self._command(actor, account, command_id, "submit", payload, apply, expected_version)

    def cancel(self, actor, account, command_id, order_id, expected_version=None, *, reason=None):
        def apply(state, observation, now):
            order = next((row for row in state["orders"] if row["id"] == order_id), None)
            if not order:
                return {"status": "rejected", "reasonCode": "order_not_found"}
            if order["status"] not in OPEN:
                return {"status": "rejected", "reasonCode": "order_not_cancellable"}
            local = now.astimezone(CN_TZ)
            if local.weekday() < 5 and (time(9, 20) <= local.time() <= time(9, 25) or time(14, 57) <= local.time() <= time(15)):
                return {"status": "rejected", "reasonCode": "exchange_cancel_window_closed"}
            if order["side"] == "buy":
                released = cash_round(order["remaining_quantity"] * order["limit_price"])
                state["cash"] += released
                state["frozen_cash"] -= released
            order.update(status="cancelled", updated_at=now.isoformat(), status_note="委托已撤销")
            return {"status": "completed", "order": order}
        return self._command(actor, account, command_id, "cancel", {"orderId": order_id, "reason": reason}, apply, expected_version, observation_needed=False)

    def match_tick(self, actor, account, tick_id):
        def apply(state, observation, now):
            matched, waiting = [], {}
            for order in state["orders"]:
                if order["status"] not in OPEN:
                    continue
                quote = (observation.get("quotes") or {}).get(order["code"])
                reason = matching_gate(quote, observation, now)
                if not reason and not current_watchlist(observation, order["code"], now):
                    reason = "not_in_current_watchlist"
                if not reason and quote.get("code") != order["code"]:
                    reason = "quote_code_mismatch"
                price = number(quote["price"], 3) if not reason else Decimal(0)
                if not reason:
                    try:
                        lower, upper = limits(quote)
                        if not lower <= price <= upper:
                            reason = "quote_outside_price_limits"
                    except PaperLedgerError:
                        reason = "quote_price_unavailable"
                if not reason and ((order["side"] == "buy" and price > order["limit_price"]) or
                                   (order["side"] == "sell" and price < order["limit_price"])):
                    reason = "limit_not_triggered"
                if not reason and order["side"] == "sell" and order["remaining_quantity"] > available(
                        state, order["code"], now.astimezone(CN_TZ).date().isoformat(), excluding=order["id"]):
                    reason = "insufficient_t1_sell_quantity"
                if reason:
                    order.update(status_note=reason, updated_at=now.isoformat())
                    waiting[order["id"]] = reason
                    continue
                self._fill(state, order, quote, now, tick_id, observation["calendar"]["version"])
                matched.append(order["id"])
            state["matching"] = {"lastAttemptAt": now.isoformat(), "lastTickId": tick_id,
                "lastMatchedAt": now.isoformat() if matched else (state.get("matching") or {}).get("lastMatchedAt"),
                "calendarVersion": (observation.get("calendar") or {}).get("version"),
                "quotePolicyVersion": (observation.get("quotePolicy") or {}).get("version"),
                "waiting": waiting, "warning": observation.get("warning")}
            return {"status": "completed", "matched": matched, "waiting": waiting}
        return self._command(actor, account, tick_id, "match", {}, apply)

    @staticmethod
    def _fill(state, order, quote, now, tick_id, calendar_version):
        qty, price = order["remaining_quantity"], number(quote["price"], 3)
        amount = cash_round(qty * price)
        fill_key = f"{tick_id}:{order['id']}"
        fill_id = f"pf_{uuid.uuid5(uuid.NAMESPACE_URL, fill_key).hex}"
        fill = {"id": fill_id, "order_id": order["id"], "execution_key": tick_id, "code": order["code"],
                "name": order["name"], "side": order["side"], "quantity": qty, "price": price,
                "amount": amount, "filled_at": now.isoformat(), "quoteId": quote["quoteId"], "calendarVersion": calendar_version,
                "quoteObservedAt": quote["observedAt"], "note": order.get("note") or "", "strategy": order.get("strategy") or ""}
        if order["side"] == "buy":
            reserved = cash_round(qty * order["limit_price"])
            state["frozen_cash"] -= reserved
            state["cash"] += reserved - amount
            state["lots"].append({"id": f"lot_{fill_id}", "code": order["code"], "name": order["name"],
                "quantity": qty, "remaining_quantity": qty, "cost_price": price,
                "trade_date": now.astimezone(CN_TZ).date().isoformat(), "created_at": now.isoformat()})
        else:
            remaining, cost = qty, Decimal(0)
            for lot in sorted(state["lots"], key=lambda row: (row["created_at"], row["id"])):
                if lot["code"] != order["code"] or lot["trade_date"] >= now.astimezone(CN_TZ).date().isoformat():
                    continue
                consumed = min(remaining, lot["remaining_quantity"])
                lot["remaining_quantity"] -= consumed
                remaining -= consumed
                cost += consumed * lot["cost_price"]
                if not remaining:
                    break
            if remaining:
                raise PaperLedgerError("insufficient_t1_sell_quantity")
            realized = cash_round(amount - cost)
            state["cash"] += amount
            state["realized_pnl"] += realized
            fill["realized_pnl"] = realized
        state["fills"].append(fill)
        order.update(status="filled", remaining_quantity=0, updated_at=now.isoformat(), status_note="已按有效行情模拟成交",
                     lastMatchedQuoteId=quote["quoteId"], calendarVersion=calendar_version)
