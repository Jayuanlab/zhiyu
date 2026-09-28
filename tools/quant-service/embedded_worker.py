"""Run quant routes inside the Web host, without a listening socket.

Each input/output line is one JSON envelope. Business logs go to stderr so
the protocol stream cannot be confused with provider diagnostics.
"""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import sys
from threading import Lock

import httpx

protocol = sys.stdout
sys.stdout = sys.stderr
output_lock = Lock()

from app.main import app  # noqa: E402


def handle(envelope: dict) -> None:
    request_id = envelope.get("id")
    try:
        async def invoke():
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://quant.local") as client:
                return await client.request(
                    envelope["method"], envelope["path"],
                    headers=envelope.get("headers", {}),
                    content=envelope.get("body", "").encode("utf-8"),
                    timeout=None,
                )

        response = asyncio.run(invoke())
        result = {"id": request_id, "status": response.status_code, "body": response.text}
    except Exception as error:
        print(f"embedded quant request failed: {type(error).__name__}: {error}", file=sys.stderr)
        result = {"id": request_id, "error": "quant_execution_failed"}
    with output_lock:
        protocol.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
        protocol.flush()


def main() -> None:
    with ThreadPoolExecutor(max_workers=4, thread_name_prefix="quant-embedded") as pool:
        for line in sys.stdin:
            try:
                envelope = json.loads(line)
                if not isinstance(envelope, dict) or not isinstance(envelope.get("id"), int):
                    raise ValueError("invalid envelope")
                pool.submit(handle, envelope)
            except Exception as error:
                print(f"embedded quant protocol error: {error}", file=sys.stderr)


if __name__ == "__main__":
    main()
