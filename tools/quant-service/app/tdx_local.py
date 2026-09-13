from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


TDX_MARKETS = ("sh", "sz", "bj")


def get_tdx_local_status() -> dict[str, Any]:
    roots = _candidate_tdx_roots()
    detected = [_inspect_tdx_root(root) for root in roots]
    usable = [item for item in detected if item["usable"]]
    selected = usable[0] if usable else None
    return {
        "enabled": _tdx_local_enabled(),
        "configured_paths": _configured_tdx_paths(),
        "searched_paths": [str(path) for path in roots],
        "available": bool(selected),
        "selected_root": selected["root"] if selected else None,
        "selected": selected,
        "detected": detected,
        "setup_hint": (
            "Install Tongdaxin, download local market data, then set "
            "QUANT_TDX_LOCAL_PATH to the directory that contains vipdoc or T0002."
        ),
    }


def _tdx_local_enabled() -> bool:
    return os.getenv("QUANT_TDX_LOCAL_ENABLED", "true").strip().lower() not in {
        "0",
        "false",
        "no",
        "off",
        "disabled",
    }


def _configured_tdx_paths() -> list[str]:
    raw = os.getenv("QUANT_TDX_LOCAL_PATHS") or os.getenv("QUANT_TDX_LOCAL_PATH") or ""
    return [part.strip().strip('"') for part in raw.split(";") if part.strip()]


def _candidate_tdx_roots() -> list[Path]:
    seen: set[str] = set()
    candidates = [
        *[Path(path) for path in _configured_tdx_paths()],
        Path("C:/new_tdx"),
        Path("C:/new_tdx64"),
        Path("D:/new_tdx"),
        Path("D:/new_tdx64"),
        Path("E:/new_tdx"),
        Path("E:/new_tdx64"),
        Path("C:/tdx"),
        Path("D:/tdx"),
        Path("E:/tdx"),
        Path("C:/通达信"),
        Path("D:/通达信"),
        Path("E:/通达信"),
        Path("C:/Program Files/new_tdx"),
        Path("C:/Program Files/new_tdx64"),
        Path("C:/Program Files (x86)/new_tdx"),
        Path("C:/Program Files (x86)/new_tdx64"),
        Path("C:/Program Files/通达信"),
        Path("C:/Program Files (x86)/通达信"),
    ]
    roots: list[Path] = []
    for candidate in candidates:
        key = str(candidate).lower()
        if key in seen:
            continue
        seen.add(key)
        roots.append(candidate)
    return roots


def _inspect_tdx_root(root: Path) -> dict[str, Any]:
    root_exists = root.exists()
    vipdoc = root / "vipdoc"
    user_data = root / "T0002"
    daily_counts = {
        market: _count_files(vipdoc / market / "lday", "*.day")
        for market in TDX_MARKETS
    }
    minute_counts = {
        market: _count_files(vipdoc / market / "minline", "*.lc1")
        + _count_files(vipdoc / market / "fzline", "*.lc5")
        for market in TDX_MARKETS
    }
    blocknew = user_data / "blocknew"
    block_files = _count_files(blocknew, "*.blk")
    usable = root_exists and (
        any(count > 0 for count in daily_counts.values())
        or any(count > 0 for count in minute_counts.values())
        or block_files > 0
    )
    return {
        "root": str(root),
        "exists": root_exists,
        "usable": usable,
        "vipdoc": _path_info(vipdoc),
        "t0002": _path_info(user_data),
        "daily_files": daily_counts,
        "minute_files": minute_counts,
        "block_files": block_files,
        "latest_daily_file": _latest_file(vipdoc, "*.day"),
    }


def _path_info(path: Path) -> dict[str, Any]:
    exists = path.exists()
    info: dict[str, Any] = {"path": str(path), "exists": exists}
    if exists:
        stat = path.stat()
        info["modified_at"] = datetime.fromtimestamp(
            stat.st_mtime,
            tz=timezone.utc,
        ).isoformat()
    return info


def _count_files(path: Path, pattern: str) -> int:
    if not path.exists() or not path.is_dir():
        return 0
    try:
        return sum(1 for item in path.glob(pattern) if item.is_file())
    except OSError:
        return 0


def _latest_file(root: Path, pattern: str) -> dict[str, Any] | None:
    if not root.exists() or not root.is_dir():
        return None
    latest: Path | None = None
    latest_mtime = 0.0
    try:
        for item in root.rglob(pattern):
            if not item.is_file():
                continue
            mtime = item.stat().st_mtime
            if mtime > latest_mtime:
                latest = item
                latest_mtime = mtime
    except OSError:
        return None
    if latest is None:
        return None
    return {
        "path": str(latest),
        "modified_at": datetime.fromtimestamp(
            latest_mtime,
            tz=timezone.utc,
        ).isoformat(),
    }
