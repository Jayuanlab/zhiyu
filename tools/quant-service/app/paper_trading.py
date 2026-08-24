from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import uuid
from datetime import datetime, time, timezone, timedelta
from pathlib import Path
from time import perf_counter
from typing import Any

from .provider import (
    QuantProviderError,
    assert_live_quant_control_available,
    quick_watchlist_quote_map,
)

CN_TZ = timezone(timedelta(hours=8))
PAPER_ACCOUNT_PATH = Path(__file__).resolve().parents[1] / "data" / "paper_account.json"
INITIAL_CASH = 1_000_000.0
DEFAULT_MAX_BUY_DEVIATION_PCT = 2.0


def _paper_trading_enabled() -> bool:
    value = os.getenv("QUANT_PAPER_TRADING_ENABLED", "true").strip().lower()
    return value not in {"0", "false", "no", "off", "disabled"}


class PaperTradingError(ValueError):
    pass


def _elapsed_ms(start: float) -> float:
    return round((perf_counter() - start) * 1000, 1)


def _quant_timing_log_path() -> Path:
    raw = os.getenv("QUANT_TIMING_LOG_PATH", "").strip()
    if raw:
        return Path(raw)
    return Path(__file__).resolve().parents[1] / "quant-timing.log"


def _log_quant_timing(operation: str, start: float, **fields: Any) -> None:
    payload = {
        "event": "quant_timing",
        "operation": operation,
        "ms": _elapsed_ms(start),
        **fields,
    }
    line = json.dumps(payload, ensure_ascii=False, default=str)
    print(line, flush=True)
    try:
        log_path = _quant_timing_log_path()
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8") as handle:
            handle.write(f"{line}\n")
    except Exception:
        pass


def get_paper_account() -> dict:
    start = perf_counter()
    load_start = perf_counter()
    account = _load_account()
    _log_quant_timing(
        "paper_account_load",
        load_start,
        lots=len(account.get("lots") or []),
        orders=len(account.get("orders") or []),
    )
    reconcile_start = perf_counter()
    _reconcile_open_orders(account)
    _log_quant_timing(
        "paper_account_reconcile",
        reconcile_start,
        has_open_orders=_has_open_orders(account),
    )
    save_start = perf_counter()
    _save_account(account)
    _log_quant_timing("paper_account_save", save_start)
    view_start = perf_counter()
    view = _account_view(account)
    _log_quant_timing(
        "paper_account_view",
        view_start,
        positions=len(view.get("positions") or []),
        open_orders=len(view.get("open_orders") or []),
    )
    _log_quant_timing(
        "paper_account_total",
        start,
        positions=len(view.get("positions") or []),
        open_orders=len(view.get("open_orders") or []),
    )
    return view


def list_paper_orders(limit: int = 100) -> dict:
    account = _load_account()
    _reconcile_open_orders(account)
    _save_account(account)
    orders = sorted(
        account["orders"],
        key=lambda item: item.get("created_at", ""),
        reverse=True,
    )[: max(1, min(limit, 500))]
    return {"orders": orders}


def list_paper_fills(limit: int = 100) -> dict:
    account = _load_account()
    fills = sorted(
        account["fills"],
        key=lambda item: item.get("filled_at", ""),
        reverse=True,
    )[: max(1, min(limit, 500))]
    return {"fills": fills}


