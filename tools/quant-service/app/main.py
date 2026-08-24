from __future__ import annotations

import os

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .paper_trading import (
    PaperTradingError,
    cancel_paper_order,
    get_paper_account,
    list_paper_fills,
    list_paper_orders,
    place_paper_order,
)
from .provider import (
    QuantProviderError,
    assert_watchlist_control_available,
    get_market_overview_status,
    get_watchlist_config,
    quant_dashboard,
    quant_market_candidates,
    refresh_market_overview_background,
    save_watchlist_codes,
)
from .storage_diagnostics import get_storage_diagnostics

app = FastAPI(title="Zhiyu Quant Service", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:3515", "http://localhost:3515"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


class WatchlistConfigRequest(BaseModel):
    codes: list[str]
    items: list[dict] | None = None


class PaperOrderRequest(BaseModel):
    code: str
    side: str
    quantity: int
    limit_price: float
    planned_price: float | None = None
    max_buy_deviation_pct: float | None = None
    note: str | None = None
    strategy: str | None = None
    actor: str | None = None


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "service": "quant-service",
        "mode": os.getenv("QUANT_DATA_PROVIDER", "auto"),
    }


@app.get("/storage/diagnostics")
def storage_diagnostics() -> dict:
    return get_storage_diagnostics()


@app.get("/dashboard")
def dashboard() -> dict:
    return quant_dashboard()


@app.get("/market/overview")
def market_overview() -> dict:
    return quant_dashboard()["market"]


@app.get("/market/overview/status")
def market_overview_status() -> dict:
    return get_market_overview_status()


@app.post("/market/overview/refresh")
def market_overview_refresh() -> dict:
    return refresh_market_overview_background(force=True)


@app.get("/market/candidates")
def market_candidates(
    theme: str = "",
    limit: int = 20,
    min_turnover_billion: float = 0.3,
    exclude_watchlist: bool = True,
    exclude_st: bool = True,
) -> dict:
    return quant_market_candidates(
        theme=theme,
        limit=limit,
        min_turnover_billion=min_turnover_billion,
        exclude_watchlist=exclude_watchlist,
        exclude_st=exclude_st,
    )


@app.get("/watchlist")
def watchlist() -> dict:
    return {"items": quant_dashboard()["watchlist"]}


@app.get("/watchlist/config")
def watchlist_config() -> dict:
    return get_watchlist_config()


@app.put("/watchlist/config")
def update_watchlist_config(request: WatchlistConfigRequest) -> dict:
    try:
        assert_watchlist_control_available()
        return save_watchlist_codes(request.codes, request.items)
    except QuantProviderError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/signals/today")
def signals_today() -> dict:
    return {"items": quant_dashboard()["signals"]}


@app.get("/portfolio")
def portfolio() -> dict:
    return quant_dashboard()["portfolio"]


@app.get("/paper/account")
def paper_account() -> dict:
    return get_paper_account()


@app.get("/paper/orders")
def paper_orders(limit: int = 100) -> dict:
    return list_paper_orders(limit)


@app.get("/paper/fills")
def paper_fills(limit: int = 100) -> dict:
    return list_paper_fills(limit)


@app.post("/paper/orders")
def paper_order(request: PaperOrderRequest) -> dict:
    try:
        return place_paper_order(request.model_dump())
    except PaperTradingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/paper/orders/{order_id}/cancel")
def paper_order_cancel(order_id: str) -> dict:
    try:
        return cancel_paper_order(order_id)
    except PaperTradingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/reports/daily")
def daily_report() -> dict:
    return quant_dashboard()["daily_report"]
