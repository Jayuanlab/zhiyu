#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = ROOT.parent.parent
DATA_DIR = ROOT / "data"
DRAFT_DIR = DATA_DIR / "drafts"
LOG_DIR = ROOT / "logs"

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def emit(payload: dict[str, Any], code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    raise SystemExit(code)


def read_stdin_json() -> dict[str, Any]:
    raw = sys.stdin.read().lstrip("\ufeff").strip()
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        emit({"ok": False, "error": f"Invalid stdin JSON: {exc}"}, 2)
    return value if isinstance(value, dict) else {}


def load_json_file(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        emit({"ok": False, "error": f"File not found: {path}"}, 2)
    except json.JSONDecodeError as exc:
        emit({"ok": False, "error": f"Invalid JSON file {path}: {exc}"}, 2)
    return value if isinstance(value, dict) else {}


def ensure_dirs() -> None:
    DRAFT_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)


def draft_path(draft_id: str) -> Path:
    safe = "".join(ch for ch in draft_id if ch.isalnum() or ch in "-_")
    if not safe:
        emit({"ok": False, "error": "Invalid draft id"}, 2)
    return DRAFT_DIR / f"{safe}.json"


def load_draft(draft_id: str) -> dict[str, Any]:
    path = draft_path(draft_id)
    if not path.exists():
        emit({"ok": False, "error": "Draft not found", "draft_id": draft_id}, 2)
    return json.loads(path.read_text(encoding="utf-8"))


def first_text(value: Any) -> str:
    return value.strip() if isinstance(value, str) and value.strip() else ""


def split_command(command: str) -> list[str]:
    if os.name == "nt":
        return shlex.split(command, posix=False)
    return shlex.split(command)


def sau_command() -> str:
    return os.getenv("DOUYIN_PUBLISHER_SAU_CMD", "sau")


def account_name(draft: dict[str, Any] | None = None) -> str:
    if draft:
        account = first_text(draft.get("account_label"))
        if account:
            return account
    return os.getenv("DOUYIN_PUBLISHER_ACCOUNT", "default")


def detect_sau_root() -> Path | None:
    explicit = os.getenv("DOUYIN_PUBLISHER_SAU_ROOT")
    candidates = [
        Path(explicit) if explicit else None,
        ROOT / "vendor" / "social-auto-upload",
        PROJECT_ROOT / "downloads" / "social-auto-upload",
    ]
    for candidate in candidates:
        if candidate and (candidate / "sau_cli.py").exists():
            return candidate.resolve()
    return None


def detect_sau_python() -> str:
    explicit = os.getenv("DOUYIN_PUBLISHER_SAU_PYTHON")
    if explicit:
        return explicit
    venv_python = ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if venv_python.exists():
        return str(venv_python)
    return "py -3.12" if os.name == "nt" else "python3"


def sau_base_command() -> list[str]:
    explicit = os.getenv("DOUYIN_PUBLISHER_SAU_BASE_CMD")
    if explicit:
        return split_command(explicit)
    if shutil.which(sau_command()):
        return [sau_command()]
    sau_root = detect_sau_root()
    if sau_root:
        return split_command(detect_sau_python()) + [str(sau_root / "sau_cli.py")]
    return [sau_command()]


def build_default_login_command() -> list[str]:
    return sau_base_command() + [
        "douyin",
        "login",
        "--account",
        account_name(),
        "--headed",
    ]


def build_default_check_command() -> list[str]:
    return sau_base_command() + ["douyin", "check", "--account", account_name()]


def format_template(template: str, draft: dict[str, Any]) -> str:
    topics = draft.get("topics")
    topic_text = " ".join(str(item) for item in topics) if isinstance(topics, list) else ""
    values = {
        "draft_id": str(draft.get("id", "")),
        "account": account_name(draft),
        "video_path": str(draft.get("video_path", "")),
        "title": str(draft.get("title", "")),
        "description": str(draft.get("description", "")),
        "topics": topic_text,
        "cover_path": str(draft.get("cover_path", "")),
        "scheduled_at": str(draft.get("scheduled_at", "")),
    }
    return template.format(**values)


def format_account_template(template: str) -> str:
    return template.format(account=account_name())


def build_upload_command(draft: dict[str, Any]) -> list[str]:
    template = os.getenv("DOUYIN_PUBLISHER_UPLOAD_CMD")
    if template:
        return split_command(format_template(template, draft))

    command = [
        *sau_base_command(),
        "douyin",
        "upload-video",
        "--account",
        account_name(draft),
        "--file",
        str(draft.get("video_path", "")),
        "--title",
        str(draft.get("title", "")),
    ]
    description = first_text(draft.get("description"))
    if description:
        command += ["--desc", description]
    cover_path = first_text(draft.get("cover_path"))
    if cover_path:
        command += ["--thumbnail", cover_path]
    scheduled_at = first_text(draft.get("scheduled_at"))
    if scheduled_at:
        command += ["--schedule", scheduled_at]
    topics = draft.get("topics")
    if isinstance(topics, list) and topics:
        command += ["--tags", ",".join(str(item) for item in topics)]
    return command


def build_publish_command(draft: dict[str, Any]) -> list[str]:
    template = os.getenv("DOUYIN_PUBLISHER_PUBLISH_CMD")
    if template:
        return split_command(format_template(template, draft))
    return build_upload_command(draft)


def command_exists(command: list[str]) -> bool:
    if not command:
        return False
    exe = command[0].strip('"')
    if Path(exe).exists():
        return True
    return shutil.which(exe) is not None


def execution_cwd_for(command: list[str]) -> Path:
    for item in command:
        path = Path(item)
        if path.name == "sau_cli.py" and path.exists():
            return path.parent
    return ROOT


def child_process_env(cwd: Path) -> dict[str, str]:
    env = dict(os.environ)
    existing_pythonpath = env.get("PYTHONPATH", "")
    env["PYTHONIOENCODING"] = env.get("PYTHONIOENCODING", "utf-8")
    env["PYTHONUTF8"] = env.get("PYTHONUTF8", "1")
    env["PYTHONPATH"] = (
        str(cwd)
        if not existing_pythonpath
        else f"{cwd}{os.pathsep}{existing_pythonpath}"
    )

    node_options = env.get("NODE_OPTIONS", "")
    if "./scripts/patch-http-timeout.cjs" in node_options:
        env.pop("NODE_OPTIONS", None)
    return env


def run_command(command: list[str], timeout: int = 900) -> dict[str, Any]:
    started = time.time()
    cwd = execution_cwd_for(command)
    try:
        result = subprocess.run(
            command,
            cwd=str(cwd),
            env=child_process_env(cwd),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except FileNotFoundError as exc:
        return {"ok": False, "error": str(exc), "error_type": "FileNotFound"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"Command timed out after {timeout}s", "error_type": "Timeout"}

    log_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8]
    log_path = LOG_DIR / f"{log_id}.json"
    payload = {
        "command": command,
        "cwd": str(cwd),
        "returncode": result.returncode,
        "stdout": result.stdout[-20000:],
        "stderr": result.stderr[-20000:],
        "duration_ms": round((time.time() - started) * 1000),
        "created_at": now_iso(),
    }
    log_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "ok": result.returncode == 0,
        "returncode": result.returncode,
        "stdout": result.stdout[-4000:],
        "stderr": result.stderr[-4000:],
        "cwd": str(cwd),
        "log_path": str(log_path),
        "duration_ms": payload["duration_ms"],
    }


