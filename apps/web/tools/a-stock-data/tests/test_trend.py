from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

TOOLS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS_DIR))

import a_stock_data  # noqa: E402


def sample_uptrend_rows(count: int = 80):
    rows = []
    for index in range(count):
        close = 10 + index * 0.08
        rows.append(
            {
                "date": f"2026-01-{(index % 28) + 1:02d}",
                "open": close - 0.03,
                "high": close + 0.08,
                "low": close - 0.08,
                "close": close,
                "volume": 100_000 + index * 2_000,
                "amount": close * (100_000 + index * 2_000),
                "amplitudePct": 1.0,
                "changePct": 0.8,
                "changeAmount": 0.08,
                "turnoverPct": 2.0,
            }
        )
    return rows


class TrendToolTest(unittest.TestCase):
    def test_action_trend_classifies_constructive_uptrend(self):
        with patch.object(
            a_stock_data,
            "eastmoney_daily_klines",
            return_value=sample_uptrend_rows(),
        ):
            result = a_stock_data.action_trend({"code": "159278.SZ", "days": 80})

        self.assertTrue(result["ok"])
        self.assertEqual(result["action"], "trend")
        self.assertEqual(result["dataQuality"]["status"], "ok")
        self.assertGreaterEqual(result["data"]["trendScore"], 65)
        self.assertIn(
            result["data"]["phase"],
            {"strong_uptrend", "early_breakout", "constructive_pullback"},
        )
        self.assertTrue(result["data"]["riskPlan"]["buyZone"]["allowed"])
        self.assertIsNotNone(result["data"]["riskPlan"]["initialStop"])

    def test_action_trend_blocks_when_kline_unavailable(self):
        with patch.object(a_stock_data, "eastmoney_daily_klines", return_value=[]):
            result = a_stock_data.action_trend({"code": "159278", "days": 80})

        self.assertTrue(result["ok"])
        self.assertEqual(result["dataQuality"]["status"], "unavailable")
        self.assertEqual(result["data"]["phase"], "unknown")
        self.assertFalse(result["data"]["riskPlan"]["buyZone"]["allowed"])

    def test_action_trend_keeps_quality_ok_when_fallback_rows_are_complete(self):
        rows = sample_uptrend_rows()

        with (
            patch.object(
                a_stock_data,
                "eastmoney_daily_klines",
                side_effect=a_stock_data.AStockDataError("Eastmoney unavailable"),
            ),
            patch.object(a_stock_data, "tencent_daily_klines", return_value=rows),
            patch.object(a_stock_data.time, "sleep", return_value=None),
        ):
            result = a_stock_data.action_trend({"code": "159278", "days": 80})

        self.assertTrue(result["ok"])
        self.assertEqual(result["dataQuality"]["status"], "ok")
        self.assertEqual(result["dataQuality"]["primaryStatus"], "failed")
        self.assertTrue(result["dataQuality"]["sourceSwitch"])
        self.assertEqual(
            result["dataQuality"]["fallbackSource"],
            "tencent:web.ifzq:fqkline",
        )

    def test_action_trend_system_ranks_rs_and_builds_stop_plan(self):
        rows = sample_uptrend_rows()
        weaker_rows = [
            {
                **row,
                "close": row["close"] * (1 - index * 0.001),
                "high": row["high"] * (1 - index * 0.001),
                "low": row["low"] * (1 - index * 0.001),
            }
            for index, row in enumerate(rows)
        ]

        def fake_klines(code: str, days: int = 120):
            normalized = a_stock_data.normalize_code(code)
            if normalized == "000002":
                return weaker_rows
            return rows

        with patch.object(a_stock_data, "eastmoney_daily_klines", side_effect=fake_klines):
            result = a_stock_data.action_trend_system(
                {
                    "codes": ["000001.SZ", "000002.SZ"],
                    "days": 80,
                    "positions": [
                        {
                            "code": "000001.SZ",
                            "quantity": 1000,
                            "cost_price": 10,
                            "highestPrice": 16,
                        }
                    ],
                    "fills": [
                        {
                            "code": "000001.SZ",
                            "strategy": "trend_following",
                            "realized_pnl": 500,
                        },
                        {
                            "code": "000002.SZ",
                            "strategy": "trend_following",
                            "realized_pnl": -200,
                        },
                    ],
                }
            )

        self.assertTrue(result["ok"])
        self.assertEqual(result["action"], "trend_system")
        data = result["data"]
        self.assertEqual(data["relativeStrengthRanking"][0]["code"], "000001")
        self.assertEqual(data["portfolioRisk"][0]["code"], "000001")
        self.assertIn(
            data["items"][0]["lifecycleState"],
            {"trend_holding", "add_candidate", "break_warning", "exit_required"},
        )
        self.assertIn("trailingStop", data["portfolioRisk"][0]["stopEngine"])
        self.assertEqual(data["strategyStats"]["sampleSize"], 2)
        self.assertEqual(data["strategyStats"]["realizedPnl"], 300)

    def test_action_trend_system_skips_primary_after_transient_primary_failure(self):
        rows = sample_uptrend_rows()
        eastmoney_calls = []
        tencent_calls = []

        def flaky_eastmoney(code: str, days: int = 120):
            eastmoney_calls.append(a_stock_data.normalize_code(code))
            raise a_stock_data.AStockDataError("Remote end closed connection without response")

        def fake_tencent(code: str, days: int = 120):
            tencent_calls.append(a_stock_data.normalize_code(code))
            return rows

        with (
            patch.object(a_stock_data, "eastmoney_daily_klines", side_effect=flaky_eastmoney),
            patch.object(a_stock_data, "tencent_daily_klines", side_effect=fake_tencent),
            patch.object(a_stock_data.time, "sleep", return_value=None),
        ):
            result = a_stock_data.action_trend_system(
                {
                    "codes": ["000001.SZ", "000002.SZ", "000003.SZ"],
                    "benchmark": "399300.SZ",
                    "days": 80,
                }
            )

        self.assertTrue(result["ok"])
        self.assertEqual(eastmoney_calls, ["000001"])
        self.assertEqual(tencent_calls, ["000001", "000002", "000003", "399300"])
        self.assertEqual(result["dataQuality"]["status"], "ok")
        self.assertGreater(len(result["dataQuality"]["sourceWarnings"]), 0)
        self.assertEqual(result["dataQuality"]["dataQualityWarnings"], [])
        self.assertIn(
            "remaining trend-system symbols used Tencent fallback directly",
            " ".join(result["data"]["systemWarnings"]),
        )

    def test_action_trend_system_marks_sell_watch_as_sell_allowed_for_positions(self):
        rows = sample_uptrend_rows()

        with patch.object(a_stock_data, "eastmoney_daily_klines", return_value=rows):
            result = a_stock_data.action_trend_system(
                {
                    "codes": ["000001.SZ"],
                    "days": 80,
                    "positions": [
                        {
                            "code": "000001.SZ",
                            "quantity": 1000,
                            "cost_price": 10,
                            "highestPrice": 40,
                        }
                    ],
                }
            )

        self.assertTrue(result["ok"])
        risk = result["data"]["portfolioRisk"][0]
        self.assertEqual(risk["stopEngine"]["action"], "sell_watch")
        self.assertEqual(risk["controlSuggestion"]["action"], "sell_watch")
        self.assertTrue(risk["controlSuggestion"]["tradeAllowed"])
        self.assertFalse(risk["controlSuggestion"]["buyAllowed"])
        self.assertTrue(risk["controlSuggestion"]["sellAllowed"])
        self.assertEqual(risk["controlSuggestion"]["allowedDirections"], ["sell"])


if __name__ == "__main__":
    unittest.main()
