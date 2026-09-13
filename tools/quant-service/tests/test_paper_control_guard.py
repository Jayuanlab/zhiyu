import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import paper_trading, provider


class PaperControlGuardTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.original_provider = os.environ.get("QUANT_DATA_PROVIDER")
        self.original_account_path = paper_trading.PAPER_ACCOUNT_PATH
        self.original_quick_quote_map = paper_trading.quick_watchlist_quote_map
        self.original_config_path = provider.WATCHLIST_CONFIG_PATH
        self.original_universe_path = provider.WATCHLIST_UNIVERSE_PATH
        paper_trading.PAPER_ACCOUNT_PATH = Path(self.tmp.name) / "paper_account.json"
        provider.WATCHLIST_CONFIG_PATH = Path(self.tmp.name) / "watchlist.json"
        provider.WATCHLIST_UNIVERSE_PATH = (
            Path(self.tmp.name) / "watchlist_universe.json"
        )
        provider.invalidate_cache()

    def tearDown(self) -> None:
        if self.original_provider is None:
            os.environ.pop("QUANT_DATA_PROVIDER", None)
        else:
            os.environ["QUANT_DATA_PROVIDER"] = self.original_provider
        paper_trading.PAPER_ACCOUNT_PATH = self.original_account_path
        paper_trading.quick_watchlist_quote_map = self.original_quick_quote_map
        provider.WATCHLIST_CONFIG_PATH = self.original_config_path
        provider.WATCHLIST_UNIVERSE_PATH = self.original_universe_path
        provider.invalidate_cache()
        self.tmp.cleanup()

    def test_sample_mode_rejects_paper_order_mutation(self) -> None:
        os.environ["QUANT_DATA_PROVIDER"] = "sample"
        provider.WATCHLIST_CONFIG_PATH.write_text(
            json.dumps({"codes": ["600519.SH"]}),
            encoding="utf-8",
        )

        with self.assertRaisesRegex(
            paper_trading.PaperTradingError,
            "paper_migration_required",
        ):
            paper_trading.place_paper_order(
                {
                    "code": "600519.SH",
                    "side": "buy",
                    "quantity": 100,
                    "limit_price": 100.0,
                    "planned_price": 100.0,
                    "actor": "test",
                }
            )

        self.assertFalse(paper_trading.PAPER_ACCOUNT_PATH.exists())

    def test_paper_account_uses_quick_quote_map_for_position_view(self) -> None:
        os.environ["QUANT_DATA_PROVIDER"] = "tencent"
        calls: list[str] = []
        paper_trading.PAPER_ACCOUNT_PATH.write_text(
            json.dumps(
                {
                    "id": "paper-default",
                    "mode": "paper",
                    "initial_cash": 1_000_000.0,
                    "cash": 900_000.0,
                    "frozen_cash": 0.0,
                    "realized_pnl": 0.0,
                    "lots": [
                        {
                            "id": "lot_1",
                            "code": "600519.SH",
                            "name": "Kweichow Moutai",
                            "quantity": 100,
                            "remaining_quantity": 100,
                            "cost_price": 1000.0,
                            "trade_date": "2026-08-20",
                            "created_at": "2026-08-20T10:00:00+08:00",
                        }
                    ],
                    "orders": [],
                    "fills": [],
                    "created_at": "2026-08-20T10:00:00+08:00",
                    "updated_at": "2026-08-20T10:00:00+08:00",
                }
            ),
            encoding="utf-8",
        )

        def fake_quick_quote_map() -> dict[str, dict]:
            calls.append("quick")
            return {
                "600519.SH": {
                    "code": "600519.SH",
                    "name": "Kweichow Moutai",
                    "price": 1100.0,
                    "change_pct": 1.2,
                }
            }

        paper_trading.quick_watchlist_quote_map = fake_quick_quote_map

        account = paper_trading.get_paper_account()

        self.assertEqual(calls, ["quick"])
        self.assertEqual(account["market_value"], 110_000.0)
        self.assertEqual(account["positions"][0]["price"], 1100.0)


if __name__ == "__main__":
    unittest.main()