def normalize_account_check(result: dict[str, Any]) -> dict[str, Any]:
    stdout = str(result.get("stdout") or "").strip().lower()
    first_line = stdout.splitlines()[0].strip() if stdout else ""
    valid = first_line == "valid"
    invalid = first_line == "invalid"
    status = "valid" if valid else "invalid" if invalid else "unknown"
    return {
        "account_valid": valid,
        "account_status": status,
        "account_status_label": "有效" if valid else "无效" if invalid else "未知",
    }


def cmd_health(_: argparse.Namespace) -> None:
    login_template = os.getenv("DOUYIN_PUBLISHER_LOGIN_CMD", "")
    check_template = os.getenv("DOUYIN_PUBLISHER_CHECK_CMD", "")
    login_command = split_command(format_account_template(login_template)) if login_template else build_default_login_command()
    check_command = split_command(format_account_template(check_template)) if check_template else build_default_check_command()
    has_cli = command_exists(check_command) or command_exists(login_command)
    sau_root = detect_sau_root()
    sau_python = detect_sau_python()
    sau_conf = sau_root / "conf.py" if sau_root else None
    emit(
        {
            "ok": True,
            "platform": "douyin",
            "adapter": "douyin-publisher",
            "publisher_cli_available": has_cli,
            "sau_command": sau_command(),
            "sau_root": str(sau_root) if sau_root else None,
            "sau_conf_exists": bool(sau_conf and sau_conf.exists()),
            "sau_python": sau_python,
            "account": account_name(),
            "login_command": login_command,
            "check_command": check_command,
            "draft_dir": str(DRAFT_DIR),
            "log_dir": str(LOG_DIR),
            "message": "Local uploader detected." if has_cli else "No local uploader CLI detected. Install social-auto-upload or configure DOUYIN_PUBLISHER_*_CMD.",
            "install_hint": "Run tools/douyin-publisher/install-social-auto-upload.ps1 to create a local Python 3.12 environment and install the cloned social-auto-upload project.",
        }
    )


