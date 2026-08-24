from __future__ import annotations

import os
import contextlib
import io
import json
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from datetime import datetime, timezone, timedelta
from math import isfinite
from pathlib import Path
from time import perf_counter
from threading import Lock
from typing import Any
from urllib.request import Request, urlopen

from .sample_data import quant_dashboard as sample_quant_dashboard

CN_TZ = timezone(timedelta(hours=8))

DEFAULT_WATCHLIST = ["600519.SH", "300750.SZ", "601318.SH", "688981.SH"]
WATCHLIST_CONFIG_PATH = Path(__file__).resolve().parents[1] / "data" / "watchlist.json"
WATCHLIST_UNIVERSE_PATH = (
    Path(__file__).resolve().parents[1] / "data" / "watchlist_universe.json"
)
WATCHLIST_ACTIVE_POOLS = {"core", "trading", "holding"}
WATCHLIST_VISIBLE_POOLS = {"candidate", "core", "trading", "holding"}
WATCHLIST_POOL_LABELS = {
    "candidate": "candidate_pool",
    "core": "core_watchlist",
    "trading": "trading_focus",
    "holding": "holding_tracking",
    "archived": "archived",
}
WATCHLIST_MAX_ACTIVE_SYMBOLS = 30
WATCHLIST_MAX_UNIVERSE_SYMBOLS = 100
INDEX_NAME_BY_CODE = {
    "000001": "上证指数",
    "399001": "深证成指",
    "399006": "创业板指",
    "000300": "沪深300",
}

_CACHE: dict[str, Any] = {"dashboard": None, "expires_at": None}
_MARKET_OVERVIEW_CACHE: dict[str, Any] = {"market": None, "expires_at": None}
_MARKET_OVERVIEW_REFRESH: dict[str, Any] = {
    "future": None,
    "started_at": None,
    "finished_at": None,
    "last_success_at": None,
    "last_error": None,
}
_MARKET_OVERVIEW_LOCK = Lock()
_MARKET_OVERVIEW_EXECUTOR = ThreadPoolExecutor(
    max_workers=1,
    thread_name_prefix="quant-market-overview",
)
_FUNDAMENTAL_CACHE: dict[str, Any] = {"items": {}, "expires_at": None}

FALLBACK_THEME_SEED_POOLS = [
    {
        "key": "ai",
        "aliases": [
            "ai",
            "\u4eba\u5de5\u667a\u80fd",
            "\u667a\u80fd",
            "\u7b97\u529b",
            "\u5927\u6a21\u578b",
            "\u8f6f\u4ef6",
            "\u6570\u636e",
        ],
        "labels": [
            "\u4eba\u5de5\u667a\u80fd",
            "\u7b97\u529b",
            "\u5927\u6a21\u578b",
            "\u8f6f\u4ef6",
        ],
        "codes": [
            "002230.SZ",
            "000977.SZ",
            "688256.SH",
            "603019.SH",
            "002236.SZ",
            "300033.SZ",
            "688111.SH",
            "688008.SH",
            "300496.SZ",
            "002415.SZ",
        ],
    },
    {
        "key": "robot",
        "aliases": [
            "robot",
            "\u673a\u5668\u4eba",
            "\u81ea\u52a8\u5316",
            "\u5de5\u4e1a\u6bcd\u673a",
            "\u667a\u80fd\u5236\u9020",
        ],
        "labels": [
            "\u673a\u5668\u4eba",
            "\u81ea\u52a8\u5316",
            "\u5de5\u4e1a\u6bcd\u673a",
            "\u667a\u80fd\u5236\u9020",
        ],
        "codes": [
            "300024.SZ",
            "300124.SZ",
            "300607.SZ",
            "688017.SH",
            "002747.SZ",
            "603728.SH",
            "300450.SZ",
            "688169.SH",
            "688327.SH",
            "002402.SZ",
        ],
    },
    {
        "key": "semiconductor",
        "aliases": [
            "\u534a\u5bfc\u4f53",
            "\u82af\u7247",
            "\u96c6\u6210\u7535\u8def",
            "\u5149\u523b\u673a",
        ],
        "labels": ["\u534a\u5bfc\u4f53", "\u82af\u7247", "\u96c6\u6210\u7535\u8def"],
        "codes": [
            "688981.SH",
            "688012.SH",
            "603986.SH",
            "002371.SZ",
            "300661.SZ",
            "688072.SH",
            "688521.SH",
            "688126.SH",
            "688099.SH",
            "688008.SH",
        ],
    },
    {
        "key": "medicine",
        "aliases": [
            "\u533b\u836f",
            "\u533b\u7597",
            "\u521b\u65b0\u836f",
            "\u751f\u7269\u533b\u836f",
            "\u533b\u7597\u5668\u68b0",
        ],
        "labels": ["\u533b\u836f", "\u533b\u7597", "\u521b\u65b0\u836f"],
        "codes": [
            "600276.SH",
            "300760.SZ",
            "603259.SH",
            "000538.SZ",
            "300015.SZ",
            "600436.SH",
            "000661.SZ",
            "300122.SZ",
            "688271.SH",
            "600196.SH",
        ],
    },
    {
        "key": "consumption",
        "aliases": [
            "\u6d88\u8d39",
            "\u767d\u9152",
            "\u98df\u54c1\u996e\u6599",
            "\u5bb6\u7535",
            "\u65c5\u6e38",
        ],
        "labels": ["\u6d88\u8d39", "\u767d\u9152", "\u98df\u54c1\u996e\u6599", "\u5bb6\u7535"],
        "codes": [
            "600519.SH",
            "000858.SZ",
            "000333.SZ",
            "600887.SH",
            "000568.SZ",
            "603288.SH",
            "600690.SH",
            "601888.SH",
            "002304.SZ",
            "600809.SH",
        ],
    },
    {
        "key": "new_energy",
        "aliases": [
            "\u65b0\u80fd\u6e90",
            "\u9502\u7535",
            "\u5149\u4f0f",
            "\u50a8\u80fd",
            "\u65b0\u80fd\u6e90\u8f66",
        ],
        "labels": ["\u65b0\u80fd\u6e90", "\u9502\u7535", "\u5149\u4f0f", "\u50a8\u80fd"],
        "codes": [
            "300750.SZ",
            "002594.SZ",
            "601012.SH",
            "300274.SZ",
            "603806.SH",
            "002812.SZ",
            "688223.SH",
            "600438.SH",
            "002459.SZ",
            "300014.SZ",
        ],
    },
    {
        "key": "finance_dividend",
        "aliases": [
            "\u91d1\u878d",
            "\u94f6\u884c",
            "\u4fdd\u9669",
            "\u5238\u5546",
            "\u7ea2\u5229",
            "\u9ad8\u80a1\u606f",
        ],
        "labels": ["\u91d1\u878d", "\u94f6\u884c", "\u4fdd\u9669", "\u7ea2\u5229"],
        "codes": [
            "601318.SH",
            "600036.SH",
            "601398.SH",
            "601288.SH",
            "601166.SH",
            "600919.SH",
            "601328.SH",
            "601939.SH",
            "600000.SH",
            "600030.SH",
        ],
    },
    {
        "key": "defense",
        "aliases": ["\u519b\u5de5", "\u56fd\u9632", "\u822a\u7a7a", "\u822a\u5929"],
        "labels": ["\u519b\u5de5", "\u56fd\u9632", "\u822a\u7a7a\u822a\u5929"],
        "codes": [
            "600760.SH",
            "000768.SZ",
            "600893.SH",
            "002179.SZ",
            "600372.SH",
            "600316.SH",
            "600150.SH",
            "000733.SZ",
            "300034.SZ",
            "688122.SH",
        ],
    },
]


def _paper_trading_enabled() -> bool:
    value = os.getenv("QUANT_PAPER_TRADING_ENABLED", "true").strip().lower()
    return value not in {"0", "false", "no", "off", "disabled"}


class QuantProviderError(RuntimeError):
    pass


def get_watchlist_config() -> dict:
    items, source = _watchlist_items_with_source()
    codes = _active_watchlist_codes(items)
    pool_counts: dict[str, int] = {}
    for item in items:
        pool = str(item.get("pool") or "core")
        pool_counts[pool] = pool_counts.get(pool, 0) + 1
    return {
        "codes": codes,
        "items": items,
        "pool_counts": pool_counts,
        "source": source,
        "path": str(WATCHLIST_CONFIG_PATH),
        "universe_path": str(WATCHLIST_UNIVERSE_PATH),
        "active_pools": sorted(WATCHLIST_ACTIVE_POOLS),
        "visible_pools": sorted(WATCHLIST_VISIBLE_POOLS),
        "max_active_symbols": WATCHLIST_MAX_ACTIVE_SYMBOLS,
        "max_universe_symbols": WATCHLIST_MAX_UNIVERSE_SYMBOLS,
        "trading_enabled": _paper_trading_enabled(),
    }


