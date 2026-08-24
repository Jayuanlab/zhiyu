import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import provider


def fake_quotes(codes: list[str]) -> list[dict]:
    return [
        {
            "code": code,
            "name": f"name-{index}",
            "price": 10 + index,
            "change_pct": 1.0,
            "turnover_billion": 1.0,
            "turnover_rate": 2.0,
            "pe_ttm": 20.0,
            "pb": 2.0,
            "roe": 0,
            "updated_at": "2026-08-21T15:00:00+08:00",
        }
        for index, code in enumerate(codes)
    ]


class DashboardProviderTest(unittest.TestCase):
    def setUp(self) -> None:
        self.original_provider = os.environ.get("QUANT_DATA_PROVIDER")
        self.original_watchlist_codes = provider._watchlist_codes
        self.original_tencent_quotes = provider._tencent_watchlist_quotes
        self.original_indices = provider._tencent_quotes
        self.original_akshare_dashboard = provider.akshare_quant_dashboard
        self.original_fundamentals = provider._load_watchlist_fundamentals
        self.original_full_market = provider._get_full_market_overview
        self.original_full_market_loader = provider._load_full_market_overview
        self.original_market_executor = provider._MARKET_OVERVIEW_EXECUTOR
        provider.invalidate_cache()

    def tearDown(self) -> None:
        if self.original_provider is None:
            os.environ.pop("QUANT_DATA_PROVIDER", None)
        else:
            os.environ["QUANT_DATA_PROVIDER"] = self.original_provider
        provider._watchlist_codes = self.original_watchlist_codes
        provider._tencent_watchlist_quotes = self.original_tencent_quotes
        provider._tencent_quotes = self.original_indices
        provider.akshare_quant_dashboard = self.original_akshare_dashboard
        provider._load_watchlist_fundamentals = self.original_fundamentals
        provider._get_full_market_overview = self.original_full_market
        provider._load_full_market_overview = self.original_full_market_loader
        provider._MARKET_OVERVIEW_EXECUTOR = self.original_market_executor
        provider.invalidate_cache()

    def test_auto_dashboard_prefers_fast_tencent_quotes(self) -> None:
        calls: list[str] = []
        os.environ["QUANT_DATA_PROVIDER"] = "auto"
        provider._watchlist_codes = lambda: ["600519.SH", "300750.SZ"]
        provider._tencent_watchlist_quotes = fake_quotes
        provider._tencent_quotes = lambda symbols: []
        provider._get_full_market_overview = lambda: {
            "trade_date": "2026-08-21",
            "market_scope": "full_market",
            "temperature": 63,
            "up_count": 3200,
            "down_count": 1800,
            "flat_count": 100,
            "turnover_billion": 9200.0,
            "indices": [],
            "sectors": [{"name": "AI", "change_pct": 2.1, "signal": "strong"}],
        }

        def fail_akshare() -> dict:
            calls.append("akshare")
            raise AssertionError("auto dashboard should not call AkShare first")

        provider.akshare_quant_dashboard = fail_akshare

        dashboard = provider.quant_dashboard()

        self.assertEqual(calls, [])
        self.assertEqual(dashboard["data_provider"], "tencent")
        self.assertEqual(dashboard["data_source_detail"], "tencent_quote_batch")
        self.assertEqual(dashboard["watchlist_source"], "configured_tencent_quote")
        self.assertEqual(dashboard["market"]["market_scope"], "full_market")
        self.assertEqual(dashboard["market"]["up_count"], 3200)

    def test_tencent_dashboard_skips_slow_fundamentals(self) -> None:
        os.environ["QUANT_DATA_PROVIDER"] = "tencent"
        provider._watchlist_codes = lambda: ["600519.SH"]
        provider._tencent_watchlist_quotes = fake_quotes
        provider._tencent_quotes = lambda symbols: []
        provider._get_full_market_overview = lambda: {
            "trade_date": "2026-08-21",
            "market_scope": "full_market",
            "temperature": 60,
            "up_count": 3000,
            "down_count": 2000,
            "flat_count": 100,
            "turnover_billion": 8800.0,
            "indices": [],
            "sectors": [],
        }

        def fail_fundamentals(codes: list[str]) -> dict:
            raise AssertionError("Tencent dashboard hot path must not load fundamentals")

        provider._load_watchlist_fundamentals = fail_fundamentals

        dashboard = provider.quant_dashboard()

        self.assertEqual(dashboard["data_provider"], "tencent")
        self.assertEqual(len(dashboard["watchlist"]), 1)
        self.assertEqual(dashboard["market"]["market_scope"], "full_market")

    def test_quick_watchlist_quote_map_skips_market_and_fundamentals(self) -> None:
        provider._watchlist_codes = lambda: ["600519.SH"]
        provider._tencent_watchlist_quotes = fake_quotes

        def fail_full_market() -> dict:
            raise AssertionError("quick quote map must not load full market overview")

        def fail_fundamentals(codes: list[str]) -> dict:
            raise AssertionError("quick quote map must not load fundamentals")

        provider._get_full_market_overview = fail_full_market
        provider._load_watchlist_fundamentals = fail_fundamentals

        quote_map = provider.quick_watchlist_quote_map()

        self.assertEqual(list(quote_map), ["600519.SH"])
        self.assertEqual(quote_map["600519.SH"]["price"], 10)

    def test_tencent_market_overview_marks_watchlist_fallback(self) -> None:
        provider._tencent_quotes = lambda symbols: []
        provider._get_full_market_overview = lambda: (_ for _ in ()).throw(
            provider.QuantProviderError("full market unavailable")
        )

        market = provider._build_tencent_market_overview(fake_quotes(["600519.SH"]))

        self.assertEqual(market["market_scope"], "watchlist_fallback")
        self.assertEqual(market["up_count"], 1)
        self.assertIn("market_warning", market)

    def test_tencent_market_overview_backgrounds_full_market_when_uncached(self) -> None:
        class PendingFuture:
            def done(self) -> bool:
                return False

        class FakeExecutor:
            def __init__(self) -> None:
                self.submitted = 0

            def submit(self, func):
                self.submitted += 1
                return PendingFuture()

        fake_executor = FakeExecutor()
        provider._MARKET_OVERVIEW_EXECUTOR = fake_executor

        def fail_if_called_sync() -> dict:
            raise AssertionError("full-market loader must run in background")

        provider._load_full_market_overview = fail_if_called_sync

        market = provider._build_tencent_market_overview(fake_quotes(["600519.SH"]))
        status = provider.get_market_overview_status()

        self.assertEqual(market["market_scope"], "watchlist_fallback")
        self.assertEqual(fake_executor.submitted, 1)
        self.assertTrue(status["in_progress"])
        self.assertEqual(status["scope"], "full_market")


if __name__ == "__main__":
    unittest.main()
