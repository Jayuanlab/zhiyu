"""
Controlled A-share data adapter inspired by simonlin1212/a-stock-data.

This module intentionally exposes a small action surface for agents while
internally aggregating multiple public endpoints. It does not execute arbitrary
Python supplied by the model.
"""

from __future__ import annotations

import json
import re
import time
import uuid
import contextlib
import io
from datetime import datetime, timedelta
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
)
REPORT_API = "https://reportapi.eastmoney.com/report/list"
PDF_TPL = "https://pdf.dfcfw.com/pdf/H3_{info_code}_1.pdf"
EM_MIN_INTERVAL = 1.05
MAX_ROWS = 40
TRANSIENT_SOURCE_ERROR_CATEGORIES = {
    "proxy_or_network",
    "remote_closed_connection",
    "timeout",
    "rate_limited",
    "upstream_5xx",
}

_LAST_EM_REQUEST_AT = 0.0
_CNINFO_ORGID_MAP: dict[str, str] | None = None


class AStockDataError(Exception):
    pass


def now_iso() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def normalize_date(value: Any, default: datetime | None = None) -> str:
    raw = str(value or "").strip()
    if re.fullmatch(r"\d{8}", raw):
        return f"{raw[:4]}-{raw[4:6]}-{raw[6:8]}"
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        return raw
    return (default or datetime.now()).strftime("%Y-%m-%d")


def clamp_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except Exception:
        parsed = default
    return max(minimum, min(maximum, parsed))


def normalize_code(code: str) -> str:
    raw = str(code or "").strip().upper()
    raw = raw.replace(" ", "")
    suffix_match = re.fullmatch(r"(\d{6})\.(SH|SZ|BJ)", raw)
    if suffix_match:
        raw = suffix_match.group(1)
    else:
        raw = raw.removeprefix("SH").removeprefix("SZ").removeprefix("BJ")
    if not re.fullmatch(r"\d{6}", raw):
        raise AStockDataError(f"Invalid A-share code: {code!r}")
    return raw


def normalize_codes(codes: list[str], max_count: int = 20) -> list[str]:
    normalized = []
    for code in codes[:max_count]:
        item = normalize_code(code)
        if item not in normalized:
            normalized.append(item)
    if not normalized:
        raise AStockDataError("At least one stock code is required.")
    return normalized


def market_id(code: str) -> int:
    return 1 if code.startswith(("6", "9")) else 0


def tencent_prefix(code: str) -> str:
    if code.startswith(("6", "9")):
        return f"sh{code}"
    if code.startswith(("8", "4")):
        return f"bj{code}"
    return f"sz{code}"


def request_bytes(
    url: str,
    *,
    params: dict[str, Any] | None = None,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    data: bytes | None = None,
    timeout: int = 15,
) -> bytes:
    if params:
        url = f"{url}?{urlencode(params)}"
    req = Request(url, data=data, method=method)
    req.add_header("User-Agent", UA)
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            with urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504):
                body = error.read()[:240].decode("utf-8", errors="replace")
                raise AStockDataError(f"HTTP {error.code} from {url}: {body}") from error
            last_error = error
        except URLError as error:
            last_error = error
        except Exception as error:
            last_error = error
        time.sleep(0.5 + attempt * 0.8)
    raise AStockDataError(f"Request failed from {url}: {last_error}") from last_error


def request_json(
    url: str,
    *,
    params: dict[str, Any] | None = None,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    json_body: dict[str, Any] | None = None,
    form_body: dict[str, Any] | None = None,
    timeout: int = 15,
) -> dict[str, Any]:
    data = None
    merged_headers = dict(headers or {})
    if json_body is not None:
        data = json.dumps(json_body, ensure_ascii=False).encode("utf-8")
        merged_headers["Content-Type"] = "application/json"
    elif form_body is not None:
        data = urlencode(form_body).encode("utf-8")
        merged_headers["Content-Type"] = "application/x-www-form-urlencoded"
    raw = request_bytes(
        url,
        params=params,
        method=method,
        headers=merged_headers,
        data=data,
        timeout=timeout,
    )
    return json.loads(raw.decode("utf-8", errors="replace"))


def em_sleep() -> None:
    global _LAST_EM_REQUEST_AT
    elapsed = time.monotonic() - _LAST_EM_REQUEST_AT
    if elapsed < EM_MIN_INTERVAL:
        time.sleep(EM_MIN_INTERVAL - elapsed)
    _LAST_EM_REQUEST_AT = time.monotonic()


def em_json(
    url: str,
    *,
    params: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    method: str = "GET",
    json_body: dict[str, Any] | None = None,
    timeout: int = 15,
) -> dict[str, Any]:
    em_sleep()
    merged_headers = {
        "Accept": "application/json,text/javascript,*/*;q=0.01",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
        "Referer": "https://quote.eastmoney.com/",
        **(headers or {}),
    }
    return request_json(
        url,
        params=params,
        method=method,
        headers=merged_headers,
        json_body=json_body,
        timeout=timeout,
    )


def em_text(
    url: str,
    *,
    params: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: int = 15,
) -> str:
    em_sleep()
    merged_headers = {
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
        "Referer": "https://quote.eastmoney.com/",
        **(headers or {}),
    }
    raw = request_bytes(url, params=params, headers=merged_headers, timeout=timeout)
    return raw.decode("utf-8", errors="replace")


def eastmoney_datacenter(
    report_name: str,
    *,
    columns: str = "ALL",
    filter_str: str = "",
    page_size: int = 50,
    page_number: int = 1,
    sort_columns: str = "",
    sort_types: str = "-1",
) -> list[dict[str, Any]]:
    data = em_json(
        "https://datacenter-web.eastmoney.com/api/data/v1/get",
        params={
            "sortColumns": sort_columns,
            "sortTypes": sort_types,
            "pageSize": str(clamp_int(page_size, 20, 1, 500)),
            "pageNumber": str(clamp_int(page_number, 1, 1, 50)),
            "reportName": report_name,
            "columns": columns,
            "filter": filter_str,
            "source": "WEB",
            "client": "WEB",
        },
        headers={"Referer": "https://data.eastmoney.com/"},
        timeout=20,
    )
    result = data.get("result") or {}
    rows = result.get("data", []) or []
    if not isinstance(rows, list):
        return []
    return [row for row in rows if isinstance(row, dict)]


def tencent_quote(codes: list[str]) -> dict[str, Any]:
    codes = normalize_codes(codes, max_count=30)
    raw = request_bytes(
        "https://qt.gtimg.cn/q=" + ",".join(tencent_prefix(code) for code in codes),
        timeout=12,
    ).decode("gbk", errors="replace")
    result: dict[str, Any] = {}
    for line in raw.strip().split(";"):
        if not line.strip() or "=" not in line or '"' not in line:
            continue
        key = line.split("=")[0].split("_")[-1]
        vals = line.split('"')[1].split("~")
        if len(vals) < 53:
            continue
        code = key[2:]
        result[code] = {
            "code": code,
            "name": vals[1],
            "price": to_float(vals[3]),
            "lastClose": to_float(vals[4]),
            "open": to_float(vals[5]),
            "changeAmount": to_float(vals[31]),
            "changePct": to_float(vals[32]),
            "high": to_float(vals[33]),
            "low": to_float(vals[34]),
            "amountWan": to_float(vals[37]),
            "turnoverPct": to_float(vals[38]),
            "peTtm": to_float(vals[39]),
            "amplitudePct": to_float(vals[43]),
            "marketCapYi": to_float(vals[44]),
            "floatMarketCapYi": to_float(vals[45]),
            "pb": to_float(vals[46]),
            "limitUp": to_float(vals[47]),
            "limitDown": to_float(vals[48]),
            "volumeRatio": to_float(vals[49]),
            "peStatic": to_float(vals[52]),
        }
    return result


def eastmoney_daily_klines(code: str, days: int = 120) -> list[dict[str, Any]]:
    code = normalize_code(code)
    size = clamp_int(days, 120, 30, 250)
    data = em_json(
        "https://push2his.eastmoney.com/api/qt/stock/kline/get",
        params={
            "secid": f"{market_id(code)}.{code}",
            "fields1": "f1,f2,f3,f4,f5,f6",
            "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
            "klt": "101",
            "fqt": "1",
            "beg": "19900101",
            "end": "20500101",
            "lmt": str(size),
        },
        headers={"Referer": "https://quote.eastmoney.com/"},
        timeout=15,
    )
    klines = (((data.get("data") or {}).get("klines")) or [])
    rows: list[dict[str, Any]] = []
    for item in klines:
        parts = str(item or "").split(",")
        if len(parts) < 11:
            continue
        rows.append(
            {
                "date": parts[0],
                "open": to_float(parts[1]),
                "close": to_float(parts[2]),
                "high": to_float(parts[3]),
                "low": to_float(parts[4]),
                "volume": to_float(parts[5]),
                "amount": to_float(parts[6]),
                "amplitudePct": to_float(parts[7]),
                "changePct": to_float(parts[8]),
                "changeAmount": to_float(parts[9]),
                "turnoverPct": to_float(parts[10]),
            }
        )
    return [row for row in rows if row.get("close") is not None]


def tencent_daily_klines(code: str, days: int = 120) -> list[dict[str, Any]]:
    code = normalize_code(code)
    size = clamp_int(days, 120, 30, 250)
    symbol = tencent_prefix(code)
    data = request_json(
        "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get",
        params={"param": f"{symbol},day,,,{size},qfq"},
        headers={
            "Accept": "application/json,text/javascript,*/*;q=0.01",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
            "Referer": f"https://gu.qq.com/{symbol}/gp",
        },
        timeout=15,
    )
    block = ((data.get("data") or {}).get(symbol) or {})
    raw_rows = block.get("qfqday") or block.get("day") or []
    rows: list[dict[str, Any]] = []
    prev_close: float | None = None
    for item in raw_rows:
        if not isinstance(item, list) or len(item) < 6:
            continue
        open_price = to_float(item[1])
        close = to_float(item[2])
        high = to_float(item[3])
        low = to_float(item[4])
        volume = to_float(item[5])
        change_pct = pct_change(close, prev_close) if prev_close else None
        rows.append(
            {
                "date": item[0],
                "open": open_price,
                "close": close,
                "high": high,
                "low": low,
                "volume": volume,
                "amount": None,
                "amplitudePct": (
                    (high - low) / prev_close * 100
                    if high is not None and low is not None and prev_close
                    else None
                ),
                "changePct": change_pct,
                "changeAmount": close - prev_close if close is not None and prev_close is not None else None,
                "turnoverPct": None,
            }
        )
        if close is not None:
            prev_close = close
    return [row for row in rows if row.get("close") is not None]