def cmd_login(args: argparse.Namespace) -> None:
    template = os.getenv("DOUYIN_PUBLISHER_LOGIN_CMD", "")
    command = split_command(format_account_template(template)) if template else build_default_login_command()
    payload = {
        "ok": True,
        "platform": "douyin",
        "action": "login",
        "execute": bool(args.execute),
        "command": command,
        "message": "Run this command locally and scan the Douyin QR code in the opened browser.",
    }
    if args.execute:
        payload["result"] = run_command(command, timeout=args.timeout)
        payload["ok"] = bool(payload["result"].get("ok"))
    emit(payload, 0 if payload["ok"] else 1)


def cmd_check(args: argparse.Namespace) -> None:
    template = os.getenv("DOUYIN_PUBLISHER_CHECK_CMD", "")
    command = split_command(format_account_template(template)) if template else build_default_check_command()
    payload = {
        "ok": True,
        "platform": "douyin",
        "action": "check",
        "execute": bool(args.execute),
        "command": command,
        "publisher_cli_available": command_exists(command),
    }
    if args.execute:
        payload["result"] = run_command(command, timeout=args.timeout)
        payload.update(normalize_account_check(payload["result"]))
        payload["ok"] = bool(payload["result"].get("ok"))
    emit(payload, 0 if payload["ok"] else 1)


