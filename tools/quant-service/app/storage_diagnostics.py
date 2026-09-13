from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .paper_trading import PAPER_ACCOUNT_PATH
from .provider import (
    MARKET_UNIVERSE_PATH,
    WATCHLIST_CONFIG_PATH,
    WATCHLIST_UNIVERSE_PATH,
    get_watchlist_config,
)
from .tdx_local import get_tdx_local_status


def _file_info(path: Path) -> dict[str, Any]:
    exists = path.exists()
    info: dict[str, Any] = {
        "path": str(path),
        "exists": exists,
    }
    if exists:
        stat = path.stat()
        info.update(
            {
                "is_file": path.is_file(),
                "size_bytes": stat.st_size if path.is_file() else None,
                "modified_at": datetime.fromtimestamp(
                    stat.st_mtime,
                    tz=timezone.utc,
                ).isoformat(),
            }
        )
    return info


def _read_json(path: Path) -> dict[str, Any] | list[Any] | None:
    if not path.exists() or not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, (dict, list)) else None
    except Exception:
        return None


def _position_count(account: dict[str, Any]) -> int:
    positions = account.get("positions")
    if isinstance(positions, list) and positions:
        return len(positions)
    lots = account.get("lots")
    if not isinstance(lots, list):
        return 0
    active_codes = {
        str(lot.get("code") or "")
        for lot in lots
        if int(lot.get("remaining_quantity") or 0) > 0
    }
    return len([code for code in active_codes if code])


def get_storage_diagnostics() -> dict[str, Any]:
    watchlist = get_watchlist_config()
    account = _read_json(PAPER_ACCOUNT_PATH)
    account_dict = account if isinstance(account, dict) else {}
    tdx_local = get_tdx_local_status()
    return {
        "service": "quant-service",
        "provider": os.getenv("QUANT_DATA_PROVIDER", "auto"),
        "paper_trading_enabled": os.getenv(
            "QUANT_PAPER_TRADING_ENABLED",
            "true",
        ).strip().lower()
        not in {"0", "false", "no", "off", "disabled"},
        "files": {
            "watchlist": _file_info(WATCHLIST_CONFIG_PATH),
            "watchlist_universe": _file_info(WATCHLIST_UNIVERSE_PATH),
            "market_universe": _file_info(MARKET_UNIVERSE_PATH),
            "paper_account": _file_info(PAPER_ACCOUNT_PATH),
        },
        "counts": {
            "watchlist_codes": len(watchlist.get("codes", [])),
            "watchlist_items": len(watchlist.get("items", [])),
            "orders": len(account_dict.get("orders", [])),
            "fills": len(account_dict.get("fills", [])),
            "positions": _position_count(account_dict),
        },
        "tdx_local": {
            "enabled": tdx_local["enabled"],
            "available": tdx_local["available"],
            "selected_root": tdx_local["selected_root"],
            "configured_paths": tdx_local["configured_paths"],
        },
    }