def average(values: list[float]) -> float | None:
    values = [value for value in values if value is not None]
    if not values:
        return None
    return sum(values) / len(values)


def moving_average(values: list[float], window: int) -> float | None:
    if len(values) < window:
        return None
    return average(values[-window:])


def pct_change(current: float | None, base: float | None) -> float | None:
    if current is None or base in (None, 0):
        return None
    return (current - base) / base * 100


def round_or_none(value: float | None, digits: int = 4) -> float | None:
    if value is None:
        return None
    return round(value, digits)


def trend_atr14(rows: list[dict[str, Any]]) -> float | None:
    if len(rows) < 15:
        return None
    true_ranges: list[float] = []
    for index in range(1, len(rows)):
        high = rows[index].get("high")
        low = rows[index].get("low")
        prev_close = rows[index - 1].get("close")
        if high is None or low is None or prev_close is None:
            continue
        true_ranges.append(
            max(float(high) - float(low), abs(float(high) - float(prev_close)), abs(float(low) - float(prev_close)))
        )
    if len(true_ranges) < 14:
        return None
    return average(true_ranges[-14:])


def pct_return(rows: list[dict[str, Any]], period: int) -> float | None:
    if len(rows) < period + 1:
        return None
    start = to_float(rows[-period - 1].get("close"))
    end = to_float(rows[-1].get("close"))
    return pct_change(end, start)


def latest_close(rows: list[dict[str, Any]]) -> float | None:
    return to_float(rows[-1].get("close")) if rows else None


def classify_trend_phase(
    *,
    close: float | None,
    ma20: float | None,
    ma60: float | None,
    ma20_slope_pct: float | None,
    high20: float | None,
    distance_to_ma20_pct: float | None,
    change_pct: float | None,
) -> str:
    if close is None or ma20 is None:
        return "unknown"
    if ma60 is not None and close < ma20 and ma20 < ma60:
        return "downtrend"
    if ma60 is not None and close > ma20 > ma60 and (ma20_slope_pct or 0) > 0:
        if high20 is not None and close >= high20 * 0.995 and (change_pct or 0) >= 0:
            return "early_breakout"
        if distance_to_ma20_pct is not None and -3 <= distance_to_ma20_pct <= 3:
            return "constructive_pullback"
        if distance_to_ma20_pct is not None and distance_to_ma20_pct > 8:
            return "extended_uptrend"
        return "strong_uptrend"
    if ma60 is not None and close > ma60 and distance_to_ma20_pct is not None and -3 <= distance_to_ma20_pct <= 3:
        return "constructive_pullback"
    if close < ma20:
        return "broken_or_range"
    return "range"


def classify_structure_events(
    *,
    close: float | None,
    ma20: float | None,
    ma60: float | None,
    high20: float | None,
    low20: float | None,
    latest_volume: float | None,
    avg20_volume: float | None,
    distance_to_ma20_pct: float | None,
    distance_to_high20_pct: float | None,
) -> dict[str, Any]:
    volume_ratio = (
        latest_volume / avg20_volume
        if latest_volume is not None and avg20_volume not in (None, 0)
        else None
    )
    is_breakout = (
        close is not None
        and high20 is not None
        and close >= high20 * 0.995
        and (volume_ratio is None or volume_ratio >= 1.05)
    )
    is_pullback = (
        close is not None
        and ma20 is not None
        and ma60 is not None
        and close >= ma60
        and distance_to_ma20_pct is not None
        and -3 <= distance_to_ma20_pct <= 3
    )
    is_breakdown = (
        (close is not None and ma20 is not None and close < ma20)
        or (close is not None and low20 is not None and close <= low20 * 1.005)
    )
    return {
        "isBreakout": bool(is_breakout),
        "isPullback": bool(is_pullback),
        "isBreakdown": bool(is_breakdown),
        "volumeRatio20": round_or_none(volume_ratio, 2),
        "distanceToHigh20Pct": round_or_none(distance_to_high20_pct, 2),
        "basis": "20日突破/回踩/破位结构，成交量用最近20日均量归一化。",
    }


def score_trend_structure(
    *,
    close: float | None,
    ma20: float | None,
    ma60: float | None,
    ma20_slope_pct: float | None,
    high20: float | None,
    latest_volume: float | None,
    avg20_volume: float | None,
    change_pct: float | None,
    atr_pct: float | None,
) -> int:
    score = 40
    if close is not None and ma20 is not None:
        score += 18 if close > ma20 else -18
    if ma20 is not None and ma60 is not None:
        score += 16 if ma20 > ma60 else -12
    if ma20_slope_pct is not None:
        score += 14 if ma20_slope_pct > 0 else -10
    if close is not None and high20 is not None:
        if close >= high20 * 0.97:
            score += 12
        elif close < high20 * 0.9:
            score -= 8
    if latest_volume and avg20_volume and latest_volume > avg20_volume * 1.2 and (change_pct or 0) > 0:
        score += 8
    if atr_pct is not None and atr_pct > 8:
        score -= 8
    return max(0, min(100, int(round(score))))