def place_paper_order(input_data: dict[str, Any]) -> dict:
    account = _load_account()
    _reconcile_open_orders(account)
    if not _paper_trading_enabled():
        raise PaperTradingError("模拟盘交易已关闭")
    try:
        assert_live_quant_control_available("Paper order control")
    except QuantProviderError as exc:
        raise PaperTradingError(str(exc)) from exc

    side = str(input_data.get("side") or "").lower()
    if side not in {"buy", "sell"}:
        raise PaperTradingError("side must be buy or sell")

    code = _normalize_code(str(input_data.get("code") or ""))
    quantity = _int(input_data.get("quantity"))
    limit_price = _money(input_data.get("limit_price"))
    planned_price = _money(input_data.get("planned_price"))
    max_buy_deviation_pct = _float(
        input_data.get("max_buy_deviation_pct"), DEFAULT_MAX_BUY_DEVIATION_PCT
    )
    note = str(input_data.get("note") or "").strip()
    strategy = str(input_data.get("strategy") or "").strip()
    actor = str(input_data.get("actor") or "agent").strip() or "agent"

    quote = _quote_for_code(code)
    _validate_order(
        account,
        quote,
        side,
        quantity,
        limit_price,
        planned_price=planned_price,
        max_buy_deviation_pct=max_buy_deviation_pct,
    )

    now = _now()
    order = {
        "id": f"po_{uuid.uuid4().hex[:16]}",
        "code": code,
        "name": quote["name"],
        "side": side,
        "order_type": "limit",
        "quantity": quantity,
        "remaining_quantity": quantity,
        "limit_price": limit_price,
        "planned_price": planned_price if planned_price > 0 else None,
        "max_buy_deviation_pct": max_buy_deviation_pct
        if side == "buy" and planned_price > 0
        else None,
        "status": "submitted",
        "created_at": now.isoformat(timespec="seconds"),
        "updated_at": now.isoformat(timespec="seconds"),
        "submitted_by": actor,
        "note": note,
        "strategy": strategy,
        "reject_reason": None,
        "rule_snapshot": _rule_snapshot(quote),
    }

    if side == "buy":
        account["cash"] = _round_money(account["cash"] - quantity * limit_price)
        account["frozen_cash"] = _round_money(
            account["frozen_cash"] + quantity * limit_price
        )

    account["orders"].append(order)
    _try_fill_order(account, order, quote)
    _touch(account)
    _save_account(account)
    return {"order": order, "account": _account_view(account)}


def cancel_paper_order(order_id: str) -> dict:
    account = _load_account()
    order = _find_order(account, order_id)
    if order["status"] not in {"submitted", "partially_filled"}:
        raise PaperTradingError("Only submitted orders can be cancelled")
    if not _can_cancel_now(order):
        raise PaperTradingError("当前处于交易所不接受撤单的时段")

    if order["side"] == "buy" and order["remaining_quantity"] > 0:
        release = order["remaining_quantity"] * order["limit_price"]
        account["cash"] = _round_money(account["cash"] + release)
        account["frozen_cash"] = _round_money(account["frozen_cash"] - release)

    order["status"] = "cancelled"
    order["updated_at"] = _now().isoformat(timespec="seconds")
    _touch(account)
    _save_account(account)
    return {"order": order, "account": _account_view(account)}


def _load_account() -> dict:
    if PAPER_ACCOUNT_PATH.exists():
        try:
            account = json.loads(PAPER_ACCOUNT_PATH.read_text(encoding="utf-8"))
            return _normalize_account(account)
        except Exception as exc:
            corrupt_path = PAPER_ACCOUNT_PATH.with_suffix(
                f"{PAPER_ACCOUNT_PATH.suffix}.corrupt-{_now().strftime('%Y%m%d%H%M%S')}"
            )
            try:
                shutil.copy2(PAPER_ACCOUNT_PATH, corrupt_path)
            except Exception:
                corrupt_path = PAPER_ACCOUNT_PATH
            raise PaperTradingError(
                f"Paper account file exists but cannot be parsed; preserved at {corrupt_path}"
            ) from exc
    account = {
        "id": "paper-default",
        "mode": "paper",
        "initial_cash": INITIAL_CASH,
        "cash": INITIAL_CASH,
        "frozen_cash": 0.0,
        "realized_pnl": 0.0,
        "lots": [],
        "orders": [],
        "fills": [],
        "created_at": _now().isoformat(timespec="seconds"),
        "updated_at": _now().isoformat(timespec="seconds"),
        "trading_enabled": _paper_trading_enabled(),
    }
    _save_account(account)
    return account


