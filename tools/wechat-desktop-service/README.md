# WeChat Desktop Service

Local Windows companion service for OpenZhiyu. It controls the logged-in PC WeChat desktop client through local desktop automation and exposes a small HTTP API plus an optional MCP stdio wrapper.

This is a personal/local automation tool, not an official WeChat SDK. Read [DISCLAIMER.md](./DISCLAIMER.md) and [SECURITY.md](./SECURITY.md) before publishing or using it on a shared machine.

## Scope

Supported:

- Check whether the local automation service is healthy.
- Preview a message and create a short-lived confirmation token.
- Send a confirmed text message through PC WeChat.
- Expose those actions as MCP tools for local AI clients.

Not supported:

- Fully invisible Windows Service / Session 0 execution.
- A stable official background WeChat API.
- Public network deployment by default.
- Bulk messaging, marketing, scraping, or production messaging guarantees.

## Safety Model

- Binds to `127.0.0.1` by default.
- Binding outside localhost is refused.
- All endpoints, including `/health` and `/shutdown`, require `WECHAT_DESKTOP_TOKEN`.
- Sending starts disabled. The owner must enable reviewed sending before `/send` can dispatch.
- `/preview` creates a short-lived `confirmToken`; it does not send.
- `/send` requires the matching `confirmToken`.
- Default send rate limit is 6 sends per minute.
- Optional recipient allowlist can block unexpected recipients.
- The default `window` backend briefly focuses PC WeChat, sends the message, then restores the previous foreground window and clipboard.

Personal PC WeChat does not expose a reliable fully invisible background API. For a sanctioned background channel, use an official API such as WeCom or another authorized integration.

## Requirements

- Windows.
- Python 3.9+.
- PC WeChat installed and logged in.
- `pywin32`.
- Node.js 18+ only when using the MCP wrapper.

## Start

When developing Zhiyu from the repository root, the recommended command is:

```powershell
pnpm dev
```

That command starts this service automatically if `127.0.0.1:8765` is not already healthy.

To start this service by itself:

```powershell
cd D:\zhiyu\tools\wechat-desktop-service
.\start.ps1
```

With an auth token:

```powershell
$env:WECHAT_DESKTOP_TOKEN = "replace-with-a-long-random-token"
.\start.ps1
```

Restrict recipients:

```powershell
$env:WECHAT_DESKTOP_ALLOWED_RECIPIENTS = "filehelper,Example Contact"
.\start.ps1
```

Adjust send rate limiting:

```powershell
.\start.ps1 -SendRateLimit 3
```

Disable send rate limiting only for local development:

```powershell
.\start.ps1 -SendRateLimit 0
```

To minimize WeChat after each send:

```powershell
.\start.ps1 -MinimizeAfterSend
```

## HTTP API

Health:

```powershell
Invoke-WebRequest http://127.0.0.1:8765/health -UseBasicParsing
```

Supply `-Headers @{Authorization = "Bearer $env:WECHAT_DESKTOP_TOKEN"}` for every HTTP request above. Preview tokens authorize only the matching content; they do not replace the application's reviewed outbox approval.

## Windows distribution contract

The installer includes two separate components: a pinned, modified `wx-cli` reader and an isolated CPython/pywin32 sender. A successful install or module import does not establish compatibility with a user's WeChat version. Windows WeChat 4.x must be installed and logged in, and the owner must explicitly authorize message initialization in Zhiyu's settings. Initialization may require a user-approved UAC prompt to inspect the owner's WeChat process. No initialization or message queries run while the component is disabled.

The runtime starts the sender using its private Python:

```text
python.exe -I -B -X utf8 -u components/wechat/server.py --host 127.0.0.1 --port <private-port> --data-dir <private-data>/wechat/sender --managed-stdin
```

`WECHAT_DESKTOP_TOKEN` supplies the private bearer credential; `WECHAT_DESKTOP_SEND_ENABLED=true` is set only after the owner's separate reviewed-send permission. `--no-window-probe` supports installation verification: health imports actual bundled modules but does not enumerate or activate WeChat windows. Normal health checks inspect only window/process/version metadata and always report login and version compatibility as unverified. A found window is not proof of login or delivery.

The sender keeps `send-ledger.sqlite` and rotating logs under its private data directory. `/shutdown` refuses with HTTP 409 during a GUI dispatch; otherwise it closes the owned process naturally. Closing the parent's stdin pipe also rejects new dispatches, drains an active dispatch and stops naturally. The runtime must confirm that process exit before taking a cold backup. Unknown send results require owner reconciliation rather than automatic redispatch.

The reader helper accepts absolute paths only:

```text
bootstrap-reader.ps1 -ReaderBinary <install>/vendor/wechat-reader/wx.exe -DataDirectory <private-data>/wechat/reader -TokenFile <private-data>/private/wechat-reader-token -Action version|initialize|health|stop
```

