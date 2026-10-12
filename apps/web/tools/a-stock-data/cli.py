from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from a_stock_data import AStockDataError, run


def _force_utf8_stdio() -> None:
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if not callable(reconfigure):
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def main() -> int:
    _force_utf8_stdio()
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw or "{}")
        result = run(payload)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except AStockDataError as error:
        print(
            json.dumps(
                {"ok": False, "error": str(error), "errorType": "AStockDataError"},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            file=sys.stderr,
        )
        return 2
    except Exception as error:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": str(error),
                    "errorType": error.__class__.__name__,
                    "trace": traceback.format_exc(limit=3),
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