def _normalize_account(account: dict) -> dict:
    account["id"] = str(account.get("id") or "paper-default")
    account.setdefault("mode", "paper")
    account.setdefault("initial_cash", INITIAL_CASH)
    account.setdefault("cash", INITIAL_CASH)
    account.setdefault("frozen_cash", 0.0)
    account.setdefault("realized_pnl", 0.0)
    account.setdefault("lots", [])
    account.setdefault("orders", [])
    account.setdefault("fills", [])
    account.setdefault("created_at", _now().isoformat(timespec="seconds"))
    account.setdefault("updated_at", _now().isoformat(timespec="seconds"))
    account["trading_enabled"] = _paper_trading_enabled()
    return account


def _save_account(account: dict) -> None:
    PAPER_ACCOUNT_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(account, ensure_ascii=False, indent=2)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=PAPER_ACCOUNT_PATH.parent,
        prefix=f".{PAPER_ACCOUNT_PATH.name}.",
        suffix=".tmp",
        delete=False,
    ) as temp_file:
        temp_file.write(payload)
        temp_file.write("\n")
        temp_path = Path(temp_file.name)
    os.replace(temp_path, PAPER_ACCOUNT_PATH)


def _account_view(account: dict) -> dict:
    start = perf_counter()
    quote_start = perf_counter()
    quotes = _quote_map() if _needs_quotes(account) else {}
    _log_quant_timing(
        "paper_account_quote_map",
        quote_start,
        needs_quotes=bool(quotes),
        quote_count=len(quotes),
    )
    positions_start = perf_counter()
    positions = _positions(account, quotes)
    _log_quant_timing(
        "paper_account_positions",
        positions_start,
        positions=len(positions),
    )
    market_value = _round_money(sum(item["market_value"] for item in positions))
    total_asset = _round_money(account["cash"] + account["frozen_cash"] + market_value)
    total_pnl = _round_money(total_asset - account["initial_cash"])
    view = {
        "id": account["id"],
        "mode": "paper",
        "trading_enabled": _paper_trading_enabled(),
        "initial_cash": account["initial_cash"],
        "cash": _round_money(account["cash"]),
        "frozen_cash": _round_money(account["frozen_cash"]),
        "market_value": market_value,
        "total_asset": total_asset,
        "realized_pnl": _round_money(account["realized_pnl"]),
        "total_pnl": total_pnl,
        "total_pnl_pct": round(total_pnl / account["initial_cash"] * 100, 2),
        "positions": positions,
        "open_orders": [
            item
            for item in account["orders"]
            if item["status"] in {"submitted", "partially_filled"}
        ],
        "recent_orders": sorted(
            account["orders"], key=lambda item: item.get("created_at", ""), reverse=True
        )[:20],
        "recent_fills": sorted(
            account["fills"], key=lambda item: item.get("filled_at", ""), reverse=True
        )[:20],
        "rules": {
            "cash": account["initial_cash"],
            "trading": "仅模拟，不连接实盘券商",
            "lot_size": "买入 100 股整数倍；卖出不超过可卖数量",
            "settlement": "T+1，可卖数量不含当日买入",
            "order_type": "第一版只支持限价单",
            "max_single_order_pct": 0.30,
            "max_position_pct": 0.40,
        },
        "updated_at": account["updated_at"],
    }
    _log_quant_timing(
        "paper_account_view_build",
        start,
        positions=len(positions),
        needs_quotes=_needs_quotes(account),
    )
    return view


