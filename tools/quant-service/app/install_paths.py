"""Explicit installer resource/data boundaries; development paths remain unchanged."""
from __future__ import annotations

import os
from pathlib import Path


def installation_mode() -> bool:
    return os.getenv("ZHIYU_QUANT_INSTALL_MODE") == "1"


def absolute_environment_path(name: str) -> Path:
    raw = os.getenv(name, "").strip()
    if not raw or not Path(raw).is_absolute():
        raise ValueError(f"{name.lower()}_must_be_absolute")
    return Path(raw).resolve()


def _overlap(left: Path, right: Path) -> bool:
    return left.is_relative_to(right) or right.is_relative_to(left)


def installation_paths() -> tuple[Path, Path, Path]:
    root = absolute_environment_path("ZHIYU_INSTALL_ROOT")
    owned = absolute_environment_path("ZHIYU_INSTALL_DATA_DIR")
    data = absolute_environment_path("QUANT_DATA_DIR")
    if _overlap(root, owned) or data == owned or not data.is_relative_to(owned):
        raise ValueError("quant_installation_data_boundary_invalid")
    marker = owned / ".zhiyu-install-data"
    if marker.is_symlink() or marker.resolve() != marker or not marker.is_file() or marker.read_text(encoding="utf-8").strip() != "zhiyu-private-install-data-v1":
        raise ValueError("quant_installation_data_not_owned")
    return root, owned, data


def resource_directory() -> Path:
    if not installation_mode():
        raw = os.getenv("ZHIYU_QUANT_RESOURCE_DIR", "").strip()
        return absolute_environment_path("ZHIYU_QUANT_RESOURCE_DIR") if raw else Path(__file__).resolve().parents[1]
    root, owned, _ = installation_paths()
    resource = absolute_environment_path("ZHIYU_QUANT_RESOURCE_DIR")
    if not resource.is_relative_to(root) or _overlap(resource, owned) or not (resource / "embedded_worker.py").is_file():
        raise ValueError("quant_resource_boundary_invalid")
    return resource


def data_directory() -> Path:
    if installation_mode():
        return installation_paths()[2]
    raw = os.getenv("QUANT_DATA_DIR", "").strip()
    return absolute_environment_path("QUANT_DATA_DIR") if raw else resource_directory() / "data"


def config_directory() -> Path:
    return resource_directory() / "config"


def timing_log_path() -> Path:
    raw = os.getenv("QUANT_TIMING_LOG_PATH", "").strip()
    if installation_mode():
        _, owned, _ = installation_paths()
        log = absolute_environment_path("QUANT_TIMING_LOG_PATH") if raw else owned / "logs" / "quant-timing.log"
        if log == owned or not log.is_relative_to(owned):
            raise ValueError("quant_timing_log_boundary_invalid")
        return log
    return Path(raw) if raw else resource_directory() / "quant-timing.log"
