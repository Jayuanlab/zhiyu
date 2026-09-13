from __future__ import annotations

import sys
import unittest
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS_DIR))

import a_stock_data  # noqa: E402


class SymbolRoutingTest(unittest.TestCase):
    def test_shanghai_etf_uses_shanghai_quote_prefix(self):
        self.assertEqual(a_stock_data.tencent_prefix("515980"), "sh515980")
        self.assertEqual(a_stock_data.market_id("515980"), 1)

    def test_shenzhen_etf_still_uses_shenzhen_quote_prefix(self):
        self.assertEqual(a_stock_data.tencent_prefix("159915"), "sz159915")
        self.assertEqual(a_stock_data.market_id("159915"), 0)


if __name__ == "__main__":
    unittest.main()