def _positions(account: dict, quotes: dict[str, dict]) -> list[dict]:
    lots_by_code: dict[str, list[dict]] = {}
    for lot in account["lots"]:
        if lot.get("remaining_quantity", 0) <= 0:
            continue
        lots_by_code.setdefault(lot["code"], []).append(lot)

    frozen_sell = _frozen_sell_quantities(account)
    today = _today()
    positions = []
    for code, lots in lots_by_code.items():
        quantity = sum(_int(lot.get("remaining_quantity")) for lot in lots)
        cost_amount = sum(
            _int(lot.get("remaining_quantity")) * _money(lot.get("cost_price"))
            for lot in lots
        )
        quote = quotes.get(code, {})
        price = _money(quote.get("price")) or _money(lots[-1].get("cost_price"))
        market_value = _round_money(quantity * price)
        cost_price = _money(cost_amount / quantity) if quantity else 0
        available_quantity = sum(
            _int(lot.get("remaining_quantity"))
            for lot in lots
            if str(lot.get("trade_date")) < today
        )
        available_quantity = max(0, available_quantity - frozen_sell.get(code, 0))
        positions.append(
            {
                "code": code,
                "name": str(quote.get("name") or lots[-1].get("name") or code),
                "quantity": quantity,
                "available_quantity": available_quantity,
                "cost_price": cost_price,
                "price": price,
                "market_value": market_value,
                "unrealized_pnl": _round_money((price - cost_price) * quantity),
                "unrealized_pnl_pct": round((price - cost_price) / cost_price * 100, 2)
                if cost_price
                else 0,
            }
        )
    return sorted(positions, key=lambda item: item["market_value"], reverse=True)


def _frozen_sell_quantities(account: dict) -> dict[str, int]:
    result: dict[str, int] = {}
    for order in account["orders"]:
        if order["side"] != "sell":
            continue
        if order["status"] not in {"submitted", "partially_filled"}:
            continue
        result[order["code"]] = result.get(order["code"], 0) + _int(
            order.get("remaining_quantity")
        )
    return result


def _reconcile_open_orders(account: dict) -> None:
    if not _is_matching_session():
        return
    if not _has_open_orders(account):
        return
    try:
        assert_live_quant_control_available("Paper order matching")
    except QuantProviderError as exc:
        for order in account["orders"]:
            if order["status"] in {"submitted", "partially_filled"}:
                order["status_note"] = str(exc)
        return
    quotes = _quote_map()
    changed = False
    for order in account["orders"]:
        if order["status"] not in {"submitted", "partially_filled"}:
            continue
        quote = quotes.get(order["code"])
        if not quote:
            continue
        before = order["status"], order["remaining_quantity"]
        _try_fill_order(account, order, quote)
        changed = changed or before != (order["status"], order["remaining_quantity"])
    if changed:
        _touch(account)


def _try_fill_order(account: dict, order: dict, quote: dict) -> None:
    if not _is_matching_session():
        order["status_note"] = "非连续竞价时段，等待模拟撮合"
        return

    current_price = _money(quote.get("price"))
    if current_price <= 0:
        order["status_note"] = "行情价格不可用，等待下一次撮合"
        return

    marketable = (
        order["side"] == "buy" and order["limit_price"] >= current_price
    ) or (order["side"] == "sell" and order["limit_price"] <= current_price)
    if not marketable:
        order["status_note"] = "限价未触发，等待价格满足"
        return

    quantity = _int(order["remaining_quantity"])
    fill_price = current_price
    fill_amount = _round_money(quantity * fill_price)
    fill = {
        "id": f"pf_{uuid.uuid4().hex[:16]}",
        "order_id": order["id"],
        "code": order["code"],
        "name": order["name"],
        "side": order["side"],
        "quantity": quantity,
        "price": fill_price,
        "amount": fill_amount,
        "filled_at": _now().isoformat(timespec="seconds"),
        "note": order.get("note") or "",
        "strategy": order.get("strategy") or "",
    }

    if order["side"] == "buy":
        reserved = quantity * order["limit_price"]
        account["frozen_cash"] = _round_money(account["frozen_cash"] - reserved)
        account["cash"] = _round_money(account["cash"] + reserved - fill_amount)
        account["lots"].append(
            {
                "id": f"lot_{uuid.uuid4().hex[:16]}",
                "code": order["code"],
                "name": order["name"],
                "quantity": quantity,
                "remaining_quantity": quantity,
                "cost_price": fill_price,
                "trade_date": _today(),
                "created_at": fill["filled_at"],
            }
        )
    else:
        realized = _consume_lots(account, order["code"], quantity, fill_price)
        account["cash"] = _round_money(account["cash"] + fill_amount)
        account["realized_pnl"] = _round_money(account["realized_pnl"] + realized)
        fill["realized_pnl"] = _round_money(realized)

    order["remaining_quantity"] = 0
    order["status"] = "filled"
    order["updated_at"] = fill["filled_at"]
    order["status_note"] = "已按当前行情模拟成交"
    account["fills"].append(fill)


