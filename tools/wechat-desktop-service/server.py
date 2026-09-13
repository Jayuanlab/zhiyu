from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import subprocess
import threading
import time
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Protocol
from send_ledger import SendLedger, SendConflict, SendUnknown
from dispatch_lock import DispatchBusy


LOGGER = logging.getLogger("wechat-desktop-service")
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
DEFAULT_CONFIRM_TTL_SECONDS = 300
MAX_BODY_BYTES = 64 * 1024
DEFAULT_SEND_RATE_LIMIT_PER_MINUTE = 6


class ServiceError(Exception):
    def __init__(self, status: HTTPStatus, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass
class PendingMessage:
    recipient_name: str
    message: str
    created_at: float
    expires_at: float


class ConfirmationStore:
    def __init__(self, ttl_seconds: int):
        self.ttl_seconds = ttl_seconds
        self._lock = threading.Lock()
        self._items: dict[str, PendingMessage] = {}

    def create(self, recipient_name: str, message: str) -> str:
        now = time.time()
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._purge_locked(now)
            self._items[token] = PendingMessage(
                recipient_name=recipient_name,
                message=message,
                created_at=now,
                expires_at=now + self.ttl_seconds,
            )
        return token

    def consume(self, token: str, recipient_name: str, message: str) -> PendingMessage:
        now = time.time()
        with self._lock:
            self._purge_locked(now)
            pending = self._items.pop(token, None)
        if pending is None:
            raise ServiceError(
                HTTPStatus.BAD_REQUEST,
                "Invalid or expired confirmToken. Call /preview first.",
            )
        if pending.recipient_name != recipient_name or pending.message != message:
            raise ServiceError(
                HTTPStatus.BAD_REQUEST,
                "confirmToken does not match recipientName and message.",
            )
        return pending

    def _purge_locked(self, now: float) -> None:
        expired = [token for token, item in self._items.items() if item.expires_at <= now]
        for token in expired:
            self._items.pop(token, None)


class SendRateLimiter:
    def __init__(self, max_sends_per_minute: int):
        self.max_sends_per_minute = max(0, max_sends_per_minute)
        self._lock = threading.Lock()
        self._timestamps: list[float] = []

    def check(self) -> None:
        if self.max_sends_per_minute <= 0:
            return
        now = time.time()
        window_started_at = now - 60
        with self._lock:
            self._timestamps = [
                timestamp for timestamp in self._timestamps if timestamp > window_started_at
            ]
            if len(self._timestamps) >= self.max_sends_per_minute:
                raise ServiceError(
                    HTTPStatus.TOO_MANY_REQUESTS,
                    f"Send rate limit exceeded. Max {self.max_sends_per_minute} sends per minute.",
                )
            self._timestamps.append(now)


class WeChatClient(Protocol):
    backend_name: str

    def health(self) -> dict[str, Any]:
        ...

    def send_message(self, recipient_name: str, message: str) -> dict[str, Any]:
        ...


class WindowAutomationWeChatClient:
    backend_name = "window"

    def __init__(self, minimize_after_send: bool = False):
        self._lock = threading.Lock()
        self._minimize_after_send = minimize_after_send

    def health(self) -> dict[str, Any]:
        try:
            self._import_windows_modules()
            hwnd = self._find_wechat_window()
            return {
                "backend": self.backend_name,
                "windowAutomationAvailable": True,
                "wechatWindowFound": hwnd is not None,
                "minimizeAfterSend": self._minimize_after_send,
                "visibleWindowAutomation": True,
            }
        except Exception as error:
            return {
                "backend": self.backend_name,
                "windowAutomationAvailable": False,
                "visibleWindowAutomation": True,
                "error": str(error),
            }

    def send_message(self, recipient_name: str, message: str) -> dict[str, Any]:
        with self._lock:
            try:
                self._send_via_window(recipient_name, message)
                backend = self.backend_name
            except ServiceError as error:
                if "Unable to activate WeChat window" not in error.message:
                    raise
                LOGGER.warning(
                    "Window backend could not activate WeChat; falling back to PowerShell SendKeys"
                )
                self._send_via_powershell(recipient_name, message)
                backend = "window-powershell"
        return {
            "sent": True,
            "backend": backend,
            "visibleWindowAutomation": True,
        }

    def _import_windows_modules(self) -> dict[str, Any]:
        try:
            import pythoncom  # type: ignore
            import win32clipboard  # type: ignore
            import win32con  # type: ignore
            import win32gui  # type: ignore
            import win32api  # type: ignore
            import win32process  # type: ignore
        except Exception as error:
            raise ServiceError(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "pywin32 is required for the window backend. Run: pip install pywin32",
            ) from error
        return {
            "pythoncom": pythoncom,
            "win32api": win32api,
            "win32clipboard": win32clipboard,
            "win32con": win32con,
            "win32gui": win32gui,
            "win32process": win32process,
        }

    def _find_wechat_window(self) -> int | None:
        modules = self._import_windows_modules()
        win32gui = modules["win32gui"]
        win32process = modules["win32process"]

        matches: list[tuple[int, str]] = []
        title_keywords = ("\u5fae\u4fe1", "WeChat")

        def enum_callback(hwnd: int, _: Any) -> None:
            if not win32gui.IsWindowVisible(hwnd):
                return
            title = win32gui.GetWindowText(hwnd).strip()
            if any(keyword in title for keyword in title_keywords):
                matches.append((hwnd, title))
                return
            try:
                _, pid = win32process.GetWindowThreadProcessId(hwnd)
                executable = self._get_process_name(pid)
            except Exception:
                executable = ""
            if executable.lower() in {"weixin.exe", "wechat.exe"} and title:
                matches.append((hwnd, title))

        win32gui.EnumWindows(enum_callback, None)
        if not matches:
            return None
        matches.sort(key=lambda item: 0 if item[1] in title_keywords else 1)
        return matches[0][0]

    def _get_process_name(self, pid: int) -> str:
        try:
            import psutil  # type: ignore

            return psutil.Process(pid).name()
        except Exception:
            return ""

    def _send_via_window(self, recipient_name: str, message: str) -> None:
        modules = self._import_windows_modules()
        pythoncom = modules["pythoncom"]
        win32api = modules["win32api"]
        win32clipboard = modules["win32clipboard"]
        win32con = modules["win32con"]
        win32gui = modules["win32gui"]
        win32process = modules["win32process"]

        hwnd = self._find_wechat_window()
        if hwnd is None:
            raise ServiceError(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "WeChat desktop window was not found. Open and log in to PC WeChat first.",
            )

        previous_foreground = win32gui.GetForegroundWindow()
        was_minimized = bool(win32gui.IsIconic(hwnd))
        original_clipboard = self._get_clipboard_text(win32clipboard, win32con)
        def require_focus() -> None:
            if win32gui.GetForegroundWindow() != hwnd:
                raise ServiceError(
                    HTTPStatus.CONFLICT,
                    "WeChat lost foreground focus. Stopped without further keyboard input. Do not retry automatically.",
                )

        def hotkey(key: str) -> None:
            require_focus()
            self._send_hotkey(win32api, win32con, key)

        def enter() -> None:
            require_focus()
            self._send_key(win32api, win32con.VK_RETURN)

        pythoncom.CoInitialize()
        try:
            self._activate_window(win32api, win32gui, win32con, win32process, hwnd)
            time.sleep(0.25)

            require_focus()
            self._paste_text(win32clipboard, win32con, recipient_name)
            hotkey("F")
            time.sleep(0.15)
            hotkey("A")
            time.sleep(0.05)
            hotkey("V")
            time.sleep(0.35)
            enter()
            time.sleep(0.35)

            require_focus()
            self._paste_text(win32clipboard, win32con, message)
            hotkey("A")
            time.sleep(0.05)
            hotkey("V")
            time.sleep(0.15)
            enter()
            time.sleep(0.25)
            LOGGER.info("WeChat message sent via window backend, length=%s", len(message))
        except ServiceError:
            raise
        except Exception as error:
            raise ServiceError(
                HTTPStatus.BAD_REQUEST,
                f"Failed to send WeChat message via window automation: {error}",
            ) from error
        finally:
            self._set_clipboard_text(win32clipboard, win32con, original_clipboard)
            self._restore_window_state(win32gui, win32con, hwnd, previous_foreground, was_minimized)
            pythoncom.CoUninitialize()

    def _restore_window_state(self, win32gui, win32con, hwnd, previous_foreground, was_minimized) -> None:
        if was_minimized or self._minimize_after_send:
            try:
                win32gui.ShowWindow(hwnd, win32con.SW_MINIMIZE)
            except Exception:
                LOGGER.warning("Unable to minimize WeChat window", exc_info=True)
        if previous_foreground and previous_foreground != hwnd and win32gui.IsWindow(previous_foreground):
            try:
                win32gui.SetForegroundWindow(previous_foreground)
            except Exception:
                LOGGER.warning("Unable to restore previous foreground window", exc_info=True)

    def _activate_window(
        self,
        win32api: Any,
        win32gui: Any,
        win32con: Any,
        win32process: Any,
        hwnd: int,
    ) -> None:
        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        try:
            win32gui.BringWindowToTop(hwnd)
        except Exception:
            LOGGER.debug("BringWindowToTop failed", exc_info=True)

        try:
            win32gui.SetForegroundWindow(hwnd)
            activated = win32gui.GetForegroundWindow() == hwnd
        except Exception:
            LOGGER.debug("SetForegroundWindow failed", exc_info=True)
            activated = False

        if not activated:
            foreground_hwnd = win32gui.GetForegroundWindow()
            current_thread_id = win32api.GetCurrentThreadId()
            target_thread_id, _ = win32process.GetWindowThreadProcessId(hwnd)
            foreground_thread_id, _ = win32process.GetWindowThreadProcessId(foreground_hwnd)
            attached_threads: list[int] = []
            try:
                for thread_id in {target_thread_id, foreground_thread_id}:
                    if thread_id and thread_id != current_thread_id:
                        win32process.AttachThreadInput(current_thread_id, thread_id, True)
                        attached_threads.append(thread_id)
                win32gui.SetForegroundWindow(hwnd)
                win32gui.SetFocus(hwnd)
                activated = win32gui.GetForegroundWindow() == hwnd
            except Exception:
                LOGGER.debug("AttachThreadInput activation failed", exc_info=True)
            finally:
                for thread_id in attached_threads:
                    try:
                        win32process.AttachThreadInput(current_thread_id, thread_id, False)
                    except Exception:
                        LOGGER.debug("AttachThreadInput detach failed", exc_info=True)

        if not activated:
            raise ServiceError(
                HTTPStatus.BAD_REQUEST,
                "Unable to activate WeChat window. Click the WeChat window once, then try again.",
            )

    def _send_hotkey(self, win32api: Any, win32con: Any, key: str) -> None:
        vk_code = ord(key.upper())
        win32api.keybd_event(win32con.VK_CONTROL, 0, 0, 0)
        time.sleep(0.02)
        self._send_key(win32api, vk_code)
        time.sleep(0.02)
        win32api.keybd_event(win32con.VK_CONTROL, 0, win32con.KEYEVENTF_KEYUP, 0)

    def _send_key(self, win32api: Any, vk_code: int) -> None:
        win32api.keybd_event(vk_code, 0, 0, 0)
        time.sleep(0.02)
        win32api.keybd_event(vk_code, 0, 2, 0)

    def _send_via_powershell(self, recipient_name: str, message: str) -> None:
        modules = self._import_windows_modules()
        win32gui, win32con = modules["win32gui"], modules["win32con"]
        hwnd = self._find_wechat_window()
        if hwnd is None:
            raise ServiceError(HTTPStatus.SERVICE_UNAVAILABLE, "WeChat desktop window was not found.")
        previous_foreground = win32gui.GetForegroundWindow()
        was_minimized = bool(win32gui.IsIconic(hwnd))
        recipient_b64 = base64.b64encode(recipient_name.encode("utf-8")).decode("ascii")
        message_b64 = base64.b64encode(message.encode("utf-8")).decode("ascii")
        script = f"""
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName Microsoft.VisualBasic
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WeChatFocus {{
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
}}
'@
$recipient = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("{recipient_b64}"))
$message = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("{message_b64}"))
$wechat = Get-Process | Where-Object {{ ($_.ProcessName -eq "Weixin" -or $_.ProcessName -eq "WeChat") -and $_.MainWindowHandle -ne 0 }} | Select-Object -First 1
if (-not $wechat) {{ throw "WeChat window not found" }}
$targetWindow = $wechat.MainWindowHandle
function Send-WeChatKeys([string]$keys) {{
  if ([WeChatFocus]::GetForegroundWindow() -ne $targetWindow) {{
    throw "WeChat is not foreground. Stopped without further keyboard input. Do not retry automatically."
  }}
  [System.Windows.Forms.SendKeys]::SendWait($keys)
}}
$oldClipboard = $null
try {{ $oldClipboard = Get-Clipboard -Raw -ErrorAction Stop }} catch {{ $oldClipboard = $null }}
try {{
  [WeChatFocus]::ShowWindow($targetWindow, 9) | Out-Null
  [Microsoft.VisualBasic.Interaction]::AppActivate([int]$wechat.Id) | Out-Null
  Start-Sleep -Milliseconds 300
  Send-WeChatKeys "^f"
  Start-Sleep -Milliseconds 150
  Set-Clipboard -Value $recipient
  Send-WeChatKeys "^a"
  Start-Sleep -Milliseconds 50
  Send-WeChatKeys "^v"
  Start-Sleep -Milliseconds 500
  Send-WeChatKeys "{{ENTER}}"
  Start-Sleep -Milliseconds 600
  Set-Clipboard -Value $message
  Send-WeChatKeys "^a"
  Start-Sleep -Milliseconds 50
  Send-WeChatKeys "^v"
  Start-Sleep -Milliseconds 150
  Send-WeChatKeys "{{ENTER}}"
  Start-Sleep -Milliseconds 300
}} finally {{
  if ($null -ne $oldClipboard) {{ Set-Clipboard -Value $oldClipboard }}
}}
"""
        encoded_script = base64.b64encode(script.encode("utf-16le")).decode("ascii")
        try:
            result = subprocess.run(
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-STA",
                    "-EncodedCommand",
                    encoded_script,
                ],
                capture_output=True,
                text=True,
                timeout=30,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
        finally:
            self._restore_window_state(win32gui, win32con, hwnd, previous_foreground, was_minimized)
        if result.returncode != 0:
            error = (result.stderr or result.stdout or "").strip()
            raise ServiceError(
                HTTPStatus.BAD_REQUEST,
                f"PowerShell WeChat automation failed: {error or result.returncode}",
            )
        LOGGER.info("WeChat message sent via PowerShell fallback, length=%s", len(message))

    def _get_clipboard_text(self, win32clipboard: Any, win32con: Any) -> str:
        try:
            win32clipboard.OpenClipboard()
            if win32clipboard.IsClipboardFormatAvailable(win32con.CF_UNICODETEXT):
                return win32clipboard.GetClipboardData(win32con.CF_UNICODETEXT)
        except Exception:
            LOGGER.debug("Unable to read existing clipboard text", exc_info=True)
        finally:
            try:
                win32clipboard.CloseClipboard()
            except Exception:
                pass
        return ""

    def _set_clipboard_text(self, win32clipboard: Any, win32con: Any, text: str) -> None:
        try:
            win32clipboard.OpenClipboard()
            win32clipboard.EmptyClipboard()
            if text:
                win32clipboard.SetClipboardData(win32con.CF_UNICODETEXT, text)
        finally:
            try:
                win32clipboard.CloseClipboard()
            except Exception:
                pass

    def _paste_text(self, win32clipboard: Any, win32con: Any, text: str) -> None:
        self._set_clipboard_text(win32clipboard, win32con, text)


class WxAutoWeChatClient:
    backend_name = "wxauto"

    def __init__(self):
        self._lock = threading.Lock()
        self._wx: Any | None = None

    def health(self) -> dict[str, Any]:
        try:
            self._import_wechat()
            return {"backend": self.backend_name, "wxautoAvailable": True}
        except Exception as error:
            return {"backend": self.backend_name, "wxautoAvailable": False, "error": str(error)}

    def send_message(self, recipient_name: str, message: str) -> dict[str, Any]:
        with self._lock:
            wx = self._get_wechat()
            self._open_chat(wx, recipient_name)
            self._send_text(wx, message)
        return {"sent": True, "backend": self.backend_name}

    def _import_wechat(self):
        try:
            from wxautox import WeChat  # type: ignore
        except Exception as error:
            try:
                from wxauto import WeChat  # type: ignore
            except Exception as fallback_error:
                raise ServiceError(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    "wxautox is not installed or cannot be imported. Run: pip install wxautox",
                ) from fallback_error
        return WeChat

    def _get_wechat(self):
        if self._wx is None:
            WeChat = self._import_wechat()
            self._wx = WeChat()
        return self._wx

    def _open_chat(self, wx: Any, recipient_name: str) -> None:
        last_error: Exception | None = None
        for method_name in ("ChatWith", "Search"):
            method = getattr(wx, method_name, None)
            if not callable(method):
                continue
            try:
                result = method(recipient_name)
                LOGGER.info("Opened WeChat chat via %s: %s", method_name, recipient_name)
                if result is False:
                    raise RuntimeError(f"{method_name} returned False")
                time.sleep(0.5)
                return
            except Exception as error:
                last_error = error
                LOGGER.warning("Failed to open chat via %s: %s", method_name, error)
        raise ServiceError(
            HTTPStatus.BAD_REQUEST,
            f"Unable to open WeChat chat for recipient: {recipient_name}. "
            f"Make sure PC WeChat is logged in and the contact name is searchable.",
        ) from last_error

    def _send_text(self, wx: Any, message: str) -> None:
        method = getattr(wx, "SendMsg", None)
        if not callable(method):
            raise ServiceError(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "WeChat automation object does not expose SendMsg.",
            )
        try:
            result = method(message)
            if result is False:
                raise RuntimeError("SendMsg returned False")
            LOGGER.info("WeChat message sent, length=%s", len(message))
        except Exception as error:
            raise ServiceError(
                HTTPStatus.BAD_REQUEST,
                f"Failed to send WeChat message: {error}",
            ) from error


def create_wechat_client(backend: str, minimize_after_send: bool) -> WeChatClient:
    if backend == "window":
        return WindowAutomationWeChatClient(minimize_after_send=minimize_after_send)
    if backend == "wxauto":
        return WxAutoWeChatClient()
    raise ValueError(f"Unsupported backend: {backend}")


class WeChatDesktopService:
    def __init__(
        self,
        auth_token: str | None,
        confirm_ttl_seconds: int,
        backend: str,
        minimize_after_send: bool,
        allowed_recipients: set[str],
        send_rate_limit_per_minute: int,
        send_ledger_path: str | None = None,
    ):
        self.auth_token = auth_token
        self.allowed_recipients = allowed_recipients
        self.rate_limiter = SendRateLimiter(send_rate_limit_per_minute)
        self.confirmations = ConfirmationStore(confirm_ttl_seconds)
        self.wechat = create_wechat_client(backend, minimize_after_send)
        self.started_at = time.time()
        self.send_ledger = SendLedger(send_ledger_path or os.environ.get("WECHAT_DESKTOP_SEND_LEDGER_PATH") or Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Zhiyu" / "wechat-desktop" / "send-ledger.sqlite")

    def require_auth(self, headers: Any) -> None:
        if not self.auth_token:
            raise ServiceError(HTTPStatus.SERVICE_UNAVAILABLE, "Internal credential is not configured.")
        provided = headers.get("Authorization", "")
        prefix = "Bearer "
        if not provided.startswith(prefix):
            raise ServiceError(HTTPStatus.UNAUTHORIZED, "Missing bearer token.")
        token = provided[len(prefix) :].strip()
        if not hmac.compare_digest(token, self.auth_token):
            raise ServiceError(HTTPStatus.UNAUTHORIZED, "Invalid bearer token.")

    def require_allowed_recipient(self, recipient_name: str) -> None:
        if not self.allowed_recipients:
            return
        if recipient_name not in self.allowed_recipients:
            raise ServiceError(
                HTTPStatus.FORBIDDEN,
                "Recipient is not allowed by WECHAT_DESKTOP_ALLOWED_RECIPIENTS.",
            )

    def require_send_allowed(self, recipient_name: str) -> None:
        self.rate_limiter.check()


def compact_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def require_string(payload: dict[str, Any], key: str, max_length: int) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ServiceError(HTTPStatus.BAD_REQUEST, f"{key} is required.")
    value = value.strip()
    if len(value) > max_length:
        raise ServiceError(
            HTTPStatus.BAD_REQUEST,
            f"{key} is too long. Max length is {max_length}.",
        )
    return value


def make_handler(service: WeChatDesktopService):
    class Handler(BaseHTTPRequestHandler):
        server_version = "OpenZhiyuWechatDesktop/0.1"

        def do_GET(self) -> None:
            try:
                if self.path != "/health":
                    raise ServiceError(HTTPStatus.NOT_FOUND, "Not found.")
                payload = {
                    "ok": True,
                    "uptimeSeconds": int(time.time() - service.started_at),
                    "requiresAuth": bool(service.auth_token),
                    "recipientAllowlistEnabled": bool(service.allowed_recipients),
                    "sendRateLimitPerMinute": service.rate_limiter.max_sends_per_minute,
                    **service.wechat.health(),
                }
                self._write_json(HTTPStatus.OK, payload)
            except ServiceError as error:
                self._write_json(error.status, {"ok": False, "error": error.message})

        def do_POST(self) -> None:
            try:
                service.require_auth(self.headers)
                if self.path == "/preview":
                    self._handle_preview()
                elif self.path == "/send":
                    self._handle_send()
                elif self.path == "/send-status":
                    payload = self._read_json()
                    command_id = require_string(payload, "commandId", 256)
                    self._write_json(HTTPStatus.OK, {"ok": True, **service.send_ledger.status(command_id)})
                elif self.path == "/resolve-send":
                    self._handle_resolve_send()
                else:
                    raise ServiceError(HTTPStatus.NOT_FOUND, "Not found.")
            except ServiceError as error:
                self._write_json(error.status, {"ok": False, "error": error.message})
            except Exception as error:
                LOGGER.exception("Unhandled request error")
                self._write_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"ok": False, "error": str(error)},
                )

        def _handle_preview(self) -> None:
            payload = self._read_json()
            recipient_name = require_string(payload, "recipientName", 200)
            message = require_string(payload, "message", 5000)
            service.require_allowed_recipient(recipient_name)
            confirm_token = service.confirmations.create(recipient_name, message)
            LOGGER.info(
                "Created preview recipient=%s messageHash=%s",
                recipient_name,
                compact_hash(message),
            )
            self._write_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "requiresConfirmation": True,
                    "confirmToken": confirm_token,
                    "expiresInSeconds": service.confirmations.ttl_seconds,
                    "preview": {
                        "recipientName": recipient_name,
                        "message": message,
                        "messageHash": compact_hash(message),
                    },
                },
            )

        def _handle_resolve_send(self) -> None:
            payload = self._read_json()
            command_id = require_string(payload, "commandId", 256)
            recipient = require_string(payload, "recipientName", 200)
            message = require_string(payload, "message", 5000)
            resolution_id = require_string(payload, "resolutionId", 256)
            actor_id = require_string(payload, "actorId", 256)
            evidence = require_string(payload, "evidence", 4000)
            decision = require_string(payload, "decision", 20)
            if decision not in ("sent", "not_sent") or len(evidence) < 8:
                raise ServiceError(HTTPStatus.BAD_REQUEST, "A valid decision and evidence are required.")
            try:
                result = service.send_ledger.resolve(command_id, recipient, message, resolution_id, decision, actor_id, evidence)
            except (SendConflict, DispatchBusy) as error:
                raise ServiceError(HTTPStatus.CONFLICT, str(error)) from error
            self._write_json(HTTPStatus.OK, {"ok": True, **result})

        def _handle_send(self) -> None:
            payload = self._read_json()
            recipient_name = require_string(payload, "recipientName", 200)
            message = require_string(payload, "message", 5000)
            confirm_token = require_string(payload, "confirmToken", 500)
            command_id = require_string(payload, "commandId", 256) if "commandId" in payload else "token:" + hashlib.sha256(confirm_token.encode("utf-8")).hexdigest()
            LOGGER.info(
                "Send requested recipient=%s messageHash=%s",
                recipient_name,
                compact_hash(message),
            )
            service.require_allowed_recipient(recipient_name)
            def authorize():
                service.require_send_allowed(recipient_name)
                service.confirmations.consume(confirm_token, recipient_name, message)
            try:
                send_result = service.send_ledger.execute(command_id, recipient_name, message, authorize, lambda: service.wechat.send_message(recipient_name, message))
            except (SendConflict, SendUnknown, DispatchBusy) as error:
                raise ServiceError(HTTPStatus.CONFLICT, str(error)) from error
            LOGGER.info(
                "Send completed recipient=%s messageHash=%s",
                recipient_name,
                compact_hash(message),
            )
            self._write_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    **send_result,
                    "recipientName": recipient_name,
                    "messageHash": compact_hash(message),
                },
            )

        def _read_json(self) -> dict[str, Any]:
            content_length = self.headers.get("Content-Length")
            if not content_length:
                raise ServiceError(HTTPStatus.BAD_REQUEST, "Missing request body.")
            try:
                length = int(content_length)
            except ValueError as error:
                raise ServiceError(HTTPStatus.BAD_REQUEST, "Invalid Content-Length.") from error
            if length > MAX_BODY_BYTES:
                raise ServiceError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Request body is too large.")
            raw = self.rfile.read(length)
            try:
                payload = json.loads(raw.decode("utf-8"))
            except Exception as error:
                raise ServiceError(HTTPStatus.BAD_REQUEST, "Invalid JSON body.") from error
            if not isinstance(payload, dict):
                raise ServiceError(HTTPStatus.BAD_REQUEST, "JSON body must be an object.")
            return payload

        def _write_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
            raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status.value)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, fmt: str, *args: Any) -> None:
            LOGGER.info("%s - %s", self.address_string(), fmt % args)

    return Handler


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Local Windows WeChat desktop automation service for OpenZhiyu.",
    )
    parser.add_argument("--host", default=os.getenv("WECHAT_DESKTOP_HOST", DEFAULT_HOST))
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.getenv("WECHAT_DESKTOP_PORT", str(DEFAULT_PORT))),
    )
    parser.add_argument(
        "--token",
        default=os.getenv("WECHAT_DESKTOP_TOKEN"),
        help="Required internal bearer token for write operations.",
    )
    parser.add_argument(
        "--confirm-ttl",
        type=int,
        default=int(
            os.getenv("WECHAT_DESKTOP_CONFIRM_TTL", str(DEFAULT_CONFIRM_TTL_SECONDS)),
        ),
    )
    parser.add_argument("--debug", action="store_true")
    parser.add_argument(
        "--backend",
        choices=("window", "wxauto"),
        default=os.getenv("WECHAT_DESKTOP_BACKEND", "window"),
        help="Automation backend. 'window' uses pywin32 UI automation and does not require wxautox.",
    )
    parser.add_argument(
        "--minimize-after-send",
        action="store_true",
        default=os.getenv("WECHAT_DESKTOP_MINIMIZE_AFTER_SEND", "").lower()
        in {"1", "true", "yes"},
        help="Minimize WeChat after each send. By default the service restores the previous window only.",
    )
    parser.add_argument(
        "--allowed-recipient",
        action="append",
        default=[],
        help="Allowed recipient display name. May be repeated. Defaults to WECHAT_DESKTOP_ALLOWED_RECIPIENTS.",
    )
    parser.add_argument(
        "--send-rate-limit",
        type=int,
        default=int(
            os.getenv(
                "WECHAT_DESKTOP_SEND_RATE_LIMIT_PER_MINUTE",
                str(DEFAULT_SEND_RATE_LIMIT_PER_MINUTE),
            ),
        ),
        help="Maximum sends per minute. Set 0 to disable.",
    )
    return parser.parse_args()