`version` reads no personal data. `health` checks private metadata and authenticated daemon responsiveness without querying messages or starting a daemon. `stop` confirms graceful exit of the same private daemon. Only `initialize`, following explicit owner authorization, can inspect WeChat and write private config/key state. `-Elevate` is accepted only for that explicit action. Helper output is one safe JSON receipt; raw CLI initialization output stays in memory and is never copied into shared logs. Different private data directories use separate authenticated Windows named pipes. Original messages enter the existing raw observation layer; sending continues through the reviewed outbox.

Preview:

```powershell
$body = @{
  recipientName = "filehelper"
  message = "Zhiyu preview test"
} | ConvertTo-Json

Invoke-WebRequest `
  -Uri http://127.0.0.1:8765/preview `
  -Method POST `
  -ContentType "application/json" `
  -Body $body `
  -UseBasicParsing
```

Send:

```powershell
$body = @{
  recipientName = "filehelper"
  message = "Zhiyu preview test"
  confirmToken = "<token-from-preview>"
} | ConvertTo-Json

Invoke-WebRequest `
  -Uri http://127.0.0.1:8765/send `
  -Method POST `
  -ContentType "application/json" `
  -Body $body `
  -UseBasicParsing
```

If `WECHAT_DESKTOP_TOKEN` is set, include:

```powershell
-Headers @{ Authorization = "Bearer $env:WECHAT_DESKTOP_TOKEN" }
```

## MCP Wrapper

The MCP wrapper is a stdio server that calls the local HTTP service. It does not send messages directly and it preserves the preview/confirm flow.

Available tools:

- `wechat_desktop_health`
- `wechat_preview_message`
- `wechat_send_confirmed_message`

Example Zhiyu MCP config at `%USERPROFILE%\.openzhiyu\mcp.json`:

```json
{
  "mcpServers": {
    "wechat-desktop": {
      "command": "node",
      "args": ["D:\\zhiyu\\tools\\wechat-desktop-service\\mcp-server.mjs"],
      "env": {
        "WECHAT_DESKTOP_HOST": "127.0.0.1",
        "WECHAT_DESKTOP_PORT": "8765",
        "WECHAT_DESKTOP_TOKEN": "replace-with-your-token"
      }
    }
  }
}
```

Start the HTTP service before using the MCP wrapper:

```powershell
.\start.ps1
```

## Configuration

| Name | Default | Description |
| --- | --- | --- |
| `WECHAT_DESKTOP_HOST` | `127.0.0.1` | HTTP host. |
| `WECHAT_DESKTOP_PORT` | `8765` | HTTP port. |
| `WECHAT_DESKTOP_TOKEN` | empty | Optional bearer token; required outside localhost. |
| `WECHAT_DESKTOP_CONFIRM_TTL` | `300` | Confirmation token TTL in seconds. |
| `WECHAT_DESKTOP_BACKEND` | `window` | `window` or `wxauto`. |
| `WECHAT_DESKTOP_MINIMIZE_AFTER_SEND` | empty | Set `1`/`true`/`yes` to minimize after sending. |
| `WECHAT_DESKTOP_ALLOWED_RECIPIENTS` | empty | Comma-separated recipient allowlist. |
| `WECHAT_DESKTOP_SEND_RATE_LIMIT_PER_MINUTE` | `6` | Max sends per minute; `0` disables. |

## Open Source Checklist

Before publishing:

- Verify `.env`, logs, screenshots, tokens, contact names, group names, and QR codes are not committed.
- Keep the default host as `127.0.0.1`.
- Keep preview/confirm enabled for all write tools.
- Keep send rate limiting enabled by default.
- Include the disclaimer and security notes in releases.
- Avoid describing this project as an official or production WeChat API.
# Persistent send command recovery

GUI dispatches use an OS file lock next to the ledger. Processes controlling the same Windows session must share the same ledger path. A competing new command is rejected before authorization is consumed; an interrupted process releases the OS lock but its recorded command remains unknown. Windows behavior is covered by local process tests; the non-Windows lock branch is not part of the validated support matrix.

`POST /send` accepts an optional stable `commandId`. The service commits dispatch intent before GUI input and stores the successful response. Repeating a completed command returns its original response; changing its recipient or message returns HTTP 409. An interrupted or failed dispatch remains unknown and cannot be resent with that command.

`POST /send-status` accepts `{ "commandId": "..." }` with the same bearer authentication and returns `sent`, `unknown`, or `not_found`. A recorded start is reported as unknown because GUI input and SQLite cannot commit atomically.

Set `WECHAT_DESKTOP_SEND_LEDGER_PATH` to the persistent SQLite ledger location. The default is `%LOCALAPPDATA%/Zhiyu/wechat-desktop/send-ledger.sqlite` (home directory fallback). Keep this ledger across restarts; do not delete it to retry uncertain sends. Legacy callers without commandId use a hash of the confirmation token, which only deduplicates that token. Web-level content versions, approval and unknown-result resolution must supply a stable attempt ID before end-to-end recovery is enabled.