def _consume_lots(account: dict, code: str, quantity: int, sell_price: float) -> float:
    left = quantity
    realized = 0.0
    today = _today()
    for lot in sorted(account["lots"], key=lambda item: item.get("created_at", "")):
        if left <= 0:
            break
        if lot.get("code") != code or str(lot.get("trade_date")) >= today:
            continue
        available = _int(lot.get("remaining_quantity"))
        consume = min(left, available)
        if consume <= 0:
            continue
        lot["remaining_quantity"] = available - consume
        realized += consume * (sell_price - _money(lot.get("cost_price")))
        left -= consume
    if left > 0:
        raise PaperTradingError("可卖数量不足")
    return realized


def _validate_order(
    account: dict,
    quote: dict,
    side: str,
    quantity: int,
    limit_price: float,
    *,
    planned_price: float = 0.0,
    max_buy_deviation_pct: float = DEFAULT_MAX_BUY_DEVIATION_PCT,
) -> None:
    if quantity <= 0:
        raise PaperTradingError("委托数量必须大于 0")
    if limit_price <= 0:
        raise PaperTradingError("限价必须大于 0")
    if quantity % 100 != 0:
        raise PaperTradingError("第一版模拟盘要求委托数量为 100 股整数倍")

    lower, upper = _price_limits(quote)
    if limit_price < lower or limit_price > upper:
        raise PaperTradingError(
            "限价超出涨跌幅限制范围："
            f"{_format_price(lower, quote['code'])} - {_format_price(upper, quote['code'])}"
        )

    if side == "buy":
        if planned_price > 0:
            if max_buy_deviation_pct < 0:
                raise PaperTradingError("max buy deviation cannot be negative")
            max_executable_price = _money(
                planned_price * (1 + max_buy_deviation_pct / 100)
            )
            if limit_price > max_executable_price:
                raise PaperTradingError(
                    "buy limit price exceeds planned price tolerance: "
                    f"planned={_format_price(planned_price, quote['code'])}, "
                    f"max={_format_price(max_executable_price, quote['code'])}, "
                    f"limit={_format_price(limit_price, quote['code'])}"
                )
        required = quantity * limit_price
        if required > account["cash"]:
            raise PaperTradingError("可用现金不足")
        max_order_value = account["initial_cash"] * 0.30
        if required > max_order_value:
            raise PaperTradingError(
                "单笔买入金额超过模拟盘 "
                "30% 风控上限"
            )
        holding_value = _position_market_value(account, quote["code"])
        max_position_value = account["initial_cash"] * 0.40
        if holding_value + required > max_position_value:
            raise PaperTradingError(
                "单票仓位超过模拟盘 "
                "40% 风控上限"
            )
    else:
        available = _available_quantity(account, quote["code"])
        if quantity > available:
            raise PaperTradingError("可卖数量不足，模拟盘执行 T+1 规则")


def _available_quantity(account: dict, code: str) -> int:
    today = _today()
    quantity = sum(
        _int(lot.get("remaining_quantity"))
        for lot in account["lots"]
        if lot.get("code") == code and str(lot.get("trade_date")) < today
    )
    return max(0, quantity - _frozen_sell_quantities(account).get(code, 0))


def _position_market_value(account: dict, code: str) -> float:
    quote = _quote_for_code(code)
    price = _money(quote.get("price"))
    quantity = sum(
        _int(lot.get("remaining_quantity"))
        for lot in account["lots"]
        if lot.get("code") == code
    )
    return quantity * price