def cmd_create_draft(args: argparse.Namespace) -> None:
    ensure_dirs()
    payload = load_json_file(Path(args.payload)) if args.payload else read_stdin_json()
    draft_id = first_text(payload.get("id")) or f"dy_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"
    title = first_text(payload.get("title"))
    video_path = first_text(payload.get("video_path"))
    if not title:
        emit({"ok": False, "error": "title is required"}, 2)
    if not video_path:
        emit({"ok": False, "error": "video_path is required"}, 2)

    draft = {
        "id": draft_id,
        "platform": "douyin",
        "status": "draft",
        "title": title,
        "description": first_text(payload.get("description")),
        "topics": payload.get("topics") if isinstance(payload.get("topics"), list) else [],
        "video_path": video_path,
        "cover_path": first_text(payload.get("cover_path")) or None,
        "scheduled_at": first_text(payload.get("scheduled_at")) or None,
        "ai_generated": bool(payload.get("ai_generated", False)),
        "account_label": first_text(payload.get("account_label")) or "default",
        "source": payload.get("source") if isinstance(payload.get("source"), dict) else {},
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    path = draft_path(draft_id)
    path.write_text(json.dumps(draft, ensure_ascii=False, indent=2), encoding="utf-8")
    emit({"ok": True, "draft": draft, "path": str(path)})


def cmd_list_drafts(_: argparse.Namespace) -> None:
    ensure_dirs()
    drafts = []
    for path in sorted(DRAFT_DIR.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True):
        try:
            draft = json.loads(path.read_text(encoding="utf-8"))
            drafts.append(
                {
                    "id": draft.get("id"),
                    "title": draft.get("title"),
                    "status": draft.get("status"),
                    "description": draft.get("description"),
                    "topics": draft.get("topics") if isinstance(draft.get("topics"), list) else [],
                    "video_path": draft.get("video_path"),
                    "cover_path": draft.get("cover_path"),
                    "scheduled_at": draft.get("scheduled_at"),
                    "ai_generated": bool(draft.get("ai_generated", False)),
                    "account_label": draft.get("account_label"),
                    "source": draft.get("source") if isinstance(draft.get("source"), dict) else {},
                    "updated_at": draft.get("updated_at"),
                }
            )
        except Exception:
            continue
    emit({"ok": True, "drafts": drafts})


def cmd_get_draft(args: argparse.Namespace) -> None:
    emit({"ok": True, "draft": load_draft(args.draft_id)})


def update_draft_status(draft: dict[str, Any], status: str, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    next_draft = {**draft, "status": status, "updated_at": now_iso()}
    if extra:
        next_draft.update(extra)
    draft_path(str(next_draft["id"])).write_text(
        json.dumps(next_draft, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return next_draft


def cmd_prepare_upload(args: argparse.Namespace) -> None:
    draft = load_draft(args.draft_id)
    command = build_upload_command(draft)
    payload: dict[str, Any] = {
        "ok": True,
        "platform": "douyin",
        "action": "prepare_upload",
        "execute": bool(args.execute),
        "draft": draft,
        "command": command,
        "publisher_cli_available": command_exists(command),
        "message": "Dry run only. Execute after owner approval." if not args.execute else "Executing uploader command.",
    }
    if args.execute:
        result = run_command(command, timeout=args.timeout)
        payload["result"] = result
        payload["ok"] = bool(result.get("ok"))
        payload["draft"] = update_draft_status(
            draft,
            "upload_prepared" if payload["ok"] else "upload_failed",
            {"last_result": result},
        )
    emit(payload, 0 if payload["ok"] else 1)


def cmd_publish(args: argparse.Namespace) -> None:
    draft = load_draft(args.draft_id)
    command = build_publish_command(draft)
    payload: dict[str, Any] = {
        "ok": True,
        "platform": "douyin",
        "action": "publish",
        "execute": bool(args.execute),
        "draft": draft,
        "command": command,
        "publisher_cli_available": command_exists(command),
        "message": "Dry run only. Publishing requires owner approval and --execute." if not args.execute else "Executing publish command.",
    }
    if args.execute:
        result = run_command(command, timeout=args.timeout)
        payload["result"] = result
        payload["ok"] = bool(result.get("ok"))
        payload["draft"] = update_draft_status(
            draft,
            "published" if payload["ok"] else "publish_failed",
            {"last_result": result},
        )
    emit(payload, 0 if payload["ok"] else 1)


def main() -> None:
    parser = argparse.ArgumentParser(description="Douyin publisher adapter")
    sub = parser.add_subparsers(dest="command", required=True)

    health = sub.add_parser("health")
    health.set_defaults(func=cmd_health)

    login = sub.add_parser("login")
    login.add_argument("--execute", action="store_true")
    login.add_argument("--timeout", type=int, default=900)
    login.set_defaults(func=cmd_login)

    check = sub.add_parser("check")
    check.add_argument("--execute", action="store_true")
    check.add_argument("--timeout", type=int, default=120)
    check.set_defaults(func=cmd_check)

    create = sub.add_parser("create-draft")
    create.add_argument("--payload")
    create.set_defaults(func=cmd_create_draft)

    list_drafts = sub.add_parser("list-drafts")
    list_drafts.set_defaults(func=cmd_list_drafts)

    get = sub.add_parser("get-draft")
    get.add_argument("--draft-id", required=True)
    get.set_defaults(func=cmd_get_draft)

    prepare = sub.add_parser("prepare-upload")
    prepare.add_argument("--draft-id", required=True)
    prepare.add_argument("--execute", action="store_true")
    prepare.add_argument("--timeout", type=int, default=900)
    prepare.set_defaults(func=cmd_prepare_upload)

    publish = sub.add_parser("publish")
    publish.add_argument("--draft-id", required=True)
    publish.add_argument("--execute", action="store_true")
    publish.add_argument("--timeout", type=int, default=900)
    publish.set_defaults(func=cmd_publish)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