def build_trend_summary(code: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
    closes = [float(row["close"]) for row in rows if row.get("close") is not None]
    volumes = [float(row["volume"]) for row in rows if row.get("volume") is not None]
    latest = rows[-1] if rows else {}
    close = to_float(latest.get("close"))
    change_pct = to_float(latest.get("changePct"))
    ma5 = moving_average(closes, 5)
    ma10 = moving_average(closes, 10)
    ma20 = moving_average(closes, 20)
    ma60 = moving_average(closes, 60)
    ma20_prev = average(closes[-25:-5]) if len(closes) >= 25 else None
    ma20_slope_pct = pct_change(ma20, ma20_prev)
    high20 = max((float(row["high"]) for row in rows[-20:] if row.get("high") is not None), default=None)
    high60 = max((float(row["high"]) for row in rows[-60:] if row.get("high") is not None), default=None)
    low20 = min((float(row["low"]) for row in rows[-20:] if row.get("low") is not None), default=None)
    atr14 = trend_atr14(rows)
    atr_pct = pct_change(close, close - atr14) if close is not None and atr14 is not None else None
    if close is not None and atr14 is not None and close != 0:
        atr_pct = atr14 / close * 100
    distance_to_ma20_pct = pct_change(close, ma20)
    distance_to_high20_pct = pct_change(close, high20)
    avg20_volume = average(volumes[-20:]) if len(volumes) >= 20 else None
    latest_volume = to_float(latest.get("volume"))
    structure = classify_structure_events(
        close=close,
        ma20=ma20,
        ma60=ma60,
        high20=high20,
        low20=low20,
        latest_volume=latest_volume,
        avg20_volume=avg20_volume,
        distance_to_ma20_pct=distance_to_ma20_pct,
        distance_to_high20_pct=distance_to_high20_pct,
    )
    phase = classify_trend_phase(
        close=close,
        ma20=ma20,
        ma60=ma60,
        ma20_slope_pct=ma20_slope_pct,
        high20=high20,
        distance_to_ma20_pct=distance_to_ma20_pct,
        change_pct=change_pct,
    )
    score = score_trend_structure(
        close=close,
        ma20=ma20,
        ma60=ma60,
        ma20_slope_pct=ma20_slope_pct,
        high20=high20,
        latest_volume=latest_volume,
        avg20_volume=avg20_volume,
        change_pct=change_pct,
        atr_pct=atr_pct,
    )
    stop_candidates = [
        value
        for value in [
            ma20 * 0.985 if ma20 is not None else None,
            close - atr14 * 2 if close is not None and atr14 is not None else None,
        ]
        if value is not None and value > 0
    ]
    initial_stop = min(stop_candidates) if stop_candidates else None
    return {
        "code": normalize_code(code),
        "asOf": latest.get("date"),
        "phase": phase,
        "trendScore": score,
        "latest": {
            "open": latest.get("open"),
            "high": latest.get("high"),
            "low": latest.get("low"),
            "close": close,
            "changePct": change_pct,
            "volume": latest_volume,
            "turnoverPct": latest.get("turnoverPct"),
        },
        "movingAverages": {
            "ma5": round_or_none(ma5),
            "ma10": round_or_none(ma10),
            "ma20": round_or_none(ma20),
            "ma60": round_or_none(ma60),
            "ma20SlopePct": round_or_none(ma20_slope_pct, 2),
        },
        "range": {
            "high20": round_or_none(high20),
            "high60": round_or_none(high60),
            "low20": round_or_none(low20),
            "distanceToMa20Pct": round_or_none(distance_to_ma20_pct, 2),
            "distanceToHigh20Pct": round_or_none(distance_to_high20_pct, 2),
            "atr14": round_or_none(atr14),
            "atrPct": round_or_none(atr_pct, 2),
            "avg20Volume": round_or_none(avg20_volume),
            "volumeRatio20": structure["volumeRatio20"],
        },
        "structure": structure,
        "returns": {
            "r20": round_or_none(pct_return(rows, 20), 2),
            "r60": round_or_none(pct_return(rows, 60), 2),
            "r120": round_or_none(pct_return(rows, 120), 2),
        },
        "riskPlan": {
            "initialStop": round_or_none(initial_stop, 3),
            "invalidation": "Close below MA20/ATR stop or trendScore falls below 55.",
            "buyZone": {
                "allowed": phase in {"strong_uptrend", "early_breakout", "constructive_pullback"} and score >= 65,
                "reason": "Requires uptrend structure, explicit invalidation, and >=1:2 risk/reward before order.",
            },
        },
        "recentKlines": rows[-20:],
    }


def to_float(value: Any) -> float | None:
    if value in (None, "", "-"):
        return None
    try:
        return float(value)
    except Exception:
        return None


def find_position(positions: list[dict[str, Any]], code: str) -> dict[str, Any] | None:
    normalized = normalize_code(code)
    for position in positions:
        try:
            if normalize_code(str(position.get("code") or "")) == normalized:
                return position
        except Exception:
            continue
    return None


def position_number(position: dict[str, Any] | None, *keys: str) -> float | None:
    if not position:
        return None
    for key in keys:
        value = to_float(position.get(key))
        if value is not None:
            return value
    return None


def parse_cn_money(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value or "").strip().replace(",", "")
    if not text or text == "-":
        return None
    multiplier = 1.0
    if text.endswith("亿"):
        multiplier = 100_000_000.0
        text = text[:-1]
    elif text.endswith("万"):
        multiplier = 10_000.0
        text = text[:-1]
    parsed = to_float(text)
    return None if parsed is None else parsed * multiplier


def parse_pct(value: Any) -> float | None:
    text = str(value or "").strip().replace("%", "")
    return to_float(text)


def compact_report(row: dict[str, Any]) -> dict[str, Any]:
    info_code = row.get("infoCode") or row.get("INFO_CODE")
    return {
        "title": row.get("title") or row.get("TITLE"),
        "publishDate": str(row.get("publishDate") or row.get("PUBLISH_DATE") or "")[:10],
        "org": row.get("orgSName") or row.get("ORG_S_NAME"),
        "rating": row.get("emRatingName") or row.get("EM_RATING_NAME"),
        "industryName": row.get("industryName") or row.get("INDUSTRY_NAME"),
        "industryCode": row.get("industryCode") or row.get("INDUSTRY_CODE"),
        "infoCode": info_code,
        "pdfUrl": PDF_TPL.format(info_code=info_code) if info_code else None,
        "epsThisYear": row.get("predictThisYearEps"),
        "epsNextYear": row.get("predictNextYearEps"),
        "epsNextTwoYear": row.get("predictNextTwoYearEps"),
    }


def eastmoney_reports(code: str, max_pages: int = 2) -> list[dict[str, Any]]:
    code = normalize_code(code)
    records: list[dict[str, Any]] = []
    for page in range(1, clamp_int(max_pages, 2, 1, 5) + 1):
        data = em_json(
            REPORT_API,
            params={
                "industryCode": "*",
                "pageSize": "100",
                "industry": "*",
                "rating": "*",
                "ratingChange": "*",
                "beginTime": "2000-01-01",
                "endTime": "2030-01-01",
                "pageNo": str(page),
                "fields": "",
                "qType": "0",
                "orgCode": "",
                "code": code,
                "rcode": "",
                "p": str(page),
                "pageNum": str(page),
                "pageNumber": str(page),
            },
            headers={"Referer": "https://data.eastmoney.com/"},
            timeout=30,
        )
        rows = data.get("data") or []
        if not rows:
            break
        records.extend(compact_report(row) for row in rows[:MAX_ROWS])
        if page >= int(data.get("TotalPage") or 1):
            break
    return records[:MAX_ROWS]


def eastmoney_industry_reports(
    industry_code: str = "*",
    max_pages: int = 2,
    begin: str = "2024-01-01",
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    industry_code = str(industry_code or "*").strip() or "*"
    begin = str(begin or "2024-01-01")[:10]
    for page in range(1, clamp_int(max_pages, 2, 1, 5) + 1):
        data = em_json(
            REPORT_API,
            params={
                "industryCode": industry_code,
                "pageSize": "100",
                "industry": "*",
                "rating": "*",
                "ratingChange": "*",
                "beginTime": begin,
                "endTime": "2030-01-01",
                "pageNo": str(page),
                "fields": "",
                "qType": "1",
            },
            headers={"Referer": "https://data.eastmoney.com/"},
            timeout=30,
        )
        rows = data.get("data") or []
        if not rows:
            break
        records.extend(compact_report(row) for row in rows[:MAX_ROWS])
        if page >= int(data.get("TotalPage") or 1):
            break
    return records[:MAX_ROWS]


def eastmoney_concept_blocks(code: str) -> dict[str, Any]:
    code = normalize_code(code)
    data = em_json(
        "https://push2.eastmoney.com/api/qt/slist/get",
        params={
            "fltt": "2",
            "invt": "2",
            "secid": f"{market_id(code)}.{code}",
            "spt": "3",
            "pi": "0",
            "pz": "200",
            "po": "1",
            "fields": "f12,f14,f3,f128",
        },
        headers={"Referer": "https://quote.eastmoney.com/"},
        timeout=15,
    )
    diff = (data.get("data") or {}).get("diff") or []
    items = list(diff.values()) if isinstance(diff, dict) else diff
    boards = [
        {
            "name": item.get("f14"),
            "code": item.get("f12"),
            "changePct": item.get("f3"),
            "leadStock": item.get("f128"),
        }
        for item in items
    ]
    return {"total": len(boards), "boards": boards, "conceptTags": [b["name"] for b in boards]}


def stock_fund_flow_120d(code: str) -> list[dict[str, Any]]:
    code = normalize_code(code)
    data = em_json(
        "https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get",
        params={
            "secid": f"{market_id(code)}.{code}",
            "fields1": "f1,f2,f3,f7",
            "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65",
            "lmt": "120",
        },
        headers={
            "Referer": "https://quote.eastmoney.com/",
            "Origin": "https://quote.eastmoney.com",
        },
        timeout=15,
    )
    rows = []
    for line in (data.get("data") or {}).get("klines", []) or []:
        parts = line.split(",")
        if len(parts) >= 7:
            rows.append(
                {
                    "date": parts[0],
                    "mainNet": to_float(parts[1]) or 0,
                    "smallNet": to_float(parts[2]) or 0,
                    "midNet": to_float(parts[3]) or 0,
                    "largeNet": to_float(parts[4]) or 0,
                    "superNet": to_float(parts[5]) or 0,
                }
            )
    return rows


def stock_fund_flow_summary_fallback(
    code: str, fund_flow_days: int
) -> dict[str, Any] | None:
    code = normalize_code(code)
    period_days = 20 if fund_flow_days > 10 else 10 if fund_flow_days > 5 else 5
    try:
        import akshare as ak
    except Exception as error:
        raise AStockDataError(f"AkShare unavailable for fund-flow fallback: {error}") from error

    symbol = f"{period_days}日排行"
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(
        io.StringIO()
    ):
        df = ak.stock_fund_flow_individual(symbol=symbol)

    if df is None or df.empty:
        raise AStockDataError(f"AkShare THS fund-flow fallback returned empty {symbol}")

    matched = None
    for _, row in df.iterrows():
        stock_code = str(row.get("股票代码") or "").split(".", 1)[0].zfill(6)
        if stock_code == code:
            matched = row
            break
    if matched is None:
        raise AStockDataError(f"{code} not found in AkShare THS {symbol}")

    net_flow = parse_cn_money(matched.get("资金流入净额"))
    return {
        "source": "akshare:stock_fund_flow_individual:ths",
        "degraded": True,
        "reason": "Eastmoney push2his fundFlow120d is unavailable; using THS cumulative fund-flow rank as a near-term substitute.",
        "periodDays": period_days,
        "date": now_iso()[:10],
        "code": code,
        "name": matched.get("股票简称"),
        "latestPrice": to_float(matched.get("最新价")),
        "periodChangePct": parse_pct(matched.get("阶段涨跌幅")),
        "turnoverPct": parse_pct(matched.get("连续换手率")),
        "netFlow": net_flow,
        "netFlowRaw": matched.get("资金流入净额"),
    }


def fund_flow_summary(
    fund_flow_rows: list[dict[str, Any]], fallback: dict[str, Any] | None
) -> dict[str, Any]:
    if fund_flow_rows:
        recent_5 = fund_flow_rows[-5:]
        recent_20 = fund_flow_rows[-20:]
        return {
            "source": "eastmoney:push2his:fundFlow120d",
            "degraded": False,
            "latestDate": fund_flow_rows[-1].get("date"),
            "rowCount": len(fund_flow_rows),
            "netFlow5d": sum(float(row.get("mainNet") or 0) for row in recent_5),
            "netFlow20d": sum(float(row.get("mainNet") or 0) for row in recent_20),
        }
    if fallback:
        return fallback
    return {
        "source": None,
        "degraded": True,
        "reason": "No usable stock-level fund-flow data source returned data.",
        "rowCount": 0,
    }


def industry_comparison(top_n: int = 20) -> dict[str, Any]:
    data = em_json(
        "https://push2.eastmoney.com/api/qt/clist/get",
        params={
            "pn": "1",
            "pz": "100",
            "po": "1",
            "np": "1",
            "fltt": "2",
            "invt": "2",
            "fs": "m:90+t:2",
            "fields": "f2,f3,f4,f12,f13,f14,f104,f105,f128,f136,f140,f141,f207",
        },
        timeout=15,
    )
    diff = (data.get("data") or {}).get("diff") or []
    items = list(diff.values()) if isinstance(diff, dict) else diff
    rows = [
        {
            "rank": idx + 1,
            "name": item.get("f14"),
            "code": item.get("f12"),
            "changePct": item.get("f3"),
            "upCount": item.get("f104"),
            "downCount": item.get("f105"),
            "leader": item.get("f140"),
            "leaderChange": item.get("f136"),
        }
        for idx, item in enumerate(items)
    ]
    limit = clamp_int(top_n, 20, 1, 50)
    return {"total": len(rows), "top": rows[:limit], "bottom": rows[-limit:]}


def industry_comparison_fallback(top_n: int = 20) -> dict[str, Any]:
    try:
        import akshare as ak
    except Exception as error:
        raise AStockDataError(
            f"AkShare unavailable for industry comparison fallback: {error}"
        ) from error

    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(
        io.StringIO()
    ):
        df = ak.stock_board_industry_summary_ths()

    if df is None or getattr(df, "empty", False):
        raise AStockDataError("AkShare THS industry summary fallback returned empty")

    rows = []
    for index, row in enumerate(df.to_dict("records"), start=1):
        rows.append(
            {
                "rank": int(row.get("序号") or index),
                "name": row.get("板块"),
                "code": None,
                "changePct": to_float(row.get("涨跌幅")),
                "upCount": row.get("上涨家数"),
                "downCount": row.get("下跌家数"),
                "leader": row.get("领涨股"),
                "leaderChange": to_float(row.get("领涨股-涨跌幅")),
                "turnoverAmount": to_float(row.get("总成交额")),
                "netFlow": to_float(row.get("净流入")),
            }
        )

    rows = [row for row in rows if row.get("name")]
    rows.sort(
        key=lambda item: (
            item.get("changePct") is not None,
            item.get("changePct") or 0,
        ),
        reverse=True,
    )
    limit = clamp_int(top_n, 20, 1, 50)
    bottom = sorted(
        rows,
        key=lambda item: (
            item.get("changePct") is not None,
            item.get("changePct") or 0,
        ),
    )[:limit]
    return {
        "total": len(rows),
        "top": rows[:limit],
        "bottom": bottom,
        "degraded": True,
        "source": "akshare:stock_board_industry_summary_ths",
        "reason": (
            "Eastmoney push2 industryComparison is unavailable; using THS "
            "industry summary as a same-day sector comparison fallback."
        ),
    }


def margin_trading(code: str, page_size: int = 20) -> list[dict[str, Any]]:
    code = normalize_code(code)
    rows = eastmoney_datacenter(
        "RPTA_WEB_RZRQ_GGMX",
        filter_str=f'(SCODE="{code}")',
        page_size=page_size,
        sort_columns="DATE",
        sort_types="-1",
    )
    return [
        {
            "date": str(row.get("DATE", ""))[:10],
            "marginBalance": row.get("RZYE", 0),
            "marginBuy": row.get("RZMRE", 0),
            "marginRepay": row.get("RZCHE", 0),
            "shortBalance": row.get("RQYE", 0),
            "totalBalance": row.get("RZRQYE", 0),
        }
        for row in rows
    ]


def holder_num_change(code: str, page_size: int = 10) -> list[dict[str, Any]]:
    code = normalize_code(code)
    rows = eastmoney_datacenter(
        "RPT_HOLDERNUMLATEST",
        filter_str=f'(SECURITY_CODE="{code}")',
        page_size=page_size,
        sort_columns="END_DATE",
        sort_types="-1",
    )
    return [
        {
            "date": str(row.get("END_DATE", ""))[:10],
            "holderNum": row.get("HOLDER_NUM", 0),
            "changeNum": row.get("HOLDER_NUM_CHANGE", 0),
            "changeRatio": row.get("HOLDER_NUM_RATIO", 0),
            "avgShares": row.get("AVG_FREE_SHARES", 0),
        }
        for row in rows
    ]


def dividend_history(code: str, page_size: int = 20) -> list[dict[str, Any]]:
    code = normalize_code(code)
    rows = eastmoney_datacenter(
        "RPT_SHAREBONUS_DET",
        filter_str=f'(SECURITY_CODE="{code}")',
        page_size=page_size,
        sort_columns="EX_DIVIDEND_DATE",
        sort_types="-1",
    )
    return [
        {
            "date": str(row.get("EX_DIVIDEND_DATE", ""))[:10],
            "bonusRmb": row.get("PRETAX_BONUS_RMB", 0),
            "transferRatio": row.get("TRANSFER_RATIO", 0),
            "bonusRatio": row.get("BONUS_RATIO", 0),
            "plan": row.get("ASSIGN_PROGRESS", ""),
        }
        for row in rows
    ]


def eastmoney_stock_info(code: str) -> dict[str, Any]:
    code = normalize_code(code)
    data = em_json(
        "https://push2.eastmoney.com/api/qt/stock/get",
        params={
            "fltt": "2",
            "invt": "2",
            "fields": "f57,f58,f84,f85,f127,f116,f117,f189,f43",
            "secid": f"{market_id(code)}.{code}",
        },
        timeout=10,
    )
    row = data.get("data") or {}
    return {
        "code": row.get("f57"),
        "name": row.get("f58"),
        "industry": row.get("f127"),
        "totalShares": row.get("f84"),
        "floatShares": row.get("f85"),
        "marketCap": row.get("f116"),
        "floatMarketCap": row.get("f117"),
        "listDate": str(row.get("f189", "")),
        "price": row.get("f43"),
    }


def eastmoney_stock_news(code: str, page_size: int = 20) -> list[dict[str, Any]]:
    code = normalize_code(code)
    inner_params = json.dumps(
        {
            "uid": "",
            "keyword": code,
            "type": ["cmsArticleWebOld"],
            "client": "web",
            "clientType": "web",
            "clientVersion": "curr",
            "param": {
                "cmsArticleWebOld": {
                    "searchScope": "default",
                    "sort": "default",
                    "pageIndex": 1,
                    "pageSize": clamp_int(page_size, 20, 1, 50),
                    "preTag": "",
                    "postTag": "",
                }
            },
        },
        separators=(",", ":"),
    )
    text = em_text(
        "https://search-api-web.eastmoney.com/search/jsonp",
        params={"cb": "jQuery_news", "param": inner_params},
        headers={"Referer": "https://so.eastmoney.com/"},
        timeout=15,
    )
    if "(" not in text or ")" not in text:
        return []
    parsed = json.loads(text[text.index("(") + 1 : text.rindex(")")])
    rows = []
    for item in (parsed.get("result") or {}).get("cmsArticleWebOld", []) or []:
        rows.append(
            {
                "title": strip_html(item.get("title", "")),
                "content": strip_html(item.get("content", ""))[:300],
                "time": item.get("date", ""),
                "source": item.get("mediaName", ""),
                "url": item.get("url", ""),
            }
        )
    return rows


def strip_html(value: str) -> str:
    return re.sub(r"<[^>]+>", "", str(value or "")).strip()


def eastmoney_global_news(page_size: int = 30) -> list[dict[str, Any]]:
    data = em_json(
        "https://np-weblist.eastmoney.com/comm/web/getFastNewsList",
        params={
            "client": "web",
            "biz": "web_724",
            "fastColumn": "102",
            "sortEnd": "",
            "pageSize": str(clamp_int(page_size, 30, 1, 80)),
            "req_trace": str(uuid.uuid4()),
        },
        headers={"Referer": "https://kuaixun.eastmoney.com/"},
        timeout=10,
    )
    return [
        {
            "title": item.get("title", ""),
            "summary": str(item.get("summary", ""))[:300],
            "time": item.get("showTime", ""),
        }
        for item in (data.get("data") or {}).get("fastNewsList", []) or []
    ]


def cninfo_ts_to_date(ts: Any) -> str:
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d")
    return str(ts or "")[:10]


def cninfo_orgid(code: str) -> str:
    global _CNINFO_ORGID_MAP
    code = normalize_code(code)
    if _CNINFO_ORGID_MAP is None:
        try:
            data = request_json(
                "https://www.cninfo.com.cn/new/data/szse_stock.json",
                timeout=15,
            )
            _CNINFO_ORGID_MAP = {
                item["code"]: item["orgId"]
                for item in data.get("stockList", [])
                if item.get("code") and item.get("orgId")
            }
        except Exception:
            _CNINFO_ORGID_MAP = {}
    if code in _CNINFO_ORGID_MAP:
        return _CNINFO_ORGID_MAP[code]
    if code.startswith("6"):
        return f"gssh0{code}"
    if code.startswith(("8", "4")):
        return f"gsbj0{code}"
    return f"gssz0{code}"


def cninfo_announcements(code: str, page_size: int = 20) -> list[dict[str, Any]]:
    code = normalize_code(code)
    data = request_json(
        "https://www.cninfo.com.cn/new/hisAnnouncement/query",
        method="POST",
        form_body={
            "stock": f"{code},{cninfo_orgid(code)}",
            "tabName": "fulltext",
            "pageSize": str(clamp_int(page_size, 20, 1, 50)),
            "pageNum": "1",
            "column": "",
            "category": "",
            "plate": "",
            "seDate": "",
            "searchkey": "",
            "secid": "",
            "sortName": "",
            "sortType": "",
            "isHLtitle": "true",
        },
        headers={
            "Referer": "https://www.cninfo.com.cn/new/disclosure",
            "Origin": "https://www.cninfo.com.cn",
        },
        timeout=15,
    )
    return [
        {
            "title": item.get("announcementTitle", ""),
            "type": item.get("announcementTypeName", ""),
            "date": cninfo_ts_to_date(item.get("announcementTime")),
            "url": (
                "https://www.cninfo.com.cn/new/disclosure/detail?annoId="
                + str(item.get("announcementId", ""))
            ),
        }
        for item in data.get("announcements", []) or []
    ]


def cninfo_irm(code: str, page_size: int = 20) -> list[dict[str, Any]]:
    code = normalize_code(code)
    lookup = request_json(
        "https://irm.cninfo.com.cn/newircs/index/queryKeyboardInfo",
        method="POST",
        form_body={"keyWord": code},
        timeout=10,
    )
    candidates = lookup.get("data") or []
    if not candidates:
        return []
    org_id = candidates[0].get("secid")
    data = request_json(
        "https://irm.cninfo.com.cn/newircs/company/question",
        method="POST",
        params={
            "_t": 1,
            "stockcode": code,
            "orgId": org_id,
            "pageSize": clamp_int(page_size, 20, 1, 50),
            "pageNum": 1,
            "keyWord": "",
            "startDay": "",
            "endDay": "",
        },
        timeout=10,
    )
    output = []
    for item in data.get("rows", []) or []:
        pd = item.get("pubDate")
        ask_time = (
            datetime.fromtimestamp(pd / 1000).strftime("%Y-%m-%d %H:%M")
            if isinstance(pd, (int, float))
            else ""
        )
        output.append(
            {
                "code": item.get("stockCode"),
                "company": item.get("companyShortName"),
                "question": item.get("mainContent"),
                "answer": item.get("attachedContent"),
                "answerer": item.get("attachedAuthor"),
                "askTime": ask_time,
            }
        )
    return output


def fmt_zt_time(value: Any) -> str:
    text = str(value or "")
    return f"{text[:2]}:{text[2:4]}:{text[4:6]}" if len(text) >= 6 else text


def em_limit_pool(endpoint: str, sort: str, date: str) -> list[dict[str, Any]]:
    data = em_json(
        f"https://push2ex.eastmoney.com/{endpoint}",
        params={
            "ut": "7eea3edcaed734bea9cbfc24409ed989",
            "dpt": "wz.ztzt",
            "Pageindex": 0,
            "pagesize": 10000,
            "sort": sort,
            "date": date,
        },
        headers={"Referer": "https://quote.eastmoney.com/"},
        timeout=12,
    )
    pool = (data.get("data") or {}).get("pool") or []
    return pool if isinstance(pool, list) else []


def limit_up_sentiment(date: str) -> dict[str, Any]:
    safe_date = re.sub(r"\D", "", str(date or ""))[:8] or datetime.now().strftime("%Y%m%d")
    zt = em_limit_pool("getTopicZTPool", "fbt:asc", safe_date)
    zb = em_limit_pool("getTopicZBPool", "fbt:asc", safe_date)
    dt = em_limit_pool("getTopicDTPool", "fund:asc", safe_date)
    yzt = em_limit_pool("getYesterdayZTPool", "zs:desc", safe_date)
    limit_up = [compact_limit_item(item) for item in zt[:80]]
    break_board = [compact_limit_item(item) for item in zb[:80]]
    limit_down = [compact_limit_item(item) for item in dt[:80]]
    return {
        "date": safe_date,
        "limitUpCount": len(zt),
        "breakBoardCount": len(zb),
        "limitDownCount": len(dt),
        "prevLimitUpCount": len(yzt),
        "breakRatePct": round(len(zb) / max(1, len(zt) + len(zb)) * 100, 2),
        "maxConsecutiveBoards": max([int(item.get("lbc") or 0) for item in zt] or [0]),
        "limitUp": limit_up,
        "breakBoard": break_board,
        "limitDown": limit_down,
    }


def compact_limit_item(item: dict[str, Any]) -> dict[str, Any]:
    stat = item.get("zttj") or {}
    return {
        "code": item.get("c"),
        "name": item.get("n"),
        "price": (item.get("p") or 0) / 1000 if isinstance(item.get("p"), (int, float)) else None,
        "pct": item.get("zdp"),
        "turnover": item.get("hs"),
        "limitDays": item.get("lbc") or item.get("days"),
        "firstSeal": fmt_zt_time(item.get("fbt") or item.get("yfbt")),
        "lastSeal": fmt_zt_time(item.get("lbt")),
        "sealFund": item.get("fund"),
        "breakTimes": item.get("zbc"),
        "industry": item.get("hybk"),
        "ztStat": f"{stat.get('days', '?')}d{stat.get('ct', '?')}b" if stat else None,
    }


def ths_hot_list(period: str = "hour") -> list[dict[str, Any]]:
    period = "day" if period == "day" else "hour"
    data = request_json(
        "https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock",
        params={"stock_type": "a", "type": period, "list_type": "normal"},
        timeout=10,
    )
    rows = (data.get("data") or {}).get("stock_list") or []
    output = []
    for item in rows[:MAX_ROWS]:
        tag = item.get("tag") or {}
        output.append(
            {
                "rank": item.get("order"),
                "code": item.get("code"),
                "name": item.get("name"),
                "heat": item.get("rate"),
                "pct": item.get("rise_and_fall"),
                "rankChange": item.get("hot_rank_chg"),
                "concepts": tag.get("concept_tag") or [],
                "tag": tag.get("popularity_tag", ""),
            }
        )
    return output


def em_hot_rank(top: int = 50) -> list[dict[str, Any]]:
    size = clamp_int(top, 50, 1, 100)
    data = em_json(
        "https://emappdata.eastmoney.com/stockrank/getAllCurrentList",
        method="POST",
        json_body={
            "appId": "appId01",
            "globalId": "786e4c21-70dc-435a-93bb-38",
            "marketType": "",
            "pageNo": 1,
            "pageSize": size,
        },
        timeout=12,
    ).get("data") or []
    return [
        {
            "rank": item.get("rk"),
            "code": str(item.get("sc", ""))[2:],
            "rankChange": item.get("hisRc"),
        }
        for item in data[:size]
    ]


def em_hot_concept(code: str) -> list[dict[str, Any]]:
    code = normalize_code(code)
    prefix = "SH" if code.startswith("6") else "SZ"
    data = em_json(
        "https://emappdata.eastmoney.com/stockrank/getHotStockRankList",
        method="POST",
        json_body={
            "appId": "appId01",
            "globalId": "786e4c21-70dc-435a-93bb-38",
            "srcSecurityCode": prefix + code,
        },
        timeout=10,
    ).get("data") or []
    return [
        {
            "concept": item.get("conceptName"),
            "bk": item.get("conceptId"),
            "hit": item.get("hitCount"),
        }
        for item in data[:MAX_ROWS]
    ]


def wrap(
    action: str,
    args: dict[str, Any],
    data: Any,
    sources: list[str],
    warnings: list[str] | None = None,
    data_quality: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "ok": True,
        "action": action,
        "args": args,
        "data": data,
        "sources": sources,
        "warnings": warnings or [],
        "dataQuality": data_quality,
        "fetchedAt": now_iso(),
        "license": {
            "origin": "simonlin1212/a-stock-data",
            "url": "https://github.com/simonlin1212/a-stock-data",
            "license": "Apache-2.0",
        },
    }


def safe_part(label: str, warnings: list[str], fn, fallback):
    try:
        return fn()
    except Exception as error:
        warnings.append(f"{label} failed: {error}")
        return fallback


def observed_part(
    label: str,
    warnings: list[str],
    fn,
    fallback,
    *,
    max_attempts: int = 2,
    retry_delay: float = 3.0,
):
    last_error: Exception | None = None
    last_category = "upstream_or_adapter_error"
    for attempt in range(1, max_attempts + 1):
        try:
            return fn(), None
        except Exception as error:
            last_error = error
            last_category = classify_source_error(str(error))
            if (
                attempt < max_attempts
                and last_category in TRANSIENT_SOURCE_ERROR_CATEGORIES
            ):
                time.sleep(retry_delay * attempt)
                continue
            break

    message = str(last_error) if last_error else "Unknown source error"
    warnings.append(f"{label} failed: {message}")
    return fallback, {
        "part": label,
        "status": "failed",
        "error": message[:500],
        "category": last_category,
        "attempts": max_attempts,
        "transient": last_category in TRANSIENT_SOURCE_ERROR_CATEGORIES,
    }


def classify_source_error(message: str) -> str:
    lowered = message.lower()
    if "proxyerror" in lowered or "unable to connect to proxy" in lowered:
        return "proxy_or_network"
    if "remote end closed" in lowered or "remotedisconnected" in lowered:
        return "remote_closed_connection"
    if "timed out" in lowered or "timeout" in lowered:
        return "timeout"
    if "http 429" in lowered:
        return "rate_limited"
    if "http 5" in lowered:
        return "upstream_5xx"
    return "upstream_or_adapter_error"


def signals_data_quality(
    *,
    fund_flow_rows: list[dict[str, Any]],
    fund_fallback: dict[str, Any] | None,
    concept_blocks: dict[str, Any],
    industry: dict[str, Any],
    issues: list[dict[str, Any]],
) -> dict[str, Any]:
    fund_issue = next((item for item in issues if item.get("part") == "fundFlow120d"), None)
    industry_issue = next((item for item in issues if item.get("part") == "industryComparison"), None)
    concept_issue = next((item for item in issues if item.get("part") == "conceptBlocks"), None)
    has_concepts = bool((concept_blocks or {}).get("boards"))
    has_industry = bool((industry or {}).get("top") or (industry or {}).get("bottom"))
    industry_degraded = bool((industry or {}).get("degraded"))
    if fund_flow_rows:
        fund_status = "ok"
        continuity = "daily_history"
        can_cross_validate = has_industry
        confidence = "medium" if industry_degraded else "high" if has_industry else "medium"
        reason = "Eastmoney historical stock-level fund-flow rows are available."
    elif fund_fallback:
        fund_status = "degraded"
        continuity = "aggregate_rank_only"
        can_cross_validate = False
        confidence = "low"
        reason = (
            "Historical daily fund-flow rows are unavailable. "
            "Only THS aggregate rank fallback is available, so multi-day validation rules should not be applied."
        )
    else:
        fund_status = "unavailable"
        continuity = "none"
        can_cross_validate = False
        confidence = "none"
        reason = "No usable stock-level fund-flow source returned data."

    return {
        "status": "ok" if fund_status == "ok" and not issues else "degraded",
        "fundFlow": {
            "status": fund_status,
            "primarySource": "eastmoney:push2his:fundFlow120d",
            "fallbackSource": fund_fallback.get("source") if fund_fallback else None,
            "continuity": continuity,
            "rowCount": len(fund_flow_rows),
            "canCrossValidate": can_cross_validate,
            "confidence": confidence,
            "reason": reason,
            "primaryIssue": fund_issue,
        },
        "conceptBlocks": {
            "status": "ok" if has_concepts else "unavailable",
            "source": "eastmoney:push2:slist",
            "issue": concept_issue,
        },
        "industryComparison": {
            "status": "degraded" if has_industry and industry_degraded else "ok" if has_industry else "unavailable",
            "source": (industry or {}).get("source") or "eastmoney:push2:clist",
            "fallbackSource": (
                (industry or {}).get("source") if industry_degraded else None
            ),
            "issue": industry_issue,
        },
        "issues": issues,
    }


def action_quote(args: dict[str, Any]) -> dict[str, Any]:
    codes = normalize_codes(args.get("codes") or [args.get("code")], max_count=30)
    return wrap("quote", {"codes": codes}, tencent_quote(codes), ["Tencent Finance qt.gtimg.cn"])


def action_research(args: dict[str, Any]) -> dict[str, Any]:
    mode = args.get("mode") or ("stock" if args.get("code") else "industry")
    if mode == "industry":
        data = eastmoney_industry_reports(
            str(args.get("industryCode") or "*"),
            max_pages=clamp_int(args.get("maxPages"), 2, 1, 5),
            begin=str(args.get("begin") or "2024-01-01")[:10],
        )
        return wrap("research", {"mode": "industry"}, data, ["Eastmoney reportapi"])
    code = normalize_code(args.get("code"))
    data = eastmoney_reports(code, max_pages=clamp_int(args.get("maxPages"), 2, 1, 5))
    return wrap("research", {"mode": "stock", "code": code}, data, ["Eastmoney reportapi"])


def action_signals(args: dict[str, Any]) -> dict[str, Any]:
    code = normalize_code(args.get("code"))
    trade_date = normalize_date(args.get("tradeDate"))
    fund_flow_days = clamp_int(args.get("fundFlowDays"), 20, 1, 120)
    warnings: list[str] = []
    issues: list[dict[str, Any]] = []
    fund, issue = observed_part("fundFlow120d", warnings, lambda: stock_fund_flow_120d(code), [])
    if issue:
        issues.append(issue)
    fund_fallback = (
        None
        if fund
        else safe_part(
            "fundFlowSummaryFallback",
            warnings,
            lambda: stock_fund_flow_summary_fallback(code, fund_flow_days),
            None,
        )
    )
    if fund_fallback:
        warnings.append(
            "fundFlow120d unavailable; fundFlowSummary uses degraded THS cumulative rank fallback."
        )
    concept_blocks, issue = observed_part(
        "conceptBlocks",
        warnings,
        lambda: eastmoney_concept_blocks(code),
        {},
    )
    if issue:
        issues.append(issue)
    industry, issue = observed_part(
        "industryComparison",
        warnings,
        lambda: industry_comparison(clamp_int(args.get("industryTopN"), 10, 1, 30)),
        {},
    )
    if issue:
        issues.append(issue)
        industry_fallback = safe_part(
            "industryComparisonFallback",
            warnings,
            lambda: industry_comparison_fallback(
                clamp_int(args.get("industryTopN"), 10, 1, 30)
            ),
            {},
        )
        if industry_fallback:
            industry = industry_fallback
            warnings.append(
                "industryComparison unavailable; using degraded THS industry summary fallback."
            )
    data = {
        "conceptBlocks": concept_blocks,
        "fundFlow120d": fund[-fund_flow_days:],
        "fundFlowSummary": fund_flow_summary(fund, fund_fallback),
        "industryComparison": industry,
        "lockupExpiry": safe_part("lockupExpiry", warnings, lambda: lockup_expiry(code, trade_date), {}),
    }
    sources = ["Eastmoney slist", "Eastmoney push2his", "Eastmoney datacenter"]
    if fund_fallback:
        sources.append("AkShare THS fund-flow rank")
    if (industry or {}).get("degraded"):
        sources.append("AkShare THS industry summary")
    data_quality = signals_data_quality(
        fund_flow_rows=fund,
        fund_fallback=fund_fallback,
        concept_blocks=concept_blocks,
        industry=industry,
        issues=issues,
    )
    return wrap(
        "signals",
        {"code": code, "tradeDate": trade_date},
        data,
        sources,
        warnings,
        data_quality,
    )


def build_relative_strength(
    observations: list[dict[str, Any]],
    benchmark_returns: dict[str, float | None],
) -> list[dict[str, Any]]:
    scored: list[dict[str, Any]] = []
    for item in observations:
        summary = item.get("trend") or {}
        returns = summary.get("returns") or {}
        r20 = to_float(returns.get("r20"))
        r60 = to_float(returns.get("r60"))
        r120 = to_float(returns.get("r120"))
        score = 0.0
        weight = 0.0
        for value, period_weight in ((r20, 0.45), (r60, 0.35), (r120, 0.20)):
            if value is not None:
                score += value * period_weight
                weight += period_weight
        rs_score = score / weight if weight else None
        benchmark_r60 = benchmark_returns.get("r60")
        scored.append(
            {
                "code": summary.get("code") or item.get("code"),
                "phase": summary.get("phase") or "unknown",
                "trendScore": summary.get("trendScore") or 0,
                "r20": r20,
                "r60": r60,
                "r120": r120,
                "rsScore": round_or_none(rs_score, 2),
                "benchmarkRelative60": round_or_none(
                    r60 - benchmark_r60
                    if r60 is not None and benchmark_r60 is not None
                    else None,
                    2,
                ),
                "dataQuality": item.get("dataQuality"),
            }
        )
    ranked = sorted(
        scored,
        key=lambda row: (
            row["rsScore"] is not None,
            row["rsScore"] if row["rsScore"] is not None else -999,
            row["trendScore"],
        ),
        reverse=True,
    )
    total = len(ranked)
    for index, row in enumerate(ranked):
        row["rank"] = index + 1
        row["percentile"] = round((total - index) / total * 100, 1) if total else None
    return ranked


def classify_lifecycle_state(
    trend: dict[str, Any],
    rs: dict[str, Any] | None,
    position: dict[str, Any] | None,
) -> str:
    phase = str(trend.get("phase") or "unknown")
    score = int(trend.get("trendScore") or 0)
    structure = trend.get("structure") or {}
    risk_plan = trend.get("riskPlan") or {}
    close = to_float((trend.get("latest") or {}).get("close"))
    stop = to_float(risk_plan.get("initialStop"))
    has_position = bool(position and (position_number(position, "quantity") or 0) > 0)
    rs_percentile = to_float((rs or {}).get("percentile"))

    if phase == "unknown":
        return "unknown"
    if has_position and close is not None and stop is not None and close <= stop:
        return "exit_required"
    if phase in {"downtrend", "broken_or_range"}:
        return "break_warning" if has_position else "avoid"
    if structure.get("isBreakdown"):
        return "break_warning" if has_position else "avoid"
    if phase == "extended_uptrend":
        return "trend_holding" if has_position else "avoid"
    if has_position:
        if (
            phase == "constructive_pullback"
            and score >= 65
            and (rs_percentile or 0) >= 60
        ):
            return "add_candidate"
        if score >= 55:
            return "trend_holding"
        return "break_warning"
    if (
        phase == "early_breakout"
        and score >= 70
        and (rs_percentile is None or rs_percentile >= 60)
    ):
        return "breakout_confirmed"
    if phase in {"strong_uptrend", "constructive_pullback"} and score >= 65:
        return "watch_setup"
    return "avoid"


def build_stop_engine_plan(
    trend: dict[str, Any],
    position: dict[str, Any] | None,
) -> dict[str, Any]:
    latest = trend.get("latest") or {}
    risk_plan = trend.get("riskPlan") or {}
    range_data = trend.get("range") or {}
    moving = trend.get("movingAverages") or {}
    close = to_float(latest.get("close"))
    ma20 = to_float(moving.get("ma20"))
    atr14 = to_float(range_data.get("atr14"))
    initial_stop = to_float(risk_plan.get("initialStop"))
    highest_price = position_number(
        position,
        "highestPrice",
        "highest_price",
        "highWatermark",
        "high_watermark",
    )
    if highest_price is None:
        highest_price = max(
            [
                value
                for value in [
                    close,
                    to_float(range_data.get("high20")),
                    to_float(range_data.get("high60")),
                ]
                if value is not None
            ],
            default=None,
        )
    ma20_stop = ma20 * 0.985 if ma20 is not None else None
    atr_stop = close - atr14 * 2 if close is not None and atr14 is not None else None
    high_stop = highest_price * 0.92 if highest_price is not None else None
    hard_stop = max(
        [value for value in [initial_stop, ma20_stop, atr_stop] if value is not None],
        default=None,
    )
    trailing_stop = max(
        [value for value in [hard_stop, high_stop] if value is not None],
        default=None,
    )
    action = "hold"
    reason = "趋势止损未触发。"
    if close is None or trailing_stop is None:
        action = "blocked"
        reason = "缺少现价或止损价，不能生成止损动作。"
    elif close <= trailing_stop:
        action = "sell_watch"
        reason = "现价触及移动止损或硬止损，进入退出观察。"
    elif ma20 is not None and close < ma20:
        action = "reduce_watch"
        reason = "现价跌破 MA20，进入减仓观察。"
    return {
        "hardStop": round_or_none(hard_stop, 3),
        "trailingStop": round_or_none(trailing_stop, 3),
        "ma20Stop": round_or_none(ma20_stop, 3),
        "atrStop": round_or_none(atr_stop, 3),
        "highWatermarkStop": round_or_none(high_stop, 3),
        "highestPriceUsed": round_or_none(highest_price, 3),
        "action": action,
        "reason": reason,
    }


def with_trade_directions(
    suggestion: dict[str, Any],
    has_position: bool = False,
) -> dict[str, Any]:
    action = str(suggestion.get("action") or "")
    buy_allowed = action == "buy_allowed"
    sell_allowed = has_position and action in {"reduce_watch", "sell_watch"}
    allowed_directions: list[str] = []
    if buy_allowed:
        allowed_directions.append("buy")
    if sell_allowed:
        allowed_directions.append("sell")
    blocked_directions = [
        direction
        for direction in ["buy", "sell"]
        if direction not in allowed_directions
    ]
    return {
        **suggestion,
        "tradeAllowed": bool(allowed_directions),
        "buyAllowed": buy_allowed,
        "sellAllowed": sell_allowed,
        "allowedDirections": allowed_directions,
        "blockedDirections": blocked_directions,
    }


def control_suggestion_for_state(
    state: str,
    position: dict[str, Any] | None = None,
    stop_plan: dict[str, Any] | None = None,
) -> dict[str, Any]:
    mapping = {
        "breakout_confirmed": (
            "buy_allowed",
            True,
            "突破确认且相对强弱合格，可进入小仓位趋势试单。",
        ),
        "watch_setup": (
            "add_watch",
            False,
            "趋势结构接近可交易，继续观察突破、回踩和量能确认。",
        ),
        "trend_holding": ("hold", False, "持仓趋势仍有效，按移动止损继续跟踪。"),
        "add_candidate": (
            "add_watch",
            False,
            "健康回踩且趋势未破，可观察是否满足加仓触发。",
        ),
        "break_warning": (
            "reduce_watch",
            False,
            "趋势结构转弱，优先检查 T+1 可卖量和减仓条件。",
        ),
        "exit_required": ("sell_watch", False, "硬止损或趋势失效，优先处理退出。"),
        "avoid": ("blocked", False, "趋势状态不支持趋势跟随买入。"),
        "unknown": ("blocked", False, "数据不足，不能形成趋势动作。"),
    }
    action, trade_allowed, reason = mapping.get(state, mapping["unknown"])
    has_position = bool(position and (position_number(position, "quantity") or 0) > 0)
    suggestion = {"action": action, "tradeAllowed": trade_allowed, "reason": reason}
    stop_action = str((stop_plan or {}).get("action") or "")
    if has_position and stop_action in {"sell_watch", "reduce_watch"}:
        suggestion = {
            "action": stop_action,
            "tradeAllowed": True,
            "reason": (stop_plan or {}).get("reason") or reason,
            "source": "stopEngine",
        }
    return with_trade_directions(suggestion, has_position=has_position)


def build_strategy_stats(fills: list[dict[str, Any]]) -> dict[str, Any]:
    trend_fills: list[dict[str, Any]] = []
    for fill in fills:
        strategy = str(fill.get("strategy") or "").lower()
        thesis = fill.get("tradeThesis") or fill.get("trade_thesis") or {}
        thesis_strategy = (
            str(thesis.get("strategy") or "").lower() if isinstance(thesis, dict) else ""
        )
        if "trend" in strategy or "趋势" in strategy or "trend" in thesis_strategy:
            trend_fills.append(fill)
    closed = [
        fill for fill in trend_fills if to_float(fill.get("realized_pnl")) is not None
    ]
    pnls = [to_float(fill.get("realized_pnl")) or 0 for fill in closed]
    wins = [value for value in pnls if value > 0]
    losses = [value for value in pnls if value < 0]
    by_symbol: dict[str, dict[str, Any]] = {}
    for fill, pnl in zip(closed, pnls):
        code = str(fill.get("code") or "unknown")
        item = by_symbol.setdefault(
            code, {"code": code, "sampleSize": 0, "realizedPnl": 0.0}
        )
        item["sampleSize"] += 1
        item["realizedPnl"] += pnl
    for item in by_symbol.values():
        item["realizedPnl"] = round_or_none(item["realizedPnl"], 2)
    sample_size = len(pnls)
    avg_win = sum(wins) / len(wins) if wins else 0
    avg_loss = sum(losses) / len(losses) if losses else 0
    win_rate = len(wins) / sample_size if sample_size else None
    expectancy = sum(pnls) / sample_size if sample_size else None
    return {
        "strategy": "trend_following",
        "sampleSize": sample_size,
        "winRate": round_or_none(win_rate * 100 if win_rate is not None else None, 2),
        "avgWin": round_or_none(avg_win, 2),
        "avgLoss": round_or_none(avg_loss, 2),
        "payoffRatio": round_or_none(avg_win / abs(avg_loss) if avg_loss else None, 2),
        "expectancy": round_or_none(expectancy, 2),
        "realizedPnl": round_or_none(sum(pnls), 2),
        "bySymbol": sorted(
            by_symbol.values(), key=lambda row: row["realizedPnl"], reverse=True
        ),
        "sampleSizeWarning": sample_size < 10,
        "note": "少于10笔已实现样本时，统计只能作为观察，不能作为硬规则。",
    }


def fetch_trend_observation(
    code: str,
    days: int,
    *,
    prefer_fallback: bool = False,
) -> dict[str, Any]:
    warnings: list[str] = []
    issues: list[dict[str, Any]] = []
    sources = ["Eastmoney push2his daily kline"]
    fallback_source = None
    rows: list[dict[str, Any]] = []
    issue = None
    if prefer_fallback:
        issue = {
            "part": "dailyKlineTrend",
            "status": "skipped",
            "error": "Primary source skipped because an earlier trend-system request showed upstream instability.",
            "category": "primary_source_circuit_open",
            "attempts": 0,
            "transient": True,
        }
        warnings.append(
            "Eastmoney daily kline skipped for this batch after prior upstream instability; using Tencent fallback."
        )
    else:
        rows, issue = observed_part(
            "dailyKlineTrend",
            warnings,
            lambda: eastmoney_daily_klines(code, days),
            [],
            max_attempts=1,
        )
    if issue:
        issues.append(issue)
        fallback_rows, fallback_issue = observed_part(
            "dailyKlineTrendFallback",
            warnings,
            lambda: tencent_daily_klines(code, days),
            [],
            max_attempts=2,
        )
        if fallback_issue:
            issues.append(fallback_issue)
        if fallback_rows:
            rows = fallback_rows
            fallback_source = "tencent:web.ifzq:fqkline"
            sources.append("Tencent Finance daily kline fallback")
            warnings.append(
                "Eastmoney daily kline unavailable; using Tencent daily kline fallback."
            )
    has_complete_rows = len(rows) >= 60
    data_quality = {
        "status": "ok"
        if has_complete_rows
        else "degraded"
        if rows
        else "unavailable",
        "rowCount": len(rows),
        "minimumRowsForMA60": 60,
        "primarySource": "eastmoney:push2his:kline",
        "primaryStatus": "failed" if issue else "ok",
        "fallbackSource": fallback_source,
        "sourceSwitch": bool(fallback_source),
        "issues": issues,
        "reason": (
            "日 K 足够支撑 MA60/ATR 趋势评估。"
            if len(rows) >= 60
            else "日 K 不足，不能支撑完整趋势评估。"
            if rows
            else "没有可用日 K。"
        ),
    }
    trend = (
        build_trend_summary(code, rows)
        if rows
        else {
            "code": normalize_code(code),
            "phase": "unknown",
            "trendScore": 0,
            "returns": {"r20": None, "r60": None, "r120": None},
            "riskPlan": {
                "initialStop": None,
                "invalidation": "No trend decision is allowed without daily OHLC data.",
                "buyZone": {"allowed": False, "reason": "daily kline unavailable"},
            },
            "recentKlines": [],
        }
    )
    return {
        "code": normalize_code(code),
        "trend": trend,
        "sources": sources,
        "warnings": warnings,
        "dataQuality": data_quality,
    }


def should_open_trend_primary_circuit(observation: dict[str, Any]) -> bool:
    data_quality = observation.get("dataQuality") or {}
    issues = data_quality.get("issues") or []
    if not isinstance(issues, list):
        return False
    for issue in issues:
        if not isinstance(issue, dict):
            continue
        if issue.get("part") != "dailyKlineTrend":
            continue
        if issue.get("category") in {
            "proxy_or_network",
            "remote_closed_connection",
            "timeout",
            "rate_limited",
            "upstream_5xx",
        }:
            return True
    return False


def action_trend_system(args: dict[str, Any]) -> dict[str, Any]:
    codes = normalize_codes(args.get("codes") or [], max_count=30)
    days = clamp_int(args.get("days"), 120, 60, 250)
    benchmark = str(args.get("benchmark") or "399300").strip()
    positions = args.get("positions") if isinstance(args.get("positions"), list) else []
    fills = args.get("fills") if isinstance(args.get("fills"), list) else []
    system_warnings: list[str] = []
    data_quality_warnings: list[str] = []
    observations: list[dict[str, Any]] = []
    prefer_fallback = False
    for code in codes:
        observation = fetch_trend_observation(
            code,
            days,
            prefer_fallback=prefer_fallback,
        )
        observations.append(observation)
        if not prefer_fallback and should_open_trend_primary_circuit(observation):
            prefer_fallback = True
            system_warnings.append(
                "Eastmoney daily kline source became unstable; remaining trend-system symbols used Tencent fallback directly."
            )
    benchmark_returns = {"r20": None, "r60": None, "r120": None}
    try:
        benchmark_observation = fetch_trend_observation(
            benchmark,
            days,
            prefer_fallback=prefer_fallback,
        )
        benchmark_trend = benchmark_observation.get("trend") or {}
        returns = benchmark_trend.get("returns") or {}
        benchmark_returns = {
            "r20": to_float(returns.get("r20")),
            "r60": to_float(returns.get("r60")),
            "r120": to_float(returns.get("r120")),
        }
        if benchmark_observation["dataQuality"]["status"] == "unavailable":
            data_quality_warnings.append("基准指数 K 线不可用，RS 仅使用池内动量排名。")
    except Exception as error:
        data_quality_warnings.append(f"基准指数 K 线不可用，RS 仅使用池内动量排名：{error}")
    ranking = build_relative_strength(observations, benchmark_returns)
    ranking_by_code = {str(row.get("code")): row for row in ranking}
    items: list[dict[str, Any]] = []
    portfolio_risk: list[dict[str, Any]] = []
    for observation in observations:
        code = observation["code"]
        trend = observation["trend"]
        position = find_position(positions, code)
        rs = ranking_by_code.get(code)
        state = classify_lifecycle_state(trend, rs, position)
        stop_plan = build_stop_engine_plan(trend, position)
        suggestion = control_suggestion_for_state(state, position, stop_plan)
        if observation["dataQuality"]["status"] != "ok":
            data_quality_warnings.append(
                f"{code} 数据质量 {observation['dataQuality']['status']}：{observation['dataQuality']['reason']}"
            )
            if suggestion["action"] == "buy_allowed":
                suggestion = {
                    "action": "blocked",
                    "tradeAllowed": False,
                    "reason": "数据质量不足，买入建议降级为禁止。",
                }
        item = {
            "code": code,
            "trend": trend,
            "relativeStrength": rs,
            "lifecycleState": state,
            "stopEngine": stop_plan,
            "controlSuggestion": suggestion,
            "position": position,
            "dataQuality": observation["dataQuality"],
            "warnings": observation["warnings"],
        }
        items.append(item)
        if position:
            portfolio_risk.append(
                {
                    "code": code,
                    "lifecycleState": state,
                    "stopEngine": stop_plan,
                    "controlSuggestion": suggestion,
                    "quantity": position_number(position, "quantity"),
                    "cost": position_number(position, "cost", "cost_price", "costPrice"),
                    "latestPrice": to_float((trend.get("latest") or {}).get("close")),
                }
            )
    return wrap(
        "trend_system",
        {"codes": codes, "benchmark": benchmark, "days": days},
        {
            "benchmark": {
                "code": benchmark,
                "returns": {
                    key: round_or_none(value, 2)
                    for key, value in benchmark_returns.items()
                },
            },
            "items": items,
            "relativeStrengthRanking": ranking,
            "portfolioRisk": portfolio_risk,
            "strategyStats": build_strategy_stats(fills),
            "systemWarnings": system_warnings + data_quality_warnings,
            "stateModel": [
                "watch_setup",
                "breakout_confirmed",
                "trend_holding",
                "add_candidate",
                "break_warning",
                "exit_required",
                "avoid",
                "unknown",
            ],
        },
        ["Eastmoney/Tencent daily kline", "trend-system local model"],
        system_warnings + data_quality_warnings,
        {
            "status": "degraded" if data_quality_warnings else "ok",
            "reason": (
                "Trend system completed with complete primary or fallback data; source switches are disclosed separately."
                if not data_quality_warnings
                else "Trend system completed with incomplete or unavailable market observations; reduce trading confidence."
            ),
            "coverage": {"codes": len(codes), "items": len(items)},
            "sourceWarnings": system_warnings,
            "dataQualityWarnings": data_quality_warnings,
        },
    )


def action_trend(args: dict[str, Any]) -> dict[str, Any]:
    code = normalize_code(args.get("code"))
    days = clamp_int(args.get("days"), 120, 30, 250)
    warnings: list[str] = []
    issues: list[dict[str, Any]] = []
    rows, issue = observed_part(
        "dailyKlineTrend",
        warnings,
        lambda: eastmoney_daily_klines(code, days),
        [],
        max_attempts=2,
    )
    sources = ["Eastmoney push2his daily kline"]
    data_quality = {
        "status": "ok" if len(rows) >= 60 and issue is None else "degraded" if rows else "unavailable",
        "rowCount": len(rows),
        "minimumRowsForMA60": 60,
        "primarySource": "eastmoney:push2his:kline",
        "primaryStatus": "failed" if issue else "ok",
        "fallbackSource": None,
        "sourceSwitch": False,
        "issues": issues,
        "reason": (
            "Daily OHLC rows are sufficient for MA60/ATR trend assessment."
            if len(rows) >= 60
            else "Daily OHLC rows are insufficient for full trend assessment."
            if rows
            else "No usable daily OHLC rows returned."
        ),
    }
    if issue:
        issues.append(issue)
        fallback_rows, fallback_issue = observed_part(
            "dailyKlineTrendFallback",
            warnings,
            lambda: tencent_daily_klines(code, days),
            [],
            max_attempts=2,
        )
        if fallback_issue:
            issues.append(fallback_issue)
        if fallback_rows:
            rows = fallback_rows
            sources.append("Tencent Finance daily kline fallback")
            warnings.append(
                "Eastmoney daily kline unavailable; using Tencent daily kline fallback."
            )
            data_quality = {
                **data_quality,
                "status": "ok" if len(rows) >= 60 else "unavailable",
                "rowCount": len(rows),
                "primaryStatus": "failed",
                "fallbackSource": "tencent:web.ifzq:fqkline",
                "sourceSwitch": True,
                "issues": issues,
                "reason": (
                    "Primary daily OHLC source failed, but Tencent fallback rows are complete for trend assessment."
                    if len(rows) >= 60
                    else "Primary daily OHLC source failed and fallback rows are insufficient for full trend assessment."
                ),
            }
    if not rows:
        return wrap(
            "trend",
            {"code": code, "days": days},
            {
                "code": code,
                "phase": "unknown",
                "trendScore": 0,
                "riskPlan": {
                    "initialStop": None,
                    "invalidation": "No trend decision is allowed without daily OHLC data.",
                    "buyZone": {"allowed": False, "reason": "daily kline unavailable"},
                },
                "recentKlines": [],
            },
            sources,
            warnings,
            data_quality,
        )
    return wrap(
        "trend",
        {"code": code, "days": days},
        build_trend_summary(code, rows),
        sources,
        warnings,
        data_quality,
    )


def lockup_expiry(code: str, trade_date: str) -> dict[str, Any]:
    start = trade_date
    end = (datetime.strptime(trade_date, "%Y-%m-%d") + timedelta(days=90)).strftime("%Y-%m-%d")
    history = eastmoney_datacenter(
        "RPT_LIFT_STAGE",
        filter_str=f'(SECURITY_CODE="{code}")',
        page_size=10,
        sort_columns="FREE_DATE",
        sort_types="-1",
    )
    upcoming = eastmoney_datacenter(
        "RPT_LIFT_STAGE",
        filter_str=f'(SECURITY_CODE="{code}")(FREE_DATE>="{start}")(FREE_DATE<="{end}")',
        page_size=20,
        sort_columns="FREE_DATE",
        sort_types="1",
    )
    compact = lambda row: {
        "date": str(row.get("FREE_DATE", ""))[:10],
        "type": row.get("LIMITED_STOCK_TYPE", ""),
        "shares": row.get("FREE_SHARES_NUM", 0),
        "ratio": row.get("FREE_RATIO", 0),
    }
    return {"history": [compact(row) for row in history], "upcoming": [compact(row) for row in upcoming]}


def action_fundamentals(args: dict[str, Any]) -> dict[str, Any]:
    code = normalize_code(args.get("code"))
    warnings: list[str] = []
    data = {
        "stockInfo": safe_part("stockInfo", warnings, lambda: eastmoney_stock_info(code), {}),
        "marginTrading": safe_part(
            "marginTrading",
            warnings,
            lambda: margin_trading(code, page_size=clamp_int(args.get("pageSize"), 10, 1, 30)),
            [],
        ),
        "holderNumChange": safe_part("holderNumChange", warnings, lambda: holder_num_change(code), []),
        "dividendHistory": safe_part("dividendHistory", warnings, lambda: dividend_history(code), []),
    }
    return wrap(
        "fundamentals",
        {"code": code},
        data,
        ["Eastmoney push2", "Eastmoney datacenter"],
        [
            *warnings,
            "mootdx F10 and Sina statements are reserved for a later optional dependency layer.",
        ],
    )


def action_news_filings(args: dict[str, Any]) -> dict[str, Any]:
    page_size = clamp_int(args.get("pageSize"), 20, 1, 50)
    code = args.get("code")
    warnings: list[str] = []
    data: dict[str, Any] = {
        "globalNews": safe_part("globalNews", warnings, lambda: eastmoney_global_news(page_size), [])
    }
    sources = ["Eastmoney global news"]
    if code:
        normalized = normalize_code(code)
        data.update(
            {
                "stockNews": safe_part(
                    "stockNews",
                    warnings,
                    lambda: eastmoney_stock_news(normalized, page_size),
                    [],
                ),
                "announcements": safe_part(
                    "announcements",
                    warnings,
                    lambda: cninfo_announcements(normalized, page_size),
                    [],
                ),
                "investorRelations": safe_part(
                    "investorRelations",
                    warnings,
                    lambda: cninfo_irm(normalized, min(page_size, 30)),
                    [],
                ),
            }
        )
        sources.extend(["Eastmoney stock news", "cninfo announcements", "cninfo IRM"])
    return wrap("news_filings", {"code": code, "pageSize": page_size}, data, sources, warnings)


def action_market_mood(args: dict[str, Any]) -> dict[str, Any]:
    date = re.sub(r"\D", "", str(args.get("date") or datetime.now().strftime("%Y%m%d")))[:8]
    code = args.get("code")
    warnings: list[str] = []
    data: dict[str, Any] = {
        "limitUpSentiment": safe_part("limitUpSentiment", warnings, lambda: limit_up_sentiment(date), {}),
        "thsHotList": safe_part(
            "thsHotList",
            warnings,
            lambda: ths_hot_list(str(args.get("period") or "hour")),
            [],
        ),
        "eastmoneyHotRank": safe_part(
            "eastmoneyHotRank",
            warnings,
            lambda: em_hot_rank(clamp_int(args.get("top"), 50, 1, 100)),
            [],
        ),
    }
    sources = ["Eastmoney push2ex", "THS hot list", "Eastmoney hot rank"]
    if code:
        normalized = normalize_code(code)
        data["hotConcepts"] = safe_part("hotConcepts", warnings, lambda: em_hot_concept(normalized), [])
        sources.append("Eastmoney hot concept")
    return wrap("market_mood", {"date": date, "code": code}, data, sources, warnings)


ACTIONS = {
    "quote": action_quote,
    "research": action_research,
    "signals": action_signals,
    "trend": action_trend,
    "trend_system": action_trend_system,
    "fundamentals": action_fundamentals,
    "news_filings": action_news_filings,
    "market_mood": action_market_mood,
}


def run(payload: dict[str, Any]) -> dict[str, Any]:
    action = str(payload.get("action") or "").strip()
    if action not in ACTIONS:
        raise AStockDataError(f"Unsupported action: {action}")
    args = payload.get("args") or {}
    if not isinstance(args, dict):
        raise AStockDataError("args must be an object.")
    return ACTIONS[action](args)