def _price_limits(quote: dict) -> tuple[float, float]:
    price = _money(quote.get("price"))
    change_pct = float(quote.get("change_pct") or 0)
    prev_close = price / (1 + change_pct / 100) if price and change_pct != -100 else price
    pct = _limit_pct(str(quote.get("code") or ""))
    precision = _price_precision(str(quote.get("code") or ""))
    return round(prev_close * (1 - pct), precision), round(
        prev_close * (1 + pct),
        precision,
    )


def _price_precision(code: str) -> int:
    symbol = code.split(".", 1)[0]
    if re.match(r"^(159|16|18|50|51|52|56|58)\d{3}$", symbol):
        return 3
    return 2


def _format_price(value: float, code: str) -> str:
    return f"{value:.{_price_precision(code)}f}"


def _limit_pct(code: str) -> float:
    symbol = code.split(".", 1)[0]
    if code.endswith(".BJ") or symbol.startswith(("4", "8")):
        return 0.30
    if symbol.startswith(("300", "301", "688")):
        return 0.20
    return 0.10


def _rule_snapshot(quote: dict) -> dict:
    lower, upper = _price_limits(quote)
    return {
        "price_limit_lower": lower,
        "price_limit_upper": upper,
        "price_precision": _price_precision(str(quote.get("code") or "")),
        "lot_size": 100,
        "settlement": "T+1",
        "trading_enabled": _paper_trading_enabled(),
        "paper_only": True,
        "default_max_buy_deviation_pct": DEFAULT_MAX_BUY_DEVIATION_PCT,
    }


def _quote_map() -> dict[str, dict]:
    start = perf_counter()
    quotes = quick_watchlist_quote_map()
    _log_quant_timing(
        "paper_account_quick_quote_map",
        start,
        quote_count=len(quotes),
    )
    return quotes


def _needs_quotes(account: dict) -> bool:
    return any(_int(lot.get("remaining_quantity")) > 0 for lot in account["lots"]) or _has_open_orders(account)


def _has_open_orders(account: dict) -> bool:
    return any(
        order.get("status") in {"submitted", "partially_filled"}
        for order in account["orders"]
    )


def _quote_for_code(code: str) -> dict:
    quote = _quote_map().get(code)
    if not quote:
        raise PaperTradingError("只能交易当前自选股中的股票")
    return quote


def _find_order(account: dict, order_id: str) -> dict:
    for order in account["orders"]:
        if order.get("id") == order_id:
            return order
    raise PaperTradingError("订单不存在")


def _normalize_code(code: str) -> str:
    compact = code.strip().upper().replace(" ", "")
    if "." in compact:
        symbol, exchange = compact.split(".", 1)
        if symbol.isdigit() and len(symbol) == 6 and exchange in {"SH", "SZ", "BJ"}:
            return f"{symbol}.{exchange}"
    if compact.isdigit() and len(compact) == 6:
        if compact.startswith(("6", "9")):
            return f"{compact}.SH"
        if compact.startswith(("0", "2", "3")):
            return f"{compact}.SZ"
        if compact.startswith(("4", "8")):
            return f"{compact}.BJ"
    raise PaperTradingError("股票代码格式无效")


def _is_matching_session() -> bool:
    now = _now()
    if now.weekday() >= 5:
        return False
    current = now.time()
    return time(9, 30) <= current <= time(11, 30) or time(13, 0) <= current <= time(15, 0)


def _can_cancel_now(order: dict) -> bool:
    if order.get("status_note") == "非连续竞价时段，等待模拟撮合":
        return True
    current = _now().time()
    return not (time(9, 20) <= current <= time(9, 25) or time(14, 57) <= current <= time(15, 0))


def _now() -> datetime:
    return datetime.now(CN_TZ)


def _today() -> str:
    return _now().date().isoformat()


def _touch(account: dict) -> None:
    account["updated_at"] = _now().isoformat(timespec="seconds")


def _int(value: Any) -> int:
    try:
        return int(value)
    except Exception:
        return 0


def _money(value: Any) -> float:
    try:
        return round(float(value), 3)
    except Exception:
        return 0.0


def _float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _round_money(value: float) -> float:
    return round(value, 2)
