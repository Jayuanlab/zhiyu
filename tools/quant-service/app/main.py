from __future__ import annotations

import os

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from .internal_auth import authorized
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .paper_trading import (
    PaperTradingError,
    cancel_paper_order,
    get_paper_account,
    read_paper_account,
    list_paper_fills,
    list_paper_orders,
    place_paper_order,
)
from .provider import (
    QuantProviderError,
    assert_watchlist_control_available,
    get_market_overview_status,
    get_market_universe_status,
    get_watchlist_config,
    quant_dashboard,
    quant_market_candidates,
    refresh_market_universe,
    refresh_market_overview_background,
    save_watchlist_codes,
)
from .storage_diagnostics import get_storage_diagnostics
from .tdx_local import get_tdx_local_status
from .paper_api import router as paper_router

app = FastAPI(title="Zhiyu Quant Service", version="0.1.0")
app.include_router(paper_router)


@app.middleware("http")
async def internal_write_boundary(request: Request, call_next):
    # Retain credentials on legacy account/order reads even after making them pure.
    requires_auth = request.method not in ("GET", "HEAD", "OPTIONS") or request.url.path in ("/paper/account", "/paper/orders", "/paper/fills")
    if requires_auth and not authorized(request.headers.get("authorization")):
        return JSONResponse({"detail": "Internal credential required"}, status_code=401)
    return await call_next(request)

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


@app.get("/market/universe/status")
def market_universe_status() -> dict:
    return get_market_universe_status()


@app.get("/market/tdx/status")
def market_tdx_status() -> dict:
    return get_tdx_local_status()


@app.post("/market/universe/refresh")
def market_universe_refresh(provider: str = "auto", theme: str = "") -> dict:
    try:
        return refresh_market_universe(provider=provider, theme=theme)
    except QuantProviderError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/market/candidates")
def market_candidates(
    theme: str = "",
    limit: int = 20,
    min_turnover_billion: float = 0.3,
    exclude_watchlist: bool = True,
    exclude_st: bool = True,
    refresh_dynamic: bool = False,
) -> dict:
    return quant_market_candidates(
        theme=theme,
        limit=limit,
        min_turnover_billion=min_turnover_billion,
        exclude_watchlist=exclude_watchlist,
        exclude_st=exclude_st,
        refresh_dynamic=refresh_dynamic,
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


@app.get("/paper/account/view")
def paper_account_view() -> dict:
    try:
        return read_paper_account()
    except PaperTradingError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/paper/account")
def paper_account() -> dict:
    try:
        return get_paper_account()
    except PaperTradingError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/paper/orders")
def paper_orders(limit: int = 100) -> dict:
    try:
        return list_paper_orders(limit)
    except PaperTradingError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/paper/fills")
def paper_fills(limit: int = 100) -> dict:
    try:
        return list_paper_fills(limit)
    except PaperTradingError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


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