def parse_allowed_recipients(args: argparse.Namespace) -> set[str]:
    recipients = set()
    raw_env = os.getenv("WECHAT_DESKTOP_ALLOWED_RECIPIENTS", "")
    for item in raw_env.split(","):
        item = item.strip()
        if item:
            recipients.add(item)
    for item in args.allowed_recipient:
        item = item.strip()
        if item:
            recipients.add(item)
    return recipients


def main() -> None:
    args = parse_args()
    log_path = Path(__file__).with_name("wechat-desktop-service.log")
    log_level = logging.DEBUG if args.debug else logging.INFO
    log_format = "%(asctime)s %(levelname)s %(name)s: %(message)s"
    logging.basicConfig(
        level=log_level,
        format=log_format,
        handlers=[
            logging.StreamHandler(),
            logging.FileHandler(log_path, encoding="utf-8"),
        ],
    )

    if args.host not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit("Refusing to bind beyond localhost.")

    allowed_recipients = parse_allowed_recipients(args)
    service = WeChatDesktopService(
        auth_token=args.token,
        confirm_ttl_seconds=args.confirm_ttl,
        backend=args.backend,
        minimize_after_send=args.minimize_after_send,
        allowed_recipients=allowed_recipients,
        send_rate_limit_per_minute=args.send_rate_limit,
    )
    server = ThreadingHTTPServer((args.host, args.port), make_handler(service))
    LOGGER.info("Listening on http://%s:%s", args.host, args.port)
    LOGGER.info("Using backend: %s", args.backend)
    LOGGER.info("Recipient allowlist enabled: %s", bool(allowed_recipients))
    LOGGER.info("Send rate limit per minute: %s", args.send_rate_limit)
    LOGGER.info("Writing logs to %s", log_path)
    LOGGER.info("Preview endpoint: POST /preview")
    LOGGER.info("Send endpoint: POST /send")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        LOGGER.info("Shutting down")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
