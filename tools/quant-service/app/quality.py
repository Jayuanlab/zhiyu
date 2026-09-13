"""Quality facts only; no calendar or matching decisions are inferred here."""
from datetime import datetime, timezone


def dashboard_quality(dashboard: dict) -> dict:
    market = dashboard.get("market") or {}
    cache = market.get("cache") or dashboard.get("cache") or {}
    scope = market.get("market_scope", "unknown")
    if dashboard.get("service_mode") == "sample":
        scope = "sample"
    elif scope == "watchlist_fallback":
        scope = "watchlist"
    elif scope not in {"full_market", "watchlist"}:
        scope = "unknown"
    observed = market.get("observed_at")
    warnings = [str(value) for value in [market.get("market_warning"), market.get("provider_error"), dashboard.get("provider_error")] if value]
    if scope != "full_market":
        warnings.append("Market statistics do not cover the full market")
    session = None
    if observed:
        try:
            parsed = datetime.fromisoformat(observed)
            if parsed.tzinfo is None:
                raise ValueError("observation timezone is unknown")
            session = parsed.date().isoformat()
        except (TypeError, ValueError):
            observed = None
    if not observed:
        warnings.append("Market observation time is unknown")
    stale = bool(cache.get("stale"))
    if cache.get("expires_at"):
        try:
            expires = datetime.fromisoformat(cache["expires_at"])
            stale = stale or expires <= datetime.now(timezone.utc)
        except (TypeError, ValueError):
            warnings.append("Cache expiration time is unknown")
    return {
        "schemaVersion": "quant-quality.v1",
        "provider": market.get("market_source") or dashboard.get("data_provider") or "unknown",
        "detail": dashboard.get("data_source_detail"), "scope": scope,
        "observedAt": observed, "fetchedAt": market.get("fetched_at"),
        "generatedAt": dashboard.get("generated_at"), "expiresAt": cache.get("expires_at"),
        "refreshing": bool(cache.get("refreshing")),
        "lastRefreshError": market.get("provider_error") or dashboard.get("provider_error"),
        "warnings": warnings, "qualityStatus": "stale" if stale else "degraded" if warnings else "ready",
        "exchange": "CN_A", "quoteSessionDate": session, "calendarVersion": None,
    }