def save_watchlist_codes(codes: list[str], items: list[dict] | None = None) -> dict:
    if items is not None:
        normalized_items = []
        seen_items = set()
        for raw in items:
            item = _normalize_watchlist_universe_item(raw)
            if item and item["code"] not in seen_items:
                normalized_items.append(item)
                seen_items.add(item["code"])
        if not normalized_items:
            raise ValueError("Watchlist cannot be empty")
        active_codes = _active_watchlist_codes(normalized_items)
        if not active_codes:
            raise ValueError("Active watchlist cannot be empty")
        _write_watchlist_universe_items(normalized_items, source="structured_config")
        WATCHLIST_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        WATCHLIST_CONFIG_PATH.write_text(
            json.dumps({"codes": active_codes}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        invalidate_cache()
        return get_watchlist_config()

    normalized = []
    seen = set()
    for code in codes:
        item = _normalize_watchlist_code(code)
        if not item or item in seen:
            continue
        normalized.append(item)
        seen.add(item)

    if not normalized:
        raise ValueError("Watchlist cannot be empty")
    if len(normalized) > WATCHLIST_MAX_ACTIVE_SYMBOLS:
        raise ValueError(
            f"Active watchlist supports at most {WATCHLIST_MAX_ACTIVE_SYMBOLS} symbols"
        )

    now = _now_iso()
    existing_by_code = {
        item["code"]: item
        for item in _read_watchlist_universe_items()
        if isinstance(item.get("code"), str)
    }
    items = []
    for code in normalized:
        previous = existing_by_code.get(code, {})
        items.append(
            {
                **previous,
                "code": code,
                "pool": "core",
                "status": "active",
                "source": previous.get("source") or "owner",
                "reason": previous.get("reason") or "manual watchlist config",
                "evidence": previous.get("evidence") or [],
                "score": previous.get("score"),
                "confidence": previous.get("confidence"),
                "data_quality": previous.get("data_quality") or "unknown",
                "first_seen_at": previous.get("first_seen_at") or now,
                "last_reviewed_at": now,
                "updated_at": now,
            }
        )
    _write_watchlist_universe_items(items, source="manual_config")
    WATCHLIST_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    WATCHLIST_CONFIG_PATH.write_text(
        json.dumps({"codes": normalized}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    invalidate_cache()
    return get_watchlist_config()


def invalidate_cache() -> None:
    _CACHE["dashboard"] = None
    _CACHE["expires_at"] = None
    _MARKET_OVERVIEW_CACHE["market"] = None
    _MARKET_OVERVIEW_CACHE["expires_at"] = None
    with _MARKET_OVERVIEW_LOCK:
        future = _MARKET_OVERVIEW_REFRESH.get("future")
        if future is not None and hasattr(future, "cancel"):
            future.cancel()
        _MARKET_OVERVIEW_REFRESH["future"] = None
        _MARKET_OVERVIEW_REFRESH["started_at"] = None
        _MARKET_OVERVIEW_REFRESH["finished_at"] = None
        _MARKET_OVERVIEW_REFRESH["last_success_at"] = None
        _MARKET_OVERVIEW_REFRESH["last_error"] = None
    _FUNDAMENTAL_CACHE["items"] = {}
    _FUNDAMENTAL_CACHE["expires_at"] = None


def _now_iso() -> str:
    return datetime.now(CN_TZ).isoformat()


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


def quant_dashboard() -> dict:
    start = perf_counter()
    provider = os.getenv("QUANT_DATA_PROVIDER", "auto").strip().lower()
    if provider == "sample":
        dashboard = sample_quant_dashboard()
        _log_quant_timing(
            "dashboard_total",
            start,
            provider="sample",
            cache_hit=False,
            service_mode=dashboard.get("service_mode"),
        )
        return dashboard

    cached_dashboard = _get_cached_dashboard()
    if cached_dashboard is not None:
        _log_quant_timing(
            "dashboard_total",
            start,
            provider=cached_dashboard.get("data_provider"),
            cache_hit=True,
            service_mode=cached_dashboard.get("service_mode"),
            data_source_detail=cached_dashboard.get("data_source_detail"),
        )
        return cached_dashboard

    provider_errors = []

    if provider in {"auto", "tencent"}:
        try:
            dashboard = tencent_quant_dashboard()
            _set_cached_dashboard(dashboard)
            _log_quant_timing(
                "dashboard_total",
                start,
                provider=dashboard.get("data_provider"),
                cache_hit=False,
                service_mode=dashboard.get("service_mode"),
                data_source_detail=dashboard.get("data_source_detail"),
            )
            return dashboard
        except Exception as exc:
            _log_quant_timing(
                "dashboard_provider_failed",
                start,
                provider="tencent",
                error=_short_provider_error(exc),
            )
            if provider == "tencent":
                raise QuantProviderError(str(exc)) from exc
            provider_errors.append(f"Tencent: {_short_provider_error(exc)}")

    if provider in {"auto", "akshare", "auto_full", "akshare_first"}:
        try:
            dashboard = akshare_quant_dashboard()
            _set_cached_dashboard(dashboard)
            _log_quant_timing(
                "dashboard_total",
                start,
                provider=dashboard.get("data_provider"),
                cache_hit=False,
                service_mode=dashboard.get("service_mode"),
                data_source_detail=dashboard.get("data_source_detail"),
            )
            return dashboard
        except Exception as exc:
            _log_quant_timing(
                "dashboard_provider_failed",
                start,
                provider="akshare",
                error=_short_provider_error(exc),
            )
            if provider == "akshare":
                raise QuantProviderError(str(exc)) from exc
            provider_errors.append(f"AkShare: {_short_provider_error(exc)}")

    if provider in {"auto_full", "akshare_first"}:
        try:
            dashboard = tencent_quant_dashboard(
                provider_error="; ".join(provider_errors) or None,
            )
            _set_cached_dashboard(dashboard)
            _log_quant_timing(
                "dashboard_total",
                start,
                provider=dashboard.get("data_provider"),
                cache_hit=False,
                service_mode=dashboard.get("service_mode"),
                data_source_detail=dashboard.get("data_source_detail"),
                provider_errors=provider_errors,
            )
            return dashboard
        except Exception as exc:
            _log_quant_timing(
                "dashboard_provider_failed",
                start,
                provider="tencent",
                error=_short_provider_error(exc),
            )
            if provider == "tencent":
                raise QuantProviderError(str(exc)) from exc
            provider_errors.append(f"Tencent: {_short_provider_error(exc)}")

    dashboard = sample_quant_dashboard()
    dashboard["provider_error"] = "; ".join(provider_errors) or "No live provider available"
    _apply_configured_watchlist_fallback(dashboard)
    _log_quant_timing(
        "dashboard_total",
        start,
        provider=dashboard.get("data_provider"),
        cache_hit=False,
        service_mode=dashboard.get("service_mode"),
        data_source_detail=dashboard.get("data_source_detail"),
        provider_errors=provider_errors,
    )
    return dashboard


def assert_live_quant_control_available(control_name: str) -> dict:
    provider = os.getenv("QUANT_DATA_PROVIDER", "auto").strip().lower()
    if provider == "sample":
        raise QuantProviderError(
            f"{control_name} is blocked because quant service is running in sample mode."
        )

    dashboard = quant_dashboard()
    if dashboard.get("service_mode") != "live":
        detail = dashboard.get("provider_error") or dashboard.get("data_source_detail")
        raise QuantProviderError(
            f"{control_name} is blocked because live quant observations are unavailable"
            + (f": {detail}" if detail else ".")
        )
    if dashboard.get("watchlist_source") == "configured_unavailable":
        raise QuantProviderError(
            f"{control_name} is blocked because configured watchlist quotes are unavailable."
        )
    return dashboard


def assert_watchlist_control_available() -> None:
    assert_live_quant_control_available("Watchlist control")


def quant_market_candidates(
    theme: str = "",
    limit: int = 20,
    min_turnover_billion: float = 0.3,
    exclude_watchlist: bool = True,
    exclude_st: bool = True,
) -> dict:
    limit = max(1, min(50, int(limit or 20)))
    min_turnover_billion = max(0.0, float(min_turnover_billion or 0))
    watchlist_codes = set(_watchlist_codes()) if exclude_watchlist else set()
    keywords = _theme_keywords(theme)

    candidate_provider = os.getenv("QUANT_CANDIDATE_PROVIDER", "tencent").strip().lower()

    try:
        if candidate_provider not in {"akshare", "auto"}:
            raise QuantProviderError("Using fast Tencent theme-seed candidate provider")

        import akshare as ak

        stock_rows, source_detail = _load_akshare_stock_rows(ak)
        if not stock_rows:
            raise QuantProviderError("AkShare returned empty A-share spot data")

        stocks = [_normalize_candidate_stock_row(row) for row in stock_rows]
        stocks = [item for item in stocks if item["code"] and item["price"] > 0]
        try:
            concept_by_code, concept_sources = _discover_theme_concepts(ak, keywords)
        except Exception as exc:
            concept_by_code = {}
            concept_sources = [
                {
                    "source": "akshare:stock_board_concept",
                    "ok": False,
                    "error": _short_provider_error(exc),
                }
            ]
        provider = "akshare"
        concept_evidence_source = "akshare:concept_board"
    except Exception as exc:
        source_detail = "tencent_theme_seed_fallback"
        stocks = _fallback_theme_seed_quotes(theme)
        concept_by_code = _fallback_theme_seed_concepts(theme, stocks)
        concept_sources = [
            {
                "source": "local_theme_seed+tencent_quote",
                "ok": True,
                "reason": _short_provider_error(exc),
            }
        ]
        provider = "tencent"
        concept_evidence_source = "local_theme_seed"

    candidates = _rank_market_candidates(
        stocks=stocks,
        keywords=keywords,
        concept_by_code=concept_by_code,
        concept_evidence_source=concept_evidence_source,
        quote_source=f"{provider}:{source_detail}:spot",
        limit=limit,
        min_turnover_billion=min_turnover_billion,
        watchlist_codes=watchlist_codes,
        exclude_watchlist=exclude_watchlist,
        exclude_st=exclude_st,
    )
    return {
        "generated_at": datetime.now(CN_TZ).isoformat(timespec="seconds"),
        "provider": provider,
        "data_source_detail": source_detail,
        "theme": theme,
        "keywords": keywords,
        "filters": {
            "limit": limit,
            "min_turnover_billion": min_turnover_billion,
            "exclude_watchlist": exclude_watchlist,
            "exclude_st": exclude_st,
        },
        "concept_sources": concept_sources,
        "items": candidates,
    }


def _call_with_timeout(func: Any, timeout_seconds: int) -> Any:
    executor = ThreadPoolExecutor(max_workers=1)
    future = executor.submit(func)
    try:
        result = future.result(timeout=timeout_seconds)
    except FutureTimeoutError as exc:
        future.cancel()
        executor.shutdown(wait=False, cancel_futures=True)
        raise QuantProviderError(f"Provider timed out after {timeout_seconds}s") from exc
    except Exception:
        executor.shutdown(wait=False, cancel_futures=True)
        raise
    executor.shutdown(wait=True)
    return result


def _market_candidate_timeout_seconds() -> int:
    raw = os.getenv("QUANT_CANDIDATE_TIMEOUT_SECONDS", "18")
    try:
        return max(5, min(60, int(raw)))
    except Exception:
        return 18


def _fallback_theme_seed_codes(theme: str) -> list[str]:
    codes = []
    for pool in _fallback_theme_seed_pools(theme):
        for code in pool["codes"]:
            if code not in codes:
                codes.append(code)
    return codes


def _fallback_theme_seed_pools(theme: str) -> list[dict[str, Any]]:
    text = (theme or "").lower()
    if not text.strip() or any(
        token in text
        for token in [
            "\u5168\u5e02\u573a",
            "\u597d\u80a1",
            "\u4e0d\u9650",
            "\u5e7f\u6cdb",
            "broad",
            "market",
        ]
    ):
        return FALLBACK_THEME_SEED_POOLS

    matched = []
    for pool in FALLBACK_THEME_SEED_POOLS:
        aliases = [str(alias).lower() for alias in pool["aliases"]]
        if any(alias and alias in text for alias in aliases):
            matched.append(pool)
    return matched


def _fallback_theme_seed_concepts(theme: str, stocks: list[dict]) -> dict[str, list[str]]:
    pools = _fallback_theme_seed_pools(theme)
    labels_by_code: dict[str, list[str]] = {}
    for pool in pools:
        labels = [str(label) for label in pool["labels"]]
        for code in pool["codes"]:
            existing = labels_by_code.setdefault(code, [])
            for label in labels:
                if label not in existing:
                    existing.append(label)
    return {
        item["code"]: labels_by_code.get(item["code"], [])
        for item in stocks
        if item.get("code") and labels_by_code.get(item["code"])
    }


def _fallback_theme_seed_quotes(theme: str) -> list[dict]:
    codes = _fallback_theme_seed_codes(theme)
    try:
        return _tencent_watchlist_quotes(codes)
    except Exception:
        return [_empty_watchlist_item(code, "theme seed quote unavailable") for code in codes]


def _rank_market_candidates(
    *,
    stocks: list[dict],
    keywords: list[str],
    concept_by_code: dict[str, list[str]],
    concept_evidence_source: str,
    quote_source: str,
    limit: int,
    min_turnover_billion: float,
    watchlist_codes: set[str],
    exclude_watchlist: bool,
    exclude_st: bool,
) -> list[dict]:
    candidates = []
    for stock in stocks:
        code = stock["code"]
        name = stock["name"]
        if exclude_watchlist and code in watchlist_codes:
            continue
        if exclude_st and ("ST" in name.upper() or "*ST" in name.upper()):
            continue
        if stock["turnover_billion"] < min_turnover_billion:
            continue

        concepts = concept_by_code.get(code, [])
        theme_fit, theme_evidence = _candidate_theme_fit(
            stock,
            keywords,
            concepts,
            concept_evidence_source,
        )
        if keywords and theme_fit < 0.35:
            continue

        liquidity = min(1.0, stock["turnover_billion"] / 5.0)
        momentum = max(0.0, min(1.0, (stock["change_pct"] + 3.0) / 10.0))
        quality = _candidate_quality_score(stock)
        risk = _candidate_risk_score(stock)
        score = round(
            100
            * (
                theme_fit * 0.34
                + liquidity * 0.24
                + momentum * 0.18
                + quality * 0.14
                + (1 - risk) * 0.10
            ),
            1,
        )
        evidence = [
            {
                "source": quote_source,
                "summary": (
                    f"price={stock['price']}, change_pct={stock['change_pct']}, "
                    f"turnover_billion={round(stock['turnover_billion'], 2)}"
                ),
            }
        ]
        evidence.extend(theme_evidence)
        candidates.append(
            {
                "code": code,
                "name": name,
                "price": stock["price"],
                "change_pct": stock["change_pct"],
                "turnover_billion": round(stock["turnover_billion"], 2),
                "turnover_rate": stock.get("turnover_rate", 0),
                "pe_ttm": stock.get("pe_ttm", 0),
                "pb": stock.get("pb", 0),
                "themes": concepts[:5],
                "tags": _stock_tags(stock),
                "score": score,
                "scores": {
                    "theme_fit": round(theme_fit, 2),
                    "liquidity": round(liquidity, 2),
                    "momentum": round(momentum, 2),
                    "quality": round(quality, 2),
                    "risk": round(risk, 2),
                },
                "evidence": evidence,
                "risks": _candidate_risks(stock, risk),
                "updated_at": stock.get("updated_at"),
            }
        )
    return sorted(candidates, key=lambda item: item["score"], reverse=True)[:limit]


def _short_provider_error(exc: Exception) -> str:
    message = str(exc)
    if "ProxyError" in message or "Unable to connect to proxy" in message:
        return "已安装，但当前代理无法访问东方财富全市场接口"
    if "RemoteDisconnected" in message:
        return "上游行情接口断开连接"
    if "timed out" in message.lower() or "timeout" in message.lower():
        return "上游行情接口超时"
    if len(message) > 180:
        return message[:177] + "..."
    return message


def _apply_configured_watchlist_fallback(dashboard: dict) -> None:
    codes = _watchlist_codes()
    metadata = _watchlist_metadata_by_code()
    try:
        watchlist = _tencent_watchlist_quotes(codes)
    except Exception as exc:
        watchlist = [_empty_watchlist_item(code, str(exc)) for code in codes]
    if not watchlist:
        watchlist = [_empty_watchlist_item(code, "No quote returned") for code in codes]
    watchlist = _enrich_watchlist_metrics(watchlist)
    watchlist = [_attach_watchlist_pool_metadata(item, metadata) for item in watchlist]

    has_live_quotes = any(
        item.get("price", 0) > 0 and not item.get("warning")
        for item in watchlist
    )
    if has_live_quotes:
        dashboard["service_mode"] = "live"
        dashboard["data_provider"] = "tencent"
    dashboard["watchlist"] = watchlist
    dashboard["signals"] = _build_signals(watchlist)
    dashboard["portfolio"] = _build_paper_portfolio(watchlist)
    dashboard["daily_report"] = _build_daily_report(dashboard["market"], dashboard["signals"], dashboard["portfolio"])
    dashboard["watchlist_source"] = (
        "configured_tencent_fallback" if has_live_quotes else "configured_unavailable"
    )


def tencent_quant_dashboard(provider_error: str | None = None) -> dict:
    start = perf_counter()
    metadata = _watchlist_metadata_by_code()
    quote_start = perf_counter()
    quote_items = _tencent_watchlist_quotes(_watchlist_codes())
    enrich_start = perf_counter()
    watchlist = _enrich_watchlist_metrics(
        quote_items,
        include_fundamentals=False,
    )
    _log_quant_timing(
        "dashboard_watchlist_enrich",
        enrich_start,
        provider="tencent",
        count=len(watchlist),
        include_fundamentals=False,
    )
    _log_quant_timing(
        "dashboard_watchlist_quotes_and_enrich",
        quote_start,
        provider="tencent",
        count=len(watchlist),
        include_fundamentals=False,
    )
    watchlist = [_attach_watchlist_pool_metadata(item, metadata) for item in watchlist]
    if not watchlist:
        raise QuantProviderError("Tencent returned empty watchlist data")

    market_start = perf_counter()
    market = _build_tencent_market_overview(watchlist)
    _log_quant_timing(
        "dashboard_market_overview",
        market_start,
        provider="tencent",
        index_count=len(market.get("indices") or []),
        market_scope=market.get("market_scope"),
        sector_scope=market.get("sector_scope"),
        stock_count=market.get("stock_count"),
    )
    signals = _build_signals(watchlist)
    portfolio = _build_paper_portfolio(watchlist)
    daily_report = _build_daily_report(market, signals, portfolio)
    dashboard = {
        "generated_at": datetime.now(CN_TZ).isoformat(timespec="seconds"),
        "service_mode": "live",
        "data_provider": "tencent",
        "data_scope": "indices_watchlist",
        "data_source_detail": "tencent_quote_batch",
        "watchlist_source": "configured_tencent_quote",
        "market": market,
        "watchlist": watchlist,
        "signals": signals,
        "portfolio": portfolio,
        "daily_report": daily_report,
    }
    if provider_error:
        dashboard["provider_error"] = provider_error
    _log_quant_timing(
        "dashboard_build",
        start,
        provider="tencent",
        count=len(watchlist),
        data_source_detail="tencent_quote_batch",
    )
    return dashboard


def quick_watchlist_quote_map() -> dict[str, dict]:
    """Return live configured watchlist quotes without building full dashboard."""
    codes = _watchlist_codes()
    metadata = _watchlist_metadata_by_code()
    quote_items = _tencent_watchlist_quotes(codes)
    watchlist = _enrich_watchlist_metrics(
        quote_items,
        include_fundamentals=False,
    )
    watchlist = [_attach_watchlist_pool_metadata(item, metadata) for item in watchlist]
    return {item["code"]: item for item in watchlist}


def _tencent_watchlist_quotes(codes: list[str]) -> list[dict]:
    start = perf_counter()
    symbols = [_normalize_watchlist_code(code) for code in codes]
    symbols = [symbol for symbol in symbols if symbol]
    if not symbols:
        _log_quant_timing(
            "tencent_watchlist_quotes",
            start,
            requested=len(codes),
            returned=0,
            ok=True,
        )
        return []

    query = ",".join(_tencent_prefix(symbol) for symbol in symbols)
    req = Request(f"https://qt.gtimg.cn/q={query}")
    req.add_header(
        "User-Agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    )
    try:
        with urlopen(req, timeout=_tencent_quote_timeout_seconds()) as resp:
            raw = resp.read().decode("gbk", errors="replace")
    except Exception as exc:
        _log_quant_timing(
            "tencent_watchlist_quotes",
            start,
            requested=len(symbols),
            returned=0,
            ok=False,
            error=_short_provider_error(exc),
        )
        raise

    by_code: dict[str, dict] = {}
    for line in raw.strip().split(";"):
        if not line.strip() or "=" not in line or '"' not in line:
            continue
        key = line.split("=")[0].split("_")[-1]
        values = line.split('"')[1].split("~")
        if len(values) < 50:
            continue
        code = _with_tencent_exchange_suffix(key)
        item = {
            "code": code,
            "name": values[1] or code,
            "price": _num(values[3]),
            "change_pct": _num(values[32]),
            "turnover_billion": round(_num(values[37]) / 100_000, 2),
            "pe_ttm": _num(values[39]),
            "pb": _num(values[46]),
            "turnover_rate": _num(values[38]),
            "roe": 0,
            "updated_at": _parse_tencent_quote_time(values[30]),
        }
        item["tags"] = _stock_tags(item)
        by_code[code] = item

    result = [by_code[code] for code in symbols if code in by_code]
    _log_quant_timing(
        "tencent_watchlist_quotes",
        start,
        requested=len(symbols),
        returned=len(result),
        ok=True,
    )
    return result


def _tencent_quotes(symbols: list[str]) -> list[tuple[str, list[str]]]:
    start = perf_counter()
    if not symbols:
        _log_quant_timing(
            "tencent_quotes",
            start,
            requested=0,
            returned=0,
            ok=True,
        )
        return []
    req = Request(f"https://qt.gtimg.cn/q={','.join(symbols)}")
    req.add_header(
        "User-Agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    )
    try:
        with urlopen(req, timeout=_tencent_quote_timeout_seconds()) as resp:
            raw = resp.read().decode("gbk", errors="replace")
    except Exception as exc:
        _log_quant_timing(
            "tencent_quotes",
            start,
            requested=len(symbols),
            returned=0,
            ok=False,
            error=_short_provider_error(exc),
        )
        raise

    rows = []
    for line in raw.strip().split(";"):
        if not line.strip() or "=" not in line or '"' not in line:
            continue
        key = line.split("=")[0].split("_")[-1]
        values = line.split('"')[1].split("~")
        rows.append((key, values))
    _log_quant_timing(
        "tencent_quotes",
        start,
        requested=len(symbols),
        returned=len(rows),
        ok=True,
    )
    return rows


def _build_tencent_market_overview(watchlist: list[dict]) -> dict:
    try:
        return _get_full_market_overview()
    except Exception as exc:
        market = _build_watchlist_market_overview(watchlist)
        market["market_scope"] = "watchlist_fallback"
        market["market_warning"] = (
            "Full-market overview is unavailable; market metrics are degraded to watchlist scope."
        )
        market["provider_error"] = _short_provider_error(exc)
        return market


def _build_watchlist_market_overview(watchlist: list[dict]) -> dict:
    index_symbols = ["sh000001", "sz399001", "sz399006", "sh000300"]
    index_names = {
        "000001.SH": "上证指数",
        "399001.SZ": "深证成指",
        "399006.SZ": "创业板指",
        "000300.SH": "沪深300",
    }
    indices = []
    for key, values in _tencent_quotes(index_symbols):
        if len(values) < 50:
            continue
        code = _with_tencent_exchange_suffix(key)
        indices.append(
            {
                "code": code,
                "name": values[1] or index_names.get(code, code),
                "price": _num(values[3]),
                "change_pct": _num(values[32]),
                "turnover_billion": round(_num(values[37]) / 100_000, 2),
            }
        )

    by_code = {item["code"]: item for item in indices}
    indices = [
        by_code.get(code)
        or {
            "code": code,
            "name": name,
            "price": 0,
            "change_pct": 0,
            "turnover_billion": 0,
        }
        for code, name in index_names.items()
    ]

    up_count = sum(1 for item in watchlist if item["change_pct"] > 0)
    down_count = sum(1 for item in watchlist if item["change_pct"] < 0)
    flat_count = max(0, len(watchlist) - up_count - down_count)
    total = max(1, len(watchlist))
    temperature = round(max(0, min(100, 50 + (up_count - down_count) / total * 50)))

    return {
        "trade_date": datetime.now(CN_TZ).date().isoformat(),
        "market_scope": "watchlist",
        "temperature": temperature,
        "up_count": up_count,
        "down_count": down_count,
        "flat_count": flat_count,
        "turnover_billion": round(sum(item["turnover_billion"] for item in watchlist), 1),
        "indices": indices,
        "sectors": [
            {"name": "人工智能", "change_pct": 0, "signal": "watchlist"},
            {"name": "机器人", "change_pct": 0, "signal": "watchlist"},
        ],
    }


def _get_full_market_overview() -> dict:
    cached = _get_cached_market_overview()
    if cached is not None:
        return cached
    refresh_market_overview_background()
    raise QuantProviderError("Full-market overview refresh is running in background")


def refresh_market_overview_background(force: bool = False) -> dict:
    if not force and _get_cached_market_overview() is not None:
        return get_market_overview_status()

    should_start = False
    with _MARKET_OVERVIEW_LOCK:
        future = _MARKET_OVERVIEW_REFRESH.get("future")
        should_start = future is None or future.done()
        if should_start:
            _MARKET_OVERVIEW_REFRESH["started_at"] = datetime.now(CN_TZ)
            _MARKET_OVERVIEW_REFRESH["finished_at"] = None
            _MARKET_OVERVIEW_REFRESH["last_error"] = None
            _MARKET_OVERVIEW_REFRESH["future"] = _MARKET_OVERVIEW_EXECUTOR.submit(
                _refresh_market_overview_job
            )
    return get_market_overview_status()


def get_market_overview_status() -> dict:
    cached = _MARKET_OVERVIEW_CACHE.get("market")
    expires_at = _MARKET_OVERVIEW_CACHE.get("expires_at")
    now = datetime.now(CN_TZ)

    with _MARKET_OVERVIEW_LOCK:
        future = _MARKET_OVERVIEW_REFRESH.get("future")
        in_progress = bool(future is not None and not future.done())
        started_at = _MARKET_OVERVIEW_REFRESH.get("started_at")
        finished_at = _MARKET_OVERVIEW_REFRESH.get("finished_at")
        last_success_at = _MARKET_OVERVIEW_REFRESH.get("last_success_at")
        last_error = _MARKET_OVERVIEW_REFRESH.get("last_error")

    cached_available = bool(cached and isinstance(expires_at, datetime))
    stale = bool(cached_available and expires_at <= now)
    return {
        "job": "quant_full_market_overview",
        "scope": "full_market",
        "source": "akshare",
        "in_progress": in_progress,
        "cached": cached_available,
        "stale": stale,
        "expires_at": expires_at.isoformat(timespec="seconds")
        if isinstance(expires_at, datetime)
        else None,
        "started_at": started_at.isoformat(timespec="seconds")
        if isinstance(started_at, datetime)
        else None,
        "finished_at": finished_at.isoformat(timespec="seconds")
        if isinstance(finished_at, datetime)
        else None,
        "last_success_at": last_success_at.isoformat(timespec="seconds")
        if isinstance(last_success_at, datetime)
        else None,
        "last_error": last_error,
    }


def _refresh_market_overview_job() -> None:
    start = perf_counter()
    try:
        market = _load_full_market_overview()
        _set_cached_market_overview(market)
        _CACHE["dashboard"] = None
        _CACHE["expires_at"] = None
        finished_at = datetime.now(CN_TZ)
        with _MARKET_OVERVIEW_LOCK:
            _MARKET_OVERVIEW_REFRESH["finished_at"] = finished_at
            _MARKET_OVERVIEW_REFRESH["last_success_at"] = finished_at
            _MARKET_OVERVIEW_REFRESH["last_error"] = None
        _log_quant_timing(
            "market_overview_background_refresh",
            start,
            ok=True,
            stock_count=market.get("stock_count"),
            market_source=market.get("market_source"),
        )
    except Exception as exc:
        finished_at = datetime.now(CN_TZ)
        error = _short_provider_error(exc)
        with _MARKET_OVERVIEW_LOCK:
            _MARKET_OVERVIEW_REFRESH["finished_at"] = finished_at
            _MARKET_OVERVIEW_REFRESH["last_error"] = error
        _log_quant_timing(
            "market_overview_background_refresh",
            start,
            ok=False,
            error=error,
        )


def _load_full_market_overview() -> dict:
    try:
        import akshare as ak
    except Exception as exc:  # pragma: no cover - depends on local env
        raise QuantProviderError("AkShare is not installed") from exc

    stock_rows, source_detail = _call_with_timeout(
        lambda: _load_akshare_stock_rows(ak),
        _market_overview_timeout_seconds(),
    )
    if not stock_rows:
        raise QuantProviderError("AkShare returned empty A-share spot data")
    stocks = [_normalize_candidate_stock_row(row) for row in stock_rows]
    stocks = [item for item in stocks if item.get("code") and item.get("price", 0) > 0]
    if not stocks:
        raise QuantProviderError("No active A-share rows in full-market snapshot")

    market = _build_full_market_overview_from_stocks(ak, stocks)
    market["market_scope"] = "full_market"
    market["market_source"] = f"akshare:{source_detail}"
    market["stock_count"] = len(stocks)
    return market


def _build_full_market_overview_from_stocks(ak: Any, stocks: list[dict]) -> dict:
    up_count = sum(1 for item in stocks if item["change_pct"] > 0)
    down_count = sum(1 for item in stocks if item["change_pct"] < 0)
    flat_count = max(0, len(stocks) - up_count - down_count)
    total = max(1, len(stocks))
    temperature = round(max(0, min(100, 50 + (up_count - down_count) / total * 50)))

    warnings = []
    try:
        indices = _call_with_timeout(
            lambda: _build_indices(ak),
            _market_auxiliary_timeout_seconds(),
        )
    except Exception as exc:
        indices = []
        warnings.append(f"indices unavailable: {_short_provider_error(exc)}")

    try:
        sectors = _call_with_timeout(
            lambda: _build_sectors(ak),
            _market_sector_timeout_seconds(),
        )
        sector_scope = "full_market"
    except Exception as exc:
        sectors = []
        sector_scope = "unavailable"
        warnings.append(f"sectors unavailable: {_short_provider_error(exc)}")

    market = {
        "trade_date": datetime.now(CN_TZ).date().isoformat(),
        "market_scope": "full_market",
        "temperature": temperature,
        "up_count": up_count,
        "down_count": down_count,
        "flat_count": flat_count,
        "turnover_billion": round(sum(item["turnover_billion"] for item in stocks), 1),
        "indices": indices,
        "sectors": sectors,
        "sector_scope": sector_scope,
    }
    if warnings:
        market["market_warning"] = "; ".join(warnings)
    return market


def _tencent_prefix(code: str) -> str:
    symbol = code.split(".", 1)[0]
    if code.endswith(".SH") or symbol.startswith(("6", "9")):
        return f"sh{symbol}"
    if code.endswith(".BJ") or symbol.startswith(("4", "8")):
        return f"bj{symbol}"
    return f"sz{symbol}"


def _tencent_quote_timeout_seconds() -> int:
    raw = os.getenv("QUANT_TENCENT_QUOTE_TIMEOUT_SECONDS", "4")
    try:
        return max(1, min(12, int(raw)))
    except Exception:
        return 4


def _with_tencent_exchange_suffix(key: str) -> str:
    compact = key.strip().lower()
    code = compact[2:] if len(compact) > 2 else compact
    if compact.startswith("sh"):
        return f"{code}.SH"
    if compact.startswith("bj"):
        return f"{code}.BJ"
    return f"{code}.SZ"


def _parse_tencent_quote_time(raw: str) -> str | None:
    value = (raw or "").strip()
    if len(value) != 14 or not value.isdigit():
        return None
    try:
        return datetime.strptime(value, "%Y%m%d%H%M%S").replace(tzinfo=CN_TZ).isoformat(timespec="seconds")
    except Exception:
        return None


def _empty_watchlist_item(code: str, warning: str) -> dict:
    normalized = _normalize_watchlist_code(code) or code
    return {
        "code": normalized,
        "name": normalized,
        "price": 0,
        "change_pct": 0,
        "turnover_billion": 0,
        "pe_ttm": 0,
        "pb": 0,
        "roe": 0,
        "tags": ["configured"],
        "warning": warning,
    }


def _attach_watchlist_pool_metadata(item: dict, metadata: dict[str, dict]) -> dict:
    meta = metadata.get(str(item.get("code") or ""), {})
    pool = str(meta.get("pool") or "core")
    status = str(meta.get("status") or "active")
    return {
        **item,
        "pool": pool,
        "pool_label": WATCHLIST_POOL_LABELS.get(pool, pool),
        "watch_status": status,
        "watch_source": meta.get("source") or "unknown",
        "watch_reason": meta.get("reason") or "",
        "watch_confidence": meta.get("confidence"),
        "watch_score": meta.get("score"),
        "watch_data_quality": meta.get("data_quality") or "unknown",
        "first_seen_at": meta.get("first_seen_at"),
        "last_reviewed_at": meta.get("last_reviewed_at"),
        "expires_at": meta.get("expires_at"),
    }


def akshare_quant_dashboard() -> dict:
    start = perf_counter()
    try:
        import akshare as ak
    except Exception as exc:  # pragma: no cover - depends on local env
        raise QuantProviderError("AkShare is not installed") from exc

    rows_start = perf_counter()
    stock_rows, source_detail = _load_akshare_stock_rows(ak)
    _log_quant_timing(
        "akshare_stock_rows",
        rows_start,
        source_detail=source_detail,
        rows=len(stock_rows),
    )
    if not stock_rows:
        raise QuantProviderError("AkShare returned empty A-share spot data")

    normalize_start = perf_counter()
    normalized_stocks = [_normalize_stock_row(row) for row in stock_rows]
    active_stocks = [item for item in normalized_stocks if item["price"] > 0]
    _log_quant_timing(
        "akshare_normalize_rows",
        normalize_start,
        rows=len(stock_rows),
        active_rows=len(active_stocks),
    )
    if not active_stocks:
        raise QuantProviderError("No active A-share rows in AkShare data")

    market_start = perf_counter()
    market = _build_market_overview(ak, active_stocks)
    _log_quant_timing(
        "akshare_market_overview",
        market_start,
        active_rows=len(active_stocks),
    )
    watchlist_start = perf_counter()
    watchlist = _build_watchlist(active_stocks)
    _log_quant_timing(
        "akshare_watchlist_build",
        watchlist_start,
        count=len(watchlist),
    )
    signals = _build_signals(watchlist)
    portfolio = _build_paper_portfolio(watchlist)
    daily_report = _build_daily_report(market, signals, portfolio)

    dashboard = {
        "generated_at": datetime.now(CN_TZ).isoformat(timespec="seconds"),
        "service_mode": "live",
        "data_provider": "akshare",
        "data_scope": "all_a_share",
        "data_source_detail": source_detail,
        "market": market,
        "watchlist": watchlist,
        "signals": signals,
        "portfolio": portfolio,
        "daily_report": daily_report,
    }
    _log_quant_timing(
        "dashboard_build",
        start,
        provider="akshare",
        count=len(watchlist),
        data_source_detail=source_detail,
    )
    return dashboard


def _load_akshare_stock_rows(ak: Any) -> tuple[list[dict[str, Any]], str]:
    source = _akshare_source_preference()
    if source == "sina":
        return _records(_quiet_call(ak.stock_zh_a_spot)), "sina"
    if source == "eastmoney":
        return _records(_quiet_call(ak.stock_zh_a_spot_em)), "eastmoney"

    try:
        return _records(_quiet_call(ak.stock_zh_a_spot_em)), "eastmoney"
    except Exception as em_exc:
        try:
            return _records(_quiet_call(ak.stock_zh_a_spot)), "sina"
        except Exception as sina_exc:
            raise QuantProviderError(
                "AkShare Eastmoney failed: "
                f"{_short_provider_error(em_exc)}; AkShare Sina failed: "
                f"{_short_provider_error(sina_exc)}"
            ) from sina_exc


def _akshare_source_preference() -> str:
    source = os.getenv("QUANT_AKSHARE_SOURCE", "auto").strip().lower()
    if source in {"eastmoney", "em"}:
        return "eastmoney"
    if source in {"sina", "sina_finance"}:
        return "sina"
    return "auto"


def _records(df: Any) -> list[dict[str, Any]]:
    if df is None:
        return []
    if hasattr(df, "to_dict"):
        return list(df.to_dict(orient="records"))
    return list(df)


def _get_cached_dashboard() -> dict | None:
    dashboard = _CACHE.get("dashboard")
    expires_at = _CACHE.get("expires_at")
    if not dashboard or not isinstance(expires_at, datetime):
        return None
    if expires_at <= datetime.now(CN_TZ):
        return None
    copied = dict(dashboard)
    copied["cache"] = {
        "hit": True,
        "expires_at": expires_at.isoformat(timespec="seconds"),
    }
    return copied


def _set_cached_dashboard(dashboard: dict) -> None:
    ttl = _cache_ttl_seconds()
    expires_at = datetime.now(CN_TZ) + timedelta(seconds=ttl)
    cached = dict(dashboard)
    cached["cache"] = {
        "hit": False,
        "expires_at": expires_at.isoformat(timespec="seconds"),
    }
    _CACHE["dashboard"] = cached
    _CACHE["expires_at"] = expires_at


def _get_cached_market_overview() -> dict | None:
    market = _MARKET_OVERVIEW_CACHE.get("market")
    expires_at = _MARKET_OVERVIEW_CACHE.get("expires_at")
    if not market or not isinstance(expires_at, datetime):
        return None
    if expires_at <= datetime.now(CN_TZ):
        return None
    copied = dict(market)
    copied["cache"] = {
        "hit": True,
        "expires_at": expires_at.isoformat(timespec="seconds"),
    }
    return copied


def _set_cached_market_overview(market: dict) -> None:
    ttl = _market_overview_cache_ttl_seconds()
    expires_at = datetime.now(CN_TZ) + timedelta(seconds=ttl)
    cached = dict(market)
    cached["cache"] = {
        "hit": False,
        "expires_at": expires_at.isoformat(timespec="seconds"),
    }
    _MARKET_OVERVIEW_CACHE["market"] = cached
    _MARKET_OVERVIEW_CACHE["expires_at"] = expires_at


def _cache_ttl_seconds() -> int:
    raw = os.getenv("QUANT_CACHE_TTL_SECONDS", "300")
    try:
        return max(30, int(raw))
    except Exception:
        return 300


def _market_overview_cache_ttl_seconds() -> int:
    raw = os.getenv("QUANT_MARKET_OVERVIEW_CACHE_TTL_SECONDS", "300")
    try:
        return max(30, int(raw))
    except Exception:
        return 300


def _market_overview_timeout_seconds() -> int:
    raw = os.getenv("QUANT_MARKET_OVERVIEW_TIMEOUT_SECONDS", "35")
    try:
        return max(5, min(60, int(raw)))
    except Exception:
        return 35


def _market_auxiliary_timeout_seconds() -> int:
    raw = os.getenv("QUANT_MARKET_AUXILIARY_TIMEOUT_SECONDS", "6")
    try:
        return max(2, min(30, int(raw)))
    except Exception:
        return 6


def _market_sector_timeout_seconds() -> int:
    raw = os.getenv("QUANT_MARKET_SECTOR_TIMEOUT_SECONDS", "10")
    try:
        return max(3, min(45, int(raw)))
    except Exception:
        return 10


def _fundamental_cache_ttl_seconds() -> int:
    raw = os.getenv("QUANT_FUNDAMENTAL_CACHE_TTL_SECONDS", "21600")
    try:
        return max(300, int(raw))
    except Exception:
        return 21600


def _get_cached_fundamentals(codes: list[str]) -> dict[str, dict]:
    expires_at = _FUNDAMENTAL_CACHE.get("expires_at")
    if not isinstance(expires_at, datetime) or expires_at <= datetime.now(CN_TZ):
        _FUNDAMENTAL_CACHE["items"] = {}
        _FUNDAMENTAL_CACHE["expires_at"] = None
        return {}
    items = _FUNDAMENTAL_CACHE.get("items")
    if not isinstance(items, dict):
        return {}
    return {code: items[code] for code in codes if code in items}


def _set_cached_fundamentals(values: dict[str, dict]) -> None:
    if not values:
        return
    expires_at = datetime.now(CN_TZ) + timedelta(
        seconds=_fundamental_cache_ttl_seconds()
    )
    items = _FUNDAMENTAL_CACHE.get("items")
    if not isinstance(items, dict):
        items = {}
    items.update(values)
    _FUNDAMENTAL_CACHE["items"] = items
    _FUNDAMENTAL_CACHE["expires_at"] = expires_at


def _quiet_call(func: Any, *args: Any, **kwargs: Any) -> Any:
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(
        io.StringIO()
    ):
        return func(*args, **kwargs)


def _normalize_stock_row(row: dict[str, Any]) -> dict:
    code = str(row.get("代码") or "").strip()
    return {
        "code": _with_exchange_suffix(code),
        "raw_code": code,
        "name": str(row.get("名称") or code),
        "price": _num(row.get("最新价")),
        "change_pct": _num(row.get("涨跌幅")),
        "turnover_billion": _num(row.get("成交额")) / 1_000_000_000,
        "volume": _num(row.get("成交量")),
        "pe_ttm": _num(row.get("市盈率-动态")),
        "pb": _num(row.get("市净率")),
        "turnover_rate": _num(row.get("换手率")),
        "updated_at": _parse_akshare_quote_time(row.get("时间戳")),
    }


def _has_row_value(value: Any) -> bool:
    return value is not None and value != ""


def _row_value(row: dict[str, Any], keys: list[str]) -> Any:
    for key in keys:
        if key in row and _has_row_value(row.get(key)):
            return row.get(key)
    normalized = {str(key).strip().lower(): value for key, value in row.items()}
    for key in keys:
        value = normalized.get(key.strip().lower())
        if _has_row_value(value):
            return value
    return None


def _normalize_candidate_stock_row(row: dict[str, Any]) -> dict:
    code = str(
        _row_value(
            row,
            [
                "\u4ee3\u7801",
                "\u80a1\u7968\u4ee3\u7801",
                "\u8bc1\u5238\u4ee3\u7801",
                "code",
                "symbol",
            ],
        )
        or ""
    ).strip()
    name = str(
        _row_value(
            row,
            ["\u540d\u79f0", "\u80a1\u7968\u7b80\u79f0", "\u8bc1\u5238\u7b80\u79f0", "name"],
        )
        or code
    ).strip()
    return {
        "code": _with_exchange_suffix(code),
        "raw_code": code,
        "name": name or code,
        "price": _num(_row_value(row, ["\u6700\u65b0\u4ef7", "\u73b0\u4ef7", "price"])),
        "change_pct": _num(
            _row_value(row, ["\u6da8\u8dcc\u5e45", "\u6da8\u5e45", "change_pct"])
        ),
        "turnover_billion": _num(
            _row_value(row, ["\u6210\u4ea4\u989d", "amount", "turnover"])
        )
        / 1_000_000_000,
        "volume": _num(_row_value(row, ["\u6210\u4ea4\u91cf", "volume"])),
        "pe_ttm": _num(
            _row_value(
                row,
                [
                    "\u5e02\u76c8\u7387-\u52a8\u6001",
                    "\u5e02\u76c8\u7387",
                    "pe_ttm",
                    "pe",
                ],
            )
        ),
        "pb": _num(_row_value(row, ["\u5e02\u51c0\u7387", "pb"])),
        "turnover_rate": _num(_row_value(row, ["\u6362\u624b\u7387", "turnover_rate"])),
        "updated_at": _parse_akshare_quote_time(
            _row_value(row, ["\u65f6\u95f4", "\u66f4\u65b0\u65f6\u95f4", "time"])
        ),
    }


def _theme_keywords(theme: str) -> list[str]:
    text = (theme or "").strip().lower()
    if not text or any(
        token in text
        for token in [
            "\u5168\u5e02\u573a",
            "\u597d\u80a1",
            "\u4e0d\u9650",
            "\u5e7f\u6cdb",
            "broad",
            "market",
        ]
    ):
        return []
    keywords = [
        item.strip().lower()
        for item in text.replace("/", " ").replace(",", " ").split()
        if item.strip()
    ]
    if any(item in text for item in ["ai", "\u4eba\u5de5\u667a\u80fd", "\u667a\u80fd"]):
        keywords.extend(
            [
                "\u4eba\u5de5\u667a\u80fd",
                "\u667a\u80fd",
                "\u7b97\u529b",
                "\u5927\u6a21\u578b",
                "\u8f6f\u4ef6",
                "\u6570\u636e",
                "ai",
            ]
        )
    if any(item in text for item in ["robot", "\u673a\u5668\u4eba", "\u81ea\u52a8\u5316"]):
        keywords.extend(
            [
                "\u673a\u5668\u4eba",
                "\u81ea\u52a8\u5316",
                "\u5de5\u4e1a\u6bcd\u673a",
                "\u667a\u80fd\u5236\u9020",
                "robot",
            ]
        )
    if any(item in text for item in ["\u534a\u5bfc\u4f53", "\u82af\u7247", "\u96c6\u6210\u7535\u8def"]):
        keywords.extend(["\u534a\u5bfc\u4f53", "\u82af\u7247", "\u96c6\u6210\u7535\u8def"])
    if any(item in text for item in ["\u533b\u836f", "\u533b\u7597", "\u521b\u65b0\u836f"]):
        keywords.extend(["\u533b\u836f", "\u533b\u7597", "\u521b\u65b0\u836f", "\u751f\u7269\u533b\u836f"])
    if any(item in text for item in ["\u6d88\u8d39", "\u767d\u9152", "\u98df\u54c1\u996e\u6599", "\u5bb6\u7535"]):
        keywords.extend(["\u6d88\u8d39", "\u767d\u9152", "\u98df\u54c1\u996e\u6599", "\u5bb6\u7535"])
    if any(item in text for item in ["\u65b0\u80fd\u6e90", "\u9502\u7535", "\u5149\u4f0f", "\u50a8\u80fd"]):
        keywords.extend(["\u65b0\u80fd\u6e90", "\u9502\u7535", "\u5149\u4f0f", "\u50a8\u80fd"])
    if any(item in text for item in ["\u91d1\u878d", "\u94f6\u884c", "\u4fdd\u9669", "\u5238\u5546", "\u7ea2\u5229"]):
        keywords.extend(["\u91d1\u878d", "\u94f6\u884c", "\u4fdd\u9669", "\u5238\u5546", "\u7ea2\u5229"])
    if any(item in text for item in ["\u519b\u5de5", "\u56fd\u9632", "\u822a\u7a7a", "\u822a\u5929"]):
        keywords.extend(["\u519b\u5de5", "\u56fd\u9632", "\u822a\u7a7a", "\u822a\u5929"])
    return sorted({item for item in keywords if item})


def _discover_theme_concepts(
    ak: Any,
    keywords: list[str],
) -> tuple[dict[str, list[str]], list[dict[str, Any]]]:
    if not keywords:
        return {}, []
    try:
        rows = _records(_quiet_call(ak.stock_board_concept_name_em))
    except Exception:
        return {}, []

    matched_boards = []
    for row in rows:
        name = str(
            _row_value(
                row,
                ["\u677f\u5757\u540d\u79f0", "\u6982\u5ff5\u540d\u79f0", "\u540d\u79f0", "name"],
            )
            or ""
        ).strip()
        lower = name.lower()
        if name and any(keyword in lower for keyword in keywords):
            matched_boards.append(name)
    matched_boards = matched_boards[:8]

    by_code: dict[str, list[str]] = {}
    sources = []
    for board in matched_boards:
        try:
            members = _records(_quiet_call(ak.stock_board_concept_cons_em, symbol=board))
        except Exception as exc:
            sources.append(
                {
                    "board": board,
                    "source": "akshare:stock_board_concept_cons_em",
                    "ok": False,
                    "error": _short_provider_error(exc),
                }
            )
            continue
        count = 0
        for row in members:
            code = _normalize_watchlist_code(
                str(
                    _row_value(
                        row,
                        [
                            "\u4ee3\u7801",
                            "\u80a1\u7968\u4ee3\u7801",
                            "\u8bc1\u5238\u4ee3\u7801",
                            "code",
                        ],
                    )
                    or ""
                )
            )
            if not code:
                continue
            concepts = by_code.setdefault(code, [])
            if board not in concepts:
                concepts.append(board)
            count += 1
        sources.append(
            {
                "board": board,
                "source": "akshare:stock_board_concept_cons_em",
                "ok": True,
                "member_count": count,
            }
        )
    return by_code, sources


def _candidate_theme_fit(
    stock: dict,
    keywords: list[str],
    concepts: list[str],
    concept_evidence_source: str = "akshare:concept_board",
) -> tuple[float, list[dict[str, str]]]:
    if not keywords:
        return 0.45, []
    name = str(stock.get("name") or "").lower()
    concept_text = " ".join(concepts).lower()
    evidence: list[dict[str, str]] = []
    concept_hits = [keyword for keyword in keywords if keyword in concept_text]
    name_hits = [keyword for keyword in keywords if keyword in name]
    if concept_hits:
        evidence.append(
            {
                "source": concept_evidence_source,
                "summary": f"matched concepts: {', '.join(concepts[:5])}",
            }
        )
        return 0.92, evidence
    if name_hits:
        evidence.append(
            {
                "source": "stock_name",
                "summary": f"name matched keywords: {', '.join(name_hits[:5])}",
            }
        )
        return 0.58, evidence
    if concepts and not keywords:
        evidence.append(
            {
                "source": concept_evidence_source,
                "summary": f"concept member: {', '.join(concepts[:5])}",
            }
        )
        return 0.78, evidence
    return 0.2, evidence


def _candidate_quality_score(stock: dict) -> float:
    pe = stock.get("pe_ttm", 0)
    pb = stock.get("pb", 0)
    score = 0.45
    if 0 < pe <= 80:
        score += 0.25
    if 0 < pb <= 12:
        score += 0.15
    if stock.get("turnover_rate", 0) > 0:
        score += 0.15
    return min(1.0, score)


def _candidate_risk_score(stock: dict) -> float:
    risk = 0.2
    if abs(stock.get("change_pct", 0)) >= 8:
        risk += 0.25
    if stock.get("turnover_rate", 0) >= 20:
        risk += 0.2
    if stock.get("pe_ttm", 0) <= 0:
        risk += 0.15
    if str(stock.get("code", "")).endswith(".BJ"):
        risk += 0.1
    return min(1.0, risk)


def _candidate_risks(stock: dict, risk: float) -> list[str]:
    risks = []
    if abs(stock.get("change_pct", 0)) >= 8:
        risks.append("large_intraday_move")
    if stock.get("turnover_rate", 0) >= 20:
        risks.append("high_turnover")
    if stock.get("pe_ttm", 0) <= 0:
        risks.append("missing_or_negative_pe")
    if risk >= 0.65:
        risks.append("requires_manual_review")
    return risks or ["normal_market_risk"]


def _with_exchange_suffix(code: str) -> str:
    compact = code.strip().upper().replace(" ", "")
    if "." in compact:
        return compact
    if compact.startswith("SH") and len(compact) >= 8:
        return f"{compact[2:]}.SH"
    if compact.startswith("SZ") and len(compact) >= 8:
        return f"{compact[2:]}.SZ"
    if compact.startswith("BJ") and len(compact) >= 8:
        return f"{compact[2:]}.BJ"
    if compact.startswith(("6", "9")):
        return f"{compact}.SH"
    if compact.startswith(("0", "2", "3")):
        return f"{compact}.SZ"
    if compact.startswith(("4", "8")):
        return f"{compact}.BJ"
    return compact


def _num(value: Any, default: float = 0.0) -> float:
    try:
        if value is None or value == "":
            return default
        number = float(value)
        return number if isfinite(number) else default
    except Exception:
        return default


def _finite_num(value: Any) -> float | None:
    try:
        if value is None or value == "":
            return None
        number = float(value)
        return number if isfinite(number) else None
    except Exception:
        return None


def _first_finite(record: dict[str, Any], keys: list[str]) -> float | None:
    for key in keys:
        number = _finite_num(record.get(key))
        if number is not None:
            return number
    return None


def _stock_symbol(code: str) -> str:
    return code.split(".", 1)[0]


def _merge_positive_metric(target: dict, key: str, value: Any) -> bool:
    number = _num(value)
    if number <= 0:
        return False
    target[key] = round(number, 4)
    return True


def _merge_nonzero_metric(target: dict, key: str, value: Any) -> bool:
    number = _finite_num(value)
    if number is None or number == 0:
        return False
    target[key] = round(number, 4)
    return True


def _latest_report_row(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not rows:
        return None
    sorted_rows = sorted(
        rows,
        key=lambda row: str(row.get("REPORT_DATE") or row.get("日期") or ""),
        reverse=True,
    )
    return sorted_rows[0]


def _load_watchlist_fundamentals(codes: list[str]) -> dict[str, dict]:
    cached = _get_cached_fundamentals(codes)
    missing = [
        code
        for code in codes
        if code not in cached and _supports_stock_fundamentals(code)
    ]
    if not missing:
        return cached

    try:
        import akshare as ak
    except Exception:
        return cached

    loaded: dict[str, dict] = {}
    for code in missing:
        metrics: dict[str, Any] = {}
        try:
            rows = _records(
                _quiet_call(
                    ak.stock_financial_analysis_indicator_em,
                    symbol=code,
                    indicator="按报告期",
                )
            )
            latest = _latest_report_row(rows) or {}
            metrics["roe"] = _first_finite(
                latest,
                [
                    "ROE_DILUTED",
                    "ROEJQ",
                    "净资产收益率(%)",
                    "加权净资产收益率(%)",
                ],
            )
            metrics["fundamental_report_date"] = str(
                latest.get("REPORT_DATE") or ""
            ).split(" ")[0]
            metrics["fundamental_source"] = "akshare:stock_financial_analysis_indicator_em"
        except Exception as exc:
            metrics["fundamental_warning"] = _short_provider_error(exc)

        loaded[code] = metrics

    _set_cached_fundamentals(loaded)
    return {**cached, **loaded}


def _supports_stock_fundamentals(code: str) -> bool:
    normalized = _normalize_watchlist_code(code)
    if not normalized:
        return False
    symbol, exchange = normalized.split(".", 1)
    if exchange == "SZ" and symbol.startswith(("1", "399")):
        return False
    if exchange == "SH" and symbol.startswith(("000", "5")):
        return False
    return True


def _enrich_watchlist_metrics(
    items: list[dict],
    *,
    include_fundamentals: bool = True,
) -> list[dict]:
    start = perf_counter()
    if not items:
        _log_quant_timing(
            "watchlist_enrich_metrics",
            start,
            count=0,
            include_fundamentals=include_fundamentals,
        )
        return items

    codes = [item["code"] for item in items if item.get("code")]
    quote_start = perf_counter()
    try:
        by_code = {item["code"]: item for item in _tencent_watchlist_quotes(codes)}
    except Exception:
        by_code = {}
    _log_quant_timing(
        "watchlist_enrich_quote_fill",
        quote_start,
        count=len(codes),
        quote_count=len(by_code),
    )
    fundamentals_start = perf_counter()
    fundamentals = _load_watchlist_fundamentals(codes) if include_fundamentals else {}
    _log_quant_timing(
        "watchlist_enrich_fundamentals",
        fundamentals_start,
        count=len(codes),
        fundamental_count=len(fundamentals),
        include_fundamentals=include_fundamentals,
    )

    for item in items:
        code = item.get("code")
        if not code:
            continue

        metric_sources = set(item.get("metric_sources") or [])
        quote = by_code.get(code, {})
        if item.get("pe_ttm", 0) <= 0 and _merge_positive_metric(
            item, "pe_ttm", quote.get("pe_ttm")
        ):
            metric_sources.add("tencent:pe_ttm")
        if item.get("pb", 0) <= 0 and _merge_positive_metric(
            item, "pb", quote.get("pb")
        ):
            metric_sources.add("tencent:pb")
        if item.get("turnover_rate", 0) <= 0 and _merge_positive_metric(
            item, "turnover_rate", quote.get("turnover_rate")
        ):
            metric_sources.add("tencent:turnover_rate")

        fundamental = fundamentals.get(code, {})
        if item.get("roe", 0) == 0 and _merge_nonzero_metric(
            item, "roe", fundamental.get("roe")
        ):
            metric_sources.add("akshare:roe")
        if fundamental.get("fundamental_report_date"):
            item["fundamental_report_date"] = fundamental["fundamental_report_date"]
        if fundamental.get("fundamental_source"):
            item["fundamental_source"] = fundamental["fundamental_source"]
        if fundamental.get("fundamental_warning"):
            item["fundamental_warning"] = fundamental["fundamental_warning"]

        if metric_sources:
            item["metric_sources"] = sorted(metric_sources)
        item["tags"] = _stock_tags(item)

    _log_quant_timing(
        "watchlist_enrich_metrics",
        start,
        count=len(items),
        include_fundamentals=include_fundamentals,
    )
    return items


def _parse_akshare_quote_time(raw: Any) -> str | None:
    value = str(raw or "").strip()
    if not value:
        return None
    for fmt in ("%H:%M:%S", "%H:%M"):
        try:
            parsed = datetime.strptime(value, fmt).time()
            return datetime.combine(datetime.now(CN_TZ).date(), parsed, tzinfo=CN_TZ).isoformat(timespec="seconds")
        except Exception:
            pass
    return None


def _build_market_overview(ak: Any, stocks: list[dict]) -> dict:
    up_count = sum(1 for item in stocks if item["change_pct"] > 0)
    down_count = sum(1 for item in stocks if item["change_pct"] < 0)
    flat_count = max(0, len(stocks) - up_count - down_count)
    total = max(1, len(stocks))
    temperature = round(max(0, min(100, 50 + (up_count - down_count) / total * 50)))

    return {
        "trade_date": datetime.now(CN_TZ).date().isoformat(),
        "market_scope": "full_market",
        "temperature": temperature,
        "up_count": up_count,
        "down_count": down_count,
        "flat_count": flat_count,
        "turnover_billion": round(sum(item["turnover_billion"] for item in stocks), 1),
        "indices": _build_indices(ak),
        "sectors": _build_sectors(ak),
    }


def _build_indices(ak: Any) -> list[dict]:
    source = _akshare_source_preference()
    rows = []
    if source in {"auto", "eastmoney"}:
        try:
            index_df = _quiet_call(ak.stock_zh_index_spot_em, symbol="沪深重要指数")
            rows = _records(index_df)
        except Exception:
            rows = []
    if not rows and source in {"auto", "sina"}:
        try:
            rows = _records(_quiet_call(ak.stock_zh_index_spot_sina))
        except Exception:
            rows = []

    by_code = {
        _with_index_exchange_suffix(str(row.get("代码") or "").strip()): row
        for row in rows
    }
    indices = []
    for code, fallback_name in INDEX_NAME_BY_CODE.items():
        normalized_code = _with_index_exchange_suffix(code)
        row = by_code.get(normalized_code, {})
        indices.append(
            {
                "code": normalized_code,
                "name": str(row.get("名称") or fallback_name),
                "price": _num(row.get("最新价")),
                "change_pct": _num(row.get("涨跌幅")),
                "turnover_billion": _num(row.get("成交额")) / 1_000_000_000,
            }
        )
    return indices


def _with_index_exchange_suffix(code: str) -> str:
    compact = code.strip().upper().replace(" ", "")
    if compact.startswith("SH") and len(compact) >= 8:
        return f"{compact[2:]}.SH"
    if compact.startswith("SZ") and len(compact) >= 8:
        return f"{compact[2:]}.SZ"
    if compact.endswith((".SH", ".SZ", ".BJ")):
        return compact
    if compact in {"000001", "000300"}:
        return f"{compact}.SH"
    if compact.startswith("399"):
        return f"{compact}.SZ"
    return _with_exchange_suffix(compact)


def _build_sectors(ak: Any) -> list[dict]:
    source = _akshare_source_preference()
    rows = []
    if source in {"auto", "eastmoney"}:
        try:
            rows = _records(_quiet_call(ak.stock_board_industry_name_em))
        except Exception:
            rows = []
    if not rows:
        try:
            rows = _records(_quiet_call(ak.stock_board_industry_name_ths))
        except Exception:
            return []
    if rows and "涨跌幅" not in rows[0]:
        return _build_ths_sector_changes(ak, rows[:8])

    sectors = []
    for row in rows[:8]:
        change_pct = _num(row.get("涨跌幅"))
        if change_pct >= 2:
            signal = "strong"
        elif change_pct > 0:
            signal = "warming"
        elif change_pct <= -2:
            signal = "risk_off"
        else:
            signal = "neutral"
        sectors.append(
            {
                "name": str(row.get("板块名称") or row.get("名称") or row.get("name") or ""),
                "change_pct": change_pct,
                "signal": signal,
            }
        )
    return [item for item in sectors if item["name"]]


def _build_ths_sector_changes(ak: Any, rows: list[dict]) -> list[dict]:
    sectors = []
    end_date = datetime.now(CN_TZ).strftime("%Y%m%d")
    start_date = (datetime.now(CN_TZ) - timedelta(days=35)).strftime("%Y%m%d")
    for row in rows:
        name = str(row.get("name") or row.get("名称") or row.get("板块名称") or "").strip()
        if not name:
            continue
        try:
            history = _records(
                _quiet_call(
                    ak.stock_board_industry_index_ths,
                    symbol=name,
                    start_date=start_date,
                    end_date=end_date,
                )
            )
        except Exception:
            history = []
        if len(history) >= 2:
            previous_close = _num(history[-2].get("收盘价"))
            latest_close = _num(history[-1].get("收盘价"))
            change_pct = (
                round((latest_close - previous_close) / previous_close * 100, 2)
                if previous_close > 0
                else 0
            )
        else:
            change_pct = 0
        if change_pct >= 2:
            signal = "strong"
        elif change_pct > 0:
            signal = "warming"
        elif change_pct <= -2:
            signal = "risk_off"
        else:
            signal = "neutral"
        sectors.append({"name": name, "change_pct": change_pct, "signal": signal})
    return sorted(sectors, key=lambda item: item["change_pct"], reverse=True)


def _watchlist_item_from_quote(item: dict) -> dict:
    return {
        "code": item["code"],
        "name": item["name"],
        "price": item["price"],
        "change_pct": item["change_pct"],
        "turnover_billion": round(item["turnover_billion"], 2),
        "pe_ttm": item["pe_ttm"],
        "pb": item.get("pb", 0),
        "turnover_rate": item.get("turnover_rate", 0),
        "roe": item.get("roe", 0),
        "tags": _stock_tags(item),
        "updated_at": item.get("updated_at"),
    }


def _build_watchlist(stocks: list[dict]) -> list[dict]:
    watch_codes = _watchlist_codes()
    metadata = _watchlist_metadata_by_code()
    by_code = {item["code"]: item for item in stocks}
    items = []
    for code in watch_codes:
        stock = by_code.get(code)
        if not stock:
            continue
        items.append(_watchlist_item_from_quote(stock))
    if watch_codes:
        found_codes = {item["code"] for item in items}
        missing_codes = [code for code in watch_codes if code not in found_codes]
        if missing_codes:
            try:
                fallback_quotes = _tencent_watchlist_quotes(missing_codes)
            except Exception:
                fallback_quotes = []
            fallback_by_code = {item["code"]: item for item in fallback_quotes}
            for code in missing_codes:
                item = fallback_by_code.get(code)
                items.append(
                    _watchlist_item_from_quote(item)
                    if item
                    else _empty_watchlist_item(code, "Configured symbol not found in live provider")
                )
        enriched = _enrich_watchlist_metrics(items)
        return [_attach_watchlist_pool_metadata(item, metadata) for item in enriched]

    fallback_items = [
        _watchlist_item_from_quote(item)
        for item in sorted(stocks, key=lambda row: row["turnover_billion"], reverse=True)[:8]
    ]
    enriched = _enrich_watchlist_metrics(fallback_items)
    return [_attach_watchlist_pool_metadata(item, metadata) for item in enriched]


def _watchlist_codes() -> list[str]:
    items, _source = _watchlist_items_with_source()
    return _active_watchlist_codes(items)


def _watchlist_codes_with_source() -> tuple[list[str], str]:
    items, source = _watchlist_items_with_source()
    if items:
        return _active_watchlist_codes(items), source
    return DEFAULT_WATCHLIST, "default"


def _watchlist_items_with_source() -> tuple[list[dict], str]:
    universe_items = _read_watchlist_universe_items()
    if universe_items:
        return universe_items, "universe_file"

    stored = _read_watchlist_config_file()
    if stored:
        items = _items_from_codes(stored, source="legacy_file")
        try:
            _write_watchlist_universe_items(items, source="legacy_migration")
        except Exception:
            pass
        return items, "legacy_migrated"

    raw = os.getenv("QUANT_WATCHLIST", "")
    if not raw.strip():
        return _items_from_codes(DEFAULT_WATCHLIST, source="default"), "default"

    env_codes = [
        item
        for item in (_normalize_watchlist_code(part) for part in raw.split(","))
        if item
    ]
    codes = env_codes or DEFAULT_WATCHLIST
    return _items_from_codes(codes, source="env"), "env"


def _active_watchlist_codes(items: list[dict]) -> list[str]:
    codes = []
    seen = set()
    for item in items:
        code = _normalize_watchlist_code(str(item.get("code") or ""))
        pool = str(item.get("pool") or "core")
        status = str(item.get("status") or "active")
        if (
            code
            and code not in seen
            and pool in WATCHLIST_ACTIVE_POOLS
            and status != "archived"
        ):
            codes.append(code)
            seen.add(code)
    return codes


def _watchlist_metadata_by_code() -> dict[str, dict]:
    items, _source = _watchlist_items_with_source()
    return {item["code"]: item for item in items if isinstance(item.get("code"), str)}


def _items_from_codes(codes: list[str], source: str = "legacy_file") -> list[dict]:
    now = _now_iso()
    items = []
    seen = set()
    for raw in codes:
        code = _normalize_watchlist_code(str(raw))
        if not code or code in seen:
            continue
        seen.add(code)
        items.append(
            {
                "code": code,
                "pool": "core",
                "status": "active",
                "source": source,
                "reason": "migrated from flat watchlist",
                "evidence": [],
                "score": None,
                "confidence": None,
                "data_quality": "unknown",
                "first_seen_at": now,
                "last_reviewed_at": now,
                "updated_at": now,
            }
        )
    return items


def _normalize_watchlist_universe_item(raw: Any) -> dict | None:
    if not isinstance(raw, dict):
        return None
    code = _normalize_watchlist_code(str(raw.get("code") or ""))
    if not code:
        return None
    pool = str(raw.get("pool") or "core").strip().lower()
    if pool not in WATCHLIST_POOL_LABELS:
        pool = "core"
    status = str(raw.get("status") or "active").strip().lower()
    if status not in {"active", "cooling", "protected", "pending_remove", "archived"}:
        status = "active"
    evidence = raw.get("evidence")
    return {
        "code": code,
        "name": raw.get("name"),
        "pool": pool,
        "pool_label": WATCHLIST_POOL_LABELS.get(pool, pool),
        "status": status,
        "source": str(raw.get("source") or "unknown"),
        "reason": str(raw.get("reason") or ""),
        "evidence": evidence if isinstance(evidence, list) else [],
        "score": raw.get("score"),
        "confidence": raw.get("confidence"),
        "data_quality": str(raw.get("data_quality") or "unknown"),
        "first_seen_at": raw.get("first_seen_at"),
        "last_reviewed_at": raw.get("last_reviewed_at"),
        "expires_at": raw.get("expires_at"),
        "updated_at": raw.get("updated_at"),
    }


def _read_watchlist_universe_items() -> list[dict]:
    if not WATCHLIST_UNIVERSE_PATH.exists():
        return []
    try:
        data = json.loads(WATCHLIST_UNIVERSE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return []
    raw_items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(raw_items, list):
        return []
    items = []
    seen = set()
    for raw in raw_items:
        item = _normalize_watchlist_universe_item(raw)
        if item and item["code"] not in seen:
            items.append(item)
            seen.add(item["code"])
    return items[:WATCHLIST_MAX_UNIVERSE_SYMBOLS]


def _write_watchlist_universe_items(items: list[dict], source: str) -> None:
    normalized = []
    seen = set()
    for raw in items:
        item = _normalize_watchlist_universe_item(raw)
        if item and item["code"] not in seen:
            normalized.append(item)
            seen.add(item["code"])
    if len(_active_watchlist_codes(normalized)) > WATCHLIST_MAX_ACTIVE_SYMBOLS:
        raise ValueError(
            f"Active watchlist supports at most {WATCHLIST_MAX_ACTIVE_SYMBOLS} symbols"
        )
    if len(normalized) > WATCHLIST_MAX_UNIVERSE_SYMBOLS:
        raise ValueError(
            f"Watchlist universe supports at most {WATCHLIST_MAX_UNIVERSE_SYMBOLS} symbols"
        )
    WATCHLIST_UNIVERSE_PATH.parent.mkdir(parents=True, exist_ok=True)
    WATCHLIST_UNIVERSE_PATH.write_text(
        json.dumps(
            {
                "version": 1,
                "source": source,
                "updated_at": _now_iso(),
                "items": normalized,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


def _read_watchlist_config_file() -> list[str] | None:
    if not WATCHLIST_CONFIG_PATH.exists():
        return None
    try:
        data = json.loads(WATCHLIST_CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return None

    raw_codes = data.get("codes") if isinstance(data, dict) else None
    if not isinstance(raw_codes, list):
        return None

    codes = []
    seen = set()
    for raw in raw_codes:
        code = _normalize_watchlist_code(str(raw))
        if code and code not in seen:
            codes.append(code)
            seen.add(code)
    return codes or None


def _normalize_watchlist_code(code: str) -> str | None:
    compact = code.strip().upper().replace(" ", "")
    if not compact:
        return None
    if "." in compact:
        symbol, exchange = compact.split(".", 1)
        if not (symbol.isdigit() and len(symbol) == 6):
            return None
        if exchange not in {"SH", "SZ", "BJ"}:
            return None
        return f"{symbol}.{exchange}"
    if compact.isdigit() and len(compact) == 6:
        return _with_exchange_suffix(compact)
    return None


def _stock_tags(stock: dict) -> list[str]:
    tags = []
    if stock["turnover_billion"] >= 5:
        tags.append("高成交")
    if stock["change_pct"] >= 3:
        tags.append("强势")
    elif stock["change_pct"] <= -3:
        tags.append("回撤")
    if 0 < stock["pe_ttm"] <= 15:
        tags.append("低估值")
    if stock.get("turnover_rate", 0) >= 5:
        tags.append("活跃")
    return tags or ["观察"]


def _build_signals(watchlist: list[dict]) -> list[dict]:
    signals = []
    for idx, stock in enumerate(watchlist[:6], start=1):
        action = "observe"
        strength = 50
        reason = "进入关注列表，等待更多策略条件确认。"
        risk = "该信号来自实时行情的轻量规则，不能作为交易建议。"

        if stock["change_pct"] >= 3 and stock["turnover_billion"] >= 3:
            action = "buy_candidate"
            strength = min(95, round(70 + stock["change_pct"] * 3))
            reason = "涨幅和成交额同步放大，短线动量较强。"
            risk = "放量上涨后波动可能加大，需要控制仓位和追高风险。"
        elif stock["change_pct"] <= -3:
            action = "sell_candidate"
            strength = min(90, round(65 + abs(stock["change_pct"]) * 3))
            reason = "跌幅较大，触发回撤风险观察。"
            risk = "需要区分系统性回撤和个股基本面变化。"
        elif 0 < stock["pe_ttm"] <= 15:
            action = "watch"
            strength = 66
            reason = "估值处于较低区间，适合纳入中期观察。"
            risk = "低估值可能来自盈利预期下修，需要结合财报验证。"

        signals.append(
            {
                "id": f"sig-{datetime.now(CN_TZ).strftime('%Y%m%d')}-{idx:03d}",
                "strategy": "实时行情轻量规则",
                "code": stock["code"],
                "name": stock["name"],
                "action": action,
                "strength": strength,
                "reason": reason,
                "risk": risk,
            }
        )
    return signals


def _build_paper_portfolio(watchlist: list[dict]) -> dict:
    cash = 100_000.0
    positions = []
    for stock in watchlist[:3]:
        if stock["price"] <= 0:
            continue
        quantity = max(100, int(30_000 / stock["price"] / 100) * 100)
        cost = round(stock["price"] / (1 + stock["change_pct"] / 100), 2)
        market_value = round(quantity * stock["price"], 2)
        positions.append(
            {
                "code": stock["code"],
                "name": stock["name"],
                "quantity": quantity,
                "cost": cost,
                "price": stock["price"],
                "market_value": market_value,
                "pnl_pct": round((stock["price"] - cost) / cost * 100, 2) if cost else 0,
                "weight_pct": 0,
            }
        )

    total_value = cash + sum(item["market_value"] for item in positions)
    for item in positions:
        item["weight_pct"] = round(item["market_value"] / total_value * 100, 2)

    largest = max((item["weight_pct"] for item in positions), default=0)
    daily_pnl = sum(item["market_value"] * item["pnl_pct"] / 100 for item in positions)
    return {
        "mode": "paper",
        "total_value": round(total_value, 2),
        "cash": cash,
        "daily_pnl": round(daily_pnl, 2),
        "daily_pnl_pct": round(daily_pnl / total_value * 100, 2) if total_value else 0,
        "total_pnl": round(daily_pnl, 2),
        "total_pnl_pct": round(daily_pnl / total_value * 100, 2) if total_value else 0,
        "max_drawdown_pct": 0,
        "positions": positions,
        "risk": {
            "cash_weight_pct": round(cash / total_value * 100, 2) if total_value else 0,
            "largest_position_pct": largest,
            "sector_concentration": "未接入行业持仓归因",
            "alerts": _portfolio_alerts(largest),
        },
    }


def _portfolio_alerts(largest: float) -> list[str]:
    alerts = ["当前组合为模拟组合，尚未连接实盘交易网关。"]
    if largest >= 40:
        alerts.append("单一持仓占比超过 40%，建议检查仓位上限。")
    return alerts


def _build_daily_report(market: dict, signals: list[dict], portfolio: dict) -> dict:
    strong_count = sum(1 for item in signals if item["action"] == "buy_candidate")
    risk_count = sum(1 for item in signals if item["action"] == "sell_candidate")
    summary = (
        f"市场温度 {market['temperature']}，上涨 {market['up_count']} 家，"
        f"下跌 {market['down_count']} 家，成交额约 {market['turnover_billion']:.1f}B。"
        f"当前关注列表产生 {strong_count} 条候选买入信号、{risk_count} 条回撤风险信号。"
    )
    return {
        "title": "A股实时观察",
        "summary": summary,
        "next_actions": [
            "开盘前检查关注列表是否仍符合个人策略边界。",
            "对候选买入信号补充行业、财报和消息面验证。",
            "保持模拟组合模式，不自动执行实盘交易。",
        ],
    }
