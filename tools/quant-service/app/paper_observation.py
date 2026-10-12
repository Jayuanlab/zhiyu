"""Versioned local calendar/policy and raw provider timestamps; never synthesize current quotes."""
import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import provider
from .paper_commands import CN_TZ
from .paper_ledger_model import PaperLedgerError, digest, number, timestamp
from .install_paths import config_directory

CONFIG = config_directory()


def calendar_fact(now, config_dir=CONFIG):
    local = now.astimezone(CN_TZ)
    date = local.date().isoformat()
    try:
        raw = json.loads((config_dir / f"paper-calendar-{local.year}.json").read_text(encoding="utf-8"))
        if not raw["validFrom"] <= date <= raw["validThrough"] or not raw["version"]:
            raise PaperLedgerError("calendar_outside_coverage")
        if set(raw["sources"]) != {"SH", "SZ", "BJ"}:
            raise PaperLedgerError("calendar_exchange_coverage_incomplete")
        closed = any(start <= date <= end for start, end in raw["closedRanges"])
        return {"version": raw["version"], "date": date, "publishedAt": raw["publishedAt"],
                "expiresAt": raw["expiresAt"], "source": raw["sources"],
                "isTradingDay": local.weekday() < 5 and not closed}
    except (OSError, ValueError, KeyError, TypeError):
        return {"date": date, "isTradingDay": None, "warning": "calendar_unknown"}


def _watchlist_bytes():
    # Read configured facts without provider's legacy migration or default demo watchlist.
    path = provider.WATCHLIST_UNIVERSE_PATH if provider.WATCHLIST_UNIVERSE_PATH.exists() else provider.WATCHLIST_CONFIG_PATH
    raw = path.read_bytes()
    content = json.loads(raw.decode("utf-8"))
    if path == provider.WATCHLIST_UNIVERSE_PATH:
        if not isinstance(content, dict) or not isinstance(content.get("items"), list):
            raise PaperLedgerError("watchlist_invalid")
        codes = provider._active_watchlist_codes(content["items"])
    else:
        items = content.get("codes") if isinstance(content, dict) else content
        if not isinstance(items, list):
            raise PaperLedgerError("watchlist_invalid")
        codes = [provider._normalize_watchlist_code(str(item)) for item in items]
        if any(not code for code in codes):
            raise PaperLedgerError("watchlist_invalid")
    return path, raw, sorted(set(codes))


def observe_paper_market(*, clock=None, config_dir=CONFIG):
    clock = clock or (lambda: datetime.now(timezone.utc))
    started = clock()
    policy = json.loads((config_dir / "paper-market-policy.json").read_text(encoding="utf-8"))
    snapshot = {"calendar": calendar_fact(started, config_dir), "quotePolicy": policy, "quotes": {}}
    try:
        path, raw, codes = _watchlist_bytes()
        observed = clock()
        max_age = number(policy["watchlistSnapshotMaxAgeSeconds"], 0)
        if max_age <= 0:
            raise PaperLedgerError("watchlist_policy_invalid")
        snapshot.update(watchlist=codes, watchlistVersion=hashlib.sha256(raw).hexdigest(),
                        watchlistObservedAt=observed.isoformat(),
                        watchlistExpiresAt=(observed + timedelta(seconds=int(max_age))).isoformat())
        rows = provider._tencent_watchlist_quotes(codes)
        # A concurrent pool change invalidates this batch instead of trading the previous pool.
        latest_path, latest_raw, _ = _watchlist_bytes()
        if path != latest_path or latest_raw != raw:
            raise PaperLedgerError("watchlist_changed_during_quote_fetch")
        for row in rows:
            observed_at = row.get("updated_at")
            try:
                stamp = timestamp(observed_at)
                good = number(row.get("price"), 3) > 0
            except PaperLedgerError:
                stamp, good = None, False
            snapshot["quotes"][row["code"]] = {**row, "provider": "tencent_quote_batch", "quoteId": digest(row),
                "observedAt": observed_at, "quoteSessionDate": stamp.astimezone(CN_TZ).date().isoformat() if stamp else None,
                "qualityStatus": "ready" if good else "unavailable"}
        snapshot["fetchedAt"] = clock().isoformat()
    except (OSError, ValueError, KeyError, TypeError, RuntimeError) as exc:
        snapshot.update(quotes={}, watchlistVersion=None, warning=str(exc) if isinstance(exc, PaperLedgerError) else type(exc).__name__)
    return snapshot
