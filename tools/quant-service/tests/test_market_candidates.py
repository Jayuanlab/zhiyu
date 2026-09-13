import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import provider


def fake_quotes(codes: list[str]) -> list[dict]:
    rows = []
    for index, code in enumerate(codes):
        rows.append(
            {
                "code": code,
                "name": f"name-{index}",
                "price": 10 + index,
                "change_pct": 1.0 + (index % 3),
                "turnover_billion": 1.0 + index / 10,
                "turnover_rate": 2.0,
                "pe_ttm": 20.0,
                "pb": 2.0,
                "updated_at": "2026-07-28T15:00:00+08:00",
            }
        )
    return rows


class MarketCandidateFallbackTest(unittest.TestCase):
    def setUp(self) -> None:
        self.original_provider = os.environ.get("QUANT_CANDIDATE_PROVIDER")
        self.original_dynamic = os.environ.get("QUANT_DYNAMIC_CANDIDATES")
        self.original_local = os.environ.get("QUANT_LOCAL_CANDIDATE_UNIVERSE")
        self.original_market_universe_path = provider.MARKET_UNIVERSE_PATH
        self.original_quotes = provider._tencent_watchlist_quotes
        self.original_dynamic_loader = provider._load_dynamic_theme_candidate_stocks
        self.tmp = tempfile.TemporaryDirectory()
        provider.MARKET_UNIVERSE_PATH = Path(self.tmp.name) / "market_universe.json"
        os.environ["QUANT_CANDIDATE_PROVIDER"] = "tencent"
        os.environ["QUANT_DYNAMIC_CANDIDATES"] = "false"
        os.environ["QUANT_LOCAL_CANDIDATE_UNIVERSE"] = "true"
        provider._tencent_watchlist_quotes = fake_quotes
        provider._MARKET_CANDIDATE_DYNAMIC_CACHE.clear()

    def tearDown(self) -> None:
        if self.original_provider is None:
            os.environ.pop("QUANT_CANDIDATE_PROVIDER", None)
        else:
            os.environ["QUANT_CANDIDATE_PROVIDER"] = self.original_provider
        if self.original_dynamic is None:
            os.environ.pop("QUANT_DYNAMIC_CANDIDATES", None)
        else:
            os.environ["QUANT_DYNAMIC_CANDIDATES"] = self.original_dynamic
        if self.original_local is None:
            os.environ.pop("QUANT_LOCAL_CANDIDATE_UNIVERSE", None)
        else:
            os.environ["QUANT_LOCAL_CANDIDATE_UNIVERSE"] = self.original_local
        provider._tencent_watchlist_quotes = self.original_quotes
        provider._load_dynamic_theme_candidate_stocks = self.original_dynamic_loader
        provider.MARKET_UNIVERSE_PATH = self.original_market_universe_path
        provider._MARKET_CANDIDATE_DYNAMIC_CACHE.clear()
        sys.modules.pop("pywencai", None)
        self.tmp.cleanup()

    def test_local_universe_varies_by_theme(self) -> None:
        medicine = provider.quant_market_candidates(
            theme="\u533b\u836f",
            limit=5,
            min_turnover_billion=0,
            exclude_watchlist=False,
        )
        consumption = provider.quant_market_candidates(
            theme="\u6d88\u8d39",
            limit=5,
            min_turnover_billion=0,
            exclude_watchlist=False,
        )

        medicine_codes = [item["code"] for item in medicine["items"]]
        consumption_codes = [item["code"] for item in consumption["items"]]

        self.assertEqual(medicine["data_source_detail"], "local_market_universe+tencent_quote")
        self.assertEqual(consumption["data_source_detail"], "local_market_universe+tencent_quote")
        self.assertTrue(medicine_codes)
        self.assertTrue(consumption_codes)
        self.assertNotEqual(medicine_codes, consumption_codes)
        medicine_seed_codes = set(provider._fallback_theme_seed_codes("\u533b\u836f"))
        consumption_seed_codes = set(provider._fallback_theme_seed_codes("\u6d88\u8d39"))
        self.assertTrue(set(medicine_codes).issubset(medicine_seed_codes))
        self.assertTrue(set(consumption_codes).issubset(consumption_seed_codes))

    def test_unknown_theme_does_not_claim_unrelated_seed_matches(self) -> None:
        result = provider.quant_market_candidates(
            theme="\u672a\u77e5\u4e3b\u9898",
            limit=5,
            min_turnover_billion=0,
            exclude_watchlist=False,
        )

        self.assertEqual(result["items"], [])

    def test_broad_market_theme_uses_diversified_seed_pool(self) -> None:
        result = provider.quant_market_candidates(
            theme="\u5168\u5e02\u573a",
            limit=12,
            min_turnover_billion=0,
            exclude_watchlist=False,
        )

        theme_sets = {tuple(item["themes"]) for item in result["items"]}

        self.assertEqual(result["keywords"], [])
        self.assertGreaterEqual(len(result["items"]), 8)
        self.assertGreaterEqual(len(theme_sets), 3)

    def test_operational_themes_have_local_universe_candidates(self) -> None:
        for theme in [
            "\u7535\u6c60",
            "\u901a\u4fe1\u8bbe\u5907",
            "\u8d35\u91d1\u5c5e",
            "\u519c\u4e1a",
        ]:
            with self.subTest(theme=theme):
                result = provider.quant_market_candidates(
                    theme=theme,
                    limit=5,
                    min_turnover_billion=0,
                    exclude_watchlist=False,
                )

                self.assertEqual(
                    result["data_source_detail"], "local_market_universe+tencent_quote"
                )
                self.assertGreater(len(result["items"]), 0)
                self.assertTrue(provider._fallback_theme_seed_codes(theme))

    def test_dynamic_theme_discovery_is_used_before_seed_fallback(self) -> None:
        os.environ["QUANT_DYNAMIC_CANDIDATES"] = "true"

        def fake_dynamic_loader(keywords: list[str]) -> tuple[list[dict], dict[str, list[str]], list[dict]]:
            self.assertIn("\u4f4e\u7a7a\u7ecf\u6d4e", keywords)
            stocks = fake_quotes(["300900.SZ", "688001.SH"])
            return (
                stocks,
                {
                    "300900.SZ": ["\u4f4e\u7a7a\u7ecf\u6d4e"],
                    "688001.SH": ["\u4f4e\u7a7a\u7ecf\u6d4e", "\u822a\u7a7a"],
                },
                [
                    {
                        "source": "akshare:stock_board_concept",
                        "board": "\u4f4e\u7a7a\u7ecf\u6d4e",
                        "ok": True,
                        "member_count": 2,
                    }
                ],
            )

        provider._load_dynamic_theme_candidate_stocks = fake_dynamic_loader

        result = provider.quant_market_candidates(
            theme="\u4f4e\u7a7a\u7ecf\u6d4e",
            limit=5,
            min_turnover_billion=0,
            exclude_watchlist=False,
            refresh_dynamic=True,
        )

        self.assertEqual(result["provider"], "akshare+tencent")
        self.assertEqual(result["data_source_detail"], "dynamic_theme_board+tencent_quote")
        self.assertEqual([item["code"] for item in result["items"]], ["688001.SH", "300900.SZ"])
        self.assertEqual(result["concept_sources"][0]["board"], "\u4f4e\u7a7a\u7ecf\u6d4e")
        self.assertEqual(result["cache"], {"hit": False})

    def test_dynamic_theme_cache_is_used_for_default_fast_requests(self) -> None:
        os.environ["QUANT_DYNAMIC_CANDIDATES"] = "true"
        provider._set_cached_dynamic_theme_candidates(
            provider._theme_keywords("\u4f4e\u7a7a\u7ecf\u6d4e"),
            fake_quotes(["300900.SZ", "688001.SH"]),
            {
                "300900.SZ": ["\u4f4e\u7a7a\u7ecf\u6d4e"],
                "688001.SH": ["\u4f4e\u7a7a\u7ecf\u6d4e"],
            },
            [
                {
                    "source": "akshare:stock_board_concept",
                    "board": "\u4f4e\u7a7a\u7ecf\u6d4e",
                    "ok": True,
                    "member_count": 2,
                }
            ],
        )

        def failing_dynamic_loader(keywords: list[str]) -> tuple[list[dict], dict[str, list[str]], list[dict]]:
            raise AssertionError("cache hit should not call the dynamic provider")

        provider._load_dynamic_theme_candidate_stocks = failing_dynamic_loader

        result = provider.quant_market_candidates(
            theme="\u4f4e\u7a7a\u7ecf\u6d4e",
            limit=5,
            min_turnover_billion=0,
            exclude_watchlist=False,
        )

        self.assertEqual(result["provider"], "akshare+tencent")
        self.assertTrue(result["cache"]["hit"])
        self.assertEqual(result["data_source_detail"], "dynamic_theme_board+tencent_quote")

    def test_dynamic_theme_failure_falls_back_to_local_universe(self) -> None:
        os.environ["QUANT_DYNAMIC_CANDIDATES"] = "true"

        def failing_dynamic_loader(keywords: list[str]) -> tuple[list[dict], dict[str, list[str]], list[dict]]:
            raise provider.QuantProviderError("boom")

        provider._load_dynamic_theme_candidate_stocks = failing_dynamic_loader

        result = provider.quant_market_candidates(
            theme="\u7535\u6c60",
            limit=5,
            min_turnover_billion=0,
            exclude_watchlist=False,
            refresh_dynamic=True,
        )

        self.assertEqual(result["data_source_detail"], "local_market_universe+tencent_quote")
        self.assertGreater(len(result["items"]), 0)

    def test_wencai_refresh_merges_theme_candidates_into_market_universe(self) -> None:
        def fake_get(question: str, query_type: str) -> list[dict]:
            self.assertEqual(query_type, "stock")
            self.assertIn("\u4f4e\u7a7a\u7ecf\u6d4e", question)
            return [
                {"\u80a1\u7968\u4ee3\u7801": "300900", "\u80a1\u7968\u7b80\u79f0": "\u5e7f\u8054\u822a\u7a7a"},
                {"\u80a1\u7968\u4ee3\u7801": "688001.SH", "\u80a1\u7968\u7b80\u79f0": "\u534e\u5174\u6e90\u521b"},
            ]

        sys.modules["pywencai"] = types.SimpleNamespace(get=fake_get)

        result = provider.refresh_market_universe(
            provider="wencai",
            theme="\u4f4e\u7a7a\u7ecf\u6d4e",
        )
        items = provider._read_market_universe_file_items()
        codes = {item["code"] for item in items}

        self.assertTrue(result["ok"])
        self.assertEqual(result["source"], "pywencai")
        self.assertIn("300900.SZ", codes)
        self.assertIn("688001.SH", codes)


if __name__ == "__main__":
    unittest.main()
